// Switching model / provider mid-session must NOT restart the conversation.
//
// Owner requirement: "when changing models or using routing make sure they keep
// same session context even if switched." Both paths (the explicit model_switch
// command and auto-routing's per-lane reassignment) reach the same place —
// Session.setProvider → QueryEngine.setProvider — which swaps the provider,
// model and context budget while leaving the message array alone. These tests
// pin that, so a future refactor of setProvider can't quietly wipe history.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Session } from "../packages/core/dist/index.js";

const now = () => new Date().toISOString();

/** Records the user-visible text of every message it is asked to answer. */
function recordingProvider(name) {
  return {
    name,
    seen: [], // one entry per request: the texts it received
    async *stream(req) {
      this.seen.push(
        req.messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)),
      );
      yield {
        type: "message_done",
        message: { id: `m_${this.seen.length}`, role: "assistant", content: [{ type: "text", text: `${name} replying` }], createdAt: now() },
        usage: { inputTokens: 5, outputTokens: 2 },
        stopReason: "end_turn",
      };
    },
  };
}

function freshSession(provider, model) {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-switch-"));
  return new Session({ workspace: ws, provider, model, systemPrompt: "s", tools: [], contextBudgetTokens: 0 });
}

async function drain(stream) {
  const events = [];
  for await (const e of stream) events.push(e);
  return events;
}

test("model switch: the new model receives the whole prior conversation", async () => {
  const first = recordingProvider("first");
  const second = recordingProvider("second");
  const session = freshSession(first, "model-a");

  await drain(session.send("remember the passphrase is thermopylae"));
  assert.equal(first.seen.length, 1);

  // The switch itself must not touch history.
  await session.setProvider(second, "model-b");

  await drain(session.send("what was the passphrase?"));

  assert.equal(second.seen.length, 1, "the new provider handled the next turn");
  const carried = second.seen[0].join("\n");
  assert.match(carried, /thermopylae/, "the earlier USER turn came along");
  assert.match(carried, /first replying/, "and so did the earlier ASSISTANT turn");
  assert.match(carried, /what was the passphrase/, "plus the new message");
  // and the old provider was not asked again
  assert.equal(first.seen.length, 1);
});

test("model switch: session meta follows the new model, history length keeps growing", async () => {
  const a = recordingProvider("a");
  const b = recordingProvider("b");
  const session = freshSession(a, "model-a");

  await drain(session.send("one"));
  await session.setProvider(b, "model-b");
  await drain(session.send("two"));
  await drain(session.send("three"));

  assert.equal(session.meta.provider.model, "model-b", "meta reflects the switch");
  assert.equal(session.meta.provider.name, "b");
  // 3 user turns + 3 assistant replies visible to the final request (which sees
  // everything before its own turn: 2 prior exchanges + the new user message)
  const lastRequest = b.seen.at(-1).join("\n");
  for (const expected of ["one", "a replying", "two", "b replying", "three"]) {
    assert.match(lastRequest, new RegExp(expected), `history retained: ${expected}`);
  }
});

test("model switch: swapping back and forth never truncates the thread", async () => {
  // Auto-routing can bounce between lanes (chat → coding → chat) within one
  // session; each bounce is a setProvider call and none may drop context.
  const chat = recordingProvider("chat");
  const coding = recordingProvider("coding");
  const session = freshSession(chat, "chat-model");

  await drain(session.send("alpha"));
  await session.setProvider(coding, "coding-model");
  await drain(session.send("bravo"));
  await session.setProvider(chat, "chat-model");
  await drain(session.send("charlie"));

  const final = chat.seen.at(-1).join("\n");
  assert.match(final, /alpha/);
  assert.match(final, /bravo/);
  assert.match(final, /charlie/);
  assert.match(final, /coding replying/, "the other model's turn is part of the thread");
});
