import {
  OpenCode,
  type EventSubscribeInput,
  type SessionMessagesResponse,
  type SessionMessageAssistant,
  type SessionMessageInfo,
} from "@opencode/client";
import { spawnOpenCodeServer, basicAuthHeader, type ServerOptions } from "./opencode-server.ts";

import type { OpenCodePromptResult, TurnStats } from "./opencode.ts";

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
  /**
   * Primary agent for sessions created by this client (v2 selects the agent
   * at session creation; there is no per-prompt agent parameter).
   * undefined → the server's default agent, and the session.create body is
   * unchanged from the previous behavior.
   */
  agent?: string;
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
    agent: options.agent,
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
        // The agent is bound at session creation in v2; omitted entirely when
        // unset so the request body stays byte-identical to before.
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
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
  /** Primary agent for created sessions; undefined keeps the server default. */
  agent?: string;
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
  private readonly agent: string | undefined;
  private readonly password: string;
  private readonly hostname: string;
  private readonly port: number;
  private readonly timeout: number;
  constructor({ url, directory, client, location, modelProvider, modelId, agent, password, hostname, port, timeout }: V2ClientImplOptions) {
    this.url = url;
    this.directory = directory;
    this.client = client;
    this.location = location;
    this.modelProvider = modelProvider;
    this.modelId = modelId;
    this.agent = agent;
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
      agent: this.agent,
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

// ——— turn statistics (observability only; never affects prompt behavior) ———

/** Defensive type guard for the `unknown` payloads arriving over the SSE wire. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A usable non-negative finite number (timestamp or count). */
function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Mutable per-step token sums; `observed` stays false until a real numeric
 *  field has been seen, so a missing measurement is never reported as zero. */
interface TokenSums {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  observed: boolean;
}

function emptyTokenSums(): TokenSums {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, observed: false };
}

/** Add one step's token usage to the sums. Every field is validated
 *  independently, so partial or malformed payloads still contribute exactly
 *  what they genuinely carry. Returns true when at least one numeric field
 *  was observed. */
function accumulateTokens(raw: unknown, sums: TokenSums): boolean {
  if (!isRecord(raw)) return false;
  const cache = isRecord(raw.cache) ? raw.cache : {};
  const fields: Array<["input" | "output" | "reasoning" | "cacheRead" | "cacheWrite", unknown]> = [
    ["input", raw.input],
    ["output", raw.output],
    ["reasoning", raw.reasoning],
    ["cacheRead", cache.read],
    ["cacheWrite", cache.write],
  ];
  let any = false;
  for (const [key, value] of fields) {
    const n = asCount(value);
    if (n !== undefined) {
      sums[key] += n;
      any = true;
    }
  }
  return any;
}

/** Finalize the turn's statistics and attach the snapshot to the prompt's
 *  result or rejection, so the caller can emit it on its own lifecycle
 *  channel. Best effort: a snapshot failure is swallowed and the carrier
 *  passes through unchanged — instrumentation never alters the outcome. */
function attachTurnStats(
  carrier: object,
  stats: TurnStatsCollector,
  outcome: TurnStats["outcome"],
): void {
  try {
    (carrier as { turnStats?: TurnStats }).turnStats = stats.snapshot(outcome);
  } catch {
    // ignore: statistics are observational
  }
}

interface TurnStatsCollector {
  /** Record one SSE event. Never throws; malformed events are skipped. */
  observe(event: unknown): void;
  /** Build the immutable statistics snapshot for the turn's outcome. */
  snapshot(outcome: TurnStats["outcome"]): TurnStats;
}

/**
 * Accumulates turn statistics from the SSE events a prompt already receives.
 *
 * Everything is read defensively (unknown payloads, validated fields) and the
 * whole event handling is isolated in its own try/catch: a malformed event
 * must never break the prompt, the stream consumption, or the statistics.
 *
 * Canonical sources, to avoid double counting:
 *   * steps / finish reasons / per-step tokens — the durable `step-start` /
 *     `step-finish` PARTS on `message.part.updated`, deduped by part id (a
 *     part is updated incrementally and may be observed repeatedly). The
 *     dedicated `session.step.*` events are only a fallback when no part was
 *     observed, and only one of the two sources is ever summed.
 *   * aggregate usage events (`session.usage.*`, `message.updated`) are
 *     never added on top of per-step data.
 */
function createTurnStatsCollector(sessionId: string): TurnStatsCollector {
  const startedAt = Date.now();
  let lastEventAt: number | undefined;
  let firstStepAt: number | undefined;
  let terminalType: string | undefined;
  // steps: identifiable step-start parts win; unidentifiable parts and the
  // dedicated `session.step.started` events are the fallback count.
  const stepPartIds = new Set<string>();
  let unidentifiableStepStarts = 0;
  let stepStartedEvents = 0;
  // per-step finishes: parts are canonical, `session.step.ended` the fallback.
  const finishPartIds = new Set<string>();
  let sawFinishPart = false;
  const partFinishReasons: string[] = [];
  const partTokens = emptyTokenSums();
  const endedMessageIds = new Set<string>();
  const endedFinishReasons: string[] = [];
  const endedTokens = emptyTokenSums();
  // tools: one entry per call identity (callID, else the part id, else the
  // event itself); the first observed name wins.
  const toolNameById = new Map<string, string>();
  const toolSpanById = new Map<string, number>();
  let unidentifiableTools = 0;
  let retries = 0;

  const noteStepStart = (id: unknown, now: number): void => {
    if (typeof id === "string" && id.length > 0) stepPartIds.add(id);
    else unidentifiableStepStarts += 1;
    firstStepAt ??= now;
  };

  const noteToolPart = (part: Record<string, unknown>): void => {
    const callId = typeof part.callID === "string" && part.callID.length > 0 ? part.callID : undefined;
    const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined;
    const identity = callId ?? (partId !== undefined ? `prt:${partId}` : `evt:${unidentifiableTools++}`);
    if (!toolNameById.has(identity)) {
      const name = typeof part.tool === "string" && part.tool.length > 0 ? part.tool : "unknown";
      toolNameById.set(identity, name);
    }
    // duration: server-side start/end (with the message.list field names as
    // a fallback); measured at most once per call, first measurement wins.
    const state = isRecord(part.state) ? part.state : {};
    const time = isRecord(state.time) ? state.time : {};
    const start = asCount(time.start) ?? asCount(time.ran);
    const end = asCount(time.end) ?? asCount(time.completed);
    if (start !== undefined && end !== undefined && end >= start && !toolSpanById.has(identity)) {
      toolSpanById.set(identity, end - start);
    }
  };

  const notePart = (part: Record<string, unknown>, now: number): void => {
    switch (part.type) {
      case "step-start":
        noteStepStart(part.id, now);
        return;
      case "step-finish": {
        sawFinishPart = true;
        const id = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined;
        // parts are updated incrementally: only the first sighting of a step
        // finish contributes (a part without an id cannot be deduped)
        if (id !== undefined && finishPartIds.has(id)) return;
        if (id !== undefined) finishPartIds.add(id);
        if (typeof part.reason === "string") partFinishReasons.push(part.reason);
        if (accumulateTokens(part.tokens, partTokens)) partTokens.observed = true;
        return;
      }
      case "tool":
        noteToolPart(part);
        return;
      default:
        // text/reasoning/… parts carry no statistics; their contents are
        // never read
        return;
    }
  };

  return {
    observe(rawEvent: unknown): void {
      try {
        if (!isRecord(rawEvent)) return;
        const type = rawEvent.type;
        if (typeof type !== "string") return;
        const now = Date.now();
        lastEventAt = now;
        const data = isRecord(rawEvent.data) ? rawEvent.data : {};
        if (type === "message.part.updated") {
          const part = data.part;
          if (isRecord(part)) notePart(part, now);
        } else if (type === "session.step.started") {
          stepStartedEvents += 1;
          firstStepAt ??= now;
        } else if (type === "session.step.ended") {
          const messageId = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
          if (messageId !== undefined && endedMessageIds.has(messageId)) return;
          if (messageId !== undefined) endedMessageIds.add(messageId);
          if (typeof data.finish === "string") endedFinishReasons.push(data.finish);
          if (accumulateTokens(data.tokens, endedTokens)) endedTokens.observed = true;
        } else if (type === "session.status") {
          const status = data.status;
          if (isRecord(status)) {
            const attempt = status.attempt;
            if (typeof attempt === "number" && Number.isFinite(attempt) && attempt > retries) {
              retries = attempt;
            }
          }
        }
        // Mirror the consumer's terminality so the snapshot can name the
        // event that ended the turn (busy/retry statuses are not terminal).
        const terminal =
          type === "session.error" ||
          type === "session.execution.failed" ||
          (type === "session.status" && data.status === "idle") ||
          (TERMINAL_EVENT_TYPES.includes(type) && type !== "session.status");
        if (terminal) terminalType ??= type;
      } catch {
        // statistics are observational: a malformed event must never break
        // the prompt or the stream
      }
    },

    snapshot(outcome: TurnStats["outcome"]): TurnStats {
      const now = Date.now();
      const wallMs = Math.max(0, now - startedAt);
      const steps =
        stepPartIds.size > 0 ? stepPartIds.size : unidentifiableStepStarts + stepStartedEvents;
      const toolCalls: Record<string, number> = {};
      for (const name of toolNameById.values()) {
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
      }
      let toolSpanMs: number | null = null;
      if (toolSpanById.size > 0) {
        toolSpanMs = 0;
        for (const span of toolSpanById.values()) toolSpanMs += span;
      }
      // exactly one canonical token/finish-reason source: durable step-finish
      // parts when any was observed, else the step.ended events
      const usedParts = sawFinishPart;
      const sums = usedParts ? partTokens : endedTokens;
      const tokens: TurnStats["tokens"] = sums.observed
        ? {
            input: sums.input,
            output: sums.output,
            reasoning: sums.reasoning,
            cacheRead: sums.cacheRead,
            cacheWrite: sums.cacheWrite,
          }
        : null;
      const reasons = usedParts ? partFinishReasons : endedFinishReasons;
      return {
        sessionId,
        outcome,
        terminalEvent: outcome === "timeout" ? "deadline" : (terminalType ?? null),
        wallMs,
        steps,
        firstStepAtMs: firstStepAt === undefined ? null : Math.max(0, firstStepAt - startedAt),
        lastEventAtMs: lastEventAt === undefined ? null : Math.max(0, lastEventAt - startedAt),
        toolCalls,
        toolSpanMs,
        unattributedSpanMs: toolSpanMs === null ? null : Math.max(0, wallMs - toolSpanMs),
        tokens,
        finishReasons: reasons.length > 0 ? [...reasons] : null,
        retries,
      };
    },
  };
}

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

  // Turn statistics are collected from the events this prompt already
  // receives — no extra request. The collector lives in THIS scope (not the
  // consumer task's) so the deadline path can still snapshot the partial
  // statistics after the consumer has been abandoned.
  const stats = createTurnStatsCollector(input.sessionId);

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
      // an SSE data block may be any JSON value; non-object blocks carry no
      // event type and are skipped before anything reads into them
      if (!isRecord(rawEvent)) continue;
      const event = rawEvent as { type: string; data?: unknown };
      // statistics first, so the terminal event itself is recorded too;
      // observe() is defensive and never throws
      stats.observe(rawEvent);
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
    const result = await Promise.race([consume, timedOut]);
    attachTurnStats(result, stats, "completed");
    return result;
  } catch (error) {
    // The deadline error carries its own diagnostic; genuine SDK/stream
    // errors are wrapped so the HTTP reason/detail survive into the
    // diagnostic (see toOpencodeError). Both rejections carry the turn's
    // statistics snapshot (attached above by attachTurnStats).
    if (error === timeoutError) {
      // The deadline won: snapshot whatever partial statistics accumulated
      // BEFORE the abandoned consumer's state is lost, and let them travel
      // with the original timeout error so the caller can still emit them.
      attachTurnStats(timeoutError, stats, "timeout");
      throw timeoutError;
    }
    const wrapped = toOpencodeError(error, input.sessionId);
    attachTurnStats(wrapped, stats, "error");
    throw wrapped;
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
