import type { DatabaseSync } from "node:sqlite";
import type { Task, TaskState } from "./types.ts";
import { canTransition } from "./state.ts";
import { withWriteTx, type WriteTx } from "./tx.ts";
import { coordinatorGuardTxn, type CoordinatorAuthority } from "./locks.ts";
import { now as nowMs } from "./clock.ts";
import { eventBus, type TaskCreatedEvent, type TaskTransitionedEvent, type SupportedEventType } from "./events.ts";

export type { CoordinatorAuthority } from "./locks.ts";

function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

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

/** Append-only event log row. */
export interface TaskEvent {
  seq: number;
  taskId: string;
  eventType: string;
  fromState: string | null;
  toState: string | null;
  detail: string | null;
  createdAt: number;
}

export interface TaskNotFound extends Error {
  taskId: string;
  name: "TaskNotFound";
}

interface TaskLeaseAuthority {
  owner: string;
  execGen: number;
}

export class TaskStore {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  addTask(input: { title: string; description?: string; priority?: number }): Task {
    return withWriteTx(this.db, (tx) =>
      this.addTaskTxn(tx, {
        title: input.title,
        description: input.description,
        priority: input.priority,
      }));
  }

  /** Create a task + `created` event inside the caller's transaction. */
  addTaskTxn(
    tx: WriteTx,
    input: { title: string; description?: string; priority?: number },
  ): Task {
    const now = tx.now();
    const id = newTaskId();
    const task: Task = {
      id,
      title: input.title,
      description: input.description ?? "",
      status: "DISCOVERED",
      priority: input.priority ?? 0,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      lastRunAt: null,
      executionMetadata: {},
      execGen: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at, attempts, last_run_at, execution_metadata, exec_gen, lease_owner, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, NULL, NULL)`,
      )
      .run(
        task.id,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.createdAt,
        task.updatedAt,
        JSON.stringify({}),
      );
    this.appendEventTx(tx, task.id, "created", null, task.status, null);

    // Publish SSE event
    const createdEvent = {
      eventType: "task.created",
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      aggregateType: "task",
      aggregateId: task.id,
      payload: {
        title: task.title,
        description: task.description,
        priority: task.priority,
        initialStatus: task.status,
      },
      schemaVersion: 1,
    };
    eventBus.publish(createdEvent as SupportedEventType);

    return task;
  }

  getTask(id: string): Task | undefined {
    return rowToTask(
      this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<
        string,
        unknown
      > | undefined,
    );
  }

  listTasks(state?: TaskState): Task[] {
    const sql =
      state === undefined
        ? "SELECT * FROM tasks ORDER BY priority DESC, created_at ASC"
        : "SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC";
    const stmt = this.db.prepare(sql);
    const rows = (state === undefined ? stmt.all() : stmt.all(state)) as unknown as Record<
      string,
      unknown
    >[];
    return rows.map((r) => rowToTask(r) as Task);
  }

  // ——— legacy leaseless-only writes —————————————————————————————————

  /** Legacy transition: leaseless rows only (leased tasks refuse legacy writes). */
  transition(id: string, to: TaskState, detail?: string): Task {
    return withWriteTx(this.db, (tx) => {
      const task = this.taskOrThrowLeaseless(id);
      if (task.status === to) {
        throw new Error(`invalid transition: ${task.status} → ${to} (same state)`);
      }
      if (!canTransition(task.status, to)) {
        throw new Error(`invalid transition: ${task.status} → ${to}`);
      }

      // Get fromState before transition
      const fromState = task.status;

      const result = applyTransition(this.db, tx, task, to, detail ?? null);

      // Publish SSE event for state transition
      const transitionEvent = {
        eventType: "task.transitioned",
        id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        aggregateType: "task",
        aggregateId: id,
        payload: {
          taskId: id,
          fromState,
          toState: to,
          detail,
        },
        schemaVersion: 1,
      };
      eventBus.publish(transitionEvent as SupportedEventType);

      return result;
    });
  }

  /** Legacy execution metadata write: leaseless rows only. */
  recordExecution(id: string, metadataPatch: Record<string, unknown>): Task {
    return withWriteTx(this.db, (tx) => {
      const task = this.taskOrThrowLeaseless(id);
      return applyMetadataPatch(this.db, tx, task, metadataPatch, { touchLastRun: true });
    });
  }

  /** Legacy metadata change without execution semantics: leaseless rows only. */
  setMetadata(id: string, metadataPatch: Record<string, unknown>): Task {
    return withWriteTx(this.db, (tx) => {
      const task = this.taskOrThrowLeaseless(id);
      return applyMetadataPatch(this.db, tx, task, metadataPatch, { touchLastRun: false });
    });
  }

  /** Legacy planning event: leaseless rows only. */
  recordPlanning(id: string, detail: string): void {
    withWriteTx(this.db, (tx) => {
      const task = this.taskOrThrowLeaseless(id);
      this.appendEventTx(tx, task.id, "planned", null, null, detail.slice(0, 2000));
    });
  }

  private taskOrThrowLeaseless(id: string): Task {
    const task = this.getTask(id);
    if (task === undefined) {
      throw new Error(`task not found: ${id}`);
    }
    if (task.leaseOwner !== null) {
      throw new Error(`task ${id} is leased by ${task.leaseOwner}; legacy write refused`);
    }
    return task;
  }

  // ——— A-class: task-lease-holder writes ————————————————————————————

  /**
   * Guarded VERIFYING read: the task must exist, be VERIFYING, be the
   * expected id, and be held by the authority with an unexpired lease. All
   * four conditions are checked in one transaction, so a lease loss between
   * the read and the verdict write cannot be missed. `now` is sampled from
   * the transaction clock immediately before the guard runs.
   */
  verifyTaskLeaseHeld(
    id: string,
    authority: TaskLeaseAuthority,
    expectedExecGen: number,
    status: TaskState,
  ): Task | undefined {
    return withWriteTx(this.db, (tx) => {
      const now = tx.now();
      const task = this.getTask(id);
      if (task === undefined) return undefined;
      if (task.id !== id) return undefined;
      if (task.status !== status) return undefined;
      if (task.execGen !== expectedExecGen) return undefined;
      if (task.leaseOwner !== authority.owner) return undefined;
      if ((task.leaseExpiresAt ?? 0) <= now) return undefined;
      return task;
    });
  }

  /**
   * Renew one task lease. False means the lease was lost (expired, cleared,
   * or bumped to another generation); callers must stop touching the task.
   */
  heartbeatTaskLease(id: string, authority: TaskLeaseAuthority, ttlMs: number): boolean {
    return withWriteTx(this.db, (tx) => {
      const now = tx.now();
      const renewed = this.db
        .prepare(
          `UPDATE tasks SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND lease_owner = ? AND exec_gen = ? AND lease_expires_at > ?`,
        )
        .run(now + ttlMs, now, id, authority.owner, authority.execGen, now);
      return Number(renewed.changes) === 1;
    });
  }

  /** Execution result under the holder's lease; the same statement renews the lease. */
  recordExecutionHeld(
    id: string,
    authority: TaskLeaseAuthority,
    ttlMs: number,
    metadataPatch: Record<string, unknown>,
  ): Task | undefined {
    return withWriteTx(this.db, (tx) => {
      const task = this.getTask(id);
      if (task === undefined) return undefined;
      if (!leaseHolds(task, authority)) return undefined;
      return applyMetadataPatch(this.db, tx, task, metadataPatch, { touchLastRun: true }, authority, ttlMs);
    });
  }

  /** Lease-holder transition; undefined = lease lost (no event, no write). */
  transitionHeld(
    id: string,
    to: TaskState,
    authority: TaskLeaseAuthority,
    detail?: string,
  ): Task | undefined {
    return withWriteTx(this.db, (tx) => {
      const task = this.getTask(id);
      if (task === undefined) return undefined;
      if (!leaseHolds(task, authority)) return undefined;
      if (task.status === to || !canTransition(task.status, to)) {
        throw new Error(`invalid transition for task ${id}: ${task.status} → ${to}`);
      }
      return applyTransition(this.db, tx, task, to, detail ?? null);
    });
  }

  /**
   * Atomic terminal write: merge verification metadata and complete the
   * final transition in one lease-guarded transaction, clearing the lease
   * (exec_gen bump) when the task leaves the active set.
   */
  recordVerdictHeld(
    id: string,
    authority: TaskLeaseAuthority,
    metadataPatch: Record<string, unknown>,
    to: TaskState,
    detail?: string,
  ): Task | undefined {
    return withWriteTx(this.db, (tx) => {
      const task = this.getTask(id);
      if (task === undefined) return undefined;
      if (!leaseHolds(task, authority)) return undefined;
      if (task.status === to || !canTransition(task.status, to)) {
        throw new Error(`invalid transition for task ${id}: ${task.status} → ${to}`);
      }
      const now = tx.now();
      const metadata = { ...task.executionMetadata, ...metadataPatch };
      const claimed = this.db
        .prepare(
          `UPDATE tasks SET execution_metadata = ?, lease_owner = NULL, lease_expires_at = NULL, exec_gen = exec_gen + 1, updated_at = ?
           WHERE id = ? AND lease_owner = ? AND exec_gen = ? AND lease_expires_at > ?`,
        )
        .run(JSON.stringify(metadata), now, id, authority.owner, authority.execGen, now);
      if (Number(claimed.changes) !== 1) return undefined;
      const after = this.getTask(id);
      if (after === undefined) return undefined;
      return applyTransition(this.db, tx, after, to, detail ?? null);
    });
  }

  // ——— B-class: coordinator-authorized writes ———————————————————————

  /** Coordinator transition (e.g. BACKLOG → READY); throws when the instance lock is lost. */
  transitionWithCoordinator(
    id: string,
    to: TaskState,
    authority: CoordinatorAuthority,
    detail?: string,
  ): Task {
    return withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      const task = this.getTask(id);
      if (task === undefined) {
        throw new Error(`task not found: ${id}`);
      }
      if (task.leaseOwner !== null) {
        throw new Error(`task ${id} is leased by ${task.leaseOwner}; coordinator write refused`);
      }
      if (task.status === to) {
        throw new Error(`invalid transition: ${task.status} → ${to} (same state)`);
      }
      if (!canTransition(task.status, to)) {
        throw new Error(`invalid transition: ${task.status} → ${to}`);
      }
      return applyTransition(this.db, tx, task, to, detail ?? null);
    });
  }

  /** Coordinator planning event (leaseless rows only). */
  recordPlanningWithCoordinator(id: string, detail: string, authority: CoordinatorAuthority): void {
    withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      const task = this.getTask(id);
      if (task === undefined) {
        throw new Error(`task not found: ${id}`);
      }
      if (task.leaseOwner !== null) {
        throw new Error(`task ${id} is leased by ${task.leaseOwner}; coordinator write refused`);
      }
      this.appendEventTx(tx, id, "planned", null, null, detail.slice(0, 2000));
    });
  }

  /** Coordinator metadata change without execution semantics (leaseless rows only). */
  setMetadataWithCoordinator(
    id: string,
    metadataPatch: Record<string, unknown>,
    authority: CoordinatorAuthority,
  ): Task {
    return withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      const task = this.getTask(id);
      if (task === undefined) {
        throw new Error(`task not found: ${id}`);
      }
      if (task.leaseOwner !== null) {
        throw new Error(`task ${id} is leased by ${task.leaseOwner}; coordinator write refused`);
      }
      return applyMetadataPatch(this.db, tx, task, metadataPatch, { touchLastRun: false });
    });
  }

  /**
   * Atomic discovery persistence: coordinator guard + task creation + the
   * full initial proposal metadata + `planned` event in one transaction, so a
   * crash can never leave a proposal-less DISCOVERED task behind.
   */
  createTaskWithCoordinator(
    input: {
      title: string;
      description: string;
      priority: number;
      metadata: Record<string, unknown>;
      planningDetail: string;
    },
    authority: CoordinatorAuthority,
  ): Task {
    return withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      const partial = this.addTaskTxn(tx, input);
      const metadata = { ...input.metadata };
      this.db
        .prepare("UPDATE tasks SET execution_metadata = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(metadata), tx.now(), partial.id);
      this.appendEventTx(tx, partial.id, "planned", null, null, input.planningDetail.slice(0, 2000));
      const task = this.getTask(partial.id);
      if (task === undefined) {
        throw new Error(`unreachable: created task ${partial.id} not readable`);
      }
      return task;
    });
  }

  /**
   * Schedule a retry for a FAILED leaseless task (coordinator authority):
   * persist failure category, reason and eligibility in one txn. The
   * returned status distinguishes scheduled requeues from exhaustion.
   */
  scheduleRetryWithCoordinator(
    id: string,
    authority: CoordinatorAuthority,
    retry: { category: string; reason: string; eligibleAt: number; maxAttempts: number },
  ): { status: "scheduled" | "exhausted" | "not-schedulable"; task: Task | undefined; cause?: string } {
    return withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      const task = this.getTask(id);
      if (task === undefined) {
        return { status: "not-schedulable" as const, task: undefined, cause: "task not found" };
      }
      if (task.leaseOwner !== null) {
        return { status: "not-schedulable" as const, task, cause: `task is leased by ${task.leaseOwner}` };
      }
      if (task.status !== "FAILED") {
        return { status: "not-schedulable" as const, task, cause: `task is ${task.status}, not FAILED` };
      }
      const failure = {
        ...(isRecord(task.executionMetadata["failure"]) ? task.executionMetadata["failure"] : {}),
        category: retry.category,
        reason: retry.reason,
        eligibleAt: retry.eligibleAt,
      };
      if (task.attempts >= retry.maxAttempts) {
        // no eligibleAt is persisted for an exhausted task — a number here would
        // make it look requeue-eligible on the next pass, bypassing the cap.
        const exhausted = applyMetadataPatch(this.db, tx, task, { failure: { ...failure, attemptsExhausted: true, eligibleAt: undefined } }, { touchLastRun: false });
        this.appendEventTx(
          tx,
          id,
          "retry_exhausted",
          "FAILED",
          null,
          `attempts ${task.attempts}/${retry.maxAttempts} — manual intervention required`,
        );
        return { status: "exhausted" as const, task: exhausted };
      }
      const scheduled = applyMetadataPatch(this.db, tx, task, { failure }, { touchLastRun: false });
      this.appendEventTx(
        tx,
        id,
        "retry_scheduled",
        "FAILED",
        null,
        `${retry.category}: ${retry.reason.slice(0, 200)} — retry eligible at ${new Date(retry.eligibleAt).toISOString()} (attempt ${task.attempts}/${retry.maxAttempts})`,
      );
      return { status: "scheduled" as const, task: scheduled };
    });
  }

  /**
   * Move a retry-eligible FAILED task back to BACKLOG (coordinator
   * authority). The planner then promotes it through its normal ready path.
   */
  requeueRetryWithCoordinator(
    id: string,
    authority: CoordinatorAuthority,
  ): { status: "requeued" | "not-eligible"; task: Task | undefined; cause?: string } {
    return withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      const task = this.getTask(id);
      if (task === undefined) {
        return { status: "not-eligible" as const, task: undefined, cause: "task not found" };
      }
      if (task.leaseOwner !== null) {
        return { status: "not-eligible" as const, task, cause: `task is leased by ${task.leaseOwner}` };
      }
      if (task.status !== "FAILED") {
        return { status: "not-eligible" as const, task, cause: `task is ${task.status}, not FAILED` };
      }
      if (!isRecord(task.executionMetadata["failure"])) {
        return { status: "not-eligible" as const, task, cause: "no failure record" };
      }
      if (!canTransition(task.status, "BACKLOG")) {
        return { status: "not-eligible" as const, task, cause: `invalid transition ${task.status} → BACKLOG` };
      }
      const moved = applyTransition(this.db, tx, task, "BACKLOG", `requeue for retry (attempt ${task.attempts})`);
      return { status: "requeued" as const, task: moved };
    });
  }

  // ——— C-class: recovery takeover under coordinator authority ————————

  /**
   * Recovery takeover: re-stamp an expired or absent lease on an interrupted
   * task and optionally move its state — all in one coordinator-guarded
   * transaction. "skipped" answers cover: still-leased fresh rows, rows in
   * unexpected states, and rows that changed between read and write. Idempotent:
   * repeated recovery of an already fresh row stays "skipped".
   */
  recoverTaskWithCoordinator(
    id: string,
    authority: CoordinatorAuthority,
    change: { fromStatuses: readonly TaskState[] },
    next: {
      toStatus?: TaskState;
      detail: string;
      taskLeaseTtlMs: number;
      metadataPatch?: Record<string, unknown>;
    },
  ): { status: "recovered" | "skipped"; task: Task | undefined; cause?: string } {
    return withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      const task = this.getTask(id);
      if (task === undefined) {
        return { status: "skipped" as const, task: undefined, cause: "task not found" };
      }
      if (task.leaseOwner !== null && (task.leaseExpiresAt ?? 0) > tx.now()) {
        const freshExpiry = task.leaseExpiresAt ?? 0;
        return {
          status: "skipped" as const,
          task,
          cause: `fresh lease held by ${task.leaseOwner} until ${new Date(freshExpiry).toISOString()}`,
        };
      }
      if (!change.fromStatuses.includes(task.status)) {
        return {
          status: "skipped" as const,
          task,
          cause: `task is ${task.status}, not in {${change.fromStatuses.join(", ")}}`,
        };
      }

      const stampNow = tx.now();
      const stamped = this.db
        .prepare(
          `UPDATE tasks
           SET lease_owner = ?, exec_gen = exec_gen + 1, lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND lease_owner = ? AND exec_gen = ? AND lease_expires_at <= ?`,
        )
        .run(
          authority.owner,
          stampNow + next.taskLeaseTtlMs,
          stampNow,
          id,
          task.leaseOwner,
          task.execGen,
          stampNow,
        );
      if (Number(stamped.changes) !== 1) {
        return { status: "skipped" as const, task: undefined, cause: "lease changed between read and stamp" };
      }
      this.appendEventTx(
        tx,
        id,
        "lease_taken_over",
        task.status,
        task.status,
        `recovery re-stamp by ${authority.owner} (exec_gen ${task.execGen + 1})`,
      );

      let current = this.getTask(id);
      if (current === undefined) {
        return { status: "skipped" as const, task: undefined, cause: "task disappeared during recovery" };
      }
      if (next.metadataPatch !== undefined) {
        current = applyMetadataPatch(this.db, tx, current, next.metadataPatch, { touchLastRun: false });
      }
      if (next.toStatus !== undefined && next.toStatus !== current.status) {
        if (!canTransition(current.status, next.toStatus)) {
          return {
            status: "skipped" as const,
            task: current,
            cause: `invalid transition ${current.status} → ${next.toStatus}`,
          };
        }
        const moved = applyTransition(this.db, tx, current, next.toStatus, next.detail);
        return { status: "recovered" as const, task: moved };
      }
      this.appendEventTx(tx, id, "recovered", current.status, current.status, next.detail);
      const refreshed = this.getTask(id);
      return { status: "recovered" as const, task: refreshed };
    });
  }

  // ——— events / internals ——————————————————————————————————————————

  eventsFor(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY seq ASC")
      .all(taskId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      taskId: String(r.task_id),
      eventType: String(r.event_type),
      fromState: r.from_state === null ? null : String(r.from_state),
      toState: r.to_state === null ? null : String(r.to_state),
      detail: r.detail === null ? null : String(r.detail),
      createdAt: Number(r.created_at),
    }));
  }

  private appendEventTx(
    tx: WriteTx,
    taskId: string,
    eventType: string,
    fromState: TaskState | null,
    toState: TaskState | null,
    detail: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_events (task_id, event_type, from_state, to_state, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        eventType,
        fromState === null ? null : String(fromState),
        toState === null ? null : String(toState),
        detail,
        tx.now(),
      );
  }
}

// ——— shared guarded-write helpers ——————————————————————————————————

function leaseHolds(task: Task, authority: TaskLeaseAuthority): boolean {
  return (
    task.leaseOwner === authority.owner &&
    task.execGen === authority.execGen &&
    (task.leaseExpiresAt ?? 0) > nowMs()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export { isRecord };

/** Persist a validated transition inside the caller's transaction (event included). */
function applyTransition(
  db: DatabaseSync,
  tx: WriteTx,
  task: Task,
  to: TaskState,
  detail: string | null,
): Task {
  const attempts = task.attempts + (to === "IN_PROGRESS" ? 1 : 0);
  const now = tx.now();
  const next: Task = { ...task, status: to, attempts, updatedAt: now, executionMetadata: { ...task.executionMetadata, [`transitioned_to_${to}_at`]: true } };
  db.prepare("UPDATE tasks SET status = ?, updated_at = ?, attempts = ? WHERE id = ?")
    .run(to, now, attempts, task.id);
  db.prepare(
    `INSERT INTO task_events (task_id, event_type, from_state, to_state, detail, created_at)
     VALUES (?, 'transition', ?, ?, ?, ?)`,
  )
    .run(task.id, task.status, to, detail, now);
  return next;
}

/**
 * Merge execution metadata inside the caller's transaction. With a lease
 * authority + ttl the same statement also renews the lease (the runner's
 * per-prompt execution heartbeat).
 */
function applyMetadataPatch(
  db: DatabaseSync,
  tx: WriteTx,
  task: Pick<Task, "id" | "executionMetadata" | "leaseOwner" | "execGen" | "leaseExpiresAt">,
  metadataPatch: Record<string, unknown>,
  opts: { touchLastRun: boolean },
  authority?: TaskLeaseAuthority,
  ttlMs = 0,
): Task {
  const now = tx.now();
  const metadata = { ...task.executionMetadata, ...metadataPatch };
  const merged: Record<string, unknown> = {
    ...metadata,
    ...(opts.touchLastRun ? { lastRunAt: now } : {}),
  };
  let rowParams: (string | number | null)[];
  let rowSql: string;
  if (authority !== undefined) {
    rowSql =
      "UPDATE tasks SET execution_metadata = ?, last_run_at = ?, updated_at = ?, lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND exec_gen = ? AND lease_expires_at > ?";
    rowParams = [JSON.stringify(merged), now, now, now + ttlMs, task.id, authority.owner, authority.execGen, now];
  } else {
    rowSql =
      "UPDATE tasks SET execution_metadata = ?" +
      (opts.touchLastRun ? ", last_run_at = ?" : "") +
      ", updated_at = ? WHERE id = ?";
    rowParams = [JSON.stringify(merged), ...(opts.touchLastRun ? [now] : []), now, task.id];
  }
  const updated = db.prepare(rowSql).run(...rowParams);
  if (Number(updated.changes) !== 1) {
    throw new Error(`task ${task.id}: condition changed mid-write (affected ${updated.changes})`);
  }
  return { ...task, executionMetadata: merged, updatedAt: now } as unknown as Task;
}
