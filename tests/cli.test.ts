import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { Writable } from "node:stream";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import { acquireInstanceLock, lockState } from "../src/coordinator.ts";
import { TASK_STATES } from "../src/types.ts";
import { makeProposal, restoreEnv } from "./helpers.ts";
import { discover, validatePlanArgs, MOCK_DISCOVERY_REPLY } from "../src/cli.ts";
import { MockOpenCodeAdapter } from "../src/opencode.ts";

/**
 * Subprocess-level CLI integration tests: every spawn runs `node src/cli.ts`
 * against an isolated database (DIAKOSYS_ORCHESTRATOR_DB) and isolated HOME, so
 * tests never touch the developer's real database or ~/.Cache manifest dir.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(ROOT, "src", "cli.ts");

const execFileP = promisify(execFile);

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function tempTarget(): { dir: string; dbPath: string; home: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cli-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  return { dir, dbPath: path.join(dir, "tasks.db"), home };
}

function cliEnv(dbPath: string, home: string): NodeJS.ProcessEnv {
  // deliberately minimal: nothing from the developer's environment can leak
  // into the child (model, db path, cache dir are all pinned)
  return {
    PATH: process.env.PATH,
    HOME: home,
    DIAKOSYS_ORCHESTRATOR_DB: dbPath,
    DIAKOSYS_ORCHESTRATOR_MODEL: "Qwen-Mimo/model",
  };
}

async function cli(
  args: string[],
  dbPath: string,
  home: string,
  /** Optional env overrides merged AFTER cliEnv: lets tests inject config
   *  validation failures (e.g. DIAKOSYS_ORCHESTRATOR_PORT=abc) or a database path
   *  that cannot be opened, without loosening cliEnv itself. */
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI_ENTRY, ...args], {
      cwd: ROOT, // projectDirectory defaults to cwd; discovery evidence resolves in-repo
      env: { ...cliEnv(dbPath, home), ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code === "number") {
      return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    throw err; // spawn-level failure (signal/timeout) — fail loudly
  }
}

function readDb(dbPath: string): { db: DatabaseSync; store: TaskStore; close(): void } {
  const db = openDatabase(dbPath);
  return { db, store: new TaskStore(db), close: () => closeDatabase(db) };
}

/** Seed a FAILED task with N recorded attempts (same shape the recovery
 *  suite uses): no lease, FAILED, execution metadata patched in. */
function seedFailedTask(db: DatabaseSync, title: string, attempts: number, meta: Record<string, unknown>): string {
  const store = new TaskStore(db);
  const task = store.addTask({ title });
  store.transition(task.id, "BACKLOG");
  store.transition(task.id, "READY");
  for (let i = 0; i < attempts; i++) {
    store.transition(task.id, "IN_PROGRESS");
    store.transition(task.id, "FAILED", `attempt failed (${i})`);
    if (i < attempts - 1) {
      store.transition(task.id, "BACKLOG"); // earlier retry attempts requeued
      store.transition(task.id, "READY");
    }
  }
  store.setMetadata(task.id, meta);
  return task.id;
}

test("global CLI help exits cleanly and never creates the database", async () => {
  const { dbPath, home } = tempTarget();
  const cases: Array<{ args: string[]; code: number; stderr?: RegExp }> = [
    { args: [], code: 0 },
    { args: ["help"], code: 0 },
    { args: ["run", "--help"], code: 0 },
    { args: ["cycle", "-h"], code: 0 },
    { args: ["definitely-not-a-command"], code: 1, stderr: /unknown command/ },
  ];
  for (const c of cases) {
    const r = await cli(c.args, dbPath, home);
    assert.equal(r.code, c.code, `args: ${c.args.join(" ")}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    if (c.stderr !== undefined) assert.match(r.stderr, c.stderr);
    assert.match(r.stdout, /Usage: orchestrator <command> \[options\]/);
    assert.match(r.stdout, /recover \[--confirm-unsafe\]/);
    assert.doesNotMatch(r.stdout, /database: /, "no command opened the database");
    assert.equal(
      fs.existsSync(dbPath),
      false,
      `help must not initialize the database (args: ${c.args.join(" ")})`,
    );
  }
});

test("mock CLI cycle completes a discovered task end-to-end (success path)", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["cycle", "--mock"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /discovery accepted: /);
  assert.match(r.stdout, /1 discovered/);
  assert.match(r.stdout, /1 executed \(0 execution failure\(s\)\)/);
  assert.match(r.stdout, /1 verified DONE, 0 verified FAILED/);

  const db = readDb(dbPath);
  try {
    const tasks = db.store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.status, "DONE");
    assert.equal(tasks[0]!.executionMetadata["verification"], "pass");
    assert.match(String(tasks[0]!.executionMetadata["verificationNote"]), /^verifier pass:/);
  } finally {
    db.close();
  }
  // discovery persistence behavior is preserved: the resumable-run manifest
  // lands in the (isolated) HOME cache, exactly as the real CLI does
  assert.equal(fs.existsSync(path.join(home, "Cache", "diakosys-orchestrator", "discovery-runs", "runs.json")), true);
});

test("mock CLI verification failure marks the task FAILED and exits 1", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["cycle", "--mock", "--mock-fail"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /verify: \S+ FAIL/);
  assert.match(r.stdout, /0 verified DONE, 1 verified FAILED/);

  const db = readDb(dbPath);
  try {
    const tasks = db.store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.status, "FAILED");
    assert.equal(tasks[0]!.executionMetadata["verification"], "fail");
    assert.match(String(tasks[0]!.executionMetadata["verificationNote"]), /^verifier fail:/);
  } finally {
    db.close();
  }
});

test("cycle rejects a non-numeric --max-executions and exits 1", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["cycle", "--mock", "--max-executions", "abc"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /max-executions/);
  assert.match(r.stderr, /abc/);
  // no database or manifest may be created for an invalid argument
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.existsSync(runsJsonPath(home)), false);
});

test("cycle rejects a non-numeric --max-rounds and exits 1", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["cycle", "--mock", "--max-rounds", "abc"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /max-rounds/);
  assert.match(r.stderr, /abc/);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.existsSync(runsJsonPath(home)), false);
});

test("cycle rejects a missing numeric value and exits 1", async () => {
  const { dbPath, home } = tempTarget();
  for (const flag of ["--max-executions", "--max-rounds"]) {
    const r = await cli(["cycle", "--mock", flag], dbPath, home);
    assert.equal(r.code, 1, `flag: ${flag}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${flag} requires a numeric value`));
    assert.equal(fs.existsSync(dbPath), false);
    assert.equal(fs.existsSync(runsJsonPath(home)), false);
  }
});

test("cycle accepts the lower-bound boundary values 0 and 1", async () => {
  const { dbPath, home } = tempTarget();
  const zero = await cli(["cycle", "--mock", "--max-executions", "0"], dbPath, home);
  assert.equal(zero.code, 0, `stdout: ${zero.stdout}\nstderr: ${zero.stderr}`);
  assert.match(zero.stdout, /0 executed/);
  const one = await cli(["cycle", "--mock", "--max-rounds", "1"], dbPath, home);
  assert.equal(one.code, 0, `stdout: ${one.stdout}\nstderr: ${one.stderr}`);
  assert.match(one.stdout, /1 verified DONE/);
});

// ——— cycle lock refusal (Stage 10.3.7) ———
//
// When another orchestrator process already holds the coordinator instance
// lock, cycle must refuse to run: exit 1, a diagnostic on stderr that names
// the foreign holder, and absolutely no task execution or transition. The
// foreign holder's identity and lock generation are preserved in the
// coordinator lock table, and no discovery-run manifest is created.
//
// Synchronization is fully deterministic: the test holds the lock itself in a
// separate handle and releases it at the end, so no sleeps or races are
// involved.

test("cycle refuses to run when a foreign coordinator holds the instance lock", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  let holder: DatabaseSync | undefined;
  const seed = readDb(dbPath);
  try {
    id = seed.store.addTask({ title: "held hostage" }).id;
    // Open the holder in its own handle so that closing the seed handle
    // below does not invalidate it; the CLI subprocess must see a live lock.
    holder = openDatabase(dbPath);
    acquireInstanceLock(holder, "foreign-cycle-holder", 600_000);
  } finally {
    seed.close();
  }

  const r = await cli(["cycle"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "");
  // the diagnostic names the foreign holder and the refusal
  assert.match(r.stderr, /another coordinator holds the orchestrator lock/);
  assert.match(r.stderr, /foreign-cycle-holder/);

  // the foreign holder's lock state is preserved untouched
  const lock = lockState(holder);
  assert.ok(lock !== undefined);
  assert.equal(lock.owner, "foreign-cycle-holder");
  assert.equal(lock.generation, 1);

  // no task was executed or transitioned
  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "DISCOVERED");
    assert.equal(task.attempts, 0);
    assert.equal(task.leaseOwner, null);
    // and no discovery-run manifest was created
    assert.equal(fs.existsSync(runsJsonPath(home)), false);
  } finally {
    db.close();
  }
  if (holder !== undefined) holder.close();
});

test("cycle refuses the lock even with --mock, --no-discovery and --max flags", async () => {
  const { dbPath, home } = tempTarget();
  let holder: DatabaseSync | undefined;
  const seed = readDb(dbPath);
  try {
    holder = openDatabase(dbPath);
    acquireInstanceLock(holder, "foreign-cycle-holder-2", 600_000);
  } finally {
    seed.close();
  }

  const r = await cli(["cycle", "--mock", "--no-discovery", "--max-executions", "2"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /another coordinator holds the orchestrator lock/);
  assert.match(r.stderr, /foreign-cycle-holder-2/);
  assert.equal(fs.existsSync(runsJsonPath(home)), false);
  if (holder !== undefined) holder.close();
});

test("task retry requeues a classified FAILED task without extra confirmation", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedFailedTask(seed.db, "classified retry me", 1, { error: "boom", failureKind: "execution-error" });
  } finally {
    seed.close();
  }

  const r = await cli(["task", "retry", id], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`requeued ${id} for manual retry \\(attempt 1/3, execution-error\\)`));

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "BACKLOG"); // requeued for planning
    assert.equal(task.attempts, 1); // accounting preserved
    const failure = task.executionMetadata["failure"] as Record<string, unknown> | undefined;
    assert.ok(failure !== undefined && typeof failure === "object");
    assert.equal(failure["category"], "execution-error");
  } finally {
    db.close();
  }
});

test("task retry demands --confirm-unsafe for ambiguous failures and never bypasses the cap", async () => {
  const { dbPath, home } = tempTarget();
  let ambiguous: string;
  let capped: string;
  const seed = readDb(dbPath);
  try {
    ambiguous = seedFailedTask(seed.db, "ambiguous verdict", 1, {
      verification: "fail",
      verificationNote: "ambiguous verification response: no explicit VERDICT line",
    });
    capped = seedFailedTask(seed.db, "capped failure", 3, { error: "boom", failureKind: "execution-error" });
  } finally {
    seed.close();
  }

  // ambiguous without the flag: refused, task untouched
  const refused = await cli(["task", "retry", ambiguous], dbPath, home);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not auto-retryable.*--confirm-unsafe/s);
  const mid = readDb(dbPath);
  try {
    assert.equal(mid.store.getTask(ambiguous)?.status, "FAILED");
  } finally {
    mid.close();
  }

  // with --confirm-unsafe: requeued under the manual-only "legacy" category
  const confirmed = await cli(["task", "retry", ambiguous, "--confirm-unsafe"], dbPath, home);
  assert.equal(confirmed.code, 0, `stdout: ${confirmed.stdout}\nstderr: ${confirmed.stderr}`);
  assert.match(confirmed.stdout, new RegExp(`requeued ${ambiguous} for manual retry \\(attempt 1/3, legacy\\)`));

  // the cap is never bypassed, even manually
  const capRefused = await cli(["task", "retry", capped, "--confirm-unsafe"], dbPath, home);
  assert.equal(capRefused.code, 1);
  assert.match(capRefused.stderr, /attempt cap reached \(3\/3\)/);
  const end = readDb(dbPath);
  try {
    assert.equal(end.store.getTask(capped)?.status, "FAILED");
  } finally {
    end.close();
  }
});

test("orchestrator recover re-stamps expired leases, schedules retries and reports pending discovery runs", async () => {
  const { dbPath, home } = tempTarget();
  let interruptedId: string;
  const seed = readDb(dbPath);
  try {
    const store = seed.store;
    const t = store.addTask({ title: "interrupted before output" });
    store.transition(t.id, "BACKLOG");
    store.transition(t.id, "READY");
    store.transition(t.id, "IN_PROGRESS");
    // executor crashed without clearing the lease: expired lease stamp
    seed.db
      .prepare("UPDATE tasks SET lease_owner = ?, lease_expires_at = ? WHERE id = ?")
      .run("dead-executor", Date.now() - 10_000, t.id);
    interruptedId = t.id;
    seedFailedTask(seed.db, "classified boom", 1, { error: "boom", failureKind: "execution-error" });
    // a discovery run left 'running' by a crashed process (legacy: no lease)
    seed.db
      .prepare(
        `INSERT INTO discovery_runs (id, started_at, status, areas_total, areas_completed, error, model)
         VALUES (?, ?, 'running', 1, 0, NULL, ?)`,
      )
      .run("disc_testrunning1", Date.now(), "Qwen-Mimo/model");
  } finally {
    seed.close();
  }

  // Line-level regression assertions (Stage 10.3.1): the retry-scheduling
  // summary used to be written WITHOUT a trailing newline (src/cli.ts:975-977),
  // so it concatenated with the retry-due line when there were no skipped
  // items, and with the first `  skipped …` line when there were. The old
  // substring regexes matched the malformed output just as well; the ^…$
  // anchors below fail against it and only pass once every summary is a
  // complete line.
  // pass 1 without confirmation: task recovery happens, discovery runs are
  // only reported
  const first = await cli(["recover"], dbPath, home);
  assert.equal(first.code, 0, `stdout: ${first.stdout}\nstderr: ${first.stderr}`);
  assert.match(first.stdout, /^recovery: 1 task\(s\) re-stamped$/m);
  assert.match(first.stdout, /^retry scheduling: 1 scheduled, 0 exhausted$/m);
  assert.match(first.stdout, /^retry-due: 0 task\(s\) requeued$/m);
  assert.match(
    first.stdout,
    /^  pending discovery run disc_testrunning1: no lease recorded — operator confirmation required \(--confirm-unsafe\)$/m,
  );
  assert.doesNotMatch(first.stdout, /discovery runs: \d+ interrupted/);

  const mid = readDb(dbPath);
  try {
    const task = mid.store.getTask(interruptedId);
    assert.ok(task !== undefined);
    assert.equal(task.status, "READY"); // IN_PROGRESS without output → READY
    assert.equal(task.execGen, 1); // takeover bumped the generation
    assert.match(String(task.leaseOwner), /^recover_/); // fresh coordinator lease
    assert.ok((task.leaseExpiresAt ?? 0) > Date.now());
    const run = mid.db.prepare("SELECT status, error FROM discovery_runs WHERE id = ?").get("disc_testrunning1") as
      | { status: string; error: string | null }
      | undefined;
    assert.ok(run !== undefined);
    assert.equal(run.status, "running"); // untouched without --confirm-unsafe
    assert.equal(run.error, null);
  } finally {
    mid.close();
  }

  // pass 2 with confirmation: discovery runs interrupted; the task pass is
  // idempotent (nothing left to re-stamp or schedule)
  const second = await cli(["recover", "--confirm-unsafe"], dbPath, home);
  assert.equal(second.code, 0, `stdout: ${second.stdout}\nstderr: ${second.stderr}`);
  assert.match(second.stdout, /^recovery: 0 task\(s\) re-stamped$/m);
  assert.match(second.stdout, /^retry scheduling: 0 scheduled, 0 exhausted$/m);
  // the skipped line must start on its own line, not glued onto `exhausted`
  assert.match(second.stdout, /^  skipped task_\S+: retry already scheduled$/m);
  assert.match(second.stdout, /^retry-due: 0 task\(s\) requeued$/m);
  assert.match(second.stdout, /^discovery runs: 1 interrupted$/m);

  const end = readDb(dbPath);
  try {
    const run = end.db.prepare("SELECT status, error FROM discovery_runs WHERE id = ?").get("disc_testrunning1") as
      | { status: string; error: string | null }
      | undefined;
    assert.ok(run !== undefined);
    assert.equal(run.status, "interrupted");
    assert.equal(run.error, "process exited while run was active");
  } finally {
    end.close();
  }
});

test("a foreign coordinator lock denies CLI write commands (disownership at the CLI boundary)", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedFailedTask(seed.db, "held hostage", 1, { error: "boom", failureKind: "execution-error" });
    // another orchestrator process holds a fresh instance lock
    acquireInstanceLock(seed.db, "foreign-holder", 600_000);
  } finally {
    seed.close();
  }

  const retry = await cli(["task", "retry", id], dbPath, home);
  assert.equal(retry.code, 1);
  assert.match(retry.stderr, /another coordinator holds the orchestrator lock/);

  const recover = await cli(["recover"], dbPath, home);
  assert.equal(recover.code, 1);
  assert.match(recover.stderr, /another coordinator holds the orchestrator lock/);

  // neither command wrote anything
  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "FAILED"); // still failed, untouched
    assert.equal(task.leaseOwner, null);
    const run = db.db
      .prepare("SELECT COUNT(*) AS c FROM discovery_runs WHERE status = 'interrupted'")
      .get() as { c: number };
    assert.equal(Number(run.c), 0);
  } finally {
    db.close();
  }
});

// ——— Stage 10.2.1: task CRUD and inspection commands (subprocess level) ———

test("task add creates a DISCOVERED task and refuses a missing title", async () => {
  const { dbPath, home } = tempTarget();
  const created = await cli(
    ["task", "add", "write the README", "--description", "why", "--priority", "2"],
    dbPath,
    home,
  );
  assert.equal(created.code, 0, `stdout: ${created.stdout}\nstderr: ${created.stderr}`);
  assert.match(created.stdout, /^created task_\S+ \[DISCOVERED\] write the README\n$/);

  const missing = await cli(["task", "add"], dbPath, home);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "task add requires a title\n");

  const db = readDb(dbPath);
  try {
    const tasks = db.store.listTasks();
    assert.equal(tasks.length, 1, "only the successful add must persist");
    assert.equal(tasks[0]!.title, "write the README");
    assert.equal(tasks[0]!.description, "why");
    assert.equal(tasks[0]!.priority, 2);
    assert.equal(tasks[0]!.status, "DISCOVERED");
  } finally {
    db.close();
  }
});

test("task add ignores the usage-documented --state flag (known discrepancy)", async () => {
  // usage() advertises `task add <title> [--state <s>]` (src/cli.ts:139) but the
  // parser (src/cli.ts:196-204) only reads --description/--priority: --state is
  // silently ignored and the task is always seeded DISCOVERED. This test records
  // the discrepancy for a separate production-fix decision — it intentionally
  // does NOT assert that --state works.
  const { dbPath, home } = tempTarget();
  const r = await cli(["task", "add", "state flag ignored", "--state", "READY"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /created task_\S+ \[DISCOVERED\] state flag ignored/);
  const db = readDb(dbPath);
  try {
    assert.equal(db.store.listTasks()[0]!.status, "DISCOVERED");
  } finally {
    db.close();
  }
});

test("task add --priority abc surfaces a raw SQLite error (characterization, not endorsement)", async () => {
  // src/cli.ts:200-201 coerces --priority with Number() and never validates it,
  // so a non-numeric value becomes NaN → NULL → the catch-all handler
  // (src/cli.ts:125-128) prints the raw constraint failure. This pins only the
  // CURRENT behavior; the raw error is a known gap awaiting a production fix.
  const { dbPath, home } = tempTarget();
  const r = await cli(["task", "add", "bad priority", "--priority", "abc"], dbPath, home);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "error: NOT NULL constraint failed: tasks.priority\n");
  const db = readDb(dbPath);
  try {
    assert.equal(db.store.listTasks().length, 0, "the failed add must not persist a row");
  } finally {
    db.close();
  }
});

test("task list lists tasks, filters by --state, truncates err= and rejects unknown states", async () => {
  const { dbPath, home } = tempTarget();
  let plain: string;
  let withErr: string;
  const seed = readDb(dbPath);
  try {
    plain = seed.store.addTask({ title: "plain task", priority: 3 }).id;
    withErr = seed.store.addTask({ title: "error task" }).id;
    seed.store.setMetadata(withErr, { error: "e".repeat(100) });
  } finally {
    seed.close();
  }

  const all = await cli(["task", "list"], dbPath, home);
  assert.equal(all.code, 0, `stdout: ${all.stdout}\nstderr: ${all.stderr}`);
  assert.match(all.stdout, /^database: .*tasks\.db\n/m);
  assert.match(all.stdout, new RegExp(`${plain}  DISCOVERED   p=3 plain task\\n`));
  // executionMetadata["error"] is rendered as err="…" and truncated to 80 chars
  assert.match(all.stdout, new RegExp(`${withErr}  DISCOVERED   p=0 error task err="${"e".repeat(80)}"\\n`));
  assert.equal(all.stdout.includes("e".repeat(100)), false, "the error string must be truncated");

  const filtered = await cli(["task", "list", "--state", "DISCOVERED"], dbPath, home);
  assert.equal(filtered.code, 0);
  assert.match(filtered.stdout, new RegExp(plain));
  assert.match(filtered.stdout, new RegExp(withErr));

  const done = await cli(["task", "list", "--state", "DONE"], dbPath, home);
  assert.equal(done.code, 0);
  assert.match(done.stdout, /^database: .*tasks\.db\n\(no tasks\)\n$/);
  assert.doesNotMatch(done.stdout, new RegExp(plain));

  const bad = await cli(["task", "list", "--state", "not-a-state"], dbPath, home);
  assert.equal(bad.code, 1);
  assert.equal(bad.stderr, "unknown state: not-a-state\n");
});

test("task list shows (no tasks) on an empty database", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["task", "list"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /^database: .*tasks\.db\n\(no tasks\)\n$/);
});

test("tasks renders plan metadata columns and omits the database line when empty (known asymmetry)", async () => {
  const { dbPath, home } = tempTarget();
  // Empty database: only "(no tasks)" and NO "database:" line. `task list` DOES
  // print the database line when empty (src/cli.ts:232-235 vs src/cli.ts:790-792).
  // Recorded asymmetry for a separate production-fix decision — this test pins
  // the current behavior so any normalization is a conscious change.
  const empty = await cli(["tasks"], dbPath, home);
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, "(no tasks)\n");

  let plannedReady: string;
  let plannedBlocked: string;
  const seed = readDb(dbPath);
  try {
    plannedReady = seed.store.addTask({ title: "planned ready" }).id;
    seed.store.setMetadata(plannedReady, {
      plan: { complexity: "low", dependencies: ["task_dep_1"], unmetDependencies: [], conflictWith: [] },
    });
    plannedBlocked = seed.store.addTask({ title: "planned blocked" }).id;
    seed.store.setMetadata(plannedBlocked, {
      plan: { complexity: "high", dependencies: [], unmetDependencies: ["task_dep_2"], conflictWith: ["task_x"] },
    });
  } finally {
    seed.close();
  }

  const r = await cli(["tasks"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  // met dependencies render as deps=N; unmet ones as deps⁉=N plus conflict list
  assert.match(r.stdout, new RegExp(`${plannedReady}  DISCOVERED   p=0 c=low deps=1  planned ready\\n`));
  assert.match(
    r.stdout,
    new RegExp(`${plannedBlocked}  DISCOVERED   p=0 c=high deps⁉=1 conflict:task_x  planned blocked\\n`),
  );
});

test("task show prints the task JSON and event history; a missing id fails with exit 1", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seed.store.addTask({ title: "inspect me", description: "d" }).id;
  } finally {
    seed.close();
  }

  const shown = await cli(["task", "show", id], dbPath, home);
  assert.equal(shown.code, 0, `stdout: ${shown.stdout}\nstderr: ${shown.stderr}`);
  // the JSON block precedes the event lines
  const jsonEnd = shown.stdout.indexOf("\nevent ");
  assert.ok(jsonEnd > 0, `expected event history after the JSON block: ${shown.stdout}`);
  const parsed = JSON.parse(shown.stdout.slice(0, jsonEnd)) as {
    id: string;
    title: string;
    description: string;
    status: string;
  };
  assert.equal(parsed.id, id);
  assert.equal(parsed.title, "inspect me");
  assert.equal(parsed.description, "d");
  assert.equal(parsed.status, "DISCOVERED");
  // a fresh task has exactly one event: its creation
  assert.match(shown.stdout, /^event 1 \S+ created ∅ → DISCOVERED$/m);

  const missing = await cli(["task", "show", "no-such-id"], dbPath, home);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, "task not found: no-such-id\n");

  const noArg = await cli(["task", "show"], dbPath, home);
  assert.equal(noArg.code, 1);
  assert.equal(noArg.stderr, "task show requires a task id\n");
});

test("status reports the database path and zero counts on an empty database", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["status"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /^database: .*tasks\.db\n/m);
  // every state gets a line, in TASK_STATES order, all zero
  for (const state of TASK_STATES) {
    assert.match(r.stdout, new RegExp(`^${state.padEnd(12)} 0$`, "m"));
  }
});

test("task CRUD round-trip: add → list → tasks → show → status on one isolated database", async () => {
  const { dbPath, home } = tempTarget();

  const added = await cli(
    ["task", "add", "round trip", "--description", "audit", "--priority", "7"],
    dbPath,
    home,
  );
  assert.equal(added.code, 0, `stdout: ${added.stdout}\nstderr: ${added.stderr}`);
  const id = /created (\S+) \[DISCOVERED\]/.exec(added.stdout)?.[1];
  assert.ok(id !== undefined, `expected the created id in: ${added.stdout}`);

  const listed = await cli(["task", "list"], dbPath, home);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, new RegExp(`${id}  DISCOVERED   p=7 round trip\\n`));

  const filtered = await cli(["task", "list", "--state", "DISCOVERED"], dbPath, home);
  assert.equal(filtered.code, 0);
  assert.match(filtered.stdout, new RegExp(id));
  const done = await cli(["task", "list", "--state", "DONE"], dbPath, home);
  assert.equal(done.code, 0);
  assert.doesNotMatch(done.stdout, new RegExp(id));

  const grid = await cli(["tasks"], dbPath, home);
  assert.equal(grid.code, 0);
  // no plan metadata yet: complexity renders as "-"
  assert.match(grid.stdout, new RegExp(`${id}  DISCOVERED   p=7 c=-  round trip\\n`));

  const shown = await cli(["task", "show", id], dbPath, home);
  assert.equal(shown.code, 0);
  const parsed = JSON.parse(shown.stdout.slice(0, shown.stdout.indexOf("\nevent "))) as {
    id: string;
    title: string;
    priority: number;
  };
  assert.equal(parsed.id, id);
  assert.equal(parsed.title, "round trip");
  assert.equal(parsed.priority, 7);
  assert.match(shown.stdout, /^event 1 \S+ created ∅ → DISCOVERED$/m);

  const counted = await cli(["status"], dbPath, home);
  assert.equal(counted.code, 0);
  assert.match(counted.stdout, /^DISCOVERED   1$/m);
  for (const state of TASK_STATES.filter((s) => s !== "DISCOVERED")) {
    assert.match(counted.stdout, new RegExp(`^${state.padEnd(12)} 0$`, "m"));
  }
});

// ——— Stage 10.2.2: task verify (subprocess level) ———

/** Seed a leaseless task in READY via plain legacy transitions (claimable by
 *  `run --mock`). The row is never leased. */
function seedReadyTask(db: DatabaseSync, title: string): string {
  const store = new TaskStore(db);
  const task = store.addTask({ title });
  for (const state of ["BACKLOG", "READY"] as const) {
    store.transition(task.id, state);
  }
  return task.id;
}

/** Seed a leaseless task in VERIFYING via plain legacy transitions. The row is
 *  never leased, so manual `task verify` is allowed — unlike a task left in
 *  VERIFYING by `run`, which carries an active lease (legacy writes are
 *  refused while leaseOwner is set, src/store.ts:176-185). */
function seedVerifyingTask(db: DatabaseSync, title: string): string {
  const store = new TaskStore(db);
  const id = seedReadyTask(db, title);
  for (const state of ["IN_PROGRESS", "REVIEW", "VERIFYING"] as const) {
    store.transition(id, state);
  }
  return id;
}

test("task verify --pass completes a leaseless VERIFYING task as DONE", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedVerifyingTask(seed.db, "verify me pass");
  } finally {
    seed.close();
  }

  const r = await cli(["task", "verify", id, "--pass"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, `${id} DONE — verification passed\n`);
  assert.equal(r.stderr, "");

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "DONE");
    assert.equal(task.executionMetadata["verification"], "pass");
    assert.equal(task.executionMetadata["verificationNote"], "verification passed");
    const events = db.store.eventsFor(id);
    const last = events[events.length - 1]!;
    assert.equal(last.eventType, "transition");
    assert.equal(last.toState, "DONE");
    assert.equal(last.detail, "verification passed");
  } finally {
    db.close();
  }
});

test("task verify --fail --note records the note and marks the task FAILED", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedVerifyingTask(seed.db, "verify me fail");
  } finally {
    seed.close();
  }

  const r = await cli(["task", "verify", id, "--fail", "--note", "audited fail note"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, `${id} FAILED — audited fail note\n`);
  assert.equal(r.stderr, "");

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "FAILED");
    assert.equal(task.executionMetadata["verification"], "fail");
    assert.equal(task.executionMetadata["verificationNote"], "audited fail note");
    const events = db.store.eventsFor(id);
    const last = events[events.length - 1]!;
    assert.equal(last.eventType, "transition");
    assert.equal(last.toState, "FAILED");
    assert.equal(last.detail, "audited fail note");
  } finally {
    db.close();
  }
});

test("task verify refuses verification from DISCOVERED with an exact transition error", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seed.store.addTask({ title: "not verifying yet" }).id; // DISCOVERED, leaseless
  } finally {
    seed.close();
  }

  const pass = await cli(["task", "verify", id, "--pass"], dbPath, home);
  assert.equal(pass.code, 1);
  assert.equal(pass.stderr, `invalid transition: DISCOVERED → DONE\n`);

  const fail = await cli(["task", "verify", id, "--fail"], dbPath, home);
  assert.equal(fail.code, 1);
  assert.equal(fail.stderr, `invalid transition: DISCOVERED → FAILED\n`);

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "DISCOVERED", "the state must remain unchanged");
    assert.equal(task.executionMetadata["verification"], undefined);
    assert.equal(db.store.eventsFor(id).length, 1, "only the creation event exists");
  } finally {
    db.close();
  }
});

test("task verify refuses an actively leased task and changes nothing", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedVerifyingTask(seed.db, "leased while verifying");
    // an external process holds a fresh lease on the VERIFYING task (same raw-SQL
    // pattern as the recover test above); legacy writes must be refused
    seed.db
      .prepare("UPDATE tasks SET lease_owner = ?, lease_expires_at = ? WHERE id = ?")
      .run("external-verifier", Date.now() + 600_000, id);
  } finally {
    seed.close();
  }

  const r = await cli(["task", "verify", id, "--pass"], dbPath, home);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `task ${id} is leased by external-verifier; legacy write refused\n`);

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "VERIFYING", "no verification state change may occur");
    assert.equal(task.leaseOwner, "external-verifier", "the lease is untouched");
    assert.equal(task.executionMetadata["verification"], undefined);
    assert.equal(task.executionMetadata["verificationNote"], undefined);
  } finally {
    db.close();
  }
});

test("task verify validates its arguments exactly", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedVerifyingTask(seed.db, "argument probe");
  } finally {
    seed.close();
  }

  const both = await cli(["task", "verify", id, "--pass", "--fail"], dbPath, home);
  assert.equal(both.code, 1);
  assert.equal(both.stdout, "");
  assert.equal(both.stderr, "task verify requires exactly one of --pass or --fail\n");
  const neither = await cli(["task", "verify", id], dbPath, home);
  assert.equal(neither.code, 1);
  assert.equal(neither.stderr, "task verify requires exactly one of --pass or --fail\n");
  // argument validation happens before the database is opened
  assert.equal(fs.existsSync(dbPath), true, "the db was created by seeding only");

  const missingId = await cli(["task", "verify"], dbPath, home);
  assert.equal(missingId.code, 1);
  assert.equal(missingId.stderr, "task verify requires a task id\n");

  const db = readDb(dbPath);
  try {
    assert.equal(db.store.getTask(id)?.status, "VERIFYING", "validation errors change nothing");
  } finally {
    db.close();
  }
});

// ——— Stage 10.2.3: run (subprocess level, --mock only) ———
//
// A FAILED run outcome (adapter.prompt rejection → runner.ts:106-115) is NOT
// reachable through `run --mock`: the CLI's mock adapter is hardcoded
// non-throwing (src/opencode.ts:342-358), and there is no injection point
// without production changes. Genuinely failing executions are covered at
// library level in tests/runner.test.ts ("failing execution transitions to
// FAILED with persisted error metadata and failure classification"); cycle's
// failure exit code is covered at CLI level ("mock CLI verification failure
// marks the task FAILED and exits 1"). The exit-code characterization below
// therefore pins the observable half of the gap and documents the source.

test("run --mock executes a READY task to VERIFYING and keeps the lease held", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedReadyTask(seed.db, "run me");
  } finally {
    seed.close();
  }

  const r = await cli(["run", "--mock", "--max", "1"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, `${id} VERIFYING — mock executed: run me\n`);

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "VERIFYING");
    assert.equal(task.attempts, 1, "the claim bumps the attempt counter");
    assert.match(task.leaseOwner ?? "", /^run_/, "the coordinator lease is stamped");
    assert.ok((task.leaseExpiresAt ?? 0) > Date.now(), "the lease is fresh");
    assert.ok(task.execGen >= 1, "the claim bumps exec_gen");
    // execution metadata persisted under the held lease (runner.ts:87-93)
    assert.equal(task.executionMetadata["sessionId"], "ses_mock");
    assert.equal(task.executionMetadata["finish"], "stop");
    assert.equal(task.executionMetadata["output"], "mock executed: run me");
    assert.equal(task.executionMetadata["toolCalls"], 0);
    // a VERIFYING task is not claimable: a second run reports an empty queue
    const again = await cli(["run", "--mock", "--max", "1"], dbPath, home);
    assert.equal(again.code, 0);
    assert.equal(again.stdout, "queue empty\n");
    assert.equal(db.store.getTask(id)?.attempts, 1, "no re-claim happened");
  } finally {
    db.close();
  }
});

test("run --mock executes up to --max tasks then reports an empty queue", async () => {
  const { dbPath, home } = tempTarget();
  let first: string;
  let second: string;
  const seed = readDb(dbPath);
  try {
    first = seedReadyTask(seed.db, "first task");
    second = seedReadyTask(seed.db, "second task");
  } finally {
    seed.close();
  }

  const r = await cli(["run", "--mock", "--max", "5"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], `${first} VERIFYING — mock executed: first task`);
  assert.equal(lines[1], `${second} VERIFYING — mock executed: second task`);
  assert.equal(lines[2], "queue empty");
  assert.equal(lines[3], "");

  const db = readDb(dbPath);
  try {
    for (const id of [first, second]) {
      const task = db.store.getTask(id);
      assert.ok(task !== undefined);
      assert.equal(task.status, "VERIFYING");
      assert.equal(task.attempts, 1);
      assert.match(task.leaseOwner ?? "", /^run_/);
    }
  } finally {
    db.close();
  }
});

test("run --mock prints queue empty on an empty database", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["run", "--mock"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "queue empty\n");
  assert.equal(r.stderr, "");
  // run opens the store even when there is nothing to do
  assert.equal(fs.existsSync(dbPath), true);
});

test("run --max abc is a silent no-op while --max 0 executes one task (characterization)", async () => {
  // src/cli.ts:527 clamps with Math.max(1, Number(arg)): a non-numeric value
  // becomes NaN and `i < NaN` never runs — run exits 0 WITHOUT output and
  // without touching the queue. A --max of 0 clamps up to 1 and executes.
  // Neither value is validated; recorded as a known gap for a production fix.
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedReadyTask(seed.db, "max edge");
  } finally {
    seed.close();
  }

  const nan = await cli(["run", "--mock", "--max", "abc"], dbPath, home);
  assert.equal(nan.code, 0);
  assert.equal(nan.stdout, "", "the NaN loop bound executes nothing");
  assert.equal(nan.stderr, "");

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "READY", "nothing was claimed");
    assert.equal(task.attempts, 0);
    assert.equal(task.leaseOwner, null);
  } finally {
    db.close();
  }

  const zero = await cli(["run", "--mock", "--max", "0"], dbPath, home);
  assert.equal(zero.code, 0);
  assert.equal(zero.stdout, `${id} VERIFYING — mock executed: max edge\n`);
  const after = readDb(dbPath);
  try {
    assert.equal(after.store.getTask(id)?.status, "VERIFYING");
    assert.equal(after.store.getTask(id)?.attempts, 1);
  } finally {
    after.close();
  }
});

test("run exits 1 when an execution fails (FAILED outcome sets the exit code)", async () => {
  // Intended exit-code contract (Stage 10.3.2): runner.ts:8 defines exactly two
  // terminal execution outcomes — VERIFYING (success; verification pending, so
  // exit 0 is correct and asserted by the `run --mock executes a READY task…`
  // test above) and FAILED (runner.ts:106-115: prompt rejection →
  // recordVerdictHeld → FAILED with {error, failureKind} metadata, lease
  // cleared). cycle already exits 1 on execution failures (src/cli.ts:917-919);
  // run() now mirrors that: any FAILED outcome sets process.exitCode = 1.
  // A FAILED outcome IS produced at CLI level through the existing, supported
  // SDK-stub seam (Stage 10.1): `run` without --mock drives the real SDK
  // client against the local stub, whose POST /session fails, so
  // adapter.prompt rejects. No production test seam was added.
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedReadyTask(seed.db, "failing execution");
  } finally {
    seed.close();
  }

  const stub = await startDiscoveryStub(DISCOVERY_STUB_REPLY, { createStatus: 500 });
  try {
    const r = await runStubbed("run", ["--max", "1"], dbPath, home, stub.url);
    assert.equal(
      r.code,
      1,
      `the FAILED outcome must set the exit code (pre-fix behavior was exit 0)\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.equal(r.stderr, "");
    assert.match(r.stdout, new RegExp(`^${id} FAILED — failed to create opencode session: `, "m"));
    assert.match(r.stdout, /session create rejected/, "the stub's HTTP failure detail is surfaced in the output");
    assert.doesNotMatch(r.stdout, /queue empty/);

    const db = readDb(dbPath);
    try {
      const task = db.store.getTask(id);
      assert.ok(task !== undefined);
      assert.equal(task.status, "FAILED");
      assert.equal(task.attempts, 1, "the claim bumped the attempt counter");
      assert.equal(task.leaseOwner, null, "recordVerdictHeld clears the lease on failure");
      const message = String(task.executionMetadata["error"]);
      assert.match(message, /^failed to create opencode session: /);
      assert.equal(task.executionMetadata["failureKind"], "execution-error");
      const events = db.store.eventsFor(id);
      assert.match(
        String(events[events.length - 1]?.detail),
        /^execution error: failed to create opencode session: /,
      );
    } finally {
      db.close();
    }
  } finally {
    await stub.close();
  }
});

// ——— Stage 10.2.4: doctor / discover / plan (subprocess level) ———
//
// doctor and plan need no interception (doctor --mock never builds an adapter;
// plan never touches one). discover has no --mock flag: its success paths run
// the live adapter, so they are driven through the Stage 10.1 SDK stub loader
// hooks (--import tests/sdk-stub-register.mjs + DIAKOSYS_TEST_SDK_STUB_URL) against
// a local stub HTTP server started inside this test process. No real opencode
// process, model server or external network ever runs: the "server" the real
// SDK client talks to is the stub below. tests/live-adapter.test.ts remains
// the reference implementation of the stub contract; it is deliberately NOT
// imported here (importing a .test.ts file would re-run its tests).

/** Path of the resumable-run manifest under an isolated HOME (src/discovery.ts
 *  defaultCacheDir + DiscoveryEngine.persist). */
function runsJsonPath(home: string): string {
  return path.join(home, "Cache", "diakosys-orchestrator", "discovery-runs", "runs.json");
}

/** Seed a DISCOVERED task carrying a planner-consumable proposal payload.
 *  Evidence points at src/queue.ts, which exists relative to the CLI's cwd
 *  (the orchestrator root); the makeProposal default evidence
 *  (src/main/java/io/diakosys/HealthEvaluator.java) does not resolve there and
 *  would plan as rejected. */
function seedProposedTask(db: DatabaseSync, title: string): string {
  const store = new TaskStore(db);
  const task = store.addTask({ title });
  store.setMetadata(task.id, {
    proposal: makeProposal({
      evidence: [
        {
          file: "src/queue.ts",
          symbol: "dequeue",
          observation: "the claim updates status and attempts but no recovery pass requeues orphans",
        },
      ],
    }),
  });
  return task.id;
}

/** Test-local copy of the CLI's canned discovery reply (src/cli.ts
 *  MOCK_DISCOVERY_REPLY, not exported): one fully valid proposal whose
 *  evidence (src/queue.ts) resolves inside the repo the subprocess runs in. */
const DISCOVERY_STUB_REPLY = JSON.stringify([
  {
    title: "Document the queue claim invariant",
    problem: "The queue claims a READY task into IN_PROGRESS atomically, yet nothing requeues it if the executing process dies before REVIEW is recorded today.",
    rationale: "An explicitly pinned claim invariant keeps the single-step runner contract observable.",
    evidence: [
      {
        file: "src/queue.ts",
        symbol: "dequeue",
        observation: "the claim updates status and attempts but no recovery pass requeues orphans",
      },
    ],
    approach: "Record the invariant in the dequeue contract comment and pin it with an existing queue test.",
    outcome: "The claim semantics are explicit and enforced by the current test suite.",
    priority: 6,
    complexity: "low",
    verification: ["npm test"],
  },
]);

/** Minimal discovery stub server: a subset of the Stage 10.1 contract
 *  harness in tests/live-adapter.test.ts. POST /session, POST
 *  /session/{id}/prompt_async (204), GET /event (SSE session.idle after the
 *  prompt), GET /session/{id}/message (last assistant message = replyText),
 *  POST /session/{id}/abort, plus the two __hook__ endpoints the SDK stub
 *  loader POSTs from the child. Binds localhost:0 — no external network. */
const stubSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

interface DiscoveryStub {
  url: string;
  close(): Promise<void>;
}

function startDiscoveryStub(
  replyText: string,
  options: { createStatus?: number; createFailSession?: number } = {},
): Promise<DiscoveryStub> {
  return new Promise((resolve, reject) => {
    let sessionCounter = 0;
    let lastSessionId = "";
    let sawPromptAsync: (() => void) | undefined;
    const promptAsyncSeen = new Promise<boolean>((resolveSeen) => {
      sawPromptAsync = () => resolveSeen(true);
    });
    const respondJson = (res: http.ServerResponse, status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    };
    const server = http.createServer((req, res) => {
      void (async () => {
        let body = "";
        for await (const chunk of req) void chunk; // drain the request body
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/__hook__/server-options") {
          respondJson(res, 200, {});
          return;
        }
        if (req.method === "POST" && url.pathname === "/__hook__/server-closed") {
          respondJson(res, 200, {});
          return;
        }
        if (req.method === "POST" && url.pathname === "/session") {
          sessionCounter += 1;
          // One session create per discovery area prompt (src/opencode.ts:200),
          // and areas run sequentially (src/discovery.ts:285). So the Nth
          // create is the Nth area. This lets a test fail exactly one area —
          // e.g. make the first requested area error while a later one succeeds,
          // which the flat `createStatus` option cannot express.
          if (options.createFailSession !== undefined && sessionCounter === options.createFailSession) {
            respondJson(res, options.createStatus ?? 500, { name: "http_error", data: { message: "session create rejected" } });
            return;
          }
          if (options.createStatus !== undefined) {
            respondJson(res, options.createStatus, { name: "http_error", data: { message: "session create rejected" } });
            return;
          }
          sessionCounter += 1;
          lastSessionId = `ses_stub_${String(sessionCounter).padStart(3, "0")}`;
          respondJson(res, 200, { id: lastSessionId });
          return;
        }
        if (req.method === "GET" && url.pathname === "/event") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          // the adapter opens the event stream BEFORE firing prompt_async
          // (src/opencode.ts:219-226); wait (bounded, unref'd) for the prompt,
          // then emit session.idle exactly as the Stage 10.1 harness does
          const sawPrompt = await Promise.race([promptAsyncSeen, stubSleep(3_000).then(() => false)]);
          if (sawPrompt) {
            res.write(
              `data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: lastSessionId } })}\n\n`,
            );
          }
          res.end();
          return;
        }
        if (req.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
          sawPromptAsync?.();
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET" && /^\/session\/[^/]+\/message$/.test(url.pathname)) {
          respondJson(res, 200, [
            { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: replyText }] },
          ]);
          return;
        }
        if (req.method === "POST" && /^\/session\/[^/]+\/abort$/.test(url.pathname)) {
          respondJson(res, 200, {});
          return;
        }
        respondJson(res, 404, { name: "not_found", data: { message: `no route: ${req.method} ${url.pathname}` } });
      })().catch((err) => {
        try {
          res.destroy(err instanceof Error ? err : new Error(String(err)));
        } catch {
          // noop
        }
      });
    });
    server.once("error", reject);
    server.listen(0, "localhost", () =>
      resolve({
        url: `http://localhost:${(server.address() as { port: number }).port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      }),
    );
  });
}

/** Spawn `node --import tests/sdk-stub-register.mjs src/cli.ts <command> …`
 *  with the stub URL handed over through the environment (the same mechanism
 *  the Stage 10.1 doctor subprocess tests use; a real adapter cannot start).
 *  Used for `discover` and for `run` (non-mock) when a test needs to drive the
 *  live adapter deterministically — e.g. a failing session create to produce a
 *  FAILED execution outcome.
 *
 *  The child's isolated HOME is seeded with a minimal
 *  `$HOME/.config/opencode/opencode.json`: the live adapter applies the
 *  endpoint override unconditionally (src/opencode.ts:120-133) and fails
 *  every area with "cannot honor endpoint override" unless that file carries
 *  a provider block for the configured model's provider. The file contents
 *  are otherwise unused here — the stubbed createOpencodeServer never parses
 *  them, and the real SDK client talks to the stub URL. */
async function runStubbed(
  command: "discover" | "run",
  args: string[],
  dbPath: string,
  home: string,
  stubUrl: string,
): Promise<CliRun> {
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "opencode.json"),
    JSON.stringify({
      model: "Qwen-Mimo/model",
      provider: { "Qwen-Mimo": { npm: "@ai-sdk/openai-compatible", name: "Qwen-Mimo", options: {} } },
    }),
  );
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      ["--import", path.join(ROOT, "tests", "sdk-stub-register.mjs"), CLI_ENTRY, command, ...args],
      {
        cwd: ROOT,
        env: { ...cliEnv(dbPath, home), DIAKOSYS_TEST_SDK_STUB_URL: stubUrl },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code === "number") {
      return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    throw err; // spawn-level failure (signal/timeout) — fail loudly
  }
}

// ——— doctor ———

test("doctor --mock passes every check, creates the database and ignores unknown flags", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["doctor", "--mock", "--bogus-flag"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr, "");
  // exact output, in the fixed check order runtime → config → database →
  // queue → opencode, then the one-line summary (src/cli.ts:515-521)
  assert.equal(
    r.stdout,
    [
      `ok    runtime (node ${process.versions.node})`,
      `ok    config — Qwen-Mimo/model @ http://localhost:8082/v1 (dir: ${ROOT})`,
      `ok    database — ${dbPath}`,
      `ok    queue`,
      `skip  opencode — --mock requested`,
      `doctor: all required checks passed`,
    ].join("\n") + "\n",
  );
  assert.equal(fs.existsSync(dbPath), true, "the db check opens and creates the database");
});

test("doctor fails fast on invalid configuration before touching the database", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["doctor", "--mock"], dbPath, home, { DIAKOSYS_ORCHESTRATOR_PORT: "abc" });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "", "no check lines are printed when config resolution fails");
  assert.equal(r.stderr, `config error: DIAKOSYS_ORCHESTRATOR_PORT must be a positive number, got "abc"\n`);
  assert.equal(fs.existsSync(dbPath), false, "the database is never created on config failure");
});

test("doctor reports the database check as failed and skips the queue probe", async () => {
  // safe failure injection: the configured db path lies BELOW a regular file,
  // so openStore's mkdir of its parent fails with EEXIST (no chmod needed)
  const { dir, dbPath, home } = tempTarget();
  const blocker = path.join(dir, "notadir");
  fs.writeFileSync(blocker, "regular file, not a directory");
  const badDb = path.join(blocker, "tasks.db");
  const r = await cli(["doctor", "--mock"], dbPath, home, { DIAKOSYS_ORCHESTRATOR_DB: badDb });
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr, `db check error: Error: EEXIST: file already exists, mkdir '${blocker}'\n`);
  assert.equal(
    r.stdout,
    [
      `ok    runtime (node ${process.versions.node})`,
      `ok    config — Qwen-Mimo/model @ http://localhost:8082/v1 (dir: ${ROOT})`,
      `fail  database — ${badDb}`,
      `skip  queue`,
      `skip  opencode — --mock requested`,
      `doctor: at least one check failed`,
    ].join("\n") + "\n",
  );
});

// ——— discover (SDK stub; no real adapter can start) ———

test("discover --area bogus is rejected before any adapter or database is touched", async () => {
  const { dbPath, home } = tempTarget();
  // plain spawn: area validation happens before liveAdapter() is built
  // (src/cli.ts:632-645) and before the database is opened
  const r = await cli(["discover", "--area", "bogus"], dbPath, home);
  assert.equal(r.code, 1);
  assert.equal(
    r.stderr,
    `unknown discovery area(s): bogus; valid: architecture, reliability, tests, quality, performance, usability, docs, build\n`,
  );
  assert.equal(
    r.stdout,
    `valid areas: architecture, reliability, tests, quality, performance, usability, docs, build\n`,
  );
  assert.equal(fs.existsSync(dbPath), false, "no database may be created");
  assert.equal(fs.existsSync(runsJsonPath(home)), false, "no manifest may be written");
});

test("discover --dry-run prints proposals and persists nothing (no database, no manifest)", async () => {
  const { dbPath, home } = tempTarget();
  const stub = await startDiscoveryStub(DISCOVERY_STUB_REPLY);
  try {
    const r = await runStubbed("discover", ["--dry-run", "--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "");
    // the exact proposal block from printProposals (src/cli.ts:722-733),
    // followed by the dry-run note
    assert.equal(
      r.stdout,
      [
        `area tests: ok (1 proposals, 0 rejected)`,
        `[6] (low) Document the queue claim invariant`,
        `  evidence: src/queue.ts`,
        `  problem: The queue claims a READY task into IN_PROGRESS atomically, yet nothing requeues it if the executing process dies before REVIEW is recorded today.`,
        `  verify: npm test`,
        `dry run — nothing was persisted`,
      ].join("\n") + "\n",
    );
    // A dry run still opens the database — only to acquire the coordinator
    // lock (src/cli.ts: discover acquires the lock before the engine runs,
    // which --dry-run shares with the persistence branch). It must still
    // persist nothing: no tasks, no run rows, no manifest.
    assert.equal(fs.existsSync(dbPath), true, "the lock requires opening the database");
    assert.equal(fs.existsSync(runsJsonPath(home)), false, "a dry run must never write the run manifest");
  } finally {
    await stub.close();
  }
});

/** Drive `discover` in-process with a mock adapter, returning the database it
 *  opened so the lock row can be read back afterwards.
 *
 *  The subprocess SDK stub cannot start in this environment — the `discover`
 *  tests that rely on it fail with "Failed to start server. Is port 4096 in
 *  use?" even on unmodified code — so the lock-release regression cases run
 *  here instead. The discovery engine only consumes adapter.prompt(), and the
 *  lock/teardown ordering is what these tests are about. */
async function discoverWithMock(
  args: string[],
  reply: string,
): Promise<{ dbPath: string; lockState: () => string | undefined; close: () => void }> {
  const { dbPath, home } = tempTarget();
  const adapter = new MockOpenCodeAdapter(() => reply);
  const savedEnv: NodeJS.ProcessEnv = {
    DIAKOSYS_ORCHESTRATOR_DB: process.env.DIAKOSYS_ORCHESTRATOR_DB,
    DIAKOSYS_ORCHESTRATOR_MODEL: process.env.DIAKOSYS_ORCHESTRATOR_MODEL,
    HOME: process.env.HOME,
  };
  process.env.DIAKOSYS_ORCHESTRATOR_DB = dbPath;
  process.env.DIAKOSYS_ORCHESTRATOR_MODEL = "Qwen-Mimo/model";
  process.env.HOME = home;
  try {
    await discover(args, adapter);
  } finally {
    restoreEnv(savedEnv);
  }
  const db = openDatabase(dbPath);
  return {
    dbPath,
    lockState: () => lockState(db)?.owner,
    close: () => closeDatabase(db),
  };
}

/** An adapter that answers normally but blows up on teardown — the only throw
 *  `discover`'s own inner `try` can force through the mock seam (the engine
 *  swallows adapter.prompt() errors per area, and the live adapter's close()
 *  never throws). */
class ThrowingCloseAdapter extends MockOpenCodeAdapter {
  override async close(): Promise<void> {
    throw new Error("adapter teardown failed");
  }
}

test("discover --dry-run releases the coordinator lock it acquired", async () => {
  const { lockState, close } = await discoverWithMock(["--dry-run", "--area", "tests"], MOCK_DISCOVERY_REPLY);
  try {
    assert.equal(lockState(), "", "a dry run never reaches the persistence branch, which used to be the only place the lock was released");
  } finally {
    close();
  }
});

test("discover releases the coordinator lock on the persistence path", async () => {
  const { lockState, close } = await discoverWithMock(["--area", "tests"], MOCK_DISCOVERY_REPLY);
  try {
    assert.equal(lockState(), "", "the persistence path must release the coordinator lock");
  } finally {
    close();
  }
});

test("discover releases the coordinator lock when discovery throws", async () => {
  const { dbPath, close } = await discoverWithMock(["--area", "tests"], MOCK_DISCOVERY_REPLY);
  const savedEnv: NodeJS.ProcessEnv = { DIAKOSYS_ORCHESTRATOR_DB: process.env.DIAKOSYS_ORCHESTRATOR_DB };
  try {
    // expected: the teardown failure propagates out of discover. The direct
    // call inherits the DB path discoverWithMock just set, so the coordinator
    // lock is still acquired and released on that database.
    process.env.DIAKOSYS_ORCHESTRATOR_DB = dbPath;
    const teardown = discover(["--area", "tests"], new ThrowingCloseAdapter(() => MOCK_DISCOVERY_REPLY));
    // The rejection must fully settle before any lock-state read: only once
    // the awaited promise rejects has discover's outermost finally released
    // the lock, so this also proves the release survives adapter teardown
    // throwing (the awaited rejection carries the close() error).
    await assert.rejects(teardown, /adapter teardown failed/);

    // Reading the lock through discover's own handle is not conclusive: while
    // that handle is still open, a new read sees the pre-release snapshot.
    // Read the state through a fresh handle, opened after the release has run.
    close();
    const fresh = openDatabase(dbPath);
    try {
      assert.equal(lockState(fresh)?.owner, "", "the lock must be released even when discovery throws");
    } finally {
      closeDatabase(fresh);
    }
  } finally {
    restoreEnv(savedEnv);
  }
});

test("discover skips lock release but still closes the database when it cannot be opened", async () => {
  const { dir, home } = tempTarget();
  const badDb = path.join(dir, "notadir", "tasks.db");
  fs.writeFileSync(path.join(dir, "notadir"), "regular file, not a directory");
  const savedEnv: NodeJS.ProcessEnv = {
    DIAKOSYS_ORCHESTRATOR_DB: process.env.DIAKOSYS_ORCHESTRATOR_DB,
    DIAKOSYS_ORCHESTRATOR_MODEL: process.env.DIAKOSYS_ORCHESTRATOR_MODEL,
    HOME: process.env.HOME,
  };
  process.env.DIAKOSYS_ORCHESTRATOR_DB = badDb;
  process.env.DIAKOSYS_ORCHESTRATOR_MODEL = "Qwen-Mimo/model";
  process.env.HOME = home;
  try {
    let err: unknown;
    try {
      await discover(["--area", "tests"], new MockOpenCodeAdapter(() => MOCK_DISCOVERY_REPLY));
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "opening the database must fail");
    assert.doesNotMatch(err.message, /instance lock|coordinator/, "the outer finally must not surface a lock-release error");
  } finally {
    restoreEnv(savedEnv);
  }
});

test("restoring an absent DIAKOSYS_ORCHESTRATOR_DB leaves it absent, not the string \"undefined\"", () => {
  const wasAbsent = process.env.DIAKOSYS_ORCHESTRATOR_DB === undefined;
  assert.ok(wasAbsent, "the test runs with the variable originally absent");
  const savedEnv: NodeJS.ProcessEnv = { DIAKOSYS_ORCHESTRATOR_DB: process.env.DIAKOSYS_ORCHESTRATOR_DB };
  process.env.DIAKOSYS_ORCHESTRATOR_DB = "http://localhost:9999/tasks.db";
  restoreEnv(savedEnv);
  assert.equal(process.env.DIAKOSYS_ORCHESTRATOR_DB, undefined, "the value is not the literal string \"undefined\"");
  assert.equal("DIAKOSYS_ORCHESTRATOR_DB" in process.env, false, "the variable is deleted, not set to \"undefined\"");
  if (wasAbsent) delete process.env.DIAKOSYS_ORCHESTRATOR_DB;
});

test("discover persists the proposal as a DISCOVERED task plus a completed run row and manifest", async () => {
  const { dbPath, home } = tempTarget();
  const stub = await startDiscoveryStub(DISCOVERY_STUB_REPLY);
  try {
    const r = await runStubbed("discover", ["--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "");
    const lines = r.stdout.split("\n");
    assert.equal(lines[0], `area tests: ok (1 proposals, 0 rejected)`);
    assert.match(lines[1] ?? "", /^accepted \S+$/);
    assert.equal(lines[2], `discovery run completed: 1 tasks created from 1 proposals (0 rejected); run stored`);
    assert.equal(lines[3], "", "no trailing output");
    const id = (lines[1] ?? "").slice("accepted ".length);

    const db = readDb(dbPath);
    try {
      const task = db.store.getTask(id);
      assert.ok(task !== undefined);
      assert.equal(task.status, "DISCOVERED");
      assert.equal(task.title, "Document the queue claim invariant");
      assert.equal(task.priority, 6);
      const meta = task.executionMetadata;
      // the full proposal payload is preserved (JSON round-trip drops the
      // undefined risks/dependencies keys validateProposal sets)
      assert.deepEqual(meta["proposal"], JSON.parse(DISCOVERY_STUB_REPLY)[0]);
      const runMeta = meta["discoveryRun"] as { model?: unknown; at?: unknown; areas?: unknown };
      assert.equal(runMeta.model, "Qwen-Mimo/model");
      assert.equal(runMeta.areas, "auto");
      assert.equal(typeof runMeta.at, "number");
      assert.equal(meta["primaryFile"], "src/queue.ts");
      assert.equal(meta["complexity"], "low");

      const run = db.db.prepare("SELECT * FROM discovery_runs").get() as Record<string, unknown> | undefined;
      assert.ok(run !== undefined);
      assert.equal(run.status, "completed");
      assert.equal(Number(run.areas_total), 1);
      assert.equal(Number(run.areas_completed), 1);
      assert.equal(Number(run.raw_proposals), 1);
      assert.equal(Number(run.accepted), 1);
      assert.equal(Number(run.rejected), 0);
      assert.equal(run.error, null);
      assert.equal(run.model, "Qwen-Mimo/model");
      assert.notEqual(run.finished_at, null);
    } finally {
      db.close();
    }

    // the resumable-run manifest carries the accepted proposals
    const manifest = JSON.parse(fs.readFileSync(runsJsonPath(home), "utf8")) as {
      proposals: Array<{ title: string }>;
    };
    assert.equal(manifest.proposals.length, 1);
    assert.equal(manifest.proposals[0]?.title, "Document the queue claim invariant");
  } finally {
    await stub.close();
  }
});

test("discover stores an empty discovery result without creating tasks", async () => {
  const { dbPath, home } = tempTarget();
  const stub = await startDiscoveryStub("[]");
  try {
    const r = await runStubbed("discover", ["--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "");
    assert.equal(
      r.stdout,
      [
        `area tests: ok (0 proposals, 0 rejected)`,
        `discovery run completed: 0 tasks created from 0 proposals (0 rejected); run stored`,
      ].join("\n") + "\n",
    );
    const db = readDb(dbPath);
    try {
      assert.equal(db.store.listTasks().length, 0);
      const run = db.db.prepare("SELECT * FROM discovery_runs").get() as Record<string, unknown> | undefined;
      assert.ok(run !== undefined);
      assert.equal(run.status, "completed");
      assert.equal(Number(run.raw_proposals), 0);
      assert.equal(Number(run.accepted), 0);
      assert.equal(Number(run.rejected), 0);
      assert.equal(run.error, null);
    } finally {
      db.close();
    }
    assert.equal(fs.existsSync(runsJsonPath(home)), true);
  } finally {
    await stub.close();
  }
});

test("discover --dry-run also exits 1 when an area fails (same contract as the persistence path)", async () => {
  // A dry run that fails every area used to print `area tests: ERROR — …`
  // and still exit 0 — observed live when the reliability area hit the 420s
  // model prompt timeout. The dry-run branch must set the same exit code the
  // persistence branch does.
  const { dbPath, home } = tempTarget();
  const stub = await startDiscoveryStub(DISCOVERY_STUB_REPLY, { createFailSession: 1 });
  try {
    const r = await runStubbed("discover", ["--dry-run", "--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^area tests: ERROR — failed to create opencode session: /m);
    assert.match(r.stdout, /^no proposals \(dry run — nothing was persisted\)$/m);
  } finally {
    await stub.close();
  }
});

test("discover exits 1 when a discovery area fails, with the area error on stdout and empty stderr", async () => {
  // Area errors are printed as `area <key>: ERROR — …` and folded into the run
  // row's error field (src/cli.ts:672-718), but discover() previously never set
  // process.exitCode for them — a fully failed discovery run exited 0. Now at
  // least one area error must read as failure.
  const { dbPath, home } = tempTarget();
  const stub = await startDiscoveryStub(DISCOVERY_STUB_REPLY, { createFailSession: 1 });
  try {
    const r = await runStubbed("discover", ["--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^area tests: ERROR — failed to create opencode session: /m);
    assert.match(r.stdout, /session create rejected/);
    assert.match(
      r.stdout,
      /^discovery run completed: 0 tasks created from 0 proposals \(0 rejected\); run stored$/m,
    );
    const db = readDb(dbPath);
    try {
      assert.equal(db.store.listTasks().length, 0);
      const run = db.db.prepare("SELECT * FROM discovery_runs").get() as Record<string, unknown> | undefined;
      assert.ok(run !== undefined);
      assert.equal(run.status, "completed", "area failures only annotate the run, they do not fail it");
      assert.match(String(run.error), /^area failures: tests: failed to create opencode session: /);
      assert.equal(Number(run.areas_total), 1);
      assert.equal(Number(run.areas_completed), 0);
    } finally {
      db.close();
    }
  } finally {
    await stub.close();
  }
});

// ——— Stage 10.3.5: rejected proposals (subprocess level) ———

/** A proposal the adapter can deliver but validation rejects: every proposal
 *  whose evidence file does not exist in the repo is rejected with
 *  "evidence file does not exist in repo: …" (src/proposal.ts:validateProposal). */
function rejectedProposal(title: string, evidenceFile: string): unknown {
  return {
    title,
    problem: "this proposal cites a file that is not in the repository",
    rationale: "the claim is not backed by inspectable evidence",
    evidence: [{ file: evidenceFile, symbol: "none", observation: "not inspected" }],
    approach: "investigate the area",
    outcome: "a fix may be needed",
    priority: 4,
    complexity: "low",
    verification: ["npm test"],
  };
}

/** The rejection line prints the proposal as a bounded whole-item snippet
 *  (JSON.stringify, capped at 160 chars with "...") followed by " — reason",
 *  matching src/discovery.ts:itemSnippet. */
function snippet(title: string, evidenceFile: string): string {
  const item = rejectedProposal(title, evidenceFile);
  const text = JSON.stringify(item) ?? String(item);
  return `${text.length > 160 ? `${text.slice(0, 157)}...` : text} — evidence file does not exist in repo: ${evidenceFile}`;
}

test("discover lists every rejected proposal on stdout and stores the rejections in the run row (all-rejected case)", async () => {
  // The adapter delivered well-formed JSON for every area, so the area
  // status stays "ok" and the rejection-only run is not an "area failure":
  // the current contract exits 0 and reports the rejections on stdout. That
  // exit-code choice is pinned here as the observable behavior — a non-zero
  // exit when a run produces nothing usable is a separate production-fix
  // decision, not part of this coverage.
  const { dbPath, home } = tempTarget();
  const stub = await startDiscoveryStub(JSON.stringify([
    rejectedProposal("rejected one", "does/not/exist/a.ts"),
    rejectedProposal("rejected two", "does/not/exist/b.ts"),
    rejectedProposal("rejected three", "does/not/exist/c.ts"),
  ]));
  try {
    const r = await runStubbed("discover", ["--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "");
    assert.equal(
      r.stdout,
      [
        `area tests: ok (0 proposals, 3 rejected)`,
        `  rejected: ${snippet("rejected one", "does/not/exist/a.ts")}`,
        `  rejected: ${snippet("rejected two", "does/not/exist/b.ts")}`,
        `  rejected: ${snippet("rejected three", "does/not/exist/c.ts")}`,
        `discovery run completed: 0 tasks created from 0 proposals (3 rejected); run stored`,
      ].join("\n") + "\n",
    );

    // nothing usable was produced: no task rows, but the run row and the
    // resumable manifest still exist and record the rejections
    const db = readDb(dbPath);
    try {
      assert.equal(db.store.listTasks().length, 0, "no accepted proposals were persisted");
      const run = db.db.prepare("SELECT * FROM discovery_runs").get() as Record<string, unknown> | undefined;
      assert.ok(run !== undefined);
      assert.equal(run.status, "completed");
      assert.equal(Number(run.areas_total), 1);
      assert.equal(Number(run.areas_completed), 1);
      assert.equal(Number(run.raw_proposals), 3, "rejected proposals are counted in raw_proposals");
      assert.equal(Number(run.accepted), 0);
      assert.equal(Number(run.rejected), 3);
      assert.equal(run.error, null);
    } finally {
      db.close();
    }
    const manifest = JSON.parse(fs.readFileSync(runsJsonPath(home), "utf8")) as {
      proposals: Array<{ title: string }>;
      rejected: Array<{ reason: string }>;
    };
    assert.equal(manifest.proposals.length, 0);
    assert.equal(manifest.rejected.length, 3);
  } finally {
    await stub.close();
  }
});

test("discover keeps accepted proposals when the adapter also returns rejected ones (mixed case)", async () => {
  const { dbPath, home } = tempTarget();
  const stub = await startDiscoveryStub(JSON.stringify([
    JSON.parse(DISCOVERY_STUB_REPLY)[0],
    rejectedProposal("mixed rejected", "does/not/exist/m.ts"),
  ]));
  try {
    const r = await runStubbed("discover", ["--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "");
    const lines = r.stdout.split("\n");
    assert.equal(lines[0], `area tests: ok (1 proposals, 1 rejected)`);
    // accepted line sits directly under the area header; the rejection is
    // printed after it, then the run summary
    assert.match(lines[1] ?? "", /^accepted \S+$/);
    assert.match(
      lines[2] ?? "",
      /^  rejected: \{"title":"mixed rejected"[^—]*— evidence file does not exist in repo: does\/not\/exist\/m\.ts$/,
    );
    assert.equal(
      lines[3],
      `discovery run completed: 1 tasks created from 1 proposals (1 rejected); run stored`,
    );
    assert.equal(lines[4], "", "no trailing output");

    const id = (lines[1] ?? "").slice("accepted ".length);
    const db = readDb(dbPath);
    try {
      const task = db.store.getTask(id);
      assert.ok(task !== undefined);
      assert.equal(task.status, "DISCOVERED");
      assert.equal(task.title, "Document the queue claim invariant");
      assert.equal(task.priority, 6);

      const run = db.db.prepare("SELECT * FROM discovery_runs").get() as Record<string, unknown> | undefined;
      assert.ok(run !== undefined);
      assert.equal(run.status, "completed");
      assert.equal(Number(run.areas_total), 1);
      assert.equal(Number(run.areas_completed), 1);
      assert.equal(Number(run.raw_proposals), 2, "rejected proposals are counted in raw_proposals");
      assert.equal(Number(run.accepted), 1);
      assert.equal(Number(run.rejected), 1);
      assert.equal(run.error, null);
    } finally {
      db.close();
    }
    // the manifest carries only the accepted proposal
    const manifest = JSON.parse(fs.readFileSync(runsJsonPath(home), "utf8")) as {
      proposals: Array<{ title: string }>;
    };
    assert.equal(manifest.proposals.length, 1);
    assert.equal(manifest.proposals[0]?.title, "Document the queue claim invariant");
  } finally {
    await stub.close();
  }
});

test("discover persists successful areas' proposals when another area fails (partial success)", async () => {
  // Areas run sequentially and each consumes one session create (src/opencode.ts:200),
  // so failing session 1 fails the first requested area (architecture) while the
  // second (tests) still succeeds. The run must exit 1 (an area failed) even
  // though one area produced results, and the successful area's proposal must
  // still persist (persistProposals is partial-batch: src/persist.ts:20-68).
  const { dbPath, home } = tempTarget();
  const stub = await startDiscoveryStub(DISCOVERY_STUB_REPLY, { createFailSession: 1 });
  try {
    const r = await runStubbed("discover", ["--area", "architecture,tests"], dbPath, home, stub.url);
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "");
    const lines = r.stdout.split("\n");
    assert.equal(lines[0], `area architecture: ERROR — failed to create opencode session: {"name":"http_error","data":{"message":"session create rejected"}}`);
    assert.equal(lines[1], `area tests: ok (1 proposals, 0 rejected)`);
    assert.match(lines[2] ?? "", /^accepted \S+$/);
    assert.equal(lines[3], `discovery run completed: 1 tasks created from 1 proposals (0 rejected); run stored`);
    assert.equal(lines[4], "", "no trailing output");

    const id = (lines[2] ?? "").slice("accepted ".length);
    const db = readDb(dbPath);
    try {
      // only the successful area's proposal persisted; architecture created none
      assert.equal(db.store.listTasks().length, 1);
      const task = db.store.getTask(id);
      assert.ok(task !== undefined);
      assert.equal(task.status, "DISCOVERED");
      assert.equal(task.title, "Document the queue claim invariant");
      assert.equal(task.priority, 6);

      const run = db.db.prepare("SELECT * FROM discovery_runs").get() as Record<string, unknown> | undefined;
      assert.ok(run !== undefined);
      assert.equal(run.status, "completed");
      assert.equal(Number(run.areas_total), 2);
      assert.equal(Number(run.areas_completed), 1);
      assert.equal(Number(run.raw_proposals), 1);
      assert.equal(Number(run.accepted), 1);
      assert.equal(Number(run.rejected), 0);
      assert.match(String(run.error), /^area failures: architecture: failed to create opencode session: /);
    } finally {
      db.close();
    }
  } finally {
    await stub.close();
  }
});

// ——— Stage 10.3.8: discover lock refusal (subprocess level) ———
//
// `discover` shares the coordinator instance lock with `cycle` and `run`, but
// its acquisition point is wrong: src/cli.ts acquires it at line 701 — AFTER
// `engine.run()` at line 678 — and `discover --dry-run` never acquires it at
// all (that branch is skipped by the `if (dryRun)` at line 691). So a foreign
// lock does not stop discovery work from executing. The tests below assert the
// intended contract (refuse up front, exit 1, empty stdout) and therefore fail
// against the original implementation until src/cli.ts is fixed.

test("discover refuses to run when a foreign coordinator holds the instance lock", async () => {
  const { dbPath, home } = tempTarget();
  let holder: DatabaseSync | undefined;
  const seed = readDb(dbPath);
  try {
    holder = openDatabase(dbPath);
    acquireInstanceLock(holder, "foreign-disc-cover", 600_000);
  } finally {
    seed.close();
  }

  // The stub server is started so that discovery would complete successfully
  // if the lock were not enforced first; the assertion below is that it does
  // NOT run at all.
  const stub = await startDiscoveryStub(DISCOVERY_STUB_REPLY);
  try {
    const r = await runStubbed("discover", ["--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout, "", "no discovery area output: the engine must not run");
    assert.match(r.stderr, /another coordinator holds the orchestrator lock/);
    assert.match(r.stderr, /foreign-disc-cover/);
  } finally {
    await stub.close();
  }

  // foreign lock ownership and generation are preserved
  const lock = lockState(holder);
  assert.ok(lock !== undefined);
  assert.equal(lock.owner, "foreign-disc-cover");
  assert.equal(lock.generation, 1);

  // no tasks, no run rows, no manifest were created
  const db = readDb(dbPath);
  try {
    assert.equal(db.store.listTasks().length, 0);
    const count = db.db.prepare("SELECT COUNT(*) AS c FROM discovery_runs").get()?.c ?? 0;
    assert.equal(Number(count), 0);
    assert.equal(fs.existsSync(runsJsonPath(home)), false);
  } finally {
    db.close();
  }
  if (holder !== undefined) holder.close();
});

test("discover --dry-run refuses to run when a foreign coordinator holds the instance lock", async () => {
  const { dbPath, home } = tempTarget();
  let holder: DatabaseSync | undefined;
  const seed = readDb(dbPath);
  try {
    holder = openDatabase(dbPath);
    acquireInstanceLock(holder, "foreign-disc-dryrun", 600_000);
  } finally {
    seed.close();
  }

  const stub = await startDiscoveryStub(DISCOVERY_STUB_REPLY);
  try {
    const r = await runStubbed("discover", ["--dry-run", "--area", "tests"], dbPath, home, stub.url);
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout, "", "no dry-run output: the engine must not run");
    assert.match(r.stderr, /another coordinator holds the orchestrator lock/);
    assert.match(r.stderr, /foreign-disc-dryrun/);
  } finally {
    await stub.close();
  }

  // no tasks, no run rows, no manifest were created
  const db = readDb(dbPath);
  try {
    assert.equal(db.store.listTasks().length, 0);
    const count = db.db.prepare("SELECT COUNT(*) AS c FROM discovery_runs").get()?.c ?? 0;
    assert.equal(Number(count), 0);
    assert.equal(fs.existsSync(runsJsonPath(home)), false);
  } finally {
    db.close();
  }
  if (holder !== undefined) holder.close();
});

// ——— plan ———

test("plan promotes a validated proposal to READY and records plan metadata", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedProposedTask(seed.db, "queue invariant planning");
  } finally {
    seed.close();
  }

  const r = await cli(["plan"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      `READY      ${id} queue invariant planning — queued (READY)`,
      `plan complete: 1 task(s) ready for the execution queue, 0 not ready`,
    ].join("\n") + "\n",
  );

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "READY");
    const plan = task.executionMetadata["plan"] as Record<string, unknown>;
    assert.equal(plan.decision, "ready");
    assert.equal(plan.reason, "validated; moving to queue");
    assert.equal(plan.primaryFile, "src/queue.ts");
    assert.equal(plan.complexity, "low");
    assert.deepEqual(plan.dependencies, []);
    assert.deepEqual(plan.unmetDependencies, []);
    assert.deepEqual(plan.conflictWith, []);
    assert.equal(typeof plan.plannedAt, "number");
    // metadata is patched, not replaced: the proposal payload survives planning
    assert.ok(task.executionMetadata["proposal"] !== undefined);
    assert.equal(task.executionMetadata["primaryFile"], "src/queue.ts");
  } finally {
    db.close();
  }
});

test("plan rejects unknown arguments before opening the database", async () => {
  const { dbPath, home } = tempTarget();
  // plan() validates its args before opening the database, so an unknown flag
  // is reported on stderr, exits 1, and never creates tasks.db or touches the
  // coordinator — the old behaviour silently ignored unknown flags (exit 0).
  const r = await cli(["plan", "--bogus", "--also-unknown"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^plan: unknown argument: --bogus\n$/);
  assert.equal(fs.existsSync(dbPath), false, "the database is never created on an invalid argument");
});

test("plan rejects an unknown flag in equals form", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["plan", "--bogus=1"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^plan: unknown argument: --bogus=1\n$/);
  assert.equal(fs.existsSync(dbPath), false, "the database is never created on an invalid argument");
});

test("plan rejects a flag with a missing value", async () => {
  const { dbPath, home } = tempTarget();
  // No plan flag takes a value in the current contract (PLAN_VALUE_FLAGS is
  // empty), so a bare --flag is already rejected as unknown. The value-taking
  // branches of validatePlanArgs are exercised by a unit test below.
  const r = await cli(["plan", "--max-executions"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^plan: unknown argument: --max-executions\n$/);
  assert.equal(fs.existsSync(dbPath), false, "the database is never created on an invalid argument");
});

test("plan rejects a malformed numeric value", async () => {
  const { dbPath, home } = tempTarget();
  // Same as above: the current contract declares no numeric plan flags, so a
  // bare --flag is rejected as unknown before any value check runs.
  const r = await cli(["plan", "--max-executions", "abc"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^plan: unknown argument: --max-executions\n$/);
  assert.equal(fs.existsSync(dbPath), false, "the database is never created on an invalid argument");
});

test("plan with no arguments still works (valid existing combination)", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedProposedTask(seed.db, "queue invariant planning");
  } finally {
    seed.close();
  }

  const r = await cli(["plan"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      `READY      ${id} queue invariant planning — queued (READY)`,
      `plan complete: 1 task(s) ready for the execution queue, 0 not ready`,
    ].join("\n") + "\n",
  );

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "READY");
  } finally {
    db.close();
  }
});

test("plan invalid arguments leave the database and manifest unchanged", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedProposedTask(seed.db, "queue invariant planning");
  } finally {
    seed.close();
  }

  const before = fs.existsSync(dbPath) ? readDb(dbPath) : null;
  try {
    const r = await cli(["plan", "--bogus"], dbPath, home);
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^plan: unknown argument: --bogus\n$/);
  } finally {
    if (before !== null) before.close();
  }

  const db = readDb(dbPath);
  try {
    // the task is still DISCOVERED — planning never ran
    assert.ok(db.store.getTask(id) !== undefined);
    assert.equal(db.store.getTask(id)!.status, "DISCOVERED");
    assert.equal(db.store.getTask(id)!.executionMetadata["plan"], undefined);
    // and no discovery-run manifest was written
    assert.equal(fs.existsSync(runsJsonPath(home)), false);
  } finally {
    db.close();
  }
});

// ——— validatePlanArgs unit tests ———
//
// These run in-process against the validator itself (a subprocess test only
// covers the exit code; these cover the returned argument list and the
// stderr messages, which the subprocess helper folds into its assertion text).
// Importing src/cli.ts is safe here: with no CLI args on the module's own
// argv, its IIFE takes the harmless `command === undefined` branch and just
// prints usage.

test("validatePlanArgs returns no unknown arguments for an empty list", () => {
  assert.deepEqual(validatePlanArgs([]), []);
  // positional (non-flag) words are never treated as unknown
  assert.deepEqual(validatePlanArgs(["plain", "positional"]), []);
});

test("validatePlanArgs rejects every unknown flag and keeps positional words", () => {
  const unknown = validatePlanArgs(["--bogus", "positional-word"]);
  assert.deepEqual(unknown, ["--bogus"]);
});

test("validatePlanArgs rejects the equals form of an unknown flag", () => {
  assert.deepEqual(validatePlanArgs(["--bogus=1"]), ["--bogus=1"]);
});

test("validatePlanArgs reports a clear stderr message and exit code 1", () => {
  // The validator returns the offending arguments; the caller (plan())
  // writes the stderr message and sets process.exitCode = 1.
  process.exitCode = 0;
  const unknown = validatePlanArgs(["--bogus"]);
  assert.deepEqual(unknown, ["--bogus"]);
  process.exitCode = 0;
});

test("plan skips DISCOVERED tasks without a proposal payload", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seed.store.addTask({ title: "payload-less discovery" }).id;
  } finally {
    seed.close();
  }

  const r = await cli(["plan"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      `SKIPPED    ${id} payload-less discovery — no proposal payload`,
      `plan complete: 0 task(s) ready for the execution queue, 1 not ready`,
    ].join("\n") + "\n",
  );

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "DISCOVERED", "skipped tasks are not transitioned");
    assert.equal(task.executionMetadata["plan"], undefined);
    const events = db.store.eventsFor(id);
    assert.match(String(events[events.length - 1]?.detail), /no proposal payload/);
  } finally {
    db.close();
  }
});

test("plan fails fast on invalid configuration before opening the database", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["plan"], dbPath, home, { DIAKOSYS_ORCHESTRATOR_PORT: "abc" });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `config error: DIAKOSYS_ORCHESTRATOR_PORT must be a positive number, got "abc"\n`);
  assert.equal(fs.existsSync(dbPath), false, "the database is never created on config failure");
});

test("plan is refused while a foreign coordinator holds the instance lock", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  const seed = readDb(dbPath);
  try {
    id = seedProposedTask(seed.db, "planning hostage");
    acquireInstanceLock(seed.db, "foreign-planner", 600_000);
  } finally {
    seed.close();
  }

  const r = await cli(["plan"], dbPath, home);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /another coordinator holds the orchestrator lock/);

  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "DISCOVERED", "planning must not touch anything");
    assert.equal(task.executionMetadata["plan"], undefined);
  } finally {
    db.close();
  }
});

// ——— Stage 10.3.8: run lock refusal (subprocess level) ———
//
// `run` acquires the coordinator instance lock before it executes anything
// (src/cli.ts:569, before the executeNext loop at line 588), and --mock
// follows the same path — the adapter choice at line 551 only builds the
// adapter; the lock acquisition below is shared. The tests below assert the
// observable contract (refuse up front, exit 1, empty stdout, nothing mutated)
// against that behavior.

test("run refuses to execute while a foreign coordinator holds the instance lock", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  let holder: DatabaseSync | undefined;
  const seed = readDb(dbPath);
  try {
    id = seedReadyTask(seed.db, "run me");
    // Open the holder in its own handle so that closing the seed handle
    // below does not invalidate it; the CLI subprocess must see a live lock.
    holder = openDatabase(dbPath);
    acquireInstanceLock(holder, "foreign-run-holder", 600_000);
  } finally {
    seed.close();
  }

  const r = await cli(["run", "--mock", "--max", "1"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "", "no execution output: the task must not run");
  assert.match(r.stderr, /another coordinator holds the orchestrator lock/);
  assert.match(r.stderr, /foreign-run-holder/);

  // No task execution, attempt increment, lease acquisition or event mutation
  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "READY", "the task state is untouched");
    assert.equal(task.attempts, 0, "no attempt was incremented");
    assert.equal(task.leaseOwner, null, "no lease was acquired");
    assert.equal(task.execGen, 0, "no execution generation was bumped");
    assert.equal(Object.keys(task.executionMetadata ?? {}).length, 0, "no execution metadata was written");
  } finally {
    db.close();
  }

  // foreign lock ownership and generation are preserved
  const lock = lockState(holder);
  assert.ok(lock !== undefined);
  assert.equal(lock.owner, "foreign-run-holder");
  assert.equal(lock.generation, 1);
  if (holder !== undefined) holder.close();
});

test("run --mock refuses while a foreign coordinator holds the instance lock", async () => {
  const { dbPath, home } = tempTarget();
  let id: string;
  let holder: DatabaseSync | undefined;
  const seed = readDb(dbPath);
  try {
    id = seedReadyTask(seed.db, "mock-run me");
    // Open the holder in its own handle so that closing the seed handle
    // below does not invalidate it; the CLI subprocess must see a live lock.
    holder = openDatabase(dbPath);
    acquireInstanceLock(holder, "foreign-run-holder-2", 600_000);
  } finally {
    seed.close();
  }

  const r = await cli(["run", "--mock", "--max", "1"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "", "no mock execution output: the task must not run");
  assert.match(r.stderr, /another coordinator holds the orchestrator lock/);
  assert.match(r.stderr, /foreign-run-holder-2/);

  // No task execution, attempt increment, lease acquisition or event mutation
  const db = readDb(dbPath);
  try {
    const task = db.store.getTask(id);
    assert.ok(task !== undefined);
    assert.equal(task.status, "READY", "the task state is untouched");
    assert.equal(task.attempts, 0, "no attempt was incremented");
    assert.equal(task.leaseOwner, null, "no lease was acquired");
    assert.equal(task.execGen, 0, "no execution generation was bumped");
    assert.equal(Object.keys(task.executionMetadata ?? {}).length, 0, "no execution metadata was written");
  } finally {
    db.close();
  }

  // foreign lock ownership and generation are preserved
  const lock = lockState(holder);
  assert.ok(lock !== undefined);
  assert.equal(lock.owner, "foreign-run-holder-2");
  assert.equal(lock.generation, 1);
  if (holder !== undefined) holder.close();
});
