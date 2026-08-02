// Tool-selection floor — the coding core is never pruned away.
//
// selectToolsForTurn() drops the tool list by keyword intent once the belt passes
// 12 tools (a live daemon session carries ~52, so it always fires). The intent
// regex is lexical, which means ordinary coding asks that happen not to contain a
// listed keyword — "add a dark mode toggle", "upgrade the deps", "rename the User
// class everywhere" — used to resolve to a NON-coding turn and ship a tool set with
// no Read/Write/Edit/Grep/Glob at all. The model then emits calls for tools whose
// schemas it was never sent, which surfaces as failed/unknown tool calls and reads
// as "the agent is bad at coding" rather than as a routing bug.
//
// The floor makes the coding core unconditional; intent may only ADD to it. These
// cases are deliberately phrased to MISS the intent regex — that is the point.

import test from "node:test";
import assert from "node:assert/strict";
import { selectToolsForTurn } from "../packages/core/dist/queryEngine.js";

/** A stand-in belt big enough to trip the >12 pruning branch. */
const NAMES = [
  "Read", "Write", "Edit", "ApplyIntent", "FindAndEdit", "CodeMode", "Glob", "Grep",
  "CodebaseSearch", "LSP", "Bash", "PowerShell", "BashOutput", "KillShell",
  "TodoWrite", "Task", "Conductor", "EnterPlanMode", "ExitPlanMode",
  "WebSearch", "WebFetch", "ImageSearch", "ComputerUse", "Browser",
  "McpListTools", "McpCallTool", "SkillsList", "SkillRead", "Memory", "Connect",
  "RequestUserAction", "Deploy", "Stripe", "Email", "Gmail", "GoogleCalendar",
  "Spotify", "Weather", "Remind", "Mission", "Self", "SkillHub", "Operator",
];
const TOOLS = NAMES.map((name) => ({ schema: { name } }));

const CORE = ["Read", "Write", "Edit", "Glob", "Grep"];
const turn = (text) => [{ role: "user", content: [{ type: "text", text }] }];
const pick = (text) => selectToolsForTurn(TOOLS, turn(text)).map((t) => t.schema.name);

test("coding core survives pruning for asks that miss the intent regex", () => {
  const missesTheRegex = [
    "add a dark mode toggle to the settings page",
    "upgrade the deps",
    "the login button doesn't work",
    "rename the User class everywhere",
    "remove the deprecated helper",
    "make the header sticky",
    "why is this broken?",
    "clean this up",
  ];

  for (const prompt of missesTheRegex) {
    const offered = pick(prompt);
    for (const tool of CORE) {
      assert.ok(offered.includes(tool), `${tool} must be offered for: ${prompt}`);
    }
    assert.ok(
      offered.includes("Bash") || offered.includes("PowerShell"),
      `a shell must be offered for: ${prompt}`,
    );
  }
});

test("explicit coding intent still expands past the floor", () => {
  const offered = pick("refactor the auth module and fix the failing test");
  for (const tool of [...CORE, "ApplyIntent", "LSP", "CodebaseSearch"]) {
    assert.ok(offered.includes(tool), `${tool} expected on an explicit coding turn`);
  }
});

test("pruning still prunes — the floor is not a bypass", () => {
  const offered = pick("what's the weather in Toronto?");
  assert.ok(offered.length < NAMES.length, "a non-coding turn should still drop tools");
  assert.ok(!offered.includes("Stripe"), "unrelated product tools stay pruned");
  assert.ok(offered.includes("Read"), "…but the coding core is still present");
});

test("the belt is returned whole when it is small enough to skip pruning", () => {
  const small = NAMES.slice(0, 10).map((name) => ({ schema: { name } }));
  assert.equal(selectToolsForTurn(small, turn("anything at all")).length, small.length);
});
