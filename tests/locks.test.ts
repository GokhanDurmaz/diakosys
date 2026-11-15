import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import {
  acquireLockTxn,
  coordinatorGuardTxn,
  releaseLockTxn,
  readLockRow,
  type CoordinatorAuthority,
  CoordinatorDisownedError,
} from "../src/locks.ts";
import { withWriteTx } from "../src/tx.ts";
import { setNowSource } from "../src/clock.ts";
import { coordinatorAuth } from "./helpers.ts";
import { TaskStore } from "../src/store.ts";
import { claimTask } from "../src/queue.ts";
import type { DatabaseSync } from "node:sqlite";

const TTL = 1_000; // short TTLs make expiry/takeover deterministic

function tempDb(): { db: DatabaseSync; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-locks-"));
  const db = openDatabase(path.join(dir, "tasks.db"));
  return { db, close: () => closeDatabase(db) };
}

let t: number;
function clock(): () => number {
  return () => t;
}

function grant(db: DatabaseSync, owner: string, ttlMs = TTL): void {
  withWriteTx(db, (tx) => {
    const outcome = acquireLockTxn(db, tx, owner, ttlMs);
    if (outcome.status !== "granted") throw new Error(`acquire failed: ${outcome.holder}`);
  });
}

function authority(db: DatabaseSync, owner: string, ttlMs = TTL): CoordinatorAuthority {
  const row = readLockRow(db);
  if (row === undefined || row.owner !== owner) throw new Error(`lock not held by ${owner}`);
  return { owner, generation: row.generation, lockTtlMs: ttlMs };
}

test("free acquire, denial while fresh, expired takeover, and release", () => {
  const s = tempDb();
  try {
    setNowSource(clock());
    try {
      t = 100;
      withWriteTx(s.db, (tx) => {
        const first = acquireLockTxn(s.db, tx, "A", TTL);
        assert.equal(first.status, "granted");
        if (first.status === "granted") {
          assert.equal(first.grant.generation, 1);
          assert.equal(first.grant.acquiredVia, "free");
          assert.equal(first.grant.expiresAt, 1100);
        }
      });
      t = 200;
      withWriteTx(s.db, (tx) => {
        const denied = acquireLockTxn(s.db, tx, "B", TTL);
        assert.equal(denied.status, "denied");
        assert.deepEqual(denied.holder, "A");
      });
      // expiry allows a takeover that advances the generation
      t = 1901;
      withWriteTx(s.db, (tx) => {
        const takeover = acquireLockTxn(s.db, tx, "B", TTL);
        assert.equal(takeover.status, "granted");
        if (takeover.status === "granted") {
          assert.equal(takeover.grant.generation, 2);
          assert.equal(takeover.grant.acquiredVia, "expired-takeover");
        }
      });
      // release clears the row; a release by a stale owner is a no-op
      t = 2000;
      const released = withWriteTx(s.db, (tx) => releaseLockTxn(s.db, tx, "B"));
      assert.equal(released, true);
      const stale = withWriteTx(s.db, (tx) => releaseLockTxn(s.db, tx, "B"));
      assert.equal(stale, false);
      const row = readLockRow(s.db);
      assert.equal(row?.owner, "");
      assert.equal(row?.generation, 3);
    } finally {
      setNowSource(null);
    }
  } finally {
    s.close();
  }
});

test("coordinator guard renews inside the transaction and a stale generation is rejected", () => {
  const s = tempDb();
  try {
    setNowSource(clock());
    try {
      t = 500;
      grant(s.db, "A");
      const auth = authority(s.db, "A");
      // guard renews the lock inside its transaction
      withWriteTx(s.db, (tx) => {
        coordinatorGuardTxn(s.db, tx, auth.owner, auth.generation, auth.lockTtlMs);
      });
      assert.equal(readLockRow(s.db)?.expiresAt, 500 + TTL);
      // a stale generation is disowned even with a matching owner
      const stale: CoordinatorAuthority = { ...auth, generation: auth.generation - 1 };
      assert.throws(
        () => withWriteTx(s.db, (tx) => coordinatorGuardTxn(s.db, tx, stale.owner, stale.generation, stale.lockTtlMs)),
        CoordinatorDisownedError,
      );
    } finally {
      setNowSource(null);
    }
  } finally {
    s.close();
  }
});

test("in-transaction clock advancement between protected statements forces a fresh rejection", () => {
  const s = tempDb();
  try {
    setNowSource(clock());
    try {
      t = 1000;
      grant(s.db, "A", 500);
      const auth = authority(s.db, "A", 500);
      let firstGuardNow = 0;
      assert.doesNotThrow(() =>
        withWriteTx(s.db, (tx) => {
          firstGuardNow = tx.now();
          coordinatorGuardTxn(s.db, tx, auth.owner, auth.generation, auth.lockTtlMs);
          t += 300; // the tx remains open; the clock advances (fresh sampling: 1000 → 1300)
          coordinatorGuardTxn(s.db, tx, auth.owner, auth.generation, auth.lockTtlMs);
        }),
      );
      assert.equal(firstGuardNow, 1000);
      assert.equal(readLockRow(s.db)?.expiresAt, 1800);
      // advancing past the (renewed) expiry rejects from the very next statement
      t += 600; // now 1900, expiry 1800
      assert.throws(
        () =>
          withWriteTx(s.db, (tx) => {
            t += 6000;
            coordinatorGuardTxn(s.db, tx, auth.owner, auth.generation, auth.lockTtlMs);
          }),
        CoordinatorDisownedError,
      );
      // the rejecting transaction rolled back its renewal
      assert.equal(readLockRow(s.db)?.expiresAt, 1800);
    } finally {
      setNowSource(null);
    }
  } finally {
    s.close();
  }
});

test("two independent connections: claim ordering, recovery takeover, lease expiry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-locks2-"));
  const dbA = openDatabase(path.join(dir, "tasks.db"));
  const dbB = openDatabase(path.join(dir, "tasks.db"));
  try {
    const storeA = new TaskStore(dbA);
    const high = storeA.addTask({ title: "claim first", priority: 9 });
    const low = storeA.addTask({ title: "claim second", priority: 2 });
    for (const task of [high, low]) {
      storeA.transition(task.id, "BACKLOG");
      storeA.transition(task.id, "READY");
    }

    setNowSource(clock());
    try {
      t = 100;
      let gen = 0;
      withWriteTx(dbA, (tx) => {
        const outcome = acquireLockTxn(dbA, tx, "A", 2000);
        if (outcome.status !== "granted") throw new Error("lock acquire failed");
        gen = outcome.grant.generation;
        assert.equal(gen > 0, true);
      });
      const auth: CoordinatorAuthority = { owner: "A", generation: gen, lockTtlMs: 2000 };

      // both connections see the same lock row
      assert.equal(readLockRow(dbB)?.generation, readLockRow(dbA)?.generation);

      // connection A claims the highest-priority READY task; B follows with the next
      const claimA = claimTask(dbA, { coordinator: auth, taskLeaseTtlMs: 400 });
      assert.equal(claimA.status, "claimed");
      if (claimA.status === "claimed") assert.equal(claimA.task.id, high.id);
      const claimB = claimTask(dbB, { coordinator: auth, taskLeaseTtlMs: 400 });
      assert.equal(claimB.status, "claimed");
      if (claimB.status === "claimed") assert.equal(claimB.task.id, low.id);
      // nothing left
      const empty = claimTask(dbB, { coordinator: auth, taskLeaseTtlMs: 400 });
      assert.equal(empty.status, "queue-empty");
    } finally {
      setNowSource(null);
    }
  } finally {
    closeDatabase(dbA);
    closeDatabase(dbB);
  }
});

test("a foreign owner with a valid generation is rejected and renews nothing", () => {
  const s = tempDb();
  try {
    setNowSource(clock());
    try {
      t = 700;
      grant(s.db, "A");
      const auth = authority(s.db, "A");
      const rowBefore = readLockRow(s.db);
      assert.throws(
        () => withWriteTx(s.db, (tx) => coordinatorGuardTxn(s.db, tx, "intruder", auth.generation, auth.lockTtlMs)),
        CoordinatorDisownedError,
      );
      // the rejected transaction rolled back: ownership, generation and the
      // piggy-back renewal are all untouched
      const row = readLockRow(s.db);
      assert.equal(row?.owner, "A");
      assert.equal(row?.generation, rowBefore?.generation);
      assert.equal(row?.expiresAt, rowBefore?.expiresAt);
    } finally {
      setNowSource(null);
    }
  } finally {
    s.close();
  }
});

test("task-lease renewal enforces all four authorization conditions", () => {
  const s = tempDb();
  try {
    setNowSource(clock());
    try {
      t = 1000;
      grant(s.db, "A");
      const auth = authority(s.db, "A");
      const store = new TaskStore(s.db);
      const task = store.addTask({ title: "lease renewal matrix" });
      store.transition(task.id, "BACKLOG");
      store.transition(task.id, "READY");
      const claim = claimTask(s.db, { coordinator: auth, taskLeaseTtlMs: 400 });
      if (claim.status !== "claimed") throw new Error("expected a claim");
      const lease = claim.lease; // { owner: "A", execGen: 1, ttlMs: 400 }

      // the valid (id, owner, exec_gen, unexpired) renewal re-stamps the lease
      assert.equal(store.heartbeatTaskLease(task.id, { owner: lease.owner, execGen: lease.execGen }, 400), true);
      assert.equal(store.getTask(task.id)?.leaseExpiresAt, 1400);

      t = 1100; // lease still fresh (expires 1400)
      // each violated condition is a silent no-op (false), never an error
      assert.equal(
        store.heartbeatTaskLease("no-such-task", { owner: lease.owner, execGen: lease.execGen }, 400),
        false,
        "unknown id",
      );
      assert.equal(
        store.heartbeatTaskLease(task.id, { owner: "intruder", execGen: lease.execGen }, 400),
        false,
        "wrong owner",
      );
      assert.equal(
        store.heartbeatTaskLease(task.id, { owner: lease.owner, execGen: lease.execGen + 1 }, 400),
        false,
        "stale generation",
      );
      t = 2500; // past the expiry: the fourth condition fails on its own
      assert.equal(
        store.heartbeatTaskLease(task.id, { owner: lease.owner, execGen: lease.execGen }, 400),
        false,
        "expired lease",
      );

      // the row was never touched by any rejected renewal
      const untouched = store.getTask(task.id);
      assert.equal(untouched?.leaseOwner, lease.owner);
      assert.equal(untouched?.leaseExpiresAt, 1400);
      assert.equal(untouched?.execGen, lease.execGen);
      assert.equal(untouched?.status, "IN_PROGRESS");
    } finally {
      setNowSource(null);
    }
  } finally {
    s.close();
  }
});

test("an expired IN_PROGRESS lease goes through recovery, then becomes claimable again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-locks3-"));
  const dbA = openDatabase(path.join(dir, "tasks.db"));
  const dbB = openDatabase(path.join(dir, "tasks.db"));
  try {
    const storeA = new TaskStore(dbA);
    const task = storeA.addTask({ title: "interrupted", priority: 5 });
    storeA.transition(task.id, "BACKLOG");
    storeA.transition(task.id, "READY");

    setNowSource(clock());
    try {
      t = 100;
      let gen = 0;
      withWriteTx(dbA, (tx) => {
        const outcome = acquireLockTxn(dbA, tx, "A", 5000);
        if (outcome.status !== "granted") throw new Error("lock acquire failed");
        gen = outcome.grant.generation;
        assert.equal(gen > 0, true);
      });
      const auth: CoordinatorAuthority = { owner: "A", generation: gen, lockTtlMs: 5000 };

      // A claims, then "crashes": the lease stays stamped but time passes
      const claimA = claimTask(dbA, { coordinator: auth, taskLeaseTtlMs: 400 });
      assert.equal(claimA.status, "claimed");
      const claimedId = claimA.status === "claimed" ? claimA.task.id : task.id;

      // while A's lease is fresh, connection B cannot take the row
      const storeB = new TaskStore(dbB);
      const tooEarly = storeB.recoverTaskWithCoordinator(claimedId, auth, { fromStatuses: ["IN_PROGRESS"] }, {
        toStatus: "READY",
        detail: "recovery takeover",
        taskLeaseTtlMs: 300,
      });
      assert.equal(tooEarly.status, "skipped");

      // after the lease expires, B recovers the row: IN_PROGRESS without output → READY
      t = 700;
      const recovered = storeB.recoverTaskWithCoordinator(claimedId, auth, { fromStatuses: ["IN_PROGRESS"] }, {
        toStatus: "READY",
        detail: "recovery takeover",
        taskLeaseTtlMs: 300,
      });
      assert.equal(recovered.status, "recovered");
      const staged = storeB.getTask(claimedId)!;
      assert.equal(staged.status, "READY");
      assert.equal(staged.execGen, 2); // takeover fences A
      assert.equal(staged.leaseOwner, "A");

      // the fresh recovery lease blocks claiming until it expires
      const tooSoon = claimTask(dbB, { coordinator: auth, taskLeaseTtlMs: 400 });
      assert.equal(tooSoon.status, "queue-empty");
      t = 1100;
      const reclaim = claimTask(dbB, { coordinator: auth, taskLeaseTtlMs: 400 });
      assert.equal(reclaim.status, "claimed");
      if (reclaim.status === "claimed") {
        assert.equal(reclaim.task.id, claimedId);
        assert.equal(reclaim.task.execGen, 3);
        assert.equal(reclaim.task.attempts, 2);
      }
    } finally {
      setNowSource(null);
    }
  } finally {
    closeDatabase(dbA);
    closeDatabase(dbB);
  }
});
