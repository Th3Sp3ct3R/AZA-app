import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { selectToolsForTurn } from "../packages/core/dist/queryEngine.js";

const tool = (name) => ({
  schema: { name, description: `${name} tool`, inputJsonSchema: { type: "object", properties: {} }, safety: "read-only" },
  execute: async () => ({ output: "ok" }),
});
const tools = [
  "Read", "Write", "Edit", "Glob", "Grep", "PowerShell", "TodoWrite", "Browser",
  "WebSearch", "WebFetch", "ImageSearch", "Memory", "RequestUserAction", "ComputerUse",
  "Stripe", "Email", "Gmail", "McpCallTool", "GoogleCalendar", "Spotify", "Weather", "Remind",
  "Task", "Conductor", "CodingBackend", "Deploy", "SkillHub", "SkillsList", "SkillRead",
].map(tool);
const user = (text) => [{ id: "u", role: "user", content: [{ type: "text", text }], createdAt: new Date(0).toISOString() }];
const names = (selected) => selected.map((entry) => entry.schema.name);

test("dynamic tool working set keeps browser turns lean", () => {
  const selected = names(selectToolsForTurn(tools, user("Open YouTube and click that video")));
  assert.ok(selected.includes("Browser"));
  assert.ok(selected.includes("WebSearch"));
  assert.ok(selected.includes("ComputerUse"));
  // "Lean" means the unrelated product integrations are gone — that is where the
  // schema budget actually goes.
  for (const unrelated of ["Stripe", "Gmail", "GoogleCalendar", "Spotify", "Weather", "Remind", "Deploy"]) {
    assert.ok(!selected.includes(unrelated), `${unrelated} should stay pruned on a browser turn`);
  }
  // The coding core is deliberately NOT pruned any more — see the floor in
  // selectToolsForTurn(). This assertion used to be `!includes("Write")`, but
  // intent detection is keyword-based and a browser turn routinely becomes
  // "…now save that to a file". Stranding the turn without Write surfaced as
  // failed tool calls, not as a clean refusal. Leanness is measured against the
  // integrations, never against core capability.
  assert.ok(selected.includes("Write"));
  assert.ok(selected.length < tools.length);
});

test("dynamic tool working set gives coding turns code tools without unrelated integrations", () => {
  const selected = names(selectToolsForTurn(tools, user("Make me a landing page and test it")));
  assert.ok(selected.includes("Read"));
  assert.ok(selected.includes("Write"));
  assert.ok(selected.includes("PowerShell"));
  assert.ok(selected.includes("Browser"));
  assert.ok(!selected.includes("Stripe"));
  assert.ok(!selected.includes("Gmail"));
});

test("recently used tool schemas survive terse follow-ups", () => {
  const history = [
    ...user("Create an invoice in Stripe"),
    { id: "a", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Stripe", input: {} }], createdAt: new Date(0).toISOString() },
    { id: "r", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], createdAt: new Date(0).toISOString() },
    ...user("Do that again"),
  ];
  assert.ok(names(selectToolsForTurn(tools, history)).includes("Stripe"));
});

test("desktop transport keeps voice instructions out of the user goal", async () => {
  const app = await readFile(new URL("../tauri/src/App.tsx", import.meta.url), "utf8");
  const daemon = await readFile(new URL("../packages/cli/src/entry/daemon.ts", import.meta.url), "utf8");
  assert.doesNotMatch(app, /const voiceDirective/);
  assert.match(app, /invoke\("ares_send", \{ goal, sessionId: sid, voice:/);
  assert.match(daemon, /voiceMode\) turnContent\.unshift\(\{ type: "system_reminder", text: "<voice-mode\/>" \}\)/);
});

test("desktop transcript hides internal reminders and labels fresh input", async () => {
  // The transcript reducer moved to state/foldEvent.ts in the UI
  // modularization; the reminder-hiding logic lives there now, while the
  // token accounting stayed with App's status rendering.
  const app = await readFile(new URL("../tauri/src/App.tsx", import.meta.url), "utf8");
  const fold = await readFile(new URL("../tauri/src/state/foldEvent.ts", import.meta.url), "utf8");
  assert.match(fold, /if \(!visible\) break/);
  const combined = app + fold;
  assert.match(combined, /const freshInput = Math\.max\(0, item\.input - item\.cacheRead\)/);
  assert.match(combined, /cacheReadTokens/);
});
