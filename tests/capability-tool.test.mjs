import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getCapability,
  loadSelfModel,
  makeCapabilityTool,
  scanCapabilityRegistry,
} from "../packages/agent/dist/index.js";
import { Session, SessionKernelStore } from "../packages/core/dist/index.js";
import { adaptToolForEngine } from "../packages/tools/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

function toolThenDoneProvider(input) {
  let calls = 0;
  return {
    name: "capability-plan-test-provider",
    async *stream() {
      calls += 1;
      if (calls === 1) {
        const use = { type: "tool_use", id: "capability-tool-use", name: "Capability", input };
        yield { type: "tool_use_start", id: use.id, name: use.name };
        yield { type: "tool_use_input_done", id: use.id, input: use.input };
        yield {
          type: "message_done",
          message: { id: `capability-plan-${calls}`, role: "assistant", content: [use], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: {
          id: `capability-plan-${calls}`,
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function drain(iterable) {
  for await (const _ of iterable) { /* drain */ }
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function manifest(scope, id) {
  return {
    schemaVersion: 1,
    id,
    kind: "environment-provider",
    version: "1.0.0",
    scope,
    description: "Generic scene adapter fixture",
    operations: {
      inspect: { description: "Observe scene state", effect: "read-only", evidence: [], requiresFreshObservationAfter: false },
      mutate: { description: "Mutate scene state", effect: "workspace-write", evidence: [], requiresFreshObservationAfter: false },
      publish: { description: "Publish scene state", effect: "external-state", evidence: [], requiresFreshObservationAfter: false },
      health: { description: "Check adapter", effect: "read-only", evidence: [], requiresFreshObservationAfter: false },
    },
    provides: {
      "scene/inspect": "inspect",
      "scene/mutate": "mutate",
      "scene/publish": "publish",
    },
    healthcheck: { operation: "health", timeoutMs: 2_000 },
  };
}

async function writeProvider(root, name, providerManifest) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`, "utf8");
  await fs.writeFile(path.join(dir, "capability.json"), JSON.stringify(providerManifest, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(dir, "handler.js"), `
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export default async function handler(input, ctx) {
  const mutations = [];
  if (ctx.operation === "mutate") {
    const content = String(input?.content ?? "mutated");
    await writeFile(path.join(ctx.targetRoot, "scene-state.txt"), content, "utf8");
    mutations.push({
      path: "scene-state.txt",
      afterHash: createHash("sha256").update(content, "utf8").digest("hex"),
    });
  }
  return {
    contractVersion: 1,
    ok: true,
    providerId: ${JSON.stringify(providerManifest.id)},
    providerHash: ctx.providerHash,
    operation: ctx.operation,
    targetRoot: ctx.targetRoot,
    result: { operation: ctx.operation, source: ${JSON.stringify(providerManifest.scope)} },
    mutations,
    evidence: [],
  };
}
`, "utf8");
}

test("Capability resolves local providers, classifies declared effects, invokes arbitrary targets, and records truth", async (t) => {
  const home = await tempDir("ares-capability-home-");
  const workspace = await tempDir("ares-capability-workspace-");
  const outsideTarget = await tempDir("ares-capability-external-target-");
  t.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(outsideTarget, { recursive: true, force: true }),
  ]));

  await writeProvider(path.join(home, "skills"), "scene_adapter", manifest("user", "fixture/global-scene"));
  await writeProvider(
    path.join(workspace, ".ares", "skills"),
    "scene_adapter",
    manifest("workspace", "fixture/workspace-scene"),
  );

  const snapshot = await scanCapabilityRegistry({ home, workspace });
  const progress = [];
  const controller = new AbortController();
  const ctx = {
    workspace,
    sessionId: "capability-session",
    signal: controller.signal,
    emitProgress: (event) => progress.push(event),
  };
  const tool = makeCapabilityTool({ home, workspace, initialSnapshot: snapshot });

  assert.equal(tool.schema.safety, "read-only", "static safety keeps list/resolve visible in plan mode");
  assert.equal(tool.effectiveSafety({ action: "list" }), "read-only");
  assert.equal(tool.effectiveSafety({ action: "resolve", capability: "scene/inspect" }), "read-only");
  assert.equal(tool.effectiveSafety({ action: "ensure", capability: "scene/render" }), "workspace-write");
  assert.equal(tool.effectiveSafety({ action: "invoke", capability: "scene/inspect" }), "read-only");
  assert.equal(tool.effectiveSafety({ action: "invoke", capability: "scene/mutate" }), "workspace-write");
  assert.equal(tool.effectiveSafety({ action: "invoke", capability: "scene/publish" }), "external-state");
  assert.equal(tool.effectiveSafety({ action: "healthcheck", name: "scene_adapter" }), "read-only");
  assert.equal(tool.effectiveSafety({ action: "invoke", capability: "unknown/future" }), "external-state");

  const resolved = await tool.call({ action: "resolve", capability: "scene/inspect" }, ctx);
  assert.equal(resolved.output.ok, true);
  assert.equal(resolved.output.provider.id, "fixture/workspace-scene");
  assert.equal(resolved.output.provider.scope, "workspace");

  const invoked = await tool.call({
    action: "invoke",
    capability: "scene/mutate",
    target_root: outsideTarget,
    arguments: { content: "owner-selected target" },
  }, ctx);
  const artifact = path.join(outsideTarget, "scene-state.txt");
  assert.equal(invoked.output.ok, true, invoked.output.error);
  assert.equal(invoked.output.targetRoot, outsideTarget);
  assert.deepEqual(invoked.touchedFiles, [artifact]);
  assert.equal(invoked.output.receipt.mutations[0].path, artifact);
  assert.equal(await fs.readFile(artifact, "utf8"), "owner-selected target");
  assert.equal(
    invoked.output.receipt.mutations[0].afterHash,
    createHash("sha256").update("owner-selected target", "utf8").digest("hex"),
  );

  const self = getCapability(await loadSelfModel(home), "skill/scene_adapter");
  assert.equal(self.status, "have");
  assert.equal(self.outcomes.ok, 1);
  assert.equal(self.outcomes.fail, 0);
  assert.equal(progress.some((event) => event.kind === "capability_progress" && event.phase === "completed"), true);

  const health = await tool.call({ action: "healthcheck", name: "scene_adapter" }, ctx);
  assert.equal(health.output.ok, true, health.output.error);
  assert.equal(health.output.operation, "health");
});

test("Capability ensure uses the injected acquisition seam and reports queued work honestly", async (t) => {
  const home = await tempDir("ares-capability-ensure-home-");
  const workspace = await tempDir("ares-capability-ensure-workspace-");
  t.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(workspace, { recursive: true, force: true }),
  ]));

  const requests = [];
  const progress = [];
  const tool = makeCapabilityTool({
    home,
    workspace,
    initialSnapshot: await scanCapabilityRegistry({ home, workspace }),
    ensure: async (request) => {
      requests.push(request);
      return { status: "queued", result: { acquisitionId: "acq_fixture", durable: true } };
    },
  });
  const result = await tool.call({
    action: "ensure",
    capability: "scene/render",
    description: "Render and visually inspect the active scene",
    scope: "workspace",
    target_root: "game",
  }, {
    workspace,
    sessionId: "ensure-session",
    signal: new AbortController().signal,
    emitProgress: (event) => progress.push(event),
  });

  assert.equal(result.output.ok, true);
  assert.equal(result.output.status, "queued", "a callback result is not proof that a provider already exists");
  assert.equal(result.output.provider, null);
  assert.deepEqual(result.output.acquisition, { acquisitionId: "acq_fixture", durable: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].capability, "scene/render");
  assert.equal(requests[0].targetRoot, "game");
  assert.deepEqual(progress.map((event) => event.phase), ["acquiring", "queued"]);
});

test("plan mode admits Capability observations but never starts ensure or mutation work", async (t) => {
  const home = await tempDir("ares-capability-plan-home-");
  const workspace = await tempDir("ares-capability-plan-workspace-");
  const target = await tempDir("ares-capability-plan-target-");
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  t.after(() => {
    store.close();
    return Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(target, { recursive: true, force: true }),
    ]);
  });

  await writeProvider(
    path.join(workspace, ".ares", "skills"),
    "scene_adapter",
    manifest("workspace", "fixture/plan-scene"),
  );
  let ensureCalls = 0;
  const raw = makeCapabilityTool({
    home,
    workspace,
    initialSnapshot: await scanCapabilityRegistry({ home, workspace }),
    ensure: async () => {
      ensureCalls += 1;
      return { status: "queued", result: { id: "must-not-run-in-plan" } };
    },
  });
  const adapted = adaptToolForEngine(raw, (base) => ({
    ...base,
    permissionMode: "plan",
    fileReadStamps: base.fileReadStamps ?? new Map(),
  }));

  const runPlanCall = async (id, input) => {
    const session = new Session({
      sessionId: id,
      workspace,
      provider: toolThenDoneProvider(input),
      model: "mock",
      systemPrompt: "test",
      tools: [adapted],
      sessionKernel: store,
      contextBudgetTokens: 0,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: home,
    });
    session.setWorkflowMode("plan");
    await drain(session.send("exercise capability boundary"));
  };

  await runPlanCall("cap-plan-list", { action: "list" });
  await runPlanCall("cap-plan-health", { action: "healthcheck", capability: "scene/inspect", target_root: target });
  await runPlanCall("cap-plan-inspect", { action: "invoke", capability: "scene/inspect", target_root: target });
  await runPlanCall("cap-plan-mutate", {
    action: "invoke",
    capability: "scene/mutate",
    target_root: target,
    arguments: { content: "forbidden in plan" },
  });
  await runPlanCall("cap-plan-ensure", { action: "ensure", capability: "scene/future", target_root: target });

  assert.equal(store.listToolRuns("cap-plan-list")[0]?.executionState, "succeeded");
  assert.equal(store.listToolRuns("cap-plan-health")[0]?.effectKind, "read-only");
  assert.equal(store.listToolRuns("cap-plan-health")[0]?.executionState, "succeeded");
  assert.equal(store.listToolRuns("cap-plan-inspect")[0]?.effectKind, "read-only");
  assert.equal(store.listToolRuns("cap-plan-inspect")[0]?.executionState, "succeeded");
  assert.equal(store.listToolRuns("cap-plan-mutate").length, 0, "mutation never crosses durable admission");
  assert.equal(store.listToolRuns("cap-plan-ensure").length, 0, "acquisition worker never starts before approved build handoff");
  assert.equal(ensureCalls, 0);
  assert.equal(await fs.access(path.join(target, "scene-state.txt")).then(() => true, () => false), false);
});
