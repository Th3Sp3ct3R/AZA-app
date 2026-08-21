// Condition watchers — initiative v2. Pins:
//  1. CRUD round-trips through disk with cadence clamping (mirror of standing orders).
//  2. A tripped condition materializes a PLANNING-ONLY goal (never an execution
//     mission) — the statement carries the "Plan ONLY — do NOT execute" gate.
//  3. Fingerprint dedupe: a condition stuck red the SAME way proposes ONCE; a
//     changed fingerprint may propose again; recovery re-arms the watcher.
//  4. One proposal in flight: while the last proposal goal is active, the
//     watcher stays quiet even if the fingerprint changes.
//  5. The background loop surfaces watcher_fired events and picks the proposal
//     goal up on the SAME tick (watchers run before the goal read).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addWatcher,
  loadWatchers,
  removeWatcher,
  setWatcherEnabled,
  dueWatchers,
  checkWatchers,
  normalizeWatcher,
  renderWatchers,
  MIN_WATCHER_CADENCE_MS,
  activeGoals,
  loadGoal,
  saveGoal,
  OperatorBackgroundLoop,
} from "../packages/operator/dist/index.js";

async function tmpHome() {
  return mkdtemp(path.join(tmpdir(), "ares-watchers-"));
}

test("normalizeWatcher clamps cadence and defaults fireWhen to unmet", () => {
  const w = normalizeWatcher({ label: "build", condition: { kind: "always", met: true }, proposal: "fix it", cadenceMs: 1000 });
  assert.equal(w.cadenceMs, MIN_WATCHER_CADENCE_MS);
  assert.equal(w.fireWhen, "unmet");
  assert.equal(w.enabled, true);
  assert.equal(w.fireCount, 0);
});

test("add / load / toggle / remove round-trips through disk", async () => {
  const home = await tmpHome();
  try {
    const w = await addWatcher(home, {
      label: "site up",
      condition: { kind: "http", url: "http://127.0.0.1:1/health" },
      proposal: "diagnose why the site is down",
      cadenceMs: 10 * 60_000,
    });
    let all = await loadWatchers(home);
    assert.equal(all.length, 1);
    assert.equal(all[0].label, "site up");

    assert.equal(await setWatcherEnabled(home, w.id, false), true);
    all = await loadWatchers(home);
    assert.equal(all[0].enabled, false);
    assert.equal(await setWatcherEnabled(home, "nope", true), false);

    assert.equal(await removeWatcher(home, w.id), true);
    assert.equal((await loadWatchers(home)).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dueWatchers: never-checked due; recently-checked not; disabled never", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  const base = {
    schemaVersion: 1,
    condition: { kind: "always", met: true },
    fireWhen: "unmet",
    proposal: "p",
    cadenceMs: 3_600_000,
    fireCount: 0,
    createdAt: now.toISOString(),
  };
  const watchers = [
    { ...base, id: "a", label: "never checked", enabled: true },
    { ...base, id: "b", label: "checked 2h ago", enabled: true, lastCheckedAt: new Date(now.getTime() - 2 * 3_600_000).toISOString() },
    { ...base, id: "c", label: "checked 5m ago", enabled: true, lastCheckedAt: new Date(now.getTime() - 5 * 60_000).toISOString() },
    { ...base, id: "d", label: "disabled", enabled: false },
  ];
  const due = dueWatchers(watchers, now).map((w) => w.id);
  assert.deepEqual(due.sort(), ["a", "b"]);
});

test("a tripped condition materializes a planning-only proposal goal", async () => {
  const home = await tmpHome();
  try {
    // fireWhen unmet + file that doesn't exist => tripped.
    await addWatcher(home, {
      label: "artifact present",
      condition: { kind: "file", path: path.join(home, "no-such-file.txt") },
      proposal: "figure out why the build artifact is missing",
    });
    const { checked, goals, fired } = await checkWatchers(home, {}, new Date());
    assert.equal(checked, 1);
    assert.equal(fired.length, 1);
    assert.equal(goals.length, 1);
    assert.match(goals[0].statement, /^Plan ONLY — do NOT execute\./);
    assert.match(goals[0].statement, /figure out why the build artifact is missing/);
    assert.match(goals[0].statement, /artifact present/);
    assert.equal(goals[0].status, "active");
    assert.equal((await activeGoals(home)).length, 1);

    const [w] = await loadWatchers(home);
    assert.equal(w.fireCount, 1);
    assert.ok(w.lastFiredAt);
    assert.ok(w.lastFingerprint);
    assert.equal(w.lastGoalId, goals[0].id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fingerprint dedupe: same red state proposes once; recovery re-arms", async () => {
  const home = await tmpHome();
  try {
    const target = path.join(home, "flag.txt");
    const w = await addWatcher(home, {
      label: "flag file",
      condition: { kind: "file", path: target },
      proposal: "restore the flag file",
      cadenceMs: 60_000,
    });
    const t0 = new Date("2026-08-11T10:00:00Z");
    const first = await checkWatchers(home, {}, t0);
    assert.equal(first.fired.length, 1);
    // Mark the proposal goal done so "in flight" doesn't mask the dedupe assertion.
    const goal = await loadGoal(home, first.fired[0].goalId);
    goal.status = "done";
    await saveGoal(home, goal);

    // Still missing, same fingerprint, past cadence => checked but NOT re-fired.
    const second = await checkWatchers(home, {}, new Date(t0.getTime() + 2 * 60_000));
    assert.equal(second.checked, 1);
    assert.equal(second.fired.length, 0);

    // Recovery: file appears => probe green => fingerprint cleared.
    await writeFile(target, "back\n");
    const third = await checkWatchers(home, {}, new Date(t0.getTime() + 4 * 60_000));
    assert.equal(third.fired.length, 0);
    assert.equal((await loadWatchers(home))[0].lastFingerprint, undefined);

    // Breaks again => fires fresh.
    await rm(target);
    const fourth = await checkWatchers(home, {}, new Date(t0.getTime() + 6 * 60_000));
    assert.equal(fourth.fired.length, 1);
    assert.equal((await loadWatchers(home))[0].fireCount, 2);
    assert.equal(w.id, (await loadWatchers(home))[0].id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("one proposal in flight: an active proposal goal keeps the watcher quiet", async () => {
  const home = await tmpHome();
  try {
    const target = path.join(home, "gone.txt");
    await addWatcher(home, {
      label: "gone file",
      condition: { kind: "file", path: target },
      proposal: "investigate the missing file",
      cadenceMs: 60_000,
    });
    const t0 = new Date("2026-08-11T10:00:00Z");
    const first = await checkWatchers(home, {}, t0);
    assert.equal(first.fired.length, 1);

    // Different red fingerprint would normally re-fire — but the proposal goal is
    // still ACTIVE, so the watcher must stay quiet. Simulate the fingerprint
    // change by clearing it on disk.
    const [w] = await loadWatchers(home);
    w.lastFingerprint = "something-else";
    const { saveWatcher } = await import("../packages/operator/dist/index.js");
    await saveWatcher(home, w);

    const second = await checkWatchers(home, {}, new Date(t0.getTime() + 2 * 60_000));
    assert.equal(second.fired.length, 0);
    assert.equal((await activeGoals(home)).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("background loop: watcher_fired surfaces and the proposal runs the same tick", async () => {
  const home = await tmpHome();
  try {
    await mkdir(path.join(home, "operator"), { recursive: true });
    await addWatcher(home, {
      label: "always red",
      condition: { kind: "always", met: false },
      proposal: "propose the fix",
    });
    const events = [];
    const ran = [];
    const loop = new OperatorBackgroundLoop(
      {
        home,
        dispatcher: {
          async runStep(goal) {
            ran.push(goal.statement);
            return { moved: true, goalMet: true, workStatus: "verified", evidence: "test" };
          },
        },
      },
      { emit: (e) => events.push(e) },
    );
    const tick = await loop.tickOnce("manual");
    const fired = events.filter((e) => e.type === "watcher_fired");
    assert.equal(fired.length, 1);
    assert.equal(fired[0].label, "always red");
    assert.ok(fired[0].goalId);
    // The proposal goal was picked up on the SAME tick (watchers run pre-read).
    assert.equal(tick.ran.length, 1);
    assert.match(ran[0], /^Plan ONLY — do NOT execute\./);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("renderWatchers produces a readable list", async () => {
  const home = await tmpHome();
  try {
    assert.match(renderWatchers([]), /No watchers/);
    await addWatcher(home, {
      label: "build green",
      condition: { kind: "command", cmd: "node", args: ["-e", "process.exit(0)"] },
      proposal: "triage the build",
      cadenceMs: 30 * 60_000,
    });
    const text = renderWatchers(await loadWatchers(home));
    assert.match(text, /build green/);
    assert.match(text, /every 30m/);
    assert.match(text, /never fired/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
