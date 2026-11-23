import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import {
  readOpencodeCatalog,
  buildModelChoices,
  buildAgentChoices,
  formatModelChoices,
  formatAgentChoices,
  runFirstRunSelection,
  shouldRunFirstRunSetup,
  maybeFirstRunSetup,
  numberPrompt,
  BUILTIN_AGENTS,
  type OpencodeCatalog,
} from "../src/first-run.ts";
import { resolveConfig, resolveEndpoint } from "../src/config.ts";
import { LiveOpenCodeAdapter } from "../src/opencode.ts";
import { createV2Client } from "../src/opencode-v2.ts";
import { installFakeSpawn } from "./fake-opencode-spawn.ts";
import { restoreEnv } from "./helpers.ts";

/**
 * First-run interactive configuration tests.
 *
 * Everything runs in temporary directories: the global opencode config and the
 * Diakosys user config are written into a mkdtemp sandbox, and env-dependent
 * code paths (HOME-based config discovery) run with the env temporarily
 * rewritten and restored. No real OpenCode process, model server, credential
 * or external network call is ever made — the adapter-level agent tests drive
 * the real SDK/client code against a local stub HTTP server exactly like
 * tests/live-adapter.test.ts and tests/opencode-v2.test.ts.
 */

// ——— shared fixtures (stand-ins for the developer's real ~/.config/opencode/opencode.json) ———

const REMOTE_ENDPOINT = "http://100.111.93.73:8082/v1";
const OTHER_ENDPOINT = "http://192.0.2.10:8083/v1";

/** Current schema: providers.<id>.{ name, settings.baseURL, models.<mid>.{ name } } + top-level agent map. */
const CURRENT_FORMAT_CONFIG = () => ({
  $schema: "https://opencode.ai/config.json",
  permission: { "*": "allow" },
  agent: {
    explore: { permission: { question: "deny" } },
  },
  providers: {
    "mimo-llama-m5": {
      name: "MiMo 2.6 Q6_K_L (M5 llama.cpp)",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: REMOTE_ENDPOINT, apiKey: "local" },
      models: {
        "mimo-2.6-9b-q6": {
          name: "MiMo 2.6 9B Q6_K_L",
          limit: { context: 102400, output: 4096 },
        },
      },
    },
    "mimo-q8-m5": {
      name: "MiMo Q8_0 (M5 llama.cpp)",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: OTHER_ENDPOINT, apiKey: "local" },
      models: {
        "mimo-q8": {
          name: "MiMo-V2.6-Distill-Qwen-9B Q8_0",
          limit: { context: 102400, output: 4096 },
        },
      },
    },
  },
});

/** Legacy schema: provider.<id>.options.baseURL + top-level "model": "<provider>/<id>". */
const LEGACY_FORMAT_CONFIG = () => ({
  model: "Qwen-Mimo/model.gguf",
  provider: {
    "Qwen-Mimo": {
      npm: "@ai-sdk/openai-compatible",
      name: "Qwen-Mimo",
      options: { baseURL: "http://localhost:8080/v1", apiKey: "<redacted>" },
    },
  },
});

// ——— helpers ———

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

/**
 * Isolate the process env for config-resolution tests: snapshots HOME plus
 * every DIAKOSYS_* variable, deletes them all, lets the callback set what it
 * needs, and restores the original values afterwards (even on failure).
 */
function isolateEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key === "HOME" || key.startsWith("DIAKOSYS_")) saved[key] = process.env[key];
  }
  for (const key of Object.keys(saved)) delete process.env[key];
  return saved;
}

function withIsolatedEnv<T>(fn: () => T): T {
  const saved = isolateEnv();
  try {
    return fn();
  } finally {
    restoreEnv(saved);
  }
}

/** Async variant for tests that await promises (e.g. the interactive hook). */
async function withIsolatedEnvAsync<T>(fn: () => Promise<T>): Promise<T> {
  const saved = isolateEnv();
  try {
    return await fn();
  } finally {
    restoreEnv(saved);
  }
}

/** A user config written where readUserConfig()/userConfigPath() look for it under `home`. */
function diakosysConfigPath(home: string): string {
  return path.join(home, ".config", "diakosys", "config.json");
}

// ——— interactive-layer test helpers ———

function asReadStream(stream: PassThrough): NodeJS.ReadStream {
  return stream as unknown as NodeJS.ReadStream;
}

function asWriteStream(stream: PassThrough): NodeJS.WriteStream {
  return stream as unknown as NodeJS.WriteStream;
}

/** A readable stream that counts as a terminal for the invocation gate. */
function ttyInput(lines?: string): PassThrough {
  const stream = new PassThrough();
  (stream as unknown as { isTTY?: boolean }).isTTY = true;
  if (lines !== undefined) stream.write(lines);
  return stream;
}

/** Collect a stream's output while it flows. */
function capture(stream: PassThrough): { text: () => string } {
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += String(chunk);
  });
  return { text: () => text };
}

/** Race a promise against a deadline so a regression cannot hang the suite. */
function withDeadline<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} hung past ${ms}ms`)), ms).unref();
    }),
  ]);
}

/** Poll a condition until it holds or the bounded wait expires. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error(`condition not met within ${timeoutMs}ms`);
}

// ——— readOpencodeCatalog: parsing the global opencode config ———

test("readOpencodeCatalog parses the current schema: providers, models, endpoints and configured agents", () => {
  const file = path.join(tempDir("diakosys-catalog-"), "opencode.json");
  writeJson(file, CURRENT_FORMAT_CONFIG());
  const catalog = readOpencodeCatalog(file);
  assert.ok(catalog !== undefined, "a valid config must parse");
  assert.deepEqual(
    catalog.providers.map((p) => p.id),
    ["mimo-llama-m5", "mimo-q8-m5"],
  );
  const first = catalog.providers[0];
  assert.ok(first !== undefined);
  assert.equal(first.name, "MiMo 2.6 Q6_K_L (M5 llama.cpp)");
  assert.equal(first.endpoint, REMOTE_ENDPOINT);
  assert.deepEqual(first.models, [{ id: "mimo-2.6-9b-q6", name: "MiMo 2.6 9B Q6_K_L" }]);
  const second = catalog.providers[1];
  assert.ok(second !== undefined);
  assert.equal(second.endpoint, OTHER_ENDPOINT);
  assert.deepEqual(second.models, [{ id: "mimo-q8", name: "MiMo-V2.6-Distill-Qwen-9B Q8_0" }]);
  assert.deepEqual(catalog.agents, ["explore"]);
});

test("readOpencodeCatalog parses the legacy schema: provider.<id>.options.baseURL and the top-level model fallback", () => {
  const file = path.join(tempDir("diakosys-catalog-"), "opencode.json");
  writeJson(file, LEGACY_FORMAT_CONFIG());
  const catalog = readOpencodeCatalog(file);
  assert.ok(catalog !== undefined);
  const provider = catalog.providers[0];
  assert.ok(provider !== undefined);
  assert.equal(provider.id, "Qwen-Mimo");
  assert.equal(provider.name, "Qwen-Mimo");
  assert.equal(provider.endpoint, "http://localhost:8080/v1");
  assert.deepEqual(provider.models, [{ id: "model.gguf", name: "model.gguf" }]);
  assert.deepEqual(catalog.agents, []);
});

test("readOpencodeCatalog returns undefined for missing, malformed or non-object configs", () => {
  const dir = tempDir("diakosys-catalog-");
  assert.equal(readOpencodeCatalog(path.join(dir, "missing.json")), undefined);

  const malformed = path.join(dir, "malformed.json");
  fs.writeFileSync(malformed, "{ not json", "utf8");
  assert.equal(readOpencodeCatalog(malformed), undefined);

  const array = path.join(dir, "array.json");
  fs.writeFileSync(array, "[1,2,3]", "utf8");
  assert.equal(readOpencodeCatalog(array), undefined);

  const str = path.join(dir, "string.json");
  fs.writeFileSync(str, '"just a string"', "utf8");
  assert.equal(readOpencodeCatalog(str), undefined);
});

test("readOpencodeCatalog keeps an empty catalog distinct from an unreadable config and skips unusable entries", () => {
  const dir = tempDir("diakosys-catalog-");
  const empty = path.join(dir, "empty.json");
  writeJson(empty, {});
  assert.deepEqual(readOpencodeCatalog(empty), { providers: [], agents: [] });

  const partial = path.join(dir, "partial.json");
  writeJson(partial, {
    providers: {
      broken: "not an object",
      "no-endpoint": {
        name: "No endpoint",
        models: { "m1": { name: "Model One" } },
      },
      "no-models": {
        name: "No models",
        settings: { baseURL: REMOTE_ENDPOINT },
      },
      "junk-model": {
        name: "Junk model entry",
        settings: { baseURL: REMOTE_ENDPOINT },
        models: { "bad": "not an object", "good": { name: "Good" } },
      },
    },
    agent: "not a map",
  });
  const catalog = readOpencodeCatalog(partial);
  assert.ok(catalog !== undefined);
  assert.deepEqual(
    catalog.providers.map((p) => ({ id: p.id, endpoint: p.endpoint, models: p.models })),
    [
      { id: "no-endpoint", endpoint: undefined, models: [{ id: "m1", name: "Model One" }] },
      { id: "no-models", endpoint: REMOTE_ENDPOINT, models: [] },
      { id: "junk-model", endpoint: REMOTE_ENDPOINT, models: [{ id: "good", name: "Good" }] },
    ],
  );
  assert.deepEqual(catalog.agents, []);
});

// ——— choice building ———

test("buildModelChoices flattens providers in config order and skips providers without an endpoint", () => {
  const catalog: OpencodeCatalog = {
    providers: [
      { id: "a", name: "Provider A", endpoint: undefined, models: [{ id: "a1", name: "A One" }] },
      { id: "b", name: "Provider B", endpoint: REMOTE_ENDPOINT, models: [{ id: "b1", name: "B One" }] },
      { id: "c", name: "Provider C", endpoint: OTHER_ENDPOINT, models: [] },
      { id: "d", name: "Provider D", endpoint: OTHER_ENDPOINT, models: [{ id: "d1", name: "D One" }] },
    ],
    agents: [],
  };
  assert.deepEqual(buildModelChoices(catalog), [
    { providerID: "b", providerName: "Provider B", modelID: "b1", modelName: "B One", endpoint: REMOTE_ENDPOINT },
    { providerID: "d", providerName: "Provider D", modelID: "d1", modelName: "D One", endpoint: OTHER_ENDPOINT },
  ]);
});

test("buildAgentChoices lists the built-in primary agents first, then configured agents without duplicates", () => {
  assert.deepEqual(
    buildAgentChoices({ providers: [], agents: [] }).map((c) => c.id),
    ["build", "plan"],
  );
  assert.deepEqual(BUILTIN_AGENTS.map((b) => b.id), ["build", "plan"]);

  const choices = buildAgentChoices({ providers: [], agents: ["explore", "build"] });
  assert.deepEqual(choices.map((c) => c.id), ["build", "plan", "explore"]);
  assert.match(choices[0]?.label ?? "", /built-in/);
  assert.match(choices[2]?.label ?? "", /configured in the global opencode config/);
});

test("formatModelChoices and formatAgentChoices render 1-based numbered menus", () => {
  const models = buildModelChoices({
    providers: [{ id: "p", name: "Prov", endpoint: REMOTE_ENDPOINT, models: [{ id: "m", name: "Model" }] }],
    agents: [],
  });
  assert.deepEqual(formatModelChoices(models), [
    `[1] Prov (p) — model Model (m) — endpoint ${REMOTE_ENDPOINT}`,
  ]);
  const agents = buildAgentChoices({ providers: [], agents: ["explore"] });
  assert.deepEqual(formatAgentChoices(agents), [
    "[1] build (built-in) — the OpenCode default agent",
    "[2] plan (built-in) — read-only planning agent",
    "[3] explore (configured in the global opencode config)",
  ]);
});

// ——— runFirstRunSelection: the interactive flow ———

test("first-run selection saves the picked provider, model, display name, endpoint and agent; parent dirs are created", async () => {
  const dir = tempDir("diakosys-first-run-");
  const globalConfig = path.join(dir, "opencode.json");
  writeJson(globalConfig, CURRENT_FORMAT_CONFIG());
  // Nested, not-yet-existing path: the flow must create every parent directory.
  const diakosysConfig = path.join(dir, "home", ".config", "diakosys", "config.json");

  let modelMenu: string[] = [];
  let agentMenu: string[] = [];
  let output = "";
  const result = await runFirstRunSelection({
    globalConfigPath: globalConfig,
    diakosysConfigPath: diakosysConfig,
    selectModel: (menu) => {
      modelMenu = menu;
      return 1; // second choice → mimo-q8
    },
    selectAgent: (menu) => {
      agentMenu = menu;
      return 0; // build
    },
    write: (text) => {
      output += text;
    },
  });

  assert.ok(result.saved, "the flow must save");
  assert.deepEqual(result.config, {
    version: 1,
    endpoint: OTHER_ENDPOINT,
    provider: "mimo-q8-m5",
    modelId: "mimo-q8",
    modelName: "MiMo-V2.6-Distill-Qwen-9B Q8_0",
    agent: "build",
  });

  const raw = fs.readFileSync(diakosysConfig, "utf8");
  const saved = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(saved), ["version", "endpoint", "provider", "modelId", "modelName", "agent"]);
  assert.deepEqual(saved, result.config);
  assert.ok(raw.endsWith("\n"), "the file ends with a newline");

  // The menus show provider display name/ID, model display name/ID and endpoint.
  assert.match(output, /first-run setup/);
  assert.match(modelMenu[0] ?? "", /\[1\] MiMo 2\.6 Q6_K_L \(M5 llama\.cpp\) \(mimo-llama-m5\) — model MiMo 2\.6 9B Q6_K_L \(mimo-2\.6-9b-q6\) — endpoint /);
  assert.match(modelMenu[1] ?? "", /\[2\] MiMo Q8_0 \(M5 llama\.cpp\) \(mimo-q8-m5\) — model MiMo-V2\.6-Distill-Qwen-9B Q8_0 \(mimo-q8\) — endpoint /);
  assert.match(agentMenu[0] ?? "", /\[1\] build \(built-in\)/);
  assert.match(agentMenu[1] ?? "", /\[2\] plan \(built-in\)/);
  assert.match(agentMenu[2] ?? "", /\[3\] explore \(configured in the global opencode config\)/);
  assert.match(output, /Saved: provider mimo-q8-m5, model mimo-q8, agent build/);
});

test("first-run selection works for the legacy schema (top-level model fallback)", async () => {
  const dir = tempDir("diakosys-first-run-");
  const globalConfig = path.join(dir, "opencode.json");
  writeJson(globalConfig, LEGACY_FORMAT_CONFIG());
  const diakosysConfig = path.join(dir, ".config", "diakosys", "config.json");

  const result = await runFirstRunSelection({
    globalConfigPath: globalConfig,
    diakosysConfigPath: diakosysConfig,
    selectModel: () => 0,
    selectAgent: () => 0,
    write: () => undefined,
  });

  assert.ok(result.saved);
  assert.deepEqual(result.config, {
    version: 1,
    endpoint: "http://localhost:8080/v1",
    provider: "Qwen-Mimo",
    modelId: "model.gguf",
    modelName: "model.gguf",
    agent: "build",
  });
});

test("first-run selection can save a configured agent from the global opencode config", async () => {
  const dir = tempDir("diakosys-first-run-");
  const globalConfig = path.join(dir, "opencode.json");
  writeJson(globalConfig, CURRENT_FORMAT_CONFIG());
  const diakosysConfig = path.join(dir, ".config", "diakosys", "config.json");

  const result = await runFirstRunSelection({
    globalConfigPath: globalConfig,
    diakosysConfigPath: diakosysConfig,
    selectModel: () => 0,
    selectAgent: () => 2, // third choice: the configured "explore" agent
    write: () => undefined,
  });

  assert.ok(result.saved);
  assert.equal(result.config.agent, "explore");
});

test("first-run selection never overwrites an existing user config and never prompts", async () => {
  const dir = tempDir("diakosys-first-run-");
  const globalConfig = path.join(dir, "opencode.json");
  writeJson(globalConfig, CURRENT_FORMAT_CONFIG());
  const diakosysConfig = path.join(dir, ".config", "diakosys", "config.json");
  fs.mkdirSync(path.dirname(diakosysConfig), { recursive: true });
  const existing = '{"endpoint":"http://existing:1/v1"}';
  fs.writeFileSync(diakosysConfig, existing, "utf8");

  let prompted = false;
  const result = await runFirstRunSelection({
    globalConfigPath: globalConfig,
    diakosysConfigPath: diakosysConfig,
    selectModel: () => {
      prompted = true;
      return 0;
    },
    selectAgent: () => {
      prompted = true;
      return 0;
    },
    write: () => undefined,
  });

  assert.deepEqual(result, { saved: false, reason: "existing-config" });
  assert.equal(prompted, false, "no menu is shown when a config already exists");
  assert.equal(fs.readFileSync(diakosysConfig, "utf8"), existing, "the file is untouched");
});

test("first-run selection fails with an actionable error when the global config is missing or malformed", async () => {
  const dir = tempDir("diakosys-first-run-");
  const diakosysConfig = path.join(dir, ".config", "diakosys", "config.json");

  await assert.rejects(
    runFirstRunSelection({
      globalConfigPath: path.join(dir, "missing.json"),
      diakosysConfigPath: diakosysConfig,
      selectModel: () => 0,
      selectAgent: () => 0,
      write: () => undefined,
    }),
    /cannot read the global opencode config at .*missing\.json/,
  );

  const malformed = path.join(dir, "malformed.json");
  fs.writeFileSync(malformed, "{ broken", "utf8");
  await assert.rejects(
    runFirstRunSelection({
      globalConfigPath: malformed,
      diakosysConfigPath: diakosysConfig,
      selectModel: () => 0,
      selectAgent: () => 0,
      write: () => undefined,
    }),
    /cannot read the global opencode config at .*malformed\.json/,
  );
  assert.equal(fs.existsSync(diakosysConfig), false, "no config is written on failure");
});

test("first-run selection fails when no provider offers both models and an endpoint", async () => {
  const dir = tempDir("diakosys-first-run-");
  const globalConfig = path.join(dir, "opencode.json");
  writeJson(globalConfig, {
    providers: {
      "no-endpoint": { name: "No endpoint", models: { "m1": { name: "One" } } },
      "no-models": { name: "No models", settings: { baseURL: REMOTE_ENDPOINT } },
    },
  });
  const diakosysConfig = path.join(dir, ".config", "diakosys", "config.json");

  await assert.rejects(
    runFirstRunSelection({
      globalConfigPath: globalConfig,
      diakosysConfigPath: diakosysConfig,
      selectModel: () => 0,
      selectAgent: () => 0,
      write: () => undefined,
    }),
    /no usable models in the global opencode config/,
  );
  assert.equal(fs.existsSync(diakosysConfig), false);
});

test("an out-of-range model or agent selection aborts without writing anything", async () => {
  const dir = tempDir("diakosys-first-run-");
  const globalConfig = path.join(dir, "opencode.json");
  writeJson(globalConfig, CURRENT_FORMAT_CONFIG());
  const diakosysConfig = path.join(dir, ".config", "diakosys", "config.json");

  await assert.rejects(
    runFirstRunSelection({
      globalConfigPath: globalConfig,
      diakosysConfigPath: diakosysConfig,
      selectModel: () => 99,
      selectAgent: () => 0,
      write: () => undefined,
    }),
    /invalid model selection: expected a number in \[1-2\], got 99/,
  );
  assert.equal(fs.existsSync(diakosysConfig), false);

  await assert.rejects(
    runFirstRunSelection({
      globalConfigPath: globalConfig,
      diakosysConfigPath: diakosysConfig,
      selectModel: () => 0,
      selectAgent: () => -1,
      write: () => undefined,
    }),
    /invalid agent selection: expected a number in \[1-3\], got -1/,
  );
  assert.equal(fs.existsSync(diakosysConfig), false);
});

test("both selections are made before anything is written: a failing agent pick leaves no file", async () => {
  const dir = tempDir("diakosys-first-run-");
  const globalConfig = path.join(dir, "opencode.json");
  writeJson(globalConfig, CURRENT_FORMAT_CONFIG());
  const diakosysConfig = path.join(dir, ".config", "diakosys", "config.json");

  await assert.rejects(
    runFirstRunSelection({
      globalConfigPath: globalConfig,
      diakosysConfigPath: diakosysConfig,
      selectModel: () => 0,
      selectAgent: () => {
        throw new Error("user pressed Ctrl-C");
      },
      write: () => undefined,
    }),
    /user pressed Ctrl-C/,
  );
  assert.equal(fs.existsSync(diakosysConfig), false);
});

// ——— saved-config loading: resolveConfig / resolveEndpoint ———

test("without a user config, resolveConfig falls back to the documented defaults", async () => {
  const home = tempDir("diakosys-resolve-");
  process.env.HOME = home;
  // Disable auto-discovery to test fallback behavior
  process.env.DIAKOSYS_AUTO_DISCOVERY = "false";
  const config = await resolveConfig();
  assert.equal(config.provider, "mimo-llama-m5");
  assert.equal(config.modelId, "mimo-2.6-9b-q6");
  assert.equal(config.model, "mimo-llama-m5/mimo-2.6-9b-q6");
  assert.equal(config.agent, undefined);
  assert.equal(config.endpoint, "http://localhost:8082/v1");
  process.env.HOME = "";
  delete process.env.DIAKOSYS_AUTO_DISCOVERY;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

test("a saved first-run config supplies provider, model, agent and the remote endpoint", async () => {
  const home = tempDir("diakosys-resolve-");
  writeJson(diakosysConfigPath(home), {
    version: 1,
    endpoint: REMOTE_ENDPOINT,
    provider: "mimo-q8-m5",
    modelId: "mimo-q8",
    modelName: "MiMo-V2.6-Distill-Qwen-9B Q8_0",
    agent: "plan",
  });
  process.env.HOME = home;
  const config = await resolveConfig();
  assert.equal(config.provider, "mimo-q8-m5");
  assert.equal(config.modelId, "mimo-q8");
  assert.equal(config.model, "mimo-q8-m5/mimo-q8");
  assert.equal(config.agent, "plan");
  // No silent localhost fallback: the explicitly selected remote endpoint stands.
  assert.equal(config.endpoint, REMOTE_ENDPOINT);
  assert.equal(resolveEndpoint(), REMOTE_ENDPOINT);
  process.env.HOME = "";
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

test("environment variables win over the saved first-run config", async () => {
  const home = tempDir("diakosys-resolve-");
  writeJson(diakosysConfigPath(home), {
    version: 1,
    endpoint: REMOTE_ENDPOINT,
    provider: "mimo-q8-m5",
    modelId: "mimo-q8",
    agent: "plan",
  });
  process.env.HOME = home;
  process.env.DIAKOSYS_ENDPOINT = OTHER_ENDPOINT;
  process.env.DIAKOSYS_ORCHESTRATOR_PROVIDER = "env-provider";
  process.env.DIAKOSYS_ORCHESTRATOR_MODEL_ID = "env-model";
  process.env.DIAKOSYS_ORCHESTRATOR_AGENT = "build";
  const config = await resolveConfig();
  assert.equal(config.provider, "env-provider");
  assert.equal(config.modelId, "env-model");
  assert.equal(config.model, "env-provider/env-model");
  assert.equal(config.agent, "build");
  assert.equal(config.endpoint, OTHER_ENDPOINT);
  process.env.HOME = "";
  process.env.DIAKOSYS_ENDPOINT = "";
  process.env.DIAKOSYS_ORCHESTRATOR_PROVIDER = "";
  process.env.DIAKOSYS_ORCHESTRATOR_MODEL_ID = "";
  process.env.DIAKOSYS_ORCHESTRATOR_AGENT = "";
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

test("DIAKOSYS_ORCHESTRATOR_MODEL replaces provider/model entirely, the saved agent still applies", async () => {
  const home = tempDir("diakosys-resolve-");
  writeJson(diakosysConfigPath(home), {
    version: 1,
    endpoint: REMOTE_ENDPOINT,
    provider: "mimo-q8-m5",
    modelId: "mimo-q8",
    agent: "plan",
  });
  process.env.HOME = home;
  process.env.DIAKOSYS_ORCHESTRATOR_MODEL = "Qwen-Mimo/model.gguf";
  // Disable auto-discovery to prevent it from overwriting the explicit model
  process.env.DIAKOSYS_AUTO_DISCOVERY = "false";
  const config = await resolveConfig();
  assert.equal(config.model, "Qwen-Mimo/model.gguf");
  assert.equal(config.provider, "Qwen-Mimo");
  assert.equal(config.modelId, "model.gguf");
  assert.equal(config.agent, "plan");
  process.env.HOME = "";
  delete process.env.DIAKOSYS_AUTO_DISCOVERY;
  process.env.DIAKOSYS_ORCHESTRATOR_MODEL = "";
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

test("a partially saved config fills the missing side from the defaults", async () => {
  const home = tempDir("diakosys-resolve-");
  writeJson(diakosysConfigPath(home), { provider: "mimo-q8-m5" });
  process.env.HOME = home;
  // Disable auto-discovery to test that saved config takes precedence
  process.env.DIAKOSYS_AUTO_DISCOVERY = "false";
  const config = await resolveConfig();
  assert.equal(config.provider, "mimo-q8-m5");
  assert.equal(config.modelId, "mimo-2.6-9b-q6");
  assert.equal(config.agent, undefined);
  process.env.HOME = "";
  delete process.env.DIAKOSYS_AUTO_DISCOVERY;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

test("junk saved values are ignored: defaults win and nothing crashes", async () => {
  const home = tempDir("diakosys-resolve-");
  writeJson(diakosysConfigPath(home), {
    version: 1,
    provider: 42,
    modelId: ["not", "a", "string"],
    agent: "",
    endpoint: REMOTE_ENDPOINT,
  });
  process.env.HOME = home;
  // Disable auto-discovery to test that defaults are used for invalid values
  process.env.DIAKOSYS_AUTO_DISCOVERY = "false";
  const config = await resolveConfig();
  assert.equal(config.provider, "mimo-llama-m5");
  assert.equal(config.modelId, "mimo-2.6-9b-q6");
  assert.equal(config.agent, undefined);
  assert.equal(config.endpoint, REMOTE_ENDPOINT);
  process.env.HOME = "";
  delete process.env.DIAKOSYS_AUTO_DISCOVERY;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

// ——— shouldRunFirstRunSetup: the interactive gate ———

test("shouldRunFirstRunSetup only fires for real TTY command runs without --mock or help", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  const none = {};

  assert.equal(shouldRunFirstRunSetup(["status"], tty), true);
  assert.equal(shouldRunFirstRunSetup(["run", "--max", "3"], tty), true);
  assert.equal(shouldRunFirstRunSetup(["doctor"], tty), true);

  // never for scripts/tests/CI (no TTY at all)
  assert.equal(shouldRunFirstRunSetup(["status"], pipe), false);
  assert.equal(shouldRunFirstRunSetup(["status"], none), false);

  // a bare invocation (no command, e.g. `npm start`) is an interactive start,
  // not help — it qualifies on a real TTY
  assert.equal(shouldRunFirstRunSetup([], tty), true);

  // never for explicit help in any form
  assert.equal(shouldRunFirstRunSetup(["help"], tty), false);
  assert.equal(shouldRunFirstRunSetup(["run", "-h"], tty), false);
  assert.equal(shouldRunFirstRunSetup(["run", "--help"], tty), false);

  // never for mock mode
  assert.equal(shouldRunFirstRunSetup(["doctor", "--mock"], tty), false);
  assert.equal(shouldRunFirstRunSetup(["cycle", "--mock"], tty), false);
});

// ——— improvement regressions: endpoint validation, consolidated gate, menu re-ask ———

test("first-run setup rejects an unusable provider endpoint before the agent question and writes nothing", async () => {
  const dir = tempDir("diakosys-first-run-");
  const globalConfig = path.join(dir, "opencode.json");
  const diakosysConfig = path.join(dir, ".config", "diakosys", "config.json");

  writeJson(globalConfig, {
    providers: {
      "bad-endpoint": {
        name: "Bad endpoint",
        settings: { baseURL: "not a url" },
        models: { "m1": { name: "One" } },
      },
    },
  });
  let agentAsked = false;
  await assert.rejects(
    runFirstRunSelection({
      globalConfigPath: globalConfig,
      diakosysConfigPath: diakosysConfig,
      selectModel: () => 0,
      selectAgent: () => {
        agentAsked = true;
        return 0;
      },
      write: () => undefined,
    }),
    /unusable endpoint for provider bad-endpoint in the global opencode config at .*: invalid endpoint "not a url"/,
  );
  assert.equal(agentAsked, false, "the agent question must not be asked after endpoint validation failed");
  assert.equal(fs.existsSync(diakosysConfig), false, "no config file is created");

  // A second scheme-level failure: any non-http(s) URL is equally unusable.
  writeJson(globalConfig, {
    providers: {
      "ftp-endpoint": {
        name: "FTP endpoint",
        settings: { baseURL: "ftp://192.0.2.9/v1" },
        models: { "m1": { name: "One" } },
      },
    },
  });
  await assert.rejects(
    runFirstRunSelection({
      globalConfigPath: globalConfig,
      diakosysConfigPath: diakosysConfig,
      selectModel: () => 0,
      selectAgent: () => 0,
      write: () => undefined,
    }),
    /unusable endpoint for provider ftp-endpoint .*expected an absolute http\(s\) URL with a hostname/,
  );
  assert.equal(fs.existsSync(diakosysConfig), false);
});

test("maybeFirstRunSetup runs the setup when the gate permits (TTY + ordinary argv), reporting failures itself", async () => {
  const home = tempDir("diakosys-gate-");
  await withIsolatedEnvAsync(async () => {
    process.env.HOME = home;
    const stderr = new PassThrough();
    const errText = capture(stderr);
    // No global opencode config under this HOME: the flow starts (the gate
    // passed inside the hook) and fails loudly, which the hook reports while
    // the command continues.
    await withDeadline(
      maybeFirstRunSetup(["status"], {
        stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
        stdout: asWriteStream(new PassThrough()),
        stderr: asWriteStream(stderr),
      }),
      "maybeFirstRunSetup",
    );
    assert.match(errText.text(), /first-run setup not completed: cannot read the global opencode config/);
    assert.equal(fs.existsSync(diakosysConfigPath(home)), false, "no config is written on failure");
  });
});

test("maybeFirstRunSetup itself blocks --mock and help arguments even with an interactive stdin", async () => {
  const home = tempDir("diakosys-gate-");
  await withIsolatedEnvAsync(async () => {
    process.env.HOME = home;
    for (const argv of [["doctor", "--mock"], ["run", "--help"], ["cycle", "-h"]]) {
      const stderr = new PassThrough();
      const errText = capture(stderr);
      await withDeadline(
        maybeFirstRunSetup(argv, {
          stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
          stdout: asWriteStream(new PassThrough()),
          stderr: asWriteStream(stderr),
        }),
        `maybeFirstRunSetup(${argv.join(" ")})`,
      );
      assert.equal(errText.text(), "", `no first-run output is expected for ${argv.join(" ")}`);
    }
    assert.equal(fs.existsSync(diakosysConfigPath(home)), false);
  });
});

test("maybeFirstRunSetup skips entirely for a non-interactive stdin", async () => {
  const home = tempDir("diakosys-gate-");
  await withIsolatedEnvAsync(async () => {
    process.env.HOME = home;
    const stderr = new PassThrough();
    const errText = capture(stderr);
    await withDeadline(
      maybeFirstRunSetup(["status"], {
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
        stdout: asWriteStream(new PassThrough()),
        stderr: asWriteStream(stderr),
      }),
      "maybeFirstRunSetup",
    );
    assert.equal(errText.text(), "");
    assert.equal(fs.existsSync(diakosysConfigPath(home)), false);
  });
});

test("maybeFirstRunSetup lets a bare invocation (empty argv) enter first-run setup on a TTY", async () => {
  const home = tempDir("diakosys-gate-");
  await withIsolatedEnvAsync(async () => {
    process.env.HOME = home;
    const stderr = new PassThrough();
    const errText = capture(stderr);
    // No global opencode config under this HOME: empty argv passed the gate
    // and the flow started, failing loudly at the missing global config —
    // proof that a bare `npm start` reaches the setup (and never blocks
    // non-TTY or scripted runs, covered below and at CLI level).
    await withDeadline(
      maybeFirstRunSetup([], {
        stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
        stdout: asWriteStream(new PassThrough()),
        stderr: asWriteStream(stderr),
      }),
      "maybeFirstRunSetup([])",
    );
    assert.match(errText.text(), /first-run setup not completed: cannot read the global opencode config/);
    assert.equal(fs.existsSync(diakosysConfigPath(home)), false);
  });
});

test("maybeFirstRunSetup returns silently for a bare invocation when a config already exists", async () => {
  const home = tempDir("diakosys-gate-");
  await withIsolatedEnvAsync(async () => {
    const existing = { version: 1, endpoint: REMOTE_ENDPOINT };
    writeJson(diakosysConfigPath(home), existing);
    process.env.HOME = home;
    const stderr = new PassThrough();
    const errText = capture(stderr);
    await withDeadline(
      maybeFirstRunSetup([], {
        stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
        stdout: asWriteStream(new PassThrough()),
        stderr: asWriteStream(stderr),
      }),
      "maybeFirstRunSetup([]) with existing config",
    );
    assert.equal(errText.text(), "", "an existing config means no setup and no output");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(diakosysConfigPath(home), "utf8")),
      existing,
      "the existing config is untouched",
    );
  });
});

test("maybeFirstRunSetup completes the whole setup from scripted stdin and persists the selection", async () => {
  const home = tempDir("diakosys-gate-");
  await withIsolatedEnvAsync(async () => {
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), CURRENT_FORMAT_CONFIG());
    process.env.HOME = home;

    const input = ttyInput(); // TTY-flagged stream; lines are fed per prompt below
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk: Buffer) => {
      out += String(chunk);
    });
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (chunk: Buffer) => {
      err += String(chunk);
    });

    const pending = withDeadline(
      maybeFirstRunSetup(["status"], {
        stdin: asReadStream(input),
        stdout: asWriteStream(output),
        stderr: asWriteStream(stderr),
      }),
      "first-run setup from scripted stdin",
    );

    // Feed one answer per prompt, only once the prompt is visible — a line
    // arriving with no pending question is dropped by readline.
    await waitUntil(() => out.includes("Select a model [1-2]: "));
    input.write("2\n"); // model 2 → mimo-q8-m5
    await waitUntil(() => out.includes("Select an agent [1-3]: "));
    input.write("2\n"); // agent 2 → plan
    await pending;

    assert.equal(err, "", "a completed setup prints no error");
    const saved = JSON.parse(fs.readFileSync(diakosysConfigPath(home), "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved, {
      version: 1,
      endpoint: OTHER_ENDPOINT,
      provider: "mimo-q8-m5",
      modelId: "mimo-q8",
      modelName: "MiMo-V2.6-Distill-Qwen-9B Q8_0",
      agent: "plan",
    });
    // Both prompts were rendered with their menu sizes.
    assert.match(out, /Select a model \[1-2\]: /);
    assert.match(out, /Select an agent \[1-3\]: /);
    input.end();
  });
});

test("numberPrompt re-asks on non-numeric and out-of-range input instead of aborting", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (chunk: Buffer) => {
    out += String(chunk);
  });

  const pending = withDeadline(
    numberPrompt("Pick [1-2]: ", asReadStream(input), asWriteStream(output), 2),
    "numberPrompt",
  );
  const promptCount = (): number => (out.match(/Pick \[1-2\]: /g) ?? []).length;

  // Feed one answer per prompt: junk → re-ask, above range → re-ask,
  // zero → re-ask, valid → returns the 0-based index.
  await waitUntil(() => promptCount() === 1);
  input.write("abc\n");
  await waitUntil(() => promptCount() === 2);
  input.write("9\n");
  await waitUntil(() => promptCount() === 3);
  input.write("0\n");
  await waitUntil(() => promptCount() === 4);
  input.write("2\n");

  assert.equal(await pending, 1);
  assert.match(out, /Please enter a number\./);
  assert.match(out, /Please enter a number between 1 and 2\./);
  assert.equal(promptCount(), 4, "the question is re-asked for every invalid answer");
  input.end();
});

test("numberPrompt aborts with a clear error when stdin closes without an answer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  // The call registers the pending question synchronously; then signal EOF
  // like a closed pipe / Ctrl-D / dropped SSH session.
  const pending = withDeadline(
    numberPrompt("Pick [1-2]: ", asReadStream(input), asWriteStream(output), 2),
    "numberPrompt",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.end();
  await assert.rejects(pending, /setup aborted: no answer \(stdin closed\)/);
});

// ——— CLI level: non-interactive runs must not hang and must not prompt ———

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(ROOT, "src", "cli.ts");
const execFileP = promisify(execFile);

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], home: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  const dbPath = path.join(home, "tasks.db");
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [CLI_ENTRY, ...args],
      {
        cwd: ROOT,
        // Deliberately minimal env: no DIAKOSYS_* leakage; stdin is a pipe
        // (non-TTY), so the first-run setup must skip instantly.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          DIAKOSYS_ORCHESTRATOR_DB: dbPath,
          DIAKOSYS_ORCHESTRATOR_MODEL: "Qwen-Mimo/model",
          ...extraEnv,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code === "number") {
      return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    throw err; // spawn-level failure (e.g. the 30s timeout) — fail loudly
  }
}

test("non-interactive `status` without any config completes instantly and silently (no prompt, no hang)", async () => {
  const home = tempDir("diakosys-cli-run-");
  const r = await runCli(["status"], home);
  assert.equal(r.code, 0, `status must exit 0, stderr: ${r.stderr}`);
  assert.equal(r.stderr, "", "non-interactive runs print no first-run chatter");
  assert.equal(fs.existsSync(diakosysConfigPath(home)), false, "no config is written without interaction");
});

test("non-interactive `doctor --mock` with a global opencode config present does not hang and exits cleanly", async () => {
  const home = tempDir("diakosys-cli-run-");
  writeJson(path.join(home, ".config", "opencode", "opencode.json"), CURRENT_FORMAT_CONFIG());
  const r = await runCli(["doctor", "--mock"], home);
  assert.equal(r.code, 0, `doctor --mock must exit 0, stderr: ${r.stderr}`);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /skip  opencode — --mock requested/);
  assert.equal(fs.existsSync(diakosysConfigPath(home)), false);
});

test("`doctor --mock` with an existing diakosys config skips the first-run setup entirely", async () => {
  const home = tempDir("diakosys-cli-run-");
  writeJson(path.join(home, ".config", "opencode", "opencode.json"), CURRENT_FORMAT_CONFIG());
  const saved = {
    version: 1,
    endpoint: REMOTE_ENDPOINT,
    provider: "mimo-q8-m5",
    modelId: "mimo-q8",
    modelName: "MiMo-V2.6-Distill-Qwen-9B Q8_0",
    agent: "build",
  };
  writeJson(diakosysConfigPath(home), saved);
  const r = await runCli(["doctor", "--mock"], home);
  assert.equal(r.code, 0, `doctor --mock must exit 0, stderr: ${r.stderr}`);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(fs.readFileSync(diakosysConfigPath(home), "utf8")), saved, "the config is untouched");
});

test("non-interactive bare invocation (`npm start` equivalent) prints usage, exits 0 and writes no config", async () => {
  const home = tempDir("diakosys-cli-run-");
  const r = await runCli([], home);
  assert.equal(r.code, 0, `a bare non-TTY run must exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage: orchestrator <command> \[options\]/);
  assert.equal(r.stderr, "", "a bare non-TTY run prints no first-run chatter");
  assert.equal(fs.existsSync(diakosysConfigPath(home)), false, "no config is written without interaction");
});

// ——— adapter level: the saved agent is actually applied ———

// v1 flavor for this file: the fake spawn emits the "opencode " banner prefix,
// so LiveOpenCodeAdapter detects the v1 protocol (real SDK client → local stub).
installFakeSpawn({ bannerPrefix: "opencode " });

const PROJECT_DIR = "/tmp/diakosys-first-run-agent-test";

interface CapturedRequest {
  method: string;
  pathname: string;
  body: string;
}

/** v1-wire stub: session create, prompt_async (agent captured), SSE idle, messages. */
async function startV1Stub(): Promise<{ url: string; requests: CapturedRequest[]; close(): Promise<void> }> {
  const requests: CapturedRequest[] = [];
  let sessionId = "";
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
      requests.push({ method: req.method ?? "", pathname: url.pathname, body });

      if (req.method === "POST" && url.pathname === "/session") {
        sessionId = "ses_stub_001";
        respondJson(res, 200, { id: sessionId });
        return;
      }
      if (req.method === "GET" && url.pathname === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const sawPrompt = await Promise.race([promptAsyncPromise, new Promise<boolean>((r) => setTimeout(() => r(false), 3_000))]);
        if (sawPrompt) {
          res.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: sessionId } })}\n\n`);
        }
        res.end();
        return;
      }
      if (req.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
        promptAsyncSeen?.();
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && /^\/session\/[^/]+\/message$/.test(url.pathname)) {
        respondJson(res, 200, [
          {
            info: { role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "stub reply" }],
          },
        ]);
        return;
      }
      if (req.method === "GET" && url.pathname === "/agent") {
        respondJson(res, 200, [{ name: "build" }]);
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/__hook__/")) {
        respondJson(res, 200, {});
        return;
      }
      respondJson(res, 404, { name: "not_found", data: { message: `no route: ${req.method} ${url.pathname}` } });
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
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function setHolder(url: string): void {
  (globalThis as { __diakosysSdkStub?: { url: string; createServerCalls: number; closeCalls: number } }).__diakosysSdkStub = {
    url,
    createServerCalls: 0,
    closeCalls: 0,
  };
}

function clearHolder(): void {
  delete (globalThis as { __diakosysSdkStub?: unknown }).__diakosysSdkStub;
}

const findRequest = (requests: CapturedRequest[], pred: (r: CapturedRequest) => boolean): CapturedRequest | undefined =>
  requests.find(pred);

test("v1: the configured agent reaches prompt_async when the caller passes none", async () => {
  const stub = await startV1Stub();
  setHolder(stub.url);
  const adapter = new LiveOpenCodeAdapter({
    projectDirectory: PROJECT_DIR,
    model: "Qwen-Mimo/model.gguf",
    agent: "plan",
    startupTimeoutMs: 2_000,
  });
  try {
    const result = await adapter.prompt({
      title: "configured agent",
      description: "uses the adapter-level agent",
      directory: PROJECT_DIR,
    });
    assert.ok(result.sessionId.length > 0);
    const prompt = findRequest(stub.requests, (r) => r.method === "POST" && /\/prompt_async$/.test(r.pathname));
    assert.ok(prompt !== undefined, "prompt_async must be called");
    const body = JSON.parse(prompt.body) as Record<string, unknown>;
    assert.equal(body.agent, "plan");
    assert.deepEqual(body.model, { providerID: "Qwen-Mimo", modelID: "model.gguf" });
  } finally {
    await adapter.close();
    clearHolder();
    await stub.close();
  }
});

test("v1: without a configured agent the prompt body carries no agent field (server default)", async () => {
  const stub = await startV1Stub();
  setHolder(stub.url);
  const adapter = new LiveOpenCodeAdapter({
    projectDirectory: PROJECT_DIR,
    model: "Qwen-Mimo/model.gguf",
    startupTimeoutMs: 2_000,
  });
  try {
    await adapter.prompt({
      title: "default agent",
      description: "no agent anywhere",
      directory: PROJECT_DIR,
    });
    const prompt = findRequest(stub.requests, (r) => r.method === "POST" && /\/prompt_async$/.test(r.pathname));
    assert.ok(prompt !== undefined);
    const body = JSON.parse(prompt.body) as Record<string, unknown>;
    assert.equal("agent" in body, false);
  } finally {
    await adapter.close();
    clearHolder();
    await stub.close();
  }
});

test("v1: an explicit per-call agent wins over the configured one", async () => {
  const stub = await startV1Stub();
  setHolder(stub.url);
  const adapter = new LiveOpenCodeAdapter({
    projectDirectory: PROJECT_DIR,
    model: "Qwen-Mimo/model.gguf",
    agent: "plan",
    startupTimeoutMs: 2_000,
  });
  try {
    await adapter.prompt({
      title: "override",
      description: "per-call agent",
      directory: PROJECT_DIR,
      agent: "build",
    });
    const prompt = findRequest(stub.requests, (r) => r.method === "POST" && /\/prompt_async$/.test(r.pathname));
    assert.ok(prompt !== undefined);
    const body = JSON.parse(prompt.body) as Record<string, unknown>;
    assert.equal(body.agent, "build");
  } finally {
    await adapter.close();
    clearHolder();
    await stub.close();
  }
});

// ——— v2: the agent is bound at session creation ———

/** v2-wire stub: only what createV2Client().create() needs (POST /api/session). */
async function startV2SessionStub(): Promise<{ url: string; bodies: Array<Record<string, unknown>>; close(): Promise<void> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/api/session") {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: "ses_stub_001" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "not_found" }));
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
    bodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("v2: session.create carries the configured agent", async () => {
  const stub = await startV2SessionStub();
  const client = createV2Client({ url: stub.url, close() {} }, {
    directory: PROJECT_DIR,
    model: { providerID: "mimo-q8-m5", modelID: "mimo-q8" },
    agent: "plan",
    location: { directory: PROJECT_DIR },
    password: "stub-password",
    hostname: "localhost",
    port: 0,
    timeout: 2_000,
  });
  const sessionId = await client.create();
  assert.equal(sessionId, "ses_stub_001");
  assert.deepEqual(stub.bodies[0], {
    model: { providerID: "mimo-q8-m5", id: "mimo-q8" },
    agent: "plan",
    location: { directory: PROJECT_DIR },
  });
  await stub.close();
});

test("v2: without an agent the session.create body is unchanged (no agent key at all)", async () => {
  const stub = await startV2SessionStub();
  const client = createV2Client({ url: stub.url, close() {} }, {
    directory: PROJECT_DIR,
    model: { providerID: "mimo-q8-m5", modelID: "mimo-q8" },
    location: { directory: PROJECT_DIR },
    password: "stub-password",
    hostname: "localhost",
    port: 0,
    timeout: 2_000,
  });
  await client.create();
  assert.deepEqual(stub.bodies[0], {
    model: { providerID: "mimo-q8-m5", id: "mimo-q8" },
    location: { directory: PROJECT_DIR },
  });
  await stub.close();
});
