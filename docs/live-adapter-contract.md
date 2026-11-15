# LiveOpenCodeAdapter — HTTP contract (stub-verified)

Status: **harness-verified contract** (Stage 10.1). Every item in §1 is pinned by
`tests/live-adapter.test.ts`, which drives the real adapter against a local stub
HTTP server (`localhost`, ephemeral port) while the SDK's `createOpencodeServer`
is replaced by loader hooks (`tests/sdk-stub-hooks.mjs`) and
`createOpencodeClient` remains the **real** SDK client.

**What this proves and what it does not prove.** These tests verify the
orchestrator↔SDK client contract and the request/response shapes the adapter
actually consumes. They do **not** prove compatibility with a real `opencode`
binary, a real OpenCode server, or a live llama.cpp model server — those are
SDK-dependent and real-process behaviors (§2/§3) and remain unverified by
construction: the harness never spawns real processes and never leaves
localhost.

## 1. Verified behavior (pinned by tests)

Adapter lifecycle

- `start()` lazily creates one server handle + client; a second `probe()`/`prompt()`
  reuses the same handle (`createServerCalls` stays 1). After `close()`, the next
  call acquires a **new** handle; `close()` releases the handle exactly once and
  resets `activeSessionId()` to `undefined`.
- The fake `createOpencodeServer(options)` receives the adapter's options
  (`hostname: "localhost"`, `port`, `startupTimeoutMs`); captured by the stub.

Probe (`doctor` path)

- `probe()` → `GET /agent` with `?directory=<projectDirectory>` appended by the
  SDK client's directory interceptor; returns the server URL on 2xx.
- Non-2xx → rejects `opencode agents probe failed: {json}` (the parsed error body
  is embedded verbatim).

Prompt flow (per prompt, in order)

1. `POST /session` with JSON body `{}` → 200 `{ id: "ses_…" }`. Non-2xx → rejects
   `failed to create opencode session: {json}`; **no prompt and no event stream
   follow**.
2. The SSE stream object is obtained via `client.event.subscribe({})` — note:
   `subscribe()` performs **no HTTP request yet**; the underlying `GET /event`
   connection is opened lazily when the `for await` loop starts (after
   `promptAsync` is accepted).
3. `POST /session/{id}/prompt_async` with query `directory=<projectDirectory>` and
   JSON body `{ model: { providerID, modelID }, agent?, tools?, parts: [{ type:
   "text", text }] }` where `text` is `Task: <title>` plus, when the description
   is non-empty, `\nDescription:\n<description>`. Response `204` (empty body) is
   treated as accepted (`accepted.error` undefined). Non-2xx → rejects
   `opencode promptAsync failed: {json} (session <id>)` and **no messages are
   read**.
4. `GET /event` (SSE): frames are split on blank lines; `data:` lines are
   JSON-parsed and yielded. `{"type":"session.idle","properties":{"sessionID":
   <id>}}` ends the loop successfully; `{"type":"session.error",…}` ends it with
   the error message surfaced; a stream that **ends without `session.idle`**
   fails with `opencode prompt timed out after <promptTimeoutMs>ms`.
5. `GET /session/{id}/message` → array of `{ info, parts }`. The adapter takes the
   **last** message with `info.role === "assistant"`, joins the `text` fields of
   its parts with spaces (tool parts are skipped for the text but passed through
   in `raw.parts`), and maps `info.finish`/`info.role` into the result
   (`{ sessionId, finish, role, text, raw: { info, parts } }`).
   A failed messages read is retried: up to **5 attempts**, **1 s** apart
   (deterministic 1-retry case pinned; the 5-attempt cap is verified in source,
   not by a 5 s test).
- `activeSessionId()` is set as soon as the session is created (before the prompt
  is sent) and survives prompt completion.
- `abort()` → `POST /session/{id}/abort`; without an argument it targets the
  active session, with an explicit id it targets that id; with no active session
  (or before `start()`) it sends **nothing**; HTTP errors are swallowed
  (aborting a finished session is fine).
- `abort()` while a prompt is in flight names the in-flight session and does not
  cancel the in-flight HTTP call; the prompt still resolves. Discarding late
  results after lease loss is the **runner's** responsibility (covered by
  `tests/runner.test.ts`), not the adapter's.

Error handling / timeouts

- HTTP errors surface as rejections whose messages embed the parsed error body
  (non-2xx is a result envelope `{ error: parsedBody }` in the SDK, not an
  exception).
- The prompt timeout is enforced by the adapter's own timer via the SSE iterator;
  there is no client-side fetch timeout (`req.timeout = false` in the SDK client).

Doctor probe flow (subprocess, real CLI)

- `node --import tests/sdk-stub-register.mjs src/cli.ts doctor` with the stub
  running: `doctor` reports `ok  opencode — http://localhost:<port>` and exits 0;
  `createOpencodeServer` was invoked inside the real CLI process (options
  captured via the stub's `/__hook__/server-options` sink).
- A failing `/agent` probe: `doctor` marks the check `fail`, prints
  `fail  opencode — agents probe failed: …` and exits 1.

## 2. SDK-dependent behavior (observed in @opencode-ai/sdk 1.19.3 source; not
   exercised against a real process)

- The real `createOpencodeServer` spawns the **`opencode serve` binary** via
  `cross-spawn` (`--hostname`, `--port`), passes config through the
  `OPENCODE_CONFIG_CONTENT` env var, parses the listening URL from stdout
  (`opencode server listening on <url>`), and enforces a startup timeout; its
  `close()` kills the child process.
- The SSE client retries failed `/event` connections with exponential backoff
  (default 3 s base, doubling, 30 s cap, unlimited attempts unless
  `sseMaxRetryAttempts` is set) — the adapter-level timeout is the practical
  bound.
- The SDK client disables hey-api's default request timeout
  (`req.timeout = false`); non-2xx responses become `{ error: body }` envelopes
  (the `wrapClientError` interceptor only fires with `throwOnError`, which the
  adapter does not use).

## 3. Unverified real-process integration

- That a real `opencode serve` (any version) accepts the request shapes above.
- That a real llama.cpp/OpenAI-compatible model server answers the provider
  requests the binary initiates.
- That SSE semantics of the real server (event ordering, replay, keep-alive)
  match the stub's minimal stream.
- That credentials/config content never leaks through the real server spawn
  (the config is passed via env; no logging claim is testable at stub level).

## 4. Endpoint override wiring (fixed in Stage 10.1.1)

**History.** Stage 10.1 discovered that `LiveOpenCodeAdapter`'s constructor did
not copy `options.endpoint` into `this.options`, making `start()`'s guard
`this.options.endpoint !== undefined` always false: the override was silently
ignored, `configWithEndpoint()` was unreachable, and `doctor`'s
`endpoint: config.endpoint` was dropped without error.

**Current verified behavior** (pinned by `tests/live-adapter.test.ts`):

- With an endpoint override, `start()` runs `configWithEndpoint()`
  (`$HOME/.config/opencode/opencode.json`, provider taken from the model
  string) and passes the result to `createOpencodeServer`:
  `provider.<providerID>.options.baseURL` is forced to the override,
  `provider.<providerID>.options.timeout` is `false`, unrelated provider
  options (`apiKey`, `npm`, …) and top-level config keys are preserved.
- With an override but no parsable provider block, `start()` fails loudly
  (`cannot honor endpoint override: no parsable provider "<provider>" block …`)
  and no server is created.
- Without an override, `config` stays `undefined` and `createOpencodeServer` is
  called exactly as before — default behavior unchanged.
- The full CLI chain is pinned end-to-end: `DIAKOSYS_ENDPOINT` →
  `resolveConfig` → doctor's `endpoint: config.endpoint` → adapter →
  `createOpencodeServer` options captured from a real CLI subprocess.

## Harness mechanics (for maintainers)

- `tests/sdk-stub-hooks.mjs` — module loader hooks: `"@opencode-ai/sdk"` →
  virtual stub module (`createOpencodeServer` → fake handle backed by
  `globalThis.__diakosysSdkStub`, which the test configures with the stub URL);
  `"@opencode-ai/sdk-real"` → the real SDK entry (re-exported as
  `createOpencodeClient`). The hook exists because ESM namespace exports are
  immutable and the real `createOpencodeServer` spawns a real process.
- `tests/sdk-stub-register.mjs` — `register()` entry for subprocess runs
  (`node --import`), used by the doctor tests; it seeds the holder from
  `DIAKOSYS_TEST_SDK_STUB_URL`.
- The stub server: binds `localhost:0` (ephemeral), captures every request
  (method/path/query/headers/body), serves deterministic responses incl.
  controlled delays, SSE modes (`idle-after-prompt` / `error-after-prompt` /
  `end-without-idle`), and failure statuses; teardown ends timers, closes all
  connections and the server. No external network access; no real OpenCode or
  model-server processes are ever started.
