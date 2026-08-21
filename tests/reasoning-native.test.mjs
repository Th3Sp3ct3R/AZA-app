import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  REASONING_LEVELS,
  anthropicReasoningEffort,
  deepSeekReasoningEffort,
  openAIReasoningEffort,
  thinkingBudgetTokens,
} from "../packages/protocol/dist/index.js";

test("provider-neutral effort ladder includes every real wire tier", () => {
  assert.deepEqual([...REASONING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("OpenAI effort maps none through xhigh without collapsing max to high", () => {
  assert.equal(openAIReasoningEffort("off"), "none");
  assert.equal(openAIReasoningEffort("minimal"), "minimal");
  assert.equal(openAIReasoningEffort("high"), "high");
  assert.equal(openAIReasoningEffort("xhigh"), "xhigh");
  assert.equal(openAIReasoningEffort("max"), "xhigh");
});

test("Claude effort preserves supported xhigh/max and clamps xhigh on 4.6", () => {
  assert.equal(anthropicReasoningEffort("xhigh", "claude-fable-5"), "xhigh");
  assert.equal(anthropicReasoningEffort("max", "claude-sonnet-4-6"), "max");
  assert.equal(anthropicReasoningEffort("xhigh", "claude-sonnet-4-6"), "high");
});

test("DeepSeek exposes its honest high/max pair", () => {
  assert.equal(deepSeekReasoningEffort("low"), "high");
  assert.equal(deepSeekReasoningEffort("high"), "high");
  assert.equal(deepSeekReasoningEffort("xhigh"), "max");
  assert.equal(deepSeekReasoningEffort("max"), "max");
});

test("manual-budget backends scale monotonically through max", () => {
  const budgets = REASONING_LEVELS.map(thinkingBudgetTokens);
  assert.deepEqual(budgets, [...budgets].sort((a, b) => a - b));
  assert.equal(budgets.at(-1), 65_536);
});

test("desktop effort control is interactive and model-native label is gone", async () => {
  const app = await readFile(new URL("../tauri/src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../tauri/src/styles.css", import.meta.url), "utf8");
  assert.match(app, /setReasoningOpen\(true\)/);
  assert.match(app, /<EffortPopover/);
  assert.match(app, /invoke\("ares_set_reasoning", \{ level \}\)/);
  assert.match(app, /className="voiceAperture"/);
  assert.match(styles, /@keyframes ownerTurnIn/);
  assert.match(styles, /\.effortChoices/);
  assert.doesNotMatch(app, />model-native</);
});
