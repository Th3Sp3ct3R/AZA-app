// Verifies the feedback loop: acting tools write outcomes into the self-model.
//   1. SkillCraft create registers an acquiring capability node.
//   2. RunSkill success + failure accumulate run stats on that node.
//   3. SkillCraft remove drops the node.
//   4. Mission verify(pass/fail) records the aggregate mission outcome.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SkillCraftTool,
  RunSkillTool,
  MissionTool,
  loadSelfModel,
  getCapability,
} from "../packages/agent/dist/index.js";

const ctx = { workspace: process.cwd(), signal: new AbortController().signal };

async function withHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-fb-"));
  process.env.ARES_HOME = home;
  try {
    await fn(home);
  } finally {
    delete process.env.ARES_HOME;
  }
}

test("SkillCraft create registers a capability node in the self-model", async () => {
  await withHome(async (home) => {
    await SkillCraftTool.call(
      { action: "create", name: "greeter", description: "says hi", handler_js: "export default async () => 'hi';" },
      ctx,
    );
    const cap = getCapability(await loadSelfModel(home), "skill/greeter");
    assert.ok(cap, "capability registered");
    assert.equal(cap.kind, "skill");
    assert.equal(cap.status, "acquiring");
    assert.deepEqual(cap.tags, ["runnable"]);
  });
});

test("RunSkill success then failure accumulate on the node", async () => {
  await withHome(async (home) => {
    await SkillCraftTool.call(
      {
        action: "create",
        name: "maybe",
        handler_js:
          "export default async (input) => { if (input?.bad) throw new Error('asked to fail'); return 'ok'; };",
      },
      ctx,
    );
    await RunSkillTool.call({ name: "maybe", input: { bad: false } }, ctx);
    await RunSkillTool.call({ name: "maybe", input: { bad: true } }, ctx);

    const cap = getCapability(await loadSelfModel(home), "skill/maybe");
    assert.equal(cap.outcomes.runs, 2);
    assert.equal(cap.outcomes.ok, 1);
    assert.equal(cap.outcomes.fail, 1);
    assert.match(cap.outcomes.lastError, /asked to fail/);
  });
});

test("SkillCraft remove drops the capability node", async () => {
  await withHome(async (home) => {
    await SkillCraftTool.call({ action: "create", name: "ephemeral", handler_js: "export default async () => 1;" }, ctx);
    await SkillCraftTool.call({ action: "remove", name: "ephemeral" }, ctx);
    const cap = getCapability(await loadSelfModel(home), "skill/ephemeral");
    assert.equal(cap, undefined);
  });
});

test("Mission verify records the aggregate mission outcome", async () => {
  await withHome(async (home) => {
    // a completed mission
    const c1 = await MissionTool.call({ action: "create", goal: "win", steps: ["do"] }, ctx);
    await MissionTool.call({ action: "step_done", result: "done", missionId: c1.output.missionId }, ctx);
    await MissionTool.call({ action: "verify", passed: true, result: "met", missionId: c1.output.missionId }, ctx);

    const cap = getCapability(await loadSelfModel(home), "mission/_aggregate");
    assert.ok(cap, "aggregate mission capability exists");
    assert.equal(cap.kind, "mission");
    assert.equal(cap.outcomes.ok, 1);
    assert.equal(cap.outcomes.fail, 0);
  });
});
