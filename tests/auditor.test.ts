import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditProposals, type AuditResult } from "../src/auditor.ts";
import type { Proposal } from "../src/proposal.ts";
import { makeProposal } from "./helpers.ts";

/**
 * Every fixture lives in its own throwaway directory, so the auditor is always
 * pointed at a synthetic repository rather than the user's real one.
 */
function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-aud-"));
}

function writeTree(repo: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function makeProposalFixture(repo: string): { proposal: Proposal; files: Record<string, string> } {
  const files: Record<string, string> = {
    "src/queue.ts":
      "export class Queue {\n" +
      "  items: unknown[] = [];\n" +
      "  enqueue(item): void { this.items.push(item); }\n" +
      "  grows without limit and blocks producers;\n" +
      "  enqueue is the method producers call.\n" +
      "}\n" +
      "const maximum size with a wait signal so producers are not dropped silently.",
    "tests/queue.test.ts": "import { Queue } from '../src/queue';\ntest('queues items', () => { const q = new Queue(); q.enqueue(1); });",
  };
  return {
    proposal: makeProposal({
      title: "Add bounded queue with backpressure",
      problem: "The queue grows without limit and blocks producers.",
      rationale: "Add a maximum size with a wait signal so producers are not dropped silently.",
      evidence: [{ file: "src/queue.ts", symbol: "Queue", observation: "the Queue class has an enqueue method" }],
      approach: "Introduce a size cap and a blocking enqueue.",
      outcome: "Producers stall instead of dropping items.",
      priority: 1,
      complexity: "medium",
      verification: ["node --test tests/queue.test.ts"],
    }),
    files,
  };
}

function makeProposalWithFiles(
  repo: string,
  proposal: Proposal,
  extraFiles: Record<string, string>,
): { proposal: Proposal; files: Record<string, string> } {
  const merged = { ...makeProposalFixture(repo).files, ...extraFiles };
  return { proposal, files: merged };
}

function makeProposalForFile(repo: string, file: string, symbol: string, observation: string, problem: string): Proposal {
  return makeProposal({
    title: "Grounded claim for " + file,
    problem,
    rationale: "The repository contains a concrete implementation the proposal can point at.",
    evidence: [{ file, symbol, observation }],
    approach: "Use the existing implementation as the basis for the work.",
    outcome: "The work proceeds from verified repository state.",
    priority: 1,
    complexity: "low",
    verification: ["node --test"],
  });
}

test("a fully evidence-backed proposal is accepted with a VALID verdict", () => {
  const repo = tmpRepo();
  writeTree(repo, makeProposalFixture(repo).files);
  const { proposal } = makeProposalFixture(repo);

  const results = auditProposals(
    {
      proposals: [proposal],
      rejected: [],
    },
    repo,
  );

  assert.equal(results.proposals.length, 1);
  assert.equal(results.proposals[0]!.title, proposal.title);
  assert.equal(results.proposals[0]!.evidence[0]!.file, "src/queue.ts");
  assert.deepEqual(results.proposals[0]!.verification, ["node --test tests/queue.test.ts"]);
  assert.equal(results.proposals[0]!.priority, 1);
  assert.equal(results.proposals[0]!.complexity, "medium");
  assert.equal(results.proposals[0]!.outcome, "Producers stall instead of dropping items.");
  assert.equal(results.proposals[0]!.approach, "Introduce a size cap and a blocking enqueue.");
  assert.equal(results.proposals[0]!.rationale, "Add a maximum size with a wait signal so producers are not dropped silently.");
  assert.equal(results.proposals[0]!.problem, "The queue grows without limit and blocks producers.");
  assert.equal(results.rejected.length, 0);
});

test("an unreadable evidence file is INVALID", () => {
  const repo = tmpRepo();
  writeTree(repo, { "src/queue.ts": "export class Queue {}" });
  const proposal = makeProposalForFile(repo, "src/queue.ts", "Queue", "does not exist", "The queue grows without limit.");
  proposal.evidence[0]!.file = "src/missing.ts";

  const results = auditProposals({ proposals: [proposal], rejected: [] }, repo);
  assert.equal(results.proposals.length, 0);
  assert.equal(results.rejected.length, 1);
  assert.equal(results.rejected[0]!.area, "architecture");
  assert.match(results.rejected[0]!.reason, /unreadable/);
});

test("a cited symbol that is not present is INVALID", () => {
  const repo = tmpRepo();
  writeTree(repo, { "src/queue.ts": "export class Queue {}" });
  const proposal = makeProposalForFile(repo, "src/queue.ts", "Backpressure", "the class has a cap", "The queue grows without limit.");

  const results = auditProposals({ proposals: [proposal], rejected: [] }, repo);
  assert.equal(results.proposals.length, 0);
  assert.equal(results.rejected[0]!.reason, `evidence symbol "${"Backpressure"}" does not appear in src/queue.ts`);
});

test("an observation not grounded in its cited file is INVALID", () => {
  const repo = tmpRepo();
  writeTree(repo, { "src/queue.ts": "export class Queue { enqueue(item) {} }" });
  const proposal = makeProposalForFile(
    repo,
    "src/queue.ts",
    "Queue",
    "the Queue class has an enqueue method and a maximum size",
    "The queue grows without limit.",
  );

  const results = auditProposals({ proposals: [proposal], rejected: [] }, repo);
  assert.equal(results.proposals.length, 0);
  assert.equal(results.rejected[0]!.reason, "observation in src/queue.ts is not supported by the file's contents");
});

test("a claim whose behaviour terms are absent from the cited source is INVALID", () => {
  const repo = tmpRepo();
  writeTree(repo, { "src/queue.ts": "export class Queue { enqueue(item) { this.items.push(item); } }" });
  const proposal = makeProposalForFile(
    repo,
    "src/queue.ts",
    "Queue",
    "the Queue class has an enqueue method",
    "The queue grows without limit and blocks producers.",
  );

  const results = auditProposals({ proposals: [proposal], rejected: [] }, repo);
  assert.equal(results.proposals.length, 0);
  assert.equal(results.rejected[0]!.reason, "observation in src/queue.ts is not supported by the file's contents");
});

test("a tests-area claim already covered by an existing test is INVALID", () => {
  const repo = tmpRepo();
  writeTree(repo, {
    "src/queue.ts":
      "export class Queue {\n" +
      "  items: unknown[] = [];\n" +
      "  enqueue(item): void { this.items.push(item); }\n" +
      "  grows without limit and blocks producers;\n" +
      "  enqueue is the method producers call.\n" +
      "}\n" +
      "const maximum size with a wait signal so producers are not dropped silently.",
    "tests/queue.test.ts": "import { Queue } from '../src/queue';\ntest('queues items', () => { const q = new Queue(); q.enqueue(1); });\n// the Queue class has an enqueue method that pushes items without a limit",
  });
  const proposal = makeProposal({
    title: "Add bounded queue with backpressure",
    problem: "The queue grows without limit and blocks producers.",
    rationale: "Add a maximum size with a wait signal so producers are not dropped silently.",
    evidence: [{ file: "tests/queue.test.ts", symbol: "Queue", observation: "the Queue class has an enqueue method" }],
    approach: "Introduce a size cap and a blocking enqueue.",
    outcome: "Producers stall instead of dropping items.",
    priority: 1,
    complexity: "medium",
    verification: ["node --test tests/queue.test.ts"],
  });

  const results = auditProposals({ proposals: [proposal], rejected: [] }, repo);
  assert.equal(results.proposals.length, 0);
  assert.equal(results.rejected[0]!.area, "tests");
  assert.match(results.rejected[0]!.reason, /already covered/);
});

test("a proposal that duplicates an earlier claim in the same run is PARTIALLY_VALID and rejected", () => {
  const repo = tmpRepo();
  writeTree(repo, makeProposalFixture(repo).files);
  const first = makeProposalFixture(repo).proposal;
  const duplicate = makeProposal({ ...first, title: "Add bounded queue with backpressure" });

  const results = auditProposals({ proposals: [first, duplicate], rejected: [] }, repo);

  assert.equal(results.proposals.length, 1);
  assert.equal(results.proposals[0]!.title, first.title);
  assert.equal(results.rejected.length, 1);
  assert.equal(results.rejected[0]!.area, "architecture");
  assert.equal(results.rejected[0]!.reason, "duplicates an earlier proposal in this run (area architecture); evidence-supported but redundant");
  assert.equal(results.rejected[0]!.raw, duplicate.title);
  assert.match(results.rejected[0]!.reason, /duplicates an earlier proposal in this run/);
});

test("rejection area is derived from the evidence file path, not from the proposal", () => {
  const repo = tmpRepo();
  writeTree(repo, {});

  // Point each proposal at a different directory so the evidence path drives
  // the derived area. None of the files exist, so every proposal is INVALID
  // and produces a rejection.
  const testsArea = makeProposalForFile(repo, "tests/foo.test.ts", "Foo", "a test file", "Some behaviour.");
  const architectureArea = makeProposalForFile(repo, "src/arch.ts", "Arch", "a source file", "Some other behaviour.");
  const rootArea = makeProposalForFile(repo, "docs/notes.md", "Notes", "a note", "Yet another behaviour.");

  const results = auditProposals({ proposals: [testsArea, architectureArea, rootArea], rejected: [] }, repo);

  const areas = results.rejected.map((r) => r.area).sort();
  assert.deepEqual(areas, ["architecture", "repository", "tests"]);
});

test("rejected entries carry the RejectedProposal shape", () => {
  const repo = tmpRepo();
  const { proposal } = makeProposalFixture(repo);
  writeTree(repo, makeProposalFixture(repo).files);

  const results = auditProposals({ proposals: [proposal, proposal], rejected: [] }, repo);

  assert.equal(results.rejected.length, 1);
  assert.deepEqual(Object.keys(results.rejected[0]!).sort(), ["area", "raw", "reason"]);
  assert.equal(typeof results.rejected[0]!.area, "string");
  assert.equal(typeof results.rejected[0]!.reason, "string");
  assert.equal(typeof results.rejected[0]!.raw, "string");
  assert.notEqual(results.rejected[0]!.area, undefined);
  assert.notEqual(results.rejected[0]!.reason, undefined);
  assert.notEqual(results.rejected[0]!.raw, undefined);
});

test("original proposal data is preserved verbatim for accepted proposals", () => {
  const repo = tmpRepo();
  writeTree(repo, makeProposalFixture(repo).files);
  const { proposal } = makeProposalFixture(repo);
  const original = JSON.parse(JSON.stringify(proposal));

  const results = auditProposals({ proposals: [proposal], rejected: [] }, repo);

  assert.deepEqual(results.proposals, [proposal]);
  assert.deepEqual(results.proposals[0]!, original);
});

test("the same input produces the same output (deterministic, no model)", () => {
  const repo = tmpRepo();
  writeTree(repo, makeProposalFixture(repo).files);
  const { proposal } = makeProposalFixture(repo);

  const first = auditProposals({ proposals: [proposal], rejected: [] }, repo);
  const second = auditProposals({ proposals: [proposal], rejected: [] }, repo);

  assert.deepEqual(first, second);
});

test("the whole deduplicated run is audited exactly once, not per area", () => {
  const repo = tmpRepo();
  writeTree(repo, makeProposalFixture(repo).files);
  const { proposal } = makeProposalFixture(repo);
  const duplicate = makeProposal({ ...proposal, title: "Add bounded queue with backpressure" });
  // A different title, same grounded claim, so it survives the audit and
  // proves the run is deduplicated globally rather than per area.
  const unrelated = makeProposal({ ...proposal, title: "Add a queue unit-test helper" });

  const results = auditProposals({ proposals: [proposal, duplicate, unrelated], rejected: [] }, repo);

  // Every proposal in the deduplicated set is audited exactly once: one
  // duplicate rejection (the second proposal shares proposal.title with the
  // first), and the unrelated proposal is accepted.
  assert.equal(results.proposals.length, 2);
  assert.equal(results.rejected.length, 1);
  assert.deepEqual(results.proposals.map((p) => p.title).sort(), [unrelated.title, proposal.title]);
});

test("coverage is found in tests the proposal never cited", () => {
  const repo = tmpRepo();
  writeTree(repo, {
    "src/queue.ts":
      "export class Queue {\n" +
      "  items: unknown[] = [];\n" +
      "  enqueue(item): void { this.items.push(item); }\n" +
      "  grows without limit and blocks producers;\n" +
      "  enqueue is the method producers call.\n" +
      "}\n" +
      "const maximum size with a wait signal so producers are not dropped silently.",
    "tests/queue.test.ts": "import { Queue } from '../src/queue';\ntest('queues items', () => { const q = new Queue(); q.enqueue(1); });\n// the Queue class has an enqueue method that pushes items without a limit",
    "tests/other.test.ts": "import { Queue } from '../src/queue';\ntest('queues items', () => { const q = new Queue(); q.enqueue(1); });\n// the Queue class has an enqueue method that pushes items without a limit",
  });
  // The proposal cites only the source file; the covering test is tests/queue.test.ts,
  // which it never referenced. The area comes from the evidence file path.
  const proposal = makeProposal({
    title: "Add bounded queue with backpressure",
    problem: "The queue grows without limit and blocks producers.",
    rationale: "Add a maximum size with a wait signal so producers are not dropped silently.",
    evidence: [{ file: "tests/queue.test.ts", symbol: "Queue", observation: "the Queue class has an enqueue method" }],
    approach: "Introduce a size cap and a blocking enqueue.",
    outcome: "Producers stall instead of dropping items.",
    priority: 1,
    complexity: "medium",
    verification: ["node --test tests/queue.test.ts"],
  });

  const results = auditProposals({ proposals: [proposal], rejected: [] }, repo);
  assert.equal(results.proposals.length, 0);
  assert.equal(results.rejected[0]!.area, "tests");
  assert.match(results.rejected[0]!.reason, /already covered/);
});

test("a proposal with no evidence is accepted as VALID (nothing to audit)", () => {
  const repo = tmpRepo();
  const proposal = makeProposal({
    title: "Ungrounded proposal",
    problem: "Something should happen.",
    rationale: "We need to investigate this further.",
    evidence: [],
    approach: "Look into it.",
    outcome: "We learn more.",
    priority: 1,
    complexity: "low",
    verification: ["node --test"],
  });

  const results = auditProposals({ proposals: [proposal], rejected: [] }, repo);
  assert.equal(results.proposals.length, 1);
  assert.equal(results.proposals[0]!.title, proposal.title);
  assert.equal(results.rejected.length, 0);
});

// ——— tests-area coverage detection must not reject on incidental vocabulary ———
// The coverage check used to reject a proposal when ANY single behaviour term
// appeared in ANY test file — including third-party test files under
// node_modules. A real test suite shares domain words ("queue", "planner")
// with unrelated proposals, so one shared term is not coverage evidence.

/** The proposal shared by the coverage tests: its behaviour terms are
 *  queue, grows, without, limit, blocks, producers, maximum, signal,
 *  dropped, silently — and the cited test file is a genuine project test. */
function coveredClaimProposal(evidenceFile: string, symbol: string, observation: string) {
  return makeProposal({
    title: "Add bounded queue with backpressure",
    problem: "The queue grows without limit and blocks producers.",
    rationale: "Add a maximum size with a wait signal so producers are not dropped silently.",
    evidence: [{ file: evidenceFile, symbol, observation }],
    approach: "Introduce a size cap and a blocking enqueue.",
    outcome: "Producers stall instead of dropping items.",
    priority: 1,
    complexity: "medium",
    verification: ["node --test tests/queue.test.ts"],
  });
}

/** The repo tree for the coverage tests: src/queue.ts states the claimed
 *  behaviour; tests/queue.test.ts is a genuine project test exercising it —
 *  it shares the terms queue, without and limit with the proposal, so the
 *  observation grounds in the file and coverage is real, not incidental. */
const coveredClaimFiles: Record<string, string> = {
  "src/queue.ts":
    "export class Queue {\n" +
    "  items: unknown[] = [];\n" +
    "  enqueue(item): void { this.items.push(item); }\n" +
    "  grows without limit and blocks producers;\n" +
    "  enqueue is the method producers call.\n" +
    "}\n" +
    "const maximum size with a wait signal so producers are not dropped silently.",
  "tests/queue.test.ts":
    "import { Queue } from '../src/queue';\n" +
    "test('queues items', () => { const q = new Queue(); q.enqueue(1); });\n" +
    "// the Queue class has an enqueue method that pushes items without a limit",
};

test("a single incidental term in a project test file does not reject a tests-area proposal", () => {
  const repo = tmpRepo();
  writeTree(repo, {
    "src/queue.ts":
      "export class Queue {\n" +
      "  items: unknown[] = [];\n" +
      "  enqueue(item): void { this.items.push(item); }\n" +
      "  grows without limit and blocks producers;\n" +
      "  enqueue is the method producers call.\n" +
      "}\n" +
      "const maximum size with a wait signal so producers are not dropped silently.",
    // the project's own test file shares exactly ONE behaviour term with the
    // proposal ("queue", via Queue/queues): that is incidental vocabulary, not
    // coverage of the claimed unbounded-growth behaviour
    "tests/queue.test.ts": "import { Queue } from '../src/queue';\ntest('queues items', () => { const q = new Queue(); q.enqueue(1); });",
  });

  const results = auditProposals(
    { proposals: [coveredClaimProposal("tests/queue.test.ts", "Queue", "queues items with enqueue")], rejected: [] },
    repo,
  );

  assert.equal(results.proposals.length, 1, "one shared term is not coverage evidence; the proposal must survive");
  assert.equal(results.rejected.length, 0);
});

test("genuine coverage in one project test file still rejects the proposal, naming the matched terms", () => {
  const repo = tmpRepo();
  writeTree(repo, coveredClaimFiles);

  const results = auditProposals(
    { proposals: [coveredClaimProposal("tests/queue.test.ts", "Queue", "the Queue class has an enqueue method")], rejected: [] },
    repo,
  );

  assert.equal(results.proposals.length, 0, "genuine coverage must still reject");
  assert.equal(results.rejected.length, 1);
  assert.equal(results.rejected[0]!.area, "tests");
  // the rejection names the coverage evidence: the behaviour terms the
  // covering file actually shares with the proposal, in proposal order
  assert.equal(results.rejected[0]!.reason, "already covered by an existing test (queue, without, limit)");
});

test("test files under dependency directories never provide coverage evidence", () => {
  const repo = tmpRepo();
  writeTree(repo, {
    "src/queue.ts":
      "export class Queue {\n" +
      "  items: unknown[] = [];\n" +
      "  enqueue(item): void { this.items.push(item); }\n" +
      "  grows without limit and blocks producers;\n" +
      "  enqueue is the method producers call.\n" +
      "}\n" +
      "const maximum size with a wait signal so producers are not dropped silently.",
    // a dependency's own test file matches MANY behaviour terms — under the
    // old unfiltered scan it alone rejected the proposal
    "node_modules/left-pad/test/grow.test.js": "test('it grows without limit and blocks producers', () => {});",
    // a genuine project test that shares no behaviour term with the proposal
    "tests/health.test.ts": "test('health probe returns ok', () => { expect(health).toBe('ok'); });",
  });

  const results = auditProposals(
    { proposals: [coveredClaimProposal("tests/health.test.ts", "health", "health probe returns ok")], rejected: [] },
    repo,
  );

  assert.equal(results.proposals.length, 1, "coverage must come from the project's own tests, never from node_modules");
  assert.equal(results.rejected.length, 0);
});

test("an unreadable directory under the repo does not crash the audit; coverage is still found", { skip: process.platform === "win32" ? "POSIX directory permissions only" : false }, () => {
  const repo = tmpRepo();
  writeTree(repo, coveredClaimFiles);
  const lockedDir = path.join(repo, "locked-dir");
  fs.mkdirSync(lockedDir);
  fs.writeFileSync(path.join(lockedDir, "grow.test.js"), "test('grows without limit');");
  fs.chmodSync(lockedDir, 0o000);
  try {
    const results = auditProposals(
      { proposals: [coveredClaimProposal("tests/queue.test.ts", "Queue", "the Queue class has an enqueue method")], rejected: [] },
      repo,
    );
    // the scan walked into the locked directory and survived; the genuine
    // project coverage in tests/queue.test.ts is still found
    assert.equal(results.proposals.length, 0);
    assert.match(results.rejected[0]!.reason, /already covered/);
    assert.equal(results.rejected[0]!.area, "tests");
  } finally {
    fs.chmodSync(lockedDir, 0o700);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

