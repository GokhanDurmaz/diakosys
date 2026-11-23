import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, readUserConfig, resolveEndpoint, DEFAULT_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_ENDPOINT, DEFAULT_TASK_LEASE_TTL_MS } from "../src/config.ts";

async function withUserConfig(content: string, fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-home-"));
  const file = path.join(dir, ".config", "diakosys", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  process.env.HOME = dir;
  try {
    await fn();
  } finally {
    delete process.env.HOME;
  }
}

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const names = [
    "DIAKOSYS_ENDPOINT",
    "DIAKOSYS_ORCHESTRATOR_MODEL",
    "DIAKOSYS_ORCHESTRATOR_PROVIDER",
    "DIAKOSYS_ORCHESTRATOR_MODEL_ID",
    "DIAKOSYS_ORCHESTRATOR_PROJECT_DIR",
    "DIAKOSYS_PROJECT_DIR",
    "DIAKOSYS_ORCHESTRATOR_PORT",
    "DIAKOSYS_ORCHESTRATOR_STARTUP_TIMEOUT_MS",
    "DIAKOSYS_ORCHESTRATOR_PROMPT_TIMEOUT_MS",
    "DIAKOSYS_ORCHESTRATOR_AGENT",
    "DIAKOSYS_ORCHESTRATOR_DISCOVERY_TIMEOUT_MS",
    "DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_PROPOSALS",
    "DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_AREAS",
    "DIAKOSYS_ORCHESTRATOR_LEASE_TTL_MS",
    "DIAKOSYS_ORCHESTRATOR_LOCK_TTL_MS",
    "DIAKOSYS_ORCHESTRATOR_RETRY_MAX_ATTEMPTS",
    "DIAKOSYS_ORCHESTRATOR_RETRY_BASE_MS",
    "DIAKOSYS_ORCHESTRATOR_RETRY_MAX_MS",
    "DIAKOSYS_ORCHESTRATOR_RECOVER_ON_START",
  ];
  const saved = new Map(names.map((n) => [n, process.env[n]]));
  try {
    for (const [n, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    fn();
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
}

test("defaults resolve to the MiMo configuration", async () => {
  // Clean any existing config file to avoid stale state
  const configPath = path.join(process.env.HOME ?? ".", ".config", "diakosys", "config.json");
  if (fs.existsSync(configPath)) {
    fs.rmSync(configPath, { force: true });
  }

  await withEnv(
    {
      DIAKOSYS_ORCHESTRATOR_PROJECT_DIR: "/repo",
      DIAKOSYS_ORCHESTRATOR_PROMPT_TIMEOUT_MS: undefined,
      DIAKOSYS_ORCHESTRATOR_PORT: undefined,
      DIAKOSYS_AUTO_DISCOVERY: "false",
    },
    async () => {
      const c = await resolveConfig();
      assert.equal(c.provider, DEFAULT_PROVIDER);
      assert.equal(c.modelId, DEFAULT_MODEL_ID);
      assert.equal(c.model, `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`);
      assert.equal(c.endpoint, DEFAULT_ENDPOINT);
      assert.equal(c.projectDirectory, "/repo");
      assert.equal(c.port, 4096);
      assert.equal(c.taskLeaseTtlMs, DEFAULT_TASK_LEASE_TTL_MS);
      assert.equal(c.agent, undefined);
    },
  );
});

test("explicit full model string wins over provider/model-id pair", async () => {
  await withEnv(
    {
      DIAKOSYS_ORCHESTRATOR_MODEL: "Qwen-Mimo/Admin/model.gguf",
      DIAKOSYS_ORCHESTRATOR_PROVIDER: "Other",
      DIAKOSYS_ORCHESTRATOR_MODEL_ID: "ignored.gguf",
    },
    async () => {
      const c = await resolveConfig();
      assert.equal(c.provider, "Qwen-Mimo");
      assert.equal(c.modelId, "Admin/model.gguf");
      assert.equal(c.model, "Qwen-Mimo/Admin/model.gguf");
    },
  );
});

test("provider + model-id pair is honored without a full model string", async () => {
  await withEnv(
    {
      DIAKOSYS_ORCHESTRATOR_MODEL: undefined,
      DIAKOSYS_ORCHESTRATOR_PROVIDER: "Prov",
      DIAKOSYS_ORCHESTRATOR_MODEL_ID: "sub/other.gguf",
    },
    async () => {
      const c = await resolveConfig();
      assert.equal(c.provider, "Prov");
      assert.equal(c.modelId, "sub/other.gguf");
      assert.equal(c.model, "Prov/sub/other.gguf");
    },
  );
});

test("numeric env overrides are parsed and validated", async () => {
  await withEnv(
    {
      DIAKOSYS_ORCHESTRATOR_PORT: "4099",
      DIAKOSYS_ORCHESTRATOR_PROMPT_TIMEOUT_MS: "900000",
    },
    async () => {
      const c = await resolveConfig();
      assert.equal(c.port, 4099);
      // no per-prompt deadline remains: the env var is inert and the lease
      // keeps its standalone default, regardless of the dropped value
      assert.equal(c.taskLeaseTtlMs, DEFAULT_TASK_LEASE_TTL_MS);
    },
  );
  await withEnv({ DIAKOSYS_ORCHESTRATOR_PORT: "zero" }, async () => {
    await assert.rejects(() => resolveConfig(), /DIAKOSYS_ORCHESTRATOR_PORT/);
  });
  await withEnv({ DIAKOSYS_ORCHESTRATOR_STARTUP_TIMEOUT_MS: "-5" }, async () => {
    await assert.rejects(() => resolveConfig(), /DIAKOSYS_ORCHESTRATOR_STARTUP_TIMEOUT_MS/);
  });
});

test("project directory precedence and agent passthrough", async () => {
  await withEnv(
    {
      DIAKOSYS_ORCHESTRATOR_PROJECT_DIR: undefined,
      DIAKOSYS_PROJECT_DIR: undefined,
      DIAKOSYS_ORCHESTRATOR_AGENT: "build",
    },
    async () => {
      const c = await resolveConfig();
      assert.equal(c.projectDirectory, process.cwd());
      assert.equal(c.agent, "build");
    },
  );
  await withEnv(
    {
      DIAKOSYS_ORCHESTRATOR_PROJECT_DIR: "/first",
      DIAKOSYS_PROJECT_DIR: "/second",
    },
    async () => {
      assert.equal((await resolveConfig()).projectDirectory, "/first");
    },
  );
});

test("endpoint default is the local llama.cpp server", () => {
  assert.equal(DEFAULT_ENDPOINT, "http://localhost:8082/v1");
});

test("endpoint default is used when no config file exists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-home-"));
  process.env.HOME = dir;
  try {
    assert.equal(resolveEndpoint(), "http://localhost:8082/v1");
    assert.equal((await resolveConfig()).endpoint, "http://localhost:8082/v1");
  } finally {
    delete process.env.HOME;
  }
});

test("endpoint precedence: env > config file > default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-home-"));
  const cfg = path.join(dir, ".config", "diakosys", "config.json");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ endpoint: "http://localhost:9090/v1" }));
  process.env.HOME = dir;
  try {
    assert.equal(resolveEndpoint(), "http://localhost:9090/v1", "config file endpoint is honored");
    process.env.DIAKOSYS_ENDPOINT = "http://localhost:9100/v1";
    assert.equal(resolveEndpoint(), "http://localhost:9100/v1", "DIAKOSYS_ENDPOINT beats the config file");
    delete process.env.DIAKOSYS_ENDPOINT;
    assert.equal(resolveEndpoint(), "http://localhost:9090/v1", "config file endpoint is honored once env is unset");
  } finally {
    delete process.env.HOME;
  }
});

test("endpoint from the user config file is honored", async () => {
  await withUserConfig(
    JSON.stringify({ endpoint: "http://localhost:9090/v1", apiKey: "should-not-appear" }),
    async () => {
      const c = await resolveConfig();
      assert.equal(c.endpoint, "http://localhost:9090/v1");
      assert.equal(c.model, `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`);
    },
  );
});

test("malformed user config fails explicitly instead of silently falling back", async () => {
  await withUserConfig("{ not valid json", async () => {
    assert.throws(() => resolveEndpoint(), /malformed/);
  });
  await withUserConfig("null", async () => {
    assert.throws(() => resolveEndpoint(), /must be a JSON object/);
  });
  await withUserConfig("[]", async () => {
    assert.throws(() => resolveEndpoint(), /JSON object/);
  });
});

test("invalid endpoint values fail explicitly instead of silently falling back", async () => {
  await withUserConfig(JSON.stringify({ endpoint: "not a url" }), async () => {
    assert.throws(() => resolveEndpoint(), /invalid endpoint/);
  });
  await withUserConfig(JSON.stringify({ endpoint: "relative/path" }), async () => {
    assert.throws(() => resolveEndpoint(), /invalid endpoint/);
  });
  await withEnv({ DIAKOSYS_ENDPOINT: "localhost" }, async () => {
    assert.throws(() => resolveEndpoint(), /invalid endpoint/);
  });
  await withEnv({ DIAKOSYS_ENDPOINT: "://bad" }, async () => {
    assert.throws(() => resolveEndpoint(), /invalid endpoint/);
  });
  // Non-string endpoint values are rejected, not coerced or silently skipped.
  await withUserConfig(JSON.stringify({ endpoint: null }), async () => {
    assert.throws(() => resolveEndpoint(), /non-empty string/);
  });
  await withUserConfig(JSON.stringify({ endpoint: 42 }), async () => {
    assert.throws(() => resolveEndpoint(), /non-empty string/);
  });
  await withUserConfig(JSON.stringify({ endpoint: [] }), async () => {
    assert.throws(() => resolveEndpoint(), /non-empty string/);
  });
  await withUserConfig(JSON.stringify({ endpoint: { host: "localhost" } }), async () => {
    assert.throws(() => resolveEndpoint(), /non-empty string/);
  });
  await withUserConfig(JSON.stringify({ endpoint: "" }), async () => {
    assert.throws(() => resolveEndpoint(), /must not be empty/);
  });
});

test("config file endpoint and provider settings are preserved when injecting", async () => {
  await withUserConfig(
    JSON.stringify({
      endpoint: "http://localhost:9090/v1",
      model: {
        provider: {
          "Qwen-Mimo": {
            npm: "@ai-sdk/openai-compatible",
            name: "Qwen-Mimo",
            options: { baseURL: "http://localhost:8080/v1", apiKey: "legacy-key" },
          },
        },
      },
    }),
    async () => {
      const c = await resolveConfig();
      assert.equal(c.endpoint, "http://localhost:9090/v1");
    },
  );
});

test("the task lease is a standalone constant and the lock is derived from it", async () => {
  // With no per-prompt deadline left, the lease no longer derives from prompt
  // or discovery timeouts; it is a standalone constant (overridable via
  // DIAKOSYS_ORCHESTRATOR_LEASE_TTL_MS) and the lock is sized from it.
  await withEnv({}, async () => {
    const c = await resolveConfig();
    assert.equal(c.taskLeaseTtlMs, 1_200_000);
    assert.equal(c.lockTtlMs, 2_400_000); // 2 × the lease
  });
  await withEnv(
    {
      DIAKOSYS_ORCHESTRATOR_LEASE_TTL_MS: "5000",
      DIAKOSYS_ORCHESTRATOR_LOCK_TTL_MS: "30000",
    },
    async () => {
      const c = await resolveConfig();
      assert.equal(c.taskLeaseTtlMs, 5_000);
      assert.equal(c.lockTtlMs, 30_000);
    },
  );
});

test("discovery limits and retry policy env overrides are parsed and validated", async () => {
  await withEnv(
    {
      DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_PROPOSALS: "7",
      DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_AREAS: "2",
      DIAKOSYS_ORCHESTRATOR_RETRY_MAX_ATTEMPTS: "5",
      DIAKOSYS_ORCHESTRATOR_RETRY_BASE_MS: "250",
      DIAKOSYS_ORCHESTRATOR_RETRY_MAX_MS: "1000",
    },
    async () => {
      const c = await resolveConfig();
      assert.equal(c.discoveryMaxProposals, 7);
      assert.equal(c.discoveryMaxAreas, 2);
      assert.deepEqual(c.retry, { maxAttempts: 5, baseMs: 250, maxMs: 1000 });
    },
  );
  await withEnv({ DIAKOSYS_ORCHESTRATOR_RETRY_MAX_ATTEMPTS: "-1" }, async () => {
    await assert.rejects(() => resolveConfig(), /DIAKOSYS_ORCHESTRATOR_RETRY_MAX_ATTEMPTS/);
  });
  await withEnv({ DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_AREAS: "0" }, async () => {
    await assert.rejects(() => resolveConfig(), /DIAKOSYS_ORCHESTRATOR_DISCOVERY_MAX_AREAS/);
  });
});

test("recoverOnStart parses booleans strictly", async () => {
  await withEnv({}, async () => {
    const c = await resolveConfig();
    assert.equal(c.recoverOnStart, true); // default: recover at cycle start
  });
  for (const truthy of ["1", "true", "yes", "on"]) {
    await withEnv({ DIAKOSYS_ORCHESTRATOR_RECOVER_ON_START: truthy }, async () => {
      const c = await resolveConfig();
      assert.equal(c.recoverOnStart, true, `value: ${truthy}`);
    });
  }
  for (const falsy of ["0", "false", "no", "off"]) {
    await withEnv({ DIAKOSYS_ORCHESTRATOR_RECOVER_ON_START: falsy }, async () => {
      const c = await resolveConfig();
      assert.equal(c.recoverOnStart, false, `value: ${falsy}`);
    });
  }
  await withEnv({ DIAKOSYS_ORCHESTRATOR_RECOVER_ON_START: "maybe" }, async () => {
    await assert.rejects(() => resolveConfig(), /DIAKOSYS_ORCHESTRATOR_RECOVER_ON_START/);
  });
});
