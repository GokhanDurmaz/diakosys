import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OpenCodeAdapter, OpenCodePromptResult } from "./opencode.ts";
import type { LifecycleLevel, LifecycleEvent } from "./lifecycle.ts";
import { withWriteTx } from "./tx.ts";
import { coordinatorGuardTxn, type CoordinatorAuthority } from "./locks.ts";
import {
  extractJsonCandidates,
  fileExistsInRepo,
  titleSimilarity,
  validateProposal,
  type Proposal,
} from "./proposal.ts";
import { DUPLICATE_THRESHOLD } from "./proposal.ts";

/**
 * The model-facing agent used for discovery.
 * undefined = opencode default agent: its system prompt still produces the
 * final JSON deliverable, while read-only enforcement comes from
 * DISCOVERY_TOOLS (every state-changing tool is hard-denied below).
 */
export const DISCOVERY_AGENT: string | undefined = undefined;
/**
 * Tool config for discovery prompts: only `read` is enabled. Everything else
 * that can act, spawn agents, search the web or burn model rounds is
 * hard-denied. grep/glob/skill are denied on purpose: live probes on the MiMo
 * model showed each tool round costing a full reasoning turn (~17 s), and with
 * a targeted per-area manifest (see DiscoveryArea.manifestPriority) reading
 * specific manifest files is both cheaper and better evidence than search
 * rounds. This narrows read-only enforcement — it does not weaken it.
 */
export const DISCOVERY_TOOLS: Record<string, boolean> = {
  read: true,
  grep: false,
  glob: false,
  skill: false,
  bash: false,
  edit: false,
  write: false,
  patch: false,
  apply_patch: false,
  multiedit: false,
  task: false,
  webfetch: false,
  websearch: false,
  question: false,
  execute: false,
};

/**
 * Spawn-config overrides that make the discovery adapter's `opencode serve`
 * read-only (v2 wire — see DISCOVERY_TOOLS for the v1 per-prompt contract).
 *
 * Verified against opencode 2.2.6 by live probes (2026-11-13):
 *   * Session-level `permissions` (SessionCreateInput / SessionUpdateInput)
 *     are accepted by the API but NOT enforced by the server — a session
 *     created (or updated) with edit/bash/write denies still ran the shell
 *     tool and wrote the file.
 *   * Config-level `permission` denies DO enforce: with `shell`/`write` etc.
 *     denied, those tools vanish from the model's toolset entirely. This is
     the only effective v2 mechanism, and the spawned server is the right
 *     scope: each adapter instance spawns its own serve process, so denying
 *     here never touches the task-runner server.
 *   * `question` must be denied as well — with the acting tools gone the
 *     model called `question`, which stalls a serve-mode session waiting for
 *     a client reply that never comes (the same class of hang this file
 *     exists to prevent). `execute` (Code Mode) cannot reach the filesystem
 *     but burns model turns probing for an escape hatch, so it is denied too.
 *     `skill` was observed as a wasted round in a live probe; grep/glob are
 *     denied because every search round is pure latency next to a targeted
 *     per-area manifest — one `read` per evidence file is enough.
 *
 * Specific keys override the `"*"` wildcard (verified: with `"*": "allow"`
 * plus specific denies, the denied tools disappeared while read kept
 * working). Only `read` stays allowed.
 */
export const DISCOVERY_SERVER_CONFIG: Record<string, unknown> = {
  permission: {
    "*": "allow",
    shell: "deny",
    bash: "deny",
    edit: "deny",
    write: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    question: "deny",
    execute: "deny",
    skill: "deny",
    grep: "deny",
    glob: "deny",
  },
};

export interface DiscoveryArea {
  key: string;
  focus: string;
  /**
   * Optional repo-relative path prefixes that rank ahead of everything else in
   * this area's manifest (first matching prefix wins; unmatched files keep
   * their generic order). Lets a targeted area spend its manifest budget on
   * relevant sources instead of a broad repository listing.
   */
  manifestPriority?: string[];
  /**
   * Optional manifest cap for this area only, overriding the engine's
   * manifestLimit. A smaller, focused manifest shrinks the prompt the model
   * re-reads on every agent round.
   */
  manifestLimit?: number;
  /**
   * Optional per-area file-inspection budget, overriding the default 3-file
   * cap in the instruction. Fewer inspection rounds = fewer model turns.
   */
  toolBudget?: number;
}

export const DISCOVERY_AREAS: readonly DiscoveryArea[] = [
  { key: "architecture", focus: "Source code structure and architecture: module boundaries, layering violations, unclear ownership." },
  {
    key: "reliability",
    focus: "Potential bugs and reliability issues: unhandled edge cases, resource leaks, error swallowing.",
    // Reliability findings live in production behaviour, so the manifest leads
    // with src/main (java AND resources — thresholds/config count) and is
    // capped tighter than the generic 220: a smaller prompt is re-read on
    // every agent round, and compiled/test/docs noise never crowds it out
    // (bin/ and target/ are excluded from every manifest — see SKIP_DIRS).
    manifestPriority: ["src/main/"],
    manifestLimit: 120,
    // Each avoided read round saves a full model turn (reasoning model:
    // prefill + thinking per round). The targeted manifest makes 2 reads
    // enough to ground the evidence.
    toolBudget: 2,
  },
  { key: "tests", focus: "Missing or weak test coverage: untested public behavior, brittle tests, missing edge-case tests." },
  { key: "quality", focus: "Code quality and technical debt: duplication, dead code, misleading comments, naming." },
  { key: "performance", focus: "Performance opportunities: unbounded data structures, repeated computation, needless allocation." },
  { key: "usability", focus: "TUI usability and presentation: confusing states, missing feedback, cramped layouts." },
  { key: "docs", focus: "Documentation inconsistencies: stale README claims, docs contradicting actual behavior." },
  { key: "build", focus: "Build and configuration problems: fragile build scripts, config drift, dependency risks." },
];

export interface RejectedProposal {
  area: string;
  reason: string;
  raw: string;
}

export interface DiscoveryEvidence {
  file: string;
  symbol?: string;
  observation: string;
}

export interface EvidenceAreaReport {
  area: string;
  ok: boolean;
  files: number;
  missing: string[];
}

export interface EvidenceReport {
  areas: EvidenceAreaReport[];
  missingFiles: string[];
}

export interface AreaResult {
  area: string;
  status: "ok" | "error";
  error?: string;
  proposals: Proposal[];
  rejected: RejectedProposal[];
  evidence: DiscoveryEvidence[];
}

export interface DiscoveryResult {
  runId?: string;
  areas: AreaResult[];
  proposals: Proposal[];
  rejected: RejectedProposal[];
  persisted: boolean;
  /** read-only evidence collected from accepted proposals in this run */
  evidence: EvidenceReport;
}

export interface DiscoveryOptions {
  repoDir: string;
  model: string;
  dryRun?: boolean;
  areas?: string[];
  /** directory holding the resumable discovery-run manifest */
  cacheDir?: string;
  maxProposalsPerArea: number;
  promptTimeoutMs: number;
  manifestLimit?: number;
  /**
   * Per-area progress callback, invoked (synchronously, in area order) right
   * before each area's model prompt starts. The CLI uses it to report that
   * work is happening — without it a slow model run looks like a frozen
   * process for the entire prompt timeout.
   */
  onAreaStart?: (area: string, index: number, total: number) => void;
  /**
   * Optional real-time lifecycle observer (display side channel only: never
   * persisted, never changes engine behaviour). Emits discovery start/complete,
   * per-area start/complete, model-request pending/complete, parse outcome,
   * accepted/rejected counts and persistence outcome. Never exposes prompts,
   * credentials or raw model responses. Reserved event keys in `extra` are
   * stripped by the logger so they don't echo the line's own columns.
   */
  onLifecycle?: (ev: LifecycleEvent) => void;
}

/** Evidence backing accepted proposals: file + symbol + what was observed. */
export function collectEvidence(result: DiscoveryResult, repoDir: string): EvidenceReport {
  const areas: EvidenceAreaReport[] = [];
  const missingFiles: string[] = [];
  const reported = new Set<string>();
  for (const area of result.areas) {
    if (area.status !== "ok") continue;
    const files = new Set<string>();
    for (const proposal of area.proposals) {
      for (const evidence of proposal.evidence) {
        files.add(evidence.file);
      }
    }
    // missing files are per-area: an unresolved file in one area must never
    // mark another area (or its missing list) as not-ok
    const missing: string[] = [];
    for (const file of files) {
      if (!fileExistsInRepo(repoDir, file)) missing.push(file);
    }
    for (const file of missing) {
      if (!reported.has(file)) {
        reported.add(file);
        missingFiles.push(file);
      }
    }
    areas.push({ area: area.area, ok: missing.length === 0, files: files.size, missing });
  }
  return { areas, missingFiles };
}

/**
 * Where the resumable-run manifest lives. Kept outside the analysed
 * repository so a discovery run never pollutes the code it is inspecting.
 */
export function defaultCacheDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, "Cache", "diakosys-orchestrator");
}

// proposal.ts owns the canonical implementation (exported, symlink-safe).
// Re-exported here so discovery consumers get the same semantics without a
// second copy of the check.
export { fileExistsInRepo };

export function repoManifest(repoDir: string, limit = 220, priority?: string[]): string {
  const files: string[] = [];
  const roots = ["src", "config", "docs", "."];
  for (const root of roots) {
    const absRoot = path.join(repoDir, root);
    if (!fs.existsSync(absRoot)) continue;
    walk(absRoot, repoDir, files, { count: 0 });
  }
  const unique = Array.from(new Set(files));
  const rank = rankerFor(priority);
  const sorted = unique
    .sort((a, b) => rank(a) - rank(b) || sortFilesForManifest(a, b))
    .slice(0, limit);
  return sorted.join("\n");
}

/**
 * Area keyword tables used by `selectFilesForArea`. Each area maps its focus
 * onto the repository paths that actually carry that signal. The tables are
 * the only per-area knowledge, so adding a new area is adding one entry here
 * — no other code needs to change.
 *
 * Reliability is the only area with a keyword table today: it is the area
 * that timed out, and its signal (failure handling, error paths, resource
 * lifecycle, test coverage) is spread across many small files, so keyword
 * ranking beats a broad listing. Every other area falls back to the generic
 * manifest.
 */
export const AREA_KEYWORDS: Record<string, readonly string[]> = {
  reliability: [
    "test", "fail", "error", "assert", "check", "exception", "catch", "try", "throw",
    "timeout", "leak", "close", "dispose", "shutdown", "retry", "race", "thread",
    "volatile", "synchronized", "lock", "mutex", "semaphore", "countdown",
    "overflow", "underflow", "nan", "cancel", "interrupt", "rollback", "commit",
    "transaction", "buffer", "empty", "boundary", "edge", "invalid", "null",
  ],
};

export interface SourceEvidence {
  /** repository-relative path — the proposal must cite this exact path */
  file: string;
  /** 1-based line number of the first line of the excerpt */
  line: number;
  /** the excerpt itself, with its trailing line number kept */
  excerpt: string;
}

/**
 * Keyword-based, area-aware file selection. Returns repository-relative
 * paths, ranked most-relevant-first, sliced to `limit`.
 *
 * For an area with a keyword table: files whose *content* matches at least one
 * keyword are ranked ahead of everything else; the rest of the listing is
 * filled by the area's manifest priority (production code first). For areas
 * without a table the behaviour is the generic manifest, so the mechanism is a
 * strict superset of the old selection — nothing is lost for non-targeted
 * areas.
 */
export function selectFilesForArea(repoDir: string, area: DiscoveryArea, limit: number): string[] {
  const roots = ["src", "config", "docs", "."];
  // `walk` collects repository-relative path strings — the single representation
  // every manifest shares — so scoring happens after the walk, keyed by path,
  // reading each file once from its repo-relative location.
  const files: string[] = [];
  const skipped: { count: number } = { count: 0 };
  for (const root of roots) {
    const absRoot = path.join(repoDir, root);
    if (!fs.existsSync(absRoot)) continue;
    walk(absRoot, repoDir, files, skipped);
  }
  const keywordTable = AREA_KEYWORDS[area.key];
  const scores = new Map<string, number>();
  if (keywordTable !== undefined) {
    for (const file of files) {
      if (scores.has(file)) continue;
      let score = 0;
      try {
        const text = fs.readFileSync(path.join(repoDir, file), "utf8");
        score = keywordTable.some((kw) => text.includes(kw)) ? 1 : 0;
      } catch {
        score = 0; // a vanished or unreadable file keeps the priority ordering
      }
      scores.set(file, score);
    }
  }
  // Rank: keyword matches ahead of everything else, then the area's manifest
  // priority (production code first), then the generic manifest order — so an
  // area without a keyword table degenerates to exactly the generic manifest.
  const rank = rankerFor(area.manifestPriority);
  const unique = Array.from(new Set(files));
  unique.sort((a, b) =>
    (scores.get(b) ?? 0) - (scores.get(a) ?? 0)
    || rank(a) - rank(b)
    || sortFilesForManifest(a, b),
  );
  return unique.slice(0, Math.max(1, limit));
}

/**
 * Reads the selected files and extracts bounded, relevant source excerpts.
 *
 * Only lines that carry the area's signal are kept, so the prompt carries
 * evidence rather than a manifest. The total excerpt size is hard-capped
 * (`MAX_SOURCE_EXCERPT_CHARS`) — a reasoning model re-reads the whole prompt
 * on every round, so an unbounded excerpt budget would re-introduce the exact
 * cost that made reliability discovery time out.
 *
 * Excerpts are never invented: every excerpt is a verbatim slice of the file
 * it cites, with the file's real repository-relative path and real line
 * numbers, so a proposal's evidence is checkable against the source.
 */
export function extractSourceEvidence(repoDir: string, area: DiscoveryArea, files: string[]): SourceEvidence[] {
  const keywordTable = AREA_KEYWORDS[area.key];
  const excerpts: SourceEvidence[] = [];
  for (const file of files) {
    const abs = path.join(repoDir, file);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const lines = text.split("\n");
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (keywordTable !== undefined && keywordTable.some((kw) => line.includes(kw))) hits.push(i);
      else if (keywordTable === undefined && line.trim() !== "") hits.push(i);
    }
    if (hits.length === 0) continue;
    // keep the keyword's neighbourhood: ±2 lines around each hit, merged
    const start = Math.max(0, hits[0]! - 2);
    const end = Math.min(lines.length - 1, hits[hits.length - 1]! + 2);
    const snippet = lines.slice(start, end + 1).join("\n");
    if (snippet.length > 1200) continue; // per-file cap, see MAX_SOURCE_EXCERPT_CHARS
    excerpts.push({ file, line: start + 1, excerpt: snippet });
  }
  return excerpts;
}

/** Hard cap on the source evidence embedded in a prompt (chars, whole prompt). */
export const MAX_SOURCE_EXCERPT_CHARS = 24_000;

/**
 * Renders the selected evidence into the prompt as a bounded block.
 *
 * The block accompanies the repository manifest (which lists the selected
 * paths): the excerpts carry the real symbols and line-level observations the
 * model grounds its proposals in, while the manifest stays the map of the
 * files this run actually inspected. An empty selection renders no block —
 * the caller omits it, because an excerpt-less listing would only add noise.
 */
export function renderSourceEvidenceBlock(excerpts: SourceEvidence[]): string {
  const body = excerpts.map((e) => {
    const excerpt = e.excerpt.replace(/\n$/, "");
    return [
      `SOURCE: ${e.file} (line ${e.line})`,
      excerpt,
      "",
    ].join("\n");
  }).join("\n");
  if (body.length > MAX_SOURCE_EXCERPT_CHARS) {
    const tail = body.slice(body.length - 200);
    return [
      `SOURCE: ${excerpts.length} selected files (total ${body.length} chars, over the ${MAX_SOURCE_EXCERPT_CHARS} cap — trimming tail evidence):`,
      body.slice(0, MAX_SOURCE_EXCERPT_CHARS),
      "\n...[excerpt truncated by the orchestrator at the size cap]",
      tail,
      "",
    ].join("\n");
  }
  return [
    `SOURCE: ${excerpts.length} selected files (total ${body.length} chars):`,
    body,
    "",
  ].join("\n");
}

/**
 * Bounded (≤160 chars) snippet of an item that failed validation, so the
 * operator sees the offending model output — the actual object or scalar —
 * instead of only its title (or "<untitled>"), without dumping the whole
 * response.
 */
function itemSnippet(item: unknown): string {
  let text: string;
  if (typeof item === "string") {
    text = item;
  } else {
    try {
      text = JSON.stringify(item) ?? String(item);
    } catch {
      text = String(item);
    }
  }
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * Turns optional path-prefix priorities into a rank function: the first
 * matching prefix wins, unmatched files rank after every listed prefix. With
 * no priorities every file ranks 0, so the sort degenerates to
 * `sortFilesForManifest` — identical ordering to the unprioritized manifest.
 */
function rankerFor(priority?: string[]): (file: string) => number {
  if (priority === undefined || priority.length === 0) return () => 0;
  return (file) => {
    const index = priority.findIndex((prefix) => file.startsWith(prefix));
    return index === -1 ? priority.length : index;
  };
}

/**
 * How many entries the manifest walked, how many survived deduplication and
 * the file cap, and how many were skipped by deduplication, the cap or the
 * walk cap (SKIP_DIRS files never enter `entries` at all and are not counted).
 */
export function repoManifestStats(repoDir: string, limit = 220): {
  total: number;
  included: number;
  skipped: number;
  dedupSkipped: number;
  capSkipped: number;
  walkSkipped: number;
} {
  const entries: string[] = [];
  const skipped: { count: number } = { count: 0 };
  const roots = ["src", "config", "docs", "."];
  for (const root of roots) {
    const absRoot = path.join(repoDir, root);
    if (!fs.existsSync(absRoot)) continue;
    walk(absRoot, repoDir, entries, skipped);
  }
  const unique = Array.from(new Set(entries));
  const manifestLines = limit < 0 ? unique.length : Math.min(limit, unique.length);
  return {
    total: entries.length,
    included: manifestLines,
    skipped: entries.length - manifestLines,
    dedupSkipped: entries.length - unique.length,
    capSkipped: unique.length - manifestLines,
    walkSkipped: skipped.count,
  };
}

function sortFilesForManifest(a: string, b: string): number {
  const aMain = a.startsWith("src/main");
  const bMain = b.startsWith("src/main");
  if (aMain !== bMain) return aMain ? -1 : 1;
  return a.localeCompare(b);
}

// Eclipse's `bin` (compiled .class output), Maven/Gradle `target` and the other
// generated directories are pure noise for a source manifest: on the diakosys repo
// they were 143 of 220 manifest entries, crowding real sources out of the cap.
const SKIP_DIRS = new Set([".git", "bin", "target", "build", ".gradle", "node_modules", "dist", ".idea", ".settings", "orchestrator"]);

/** Walks a root, honouring SKIP_DIRS and the 4000-entry walk cap (shared `out`). */
function walk(dir: string, repoDir: string, out: string[], skipped: { count: number }): void {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(repoDir, abs);
    if (entry.isDirectory()) {
      walk(abs, repoDir, out, skipped);
    } else if (out.length < 4000) {
      out.push(rel);
    } else {
      skipped.count += 1;
    }
  }
}

export function areaInstruction(area: DiscoveryArea, maxProposals: number, manifest: string, evidence?: string): string {
  const toolBudget = area.toolBudget ?? 3;
  // Targeted areas get a scope note so the model reasons from the focused
  // listing instead of asking for (disabled) search tools.
  const scopeNote = area.manifestPriority === undefined || area.manifestPriority.length === 0
    ? undefined
    : `Manifest scope: for the ${area.key} area the listing is targeted — files under ${area.manifestPriority.join(", ")} come first and unrelated files only fill remaining space. Base your analysis on these files; broader exploration tools are disabled.`;
  return [
    "=== DISCOVERY PROTOCOL (READ-ONLY) ===",
    "You are a read-only repository analyst. STRICT RULES:",
    "- Do not edit, create or delete any file.",
    "- Do not run any shell command (bash tool is disabled).",
    "- Do not run git or any state-changing operation.",
    "Use only the read tool against this repository (grep/glob and every other tool are disabled).",
    `- Use it sparingly: inspect at most ${toolBudget} files and only when the manifest is truly insufficient.`,
    "- Prefer reasoning directly from the manifest. Produce the JSON array in ONE response as soon as it is accurate.",
    "",
    `Area: ${area.key}`,
    `Focus: ${area.focus}`,
    "",
    "Report possible improvement tasks for THIS AREA ONLY as a JSON array. Do not invent issues:",
    "every claim must cite repository evidence you actually inspected with a tool.",
    "Each array element must be a JSON object with exactly these fields, in the shape of this example:",
    `{"title": "Guard executeNext against negative batch sizes", "problem": "A negative --max drains zero tasks and the round completes silently without progress.", "rationale": "Silent no-ops hide coordinator stalls from the operator.", "evidence": [{"file": "src/queue.ts", "symbol": "executeNext", "observation": "the limit is used without a sign check"}], "approach": "Validate the limit before the drain loop and fail loudly.", "outcome": "Invalid invocations are rejected with a clear error.", "priority": 2, "complexity": "low", "risks": "May surface previously hidden caller bugs.", "verification": ["node --test tests/queue.test.ts"], "dependencies": []}`,
    "",
    `Field constraints: "title" 5-120 chars; "problem" at least 40 concrete chars; "priority" an`,
    `integer 0-9; "complexity" one of "low"|"medium"|"high"; "evidence" one or more entries;`,
    `"dependencies" an array of titles of tasks this one depends on (omit the field or use []`,
    `when there are none). The file paths in the example are illustrative only.`,
    "",
    `"verification" is REQUIRED and must be a non-empty JSON array of concrete, runnable`,
    `command strings for THIS repository (e.g. "node --test tests/queue.test.ts" — this project's`,
    `real test command from package.json). It must never be a single string,`,
    `an empty array, or prose: validation rejects any proposal whose "verification" is`,
    `missing, empty, or not an array of command strings — such a proposal cannot become`,
    `a task. Commands need not exist yet, but must be executable as written against the`,
    `repository's real build system.`,
    "",
    `Every "evidence.file" must be a repository-relative path that appears in the manifest or in`,
    `the SOURCE excerpts below — never invent or extrapolate a path: validation rejects any`,
    `proposal citing a file that does not exist in the repository.`,
    "",
    `Provide at most ${maxProposals} proposals — the strongest ones only.`,
    "If the area yields nothing worth proposing, return [].",
    "Your reply MUST be ONLY the JSON array — no markdown, no prose, no code fences.",
    ...(scopeNote === undefined ? [] : ["", scopeNote]),
    // pre-extracted source excerpts (bounded), rendered before the manifest so
    // the manifest section below stays a pure path-per-line listing
    ...(evidence === undefined ? [] : ["", evidence]),
    "",
    "Repository file manifest (paths relative to repo root):",
    manifest,
  ].join("\n");
}

/** Aggregates raw adapter errors so tests can exercise model-failure paths. */
export class DiscoveryEngine {
  private adapter: OpenCodeAdapter;
  private readonly options: DiscoveryOptions;

  constructor(adapter: OpenCodeAdapter, options: DiscoveryOptions) {
    this.adapter = adapter;
    this.options = options;
  }

  /** Directory holding this engine's resumable-run manifest: an explicit
   * `cacheDir` option, or the home-based default used by run()/persist(). */
  get cacheDir(): string {
    return this.options.cacheDir ?? defaultCacheDir();
  }

  /** Emit a lifecycle event to the optional observer; no-op when absent. */
  private lifecycle(level: LifecycleLevel, stage: string, event: string, extra: Record<string, unknown> = {}): void {
    this.options.onLifecycle?.({
      level,
      operation: "discover",
      stage,
      event,
      ...extra,
    });
  }

  async run(): Promise<DiscoveryResult> {
    this.lifecycle("INFO", "run", "started", {
      areas: selectAreas(this.options.areas).length,
      dryRun: this.options.dryRun === true,
    });
    const startedAt = Date.now();
    const areas = selectAreas(this.options.areas);
    const allProposals: Proposal[] = [];
    const allRejected: RejectedProposal[] = [];
    const areaResults: AreaResult[] = [];

    for (const [index, area] of areas.entries()) {
      this.options.onAreaStart?.(area.key, index + 1, areas.length);
      const result = await this.runArea(area, areas.length);
      areaResults.push(result);
      allProposals.push(...result.proposals);
      allRejected.push(...result.rejected);
    }
    // cross-area dedupe keeps the first (higher-priority-first within area) occurrence
    const kept: Proposal[] = [];
    const keptTitles: string[] = [];
    const seenPrimary = new Set<string>();
    for (const proposal of allProposals) {
      const primary = primaryFileOf(proposal);
      if (primary !== undefined && seenPrimary.has(primary)) {
        allRejected.push({ area: "cross-area", reason: `duplicate primary file ${primary} in this run`, raw: proposal.title });
        continue;
      }
      if (keptTitles.some((t) => titleSimilarity(t, proposal.title) >= DUPLICATE_THRESHOLD)) {
        allRejected.push({ area: "cross-area", reason: "duplicate of an earlier proposal in this run", raw: proposal.title });
        continue;
      }
      kept.push(proposal);
      keptTitles.push(proposal.title);
      if (primary !== undefined) seenPrimary.add(primary);
    }

    const result: DiscoveryResult = {
      areas: areaResults,
      proposals: kept.slice(0, this.options.maxProposalsPerArea * areas.length),
      rejected: allRejected,
      persisted: false,
      evidence: { areas: [], missingFiles: [] },
    };
    result.evidence = collectEvidence(result, this.options.repoDir);
    // a dry run must not touch persistent state: the CLI reports "nothing
    // was persisted" for dry runs
    result.persisted = this.options.dryRun === true
      ? false
      : await this.persist(result, this.options.cacheDir ?? defaultCacheDir());
    this.lifecycle("INFO", "run", "completed", {
      areas: areas.length,
      proposals: result.proposals.length,
      rejected: result.rejected.length,
      persisted: result.persisted,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  /**
   * Write this run's accepted proposals + evidence to the resumable-run
   * manifest so a crashed process can pick the run back up.
   */
  async persist(result: DiscoveryResult, cacheDir: string): Promise<boolean> {
    const startedAt = Date.now();
    this.lifecycle("INFO", "persist", "started", { cacheDir });
    try {
      const dir = path.join(cacheDir, "discovery-runs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "runs.json");
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + "\n");
      fs.renameSync(tmp, file);
      this.lifecycle("INFO", "persist", "completed", { persisted: true, durationMs: Date.now() - startedAt });
      return true;
    } catch {
      this.lifecycle("ERROR", "persist", "error", { cacheDir, persisted: false, error: "runs.json write failed" });
      return false;
    }
  }

  /**
   * Run one area end to end: evidence collection → read-only model prompt →
   * JSON parse/validation → accepted/rejected split. The model receives
   * pre-extracted source excerpts, so every repository
   * fact in a proposal is traceable to a file this run actually read; only
   * `read` stays enabled (DISCOVERY_TOOLS, enforced end to end by
   * DISCOVERY_SERVER_CONFIG).
   */
  private async runArea(area: DiscoveryArea, total: number): Promise<AreaResult> {
    const areaStartedAt = Date.now();
    this.lifecycle("INFO", "area", "started", { areaId: area.key, total });
    // Evidence is prepared deterministically by the orchestrator, not by the
    // model: the model receives pre-extracted source excerpts, so every
    // repository fact in a proposal is traceable to a file this run actually
    // read.
    // Per-area manifest cap: a targeted area's own limit wins, then the
    // engine-level limit, then the generic 220.
    const files = selectFilesForArea(this.options.repoDir, area, area.manifestLimit ?? this.options.manifestLimit ?? 220);
    const excerpts = extractSourceEvidence(this.options.repoDir, area, files);
    const evidenceBlock = excerpts.length === 0 ? undefined : renderSourceEvidenceBlock(excerpts);
    const prompt = areaInstruction(area, this.options.maxProposalsPerArea, files.join("\n"), evidenceBlock);
    this.lifecycle("INFO", "model-request", "pending", { areaId: area.key, total });
    let response: OpenCodePromptResult;
    try {
      response = await this.adapter.prompt({
        title: `Discovery: ${area.key}`,
        description: prompt,
        directory: this.options.repoDir,
        agent: DISCOVERY_AGENT,
        // The v1 per-prompt tool contract (DISCOVERY_TOOLS): only `read` is
        // enabled — the pre-extracted evidence block makes reads rare, and
        // every acting, network or searching tool is hard-denied so the model
        // cannot burn rounds on them. The v2 spawned server enforces the same
        // contract at the permission layer (DISCOVERY_SERVER_CONFIG); prompt
        // text alone is never the permission boundary.
        tools: DISCOVERY_TOOLS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lifecycle("ERROR", "model-request", "error", { areaId: area.key, error: message });
      this.lifecycle("INFO", "area", "completed", {
        areaId: area.key,
        status: "error",
        proposals: 0,
        rejected: 0,
        durationMs: Date.now() - areaStartedAt,
      });
      return {
        area: area.key,
        status: "error",
        error: message,
        proposals: [],
        rejected: [],
        evidence: [],
      };
    }
    this.lifecycle("INFO", "model-request", "completed", {
      areaId: area.key,
      durationMs: Date.now() - areaStartedAt,
    });
    const { items, parseErrors, segments, truncated } = extractJsonCandidates(response.text);
    const rejected: RejectedProposal[] = parseErrors.map((reason) => ({ area: area.key, reason, raw: reason }));
    // A plausible truncated-JSON tail (the reply was cut off mid-array or
    // mid-object, e.g. by the model server's output limit) is reported with
    // the finish reason, even when other balanced segments parsed alongside
    // it — a cut deliverable must never look like a clean partial result.
    // Ordinary prose with unmatched brackets never reaches this branch: the
    // tail detector only fires on JSON-shaped syntax.
    if (truncated.length > 0) {
      rejected.push({
        area: area.key,
        reason: `possibly truncated JSON in the model reply (${response.text.trim().length} chars, finish=${response.finish})`,
        raw: truncated[0]!.replace(/\s+/g, " "),
      });
    }
    // A reply with no JSON at all (no parseable proposals, no parse errors and
    // no JSON segments) must never silently become an "ok" result with 0
    // proposals and 0 rejections. The clearest symptom: the model spent its
    // turn calling state-changing tools and ended with finish=tool-calls and
    // an empty text reply (or hid its findings in a written file), so the
    // operator must see what actually came back instead of an apparently
    // successful no-op.
    // A valid empty JSON array ("[]", bare or prose-wrapped) is the legitimate
    // "nothing worth proposing" reply: it parses, so segments > 0 and it must
    // NOT surface as a no-JSON diagnostic — only a reply without any JSON
    // segment is one. A truncated tail is its own diagnostic above.
    if (items.length === 0 && parseErrors.length === 0 && segments === 0 && truncated.length === 0) {
      const reply = response.text.trim();
      rejected.push({
        area: area.key,
        reason:
          reply.length === 0
            ? `no JSON in the model reply (empty text, finish=${response.finish})`
            : `no JSON in the model reply (${response.text.length} chars, finish=${response.finish})`,
        raw: reply.length === 0 ? response.finish : reply.replace(/\s+/g, " ").slice(0, 120),
      });
    }
    const accepted: Proposal[] = [];
    // The adapter may return many candidates; only the top (priority-first)
    // ones matter. Scanning cap+5 instead of the cap keeps the slice cheap and
    // lets a few low-priority items through the per-area cap, but anything
    // beyond cap+5 is silently dropped with no rejection entry — it was never
    // inspected, so it must not be reported as a model rejection.
    for (const item of items.slice(0, this.options.maxProposalsPerArea + 5)) {
      const validated = validateProposal(item, this.options.repoDir);
      if (!validated.ok || validated.proposal === undefined) {
        rejected.push({
          area: area.key,
          reason: validated.reason ?? "unknown validation failure",
          raw: itemSnippet(item),
        });
        continue;
      }
      accepted.push(validated.proposal);
      if (accepted.length >= this.options.maxProposalsPerArea) break;
    }
    this.lifecycle("INFO", "parse", "completed", {
      areaId: area.key,
      accepted: accepted.length,
      rejected: rejected.length,
      durationMs: Date.now() - areaStartedAt,
    });
    this.lifecycle("INFO", "area", "completed", {
      areaId: area.key,
      status: "ok",
      proposals: accepted.length,
      rejected: rejected.length,
      durationMs: Date.now() - areaStartedAt,
    });
    return { area: area.key, status: "ok", proposals: accepted, rejected, evidence: accepted.flatMap((p) => p.evidence) };
  }
}

export function primaryFileOf(proposal: Proposal): string | undefined {
  return proposal.evidence[0]?.file;
}

/**
 * Normalises a requested area list into the keys of the known discovery
 * areas. Unknown entries are kept so callers can report them.
 */
export function requestedAreaKeys(requested?: string | string[]): { keys: string[]; unknown: string[] } {
  if (requested === undefined || requested === "") return { keys: [], unknown: [] };
  const items = Array.isArray(requested) ? requested : requested.split(",");
  const keys: string[] = [];
  const unknown: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (key.length === 0) continue;
    if (DISCOVERY_AREAS.some((a) => a.key === key)) keys.push(key);
    else unknown.push(item.trim());
  }
  return { keys, unknown };
}

/**
 * Validates a requested area list against the known discovery areas. Throws
 * for unknown areas. This is the validation entry point for CLI entry points,
 * which can report the error and exit. `selectAreas` itself never throws —
 * unknown areas fall back to all areas so library callers never fail on an
 * unexpected input.
 */
export function validateRequestedAreas(requested?: string | string[]): void {
  const { unknown } = requestedAreaKeys(requested);
  if (unknown.length > 0) {
    throw new Error(`unknown discovery area(s): ${unknown.join(", ")}; valid: ${DISCOVERY_AREAS.map((a) => a.key).join(", ")}`);
  }
}

function capAreas(areas: DiscoveryArea[], maxAreas?: number): DiscoveryArea[] {
  if (maxAreas === undefined) return areas;
  return areas.slice(0, Math.max(1, Math.min(maxAreas, areas.length)));
}

export function selectAreas(requested?: string | string[], maxAreas?: number): DiscoveryArea[] {
  if (requested === undefined || requested === "") return capAreas([...DISCOVERY_AREAS], maxAreas);
  const { keys, unknown } = requestedAreaKeys(requested);
  if (keys.length === 0) return capAreas([...DISCOVERY_AREAS], maxAreas);
  let selected = DISCOVERY_AREAS.filter((a) => keys.includes(a.key));
  // unknown areas fall back to all areas rather than failing the caller
  if (unknown.length > 0) return capAreas([...DISCOVERY_AREAS], maxAreas);
  if (maxAreas !== undefined) selected = selected.slice(0, Math.max(1, Math.min(maxAreas, selected.length)));
  return selected.length > 0 ? selected : [...DISCOVERY_AREAS];
}

export interface DiscoveryRunRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "completed" | "failed" | "interrupted";
  areasTotal: number;
  areasCompleted: number;
  rawProposals: number;
  accepted: number;
  rejected: number;
  error: string | null;
  model: string | null;
}

/** Report of one explicit discovery-run recovery pass. */
export interface DiscoveryRecoveryReport {
  /** runs this pass flipped to 'interrupted' (confirmed recovery only) */
  interrupted: number;
  /**
   * 'running' rows this pass left untouched. Discovery-run rows carry no
   * lease, so nothing proves a run is dead; each pending row needs explicit
   * operator confirmation before it is interrupted.
   */
  pending: { id: string; cause: string }[];
}

/** discovery_runs persistence: interruption-safe (stale 'running' rows on restart). */
export class DiscoveryRunStore {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Explicit coordinator-authorized recovery of discovery runs left 'running'
   * by a crashed process. Never runs implicitly on store open — the
   * instance-lock holder calls it (e.g. `orchestrator recover`).
   *
   * Discovery-run rows carry no lease, so nothing inside the database proves a
   * run is dead the way an expired task lease does: every 'running' row is a
   * legacy no-lease row. Interruption therefore requires explicit operator
   * confirmation (`confirmed: true`; `--confirm-unsafe` on the CLI). Without
   * confirmation the pass is a read-only report of the rows it would flip.
   *
   * Atomic: the coordinator guard and every mutation share one write
   * transaction, so a disowned coordinator aborts with no state change.
   * Idempotent: interrupted runs are no longer 'running', so repeated passes
   * find nothing left to do.
   */
  recoverInterruptedRuns(
    authority: CoordinatorAuthority,
    options?: { confirmed?: boolean },
  ): DiscoveryRecoveryReport {
    return withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      const running = this.listRunsByStatus("running");
      if (running.length === 0) return { interrupted: 0, pending: [] };
      if (options?.confirmed !== true) {
        return {
          interrupted: 0,
          pending: running.map((run) => ({
            id: run.id,
            cause: "no lease recorded — operator confirmation required (--confirm-unsafe)",
          })),
        };
      }
      const updated = this.db
        .prepare(
          "UPDATE discovery_runs SET status = 'interrupted', error = COALESCE(error, 'process exited while run was active') WHERE status = 'running'",
        )
        .run();
      return { interrupted: Number(updated.changes), pending: [] };
    });
  }

  /** camelCase run records for one status column value (empty when none). */
  private listRunsByStatus(status: DiscoveryRunRecord["status"]): DiscoveryRunRecord[] {
    return this.listRuns().filter((run) => run.status === status);
  }

  start(areas: DiscoveryArea[], model: string, authority: CoordinatorAuthority): string {
    const id = `disc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      this.db
        .prepare(
          `INSERT INTO discovery_runs (id, started_at, status, areas_total, areas_completed, error, model)
           VALUES (?, ?, 'running', ?, 0, NULL, ?)`,
        )
        .run(id, tx.now(), areas.length, model);
    });
    return id;
  }

  /**
   * Mark a running run complete. `error` records partial area failures while
   * the run itself finished its lifecycle; status stays `completed`.
   * Only a `running` row transitions: an already-terminal run (failed via
   * `fail()` or interrupted by a crash) is never resurrected.
   */
  complete(
    id: string,
    counts: { areasCompleted: number; rawProposals: number; accepted: number; rejected: number },
    authority: CoordinatorAuthority,
    error?: string,
  ): void {
    withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      this.db
        .prepare(
          `UPDATE discovery_runs
           SET status='completed', finished_at=?, areas_completed=?, raw_proposals=?, accepted=?, rejected=?, error=?
           WHERE id=? AND status='running'`,
        )
        .run(
          tx.now(),
          counts.areasCompleted,
          counts.rawProposals,
          counts.accepted,
          counts.rejected,
          error === undefined || error.length === 0 ? null : error.slice(0, 2000),
          id,
        );
    });
  }

  fail(id: string, error: string, authority: CoordinatorAuthority): void {
    withWriteTx(this.db, (tx) => {
      coordinatorGuardTxn(this.db, tx, authority.owner, authority.generation, authority.lockTtlMs);
      this.db
        .prepare(
          "UPDATE discovery_runs SET status='failed', finished_at=?, error=? WHERE id=? AND status='running'",
        )
        .run(tx.now(), error.slice(0, 2000), id);
    });
  }

  statusOf(id: string): "running" | "completed" | "failed" | "interrupted" {
    const row = this.db.prepare("SELECT status FROM discovery_runs WHERE id = ?").get(id);
    return row === undefined ? "interrupted" : (row.status as "running" | "completed" | "failed" | "interrupted");
  }

  areaCountOf(id: string): number {
    return Number(this.db.prepare("SELECT areas_completed FROM discovery_runs WHERE id = ?").get(id)?.areas_completed ?? 0);
  }

  errorOf(id: string): string | null {
    const row = this.db.prepare("SELECT error FROM discovery_runs WHERE id = ?").get(id);
    const error = row === undefined ? null : (row as { error: string | null }).error;
    return error === null || error === undefined ? null : String(error);
  }

  listRuns(): DiscoveryRunRecord[] {
    return this.db
      .prepare(
        `SELECT id,
                started_at      AS "startedAt",
                finished_at     AS "finishedAt",
                status,
                areas_total     AS "areasTotal",
                areas_completed AS "areasCompleted",
                raw_proposals   AS "rawProposals",
                accepted,
                rejected,
                error,
                model
         FROM discovery_runs
         ORDER BY finished_at DESC NULLS LAST, started_at DESC`,
      )
      .all() as unknown as DiscoveryRunRecord[];
  }

  latestRun(): DiscoveryRunRecord | undefined {
    const rows = this.listRuns();
    return rows.length > 0 ? rows[0] : undefined;
  }

  countRuns(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS c FROM discovery_runs").get()?.c ?? 0);
  }

  runsByStatus(): Record<"running" | "completed" | "failed" | "interrupted", number> {
    const counts: Record<"running" | "completed" | "failed" | "interrupted", number> = { running: 0, completed: 0, failed: 0, interrupted: 0 };
    for (const row of this.listRuns()) {
      counts[row.status] += 1;
    }
    return counts;
  }

  /**
   * Append this run to the resumable manifest. Returns false when the write
   * fails (read-only repo, missing cache dir, etc.) — the run is simply not
   * persisted and `persisted` reflects that.
   * @deprecated use `DiscoveryEngine.persist(result, cacheDir)` instead — this
   * byte-identical copy exists only for API stability; nothing in the
   * orchestrator calls it.
   */
  persist(engineResult: DiscoveryResult, cacheDir: string): boolean {
    try {
      const dir = path.join(cacheDir, "discovery-runs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "runs.json");
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(engineResult, null, 2) + "\n");
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }
}
