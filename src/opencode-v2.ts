import {
  OpenCode,
  type EventSubscribeInput,
  type SessionMessagesResponse,
  type SessionMessageAssistant,
  type SessionMessageInfo,
} from "@opencode/client";
import { spawnOpenCodeServer, basicAuthHeader, type ServerOptions } from "./opencode-server.ts";

import type { OpenCodePromptResult } from "./opencode.ts";

/**
 * OpenCode v2 backend (CLI ≥ v2.x, @opencode/client 2.x).
 *
 * The v2 protocol differs from v1 in every transport detail, but the
 * orchestrator's `OpenCodeAdapter` contract is unchanged, so this module
 * normalizes v2's responses into the exact `OpenCodePromptResult` shape the
 * existing consumers (`runner.ts`, `cycle.ts`, `discovery.ts`) already expect.
 *
 * v2 specifics:
 *   * agents:   GET  /api/agent?location[directory]=…   -> { location, data: AgentInfo[] }
 *   * create:   POST /api/session  { model, location }   -> SessionInfo { id }
 *   * prompt:   POST /api/session/{id}/prompt { text }   -> 202, returns immediately
 *   * events:   GET  /api/event (SSE, optional `types` filter)
 *   * messages: GET  /api/session/{id}/message?type=assistant -> { data, cursor }
 *   * interrupt: POST /api/session/{id}/interrupt        -> { interrupted }
 *
 * Errors are thrown `ClientError`s (Transport | UnexpectedStatus |
 * UnsupportedContentType | MalformedResponse | SseEventTooLarge) rather than
 * `{ error }` result objects, so failures surface as rejections.
 */

export interface V2SessionInfo {
  sessionId: string;
  finish: string;
  role: string;
  text: string;
  raw: { info: { finish?: string; role?: string } | undefined; parts: unknown[] };
}

export interface V2Client {
  readonly url: string;
  readonly directory: string;
  probe(): Promise<string>;
  create(): Promise<string>;
  prompt(input: V2PromptInput): Promise<OpenCodePromptResult>;
  abort(sessionId: string): Promise<void>;
}

export interface V2PromptInput {
  sessionId: string;
  title: string;
  description: string;
  projectDirectory: string;
  promptTimeoutMs: number;
}

export interface V2ServerOptions extends ServerOptions {
  directory: string;
  model: { providerID: string; modelID: string };
  location?: { directory: string };
  password: string;
}

export function createV2Client(server: { url: string; close(): void }, options: V2ServerOptions): V2Client {
  const baseUrl = server.url;
  const client = OpenCode.make({
    baseUrl,
    headers: { authorization: basicAuthHeader(options.password) },
  });
  return new V2ClientImpl({
    url: baseUrl,
    directory: options.directory,
    client,
    location: options.location,
    modelProvider: options.model.providerID,
    modelId: options.model.modelID,
    password: options.password,
    hostname: options.hostname,
    port: options.port,
    timeout: options.timeout,
  });
}

function v2Probe(client: ReturnType<typeof OpenCode.make>, baseUrl: string, location?: { directory: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    void client
      .agent.list({ location })
      .then((agents) => {
        // v2 has no per-request error envelope; a transport failure surfaces
        // as a thrown ClientError instead.
        resolve(baseUrl);
      })
      .catch(reject);
  });
}

function v2Create(client: ReturnType<typeof OpenCode.make>, options: V2ServerOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    void client
      .session.create({
        model: { providerID: options.model.providerID, id: options.model.modelID },
        location: options.location ?? { directory: options.directory },
      })
      .then((created) => {
        // SessionInfo carries no error envelope; transport failures throw.
        if (created.id === undefined) {
          reject(new Error(`failed to create opencode session: ${JSON.stringify(created)}`));
          return;
        }
        resolve(created.id);
      })
      .catch(reject);
  });
}

export interface V2ClientImplOptions {
  url: string;
  directory: string;
  client: ReturnType<typeof OpenCode.make>;
  location?: { directory: string };
  /** Configured model, propagated to session.create so the server runs the right provider/model. */
  modelProvider: string;
  modelId: string;
  password: string;
  hostname: string;
  port: number;
  timeout: number;
}

export class V2ClientImpl implements V2Client {
  readonly url: string;
  readonly directory: string;
  private readonly client: ReturnType<typeof OpenCode.make>;
  private readonly location?: { directory: string };
  private readonly modelProvider: string;
  private readonly modelId: string;
  private readonly password: string;
  private readonly hostname: string;
  private readonly port: number;
  private readonly timeout: number;
  constructor({ url, directory, client, location, modelProvider, modelId, password, hostname, port, timeout }: V2ClientImplOptions) {
    this.url = url;
    this.directory = directory;
    this.client = client;
    this.location = location;
    this.modelProvider = modelProvider;
    this.modelId = modelId;
    this.password = password;
    this.hostname = hostname;
    this.port = port;
    this.timeout = timeout;
  }
  probe(): Promise<string> {
    return v2Probe(this.client, this.url, this.location);
  }
  create(): Promise<string> {
    return v2Create(this.client, {
      directory: this.directory,
      model: { providerID: this.modelProvider, modelID: this.modelId },
      location: this.location ?? { directory: this.directory },
      password: this.password,
      hostname: this.hostname,
      port: this.port,
      timeout: this.timeout,
    });
  }
  abort(sessionId: string): Promise<void> {
    return v2Abort(this.client, sessionId);
  }
  prompt(input: V2PromptInput): Promise<OpenCodePromptResult> {
    return v2Prompt(this.client, input);
  }
}

function v2Abort(client: ReturnType<typeof OpenCode.make>, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    void client
      .session.interrupt({ sessionID: sessionId })
      .then(() => {
        // Interrupting an already-finished session is a no-op; late results are
        // discarded by the caller regardless.
        resolve();
      })
      .catch(reject);
  });
}

/** Terminal (non-streaming) signals: the run is done or errored. */
const TERMINAL_EVENT_TYPES: Array<string> = [
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.status",
];

async function v2Prompt(client: ReturnType<typeof OpenCode.make>, input: V2PromptInput): Promise<OpenCodePromptResult> {
  const text = [
    `Task: ${input.title}`,
    input.description.length > 0 ? `\nDescription:\n${input.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // ONE deadline bounds the whole operation: the prompt POST, the wait for a
  // terminal SSE event, and the final assistant-message read. The deadline
  // aborts the signal handed to every request: the generated client forwards
  // `requestOptions.signal` into the fetch init (promise/generated/client.d.ts,
  // `RequestOptions.signal`), and an aborted signal rejects a pending SSE
  // `reader.read()` (verified against the installed 2.2.7 client), which
  // unwinds the subscriber's generator including its
  // `finally { await reader.cancel() }`. The subscriber's AsyncIterable is NOT
  // relied on for cleanup: `.return()` cannot unstick a read that never
  // settles.
  const controller = new AbortController();
  const timeoutError = new Error(
    `opencode prompt timed out after ${input.promptTimeoutMs}ms (session ${input.sessionId})`,
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, input.promptTimeoutMs);
  });

  // Subscribe BEFORE firing the prompt so no early events are lost. The
  // shared-events `subscribe(options?: SubscribeOptions)` carries the abort
  // signal inside the options object (`signal?: AbortSignal`), which the
  // underlying SSE fetch consumes.
  const events = client.event.subscribe({ signal: controller.signal });

  // The consumer runs as its own task so the deadline can abandon it: the
  // post-race `.catch` in the finally block keeps an abort-induced rejection
  // (e.g. the aborted SSE read surfacing as ClientError Transport) from
  // becoming an unhandled rejection, while a genuine pre-timeout failure
  // propagates through the race untouched.
  const consume = (async (): Promise<OpenCodePromptResult> => {
    // The inbox acknowledgement carries no error field; a transport-level
    // failure surfaces as a thrown ClientError instead.
    await client.session.prompt({ sessionID: input.sessionId, text }, { signal: controller.signal });

    let terminalEvent: { type: string; data?: unknown } | undefined;
    let streamErrorMessage: string | undefined;
    for await (const rawEvent of events) {
      const event = rawEvent as { type: string; data?: unknown };
      if (event.type === "session.error" || event.type === "session.execution.failed") {
        streamErrorMessage = JSON.stringify(event.data ?? {}).slice(0, 400);
        break;
      }
      if (event.type === "session.status") {
        const status = (event.data as { status?: unknown })?.status;
        if (status === "idle") {
          terminalEvent = event;
          break;
        }
        continue;
      }
      if (TERMINAL_EVENT_TYPES.includes(event.type)) {
        terminalEvent = event;
        break;
      }
    }

    if (!terminalEvent) {
      throw new Error(streamErrorMessage ?? timeoutError.message);
    }

    // Reading the final assistant message is part of the same prompt
    // operation, so the deadline covers it too. The list MUST be requested in
    // chronological order explicitly: the server's default is newest-first
    // (verified against opencode 2.2.6 — an omitted `order` returns the same
    // sequence as "desc"), so the old `data[data.length - 1]` picked the
    // OLDEST assistant message — the model's first step (often tool calls
    // with empty text) — and discarded the actual deliverable.
    const messages = await client.message.list(
      { sessionID: input.sessionId, type: "assistant", order: "asc" },
      { signal: controller.signal },
    );
    const assistant = messages.data[messages.data.length - 1] as SessionMessageAssistant;
    if (assistant === undefined) {
      throw new Error(`opencode session ${input.sessionId} has no assistant message`);
    }
    const reply = normalizeText(assistant.content ?? []);
    const finish = String(assistant.finish ?? "unknown");
    const parts = normalizeParts(assistant.content ?? []);
    return {
      sessionId: input.sessionId,
      finish,
      role: "assistant",
      text: reply,
      raw: { info: { finish, role: "assistant" }, parts },
    };
  })();

  try {
    return await Promise.race([consume, timedOut]);
  } catch (error) {
    // The deadline error carries its own diagnostic; genuine SDK/stream
    // errors are wrapped so the HTTP reason/detail survive into the
    // diagnostic (see toOpencodeError).
    if (error === timeoutError) throw timeoutError;
    throw toOpencodeError(error, input.sessionId);
  } finally {
    clearTimeout(timer);
    // If the deadline won, consume is still unwinding; its abort-induced
    // rejection must never surface as an unhandled rejection.
    consume.catch(() => undefined);
  }
}

/** Text content only, joined in stream order — the deliverable is in the LAST
 * assistant message, so later messages overwrite earlier narration. */
function normalizeText(content: Array<{ type: string; text?: unknown }>): string {
  return (content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ")
    .trim();
}

/**
 * Map v2's `content[]` entries onto the v1-style parts shape the runner
 * already consumes (`type === "tool"` with a `tool` field). Tool calls keep
 * their `tool` name and state; text/reasoning entries keep their type.
 */
function normalizeParts(content: Array<{ type: string; text?: unknown; name?: unknown; state?: unknown; id?: unknown }>): unknown[] {
  return (content ?? []).map((entry) => {
    if (entry.type === "tool") {
      return { type: "tool", tool: entry.name, state: entry.state, id: entry.id };
    }
    if (entry.type === "text") return { type: "text", text: entry.text };
    if (entry.type === "reasoning") return { type: "reasoning", text: entry.text ?? "" };
    return entry;
  });
}

/**
 * Rejection wrapper so v2 `ClientError` details stay readable to callers.
 *
 * The SDK's `ClientError` carries the HTTP `reason` (e.g. `UnsupportedContentType`),
 * the `detail` (content-type header or status text) and the original `message` under
 * `cause`. Collapsing it to `message` alone destroys the diagnostics that tell you
 * which endpoint misbehaved, so both `reason` and `detail` are kept. No credential
 * is ever copied through — the SDK never puts one in `detail`.
 */
export function toOpencodeError(error: unknown, sessionId?: string): Error {
  if (error instanceof Error) {
    if (error.name === "ClientError") {
      const detail = (error as { detail?: unknown }).detail;
      const detailText =
        detail === undefined || detail === null
          ? undefined
          : typeof detail === "string"
            ? detail
            : JSON.stringify(detail);
      const reason = (error as { reason?: unknown }).reason;
      const bits: string[] = [error.message];
      if (detailText !== undefined) bits.push(`detail: ${detailText}`);
      if (reason !== undefined && reason !== null && reason !== "") bits.push(`reason: ${reason}`);
      return new Error(`opencode ClientError (${bits.join("; ")})`);
    }
    return new Error(error.message);
  }
  return new Error(`opencode failed (session ${sessionId ?? ""}): ${JSON.stringify(error ?? {})}`);
}
