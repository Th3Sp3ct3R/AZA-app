// Friction telemetry — every turn folds into one JSONL line so upgrades are data-driven.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FrictionRecorder, summarizeFriction } from "../packages/core/dist/index.js";

function turnEnd(over = {}) {
  return { type: "turn_end", status: "completed", durationMs: 1234, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800 }, ...over };
}

test("recorder folds tool calls, edit tiers, stalls, verify flags into one line", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-friction-"));
  try {
    const rec = new FrictionRecorder("sess_t1", dir);
    rec.record({ type: "tool_use_start", id: "a", name: "Edit" });
    rec.record({ type: "tool_end", id: "a", output: { layer: "anchor" }, durationMs: 5 });
    rec.record({ type: "tool_use_start", id: "b", name: "Edit" });
    rec.record({ type: "tool_error", id: "b", error: "old_string not found", durationMs: 3 });
    rec.record({ type: "tool_use_start", id: "c", name: "Bash" });
    rec.record({ type: "tool_end", id: "c", output: "ok", durationMs: 9 });
    rec.record({ type: "error", error: { code: "reasoning_stall", message: "x", retriable: true } });
    rec.record({ type: "system_reminder_injected", text: "red", source: "verifier" });
    rec.record(turnEnd());
    await rec.settle();

    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const line = JSON.parse((await readFile(path.join(dir, files[0]), "utf8")).trim());
    assert.equal(line.sessionId, "sess_t1");
    assert.equal(line.status, "completed");
    assert.deepEqual(line.tools.Edit, { calls: 2, errors: 1 });
    assert.deepEqual(line.tools.Bash, { calls: 1, errors: 0 });
    assert.equal(line.editTiers.anchor, 1);
    assert.equal(line.editTiers.miss, 1);
    assert.equal(line.stalls, 1);
    assert.equal(line.reasoningStalls, 1);
    assert.equal(line.verifyReminders, 1);
    assert.equal(line.cacheReadRatio, 0.8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consecutive turns append separate lines and reset state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-friction-"));
  try {
    const rec = new FrictionRecorder("sess_t2", dir);
    rec.record({ type: "tool_use_start", id: "a", name: "Read" });
    rec.record({ type: "tool_end", id: "a", output: "x", durationMs: 1 });
    rec.record(turnEnd());
    rec.record(turnEnd({ status: "failed", usage: { inputTokens: 10, outputTokens: 1 } }));
    await rec.settle();
    const files = await readdir(dir);
    const lines = (await readFile(path.join(dir, files[0]), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0].tools.Read, { calls: 1, errors: 0 });
    assert.equal(lines[1].tools.Read, undefined, "second turn starts clean");
    assert.equal(lines[1].status, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ARES_TELEMETRY=0 writes nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-friction-"));
  process.env.ARES_TELEMETRY = "0";
  try {
    const rec = new FrictionRecorder("sess_t3", dir);
    rec.record({ type: "tool_use_start", id: "a", name: "Read" });
    rec.record(turnEnd());
    await rec.settle();
    assert.deepEqual(await readdir(dir), []);
  } finally {
    delete process.env.ARES_TELEMETRY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("node test sessions do not contaminate the default user telemetry directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-friction-home-"));
  const prevHome = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  try {
    const rec = new FrictionRecorder("sess_default_test");
    rec.record({ type: "tool_use_start", id: "browser", name: "Browser" });
    rec.record({ type: "tool_error", id: "browser", error: "synthetic test failure" });
    rec.record(turnEnd());
    await rec.settle();
    assert.deepEqual(await readdir(home), [], "default telemetry stays untouched under node --test");
  } finally {
    if (prevHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("summarizeFriction aggregates across turns with error-rate ordering data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-friction-"));
  try {
    const rec = new FrictionRecorder("sess_t4", dir);
    for (let i = 0; i < 3; i++) {
      rec.record({ type: "tool_use_start", id: `a${i}`, name: "Grep" });
      rec.record(i === 0 ? { type: "tool_error", id: `a${i}`, error: "bad regex" } : { type: "tool_end", id: `a${i}`, output: "ok" });
      rec.record(turnEnd());
    }
    await rec.settle();
    const s = await summarizeFriction(dir, 7);
    assert.equal(s.turns, 3);
    assert.equal(s.completed, 3);
    assert.deepEqual(s.tools.Grep, { calls: 3, errors: 1 });
    assert.equal(s.avgCacheReadRatio, 0.8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
