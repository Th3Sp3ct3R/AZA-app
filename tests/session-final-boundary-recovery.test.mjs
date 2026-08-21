import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSessionSnapshot, Session, SessionKernelStore } from "../packages/core/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

function finalProvider(counter) {
  return {
    name: "final-boundary-provider",
    async *stream(request) {
      counter.calls += 1;
      counter.requests.push(request);
      yield {
        type: "message_done",
        message: {
          id: `final_reply_${counter.calls}`,
          role: "assistant",
          content: [{ type: "text", text: `finished ${counter.calls}` }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

test("restart after final message_done auto-drains the runnable input without manual resume", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-final-boundary-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const counter = { calls: 0, requests: [] };
    const provider = finalProvider(counter);
    const first = new Session({
      sessionId: "final-boundary",
      workspace,
      provider,
      model: "mock",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const stream = first.sendContent([{ type: "text", text: "finish safely" }], { inputId: "final-input" });
    for (;;) {
      const next = await stream.next();
      assert.equal(next.done, false);
      if (next.value.type === "message_done") break;
    }
    // Simulate process death at the exact model-boundary window: the provider
    // response exists, but the harness has not exposed/committed turn_end.
    await stream.return(undefined);
    assert.equal(store.listInputs("final-boundary")[0]?.state, "admitted");

    const snapshot = await loadSessionSnapshot(workspace, "final-boundary", { maxMessages: 10_000 });
    const restarted = new Session({
      workspace,
      provider,
      model: "mock",
      systemPrompt: "test",
      tools: [],
      sessionMeta: snapshot.meta,
      initialMessages: snapshot.messages,
      initialTodos: snapshot.todos,
      initialSeq: snapshot.nextSeq,
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    await restarted.waitForStartupRecovery();
    const manualResumeEvents = [];
    for await (const event of restarted.resumeTurn()) manualResumeEvents.push(event);

    assert.deepEqual(manualResumeEvents, [], "startup coordination already delivered the orphan result");
    assert.equal(store.listInputs("final-boundary")[0]?.state, "consumed");
    assert.equal(store.getDetachedInputResult("final-input")?.executionState, "completed");
    assert.equal(counter.calls, 2, "startup drainer finalizes from an explicit recovery boundary");
    const recoveryRequest = counter.requests.at(-1);
    const recoveryMessages = recoveryRequest.messages.filter((message) =>
      message.content.some((block) => block.type === "system_reminder" && block.text.includes("RECOVERY BOUNDARY"))
    );
    assert.equal(recoveryMessages.length, 1);
    assert.equal(recoveryMessages[0].role, "user");
    const durableRecovery = store.listMessages("final-boundary")
      .find((message) => message.metadata?.source === "session-kernel-recovery");
    assert.equal(durableRecovery?.inputId, "final-input", "recovery remains owned by the original admitted input");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("completed input is consumed before turn_end is exposed to a stopping caller", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-terminal-consume-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const counter = { calls: 0, requests: [] };
    const session = new Session({
      sessionId: "terminal-consume",
      workspace,
      provider: finalProvider(counter),
      model: "mock",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const stream = session.sendContent([{ type: "text", text: "finish once" }], { inputId: "terminal-input" });
    for (;;) {
      const next = await stream.next();
      assert.equal(next.done, false);
      if (next.value.type === "turn_end") break;
    }

    assert.equal(
      store.getInput("terminal-input")?.state,
      "consumed",
      "the durable input commit precedes terminal event exposure",
    );
    await stream.return(undefined);
    assert.equal(store.getInput("terminal-input")?.state, "consumed");

    // An idempotent retry acknowledges the settled admission without calling
    // the provider or creating a second logical request.
    for await (const _ of session.sendContent(
      [{ type: "text", text: "finish once" }],
      { inputId: "terminal-input" },
    )) { /* drain */ }
    assert.equal(counter.calls, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("final-boundary recovery projects a settled tool result without rerunning its effect", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-final-tool-boundary-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const state = { providerCalls: 0, effectCalls: 0, requests: [] };
    const provider = {
      name: "final-tool-boundary-provider",
      async *stream(request) {
        state.providerCalls += 1;
        state.requests.push(request);
        if (state.providerCalls === 1) {
          const use = { type: "tool_use", id: "external-effect-1", name: "ExternalEffect", input: { value: 7 } };
          yield { type: "tool_use_start", id: use.id, name: use.name };
          yield { type: "tool_use_input_done", id: use.id, input: use.input };
          yield {
            type: "message_done",
            message: {
              id: "effect-request",
              role: "assistant",
              content: [use],
              createdAt: new Date().toISOString(),
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        const text = state.providerCalls === 2 ? "effect complete" : "recovery finalized";
        yield {
          type: "message_done",
          message: {
            id: state.providerCalls === 2 ? "effect-final" : "effect-recovery-final",
            role: "assistant",
            content: [{ type: "text", text }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const effectTool = {
      schema: {
        name: "ExternalEffect",
        description: "test-only externally visible effect",
        inputJsonSchema: { type: "object", properties: { value: { type: "number" } } },
        safety: "external-state",
      },
      async call(input) {
        state.effectCalls += 1;
        return { output: { applied: input.value } };
      },
    };
    const first = new Session({
      sessionId: "final-tool-boundary",
      workspace,
      provider,
      model: "mock",
      systemPrompt: "test",
      tools: [effectTool],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const stream = first.sendContent([{ type: "text", text: "apply exactly once" }], { inputId: "effect-input" });
    for (;;) {
      const next = await stream.next();
      assert.equal(next.done, false);
      if (
        next.value.type === "message_done" &&
        next.value.message.content.some((block) => block.type === "text" && block.text === "effect complete")
      ) break;
    }
    await stream.return(undefined);
    assert.equal(state.effectCalls, 1);
    assert.equal(store.getInput("effect-input")?.state, "admitted");

    const snapshot = await loadSessionSnapshot(workspace, "final-tool-boundary", { maxMessages: 10_000 });
    const restarted = new Session({
      workspace,
      provider,
      model: "mock",
      systemPrompt: "test",
      tools: [effectTool],
      sessionMeta: snapshot.meta,
      initialMessages: snapshot.messages,
      initialTodos: snapshot.todos,
      initialSeq: snapshot.nextSeq,
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    for await (const _ of restarted.resumeTurn()) { /* drain */ }

    assert.equal(state.providerCalls, 3);
    assert.equal(state.effectCalls, 1, "a settled external effect must never execute during boundary recovery");
    assert.equal(store.getInput("effect-input")?.state, "consumed");
    const recoveryRequest = state.requests.at(-1);
    const recoveredBlocks = recoveryRequest.messages.flatMap((message) => message.content);
    assert.equal(recoveredBlocks.filter((block) => block.type === "tool_use" && block.id === "external-effect-1").length, 1);
    assert.equal(recoveredBlocks.filter((block) => block.type === "tool_result" && block.tool_use_id === "external-effect-1").length, 1);
    assert.equal(
      recoveredBlocks.filter((block) => block.type === "system_reminder" && block.text.includes("RECOVERY BOUNDARY")).length,
      1,
    );
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
