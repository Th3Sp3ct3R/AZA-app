// OpenRouter provider — streaming chat completions: text, tool calls, usage,
// message assembly, and request-body translation from Anthropic-shaped input.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DeepSeekProvider,
  OpenRouterProvider,
  fetchDeepSeekModels,
  fetchOpenRouterModels,
} from "../packages/core/dist/index.js";

function sse(lines) {
  const body = lines.map((l) => (l === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(l)}\n\n`)).join("");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("OpenRouter: streams text deltas and assembles a message", async () => {
  const fetchImpl = async () => sse([
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 10, completion_tokens: 2 } },
    "[DONE]",
  ]);
  const p = new OpenRouterProvider({ apiKey: "k", model: "x/y", fetchImpl });
  const events = [];
  for await (const e of p.stream({ model: "x/y", system: "s", messages: [], tools: [] })) events.push(e);
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
  assert.equal(text, "Hello");
  const done = events.at(-1);
  assert.equal(done.type, "message_done");
  assert.equal(done.message.content[0].text, "Hello");
  assert.equal(done.usage.inputTokens, 10);
  assert.equal(done.usage.outputTokens, 2);
  assert.equal(done.stopReason, "end_turn");
});

test("OpenRouter: accumulates streamed tool_calls into a tool_use block", async () => {
  const fetchImpl = async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);
  const p = new OpenRouterProvider({ apiKey: "k", model: "x/y", fetchImpl });
  const events = [];
  for await (const e of p.stream({ model: "x/y", system: "", messages: [], tools: [] })) events.push(e);
  assert.ok(events.some((e) => e.type === "tool_use_start" && e.name === "read_file"));
  const doneInput = events.find((e) => e.type === "tool_use_input_done");
  assert.deepEqual(doneInput.input, { path: "a.ts" });
  const done = events.at(-1);
  assert.equal(done.stopReason, "tool_use");
  const block = done.message.content.find((b) => b.type === "tool_use");
  assert.equal(block.name, "read_file");
  assert.deepEqual(block.input, { path: "a.ts" });
});

test("OpenRouter: sends Bearer auth + translates tool_result to role:tool", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
  };
  const p = new OpenRouterProvider({ apiKey: "sk-test", model: "anthropic/claude", fetchImpl });
  const messages = [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "now" },
    { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ls", input: {} }], createdAt: "now" },
    { id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "files" }], createdAt: "now" },
  ];
  for await (const _ of p.stream({ model: "anthropic/claude", system: "sys", messages, tools: [] })) { /* drain */ }
  assert.match(captured.url, /\/chat\/completions$/);
  assert.equal(captured.headers.Authorization, "Bearer sk-test");
  assert.equal(captured.body.messages[0].role, "system");
  const toolMsg = captured.body.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "t1");
  assert.equal(toolMsg.content, "files");
  const asst = captured.body.messages.find((m) => m.role === "assistant");
  assert.equal(asst.tool_calls[0].function.name, "ls");
});

test("OpenRouter: forwards act-first tool forcing to the wire", async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
  };
  const provider = new OpenRouterProvider({ apiKey: "k", model: "x/y", fetchImpl });
  for await (const _ of provider.stream({
    model: "x/y",
    system: "",
    messages: [],
    tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
    toolChoice: "any",
  })) { /* drain */ }
  assert.equal(body.tool_choice, "required");
});

test("OpenRouter: replays reasoning with a valid tool-call chain", async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
  };
  const p = new OpenRouterProvider({ apiKey: "k", model: "deepseek/example", fetchImpl });
  const messages = [
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", text: "need the file first" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ],
      createdAt: "now",
    },
    {
      id: "u1",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "source" }],
      createdAt: "now",
    },
  ];
  for await (const _ of p.stream({ model: "deepseek/example", system: "", messages, tools: [] })) { /* drain */ }
  const assistant = captured.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.reasoning, "need the file first");
  assert.equal(assistant.content, "");
  assert.equal(assistant.tool_calls[0].id, "t1");
  assert.equal(captured.messages.find((message) => message.role === "tool").tool_call_id, "t1");
});

test("OpenRouter: downgrades orphan tool results instead of sending invalid role:tool history", async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
  };
  const p = new OpenRouterProvider({ apiKey: "k", model: "x/y", fetchImpl });
  const messages = [
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "tool_use", id: "missing", name: "Read", input: { file_path: "a.ts" } }],
      createdAt: "now",
    },
    {
      id: "u1",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "orphan", content: "old result" }],
      createdAt: "now",
    },
  ];
  for await (const _ of p.stream({ model: "x/y", system: "", messages, tools: [] })) { /* drain */ }
  assert.equal(captured.messages.some((message) => message.role === "tool"), false);
  const assistant = captured.messages.find((message) => message.role === "assistant");
  assert.equal(Object.hasOwn(assistant, "tool_calls"), false);
  assert.ok(captured.messages.some((message) => message.role === "user" && String(message.content).includes("Retained tool result orphan")));
});

test("OpenRouter: surfaces HTTP errors as an error event", async () => {
  const fetchImpl = async () => new Response("bad key", { status: 401 });
  const p = new OpenRouterProvider({ apiKey: "k", model: "x/y", fetchImpl });
  const events = [];
  for await (const e of p.stream({ model: "x/y", system: "", messages: [], tools: [] })) events.push(e);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "http_401");
});

test("OpenRouter: missing key yields a no_auth error", async () => {
  const p = new OpenRouterProvider({ apiKey: "", model: "x/y" });
  const events = [];
  for await (const e of p.stream({ model: "x/y", system: "", messages: [], tools: [] })) events.push(e);
  assert.equal(events[0].error.code, "no_auth");
});

test("fetchOpenRouterModels parses the public catalog", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    data: [
      {
        id: "anthropic/claude-opus-4",
        name: "Claude Opus 4",
        context_length: 200000,
        pricing: { prompt: "0.000015" },
        supported_parameters: ["tools", "reasoning"],
      },
      { id: "openai/gpt-5", name: "GPT-5", context_length: 400000 },
    ],
  }), { status: 200 });
  const models = await fetchOpenRouterModels({ fetchImpl });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "anthropic/claude-opus-4");
  assert.equal(models[0].contextLength, 200000);
  assert.equal(models[0].promptPrice, "0.000015");
  assert.deepEqual(models[0].supportedParameters, ["tools", "reasoning"]);
});

test("DeepSeek: sends V4 thinking controls and replays reasoning_content with tool calls", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    return sse([
      { choices: [{ delta: { reasoning_content: "checking" } }] },
      { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  };
  const provider = new DeepSeekProvider({ apiKey: "ds-key", model: "deepseek-v4-pro", fetchImpl });
  const messages = [
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", text: "need file" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ],
      createdAt: "now",
    },
    {
      id: "u1",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file text" }],
      createdAt: "now",
    },
  ];
  const events = [];
  for await (const event of provider.stream({
    model: "deepseek-v4-pro",
    system: "sys",
    messages,
    tools: [],
    reasoningLevel: "max",
  })) events.push(event);

  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.equal(captured.headers.Authorization, "Bearer ds-key");
  assert.deepEqual(captured.body.thinking, { type: "enabled" });
  assert.equal(captured.body.reasoning_effort, "max");
  const assistant = captured.body.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.reasoning_content, "need file");
  assert.equal(assistant.content, "");
  assert.equal(events.find((event) => event.type === "thinking_delta").text, "checking");
  const done = events.at(-1);
  assert.equal(done.message.content[0].type, "thinking");
  assert.equal(done.message.content[0].text, "checking");
});

test("fetchDeepSeekModels uses bearer auth and parses the enabled catalog", async () => {
  let authorization = "";
  const fetchImpl = async (_url, init) => {
    authorization = init.headers.Authorization;
    return new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
        { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
      ],
    }), { status: 200 });
  };
  const models = await fetchDeepSeekModels({ apiKey: "ds-key", fetchImpl });
  assert.equal(authorization, "Bearer ds-key");
  assert.deepEqual(models.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
});
