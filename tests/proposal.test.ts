import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractJsonCandidates,
  isDuplicateTitle,
  titleSimilarity,
  validateProposal,
  fileExistsInRepo,
} from "../src/proposal.ts";
import { makeProposal } from "./helpers.ts";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-prop-"));
  fs.mkdirSync(path.join(dir, "src/main/java/io/diakosys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/main/java/io/diakosys/HealthEvaluator.java"), "class HealthEvaluator {}");
  return dir;
}

test("extraction handles fenced arrays, prose wrapping and wrapper objects", () => {
  const fenced = "```json\n[{\"title\":\"a b c d e\"}]\n```\n";
  assert.equal(extractJsonCandidates(fenced).items.length, 1);

  const prose = 'Here are my findings:\n[{"title":"a b c d e"},{"title":"f g h i j"}]\nDone.';
  assert.equal(extractJsonCandidates(prose).items.length, 2);

  const wrapper = '{"proposals":[{"title":"a b c d e","evidence":[]}]}';
  assert.equal(extractJsonCandidates(wrapper).items.length, 2);
  assert.strictEqual(
    extractJsonCandidates(wrapper).items.filter((i) => typeof i === "object" && (i as Record<string, unknown>).title === "a b c d e").length,
    2,
  );

  const single = '{"title":"a b c d e","evidence":[]}';
  assert.equal(extractJsonCandidates(single).items.length, 1);
});

test("extraction does not double-count array elements", () => {
  const two = '[{"title":"one","evidence":[]},{"title":"two","evidence":[]}]';
  assert.equal(extractJsonCandidates(two).items.length, 2);
  assert.deepEqual(
    extractJsonCandidates(two).items.map((i) => (i as { title?: string }).title),
    ["one", "two"],
  );

  // A wrapper yields each proposal once from the array and once from the
  // wrapper branch — that is the pinned semantics.
  const wrapper = '{"proposals":[{"title":"one","evidence":[]},{"title":"two","evidence":[]}]}'
    ;
  assert.equal(extractJsonCandidates(wrapper).items.length, 4);

  const single = '[{"title":"one","evidence":[]}]';
  assert.equal(extractJsonCandidates(single).items.length, 1);
});

test("extraction reports malformed segments instead of throwing", () => {
  const messy = 'Intent: {"title":"oops", broken [ {"title":"good item 1"} ] trailing';
  const { items, parseErrors } = extractJsonCandidates(messy);
  assert.equal(items.length, 1);
  // Previously 1: the array element was yielded as an item AND re-reported as
  // a parse error ("object without proposals array or proposal shape"). With
  // array-internal segments skipped without re-parsing, the element counts
  // once and nothing else in this text forms a decodable-but-unusable segment.
  assert.strictEqual(parseErrors.length, 0);
  assert.strictEqual(extractJsonCandidates("no json at all").items.length, 0);
  assert.strictEqual(extractJsonCandidates("unbalanced [{").items.length, 0);
});

test("extraction reports a JSON scalar value as a parse error", () => {
  // A scalar nested inside an array is model noise and is filtered out —
  // it must never reach proposal validation as a false candidate.
  assert.equal(extractJsonCandidates('[12345]').items.length, 0);
  assert.equal(extractJsonCandidates('[12345]').parseErrors.length, 0);
  // A scalar used where an object is expected is an undecodable segment.
  assert.equal(extractJsonCandidates('{"a": 12345}').items.length, 0);
  assert.equal(extractJsonCandidates('{"a": 12345}').parseErrors.length, 1);
});

test("malformed arrays never throw and report one undecodable parse error", () => {
  for (const text of ['[{oops:1, evidence:[]}]', '[{"title":"x",bad}]']) {
    const { items, parseErrors } = extractJsonCandidates(text);
    assert.equal(items.length, 0, text);
    assert.ok(parseErrors.length >= 1, text);
    assert.ok(parseErrors.every((e) => e.includes("undecodable")), text);
  }
});

test("valid array elements are not re-reported as parse errors", () => {
  const shaped = '[{"title":"a b c d e"}]';
  const one = extractJsonCandidates(shaped);
  assert.equal(one.items.length, 1);
  assert.equal(one.parseErrors.length, 0);

  // Scalar elements are filtered before validation; only the object survives.
  const scalars = '[1,{"title":"x b c d e"},2]';
  const two = extractJsonCandidates(scalars);
  assert.deepEqual(two.items, [{ title: "x b c d e" }]);
  assert.equal(two.parseErrors.length, 0);
});

test("prose brackets are never candidates: [from] alongside a valid array", () => {
  // Live MiMo regression: explanatory prose with bracketed words ([from]) used
  // to surface as "malformed segment" rejections next to the real proposals.
  const text = 'The evidence comes [from] the manifest, [note: check] so:\n[{"title":"a b c d e","evidence":[]}]\nDone.';
  const { items, parseErrors, segments, truncated } = extractJsonCandidates(text);
  assert.deepEqual(items.map((i) => (i as { title?: string }).title), ["a b c d e"]);
  assert.equal(parseErrors.length, 0, "prose brackets produce no diagnostic noise");
  assert.equal(segments, 2, "the wrapper array and its nested object are counted separately");
  assert.deepEqual(truncated, []);
});

test("a numeric prose bracket creates no false proposal", () => {
  // [1] parses as a one-element number array; its scalar element is filtered
  // instead of flowing into validation as an unvalidatable item.
  const { items, parseErrors, truncated } = extractJsonCandidates("see step [1] and [2] for details, also [from tests]");
  assert.equal(items.length, 0);
  assert.equal(parseErrors.length, 0);
  assert.deepEqual(truncated, []);
});

test("scalar elements inside a valid array are filtered before validation", () => {
  const { items, parseErrors } = extractJsonCandidates('["from", 1, {"title":"x b c d e","evidence":[]}, true, null]');
  assert.deepEqual(items, [{ title: "x b c d e", evidence: [] }]);
  assert.equal(parseErrors.length, 0);
});

test("a truncated JSON tail is detected with and without balanced junk elsewhere", () => {
  // Plain truncation mid-array: the deliverable was cut off.
  const plain = extractJsonCandidates('[{"title": "cut off here');
  assert.equal(plain.truncated.length, 1);
  assert.match(plain.truncated[0]!, /^\[\{"title": "cut off here$/);
  assert.equal(plain.items.length, 0);
  assert.equal(plain.parseErrors.length, 0);

  // Balanced junk + truncated deliverable: the cut is still detected and the
  // junk neither becomes a proposal nor produces a rejection.
  const withJunk = extractJsonCandidates('see step [1] and [from docs], then: [{"title": "cut');
  assert.equal(withJunk.truncated.length, 1);
  assert.match(withJunk.truncated[0]!, /\[\{"title": "cut$/);
  assert.equal(withJunk.items.length, 0, "junk never becomes a proposal");

  // Mid-object truncation.
  const obj = extractJsonCandidates('{"problem": "the reply was cut before the object closed');
  assert.equal(obj.truncated.length, 1);

  // A markdown-fenced, complete array is not truncation.
  const fenced = extractJsonCandidates('```json\n[{"title":"a b c d e","evidence":[]}]\n```\n');
  assert.deepEqual(fenced.truncated, []);
  assert.equal(fenced.items.length, 1);
});

test("ordinary prose with unmatched brackets never reports truncation", () => {
  assert.deepEqual(extractJsonCandidates("see [note about {things").truncated, []);
  assert.deepEqual(extractJsonCandidates('say "hello [world').truncated, []);
  assert.deepEqual(extractJsonCandidates("see [1").truncated, []);
  assert.deepEqual(extractJsonCandidates("see [from").truncated, []);
  // Those texts carry no JSON at all: segments stays 0 so the engine's
  // no-JSON diagnostic remains armed instead of the reply counting as JSON.
  assert.equal(extractJsonCandidates("see [note about {things").segments, 0);
});

function bareProposalText(title: string, evidenceEntries: number): string {
  return JSON.stringify({
    title,
    problem: "HealthEvaluator treats non-finite system CPU samples as OK today.",
    rationale: "Silent forgetting of corrupt samples hides real problems.",
    evidence: Array.from({ length: evidenceEntries }, (_, i) => ({
      file: `src/main/java/io/diakosys/F${i}.java`,
      observation: "observed condition here",
    })),
    approach: "Mirror the process-CPU isFinite guard there.",
    outcome: "Non-finite samples are skipped, not reported.",
    priority: 6,
    complexity: "low",
    verification: ["./gradlew test --tests 'io.diakosys.domain.health.*'"],
  });
}

test("a bare proposal's evidence entries are suppressed, yielding exactly one item", () => {
  const { items, parseErrors } = extractJsonCandidates(bareProposalText("Guard evaluator against NaN samples", 6));
  assert.equal(parseErrors.length, 0);
  assert.equal(items.length, 1);
  assert.equal((items[0] as { title?: string }).title, "Guard evaluator against NaN samples");
});

test("a capped scan window holds only the real proposal (junk cannot flood the window)", () => {
  // discovery.ts scans items.slice(0, maxProposalsPerArea + 5); the bare
  // proposal must occupy item slot 0 so the cap+5 window cannot push it out.
  const { items } = extractJsonCandidates(bareProposalText("Guard evaluator against NaN samples", 6));
  const window = items.slice(0, 1 + 5);
  assert.equal(window.length, 1);
  assert.equal((window[0] as { title?: string }).title, "Guard evaluator against NaN samples");
});

test("sequential bare proposals are each counted exactly once, in order", () => {
  const text = `${bareProposalText("first proposal b c", 2)} prose gap ${bareProposalText("second proof ee", 3)}`;
  const { items, parseErrors } = extractJsonCandidates(text);
  assert.equal(parseErrors.length, 0);
  assert.deepEqual(
    items.map((i) => (i as { title?: string }).title),
    ["first proposal b c", "second proof ee"],
  );
});

test("wrapper semantics stay 4-for-2 when suppression is active", () => {
  const text = `${'{"proposals":[{"title":"one","evidence":[]},{"title":"two","evidence":[]}]}'} plus ${bareProposalText("third one b c", 2)}`;
  const { items, parseErrors } = extractJsonCandidates(text);
  assert.equal(parseErrors.length, 0);
  assert.equal(items.length, 4 + 1);
  assert.equal(items.filter((i) => (i as { title?: string }).title === "third one b c").length, 1);
});

test("mixed malformed spans around a suppressing proposal never throw or distort items", () => {
  // Stray brackets around a consumed bare proposal: its internal evidence and
  // verification arrays must stay suppressed and nothing may throw. (Semi-
  // overlapping segments require malformed bracket soup: the balanced scanners
  // can only produce spans that nest strictly or sit apart around a decodable
  // suppressor, so a valid proposal's internal segments are always strictly
  // inside its span.)
  const text = `${bareProposalText("Guard evaluator against NaN samples", 2)} ] stray ] [`;
  const { items } = extractJsonCandidates(text);
  assert.deepEqual(
    items.map((i) => (i as { title?: string }).title),
    ["Guard evaluator against NaN samples"],
  );
});

test("validation accepts a fully specified proposal", () => {
  const repo = tmpRepo();
  try {
    const validated = validateProposal(makeProposal(), repo);
    assert.equal(validated.ok, true);
    assert.equal(validated.proposal?.priority, 6);
    assert.equal(validated.proposal?.complexity, "low");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("verification contract: a real command array is accepted verbatim", () => {
  const repo = tmpRepo();
  try {
    const commands = ["./gradlew test --tests io.diakosys.infrastructure.jvm.JmxThreadCollectorTest"];
    const validated = validateProposal(makeProposal({ verification: commands }), repo);
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.proposal?.verification, commands);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("verification contract: a bare-string verification (live MiMo run regression) is rejected", () => {
  const repo = tmpRepo();
  try {
    // observed live: the model emitted "verification": "<single command>" —
    // the validator must keep rejecting anything that is not an array
    const bareString = makeProposal({
      verification: "Run: ./gradlew test --tests io.diakosys.infrastructure.jvm.JmxThreadCollectorDeadlockTest" as unknown as string[],
    });
    const rejected = validateProposal(bareString, repo);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason ?? "", /verification must be a non-empty array/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("validation requires evidence files that exist in the repository", () => {
  const repo = tmpRepo();
  try {
    const missing = validateProposal(
      makeProposal({ evidence: [{ file: "src/main/java/io/diakosys/DoesNotExist.java", observation: "something observed here" }] }),
      repo,
    );
    assert.equal(missing.ok, false);
    assert.match(missing.reason ?? "", /does not exist/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("validation rejects evidence paths escaping the repo", () => {
  const repo = tmpRepo();
  try {
    const escape = validateProposal(
      makeProposal({ evidence: [{ file: "../../etc/hosts", observation: "observed thing here" }] }),
      repo,
    );
    assert.equal(escape.ok, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("validation rejects incomplete or vague proposals", () => {
  const repo = tmpRepo();
  try {
    const cases: Array<[unknown, RegExp]> = [
      [makeProposal({ title: "x" }), /title too short/],
      [makeProposal({ problem: "too short" }), /problem too short/],
      [makeProposal({ evidence: [] }), /evidence must be a non-empty array/],
      [makeProposal({ verification: [] }), /verification must be a non-empty array/],
      [makeProposal({ verification: undefined as unknown as string[] }), /verification must be a non-empty array/],
      [makeProposal({ verification: ["no"] }), /each verification command must be a string of at least 5 characters/],
      [makeProposal({ verification: [42 as unknown as string] }), /each verification command must be a string of at least 5 characters/],
      [makeProposal({ priority: 3.5 }), /priority must be an integer/],
      [makeProposal({ priority: 11 }), /priority must be an integer/],
      [makeProposal({ complexity: "trivial" as never }), /complexity must be one of/],
      ["just a string", /must be a JSON object/],
      [null, /must be a JSON object/],
      [
        makeProposal({
          title: "Refactor TBD sampler logic pipeline",
          problem: "some sufficiently long problem text that should be fine",
        }),
        /placeholder\/vague text/,
      ],
    ];
    for (const [raw, expected] of cases) {
      const v = validateProposal(raw, repo);
      assert.equal(v.ok, false, JSON.stringify(raw).slice(0, 60));
      assert.match(v.reason ?? "", expected);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("file existence accepts absolute paths inside the repo", () => {
  const repo = tmpRepo();
  try {
    assert.ok(fileExistsInRepo(repo, path.join(repo, "src/main/java/io/diakosys/HealthEvaluator.java")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("duplicate detection uses token similarity", () => {
  assert.ok(titleSimilarity("Guard evaluator against NaN CPU samples", "Guard evaluator against NaN CPU samples") === 1);
  assert.ok(
    titleSimilarity(
      "Guard HealthEvaluator against non-finite system CPU samples",
      "Guard HealthEvaluator against non-finite CPU samples",
    ) >= 0.7,
  );
  assert.ok(titleSimilarity("Cache database connections", "Handle file watcher events") < 0.7);
  assert.equal(isDuplicateTitle("Guard evaluator against NaN samples", ["Guard evaluator against NaN CPU samples"]), true);
  assert.equal(isDuplicateTitle("Cache database connections", ["Handle file watcher events"]), false);
});
