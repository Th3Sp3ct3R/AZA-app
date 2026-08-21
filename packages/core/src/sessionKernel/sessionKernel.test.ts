import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectMessagesFromKernel } from "../session.js";
import {
  IdempotencyConflictError,
  InvalidStateTransitionError,
  LeaseHeldError,
  PlanConflictError,
  RevisionConflictError,
  RunCoordinator,
  SessionKernelStore,
  StaleGenerationError,
  type BetterSqlite3Constructor,
  type RunFence,
} from "./index.js";

const requireFromAgent = createRequire(new URL("../../../agent/package.json", import.meta.url));
const BetterSqlite3 = requireFromAgent("better-sqlite3") as BetterSqlite3Constructor;

interface TestClock {
  value: number;
  now(): number;
  advance(ms: number): void;
}

function testClock(initial = 1_700_000_000_000): TestClock {
  return {
    value: initial,
    now() {
      return this.value;
    },
    advance(ms: number) {
      this.value += ms;
    },
  };
}

function inMemoryStore(clock = testClock()): SessionKernelStore {
  let sequence = 0;
  return new SessionKernelStore(new BetterSqlite3(":memory:"), {
    now: () => clock.now(),
    idFactory: (kind) => `${kind}_${++sequence}`,
  });
}

function fenceOf(lease: { sessionId: string; generation: number; leaseToken: string }): RunFence {
  return {
    sessionId: lease.sessionId,
    generation: lease.generation,
    leaseToken: lease.leaseToken,
  };
}

test("WAL store persists canonical sessions, child links, and events across reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ares-session-kernel-"));
  const filename = path.join(directory, "sessions.sqlite");
  try {
    const first = await SessionKernelStore.open({ filename, Database: BetterSqlite3 });
    assert.equal(first.schemaVersion, 8);
    assert.equal(first.journalMode.toLowerCase(), "wal");
    const root = first.createSession({ id: "root", workspaceKey: "D:/repo", metadata: { b: 2, a: 1 } });
    const child = first.createChildSession({
      id: "child",
      parentSessionId: root.id,
      relation: "task",
      externalKey: "research-api",
      linkMetadata: { role: "explore" },
    });
    assert.equal(child.rootSessionId, root.id);
    assert.equal(child.parentSessionId, root.id);
    const sameChild = first.createChildSession({
      parentSessionId: root.id,
      relation: "task",
      externalKey: "research-api",
    });
    assert.equal(sameChild.id, child.id);
    first.close();

    const reopened = await SessionKernelStore.open({ filename, Database: BetterSqlite3 });
    assert.equal(reopened.requireSession("root").metadata && (reopened.requireSession("root").metadata as any).a, 1);
    const children = reopened.listChildSessions("root");
    assert.equal(children.length, 1);
    assert.equal(children[0]?.session.id, "child");
    assert.equal(children[0]?.link.externalKey, "research-api");
    assert.deepEqual(
      reopened.listEvents("root").map((event) => event.type),
      ["session.created", "child.linked"],
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("finalized deletion atomically preserves permanent tombstones for the whole tree", () => {
  const clock = testClock();
  const store = inMemoryStore(clock);
  store.createSession({ id: "delete-root", workspaceKey: "D:/repo" });
  store.createChildSession({
    id: "delete-child",
    parentSessionId: "delete-root",
    relation: "task",
  });
  store.prepareSessionDeletion("delete-root");

  // Force the last canonical-row delete to fail. Child deletion and every
  // tombstone insert must roll back with it; there can be no half-finalized
  // identity state.
  (store as any).db.exec(`
    CREATE TRIGGER test_block_root_delete
    BEFORE DELETE ON sessions
    WHEN OLD.id = 'delete-root'
    BEGIN
      SELECT RAISE(ABORT, 'blocked for atomicity test');
    END;
  `);
  assert.throws(() => store.finalizeSessionDeletion("delete-root"), /blocked for atomicity test/);
  assert.equal(store.requireSession("delete-root").archived, true);
  assert.equal(store.requireSession("delete-child").archived, true);
  assert.deepEqual(store.listSessionTombstones(), []);

  (store as any).db.exec("DROP TRIGGER test_block_root_delete");
  clock.advance(25);
  assert.equal(store.finalizeSessionDeletion("delete-root"), true);
  assert.equal(store.getSession("delete-root"), null);
  assert.equal(store.getSession("delete-child"), null);
  assert.deepEqual(
    store.listSessionTombstones().map((entry) => ({
      id: entry.sessionId,
      parent: entry.parentSessionId,
      root: entry.rootSessionId,
      source: entry.deletionSource,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "delete-child", parent: "delete-root", root: "delete-root", source: "canonical" },
      { id: "delete-root", parent: null, root: "delete-root", source: "canonical" },
    ],
  );
  assert.throws(
    () => store.createSession({ id: "delete-root" }),
    /permanently deleted/i,
  );
  assert.throws(
    () => (store as any).db.prepare(
      `INSERT INTO sessions(id, root_session_id, created_at_ms, updated_at_ms)
       VALUES ('delete-root', 'delete-root', 1, 1)`,
    ).run(),
    /session id was permanently deleted/i,
    "the schema rejects a future importer that bypasses the store API",
  );
  store.createSession({ id: "surviving-parent" });
  assert.throws(
    () => store.createChildSession({
      id: "delete-child",
      parentSessionId: "surviving-parent",
      relation: "task",
    }),
    /permanently deleted/i,
  );
  store.close();
});

test("v5 migration backfills v4 archived deletion barriers before final cleanup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ares-session-kernel-v4-upgrade-"));
  const filename = path.join(directory, "sessions.sqlite");
  try {
    const seeded = await SessionKernelStore.open({ filename, Database: BetterSqlite3 });
    seeded.createSession({ id: "archived-on-v4", workspaceKey: "D:/repo" });
    seeded.prepareSessionDeletion("archived-on-v4");
    seeded.close();

    // Recreate the exact pre-v5 schema boundary while retaining the archived
    // row that v4 used to shadow stale JSON. Remove later v6-v8 tables too so
    // the normal migration chain is exercised on reopen.
    const v4 = new BetterSqlite3(filename);
    v4.exec(`
      DROP TABLE session_mutations;
      DROP TABLE detached_input_results;
      DROP TABLE background_job_cursors;
      DROP TABLE background_jobs;
      DROP TRIGGER sessions_reject_tombstoned_insert;
      DROP TRIGGER sessions_reject_tombstoned_id_update;
      DROP TABLE session_tombstones;
      DELETE FROM schema_migrations WHERE version >= 5;
      PRAGMA user_version = 4;
    `);
    v4.close();

    const upgraded = await SessionKernelStore.open({ filename, Database: BetterSqlite3 });
    assert.equal(upgraded.schemaVersion, 8);
    const tombstone = upgraded.getSessionTombstone("archived-on-v4");
    assert.equal(tombstone?.deletionSource, "canonical");
    assert.equal(tombstone?.deletedAtMs, upgraded.requireSession("archived-on-v4").updatedAtMs);
    assert.equal(upgraded.finalizeSessionDeletion("archived-on-v4"), true);
    assert.ok(upgraded.getSessionTombstone("archived-on-v4"));
    assert.throws(
      () => upgraded.createSession({ id: "archived-on-v4" }),
      /permanently deleted/i,
    );
    upgraded.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("admission is idempotent, inputs are fenced, and messages plus parts are atomic", () => {
  const store = inMemoryStore();
  store.createSession({ id: "s1" });
  const first = store.admitInput({
    id: "input-1",
    sessionId: "s1",
    idempotencyKey: "request-42",
    delivery: "queue",
    payload: { text: "build", options: { z: true, a: false } },
  });
  const replay = store.admitInput({
    sessionId: "s1",
    idempotencyKey: "request-42",
    delivery: "queue",
    payload: { options: { a: false, z: true }, text: "build" },
  });
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  assert.equal(replay.record.id, first.record.id);
  assert.throws(
    () =>
      store.admitInput({
        sessionId: "s1",
        idempotencyKey: "request-42",
        delivery: "steer",
        payload: { text: "different" },
      }),
    IdempotencyConflictError,
  );

  const lease = store.acquireRunnerLease("s1", "desktop", 5_000);
  assert.throws(() => store.acquireRunnerLease("s1", "garrison", 5_000), LeaseHeldError);
  const fence = fenceOf(lease);
  const claimed = store.claimNextInput(fence, "queue");
  assert.equal(claimed?.state, "claimed");
  assert.equal(claimed?.claimedGeneration, lease.generation);
  const message = store.appendMessage(fence, {
    id: "message-1",
    inputId: claimed!.id,
    role: "user",
    agent: "build",
    parts: [
      { type: "text", data: { text: "build" } },
      { type: "context", data: { planRevision: 3 } },
    ],
  });
  assert.equal(message.ordinal, 1);
  assert.deepEqual(message.parts.map((part) => part.ordinal), [1, 2]);
  assert.equal(store.consumeInput(fence, claimed!.id).state, "consumed");
  const run = store.releaseRunnerLease(fence, { executionState: "completed", workOutcome: "verified" });
  assert.equal(run.workOutcome, "verified");
  assert.equal(store.snapshot("s1").session.executionState, "completed");
  assert.equal(store.listMessages("s1").length, 1);
  store.close();
});

test("admission sequence is deterministic and explicit claims preserve caller ownership", () => {
  const store = inMemoryStore(testClock(42));
  store.createSession({ id: "ordered-inputs" });
  const first = store.admitInput({
    id: "z-first",
    sessionId: "ordered-inputs",
    idempotencyKey: "z-first",
    delivery: "queue",
    payload: { text: "first" },
  }).record;
  const second = store.admitInput({
    id: "a-second",
    sessionId: "ordered-inputs",
    idempotencyKey: "a-second",
    delivery: "queue",
    payload: { text: "second" },
  }).record;

  assert.equal(first.admittedAtMs, second.admittedAtMs, "the test forces a wall-clock tie");
  assert.deepEqual(store.listInputs("ordered-inputs").map((input) => input.id), ["z-first", "a-second"]);
  assert.deepEqual(store.listInputs("ordered-inputs").map((input) => input.admissionSequence), [1, 2]);

  const fence = fenceOf(store.acquireRunnerLease("ordered-inputs", "owner", 5_000));
  assert.equal(store.claimInput(fence, "a-second").id, "a-second", "a sender claims its own durable id");
  store.consumeInput(fence, "a-second");
  assert.equal(store.claimNextInput(fence)?.id, "z-first", "recovery FIFO uses admission sequence, not id order");
  store.consumeInput(fence, "z-first");
  store.releaseRunnerLease(fence, { executionState: "completed", workOutcome: "not_applicable" });

  store.createSession({ id: "ordered-steers" });
  store.admitInput({
    id: "z-steer-first",
    sessionId: "ordered-steers",
    idempotencyKey: "z-steer-first",
    delivery: "steer",
    payload: { text: "first steer" },
  });
  store.admitInput({
    id: "a-steer-second",
    sessionId: "ordered-steers",
    idempotencyKey: "a-steer-second",
    delivery: "steer",
    payload: { text: "second steer" },
  });
  const steerFence = fenceOf(store.acquireRunnerLease("ordered-steers", "steer-owner", 5_000));
  const steers = store.claimSteeringInputs(steerFence);
  assert.deepEqual(steers.map((input) => input.id), ["z-steer-first", "a-steer-second"]);
  for (const steer of steers) store.consumeInput(steerFence, steer.id);
  store.releaseRunnerLease(steerFence, { executionState: "completed", workOutcome: "not_applicable" });
  store.close();
});

test("generation-bound cancellation is terminal and release never requeues the claim", () => {
  const clock = testClock();
  const store = inMemoryStore(clock);
  store.createSession({ id: "cancelled-claim" });
  store.admitInput({
    id: "cancel-me",
    sessionId: "cancelled-claim",
    idempotencyKey: "cancel-me",
    delivery: "queue",
    payload: { content: [{ type: "text", text: "stop this" }] },
  });
  const fence = fenceOf(store.acquireRunnerLease("cancelled-claim", "desktop", 5_000));
  store.claimInput(fence, "cancel-me");

  clock.advance(25);
  const cancelled = store.cancelInput("cancel-me", {
    sessionId: "cancelled-claim",
    fence,
    reason: { code: "USER_CANCELLED" },
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.claimedGeneration, null);
  assert.equal(cancelled.claimedAtMs, null);
  assert.equal(cancelled.consumedAtMs, clock.now());
  assert.deepEqual(
    store.cancelInput("cancel-me", { sessionId: "cancelled-claim", fence }),
    cancelled,
    "duplicate Stop returns the one terminal record",
  );

  store.releaseRunnerLease(fence, {
    executionState: "interrupted",
    workOutcome: "not_applicable",
  });
  assert.equal(store.getInput("cancel-me")?.state, "cancelled");
  assert.equal(store.listInputs("cancelled-claim", "admitted").length, 0);
  const events = store.listEvents("cancelled-claim");
  assert.equal(events.filter((event) => event.type === "input.cancelled").length, 1);
  assert.equal(events.filter((event) => event.type === "input.requeued").length, 0);
  assert.equal(store.requireSession("cancelled-claim").executionState, "interrupted");
  store.close();
});

test("control-plane Stop can cancel an expired claim without touching a replacement generation", () => {
  const clock = testClock();
  const store = inMemoryStore(clock);
  store.createSession({ id: "expired-stop" });
  store.admitInput({
    id: "expired-input",
    sessionId: "expired-stop",
    idempotencyKey: "expired-input",
    delivery: "queue",
    payload: { content: [{ type: "text", text: "cancel across lease expiry" }] },
  });
  const expired = store.acquireRunnerLease("expired-stop", "old-runner", 250);
  store.claimInput(fenceOf(expired), "expired-input");
  clock.advance(251);

  assert.equal(
    store.cancelInput("expired-input", {
      sessionId: "expired-stop",
      expectedGeneration: expired.generation,
      reason: { code: "USER_CANCELLED" },
    }).state,
    "cancelled",
  );
  const replacement = store.acquireRunnerLease("expired-stop", "replacement", 250);
  assert.equal(replacement.generation, expired.generation + 1);
  assert.equal(store.getInput("expired-input")?.state, "cancelled");
  assert.equal(store.claimNextInput(fenceOf(replacement)), null);
  store.releaseRunnerLease(fenceOf(replacement), {
    executionState: "idle",
    workOutcome: "not_applicable",
  });
  store.close();
});

test("detached input delivery atomically consumes once or remains runnable", () => {
  const store = inMemoryStore();
  store.createSession({ id: "detached-result" });
  store.admitInput({
    id: "orphan-input",
    sessionId: "detached-result",
    idempotencyKey: "orphan-input",
    delivery: "queue",
    payload: { content: [{ type: "text", text: "finish me" }] },
  });
  const fence = fenceOf(store.acquireRunnerLease("detached-result", "recovery-host", 5_000));
  store.claimInput(fence, "orphan-input");
  store.appendMessage(fence, {
    id: "detached-output",
    role: "assistant",
    parts: [{ type: "text", data: { type: "text", text: "finished" } }],
  });

  (store as any).db.exec(`
    CREATE TRIGGER test_abort_detached_result
    BEFORE INSERT ON detached_input_results
    BEGIN
      SELECT RAISE(ABORT, 'injected detached-result commit failure');
    END;
  `);
  assert.throws(
    () => store.settleDetachedInputResult(fence, "orphan-input", {
      workOutcome: "verified",
      outputMessageId: "detached-output",
    }),
    /injected detached-result commit failure/,
  );
  assert.equal(store.getInput("orphan-input")?.state, "claimed", "consume rolled back with result insert");
  assert.equal(store.getDetachedInputResult("orphan-input"), null);

  (store as any).db.exec("DROP TRIGGER test_abort_detached_result");
  const settled = store.settleDetachedInputResult(fence, "orphan-input", {
    workOutcome: "verified",
    outputMessageId: "detached-output",
  });
  assert.equal(settled.outputMessageId, "detached-output");
  assert.deepEqual(
    store.settleDetachedInputResult(fence, "orphan-input", {
      workOutcome: "verified",
      outputMessageId: "detached-output",
    }),
    settled,
    "replaying settlement returns the one canonical acknowledgement",
  );
  assert.equal(store.getInput("orphan-input")?.state, "consumed");
  assert.equal(store.listDetachedInputResults("detached-result").length, 1);
  const events = store.listEvents("detached-result");
  assert.equal(events.filter((event) => event.type === "input.consumed").length, 1);
  assert.equal(events.filter((event) => event.type === "input.detached_result").length, 1);
  store.releaseRunnerLease(fence, { executionState: "completed", workOutcome: "verified" });
  store.close();
});

test("expired generation is fenced and takeover records uncertain effects without replaying claims", () => {
  const clock = testClock();
  const store = inMemoryStore(clock);
  store.createSession({ id: "s1" });
  store.admitInput({
    id: "queued",
    sessionId: "s1",
    idempotencyKey: "queued",
    delivery: "queue",
    payload: { text: "change it" },
  });
  const firstLease = store.acquireRunnerLease("s1", "runner-a", 1_000);
  const firstFence = fenceOf(firstLease);
  assert.equal(store.claimNextInput(firstFence)?.state, "claimed");
  let tool = store.beginToolRun(firstFence, {
    id: "tool-1",
    callKey: "call-1",
    toolName: "Shell",
    arguments: { command: "build" },
    effectKind: "workspace-write",
  });
  tool = store.transitionToolRun(firstFence, tool.id, "validated");
  tool = store.transitionToolRun(firstFence, tool.id, "authorized");
  tool = store.transitionToolRun(firstFence, tool.id, "checkpointed", { checkpointId: "cp-1" });
  tool = store.transitionToolRun(firstFence, tool.id, "executing");
  assert.equal(tool.executionState, "executing");

  clock.advance(1_001);
  assert.equal(store.isFenceCurrent(firstFence), false);
  const secondLease = store.acquireRunnerLease("s1", "runner-b", 1_000);
  assert.equal(secondLease.generation, firstLease.generation + 1);
  assert.throws(
    () => store.appendEvent(firstFence, "late.result", { shouldNotCommit: true }),
    StaleGenerationError,
  );
  const recoveredTool = store.getToolRun(tool.id)!;
  assert.equal(recoveredTool.executionState, "effect_unknown");
  assert.equal(recoveredTool.verificationState, "unverified");
  assert.equal(store.listInputs("s1", "admitted").length, 1);
  const interrupted = store.getRun("s1", firstLease.generation)!;
  assert.equal(interrupted.executionState, "interrupted");
  assert.equal(interrupted.workOutcome, "unverified");

  const secondFence = fenceOf(secondLease);
  // Reconciliation belongs to the old generation and must not be mutated by a
  // new runner through the normal transition API.
  assert.throws(
    () => store.transitionToolRun(secondFence, tool.id, "succeeded", { result: { reconciled: true } }),
    StaleGenerationError,
  );
  store.releaseRunnerLease(secondFence, { executionState: "waiting", workOutcome: "unverified" });
  store.close();
});

test("tool transitions reject illegal and stale optimistic updates", () => {
  const store = inMemoryStore();
  store.createSession({ id: "s1" });
  const fence = fenceOf(store.acquireRunnerLease("s1", "runner", 5_000));
  let tool = store.beginToolRun(fence, {
    id: "tool-1",
    callKey: "provider-call-1",
    toolName: "ApplyPatch",
    arguments: { patch: "*** Begin Patch" },
  });
  assert.throws(() => store.transitionToolRun(fence, tool.id, "succeeded"), InvalidStateTransitionError);
  tool = store.transitionToolRun(fence, tool.id, "validated", { expectedRevision: 0 });
  assert.throws(
    () => store.transitionToolRun(fence, tool.id, "authorized", { expectedRevision: 0 }),
    RevisionConflictError,
  );
  tool = store.transitionToolRun(fence, tool.id, "authorized", { expectedRevision: 1 });
  tool = store.transitionToolRun(fence, tool.id, "executing");
  tool = store.transitionToolRun(fence, tool.id, "succeeded", { result: { changedFiles: ["a.ts"] } });
  assert.equal(tool.result && (tool.result as any).changedFiles[0], "a.ts");
  tool = store.setToolVerification(fence, tool.id, "unverified", { check: "pending" });
  tool = store.setToolVerification(fence, tool.id, "verified", { check: "pnpm test" });
  assert.equal(tool.verificationState, "verified");
  assert.throws(() => store.setToolVerification(fence, tool.id, "blocked"), InvalidStateTransitionError);
  store.releaseRunnerLease(fence, { executionState: "completed", workOutcome: "verified" });
  store.close();
});

test("restart projection normalizes complete parallel tool results into assistant tool_use order", () => {
  const store = inMemoryStore();
  const sessionId = "ordered-parallel-results";
  store.createSession({ id: sessionId });
  const fence = fenceOf(store.acquireRunnerLease(sessionId, "runner", 5_000));

  store.appendMessage(fence, {
    id: "assistant-tools",
    role: "assistant",
    parts: [
      { type: "tool_use", data: { type: "tool_use", id: "use-a", name: "ReadA", input: {} } },
      { type: "tool_use", data: { type: "tool_use", id: "use-b", name: "ReadB", input: {} } },
    ],
  });
  for (const [id, name] of [["use-a", "ReadA"], ["use-b", "ReadB"]] as const) {
    let run = store.beginToolRun(fence, {
      id: `run-${id}`,
      callKey: `${fence.generation}:${id}`,
      toolName: name,
      arguments: {},
      effectKind: "read-only",
    });
    run = store.transitionToolRun(fence, run.id, "executing");
    store.transitionToolRun(fence, run.id, "succeeded", { result: { id } });
  }

  // Parallel completion order is intentionally the reverse of proposal order.
  store.appendMessage(fence, {
    id: "tool-b",
    role: "tool",
    parts: [{ type: "tool_result", data: { type: "tool_result", tool_use_id: "use-b", content: "B" } }],
  });
  store.appendMessage(fence, {
    id: "tool-a",
    role: "tool",
    parts: [{ type: "tool_result", data: { type: "tool_result", tool_use_id: "use-a", content: "A" } }],
  });

  const projection = projectMessagesFromKernel(store, sessionId);
  const resultMessage = projection.find((message) =>
    message.role === "user" && message.content.some((block) => block.type === "tool_result"),
  );
  assert.deepEqual(
    resultMessage?.content
      .filter((block) => block.type === "tool_result")
      .map((block) => block.tool_use_id),
    ["use-a", "use-b"],
  );
  store.releaseRunnerLease(fence, { executionState: "completed", workOutcome: "not_applicable" });
  store.close();
});

test("terminal tool settlement and canonical mutation scope commit atomically", () => {
  const store = inMemoryStore();
  store.createSession({ id: "mutation-scope" });
  const fence = fenceOf(store.acquireRunnerLease("mutation-scope", "writer", 5_000));
  let tool = store.beginToolRun(fence, {
    id: "mutation-tool-run",
    callKey: `${fence.generation}:edit-1`,
    toolName: "Edit",
    arguments: { file_path: "src/feature.ts" },
  });
  tool = store.transitionToolRun(fence, tool.id, "executing");

  (store as any).db.exec(`
    CREATE TRIGGER test_abort_mutation_scope
    BEFORE INSERT ON session_mutations
    BEGIN
      SELECT RAISE(ABORT, 'injected mutation scope failure');
    END;
  `);
  assert.throws(
    () => store.transitionToolRun(fence, tool.id, "succeeded", {
      result: { ok: true },
      mutation: {
        toolUseId: "edit-1",
        affectedPaths: ["D:/repo/src/feature.ts"],
      },
    }),
    /injected mutation scope failure/,
  );
  assert.equal(store.getToolRun(tool.id)?.executionState, "executing", "tool result rolled back with scope");
  assert.deepEqual(store.listUnresolvedSessionMutations("mutation-scope"), []);

  (store as any).db.exec("DROP TRIGGER test_abort_mutation_scope");
  store.transitionToolRun(fence, tool.id, "succeeded", {
    result: { ok: true },
    mutation: {
      toolUseId: "edit-1",
      affectedPaths: ["D:/repo/src/feature.ts"],
    },
  });
  const mutation = store.listUnresolvedSessionMutations("mutation-scope")[0];
  assert.equal(mutation?.generation, fence.generation);
  assert.equal(mutation?.toolRunId, tool.id);
  assert.deepEqual(mutation?.affectedPaths, ["D:/repo/src/feature.ts"]);
  assert.equal(mutation?.scopeComplete, true);
  store.releaseRunnerLease(fence, { executionState: "completed", workOutcome: "unverified" });

  const proofFence = fenceOf(store.acquireRunnerLease("mutation-scope", "verifier", 5_000));
  assert.equal(store.resolveSessionMutations(proofFence), 1);
  assert.deepEqual(store.listUnresolvedSessionMutations("mutation-scope"), []);
  store.releaseRunnerLease(proofFence, { executionState: "completed", workOutcome: "verified" });
  store.close();
});

test("context epochs form an immutable chain and only an exact approved plan can execute", () => {
  const store = inMemoryStore();
  store.createSession({ id: "s1" });
  const fence = fenceOf(store.acquireRunnerLease("s1", "runner", 5_000));
  const first = store.appendContextEpoch(fence, {
    reason: "initial",
    summary: { objective: "ship" },
    projection: { messageIds: ["m1"] },
    sourceVersions: { instructions: "sha-1" },
    tokenCount: 100,
  });
  const second = store.appendContextEpoch(fence, {
    reason: "compaction",
    summary: { objective: "ship", done: ["schema"] },
    projection: { anchorEpochId: first.id, messageIds: ["m8", "m9"] },
    sourceVersions: { previousEpoch: first.id },
    tokenCount: 80,
  });
  assert.equal(second.epoch, 2);
  assert.equal(second.previousEpochId, first.id);
  assert.equal(store.getLatestContextEpoch("s1")?.id, second.id);

  let plan = store.createPlanRevision({
    id: "plan-1",
    sessionId: "s1",
    body: "1. Change schema\n2. Run tests",
    author: "ares",
    fence,
  });
  plan = store.requestPlanApproval(plan.id, plan.planHash, fence);
  assert.equal(plan.status, "awaiting_approval");
  assert.throws(
    () =>
      store.decidePlan({
        planRevisionId: plan.id,
        expectedPlanHash: "wrong-hash",
        approver: "owner",
        decision: "approved",
      }),
    PlanConflictError,
  );
  const decision = store.decidePlan({
    planRevisionId: plan.id,
    expectedPlanHash: plan.planHash,
    approver: "owner",
    decision: "approved",
  });
  assert.equal(decision.plan.status, "approved");
  assert.equal(decision.approval.planHash, plan.planHash);
  plan = store.beginPlanExecution(fence, plan.id, plan.planHash);
  assert.equal(plan.status, "executing");
  plan = store.finishPlanExecution(fence, plan.id, "completed");
  assert.equal(plan.status, "completed");
  store.releaseRunnerLease(fence, { executionState: "completed", workOutcome: "verified" });
  store.close();
});

test("background jobs are idempotent, leased, cursor-fenced, and settle with one parent completion", () => {
  const clock = testClock();
  const store = inMemoryStore(clock);
  store.createSession({ id: "parent" });
  const request = {
    version: 1,
    subagentType: "researcher",
    description: "inspect jobs",
    prompt: "inspect",
    parentSessionId: "parent",
    invocationId: "tool-1",
    taskId: null,
    workspace: "D:/repo",
  } as const;
  const first = store.createBackgroundJob({
    id: "job-1",
    sessionId: "parent",
    invocationKey: "tool-1",
    kind: "task",
    description: "inspect jobs",
    request,
  });
  const replay = store.createBackgroundJob({
    sessionId: "parent",
    invocationKey: "tool-1",
    kind: "task",
    description: "inspect jobs",
    request,
  });
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  assert.equal(replay.record.id, "job-1");
  assert.throws(() => store.createBackgroundJob({
    sessionId: "parent",
    invocationKey: "tool-1",
    kind: "task",
    description: "changed",
    request,
  }), IdempotencyConflictError);
  assert.throws(
    () => store.prepareSessionDeletion("parent"),
    /background job job-1 is active/,
    "session deletion cannot orphan a detached worker or shell",
  );

  const claimed = store.claimBackgroundJob("job-1", "worker-a", 1_000);
  assert.equal(claimed?.status, "running");
  assert.equal(store.claimBackgroundJob("job-1", "worker-b", 1_000), null);
  clock.advance(1_001);
  assert.equal(store.claimBackgroundJob("job-1", "worker-b", 1_000)?.ownerId, "worker-b");

  assert.equal(store.getBackgroundJobCursor("job-1", "model"), 0);
  assert.equal(store.advanceBackgroundJobCursor("job-1", "model", 0, 12), true);
  assert.equal(store.advanceBackgroundJobCursor("job-1", "model", 0, 20), false);
  assert.equal(store.getBackgroundJobCursor("job-1", "model"), 12);

  const settled = store.settleBackgroundJob("job-1", {
    status: "completed",
    result: { summary: "done" },
    completion: {
      id: "job-completion-1",
      idempotencyKey: "background-job:job-1:completion",
      payload: {
        kind: "background-job-completion",
        jobId: "job-1",
        content: [{ type: "text", text: "done" }],
      },
    },
  }, "worker-b");
  assert.equal(settled.status, "completed");
  assert.equal(settled.completionInputId, "job-completion-1");
  assert.equal(store.getInput("job-completion-1")?.delivery, "steer");
  assert.equal(store.listEvents("parent").filter((event) => event.type === "background_job.settled").length, 1);
  const replayedSettlement = store.settleBackgroundJob("job-1", {
    status: "completed",
    result: { summary: "done" },
    completion: {
      id: "job-completion-1",
      idempotencyKey: "background-job:job-1:completion",
      payload: {
        kind: "background-job-completion",
        jobId: "job-1",
        content: [{ type: "text", text: "done" }],
      },
    },
  });
  assert.equal(replayedSettlement.completionInputId, "job-completion-1");
  assert.equal(store.listInputs("parent").filter((input) => input.id === "job-completion-1").length, 1);
  store.close();
});

test("RunCoordinator serializes a session and coalesces wakeups received during work", async () => {
  const store = inMemoryStore();
  store.createSession({ id: "s1" });
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  let active = 0;
  let peak = 0;
  const coordinator = new RunCoordinator({
    store,
    ownerId: "desktop",
    leaseTtlMs: 5_000,
    heartbeatIntervalMs: 1_000,
    worker: async (context) => {
      context.assertCurrent();
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (calls === 1) {
        markStarted();
        await gate;
      }
      active -= 1;
      return { executionState: "completed", workOutcome: "verified" };
    },
  });

  const first = coordinator.wake("s1");
  await firstStarted;
  const second = coordinator.wake("s1");
  const third = coordinator.wake("s1");
  assert.equal(first, second);
  assert.equal(second, third);

  const rival = new RunCoordinator({
    store,
    ownerId: "garrison",
    worker: async () => ({ executionState: "idle", workOutcome: "not_applicable" }),
  });
  await assert.rejects(rival.wake("s1"), LeaseHeldError);
  releaseFirst();
  const result = await first;
  assert.equal(result.cycles, 2);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  assert.equal(store.getRunnerLease("s1"), null);
  await Promise.all([coordinator.shutdown(), rival.shutdown()]);
  store.close();
});
