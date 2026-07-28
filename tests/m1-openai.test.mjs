// M1.4 — OpenAI Responses provider, SSE parsing.
//
// We mock fetch with a canned SSE stream and verify the provider emits
// the right StreamEvent sequence for text and function-call paths.

import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIResponsesProvider } from "../packages/core/dist/index.js";

function makeStreamFromString(s) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(s));
      controller.close();
    },
  });
}

function mockFetch(sseBody, status = 200) {
  return async () =>
    new Response(makeStreamFromString(sseBody), {
      status,
      headers: { "content-type": "text/event-stream" },
    });
}

function captureFetch(sseBody, captured, status = 200) {
  return async (_url, init) => {
    captured.body = JSON.parse(init.body);
    return new Response(makeStreamFromString(sseBody), {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

const auth = {
  token: "test-token",
  source: "env:ARES_OPENAI_OAUTH_TOKEN",
  mode: "chatgpt-oauth",
};

test("OpenAIResponsesProvider: parses text_delta and message_done", async () => {
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hel" })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    })}\n\n`,
  ].join("");

  const provider = new OpenAIResponsesProvider({ auth, fetchImpl: mockFetch(sse), endpointUrl: "http://x" });
  const events = [];
  for await (const e of provider.stream({
    model: "gpt-4o",
    system: "you are a test",
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "now" }],
    tools: [],
  })) {
    events.push(e);
  }

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["text_delta", "text_delta", "message_done"]);
  assert.equal(events[0].text, "Hel");
  assert.equal(events[1].text, "lo");

  const done = events.at(-1);
  assert.equal(done.message.role, "assistant");
  assert.equal(done.message.content[0].text, "Hello");
  assert.equal(done.usage.inputTokens, 10);
  assert.equal(done.usage.outputTokens, 2);
  assert.equal(done.stopReason, "end_turn");
});

test("OpenAIResponsesProvider: parses streaming function call", async () => {
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_2" } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "Read" },
    })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      delta: '{"file_p',
    })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      delta: 'ath":"/tmp/x.txt"}',
    })}\n\n`,
    `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_2", status: "completed", usage: { input_tokens: 5, output_tokens: 4 } },
    })}\n\n`,
  ].join("");

  const provider = new OpenAIResponsesProvider({ auth, fetchImpl: mockFetch(sse), endpointUrl: "http://x" });
  const events = [];
  for await (const e of provider.stream({
    model: "gpt-4o",
    system: "test",
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "x" }], createdAt: "now" }],
    tools: [{ name: "Read", description: "read file", input_schema: { type: "object" } }],
  })) {
    events.push(e);
  }

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "tool_use_start",
    "tool_use_input_delta",
    "tool_use_input_delta",
    "tool_use_input_done",
    "message_done",
  ]);

  const done = events.find((e) => e.type === "tool_use_input_done");
  assert.equal(done.id, "call_abc");
  assert.deepEqual(done.input, { file_path: "/tmp/x.txt" });

  const final = events.at(-1);
  const toolUse = final.message.content.find((b) => b.type === "tool_use");
  assert.equal(toolUse.name, "Read");
  assert.deepEqual(toolUse.input, { file_path: "/tmp/x.txt" });
});

test("OpenAIResponsesProvider: serializes function call outputs as top-level Responses input items", async () => {
  const sse = [
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_3", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n\n`,
  ].join("");
  const captured = {};
  const provider = new OpenAIResponsesProvider({
    auth,
    fetchImpl: captureFetch(sse, captured),
    endpointUrl: "http://x",
  });

  const events = [];
  for await (const e of provider.stream({
    model: "gpt-4o",
    system: "test",
    messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "read it" }], createdAt: "now" },
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "tool_use", id: "call_read", name: "Read", input: { file_path: "a.txt" } }],
        createdAt: "now",
      },
      {
        id: "t1",
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "call_read", content: "file contents" }],
        createdAt: "now",
      },
    ],
    tools: [{ name: "Read", description: "read file", input_schema: { type: "object" } }],
  })) {
    events.push(e);
  }

  assert.equal(events.at(-1).type, "message_done");
  assert.equal(captured.body.store, false);
  assert.deepEqual(captured.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }] },
    { type: "function_call", call_id: "call_read", name: "Read", arguments: '{"file_path":"a.txt"}' },
    { type: "function_call_output", call_id: "call_read", output: "file contents" },
  ]);
});

test("OpenAIResponsesProvider: sends prompt_cache_key and image blocks", async () => {
  const sse = [
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_img", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n\n`,
  ].join("");
  const captured = {};
  const provider = new OpenAIResponsesProvider({
    auth,
    fetchImpl: captureFetch(sse, captured),
    endpointUrl: "http://x",
  });

  const req = {
    model: "gpt-4o",
    system: "test",
    messages: [
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
        ],
        createdAt: "now",
      },
    ],
    tools: [{ name: "Read", description: "read file", input_schema: { type: "object" } }],
  };
  const events = [];
  for await (const e of provider.stream(req)) events.push(e);

  assert.equal(events.at(-1).type, "message_done");
  assert.match(captured.body.prompt_cache_key, /^ares:/);
  assert.deepEqual(captured.body.input[0].content, [
    { type: "input_text", text: "inspect" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ]);
});

test("OpenAIResponsesProvider: sends reasoning effort but not unsupported output cap", async () => {
  const sse = [
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_effort", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n\n`,
  ].join("");
  const captured = {};
  const provider = new OpenAIResponsesProvider({
    auth,
    fetchImpl: captureFetch(sse, captured),
    endpointUrl: "http://x",
  });

  const events = [];
  for await (const e of provider.stream({
    model: "gpt-5.5",
    system: "test",
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "now" }],
    tools: [],
    reasoningLevel: "max",
    maxOutputTokens: 1234,
  })) {
    events.push(e);
  }

  assert.equal(events.at(-1).type, "message_done");
  assert.deepEqual(captured.body.reasoning, { effort: "xhigh" });
  assert.equal(Object.hasOwn(captured.body, "max_output_tokens"), false);
});

test("OpenAIResponsesProvider: forwards act-first tool forcing to the wire", async () => {
  const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
  const captured = {};
  const provider = new OpenAIResponsesProvider({ auth, fetchImpl: captureFetch(sse, captured), endpointUrl: "http://x" });
  for await (const _ of provider.stream({
    model: "gpt-5.5",
    system: "test",
    messages: [{ id: "u", role: "user", content: [{ type: "text", text: "act" }], createdAt: "now" }],
    tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
    toolChoice: "any",
  })) { /* drain */ }
  assert.equal(captured.body.tool_choice, "required");
});

test("OpenAIResponsesProvider: emits error event on HTTP failure", async () => {
  const provider = new OpenAIResponsesProvider({
    auth,
    fetchImpl: async () =>
      new Response("rate limit", { status: 429, headers: { "content-type": "text/plain" } }),
    endpointUrl: "http://x",
  });
  const events = [];
  for await (const e of provider.stream({
    model: "gpt-4o",
    system: "test",
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "x" }], createdAt: "now" }],
    tools: [],
  })) {
    events.push(e);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "http_429");
  assert.equal(events[0].error.retriable, true);
});

test("OpenAIResponsesProvider: missing auth → no_auth error", async () => {
  const provider = new OpenAIResponsesProvider({ fetchImpl: async () => new Response("never") });
  // No OAuth env var, no file.
  const prevTok = process.env.ARES_OPENAI_OAUTH_TOKEN;
  const prevHome = process.env.ARES_HOME;
  delete process.env.ARES_OPENAI_OAUTH_TOKEN;
  process.env.ARES_HOME = "/nonexistent/path/ares-test";
  try {
    const events = [];
    for await (const e of provider.stream({
      model: "gpt-5.5",
      system: "x",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "x" }], createdAt: "now" }],
      tools: [],
    })) {
      events.push(e);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(events[0].error.code, "no_auth");
    assert.match(events[0].error.message, /ares login/);
  } finally {
    if (prevTok) process.env.ARES_OPENAI_OAUTH_TOKEN = prevTok;
    if (prevHome) process.env.ARES_HOME = prevHome;
    else delete process.env.ARES_HOME;
  }
});
