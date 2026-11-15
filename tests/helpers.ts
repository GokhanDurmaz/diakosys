import type { DatabaseSync } from "node:sqlite";
import type { CoordinatorAuthority } from "../src/locks.ts";
import type { Proposal } from "../src/proposal.ts";

/**
 * Restore the listed environment variables to how they were before a test
 * overrode them. A variable that was originally absent is deleted rather than
 * assigned `undefined`, which Node would otherwise store as the literal string
 * "undefined" and leak into later tests.
 */
export function restoreEnv(vars: Readonly<Record<string, string | undefined>>): void {
  for (const key of Object.keys(vars)) {
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
}

/** Test coordinator: stamps the instance lock row as the test's authority. */
export function coordinatorAuth(db: DatabaseSync): CoordinatorAuthority {
  const owner = "orchestrator-test";
  const row = db.prepare("SELECT owner, generation FROM instance_locks WHERE id = 1").get() as
    | { owner: string; generation: number }
    | undefined;
  if (row === undefined || row.owner !== owner) {
    db.prepare(
      "UPDATE instance_locks SET owner = ?, generation = generation + 1, expires_at = ? WHERE id = 1",
    ).run(owner, Date.now() + 600_000);
  }
  const refreshed = db.prepare("SELECT generation FROM instance_locks WHERE id = 1").get() as { generation: number };
  return { owner, generation: refreshed.generation, lockTtlMs: 120_000 };
}

/** Fully valid proposal used as the base for test payloads. Evidence file
 *  resolves in the tmp repos every affected test creates. */
export function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    title: "Guard evaluator against NaN samples",
    problem: "Non-finite samples reach the health evaluator and corrupt the score",
    rationale: "The evaluator must reject non-finite sampled values",
    evidence: [
      { file: "src/main/java/io/diakosys/HealthEvaluator.java", observation: "sampled value is not finite" },
    ],
    approach: "Pin the sample before scoring and reject NaN/Infinity",
    outcome: "The health score stays finite for every sample",
    priority: 6,
    complexity: "low",
    verification: ["run the health evaluator tests"],
    ...overrides,
  };
}
