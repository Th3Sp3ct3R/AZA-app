import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AresSubagentRunner,
  SessionKernelStore,
  SubagentRegistry,
  runFleet,
} from "../packages/core/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

function childProvider(prefix = "child") {
  let calls = 0;
  return {
    name: "verified-child-scripted",
    get calls() {
      return calls;
    },
    async *stream(request) {
      calls += 1;
      const hasToolResult = request.messages.some(
        (message) => message.role === "user" && message.content.some((block) => block.type === "tool_result"),
      );
      if (!hasToolResult) {
        const id = `${prefix}_edit_${calls}`;
        const input = { file_path: "feature.test.mjs" };
        yield { type: "tool_use_start", id, name: "Edit" };
        yield { type: "tool_use_input_done", id, input };
        yield {
          type: "message_done",
          message: {
            id: `${prefix}_message_${calls}`,
            role: "assistant",
            content: [{ type: "tool_use", id, name: "Edit", input }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: {
          id: `${prefix}_message_${calls}`,
          role: "assistant",
          content: [{ type: "text", text: "child implementation complete" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function editTool() {
  return {
    schema: {
      name: "Edit",
      description: "Synthetic child edit",
      inputJsonSchema: { type: "object" },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call(_input, ctx) {
      const touched = path.join(ctx.workspace, "feature.test.mjs");
      await fs.mkdir(path.dirname(touched), { recursive: true });
      await fs.writeFile(
        touched,
        "import test from 'node:test';\ntest('child feature', () => {});\n",
        "utf8",
      );
      return { output: "edited", touchedFiles: [touched] };
    },
  };
}

function failedEditTool() {
  const base = editTool();
  return {
    ...base,
    async call(input, ctx) {
      const result = await base.call(input, ctx);
      return { ...result, output: { exitCode: 1 }, failure: "failed after writing child output" };
    },
  };
}

function resultFor(command, ok) {
  return {
    ok,
    command,
    exitCode: ok ? 0 : 1,
    stdoutTail: ok ? "pass" : "",
    stderrTail: ok ? "" : "synthetic child failure",
    durationMs: 1,
  };
}

test("durable Task children accept writes only from fresh evidence rooted in that child workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ares-task-child-verifier-"));
  const greenWorkspace = path.join(root, "green");
  const redWorkspace = path.join(root, "red");
  await Promise.all([fs.mkdir(greenWorkspace), fs.mkdir(redWorkspace)]);
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  const commands = [];
  try {
    store.createSession({ id: "task-parent", workspaceKey: root });
    const runner = new AresSubagentRunner({
      registry: new SubagentRegistry([{
        name: "writer",
        description: "writes and proves one child change",
        systemPrompt: "write the requested feature",
        toolWhitelist: ["Edit"],
        maxTurns: 6,
      }]),
      provider: childProvider(),
      model: "scripted",
      parentTools: [editTool()],
      baseSystemPrompt: "child verifier regression",
      sessionKernel: store,
      contextBudgetTokens: 0,
      childVerifierOptions: {
        debounceMs: 60_000,
        async runCommand(command) {
          commands.push(command);
          return resultFor(command, path.resolve(command.cwd) === path.resolve(greenWorkspace));
        },
      },
    });

    const green = await runner.run({
      subagent_type: "writer",
      description: "green child",
      prompt: "implement it",
      parentSessionId: "task-parent",
      invocationId: "green-invocation",
      workspace: greenWorkspace,
    });
    const red = await runner.run({
      subagent_type: "writer",
      description: "red child",
      prompt: "implement it",
      parentSessionId: "task-parent",
      invocationId: "red-invocation",
      workspace: redWorkspace,
    });

    assert.equal(green.workStatus, "verified");
    assert.notEqual(red.workStatus, "verified", "green evidence from a sibling child must not leak into a red child");
    assert.deepEqual(
      new Set(commands.map((command) => path.resolve(command.cwd))),
      new Set([path.resolve(greenWorkspace), path.resolve(redWorkspace)]),
      "each child owns a verifier rooted in its own workspace",
    );
    assert.ok(commands.every((command) => /tests/i.test(command.label)), "proof is behavior-capable, not a static-only check");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resumed red Task debt is rechecked by a fresh verifier before the child can become verified", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-task-resume-verifier-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  const registry = new SubagentRegistry([{
    name: "writer",
    description: "durable writer",
    systemPrompt: "write and verify",
    toolWhitelist: ["Edit"],
    maxTurns: 6,
  }]);
  try {
    store.createSession({ id: "resume-parent", workspaceKey: workspace });
    const firstRunner = new AresSubagentRunner({
      registry,
      provider: childProvider("first"),
      model: "scripted",
      parentTools: [editTool()],
      baseSystemPrompt: "resume verifier regression",
      sessionKernel: store,
      childVerifierOptions: {
        debounceMs: 60_000,
        async runCommand(command) {
          return resultFor(command, false);
        },
      },
    });
    const first = await firstRunner.run({
      subagent_type: "writer",
      description: "initial red write",
      prompt: "implement it",
      parentSessionId: "resume-parent",
      invocationId: "initial-write",
      workspace,
    });
    assert.notEqual(first.workStatus, "verified");
    const canonicalDebt = store.listUnresolvedSessionMutations(first.id);
    assert.equal(canonicalDebt.length, 1);
    assert.deepEqual(canonicalDebt[0].affectedPaths, [path.join(workspace, "feature.test.mjs")]);
    // SQLite is the restart authority. Delete the readable rollout entirely;
    // exact verifier scope must still be restored and rechecked.
    await fs.rm(path.join(workspace, ".ares", "sessions", first.id, "events.jsonl"), { force: true });

    let resumedVerificationRuns = 0;
    const resumedRunner = new AresSubagentRunner({
      registry,
      provider: childProvider("resumed"),
      model: "scripted",
      parentTools: [editTool()],
      baseSystemPrompt: "resume verifier regression",
      sessionKernel: store,
      childVerifierOptions: {
        debounceMs: 60_000,
        async runCommand(command) {
          resumedVerificationRuns += 1;
          return resultFor(command, true);
        },
      },
    });
    const resumed = await resumedRunner.run({
      subagent_type: "writer",
      description: "recheck durable work",
      prompt: "recheck the existing work and finish only if green",
      parentSessionId: "resume-parent",
      taskId: first.id,
      invocationId: "resume-check",
      workspace,
    });

    assert.equal(resumedVerificationRuns, 1, "restart creates and settles a new verifier generation for persisted debt");
    assert.equal(resumed.workStatus, "verified");
    assert.equal(store.listUnresolvedSessionMutations(first.id).length, 0, "verified restart resolves canonical debt");
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("durable read-only Task children remain not_applicable and schedule no proof work", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-task-readonly-verifier-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  let verificationRuns = 0;
  try {
    store.createSession({ id: "research-parent", workspaceKey: workspace });
    const provider = {
      name: "readonly-child",
      async *stream() {
        yield {
          type: "message_done",
          message: {
            id: "readonly-final",
            role: "assistant",
            content: [{ type: "text", text: "research complete" }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const runner = new AresSubagentRunner({
      registry: new SubagentRegistry([{
        name: "researcher",
        description: "read only",
        systemPrompt: "research",
        toolWhitelist: [],
        maxTurns: 2,
      }]),
      provider,
      model: "scripted",
      parentTools: [],
      baseSystemPrompt: "read only",
      sessionKernel: store,
      childVerifierOptions: {
        async runCommand(command) {
          verificationRuns += 1;
          return resultFor(command, true);
        },
      },
    });
    const result = await runner.run({
      subagent_type: "researcher",
      description: "inspect",
      prompt: "inspect only",
      parentSessionId: "research-parent",
      invocationId: "research-invocation",
      workspace,
    });
    assert.equal(result.workStatus, "not_applicable");
    assert.equal(verificationRuns, 0);
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("durable Task verifier schedules tool_error touchedFiles from a failed-after-write child tool", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-task-failed-write-verifier-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  let verificationRuns = 0;
  try {
    store.createSession({ id: "failed-write-parent", workspaceKey: workspace });
    const runner = new AresSubagentRunner({
      registry: new SubagentRegistry([{
        name: "writer",
        description: "failed writer",
        systemPrompt: "run the writer",
        toolWhitelist: ["Edit"],
        maxTurns: 6,
      }]),
      provider: childProvider(),
      model: "scripted",
      parentTools: [failedEditTool()],
      baseSystemPrompt: "failed write verifier regression",
      sessionKernel: store,
      childVerifierOptions: {
        debounceMs: 60_000,
        async runCommand(command) {
          verificationRuns += 1;
          return resultFor(command, true);
        },
      },
    });
    const result = await runner.run({
      subagent_type: "writer",
      description: "write then fail",
      prompt: "run it",
      parentSessionId: "failed-write-parent",
      invocationId: "failed-write-invocation",
      workspace,
    });
    assert.equal(verificationRuns, 1, "partial mutations on tool_error enter the child verifier queue");
    assert.deepEqual(result.handoff.filesTouched, [path.join(workspace, "feature.test.mjs")]);
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a red production Conductor child is never eligible for worktree merge", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ares-conductor-child-verifier-"));
  const branch = path.join(root, "branch");
  await fs.mkdir(branch);
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  let applied = 0;
  const verificationCwds = [];
  try {
    store.createSession({ id: "conductor-parent", workspaceKey: root });
    const result = await runFleet({
      phases: [{
        id: "build",
        kind: "parallel",
        build: true,
        isolation: "worktree",
        agents: [{ role: "red-writer", prompt: "implement the feature", tools: ["Edit"] }],
      }],
    }, {
      provider: childProvider(),
      model: "scripted",
      parentTools: [editTool()],
      baseSystemPrompt: "conductor child verifier regression",
      workspace: root,
      signal: new AbortController().signal,
      sessionKernel: store,
      parentSessionId: "conductor-parent",
      invocationId: "red-fleet-invocation",
      allowWriteTools: true,
      validate: (_schema, parsed) => ({ ok: true, value: parsed }),
      schemaHint: (schema) => JSON.stringify(schema),
      childVerifierOptions: {
        debounceMs: 60_000,
        async runCommand(command) {
          verificationCwds.push(path.resolve(command.cwd));
          return resultFor(command, false);
        },
      },
      makeWorktree: async () => ({
        dir: branch,
        changedFiles: async () => ["feature.test.mjs"],
        applyTo: async () => {
          applied += 1;
          return { applied: ["feature.test.mjs"], failed: [] };
        },
        cleanup: async () => {},
      }),
    });

    const leaf = result.phases[0]?.leaves[0];
    assert.ok(leaf);
    assert.equal(result.status, "failed");
    assert.notEqual(leaf.workStatus, "verified");
    assert.equal(applied, 0, "a failed child verifier keeps the branch out of the merge set");
    assert.deepEqual(verificationCwds, [path.resolve(branch)], "the verifier ran inside the child worktree");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
