// V7 — Crucible trials. Promotion gates on PROOF: checks run as reality
// probes, records speak when no check exists, losers archive with the failure
// reason as a new memory, and confirmed beliefs can lose tenure.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemoryStore } from "../packages/mind/dist/index.js";
import { runCrucibleTrials, checkToSpec, recordOf } from "../packages/operator/dist/index.js";

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-crucible-"));
  const store = await MemoryStore.open(path.join(dir, "memory.jsonl"));
  return { dir, store };
}

const probeReturning = (byPath) => async (spec) => {
  const key = spec.kind === "file" ? spec.path : spec.cmd;
  const met = byPath[key] ?? false;
  return { met, summary: met ? `${key} ok` : `${key} red`, fingerprint: String(met) };
};

test("a candidate whose check passes (clean record) promotes to confirmed", async () => {
  const { dir, store } = await makeStore();
  const node = await store.add({
    kind: "semantic",
    content: "the tauri config lives at tauri.conf.json",
    status: "candidate",
    check: { type: "file_exists", path: "tauri.conf.json" },
  });
  await store.recordOutcome([node.id], { won: true, note: "used successfully" });

  const report = await runCrucibleTrials({ store, probe: probeReturning({ "tauri.conf.json": true }) });
  assert.equal(report.promoted, 1);
  assert.equal(store.get(node.id).status, "confirmed");
  assert.match(report.verdicts[0].reason, /trial passed/);
  await rm(dir, { recursive: true, force: true });
});

test("a candidate whose check fails archives WITH a post-mortem memory", async () => {
  const { dir, store } = await makeStore();
  const node = await store.add({
    kind: "semantic",
    content: "there is a Makefile at the repo root",
    status: "candidate",
    check: { type: "file_exists", path: "Makefile" },
  });

  const report = await runCrucibleTrials({ store, probe: probeReturning({ Makefile: false }) });
  assert.equal(report.archived, 1);
  assert.equal(store.get(node.id).status, "archived");

  const postMortem = store.all().find((n) => n.tags?.includes("post-mortem"));
  assert.ok(postMortem, "the failure reason was written back as a learning");
  assert.match(postMortem.content, /Archived hypothesis/);
  assert.match(postMortem.content, /failed its check/);
  assert.equal(postMortem.source, node.id);
  await rm(dir, { recursive: true, force: true });
});

test("without a check, the record decides: 2 wins promote, 3 losses archive, thin records hold", async () => {
  const { dir, store } = await makeStore();
  const winner = await store.add({ kind: "procedural", content: "retry flaky installs once before failing the build", status: "candidate" });
  const loser = await store.add({ kind: "semantic", content: "friday deploys are fine actually", status: "candidate" });
  const rookie = await store.add({ kind: "semantic", content: "the user prefers tabs probably", status: "candidate" });

  await store.recordOutcome([winner.id], { won: true, note: "w1" });
  await store.recordOutcome([winner.id], { won: true, note: "w2" });
  for (let i = 0; i < 3; i++) await store.recordOutcome([loser.id], { won: false, note: `l${i}` });

  const report = await runCrucibleTrials({ store, probe: probeReturning({}) });
  assert.equal(store.get(winner.id).status, "confirmed");
  assert.equal(store.get(loser.id).status, "archived");
  assert.equal(store.get(rookie.id).status, "candidate");
  assert.equal(report.held, 1);
  await rm(dir, { recursive: true, force: true });
});

test("confirmed knowledge whose check starts failing is demoted — beliefs lose tenure", async () => {
  const { dir, store } = await makeStore();
  const node = await store.add({
    kind: "semantic",
    content: "the legacy launcher exists",
    status: "confirmed",
    check: { type: "file_exists", path: "legacy-launcher.ps1" },
  });

  const report = await runCrucibleTrials({ store, probe: probeReturning({ "legacy-launcher.ps1": false }) });
  assert.equal(report.demoted, 1);
  const demoted = store.get(node.id);
  assert.equal(demoted.status, "candidate");
  assert.match(demoted.evidence.at(-1).note, /tenure revoked/);
  await rm(dir, { recursive: true, force: true });
});

test("a check passing over a NEGATIVE record holds instead of promoting", async () => {
  const { dir, store } = await makeStore();
  const node = await store.add({
    kind: "semantic",
    content: "the dev server starts in under a second",
    status: "candidate",
    check: { type: "command", cmd: "node --version" },
  });
  for (let i = 0; i < 2; i++) await store.recordOutcome([node.id], { won: false, note: `failed turn ${i}` });

  const report = await runCrucibleTrials({ store, probe: probeReturning({ node: true }) });
  assert.equal(report.held, 1);
  assert.equal(store.get(node.id).status, "candidate");
  assert.match(report.verdicts[0].reason, /record is negative/);
  await rm(dir, { recursive: true, force: true });
});

test("checkToSpec maps both kinds; recordOf counts evidence", () => {
  assert.deepEqual(checkToSpec({ type: "file_exists", path: "a/b.txt" }), { kind: "file", path: "a/b.txt" });
  const cmd = checkToSpec({ type: "command", cmd: "git status --short", expect: "M " });
  assert.equal(cmd.kind, "command");
  assert.equal(cmd.cmd, "git");
  assert.deepEqual(cmd.args, ["status", "--short"]);
  assert.equal(cmd.contains, "M ");
  assert.equal(checkToSpec({ type: "command" }), null);
  assert.deepEqual(
    recordOf({ evidence: [{ won: true }, { won: false }, { won: true }] }),
    { wins: 2, losses: 1 },
  );
});
