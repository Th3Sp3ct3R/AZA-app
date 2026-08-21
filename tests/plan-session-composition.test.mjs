import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MockEchoProvider,
  runFleet,
  scopeSubagentTools,
  Session,
  SessionKernelStore,
} from "../packages/core/dist/index.js";
import { scopeOperatorWorkerTools } from "../packages/operator/dist/index.js";
import {
  makeEnterPlanModeTool,
  makeExitPlanModeTool,
  makeUpdatePlanDraftTool,
} from "../packages/tools/dist/index.js";
import {
  scopeChildEngineTools,
} from "../packages/cli/dist/entry/engineTools.js";
import { SessionPlanModeRegistry } from "../packages/cli/dist/entry/sessionPlanModes.js";

function context(sessionId, requestPermission) {
  return {
    workspace: process.cwd(),
    sessionId,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
    requestPermission,
  };
}

function engineTool(name, safety = "read-only") {
  return {
    schema: {
      name,
      description: name,
      inputJsonSchema: { type: "object", properties: {} },
      safety,
      concurrency: "parallel-safe",
    },
    async call() {
      return { output: null };
    },
  };
}

test("Garrison plan transitions are isolated and persisted by each canonical Session", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-plan-session-scope-"));
  const kernel = await SessionKernelStore.open({ filename: path.join(workspace, "sessions.sqlite") });
  try {
    const sessions = new Map();
    for (const id of ["garrison-a", "garrison-b"]) {
      sessions.set(id, new Session({
        sessionId: id,
        workspace,
        provider: new MockEchoProvider(),
        model: "mock",
        systemPrompt: `prompt:${id}:workspace-write`,
        tools: [],
        sessionKernel: kernel,
        telemetryDir: path.join(workspace, "telemetry"),
        sessionRegistryHome: workspace,
      }));
    }

    const prompts = [];
    const registry = new SessionPlanModeRegistry({
      kernel,
      defaultPermissionMode: "workspace-write",
      sessionFor: (id) => sessions.get(id),
      systemPromptFor: (mode, id) => {
        prompts.push([id, mode]);
        return `prompt:${id}:${mode}`;
      },
    });
    const resolve = ({ sessionId }) => registry.stateFor(sessionId);

    await makeEnterPlanModeTool(resolve).call(
      { reason: "design first" },
      context("garrison-a"),
    );

    assert.equal(registry.stateFor("garrison-a").permissionMode, "plan");
    assert.equal(registry.stateFor("garrison-b").permissionMode, "workspace-write");
    assert.equal(kernel.requireSession("garrison-a").workflowMode, "plan");
    assert.equal(kernel.requireSession("garrison-b").workflowMode, "build");

    const body = "# Build A\n\n1. inspect\n2. implement\n3. verify";
    await makeUpdatePlanDraftTool(resolve).call(
      { plan: body },
      context("garrison-a"),
    );
    const result = await makeExitPlanModeTool(resolve).call(
      {},
      context("garrison-a", async () => "allow_once"),
    );

    assert.equal(result.output.approved, true);
    assert.equal(kernel.requireSession("garrison-a").workflowMode, "build");
    assert.equal(kernel.getActivePlan("garrison-a")?.body, body);
    assert.equal(kernel.getActivePlan("garrison-a")?.status, "approved");
    assert.equal(kernel.getActivePlan("garrison-b"), null);
    assert.equal(registry.stateFor("garrison-b").permissionMode, "workspace-write");
    assert.deepEqual(prompts, [
      ["garrison-a", "plan"],
      ["garrison-a", "workspace-write"],
    ]);
  } finally {
    kernel.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Task and Operator child scopes strip owner plan transitions", () => {
  const tools = [
    engineTool("Read"),
    engineTool("EnterPlanMode"),
    engineTool("UpdatePlanDraft", "workspace-write"),
    engineTool("ExitPlanMode"),
    engineTool("Task", "workspace-write"),
  ];

  assert.deepEqual(
    scopeChildEngineTools(tools).map((tool) => tool.schema.name),
    ["Read", "Task"],
  );
  assert.deepEqual(
    scopeSubagentTools(tools).map((tool) => tool.schema.name),
    ["Read", "Task"],
  );
  assert.deepEqual(
    scopeOperatorWorkerTools(tools).map((tool) => tool.schema.name),
    ["Read", "Task"],
  );
  assert.deepEqual(
    tools.map((tool) => tool.schema.name),
    ["Read", "EnterPlanMode", "UpdatePlanDraft", "ExitPlanMode", "Task"],
    "scoping must not remove transitions from the owner-facing catalog",
  );
});

test("Conductor leaves never inherit plan-transition tools from a full catalog", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-plan-conductor-scope-"));
  const calls = [];
  try {
    await runFleet(
      {
        phases: [{
          id: "inspect",
          kind: "parallel",
          agents: [{ role: "reader", prompt: "inspect" }],
        }],
      },
      {
        provider: { name: "mock", async *stream() {} },
        model: "mock",
        parentTools: [
          engineTool("Read"),
          engineTool("EnterPlanMode"),
          engineTool("UpdatePlanDraft", "workspace-write"),
          engineTool("ExitPlanMode"),
        ],
        baseSystemPrompt: "base",
        workspace,
        signal: new AbortController().signal,
        defaultMaxTurns: 2,
        validate: (_shape, value) => ({ ok: true, value }),
        schemaHint: (shape) => JSON.stringify(shape),
        runAgent: async (args) => {
          calls.push(args.tools.map((tool) => tool.schema.name));
          return {
            finalText: "done",
            events: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            status: "completed",
            workStatus: "not_applicable",
          };
        },
      },
    );

    assert.deepEqual(calls, [["Read"]]);

    await assert.rejects(
      runFleet(
        {
          phases: [{
            id: "escape",
            kind: "parallel",
            agents: [{ role: "planner", prompt: "escape", tools: ["EnterPlanMode"] }],
          }],
        },
        {
          provider: { name: "mock", async *stream() {} },
          model: "mock",
          parentTools: [engineTool("EnterPlanMode")],
          baseSystemPrompt: "base",
          workspace,
          signal: new AbortController().signal,
          validate: (_shape, value) => ({ ok: true, value }),
          schemaHint: (shape) => JSON.stringify(shape),
          runAgent: async () => {
            throw new Error("forbidden leaf must not run");
          },
        },
      ),
      /owner\/control-plane capability/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
