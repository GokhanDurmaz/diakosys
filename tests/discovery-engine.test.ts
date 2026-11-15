import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenCodeAdapter } from "../src/opencode.ts";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { CoordinatorDisownedError } from "../src/locks.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Proposal } from "../src/proposal.ts";
import { coordinatorAuth } from "./helpers.ts";
import {
  DISCOVERY_AREAS,
  DiscoveryEngine,
  DiscoveryRunStore,
  areaInstruction,
  collectEvidence,
  repoManifest,
  repoManifestStats,
  selectAreas,
  validateRequestedAreas,
} from "../src/discovery.ts";
import type { DiscoveryOptions, DiscoveryResult } from "../src/discovery.ts";

/** The analysed repository root: the orchestrator itself is the repo under inspection. */
const REPO_DIR = process.cwd();

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-dis-"));
  fs.mkdirSync(path.join(dir, "src/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthEvaluator.java"), "class HealthEvaluator {}");
  return dir;
}

const MODEL = "Qwen-Mimo/model";

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

function engine(dir: string, options: Partial<DiscoveryOptions> = {}): { adapter: MockOpenCodeAdapter; engine: DiscoveryEngine } {
  const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low")]));
  const discovery = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    promptTimeoutMs: 5000,
    // an engine must never persist into the real home cache dir
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-")),
    ...options,
  });
  return { adapter, engine: discovery };
}

test("selectAreas caps an explicit request", () => {
  assert.deepEqual(selectAreas(undefined, 2).map((a) => a.key), ["architecture", "reliability"]);
  assert.deepEqual(selectAreas(undefined, 1).map((a) => a.key), ["architecture"]);
  assert.deepEqual(selectAreas(undefined, 99).map((a) => a.key), DISCOVERY_AREAS.map((a) => a.key));
  assert.deepEqual(selectAreas(["architecture", "tests"], 1).map((a) => a.key), ["architecture"]);
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

test("engine writes only to an explicit cacheDir, never to the real home cache dir", async () => {
  const repoDir = tmpRepo();
  const homeCache = path.join(process.env.HOME ?? os.homedir(), "Cache", "diakosys-orchestrator", "discovery-runs", "runs.json");
  const before = fs.existsSync(homeCache) ? fs.readFileSync(homeCache, "utf8") : null;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  try {
    const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low")]));
    try {
      const result = await new DiscoveryEngine(adapter, {
        repoDir,
        model: MODEL,
        maxProposalsPerArea: 1,
        promptTimeoutMs: 5000,
        cacheDir,
        areas: ["reliability"],
      }).run();
      assert.equal(result.persisted, true);
      assert.equal(fs.existsSync(path.join(cacheDir, "discovery-runs", "runs.json")), true);
    } finally {
      await adapter.close();
    }
    assert.equal(fs.existsSync(homeCache) ? fs.readFileSync(homeCache, "utf8") : null, before, "a run must not overwrite the real home manifest");
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("selectAreas falls back to all areas for unknown entries instead of returning an empty list", () => {
  assert.deepEqual(selectAreas(["zzz"]).map((a) => a.key), DISCOVERY_AREAS.map((a) => a.key));
  assert.deepEqual(selectAreas(["zzz"], 2).map((a) => a.key), ["architecture", "reliability"]);
  assert.deepEqual(selectAreas(["zzz", "build"]).map((a) => a.key), DISCOVERY_AREAS.map((a) => a.key));
  assert.deepEqual(selectAreas(["architecture", "zzz"]).map((a) => a.key), DISCOVERY_AREAS.map((a) => a.key));
});

test("validateRequestedAreas throws for unknown areas and accepts known ones", () => {
  assert.equal(validateRequestedAreas(["architecture", "tests"]), undefined);
  assert.throws(() => validateRequestedAreas(["zzz"]));
  assert.throws(() => validateRequestedAreas(["zzz", "build"]));
});

test("collectEvidence reports per-area files and flags missing evidence files", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthSampler.java"), "class HealthSampler {}");
  const adapter = new MockOpenCodeAdapter(() =>
    JSON.stringify([
      proposal("Guard evaluator against NaN samples", 6, "low"),
      proposal("Shorten the unbounded history buffers", 5, "medium", "src/main/java/io/diakosys/HealthSampler.java"),
    ]),
  );
  try {
    const result = await new DiscoveryEngine(adapter, { repoDir: dir, model: MODEL, maxProposalsPerArea: 1, promptTimeoutMs: 5000, cacheDir, areas: ["reliability"] }).run();
    const report = collectEvidence(result, dir);
    assert.equal(report.areas.length, 1);
    assert.equal(report.areas[0]!.area, "reliability");
    assert.equal(report.areas[0]!.files, 1);
    assert.equal(report.areas[0]!.missing.length, 0);
    assert.equal(report.areas[0]!.ok, true);
    assert.equal(report.missingFiles.length, 0);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("extraction below the per-area cap is not distorted by junk items", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  // A bare single proposal whose evidence entries previously leaked into the
  // item list and flooded the cap+5 scan window, pushing the real proposal out.
  const adapter = new MockOpenCodeAdapter(() =>
    JSON.stringify({
      title: "Guard evaluator against non-finite samples",
      problem: "HealthEvaluator treats non-finite system CPU samples as OK because the guard only checks presence.",
      rationale: "Silent forgetting of corrupt samples hides real problems from the operator.",
      evidence: Array.from({ length: 6 }, (_, i) => ({
        file: "src/main/java/io/diakosys/HealthEvaluator.java",
        observation: `observed condition variant ${i} in evaluation path`,
      })),
      approach: "Mirror the process-CPU isFinite guard in the system path.",
      outcome: "Non-finite samples are skipped, not silently reported healthy.",
      priority: 6,
      complexity: "low",
      verification: ["./gradlew test --tests 'io.diakosys.domain.health.*'"],
    }),
  );
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 1,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability"],
    }).run();
    assert.equal(result.areas[0]!.proposals.length, 1);
    assert.equal(result.areas[0]!.proposals[0]!.title, "Guard evaluator against non-finite samples");
    // the evidence entries must not surface as junk rejections either
    assert.equal(result.areas[0]!.rejected.length, 0);
    assert.equal(result.proposals.length, 1);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("runArea reports a concise diagnostic when the reply contains no JSON at all", async () => {
  // A reply with neither parseable nor malformed JSON used to vanish as a
  // silent "ok (0 proposals, 0 rejected)" — the operator saw nothing at all.
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() =>
    "I inspected the repository and wrote my findings to a markdown file instead of answering with JSON.",
  );
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability"],
      dryRun: true,
    }).run();
    const area = result.areas[0]!;
    assert.equal(area.status, "ok", "the run itself still completes");
    assert.equal(area.proposals.length, 0);
    assert.equal(area.rejected.length, 1, "the no-JSON reply must surface as a rejection");
    assert.match(area.rejected[0]!.reason, /^no JSON in the model reply \(\d+ chars, finish=stop\)$/);
    // the rejection carries a bounded snippet of what the model actually said
    assert.match(area.rejected[0]!.raw, /wrote my findings to a markdown file/);
    assert.ok(area.rejected[0]!.raw.length <= 120, "the snippet stays bounded");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("runArea names finish=tool-calls for an empty-text reply (the model ended on a tool call)", async () => {
  // Observed live: a model whose tools were unconstrained ended its run with
  // finish=tool-calls and an empty text reply — the JSON deliverable never
  // existed. The diagnostic must say so instead of reporting silent success.
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  // MockOpenCodeAdapter maps a reply of "tool-calls" to finish=tool-calls.
  const adapter = new MockOpenCodeAdapter(() => "tool-calls");
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability"],
      dryRun: true,
    }).run();
    const area = result.areas[0]!;
    assert.equal(area.rejected.length, 1);
    assert.equal(area.rejected[0]!.reason, "no JSON in the model reply (10 chars, finish=tool-calls)");
    assert.equal(area.rejected[0]!.raw, "tool-calls");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a plausible truncated JSON reply surfaces a truncation diagnostic with the finish reason", async () => {
  // Live failure mode: the reply was cut off mid-array, the segmenter dropped
  // the unterminated segment silently, and the run looked like a clean
  // "ok (0 proposals, 0 rejected)". The cut deliverable must surface as a
  // rejection that names the finish reason.
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() => '[{"title": "cut off mid-array');
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability"],
      dryRun: true,
    }).run();
    const area = result.areas[0]!;
    assert.equal(area.status, "ok", "the run itself still completes");
    assert.equal(area.proposals.length, 0);
    assert.equal(area.rejected.length, 1, "the truncated reply must surface as exactly one rejection");
    assert.match(area.rejected[0]!.reason, /^possibly truncated JSON in the model reply \(\d+ chars, finish=stop\)$/);
    assert.match(area.rejected[0]!.raw, /"title": "cut off mid-array/);
    assert.ok(area.rejected[0]!.raw.length <= 160, "the snippet stays bounded");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("truncation is still detected when balanced junk segments accompany the cut deliverable", async () => {
  // Balanced prose brackets around a truncated array: the junk ([1], [from
  // docs]) must not mask the cut, and must not add rejections of its own.
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() => 'see step [1] and [from docs], then: [{"title": "cut');
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability"],
      dryRun: true,
    }).run();
    const area = result.areas[0]!;
    assert.equal(area.rejected.length, 1, "only the truncation is reported — junk brackets produce no noise");
    assert.match(area.rejected[0]!.reason, /^possibly truncated JSON in the model reply \(\d+ chars, finish=stop\)$/);
    assert.match(area.rejected[0]!.raw, /\{"title": "cut/);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("ordinary prose with unmatched brackets keeps the no-JSON diagnostic, not truncation", async () => {
  // Prose brackets ("see [note about {things and such") are not JSON: no
  // truncation diagnostic, no parse errors — the no-JSON rejection is the
  // honest report for such a reply.
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() => "see [note about {things and such");
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability"],
      dryRun: true,
    }).run();
    const area = result.areas[0]!;
    assert.equal(area.rejected.length, 1);
    assert.match(area.rejected[0]!.reason, /^no JSON in the model reply \(\d+ chars, finish=stop\)$/);
    assert.ok(!area.rejected[0]!.reason.includes("truncated"), "prose brackets must never report truncation");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a valid empty JSON array still reports ok with no rejections (not a no-JSON failure)", async () => {
  // The diagnostic must not misfire on the legitimate "nothing worth
  // proposing" reply: [] parses fine, so segments > 0 and no rejection.
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() => "[]");
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability"],
      dryRun: true,
    }).run();
    const area = result.areas[0]!;
    assert.equal(area.status, "ok");
    assert.equal(area.proposals.length, 0);
    assert.equal(area.rejected.length, 0, "an empty but valid JSON array is not a diagnostic");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("onAreaStart reports each area with a 1-based index and the total", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() => "[]");
  const seen: Array<{ area: string; index: number; total: number }> = [];
  try {
    await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["architecture", "reliability"],
      dryRun: true,
      onAreaStart: (area, index, total) => seen.push({ area, index, total }),
    }).run();
    assert.deepEqual(seen, [
      { area: "architecture", index: 1, total: 2 },
      { area: "reliability", index: 2, total: 2 },
    ]);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("collectEvidence flags an evidence file that does not exist in the repository", () => {
  const dir = tmpRepo();
  const result: DiscoveryResult = {
    areas: [
      {
        area: "reliability",
        status: "ok",
        proposals: [
          proposal("Guard evaluator against NaN samples", 6, "low", "src/main/java/io/diakosys/NoSuchFile.java"),
        ],
        rejected: [],
        evidence: [],
      },
    ],
    proposals: [],
    rejected: [],
    persisted: false,
    evidence: { areas: [], missingFiles: [] },
  };
  const report = collectEvidence(result, dir);
  assert.equal(report.areas[0]!.files, 1);
  assert.deepEqual(report.areas[0]!.missing, ["src/main/java/io/diakosys/NoSuchFile.java"]);
  assert.equal(report.areas[0]!.ok, false);
  assert.deepEqual(report.missingFiles, ["src/main/java/io/diakosys/NoSuchFile.java"]);
});

test("repoManifestStats counts walk entries, unique files and skips", () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, "src/main/resources"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/main/resources/application.properties"), "diakosys.discovery=true");
  const stats = repoManifestStats(dir);
  assert.equal(stats.total, 4);
  assert.equal(stats.included, 2);
  assert.equal(stats.skipped, 2);
  assert.equal(stats.dedupSkipped, 2);
  assert.equal(stats.capSkipped, 0);
  assert.equal(stats.walkSkipped, 0);
});

test("repoManifestStats reports the 220-entry file cap and the 4000-entry walk cap", () => {
  const dir = tmpRepo(); // seeds one file (HealthEvaluator.java)
  fs.mkdirSync(path.join(dir, "src/main/resources"), { recursive: true });
  // 221 unique files -> the file cap slices the manifest to exactly 220 lines,
  // so the one file below the cap is capSkipped (not dedupSkipped)
  for (let i = 0; i < 220; i++) fs.writeFileSync(path.join(dir, `src/main/java/io/diakosys/F${i}.java`), "class F {}");
  const capped = repoManifestStats(dir);
  assert.equal(capped.included, 220);
  assert.equal(capped.capSkipped, 1);
  assert.equal(capped.dedupSkipped, 221);
  assert.equal(capped.walkSkipped, 0);
  assert.equal(repoManifest(dir).trim().split("\n").length, 220);

  // 301 unique files -> 81 fall below the cap
  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(dir, `src/main/java/io/diakosys/G${i}.java`), "class G {}");
  const over = repoManifestStats(dir);
  assert.equal(over.included, 220);
  assert.equal(over.capSkipped, 81);
  assert.equal(over.dedupSkipped, 301);
  assert.equal(over.walkSkipped, 0);
  assert.equal(repoManifest(dir).trim().split("\n").length, 220);
});

test("repoManifestStats counts files dropped by the 4000-entry walk cap", () => {
  const dir = tmpRepo(); // seeds one file (HealthEvaluator.java)
  for (let i = 0; i < 9000; i++) fs.writeFileSync(path.join(dir, `src/main/java/io/diakosys/H${i}.java`), "class H {}");
  const stats = repoManifestStats(dir);
  // the walk cap truncates the walk itself: 9001 files are seen, 4000 enter
  // `entries`, and the rest are counted as walkSkipped (not capSkipped)
  assert.equal(stats.walkSkipped, 14002);
  assert.equal(stats.included, 220);
  assert.equal(stats.dedupSkipped, 0);
  assert.equal(repoManifest(dir).trim().split("\n").length, 220);
});

test("reliability discovery prompt is targeted: scoped manifest, tighter cap, smaller read budget", async () => {
  const dir = tmpRepo();
  // compiled output that must never reach the manifest after the bin/target
  // exclusion
  fs.mkdirSync(path.join(dir, "bin/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin/main/java/io/diakosys/HealthEvaluator.class"), "");
  // non-priority files that only fill space behind the src/main priority
  fs.mkdirSync(path.join(dir, "src/test/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/test/java/io/diakosys/HealthEvaluatorTest.java"), "class HealthEvaluatorTest {}");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/notes.md"), "notes");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() => "[]");
  try {
    await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability", "architecture"],
    }).run();
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(adapter.calls.length, 2);
  const reliability = adapter.calls.find((c) => c.title === "Discovery: reliability")?.description;
  const architecture = adapter.calls.find((c) => c.title === "Discovery: architecture")?.description;
  assert.ok(reliability !== undefined, "reliability prompt must be recorded");
  assert.ok(architecture !== undefined, "architecture prompt must be recorded");
  // the proposal schema and JSON-only reply contract must survive targeting
  assert.ok(reliability.includes("exactly these fields"), "the proposal schema line must stay");
  assert.ok(reliability.includes("ONLY the JSON array"), "the JSON-only reply rule must stay");
  // the per-area toolBudget override reaches the instruction: fewer read
  // rounds = fewer full model turns on a reasoning model
  assert.ok(reliability.includes("inspect at most 2 files"), "reliability toolBudget must show in the instruction");
  // the targeted manifest leads with the prioritized prefix and carries a
  // scope note so the model reasons from the focused listing
  assert.ok(reliability.includes("Manifest scope: for the reliability area"), "the scope note must be present");
  const reliabilityManifest = manifestLines(reliability);
  assert.ok(reliabilityManifest[0]!.startsWith("src/main/"), `manifest must lead with the prioritized prefix, got ${reliabilityManifest[0]}`);
  assert.ok(reliabilityManifest.some((line) => line.startsWith("src/main/")), "manifest keeps src/main sources");
  assert.ok(!reliabilityManifest.some((line) => line.includes(".class")), "compiled outputs stay out of the manifest");

  // a non-targeted area keeps the default budget, no scope note, and the
  // full default manifest (test/doc sources still fill behind src/main)
  assert.ok(architecture.includes("inspect at most 3 files"));
  assert.ok(!architecture.includes("Manifest scope:"));
  assert.ok(manifestLines(architecture).includes("src/test/java/io/diakosys/HealthEvaluatorTest.java"));
});

test("areaInstruction is exported, states the read-only tool budget, and describes the per-area manifest scope", () => {
  const area = DISCOVERY_AREAS.find((a) => a.key === "reliability")!;
  const prompt = areaInstruction(area, 3, repoManifest(REPO_DIR, 120, ["src/main/"]));
  assert.equal(typeof areaInstruction, "function");
  assert.ok(prompt.includes("READ-ONLY"), "the instruction must state the read-only tool budget");
  assert.ok(prompt.includes("inspect at most 2 files"), "the reliability area's tool budget must reach the instruction");
  assert.ok(prompt.includes("Manifest scope: for the reliability area"), "a targeted area must note its manifest scope");
  assert.ok(prompt.includes("src/main/"), "the scope note must name the prioritized prefix");
});

test("areaInstruction requires verification as a non-empty array of concrete command strings", () => {
  const area = DISCOVERY_AREAS.find((a) => a.key === "reliability")!;
  const prompt = areaInstruction(area, 3, repoManifest(REPO_DIR, 120, ["src/main/"]));
  // the schema block keeps the verification field with an example grounded in
  // this repository's real test command (package.json), not a foreign build tool
  assert.ok(prompt.includes('"verification": ["node --test tests/queue.test.ts"]'), "the schema must show verification as an array with this repo's real test command");
  // the requirement must be explicit: bare strings were observed live and are invalid
  assert.ok(prompt.includes('"verification" is REQUIRED'), "the requirement statement must be present");
  assert.ok(prompt.includes("non-empty JSON array of concrete"), "the array-of-commands contract must be stated");
  assert.ok(prompt.includes("never be a single string"), "the bare-string failure mode must be called out");
  assert.ok(prompt.includes("an empty array, or prose"), "empty array and prose must be called out");
  assert.ok(prompt.includes("validation rejects any proposal whose \"verification\""), "the rejection consequence must be stated");
});

test("areaInstruction's example object is valid JSON using this repository's real test command", () => {
  const area = DISCOVERY_AREAS.find((a) => a.key === "reliability")!;
  const prompt = areaInstruction(area, 3, repoManifest(REPO_DIR, 120, ["src/main/"]));
  // The example must be pasteable, syntactically valid JSON: the failed live
  // run's pseudo-JSON template (unquoted placeholders) taught the model a
  // shape it could not reproduce, producing malformed segments.
  const exampleLine = prompt.split("\n").find((l) => l.startsWith('{"title":'));
  assert.ok(exampleLine !== undefined, "the prompt must contain a JSON example object");
  const example = JSON.parse(exampleLine!) as Record<string, unknown>;
  assert.deepEqual(example["verification"], ["node --test tests/queue.test.ts"], "the verification example must be this repository's real test command from package.json");
  assert.ok(!prompt.includes("gradlew"), "the foreign gradle example must be gone");
  assert.ok(prompt.includes("node --test"), "the real test command must appear in the instruction");
});

test("areaInstruction forbids invented evidence paths and points at the manifest and SOURCE excerpts", () => {
  // The failed live run hallucinated tests/clock.test.ts by pattern-matching
  // the tests/*.test.ts naming convention against src/clock.ts — the prompt
  // must state that evidence paths come from the supplied manifest/excerpts.
  const area = DISCOVERY_AREAS.find((a) => a.key === "tests")!;
  const prompt = areaInstruction(area, 3, repoManifest(REPO_DIR));
  assert.ok(prompt.includes("must be a repository-relative path that appears in the manifest or in"), "the path-citation rule must be present");
  assert.ok(prompt.includes("never invent or extrapolate a path"), "inventing paths must be explicitly forbidden");
  assert.ok(prompt.includes("citing a file that does not exist"), "the hallucinated-path consequence must be stated");
});

test("reliability manifest cap (120) applies per area while other areas keep the engine cap", async () => {
  const dir = tmpRepo(); // seeds HealthEvaluator.java
  // 130 src/main files so both caps bite: reliability must slice at its
  // manifestLimit=120, architecture at the default 220
  for (let i = 0; i < 129; i++) fs.writeFileSync(path.join(dir, `src/main/java/io/diakosys/Generated${i}.java`), "class G {}");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() => "[]");
  try {
    await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 3,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability", "architecture"],
    }).run();
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(adapter.calls.length, 2);
  const reliabilityPrompt = adapter.calls.find((c) => c.title === "Discovery: reliability")!.description;
  const architecturePrompt = adapter.calls.find((c) => c.title === "Discovery: architecture")!.description;
  assert.equal(manifestLines(reliabilityPrompt).length, 120, "reliability must honour its manifestLimit override");
  assert.equal(manifestLines(architecturePrompt).length, 130, "architecture must keep the default cap");
});

/** Lines after the "Repository file manifest" header = the manifest itself. */
function manifestLines(prompt: string): string[] {
  const header = "Repository file manifest (paths relative to repo root):";
  const start = prompt.indexOf(header);
  assert.ok(start !== -1, "prompt must contain the manifest header");
  return prompt.slice(start + header.length).trim().split("\n");
}

test("DiscoveryRunStore.persist writes the run result to a manifest the caller can read back", async () => {
  const repoDir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const dbPath = path.join(cacheDir, "tasks.db");
  const settings = openDb(dbPath);
  const adapterForRun = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low")]));
  const engineForRun = new DiscoveryEngine(adapterForRun, { repoDir, model: MODEL, maxProposalsPerArea: 1, promptTimeoutMs: 5000, cacheDir, areas: ["reliability"] });
  try {
    const result = await engineForRun.run();
    assert.equal(result.persisted, true);

    const manifestPath = path.join(cacheDir, "discovery-runs", "runs.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(typeof manifest, "object");
    assert.ok(manifest.areas !== undefined);
    assert.ok(manifest.proposals !== undefined);
    assert.equal(manifest.proposals.length, 1);
    assert.equal(manifest.proposals[0]!.title, "Guard evaluator against NaN samples");
  } finally {
    settings.close();
    await adapterForRun.close();
  }
});

function openDb(dir: string): { dbPath: string; close(): void; db: DatabaseSync } {
  const dbPath = path.join(dir, "tasks.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  return { dbPath, close: () => closeDatabase(db), db };
}

test("collectEvidence isolates missing files per area instead of leaking them across areas", () => {
  const dir = tmpRepo();
  const result: DiscoveryResult = {
    areas: [
      {
        area: "reliability",
        status: "ok",
        proposals: [
          proposal("Guard evaluator against NaN samples", 6, "low", "src/main/java/io/diakosys/NoSuchFile.java"),
        ],
        rejected: [],
        evidence: [],
      },
      {
        area: "performance",
        status: "ok",
        proposals: [
          proposal("Shorten the unbounded history buffers", 5, "medium"),
        ],
        rejected: [],
        evidence: [],
      },
    ],
    proposals: [],
    rejected: [],
    persisted: false,
    evidence: { areas: [], missingFiles: [] },
  };
  const report = collectEvidence(result, dir);
  const reliability = report.areas.find((a) => a.area === "reliability");
  const performance = report.areas.find((a) => a.area === "performance");
  assert.ok(reliability !== undefined);
  assert.ok(performance !== undefined);
  assert.equal(reliability.ok, false);
  assert.deepEqual(reliability.missing, ["src/main/java/io/diakosys/NoSuchFile.java"]);
  // the performance area cites an existing file and must stay ok; reliability's
  // missing file must not leak into it
  assert.equal(performance.ok, true);
  assert.equal(performance.missing.length, 0);
  assert.equal(performance.files, 1);
  // deduplicated top-level missing list
  assert.deepEqual(report.missingFiles, ["src/main/java/io/diakosys/NoSuchFile.java"]);
});

test("dry run does not persist the run manifest", async () => {
  const repoDir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low")]));
  try {
    const engine = new DiscoveryEngine(adapter, {
      repoDir,
      model: MODEL,
      dryRun: true,
      maxProposalsPerArea: 1,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability"],
    });
    const result = await engine.run();
    assert.equal(result.proposals.length, 1);
    assert.equal(result.persisted, false);
    // a dry run must not touch persistent state (the CLI reports "nothing was
    // persisted"), so no manifest file may appear under cacheDir
    assert.equal(fs.existsSync(path.join(cacheDir, "discovery-runs", "runs.json")), false);
  } finally {
    await adapter.close();
  }
});

test("DiscoveryRunStore.fail marks a running run failed and complete cannot resurrect it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const settings = openDb(dir);
  try {
    const runs = new DiscoveryRunStore(settings.db);
    const id = runs.start([{ key: "reliability", focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing." }], MODEL, coordinatorAuth(settings.db));
    assert.equal(runs.statusOf(id), "running");
    runs.fail(id, "adapter exploded", coordinatorAuth(settings.db));
    assert.equal(runs.statusOf(id), "failed");
    assert.equal(runs.errorOf(id), "adapter exploded");
    // a terminal failed run is not resurrected by a late complete()
    runs.complete(id, { areasCompleted: 1, rawProposals: 0, accepted: 0, rejected: 0 }, coordinatorAuth(settings.db));
    assert.equal(runs.statusOf(id), "failed");
    assert.equal(runs.areaCountOf(id), 0);
  } finally {
    settings.close();
  }
});

const RUN_AREAS = [{ key: "tests", focus: "Missing or weak test coverage: untested public behavior, brittle tests, missing edge-case tests." }];

test("ordinary store opening never mutates discovery-run state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const first = openDb(dir);
  const runs = new DiscoveryRunStore(first.db);
  const auth = coordinatorAuth(first.db);
  const crashed = runs.start(RUN_AREAS, MODEL, auth);
  const done = runs.start(RUN_AREAS, MODEL, auth);
  runs.complete(done, { areasCompleted: 1, rawProposals: 2, accepted: 1, rejected: 1 }, auth);
  first.close();

  // an ordinary open constructs the store and reads: no recovery call, no
  // coordinator acquisition — discovery-run state comes back exactly as left
  const reopened = openDb(dir);
  try {
    const reopenedRuns = new DiscoveryRunStore(reopened.db);
    assert.equal(reopenedRuns.statusOf(crashed), "running");
    assert.equal(reopenedRuns.errorOf(crashed), null);
    assert.equal(reopenedRuns.statusOf(done), "completed");
    assert.deepEqual(reopenedRuns.runsByStatus(), { running: 1, completed: 1, failed: 0, interrupted: 0 });
  } finally {
    reopened.close();
  }
});

test("explicit coordinator-authorized recovery interrupts crashed runs (confirmed)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const settings = openDb(dir);
  try {
    const runs = new DiscoveryRunStore(settings.db);
    const auth = coordinatorAuth(settings.db);
    const crashed = runs.start(RUN_AREAS, MODEL, auth);

    const report = runs.recoverInterruptedRuns(auth, { confirmed: true });
    assert.equal(report.interrupted, 1);
    assert.deepEqual(report.pending, []);
    assert.equal(runs.statusOf(crashed), "interrupted");
    assert.equal(runs.errorOf(crashed), "process exited while run was active");
    const latest = runs.latestRun();
    assert.ok(latest !== undefined);
    assert.equal(latest.id, crashed);
    assert.equal(latest.status, "interrupted");
    assert.ok(/^disc_\w+/.test(latest.id));
    // idempotent: a second confirmed pass finds nothing left to interrupt
    const again = runs.recoverInterruptedRuns(auth, { confirmed: true });
    assert.equal(again.interrupted, 0);
    assert.deepEqual(again.pending, []);
    assert.equal(runs.statusOf(crashed), "interrupted");
  } finally {
    settings.close();
  }
});

test("disowned coordinator cannot recover discovery runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const settings = openDb(dir);
  try {
    const runs = new DiscoveryRunStore(settings.db);
    const auth = coordinatorAuth(settings.db);
    const crashed = runs.start(RUN_AREAS, MODEL, auth);
    assert.equal(runs.statusOf(crashed), "running");

    // wrong owner
    assert.throws(
      () => runs.recoverInterruptedRuns({ owner: "orchestrator-stranger", generation: auth.generation, lockTtlMs: auth.lockTtlMs }, { confirmed: true }),
      CoordinatorDisownedError,
    );
    // stale generation
    assert.throws(
      () => runs.recoverInterruptedRuns({ owner: auth.owner, generation: auth.generation + 1, lockTtlMs: auth.lockTtlMs }, { confirmed: true }),
      CoordinatorDisownedError,
    );
    // expired lock lease
    settings.db.prepare("UPDATE instance_locks SET expires_at = ? WHERE id = 1").run(Date.now() - 1_000);
    assert.throws(
      () => runs.recoverInterruptedRuns(auth, { confirmed: true }),
      CoordinatorDisownedError,
    );
    // every refused pass aborted atomically: the row is exactly as it was
    assert.equal(runs.statusOf(crashed), "running");
    assert.equal(runs.errorOf(crashed), null);
    assert.deepEqual(runs.runsByStatus(), { running: 1, completed: 0, failed: 0, interrupted: 0 });

    // the same authority with a fresh lease recovers — refusals poisoned nothing
    settings.db.prepare("UPDATE instance_locks SET expires_at = ? WHERE id = 1").run(Date.now() + 600_000);
    const report = runs.recoverInterruptedRuns(auth, { confirmed: true });
    assert.equal(report.interrupted, 1);
    assert.equal(runs.statusOf(crashed), "interrupted");
  } finally {
    settings.close();
  }
});

test("legacy running rows (no lease) need operator confirmation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const settings = openDb(dir);
  try {
    const runs = new DiscoveryRunStore(settings.db);
    const auth = coordinatorAuth(settings.db);
    const crashed = runs.start(RUN_AREAS, MODEL, auth);

    // an unconfirmed pass only reports: discovery-run rows carry no lease, so
    // nothing proves the run is dead — interrupting is the operator's call
    const planned = runs.recoverInterruptedRuns(auth);
    assert.equal(planned.interrupted, 0);
    assert.deepEqual(planned.pending.map((p) => p.id), [crashed]);
    for (const p of planned.pending) assert.match(p.cause, /confirm/i);
    assert.equal(runs.statusOf(crashed), "running");
    assert.equal(runs.errorOf(crashed), null);
    // repeated unconfirmed passes stay equally inert
    const again = runs.recoverInterruptedRuns(auth);
    assert.equal(again.interrupted, 0);
    assert.equal(again.pending.length, 1);
    assert.equal(runs.statusOf(crashed), "running");
    assert.deepEqual(runs.runsByStatus(), { running: 1, completed: 0, failed: 0, interrupted: 0 });
    // only the operator's confirmation flips it
    const confirmed = runs.recoverInterruptedRuns(auth, { confirmed: true });
    assert.equal(confirmed.interrupted, 1);
    assert.equal(confirmed.pending.length, 0);
    assert.equal(runs.statusOf(crashed), "interrupted");
  } finally {
    settings.close();
  }
});

test("close and reopen keeps run state; recovery stays explicit after reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const first = openDb(dir);
  const runs = new DiscoveryRunStore(first.db);
  const crashed = runs.start(RUN_AREAS, MODEL, coordinatorAuth(first.db));
  first.close(); // crash mid-run: the row stays 'running'

  const reopened = openDb(dir);
  let reopenedClosed = false;
  try {
    const reopenedRuns = new DiscoveryRunStore(reopened.db);
    // reopening recovered nothing; the unconfirmed pass only reports
    assert.equal(reopenedRuns.statusOf(crashed), "running");
    const planned = reopenedRuns.recoverInterruptedRuns(coordinatorAuth(reopened.db));
    assert.equal(planned.interrupted, 0);
    assert.deepEqual(planned.pending.map((p) => p.id), [crashed]);
    // the confirmed pass flips it
    assert.equal(reopenedRuns.recoverInterruptedRuns(coordinatorAuth(reopened.db), { confirmed: true }).interrupted, 1);
    assert.equal(reopenedRuns.statusOf(crashed), "interrupted");
    reopened.close();
    reopenedClosed = true;

    // second reopen: the interrupted state is durable
    const again = openDb(dir);
    try {
      const againRuns = new DiscoveryRunStore(again.db);
      assert.equal(againRuns.statusOf(crashed), "interrupted");
      assert.equal(againRuns.errorOf(crashed), "process exited while run was active");
    } finally {
      again.close();
    }
  } finally {
    if (!reopenedClosed) reopened.close();
  }
});

test("listRuns and latestRun reflect recorded run states in order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const settings = openDb(dir);
  try {
    const runs = new DiscoveryRunStore(settings.db);
    const first = runs.start([{ key: "reliability", focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing." }], MODEL, coordinatorAuth(settings.db));
    runs.complete(first, { areasCompleted: 1, rawProposals: 2, accepted: 1, rejected: 1 }, coordinatorAuth(settings.db));
    const second = runs.start([{ key: "tests", focus: "Missing or weak test coverage: untested public behavior, brittle tests, missing edge-case tests." }], MODEL, coordinatorAuth(settings.db));
    assert.equal(runs.countRuns(), 2);
    const all = runs.listRuns();
    assert.equal(all.length, 2);
    // finished runs order before unfinished ones (finished_at DESC NULLS LAST)
    assert.equal(all[0]!.id, first);
    assert.equal(all[0]!.status, "completed");
    assert.equal(all[0]!.accepted, 1);
    assert.equal(all[1]!.id, second);
    assert.equal(all[1]!.status, "running");
    assert.deepEqual(runs.runsByStatus(), { running: 1, completed: 1, failed: 0, interrupted: 0 });
    const latest = runs.latestRun();
    assert.ok(latest !== undefined);
    assert.equal(latest.id, first);
  } finally {
    settings.close();
  }
});

test("complete with an error records partial area failures under a completed status", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-runs-"));
  const settings = openDb(dir);
  try {
    const runs = new DiscoveryRunStore(settings.db);
    const id = runs.start([{ key: "reliability", focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing." }], MODEL, coordinatorAuth(settings.db));
    runs.complete(
      id,
      { areasCompleted: 0, rawProposals: 0, accepted: 0, rejected: 0 },
      coordinatorAuth(settings.db),
      "area failures: tests: prompt failed",
    );
    const record = runs.latestRun();
    assert.ok(record !== undefined);
    assert.equal(record.status, "completed");
    assert.equal(record.error, "area failures: tests: prompt failed");
  } finally {
    settings.close();
  }
});

test("title-similar proposals from different areas are deduped cross-area with first-seen wins", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthSampler.java"), "class HealthSampler {}");
  const adapter = new MockOpenCodeAdapter((input) => {
    if (input.title === "Discovery: reliability") {
      return JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low")]);
    }
    // different primary file than the kept proposal, so only the
    // title-similarity rule can fire
    return JSON.stringify([
      proposal("Guard the evaluator against NaN samples", 4, "medium", "src/main/java/io/diakosys/HealthSampler.java"),
    ]);
  });
  try {
    const engine = new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 1,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability", "performance"],
    });
    const result = await engine.run();
    assert.equal(result.proposals.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]!.area, "cross-area");
    assert.match(result.rejected[0]!.reason, /duplicate of an earlier proposal/);
    assert.equal(result.rejected[0]!.raw, "Guard the evaluator against NaN samples");
    // the first-seen (higher-priority) occurrence is kept
    assert.ok(result.proposals.some((p) => p.title === "Guard evaluator against NaN samples"));
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
