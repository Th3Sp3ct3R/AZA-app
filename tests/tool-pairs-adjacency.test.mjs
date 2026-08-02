// sanitizeToolPairs must enforce ADJACENCY, not mere existence. Anthropic 400s
// on a tool_use whose tool_result isn't in the immediately-following message —
// "tool_use ids were found without tool_result blocks immediately after" — and
// once persisted it bricks the session (every resend 400s identically). This
// reproduces the split-pair the existence-only check let through.

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolPairs } from "../packages/core/dist/providers/_toolPairs.js";

const msg = (role, content) => ({ id: `${role}${Math.random()}`, role, content, createdAt: "now" });

function hasBlock(messages, pred) {
  return messages.some((m) => m.content.some(pred));
}

test("split pair: user text between a tool_use and its result → tool_use converted to text", () => {
  // The exact shape: assistant tool_use, then the user TYPED a message (landing
  // between the call and its result), then the result. Result exists — but not
  // adjacent — so the old existence check kept the tool_use and Anthropic 400'd.
  const history = [
    msg("user", [{ type: "text", text: "do the thing" }]),
    msg("assistant", [{ type: "tool_use", id: "call_00_fZ5", name: "Read", input: {} }]),
    msg("user", [{ type: "text", text: "wait actually stop" }]),
    msg("user", [{ type: "tool_result", tool_use_id: "call_00_fZ5", content: "file contents" }]),
  ];
  const out = sanitizeToolPairs(history);
  assert.ok(!hasBlock(out, (b) => b.type === "tool_use"), "the non-adjacent tool_use must be converted");
  assert.ok(!hasBlock(out, (b) => b.type === "tool_result"), "its now-orphaned result must be converted too");
  assert.ok(hasBlock(out, (b) => b.type === "text" && /Read tool call/.test(b.text)), "tool_use kept as context text");
});

test("valid adjacent pair is preserved untouched", () => {
  const history = [
    msg("assistant", [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }]),
    msg("user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]),
  ];
  const out = sanitizeToolPairs(history);
  assert.ok(hasBlock(out, (b) => b.type === "tool_use" && b.id === "toolu_1"), "adjacent tool_use kept");
  assert.ok(hasBlock(out, (b) => b.type === "tool_result" && b.tool_use_id === "toolu_1"), "adjacent tool_result kept");
});

test("partial answer: two calls, one answered → only the unanswered is converted", () => {
  const history = [
    msg("assistant", [
      { type: "tool_use", id: "toolu_A", name: "Read", input: {} },
      { type: "tool_use", id: "toolu_B", name: "Grep", input: {} },
    ]),
    msg("user", [{ type: "tool_result", tool_use_id: "toolu_A", content: "ok" }]),
  ];
  const out = sanitizeToolPairs(history);
  assert.ok(hasBlock(out, (b) => b.type === "tool_use" && b.id === "toolu_A"), "answered call kept");
  assert.ok(!hasBlock(out, (b) => b.type === "tool_use" && b.id === "toolu_B"), "unanswered call converted");
  assert.ok(hasBlock(out, (b) => b.type === "text" && /Grep tool call/.test(b.text)), "unanswered call kept as text");
});

test("fully orphaned result (provider switch) still handled", () => {
  const history = [
    msg("user", [{ type: "tool_result", tool_use_id: "toolu_GONE", content: "stale" }]),
    msg("assistant", [{ type: "text", text: "continuing" }]),
  ];
  const out = sanitizeToolPairs(history);
  assert.ok(!hasBlock(out, (b) => b.type === "tool_result"), "orphaned result converted");
  assert.ok(hasBlock(out, (b) => b.type === "text" && /earlier tool result/.test(b.text)), "kept as context");
});
