import { DatabaseSync } from "node:sqlite";
import { now } from "./clock.ts";

const NESTED_BEGIN_PATTERN = /cannot start a transaction within a transaction/i;

export class NestedTransactionError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "NestedTransactionError";
  }
}

export class TxStateError extends Error {}

export interface WriteTx {
  now(): number;
}

const BEGIN_FAILED_PATTERN = "BEGIN IMMEDIATE failed";

export function withWriteTx<T>(db: DatabaseSync, fn: (tx: WriteTx) => T): T {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (NESTED_BEGIN_PATTERN.test(message)) {
      throw new NestedTransactionError(
        `${BEGIN_FAILED_PATTERN}: a transaction is already open on this connection; nested transactions are not supported`,
        err,
      );
    }
    throw err;
  }

  let txnOpen = true;
  const tx: WriteTx = {
    now(): number {
      if (!txnOpen) {
        throw new TxStateError("txnNow() is only valid inside the withWriteTx callback");
      }
      return now();
    },
  };

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: fn(tx) };
  } catch (err) {
    outcome = { ok: false, error: err };
  }
  txnOpen = false;

  if (outcome.ok) {
    try {
      db.exec("COMMIT");
      return outcome.value;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // rollback of a failed commit is best-effort; the commit error is primary
      }
      throw err;
    }
  }

  try {
    db.exec("ROLLBACK");
  } catch {
    // failed work already unrolled the transaction in some error paths; preserve the original error
  }
  throw outcome.error;
}
