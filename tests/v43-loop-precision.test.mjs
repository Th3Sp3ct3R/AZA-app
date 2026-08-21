// Verifies the loop-precision layer that the failure-breaker misses:
//   1. canonicalCallSignature is stable under key reordering, equal for equal input.
//   2. Identical SUCCESSFUL call repeated N times → ONE 'loop-guard: identical' nudge.
//   3. A/B/A/B oscillation → ONE 'A/B oscillation' nudge.
//   4. The per-turn tool-call ceiling ends the turn GRACEFULLY (status 'completed',
//      NOT the failed max_turns_exceeded backstop), with the tool_result pushed.

import test from "node:test";
import assert from "node:assert/strict";

import { QueryEngine } from "../packages/core/dist/index.js";
import { __internal } from "../packages/core/dist/queryEngine.js";

const now = () => new Date().toISOString();
const { canonicalCallSignature } = __internal;

// ── 1. signature ─────────────────────────────────────────────────────────────

test("canonicalCallSignature: stable under key order, equal for equal input", () => {
  const a = canonicalCallSignature("Read", { file_path: "x.ts", offset: 5 });
  const b = canonicalCallSignature("Read", { offset: 5, file_path: "x.ts" });
  assert.equal(a, b, "key order does not change the signature");
  assert.notEqual(a, canonicalCallSignature("Read", { file_path: "y.ts", offset: 5 }), "different args differ");
});

test("canonicalCallSignature: long payloads sharing a prefix do NOT collide (no false repeat)", () => {
  // The exact bug the review caught: a 200-char truncation collapsed two distinct
  // full-file rewrites (same boilerplate header) into one signature → false nudge.
  const header = "// SPDX-License-Identifier: MIT\n".repeat(20); // >200 chars of shared prefix
  const v1 = canonicalCallSignature("Write", { file_path: "app.ts", content: header + "export const v = 1;\n" });
  const v2 = canonicalCallSignature("Write", { file_path: "app.ts", content: header + "export const v = 2;\n" });
  assert.notEqual(v1, v2, "distinct full-file rewrites must hash to distinct signatures");
});

/** Provider that emits a scripted tool call per round, then ends after `rounds`. */
function scriptedProvider(perRound, rounds) {
  let r = 0;
  return {
    name: "scripted",
    async *stream() {
      const i = r++;
      if (i >= rounds) {
        yield { type: "message_done", message: { id: `end`, role: "assistant", content: [{ type: "text", text: "done" }], createdAt: now() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
        return;
      }
      const { name, input } = perRound(i);
      const id = `t${i}`;
      yield { type: "tool_use_start", id, name };
      yield { type: "tool_use_input_done", id, input };
      yield { type: "message_done", message: { id: `a${i}`, role: "assistant", content: [{ type: "tool_use", id, name, input }], createdAt: now() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" };
    },
  };
}

const okTool = (name) => ({
  schema: { name, description: "ok", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe", watchdogTimeoutMs: 0 },
  async call() { return { output: { ok: true } }; },
});

async function collect(engine) {
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

function makeEngine(provider, tools, maxTurns = 80) {
  const engine = QueryEngine.forTesting({ provider, model: "test", systemPrompt: "t", tools, workspace: "D:\\Ares", maxTurns }, "sess_lp");
  engine.appendUserMessage("go");
  return engine;
}

// ── 2. identical-call no-op loop ─────────────────────────────────────────────

test("loop-guard: an identical successful call repeated trips ONE nudge", async () => {
  process.env.ARES_REPEAT_CALL_LIMIT = "3";
  // Same TodoWrite-style call every round (a 'progress' tool, so the gather-stall
  // never fires) — only the repeat detector should catch it.
  const provider = scriptedProvider(() => ({ name: "Note", input: { text: "same" } }), 5);
  const events = await collect(makeEngine(provider, [okTool("Note")]));
  const hits = events.filter((e) => e.type === "system_reminder_injected" && /loop-guard: identical/.test(e.text));
  assert.equal(hits.length, 1, "fires exactly once (single-fire latch)");
  delete process.env.ARES_REPEAT_CALL_LIMIT;
});

// ── 3. oscillation ───────────────────────────────────────────────────────────

test("loop-guard: A/B/A/B oscillation trips ONE nudge", async () => {
  process.env.ARES_REPEAT_CALL_LIMIT = "99"; // isolate oscillation from the repeat detector
  const provider = scriptedProvider((i) => (i % 2 === 0 ? { name: "A", input: {} } : { name: "B", input: {} }), 6);
  const events = await collect(makeEngine(provider, [okTool("A"), okTool("B")]));
  const hits = events.filter((e) => e.type === "system_reminder_injected" && /oscillation/.test(e.text));
  assert.equal(hits.length, 1, "oscillation fires exactly once");
  delete process.env.ARES_REPEAT_CALL_LIMIT;
});

// ── 4. graceful tool-call ceiling ────────────────────────────────────────────

test("ceiling: hitting the per-turn tool-call ceiling ends GRACEFULLY (completed)", async () => {
  process.env.ARES_MAX_TURN_TOOL_CALLS = "10"; // min allowed
  process.env.ARES_REPEAT_CALL_LIMIT = "99";
  // A DISTINCT call each round (no repeat/oscillation), one tool call per round,
  // forever — only the ceiling can stop it.
  const provider = scriptedProvider((i) => ({ name: "Step", input: { n: i } }), 1000);
  const events = await collect(makeEngine(provider, [okTool("Step")], 80));

  const end = events.at(-1);
  assert.equal(end.type, "turn_end");
  assert.equal(end.status, "completed", "graceful completion, not failed");
  assert.ok(!events.some((e) => e.type === "error" && e.error?.code === "max_turns_exceeded"), "did NOT hit the failed max-turns backstop");
  assert.ok(events.some((e) => e.type === "system_reminder_injected" && /tool-call ceiling/.test(e.text)), "warned before stopping");
  delete process.env.ARES_MAX_TURN_TOOL_CALLS;
  delete process.env.ARES_REPEAT_CALL_LIMIT;
});
