import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { projectMessagesFromKernel, SessionKernelStore } from "../packages/core/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

test("kernel projection repairs every dangling tool_use from the durable execution ledger", () => {
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "repair-session" });
    const lease = store.acquireRunnerLease("repair-session", "repair-test", 5_000);
    const fence = {
      sessionId: lease.sessionId,
      generation: lease.generation,
      leaseToken: lease.leaseToken,
    };
    store.appendMessage(fence, {
      id: "assistant-tools",
      role: "assistant",
      parts: [
        { type: "tool_use", data: { type: "tool_use", id: "settled-use", name: "Write", input: { file_path: "a" } } },
        { type: "tool_use", data: { type: "tool_use", id: "failed-use", name: "Bash", input: { command: "build" } } },
        { type: "tool_use", data: { type: "tool_use", id: "unknown-use", name: "Bash", input: { command: "build" } } },
        { type: "tool_use", data: { type: "tool_use", id: "never-admitted", name: "Edit", input: {} } },
      ],
    });

    let settled = store.beginToolRun(fence, {
      callKey: `${fence.generation}:settled-use`,
      toolName: "Write",
      arguments: { file_path: "a" },
      effectKind: "workspace-write",
    });
    settled = store.transitionToolRun(fence, settled.id, "executing");
    store.transitionToolRun(fence, settled.id, "succeeded", { result: { path: "a", bytesWritten: 4 } });

    let failed = store.beginToolRun(fence, {
      callKey: `${fence.generation}:failed-use`,
      toolName: "Bash",
      arguments: { command: "build" },
      effectKind: "workspace-write",
    });
    failed = store.transitionToolRun(fence, failed.id, "executing");
    store.transitionToolRun(fence, failed.id, "failed", {
      result: {
        command: "bash -lc build",
        exitCode: 7,
        stdout: "stdout survives recovery",
        stderr: "stderr survives recovery",
        durationMs: 42,
        timedOut: false,
        truncated: true,
        fullOutputPath: "/workspace/.ares/shell-output/full.log",
      },
      error: { message: "Bash exited with code 7" },
    });

    let unknown = store.beginToolRun(fence, {
      callKey: `${fence.generation}:unknown-use`,
      toolName: "Bash",
      arguments: { command: "build" },
      effectKind: "workspace-write",
    });
    unknown = store.transitionToolRun(fence, unknown.id, "executing");
    store.transitionToolRun(fence, unknown.id, "effect_unknown", { error: { message: "runner disappeared" } });

    const projected = projectMessagesFromKernel(store, "repair-session");
    assert.equal(projected.length, 2);
    assert.equal(projected[0].role, "assistant");
    assert.equal(projected[1].role, "user");
    const results = projected[1].content.filter((block) => block.type === "tool_result");
    assert.deepEqual(results.map((block) => block.tool_use_id), ["settled-use", "failed-use", "unknown-use", "never-admitted"]);
    assert.equal(results[0].is_error, undefined);
    assert.match(results[0].content, /bytesWritten/);
    assert.equal(results[1].is_error, true);
    assert.match(results[1].content, /^Bash exited with code 7/);
    assert.match(results[1].content, /stdout survives recovery/);
    assert.match(results[1].content, /stderr survives recovery/);
    assert.match(results[1].content, /"exitCode":7/);
    assert.match(results[1].content, /fullOutputPath/);
    assert.equal(results[2].is_error, true);
    assert.match(results[2].content, /unknown effect/i);
    assert.equal(results[3].is_error, true);
    assert.match(results[3].content, /no durable execution record/i);
  } finally {
    store.close();
  }
});

test("kernel projection never duplicates an already persisted tool_result", () => {
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "existing-result" });
    const lease = store.acquireRunnerLease("existing-result", "repair-test", 5_000);
    const fence = { sessionId: lease.sessionId, generation: lease.generation, leaseToken: lease.leaseToken };
    store.appendMessage(fence, {
      id: "assistant-one",
      role: "assistant",
      parts: [{ type: "tool_use", data: { type: "tool_use", id: "call-one", name: "Read", input: {} } }],
    });
    store.appendMessage(fence, {
      id: "result-one",
      role: "tool",
      parts: [{ type: "tool_result", data: { type: "tool_result", tool_use_id: "call-one", content: "original" } }],
    });

    const projected = projectMessagesFromKernel(store, "existing-result");
    const results = projected.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "original");
  } finally {
    store.close();
  }
});
