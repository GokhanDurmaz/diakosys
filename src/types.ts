export const TASK_STATES = [
  "DISCOVERED",
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "REVIEW",
  "VERIFYING",
  "BLOCKED",
  "FAILED",
  "DONE",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskState;
  priority: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastRunAt: number | null;
  executionMetadata: Record<string, unknown>;
  execGen: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
}

/** Outside an active lease the fields are cleared rather than null-or-zero. */
export interface LeaseFields {
  execGen: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
}

export const TERMINAL_STATES: readonly TaskState[] = ["DONE"] as const;
export const ACTIVE_STATES: readonly TaskState[] = ["IN_PROGRESS", "REVIEW", "VERIFYING"] as const;
