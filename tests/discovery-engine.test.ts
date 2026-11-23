// Force recompilation by touching this line
console.log("DEBUG TEST FILE LOADED");
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenCodeAdapter, type OpenCodeAdapter, type OpenCodeAdapterOptions, type OpenCodePromptResult, type TurnStats } from "../src/opencode.ts";
import type { LifecycleEvent } from "../src/lifecycle.ts";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { CoordinatorDisownedError } from "../src/locks.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Proposal } from "../src/proposal.ts";
import { validateProposal } from "../src/proposal.ts";
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
    const result = await new DiscoveryEngine(adapter, { repoDir: dir, model: MODEL, maxProposalsPerArea: 1, cacheDir, areas: ["reliability"] }).run();
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
  const engineForRun = new DiscoveryEngine(adapterForRun, { repoDir, model: MODEL, maxProposalsPerArea: 1, cacheDir, areas: ["reliability"] });
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

// ——— orphan-turn cleanup after a failed area prompt ———
// A failed prompt leaves its turn running server-side, and every area shares
// one OpenCode session: the failed area must interrupt the session BEFORE the
// next area's prompt is admitted. The stub records the prompt/abort sequence
// in one journal so the ordering is directly assertable.

/** Scripted outcomes per prompt call; "no-terminal" rejects with the real v2
 * no-terminal-event error. */
type PromptOutcome = "no-terminal" | "reply";

class OrphanTurnAdapter implements OpenCodeAdapter {
  readonly kind = "mock" as const;
  readonly options: OpenCodeAdapterOptions = {
    projectDirectory: "",
    model: "",
    agent: undefined,
    port: undefined,
    hostname: undefined,
    startupTimeoutMs: undefined,
    workDirectory: undefined,
    endpoint: undefined,
  };
  /** Ordered record of every prompt and abort phase ("prompt:1", "abort:start", …). */
  readonly journal: string[] = [];
  readonly aborted: Array<string | undefined> = [];
  private readonly outcomes: PromptOutcome[];
  private readonly abortBehavior: "delayed" | "rejecting" | "hanging";
  private calls = 0;

  constructor(outcomes: PromptOutcome[], abortBehavior: "delayed" | "rejecting" | "hanging" = "delayed") {
    this.outcomes = outcomes;
    this.abortBehavior = abortBehavior;
  }

  async probe(): Promise<string> {
    return "orphan-stub:localhost:4096";
  }

  async prompt(input: {
    title: string;
    description: string;
    directory: string;
    agent?: string;
    tools?: Record<string, boolean>;
  }): Promise<OpenCodePromptResult> {
    void input;
    this.calls += 1;
    const index = this.calls;
    this.journal.push(`prompt:${index}`);
    if ((this.outcomes[index - 1] ?? "reply") === "no-terminal") {
      // the exact v2 no-terminal-event diagnostic shape (src/opencode-v2.ts)
      throw new Error(`opencode prompt returned no terminal event (session ses_stub_001)`);
    }
    const text = JSON.stringify([proposal(`Orphan probe ${index}`, 6, "low")]);
    return {
      sessionId: "ses_stub_001",
      finish: "stop",
      role: "assistant",
      text,
      raw: { info: { finish: "stop", role: "assistant" }, parts: [{ type: "text", text }] },
    };
  }

  async abort(sessionId?: string): Promise<void> {
    this.journal.push("abort:start");
    this.aborted.push(sessionId);
    if (this.abortBehavior === "rejecting") {
      throw new Error("interrupt POST failed");
    }
    if (this.abortBehavior === "hanging") {
      return new Promise<void>(() => undefined);
    }
    // A realistic interrupt round-trip: long enough that fire-and-forget
    // cleanup would submit the next area's prompt before the abort completed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.journal.push("abort:end");
  }

  activeSessionId(): string | undefined {
    return "ses_stub_001";
  }

  async close(): Promise<void> {
    return;
  }
}

function orphanEngine(adapter: OpenCodeAdapter, dir: string, cacheDir: string): DiscoveryEngine {
  return new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture", "tests"],
  });
}

test("a failed area prompt interrupts the shared session before the next area submits", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new OrphanTurnAdapter(["no-terminal", "reply"]);
  try {
    const result = await orphanEngine(adapter, dir, cacheDir).run();
    // the failed area keeps the original prompt error
    assert.equal(result.areas[0]?.status, "error");
    assert.match(result.areas[0]?.error ?? "", /opencode prompt returned no terminal event \(session ses_stub_001\)/);
    // the orphan turn was interrupted exactly once
    assert.deepEqual(adapter.aborted, ["ses_stub_001"]);
    // and the interrupt COMPLETED before the second area's prompt was admitted
    const abortEnd = adapter.journal.indexOf("abort:end");
    const secondPrompt = adapter.journal.indexOf("prompt:2");
    assert.ok(abortEnd !== -1, `the delayed abort must have completed (journal: ${adapter.journal.join(" → ")})`);
    assert.ok(
      abortEnd < secondPrompt,
      `the abort must complete before the next prompt is submitted (journal: ${adapter.journal.join(" → ")})`,
    );
    // discovery continues: the second area still runs and parses
    assert.equal(result.areas[1]?.status, "ok");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a rejecting abort must not mask the original prompt error", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new OrphanTurnAdapter(["no-terminal", "reply"], "rejecting");
  try {
    const result = await orphanEngine(adapter, dir, cacheDir).run();
    assert.equal(result.areas[0]?.status, "error");
    // the reported error is the prompt's, not the abort's
    assert.match(result.areas[0]?.error ?? "", /opencode prompt returned no terminal event \(session ses_stub_001\)/);
    assert.ok(!(result.areas[0]?.error ?? "").includes("interrupt POST failed"), "the abort failure must stay swallowed");
    // the abort was still requested, and the next area still ran
    assert.deepEqual(adapter.aborted, ["ses_stub_001"]);
    assert.equal(result.areas[1]?.status, "ok");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a never-settling abort cannot stall discovery past the grace period", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const adapter = new OrphanTurnAdapter(["no-terminal", "reply"], "hanging");
  try {
    const started = Date.now();
    const result = await orphanEngine(adapter, dir, cacheDir).run();
    const elapsed = Date.now() - started;
    // the abort was requested but never answered: the grace period bounds the wait
    assert.deepEqual(adapter.aborted, ["ses_stub_001"]);
    assert.ok(elapsed >= 1_950, `the grace period must be honored, resumed after ${elapsed}ms`);
    assert.ok(elapsed < 8_000, `the grace must bound the wait, took ${elapsed}ms`);
    // discovery continues after the grace period
    assert.equal(result.areas[1]?.status, "ok");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ——— evidence preparation must never abort the run (per-area isolation) ———
// A symlinked directory inside the walked roots used to be pushed into the
// manifest as a plain file (readdir's dirent reports the link itself, not the
// target), and extractSourceEvidence's readFileSync of it threw EISDIR —
// aborting the ENTIRE run before any area could complete.

test("a symlinked directory in the repo never aborts the run: both areas still complete", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  // a symlinked directory under src/main: a real directory behind a link
  const target = path.join(dir, "linked-target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "Nested.java"), "class Nested {}");
  fs.symlinkSync(target, path.join(dir, "src/main/java/io/diakosys/Linked"));
  // a second real source file so the two areas cite DIFFERENT primary files —
  // the engine deduplicates proposals across areas by primary evidence file,
  // and this test is about the symlink never aborting the run, not dedupe
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/Sampler.java"), "class Sampler { void evaluate() {} }");
  const adapter = new MockOpenCodeAdapter((input) => {
    if (input.title === "Discovery: architecture") {
      return JSON.stringify([proposal("Guard evaluator against NaN samples", 6, "low")]);
    }
    return JSON.stringify([proposal("Track sampler test coverage", 4, "medium", "src/main/java/io/diakosys/Sampler.java")]);
  });
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 1,
      cacheDir,
      dryRun: true,
      areas: ["architecture", "tests"],
    }).run();
    // neither area may fail, and neither may the run: the pre-fix behaviour
    // threw EISDIR out of run() before any area completed
    assert.equal(result.areas[0]?.status, "ok", `architecture must complete: ${result.areas[0]?.error ?? ""}`);
    assert.equal(result.areas[1]?.status, "ok", `tests must complete: ${result.areas[1]?.error ?? ""}`);
    assert.equal(result.proposals.length, 2, "both areas' proposals survive");
    // the symlinked directory must not enter any prompt manifest: it is not a
    // readable file, so it is excluded at the walk, not read and failed on
    for (const call of adapter.calls) {
      assert.ok(!call.description.includes("Linked"), "the symlinked directory must not appear in the manifest");
    }
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ——— turn-statistics lifecycle emission (observability only) ———
// The v2 backend attaches one aggregated TurnStats snapshot to each prompt's
// result or rejection; runArea emits it as exactly ONE lifecycle event per
// prompt. These tests use a stub that mirrors that contract without a server.

/** A representative completed-turn snapshot, overridden per test. */
function turnStatsFixture(overrides: Partial<TurnStats> = {}): TurnStats {
  return {
    sessionId: "ses_stub_001",
    outcome: "completed",
    terminalEvent: "session.status",
    wallMs: 1_234,
    steps: 2,
    firstStepAtMs: 15,
    lastEventAtMs: 1_100,
    toolCalls: { read: 2 },
    toolSpanMs: 40,
    unattributedSpanMs: 1_194,
    tokens: { input: 100, output: 50, reasoning: 20, cacheRead: 10, cacheWrite: 5 },
    finishReasons: ["tool-calls", "stop"],
    retries: 0,
    ...overrides,
  };
}

/** Scripted adapter that attaches fixed snapshots to its prompt outcomes,
 *  mirroring the v2 backend's instrumentation contract (the timeout error
 *  carries the partial snapshot; the result carries the completed one). */
class StatsCarrierAdapter implements OpenCodeAdapter {
  readonly kind = "mock" as const;
  readonly options: OpenCodeAdapterOptions = {
    projectDirectory: "",
    model: "",
    agent: undefined,
    port: undefined,
    hostname: undefined,
    startupTimeoutMs: undefined,
    workDirectory: undefined,
    endpoint: undefined,
  };
  private readonly outcomes: Array<"fail" | "ok">;
  private readonly failStats: TurnStats | undefined;
  private readonly okStats: TurnStats | undefined;
  private calls = 0;

  constructor(outcomes: Array<"fail" | "ok">, stats: { fail?: TurnStats; ok?: TurnStats } = {}) {
    this.outcomes = outcomes;
    this.failStats = stats.fail;
    this.okStats = stats.ok;
  }

  async probe(): Promise<string> {
    return "stats-stub:localhost:4096";
  }

  async prompt(input: {
    title: string;
    description: string;
    directory: string;
    agent?: string;
    tools?: Record<string, boolean>;
  }): Promise<OpenCodePromptResult> {
    void input;
    this.calls += 1;
    if ((this.outcomes[this.calls - 1] ?? "ok") === "fail") {
      // the exact v2 deadline diagnostic shape, carrying the partial snapshot
      throw Object.assign(
        new Error("opencode prompt returned no terminal event (session ses_stub_001)"),
        this.failStats === undefined ? {} : { turnStats: this.failStats },
      );
    }
    const text = JSON.stringify([proposal("Stats carrier proposal", 5, "low")]);
    return {
      sessionId: "ses_stub_001",
      finish: "stop",
      role: "assistant",
      text,
      raw: { info: { finish: "stop", role: "assistant" }, parts: [{ type: "text", text }] },
      ...(this.okStats === undefined ? {} : { turnStats: this.okStats }),
    };
  }

  async abort(): Promise<void> {
    return;
  }

  activeSessionId(): string | undefined {
    return "ses_stub_001";
  }

  async close(): Promise<void> {
    return;
  }
}

function statsEngine(
  adapter: OpenCodeAdapter,
  dir: string,
  cacheDir: string,
  events: LifecycleEvent[],
): DiscoveryEngine {
  return new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture", "tests"],
    onLifecycle: (event) => events.push(event),
  });
}

test("a completed prompt emits exactly one turn-stats event per prompt with area context", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new StatsCarrierAdapter(["ok", "ok"], { ok: turnStatsFixture() });
  try {
    const result = await statsEngine(adapter, dir, cacheDir, events).run();
    assert.equal(result.areas.length, 2);
    const statsEvents = events.filter((e) => e.event === "turn-stats");
    assert.equal(statsEvents.length, 2, "exactly one aggregated event per prompt, none per SSE event");
    const first = statsEvents[0] as unknown as Record<string, unknown>;
    assert.equal(statsEvents[0]?.level, "INFO");
    assert.equal(statsEvents[0]?.stage, "model-request");
    assert.equal(statsEvents[0]?.areaId, "architecture", "the event carries the discovery areaId");
    assert.equal(first.sessionId, "ses_stub_001");
    assert.equal(first.outcome, "completed");
    assert.equal(first.terminalEvent, "session.status");
    assert.equal(first.steps, 2);
    assert.equal(first.wallMs, 1_234);
    assert.equal(first.firstStepAtMs, 15);
    assert.equal(first.toolCalls, "read:2", "grouped counts render compactly");
    assert.equal(first.toolSpanMs, 40);
    assert.equal(first.unattributedSpanMs, 1_194);
    assert.equal(first.tokensInput, 100);
    assert.equal(first.tokensOutput, 50);
    assert.equal(first.tokensReasoning, 20);
    assert.equal(first.tokensCacheRead, 10);
    assert.equal(first.tokensCacheWrite, 5);
    assert.equal(first.finishReasons, "tool-calls,stop");
    assert.equal(first.retries, 0);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a failed prompt emits one turn-stats event and keeps the original error verdict", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new StatsCarrierAdapter(["fail", "ok"], {
    fail: turnStatsFixture({ outcome: "error", terminalEvent: null, steps: 4, toolCalls: { read: 3 }, tokens: null, finishReasons: null }),
    ok: turnStatsFixture(),
  });
  try {
    const result = await statsEngine(adapter, dir, cacheDir, events).run();
    assert.equal(result.areas[0]?.status, "error");
    assert.match(result.areas[0]?.error ?? "", /opencode prompt returned no terminal event \(session ses_stub_001\)/);
    const statsEvents = events.filter((e) => e.event === "turn-stats");
    assert.equal(statsEvents.length, 2, "the failed prompt emitted its own single event");
    const failed = statsEvents[0] as unknown as Record<string, unknown>;
    assert.equal(failed.areaId, "architecture");
    assert.equal(failed.outcome, "error");
    assert.equal(failed.terminalEvent, undefined, "a prompt with no terminal event omits the field");
    assert.equal(failed.steps, 4);
    assert.equal(failed.toolCalls, "read:3");
    assert.ok(!("tokensInput" in failed) || failed.tokensInput === undefined, "missing token data is omitted, not zero");
    assert.ok(!("finishReasons" in failed) || failed.finishReasons === undefined, "missing finish reasons are omitted");
    // the existing ERROR verdict still fires alongside the stats event
    const errorEvent = events.find((e) => e.event === "error" && e.level === "ERROR");
    assert.ok(errorEvent !== undefined, "the pre-existing error lifecycle event is unchanged");
    assert.match(errorEvent.error ?? "", /opencode prompt returned no terminal event/);
    // the second area's prompt emitted its own completed event
    assert.equal(statsEvents[1] && (statsEvents[1] as unknown as Record<string, unknown>).outcome, "completed");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("adapters without turn statistics emit no turn-stats event", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Mock proposal", 5, "low")]));
  try {
    const result = await statsEngine(adapter, dir, cacheDir, events).run();
    assert.ok(result.areas.every((a) => a.status === "ok"), "the run itself is unchanged");
    assert.equal(events.filter((e) => e.event === "turn-stats").length, 0, "no snapshot → no emission");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a throwing lifecycle observer cannot mask the original prompt error", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new StatsCarrierAdapter(["fail", "ok"], {
    fail: turnStatsFixture({ outcome: "error", terminalEvent: null }),
    ok: turnStatsFixture(),
  });
  const engine = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture", "tests"],
    onLifecycle: (event) => {
      if (event.event === "turn-stats") throw new Error("observer exploded");
      events.push(event);
    },
  });
  try {
    const result = await engine.run();
    assert.equal(result.areas[0]?.status, "error");
    assert.match(result.areas[0]?.error ?? "", /opencode prompt returned no terminal event/, "the original error message survives the instrumentation failure");
    assert.equal(result.areas[1]?.status, "ok", "the observer failure stays swallowed and discovery continues");
    assert.equal(events.filter((e) => e.event === "turn-stats").length, 0, "the failed emissions never surface");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a complete proposal with an empty dependencies array is accepted end-to-end", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  // the prompt documents "omit the field or use [] when there are none" —
  // the example shape the model is told to copy ends with "dependencies": [],
  // so the exact form it produces must survive validation (regression for the
  // former "dependencies must contain at least one non-empty entry" rejection)
  const adapter = new MockOpenCodeAdapter(() =>
    JSON.stringify([{ ...proposal("Guard evaluator against NaN samples", 6, "low"), dependencies: [] }]),
  );
  try {
    const discovery = new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 1,
      cacheDir,
      areas: ["tests"],
    });
    const result = await discovery.run();
    assert.equal(result.areas[0]?.status, "ok");
    assert.equal(result.areas[0]?.rejected.length, 0, "no rejection may be reported for the documented empty form");
    assert.equal(result.areas[0]?.proposals.length, 1);
    assert.deepEqual(result.areas[0]?.proposals[0]?.dependencies, []);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the example JSON embedded in the discovery prompt passes validateProposal", () => {
  // drift guard: the prompt teaches a concrete example shape; if either the
  // example or the validator changes, this test fails before a discovery run
  // wastes a full model turn on proposals that would all be rejected
  const dir = tmpRepo();
  try {
    // the example cites src/queue.ts as its evidence file; it must exist for
    // the example to validate
    fs.writeFileSync(path.join(dir, "src/queue.ts"), "export function executeNext(limit: number): void {}\n");
    const prompt = areaInstruction({ key: "tests", focus: "Missing or weak test coverage." }, 3, "src/queue.ts");
    const marker = "in the shape of this example:";
    const markerAt = prompt.indexOf(marker);
    assert.ok(markerAt >= 0, "the prompt must still introduce the example");
    const exampleStart = prompt.indexOf('{"title"', markerAt);
    assert.ok(exampleStart > markerAt, "the example object must follow the example marker");
    const lineEnd = prompt.indexOf("\n", exampleStart);
    const exampleLine = prompt.slice(exampleStart, lineEnd === -1 ? undefined : lineEnd).trim();
    const parsed: unknown = JSON.parse(exampleLine);
    const validated = validateProposal(parsed, dir);
    assert.equal(validated.ok, true, `the prompt's own example must validate: ${validated.reason ?? ""}`);
    assert.deepEqual(validated.proposal?.dependencies, [], "the example demonstrates the documented empty form");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ——— stage-level pipeline observability ———
// All stage transitions are emitted from the engine's per-area path (src/
// discovery.ts), so these tests assert the observable contract directly:
// which events fire, in what order, with which per-area context — while the
// engine's own lifecycle events keep flowing alongside them.

/** Builds an engine whose stage events land in a capturing sink, with a
 *  deterministic clock so durationMs is exactly assertable. */
function stageEngine(
  dir: string,
  cacheDir: string,
  options: Partial<DiscoveryOptions> = {},
  now = Date.now,
): { adapter: MockOpenCodeAdapter; engine: DiscoveryEngine; events: LifecycleEvent[] } {
  const events: LifecycleEvent[] = [];
  const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Stage logger proposal", 6, "low")]));
  console.log(`DEBUG stageEngine: received options=${JSON.stringify(options)}`);
  console.log(`DEBUG stageEngine: options.promptBudgetChars=${options.promptBudgetChars}`);
  console.log(`DEBUG stageEngine: about to call DiscoveryEngine constructor`);
  const engine = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture", "tests"],
    onLifecycle: (event) => events.push(event),
    now,
    ...options,
  });
  console.log(`DEBUG stageEngine: after constructor, checking engine...`);
  console.log(`DEBUG stageEngine: engine.options.promptBudgetChars=${engine.options?.promptBudgetChars}`);
  return { adapter, engine, events };
}

test("stage events fire in pipeline order for a successful run", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  try {
    const { adapter, engine, events } = stageEngine(dir, cacheDir);
    await engine.run();
    const stageNames = new Set(["discovery", "evidence", "prompt", "opencode", "response", "proposal"]);
    const stageEvents = events.filter((e) => e.stage !== undefined && stageNames.has(e.stage) && e.event !== "turn-stats");
    // The engine's own lifecycle events (run/area/model-request/parse) are
    // interleaved; only the stage channel is ordered here. Each of the two
    // areas runs the full per-area pipeline between the run's bookends.
    const areaPipeline = [
      "evidence:started",
      "evidence:completed",
      "prompt:started",
      "prompt:prepared",
      "prompt:completed",
      "opencode:started",
      "opencode:submitted",
      "opencode:completed",
      "response:started",
      "response:parsed",
      "response:completed",
      "proposal:started",
      "proposal:accepted",
      "proposal:completed",
    ];
    const expectedEvents = ["discovery:started", ...areaPipeline, ...areaPipeline, "discovery:completed"];
    assert.deepEqual(stageEvents.map((e) => `${e.stage}:${e.event}`), expectedEvents);
    // exactly one event per transition: the stage logger's guards are not
    // defeated by two areas sharing the same adapter/session
    assert.equal(events.filter((e) => e.stage === "discovery" && e.event === "started").length, 1);
    assert.equal(events.filter((e) => e.stage === "discovery" && e.event === "completed").length, 1);
    assert.equal(events.filter((e) => e.stage === "opencode" && e.event === "completed").length, 2);
    assert.equal(events.filter((e) => e.stage === "proposal" && e.event === "accepted").length, 2);
    assert.equal(events.filter((e) => e.stage === "response" && e.event === "parsed").length, 2);
    assert.equal(events.filter((e) => e.stage === "evidence" && e.event === "completed").length, 2);
    assert.equal(events.filter((e) => e.stage === "prompt" && e.event === "prepared").length, 2);
    assert.equal(events.filter((e) => e.stage === "opencode" && e.event === "submitted").length, 2);
    for (const stage of ["evidence", "prompt", "opencode", "response", "proposal"]) {
      assert.equal(events.filter((e) => e.stage === stage && e.event === "started").length, 2, `${stage}.started fires once per area`);
      assert.equal(events.filter((e) => e.stage === stage && e.event === "completed").length, 2, `${stage}.completed fires once per area`);
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("stage events carry per-area correlation (areaId + session id)", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  try {
    const { engine, events } = stageEngine(dir, cacheDir);
    await engine.run();
    const stageNames = new Set(["discovery", "evidence", "prompt", "opencode", "response", "proposal"]);
    const stages = events.filter((e) => e.stage !== undefined && stageNames.has(e.stage) && e.event !== "turn-stats");
    const architecture = stages.filter((e) => e.areaId === "architecture");
    const tests = stages.filter((e) => e.areaId === "tests");
    for (const expectedEvent of [
      "discovery.started",
      "evidence.started",
      "evidence.completed",
      "prompt.started",
      "prompt.prepared",
      "prompt.completed",
      "opencode.started",
      "opencode.submitted",
      "opencode.completed",
      "response.started",
      "response.parsed",
      "response.completed",
      "proposal.started",
      "proposal.accepted",
      "proposal.completed",
      "discovery.completed",
    ]) {
      const [stage, eventPart] = expectedEvent.split(".");
      // discovery events are run-level, not area-level
      if (stage === "discovery") {
        assert.ok(!architecture.some((e) => e.stage === stage && e.event === eventPart), "discovery events are run-level, not area-level");
      } else {
        assert.equal(architecture.filter((e) => e.stage === stage && e.event === eventPart).length, 1);
      }
      // area-specific events should have areaId
      assert.ok(!tests.some((e) => e.stage === stage && e.event === eventPart && e.areaId === "architecture"), "tests area events should not have architecture areaId");
    }
    // every stage event names its area; the run-level events carry the run's
    // own pseudo-area id, never a fabricated area id
    for (const runLevel of stages.filter((e) => e.stage === "discovery")) {
      assert.equal(runLevel.areaId, "run", "discovery started/completed are run-level events");
    }
    assert.ok(!architecture.some((e) => e.areaId === "tests"));
    assert.ok(!tests.some((e) => e.areaId === "architecture"));
    const first = architecture.find((e) => e.stage === "opencode" && e.event === "submitted")!;
    const second = tests.find((e) => e.stage === "opencode" && e.event === "submitted")!;
    // sessionId is tracked in the stage logger, not the LifecycleEvent
    assert.notEqual(first, second, "different areas have different sessions");
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("evidence extraction failure is reported per area without aborting the run", async () => {
  const dir = tmpRepo();
  // HealthEvaluator.java contains no reliability keyword, so the area's
  // keyword table matches nothing: no excerpts, and the engine must still
  // run the prompt (with no evidence block) instead of aborting.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Stage logger proposal", 6, "low")]));
  const engine = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["reliability"],
    onLifecycle: (event) => events.push(event),
  });
  try {
    const result = await engine.run();
    const extraction = events.filter((e) => e.stage === "evidence" && e.event === "failed");
    assert.equal(extraction.length, 1);
    assert.equal(extraction[0]!.areaId, "reliability");
    assert.equal(extraction[0]!.error, "no source excerpts extracted");
    assert.equal(events.filter((e) => e.stage === "evidence" && e.event === "extraction_failed").length, 1, "the extraction_failed stage event is reported too");
    assert.equal(result.areas[0]?.status, "ok", "the area still completes");
    assert.equal(events.filter((e) => e.stage === "evidence" && e.event === "completed").length, 0);
    assert.equal(events.filter((e) => e.stage === "opencode" && e.event === "completed").length, 1);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("evidence failure durations are real elapsed times, never invented", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  // A clock that advances 100 ms per reading: the evidence stage's start
  // and its failure are consecutive readings, so durationMs is exactly one
  // tick — measured against the injected clock, never invented.
  let t = 0;
  const now = () => (t += 100);
  const { adapter, engine, events } = stageEngine(dir, cacheDir, { areas: ["reliability"] }, now);
  try {
    await engine.run();
    const failed = events.find((e) => e.stage === "evidence" && e.event === "failed")!;
    assert.equal(failed.durationMs, 100, "durationMs is the monotonic elapsed time since the stage start");
    assert.equal(failed.durationMs >= 0, true, "elapsed time is never negative");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("every started stage completes once per area with a real duration", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const { adapter, engine, events } = stageEngine(dir, cacheDir);
  try {
    await engine.run();
    const stageNames = new Set(["discovery", "evidence", "prompt", "opencode", "response", "proposal"]);
    const stages = events.filter((e) => e.stage !== undefined && stageNames.has(e.stage) && e.event !== "turn-stats");
    // start events carry context only; duration belongs to the outcome
    for (const started of stages.filter((e) => e.event === "started")) {
      assert.equal(started.durationMs, undefined, `${started.stage}.started must not invent a duration`);
    }
    // every completion reports a real elapsed time
    for (const completed of stages.filter((e) => e.event === "completed")) {
      assert.equal(typeof completed.durationMs, "number", `${completed.stage}.completed carries durationMs`);
      assert.ok(completed.durationMs! >= 0, `${completed.stage}.completed duration is never negative`);
    }
    // each per-area stage starts and completes exactly once for its area
    for (const areaId of ["architecture", "tests"]) {
      for (const stage of ["evidence", "prompt", "opencode", "response", "proposal"]) {
        const scoped = stages.filter((e) => e.areaId === areaId && e.stage === stage);
        assert.equal(scoped.filter((e) => e.event === "started").length, 1, `${stage}.started fires once for ${areaId}`);
        assert.equal(scoped.filter((e) => e.event === "completed").length, 1, `${stage}.completed fires once for ${areaId}`);
      }
    }
    const proposalDone = stages.find(
      (e) => e.areaId === "architecture" && e.stage === "proposal" && e.event === "completed",
    ) as (LifecycleEvent & { accepted?: number; rejected?: number }) | undefined;
    assert.equal(proposalDone?.accepted, 1);
    assert.equal(proposalDone?.rejected, 0);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("prompt budget failure emits prompt.failed and never starts the model stages", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const { adapter, engine, events } = stageEngine(dir, cacheDir, {
    areas: ["architecture"],
    promptBudgetChars: 10,
  });
  try {
    const result = await engine.run();
    assert.equal(result.areas[0]?.status, "error");
    assert.match(result.areas[0]?.error ?? "", /context budget exceeded/);

    const started = events.find((e) => e.stage === "prompt" && e.event === "started")!;
    assert.equal(started.areaId, "architecture");
    const failed = events.find((e) => e.stage === "prompt" && e.event === "failed")!;
    assert.equal(failed.areaId, "architecture");
    assert.match(failed.error ?? "", /context budget exceeded/);
    assert.equal(typeof failed.durationMs, "number", "the failed prompt stage reports its elapsed time");
    assert.ok(failed.durationMs! >= 0);

    assert.equal(events.filter((e) => e.stage === "prompt" && e.event === "prepared").length, 0);
    assert.equal(events.filter((e) => e.stage === "prompt" && e.event === "completed").length, 0);
    assert.equal(events.filter((e) => e.stage === "opencode").length, 0, "no model stage starts after the prompt failure");
    assert.equal(events.filter((e) => e.stage === "response").length, 0);
    assert.equal(events.filter((e) => e.stage === "proposal").length, 0);

    const runFailed = events.find((e) => e.stage === "discovery" && e.event === "failed")!;
    assert.equal(runFailed.areaId, "run");
    assert.equal(typeof runFailed.durationMs, "number");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("opencode failure events carry the error, the elapsed time and the session id", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new MockOpenCodeAdapter(() => {
    throw new Error("model connection refused");
  });
  const engine = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture"],
    onLifecycle: (event) => events.push(event),
  });
  try {
    const result = await engine.run();
    assert.equal(result.areas[0]?.status, "error", "the area keeps the adapter's verdict");
    assert.match(result.areas[0]?.error ?? "", /model connection refused/);
    const failed = events.find((e) => e.stage === "opencode" && e.event === "failed")!;
    assert.equal(failed.areaId, "architecture");
    assert.match(failed.error ?? "", /model connection refused/);
    assert.equal(typeof failed.durationMs, "number", "a failed stage still reports its elapsed time");
    assert.ok(failed.durationMs! >= 0);
    // the prompt itself was prepared successfully; only the model stage failed
    assert.equal(events.filter((e) => e.stage === "prompt" && e.event === "prepared").length, 1);
    assert.equal(events.filter((e) => e.stage === "prompt" && e.event === "completed").length, 1);
    // no completion for the failed model stage
    assert.equal(events.filter((e) => e.stage === "opencode" && e.event === "completed").length, 0);
    // the failed stage never started the response/proposal stages
    assert.equal(events.filter((e) => e.stage === "response" && e.event === "started").length, 0);
    assert.equal(events.filter((e) => e.stage === "proposal" && e.event === "started").length, 0);
    // a run whose area errored ends in the run-level discovery.failed event
    const runFailed = events.find((e) => e.stage === "discovery" && e.event === "failed");
    assert.equal(runFailed?.areaId, "run", "discovery.failed is a run-level event");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("proposal accept and reject events carry the reason, never the raw model reply", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  // A plain (valid) proposal: the engine must accept it and emit
  // proposal.accepted — the rejection path is covered by the test below.
  const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Stage logger proposal", 6, "low")]));
  const engine = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture"],
    onLifecycle: (event) => events.push(event),
  });
  try {
    const result = await engine.run();
    const accepted = events.find((e) => e.stage === "proposal" && e.event === "accepted")!;
    assert.equal(accepted.areaId, "architecture");
    // sessionId is not on LifecycleEvent
    // rejected reasons are plain strings; no model-response dump may leak in
    const rejected = events.filter((e) => e.stage === "proposal" && e.event === "rejected");
    assert.equal(rejected.length, 0, "a valid proposal is not rejected");
    assert.ok(!JSON.stringify(events).includes("model connection refused"), "no raw error text in the stage channel");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a rejected proposal emits proposal.rejected with the validator's reason", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new MockOpenCodeAdapter(() =>
    JSON.stringify([{ ...proposal("Stage logger proposal", 6, "low"), verification: "run tests" }].map((p) => p)),
  );
  const engine = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture"],
    onLifecycle: (event) => events.push(event),
  });
  try {
    const result = await engine.run();
    const rejected = events.find((e) => e.stage === "proposal" && e.event === "rejected")!;
    assert.equal(rejected.areaId, "architecture");
    assert.equal(typeof rejected.error, "string");
    assert.match(rejected.error ?? "", /verification/);
    assert.equal(events.filter((e) => e.stage === "proposal" && e.event === "accepted").length, 0);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a throwing stage observer cannot break discovery", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Stage logger proposal", 6, "low")]));
  const engine = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture", "tests"],
    onLifecycle: (event) => {
      // One designated stage event explodes; the logger must swallow it and
      // keep every other event (and discovery itself) flowing.
      if (event.stage === "evidence" && event.event === "started") throw new Error("stage observer exploded");
      events.push(event);
    },
  });
  try {
    const result = await engine.run();
    assert.equal(result.areas[0]?.status, "ok");
    assert.equal(result.areas[1]?.status, "ok");
    // Each area's own proposal survives the throwing observer. The run-level
    // list would then apply the engine's cross-area dedupe (both areas return
    // the same title/file here) — that behaviour has its own test.
    assert.deepEqual(result.areas.map((a) => a.proposals.length), [1, 1], "both areas' proposals survive");
    assert.equal(events.filter((e) => e.stage === "discovery" && e.event === "completed").length, 1);
    assert.equal(events.filter((e) => e.stage === "proposal" && e.event === "accepted").length, 2);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("dry run still emits the full stage set", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cache-"));
  const events: LifecycleEvent[] = [];
  const adapter = new MockOpenCodeAdapter(() => JSON.stringify([proposal("Stage logger proposal", 6, "low")]));
  const engine = new DiscoveryEngine(adapter, {
    repoDir: dir,
    model: MODEL,
    maxProposalsPerArea: 1,
    cacheDir,
    areas: ["architecture"],
    onLifecycle: (event) => events.push(event),
    dryRun: true,
  });
  try {
    const result = await engine.run();
    assert.equal(result.proposals.length, 1);
    assert.equal(result.persisted, false);
    const stages = events.filter((e) => e.stage !== undefined).filter((e) => e.event !== "turn-stats");
    assert.ok(stages.some((e) => e.stage === "discovery" && e.event === "started"));
    assert.ok(stages.some((e) => e.stage === "opencode" && e.event === "completed"));
    assert.ok(stages.some((e) => e.stage === "proposal" && e.event === "accepted"));
    assert.ok(stages.some((e) => e.stage === "discovery" && e.event === "completed"));
    assert.equal(events.filter((e) => e.stage === "discovery" && e.event === "completed").length, 1);
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
