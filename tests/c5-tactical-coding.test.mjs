// C5 — tactical coding upgrades: act-first tool_choice forcing, per-iteration
// reasoning phases (deep plan → routine continuation → deep recovery), the
// DeepSeek thinking-skip on routine rounds with 400 self-heal, and incremental
// checkpoints (no full-workspace walk on the hot Edit path).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  QueryEngine,
  AnthropicProvider,
  createWorkspaceCheckpoint,
  diffWorkspaceCheckpointUnified,
} from "../packages/core/dist/index.js";

process.env.ARES_ADAPTIVE_REASONING = "0"; // isolate the tactical dial from text triviality

// ─── engine harness ───────────────────────────────────────────────────────────

/** Provider that emits one tool call on the first N stream()s, then plain text.
 *  Captures every ProviderRequest so tests can assert per-iteration fields. */
function makeToolLoopProvider(captured, { toolRounds = 1 } = {}) {
  let call = 0;
  return {
    name: "capture-provider",
    async *stream(req) {
      captured.push(req);
      call++;
      if (call <= toolRounds) {
        const id = `tool_${call}`;
        yield { type: "tool_use_start", id, name: "Echo" };
        yield { type: "tool_use_input_done", id, input: { note: `round ${call}` } };
        yield {
          type: "message_done",
          message: {
            id: `a_${call}`,
            role: "assistant",
            content: [{ type: "tool_use", id, name: "Echo", input: { note: `round ${call}` } }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield {
        type: "message_done",
        message: { id: `a_${call}`, role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      };
    },
  };
}

function makeEchoTool({ fail = false } = {}) {
  return {
    schema: {
      name: "Echo",
      description: "Test echo tool",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "read-only",
      concurrency: "parallel-safe",
    },
    async call() {
      if (fail) throw new Error("echo exploded");
      return { output: "ok" };
    },
  };
}

async function runTurn(engine) {
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);
  return events;
}

test("C5: work-item first turn forces toolChoice 'any'; routine continuation relaxes + goes routine-phase", async () => {
  const captured = [];
  const engine = QueryEngine.forTesting(
    {
      provider: makeToolLoopProvider(captured),
      model: "test",
      systemPrompt: "test",
      tools: [makeEchoTool()],
      workspace: "D:\\Ares",
      maxTurns: 4,
      reasoningLevel: "high",
    },
    "sess_c5_workitem",
  );
  engine.appendWorkItem("build the widget end to end");
  await runTurn(engine);

  assert.equal(captured.length, 2, "one tool round + one closing call");
  // iteration 0: act-first forcing + deep phase at the owner's ceiling
  assert.equal(captured[0].toolChoice, "any", "goal-mode opening call must force a tool call");
  assert.equal(captured[0].reasoningPhase, "deep");
  assert.equal(captured[0].reasoningLevel, "high");
  // iteration 1 (clean round behind it): no forcing, routine phase, one notch lighter
  assert.equal(captured[1].toolChoice, undefined);
  assert.equal(captured[1].reasoningPhase, "routine");
  assert.equal(captured[1].reasoningLevel, "medium", "tactical dial steps high→medium on routine rounds");
});

test("C5: interactive chat never gets toolChoice forcing", async () => {
  const captured = [];
  const engine = QueryEngine.forTesting(
    {
      provider: makeToolLoopProvider(captured, { toolRounds: 0 }),
      model: "test",
      systemPrompt: "test",
      tools: [makeEchoTool()],
      workspace: "D:\\Ares",
      maxTurns: 2,
    },
    "sess_c5_chat",
  );
  engine.appendUserMessage("hey what's up");
  await runTurn(engine);
  assert.equal(captured[0].toolChoice, undefined, "chat turns are never forced");
});

test("C5: a failed tool round earns the deep phase (and full effort) back", async () => {
  const captured = [];
  const engine = QueryEngine.forTesting(
    {
      provider: makeToolLoopProvider(captured),
      model: "test",
      systemPrompt: "test",
      tools: [makeEchoTool({ fail: true })],
      workspace: "D:\\Ares",
      maxTurns: 4,
      reasoningLevel: "max",
    },
    "sess_c5_recovery",
  );
  engine.appendWorkItem("do the risky thing");
  await runTurn(engine);

  assert.equal(captured.length, 2);
  assert.equal(captured[1].reasoningPhase, "deep", "recovery after a failed round thinks at full depth");
  assert.equal(captured[1].reasoningLevel, "max", "no downshift on recovery");
});

// ─── provider wire: deepseek thinking-skip + tool_choice + self-heal ─────────

function streamFrom(s) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(s)); c.close(); } });
}
function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}
const MIN_SSE = [
  sse("message_start", { message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }),
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
  sse("message_stop", {}),
].join("");

function baseReq(extra = {}) {
  return {
    model: "deepseek-v4-pro",
    system: "SYSTEM",
    reasoningLevel: "high",
    tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
    signal: new AbortController().signal,
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "go" }], createdAt: "now" }],
    ...extra,
  };
}

async function drive(provider, req) {
  const events = [];
  for await (const ev of provider.stream(req)) events.push(ev);
  return events;
}

test("C5: deepseek routine phase omits the thinking pass; deep phase keeps it", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(streamFrom(MIN_SSE), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const p = new AnthropicProvider({ apiKey: "k", dialect: "deepseek", endpointUrl: "https://x/v1/messages", fetchImpl });
  await drive(p, baseReq({ reasoningPhase: "routine" }));
  await drive(p, baseReq({ reasoningPhase: "deep" }));
  await drive(p, baseReq({}));
  assert.equal(bodies[0].thinking, undefined, "routine round skips the reasoning pass");
  assert.deepEqual(bodies[1].thinking, { type: "enabled" }, "deep round thinks");
  assert.deepEqual(bodies[2].thinking, { type: "enabled" }, "no phase = deep (safe default)");
});

test("C5: genuine anthropic ignores the routine phase (budget models keep thinking)", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(streamFrom(MIN_SSE), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const p = new AnthropicProvider({ apiKey: "k", fetchImpl });
  await drive(p, baseReq({ model: "claude-sonnet-5", reasoningPhase: "routine" }));
  assert.ok(bodies[0].thinking, "anthropic path unaffected by the deepseek-only skip");
});

test("C5: toolChoice 'any' reaches the deepseek wire; anthropic+thinking withholds it", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(streamFrom(MIN_SSE), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const ds = new AnthropicProvider({ apiKey: "k", dialect: "deepseek", endpointUrl: "https://x/v1/messages", fetchImpl });
  await drive(ds, baseReq({ toolChoice: "any" }));
  assert.deepEqual(bodies[0].tool_choice, { type: "any" }, "deepseek accepts forcing alongside thinking");

  const an = new AnthropicProvider({ apiKey: "k", fetchImpl });
  await drive(an, baseReq({ model: "claude-sonnet-5", toolChoice: "any" }));
  assert.equal(bodies[1].tool_choice, undefined, "anthropic + extended thinking: forcing withheld (API rejects the combo)");

  await drive(an, baseReq({ model: "claude-sonnet-5", toolChoice: "any", reasoningLevel: "off" }));
  assert.deepEqual(bodies[2].tool_choice, { type: "any" }, "anthropic without thinking: forcing sent");
});

test("C5: a 400 on forced tool_choice self-heals (strip + retry once)", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.tool_choice) return new Response("no forced tools here", { status: 400 });
    return new Response(streamFrom(MIN_SSE), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const p = new AnthropicProvider({ apiKey: "k", dialect: "deepseek", endpointUrl: "https://x/v1/messages", fetchImpl });
  const events = await drive(p, baseReq({ toolChoice: "any" }));
  assert.equal(bodies.length, 2, "exactly one retry");
  assert.ok(bodies[0].tool_choice, "first attempt carried the forcing");
  assert.equal(bodies[1].tool_choice, undefined, "retry stripped it");
  assert.ok(events.some((e) => e.type === "text_delta"), "turn succeeded after the heal");
});

test("C5: a 400 on the thinking-skip self-heals (re-enable + retry once)", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (!body.thinking) return new Response("thinking required", { status: 400 });
    return new Response(streamFrom(MIN_SSE), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const p = new AnthropicProvider({ apiKey: "k", dialect: "deepseek", endpointUrl: "https://x/v1/messages", fetchImpl });
  const events = await drive(p, baseReq({ reasoningPhase: "routine" }));
  assert.equal(bodies.length, 2, "exactly one retry");
  assert.equal(bodies[0].thinking, undefined);
  assert.deepEqual(bodies[1].thinking, { type: "enabled" });
  assert.ok(events.some((e) => e.type === "text_delta"), "turn succeeded after the heal");
});

// ─── incremental checkpoints ──────────────────────────────────────────────────

test("C5: declared-target checkpoint layers on the parent instead of walking the workspace", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-c5-ckpt-"));
  try {
    writeFileSync(path.join(ws, "a.txt"), "alpha v1");
    writeFileSync(path.join(ws, "b.txt"), "bravo v1");

    // Base checkpoint: full walk (no targets).
    const base = await createWorkspaceCheckpoint({ workspace: ws, sessionId: "s", turnSeq: 1 });
    assert.equal(base.fileManifest.length, 2);

    // Edit a.txt; incremental checkpoint declares ONLY a.txt.
    writeFileSync(path.join(ws, "a.txt"), "alpha v2 — changed");
    // ...and sneak a change into b.txt that the incremental snapshot must NOT
    // pick up (proving it didn't walk).
    writeFileSync(path.join(ws, "b.txt"), "bravo v2 — sneaky");
    const inc = await createWorkspaceCheckpoint({
      workspace: ws,
      sessionId: "s",
      turnSeq: 2,
      parentCheckpointId: base.id,
      targetFiles: [path.join(ws, "a.txt")],
    });
    assert.equal(inc.fileManifest.length, 2, "manifest stays complete (layered)");
    const baseA = base.fileManifest.find((f) => f.path === "a.txt");
    const incA = inc.fileManifest.find((f) => f.path === "a.txt");
    const baseB = base.fileManifest.find((f) => f.path === "b.txt");
    const incB = inc.fileManifest.find((f) => f.path === "b.txt");
    assert.notEqual(incA.blobHash, baseA.blobHash, "target re-snapshotted");
    assert.equal(incB.blobHash, baseB.blobHash, "non-target inherited from parent — NO workspace walk");

    // Deleted target drops out of the manifest.
    rmSync(path.join(ws, "a.txt"));
    const inc2 = await createWorkspaceCheckpoint({
      workspace: ws,
      sessionId: "s",
      turnSeq: 3,
      parentCheckpointId: inc.id,
      targetFiles: [path.join(ws, "a.txt")],
    });
    assert.equal(inc2.fileManifest.some((f) => f.path === "a.txt"), false, "deleted target removed");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("C5: files-scoped unified diff stats only the named files (and still diffs them)", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-c5-diff-"));
  try {
    writeFileSync(path.join(ws, "a.txt"), "line one\n");
    writeFileSync(path.join(ws, "b.txt"), "other\n");
    const base = await createWorkspaceCheckpoint({ workspace: ws, sessionId: "s", turnSeq: 1 });
    writeFileSync(path.join(ws, "a.txt"), "line one\nline two\n");
    const diff = await diffWorkspaceCheckpointUnified(ws, base.id, ["a.txt"]);
    assert.deepEqual(diff.files, ["a.txt"]);
    assert.match(diff.diff, /\+line two/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─── Edit Layer 4: canonical match (unicode drift + indent shift) ─────────────

import { replaceResilient } from "../packages/tools/dist/Edit.js";

test("C5: Edit rescues unicode drift (curly quotes / NBSP / em-dash) via the normalized tier", () => {
  const file = `console.log("hello — world");\nconst x = 'it works';\n`;
  // The model reproduced straight-vs-curly + regular spaces + a hyphen:
  const r = replaceResilient(file, `console.log("hello - world");`, `console.log("bye");`, false);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.matchedBy, "normalized");
  assert.match(r.text, /console\.log\("bye"\);/);
  assert.match(r.text, /it works/, "untouched lines keep their original bytes");
});

test("C5: Edit rescues a SINGLE-line target the model over-indented (layers 1-3 all decline)", () => {
  const file = `function f() {\n    return 42;\n}\n`;
  // Model guessed EIGHT spaces; the file has 4. Not a substring (layer 1 misses),
  // trailing-ws tier misses (leading differs), anchor declines (<2 sig lines).
  const r = replaceResilient(file, `        return 42;`, `        return 43;`, false);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.matchedBy, "normalized");
  assert.match(r.text, /^ {4}return 43;$/m, "replacement re-indented to the FILE's real depth");
});

test("C5: normalized tier refuses ambiguity (two unicode-drifted matches fail loudly)", () => {
  const file = `log("a — b");\nx();\nlog("a — b");\n`; // em-dashes, twice
  const r = replaceResilient(file, `log("a - b");`, `log("c");`, false);
  assert.equal(r.ok, false, "two canon matches must never auto-apply");
});

// ─── EPERM armor: checkpoints can never kill a tool ───────────────────────────

import { isUnsnapshotableWorkspace } from "../packages/core/dist/index.js";
import os2 from "node:os";

test("C5: home / root / home-parent workspaces are unsnapshotable; project dirs are fine", () => {
  assert.equal(isUnsnapshotableWorkspace(os2.homedir()), true, "home itself");
  assert.equal(isUnsnapshotableWorkspace(path.dirname(os2.homedir())), true, "home's parent (C:\Users)");
  assert.equal(isUnsnapshotableWorkspace(path.parse(os2.homedir()).root), true, "drive root");
  assert.equal(isUnsnapshotableWorkspace("D:\Ares"), false, "a project dir snapshots normally");
  assert.equal(isUnsnapshotableWorkspace(path.join(os2.homedir(), "projects", "x")), false, "a project under home is fine");
});

test("C5: a THROWING checkpoint host degrades to no-undo — the tool still runs", async () => {
  const captured = [];
  let toolRan = false;
  const engine = QueryEngine.forTesting(
    {
      provider: makeToolLoopProvider(captured),
      model: "test",
      systemPrompt: "test",
      tools: [{
        schema: {
          name: "Echo",
          description: "writes",
          inputJsonSchema: { type: "object", properties: {} },
          safety: "workspace-write", // checkpointed class
          concurrency: "exclusive",
        },
        async call() {
          toolRan = true;
          return { output: "wrote it" };
        },
      }],
      workspace: "D:\Ares",
      maxTurns: 4,
      beforeToolUseCheckpoint: async () => {
        throw new Error("EPERM: operation not permitted, open 'C:\locked\file'");
      },
    },
    "sess_c5_ckpt_armor",
  );
  engine.appendWorkItem("write the file");
  const events = await runTurn(engine);

  assert.equal(toolRan, true, "the tool MUST run despite the checkpoint failure");
  assert.ok(
    events.some((e) => e.type === "system_reminder_injected" && /checkpoint failed/.test(e.text)),
    "failure surfaced as a reminder, not a tool_error",
  );
  assert.ok(!events.some((e) => e.type === "tool_error"), "no tool_error from the checkpoint layer");
  assert.equal(events.at(-1).status, "completed");
});

// ─── Elite gaps: post-compact file re-pin + explorer fast lane ────────────────

import { recentFilePathsFromSpan, BUILT_IN_SUBAGENT_TYPES } from "../packages/core/dist/index.js";

test("C5: recentFilePathsFromSpan pulls the last N unique worked-in files, most recent first", () => {
  const mk = (name, file_path) => ({
    id: "x", role: "assistant", createdAt: "now",
    content: [{ type: "tool_use", id: "t", name, input: { file_path } }],
  });
  const span = [
    mk("Read", "a.ts"),
    mk("Edit", "b.ts"),
    { id: "u", role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }], createdAt: "now" },
    mk("Write", "c.ts"),
    mk("Edit", "b.ts"), // duplicate — must dedupe
    mk("Grep", "ignored.ts"), // not a file tool input shape that counts
  ];
  const got = recentFilePathsFromSpan(span, 5);
  assert.deepEqual(got, ["b.ts", "c.ts", "a.ts"], `most recent first, deduped; got ${JSON.stringify(got)}`);
  assert.deepEqual(recentFilePathsFromSpan(span, 1), ["b.ts"], "cap respected");
});

test("C5: explorer subagent type exists — read-only whitelist + fast-lane preference", () => {
  const explorer = BUILT_IN_SUBAGENT_TYPES.find((t) => t.name === "explorer");
  assert.ok(explorer, "explorer type registered");
  assert.equal(explorer.modelPreference, "fast");
  assert.ok(explorer.toolWhitelist.includes("Grep") && explorer.toolWhitelist.includes("Read"));
  assert.ok(!explorer.toolWhitelist.includes("Edit") && !explorer.toolWhitelist.includes("Write"), "read-only");
  assert.match(explorer.systemPrompt, /file_path:line|file:line|citations/i);
});
