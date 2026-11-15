import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition } from "../src/state.ts";

test("linear flow transitions are valid", () => {
  assert.equal(canTransition("DISCOVERED", "BACKLOG"), true);
  assert.equal(canTransition("BACKLOG", "READY"), true);
  assert.equal(canTransition("READY", "IN_PROGRESS"), true);
  assert.equal(canTransition("IN_PROGRESS", "REVIEW"), true);
  assert.equal(canTransition("REVIEW", "VERIFYING"), true);
  assert.equal(canTransition("VERIFYING", "DONE"), true);
});

test("blocked and failed side transitions are valid", () => {
  assert.equal(canTransition("BACKLOG", "BLOCKED"), true);
  assert.equal(canTransition("READY", "BLOCKED"), true);
  assert.equal(canTransition("IN_PROGRESS", "BLOCKED"), true);
  assert.equal(canTransition("BLOCKED", "READY"), true);
  assert.equal(canTransition("BLOCKED", "BACKLOG"), true);
  assert.equal(canTransition("IN_PROGRESS", "FAILED"), true);
  assert.equal(canTransition("VERIFYING", "FAILED"), true);
  assert.equal(canTransition("FAILED", "BACKLOG"), true);
});

test("review loop-back to in_progress is allowed", () => {
  assert.equal(canTransition("REVIEW", "IN_PROGRESS"), true);
});

test("skipping the chain is rejected", () => {
  assert.equal(canTransition("DISCOVERED", "READY"), false);
  assert.equal(canTransition("DISCOVERED", "DONE"), false);
  assert.equal(canTransition("BACKLOG", "REVIEW"), false);
  assert.equal(canTransition("READY", "DONE"), false);
});

test("backwards transitions are rejected", () => {
  assert.equal(canTransition("REVIEW", "BACKLOG"), false);
  assert.equal(canTransition("VERIFYING", "REVIEW"), false);
  assert.equal(canTransition("DONE", "BACKLOG"), false);
});

test("DONE is terminal, same-state moves rejected", () => {
  assert.equal(canTransition("DONE", "DONE"), false);
  assert.equal(canTransition("DONE", "FAILED"), false);
});
