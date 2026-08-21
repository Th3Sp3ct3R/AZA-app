// Background jobs must settle even when nobody polls them.
//
// Field origin: a session fired fourteen background shells (smoke tests for a
// Minecraft launcher, each of which LAUNCHES the game) and polled almost none
// of them. Reconciliation was pull-only — it ran when the model asked about a
// job — so thirteen long-dead processes sat at status "running" forever, and
// the one still alive was an orphaned dev server nobody had asked to keep.
// From the owner's side this looked like "Minecraft keeps randomly launching".

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ShellRegistry } from "../packages/tools/dist/index.js";
import { openWorkspaceSessionKernel } from "../packages/core/dist/index.js";

async function setup(t) {
  const workspace = await mkdtemp(path.join(tmpdir(), "ares-sweep-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  // Close the kernel BEFORE removing the tree — SQLite keeps the db/-shm/-wal
  // handles open, and Windows refuses to unlink a file still held.
  t.after(async () => {
    try { kernel.close(); } catch { /* already closed */ }
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });
  const sessionId = `sess_sweep_${Math.random().toString(36).slice(2, 10)}`;
  kernel.createSession({ id: sessionId, workspaceKey: workspace });
  return { workspace, kernel, sessionId };
}

/** A durable job record whose process is definitively gone. */
function seedDeadJob(kernel, sessionId, n) {
  const id = `sh_dead_${n}`;
  kernel.createBackgroundJob({
    id,
    sessionId,
    invocationKey: `key_${n}`,
    kind: "shell",
    description: `Run smoke test ${n}`,
    request: { version: 1, program: "pwsh", args: ["-c", "echo hi"], cwd: ".", description: `smoke ${n}` },
    processToken: `tok_${n}`,
    statePath: path.join("nowhere", `${id}.state.json`),
    outputPath: path.join("nowhere", `${id}.output.log`),
  });
  // Mark it running behind a PID that cannot exist, with no supervisor state
  // file — exactly the shape the stuck records had.
  kernel.markBackgroundJobRunning(id, {
    pid: 0x7ffffff0 + n,
    processToken: `tok_${n}`,
    statePath: path.join("nowhere", `${id}.state.json`),
    outputPath: path.join("nowhere", `${id}.output.log`),
    heartbeatAtMs: Date.now(),
  });
  return id;
}

test("a sweep settles running jobs whose process is gone, with no poll", async (t) => {
  const { workspace, kernel, sessionId } = await setup(t);
  const registry = new ShellRegistry();
  registry.configureDurability({ kernel, workspace });

  const ids = [1, 2, 3].map((n) => seedDeadJob(kernel, sessionId, n));
  for (const id of ids) {
    assert.equal(kernel.getBackgroundJob(id).status, "running", "seeded as running");
  }

  const result = registry.sweepDurableJobs(sessionId);
  assert.equal(result.settled, 3, `all three should settle, got ${result.settled}`);
  for (const id of ids) {
    const after = kernel.getBackgroundJob(id).status;
    assert.notEqual(after, "running", `${id} must no longer read as running (got ${after})`);
  }
});

test("registering a session sweeps it — so a restart settles what the last run abandoned", async (t) => {
  const { workspace, kernel, sessionId } = await setup(t);
  seedDeadJob(kernel, sessionId, 9);
  assert.equal(kernel.getBackgroundJob("sh_dead_9").status, "running");

  // A fresh registry, as a restarted host would build.
  const restarted = new ShellRegistry();
  restarted.configureDurability({ kernel, workspace });
  restarted.registerSession(sessionId);

  assert.notEqual(
    kernel.getBackgroundJob("sh_dead_9").status,
    "running",
    "session registration must reconcile abandoned jobs",
  );
});

test("the sweep is idempotent and never throws on a terminal job", async (t) => {
  const { workspace, kernel, sessionId } = await setup(t);
  seedDeadJob(kernel, sessionId, 4);
  const registry = new ShellRegistry();
  registry.configureDurability({ kernel, workspace });

  const first = registry.sweepDurableJobs(sessionId);
  assert.equal(first.settled, 1);
  const second = registry.sweepDurableJobs(sessionId);
  assert.equal(second.settled, 0, "already-terminal jobs are skipped, not re-settled");
});

test("a sweep with no durability configured is a harmless no-op", () => {
  const registry = new ShellRegistry();
  assert.deepEqual(registry.sweepDurableJobs("sess_none"), { settled: 0, reaped: 0 });
});
