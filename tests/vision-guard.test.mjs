// Vision guard — never ship a pasted image to a blind model (bug sess_e4c6022d:
// deepseek-v4-pro received a screenshot and replied "Can't view the image
// format directly"). modelLikelyHasVision is the per-model capability floor the
// daemon's escalation and the terminal guard both stand on.

import test from "node:test";
import assert from "node:assert/strict";
import { modelLikelyHasVision, chatContextBudget } from "../packages/cli/dist/entry/sessionFactory.js";

test("vision: text-only reasoners are blind", () => {
  for (const id of [
    "deepseek-v4-pro",
    "deepseek-v4-pro:cloud",
    "deepseek-v4-flash",
    "deepseek-v3.1:671b-cloud",
    "gpt-oss:120b-cloud",
    "glm-5.1",
    "kimi-k2",
    "qwen3-coder:480b-cloud",
  ]) {
    assert.equal(modelLikelyHasVision(id), false, `${id} must be treated as blind`);
  }
});

test("vision: frontier multimodal models see", () => {
  for (const id of [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "gpt-4o-mini",
    "openai/gpt-4o-mini",
    "gpt-5",
    "gemini-2.0-flash",
    "models/gemini-2.0-flash",
    "gemma3:27b-cloud",
    "qwen3-vl:235b-cloud",
  ]) {
    assert.equal(modelLikelyHasVision(id), true, `${id} must be treated as vision-capable`);
  }
});

test("vision: unknown ids default to blind (conservative)", () => {
  assert.equal(modelLikelyHasVision("mystery-model-9000"), false);
  assert.equal(modelLikelyHasVision(""), false);
});

test("budget: ollama-served models are clamped to the practical serving ceiling", () => {
  // deepseek-v4 markets a 1M window but ollama-cloud rejects/stalls far below it
  // (bug 4a8ac088: hard reject at ~335k, then 90s stalls). Compaction must fire
  // long before the provider chokes.
  const viaOllama = chatContextBudget({ provider: { name: "ollama" }, model: "deepseek-v4-pro:cloud" });
  assert.ok(viaOllama <= 160_000, `ollama-served budget must be ≤160k, got ${viaOllama}`);
  const direct = chatContextBudget({ provider: { name: "anthropic" }, model: "claude-opus-4-8" });
  assert.ok(direct > 160_000, `non-ollama providers keep the full budget, got ${direct}`);
});
