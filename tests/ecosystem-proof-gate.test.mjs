// Ecosystem-wide manual proof (the FPSgame gap).
//
// The proof grammar only knew JS/TS/Python/Rust/Go. In a .NET or Unreal
// project even a GREEN build could never count, so the completion gate was
// unsatisfiable by construction in exactly the projects users ship. These pin
// the widened grammar end-to-end through the engine, plus the project-aware
// nag text.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine } from "../packages/core/dist/index.js";

function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "ecosystem-proof-scripted",
    async *stream() {
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        const id = `tool_${call}`;
        yield { type: "tool_use_start", id, name: script.tool.name };
        yield { type: "tool_use_input_done", id, input: script.tool.input };
        yield {
          type: "message_done",
          message: { id: `m_${call}`, role: "assistant", content: [{ type: "tool_use", id, name: script.tool.name, input: script.tool.input }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: script.text ?? "done" };
      yield {
        type: "message_done",
        message: { id: `m_${call}`, role: "assistant", content: [{ type: "text", text: script.text ?? "done" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function collect(engine) {
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);
  return events;
}

function editTool(file) {
  return {
    schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call() { return { output: "edited", touchedFiles: [file] }; },
  };
}

function powershellTool() {
  return {
    schema: { name: "PowerShell", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) { return { output: { command: input.command, exitCode: 0, timedOut: false, stdout: "Build succeeded.", stderr: "" } }; },
  };
}

async function runProofScenario(root, scripts, tools) {
  const engine = QueryEngine.forTesting({
    provider: scriptedProvider(scripts),
    model: "scripted",
    systemPrompt: "code",
    tools,
    workspace: root,
    requireVerificationEvidence: true,
  }, `sess_proof_${Math.random().toString(36).slice(2, 8)}`);
  engine.appendUserMessage("do the work");
  return collect(engine);
}

test("a green dotnet build counts as manual proof", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-dotnet-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Game.cs");
  const events = await runProofScenario(root, [
    { tool: { name: "Edit", input: { file_path: "Game.cs" } } },
    { text: "done" },
    { tool: { name: "PowerShell", input: { command: "dotnet build --nologo", description: "Build" } } },
    { text: "verified" },
  ], [editTool(file), powershellTool()]);
  assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "verified");
});

test("a green Unreal Build.bat via the call operator counts as manual proof", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-unreal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Source", "FPSWeapon.h");
  const events = await runProofScenario(root, [
    { tool: { name: "Edit", input: { file_path: "Source/FPSWeapon.h" } } },
    { text: "done" },
    { tool: { name: "PowerShell", input: { command: String.raw`& "C:\Program Files\Epic Games\UE_5.4\Engine\Build\BatchFiles\Build.bat" FPSgameEditor Win64 Development`, description: "Engine build" } } },
    { text: "verified" },
  ], [editTool(file), powershellTool()]);
  assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "verified");
});

test("make clean and script-chain forgery still never count", async (t) => {
  for (const command of [
    "make clean",
    String.raw`& "C:\proj\Build.bat" Target; echo pwned`,
    String.raw`& "C:\proj\cleanup.bat" all`,
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), "ares-proof-reject-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "a.c");
    const events = await runProofScenario(root, [
      { tool: { name: "Edit", input: { file_path: "a.c" } } },
      { text: "done" },
      { tool: { name: "PowerShell", input: { command, description: "Attempt" } } },
      { text: "claiming done" },
      { text: "still claiming" },
    ], [editTool(file), powershellTool()]);
    assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "unverified", `${command} must not count as proof`);
  }
});

function exitCodedShellTool(exitCodeFor) {
  return {
    schema: { name: "PowerShell", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) {
      const exitCode = exitCodeFor(input.command);
      return { output: { command: input.command, exitCode, timedOut: false, stdout: exitCode === 0 ? "pass" : "1 failing", stderr: "" } };
    },
  };
}

test("a green package-suite run clears a red scoped test run (the coding-v2 atomic-state burn)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-suite-covers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "src", "atomicStore.mjs");
  const events = await runProofScenario(root, [
    { tool: { name: "Edit", input: { file_path: "src/atomicStore.mjs" } } },
    { tool: { name: "PowerShell", input: { command: "node --test tests/atomic-store.test.mjs", description: "Scoped test" } } },
    { tool: { name: "Edit", input: { file_path: "src/atomicStore.mjs" } } },
    { tool: { name: "PowerShell", input: { command: "npm test", description: "Full suite" } } },
    { text: "verified" },
  ], [editTool(file), exitCodedShellTool((command) => command === "npm test" ? 0 : 1)]);
  assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "verified",
    "the project's own full test suite is the proof the gate's hint demands — it must clear a scoped red run");
});

test("a green scoped test run does NOT clear a red package-suite run", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-scoped-noclear-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "src", "atomicStore.mjs");
  const events = await runProofScenario(root, [
    { tool: { name: "Edit", input: { file_path: "src/atomicStore.mjs" } } },
    { tool: { name: "PowerShell", input: { command: "npm test", description: "Full suite" } } },
    { tool: { name: "PowerShell", input: { command: "node --test tests/one.test.mjs", description: "Scoped test" } } },
    { text: "claiming done" },
    { text: "still claiming" },
  ], [editTool(file), exitCodedShellTool((command) => command === "npm test" ? 1 : 0)]);
  assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "unverified",
    "a passing subset must never cover a failing full suite");
});

test("cross-spelling pytest invocations cover each other", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-pytest-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "app.py");
  const events = await runProofScenario(root, [
    { tool: { name: "Edit", input: { file_path: "app.py" } } },
    { tool: { name: "PowerShell", input: { command: "pytest tests/test_app.py", description: "Scoped test" } } },
    { tool: { name: "Edit", input: { file_path: "app.py" } } },
    { tool: { name: "PowerShell", input: { command: "python -m pytest", description: "Full suite" } } },
    { text: "verified" },
  ], [editTool(file), exitCodedShellTool((command) => command === "python -m pytest" ? 0 : 1)]);
  assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "verified",
    "python -m pytest is the same suite as pytest — it must clear the scoped red run");
});

test("the unverified nag names project-appropriate proof for an Unreal workspace", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-hint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "FPSgame.uproject"), "{}");
  const file = path.join(root, "Source", "A.cpp");
  const events = await runProofScenario(root, [
    { tool: { name: "Edit", input: { file_path: "Source/A.cpp" } } },
    { text: "done" },
    { text: "still done" },
  ], [editTool(file)]);
  const nag = events.find((e) => e.type === "system_reminder_injected" && /behavior-capable verifier run/.test(e.text));
  assert.ok(nag, "proof-gate nag fired");
  assert.match(nag.text, /Unreal|Build\.bat/i, "nag names the Unreal verification floor instead of demanding nonexistent tests");
});
