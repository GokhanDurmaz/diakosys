import type { DatabaseSync } from "node:sqlite";
import type { Task, TaskState } from "./types.ts";
import { withWriteTx, type WriteTx } from "./tx.ts";
import { coordinatorGuardTxn, type CoordinatorAuthority, CoordinatorDisownedError } from "./locks.ts";

const QUEUE_STATE: TaskState = "READY";

function rowToTask(row: Record<string, unknown> | undefined): Task | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ""),
    status: String(row.status) as TaskState,
    priority: Number(row.priority),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    attempts: Number(row.attempts),
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    executionMetadata: JSON.parse(String(row.execution_metadata ?? "{}")) as Record<string, unknown>,
    execGen: Number(row.exec_gen ?? 0),
    leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null || row.lease_expires_at === undefined
        ? null
        : Number(row.lease_expires_at),
  };
}

export class ClaimInvariantsViolation extends Error {}

export type ClaimOutcome =
  | {
      status: "claimed";
      task: Task;
      /** Lease authority for the runner's guarded writes: owner, bumped exec_gen and TTL. */
      lease: { owner: string; execGen: number; ttlMs: number };
    }
  | { status: "queue-empty" }
  | { status: "coordinator-disowned" };

export interface ClaimRequest {
  coordinator: CoordinatorAuthority;
  /** TTL stamped onto the task lease at claim time (ms). */
  taskLeaseTtlMs: number;
}

export interface ClaimOrderMetric {
  status: TaskState;
  priority: number;
  createdAt: number;
  rowid: number;
}

/**
 * Durable task queue: the queue state itself is persisted in `tasks.status = READY`,
 * so the queue survives restarts. peek() leaves the task READY (observable).
 */
export class TaskQueue {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  peek(next = 1): Task[] {
    const stmt = this.db.prepare(
      `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT ?`,
    );
    const rows = stmt.all(QUEUE_STATE, next) as unknown as Record<string, unknown>[];
    return rows.map((r) => rowToTask(r) as Task);
  }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = ?").get(QUEUE_STATE) as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  }
}

/**
 * Atomic claim of the top READY task (highest priority, oldest first) into
 * IN_PROGRESS under a fresh task lease, ordered by the Stage 8.6 exchange:
 *
 *   BEGIN IMMEDIATE
 *   → coordinator guard with piggy-back lease renewal
 *   → in-transaction candidate SELECT (READY, lease expired-or-absent)
 *   → guarded claim UPDATE (status, attempts+1, exec_gen+1, lease stamp)
 *   → exactly one `declared` event
 *   → COMMIT "claimed"
 *
 * Outcomes are exactly `claimed`, `queue-empty` and `coordinator-disowned`.
 * An in-transaction candidate followed by a zero-row claim UPDATE is an
 * invariant violation (BEGIN IMMEDIATE serializes writers, so it should be
 * impossible): the transaction rolls back (including the guard renewal) and
 * ClaimInvariantsViolation is thrown. peek() is intentionally never used as
 * claim input; candidate selection happens inside the transaction.
 */
export function claimTask(db: DatabaseSync, request: ClaimRequest): ClaimOutcome {
  try {
    return withWriteTx(db, (tx) => claimInsideTxn(db, tx, request));
  } catch (err) {
    if (err instanceof CoordinatorDisownedError) {
      return { status: "coordinator-disowned" };
    }
    throw err;
  }
}

function claimInsideTxn(db: DatabaseSync, tx: WriteTx, request: ClaimRequest): ClaimOutcome {
  const authority = request.coordinator;
  coordinatorGuardTxn(db, tx, authority.owner, authority.generation, authority.lockTtlMs);

  const candidateNow = tx.now();
  const candidate = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = ? AND (lease_owner IS NULL OR lease_expires_at <= ?)
       ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT 1`,
    )
    .get(QUEUE_STATE, candidateNow) as Record<string, unknown> | undefined;
  if (candidate === undefined) {
    return { status: "queue-empty" };
  }
  const taskId = String(candidate.id);
  const now = tx.now();
  const claimed = db
    .prepare(
      `UPDATE tasks
       SET status = 'IN_PROGRESS', attempts = attempts + 1, exec_gen = exec_gen + 1,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?, last_run_at = ?
       WHERE id = ? AND status = ? AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
    )
    .run(
      authority.owner,
      now + request.taskLeaseTtlMs,
      now,
      now,
      taskId,
      QUEUE_STATE,
      now,
    );
  if (Number(claimed.changes) !== 1) {
    throw new ClaimInvariantsViolation(
      `claim UPDATE matched 0 rows for candidate ${taskId} inside an open transaction — queue invariant violated`,
    );
  }
  db.prepare(
    `INSERT INTO task_events (task_id, event_type, from_state, to_state, detail, created_at)
     VALUES (?, 'declared', ?, 'IN_PROGRESS', 'queue claim', ?)`,
  ).run(taskId, QUEUE_STATE, now);
  const claimedRow = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
  const task = rowToTask(claimedRow) as Task;
  return {
    status: "claimed",
    task,
    lease: { owner: authority.owner, execGen: task.execGen, ttlMs: request.taskLeaseTtlMs },
  };
}
