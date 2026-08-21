import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AresSubagentRunner,
  SessionKernelStore,
  SubagentRegistry,
} from "../packages/core/dist/index.js";
import { adaptToolForEngine, makeTaskTool } from "../packages/tools/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

function makeProvider(counter) {
  return {
    name: "durable-child-test",
    async *stream() {
      counter.calls += 1;
      yield {
        type: "message_done",
        message: {
          id: `child_reply_${counter.calls}`,
          role: "assistant",
          content: [{ type: "text", text: `child response ${counter.calls}` }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 2, outputTokens: 3 },
        stopReason: "end_turn",
      };
    },
  };
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for background task");
}

test("Task replay reconnects to one durable child and does not repeat provider work", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-task-replay-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "parent-session", workspaceKey: workspace });
    const counter = { calls: 0 };
    const runner = new AresSubagentRunner({
      registry: new SubagentRegistry([
        { name: "worker", description: "test worker", systemPrompt: "work", toolWhitelist: [], maxTurns: 2 },
      ]),
      provider: makeProvider(counter),
      model: "mock",
      parentTools: [],
      baseSystemPrompt: "base",
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const request = {
      subagent_type: "worker",
      description: "durable work",
      prompt: "perform it exactly once",
      parentSessionId: "parent-session",
      invocationId: "provider-tool-use-42",
      workspace,
    };

    const first = await runner.run(request);
    const transcriptAfterFirst = await readFile(first.transcriptPath, "utf8");
    const replay = await runner.run(request);
    const transcriptAfterReplay = await readFile(replay.transcriptPath, "utf8");

    assert.equal(first.id, replay.id, "the provider tool-use id determines the child session id");
    assert.equal(counter.calls, 1, "a consumed child input is never submitted to the provider twice");
    assert.equal(store.listChildSessions("parent-session").length, 1);
    assert.equal(store.listInputs(first.id).length, 1);
    assert.equal(store.listInputs(first.id)[0]?.state, "consumed");
    assert.equal(replay.summary.includes("child response 1"), true);
    assert.equal(transcriptAfterReplay, transcriptAfterFirst, "an empty replay must not erase the first transcript");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a different parent cannot claim a durable task id", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-task-parent-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "parent-a", workspaceKey: workspace });
    store.createSession({ id: "parent-b", workspaceKey: workspace });
    const runner = new AresSubagentRunner({
      registry: new SubagentRegistry([
        { name: "worker", description: "test worker", systemPrompt: "work", toolWhitelist: [], maxTurns: 2 },
      ]),
      provider: makeProvider({ calls: 0 }),
      model: "mock",
      parentTools: [],
      baseSystemPrompt: "base",
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const first = await runner.run({
      subagent_type: "worker",
      description: "owned task",
      prompt: "work",
      parentSessionId: "parent-a",
      invocationId: "tool-a",
      workspace,
    });

    await assert.rejects(
      runner.run({
        subagent_type: "worker",
        description: "steal task",
        prompt: "work",
        parentSessionId: "parent-b",
        taskId: first.id,
        invocationId: "tool-b",
        workspace,
      }),
      /different parent session/,
    );
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("detached Task returns immediately, settles durably, and injects its parent completion once", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-task-background-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "parent", workspaceKey: workspace });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const counter = { calls: 0 };
    const provider = {
      name: "background-child-test",
      async *stream() {
        counter.calls += 1;
        await gate;
        yield {
          type: "message_done",
          message: {
            id: "background_reply",
            role: "assistant",
            content: [{ type: "text", text: "detached result" }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 2 },
          stopReason: "end_turn",
        };
      },
    };
    const runner = new AresSubagentRunner({
      registry: new SubagentRegistry([
        { name: "worker", description: "test worker", systemPrompt: "work", toolWhitelist: [], maxTurns: 2 },
      ]),
      provider,
      model: "mock",
      parentTools: [],
      baseSystemPrompt: "base",
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const request = {
      subagent_type: "worker",
      description: "detached work",
      prompt: "finish after the foreground returns",
      parentSessionId: "parent",
      invocationId: "task-tool-background-1",
      workspace,
    };
    const taskTool = adaptToolForEngine(makeTaskTool(runner), (base) => ({
      ...base,
      permissionMode: "workspace-write",
      fileReadStamps: new Map(),
    }));
    const startedCall = await taskTool.call({
      subagent_type: request.subagent_type,
      description: request.description,
      prompt: request.prompt,
      run_in_background: true,
    }, {
      workspace,
      sessionId: "parent",
      toolUseId: request.invocationId,
      signal: new AbortController().signal,
      requestPermission: async () => "allow_once",
    });
    const started = {
      jobId: startedCall.output.jobId,
      taskId: startedCall.output.taskId,
      status: startedCall.output.status,
    };
    assert.match(started.jobId, /^taskjob_/);
    await waitFor(() =>
      runner.getBackground(started.jobId, "parent")?.status === "running" && counter.calls === 1,
    );
    release();
    const completed = await waitFor(() => {
      const value = runner.getBackground(started.jobId, "parent");
      return value?.status === "completed" ? value : null;
    });
    assert.equal(completed.taskId, started.taskId);
    assert.match(JSON.stringify(completed.result), /detached result/);
    const job = store.getBackgroundJob(started.jobId);
    assert.ok(job?.completionInputId);
    assert.equal(store.getInput(job.completionInputId)?.delivery, "steer");

    const replay = await runner.startBackground(request);
    assert.equal(replay.jobId, started.jobId);
    assert.equal(replay.status, "completed");
    assert.equal(counter.calls, 1, "replaying a completed background Task never calls the provider twice");
    assert.equal(
      store.listInputs("parent").filter((input) => input.id === job.completionInputId).length,
      1,
    );
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a new runner recovers a queued durable Task after host restart", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-task-recover-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "parent", workspaceKey: workspace });
    store.createBackgroundJob({
      id: "taskjob-recovery",
      sessionId: "parent",
      invocationKey: "recover-tool-use",
      kind: "task",
      description: "recover work",
      request: {
        version: 1,
        subagentType: "worker",
        description: "recover work",
        prompt: "resume me",
        parentSessionId: "parent",
        invocationId: "recover-tool-use",
        taskId: null,
        workspace,
      },
    });
    const counter = { calls: 0 };
    const runner = new AresSubagentRunner({
      registry: new SubagentRegistry([
        { name: "worker", description: "test worker", systemPrompt: "work", toolWhitelist: [], maxTurns: 2 },
      ]),
      provider: makeProvider(counter),
      model: "mock",
      parentTools: [],
      baseSystemPrompt: "base",
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const completed = await waitFor(() => {
      const value = runner.getBackground("taskjob-recovery", "parent");
      return value?.status === "completed" ? value : null;
    });
    assert.equal(counter.calls, 1);
    assert.match(JSON.stringify(completed.result), /child response 1/);
    assert.equal(store.listChildSessions("parent").length, 1);
    assert.ok(store.getBackgroundJob("taskjob-recovery")?.completionInputId);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
