import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import { type OpenCodeAdapter, type OpenCodeAdapterOptions, type OpenCodePromptResult } from "../src/opencode.ts";
import type { Task } from "../src/types.ts";
import { executeNext } from "../src/runner.ts";
import { verifyTask } from "../src/verify.ts";
import { coordinatorAuth } from "./helpers.ts";
import type { DatabaseSync } from "node:sqlite";

function setup(): {
  store: TaskStore;
  db: DatabaseSync;
  dbPath: string;
  close(): void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-verify-"));
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  return {
    store: new TaskStore(db),
    db,
    dbPath,
    close: () => closeDatabase(db),
  };
}

/**
 * Adapter double that returns a canned full result including tool parts,
 * mirroring the live response shape recorded in the runner.
 */
class ToolPartAdapter implements OpenCodeAdapter {
  readonly kind = "mock" as const;
  readonly options: OpenCodeAdapterOptions = {
    projectDirectory: "",
    model: "",
    agent: undefined,
    port: undefined,
    hostname: undefined,
    startupTimeoutMs: undefined,
    promptTimeoutMs: undefined,
    workDirectory: undefined,
    endpoint: undefined,
  };
  readonly calls: Array<{ title: string; description: string; directory: string; agent?: string }> = [];
  readonly aborted: Array<string | undefined> = [];
  private readonly result: OpenCodePromptResult;

  constructor(result: OpenCodePromptResult) {
    this.result = result;
  }

  async probe(): Promise<string> {
    return "mock:localhost:4096";
  }

  async prompt(input: {
    title: string;
    description: string;
    directory: string;
    agent?: string;
  }): Promise<OpenCodePromptResult> {
    this.calls.push(input);
    return this.result;
  }

  async close(): Promise<void> {
    return;
  }

  async abort(sessionId?: string): Promise<void> {
    this.aborted.push(sessionId);
  }

  activeSessionId(): string | undefined {
    return undefined;
  }
}

/**
 * Drives the verified execution pipeline to VERIFYING with mock tool parts,
 * exercising the tool-call metadata capture added with real execution.
 */
async function toVerifying(s: ReturnType<typeof setup>): Promise<string> {
  const t = s.store.addTask({ title: "verify me" });
  s.store.transition(t.id, "BACKLOG");
  s.store.transition(t.id, "READY");
  const adapter = new ToolPartAdapter({
    sessionId: "ses_mock_tools",
    finish: "stop",
    role: "assistant",
    text: "edited file and ran tests",
    raw: {
      info: { finish: "stop", role: "assistant" },
      parts: [
        { type: "step-start" },
        { type: "tool", tool: "read" },
        { type: "tool", tool: "edit" },
        { type: "tool", tool: "bash" },
        { type: "tool", tool: "read" },
        { type: "text", text: "edited file and ran tests" },
      ],
    },
  });
  await executeNext(s.db, s.store, adapter, {
    directory: "/tmp/project",
    coordinator: coordinatorAuth(s.db),
    taskLeaseTtlMs: 120_000,
    noHeartbeat: true,
  });
  const task = s.store.getTask(t.id);
  if (task?.status !== "VERIFYING") throw new Error(`task not VERIFYING: ${String(task?.status)}`);
  return t.id;
}

test("execution captures tool-call count and distinct tool names", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const task = s.store.getTask(id);
    assert.equal(task?.executionMetadata["toolCalls"], 4);
    assert.equal(task?.executionMetadata["tools"], "read,edit,bash");
    assert.equal(task?.executionMetadata["sessionId"], "ses_mock_tools");
  } finally {
    s.close();
  }
});

test("verification pass moves VERIFYING → DONE and records the verdict", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const t = s.store.getTask(id)!;
    const done = s.store.recordVerdictHeld(id, { owner: t.leaseOwner ?? "", execGen: t.execGen }, { verification: "pass", verificationNote: "gradle checks passed" }, "DONE", "gradle checks passed");
    assert.ok(done);
    assert.equal(done?.status, "DONE");
    const stored = s.store.getTask(id);
    assert.equal(stored?.executionMetadata["verification"], "pass");
    const history = s.store.eventsFor(id).map((e) => e.toState);
    assert.deepEqual(history, [
      "DISCOVERED",
      "BACKLOG",
      "READY",
      "IN_PROGRESS",
      "REVIEW",
      "VERIFYING",
      "DONE",
    ]);
  } finally {
    s.close();
  }
});

test("verification failure moves VERIFYING → FAILED, rejecting direct DONE", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    assert.throws(() => s.store.transition("other-task", "DONE"), /not found/);
    const t = s.store.getTask(id)!;
    const failed = s.store.recordVerdictHeld(id, { owner: t.leaseOwner ?? "", execGen: t.execGen }, { verification: "fail", verificationNote: "gradle test failures" }, "FAILED", "gradle test failures");
    assert.ok(failed);
    assert.equal(failed.status, "FAILED");
    const stored = s.store.getTask(id);
    assert.equal(stored?.executionMetadata["verification"], "fail");
    // the verdict write clears the lease; failed tasks are retryable from BACKLOG
    const retried = s.store.transition(id, "BACKLOG");
    assert.equal(retried.status, "BACKLOG");
  } finally {
    s.close();
  }
});

test("DONE is terminal: no further verification from DONE", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const t = s.store.getTask(id)!;
    const done = s.store.recordVerdictHeld(id, { owner: t.leaseOwner ?? "", execGen: t.execGen }, { verified: true }, "DONE", "verified");
    assert.ok(done);
    assert.throws(() => s.store.transition(id, "FAILED"), /invalid transition/);
  } finally {
    s.close();
  }
});

/**
 * Adapter that holds the prompt open for `delayMs` before resolving, so a
 * heartbeat can lose the lease mid-prompt.
 */
class DelayedAdapter implements OpenCodeAdapter {
  readonly kind = "mock" as const;
  readonly options: OpenCodeAdapterOptions = {
    projectDirectory: "",
    model: "",
    agent: undefined,
    port: undefined,
    hostname: undefined,
    startupTimeoutMs: undefined,
    promptTimeoutMs: undefined,
    workDirectory: undefined,
    endpoint: undefined,
  };
  readonly aborted: Array<string | undefined> = [];
  private readonly result: OpenCodePromptResult;
  readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(result: OpenCodePromptResult, delayMs = 1500) {
    this.result = result;
    this.delayMs = delayMs;
  }

  async probe(): Promise<string> {
    return "mock:localhost:4096";
  }

  async prompt(): Promise<OpenCodePromptResult> {
    await new Promise((resolve) => (this.timer = setTimeout(resolve, this.delayMs)));
    return this.result;
  }

  async close(): Promise<void> {
    if (this.timer === undefined) return;
    const timer = this.timer;
    this.timer = undefined;
    clearTimeout(timer as unknown as NodeJS.Timeout);
    return;
  }

  async abort(sessionId?: string): Promise<void> {
    this.aborted.push(sessionId);
  }

  activeSessionId(): string | undefined {
    return undefined;
  }
}

/**
 * Puts a task in VERIFYING under a lease that expires after `ttlMs`, so the
 * heartbeat can lose it mid-prompt. The lease is stamped directly (no
 * execution), which is what the runner does after a claim.
 */
async function toVerifyingWithTtl(s: ReturnType<typeof setup>, ttlMs = 1000): Promise<{ id: string; task: Task }> {
  const t = s.store.addTask({ title: "verify me" });
  s.store.transition(t.id, "BACKLOG");
  s.store.transition(t.id, "READY");
  s.store.transition(t.id, "IN_PROGRESS");
  s.store.transition(t.id, "REVIEW");
  s.store.transition(t.id, "VERIFYING");
  const task = s.store.getTask(t.id)!;
  const now = Date.now();
  s.db
    .prepare("UPDATE tasks SET lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
    .run("orchestrator-test", now + ttlMs, now, t.id);
  return { id: t.id, task: s.store.getTask(t.id)! };
}

// ——— ownership, lease and generation guards ————————————————————————————————————————

test("valid ownership: a held lease lets the verifier pass through to DONE", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const t = s.store.getTask(id)!;
    const authority = { owner: t.leaseOwner ?? "", execGen: t.execGen, ttlMs: 120_000 };
    const adapter = new ToolPartAdapter({
      sessionId: "ses_verify_ok",
      finish: "stop",
      role: "assistant",
      text: "VERDICT: PASS — gradle build is green",
      raw: { info: { finish: "stop", role: "assistant" }, parts: [] },
    });
    const outcome = await verifyTask(s.store, t, adapter, {
      directory: "/tmp/project",
      authority,
      noHeartbeat: true,
    });
    assert.equal(outcome.verdict, "pass");
    assert.equal(outcome.detail, "DONE — — gradle build is green");
    assert.equal(s.store.getTask(id)?.status, "DONE");
    assert.equal(s.store.getTask(id)?.leaseOwner, null, "lease cleared on verdict");
  } finally {
    s.close();
  }
});

test("expired lease: verification is skipped, nothing is written", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const t = s.store.getTask(id)!;
    // expire the lease by re-stamping it to a past epoch
    s.db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() - 5000, id);
    const authority = { owner: t.leaseOwner ?? "", execGen: t.execGen, ttlMs: 120_000 };
    const adapter = new ToolPartAdapter({
      sessionId: "ses_verify_expired",
      finish: "stop",
      role: "assistant",
      text: "VERDICT: PASS",
      raw: { info: { finish: "stop", role: "assistant" }, parts: [] },
    });
    const outcome = await verifyTask(s.store, t, adapter, {
      directory: "/tmp/project",
      authority,
      noHeartbeat: true,
    });
    assert.equal(outcome.verdict, "skipped");
    assert.equal(s.store.getTask(id)?.status, "VERIFYING", "status must not change");
    assert.equal(s.store.getTask(id)?.executionMetadata["verification"], undefined, "no verdict metadata");
  } finally {
    s.close();
  }
});

test("wrong owner: verification is skipped, nothing is written", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const t = s.store.getTask(id)!;
    const authority = { owner: "someone-else", execGen: t.execGen, ttlMs: 120_000 };
    const adapter = new ToolPartAdapter({
      sessionId: "ses_verify_owner",
      finish: "stop",
      role: "assistant",
      text: "VERDICT: PASS",
      raw: { info: { finish: "stop", role: "assistant" }, parts: [] },
    });
    const outcome = await verifyTask(s.store, t, adapter, {
      directory: "/tmp/project",
      authority,
      noHeartbeat: true,
    });
    assert.equal(outcome.verdict, "skipped");
    assert.equal(s.store.getTask(id)?.status, "VERIFYING", "status must not change");
    assert.equal(s.store.getTask(id)?.executionMetadata["verification"], undefined, "no verdict metadata");
  } finally {
    s.close();
  }
});

test("wrong generation: verification is skipped, stale exec_gen rejected", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const t = s.store.getTask(id)!;
    const authority = { owner: t.leaseOwner ?? "", execGen: t.execGen + 1, ttlMs: 120_000 };
    const adapter = new ToolPartAdapter({
      sessionId: "ses_verify_gen",
      finish: "stop",
      role: "assistant",
      text: "VERDICT: PASS",
      raw: { info: { finish: "stop", role: "assistant" }, parts: [] },
    });
    const outcome = await verifyTask(s.store, t, adapter, {
      directory: "/tmp/project",
      authority,
      noHeartbeat: true,
    });
    assert.equal(outcome.verdict, "skipped");
    assert.equal(s.store.getTask(id)?.status, "VERIFYING", "status must not change");
    assert.equal(s.store.getTask(id)?.executionMetadata["verification"], undefined, "no verdict metadata");
  } finally {
    s.close();
  }
});

test("stale verifier: a stale authority is rejected before the prompt fires", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const t = s.store.getTask(id)!;
    const adapter = new ToolPartAdapter({
      sessionId: "ses_stale",
      finish: "stop",
      role: "assistant",
      text: "VERDICT: PASS",
      raw: { info: { finish: "stop", role: "assistant" }, parts: [] },
    });
    const calls = adapter.calls.length;
    const outcome = await verifyTask(s.store, t, adapter, {
      directory: "/tmp/project",
      authority: { owner: "orchestrator-test", execGen: t.execGen + 2, ttlMs: 120_000 },
      noHeartbeat: true,
    });
    assert.equal(outcome.verdict, "skipped");
    assert.equal(adapter.calls.length, calls, "the prompt must not fire for a stale authority");
  } finally {
    s.close();
  }
});

test("lease loss during verification: the prompt is aborted and its result discarded", async () => {
  const s = setup();
  try {
    const { id, task } = await toVerifyingWithTtl(s);
    const authority = { owner: task.leaseOwner ?? "", execGen: task.execGen, ttlMs: 1000 };
    const adapter = new DelayedAdapter({
      sessionId: "ses_verify_lost",
      finish: "stop",
      role: "assistant",
      text: "VERDICT: PASS — late result after lease loss",
      raw: { info: { finish: "stop", role: "assistant" }, parts: [] },
    });
    const outcome = await verifyTask(s.store, task, adapter, {
      directory: "/tmp/project",
      authority,
      noHeartbeat: false,
    });
    assert.equal(outcome.verdict, "skipped");
    assert.equal(s.store.getTask(id)?.status, "VERIFYING", "status must not change");
    assert.equal(s.store.getTask(id)?.executionMetadata["verification"], undefined, "no verdict metadata");
    assert.equal(adapter.aborted.length, 1, "abort was requested");
  } finally {
    s.close();
  }
});

test("atomic verdict and event persistence: one write, one transition event", async () => {
  const s = setup();
  try {
    const id = await toVerifying(s);
    const t = s.store.getTask(id)!;
    const authority = { owner: t.leaseOwner ?? "", execGen: t.execGen, ttlMs: 120_000 };
    const adapter = new ToolPartAdapter({
      sessionId: "ses_atomic",
      finish: "stop",
      role: "assistant",
      text: "VERDICT: FAIL — gradle build failed",
      raw: { info: { finish: "stop", role: "assistant" }, parts: [] },
    });
    const outcome = await verifyTask(s.store, t, adapter, {
      directory: "/tmp/project",
      authority,
      noHeartbeat: true,
    });
    assert.equal(outcome.verdict, "fail");
    assert.equal(s.store.getTask(id)?.status, "FAILED");
    const stored = s.store.getTask(id);
    assert.equal(stored?.executionMetadata["verification"], "fail");
    assert.equal(stored?.executionMetadata["verificationNote"], "verifier fail: — gradle build failed");
    // the verdict write cleared the lease and bumped exec_gen in the same
    // statement as the transition event, so exactly one terminal event exists
    const events = s.store.eventsFor(id);
    assert.equal(events.length, 7, "one transition per state change");
    const terminal = events.find((e) => e.toState === "FAILED");
    assert.ok(terminal, "expected a FAILED transition event");
    assert.equal(terminal!.eventType, "transition");
    assert.equal(terminal!.detail, "verifier fail: — gradle build failed");
    // and the lease is gone, so no further lease-guarded write can land
    assert.equal(s.store.getTask(id)?.leaseOwner, null);
    assert.equal(s.store.heartbeatTaskLease(id, { owner: t.leaseOwner ?? "", execGen: t.execGen }, 120_000), false);
  } finally {
    s.close();
  }
});
