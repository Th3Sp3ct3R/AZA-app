// The prompt split: persona / craft core / per-provider overlay / surfaces.
//
// The old prompt was one 33,819-char string with six sections restating the
// same doctrine. Cutting it is only safe if every load-bearing rule survives —
// these tests are the proof, and the guard against a future "tidy-up" quietly
// deleting a rule that exists because something once went wrong.

import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../packages/cli/dist/entry/turnPipeline.js";
import { renderPersona, providerOverlay, craftCore } from "../packages/cli/dist/entry/prompt/index.js";

const prompt = (opts) => buildSystemPrompt("workspace-write", undefined, opts);

// ── every load-bearing rule survives the cut ─────────────────────────────────

const MUST_SURVIVE = [
  // proof + honesty
  [/never a bare "done/i, "the done-without-proof contract"],
  [/Reading the code is NOT verification/i, "reading != verifying"],
  [/Compiling is not working/i, "build-green != feature-works"],
  [/symptom the owner actually reported/i, "verify the real symptom, not a proxy"],
  [/most expensive lie/i, "false success on long missions"],
  // edit discipline
  [/without line-number prefixes/i, "old_string copy rule"],
  [/fails SILENTLY when the pattern misses/i, "shell regex edit hazard"],
  [/new_string_from_file/i, "large-content insertion path"],
  [/that's how files get truncated/i, "never Write-rewrite after a failed Edit"],
  // codebase craft
  [/blast radius/i, "trace consumers before editing"],
  [/Fifty failures is almost never fifty problems/i, "triage doctrine"],
  [/house style is a defect/i, "match local pattern"],
  // quality bar
  [/"Works" is not the bar/i, "quality bar"],
  [/only your eyes prove the experience/i, "look at the UI you built"],
  [/never by sleeping and re-checking/i, "time-dependent verification"],
  // tools + hard rules
  [/TOOL RESULTS ARE NOT THE USER/i, "tool output is not the human"],
  [/DELIVER, DON'T DEFLECT/i, "deliver what was asked"],
  [/pixel space of the LAST image/i, "ComputerUse coordinate contract"],
  [/RequestUserAction/i, "human-wall handoff"],
  [/Defensive security only/i, "security posture"],
  [/Never commit unless/i, "git discipline"],
  // reach
  [/NEVER tell the owner you "can't see"/i, "no false incapacity"],
  [/OneDrive/i, "Windows desktop redirection"],
  // modes
  [/PLAN MODE/i, "plan-mode boundary"],
  [/file_path:line_number/i, "code reference format"],
];

test("every load-bearing rule survives the prompt split", () => {
  const p = prompt();
  const missing = MUST_SURVIVE.filter(([re]) => !re.test(p)).map(([, what]) => what);
  assert.deepEqual(missing, [], `these rules were lost in the cut: ${missing.join(" | ")}`);
});

test("the prompt is materially smaller than the pre-split monolith", () => {
  const p = prompt();
  // Budget raised 26k → 28.5k for the machine card (the agent-computer's
  // standing awareness block, ~0.4k unprovisioned / ~1.6k provisioned) — a
  // deliberate surface, not paraphrase creep. Still well under the old 33,819.
  assert.ok(p.length < 28_500, `expected well under the old 33,819 chars, got ${p.length}`);
  assert.ok(p.length > 12_000, `suspiciously small (${p.length}) — a section may have been dropped entirely`);
});

// ── persona is genuinely configurable ────────────────────────────────────────

test("persona styles change the voice without touching the craft core", () => {
  const ares = prompt();
  const neutral = prompt({ persona: { style: "neutral" } });
  assert.match(ares, /god of war/, "default persona is Ares");
  assert.doesNotMatch(neutral, /god of war/, "neutral persona drops the mythology");
  // Craft survives regardless of voice.
  for (const p of [ares, neutral]) {
    assert.match(p, /Reading the code is NOT verification/i);
    assert.match(p, /"Works" is not the bar/i);
  }
});

test("persona can be turned off entirely and the craft core still stands", () => {
  const off = prompt({ persona: { style: "custom", custom: "" } });
  assert.equal(renderPersona({ style: "custom", custom: "" }), "");
  assert.doesNotMatch(off, /god of war/);
  assert.match(off, /## How you work/, "craft core is independent of persona");
});

test("a custom persona is used verbatim", () => {
  const p = prompt({ persona: { style: "custom", custom: "You are Bolt, terse and fast." } });
  assert.match(p, /You are Bolt, terse and fast\./);
  assert.doesNotMatch(p, /god of war/);
});

// ── per-provider overlays target real failure modes ──────────────────────────

test("each family gets its own corrective overlay", () => {
  assert.match(providerOverlay("kimi", "k3"), /do not just describe/i);
  assert.match(providerOverlay("openai", "gpt-5.6-sol"), /smallest correct change/i);
  assert.match(providerOverlay("anthropic", "claude-opus-5"), /guess a URL/i);
  assert.match(providerOverlay("deepseek", "deepseek-v4-flash"), /Converge/i);
});

test("overlays resolve by MODEL id too, so aggregators route correctly", () => {
  // OpenRouter/gateway serve many families behind one provider name — routing
  // on the provider alone would hand a Kimi model the generic overlay.
  assert.match(providerOverlay("openrouter", "moonshotai/kimi-k3"), /do not just describe/i);
  assert.match(providerOverlay("ares", "claude-opus-5"), /guess a URL/i);
  assert.match(providerOverlay("custom", "deepseek-v4-pro"), /Converge/i);
});

test("an unknown provider adds no overlay rather than guessing", () => {
  assert.equal(providerOverlay("something-new", "mystery-1"), "");
  const p = prompt({ providerFamily: "something-new", model: "mystery-1" });
  assert.match(p, /## How you work/, "the core still composes without an overlay");
});

test("the overlay is a small delta, not a second doctrine", () => {
  const core = craftCore();
  for (const fam of ["kimi", "openai", "anthropic", "deepseek"]) {
    const overlay = providerOverlay(fam, "");
    assert.ok(overlay.length < core.length / 4, `${fam} overlay should stay a delta (${overlay.length} vs core ${core.length})`);
  }
});
