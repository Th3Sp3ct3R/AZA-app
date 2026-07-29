// M0 smoke test — proves the streaming loop wires end-to-end.
//
// Runs `ares run --goal "ping"` against the mock provider and verifies the
// NDJSON event stream contains turn_start → text_delta(s) → message_done →
// turn_end in order.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { QueryEngine, Session, MockEchoProvider, loadSessionSnapshot } from "../packages/core/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A throwaway workspace: these tests persist REAL session rollouts, and using
// the repo root littered D:\Ares\.ares\sessions with mock sessions every run.
const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ares-m0-ws-"));
const cliEntry = path.join(__dirname, "..", "packages", "cli", "dist", "entry.js");
const testHome = mkdtempSync(path.join(os.tmpdir(), "ares-m0-"));

function runAres(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    encoding: "utf8",
    windowsHide: true,
    cwd: workspaceRoot,
    env: { ...process.env, ARES_HOME: testHome, ARES_AGENT_ENABLED: "0" },
  });
}

test("M0: ares help exits 0 with usage on stdout", () => {
  const r = runAres(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ares v\d+\.\d+\.\d+/); // version-agnostic — help now reads it live from package.json
  assert.match(r.stdout, /autonomous AI agent/);
});

test("M0: ares --help is non-interactive and exits 0", () => {
  const r = runAres(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ares eval coding/);
});

test("M0: ares run --goal emits ordered event stream", () => {
  const r = runAres(["run", "--provider", "mock", "--goal", "ping"]);
  assert.equal(r.status, 0, `ares run failed: ${r.stderr}`);
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 4, `expected >=4 events, got ${lines.length}`);

  const events = lines.map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);

  // First event is turn_start
  assert.equal(types[0], "turn_start");
  // Last event is turn_end with status: completed
  assert.equal(types[types.length - 1], "turn_end");
  assert.equal(events[events.length - 1].status, "completed");

  // Stream contains text_delta and message_done
  assert.ok(types.includes("text_delta"));
  assert.ok(types.includes("message_done"));

  // turn_start carries the user message
  assert.equal(events[0].userMessage.role, "user");

  // message_done carries the assistant message
  const messageDone = events.find((e) => e.type === "message_done");
  assert.equal(messageDone.message.role, "assistant");
  assert.match(messageDone.message.content[0].text, /^echo: ping$/);

  // Echo response is delivered via text_delta chunks
  const textDeltas = events.filter((e) => e.type === "text_delta");
  const joined = textDeltas.map((e) => e.text).join("");
  assert.equal(joined, "echo: ping");
});

test("M0: ares run persists the same ordered rollout stream", async () => {
  const r = runAres(["run", "--provider", "mock", "--goal", "persist me"]);
  assert.equal(r.status, 0, `ares run failed: ${r.stderr}`);
  const sessionId = r.stderr.match(/session=(sess_[^\s]+)/)?.[1];
  assert.ok(sessionId, `missing session id in stderr: ${r.stderr}`);

  const events = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const eventsPath = path.join(workspaceRoot, ".ares", "sessions", sessionId, "events.jsonl");
  const persisted = (await readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

  assert.equal(persisted.length, events.length);
  assert.deepEqual(persisted.map((e) => e.seq), events.map((_e, i) => i));
  assert.deepEqual(persisted.map((e) => e.event.type), events.map((e) => e.type));
});

test("M0: saved sessions can be listed and replayed into messages", async () => {
  const r = runAres(["run", "--provider", "mock", "--goal", "remember this session"]);
  assert.equal(r.status, 0, `ares run failed: ${r.stderr}`);
  const sessionId = r.stderr.match(/session=(sess_[^\s]+)/)?.[1];
  assert.ok(sessionId, `missing session id in stderr: ${r.stderr}`);

  const events = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const snapshot = await loadSessionSnapshot(workspaceRoot, sessionId);
  assert.equal(snapshot.eventCount, events.length);
  assert.equal(snapshot.nextSeq, events.length);
  assert.equal(snapshot.compacted, false);
  assert.equal(snapshot.replayedMessageCount, 2);
  assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant"]);
  assert.match(snapshot.preview, /remember this session/);

  const listed = runAres(["sessions"]);
  assert.equal(listed.status, 0, `ares sessions failed: ${listed.stderr}`);
  assert.match(listed.stdout, /Sessions/);
  assert.ok(listed.stdout.includes(sessionId), `session list did not include ${sessionId}`);
});

test("M0: long session replay compacts older messages", async () => {
  const session = new Session({
    workspace: workspaceRoot,
    provider: new MockEchoProvider(),
    model: "mock-echo",
    systemPrompt: "test",
    tools: [],
  });

  for (let i = 0; i < 6; i++) {
    for await (const _event of session.send(`turn ${i}`)) {
      // Drain the stream so it persists to .ares.
    }
  }

  const full = await loadSessionSnapshot(workspaceRoot, session.meta.id);
  assert.equal(full.compacted, false);
  assert.equal(full.messages.length, 12);

  const compacted = await loadSessionSnapshot(workspaceRoot, session.meta.id, { maxMessages: 5 });
  assert.equal(compacted.compacted, true);
  assert.equal(compacted.messages.length, 5);
  assert.equal(compacted.messages[0].role, "system");
  assert.ok(compacted.omittedMessageCount > 0);
});

test("M0: ares run --goal requires --goal flag", () => {
  const r = runAres(["run", "--provider", "mock"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--goal is required/);
});

test("M0: ares unknown command returns 2", () => {
  const r = runAres(["nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test("M0: permission denial stops the turn instead of re-querying provider", async () => {
  let providerCalls = 0;
  const provider = {
    name: "denial-provider",
    async *stream() {
      providerCalls += 1;
      if (providerCalls > 1) {
        yield { type: "text_delta", text: "should not happen" };
        yield {
          type: "message_done",
          message: {
            id: "assistant_after_denial",
            role: "assistant",
            content: [{ type: "text", text: "should not happen" }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
        return;
      }

      yield { type: "tool_use_start", id: "tool_1", name: "NeedsPermission" };
      yield { type: "tool_use_input_done", id: "tool_1", input: { path: "C:\\outside.txt" } };
      yield {
        type: "message_done",
        message: {
          id: "assistant_tool",
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "NeedsPermission", input: { path: "C:\\outside.txt" } }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      };
    },
  };
  const tool = {
    schema: {
      name: "NeedsPermission",
      description: "Test tool",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "read-only",
      concurrency: "parallel-safe",
    },
    async call() {
      const err = new Error("file_path denied outside workspace: C:\\outside.txt");
      err.name = "PermissionDeniedError";
      throw err;
    },
  };
  const engine = new QueryEngine(
    {
      provider,
      model: "test",
      systemPrompt: "test",
      tools: [tool],
      workspace: workspaceRoot,
      maxTurns: 1,
    },
    "sess_test_denial",
  );

  engine.appendUserMessage("read outside");
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  assert.equal(providerCalls, 1);
  assert.equal(events.at(-1).type, "turn_end");
  assert.equal(events.at(-1).status, "interrupted");
  assert.ok(events.some((event) => event.type === "tool_error" && /denied outside workspace/.test(event.error)));
  assert.equal(events.some((event) => event.type === "text_delta"), false);
});

test("M0: interrupted multi-tool turns record output for every pending tool call", async () => {
  const provider = {
    name: "multi-denial-provider",
    async *stream() {
      yield { type: "tool_use_start", id: "edit_1", name: "Edit" };
      yield { type: "tool_use_input_done", id: "edit_1", input: { file_path: "x.ts" } };
      yield { type: "tool_use_start", id: "write_1", name: "Write" };
      yield { type: "tool_use_input_done", id: "write_1", input: { file_path: "x.ts" } };
      yield {
        type: "message_done",
        message: {
          id: "assistant_tools",
          role: "assistant",
          content: [
            { type: "tool_use", id: "edit_1", name: "Edit", input: { file_path: "x.ts" } },
            { type: "tool_use", id: "write_1", name: "Write", input: { file_path: "x.ts" } },
          ],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      };
    },
  };
  const editTool = {
    schema: {
      name: "Edit",
      description: "denying edit",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call() {
      const err = new Error("permission denied: Edit");
      err.name = "PermissionDeniedError";
      throw err;
    },
  };
  const writeTool = {
    schema: {
      name: "Write",
      description: "skipped write",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call() {
      return { output: "should not run" };
    },
  };
  const engine = new QueryEngine(
    {
      provider,
      model: "test",
      systemPrompt: "test",
      tools: [editTool, writeTool],
      workspace: workspaceRoot,
      maxTurns: 1,
    },
    "sess_test_multi_denial",
  );

  engine.appendUserMessage("use tools");
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  assert.equal(events.at(-1).status, "interrupted");
  const toolResultMessage = engine.history().at(-1);
  assert.equal(toolResultMessage.role, "user");
  assert.equal(toolResultMessage.content.filter((block) => block.type === "tool_result").length, 2);
});

test("M0: workspace-write tools can run without magic write wording", async () => {
  let toolCalls = 0;
  const provider = {
    name: "write-gate-provider",
    async *stream() {
      yield { type: "tool_use_start", id: "edit_1", name: "Edit" };
      yield { type: "tool_use_input_done", id: "edit_1", input: { file_path: "x.ts" } };
      yield {
        type: "message_done",
        message: {
          id: "assistant_tool",
          role: "assistant",
          content: [{ type: "tool_use", id: "edit_1", name: "Edit", input: { file_path: "x.ts" } }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      };
    },
  };
  const tool = {
    schema: {
      name: "Edit",
      description: "Test edit",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call() {
      toolCalls += 1;
      return { output: "edited" };
    },
  };
  const engine = new QueryEngine(
    {
      provider,
      model: "test",
      systemPrompt: "test",
      tools: [tool],
      workspace: workspaceRoot,
      maxTurns: 1,
    },
    "sess_test_write_gate",
  );

  engine.appendUserMessage("flex grep tool");
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  assert.equal(toolCalls, 1);
  assert.ok(events.some((event) => event.type === "tool_end"));
});

test("M0: explicit write intent allows workspace-write tools", async () => {
  let toolCalls = 0;
  const provider = {
    name: "write-allow-provider",
    async *stream() {
      yield { type: "tool_use_start", id: "edit_1", name: "Edit" };
      yield { type: "tool_use_input_done", id: "edit_1", input: { file_path: "x.ts" } };
      yield {
        type: "message_done",
        message: {
          id: "assistant_tool",
          role: "assistant",
          content: [{ type: "tool_use", id: "edit_1", name: "Edit", input: { file_path: "x.ts" } }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      };
    },
  };
  const tool = {
    schema: {
      name: "Edit",
      description: "Test edit",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call() {
      toolCalls += 1;
      return { output: "edited" };
    },
  };
  const engine = new QueryEngine(
    {
      provider,
      model: "test",
      systemPrompt: "test",
      tools: [tool],
      workspace: workspaceRoot,
      maxTurns: 1,
    },
    "sess_test_write_allow",
  );

  engine.appendUserMessage("edit x.ts");
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  assert.equal(toolCalls, 1);
  assert.ok(events.some((event) => event.type === "tool_end"));
});

test("M3: parallel-safe tools execute concurrently and forward progress", async () => {
  const provider = {
    name: "parallel-provider",
    async *stream() {
      for (const id of ["a", "b"]) {
        yield { type: "tool_use_start", id, name: "SlowRead" };
        yield { type: "tool_use_input_done", id, input: { id } };
      }
      yield {
        type: "message_done",
        message: {
          id: "assistant_parallel",
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "SlowRead", input: { id: "a" } },
            { type: "tool_use", id: "b", name: "SlowRead", input: { id: "b" } },
          ],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      };
    },
  };
  const tool = {
    schema: {
      name: "SlowRead",
      description: "Slow parallel-safe test tool",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "read-only",
      concurrency: "parallel-safe",
    },
    async call(input, ctx) {
      ctx.emitProgress?.({ kind: "slow", id: input.id });
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { output: input.id };
    },
  };
  const engine = new QueryEngine(
    {
      provider,
      model: "test",
      systemPrompt: "test",
      tools: [tool],
      workspace: workspaceRoot,
      maxTurns: 1,
    },
    "sess_test_parallel",
  );

  engine.appendUserMessage("read both");
  const started = Date.now();
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);
  const duration = Date.now() - started;

  assert.ok(duration < 260, `expected concurrent runtime, got ${duration}ms`);
  assert.equal(events.filter((event) => event.type === "tool_end").length, 2);
  assert.equal(events.filter((event) => event.type === "tool_progress").length, 2);
});
