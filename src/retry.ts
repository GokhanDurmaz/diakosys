/** Retry policy knobs; defaults come from config.ts. */
export interface RetryPolicy {
  /** Maximum attempts per task (initial execution counts). */
  maxAttempts: number;
  /** Base backoff after the first failure (ms). */
  baseMs: number;
  /** Upper backoff bound (ms). */
  maxMs: number;
}

/** Failure categories auto-retried when attempts remain. */
export const AUTO_RETRY_CATEGORIES = ["execution-error", "verifier-error", "verification-fail"] as const;
/** Categories never auto-retried; they need `task retry --confirm-unsafe`. */
export const MANUAL_ONLY_CATEGORIES = ["verification-ambiguous", "legacy"] as const;

/**
 * Exponential backoff for attempt N (1-based): the first failure waits for
 * the base delay, each subsequent failure doubles it, capped at maxMs.
 */
export function retryBackoffMs(policy: RetryPolicy, attemptsAfterFailure: number): number {
  const exponent = Math.max(0, attemptsAfterFailure - 1);
  const raw = policy.baseMs * Math.pow(2, exponent);
  return Math.min(raw, policy.maxMs);
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseMs: 60_000,
  maxMs: 1_800_000,
};

export interface ScheduledRetry {
  category: (typeof AUTO_RETRY_CATEGORIES)[number];
  reason: string;
  eligibleAt: number;
}

/** Build the retry record a coordinator persists with a failure. */
export function planRetry(
  policy: RetryPolicy,
  category: ScheduledRetry["category"],
  reason: string,
  failedAt: number,
  attemptsAfterFailure: number,
): ScheduledRetry {
  return {
    category,
    reason,
    eligibleAt: failedAt + retryBackoffMs(policy, attemptsAfterFailure),
  };
}
