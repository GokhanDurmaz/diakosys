import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { LiveOpenCodeAdapter } from "../src/opencode.ts";
import { installFakeSpawn } from "./fake-opencode-spawn.ts";

/**
 * Stage 10.1 — Live adapter contract harness.
 *
 * `LiveOpenCodeAdapter` is driven against a local stub HTTP server bound to
 * localhost on an ephemeral port, speaking the wire protocol observed in
 * @opencode-ai/sdk 1.19.3 (see docs/live-adapter-contract.md). The SDK's
 * `createOpencodeServer` — which in production spawns the real `opencode serve`
 * binary — is intercepted by the loader hooks in tests/sdk-stub-hooks.mjs
 * (registered below) and replaced with a fake handle pointing at the stub,
 * while `createOpencodeClient` remains the REAL SDK client. No real OpenCode
 * process, model server, credential or external network call is ever made.
 *
 * ESM namespace exports are immutable, so a loader hook is the only clean
 * interception point that avoids both a real process spawn and any production
 * source modification.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register(new URL("./sdk-stub-hooks.mjs", import.meta.url));
// The server spawn moved into src/opencode-server.ts (shared by both CLI
// generations), which the SDK loader hook above cannot intercept. Install the
// in-process fake spawn — same __diakosysSdkStub holder contract — so no real
// `opencode serve` binary is started. The "opencode "-prefixed banner keeps
// the facade's protocol detection on the v1 backend.
installFakeSpawn({ bannerPrefix: "opencode " });

const execFileP = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ——— stub holder (shared with the virtual stub module on globalThis) ———

interface StubHolder {
  url: string;
  serverOptions?: Record<string, unknown>;
  createServerCalls: number;
  closeCalls: number;
}

function setHolder(url: string): void {
  (globalThis as { __diakosysSdkStub?: StubHolder }).__diakosysSdkStub = {
    url,
    createServerCalls: 0,
    closeCalls: 0,
  };
}

function holder(): StubHolder {
  const h = (globalThis as { __diakosysSdkStub?: StubHolder }).__diakosysSdkStub;
  if (h === undefined) throw new Error("stub holder not configured");
  return h;
}

function clearHolder(): void {
  delete (globalThis as { __diakosysSdkStub?: unknown }).__diakosysSdkStub;
}

// ——— local stub HTTP server ———

interface CapturedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface StubOptions {
  /** Failure status for POST /session (session create). */
  createStatus?: number;
  /** Failure status for POST /session/{id}/prompt_async. */
  promptStatus?: number;
  /** Failure status for GET /agent (probe). */
  agentsStatus?: number;
  /** Failure status for POST /session/{id}/abort. */
  abortStatus?: number;
  /** Controlled delay before the prompt_async response. */
  promptDelayMs?: number;
  /** SSE stream behavior for GET /event. */
  sseMode: "idle-after-prompt" | "error-after-prompt" | "end-without-idle";
  /** For end-without-idle: how long the stream stays open before ending. */
  sseEndAfterMs?: number;
  /** Queued responses for GET /session/{id}/message (default: success). */
  messagesResponses?: Array<{ status: number; body?: unknown }>;
}

interface StubHandle {
  url: string;
  port: number;
  requests: CapturedRequest[];
  serverOptionPosts: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** The messages payload a completed stub session exposes: an earlier user
 *  message followed by the final assistant message with text AND tool parts,
 *  pinning "last assistant message wins" and tool-part passthrough. */
const defaultMessages = (): unknown => [
  {
    info: { role: "user", finish: null },
    parts: [{ type: "text", text: "earlier user message must be skipped" }],
  },
  {
    info: { role: "assistant", finish: "stop" },
    parts: [
      { type: "text", text: "stub reply part one" },
      { type: "tool", tool: "read", state: { status: "completed", output: "file contents" } },
      { type: "text", text: "part two" },
    ],
  },
];

async function startStub(options: StubOptions): Promise<StubHandle> {
  const requests: CapturedRequest[] = [];
  const serverOptionPosts: Array<Record<string, unknown>> = [];
  const sseTimers: NodeJS.Timeout[] = [];
  let sessionCounter = 0;
  let lastSessionId = "";
  let promptAsyncSeen: (() => void) | undefined;
  const promptAsyncPromise = new Promise<boolean>((resolve) => {
    promptAsyncSeen = () => resolve(true);
  });

  const respondJson = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({
        method: req.method ?? "",
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      });

      if (req.method === "POST" && url.pathname === "/session") {
        if (options.createStatus !== undefined) {
          respondJson(res, options.createStatus, { name: "http_error", data: { message: "session create rejected" } });
          return;
        }
        sessionCounter += 1;
        lastSessionId = `ses_stub_${String(sessionCounter).padStart(3, "0")}`;
        respondJson(res, 200, { id: lastSessionId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (options.sseMode === "idle-after-prompt") {
          const sawPrompt = await Promise.race([promptAsyncPromise, sleep(3_000).then(() => false)]);
          if (sawPrompt) {
            res.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: lastSessionId } })}\n\n`);
          }
          res.end();
          return;
        }
        if (options.sseMode === "error-after-prompt") {
          await Promise.race([promptAsyncPromise, sleep(3_000)]);
          res.write(
            `data: ${JSON.stringify({
              type: "session.error",
              properties: { sessionID: lastSessionId, error: { name: "stub_error", message: "stream failed" } },
            })}\n\n`,
          );
          res.end();
          return;
        }
        // end-without-idle: hold the stream open, then end it without ever
        // emitting session.idle — the adapter must fail on its own timeout
        sseTimers.push(setTimeout(() => res.end(), options.sseEndAfterMs ?? 300));
        return;
      }

      if (req.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
        promptAsyncSeen?.();
        if (options.promptDelayMs !== undefined) await sleep(options.promptDelayMs);
        if (options.promptStatus !== undefined) {
          respondJson(res, options.promptStatus, { name: "http_error", data: { message: "prompt rejected" } });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && /^\/session\/[^/]+\/message$/.test(url.pathname)) {
        const next = options.messagesResponses?.shift();
        if (next !== undefined) {
          respondJson(res, next.status, next.body ?? { name: "http_error", data: { message: "messages rejected" } });
          return;
        }
        respondJson(res, 200, defaultMessages());
        return;
      }

      if (req.method === "POST" && /^\/session\/[^/]+\/abort$/.test(url.pathname)) {
        if (options.abortStatus !== undefined) {
          respondJson(res, options.abortStatus, { name: "http_error", data: { message: "abort rejected" } });
          return;
        }
        respondJson(res, 200, {});
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent") {
        if (options.agentsStatus !== undefined) {
          respondJson(res, options.agentsStatus, { name: "http_error", data: { message: "agents rejected" } });
          return;
        }
        respondJson(res, 200, [{ name: "build" }]);
        return;
      }

      if (req.method === "POST" && url.pathname === "/__hook__/server-options") {
        try {
          serverOptionPosts.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          serverOptionPosts.push({});
        }
        respondJson(res, 200, {});
        return;
      }

      if (req.method === "POST" && url.pathname === "/__hook__/server-closed") {
        respondJson(res, 200, {});
        return;
      }

      respondJson(res, 404, { name: "not_found", data: { message: `no route: ${req.method} ${url.pathname}` } });
    })().catch((err) => {
      try {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      } catch {
        // noop
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => resolve());
  });
  const address = server.address() as { port: number };

  return {
    url: `http://localhost:${address.port}`,
    port: address.port,
    requests,
    serverOptionPosts,
    close: async () => {
      for (const timer of sseTimers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ——— adapter + assertion helpers ———

function makeAdapter(overrides: Partial<ConstructorParameters<typeof LiveOpenCodeAdapter>[0]> = {}): LiveOpenCodeAdapter {
  return new LiveOpenCodeAdapter({
    projectDirectory: "/tmp/diakosys-stub-project",
    model: "Qwen-Mimo/model.gguf",
    startupTimeoutMs: 2_000,
    promptTimeoutMs: 5_000,
    ...overrides,
  });
}

const PROMPT_INPUT = {
  title: "stub task",
  description: "does stub things",
  directory: "/tmp/diakosys-stub-project",
} as const;

const findRequest = (stub: StubHandle, pred: (r: CapturedRequest) => boolean): CapturedRequest | undefined =>
  stub.requests.find(pred);

const findPromptAsync = (stub: StubHandle): CapturedRequest | undefined =>
  findRequest(stub, (r) => r.method === "POST" && /\/prompt_async$/.test(r.pathname));

const messageReads = (stub: StubHandle): CapturedRequest[] =>
  stub.requests.filter((r) => r.method === "GET" && /\/message$/.test(r.pathname));

/** Guard against hangs: the adapter's timeout semantics rely on the SSE
 *  iterator ending, so a stuck stream must fail the test, not the suite. */
async function withDeadline<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`test deadline exceeded: ${label} (${String(ms)}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(5);
  }
  return true;
}

// ——— behavioral tests ———

test("probe succeeds against the stub, reports its url and reuses the server handle", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt" });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    const url = await adapter.probe();
    assert.equal(url, stub.url);
    const agents = findRequest(stub, (r) => r.method === "GET" && r.pathname === "/agent");
    assert.ok(agents, "probe must call GET /agent");
    // the SDK client interceptor appends ?directory= to GETs from the client config
    assert.equal(agents.query.get("directory"), "/tmp/diakosys-stub-project");
    assert.equal(holder().createServerCalls, 1);
    assert.equal(holder().serverOptions?.hostname, "localhost");
    // a second probe reuses the same server handle — no new server is created
    await adapter.probe();
    assert.equal(holder().createServerCalls, 1);
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("probe fails loudly when the /agent endpoint returns an HTTP error", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt", agentsStatus: 500 });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    await assert.rejects(adapter.probe(), /agents probe failed.*agents rejected/s);
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("prompt: session create, promptAsync request shape, SSE idle, final assistant message", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt" });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    const result = await withDeadline(
      adapter.prompt({ ...PROMPT_INPUT, agent: "build", tools: { write: true, bash: false } }),
      "happy-path prompt",
    );

    // 1. session creation: POST /session with an empty JSON body
    const create = findRequest(stub, (r) => r.method === "POST" && r.pathname === "/session");
    assert.ok(create, "prompt must create a session first");
    assert.deepEqual(JSON.parse(create.body), {});

    // 2. promptAsync: path, directory query and body shape
    const prompt = findPromptAsync(stub);
    assert.ok(prompt, "the prompt must be sent via POST /session/{id}/prompt_async");
    assert.match(prompt.pathname, /^\/session\/ses_stub_001\/prompt_async$/);
    assert.equal(prompt.query.get("directory"), "/tmp/diakosys-stub-project");
    const promptBody = JSON.parse(prompt.body) as Record<string, unknown>;
    assert.deepEqual(promptBody.model, { providerID: "Qwen-Mimo", modelID: "model.gguf" });
    assert.equal(promptBody.agent, "build");
    assert.deepEqual(promptBody.tools, { write: true, bash: false });
    const parts = promptBody.parts as Array<{ type: string; text: string }>;
    assert.equal(parts.length, 1);
    assert.equal(parts[0]?.type, "text");
    assert.equal(parts[0]?.text, "Task: stub task\n\nDescription:\ndoes stub things");

    // 3. the SSE event stream was consumed (GET /event happened)
    assert.ok(findRequest(stub, (r) => r.method === "GET" && r.pathname === "/event"), "the event stream must be read");

    // 4. messages read: GET /session/{id}/message with the directory query
    const messages = messageReads(stub);
    assert.equal(messages.length, 1);
    assert.match(messages[0]?.pathname ?? "", /^\/session\/ses_stub_001\/message$/);
    assert.equal(messages[0]?.query.get("directory"), "/tmp/diakosys-stub-project");

    // 5. result mapping: last assistant message, text-only join, tool passthrough
    assert.equal(result.sessionId, "ses_stub_001");
    assert.equal(result.finish, "stop");
    assert.equal(result.role, "assistant");
    assert.equal(result.text, "stub reply part one part two");
    const rawParts = result.raw.parts as Array<Record<string, unknown>>;
    assert.equal(rawParts.length, 3, "raw.parts must include tool parts");
    assert.equal(rawParts[1]?.type, "tool");
    assert.equal(result.raw.info?.finish, "stop");
    assert.equal(adapter.activeSessionId(), "ses_stub_001");
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("prompt: session create failure rejects and never sends a prompt", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt", createStatus: 500 });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    await assert.rejects(
      withDeadline(adapter.prompt({ ...PROMPT_INPUT }), "create-failure prompt"),
      /failed to create opencode session.*session create rejected/s,
    );
    assert.equal(findPromptAsync(stub), undefined, "no prompt after a failed session create");
    assert.equal(findRequest(stub, (r) => r.pathname === "/event"), undefined, "the event stream was never opened");
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("prompt: promptAsync HTTP error rejects with the session id in the message", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt", promptStatus: 500 });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    await assert.rejects(
      withDeadline(adapter.prompt({ ...PROMPT_INPUT }), "promptAsync-failure prompt"),
      /opencode promptAsync failed.*prompt rejected.*session ses_stub_001/s,
    );
    assert.equal(messageReads(stub).length, 0, "messages are not read after a failed prompt");
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("prompt: a session.error SSE event fails the prompt and no messages are read", async () => {
  const stub = await startStub({ sseMode: "error-after-prompt" });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    await assert.rejects(
      withDeadline(adapter.prompt({ ...PROMPT_INPUT }), "session.error prompt"),
      /stub_error/,
    );
    assert.equal(messageReads(stub).length, 0, "no messages read after a stream error");
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("prompt: an SSE stream that never goes idle fails on the configured prompt timeout", async () => {
  const stub = await startStub({ sseMode: "end-without-idle", sseEndAfterMs: 400 });
  setHolder(stub.url);
  const adapter = makeAdapter({ promptTimeoutMs: 120 });
  try {
    await assert.rejects(
      withDeadline(adapter.prompt({ ...PROMPT_INPUT }), "timeout prompt"),
      /opencode prompt timed out after 120ms/,
    );
    assert.equal(messageReads(stub).length, 0, "no messages are read when the stream never goes idle");
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("abort: posts to /session/{id}/abort, supports explicit ids, ignores HTTP errors", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt", abortStatus: 500 });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    await withDeadline(adapter.prompt({ ...PROMPT_INPUT }), "abort-setup prompt");
    // no argument: abort the currently active session; a failing abort resolves anyway
    await adapter.abort();
    // explicit session id
    await adapter.abort("ses_explicit_9");
    const aborts = stub.requests.filter((r) => r.method === "POST" && /\/abort$/.test(r.pathname));
    assert.equal(aborts.length, 2);
    assert.match(aborts[0]?.pathname ?? "", /ses_stub_001/);
    assert.match(aborts[1]?.pathname ?? "", /ses_explicit_9/);
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("abort: no request without a session, and close() resets the active session", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt" });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    await adapter.abort(); // no session yet: no request
    assert.equal(stub.requests.filter((r) => r.method === "POST" && /\/abort$/.test(r.pathname)).length, 0);

    await withDeadline(adapter.prompt({ ...PROMPT_INPUT }), "no-op-abort prompt");
    assert.equal(adapter.activeSessionId(), "ses_stub_001");
    await adapter.close();
    assert.equal(adapter.activeSessionId(), undefined);
    const before = stub.requests.filter((r) => r.method === "POST" && /\/abort$/.test(r.pathname)).length;
    await adapter.abort(); // session cleared: still no request
    assert.equal(stub.requests.filter((r) => r.method === "POST" && /\/abort$/.test(r.pathname)).length, before);
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("abort while a prompt is in flight names the in-flight session; the result still resolves", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt", promptDelayMs: 250 });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    const pending = withDeadline(adapter.prompt({ ...PROMPT_INPUT }), "in-flight prompt");
    // explicit barrier: the session exists as soon as create returned
    assert.equal(await waitUntil(() => adapter.activeSessionId() !== undefined, 2_000), true);
    const inflight = adapter.activeSessionId();
    assert.ok(inflight !== undefined);
    await adapter.abort(inflight);
    const result = await pending;
    // the adapter's contract returns the completed result; discarding late
    // results after lease loss is the RUNNER's responsibility (documented)
    assert.equal(result.sessionId, inflight);
    assert.ok(
      stub.requests.some((r) => r.method === "POST" && /\/abort$/.test(r.pathname) && r.pathname.includes(inflight)),
      "the abort must name the in-flight session",
    );
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("messages: a failed read is retried (1s interval) and the retry succeeds", async () => {
  const stub = await startStub({
    sseMode: "idle-after-prompt",
    messagesResponses: [{ status: 500 }],
  });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    const result = await withDeadline(adapter.prompt({ ...PROMPT_INPUT }), "retry prompt");
    assert.equal(result.text, "stub reply part one part two");
    const reads = messageReads(stub);
    assert.equal(reads.length, 2, "first read failed, second succeeded");
  } finally {
    await stub.close();
    clearHolder();
  }
});

test("close: releases the server handle once and a later call re-acquires a new one", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt" });
  setHolder(stub.url);
  const adapter = makeAdapter();
  try {
    await adapter.probe();
    await adapter.close();
    assert.equal(holder().closeCalls, 1);
    assert.equal(adapter.activeSessionId(), undefined);
    await adapter.probe();
    assert.equal(holder().createServerCalls, 2, "a new server handle is acquired after close");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test(
  "endpoint override: injected into the provider options.baseURL of the server config " +
    "through the user's global opencode config",
  async () => {
    // Intended contract (see docs/live-adapter-contract.md): an endpoint override
    // is injected into the provider options.baseURL of the server config via
    // configWithEndpoint($HOME/.config/opencode/opencode.json): baseURL is forced
    // to the override, the provider request timeout is disabled for agentic runs,
    // and unrelated options/top-level keys are preserved.
    const stub = await startStub({ sseMode: "idle-after-prompt" });
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-live-home-"));
    const savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    let adapter: LiveOpenCodeAdapter | undefined;
    try {
      const configDir = path.join(homeDir, ".config", "opencode");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "opencode.json"),
        JSON.stringify({
          model: "Qwen-Mimo/model.gguf",
          provider: {
            "Qwen-Mimo": {
              npm: "@ai-sdk/openai-compatible",
              name: "Qwen-Mimo",
              options: { baseURL: "http://localhost:8080/v1", apiKey: "secret-key" },
            },
          },
        }),
      );
      setHolder(stub.url);
      adapter = new LiveOpenCodeAdapter({
        projectDirectory: "/tmp/diakosys-stub-project",
        model: "Qwen-Mimo/model.gguf",
        endpoint: `${stub.url}/v1`,
        startupTimeoutMs: 2_000,
        promptTimeoutMs: 5_000,
      });
      await adapter.probe();
      // the endpoint-derived config reaches createOpencodeServer
      const config = holder().serverOptions?.config as
        | { model?: unknown; provider?: Record<string, Record<string, unknown>> }
        | undefined;
      assert.ok(config?.provider?.["Qwen-Mimo"], "the provider config must reach createOpencodeServer");
      const providerBlock = config.provider?.["Qwen-Mimo"] as Record<string, unknown>;
      const providerOptions = providerBlock.options as Record<string, unknown> | undefined;
      assert.equal(providerOptions?.baseURL, `${stub.url}/v1`, "endpoint must override the user's baseURL");
      assert.equal(providerOptions?.timeout, false, "provider request cap must be disabled for agentic runs");
      assert.equal(providerOptions?.apiKey, "secret-key", "unrelated provider options are preserved");
      assert.equal(providerBlock.npm, "@ai-sdk/openai-compatible", "the rest of the provider block is preserved");
      assert.equal(config.model, "Qwen-Mimo/model.gguf", "unrelated top-level config keys are preserved");
      // the probe itself still works end-to-end through the stub
      assert.equal(findRequest(stub, (r) => r.method === "GET" && r.pathname === "/agent") !== undefined, true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await adapter?.close().catch(() => undefined);
      await stub.close();
      clearHolder();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  },
);

test(
  "endpoint override: fails loudly when no parsable provider block exists",
  async () => {
    // Intended contract: with an endpoint override and no parsable provider block
    // in $HOME/.config/opencode/opencode.json, start() must fail loudly
    // ("cannot honor endpoint override") instead of silently keeping a stale
    // endpoint; no server is created.
    const stub = await startStub({ sseMode: "idle-after-prompt" });
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-live-home-"));
    const savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      setHolder(stub.url);
      const adapter = new LiveOpenCodeAdapter({
        projectDirectory: "/tmp/diakosys-stub-project",
        model: "Qwen-Mimo/model.gguf",
        endpoint: `${stub.url}/v1`,
      });
      await assert.rejects(adapter.probe(), /cannot honor endpoint override/);
      assert.equal(holder().createServerCalls, 0, "no server is created when the endpoint cannot be honored");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await stub.close();
      clearHolder();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  },
);

test(
  "configOverrides are shallow-merged over the endpoint-patched global config",
  async () => {
    // Intended contract: configOverrides replaces a whole top-level key of the
    // base config (here: the global config's `permission`) while every other
    // base key — and the endpoint patch inside the provider block — survives.
    // This is the seam discovery uses to spawn a read-only server without
    // touching the task-runner server's config.
    const stub = await startStub({ sseMode: "idle-after-prompt" });
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-live-home-"));
    const savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const configDir = path.join(homeDir, ".config", "opencode");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "opencode.json"),
        JSON.stringify({
          model: "Qwen-Mimo/model.gguf",
          permission: { "*": "allow" },
          provider: {
            "Qwen-Mimo": {
              npm: "@ai-sdk/openai-compatible",
              name: "Qwen-Mimo",
              options: { baseURL: "http://localhost:8080/v1", apiKey: "secret-key" },
            },
          },
        }),
      );
      setHolder(stub.url);
      const adapter = new LiveOpenCodeAdapter({
        projectDirectory: "/tmp/diakosys-stub-project",
        model: "Qwen-Mimo/model.gguf",
        endpoint: `${stub.url}/v1`,
        startupTimeoutMs: 2_000,
        promptTimeoutMs: 5_000,
        configOverrides: { permission: { "*": "deny" }, lsp: false },
      });
      await adapter.probe();
      const config = holder().serverOptions?.config as
        | {
            model?: unknown;
            permission?: Record<string, unknown>;
            lsp?: unknown;
            provider?: Record<string, Record<string, unknown>>;
          }
        | undefined;
      assert.ok(config, "the merged config must reach the spawned server");
      // the override replaces the global `permission` key wholesale…
      assert.deepEqual(config.permission, { "*": "deny" });
      // …and adds keys the global config did not have…
      assert.equal(config.lsp, false);
      // …while the base config and the endpoint patch survive untouched
      assert.equal(config.model, "Qwen-Mimo/model.gguf");
      const providerOptions = config.provider?.["Qwen-Mimo"]?.options as Record<string, unknown> | undefined;
      assert.equal(providerOptions?.baseURL, `${stub.url}/v1`);
      assert.equal(providerOptions?.apiKey, "secret-key");
      assert.equal(providerOptions?.timeout, false);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await stub.close();
      clearHolder();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  },
);

// ——— doctor probe flow through the real CLI (subprocess with hooks) ———

const DOCTOR_ENV = (dir: string, home: string, stub: StubHandle, endpoint: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  DIAKOSYS_ORCHESTRATOR_DB: path.join(dir, "tasks.db"),
  DIAKOSYS_ORCHESTRATOR_MODEL: "Qwen-Mimo/model.gguf",
  DIAKOSYS_ENDPOINT: endpoint,
  DIAKOSYS_TEST_SDK_STUB_URL: stub.url,
});

async function runDoctor(dir: string, home: string, stub: StubHandle, endpoint: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [
        "--import",
        path.join(ROOT, "tests", "sdk-stub-register.mjs"),
        path.join(ROOT, "src", "cli.ts"),
        "doctor",
      ],
      { cwd: ROOT, env: DOCTOR_ENV(dir, home, stub, endpoint), encoding: "utf8", timeout: 60_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code === "number") return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    throw err;
  }
}

/** Isolated HOME for the doctor subprocess: the endpoint override requires a
 *  parsable provider block in $HOME/.config/opencode/opencode.json. */
function doctorHome(dir: string): string {
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({
      provider: {
        "Qwen-Mimo": {
          npm: "@ai-sdk/openai-compatible",
          name: "Qwen-Mimo",
          options: { baseURL: "http://localhost:8080/v1" },
        },
      },
    }),
  );
  return home;
}

test(
  "doctor: opencode probe is ok through the stub and the configured endpoint reaches server options",
  async () => {
    const stub = await startStub({ sseMode: "idle-after-prompt" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-live-cli-"));
    try {
      const home = doctorHome(dir);
      const r = await runDoctor(dir, home, stub, `${stub.url}/v1`);
      assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /ok\s+opencode — http:\/\/localhost:\d+/);
      assert.match(r.stdout, /doctor: all required checks passed/);
      // the full CLI wiring ran inside the REAL CLI process:
      // DIAKOSYS_ENDPOINT → resolveConfig → doctor's
      // `endpoint: config.endpoint` (src/cli.ts) → LiveOpenCodeAdapter →
      // configWithEndpoint($HOME/.config/opencode/opencode.json) →
      // createOpencodeServer options, captured through the stub server
      const post = stub.serverOptionPosts.at(-1);
      assert.ok(post, "createOpencodeServer must have been called in the CLI process");
      const config = post.config as { provider?: Record<string, Record<string, unknown>> } | undefined;
      assert.ok(config?.provider?.["Qwen-Mimo"], "the provider config must reach createOpencodeServer");
      const providerOptions = config.provider?.["Qwen-Mimo"]?.options as Record<string, unknown> | undefined;
      assert.equal(providerOptions?.baseURL, `${stub.url}/v1`);
      assert.equal(providerOptions?.timeout, false);
    } finally {
      await stub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("doctor: a failing opencode probe marks the check failed and exits 1", async () => {
  const stub = await startStub({ sseMode: "idle-after-prompt", agentsStatus: 500 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-live-cli-"));
  try {
    const home = doctorHome(dir);
    const r = await runDoctor(dir, home, stub, `${stub.url}/v1`);
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /fail\s+opencode/);
    assert.match(r.stdout, /agents probe failed/);
    assert.match(r.stdout, /doctor: at least one check failed/);
  } finally {
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ——— discover wiring through the real CLI (subprocess with hooks) ———

/** Spawn `node --import tests/sdk-stub-register.mjs src/cli.ts discover …`
 *  with the same isolated-HOME + endpoint env the doctor subprocess tests
 *  use, so the discovery adapter's spawned-server options can be asserted
 *  through the stub's /__hook__/server-options route. */
async function runDiscover(
  dir: string,
  home: string,
  stub: StubHandle,
  endpoint: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      ["--import", path.join(ROOT, "tests", "sdk-stub-register.mjs"), path.join(ROOT, "src", "cli.ts"), "discover", ...args],
      { cwd: ROOT, env: DOCTOR_ENV(dir, home, stub, endpoint), encoding: "utf8", timeout: 120_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code === "number") return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    throw err;
  }
}

test(
  "discover spawns its server read-only (DISCOVERY_SERVER_CONFIG) while the endpoint patch survives",
  async () => {
    // One valid proposal so the area completes with a clean ok line; the
    // evidence file exists relative to the child's cwd (orchestrator/).
    const reply = JSON.stringify([
      {
        title: "Document the queue claim invariant",
        problem: "An in-transaction candidate followed by a zero-row claim UPDATE is an invariant violation.",
        rationale: "An explicitly pinned claim invariant keeps the single-step runner contract observable.",
        evidence: [
          {
            file: "src/queue.ts",
            symbol: "claimTask",
            observation: "an in-transaction candidate followed by a zero-row claim UPDATE is an invariant violation",
          },
        ],
        approach: "Record the invariant in the claimTask contract comment and pin it with an existing queue test.",
        outcome: "The claim semantics are explicit and enforced by the current test suite.",
        priority: 6,
        complexity: "low",
        verification: ["npm test"],
      },
    ]);
    const stub = await startStub({
      sseMode: "idle-after-prompt",
      messagesResponses: [
        {
          status: 200,
          body: [{ info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: reply }] }],
        },
      ],
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-live-discover-"));
    try {
      const home = doctorHome(dir);
      const endpoint = `${stub.url}/v1`;
      const r = await runDiscover(dir, home, stub, endpoint, ["--dry-run", "--area", "tests"]);
      assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.equal(r.stderr, "", "piped stdout must stay silent (the progress line is TTY-gated)");
      assert.equal(
        r.stdout,
        [
          `area tests: ok (1 proposals, 0 rejected)`,
          `[6] (low) Document the queue claim invariant`,
          `  evidence: src/queue.ts`,
          `  problem: An in-transaction candidate followed by a zero-row claim UPDATE is an invariant violation.`,
          `  verify: npm test`,
          `dry run — nothing was persisted`,
        ].join("\n") + "\n",
      );

      // The discovery adapter spawned exactly one dedicated server, and its
      // options carry the read-only permission block merged over the
      // endpoint-patched global config (src/opencode.ts start()).
      assert.equal(stub.serverOptionPosts.length, 1, "discovery spawns exactly one server");
      const config = stub.serverOptionPosts[0]?.config as
        | { permission?: Record<string, unknown>; provider?: Record<string, Record<string, unknown>> }
        | undefined;
      assert.ok(config, "the spawned server must receive a config");
      const permission = config.permission ?? {};
      assert.equal(permission["*"], "allow", "the wildcard stays allowed so read keeps working");
      for (const tool of [
        "shell",
        "bash",
        "edit",
        "write",
        "webfetch",
        "websearch",
        "task",
        "question",
        "execute",
        "skill",
        "grep",
        "glob",
      ]) {
        assert.equal(permission[tool], "deny", `permission.${tool} must be denied for discovery`);
      }
      assert.equal(permission.read, undefined, "read must not be explicitly denied");
      // the endpoint patch must survive the shallow merge
      const providerOptions = config.provider?.["Qwen-Mimo"]?.options as Record<string, unknown> | undefined;
      assert.equal(providerOptions?.baseURL, endpoint);
      assert.equal(providerOptions?.timeout, false);

      // the v1 per-prompt tool contract matches the v2 override: read is the
      // only enabled tool (fewer model rounds than search/skill rounds)
      const promptAsync = findPromptAsync(stub);
      assert.ok(promptAsync, "the discovery prompt must reach the stub");
      const promptBody = JSON.parse(promptAsync.body) as { tools?: Record<string, boolean> };
      assert.equal(promptBody.tools?.read, true);
      assert.equal(promptBody.tools?.grep, false);
      assert.equal(promptBody.tools?.glob, false);
      assert.equal(promptBody.tools?.skill, false);
      assert.equal(promptBody.tools?.write, false);
      assert.equal(promptBody.tools?.bash, false);
    } finally {
      await stub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
