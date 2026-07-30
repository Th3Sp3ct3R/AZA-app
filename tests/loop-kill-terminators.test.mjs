// Loop-kill terminators: with iterations effectively unbounded by default,
// the ONLY things that end a stuck turn are the loop-kill detectors. Verify:
//   1. Default maxIters is a huge backstop (not 80) — a long productive run
//      of DISTINCT calls does not die at 80 rounds.
//   2. A failure signature repeated to ARES_LOOP_KILL_LIMIT ends the turn
//      FAILED with error code 'loop_detected' (after breaker/recall fired).
//   3. An identical SUCCESSFUL call repeated to 3× the repeat limit ends the
//      turn FAILED with 'loop_detected'.
//   4. Sustained A/B oscillation ends the turn FAILED with 'loop_detected'.
//   5. Stringified-JSON coercion: TodoWrite's todos arriving as a JSON string
//      is parsed into a real array before the tool sees it.
//   6. Shell-regex file-edit hint fires once on `-replace` + Set-Content.

import test from "node:test";
import assert from "node:assert/strict";

import { QueryEngine } from "../packages/core/dist/index.js";

const now = () => new Date().toISOString();

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

const okTool = (name, call) => ({
  schema: { name, description: "ok", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe", watchdogTimeoutMs: 0 },
  async call(input) { return call ? call(input) : { output: { ok: true } }; },
});

const failTool = (name) => ({
  schema: { name, description: "fails", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe", watchdogTimeoutMs: 0 },
  async call() { throw new Error("target not found: same failure every time"); },
});

async function collect(engine) {
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

function makeEngine(provider, tools, maxTurns = undefined) {
  const engine = new QueryEngine({ provider, model: "test", systemPrompt: "t", tools, workspace: "D:\\Ares", ...(maxTurns !== undefined ? { maxTurns } : {}) }, "sess_lk");
  engine.appendUserMessage("go");
  return engine;
}

// ── 1. no default 80-round leash ─────────────────────────────────────────────

test("unbounded default: 120 rounds of DISTINCT productive calls do not hit max_turns_exceeded", async () => {
  process.env.ARES_REPEAT_CALL_LIMIT = "99";
  process.env.ARES_MAX_TURN_TOOL_CALLS = "100000";
  const provider = scriptedProvider((i) => ({ name: "Step", input: { n: i } }), 120);
  const events = await collect(makeEngine(provider, [okTool("Step")]));
  assert.ok(!events.some((e) => e.type === "error" && e.error?.code === "max_turns_exceeded"), "no max-turns death at the old 80 default");
  assert.ok(!events.some((e) => e.type === "error" && e.error?.code === "loop_detected"), "distinct calls are not a loop");
  const end = events.at(-1);
  assert.equal(end.type, "turn_end");
  assert.equal(end.status, "completed");
  delete process.env.ARES_REPEAT_CALL_LIMIT;
  delete process.env.ARES_MAX_TURN_TOOL_CALLS;
});

test("explicit cfg.maxTurns still binds (subagents/tests keep their leash)", async () => {
  const provider = scriptedProvider((i) => ({ name: "Step", input: { n: i } }), 1000);
  const events = await collect(makeEngine(provider, [okTool("Step")], 5));
  assert.ok(events.some((e) => e.type === "error" && e.error?.code === "max_turns_exceeded"), "explicit maxTurns is honored");
});

// ── 2. dead failure loop terminates ──────────────────────────────────────────

test("loop-kill: identical failure repeated to the kill limit ends the turn FAILED as loop_detected", async () => {
  process.env.ARES_LOOP_KILL_LIMIT = "4"; // min allowed — keep the test fast
  const provider = scriptedProvider(() => ({ name: "Broken", input: { same: true } }), 100);
  const events = await collect(makeEngine(provider, [failTool("Broken")]));
  const err = events.find((e) => e.type === "error" && e.error?.code === "loop_detected");
  assert.ok(err, "loop_detected error emitted");
  assert.match(err.error.message, /Broken/, "names the looping tool");
  const end = events.at(-1);
  assert.equal(end.type, "turn_end");
  assert.equal(end.status, "failed", "stuck loop ends failed, not hung");
  // the breaker intervened BEFORE the kill
  assert.ok(events.some((e) => e.type === "system_reminder_injected" && /circuit-breaker/.test(e.text)), "breaker fired first");
  delete process.env.ARES_LOOP_KILL_LIMIT;
});

// ── 3. no-op repeat loop terminates ──────────────────────────────────────────

test("loop-kill: identical SUCCESSFUL call repeated to 3x the repeat limit ends FAILED as loop_detected", async () => {
  process.env.ARES_REPEAT_CALL_LIMIT = "2"; // kill at 6
  const provider = scriptedProvider(() => ({ name: "Note", input: { text: "same" } }), 100);
  const events = await collect(makeEngine(provider, [okTool("Note")]));
  const err = events.find((e) => e.type === "error" && e.error?.code === "loop_detected");
  assert.ok(err, "loop_detected emitted for the no-op loop");
  assert.match(err.error.message, /Note/, "names the looping tool");
  assert.equal(events.at(-1).status, "failed");
  delete process.env.ARES_REPEAT_CALL_LIMIT;
});

// ── 4. sustained oscillation terminates ──────────────────────────────────────

test("loop-kill: sustained A/B oscillation ends FAILED as loop_detected", async () => {
  process.env.ARES_REPEAT_CALL_LIMIT = "99"; // isolate from the repeat detector
  process.env.ARES_LOOP_KILL_LIMIT = "4";
  const provider = scriptedProvider((i) => (i % 2 === 0 ? { name: "A", input: {} } : { name: "B", input: {} }), 100);
  const events = await collect(makeEngine(provider, [okTool("A"), okTool("B")]));
  const err = events.find((e) => e.type === "error" && e.error?.code === "loop_detected");
  assert.ok(err, "loop_detected emitted for sustained oscillation");
  assert.match(err.error.message, /oscillation/i);
  assert.equal(events.at(-1).status, "failed");
  delete process.env.ARES_REPEAT_CALL_LIMIT;
  delete process.env.ARES_LOOP_KILL_LIMIT;
});

// ── 5. stringified-JSON structured args are coerced ──────────────────────────

test("coercion: todos arriving as a JSON-encoded string reaches the tool as a real array", async () => {
  let received = null;
  const todosTool = okTool("TodoWrite", (input) => {
    received = input;
    return { output: { ok: true } };
  });
  const todos = [{ id: "a", content: "x", activeForm: "x", status: "pending" }];
  const provider = scriptedProvider(() => ({ name: "TodoWrite", input: { todos: JSON.stringify(todos) } }), 1);
  await collect(makeEngine(provider, [todosTool]));
  assert.ok(received, "tool was invoked");
  assert.ok(Array.isArray(received.todos), "stringified todos coerced to a real array");
  assert.equal(received.todos[0].id, "a");
});

// ── 6. shell-regex edit hint ─────────────────────────────────────────────────

test("shell-regex edit: PowerShell -replace + Set-Content trips ONE hint", async () => {
  const provider = scriptedProvider(
    (i) => ({ name: "PowerShell", input: { command: `$c = Get-Content f.txt -Raw; $c = $c -replace 'a${i}', 'b'; Set-Content f.txt $c` } }),
    3,
  );
  const events = await collect(makeEngine(provider, [okTool("PowerShell")]));
  const hits = events.filter((e) => e.type === "system_reminder_injected" && /shell-regex file edit/.test(e.text));
  assert.equal(hits.length, 1, "hint fires exactly once per turn");
});
