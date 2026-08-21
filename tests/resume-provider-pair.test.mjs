// A RESUMED session must come back on ITS OWN saved provider+model pair.
//
// The field failure (Aug 2026): the daemon's main lane is a moving target —
// failover and model switches mutate it — and pairing main's provider with a
// resumed session's model built Franken-selections. A deepseek-wire client
// asked to run gpt-5.6-sol 400'd 17 times across three days:
//   "The supported API model names are deepseek-v4-pro or deepseek-v4-flash,
//    but you passed gpt-5.6-sol."
// The fix (resolveEntry reads the snapshot's saved pair) landed 2026-08-02;
// this test is the lock that keeps it fixed.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "packages", "cli", "dist", "entry.js");

test("a resumed session runs its saved model, not the daemon main lane's", async (t) => {
  try {
    await access(ENTRY);
  } catch {
    t.skip("packages/cli/dist not built — run pnpm build");
    return;
  }

  const home = await mkdtemp(path.join(os.tmpdir(), "ares-resume-home-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-resume-ws-"));

  // A legacy on-disk session whose saved pair differs from the daemon's main
  // lane model. (Legacy layout: meta.json + events.jsonl; no kernel row —
  // exactly what an old workspace being reopened looks like.)
  const savedId = "sess_saved_pair_regression";
  const sessionDir = path.join(workspace, ".ares", "sessions", savedId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({
      id: savedId,
      workspace,
      provider: { name: "mock-echo", model: "mock-saved-model" },
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n",
    "utf8",
  );
  await writeFile(path.join(sessionDir, "events.jsonl"), "", "utf8");

  const child = spawn(process.execPath, [ENTRY, "daemon", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      ARES_HOME: home,
      ARES_PROVIDER: "mock",
      ARES_MODEL: "mock-main-model",
      ARES_AGENT_ENABLED: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });

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
  const waitFor = async (pred, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`daemon exited (${child.exitCode}): ${stderr.slice(0, 600)}`);
      const hit = events().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };

  assert.ok(await waitFor((e) => e.type === "daemon_ready" || e.type === "ready", 90_000), "daemon started");

  // Any per-session command materializes the entry through resolveEntry.
  child.stdin.write(JSON.stringify({ type: "background_list", sessionId: savedId }) + "\n");

  const opened = await waitFor((e) => e.type === "session_opened");
  assert.ok(opened, `resumed session opened. stderr: ${stderr.slice(0, 600)}`);
  assert.equal(
    opened.model,
    "mock-saved-model",
    "the resumed card must run ITS OWN saved model — inheriting the main lane's builds a Franken-selection the provider 400s",
  );
});
