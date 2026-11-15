/**
 * Diakosys orchestrator — OpenCode adapter (dual-protocol).
 *
 * Supports both OpenCode CLI generations behind a single public contract:
 *   * v1 (CLI ≤ 1.x / SDK 1.19.x) — `src/opencode-v1.ts`
 *   * v2 (CLI ≥ 2.x / @opencode/client 2.x) — `src/opencode-v2.ts`
 *
 * The protocol is detected from the server's startup banner and can be forced
 * with the `DIAKOSYS_ORCHESTRATOR_OPENCODE_PROTOCOL` environment variable
 * ("v1" | "v2") for deterministic testing. Everything else — startup timeout,
 * shutdown, error propagation, port handling, and the `OpenCodeAdapter`
 * interface — is identical across both backends.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_HOSTNAME, DEFAULT_PORT } from "./defaults.ts";
import { spawnOpenCodeServer, type ServerHandle } from "./opencode-server.ts";
import { createV1Client, type V1Client } from "./opencode-v1.ts";
import { createV2Client, type V2Client } from "./opencode-v2.ts";

import { V1ClientImpl } from "./opencode-v1.ts";
import { V2ClientImpl } from "./opencode-v2.ts";

export interface OpenCodePromptResult {
  sessionId: string;
  finish: string;
  role: string;
  text: string;
  raw: {
    info: { finish?: string; role?: string } | undefined;
    parts: unknown[];
  };
}

export interface OpenCodeAdapter {
  readonly kind: "live" | "mock";
  readonly options: OpenCodeAdapterOptions;
  probe(): Promise<string>;
  prompt(input: {
    title: string;
    description: string;
    directory: string;
    agent?: string;
    tools?: Record<string, boolean>;
  }): Promise<OpenCodePromptResult>;
  abort(sessionId?: string): Promise<void>;
  activeSessionId(): string | undefined;
  close(): Promise<void>;
}

export interface OpenCodeAdapterOptions {
  projectDirectory: string;
  /** "provider/model" string; modelID may itself contain "/". */
  model: string;
  /** Optional primary agent name (e.g. "build"). */
  agent?: string;
  /** Headless server port (default 4096, SDK default). */
  port?: number;
  hostname?: string;
  /** ms for server startup (default 20_000) and per prompt (default 120_000). */
  startupTimeoutMs?: number;
  promptTimeoutMs?: number;
  /** Directory of files read and edited by opencode; defaults to projectDirectory. */
  workDirectory?: string;
  /** Explicit OpenAI-compatible endpoint injected into the provider config (baseURL). */
  endpoint?: string;
  /**
   * Extra top-level keys merged over the spawned server's config (the global
   * opencode config with the endpoint patched). Top-level keys win entirely
   * (shallow merge), so e.g. a `permission` override replaces the global one.
   * Scoped per adapter instance: each LiveOpenCodeAdapter spawns its own
   * `opencode serve`, so e.g. discovery can deny state-changing tools without
   * touching the task-runner server.
   */
  configOverrides?: Record<string, unknown>;
}

export function parseModelString(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`invalid model string "${model}"; expected "<providerID>/<modelID>\"`);
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

const DEFAULT_STARTUP_MS = 20_000;
const DEFAULT_PROMPT_MS = 120_000;

const PROTOCOL_ENV = "DIAKOSYS_ORCHESTRATOR_OPENCODE_PROTOCOL";
const PROTOCOL_ENV_VALUE = "v1";

/**
 * Read the global OpenCode config and inject an explicit endpoint into the
 * provider block, in BOTH schemas.
 *
 *   * legacy: config.provider["<name>"].options / .settings.baseURL
 *   * current: config.providers["<name>"].settings.baseURL
 *
 * Returns undefined when it cannot be done safely (missing/unparsable config,
 * provider block absent or malformed, options/settings present but not an
 * object) — the caller must then fail loudly rather than silently keep a stale
 * endpoint. Never logs config content (may contain credentials).
 */
/** Replace the `baseURL` in a provider block's `options` and/or `settings`,
 *  ensuring both objects exist and the agentic request cap is disabled
 *  (`timeout: false`). Preserves everything else verbatim. Never touches the
 *  top-level config. */
function injectEndpoint(block: Record<string, unknown>, endpoint: string): Record<string, unknown> {
  if (isRecord(block.options)) {
    block.options = { ...block.options, baseURL: endpoint, timeout: false };
  } else {
    block.options = { baseURL: endpoint, timeout: false };
  }
  if (isRecord(block.settings)) {
    block.settings = { ...block.settings, baseURL: endpoint, timeout: false };
  } else {
    block.settings = { baseURL: endpoint, timeout: false };
  }
  return block;
}

export function configWithEndpoint(
  globalConfigPath: string,
  provider: string,
  endpoint: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(globalConfigPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const config = parsed as {
    provider?: Record<string, unknown>;
    providers?: Record<string, unknown>;
  };
  // A present-but-malformed block must not silently fall back to a stale
  // endpoint. `null` counts as present-but-malformed, so check it explicitly
  // before providerBlock (which collapses null to undefined).
  const legacyPresent = config.provider?.[provider] !== undefined && config.provider?.[provider] !== null;
  const currentPresent = config.providers?.[provider] !== undefined;
  const legacy = providerBlock(config.provider, provider);
  const current = providerBlock(config.providers, provider);
  if (!legacyPresent && !currentPresent) return undefined;
  if (legacyPresent && legacy === undefined) return undefined;
  if (currentPresent && current === undefined) return undefined;
  // Both schemas present: both must be well-formed.
  if (legacyPresent && currentPresent) {
    if (!isRecord(legacy) || !isRecord(current)) return undefined;
    if (isMalformedBlock(legacy) || isMalformedBlock(current)) return undefined;
    config.provider = { ...config.provider, [provider]: injectEndpoint(legacy, endpoint) };
    config.providers = { ...config.providers, [provider]: injectEndpoint(current, endpoint) };
  } else if (legacy !== undefined) {
    config.provider = { ...config.provider, [provider]: injectEndpoint(legacy, endpoint) };
  } else if (currentPresent && isRecord(current)) {
    config.providers = { ...config.providers, [provider]: injectEndpoint(current, endpoint) };
  }
  return config;
}

/** True when the value is a non-null, non-array plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when the value is present (not undefined) and not `null`. */
function valuePresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** True when a block declares `options`/`settings` but they are not objects
 *  (i.e. the block is present-but-malformed). */
function isMalformedBlock(block: Record<string, unknown>): boolean {
  const options = block.options;
  const settings = block.settings;
  return (
    (options !== undefined && options !== null && (typeof options !== "object" || Array.isArray(options))) ||
    (settings !== undefined && settings !== null && (typeof settings !== "object" || Array.isArray(settings)))
  );
}

function providerBlock(
  block: Record<string, unknown> | undefined,
  provider: string,
): Record<string, unknown> | undefined {
  if (!isRecord(block)) return undefined;
  // The caller passes the whole provider map; return the named entry only.
  const entry = block[provider];
  if (!isRecord(entry)) return undefined;
  const names = ["options", "settings"] as const;
  for (const name of names) {
    if (valuePresent(entry[name]) && !isRecord(entry[name])) {
      return undefined;
    }
  }
  return entry;
}

export function globalOpencodeConfigPath(home: string): string {
  return path.join(home, ".config", "opencode", "opencode.json");
}

/**
 * Detect the CLI generation from the server's startup banner line.
 *
 * v1 prints `opencode server listening on <url>`; v2 prints `server listening
 * on <url>`. v2's bare form is a subset of v1's prefixed form, so one banner
 * regex covers both — but only the banner line carries the "opencode " prefix
 * (the extracted url cannot), which is why detection reads the banner.
 */
function detectProtocol(banner: string): "v1" | "v2" {
  // v1's banner is prefixed with "opencode "; v2's is not.
  if (banner.includes("opencode ")) return "v1";
  return "v2";
}

/**
 * Live adapter: starts a headless `opencode serve` bound to localhost by default,
 * drives it with the protocol backend selected by banner.
 */
export class LiveOpenCodeAdapter implements OpenCodeAdapter {
  readonly kind = "live" as const;
  readonly options: Required<
    Pick<
      OpenCodeAdapterOptions,
      "projectDirectory" | "model" | "startupTimeoutMs" | "promptTimeoutMs"
    >
  > &
    OpenCodeAdapterOptions;
  private server: ServerHandle | null = null;
  private client: V1Client | V2Client | null = null;
  private currentSessionId: string | null = null;
  private readonly modelProvider: string;
  private readonly modelId: string;
  private readonly locationDirectory: string;

  constructor(options: OpenCodeAdapterOptions) {
    const parsed = parseModelString(options.model);
    this.modelProvider = parsed.providerID;
    this.modelId = parsed.modelID;
    this.locationDirectory = options.projectDirectory;
    this.options = {
      projectDirectory: options.projectDirectory,
      model: options.model,
      agent: options.agent,
      port: options.port,
      hostname: options.hostname ?? DEFAULT_HOSTNAME,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_MS,
      promptTimeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_MS,
      workDirectory: options.workDirectory ?? options.projectDirectory,
      endpoint: options.endpoint,
      configOverrides: options.configOverrides,
    };
  }

  private async start(): Promise<void> {
    if (this.server !== null && this.client !== null) return;
    const { hostname, port, startupTimeoutMs, promptTimeoutMs, endpoint, configOverrides } = this.options;
    let baseConfig: Record<string, unknown> | undefined;
    if (endpoint !== undefined) {
      baseConfig = configWithEndpoint(globalOpencodeConfigPath(os.homedir()), this.modelProvider, endpoint);
      // A present-but-unhonorable endpoint must fail loudly rather than
      // silently keep a stale provider baseURL (see configWithEndpoint).
      if (baseConfig === undefined) {
        throw new Error("cannot honor endpoint override (no parsable provider block in the global opencode config)");
      }
    }
    // Overrides are shallow-merged OVER the endpoint-patched global config so
    // a whole top-level key (e.g. `permission`) can be replaced wholesale.
    const config =
      configOverrides === undefined
        ? baseConfig
        : baseConfig === undefined
          ? { ...configOverrides }
          : { ...baseConfig, ...configOverrides };
    const server = await spawnOpenCodeServer({
      hostname: hostname ?? DEFAULT_HOSTNAME,
      port: port ?? 0,
      timeout: startupTimeoutMs ?? DEFAULT_STARTUP_MS,
      ...(config !== undefined ? { config } : {}),
    });
    const protocol = detectProtocol(server.banner ?? server.url);
    const client =
      protocol === "v1"
        ? createV1Client(server, {
            directory: this.options.projectDirectory,
            password: server.password,
            hostname: hostname ?? DEFAULT_HOSTNAME,
            port: port ?? 0,
            timeout: startupTimeoutMs ?? DEFAULT_STARTUP_MS,
          })
        : createV2Client(server, {
            directory: this.locationDirectory,
            location: { directory: this.locationDirectory },
            model: { providerID: this.modelProvider, modelID: this.modelId },
            password: server.password,
            hostname: hostname ?? DEFAULT_HOSTNAME,
            port: port ?? 0,
            timeout: startupTimeoutMs ?? DEFAULT_STARTUP_MS,
          });
    this.server = server;
    this.client = client;
  }

  /**
   * Create the first session and remember its id; every prompt after that
   * reuses it. Without this the server would receive an empty session id on
   * the first prompt.
   */
  private async ensureSession(): Promise<string> {
    if (this.currentSessionId !== null) return this.currentSessionId;
    const client = this.client;
    if (client === null || this.server === null) {
      throw new Error("opencode adapter not started");
    }
    // create() is the only session-creating call; callers must go through
    // this method so the same session is reused across prompts.
    this.currentSessionId = await client.create();
    return this.currentSessionId;
  }

  /** Check connectivity without running a prompt; returns the server URL. */
  async probe(): Promise<string> {
    await this.start();
    if (this.client === null || this.server === null) {
      throw new Error("opencode adapter not started");
    }
    // the client was constructed with `directory`, which scopes all calls
    if (this.client instanceof V1ClientImpl) {
      const agents = await this.client.probe();
      if (agents === undefined || agents === null) {
        throw new Error("opencode agents probe failed");
      }
      return agents;
    }
    const agents = await this.client.probe();
    if (agents === undefined || agents === null) {
      throw new Error("opencode agents probe failed");
    }
    return agents;
  }

  async prompt(input: {
    title: string;
    description: string;
    directory: string;
    agent?: string;
    tools?: Record<string, boolean>;
  }): Promise<OpenCodePromptResult> {
    await this.start();
    const client = this.client;
    if (client === null || this.server === null) {
      throw new Error("opencode adapter not started");
    }
    await this.ensureSession();
    if (client instanceof V1ClientImpl) {
      const v1client = client as V1Client;
      return v1client.prompt({
        sessionId: this.currentSessionId ?? "",
        title: input.title,
        description: input.description,
        projectDirectory: input.directory,
        agent: input.agent,
        tools: input.tools,
        model: parseModelString(this.options.model),
        promptTimeoutMs: this.options.promptTimeoutMs,
      });
    }
    const v2client = client as V2Client;
    return v2client.prompt({
      sessionId: this.currentSessionId ?? "",
      title: input.title,
      description: input.description,
      projectDirectory: input.directory,
      promptTimeoutMs: this.options.promptTimeoutMs,
    });
  }

  async abort(sessionId?: string): Promise<void> {
    const client = this.client;
    if (client === null) return;
    const target = sessionId ?? this.currentSessionId;
    if (target === null) return;
    try {
      await client.abort(target);
    } catch {
      // aborting an already-finished session is fine; late results are
      // discarded by the caller regardless
    }
  }

  activeSessionId(): string | undefined {
    return this.currentSessionId === null ? undefined : this.currentSessionId;
  }

  async close(): Promise<void> {
    this.currentSessionId = null;
    if (this.server !== null) {
      this.server.close();
      this.server = null;
      this.client = null;
    }
  }
}

/** Test double: records inputs and returns canned replies; never touches a server. */
export class MockOpenCodeAdapter implements OpenCodeAdapter {
  readonly kind = "mock" as const;
  readonly options: OpenCodeAdapterOptions;
  readonly calls: Array<{ title: string; description: string; directory: string; agent?: string }> = [];
  readonly aborted: Array<string | undefined> = [];
  private readonly reply: (input: { title: string; description: string; directory: string }) =>
    | string
    | Promise<string>;

  constructor(
    reply: (input: { title: string; description: string; directory: string }) =>
      | string
      | Promise<string>,
  ) {
    this.reply = reply;
    this.options = {
      projectDirectory: "",
      model: "",
      agent: undefined,
      port: undefined,
      hostname: undefined,
      startupTimeoutMs: undefined,
      promptTimeoutMs: undefined,
      workDirectory: undefined,
      endpoint: undefined,
    };
  }

  async probe(): Promise<string> {
    return "mock:localhost:4096";
  }

  async prompt(input: {
    title: string;
    description: string;
    directory: string;
    agent?: string;
    tools?: Record<string, boolean>;
  }): Promise<OpenCodePromptResult> {
    this.calls.push(input);
    const reply = await this.reply(input);
    const finish = String(reply).toLowerCase();
    const parts = [{ type: "text", text: reply }];
    const info = { finish: finish === "tool-calls" ? "tool-calls" : "stop", role: "assistant" };
    return {
      // Same id activeSessionId() reports, mirroring the live adapter where
      // result.sessionId === activeSessionId() (runner.ts records the former).
      sessionId: "ses_mock",
      finish: String(info.finish),
      role: String(info.role),
      text: reply,
      raw: { info, parts },
    };
  }

  async abort(sessionId?: string): Promise<void> {
    this.aborted.push(sessionId);
  }

  activeSessionId(): string | undefined {
    return "ses_mock";
  }

  async close(): Promise<void> {
    return;
  }
}
