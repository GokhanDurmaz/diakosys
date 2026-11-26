import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, applyMigrations, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import { persistProposals } from "../src/persist.ts";
import type { CoordinatorAuthority } from "../src/locks.ts";
import type { Proposal, Complexity } from "../src/proposal.ts";
import type { TaskEvent } from "../src/store.ts";
import type { Task } from "../src/types.ts";
import { coordinatorAuth } from "./helpers.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-orch-"));
}

test("schema is versioned and migrations run once", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db1 = openDatabase(dbPath);
  const versions = () => {
    const rows = db1.prepare("SELECT version FROM schema_info ORDER BY version").all() as unknown[];
    return rows.map((r) => (r as { version: number }).version);
  };
  const v1 = (db1.prepare("SELECT MAX(version) v FROM schema_info").get() as { v: number }).v;
  assert.equal(v1, 5, "every versioned migration records its version on first open");
  applyMigrations(db1);
  const reapplied = versions();
  const seenOnce = reapplied.length === new Set(reapplied).size;
  assert.ok(seenOnce, "migration records are written exactly once");
  closeDatabase(db1);

  const db2 = openDatabase(dbPath);
  const v2 = (db2.prepare("SELECT MAX(version) v FROM schema_info").get() as { v: number }).v;
  assert.equal(v2, 5, "no duplicate migration on reopen");
  const reopened = (db2.prepare("SELECT version FROM schema_info ORDER BY version").all() as unknown[]).map(
    (r) => (r as { version: number }).version,
  );
  assert.deepEqual(reopened, [1, 2, 3, 4, 5], "all migration records present exactly once");
  closeDatabase(db2);
});

test("tasks and events survive close/reopen", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");

  const db1 = openDatabase(dbPath);
  const store1 = new TaskStore(db1);
  const created = store1.addTask({
    title: "persist me",
    description: "across restarts",
    priority: 3,
  });
  store1.transition(created.id, "BACKLOG");
  store1.transition(created.id, "READY");
  store1.transition(created.id, "IN_PROGRESS");
  closeDatabase(db1);

  const db2 = openDatabase(dbPath);
  const store2 = new TaskStore(db2);
  const recovered = store2.getTask(created.id);
  assert.ok(recovered, "task recovered");
  assert.equal(recovered?.status, "IN_PROGRESS");
  assert.equal(recovered?.title, "persist me");
  assert.equal(recovered?.priority, 3);
  assert.equal(recovered?.attempts, 1);

  const events = store2.eventsFor(created.id);
  assert.deepEqual(
    events.map((e) => `${String(e.fromState)}→${String(e.toState)}`),
    ["null→DISCOVERED", "DISCOVERED→BACKLOG", "BACKLOG→READY", "READY→IN_PROGRESS"],
  );
  closeDatabase(db2);
});

test("list filters by state across restarts", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db1 = openDatabase(dbPath);
  const s1 = new TaskStore(db1);
  const a = s1.addTask({ title: "task a", priority: 5 });
  const b = s1.addTask({ title: "task b", priority: 1 });
  s1.transition(a.id, "BACKLOG");
  s1.transition(b.id, "BACKLOG");
  s1.transition(b.id, "BLOCKED", "waiting");
  closeDatabase(db1);

  const db2 = openDatabase(dbPath);
  const s2 = new TaskStore(db2);
  assert.equal(s2.listTasks("BACKLOG").length, 1);
  assert.equal(s2.listTasks("BLOCKED").length, 1);
  assert.equal(s2.listTasks("DISCOVERED").length, 0);
  assert.equal(s2.listTasks().length, 2);
  closeDatabase(db2);
});

test("corrupt database file fails loudly", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  fs.writeFileSync(dbPath, "this is not sqlite");
  assert.throws(() => openDatabase(dbPath));
});

test("empty database file fails loudly", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  fs.writeFileSync(dbPath, "");
  assert.throws(() => openDatabase(dbPath), /not a SQLite database file/);
  assert.equal(fs.statSync(dbPath).size, 0, "rejected file is left untouched");
  assert.equal(fs.existsSync(path.join(dir, "tasks.db-wal")), false, "no WAL sidecar created");
});

test("valid database file is accepted", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  // A real SQLite writer produced this file; openDatabase must accept it.
  const writer = new DatabaseSync(dbPath);
  writer.exec("CREATE TABLE seeded (x TEXT);");
  writer.close();

  const db = openDatabase(dbPath);
  const seeded = db.prepare("SELECT name FROM sqlite_master WHERE name = 'seeded'").get() as
    | { name: string }
    | undefined;
  assert.equal(seeded?.name, "seeded", "pre-existing tables are preserved");
  closeDatabase(db);
});

test("closeDatabase is idempotent", () => {
  const dir = tempDir();
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

test("stale v1 schema upgrades to v2 on reopen", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");

  // Build a database as it existed while only migration v1 was known: tasks +
  // task_events tables and schema_info pinned at version 1, no discovery_runs.
  const v1 = new DatabaseSync(dbPath);
  v1.exec(`
    CREATE TABLE tasks (
      id                 TEXT PRIMARY KEY,
      title              TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL,
      priority           INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      attempts           INTEGER NOT NULL DEFAULT 0,
      last_run_at        INTEGER,
      execution_metadata JSON NOT NULL DEFAULT '{}'
    );
    CREATE TABLE task_events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      event_type  TEXT NOT NULL,
      from_state  TEXT,
      to_state    TEXT,
      detail      TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE schema_info (
      version INTEGER NOT NULL,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_info (version, name, applied_at)
      VALUES (1, 'create-tasks-and-events', 1700000000000);
  `);
  v1.close();

  const db = openDatabase(dbPath);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'discovery_runs'").get() as
    | { name: string }
    | undefined;
  assert.equal(table?.name, "discovery_runs", "discovery_runs created during upgrade");
  const index = db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'idx_runs_status_finished'")
    .get() as { name: string } | undefined;
  assert.equal(index?.name, "idx_runs_status_finished", "composite index created during upgrade");

  // Tasks keep working after the upgrade.
  const store = new TaskStore(db);
  const task = store.addTask({ title: "after upgrade", priority: 1 });
  store.transition(task.id, "BACKLOG");
  store.transition(task.id, "READY");
  assert.equal(store.getTask(task.id)?.status, "READY");
  assert.equal(store.listTasks().length, 1);

  const events = store.eventsFor(task.id);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.eventType),
    ["created", "transition", "transition"],
  );
  assert.deepEqual(
    events.map((e) => `${String(e.fromState)}→${String(e.toState)}`),
    ["null→DISCOVERED", "DISCOVERED→BACKLOG", "BACKLOG→READY"],
  );
  closeDatabase(db);
});

test("schema_info missing upgrades from scratch", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const writer = new DatabaseSync(dbPath);
  writer.exec("CREATE TABLE scratch (x TEXT);");
  writer.close();
  fs.rmSync(path.join(dir, "tasks.db-shm"), { force: true });
  fs.rmSync(path.join(dir, "tasks.db-wal"), { force: true });

  const db = openDatabase(dbPath);
  const version = (db.prepare("SELECT MAX(version) v FROM schema_info").get() as { v: number }).v;
  assert.equal(version, 5, "all migrations applied when schema_info is absent");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'discovery_runs'").get() !== undefined, true);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_info'").get() !== undefined, true);
  closeDatabase(db);
});

test("empty schema_info table upgrades from scratch", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const writer = new DatabaseSync(dbPath);
  writer.exec(`
    CREATE TABLE schema_info (
      version INTEGER NOT NULL,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  writer.close();

  const db = openDatabase(dbPath);
  const version = (db.prepare("SELECT MAX(version) v FROM schema_info").get() as { v: number }).v;
  assert.equal(version, 5, "empty schema_info is not a version");
  closeDatabase(db);
});

test("duplicate schema_info version rows report the highest version", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const writer = new DatabaseSync(dbPath);
  writer.exec(`
    CREATE TABLE schema_info (
      version INTEGER NOT NULL,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_info (version, name, applied_at) VALUES (2, 'create-discovery-runs', 1);
    INSERT INTO schema_info (version, name, applied_at) VALUES (2, 'create-discovery-runs', 2);
    INSERT INTO schema_info (version, name, applied_at) VALUES (1, 'create-tasks-and-events', 3);
  `);
  writer.close();

  const db = openDatabase(dbPath);
  const version = (db.prepare("SELECT MAX(version) v FROM schema_info").get() as { v: number }).v;
  assert.equal(version, 5, "duplicate rows resolve to the maximum version");
  closeDatabase(db);
});

test("discovery_runs carries the status index and the composite status/finished_at index", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'discovery_runs'")
    .all() as { name: string }[];
  assert.deepEqual(
    indexes.map((i) => i.name).sort(),
    ["idx_runs_status", "idx_runs_status_finished", "sqlite_autoindex_discovery_runs_1"],
  );
  closeDatabase(db);
});

test("discovery_runs schema matches migration v2", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  const info = db.prepare("PRAGMA table_info(discovery_runs)").all() as unknown as { name: string }[];
  const columns = info.map((i) => i.name);
  assert.deepEqual(columns, ["id", "started_at", "finished_at", "status", "areas_total", "areas_completed", "raw_proposals", "accepted", "rejected", "error", "model"]);
  closeDatabase(db);
});

// ---------------------------------------------------------------------------
// Task 5 — proposal persistence is coordinator-guarded and atomic
// ---------------------------------------------------------------------------

function mkProposal(title: string, priority: number, complexity: Complexity): Proposal {
  return {
    title,
    problem: "Non-finite samples reach the health evaluator and corrupt the score",
    rationale: "The evaluator must reject non-finite sampled values",
    evidence: [{ file: "src/main/java/io/diakosys/HealthEvaluator.java", observation: "sampled value is not finite" }],
    approach: "Pin the sample before scoring and reject NaN/Infinity",
    outcome: "The health score stays finite for every sample",
    priority,
    complexity,
    verification: ["run the health evaluator tests"],
  };
}

function proposalTasks(store: TaskStore): Task[] {
  return store.listTasks().filter((task) => task.status === "DISCOVERED");
}

function proposalEvents(store: TaskStore, title: string): TaskEvent[] {
  const task = proposalTasks(store).find((t) => t.title === title);
  return task === undefined ? [] : store.eventsFor(task.id);
}

function proposalMeta(store: TaskStore, title: string): Record<string, unknown> {
  const task = proposalTasks(store).find((task) => task.title === title);
  return task === undefined ? {} : task.executionMetadata;
}

test("coordinator authorization: wrong owner and stale generation reject the proposal", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  try {
    const store = new TaskStore(db);
    const auth = coordinatorAuth(db);
    const proposal = mkProposal("owned by the coordinator", 6, "low");

    // wrong owner
    let threw = false;
    try {
      persistProposals(store, { proposals: [proposal] }, { model: "mimo-2.6" }, { ...auth, owner: "other" }, () => {});
    } catch {
      threw = true;
    }
    assert.ok(threw, "a proposal from a different coordinator owner is rejected");
    assert.equal(proposalTasks(store).length, 0, "no task was created for the wrong owner");

    // stale generation: the lock row advanced but the authority still claims the old one
    db.prepare("UPDATE instance_locks SET generation = generation + 1 WHERE id = 1").run();
    threw = false;
    try {
      persistProposals(store, { proposals: [proposal] }, { model: "mimo-2.6" }, { ...auth, generation: auth.generation }, () => {});
    } catch {
      threw = true;
    }
    assert.ok(threw, "a proposal submitted with a stale generation is rejected");
    assert.equal(proposalTasks(store).length, 0, "no task was created for the stale generation");
  } finally {
    closeDatabase(db);
  }
});

test("coordinator authorization: an expired lock rejects the proposal", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  try {
    const store = new TaskStore(db);
    const auth = coordinatorAuth(db);
    const proposal = mkProposal("locked by an expired lease", 6, "low");
    // Expire the live lock row itself; the authority still carries a fresh TTL.
    db.prepare("UPDATE instance_locks SET expires_at = ? WHERE id = 1").run(Date.now() - 1);
    let threw = false;
    try {
      persistProposals(store, { proposals: [proposal] }, { model: "mimo-2.6" }, auth, () => {});
    } catch {
      threw = true;
    }
    assert.ok(threw, "a proposal is rejected when the coordinator lock has expired");
    assert.equal(proposalTasks(store).length, 0, "no task was created for the expired lock");
  } finally {
    closeDatabase(db);
  }
});

test("proposal persistence is atomic: task, metadata, created and planned in one transaction", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  try {
    const store = new TaskStore(db);
    const auth = coordinatorAuth(db);
    const proposal = mkProposal("atomic proposal persistence", 6, "high");

    persistProposals(store, { proposals: [proposal] }, { model: "mimo-2.6" }, auth, () => {});

    const tasks = proposalTasks(store);
    assert.equal(tasks.length, 1, "exactly one DISCOVERED task was created");
    const task = tasks[0];
    if (task === undefined) throw new Error("expected a persisted task");
    assert.equal(task.status, "DISCOVERED");
    assert.equal(task.description, proposal.problem);
    assert.equal(task.priority, proposal.priority);

    const meta = proposalMeta(store, task.title);
    assert.ok(meta.proposal !== undefined, "the proposal payload was persisted as metadata");
    assert.deepEqual(meta.proposal, proposal, "the persisted proposal payload matches the input");
    assert.ok(meta.discoveryRun !== undefined, "discovery-run metadata was persisted");
    assert.equal(meta.primaryFile, proposal.evidence[0]?.file);
    assert.equal(meta.complexity, "high");

    const events = store.eventsFor(task.id);
    const created = events.filter((event) => event.eventType === "created");
    const planned = events.filter((event) => event.eventType === "planned");
    assert.equal(created.length, 1, "exactly one creation event was recorded");
    assert.equal(planned.length, 1, "exactly one planning event was recorded");
  } finally {
    closeDatabase(db);
  }
});

test("proposal persistence rolls back after a mid-batch failure", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  const store = new TaskStore(db);
  const auth = coordinatorAuth(db);
  const a = mkProposal("alpha survives the batch failure", 6, "high");
  const b = mkProposal("beta fails mid-batch", 6, "high");
  const c = mkProposal("gamma survives the batch failure", 6, "high");
  let made = 0;
  const original = Object.getPrototypeOf(store).createTaskWithCoordinator;
  try {
  // patch the instance only — the prototype method is a class "const", so the
  // wrapper is an own property of this store and is restored by re-assigning
  // the captured original.
  store.createTaskWithCoordinator = function (
    input: { title: string; description: string; priority: number; metadata: Record<string, unknown>; planningDetail: string },
    authority: CoordinatorAuthority,
  ) {
    made++;
    if (input.title === b.title) throw new Error("simulated proposal failure");
    return original.call(this, input, authority);
  };

  let threw = false;
  try {
    persistProposals(store, { proposals: [a, b, c] }, { model: "mimo-2.6" }, auth, () => {});
  } catch {
    threw = true;
  }
  assert.ok(threw, "a mid-batch proposal failure is propagated to the caller");

  const tasks = proposalTasks(store);
  assert.equal(tasks.length, 2, "the surviving proposals were kept; only the failing one rolled back");
  const titles = tasks.map((task) => task.title).sort();
  assert.deepEqual(titles, [a.title, c.title], "the failed proposal left no task behind");

  // the surviving tasks are fully persisted, not half-written
  for (const task of tasks) {
    assert.ok(task.executionMetadata.proposal !== undefined, `${task.title} carries its proposal payload`);
    assert.equal(store.eventsFor(task.id).filter((e) => e.eventType === "created").length, 1);
    assert.equal(store.eventsFor(task.id).filter((e) => e.eventType === "planned").length, 1);
  }
} finally {
  store.createTaskWithCoordinator = original;
  closeDatabase(db);
}
});

// ---------------------------------------------------------------------------
// Migration v5 — migrate-sse-events-to-sequence
// ---------------------------------------------------------------------------

interface PreV5Event {
  id: string;
  timestamp: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: string;
  schemaVersion?: number;
}

/**
 * Build a database exactly as migration v4 leaves it: every table, index and
 * seed row from migrations 1-4, schema_info rows for versions 1-4, and an
 * sse_events table without the v5 sequence column.
 */
function createPreV5Database(dbPath: string, events: readonly PreV5Event[] = []): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE tasks (
        id                 TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL,
        priority           INTEGER NOT NULL DEFAULT 0,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        attempts           INTEGER NOT NULL DEFAULT 0,
        last_run_at        INTEGER,
        execution_metadata JSON NOT NULL DEFAULT '{}'
      );
      CREATE TABLE task_events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT NOT NULL REFERENCES tasks(id),
        event_type  TEXT NOT NULL,
        from_state  TEXT,
        to_state    TEXT,
        detail      TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_events_task  ON task_events(task_id, seq);

      CREATE TABLE discovery_runs (
        id              TEXT PRIMARY KEY,
        started_at      INTEGER NOT NULL,
        finished_at     INTEGER,
        status          TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
        areas_total     INTEGER NOT NULL,
        areas_completed INTEGER NOT NULL,
        raw_proposals   INTEGER NOT NULL DEFAULT 0,
        accepted        INTEGER NOT NULL DEFAULT 0,
        rejected        INTEGER NOT NULL DEFAULT 0,
        error           TEXT,
        model           TEXT
      );
      CREATE INDEX idx_runs_status ON discovery_runs(status);
      CREATE INDEX idx_runs_status_finished ON discovery_runs(status, finished_at);

      ALTER TABLE tasks ADD COLUMN exec_gen INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN lease_owner TEXT;
      ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER;

      CREATE TABLE instance_locks (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        owner      TEXT NOT NULL,
        generation INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO instance_locks (id, owner, generation, expires_at) VALUES (1, '', 0, 0);

      CREATE TABLE sse_events (
        id              TEXT PRIMARY KEY,
        timestamp       INTEGER NOT NULL,
        event_type      TEXT NOT NULL,
        aggregate_type  TEXT NOT NULL,
        aggregate_id    TEXT NOT NULL,
        payload         TEXT NOT NULL,
        schema_version  INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_sse_events_timestamp ON sse_events(timestamp);
      CREATE INDEX idx_sse_events_aggregate ON sse_events(aggregate_type, aggregate_id);

      CREATE TABLE schema_info (
        version INTEGER NOT NULL,
        name    TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_info (version, name, applied_at) VALUES
        (1, 'create-tasks-and-events', 1700000000000),
        (2, 'create-discovery-runs', 1700000000001),
        (3, 'add-leases-and-instance-lock', 1700000000002),
        (4, 'create-sse-event-storage', 1700000000003);
    `);

    const insert = db.prepare(`
      INSERT INTO sse_events
        (id, timestamp, event_type, aggregate_type, aggregate_id, payload, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      insert.run(
        event.id,
        event.timestamp,
        event.eventType,
        event.aggregateType,
        event.aggregateId,
        event.payload,
        event.schemaVersion ?? 1,
      );
    }

    const version = (db.prepare("SELECT MAX(version) v FROM schema_info").get() as { v: number }).v;
    assert.equal(version, 4, "pre-v5 fixture stops at migration v4");
    const columns = db.prepare("PRAGMA table_info(sse_events)").all() as unknown as { name: string }[];
    assert.equal(
      columns.some((column) => column.name === "sequence"),
      false,
      "pre-v5 fixture has no sequence column",
    );
  } finally {
    db.close();
  }
}

test("migration v5 creates sse_events with sequence as primary key", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks_v5.db");
  createPreV5Database(dbPath);

  const db = openDatabase(dbPath);
  try {
    const applied = db
      .prepare("SELECT version, name FROM schema_info ORDER BY version")
      .all() as unknown as { version: number; name: string }[];
    assert.deepEqual(
      applied.map((row) => row.version),
      [1, 2, 3, 4, 5],
      "migration v5 is recorded on top of the existing v1-v4 rows",
    );
    assert.equal(applied[4]?.name, "migrate-sse-events-to-sequence", "v5 migration name is recorded");

    const columns = db.prepare("PRAGMA table_info(sse_events)").all() as unknown as {
      name: string;
      type: string;
      pk: number;
    }[];
    const sequence = columns.find((column) => column.name === "sequence");
    assert.equal(sequence?.type, "INTEGER", "sequence should be INTEGER type");
    assert.equal(sequence?.pk, 1, "sequence should be the primary key");
    const id = columns.find((column) => column.name === "id");
    assert.equal(id?.type, "TEXT", "id should remain a TEXT column");
    assert.equal(id?.pk, 0, "id should no longer be the primary key");

    const table = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sse_events'")
      .get() as { sql: string };
    assert.match(
      table.sql,
      /sequence\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i,
      "sequence should be INTEGER PRIMARY KEY AUTOINCREMENT",
    );
  } finally {
    closeDatabase(db);
  }
});

test("migration v5 preserves all sse_events data", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks_v5_data.db");
  const events: readonly PreV5Event[] = [
    {
      id: "evt_001",
      timestamp: 1700000000000,
      eventType: "task.created",
      aggregateType: "task",
      aggregateId: "task-1",
      payload: '{"key": "value1"}',
      schemaVersion: 1,
    },
    {
      id: "evt_002",
      timestamp: 1700000001000,
      eventType: "task.transitioned",
      aggregateType: "task",
      aggregateId: "task-1",
      payload: '{"from": "DISCOVERED", "to": "READY"}',
      schemaVersion: 2,
    },
    {
      id: "evt_003",
      timestamp: 1700000002000,
      eventType: "discovery.completed",
      aggregateType: "discovery",
      aggregateId: "disc-1",
      payload: '{"count": 42}',
      schemaVersion: 3,
    },
  ];
  createPreV5Database(dbPath, events);

  const db = openDatabase(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT sequence, id, timestamp, event_type, aggregate_type, aggregate_id, payload, schema_version
         FROM sse_events ORDER BY sequence ASC`,
      )
      .all() as unknown as {
      sequence: number;
      id: string;
      timestamp: number;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: string;
      schema_version: number;
    }[];
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          sequence: 1,
          id: "evt_001",
          timestamp: 1700000000000,
          event_type: "task.created",
          aggregate_type: "task",
          aggregate_id: "task-1",
          payload: '{"key": "value1"}',
          schema_version: 1,
        },
        {
          sequence: 2,
          id: "evt_002",
          timestamp: 1700000001000,
          event_type: "task.transitioned",
          aggregate_type: "task",
          aggregate_id: "task-1",
          payload: '{"from": "DISCOVERED", "to": "READY"}',
          schema_version: 2,
        },
        {
          sequence: 3,
          id: "evt_003",
          timestamp: 1700000002000,
          event_type: "discovery.completed",
          aggregate_type: "discovery",
          aggregate_id: "disc-1",
          payload: '{"count": 42}',
          schema_version: 3,
        },
      ],
      "every event is preserved with its id and data unchanged",
    );
  } finally {
    closeDatabase(db);
  }
});

test("migration v5 creates proper indexes on sse_events", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks_v5_indexes.db");
  createPreV5Database(dbPath);

  const db = openDatabase(dbPath);
  try {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sse_events' AND name LIKE 'idx_%'",
      )
      .all() as unknown as { name: string }[];
    assert.deepEqual(
      indexes.map((index) => index.name).sort(),
      ["idx_sse_events_aggregate", "idx_sse_events_id", "idx_sse_events_timestamp"],
      "all expected sse_events indexes are recreated",
    );

    const indexColumns = (name: string) =>
      (db.prepare(`PRAGMA index_info(${name})`).all() as unknown as { name: string }[]).map(
        (column) => column.name,
      );
    assert.deepEqual(indexColumns("idx_sse_events_timestamp"), ["timestamp"]);
    assert.deepEqual(indexColumns("idx_sse_events_aggregate"), ["aggregate_type", "aggregate_id"]);
    assert.deepEqual(indexColumns("idx_sse_events_id"), ["id"]);
  } finally {
    closeDatabase(db);
  }
});

test("migration v5 uses sequence for ordering", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks_v5_order.db");

  // Insertion order deliberately disagrees with timestamp order.
  const events: readonly PreV5Event[] = [
    {
      id: "evt_late",
      timestamp: 1700000003000,
      eventType: "event.late",
      aggregateType: "agg",
      aggregateId: "a1",
      payload: "{}",
    },
    {
      id: "evt_early",
      timestamp: 1700000001000,
      eventType: "event.early",
      aggregateType: "agg",
      aggregateId: "a1",
      payload: "{}",
    },
    {
      id: "evt_middle",
      timestamp: 1700000002000,
      eventType: "event.middle",
      aggregateType: "agg",
      aggregateId: "a1",
      payload: "{}",
    },
  ];
  createPreV5Database(dbPath, events);

  const db = openDatabase(dbPath);
  try {
    const bySequence = db
      .prepare("SELECT sequence, id FROM sse_events ORDER BY sequence ASC")
      .all() as unknown as { sequence: number; id: string }[];
    assert.deepEqual(
      bySequence.map((row) => row.sequence),
      [1, 2, 3],
      "sequence values follow rowid/insertion order",
    );
    assert.deepEqual(
      bySequence.map((row) => row.id),
      ["evt_late", "evt_early", "evt_middle"],
      "sequence order is insertion order",
    );

    const byTimestamp = db
      .prepare("SELECT id FROM sse_events ORDER BY timestamp ASC, id ASC")
      .all() as unknown as { id: string }[];
    assert.deepEqual(
      byTimestamp.map((row) => row.id),
      ["evt_early", "evt_middle", "evt_late"],
      "timestamp order intentionally differs from insertion order",
    );
    assert.notDeepEqual(
      bySequence.map((row) => row.id),
      byTimestamp.map((row) => row.id),
      "the test would not prove sequence ordering if the two orders matched",
    );
  } finally {
    closeDatabase(db);
  }
});

test("reopening a migrated database does not execute migration v5 again", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks_v5_reopen.db");
  createPreV5Database(dbPath, [
    {
      id: "evt_reopen",
      timestamp: 1700000000000,
      eventType: "task.created",
      aggregateType: "task",
      aggregateId: "task-1",
      payload: "{}",
    },
  ]);

  const first = openDatabase(dbPath);
  const firstAppliedAt = (
    first.prepare("SELECT applied_at FROM schema_info WHERE version = 5").get() as {
      applied_at: number;
    }
  ).applied_at;
  assert.equal(
    (first.prepare("SELECT sequence FROM sse_events WHERE id = 'evt_reopen'").get() as {
      sequence: number;
    }).sequence,
    1,
    "migration v5 ran on the first open",
  );
  closeDatabase(first);

  const reopened = openDatabase(dbPath);
  try {
    const v5Rows = reopened
      .prepare("SELECT version, applied_at FROM schema_info WHERE version = 5")
      .all() as unknown as { version: number; applied_at: number }[];
    assert.equal(v5Rows.length, 1, "migration v5 is recorded exactly once");
    assert.equal(v5Rows[0]?.applied_at, firstAppliedAt, "the v5 record was not rewritten on reopen");

    const duplicates = reopened
      .prepare(
        "SELECT version FROM schema_info GROUP BY version HAVING COUNT(*) > 1",
      )
      .all() as unknown as { version: number }[];
    assert.deepEqual(duplicates, [], "no migration version is recorded twice");

    assert.equal(
      (reopened.prepare("SELECT MAX(version) v FROM schema_info").get() as { v: number }).v,
      5,
      "the reopened database is still at version 5",
    );
    assert.equal(
      (reopened.prepare("SELECT COUNT(*) AS c FROM sse_events").get() as { c: number }).c,
      1,
      "reopening does not rebuild or duplicate the migrated events",
    );
  } finally {
    closeDatabase(reopened);
  }
});

test("proposal persistence uses one transaction per proposal", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  try {
    const store = new TaskStore(db);
    const auth = coordinatorAuth(db);
    const first = mkProposal("first proposal transaction", 6, "high");
    const second = mkProposal("second proposal transaction", 6, "high");

    persistProposals(store, { proposals: [first, second] }, { model: "mimo-2.6" }, auth, () => {});

    const tasks = proposalTasks(store);
    assert.equal(tasks.length, 2, "both proposals were persisted independently");
    const titles = tasks.map((task) => task.title).sort();
    assert.deepEqual(titles, [first.title, second.title]);

    // each proposal has its own task, metadata, events and timestamps
    for (const task of tasks) {
      const meta = proposalMeta(store, task.title);
      assert.ok(meta.proposal !== undefined, `${task.title} carries its proposal payload`);
      assert.ok(meta.discoveryRun !== undefined, `${task.title} carries its discovery-run metadata`);
      assert.equal(store.eventsFor(task.id).length, 2, `${task.title} has its own event chain`);
    }

    // a failure in one proposal does not affect the other: the same batch shape
    // with two fresh proposals (the first pair is already in the store, which
    // makes them title-similar duplicates and would be skipped).
    const third = mkProposal("third proposal transaction", 6, "high");
    const fourth = mkProposal("fourth proposal transaction", 6, "high");
    const original = Object.getPrototypeOf(store).createTaskWithCoordinator;
    let calls = 0;
    store.createTaskWithCoordinator = function (
      input: { title: string; description: string; priority: number; metadata: Record<string, unknown>; planningDetail: string },
      authority: CoordinatorAuthority,
    ) {
      calls++;
      if (input.title === fourth.title) throw new Error("simulated proposal failure");
      return original.call(this, input, authority);
    };
    let threw = false;
    try {
      persistProposals(store, { proposals: [third, fourth] }, { model: "mimo-2.6" }, auth, () => {});
    } catch {
      threw = true;
    }
    assert.ok(threw, "a proposal failure is propagated");
    assert.equal(proposalTasks(store).length, 3, "only the failed proposal rolled back");
    assert.equal(calls, 2, "both proposals were attempted");
    assert.ok(proposalTasks(store).some((t) => t.title === third.title), "the survivor persisted");
    store.createTaskWithCoordinator = original;
  } finally {
    closeDatabase(db);
  }
});
