/**
 * Proposal Auditor — deterministic, read-only, filesystem-only verification
 * stage for discovery proposals.
 *
 * The auditor never calls a model, never spawns an agent, and never writes to
 * the repository. It answers one question per proposal: is the claim in the
 * proposal supported by concrete evidence in the repository?
 *
 * What the auditor CAN establish (filesystem-grounded only):
 *   * a cited file is readable and a cited symbol appears in it;
 *   * an observation's key terms are present in the file it cites;
 *   * a claimed behaviour's terms are shared with an existing project test
 *     file (already covered: at least two behaviour terms in one test file —
 *     a single shared term is incidental vocabulary, not coverage);
 *   * two proposals in one run describe the same behavior (duplicate/overlap).
 * What it CANNOT establish (and therefore never claims):
 *   * whether a test would pass once written;
 *   * whether a design decision is the best one;
 *   * anything about a file it was not shown (no model reads).
 *
 * Verdicts are execution-local: they are merged into the run's `rejected`
 * channel and are never persisted.
 */

import fs from "node:fs";
import path from "node:path";

import { SKIP_DIRS } from "./discovery.ts";
import type { RejectedProposal } from "./discovery.ts";
import type { Proposal } from "./proposal.ts";

export type Verdict = "VALID" | "PARTIALLY_VALID" | "INVALID";

export interface AuditFinding {
  file: string;
  line?: number;
  observation: string;
}

export interface AuditResult {
  verdict: Verdict;
  area: string;
  reason: string;
  findings: AuditFinding[];
}

/**
 * Audit the globally deduplicated proposal set exactly once. Audit rejections
 * are merged into the run's existing `rejected` channel; nothing is persisted.
 */
export function auditProposals(result: { proposals: Proposal[]; rejected: RejectedProposal[] }, repoDir: string): { proposals: Proposal[]; rejected: RejectedProposal[] } {
  const seen = new Set<string>();
  const proposals: Proposal[] = [];
  const auditRejected: RejectedProposal[] = [];
  for (const proposal of result.proposals) {
    const audit = auditProposal(proposal, repoDir, seen);
    if (audit.verdict === "INVALID" || audit.verdict === "PARTIALLY_VALID") {
      auditRejected.push({
        area: audit.area,
        reason: audit.reason,
        raw: proposal.title,
      });
    } else {
      proposals.push(proposal);
    }
  }
  // Audit rejections are appended to the engine's own `rejected` channel, which
  // already carries rejections from proposal validation — the two channels are
  // both printed and neither is persisted.
  return { proposals, rejected: [...result.rejected, ...auditRejected] };
}

/**
 * Decide the verdict for one proposal against the whole deduplicated set.
 *
 * Order of checks (first failure wins):
 *   1. evidence integrity — cited files readable, cited symbols present,
 *      observations grounded in the file they cite;
 *   2. coverage verification — for tests-area claims, is the behaviour
 *      already exercised by an existing test file?
 *   3. claim grounding — is the claimed behaviour present in the cited
 *      source? (catches speculative claims)
 *   4. duplicates — same behaviour as another proposal in the run. A
 *      duplicate is PARTIALLY_VALID: the claim is evidence-supported, but
 *      creating a task for it would duplicate work already queued.
 */
function auditProposal(proposal: Proposal, repoDir: string, seen: Set<string>): AuditResult {
  const findings: AuditFinding[] = [];
  const evidence = proposal.evidence;
  const area = areaFromPath(evidence[0]?.file ?? "");
  const files = evidence.map((e) => e.file);
  const contents = new Map<string, string>();
  for (const file of files) {
    const text = readFileText(repoDir, file);
    if (text === undefined) {
      return { verdict: "INVALID", area, reason: `evidence file unreadable: ${file}`, findings: [{ file, observation: "read failed" }] };
    }
    contents.set(file, text);
  }

  // 1. evidence integrity
  for (const e of evidence) {
    const symbol = e.symbol;
    const text = contents.get(e.file) ?? "";
    if (symbol !== undefined && !containsIdentifier(text, symbol)) {
      findings.push({ file: e.file, observation: `symbol "${symbol}" not found in file` });
      return { verdict: "INVALID", area, reason: `evidence symbol "${symbol}" does not appear in ${e.file}`, findings };
    }
    if (!groundedIn(text, e.observation)) {
      findings.push({ file: e.file, observation: "observation terms not found in file" });
      return { verdict: "INVALID", area, reason: `observation in ${e.file} is not supported by the file's contents`, findings };
    }
  }

  // 2. coverage verification (tests area: is the claimed behaviour already tested?)
  const covered = area === "tests" ? checkAlreadyCovered(proposal, repoDir) : undefined;
  if (covered !== undefined) {
    findings.push({ file: covered.file, observation: covered.observation });
    return { verdict: "INVALID", area, reason: covered.reason, findings };
  }

  // 3. claim grounding: the claimed behaviour must exist in the cited source
  const source = findSourceFile(evidence);
  if (source !== undefined && !groundedIn(contents.get(source) ?? "", proposal.problem)) {
    findings.push({ file: source, observation: "claimed behaviour terms not found in source" });
    return {
      verdict: "INVALID",
      area,
      reason: `claimed behaviour in ${proposal.problem.slice(0, 120)} is not present in ${source}`,
      findings,
    };
  }

  // 4. duplicates across the whole run
  const key = `${area}:${proposal.title}`;
  if (seen.has(key)) {
    findings.push({ file: source ?? evidence[0]?.file ?? "", observation: "duplicate title" });
    return {
      verdict: "PARTIALLY_VALID",
      area,
      reason: `duplicates an earlier proposal in this run (area ${area}); evidence-supported but redundant`,
      findings,
    };
  }
  seen.add(key);
  return { verdict: "VALID", area, reason: "evidence-supported gap confirmed, no duplicate found", findings };
}
/**
 * For a tests-area proposal, is the claimed behaviour already exercised by an
 * existing test file? Returns the covering test location, or undefined when
 * no coverage was found. The scan covers the whole repository, not just the
 * files the proposal cited — a test it never referenced may still cover the
 * claim. Dependency and generated directories (node_modules, dist, target, …
 * — discovery's SKIP_DIRS) are excluded: coverage evidence must come from the
 * project's own tests, not from vendored content. The file list is memoized
 * so it is computed once per run.
 */
const testFileCache = new Map<string, string[]>();
function testFilesInRepo(repoDir: string): string[] {
  if (testFileCache.has(repoDir)) return testFileCache.get(repoDir) ?? [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is skipped, never fatal to the audit
    }
    for (const entry of entries) {
      // hidden and dependency/generated directories never carry project
      // coverage; skip them entirely (same rationale as discovery's walk)
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // only plain files are candidates: an unreadable or non-regular entry
      // must never reach readFileText (a FIFO read would block, a directory
      // read would throw)
      else if (entry.isFile() && isTestFile(full)) files.push(full);
    }
  };
  walk(repoDir);
  testFileCache.set(repoDir, files);
  return files;
}

/** Extract the behaviour terms a proposal claims, e.g. "retry", "timeout", "edge case". */
function behaviourTerms(proposal: Proposal): string[] {
  const body = `${proposal.problem} ${proposal.rationale}`;
  const words = body.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const stop = new Set(["and", "the", "for", "with", "that", "this", "from", "into", "not", "are", "its", "when", "use", "nor", "but", "yet", "any", "all", "has", "have", "will", "should", "would", "could", "add", "improve", "improving", "fix", "issue", "task", "test", "tests", "coverage"]);
  const terms = new Set<string>();
  for (const word of words) {
    if (word.length >= 5 && !stop.has(word)) terms.add(word);
  }
  return [...terms].slice(0, 12);
}

/** Does the test file exercise any of the claimed behaviour terms? */
function findCoveredBehaviour(text: string, problem: string): string | undefined {
  const terms = behaviourTerms({ problem, rationale: "" } as Proposal);
  if (terms.length === 0) return undefined;
  for (const term of terms) {
    if (text.toLowerCase().includes(term)) return term;
  }
  return undefined;
}

/** Read a repository file as text. Returns undefined when it is missing or unreadable. */
function readFileText(repoDir: string, file: string): string | undefined {
  const resolved = path.isAbsolute(file) ? file : path.join(repoDir, file);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return undefined;
  }
}

/** Does the file contain the identifier (case-insensitive)? */
function containsIdentifier(text: string, symbol: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "i");
  return pattern.test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Are the observation's key terms present in the file's text? */
function groundedIn(text: string, observation: string): boolean {
  const terms = observation
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 4 && !isStopword(t));
  if (terms.length === 0) return true; // vague observations are not a ground for rejection
  return terms.every((term) => text.toLowerCase().includes(term));
}

function isStopword(word: string): boolean {
  return new Set(["and", "the", "for", "with", "that", "this", "from", "into", "not", "are", "its", "when", "use", "nor", "but", "yet", "any", "all", "has", "have", "will", "should", "would", "could", "add", "improve", "improving", "fix", "issue", "task", "test", "tests", "coverage"]).has(word);
}

/** Is the file a test file? */
function isTestFile(file: string): boolean {
  const base = path.basename(file);
  return base.endsWith(".test.ts") || base.endsWith(".test.js") || base.endsWith(".test.tsx");
}

/** The first evidence file that looks like production source, for claim grounding. */
function findSourceFile(evidence: { file: string }[]): string | undefined {
  for (const e of evidence) {
    if (!path.basename(e.file).endsWith(".test.ts") && !path.basename(e.file).endsWith(".test.js") && !path.basename(e.file).endsWith(".test.tsx")) {
      return e.file;
    }
  }
  return undefined;
}

/** Derive the discovery area for a rejection from the proposal's evidence path. */
function areaFromPath(file: string): string {
  const dir = path.basename(path.dirname(file));
  if (dir === "tests" || dir === "test") return "tests";
  if (dir === "src") return "architecture";
  return "repository";
}

/**
 * For a tests-area proposal, is the claimed behaviour already exercised by an
 * existing test file? Returns the covering test location, or undefined when
 * no coverage was found. The scan covers the whole repository, not just the
 * files the proposal cited — a test it never referenced may still cover the
 * claim. A file only counts as covering when at least TWO distinct behaviour
 * terms appear in it: a single shared term is incidental vocabulary that any
 * real test suite shares with unrelated proposals, not evidence that the
 * claimed behaviour is exercised. The file list is memoized so it is computed
 * once per run.
 */
function checkAlreadyCovered(proposal: Proposal, repoDir: string): { file: string; observation: string; reason: string } | undefined {
  const terms = behaviourTerms(proposal);
  if (terms.length === 0) return undefined;
  const testFiles = testFilesInRepo(repoDir);
  for (const testFile of testFiles) {
    const text = readFileText(repoDir, testFile) ?? "";
    const lower = text.toLowerCase();
    // matched keeps behaviourTerms' order, so the reason lists the terms in
    // the proposal's own order — the coverage evidence is the terms
    // themselves, named so the rejection is checkable against the file.
    const matched = terms.filter((term) => lower.includes(term));
    if (matched.length >= 2) {
      return {
        file: testFile,
        observation: matched.join(", "),
        reason: `already covered by an existing test (${matched.join(", ")})`,
      };
    }
  }
  return undefined;
}
