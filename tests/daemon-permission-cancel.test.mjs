import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openWorkspaceSessionKernel } from "../packages/core/dist/index.js";
import { DaemonCommandRouter } from "../packages/cli/dist/entry/daemon/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

function request(id, signal) {
  return {
    id,
    toolName: "ExternalEffect",
    input: {},
    reason: "test owner approval",
    signal,
  };
}

test("daemon permission waiter detaches on abort and discards its late id response", async () => {
  const errors = [];
  const router = new DaemonCommandRouter((error) => errors.push(error));
  const controller = new AbortController();
  const pending = router.waitForPermission(request("permission-old", controller.signal));

  assert.equal(router.permissionWaiters.length, 1);
  controller.abort();
  assert.equal(await pending, "deny");
  assert.equal(router.permissionWaiters.length, 0);

  router.pushPermissionResponse({
    type: "permission_response",
    id: "permission-old",
    decision: "allow_once",
  });
  assert.equal(router.permissionResponses.length, 0, "late retired response is discarded, not leaked");

  const next = router.waitForPermission(request("permission-new"));
  router.pushPermissionResponse({
    type: "permission_response",
    id: "permission-new",
    decision: "allow_always",
  });
  assert.equal(await next, "allow_always", "ordinary later approval semantics are unchanged");
  assert.deepEqual(errors, []);
  router.close();
});

test("an id-less late response cannot approve the next id-less prompt", async () => {
  const router = new DaemonCommandRouter(() => undefined);
  const controller = new AbortController();
  const cancelled = router.waitForPermission(request(undefined, controller.signal));
  controller.abort();
  assert.equal(await cancelled, "deny");

  router.pushPermissionResponse({ type: "permission_response", decision: "allow_once" });
  assert.equal(router.permissionResponses.length, 0, "one anonymous late response is retired");

  const next = router.waitForPermission(request(undefined));
  router.pushPermissionResponse({ type: "permission_response", decision: "deny" });
  assert.equal(await next, "deny", "the next prompt receives only its own response");
  router.close();
});

test("a legacy id-less response for an explicitly retired prompt is quarantined", async () => {
  const router = new DaemonCommandRouter(() => undefined);
  const controller = new AbortController();
  const cancelled = router.waitForPermission(request("explicit-retired", controller.signal));
  controller.abort();
  assert.equal(await cancelled, "deny");

  router.pushPermissionResponse({ type: "permission_response", decision: "allow_once" });
  assert.equal(router.permissionResponses.length, 0, "legacy late approval cannot enter the response queue");

  const next = router.waitForPermission(request("next-explicit"));
  router.pushPermissionResponse({
    type: "permission_response",
    id: "next-explicit",
    decision: "deny",
  });
  assert.equal(await next, "deny");
  router.close();
});

test("daemon permission denial cancels the exact owner and the immediate next message runs", { timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-deny-workspace-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-deny-home-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-deny-outside-"));
  // "credentials" deliberately classifies the path request as sensitive so
  // the daemon parks for the owner instead of auto-approving an ordinary Read.
  const outsideFile = path.join(outside, "credentials.txt");
  const sessionId = "permission-deny-daemon";
  const ownerInputId = "permission-denied-owner";
  const nextInputId = "after-permission-denial";
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "ui.json"),
    JSON.stringify({ dangerousBypass: false, routingMode: "manual" }, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(outsideFile, "permission denial boundary\n", "utf8");

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
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const events = [];
  let stdoutBuffer = "";
  let stderr = "";
  let sentOwner = false;
  let deniedPermission = false;
  let sentNext = false;
  let settled = false;
  const writeCommand = (command) => child.stdin.write(JSON.stringify(command) + "\n");

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(
          `daemon denial flow timed out\nstdout=${stdoutBuffer}\nstderr=${stderr}\n` +
          `events=${JSON.stringify(events.slice(-40))}`,
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
          if (event.type === "daemon_ready" && !sentOwner) {
            sentOwner = true;
            writeCommand({
              type: "send",
              sessionId,
              inputId: ownerInputId,
              goal: `__mock_read_tool__ ${outsideFile}`,
            });
          }
          if (event.type === "permission_request" && event.sessionId === sessionId && !deniedPermission) {
            deniedPermission = true;
            writeCommand({ type: "permission_response", id: event.id, decision: "deny" });
          }
          if (
            event.type === "turn_end" &&
            event.sessionId === sessionId &&
            event.status === "interrupted" &&
            !sentNext
          ) {
            // Deliberately submit at the visible terminal edge, before the
            // daemon wrapper necessarily finishes its epilogue. This is the
            // race that used to strand the message behind the requeued owner.
            sentNext = true;
            writeCommand({
              type: "send",
              sessionId,
              inputId: nextInputId,
              goal: "NEXT-AFTER-PERMISSION-DENIAL",
            });
          } else if (
            sentNext &&
            event.type === "turn_end" &&
            event.sessionId === sessionId &&
            event.status === "completed"
          ) {
            settled = true;
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
        if (settled) return;
        clearTimeout(deadline);
        reject(new Error(`daemon exited before denial recovery completed: ${code}\nstderr=${stderr}`));
      });
    });
  } finally {
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
    assert.equal(deniedPermission, true, "the owner saw and denied a real daemon permission prompt");
    assert.equal(sentNext, true, "the immediate follow-up was submitted at the interrupted boundary");
    assert.match(
      events.filter((event) => event.type === "text_delta" && event.sessionId === sessionId)
        .map((event) => event.text ?? "")
        .join(""),
      /NEXT-AFTER-PERMISSION-DENIAL/,
      "the follow-up reached the provider instead of waiting behind an orphan",
    );
    kernel = await openWorkspaceSessionKernel(workspace);
    assert.equal(kernel.getInput(ownerInputId)?.state, "cancelled");
    assert.equal(kernel.getInput(nextInputId)?.state, "consumed");
    assert.equal(
      kernel.listEvents(sessionId).some((event) => event.type === "input.requeued"),
      false,
      "lease release must not requeue an explicitly interrupted owner",
    );
  } finally {
    kernel?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
