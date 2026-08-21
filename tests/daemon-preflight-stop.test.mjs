import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openWorkspaceSessionKernel } from "../packages/core/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

test("Stop during daemon pre-admission skips optional preflight and the next exact input runs", { timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-preflight-stop-workspace-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-preflight-stop-home-"));
  const sessionId = "preflight-stop-daemon";
  const stoppedInputId = "owner-stopped-before-admission";
  const nextInputId = "owner-after-preflight-stop";
  mkdirSync(path.join(home, "roster", "hammer"), { recursive: true });
  writeFileSync(
    path.join(home, "ui.json"),
    JSON.stringify({ dangerousBypass: false, routingMode: "manual" }, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(home, "roster", "hammer", "AGENT.md"),
    [
      "---",
      "label: Hammer",
      "description: Builds things.",
      "autonomy: auto",
      "triggers:",
      "  - implement the thing",
      "---",
      "You are working as Hammer.",
    ].join("\n"),
    "utf8",
  );

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
        // Holds only this test's active owner before routing. The daemon wakes
        // the window immediately when exact-ID Stop arrives.
        ARES_TEST_DAEMON_PRE_ADMISSION_WINDOW_MS: "2000",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const events = [];
  let stdoutBuffer = "";
  let stderr = "";
  let ownerSent = false;
  let stopAccepted = false;
  let ownerSettledIndex = -1;
  let nextSent = false;
  let nextCompleted = false;
  let interruptTimer;
  const writeCommand = (command) => child.stdin.write(JSON.stringify(command) + "\n");

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(
          `daemon preflight Stop flow timed out\nstdout=${stdoutBuffer}\nstderr=${stderr}\n` +
          `events=${JSON.stringify(events.slice(-60))}`,
        ));
      }, 45_000);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          events.push(event);
          if (event.type === "daemon_ready" && !ownerSent) {
            ownerSent = true;
            writeCommand({
              type: "send",
              sessionId,
              inputId: stoppedInputId,
              goal: "please implement the thing CANCELLED-PREFLIGHT-MARKER",
            });
            // Interrupt is out-of-band. Retry until the daemon acknowledges that
            // the exact activeInputId (not an idle session) accepted Stop.
            interruptTimer = setInterval(() => {
              writeCommand({ type: "interrupt", sessionId });
            }, 10);
          }
          if (
            event.type === "interrupt_requested" &&
            event.sessionId === sessionId &&
            event.inputId === stoppedInputId
          ) {
            stopAccepted = true;
            clearInterval(interruptTimer);
            interruptTimer = undefined;
          }
          if (
            event.type === "turn_settled" &&
            event.sessionId === sessionId &&
            event.inputId === stoppedInputId &&
            !nextSent
          ) {
            ownerSettledIndex = events.length - 1;
            nextSent = true;
            writeCommand({
              type: "send",
              sessionId,
              inputId: nextInputId,
              goal: "NEXT-AFTER-PREFLIGHT-STOP",
            });
          }
          if (
            event.type === "turn_settled" &&
            event.sessionId === sessionId &&
            event.inputId === nextInputId
          ) {
            nextCompleted = true;
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
        if (nextCompleted) return;
        clearTimeout(deadline);
        reject(new Error(`daemon exited before preflight Stop recovery completed: ${code}\nstderr=${stderr}`));
      });
    });
  } finally {
    if (interruptTimer) clearInterval(interruptTimer);
    if (child.exitCode === null) {
      try {
        writeCommand({ type: "exit" });
      } catch {
        // The process may already be closing after a test failure.
      }
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
    assert.equal(stopAccepted, true, "Stop bound to the exact owner while it was still pre-admission");
    assert.ok(ownerSettledIndex >= 0, "the cancelled owner reached the host settlement boundary");
    const stoppedEvents = events.slice(0, ownerSettledIndex + 1).filter((event) => event.sessionId === sessionId);
    assert.equal(
      stoppedEvents.some((event) => event.type === "route_resolved"),
      false,
      "optional routing was skipped after pre-admission Stop",
    );
    assert.equal(
      stoppedEvents.some((event) => event.type === "persona_changed" || event.type === "persona_suggested"),
      false,
      "persona matching was skipped after pre-admission Stop",
    );
    assert.equal(
      stoppedEvents.some((event) => event.type === "text_delta" && /CANCELLED-PREFLIGHT-MARKER/.test(event.text ?? "")),
      false,
      "the cancelled request never reached the provider",
    );
    assert.equal(
      stoppedEvents.some((event) => event.type === "turn_end" && event.status === "interrupted"),
      true,
      "the exact cancelled request emitted an interrupted terminal boundary",
    );
    assert.match(
      events.filter((event) => event.type === "text_delta" && event.sessionId === sessionId)
        .map((event) => event.text ?? "")
        .join(""),
      /NEXT-AFTER-PREFLIGHT-STOP/,
      "the message after settlement reached the provider",
    );

    kernel = await openWorkspaceSessionKernel(workspace);
    assert.equal(kernel.getInput(stoppedInputId)?.state, "cancelled");
    assert.equal(kernel.getInput(nextInputId)?.state, "consumed");
  } finally {
    kernel?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
