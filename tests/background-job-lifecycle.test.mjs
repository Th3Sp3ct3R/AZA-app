// No background job outlives the host that owns it.
//
// Field origin: "Ares keeps launching the minecraft clone, then navigating and
// launching minecraft when I'm not even doing that or authorizing it. It's
// broken so it never ends."
//
// The mechanism: background shells run behind a DETACHED, unref'd supervisor so
// they survive a daemon restart and stay pollable. Nothing ever took that
// survival away. Closing Ares, or pressing Stop, left the supervisor running —
// and a dev-server-shaped job that relaunches a game every few minutes then
// does exactly that, forever, with no window open to show it and no UI to stop
// it from.
//
// The rule these tests hold: a job may survive a RESTART, never its host. On
// Stop we suspend what the turn started; on shutdown we suspend everything. A
// suspension is resumable and NEVER auto-resumes — that last part is what keeps
// "pick the session back up" from meaning "the game starts again".

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { ShellRegistry } from "../packages/tools/dist/index.js";
import { openWorkspaceSessionKernel } from "../packages/core/dist/index.js";

async function setup(t) {
  const workspace = await mkdtemp(path.join(tmpdir(), "ares-bglife-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  t.after(async () => {
    try { kernel.close(); } catch { /* already closed */ }
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });
  const sessionId = `sess_bg_${Math.random().toString(36).slice(2, 10)}`;
  kernel.createSession({ id: sessionId, workspaceKey: workspace });
  const registry = new ShellRegistry();
  registry.configureDurability({ kernel, workspace });
  registry.registerSession(sessionId);
  // Real processes, because suspension really kills process trees — the first
  // version of this fixture used the test runner's own pid and the sweep
  // promptly taskkill'd the test run. That is the behaviour working; it just
  // needs a stand-in that is safe to reap.
  const spawned = [];
  t.after(() => {
    for (const child of spawned) {
      try { child.kill(); } catch { /* already gone */ }
    }
  });
  const sleeper = () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    spawned.push(child);
    return child;
  };
  return { workspace, kernel, sessionId, registry, sleeper };
}

/**
 * A job that reads as genuinely alive: a fresh supervisor state file behind a
 * real live pid — which is exactly what reconciliation checks before it will
 * call a job "running".
 */
async function seedLiveJob(ctx, n, opts = {}) {
  const { kernel, workspace, sleeper } = ctx;
  const sessionId = opts.sessionId ?? ctx.sessionId;
  const startedAtMs = opts.startedAtMs ?? Date.now();
  const id = `sh_live_${n}`;
  const root = path.join(workspace, ".ares", "background-jobs", sessionId);
  const statePath = path.join(root, `${id}.state.json`);
  const outputPath = path.join(root, `${id}.output.log`);
  const token = `tok_live_${n}`;
  const supervisor = sleeper();
  kernel.createBackgroundJob({
    id,
    sessionId,
    invocationKey: `key_live_${n}`,
    kind: "shell",
    description: `Run the game dev server ${n}`,
    request: { version: 1, program: "node", args: ["server.mjs"], cwd: workspace, description: `dev server ${n}`, attempt: 1 },
    processToken: token,
    statePath,
    outputPath,
  });
  await mkdir(root, { recursive: true });
  await writeFile(outputPath, "[stdout] listening\n");
  await writeFile(statePath, JSON.stringify({
    version: 1,
    jobId: id,
    token,
    supervisorPid: supervisor.pid,
    childPid: null,
    phase: "running",
    startedAtMs,
    heartbeatAtMs: Date.now(),
    finishedAtMs: null,
    exitCode: null,
    signal: null,
    outputBytes: 20,
    error: null,
  }) + "\n");
  kernel.markBackgroundJobRunning(id, {
    pid: supervisor.pid,
    processToken: token,
    statePath,
    outputPath,
    startedAtMs,
    heartbeatAtMs: Date.now(),
  });
  return id;
}

test("closing the host suspends running jobs and marks them resumable", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel, sessionId, registry } = ctx;
  await seedLiveJob(ctx, 1);
  await seedLiveJob(ctx, 2);
  assert.equal(registry.list(sessionId).filter((j) => j.status === "running").length, 2);

  const suspended = await registry.suspendForSession(sessionId, { reason: "Ares closed" });
  assert.equal(suspended.length, 2, "both jobs must be taken down with the host");

  const after = registry.list(sessionId);
  assert.equal(after.filter((j) => j.status === "running").length, 0, "nothing may still read as running");
  for (const job of after) {
    assert.equal(job.suspended, true);
    assert.equal(job.resumable, true, "a host-suspended job must be resumable");
    assert.equal(job.stoppedReason, "Ares closed", "and must say WHY it stopped");
  }
});

test("a suspension writes NO completion input — nothing wakes up and re-runs it", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel, sessionId, registry } = ctx;
  const id = await seedLiveJob(ctx, 3);

  await registry.suspendForSession(sessionId, { reason: "Ares closed" });

  const job = kernel.getBackgroundJob(id);
  assert.equal(job.completionInputId, null,
    "a completion row becomes a recovered TURN on the next start — that is exactly how an unattended relaunch loop begins");
});

test("Stop takes down what the turn started, and leaves older work alone", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel, sessionId, registry } = ctx;
  // startedAtMs is stamped by the kernel when a job actually starts — it cannot
  // be backdated through the API, and shouldn't be: it is the fact the fence
  // depends on. So this test spends real milliseconds instead of faking them.
  const older = await seedLiveJob(ctx, 4); // the user's own dev server
  await new Promise((resolve) => setTimeout(resolve, 40));
  const turnStartedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const mine = await seedLiveJob(ctx, 5); // started by the turn being interrupted

  const suspended = await registry.suspendForSession(sessionId, {
    reason: "turn interrupted",
    since: turnStartedAt,
  });

  const ids = suspended.map((j) => j.id);
  assert.deepEqual(ids, [mine], "only the interrupted turn's own launch is stopped");
  assert.equal(kernel.getBackgroundJob(older).status, "running", "the user's earlier job is untouched");
});

test("resume relaunches a suspended job as a NEW attempt, never in place", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel, sessionId, registry } = ctx;
  const id = await seedLiveJob(ctx, 6);
  await registry.suspendForSession(sessionId, { reason: "Ares closed" });

  const resumed = await registry.resume(id, sessionId);
  assert.notEqual(resumed.id, id, "a resume is a fresh record, so the old one stays auditable");
  assert.equal(resumed.resumedFrom, id, "and it says what it descends from");

  const original = kernel.getBackgroundJob(id);
  assert.equal(original.status, "cancelled", "the suspended record stays terminal");
  const fresh = kernel.getBackgroundJob(resumed.id);
  assert.equal(fresh.request.attempt, 2, "attempt count carries forward");
});

test("resuming a job that is still alive does not double-launch it", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel, sessionId, registry } = ctx;
  const id = await seedLiveJob(ctx, 7);

  const result = await registry.resume(id, sessionId);
  assert.equal(result.id, id, "a live job resumes to ITSELF — two copies of a dev server is the bug, not the fix");
});

test("a job from another session is invisible and untouchable", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel, sessionId, registry } = ctx;
  const id = await seedLiveJob(ctx, 8);
  const other = `sess_other_${Math.random().toString(36).slice(2, 8)}`;
  kernel.createSession({ id: other, workspaceKey: workspace });

  assert.equal(registry.get(id, other), undefined);
  await assert.rejects(() => registry.resume(id, other), /unknown background job/);
  assert.deepEqual(await registry.suspendForSession(other, { reason: "Ares closed" }), []);
});

test("suspendAll covers every session the registry has seen", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel, sessionId, registry } = ctx;
  const second = `sess_two_${Math.random().toString(36).slice(2, 8)}`;
  kernel.createSession({ id: second, workspaceKey: workspace });
  registry.registerSession(second);
  await seedLiveJob(ctx, 9);
  await seedLiveJob(ctx, 10, { sessionId: second });

  const suspended = await registry.suspendAll("Ares closed");
  assert.equal(suspended.length, 2, "a shutdown sweep that misses a session leaves a process running forever");
});

test("a boot sweep stops what a CRASHED host left running, in sessions it never opened", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel } = ctx;
  // A session this host has not opened — the leftovers nobody would ever look
  // at, which is exactly why they kept running for days.
  const abandonedSession = `sess_ghost_${Math.random().toString(36).slice(2, 8)}`;
  kernel.createSession({ id: abandonedSession, workspaceKey: workspace });
  const ghost = await seedLiveJob(ctx, 12, { sessionId: abandonedSession });

  await new Promise((resolve) => setTimeout(resolve, 40));
  const hostStartedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 40));
  // Started AFTER this host booted: a live sibling host owns it — hands off.
  const sibling = await seedLiveJob(ctx, 13, { sessionId: abandonedSession });

  const fresh = new ShellRegistry();
  fresh.configureDurability({ kernel, workspace });
  const suspended = await fresh.suspendAbandoned({
    before: hostStartedAt,
    reason: "left running by a previous Ares",
  });

  assert.deepEqual(suspended.map((j) => j.id), [ghost], "only work that predates this host is swept");
  assert.equal(kernel.getBackgroundJob(ghost).status, "cancelled");
  assert.equal(kernel.getBackgroundJob(ghost).completionInputId, null, "and it still must not schedule a turn");
  assert.equal(kernel.getBackgroundJob(sibling).status, "running", "a live sibling host's job is left alone");
});

test("suspension is idempotent — a second sweep finds nothing left to stop", async (t) => {
  const ctx = await setup(t);
  const { workspace, kernel, sessionId, registry } = ctx;
  await seedLiveJob(ctx, 11);
  assert.equal((await registry.suspendForSession(sessionId, { reason: "Ares closed" })).length, 1);
  assert.equal((await registry.suspendForSession(sessionId, { reason: "Ares closed" })).length, 0);
});


