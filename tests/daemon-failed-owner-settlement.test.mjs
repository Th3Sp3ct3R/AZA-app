import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "packages", "cli", "dist", "entry.js");
const coreUrl = pathToFileURL(path.join(here, "..", "packages", "core", "dist", "index.js")).href;

test("daemon terminalizes an exhausted failed owner before accepting the next queue input", { timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-failed-owner-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-failed-home-"));
  const sessionId = "failed-owner-session";
  const failedInputId = "failed-owner";
  const nextInputId = "queue-after-failure";
  let child;
  try {
    const events = await new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [cli, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"],
        {
          cwd: workspace,
          windowsHide: true,
          env: {
            ...process.env,
            ARES_HOME: home,
            ARES_AGENT_ENABLED: "0",
            ARES_OPERATOR_AUTOTICK: "0",
            ARES_CODING_PROOF_GATE: "0",
            ARES_REPO_MAP: "0",
            ARES_PROVIDER_RETRIES: "0",
          },
        },
      );
      const seen = [];
      let stdout = "";
      let stderr = "";
      let failedSent = false;
      let nextSent = false;
      let settled = false;
      const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const done = () => error ? reject(error) : resolve(seen);
        if (child.exitCode === null) {
          child.once("close", done);
          child.kill();
        } else {
          done();
        }
      };
      const deadline = setTimeout(() => finish(new Error(
        `failed-owner daemon flow timed out\nstderr=${stderr.slice(-2_000)}\nevents=${JSON.stringify(seen.slice(-60))}`,
      )), 50_000);

      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", finish);
      child.on("exit", (code) => {
        if (!settled && code !== null) finish(new Error(`daemon exited ${code}\nstderr=${stderr.slice(-2_000)}`));
      });
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        while (true) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) break;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          seen.push(event);
          if (event.type === "daemon_ready" && !failedSent) {
            failedSent = true;
            send({
              type: "send",
              sessionId,
              inputId: failedInputId,
              goal: "__mock_fail_provider__ terminal failure",
            });
          } else if (
            event.type === "turn_settled" &&
            event.sessionId === sessionId &&
            event.inputId === failedInputId &&
            !nextSent
          ) {
            nextSent = true;
            send({
              type: "send",
              sessionId,
              inputId: nextInputId,
              goal: "NEXT-QUEUE-AFTER-FAILED-OWNER",
            });
          } else if (
            nextSent &&
            event.type === "turn_settled" &&
            event.sessionId === sessionId &&
            event.inputId === nextInputId
          ) {
            setTimeout(() => finish(), 100);
          }
        }
      });
    });

    const failedEnd = events.findIndex((event) =>
      event.type === "turn_end" && event.sessionId === sessionId && event.status === "failed");
    const failedSettled = events.findIndex((event) =>
      event.type === "turn_settled" && event.sessionId === sessionId && event.inputId === failedInputId);
    const nextStart = events.findIndex((event, index) =>
      index > failedSettled && event.type === "turn_start" && event.sessionId === sessionId);
    const nextEnd = events.findIndex((event, index) =>
      index > nextStart && event.type === "turn_end" && event.sessionId === sessionId && event.status === "completed");
    const output = events
      .filter((event) => event.type === "text_delta" && event.sessionId === sessionId)
      .map((event) => event.text ?? "")
      .join("");

    assert.ok(failedEnd >= 0, "the injected provider failure reaches a visible terminal boundary");
    assert.ok(failedSettled > failedEnd, "host settlement, not model terminal, unlocks the next queue send");
    assert.ok(nextStart > failedSettled, "the next input owns a fresh ordinary generation");
    assert.ok(nextEnd > nextStart);
    assert.match(output, /NEXT-QUEUE-AFTER-FAILED-OWNER/);

    const core = await import(`${coreUrl}?failedOwner=${Date.now()}`);
    const store = await core.SessionKernelStore.open({ filename: core.workspaceSessionKernelPath(workspace) });
    try {
      assert.equal(store.getInput(failedInputId)?.state, "cancelled");
      assert.equal(store.getInput(nextInputId)?.state, "consumed");
    } finally {
      store.close();
    }
  } finally {
    if (child?.exitCode === null) child.kill();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
