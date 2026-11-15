// Stage 10.1 — fake `opencode serve` spawn (test-only, no production impact).
//
// The adapter starts its headless server through spawnOpenCodeServer()
// (src/opencode-server.ts), whose spawn implementation is a documented test
// seam (setSpawnOpenCode). Loader hooks cannot intercept that static import,
// so the adapter harnesses install this fake in-process instead: it hands back
// a SpawnedProc whose stdout carries a startup banner pointing at the test's
// local stub HTTP server, so no real OpenCode process, model server, credential
// or external network call is ever made.
//
// The stub server URL comes from the same globalThis.__diakosysSdkStub holder the
// SDK loader hook (tests/sdk-stub-hooks.mjs) uses, so existing assertions on
// createServerCalls / serverOptions / closeCalls keep working unchanged. The
// banner prefix selects the CLI generation the facade detects: "opencode " →
// v1, bare → v2 (see detectProtocol in src/opencode.ts).

import { PassThrough } from "node:stream";
import { setSpawnOpenCode, type SpawnOptions, type SpawnedProc } from "../src/opencode-server.ts";

interface StubHolder {
  url: string;
  serverOptions?: unknown;
  createServerCalls: number;
  closeCalls: number;
}

export interface FakeSpawnOptions {
  /** Emitted before "server listening on …". "opencode " selects v1, bare selects v2. */
  bannerPrefix?: string;
}

let installed = false;

/** Install the fake spawn once per process. Later calls are no-ops. */
export function installFakeSpawn(options: FakeSpawnOptions = {}): void {
  if (installed) return;
  installed = true;
  const prefix = options.bannerPrefix ?? "";
  setSpawnOpenCode((spawnOptions: SpawnOptions): SpawnedProc => {
    const holder = (globalThis as { __diakosysSdkStub?: StubHolder }).__diakosysSdkStub;
    if (holder === undefined || typeof holder.url !== "string") {
      throw new Error(
        "diakosys sdk stub not configured: set globalThis.__diakosysSdkStub = { url } before adapter.start()",
      );
    }
    // The generated password must not leak into the captured server options.
    const { password: _password, ...reportedOptions } = spawnOptions;
    holder.createServerCalls = (holder.createServerCalls ?? 0) + 1;
    holder.serverOptions = reportedOptions;
    // Fire-and-forget: the doctor subprocess assertions read the captured
    // options through the stub server's /__hook__/server-options route.
    try {
      void fetch(new URL("/__hook__/server-options", holder.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reportedOptions ?? {}),
      }).catch(() => undefined);
    } catch {
      // the stub server may already be gone; the fake handle itself is unaffected
    }

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // Buffered until spawnOpenCodeServer attaches its "data" listener.
    stdout.write(`${prefix}server listening on ${holder.url}\n`);
    return {
      pid: 424_242,
      stdout,
      stderr,
      kill: () => {
        // ServerHandle.close() stops the proc; count it like the old SDK stub did.
        holder.closeCalls = (holder.closeCalls ?? 0) + 1;
        return true;
      },
      exitCode: null,
      signalCode: null,
      // The fake proc never exits, and tests never pass an abort signal, so
      // the exit/error/close listeners are never invoked.
      on: () => undefined,
      off: () => undefined,
    };
  });
}
