// Locks the read-stamp isolation invariant at the ENGINE level (the tool-level
// half is covered by v23). Two mechanisms together prevent the "a subagent's
// read blesses the parent with edit permission" bug:
//   - QueryEngine threads its OWN cfg.fileReadStamps into every tool call.
//   - AresSubagentRunner gives each subagent run a FRESH Map (subagents.ts).
// If either regressed (a shared/module-global map), one engine could falsely
// grant another read-before-write authority — these tests catch it.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  QueryEngine,
  AresSubagentRunner,
  SubagentRegistry,
} from "../packages/core/dist/index.js";
import { ReadTool, adaptToolForEngine } from "../packages/tools/dist/index.js";

const makeTmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-v24-"));

// A provider that performs one whole-file Read, then ends.
class WholeFileReadProvider {
  constructor(file) {
    this.file = file;
    this.name = "wholefile-read";
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
        message: { id: "m_read", role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: this.file } }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 0 },
        stopReason: "tool_use",
      };
    } else {
      yield {
        type: "message_done",
        message: { id: "m_done", role: "assistant", content: [{ type: "text", text: "read complete" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 0 },
        stopReason: "end_turn",
      };
    }
  }
}

const readTool = adaptToolForEngine(ReadTool, (base) => ({
  ...base,
  permissionMode: "bypass",
  fileReadStamps: base.fileReadStamps,
}));

async function runReadEngine(map, file, workspace) {
  const engine = QueryEngine.forTesting(
    { provider: new WholeFileReadProvider(file), model: "mock", systemPrompt: "t", tools: [readTool], workspace, signal: new AbortController().signal, fileReadStamps: map },
    "eng",
  );
  engine.appendUserMessage("read it");
  for await (const _ of engine.streamTurn()) { /* drain */ }
}

async function toolEndOutput(transcriptPath) {
  const text = await fs.readFile(transcriptPath, "utf8");
  for (const line of text.trim().split(/\r?\n/)) {
    const ev = JSON.parse(line);
    if (ev.type === "tool_end") return JSON.stringify(ev.output);
  }
  return "";
}

// ── QueryEngine threads its OWN map into tool calls ───────────────────────────

test("engine: a tool call writes to the engine's own fileReadStamps map", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "a.ts");
  await fs.writeFile(file, "const a = 1;\n", "utf8");
  const map = new Map();
  await runReadEngine(map, file, tmp);
  assert.equal(map.has(path.resolve(file)), true, "the engine's read landed in the map it was configured with");
});

test("engine: two engines with separate maps do not share read stamps", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "b.ts");
  await fs.writeFile(file, "const b = 2;\n", "utf8");
  const mapA = new Map();
  const mapB = new Map();
  await runReadEngine(mapA, file, tmp);
  assert.equal(mapA.has(path.resolve(file)), true, "engine A recorded its read");
  assert.equal(mapB.has(path.resolve(file)), false, "engine B never saw engine A's read — isolated");
});

// ── Each subagent run gets a fresh map (the headline guard) ───────────────────

test("subagent: each run reads fresh — a prior run's read is NOT inherited", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "shared.ts");
  await fs.writeFile(file, "const secret = 42;\n", "utf8");

  const registry = new SubagentRegistry([
    { name: "reader", description: "reads a file", systemPrompt: "Read the file.", toolWhitelist: ["Read"], maxTurns: 3 },
  ]);
  const runner = new AresSubagentRunner({
    registry,
    provider: new WholeFileReadProvider(file),
    model: "mock",
    parentTools: [readTool],
    baseSystemPrompt: "base",
  });

  const r1 = await runner.run({ subagent_type: "reader", description: "first", prompt: "read", workspace: tmp });
  const r2 = await runner.run({ subagent_type: "reader", description: "second", prompt: "read", workspace: tmp });

  assert.ok(r1.toolCallCount >= 1 && r2.toolCallCount >= 1, "both subagents actually ran the Read");
  const out1 = await toolEndOutput(r1.transcriptPath);
  const out2 = await toolEndOutput(r2.transcriptPath);
  assert.match(out1, /const secret = 42;/, "first subagent read real content");
  assert.match(out2, /const secret = 42;/, "second subagent ALSO read real content (fresh map)");
  assert.doesNotMatch(out2, /already in your context/, "second run did NOT inherit the first run's read stamp");
});

// ── A parent's read does not bless a subagent ─────────────────────────────────

test("subagent: a parent engine's read does not pre-satisfy a subagent's read", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "p.ts");
  await fs.writeFile(file, "const parent = 1;\n", "utf8");

  const parentMap = new Map();
  await runReadEngine(parentMap, file, tmp);
  assert.equal(parentMap.has(path.resolve(file)), true, "parent recorded its read");

  const registry = new SubagentRegistry([
    { name: "reader", description: "reads", systemPrompt: "Read the file.", toolWhitelist: ["Read"], maxTurns: 3 },
  ]);
  const runner = new AresSubagentRunner({
    registry,
    provider: new WholeFileReadProvider(file),
    model: "mock",
    parentTools: [readTool],
    baseSystemPrompt: "base",
  });
  const r = await runner.run({ subagent_type: "reader", description: "child", prompt: "read", workspace: tmp });
  const out = await toolEndOutput(r.transcriptPath);
  assert.match(out, /const parent = 1;/, "subagent read fresh content in its isolated context");
});

test("subagent: dispatch awaits the live full parent prompt composition", async () => {
  const tmp = await makeTmp();
  let observedPrompt = "";
  let compositions = 0;
  const provider = {
    name: "prompt-capture",
    async *stream(req) {
      observedPrompt = req.system;
      yield {
        type: "message_done",
        message: {
          id: "done",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const registry = new SubagentRegistry([
    { name: "worker", description: "works", systemPrompt: "TYPE PROMPT", maxTurns: 2 },
  ]);
  const runner = new AresSubagentRunner({
    registry,
    provider,
    model: "mock",
    parentTools: [],
    baseSystemPrompt: async () => {
      compositions++;
      await Promise.resolve();
      return "OWNER + PERSONA + MEMORY + REPO";
    },
  });

  await runner.run({ subagent_type: "worker", description: "child", prompt: "work", workspace: tmp });
  assert.equal(compositions, 1);
  assert.match(observedPrompt, /TYPE PROMPT/);
  assert.match(observedPrompt, /OWNER \+ PERSONA \+ MEMORY \+ REPO/);
});
