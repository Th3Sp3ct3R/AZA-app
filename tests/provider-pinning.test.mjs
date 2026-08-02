import test from "node:test";
import assert from "node:assert/strict";

import {
  preflightProviderSelection,
  providerFamilyForSelection,
} from "../packages/cli/dist/entry/providers.js";
import { pickHealthyFallback } from "../packages/cli/dist/entry/sessionFactory.js";

const adapter = (name = "anthropic") => ({
  name,
  async *stream() {},
});

test("canonical family wins over a shared wire adapter", () => {
  assert.equal(providerFamilyForSelection({
    provider: adapter("anthropic"),
    model: "ares-internal",
    source: "explicit:ares",
    family: "ares",
  }), "ares");
  assert.equal(providerFamilyForSelection({
    provider: adapter("anthropic"),
    model: "deepseek-v4-pro",
    source: "explicit:deepseek",
    family: "deepseek",
  }), "deepseek");
});

test("legacy Ares selections still resolve as Ares instead of Anthropic", () => {
  assert.equal(providerFamilyForSelection({
    provider: adapter("anthropic"),
    model: "ares-internal",
    source: "explicit:ares",
  }), "ares");
});

test("manual provider pins do not cross-provider fail over", async () => {
  const current = {
    provider: adapter("anthropic"),
    model: "deepseek-v4-pro",
    source: "explicit:deepseek",
    family: "deepseek",
  };
  assert.equal(await pickHealthyFallback(current), null);
});

test("provider preflight rejects before a selection can be committed", async () => {
  const requested = {
    provider: adapter("ollama-cloud:reasoner"),
    model: "missing:cloud",
    source: "explicit:ollama",
    family: "ollama",
    preflight: async () => ({ ok: false, error: "model is not available" }),
  };
  await assert.rejects(() => preflightProviderSelection(requested), /not available/);
});

test("provider preflight accepts a validated selection", async () => {
  const requested = {
    provider: adapter("ollama-cloud:reasoner"),
    model: "installed:latest",
    source: "explicit:ollama",
    family: "ollama",
    preflight: async () => ({ ok: true }),
  };
  await assert.doesNotReject(() => preflightProviderSelection(requested));
});
