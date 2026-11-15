import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configWithEndpoint, globalOpencodeConfigPath } from "../src/opencode.ts";

function tmpConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-cfg-"));
  const file = path.join(dir, "opencode.json");
  fs.writeFileSync(file, content);
  return file;
}

test("endpoint is injected into the provider options.baseURL", () => {
  const file = tmpConfig(
    JSON.stringify({
      model: "Qwen-Mimo/model.gguf",
      provider: {
        "Qwen-Mimo": {
          npm: "@ai-sdk/openai-compatible",
          name: "Qwen-Mimo",
          options: { baseURL: "http://localhost:8080/v1", apiKey: "<redacted>" },
        },
      },
    }),
  );
  const content = configWithEndpoint(file, "Qwen-Mimo", "http://localhost:8081/v1");
  assert.ok(content);
  const provider = (content.provider as Record<string, Record<string, unknown>>)["Qwen-Mimo"];
  assert.ok(provider);
  const options = provider.options as Record<string, unknown>;
  assert.equal(options.baseURL, "http://localhost:8081/v1");
  // everything else from the original config is preserved
  assert.equal(content.model, "Qwen-Mimo/model.gguf");
  assert.equal(options.apiKey, "<redacted>");
  assert.equal(options.timeout, false, "provider request cap must be disabled for agentic runs");
});

test("returns undefined for missing or unparsable config", () => {
  assert.equal(configWithEndpoint(path.join(os.tmpdir(), "does-not-exist.json"), "Qwen-Mimo", "http://x/v1"), undefined);
  const bad = tmpConfig("not json {");
  assert.equal(configWithEndpoint(bad, "Qwen-Mimo", "http://x/v1"), undefined);
});

test("returns undefined when the provider block is missing", () => {
  const file = tmpConfig(JSON.stringify({ provider: { Other: { options: {} } } }));
  assert.equal(configWithEndpoint(file, "Qwen-Mimo", "http://x/v1"), undefined);
  const empty = tmpConfig(JSON.stringify({}));
  assert.equal(configWithEndpoint(empty, "Qwen-Mimo", "http://x/v1"), undefined);
});

test("creates options object when provider block lacks one", () => {
  const file = tmpConfig(JSON.stringify({ provider: { "Qwen-Mimo": { npm: "@ai-sdk/openai-compatible" } } }));
  const content = configWithEndpoint(file, "Qwen-Mimo", "http://localhost:9999/v1");
  assert.ok(content);
  const block = (content.provider as Record<string, Record<string, unknown>>)["Qwen-Mimo"];
  assert.ok(block);
  const options = block.options as Record<string, unknown>;
  assert.equal(options.baseURL, "http://localhost:9999/v1");
});

test("endpoint is injected into the current providers.settings.baseURL format", () => {
  const file = tmpConfig(
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      providers: {
        "mimo-llama-m5": {
          name: "MiMo Llama M5",
          package: "@ai-sdk/openai-compatible",
          settings: { baseURL: "http://localhost:8080/v1", apiKey: "<redacted>", timeout: 300000 },
          models: { "mimo-2.6-9b-q6": { id: "mimo-2.6-9b-q6", name: "MiMo" } },
        },
      },
    }),
  );
  const content = configWithEndpoint(file, "mimo-llama-m5", "http://localhost:8081/v1");
  assert.ok(content);
  const provider = (content.providers as Record<string, Record<string, unknown>>)["mimo-llama-m5"];
  assert.ok(provider);
  const settings = provider.settings as Record<string, unknown>;
  assert.equal(settings.baseURL, "http://localhost:8081/v1");
  assert.equal(settings.timeout, false, "provider request cap must be disabled for agentic runs");
});

test("current format preserves unrelated fields and model definitions", () => {
  const models = { "mimo-2.6-9b-q6": { id: "mimo-2.6-9b-q6", name: "MiMo", limit: { context: 131072 } } };
  const lsp = { typescript: { enabled: true } };
  const other = { settings: { baseURL: "http://elsewhere:1/v1" } };
  const file = tmpConfig(
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      lsp,
      providers: { "mimo-llama-m5": { name: "MiMo Llama M5", settings: { baseURL: "http://old:0/v1", apiKey: "<redacted>" }, models }, Other: other },
    }),
  );
  const content = configWithEndpoint(file, "mimo-llama-m5", "http://new:2/v1");
  assert.ok(content);
  assert.equal(content.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(content.lsp, lsp, "unrelated top-level keys must survive");
  const providers = content.providers as Record<string, Record<string, unknown>>;
  const provider = providers["mimo-llama-m5"];
  assert.ok(provider);
  assert.equal(provider.name, "MiMo Llama M5");
  assert.deepEqual(provider.models, models, "model definitions must survive verbatim");
  assert.equal((provider.settings as Record<string, unknown>).apiKey, "<redacted>");
  const otherAfter = providers.Other as Record<string, unknown>;
  assert.deepEqual(otherAfter, other, "other provider entries must survive untouched");
});

test("updates both blocks when the provider exists in both formats", () => {
  const file = tmpConfig(
    JSON.stringify({
      provider: { "Qwen-Mimo": { options: { baseURL: "http://legacy:0/v1" } } },
      providers: { "Qwen-Mimo": { settings: { baseURL: "http://current:0/v1" } } },
    }),
  );
  const content = configWithEndpoint(file, "Qwen-Mimo", "http://localhost:9999/v1");
  assert.ok(content);
  const legacy = (content.provider as Record<string, Record<string, unknown>>)["Qwen-Mimo"];
  assert.ok(legacy);
  assert.equal((legacy.options as Record<string, unknown>).baseURL, "http://localhost:9999/v1");
  const current = (content.providers as Record<string, Record<string, unknown>>)["Qwen-Mimo"];
  assert.ok(current);
  assert.equal((current.settings as Record<string, unknown>).baseURL, "http://localhost:9999/v1");
});

test("creates settings object when current-format block lacks one", () => {
  const file = tmpConfig(
    JSON.stringify({ providers: { "mimo-llama-m5": { name: "MiMo Llama M5", models: {} } } }),
  );
  const content = configWithEndpoint(file, "mimo-llama-m5", "http://localhost:9999/v1");
  assert.ok(content);
  const block = (content.providers as Record<string, Record<string, unknown>>)["mimo-llama-m5"];
  assert.ok(block);
  const settings = block.settings as Record<string, unknown>;
  assert.equal(settings.baseURL, "http://localhost:9999/v1");
});

test("returns undefined when the named provider is absent from providers", () => {
  const file = tmpConfig(JSON.stringify({ providers: { Other: { settings: { baseURL: "http://x/v1" } } } }));
  assert.equal(configWithEndpoint(file, "mimo-llama-m5", "http://x/v1"), undefined);
  const empty = tmpConfig(JSON.stringify({ providers: {} }));
  assert.equal(configWithEndpoint(empty, "mimo-llama-m5", "http://x/v1"), undefined);
});

test("returns undefined for malformed provider blocks in either format", () => {
  const legacyBad = tmpConfig(JSON.stringify({ provider: { "Qwen-Mimo": "not-an-object" } }));
  assert.equal(configWithEndpoint(legacyBad, "Qwen-Mimo", "http://x/v1"), undefined);
  const legacyArray = tmpConfig(JSON.stringify({ provider: { "Qwen-Mimo": ["nope"] } }));
  assert.equal(configWithEndpoint(legacyArray, "Qwen-Mimo", "http://x/v1"), undefined);
  const legacyOptions = tmpConfig(JSON.stringify({ provider: { "Qwen-Mimo": { options: "not-an-object" } } }));
  assert.equal(configWithEndpoint(legacyOptions, "Qwen-Mimo", "http://x/v1"), undefined);
  const currentBad = tmpConfig(JSON.stringify({ providers: { "mimo-llama-m5": 42 } }));
  assert.equal(configWithEndpoint(currentBad, "mimo-llama-m5", "http://x/v1"), undefined);
  const currentSettings = tmpConfig(
    JSON.stringify({ providers: { "mimo-llama-m5": { settings: ["not-an-object"] } } }),
  );
  assert.equal(configWithEndpoint(currentSettings, "mimo-llama-m5", "http://x/v1"), undefined);
  // a well-formed block in the other format does not rescue a malformed one
  const mixed = tmpConfig(
    JSON.stringify({
      provider: { "Qwen-Mimo": { options: { baseURL: "http://legacy/v1" } } },
      providers: { "Qwen-Mimo": null },
    }),
  );
  assert.equal(configWithEndpoint(mixed, "Qwen-Mimo", "http://x/v1"), undefined);
});

test("returns undefined for non-object top-level configs", () => {
  const nullConfig = tmpConfig("null");
  assert.equal(configWithEndpoint(nullConfig, "Qwen-Mimo", "http://x/v1"), undefined);
  const stringConfig = tmpConfig('"just a string"');
  assert.equal(configWithEndpoint(stringConfig, "Qwen-Mimo", "http://x/v1"), undefined);
  const arrayConfig = tmpConfig("[]");
  assert.equal(configWithEndpoint(arrayConfig, "Qwen-Mimo", "http://x/v1"), undefined);
});

test("global config path follows the user home", () => {
  assert.equal(
    globalOpencodeConfigPath("/home/u"),
    path.join("/home/u", ".config", "opencode", "opencode.json"),
  );
});
