import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Session, SessionKernelStore } from "../packages/core/dist/index.js";
import { ShellRegistry } from "../packages/tools/dist/index.js";

// The deadline is a FAILURE ceiling, not an expected duration: a passing run
// returns the moment the condition holds, so a generous ceiling costs nothing
// on green and only makes a genuine hang take longer to report. Eight seconds
// was tight enough to lose a race on a loaded windows-latest runner — this test
// waits on real spawned processes while --test-concurrency=4 spawns more — and
// a CI that goes red without a regression trains you to ignore red.
//
// `diagnose` runs on timeout so a failure names the state it was stuck in.
// The v0.39.0 release flake burned the full 30s and reported NOTHING — the job
// had settled orphaned (a lost supervisor state-file write) and this loop was
// blindly waiting for "exited". Never let a waitFor fail without evidence.
async function waitFor(check, { timeoutMs = 30_000, diagnose } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const detail = diagnose ? `\n${diagnose()}` : "";
  throw new Error(`timed out waiting for durable background job${detail}`);
}

// Render everything a hung waitFor needs to be triaged from a CI log alone:
// the durable record and the supervisor's token-bound state file.
function describeJob(kernel, jobId) {
  const job = kernel.getBackgroundJob(jobId);
  let supervisorState = "<unreadable>";
  try {
    supervisorState = job?.statePath ? readFileSync(job.statePath, "utf8").trim() : "<no statePath>";
  } catch (error) {
    supervisorState = `<${error.code ?? error.message}>`;
  }
  return `job=${JSON.stringify(job)}\nsupervisorState=${supervisorState}`;
}

test("background shell survives registry replacement with durable output, terminal truth, and one completion", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-background-shell-"));
  const kernel = await SessionKernelStore.open({ filename: path.join(workspace, "sessions.sqlite") });
  try {
    kernel.createSession({ id: "parent", workspaceKey: workspace });
    const launch = {
      program: process.execPath,
      args: ["-e", "console.log('first'); setTimeout(() => { console.error('second'); process.exit(0) }, 350)"],
      cwd: workspace,
      description: "emit durable output",
      sessionId: "parent",
      invocationKey: "tool-shell-1",
    };
    const firstHost = new ShellRegistry().configureDurability({ kernel, workspace });
    const launched = await firstHost.spawn(launch);
    assert.equal(launched.durable, true);
    assert.equal(launched.status, "running");

    // Simulate losing every in-process ChildProcess/stream handle. Replaying
    // the stable tool call discovers the same supervisor instead of spawning a
    // second command.
    firstHost.detachAll();
    const secondHost = new ShellRegistry().configureDurability({ kernel, workspace });
    const replay = await secondHost.spawn(launch);
    assert.equal(replay.id, launched.id);
    assert.equal(kernel.listBackgroundJobs("parent", { kind: "shell" }).length, 1);

    const terminal = await waitFor(() => {
      const polled = secondHost.poll(launched.id, "model", undefined, "parent");
      const status = polled?.snapshot.status;
      // A wrong TERMINAL state will never become "exited" — fail now with the
      // actual state instead of silently burning the whole ceiling.
      if (status && status !== "running" && status !== "exited") {
        throw new Error(`durable job settled ${status} instead of exited\n${describeJob(kernel, launched.id)}`);
      }
      return status === "exited" ? polled : null;
    }, { diagnose: () => describeJob(kernel, launched.id) });
    assert.equal(terminal.snapshot.exitCode, 0);
    // The first polling loop may have acknowledged the first chunk. A distinct
    // durable audit cursor can read the complete append-only spool once.
    const audit = secondHost.poll(launched.id, "audit", undefined, "parent");
    assert.match(audit?.output ?? "", /\[stdout\] first/);
    assert.match(audit?.output ?? "", /\[stderr\] second/);
    const thirdHost = new ShellRegistry().configureDurability({ kernel, workspace });
    assert.equal(thirdHost.poll(launched.id, "audit", undefined, "parent")?.output, "");

    const job = kernel.getBackgroundJob(launched.id);
    assert.equal(job?.status, "completed");
    assert.ok(job?.outputPath);
    assert.equal(job?.completionInputId !== null, true);
    assert.equal(
      kernel.listInputs("parent").filter((input) => input.id === job?.completionInputId).length,
      1,
    );
  } finally {
    kernel.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a recovered registry can terminate a durable supervisor by session-owned job id", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-background-kill-"));
  const kernel = await SessionKernelStore.open({ filename: path.join(workspace, "sessions.sqlite") });
  try {
    kernel.createSession({ id: "owner", workspaceKey: workspace });
    kernel.createSession({ id: "other", workspaceKey: workspace });
    const launch = {
      program: process.execPath,
      args: ["-e", "setInterval(() => console.log('alive'), 100)"],
      cwd: workspace,
      description: "run until killed",
      sessionId: "owner",
      invocationKey: "tool-shell-kill",
    };
    const original = new ShellRegistry().configureDurability({ kernel, workspace });
    const shell = await original.spawn(launch);
    original.detachAll();

    const recovered = new ShellRegistry().configureDurability({ kernel, workspace });
    assert.equal(recovered.has(shell.id, "other"), false, "another session cannot inspect the job");
    assert.equal(await recovered.kill(shell.id, "user", "other"), false);
    assert.equal(await recovered.kill(shell.id, "user", "owner"), true);
    await waitFor(() => {
      const status = recovered.get(shell.id, "owner")?.status;
      return status === "killed" || status === "errored" || status === "orphaned";
    }, { diagnose: () => describeJob(kernel, shell.id) });
  } finally {
    kernel.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an idle parent drains a detached completion before its next real input without blocking FIFO", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-background-delivery-"));
  const kernel = await SessionKernelStore.open({ filename: path.join(workspace, "sessions.sqlite") });
  try {
    const requests = [];
    const provider = {
      name: "background-delivery-test",
      async *stream(request) {
        requests.push(request);
        yield {
          type: "message_done",
          message: {
            id: "delivery-reply",
            role: "assistant",
            content: [{ type: "text", text: "continued with result" }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const session = new Session({
      sessionId: "parent",
      workspace,
      provider,
      model: "mock",
      systemPrompt: "test",
      tools: [],
      sessionKernel: kernel,
      contextBudgetTokens: 0,
    });
    kernel.createBackgroundJob({
      id: "delivery-job",
      sessionId: "parent",
      invocationKey: "delivery-call",
      kind: "shell",
      description: "delivery test",
      request: { version: 1, program: "test", args: [], cwd: workspace },
    });
    kernel.markBackgroundJobRunning("delivery-job");
    kernel.settleBackgroundJob("delivery-job", {
      status: "completed",
      result: { ok: true },
      completion: {
        id: "delivery-completion",
        idempotencyKey: "background-job:delivery-job:completion",
        payload: {
          kind: "background-job-completion",
          jobId: "delivery-job",
          content: [{ type: "text", text: "background result is ready" }],
        },
      },
    });

    for await (const _event of session.sendContent(
      [{ type: "text", text: "use that result now" }],
      { inputId: "real-input" },
    )) {
      // drain
    }
    assert.equal(requests.length, 1, "the unattached control input never owns a deadlocking generator slot");
    const promptText = requests[0].messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.match(promptText, /background result is ready/);
    assert.match(promptText, /use that result now/);
    assert.equal(kernel.getInput("delivery-completion")?.state, "consumed");
    assert.equal(kernel.getInput("real-input")?.state, "consumed");
  } finally {
    kernel.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
