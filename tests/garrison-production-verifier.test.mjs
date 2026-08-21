import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createVerifiedGarrisonCoreSession,
  loadCanonicalGarrisonVerificationDebt,
} from "../packages/cli/dist/entry/garrisonCmd.js";
import {
  openWorkspaceSessionKernel,
  projectMessagesFromKernel,
} from "../packages/core/dist/index.js";

function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "garrison-production-scripted",
    get calls() {
      return call;
    },
    async *stream() {
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        const id = `tool_${call}`;
        yield { type: "tool_use_start", id, name: script.tool.name };
        yield { type: "tool_use_input_done", id, input: script.tool.input };
        yield {
          type: "message_done",
          message: {
            id: `message_${call}`,
            role: "assistant",
            content: [{ type: "tool_use", id, name: script.tool.name, input: script.tool.input }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: script.text };
      yield {
        type: "message_done",
        message: {
          id: `message_${call}`,
          role: "assistant",
          content: [{ type: "text", text: script.text }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function editTool(touched) {
  return {
    schema: {
      name: "Edit",
      description: "Synthetic production edit",
      inputJsonSchema: { type: "object" },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call() {
      return { output: "edited", touchedFiles: [touched] };
    },
  };
}

async function createRedCanonicalSession(workspace, kernel, sessionId, touched) {
  let verificationRuns = 0;
  const verified = createVerifiedGarrisonCoreSession({
    workspace,
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: touched } } },
      { text: "claiming completion despite red checks" },
    ]),
    model: "scripted",
    systemPrompt: "seed durable Garrison verification debt",
    tools: [editTool(touched)],
    sessionId,
    telemetryDir: path.join(workspace, "telemetry"),
    sessionRegistryHome: workspace,
    sessionKernel: kernel,
  }, {
    debounceMs: 60_000,
    async runCommand(command) {
      verificationRuns += 1;
      return {
        ok: false,
        command,
        exitCode: 1,
        stdoutTail: "not ok 1 - durable red check",
        stderrTail: "AssertionError: still red",
        durationMs: 1,
      };
    },
  });
  try {
    const events = [];
    for await (const event of verified.session.send("make a change")) events.push(event);
    const workStatus = events.findLast((event) => event.type === "turn_end")?.workStatus;
    assert.ok(workStatus === "unverified" || workStatus === "blocked");
    assert.equal(verificationRuns, 1);
  } finally {
    await verified.dispose();
  }
}

test("production Garrison factory schedules touched files and settles behavioral proof before completion", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-production-verify-"));
  const touched = path.join(workspace, "feature.test.mjs");
  await fs.writeFile(touched, "import test from 'node:test';\ntest('feature', () => {});\n", "utf8");
  const provider = scriptedProvider([
    { tool: { name: "Edit", input: { file_path: touched } } },
    { text: "implemented and verified" },
  ]);
  const commands = [];
  const kernel = await openWorkspaceSessionKernel(workspace);
  const verified = createVerifiedGarrisonCoreSession({
    workspace,
    provider,
    model: "scripted",
    systemPrompt: "production garrison verifier regression",
    tools: [{
      schema: {
        name: "Edit",
        description: "Synthetic production edit",
        inputJsonSchema: { type: "object" },
        safety: "workspace-write",
        concurrency: "exclusive",
      },
      async call() {
        return { output: "edited", touchedFiles: [touched] };
      },
    }],
    sessionId: "garrison-production-verifier",
    telemetryDir: path.join(workspace, "telemetry"),
    sessionRegistryHome: workspace,
    sessionKernel: kernel,
  }, {
    // A long debounce proves the end-of-turn callback actively flushes the
    // verifier; the background timer could not win the race by itself.
    debounceMs: 60_000,
    async runCommand(command) {
      commands.push(command);
      return {
        ok: true,
        command,
        exitCode: 0,
        stdoutTail: "pass",
        stderrTail: "",
        durationMs: 1,
      };
    },
  });

  try {
    const events = [];
    for await (const event of verified.session.send("change the feature")) events.push(event);

    assert.equal(provider.calls, 2, "the verifier settles after the edit and before accepting completion");
    assert.equal(commands.length, 1);
    assert.match(commands[0].label, /tests/i, "touched test file derives a behavioral check");
    const evidence = verified.verifier.evidenceSnapshot();
    assert.equal(evidence.mutationGeneration, 1);
    assert.equal(evidence.scheduledRuns, 1);
    assert.equal(evidence.finishedCommands, 1);
    assert.equal(evidence.passedCommands, 1);
    assert.equal(evidence.latestRunGeneration, 1);
    assert.equal(evidence.latestRunStatus, "passed");
    assert.equal(evidence.latestRunStrength, "behavioral");
    const end = events.findLast((event) => event.type === "turn_end");
    assert.equal(end?.status, "completed");
    assert.equal(end?.workStatus, "verified");
  } finally {
    await verified.dispose();
    kernel.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("production Garrison verifier also schedules failed tools that mutated files", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-failed-mutation-"));
  const touched = path.join(workspace, "failed-command.test.mjs");
  await fs.writeFile(touched, "import test from 'node:test';\ntest('partial output', () => {});\n", "utf8");
  const provider = scriptedProvider([
    { tool: { name: "Edit", input: { file_path: touched } } },
    { text: "the partial mutation is now checked" },
  ]);
  let verificationRuns = 0;
  const kernel = await openWorkspaceSessionKernel(workspace);
  const verified = createVerifiedGarrisonCoreSession({
    workspace,
    provider,
    model: "scripted",
    systemPrompt: "failed mutation verifier regression",
    tools: [{
      schema: {
        name: "Edit",
        description: "Synthetic command that writes before failing",
        inputJsonSchema: { type: "object" },
        safety: "workspace-write",
        concurrency: "exclusive",
      },
      async call() {
        return {
          output: { exitCode: 1 },
          touchedFiles: [touched],
          failure: "synthetic command failed after writing",
        };
      },
    }],
    sessionId: "garrison-failed-mutation-verifier",
    telemetryDir: path.join(workspace, "telemetry"),
    sessionRegistryHome: workspace,
    sessionKernel: kernel,
  }, {
    debounceMs: 60_000,
    async runCommand(command) {
      verificationRuns += 1;
      return {
        ok: true,
        command,
        exitCode: 0,
        stdoutTail: "pass",
        stderrTail: "",
        durationMs: 1,
      };
    },
  });

  try {
    const events = [];
    for await (const event of verified.session.send("run the mutating command")) events.push(event);
    const failed = events.find(
      (event) => event.type === "tool_error" && /synthetic command failed/.test(event.error),
    );
    assert.ok(failed, `expected declared failure event, got ${JSON.stringify(events.filter((event) => event.type === "tool_error"))}`);
    assert.deepEqual(failed?.touchedFiles, [touched]);
    const evidence = verified.verifier.evidenceSnapshot();
    assert.equal(
      verificationRuns,
      1,
      `tool_error touchedFiles enter the same verifier queue as tool_end; evidence=${JSON.stringify(evidence)} calls=${provider.calls}`,
    );
    assert.equal(evidence.mutationGeneration, 1);
    assert.equal(events.findLast((event) => event.type === "turn_end")?.workStatus, "verified");
  } finally {
    await verified.dispose();
    kernel.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("canonical Garrison restart reschedules red debt in a fresh verifier generation", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-resume-debt-"));
  const touched = path.join(workspace, "resume-debt.test.mjs");
  await fs.writeFile(touched, "import test from 'node:test';\ntest('resume debt', () => {});\n", "utf8");
  const kernel = await openWorkspaceSessionKernel(workspace);
  const sessionId = "garrison-resume-red";
  try {
    await createRedCanonicalSession(workspace, kernel, sessionId, touched);
    assert.ok(["unverified", "blocked"].includes(kernel.requireSession(sessionId).workOutcome));

    const debtBySession = await loadCanonicalGarrisonVerificationDebt(kernel, workspace);
    const debt = debtBySession.get(sessionId);
    assert.deepEqual(debt, {
      required: true,
      touchedFiles: [touched],
      scopeComplete: true,
    });

    let resumedRuns = 0;
    const resumed = createVerifiedGarrisonCoreSession({
      workspace,
      provider: scriptedProvider([{ text: "no new mutation; finish the resumed work" }]),
      model: "scripted",
      systemPrompt: "resume canonical Garrison session",
      tools: [editTool(touched)],
      sessionId,
      initialMessages: projectMessagesFromKernel(kernel, sessionId),
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
      sessionKernel: kernel,
    }, {
      debounceMs: 60_000,
      async runCommand(command) {
        resumedRuns += 1;
        return {
          ok: true,
          command,
          exitCode: 0,
          stdoutTail: "pass",
          stderrTail: "",
          durationMs: 1,
        };
      },
    }, debt);
    try {
      assert.equal(resumed.verifier.evidenceSnapshot().mutationGeneration, 1, "restored scope schedules a fresh generation before the resumed turn");
      const events = [];
      for await (const event of resumed.session.send("continue without editing")) events.push(event);
      assert.equal(resumedRuns, 1);
      assert.equal(resumed.verifier.evidenceSnapshot().latestRunGeneration, 1);
      assert.equal(events.findLast((event) => event.type === "turn_end")?.workStatus, "verified");
    } finally {
      await resumed.dispose();
    }
  } finally {
    kernel.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("canonical Garrison restart fails closed when red debt scope is missing", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-resume-missing-scope-"));
  const touched = path.join(workspace, "missing-scope.test.mjs");
  await fs.writeFile(touched, "import test from 'node:test';\ntest('missing scope', () => {});\n", "utf8");
  const kernel = await openWorkspaceSessionKernel(workspace);
  const sessionId = "garrison-resume-missing-scope";
  try {
    kernel.createSession({ id: sessionId, workspaceKey: workspace });
    const lease = kernel.acquireRunnerLease(sessionId, "missing-scope-seed", 30_000);
    kernel.releaseRunnerLease({
      sessionId: lease.sessionId,
      generation: lease.generation,
      leaseToken: lease.leaseToken,
    }, {
      executionState: "failed",
      workOutcome: "blocked",
      error: { message: "legacy/crash window retained no canonical mutation scope" },
    });

    const debt = (await loadCanonicalGarrisonVerificationDebt(kernel, workspace)).get(sessionId);
    assert.deepEqual(debt, { required: true, touchedFiles: [], scopeComplete: false });

    let verifierRuns = 0;
    const resumed = createVerifiedGarrisonCoreSession({
      workspace,
      provider: scriptedProvider([{ text: "claim done without recoverable scope" }]),
      model: "scripted",
      systemPrompt: "missing-scope canonical restart",
      tools: [editTool(touched)],
      sessionId,
      initialMessages: projectMessagesFromKernel(kernel, sessionId),
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
      sessionKernel: kernel,
    }, {
      async runCommand(command) {
        verifierRuns += 1;
        return {
          ok: true,
          command,
          exitCode: 0,
          stdoutTail: "pass",
          stderrTail: "",
          durationMs: 1,
        };
      },
    }, debt);
    try {
      const events = [];
      for await (const event of resumed.session.send("continue without editing")) events.push(event);
      assert.equal(verifierRuns, 0, "unknown scope cannot fabricate a passing verifier run");
      const workStatus = events.findLast((event) => event.type === "turn_end")?.workStatus;
      assert.notEqual(workStatus, "not_applicable");
      assert.notEqual(workStatus, "verified");
    } finally {
      await resumed.dispose();
    }
  } finally {
    kernel.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
