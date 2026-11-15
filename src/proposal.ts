import fs from "node:fs";
import path from "node:path";

/**
 * A single unit of read-only evidence backing a proposal: a repository file
 * that was actually inspected, plus the symbol and observation.
 */
export interface ProposalEvidence {
  file: string;
  symbol?: string;
  observation: string;
}

export interface Proposal {
  title: string;
  problem: string;
  rationale: string;
  evidence: ProposalEvidence[];
  approach: string;
  outcome: string;
  priority: number;
  complexity: Complexity;
  risks?: string;
  verification: string[];
  dependencies?: string[];
}

export type Complexity = "low" | "medium" | "high";
export const COMPLEXITIES: readonly Complexity[] = ["low", "medium", "high"];

export interface ParsedProposals {
  items: unknown[];
  /** number of discovered JSON arrays/objects that could not be used */
  parseErrors: string[];
  /** how many balanced JSON segments the text contained at all — 0 means the
   * reply carried no JSON whatsoever (a distinct failure from "parsed but
   * unusable"), so callers can surface it instead of reporting silent success. */
  segments: number;
}

/** Bounded segment snippet embedded in parse errors so callers can see which text failed. */
function parseErrorText(message: string, segment: string): string {
  const snippet = segment.length > 160 ? `${segment.slice(0, 157)}...` : segment;
  return `malformed segment: ${message}; raw: ${snippet}`;
}

/**
 * Extract candidate JSON values from free-form model text. Handles fenced
 * ```json blocks, surrounding prose, wrapper objects like {"proposals": [...]},
 * and single proposal objects. Never throws on malformed input; reports what
 * could not be parsed.
 */
export function extractJsonCandidates(text: string): ParsedProposals {
  const items: unknown[] = [];
  const parseErrors: string[] = [];
  const arrays = collectBalancedSegments(text, "[");
  const objects = collectBalancedSegments(text, "{");
  // Objects nested inside an array segment are already yielded by the array
  // branch — parsing them again double-counts every element. Skip any object
  // whose span lies inside an array segment unconditionally, without parsing:
  // an element of a parseable array cannot be separately malformed, and an
  // unparseable array reports one parse error for the whole segment.
  const insideArray = new Set<number>();
  for (const array of arrays) {
    for (const object of objects) {
      if (object.start > array.start && object.end < array.end) {
        insideArray.add(object.start);
      }
    }
  }
  // Spans of proposal-shaped objects consumed as single items. Segments
  // strictly inside such an object — its evidence entries, verification
  // array, nested objects — are internal structure the enclosing proposal
  // already owns, not independent candidates. The wrapper branch and the
  // array branch do NOT take ownership this way: their double-report is the
  // pinned wrapper semantics.
  const consumedProposalSpans: SegmentSpan[] = [];
  // Left-to-right so an enclosing proposal-shaped object is consumed (and
  // takes ownership) before any segment nested inside it is considered.
  const segments = [...arrays, ...objects].sort((a, b) => a.start - b.start);
  for (const segment of segments) {
    if (insideArray.has(segment.start)) continue; // covered by the array's own parse
    if (consumedProposalSpans.some((s) => segment.start > s.start && segment.end < s.end)) continue;
    let value: unknown;
    try {
      value = JSON.parse(segment.text);
    } catch (err) {
      parseErrors.push(parseErrorText(`undecodable (${String(err).slice(0, 120)})`, segment.text));
      continue;
    }
    if (Array.isArray(value)) {
      items.push(...value);
    } else if (value !== null && typeof value === "object") {
      const wrapper = value as Record<string, unknown>;
      if (Array.isArray(wrapper["proposals"])) {
        items.push(...(wrapper["proposals"] as unknown[]));
      } else if (isProposalShaped(wrapper)) {
        items.push(value);
        consumedProposalSpans.push(segment);
      } else {
        parseErrors.push(parseErrorText("object without proposals array or proposal shape", segment.text));
      }
    } else {
      parseErrors.push(parseErrorText("JSON scalar ignored", segment.text));
    }
  }
  return { items, parseErrors, segments: arrays.length + objects.length };
}

function collectBalancedSegments(text: string, opener: "[" | "{"): SegmentSpan[] {
  const closer = opener === "[" ? "]" : "}";
  const segments: SegmentSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== opener) {
      i++;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let j = i;
    let closed = false;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) {
          closed = true;
          j++;
          break;
        }
      }
    }
    if (closed) {
      segments.push({ start: i, end: j, text: text.slice(i, j) });
      i = j;
    } else {
      i++;
    }
  }
  return segments;
}

export interface SegmentSpan {
  start: number;
  end: number;
  text: string;
}

export function isProposalShaped(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === "string" && Array.isArray(v.evidence);
}

export interface ValidatedProposal {
  ok: boolean;
  proposal?: Proposal;
  reason?: string;
}

const TITLE_MIN = 5;
const TITLE_MAX = 120;
const PROBLEM_MIN = 40;
const SENTENCE_MIN = 10;

function asField(value: unknown, field: string, min: number, max: number): { value?: string; error?: string } {
  if (typeof value !== "string") return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length < min) return { error: `${field} too short (min ${min})` };
  if (trimmed.length > max) return { error: `${field} too long (max ${max})` };
  return { value: trimmed };
}

const VAGUE_PATTERN = /\btbd\b|\blorem ipsum\b|\[insert\b|<=?\s*your\b|xxx/i;

/**
 * Validate one raw proposal against the discovery contract. Strict on vague
 * content and evidence: every evidence.file must resolve to an existing file
 * or directory inside repoDir.
 */
export function validateProposal(raw: unknown, repoDir: string): ValidatedProposal {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "proposal must be a JSON object" };
  }
  const v = raw as Record<string, unknown>;

  const title = asField(v.title, "title", TITLE_MIN, TITLE_MAX);
  if (title.error) return { ok: false, reason: title.error };

  const problem = asField(v.problem, "problem", PROBLEM_MIN, 4000);
  if (problem.error) return { ok: false, reason: problem.error };

  const rationale = asField(v.rationale, "rationale", SENTENCE_MIN, 2000);
  if (rationale.error) return { ok: false, reason: rationale.error };

  const approach = asField(v.approach, "approach", SENTENCE_MIN, 2000);
  if (approach.error) return { ok: false, reason: approach.error };

  const outcome = asField(v.outcome, "outcome", SENTENCE_MIN, 1000);
  if (outcome.error) return { ok: false, reason: outcome.error };

  if (typeof v.priority !== "number" || !Number.isInteger(v.priority) || v.priority < 0 || v.priority > 9) {
    return { ok: false, reason: "priority must be an integer 0-9" };
  }

  if (typeof v.complexity !== "string" || !COMPLEXITIES.includes(v.complexity as Complexity)) {
    return { ok: false, reason: `complexity must be one of ${COMPLEXILITIES()}` };
  }

  if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
    return { ok: false, reason: "evidence must be a non-empty array" };
  }
  const evidence: ProposalEvidence[] = [];
  for (const rawItem of v.evidence) {
    if (rawItem === null || typeof rawItem !== "object") {
      return { ok: false, reason: "each evidence item must be an object" };
    }
    const ev = rawItem as Record<string, unknown>;
    const file = typeof ev.file === "string" ? ev.file.trim() : "";
    if (file === "") return { ok: false, reason: "evidence.file must be a non-empty string" };
    if (!fileExistsInRepo(repoDir, file)) {
      return { ok: false, reason: `evidence file does not exist in repo: ${file}` };
    }
    const observation = asField(ev.observation, "evidence.observation", SENTENCE_MIN, 1000);
    if (observation.error) return { ok: false, reason: observation.error };
    evidence.push({
      file,
      symbol: typeof ev.symbol === "string" && ev.symbol.trim().length > 0 ? ev.symbol.trim() : undefined,
      observation: observation.value as string,
    });
  }

  if (!Array.isArray(v.verification) || v.verification.length === 0) {
    return { ok: false, reason: "verification must be a non-empty array of commands" };
  }
  const verification: string[] = [];
  for (const command of v.verification) {
    if (typeof command !== "string" || command.trim().length < 5) {
      return { ok: false, reason: "each verification command must be a string of at least 5 characters" };
    }
    verification.push(command.trim());
  }

  let dependencies: string[] | undefined;
  if (v.dependencies !== undefined) {
    if (!Array.isArray(v.dependencies)) return { ok: false, reason: "dependencies must be an array of task titles" };
    dependencies = v.dependencies
      .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
      .map((d) => d.trim());
    if (dependencies.length === 0) {
      return { ok: false, reason: "dependencies must contain at least one non-empty entry" };
    }
  }

  const risks = typeof v.risks === "string" && v.risks.trim().length > 0 ? v.risks.trim() : undefined;

  const vagueHit = VAGUE_PATTERN.exec(`${title.value} ${problem.value}`);
  if (vagueHit) return { ok: false, reason: `proposal contains placeholder/vague text ("${vagueHit[0]}")` };

  return {
    ok: true,
    proposal: {
      title: title.value as string,
      problem: problem.value as string,
      rationale: rationale.value as string,
      evidence,
      approach: approach.value as string,
      outcome: outcome.value as string,
      priority: v.priority,
      complexity: v.complexity as Complexity,
      risks,
      verification,
      dependencies,
    },
  };
}

function COMPLEXILITIES(): string {
  return COMPLEXITIES.join("|");
}

export function fileExistsInRepo(repoDir: string, file: string): boolean {
  const candidate = path.isAbsolute(file) ? file : path.join(repoDir, file);
  const resolved = path.resolve(candidate);
  if (!isInsideRepo(resolved, path.resolve(repoDir))) {
    return false;
  }
  try {
    if (!fs.existsSync(resolved)) return false;
    // The lexical path is inside the repo, but a symlink could still point
    // outside it: re-check the real path against the repo's real path.
    return isInsideRepo(fs.realpathSync(resolved), fs.realpathSync(path.resolve(repoDir)));
  } catch {
    return false;
  }
}

function isInsideRepo(resolved: string, repoDir: string): boolean {
  return resolved === repoDir || resolved.startsWith(repoDir + path.sep);
}

const STOPWORDS = new Set([
  "and", "the", "for", "with", "that", "this", "from", "into", "not", "are", "its",
  "when", "use", "nor", "but", "yet", "any", "all", "has", "have", "will",
  "should", "would", "could", "add", "improve", "improving", "fix", "issue", "task",
]);

export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t.toLowerCase())),
  );
}

export function titleSimilarity(a: string, b: string): number {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return shared / union;
}

export const DUPLICATE_THRESHOLD = 0.7;

export function isDuplicateTitle(candidate: string, titles: Iterable<string>): boolean {
  for (const t of titles) {
    if (titleSimilarity(candidate, t) >= DUPLICATE_THRESHOLD) return true;
  }
  return false;
}
