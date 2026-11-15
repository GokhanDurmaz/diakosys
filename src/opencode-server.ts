import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * Shared server lifecycle for both CLI generations.
 *
 * Both OpenCode CLI v1.2.0 and v2.2.6 spawn the same way (`opencode serve
 * --hostname=… --port=…`), but they differ in two places the orchestrator
 * relies on:
 *   * the startup banner is prefixed in v1 ("opencode server listening on …")
 *     and bare in v2 ("server listening on …");
 *   * v2.2.6 always enables HTTP Basic auth (username `opencode`) while v1.2.0
 *     only does so when a password is present.
 *
 * This module owns the spawn, the dual-format banner readiness check, the
 * generated `OPENCODE_SERVER_PASSWORD` (used to enable auth on both servers),
 * and the Basic auth header the client must send. The spawn implementation is
 * replaceable so tests can drive a fake server without touching the network.
 */

export interface ServerOptions {
  hostname: string;
  port: number;
  /** ms the readiness check waits for a banner before giving up. */
  timeout: number;
  config?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ServerHandle {
  url: string;
  /** The matched banner line ("opencode server listening on …" for v1, bare
   *  "server listening on …" for v2). Protocol detection reads the prefix; the
   *  extracted url can never carry it (urls contain no spaces). */
  banner?: string;
  /** `OPENCODE_SERVER_PASSWORD` used to start the server (never logged). */
  password: string;
  close(): void;
}

/**
 * Minimal proc surface the readiness check consumes (mirrors the SDK's).
 *
 * The `on`/`off` signatures mirror node:child_process's event-specific
 * listener types rather than a generic callback. A listener with fewer
 * parameters than the declared signature is still accepted, which is what
 * lets a bare `() => void` cleanup function serve as both the "exit"
 * listener (which also receives a signal) and the "error" listener.
 */
export interface SpawnedProc {
  pid: number;
  stdout: Readable;
  stderr: Readable;
  kill: () => boolean;
  exitCode: number | null;
  signalCode: string | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
}

export interface SpawnOptions extends ServerOptions {
  password: string;
}

/**
 * Replaceable spawn implementation. Tests swap this in (see the loader hook in
 * tests/sdk-stub-hooks.mjs) so the adapter flow can be exercised against a fake
 * server with no real process or network.
 */
let spawnOpenCode: (options: SpawnOptions) => SpawnedProc = defaultSpawnOpenCode;

export function setSpawnOpenCode(fn: (options: SpawnOptions) => SpawnedProc): void {
  spawnOpenCode = fn;
}

export function getSpawnOpenCode(): (options: SpawnOptions) => SpawnedProc {
  return spawnOpenCode;
}

/** The default: `opencode serve --hostname=X --port=Y` with the password
 *  injected as `OPENCODE_SERVER_PASSWORD` (mirrors the SDK's cross-spawn call). */
function defaultSpawnOpenCode(options: SpawnOptions): SpawnedProc {
  const args = [`serve`, `--hostname=${options.hostname}`, `--port=${options.port}`];
  if (options.config?.logLevel) args.push(`--log-level=${options.config.logLevel}`);
  const proc = spawn("opencode", args, {
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: options.password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),
    },
  });
  return {
    pid: proc.pid ?? 0,
    stdout: proc.stdout ?? proc,
    stderr: proc.stderr ?? proc,
    kill: () => proc.kill(),
    // LIVE getters, not spawn-time snapshots: stop() early-returns when
    // exitCode/signalCode are set, so these must report the child's CURRENT
    // state. The previous implementation captured them once at spawn time and
    // normalised signalCode to `""` — which is not `null` — so the
    // "already exited" guard fired on every call and stop() never sent any
    // signal at all: every spawned server survived close(), and because the
    // parent holds the child's stdio pipes, CLI processes that spawned one
    // (doctor, discover) printed their output and then hung forever.
    get exitCode() {
      return proc.exitCode;
    },
    get signalCode(): string | null {
      return proc.signalCode ?? null;
    },
    on: proc.on.bind(proc),
    off: proc.off.bind(proc),
  };
}

/** Fresh server password; never logged or exposed anywhere. */
export function generatePassword(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Basic auth header both CLI generations accept (username is `opencode`). */
export function basicAuthHeader(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

/**
 * Extract the listening URL from either real banner format. v2's bare
 * "server listening on …" is a subset of v1's prefixed "opencode server
 * listening on …", so one regex covers both. Returns null when no banner line
 * has been seen yet (the caller scans cumulative output per line).
 */
export function matchServerUrlLine(line: string): string | null {
  const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
  return match?.[1] ?? null;
}

/**
 * Stop a spawned process. Mirrors the SDK's stop(): taskkill /T /F on Windows,
 * plain kill everywhere else.
 *
 * The early-return guard reads the SpawnedProc's exitCode/signalCode, which is
 * why those must be LIVE getters on the default spawner: the previous
 * spawn-time snapshot reported `""` for signalCode (never `null`), so this
 * function bailed on every call and never sent any signal — every spawned
 * server survived close(), and the CLI processes that spawned one (doctor,
 * discover) hung forever after printing their output, held by the child's
 * open stdio pipes.
 *
 * POSIX escalation (defense in depth): if the child ignores the SIGTERM, a
 * short grace period later it is probed with signal 0 and SIGKILLed if still
 * alive. The escalation timer is unref'd (it must not keep the parent alive
 * by itself); the parent's own pipes drain as soon as the child dies, which
 * is precisely what the escalation guarantees.
 */
const STOP_GRACE_MS = 500;
function stop(proc: SpawnedProc): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    if (!out.error && out.status === 0) return;
  }
  proc.kill();
  if (process.platform !== "win32" && proc.pid) {
    const escalate = setTimeout(() => {
      if (!proc.pid) return;
      try {
        process.kill(proc.pid, 0); // liveness probe: throws ESRCH once the child is gone
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // the child exited (or vanished) between the probe and the kill — done
      }
    }, STOP_GRACE_MS);
    escalate.unref();
  }
}

/**
 * Spawn the headless server and wait for a listening banner.
 *
 * Error semantics match the SDK exactly:
 *   * no banner within `timeout`ms → `Timeout waiting for server to start after Nms`
 *   * process exits → `Server exited with code N` (+ captured output)
 *   * spawn error → the spawn error itself
 *   * banner present but unparseable → `Failed to parse server url from output: …`
 */
export async function spawnOpenCodeServer(options: ServerOptions): Promise<ServerHandle> {
  const password = generatePassword();
  const proc = spawnOpenCode({ ...options, password });

  let clear = () => {};
  const listening = await new Promise<{ url: string; banner: string } | null>((resolve, reject) => {
    const id = setTimeout(() => {
      clear();
      stop(proc);
      reject(new Error(`Timeout waiting for server to start after ${options.timeout}ms`));
    }, options.timeout);

    let output = "";
    let resolved = false;

    proc.stdout?.on("data", (chunk: string) => {
      if (resolved) return;
      output += chunk;
      for (const line of output.split("\n")) {
        if (line.includes("server listening on")) {
          const match = matchServerUrlLine(output);
          if (!match) {
            clear();
            stop(proc);
            clearTimeout(id);
            reject(new Error(`Failed to parse server url from output: ${line}`));
            return;
          }
          clearTimeout(id);
          resolved = true;
          resolve({ url: match, banner: line });
          return;
        }
      }
    });

    proc.stderr?.on("data", (chunk: string) => {
      output += chunk;
    });

    proc.on("exit", (code: number | null) => {
      clearTimeout(id);
      let msg = `Server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });

    proc.on("error", (error: Error) => {
      clearTimeout(id);
      reject(error);
    });

    clear = bindAbort(proc, options.signal, () => {
      clearTimeout(id);
      reject(options.signal?.reason);
    });
  });

  if (listening === null) throw new Error("opencode server exited without reporting a listening url");
  return {
    url: listening.url,
    banner: listening.banner,
    password,
    close() {
      clear();
      stop(proc);
    },
  };
}

/**
 * Clear SDK-style abort wiring: on abort, clear the readiness timer and reject
 * with the signal reason; on exit/error, clear the wiring.
 */
function bindAbort(proc: SpawnedProc, signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => {};
  const abort = () => {
    clear();
    stop(proc);
    onAbort?.();
  };
  const clear = () => {
    signal.removeEventListener("abort", abort);
    proc.off("exit", clear);
    proc.off("error", clear);
  };
  signal.addEventListener("abort", abort, { once: true });
  proc.on("exit", clear);
  proc.on("error", clear);
  if (signal.aborted) abort();
  return clear;
}
