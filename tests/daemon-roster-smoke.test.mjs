// Does the product actually START, and do the roster commands answer?
//
// This exists because v0.29.0 shipped an installer that could not start its own
// backend: every unit test was green, because none of them ran the built daemon
// as a real process. This one does — it spawns dist/entry.js, waits for
// daemon_ready over the real stdio protocol, and drives the roster commands the
// desktop uses.
//
// Kept deliberately cheap (mock provider, temp home + workspace, no network) so
// it can sit in the default suite rather than being a thing someone remembers
// to run before a release.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "packages", "cli", "dist", "entry.js");
const START_TIMEOUT_MS = 90_000;
const REPLY_TIMEOUT_MS = 30_000;

/** Boot the daemon and return a small driver around its stdio protocol. */
async function startDaemon() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-smoke-home-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-smoke-ws-"));
  // `--json` is required: without it the daemon exits with a usage error, which
  // is itself a thing worth pinning — the desktop passes it.
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
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

  const waitFor = async (pred, ms = REPLY_TIMEOUT_MS) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`daemon exited early (code ${child.exitCode}): ${stderr.slice(0, 400)}`);
      }
      const hit = events().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };

  const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");

  return {
    child,
    send,
    events,
    waitFor,
    stderr: () => stderr,
    stop: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

test("the built daemon starts and serves the roster", async (t) => {
  try {
    await access(ENTRY);
  } catch {
    t.skip("packages/cli/dist not built — run pnpm build");
    return;
  }

  const daemon = await startDaemon();
  t.after(() => daemon.stop());

  const ready = await daemon.waitFor((e) => e.type === "daemon_ready" || e.type === "ready", START_TIMEOUT_MS);
  assert.ok(ready, `the backend announced itself. stderr: ${daemon.stderr().slice(0, 600)}`);

  // ── roster_list ────────────────────────────────────────────────────
  daemon.send({ type: "roster_list" });
  const roster = await daemon.waitFor((e) => e.type === "roster_list");
  assert.ok(roster, "roster_list answered");
  const names = roster.personas.map((p) => p.name);
  for (const builtin of ["vitruvius", "forge", "aegis", "scribe"]) {
    assert.ok(names.includes(builtin), `${builtin} is on the roster (saw ${names.join(", ")})`);
  }
  assert.equal(roster.active, null, "a fresh session wears no persona");

  const vitruvius = roster.personas.find((p) => p.name === "vitruvius");
  // `body` is what HELM's Edit seeds the composer from. If the wire drops it,
  // Edit silently blanks the method on save — so pin it here.
  assert.ok(vitruvius.body?.length > 0, "the persona body is wired for editing");
  assert.ok(vitruvius.triggers.length > 0, "triggers reach the UI");
  assert.ok(vitruvius.tools.length > 0, "the delegated tool whitelist reaches the UI");

  // ── adopt ──────────────────────────────────────────────────────────
  daemon.send({ type: "persona_adopt", name: "aegis" });
  const adopted = await daemon.waitFor((e) => e.type === "persona_changed" && e.active);
  assert.equal(adopted.active.name, "aegis");
  assert.equal(adopted.origin, "owner", "an explicit adopt is attributed to the owner, not to a trigger");

  // ── an unknown name must fail LOUDLY ───────────────────────────────
  daemon.send({ type: "persona_adopt", name: "does-not-exist" });
  const failed = await daemon.waitFor((e) => e.type === "persona_changed" && e.error);
  assert.match(failed.error, /no persona named/i, "a bad name reports an error instead of silently succeeding");

  // ── release ────────────────────────────────────────────────────────
  daemon.send({ type: "persona_adopt", name: "" });
  const released = await daemon.waitFor(
    (e) => e.type === "persona_changed" && e.active === null && !e.error,
  );
  assert.ok(released, "an empty name releases the persona");
});
