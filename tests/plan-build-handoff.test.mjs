import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  planArtifactPath,
  Session,
  SessionKernelStore,
} from "../packages/core/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

function textProvider(requests, text = "done") {
  return {
    name: "plan-text-provider",
    async *stream(request) {
      requests.push(request);
      yield {
        type: "message_done",
        message: {
          id: `reply-${requests.length}`,
          role: "assistant",
          content: [{ type: "text", text }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function buildProvider(requests) {
  let calls = 0;
  return {
    name: "plan-build-provider",
    async *stream(request) {
      calls += 1;
      requests.push(request);
      if (calls === 1) {
        const use = { type: "tool_use", id: "approved-write-1", name: "ApprovedWrite", input: { value: 1 } };
        yield { type: "tool_use_start", id: use.id, name: use.name };
        yield { type: "tool_use_input_done", id: use.id, input: use.input };
        yield {
          type: "message_done",
          message: {
            id: "approved-write-request",
            role: "assistant",
            content: [use],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: {
          id: "approved-write-finished",
          role: "assistant",
          content: [{ type: "text", text: "approved build started" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function workspaceWriteTool(state, name = "ApprovedWrite") {
  return {
    schema: {
      name,
      description: "test-only workspace mutation",
      inputJsonSchema: { type: "object", properties: { value: { type: "number" } } },
      safety: "workspace-write",
    },
    async call(input) {
      state.calls += 1;
      return { output: { applied: input.value } };
    },
  };
}

test("living plan drafts exist before exit and retain exact revisioned bytes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-living-plan-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const session = new Session({
      sessionId: "living-plan",
      workspace,
      provider: textProvider([]),
      model: "mock",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    session.setWorkflowMode("plan");
    await session.beginPlanDraft("Map the architecture before editing.");

    const initial = store.getActivePlan("living-plan");
    assert.equal(initial?.status, "draft");
    assert.match(initial?.body ?? "", /Map the architecture before editing/);
    assert.ok((await readFile(planArtifactPath(workspace, "living-plan"), "utf8")).endsWith(initial.body));

    const exact = "# Exact living plan\n\n1. inspect\n2. decide\n3. build\n4. verify";
    await session.recordPlanDraft(exact);
    await session.recordPlanDraft(exact);
    const revisions = store.listPlanRevisions("living-plan");
    assert.equal(revisions.length, 2, "identical saves heal the projection without revision churn");
    assert.equal(revisions[0].status, "superseded");
    assert.equal(revisions[1].status, "draft");
    assert.equal(session.activePlanBody(), exact);

    await session.recordPlanProposal(exact);
    assert.equal(store.getActivePlan("living-plan")?.status, "awaiting_approval");
    assert.equal(store.listPlanRevisions("living-plan").length, 2);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("plan refinement rewrites one stable artifact and exact approval is idempotent", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-plan-artifact-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const session = new Session({
      sessionId: "artifact-session",
      workspace,
      provider: textProvider([]),
      model: "mock",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    session.setWorkflowMode("plan");

    const firstBody = "# Plan\n\n1. Inspect\n2. Build";
    await session.recordPlanProposal(firstBody);
    const artifact = planArtifactPath(workspace, "artifact-session");
    const firstPlan = store.getActivePlan("artifact-session");
    assert.equal(firstPlan?.status, "awaiting_approval");
    assert.equal(store.listPlanRevisions("artifact-session").length, 1);
    const firstProjection = await readFile(artifact, "utf8");
    assert.match(firstProjection, new RegExp(`sha256: ${firstPlan.planHash}`));
    assert.ok(firstProjection.endsWith(firstBody), "artifact body is the exact canonical body");

    // Same bytes are an idempotent artifact-heal, not revision churn.
    await session.recordPlanProposal(firstBody);
    assert.equal(store.listPlanRevisions("artifact-session").length, 1);

    const refinedBody = "# Refined plan\n\n1. Inspect boundaries\n2. Build once\n3. Verify";
    await session.recordPlanProposal(refinedBody);
    const revisions = store.listPlanRevisions("artifact-session");
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].status, "superseded");
    assert.equal(revisions[1].status, "awaiting_approval");
    const refinedProjection = await readFile(artifact, "utf8");
    assert.match(refinedProjection, new RegExp(`revision-id: ${JSON.stringify(revisions[1].id)}`));
    assert.match(refinedProjection, new RegExp(`sha256: ${revisions[1].planHash}`));
    assert.ok(refinedProjection.endsWith(refinedBody));
    assert.doesNotMatch(refinedProjection, /1\. Inspect\n2\. Build$/);

    await assert.rejects(session.approvePlan(firstBody), /does not match the active durable revision/);
    await session.approvePlan(refinedBody, "owner");
    await session.approvePlan(refinedBody, "owner-retry");

    assert.equal(store.requireSession("artifact-session").workflowMode, "build");
    assert.equal(store.getActivePlan("artifact-session")?.status, "approved");
    const handoffs = store.listInputs("artifact-session").filter((input) =>
      input.payload?.kind === "approved-plan-build-handoff"
    );
    assert.equal(handoffs.length, 1, "idempotent approval creates one logical handoff");
    assert.equal(store.listEvents("artifact-session", { limit: 10_000 }).filter((event) => event.type === "plan.approved").length, 1);
    assert.equal(store.listEvents("artifact-session", { limit: 10_000 }).filter((event) => event.type === "plan.build_handoff_admitted").length, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("restart receives the approved revision in both durable history and pinned build context", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-plan-restart-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const planBody = "# Approved restart plan\n\n1. Make the exact change\n2. Verify it";
    const initial = new Session({
      sessionId: "restart-plan",
      workspace,
      provider: textProvider([]),
      model: "mock",
      systemPrompt: "base system",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    initial.setWorkflowMode("plan");
    await initial.recordPlanProposal(planBody);
    await initial.approvePlan(planBody);
    const approved = store.getActivePlan("restart-plan");
    assert.equal(approved?.status, "approved");

    const requests = [];
    const effects = { calls: 0 };
    const restarted = new Session({
      sessionId: "restart-plan",
      workspace,
      provider: buildProvider(requests),
      model: "mock",
      systemPrompt: "base system after restart",
      tools: [workspaceWriteTool(effects)],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    for await (const _ of restarted.sendContent(
      [{ type: "text", text: "Build the approved plan now." }],
      { inputId: "build-after-restart" },
    )) { /* drain */ }

    assert.equal(effects.calls, 1);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.match(request.system, /Approved build handoff \(durably pinned until settlement\)/);
      assert.match(request.system, new RegExp(approved.planHash));
      assert.ok(request.system.includes(planBody));
    }
    const firstBlocks = requests[0].messages.flatMap((message) => message.content);
    const handoff = firstBlocks.find((block) =>
      block.type === "system_reminder" && block.text.includes("APPROVED BUILD HANDOFF")
    );
    assert.ok(handoff, "the persisted synthetic handoff is projected before the first build call");
    assert.ok(handoff.text.includes(approved.id));
    assert.ok(handoff.text.includes(approved.planHash));
    assert.ok(handoff.text.includes(planBody));
    const handoffInput = store.listInputs("restart-plan").find((input) =>
      input.payload?.kind === "approved-plan-build-handoff"
    );
    assert.equal(handoffInput?.state, "consumed");
    assert.equal(store.listEvents("restart-plan", { limit: 10_000 }).filter((event) => event.type === "plan.execution_started").length, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an awaiting plan cannot enter build mode or execute a write capability", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-plan-denial-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const requests = [];
    const effects = { calls: 0 };
    const session = new Session({
      sessionId: "denied-plan",
      workspace,
      provider: buildProvider(requests),
      model: "mock",
      systemPrompt: "test",
      tools: [workspaceWriteTool(effects)],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    session.setWorkflowMode("plan");
    await session.recordPlanProposal("# Not approved\n\nNo writes yet.");

    assert.throws(() => session.setWorkflowMode("build"), /without exact approval/);
    for await (const _ of session.sendContent(
      [{ type: "text", text: "Try to write without approval." }],
      { inputId: "denied-write" },
    )) { /* drain */ }

    assert.equal(effects.calls, 0, "the tool implementation never gains effects");
    assert.equal(store.requireSession("denied-plan").workflowMode, "plan");
    assert.equal(store.getActivePlan("denied-plan")?.status, "awaiting_approval");
    assert.equal(store.listEvents("denied-plan", { limit: 10_000 }).filter((event) => event.type === "plan.execution_started").length, 0);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
