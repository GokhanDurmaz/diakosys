import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import { recoverInterruptedTasks, scheduleFailedRetries, requeueRetryDueTasks } from "../src/recovery.ts";
import { DEFAULT_RETRY_POLICY, retryBackoffMs, type RetryPolicy } from "../src/retry.ts";
import { setNowSource } from "../src/clock.ts";
import { coordinatorAuth } from "./helpers.ts";
import { planDiscoveredTasks } from "../src/planner.ts";
import type { DatabaseSync } from "node:sqlite";

const AUTH_OWNER = "orchestrator-test";
const LEASE_TTL = 120_000;

function tempDb(): { db: DatabaseSync; store: TaskStore; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-rec-"));
  const db = openDatabase(path.join(dir, "tasks.db"));
  return { db, store: new TaskStore(db), close: () => closeDatabase(db) };
}

let t: number;
setNowSource(() => t);
// the deterministic clock seam stays installed for all tests in this file;
// each test controls `t` explicitly. node --test runs one process per file,
// so this cannot leak into other suites.
after(() => setNowSource(null));

function driveTo(store: TaskStore, id: string, status: "READY" | "IN_PROGRESS" | "REVIEW" | "VERIFYING"): void {
  if (store.getTask(id)?.status === status) return;
  store.transition(id, "BACKLOG");
  if (status !== "READY") store.transition(id, "READY");
  if (status === "IN_PROGRESS") store.transition(id, "IN_PROGRESS");
  if (status === "REVIEW" || status === "VERIFYING") store.transition(id, "IN_PROGRESS");
  if (status === "REVIEW" || status === "VERIFYING") store.transition(id, "REVIEW");
  if (status === "VERIFYING") store.transition(id, "VERIFYING");
}

test("recovery: expired-lease takeover follows the state matrix", () => {
  const s = tempDb();
  try {
    t = 100;
    const auth = coordinatorAuth(s.db);
    const noOutput = s.store.addTask({ title: "interrupted before output" });
    driveTo(s.store, noOutput.id, "IN_PROGRESS");
    const withOutput = s.store.addTask({ title: "interrupted after output" });
    driveTo(s.store, withOutput.id, "VERIFYING");
    s.store.setMetadata(withOutput.id, { output: "did something" });
    const reviewing = s.store.addTask({ title: "stuck in review" });
    driveTo(s.store, reviewing.id, "REVIEW");
    const verifying = s.store.addTask({ title: "verification interrupted" });
    driveTo(s.store, verifying.id, "VERIFYING");

    // pre-stamp expired leases (executor crashed without clearing)
    const expstamp = s.db.prepare("UPDATE tasks SET lease_owner = ? , lease_expires_at = ? WHERE status IN ('IN_PROGRESS','REVIEW','VERIFYING')");
    expstamp.run(AUTH_OWNER, t - 1);

    const report = recoverInterruptedTasks(s.store, auth, LEASE_TTL);
    assert.equal(report.recovered, 4);
    assert.equal(report.skipped.length, 0);
    assert.equal(s.store.getTask(noOutput.id)?.status, "READY");
    assert.equal(s.store.getTask(withOutput.id)?.status, "VERIFYING");
    assert.equal(s.store.getTask(reviewing.id)?.status, "VERIFYING");
    assert.equal(s.store.getTask(verifying.id)?.status, "VERIFYING");
    // every recovered row has a fresh lease stamped by the recovery pass
    for (const id of [noOutput.id, withOutput.id, reviewing.id, verifying.id]) {
      const task = s.store.getTask(id)!;
      assert.equal(task.leaseOwner, AUTH_OWNER);
      assert.equal(task.leaseExpiresAt, t + LEASE_TTL);
      assert.ok(task.execGen >= 1); // 0 from addTask + 1 from the recovery takeover
    }
    // idempotent: the second pass re-stamps nothing and reports skips only
    const again = recoverInterruptedTasks(s.store, auth, LEASE_TTL);
    assert.equal(again.recovered, 0);
    assert.equal(again.skipped.length, 3); // the no-output row is READY, not in the active set
    for (const skipped of again.skipped) assert.match(String(skipped.cause), /fresh/i);
  } finally {
    s.close();
  }
});

function makeFailed(store: TaskStore, title: string, attempts: number, meta: Record<string, unknown>): string {
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

const SMALL_POLICY: RetryPolicy = { maxAttempts: 3, baseMs: 100, maxMs: 250 };

test("retry scheduling: categories, cap, exhaustion and idempotence", () => {
  const s = tempDb();
  try {
    t = 1000;
    const auth = coordinatorAuth(s.db);
    const exec = makeFailed(s.store, "execution error", 1, { error: "boom", failureKind: "execution-error" });
    const verif = makeFailed(s.store, "verification failed", 1, { verification: "fail", verificationNote: "gradle test failures" });
    const verr = makeFailed(s.store, "verifier broke", 1, { verification: "fail", verificationNote: "verifier error: prompt timed out" });
    const ambig = makeFailed(s.store, "ambiguous verdict", 1, { verification: "fail", verificationNote: "ambiguous verification response: no explicit VERDICT line — treated as FAIL" });
    const legacy = makeFailed(s.store, "legacy failure", 1, { error: "old failure without classification" });
    const capped = makeFailed(s.store, "exhausted failure", 3, { error: "boom", failureKind: "execution-error" });

    const report = scheduleFailedRetries(s.store, auth, SMALL_POLICY);
    assert.equal(report.scheduled, 3);
    assert.equal(report.exhausted, 1);
    assert.equal(report.skipped.length, 2);

    const eligibleOf = (id: string): number | undefined => {
      const failure = s.store.getTask(id)?.executionMetadata["failure"] as Record<string, unknown> | undefined;
      return failure === undefined ? undefined : Number(failure["eligibleAt"]);
    };
    // backoff for attempt 1 (attempt after failure = 1): n=0 → base
    assert.equal(eligibleOf(exec), 1000 + SMALL_POLICY.baseMs);
    assert.equal((s.store.getTask(exec)?.executionMetadata["failure"] as Record<string, unknown>)["category"], "execution-error");
    assert.equal((s.store.getTask(verif)?.executionMetadata["failure"] as Record<string, unknown>)["category"], "verification-fail");
    assert.equal((s.store.getTask(verr)?.executionMetadata["failure"] as Record<string, unknown>)["category"], "verifier-error");
    // ambiguous and legacy stay manual-only, with no scheduled retry record
    assert.equal(eligibleOf(ambig), undefined);
    assert.equal(eligibleOf(legacy), undefined);
    // attempts cap: exhausted flag persisted, no eligibility
    const cappedMeta = s.store.getTask(capped)?.executionMetadata["failure"] as Record<string, unknown>;
    assert.equal(cappedMeta["attemptsExhausted"], true);
    assert.equal(cappedMeta["eligibleAt"], undefined);

    // idempotent: a second pass reschedules nothing (scheduling is durable); the
    // capped task still reports as exhausted because it is still FAILED and past its cap
    t = 2000;
    const again = scheduleFailedRetries(s.store, auth, SMALL_POLICY);
    assert.equal(again.scheduled, 0);
    assert.equal(again.exhausted, 1);
    assert.equal(again.skipped.length, 5); // 3 already scheduled + 2 manual-only
    // the eligible times persisted by the first pass remain untouched
    assert.equal(eligibleOf(exec), 1000 + SMALL_POLICY.baseMs);
  } finally {
    s.close();
  }
});

test("retry backoff uses the canonical policy values (60s base, 30m cap)", () => {
  assert.equal(retryBackoffMs(DEFAULT_RETRY_POLICY, 1), 60_000);
  assert.equal(retryBackoffMs(DEFAULT_RETRY_POLICY, 2), 120_000);
  assert.equal(retryBackoffMs(DEFAULT_RETRY_POLICY, 3), 240_000);
  assert.equal(retryBackoffMs(DEFAULT_RETRY_POLICY, 9), 1_800_000);
  assert.equal(retryBackoffMs(DEFAULT_RETRY_POLICY, 99), 1_800_000);
});

test("retry-due pass requeues only after eligibility passes (backoff honored)", () => {
  const s = tempDb();
  try {
    t = 1000;
    const auth = coordinatorAuth(s.db);
    const exec = makeFailed(s.store, "retry me", 1, { error: "boom", failureKind: "execution-error" });
    const scheduled = s.store.scheduleRetryWithCoordinator(exec, auth, {
      category: "execution-error",
      reason: "execution error: boom",
      eligibleAt: 1000 + SMALL_POLICY.baseMs,
      maxAttempts: SMALL_POLICY.maxAttempts,
    });
    assert.equal(scheduled.status, "scheduled");

    // before the eligible time: untouched
    t = 1050;
    const early = requeueRetryDueTasks(s.store, auth);
    assert.equal(early.requeued, 0);
    assert.equal(s.store.getTask(exec)?.status, "FAILED");

    // after the eligible time: FAILED → BACKLOG
    t = 1300;
    const due = requeueRetryDueTasks(s.store, auth);
    assert.equal(due.requeued, 1);
    assert.equal(s.store.getTask(exec)?.status, "BACKLOG");
    // idempotent
    const again = requeueRetryDueTasks(s.store, auth);
    assert.equal(again.requeued, 0);
  } finally {
    s.close();
  }
});

test("exhausted attempts stay FAILED (the cap is never bypassed by retries)", () => {
  const s = tempDb();
  try {
    t = 1000;
    const auth = coordinatorAuth(s.db);
    const dep = makeFailed(s.store, "exhausted blocking task", 3, { error: "boom", failureKind: "execution-error" });
    const sched = s.store.scheduleRetryWithCoordinator(dep, auth, {
      category: "execution-error",
      reason: "boom",
      eligibleAt: 1000,
      maxAttempts: 3,
    });
    assert.equal(sched.status, "exhausted");
    // exhaustion persists the flag and never makes the row requeue-eligible
    const meta = s.store.getTask(dep)?.executionMetadata["failure"] as Record<string, unknown>;
    assert.equal(meta["attemptsExhausted"], true);
    assert.equal(meta["eligibleAt"], undefined);
    const report = requeueRetryDueTasks(s.store, auth);
    assert.equal(report.requeued, 0);
    assert.equal(s.store.getTask(dep)?.status, "FAILED");
  } finally {
    s.close();
  }
});

test("a FAILED dependency keeps its dependent out of the queue", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-rec-repo-"));
  fs.mkdirSync(path.join(repo, "src/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/main/java/io/diakosys/HealthEvaluator.java"), "class HealthEvaluator {}");
  const s = tempDb();
  try {
    t = 1000;
    const auth = coordinatorAuth(s.db);
    const dep = makeFailed(s.store, "Add system-CPU sampling", 1, { error: "boom", failureKind: "execution-error" });
    const sched = s.store.scheduleRetryWithCoordinator(dep, auth, {
      category: "execution-error",
      reason: "boom",
      eligibleAt: 1000 + SMALL_POLICY.baseMs,
      maxAttempts: SMALL_POLICY.maxAttempts,
    });
    assert.equal(sched.status, "scheduled");
    const child = s.store.addTask({ title: "Guard evaluator against NaN samples" });
    s.store.setMetadata(child.id, {
      proposal: {
        title: "Guard evaluator against NaN samples",
        problem: "Non-finite samples reach the health evaluator and corrupt the score",
        rationale: "The evaluator must reject non-finite sampled values",
        approach: "Pin the sample before scoring and reject NaN/Infinity",
        outcome: "The health score stays finite for every sample",
        priority: 6,
        complexity: "low",
        evidence: [{ file: "src/main/java/io/diakosys/HealthEvaluator.java", observation: "sampled value is not finite" }],
        verification: ["npm test"],
        dependencies: ["Add system-CPU sampling"],
      },
      discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
    });

    const reports = planDiscoveredTasks(s.db, repo, auth);
    const entry = reports.find((r) => r.taskId === child.id);
    // the FAILED dependency is not finished, so the child is held, not queued
    assert.equal(entry?.decision, "backlog");
    assert.deepEqual(entry?.unmetDependencies, ["Add system-CPU sampling"]);
  } finally {
    s.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
