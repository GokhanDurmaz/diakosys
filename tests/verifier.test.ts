import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { TaskStore } from "../src/store.ts";
import { MockOpenCodeAdapter, type OpenCodeAdapter } from "../src/opencode.ts";
import { executeNext } from "../src/runner.ts";
import { parseVerdict, verifyNext, verifyTask, verificationPromptBody } from "../src/verify.ts";
import { coordinatorAuth } from "./helpers.ts";
import type { DatabaseSync } from "node:sqlite";

function setup(): { store: TaskStore; db: DatabaseSync; dbPath: string; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diakosys-verifier-"));
  const db = openDatabase(path.join(dir, "tasks.db"));
  return {
    store: new TaskStore(db),
    db,
    dbPath: path.join(dir, "tasks.db"),
    close: () => closeDatabase(db),
  };
}

/** Drive a task into VERIFYING through the real claim → prompt pipeline. */
async function toVerifying(s: ReturnType<typeof setup>, id: string): Promise<void> {
  s.store.transition(id, "BACKLOG");
  s.store.transition(id, "READY");
  await executeNext(s.db, s.store, new MockOpenCodeAdapter(() => "changes applied"), {
    directory: "/tmp/project",
    coordinator: coordinatorAuth(s.db),
    taskLeaseTtlMs: 120_000,
    noHeartbeat: true,
  });
}

/** The claim's lease, handed to verification as task-lease authority. */
function leaseAuthority(s: ReturnType<typeof setup>, id: string): { owner: string; execGen: number; ttlMs: number } {
  const t = s.store.getTask(id)!;
  return { owner: t.leaseOwner ?? "", execGen: t.execGen, ttlMs: 120_000 };
}

function verifyingTask(s: ReturnType<typeof setup>, title: string, priority = 0): string {
  const t = s.store.addTask({ title, priority });
  // addTask → DISCOVERED; executeNext needs BACKLOG→READY, so transition first
  return t.id;
}

function neverAdapter(): OpenCodeAdapter {
  return new MockOpenCodeAdapter(() => {
    throw new Error("must not be called");
  });
}

test("a PASS verdict transitions VERIFYING → DONE and records the evidence", async () => {
  const s = setup();
  try {
    const id = verifyingTask(s, "verify me", 6);
    await toVerifying(s, id);

    const verifier = new MockOpenCodeAdapter(
      () => "ran the checks; everything holds\nVERDICT: PASS — checks green",
    );
    const outcome = await verifyTask(s.store, s.store.getTask(id)!, verifier, { directory: "/tmp/project", authority: leaseAuthority(s, id) });
    assert.equal(outcome.verdict, "pass");
    assert.match(outcome.detail, /^DONE — /);
    assert.match(outcome.detail, /checks green/);

    const stored = s.store.getTask(id);
    assert.equal(stored?.status, "DONE");
    assert.equal(stored?.executionMetadata["verification"], "pass");
    assert.match(String(stored?.executionMetadata["verificationNote"]), /verifier pass/);
    assert.equal(stored?.executionMetadata["verifierSessionId"], "ses_mock");
    const history = s.store.eventsFor(id).map((e) => e.toState);
    assert.equal(history[history.length - 1], "DONE");
    const lastEvent = s.store.eventsFor(id)[history.length - 1]!;
    assert.match(lastEvent.detail ?? "", /verification passed/);
  } finally {
    s.close();
  }
});

test("a FAIL verdict transitions VERIFYING → FAILED with the recorded reason", async () => {
  const s = setup();
  try {
    const id = verifyingTask(s, "verify me");
    await toVerifying(s, id);

    const verifier = new MockOpenCodeAdapter(() => "tests red\nVERDICT: FAIL — gradle test failures");
    const outcome = await verifyTask(s.store, s.store.getTask(id)!, verifier, { directory: "/tmp/project", authority: leaseAuthority(s, id) });
    assert.equal(outcome.verdict, "fail");
    assert.match(outcome.detail, /gradle test failures/);

    const stored = s.store.getTask(id);
    assert.equal(stored?.status, "FAILED");
    assert.equal(stored?.executionMetadata["verification"], "fail");
    assert.match(String(stored?.executionMetadata["verificationNote"]), /verifier fail/);
  } finally {
    s.close();
  }
});

test("a malformed response without a verdict fails and never passes", async () => {
  const s = setup();
  try {
    const id = verifyingTask(s, "verify me");
    await toVerifying(s, id);

    const verifier = new MockOpenCodeAdapter(() => "looks complete to me, great work!");
    const outcome = await verifyTask(s.store, s.store.getTask(id)!, verifier, { directory: "/tmp/project", authority: leaseAuthority(s, id) });
    assert.equal(outcome.verdict, "fail");
    assert.match(outcome.detail, /no explicit VERDICT/);
    assert.equal(s.store.getTask(id)?.status, "FAILED");
    assert.equal(s.store.getTask(id)?.executionMetadata["verification"], "fail");
  } finally {
    s.close();
  }
});

test("conflicting verdict lines are ambiguous and always fail", () => {
  assert.equal(parseVerdict("VERDICT: PASS\nthen again\nVERDICT: FAIL"), undefined);
  assert.equal(parseVerdict("no verdict at all"), undefined);
  const one = parseVerdict("stuff\nVERDICT: FAIL — broken build");
  assert.ok(one);
  assert.equal(one?.verdict, "FAIL");
  // the reason is everything after the verdict word, including the em dash
  assert.equal(one?.reason, "— broken build");
  const pass = parseVerdict("VERDICT: PASS");
  assert.ok(pass);
  assert.equal(pass?.verdict, "PASS");
});

test("a verifier timeout or error is a verification failure, never DONE", async () => {
  const s = setup();
  try {
    const id = verifyingTask(s, "verify me");
    await toVerifying(s, id);

    const verifier = new MockOpenCodeAdapter(() => {
      throw new Error("opencode prompt timed out after 40ms (session ses_x)");
    });
    const outcome = await verifyTask(s.store, s.store.getTask(id)!, verifier, { directory: "/tmp/project", authority: leaseAuthority(s, id) });
    assert.equal(outcome.verdict, "fail");
    assert.match(outcome.detail, /verifier error: opencode prompt timed out/);
    const stored = s.store.getTask(id);
    assert.equal(stored?.status, "FAILED");
    assert.notEqual(stored?.executionMetadata["verification"], "pass");
  } finally {
    s.close();
  }
});

test("verifyNext on an empty VERIFYING set returns undefined without prompting", async () => {
  const s = setup();
  try {
    const none = await verifyNext(s.store, neverAdapter(), { directory: "/tmp/project" });
    assert.equal(none, undefined);
  } finally {
    s.close();
  }
});

test("verifyNext verifies the highest-priority VERIFYING task", async () => {
  const s = setup();
  try {
    const low = verifyingTask(s, "low priority verify", 1);
    const high = verifyingTask(s, "high priority verify", 9);
    await toVerifying(s, low);
    await toVerifying(s, high);

    const adapter = new MockOpenCodeAdapter((input) =>
      input.description.startsWith("VERIFY TASK:") ? `checking ${input.title}\nVERDICT: PASS — OK` : "changes",
    );
    const highTask = s.store.listTasks("VERIFYING")[0]!;
    const first = await verifyNext(s.store, adapter, { directory: "/tmp/project", authority: leaseAuthority(s, highTask.id) });
    assert.ok(first);
    assert.equal(first?.title, "high priority verify");
    assert.equal(first?.verdict, "pass");
    const lowTask = s.store.listTasks("VERIFYING")[0]!;
    const second = await verifyNext(s.store, adapter, { directory: "/tmp/project", authority: leaseAuthority(s, lowTask.id) });
    assert.ok(second);
    assert.equal(second?.title, "low priority verify");
    const none = await verifyNext(s.store, adapter, { directory: "/tmp/project" });
    assert.equal(none, undefined);
  } finally {
    s.close();
  }
});

test("verifyTask skips tasks that are not in VERIFYING without touching state", async () => {
  const s = setup();
  try {
    const id = verifyingTask(s, "not verifying");
    s.store.transition(id, "BACKLOG");
    s.store.transition(id, "READY");
    const outcome = await verifyTask(s.store, s.store.getTask(id)!, neverAdapter(), { directory: "/tmp/project", authority: leaseAuthority(s, id) });
    assert.equal(outcome.verdict, "skipped");
    assert.equal(s.store.getTask(id)?.status, "READY");
  } finally {
    s.close();
  }
});

test("the verification prompt body starts with the VERIFY TASK marker", () => {
  const t = {
    id: "t1",
    title: "Fix leak",
    description: "stop the leak",
    status: "VERIFYING" as const,
    priority: 0,
    createdAt: 0,
    updatedAt: 0,
    attempts: 0,
    lastRunAt: null,
    executionMetadata: {},
    execGen: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  assert.ok(verificationPromptBody(t).startsWith("VERIFY TASK: Fix leak"));
  assert.match(verificationPromptBody(t), /VERDICT: PASS/);
  assert.match(verificationPromptBody(t), /always counts as VERDICT: FAIL/);
});
