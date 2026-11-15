import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import {
  parseModelString,
  MockOpenCodeAdapter,
} from "../src/opencode.ts";

test("parseModelString splits provider from model id keeping inside slashes", () => {
  assert.deepEqual(parseModelString("Qwen-Mimo/Admin/model.gguf"), {
    providerID: "Qwen-Mimo",
    modelID: "Admin/model.gguf",
  });
  assert.deepEqual(parseModelString("Qwen-Mimo/model.gguf"), {
    providerID: "Qwen-Mimo",
    modelID: "model.gguf",
  });
});

test("parseModelString rejects malformed input", () => {
  assert.throws(() => parseModelString("no-slash"));
  assert.throws(() => parseModelString("/leading-slash"));
  assert.throws(() => parseModelString("trailing/"));
});

test("mock adapter records prompt inputs and returns canned result", async () => {
  const adapter = new MockOpenCodeAdapter((i) => `mock: ${i.title}`);
  const result = await adapter.prompt({
    title: "t",
    description: "d",
    directory: "/x",
  });
  assert.equal(result.role, "assistant");
  assert.equal(result.finish, "stop");
  assert.equal(result.text, "mock: t");
  assert.equal(adapter.calls.length, 1);
  await adapter.close();
});

test("store rejects invalid transitions and persists nothing for them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-state-"));
  const db = openDatabase(path.join(dir, "tasks.db"));
  try {
    const store = new TaskStore(db);
    const t = store.addTask({ title: "transition rules" });

    assert.throws(() => store.transition(t.id, "DONE"), /invalid transition/);
    assert.throws(() => store.transition(t.id, "IN_PROGRESS"), /invalid transition/);
    assert.equal(store.getTask(t.id)?.status, "DISCOVERED");
    assert.equal(store.eventsFor(t.id).length, 1, "only the created event");

    assert.throws(() => store.transition("no-such-task", "BACKLOG"), /not found/);
    store.transition(t.id, "BACKLOG");
    assert.equal(store.getTask(t.id)?.status, "BACKLOG");
    assert.throws(() => store.transition(t.id, "BACKLOG"), /same state/);
  } finally {
    closeDatabase(db);
  }
});
