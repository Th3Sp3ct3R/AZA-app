import test from "node:test";
import assert from "node:assert/strict";

import { QueryEngine } from "../packages/core/dist/index.js";

const workspace = process.platform === "win32" ? "D:\\Ares" : "/tmp";

function oneToolProvider(name) {
  let calls = 0;
  return {
    name: "effect-host-test",
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool_use_start", id: "effect-1", name };
        yield { type: "tool_use_input_done", id: "effect-1", input: {} };
        yield {
          type: "message_done",
          message: {
            id: "assistant-effect",
            role: "assistant",
            content: [{ type: "tool_use", id: "effect-1", name, input: {} }],
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

function tool(safety = "workspace-write") {
  return {
    schema: {
      name: "Mutate",
      description: "test mutation",
      inputJsonSchema: { type: "object", properties: {}, additionalProperties: false },
      safety,
      concurrency: "exclusive",
    },
    async call() {
      return { output: "changed", touchedFiles: ["changed.txt"] };
    },
  };
}

test("effectful QueryEngine construction is blocked without a durable host", () => {
  assert.throws(
    () => new QueryEngine({
      provider: oneToolProvider("Mutate"),
      model: "m",
      systemPrompt: "s",
      tools: [tool()],
      workspace,
    }, "bare-effect"),
    /requires a durable Session host/,
  );
});

test("a dynamically effectful tool is blocked before its implementation", async () => {
  let entered = false;
  const dynamic = {
    ...tool("read-only"),
    classifyInput: () => ({ safety: "external-state" }),
    async call() {
      entered = true;
      return { output: "should not run" };
    },
  };
  const engine = new QueryEngine({
    provider: oneToolProvider("Mutate"),
    model: "m",
    systemPrompt: "s",
    tools: [dynamic],
    workspace,
    maxTurns: 2,
  }, "dynamic-effect");
  engine.appendUserMessage("run it");
  await assert.rejects(async () => {
    for await (const _event of engine.streamTurn()) void _event;
  }, /no durable effect host/);
  assert.equal(entered, false);
});

test("hosted QueryEngine settles an effect through both durable barriers", async () => {
  const transitions = [];
  const engine = QueryEngine.hosted({
    provider: oneToolProvider("Mutate"),
    model: "m",
    systemPrompt: "s",
    tools: [tool()],
    workspace,
    maxTurns: 3,
    beforeToolExecution: async ({ toolUseId }) => transitions.push(`before:${toolUseId}`),
    afterToolExecution: async ({ toolUseId, status }) => transitions.push(`after:${toolUseId}:${status}`),
  }, "hosted-effect");
  engine.appendUserMessage("run it");
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  assert.deepEqual(transitions, ["before:effect-1", "after:effect-1:succeeded"]);
  assert.ok(events.some((event) => event.type === "tool_end"));
});
