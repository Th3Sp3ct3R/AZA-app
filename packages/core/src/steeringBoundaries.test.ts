import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, StreamEvent, TurnEvent } from "@ares/protocol";
import { QueryEngine, type ClaimedSteeringMessage, type Provider, type ProviderRequest } from "./queryEngine.js";

function message(id: string, role: Message["role"], text: string, source?: "steer"): Message {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
    ...(source ? { metadata: { source } } : {}),
  };
}

function finalProvider(requests: ProviderRequest[]): Provider {
  return {
    name: "steering-boundary-test",
    async *stream(request): AsyncGenerator<StreamEvent> {
      requests.push({
        ...request,
        messages: request.messages.map((item) => ({
          ...item,
          content: item.content.map((block) => ({ ...block })),
        })),
      });
      yield {
        type: "message_done",
        message: message(`assistant-${requests.length}`, "assistant", `answer ${requests.length}`),
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function nextWithin<T>(promise: Promise<T>, messageText: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(messageText)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("steering aborts heavy compaction and reaches the first provider request without a fallback rewrite", async () => {
  const requests: ProviderRequest[] = [];
  const steering: ClaimedSteeringMessage[] = [];
  const consumed: string[] = [];
  let announceSummarizer!: () => void;
  const summarizerStarted = new Promise<void>((resolve) => {
    announceSummarizer = resolve;
  });
  const engine = QueryEngine.forTesting({
    provider: finalProvider(requests),
    model: "fixed",
    systemPrompt: "test",
    tools: [],
    workspace: process.cwd(),
    contextBudgetTokens: 200_000,
    compactionThresholdTokens: 100,
    summarizeSpan: async () => {
      announceSummarizer();
      return await new Promise<string>(() => undefined);
    },
    claimSteeringMessages: async () => steering.splice(0),
    consumeSteeringInputs: async (inputIds) => {
      consumed.push(...inputIds);
    },
  }, "steering-compaction-boundary");

  const large = "context ".repeat(2_500);
  engine.hydrate([
    message("u1", "user", large),
    message("a1", "assistant", large),
    message("u2", "user", large),
    message("a2", "assistant", large),
    message("u3", "user", large),
    message("a3", "assistant", large),
    message("u4", "user", large),
    message("pending", "user", `current request ${large}`),
  ]);

  const stream = engine.streamTurn();
  const start = await stream.next();
  assert.equal(start.value?.type, "turn_start");
  const blockedAdvance = stream.next();
  await nextWithin(summarizerStarted, "heavy compaction did not start");

  steering.push({
    inputId: "steer-during-summary",
    message: message("steer-message", "user", "correction while compacting", "steer"),
  });
  assert.equal(engine.requestSteeringPreemption(), "boundary_pending");

  const firstAfterSteer = await nextWithin(blockedAdvance, "steer did not cancel heavy compaction promptly");
  const events: TurnEvent[] = firstAfterSteer.done ? [] : [firstAfterSteer.value];
  for await (const event of stream) events.push(event);

  assert.equal(requests.length, 1);
  assert.ok(
    requests[0]?.messages.some((item) => item.id === "steer-message"),
    "the correction must be present in the very first provider request",
  );
  assert.deepEqual(consumed, ["steer-during-summary"]);
  assert.equal(events.some((event) => event.type === "compaction"), false);
  assert.equal(
    engine.history().some((item) => item.id.startsWith("compact_")),
    false,
    "an aborted summary must not commit a ledger fallback or history rewrite",
  );
  engine.markTurnEnded();
});

test("a completion-boundary steer earns a replacement response even when maxTurns is one", async () => {
  const requests: ProviderRequest[] = [];
  const steering: ClaimedSteeringMessage[] = [];
  const consumed: string[] = [];
  const engine = QueryEngine.forTesting({
    provider: finalProvider(requests),
    model: "fixed",
    systemPrompt: "test",
    tools: [],
    workspace: process.cwd(),
    maxTurns: 1,
    contextBudgetTokens: 0,
    claimSteeringMessages: async () => steering.splice(0),
    consumeSteeringInputs: async (inputIds) => {
      consumed.push(...inputIds);
    },
  }, "steering-completion-boundary");
  engine.appendUserMessage("initial request");

  const stream = engine.streamTurn();
  const events: TurnEvent[] = [];
  for (;;) {
    const next = await stream.next();
    assert.equal(next.done, false, "turn ended before the first provider response committed");
    events.push(next.value);
    if (next.value.type === "message_done") break;
  }

  steering.push({
    inputId: "late-steer",
    message: message("late-steer-message", "user", "change the final answer", "steer"),
  });
  assert.equal(engine.requestSteeringPreemption(), "boundary_pending");

  let terminalSeen = false;
  for (;;) {
    const next = await stream.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === "turn_end") {
      terminalSeen = true;
      assert.equal(
        engine.requestSteeringPreemption(),
        "idle",
        "a terminal generation must not claim a late steer as pending on itself",
      );
    }
  }

  assert.equal(terminalSeen, true);
  assert.equal(requests.length, 2, "the correction gets its own replacement provider attempt");
  assert.equal(requests[0]?.messages.some((item) => item.id === "late-steer-message"), false);
  assert.equal(requests[1]?.messages.some((item) => item.id === "late-steer-message"), true);
  assert.deepEqual(consumed, ["late-steer"]);
  assert.equal(events.filter((event) => event.type === "message_done").length, 2);
  assert.equal(events.at(-1)?.type, "turn_end");
  assert.notEqual(
    events.find((event) => event.type === "error")?.error.code,
    "max_turns_exceeded",
  );
  engine.markTurnEnded();
});
