// The effort-dial cutoff — a stalled stream is cut, reasoning downgrades one
// notch, and the SAME turn retries instead of spinning forever.
import test from "node:test";
import assert from "node:assert/strict";
import { QueryEngine, guardStreamStalls } from "../packages/core/dist/index.js";

function msgDone(text) {
  return {
    type: "message_done",
    message: { id: "a1", role: "assistant", content: [{ type: "text", text }], createdAt: new Date().toISOString() },
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

// ── guard unit tests ──────────────────────────────────────────────────

test("guard: a stream that never yields is cut as stream_stall", async () => {
  let stalled = false;
  async function* dead() {
    await new Promise(() => {});
  }
  const events = [];
  for await (const ev of guardStreamStalls(dead(), { idleMs: 60, thinkCeilingMs: 10_000, onStall: () => (stalled = true) })) {
    events.push(ev);
  }
  assert.ok(stalled);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "stream_stall");
  assert.equal(events[0].error.retriable, true);
});

test("guard: thinking-only output past the ceiling is cut as reasoning_stall", async () => {
  async function* thinker() {
    for (let i = 0; i < 200; i++) {
      yield { type: "thinking_delta", text: "hmm" };
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  const events = [];
  for await (const ev of guardStreamStalls(thinker(), { idleMs: 5_000, thinkCeilingMs: 80, onStall: () => {} })) {
    events.push(ev);
  }
  const last = events.at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.error.code, "reasoning_stall");
});

test("guard: committed output disarms the thinking ceiling", async () => {
  async function* productive() {
    yield { type: "thinking_delta", text: "hmm" };
    yield { type: "text_delta", text: "answer" };
    yield msgDone("answer");
  }
  const events = [];
  for await (const ev of guardStreamStalls(productive(), { idleMs: 5_000, thinkCeilingMs: 1, onStall: () => {} })) {
    events.push(ev);
  }
  assert.ok(events.every((e) => e.type !== "error"));
  assert.equal(events.at(-1).type, "message_done");
});

test("guard: a healthy stream passes through untouched", async () => {
  async function* healthy() {
    yield { type: "text_delta", text: "hi" };
    yield msgDone("hi");
  }
  const events = [];
  for await (const ev of guardStreamStalls(healthy(), { idleMs: 1_000, thinkCeilingMs: 1_000, onStall: () => {} })) {
    events.push(ev);
  }
  assert.deepEqual(events.map((e) => e.type), ["text_delta", "message_done"]);
});

// ── engine integration: stall → downgrade → same-turn retry ──────────

test("engine: reasoning stall downgrades one notch and the turn completes", async () => {
  const prevIdle = process.env.ARES_STREAM_IDLE_MS;
  const prevCeiling = process.env.ARES_THINK_CEILING_MS;
  const prevAdaptive = process.env.ARES_ADAPTIVE_REASONING;
  process.env.ARES_STREAM_IDLE_MS = "1000";
  process.env.ARES_THINK_CEILING_MS = "1000";
  process.env.ARES_ADAPTIVE_REASONING = "0";
  try {
    const levels = [];
    const provider = {
      name: "stall-once",
      async *stream({ signal, reasoningLevel }) {
        levels.push(reasoningLevel);
        if (levels.length === 1) {
          yield { type: "thinking_delta", text: "pondering…" };
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return;
        }
        yield { type: "text_delta", text: "done thinking, here you go" };
        yield msgDone("done thinking, here you go");
      },
    };
    const engine = new QueryEngine(
      { provider, model: "test", systemPrompt: "test", tools: [], workspace: "D:\\Ares", maxTurns: 2, reasoningLevel: "high" },
      "sess_effort_dial",
    );
    engine.appendUserMessage("investigate why the build is slow and explain the root cause in detail");
    const events = [];
    for await (const ev of engine.streamTurn()) events.push(ev);

    assert.equal(levels.length, 2, "one stalled attempt + one retry");
    assert.equal(levels[0], "high");
    assert.equal(levels[1], "medium", "retry runs one notch down");
    assert.equal(events.at(-1).type, "turn_end");
    assert.equal(events.at(-1).status, "completed");
    assert.ok(
      events.some((e) => e.type === "system_reminder_injected" && /stalled at "high"; retrying at "medium"/.test(e.text)),
      "the downgrade is announced",
    );
  } finally {
    if (prevIdle === undefined) delete process.env.ARES_STREAM_IDLE_MS; else process.env.ARES_STREAM_IDLE_MS = prevIdle;
    if (prevCeiling === undefined) delete process.env.ARES_THINK_CEILING_MS; else process.env.ARES_THINK_CEILING_MS = prevCeiling;
    if (prevAdaptive === undefined) delete process.env.ARES_ADAPTIVE_REASONING; else process.env.ARES_ADAPTIVE_REASONING = prevAdaptive;
  }
});

test("engine: ARES_STALL_DOWNGRADE=0 retries at the same level", async () => {
  const prevCeiling = process.env.ARES_THINK_CEILING_MS;
  const prevDowngrade = process.env.ARES_STALL_DOWNGRADE;
  const prevAdaptive = process.env.ARES_ADAPTIVE_REASONING;
  process.env.ARES_THINK_CEILING_MS = "1000";
  process.env.ARES_STALL_DOWNGRADE = "0";
  process.env.ARES_ADAPTIVE_REASONING = "0";
  try {
    const levels = [];
    const provider = {
      name: "stall-once-flat",
      async *stream({ signal, reasoningLevel }) {
        levels.push(reasoningLevel);
        if (levels.length === 1) {
          yield { type: "thinking_delta", text: "pondering…" };
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield msgDone("ok");
      },
    };
    const engine = new QueryEngine(
      { provider, model: "test", systemPrompt: "test", tools: [], workspace: "D:\\Ares", maxTurns: 2, reasoningLevel: "high" },
      "sess_effort_flat",
    );
    engine.appendUserMessage("investigate why the build is slow and explain the root cause in detail");
    for await (const ev of engine.streamTurn()) void ev;
    assert.deepEqual(levels, ["high", "high"]);
  } finally {
    if (prevCeiling === undefined) delete process.env.ARES_THINK_CEILING_MS; else process.env.ARES_THINK_CEILING_MS = prevCeiling;
    if (prevDowngrade === undefined) delete process.env.ARES_STALL_DOWNGRADE; else process.env.ARES_STALL_DOWNGRADE = prevDowngrade;
    if (prevAdaptive === undefined) delete process.env.ARES_ADAPTIVE_REASONING; else process.env.ARES_ADAPTIVE_REASONING = prevAdaptive;
  }
});

test("engine: an empty premature provider close retries and completes", async () => {
  let calls = 0;
  const provider = {
    name: "close-once",
    async *stream() {
      calls++;
      if (calls === 1) return;
      yield { type: "text_delta", text: "recovered" };
      yield msgDone("recovered");
    },
  };
  const engine = new QueryEngine(
    { provider, model: "test", systemPrompt: "test", tools: [], workspace: "D:\\Ares", maxTurns: 2 },
    "sess_close_retry",
  );
  engine.appendUserMessage("keep working");
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);

  assert.equal(calls, 2, "the empty close is retried once");
  assert.equal(events.at(-1)?.status, "completed");
  assert.ok(events.some((e) => e.type === "system_reminder_injected" && /no_message_done/.test(e.text)));
  assert.ok(!events.some((e) => e.type === "error"), "a recovered close is not shown as a failure");
});

test("guard: post-output silence gets the ACTIVE window, not the pre-output cutoff", async () => {
  // The Minecraft-clone regression: model streams text, then goes silent while
  // composing a big buffered Write. The old guard cut at idleMs and killed a
  // healthy turn that could not retry (output was committed).
  async function* buffering() {
    yield { type: "text_delta", text: "Building the voxel engine…" };
    await new Promise((r) => setTimeout(r, 250)); // silent 250ms >> idleMs
    yield { type: "text_delta", text: "done" };
    yield msgDone("done");
  }
  const events = [];
  for await (const ev of guardStreamStalls(buffering(), { idleMs: 60, activeIdleMs: 2_000, thinkCeilingMs: 10_000, onStall: () => {} })) {
    events.push(ev);
  }
  assert.ok(events.every((e) => e.type !== "error"), "no stall cut during committed work");
  assert.equal(events.at(-1).type, "message_done");
});

test("guard: pre-output hang still cuts fast even with a generous active window", async () => {
  let stalled = false;
  async function* dead() {
    await new Promise(() => {});
  }
  const events = [];
  for await (const ev of guardStreamStalls(dead(), { idleMs: 60, activeIdleMs: 60_000, thinkCeilingMs: 10_000, onStall: () => (stalled = true) })) {
    events.push(ev);
  }
  assert.ok(stalled);
  assert.equal(events[0].error.code, "stream_stall");
});

test("guard: silence AFTER thinking gets the generous window, not the pre-output cutoff", async () => {
  // The surface-build regression: the model streams reasoning, then goes quiet
  // for longer than the short pre-output idle while composing a huge canvas
  // program. The connection is demonstrably alive (thinking arrived), so the
  // pause must be tolerated up to the thinking ceiling — not cut at idleMs.
  async function* reasonThenCompose() {
    yield { type: "thinking_delta", text: "planning the castle…" };
    await new Promise((r) => setTimeout(r, 200)); // silent 200ms >> idleMs (60)
    yield { type: "text_delta", text: "<canvas>" };
    yield msgDone("<canvas>");
  }
  const events = [];
  for await (const ev of guardStreamStalls(reasonThenCompose(), { idleMs: 60, activeIdleMs: 5_000, thinkCeilingMs: 4_000, onStall: () => {} })) {
    events.push(ev);
  }
  assert.ok(events.every((e) => e.type !== "error"), "alive-after-thinking pause must not be cut");
  assert.equal(events.at(-1).type, "message_done");
});
