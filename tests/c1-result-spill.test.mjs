// C1 — tool-result disk-spill (feat/core-consolidation, coding-win track).
//
// Over-budget tool output is no longer silently truncated-and-lost. The engine
// spills the FULL output to <workspace>/.ares/tool-results/<session>/<id>.txt and
// hands the model a head preview + the path it can Read. Per-tool budget comes
// from schema.maxResultSizeChars (0 = uncapped, for self-bounding tools like Bash).
// This is the "forgets mid-build" fix: the tail is recoverable, not gone.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryEngine } from "../packages/core/dist/index.js";

function toolThenDone(toolCalls) {
  let calls = 0;
  return {
    name: "spill-provider",
    async *stream() {
      calls += 1;
      if (calls > 1) {
        yield {
          type: "message_done",
          message: { id: "done", role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
        return;
      }
      for (const t of toolCalls) {
        yield { type: "tool_use_start", id: t.id, name: t.name };
        yield { type: "tool_use_input_done", id: t.id, input: {} };
      }
      yield {
        type: "message_done",
        message: {
          id: "tools",
          role: "assistant",
          content: toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: {} })),
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      };
    },
  };
}

function bigTool(name, maxResultSizeChars, payload) {
  return {
    schema: {
      name,
      description: "returns a fixed payload",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "read-only",
      concurrency: "parallel-safe",
      maxResultSizeChars,
    },
    async call() {
      return { output: payload };
    },
  };
}

function toolResultFor(engine, id) {
  for (const m of engine.history()) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === id) return b;
    }
  }
  return null;
}

async function runOne(ws, sessionId, tool, id) {
  const engine = QueryEngine.forTesting(
    { provider: toolThenDone([{ id, name: tool.schema.name }]), model: "m", systemPrompt: "s", tools: [tool], workspace: ws, maxTurns: 2 },
    sessionId,
  );
  engine.appendUserMessage("go");
  for await (const _ of engine.streamTurn()) { /* drain */ }
  return engine;
}

test("C1: a small result stays inline, unchanged", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-spill-"));
  const engine = await runOne(ws, "sess_spill_small", bigTool("Small", 50, "tiny"), "s1");
  const r = toolResultFor(engine, "s1");
  assert.ok(r);
  assert.equal(r.content, "tiny");
});

test("C1: an over-budget result spills full to disk and the model gets preview + path", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-spill-"));
  const payload = "X".repeat(500);
  const sessionId = "sess_spill_big";
  const engine = await runOne(ws, sessionId, bigTool("Big", 50, payload), "b1");

  const r = toolResultFor(engine, "b1");
  assert.ok(r);
  assert.equal(typeof r.content, "string");
  // Model-facing content: head preview (<= budget) + a recoverable note, NOT the full blob.
  assert.ok(r.content.length < payload.length, "inline content must be smaller than the full payload");
  assert.match(r.content, /\[tool result truncated for context: \d+ of 500 chars omitted/);
  assert.match(r.content, /b1\.txt/);
  assert.ok(r.content.startsWith("X".repeat(50)), "preview is the head of the output");

  // The FULL output is on disk, recoverable via Read.
  const spillPath = path.join(ws, ".ares", "tool-results", sessionId, "b1.txt");
  const onDisk = await readFile(spillPath, "utf8");
  assert.equal(onDisk, payload);
});

test("C1: maxResultSizeChars=0 is uncapped (self-bounding tools keep full output)", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-spill-"));
  const payload = "Y".repeat(500);
  const engine = await runOne(ws, "sess_spill_uncapped", bigTool("Uncapped", 0, payload), "u1");
  const r = toolResultFor(engine, "u1");
  assert.ok(r);
  assert.equal(r.content, payload); // full, no spill, no note
});
