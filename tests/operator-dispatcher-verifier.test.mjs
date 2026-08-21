import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  QueryEngineDispatcher,
  createGoal,
  saveGoal,
  tickGoal,
} from "../packages/operator/dist/index.js";
import { SessionKernelStore } from "../packages/core/dist/index.js";

function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "operator-verifier-scripted",
    async *stream() {
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        const id = `operator_tool_${call}`;
        yield { type: "tool_use_start", id, name: script.tool.name };
        yield { type: "tool_use_input_done", id, input: script.tool.input };
        yield {
          type: "message_done",
          message: {
            id: `operator_message_${call}`,
            role: "assistant",
            content: [{ type: "tool_use", id, name: script.tool.name, input: script.tool.input }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      const text = script.text ?? "goal is fully met";
      yield { type: "text_delta", text };
      yield {
        type: "message_done",
        message: {
          id: `operator_message_${call}`,
          role: "assistant",
          content: [{ type: "text", text }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function tool(name, safety, call) {
  return {
    schema: {
      name,
      description: `${name} regression tool`,
      inputJsonSchema: { type: "object" },
      safety,
      concurrency: "exclusive",
    },
    call,
  };
}

test("durable Operator refuses normal progress when a worker write verifies red", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-operator-red-worker-"));
  const kernel = await SessionKernelStore.open({ filename: path.join(workspace, "operator-kernel.sqlite") });
  const touched = path.join(workspace, "operator-change.test.mjs");
  await fs.writeFile(touched, "import test from 'node:test';\ntest('operator change', () => {});\n", "utf8");
  let verificationRuns = 0;
  const dispatcher = new QueryEngineDispatcher({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: touched } } },
      { text: "goal is fully met" },
    ]),
    model: "scripted",
    workspace,
    tools: [tool("Edit", "workspace-write", async () => ({
      output: "changed",
      touchedFiles: [touched],
    }))],
    sessionKernel: kernel,
    telemetryDir: path.join(workspace, "telemetry"),
    sessionRegistryHome: workspace,
    evaluate: () => ({ moved: true, goalMet: true, evidence: "model claimed success" }),
    childVerifierOptions: {
      // The completion barrier must flush this; the background debounce cannot
      // finish before the worker tries to declare success.
      debounceMs: 60_000,
      async runCommand(command) {
        verificationRuns += 1;
        return {
          ok: false,
          command,
          exitCode: 1,
          stdoutTail: "not ok 1 - operator change",
          stderrTail: "AssertionError: expected green",
          durationMs: 1,
        };
      },
    },
  });

  try {
    const verdict = await dispatcher.runStep(
      createGoal({ id: "operator-red-proof", statement: "make a verified change" }),
      { signal: new AbortController().signal, now: () => new Date() },
    );

    assert.equal(verificationRuns, 1, "the Operator worker write entered its child-local verifier");
    assert.equal(verdict.moved, false, "red code cannot advance long-horizon progress");
    assert.equal(verdict.goalMet, false, "model prose cannot self-certify over red proof");
    assert.ok(verdict.workStatus === "unverified" || verdict.workStatus === "blocked");
    assert.match(verdict.evidence, /worker changes (?:unverified|blocked)/i);

    const goalRoot = kernel.listSessions().find((session) => session.id.startsWith("operator_goal_"));
    const worker = goalRoot ? kernel.listChildSessions(goalRoot.id)[0]?.session : null;
    assert.ok(worker);
    assert.equal(worker.workOutcome, verdict.workStatus, "canonical child row retains the proof-bearing outcome");
  } finally {
    kernel.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("durable Operator read-only worker remains eligible to make progress", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-operator-read-worker-"));
  const kernel = await SessionKernelStore.open({ filename: path.join(workspace, "operator-kernel.sqlite") });
  let verificationRuns = 0;
  const dispatcher = new QueryEngineDispatcher({
    provider: scriptedProvider([
      { tool: { name: "Read", input: { file_path: "README.md" } } },
      { text: "goal is fully met" },
    ]),
    model: "scripted",
    workspace,
    tools: [tool("Read", "read-only", async () => ({ output: "observed state" }))],
    sessionKernel: kernel,
    telemetryDir: path.join(workspace, "telemetry"),
    sessionRegistryHome: workspace,
    evaluate: () => ({ moved: true, goalMet: true, evidence: "read-only result accepted" }),
    childVerifierOptions: {
      async runCommand(command) {
        verificationRuns += 1;
        return {
          ok: false,
          command,
          exitCode: 1,
          stdoutTail: "",
          stderrTail: "must not run",
          durationMs: 1,
        };
      },
    },
  });

  try {
    const verdict = await dispatcher.runStep(
      createGoal({ id: "operator-read-only", statement: "inspect current state" }),
      { signal: new AbortController().signal, now: () => new Date() },
    );

    assert.equal(verificationRuns, 0);
    assert.equal(verdict.workStatus, "not_applicable");
    assert.equal(verdict.moved, true);
    assert.equal(verdict.goalMet, true);
  } finally {
    kernel.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a green reality probe cannot overwrite a red worker proof status", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-operator-proof-precedence-"));
  const artifact = path.join(home, "artifact.txt");
  const goal = createGoal({
    id: "operator-proof-precedence",
    statement: "produce a verified artifact",
    verification: { kind: "file", path: artifact },
  });
  await saveGoal(home, goal);

  const after = await tickGoal({
    home,
    workspace: home,
    dispatcher: {
      async runStep() {
        await fs.writeFile(artifact, "exists but worker checks are red", "utf8");
        return {
          moved: false,
          goalMet: false,
          workStatus: "unverified",
          evidence: "worker changes unverified: behavioral check failed",
        };
      },
    },
  }, goal);

  assert.equal(after.status, "active", "artifact existence alone cannot certify a red coding step");
  assert.equal(after.progress, 0);
  assert.equal(after.stepLog[0].goalMet, false);
  assert.equal(after.stepLog[0].moved, false);
  assert.equal(after.stepLog[0].workStatus, "unverified");
  assert.match(after.stepLog[0].evidence, /worker changes unverified/i);
  await fs.rm(home, { recursive: true, force: true });
});
