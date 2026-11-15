import type { DatabaseSync } from "node:sqlite";
import { withWriteTx } from "./tx.ts";
import {
  acquireLockTxn,
  coordinatorGuardTxn,
  releaseLockTxn,
  readLockRow,
  CoordinatorDisownedError,
  type CoordinatorAuthority,
  type LockGrant,
} from "./locks.ts";

export { CoordinatorDisownedError };
export type { CoordinatorAuthority, LockGrant };

export interface LockAcquireFailure {
  holder: string;
  holderExpiresAt: number;
}

/**
 * Acquire the instance lock in its own transaction. Denied → throw with a
 * descriptive message (another orchestrator process is steering the same
 * database); callers must surface that and exit without touching tasks.
 */
export function acquireInstanceLock(db: DatabaseSync, owner: string, ttlMs: number): LockGrant {
  const outcome = withWriteTx(db, (tx) => acquireLockTxn(db, tx, owner, ttlMs));
  if (outcome.status !== "granted") {
    throw new Error(
      `another coordinator holds the orchestrator lock (owner '${outcome.holder}', expires ${new Date(outcome.holderExpiresAt).toISOString()}); refusing to run concurrently`,
    );
  }
  return outcome.grant;
}

/** Renew the held lock; false means the lock was lost or stolen. */
export function renewInstanceLock(db: DatabaseSync, authority: CoordinatorAuthority): boolean {
  try {
    withWriteTx(db, (tx) => {
      coordinatorGuardTxn(db, tx, authority.owner, authority.generation, authority.lockTtlMs);
    });
    return true;
  } catch {
    return false;
  }
}

/** Release the lock if still held; wrapped in its own transaction. */
export function releaseInstanceLock(db: DatabaseSync, owner: string): boolean {
  return withWriteTx(db, (tx) => releaseLockTxn(db, tx, owner));
}

/** Read the current lock state (for diagnostics). */
export function lockState(db: DatabaseSync): { owner: string; generation: number; expiresAt: number } | undefined {
  return readLockRow(db);
}

/** Stable per-process coordinator owner string. */
export function coordinatorOwner(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${process.pid.toString(36)}_${rand}`;
}
