// Task-adaptive reasoning router — proves the "stop thinking forever on trivial
// turns" behavior without burning the owner's control. Pure function, no engine.

import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveReasoningLevel } from "../packages/core/dist/index.js";

test("owner ceiling is never exceeded — a deep ask on 'high' stays 'high', not 'max'", () => {
  assert.equal(adaptiveReasoningLevel("high", "Please debug why the auth refresh loops forever and design a fix"), "high");
});

test("trivial greetings drop to 'off' regardless of ceiling", () => {
  assert.equal(adaptiveReasoningLevel("max", "hi"), "off");
  assert.equal(adaptiveReasoningLevel("high", "thanks!"), "off");
  assert.equal(adaptiveReasoningLevel("max", "ok cool"), "off");
});

test("short single-clause asks drop one rung (max -> xhigh)", () => {
  assert.equal(adaptiveReasoningLevel("max", "rename this variable to userId"), "xhigh");
});

test("deep-work verbs keep the full ceiling even when short", () => {
  assert.equal(adaptiveReasoningLevel("max", "debug this"), "max");
  assert.equal(adaptiveReasoningLevel("max", "why does this crash"), "max");
});

test("a long substantive ask keeps the ceiling", () => {
  const msg = "Refactor the session manager so that each chat card gets its own abort controller and the daemon never leaks a background heartbeat when a second card connects";
  assert.equal(adaptiveReasoningLevel("max", msg), "max");
});

test("owner opt-out (enabled=false) returns the base untouched", () => {
  assert.equal(adaptiveReasoningLevel("max", "hi", false), "max");
});

test("low/off/undefined bases pass through unchanged (nothing to downshift)", () => {
  assert.equal(adaptiveReasoningLevel("low", "hi"), "low");
  assert.equal(adaptiveReasoningLevel("off", "debug this deeply"), "off");
  assert.equal(adaptiveReasoningLevel(undefined, "hi"), undefined);
});
