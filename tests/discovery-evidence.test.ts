import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenCodeAdapter } from "../src/opencode.ts";
import {
  DISCOVERY_AREAS,
  DiscoveryEngine,
  areaInstruction,
  extractSourceEvidence,
  repoManifest,
  selectFilesForArea,
} from "../src/discovery.ts";
import type { DiscoveryArea } from "../src/discovery.ts";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-dis-ev-"));
  fs.mkdirSync(path.join(dir, "src/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthEvaluator.java"), "class HealthEvaluator {}");
  return dir;
}

const MODEL = "Qwen-Mimo/model";

function area(key: string): DiscoveryArea {
  return DISCOVERY_AREAS.find((a) => a.key === key)!;
}

test("selectFilesForArea returns repository-relative path strings that resolve under repoDir", () => {
  // Regression: walk() collects path strings while the old selection read
  // entry.file off them, so every selected path was undefined and evidence
  // extraction crashed on path.join(repoDir, undefined).
  const dir = tmpRepo();
  try {
    const selected = selectFilesForArea(dir, area("reliability"), 120);
    assert.ok(selected.length >= 1, "the seeded source must be selected");
    for (const file of selected) {
      assert.equal(typeof file, "string", `selected entry must be a path string, got ${String(file)}`);
      assert.ok(file.length > 0, "selected entries must not be undefined");
      assert.ok(!path.isAbsolute(file), `paths must be repo-relative, got ${file}`);
      assert.ok(fs.existsSync(path.join(dir, file)), `selected path must resolve under repoDir, got ${file}`);
      assert.equal(file, path.relative(dir, path.join(dir, file)), "paths must be normalized relative to the repo root");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keyword-matched content ranks ahead; the manifest priority fills the rest (production code first)", () => {
  const dir = tmpRepo();
  try {
    // None of these contents match the reliability keyword table; only the
    // guard file does ("try"/"catch"), so it must rank first regardless of
    // its manifest priority.
    fs.mkdirSync(path.join(dir, "src/test/java/io/diakosys"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/Plain.java"), "class Plain {}");
    fs.writeFileSync(path.join(dir, "src/test/java/io/diakosys/GuardTest.java"), "class GuardTest { void run() { try {} catch (Exception e) {} } }");
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/notes.md"), "notes");
    assert.deepEqual(selectFilesForArea(dir, area("reliability"), 120), [
      "src/test/java/io/diakosys/GuardTest.java",
      "src/main/java/io/diakosys/HealthEvaluator.java",
      "src/main/java/io/diakosys/Plain.java",
      "docs/notes.md",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an area without a keyword table keeps the generic manifest order and slices to the limit", () => {
  const dir = tmpRepo();
  try {
    fs.mkdirSync(path.join(dir, "src/test/java/io/diakosys"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/Plain.java"), "class Plain {}");
    fs.writeFileSync(path.join(dir, "src/test/java/io/diakosys/GuardTest.java"), "class GuardTest { void run() { try {} catch (Exception e) {} } }");
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/notes.md"), "notes");
    const selected = selectFilesForArea(dir, area("architecture"), 220);
    // identical ordering to the generic repoManifest: src/main first, then the
    // remaining paths lexicographically
    assert.deepEqual(selected, repoManifest(dir).split("\n"));
    assert.deepEqual(selected, [
      "src/main/java/io/diakosys/HealthEvaluator.java",
      "src/main/java/io/diakosys/Plain.java",
      "docs/notes.md",
      "src/test/java/io/diakosys/GuardTest.java",
    ]);
    assert.deepEqual(selectFilesForArea(dir, area("architecture"), 3), [
      "src/main/java/io/diakosys/HealthEvaluator.java",
      "src/main/java/io/diakosys/Plain.java",
      "docs/notes.md",
    ], "the limit slices the ranked list");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractSourceEvidence keeps verbatim keyword neighbourhoods with real line numbers", () => {
  const dir = tmpRepo();
  try {
    const file = "src/main/java/io/diakosys/HealthEvaluator.java";
    fs.writeFileSync(
      path.join(dir, file),
      [
        "class HealthEvaluator {",
        "  int a;",
        "  int b;",
        "  int c;",
        "  int tryGuard;",
        "  int d;",
        "  int e;",
        "}",
      ].join("\n"),
    );
    const excerpts = extractSourceEvidence(dir, area("reliability"), [file, "src/main/java/io/diakosys/Gone.java"]);
    assert.equal(excerpts.length, 1, "the vanished file is skipped, the existing one excerpted");
    assert.equal(excerpts[0]!.file, file);
    assert.equal(excerpts[0]!.line, 3, "the excerpt line is 1-based at the start of the keyword neighbourhood");
    assert.equal(
      excerpts[0]!.excerpt,
      "  int b;\n  int c;\n  int tryGuard;\n  int d;\n  int e;",
      "the excerpt is a verbatim ±2-line slice around the keyword hit",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty evidence and missing optional files are handled safely", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-dis-ev-empty-"));
  try {
    // no src/config/docs roots at all: nothing to select, nothing crashes
    assert.deepEqual(selectFilesForArea(empty, area("reliability"), 120), []);
    assert.deepEqual(selectFilesForArea(empty, area("architecture"), 220), []);
    // selections referencing files that are gone are skipped, not crashed on
    assert.deepEqual(
      extractSourceEvidence(empty, area("reliability"), ["src/main/java/io/diakosys/Gone.java"]),
      [],
    );
    // a keyword-table area over a repo whose files carry no keywords yields no
    // excerpts: empty evidence is a valid outcome, not a failure
    const dir = tmpRepo();
    try {
      assert.deepEqual(
        extractSourceEvidence(dir, area("reliability"), selectFilesForArea(dir, area("reliability"), 120)),
        [],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the engine progresses past evidence selection: the prompt manifest lists real selected paths", async () => {
  const dir = tmpRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-dis-ev-cache-"));
  const adapter = new MockOpenCodeAdapter(() => "[]");
  try {
    const result = await new DiscoveryEngine(adapter, {
      repoDir: dir,
      model: MODEL,
      maxProposalsPerArea: 1,
      promptTimeoutMs: 5000,
      cacheDir,
      areas: ["reliability", "architecture"],
      dryRun: true,
    }).run();
    assert.equal(adapter.calls.length, 2, "both areas reach the model");
    assert.equal(result.areas[0]!.status, "ok");
    assert.equal(result.areas[1]!.status, "ok");
    const header = "Repository file manifest (paths relative to repo root):";
    for (const call of adapter.calls) {
      assert.ok(!call.description.includes("undefined"), "the path.join(repoDir, undefined) symptom must be gone");
      const start = call.description.indexOf(header);
      assert.ok(start !== -1, "the prompt carries the manifest header");
      const manifest = call.description.slice(start + header.length).trim();
      assert.ok(manifest.length > 0, "the manifest section is not empty");
      for (const line of manifest.split("\n")) {
        assert.ok(!path.isAbsolute(line), `manifest lines are repo-relative, got ${line}`);
        assert.ok(fs.existsSync(path.join(dir, line)), `manifest line must resolve under the repo, got ${line}`);
      }
    }
    // the reliability area matches no keywords here, so its prompt carries the
    // manifest only; the architecture area excerpts every non-empty line
    const reliability = adapter.calls.find((c) => c.title === "Discovery: reliability")!;
    const architecture = adapter.calls.find((c) => c.title === "Discovery: architecture")!;
    assert.ok(!reliability.description.includes("SOURCE: "), "an excerpt-less selection renders no evidence block");
    assert.ok(architecture.description.includes("SOURCE: "), "excerpted files render the evidence block");
  } finally {
    await adapter.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("areaInstruction renders the optional evidence block before the manifest section", () => {
  const dir = tmpRepo();
  try {
    const manifest = selectFilesForArea(dir, area("reliability"), 120).join("\n");
    const withEvidence = areaInstruction(area("reliability"), 3, manifest, "SOURCE: src/main/java/io/diakosys/HealthEvaluator.java (line 1)\nclass HealthEvaluator {}");
    const withoutEvidence = areaInstruction(area("reliability"), 3, manifest);
    const header = "Repository file manifest (paths relative to repo root):";
    const evidenceIndex = withEvidence.indexOf("SOURCE: ");
    const headerIndex = withEvidence.indexOf(header);
    assert.ok(evidenceIndex !== -1 && headerIndex !== -1 && evidenceIndex < headerIndex, "the evidence block precedes the manifest section");
    // without evidence the prompt is identical to the 3-arg form: the manifest
    // section stays a pure path-per-line listing either way
    assert.equal(withoutEvidence, areaInstruction(area("reliability"), 3, manifest, undefined));
    assert.deepEqual(withEvidence.slice(headerIndex + header.length).trim().split("\n"), manifest.split("\n"), "the manifest section lists exactly the selected paths");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
