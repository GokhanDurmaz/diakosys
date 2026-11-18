import type { LifecycleLogger } from "./lifecycle.ts";
import type { OpenCodeAdapter } from "./opencode.ts";
import type { Task, TaskState } from "./types.ts";
import type { TaskStore } from "./store.ts";

export type VerificationVerdict = "pass" | "fail" | "skipped";

export interface VerificationOutcome {
  taskId: string;
  title: string;
  verdict: VerificationVerdict;
  detail: string;
}

/** A response line "VERDICT: PASS" / "VERDICT: FAIL – reason" (rest of the
 * line is the reason). Case-sensitive so quoted prose in an explanation
 * cannot accidentally match a verdict the verifier did not issue. */
export const VERDICT_PATTERN = /(?:^|\n)\s*VERDICT:\s*(PASS|FAIL)\b[ \t]*(.*)/g;

export function parseVerdict(text: string): { verdict: "PASS" | "FAIL"; reason: string } | undefined {
  const matches = [...text.matchAll(VERDICT_PATTERN)];
  if (matches.length === 0) return undefined;
  const verdicts = new Set(matches.map((m) => m[1]));
  // Conflicting verdict lines are an ambiguous response — unusable.
  if (verdicts.size !== 1) return undefined;
  const last = matches[matches.length - 1]!;
  return { verdict: last[1] as "PASS" | "FAIL", reason: (last[2] ?? "").trim() };
}

/**
 * Dedicated verification prompt body. It deliberately starts with the
 * "VERIFY TASK:" marker so adapter-level mocking can discriminate
 * verification prompts from execution prompts deterministically.
 */
export function verificationPromptBody(task: Task): string {
  return [
    `VERIFY TASK: ${task.title}`,
    task.description.length > 0 ? `Description:\n${task.description}` : "",
    "",
    "You are the independent verification reviewer for this task. Inspect the delivered work as thoroughly as you can: run its stated verification commands, check the relevant files, read the recorded outputs.",
    'End your final message with exactly one line: "VERDICT: PASS" when the task is complete and correct, "VERDICT: FAIL — <reason>" otherwise.',
    "",
    "A response without this exact verdict line, or with conflicting verdict lines, always counts as VERDICT: FAIL.",
  ].join("\n");
}

export interface VerifyOptions {
  directory: string;
  /**
   * Task-lease authority continuing from the runner's claim. When present,
   * every write is lease-guarded (owner + exec_gen + unexpired lease) and a
   * heartbeat renews the lease during the verification prompt; the first
   * heartbeat failure aborts the prompt and any late result is discarded.
   * When absent the legacy leaseless write path is used (rows nothing owns).
   */
  authority?: { owner: string; execGen: number; ttlMs: number };
  noHeartbeat?: boolean;
  /**
   * Optional real-time lifecycle observer (display side channel only: never
   * persisted, never changes lease/timeout behaviour). Reports the prompt,
   * heartbeats, lease loss, verdict outcomes and skipped stages.
   */
  lifecycle?: LifecycleLogger;
}

/**
 * Verify one task that is in VERIFYING state. The outcome is explicit:
 * PASS → DONE, FAIL → FAILED, skipped → no state change. A verifier throw
 * (including the adapter's prompt returning no terminal event) is a
 * verification FAILURE, never a silent pass. The verification timeout is the
 * adapter's own; DEFAULT_STARTUP_MS applies to server startup only.
 *
 * With a lease authority the terminal write is atomic: verification
 * metadata, the DONE/FAILED transition and lease clearance (exec_gen bump)
 * share one transaction.
 */
export async function verifyTask(
  store: TaskStore,
  task: Task,
  adapter: OpenCodeAdapter,
  options: VerifyOptions,
): Promise<VerificationOutcome> {
  if (task.status !== "VERIFYING") {
    options.lifecycle?.log("INFO", "verify", "prompt", "skipped", { taskId: task.id, status: task.status });
    return {
      taskId: task.id,
      title: task.title,
      verdict: "skipped",
      detail: `task is ${task.status}, not VERIFYING`,
    };
  }
  const base = { taskId: task.id, title: task.title } as const;
  const authority = options.authority;
  if (authority !== undefined) {
    // ownership is validated in SQL (id, exec_gen, lease_owner, unexpired
    // lease) inside a transaction, so a lease loss between the read below and
    // the verdict write cannot be missed
    const held = store.verifyTaskLeaseHeld(task.id, authority, authority.execGen, "VERIFYING");
    if (held === undefined) {
      options.lifecycle?.warn("verify", "lease", `lease not held by '${authority.owner}' (exec_gen ${authority.execGen}) — verification skipped`);
      return {
        taskId: task.id,
        title: task.title,
        verdict: "skipped",
        detail: `lease not held by '${authority.owner}' (exec_gen ${authority.execGen}) — verification skipped`,
      };
    }
  }

  let leaseLost = false;
  const heartbeatMs =
    authority !== undefined && options.noHeartbeat === true
      ? 0
      : authority !== undefined
        ? Math.max(1000, Math.floor(authority.ttlMs / 3))
        : 0;
  const heartbeat =
    heartbeatMs > 0 && authority !== undefined
      ? setInterval(async () => {
          if (leaseLost) return;
          const renewed = store.heartbeatTaskLease(task.id, authority, authority.ttlMs);
          if (!renewed) {
            leaseLost = true;
            options.lifecycle?.warn("verify", "lease", `task lease lost (owner ${authority.owner}) — verification aborted`);
            // name the in-flight session so the adapter cancels the verifier's
            // work rather than just nudging it; late results are discarded by
            // the caller regardless
            void adapter.abort(await adapter.activeSessionId()).catch(() => undefined);
          }
        }, heartbeatMs)
      : null;

  try {
    options.lifecycle?.beginHeartbeat("verify", "prompt");
    options.lifecycle?.start("verify", "prompt", { taskId: task.id });
    const result = await adapter.prompt({
      title: task.title,
      description: verificationPromptBody(task),
      directory: options.directory,
      agent: undefined,
    });
    options.lifecycle?.complete("verify", "prompt", { taskId: task.id });
    if (authority !== undefined && leaseLost) {
      options.lifecycle?.warn("verify", "prompt", "lease lost during verification — response discarded");
      return {
        ...base,
        verdict: "skipped",
        detail: "lease lost during verification — response discarded",
      };
    }
    const parsed = parseVerdict(result.text);
    if (parsed === undefined) {
      return recordFailure(store, base, "ambiguous verification response: no explicit VERDICT line — treated as FAIL", authority, { verifierSessionId: result.sessionId }, options.lifecycle);
    }
    const note = parsed.reason.length > 0 ? parsed.reason : "no reason given";
    if (parsed.verdict === "PASS") {
      const evidence = {
        verification: "pass",
        verificationNote: `verifier pass: ${note}`,
        verifierSessionId: result.sessionId,
      } as Record<string, unknown>;
      const done = verdictWithAuthorityOrLegacy(store, base.taskId, authority, evidence, "DONE", `verification passed: ${note}`);
      if (authority !== undefined && done === undefined) {
        return {
          ...base,
          verdict: "skipped",
          detail: "lease lost while recording the verdict — result discarded",
        };
      }
      // reported after the write succeeded, so the observed transition is real
      options.lifecycle?.transition("verify", task.id, "VERIFYING", "DONE", `verification passed: ${note}`);
      return { ...base, verdict: "pass", detail: `${done?.status} — ${note}` };
    }
    return recordFailure(
      store,
      base,
      `verifier fail: ${note}`,
      authority,
      { verifierSessionId: result.sessionId },
      options.lifecycle,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.lifecycle?.error("verify", "prompt", `prompt failed: ${message}`);
    if (authority !== undefined && leaseLost) {
      return {
        taskId: task.id,
        title: task.title,
        verdict: "skipped",
        detail: "lease lost during verification — response discarded",
      };
    }
    return recordFailure(store, base, `verifier error: ${message} — treated as FAIL`, authority, {}, options.lifecycle);
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    options.lifecycle?.stopHeartbeat("verify", "prompt");
  }
}

/** Held/legacy dispatch for terminal verdicts; undefined only with a lost lease. */
function verdictWithAuthorityOrLegacy(
  store: TaskStore,
  taskId: string,
  authority: VerifyOptions["authority"],
  metadataPatch: Record<string, unknown>,
  to: Extract<TaskState, "DONE" | "FAILED">,
  detail: string,
): Task | undefined {
  if (authority === undefined) {
    store.recordExecution(taskId, metadataPatch);
    return store.transition(taskId, to, detail);
  }
  return store.recordVerdictHeld(taskId, authority, metadataPatch, to, detail);
}

function recordFailure(
  store: TaskStore,
  base: { taskId: string; title: string },
  detail: string,
  authority?: VerifyOptions["authority"],
  extraMetadata: Record<string, unknown> = {},
  lifecycle?: LifecycleLogger,
): VerificationOutcome {
  const patch = {
    verification: "fail",
    verificationNote: detail,
    ...extraMetadata,
  } as Record<string, unknown>;
  const failed = verdictWithAuthorityOrLegacy(store, base.taskId, authority, patch, "FAILED", detail);
  if (authority !== undefined && failed === undefined) {
    return {
      taskId: base.taskId,
      title: base.title,
      verdict: "skipped",
      detail: "lease lost while recording the verdict — result discarded",
    };
  }
  // reported after the write succeeded, so the observed transition is real
  lifecycle?.transition("verify", base.taskId, "VERIFYING", "FAILED", detail);
  return { ...base, verdict: "fail", detail: `${failed?.status} — ${detail}` };
}

/**
 * Verify the highest-priority (oldest first) task currently in VERIFYING,
 * mirroring the queue's claim ordering. Returns undefined when the verifying
 * set is empty.
 */
export async function verifyNext(
  store: TaskStore,
  adapter: OpenCodeAdapter,
  options: VerifyOptions,
): Promise<VerificationOutcome | undefined> {
  const [task] = store.listTasks("VERIFYING");
  if (task === undefined) return undefined;
  return verifyTask(store, task, adapter, options);
}
