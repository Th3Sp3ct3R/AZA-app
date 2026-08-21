// C0 — characterization tests for the core-consolidation effort (feat/core-consolidation).
//
// These pin the load-bearing invariants that the consolidation phases (runForkedTurn,
// memory unification, tool-contract hardening) must NOT regress. They capture CURRENT
// behavior so any drift fails loudly.
//
// COVERAGE MAP (the rest of the invariants are already pinned elsewhere — do not duplicate):
//   - fork read-stamp isolation ............. v24-subagent-read-isolation
//   - UNATTENDED permission gate ............. v16-policy-gate
//   - Anthropic cache-breakpoint placement .. ares-anthropic ("request shape")
//   - orphan tool-pair sanitization ......... ares-anthropic ("orphaned tool blocks…")
//   - OAuth "Claude Code" request contract .. ares-anthropic / v12-anthropic-oauth
//   - JSONL rollout replay + compaction ..... m0-engine + v14-compaction
//   - interrupted multi-tool pairing ........ m0-engine ("interrupted multi-tool turns…")
//
// THIS FILE adds the gap: NORMAL-path (non-interrupted) tool_use<->tool_result pairing
// and ORDERING under parallel execution, plus the mixed success/error case. The engine
// re-orders results to the assistant's tool_use emission order regardless of completion
// order (orderedToolResults); runForkedTurn must preserve this exactly.

import test from "node:test";
import assert from "node:assert/strict";
import { QueryEngine } from "../packages/core/dist/index.js";

const WS = process.platform === "win32" ? "D:\\Ares" : "/tmp";

// A provider that emits the given tool calls on its first stream, then ends the
// turn with plain text on its second stream (after the engine feeds tool_results back).
function toolThenDoneProvider(toolCalls) {
  let calls = 0;
  return {
    name: "c0-provider",
    async *stream() {
      calls += 1;
      if (calls > 1) {
        yield {
          type: "message_done",
          message: {
            id: "asst_done",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
        return;
      }
      for (const t of toolCalls) {
        yield { type: "tool_use_start", id: t.id, name: t.name };
        yield { type: "tool_use_input_done", id: t.id, input: t.input };
      }
      yield {
        type: "message_done",
        message: {
          id: "asst_tools",
          role: "assistant",
          content: toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      };
    },
  };
}

// A parallel-safe read-only tool that sleeps `ms` then echoes `id` — lets us force
// out-of-order COMPLETION while asserting in-order RESULTS.
const slowEcho = {
  schema: {
    name: "SlowEcho",
    description: "sleeps then echoes id",
    inputJsonSchema: { type: "object", properties: {} },
    safety: "read-only",
    concurrency: "parallel-safe",
  },
  async call(input) {
    await new Promise((r) => setTimeout(r, input.ms ?? 0));
    return { output: input.id };
  },
};

// A tool that throws for ids flagged `fail`, succeeds otherwise.
const maybeFail = {
  schema: {
    name: "MaybeFail",
    description: "fails when input.fail is true",
    inputJsonSchema: { type: "object", properties: {} },
    safety: "read-only",
    concurrency: "parallel-safe",
  },
  async call(input) {
    if (input.fail) throw new Error(`boom:${input.id}`);
    return { output: input.id };
  },
};

function lastToolResultMessage(engine) {
  const history = engine.history();
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && m.content.some((b) => b.type === "tool_result")) return m;
  }
  return null;
}

test("C0: parallel tools complete out of order but results pair+order to tool_use emission order", async () => {
  // Emission order a,b,c; completion order will be c,b,a (descending sleeps).
  const calls = [
    { id: "a", name: "SlowEcho", input: { id: "a", ms: 90 } },
    { id: "b", name: "SlowEcho", input: { id: "b", ms: 45 } },
    { id: "c", name: "SlowEcho", input: { id: "c", ms: 5 } },
  ];
  const engine = QueryEngine.forTesting(
    { provider: toolThenDoneProvider(calls), model: "m", systemPrompt: "s", tools: [slowEcho], workspace: WS, maxTurns: 2 },
    "sess_c0_order",
  );
  engine.appendUserMessage("run three");
  for await (const _ of engine.streamTurn()) { /* drain */ }

  const msg = lastToolResultMessage(engine);
  assert.ok(msg, "a user message carrying tool_result blocks must exist");
  const results = msg.content.filter((b) => b.type === "tool_result");

  // Exactly one result per tool_use — no missing, no duplicate, no orphan.
  assert.equal(results.length, 3);
  // Order matches the assistant's tool_use emission order (a,b,c), NOT completion order.
  assert.deepEqual(results.map((r) => r.tool_use_id), ["a", "b", "c"]);
  // Each result is paired to its own call's output and is not an error.
  for (const r of results) {
    assert.equal(r.is_error ?? false, false, `result ${r.tool_use_id} should not be an error`);
    const text = typeof r.content === "string" ? r.content : r.content.map((c) => c.text).join("");
    assert.ok(text.includes(r.tool_use_id), `result ${r.tool_use_id} should echo its id`);
  }
});

test("C0: a failing tool still yields exactly one ordered, error-flagged result alongside successes", async () => {
  const calls = [
    { id: "ok1", name: "MaybeFail", input: { id: "ok1", fail: false } },
    { id: "bad", name: "MaybeFail", input: { id: "bad", fail: true } },
    { id: "ok2", name: "MaybeFail", input: { id: "ok2", fail: false } },
  ];
  const engine = QueryEngine.forTesting(
    { provider: toolThenDoneProvider(calls), model: "m", systemPrompt: "s", tools: [maybeFail], workspace: WS, maxTurns: 2 },
    "sess_c0_mixed",
  );
  engine.appendUserMessage("run mixed");
  for await (const _ of engine.streamTurn()) { /* drain */ }

  const msg = lastToolResultMessage(engine);
  assert.ok(msg);
  const results = msg.content.filter((b) => b.type === "tool_result");

  // Pairing holds across the error: 3 calls -> 3 results, in emission order.
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.tool_use_id), ["ok1", "bad", "ok2"]);
  // Only the failing call is flagged is_error; a sibling's failure never poisons the others.
  assert.equal(results.find((r) => r.tool_use_id === "bad").is_error, true);
  assert.equal(results.find((r) => r.tool_use_id === "ok1").is_error ?? false, false);
  assert.equal(results.find((r) => r.tool_use_id === "ok2").is_error ?? false, false);
});

test("C0: every tool_use block in history has exactly one matching tool_result (no orphans either way)", async () => {
  const calls = [
    { id: "x", name: "SlowEcho", input: { id: "x", ms: 10 } },
    { id: "y", name: "SlowEcho", input: { id: "y", ms: 10 } },
  ];
  const engine = QueryEngine.forTesting(
    { provider: toolThenDoneProvider(calls), model: "m", systemPrompt: "s", tools: [slowEcho], workspace: WS, maxTurns: 2 },
    "sess_c0_orphan",
  );
  engine.appendUserMessage("pair check");
  for await (const _ of engine.streamTurn()) { /* drain */ }

  const history = engine.history();
  const toolUseIds = new Set();
  const toolResultIds = new Set();
  for (const m of history) {
    for (const b of m.content) {
      if (b.type === "tool_use") toolUseIds.add(b.id);
      if (b.type === "tool_result") toolResultIds.add(b.tool_use_id);
    }
  }
  // The Anthropic 400-on-orphan invariant: the tool_use and tool_result id sets are equal.
  assert.deepEqual([...toolUseIds].sort(), [...toolResultIds].sort());
});
