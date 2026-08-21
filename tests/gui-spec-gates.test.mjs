// GUI ground-truth gate + spec-checklist gate. Born from the BeanBrawl
// failure: a Godot game reported "27/27 tests pass" and shipped a grey
// screen, with the spec's mandated screenshots never taken.
//   1. Touching an artifact matched by an environment-provider manifest arms
//      the GUI gate: the first
//      completion attempt gets a "launch it + screenshot it" push, a second
//      unsupported finish surfaces GUI-UNVERIFIED, and workStatus can never
//      resolve verified without visual proof.
//   2. A successful ComputerUse screenshot AFTER the last mutation satisfies
//      the gate — no GUI reminder, no GUI-UNVERIFIED marker.
//   3. cfg.specDocs forces one requirements-vs-artifacts diff reminder before
//      the first completion claim.
//   4. CodingJournal records spec .md files read during an active objective
//      and exposes them via specDocsForCurrentTurn().

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine, CodingJournal } from "../packages/core/dist/index.js";

const now = () => new Date().toISOString();

/** Provider that emits one scripted tool call per round, then tries to end
 *  every round after the script is exhausted. */
function scriptedProvider(calls) {
  let r = 0;
  return {
    name: "scripted",
    async *stream() {
      const i = r++;
      const call = calls[i];
      if (!call) {
        yield { type: "message_done", message: { id: `end${i}`, role: "assistant", content: [{ type: "text", text: "done" }], createdAt: now() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
        return;
      }
      const id = `t${i}`;
      yield { type: "tool_use_start", id, name: call.name };
      yield { type: "tool_use_input_done", id, input: call.input };
      yield { type: "message_done", message: { id: `a${i}`, role: "assistant", content: [{ type: "tool_use", id, name: call.name, input: call.input }], createdAt: now() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" };
    },
  };
}

const sceneEditTool = {
  schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
  async call() { return { output: "edited", touchedFiles: ["D:/game/scenes/Main.tscn"] }; },
};

const computerUseTool = {
  schema: { name: "ComputerUse", description: "desktop", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "exclusive" },
  async call() { return { output: { ok: true, screenshotPath: "shot.png" } }; },
};

const environmentCapabilityTool = {
  schema: { name: "Capability", description: "adaptive environment", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "exclusive" },
  classifyInput(input) {
    return { safety: input.operation === "observe" ? "read-only" : "external-state" };
  },
  async call(input) {
    const observe = input.operation === "observe";
    return {
      output: {
        action: "invoke",
        ok: true,
        operation: input.operation,
        provider: {
          id: "test.scene.provider",
          kind: "environment-provider",
          operations: {
            pose: { effect: "external-state" },
            observe: { effect: "read-only" },
          },
        },
        receipt: {
          ok: true,
          evidence: observe
            ? [{ kind: "viewport-screenshot", observedAt: new Date().toISOString(), uri: "artifact://scene.png" }]
            : [],
        },
      },
    };
  },
};

async function collect(engine) {
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

function makeEngine(provider, tools, extraCfg = {}) {
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "test",
      systemPrompt: "t",
      tools,
      workspace: "D:\\Ares",
      requireVerificationEvidence: true,
      // Test fixture for a provider manifest with match.files=["*.tscn"]. Core
      // itself intentionally knows no engine/editor extensions.
      environmentArtifactSignals: ({ touchedFiles = [] }) => {
        const file = touchedFiles.find((candidate) => /\.tscn$/i.test(candidate));
        return file ? [`provider:test.scene:file:${path.basename(file)}`] : [];
      },
      ...extraCfg,
    },
    "sess_gui",
  );
  engine.appendUserMessage("build the game");
  return engine;
}

// ── 1. gate fires and blocks "verified" ──────────────────────────────────────

test("GUI gate: touched .tscn without a screenshot pushes once, then surfaces GUI-UNVERIFIED", async () => {
  // ComputerUse is IN the belt (the gate only demands screenshots it can take)
  // — the model just never calls it.
  const provider = scriptedProvider([{ name: "Edit", input: { file_path: "Main.tscn" } }]);
  const events = await collect(makeEngine(provider, [sceneEditTool, computerUseTool]));

  const pushes = events.filter((e) => e.type === "system_reminder_injected" && /WINDOWED app artifact/.test(e.text));
  assert.equal(pushes.length, 1, "the launch-and-screenshot push fires exactly once");
  assert.match(pushes[0].text, /Main\.tscn/, "names the GUI artifact");

  const surfaced = events.filter((e) => e.type === "system_reminder_injected" && /^GUI-UNVERIFIED at turn end/.test(e.text));
  assert.equal(surfaced.length, 1, "the honest GUI-UNVERIFIED marker surfaces at the end");

  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.workStatus, "unverified", "GUI work without visual proof can never end verified");
});

test("GUI gate: with NO screenshot-capable tool in the belt, skips the dead order and surfaces GUI-UNVERIFIED directly", async () => {
  const provider = scriptedProvider([{ name: "Edit", input: { file_path: "Main.tscn" } }]);
  const events = await collect(makeEngine(provider, [sceneEditTool]));
  assert.ok(
    !events.some((e) => e.type === "system_reminder_injected" && /WINDOWED app artifact/.test(e.text)),
    "no futile screenshot demand when no tool can take one",
  );
  assert.ok(
    events.some((e) => e.type === "system_reminder_injected" && /^GUI-UNVERIFIED at turn end/.test(e.text)),
    "still discloses honestly",
  );
  assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "unverified");
});

// ── 2. screenshot after the mutation satisfies the gate ─────────────────────

test("GUI gate: a ComputerUse screenshot newer than the mutation satisfies it", async () => {
  const provider = scriptedProvider([
    { name: "Edit", input: { file_path: "Main.tscn" } },
    { name: "ComputerUse", input: { action: "screenshot" } },
  ]);
  const events = await collect(makeEngine(provider, [sceneEditTool, computerUseTool]));

  assert.ok(
    !events.some((e) => e.type === "system_reminder_injected" && /WINDOWED app artifact/.test(e.text)),
    "no GUI push when visual evidence is fresh",
  );
  assert.ok(
    !events.some((e) => e.type === "system_reminder_injected" && /^GUI-UNVERIFIED/.test(e.text)),
    "no GUI-UNVERIFIED marker",
  );
});

test("GUI gate: a screenshot taken BEFORE the last mutation does not count", async () => {
  const provider = scriptedProvider([
    { name: "ComputerUse", input: { action: "screenshot" } },
    { name: "Edit", input: { file_path: "Main.tscn" } },
  ]);
  const events = await collect(makeEngine(provider, [sceneEditTool, computerUseTool]));
  assert.ok(
    events.some((e) => e.type === "system_reminder_injected" && /WINDOWED app artifact/.test(e.text)),
    "stale screenshot → gate still fires",
  );
});

test("GUI gate: an environment provider mutation requires later provider pixel evidence", async () => {
  const withoutObservation = await collect(makeEngine(
    scriptedProvider([{ name: "Capability", input: { action: "invoke", operation: "pose" } }]),
    [environmentCapabilityTool],
    { environmentArtifactSignals: () => [] },
  ));
  assert.ok(
    withoutObservation.some((event) => event.type === "system_reminder_injected" && /WINDOWED app artifact/.test(event.text)),
    "a live editor mutation with no files still arms visual proof",
  );

  const withObservation = await collect(makeEngine(
    scriptedProvider([
      { name: "Capability", input: { action: "invoke", operation: "pose" } },
      { name: "Capability", input: { action: "invoke", operation: "observe" } },
    ]),
    [environmentCapabilityTool],
    { environmentArtifactSignals: () => [] },
  ));
  assert.ok(
    !withObservation.some((event) => event.type === "system_reminder_injected" && /WINDOWED app artifact/.test(event.text)),
    "a fresh contract receipt carrying viewport pixels settles the GUI gate",
  );
});

// ── 3. spec-checklist gate ───────────────────────────────────────────────────

test("spec gate: cfg.specDocs forces one requirements-vs-artifacts diff before finishing", async () => {
  const provider = scriptedProvider([{ name: "Edit", input: { file_path: "app.ts" } }]);
  const plainEdit = {
    schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call() { return { output: "edited", touchedFiles: ["D:/game/app.ts"] }; },
  };
  const events = await collect(makeEngine(provider, [plainEdit], { specDocs: () => ["fallguys-godot-prompt.md"] }));
  const pushes = events.filter((e) => e.type === "system_reminder_injected" && /re-open the task spec/.test(e.text));
  assert.equal(pushes.length, 1, "spec diff push fires exactly once");
  assert.match(pushes[0].text, /fallguys-godot-prompt\.md/);
  assert.match(pushes[0].text, /do not silently reduce scope/i);
});

test("spec gate: silent without spec docs or without mutations", async () => {
  // no mutation → not applicable
  const provider = scriptedProvider([]);
  const events = await collect(makeEngine(provider, [], { specDocs: () => ["spec.md"] }));
  assert.ok(!events.some((e) => e.type === "system_reminder_injected" && /re-open the task spec/.test(e.text)));
});

// ── 4. journal records spec docs ─────────────────────────────────────────────

test("CodingJournal: a spec .md read during an active objective is recorded and survives rerender", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-specdocs-"));
  const journal = await CodingJournal.open({ workspace: root, sessionId: "sess_spec" });
  journal.beginTurn("Build the game described in the task markdown");
  journal.recordTurnEvent({ type: "tool_start", id: "r1", name: "Read", input: { file_path: path.join(root, "task", "fallguys-godot-prompt.md") }, activityDescription: "" });
  const docs = journal.specDocsForCurrentTurn();
  assert.equal(docs.length, 1);
  assert.match(docs[0], /fallguys-godot-prompt\.md$/);
  assert.match(journal.renderReminder(), /spec docs \(completion is diffed against these\)/);

  // memory/vendor noise is excluded
  journal.recordTurnEvent({ type: "tool_start", id: "r2", name: "Read", input: { file_path: path.join(root, "node_modules", "pkg", "README.md") }, activityDescription: "" });
  journal.recordTurnEvent({ type: "tool_start", id: "r3", name: "Read", input: { file_path: path.join(root, ".ares", "memory.md") }, activityDescription: "" });
  assert.equal(journal.specDocsForCurrentTurn().length, 1, "node_modules/.ares reads are not specs");

  // a NEW objective resets the spec list
  journal.beginTurn("new task — build a completely different pomodoro timer app instead");
  assert.equal(journal.specDocsForCurrentTurn().length, 0, "fresh objective starts with no spec docs");
  await journal.flush();
  await rm(root, { recursive: true, force: true });
});
