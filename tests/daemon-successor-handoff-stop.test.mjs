import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openWorkspaceSessionKernel } from "../packages/core/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

test("Stop owns the exact deferred successor across the post-turn handoff", { timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-handoff-stop-workspace-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-handoff-stop-home-"));
  const sessionId = "successor-handoff-stop";
  const ownerInputId = "handoff-owner";
  const successorInputId = "handoff-successor";
  const nextInputId = "after-handoff-stop";
  const events = [];
  let stdoutBuffer = "";
  let stderr = "";
  let ownerSent = false;
  let successorSent = false;
  let stopSent = false;
  let nextSent = false;
  let completed = false;

  const child = spawn(
    process.execPath,
    [cliEntry, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        ARES_HOME: home,
        ARES_AGENT_ENABLED: "0",
        ARES_OPERATOR_AUTOTICK: "0",
        ARES_CODING_PROOF_GATE: "0",
        // Holds the engine-settlement and queued-successor boundaries just long
        // enough for stdin to deterministically exercise both sides.
        ARES_TEST_DAEMON_SUCCESSOR_HANDOFF_WINDOW_MS: "2500",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const writeCommand = (command) => child.stdin.write(JSON.stringify(command) + "\n");

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(
          `deferred successor handoff Stop timed out\nstdout=${stdoutBuffer}\nstderr=${stderr}\n` +
          `events=${JSON.stringify(events.slice(-80))}`,
        ));
      }, 45_000);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          events.push(event);

          if (event.type === "daemon_ready" && !ownerSent) {
            ownerSent = true;
            writeCommand({
              type: "send",
              sessionId,
              inputId: ownerInputId,
              goal: "ORIGINAL-HANDOFF-OWNER",
            });
          }
          if (
            event.type === "turn_end" &&
            event.sessionId === sessionId &&
            event.status === "completed" &&
            !successorSent
          ) {
            successorSent = true;
            writeCommand({
              type: "steer",
              sessionId,
              inputId: successorInputId,
              text: "DEFERRED-SUCCESSOR-MUST-NOT-RUN",
            });
          }
          if (
            event.type === "turn_settled" &&
            event.sessionId === sessionId &&
            event.inputId === ownerInputId &&
            event.continuing === true &&
            !stopSent
          ) {
            stopSent = true;
            writeCommand({ type: "interrupt", sessionId });
          }
          if (
            event.type === "turn_settled" &&
            event.sessionId === sessionId &&
            event.inputId === successorInputId &&
            !nextSent
          ) {
            nextSent = true;
            writeCommand({
              type: "send",
              sessionId,
              inputId: nextInputId,
              goal: "NEXT-AFTER-HANDOFF-STOP",
            });
          }
          if (
            event.type === "turn_settled" &&
            event.sessionId === sessionId &&
            event.inputId === nextInputId
          ) {
            completed = true;
            clearTimeout(deadline);
            resolve();
          }
        }
      });
      child.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.once("exit", (code) => {
        if (completed) return;
        clearTimeout(deadline);
        reject(new Error(`daemon exited before handoff recovery completed: ${code}\nstderr=${stderr}`));
      });
    });
  } finally {
    if (child.exitCode === null) {
      try { writeCommand({ type: "exit" }); } catch { /* process may be closing */ }
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }

  let kernel;
  try {
    const handoffInterrupt = events.find((event) =>
      event.type === "interrupt_requested" &&
      event.sessionId === sessionId &&
      event.inputId === successorInputId &&
      event.phase === "successor_handoff");
    assert.ok(handoffInterrupt, "Stop was accepted against the exact queued successor, not idle state");

    const ownerSettlement = events.find((event) =>
      event.type === "turn_settled" && event.inputId === ownerInputId);
    assert.equal(ownerSettlement?.continuing, true, "the predecessor kept the UI busy while its successor was owned");
    assert.equal(
      events.some((event) => event.type === "interrupt_idle" && event.sessionId === sessionId),
      false,
      "the handoff exposes no false idle response",
    );
    assert.ok(
      events.some((event) =>
        event.type === "steer_cancelled" &&
        event.inputId === successorInputId &&
        event.status === "cancelled"),
      "the pending correction receives one visible terminal acknowledgement",
    );
    assert.ok(
      events.some((event) =>
        event.type === "turn_end" &&
        event.sessionId === sessionId &&
        event.status === "interrupted"),
      "the cancelled successor reaches an interrupted turn boundary",
    );
    const text = events
      .filter((event) => event.type === "text_delta" && event.sessionId === sessionId)
      .map((event) => event.text ?? "")
      .join("");
    assert.doesNotMatch(text, /DEFERRED-SUCCESSOR-MUST-NOT-RUN/, "the cancelled successor never reaches the provider");
    assert.match(text, /NEXT-AFTER-HANDOFF-STOP/, "the next ordinary input runs after exact cancellation settles");

    kernel = await openWorkspaceSessionKernel(workspace);
    assert.equal(kernel.getInput(ownerInputId)?.state, "consumed");
    assert.equal(kernel.getInput(successorInputId)?.state, "cancelled");
    assert.equal(kernel.getInput(nextInputId)?.state, "consumed");
  } finally {
    kernel?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
