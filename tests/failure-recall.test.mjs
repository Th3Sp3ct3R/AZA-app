// Failure-signature recall — the agent learning from its own past. When the same
// tool fails the same way twice, the engine asks the host for a remembered fix and
// injects it BEFORE the dead-loop breaker gives up. This is a headline differentiator,
// so it's pinned end-to-end against the real QueryEngine.

import test from "node:test";
import assert from "node:assert/strict";
import { QueryEngine } from "../packages/core/dist/index.js";

const WS = process.platform === "win32" ? "D:\\Ares" : "/tmp";

// A tool that always fails identically — the "stuck approach" the recall targets.
const alwaysFails = {
  schema: {
    name: "FlakyThing",
    description: "always fails the same way",
    inputJsonSchema: { type: "object", properties: {} },
    safety: "read-only",
    concurrency: "parallel-safe",
  },
  async call() {
    throw new Error("ECONNREFUSED connecting to service on port 8080");
  },
};

// Provider that re-issues the same failing call for `failRounds` rounds, then ends.
function repeatFailingCallProvider(failRounds) {
  let calls = 0;
  return {
    name: "recall-provider",
    async *stream() {
      calls += 1;
      if (calls > failRounds) {
        yield {
          type: "message_done",
          message: { id: `done`, role: "assistant", content: [{ type: "text", text: "giving up" }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
        return;
      }
      const id = `t${calls}`;
      yield { type: "tool_use_start", id, name: "FlakyThing" };
      yield { type: "tool_use_input_done", id, input: {} };
      yield {
        type: "message_done",
        message: { id: `a${calls}`, role: "assistant", content: [{ type: "tool_use", id, name: "FlakyThing", input: {} }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      };
    },
  };
}

test("second identical failure triggers recall, and the remembered fix is injected", async () => {
  let recallInput = null;
  const engine = QueryEngine.forTesting(
    {
      provider: repeatFailingCallProvider(3),
      model: "m",
      systemPrompt: "s",
      tools: [alwaysFails],
      workspace: WS,
      maxTurns: 8,
      recallFailureFix: async (input) => {
        recallInput = input;
        return "the service wasn't started — run `docker compose up -d` first";
      },
    },
    "sess_recall",
  );
  engine.appendUserMessage("hit the service");
  for await (const _ of engine.streamTurn()) { /* drain */ }

  // The host was asked, with the failing tool + the real error text.
  assert.ok(recallInput, "recallFailureFix should have been called");
  assert.equal(recallInput.tool, "FlakyThing");
  assert.match(recallInput.error, /ECONNREFUSED/);

  // The remembered fix was injected into the conversation as a system reminder.
  const injected = engine.history().some((m) =>
    m.role === "user" && m.content.some((b) => b.type === "system_reminder" && /RECALLED FIX/.test(b.text) && /docker compose up/.test(b.text)),
  );
  assert.ok(injected, "the recalled fix must be injected before the breaker gives up");
});

test("recall fires at most once per signature per turn (no repeated lookups)", async () => {
  let recallCount = 0;
  const engine = QueryEngine.forTesting(
    {
      provider: repeatFailingCallProvider(5),
      model: "m",
      systemPrompt: "s",
      tools: [alwaysFails],
      workspace: WS,
      maxTurns: 10,
      recallFailureFix: async () => { recallCount += 1; return null; },
    },
    "sess_recall_once",
  );
  engine.appendUserMessage("hit it repeatedly");
  for await (const _ of engine.streamTurn()) { /* drain */ }
  assert.equal(recallCount, 1, "recall should fire exactly once for the one repeating signature");
});

test("no recall hook configured → engine still runs fine (feature is optional)", async () => {
  const engine = QueryEngine.forTesting(
    { provider: repeatFailingCallProvider(2), model: "m", systemPrompt: "s", tools: [alwaysFails], workspace: WS, maxTurns: 6 },
    "sess_recall_none",
  );
  engine.appendUserMessage("hit it");
  let ok = true;
  try {
    for await (const _ of engine.streamTurn()) { /* drain */ }
  } catch {
    ok = false;
  }
  assert.ok(ok, "engine runs without a recall hook");
});
