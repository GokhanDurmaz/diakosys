# Implementation Status — Discovery Reliability and Session Isolation

Checkpoint for the Discovery Reliability and Session Isolation implementation.
Every item below is marked complete only against evidence read from the current
source tree (`src/`, `tests/`) and, where noted, against a live run.

---

## 1. Per-area discovery sessions

**Complete.**

- `AreaResult` and the `DiscoveryResult.areas: AreaResult[]` shape are defined
  in `src/discovery.ts` (lines 169–198).
- `runArea()` returns an `AreaResult` per area in `src/discovery.ts`
  (line 923).
- The CLI consumes the per-area shape: `discover()` in `src/cli.ts` iterates
  `result.areas` and reports `area <name>: <ok | ERROR — …>` per area
  (line ~892).
- Per-area proposal/rejection counts are printed per area, so a failure in one
  area is attributed to that area rather than to the whole run.

## 2. Prompt / context budget

**Complete.**

- `MAX_AREA_PROMPT_CHARS = 64_000` in `src/discovery.ts` (line 466).
- `fitManifestToBudget(area, maxProposalsPerArea, files, evidenceBlock, budgetChars)`
  in `src/discovery.ts` (line 694).
- The assembled area prompt is measured **before** it is submitted and the
  proposal set is trimmed to fit the budget; the prompt-timeout default of 420s
  is the reason the budget is enforced at the prompt level.

## 3. Coordinator heartbeat

**Complete.**

- Heartbeat logic lives in `src/coordinator.ts` (`holdsInstanceLock`, renewal,
  disowning on generation mismatch).
- `discover()` in `src/cli.ts` installs a `setInterval` that renews the instance
  lock on the same `lockTtlMs / 3` cadence used by `run` and `cycle`
  (line 774). A failed renewal sets `lockLost` and is reported on stderr.
- The interval handle is held in the outermost scope and cleared in the outermost
  `finally` **before** the lock is released, so a queued renewal cannot fire
  against a released (or stolen) lock row.

## 4. Instance-lock-loss safety

**Complete.**

- `holdsInstanceLock(db, authority)` guard predicate in `src/coordinator.ts`
  (line 59).
- Wired into the CLI at `src/cli.ts:788` via `stillHoldsLock()`, which is the
  predicate used by both the cancellation gate and the persistence gates.
- Persistence gating: the pre-write gate, the `CoordinatorDisownedError` catch
  that refuses persistence, and the post-write refusal path all refuse writes
  when the lock is lost — a disowned coordinator cannot keep writing or persist
  a partial run.

## 5. `shouldStop` wiring

**Complete.**

- `shouldStop?: () => boolean` is part of the discovery options in
  `src/discovery.ts` (line 221) and consulted before each area
  (line 828) and again after the run (line 873).
- Wired in `src/cli.ts:811`: `shouldStop: () => lockRefused()` — cancellation
  between areas when the instance lock was lost (heartbeat) or no longer held.
- Wired in `src/cycle.ts:241`: `shouldStop: () => summary.disowned` — cycle
  stops when its own lock heartbeat reports the instance lock lost.

## 6. Regression tests

**Complete.**

- `tests/cli.test.ts` — dry-run contract (pinned note text, no manifest, no run
  summary), per-area error exit code, post-audit rejection relocation, lock
  release on every path, foreign-coordinator refusal.
- `tests/discovery-engine.test.ts` — per-area session / budget behaviour.
- `tests/discovery-evidence.test.ts` — evidence collection per area.
- `tests/live-adapter.test.ts` — live adapter session contract.
- `tests/auditor.test.ts` — proposal audit verdicts.

## 7. Verification checklist

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Per-area discovery sessions | ✅ Complete | `src/discovery.ts:169`, `:923`; `src/cli.ts` per-area reporting |
| 2 | Prompt / context budget | ✅ Complete | `src/discovery.ts:466`, `:694` |
| 3 | Coordinator heartbeat | ✅ Complete | `src/coordinator.ts`; `src/cli.ts:774` |
| 4 | Instance-lock-loss safety | ✅ Complete | `src/coordinator.ts:59`; `src/cli.ts:788` |
| 5 | `shouldStop` wiring | ✅ Complete | `src/discovery.ts:221,828,873`; `src/cli.ts:811`; `src/cycle.ts:241` |
| 6 | npm argument forwarding | ✅ Complete | `npm start -- discover --dry-run --area quality` runs end-to-end; `src/cli.ts` reads `process.argv.slice(2)` |
| 7 | Dry-run behaviour | ✅ Complete | pinned `DRY_RUN_NOTE` in `src/cli.ts:711`; no proposals / discovery runs / manifest written |
| 8 | Regression tests | ✅ Complete | `tests/cli.test.ts`, `tests/discovery-engine.test.ts`, `tests/discovery-evidence.test.ts`, `tests/live-adapter.test.ts`, `tests/auditor.test.ts` |

### Test run

```
$ npm test
ℹ tests 453
ℹ pass  452
ℹ fail  1
```

The single failure is `tests/config.test.ts:58` — "defaults resolve to the
MiMo configuration" — asserting `mimo-llama-m5` while the environment resolves
`mimo-q8-m5`. It is a model-default assertion unrelated to any of the five
improvements (no source in `src/discovery.ts`, `src/coordinator.ts`,
`src/cli.ts` or `src/cycle.ts` is involved), and it is pre-existing.

## Decisions

- Dry-run is **not** a fully write-free run: it still opens the database file and
  acquires/renews/releases the coordinator instance lock. The pinned output note
  names exactly what it does and does not write so the contract cannot be
  misread.
- Lock loss during discovery is treated as cancellation *and* as a write refusal:
  no further model requests are submitted between areas, and no persistence path
  executes.
- The heartbeat is stopped before the lock is released in the outermost `finally`,
  so a queued renewal cannot target a released lock row.

## Blockers

- None.
