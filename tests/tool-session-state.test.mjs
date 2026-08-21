// Shared tool catalogs must route mutable state through ToolCallContext. This
// is what lets Garrison reuse schemas/closures without sharing todos or shell
// process handles across independent sessions.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TodoStore,
  adaptToolForEngine,
  makeBashOutputTool,
  makeKillShellTool,
  makeTodoWriteTool,
} from "../packages/tools/dist/index.js";

const callContext = () => ({
  workspace: ".",
  sessionId: "sess-routed",
  signal: new AbortController().signal,
  requestPermission: async () => "allow_once",
});

test("shared tools prefer session-routed todo and shell state over captured fallbacks", async () => {
  const fallbackTodos = new TodoStore();
  const routedTodos = new TodoStore();
  let fallbackPolls = 0;
  let fallbackKills = 0;
  const fallbackShells = {
    poll() { fallbackPolls++; return null; },
    has() { return true; },
    get() { return { status: "running" }; },
    async kill() { fallbackKills++; return false; },
  };
  let routedPolls = 0;
  let routedKills = 0;
  const shell = {
    id: "sh_routed",
    description: "routed shell",
    command: "test",
    cwd: ".",
    status: "running",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    totalChars: 2,
  };
  const routedShells = {
    poll(id) {
      routedPolls++;
      return id === shell.id ? { snapshot: shell, output: "ok", newChunks: 1 } : null;
    },
    has(id) { return id === shell.id; },
    get(id) { return id === shell.id ? shell : undefined; },
    async kill(id) { routedKills++; return id === shell.id; },
  };
  const enrich = (base) => ({
    ...base,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
    todoStore: routedTodos,
    shellRegistry: routedShells,
  });

  const todo = adaptToolForEngine(makeTodoWriteTool(fallbackTodos), enrich);
  await todo.call({
    todos: [{ id: "one", content: "isolated", activeForm: "isolating", status: "in_progress" }],
  }, callContext());
  assert.equal(routedTodos.list()[0]?.content, "isolated");
  assert.equal(fallbackTodos.list().length, 0, "captured fallback was not mutated");

  const output = adaptToolForEngine(makeBashOutputTool(fallbackShells), enrich);
  const polled = await output.call({ shell_id: shell.id }, callContext());
  assert.equal(polled.output.output, "ok");

  const kill = adaptToolForEngine(makeKillShellTool(fallbackShells), enrich);
  const killed = await kill.call({ shell_id: shell.id }, callContext());
  assert.equal(killed.output.killed, true);
  assert.equal(routedPolls, 1);
  assert.equal(routedKills, 1);
  assert.equal(fallbackPolls, 0);
  assert.equal(fallbackKills, 0);
});
