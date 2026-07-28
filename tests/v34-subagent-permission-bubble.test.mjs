// Locks the subagent permission-bubbling contract (the "5/5 researcher fleet
// died on Desktop\fixing\Mods_5" bug). A subagent runs a child QueryEngine with
// no UI of its own; before the fix, its tools saw ctx.requestPermission ===
// undefined, so ANY path outside the workspace hard-threw "escapes workspace
// and no permission prompt is available" — killing the whole fan-out on the
// first Glob/Read even though the user was sitting right there.
//
// The contract now:
//   1. The Task tool forwards the PARENT's live requestPermission into
//      SubagentRunRequest; AresSubagentRunner threads it into the child
//      engine's config, so an out-of-workspace touch PROMPTS instead of dying.
//   2. The grant lands in the SHARED path-permission store dir-scoped, so one
//      approval covers sibling leaves (no re-prompt storm).
//   3. Headless runs (no requestPermission anywhere) keep today's hard deny.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AresSubagentRunner, SubagentRegistry } from "../packages/core/dist/index.js";
import { ReadTool, adaptToolForEngine } from "../packages/tools/dist/index.js";

const makeTmp = (tag) => fs.mkdtemp(path.join(os.tmpdir(), `ares-v34-${tag}-`));

// Provider that issues ONE Read of the target file, then summarizes.
class ReadOnceProvider {
  constructor(file) {
    this.file = file;
    this.name = "read-once";
  }
  async *stream(req) {
    const hasToolResult = req.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    if (!hasToolResult) {
      const id = "rd";
      yield { type: "tool_use_start", id, name: "Read" };
      yield { type: "tool_use_input_done", id, input: { file_path: this.file } };
      yield {
        type: "message_done",
        message: {
          id: "m_read",
          role: "assistant",
          content: [{ type: "tool_use", id, name: "Read", input: { file_path: this.file } }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 0 },
        stopReason: "tool_use",
      };
    } else {
      yield {
        type: "message_done",
        message: {
          id: "m_done",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 0 },
        stopReason: "end_turn",
      };
    }
  }
}

// Minimal in-memory PathPermissionStore: dir-prefix grants, like the real one.
function makeStore() {
  const grants = [];
  return {
    grants,
    isAllowed(absPath, access) {
      const p = path.resolve(absPath);
      return grants.some(
        (g) =>
          (g.access === access || g.access === "all") &&
          (p === g.path || p.startsWith(g.path + path.sep)),
      );
    },
    async grant(absPath, access, scope) {
      grants.push({ path: path.resolve(absPath), access, scope });
    },
  };
}

function makeReadTool(store) {
  return adaptToolForEngine(ReadTool, (base) => ({
    ...base, // keeps the engine-injected requestPermission — mirrors the CLI's enrich
    permissionMode: "auto-safe",
    fileReadStamps: base.fileReadStamps,
    pathPermissions: store,
  }));
}

function makeRunner(provider, tool) {
  const registry = new SubagentRegistry([
    { name: "reader", description: "reads a file", systemPrompt: "Read the file.", toolWhitelist: ["Read"], maxTurns: 3 },
  ]);
  return new AresSubagentRunner({
    registry,
    provider,
    model: "mock",
    parentTools: [tool],
    baseSystemPrompt: "base",
  });
}

async function toolEndOutput(transcriptPath) {
  const text = await fs.readFile(transcriptPath, "utf8");
  for (const line of text.trim().split(/\r?\n/)) {
    const ev = JSON.parse(line);
    // A permission denial surfaces as tool_error, a success as tool_end —
    // capture whichever the call produced.
    if (ev.type === "tool_end") return JSON.stringify(ev.output);
    if (ev.type === "tool_error") return JSON.stringify(ev.error ?? ev);
  }
  return "";
}

// ── The headline: out-of-workspace read PROMPTS the parent and proceeds ──────

test("subagent: out-of-workspace read bubbles a permission prompt and succeeds on allow", async () => {
  const workspace = await makeTmp("ws");
  const outside = await makeTmp("outside"); // sibling dir — NOT under the workspace
  const file = path.join(outside, "mod.lua");
  await fs.writeFile(file, "print('oil quality')\n", "utf8");

  const store = makeStore();
  const prompts = [];
  const runner = makeRunner(new ReadOnceProvider(file), makeReadTool(store));

  const r = await runner.run({
    subagent_type: "reader",
    description: "read outside",
    prompt: "read the mod file",
    workspace,
    // The parent's prompt, as forwarded by the Task tool.
    requestPermission: async (req) => {
      prompts.push(req);
      return "allow_once";
    },
  });

  assert.equal(prompts.length, 1, "exactly one permission prompt bubbled up to the parent");
  assert.match(prompts[0].reason ?? "", /outside the workspace/, "prompt names the out-of-workspace path");
  const out = await toolEndOutput(r.transcriptPath);
  assert.match(out, /oil quality/, "the read went through after the allow — no dead subagent");
  assert.equal(r.status, "completed");
  assert.ok(
    store.isAllowed(file, "read"),
    "the grant landed dir-scoped in the SHARED store — sibling leaves won't re-prompt",
  );
});

// ── Deny: the child SURVIVES the denial and reports it ──
// A permission denial inside a child engine is an ordinary tool error the
// model can route around — NOT a turn interrupt. One denied out-of-workspace
// path used to kill an entire researcher fleet with "(subagent produced no
// text output)" (bug 96ca5473). The contract now: the denial is named in the
// child's transcript, the file never leaks, and the child still completes
// with a summary the parent can read.

test("subagent: a denied out-of-workspace read is recorded but does not kill the child", async () => {
  const workspace = await makeTmp("ws2");
  const outside = await makeTmp("outside2");
  const file = path.join(outside, "secret.lua");
  await fs.writeFile(file, "print('secret')\n", "utf8");

  const prompts = [];
  const runner = makeRunner(new ReadOnceProvider(file), makeReadTool(makeStore()));
  const r = await runner.run({
    subagent_type: "reader",
    description: "denied read",
    prompt: "read it",
    workspace,
    requestPermission: async (req) => {
      prompts.push(req);
      return "deny";
    },
  });

  assert.equal(prompts.length, 1, "the deny came from a REAL prompt that reached the parent");
  const out = await toolEndOutput(r.transcriptPath);
  assert.match(out, /denied outside workspace/, "the tool error names the denial");
  assert.doesNotMatch(out, /no permission prompt is available/, "denial ≠ the no-prompt hard-fail");
  assert.equal(r.status, "completed", "denial is survivable — the child routes around it and still reports");
});

// ── Headless: no prompt anywhere keeps today's hard deny (no silent bypass) ──

test("subagent: with no requestPermission the out-of-workspace read stays hard-denied", async () => {
  const workspace = await makeTmp("ws3");
  const outside = await makeTmp("outside3");
  const file = path.join(outside, "locked.lua");
  await fs.writeFile(file, "print('locked')\n", "utf8");

  const runner = makeRunner(new ReadOnceProvider(file), makeReadTool(makeStore()));
  const r = await runner.run({
    subagent_type: "reader",
    description: "headless read",
    prompt: "read it",
    workspace,
    // no requestPermission — the operator/cron posture
  });

  const out = await toolEndOutput(r.transcriptPath);
  assert.match(out, /no permission prompt is available/, "headless behavior unchanged: hard deny");
  assert.doesNotMatch(out, /print\('locked'\)/, "file content never leaked without a grant");
});
