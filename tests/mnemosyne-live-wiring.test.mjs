// Mnemosyne live adoption — the recall spine goes through the single-writer
// server. Pins the mnemosyneRuntime contract:
//   1. first process HOSTS (unref'd), and recall round-trips through the wire;
//   2. a process that finds a running server CONNECTS instead of hosting;
//   3. a dead server falls back to the direct store — a turn never breaks;
//   4. ARES_MNEMOSYNE=0 disables the whole path;
//   5. unifiedRecallForTurn consumes the recaller through its openLiving seam.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mnemosyneHandle,
  mnemosyneRecaller,
  mnemosyneLiveness,
  resetMnemosyneForTests,
} from "../packages/cli/dist/entry/mnemosyneRuntime.js";
import { MnemosyneServer } from "../packages/mnemosyne/dist/index.js";
import { MemoryStore } from "../packages/mind/dist/index.js";
import { unifiedRecallForTurn } from "../packages/agent/dist/index.js";

// Each test gets its own port so a parallel test file on the default port
// can never cross-talk with these.
let nextPort = 17_433 + Math.floor(Math.random() * 500);
function freshEnv() {
  process.env.ARES_MNEMOSYNE_PORT = String(nextPort++);
  delete process.env.ARES_MNEMOSYNE;
}

function freshHome() {
  return mkdtempSync(path.join(os.tmpdir(), "ares-mn-wire-"));
}

test("first process hosts, recall round-trips through the wire", async () => {
  freshEnv();
  const home = freshHome();
  try {
    const handle = await mnemosyneHandle(home);
    assert.ok(handle, "handle must be acquired when nothing is listening");
    assert.equal(handle.hosted, true, "with no server running, this process hosts");
    assert.equal(mnemosyneLiveness().state, "hosting");

    await handle.client.remember("semantic", "the garrison token lives under the ares home");
    const recaller = await mnemosyneRecaller(home, path.join(home, "mind", "memory.jsonl"));
    assert.ok(recaller);
    const hits = await recaller.remember("where does the garrison token live");
    assert.ok(hits.some((r) => /garrison token/.test(r.node.content)), "wire recall surfaces the stored memory");

    // peek is read-only recall over the same wire.
    const peeked = await recaller.peek("garrison token");
    assert.ok(peeked.some((r) => /garrison token/.test(r.node.content)));
  } finally {
    await resetMnemosyneForTests();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a process that finds a running server connects instead of hosting", async () => {
  freshEnv();
  const home = freshHome();
  const server = new MnemosyneServer({ home, port: Number(process.env.ARES_MNEMOSYNE_PORT) });
  try {
    await server.start();
    const handle = await mnemosyneHandle(home);
    assert.ok(handle);
    assert.equal(handle.hosted, false, "an already-running server is joined, never fought");
    assert.equal(mnemosyneLiveness().state, "connected");
  } finally {
    await resetMnemosyneForTests();
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a dead server falls back to the direct store mid-recaller", async () => {
  freshEnv();
  const home = freshHome();
  const memoryFile = path.join(home, "mind", "memory.jsonl");
  try {
    const handle = await mnemosyneHandle(home);
    assert.ok(handle?.hosted);
    await handle.client.remember("semantic", "fallback memories survive a server death");
    const recaller = await mnemosyneRecaller(home, memoryFile);

    // The server dies out from under the live recaller.
    await resetMnemosyneForTests();

    const hits = await recaller.remember("what survives a server death");
    assert.ok(
      hits.some((r) => /fallback memories/.test(r.node.content)),
      "recall falls back to the direct store instead of failing the turn",
    );
  } finally {
    await resetMnemosyneForTests();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ARES_MNEMOSYNE=0 disables the whole path", async () => {
  freshEnv();
  process.env.ARES_MNEMOSYNE = "0";
  const home = freshHome();
  try {
    assert.equal(await mnemosyneHandle(home), null);
    assert.equal(await mnemosyneRecaller(home, path.join(home, "mind", "memory.jsonl")), null);
    assert.equal(mnemosyneLiveness().state, "disabled");
  } finally {
    delete process.env.ARES_MNEMOSYNE;
    await resetMnemosyneForTests();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("unifiedRecallForTurn consumes the wire recaller through openLiving", async () => {
  freshEnv();
  const home = freshHome();
  try {
    const handle = await mnemosyneHandle(home);
    assert.ok(handle?.hosted);
    await handle.client.remember("semantic", "the release checklist has four manifests and a changelog");
    // Distilled kinds only — episodic must NOT surface into a live turn.
    await handle.client.remember("episodic", "user said: hello there");
    const recaller = await mnemosyneRecaller(home, path.join(home, "mind", "memory.jsonl"));

    const recall = await unifiedRecallForTurn({
      query: "what is in the release checklist",
      workspace: home,
      openLiving: async () => recaller,
    });
    assert.ok(recall.items.some((it) => /four manifests/.test(it.content)), "living recall flows through the wire");
    assert.ok(recall.items.every((it) => !/hello there/.test(it.content)), "episodic stays out of live turns");
    assert.ok(recall.livingIds.length >= 1, "consequence settling still gets ids to settle");
  } finally {
    await resetMnemosyneForTests();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("direct-store writes remain visible to wire recall (one file, one truth)", async () => {
  freshEnv();
  const home = freshHome();
  const memoryFile = path.join(home, "mind", "memory.jsonl");
  try {
    // A legacy writer (router path) writes straight to the file first…
    const store = await MemoryStore.open(memoryFile);
    await store.add({ kind: "semantic", content: "legacy writers still land in the same substrate" });

    // …then the server opens the SAME file and serves it over the wire.
    const handle = await mnemosyneHandle(home);
    assert.ok(handle);
    const hits = await handle.client.recall("where do legacy writers land");
    assert.ok(hits.some((r) => /legacy writers/.test(r.node.content)));
  } finally {
    await resetMnemosyneForTests();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
