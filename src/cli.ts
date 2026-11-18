import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, closeDatabase } from "./db.ts";
import { TaskStore } from "./store.ts";
import { TaskQueue } from "./queue.ts";
import {
  LiveOpenCodeAdapter,
  MockOpenCodeAdapter,
  type OpenCodeAdapter,
} from "./opencode.ts";
import { executeNext } from "./runner.ts";
import { TASK_STATES } from "./types.ts";
import type { OrchestratorConfig } from "./config.ts";
import { resolveConfig, ALL_DISCOVERY_AREAS } from "./config.ts";
import { maybeFirstRunSetup } from "./first-run.ts";
import type { TaskState } from "./types.ts";
import {
  DiscoveryEngine,
  DiscoveryRunStore,
  DISCOVERY_SERVER_CONFIG,
  defaultCacheDir,
  selectAreas,
  validateRequestedAreas,
  type AreaResult,
  type RejectedProposal,
} from "./discovery.ts";
import { planDiscoveredTasks, type PlanReportEntry, type PlanMeta } from "./planner.ts";
import { auditProposals } from "./auditor.ts";
import { persistProposals } from "./persist.ts";
import { runCycle } from "./cycle.ts";
import { LifecycleLogger, type LifecycleEvent } from "./lifecycle.ts";
import type { Proposal } from "./proposal.ts";
import {
  acquireInstanceLock,
  releaseInstanceLock,
  renewInstanceLock,
  holdsInstanceLock,
  coordinatorOwner,
  CoordinatorDisownedError,
} from "./coordinator.ts";
import type { CoordinatorAuthority } from "./locks.ts";
import {
  recoverInterruptedTasks,
  requeueRetryDueTasks,
  scheduleFailedRetries,
  classifyFailure,
  type RecoveryReport,
  type RetryDueReport,
  type RetrySchedulingReport,
} from "./recovery.ts";

const DB_ENV = "DIAKOSYS_ORCHESTRATOR_DB";

function defaultDbPath(): string {
  if (process.env[DB_ENV] !== undefined && process.env[DB_ENV] !== "") {
    return String(process.env[DB_ENV]);
  }
  const dataHome =
    process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? ".", ".local", "share");
  return path.join(dataHome, "diakosys-orchestrator", "tasks.db");
}

function openStore(dbPath: string): { dbPath: string; close(): void; db: ReturnType<typeof openDatabase>; store: TaskStore; queue: TaskQueue } {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  return { dbPath, close: () => closeDatabase(db), db, store: new TaskStore(db), queue: new TaskQueue(db) };
}

/**
 * Acquire the coordinator instance lock for a CLI write session (run, plan,
 * discover, recover, task retry). Denied → descriptive error, exit code 1.
 */
function acquireCoordinator(db: ReturnType<typeof openDatabase>, config: OrchestratorConfig, prefix: string): CoordinatorAuthority {
  const owner = coordinatorOwner(prefix);
  const grant = acquireInstanceLock(db, owner, config.lockTtlMs);
  return { owner, generation: grant.generation, lockTtlMs: config.lockTtlMs };
}

/**
 * Opt-in real-time lifecycle observer for CLI commands.
 *
 * One logger per command invocation; its sink is stdout (one line per event).
 * Returns `undefined` when `--lifecycle` is absent, so the scripted output
 * contract (exact stdout) is untouched by default.
 */
function lifecycleLoggerFor(args: string[]): LifecycleLogger | undefined {
  if (!args.includes("--lifecycle")) return undefined;
  return new LifecycleLogger({
    sink: (line) => process.stdout.write(`${line}\n`),
  });
}

/**
 * Value-taking `plan` flags, mapped to their value kind.
 *
 * The current CLI contract documents `plan` with no arguments — it is a
 * read-only planning pass over whatever discovery already produced, and the
 * planner itself takes no options. This map is empty today; it is kept so a
 * future flag can be added here without reworking `plan()`'s validation.
 */
const PLAN_VALUE_FLAGS = new Map<string, "text" | "number">();

(async () => {
  const argv = process.argv.slice(2);
  const command = argv[0];

  // explicit help command: print usage and return before anything interactive
  if (command === "help") {
    usage(0);
    return;
  }

  // every subcommand must print usage for -h/--help BEFORE any adapter,
  // database or discovery runs — an unguarded --help could trigger live work
  if (argv.includes("-h") || argv.includes("--help")) {
    usage(0);
    return;
  }

  // First-run setup: an interactive terminal without a user config gets to
  // pick model + agent from the global opencode config once, before the
  // command resolves its configuration. The full gate — TTY, help arguments,
  // --mock — is enforced inside maybeFirstRunSetup (see
  // shouldRunFirstRunSetup); nothing is duplicated here, so scripted and
  // non-interactive behavior is byte-identical to before. A bare invocation
  // (`npm start`) passes the gate on a real TTY, gets the one-time setup,
  // and then falls through to the usage screen below.
  await maybeFirstRunSetup(argv);

  // Bare invocation: after the (possible) one-time setup, keep the documented
  // usage output and exit-0 behavior.
  if (command === undefined) {
    usage(0);
    return;
  }

  switch (command) {
    case "doctor": {
      await doctor(argv.slice(1));
      return;
    }
    case "status": {
      status();
      return;
    }
    case "task": {
      task(argv.slice(1));
      return;
    }
    case "recover": {
      recoverTaskQueue(argv.slice(1));
      return;
    }
    case "run": {
      await run(argv.slice(1));
      return;
    }
    case "discover": {
      await discover(argv.slice(1));
      return;
    }
    case "plan": {
      plan(argv.slice(1));
      return;
    }
    case "cycle": {
      await cycle(argv.slice(1));
      return;
    }
    case "tasks": {
      tasks(argv.slice(1));
      return;
    }
    default: {
      process.stderr.write(`unknown command: ${command}\n`);
      usage(1);
      return;
    }
  }
})().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

function usage(code: number): void {
  process.stdout.write(
    [
      "diakosys-orchestrator — persistent task queue with OpenCode execution",
      "",
      "Usage: orchestrator <command> [options]",
      "",
      "  doctor                      Check runtime, config, database and OpenCode connectivity",
      "",
      "Machine-specific settings live in ~/.config/diakosys/config.json (endpoint, port) or in",
      "the DIAKOSYS_ENDPOINT environment variable. Point a remote model server at localhost on",
      "the machine that runs the CLI; no machine address is stored in this project's sources.",
      "  status                      Task counts by state",
      "  task add <title> [--description <text>] [--priority <n>] [--state <s>]",
      "  task list [--state <s>]     List stored tasks",
      "  task show <id>              Show a task and its event history",
      "  task verify <id> --pass|--fail [--note <text>]",
      "                              Record the verification outcome (VERIFYING → DONE/FAILED)",
      "  task retry <id> [--confirm-unsafe]",
      "                              Manually requeue a FAILED task (bypasses backoff, never the",
      "                              attempt cap; ambiguous/legacy failures need --confirm-unsafe)",
      "  recover [--confirm-unsafe]  Coordinator-guarded recovery pass: re-stamp interrupted leases,",
      "                              schedule/requeue retries; discovery runs left 'running' by a",
      "                              crash are interrupted only with --confirm-unsafe",
      "  run [--mock] [--max <n>]    Execute up to n queued tasks (default 1); --mock uses a test adapter",
      "",
      "Discovery and planning (read-only analysis, no auto-execution):",
      "  discover [--dry-run] [--area a,b,...]",
      "                              Inspect the repo with the configured model in read-only mode",
      "  plan                        Validate discovered proposals; queue dependency-ready ones",
      "                              Takes no arguments: any --flag is rejected before the database opens",
      "  cycle [--mock] [--max-executions <n>] [--max-rounds <n>] [--no-discovery]",
      "                              One composed orchestration pass: discover → plan →",
      "                              execute → verify → DONE/FAILED. --mock uses test adapters",
      "                              (add --mock-fail to make verification fail deterministically)",
      "  tasks [--state <s>]         Tasks with priority, status and dependencies",
      "",
      `Environment: ${DB_ENV}, DIAKOSYS_ORCHESTRATOR_MODEL / DIAKOSYS_ORCHESTRATOR_PROVIDER + DIAKOSYS_ORCHESTRATOR_MODEL_ID, DIAKOSYS_ORCHESTRATOR_AGENT, DIAKOSYS_ORCHESTRATOR_PROJECT_DIR, DIAKOSYS_ORCHESTRATOR_PORT, DIAKOSYS_ORCHESTRATOR_LEASE_TTL_MS, DIAKOSYS_ORCHESTRATOR_LOCK_TTL_MS, DIAKOSYS_ORCHESTRATOR_RETRY_MAX_ATTEMPTS / _BASE_MS / _MAX_MS, DIAKOSYS_ORCHESTRATOR_RECOVER_ON_START`,
      `Endpoint: DIAKOSYS_ENDPOINT (highest precedence), ~/.config/diakosys/config.json "endpoint", then the documented safe default (http://localhost:8082/v1)`,
      "",
    ].join("\n"),
  );
  if (code !== 0) process.exitCode = code;
}

function status(): void {
  const settings = openStore(defaultDbPath());
  try {
    const counts = new Map<TaskState, number>(TASK_STATES.map((s) => [s, 0]));
    for (const task of settings.store.listTasks()) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    process.stdout.write(`database: ${settings.dbPath}\n`);
    for (const [state, count] of counts) {
      process.stdout.write(`${state.padEnd(12)} ${count}\n`);
    }
  } finally {
    settings.close();
  }
}

function task(args: string[]): void {
  const sub = args[0];
  if (sub === "add") {
    const title = args[1];
    if (title === undefined || title === "") {
      process.stderr.write("task add requires a title\n");
      process.exitCode = 1;
      return;
    }
    let description = "";
    let priority = 0;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--description" && args[i + 1] !== undefined) {
        description = String(args[i + 1]);
        i++;
      } else if (args[i] === "--priority" && args[i + 1] !== undefined) {
        priority = Number(args[i + 1]);
        i++;
      }
    }
    const settings = openStore(defaultDbPath());
    try {
      const created = settings.store.addTask({ title, description, priority });
      process.stdout.write(
        `created ${created.id} [${created.status}] ${created.title}\n`,
      );
    } finally {
      settings.close();
    }
    return;
  }
  if (sub === "list") {
    let state: TaskState | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--state" && args[i + 1] !== undefined) {
        state = String(args[i + 1]) as TaskState;
        i++;
      }
    }
    if (state !== undefined && !TASK_STATES.includes(state)) {
      process.stderr.write(`unknown state: ${String(state)}\n`);
      process.exitCode = 1;
      return;
    }
    const settings = openStore(defaultDbPath());
    try {
      const tasks = settings.store.listTasks(state);
      process.stdout.write(`database: ${settings.dbPath}\n`);
      if (tasks.length === 0) {
        process.stdout.write("(no tasks)\n");
      }
      for (const t of tasks) {
        const lastErr = typeof t.executionMetadata["error"] === "string" ? ` err="${String(t.executionMetadata["error"]).slice(0, 80)}"` : "";
        process.stdout.write(`${t.id}  ${t.status.padEnd(12)} p=${t.priority} ${t.title}${lastErr}\n`);
      }
    } finally {
      settings.close();
    }
    return;
  }
  if (sub === "show") {
    const id = args[1];
    if (id === undefined) {
      process.stderr.write("task show requires a task id\n");
      process.exitCode = 1;
      return;
    }
    const settings = openStore(defaultDbPath());
    try {
      const t = settings.store.getTask(id);
      if (t === undefined) {
        process.stderr.write(`task not found: ${id}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(JSON.stringify(t, null, 2) + "\n");
      for (const ev of settings.store.eventsFor(id)) {
        process.stdout.write(
          `event ${ev.seq} ${new Date(ev.createdAt).toISOString()} ${ev.eventType} ${String(ev.fromState ?? "∅")} → ${String(ev.toState ?? "∅")}${ev.detail ? ` (${ev.detail})` : ""}\n`,
        );
      }
    } finally {
      settings.close();
    }
    return;
  }
  if (sub === "verify") {
    const id = args[1];
    if (id === undefined) {
      process.stderr.write("task verify requires a task id\n");
      process.exitCode = 1;
      return;
    }
    const pass = args.includes("--pass");
    const fail = args.includes("--fail");
    if (pass === fail) {
      process.stderr.write("task verify requires exactly one of --pass or --fail\n");
      process.exitCode = 1;
      return;
    }
    const noteIdx = args.indexOf("--note");
    const note = noteIdx >= 0 && args[noteIdx + 1] !== undefined ? String(args[noteIdx + 1]) : undefined;
    const settings = openStore(defaultDbPath());
    try {
      const target: TaskState = pass ? "DONE" : "FAILED";
      const detail = note ?? (pass ? "verification passed" : "verification failed");
      const updated = settings.store.transition(id, target, detail);
      settings.store.recordExecution(id, {
        verification: pass ? "pass" : "fail",
        verificationNote: detail,
      });
      process.stdout.write(`${updated.id} ${updated.status} — ${detail}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    } finally {
      settings.close();
    }
    return;
  }
  if (sub === "retry") {
    retryTask(args.slice(1));
    return;
  }
  process.stderr.write(`unknown task subcommand: ${String(sub)}\n`);
  process.exitCode = 1;
}

/**
 * Manual retry of a FAILED task (`task retry <id> [--confirm-unsafe]`).
 * Bypasses the backoff delay by scheduling the retry as immediately eligible
 * and requeuing right away; never bypasses the attempt cap. Ambiguous,
 * malformed and legacy failure classifications are manual-only: they need an
 * explicit --confirm-unsafe. Runs under the coordinator instance lock.
 */
function retryTask(args: string[]): void {
  const id = args[0];
  if (id === undefined) {
    process.stderr.write("task retry requires a task id\n");
    process.exitCode = 1;
    return;
  }
  const confirmUnsafe = args.includes("--confirm-unsafe");
  let config: OrchestratorConfig;
  try {
    config = resolveConfig();
  } catch (err) {
    process.stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const settings = openStore(defaultDbPath());
  let authority: CoordinatorAuthority | undefined;
  try {
    try {
      authority = acquireCoordinator(settings.db, config, "retry");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
    const task = settings.store.getTask(id);
    if (task === undefined) {
      process.stderr.write(`task not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    if (task.status !== "FAILED") {
      process.stderr.write(`task ${id} is ${task.status}, not FAILED — retry requires a FAILED task\n`);
      process.exitCode = 1;
      return;
    }
    if (task.leaseOwner !== null) {
      process.stderr.write(`task ${id} is leased by '${task.leaseOwner}' — retry refused while leased\n`);
      process.exitCode = 1;
      return;
    }
    if (task.attempts >= config.retry.maxAttempts) {
      process.stderr.write(
        `attempt cap reached (${task.attempts}/${config.retry.maxAttempts}) — manual retry cannot bypass the cap\n`,
      );
      process.exitCode = 1;
      return;
    }
    const category = classifyFailure(task);
    if (category === undefined && !confirmUnsafe) {
      process.stderr.write(
        `failure of task ${id} is not auto-retryable (ambiguous, malformed or unclassified) — pass --confirm-unsafe to retry it anyway\n`,
      );
      process.exitCode = 1;
      return;
    }
    const unsafe = category === undefined;
    const chosen = category ?? "legacy";
    const reason = unsafe
      ? "manual retry confirmed with --confirm-unsafe (unclassified failure)"
      : `manual retry of ${chosen}`;
    // Two guarded transactions; a crash in between leaves a scheduled retry
    // whose eligibleAt is now — the regular retry-due pass requeues it.
    if (isFailureRecorded(task)) {
      const requeue = settings.store.requeueRetryWithCoordinator(id, authority);
      if (requeue.status !== "requeued") {
        process.stderr.write(`retry refused: ${requeue.cause ?? requeue.status}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`requeued ${id} for manual retry (attempt ${task.attempts}/${config.retry.maxAttempts}, ${chosen})\n`);
      return;
    }
    const scheduled = settings.store.scheduleRetryWithCoordinator(id, authority, {
      category: chosen,
      reason,
      eligibleAt: Date.now(),
      maxAttempts: config.retry.maxAttempts,
    });
    if (scheduled.status === "exhausted") {
      process.stderr.write(`attempt cap reached for ${id} (exhausted) — manual retry cannot bypass the cap\n`);
      process.exitCode = 1;
      return;
    }
    if (scheduled.status !== "scheduled") {
      process.stderr.write(`retry refused: ${scheduled.cause ?? scheduled.status}\n`);
      process.exitCode = 1;
      return;
    }
    const requeue = settings.store.requeueRetryWithCoordinator(id, authority);
    if (requeue.status !== "requeued") {
      process.stderr.write(`retry scheduled but requeue failed: ${requeue.cause ?? requeue.status}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `requeued ${id} for manual retry (attempt ${task.attempts}/${config.retry.maxAttempts}, ${chosen})\n`,
    );
  } catch (err) {
    process.stderr.write(`retry error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    if (authority !== undefined) releaseInstanceLock(settings.db, authority.owner);
    settings.close();
  }
}

function isFailureRecorded(task: { executionMetadata: Record<string, unknown> }): boolean {
  const failure = task.executionMetadata["failure"];
  return failure !== null && typeof failure === "object";
}

async function doctor(args: string[]): Promise<void> {
  const checks: Array<{ name: string; state: "ok" | "fail" | "skip"; note?: string }> = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: `runtime (node ${process.versions.node})`,
    state: nodeMajor >= 24 ? "ok" : "fail",
    note: nodeMajor >= 24 ? undefined : "node >= 24 required",
  });

  const useMock = args.includes("--mock");
  let config: OrchestratorConfig;
  try {
    config = resolveConfig();
  } catch (err) {
    process.stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  checks.push({
    name: "config",
    state: "ok",
    note: `${config.model} @ ${config.endpoint} (dir: ${config.projectDirectory})`,
  });

  let dbState: "ok" | "fail";
  try {
    const settings = openStore(defaultDbPath());
    settings.store.listTasks();
    settings.close();
    dbState = "ok";
  } catch (err) {
    dbState = "fail";
    process.stderr.write(`db check error: ${String(err)}\n`);
  }
  checks.push({ name: "database", state: dbState, note: defaultDbPath() });

  if (dbState === "ok") {
    try {
      dbProbe();
      checks.push({ name: "queue", state: "ok" });
    } catch {
      checks.push({ name: "queue", state: "fail" });
    }
  } else {
    checks.push({ name: "queue", state: "skip" });
  }

  function dbProbe(): void {
    const db = openDatabase(defaultDbPath());
    try {
      const queue = new TaskQueue(db);
      if (queue.size() < 0) throw new Error("unreachable");
    } finally {
      closeDatabase(db);
    }
  }

  if (useMock) {
    checks.push({ name: "opencode", state: "skip", note: "--mock requested" });
  } else {
    const agent = new LiveOpenCodeAdapter({
      projectDirectory: config.projectDirectory,
      model: config.model,
      port: config.port,
      startupTimeoutMs: config.startupTimeoutMs,
      endpoint: config.endpoint,
    });
    try {
      const url = await agent.probe();
      checks.push({ name: "opencode", state: "ok", note: url });
    } catch (err) {
      checks.push({
        name: "opencode",
        state: "fail",
        note: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    } finally {
      await agent.close();
    }
  }

  let exit = 0;
  for (const c of checks) {
    process.stdout.write(`${c.state.padEnd(4)}  ${c.name}${c.note ? ` — ${c.note}` : ""}\n`);
    if (c.state === "fail") exit = 1;
  }
  process.stdout.write(`doctor: ${exit === 0 ? "all required checks passed" : "at least one check failed"}\n`);
  process.exitCode = exit;
}

async function run(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  const maxIdx = args.indexOf("--max");
  const max = maxIdx >= 0 && args[maxIdx + 1] !== undefined ? Math.max(1, Number(args[maxIdx + 1])) : 1;
  let config: OrchestratorConfig;
  try {
    config = resolveConfig();
  } catch (err) {
    process.stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const directory = config.projectDirectory;

  let adapter;
  if (useMock) {
    adapter = new MockOpenCodeAdapter((i) => `mock executed: ${i.title}`);
  } else {
    adapter = new LiveOpenCodeAdapter({
      projectDirectory: directory,
      model: config.model,
      agent: config.agent,
      port: config.port,
      startupTimeoutMs: config.startupTimeoutMs,
      endpoint: config.endpoint,
    });
  }

  const settings = openStore(defaultDbPath());
  const lifecycle = lifecycleLoggerFor(args);
  let authority: CoordinatorAuthority | undefined;
  try {
    try {
      authority = acquireCoordinator(settings.db, config, "run");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
    const heartbeat = setInterval(() => {
      if (!renewInstanceLock(settings.db, authority!)) {
        lockLost = true;
        process.stdout.write("instance lock lost — aborting further writes\n");
      }
    }, Math.max(1000, Math.floor(config.lockTtlMs / 3)));
    let lockLost = false;
    // Exit-code contract: mirror `cycle` — a FAILED outcome is an execution
    // failure (runner records the verdict via recordVerdictHeld and clears the
    // lease) and must set exit 1; VERIFYING means the task executed
    // successfully and only awaits verification, so it stays exit 0.
    let failed = false;
    try {
      for (let i = 0; i < max; i++) {
        const outcome = await executeNext(settings.db, settings.store, adapter, {
          directory,
          coordinator: authority,
          taskLeaseTtlMs: config.taskLeaseTtlMs,
          ...(lifecycle !== undefined ? { lifecycle } : {}),
        });
        if (outcome === undefined) {
          process.stdout.write("queue empty\n");
          break;
        }
        if (outcome.state === "coordinator-disowned") {
          process.stdout.write(`${outcome.task.id} coordinator-disowned — instance lock lost; result discarded\n`);
          lockLost = true;
          break;
        }
        process.stdout.write(
          `${outcome.task.id} ${outcome.state} — ${outcome.output.slice(0, 200)}\n`,
        );
        if (outcome.state === "FAILED") failed = true;
        if (lockLost) break;
      }
      if (failed) process.exitCode = 1;
    } finally {
      clearInterval(heartbeat);
      if (authority !== undefined) releaseInstanceLock(settings.db, authority.owner);
    }
  } finally {
    lifecycle?.close();
    await adapter.close();
    settings.close();
  }
}

function resolveAreaArg(args: string[]): string[] | undefined {
  const idx = args.indexOf("--area");
  if (idx < 0 || args[idx + 1] === undefined) return undefined;
  const list = String(args[idx + 1])
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  return list.length > 0 ? list : undefined;
}

function liveAdapter(config: OrchestratorConfig, configOverrides?: Record<string, unknown>): LiveOpenCodeAdapter {
  return new LiveOpenCodeAdapter({
    projectDirectory: config.projectDirectory,
    model: config.model,
    port: config.port,
    startupTimeoutMs: config.startupTimeoutMs,
    endpoint: config.endpoint,
    ...(configOverrides !== undefined ? { configOverrides } : {}),
  });
}

/**
 * Discovery pass, guarded by the coordinator instance lock.
 *
 * `adapter` is optional: the CLI entry point always supplies the live adapter
 * (see `liveAdapter`), while in-process callers that need deterministic
 * behaviour — or want to prove the error paths release their resources — may
 * pass a mock.
 */
/**
 * Dry-run note. A dry run DOES perform operational writes — it opens the
 * database file and acquires/renews/releases the coordinator instance lock —
 * so "nothing was persisted" would be false. The note names exactly what a
 * dry run does not write (proposals → tasks, discovery runs, the run
 * manifest) and what it does (database + coordinator lock), so the pinned
 * output contract cannot be mistaken for a fully write-free run.
 */
const DRY_RUN_NOTE =
  "dry run — no proposals or discovery runs were persisted (operational writes: database + coordinator lock)";

export async function discover(args: string[], adapter?: OpenCodeAdapter): Promise<void> {
  const dryRun = args.includes("--dry-run");
  let config: OrchestratorConfig;
  try {
    config = resolveConfig();
  } catch (err) {
    process.stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const areaList = resolveAreaArg(args);
  let discoveryAreas;
  try {
    // `selectAreas` never throws — unknown areas fall back to all areas for
    // library callers. CLI entry points validate explicitly so they can report
    // the error and exit.
    validateRequestedAreas(areaList);
    discoveryAreas = selectAreas(areaList);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stdout.write(`valid areas: ${ALL_DISCOVERY_AREAS.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  const areas = discoveryAreas.map((a) => a.key);

  // The coordinator lock is acquired before any discovery work runs, so a
  // foreign lock is refused up front instead of after the engine has already
  // executed. The lock is released in the outermost `finally` below, which
  // runs for every outcome (dry run, persistence, engine error); the
  // database follows it, so the lock row is still writable at release time.
  let db: DatabaseSync | undefined = undefined;
  let authority: CoordinatorAuthority | undefined;
  // Lock heartbeat handle (outermost scope so the outermost finally can stop
  // it before the lock is released) and the write-refusal flag it raises.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let persistenceRefused = false;
  let result;
  let acceptedCount = 0;
  const acceptedIds: string[] = [];
  // One shared lifecycle logger for the whole command (opt-in via the flag).
  const lifecycle = lifecycleLoggerFor(args);

  try {
    db = openDatabase(defaultDbPath());
    try {
      authority = acquireCoordinator(db, config, "discover");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }

    // Coordinator heartbeat: a discovery prompt can run for minutes per area
    // (the prompt timeout alone defaults to 420s), far past the instance-lock
    // TTL, so the lock is renewed on the same TTL/3 cadence `run` and `cycle`
    // use. A failed renewal means the lock was lost or stolen: `lockLost`
    // stops the engine between areas (via shouldStop below) and refuses every
    // persistence path below — a disowned coordinator must not write.
    let lockLost = false;
    heartbeat = setInterval(() => {
      if (db === undefined || authority === undefined) return;
      if (renewInstanceLock(db, authority)) return;
      if (lockLost) return;
      lockLost = true;
      process.stderr.write("instance lock lost — stopping discovery; refusing to persist results\n");
      lifecycle?.log("ERROR", "discover", "lock", "lost", {
        detail: "instance lock lost — stopping discovery; refusing to persist results",
      });
    }, Math.max(1000, Math.floor(config.lockTtlMs / 3)));
    // Ownership probe used before each area and before every write: mirrors
    // the guard's predicate (owner + generation + unexpired) without renewing,
    // so a lock that a guarded write would refuse is also refused here.
    const stillHoldsLock = (): boolean =>
      db !== undefined && authority !== undefined && holdsInstanceLock(db, authority);
    // Single refusal predicate for cancellation (shouldStop) and for the
    // persistence gates below: either the heartbeat already observed a failed
    // renewal, or the row no longer belongs to us right now.
    const lockRefused = (): boolean => lockLost || !stillHoldsLock();

    // `adapter ?? liveAdapter(...)`: the seam above is optional — the CLI
    // entry point builds the live adapter here, test callers may pass a mock.
    // The discovery server is spawned read-only via DISCOVERY_SERVER_CONFIG:
    // without it the model can write files / run shell commands (session-level
    // v2 permissions are not enforced by opencode 2.2.6; see discovery.ts).
    const discoveryAdapter = adapter ?? liveAdapter(config, DISCOVERY_SERVER_CONFIG);
    const engine = new DiscoveryEngine(discoveryAdapter, {
      repoDir: config.projectDirectory,
      model: config.model,
      dryRun,
      areas,
      maxProposalsPerArea: config.discoveryMaxProposals,
      // Stop between areas when the instance lock was lost (heartbeat above):
      // no further model requests are submitted, and run() skips the
      // run-manifest write, so a disowned coordinator cannot keep working or
      // persist a partial run.
      shouldStop: () => lockRefused(),
      // Interactive runs report which area is being analyzed — without this a
      // slow model run looks like a frozen process for the whole prompt
      // timeout. Scripted runs (piped stdout) keep the pinned output contract.
      ...(process.stdout.isTTY === true
        ? {
            onAreaStart: (area: string, index: number, total: number) => {
              process.stdout.write(`discovery: analyzing area '${area}' (${index}/${total})…\n`);
            },
          }
        : {}),
      ...(lifecycle !== undefined
        ? {
            // Bridge the engine's structured events onto the command's shared
            // logger (emitEvent preserves the event's own durationMs column).
            onLifecycle: (ev: LifecycleEvent) => lifecycle.emitEvent(ev),
          }
        : {}),
    });

    try {
      result = await engine.run();
    } finally {
      await discoveryAdapter.close();
    }

    // The auditor runs exactly once on the globally deduplicated proposal
    // set, immediately after discovery and before either output or
    // persistence. It is deterministic, read-only and filesystem-only — no
    // model call, no agent, no writes. Its verdicts are merged into the run's
    // `rejected` channel and are never persisted themselves.
    const audited = auditProposals(result, config.projectDirectory);
    // Verdicts are execution-local: the auditor's `rejected` channel is folded
    // into the run's existing `rejected` array, and nothing is persisted.
    result.proposals = audited.proposals;
    result.rejected = audited.rejected;

    // Reconcile the per-area channels with the post-audit verdicts. The audit
    // rejections carry their owning area, so the same proposal objects are
    // moved from the owning area's accepted channel into that area's rejected
    // channel — preserving area attribution, the auditor's reason and the raw
    // title — instead of only replacing the top-level arrays.
    {
      const auditRejections = audited.rejected;
      // Each Proposal object is owned by the first area that reported it
      // (cross-area dedupe keeps the first occurrence). Only that area's
      // accepted channel is drained, so a rejected proposal is never counted
      // twice across areas.
      const ownedBy: Map<Proposal, string> = new Map();
      for (const area of result.areas) {
        for (const proposal of area.proposals) {
          if (!ownedBy.has(proposal)) ownedBy.set(proposal, area.area);
        }
      }
      // The rejection is matched by the proposal's raw title, not by the
      // rejection's own `area` field: that field is derived from the cited
      // evidence file (auditor.ts:areaFromPath), which need not be the area
      // that generated the proposal.
      const rejectedByTitle = new Map<string, RejectedProposal>();
      for (const rejection of auditRejections) {
        if (rejection.area === "cross-area") continue;
        rejectedByTitle.set(rejection.raw, rejection);
      }
      for (const area of result.areas) {
        const moved: Proposal[] = [];
        area.proposals = area.proposals.filter((proposal) => {
          // Only drain the proposal's owning area; other areas keep the
          // cross-area duplicate in their own accepted channel.
          if (ownedBy.get(proposal) !== area.area || rejectedByTitle.has(proposal.title) === false) return true;
          moved.push(proposal);
          return false;
        });
        for (const proposal of moved) {
          const rejection = rejectedByTitle.get(proposal.title);
          if (rejection !== undefined) {
            area.rejected.push(rejection);
          }
        }
      }
    }

    lifecycle?.log("INFO", "discover", "audit", "completed", {
      accepted: result.proposals.length,
      rejected: result.rejected.length,
    });

    // The manifest was written by engine.run() BEFORE the auditor ran, so it
    // still carries the pre-audit proposal set. Re-persist the audited result
    // so the resumable-run manifest matches the verdicts that were reported:
    // only VALID proposals are accepted, and the auditor's rejections are
    // recorded in the manifest's existing `rejected` array. Gated on still
    // holding the instance lock: a run the model finished after lock loss
    // must not be written either.
    if (dryRun !== true && !lockRefused()) {
      result.persisted = await engine.persist(result, engine.cacheDir);
    }

    // One refusal path for the pre-write gate and for a mid-write
    // CoordinatorDisownedError: report on stderr (unless the heartbeat
    // already reported the loss), fail the command, and skip every remaining
    // write. Nothing below this point touches the database or the manifest.
    const refusePersistence = (): void => {
      persistenceRefused = true;
      process.exitCode = 1;
      if (!lockLost) {
        lockLost = true;
        process.stderr.write("instance lock lost — refusing to persist discovery results\n");
        lifecycle?.log("ERROR", "discover", "lock", "lost", {
          detail: "instance lock lost — refusing to persist discovery results",
        });
      }
    };

    for (const area of result.areas) {
      process.stdout.write(
        `area ${area.area}: ${area.status === "ok" ? `ok (${area.proposals.length} proposals, ${area.rejected.length} rejected)` : `ERROR — ${area.error ?? "unknown"}`}\n`,
      );
    }

    if (dryRun) {
      // Same contract as the persistence branch: at least one area error must
      // read as failure. (A dry run that failed every area used to exit 0 —
      // observed live with the 420s model prompt timeout.)
      if (result.areas.some((a) => a.status === "error")) process.exitCode = 1;
      printProposals(result.areas, result.proposals, DRY_RUN_NOTE);
    } else if (lockRefused()) {
      // Pre-write ownership check: the model run outlasted the lock (or the
      // heartbeat already saw it taken). The guarded transactions below would
      // throw anyway — refuse here so the refusal is reported once, before
      // any write is attempted.
      refusePersistence();
    } else {
      try {
        fs.mkdirSync(path.dirname(defaultDbPath()), { recursive: true });
        const store = new TaskStore(db);
        const runs = new DiscoveryRunStore(db);
        const runId = runs.start(discoveryAreas, config.model, authority);
        persistProposals(store, result, { model: config.model }, authority, (id: string) => {
          acceptedCount++;
          acceptedIds.push(id);
        });
        const failedAreas = result.areas.filter(
          (a): a is AreaResult & { status: "error" } => a.status === "error",
        );
        runs.complete(
          runId,
          {
            areasCompleted: result.areas.length - failedAreas.length,
            rawProposals: result.proposals.length + result.rejected.length,
            accepted: acceptedCount,
            rejected: result.rejected.length,
          },
          authority,
          failedAreas.length === 0
            ? undefined
            : `area failures: ${failedAreas.map((a) => `${a.area}: ${String(a.error).slice(0, 120)}`).join("; ")}`,
        );
        if (failedAreas.length > 0) process.exitCode = 1;
      } catch (err) {
        // The lock can be lost between the gate above and (or inside) the
        // guarded transactions: report the refusal distinctly instead of
        // surfacing the raw guard error, and leave the writes uncompleted.
        if (err instanceof CoordinatorDisownedError) refusePersistence();
        else throw err;
      }
    }
  } finally {
    // Outermost release: stop the heartbeat BEFORE handing the lock back so a
    // queued renewal cannot fire against a released (or stolen) lock row, then
    // release on every exit path (dry run, persistence, refusal, early
    // `return`, engine error).
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (db !== undefined && authority !== undefined) {
      releaseInstanceLock(db, authority.owner);
    }
    if (db !== undefined) closeDatabase(db);
    lifecycle?.close();
  }

  // Output order is: area headers, then the accepted ids, then the
  // rejections, then the run summary. The accepted line must sit directly
  // under its area header (the mixed-case contract), and in the all-rejected
  // case there are no accepted lines, so the rejection lines still follow the
  // area headers directly as that case's exact output requires. Task ids
  // only exist after the persistProposals callback runs, so the ids are
  // collected there rather than read off result.proposals (which has no id
  // field). A dry run prints neither the accepted ids nor the run summary —
  // it only prints the proposals and the dry-run note. A refused run (lock
  // lost) prints no "run stored" summary either: nothing was stored.
  for (const id of acceptedIds) {
    process.stdout.write(`accepted ${id}\n`);
  }
  for (const rejected of result.rejected) {
    process.stdout.write(`  rejected: ${rejected.raw} — ${rejected.reason}\n`);
  }
  if (!dryRun && !persistenceRefused) {
    process.stdout.write(
      `discovery run completed: ${acceptedCount} tasks created from ${result.proposals.length} proposals (${result.rejected.length} rejected); run stored\n`,
    );
  }
}

function printProposals(_areas: AreaResult[], proposals: Proposal[], note: string): void {
  if (proposals.length === 0) {
    process.stdout.write(`no proposals (${note})\n`);
    return;
  }
  for (const p of proposals) {
    process.stdout.write(
      `[${p.priority}] (${p.complexity}) ${p.title}\n  evidence: ${p.evidence.map((e) => e.file).join(", ")}\n  problem: ${p.problem.slice(0, 220)}\n  verify: ${p.verification[0] ?? "-"}\n`,
    );
  }
  process.stdout.write(note + "\n");
}

/**
 * Validates `plan` arguments before the database is opened or mutated.
 *
 * Any `-`-prefixed argument that is not a known plan flag is unknown and is
 * rejected here. A value-taking flag (declared in PLAN_VALUE_FLAGS) is
 * rejected when its value is missing or malformed.
 *
 * Validation deliberately runs before `resolveConfig()` and before
 * `openDatabase()`, so an invalid invocation cannot create tasks.db, acquire
 * the coordinator lock, or re-plan anything.
 *
 * Positional (non-flag) arguments are never rejected: the current CLI
 * contract does not define any for `plan`, and callers that pass stray words
 * through must keep working.
 *
 * Returns the offending arguments. If non-empty, the caller writes the
 * error to stderr, sets process.exitCode, and returns without planning.
 */
export function validatePlanArgs(args: string[]): string[] {
  const unknown: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== undefined && arg.startsWith("-") && arg.length > 1) {
      if (PLAN_VALUE_FLAGS.has(arg)) {
        const value = args[i + 1];
        if (value === undefined) {
          process.stderr.write(`${arg} requires a value\n`);
          process.exitCode = 1;
          return [...unknown, arg];
        }
        const kind = PLAN_VALUE_FLAGS.get(arg) ?? "text";
        if (kind === "number" && !/^\d+$/.test(value)) {
          process.stderr.write(`${arg} must be a non-negative integer, got ${value}\n`);
          process.exitCode = 1;
          return [...unknown, arg];
        }
        // consume the value
        const idx = args.indexOf(arg);
        if (idx + 1 < args.length) args.splice(idx + 1, 1);
      } else {
        unknown.push(arg);
      }
    }
  }
  return unknown;
}

function plan(args: string[]): void {
  // `--lifecycle` is this command's opt-in observer flag, not a planning
  // argument: strip it before validation because `validatePlanArgs` rejects
  // any unknown `-`-prefixed flag.
  const lifecycle = lifecycleLoggerFor(args);
  const planArgs = args.filter((a) => a !== "--lifecycle");
  // Validate arguments before opening or mutating the database: an invalid
  // invocation must never create tasks.db, take the coordinator lock, or
  // re-plan anything.
  const unknown = validatePlanArgs(planArgs);
  if (unknown.length > 0) {
    process.stderr.write(`plan: unknown argument: ${unknown[0]}\n`);
    process.exitCode = 1;
    lifecycle?.close();
    return;
  }
  let config: OrchestratorConfig;
  try {
    config = resolveConfig();
  } catch (err) {
    process.stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    lifecycle?.close();
    return;
  }
  fs.mkdirSync(path.dirname(defaultDbPath()), { recursive: true });
  const db = openDatabase(defaultDbPath());
  let planAuthority: CoordinatorAuthority | undefined;
  try {
    try {
      planAuthority = acquireCoordinator(db, config, "plan");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      lifecycle?.error("plan", "lock", `instance lock acquisition refused: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    lifecycle?.start("plan", "plan");
    const reports: PlanReportEntry[] = planDiscoveredTasks(db, config.projectDirectory, planAuthority);
    if (reports.length === 0) {
      process.stdout.write("nothing to plan\n");
      lifecycle?.complete("plan", "plan", { promoted: 0, total: 0 });
      return;
    }
    for (const entry of reports) {
      process.stdout.write(`${entry.decision.toUpperCase().padEnd(10)} ${entry.taskId} ${entry.title} — ${entry.reason}\n`);
    }
    const ready = reports.filter((r) => r.decision === "ready" || r.decision === "cleared").length;
    process.stdout.write(`plan complete: ${ready} task(s) ready for the execution queue, ${reports.length - ready} not ready\n`);
    lifecycle?.complete("plan", "plan", { promoted: ready, total: reports.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`plan error: ${message}\n`);
    process.exitCode = 1;
    lifecycle?.error("plan", "plan", `planning failed: ${message}`);
  } finally {
    if (planAuthority !== undefined) releaseInstanceLock(db, planAuthority.owner);
    closeDatabase(db);
    lifecycle?.close();
  }
}

function tasks(args: string[]): void {
  let state: TaskState | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state" && args[i + 1] !== undefined) {
      state = String(args[i + 1]) as TaskState;
      i++;
    }
  }
  if (state !== undefined && !TASK_STATES.includes(state)) {
    process.stderr.write(`unknown state: ${String(state)}\n`);
    process.exitCode = 1;
    return;
  }
  const settings = openStore(defaultDbPath());
  try {
    const all = settings.store.listTasks(state);
    if (all.length === 0) {
      process.stdout.write("(no tasks)\n");
      return;
    }
    process.stdout.write(`database: ${settings.dbPath}\n`);
    for (const t of all) {
      const plan = t.executionMetadata["plan"] as PlanMeta | undefined;
      const complexity = plan?.complexity ?? (typeof t.executionMetadata["complexity"] === "string" ? String(t.executionMetadata["complexity"]) : "-");
      const deps =
        plan?.unmetDependencies !== undefined && plan.unmetDependencies.length > 0
          ? ` deps⁉=${plan.unmetDependencies.length}`
          : plan?.dependencies !== undefined && plan.dependencies.length > 0
            ? ` deps=${plan.dependencies.length}`
            : "";
      const conflicts = plan?.conflictWith !== undefined && plan.conflictWith.length > 0 ? ` conflict:${plan.conflictWith.join("/")}` : "";
      process.stdout.write(
        `${t.id}  ${t.status.padEnd(12)} p=${t.priority} c=${complexity}${deps}${conflicts}  ${t.title}\n`,
      );
    }
  } finally {
    settings.close();
  }
}

/** Canned discovery reply for `cycle --mock`: one simple, fully valid
 * proposal so mock cycles exercise the complete pipeline deterministically.
 * Evidence references files that exist inside the orchestrator repo itself. */
export const MOCK_DISCOVERY_REPLY = JSON.stringify([
  {
    title: "Document the queue claim invariant",
    problem: "An in-transaction candidate followed by a zero-row claim UPDATE is an invariant violation.",
    rationale: "An explicitly pinned claim invariant keeps the single-step runner contract observable.",
    evidence: [
      {
        file: "src/queue.ts",
        symbol: "claimTask",
        observation: "an in-transaction candidate followed by a zero-row claim UPDATE is an invariant violation",
      },
    ],
    approach: "Record the invariant in the claimTask contract comment and pin it with an existing queue test.",
    outcome: "The claim semantics are explicit and enforced by the current test suite.",
    priority: 6,
    complexity: "low",
    verification: ["npm test"],
  },
]);

/**
 * Parses a cycle numeric limit. Returns `undefined` when the flag is absent
 * (caller uses its default), and `null` when the flag is present but its value
 * is missing or non-integer — in which case the error has already been written
 * to stderr and process.exitCode set to 1, so the caller must not proceed.
 * Valid values are clamped upward from `floor` as the cycle semantics require
 * (max-executions >= 0, max-rounds >= 1).
 */
function parseCycleLimit(args: string[], flag: string, floor: number): number | null | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (value === undefined) {
    process.stderr.write(`${flag} requires a numeric value\n`);
    process.exitCode = 1;
    return null;
  }
  if (!/^\d+$/.test(value)) {
    process.stderr.write(`${flag} must be a non-negative integer, got ${value}\n`);
    process.exitCode = 1;
    return null;
  }
  return Math.max(floor, Number(value));
}

async function cycle(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  const mockFail = args.includes("--mock-fail");
  const skipDiscovery = args.includes("--no-discovery");
  const maxExecutions = parseCycleLimit(args, "--max-executions", 0);
  const maxRounds = parseCycleLimit(args, "--max-rounds", 1);
  if (maxExecutions === null || maxRounds === null) return;
  // max-executions defaults to 1 (not 0) when the flag is omitted; max-rounds
  // is optional, so `undefined` there means "no round cap".
  const maxExecutionsValue = maxExecutions ?? 1;
  const maxRoundsValue = maxRounds;
  const areaList = resolveAreaArg(args);

  let config: OrchestratorConfig;
  try {
    config = resolveConfig();
  } catch (err) {
    process.stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const directory = config.projectDirectory;

  // One reply function discriminates stage kinds so mock cycles are fully
  // deterministic: discovery prompts are titled "Discovery: <area>",
  // verification prompts start with "VERIFY TASK:", everything else executes.
  const mockReply = (input: { title: string; description: string }): string => {
    if (input.title.startsWith("Discovery:")) return MOCK_DISCOVERY_REPLY;
    if (input.description.startsWith("VERIFY TASK:")) {
      return mockFail
        ? "mock answer\nVERDICT: FAIL — mock verification was configured to fail"
        : "mock answer\nVERDICT: PASS — mock checks succeeded";
    }
    return `mock executed: ${input.title}`;
  };

  let discoveryAdapter;
  let executionAdapter;
  if (useMock) {
    discoveryAdapter = new MockOpenCodeAdapter(mockReply);
    executionAdapter = new MockOpenCodeAdapter(mockReply);
  } else {
    discoveryAdapter = liveAdapter(config, DISCOVERY_SERVER_CONFIG);
    executionAdapter = new LiveOpenCodeAdapter({
      projectDirectory: directory,
      model: config.model,
      agent: config.agent,
      port: config.port,
      startupTimeoutMs: config.startupTimeoutMs,
      endpoint: config.endpoint,
    });
  }

  const settings = openStore(defaultDbPath());
  const lifecycle = lifecycleLoggerFor(args);
  try {
    const summary = await runCycle({
      db: settings.db,
      directory,
      ...(!skipDiscovery
        ? {
            discovery: {
              adapter: discoveryAdapter,
              repoDir: directory,
              model: config.model,
              ...(areaList !== undefined ? { areas: areaList } : {}),
              maxProposalsPerArea: config.discoveryMaxProposals,
            },
          }
        : {}),
      executionAdapter,
      maxExecutions: maxExecutionsValue,
      ...(maxRoundsValue !== undefined ? { maxRounds: maxRoundsValue } : {}),
      retry: config.retry,
      taskLeaseTtlMs: config.taskLeaseTtlMs,
      lockTtlMs: config.lockTtlMs,
      recoverOnStart: config.recoverOnStart,
      onOutput: (line) => process.stdout.write(`${line}\n`),
      ...(lifecycle !== undefined ? { lifecycle } : {}),
    });
    process.stdout.write(
      `cycle: ${summary.rounds} round(s), ${summary.discoveredAccepted} discovered, ${summary.plannedReady} planned, ${summary.executed} executed (${summary.executionFailures} execution failure(s)), ${summary.verifiedPass} verified DONE, ${summary.verifiedFail} verified FAILED — stopped: ${summary.stopReason}\n`,
    );
    if (summary.verifiedFail > 0 || summary.executionFailures > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`cycle error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    lifecycle?.close();
    await discoveryAdapter.close();
    await executionAdapter.close();
    settings.close();
  }
}

/**
 * Explicit recovery pass (`orchestrator recover`), guarded by the instance
 * lock:
 *  - re-stamp leases for interrupted executions/verifications (lease-expiry
 *    based; fresh foreign leases are never stolen),
 *  - schedule retries for classified FAILED tasks,
 *  - requeue FAILED tasks whose retry eligibility has passed,
 *  - interrupt discovery runs left 'running' by a crashed process — only with
 *    --confirm-unsafe, because discovery-run rows carry no lease that would
 *    prove the run is dead.
 * Ordinary store opening stays read-only with respect to tracking state —
 * recovery happens only here (discovery runs) or here and at cycle start
 * (task leases).
 */
function recoverTaskQueue(args: string[]): void {
  // discovery runs carry no lease, so interrupting them is never automatic:
  // the operator confirms with --confirm-unsafe (same contract as task retry)
  const confirmUnsafe = args.includes("--confirm-unsafe");
  let config: OrchestratorConfig;
  try {
    config = resolveConfig();
  } catch (err) {
    process.stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const settings = openStore(defaultDbPath());
  let authority: CoordinatorAuthority | undefined;
  try {
    try {
      authority = acquireCoordinator(settings.db, config, "recover");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
    const recovery: RecoveryReport = recoverInterruptedTasks(settings.store, authority, config.taskLeaseTtlMs);
    const scheduling: RetrySchedulingReport = scheduleFailedRetries(settings.store, authority, config.retry);
    const due: RetryDueReport = requeueRetryDueTasks(settings.store, authority);
    // discovery-run recovery is explicit and confirmed: without --confirm-unsafe
    // the pass only reports the crashed runs it would interrupt
    const runs = new DiscoveryRunStore(settings.db);
    const discoveryRuns = runs.recoverInterruptedRuns(authority, { confirmed: confirmUnsafe });
    process.stdout.write(`recovery: ${recovery.recovered} task(s) re-stamped\n`);
    for (const s of recovery.skipped) process.stdout.write(`  skipped ${s.taskId}: ${s.cause ?? "no change"}\n`);
    process.stdout.write(
      `retry scheduling: ${scheduling.scheduled} scheduled, ${scheduling.exhausted} exhausted\n`,
    );
    for (const s of scheduling.skipped) process.stdout.write(`  skipped ${s.taskId}: ${s.cause ?? "no change"}\n`);
    process.stdout.write(`retry-due: ${due.requeued} task(s) requeued\n`);
    for (const s of due.skipped) process.stdout.write(`  skipped ${s.taskId}: ${s.cause ?? "no change"}\n`);
    if (discoveryRuns.interrupted > 0) {
      process.stdout.write(`discovery runs: ${discoveryRuns.interrupted} interrupted\n`);
    }
    for (const p of discoveryRuns.pending) {
      process.stdout.write(`  pending discovery run ${p.id}: ${p.cause}\n`);
    }
  } catch (err) {
    process.stderr.write(`recover error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    if (authority !== undefined) releaseInstanceLock(settings.db, authority.owner);
    settings.close();
  }
}
