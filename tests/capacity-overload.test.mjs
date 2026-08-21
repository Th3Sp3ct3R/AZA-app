// Provider CAPACITY pressure must not lose the user's turn.
//
// Field report sess_8b12f633: Anthropic returned `overloaded_error` five times
// in ~20s. The generic transient budget (4 tries, ~12s of backoff) ran out and
// the turn ended FAILED with modelCalls: 0 — the user's message evaporated.
// Two independent defences are asserted here:
//   1. the engine rides out capacity pressure far longer than a generic hiccup
//      and still completes when it clears — while a NON-capacity error with the
//      same failure count still gives up, proving the budgets really differ;
//   2. sustained overload is classified as fail-over-worthy so the daemon's
//      self-healing loop actually runs, while NOT retiring the provider (the
//      congestion is temporary, unlike a dead balance or a bad key).
//
// The retry constants are captured at module load, so the env tuning below MUST
// be set before the dynamic import — that is also what keeps this test fast
// instead of sleeping through the real ~95s ladder.

import test from "node:test";
import assert from "node:assert/strict";

process.env.ARES_CAPACITY_BACKOFF_MS = "5";
process.env.ARES_CAPACITY_BACKOFF_MAX_MS = "20";

const { QueryEngine } = await import("../packages/core/dist/index.js");
const { isProviderFatalError } = await import("../packages/cli/dist/entry/sessionFactory.js");

const now = () => new Date().toISOString();

/** Fails `failures` times with `code`, then answers. */
function flakyProvider(failures, code = "overloaded_error", message = "Overloaded") {
  let calls = 0;
  return {
    name: "flaky",
    calls: () => calls,
    async *stream() {
      calls++;
      if (calls <= failures) {
        yield { type: "error", error: { code, message, retriable: true } };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "a1", role: "assistant", content: [{ type: "text", text: "recovered" }], createdAt: now() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function run(provider) {
  const engine = QueryEngine.forTesting(
    { provider, model: "claude-opus-5", systemPrompt: "t", tools: [], workspace: "D:\\Ares", maxTurns: 4 },
    "sess_cap",
  );
  engine.appendUserMessage("hello");
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

test("capacity: five Overloadeds are ridden out and the turn still completes", async () => {
  const provider = flakyProvider(5);
  const events = await run(provider);

  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "completed", "the turn survives the congestion");
  assert.ok(end.usage.modelCalls > 0, "and actually reaches the model (the report showed modelCalls: 0)");
  assert.equal(provider.calls(), 6, "5 refusals + 1 success");

  const notes = events.filter((e) => e.type === "system_reminder_injected" && /overloaded upstream/i.test(e.text));
  assert.equal(notes.length, 5, "each wait is surfaced honestly");
  assert.match(notes[0].text, /Your message is safe/, "and reassures rather than looking broken");
});

test("capacity: a NON-capacity error with the same failure count still gives up", async () => {
  // The contrast that proves the budgets are genuinely separate: the generic
  // ladder is 4 retries, so 5 failures exhausts it exactly as the field report
  // did. Same provider shape, different error code.
  const provider = flakyProvider(5, "internal_error", "Internal server problem");
  const events = await run(provider);
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "failed");
  assert.equal(end.usage.modelCalls, 0, "reproduces the reported failure shape");
  assert.equal(provider.calls(), 5, "1 initial + 4 generic retries");
});

test("capacity: overload is fail-over-worthy, a bad key is, a big prompt is not", () => {
  // The reported error's own shape: no http_5xx anywhere in it. This is what
  // silently skipped the daemon's self-healing loop before the fix.
  assert.equal(isProviderFatalError({ code: "overloaded_error", message: "Overloaded" }), true);
  assert.equal(isProviderFatalError({ code: "http_529", message: "" }), true);
  assert.equal(isProviderFatalError({ code: "", message: "service unavailable" }), true);
  // still true for the auth/balance deaths
  assert.equal(isProviderFatalError({ code: "http_402", message: "insufficient balance" }), true);
  // and still false for payload problems, which must never cascade providers
  assert.equal(isProviderFatalError({ code: "context_length_exceeded", message: "prompt is too long" }), false);
});
