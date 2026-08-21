// V14 — smart compaction: when history crosses the threshold, the engine
// summarizes the OLD span via the host summarizer (model-written recap) and
// keeps recent turns whole, instead of bluntly trimming. Falls back to the
// deterministic ledger when no summarizer is wired or it fails.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { QueryEngine, Session, buildContextLedger, chooseCompactionSplit, loadSessionSnapshot, openWorkspaceSessionKernel } from "../packages/core/dist/index.js";

function bigMsg(role, tag, chars = 20_000) {
  return { id: `m_${tag}`, role, content: [{ type: "text", text: "x".repeat(chars) }], createdAt: new Date().toISOString() };
}

function okProvider(onReq) {
  return {
    name: "mock",
    async *stream(req) {
      onReq?.(req);
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

function mkSession(extra) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-v14-"));
  // 8 fat messages (~5k tokens each ≈ 40k tokens) — well over the threshold.
  const history = Array.from({ length: 8 }, (_, i) => bigMsg(i % 2 ? "assistant" : "user", `old_${i}`));
  return new Session({
    workspace,
    provider: okProvider(extra.onReq),
    model: "m",
    systemPrompt: "s",
    tools: [],
    initialMessages: history,
    compactionThresholdTokens: 3_000,
    ...extra.opts,
  });
}

// ─── chooseCompactionSplit ─────────────────────────────────────────────

test("chooseCompactionSplit keeps recent messages and summarizes the rest", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => bigMsg("user", `${i}`, 8_000)); // ~2k tokens each
  const split = chooseCompactionSplit(msgs, 4_000); // keep ~4k tokens of recent
  assert.ok(split > 0 && split < msgs.length, `split in range, got ${split}`);
  assert.ok(msgs.length - split >= 4, "keeps at least minKeep recent");
});

test("chooseCompactionSplit refuses to split a tiny history", () => {
  const msgs = Array.from({ length: 3 }, (_, i) => bigMsg("user", `${i}`));
  assert.equal(chooseCompactionSplit(msgs, 4_000), 0);
});

test("fallback ledger preserves the prior mission and the latest corrections/files", () => {
  const messages = [
    {
      id: "prior",
      role: "user",
      content: [{
        type: "system_reminder",
        text: "Compacted memory — established.\n\nGOAL: ship the FPS controller\nCONSTRAINTS: do not replace the input system\nSTATE: gun mount remains wrong\n\nThe files you were working in, re-read AFTER compaction:\nold bytes",
      }],
      createdAt: "now",
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `ask_${i}`,
      role: "user",
      content: [{ type: "text", text: `direction ${i}${i === 9 ? " — rotate the gun down, not right" : ""}` }],
      createdAt: "now",
    })),
    {
      id: "tools",
      role: "assistant",
      content: [
        { type: "tool_use", id: "early", name: "Read", input: { file_path: "old.cs" } },
        { type: "tool_use", id: "late", name: "Edit", input: { file_path: "GunMount.cs" } },
      ],
      createdAt: "now",
    },
  ];

  const ledger = buildContextLedger(messages);
  assert.match(ledger, /GOAL: ship the FPS controller/);
  assert.match(ledger, /CONSTRAINTS: do not replace the input system/);
  assert.doesNotMatch(ledger, /old bytes/, "stale file pins are not recursively retained");
  assert.doesNotMatch(ledger, /direction 0\b/, "early directions are displaced by newer corrections");
  assert.match(ledger, /direction 9 — rotate the gun down, not right/);
  assert.ok(ledger.indexOf("GunMount.cs") < ledger.indexOf("old.cs"), "recent files are listed first");
});

test("chooseCompactionSplit never opens the kept window on an orphan tool_result", () => {
  const msgs = [
    bigMsg("user", "u0", 8_000),
    { id: "tu", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }], createdAt: "now" },
    { id: "tr", role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "data" }], createdAt: "now" },
    bigMsg("assistant", "a1", 8_000),
    bigMsg("user", "u1", 8_000),
    bigMsg("assistant", "a2", 8_000),
  ];
  const split = chooseCompactionSplit(msgs, 5_000);
  if (split > 0) {
    assert.notEqual(msgs[split].content[0].type, "tool_result", "kept window must not lead with a tool_result");
  }
});

// ─── engine compaction via a real turn ─────────────────────────────────

test("compaction: summarizes the old span with the host summarizer and keeps recent", async () => {
  let summarizedSpan = null;
  const session = mkSession({
    opts: {
      summarizeSpan: async (messages) => {
        summarizedSpan = messages;
        return "GOAL: test\nDONE: built stuff\nSTATE: green\nOPEN: none\nFACTS: a.ts";
      },
    },
  });

  const events = [];
  for await (const e of session.send("continue")) events.push(e);

  const compaction = events.find((e) => e.type === "compaction");
  assert.ok(compaction, "a compaction event was emitted");
  assert.equal(compaction.method, "summary");
  assert.ok(compaction.summarizedMessages >= 2, "summarized the old span");
  assert.ok(compaction.tokensAfter < compaction.tokensBefore, "compaction shrank the context");
  assert.deepEqual(compaction.messages, session.engine.history().slice(0, compaction.messages.length), "event carries the exact compacted state");
  assert.ok(summarizedSpan && summarizedSpan.length >= 2, "summarizer received the old messages");

  const history = session.engine.history();
  const recap = history[0];
  assert.equal(recap.role, "user");
  assert.equal(recap.content[0].type, "system_reminder");
  assert.match(recap.content[0].text, /Compacted memory/);
  assert.match(recap.content[0].text, /built stuff/);
  // History shrank: the oldest summarized messages are folded into the recap;
  // recent ones (kept at full fidelity) and the new turn remain.
  const ids = history.map((m) => m.id);
  assert.ok(!ids.includes("m_old_0"), "the oldest message was folded into the recap");
  assert.ok(history.length < 8 + 2, "fewer messages than before compaction");
});

test("compaction: persisted replay restores the exact compacted transcript", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-v14-replay-"));
  const sessionId = "sess_compaction_replay";
  const session = new Session({
    workspace,
    sessionId,
    provider: okProvider(),
    model: "m",
    systemPrompt: "s",
    tools: [],
    initialMessages: Array.from({ length: 8 }, (_, i) => bigMsg(i % 2 ? "assistant" : "user", `replay_${i}`)),
    compactionThresholdTokens: 3_000,
    summarizeSpan: async () => "GOAL: replay\nDONE: compacted\nSTATE: exact\nOPEN: none",
  });

  for await (const _event of session.send("continue")) void _event;

  const snapshot = await loadSessionSnapshot(workspace, sessionId, { maxMessages: 1_000 });
  assert.deepEqual(snapshot.messages, session.engine.history());
});

test("compaction epoch persists the host's complete context source manifest", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-v14-source-manifest-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  let journalVersion = "journal-sha-before";
  try {
    const session = new Session({
      workspace,
      sessionId: "sess_context_source_manifest",
      provider: okProvider(),
      model: "m",
      systemPrompt: "s",
      tools: [],
      initialMessages: Array.from({ length: 8 }, (_, i) => bigMsg(i % 2 ? "assistant" : "user", `manifest_${i}`)),
      compactionThresholdTokens: 3_000,
      summarizeSpan: async () => "GOAL: manifest\nDONE: compacted\nSTATE: exact\nOPEN: none",
      contextSourceVersions: () => ({
        compiler: "test-context-v1",
        systemPromptSha256: "system-sha",
        toolCatalogSha256: "tools-sha",
        memorySha256: "memory-sha",
        codingJournalSha256: journalVersion,
      }),
      sessionKernel: kernel,
    });
    journalVersion = "journal-sha-at-compaction";
    for await (const _event of session.send("continue")) void _event;

    const epoch = kernel.getLatestContextEpoch(session.meta.id);
    assert.ok(epoch, "heavy compaction produced a durable epoch");
    assert.deepEqual(
      {
        compiler: epoch.sourceVersions.compiler,
        systemPromptSha256: epoch.sourceVersions.systemPromptSha256,
        toolCatalogSha256: epoch.sourceVersions.toolCatalogSha256,
        memorySha256: epoch.sourceVersions.memorySha256,
        codingJournalSha256: epoch.sourceVersions.codingJournalSha256,
      },
      {
        compiler: "test-context-v1",
        systemPromptSha256: "system-sha",
        toolCatalogSha256: "tools-sha",
        memorySha256: "memory-sha",
        codingJournalSha256: "journal-sha-at-compaction",
      },
    );
    assert.equal(epoch.sourceVersions.protocol, 1);
    assert.equal(epoch.sourceVersions.projection, "ares-message-v1");
  } finally {
    kernel.close();
  }
});

test("compaction: falls back to the deterministic ledger when the summarizer fails", async () => {
  const session = mkSession({
    opts: {
      summarizeSpan: async () => {
        throw new Error("summarizer down");
      },
    },
  });

  const events = [];
  for await (const e of session.send("continue")) events.push(e);

  const compaction = events.find((e) => e.type === "compaction");
  assert.ok(compaction, "compaction still happened");
  assert.equal(compaction.method, "ledger", "fell back to the ledger");
  const recap = session.engine.history()[0];
  assert.match(recap.content[0].text, /Context ledger/);
});

test("compaction: Stop aborts maintenance without rewriting history or calling the provider", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-v14-cancel-"));
  let summarizeStarted;
  const started = new Promise((resolve) => { summarizeStarted = resolve; });
  let providerCalls = 0;
  const engine = QueryEngine.forTesting({
    workspace,
    provider: okProvider(() => { providerCalls++; }),
    model: "m",
    systemPrompt: "s",
    tools: [],
    compactionThresholdTokens: 3_000,
    summarizeSpan: async (_messages, signal) => {
      summarizeStarted();
      await new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
      return "unreachable";
    },
  }, "sess_compaction_cancel");
  const original = Array.from({ length: 8 }, (_, i) => bigMsg(i % 2 ? "assistant" : "user", `cancel_${i}`));
  engine.hydrate(original);
  engine.appendUserMessage("continue");

  const events = [];
  const running = (async () => { for await (const event of engine.streamTurn()) events.push(event); })();
  await started;
  assert.equal(engine.interrupt(), true, "the active maintenance turn accepts Stop");
  await running;

  assert.equal(providerCalls, 0, "no obsolete provider request starts after cancellation");
  assert.equal(events.some((event) => event.type === "compaction"), false, "cancelled maintenance is not reported as completed");
  assert.equal(events.at(-1)?.type, "turn_end");
  assert.equal(events.at(-1)?.status, "interrupted");
  assert.equal(engine.history()[0].id, original[0].id, "the old span was not replaced by a fallback ledger");
});

test("compaction: a steer arriving during maintenance reaches the very next provider call", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-v14-steer-"));
  let summarizeStarted;
  let releaseSummary;
  const started = new Promise((resolve) => { summarizeStarted = resolve; });
  const gate = new Promise((resolve) => { releaseSummary = resolve; });
  let steerReady = false;
  let consumed = false;
  let request;
  const steerMessage = {
    id: "steer_during_compaction",
    role: "user",
    content: [{ type: "text", text: "STEER: rotate the gun down, never to the right" }],
    createdAt: "now",
  };
  const engine = QueryEngine.forTesting({
    workspace,
    provider: okProvider((req) => { request = req; }),
    model: "m",
    systemPrompt: "s",
    tools: [],
    compactionThresholdTokens: 3_000,
    summarizeSpan: async () => {
      summarizeStarted();
      await gate;
      return "GOAL: fix the gun mount\nSTATE: awaiting correction";
    },
    claimSteeringMessages: async () => steerReady && !consumed
      ? [{ inputId: "input_steer_during_compaction", message: steerMessage }]
      : [],
    consumeSteeringInputs: async (inputIds) => {
      assert.deepEqual(inputIds, ["input_steer_during_compaction"]);
      consumed = true;
    },
  }, "sess_compaction_steer");
  engine.hydrate(Array.from({ length: 8 }, (_, i) => bigMsg(i % 2 ? "assistant" : "user", `steer_${i}`)));
  engine.appendUserMessage("continue the build");

  const running = (async () => { for await (const _event of engine.streamTurn()) void _event; })();
  await started;
  steerReady = true;
  releaseSummary();
  await running;

  assert.equal(consumed, true, "the durable steer was acknowledged");
  assert.match(JSON.stringify(request.messages), /rotate the gun down, never to the right/);
});

test("compaction: does NOT fire below the threshold", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-v14-small-"));
  const session = new Session({
    workspace,
    provider: okProvider(),
    model: "m",
    systemPrompt: "s",
    tools: [],
    initialMessages: [bigMsg("user", "tiny", 100)],
    compactionThresholdTokens: 50_000, // way above this small history
    summarizeSpan: async () => "should not be called",
  });
  const events = [];
  for await (const e of session.send("continue")) events.push(e);
  assert.equal(events.find((e) => e.type === "compaction"), undefined, "no compaction under threshold");
});

test("compaction: rechecks inside one long tool loop before the next model call", async () => {
  let calls = 0;
  const requests = [];
  const provider = {
    name: "mock-loop",
    async *stream(req) {
      calls++;
      requests.push(req.messages);
      if (calls <= 3) {
        const id = `blob_${calls}`;
        yield { type: "tool_use_start", id, name: "Blob" };
        yield { type: "tool_use_input_done", id, input: {} };
        yield {
          type: "message_done",
          message: { id: `a_${calls}`, role: "assistant", content: [{ type: "tool_use", id, name: "Blob", input: {} }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "a_done", role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const blobTool = {
    schema: { name: "Blob", description: "large non-rederivable output", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "exclusive" },
    async call() { return { output: "z".repeat(20_000) }; },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-v14-loop-"));
  const engine = QueryEngine.forTesting({
    workspace,
    provider,
    model: "m",
    systemPrompt: "s",
    tools: [blobTool],
    maxTurns: 6,
    compactionThresholdTokens: 3_000,
    summarizeSpan: async () => "GOAL: finish loop\nCONSTRAINTS: retain tool facts\nDONE: gathered blobs\nSTATE: continuing\nOPEN: finish",
  }, "sess_compaction_loop");

  engine.appendUserMessage("gather until done");
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  const compactAt = events.findIndex((event) => event.type === "compaction");
  assert.ok(compactAt >= 0, "heavy compaction fires during the same turn");
  assert.equal(calls, 4, "the tool loop continued after compaction");
  assert.ok(
    requests[3].some((message) => message.content.some((block) => block.type === "system_reminder" && /Compacted memory/.test(block.text))),
    "the very next provider request receives the compacted anchor",
  );
});
