// v6 context budgeting + chat tuning — proves a long thread can't hard-fail
// with context_length_exceeded, and that interactive chat passes a reasoning
// budget + output cap through to the provider (so a trivial "hi" can't hang
// for minutes on a reasoning model).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { budgetMessages, Session, stringifyModelToolOutput } from "../packages/core/dist/index.js";

function textMsg(role, chars, tag) {
  return {
    id: `m_${tag}`,
    role,
    content: [{ type: "text", text: "x".repeat(chars) }],
    createdAt: new Date().toISOString(),
  };
}

test("budget: oldest messages trim away, the pending message always survives", () => {
  // 12 messages ~1000 tokens each (4000 chars), budget 2500 tokens, no overhead.
  const msgs = Array.from({ length: 12 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 4000, `${i}`));
  const { messages, trimmed } = budgetMessages(msgs, 2500, 0);
  assert.ok(trimmed >= 8, `expected to trim the bulk, trimmed ${trimmed}`);
  assert.equal(messages[messages.length - 1].id, "m_11", "the latest (pending) message must be kept");
});

test("budget: trimming stops at the recent-history floor even over budget", () => {
  // The field failure: a budget below the fixed overhead used to trim history
  // to ONE message, and the model denied instructions from two turns ago.
  // Default minKeep must hold the last 4 messages even when the result is
  // still over budget — a slightly too-big prompt the provider can reject
  // beats a silently erased conversation.
  const msgs = Array.from({ length: 8 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 4000, `${i}`));
  const { messages, trimmed } = budgetMessages(msgs, 100, 50_000);
  assert.equal(messages.length, 4, "the recent-history floor must hold");
  assert.equal(trimmed, 4);
  assert.deepEqual(messages.map((m) => m.id), ["m_4", "m_5", "m_6", "m_7"], "the newest messages survive");
});

test("budget: minKeep=1 is the explicit last resort that shrinks to the pending message", () => {
  // The engine passes 1 only on the FINAL ladder rung, reachable only via a
  // hard context-limit rejection — a genuinely tiny provider window still gets
  // a sendable prompt instead of a hard-failed turn.
  const msgs = Array.from({ length: 8 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 4000, `${i}`));
  const { messages, trimmed } = budgetMessages(msgs, 1200, 0, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "m_7");
  assert.equal(trimmed, 7);
});

test("budget: an under-budget thread is returned untouched", () => {
  const msgs = [textMsg("user", 40, "a"), textMsg("assistant", 40, "b")];
  const { messages, trimmed } = budgetMessages(msgs, 10_000, 0);
  assert.equal(trimmed, 0);
  assert.equal(messages.length, 2);
});

test("budget: never leaves a leading orphan tool_result", () => {
  const msgs = [
    textMsg("user", 4000, "task"),
    { id: "m_call", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "x" } }, { type: "text", text: "x".repeat(3600) }], createdAt: new Date().toISOString() },
    { id: "m_result", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(3600) }], createdAt: new Date().toISOString() },
    textMsg("user", 200, "final"),
  ];
  const { messages } = budgetMessages(msgs, 1500, 0);
  // The kept window must not begin with a tool_result (would orphan into a
  // function_call_output with no preceding call).
  const first = messages[0];
  const leadsWithToolResult = first.role === "user" && first.content[0]?.type === "tool_result";
  assert.equal(leadsWithToolResult, false, "kept window must not start with a tool_result");
  assert.equal(messages[messages.length - 1].id, "m_final");
});

test("chat tuning: reasoningLevel + maxOutputTokens reach the provider", async () => {
  let captured = null;
  const provider = {
    name: "capture",
    async *stream(req) {
      captured = req;
      yield {
        type: "message_done",
        message: { id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-budget-"));
  const session = new Session({
    workspace,
    provider,
    model: "test-model",
    systemPrompt: "s",
    tools: [],
    reasoningLevel: "high",
    maxOutputTokens: 1234,
    contextBudgetTokens: 0,
  });
  // A substantive ask so the adaptive router keeps the configured ceiling — this
  // test verifies the dial PLUMBS THROUGH; the router's downshift logic has its
  // own coverage in reasoning-router.test.mjs.
  for await (const _event of session.send("Refactor the auth module to add a token refresh path and cover it with tests")) {
    void _event;
  }
  assert.ok(captured, "provider should have been called");
  assert.equal(captured.reasoningLevel, "high");
  assert.equal(captured.maxOutputTokens, 1234);
});

test("chat tuning: setReasoningLevel updates the dial live", async () => {
  const levels = [];
  const provider = {
    name: "capture",
    async *stream(req) {
      levels.push(req.reasoningLevel);
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-reason-"));
  const session = new Session({ workspace, provider, model: "m", systemPrompt: "s", tools: [], reasoningLevel: "low", contextBudgetTokens: 0 });
  // Substantive asks so the adaptive router preserves the configured level and
  // this stays a pure plumbing test for setReasoningLevel.
  for await (const _e of session.send("Please implement a debounce utility and unit-test it")) void _e;
  session.setReasoningLevel("max");
  for await (const _e of session.send("Now design a retry policy for the HTTP client with backoff")) void _e;
  assert.deepEqual(levels, ["low", "max"]);
});

test("chat tuning: setProvider updates the live context budget", async () => {
  const captured = [];
  const provider = (name) => ({
    name,
    async *stream(req) {
      captured.push({ name, count: req.messages.length, model: req.model });
      yield {
        type: "message_done",
        message: { id: `a_${name}`, role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  });
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-model-context-"));
  const session = new Session({
    workspace,
    provider: provider("small"),
    model: "small-model",
    systemPrompt: "s",
    tools: [],
    initialMessages: Array.from({ length: 8 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 4_000, `switch_${i}`)),
    contextBudgetTokens: 1_500,
    compactionThresholdTokens: 1_000_000,
  });

  for await (const _event of session.send("one")) void _event;
  await session.setProvider(provider("large"), "large-model", {
    contextBudgetTokens: 100_000,
    compactionThresholdTokens: 1_000_000,
  });
  for await (const _event of session.send("two")) void _event;

  assert.equal(captured[0].name, "small");
  assert.equal(captured[1].name, "large");
  assert.equal(captured[1].model, "large-model");
  assert.ok(captured[1].count > captured[0].count, "larger model budget should restore more history");
});

test("chat tuning: context-limit errors retry with a smaller recent-history window", async () => {
  const callMessageCounts = [];
  const provider = {
    name: "context-limit-on-history",
    async *stream(req) {
      callMessageCounts.push(req.messages.length);
      if (req.messages.length > 1) {
        yield {
          type: "error",
          error: { code: "http_400", message: "prompt too long; exceeded max context length", retriable: false },
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-context-retry-"));
  const oldMessages = Array.from({ length: 10 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 20_000, `old_${i}`));
  const session = new Session({
    workspace,
    provider,
    model: "m",
    systemPrompt: "s",
    tools: [],
    initialMessages: oldMessages,
    contextBudgetTokens: 100_000,
  });

  const events = [];
  for await (const event of session.send("final")) events.push(event);

  assert.ok(callMessageCounts.length > 1, "provider should be retried after context rejection");
  assert.equal(callMessageCounts.at(-1), 1, "final retry should keep only the pending user message");
  assert.equal(events.some((event) => event.type === "error"), false, "transient context errors should not surface as final errors");
  assert.equal(events.at(-1)?.type, "turn_end");
  assert.equal(events.at(-1)?.status, "completed");
});

test("chat tuning: a gateway 413 (Vercel body limit) retries with a smaller window instead of dead-looping", async () => {
  // Regression: the Ares Gateway runs on Vercel, which rejects oversized request
  // bodies with a hard HTTP 413 ("Request Entity Too Large" /
  // "FUNCTION_PAYLOAD_TOO_LARGE") that never says "prompt too long". This error
  // must be recognized as a context-limit condition so the shrink-and-retry loop
  // engages — otherwise every resend ships the same too-large body and 413s
  // forever, locking the session (the "Hi → 413, Hello → 413" report).
  const callMessageCounts = [];
  const provider = {
    name: "gateway-413-on-history",
    async *stream(req) {
      callMessageCounts.push(req.messages.length);
      if (req.messages.length > 1) {
        yield {
          type: "error",
          error: {
            code: "http_413",
            message: "Anthropic returned 413: Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n\ncle1::abc",
            retriable: false,
          },
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-gateway-413-"));
  const oldMessages = Array.from({ length: 10 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 20_000, `old_${i}`));
  const session = new Session({
    workspace,
    provider,
    model: "ares-internal",
    systemPrompt: "s",
    tools: [],
    initialMessages: oldMessages,
    contextBudgetTokens: 100_000,
  });

  const events = [];
  for await (const event of session.send("final")) events.push(event);

  assert.ok(callMessageCounts.length > 1, "a gateway 413 should trigger a retry, not a dead loop");
  assert.equal(callMessageCounts.at(-1), 1, "final retry should shrink to just the pending user message");
  assert.equal(events.some((event) => event.type === "error"), false, "a recoverable 413 should not surface as a final error");
  assert.equal(events.at(-1)?.status, "completed");
});

test("chat tuning: tool results are bounded before entering model context", () => {
  const result = stringifyModelToolOutput("x".repeat(40_000));
  assert.ok(result.length < 25_000, "model-facing tool result should be clipped");
  assert.match(result, /tool result truncated/);
});

test("stall descent: a thinking model that stalls repeatedly cannot erase recent history", async () => {
  // The 2026-08-05 field report: hours into an anthropic/opus chat, the model
  // denied an instruction given two turns earlier. Mechanism: reasoning stalls
  // walked the shrink ladder to rungs BELOW the fixed prompt overhead, where
  // budgetMessages stripped every message but the pending one. The contract
  // now: stall-driven shrink is capped and floored (history survives), and a
  // model producing only reasoning trips the unresponsive breaker instead of
  // descending forever.
  process.env.ARES_STREAM_IDLE_MS = "1000";
  process.env.ARES_THINK_CEILING_MS = "1000";
  try {
    const perCallCounts = [];
    const provider = {
      name: "thinking-staller",
      async *stream(req) {
        perCallCounts.push(req.messages.length);
        yield { type: "thinking_delta", text: "pondering..." };
        await new Promise((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", resolve, { once: true });
        });
      },
    };
    const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-stall-amnesia-"));
    const session = new Session({
      workspace,
      provider,
      model: "m",
      // A big system prompt puts the fixed overhead ABOVE the old bottom rungs
      // (8k/4k) — the exact geometry that used to produce the lobotomy.
      systemPrompt: "s".repeat(60_000),
      tools: [],
      initialMessages: Array.from({ length: 10 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 400, `hist_${i}`)),
      contextBudgetTokens: 100_000,
    });

    const events = [];
    for await (const event of session.send("and now do the thing I asked about")) events.push(event);

    assert.ok(perCallCounts.length >= 2, `expected retries, saw ${perCallCounts.length} call(s)`);
    for (const count of perCallCounts) {
      assert.ok(count >= 4, `a provider call saw only ${count} message(s) — recent history was erased (calls: ${perCallCounts.join(", ")})`);
    }
    const errors = events.filter((e) => e.type === "error");
    assert.ok(
      errors.some((e) => e.error?.code === "provider_unresponsive"),
      `a thinking-only staller must trip the unresponsive breaker, got: ${errors.map((e) => e.error?.code).join(", ") || "no errors"}`,
    );
  } finally {
    delete process.env.ARES_STREAM_IDLE_MS;
    delete process.env.ARES_THINK_CEILING_MS;
  }
});
