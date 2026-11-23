# Work Checkpoint

## Current Task
Fix three failing tests in Diakosys:
1. "discover releases the coordinator lock when discovery throws" - adapter teardown error not propagating
2. "discover --dry-run --area quality --lifecycle logs the audit-completed event with final counts" - 24 vs 20 events
3. "discover --dry-run --verbose exposes the same detailed lifecycle and stage events" - 24 vs 20 events

## Task Objective
Identify and fix the root causes of the failing tests without modifying test expectations.

## Inspected Sources
| File | Symbols / Sections | Findings |
|---|---|---|
| tests/cli.test.ts | 1533-1560 | Test "discover releases the coordinator lock when discovery throws" expects adapter teardown error to propagate |
| tests/cli.test.ts | 1922-1960 | Lifecycle test expects 20 lines, getting 24 |
| tests/cli.test.ts | 1943-1965 | Verbose test expects 20 lines, getting 24 |
| src/cli.ts | 795-840 | discover() function with adapter parameter |
| src/cli.ts | 847 | lifecycle?.start("discover", "audit", ...) |
| src/cli.ts | 912 | lifecycle?.complete("discover", "audit", ...) |
| src/discovery.ts | 825-830 | run() emits lifecycle events |
| src/discovery.ts | 959 | runArea() lifecycle("INFO", "area", "started", ...) |
| src/discovery.ts | 1118 | lifecycle("INFO", "model-request", "pending", ...) |
| src/discovery.ts | 1186 | lifecycle("INFO", "model-request", "completed", ...) |
| src/discovery.ts | 1259 | lifecycle("INFO", "parse", "completed", ...) |
| src/discovery.ts | 1265 | lifecycle("INFO", "area", "completed", ...) |
| src/stages.ts | 14-22 | STAGE_NAMES with 13 stage events |
| src/opencode.ts | 545-572 | MockOpenCodeAdapter.prompt() - does NOT return turnStats |

## Confirmed Findings
### Test 1: adapter teardown error
- The test calls `discover(["--area", "tests"], new ThrowingCloseAdapter(() => MOCK_DISCOVERY_REPLY))`
- The adapter's close() method throws "adapter teardown failed"
- The error is NOT being thrown to the test
- Looking at cli.ts:837-840, the adapter.close() is called in a finally block and should throw
- The test expects `await assert.rejects(teardown, /adapter teardown failed/)`
- Possible cause: The test is using `discover(["--area", "tests"], ...)` but the adapter parameter might not be used correctly

### Test 2 & 3: lifecycle event count
- Test expects 20 lifecycle lines, gets 24
- For dry run with one area (quality):
  - DiscoveryEngine emits: run started, area started, model-request pending, model-request completed, parse completed, area completed = 6 events
  - CLI emits: audit started, audit completed = 2 events
  - StageLogger emits: 13 stage events
  - Total: 6 + 2 + 13 = 21 events
- But test is getting 24, meaning 3 extra events somewhere
- Possible causes:
  1. `model-request turn-stats` event being emitted even though mock adapter doesn't return turnStats
  2. Some other event being emitted multiple times
  3. The test is counting non-lifecycle lines incorrectly

## Decisions
- Need to add debug logging to capture all emitted events
- Need to verify the adapter parameter is being passed correctly to discover()
- Need to identify which 3 extra events are being emitted

## Pending Work
1. Add debug logging to DiscoveryEngine lifecycle() method to capture all emitted events
2. Run the failing tests with debug logging to see the actual event sequence
3. Compare the emitted events against expected events to identify duplicates
4. Fix the adapter parameter handling in cli.ts discover() function
5. Fix any duplicate event emissions discovered in step 2-3
6. Run all 471 tests to verify fixes

## Verification
- Test command: `npm test tests/cli.test.ts -g "discover.*lifecycle|discover releases"`
- Expected: 20 lifecycle lines for dry run with one area
- Actual: 24 lifecycle lines being emitted
- Test for adapter teardown should reject with "adapter teardown failed"

## Constraints
- Minimal changes only.
- Do not modify test expectations.
- Do not stage, commit, push, or reset Git.
- Never claim unverified results.

## Last Updated
2026-11-22 - Initial investigation started
