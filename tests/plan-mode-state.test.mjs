import test from "node:test";
import assert from "node:assert/strict";

import {
  makeEnterPlanModeTool,
  makeExitPlanModeTool,
  makeUpdatePlanDraftTool,
} from "../packages/tools/dist/index.js";

function context(requestPermission) {
  return {
    workspace: process.cwd(),
    sessionId: "plan-test",
    signal: new AbortController().signal,
    permissionMode: "plan",
    fileReadStamps: new Map(),
    requestPermission,
  };
}

test("ExitPlanMode records the proposal but cannot self-approve without a user channel", async () => {
  const events = [];
  const state = {
    permissionMode: "plan",
    onPlanProposed(plan) { events.push(["proposed", plan]); },
    onPlanApproved(plan) { events.push(["approved", plan]); },
    onPermissionModeChanged(mode) { events.push(["mode", mode]); },
  };
  const result = await makeExitPlanModeTool(state).call({ plan: "# Exact plan" }, context());
  assert.equal(result.output.approved, false);
  assert.equal(state.permissionMode, "plan");
  assert.deepEqual(events, [["proposed", "# Exact plan"]]);
});

test("ExitPlanMode transitions only after the exact proposal is approved", async () => {
  const events = [];
  const state = {
    permissionMode: "plan",
    onPlanProposed(plan) { events.push(["proposed", plan]); },
    onPlanApproved(plan) { events.push(["approved", plan]); },
    onPermissionModeChanged(mode) { events.push(["mode", mode]); },
  };
  const result = await makeExitPlanModeTool(state).call(
    { plan: "1. inspect\n2. build\n3. verify" },
    context(async () => "allow_once"),
  );
  assert.equal(result.output.approved, true);
  assert.equal(state.permissionMode, "workspace-write");
  assert.deepEqual(events.map(([kind]) => kind), ["proposed", "approved", "mode"]);
});

test("EnterPlanMode updates the live runtime through its transition callback", async () => {
  const modes = [];
  const state = {
    permissionMode: "workspace-write",
    onPermissionModeChanged(mode) { modes.push(mode); },
  };
  await makeEnterPlanModeTool(state).call({ reason: "design first" }, context());
  assert.equal(state.permissionMode, "plan");
  assert.deepEqual(modes, ["plan"]);
});

test("UpdatePlanDraft persists throughout planning and Exit submits the exact active bytes", async () => {
  const revisions = [];
  let current = null;
  const state = {
    permissionMode: "workspace-write",
    onPlanStarted(reason) {
      current = `# Plan\n\n${reason}`;
      revisions.push(current);
    },
    onPlanDraftUpdated(plan) {
      current = plan;
      revisions.push(plan);
    },
    currentPlan() { return current; },
    onPlanProposed(plan) { revisions.push(`proposed:${plan}`); },
    onPlanApproved(plan) { revisions.push(`approved:${plan}`); },
  };
  await makeEnterPlanModeTool(state).call({ reason: "inspect first" }, context());
  const exact = "# Durable plan\n\n1. inspect\n2. implement\n3. verify";
  await makeUpdatePlanDraftTool(state).call({ plan: exact }, context());
  const result = await makeExitPlanModeTool(state).call({}, context(async () => "allow_once"));

  assert.equal(result.output.plan, exact);
  assert.equal(result.output.approved, true);
  assert.equal(state.permissionMode, "workspace-write");
  assert.deepEqual(revisions.slice(-2), [`proposed:${exact}`, `approved:${exact}`]);
});

test("a failed durable mode transition rolls the live permission mode back", async () => {
  const state = {
    permissionMode: "workspace-write",
    onPermissionModeChanged() { throw new Error("database unavailable"); },
  };
  await assert.rejects(
    makeEnterPlanModeTool(state).call({ reason: "design first" }, context()),
    /database unavailable/,
  );
  assert.equal(state.permissionMode, "workspace-write");
});
