/**
 * Real-time terminal lifecycle logging side channel.
 *
 * `LifecycleLogger` observes actual execution and writes structured, readable
 * lines to the terminal. It never writes to the database, never persists
 * events, and never changes business logic, state transitions, model prompts,
 * lock/lease semantics, or existing terminal output strings. It is an
 * additional observational channel layered on top of the commands' existing
 * output.
 *
 * Every line is optional: callers inject a `LifecycleLogger` to observe, or
 * omit it entirely (the default sink is stdout) to stay silent. In unit tests
 * the logger is injected with a capturing sink and a deterministic clock so
 * heartbeats and elapsed times are assertable.
 *
 * The schema reports only observable events: stage start/completion, elapsed
 * time, heartbeats that say `pending`/`elapsed` (never implying model
 * progress), observed task state transitions, and errors/early exits.
 */

/** Injectable clock (tests). Same shape as clock.ts's internal `NowFn`. */
type NowFn = () => number;

const DEFAULT_HEARTBEAT_EVERY_MS = 5_000;

/** Default sink appends a newline — matches the CLI's `onOutput`/`process.stdout.write` contract. */
function defaultSink(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

/** The line's own columns; `renderDetails` never echoes them. */
const COLUMN_KEYS = new Set(["level", "operation", "stage", "event"]);

/** `extra` keys that duplicate the line's own computed columns; `log()`
 *  strips them so callers cannot spoof or conflict with the stage tracker's
 *  own `durationMs`/`elapsedMs` or the event's own `level`/`stage`/`event`. */
const RESERVED_EVENT_KEYS = new Set(["level", "operation", "stage", "event", "durationMs", "elapsedMs"]);

/** Formats a key/value detail column: `key=value key=value`. Values are strings or numbers. */
function renderDetails(extra: object): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    if (COLUMN_KEYS.has(k)) continue; // already rendered as its own column
    parts.push(`${k}=${typeof v === "string" ? v : String(v)}`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

/** Local time as `[HH:MM:SS]`. */
function formatClock(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

export type LifecycleLevel = "INFO" | "DEBUG" | "WARN" | "ERROR";

/**
 * Structured lifecycle event. Fields are populated only when observable — the
 * logger never invents values.
 */
export interface LifecycleEvent {
  level: LifecycleLevel;
  operation: string;
  stage: string;
  /** Human-readable event kind: started, completed, pending, transition, error, info, skipped. */
  event: string;
  /** ms the stage took (completed). */
  durationMs?: number;
  /** ms since the stage started (pending/heartbeat). */
  elapsedMs?: number;
  taskId?: string;
  areaId?: string;
  modelId?: string;
  fromState?: string | null;
  toState?: string | null;
  detail?: string;
  /** sanitized error summary (never a full stack / raw model response). */
  error?: string;
}

export interface LifecycleLoggerOptions {
  /** Output sink. Defaults to console.log (newline-terminated). */
  sink?: (line: string) => void;
  /** Heartbeat interval for active stages (ms). 0 disables heartbeats. */
  heartbeatEveryMs?: number;
  /** Injectable clock (tests). */
  now?: NowFn;
}

/**
 * One terminal line, aligned like `doctor`'s `padEnd(4)/padEnd(2)` columns:
 * `[HH:MM:SS] <LEVEL>  <operation>  <stage>  <event>  <key=value ...>`.
 */
function formatLine(ev: LifecycleEvent): string {
  const clock = formatClock();
  const level = ev.level.padEnd(4);
  const op = ev.operation.padEnd(10);
  const stage = ev.stage.padEnd(20);
  const kind = ev.event.padStart(10); // right-aligned event column
  const details = renderDetails(ev);
  return `${clock} ${level}  ${op}  ${stage}  ${kind}${details}`;
}

export class LifecycleLogger {
  private sink: (line: string) => void;
  private heartbeatEveryMs: number;
  private readonly now: NowFn;

  // active stages, per operation+stage, for start/completion/elapsed tracking
  private readonly stages = new Map<string, { stage: string; startedAt: number }>();
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();

  private key(op: string, stage: string): string {
    return `${op}::${stage}`;
  }

  constructor(options: LifecycleLoggerOptions = {}) {
    this.sink = options.sink ?? defaultSink;
    this.heartbeatEveryMs = options.heartbeatEveryMs ?? DEFAULT_HEARTBEAT_EVERY_MS;
    this.now = options.now ?? Date.now;
  }

  /** Drop `extra` keys that would duplicate the event's own columns, and
   *  undefined/null values (renderDetails would skip them anyway). */
  private sanitize(extra: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(extra).filter(([k, v]) => !RESERVED_EVENT_KEYS.has(k) && v !== undefined && v !== null),
    );
  }

  /** Replace the output sink (tests). */
  useSink(sink: (line: string) => void): void {
    this.sink = sink;
  }

  /** Set the heartbeat interval. 0 disables heartbeats. */
  setHeartbeatEveryMs(ms: number): void {
    this.heartbeatEveryMs = ms;
  }

  /**
   * Emit a structured lifecycle event. `stage` is the stage name; `event` is
   * the kind. Callers usually prefer `start`/`complete`/`heartbeat`/`transition`
   * /`error`/`info`/`warn` which set sensible defaults. Reserved
   * `level`/`operation`/`stage`/`event`/`durationMs`/`elapsedMs` keys in
   * `extra` are stripped so a caller can never echo the line's own columns
   * with conflicting values.
   */
  log(
    level: LifecycleLevel,
    operation: string,
    stage: string,
    event: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.emitLine({ level, operation, stage, event, ...this.sanitize(extra) });
  }

  /** Emit an already-formed `LifecycleEvent` (the bridge for internal emitters
   *  such as the discovery engine's `onLifecycle` callback). No
   *  re-sanitization: the emitter built the event's own columns, including
   *  its own `durationMs`/`elapsedMs`, which `log()` would strip from `extra`. */
  emitEvent(ev: LifecycleEvent): void {
    this.emitLine(ev);
  }

  /** Format and write one event. Display-only: a failing sink is swallowed so
   *  logging can never alter execution outcomes, exit codes or process health. */
  private emitLine(ev: LifecycleEvent): void {
    try {
      this.sink(formatLine(ev));
    } catch {
      // ignore: the lifecycle channel must never break the command it observes
    }
  }

  /** Begin a stage. Logs `<stage> started` and starts tracking elapsed time.
   *  Multiple stages may share an operation (e.g. claim → prompt); the
   *  tracker is keyed by operation+stage. */
  start(operation: string, stage: string, extra: Record<string, unknown> = {}): void {
    this.log("INFO", operation, stage, "started", extra);
    this.stages.set(this.key(operation, stage), { stage, startedAt: this.now() });
  }

  /** End a stage. Logs `<stage> completed` with the elapsed duration and
   *  clears its tracker. The tracker-computed `durationMs` is added after
   *  sanitization so a caller-supplied `durationMs` can never override it. */
  complete(operation: string, stage: string, extra: Record<string, unknown> = {}): void {
    const entry = this.stages.get(this.key(operation, stage));
    const durationMs = entry === undefined ? undefined : this.now() - entry.startedAt;
    this.stages.delete(this.key(operation, stage));
    this.stopHeartbeat(operation, stage);
    this.emitLine({
      level: "INFO",
      operation,
      stage,
      event: "completed",
      ...this.sanitize(extra),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }

  /**
   * Report a stage is still running (used by heartbeats). Always says
   * `pending` and `elapsedMs` — never that the model is making progress.
   */
  heartbeat(operation: string, stage: string, extra: Record<string, unknown> = {}): void {
    const entry = this.stages.get(this.key(operation, stage));
    const elapsedMs = entry === undefined ? undefined : this.now() - entry.startedAt;
    this.emitLine({
      level: "INFO",
      operation,
      stage,
      event: "pending",
      ...this.sanitize(extra),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
  }

  /** Observe a task state transition (from actual store state, never invented). */
  transition(
    operation: string,
    taskId: string,
    fromState: string | null,
    toState: string | null,
    detail?: string,
  ): void {
    if (fromState === toState) return;
    this.log("INFO", operation, "state", "transition", {
      taskId,
      fromState,
      toState,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /** Report an error / early exit. The message is a summary, never a stack or raw model response. */
  error(operation: string, stage: string, message: string, extra: Record<string, unknown> = {}): void {
    this.log("ERROR", operation, stage, "error", { ...extra, error: message });
  }

  /** Report a warning. */
  warn(operation: string, stage: string, message: string, extra: Record<string, unknown> = {}): void {
    this.log("WARN", operation, stage, "warn", { ...extra, error: message });
  }

  /** Report a plain informational line for an operation. The message becomes
   *  the event column (e.g. "instance lock acquired", "skipped", "stopped");
   *  `extra` keys render as details. */
  info(operation: string, stage: string, message: string, extra: Record<string, unknown> = {}): void {
    this.log("INFO", operation, stage, message, extra);
  }

  /**
   * Start a periodic heartbeat for an active stage. Re-entrant: calling while
   * a heartbeat is active restarts the timer. Stopped automatically by
   * `complete` and by `stopHeartbeat`. A no-op when the interval is 0.
   */
  beginHeartbeat(operation: string, stage: string): void {
    this.stopHeartbeat(operation, stage);
    if (this.heartbeatEveryMs > 0) {
      const interval = this.heartbeatEveryMs;
      const handle = setInterval(() => this.heartbeat(operation, stage), interval);
      // never keep the event loop alive for a display-only channel
      handle.unref?.();
      this.heartbeats.set(this.key(operation, stage), handle);
    }
  }

  /** Stop any active heartbeat for an operation+stage. */
  stopHeartbeat(operation: string, stage: string): void {
    const handle = this.heartbeats.get(this.key(operation, stage));
    if (handle !== undefined) {
      clearInterval(handle);
      this.heartbeats.delete(this.key(operation, stage));
    }
  }

  /** Tear down all heartbeats and stage tracking (used on logger disposal). */
  close(): void {
    for (const handle of this.heartbeats.values()) {
      clearInterval(handle);
    }
    this.heartbeats.clear();
    this.stages.clear();
  }
}
