import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "./defaults.ts";
import type { RetryPolicy } from "./retry.ts";
import { DEFAULT_RETRY_POLICY } from "./retry.ts";

export { DEFAULT_ENDPOINT, DEFAULT_MODEL_ID, DEFAULT_PROVIDER };

export interface OrchestratorConfig {
  projectDirectory: string;
  provider: string;
  modelId: string;
  /** "provider/modelId"; modelId may contain "/" (local gguf paths). */
  model: string;
  /** llama.cpp OpenAI-compatible endpoint the provider is expected to use. */
  endpoint: string;
  port: number;
  startupTimeoutMs: number;
  promptTimeoutMs: number;
  agent?: string;
  /** read-only analysis prompt timeout */
  discoveryPromptTimeoutMs: number;
  /** max validated proposals kept per discovery area */
  discoveryMaxProposals: number;
  /** max areas analyzed per discovery run */
  discoveryMaxAreas: number;
  /** Coordinator instance-lock TTL (ms). */
  lockTtlMs: number;
  /** Task execution/verification lease TTL (ms). */
  taskLeaseTtlMs: number;
  /** Retry policy for FAILED tasks with auto-retry categories. */
  retry: RetryPolicy;
  /** Run interrupted-lease recovery + retry passes at cycle start. */
  recoverOnStart: boolean;
}

/**
 * User-level, machine-specific configuration: `~/.config/diakosys/config.json`.
 *
 * Machine-specific connection details (endpoint, port) live here instead of in
 * tracked source, so a different model server needs no code change.
 */
export interface UserConfig {
  /** OpenAI-compatible model server endpoint. */
  endpoint?: string;
  /** First-run setup schema version (1), written by src/first-run.ts. */
  version?: number;
  /** Provider id saved by the first-run setup (e.g. "mimo-q8-m5"). */
  provider?: string;
  /** Model id saved by the first-run setup (e.g. "mimo-q8"). */
  modelId?: string;
  /** Model display name saved by the first-run setup (informational). */
  modelName?: string;
  /** Primary agent saved by the first-run setup (e.g. "build"). */
  agent?: string;
  /**
   * Anything else is accepted and ignored. The keys the orchestrator reads
   * are `endpoint`, `provider`, `modelId` and `agent`; extra keys are
   * tolerated so a hand-written file is not rejected wholesale.
   */
  [key: string]: unknown;
}

/** Config location template (expanded against the caller's HOME at read time). */
export const CONFIG_HOME = "~/.config";
export const CONFIG_DIR_NAME = "diakosys";
export const CONFIG_FILE_NAME = "config.json";

/** Absolute path of the user-level config file: `<home>/.config/diakosys/config.json`. */
export function userConfigPath(): string {
  return path.join(expandHome(CONFIG_HOME), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** Expand `~` in a config location; the location itself stays out of tracked source. */
function expandHome(h: string): string {
  const home = process.env.HOME ?? ".";
  return h.replace(/^~(?=[/])/u, () => home).replace(/^~[^/]+/u, () => path.join(home, "home"));
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** A saved config value usable as a string: present and non-blank. */
function savedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean (true/false), got "${raw}"`);
}

/**
 * Validate an OpenAI-compatible endpoint: an absolute http(s) URL with a
 * non-empty hostname. Anything else (relative URL, bare host, malformed,
 * https:// with no host) fails with an actionable message — never a silent
 * fall back to a stale endpoint.
 */
export function parseEndpoint(endpoint: string): { scheme: string; host: string; port?: number; path: string } | null {
  try {
    const parsed = new URL(endpoint);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.hostname === "") return null;
    return {
      scheme: parsed.protocol,
      host: parsed.host,
      port: parsed.port === "" ? undefined : Number(parsed.port),
      path: parsed.pathname,
    };
  } catch {
    return null;
  }
}

/**
 * Validate an endpoint value of any JSON type. A non-string, empty string or
 * a non-absolute URL fails with an actionable error; nothing falls back to a
 * stale or default endpoint when a configured value is malformed.
 */
export function validateEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== "string") {
    throw new Error(
      `endpoint must be a non-empty string, got ${typeof endpoint}${
        Array.isArray(endpoint) ? " (array)" : typeof endpoint === "object" ? " (object)" : ""
      }`,
    );
  }
  if (endpoint.length === 0) {
    throw new Error('endpoint must not be empty, e.g. http://localhost:8082/v1');
  }
  const info = parseEndpoint(endpoint);
  if (info === null) {
    throw new Error(
      `invalid endpoint "${endpoint}"; expected an absolute http(s) URL with a hostname, e.g. http://localhost:8082/v1`,
    );
  }
  return endpoint;
}

/** Strips embedded credentials so logs and diagnostics never leak them. */
export function redactEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return endpoint;
  }
}

/**
 * Narrow a parsed JSON value to a user config record, rejecting null, arrays,
 * primitives and other unusable shapes with an actionable error.
 */
function narrowUserConfig(parsed: unknown): UserConfig {
  if (parsed === null) throw new Error(`user config must be a JSON object, got null`);
  if (typeof parsed !== "object") throw new Error(`user config must be a JSON object, got ${typeof parsed}`);
  if (Array.isArray(parsed)) throw new Error(`user config must be a JSON object, got an array`);
  // A boxed value or a Date parses as an object but is never a usable config.
  if (Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error(`user config must be a plain JSON object`);
  return parsed as UserConfig;
}

/**
 * Read the user-level configuration.
 *
 * A missing file is fine (the documented default stands). A file that exists
 * but is malformed must NOT silently fall back — it throws so the command can
 * report the problem instead of running on a stale endpoint.
 */
export function readUserConfig(): UserConfig | undefined {
  const configFile = userConfigPath();
  if (!fs.existsSync(configFile)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (err) {
    throw new Error(`user config ${configFile} is malformed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return narrowUserConfig(parsed);
}

/**
 * Resolve the model endpoint in precedence order:
 *   1. DIAKOSYS_ENDPOINT
 *   2. ~/.config/diakosys/config.json "endpoint"
 *   3. documented safe default (localhost)
 *
 * Every candidate is validated; a missing or invalid value fails with an
 * actionable error rather than silently falling back to a stale endpoint.
 */
export function resolveEndpoint(): string {
  const explicit = env("DIAKOSYS_ENDPOINT");
  if (explicit !== undefined) return validateEndpoint(explicit);
  const fromConfig = readUserConfig()?.endpoint;
  if (fromConfig !== undefined) return validateEndpoint(fromConfig);
  return validateEndpoint(DEFAULT_ENDPOINT);
}

/**
 * Resolve effective configuration in priority order:
 * DIAKOSYS_ORCHESTRATOR_MODEL ("provider/modelId")
 *   > DIAKOSYS_ORCHESTRATOR_PROVIDER + DIAKOSYS_ORCHESTRATOR_MODEL_ID
 *   > provider/modelId saved in `~/.config/diakosys/config.json` by the
 *   first-run setup > documented safe defaults.
 * The endpoint resolves as DIAKOSYS_ENDPOINT > saved endpoint > safe default
 * (see resolveEndpoint); the agent resolves as DIAKOSYS_ORCHESTRATOR_AGENT >
 * saved agent, with no default (absent means the opencode default agent).
 * Everything is overridable; nothing is secret — credentials stay in the
 * opencode/llama.cpp configuration, never here or in logs.
 */
export function resolveConfig(): OrchestratorConfig {
  const fullModel = env("DIAKOSYS_ORCHESTRATOR_MODEL");
  // The first-run setup's saved values sit between the environment and the
  // built-in defaults: explicit env vars still win, but a saved
  // provider/modelId/agent replaces the defaults when no env override exists.
  const user = readUserConfig();
  const providerOnly =
    env("DIAKOSYS_ORCHESTRATOR_PROVIDER") ??
    (fullModel === undefined
      ? savedString(user?.provider) ?? DEFAULT_PROVIDER
      : undefined);
  const modelIdOnly =
    env("DIAKOSYS_ORCHESTRATOR_MODEL_ID") ??
    (fullModel === undefined
      ? savedString(user?.modelId) ?? DEFAULT_MODEL_ID
      : undefined);
  const model = fullModel ?? `${providerOnly}/${modelIdOnly}`;
  const provider = fullModel === undefined ? (providerOnly as string) : model.slice(0, model.indexOf("/"));
  const modelId = fullModel === undefined ? (modelIdOnly as string) : model.slice(model.indexOf("/") + 1);

  const base = {
    projectDirectory: env("DIAKOSYS_ORCHESTRATOR_PROJECT_DIR") ?? env("DIAKOSYS_PROJECT_DIR") ?? DEFAULT_PROJECT_DIR,
    provider,
    modelId,
    model,
    endpoint: resolveEndpoint(),
    port: num("DIAKOSYS_ORCHESTRATOR_PORT", DEFAULT_PORT),
    startupTimeoutMs: num("DIAKOSYS_ORCHESTRATOR_STARTUP_TIMEOUT_MS", DEFAULT_STARTUP_TIMEOUT_MS),
    promptTimeoutMs: num("DIAKOSYS_ORCHESTRATOR_PROMPT_TIMEOUT_MS", DEFAULT_PROMPT_TIMEOUT_MS),
    agent: env("DIAKOSYS_ORCHESTRATOR_AGENT") ?? savedString(user?.agent),
    discoveryPromptTimeoutMs: num("DIAKOSYS_ORCHESTRATOR_DISCOVERY_TIMEOUT_MS", DEFAULT_DISCOVERY_TIMEOUT_MS),
    discoveryMaxProposals: num("DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_PROPOSALS", DEFAULT_DISCOVERY_MAX_PROPOSALS),
    discoveryMaxAreas: num("DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_AREAS", DEFAULT_DISCOVERY_MAX_AREAS),
  };
  const taskLeaseTtlMs = num("DIAKOSYS_ORCHESTRATOR_LEASE_TTL_MS", 2 * Math.max(base.promptTimeoutMs, base.discoveryPromptTimeoutMs));
  return {
    ...base,
    lockTtlMs: num("DIAKOSYS_ORCHESTRATOR_LOCK_TTL_MS", Math.max(120_000, 2 * taskLeaseTtlMs)),
    taskLeaseTtlMs,
    retry: {
      maxAttempts: num("DIAKOSYS_ORCHESTRATOR_RETRY_MAX_ATTEMPTS", DEFAULT_RETRY_POLICY.maxAttempts),
      baseMs: num("DIAKOSYS_ORCHESTRATOR_RETRY_BASE_MS", DEFAULT_RETRY_POLICY.baseMs),
      maxMs: num("DIAKOSYS_ORCHESTRATOR_RETRY_MAX_MS", DEFAULT_RETRY_POLICY.maxMs),
    },
    recoverOnStart: bool("DIAKOSYS_ORCHESTRATOR_RECOVER_ON_START", true),
  };
}

const DEFAULT_PROJECT_DIR = process.cwd();
const DEFAULT_PORT = 4096;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 420_000;
const DEFAULT_DISCOVERY_MAX_PROPOSALS = 3;
const DEFAULT_DISCOVERY_MAX_AREAS = 8;
export const ALL_DISCOVERY_AREAS = [
  "architecture",
  "reliability",
  "tests",
  "quality",
  "performance",
  "usability",
  "docs",
  "build",
] as const;
