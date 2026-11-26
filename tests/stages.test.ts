import { test } from "node:test";
import assert from "node:assert/strict";
import type { LifecycleEvent } from "../src/lifecycle.ts";
import { StageLogger } from "../src/stages.ts";

function capture(): { events: LifecycleEvent[]; logger: StageLogger; advance(ms: number): void } {
  const events: LifecycleEvent[] = [];
  let now = 1_000;
  const logger = new StageLogger({
    onLifecycle: (event) => events.push(event),
    now: () => now,
  });
  return {
    events,
    logger,
    advance(ms: number): void {
      now += ms;
    },
  };
}

test("StageLogger start emits started and complete emits completed with the elapsed duration", () => {
  const { events, logger, advance } = capture();
  logger.start("evidence", { areaId: "architecture" });
  advance(250);
  logger.complete("evidence", { areaId: "architecture", sessionId: "ses_1" });

  assert.deepEqual(events.map((e) => `${e.stage}:${e.event}`), ["evidence:started", "evidence:completed"]);
  assert.equal(events[0]!.areaId, "architecture");
  assert.equal(events[0]!.durationMs, undefined, "a start never invents a duration");
  assert.equal(events[1]!.areaId, "architecture");
  assert.equal(events[1]!.durationMs, 250);
  assert.equal((events[1] as unknown as Record<string, unknown>).sessionId, "ses_1");
});

test("StageLogger failed emits failed with the error and the elapsed duration", () => {
  const { events, logger, advance } = capture();
  logger.start("opencode", { areaId: "tests" });
  advance(500);
  logger.failed("opencode", { areaId: "tests", error: "model connection refused" });

  assert.deepEqual(events.map((e) => `${e.stage}:${e.event}`), ["opencode:started", "opencode:failed"]);
  assert.equal(events[1]!.areaId, "tests");
  assert.equal(events[1]!.error, "model connection refused");
  assert.equal(events[1]!.durationMs, 500);
});

test("StageLogger start is idempotent per stage until the stage ends", () => {
  const { events, logger, advance } = capture();
  logger.start("prompt", { areaId: "architecture" });
  logger.start("prompt", { areaId: "architecture" });
  advance(10);
  logger.complete("prompt", { areaId: "architecture" });
  logger.start("prompt", { areaId: "tests" });
  advance(20);
  logger.complete("prompt", { areaId: "tests" });

  assert.deepEqual(
    events.map((e) => `${e.areaId}:${e.stage}:${e.event}`),
    ["architecture:prompt:started", "architecture:prompt:completed", "tests:prompt:started", "tests:prompt:completed"],
  );
  assert.equal(events[1]!.durationMs, 10);
  assert.equal(events[3]!.durationMs, 20);
});

test("StageLogger outcomes are no-ops for a stage that never started", () => {
  const { events, logger } = capture();
  logger.complete("response", { areaId: "architecture" });
  logger.failed("proposal", { areaId: "architecture", error: "never started" });
  assert.deepEqual(events, []);
});

test("StageLogger one-shot transitions always emit and carry no duration", () => {
  const { events, logger } = capture();
  logger.oneShot("proposal", "accepted", { areaId: "architecture" });
  logger.oneShot("proposal", "accepted", { areaId: "architecture" });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.event), ["accepted", "accepted"]);
  assert.ok(events.every((e) => e.durationMs === undefined));
});

test("a throwing StageLogger observer cannot interrupt discovery", () => {
  const logger = new StageLogger({
    onLifecycle: () => {
      throw new Error("observer exploded");
    },
  });
  assert.doesNotThrow(() => {
    logger.start("discovery", { areaId: "run" });
    logger.oneShot("prompt", "prepared", { areaId: "architecture" });
    logger.complete("discovery", { areaId: "run" });
    logger.start("evidence", { areaId: "architecture" });
    logger.failed("evidence", { areaId: "architecture", error: "boom" });
  });
});

test("StageLogger elapsed is measured from the stage start", () => {
  const { logger, advance } = capture();
  assert.equal(logger.elapsed("evidence", "architecture"), undefined);
  logger.start("evidence", { areaId: "architecture" });
  advance(42);
  assert.equal(logger.elapsed("evidence", "architecture"), 42);
  logger.complete("evidence", { areaId: "architecture" });
  assert.equal(logger.elapsed("evidence", "architecture"), undefined);
});
