/**
 * The discovery pipeline's 13 stage transitions — an observability-only
 * abstraction over the engine's `onLifecycle` observer.
 *
 * Two shapes are covered:
 *   * start → outcome — `evidence`, `opencode` and `discovery` each start and
 *     end with either `completed` (durationMs, monotonic clock) or `failed`
 *     (no duration — the stage never completed).
 *   * one-shot — `prompt.prepared`, `opencode.submitted`, `response.parsed`
 *     and `proposal.accepted`/`proposal.rejected` fire when the transition
 *     happens and carry context only.
 *
 * Elapsed time is therefore only ever reported for a stage that actually
 * started, and never invented. The emitter is a no-op when `onLifecycle` is
 * absent, so attaching the logger can never change discovery behaviour,
 * results or exit codes.
 */

import type { LifecycleEvent } from "./lifecycle.ts";

/** Injectable clock (tests). Same shape as lifecycle.ts's internal `NowFn`. */
type NowFn = () => number;

/** The 13 pipeline stages, as `stage` → `event` pairs. */
export const STAGE_NAMES: ReadonlyArray<[string, string]> = [
  ["discovery", "started"],
  ["discovery", "completed"],
  ["discovery", "failed"],
  ["evidence", "started"],
  ["evidence", "completed"],
  ["evidence", "extraction_failed"],
  ["prompt", "prepared"],
  ["opencode", "submitted"],
  ["opencode", "completed"],
  ["opencode", "failed"],
  ["response", "parsed"],
  ["proposal", "accepted"],
  ["proposal", "rejected"],
];

export interface StageLoggerOptions {
  /** Optional observer: one `LifecycleEvent` per stage outcome. */
  onLifecycle?: (ev: LifecycleEvent) => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: NowFn;
}

export class StageLogger {
  private readonly onLifecycle: ((ev: LifecycleEvent) => void) | undefined;
  private readonly now: () => number;
  // one start per stage key; each area re-records its own start (start() is
  // idempotent per key, and complete()/failed() clear it), so every area's
  // outcome is timed against its own start, never a previous area's
  private readonly startedAt = new Map<string, number>();

  constructor(options: StageLoggerOptions = {}) {
    this.onLifecycle = options.onLifecycle ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  /** Record a stage start; idempotent for the same stage+area pair. */
  start(stage: string, extra: Record<string, unknown> = {}): void {
    const key = `${stage}:${extra.areaId ?? "run"}`;
    if (this.startedAt.has(key)) return;
    this.startedAt.set(key, this.now());
    this.outcome(stage, "started", extra);
  }

  /** Elapsed ms since the stage started, or `undefined` if it never started. Does not clear the tracking entry. */
  elapsed(stage: string, extra?: Record<string, unknown>): number | undefined {
    const key = `${stage}:${extra?.areaId ?? "run"}`;
    const startedAt = this.startedAt.get(key);
    // Don't clear the entry - callers may call elapsed() multiple times
    return startedAt === undefined ? undefined : this.now() - startedAt;
  }

  /** Complete a started stage: emits `completed` with durationMs. */
  complete(stage: string, extra: Record<string, unknown> = {}): void {
    const key = `${stage}:${extra.areaId ?? "run"}`;
    const startedAt = this.startedAt.get(key);
    if (startedAt === undefined) return;
    this.startedAt.delete(key);
    this.outcome(stage, "completed", { ...extra, durationMs: this.now() - startedAt });
  }

  /** Report a stage that never completed (extraction failure, prompt error). Only emits if the stage was started. */
  failed(stage: string, extra: Record<string, unknown> = {}): void {
    const key = `${stage}:${extra.areaId ?? "run"}`;
    const startedAt = this.startedAt.get(key);
    // Only emit failed if the stage was started (match complete() behavior)
    if (startedAt !== undefined) {
      // Use durationMs from caller if provided (from elapsed()), otherwise calculate
      const durationMs = extra.durationMs ?? this.now() - startedAt;
      this.outcome(stage, "failed", { ...extra, durationMs });
      this.startedAt.delete(key);
    }
  }

  /** Fire a one-shot stage transition (no duration); every call emits. */
  oneShot(stage: string, event: string, extra: Record<string, unknown> = {}): void {
    this.emit(stage, event, extra);
  }

  private outcome(stage: string, event: string, extra: Record<string, unknown> = {}): void {
    // No cross-area suppression: each area completes/fails its own stage, so
    // two areas produce two outcomes for the same stage key.
    this.emit(stage, event, extra);
  }

  /** Hand the event to the observer. An observer that throws must never
   *  interrupt discovery — the logger is strictly observational. */
  private emit(stage: string, event: string, extra: Record<string, unknown>): void {
    try {
      this.onLifecycle?.({
        level: "INFO",
        operation: "discover",
        stage,
        event,
        ...extra,
      });
    } catch (_err) {
      // swallow: a broken observer cannot change discovery behaviour
    }
  }
}
