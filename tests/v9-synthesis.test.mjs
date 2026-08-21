// Verifies M1 dreaming synthesis — the real "what should I believe now" pass:
//   1. synthesize() crystallizes recurring episodes into an `insight:` node and
//      recurring failures into a `belief:` node, fully offline (no LLM phraser).
//   2. Synthesis nodes carry confidence + derivedFrom provenance + links to members.
//   3. It is idempotent by tag: re-running updates (never duplicates) the nodes.
//   4. consolidate() never prunes synthesis nodes.

import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStore } from "../packages/mind/dist/index.js";

// Distinguished only by leading stopwords (this/that/with) so the SALIENT token
// sets are identical → deterministic clustering, but the content differs so the
// dedup pass never merges them.
const INSIGHT_EPISODES = [
  "this shopify checkout flow redesign",
  "that shopify checkout flow redesign",
  "with shopify checkout flow redesign",
];
// Three, not two: recurring-failure beliefs now require minMembers = 3 — at 2,
// the pass amplified stored error noise into "recurring failure" beliefs
// (field report 2026-08-06).
const FAILURE_EPISODES = [
  "this kubernetes deploy rollback failed",
  "that kubernetes deploy rollback failed",
  "with kubernetes deploy rollback failed",
];

async function seed() {
  const store = MemoryStore.memory();
  for (const content of INSIGHT_EPISODES) await store.add({ kind: "episodic", content });
  for (const content of FAILURE_EPISODES) await store.add({ kind: "episodic", content });
  return store;
}

test("synthesis: crystallizes one insight + one belief offline, with provenance", async () => {
  const store = await seed();
  const report = await store.synthesize();

  // The kubernetes trio crosses BOTH thresholds now that failures need 3
  // members: it recurs as a pattern (insight) and as a failure (belief).
  assert.equal(report.insights, 2, "recurring-pattern insights from the shopify AND kubernetes trios");
  assert.equal(report.beliefs, 1, "one recurring-failure belief from the 3 kubernetes episodes");

  const insight = store.all().find((n) => n.tags?.some((t) => t.startsWith("insight:")));
  const belief = store.all().find((n) => n.tags?.some((t) => t.startsWith("belief:")));
  assert.ok(insight, "an insight node was written");
  assert.ok(belief, "a belief node was written");

  assert.equal(insight.kind, "semantic");
  assert.equal(insight.source, "synthesis");
  assert.ok(insight.confidence > 0, "insight carries a confidence");
  assert.equal(insight.derivedFrom.length, 3, "insight cites its 3 source episodes");
  assert.equal(insight.links.length, 3, "insight is linked to its 3 members");
  // Offline path uses the deterministic template, not an LLM.
  assert.match(insight.content, /^Recurring pattern across 3 episodes/);

  assert.equal(belief.derivedFrom.length, 3, "belief cites its 3 source failures");
  assert.match(belief.content, /^Recurring failure mode/);
});

test("synthesis: idempotent by tag — re-running updates, never duplicates", async () => {
  const store = await seed();
  await store.synthesize();
  const before = store.all().filter((n) => n.source === "synthesis").length;

  const second = await store.synthesize();
  const after = store.all().filter((n) => n.source === "synthesis").length;

  assert.equal(second.insights, 0, "no new insight on the second pass");
  assert.equal(second.beliefs, 0, "no new belief on the second pass");
  assert.equal(second.updated, 3, "all existing synthesis nodes were updated");
  assert.equal(after, before, "synthesis node count is unchanged (no duplicates)");
});

test("synthesis: consolidate() never prunes crystallized nodes", async () => {
  const store = await seed();
  await store.synthesize();
  const synthIds = store.all().filter((n) => n.source === "synthesis").map((n) => n.id);
  assert.ok(synthIds.length >= 2);

  await store.consolidate();

  for (const id of synthIds) {
    assert.ok(store.get(id), `synthesis node ${id} survived consolidation`);
  }
});
