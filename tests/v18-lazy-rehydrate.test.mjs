// Verifies lazy single-session rehydration — a session whose rollout is on disk
// but was NOT loaded at boot is rebuilt on demand when a client sends/attaches,
// instead of erroring. This is what keeps sessions alive across a crash/restart
// when boot rehydrate didn't catch them (appeared late, transient factory miss,
// or a client referencing an id this process never loaded).

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GarrisonServer,
  SessionManager,
  rehydrateSession,
  ensureToken,
} from "../packages/garrison/dist/index.js";
import { QueryEngine, MockEchoProvider } from "../packages/core/dist/index.js";

const wsModule = await import("ws").catch(
  () => import("../packages/garrison/node_modules/ws/wrapper.mjs"),
);
const WebSocket = wsModule.default ?? wsModule.WebSocket;

function makeFactory(home) {
  return ({ sessionId, model, signal, requestPermission }) => ({
    engine: QueryEngine.forTesting(
      { provider: new MockEchoProvider(), model: model ?? "mock", systemPrompt: "t", tools: [], workspace: home, signal, requestPermission },
      sessionId,
    ),
    providerName: "mock-echo",
    model: model ?? "mock",
    workspace: home,
  });
}

// Write a real rollout to disk by running a session in a throwaway manager.
async function seedSession(home, text = "remember the war plans") {
  const m = new SessionManager({ home, factory: makeFactory(home) });
  const { id } = m.create({});
  await m.send(id, text);
  await m.flush();
  return id;
}

// ── 1. send() lazily rehydrates a session not loaded at boot ──────────────────

test("manager: send to an unknown-but-on-disk session rebuilds it with full history", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lazy-"));
  const id = await seedSession(home);

  // A fresh manager that DID NOT call rehydrate() — the session is absent in memory.
  const m2 = new SessionManager({ home, factory: makeFactory(home) });
  assert.equal(m2.has(id), false, "not live until touched");

  // The mock echoes message count it was sent: 2 restored (user+assistant) + 1 new = 3.
  // ensureLive first (as the gateway does before attach), then observe the turn.
  const summary = await m2.ensureLive(id);
  assert.equal(summary.id, id);
  const events = [];
  m2.attach(id, (e) => events.push(e));
  await m2.send(id, "__mock_request_stats__");

  assert.equal(m2.has(id), true, "now live after the lazy rehydrate");
  const done = events.find((e) => e.type === "message_done");
  assert.ok(done, "the rehydrated session ran a real turn");
  assert.match(done.message.content[0].text, /messages=3/, "prior history was restored and sent");
  await m2.flush();
});

// ── 2. ensureLive returns null for a genuinely unknown id ─────────────────────

test("manager: ensureLive returns null for a session with no rollout", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lazy-"));
  const m = new SessionManager({ home, factory: makeFactory(home) });
  assert.equal(await m.ensureLive("sess_does_not_exist"), null);
  // send to a truly unknown id still rejects cleanly.
  await assert.rejects(() => m.send("sess_ghost", "hi"), /unknown session/);
});

// ── 3. concurrent ensureLive does not double-spawn ────────────────────────────

test("manager: concurrent rehydration of the same id is deduped (one live session)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lazy-"));
  const id = await seedSession(home);

  const m2 = new SessionManager({ home, factory: makeFactory(home) });
  const [a, b, c] = await Promise.all([m2.ensureLive(id), m2.ensureLive(id), m2.ensureLive(id)]);
  assert.equal(a.id, id);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(m2.list().filter((s) => s.id === id).length, 1, "spawned exactly once");
});

// ── 4. rehydrateSession single-file loader ────────────────────────────────────

test("rehydrateSession: loads one session's history, null when absent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lazy-"));
  const id = await seedSession(home, "hold the line");
  const restored = await rehydrateSession(home, id);
  assert.equal(restored.id, id);
  assert.match(restored.title, /hold the line/);
  assert.equal(restored.messages.length, 2, "user + assistant restored");
  assert.equal(await rehydrateSession(home, "nope"), null);
});

// ── 5. gateway: attach to a session not loaded at boot rehydrates + streams ────

class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.waiters = [];
    ws.on("message", (data) => {
      this.frames.push(JSON.parse(data.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
    ws.on("error", () => {});
  }
  static async openAuthed(port, token, name = "test") {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new TestClient(ws);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    client.send({ type: "hello", token, client: name, proto: 1 });
    await client.waitFor((f) => f.type === "welcome");
    return client;
  }
  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }
  async waitFor(pred, timeoutMs = 8000) {
    const start = Date.now();
    while (!this.frames.some(pred)) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out; saw: ${this.frames.map((f) => f.type).join(", ")}`);
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        const t = setTimeout(resolve, 50);
        t.unref?.();
      });
    }
    return this.frames.find(pred);
  }
}

test("gateway: attach+send to a session only on disk rehydrates and drives it", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lazy-"));
  const id = await seedSession(home);

  // Boot a server that DID NOT rehydrate — the id is unknown to its live table.
  const sessions = new SessionManager({ home, factory: makeFactory(home) });
  const server = new GarrisonServer({ home, sessions, port: 0 });
  const { port } = await server.start();
  const token = await ensureToken(home);
  try {
    const client = await TestClient.openAuthed(port, token);
    // welcome lists nothing (boot didn't load it) — but attach self-heals.
    client.send({ type: "session.attach", sessionId: id });
    client.send({ type: "session.send", sessionId: id, text: "__mock_request_stats__" });

    const done = await client.waitFor((f) => f.type === "event" && f.event.type === "message_done");
    assert.match(done.event.message.content[0].text, /messages=3/, "restored history reached the provider over the wire");
    client.ws.close();
  } finally {
    await server.close();
  }
});

test("gateway: attach to a genuinely unknown id yields an error frame", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lazy-"));
  const sessions = new SessionManager({ home, factory: makeFactory(home) });
  const server = new GarrisonServer({ home, sessions, port: 0 });
  const { port } = await server.start();
  const token = await ensureToken(home);
  try {
    const client = await TestClient.openAuthed(port, token);
    client.send({ type: "session.attach", sessionId: "sess_phantom" });
    const err = await client.waitFor((f) => f.type === "error");
    assert.match(err.message, /unknown session/);
    client.ws.close();
  } finally {
    await server.close();
  }
});
