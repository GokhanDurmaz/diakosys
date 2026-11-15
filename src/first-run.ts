/**
 * First-run interactive configuration.
 *
 * On first setup (no `~/.config/diakosys/config.json` yet) Diakosys reads the
 * user's global OpenCode configuration, lists the configured providers and
 * models, lets the user pick one interactively, and saves the selected
 * endpoint, provider/model and agent to `~/.config/diakosys/config.json`.
 *
 * The model list is built from the user's actual OpenCode config — both
 * schema generations are supported (mirroring configWithEndpoint's reader):
 *   * current: providers.<id>.{ name, settings.baseURL, models.<mid>.{ name, ... } }
 *   * legacy:  provider.<id>.{ name?, options.baseURL, models? }
 *              (with the top-level "model": "<provider>/<modelId>" fallback)
 *
 * Agent choices combine the built-in primary agents of the installed OpenCode
 * interface with the agents configured in the global config's top-level
 * `agent` map. Grounded against opencode 2.2.6's GET /agent response through
 * @opencode/client 2.2.7: "build" ("The default agent…") and "plan"
 * (read-only) are the visible primary agents; "general"/"explore" are
 * subagents; "compaction"/"title"/"summary" are hidden internals. Selection
 * is never automatic — the user always picks, so no incompatible agent is
 * chosen silently.
 *
 * The interactive prompt is a thin shell over the pure selection flow:
 * everything testable takes the choice as a parameter, so tests drive the
 * flow without a TTY and the CLI never blocks non-interactive runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { readUserConfig, userConfigPath, validateEndpoint } from "./config.ts";
import { globalOpencodeConfigPath } from "./opencode.ts";

export interface OpencodeProviderInfo {
  id: string;
  /** Display name from the config, falling back to the provider id. */
  name: string;
  /** settings.baseURL (current format) or options.baseURL (legacy format). */
  endpoint: string | undefined;
  models: Array<{ id: string; name: string }>;
}

export interface OpencodeCatalog {
  providers: Array<OpencodeProviderInfo>;
  /** Agent ids configured in the global config's top-level `agent` map. */
  agents: string[];
}

export interface ModelChoice {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  endpoint: string;
}

export interface AgentChoice {
  id: string;
  label: string;
}

/** The exact structure persisted by the first-run setup (schema version 1). */
export interface SavedFirstRunConfig {
  version: number;
  endpoint: string;
  provider: string;
  modelId: string;
  modelName: string;
  agent: string;
}

/** Built-in primary agents (see the module comment for the grounding). */
export const BUILTIN_AGENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "build", label: "build (built-in) — the OpenCode default agent" },
  { id: "plan", label: "plan (built-in) — read-only planning agent" },
];

/** True when the value is a non-null, non-array plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A non-empty string, usable as a display name or URL. */
function displayString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function baseURLFrom(block: Record<string, unknown> | undefined): string | undefined {
  return displayString(block?.baseURL);
}

function modelsFrom(models: Record<string, unknown> | undefined): Array<{ id: string; name: string }> {
  if (models === undefined) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const [id, entry] of Object.entries(models)) {
    if (!isRecord(entry)) continue;
    out.push({ id, name: displayString(entry.name) ?? id });
  }
  return out;
}

/**
 * Read the global OpenCode config into a provider/model/agent catalog.
 * Returns undefined when the file is missing, unparsable or not a JSON
 * object; a present-but-empty catalog is returned as-is so the caller can
 * report "no usable models" distinctly from "cannot read the config".
 */
export function readOpencodeCatalog(configPath: string): OpencodeCatalog | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const providers: Array<OpencodeProviderInfo> = [];
  const current = isRecord(parsed.providers) ? parsed.providers : undefined;
  if (current !== undefined) {
    for (const [id, block] of Object.entries(current)) {
      if (!isRecord(block)) continue;
      providers.push({
        id,
        name: displayString(block.name) ?? id,
        endpoint: baseURLFrom(isRecord(block.settings) ? block.settings : undefined),
        models: modelsFrom(isRecord(block.models) ? block.models : undefined),
      });
    }
  }
  const legacy = isRecord(parsed.provider) ? parsed.provider : undefined;
  if (legacy !== undefined) {
    for (const [id, block] of Object.entries(legacy)) {
      if (!isRecord(block)) continue;
      let models = modelsFrom(isRecord(block.models) ? block.models : undefined);
      if (models.length === 0 && typeof parsed.model === "string" && parsed.model.startsWith(`${id}/`)) {
        // Legacy configs name a single top-level model as "<provider>/<modelId>".
        const modelId = parsed.model.slice(id.length + 1);
        models = [{ id: modelId, name: modelId }];
      }
      providers.push({
        id,
        name: displayString(block.name) ?? id,
        endpoint: baseURLFrom(isRecord(block.options) ? block.options : undefined),
        models,
      });
    }
  }

  const agents = isRecord(parsed.agent) ? Object.keys(parsed.agent) : [];
  return { providers, agents };
}

/**
 * Flatten the catalog into selectable (provider, model) pairs in config
 * order. Providers without a baseURL are skipped — their models cannot be
 * configured without an endpoint to save.
 */
export function buildModelChoices(catalog: OpencodeCatalog): Array<ModelChoice> {
  const choices: Array<ModelChoice> = [];
  for (const provider of catalog.providers) {
    if (provider.endpoint === undefined) continue;
    for (const model of provider.models) {
      choices.push({
        providerID: provider.id,
        providerName: provider.name,
        modelID: model.id,
        modelName: model.name,
        endpoint: provider.endpoint,
      });
    }
  }
  return choices;
}

/** Built-in primary agents first, then configured agents (deduplicated). */
export function buildAgentChoices(catalog: OpencodeCatalog): Array<AgentChoice> {
  const out: Array<AgentChoice> = BUILTIN_AGENTS.map((b) => ({ id: b.id, label: b.label }));
  for (const id of catalog.agents) {
    if (out.some((c) => c.id === id)) continue;
    out.push({ id, label: `${id} (configured in the global opencode config)` });
  }
  return out;
}

export function formatModelChoices(choices: ReadonlyArray<ModelChoice>): string[] {
  return choices.map(
    (c, i) =>
      `[${i + 1}] ${c.providerName} (${c.providerID}) — model ${c.modelName} (${c.modelID}) — endpoint ${c.endpoint}`,
  );
}

export function formatAgentChoices(choices: ReadonlyArray<AgentChoice>): string[] {
  return choices.map((c, i) => `[${i + 1}] ${c.label}`);
}

export type FirstRunResult =
  | { saved: false; reason: "existing-config" }
  | { saved: true; config: SavedFirstRunConfig };

export interface FirstRunDeps {
  globalConfigPath: string;
  diakosysConfigPath: string;
  /** Returns the chosen 0-based index; validated against the menu length. */
  selectModel: (menu: string[]) => number | Promise<number>;
  selectAgent: (menu: string[]) => number | Promise<number>;
  /** Menu/progress sink (default: process.stdout). */
  write?: (text: string) => void;
}

/**
 * The pure first-run flow: read the global OpenCode config, render the model
 * and agent menus, persist the selection to the Diakosys user config. Never
 * overwrites an existing config file; both selections are made before
 * anything is written, so a failed selection leaves no file behind. The
 * selected endpoint is validated with validateEndpoint before the agent
 * question is asked, so an unusable baseURL aborts the setup with a clear
 * error instead of being persisted to fail every later command.
 */
export async function runFirstRunSelection(deps: FirstRunDeps): Promise<FirstRunResult> {
  if (fs.existsSync(deps.diakosysConfigPath)) {
    return { saved: false, reason: "existing-config" };
  }

  const catalog = readOpencodeCatalog(deps.globalConfigPath);
  if (catalog === undefined) {
    throw new Error(
      `cannot read the global opencode config at ${deps.globalConfigPath} (missing or not a JSON object)`,
    );
  }
  const modelChoices = buildModelChoices(catalog);
  if (modelChoices.length === 0) {
    throw new Error(
      `no usable models in the global opencode config at ${deps.globalConfigPath}: every offered model needs a provider entry with models and a settings.baseURL (legacy format: options.baseURL)`,
    );
  }

  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const modelMenu = formatModelChoices(modelChoices);
  write("Diakosys first-run setup — select the model to use:\n");
  for (const line of modelMenu) write(`  ${line}\n`);
  const modelIndex = await deps.selectModel(modelMenu);
  const selected = modelChoices[modelIndex];
  if (
    !Number.isInteger(modelIndex) ||
    modelIndex < 0 ||
    modelIndex >= modelChoices.length ||
    selected === undefined
  ) {
    throw new Error(
      `invalid model selection: expected a number in [1-${modelChoices.length}], got ${String(modelIndex)}`,
    );
  }

  // Validate before asking anything else: a provider whose baseURL cannot
  // serve OpenAI-compatible requests would otherwise be persisted and fail
  // every later command at resolveEndpoint time. Nothing has been written
  // yet, so failing here simply leaves the setup uncompleted.
  try {
    validateEndpoint(selected.endpoint);
  } catch (err) {
    throw new Error(
      `unusable endpoint for provider ${selected.providerID} in the global opencode config at ${deps.globalConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const agentChoices = buildAgentChoices(catalog);
  const agentMenu = formatAgentChoices(agentChoices);
  write("\nSelect the agent orchestrator sessions should run as:\n");
  for (const line of agentMenu) write(`  ${line}\n`);
  const agentIndex = await deps.selectAgent(agentMenu);
  const agentChoice = agentChoices[agentIndex];
  if (
    !Number.isInteger(agentIndex) ||
    agentIndex < 0 ||
    agentIndex >= agentChoices.length ||
    agentChoice === undefined
  ) {
    throw new Error(
      `invalid agent selection: expected a number in [1-${agentChoices.length}], got ${String(agentIndex)}`,
    );
  }

  const config: SavedFirstRunConfig = {
    version: 1,
    endpoint: selected.endpoint,
    provider: selected.providerID,
    modelId: selected.modelID,
    modelName: selected.modelName,
    agent: agentChoice.id,
  };
  saveFirstRunConfig(deps.diakosysConfigPath, config);
  write(
    `\nSaved: provider ${config.provider}, model ${config.modelId}, agent ${config.agent}, endpoint ${config.endpoint}\n`,
  );
  write(`Config file: ${deps.diakosysConfigPath}\n`);
  return { saved: true, config };
}

/** mkdir -p the parent, then an atomic tmp+rename write. Refuses to overwrite. */
function saveFirstRunConfig(filePath: string, config: SavedFirstRunConfig): void {
  if (fs.existsSync(filePath)) {
    throw new Error(`refusing to overwrite the existing config at ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Decide whether the interactive first-run setup may run for this invocation.
 * Only a real interactive terminal that is not asking for help and not
 * running in mock mode qualifies — scripts, tests and CI never block on a
 * prompt. A bare invocation (no command, e.g. `npm start`) is an interactive
 * start, not help: it qualifies, so the one-time setup runs before the usage
 * screen. Only an explicit `help` command or `-h`/`--help` counts as help.
 *
 * This is the single authoritative gate: maybeFirstRunSetup enforces exactly
 * this check, so callers need not (and must not) duplicate any of it.
 */
export function shouldRunFirstRunSetup(
  argv: string[],
  stdin: { isTTY?: boolean } = process.stdin,
): boolean {
  if (stdin.isTTY !== true) return false;
  if (argv[0] === "help") return false;
  if (argv.includes("-h") || argv.includes("--help")) return false;
  if (argv.includes("--mock")) return false;
  return true;
}

/** Maximum re-asks for one question before giving up (stuck-pipe insurance). */
const MAX_PROMPT_ATTEMPTS = 100;

/**
 * Ask for a 1-based menu number and return the 0-based index. Non-numeric and
 * out-of-range answers print an error and re-ask — they never abort the
 * setup; only a closed stdin (or the attempt cap) does. Exported for tests.
 */
export async function numberPrompt(
  question: string,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  /** Inclusive upper bound of the valid menu numbers. */
  max: number,
): Promise<number> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  // A pending rl.question() neither resolves nor rejects when the input
  // stream ends or the interface closes (probed on Node 24), so EOF must be
  // raced explicitly — otherwise a closed pipe or a dropped SSH session
  // would leave the prompt hanging forever.
  const closed = new Promise<never>((_, reject) => {
    const abort = (): void => reject(new Error("input closed"));
    rl.once("close", abort);
    stdin.once("end", abort);
    stdin.once("error", abort);
  });
  try {
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
      const answer = await Promise.race([rl.question(question), closed]);
      const trimmed = answer.trim();
      if (/^[0-9]+$/.test(trimmed)) {
        const n = Number(trimmed);
        if (n >= 1 && n <= max) return n - 1;
        stdout.write(`Please enter a number between 1 and ${max}.\n`);
        continue;
      }
      stdout.write("Please enter a number.\n");
    }
    throw new Error(`no valid answer after ${MAX_PROMPT_ATTEMPTS} attempts`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("attempts")) throw err;
    throw new Error("setup aborted: no answer (stdin closed)");
  } finally {
    rl.close();
  }
}

/**
 * CLI startup hook: run the first-run setup once, only when it can actually
 * interact. The invocation gate — TTY, help arguments, --mock — lives entirely
 * in shouldRunFirstRunSetup and is applied to `argv` here; callers pass argv
 * and must not re-check it. Never blocks non-TTY runs, mock runs or help;
 * never runs when a config file already exists (a malformed config is left to
 * the running command, which reports it as before); never throws — a failed
 * setup is reported and the command continues with the env/default
 * configuration it would have used anyway.
 */
export async function maybeFirstRunSetup(
  argv: string[],
  io: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
  } = {},
): Promise<void> {
  if (!shouldRunFirstRunSetup(argv, io.stdin ?? process.stdin)) return;
  try {
    if (readUserConfig() !== undefined) return;
  } catch {
    return;
  }
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    await runFirstRunSelection({
      globalConfigPath: globalOpencodeConfigPath(os.homedir()),
      diakosysConfigPath: userConfigPath(),
      selectModel: (menu) => numberPrompt(`Select a model [1-${menu.length}]: `, stdin, stdout, menu.length),
      selectAgent: (menu) => numberPrompt(`Select an agent [1-${menu.length}]: `, stdin, stdout, menu.length),
      write: (text) => stdout.write(text),
    });
  } catch (err) {
    stderr.write(`first-run setup not completed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
