import type { OrchestratorConfig } from "./config.ts";
import type { Proposal } from "./proposal.ts";
import { titleSimilarity } from "./proposal.ts";
import type { TaskStore } from "./store.ts";
import type { CoordinatorAuthority } from "./locks.ts";

/**
 * Persist validated discovery proposals as DISCOVERED tasks carrying their
 * proposal payload and discovery-run metadata. Title-similar duplicates of
 * tasks already in the store (titleSimilarity >= 0.7, first-seen wins) are
 * skipped. Shared by the `discover` and `cycle` CLI commands.
 *
 * Every proposal is its own coordinator-guarded transaction: the task INSERT,
 * the `created`/`planned` events and the proposal/discovery-run metadata are
 * written together, so a crash can never leave a task without its proposal
 * payload (the planner skips payload-less DISCOVERED rows).
 *
 * Persistence is deliberately partial: a proposal that fails mid-batch rolls
 * back its own transaction only. Already-committed proposals stay and the
 * remaining ones are still persisted, so the batch is never all-or-nothing.
 * The first failure is rethrown so callers can report it.
 *
 * Nothing here is awaited: no external, model or network operation runs
 * inside a transaction — every write is local SQL guarded by the instance
 * lock, with a fresh tx.now() sampled before each protected statement.
 */
export function persistProposals(
  store: TaskStore,
  result: { proposals: Proposal[] },
  config: Pick<OrchestratorConfig, "model">,
  authority: CoordinatorAuthority,
  onCreated: (taskId: string) => void,
): void {
  const existingTitles = store.listTasks().map((t) => t.title);
  let firstFailure: unknown;
  for (const proposal of result.proposals) {
    if (existingTitles.some((t) => titleSimilarity(t, proposal.title) >= 0.7)) {
      continue;
    }
    try {
      const created = store.createTaskWithCoordinator(
        {
          title: proposal.title,
          description: proposal.problem,
          priority: proposal.priority,
          metadata: {
            proposal,
            discoveryRun: { model: config.model, at: Date.now(), areas: "auto" },
            primaryFile: proposal.evidence[0]?.file,
            complexity: proposal.complexity,
          },
          planningDetail: `discovery proposal stored (${proposal.complexity}, p=${proposal.priority})`,
        },
        authority,
      );
      existingTitles.push(proposal.title);
      onCreated(created.id);
    } catch (err) {
      // Partial batch persistence: a failed proposal rolls back its own
      // transaction; the batch keeps going so the rest still lands.
      if (firstFailure === undefined) {
        firstFailure = err;
      }
    }
  }
  if (firstFailure !== undefined) {
    throw firstFailure instanceof Error ? firstFailure : new Error(`proposal persistence failed: ${String(firstFailure)}`);
  }
}
