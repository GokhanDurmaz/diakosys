import type { TaskState } from "./types.ts";

/**
 * Valid task state transitions.
 *
 * Linear flow: DISCOVERED → BACKLOG → READY → IN_PROGRESS → REVIEW → VERIFYING → DONE
 * SIDE STATES: BLOCKED (unblocks to READY or returns to BACKLOG),
 *              FAILED (retries back to BACKLOG).
 * RECOVERY:    IN_PROGRESS → READY (crash recovery; a claimed task whose
 *              lease expired with no recorded output goes back to READY)
 *              and stale REVIEW → VERIFYING restarts verification.
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DISCOVERED: ["BACKLOG"],
  BACKLOG: ["READY", "BLOCKED"],
  READY: ["IN_PROGRESS", "BACKLOG", "BLOCKED"],
  IN_PROGRESS: ["REVIEW", "BLOCKED", "FAILED", "READY"],
  REVIEW: ["VERIFYING", "IN_PROGRESS"],
  VERIFYING: ["DONE", "FAILED"],
  BLOCKED: ["READY", "BACKLOG"],
  FAILED: ["BACKLOG"],
  DONE: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  const allowed = TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}
