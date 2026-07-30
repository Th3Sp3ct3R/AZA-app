// Friction telemetry — every turn folds into one JSONL line so upgrades are data-driven.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FrictionRecorder, MockEchoProvider, Session, summarizeFriction } from "../packages/core/dist/index.js";

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

test("v2 envelope adds source/model/work truth and bounded redacted diagnostics", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-friction-v2-"));
  const dir = path.join(home, "telemetry");
  const workspace = path.join(home, "Private Workspace");
  try {
    const rec = new FrictionRecorder("sess_v2", {
      dir,
      source: "core",
      workspace,
      provider: "anthropic",
      model: "claude-test",
      location: {
        registryHome: home,
        rolloutPath: path.join(workspace, ".ares", "sessions", "sess_v2", "events.jsonl"),
        metaPath: path.join(workspace, ".ares", "sessions", "sess_v2", "meta.json"),
        format: "core-rollout-v1",
      },
    });
    rec.record({
      type: "turn_start",
      turnId: "turn_v2",
      sessionId: "sess_v2",
      userMessage: { id: "u1", role: "user", content: [{ type: "text", text: "private prompt" }], createdAt: new Date().toISOString() },
    });
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
    for (let i = 0; i < words.length; i++) {
      const id = `diag_${i}`;
      const tool = `Tool${i}`;
      rec.record({ type: "tool_use_start", id, name: tool });
      const secret = i === 0 ? " sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456" : "";
      rec.record({
        type: "tool_error",
        id,
        error: `${words[i]} failure at ${path.join(workspace, "secret.ts")}${secret} value 93842`,
        durationMs: 2,
      });
    }
    rec.record(turnEnd({
      workStatus: "blocked",
      provider: "anthropic",
      model: "claude-test-v2",
    }));
    await rec.settle();

    const file = (await readdir(dir)).find((name) => name.startsWith("friction-") && name.endsWith(".jsonl"));
    assert.ok(file);
    const raw = (await readFile(path.join(dir, file), "utf8")).trim();
    const line = JSON.parse(raw);
    assert.equal(line.schemaVersion, 2);
    assert.equal(line.recordType, "friction_turn");
    assert.equal(line.source, "core");
    assert.match(line.workspaceHash, /^[a-f0-9]{64}$/);
    assert.equal(line.provider, "anthropic");
    assert.equal(line.model, "claude-test-v2");
    assert.equal(line.workStatus, "blocked");
    assert.equal(line.turnId, "turn_v2");
    assert.equal(line.diagnostics.length, 8, "unique diagnostics are hard-bounded");
    assert.equal(line.diagnosticsDropped, 4);
    assert.ok(line.diagnostics.every((diagnostic) => /^[a-f0-9]{16}$/.test(diagnostic.signature)));
    assert.ok(line.diagnostics.every((diagnostic) => diagnostic.sample.length <= 240));
    assert.doesNotMatch(raw, /sk-ant-api03|abcdefghijklmnopqrstuvwxyz123456/i);
    assert.doesNotMatch(raw, /Private Workspace/i, "diagnostic samples do not retain the raw workspace");
    assert.match(raw, /<workspace>/, "relative file context remains useful after workspace scrubbing");

    const registry = await readdir(path.join(home, "telemetry", "session-locations"));
    assert.equal(registry.filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("core Session registers its rollout and emits a v2 core friction row", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-core-observability-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const telemetryDir = path.join(home, "telemetry");
  try {
    const session = new Session({
      workspace,
      provider: new MockEchoProvider(),
      model: "mock",
      systemPrompt: "test",
      tools: [],
      sessionId: "sess_core_registry",
      telemetryDir,
      sessionRegistryHome: home,
    });
    for await (const _event of session.send("hello registry")) {
      // Drain through turn_end; Session's durability barrier settles both logs.
    }

    const frictionName = (await readdir(telemetryDir)).find((name) => /^friction-.*\.jsonl$/.test(name));
    assert.ok(frictionName);
    const friction = JSON.parse((await readFile(path.join(telemetryDir, frictionName), "utf8")).trim());
    assert.equal(friction.source, "core");
    assert.equal(friction.provider, "mock-echo");
    assert.equal(friction.model, "mock");
    assert.equal(friction.sessionId, "sess_core_registry");

    const registryDir = path.join(telemetryDir, "session-locations");
    const registryName = (await readdir(registryDir)).find((name) => name.endsWith(".json"));
    assert.ok(registryName);
    const location = JSON.parse(await readFile(path.join(registryDir, registryName), "utf8"));
    assert.equal(location.source, "core");
    assert.equal(
      location.rolloutPath,
      path.join(workspace, ".ares", "sessions", "sess_core_registry", "events.jsonl"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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
