// Verifies workspace-write autonomy:
//   1. Self-territory writes (under selfTerritoryRoots) are allowed.
//   2. Ordinary workspace writes are also allowed in workspace-write mode.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { QueryEngine } from "../packages/core/dist/index.js";

async function makeTmp(prefix = "ares-gate-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeEditTool(state) {
  return {
    schema: {
      name: "Edit",
      description: "edit test tool",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call(input) {
      state.calls += 1;
      state.lastInput = input;
      return { output: "edited", touchedFiles: [String(input.file_path)] };
    },
  };
}

function singleEditProvider(filePath) {
  let callCount = 0;
  return {
    name: "single-edit",
    async *stream() {
      callCount += 1;
      if (callCount === 1) {
        const useId = `edit_${callCount}`;
        yield { type: "tool_use_start", id: useId, name: "Edit" };
        yield { type: "tool_use_input_done", id: useId, input: { file_path: filePath } };
        yield {
          type: "message_done",
          message: {
            id: `assistant_${callCount}`,
            role: "assistant",
            content: [{ type: "tool_use", id: useId, name: "Edit", input: { file_path: filePath } }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
        return;
      }
      // After the tool runs, return a plain text response to finish the turn cleanly.
      yield {
        type: "message_done",
        message: {
          id: `assistant_${callCount}`,
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
    resetCalls() {
      callCount = 0;
    },
  };
}

test("self-territory writes are allowed without magic wording", async () => {
  const home = await makeTmp("ares-self-");
  const workspace = await makeTmp("ares-ws-");
  const editState = { calls: 0, lastInput: null };
  const targetFile = path.join(home, "SOUL.md");
  const engine = QueryEngine.forTesting(
    {
      provider: singleEditProvider(targetFile),
      model: "test",
      systemPrompt: "test",
      tools: [makeEditTool(editState)],
      workspace,
      selfTerritoryRoots: [home],
    },
    "sess_self_territory",
  );

  engine.appendUserMessage("hey just a chat — no write verbs here");
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  assert.equal(editState.calls, 1, "Edit should have been executed despite missing write intent");
  assert.ok(events.some((event) => event.type === "tool_end"), "tool_end event expected");
  assert.ok(
    !events.some((event) => event.type === "tool_error" && /explicit write intent/.test(event.error)),
    "self-territory write must not be gated",
  );
});

test("workspace-write mode allows ordinary workspace files without magic wording", async () => {
  const home = await makeTmp("ares-self-");
  const workspace = await makeTmp("ares-ws-");
  const editState = { calls: 0, lastInput: null };
  const engine = QueryEngine.forTesting(
    {
      provider: singleEditProvider(path.join(workspace, "src", "x.ts")),
      model: "test",
      systemPrompt: "test",
      tools: [makeEditTool(editState)],
      workspace,
      selfTerritoryRoots: [home],
    },
    "sess_workspace_blocked",
  );

  engine.appendUserMessage("hey just hanging out, no intent words");
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  assert.equal(editState.calls, 1, "workspace Edit should run when the session is in workspace-write mode");
  assert.ok(events.some((event) => event.type === "tool_end"));
});

test("workspace-write mode remains open across turns", async () => {
  const workspace = await makeTmp("ares-ws-");
  const editState = { calls: 0, lastInput: null };
  const provider = singleEditProvider(path.join(workspace, "src", "x.ts"));
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "test",
      systemPrompt: "test",
      tools: [makeEditTool(editState)],
      workspace,
    },
    "sess_sticky",
  );

  engine.appendUserMessage("go ahead and edit x.ts");
  for await (const _event of engine.streamTurn()) { void _event; }
  assert.equal(editState.calls, 1);

  // Reset provider state so it offers the tool again on the next user turn.
  provider.resetCalls();

  // Second turn: no intent words. Should still be allowed.
  engine.appendUserMessage("ok cool");
  for await (const _event of engine.streamTurn()) { void _event; }
  assert.equal(editState.calls, 2, "workspace-write mode should let the second turn through");
});
