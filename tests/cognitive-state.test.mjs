// The cockpit's data contract, against a real daemon.
//
// This is the instrument that tells the owner which subsystems are actually
// alive. It therefore has to be trustworthy about two things above all:
//   1. it must never mutate agent state (it is a read-only snapshot);
//   2. an empty section must be reported as empty, and a subsystem that ran and
//      found NOTHING must be distinguishable from one that never ran.
//
// (2) is the whole reason this exists: reliabilityTriage read zero rollout files
// for three releases and reported it as a clean run, because "found nothing" and
// "saw nothing" collapsed into the same silence.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "packages", "cli", "dist", "entry.js");

async function startDaemon() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-cog-home-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-cog-ws-"));
  const child = spawn(process.execPath, [ENTRY, "daemon", "--json"], {
    cwd: workspace,
    env: { ...process.env, ARES_HOME: home, ARES_PROVIDER: "mock", ARES_MODEL: "mock", ARES_AGENT_ENABLED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const events = () =>
    stdout.split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  const waitFor = async (pred, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`daemon exited (${child.exitCode}): ${stderr.slice(0, 400)}`);
      const hit = events().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };
  return {
    send: (c) => child.stdin.write(JSON.stringify(c) + "\n"),
    events,
    waitFor,
    stderr: () => stderr,
    stop: () => { try { child.kill(); } catch { /* gone */ } },
  };
}

test("cognitive_state reports a full, honest snapshot", async (t) => {
  try {
    await access(ENTRY);
  } catch {
    t.skip("packages/cli/dist not built — run pnpm build");
    return;
  }

  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  assert.ok(await daemon.waitFor((e) => e.type === "daemon_ready" || e.type === "ready", 90_000), "daemon started");

  daemon.send({ type: "cognitive_state" });
  const reply = await daemon.waitFor((e) => e.type === "cognitive_state");
  assert.ok(reply, `cognitive_state answered. stderr: ${daemon.stderr().slice(0, 400)}`);
  const s = reply.cognitive;

  // Every section must be PRESENT even when empty, so the UI renders "nothing
  // yet" rather than crashing or silently omitting a panel.
  for (const key of [
    "sessionId", "at", "missions", "steering", "todos", "evidence",
    "uncertainty", "recalled", "failures", "recovery", "blockedApprovals",
    "touchedFiles", "liveness",
  ]) {
    assert.ok(key in s, `snapshot carries "${key}"`);
  }
  for (const key of ["missions", "steering", "todos", "evidence", "uncertainty", "recalled", "failures", "recovery", "blockedApprovals", "touchedFiles", "liveness"]) {
    assert.ok(Array.isArray(s[key]), `"${key}" is an array (empty is fine, absent is not)`);
  }

  // A fresh session genuinely has nothing pursued or proven yet, and the
  // snapshot must say so rather than inventing content.
  assert.equal(s.evidence.length, 0, "a fresh session claims no evidence");
  assert.equal(s.blockedApprovals.length, 0, "nothing is waiting on the owner yet");

  // ── The load-bearing part: liveness distinguishes idle from dead. ──
  const names = s.liveness.map((l) => l.subsystem);
  for (const expected of ["Working state (journal)", "Continuous verification", "Memory recall", "Reliability triage", "Mission loop"]) {
    assert.ok(names.includes(expected), `liveness covers "${expected}" (saw ${names.join(" | ")})`);
  }
  for (const row of s.liveness) {
    assert.ok(["live", "idle", "dead", "unknown"].includes(row.state), `${row.subsystem} has a real state, got "${row.state}"`);
    assert.ok(row.detail && row.detail.length > 0, `${row.subsystem} explains itself instead of showing a bare status`);
  }

  // ── The invariant, asserted as INTENT rather than exact copy ──
  //
  // Nothing that has not actually run may report "live". That single rule is
  // what a dead subsystem hides behind, and it must hold for every row on a
  // fresh process regardless of how the wording evolves.
  for (const row of s.liveness) {
    if (row.subsystem === "Working state (journal)") continue; // the journal IS open
    assert.notEqual(row.state, "live", `${row.subsystem} must not claim "live" before doing anything`);
  }

  // Triage has not run in a fresh process — never "live", and it says why.
  const triage = s.liveness.find((l) => l.subsystem === "Reliability triage");
  assert.equal(triage.state, "unknown", "a triage that never ran is 'unknown'");
  assert.match(triage.detail, /has not run/i);

  // The mission loop is now instrumented, so a fresh process reports "idle"
  // (not invoked) rather than "unknown" (cannot tell) — and still never "live".
  const mission = s.liveness.find((l) => l.subsystem === "Mission loop");
  assert.equal(mission.state, "idle", "an un-invoked mission loop is idle, not live and not unknowable");
  assert.match(mission.detail, /has not been invoked/i, "and it says so plainly");

  // Recall on a session with no completed turn is "unknown": the durable
  // summary does not exist yet, so claiming it ran and found nothing would be
  // an invention. This is the distinction that made working recall look dead.
  const recall = s.liveness.find((l) => l.subsystem === "Memory recall");
  assert.equal(recall.state, "unknown", "recall before any turn is 'unknown', not 'idle'");
});

test("cognitive_state is read-only — two calls agree, and it never mutates state", async (t) => {
  try {
    await access(ENTRY);
  } catch {
    t.skip("packages/cli/dist not built");
    return;
  }
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  assert.ok(await daemon.waitFor((e) => e.type === "daemon_ready" || e.type === "ready", 90_000));

  daemon.send({ type: "cognitive_state" });
  const first = await daemon.waitFor((e) => e.type === "cognitive_state");
  await new Promise((r) => setTimeout(r, 600));
  daemon.send({ type: "cognitive_state" });
  const both = await (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const all = daemon.events().filter((e) => e.type === "cognitive_state");
      if (all.length >= 2) return all;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  })();
  assert.ok(both, "a second snapshot answered");

  // Timestamps legitimately differ between two reads; everything else must not.
  const strip = (x) => ({
    ...x.cognitive,
    at: "<ts>",
    liveness: x.cognitive.liveness.map((l) => ({ ...l, lastRunAt: undefined })),
  });
  assert.deepEqual(strip(both[1]), strip(both[0]), "assembling a snapshot changed nothing — it is a read, not a write");
  assert.equal(both[0].cognitive.sessionId, first.cognitive.sessionId);
});

test("a dormant session answers empty — never someone else's state, never an error", async (t) => {
  // The desktop polls cognitive_state every 5s while HELM is open, and a
  // resumed card has no live entry until its first send. When that poll was
  // answered with daemon_error, the transcript filled with red "unknown
  // session" notices — one per tick (field report, 2026-08-08). The contract
  // now: a session the daemon has no live entry for gets cognitive: null
  // (dormant), which the UI renders as its honest "no snapshot yet" state.
  // The original invariant still holds: it must NOT answer with the primary
  // session's snapshot.
  try {
    await access(ENTRY);
  } catch {
    t.skip("packages/cli/dist not built");
    return;
  }
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  assert.ok(await daemon.waitFor((e) => e.type === "daemon_ready" || e.type === "ready", 90_000));

  daemon.send({ type: "cognitive_state", sessionId: "sess_does_not_exist" });
  const reply = await daemon.waitFor((e) => e.type === "cognitive_state");
  assert.ok(reply, "a dormant session id still gets a reply");
  assert.equal(reply.cognitive, null, "the reply is an empty snapshot, not another session's state");
  const spam = daemon.events().find((e) => e.type === "daemon_error" && /cognitive_state/.test(e.error ?? ""));
  assert.equal(spam, undefined, "no daemon_error — a 5s poll must not spam the transcript");
});
