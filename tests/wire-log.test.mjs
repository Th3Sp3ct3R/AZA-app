// Wire-prompt log — the field-debuggability contract.
//
// Every outbound provider call must leave a JSONL record on disk BEFORE the
// request is dispatched, so a hang, stall, or oversized-payload failure can be
// diagnosed after the fact from what was actually sent. This exists because a
// field user watching "no stream events for 90s" had no way to observe what
// data was shipping to the cloud or why it was that large (report, 2026-08-06).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(__dirname, "..", "packages", "cli", "dist", "entry.js");

function runAres(workspaceRoot, home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    encoding: "utf8",
    windowsHide: true,
    cwd: workspaceRoot,
    env: { ...process.env, ARES_HOME: home, ARES_AGENT_ENABLED: "0", ...extraEnv },
  });
}

test("every provider call logs its outbound prompt shape to .ares/wire-log", async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ares-wire-ws-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-wire-home-"));
  const r = runAres(workspaceRoot, home, ["run", "--provider", "mock", "--goal", "ping"]);
  assert.equal(r.status, 0, `ares run failed: ${r.stderr}`);
  const sessionId = r.stderr.match(/session=(sess_[^\s]+)/)?.[1];
  assert.ok(sessionId, `missing session id in stderr: ${r.stderr}`);

  const logPath = path.join(workspaceRoot, ".ares", "wire-log", `${sessionId}.jsonl`);
  const lines = (await readFile(logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length >= 1, "at least one provider call was logged");

  const rec = lines[0];
  // The fields that answer "what was sent and why was it that big".
  assert.equal(rec.provider, "mock-echo");
  assert.ok(typeof rec.model === "string" && rec.model.length > 0, "records the model");
  assert.ok(typeof rec.estPromptTokens === "number" && rec.estPromptTokens > 0, "records the estimated prompt size");
  assert.ok(typeof rec.systemChars === "number" && rec.systemChars > 0, "records the system prompt weight");
  assert.ok(typeof rec.at === "string" && !Number.isNaN(Date.parse(rec.at)), "timestamped");
  assert.ok(Array.isArray(rec.messages) && rec.messages.length >= 1, "carries the message manifest");
  for (const m of rec.messages) {
    assert.ok(m.role === "user" || m.role === "assistant", `message role is real, got ${m.role}`);
    assert.ok(Array.isArray(m.blocks) && m.blocks.length >= 1, "each message lists its blocks");
    for (const b of m.blocks) {
      assert.ok(typeof b.type === "string", "block records its type");
      assert.ok(typeof b.chars === "number" && b.chars > 0, "block records its serialized size");
    }
  }
});

test("ARES_WIRE_LOG=0 opts out", async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ares-wire-off-ws-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-wire-off-home-"));
  const r = runAres(workspaceRoot, home, ["run", "--provider", "mock", "--goal", "ping"], { ARES_WIRE_LOG: "0" });
  assert.equal(r.status, 0, `ares run failed: ${r.stderr}`);
  const sessionId = r.stderr.match(/session=(sess_[^\s]+)/)?.[1];
  assert.ok(sessionId, `missing session id in stderr: ${r.stderr}`);
  const logPath = path.join(workspaceRoot, ".ares", "wire-log", `${sessionId}.jsonl`);
  await assert.rejects(() => readFile(logPath, "utf8"), /ENOENT/, "no wire log is written when opted out");
});
