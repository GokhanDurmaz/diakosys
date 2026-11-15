import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnOpenCodeServer, basicAuthHeader, type ServerOptions } from "./opencode-server.ts";

import type { OpenCodePromptResult } from "./opencode.ts";

/**
 * OpenCode v1 backend (CLI ≤ v1.x, SDK 1.19.x).
 *
 * Preserves the previously validated v1 flow exactly:
 *   * session.create({ body: {} })
 *   * session.promptAsync({ path, query, body }) -> 204, returns immediately
 *   * GET /event SSE for progress, `session.idle` as the terminal signal
 *   * session.messages({ path }) for the final assistant message
 *   * session.abort({ path }) for interruption
 *
 * The server is now started through the shared lifecycle module, which injects
 * `OPENCODE_SERVER_PASSWORD` so both CLI generations accept the same Basic
 * `opencode:<password>` header (v1.2.0 enables auth only when a password is
 * present; the header is a no-op for servers that don't require it).
 */

export interface V1SessionInfo {
  sessionId: string;
  finish: string;
  role: string;
  text: string;
  raw: { info: { finish?: string; role?: string } | undefined; parts: unknown[] };
}

export interface V1Client {
  readonly url: string;
  readonly directory: string;
  /** `GET /app/agents` connectivity probe; resolves to the server url. */
  probe(): Promise<string>;
  /** `POST /session` -> session id, or throws on failure. */
  create(): Promise<string>;
  /** Submit a prompt and wait for the terminal event + final message. */
  prompt(input: V1PromptInput): Promise<OpenCodePromptResult>;
  /** `POST /session/{id}/abort`; no-op on a finished session. */
  abort(sessionId: string): Promise<void>;
}

export interface V1PromptInput {
  sessionId: string;
  title: string;
  description: string;
  projectDirectory: string;
  model: { providerID: string; modelID: string };
  agent?: string;
  tools?: Record<string, boolean>;
  promptTimeoutMs: number;
}

export interface V1ServerOptions extends ServerOptions {
  directory: string;
  password: string;
}

function makeClient(options: { baseUrl: string; directory: string; headers?: Record<string, string> }): OpencodeClient {
  return createOpencodeClient({ baseUrl: options.baseUrl, directory: options.directory, headers: options.headers });
}

export function createV1Client(server: { url: string; close(): void }, options: V1ServerOptions): V1Client {
  const baseUrl = server.url;
  const client = makeClient({
    baseUrl,
    directory: options.directory,
    headers: { authorization: basicAuthHeader(options.password) },
  });
  return new V1ClientImpl({ url: baseUrl, directory: options.directory, client });
}

function v1Probe(client: OpencodeClient, baseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    void client
      .app.agents({})
      .then((agents) => (agents.error ? reject(new Error(`opencode agents probe failed: ${JSON.stringify(agents.error).slice(0, 300)}`)) : resolve(baseUrl)))
      .catch(reject);
  });
}

export class V1ClientImpl implements V1Client {
  readonly url: string;
  readonly directory: string;
  private readonly client: OpencodeClient;
  constructor({ url, directory, client }: { url: string; directory: string; client: OpencodeClient }) {
    this.url = url;
    this.directory = directory;
    this.client = client;
  }
  probe(): Promise<string> {
    return v1Probe(this.client, this.url);
  }
  create(): Promise<string> {
    return v1Create(this.client);
  }
  prompt(input: V1PromptInput): Promise<OpenCodePromptResult> {
    return v1Prompt(this.client, input);
  }
  abort(sessionId: string): Promise<void> {
    return v1Abort(this.client, sessionId);
  }
}

function v1Create(client: OpencodeClient): Promise<string> {
  return new Promise((resolve, reject) => {
    void client
      .session.create({ body: {} })
      .then((created) => {
        if (created.error || created.data?.id === undefined) {
          reject(new Error(`failed to create opencode session: ${JSON.stringify(created.error ?? {})}`));
          return;
        }
        resolve(created.data.id);
      })
      .catch(reject);
  });
}

function v1Abort(client: OpencodeClient, sessionId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void client
      .session.abort({ path: { id: sessionId } })
      .then(() => resolve())
      .catch(() => resolve());
  });
}

async function v1Prompt(client: OpencodeClient, input: V1PromptInput): Promise<OpenCodePromptResult> {
  const text = [
    `Task: ${input.title}`,
    input.description.length > 0 ? `\nDescription:\n${input.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Subscribe BEFORE firing the prompt so no early events are lost.
  const events = await client.event.subscribe({});
  const timer = setTimeout(() => {
    void events.stream.return(undefined as never).catch(() => undefined);
  }, input.promptTimeoutMs);
  let idle = false;
  let streamErrorMessage: string | undefined;
  try {
    const accepted = await client.session.promptAsync({
      path: { id: input.sessionId },
      query: { directory: input.projectDirectory },
      body: {
        model: input.model,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        parts: [{ type: "text", text }],
      },
    });
    if (accepted.error !== undefined) {
      throw new Error(
        `opencode promptAsync failed: ${JSON.stringify(accepted.error).slice(0, 400)} (session ${input.sessionId})`,
      );
    }

    for await (const rawEvent of events.stream) {
      const event = rawEvent as { type?: string; properties?: { sessionID?: string; error?: unknown } };
      if (event.type === "session.idle" && event.properties?.sessionID === input.sessionId) {
        idle = true;
        break;
      }
      if (event.type === "session.error" && (event.properties?.sessionID ?? input.sessionId) === input.sessionId) {
        streamErrorMessage = JSON.stringify(event.properties?.error ?? event.properties ?? {}).slice(0, 400);
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    void events.stream.return(undefined as never).catch(() => undefined);
  }
  if (!idle) {
    throw new Error(streamErrorMessage ?? `opencode prompt timed out after ${input.promptTimeoutMs}ms (session ${input.sessionId})`);
  }

  let lastMessagesError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const messages = await client.session.messages({ path: { id: input.sessionId } });
    if (messages.error !== undefined || messages.data === undefined) {
      lastMessagesError = messages.error;
      if (attempt === 4) {
        throw new Error(`failed to read opencode messages: ${JSON.stringify(lastMessagesError ?? {})}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    const assistantMessages = messages.data.filter((m) => m.info?.role === "assistant");
    const assistant = assistantMessages[assistantMessages.length - 1];
    if (assistant === undefined) {
      throw new Error(`opencode session ${input.sessionId} has no assistant message`);
    }
    const parts = assistant.parts ?? [];
    const reply = parts
      .map((p) => (typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter((s) => s.length > 0)
      .join(" ")
      .trim();
    const info = assistant.info as { finish?: string; role?: string };
    return {
      sessionId: input.sessionId,
      finish: String(info.finish ?? "unknown"),
      role: String(info.role ?? "assistant"),
      text: reply,
      raw: { info, parts },
    };
  }
  throw new Error(`opencode messages remained unreadable (session ${input.sessionId})`);
}

/** Shared with the facade; the facade owns the server + session state. */
export function parseModelString(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`invalid model string "${model}"; expected "<providerID>/<modelID>\"`);
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
