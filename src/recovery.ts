import type { Task, TaskState } from "./types.ts";
import type { TaskStore } from "./store.ts";
import type { CoordinatorAuthority } from "./locks.ts";
import { isRecord } from "./store.ts";
import type { RetryPolicy } from "./retry.ts";
import { now } from "./clock.ts";
import { planRetry } from "./retry.ts";

/**
 * Crash recovery for interrupted task leases (idempotent, lease-expiry
 * based — never timestamps alone). Rules:
 * - IN_PROGRESS with recorded output → VERIFYING
 * - IN_PROGRESS with no output → READY
 * - REVIEW → VERIFYING
 * - VERIFYING keeps its state and gets a fresh lease
 * A fresh foreign lease is never stolen; takeover bumps exec_gen.
 */
export interface RecoveryReport {
  recovered: number;
  skipped: { taskId: string; cause?: string }[];
}

const FROM_VERIFICATION: readonly TaskState[] = ["IN_PROGRESS", "REVIEW", "VERIFYING"];

export function recoverInterruptedTasks(
  store: TaskStore,
  authority: CoordinatorAuthority,
  taskLeaseTtlMs: number,
): RecoveryReport {
  const report: RecoveryReport = { recovered: 0, skipped: [] };
  for (const task of store.listTasks()) {
    if (task.status !== "IN_PROGRESS" && task.status !== "REVIEW" && task.status !== "VERIFYING") continue;
    const result = recoverOne(store, task, authority, taskLeaseTtlMs);
    if (result.status === "recovered") report.recovered += 1;
    else report.skipped.push({ taskId: task.id, cause: result.cause });
  }
  return report;
}

function recoverOne(
  store: TaskStore,
  task: Task,
  authority: CoordinatorAuthority,
  taskLeaseTtlMs: number,
): { status: "recovered" | "skipped"; cause?: string } {
  const hasOutput =
    typeof task.executionMetadata["output"] === "string" &&
    String(task.executionMetadata["output"]).length > 0;
  const toStatus: TaskState | undefined =
    task.status === "IN_PROGRESS" ? (hasOutput ? "VERIFYING" : "READY")
      : task.status === "REVIEW" ? "VERIFYING"
        : undefined;
  const result = store.recoverTaskWithCoordinator(
    task.id,
    authority,
    { fromStatuses: FROM_VERIFICATION },
    {
      detail:
        toStatus === undefined
          ? "recovery: re-stamp lease for verification"
          : `recovery: ${task.status} → ${toStatus}`,
      taskLeaseTtlMs,
      ...(toStatus !== undefined ? { toStatus } : {}),
    },
  );
  return { status: result.status, cause: result.cause };
}

/**
 * Schedule retries for FAILED tasks that carry a failure classification but
 * no scheduled retry record yet (idempotent: a task with `failure.eligibleAt`
 * already recorded is untouched). Exhaustion is persisted by the store.
 */
export interface RetrySchedulingReport {
  scheduled: number;
  exhausted: number;
  skipped: { taskId: string; cause?: string }[];
}

export function scheduleFailedRetries(
  store: TaskStore,
  authority: CoordinatorAuthority,
  policy: RetryPolicy,
): RetrySchedulingReport {
  const report: RetrySchedulingReport = { scheduled: 0, exhausted: 0, skipped: [] };
  for (const task of store.listTasks("FAILED")) {
    const existing = isRecord(task.executionMetadata["failure"]) ? task.executionMetadata["failure"] : undefined;
    if (existing !== undefined && typeof existing["eligibleAt"] === "number") {
      report.skipped.push({ taskId: task.id, cause: "retry already scheduled" });
      continue;
    }
    const category = classifyFailure(task);
    if (category === undefined) {
      report.skipped.push({ taskId: task.id, cause: "no classifiable failure record" });
      continue;
    }
    const reason = failureReason(task, category);
    // backoff is computed from the failure time and the attempt count: the
    // persisted eligibleAt is the deterministic retry-due boundary
    const planned = planRetry(policy, category, reason, now(), task.attempts);
    const result = store.scheduleRetryWithCoordinator(task.id, authority, {
      category,
      reason: planned.reason,
      eligibleAt: planned.eligibleAt,
      maxAttempts: policy.maxAttempts,
    });
    if (result.status === "scheduled") report.scheduled += 1;
    else if (result.status === "exhausted") report.exhausted += 1;
    else report.skipped.push({ taskId: task.id, cause: result.cause });
  }
  return report;
}

/** Retry-due pass: requeue FAILED tasks whose eligible time passed. */
export interface RetryDueReport {
  requeued: number;
  skipped: { taskId: string; cause?: string }[];
}

export function requeueRetryDueTasks(
  store: TaskStore,
  authority: CoordinatorAuthority,
): RetryDueReport {
  const report: RetryDueReport = { requeued: 0, skipped: [] };
  for (const task of store.listTasks("FAILED")) {
    const failure = isRecord(task.executionMetadata["failure"]) ? task.executionMetadata["failure"] : undefined;
    if (failure === undefined || typeof failure["eligibleAt"] !== "number") {
      report.skipped.push({ taskId: task.id, cause: "no scheduled retry" });
      continue;
    }
    if (Number(failure["eligibleAt"]) > now()) {
      continue;
    }
    const result = store.requeueRetryWithCoordinator(task.id, authority);
    if (result.status === "requeued") report.requeued += 1;
    else report.skipped.push({ taskId: task.id, cause: result.cause });
  }
  return report;
}

/** Classify a FAILED task's recorded failure for retry decisions. Undefined
 *  means manual-only (ambiguous/malformed/legacy — never auto-retried).
 *  Reads the structured `failureKind` tag when present; verification verdicts
 *  fall back to the leading tag the verifier itself writes into
 *  verificationNote ("ambig…", "verifier error", anything else). Free-form
 *  note content past that tag is never interpreted. */
export function classifyFailure(task: Task): "execution-error" | "verifier-error" | "verification-fail" | undefined {
  const kind = task.executionMetadata["failureKind"];
  if (kind === "execution-error") return "execution-error";
  if (task.executionMetadata["verification"] !== "fail") return undefined;
  const note = typeof task.executionMetadata["verificationNote"] === "string"
    ? String(task.executionMetadata["verificationNote"])
    : "";
  if (note.startsWith("ambigu")) return undefined; // manual-only: ambiguous verification
  if (note.startsWith("verifier error")) return "verifier-error";
  return "verification-fail";
}

function failureReason(task: Task, category: string): string {
  const note = typeof task.executionMetadata["verificationNote"] === "string"
    ? String(task.executionMetadata["verificationNote"])
    : undefined;
  const error = typeof task.executionMetadata["error"] === "string" ? String(task.executionMetadata["error"]) : undefined;
  const reason = note ?? error ?? "task failed";
  return `${category}: ${reason}`;
}
