import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import {
  matchServerModel,
  normalizeEndpoint,
  validateModelSelection,
} from "../src/server-model.ts";
import { readUserConfig, resolveConfig, userConfigPath } from "../src/config.ts";

const SHARED_ENDPOINT = "http://localhost:8082/v1";
const OXCODER_GGUF = "/Users/example/Desktop/llama.cpp/models/OxCoder-9B-Q8_0.gguf";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function sharedEndpointProviders(
  matchedFirst: boolean,
  endpoint: string = SHARED_ENDPOINT,
): Record<string, unknown> {
  const matched = {
    "oxcoder-q8-m5": {
      name: "OxCoder Q8_0 (M5 llama.cpp)",
      settings: { baseURL: endpoint },
      models: {
        "oxcoder-q8": {
          name: "OxCoder-9B Q8_0",
          modelID: OXCODER_GGUF,
        },
      },
    },
  };
  const others = {
    "mimo-llama-m5": {
      name: "MiMo 2.6 Q6_K_L (M5 llama.cpp)",
      settings: { baseURL: endpoint },
      models: { "mimo-2.6-9b-q6": { name: "MiMo 2.6 9B Q6_K_L" } },
    },
    "mimo-q8-m5": {
      name: "MiMo Q8_0 (M5 llama.cpp)",
      settings: { baseURL: endpoint },
      models: { "mimo-q8": { name: "MiMo-V2.6-Distill-Qwen-9B Q8_0" } },
    },
    "oxcoder-q6-m5": {
      name: "OxCoder Q6_K (M5 llama.cpp)",
      settings: { baseURL: endpoint },
      models: { "oxcoder-q6": { name: "OxCoder-9B i1-MTP Q6_K" } },
    },
    "oxcoder-iq4nl-m5": {
      name: "OxCoder IQ4_NL (M5 llama.cpp)",
      settings: { baseURL: endpoint },
      models: { "oxcoder-iq4nl": { name: "OxCoder-9B i1-MTP IQ4_NL" } },
    },
  };
  return matchedFirst ? { ...matched, ...others } : { ...others, ...matched };
}

const DIAKOSYS_ENV_KEYS = [
  "DIAKOSYS_ENDPOINT",
  "DIAKOSYS_ORCHESTRATOR_MODEL",
  "DIAKOSYS_ORCHESTRATOR_PROVIDER",
  "DIAKOSYS_ORCHESTRATOR_MODEL_ID",
  "DIAKOSYS_AUTO_DISCOVERY",
] as const;

function clearDiakosysEnv(): () => void {
  const saved = new Map(DIAKOSYS_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of DIAKOSYS_ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("automatic model discovery runs when no explicit model or saved config exists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-home-"));
  const configPath = path.join(dir, ".config", "diakosys", "config.json");
  const opencodePath = path.join(dir, ".config", "opencode", "opencode.json");
  process.env.HOME = dir;

  if (fs.existsSync(configPath)) {
    fs.rmSync(configPath, { force: true });
  }

  delete process.env.DIAKOSYS_ORCHESTRATOR_MODEL;
  delete process.env.DIAKOSYS_ORCHESTRATOR_PROVIDER;
  delete process.env.DIAKOSYS_ORCHESTRATOR_MODEL_ID;
  delete process.env.DIAKOSYS_ENDPOINT;
  delete process.env.DIAKOSYS_AUTO_DISCOVERY;

  const server = http.createServer((req, res) => {
    if (req.url === "/models" || req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: OXCODER_GGUF, object: "model" }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const endpoint = `http://localhost:${port}/v1`;

  fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
  fs.writeFileSync(opencodePath, JSON.stringify({
    providers: {
      "oxcoder-q8-m5": {
        settings: { baseURL: endpoint },
        models: {
          "oxcoder-q8": { name: "OxCoder-9B Q8_0", modelID: OXCODER_GGUF },
        },
      },
    },
  }, null, 2) + "\n");

  try {
    const result = await resolveConfig();
    assert.ok(result.provider, "provider should be set after discovery");
    assert.ok(result.modelId, "modelId should be set after discovery");
    assert.ok(result.model, "model should be set after discovery");
    assert.equal(result.provider, "oxcoder-q8-m5");
    assert.equal(result.modelId, "oxcoder-q8");
    assert.equal(result.model, "oxcoder-q8-m5/oxcoder-q8");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discovered model configuration is persisted to user config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-home-"));
  const configPath = path.join(dir, ".config", "diakosys", "config.json");
  const opencodePath = path.join(dir, ".config", "opencode", "opencode.json");
  process.env.HOME = dir;

  delete process.env.DIAKOSYS_ORCHESTRATOR_MODEL;
  delete process.env.DIAKOSYS_ORCHESTRATOR_PROVIDER;
  delete process.env.DIAKOSYS_ORCHESTRATOR_MODEL_ID;
  delete process.env.DIAKOSYS_ENDPOINT;
  delete process.env.DIAKOSYS_AUTO_DISCOVERY;

  const server = http.createServer((req, res) => {
    if (req.url === "/models" || req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: OXCODER_GGUF, object: "model" }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const endpoint = `http://localhost:${port}/v1`;

  fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
  fs.writeFileSync(opencodePath, JSON.stringify({
    providers: {
      "oxcoder-q8-m5": {
        settings: { baseURL: endpoint },
        models: {
          "oxcoder-q8": { name: "OxCoder-9B Q8_0", modelID: OXCODER_GGUF },
        },
      },
    },
  }, null, 2) + "\n");

  try {
    await resolveConfig();
    assert.ok(fs.existsSync(configPath), "config file should exist after discovery");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(config.provider, "oxcoder-q8-m5");
    assert.equal(config.modelId, "oxcoder-q8");
    assert.equal(config.modelName, "OxCoder-9B Q8_0");
    const opencode = JSON.parse(fs.readFileSync(opencodePath, "utf-8"));
    assert.equal(opencode.providers["oxcoder-q8-m5"].defaultModel, "oxcoder-q8");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
