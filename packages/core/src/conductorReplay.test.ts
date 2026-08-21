import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Message, StreamEvent } from "@ares/protocol";
import { runFleet, type ConductorDeps, type FleetSpec } from "./conductor.js";
import type { Provider, ProviderRequest } from "./queryEngine.js";
import { SessionKernelStore, type BetterSqlite3Constructor } from "./sessionKernel/index.js";

const requireFromAgent = createRequire(new URL("../../agent/package.json", import.meta.url));
const BetterSqlite3 = requireFromAgent("better-sqlite3") as BetterSqlite3Constructor;

test("Conductor replay reconnects to one deterministic leaf input when the fleet boundary was lost", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-replay-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  let providerCalls = 0;
  const provider: Provider = {
    name: "counting-final",
    async *stream(_request: ProviderRequest): AsyncGenerator<StreamEvent> {
      providerCalls += 1;
      const message: Message = {
        id: "wire-conductor-result",
        role: "assistant",
        content: [{ type: "text", text: "durable leaf result" }],
        createdAt: new Date(0).toISOString(),
      };
      yield {
        type: "message_done",
        message,
        usage: { inputTokens: 3, outputTokens: 4, modelCalls: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const spec: FleetSpec = {
    goal: "read one durable fact",
    phases: [{ id: "research", kind: "parallel", agents: [{ role: "reader", prompt: "inspect it" }] }],
  };
  const deps: ConductorDeps = {
    provider,
    model: "fixed",
    parentTools: [],
    baseSystemPrompt: "test",
    workspace,
    signal: new AbortController().signal,
    sessionKernel: store,
    parentSessionId: "parent-session",
    invocationId: "provider-tool-use-42",
    validate: (_schema, parsed) => ({ ok: true, value: parsed }),
    schemaHint: (schema) => JSON.stringify(schema),
  };

  try {
    const first = await runFleet(spec, deps);
    assert.equal(providerCalls, 1);
    assert.match(first.fleetId, /^fleet_[a-f0-9]{32}$/);
    assert.equal(first.summary, "### reader\ndurable leaf result");
    const firstLeaf = first.phases[0]?.leaves[0];
    assert.ok(firstLeaf);

    // Simulate a process dying after the child committed but before the fleet's
    // phase-boundary checkpoint survived. The replay must recover through the
    // child session/input, not through leaves.json.
    await rm(path.join(workspace, ".ares", "fleets", first.fleetId, "leaves.json"), { force: true });

    const replay = await runFleet(spec, deps);
    assert.equal(replay.fleetId, first.fleetId, "same parent tool invocation owns one fleet");
    assert.equal(replay.phases[0]?.leaves[0]?.agentId, firstLeaf.agentId, "leaf session identity is stable");
    assert.equal(replay.summary, first.summary, "the restored canonical transcript supplies the result");
    assert.equal(providerCalls, 1, "replay must not issue a second provider request");

    const children = store.listChildSessions("parent-session");
    assert.equal(children.length, 1, "replay reconnects to the existing child session");
    assert.equal(store.listInputs(firstLeaf.agentId).length, 1, "one logical leaf has one admitted input");
    assert.equal(store.listInputs(firstLeaf.agentId)[0]?.state, "consumed");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Conductor never counts or merges completed-but-unverified mutation leaves", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-work-proof-"));
  const applied: string[] = [];
  const deps: ConductorDeps = {
    provider: { name: "unused", async *stream(): AsyncGenerator<StreamEvent> {} },
    model: "fixed",
    parentTools: [],
    baseSystemPrompt: "test",
    workspace,
    signal: new AbortController().signal,
    validate: (_schema, parsed) => ({ ok: true, value: parsed }),
    schemaHint: (schema) => JSON.stringify(schema),
    runAgent: async (args) => ({
      finalText: args.role,
      events: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      status: "completed",
      workStatus: args.role === "green" ? "verified" : "unverified",
    }),
    makeWorktree: async (label) => ({
      dir: path.join(workspace, label),
      changedFiles: async () => [`${label}.ts`],
      applyTo: async () => {
        applied.push(label);
        return { applied: [`${label}.ts`], failed: [] };
      },
      cleanup: async () => {},
    }),
  };
  const spec: FleetSpec = {
    phases: [{
      id: "build",
      kind: "parallel",
      build: true,
      isolation: "worktree",
      agents: [{ role: "green", prompt: "implement a" }, { role: "unproven", prompt: "implement b" }],
    }],
  };

  try {
    const result = await runFleet(spec, deps);
    assert.equal(result.status, "failed", "default all policy requires every mutation leaf to be verified");
    assert.equal(result.phases[0]?.status, "failed");
    assert.deepEqual(applied, ["build-0"], "the unverified branch is discarded instead of merged");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
