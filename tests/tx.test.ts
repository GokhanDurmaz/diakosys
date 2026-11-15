import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { withWriteTx, NestedTransactionError, TxStateError, type WriteTx } from "../src/tx.ts";
import { setNowSource } from "../src/clock.ts";
import type { DatabaseSync } from "node:sqlite";

function tempDb(): { db: DatabaseSync; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-tx-"));
  const db = openDatabase(path.join(dir, "tasks.db"));
  db.prepare("INSERT INTO tasks (id, title, status, priority, created_at, updated_at) VALUES ('t', 'hook', 'DISCOVERED', 0, 1, 1)").run();
  return { db, close: () => closeDatabase(db) };
}

function eventCount(db: DatabaseSync, minId: number): number {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE seq >= ?").get(minId)?.c ?? 0);
}

test("withWriteTx commits on success and the change persists", () => {
  const s = tempDb();
  try {
    let firstSeq = 0;
    const value = withWriteTx(s.db, (tx) => {
      firstSeq = Number(
        s.db
          .prepare("INSERT INTO task_events (task_id, event_type, created_at) VALUES ('t', 'created', ?)")
          .run(tx.now()).lastInsertRowid,
      );
      return "done";
    });
    assert.equal(value, "done");
    assert.equal(eventCount(s.db, firstSeq), 1);
  } finally {
    s.close();
  }
});

test("withWriteTx rolls back on throw and the original error is preserved", () => {
  const s = tempDb();
  try {
    let firstSeq = 0;
    assert.throws(
      () =>
        withWriteTx(s.db, (tx) => {
          firstSeq = Number(
            s.db
              .prepare("INSERT INTO task_events (task_id, event_type, created_at) VALUES ('t', 'rollback_probe', ?)")
              .run(tx.now()).lastInsertRowid,
          );
          throw new Error("writer exploded");
        }),
      /writer exploded/,
    );
    assert.equal(eventCount(s.db, firstSeq), 0);
  } finally {
    s.close();
  }
});

test("nested withWriteTx is rejected through the SQLite nested-BEGIN error", () => {
  const s = tempDb();
  try {
    assert.throws(
      () =>
        withWriteTx(s.db, (tx) => {
          // the outer transaction is open; the inner BEGIN IMMEDIATE fails
          withWriteTx(s.db, () => undefined);
          return undefined;
        }),
      (err: unknown) => {
        assert.ok(err instanceof NestedTransactionError);
        assert.match(err.message, /^BEGIN IMMEDIATE failed/);
        assert.match(err.message, /nested transactions are not supported/);
        return true;
      },
    );
    // the thrown error rolled back the outer transaction; the connection works again
    withWriteTx(s.db, (tx) => {
      s.db.prepare("INSERT INTO task_events (task_id, event_type, created_at) VALUES ('t', 'after_nested', ?)").run(tx.now());
      return undefined;
    });
    assert.ok(s.db.prepare("SELECT seq FROM task_events WHERE event_type = 'after_nested'").get());
  } finally {
    s.close();
  }
});

test("txnNow() is only valid inside the active write transaction", () => {
  const s = tempDb();
  try {
    let captured: WriteTx | undefined;
    withWriteTx(s.db, (tx) => {
      captured = tx;
      tx.now(); // valid here
    });
    assert.ok(captured);
    assert.throws(() => captured?.now(), TxStateError);
  } finally {
    s.close();
  }
});

test("fresh timestamp sampling: every tx.now() call re-reads the clock source", () => {
  const s = tempDb();
  try {
    let t = 10;
    setNowSource(() => t);
    try {
      const sampled: number[] = [];
      withWriteTx(s.db, (tx) => {
        sampled.push(tx.now());
        t += 5; // clock advances between protected statements
        sampled.push(tx.now());
      });
      assert.deepEqual(sampled, [10, 15]);
    } finally {
      setNowSource(null);
    }
  } finally {
    s.close();
  }
});
