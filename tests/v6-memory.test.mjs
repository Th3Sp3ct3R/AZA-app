// Verifies M1 — Living Memory (the brain-like memory):
//   1. remember() recalls relevant memories AND reinforces them (recalling makes
//      them stick — activations + strength rise).
//   2. Fading: an old, unused memory has lower effective strength than a fresh one.
//   3. Spreading activation: recalling a cue that matches A also surfaces a LINKED
//      memory B — even though the cue never matched B's text.
//   4. Consolidation: forgets faded one-off episodes; crystallizes a recurring
//      theme into a new semantic memory linked to its episodes.
//   5. Pluggable home: a file-backed store persists and reopens (the flashdrive).

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore, currentStrength, reinforce } from "../packages/mind/dist/index.js";

async function makeDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-mem-"));
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// ── 1. recall reinforces ─────────────────────────────────────────────────────

test("memory: remember surfaces relevant memories and strengthens them", async () => {
  const store = MemoryStore.memory();
  await store.add({ kind: "semantic", content: "The user prefers TypeScript for the Ares harness" });
  await store.add({ kind: "episodic", content: "Cooked pasta for dinner" });

  const results = await store.remember("what language does the user prefer for ares");
  assert.ok(results.length >= 1);
  assert.match(results[0].node.content, /TypeScript/);
  assert.equal(results[0].node.activations, 1, "recalling reinforced it (activation recorded)");
  assert.ok(results[0].node.strength > 1, "strength grew from being recalled");
});

// ── 2. fading ────────────────────────────────────────────────────────────────

test("memory: an old unused memory fades below a fresh one", () => {
  const now = new Date();
  const fresh = { id: "a", kind: "episodic", content: "x", at: now.toISOString(), strength: 1, activations: 0, lastActivatedAt: now.toISOString(), links: [] };
  const old = { id: "b", kind: "episodic", content: "y", at: daysAgo(60).toISOString(), strength: 1, activations: 0, lastActivatedAt: daysAgo(60).toISOString(), links: [] };
  assert.ok(currentStrength(old, now) < currentStrength(fresh, now));
  assert.ok(currentStrength(old, now) < 0.05, "a 60-day-untouched memory has nearly faded");
  // using it brings it back
  const revived = reinforce(old, now);
  assert.ok(currentStrength(revived, now) > currentStrength(old, now));
});

// ── 3. spreading activation ──────────────────────────────────────────────────

test("memory: recall spreads along associations to surface a linked memory", async () => {
  const store = MemoryStore.memory();
  const a = await store.add({ kind: "semantic", content: "Dropshipping store runs on Shopify" });
  const b = await store.add({ kind: "semantic", content: "Payments settle every Friday to the bank" });
  await store.link(a.id, b.id); // associated, but very different words

  const results = await store.remember("tell me about the shopify dropshipping setup");
  const ids = results.map((r) => r.node.id);
  assert.ok(ids.includes(a.id), "direct match surfaced");
  assert.ok(ids.includes(b.id), "the associated memory surfaced via spreading activation");
  assert.ok(results.find((r) => r.node.id === b.id)?.viaAssociation, "and it was flagged as an association hit");
});

// ── 4. consolidation ─────────────────────────────────────────────────────────

test("memory: consolidation forgets trivia; crystallization belongs to synthesize()", async () => {
  const store = MemoryStore.memory();
  // a faded one-off episode (old, never reinforced) → should be pruned
  await store.add({ kind: "episodic", content: "random idle chatter", at: daysAgo(90) });
  // recurring fresh episodes: consolidate() KEEPS them but no longer mints
  // single-token "Recurring theme" semantics from them — that mechanism
  // produced 47 filler nodes on one real store ("first", "every", "claude").
  // synthesize() crystallizes recurrence properly (IDF keys, provenance).
  await store.add({ kind: "episodic", content: "Researched shopify product trends" });
  await store.add({ kind: "episodic", content: "Posted a shopify listing" });
  await store.add({ kind: "episodic", content: "Checked shopify revenue dashboard" });

  const report = await store.consolidate();
  assert.ok(report.pruned >= 1, "the faded one-off episode was forgotten");
  assert.equal(report.promoted.length, 0, "consolidate no longer mints theme semantics");
  assert.equal(store.all().some((n) => n.tags?.some((t) => t.startsWith("theme:"))), false);
  // (Crystallization itself — recurring episodes → insight nodes with IDF
  // cluster keys and provenance — is covered by v9-synthesis.test.mjs.)
  assert.equal(store.all().filter((n) => n.kind === "episodic").length, 3, "the fresh episodes survive for synthesize()");
});

// ── 5. pluggable home (the flashdrive) ───────────────────────────────────────

test("memory: a file-backed store persists and reopens from its home", async () => {
  const home = await makeDir();
  const store1 = await MemoryStore.open(home);
  await store1.add({ kind: "semantic", content: "This drive is my home now" });

  const store2 = await MemoryStore.open(home); // reopen — like remounting the flashdrive
  assert.equal(store2.count(), 1, "memory persisted to the home and reloaded");
  const results = await store2.remember("where is home");
  assert.match(results[0].node.content, /home/);

  await fs.rm(home, { recursive: true, force: true });
});

test("memory: oversized entries are bounded on write and repaired on reopen", async () => {
  const home = await makeDir();
  const store = await MemoryStore.open(home);
  const node = await store.add({ kind: "episodic", content: "a".repeat(20_000) });
  assert.ok(node.content.length < 2_100, "new memories should not store giant raw blobs");

  const memoryFile = path.join(home, "memory.jsonl");
  await fs.writeFile(
    memoryFile,
    JSON.stringify({
      id: "manual_huge",
      kind: "episodic",
      content: "b".repeat(20_000),
      at: new Date().toISOString(),
      strength: 1,
      activations: 0,
      lastActivatedAt: new Date().toISOString(),
      links: [],
    }) + "\n",
    "utf8",
  );

  const reopened = await MemoryStore.open(home);
  const repaired = reopened.get("manual_huge");
  assert.ok(repaired, "manual memory should still load");
  assert.ok(repaired.content.length < 2_100, "reopened memories should be repaired before recall");
  assert.ok((await fs.readFile(memoryFile, "utf8")).length < 2_400, "repair should persist back to disk");

  await fs.rm(home, { recursive: true, force: true });
});

test("memory: reopen repairs orphan and self links", async () => {
  const home = await makeDir();
  const memoryFile = path.join(home, "memory.jsonl");
  const now = new Date().toISOString();
  await fs.writeFile(
    memoryFile,
    [
      JSON.stringify({
        id: "a",
        kind: "episodic",
        content: "linked memory",
        at: now,
        strength: 1,
        activations: 0,
        lastActivatedAt: now,
        links: ["a", "b", "missing", "b"],
      }),
      JSON.stringify({
        id: "b",
        kind: "semantic",
        content: "real neighbor",
        at: now,
        strength: 1,
        activations: 0,
        lastActivatedAt: now,
        links: ["a"],
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const reopened = await MemoryStore.open(home);
  assert.deepEqual(reopened.get("a").links, ["b"]);
  assert.ok(!(await fs.readFile(memoryFile, "utf8")).includes("missing"), "repair should persist to disk");

  await fs.rm(home, { recursive: true, force: true });
});

test("memory: consolidation merges exact duplicate memories and redirects links", async () => {
  const store = MemoryStore.memory();
  const keeper = await store.add({ kind: "episodic", content: "User prefers TypeScript", strength: 2 });
  const duplicate = await store.add({ kind: "episodic", content: "user prefers typescript", strength: 1 });
  const neighbor = await store.add({ kind: "semantic", content: "Ares is TypeScript-first" });
  await store.link(duplicate.id, neighbor.id);

  const report = await store.consolidate();
  assert.equal(report.deduped, 1);
  assert.equal(store.all().filter((n) => n.content.toLowerCase() === "user prefers typescript").length, 1);
  assert.equal(neighbor.links.includes(duplicate.id), false, "links should not point at removed duplicate ids");
  assert.equal(store.get(keeper.id).links.includes(neighbor.id), true, "keeper should inherit duplicate links");
});

test("memory: consolidation prunes ALL theme semantics and mints no new ones", async () => {
  const store = MemoryStore.memory();
  await store.add({ kind: "semantic", content: 'Recurring theme "lmao" observed across 5 episodes.', tags: ["theme:lmao"], strength: 1.5 });
  // Even a "meaningful"-looking theme is filler: a token plus a count is not
  // knowledge, and the stopword gate was unwinnable whack-a-mole in the field.
  await store.add({ kind: "semantic", content: 'Recurring theme "shopify" observed across 3 episodes.', tags: ["theme:shopify"], strength: 1.5 });
  await store.add({ kind: "episodic", content: "hey homie u working lmao?" });
  await store.add({ kind: "episodic", content: "Researched shopify product trends" });
  await store.add({ kind: "episodic", content: "Posted a shopify listing" });
  await store.add({ kind: "episodic", content: "Checked shopify revenue dashboard" });

  const report = await store.consolidate();
  assert.ok(report.pruned >= 2, "every legacy theme semantic is removed");
  assert.equal(store.all().some((n) => n.tags?.some((t) => t.startsWith("theme:"))), false, "no theme node survives or is minted");
  assert.equal(report.promoted.length, 0, "theme promotion is gone for good");
});
