import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "packages", "cli", "dist", "entry.js");
const coreUrl = pathToFileURL(path.join(here, "..", "packages", "core", "dist", "index.js")).href;
const requireFromCore = createRequire(path.join(here, "..", "packages", "core", "package.json"));
const BetterSqlite3 = requireFromCore("better-sqlite3");

test("daemon restart promotes a crashed steer through visible preparation and exact-ID Stop", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-recovery-"));
  const sessionId = "crash-recovery-chat";
  const inputId = "crash-recovery-owner";
  const goal = "EARLY-RECOVERY-STOP";
  const steerInputId = "crash-recovery-steer";
  const steerGoal = "RECOVERED-PREP-MARKER fix the renderer";
  let child;
  try {
    const core = await import(`${coreUrl}?seed=${Date.now()}`);
    const filename = core.workspaceSessionKernelPath(workspace);
    const seed = await core.SessionKernelStore.open({ filename });
    try {
      seed.createSession({
        id: sessionId,
        workspaceKey: workspace,
        metadata: {
          provider: "mock-echo",
          model: "mock-echo",
          createdAt: new Date().toISOString(),
        },
      });
      seed.admitInput({
        id: inputId,
        sessionId,
        idempotencyKey: inputId,
        delivery: "steer",
        payload: { content: [{ type: "text", text: goal }] },
      });
      seed.admitInput({
        id: steerInputId,
        sessionId,
        idempotencyKey: steerInputId,
        delivery: "steer",
        payload: { content: [{ type: "text", text: steerGoal }] },
      });
      const crashed = seed.acquireRunnerLease(sessionId, "crashed-daemon", 60_000);
      const crashedFence = {
        sessionId,
        generation: crashed.generation,
        leaseToken: crashed.leaseToken,
      };
      seed.claimInput(crashedFence, inputId);
      seed.claimInput(crashedFence, steerInputId);
    } finally {
      seed.close();
    }

    const result = await new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [cli, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"],
        {
          env: {
            ...process.env,
            ARES_AGENT_ENABLED: "0",
            ARES_CODING_PROOF_GATE: "0",
            ARES_HOME: path.join(workspace, "home"),
            ARES_OPERATOR_AUTOTICK: "0",
            ARES_REPO_MAP: "0",
            ARES_SESSION_LEASE_TTL_MS: "250",
            ARES_SESSION_LEASE_HEARTBEAT_MS: "50",
          },
        },
      );
      const events = [];
      let stdout = "";
      let stderr = "";
      let replaySent = false;
      let stopSent = false;
      let leaseExpired = false;
      let stopSettled = false;
      let recoveredText = "";
      let settled = false;
      const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const done = () => error ? reject(error) : resolve({ events, stderr });
        if (child.exitCode === null) {
          child.once("close", done);
          child.kill();
        } else {
          done();
        }
      };
      const deadline = setTimeout(() => {
        finish(new Error(
          `daemon startup recovery timed out\nstderr=${stderr.slice(-2_000)}\nevents=${JSON.stringify(events.slice(-60))}`,
        ));
      }, 60_000);

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
          events.push(event);
          if (event.type === "daemon_ready" && !replaySent) {
            replaySent = true;
            // This is the desktop's same-ID replay after transport loss. The
            // daemon must derive authority/content from SQLite and run it once.
            send({ type: "steer", sessionId, inputId, text: goal });
          } else if (
            event.type === "startup_recovery_preparing" &&
            event.sessionId === sessionId &&
            !stopSent
          ) {
            stopSent = true;
            send({ type: "interrupt", sessionId });
          } else if (
            event.type === "interrupt_requested" &&
            event.sessionId === sessionId &&
            event.inputId === inputId &&
            !leaseExpired
          ) {
            // Release the simulated dead process's still-live lease only after
            // the daemon has durably exposed the exact pending Stop target.
            leaseExpired = true;
            const db = new BetterSqlite3(filename);
            try {
              db.prepare("UPDATE runner_leases SET expires_at_ms = 0 WHERE session_id = ?").run(sessionId);
            } finally {
              db.close();
            }
          } else if (
            event.type === "interrupt_settled" &&
            event.sessionId === sessionId &&
            event.inputId === inputId
          ) {
            stopSettled = true;
          } else if (event.type === "text_delta" && event.sessionId === sessionId) {
            recoveredText += event.text ?? "";
          } else if (
            event.type === "turn_end" &&
            event.sessionId === sessionId &&
            event.status === "completed" &&
            stopSettled &&
            recoveredText.includes("RECOVERED-PREP-MARKER")
          ) {
            setTimeout(() => finish(), 100);
          }
        }
      });
    });

    const events = result.events;
    const ready = events.findIndex((event) => event.type === "daemon_ready");
    const opened = events.findIndex((event) => event.type === "session_opened" && event.sessionId === sessionId);
    const preparing = events.findIndex((event) =>
      event.type === "startup_recovery_preparing" &&
      event.sessionId === sessionId &&
      event.inputId === inputId &&
      event.inputIds?.includes(steerInputId));
    const earlyStop = events.findIndex((event) =>
      event.type === "interrupt_requested" &&
      event.sessionId === sessionId &&
      event.inputId === inputId &&
      event.phase === "startup_recovery");
    const queued = events.findIndex((event) =>
      event.type === "startup_recovery_queued" &&
      event.sessionId === sessionId &&
      event.inputIds?.includes(inputId) &&
      event.inputIds?.includes(steerInputId));
    const routes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "route_resolved" && event.sessionId === sessionId)
      .map(({ index }) => index);
    const prepared = events.findIndex((event) =>
      event.type === "system_reminder_injected" &&
      event.sessionId === sessionId &&
      /Foreground request[\s\S]*RECOVERED-PREP-MARKER/.test(event.text ?? ""));
    const provider = events.findIndex((event) =>
      event.type === "provider_attempt_started" && event.sessionId === sessionId);
    const applied = events.findIndex((event) =>
      event.type === "steer_applied" && event.sessionId === sessionId && event.inputId === steerInputId);
    const interrupted = events.findIndex((event) =>
      event.type === "turn_end" && event.sessionId === sessionId && event.status === "interrupted");
    const settledStop = events.findIndex((event) =>
      event.type === "interrupt_settled" && event.sessionId === sessionId && event.inputId === inputId);
    const stoppedOwnerLifecycle = (type) => events.filter((event) =>
      event.type === type && event.sessionId === sessionId && event.inputId === inputId);

    assert.ok(ready >= 0, "daemon transport becomes ready");
    assert.ok(opened > ready, "the pinned Session is hosted only after daemon_ready");
    assert.ok(preparing > opened, "the crashed canonical IDs become visible before lease takeover waits");
    assert.ok(earlyStop > preparing, "Stop binds to the exact recovered ID during lease takeover");
    assert.ok(queued > earlyStop, "takeover applies the pending Stop before scheduling execution");
    assert.equal(routes.length, 1, "the terminal cancelled owner never re-enters routing");
    assert.ok(interrupted > queued, "the takeover-window Stop reaches a visible interrupted boundary without preparation");
    assert.ok(settledStop > interrupted, "daemon ownership releases only after exact-ID settlement");
    assert.equal(stoppedOwnerLifecycle("input_replayed").length, 1, "the internal recovery copy cannot duplicate replay acknowledgement");
    assert.equal(stoppedOwnerLifecycle("turn_end").length, 1, "the stopped owner has one terminal boundary");
    assert.equal(stoppedOwnerLifecycle("interrupt_settled").length, 1, "the exact Stop settles once");
    assert.equal(stoppedOwnerLifecycle("turn_settled").length, 1, "host settlement is emitted once");
    assert.ok(routes[0] > settledStop, "only the next non-terminal recovered input enters routing");
    assert.ok(prepared > routes[0], "the next recovered input runs prepareUserTurn and exposes its foreground reminder");
    assert.ok(applied > routes[0], "a recovered steer keeps its durable delivery and exact acknowledgement ID");
    assert.ok(provider > Math.max(applied, prepared), "provider execution cannot precede ready/routing/preparation");
    assert.equal(
      events.filter((event) => event.type === "provider_attempt_started" && event.sessionId === sessionId).length,
      1,
      "restart executes one visible provider attempt, never a detached duplicate",
    );

    const inspect = await core.SessionKernelStore.open({ filename });
    try {
      assert.equal(inspect.getInput(inputId)?.state, "cancelled");
      assert.equal(inspect.getInput(steerInputId)?.state, "consumed");
      assert.equal(
        inspect.listEvents(sessionId).filter((event) => event.type === "input.detached_recovery_started").length,
        0,
        "daemon recovery never uses Session's hidden detached runner",
      );
    } finally {
      inspect.close();
    }
  } finally {
    if (child?.exitCode === null) child.kill();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("daemon restart keeps a queue owner and later steer in one visible provider generation", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-owner-steer-recovery-"));
  const sessionId = "crash-owner-steer-chat";
  const ownerInputId = "crash-owner-queue";
  const steerInputId = "crash-owner-correction";
  const ownerGoal = "OWNER-RECOVERY-MARKER finish the renderer";
  const steerGoal = "ATTACHED-STEER-MARKER preserve the camera transform";
  let child;
  try {
    const core = await import(`${coreUrl}?ownerSteer=${Date.now()}`);
    const filename = core.workspaceSessionKernelPath(workspace);
    const seed = await core.SessionKernelStore.open({ filename });
    try {
      seed.createSession({
        id: sessionId,
        workspaceKey: workspace,
        metadata: {
          provider: "mock-echo",
          model: "mock-echo",
          createdAt: new Date().toISOString(),
        },
      });
      seed.admitInput({
        id: ownerInputId,
        sessionId,
        idempotencyKey: ownerInputId,
        delivery: "queue",
        payload: { content: [{ type: "text", text: ownerGoal }] },
      });
      seed.admitInput({
        id: steerInputId,
        sessionId,
        idempotencyKey: steerInputId,
        delivery: "steer",
        payload: { content: [{ type: "text", text: steerGoal }] },
      });
      const crashed = seed.acquireRunnerLease(sessionId, "crashed-owner", 60_000);
      seed.claimInput({
        sessionId,
        generation: crashed.generation,
        leaseToken: crashed.leaseToken,
      }, ownerInputId);
    } finally {
      seed.close();
    }
    // Deterministically model process death without a wall-clock sleep.
    const db = new BetterSqlite3(filename);
    try {
      db.prepare("UPDATE runner_leases SET expires_at_ms = 0 WHERE session_id = ?").run(sessionId);
    } finally {
      db.close();
    }

    const events = await new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [cli, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"],
        {
          env: {
            ...process.env,
            ARES_AGENT_ENABLED: "0",
            ARES_CODING_PROOF_GATE: "0",
            ARES_HOME: path.join(workspace, "home"),
            ARES_OPERATOR_AUTOTICK: "0",
            ARES_REPO_MAP: "0",
            ARES_SESSION_LEASE_TTL_MS: "250",
            ARES_SESSION_LEASE_HEARTBEAT_MS: "50",
          },
        },
      );
      const seen = [];
      let stdout = "";
      let stderr = "";
      let replaySent = false;
      let recoveredText = "";
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
        `queue-owner recovery timed out\nstderr=${stderr.slice(-2_000)}\nevents=${JSON.stringify(seen.slice(-60))}`,
      )), 60_000);
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
          if (event.type === "daemon_ready" && !replaySent) {
            replaySent = true;
            send({ type: "send", sessionId, inputId: ownerInputId, goal: ownerGoal });
          } else if (event.type === "text_delta" && event.sessionId === sessionId) {
            recoveredText += event.text ?? "";
          } else if (
            event.type === "input_replayed" &&
            event.sessionId === sessionId &&
            event.inputId === steerInputId &&
            recoveredText.includes("ATTACHED-STEER-MARKER")
          ) {
            setTimeout(() => finish(), 100);
          }
        }
      });
    });

    const ready = events.findIndex((event) => event.type === "daemon_ready");
    const preparing = events.findIndex((event) =>
      event.type === "startup_recovery_preparing" &&
      event.sessionId === sessionId &&
      event.inputId === ownerInputId &&
      JSON.stringify(event.inputIds) === JSON.stringify([ownerInputId, steerInputId]));
    const routes = events.filter((event) => event.type === "route_resolved" && event.sessionId === sessionId);
    const route = events.findIndex((event) => event.type === "route_resolved" && event.sessionId === sessionId);
    const preparedTurns = events.filter((event) =>
      event.type === "system_reminder_injected" &&
      event.sessionId === sessionId &&
      /Foreground request[\s\S]*OWNER-RECOVERY-MARKER/.test(event.text ?? ""));
    const prepared = events.findIndex((event) => preparedTurns.includes(event));
    const providerAttempts = events.filter((event) =>
      event.type === "provider_attempt_started" && event.sessionId === sessionId);
    const turnEnds = events.filter((event) => event.type === "turn_end" && event.sessionId === sessionId);
    const replayedSteer = events.find((event) =>
      event.type === "input_replayed" && event.sessionId === sessionId && event.inputId === steerInputId);
    const recoveredText = events
      .filter((event) => event.type === "text_delta" && event.sessionId === sessionId)
      .map((event) => event.text ?? "")
      .join("");

    assert.ok(ready >= 0);
    assert.ok(preparing > ready, "the queue owner remains the recovered generation owner");
    assert.ok(route > preparing, "owner recovery uses the ordinary route pipeline");
    assert.ok(prepared > route, "owner recovery uses ordinary turn preparation");
    assert.equal(routes.length, 1, "a consumed attached steer never re-enters routing");
    assert.equal(preparedTurns.length, 1, "a consumed attached steer never re-runs mutable preparation");
    assert.equal(providerAttempts.length, 1, "owner and attached steer invoke the provider once");
    assert.equal(turnEnds.length, 1, "the recovered generation has one terminal turn boundary");
    assert.match(recoveredText, /ATTACHED-STEER-MARKER/, "the recovered generation sees its correction");
    assert.equal(replayedSteer?.settled, true, "the later scheduled ID observes the in-generation settlement");

    const inspect = await core.SessionKernelStore.open({ filename });
    try {
      assert.equal(inspect.getInput(ownerInputId)?.state, "consumed");
      assert.equal(inspect.getInput(steerInputId)?.state, "consumed");
      assert.equal(inspect.listDetachedInputResults(sessionId).length, 0);
      assert.equal(
        inspect.listEvents(sessionId).filter((event) => event.type === "input.detached_recovery_started").length,
        0,
      );
    } finally {
      inspect.close();
    }
  } finally {
    if (child?.exitCode === null) child.kill();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
