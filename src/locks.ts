import type { DatabaseSync } from "node:sqlite";
import type { WriteTx } from "./tx.ts";

export interface LockGrant {
  owner: string;
  generation: number;
  expiresAt: number;
  acquiredVia: "free" | "expired-takeover";
}

export type LockAcquireOutcome =
  | { status: "granted"; grant: LockGrant }
  | { status: "denied"; holder: string; holderExpiresAt: number };

/** Proof of instance-level control: the live coordinator lock (owner + generation + TTL). */
export interface CoordinatorAuthority {
  owner: string;
  generation: number;
  lockTtlMs: number;
}

export class CoordinatorDisownedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorDisownedError";
  }
}

/**
 * Acquire (or takeover an expired) instance lock inside the caller's open
 * write transaction. Denied results leave the row untouched.
 */
export function acquireLockTxn(
  db: DatabaseSync,
  tx: WriteTx,
  owner: string,
  ttlMs: number,
): LockAcquireOutcome {
  const now = tx.now();
  const row = readLockRow(db);
  const holder = row?.owner ?? "";
  const holderExpiresAt = row?.expiresAt ?? 0;
  const previousGeneration = row?.generation ?? 0;

  const expiresAt = now + ttlMs;
  const acquired = db
    .prepare(
      `UPDATE instance_locks
       SET owner = ?, generation = generation + 1, expires_at = ?
       WHERE id = 1 AND (owner = '' OR expires_at <= ?)`,
    )
    .run(owner, expiresAt, now);
  if (Number(acquired.changes) !== 1) {
    return { status: "denied", holder: holder || "unknown", holderExpiresAt };
  }
  const grant: LockGrant = {
    owner,
    generation: previousGeneration + 1,
    expiresAt,
    acquiredVia: holder === "" ? "free" : "expired-takeover",
  };
  return { status: "granted", grant };
}

/**
 * Coordinator guard: piggy-back a real lease renewal onto any guarded write.
 * Zero rows changed means the lock was lost (released, expired and taken
 * over, or stolen); the caller must abort the transaction.
 */
export function coordinatorGuardTxn(
  db: DatabaseSync,
  tx: WriteTx,
  owner: string,
  generation: number,
  ttlMs: number,
): void {
  const now = tx.now();
  const renewed = db
    .prepare(
      `UPDATE instance_locks
       SET expires_at = ?
       WHERE id = 1 AND owner = ? AND generation = ? AND expires_at > ?`,
    )
    .run(now + ttlMs, owner, generation, now);
  if (Number(renewed.changes) !== 1) {
    throw new CoordinatorDisownedError(
      `instance lock no longer held by '${owner}' (generation ${generation}) — transaction aborted`,
    );
  }
}

/** Release the lock if it is still held by `owner`; unowned or stolen rows stay untouched. */
export function releaseLockTxn(db: DatabaseSync, tx: WriteTx, owner: string): boolean {
  const released = db
    .prepare(
      `UPDATE instance_locks
       SET owner = '', generation = generation + 1, expires_at = 0
       WHERE id = 1 AND owner = ?`,
    )
    .run(owner);
  return Number(released.changes) === 1;
}

export interface LockRow {
  owner: string;
  generation: number;
  expiresAt: number;
}

export function readLockRow(db: DatabaseSync): LockRow | undefined {
  const row = db.prepare("SELECT owner, generation, expires_at FROM instance_locks WHERE id = 1").get() as
    | { owner: string; generation: number; expires_at: number }
    | undefined;
  if (row === undefined) return undefined;
  return { owner: String(row.owner), generation: Number(row.generation), expiresAt: Number(row.expires_at) };
}
