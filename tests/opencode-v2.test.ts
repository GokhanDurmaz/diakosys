import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LiveOpenCodeAdapter, type TurnStats } from "../src/opencode.ts";
import { toOpencodeError } from "../src/opencode-v2.ts";
import { installFakeSpawn } from "./fake-opencode-spawn.ts";

/**
 * Stage 10.1 — v2 adapter contract harness.
 *
 * `LiveOpenCodeAdapter` is driven against a local stub HTTP server bound to
 * localhost on an ephemeral port, speaking the @opencode/client 2.2.7 wire
 * protocol (see src/opencode-v2.ts):
 *
 *   * agents:   GET  /api/agent                        -> { location, data }
 *   * create:   POST /api/session { model, location }  -> 200 { data: { id } }
 *   * prompt:   POST /api/session/{id}/prompt { text } -> 200 { data }
 *   * events:   GET  /api/event (SSE; each `data:` block is yielded as JSON)
 *   * messages: GET  /api/session/{id}/message?type=assistant -> { data }
 *   * interrupt: POST /api/session/{id}/interrupt      -> 200 { data }
 *
 * The fake spawn (tests/fake-opencode-spawn.ts) emits a bare "server listening
 * on …" banner, so the facade's protocol detection selects the v2 backend and
 * drives it end to end: session creation before the first prompt, model and
 * location propagation, session reuse across prompts, abort, and error
 * diagnostics. No real OpenCode process, model server, credential or external
 * network call is ever made.
 */

// Bare banner → the facade selects the v2 backend.
installFakeSpawn();

const PROJECT_DIR = "/tmp/diakosys-stub-project-v2";

// ——— stub holder (same convention as tests/live-adapter.test.ts) ———

interface StubHolder {
  url: string;
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

// ——— local stub HTTP server (v2 wire) ———

interface CapturedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface StubOptions {
  /** Queued non-200 responses for POST /api/session (session create). */
  createFailures?: number[];
  /** Queued non-200 statuses for GET /api/session/{id}/message. */
  messageFailures?: number[];
  /** Content type for GET /api/event (default "text/event-stream"). */
  sseContentType?: string;
  /** SSE behavior for GET /api/event: "idle" (default) sends a terminal
   * session.status event then ends; "hold" flushes the headers and never
   * sends a body byte — a prompt then never sees a terminal event. */
  sseMode?: "idle" | "hold";
  /** POST /prompt is accepted (fully read) but never answered — the client's
   * fetch stays pending, so the prompt acknowledgement never resolves. */
  promptHang?: boolean;
  /** Multi-assistant-message mode for GET /api/session/{id}/message: entries
   * are in chronological (oldest-first) order. The stub mimics the real
   * server's contract: `order=asc` → chronological, anything else (including
   * the parameter's absence) → newest-first. */
  assistantMessages?: Array<{ finish?: string; text?: string }>;
  /** Scripted SSE events, sent in order as `data:` lines when the stream
   * opens. In "idle" mode they precede the terminal session.status event;
   * in "hold" mode they are the only body bytes (no terminal event). */
  sseEvents?: Array<unknown>;
}

interface StubHandle {
  url: string;
  port: number;
  requests: CapturedRequest[];
  /** SSE connections opened on GET /api/event. */
  readonly sseOpened: number;
  /** SSE connections whose socket has closed (client or server side). */
  readonly sseClosed: number;
  close(): Promise<void>;
}

async function startStub(options: StubOptions = {}): Promise<StubHandle> {
  const requests: CapturedRequest[] = [];
  const createFailures = [...(options.createFailures ?? [])];
  const messageFailures = [...(options.messageFailures ?? [])];
  const sseTimers: NodeJS.Timeout[] = [];
  const sseCounters = { opened: 0, closed: 0 };
  let sessionCounter = 0;
  let lastSessionId = "";

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

      const respondJson = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload ?? {}));
      };

      // POST /api/session — session create; the client unwraps { data }.
      if (req.method === "POST" && url.pathname === "/api/session") {
        const failure = createFailures.shift();
        if (failure !== undefined) {
          respondJson(failure, { name: "http_error", data: { message: "session create rejected" } });
          return;
        }
        sessionCounter += 1;
        lastSessionId = `ses_stub_${String(sessionCounter).padStart(3, "0")}`;
        respondJson(200, { data: { id: lastSessionId } });
        return;
      }

      // GET /api/agent — connectivity probe.
      if (req.method === "GET" && url.pathname === "/api/agent") {
        respondJson(200, {
          location: { directory: PROJECT_DIR },
          data: [{ id: "build", name: "build", type: "builtin" }],
        });
        return;
      }

      // POST /api/session/{id}/prompt — successStatus is 200 (a 202 would be a
      // ClientError); the inbox acknowledgement carries no error field.
      if (req.method === "POST" && /\/prompt$/.test(url.pathname)) {
        if (options.promptHang === true) {
          // Accepted (the body was fully read above) but never answered: the
          // client's fetch stays pending until something aborts it.
          return;
        }
        respondJson(200, { data: { accepted: true } });
        return;
      }

      // GET /api/session/{id}/message?type=assistant
      if (req.method === "GET" && /\/message$/.test(url.pathname)) {
        const failure = messageFailures.shift();
        if (failure !== undefined) {
          respondJson(failure, { name: "http_error", data: { message: "messages rejected" } });
          return;
        }
        if (options.assistantMessages !== undefined) {
          const chronological = options.assistantMessages.map((m, index) => ({
            id: `msg_${String(index + 1).padStart(3, "0")}`,
            role: "assistant",
            finish: m.finish ?? "stop",
            content: [{ type: "text", text: m.text ?? "" }],
          }));
          // The real server's default is newest-first (verified against
          // opencode 2.2.6): only an explicit order=asc is chronological.
          const ordered =
            url.searchParams.get("order") === "asc" ? chronological : [...chronological].reverse();
          respondJson(200, { data: ordered, cursor: null });
          return;
        }
        respondJson(200, {
          data: [{ role: "assistant", finish: "stop", content: [{ type: "text", text: "stub reply" }] }],
          cursor: null,
        });
        return;
      }

      // GET /api/event — SSE; the client yields each `data:` block as JSON and
      // requires the text/event-stream content type.
      if (req.method === "GET" && url.pathname === "/api/event") {
        sseCounters.opened += 1;
        res.on("close", () => {
          sseCounters.closed += 1;
        });
        if (options.sseMode === "hold") {
          // Headers only: flush them now and hold the stream open forever —
          // no terminal event is ever sent, so a subscriber never completes.
          // Scripted events (when present) are still delivered first, so a
          // prompt can observe partial activity before its deadline.
          // (writeHead alone never reaches the wire; the probe verified
          // that flushHeaders() is required for the client to see the stream.)
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.flushHeaders();
          for (const event of options.sseEvents ?? []) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          return;
        }
        const contentType = options.sseContentType ?? "text/event-stream";
        res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
        if (contentType === "text/event-stream") {
          for (const event of options.sseEvents ?? []) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: "session.status", data: { status: "idle" } })}\n\n`);
          // End shortly after so the abandoned SSE iterator completes cleanly.
          sseTimers.push(setTimeout(() => res.end(), 250));
        } else {
          res.end("{}");
        }
        return;
      }

      // POST /api/session/{id}/interrupt
      if (req.method === "POST" && /\/interrupt$/.test(url.pathname)) {
        respondJson(200, { data: { interrupted: true } });
        return;
      }

      respondJson(404, { name: "not_found", data: { message: `no route: ${req.method} ${url.pathname}` } });
    })().catch(() => {
      try {
        res.destroy();
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
    get sseOpened() {
      return sseCounters.opened;
    },
    get sseClosed() {
      return sseCounters.closed;
    },
    close: async () => {
      for (const timer of sseTimers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ——— adapter + assertion helpers ———

function makeV2Adapter(model = "Qwen-Mimo/model.gguf", promptTimeoutMs = 5_000): LiveOpenCodeAdapter {
  return new LiveOpenCodeAdapter({
    projectDirectory: PROJECT_DIR,
    model,
    startupTimeoutMs: 2_000,
    promptTimeoutMs,
  });
}

/** Poll a condition until it holds or the bounded wait expires. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const PROMPT_INPUT = {
  title: "stub task",
  description: "does stub things",
  directory: PROJECT_DIR,
} as const;

const findRequest = (stub: StubHandle, pred: (r: CapturedRequest) => boolean): CapturedRequest | undefined =>
  stub.requests.find(pred);

const findCreate = (stub: StubHandle): CapturedRequest | undefined =>
  findRequest(stub, (r) => r.method === "POST" && r.pathname === "/api/session");

const findPrompt = (stub: StubHandle): CapturedRequest | undefined =>
  findRequest(stub, (r) => r.method === "POST" && /\/prompt$/.test(r.pathname));

const messageReads = (stub: StubHandle): CapturedRequest[] =>
  stub.requests.filter((r) => r.method === "GET" && /\/message$/.test(r.pathname));

const interruptPosts = (stub: StubHandle): CapturedRequest[] =>
  stub.requests.filter((r) => r.method === "POST" && /\/interrupt$/.test(r.pathname));

// ——— behavioral tests ———

test("v2 prompt creates a session first and propagates model + location", async () => {
  const stub = await startStub();
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    const result = await adapter.prompt({ ...PROMPT_INPUT });

    // 1. session creation happens BEFORE the prompt
    const create = findCreate(stub);
    assert.ok(create, "the first prompt must create a session first");
    const prompt = findPrompt(stub);
    assert.ok(prompt, "the prompt must be sent via POST /api/session/{id}/prompt");
    assert.ok(
      stub.requests.indexOf(create) < stub.requests.indexOf(prompt),
      "session creation must happen before the prompt",
    );

    // 2. the create body carries the configured model and project location
    const createBody = JSON.parse(create.body) as {
      model?: { providerID?: string; id?: string };
      location?: { directory?: string };
    };
    assert.deepEqual(createBody.model, { providerID: "Qwen-Mimo", id: "model.gguf" });
    assert.deepEqual(createBody.location, { directory: PROJECT_DIR });
    // auth travels as a Basic header only; presence is asserted, the value
    // (which derives from the generated server password) is never logged
    assert.match(create.headers.authorization ?? "", /^Basic /);

    // 3. the prompt body is the rendered task text on the created session
    assert.match(prompt.pathname, /^\/api\/session\/ses_stub_001\/prompt$/);
    assert.deepEqual(JSON.parse(prompt.body), { text: "Task: stub task\n\nDescription:\ndoes stub things" });

    // 4. the final assistant message is read with the assistant type filter
    const reads = messageReads(stub);
    assert.equal(reads.length, 1);
    assert.match(reads[0]?.pathname ?? "", /^\/api\/session\/ses_stub_001\/message$/);
    assert.equal(reads[0]?.query.get("type"), "assistant");

    // 5. result mapping
    assert.equal(result.sessionId, "ses_stub_001");
    assert.equal(result.finish, "stop");
    assert.equal(result.role, "assistant");
    assert.equal(result.text, "stub reply");
    assert.equal(adapter.activeSessionId(), "ses_stub_001");
    assert.equal(holder().createServerCalls, 1, "the fake server is acquired once");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 model propagation: provider and modelID (including embedded slashes) reach session.create", async () => {
  const stub = await startStub();
  setHolder(stub.url);
  // parseModelString splits on the FIRST slash; the rest is the modelID.
  const adapter = makeV2Adapter("Qwen-Mimo/deep/nested-model");
  try {
    await adapter.prompt({ ...PROMPT_INPUT, description: "" });
    const create = findCreate(stub);
    assert.ok(create, "session create must be sent");
    const createBody = JSON.parse(create.body) as {
      model?: { providerID?: string; id?: string };
      location?: { directory?: string };
    };
    assert.deepEqual(createBody.model, { providerID: "Qwen-Mimo", id: "deep/nested-model" });
    assert.deepEqual(createBody.location, { directory: PROJECT_DIR });
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 session reuse: the second prompt reuses the first session", async () => {
  const stub = await startStub();
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    const first = await adapter.prompt({ ...PROMPT_INPUT, title: "first task", description: "" });
    const second = await adapter.prompt({ ...PROMPT_INPUT, title: "second task", description: "" });

    const creates = stub.requests.filter((r) => r.method === "POST" && r.pathname === "/api/session");
    assert.equal(creates.length, 1, "exactly one session is created across prompts");
    const prompts = stub.requests.filter((r) => r.method === "POST" && /\/prompt$/.test(r.pathname));
    assert.equal(prompts.length, 2, "two prompts are sent");
    assert.equal(prompts[0]?.pathname, prompts[1]?.pathname, "both prompts target the same session");
    assert.match(prompts[0]?.pathname ?? "", /ses_stub_001/);
    assert.equal(first.sessionId, "ses_stub_001");
    assert.equal(second.sessionId, "ses_stub_001");
    assert.equal(adapter.activeSessionId(), "ses_stub_001");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 create failure: rejects loudly, sends no prompt, and retries the create on the next prompt", async () => {
  const stub = await startStub({ createFailures: [500] });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    await assert.rejects(
      adapter.prompt({ ...PROMPT_INPUT }),
      /UnexpectedStatus: 500/,
      "the create failure surfaces as the SDK's UnexpectedStatus diagnostic",
    );
    assert.equal(findPrompt(stub), undefined, "no prompt after a failed session create");
    assert.equal(messageReads(stub).length, 0, "no messages are read after a failed session create");

    // the next prompt creates a fresh session and succeeds (a failed create
    // consumes no session id on the stub)
    const result = await adapter.prompt({ ...PROMPT_INPUT, title: "retry" });
    const creates = stub.requests.filter((r) => r.method === "POST" && r.pathname === "/api/session");
    assert.equal(creates.length, 2, "the create is retried after the failure");
    assert.equal(findPrompt(stub)?.pathname, "/api/session/ses_stub_001/prompt");
    assert.equal(result.sessionId, "ses_stub_001");
    assert.equal(result.text, "stub reply");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 reuse after a failed prompt: the created session is kept for the next prompt", async () => {
  const stub = await startStub({ messageFailures: [503] });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    await assert.rejects(
      adapter.prompt({ ...PROMPT_INPUT }),
      /UnexpectedStatus: 503/,
      "the message-read failure surfaces the SDK's status diagnostic",
    );
    const creates = stub.requests.filter((r) => r.method === "POST" && r.pathname === "/api/session");
    assert.equal(creates.length, 1, "a failed prompt does not discard the created session");
    const result = await adapter.prompt({ ...PROMPT_INPUT, title: "retry" });
    const prompts = stub.requests.filter((r) => r.method === "POST" && /\/prompt$/.test(r.pathname));
    assert.equal(prompts.length, 2, "the second prompt reuses the session");
    assert.equal(prompts[0]?.pathname, prompts[1]?.pathname, "both prompts target the same session");
    assert.match(prompts[1]?.pathname ?? "", /ses_stub_001/);
    assert.equal(result.sessionId, "ses_stub_001");
    assert.equal(result.text, "stub reply");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 abort: interrupts the active session and honors explicit ids", async () => {
  const stub = await startStub();
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    await adapter.prompt({ ...PROMPT_INPUT });
    // no argument: interrupt the currently active session
    await adapter.abort();
    // explicit session id
    await adapter.abort("ses_explicit_9");
    const interrupts = interruptPosts(stub);
    assert.equal(interrupts.length, 2);
    assert.match(interrupts[0]?.pathname ?? "", /\/api\/session\/ses_stub_001\/interrupt$/);
    assert.match(interrupts[1]?.pathname ?? "", /\/api\/session\/ses_explicit_9\/interrupt$/);
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 diagnostics: an UnsupportedContentType SSE failure keeps reason and content-type detail", async () => {
  const stub = await startStub({ sseContentType: "application/json" });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    // The SSE stream responding with a JSON content type makes the SDK throw
    // ClientError(UnsupportedContentType); the SDK folds the content-type
    // detail into the message ("<reason>: <detail>"), so the wrapped
    // diagnostic keeps both the message and the explicit reason tag.
    await assert.rejects(
      adapter.prompt({ ...PROMPT_INPUT }),
      /opencode ClientError \(UnsupportedContentType: application\/json; reason: UnsupportedContentType\)/,
    );
    assert.equal(messageReads(stub).length, 0, "no messages are read after a stream failure");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

// ——— prompt timeout regression tests ———
// The v2 deadline must bound the WHOLE prompt operation: the prompt POST, the
// wait for a terminal SSE event, and the assistant-message read. Both tests
// use a short (300ms) deadline and assert a bounded, descriptive rejection.

test("v2 prompt timeout: prompt accepted but no terminal SSE event arrives", async () => {
  const stub = await startStub({ sseMode: "hold" });
  setHolder(stub.url);
  const adapter = makeV2Adapter("Qwen-Mimo/model.gguf", 300);
  try {
    const started = Date.now();
    await assert.rejects(
      adapter.prompt({ ...PROMPT_INPUT }),
      /opencode prompt timed out after 300ms \(session ses_stub_001\)/,
      "the timeout diagnostic must name the deadline and the session",
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250, `the deadline must be honored, rejected after ${elapsed}ms`);
    assert.ok(elapsed < 4_000, `the rejection must be bounded, took ${elapsed}ms`);

    // The prompt was accepted and the SSE stream subscribed before the deadline.
    assert.ok(findPrompt(stub), "the prompt POST must have been sent");
    assert.equal(stub.sseOpened, 1, "the SSE stream must have been subscribed");

    // After the deadline the aborted stream consumer must release the
    // connection — no indefinitely running SSE subscriber.
    const closed = await waitUntil(() => stub.sseClosed >= 1, 2_000);
    assert.ok(closed, `the abandoned SSE connection must close after the deadline (opened=${stub.sseOpened}, closed=${stub.sseClosed})`);
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 prompt timeout: the prompt request itself never resolves", async () => {
  const stub = await startStub({ promptHang: true });
  setHolder(stub.url);
  const adapter = makeV2Adapter("Qwen-Mimo/model.gguf", 300);
  try {
    const started = Date.now();
    await assert.rejects(
      adapter.prompt({ ...PROMPT_INPUT }),
      /opencode prompt timed out after 300ms \(session ses_stub_001\)/,
      "a hanging prompt POST must also hit the deadline diagnostic",
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250, `the deadline must be honored, rejected after ${elapsed}ms`);
    assert.ok(elapsed < 4_000, `the rejection must be bounded, took ${elapsed}ms`);

    // The prompt request was sent and accepted, just never answered. The SSE
    // subscription is lazy — its connection opens only when the consumer
    // starts iterating, which never happens while the prompt hangs — so the
    // stub observes zero SSE connections and none are leaked.
    assert.ok(findPrompt(stub), "the prompt POST must have been sent");
    assert.equal(stub.sseOpened, 0, "the lazy SSE stream never connects while the prompt hangs");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 prompt reads the chronologically LAST assistant message (explicit order=asc)", async () => {
  // The real server's message.list default is newest-first (verified against
  // opencode 2.2.6), so the pre-fix `data[data.length - 1]` without an order
  // parameter returned the model's FIRST step — typically tool calls with an
  // empty text — and discarded the actual deliverable. The stub reproduces
  // that default, so this test fails if the fix regresses.
  const stub = await startStub({
    assistantMessages: [
      { finish: "tool-calls", text: "step one: reading files" },
      { finish: "stop", text: '[{"title":"the deliverable"}]' },
    ],
  });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    const result = await adapter.prompt({ ...PROMPT_INPUT });
    assert.equal(result.text, '[{"title":"the deliverable"}]', "the newest assistant message is the deliverable");
    assert.equal(result.finish, "stop");
    const read = messageReads(stub)[0];
    assert.equal(read?.query.get("order"), "asc", "the message list must be requested in chronological order");
    assert.equal(read?.query.get("type"), "assistant");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

// ——— toOpencodeError unit tests ———

test("toOpencodeError mirrors real SDK ClientErrors (detail folded into the message)", () => {
  // The real SDK's ClientError only exposes `name` and `reason`; the detail is
  // folded into the message as "<reason>: <detail>" and never stored, so the
  // wrapper keeps the message verbatim plus the explicit reason tag.
  const error = new Error("UnsupportedContentType: application/json") as Error & {
    name: string;
    reason?: unknown;
    detail?: unknown;
  };
  error.name = "ClientError";
  error.reason = "UnsupportedContentType";

  const wrapped = toOpencodeError(error, "ses_stub_001");
  assert.equal(
    wrapped.message,
    "opencode ClientError (UnsupportedContentType: application/json; reason: UnsupportedContentType)",
  );
});

test("toOpencodeError surfaces a detail property when one is present", () => {
  const error = new Error("UnexpectedStatus: 500") as Error & { name: string; reason?: unknown; detail?: unknown };
  error.name = "ClientError";
  error.reason = "UnexpectedStatus";
  error.detail = "500";

  const wrapped = toOpencodeError(error, undefined);
  assert.equal(
    wrapped.message,
    "opencode ClientError (UnexpectedStatus: 500; detail: 500; reason: UnexpectedStatus)",
  );
});

test("toOpencodeError keeps the Transport cause detail", () => {
  const error = new Error("Transport: connection refused") as Error & { name: string; reason?: unknown; detail?: unknown };
  error.name = "ClientError";
  error.reason = "Transport";
  error.detail = "connection refused";

  const wrapped = toOpencodeError(error, "ses_stub_001");
  assert.equal(
    wrapped.message,
    "opencode ClientError (Transport: connection refused; detail: connection refused; reason: Transport)",
  );
});

test("toOpencodeError keeps a non-string detail readable via JSON", () => {
  const error = new Error("MalformedResponse") as Error & { name: string; reason?: unknown; detail?: unknown };
  error.name = "ClientError";
  error.reason = "MalformedResponse";
  error.detail = { expected: "sse", got: "json" };

  const wrapped = toOpencodeError(error, "ses_stub_001");
  assert.match(wrapped.message, /detail: {"expected":"sse","got":"json"}/);
  assert.match(wrapped.message, /reason: MalformedResponse/);
});

test("toOpencodeError falls back to the message for non-ClientError errors", () => {
  const wrapped = toOpencodeError(new Error("plain failure"), "ses_stub_001");
  assert.equal(wrapped.message, "plain failure");
});

test("toOpencodeError renders non-Error values with the session id", () => {
  const wrapped = toOpencodeError({ foo: "bar" }, "ses_stub_001");
  assert.equal(wrapped.message, `opencode failed (session ses_stub_001): {"foo":"bar"}`);
});

// ——— turn statistics (observability only; prompt behavior is unchanged) ———
// The scripted SSE events mirror the real v2 bus: `message.part.updated`
// carries the durable per-step/tool parts; `session.step.*` and
// `session.status` are the dedicated events. All payloads are plain JSON, so
// the collector's defensive reads are exercised with genuinely malformed data.

/** Extract the turn-stats snapshot a v2 prompt attaches to a rejection. */
function turnStatsOf(err: unknown): TurnStats | undefined {
  return err !== null && typeof err === "object" ? (err as { turnStats?: TurnStats }).turnStats : undefined;
}

const partEvent = (part: Record<string, unknown>): unknown => ({
  type: "message.part.updated",
  data: { sessionID: "ses_stub_001", part: { sessionID: "ses_stub_001", messageID: "msg_1", ...part } },
});

const stepStartPart = (id: string): unknown => partEvent({ id, type: "step-start" });

const stepFinishPart = (id: string, reason: string, tokens?: Record<string, unknown>): unknown =>
  partEvent({ id, type: "step-finish", reason, ...(tokens === undefined ? {} : { tokens }) });

const toolPart = (callID: string, tool: string, state: Record<string, unknown>): unknown =>
  partEvent({ id: `prt_${callID}`, type: "tool", callID, tool, state });

test("v2 turn stats: step count and finish reasons from per-step parts", async () => {
  const stub = await startStub({
    sseEvents: [
      stepStartPart("prt_ss1"),
      stepFinishPart("prt_sf1", "tool-calls", { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } }),
      stepStartPart("prt_ss2"),
      stepFinishPart("prt_sf2", "stop", { input: 200, output: 80, reasoning: 30, cache: { read: 15, write: 6 } }),
    ],
  });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    const result = await adapter.prompt({ ...PROMPT_INPUT });
    assert.equal(result.text, "stub reply", "the prompt result is unchanged by instrumentation");
    const stats = result.turnStats;
    assert.ok(stats, "a completed v2 prompt carries a turn-stats snapshot");
    assert.equal(stats.sessionId, "ses_stub_001");
    assert.equal(stats.outcome, "completed");
    assert.equal(stats.terminalEvent, "session.status");
    assert.equal(stats.steps, 2, "distinct step-start parts, deduped by part id");
    assert.deepEqual(stats.finishReasons, ["tool-calls", "stop"]);
    assert.deepEqual(stats.tokens, { input: 300, output: 130, reasoning: 50, cacheRead: 25, cacheWrite: 11 });
    assert.deepEqual(stats.toolCalls, {});
    assert.equal(stats.toolSpanMs, null);
    assert.equal(stats.unattributedSpanMs, null, "no measured tool span → no unattributed attribution");
    assert.equal(stats.retries, 0);
    assert.ok(stats.wallMs !== null && stats.wallMs >= 0);
    assert.ok(stats.firstStepAtMs !== null, "the first step timestamp is measured");
    assert.ok(stats.lastEventAtMs !== null, "the last event timestamp is measured");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 turn stats: tool calls counted once per call, durations summed once", async () => {
  const stub = await startStub({
    sseEvents: [
      toolPart("call_1", "read", { status: "pending" }),
      toolPart("call_1", "read", { status: "running", time: { start: 1_000 } }),
      toolPart("call_1", "read", { status: "completed", time: { start: 1_000, end: 1_250 } }),
      // duplicate completion update of the same call: neither the count nor
      // the duration may be added twice
      toolPart("call_1", "read", { status: "completed", time: { start: 1_000, end: 1_250 } }),
      toolPart("call_2", "grep", { status: "completed", time: { start: 2_000, end: 2_050 } }),
    ],
  });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    const result = await adapter.prompt({ ...PROMPT_INPUT });
    const stats = result.turnStats;
    assert.ok(stats);
    assert.deepEqual(stats.toolCalls, { read: 1, grep: 1 }, "pending/running/completed updates are one call");
    assert.equal(stats.toolSpanMs, 300, "250ms + 50ms, the duplicate completion ignored");
    assert.equal(stats.steps, 0);
    assert.equal(stats.tokens, null, "no step reported usage");
    assert.equal(stats.finishReasons, null);
    assert.ok(stats.unattributedSpanMs !== null, "the unattributed remainder is measurable here");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 turn stats: per-step usage counted once; aggregates never added on top", async () => {
  const usage = { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } };
  const stub = await startStub({
    sseEvents: [
      stepFinishPart("prt_sf1", "stop", usage),
      // the same step finish updated again (incremental persistence)
      stepFinishPart("prt_sf1", "stop", usage),
      // the dedicated step event for the same step — same numbers, different
      // source: must not be summed on top of the canonical part
      { type: "session.step.ended", data: { assistantMessageID: "msg_1", finish: "stop", tokens: usage } },
      // aggregate usage events are ignored entirely
      { type: "session.usage.updated", data: { cost: 1, tokens: usage } },
      { type: "message.updated", data: { messageID: "msg_1", tokens: usage } },
    ],
  });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    const result = await adapter.prompt({ ...PROMPT_INPUT });
    const stats = result.turnStats;
    assert.ok(stats);
    assert.deepEqual(stats.tokens, { input: 10, output: 5, reasoning: 2, cacheRead: 1, cacheWrite: 0 });
    assert.deepEqual(stats.finishReasons, ["stop"]);
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 turn stats: step.ended events are the fallback when no step part arrives", async () => {
  const stub = await startStub({
    sseEvents: [
      { type: "session.step.started", data: { assistantMessageID: "msg_1" } },
      { type: "session.step.started", data: { assistantMessageID: "msg_2" } },
      // duplicate step.ended for the same message: counted once
      {
        type: "session.step.ended",
        data: { assistantMessageID: "msg_1", finish: "tool-calls", tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 0, write: 0 } } },
      },
      {
        type: "session.step.ended",
        data: { assistantMessageID: "msg_1", finish: "tool-calls", tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 0, write: 0 } } },
      },
    ],
  });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    const result = await adapter.prompt({ ...PROMPT_INPUT });
    const stats = result.turnStats;
    assert.ok(stats);
    assert.equal(stats.steps, 2);
    assert.deepEqual(stats.finishReasons, ["tool-calls"]);
    assert.deepEqual(stats.tokens, { input: 7, output: 3, reasoning: 1, cacheRead: 0, cacheWrite: 0 });
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 turn stats: malformed events never break the prompt or the snapshot", async () => {
  const stub = await startStub({
    sseEvents: [
      // object-shaped but empty/ill-typed: the wire protocol requires every
      // data block to be an object, so malformed METADATA is what the
      // collector must survive
      {},
      { type: null },
      { type: 123 },
      { type: "message.part.updated" },
      { type: "message.part.updated", data: { part: "not-an-object" } },
      { type: "message.part.updated", data: { part: { type: "tool" } } },
      {
        type: "message.part.updated",
        data: { part: { type: "step-finish", reason: 42, tokens: { input: "lots", output: -5, cache: "nope" } } },
      },
      { type: "session.status", data: { status: { attempt: "three" } } },
      { type: "session.status", data: { status: { attempt: 2 } } },
    ],
  });
  setHolder(stub.url);
  const adapter = makeV2Adapter();
  try {
    const result = await adapter.prompt({ ...PROMPT_INPUT });
    assert.equal(result.text, "stub reply", "the prompt completes normally past malformed events");
    const stats = result.turnStats;
    assert.ok(stats);
    assert.equal(stats.steps, 0);
    assert.deepEqual(stats.toolCalls, { unknown: 1 }, "a tool part without a name is counted, not dropped silently");
    assert.equal(stats.toolSpanMs, null, "a tool part without usable times measures nothing");
    assert.equal(stats.tokens, null, "malformed token fields are never reported as usage");
    assert.equal(stats.finishReasons, null);
    assert.equal(stats.retries, 2, "a numeric retry attempt is honored, a string one ignored");
    assert.equal(stats.outcome, "completed");
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});

test("v2 prompt timeout: partial turn stats travel with the deadline error", async () => {
  const stub = await startStub({
    sseMode: "hold",
    sseEvents: [
      stepStartPart("prt_ss1"),
      stepFinishPart("prt_sf1", "tool-calls", { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } }),
      toolPart("call_1", "read", { status: "completed", time: { start: 1_000, end: 1_100 } }),
      { type: "session.status", data: { status: { attempt: 1 } } },
    ],
  });
  setHolder(stub.url);
  const adapter = makeV2Adapter("Qwen-Mimo/model.gguf", 300);
  try {
    const rejection = await adapter.prompt({ ...PROMPT_INPUT }).then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(rejection instanceof Error, "the prompt must reject with the deadline error");
    assert.match(
      (rejection as Error).message,
      /opencode prompt timed out after 300ms \(session ses_stub_001\)/,
      "the original timeout diagnostic is unchanged",
    );
    const stats = turnStatsOf(rejection);
    assert.ok(stats, "partial statistics are attached before the consumer state is lost");
    assert.equal(stats.outcome, "timeout");
    assert.equal(stats.terminalEvent, "deadline");
    assert.equal(stats.steps, 1, "the step observed before the deadline");
    assert.deepEqual(stats.tokens, { input: 100, output: 50, reasoning: 20, cacheRead: 10, cacheWrite: 5 });
    assert.deepEqual(stats.toolCalls, { read: 1 });
    assert.equal(stats.toolSpanMs, 100);
    assert.deepEqual(stats.finishReasons, ["tool-calls"]);
    assert.equal(stats.retries, 1);
    assert.ok(stats.wallMs !== null && stats.wallMs >= 300, `the deadline is honored (wallMs=${stats.wallMs})`);
    assert.ok(stats.firstStepAtMs !== null);
  } finally {
    await adapter.close().catch(() => undefined);
    await stub.close();
    clearHolder();
  }
});
