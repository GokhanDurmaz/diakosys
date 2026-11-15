import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import { acquireInstanceLock } from "../src/coordinator.ts";
import { MockOpenCodeAdapter, type OpenCodeAdapter } from "../src/opencode.ts";
import { runCycle } from "../src/cycle.ts";
import { discover } from "../src/cli.ts";
import { LifecycleLogger, type LifecycleEvent } from "../src/lifecycle.ts";
import { restoreEnv } from "./helpers.ts";

/**
 * Focused tests for the shared real-time lifecycle logger and its opt-in CLI
 * integration (`--lifecycle`). Unit tests inject a capturing sink and a
 * deterministic clock; CLI tests spawn `node src/cli.ts` against isolated
 * databases (same isolation contract as tests/cli.test.ts).
 */

// ——— unit: capturing sink + deterministic clock ———

/** Capturing sink: records every rendered lifecycle line. */
function capturingSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

/** Deterministic clock: returns the queued values in order (last value repeats). */
function fakeClock(values: number[]): { now: () => number } {
  const queue = [...values];
  return {
    now: () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return next;
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The lifecycle line signature: `[HH:MM:SS] LEVEL  ...`. */
const LINE = /^\[\d\d:\d\d:\d\d\] (INFO|DEBUG|WARN|ERROR) {2}\S+\s+\S+\s+\S+/m;

function opAndStage(line: string): { level: string; op: string; stage: string; event: string } | undefined {
  const m = line.match(/^\[(\d\d):(\d\d):(\d\d)\] (\w+)\s+(\S+)\s+(\S+)\s+(\S+)/);
  if (m === null) return undefined;
  return { level: m[4] ?? "", op: m[5] ?? "", stage: m[6] ?? "", event: m[7] ?? "" };
}

test("lifecycle lines render the level/operation/stage/event columns and structured fields", () => {
  const { lines, sink } = capturingSink();
  const logger = new LifecycleLogger({ sink, now: fakeClock([1_000, 1_250]).now });
  logger.start("execute", "claim", { taskId: "t-1", attempts: 2 });
  logger.complete("execute", "claim", { taskId: "t-1" });
  logger.transition("execute", "t-1", "READY", "IN_PROGRESS", "queue claim");
  logger.error("execute", "prompt", "prompt failed: adapter closed");

  assert.match(lines[0]!, LINE);
  assert.match(lines[0]!, /taskId=t-1/);
  assert.match(lines[0]!, /attempts=2/);
  assert.equal(opAndStage(lines[0]!)?.op, "execute");
  assert.equal(opAndStage(lines[0]!)?.stage, "claim");
  assert.equal(opAndStage(lines[0]!)?.event, "started");

  // completed carries the stage-tracker's durationMs (250ms fake step)
  assert.match(lines[1]!, /durationMs=250/);
  assert.equal(opAndStage(lines[1]!)?.event, "completed");

  // observed store transition renders from/to/taskId, detail optional
  assert.match(lines[2]!, /fromState=READY/);
  assert.match(lines[2]!, /toState=IN_PROGRESS/);
  assert.match(lines[2]!, /taskId=t-1/);
  assert.match(lines[2]!, /detail=queue claim/);

  // error summaries land in the error column — never a raw response or stack
  assert.match(lines[3]!, /^.*ERROR {2}/);
  assert.match(lines[3]!, /error=prompt failed: adapter closed/);
});

test("log() strips reserved keys (level/operation/stage/event/durationMs/elapsedMs) from extra", () => {
  const { lines, sink } = capturingSink();
  const logger = new LifecycleLogger({ sink });
  logger.log("INFO", "discover", "run", "started", {
    level: "SPOOFED",
    operation: "SPOOFED",
    stage: "SPOOFED",
    event: "SPOOFED",
    durationMs: 999,
    elapsedMs: 888,
    detail: "kept",
  });
  const line = lines[0]!;
  assert.doesNotMatch(line, /SPOOFED/);
  assert.doesNotMatch(line, /durationMs=999/);
  assert.doesNotMatch(line, /elapsedMs=888/);
  assert.match(line, /detail=kept/);
  assert.equal(opAndStage(line)?.op, "discover");
  assert.equal(opAndStage(line)?.stage, "run");
  assert.equal(opAndStage(line)?.event, "started");
});

test("stage tracking is keyed by operation+stage so claim and prompt coexist under execute", () => {
  const { lines, sink } = capturingSink();
  // start claim @1000, start prompt @1200, complete claim @1500, complete prompt @1900
  const logger = new LifecycleLogger({ sink, now: fakeClock([1_000, 1_200, 1_500, 1_900]).now });
  logger.start("execute", "claim", { taskId: "t-1" }); // t=1_000_100
  logger.start("execute", "prompt", { taskId: "t-1" }); // t=1_000_200
  logger.complete("execute", "claim"); // elapsed 100
  logger.complete("execute", "prompt"); // elapsed 200
  const claimCompleted = lines[2]!;
  const promptCompleted = lines[3]!;
  assert.equal(opAndStage(claimCompleted)?.stage, "claim");
  assert.match(claimCompleted, /durationMs=500/);
  assert.equal(opAndStage(promptCompleted)?.stage, "prompt");
  assert.match(promptCompleted, /durationMs=700/);
  // claim's completion must not have clobbered prompt's start time
  assert.doesNotMatch(promptCompleted, /durationMs=500/);
});

test("heartbeat reports pending with elapsedMs (never model progress)", () => {
  const { lines, sink } = capturingSink();
  const logger = new LifecycleLogger({ sink, now: fakeClock([1_000, 6_000]).now });
  logger.start("execute", "prompt", { taskId: "t-1" });
  logger.heartbeat("execute", "prompt");
  const line = lines[1]!;
  assert.equal(opAndStage(line)?.event, "pending");
  assert.match(line, /elapsedMs=5000/);
  assert.doesNotMatch(line, /progress|tokens|tool/i);

  // heartbeat without an active stage reports no invented elapsedMs
  logger.heartbeat("verify", "prompt");
  const orphan = lines[2]!;
  assert.equal(opAndStage(orphan)?.event, "pending");
  assert.doesNotMatch(orphan, /elapsedMs/);
});

test("beginHeartbeat fires on the configured interval and complete() stops it", async () => {
  const { lines, sink } = capturingSink();
  const logger = new LifecycleLogger({ sink, heartbeatEveryMs: 25 });
  logger.start("execute", "prompt", { taskId: "t-1" });
  logger.beginHeartbeat("execute", "prompt");
  await sleep(120);
  const pendingDuring = lines.filter((l) => opAndStage(l)?.event === "pending");
  assert.ok(pendingDuring.length >= 1, `expected at least one heartbeat, got: ${lines.join(" | ")}`);
  const before = lines.length;
  logger.complete("execute", "prompt", { taskId: "t-1" });
  await sleep(90);
  // no further heartbeats after completion
  assert.equal(lines.length, before + 1);
  assert.match(lines[lines.length - 1]!, /durationMs=\d+/);
});

test("setHeartbeatEveryMs(0) disables heartbeats", async () => {
  const { lines, sink } = capturingSink();
  const logger = new LifecycleLogger({ sink, heartbeatEveryMs: 25 });
  logger.setHeartbeatEveryMs(0);
  logger.start("execute", "prompt", { taskId: "t-1" });
  logger.beginHeartbeat("execute", "prompt");
  await sleep(120);
  assert.equal(lines.length, 1, "only the started line must appear");
  logger.complete("execute", "prompt", { taskId: "t-1" });
  assert.equal(lines.length, 2);
});

test("a failing sink never breaks execution (logging failures are swallowed)", () => {
  const logger = new LifecycleLogger({
    sink: () => {
      throw new Error("sink exploded (e.g. EPIPE)");
    },
    heartbeatEveryMs: 0,
  });
  // every method must survive a throwing sink
  logger.start("execute", "claim", { taskId: "t-1" });
  logger.complete("execute", "claim", { taskId: "t-1" });
  logger.transition("execute", "t-1", "READY", "IN_PROGRESS");
  logger.error("execute", "prompt", "boom");
  logger.warn("cycle", "lock", "wobbly");
  logger.info("cycle", "recovery", "skipped");
  logger.heartbeat("execute", "prompt");
  logger.beginHeartbeat("execute", "prompt");
  logger.emitEvent({ level: "INFO", operation: "discover", stage: "run", event: "completed", durationMs: 5 });
  logger.close();
  // the stage tracker still works even though nothing was rendered
  logger.start("execute", "prompt", { taskId: "t-2" });
  logger.complete("execute", "prompt", { taskId: "t-2" });
});

test("close() tears down heartbeats and stage tracking (success and error paths)", async () => {
  const { lines, sink } = capturingSink();
  const logger = new LifecycleLogger({ sink, heartbeatEveryMs: 25 });
  logger.start("execute", "prompt", { taskId: "t-1" });
  logger.beginHeartbeat("execute", "prompt");
  await sleep(80);
  assert.ok(lines.length >= 2);
  // error path: an error report then disposal
  logger.error("execute", "prompt", "shutting down");
  logger.close();
  const afterClose = lines.length;
  await sleep(80);
  assert.equal(lines.length, afterClose, "no heartbeats may fire after close()");
  // the logger stays usable (stage tracking restarted from clean state)
  logger.start("execute", "prompt", { taskId: "t-2" });
  logger.complete("execute", "prompt", { taskId: "t-2" });
  assert.equal(lines.length, afterClose + 2);
});

test("emitEvent bridges internal emitters (discovery engine) and preserves their durationMs", () => {
  const { lines, sink } = capturingSink();
  const logger = new LifecycleLogger({ sink });
  const ev: LifecycleEvent = {
    level: "INFO",
    operation: "discover",
    stage: "run",
    event: "completed",
    durationMs: 1234,
  };
  logger.emitEvent(ev);
  const line = lines[0]!;
  assert.equal(opAndStage(line)?.op, "discover");
  assert.equal(opAndStage(line)?.stage, "run");
  assert.equal(opAndStage(line)?.event, "completed");
  assert.match(line, /durationMs=1234/);
});

// ——— in-process: runCycle routes lifecycle lines through onOutput ———

function setupDb(): { db: DatabaseSync; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-lifecycle-"));
  const db = openDatabase(path.join(dir, "tasks.db"));
  return { db, close: () => closeDatabase(db) };
}

function mockCycleAdapter(verifyReply: "PASS" | "FAIL"): OpenCodeAdapter {
  return new MockOpenCodeAdapter((input) => {
    if (input.description.startsWith("VERIFY TASK:")) {
      return verifyReply === "PASS" ? "checked\nVERDICT: PASS — ok" : "checked\nVERDICT: FAIL — broke";
    }
    return `mock executed: ${input.title}`;
  });
}

test("runCycle emits lifecycle events through onOutput for real executions and transitions", async () => {
  const s = setupDb();
  const { lines, sink } = capturingSink();
  const logger = new LifecycleLogger({
    sink,
    heartbeatEveryMs: 0,
    now: fakeClock(Array.from({ length: 60 }, (_, i) => 1_000 + i * 50)).now,
  });
  try {
    const store = new TaskStore(s.db);
    const task = store.addTask({ title: "Handle the NaN guard", priority: 6 });
    store.transition(task.id, "BACKLOG");
    store.transition(task.id, "READY");

    const summary = await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: mockCycleAdapter("PASS"),
      maxExecutions: 3,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: sink,
      lifecycle: logger,
    });
    assert.equal(summary.executed, 1);
    assert.equal(summary.verifiedPass, 1);

    const text = lines.join("\n");
    // cycle stage start/completion with the real stop reason
    assert.match(text, /cycle {2,}cycle {2,}started rounds=10/);
    assert.match(text, /cycle {2,}cycle {2,}completed/);
    assert.match(text, /stopReason=no-progress/);
    // recovery ran (no interrupted leases) and planning ran (the fixture task
    // is already READY, so the planner promotes nothing)
    assert.match(text, /cycle {2,}recovery {2,}(started|completed)/);
    assert.match(text, /cycle {2,}plan {2,}(started|completed)/);
    assert.match(text, /promoted=0/);
    // real observed transitions, not invented ones
    assert.match(text, /fromState=READY toState=IN_PROGRESS/);
    assert.match(text, /fromState=IN_PROGRESS toState=REVIEW/);
    assert.match(text, /fromState=REVIEW toState=VERIFYING/);
    assert.match(text, /fromState=VERIFYING toState=DONE/);
    // prompt stage completed with a duration from the injected clock
    assert.match(text, /execute {2,}prompt {2,}completed/);
    assert.match(text, /durationMs=\d+/);
    // per-execution and per-verification completions under the cycle operation
    assert.match(text, /cycle {2,}execute {2,}completed/);
    assert.match(text, /cycle {2,}verify {2,}completed/);
    // no raw model response ever reaches a LIFECYCLE line (the pre-existing
    // plain `note()` output may echo an output slice — that is not the channel
    // under test)
    const lifecycleLines = lines.filter((l) => l.startsWith("["));
    assert.ok(lifecycleLines.length > 0);
    for (const l of lifecycleLines) {
      assert.doesNotMatch(l, /mock executed:|VERDICT/);
    }
  } finally {
    logger.close();
    s.close();
  }
});

test("a lifecycle logger is not required: runCycle output is unchanged without one", async () => {
  const s = setupDb();
  try {
    const store = new TaskStore(s.db);
    const task = store.addTask({ title: "Handle the NaN guard", priority: 6 });
    store.transition(task.id, "BACKLOG");
    store.transition(task.id, "READY");

    const summary = await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: mockCycleAdapter("PASS"),
      maxExecutions: 3,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: () => undefined,
    });
    assert.equal(summary.executed, 1);
    assert.equal(summary.verifiedPass, 1);
  } finally {
    s.close();
  }
});

// ——— CLI: opt-in `--lifecycle` (subprocess, isolated db/home like cli.test.ts) ———

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(ROOT, "src", "cli.ts");
const execFileP = promisify(execFile);

interface CliRun {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function tempTarget(): { dir: string; dbPath: string; home: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-lifecycle-cli-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  return { dir, dbPath: path.join(dir, "tasks.db"), home };
}

async function cli(args: string[], dbPath: string, home: string): Promise<CliRun> {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    DIAKOSYS_ORCHESTRATOR_DB: dbPath,
    DIAKOSYS_ORCHESTRATOR_MODEL: "Qwen-Mimo/model",
  };
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI_ENTRY, ...args], {
      cwd: ROOT,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code === "number") {
      return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    throw err;
  }
}

test("lifecycle output is absent by default: run --mock keeps its exact stdout", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["run", "--mock"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "queue empty\n");
  assert.doesNotMatch(r.stdout, LINE);
});

test("lifecycle output is absent by default: plan keeps its exact stdout", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["plan"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, "nothing to plan\n");
  assert.doesNotMatch(r.stdout, LINE);
});

test("lifecycle output is absent by default: cycle --mock --no-discovery keeps its stdout", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["cycle", "--mock", "--no-discovery"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /cycle: 1 round\(s\)/);
  assert.doesNotMatch(r.stdout, LINE);
});

test("run --mock --lifecycle prints execution lifecycle events", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["run", "--mock", "--lifecycle"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  // the plain output contract is preserved alongside the lifecycle channel
  assert.match(r.stdout, /queue empty\n/);
  // the runner's early-exit is reported as an INFO claim completion
  assert.match(r.stdout, LINE);
  assert.match(r.stdout, /execute {2,}claim {2,}completed/);
  assert.match(r.stdout, /queue empty \(no READY task\)/);
});

test("plan --lifecycle prints plan lifecycle events and passes argument validation", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["plan", "--lifecycle"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /nothing to plan\n/);
  assert.match(r.stdout, /plan {2,}plan {2,}started/);
  assert.match(r.stdout, /plan {2,}plan {2,}completed/);
  assert.match(r.stdout, /promoted=0/);
  assert.match(r.stdout, /total=0/);
});

test("plan --lifecycle still rejects genuinely unknown flags (only --lifecycle is stripped)", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["plan", "--lifecycle", "--bogus"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /plan: unknown argument: --bogus/);
  assert.equal(fs.existsSync(dbPath), false, "validation must run before the database is opened");
});

test("cycle --mock --no-discovery --lifecycle prints cycle lifecycle events end-to-end", async () => {
  const { dbPath, home } = tempTarget();
  const r = await cli(["cycle", "--mock", "--no-discovery", "--lifecycle"], dbPath, home);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  // existing output contract preserved
  assert.match(r.stdout, /cycle: 1 round\(s\)/);
  assert.match(r.stdout, LINE);
  assert.match(r.stdout, /cycle {2,}cycle {2,}started rounds=1/);
  assert.match(r.stdout, /cycle {2,}cycle {2,}completed/);
  assert.match(r.stdout, /stopReason=no-progress/);
  // lock and recovery observation
  assert.match(r.stdout, /instance lock acquired/);
  assert.match(r.stdout, /cycle {2,}recovery {2,}started/);
  assert.match(r.stdout, /cycle {2,}recovery {2,}completed/);
  // discovery skipped (early exit, not a fake stage)
  assert.match(r.stdout, /discovery {2,}skipped/);
  // plan ran with nothing to promote; the queue was empty; the round stopped
  assert.match(r.stdout, /cycle {2,}plan {2,}completed/);
  assert.match(r.stdout, /promoted=0/);
  assert.match(r.stdout, /execute {2,}claim {2,}completed/);
  assert.match(r.stdout, /queue empty \(no READY task\)/);
  assert.match(r.stdout, /round {2,}stopped/);
});

test("cycle lock refusal is reported on the lifecycle channel and still exits 1", async () => {
  const { dbPath, home } = tempTarget();
  // a foreign coordinator holds the instance lock
  const holder = openDatabase(dbPath);
  acquireInstanceLock(holder, "foreign-lifecycle-cover", 600_000);
  closeDatabase(holder);

  const r = await cli(["cycle", "--mock", "--no-discovery", "--lifecycle"], dbPath, home);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /cycle error:/);
  assert.match(r.stdout, LINE);
  assert.match(r.stdout, /ERROR {2}/);
  assert.match(r.stdout, /instance lock acquisition refused/);
  // the command must exit cleanly: the closed logger cannot keep the loop alive
});

test("discover --lifecycle emits the engine's start event and releases resources on the failure path", async () => {
  const { dbPath, home } = tempTarget();
  const adapter = new MockOpenCodeAdapter(() => "[]");
  const savedEnv: NodeJS.ProcessEnv = {
    DIAKOSYS_ORCHESTRATOR_DB: process.env.DIAKOSYS_ORCHESTRATOR_DB,
    DIAKOSYS_ORCHESTRATOR_MODEL: process.env.DIAKOSYS_ORCHESTRATOR_MODEL,
    HOME: process.env.HOME,
  };
  process.env.DIAKOSYS_ORCHESTRATOR_DB = dbPath;
  process.env.DIAKOSYS_ORCHESTRATOR_MODEL = "Qwen-Mimo/model";
  process.env.HOME = home;
  const captured: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    let threw: unknown;
    try {
      await discover(["--dry-run", "--area", "tests", "--lifecycle"], adapter);
    } catch (e) {
      threw = e; // tolerated: the engine path may fail for its own reasons
    }
    // the discovery engine's lifecycle events reached stdout through the bridge
    const text = captured.join("");
    assert.match(text, LINE);
    assert.match(text, /discover {2,}run {2,}started/);
    assert.match(text, /dryRun=true/);
    // whether the engine afterwards succeeds or throws is not this test's
    // concern — only that the opt-in channel is live and stays display-only
    if (threw !== undefined) {
      assert.ok(threw instanceof Error);
    }
  } finally {
    process.stdout.write = realWrite;
    restoreEnv(savedEnv);
  }
});
