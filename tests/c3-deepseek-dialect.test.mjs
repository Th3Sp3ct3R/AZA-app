// C3 — DeepSeek dialect on AnthropicProvider (ultra-coding Phase 0).
//
// Routing DeepSeek through the hardened /anthropic endpoint requires three wire
// differences vs genuine Anthropic, all gated on dialect:"deepseek":
//   1. echo UNSIGNED thinking blocks (DeepSeek 400s a tool loop without the
//      reasoning echo) — while genuine Anthropic must still DROP unsigned thinking;
//   2. send NO cache_control (DeepSeek ignores it; auto KV-caches server-side);
//   3. thinking:{type:"enabled"} with NO budget_tokens and NO max_tokens inflation.
// These tests lock all three in, plus the load-bearing negative (anthropic drops).

import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../packages/core/dist/index.js";

function streamFrom(s) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(s)); c.close(); } });
}
function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}
const MIN_SSE = [
  sse("message_start", { message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }),
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
  sse("message_stop", {}),
].join("");

function captureFetch(captured) {
  return async (url, init) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body);
    return new Response(streamFrom(MIN_SSE), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

// A request whose history carries an UNSIGNED thinking block paired with a tool loop.
function reqWithUnsignedThinking(model) {
  return {
    model,
    system: "SYSTEM PROMPT",
    reasoningLevel: "medium",
    tools: [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } }],
    signal: new AbortController().signal,
    messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "build it" }], createdAt: "now" },
      { id: "a1", role: "assistant", content: [
        { type: "thinking", text: "let me reason" }, // UNSIGNED
        { type: "tool_use", id: "t1", name: "Read", input: {} },
      ], createdAt: "now" },
      { id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }], createdAt: "now" },
      { id: "u3", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "now" },
    ],
  };
}

async function drive(provider, req) {
  for await (const _ of provider.stream(req)) { /* exhaust so fetch fires */ }
}

function assistantThinkingBlocks(body) {
  const a = body.messages.find((m) => m.role === "assistant");
  return (a?.content ?? []).filter((b) => b.type === "thinking");
}

test("C3: DeepSeek dialect echoes UNSIGNED thinking on a tool loop", async () => {
  const captured = {};
  const provider = new AnthropicProvider({
    apiKey: "sk-deepseek-test",
    endpointUrl: "https://api.deepseek.com/anthropic",
    dialect: "deepseek",
    fetchImpl: captureFetch(captured),
  });
  await drive(provider, reqWithUnsignedThinking("deepseek-v4-flash"));

  const thinking = assistantThinkingBlocks(captured.body);
  assert.equal(thinking.length, 1, "unsigned thinking must be echoed for DeepSeek");
  assert.equal(thinking[0].thinking, "let me reason");
  assert.equal(Object.hasOwn(thinking[0], "signature"), false, "echoed DeepSeek thinking carries no signature");
  assert.equal(captured.url, "https://api.deepseek.com/anthropic");
  assert.equal(captured.headers["x-api-key"], "sk-deepseek-test");
});

test("C3: genuine Anthropic STILL drops unsigned thinking (load-bearing negative)", async () => {
  const captured = {};
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    fetchImpl: captureFetch(captured),
  });
  await drive(provider, reqWithUnsignedThinking("claude-sonnet-4-6"));

  assert.equal(assistantThinkingBlocks(captured.body).length, 0, "Anthropic must drop unsigned thinking");
});

test("C3: DeepSeek dialect sends NO cache_control anywhere", async () => {
  const captured = {};
  const provider = new AnthropicProvider({
    apiKey: "sk-deepseek-test",
    endpointUrl: "https://api.deepseek.com/anthropic",
    dialect: "deepseek",
    fetchImpl: captureFetch(captured),
  });
  await drive(provider, reqWithUnsignedThinking("deepseek-v4-flash"));
  assert.equal(JSON.stringify(captured.body).includes("cache_control"), false, "no cache_control for DeepSeek");
});

test("C3: DeepSeek dialect enables thinking without budget_tokens and does NOT inflate max_tokens", async () => {
  const captured = {};
  const provider = new AnthropicProvider({
    apiKey: "sk-deepseek-test",
    endpointUrl: "https://api.deepseek.com/anthropic",
    dialect: "deepseek",
    fetchImpl: captureFetch(captured),
  });
  await drive(provider, reqWithUnsignedThinking("deepseek-v4-flash"));
  assert.deepEqual(captured.body.thinking, { type: "enabled" });
  assert.deepEqual(captured.body.output_config, { effort: "high" });
  assert.equal(captured.body.max_tokens, 8192, "max_tokens stays at the default, not budget-inflated");
  // No Claude-Code identity block leaks on the x-api-key path.
  assert.equal(captured.body.system[0].text, "SYSTEM PROMPT");
});

test("C3: DeepSeek Off explicitly disables its default-on thinking mode", async () => {
  const captured = {};
  const provider = new AnthropicProvider({
    apiKey: "sk-deepseek-test",
    endpointUrl: "https://api.deepseek.com/anthropic",
    dialect: "deepseek",
    fetchImpl: captureFetch(captured),
  });
  const req = reqWithUnsignedThinking("deepseek-v4-flash");
  req.reasoningLevel = "off";
  await drive(provider, req);
  assert.deepEqual(captured.body.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(captured.body, "output_config"), false);
});
