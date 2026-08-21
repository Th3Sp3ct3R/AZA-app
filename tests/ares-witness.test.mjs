// V5 — the Witness. An LLM (stubbed here) reviews a finished turn and proposes
// candidate hypotheses; the deterministic intake validates, dedupes, caps, and
// writes them into living memory with status "candidate".

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runWitness, vetCandidate } from "../packages/agent/dist/index.js";
import { MemoryStore } from "../packages/mind/dist/index.js";

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-witness-"));
  const store = await MemoryStore.open(path.join(dir, "memory.jsonl"));
  return { dir, store };
}

const askWith = (reply) => async () => reply;

test("witness: a correction-bearing turn yields a feedback candidate with status candidate", async () => {
  const { dir, store } = await makeStore();
  const report = await runWitness({
    conversation: {
      user: "no — stop mocking the database in tests, we got burned by that last quarter",
      assistant: "Understood. I rewrote the tests against the real database fixture.",
      status: "completed",
    },
    store,
    ask: askWith([
      {
        kind: "feedback",
        claim: "Tests must hit the real database, never mocks — a mock/prod divergence once masked a broken migration",
        why: "explicit user correction with a reason",
      },
    ]),
  });
  assert.equal(report.proposed, 1);
  assert.equal(report.accepted.length, 1);
  const node = store.get(report.accepted[0].id);
  assert.equal(node.status, "candidate");
  assert.equal(node.kind, "semantic");
  assert.ok(node.tags.includes("crucible:feedback"));
  await rm(dir, { recursive: true, force: true });
});

test("witness: an empty model reply writes nothing", async () => {
  const { dir, store } = await makeStore();
  const report = await runWitness({
    conversation: { user: "thanks lol", assistant: "anytime", status: "completed" },
    store,
    ask: askWith([]),
  });
  assert.equal(report.proposed, 0);
  assert.equal(report.accepted.length, 0);
  assert.equal(store.all().length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("witness: a procedure candidate carries its falsifiable check", async () => {
  const { dir, store } = await makeStore();
  const report = await runWitness({
    conversation: {
      user: "get the desktop build working",
      assistant: "Done — the trick was building the runtime first: pnpm build:runtime, then tauri build.",
      status: "completed",
    },
    store,
    ask: askWith([
      {
        kind: "procedure",
        claim: "Desktop builds require pnpm build:runtime before tauri build, in that order",
        check: { type: "file_exists", path: "tauri/src-tauri/tauri.conf.json" },
      },
    ]),
  });
  assert.equal(report.accepted.length, 1);
  const node = store.get(report.accepted[0].id);
  assert.equal(node.kind, "procedural");
  assert.deepEqual(node.check, { type: "file_exists", path: "tauri/src-tauri/tauri.conf.json" });
  await rm(dir, { recursive: true, force: true });
});

test("witness: duplicates of existing memories are rejected, not re-added", async () => {
  const { dir, store } = await makeStore();
  await store.add({ kind: "semantic", content: "The build uses pnpm workspaces" });
  const report = await runWitness({
    conversation: { user: "how do we build?", assistant: "pnpm build", status: "completed" },
    store,
    ask: askWith([{ kind: "belief", claim: "the build   uses PNPM workspaces" }]),
  });
  assert.equal(report.accepted.length, 0);
  assert.match(report.rejected[0], /duplicate/);
  assert.equal(store.all().length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("witness: unsafe check commands and malformed proposals are rejected", async () => {
  const { dir, store } = await makeStore();
  const report = await runWitness({
    conversation: { user: "clean things up for me", assistant: "done", status: "completed" },
    store,
    ask: askWith([
      { kind: "belief", claim: "Cleanup leaves the dist directory empty afterwards", check: { type: "command", cmd: "rm -rf dist" } },
      { kind: "sorcery", claim: "I can read minds and the user knows it now" },
      "not even an object",
      { kind: "belief", claim: "short" },
    ]),
  });
  assert.equal(report.accepted.length, 0);
  assert.equal(report.rejected.length, 4);
  assert.match(report.rejected[0], /unsafe/);
  assert.match(report.rejected[1], /unknown kind/);
  await rm(dir, { recursive: true, force: true });
});

test("witness: the candidate cap holds even when the model overshoots", async () => {
  const { dir, store } = await makeStore();
  // Genuinely distinct claims: the witness channel now similarity-dedupes
  // rewordings, so near-identical fixtures would collapse to one and mask the
  // cap this test exists to prove.
  const flood = [
    "The build system uses pnpm workspaces with one tsc project graph",
    "Session rollouts persist under .ares/sessions as JSONL event files",
    "The desktop app talks to the daemon over NDJSON on stdin",
    "Voice features provision themselves through a python sidecar venv",
    "Telegram bridging runs through the gateway mirror wiring",
    "The updater verifies release signatures with the tauri key",
    "HELM polls cognitive state on a five second cadence",
    "Provider failover tracks dead providers per session lane",
    "Memory consolidation runs under a cross-process lock file",
  ].map((claim) => ({ kind: "belief", claim }));
  const report = await runWitness({
    conversation: { user: "audit everything", assistant: "done, found a lot", status: "completed" },
    store,
    ask: askWith(flood),
    maxCandidates: 3,
  });
  assert.equal(report.accepted.length, 3);
  assert.ok(report.rejected.some((r) => /cap/.test(r)));
  await rm(dir, { recursive: true, force: true });
});

test("vetCandidate: a non-array model reply is survivable at the runWitness level", async () => {
  const { dir, store } = await makeStore();
  const report = await runWitness({
    conversation: { user: "hello there world", assistant: "hi", status: "completed" },
    store,
    ask: askWith({ not: "an array" }),
  });
  assert.equal(report.accepted.length, 0);
  assert.match(report.rejected[0], /not a JSON array/);
  assert.equal(typeof vetCandidate(null, new Set()), "string");
  await rm(dir, { recursive: true, force: true });
});
