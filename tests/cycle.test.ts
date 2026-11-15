import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import { MockOpenCodeAdapter, type OpenCodeAdapter } from "../src/opencode.ts";
import { runCycle } from "../src/cycle.ts";
import type { PlanMeta } from "../src/planner.ts";
import { makeProposal } from "./helpers.ts";

function setup(): {
  db: import("node:sqlite").DatabaseSync;
  store: TaskStore;
  dbPath: string;
  close(): void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cycle-"));
  const dbPath = path.join(dir, "tasks.db");
  const db = openDatabase(dbPath);
  return {
    db,
    store: new TaskStore(db),
    dbPath,
    close: () => closeDatabase(db),
  };
}

/** Deterministic full-cycle mock: execution prompts execute, verification
 * prompts issue the configured verdict. */
function mockCycleAdapter(verifyReply: "PASS" | "FAIL" | "AMBIGUOUS"): OpenCodeAdapter {
  return new MockOpenCodeAdapter((input) => {
    if (input.description.startsWith("VERIFY TASK:")) {
      if (verifyReply === "PASS") return "checked the work\nVERDICT: PASS — checks green";
      if (verifyReply === "FAIL") return "checked the work\nVERDICT: FAIL — checks broke";
      return "checked the work but cannot say";
    }
    return `mock executed: ${input.title}`;
  });
}

const readyTask = (s: ReturnType<typeof setup>, title = "Handle the NaN guard", priority = 0): string => {
  const t = s.store.addTask({ title, priority });
  s.store.transition(t.id, "BACKLOG");
  s.store.transition(t.id, "READY");
  return t.id;
};

function backloggedWithDep(s: ReturnType<typeof setup>, title: string, depId: string): string {
  const t = s.store.addTask({ title, priority: 0 });
  s.store.transition(t.id, "BACKLOG");
  s.store.setMetadata(t.id, {
    plan: {
      plannedAt: Date.now(),
      dependencies: [depId],
      unmetDependencies: [title === "Guard evaluator" ? "missing title" : "Fix evaluator first"],
      unresolvedDependencies: [],
      conflictWith: [],
      decision: "backlog",
      reason: "waiting for dependencies: Fix evaluator first",
    } as PlanMeta,
  });
  return t.id;
}

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cycle-repo-"));
  fs.mkdirSync(path.join(dir, "src/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthEvaluator.java"), "class HealthEvaluator {}");
  return dir;
}

test("cycle executes a READY task end-to-end: claim → execute → verify PASS → DONE", async () => {
  const s = setup();
  try {
    const id = readyTask(s, "Handle the NaN guard", 6);
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
    assert.equal(summary.executionFailures, 0);
    assert.equal(summary.verifiedPass, 1);
    assert.equal(summary.verifiedFail, 0);
    assert.equal(summary.stopReason, "no-progress");

    const stored = s.store.getTask(id);
    assert.equal(stored?.status, "DONE");
    assert.equal(stored?.executionMetadata["verification"], "pass");
    assert.match(String(stored?.executionMetadata["verificationNote"]), /checks green/);
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

test("cycle verification FAIL transitions to FAILED with evidence", async () => {
  const s = setup();
  try {
    const id = readyTask(s);
    const summary = await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: mockCycleAdapter("FAIL"),
      maxExecutions: 3,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: () => undefined,
    });
    assert.equal(summary.executed, 1);
    assert.equal(summary.verifiedFail, 1);
    const stored = s.store.getTask(id);
    assert.equal(stored?.status, "FAILED");
    assert.equal(stored?.executionMetadata["verification"], "fail");
    assert.match(String(stored?.executionMetadata["verificationNote"]), /verifier fail/);
  } finally {
    s.close();
  }
});

test("cycle verification ambiguity fails and is never treated as pass", async () => {
  const s = setup();
  try {
    const id = readyTask(s);
    const summary = await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: mockCycleAdapter("AMBIGUOUS"),
      maxExecutions: 3,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: () => undefined,
    });
    assert.equal(summary.verifiedFail, 1);
    assert.equal(s.store.getTask(id)?.status, "FAILED");
    assert.notEqual(s.store.getTask(id)?.executionMetadata["verification"], "pass");
  } finally {
    s.close();
  }
});

test("a completed prerequisite unblocks its dependent on the next round", async () => {
  const s = setup();
  try {
    const a = readyTask(s, "Fix evaluator first", 9);
    const b = backloggedWithDep(s, "Prepare sampler fix second", a);
    const summary = await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: mockCycleAdapter("PASS"),
      maxExecutions: 5,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: () => undefined,
    });
    // round 1 promoted nothing (a was already READY; b waited for a),
    // round 2 promoted b after a reached DONE
    assert.equal(summary.plannedReady, 1);
    assert.equal(summary.executed, 2);
    assert.equal(summary.verifiedPass, 2);
    assert.equal(summary.stopReason, "no-progress");
    assert.equal(s.store.getTask(a)?.status, "DONE");
    assert.equal(s.store.getTask(b)?.status, "DONE");
    const bHistory = s.store.eventsFor(b).map((e) => `${e.fromState}→${e.toState}`);
    assert.ok(bHistory.some((e) => e === "BACKLOG→READY"), "the dependent was promoted");
    assert.equal(bHistory[bHistory.length - 1], "VERIFYING→DONE");
  } finally {
    s.close();
  }
});

test("cycle stops at the execution limit with work still queued", async () => {
  const s = setup();
  try {
    const first = readyTask(s, "Handle the NaN guard", 6);
    const second = readyTask(s, "Trace the heap growth", 5);
    const summary = await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: mockCycleAdapter("PASS"),
      maxExecutions: 1,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: () => undefined,
    });
    assert.equal(summary.executed, 1);
    assert.equal(summary.stopReason, "execution-limit");
    assert.equal(s.store.getTask(first)?.status, "DONE");
    assert.equal(s.store.getTask(second)?.status, "READY");
  } finally {
    s.close();
  }
});

test("cycle terminates with no-progress when nothing can advance", async () => {
  const s = setup();
  try {
    // a manual DISCOVERED task without a proposal payload cannot be planned
    // and must not loop the cycle forever
    const stuck = s.store.addTask({ title: "Not plannable" });
    const summary = await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: mockCycleAdapter("PASS"),
      maxExecutions: 5,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: () => undefined,
    });
    assert.equal(summary.executed, 0);
    assert.equal(summary.stopReason, "no-progress");
    assert.ok(summary.rounds <= 2);
    assert.equal(s.store.getTask(stuck.id)?.status, "DISCOVERED");
  } finally {
    s.close();
  }
});

test("mock discovery runs through the engine and the cycle completes it", async () => {
  const s = setup();
  try {
    const repoDir = tmpRepo();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cycle-cache-"));
    try {
      const discoveryAdapter = new MockOpenCodeAdapter(() =>
        JSON.stringify([makeProposal({ priority: 6 })]),
      );
      const summary = await runCycle({
        db: s.db,
        directory: repoDir,
        discovery: {
          adapter: discoveryAdapter,
          repoDir,
          model: "test/discovery",
          areas: ["reliability"],
          maxProposalsPerArea: 1,
          promptTimeoutMs: 5000,
          cacheDir,
        },
        executionAdapter: mockCycleAdapter("PASS"),
        maxExecutions: 3,
        retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
        taskLeaseTtlMs: 5000,
        onOutput: () => undefined,
      });
      assert.equal(summary.discoveredAccepted, 1);
      assert.equal(summary.plannedReady, 1);
      assert.equal(summary.executed, 1);
      assert.equal(summary.verifiedPass, 1);
      assert.equal(summary.stopReason, "no-progress");
      const tasks = s.store.listTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.status, "DONE");
      assert.equal(tasks[0]?.executionMetadata["discoveryRun"] !== undefined, true);
      assert.equal(tasks[0]?.executionMetadata["proposal"] !== undefined, true);
      // the engine manifest landed in the isolated cacheDir only
      assert.equal(fs.existsSync(path.join(cacheDir, "discovery-runs", "runs.json")), true);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  } finally {
    s.close();
  }
});

test("final task state and verification evidence survive close/reopen", async () => {
  const s = setup();
  try {
    const id = readyTask(s);
    await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: mockCycleAdapter("PASS"),
      maxExecutions: 3,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: () => undefined,
    });
    const dbPath = s.dbPath;
    s.close();

    const db2 = openDatabase(dbPath);
    const store2 = new TaskStore(db2);
    const stored = store2.getTask(id);
    assert.equal(stored?.status, "DONE");
    assert.equal(stored?.executionMetadata["verification"], "pass");
    assert.match(String(stored?.executionMetadata["verificationNote"]), /checks green/);
    const history = store2.eventsFor(id).map((e) => e.toState);
    assert.equal(history[history.length - 1], "DONE");
    closeDatabase(db2);
  } finally {
    s.close();
  }
});

test("an execution failure inside the cycle is recorded and the cycle continues", async () => {
  const s = setup();
  try {
    const id = readyTask(s);
    const summary = await runCycle({
      db: s.db,
      directory: "/tmp/project",
      executionAdapter: new MockOpenCodeAdapter(() => {
        throw new Error("opencode unreachable");
      }),
      maxExecutions: 3,
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 4000 },
      taskLeaseTtlMs: 5000,
      onOutput: () => undefined,
    });
    assert.equal(summary.executed, 1);
    assert.equal(summary.executionFailures, 1);
    const stored = s.store.getTask(id);
    assert.equal(stored?.status, "FAILED");
    assert.match(String(stored?.executionMetadata["error"]), /opencode unreachable/);
    assert.equal(stored?.executionMetadata["verification"] === undefined, true);
  } finally {
    s.close();
  }
});
