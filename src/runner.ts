import type { Task } from "./types.ts";
import type { TaskStore } from "./store.ts";
import type { DatabaseSync } from "node:sqlite";
import type { OpenCodeAdapter } from "./opencode.ts";
import type { LifecycleLogger } from "./lifecycle.ts";
import { claimTask } from "./queue.ts";
import type { CoordinatorAuthority } from "./locks.ts";

export type ExecutionState = "VERIFYING" | "FAILED";

/**
 * claim → prompt → verify handoff of a single task. `undefined` means the
 * queue had nothing; `state: "coordinator-disowned"` means the instance lock
 * was lost before the claim could proceed.
 */
export type ExecutionOutcome =
  | { task: Task; output: string; state: ExecutionState; lease: { owner: string; execGen: number; ttlMs: number } }
  | { task: Task; output: string; state: "coordinator-disowned" };

export interface ExecutionOptions {
  directory: string;
  /** instance-lock authority under which the claim runs. */
  coordinator: CoordinatorAuthority;
  /** task lease TTL stamped at claim time (ms). */
  taskLeaseTtlMs: number;
  /**
   * Disable the in-prompt lease heartbeat (deterministic unit tests; the
   * heartbeat interval is synchronous DB writes and safe to skip there).
   */
  noHeartbeat?: boolean;
  /**
   * Optional real-time lifecycle observer (display side channel only: never
   * persisted, never changes claim/lease/timeout behaviour). Reports the
   * claim, the prompt, and completion/failure outcomes.
   */
  lifecycle?: LifecycleLogger;
}

/**
 * Single-step task execution (no continuous loop): claim → prompt → verify handoff.
 * The runner holds the task lease from claim until the route into VERIFYING or
 * FAILED; every write is guarded by id + lease_owner + exec_gen + unexpired.
 * A lease heartbeat (TTL/3, minimum 1s) runs during the prompt; its first
 * failure aborts the adapter prompt and anything recorded afterwards is
 * discarded — the supervisor's recovery pass owns the orphaned row.
 */
export async function executeNext(
  db: DatabaseSync,
  store: TaskStore,
  adapter: OpenCodeAdapter,
  options: ExecutionOptions,
): Promise<ExecutionOutcome | undefined> {
  const disposition = claimTask(db, {
    coordinator: options.coordinator,
    taskLeaseTtlMs: options.taskLeaseTtlMs,
  });
  if (disposition.status === "queue-empty") {
    options.lifecycle?.log("INFO", "execute", "claim", "completed", { detail: "queue empty (no READY task)" });
    return undefined;
  }
  if (disposition.status === "coordinator-disowned") {
    options.lifecycle?.error("execute", "claim", "claim blocked by coordinator lock loss");
    return { task: undefined as unknown as Task, output: "", state: "coordinator-disowned" };
  }
  const { task, lease } = disposition;
  const authority = { owner: lease.owner, execGen: lease.execGen };
  // The claim itself is a real state transition: READY → IN_PROGRESS.
  options.lifecycle?.transition("execute", task.id, "READY", "IN_PROGRESS", "queue claim");
  options.lifecycle?.start("execute", "claim", { taskId: task.id, attempts: task.attempts, leaseMs: lease.ttlMs });
  options.lifecycle?.complete("execute", "claim", { taskId: task.id, attempts: task.attempts });

  let leaseLost = false;
  const heartbeatMs = options.noHeartbeat === true ? 0 : Math.max(1000, Math.floor(lease.ttlMs / 3));
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(async () => {
          if (leaseLost) return;
          const renewed = store.heartbeatTaskLease(task.id, authority, lease.ttlMs);
          if (!renewed) {
            leaseLost = true;
            options.lifecycle?.error("execute", "lease", `task lease lost (owner ${authority.owner}) — execution aborted`);
            // name the in-flight session so the adapter cancels the agent's
            // work rather than just nudging it; if the adapter cannot honour
            // the abort (late results still arrive) the caller discards them
            void adapter.abort(await adapter.activeSessionId()).catch(() => undefined);
          }
        }, heartbeatMs)
      : null;
  try {
    options.lifecycle?.beginHeartbeat("execute", "prompt");
    options.lifecycle?.start("execute", "prompt", { taskId: task.id, attempts: task.attempts });
    const result = await adapter.prompt({
      title: task.title,
      description: task.description,
      directory: options.directory,
      agent: undefined,
    });
    options.lifecycle?.complete("execute", "prompt", { taskId: task.id });
    if (leaseLost) {
      return { task, output: result.text, state: "coordinator-disowned" };
    }
    const toolCalls = result.raw.parts.filter(
      (p): p is { tool?: string } => (p as { type?: string })?.type === "tool",
    );
    const toolNames = [...new Set(toolCalls.map((p) => p.tool).filter((t): t is string => t !== undefined))];
    const recorded = store.recordExecutionHeld(task.id, authority, lease.ttlMs, {
      sessionId: result.sessionId,
      finish: result.finish,
      output: result.text,
      toolCalls: toolCalls.length,
      ...(toolNames.length > 0 ? { tools: toolNames.join(",") } : {}),
    });
    if (recorded === undefined) {
      return { task, output: result.text, state: "coordinator-disowned" };
    }
    // recordExecutionHeld moved IN_PROGRESS → REVIEW with the execution
    // result; observed store transition, reported for observability only.
    options.lifecycle?.transition("execute", task.id, "IN_PROGRESS", "REVIEW", "execution result recorded");
    const reviewing = store.transitionHeld(task.id, "REVIEW", authority);
    if (reviewing === undefined) {
      return { task, output: result.text, state: "coordinator-disowned" };
    }
    options.lifecycle?.transition("execute", task.id, "REVIEW", "VERIFYING", "verification handoff");
    const verifying = store.transitionHeld(task.id, "VERIFYING", authority);
    if (verifying === undefined) {
      return { task, output: result.text, state: "coordinator-disowned" };
    }
    return { task: verifying, output: result.text, state: "VERIFYING", lease };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.lifecycle?.error("execute", "prompt", `prompt failed: ${message}`);
    if (leaseLost) {
      return { task, output: message, state: "coordinator-disowned" };
    }
    const failure = store.recordVerdictHeld(task.id, authority, { error: message, failureKind: "execution-error" }, "FAILED", `execution error: ${message}`);
    if (failure === undefined) {
      return { task, output: message, state: "coordinator-disowned" };
    }
    options.lifecycle?.transition("execute", task.id, "IN_PROGRESS", "FAILED", "execution error");
    return { task: failure, output: message, state: "FAILED", lease };
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    options.lifecycle?.stopHeartbeat("execute", "prompt");
  }
}
