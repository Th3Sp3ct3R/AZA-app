// V9 core engine upgrades — the context ledger (trimmed history leaves a
// deterministic digest, not silent amnesia) and the adaptive convergence
// guard (gather-stalls get told to deliver; productive builds run free).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { budgetMessages, buildContextLedger, Session } from "../packages/core/dist/index.js";

function textMsg(role, text, tag) {
  return { id: `m_${tag}`, role, content: [{ type: "text", text }], createdAt: new Date().toISOString() };
}

test("budget: the dropped span is returned, in order", () => {
  const msgs = [0, 1, 2, 3, 4].map((i) => textMsg(i % 2 ? "assistant" : "user", "x".repeat(4000), `${i}`));
  const { dropped, trimmed } = budgetMessages(msgs, 2500, 0);
  assert.equal(dropped.length, trimmed);
  assert.equal(dropped[0].id, "m_0", "oldest message drops first");
});

test("context ledger: extracts user asks, tool counts, and touched files", () => {
  const dropped = [
    textMsg("user", "build me a landing page\nwith dark mode", "ask1"),
    {
      id: "m_tools",
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "site/index.html", content: "..." } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "site/styles.css" } },
        { type: "tool_use", id: "t3", name: "Read", input: { file_path: "site/app.js" } },
      ],
      createdAt: new Date().toISOString(),
    },
  ];
  const ledger = buildContextLedger(dropped);
  assert.match(ledger, /Context ledger/);
  assert.match(ledger, /build me a landing page/);
  assert.match(ledger, /Read×2/);
  assert.match(ledger, /Write×1/);
  assert.match(ledger, /site\/index\.html/);
  assert.match(ledger, /Stay on the original mission/);
});

test("context ledger: empty span yields empty string", () => {
  assert.equal(buildContextLedger([]), "");
});

test("engine: a trimmed request carries the ledger to the provider", async () => {
  const requests = [];
  const provider = {
    name: "capture",
    async *stream(req) {
      requests.push(req);
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-ledger-"));
  const oldMessages = Array.from({ length: 8 }, (_, i) =>
    textMsg(i % 2 ? "assistant" : "user", `${i === 0 ? "the original mission statement" : "x".repeat(20_000)}`, `old_${i}`),
  );
  const session = new Session({
    workspace,
    provider,
    model: "m",
    systemPrompt: "s",
    tools: [],
    initialMessages: oldMessages,
    contextBudgetTokens: 10_000, // force a trim on the first attempt
  });
  for await (const _e of session.send("continue")) void _e;

  const sent = requests[0].messages;
  const flat = JSON.stringify(sent);
  assert.match(flat, /Context ledger/, "trimmed request must include the ledger digest");
  // The ledger must not break message shape: first message is user-role.
  assert.equal(sent[0].role, "user");
});

test("engine: gather-stall fires the convergence reminder; progress tools do not", async () => {
  process.env.ARES_GATHER_STALL_ROUNDS = "2";
  try {
    // The threshold is read live so Advanced settings apply without a restart.
    const requests = [];
    let round = 0;
    const gatherTool = {
      schema: { name: "Read", description: "read", inputJsonSchema: { type: "object" } },
      call: async () => ({ output: "data" }),
    };
    const provider = {
      name: "gatherer",
      async *stream(req) {
        requests.push(req);
        round++;
        if (round <= 3) {
          yield {
            type: "tool_use_start",
            id: `t${round}`,
            name: "Read",
          };
          yield { type: "tool_use_input_done", id: `t${round}`, input: { file_path: "x" } };
          yield {
            type: "message_done",
            message: {
              id: `a${round}`,
              role: "assistant",
              content: [{ type: "tool_use", id: `t${round}`, name: "Read", input: { file_path: "x" } }],
              createdAt: new Date().toISOString(),
            },
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: { id: "done", role: "assistant", content: [{ type: "text", text: "answer" }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "end_turn",
        };
      },
    };
    const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-stall-"));
    const session = new Session({
      workspace,
      provider,
      model: "m",
      systemPrompt: "s",
      tools: [gatherTool],
      contextBudgetTokens: 0,
    });
    const events = [];
    for await (const e of session.send("look around")) events.push(e);

    const stallReminders = events.filter((e) => e.type === "system_reminder_injected" && /gather-stall/.test(e.text ?? ""));
    assert.equal(stallReminders.length, 1, "the live two-round threshold should inject one convergence reminder");
    assert.equal(events.at(-1)?.status, "completed");
  } finally {
    delete process.env.ARES_GATHER_STALL_ROUNDS;
  }
});

test("engine: interrupt() stops the current turn; the next turn is unaffected", async () => {
  const { Session } = await import("../packages/core/dist/index.js");
  let call = 0;
  const provider = {
    name: "slow",
    async *stream(req) {
      call++;
      if (call === 1) {
        // emit a little text, then hang until aborted
        yield { type: "text_delta", text: "starting…" };
        await new Promise((resolve) => {
          const t = setInterval(() => {
            if (req.signal?.aborted) {
              clearInterval(t);
              resolve();
            }
          }, 20);
        });
        yield { type: "error", error: { code: "aborted", message: "aborted", retriable: false } };
        return;
      }
      yield {
        type: "message_done",
        message: { id: `a${call}`, role: "assistant", content: [{ type: "text", text: "second turn ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-interrupt-"));
  const session = new Session({ workspace, provider, model: "m", systemPrompt: "s", tools: [], contextBudgetTokens: 0 });

  const events = [];
  const run = (async () => {
    for await (const e of session.send("long task")) events.push(e);
  })();
  // Interrupt only ONCE the turn is provably streaming (its first text_delta
  // has landed) — a fixed sleep races the generator's startup under CI load.
  const deadline = Date.now() + 5000;
  while (!events.some((e) => e.type === "text_delta") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(events.some((e) => e.type === "text_delta"), "the turn started streaming before interrupt");
  session.interrupt();
  await run;
  assert.equal(events.at(-1)?.type, "turn_end");
  assert.equal(events.at(-1)?.status, "interrupted");
  assert.ok(!events.some((e) => e.error?.code === "no_message_done"), "Stop is never mislabeled as a provider close");

  // next turn must stream normally — interrupt() must not poison the session
  const events2 = [];
  for await (const e of session.send("again")) events2.push(e);
  assert.equal(events2.at(-1)?.status, "completed");
});

test("session: an interrupted attempt can resume the same pending turn with steering", async () => {
  const { Session } = await import("../packages/core/dist/index.js");
  const reminders = [];
  const requests = [];
  let calls = 0;
  const provider = {
    name: "steer-resume",
    async *stream(req) {
      calls++;
      requests.push(req.messages);
      if (calls === 1) {
        yield { type: "text_delta", text: "working" };
        await new Promise((resolve) => req.signal.addEventListener("abort", resolve, { once: true }));
        return;
      }
      yield {
        type: "message_done",
        message: { id: "steered", role: "assistant", content: [{ type: "text", text: "changed course" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-steer-resume-"));
  const session = new Session({
    workspace,
    provider,
    model: "m",
    systemPrompt: "s",
    tools: [],
    contextBudgetTokens: 0,
    drainSystemReminders: () => reminders.splice(0),
  });
  const first = [];
  const running = (async () => { for await (const event of session.send("build it")) first.push(event); })();
  const deadline = Date.now() + 5000;
  while (!first.some((event) => event.type === "text_delta") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  session.interrupt();
  await running;
  assert.equal(first.at(-1)?.status, "interrupted");

  reminders.push({ text: "The user STEERED mid-task: use blue", source: "instructions" });
  const resumed = [];
  for await (const event of session.resumeTurn()) resumed.push(event);
  assert.equal(resumed.at(-1)?.status, "completed");
  assert.match(JSON.stringify(requests[1]), /STEERED mid-task: use blue/);
  assert.equal(calls, 2);
});

test("verifier: findRelatedTestFiles maps source files to existing tests only", async () => {
  const { findRelatedTestFiles } = await import("../packages/core/dist/index.js");
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "ares-related-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "src", "auth.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "src", "auth.test.ts"), "// sibling test\n");
  await writeFile(path.join(root, "src", "db.ts"), "export const y = 1;\n");
  await writeFile(path.join(root, "tests", "db.test.mjs"), "// workspace tests dir\n");
  await writeFile(path.join(root, "src", "lonely.ts"), "export const z = 1;\n");

  const related = await findRelatedTestFiles(
    [path.join(root, "src", "auth.ts"), path.join(root, "src", "db.ts"), path.join(root, "src", "lonely.ts")],
    root,
  );
  const names = related.map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ["auth.test.ts", "db.test.mjs"]);
});

test("engine: a retriable pre-output provider error is retried, not failed (S1)", async () => {
  let calls = 0;
  const provider = {
    name: "flaky",
    async *stream() {
      calls++;
      if (calls === 1) {
        // 529-style overload before any tokens stream — must be retried.
        yield { type: "error", error: { code: "overloaded_error", message: "overloaded", retriable: true } };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text: "recovered" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 10, outputTokens: 2 },
        stopReason: "end_turn",
      };
    },
  };
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-retry-"));
  const session = new Session({ workspace: ws, provider, model: "m", systemPrompt: "s", tools: [], contextBudgetTokens: 0 });
  const events = [];
  for await (const e of session.send("hi")) events.push(e);
  assert.equal(calls, 2, "the engine retried once after the transient error");
  const retryNote = events.find((e) => e.type === "system_reminder_injected" && /retrying/.test(e.text ?? ""));
  assert.ok(retryNote, "a retry notice is surfaced");
  assert.equal(events.at(-1)?.status, "completed", "the turn completes instead of dying on the 529");
  const done = events.find((e) => e.type === "message_done");
  assert.match(done.message.content[0].text, /recovered/);
});

test("engine: a non-retriable provider error fails the turn (no infinite retry)", async () => {
  let calls = 0;
  const provider = {
    name: "fatal",
    async *stream() {
      calls++;
      yield { type: "error", error: { code: "bad_request", message: "nope", retriable: false } };
    },
  };
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-fatal-"));
  const session = new Session({ workspace: ws, provider, model: "m", systemPrompt: "s", tools: [], contextBudgetTokens: 0 });
  const events = [];
  for await (const e of session.send("hi")) events.push(e);
  assert.equal(calls, 1, "non-retriable errors are not retried");
  assert.equal(events.at(-1)?.status, "failed");
});

test("engine: circuit-breaker fires after 3 identical tool failures, then re-arms", async () => {
  const failTool = {
    schema: { name: "Browser", description: "browser", inputJsonSchema: { type: "object" } },
    call: async () => {
      throw new Error("BROWSER_UNAVAILABLE: the headless browser is not available");
    },
  };
  let round = 0;
  const provider = {
    name: "looper",
    async *stream() {
      round++;
      if (round <= 5) {
        yield { type: "tool_use_start", id: `t${round}`, name: "Browser" };
        yield { type: "tool_use_input_done", id: `t${round}`, input: { action: "open" } };
        yield {
          type: "message_done",
          message: { id: `a${round}`, role: "assistant", content: [{ type: "tool_use", id: `t${round}`, name: "Browser", input: { action: "open" } }], createdAt: new Date().toISOString() },
          usage: {},
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "done", role: "assistant", content: [{ type: "text", text: "switching to WebFetch" }], createdAt: new Date().toISOString() },
        usage: {},
        stopReason: "end_turn",
      };
    },
  };
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-cb-"));
  const session = new Session({ workspace: ws, provider, model: "m", systemPrompt: "s", tools: [failTool], contextBudgetTokens: 0 });
  const events = [];
  for await (const e of session.send("open a browser")) events.push(e);
  const breaker = events.find((e) => e.type === "system_reminder_injected" && /circuit-breaker/.test(e.text ?? ""));
  assert.ok(breaker, "circuit-breaker should fire on a 3x identical failure loop");
  assert.match(breaker.text, /Browser/);
  assert.equal(events.at(-1)?.status, "completed");
});

test("engine: steer reminder on a resumed turn lands AFTER the tool_result blocks (400-brick fix)", async () => {
  // Post-steer resume: the interrupted turn's history tail is the tool_results
  // user message, and the daemon queues the steer as a system reminder before
  // resumeTurn(). The old unshift put the reminder AHEAD of the tool_results —
  // on the Anthropic wire that's [text, tool_result], which 400s ("tool_use ids
  // were found without tool_result blocks immediately after") and, because the
  // unshift mutated persisted history, re-sent the same poison on every retry.
  const requests = [];
  const provider = {
    name: "capture",
    async *stream(req) {
      requests.push(req);
      yield {
        type: "message_done",
        message: { id: "a_res", role: "assistant", content: [{ type: "text", text: "adjusted course" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-steer-"));
  const steers = [{ text: 'The user STEERED mid-task: "overhaul the design too". Adjust course.', source: "instructions" }];
  const initialMessages = [
    textMsg("user", "rebuild the extension", "u0"),
    { id: "a0", role: "assistant", content: [{ type: "tool_use", id: "toolu_STEER", name: "Read", input: {} }], createdAt: new Date().toISOString() },
    { id: "u1", role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_STEER", content: "file contents" }], createdAt: new Date().toISOString() },
  ];
  const session = new Session({
    workspace,
    provider,
    model: "m",
    systemPrompt: "s",
    tools: [],
    initialMessages,
    contextBudgetTokens: 0,
    drainSystemReminders: () => steers.splice(0),
  });
  const events = [];
  for await (const e of session.resumeTurn()) events.push(e);

  assert.equal(events.at(-1)?.status, "completed");
  const sent = requests[0].messages;
  const resultsMsg = sent.find((m) => m.content.some((b) => b.type === "tool_result"));
  assert.ok(resultsMsg, "tool_results message reaches the provider");
  assert.equal(resultsMsg.content[0].type, "tool_result", "tool_result must stay the FIRST block of its message");
  const reminderIndex = resultsMsg.content.findIndex((b) => b.type === "system_reminder" && /STEERED mid-task/.test(b.text));
  assert.ok(reminderIndex > 0, "steer reminder is present and positioned after the tool_result");
});
