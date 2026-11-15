# Diakosys

**Diakosys** is a persistent task-queue orchestrator with OpenCode execution — an autonomous engineering workflow engine that goes from discovery and planning to execution and verification.

A configured model inspects the repository in read-only mode (**discovery**) and proposes concrete improvements as validated proposals. The **planner** validates those proposals, resolves dependencies, and queues them as tasks. The **runner** executes queued tasks through an OpenCode-backed model session, and a **verification** pass records the outcome (`--pass` / `--fail`) before a task is done. All state lives in a local SQLite database; leases, coordinator locks and crash recovery make concurrent or interrupted runs safe to recover from.

## Task lifecycle

```
DISCOVERED → BACKLOG → READY → IN_PROGRESS → REVIEW → VERIFYING → DONE
                                  │
                     side states: BLOCKED, FAILED (retries back to BACKLOG)
```

- **BLOCKED** unblocks to `READY` (or returns to `BACKLOG`).
- **FAILED** tasks are retried through `recover` or `task retry` (a backoff schedule applies; the attempt cap is never bypassed).
- Crash recovery: an expired `IN_PROGRESS` lease returns the task to `READY`; interrupted discovery runs are marked interrupted only with explicit confirmation (`--confirm-unsafe`).

## Requirements

- **Node.js ≥ 24** — the CLI runs TypeScript directly (type stripping) and uses the built-in `node:sqlite`.
- For live (non-mock) execution and discovery:
  - the **`opencode` CLI** available on `PATH` (the orchestrator starts it headless as `opencode serve --hostname=… --port=…`), and
  - an **OpenAI-compatible model endpoint**. The documented safe default is a llama.cpp server on the same machine: `http://localhost:8082/v1`.
- `--mock` modes (`doctor --mock`, `run --mock`, `cycle --mock`) need neither `opencode` nor a model server and work fully offline.

## Installation

```sh
git clone <repo-url>
cd <repo-dir>
npm install
```

No build step is required to run the CLI:

```sh
npm start                 # runs: node src/cli.ts
# or directly:
node src/cli.ts help
```

`npm run build` only emits TypeScript declaration files into `dist/` (`emitDeclarationOnly`); it is not needed for execution.

## Usage

```
Usage: orchestrator <command> [options]

  doctor                      Check runtime, config, database and OpenCode connectivity

  status                      Task counts by state
  task add <title> [--description <text>] [--priority <n>] [--state <s>]
  task list [--state <s>]     List stored tasks
  task show <id>              Show a task and its event history
  task verify <id> --pass|--fail [--note <text>]
                              Record the verification outcome (VERIFYING → DONE/FAILED)
  task retry <id> [--confirm-unsafe]
                              Manually requeue a FAILED task (bypasses backoff, never the
                              attempt cap; ambiguous/legacy failures need --confirm-unsafe)
  recover [--confirm-unsafe]  Coordinator-guarded recovery pass: re-stamp interrupted leases,
                              schedule/requeue retries; discovery runs left 'running' by a
                              crash are interrupted only with --confirm-unsafe
  run [--mock] [--max <n>]    Execute up to n queued tasks (default 1); --mock uses a test adapter

Discovery and planning (read-only analysis, no auto-execution):
  discover [--dry-run] [--area a,b,...]
                              Inspect the repo with the configured model in read-only mode
  plan                        Validate discovered proposals; queue dependency-ready ones
                              Takes no arguments: any --flag is rejected before the database opens
  cycle [--mock] [--max-executions <n>] [--max-rounds <n>] [--no-discovery]
                              One composed orchestration pass: discover → plan →
                              execute → verify → DONE/FAILED. --mock uses test adapters
                              (add --mock-fail to make verification fail deterministically)
  tasks [--state <s>]         Tasks with priority, status and dependencies
```

Notes:

- `help`, no arguments, or `-h`/`--help` on any command print usage without opening the database.
- Every write command (`run`, `plan`, `discover`, `recover`, `task retry`, `cycle`) acquires a coordinator instance lock on the database; a second orchestrator on the same database is refused with a descriptive error.
- `--lifecycle` is an opt-in flag on `run`, `plan`, `cycle` and `discover` that streams real-time lifecycle events to stdout; without it, the scripted stdout contract is unchanged.
- `plan` reads whatever discovery already persisted — it never talks to the model.

### Examples

Fully offline smoke run (mock discovery, mock execution, mock verification):

```sh
DIAKOSYS_ORCHESTRATOR_DB=/tmp/diakosys-smoke/tasks.db npm start -- cycle --mock
```

Check the local setup without touching a live model server:

```sh
DIAKOSYS_ORCHESTRATOR_DB=/tmp/diakosys-smoke/tasks.db npm start -- doctor --mock
```

Inspect the queue:

```sh
npm start -- status
npm start -- tasks
npm start -- task show <id>
```

Read-only discovery dry run against a live model endpoint:

```sh
npm start -- discover --dry-run --area src,docs
```

## Configuration

Machine-specific settings live in `~/.config/diakosys/config.json` (`endpoint`, `port`). Precedence: `DIAKOSYS_ENDPOINT` environment variable → config file → documented safe default (`http://localhost:8082/v1`). Point the model server at localhost on the machine that runs the CLI; no machine address is stored in this repository's sources.

### Environment variables

| Variable | Purpose / default |
|---|---|
| `DIAKOSYS_ORCHESTRATOR_DB` | SQLite database path. Default: `$XDG_DATA_HOME/diakosys-orchestrator/tasks.db`, i.e. `~/.local/share/diakosys-orchestrator/tasks.db` |
| `DIAKOSYS_ORCHESTRATOR_MODEL` | Full model string (wins over the provider/model-id pair) |
| `DIAKOSYS_ORCHESTRATOR_PROVIDER` + `DIAKOSYS_ORCHESTRATOR_MODEL_ID` | Provider/model-id pair. Defaults: `mimo-llama-m5` / `mimo-2.6-9b-q6` |
| `DIAKOSYS_ORCHESTRATOR_AGENT` | Agent used for execution sessions |
| `DIAKOSYS_ORCHESTRATOR_PROJECT_DIR` | Repository the orchestrator works on. Default: current working directory |
| `DIAKOSYS_ORCHESTRATOR_PORT` | Port the spawned OpenCode server binds to. Default: `4096` |
| `DIAKOSYS_ORCHESTRATOR_PROMPT_TIMEOUT_MS` | Per-prompt timeout. Default: `600000` (10 min) |
| `DIAKOSYS_ORCHESTRATOR_LEASE_TTL_MS` / `DIAKOSYS_ORCHESTRATOR_LOCK_TTL_MS` | Task-lease and coordinator-lock TTLs (derive from the prompt timeout when unset) |
| `DIAKOSYS_ORCHESTRATOR_RETRY_MAX_ATTEMPTS` / `_BASE_MS` / `_MAX_MS` | Retry policy: attempt cap, base backoff, backoff cap |
| `DIAKOSYS_ORCHESTRATOR_RECOVER_ON_START` | Boolean (default `true`); when `false`, `cycle` skips its startup recovery pass |
| `DIAKOSYS_ENDPOINT` | Highest-precedence model endpoint override |

Numeric values are parsed strictly; invalid values fail explicitly instead of falling back silently.

## Development

```sh
npm install          # install dependencies
npm test             # full suite: node --test "tests/*.test.ts"
npm run typecheck    # tsc --noEmit --project tsconfig.json
npm run build        # declaration-only emit into dist/
node --test tests/cli.test.ts   # a single test file
```

The test suite is self-contained: it uses temporary databases, mock adapters and a stubbed SDK, so it never touches your real database, home directory or a live model server.

Further developer documentation:

- `docs/live-adapter-contract.md` — the OpenCode adapter/server contract (spawn, readiness, auth, teardown).
- `docs/agent-colony.md` — internal multi-agent development notes (not user documentation).

## License

[Apache-2.0](LICENSE)
