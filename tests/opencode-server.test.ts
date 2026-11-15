// Regression tests for ServerHandle.close()/stop() termination semantics
// (src/opencode-server.ts). These drive a REAL child process — no fake spawn —
// because the bug they pin is real-process behaviour the fake seam cannot
// reproduce: `opencode serve` (v2.x, Bun binary) swallows a SIGTERM that
// arrives shortly after startup, and the surviving child's stdio pipes kept
// the CLI's event loop alive forever (doctor printed every check and hung).
//
// The children here are `sh` processes, so no opencode binary is required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  getSpawnOpenCode,
  setSpawnOpenCode,
  spawnOpenCodeServer,
  type SpawnOptions,
  type SpawnedProc,
} from "../src/opencode-server.ts";

/** pid of the most recently spawned stub child (set by makeChild). */
let childPid = 0;

function makeChild(shellScript: string): SpawnedProc {
  const real = spawn("sh", ["-c", shellScript]);
  childPid = real.pid ?? 0;
  if (!real.stdout || !real.stderr) throw new Error("stub child must pipe stdout and stderr");
  return wrap(real, real.stdout, real.stderr);
}

/** Wrap a real ChildProcess into the SpawnedProc shape defaultSpawnOpenCode
 *  produces — including the LIVE getters (the whole point of these tests). */
function wrap(real: ChildProcess, stdout: Readable, stderr: Readable): SpawnedProc {
  return {
    pid: real.pid ?? 0,
    stdout,
    stderr,
    kill: () => real.kill(),
    get exitCode() {
      return real.exitCode;
    },
    get signalCode(): string | null {
      return real.signalCode ?? null;
    },
    on: real.on.bind(real),
    off: real.off.bind(real),
  };
}

/** Install a custom spawner and return a restore function. */
function useSpawner(spawner: (options: SpawnOptions) => SpawnedProc): () => void {
  const original = getSpawnOpenCode();
  setSpawnOpenCode(spawner);
  return () => setSpawnOpenCode(original);
}

/** A liveness probe that is unambiguous about pid reuse: signal 0. */
function childAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the child is gone (or the deadline passes). */
async function untilDead(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!childAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !childAlive(pid);
}

const BANNER = 'echo "server listening on http://localhost:1"';

test(
  "close() terminates a child that swallows SIGTERM (escalates to SIGKILL)",
  { skip: process.platform === "win32" },
  async () => {
    // `trap "" TERM` makes the shell ignore SIGTERM entirely — exactly the
    // observed opencode serve behaviour that left the parent's event loop
    // hanging on the child's open stdio pipes.
    const restore = useSpawner(() => makeChild(`${BANNER}; trap "" TERM; sleep 30`));
    try {
      const server = await spawnOpenCodeServer({ hostname: "localhost", port: 0, timeout: 5000 });
      const pid = childPid;
      assert.ok(pid > 0, "the stub spawner must expose the child pid");
      assert.equal(server.url, "http://localhost:1");
      server.close();
      // SIGTERM is trapped, so only the escalation can kill it — the child
      // must be dead well within the grace window plus a generous margin.
      const dead = await untilDead(pid, 5_000);
      assert.equal(dead, true, "close() must SIGKILL a SIGTERM-swallowing child");
    } finally {
      restore();
    }
  },
);

test(
  "close() terminates a child that honours SIGTERM without escalating",
  { skip: process.platform === "win32" },
  async () => {
    // `exec sleep` REPLACES the shell, so the captured pid is the sleep
    // itself: the first SIGTERM kills it directly (no shell indirection, no
    // orphans); the escalation's liveness probe must then find nothing to
    // SIGKILL. Pins the non-escalation path.
    const restore = useSpawner(() => makeChild(`${BANNER}; exec sleep 30`));
    try {
      const server = await spawnOpenCodeServer({ hostname: "localhost", port: 0, timeout: 5000 });
      const pid = childPid;
      assert.ok(pid > 0);
      server.close();
      const dead = await untilDead(pid, 5_000);
      assert.equal(dead, true, "close() must terminate a well-behaved child");
    } finally {
      restore();
    }
  },
);
