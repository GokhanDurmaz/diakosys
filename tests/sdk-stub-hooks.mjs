// Stage 10.1 — SDK stub loader hooks (test-only, no production impact).
//
// LiveOpenCodeAdapter dynamically imports "@opencode-ai/sdk" inside start() and
// calls createOpencodeServer(), which — in the real SDK — spawns the actual
// `opencode serve` binary (node_modules/@opencode-ai/sdk/dist/server.js). The
// orchestrator contract harness must not start real processes, and ESM module
// namespace exports are immutable, so the only clean interception point is a
// module loader hook: this file redirects the "@opencode-ai/sdk" specifier to a
// virtual stub module whose createOpencodeServer returns a fake handle pointing
// at the test's local stub HTTP server, while createOpencodeClient is
// re-exported unchanged from the REAL SDK (via the "@opencode-ai/sdk-real"
// marker specifier), so the adapter drives a real SDK client over real HTTP.
//
// Registered from tests/live-adapter.test.ts (in-process) and from
// tests/sdk-stub-register.mjs (for `node --import` in the doctor subprocess).

const STUB_URL = "file:///@diakosys-sdk-stub/sdk-stub-virtual.mjs";

// Evaluated on the main thread like any imported module: the holder on
// globalThis is shared with the test file, which configures the stub server
// URL per test and reads back the captured server options.
const STUB_SOURCE = `
export { createOpencodeClient } from "@opencode-ai/sdk-real";

export async function createOpencodeServer(options) {
  const holder = globalThis.__diakosysSdkStub;
  if (holder === undefined || typeof holder.url !== "string") {
    throw new Error(
      "diakosys sdk stub not configured: set globalThis.__diakosysSdkStub = { url } before adapter.start()",
    );
  }
  holder.createServerCalls = (holder.createServerCalls ?? 0) + 1;
  holder.serverOptions = options;
  try {
    void fetch(new URL("/__hook__/server-options", holder.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options ?? {}),
    }).catch(() => undefined);
  } catch {
    // stub server may already be gone; the handle itself is unaffected
  }
  return {
    url: holder.url,
    close() {
      holder.closeCalls = (holder.closeCalls ?? 0) + 1;
      try {
        void fetch(new URL("/__hook__/server-closed", holder.url), { method: "POST" }).catch(
          () => undefined,
        );
      } catch {
        // noop
      }
    },
  };
}
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@opencode-ai/sdk") {
    return { url: STUB_URL, format: "module", shortCircuit: true };
  }
  if (specifier === "@opencode-ai/sdk-real") {
    // Resolve the REAL package entry; nextResolve bypasses this hook chain,
    // so this cannot recurse into the stub redirect above. The virtual stub
    // module lives outside any node_modules scope, so bare-specifier
    // resolution needs a parentURL inside the orchestrator package
    // (tests/ → walks up to orchestrator/node_modules).
    const realParent = new URL("package.json", import.meta.url);
    return nextResolve("@opencode-ai/sdk", { ...context, parentURL: realParent.href });
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    return { format: "module", source: STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
