// ultracode-policy.test.mjs — the Conductor "elite fleet" policy layer:
//
//  1. WHEN-TO-SPAWN policy: a 1-phase/1-agent fleet is rejected at the tool
//     boundary (run it inline), un-isolated parallel writers must declare
//     disjoint file scopes, and the overlap check is glob-ish + segment-aware.
//  2. ISOLATION BY DEFAULT: a parallel build phase with 2+ writers gets
//     isolation:'worktree' automatically when the host can make worktrees;
//     explicit values, single writers, and read-only phases are untouched.
//  3. TYPED HANDOFFS: {{prev.field}} refs are validated against the upstream
//     stage's declared schema BEFORE the stage runs — an undeclared field fails
//     immediately with the declared field list; schema-less stages keep the
//     existing post-run fail-fast.
//
// No live model: leaves are faked via the injected runAgent seam (same pattern
// as packages/core/src/conductor.test.ts).

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { runFleet } from "../packages/core/dist/index.js";
import { makeConductorTool } from "../packages/tools/dist/index.js";

// ─── Mock substrate (mirrors conductor.test.ts) ─────────────────────────────

const U = (i = 10, o = 10) => ({ inputTokens: i, outputTokens: o, modelCalls: 1 });

function tool(name, safety = "read-only") {
  return {
    schema: { name, description: "", inputJsonSchema: {}, safety, concurrency: "parallel-safe" },
    call: async () => ({ output: null }),
  };
}

const validate = (schema, parsed) => {
  if (parsed == null || typeof parsed !== "object") return { ok: false, issues: "not an object" };
  for (const k of Object.keys(schema)) {
    if (!(k in parsed)) return { ok: false, issues: `${k}: missing` };
  }
  return { ok: true, value: parsed };
};

function baseDeps(overrides, runAgent) {
  return {
    provider: { name: "mock", stream: async function* () {} },
    model: "mock",
    parentTools: [tool("Read"), tool("Grep"), tool("Write", "workspace-write")],
    baseSystemPrompt: "base",
    workspace: os.tmpdir(),
    signal: new AbortController().signal,
    defaultMaxTurns: 4,
    validate,
    schemaHint: (s) => JSON.stringify(s),
    runAgent,
    ...overrides,
  };
}

function recordingRunner(record) {
  return async (args) => {
    record.calls.push(args);
    record.inFlight++;
    record.peak = Math.max(record.peak, record.inFlight);
    await new Promise((r) => setTimeout(r, 5)); // overlap window
    record.inFlight--;
    // Build output is accepted only with proof newer than its mutations. These
    // policy tests inject a fake runner, so explicitly provide that proof-bearing
    // outcome instead of relying on the old "loop completed == work succeeded"
    // default.
    return { finalText: args.role, events: [], usage: U(), status: "completed", workStatus: "verified" };
  };
}

function mockWorktrees() {
  const made = [];
  const filesByLabel = {};
  const make = async (label) => {
    made.push(label);
    return {
      dir: `/wt/${label}`,
      changedFiles: async () => filesByLabel[label] ?? [`${label}.ts`],
      applyTo: async () => ({ applied: filesByLabel[label] ?? [`${label}.ts`], failed: [] }),
      cleanup: async () => {},
    };
  };
  return { make, made, filesByLabel };
}

const twoWriterBuild = (agents) => ({
  phases: [{ id: "build", kind: "parallel", build: true, agents }],
});

// ─── 1. When-to-spawn: scope-gated un-isolated parallel writers ─────────────

test("isolation:'none' with OVERLAPPING scopes is rejected at spec time", async () => {
  const spec = {
    phases: [{
      id: "build", kind: "parallel", build: true, isolation: "none",
      agents: [
        { role: "a", prompt: "x", scope: ["src/api/**"] },
        { role: "b", prompt: "x", scope: ["src/api/handlers"] },
      ],
    }],
  };
  await assert.rejects(() => runFleet(spec, baseDeps({}, recordingRunner({ calls: [], inFlight: 0, peak: 0 }))), /overlapping scopes/);
});

test("isolation:'none' with a writer missing 'scope' is rejected", async () => {
  const spec = {
    phases: [{
      id: "build", kind: "parallel", build: true, isolation: "none",
      agents: [
        { role: "a", prompt: "x", scope: ["src/api"] },
        { role: "b", prompt: "x" }, // no scope declared
      ],
    }],
  };
  await assert.rejects(() => runFleet(spec, baseDeps({}, recordingRunner({ calls: [], inFlight: 0, peak: 0 }))), /must declare 'scope'/);
});

test("isolation:'none' with DISJOINT scopes runs writers in parallel in the shared workspace", async () => {
  const record = { calls: [], inFlight: 0, peak: 0 };
  const spec = {
    concurrency: 2,
    phases: [{
      id: "build", kind: "parallel", build: true, isolation: "none",
      agents: [
        { role: "a", prompt: "x", scope: ["src/api"] },
        { role: "b", prompt: "x", scope: ["src/ui"] },
      ],
    }],
  };
  const wt = mockWorktrees();
  const res = await runFleet(spec, baseDeps({ makeWorktree: wt.make }, recordingRunner(record)));
  assert.equal(res.status, "completed");
  assert.equal(record.calls.length, 2);
  assert.equal(record.peak, 2, "writers ran in PARALLEL");
  assert.ok(record.calls.every((c) => c.workspace === undefined), "shared main workspace — no sandbox");
  assert.equal(wt.made.length, 0, "explicit 'none' suppresses the worktree default");
});

test("scope overlap is segment-aware: 'src/api' does NOT overlap 'src/apiClient'", async () => {
  const record = { calls: [], inFlight: 0, peak: 0 };
  const spec = {
    phases: [{
      id: "build", kind: "parallel", build: true, isolation: "none",
      agents: [
        { role: "a", prompt: "x", scope: ["src/api"] },
        { role: "b", prompt: "x", scope: ["src/apiClient"] },
      ],
    }],
  };
  const res = await runFleet(spec, baseDeps({}, recordingRunner(record)));
  assert.equal(res.status, "completed");

  const nested = {
    phases: [{
      id: "build", kind: "parallel", build: true, isolation: "none",
      agents: [
        { role: "a", prompt: "x", scope: ["src"] },
        { role: "b", prompt: "x", scope: ["src/deep/file.ts"] },
      ],
    }],
  };
  await assert.rejects(() => runFleet(nested, baseDeps({}, recordingRunner({ calls: [], inFlight: 0, peak: 0 }))), /overlapping scopes/);
});

// ─── 2. Isolation by default ─────────────────────────────────────────────────

test("a parallel build phase with 2+ writers DEFAULTS to worktree isolation when the host can make worktrees", async () => {
  const wt = mockWorktrees();
  wt.filesByLabel["build-0"] = ["a.ts"];
  wt.filesByLabel["build-1"] = ["b.ts"];
  const seen = [];
  const run = async (args) => {
    seen.push(args.workspace ?? "MAIN");
    return { finalText: args.role, events: [], usage: U(), status: "completed", workStatus: "verified" };
  };
  // NOTE: no isolation set on the phase.
  const res = await runFleet(
    twoWriterBuild([{ role: "a", prompt: "x" }, { role: "b", prompt: "x" }]),
    baseDeps({ makeWorktree: wt.make }, run),
  );
  assert.equal(res.status, "completed");
  assert.equal(wt.made.length, 2, "a worktree per writer");
  assert.ok(seen.every((w) => w.startsWith("/wt/")), `writers ran in sandboxes, got ${seen}`);
});

test("without a worktree factory the un-isolated 2-writer parallel build still rejects (existing guard)", async () => {
  await assert.rejects(
    () => runFleet(
      twoWriterBuild([{ role: "a", prompt: "x" }, { role: "b", prompt: "x" }]),
      baseDeps({}, recordingRunner({ calls: [], inFlight: 0, peak: 0 })),
    ),
    /parallel BUILD phase/,
  );
});

test("a SINGLE-writer parallel build stays un-isolated even with a worktree factory", async () => {
  const wt = mockWorktrees();
  const record = { calls: [], inFlight: 0, peak: 0 };
  const res = await runFleet(
    twoWriterBuild([{ role: "solo", prompt: "x" }]),
    baseDeps({ makeWorktree: wt.make }, recordingRunner(record)),
  );
  assert.equal(res.status, "completed");
  assert.equal(wt.made.length, 0, "no worktree for a single writer");
  assert.equal(record.calls[0].workspace, undefined, "ran in the main workspace");
});

test("a READ-ONLY parallel phase stays un-isolated even with a worktree factory", async () => {
  const wt = mockWorktrees();
  const record = { calls: [], inFlight: 0, peak: 0 };
  const res = await runFleet(
    { phases: [{ id: "survey", kind: "parallel", agents: [{ role: "a", prompt: "x" }, { role: "b", prompt: "x" }] }] },
    baseDeps({ makeWorktree: wt.make }, recordingRunner(record)),
  );
  assert.equal(res.status, "completed");
  assert.equal(wt.made.length, 0, "research phases never pay the worktree cost");
  assert.ok(record.calls.every((c) => c.workspace === undefined));
});

// ─── 3. Typed handoffs ───────────────────────────────────────────────────────

test("a {{prev.field}} the upstream schema does NOT declare fails the stage BEFORE it runs", async () => {
  const ran = [];
  const run = async (args) => {
    ran.push(args.role);
    return { finalText: '{"topic":"auth"}', events: [], usage: U(), status: "completed" };
  };
  const spec = {
    phases: [{
      id: "pipe", kind: "pipeline",
      agents: [
        { role: "extract", prompt: "find the topic", schema: { topic: "..." } },
        { role: "write", prompt: "Write about {{prev.missing}}" },
      ],
    }],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.phases[0].status, "failed");
  assert.match(res.phases[0].failureReason ?? "", /upstream schema has no field 'missing'/);
  assert.match(res.phases[0].failureReason ?? "", /declared fields: \[topic\]/);
  assert.equal(ran.includes("write"), false, "the mistyped stage was never forked");
});

test("declared {{prev.field}} refs — including nested and array-indexed — pass the typed handoff", async () => {
  const prompts = [];
  const run = async (args) => {
    prompts.push(args.prompt);
    if (args.role === "plan") {
      return { finalText: '{"plan":{"files":["a.ts","b.ts"]}}', events: [], usage: U(), status: "completed" };
    }
    return { finalText: "done", events: [], usage: U(), status: "completed" };
  };
  const spec = {
    phases: [{
      id: "pipe", kind: "pipeline",
      agents: [
        { role: "plan", prompt: "plan it", schema: { plan: { files: ["..."] } } },
        { role: "build", prompt: "Build {{prev.plan.files.0}} from {{prev.plan.files}} ({{prev}})" },
      ],
    }],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.status, "completed");
  const buildPrompt = prompts.find((p) => p.startsWith("Build"));
  assert.ok(buildPrompt.includes("a.ts"), "nested/indexed refs resolved");
  assert.ok(!buildPrompt.includes("{{"), "no unresolved mustache reached the fork");
});

test("a NESTED undeclared field also fails the typed handoff", async () => {
  const ran = [];
  const run = async (args) => {
    ran.push(args.role);
    return { finalText: '{"plan":{"files":["a.ts"]}}', events: [], usage: U(), status: "completed" };
  };
  const spec = {
    phases: [{
      id: "pipe", kind: "pipeline",
      agents: [
        { role: "plan", prompt: "plan it", schema: { plan: { files: ["..."] } } },
        { role: "build", prompt: "Use {{prev.plan.nope}}" },
      ],
    }],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.phases[0].status, "failed");
  assert.match(res.phases[0].failureReason ?? "", /upstream schema has no field 'plan\.nope'/);
  assert.equal(ran.includes("build"), false);
});

test("no upstream schema → the existing post-run fail-fast still applies (stage runs, then barrier)", async () => {
  const ran = [];
  const run = async (args) => {
    ran.push(args.role);
    return { finalText: "free text, no json", events: [], usage: U(), status: "completed" };
  };
  const spec = {
    phases: [{
      id: "pipe", kind: "pipeline",
      agents: [
        { role: "first", prompt: "do work" }, // no schema declared
        { role: "second", prompt: "use {{prev.topic}}" },
      ],
    }],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.phases[0].status, "failed");
  assert.equal(ran.includes("second"), true, "schema-less handoff keeps today's behavior: run, then fail-fast");
  assert.match(res.phases[0].failureReason ?? "", /unresolved/);
});

test("bare {{prev}} with an upstream schema is always fine", async () => {
  const run = async (args) =>
    args.role === "extract"
      ? { finalText: '{"topic":"auth"}', events: [], usage: U(), status: "completed" }
      : { finalText: "done", events: [], usage: U(), status: "completed" };
  const spec = {
    phases: [{
      id: "pipe", kind: "pipeline",
      agents: [
        { role: "extract", prompt: "find it", schema: { topic: "..." } },
        { role: "write", prompt: "Summarize {{prev}}" },
      ],
    }],
  };
  const res = await runFleet(spec, baseDeps({}, run));
  assert.equal(res.status, "completed");
});

// ─── Tool boundary: when-to-spawn + schema surface ───────────────────────────

function conductorTool() {
  return makeConductorTool({
    provider: { name: "mock", stream: async function* () {} },
    model: "mock",
    parentTools: [tool("Read")],
    baseSystemPrompt: "base",
  });
}

test("the Conductor tool REJECTS a 1-phase/1-agent fleet (run it inline)", async () => {
  const t = conductorTool();
  const verdict = await t.validateInput(
    { phases: [{ id: "p", kind: "parallel", agents: [{ role: "solo", prompt: "x" }] }] },
    {},
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /inline/);
});

test("a lone self-repairing verify phase is exempt from the single-leaf rejection", async () => {
  const t = conductorTool();
  const verdict = await t.validateInput(
    { phases: [{ id: "v", kind: "pipeline", repairRounds: 3, agents: [{ role: "verify", prompt: "x" }] }] },
    {},
  );
  assert.equal(verdict.ok, true);
});

test("plan-only and multi-agent fleets pass the tool policy gate", async () => {
  const t = conductorTool();
  assert.equal((await t.validateInput({ plan: "build a thing" }, {})).ok, true);
  assert.equal(
    (await t.validateInput(
      { phases: [{ id: "p", kind: "parallel", agents: [{ role: "a", prompt: "x" }, { role: "b", prompt: "x" }] }] },
      {},
    )).ok,
    true,
  );
});

test("BUILD-DELIVERY: a build-goal fleet with NO build phase is REJECTED (research-only ships nothing)", async () => {
  const t = conductorTool();
  const verdict = await t.validateInput(
    {
      goal: "build a minecraft-style voxel builder in three.js",
      phases: [
        { id: "r", kind: "parallel", reduce: "judge", agents: [{ role: "a", prompt: "research voxel meshing" }, { role: "b", prompt: "research shaders" }] },
        { id: "p", kind: "pipeline", agents: [{ role: "planner", prompt: "plan the architecture" }] },
      ],
    },
    {},
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /no phase sets build:true|write ZERO code/i);
});

test("BUILD-DELIVERY: a build-goal fleet WITH a build:true phase passes", async () => {
  const t = conductorTool();
  const verdict = await t.validateInput(
    {
      goal: "build a minecraft-style voxel builder",
      phases: [
        { id: "r", kind: "parallel", reduce: "judge", agents: [{ role: "a", prompt: "research" }, { role: "b", prompt: "research2" }] },
        { id: "b", kind: "parallel", build: true, agents: [{ role: "m1", prompt: "write world.ts" }, { role: "m2", prompt: "write render.ts" }] },
      ],
    },
    {},
  );
  assert.equal(verdict.ok, true);
});

test("BUILD-DELIVERY: a non-build goal (review/research panel) is NOT falsely rejected", async () => {
  const t = conductorTool();
  assert.equal(
    (await t.validateInput(
      { goal: "review the staged diff", phases: [{ id: "rev", kind: "parallel", reduce: "judge", agents: [{ role: "c", prompt: "correctness" }, { role: "s", prompt: "security" }] }] },
      {},
    )).ok,
    true,
  );
});

test("BUILD-DELIVERY: a research-framed goal that merely NAMES 'build' is NOT rejected", async () => {
  const t = conductorTool();
  // "research how to build X" is a findings request, not a build directive.
  assert.equal(
    (await t.validateInput(
      { goal: "research rendering approaches for building a voxel game", phases: [{ id: "r", kind: "parallel", reduce: "judge", agents: [{ role: "a", prompt: "meshing" }, { role: "b", prompt: "shaders" }] }] },
      {},
    )).ok,
    true,
  );
});

test("the input schema accepts scope + isolation:'none' and rejects unknown isolation values", () => {
  const t = conductorTool();
  const good = t.inputZod.safeParse({
    phases: [{
      id: "b", kind: "parallel", build: true, isolation: "none",
      agents: [
        { role: "a", prompt: "x", scope: ["src/api"] },
        { role: "b", prompt: "x", scope: ["src/ui"] },
      ],
    }],
  });
  assert.equal(good.success, true);
  const bad = t.inputZod.safeParse({
    phases: [{ id: "b", kind: "parallel", isolation: "bogus", agents: [{ role: "a", prompt: "x" }] }],
  });
  assert.equal(bad.success, false);
});

test("the tool description carries the when-to-spawn doctrine", () => {
  const t = conductorTool();
  const d = t.schema.description;
  assert.match(d, /fan out ONLY/i);
  assert.match(d, /NEVER for a single-file edit/);
  assert.match(d, /TYPED HANDOFF/);
  assert.match(d, /DEFAULT for a parallel build phase|defaults to 'worktree'/i);
  assert.match(d, /BUILD FLEETS MUST BUILD/);
  assert.match(d, /no build:true phase is REJECTED/i);
});
