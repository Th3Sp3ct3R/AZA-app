// Large-context plumbing — advertised windows stay accurate while the default
// working set remains cost-safe. Owners can still opt into a larger budget.
import test from "node:test";
import assert from "node:assert/strict";
import { modelContextWindow, chatContextBudget } from "../packages/cli/dist/entry/sessionFactory.js";

test("1M windows: opus 4.8, deepseek v4, glm 5.1", () => {
  assert.equal(modelContextWindow("claude-opus-4-8"), 1_000_000);
  assert.equal(modelContextWindow("deepseek/deepseek-v4-pro"), 1_000_000);
  assert.equal(modelContextWindow("glm-5.1"), 1_000_000);
});

test("non-1M families keep their real windows", () => {
  assert.equal(modelContextWindow("claude-fable-5"), 200_000);
  assert.equal(modelContextWindow("claude-sonnet-4-6"), 200_000);
  assert.equal(modelContextWindow("claude-haiku-4-5-20251001"), 200_000);
  assert.equal(modelContextWindow("glm-5"), 200_000);
  assert.equal(modelContextWindow("deepseek-v3.1"), 160_000);
});

test("budget: giant windows use a cost-safe 192k working set unless explicitly raised", () => {
  const prevBudget = process.env.ARES_CONTEXT_BUDGET;
  const prevCap = process.env.ARES_CONTEXT_BUDGET_CAP;
  delete process.env.ARES_CONTEXT_BUDGET;
  delete process.env.ARES_CONTEXT_BUDGET_CAP;
  try {
    assert.equal(chatContextBudget({ model: "claude-opus-4-8" }), 192_000);
    assert.equal(chatContextBudget({ model: "claude-fable-5" }), 150_000, "200k models unchanged");
    process.env.ARES_CONTEXT_BUDGET_CAP = "100000";
    assert.equal(chatContextBudget({ model: "claude-opus-4-8" }), 100_000, "cap env still wins");
  } finally {
    if (prevBudget === undefined) delete process.env.ARES_CONTEXT_BUDGET; else process.env.ARES_CONTEXT_BUDGET = prevBudget;
    if (prevCap === undefined) delete process.env.ARES_CONTEXT_BUDGET_CAP; else process.env.ARES_CONTEXT_BUDGET_CAP = prevCap;
  }
});
