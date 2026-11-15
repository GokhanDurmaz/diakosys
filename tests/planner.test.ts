import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import type { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/store.ts";
import { DiscoveryRunStore, selectAreas } from "../src/discovery.ts";
import {
  planDiscoveredTasks,
  listDuplicateTitles,
  dedupeProposals,
  revalidateProposal,
} from "../src/planner.ts";
import type { PlanMeta } from "../src/planner.ts";
import { repoManifest } from "../src/discovery.ts";
import type { Proposal } from "../src/proposal.ts";
import { titleSimilarity } from "../src/proposal.ts";
import { makeProposal } from "./helpers.ts";
import type { CoordinatorAuthority } from "../src/locks.ts";

/** Test coordinator: stamps the instance lock row as the planner's authority. */
function coordinatorAuth(db: DatabaseSync): CoordinatorAuthority {
  const owner = "planner-test";
  const row = db.prepare("SELECT owner, generation FROM instance_locks WHERE id = 1").get() as
    | { owner: string; generation: number }
    | undefined;
  if (row === undefined || row.owner !== owner) {
    db.prepare(
      "UPDATE instance_locks SET owner = ?, generation = generation + 1, expires_at = ? WHERE id = 1",
    ).run(owner, Date.now() + 600_000);
  }
  const refreshed = db.prepare("SELECT generation FROM instance_locks WHERE id = 1").get() as { generation: number };
  return { owner, generation: refreshed.generation, lockTtlMs: 120_000 };
}

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-plan-"));
  fs.mkdirSync(path.join(dir, "src/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthEvaluator.java"), "class HealthEvaluator {}");
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/SystemCpuSampler.java"), "class SystemCpuSampler {}");
  return dir;
}

function openDb(dir: string): { dbPath: string; close(): void; db: DatabaseSync; store: TaskStore } {
  const dbPath = path.join(dir, "tasks.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  return { dbPath, close: () => closeDatabase(db), db, store: new TaskStore(db) };
}

function proposalPayload(proposal: Partial<Proposal> = {}): unknown {
  return { ...proposal, evidence: proposal.evidence ?? [{ file: "src/main/java/io/diakosys/HealthEvaluator.java", observation: "sampled value is not finite" }] };
}

const discoveryRunMeta = { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" };

/** Walk BACKLOG/READY through to DONE (planner transitions are state-machine only). */
function finishTask(store: TaskStore, id: string): void {
  for (const step of ["READY", "IN_PROGRESS", "REVIEW", "VERIFYING", "DONE"] as const) {
    const status = store.getTask(id)?.status;
    if (status === step || status === "DONE") continue;
    store.transition(id, step);
  }
}

test("plan accepts a valid proposal and queues the task", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, { proposal: proposalPayload(makeProposal({ priority: 6 })), discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" } });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    const entry = reports.find((r) => r.taskId === task.id);
    assert.equal(entry?.decision, "ready");
    assert.equal(entry?.reason, "queued (READY)");
    const plan = store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.equal(plan?.decision, "ready");
    assert.equal(plan?.reason, "validated; moving to queue");
    assert.deepEqual(entry?.title, "Guard evaluator against NaN samples");
    assert.equal(store.getTask(task.id)?.status, "READY");
  } finally {
    settings.close();
  }
});

test("plan accepts a proposal wrapped under the proposal key", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, {
      proposal: { proposal: proposalPayload(makeProposal({ priority: 6 })) },
      discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
    });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    const entry = reports.find((r) => r.taskId === task.id);
    assert.equal(entry?.decision, "ready");
    assert.equal(store.getTask(task.id)?.status, "READY");
    const plan = store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.equal(plan?.decision, "ready");
  } finally {
    settings.close();
  }
});

test("plan skips tasks without a proposal payload", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "No proposal here", priority: 0 });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "skipped");
    assert.equal(store.getTask(task.id)?.status, "DISCOVERED");
  } finally {
    settings.close();
  }
});

test("plan rejects a proposal whose evidence file does not exist", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Missing file proposal", priority: 0 });

    store.setMetadata(task.id, {
      proposal: { ...makeProposal({ priority: 0 }), evidence: [{ file: "src/main/java/io/diakosys/Nope.java", observation: "x" }] },
      discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
    });
    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "rejected");
    assert.equal(store.getTask(task.id)?.status, "DISCOVERED");
  } finally {
    settings.close();
  }
});

test("plan detects a duplicate title against an existing task", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const existing = store.addTask({ title: "Guard evaluator against NaN samples", priority: 10 });
    store.transition(existing.id, "BACKLOG");
    store.transition(existing.id, "READY");
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 0 });

    store.setMetadata(task.id, { proposal: proposalPayload(makeProposal({ priority: 0 })) });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "duplicate");
    assert.equal(store.getTask(task.id)?.status, "DISCOVERED");
    assert.equal((store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined)?.decision, "duplicate");
  } finally {
    settings.close();
  }
});

test("plan holds a task in BACKLOG while its dependency is unfinished", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const dep = store.addTask({ title: "Add system-CPU sampling", priority: 5 });
    store.transition(dep.id, "BACKLOG");
    store.transition(dep.id, "READY");
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, {
      proposal: {
        ...makeProposal({ priority: 6 }),
        dependencies: ["Add system-CPU sampling"],
      },
      discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
    });
    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "backlog");
    assert.equal(store.getTask(task.id)?.status, "BACKLOG");
    assert.deepEqual((store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined)?.unmetDependencies, ["Add system-CPU sampling"]);
    // PlanMeta.dependencies holds the ids the task waits for (unmet at
    // planning time); Phase A's re-check relies on this list
    assert.deepEqual((store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined)?.dependencies, [dep.id]);
    // re-planning while the dependency is not DONE must keep the task waiting
    const second = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(second.find((r) => r.taskId === task.id)?.decision, "unchanged");
    assert.equal(store.getTask(task.id)?.status, "BACKLOG");
  } finally {
    settings.close();
  }
});

test("plan clears the dependency once the blocking task finishes", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const dep = store.addTask({ title: "Add system-CPU sampling", priority: 5 });
    store.transition(dep.id, "BACKLOG");
    store.transition(dep.id, "READY");
    store.transition(dep.id, "IN_PROGRESS");
    store.transition(dep.id, "REVIEW");
    store.transition(dep.id, "VERIFYING");
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 6 }),
        dependencies: ["Add system-CPU sampling"],
      }),
      discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
    });
    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "backlog");
    store.transition(dep.id, "DONE");
    const again = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(again.find((r) => r.taskId === task.id)?.decision, "ready");
    assert.deepEqual((store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined)?.unmetDependencies ?? [], []);
  } finally {
    settings.close();
  }
});

test("plan moves an accepted conflict task to BACKLOG and clears it when the conflict ends", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const other = store.addTask({ title: "Fix heap leak", priority: 1 });
    store.transition(other.id, "BACKLOG");
    store.transition(other.id, "READY");
    store.transition(other.id, "IN_PROGRESS");
    store.transition(other.id, "REVIEW");
    store.setMetadata(other.id, { plan: { primaryFile: "src/main/java/io/diakosys/SystemCpuSampler.java", dependencies: [], unmetDependencies: [], conflictWith: [], decision: "backlog", reason: "in progress" } });
    const task = store.addTask({ title: "Trace heap growth in the sampler thread", priority: 0 });

    store.setMetadata(task.id, {
      proposal: proposalPayload({ ...makeProposal({ priority: 0 }), evidence: [{ file: "src/main/java/io/diakosys/SystemCpuSampler.java", observation: "heap grows unboundedly" }] }),
      discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
    });
    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "backlog");
    assert.equal(store.getTask(task.id)?.status, "BACKLOG");
    store.transition(other.id, "VERIFYING");
    store.transition(other.id, "DONE");
    const again = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(again.find((r) => r.taskId === task.id)?.decision, "ready");
  } finally {
    settings.close();
  }
});

test("plan never moves a task to DONE", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, { proposal: proposalPayload(makeProposal({ priority: 6 })) });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "ready");
    assert.equal(store.getTask(task.id)?.status, "READY");
  } finally {
    settings.close();
  }
});

test("plan records a proposal metadata snapshot and a planning event", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, {
      proposal: proposalPayload({ ...makeProposal({ priority: 6 }) }),
      discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
    });
    const before = store.getTask(task.id)?.executionMetadata;
    planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    const after = store.getTask(task.id)?.executionMetadata;
    assert.deepEqual(before?.proposal, after?.proposal);
    assert.deepEqual(before?.discoveryRun, after?.discoveryRun);
    assert.equal(before?.lastRunAt, undefined);
    assert.equal(after?.primaryFile, "src/main/java/io/diakosys/HealthEvaluator.java");
    assert.equal(after?.complexity, "low");
    const meta = store.getTask(task.id)?.executionMetadata as Record<string, unknown> | undefined;
    const rawHistory: string = meta === undefined ? "[]" : String(meta["eventHistory"]);
    const history = JSON.parse(rawHistory) as unknown as string[];
    assert.equal(history.length, 1);
    assert.match(history[0]!, /validated and accepted/);
  } finally {
    settings.close();
  }
});

test("plan works after a database reopen with no open handle", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  const store = settings.store;
  const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

  store.setMetadata(task.id, {
    proposal: proposalPayload(makeProposal({ priority: 6 })),
    discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
  });
  settings.close();
  const reopened = openDb(dir);
  try {
    const reports = planDiscoveredTasks(reopened.db, dir, coordinatorAuth(reopened.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "ready");
    assert.equal(reopened.store.getTask(task.id)?.status, "READY");
  } finally {
    reopened.close();
  }
});

test("planning a proposal does not persist a discovery run", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, {
      proposal: proposalPayload(makeProposal({ priority: 6 })),
      discoveryRun: { model: "Qwen-Mimo/model", at: Date.now(), areas: "auto" },
    });
    planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(settings.store.listTasks().length, 1);
  } finally {
    settings.close();
  }
});

test("discovery runs are persisted, recoverable and resumable", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  let mainDbClosed = false;
  try {
    const db = settings.db as DatabaseSync;
    const runs = new DiscoveryRunStore(db);
    const a = runs.start([{ key: "reliability", focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing." }], "Qwen-Mimo/model", coordinatorAuth(settings.db));
    assert.match(a, /^disc_\w+/);
    runs.complete(a, { areasCompleted: 1, rawProposals: 0, accepted: 0, rejected: 0 }, coordinatorAuth(settings.db));
    assert.equal(runs.statusOf(a), "completed");
    assert.equal(runs.areaCountOf(a), 1);

    const b = runs.start([{ key: "reliability", focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing." }], "Qwen-Mimo/model", coordinatorAuth(settings.db));
    runs.fail(b, "connection refused", coordinatorAuth(settings.db));
    assert.equal(runs.statusOf(b), "failed");

    // reopen without an open handle, then continue
    settings.close();
    mainDbClosed = true;
    const reopened = openDb(dir);
    try {
      const recovered = new DiscoveryRunStore(reopened.db);
      assert.equal(recovered.statusOf(b), "failed");
      const c = recovered.start([{ key: "reliability", focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing." }], "Qwen-Mimo/model", coordinatorAuth(reopened.db));
      recovered.complete(c, { areasCompleted: 1, rawProposals: 0, accepted: 0, rejected: 0 }, coordinatorAuth(reopened.db));
      assert.equal(recovered.statusOf(c), "completed");
      assert.equal(recovered.errorOf(c), null);
    } finally {
      reopened.close();
    }
  } finally {
    if (!mainDbClosed) settings.close();
  }
});

test("plan reports unresolvable dependencies and holds the task in BACKLOG", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const dep = store.addTask({ title: "Add system-CPU sampling", priority: 5 });
    store.transition(dep.id, "BACKLOG");
    store.transition(dep.id, "READY");
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 6 }),
        dependencies: ["Add system-CPU sampling", "Does not exist anywhere"],
      }),
    });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    const entry = reports.find((r) => r.taskId === task.id);
    assert.equal(entry?.decision, "backlog");
    assert.deepEqual(entry?.unresolvedDependencies, ["Does not exist anywhere"]);
    assert.equal(store.getTask(task.id)?.status, "BACKLOG");
    const plan = store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.equal(plan?.decision, "backlog");
    assert.equal(plan?.reason, "unresolvable dependencies: Does not exist anywhere");
    assert.deepEqual(plan?.unresolvedDependencies, ["Does not exist anywhere"]);
    assert.deepEqual(plan?.unmetDependencies, ["Does not exist anywhere"]);
    assert.deepEqual(plan?.dependencies, [dep.id]);
    assert.equal(store.eventsFor(task.id).some((e) => e.eventType === "planned"), true);
  } finally {
    settings.close();
  }
});

test("plan keeps resolving the resolvable part of a dependency list", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const dep = store.addTask({ title: "Add system-CPU sampling", priority: 5 });
    store.transition(dep.id, "BACKLOG");
    store.transition(dep.id, "READY");
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 6 }),
        dependencies: ["Add system-CPU sampling", "Missing prerequisite"],
      }),
    });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "backlog");
    const plan = store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.deepEqual(plan?.dependencies, [dep.id]);
    assert.deepEqual(plan?.unresolvedDependencies, ["Missing prerequisite"]);
  } finally {
    settings.close();
  }
});

test("plan records an event and planning metadata for an already planned task", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });

    store.setMetadata(task.id, {
      proposal: proposalPayload(makeProposal({ priority: 6 })),
      plan: {
        plannedAt: Date.now(),
        primaryFile: "src/main/java/io/diakosys/HealthEvaluator.java",
        complexity: "low",
        dependencies: [],
        unmetDependencies: [],
        unresolvedDependencies: [],
        conflictWith: [],
        decision: "backlog",
        reason: "waiting for dependencies: Missing prerequisite",
      },
    });
    store.recordPlanning(task.id, "earlier planning decision");

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "unchanged");
    assert.equal(reports.find((r) => r.taskId === task.id)?.reason, "already planned");
    assert.equal(store.getTask(task.id)?.status, "DISCOVERED");
    const events = store.eventsFor(task.id);
    assert.equal(events.filter((e) => e.eventType === "planned").length, 2);
    assert.equal(events.find((e) => e.eventType === "planned")?.detail, "earlier planning decision");
    const plannedEvent = events.find((e) => e.eventType === "planned" && e.seq === 3);
    assert.match(plannedEvent?.detail ?? "", /already planned/);
    const plan = store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.equal(plan?.decision, "unchanged");
  } finally {
    settings.close();
  }
});

test("listDuplicateTitles returns non-DONE task titles that duplicate the input", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const a = store.addTask({ title: "Add system-CPU sampling", priority: 1 });
    store.transition(a.id, "BACKLOG");
    store.transition(a.id, "READY");
    const b = store.addTask({ title: "Different task", priority: 2 });
    store.transition(b.id, "BACKLOG");
    const c = store.addTask({ title: "Add system-CPU sampling task", priority: 3 });
    store.transition(c.id, "BACKLOG");
    const done = store.addTask({ title: "Add system-CPU sampling", priority: 4 });
    store.transition(done.id, "BACKLOG");
    store.transition(done.id, "READY");
    store.transition(done.id, "IN_PROGRESS");
    store.transition(done.id, "REVIEW");
    store.transition(done.id, "VERIFYING");
    store.transition(done.id, "DONE");

    assert.deepEqual(listDuplicateTitles(store, ["Add system-CPU sampling"]), [c.title, a.title]);
    assert.deepEqual(listDuplicateTitles(store, ["Unrelated work"]), []);
    assert.deepEqual(listDuplicateTitles(store, []), []);
  } finally {
    settings.close();
  }
});

test("dedupeProposals keeps the highest-ranked proposal per title-equivalent group", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const existing = store.addTask({ title: "Guard evaluator against NaN samples", priority: 9 });
    store.transition(existing.id, "BACKLOG");
    const other = store.addTask({ title: "Add system-CPU sampling", priority: 8 });
    store.transition(other.id, "BACKLOG");

    const proposals = [
      makeProposal({ title: "Fix heap leak", priority: 8, complexity: "high" }),
      makeProposal({ title: "Guard evaluator against NaN samples", priority: 6, complexity: "low" }),
      makeProposal({ title: "Add system-CPU sampling", priority: 8, complexity: "medium" }),
      makeProposal({ title: "Add system-CPU sampling", priority: 5, complexity: "high" }),
      makeProposal({ title: "Guard evaluator against NaN samples", priority: 1, complexity: "high" }),
    ];

    const result = dedupeProposals(proposals, store);
    // priority desc, then complexity rank, then title
    assert.equal(result.kept.length, 3);
    assert.equal(result.kept[0]!.title, "Fix heap leak");
    assert.equal(result.kept[0]!.priority, 8);
    assert.equal(result.kept[1]!.title, "Add system-CPU sampling");
    assert.equal(result.kept[1]!.priority, 8);
    assert.equal(result.kept[2]!.title, "Guard evaluator against NaN samples");
    assert.equal(result.kept[2]!.priority, 6);
    assert.equal(result.accepted.length, 3);
    assert.equal(result.duplicates.length, 2);
    // priority 5 (high) outranks priority 1 (high) inside its group
    assert.equal(result.duplicates[0]!.proposal.priority, 5);
    assert.equal(result.duplicates[0]!.reason, 'duplicate of existing task title "Add system-CPU sampling"');
    assert.equal(result.duplicates[1]!.proposal.priority, 1);
    assert.equal(result.duplicates[1]!.reason, 'duplicate of existing task title "Guard evaluator against NaN samples"');
  } finally {
    settings.close();
  }
});

test("revalidateProposal rejects a title that duplicates an existing task", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const existing = store.addTask({ title: "Guard evaluator against NaN samples", priority: 9 });
    store.transition(existing.id, "BACKLOG");
    const other = store.addTask({ title: "Guard evaluator against NaN samples", priority: 1 });
    store.transition(other.id, "BACKLOG");

    // the proposal belongs to "other", so only "existing" counts as a duplicate
    const duplicate = makeProposal({ title: "Guard evaluator against NaN samples" });
    assert.equal(revalidateProposal(duplicate, dir, store, other.id).ok, false);
    assert.equal(revalidateProposal(duplicate, dir, store, other.id).reason, "title duplicates an existing task");

    const clean = makeProposal({ title: "Fix NaN handling in the health evaluator" });
    assert.equal(revalidateProposal(clean, dir, store, other.id).ok, true);
    assert.equal(revalidateProposal(clean, dir, store, other.id).proposal?.title, clean.title);

    // without a store the duplicate check is skipped and validation alone decides
    assert.equal(revalidateProposal(duplicate, dir).ok, true);
    assert.equal(revalidateProposal(clean, dir).ok, true);
  } finally {
    settings.close();
  }
});

test("setMetadata does not touch lastRunAt and append-only planning events survive reopens", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  const store = settings.store;
  const task = store.addTask({ title: "t", priority: 1 });

  store.setMetadata(task.id, { proposal: proposalPayload({ priority: 1 }), discoveryRun: { model: "M", at: Date.now(), areas: "auto" } });
  const before = new Date(store.getTask(task.id)?.lastRunAt ?? 0).getTime();
  store.recordPlanning(task.id, "first plan");
  store.recordPlanning(task.id, "second plan");
  assert.equal(new Date(store.getTask(task.id)?.lastRunAt ?? 0).getTime(), before);

    // append-only planning events (task_events) must survive a reopen with no open handle
    const events = store.eventsFor(task.id);
    assert.equal(events.length, 3); // created + 2 planned
    assert.equal(events.filter((e) => e.eventType === "planned").length, 2);
    settings.close();
    const reopened = openDb(dir);
    try {
      const restored = reopened.store.eventsFor(task.id);
      assert.equal(restored.length, events.length);
      assert.equal(restored[1]!.eventType, "planned");
      assert.equal(reopened.store.getTask(task.id)?.executionMetadata["proposal"] !== undefined, true);
      assert.equal(reopened.store.getTask(task.id)?.executionMetadata["discoveryRun"] !== undefined, true);
    } finally {
      reopened.close();
    }
});

// ---------------------------------------------------------------------------
// P1 — BACKLOG holders of a primary file block fresh proposals
// ---------------------------------------------------------------------------

test("a fresh proposal queues behind a BACKLOG-only primary-file holder", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    // holder created via the unmet-dependency path
    const dep = store.addTask({ title: "Prepare sampler baseline", priority: 3 });
    const holder = store.addTask({ title: "Fix sampler leak", priority: 7 });
    store.setMetadata(holder.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 7 }),
        title: "Fix sampler leak",
        evidence: [{ file: "src/main/java/io/diakosys/SystemCpuSampler.java", observation: "sampler leaks" }],
        dependencies: ["Prepare sampler baseline"],
      }),
      discoveryRun: discoveryRunMeta,
    });
    const first = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(first.find((r) => r.taskId === holder.id)?.decision, "backlog");
    assert.equal(store.getTask(holder.id)?.status, "BACKLOG");

    const fresh = store.addTask({ title: "Trace heap growth in the sampler thread", priority: 0 });
    store.setMetadata(fresh.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 0 }),
        title: "Trace heap growth in the sampler thread",
        evidence: [{ file: "src/main/java/io/diakosys/SystemCpuSampler.java", observation: "heap grows unboundedly" }],
      }),
      discoveryRun: discoveryRunMeta,
    });
    const second = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    const freshEntry = second.find((r) => r.taskId === fresh.id);
    assert.equal(freshEntry?.decision, "backlog");
    assert.match(freshEntry?.reason ?? "", /^conflict: .*SystemCpuSampler\.java/);
    assert.equal(store.getTask(fresh.id)?.status, "BACKLOG");
    assert.equal(store.getTask(holder.id)?.status, "BACKLOG");

    // run again: the fresh task stays queued behind the holder
    const third = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(third.find((r) => r.taskId === fresh.id)?.decision, "unchanged");
    assert.equal(store.getTask(fresh.id)?.status, "BACKLOG");

    // from the moment the holder (dep) is DONE, the fresh task promotes normally
    store.transition(dep.id, "BACKLOG");
    finishTask(store, dep.id);
    assert.equal(planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db)).find((r) => r.taskId === fresh.id)?.decision, "unchanged");
    assert.equal(store.getTask(fresh.id)?.status, "BACKLOG");
    finishTask(store, holder.id);
    const last = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(last.find((r) => r.taskId === fresh.id)?.decision, "ready");
    assert.equal(store.getTask(fresh.id)?.status, "READY");
  } finally {
    settings.close();
  }
});

test("a proposal-evidence holder blocks fresh proposals even without plan.primaryFile", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const holder = store.addTask({ title: "Fix heap leak", priority: 7 });
    store.transition(holder.id, "BACKLOG");
    store.transition(holder.id, "READY");
    // plan points at file X, the stored proposal's evidence still claims Y
    store.setMetadata(holder.id, {
      plan: {
        plannedAt: Date.now(),
        primaryFile: "src/main/java/io/diakosys/HealthEvaluator.java",
        dependencies: [],
        unmetDependencies: [],
        unresolvedDependencies: [],
        conflictWith: [],
        decision: "ready",
        reason: "validated; moving to queue",
      },
      proposal: proposalPayload({
        ...makeProposal({ priority: 7 }),
        title: "Fix heap leak",
        evidence: [{ file: "src/main/java/io/diakosys/SystemCpuSampler.java", observation: "heap grows unboundedly" }],
      }),
    });

    const fresh = store.addTask({ title: "Trace heap growth in the sampler thread", priority: 0 });
    store.setMetadata(fresh.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 0 }),
        title: "Trace heap growth in the sampler thread",
        evidence: [{ file: "src/main/java/io/diakosys/SystemCpuSampler.java", observation: "heap grows unboundedly" }],
      }),
      discoveryRun: discoveryRunMeta,
    });
    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === fresh.id)?.decision, "backlog");
    assert.equal(store.getTask(fresh.id)?.status, "BACKLOG");
    const freshPlan = store.getTask(fresh.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.deepEqual(freshPlan?.conflictWith, [holder.id]);
    assert.equal(store.getTask(holder.id)?.status, "READY");
  } finally {
    settings.close();
  }
});

test("two BACKLOG holders never both become READY for the same file", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const deps = [
      store.addTask({ title: "Prepare warmup dependency", priority: 4 }),
      store.addTask({ title: "Prepare cooldown dependency", priority: 2 }),
    ];
    const workA = store.addTask({ title: "Add sampler warmup guard", priority: 6 });
    const workB = store.addTask({ title: "Add sampler cooldown guard", priority: 5 });
    for (const [task, depTitle] of [[workA, "Prepare warmup dependency"], [workB, "Prepare cooldown dependency"]] as const) {
      store.setMetadata(task.id, {
        proposal: proposalPayload({
          ...makeProposal({ priority: task.priority }),
          title: task.title,
          evidence: [{ file: "src/main/java/io/diakosys/SystemCpuSampler.java", observation: "sampler utilization unbounded" }],
          dependencies: [depTitle],
        }),
        discoveryRun: discoveryRunMeta,
      });
    }

    const first = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(first.find((r) => r.taskId === workA.id)?.decision, "backlog");
    assert.equal(first.find((r) => r.taskId === workB.id)?.decision, "backlog");
    assert.equal(store.getTask(workA.id)?.status, "BACKLOG");
    assert.equal(store.getTask(workB.id)?.status, "BACKLOG");

    // A's dep DONE → A promotes, B stays queued (A now holds the file)
    store.transition(deps[0]!.id, "BACKLOG");
    finishTask(store, deps[0]!.id);
    const second = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(second.find((r) => r.taskId === workA.id)?.decision, "ready");
    assert.equal(second.find((r) => r.taskId === workB.id)?.decision, "unchanged");
    assert.equal(store.getTask(workA.id)?.status, "READY");
    assert.equal(store.getTask(workB.id)?.status, "BACKLOG");

    // B's dep DONE → B still blocked while A holds the file in READY
    store.transition(deps[1]!.id, "BACKLOG");
    finishTask(store, deps[1]!.id);
    const third = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(third.find((r) => r.taskId === workB.id)?.decision, "unchanged");
    assert.match(third.find((r) => r.taskId === workB.id)?.reason ?? "", /primary file is active in another task/);
    assert.equal(store.getTask(workB.id)?.status, "BACKLOG");

    // only once A is DONE does B become READY
    finishTask(store, workA.id);
    const last = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(last.find((r) => r.taskId === workB.id)?.decision, "ready");
    assert.equal(store.getTask(workB.id)?.status, "READY");
  } finally {
    settings.close();
  }
});

// ---------------------------------------------------------------------------
// P2 — the conflict branch records dependencies instead of discarding them
// ---------------------------------------------------------------------------

test("a conflicted task records its dependencies and clears them in order", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const holder = store.addTask({ title: "Fix heap leak", priority: 7 });
    store.transition(holder.id, "BACKLOG");
    store.transition(holder.id, "READY");
    store.setMetadata(holder.id, {
      plan: {
        plannedAt: Date.now(),
        primaryFile: "src/main/java/io/diakosys/SystemCpuSampler.java",
        dependencies: [],
        unmetDependencies: [],
        unresolvedDependencies: [],
        conflictWith: [],
        decision: "ready",
        reason: "validated; moving to queue",
      },
    });
    const dep = store.addTask({ title: "Add system-CPU sampling", priority: 5 });
    const fresh = store.addTask({ title: "Trace heap growth in the sampler thread", priority: 0 });
    store.setMetadata(fresh.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 0 }),
        title: "Trace heap growth in the sampler thread",
        evidence: [{ file: "src/main/java/io/diakosys/SystemCpuSampler.java", observation: "heap grows unboundedly" }],
        dependencies: ["Add system-CPU sampling"],
      }),
      discoveryRun: discoveryRunMeta,
    });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === fresh.id)?.decision, "backlog");
    const freshPlan = store.getTask(fresh.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.deepEqual(freshPlan?.conflictWith, [holder.id]);
    assert.deepEqual(freshPlan?.dependencies, [dep.id]);
    assert.deepEqual(freshPlan?.unmetDependencies, ["Add system-CPU sampling"]);
    assert.deepEqual(freshPlan?.unresolvedDependencies, []);
    assert.equal(store.getTask(fresh.id)?.status, "BACKLOG");

    // holder finishes but the dependency is still open → still blocked
    finishTask(store, holder.id);
    const second = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(second.find((r) => r.taskId === fresh.id)?.decision, "unchanged");
    assert.equal(store.getTask(fresh.id)?.status, "BACKLOG");

    // dependency finishes → READY
    store.transition(dep.id, "BACKLOG");
    finishTask(store, dep.id);
    const third = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(third.find((r) => r.taskId === fresh.id)?.decision, "ready");
    assert.equal(store.getTask(fresh.id)?.status, "READY");
  } finally {
    settings.close();
  }
});

// ---------------------------------------------------------------------------
// P3 — exact title match outranks a higher-priority fuzzy match
// ---------------------------------------------------------------------------

test("dependency resolution prefers an exact title over a higher-priority fuzzy match", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const exact = store.addTask({ title: "Add system-CPU sampling", priority: 2 });
    const fuzzy = store.addTask({ title: "Add the system-CPU sampling", priority: 9 });
    assert.equal(titleSimilarity("Add system-CPU sampling", fuzzy.title) >= 0.7, true);

    const fresh = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });
    store.setMetadata(fresh.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 6 }),
        dependencies: ["Add system-CPU sampling"],
      }),
      discoveryRun: discoveryRunMeta,
    });
    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === fresh.id)?.decision, "backlog");
    const plan = store.getTask(fresh.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.deepEqual(plan?.dependencies, [exact.id]);
    assert.deepEqual(plan?.unmetDependencies, ["Add system-CPU sampling"]);
  } finally {
    settings.close();
  }
});

// ---------------------------------------------------------------------------
// P4 — dependency ids without task records count as resolved but surface
// ---------------------------------------------------------------------------

test("promotion surfaces dependency ids whose task records are missing", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });
    store.transition(task.id, "BACKLOG");
    store.setMetadata(task.id, {
      plan: {
        plannedAt: Date.now(),
        dependencies: ["task_missing_record"],
        unmetDependencies: ["Ghost dependency"],
        unresolvedDependencies: [],
        conflictWith: [],
        decision: "backlog",
        reason: "waiting for dependencies: Ghost dependency",
      },
    });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    const entry = reports.find((r) => r.taskId === task.id);
    assert.equal(entry?.decision, "ready");
    assert.equal(store.getTask(task.id)?.status, "READY");
    const plan = store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.equal(plan?.decision, "ready");
    assert.match(plan?.reason ?? "", /missing dependency records dropped: task_missing_record/);
    assert.deepEqual(plan?.unresolvedDependencies, ["task_missing_record"]);
    assert.deepEqual(entry?.unresolvedDependencies, ["task_missing_record"]);
  } finally {
    settings.close();
  }
});

test("a conflictWith id without a task record is treated as resolved", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 6 });
    store.transition(task.id, "BACKLOG");
    store.setMetadata(task.id, {
      plan: {
        plannedAt: Date.now(),
        dependencies: [],
        unmetDependencies: [],
        unresolvedDependencies: [],
        conflictWith: ["task_missing_record"],
        decision: "backlog",
        reason: "conflict: src/main/java/io/diakosys/HealthEvaluator.java is active in an unknown task",
      },
    });

    const reports = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(reports.find((r) => r.taskId === task.id)?.decision, "ready");
    assert.equal(store.getTask(task.id)?.status, "READY");
    assert.equal((store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined)?.decision, "ready");
  } finally {
    settings.close();
  }
});

// ---------------------------------------------------------------------------
// P5 — dependency cycles are detected and never promoted
// ---------------------------------------------------------------------------

test("a mutual dependency cycle is reported explicitly and never promotes", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const a = store.addTask({ title: "Fix evaluator first", priority: 6 });
    const b = store.addTask({ title: "Prepare sampler fix second", priority: 5 });
    store.setMetadata(a.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 6 }),
        title: a.title,
        dependencies: ["Prepare sampler fix second"],
      }),
      discoveryRun: discoveryRunMeta,
    });
    store.setMetadata(b.id, {
      proposal: proposalPayload({
        ...makeProposal({ priority: 5 }),
        title: b.title,
        dependencies: ["Fix evaluator first"],
      }),
      discoveryRun: discoveryRunMeta,
    });

    // run 1: both are queued as waiting for their (recorded) dependency
    const first = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(first.find((r) => r.taskId === a.id)?.decision, "backlog");
    assert.equal(first.find((r) => r.taskId === a.id)?.reason, "waiting for dependencies: Prepare sampler fix second");
    assert.equal(first.find((r) => r.taskId === b.id)?.decision, "backlog");
    assert.equal(first.find((r) => r.taskId === b.id)?.reason, "waiting for dependencies: Fix evaluator first");
    assert.equal(store.getTask(a.id)?.status, "BACKLOG");
    assert.equal(store.getTask(b.id)?.status, "BACKLOG");

    // run 2: the recorded chain reaches back → explicit cycle decision
    const second = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    const aEntry = second.find((r) => r.taskId === a.id);
    assert.equal(aEntry?.decision, "backlog");
    assert.equal(aEntry?.reason, "dependency cycle detected: Fix evaluator first → Prepare sampler fix second → Fix evaluator first");
    const bEntry = second.find((r) => r.taskId === b.id);
    assert.equal(bEntry?.reason, "dependency cycle detected: Prepare sampler fix second → Fix evaluator first → Prepare sampler fix second");
    const aPlan = store.getTask(a.id)?.executionMetadata["plan"] as PlanMeta | undefined;
    assert.equal(aPlan?.decision, "backlog");
    assert.match(aPlan?.reason ?? "", /^dependency cycle detected:/);
    assert.equal(store.getTask(a.id)?.status, "BACKLOG");
    assert.equal(store.getTask(b.id)?.status, "BACKLOG");

    // deterministic: identical output on later runs; never READY
    const third = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(third.find((r) => r.taskId === a.id)?.reason, aEntry?.reason);
    assert.equal(third.find((r) => r.taskId === b.id)?.reason, bEntry?.reason);
    assert.equal(store.getTask(a.id)?.status, "BACKLOG");
    assert.equal(store.getTask(b.id)?.status, "BACKLOG");
  } finally {
    settings.close();
  }
});

// ---------------------------------------------------------------------------
// P6 — duplicate-decided tasks are re-checked every plan run
// ---------------------------------------------------------------------------

test("a duplicate-decided task stays unchanged while its source stays active", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const source = store.addTask({ title: "Guard evaluator against NaN samples", priority: 10 });
    store.transition(source.id, "BACKLOG");
    store.transition(source.id, "READY");
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 0 });
    store.setMetadata(task.id, {
      proposal: proposalPayload(makeProposal({ priority: 0 })),
      discoveryRun: discoveryRunMeta,
    });

    assert.equal(planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db)).find((r) => r.taskId === task.id)?.decision, "duplicate");
    assert.equal((store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined)?.decision, "duplicate");

    const again = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    const entry = again.find((r) => r.taskId === task.id);
    assert.equal(entry?.decision, "unchanged");
    assert.match(entry?.reason ?? "", /Guard evaluator against NaN samples/);
    assert.equal(store.getTask(task.id)?.status, "DISCOVERED");
  } finally {
    settings.close();
  }
});

test("a duplicate-decided task is planned normally once the duplicate source is done", () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  try {
    const store = settings.store;
    const source = store.addTask({ title: "Guard evaluator against NaN samples", priority: 10 });
    store.transition(source.id, "BACKLOG");
    const task = store.addTask({ title: "Guard evaluator against NaN samples", priority: 0 });
    store.setMetadata(task.id, {
      proposal: proposalPayload(makeProposal({ priority: 0 })),
      discoveryRun: discoveryRunMeta,
    });

    assert.equal(planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db)).find((r) => r.taskId === task.id)?.decision, "duplicate");
    assert.equal(store.getTask(task.id)?.status, "DISCOVERED");

    finishTask(store, source.id);
    const again = planDiscoveredTasks(settings.db, dir, coordinatorAuth(settings.db));
    assert.equal(again.find((r) => r.taskId === task.id)?.decision, "ready");
    assert.equal(store.getTask(task.id)?.status, "READY");
    assert.equal((store.getTask(task.id)?.executionMetadata["plan"] as PlanMeta | undefined)?.decision, "ready");
  } finally {
    settings.close();
  }
});
