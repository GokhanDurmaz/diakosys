// Registers the SDK stub hooks for a fresh Node process (Stage 10.1).
// Used by tests/live-adapter.test.ts to run `src/cli.ts doctor` in a
// subprocess with the stub active: node --import tests/sdk-stub-register.mjs
import { register } from "node:module";
import { installFakeSpawn } from "./fake-opencode-spawn.ts";

register(new URL("./sdk-stub-hooks.mjs", import.meta.url));
// The doctor subprocess runs the real module chain, so the shared server spawn
// (src/opencode-server.ts) must also be faked here — the SDK loader hook alone
// cannot intercept it. Same "opencode "-prefixed v1 banner as the in-process
// harness.
installFakeSpawn({ bannerPrefix: "opencode " });

// The doctor subprocess connects to the test's stub HTTP server, whose URL is
// handed over through the environment (worker threads cannot share globals).
if (process.env.DIAKOSYS_TEST_SDK_STUB_URL !== undefined) {
  globalThis.__diakosysSdkStub = {
    url: process.env.DIAKOSYS_TEST_SDK_STUB_URL,
    createServerCalls: 0,
    closeCalls: 0,
  };
}
