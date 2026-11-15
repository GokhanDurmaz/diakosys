import type { DatabaseSync } from "node:sqlite";
import {
  validateProposal,
  isProposalShaped,
  isDuplicateTitle,
  titleSimilarity,
  COMPLEXITIES,
  type Proposal,
  type ValidatedProposal,
} from "./proposal.ts";
import { primaryFileOf } from "./discovery.ts";
import { TaskStore } from "./store.ts";
import type { CoordinatorAuthority } from "./locks.ts";
import type { Task, TaskState } from "./types.ts";

const SIMPLE_THRESHOLD = 0.7;

export type PlanDecision =
  | "ready" // eligible: sent to the READY queue
  | "backlog" // accepted but not ready yet (dependency or conflict)
  | "rejected" // failed re-validation against the repository
  | "duplicate" // duplicate of an existing task
  | "cleared" // previously blocked task, now READY
  | "unchanged" // previously blocked task, still blocked
  | "skipped"; // not a discovery proposal; no plan payload

export interface PlanReportEntry {
  taskId: string;
  title: string;
  decision: PlanDecision;
  reason: string;
  primaryFile?: string;
  complexity?: string;
  dependencies?: string[];
  unmetDependencies?: string[];
  unresolvedDependencies?: string[];
  conflictWith?: string[];
}

export interface PlanMeta {
  plannedAt: number;
  primaryFile?: string;
  complexity?: string;
  /** task ids this task waits for (unmet at planning time) */
  dependencies: string[];
  /** unmet dependency titles at planning time */
  unmetDependencies: string[];
  /** proposal dependency titles that matched no task */
  unresolvedDependencies: string[];
  /** task ids holding the same primary file while active */
  conflictWith: string[];
  decision: PlanDecision;
  reason: string;
}

/** Proposal dependency entries may reference other proposals by title. */
export interface ResolvedDependency {
  id: string;
  title: string;
}

/** Result of mapping proposal dependency titles to existing task ids. */
export interface DependencyResolution {
  resolved: ResolvedDependency[];
  /** proposal titles that did not match any task */
  unresolved: ResolvedDependency[];
}

/** DONE, or no task record at all — missing dependency records count as
 * resolved (symmetric with the conflictWith semantics). */
function isFinished(task: Task | undefined): boolean {
  return task === undefined || task.status === "DONE";
}

/** Active states that may hold a primary file while a BACKLOG task waits. */
const HOLDING_STATES: readonly TaskState[] = ["READY", "IN_PROGRESS", "REVIEW", "VERIFYING"];

/** States that count as holding a primary file when seed-conflict-checking
 * fresh proposals: accepted BACKLOG tasks queue the file while they wait. */
const FILE_HOLDER_STATES: readonly TaskState[] = ["BACKLOG", ...HOLDING_STATES];

function holdsPrimaryFile(task: Task, primaryFile: string): boolean {
  const plan = task.executionMetadata["plan"] as PlanMeta | undefined;
  if (plan?.primaryFile === primaryFile) return true;
  const proposal = task.executionMetadata["proposal"] as Proposal | undefined;
  return proposal?.evidence?.[0]?.file === primaryFile;
}

/**
 * True when another task in an active state still holds the given primary
 * file. Used to keep BACKLOG tasks from becoming READY while a conflicting
 * task is already queued for the same file.
 */
function fileHeldByActive(store: TaskStore, selfId: string, primaryFile: string | undefined): boolean {
  if (primaryFile === undefined) return false;
  return store
    .listTasks()
    .some((t) => t.id !== selfId && HOLDING_STATES.includes(t.status) && holdsPrimaryFile(t, primaryFile));
}

/**
 * Plan discovery-produced tasks: ...
 * All state changes go through the TaskStore state machine (full event
 * history) under the given coordinator authority — every B-class write is
 * its own transaction guarded by the instance lock. Nothing is ever marked
 * DONE by the planner.
 */
export function planDiscoveredTasks(
  db: DatabaseSync,
  repoDir: string,
  authority: CoordinatorAuthority,
): PlanReportEntry[] {
  const store = new TaskStore(db);
  const reports: PlanReportEntry[] = [];

  // Phase A: re-check BACKLOG tasks that waited on dependencies or conflicts
  const plannedEdges = dependencyEdges(store);
  for (const task of store.listTasks("BACKLOG")) {
    const meta = task.executionMetadata["plan"] as PlanMeta | undefined;
    // Retry-requeued tasks re-enter BACKLOG via requeueRetryWithCoordinator
    // carrying the stale decision "ready" from their previous READY life (a
    // task must have been READY to be claimed, executed and failed). The
    // documented contract is that requeued BACKLOG tasks "flow through
    // planning in the rounds below" (cycle.ts) and that the planner "then
    // promotes it through its normal ready path" (requeueRetryWithCoordinator),
    // so they must be re-checked here like decision-"backlog" tasks. Tasks
    // without plan metadata were never planned (manual/synthetic) and stay
    // skipped: the planner has no dependency/conflict data to re-check.
    if (meta === undefined || (meta.decision !== "backlog" && meta.decision !== "ready")) continue;
    const depsResolved =
      meta.dependencies.length === 0 ||
      meta.dependencies.every((id) => isFinished(store.getTask(id)));
    const conflictResolved =
      meta.conflictWith.length === 0 ||
      meta.conflictWith.every((id) => isFinished(store.getTask(id)));
    const fileHeldByActiveTask = fileHeldByActive(store, task.id, meta.primaryFile);
    if (depsResolved && conflictResolved && !fileHeldByActiveTask) {
      // Dependency ids whose task records vanished are dropped explicitly:
      // surfaced on the promoted plan and in the reason, never silently.
      const dropped = meta.dependencies.filter((id) => store.getTask(id) === undefined);
      const unresolvedTitles =
        dropped.length > 0
          ? [...new Set([...(meta.unresolvedDependencies ?? []), ...dropped])]
          : (meta.unresolvedDependencies ?? []);
      const reason =
        dropped.length > 0
          ? `prerequisites resolved; missing dependency records dropped: ${dropped.join(", ")}`
          : "prerequisites resolved";
      const updated = store.transitionWithCoordinator(task.id, "READY", authority, "planner: dependencies and conflicts resolved");
      store.setMetadataWithCoordinator(task.id, {
        plan: {
          ...meta,
          decision: "ready",
          reason,
          plannedAt: Date.now(),
          dependencies: [],
          unmetDependencies: [],
          conflictWith: [],
          unresolvedDependencies: unresolvedTitles,
        },
      }, authority);
      reports.push({
        taskId: task.id,
        title: task.title,
        decision: "ready",
        reason: `queued (${updated.status})`,
        unresolvedDependencies: unresolvedTitles.length > 0 ? unresolvedTitles : undefined,
      });
    } else {
      // A dependency cycle can never self-resolve: report it explicitly
      // (deterministic — same recorded edges produce the same cycle path)
      // instead of an opaque "still blocked".
      const cycle = detectDependencyCycle(store, plannedEdges, task.id, meta.dependencies);
      if (cycle !== undefined) {
        const reason = `dependency cycle detected: ${describeCycle(store, cycle)}`;
        store.setMetadataWithCoordinator(task.id, {
          plan: { ...meta, plannedAt: Date.now(), decision: "backlog", reason },
        }, authority);
        reports.push({
          taskId: task.id,
          title: task.title,
          decision: "backlog",
          reason,
          dependencies: meta.dependencies,
          unmetDependencies: meta.unmetDependencies,
          conflictWith: meta.conflictWith,
        });
      } else {
        const reason = !depsResolved
          ? "still blocked"
          : fileHeldByActiveTask
            ? "still blocked: primary file is active in another task"
            : "still blocked";
        reports.push({ taskId: task.id, title: task.title, decision: "unchanged", reason });
      }
    }
  }

  // Phase B: fresh DISCOVERED proposals
  // A primary file counts as held by any accepted task that still queues or
  // executes on it (BACKLOG included): a BACKLOG holder seeded via the
  // unmet-dependency or conflict path must keep fresh proposals for the same
  // file queued behind it. The held file is either the planned primaryFile
  // or the stored proposal's first evidence file (some tasks carry only
  // proposal metadata). DISCOVERED/FAILED/BLOCKED/DONE never hold.
  const acceptedPrimaryFiles = new Set<string>();
  for (const t of store.listTasks()) {
    if (!FILE_HOLDER_STATES.includes(t.status)) continue;
    const planPrimary = (t.executionMetadata["plan"] as PlanMeta | undefined)?.primaryFile;
    if (planPrimary !== undefined) acceptedPrimaryFiles.add(planPrimary);
    const evidenceFile = (t.executionMetadata["proposal"] as Proposal | undefined)?.evidence?.[0]?.file;
    if (evidenceFile !== undefined) acceptedPrimaryFiles.add(evidenceFile);
  }
  // Recorded dependency edges snapshot (plan metadata only): fresh tasks are
  // cycle-checked against decisions that already existed when this run
  // started; a cycle that only materialises between same-run peers is
  // recorded by the end of this run and becomes explicit on the next run's
  // Phase A re-check.
  const recordedEdges = dependencyEdges(store);

  for (const task of store.listTasks("DISCOVERED")) {
    const proposalRaw = task.executionMetadata["proposal"];
    if (proposalRaw === undefined) {
      withEventHistory(store, task, authority, "planner: no proposal payload — not a discovery task");
      store.recordPlanningWithCoordinator(task.id, "planner: no proposal payload — not a discovery task", authority);
      reports.push({ taskId: task.id, title: task.title, decision: "skipped", reason: "no proposal payload" });
      continue;
    }
    const previous = task.executionMetadata["plan"] as PlanMeta | undefined;
    if (previous !== undefined && previous.decision !== "rejected") {
      if (previous.decision === "duplicate") {
        // Duplicate lifecycle: re-run the duplicate check every run. While a
        // live (non-DONE) duplicate source exists the task stays unchanged;
        // once the source finishes (or disappears) the task falls through to
        // the normal planning path below instead of staying DISCOVERED.
        const activeDuplicates = listDuplicateTitles(store, [task.title], task.id);
        if (activeDuplicates.length > 0) {
          const reason = `duplicate of "${activeDuplicates[0]}" still active`;
          store.setMetadataWithCoordinator(task.id, {
            plan: { ...previous, plannedAt: Date.now(), decision: "unchanged", reason },
          }, authority);
          withEventHistory(store, task, authority, `planner: ${reason}`);
          store.recordPlanningWithCoordinator(task.id, `planner: ${reason}`, authority);
          reports.push({ taskId: task.id, title: task.title, decision: "unchanged", reason });
          continue;
        }
      } else {
        reports.push({ taskId: task.id, title: task.title, decision: "unchanged", reason: "already planned" });
        store.setMetadataWithCoordinator(task.id, {
          plan: {
            ...previous,
            plannedAt: Date.now(),
            decision: "unchanged",
            reason: "already planned",
          },
        }, authority);
        withEventHistory(store, task, authority, "planner: already planned");
        store.recordPlanningWithCoordinator(task.id, "planner: already planned", authority);
        continue;
      }
    }

    // The CLI (persistProposals) stores the Proposal directly under the
    // "proposal" key, while some callers wrap it as { proposal: <Proposal> }.
    // Normalize so both forms validate identically.
    const proposal = unwrapProposal(proposalRaw);

    const existingTitles = store
      .listTasks()
      .filter((t) => t.id !== task.id && t.status !== "DONE")
      .map((t) => t.title);
    if (isDuplicateTitle(task.title, existingTitles)) {
      store.setMetadataWithCoordinator(task.id, { plan: freshMeta("duplicate", "title duplicates an existing task") }, authority);
      withEventHistory(store, task, authority, "planner rejected: duplicate of an existing task");
      store.recordPlanningWithCoordinator(task.id, "planner rejected: duplicate of an existing task", authority);
      reports.push({ taskId: task.id, title: task.title, decision: "duplicate", reason: "duplicate of an existing task", primaryFile: primaryFileOf(proposal), conflictWith: [] });
      continue;
    }

    const validation = revalidateProposal(proposal, repoDir, store, task.id);
    if (!validation.ok || validation.proposal === undefined) {
      const reason = validation.reason ?? "validation failed";
      store.setMetadataWithCoordinator(task.id, {
        plan: freshMeta("rejected", reason),
      }, authority);
      withEventHistory(store, task, authority, `planner rejected: ${reason}`);
      store.recordPlanningWithCoordinator(task.id, `planner rejected: ${reason}`, authority);
      reports.push({ taskId: task.id, title: task.title, decision: "rejected", reason });
      continue;
    }

    const primaryFile = primaryFileOf(proposal);
    // Dependencies resolve BEFORE the conflict decision (D6) and are never
    // discarded by it; the conflict BACKLOG write below keeps them recorded.
    const { resolved: dependencies, unresolved } = resolveDependencies(store, proposal, task.id);
    // Cycle check against the pre-run snapshot of recorded dependency edges:
    // a fresh task whose recorded chain reaches back to itself can never be
    // promoted and is reported explicitly.
    const cycle = detectDependencyCycle(
      store,
      recordedEdges,
      task.id,
      dependencies.map((dep) => dep.id),
    );
    if (cycle !== undefined) {
      const reason = `dependency cycle detected: ${describeCycle(store, cycle)}`;
      const unmetTitles = dependencies
        .filter((dep) => !isFinished(store.getTask(dep.id)))
        .map((dep) => dep.title);
      store.transitionWithCoordinator(task.id, "BACKLOG", authority, "planner: dependency cycle detected");
      store.setMetadataWithCoordinator(task.id, {
        plan: {
          ...freshMeta("backlog", reason),
          primaryFile,
          complexity: proposal.complexity,
          dependencies: dependencies.map((dep) => dep.id),
          unmetDependencies: unmetTitles,
          unresolvedDependencies: unresolved.map((dep) => dep.title),
          conflictWith: [],
        },
      }, authority);
      withEventHistory(store, task, authority, `planner: ${reason} → BACKLOG`);
      store.recordPlanningWithCoordinator(task.id, `planner: ${reason} → BACKLOG`, authority);
      reports.push({
        taskId: task.id,
        title: task.title,
        decision: "backlog",
        reason,
        dependencies: dependencies.map((dep) => dep.id),
        conflictWith: [],
      });
      continue;
    }

    if (primaryFile !== undefined && acceptedPrimaryFiles.has(primaryFile)) {
      const holders = store
        .listTasks()
        .filter(
          (t) =>
            t.id !== task.id &&
            ((t.executionMetadata["plan"] as PlanMeta | undefined)?.primaryFile === primaryFile ||
              (t.executionMetadata["proposal"] as Proposal | undefined)?.evidence?.[0]?.file === primaryFile),
        )
        .filter((t) => FILE_HOLDER_STATES.includes(t.status))
        .map((t) => t.id);
      const unmetDeps = dependencies.filter((dep) => !isFinished(store.getTask(dep.id)));
      const conflictReason = `conflict: ${primaryFile} is active in task(s) ${holders.join(", ") || "<unknown>"}`;
      store.transitionWithCoordinator(task.id, "BACKLOG", authority, "planner: conflict on active primary file");
      store.setMetadataWithCoordinator(task.id, {
        plan: {
          ...freshMeta("backlog", conflictReason),
          primaryFile,
          complexity: proposal.complexity,
          dependencies: dependencies.map((dep) => dep.id),
          unmetDependencies: unmetDeps.map((dep) => dep.title),
          unresolvedDependencies: unresolved.map((dep) => dep.title),
          conflictWith: holders,
        },
      }, authority);
      withEventHistory(store, task, authority, `planner conflict on ${primaryFile} → BACKLOG`);
      store.recordPlanningWithCoordinator(task.id, `planner conflict on ${primaryFile} → BACKLOG`, authority);
      reports.push({
        taskId: task.id,
        title: task.title,
        decision: "backlog",
        reason: conflictReason,
        dependencies: dependencies.map((dep) => dep.id),
        unmetDependencies: unmetDeps.map((dep) => dep.title),
        unresolvedDependencies: unresolved.map((dep) => dep.title),
        conflictWith: holders,
      });
      continue;
    }
    if (unresolved.length > 0) {
      const reason = `unresolvable dependencies: ${unresolved.map((d) => d.title).join(", ")}`;
      store.transitionWithCoordinator(task.id, "BACKLOG", authority, `planner: ${reason}`);
      store.setMetadataWithCoordinator(task.id, {
        plan: {
          ...freshMeta("backlog", reason),
          primaryFile,
          complexity: proposal.complexity,
          dependencies: dependencies.map((dep) => dep.id),
          unmetDependencies: unresolved.map((dep) => dep.title),
          unresolvedDependencies: unresolved.map((dep) => dep.title),
          conflictWith: [],
        },
      }, authority);
      withEventHistory(store, task, authority, `planner: ${reason} → BACKLOG`);
      store.recordPlanningWithCoordinator(task.id, `planner: ${reason} → BACKLOG`, authority);
      reports.push({ taskId: task.id, title: task.title, decision: "backlog", reason, unresolvedDependencies: unresolved.map((dep) => dep.title) });
      continue;
    }

    const unmet = dependencies.filter((dep) => !isFinished(store.getTask(dep.id)));
    if (unmet.length > 0) {
      const reason = `waiting for dependencies: ${unmet.map((d) => d.title).join(", ")}`;
      store.transitionWithCoordinator(task.id, "BACKLOG", authority, `planner: waiting for ${unmet.map((d) => d.title).join(", ")}`);
      store.setMetadataWithCoordinator(task.id, {
        plan: {
          ...freshMeta("backlog", reason),
          primaryFile,
          complexity: proposal.complexity,
          dependencies: dependencies.map((dep) => dep.id),
          unmetDependencies: unmet.map((dep) => dep.title),
          conflictWith: [],
        },
      }, authority);
      withEventHistory(store, task, authority, `planner: ${reason} → BACKLOG`);
      store.recordPlanningWithCoordinator(task.id, `planner: ${reason} → BACKLOG`, authority);
      reports.push({ taskId: task.id, title: task.title, decision: "backlog", reason, unmetDependencies: unmet.map((dep) => dep.title) });
      continue;
    }

    // eligible: DISCOVERED → BACKLOG → READY
    store.transitionWithCoordinator(task.id, "BACKLOG", authority, "planner: validated and accepted");
    store.setMetadataWithCoordinator(task.id, {
      plan: {
        plannedAt: Date.now(),
        primaryFile,
        complexity: proposal.complexity,
        dependencies: [],
        unmetDependencies: [],
        conflictWith: [],
        decision: "backlog",
        reason: "validated; moving to queue",
      },
    }, authority);
    const ready = store.transitionWithCoordinator(task.id, "READY", authority, "planner: dependency-ready and conflict-free");
    store.setMetadataWithCoordinator(task.id, {
      plan: {
        plannedAt: Date.now(),
        primaryFile,
        complexity: proposal.complexity,
        dependencies: dependencies.map((dep) => dep.id),
        unmetDependencies: [],
        conflictWith: [],
        decision: "ready",
        reason: "validated; moving to queue",
      },
      primaryFile,
      complexity: proposal.complexity,
    }, authority);
    withEventHistory(store, task, authority, "planner: validated and accepted");
    store.recordPlanningWithCoordinator(task.id, "planner: validated and accepted", authority);
    if (primaryFile !== undefined) acceptedPrimaryFiles.add(primaryFile);
    reports.push({ taskId: task.id, title: task.title, decision: "ready", reason: `queued (${ready.status})` });
  }

  return reports;
}

/**
 * Append one planning detail to the append-only event history stored in
 * executionMetadata.eventHistory (keeps a JSON snapshot for every decision).
 */
function withEventHistory(store: TaskStore, task: Task, authority: CoordinatorAuthority, detail: string): void {
  const current = task.executionMetadata["eventHistory"];
  if (current !== undefined) return; // event history already maintained by the store
  store.setMetadataWithCoordinator(task.id, { eventHistory: JSON.stringify([detail]) }, authority);
}

/**
 * Proposal payloads are written bare by persistProposals and wrapped as
 * { proposal: <Proposal> } by some callers. Accept both shapes.
 */
function unwrapProposal(raw: unknown): Proposal {
  if (typeof raw !== "object" || raw === null) return raw as Proposal;
  const candidate = raw as Record<string, unknown>;
  const nested = candidate["proposal"];
  if (
    nested !== undefined &&
    typeof nested === "object" &&
    nested !== null &&
    isProposalShaped(nested)
  ) {
    return nested as Proposal;
  }
  return raw as Proposal;
}

function freshMeta(decision: PlanDecision, reason: string): PlanMeta {
  return {
    plannedAt: Date.now(),
    dependencies: [],
    unmetDependencies: [],
    unresolvedDependencies: [],
    conflictWith: [],
    decision,
    reason,
  };
}

/**
 * Proposal dependencies reference proposal titles; map them to existing task
 * ids. Resolution is exact-first: a normalized exact title match (trim +
 * lowercase, consistent with titleSimilarity's lowercase tokenization) wins
 * over fuzzy matches, so a lower-priority exact task is not shadowed by a
 * merely similar higher-priority one. The fuzzy fallback scans in the
 * current listTasks() order (priority DESC). Self and already-seen ids are
 * excluded in both passes.
 */
export function resolveDependencies(store: TaskStore, proposal: Proposal, selfId: string): DependencyResolution {
  if (proposal.dependencies === undefined) return { resolved: [], unresolved: [] };
  const all = store.listTasks();
  const resolved: ResolvedDependency[] = [];
  const unresolved: ResolvedDependency[] = [];
  const seen = new Set<string>([selfId]);
  for (const title of proposal.dependencies) {
    let matched: ResolvedDependency | undefined;
    const wanted = title.trim().toLowerCase();
    if (wanted.length > 0) {
      // pass 1: exact normalized title
      for (const candidate of all) {
        if (candidate.id === selfId || seen.has(candidate.id)) continue;
        if (candidate.title.trim().toLowerCase() === wanted) {
          matched = { id: candidate.id, title: candidate.title };
          break;
        }
      }
    }
    if (matched === undefined) {
      // pass 2: fuzzy similarity in listTasks() order (priority DESC)
      for (const candidate of all) {
        if (candidate.id === selfId || seen.has(candidate.id)) continue;
        if (titleSimilarity(title, candidate.title) >= SIMPLE_THRESHOLD) {
          matched = { id: candidate.id, title: candidate.title };
          break;
        }
      }
    }
    if (matched !== undefined) {
      resolved.push(matched);
      seen.add(matched.id);
    } else {
      unresolved.push({ id: "", title });
    }
  }
  return { resolved, unresolved };
}

/** Dependency edges recorded in plan metadata, keyed by task id. Tasks that
 * were never planned or whose recorded dependencies are resolved are leaves. */
function dependencyEdges(store: TaskStore): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const t of store.listTasks()) {
    const plan = t.executionMetadata["plan"] as PlanMeta | undefined;
    edges.set(t.id, plan?.dependencies ?? []);
  }
  return edges;
}

/**
 * Follow the recorded dependency chain from `startId` (beginning with
 * `startDeps`, the freshly resolved ids for a not-yet-planned task) and
 * return the cycle path (starting and ending at startId) when the chain
 * reaches back to startId. Bounded and total: every task id is expanded at
 * most once via the visited set and DONE tasks are leaves because their own
 * chains are resolved by definition.
 */
function detectDependencyCycle(
  store: TaskStore,
  edges: Map<string, string[]>,
  startId: string,
  startDeps: string[],
): string[] | undefined {
  const visited = new Set<string>([startId]);
  const path: string[] = [startId];
  const expand = (nodeId: string, depIds: string[]): string[] | undefined => {
    for (const dep of depIds) {
      if (dep === startId) return [...path, startId];
      if (visited.has(dep) || store.getTask(dep)?.status === "DONE") continue;
      visited.add(dep);
      path.push(dep);
      const found = expand(dep, edges.get(dep) ?? []);
      if (found !== undefined) return found;
      path.pop();
    }
    return undefined;
  };
  return expand(startId, startDeps);
}

/** Human-readable cycle path using task titles (ids as fallback). */
function describeCycle(store: TaskStore, cycle: string[]): string {
  return cycle.map((id) => store.getTask(id)?.title ?? id).join(" → ");
}

/**
 * Titles of existing non-DONE tasks that duplicate any of `titles` (token
 * similarity >= proposal.DUPLICATE_THRESHOLD).
 */
export function listDuplicateTitles(store: TaskStore, titles: Iterable<string>, selfId?: string): string[] {
  const existing = store
    .listTasks()
    .filter((t) => (t.id !== selfId && t.status !== "DONE"))
    .map((t) => t.title);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const title of titles) {
    for (const existingTitle of existing) {
      if (isDuplicateTitle(title, [existingTitle]) && !seen.has(existingTitle)) {
        seen.add(existingTitle);
        result.push(existingTitle);
      }
    }
  }
  return result;
}

/**
 * Keep the highest-ranked proposal for each title-equivalent group; the rest
 * are reported as duplicates of the surviving title.
 */
export function dedupeProposals(proposals: Proposal[], store: TaskStore): {
  kept: Proposal[];
  duplicates: Array<{ proposal: Proposal; reason: string }>;
  accepted: Proposal[];
} {
  const ordered = [...proposals].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const rankA = COMPLEXITIES.indexOf(a.complexity);
    const rankB = COMPLEXITIES.indexOf(b.complexity);
    if (rankA !== rankB) return rankB - rankA;
    return a.title.localeCompare(b.title);
  });

  const survivors = new Map<string, Proposal>();
  const duplicates: Array<{ proposal: Proposal; reason: string }> = [];
  for (const proposal of ordered) {
    if (survivors.has(proposal.title)) {
      duplicates.push({ proposal, reason: `duplicate of existing task title "${proposal.title}"` });
      continue;
    }
    if (isDuplicateTitle(proposal.title, [...survivors.keys()])) {
      const sortedSurvivors = [...survivors.keys()].sort((x, y) => x.localeCompare(y));
      duplicates.push({
        proposal,
        reason: `duplicate of existing task title "${sortedSurvivors[0] ?? ""}"`,
      });
      continue;
    }
    survivors.set(proposal.title, proposal);
  }

  const kept = [...survivors.values()];
  const accepted = [...ordered].filter((proposal) => survivors.get(proposal.title) === proposal);
  return { kept, duplicates, accepted };
}

/**
 * Re-validate a proposal against the discovery contract and against existing
 * task titles (duplicate titles are rejected up front).
 */
export function revalidateProposal(
  proposal: Proposal,
  repoDir: string,
  store?: TaskStore,
  selfId?: string,
): ValidatedProposal {
  if (store !== undefined) {
    const duplicates = listDuplicateTitles(store, [proposal.title], selfId);
    if (duplicates.length > 0) return { ok: false, reason: "title duplicates an existing task" };
  }
  return validateProposal(proposal, repoDir);
}
