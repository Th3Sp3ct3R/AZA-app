// C1 — the verified edit loop, engine contract:
//   1. Mid-turn drain: reminders that become ready while tools run reach the
//      model in the SAME turn, attached to the tool-results message.
//   2. End-of-turn gate: when the model wants to finish, confirmTurnEnd() can
//      object with red verdicts — the engine injects them and keeps the turn
//      alive instead of ending it. The gate fires at most twice (no infinite
//      engine-level repair loops).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine } from "../packages/core/dist/index.js";

/** A provider that plays back one scripted reply per call. */
function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "scripted",
    calls: [],
    async *stream(req) {
      const me = this;
      me.calls.push(req.messages.map((m) => m.content.map((b) => b.type).join("+")).join(" | "));
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        yield { type: "tool_use_start", id: `tu_${call}`, name: script.tool.name };
        yield { type: "tool_use_input_done", id: `tu_${call}`, input: script.tool.input };
        yield {
          type: "message_done",
          message: {
            id: `m_${call}`,
            role: "assistant",
            content: [{ type: "tool_use", id: `tu_${call}`, name: script.tool.name, input: script.tool.input }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
      } else {
        yield { type: "text_delta", text: script.text };
        yield {
          type: "message_done",
          message: {
            id: `m_${call}`,
            role: "assistant",
            content: [{ type: "text", text: script.text }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      }
    },
  };
}

function editTool(touched) {
  return {
    schema: {
      name: "Edit",
      description: "fake edit",
      inputJsonSchema: { type: "object" },
      safety: "workspace-write",
    },
    async call() {
      return { output: "edited", touchedFiles: [touched] };
    },
  };
}

async function drain(engine) {
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

test("C1 mid-turn drain: a reminder ready after a tool batch lands in the SAME turn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  const pending = [];
  const provider = scriptedProvider([
    { tool: { name: "Edit", input: { file_path: "a.ts" } } },
    { text: "done" },
  ]);
  const engine = new QueryEngine(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [
        {
          ...editTool(path.join(dir, "a.ts")),
          async call() {
            // The "verifier finished while tools ran" moment.
            pending.push({ text: "VERIFY RED: a.ts broke the typecheck", source: "verifier" });
            return { output: "edited", touchedFiles: [path.join(dir, "a.ts")] };
          },
        },
      ],
      workspace: dir,
      drainSystemReminders: () => pending.splice(0),
    },
    "sess_c1_mid",
  );
  engine.appendUserMessage("edit the file");
  const events = await drain(engine);

  const injected = events.filter((e) => e.type === "system_reminder_injected" && /VERIFY RED/.test(e.text));
  assert.equal(injected.length, 1, "the red verdict surfaced mid-turn");

  // It rode the tool-results user message, so the NEXT provider call saw it.
  assert.match(provider.calls.at(-1), /tool_result\+system_reminder/, "model saw tool_result + reminder together");
  await rm(dir, { recursive: true, force: true });
});

test("C1 end-of-turn gate: red blocks 'done', the model gets to repair, green ends the turn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  let gateCalls = 0;
  const provider = scriptedProvider([
    { text: "all done!" }, // tries to finish immediately
    { text: "fixed it properly now" }, // after the gate objects
  ]);
  const engine = new QueryEngine(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [],
      workspace: dir,
      confirmTurnEnd: async () => {
        gateCalls++;
        // First gate: red. Second gate: green.
        return gateCalls === 1 ? [{ text: "GATE: typecheck is red on files you touched", source: "verifier" }] : [];
      },
    },
    "sess_c1_gate",
  );
  engine.appendUserMessage("do the thing");
  const events = await drain(engine);

  assert.equal(gateCalls, 2, "gate consulted on both completion attempts");
  const injected = events.filter((e) => e.type === "system_reminder_injected" && /GATE:/.test(e.text));
  assert.equal(injected.length, 1);
  const end = events.find((e) => e.type === "turn_end");
  assert.equal(end.status, "completed");
  // The model's second reply exists in history AFTER the gate reminder.
  const history = engine.history();
  const lastAssistant = history.at(-1);
  assert.match(lastAssistant.content[0].text, /fixed it/);
  await rm(dir, { recursive: true, force: true });
});

test("C1 gate cap: a permanently-red gate cannot trap the turn forever", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  let gateCalls = 0;
  const provider = scriptedProvider([{ text: "done (1)" }, { text: "done (2)" }, { text: "done (3)" }]);
  const engine = new QueryEngine(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [],
      workspace: dir,
      confirmTurnEnd: async () => {
        gateCalls++;
        return [{ text: "GATE: still red, forever", source: "verifier" }];
      },
    },
    "sess_c1_cap",
  );
  engine.appendUserMessage("do the thing");
  const events = await drain(engine);

  assert.equal(gateCalls, 2, "the gate fires at most twice per turn");
  const end = events.find((e) => e.type === "turn_end");
  assert.equal(end.status, "completed", "the turn still ends — escalation is the harness's job, not a hang");
  await rm(dir, { recursive: true, force: true });
});

test("C1 gate honesty: a stuck red gate ends the turn but SURFACES the failure (no silent success)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  let gateCalls = 0;
  const provider = scriptedProvider([{ text: "done (1)" }, { text: "done (2)" }, { text: "done (3)" }]);
  const engine = new QueryEngine(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [],
      workspace: dir,
      // Permanently red, same objection every time — the agent is NOT resolving it.
      confirmTurnEnd: async () => {
        gateCalls++;
        return [{ text: "typecheck is still red on a.ts", source: "verifier" }];
      },
    },
    "sess_c1_honest",
  );
  engine.appendUserMessage("do the thing");
  const events = await drain(engine);

  // The OLD bug: after 2 fires it silently yielded status "completed" with the
  // red check unmentioned. New contract: it still ends (no infinite loop) but the
  // unresolved failure is surfaced, so the turn cannot pass off red as done.
  const unresolved = events.filter(
    (e) => e.type === "system_reminder_injected" && /UNRESOLVED at turn end/.test(e.text),
  );
  assert.ok(unresolved.length >= 1, "the still-red failure is surfaced as UNRESOLVED, not silently completed");
  const end = events.find((e) => e.type === "turn_end");
  assert.equal(end.status, "completed");
  assert.equal(end.workStatus, "blocked", "execution completed, but work truth remains blocked");
  await rm(dir, { recursive: true, force: true });
});

test("C1 gate progress: NEW objections each round keep the model working past the old 2-fire cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  let gateCalls = 0;
  const provider = scriptedProvider([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "done" }]);
  const engine = new QueryEngine(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [],
      workspace: dir,
      // A DIFFERENT objection each round (the model is making progress), then green.
      confirmTurnEnd: async () => {
        gateCalls++;
        return gateCalls < 4 ? [{ text: `round ${gateCalls}: fix item ${gateCalls}`, source: "verifier" }] : [];
      },
    },
    "sess_c1_progress",
  );
  engine.appendUserMessage("do the thing");
  const events = await drain(engine);

  assert.ok(gateCalls > 2, `gate fired ${gateCalls}× — fresh feedback keeps it working past the old hard cap of 2`);
  assert.equal(events.find((e) => e.type === "turn_end").status, "completed");
  await rm(dir, { recursive: true, force: true });
});

test("C1 gate is skipped entirely when not configured (zero-cost default)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  const provider = scriptedProvider([{ text: "done" }]);
  const engine = new QueryEngine(
    { provider, model: "scripted", systemPrompt: "s", tools: [], workspace: dir },
    "sess_c1_off",
  );
  engine.appendUserMessage("hi");
  const events = await drain(engine);
  assert.equal(events.find((e) => e.type === "turn_end").status, "completed");
  await rm(dir, { recursive: true, force: true });
});
