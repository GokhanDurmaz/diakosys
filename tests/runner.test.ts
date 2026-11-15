import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import { MockOpenCodeAdapter } from "../src/opencode.ts";
import { executeNext } from "../src/runner.ts";
import type { DatabaseSync } from "node:sqlite";
import { coordinatorAuth } from "./helpers.ts";

function setup(): { store: TaskStore; db: DatabaseSync; dbPath: string; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-run-"));
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  return {
    store: new TaskStore(db),
    db,
    dbPath,
    close: () => closeDatabase(db),
  };
}

test("executeNext is a no-op for an empty queue", async () => {
  const s = setup();
  try {
    const adapter = new MockOpenCodeAdapter(() => "reply");
    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 120_000,
      noHeartbeat: true,
    });
    assert.equal(outcome, undefined);
    assert.equal(adapter.calls.length, 0);
  } finally {
    s.close();
  }
});

test("successful execution: claim → prompt → REVIEW → VERIFYING, output recorded under the lease", async () => {
  const s = setup();
  try {
    const t = s.store.addTask({ title: "compile it", description: "make gradle pass", priority: 2 });
    s.store.transition(t.id, "BACKLOG");
    s.store.transition(t.id, "READY");

    const adapter = new MockOpenCodeAdapter(
      (input) => `ran: ${input.title} @ ${input.directory}`,
    );
    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 120_000,
      noHeartbeat: true,
    });
    assert.ok(outcome);
    assert.equal(outcome?.state, "VERIFYING");
    assert.equal(outcome?.output, "ran: compile it @ /tmp/project");
    assert.equal(outcome?.task.status, "VERIFYING");
    assert.equal(outcome?.lease.owner, "orchestrator-test");
    assert.equal(outcome?.lease.execGen, 1);
    assert.equal(outcome?.task.execGen, 1);
    assert.equal(adapter.kind, "mock");
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0]?.title, "compile it");
    assert.equal(adapter.calls[0]?.directory, "/tmp/project");

    const stored = s.store.getTask(t.id);
    assert.equal(stored?.executionMetadata["output"], "ran: compile it @ /tmp/project");
    assert.equal(String(stored?.executionMetadata["finish"]), "stop");
    assert.equal(stored?.leaseOwner, "orchestrator-test");

    const history = s.store.eventsFor(t.id).map((e) => e.toState);
    assert.deepEqual(history, ["DISCOVERED", "BACKLOG", "READY", "IN_PROGRESS", "REVIEW", "VERIFYING"]);
    const declared = s.store.eventsFor(t.id).find((e) => e.eventType === "declared");
    assert.ok(declared);
  } finally {
    s.close();
  }
});

test("failing execution transitions to FAILED with persisted error metadata and failure classification", async () => {
  const s = setup();
  try {
    const t = s.store.addTask({ title: "will fail" });
    s.store.transition(t.id, "BACKLOG");
    s.store.transition(t.id, "READY");

    const adapter = new MockOpenCodeAdapter(() => {
      throw new Error("opencode unreachable");
    });
    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 120_000,
      noHeartbeat: true,
    });
    assert.ok(outcome);
    assert.equal(outcome?.state, "FAILED");
    assert.equal(outcome?.task.status, "FAILED");
    assert.ok(outcome?.lease.owner !== undefined || (outcome as { lease?: unknown }).lease === undefined);
    const stored = s.store.getTask(t.id);
    assert.equal(stored?.executionMetadata["error"], "opencode unreachable");
    assert.equal(stored?.executionMetadata["failureKind"], "execution-error");
    const history = s.store.eventsFor(t.id).map((e) => e.toState);
    assert.deepEqual(history, ["DISCOVERED", "BACKLOG", "READY", "IN_PROGRESS", "FAILED"]);
  } finally {
    s.close();
  }
});

test("executions are persisted so state matches across reopen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-run2-"));
  const dbPath = path.join(dir, "tasks.db");
  const db1 = openDatabase(dbPath);
  const store1 = new TaskStore(db1);
  const t = store1.addTask({ title: "done durable" });
  store1.transition(t.id, "BACKLOG");
  store1.transition(t.id, "READY");
  const adapter = new MockOpenCodeAdapter(() => "ok");
  await executeNext(db1, store1, adapter, {
    directory: "/tmp/project",
    coordinator: coordinatorAuth(db1),
    taskLeaseTtlMs: 120_000,
    noHeartbeat: true,
  });
  closeDatabase(db1);

  const db2 = openDatabase(dbPath);
  const store2 = new TaskStore(db2);
  assert.equal(store2.getTask(t.id)?.status, "VERIFYING");
  closeDatabase(db2);
});

// ——— heartbeat, cancellation and lease loss ————————————————————————————————————————

test("heartbeat renews the lease during a long prompt", async () => {
  const s = setup();
  try {
    const t = s.store.addTask({ title: "long run", description: "keep working", priority: 2 });
    s.store.transition(t.id, "BACKLOG");
    s.store.transition(t.id, "READY");

    const adapter = new MockOpenCodeAdapter(async () => {
      // long enough that the TTL/3 heartbeat fires mid-prompt
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return "ran: long run @ /tmp/project";
    });
    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 3000,
    });
    assert.ok(outcome);
    assert.equal(outcome?.state, "VERIFYING");
    assert.equal(outcome?.output, "ran: long run @ /tmp/project");
    // the lease survived the prompt: the heartbeat re-stamped it, so it still
    // expires in the future rather than having been dropped at claim time
    const stored = s.store.getTask(t.id);
    assert.equal(stored?.leaseOwner, "orchestrator-test");
    assert.ok(stored?.leaseExpiresAt !== null && stored!.leaseExpiresAt > Date.now(), "lease expired: heartbeat did not renew");
  } finally {
    s.close();
  }
});

test("lease loss aborts the adapter with the in-flight session id", async () => {
  const s = setup();
  try {
    const t = s.store.addTask({ title: "long run", description: "keep working", priority: 2 });
    s.store.transition(t.id, "BACKLOG");
    s.store.transition(t.id, "READY");

    const adapter = new MockOpenCodeAdapter(async () => {
      // longer than the 1000ms lease, so the heartbeat at 1000ms loses it
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return "ran: long run @ /tmp/project";
    });
    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 1000,
    });
    assert.ok(outcome);
    // the heartbeat lost the lease, so it requested cancellation naming the
    // session that was in flight when the prompt started
    assert.equal(adapter.aborted.length, 1);
    assert.equal(adapter.aborted[0], "ses_mock");
    assert.equal(outcome?.state, "coordinator-disowned");
    assert.equal(outcome?.output, "ran: long run @ /tmp/project");
  } finally {
    s.close();
  }
});

test("cancellation names the session id the runner captured from the prompt", async () => {
  const s = setup();
  try {
    const t = s.store.addTask({ title: "long run", description: "keep working", priority: 2 });
    s.store.transition(t.id, "BACKLOG");
    s.store.transition(t.id, "READY");

    const adapter = new MockOpenCodeAdapter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return "ran: long run @ /tmp/project";
    });
    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 1000,
    });
    // the abort was issued with the session id the adapter reported for the
    // prompt, not with the adapter's own bookkeeping
    assert.ok(adapter.aborted.length > 0);
    assert.equal(adapter.aborted[0], "ses_mock");
    assert.ok(adapter.aborted.includes("ses_mock"));
  } finally {
    s.close();
  }
});

test("late results arriving after lease loss are discarded, never persisted", async () => {
  const s = setup();
  try {
    const t = s.store.addTask({ title: "long run", description: "keep working", priority: 2 });
    s.store.transition(t.id, "BACKLOG");
    s.store.transition(t.id, "READY");

    const adapter = new MockOpenCodeAdapter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return "late result: ran: long run @ /tmp/project";
    });
    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 1000,
    });
    assert.ok(outcome);
    assert.equal(outcome?.state, "coordinator-disowned");
    // the prompt resolved after the lease was lost, so its late result was
    // dropped: the task is still leased IN_PROGRESS with no recorded output
    const stored = s.store.getTask(t.id);
    assert.equal(stored?.status, "IN_PROGRESS");
    assert.equal(stored?.leaseOwner, "orchestrator-test");
    assert.equal(stored?.executionMetadata["output"], undefined);
    assert.equal(stored?.executionMetadata["error"], undefined);
  } finally {
    s.close();
  }
});

// ——— stale exec_gen ————————————————————————————————————————————————————————

test("a stale exec_gen never persists output, task mutations or events", async () => {
  const s = setup();
  try {
    const t = s.store.addTask({ title: "stale write", description: "x", priority: 2 });
    s.store.transition(t.id, "BACKLOG");
    s.store.transition(t.id, "READY");
    const adapter = new MockOpenCodeAdapter(() => "ok");

    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 120_000,
      noHeartbeat: true,
    });
    assert.ok(outcome);
    assert.equal(outcome?.state, "VERIFYING");

    // simulate another coordinator bumping the generation mid-execution
    const staleGen = s.store.getTask(t.id)?.execGen;
    assert.ok(staleGen !== undefined);
    s.db.prepare("UPDATE tasks SET exec_gen = exec_gen + 1 WHERE id = ?").run(t.id);

    // every lease-guarded write now rejects: no output, no transition, no event
    assert.equal(s.store.recordExecutionHeld(t.id, { owner: "orchestrator-test", execGen: staleGen }, 120_000, {}), undefined);
    assert.equal(s.store.transitionHeld(t.id, "DONE", { owner: "orchestrator-test", execGen: staleGen }), undefined);
    assert.equal(s.store.recordVerdictHeld(t.id, { owner: "orchestrator-test", execGen: staleGen }, {}, "FAILED"), undefined);
    assert.equal(s.store.heartbeatTaskLease(t.id, { owner: "orchestrator-test", execGen: staleGen }, 120_000), false);
    assert.equal(s.store.getTask(t.id)?.execGen, staleGen + 1, "exec_gen was not rolled back");
    assert.equal(s.store.eventsFor(t.id).length, 6, "no stale event was appended");
  } finally {
    s.close();
  }
});

// ——— structured failure metadata —————————————————————————————————————————————————————

test("structured failure metadata is persisted, never inferred from the message", async () => {
  const s = setup();
  try {
    const t = s.store.addTask({ title: "fails structured", description: "x", priority: 2 });
    s.store.transition(t.id, "BACKLOG");
    s.store.transition(t.id, "READY");

    const adapter = new MockOpenCodeAdapter(() => {
      throw new Error("prompt timed out after 120s with no VERDICT line");
    });
    const outcome = await executeNext(s.db, s.store, adapter, {
      directory: "/tmp/project",
      coordinator: coordinatorAuth(s.db),
      taskLeaseTtlMs: 120_000,
      noHeartbeat: true,
    });
    assert.ok(outcome);
    assert.equal(outcome?.state, "FAILED");
    assert.equal(outcome?.task.status, "FAILED");

    const stored = s.store.getTask(t.id);
    assert.equal(stored?.status, "FAILED");
    assert.equal(stored?.executionMetadata["error"], "prompt timed out after 120s with no VERDICT line");
    // the category is a structured tag, not parsed out of the human-readable text
    assert.equal(stored?.executionMetadata["failureKind"], "execution-error");

    const history = s.store.eventsFor(t.id).map((e) => e.toState);
    assert.deepEqual(history, ["DISCOVERED", "BACKLOG", "READY", "IN_PROGRESS", "FAILED"]);
    const verdict = s.store.eventsFor(t.id).find((e) => e.toState === "FAILED");
    assert.ok(verdict, "expected a verdict event");
    assert.equal(verdict?.eventType, "transition");
    assert.equal(verdict?.detail, "execution error: prompt timed out after 120s with no VERDICT line");
  } finally {
    s.close();
  }
});
