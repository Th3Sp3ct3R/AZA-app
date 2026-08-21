// Verifies O1 — the Operator spine (the durable autonomy backbone):
//   1. Pure transitions: createGoal + applyVerdict (moved / progress / done / diverge).
//   2. Control loop: a Worker that moves the gap completes the goal in <= N ticks
//      and persists "done".
//   3. Resume: kill the Operator mid-goal, reload from disk, finish — no lost
//      progress, no duplicated step.
//   4. Divergence: a Worker that never moves the gap blocks + escalates after
//      maxNoProgress ticks instead of looping forever.
//   5. Real wiring: QueryEngineDispatcher drives an ephemeral QueryEngine
//      (MockEchoProvider) and the loop completes the goal.
//   6. Worker scope: recursive control-plane tools never enter unattended forks.
//   7. Scheduler: interval ticks fire, events wake immediately, stop halts.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  createGoal,
  applyVerdict,
  newGoalId,
  saveGoal,
  loadGoal,
  activeGoals,
  tickGoal,
  runGoalToCompletion,
  QueryEngineDispatcher,
  scopeOperatorWorkerTools,
  Scheduler,
} from "../packages/operator/dist/index.js";

import { MockEchoProvider, SessionKernelStore } from "../packages/core/dist/index.js";

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-operator-"));
}

// ── 1. Pure transitions ───────────────────────────────────────────────────

test("goal: createGoal starts active with zero progress", () => {
  const g = createGoal({ id: "g1", statement: "ship the spine" });
  assert.equal(g.status, "active");
  assert.equal(g.progress, 0);
  assert.equal(g.stepLog.length, 0);
});

test("goal: applyVerdict advances progress, completes on goalMet", () => {
  let g = createGoal({ id: "g2", statement: "do it" });
  g = applyVerdict(g, { moved: true, goalMet: false, evidence: "step a" });
  assert.equal(g.progress, 1);
  assert.equal(g.status, "active");
  assert.equal(g.noProgressStreak, 0);

  g = applyVerdict(g, { moved: true, goalMet: true, evidence: "done now" });
  assert.equal(g.status, "done");
  assert.equal(g.verdict, "done now");
  assert.equal(g.stepLog.length, 2);
});

test("goal: a run of no-progress steps trips divergence -> blocked", () => {
  let g = createGoal({ id: "g3", statement: "stuck", maxNoProgress: 3 });
  g = applyVerdict(g, { moved: false, goalMet: false });
  g = applyVerdict(g, { moved: false, goalMet: false });
  assert.equal(g.status, "active");
  g = applyVerdict(g, { moved: false, goalMet: false });
  assert.equal(g.status, "blocked");
  assert.match(g.verdict, /diverged/);
});

test("goal: a moving step resets the divergence streak", () => {
  let g = createGoal({ id: "g4", statement: "flaky", maxNoProgress: 2 });
  g = applyVerdict(g, { moved: false, goalMet: false });
  assert.equal(g.noProgressStreak, 1);
  g = applyVerdict(g, { moved: true, goalMet: false });
  assert.equal(g.noProgressStreak, 0);
  assert.equal(g.status, "active");
});

// ── 2. Control loop completes ──────────────────────────────────────────────

test("loop: a gap-moving Worker completes the goal in <= 2 ticks and persists done", async () => {
  const home = await makeHome();
  const goal = createGoal({ id: newGoalId(), statement: "two-step goal" });
  await saveGoal(home, goal);

  // Mock Worker: every step moves the gap; the goal is met on the 2nd step.
  let calls = 0;
  const dispatcher = {
    async runStep(g) {
      calls++;
      const index = g.stepLog.length; // 0-based index of this step
      return { moved: true, goalMet: index >= 1, evidence: `step ${index}` };
    },
  };

  const events = [];
  const final = await runGoalToCompletion(
    { home, dispatcher, emit: (e) => events.push(e.type) },
    goal.id,
    { maxTicks: 10 },
  );

  assert.equal(final.status, "done");
  assert.equal(calls, 2, "exactly two steps dispatched");
  assert.equal(final.progress, 2);

  const onDisk = await loadGoal(home, goal.id);
  assert.equal(onDisk.status, "done", "completion persisted to disk");
  assert.ok(events.includes("goal_completed"), "emitted goal_completed");
});

// ── 3. Resume after kill ────────────────────────────────────────────────────

test("loop: killing mid-goal and reloading resumes with no lost or duplicated step", async () => {
  const home = await makeHome();
  const goal = createGoal({ id: newGoalId(), statement: "resume me" });
  await saveGoal(home, goal);

  let calls = 0;
  const dispatcher = {
    async runStep(g) {
      calls++;
      const index = g.stepLog.length;
      return { moved: true, goalMet: index >= 1, evidence: `step ${index}` };
    },
  };
  const ctx = { home, dispatcher };

  // One tick, then simulate a process kill: drop the in-memory goal entirely.
  const afterFirst = await tickGoal(ctx, goal);
  assert.equal(afterFirst.status, "active");
  assert.equal(afterFirst.stepLog.length, 1);

  // "Restart": the only thing that survives is what's on disk.
  const reloaded = await loadGoal(home, goal.id);
  assert.equal(reloaded.stepLog.length, 1, "first step survived the kill");

  const final = await runGoalToCompletion(ctx, reloaded.id, { maxTicks: 10 });
  assert.equal(final.status, "done");
  assert.equal(calls, 2, "no step was duplicated across the restart");
  assert.equal(final.stepLog.length, 2);
});

// ── 4. Divergence escalates ─────────────────────────────────────────────────

test("loop: a Worker that never moves the gap escalates instead of looping forever", async () => {
  const home = await makeHome();
  const goal = createGoal({ id: newGoalId(), statement: "impossible", maxNoProgress: 3 });
  await saveGoal(home, goal);

  let calls = 0;
  const dispatcher = {
    async runStep() {
      calls++;
      return { moved: false, goalMet: false, evidence: "no progress" };
    },
  };

  const events = [];
  const final = await runGoalToCompletion(
    { home, dispatcher, emit: (e) => events.push(e.type) },
    goal.id,
    { maxTicks: 100 }, // generous ceiling; divergence must stop it well before this
  );

  assert.equal(final.status, "blocked");
  assert.equal(calls, 3, "stopped at the divergence threshold, did not run to the ceiling");
  assert.ok(events.includes("goal_diverged"), "emitted goal_diverged escalation");
});

// ── 5. Real QueryEngine wiring ──────────────────────────────────────────────

test("dispatcher: QueryEngineDispatcher drives an ephemeral QueryEngine to completion", async () => {
  const home = await makeHome();
  const goal = createGoal({ id: newGoalId(), statement: "exercise the real engine" });
  await saveGoal(home, goal);

  const dispatcher = new QueryEngineDispatcher({
    provider: new MockEchoProvider(),
    model: "mock",
    workspace: process.cwd(),
    // O1 placeholder verdict: the mock engine ran a real turn (text came back),
    // so the step moved; mark the goal met so the loop terminates.
    evaluate: (turnText) => ({ moved: turnText.length > 0, goalMet: true, evidence: turnText.slice(0, 80) }),
  });

  const final = await runGoalToCompletion({ home, dispatcher }, goal.id, { maxTicks: 5 });
  assert.equal(final.status, "done");
  assert.ok(final.stepLog[0].moved, "the real QueryEngine turn produced output");
});

test("dispatcher: unattended worker scope strips recursive control planes but keeps bounded Task", () => {
  const tool = (name) => ({
    schema: {
      name,
      description: name,
      inputJsonSchema: { type: "object", properties: {} },
      safety: "read-only",
      concurrency: "parallel-safe",
    },
    async call() { return { output: null }; },
  });
  const scoped = scopeOperatorWorkerTools([
    tool("Read"),
    tool("Task"),
    tool("Operator"),
    tool("Conductor"),
    tool("StandingOrder"),
    tool("CodingBackend"),
    tool("Capability"),
    tool("EnterPlanMode"),
    tool("ExitPlanMode"),
  ]);

  assert.deepEqual(scoped.map((entry) => entry.schema.name), ["Read", "Task"]);
});

test("dispatcher: durable worker session links to the goal and reuses a consumed step idempotently", async () => {
  const workspace = await makeHome();
  const kernel = await SessionKernelStore.open({ filename: path.join(workspace, "operator-kernel.sqlite") });
  try {
    const goal = createGoal({ id: "durable-dispatch", statement: "exercise the durable operator worker" });
    const dispatcher = new QueryEngineDispatcher({
      provider: new MockEchoProvider(),
      model: "mock",
      workspace,
      sessionKernel: kernel,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
    });
    const ctx = { signal: new AbortController().signal, now: () => new Date() };

    const first = await dispatcher.runStep(goal, ctx);
    const recovered = await dispatcher.runStep(goal, ctx);
    assert.equal(first.moved, true);
    assert.equal(recovered.moved, true, "retry recovered the durable assistant result");
    assert.equal(recovered.evidence, first.evidence);

    const key = createHash("sha256").update(goal.id, "utf8").digest("hex").slice(0, 24);
    const root = kernel.getSession(`operator_goal_${key}`);
    assert.ok(root);
    const children = kernel.listChildSessions(root.id);
    assert.equal(children.length, 1, "same logical step reused one child session");
    const worker = children[0].session;
    const inputs = kernel.listInputs(worker.id);
    assert.equal(inputs.length, 1, "same logical step reused one admitted input");
    assert.equal(inputs[0].state, "consumed");
    assert.ok(kernel.listMessages(worker.id).some((message) => message.role === "assistant"));
  } finally {
    kernel.close();
  }
});

// ── 7. Scheduler ────────────────────────────────────────────────────────────

test("scheduler: interval ticks fire and stop halts them", async () => {
  let ticks = 0;
  const sched = new Scheduler({ everyMs: 10, onTick: () => { ticks++; } });
  sched.start();
  await new Promise((r) => setTimeout(r, 45));
  sched.stop();
  const settled = ticks;
  assert.ok(settled >= 1, "interval fired at least once");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ticks, settled, "no ticks after stop()");
});

test("scheduler: an enqueued event wakes the loop immediately", async () => {
  const reasons = [];
  const sched = new Scheduler({ everyMs: 100000, onTick: (reason) => { reasons.push(reason); } });
  sched.enqueueEvent({ kind: "inbound_email" });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(reasons.includes("event"), "event triggered a tick without waiting for the interval");
});
