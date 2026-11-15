import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import type { DatabaseSync } from "node:sqlite";
import { TaskQueue, claimTask, ClaimInvariantsViolation } from "../src/queue.ts";
import { acquireLockTxn, readLockRow, releaseLockTxn, type CoordinatorAuthority } from "../src/locks.ts";
import { withWriteTx } from "../src/tx.ts";
import { setNowSource, now } from "../src/clock.ts";

const OWNER = "coordinator_test";
const LOCK_TTL = 60_000;
const TASK_LEASE_TTL = 120_000;

function tempDb(): { db: DatabaseSync; store: TaskStore; queue: TaskQueue; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-queue-"));
  const db = openDatabase(path.join(dir, "tasks.db"));
  return {
    db,
    store: new TaskStore(db),
    queue: new TaskQueue(db),
    close: () => closeDatabase(db),
  };
}

/** Fresh instance lock held by OWNER for the test run. */
function heldAuthority(db: DatabaseSync): CoordinatorAuthority {
  return withWriteTx(db, (tx) => {
    const outcome = acquireLockTxn(db, tx, OWNER, LOCK_TTL);
    if (outcome.status !== "granted") throw new Error("test lock acquire failed");
    const row = readLockRow(db);
    return { owner: OWNER, generation: row?.generation ?? 0, lockTtlMs: LOCK_TTL };
  });
}

function attribute(db: DatabaseSync): CoordinatorAuthority {
  const row = readLockRow(db);
  return { owner: row?.owner ?? OWNER, generation: row?.generation ?? 0, lockTtlMs: LOCK_TTL };
}

function enqueueTopTask(store: TaskStore, title: string, priority = 7): string {
  const t = store.addTask({ title, priority });
  store.transition(t.id, "BACKLOG");
  store.transition(t.id, "READY");
  return t.id;
}

test("empty queue peeks nothing and reports zero size", () => {
  const s = tempDb();
  try {
    assert.deepEqual(s.queue.peek(5), []);
    assert.equal(s.queue.size(), 0);
    const outcome = claimTask(s.db, { coordinator: heldAuthority(s.db), taskLeaseTtlMs: TASK_LEASE_TTL });
    assert.equal(outcome.status, "queue-empty");
  } finally {
    s.close();
  }
});

test("only READY tasks are queued; priority then age ordering", () => {
  const s = tempDb();
  try {
    const t1 = s.store.addTask({ title: "low prio", priority: 1 });
    const t2 = s.store.addTask({ title: "high prio", priority: 9 });
    const t3 = s.store.addTask({ title: "later high prio", priority: 9 });
    const t4 = s.store.addTask({ title: "not ready" });
    for (const t of [t1, t2, t3]) s.store.transition(t.id, "BACKLOG");
    for (const t of [t1, t2, t3]) s.store.transition(t.id, "READY");
    // t4 stays DISCOVERED and must never appear in the queue

    const peeked = s.queue.peek(3);
    assert.deepEqual(
      peeked.map((t) => t.title),
      ["high prio", "later high prio", "low prio"],
      "priority first, creation time tie-break",
    );
    assert.equal(s.queue.size(), 3);
    assert.ok(s.queue.peek(3).every((t) => t.id !== t4.id));
    assert.equal(s.store.getTask(t4.id)?.status, "DISCOVERED");
  } finally {
    s.close();
  }
});

test("claim stamps the top READY task as IN_PROGRESS under a fresh lease", () => {
  const s = tempDb();
  try {
    const taskId = enqueueTopTask(s.store, "claim me");
    assert.equal(s.queue.size(), 1);

    const outcome = claimTask(s.db, { coordinator: heldAuthority(s.db), taskLeaseTtlMs: TASK_LEASE_TTL });
    assert.equal(outcome.status, "claimed");
    if (outcome.status !== "claimed") return;
    assert.equal(outcome.task.id, taskId);
    assert.equal(outcome.task.status, "IN_PROGRESS");
    assert.equal(outcome.task.attempts, 1);
    assert.equal(outcome.task.leaseOwner, OWNER);
    assert.equal(outcome.task.execGen, 1);
    assert.ok((outcome.task.leaseExpiresAt ?? 0) > now());
    assert.equal(outcome.lease.execGen, 1);
    assert.equal(s.queue.size(), 0, "claim removes from queue");
    const stored = s.store.getTask(taskId);
    assert.equal(stored?.status, "IN_PROGRESS");
    const claimEvent = s.store
      .eventsFor(taskId)
      .find((e) => e.eventType === "declared" && e.toState === "IN_PROGRESS");
    assert.ok(claimEvent, "claim persisted to event history");
  } finally {
    s.close();
  }
});

test("claim is order-stable: highest priority and oldest first", () => {
  const s = tempDb();
  try {
    enqueueTopTask(s.store, "least", 1);
    enqueueTopTask(s.store, "most", 9);
    const authority = heldAuthority(s.db);
    const outcome = claimTask(s.db, { coordinator: authority, taskLeaseTtlMs: TASK_LEASE_TTL });
    if (outcome.status !== "claimed") throw new Error("expected claim");
    assert.equal(outcome.task.title, "most");
    const second = claimTask(s.db, { coordinator: authority, taskLeaseTtlMs: TASK_LEASE_TTL });
    if (second.status !== "claimed") throw new Error("expected second claim");
    assert.equal(second.task.title, "least");
  } finally {
    s.close();
  }
});

test("claim refuses a task still leased in READY (dirty row) and picks nothing", () => {
  const s = tempDb();
  try {
    enqueueTopTask(s.store, "phantom lease");
    s.db
      .prepare("UPDATE tasks SET lease_owner = 'ghost', lease_expires_at = ? WHERE status = 'READY'")
      .run(now() + TASK_LEASE_TTL);
    const authority = heldAuthority(s.db);
    const outcome = claimTask(s.db, { coordinator: authority, taskLeaseTtlMs: TASK_LEASE_TTL });
    assert.equal(outcome.status, "queue-empty", "leased READY row stays invisible to claims");
    assert.equal(s.store.getTask(s.store.listTasks("READY")[0]?.id ?? "")?.leaseOwner, "ghost");

    // Once the lease expires (clock moved forward) the same row becomes claimable.
    let fake = now() + TASK_LEASE_TTL + 1;
    setNowSource(() => fake);
    const lateAuthority = heldAuthority(s.db);
    const outcome2 = claimTask(s.db, { coordinator: lateAuthority, taskLeaseTtlMs: TASK_LEASE_TTL });
    assert.equal(outcome2.status, "claimed");
  } finally {
    s.close();
  }
});

test("claim under a stale lock generation returns coordinator-disowned", () => {
  const s = tempDb();
  try {
    enqueueTopTask(s.store, "watch me");
    const authority = heldAuthority(s.db);
    // steal/release the lock so the recorded generation is stale
    withWriteTx(s.db, (tx) => {
      assert.equal(releaseLockTxn(s.db, tx, OWNER), true);
    });
    const outcome = claimTask(s.db, {
      coordinator: { owner: "stale-ghost", generation: authority.generation, lockTtlMs: LOCK_TTL },
      taskLeaseTtlMs: TASK_LEASE_TTL,
    });
    assert.equal(outcome.status, "coordinator-disowned");
    assert.equal(s.store.getTask(s.store.listTasks("READY")[0]?.id ?? "")?.status, "READY", "claim did not touch the task");
  } finally {
    s.close();
  }
});

test("queue is durable across close/reopen and claims survive restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-queue-dur-"));
  const dbPath = path.join(dir, "tasks.db");
  const db1 = openDatabase(dbPath);
  const s1 = { store: new TaskStore(db1), queue: new TaskQueue(db1) };
  enqueueTopTask(s1.store, "durable", 2);
  const claimed = claimTask(db1, { coordinator: heldAuthority(db1), taskLeaseTtlMs: TASK_LEASE_TTL });
  assert.equal(claimed.status, "claimed");
  closeDatabase(db1);

  const db2 = openDatabase(dbPath);
  const store2 = new TaskStore(db2);
  const queue2 = new TaskQueue(db2);
  assert.equal(queue2.size(), 0, "claimed task no longer counts as queued");
  const taskId = store2.listTasks("IN_PROGRESS")[0]?.id ?? "";
  const stored = store2.getTask(taskId);
  assert.equal(stored?.status, "IN_PROGRESS");
  assert.equal(stored?.attempts, 1);
  assert.equal(stored?.leaseOwner, OWNER);
  const claimEvent = store2
    .eventsFor(taskId)
    .find((e) => e.eventType === "declared" && e.toState === "IN_PROGRESS");
  assert.ok(claimEvent, "claim event survived close/reopen");
  closeDatabase(db2);
});

test("claimed task refuses legacy leaseless-only writes", () => {
  const s = tempDb();
  try {
    const taskId = enqueueTopTask(s.store, "held tight");
    claimTask(s.db, { coordinator: heldAuthority(s.db), taskLeaseTtlMs: TASK_LEASE_TTL });
    assert.throws(
      () => s.store.transition(taskId, "REVIEW"),
      /is leased/,
      "legacy writes cannot bypass a live claim lease",
    );
    assert.throws(() => s.store.recordExecution(taskId, { error: "leak" }), /is leased/);
    assert.throws(() => s.store.setMetadata(taskId, { x: 1 }), /is leased/);
  } finally {
    s.close();
  }
});

test("a zero-row claim UPDATE inside the open transaction rolls back everything and throws ClaimInvariantsViolation", () => {
  const s = tempDb();
  try {
    const taskId = enqueueTopTask(s.store, "invariant victim");
    const authority = heldAuthority(s.db);
    const lockBefore = readLockRow(s.db);

    // Force the impossible path deterministically: the in-transaction candidate
    // SELECT finds a READY row, but the guarded claim UPDATE reports zero
    // changes. A prepared-statement shim on this connection intercepts only
    // the claim UPDATE; every other statement behaves normally.
    type PrepareFn = DatabaseSync["prepare"];
    const originalPrepare: PrepareFn = s.db.prepare.bind(s.db);
    const shim = ((sql: string) =>
      sql.includes("SET status = 'IN_PROGRESS'")
        ? ({ run: () => ({ changes: 0 }) } as unknown as ReturnType<PrepareFn>)
        : originalPrepare(sql)) as unknown as PrepareFn;
    (s.db as unknown as { prepare: PrepareFn }).prepare = shim;
    let caught: unknown;
    try {
      claimTask(s.db, { coordinator: authority, taskLeaseTtlMs: TASK_LEASE_TTL });
    } catch (err) {
      caught = err;
    } finally {
      (s.db as unknown as { prepare: PrepareFn }).prepare = originalPrepare;
    }
    assert.ok(caught instanceof ClaimInvariantsViolation, `expected ClaimInvariantsViolation, got ${String(caught)}`);

    // the whole transaction rolled back: task row, claim event and the
    // guard's piggy-back lock renewal are all untouched
    const task = s.store.getTask(taskId);
    assert.equal(task?.status, "READY");
    assert.equal(task?.attempts, 0);
    assert.equal(task?.leaseOwner, null);
    assert.equal(task?.execGen, 0);
    assert.equal(s.store.eventsFor(taskId).some((e) => e.eventType === "declared"), false);
    const lockAfter = readLockRow(s.db);
    assert.equal(lockAfter?.expiresAt, lockBefore?.expiresAt);
    assert.equal(lockAfter?.generation, lockBefore?.generation);

    // the queue is healthy after the failed claim: the task claims normally
    const retry = claimTask(s.db, { coordinator: authority, taskLeaseTtlMs: TASK_LEASE_TTL });
    assert.equal(retry.status, "claimed");
  } finally {
    s.close();
  }
});

test("closeDatabase is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-queue-close-"));
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  try {
    closeDatabase(db);
    closeDatabase(db);
    closeDatabase(db);
  } finally {
    assert.equal(db.isOpen, false, "database was closed exactly once");
  }
});
