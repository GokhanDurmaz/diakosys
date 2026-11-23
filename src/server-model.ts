import fs from "node:fs";
import path from "node:path";
import { readUserConfig } from "./config.ts";

/** Result of matching a discovered model against OpenCode config. */
export interface ModelMatchResult {
  success: boolean;
  provider?: string;
  modelId?: string;
  modelName?: string;
  endpoint: string;
  reason: string;
  updated?: boolean;
}

interface OpenCodeModelEntry {
  /** The configured model key/id that OpenCode expects in `defaultModel`. */
  modelId: string;
  modelName: string;
  /** Every explicit identifier for this model: key, display name and modelID alias. */
  aliases: string[];
}

interface ProviderCandidate {
  providerId: string;
  baseURL: string | undefined;
  models: unknown;
  defaultModel: string | undefined;
}

interface FoundModelMatch {
  provider: string;
  modelId: string;
  modelName: string;
  quality: 1 | 2;
  alreadySelected: boolean;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function defaultOpenCodeConfigPath(): string {
  return path.join(process.env.HOME ?? ".", ".config", "opencode", "opencode.json");
}

/**
 * Normalize an endpoint for comparison.
 *
 * Both sides of every endpoint comparison go through this function, so
 * `http://host:8082`, `http://host:8082/` and `http://host:8082/v1` are
 * equivalent. Query strings and fragments are ignored.
 */
export function normalizeEndpoint(endpoint: string): string {
  const base = endpoint.trim().split(/[?#]/u, 1)[0] ?? endpoint.trim();
  const withoutTrailingSlash = base.replace(/\/+$/u, "");
  return withoutTrailingSlash.replace(/\/v1$/iu, "").replace(/\/+$/u, "");
}

/**
 * Deterministic model-token normalization.
 *
 * It keeps the full basename stem: directory, `.gguf` and punctuation/case
 * differences are removed, but no token is dropped. This is deliberately not
 * a fuzzy/suffix match — two models that merely share `Q8_0` do not match.
 */
function normalizeModelToken(value: string): string {
  const trimmed = value.trim();
  const withoutModelsPrefix = trimmed.replace(/^models[\\/]/iu, "");
  const basename = withoutModelsPrefix.split(/[\\/]/u).pop() ?? withoutModelsPrefix;
  return basename
    .replace(/\.gguf$/iu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function modelMatchQuality(discoveredModelId: string, aliases: readonly string[]): 0 | 1 | 2 {
  const discovered = discoveredModelId.trim();
  if (discovered === "") return 0;
  if (aliases.some((alias) => alias === discovered)) return 2;

  const normalizedDiscovered = normalizeModelToken(discovered);
  if (normalizedDiscovered === "") return 0;
  return aliases.some((alias) => normalizeModelToken(alias) === normalizedDiscovered) ? 1 : 0;
}

/**
 * Extract model entries from either OpenCode schema shape:
 *   * object: `models.<id>.{ name, modelID, ... }`
 *   * array:  `models: [{ id, name, modelID, ... }]`
 *
 * `modelID` is the explicit alias some providers use for the underlying
 * llama.cpp GGUF path, so it participates in matching.
 */
function modelEntries(models: unknown): OpenCodeModelEntry[] {
  if (Array.isArray(models)) {
    const entries: OpenCodeModelEntry[] = [];
    for (const item of models) {
      if (!isRecord(item)) continue;
      const id = displayString(item.id) ?? displayString(item.name);
      if (id === undefined) continue;
      const name = displayString(item.name) ?? id;
      const aliases = [id, name];
      const modelID = displayString(item.modelID);
      if (modelID !== undefined) aliases.push(modelID);
      entries.push({ modelId: id, modelName: name, aliases });
    }
    return entries;
  }

  if (!isRecord(models)) return [];

  const entries: OpenCodeModelEntry[] = [];
  for (const [modelId, value] of Object.entries(models)) {
    if (!isRecord(value)) continue;
    const name = displayString(value.name) ?? modelId;
    const aliases = [modelId, name];
    const modelID = displayString(value.modelID);
    if (modelID !== undefined) aliases.push(modelID);
    entries.push({ modelId, modelName: name, aliases });
  }
  return entries;
}

function providerBaseURL(block: Record<string, unknown>): string | undefined {
  const settings = isRecord(block.settings) ? block.settings : undefined;
  const options = isRecord(block.options) ? block.options : undefined;
  return displayString(settings?.baseURL) ?? displayString(options?.baseURL);
}

function providerCandidates(providers: Record<string, unknown>): ProviderCandidate[] {
  const candidates: ProviderCandidate[] = [];
  for (const [providerId, block] of Object.entries(providers)) {
    if (!isRecord(block)) continue;
    candidates.push({
      providerId,
      baseURL: providerBaseURL(block),
      models: block.models,
      defaultModel: displayString(block.defaultModel),
    });
  }
  return candidates;
}

/**
 * Find the configured provider/model that corresponds to a discovered model.
 *
 * Matching precedence is deterministic:
 *   1. exact match against the model key, display name or explicit `modelID`;
 *   2. normalized full-stem match against the same aliases.
 *
 * If several providers match at the same precedence the result is ambiguous
 * and the caller must fail instead of silently picking the first provider.
 */
function findModelMatch(
  candidates: readonly ProviderCandidate[],
  endpoint: string,
  discoveredModelId: string,
): { match?: FoundModelMatch; ambiguous?: FoundModelMatch[] } {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const matches: FoundModelMatch[] = [];

  for (const candidate of candidates) {
    if (candidate.baseURL === undefined) continue;
    if (normalizeEndpoint(candidate.baseURL) !== normalizedEndpoint) continue;

    for (const entry of modelEntries(candidate.models)) {
      const quality = modelMatchQuality(discoveredModelId, entry.aliases);
      if (quality === 0) continue;
      matches.push({
        provider: candidate.providerId,
        modelId: entry.modelId,
        modelName: entry.modelName,
        quality,
        alreadySelected: candidate.defaultModel === entry.modelId,
        reason: quality === 2 ? "Model found in OpenCode config" : "Model matched configured alias",
      });
    }
  }

  if (matches.length === 0) return {};

  const bestQuality = Math.max(...matches.map((match) => match.quality));
  const best = matches.filter((match) => match.quality === bestQuality);
  const unique = new Map<string, FoundModelMatch>();
  for (const match of best) unique.set(`${match.provider}\u0000${match.modelId}`, match);

  if (unique.size > 1) return { ambiguous: [...unique.values()] };
  return { match: [...unique.values()][0] };
}

function failure(endpoint: string, reason: string): ModelMatchResult {
  return { success: false, provider: undefined, modelId: undefined, modelName: undefined, endpoint, reason };
}

function readOpenCodeConfig(configPath: string): { config?: Record<string, unknown>; error?: string } {
  if (!fs.existsSync(configPath)) return { error: "Cannot read OpenCode config" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    return { error: `Failed to read OpenCode config: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(parsed)) return { error: "OpenCode config must be a JSON object" };
  return { config: parsed };
}

function toMatchResult(
  result: { match?: FoundModelMatch; ambiguous?: FoundModelMatch[] },
  endpoint: string,
  noMatchReason: string,
): ModelMatchResult {
  if (result.ambiguous !== undefined) {
    const choices = result.ambiguous.map((match) => `${match.provider}/${match.modelId}`).join(", ");
    return failure(endpoint, `Multiple OpenCode providers match the discovered model: ${choices}`);
  }
  if (result.match === undefined) return failure(endpoint, noMatchReason);

  return {
    success: true,
    provider: result.match.provider,
    modelId: result.match.modelId,
    modelName: result.match.modelName,
    endpoint,
    reason: result.match.alreadySelected ? "Model already selected in OpenCode config" : result.match.reason,
    updated: result.match.alreadySelected ? false : undefined,
  };
}

/**
 * Check if a discovered model is already selected in the OpenCode config.
 *
 * Uses the same endpoint normalization and alias matching as
 * `matchServerModel`, so a configured `modelID` GGUF alias is recognized.
 */
export function isModelAlreadySelected(
  endpoint: string,
  discoveredModelId: string,
  opencodeConfigPath: string = defaultOpenCodeConfigPath(),
): boolean {
  const loaded = readOpenCodeConfig(opencodeConfigPath);
  if (loaded.config === undefined) return false;

  const config = loaded.config;
  const legacyProviders = config.provider;
  if (isRecord(legacyProviders)) {
    return findModelMatch(providerCandidates(legacyProviders), endpoint, discoveredModelId).match?.alreadySelected === true;
  }

  const currentProviders = config.providers;
  if (!isRecord(currentProviders)) return false;
  return findModelMatch(providerCandidates(currentProviders), endpoint, discoveredModelId).match?.alreadySelected === true;
}

/**
 * Ensure a discovered model is selected in the OpenCode config.
 *
 * `providerId` is the provider identified by `matchServerModel`. When it is
 * supplied, that exact provider is used. Without it, the provider is resolved
 * deterministically: a unique endpoint match wins; otherwise the model must
 * exist under exactly one of the endpoint-sharing providers. Ambiguous
 * selections fail instead of falling back to the first JSON key.
 *
 * `defaultModel` is only updated when it differs from the matched model key,
 * and the write is atomic (temp file + rename).
 */
export function ensureServerModelSelected(
  endpoint: string,
  discoveredModelId: string,
  opencodeConfigPath: string,
  log?: (message: string) => void,
  providerId?: string,
): ModelMatchResult {
  if (log) log(`[server-model] Attempting to select model in OpenCode config...`);

  const loaded = readOpenCodeConfig(opencodeConfigPath);
  if (loaded.config === undefined) {
    if (log) log(`[server-model] ${loaded.error ?? "Failed to read OpenCode config"}`);
    return failure(endpoint, loaded.error ?? "Failed to read OpenCode config");
  }
  const config = loaded.config;

  // Writing `defaultModel` is only defined for the current providers schema.
  const currentProviders = config.providers;
  if (!isRecord(currentProviders)) {
    if (log) log(`[server-model] No providers section in OpenCode config`);
    return failure(endpoint, "No providers section in OpenCode config");
  }

  const selection = findProviderForSelection(currentProviders, endpoint, discoveredModelId, providerId);
  if (selection.providerId === undefined || selection.block === undefined) {
    const reason = selection.error ?? "No matching OpenCode provider found";
    if (log) log(`[server-model] ${reason}`);
    return failure(endpoint, reason);
  }

  const entries = modelEntries(selection.block.models);
  const matchedEntry =
    entries.find((entry) => entry.modelId === discoveredModelId) ??
    entries.find((entry) => modelMatchQuality(discoveredModelId, entry.aliases) > 0);
  if (matchedEntry === undefined) {
    const reason = `Model ${discoveredModelId} not found in OpenCode provider ${selection.providerId}`;
    if (log) log(`[server-model] ${reason}`);
    return failure(endpoint, reason);
  }

  if (selection.block.defaultModel === matchedEntry.modelId) {
    if (log) log(`[server-model] Model already selected in OpenCode config`);
    return {
      success: true,
      provider: selection.providerId,
      modelId: matchedEntry.modelId,
      modelName: matchedEntry.modelName,
      endpoint,
      reason: "Model already selected in OpenCode config",
      updated: false,
    };
  }

  selection.block.defaultModel = matchedEntry.modelId;
  if (log) log(`[server-model] Set defaultModel: ${matchedEntry.modelId}`);

  const tempPath = `${opencodeConfigPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tempPath, opencodeConfigPath);
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Ignore cleanup errors; the original write error is more useful.
    }
    const reason = `Failed to write OpenCode config: ${err instanceof Error ? err.message : String(err)}`;
    if (log) log(`[server-model] ${reason}`);
    return failure(endpoint, reason);
  }

  if (log) log(`[server-model] Updated OpenCode config with model: ${matchedEntry.modelId}`);
  return {
    success: true,
    provider: selection.providerId,
    modelId: matchedEntry.modelId,
    modelName: matchedEntry.modelName,
    endpoint,
    reason: "Model selected and added to OpenCode config",
    updated: true,
  };
}

function findProviderForSelection(
  providers: Record<string, unknown>,
  endpoint: string,
  modelId: string,
  providerId: string | undefined,
): { providerId?: string; block?: Record<string, unknown>; error?: string } {
  const normalizedEndpoint = normalizeEndpoint(endpoint);

  if (providerId !== undefined) {
    const block = providers[providerId];
    if (!isRecord(block)) return { error: `OpenCode provider ${providerId} not found` };

    const baseURL = providerBaseURL(block);
    if (baseURL === undefined) return { error: `OpenCode provider ${providerId} has no endpoint` };
    if (normalizeEndpoint(baseURL) !== normalizedEndpoint) {
      return { error: `OpenCode provider ${providerId} does not use endpoint ${endpoint}` };
    }
    return { providerId, block };
  }

  const endpointProviders: Array<[string, Record<string, unknown>]> = [];
  for (const [id, block] of Object.entries(providers)) {
    if (!isRecord(block)) continue;
    const baseURL = providerBaseURL(block);
    if (baseURL !== undefined && normalizeEndpoint(baseURL) === normalizedEndpoint) {
      endpointProviders.push([id, block]);
    }
  }

  if (endpointProviders.length === 0) return { error: "No matching OpenCode provider found" };
  if (endpointProviders.length === 1) {
    const [id, block] = endpointProviders[0]!;
    return { providerId: id, block };
  }

  const modelProviders = endpointProviders.filter(([, block]) =>
    modelEntries(block.models).some((entry) => modelMatchQuality(modelId, entry.aliases) > 0),
  );
  if (modelProviders.length === 1) {
    const [id, block] = modelProviders[0]!;
    return { providerId: id, block };
  }
  if (modelProviders.length === 0) {
    return { error: `No matching OpenCode provider found for model ${modelId}` };
  }
  return { error: `Multiple OpenCode providers share endpoint ${endpoint}; provider selection is ambiguous` };
}

/**
 * Match a discovered model against the OpenCode config.
 *
 * Returns the actual configured provider and model key, never a provider
 * fabricated from the discovered string. A configured `modelID` alias (the
 * llama.cpp GGUF path) is matched deterministically.
 */
export function matchServerModel(
  endpoint: string,
  discoveredModelId: string,
  opencodeConfigPath: string = defaultOpenCodeConfigPath(),
): ModelMatchResult {
  const loaded = readOpenCodeConfig(opencodeConfigPath);
  if (loaded.config === undefined) return failure(endpoint, loaded.error ?? "Cannot read OpenCode config");

  const config = loaded.config;
  const legacyProviders = config.provider;
  if (isRecord(legacyProviders)) {
    return toMatchResult(
      findModelMatch(providerCandidates(legacyProviders), endpoint, discoveredModelId),
      endpoint,
      "No matching OpenCode provider/model found in legacy config",
    );
  }

  const currentProviders = config.providers;
  if (!isRecord(currentProviders)) {
    return failure(endpoint, "No providers section in OpenCode config");
  }

  return toMatchResult(
    findModelMatch(providerCandidates(currentProviders), endpoint, discoveredModelId),
    endpoint,
    "No matching OpenCode provider/model found",
  );
}

/**
 * Auto-select a model from server discovery.
 *
 * Discovery is only successful when a configured provider/model match exists
 * and the OpenCode config was updated (or already selected). There is no
 * fabricated-provider fallback.
 */
export async function autoSelectModel(
  endpoint: string,
  opencodeConfigPath: string,
  log?: (message: string) => void,
): Promise<{ success: boolean; provider: string; modelId: string; modelName: string; endpoint: string; updated: boolean; reason: string }> {
  if (log) log(`[server-model] Auto-selecting model from server discovery`);

  const discovery = await discoverServerModel(endpoint, log);
  if (!discovery.success) {
    if (discovery.models.length === 0 && discovery.error === "Server returned no models") {
      return { success: false, provider: "unknown", modelId: "unknown", modelName: "", endpoint, updated: false, reason: "Server returned no models" };
    }
    const detail = discovery.error ?? "unknown discovery error";
    return { success: false, provider: "unknown", modelId: "unknown", modelName: "", endpoint, updated: false, reason: `Cannot determine model: ${detail}` };
  }

  const modelId = discovery.models[0]?.id;
  if (modelId === undefined || modelId.trim() === "") {
    if (log) log(`[server-model] Failed to get model ID from discovery`);
    return { success: false, provider: "unknown", modelId: "unknown", modelName: "", endpoint, updated: false, reason: "Cannot determine model" };
  }

  const match = matchServerModel(endpoint, modelId, opencodeConfigPath);
  if (!match.success || match.provider === undefined || match.modelId === undefined) {
    return {
      success: false,
      provider: "unknown",
      modelId: "unknown",
      modelName: "",
      endpoint,
      updated: false,
      reason: match.reason,
    };
  }

  const configSelection = ensureServerModelSelected(
    endpoint,
    match.modelId,
    opencodeConfigPath,
    (msg) => { if (log) log(msg); },
    match.provider,
  );
  if (!configSelection.success || configSelection.provider === undefined || configSelection.modelId === undefined) {
    return {
      success: false,
      provider: "unknown",
      modelId: "unknown",
      modelName: "",
      endpoint,
      updated: false,
      reason: configSelection.reason,
    };
  }

  return {
    success: true,
    provider: configSelection.provider,
    modelId: configSelection.modelId,
    modelName: configSelection.modelName ?? match.modelName ?? match.modelId,
    endpoint,
    updated: configSelection.updated === true,
    reason: match.reason,
  };
}

/**
 * Validate that a provider/model selection actually exists in the OpenCode
 * config and belongs to the endpoint. Used before persisting a discovery
 * result to the Diakosys config.
 */
export function validateModelSelection(
  endpoint: string,
  provider: string | undefined,
  modelId: string | undefined,
  opencodeConfigPath: string,
): { valid: boolean; reason?: string } {
  if (provider === undefined || provider.trim() === "") {
    return { valid: false, reason: "provider is missing" };
  }
  if (modelId === undefined || modelId.trim() === "") {
    return { valid: false, reason: "model ID is missing" };
  }

  const loaded = readOpenCodeConfig(opencodeConfigPath);
  if (loaded.config === undefined) {
    return { valid: false, reason: loaded.error ?? "Cannot read OpenCode config" };
  }

  const config = loaded.config;
  const legacyProviders = config.provider;
  const providers = isRecord(legacyProviders) ? legacyProviders : config.providers;
  if (!isRecord(providers)) return { valid: false, reason: "No providers section in OpenCode config" };

  const block = providers[provider];
  if (!isRecord(block)) return { valid: false, reason: `provider ${provider} is not configured in OpenCode` };

  const baseURL = providerBaseURL(block);
  if (baseURL === undefined || normalizeEndpoint(baseURL) !== normalizeEndpoint(endpoint)) {
    return { valid: false, reason: `provider ${provider} does not use endpoint ${endpoint}` };
  }

  const modelExists = modelEntries(block.models).some((entry) => entry.modelId === modelId);
  if (!modelExists) {
    return { valid: false, reason: `model ${modelId} is not configured under provider ${provider}` };
  }
  return { valid: true };
}

/**
 * Resolve the effective model configuration for Diakosys.
 */
export async function resolveEffectiveModel(
  endpoint: string,
  opencodeConfigPath: string,
  autoDiscover: boolean = true,
  log?: (message: string) => void,
): Promise<{ provider: string | undefined; modelId: string | undefined; model: string | undefined; endpoint: string; modelName?: string }> {
  const explicitModel = process.env.DIAKOSYS_ORCHESTRATOR_MODEL;
  if (explicitModel) {
    const [prov, mid] = explicitModel.split("/");
    return { provider: prov, modelId: mid, model: explicitModel, endpoint };
  }

  const userConfig = readUserConfig();
  if (userConfig?.provider && userConfig.modelId) {
    return {
      provider: userConfig.provider,
      modelId: userConfig.modelId,
      model: `${userConfig.provider}/${userConfig.modelId}`,
      endpoint,
      modelName: typeof userConfig.modelName === "string" ? userConfig.modelName : undefined,
    };
  }

  if (!autoDiscover) {
    throw new Error("auto-discovery disabled");
  }

  if (log) log(`[server-model] No model configured, attempting auto-discovery...`);

  const selection = await autoSelectModel(endpoint, opencodeConfigPath, (msg) => { if (log) log(msg); });

  if (!selection.success) {
    if (selection.reason === "Server returned no models") {
      // Keep the precise reason while retaining the historical prefix expected
      // by callers that classify discovery failures as "cannot determine model".
      throw new Error(`Cannot determine model: ${selection.reason}`);
    }
    throw new Error(selection.reason.includes("Cannot determine model") ? selection.reason : `server-model ${selection.reason}`);
  }

  const validation = validateModelSelection(endpoint, selection.provider, selection.modelId, opencodeConfigPath);
  if (!validation.valid) {
    throw new Error(`server-model discovery returned an invalid selection: ${validation.reason ?? "unknown reason"}`);
  }

  return {
    provider: selection.provider,
    modelId: selection.modelId,
    model: `${selection.provider}/${selection.modelId}`,
    endpoint: selection.endpoint,
    modelName: selection.modelName,
  };
}

/**
 * Discover the server model by calling the OpenAI-compatible endpoint.
 */
export async function discoverServerModel(
  endpoint: string,
  log?: (message: string) => void,
): Promise<{ success: boolean; models: Array<{ id: string; name: string }>; error?: string }> {
  if (log) log(`[server-model] Discovering server model at ${endpoint}`);

  try {
    const url = new URL(endpoint);
    if (url.pathname.endsWith("/v1")) url.pathname = url.pathname.slice(0, -3);
    else if (!url.pathname.endsWith("/")) url.pathname += "/";
    url.pathname += "models";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url.toString(), { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Server returned ${response.status}: ${text}`);
      }

      const data = await response.json();
      let models: Array<{ id: string; name: string }>;
      if (typeof data === "object" && data !== null && "object" in data && "data" in data) {
        models = (data as any).data.filter((m: any) => typeof m === "object" && m !== null).map((m: any) => ({ id: m.id || m.name || "unknown", name: m.name || m.id || "unknown" }));
      } else if (Array.isArray(data)) {
        models = data.filter((m) => typeof m === "object" && m !== null).map((m: any) => ({ id: m.id || m.name || "unknown", name: m.name || m.id || "unknown" }));
      } else {
        throw new Error("Server did not return a models array");
      }

      if (log) log(`[server-model] Server returned ${models.length} model(s)`);
      for (const m of models) { if (log) log(`[server-model]   - ${m.id} (name: ${m.name})`); }

      if (models.length === 0) {
        return { success: false, models: [], error: "Server returned no models" };
      }

      return { success: true, models };
    } finally {
      controller.abort();
    }
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (log) log(`[server-model] Discovery failed: ${errMessage}`);
    return { success: false, models: [], error: errMessage };
  }
}

export interface GlobalOpenCodeConfig {
  providers?: Record<string, {
    settings?: { baseURL: string };
    options?: { baseURL: string };
    models?: Record<string, { name?: string; modelID?: string }> | Array<{ id?: string; name?: string; modelID?: string }>;
  }>;
}

/**
 * Fetch model IDs from a server by calling the OpenAI-compatible endpoint.
 */
export async function fetchServerModelIds(
  endpoint: string,
  log?: (message: string) => void,
): Promise<{ success: boolean; models: Array<{ id: string; name: string }>; error?: string }> {
  return await discoverServerModel(endpoint, log);
}
