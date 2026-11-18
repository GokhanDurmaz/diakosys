import type { DatabaseSync } from "node:sqlite";
import type { OpenCodeAdapter } from "./opencode.ts";
import { DiscoveryEngine, selectAreas, validateRequestedAreas } from "./discovery.ts";
import { planDiscoveredTasks, type PlanReportEntry } from "./planner.ts";
import { persistProposals } from "./persist.ts";
import { TaskQueue } from "./queue.ts";
import { executeNext } from "./runner.ts";
import { TaskStore } from "./store.ts";
import { verifyTask } from "./verify.ts";
import {
  acquireInstanceLock,
  releaseInstanceLock,
  renewInstanceLock,
  coordinatorOwner,
  type CoordinatorAuthority,
} from "./coordinator.ts";
import {
  recoverInterruptedTasks,
  scheduleFailedRetries,
  requeueRetryDueTasks,
  type RecoveryReport,
  type RetrySchedulingReport,
  type RetryDueReport,
} from "./recovery.ts";
import type { RetryPolicy } from "./retry.ts";
import type { LifecycleLogger } from "./lifecycle.ts";

/** One composed orchestration pass. */
export interface CycleOptions {
  db: DatabaseSync;
  /** Revalidation base directory for the planner (defaults to `directory`). */
  repoDir?: string;
  /** Prompt target directory (what the execution/verification adapter sees). */
  directory: string;
  /** Discovery stage — omitted entirely to start the cycle at the planner. */
  discovery?: {
    adapter: OpenCodeAdapter;
    repoDir: string;
    model: string;
    /** lowercase area keys; undefined = all areas */
    areas?: string[];
    /** max accepted proposals per area (discovery engine requires it) */
    maxProposalsPerArea: number;
    /** read-only analysis prompt timeout (DiscoveryOptions requires it) */
    promptTimeoutMs: number;
    /** Isolated cacheDir for the engine's runs.json manifest — tests MUST
     * pass a temp dir so the real $HOME cache is never written. */
    cacheDir?: string;
  };
  /** Adapter used for task execution prompts. */
  executionAdapter: OpenCodeAdapter;
  /** Adapter used for verification prompts; defaults to executionAdapter. */
  verificationAdapter?: OpenCodeAdapter;
  /** Hard cap on total executions across all rounds. */
  maxExecutions: number;
  /** Hard cap on plan/execute rounds (guards against cycles). Default 10. */
  maxRounds?: number;
  /** Retry policy for FAILED tasks with auto-retry categories. */
  retry: RetryPolicy;
  /** Recovery + retry scheduling before the first round. Default true. */
  recoverOnStart?: boolean;
  /** Task lease TTL override (ms); default 2× max of the prompt timeouts. */
  taskLeaseTtlMs?: number;
  /** Instance lock TTL override (ms). */
  lockTtlMs?: number;
  /** Instance-lock owner override (tests); default `cycle_<pid>_<rand>`. */
  lockOwner?: string;
  /** Skip the runner's in-prompt heartbeat (deterministic tests). */
  noHeartbeat?: boolean;
  /** Optional real-time lifecycle observer; its output is routed through
   *  `onOutput`, so unit tests with `onOutput: () => undefined` stay silent
   *  while CLI runs stay on stdout. */
  lifecycle?: LifecycleLogger;
  onOutput?: (line: string) => void;
}

export type CycleStopReason = "no-progress" | "execution-limit" | "round-limit";

export interface CycleSummary {
  rounds: number;
  discoveredAccepted: number;
  /** planner decisions per round that promoted tasks to READY */
  plannedReady: number;
  executed: number;
  executionFailures: number;
  verifiedPass: number;
  verifiedFail: number;
  stopReason: CycleStopReason;
  /** instance lock was lost mid-cycle; results after that are discarded */
  disowned: boolean;
  recovery: RecoveryReport;
  retryScheduling: RetrySchedulingReport;
  retryRequeued: number;
  events: string[];
}

const DEFAULT_MAX_ROUNDS = 10;

/**
 * Compose the existing stages — discovery → planning → queue → execution →
 * verification — under the orchestrator's instance lock. The lock is
 * acquired before any write and renewed while prompts run (TTL/3 interval).
 * Stage order per run:
 *   0. recovery of interrupted leases + retry scheduling + retry-due requeue
 *   1. (round 1 only) discovery persisted atomically per proposal
 *   2. plan: promote BACKLOG tasks whose prerequisites/conflicts cleared
 *   3. execute and verify queued tasks, up to maxExecutions in total
 * Termination: a round that neither promotes, executes, nor verifies
 * anything makes no progress and the cycle stops ("no-progress"); the
 * execution cap stops the cycle while work still queues ("execution-limit");
 * the round cap bounds the loop hard ("round-limit").
 */
export async function runCycle(options: CycleOptions): Promise<CycleSummary> {
  const store = new TaskStore(options.db);
  const emit = options.onOutput ?? (() => undefined);
  // Route lifecycle lines through the existing output sink so tests that
  // provide `onOutput: () => undefined` suppress them entirely.
  if (options.lifecycle !== undefined) {
    options.lifecycle.useSink(emit);
  }
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const verifier = options.verificationAdapter ?? options.executionAdapter;
  const recoverOnStart = options.recoverOnStart !== false;

  const taskLeaseTtlMs = options.taskLeaseTtlMs;
  if (taskLeaseTtlMs === undefined || taskLeaseTtlMs <= 0) {
    throw new Error("taskLeaseTtlMs must be positive (configures the execution lease TTL)");
  }
  const lockTtlMs = options.lockTtlMs ?? Math.max(120_000, taskLeaseTtlMs * 2);
  const lockOwner = options.lockOwner ?? coordinatorOwner("cycle");

  options.lifecycle?.start("cycle", "cycle", { rounds: maxRounds });

  const summary: CycleSummary = {
    rounds: 0,
    discoveredAccepted: 0,
    plannedReady: 0,
    executed: 0,
    executionFailures: 0,
    verifiedPass: 0,
    verifiedFail: 0,
    stopReason: "no-progress",
    disowned: false,
    recovery: { recovered: 0, skipped: [] },
    retryScheduling: { scheduled: 0, exhausted: 0, skipped: [] },
    retryRequeued: 0,
    events: [],
  };
  const note = (message: string): void => {
    summary.events.push(message);
    emit(message);
  };

  let coordinator: CoordinatorAuthority;
  try {
    coordinator = {
      owner: lockOwner,
      generation: acquireInstanceLock(options.db, lockOwner, lockTtlMs).generation,
      lockTtlMs,
    };
    options.lifecycle?.info("cycle", "lock", "instance lock acquired");
  } catch (err) {
    // The caller reports this as "cycle error: ..." on stderr with exit 1;
    // the lifecycle channel mirrors it as an error event.
    options.lifecycle?.error(
      "cycle",
      "lock",
      `instance lock acquisition refused: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  const lockHeartbeatMs = Math.max(1000, Math.floor(lockTtlMs / 3));
  const lockHeartbeat = setInterval(() => {
    const ok = renewInstanceLock(options.db, coordinator);
    if (!ok) {
      summary.disowned = true;
      options.lifecycle?.warn("cycle", "lock", "instance lock lost — stopping writes; release any pending results");
      note("cycle: instance lock lost — stopping writes; release any pending results");
    }
  }, lockHeartbeatMs);

  // Verifies a claimed task; the loop below calls once per successful claim.
  const finish = (summary: CycleSummary): CycleSummary => {
    options.lifecycle?.complete("cycle", "cycle", {
      stopReason: summary.stopReason,
      rounds: summary.rounds,
      discoveredAccepted: summary.discoveredAccepted,
      plannedReady: summary.plannedReady,
      executed: summary.executed,
      executionFailures: summary.executionFailures,
      verifiedPass: summary.verifiedPass,
      verifiedFail: summary.verifiedFail,
    });
    return summary;
  };

  try {
    if (recoverOnStart) {
      options.lifecycle?.start("cycle", "recovery");
      summary.recovery = recoverInterruptedTasks(store, coordinator, taskLeaseTtlMs);
      note(
        `recovery: ${summary.recovery.recovered} task(s) re-stamped, ${summary.recovery.skipped.length} skipped`,
      );
      summary.retryScheduling = scheduleFailedRetries(store, coordinator, options.retry);
      note(
        `retry scheduling: ${summary.retryScheduling.scheduled} scheduled, ${summary.retryScheduling.exhausted} exhausted`,
      );
      const due = requeueRetryDueTasks(store, coordinator);
      summary.retryRequeued = due.requeued;
      note(`retry-due pass: ${due.requeued} requeued for retry`);
      // requeued BACKLOG tasks flow through planning in the rounds below
      options.lifecycle?.complete("cycle", "recovery", {
        recovered: summary.recovery.recovered,
        skipped: summary.recovery.skipped.length,
        scheduled: summary.retryScheduling.scheduled,
        exhausted: summary.retryScheduling.exhausted,
        requeued: due.requeued,
      });
    } else {
      options.lifecycle?.info("cycle", "recovery", "skipped", { detail: "recoverOnStart=false — no recovery pass" });
    }

    for (let round = 1; round <= maxRounds; round++) {
      summary.rounds = round;
      let progressed = false;

      if (round === 1 && options.discovery !== undefined) {
        const d = options.discovery;
        options.lifecycle?.start("cycle", "discovery", { areas: selectAreas(d.areas).length });
        validateRequestedAreas(d.areas);
        const engine = new DiscoveryEngine(d.adapter, {
          repoDir: d.repoDir,
          model: d.model,
          promptTimeoutMs: d.promptTimeoutMs,
          maxProposalsPerArea: d.maxProposalsPerArea,
          ...(d.areas !== undefined ? { areas: selectAreas(d.areas).map((a) => a.key) } : {}),
          ...(d.cacheDir !== undefined ? { cacheDir: d.cacheDir } : {}),
          // Stop between areas (and skip the run-manifest write) once this
          // cycle's lock heartbeat has reported the instance lock lost — a
          // disowned coordinator must not keep submitting model requests.
          shouldStop: () => summary.disowned,
        });
        const result = await engine.run();
        persistProposals(
          store,
          result,
          { model: d.model },
          coordinator,
          (taskId) => {
            summary.discoveredAccepted++;
            note(`discovery accepted: ${taskId}`);
          },
        );
        if (summary.discoveredAccepted > 0) progressed = true;
        note(
          `discovery: ${result.proposals.length} proposal(s), ${result.rejected.length} rejected, ${summary.discoveredAccepted} persisted as tasks`,
        );
        options.lifecycle?.complete("cycle", "discovery", {
          areas: result.areas.length,
          proposals: result.proposals.length,
          rejected: result.rejected.length,
          persisted: result.persisted,
        });
      } else if (round === 1) {
        options.lifecycle?.info("cycle", "discovery", "skipped", { detail: "no discovery stage — cycle starts at planner" });
      }

      options.lifecycle?.start("cycle", "plan");
      let reports: PlanReportEntry[] = [];
      try {
        reports = planDiscoveredTasks(options.db, options.repoDir ?? options.directory, coordinator);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.lifecycle?.error("cycle", "plan", `planning failed: ${message}`);
        throw new Error(`cycle planning failed: ${message}`);
      }
      const promoted = reports.filter((r) => r.decision === "ready").length;
      if (promoted > 0) progressed = true;
      summary.plannedReady += promoted;
      for (const entry of reports) {
        note(`plan: ${entry.decision} ${entry.taskId} ${entry.title} — ${entry.reason}`);
      }
      options.lifecycle?.complete("cycle", "plan", { promoted: promoted });

      while (summary.executed < options.maxExecutions) {
        const outcome = await executeNext(options.db, store, options.executionAdapter, {
          directory: options.directory,
          coordinator,
          taskLeaseTtlMs,
          ...(options.noHeartbeat === true ? { noHeartbeat: true } : {}),
          ...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
        });
        if (outcome === undefined) break;
        if (outcome.state === "coordinator-disowned") {
          summary.disowned = true;
          options.lifecycle?.error("cycle", "execute", "instance lock loss mid-cycle — stopping execution loop");
          note(`disowned: claim or write blocked by lock loss — stopping execution loop`);
          break;
        }
        options.lifecycle?.log("INFO", "cycle", "execute", "completed", {
          taskId: outcome.task.id,
          state: outcome.state,
          attempts: outcome.task.attempts,
        });
        summary.executed++;
        progressed = true;
        if (outcome.state === "FAILED") {
          summary.executionFailures++;
          note(`execute: ${outcome.task.id} FAILED — ${outcome.output.slice(0, 160)}`);
          continue;
        }
        note(`execute: ${outcome.task.id} VERIFYING — ${outcome.output.slice(0, 160)}`);
        const target = store.getTask(outcome.task.id);
        if (target === undefined) {
          throw new Error(`claimed task disappeared from the store: ${outcome.task.id}`);
        }
        const verdict = await verifyTask(store, target, verifier, {
          directory: options.directory,
          authority: outcome.lease,
          ...(options.noHeartbeat === true ? { noHeartbeat: true } : {}),
          ...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
        });
        options.lifecycle?.log("INFO", "cycle", "verify", "completed", {
          taskId: verdict.taskId,
          verdict: verdict.verdict,
        });
        if (verdict.verdict === "pass") summary.verifiedPass++;
        else if (verdict.verdict === "fail") summary.verifiedFail++;
        note(`verify: ${verdict.taskId} ${verdict.verdict.toUpperCase()} — ${verdict.detail}`);
      }

      if (summary.disowned) {
        summary.stopReason = "no-progress";
        return finish(summary);
      }
      if (options.maxExecutions > 0 && summary.executed >= options.maxExecutions && new TaskQueue(options.db).size() > 0) {
        summary.stopReason = "execution-limit";
        options.lifecycle?.info("cycle", "execute", "stopped", { reason: "execution-limit", executed: summary.executed });
        return finish(summary);
      }
      if (!progressed) {
        summary.stopReason = "no-progress";
        options.lifecycle?.info("cycle", "round", "stopped", { reason: "no-progress", round });
        return finish(summary);
      }
    }

    summary.stopReason =
      options.maxExecutions > 0 && summary.executed >= options.maxExecutions ? "execution-limit" : "round-limit";
    return finish(summary);
  } finally {
    clearInterval(lockHeartbeat);
    options.lifecycle?.info("cycle", "lock", "released");
    releaseInstanceLock(options.db, coordinator.owner);
  }
}
