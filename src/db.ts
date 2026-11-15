import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  apply: (db: DatabaseSync) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "create-tasks-and-events",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
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
        CREATE TABLE IF NOT EXISTS task_events (
          seq         INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     TEXT NOT NULL REFERENCES tasks(id),
          event_type  TEXT NOT NULL,
          from_state  TEXT,
          to_state    TEXT,
          detail      TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_events_task  ON task_events(task_id, seq);
      `);
    },
  },
  {
    version: 2,
    name: "create-discovery-runs",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS discovery_runs (
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
        CREATE INDEX IF NOT EXISTS idx_runs_status ON discovery_runs(status);
        CREATE INDEX IF NOT EXISTS idx_runs_status_finished ON discovery_runs(status, finished_at);
      `);
    },
  },
  {
    version: 3,
    name: "add-leases-and-instance-lock",
    apply: (db) => {
      const taskColumns = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as unknown as { name: string }[]).map(
          (c) => c.name,
        ),
      );
      if (taskColumns.size > 0) {
        if (!taskColumns.has("exec_gen")) {
          db.exec("ALTER TABLE tasks ADD COLUMN exec_gen INTEGER NOT NULL DEFAULT 0");
        }
        if (!taskColumns.has("lease_owner")) {
          db.exec("ALTER TABLE tasks ADD COLUMN lease_owner TEXT");
        }
        if (!taskColumns.has("lease_expires_at")) {
          db.exec("ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER");
        }
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS instance_locks (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          owner      TEXT NOT NULL,
          generation INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      db.exec(
        "INSERT OR IGNORE INTO instance_locks (id, owner, generation, expires_at) VALUES (1, '', 0, 0)",
      );
    },
  },
];

const SQLITE_MAGIC = "SQLite format 3";
const SQLITE_HEADER_SIZE = 100;

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_info (
      version INTEGER NOT NULL,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function currentVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT COALESCE(MAX(version), -1) AS v FROM schema_info").get() as
      | { v: number }
      | undefined;
    return row?.v ?? -1;
  } catch {
    return -1;
  }
}

/** A table that never existed is invisible to `IF NOT EXISTS`; detect absence explicitly. */
function discoveryRunsTablePresent(db: DatabaseSync): boolean {
  const rows = db.prepare("PRAGMA table_info(discovery_runs)").all() as unknown[];
  return rows.some((r) => (r as { name: string }).name !== "");
}

/**
 * Stale-schema upgrade: a database created while an earlier migration was the
 * newest has no tables introduced by later migrations. Upgrade in place before
 * applying any migration, so `CREATE TABLE IF NOT EXISTS` is never asked to
 * create a table that never existed.
 */
function upgradeStaleSchema(db: DatabaseSync): void {
  if (discoveryRunsTablePresent(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_runs (
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
    CREATE INDEX IF NOT EXISTS idx_runs_status ON discovery_runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_status_finished ON discovery_runs(status, finished_at);
  `);
}

export function applyMigrations(db: DatabaseSync): void {
  ensureMigrationsTable(db);
  const applied = currentVersion(db);
  upgradeStaleSchema(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue;
    db.exec("BEGIN");
    try {
      migration.apply(db);
      db.prepare(
        "INSERT INTO schema_info (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${String(err)}`);
    }
  }
}

/** Refuse to open anything that exists but is not a real SQLite database file. */
function validateDatabaseFile(path: string): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(path);
  } catch {
    return; // absent file is created by DatabaseSync, as before
  }
  if (!stat.isFile()) return;
  let header: string;
  try {
    header = fs.readFileSync(path, { encoding: "utf8" });
  } catch (err) {
    throw new Error(`refusing to open '${path}': cannot read database file (${String(err)})`);
  }
  if (!header.startsWith(SQLITE_MAGIC)) {
    throw new Error(
      `refusing to open '${path}': not a SQLite database file (missing '${SQLITE_MAGIC}' magic)`,
    );
  }
  if (stat.size < SQLITE_HEADER_SIZE) {
    throw new Error(`refusing to open '${path}': file is truncated at ${stat.size} bytes (< ${SQLITE_HEADER_SIZE})`);
  }
}

const SQLITE_VERSION_FLOOR = { major: 3, minor: 35, patch: 0 };

function assertSqliteVersionFloor(db: DatabaseSync): void {
  const raw = db.prepare("SELECT sqlite_version() AS v").get() as { v: string } | undefined;
  const parts = (raw?.v ?? "").split(".").map((n) => Number.parseInt(n, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  const atLeastFloor =
    major > SQLITE_VERSION_FLOOR.major ||
    (major === SQLITE_VERSION_FLOOR.major &&
      (minor > SQLITE_VERSION_FLOOR.minor ||
        (minor === SQLITE_VERSION_FLOOR.minor && patch >= SQLITE_VERSION_FLOOR.patch)));
  if (!atLeastFloor) {
    const version = raw?.v ?? "unknown";
    throw new Error(
      `SQLite ${raw?.v ?? "unknown"} is too old for diakosys-orchestrator (requires >= 3.35). Node.js node:sqlite build is incompatible.`,
    );
  }
}

export function openDatabase(path: string): DatabaseSync {
  validateDatabaseFile(path);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  assertSqliteVersionFloor(db);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applyMigrations(db);
  return db;
}

/** Closing an already-closed handle is a safe no-op. */
export function closeDatabase(db: DatabaseSync): void {
  if (!db.isOpen) return;
  db.close();
}
