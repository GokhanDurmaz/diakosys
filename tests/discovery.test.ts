import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenCodeAdapter } from "../src/opencode.ts";
import { openDatabase, closeDatabase } from "../src/db.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Proposal } from "../src/proposal.ts";
import { coordinatorAuth } from "./helpers.ts";
import { DISCOVERY_AREAS, DISCOVERY_SERVER_CONFIG, DISCOVERY_TOOLS, DiscoveryEngine, DiscoveryRunStore, fileExistsInRepo, repoManifest, selectAreas } from "../src/discovery.ts";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-dis-"));
  fs.mkdirSync(path.join(dir, "src/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthEvaluator.java"), "class HealthEvaluator {}");
  return dir;
}

const MODEL = "Qwen-Mimo/model";

// Every engine in this file must persist to an isolated cache directory:
// engines run with the default cacheDir would write the real
// $HOME/Cache/diakosys-orchestrator manifest and race the home-cache protection
// test in tests/discovery-engine.test.ts across node --test parallel files.
const tmpCacheDirs: string[] = [];
function tmpCache(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-dis-cache-"));
  tmpCacheDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpCacheDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function proposal(title: string, priority: number, complexity: "low" | "medium" | "high", file: string = "src/main/java/io/diakosys/HealthEvaluator.java"): Proposal {
  return {
    title,
    problem: `Problem for ${title}: a concrete, reproducible statement.`,
    rationale: "Evidence-based remediation.",
    evidence: [{ file, symbol: "evaluate", observation: "observed condition here" }],
    approach: "Implement the smallest safe change.",
    outcome: "Behaviour is fixed and covered by tests.",
    priority,
    complexity,
    verification: ["./gradlew test"],
  };
}

test("engine collects proposals from all listed areas", async () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthSampler.java"), "class HealthSampler {}");
  const adapter = new MockOpenCodeAdapter((input) => {
    if (input.title === "Discovery: reliability") {
      return JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low")]);
    }
    return JSON.stringify([proposal("Shorten the unbounded history buffers", 5, "medium", "src/main/java/io/diakosys/HealthSampler.java")]);
  });
  try {
    const engine = new DiscoveryEngine(adapter, { repoDir: dir, model: MODEL, maxProposalsPerArea: 1, cacheDir: tmpCache(), areas: ["reliability", "performance"] });
    const result = await engine.run();
    assert.equal(result.areas.length, 2);
    assert.equal(result.areas[0]!.area, "reliability");
    assert.equal(result.areas[1]!.area, "performance");
    assert.equal(result.areas[0]!.status, "ok");
    assert.equal(result.areas[0]!.proposals.length, 1);
    assert.equal(result.areas[0]!.proposals[0]!.title, "Guard evaluator against NaN samples");
    assert.equal(result.proposals.length, 2);
    assert.equal(result.rejected.length, 0);
  } finally {
    await adapter.close();
  }
});

test("engine reports malformed proposal segments instead of failing", async () => {
  const dir = tmpRepo();
  const adapter = new MockOpenCodeAdapter(() => [
    JSON.stringify({ note: "the analysis reply was not a json array of proposals" }),
    JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low")]),
  ].join("\n"));
  try {
    const engine = new DiscoveryEngine(adapter, { repoDir: dir, model: MODEL, maxProposalsPerArea: 1, cacheDir: tmpCache(), areas: ["reliability"] });
    const result = await engine.run();
    assert.equal(result.areas[0]!.status, "ok");
    assert.equal(result.areas[0]!.proposals.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.raw, /not a json array/);
    assert.match(result.rejected[0]!.reason, /malformed|not a json array/);
  } finally {
    await adapter.close();
  }
});

test("engine marks the area with an error when the model fails", async () => {
  const dir = tmpRepo();
  const adapter = new MockOpenCodeAdapter((i) => {
    throw new Error("model exploded");
  });
  try {
    const engine = new DiscoveryEngine(adapter, { repoDir: dir, model: MODEL, maxProposalsPerArea: 2, cacheDir: tmpCache(), areas: ["reliability"] });
    const result = await engine.run();
    assert.equal(result.areas[0]!.status, "error");
    assert.match(result.areas[0]!.error ?? "", /model exploded/);
  } finally {
    await adapter.close();
  }
});

test("engine rejects cross-area duplicates and per-area proposal limits", async () => {
  const dir = tmpRepo();
  const adapter = new MockOpenCodeAdapter((i) => JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low"), proposal("Fix flaky health checks", 3, "medium")]));
  try {
    const engine = new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      areas: ["reliability", "performance"],
      maxProposalsPerArea: 1,
      cacheDir: tmpCache(),
    });
    const result = await engine.run();
    assert.equal(result.areas[0]!.proposals.length, 1);
    assert.equal(result.areas[1]!.proposals.length, 1);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]!.area, "cross-area");
  } finally {
    await adapter.close();
  }
});

test("engine skips a repository without a discoverable manifest", async () => {
  const dir = tmpRepo();
  fs.rmSync(path.join(dir, "src/main/java/io/diakosys/HealthEvaluator.java"));
  const adapter = new MockOpenCodeAdapter((i) => "no findings");
  try {
    const engine = new DiscoveryEngine(adapter, { repoDir: dir, model: MODEL, maxProposalsPerArea: 2, cacheDir: tmpCache(), areas: ["reliability"] });
    const result = await engine.run();
    assert.equal(result.areas[0]!.proposals.length, 0);
  } finally {
    await adapter.close();
  }
});

test("selectAreas accepts comma-separated and single areas", () => {
  assert.deepEqual(selectAreas(undefined), DISCOVERY_AREAS);
  assert.deepEqual(selectAreas(["reliability"]), DISCOVERY_AREAS.filter((a) => a.key === "reliability"));
  assert.deepEqual(selectAreas(["reliability", "performance"]), DISCOVERY_AREAS.filter((a) => a.key === "reliability" || a.key === "performance"));
  assert.equal(selectAreas(["reliability", "performance"]).length, 2);
});

test("selectAreas caps an explicit area request", () => {
  assert.deepEqual(selectAreas(["reliability", "performance", "quality"], 1).map((a) => a.key), ["reliability"]);
  assert.equal(selectAreas(["architecture", "tests"], 1).length, 1);
});

test("selectAreas honours maxAreas=0 with the Math.max(1, ...) floor (never zero areas)", () => {
  assert.equal(selectAreas(undefined, 0).length, 1);
  assert.deepEqual(selectAreas(undefined, 0).map((a) => a.key), ["architecture"]);
  assert.equal(selectAreas(["architecture"], 0).length, 1);
});

test("selectAreas treats empty-string entries like unknown entries (fallback to all areas)", () => {
  assert.deepEqual(selectAreas([""]).map((a) => a.key), DISCOVERY_AREAS.map((a) => a.key));
  assert.deepEqual(selectAreas(["", "reliability"]).map((a) => a.key), ["reliability"]);
  assert.deepEqual(selectAreas(["", "zzz"], 2).map((a) => a.key), ["architecture", "reliability"]);
  assert.deepEqual(selectAreas(["reliability", ""]).map((a) => a.key), ["reliability"]);
});

test("fileExistsInRepo rejects a repository symlink that escapes the repo", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-repo-symlink-"));
  fs.mkdirSync(path.join(repo, "src/main/java/io/diakosys"), { recursive: true });
  const inside = path.join(repo, "src/main/java/io/diakosys/HealthEvaluator.java");
  fs.writeFileSync(inside, "class HealthEvaluator {}");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-symlink-outside-"));
  fs.writeFileSync(path.join(outside, "Secret.java"), "class Secret {}");
  const link = path.join(repo, "src/main/java/io/diakosys/Link.java");
  fs.symlinkSync(path.join(outside, "Secret.java"), link);
  try {
    assert.equal(fileExistsInRepo(repo, "src/main/java/io/diakosys/HealthEvaluator.java"), true);
    assert.equal(fileExistsInRepo(repo, "src/main/java/io/diakosys/Link.java"), false, "a repo symlink pointing outside must not pass");
    assert.equal(fileExistsInRepo(repo, "src/main/java/io/diakosys/Missing.java"), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("repoManifest lists source files sorted with the main entry first", () => {
  const dir = tmpRepo();

  const manifest = repoManifest(dir);
    assert.equal(manifest.trim().split("\n").length, 1);
  assert.equal(manifest.trim().split("\n")[0], "src/main/java/io/diakosys/HealthEvaluator.java");

  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthEvaluator.java"), "class HealthEvaluator {}");
  fs.mkdirSync(path.join(dir, "src/test/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/test/java/io/diakosys/HealthEvaluatorTest.java"), "class HealthEvaluatorTest {}");
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/Other.java"), "class Other {}");
  const again = repoManifest(dir);
  assert.deepEqual(again.split("\n"), [
    "src/main/java/io/diakosys/HealthEvaluator.java",
    "src/main/java/io/diakosys/Other.java",
    "src/test/java/io/diakosys/HealthEvaluatorTest.java",
  ]);
});

test("repoManifest skips build outputs, bin/target artifacts and node_modules", () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, "build/classes/java/main"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build/classes/java/main/HealthEvaluator.class"), "");
  // Eclipse's `bin` and Maven/Gradle `target` output trees: on the diakosys repo
  // these were 143 of 220 manifest entries, crowding real sources out of the
  // cap, so they must never enter the manifest.
  fs.mkdirSync(path.join(dir, "bin/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin/main/java/io/diakosys/HealthEvaluator.class"), "");
  fs.mkdirSync(path.join(dir, "bin/test/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin/test/java/io/diakosys/HealthEvaluatorTest.class"), "");
  fs.mkdirSync(path.join(dir, "target/classes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "target/classes/HealthEvaluator.class"), "");
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules/.package-lock.json"), "{}");
  fs.mkdirSync(path.join(dir, "build/resources/main"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build/resources/main/x.txt"), "x");
  const manifest = repoManifest(dir);
  assert.equal(manifest, "src/main/java/io/diakosys/HealthEvaluator.java");
});

test("repoManifest ranks priority prefixes ahead of the default src/main-first order", () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, "src/test/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/test/java/io/diakosys/HealthEvaluatorTest.java"), "class HealthEvaluatorTest {}");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/notes.md"), "notes");

  // default order (no priority): src/main first, then the generic sort
  assert.deepEqual(repoManifest(dir).split("\n"), [
    "src/main/java/io/diakosys/HealthEvaluator.java",
    "docs/notes.md",
    "src/test/java/io/diakosys/HealthEvaluatorTest.java",
  ]);

  // a priority prefix overrides that default: matching files lead even when
  // the generic order would put them last
  assert.deepEqual(repoManifest(dir, 220, ["src/test/"]).split("\n"), [
    "src/test/java/io/diakosys/HealthEvaluatorTest.java",
    "src/main/java/io/diakosys/HealthEvaluator.java",
    "docs/notes.md",
  ]);

  // priority also shields matching files from the cap: with a single slot the
  // prioritized file survives and the unmatched files are cut
  assert.equal(repoManifest(dir, 1, ["src/test/"]), "src/test/java/io/diakosys/HealthEvaluatorTest.java");
});

test("discovery tool contract: only read is enabled on both the v1 and v2 surfaces", () => {
  // v1 per-prompt tool config: exactly one enabled tool, so a reasoning model
  // cannot burn rounds on search/skill calls next to a targeted manifest.
  const enabled = Object.entries(DISCOVERY_TOOLS).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(enabled, ["read"]);
  // v2 spawn-config permissions: wildcard allow (read works, verified in live
  // probes) with every acting, network, agent-spawning, round-burning and
  // searching tool explicitly denied.
  const permission = DISCOVERY_SERVER_CONFIG.permission as Record<string, string>;
  assert.equal(permission["*"], "allow");
  for (const tool of [
    "shell",
    "bash",
    "edit",
    "write",
    "webfetch",
    "websearch",
    "task",
    "question",
    "execute",
    "skill",
    "grep",
    "glob",
  ]) {
    assert.equal(permission[tool], "deny", `permission.${tool} must be denied for discovery`);
  }
  assert.equal(permission.read, undefined, "read must stay allowed by the wildcard");
});

test("discovery runs are persisted and recoverable after a crash", async () => {
  const dir = tmpRepo();
  const settings = openDb(dir);
  const runs = new DiscoveryRunStore(settings.db);
  const id = runs.start([{ key: "reliability", focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing." }], MODEL, coordinatorAuth(settings.db));
  runs.complete(id, { areasCompleted: 1, rawProposals: 0, accepted: 0, rejected: 0 }, coordinatorAuth(settings.db));
  settings.close();

  const reopened = openDb(dir);
  try {
    const recovered = new DiscoveryRunStore(reopened.db);
    assert.equal(recovered.statusOf(id), "completed");
    assert.equal(recovered.areaCountOf(id), 1);
    assert.equal(recovered.errorOf(id), null);
  } finally {
    reopened.close();
  }
});

test("listRuns returns camelCase DiscoveryRunRecord fields (not the snake_case columns)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const settings = openDb(dir);
  try {
    const runs = new DiscoveryRunStore(settings.db);
    const id = runs.start([{ key: "reliability", focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing." }], MODEL, coordinatorAuth(settings.db));
    runs.complete(id, { areasCompleted: 1, rawProposals: 2, accepted: 1, rejected: 1 }, coordinatorAuth(settings.db));
    const record = runs.listRuns()[0] as unknown as Record<string, unknown>;
    // snake_case columns are aliased in SQL, so the camelCase interface fields
    // must be populated — a raw cast would leave them undefined.
    // snake_case columns are aliased in SQL, so the camelCase interface fields
    // are populated — a raw cast would leave them undefined
    assert.equal(typeof record.startedAt, "number");
    assert.equal(typeof record.finishedAt, "number");
    assert.equal(record.areasTotal, 1);
    assert.equal(record.areasCompleted, 1);
    assert.equal(record.rawProposals, 2);
    assert.equal(record.accepted, 1);
    assert.equal(record.rejected, 1);
    assert.equal(record.error, null);
    assert.equal(record.model, MODEL);
    assert.equal(record["started_at"], undefined, "the raw snake_case column names are replaced by the alias");
  } finally {
    settings.close();
  }
});

test("a fresh DiscoveryRunStore over an empty database answers without throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-empty-"));
  const settings = openDb(dir);
  try {
    const runs = new DiscoveryRunStore(settings.db);
    assert.deepEqual(runs.listRuns(), []);
    assert.equal(runs.latestRun(), undefined);
    assert.deepEqual(runs.runsByStatus(), { running: 0, completed: 0, failed: 0, interrupted: 0 });
    assert.equal(runs.countRuns(), 0);
    // absence of a row is reported as "interrupted" / 0 / null, never thrown
    assert.equal(runs.statusOf("no-such-run"), "interrupted");
    assert.equal(runs.areaCountOf("no-such-run"), 0);
    assert.equal(runs.errorOf("no-such-run"), null);
  } finally {
    settings.close();
  }
});

test("engine never creates, modifies or deletes tasks", async () => {
  const dir = tmpRepo();
  const adapter = new MockOpenCodeAdapter((i) => "mock");
  try {
    const engine = new DiscoveryEngine(adapter, { repoDir: dir, model: MODEL, maxProposalsPerArea: 2, cacheDir: tmpCache(), areas: ["reliability"] });
    const result = await engine.run();
    assert.equal(result.proposals.length, 0);
  } finally {
    await adapter.close();
  }
});

function openDb(dir: string): { dbPath: string; close(): void; db: DatabaseSync } {
  const dbPath = path.join(dir, "tasks.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  return { dbPath, close: () => closeDatabase(db), db };
}
