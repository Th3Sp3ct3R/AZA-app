// C2 — runForkedTurn, the one fork primitive (feat/core-consolidation, Phase 1).
//
// Subagents and the operator dispatcher now re-enter the SAME QueryEngine through
// runForkedTurn instead of hand-rolling new-engine + appendUserMessage + streamTurn.
// This pins the two invariants the primitive centralizes:
//   1. every fork gets a FRESH, empty fileReadStamps map (read isolation — a child
//      can never inherit the parent's read-before-write grants);
//   2. autonomous work is seeded as a tagged work-item, not a faked chat turn.
// Plus result propagation (finalText / streamedText / status).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspaceSessionKernel, runForkedTurn } from "../packages/core/dist/index.js";

const WS = process.platform === "win32" ? "D:\\Ares" : "/tmp";

function textProvider(text) {
  return {
    name: "text-provider",
    async *stream() {
      yield { type: "text_delta", text };
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 7, outputTokens: 3 },
        stopReason: "end_turn",
      };
    },
  };
}

// Emits one Stamp tool call, then ends the turn.
function stampProvider() {
  let calls = 0;
  return {
    name: "stamp-provider",
    async *stream() {
      calls += 1;
      if (calls > 1) {
        yield {
          type: "message_done",
          message: { id: "done", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "end_turn",
        };
        return;
      }
      yield { type: "tool_use_start", id: "s1", name: "Stamp" };
      yield { type: "tool_use_input_done", id: "s1", input: {} };
      yield {
        type: "message_done",
        message: { id: "t", role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Stamp", input: {} }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "tool_use",
      };
    },
  };
}

// Records the read-stamp map size it sees, then writes one entry.
function stampTool(observedSizes) {
  return {
    schema: { name: "Stamp", description: "records stamp map size", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe" },
    async call(_input, ctx) {
      observedSizes.push(ctx.fileReadStamps ? ctx.fileReadStamps.size : -1);
      ctx.fileReadStamps?.set(`f${observedSizes.length}`, { mtimeMs: 1, size: 1 });
      return { output: "ok" };
    },
  };
}

test("C2: a work-item seed tags the seed message; a chat seed does not", async () => {
  const work = await runForkedTurn({
    config: { provider: textProvider("hi"), model: "m", systemPrompt: "s", tools: [], workspace: WS, maxTurns: 1 },
    sessionId: "fork_work",
    seed: { kind: "work-item", text: "do the thing" },
  });
  const seed = work.history[0];
  assert.equal(seed.role, "user");
  assert.equal(seed.metadata?.source, "work-item");

  const chat = await runForkedTurn({
    config: { provider: textProvider("hi"), model: "m", systemPrompt: "s", tools: [], workspace: WS, maxTurns: 1 },
    sessionId: "fork_chat",
    seed: { kind: "chat", text: "hello" },
  });
  assert.notEqual(chat.history[0].metadata?.source, "work-item");
});

test("C2: each fork gets a fresh, isolated fileReadStamps map", async () => {
  const observed = [];
  for (const id of ["forkA", "forkB"]) {
    await runForkedTurn({
      config: { provider: stampProvider(), model: "m", systemPrompt: "s", tools: [stampTool(observed)], workspace: WS, maxTurns: 3 },
      sessionId: id,
      seed: { kind: "work-item", text: "stamp" },
    });
  }
  // Both forks saw an EMPTY map at tool time — the second did NOT inherit the first's write.
  assert.deepEqual(observed, [0, 0]);
});

test("C2: result propagates finalText, streamedText, usage, and status", async () => {
  const r = await runForkedTurn({
    config: { provider: textProvider("the answer"), model: "m", systemPrompt: "s", tools: [], workspace: WS, maxTurns: 1 },
    sessionId: "fork_result",
    seed: { kind: "work-item", text: "answer" },
  });
  assert.equal(r.streamedText, "the answer");
  assert.equal(r.finalText, "the answer");
  assert.equal(r.status, "completed");
  assert.equal(r.usage.outputTokens, 3);
});

test("C2: an effectful compatibility fork auto-provisions the canonical durable host", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-effectful-fork-"));
  let providerRound = 0;
  let calls = 0;
  const provider = {
    name: "effectful-fork-provider",
    async *stream() {
      providerRound += 1;
      if (providerRound === 1) {
        yield { type: "tool_use_start", id: "write-1", name: "Mutate" };
        yield { type: "tool_use_input_done", id: "write-1", input: {} };
        yield {
          type: "message_done",
          message: {
            id: "effectful-use",
            role: "assistant",
            content: [{ type: "tool_use", id: "write-1", name: "Mutate", input: {} }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: "durably done" };
      yield {
        type: "message_done",
        message: {
          id: "effectful-done",
          role: "assistant",
          content: [{ type: "text", text: "durably done" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 2, outputTokens: 2 },
        stopReason: "end_turn",
      };
    },
  };
  const tool = {
    schema: {
      name: "Mutate",
      description: "exercise the durable effect boundary",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "read-only",
      concurrency: "exclusive",
    },
    // Exercise the harder case: the static schema is inspect-safe, but a valid
    // input can become effectful and therefore still requires a durable host.
    mayHaveEffects: true,
    classifyInput() {
      return { safety: "workspace-write" };
    },
    async call() {
      calls += 1;
      return { output: "mutation settled" };
    },
  };

  let kernel;
  try {
    const result = await runForkedTurn({
      config: { provider, model: "m", systemPrompt: "s", tools: [tool], workspace, maxTurns: 3 },
      sessionId: "effectful_compatibility_fork",
      inputId: "effectful_compatibility_input",
      seed: { kind: "work-item", text: "perform the requested mutation" },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.finalText, "durably done");
    assert.equal(result.history[0].metadata?.source, "work-item");
    assert.equal(calls, 1);

    const replay = await runForkedTurn({
      config: { provider, model: "m", systemPrompt: "s", tools: [tool], workspace, maxTurns: 3 },
      sessionId: "effectful_compatibility_fork",
      inputId: "effectful_compatibility_input",
      seed: { kind: "work-item", text: "perform the requested mutation" },
    });
    assert.equal(replay.finalText, "durably done");
    assert.equal(calls, 1, "the settled logical input is not executed again");
    assert.equal(providerRound, 2, "replay returns canonical history without another provider call");

    kernel = await openWorkspaceSessionKernel(workspace);
    const runs = kernel.listToolRuns("effectful_compatibility_fork");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].executionState, "succeeded");
  } finally {
    kernel?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
