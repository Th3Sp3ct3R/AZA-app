// The stringified-JSON arg repair in parseToolInputLenient: weaker models
// (observed live: glm-5.2) emit structured params as JSON-ENCODED STRINGS —
// `"todos": "[{...}]"` — which zod rejects as "Expected array, received
// string". The lenient parser now parses such strings at exactly the paths
// the SCHEMA declares non-scalar, and retries once. Free-text params that
// merely look like JSON are never touched.

import test from "node:test";
import assert from "node:assert/strict";
import { adaptToolForEngine, makeTodoWriteTool, TodoStore } from "../packages/tools/dist/index.js";

const enrich = (base) => ({ ...base, fileReadStamps: new Map() });
const ctx = () => ({
  workspace: ".",
  signal: new AbortController().signal,
  permissionMode: "workspace-write",
});

test("TodoWrite: todos as a JSON-encoded string is repaired into a real array", async () => {
  const store = new TodoStore();
  const tool = adaptToolForEngine(makeTodoWriteTool(store), enrich);
  const todos = [
    { id: "a", content: "fix camera", activeForm: "fixing camera", status: "in_progress" },
    { id: "b", content: "recompile", activeForm: "recompiling", status: "pending" },
  ];
  const result = await tool.call({ todos: JSON.stringify(todos) }, ctx());
  assert.ok(!/tool_use_error/.test(JSON.stringify(result.output ?? "")), "no validation error");
  assert.equal(store.list().length, 2, "both todos landed in the store");
  assert.equal(store.list()[0].content, "fix camera");
});

test("TodoWrite: a string that is NOT valid JSON still fails with the real zod error", async () => {
  const store = new TodoStore();
  const tool = adaptToolForEngine(makeTodoWriteTool(store), enrich);
  await assert.rejects(
    () => tool.call({ todos: "do the thing, then the other thing" }, ctx()),
    /invalid arguments/,
    "non-JSON strings are not silently swallowed",
  );
  assert.equal(store.list().length, 0);
});

test("TodoWrite: a JSON string of the WRONG shape fails validation after repair", async () => {
  const store = new TodoStore();
  const tool = adaptToolForEngine(makeTodoWriteTool(store), enrich);
  await assert.rejects(
    () => tool.call({ todos: JSON.stringify([{ nope: true }]) }, ctx()),
    /invalid arguments/,
    "repair does not bypass schema validation",
  );
});
