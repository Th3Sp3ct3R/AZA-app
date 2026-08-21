// Verifies bounded parallel tool fan-out (the path Task subagents take):
//   - independent tools in a batch run CONCURRENTLY (not sum-of-durations)
//   - results aggregate in EMITTED order regardless of finish order
//   - concurrency is CAPPED (ARES_MAX_TOOL_CONCURRENCY) — no 20-way storm
//   - a sibling's failure does not poison the others
//   - two real Task calls run their subagents in parallel
// "Three specialists at once," not "twenty toddlers with scissors."

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  QueryEngine,
  AresSubagentRunner,
  SubagentRegistry,
} from "../packages/core/dist/index.js";
import { makeTaskTool, adaptToolForEngine } from "../packages/tools/dist/index.js";

const makeTmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-v25-"));

// A parallel-safe, no-target tool that sleeps — so wall-clock reveals concurrency.
function slowTool(counter) {
  return {
    schema: {
      name: "Slow",
      description: "sleeps then returns",
      inputJsonSchema: { type: "object", properties: { sleepMs: { type: "number" }, id: { type: "string" }, fail: { type: "boolean" } } },
      safety: "read-only",
      concurrency: "parallel-safe",
    },
    async call(input) {
      counter.current += 1;
      counter.max = Math.max(counter.max, counter.current);
      await new Promise((r) => setTimeout(r, input?.sleepMs ?? 100));
      counter.current -= 1;
      if (input?.fail) throw new Error(`boom:${input?.id ?? "?"}`);
      return { output: { id: input?.id ?? "?", slept: input?.sleepMs ?? 100 } };
    },
  };
}

// Emits N tool_use blocks in one assistant message, then ends.
function batchProvider(calls) {
  return {
    name: "batch",
    async *stream(req) {
      const done = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
      if (!done) {
        const blocks = calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name ?? "Slow", input: c.input }));
        for (const b of blocks) {
          yield { type: "tool_use_start", id: b.id, name: b.name };
          yield { type: "tool_use_input_done", id: b.id, input: b.input };
        }
        yield { type: "message_done", message: { id: "m1", role: "assistant", content: blocks, createdAt: new Date().toISOString() }, usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "tool_use" };
      } else {
        yield { type: "message_done", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() }, usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "end_turn" };
      }
    },
  };
}

async function runTurn(provider, tools, workspace) {
  const engine = QueryEngine.forTesting(
    { provider, model: "mock", systemPrompt: "t", tools, workspace, signal: new AbortController().signal },
    "eng",
  );
  engine.appendUserMessage("go");
  const t0 = Date.now();
  for await (const _ of engine.streamTurn()) { /* drain */ }
  return { elapsed: Date.now() - t0, history: engine.history() };
}

function toolResultIds(history) {
  const msg = history.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
  return (msg?.content ?? []).filter((b) => b.type === "tool_result");
}

// ── Concurrency: a batch runs in parallel, not sequentially ───────────────────

test("fan-out: 3 independent 250ms tools finish in parallel, not ~750ms", async () => {
  const tmp = await makeTmp();
  const counter = { current: 0, max: 0 };
  const calls = ["t0", "t1", "t2"].map((id) => ({ id, input: { sleepMs: 250, id } }));
  const { elapsed } = await runTurn(batchProvider(calls), [slowTool(counter)], tmp);
  assert.ok(elapsed < 550, `ran concurrently in ${elapsed}ms (sequential would be ~750ms)`);
  assert.equal(counter.max, 3, "all 3 ran at once (default cap 5 >= 3)");
});

// ── Deterministic order regardless of finish order ────────────────────────────

test("fan-out: results aggregate in EMITTED order even when they finish out of order", async () => {
  const tmp = await makeTmp();
  // a finishes last (300ms), b first (50ms), c middle (150ms).
  const calls = [
    { id: "a", input: { sleepMs: 300, id: "a" } },
    { id: "b", input: { sleepMs: 50, id: "b" } },
    { id: "c", input: { sleepMs: 150, id: "c" } },
  ];
  const { history } = await runTurn(batchProvider(calls), [slowTool({ current: 0, max: 0 })], tmp);
  const ids = toolResultIds(history).map((r) => r.tool_use_id);
  assert.deepEqual(ids, ["a", "b", "c"], "emitted order preserved (finish order was b, c, a)");
});

// ── Concurrency cap (backpressure) ────────────────────────────────────────────

test("fan-out: ARES_MAX_TOOL_CONCURRENCY caps how many run at once", async () => {
  const tmp = await makeTmp();
  process.env.ARES_MAX_TOOL_CONCURRENCY = "2";
  try {
    const counter = { current: 0, max: 0 };
    const calls = ["w", "x", "y", "z"].map((id) => ({ id, input: { sleepMs: 150, id } }));
    const { elapsed } = await runTurn(batchProvider(calls), [slowTool(counter)], tmp);
    assert.ok(counter.max <= 2, `never more than 2 concurrent (saw ${counter.max})`);
    assert.equal(counter.max, 2, "but did run 2 at a time");
    assert.ok(elapsed >= 280, `4 tools at cap 2 took ~2 waves (${elapsed}ms; uncapped would be ~150ms)`);
  } finally {
    delete process.env.ARES_MAX_TOOL_CONCURRENCY;
  }
});

// ── A sibling failure does not poison the others ──────────────────────────────

test("fan-out: one tool failing leaves its siblings' results intact", async () => {
  const tmp = await makeTmp();
  const calls = [
    { id: "ok1", input: { sleepMs: 50, id: "ok1" } },
    { id: "bad", input: { sleepMs: 50, id: "bad", fail: true } },
    { id: "ok2", input: { sleepMs: 50, id: "ok2" } },
  ];
  const { history } = await runTurn(batchProvider(calls), [slowTool({ current: 0, max: 0 })], tmp);
  const results = toolResultIds(history);
  assert.equal(results.find((r) => r.tool_use_id === "bad")?.is_error, true, "failed sibling is an error result");
  assert.notEqual(results.find((r) => r.tool_use_id === "ok1")?.is_error, true, "ok1 still succeeded");
  assert.notEqual(results.find((r) => r.tool_use_id === "ok2")?.is_error, true, "ok2 still succeeded");
  assert.equal(results.length, 3, "every sibling produced a result");
});

// ── Two real Task calls fan out concurrently ──────────────────────────────────

test("task: two Task calls run their subagents in parallel", async () => {
  const tmp = await makeTmp();
  // Prove parallelism STRUCTURALLY, not by wall-clock: track how many subagent
  // streams are in-flight at once. A wall-clock threshold flakes under CI load
  // (starvation inflates even genuinely-parallel runs); peak concurrency does
  // not. Each stream waits on a gate released only when BOTH have started, so a
  // sequential runner leaves peak at 1 and the assert fails loud (the 2nd never
  // starts, the 1st releases via the 1s fallback — no hang).
  let inFlight = 0;
  let peak = 0;
  let openGate;
  const bothStarted = new Promise((r) => { openGate = r; });
  const slowSubProvider = {
    name: "slowsub",
    async *stream() {
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (inFlight >= 2) openGate();
      await Promise.race([bothStarted, new Promise((r) => setTimeout(r, 1000))]);
      inFlight--;
      yield { type: "message_done", message: { id: "s", role: "assistant", content: [{ type: "text", text: "sub done" }], createdAt: new Date().toISOString() }, usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "end_turn" };
    },
  };
  // Use a declared read-only Task type. Unknown/custom personas are treated as
  // possible writers and serialized unless Conductor gives them isolated file
  // ownership; known researchers are safe to fan out in one parent batch.
  const registry = new SubagentRegistry([{ name: "researcher", description: "does slow read-only work", systemPrompt: "work", toolWhitelist: [], maxTurns: 2 }]);
  const runner = new AresSubagentRunner({ registry, provider: slowSubProvider, model: "mock", parentTools: [], baseSystemPrompt: "base" });
  const taskTool = adaptToolForEngine(makeTaskTool(runner), (base) => ({ ...base, permissionMode: "bypass", fileReadStamps: base.fileReadStamps ?? new Map() }));

  const calls = [0, 1].map((i) => ({ id: `task${i}`, name: "Task", input: { subagent_type: "researcher", description: `d${i}`, prompt: "work" } }));
  const { history } = await runTurn(batchProvider(calls), [taskTool], tmp);
  assert.equal(peak, 2, `both Task subagents were in-flight at once (peak concurrency ${peak})`);
  assert.equal(toolResultIds(history).length, 2, "both Task calls returned results");
});
