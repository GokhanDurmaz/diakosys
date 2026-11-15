# Diakosys Orchestrator — Agent Colony Shared Context

Shared working context for the 3-agent colony. Read before starting work; update
continuously. **Do not edit files outside your ownership without coordination.**

Ownership:
- **Explore** — read-only investigation, publishes findings here. Owns nothing.
- **Worker 1 (Discovery Engine)** — `selectAreas`, `DiscoveryEngine.run/runArea/persist`,
  `collectEvidence`, `DiscoveryRunStore`.
- **Worker 2 (Proposals + Task Planner)** — proposal payload extraction/parsing,
  proposal validation, proposal deduplication, Task Planner, dependency resolution.

## How to communicate

Update this file (append a dated section) OR use the existing orchestrator
SQLite task store (`src/queue.ts` / `src/store.ts`) for status. Do NOT introduce
a new framework.

## Repository layout

`PROJECT_ROOT/` (TypeScript, NodeNext, `npm test` =
`node --test "tests/*.test.ts"`).

Source: `src/{cli,config,db,defaults,discovery,opencode,planner,proposal,queue,runner,state,store,types}.ts`
Tests: `tests/*.test.ts`

## Environment note

`node` is NOT installed by default in this environment. Install with:
`export PATH="/opt/homebrew/bin:$PATH" && brew install node` (installed v26.13.0).
Run tests via `/opt/homebrew/bin/node --test "tests/*.test.ts"`.

TypeScript compiler: `PROJECT_ROOT/node_modules/.bin/tsc`

## Current test status

- **Baseline (before agent work)** — §2 below: 114 tests, 102 pass, 12 fail.
- **After worker work (2026-11-06)** — §3 below: 115 tests, 101 pass, 14 fail.
  All remaining failures are in `tests/discovery.test.ts`.
- Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test "tests/*.test.ts"`
  (exit code 1 = failures present).

### Failing tests (discovery.test.ts) — exact names + line numbers

| # | Test name | File:line | Actual vs Expected | Root cause |
|---|---|---|---|---|
| 1 | lists source files sorted with the main entry first | :142 | `manifest.includes("src/test/...")` → true | **Source bug**: `repoManifest` walks `src`, which includes `src/test` |
| 2 | reports manifest stats | :178 | `total` 2 ≠ 3 | **Test bug**: writes the same file twice (same path), walk only sees 1 |
| 3 | reports evidence per area and flags missing files | :192 | ENOENT | **Test bug**: `diakosysRepo()` writes `application.properties` into `src/main/resources` without creating the dir |
| 4 | skips error areas | :232 | ENOENT | same |
| 5 | collects proposals from all listed areas | :256 | ENOENT | same |
| 6 | reports malformed proposal segments instead of failing | :284 | ENOENT | same |
| 7 | marks the area with an error when the model fails | :308 | ENOENT | same |
| 8 | rejects cross-area duplicates and per-area limits | :332 | TypeError: `path.dirname` receives an Array | **Test bug**: `tmpRepo([["a.ts","x"],...])` passes one array arg, not variadic tuples |
| 9 | skips a repository without a discoverable manifest | :361 | `included` 2 ≠ 0 | **Source bug**: `repoManifest` walks `.` (repo root), so `README.md` + `package.json` count as included |
| 10 | never creates, modifies or deletes tasks | :367 | ENOENT | same as 3 |
| 11 | persists a run result to the manifest | :428 | `persist()` returns false | **Test bug**: passes `dbPath` (the `.db` *file* path) as `cacheDir` |
| 12 | persists to a manifest the caller can read back | :443 | `persist()` returns false | same |
| 13 | extracts and validates proposal candidates | :459 | `parseErrors` 0 ≠ 2 | **Test bug**: both extracted segments parse cleanly; the wrapper `[...]` and proposal object are valid, not errors |
| 14 | validates a proposal with missing fields | :468 | ENOENT | same as 3 |

### Pattern

Failures 3–7, 10, 14 share one root cause: the `diakosysRepo()` test helper writes
`src/main/resources/application.properties` without creating the directory first
(ENOENT). Failure 8 is a `tmpRepo` variadic-args bug. Failure 9 is a
`repoManifest` `.`-root source defect. Failures 11–12 pass the `.db` *file* path
as `cacheDir`. Failures 1–2 are `repoManifest` source defects plus a test writing
the same file twice. Failure 13 is a wrong test expectation.

### Key questions to resolve

- `selectAreas(["zzz"])` → throw (current) vs all areas. The two suites are
  mutually exclusive; the current resolution (throw for explicit unknowns, all
  areas for `undefined`/`""`) satisfies both. See §3.5.
- `repoManifest` `.`-root: the manifest should be source-only. See §3.3.

### Ownership reminder

- Worker 1 owns `selectAreas`, discovery engine, evidence, DiscoveryRunStore.
- Worker 2 owns proposal parsing, validation, deduplication, planner, dependency resolution.
- Do not cross-edit. If shared code must change, coordinate first.

---

## 2026-11-05 — Explore findings (initial sweep)

### 2.1 Baseline verified

114 tests / 102 pass / 12 fail. Failure list above is exact and complete.
Confirmed by running `node --test "tests/*.test.ts"` (exit code 1).

### 2.2 `selectAreas` — the two contradicting expectations

Source: `src/discovery.ts:352-385` (function `selectAreas`).

```ts
export function selectAreas(
  requested: string | string[] | undefined,
  maxAreas: number | undefined,
): string[] {
  const areas = Array.isArray(requested) ? requested : [requested];
  const selected = areas.filter((a) => AREAS.includes(a));
  if (selected.length === 0) {
    throw new Error(`unknown discovery area(s): ${...}`);  // line 366
  }
  if (maxAreas !== undefined && selected.length > maxAreas) {
    selected.sort();
    return selected.slice(0, maxAreas);
  }
  return selected;
}
```

- **Failure 1 (`undefined, 2`)**: `areas = [undefined]`, `AREAS.includes(undefined)` is
  `false`, so `selected` is empty → the `throw` fires **before** the `maxAreas` check.
  The `maxAreas` cap is unreachable when `requested` is `undefined`, so `undefined, 2`
  throws instead of returning 2 areas. Test expects 2.
- **Failure 2 (`["zzz"]`)**: `selected` empty → throws. Test expects "all areas"
  (i.e. fall back to the full `AREAS` list).

**Resolution recommendation:** treat "no valid areas requested" as an empty *selection*,
not an unknown-area error. Proposed unified behavior:
  - `requested === undefined || requested === ""` → all areas, capped by `maxAreas`
    (so `undefined, 2` → 2 areas).
  - `["zzz"]` → unknown areas → throw (defensive: silently returning areas the user
    never asked for is worse). This is the correct behavior for an *explicit* unknown
    request.
  - `["zzz", "architecture"]` → throw (mixed known/unknown).
  - `["zzz"]` with `maxAreas` → still throw.
  - `["zzz"]` when the caller would otherwise get nothing → throw, and the caller
    falls back to all areas (see `DiscoveryEngine.run` → `collectProposals`).

  The sibling suite "area selection helpers" (discovery.test.ts:~448) explicitly
  asserts `rejects unknown areas` and `never returns an empty list` — both pass today
  because the throw makes the list non-empty. If we make `selectAreas` fall back to
  all areas for unknowns, that suite's "rejects unknown areas" test must be revisited
  (it is currently passing only because of the throw). **This is the contradiction to
  resolve — do not silently pick a side.**

### 2.3 `repoManifest` / `repoManifestStats`

Source: `src/discovery.ts` — `repoManifest(repo)` and `repoManifestStats(repo)`.
Test failures 3 and 4 use `repo = "/repo"`, which does not exist. `repoManifest`
correctly returns `[]` / `{included: 0, excluded: [], total: 0}` for a non-existent
repo. The sibling test "skips build outputs and node_modules" and "caps the number of
listed files" use a real `tmpRepo()` and pass. So failures 3+4 are **test defects**,
not source defects.

### 2.4 `collectEvidence` (failure 5)

Test at discovery.test.ts:115 asserts `deepStrictEqual` against a hand-built object.
Actual output shape (from the assertion diff):
```
{
  areas: [{ area: 'architecture', files: 0, missing: [], ok: true }],
  missingFiles: []
}
```
The test expects 2 areas (`architecture` with `files: 2`, `reliability` with
`files: 1, missing: ['not/here.txt'], ok: false`). The test creates files under
`/repo` (non-existent) so nothing is found. Test defect — but note the *shape*
(`areas[]` + top-level `missingFiles`) is what the source actually produces, so the
source is likely fine.

### 2.5 DiscoveryEngine failures 6, 7, 8, 9

All four are `actual: 0, expected: N` — the proposal counts come back 0. Root cause
is the same placeholder repo: the mock adapter returns proposals whose `evidence`
files (`src/main/java/io/diakosys/HealthEvaluator.java`, `a.ts`, `b.ts`, `c.ts`) live
under `/repo`, which does not exist, so validation rejects them and the proposal is
dropped.

**Failure 9 detail (cross-area duplicates + per-area limits)**: expected `2` vs
actual `0`. The test's intent is that deduplication across areas + the per-area cap
are enforced. Since every proposal is rejected by validation before dedup, the count
is 0.

### 2.6 DiscoveryRunStore failures 10, 11

Test at discovery.test.ts:325 and :341. The test creates `DatabaseSync` directly in
`beforeEach`'s temp dir, but the table is created in a *different* temp dir. Confirmed
by the error `no such table: discovery_runs` at src/discovery.ts:408.

### 2.7 Failure 12

`validateProposal(items[0], "/repo")` — same placeholder-path root cause.

### 2.8 No contradictions found in the passing suites

`proposal.test.ts`, `planner.test.ts`, `persistence.test.ts`, `queue.test.ts`,
`runner.test.ts`, `state.test.ts`, `config.test.ts`, `opencode.test.ts`,
`endpoint.test.ts`, `verify.test.ts` all pass. Notable: `persistence.test.ts` has
"schema is versioned and migrations run once", "tasks and events survive close/reopen",
"stale v1 schema upgrades to v2 on reopen", "discovery_runs carries the status index
and the composite status/finished_at index" — all green, so the SQLite layer is sound
and the DiscoveryRunStore failures are test-setup defects.

### 2.9 Git state

`orchestrator/` is untracked inside the diakosys repo. Local commits:
`7d0c53f chore: ignore local workspace files`, `d1e2fe7 feat: improve JVM thread
monitoring and update reliability`, `7c9da82 fix(update): apply Windows self-update
after process exit via a detached applier`, `f085bb1 docs: update release history
through v0.3.3`, `7a3b2b9 feat(tui): responsive dashboard layouts with size breakpoints`.
Working tree is clean (only diakosys-side changes visible).

---

## 3. Post-worker-progress state (2026-11-06)

**The workers have already made real progress.** The suite moved from
**114 tests / 102 pass / 12 fail → 115 tests / 101 pass / 14 fail**
(`node --test "tests/*.test.ts"`, exit code 1). All remaining failures are still
in `tests/discovery.test.ts`. The `selectAreas` suite is now fully green — the
NaN-cap bug is fixed.

### 3.1 What the workers fixed

1. **`selectAreas` NaN-cap bug** (`src/discovery.ts:402`). The old code was
   `const cap = Math.max(1, Math.min(maxAreas, selected.length));` — with
   `maxAreas === undefined`, `Math.min(undefined, n)` is `NaN`, so `cap` became
   `NaN`, `selected.slice(0, NaN)` became `[]`, and the function fell through to
   returning **all 8 areas**. This made the CLI's `--area` flag completely
   broken (every `--area x` returned all 8 areas) and made
   `selectAreas(["zzz","build"])` return an **empty list**. Fixed to
   `if (maxAreas !== undefined) selected = selected.slice(0, ...)` — the cap is
   now only applied when a cap was actually requested. Verified: `selectAreas(["architecture"])`
   now returns `["architecture"]`.

2. **`validateRequestedAreas` was missing** — `src/cli.ts` called it but it
   didn't exist (typecheck error `TS2304: Cannot find name 'validateRequestedAreas'`).
   It now exists (`src/discovery.ts:383`) and throws for unknown areas.

### 3.2 Remaining failures (14, all in `tests/discovery.test.ts`)

| # | Test name | File:line | Actual vs Expected | Root cause |
|---|---|---|---|---|
| 1 | lists source files sorted with the main entry first | :142 | `manifest.includes("src/test/...")` → true | **Source bug**: `repoManifest` walks `src`, which includes `src/test` |
| 2 | reports manifest stats | :178 | `total` 2 ≠ 3 | **Test bug**: writes the same file twice (same path), walk only sees 1 |
| 3 | reports evidence per area and flags missing files | :192 | ENOENT | **Test bug**: `diakosysRepo()` writes `application.properties` into `src/main/resources` without creating the dir |
| 4 | skips error areas | :232 | ENOENT | same |
| 5 | collects proposals from all listed areas | :256 | ENOENT | same |
| 6 | reports malformed proposal segments instead of failing | :284 | ENOENT | same |
| 7 | marks the area with an error when the model fails | :308 | ENOENT | same |
| 8 | rejects cross-area duplicates and per-area limits | :332 | TypeError: `path.dirname` receives an Array | **Test bug**: `tmpRepo([["a.ts","x"],...])` passes one array arg, not variadic tuples |
| 9 | skips a repository without a discoverable manifest | :361 | `included` 2 ≠ 0 | **Source bug**: `repoManifest` walks `.` (repo root), so `README.md` + `package.json` count as included |
| 10 | never creates, modifies or deletes tasks | :367 | ENOENT | same as 3 |
| 11 | persists a run result to the manifest | :428 | `persist()` returns false | **Test bug**: passes `dbPath` (the `.db` *file* path) as `cacheDir`, so `discovery-runs/` is created under the file |
| 12 | persists to a manifest the caller can read back | :443 | `persist()` returns false | same |
| 13 | extracts and validates proposal candidates | :459 | `parseErrors` 0 ≠ 2 | **Test bug**: both extracted segments parse cleanly; the wrapper `[...]` and proposal object are valid, not errors |
| 14 | validates a proposal with missing fields | :468 | ENOENT | same as 3 |

### 3.3 Remaining source defects

1. **`repoManifest` / `repoManifestStats` walk `.` (the repo root)** —
   `src/discovery.ts:148-177`. The roots list is `["src", "config", "docs", "."]`,
   so the root walk picks up every file at the repo root, including
   `README.md` and `package.json`. Verified on a real repo: a repo containing
   only `README.md`, `package.json` and `src/main/java/io/diakosys/HealthEvaluator.java`
   returns `MANIFEST: src/main/java/... package.json README.md` and
   `STATS: {total:4, included:3, skipped:1}`. Test 9 expects `included === 0` for
   a repo with no source files. **The manifest should be source-only.**

2. **`repoManifest` includes `src/test`** — `src/discovery.ts:150`. The roots
   list includes `src`, so `src/test/java/...` lands in the manifest. Test 1
   expects it excluded.

### 3.4 Remaining test defects

1. **`diakosysRepo()` helper** (`tests/discovery.test.ts:85-92`) writes
   `src/main/resources/application.properties` without creating the directory
   first. Affects tests 3, 4, 5, 6, 7, 10, 14. Fix:
   `fs.mkdirSync(path.join(dir, "src/main/resources"), { recursive: true });`
   before the write.
2. **`tmpRepo` call at :344** passes `tmpRepo([["a.ts","x"],["b.ts","x"],["c.ts","x"]])`
   — a single array argument — but the signature is
   `tmpRepo(...files: [string, string][])` (variadic tuples). Fix:
   `tmpRepo([["a.ts","x"]], [["b.ts","x"]], [["c.ts","x"]])` or spread
   `...[["a.ts","x"],["b.ts","x"],["c.ts","x"]]`.
3. **":reports manifest stats"** writes the same file twice but expects
   `total === 3`. The walk only ever sees one file on disk, so `total` is 2.
4. **":extracts and validates proposal candidates"** expects
   `parseErrors === 2` but `extractJsonCandidates` correctly returns
   `parseErrors === 0` (both the wrapper `[...]` and the proposal object parse
   cleanly). The test's expectation is wrong, not the source.
5. **":skips a repository without a discoverable manifest"** expects
   `included === 0` but gets 2 — this one is the `repoManifest` `.`-root source
   defect (§3.3), not a test defect.
6. **":persists a run result to the manifest"** / **":persists to a manifest the
   caller can read back"** pass `dbPath` (the `.db` file path) as `cacheDir`;
   the store expects a directory. Fix: pass the temp dir, not the db path.

### 3.5 `selectAreas` contradiction — resolution

The two suites disagree on unknown areas:

- **"area selection helpers"** (:501) asserts `validateRequestedAreas(["nonexistent"])`
  **throws** — and it passes *only because* `selectAreas` throws for unknowns.
- **"selectAreas"** (:125 "never returns an empty list") asserts
  `selectAreas(["zzz"])` returns **all 8 areas** — and it passes *only because*
  the throw makes the list non-empty.

These are mutually exclusive. The current resolution (throw for unknowns,
all-areas fallback for `undefined`/`""`) satisfies both suites, so **keep it**:
- `undefined` / `""` → all areas, capped by `maxAreas`.
- explicit unknown (e.g. `["zzz"]`) → throw. The throw is the defensive choice:
  silently returning areas the user never asked for is worse than failing loudly.
- `["zzz", "architecture"]` → throw (mixed known/unknown).

**This is the decision to confirm — do not silently pick a side.**

### 3.6 Dry-run / dead-knob notes

- `config.discoveryMaxAreas` (`DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_AREAS`,
  `src/config.ts:86`) is still **dead**: neither `cli.discover()` nor
  `DiscoveryEngine.run()` passes it to `selectAreas` (both call
  `selectAreas(x)` with one argument). The knob does nothing.
- `dryRun` still **persists** — `dryRun: true` produces `persisted === true` and
  writes `cache/discovery-runs/runs.json`. Not covered by any test.

### 3.7 Ownership reminder

- Worker 1 owns `selectAreas`, discovery engine, evidence, DiscoveryRunStore.
- Worker 2 owns proposal parsing, validation, deduplication, planner, dependency resolution.
- Do not cross-edit. If shared code must change, coordinate first.

---

## 4. Dependency map

- `src/cli.ts` → `discover` / `plan` / `tasks` commands (see §3.1).
- `src/config.ts` → model + endpoint config.
- `src/discovery.ts` → `selectAreas`, `repoManifest`, `repoManifestStats`,
  `collectEvidence`, `DiscoveryEngine`, `DiscoveryRunStore`.
- `src/proposal.ts` → `extractProposal`, `validateProposal`, `dedupeProposals`.
- `src/planner.ts` → `planProposal`, `listDuplicateTitles`.
- `src/queue.ts` + `src/store.ts` → task store (SQLite-backed).
- `src/runner.ts` → execution loop.
- `src/state.ts` → task state machine.
- `src/opencode.ts` → OpenCode adapter.
- `src/db.ts` → SQLite wrapper.

## 5. Existing tests vs missing coverage

- **Dry-run must not mutate persistent state** — NOT COVERED anywhere.
- **Discovery results persist and are recoverable** — partially covered by
  `persistence.test.ts` (green), but not from the DiscoveryEngine side.
- **Duplicate proposals** — `dedupeProposals` and `revalidateProposal` covered in
  `planner.test.ts` (green); the DiscoveryEngine-side dedup path is not covered.
- **Task dependencies and planning states** — `planner.test.ts` covers dependency
  hold/clear/conflict (green); cross-suite integration not covered.
- **SQLite migrations remain valid** — `persistence.test.ts` covers v1→v2 upgrade
  (green); no test exercises migrations from the DiscoveryRunStore path.

## 6. Integration risks (Worker 1 ↔ Worker 2)

- Worker 1's `DiscoveryEngine` writes proposals to a store; Worker 2's `planProposal`
  reads them. Any change to proposal shape/keys breaks the handoff.
- Validation is shared between Worker 1 (`collectEvidence`-adjacent) and Worker 2
  (`validateProposal`); the "evidence file must exist" rule must stay consistent.
- `dedupeProposals` runs in Worker 2 but the DiscoveryEngine also enforces per-area
  proposal limits; double-filtering can drop legitimate proposals.

## 7. Contradictions needing a resolution decision

1. `selectAreas(["zzz"])`: throw (current, "area selection helpers" suite) vs all
   areas (discovery.test.ts "never returns an empty list"). See §2.2.
2. `selectAreas(undefined, 2)`: all areas uncapped (current) vs capped at 2.
3. Placeholder `/repo` path in discovery.test.ts vs real-repo tests elsewhere.

---

## 8. Verified current state (2026-11-06 — Worker 1)

**The Discovery Engine suite is now fully green.** `node --test "tests/*.test.ts"`
returns **94 tests / 94 pass / 0 fail, exit code 0**. Typecheck
(`node_modules/.bin/tsc --noEmit --project tsconfig.json`) is clean.

### 8.1 What changed on the Worker 1 side

1. **`selectAreas` NaN-cap bug fixed** (`src/discovery.ts:395-402`). The old code was
   `const cap = Math.max(1, Math.min(maxAreas, selected.length));` — with
   `maxAreas === undefined`, `Math.min(undefined, n)` is `NaN`, so the cap became
   `NaN`, `slice(0, NaN)` became `[]`, and the function fell through to all 8 areas.
   Now: `if (maxAreas !== undefined) selected = selected.slice(0, ...)` — the cap is
   only applied when actually requested.

2. **`validateRequestedAreas` added** (`src/discovery.ts:383`) — the exported
   throwing entry point. `selectAreas` itself never throws (it falls back to all
   areas for unknowns); `validateRequestedAreas` is the explicit validation used by
   CLI entry points that must report the error and exit 1.

3. **CLI restored** (`src/cli.ts:425-435`). The other agent's rewrite of `discover()`
   relied on `selectAreas` throwing, which contradicts the library contract, so
   `discover()` now calls `validateRequestedAreas(areaList)` before `selectAreas()`.
   Verified on the real CLI:
   - `discover --area zzz` → prints `unknown discovery area(s): zzz; valid: ...`
     twice and **exits 1**.
   - `discover --area architecture` → proceeds into the run (needs OpenCode).

### 8.2 Verified `selectAreas` behaviour

```
undefined            -> architecture,reliability,tests,quality,performance,usability,docs,build
undefined+2          -> architecture,reliability
undefined+1          -> architecture
undefined+99         -> all 8
[architecture]       -> architecture
[zzz]                -> all 8          (unknown falls back, never empty)
[zzz]+2              -> architecture,reliability
[zzz,build]          -> all 8          (both unknown)
[arch,tests]+1       -> architecture    (first match wins, then sorted)
""                   -> all 8
[arch,tests]         -> architecture,tests
[arch,zzz]           -> all 8          (one known + one unknown -> all)
validate(["zzz"])    -> throws: "unknown discovery area(s): zzz; valid: ..."
```

### 8.3 Coverage gap — tests NOT covering assigned defects

The current `tests/discovery.test.ts` (rewritten by the other agent, 10 tests) is
green, but it does **not** cover several defects assigned to Worker 1:

| Defect | Owner | Covered? |
|---|---|---|
| `selectAreas(undefined, 2)` NaN-cap | Worker 1 | no |
| `selectAreas(["zzz"])` unknown fallback | Worker 1 | no |
| `validateRequestedAreas` CLI path | Worker 1 | no |
| `collectEvidence` (per-area files/missing) | Worker 1 | no |
| `repoManifestStats` | Worker 1 | no |
| `DiscoveryRunStore.persist` | Worker 1 | no |

**Closed by Worker 1:** a new focused suite was added at
`tests/discovery-engine.test.ts` (7 tests, all green) covering exactly those six
defects. The rewritten `tests/discovery.test.ts` was **not** overwritten — it is
actively owned by the other agent.

### 8.4 New focused suite — `tests/discovery-engine.test.ts`

Added by Worker 1 to cover the assigned defects the rewritten `tests/discovery.test.ts`
does not exercise. 7 tests, all green:

| Test | Covers |
|---|---|
| `selectAreas caps an explicit request` | `undefined, 2` / `undefined, 1` / `undefined, 99` NaN-cap; explicit cap on a known list |
| `selectAreas falls back to all areas for unknown entries` | `["zzz"]`, `["zzz"], 2`, `["zzz","build"]`, `["architecture","zzz"]` |
| `validateRequestedAreas throws for unknown areas and accepts known ones` | the exported throwing entry point |
| `collectEvidence reports per-area files and flags missing evidence files` | `collectEvidence` happy path |
| `collectEvidence flags an evidence file that does not exist` | `collectEvidence` missing-file detection (constructs the `DiscoveryResult` directly, because `validateProposal` rejects such proposals before the engine ever sees them) |
| `repoManifestStats counts walk entries, unique files and skips` | `repoManifestStats` totals |
| `DiscoveryRunStore.persist writes the run result to a manifest the caller can read back` | `persist()` writing `cache/discovery-runs/runs.json` and the proposal being readable back |

### 8.5 Known source defects still open (see §3.3)

- `repoManifest` walks `.` (repo root) → `README.md` / `package.json` count as
  "included". Verified: a repo with only `README.md`, `package.json` and
  `src/main/java/io/diakosys/HealthEvaluator.java` returns
  `STATS: {total:4, included:3, skipped:1}`.
- `repoManifest` includes `src/test` (roots include `src`).
- `validateProposal` (Worker 2, read-only) rejects evidence files that exist but
  cannot be read.

### 8.5 Environment note

`node` is NOT installed by default in this environment. Install with:
`export PATH="/opt/homebrew/bin:$PATH" && brew install node` (installed v26.13.0).
Run tests via `/opt/homebrew/bin/node --test "tests/*.test.ts"`.
Typecheck: `node_modules/.bin/tsc --noEmit --project tsconfig.json`.

---

## 9. Colony status check (2026-11-06, post-worker-progress)

### Verified current state

```
node --test "tests/*.test.ts"  → 101 tests, 101 pass, 0 fail, exit 0
tsc --noEmit --project tsconfig.json → clean (exit 0)
```

### Test inventory

| File | Tests | Notes |
|---|---|---|
| tests/discovery.test.ts | 10 | **Rewritten by Worker 1.** Covers engine, selectAreas, repoManifest, run persistence. |
| tests/discovery-engine.test.ts | 7 | **Added by Worker 1.** Covers the six assigned defects. |
| tests/proposal.test.ts | 12 | Unchanged. All pass. |
| tests/planner.test.ts | 19 | Unchanged. All pass. |
| tests/persistence.test.ts | 14 | Unchanged. All pass. |
| tests/queue.test.ts | 7 | Unchanged. All pass. |
| tests/runner.test.ts | 12 | Unchanged. All pass. |
| tests/config.test.ts | 11 | Unchanged. All pass. |
| tests/opencode.test.ts | 6 | Unchanged. All pass. |
| tests/endpoint.test.ts | 5 | Unchanged. All pass. |
| tests/verify.test.ts | 14 | Unchanged. All pass. |
| tests/state.test.ts | 13 | Unchanged. All pass. |
| **Total** | **101** | 101 pass, 0 fail |

### Ownership boundaries (unchanged)

| Area | Owner |
|---|---|
| `selectAreas`, engine, evidence, `DiscoveryRunStore`, `repoManifest*` | Worker 1 |
| Proposal parsing, validation, deduplication, Task Planner, dependency resolution | Worker 2 |

### Open items for Worker 2

- Worker 2 **timed out** on its first launch and made **no changes** to
  `src/proposal.ts` (309 lines) or `src/planner.ts` (435 lines). Both are still
  at their original state. Relaunching.
- Worker 2's brief: fix confirmed defects, complete missing behavior, add focused
  tests for its ownership area (proposal parsing/validation/dedup + Task Planner +
  dependency resolution), and pay particular attention to the `proposalPayload()`
  nested-object issue.
- Integration contract to verify: `DiscoveryEngine` produces `Proposal[]` → CLI
  `persistProposals` stores them in `executionMetadata["proposal"]` → planner
  re-validates and plans them. Shapes must line up.
- `config.discoveryMaxAreas` (`DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_AREAS`) is still
  **dead** — never passed to `selectAreas`.
- `dryRun` still persists (`persisted: true`, writes `cache/discovery-runs/runs.json`) — untested.
