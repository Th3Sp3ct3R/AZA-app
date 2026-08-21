// The memory write spine + reflection scheduler (core-redesign consolidation).
//
// Proves:
//   1. MemoryRouter is the ONE write path: per-channel dedupe (exact / jaccard /
//      tag-prefix / source-tag / none), salience gating, and batch flush live in
//      one place and behave exactly as the writers they replaced.
//   2. Routed writers still produce the same memories for the same inputs
//      (mergeDurableFacts, recordCardMemoryOnce, migrateLegacyVectors, runWitness).
//   3. ReflectionScheduler owns cadence: one timer, staged passes as pure
//      functions, single-flight per trigger, error containment.
//   4. withConsolidationLock: cross-process double-fire is skipped, stale locks
//      are stolen, the lock is always released.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MemoryRouter,
  MEMORY_CHANNEL_POLICIES,
  MemoryStore,
  mergeDurableFacts,
  migrateLegacyVectors,
  withConsolidationLock,
} from "../packages/mind/dist/index.js";
import {
  ReflectionScheduler,
  recordCardMemoryOnce,
  runWitness,
} from "../packages/agent/dist/index.js";

const makeDir = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-spine-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal fake store: counts flushes so batch behavior is observable. */
function fakeStore(seed = []) {
  const nodes = seed.map((n) => (typeof n === "string" ? { content: n } : n));
  let flushes = 0;
  return {
    nodes,
    get flushes() { return flushes; },
    all() { return nodes; },
    async add(input) { flushes++; const node = { ...input }; nodes.push(node); return node; },
    async addMany(inputs) { flushes++; const added = inputs.map((i) => ({ ...i })); nodes.push(...added); return added; },
  };
}

// ── 1. The router: one policy table, per-channel behavior ────────────────────

test("spine: every channel has a policy in the ONE table", () => {
  for (const channel of ["conversation", "witness", "dream", "card", "v4-migration", "manual"]) {
    assert.ok(MEMORY_CHANNEL_POLICIES[channel], `policy exists for ${channel}`);
    assert.ok(MEMORY_CHANNEL_POLICIES[channel].dedupe.kind, `dedupe rule for ${channel}`);
  }
});

test("spine: conversation channel gates on salience and jaccard-dedupes, one flush", async () => {
  const store = fakeStore(["Crix works twelve hour welding shifts from 6am to 6pm"]);
  const report = await new MemoryRouter(store).write("conversation", [
    { kind: "semantic", content: "Crix works 12-hour welding shifts from 6am to 6pm", salience: 0.9 }, // paraphrase dup
    { kind: "semantic", content: "Crix said hi in the chat today morning", salience: 0.1 }, // below floor
    { kind: "semantic", content: "ok", salience: 0.9 }, // too short
    { kind: "semantic", content: "Crix is allergic to penicillin medication", salience: 0.9 }, // lands
    { kind: "semantic", content: "Crix has a penicillin medication allergy", salience: 0.9 }, // intra-batch dup
  ]);
  assert.equal(report.written.length, 1);
  assert.match(report.written[0].input.content, /penicillin/);
  assert.deepEqual(
    report.skipped.map((s) => s.reason).sort(),
    ["below-salience", "duplicate", "duplicate", "empty"].sort(),
  );
  assert.equal(store.flushes, 1, "the whole batch flushed once (addMany)");
});

test("spine: witness channel dedupes on normalized content, exact", async () => {
  const store = fakeStore(["The build   uses PNPM workspaces"]);
  const report = await new MemoryRouter(store).write("witness", [
    { kind: "semantic", content: "the build uses pnpm workspaces" }, // whitespace/case dup
    { kind: "semantic", content: "The daemon speaks NDJSON over stdio" },
  ]);
  assert.equal(report.written.length, 1);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, "duplicate");
});

test("spine: dream channel is ungated — repeats land (consolidate merges later)", async () => {
  const store = fakeStore(["same snippet appears again"]);
  const report = await new MemoryRouter(store).write("dream", [
    { kind: "episodic", content: "same snippet appears again", strength: 0.55 },
  ]);
  assert.equal(report.written.length, 1, "no dedupe on the dream channel");
});

test("spine: card channel is idempotent by source id + provenance tag", async () => {
  const store = fakeStore([
    { content: "unrelated memory reusing the id", source: "card_1", tags: ["other"] },
  ]);
  const router = new MemoryRouter(store);
  const first = await router.write("card", [
    { kind: "procedural", content: "lesson learned about installers", source: "card_1", tags: ["lesson", "learning-card"] },
  ]);
  assert.equal(first.written.length, 1, "a non-card memory with the same id does not block the card");
  const second = await router.write("card", [
    { kind: "procedural", content: "lesson learned about installers", source: "card_1", tags: ["lesson", "learning-card"] },
  ]);
  assert.equal(second.written.length, 0, "the recorded card blocks a re-record");
  assert.equal(second.skipped[0].reason, "duplicate");
});

test("spine: v4-migration channel dedupes by v4-hash tag, intra-batch included", async () => {
  const store = fakeStore([{ content: "already migrated", tags: ["v4-vector-store", "v4-hash:aabbccdd"] }]);
  const report = await new MemoryRouter(store).write("v4-migration", [
    { kind: "semantic", content: "already migrated copy", tags: ["v4-vector-store", "v4-hash:aabbccdd"] },
    { kind: "semantic", content: "new row", tags: ["v4-vector-store", "v4-hash:11223344"] },
    { kind: "semantic", content: "new row duplicate", tags: ["v4-vector-store", "v4-hash:11223344"] },
  ]);
  assert.equal(report.written.length, 1);
  assert.equal(report.written[0].input.content, "new row");
  assert.equal(report.skipped.length, 2);
});

// ── 2. Routed writers: same inputs → same memories as before ─────────────────

test("spine: mergeDurableFacts routes through the spine with identical results", async () => {
  const store = fakeStore(["Crix works twelve hour welding shifts from 6am to 6pm"]);
  const res = await mergeDurableFacts(store, [
    { content: "Crix works 12-hour welding shifts from 6am to 6pm", kind: "fact", importance: 0.9 },
    { content: "Crix's girlfriend is named Jamara", kind: "relationship", importance: 0.9 },
    { content: "Crix said hi today", kind: "fact", importance: 0.1 },
  ]);
  assert.equal(res.added, 1);
  assert.equal(res.skipped, 2);
  assert.match(res.addedFacts[0], /Jamara/);
  const added = store.nodes[store.nodes.length - 1];
  assert.equal(added.kind, "semantic");
  assert.deepEqual(added.tags, ["reflected", "conversation", "relationship"]);
  assert.equal(added.source, "conversation-reflection");
  assert.equal(added.strength, 3, "importance→strength mapping unchanged");
});

test("spine: recordCardMemoryOnce stays idempotent end-to-end", async () => {
  const store = MemoryStore.memory();
  const first = await recordCardMemoryOnce(store, { id: "card_x", summary: "Use the daemon bridge for desktop turns", tags: ["ops"] });
  const second = await recordCardMemoryOnce(store, { id: "card_x", summary: "Use the daemon bridge for desktop turns", tags: ["ops"] });
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0].kind, "procedural");
  assert.ok(store.all()[0].tags.includes("learning-card"));
});

test("spine: migrateLegacyVectors is idempotent across re-runs (v4-hash routing)", async () => {
  const dir = await makeDir();
  const legacy = path.join(dir, "vectors.json");
  await fs.writeFile(legacy, JSON.stringify({
    version: 1,
    memories: [
      { id: 1, category: "USER", content: "Crix prefers concise answers", score: 2 },
      { id: 2, category: "PROJECT", content: "", score: 1 }, // empty → skipped
    ],
  }));
  const store = await MemoryStore.open(path.join(dir, "memory.jsonl"));
  const first = await migrateLegacyVectors({ store, legacyDbJsonPath: legacy });
  assert.deepEqual({ scanned: first.scanned, migrated: first.migrated, skipped: first.skipped }, { scanned: 2, migrated: 1, skipped: 1 });
  const second = await migrateLegacyVectors({ store, legacyDbJsonPath: legacy });
  assert.equal(second.migrated, 0, "re-run migrates nothing");
  assert.equal(second.skipped, 2);
  assert.equal(store.all().length, 1);
  assert.ok(store.all()[0].tags.some((t) => t.startsWith("v4-hash:")));
});

test("spine: the Witness dedupes through the router (not a private set)", async () => {
  const store = MemoryStore.memory();
  await store.add({ kind: "semantic", content: "The build uses pnpm workspaces" });
  const report = await runWitness({
    conversation: { user: "how do we build?", assistant: "pnpm build", status: "completed" },
    store,
    ask: async () => [
      { kind: "belief", claim: "the build   uses PNPM workspaces" }, // dup of stored
      { kind: "belief", claim: "The garrison rehydrates sessions from JSONL" }, // lands
      { kind: "belief", claim: "the garrison REHYDRATES sessions from jsonl" }, // intra-turn dup
    ],
  });
  assert.equal(report.accepted.length, 1);
  assert.equal(report.rejected.filter((r) => /duplicate/.test(r)).length, 2);
  assert.equal(store.all().length, 2);
});

// ── 3. ReflectionScheduler: one timer, staged pure passes ────────────────────

test("scheduler: fires registered passes in order with a shared now", async () => {
  const ran = [];
  const scheduler = new ReflectionScheduler()
    .register("sessionEnd", "first", async ({ now }) => { ran.push(["first", now.getTime()]); })
    .register("sessionEnd", "second", async ({ now }) => { ran.push(["second", now.getTime()]); })
    .register("interval", "not-this-one", async () => { ran.push(["wrong", 0]); });
  const now = new Date("2026-07-01T12:00:00Z");
  const outcomes = await scheduler.fire("sessionEnd", { now });
  assert.deepEqual(ran.map(([n]) => n), ["first", "second"]);
  assert.equal(ran[0][1], now.getTime());
  assert.deepEqual(outcomes.map((o) => [o.name, o.ok]), [["first", true], ["second", true]]);
});

test("scheduler: a throwing pass is contained and its siblings still run", async () => {
  const ran = [];
  const scheduler = new ReflectionScheduler()
    .register("sessionEnd", "boom", async () => { throw new Error("reflection exploded"); })
    .register("sessionEnd", "survivor", async () => { ran.push("survivor"); });
  const outcomes = await scheduler.fire("sessionEnd");
  assert.deepEqual(ran, ["survivor"]);
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].error, /reflection exploded/);
  assert.equal(outcomes[1].ok, true);
});

test("scheduler: single-flight — a concurrent same-trigger fire is skipped", async () => {
  let entered = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const scheduler = new ReflectionScheduler()
    .register("sessionEnd", "slow", async () => { entered++; await gate; });
  const firstFire = scheduler.fire("sessionEnd");
  await sleep(10);
  const second = await scheduler.fire("sessionEnd"); // while first is mid-flight
  assert.deepEqual(second, [], "re-entry skipped, not queued");
  assert.equal(entered, 1);
  release();
  const first = await firstFire;
  assert.equal(first.length, 1);
  // After the first completes, firing works again.
  const third = await scheduler.fire("sessionEnd");
  assert.equal(third.length, 1);
});

test("scheduler: start() owns the one interval timer; stop() clears it", async () => {
  let ticks = 0;
  const scheduler = new ReflectionScheduler().register("interval", "tick", () => { ticks++; });
  assert.equal(scheduler.running, false);
  scheduler.start(15);
  assert.equal(scheduler.running, true);
  await sleep(80);
  scheduler.stop();
  assert.equal(scheduler.running, false);
  assert.ok(ticks >= 2, `interval fired (${ticks} ticks)`);
  const after = ticks;
  await sleep(50);
  assert.equal(ticks, after, "no ticks after stop()");
});

// ── 4. Cross-process consolidation lock ───────────────────────────────────────

test("lock: a held lock makes the second reflector skip, and releases after", async () => {
  const dir = await makeDir();
  const memoryFile = path.join(dir, "memory.jsonl");
  let releaseFirst;
  const holdGate = new Promise((r) => { releaseFirst = r; });
  // The first holder SIGNALS the instant it's inside the critical section, so
  // the test never guesses how long acquisition takes (a fixed sleep flakes
  // under CI load — the async body may not have run yet). Deterministic.
  let announceHeld;
  const held = new Promise((r) => { announceHeld = r; });
  const first = withConsolidationLock(memoryFile, async () => { announceHeld(); await holdGate; return "first"; });
  await held; // the lock is provably held now
  const second = await withConsolidationLock(memoryFile, async () => "second");
  assert.equal(second, undefined, "contended pass is skipped, never queued");
  releaseFirst();
  assert.equal(await first, "first");
  const third = await withConsolidationLock(memoryFile, async () => "third");
  assert.equal(third, "third", "lock released after the holder finished");
});

test("lock: a stale lock from a dead process is stolen", async () => {
  const dir = await makeDir();
  const memoryFile = path.join(dir, "memory.jsonl");
  const lockFile = path.join(dir, ".consolidation.lock");
  await fs.writeFile(lockFile, "99999 2020-01-01T00:00:00.000Z\n");
  const old = new Date(Date.now() - 60 * 60_000);
  await fs.utimes(lockFile, old, old);
  const result = await withConsolidationLock(memoryFile, async () => "recovered", { staleMs: 5 * 60_000 });
  assert.equal(result, "recovered");
});

test("lock: fn errors propagate but the lock is still released", async () => {
  const dir = await makeDir();
  const memoryFile = path.join(dir, "memory.jsonl");
  await assert.rejects(
    () => withConsolidationLock(memoryFile, async () => { throw new Error("consolidate blew up"); }),
    /consolidate blew up/,
  );
  const next = await withConsolidationLock(memoryFile, async () => "ok");
  assert.equal(next, "ok");
});

// ── 5. The operational-noise gate (field report 2026-08-06: a MEMORY.md index
//      that was 24 "Tool error observed:" entries against 5 real memories) ────

test("noise: harness failure output is knowledge on NO channel", async () => {
  const { isOperationalNoise } = await import("../packages/mind/dist/index.js");
  const noise = [
    "Tool error observed: Workspace paths must be non-empty and relative.",
    "<tool_use_error>Read failed</tool_use_error>",
    "Bash failed: ENOENT no such file or directory D:\\missing",
    "at handleTurn (src/entry/daemon.ts:2041:13)",
    "the gateway answered HTTP 413 Request Entity Too Large",
    "command failed with exit code 1",
    "provider stalled twice at this prompt size",
    "no stream events for 90s — cutting the attempt",
  ];
  for (const channel of ["conversation", "witness", "dream", "card", "v4-migration", "manual"]) {
    const store = fakeStore();
    const report = await new MemoryRouter(store).write(
      channel,
      noise.map((content) => ({ kind: "episodic", content, salience: 0.95 })),
    );
    assert.equal(report.written.length, 0, `${channel} stored noise: ${JSON.stringify(report.written[0]?.input.content)}`);
    assert.ok(report.skipped.every((s) => s.reason === "operational-noise"), `${channel} skip reasons: ${report.skipped.map((s) => s.reason).join(",")}`);
  }
});

test("noise: real knowledge ABOUT failures still lands — the gate is signature-based, not word-based", async () => {
  const { isOperationalNoise } = await import("../packages/mind/dist/index.js");
  const knowledge = [
    "The test suite breaks when the daemon is still running — stop it first",
    "Crix prefers failing fast over silent retries in provider code",
    "This repo's build uses pnpm, and tsc -b is the whole build",
    "Deploys failed all week until the cache key included the lockfile hash",
  ];
  for (const content of knowledge) {
    assert.equal(isOperationalNoise(content), false, `false positive: ${content}`);
  }
  const store = fakeStore();
  const report = await new MemoryRouter(store).write(
    "manual",
    knowledge.map((content) => ({ kind: "semantic", content })),
  );
  assert.equal(report.written.length, knowledge.length, "legitimate failure-adjacent knowledge must not be gated");
});

test("noise: consolidate() durably prunes noise stored before the gate existed", async () => {
  const dir = await makeDir();
  const store = await MemoryStore.open(path.join(dir, "memory.jsonl"));
  await store.add({ kind: "semantic", content: "Tool error observed: <tool_use_error>timeout</tool_use_error>", source: "v4-migration" });
  await store.add({ kind: "semantic", content: "Crix is allergic to penicillin medication", source: "conversation" });
  const report = await store.consolidate();
  assert.ok(report.pruned >= 1, "legacy noise pruned");
  const contents = store.all().map((n) => n.content);
  assert.ok(!contents.some((c) => c.includes("Tool error observed")), "the error entry is gone");
  assert.ok(contents.some((c) => c.includes("penicillin")), "the real memory survives");
});

test("noise: legacy 'Recurring theme' filler is pruned wholesale", async () => {
  // Theme promotion is gone (a single token + a count is not knowledge — 47 of
  // 66 nodes on a real store were themes like "first" and "every"), and
  // consolidate() now clears the population it left behind.
  const dir = await makeDir();
  const store = await MemoryStore.open(path.join(dir, "memory.jsonl"));
  await store.add({ kind: "semantic", content: 'Recurring theme "first" observed across 3 episodes.', tags: ["theme:first"] });
  await store.add({ kind: "semantic", content: 'Recurring theme "claude" observed across 4 episodes.' });
  await store.add({ kind: "semantic", content: "Crix prefers pnpm for every build in this repo" });
  const report = await store.consolidate();
  assert.ok(report.pruned >= 2, `both theme nodes pruned, got ${report.pruned}`);
  const contents = store.all().map((n) => n.content);
  assert.ok(!contents.some((c) => c.startsWith("Recurring theme")), "theme filler is gone");
  assert.ok(contents.some((c) => c.includes("pnpm")), "real knowledge survives");
});
