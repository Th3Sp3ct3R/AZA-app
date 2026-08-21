import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HookManager,
  Session,
  SessionKernelStore,
} from "../packages/core/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

function toolThenDoneProvider(toolName, input, requests = []) {
  let calls = 0;
  return {
    name: "effect-settlement-provider",
    async *stream(request) {
      calls += 1;
      requests.push(request);
      if (calls === 1) {
        const use = { type: "tool_use", id: "primary-use", name: toolName, input };
        yield { type: "tool_use_start", id: use.id, name: use.name };
        yield { type: "tool_use_input_done", id: use.id, input: use.input };
        yield {
          type: "message_done",
          message: {
            id: "assistant-tool",
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
          id: "assistant-done",
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

function finalProvider(requests = []) {
  return {
    name: "effect-recovery-provider",
    async *stream(request) {
      requests.push(request);
      yield {
        type: "message_done",
        message: {
          id: "recovery-done",
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function drain(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

test("PostToolUse hook is a durable child effect settled before primary exposure", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-post-hook-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const hookCommand = `node -e "require('node:fs').writeFileSync('hook-output.txt','formatted');process.exit(2)"`;
    const hooks = new HookManager([
      { event: "PostToolUse", matcher: "Probe", command: hookCommand },
    ]);
    const requests = [];
    const session = new Session({
      sessionId: "post-hook-session",
      workspace,
      provider: toolThenDoneProvider("Probe", { value: "x" }, requests),
      model: "mock",
      systemPrompt: "test",
      tools: [{
        schema: {
          name: "Probe",
          description: "fixture",
          inputJsonSchema: { type: "object" },
          safety: "read-only",
          concurrency: "parallel-safe",
        },
        async call() {
          return { output: { primary: "committed" } };
        },
      }],
      hookManager: hooks,
      sessionKernel: store,
      contextBudgetTokens: 0,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
    });

    const events = await drain(session.sendContent(
      [{ type: "text", text: "probe" }],
      { inputId: "post-hook-input" },
    ));

    assert.equal(await readFile(path.join(workspace, "hook-output.txt"), "utf8"), "formatted");
    const runs = store.listToolRuns("post-hook-session");
    assert.deepEqual(runs.map((run) => run.toolName), ["Probe", "PostToolUseHook"]);
    assert.equal(runs[0].executionState, "succeeded", "hook failure cannot rewrite committed primary truth");
    assert.equal(runs[1].executionState, "failed");
    assert.equal(runs[1].arguments.primaryToolUseId, "primary-use");
    assert.equal(runs[1].result.exitCode, 2);

    const terminal = events.find((event) => event.type === "tool_end" && event.id === "primary-use");
    assert.ok(terminal, "primary result is exposed only after the hook run settled");
    assert.ok(
      terminal.touchedFiles.some((file) => path.basename(file) === "hook-output.txt"),
      "hook-created files join primary proof accounting",
    );
    assert.ok(
      store.listEvents("post-hook-session", { limit: 200 }).some((event) => event.type === "hook.workspace_observed"),
    );
    const secondRequestText = JSON.stringify(requests[1]?.messages ?? []);
    assert.match(secondRequestText, /PostToolUse hook failures/);
    assert.match(secondRequestText, /do not blindly replay/i);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("external effect reconciler repairs an ambiguous run without invoking the tool", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-external-reconcile-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "external-recovery", workspaceKey: workspace });
    const lease = store.acquireRunnerLease("external-recovery", "crashed-owner", 30_000);
    const fence = {
      sessionId: lease.sessionId,
      generation: lease.generation,
      leaseToken: lease.leaseToken,
    };
    store.appendMessage(fence, {
      id: "external-assistant-message",
      role: "assistant",
      parts: [{
        type: "tool_use",
        data: {
          type: "tool_use",
          id: "remote-use",
          name: "RemoteSend",
          input: { message: "exactly once", requestId: "req-42" },
        },
      }],
    });
    let run = store.beginToolRun(fence, {
      callKey: "1:remote-use",
      toolName: "RemoteSend",
      arguments: { message: "exactly once", requestId: "req-42" },
      effectKind: "external-state",
    });
    run = store.transitionToolRun(fence, run.id, "executing");
    store.transitionToolRun(fence, run.id, "effect_unknown", {
      error: { message: "connection died after request upload" },
    });
    store.releaseRunnerLease(fence, {
      executionState: "failed",
      workOutcome: "blocked",
      error: { message: "simulated crash" },
    });

    let callCount = 0;
    let reconcileCount = 0;
    const requests = [];
    const session = new Session({
      sessionId: "external-recovery",
      workspace,
      provider: finalProvider(requests),
      model: "mock",
      systemPrompt: "test",
      tools: [{
        schema: {
          name: "RemoteSend",
          description: "fixture remote sender",
          inputJsonSchema: { type: "object" },
          safety: "external-state",
          concurrency: "exclusive",
        },
        effectPolicy: {
          retry: "idempotent-with-key",
          reconcilerKey: "fixture.remote-send.v1",
          idempotencyKey(input) {
            return input.requestId;
          },
          async reconcile(request) {
            reconcileCount += 1;
            assert.equal(request.toolUseId, "remote-use");
            assert.equal(request.idempotencyKey, "req-42");
            assert.deepEqual(request.input, { message: "exactly once", requestId: "req-42" });
            return {
              disposition: "applied",
              evidence: { remoteReceipt: "receipt-7" },
              output: { delivered: true, receipt: "receipt-7" },
            };
          },
        },
        async call() {
          callCount += 1;
          return { output: { delivered: true } };
        },
      }],
      sessionKernel: store,
      contextBudgetTokens: 0,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
    });

    await drain(session.sendContent(
      [{ type: "text", text: "continue after recovery" }],
      { inputId: "external-recovery-input" },
    ));

    assert.equal(reconcileCount, 1);
    assert.equal(callCount, 0, "recovery never replays the ambiguous implementation");
    const recovered = store.listToolRuns("external-recovery")[0];
    assert.equal(recovered.executionState, "succeeded");
    assert.equal(recovered.verificationState, "unverified");
    assert.deepEqual(recovered.result, { delivered: true, receipt: "receipt-7" });
    assert.ok(
      store.listEvents("external-recovery", { limit: 200 }).some((event) =>
        event.type === "tool.effect_reconciled" &&
        event.payload.source === "tool-reconciler" &&
        event.payload.reconcilerKey === "fixture.remote-send.v1"
      ),
    );
    assert.match(JSON.stringify(requests[0]?.messages ?? []), /receipt-7/);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("indeterminate reconciliation remains blocked and never becomes retry authority", async () => {
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "indeterminate-effect" });
    const lease = store.acquireRunnerLease("indeterminate-effect", "owner-a", 30_000);
    const fence = { sessionId: lease.sessionId, generation: lease.generation, leaseToken: lease.leaseToken };
    let run = store.beginToolRun(fence, {
      callKey: "1:remote-unknown",
      toolName: "RemoteUnknown",
      arguments: { requestId: "missing-key" },
      effectKind: "external-state",
    });
    run = store.transitionToolRun(fence, run.id, "executing");
    store.transitionToolRun(fence, run.id, "effect_unknown");
    store.reconcileToolRunEffect(fence, run.id, {
      disposition: "diverged",
      evidence: { lookup: "inconclusive" },
      source: "tool-reconciler",
      retryPolicy: "never",
      reconcilerKey: "fixture.unknown.v1",
      reason: "remote service cannot prove request outcome",
    });
    const blocked = store.getToolRun(run.id);
    assert.equal(blocked.executionState, "effect_unknown");
    assert.equal(blocked.verificationState, "blocked");
    assert.match(blocked.error.message, /cannot prove request outcome/);
  } finally {
    store.close();
  }
});
