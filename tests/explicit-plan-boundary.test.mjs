import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Session, SessionKernelStore } from "../packages/core/dist/index.js";
import {
  makeEnterPlanModeTool,
  makeExitPlanModeTool,
  makeUpdatePlanDraftTool,
  WriteTool,
  adaptToolForEngine,
} from "../packages/tools/dist/index.js";
import { SessionPlanModeRegistry } from "../packages/cli/dist/entry/sessionPlanModes.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

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

function codingProvider(requests) {
  return {
    name: "coding-turn-provider",
    async *stream(request) {
      requests.push(request);
      yield {
        type: "message_done",
        message: {
          id: `reply-${requests.length}`,
          role: "assistant",
          content: [{ type: "text", text: "Ready to implement." }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

test("coding language stays in build mode; only the explicit durable plan transition enters talk-only mode", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-explicit-plan-boundary-"));
  const kernel = new SessionKernelStore(new BetterSqlite3(":memory:"));
  const requests = [];
  const sessionId = "explicit-plan-boundary";
  try {
    const session = new Session({
      sessionId,
      workspace,
      provider: codingProvider(requests),
      model: "mock",
      systemPrompt: "Build when asked; plan only through the explicit transition.",
      tools: [],
      sessionKernel: kernel,
      contextBudgetTokens: 0,
    });
    const registry = new SessionPlanModeRegistry({
      kernel,
      defaultPermissionMode: "workspace-write",
      sessionFor: (id) => id === sessionId ? session : undefined,
      systemPromptFor: (mode) => `mode:${mode}`,
    });
    const resolve = ({ sessionId: id }) => registry.stateFor(id);

    for await (const _ of session.sendContent([
      { type: "text", text: "Implement the feature, edit the code, and run the build now." },
    ])) { /* drain */ }

    assert.equal(requests.length, 1);
    assert.equal(kernel.requireSession(sessionId).workflowMode, "build");
    assert.equal(kernel.getActivePlan(sessionId), null);
    assert.equal(registry.stateFor(sessionId).permissionMode, "workspace-write");

    await makeEnterPlanModeTool(resolve).call(
      { reason: "The owner explicitly requested a planning conversation." },
      context(sessionId),
    );
    assert.equal(kernel.requireSession(sessionId).workflowMode, "plan");
    assert.equal(kernel.getActivePlan(sessionId)?.status, "draft");

    const exactPlan = "# Exact plan\n\n1. Inspect\n2. Implement\n3. Verify";
    await makeUpdatePlanDraftTool(resolve).call({ plan: exactPlan }, context(sessionId));
    const held = await makeExitPlanModeTool(resolve).call({}, context(sessionId));
    assert.equal(held.output.approved, false);
    assert.equal(kernel.requireSession(sessionId).workflowMode, "plan");
    assert.equal(kernel.getActivePlan(sessionId)?.status, "awaiting_approval");

    const forbiddenPath = path.join(workspace, "must-not-write-before-approval.txt");
    const write = adaptToolForEngine(WriteTool, (base) => ({
      ...base,
      permissionMode: registry.stateFor(sessionId).permissionMode,
      fileReadStamps: new Map(),
    }));
    await assert.rejects(
      write.call(
        { file_path: forbiddenPath, content: "not yet\n" },
        {
          workspace,
          sessionId,
          signal: new AbortController().signal,
        },
      ),
      /disabled in plan mode/,
    );
    assert.equal(
      await stat(forbiddenPath).then(() => false, (error) => error?.code === "ENOENT"),
      true,
      "plan mode must remain talk-only until the owner approves the exact revision",
    );

    const approved = await makeExitPlanModeTool(resolve).call(
      {},
      context(sessionId, async () => "allow_once"),
    );
    assert.equal(approved.output.approved, true);
    assert.equal(kernel.requireSession(sessionId).workflowMode, "build");
    assert.equal(kernel.getActivePlan(sessionId)?.status, "approved");
  } finally {
    kernel.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
