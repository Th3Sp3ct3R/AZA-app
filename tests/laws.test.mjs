// LAWS — the owner's standing orders, always-on and impossible to lose.
//
// The failure this layer kills (field, 2026-08-10): "I told it to stop
// verifying with github at every instance, it said OK, wrote it into memory,
// and I had to remind it 4 more times." The built-in doctrine was always-on;
// the owner's countermand was a budgeted, similarity-recalled memory. These
// tests pin the new contract: a law recorded THIS turn is present in the very
// next composed prompt, in force, and stated to outrank default doctrine.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addLaw, removeLaw, listLaws, lawsPromptBlock, MAX_LAWS } from "../packages/agent/dist/index.js";
import { composeSystemPrompt } from "../packages/cli/dist/entry/prompt/index.js";

const tmpHome = () => mkdtemp(path.join(os.tmpdir(), "ares-laws-"));

test("a law is in the prompt block immediately after being recorded", async () => {
  const home = await tmpHome();
  assert.equal(lawsPromptBlock(home), "", "no laws → no block");

  await addLaw("Never verify against GitHub unless the owner asks for it.", home);
  const block = lawsPromptBlock(home);
  assert.match(block, /Never verify against GitHub/);
  assert.match(block, /OVERRIDE any\s*\n?default habit or doctrine/i, "the block states its precedence");
  assert.match(block, /ALWAYS in force/i);
});

test("the block rides the composed system prompt, after the doctrine it outranks", async () => {
  const home = await tmpHome();
  await addLaw("Always answer the owner in Spanish.", home);
  const p = composeSystemPrompt({
    laws: lawsPromptBlock(home),
    surfaces: { tools: "TOOLS", workflows: "WORKFLOWS", environment: "ENV" },
  });
  const lawAt = p.indexOf("Always answer the owner in Spanish");
  const doctrineAt = p.indexOf("Proof");
  assert.ok(lawAt > 0, "law present in the composed prompt");
  assert.ok(doctrineAt >= 0 && lawAt > doctrineAt, "laws come after the craft doctrine");
  assert.ok(p.indexOf("TOOLS") > lawAt, "and before the tool surfaces");
});

test("a law added between two composes appears in the second — no restart, no recall", async () => {
  const home = await tmpHome();
  await addLaw("First law.", home);
  const first = lawsPromptBlock(home);
  assert.match(first, /First law/);
  assert.doesNotMatch(first, /Second law/);
  // fs mtime has coarse resolution on some filesystems; make the write land
  // in a distinct tick so the cache check is honestly exercised.
  await new Promise((r) => setTimeout(r, 20));
  await addLaw("Second law.", home);
  const second = lawsPromptBlock(home);
  assert.match(second, /First law/);
  assert.match(second, /Second law/);
});

test("re-adding an existing law refreshes it instead of duplicating", async () => {
  const home = await tmpHome();
  await addLaw("Never push without asking first.", home);
  await addLaw("never push without asking first", home); // case/punct variant
  const laws = await listLaws(home);
  assert.equal(laws.length, 1, "one law, not two");
});

test("the cap fails loudly and never silently drops an order", async () => {
  const home = await tmpHome();
  for (let i = 0; i < MAX_LAWS; i++) await addLaw(`Standing order number ${i} about topic ${i}.`, home);
  await assert.rejects(() => addLaw("One law too many.", home), /cap/i);
  const laws = await listLaws(home);
  assert.equal(laws.length, MAX_LAWS, "nothing was evicted");
});

test("removal works and the file stays owner-editable markdown", async () => {
  const home = await tmpHome();
  await addLaw("Keep this law.", home);
  await addLaw("Remove this law.", home);
  await removeLaw("remove this law", home);
  const laws = await listLaws(home);
  assert.deepEqual(laws.map((l) => l.text), ["Keep this law."]);
  const raw = await readFile(path.join(home, "LAWS.md"), "utf8");
  assert.match(raw, /^# Laws/m, "human-readable header survives rewrites");
});
