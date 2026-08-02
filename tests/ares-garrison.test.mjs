// Verifies V1 — the Garrison (daemon + gateway API):
//   1. Boot: HTTP /health answers and an authed websocket gets a welcome frame.
//   2. Auth: a bad token (and a non-hello first frame) is rejected and closed.
//   3. Fan-out: two clients attached to one session receive IDENTICAL event
//      frame sequences for a turn.
//   4. Resilience: killing one client mid-turn does not break the session for
//      the other; the survivor can keep driving the session.
//   5. Scheduler: heartbeat/dream hooks fire on (fake) interval ticks with no
//      client attached; stop() clears every timer.
//   6. Rollout: every TurnEvent persists as {ts,event} JSONL and
//      rehydrateSessions() restores the session — id, title, AND the full
//      message history (proven via the mock provider's request stats).
//   7. Busy: a concurrent send on a busy session is rejected cleanly.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GarrisonServer,
  SessionManager,
  Scheduler,
  ensureToken,
  rehydrateSessions,
} from "../packages/garrison/dist/index.js";
import { QueryEngine, MockEchoProvider } from "../packages/core/dist/index.js";

// "ws" is a dependency of @ares/garrison. Under pnpm's isolated node_modules it
// may not be importable from the repo root; fall back to the package's own copy.
const wsModule = await import("ws").catch(
  () => import("../packages/garrison/node_modules/ws/wrapper.mjs"),
);
const WebSocket = wsModule.default ?? wsModule.WebSocket;

// ── Helpers ────────────────────────────────────────────────────────────────

const echoTool = {
  schema: {
    name: "Echo",
    description: "Echo the input back.",
    inputJsonSchema: { type: "object", properties: { text: { type: "string" } } },
    safety: "read-only",
    concurrency: "parallel-safe",
  },
  async call(input) {
    return { output: input };
  },
};

function makeFactory(workspace) {
  return ({ sessionId, model, signal, requestPermission }) => {
    const engine = new QueryEngine(
      {
        provider: new MockEchoProvider(),
        model: model ?? "mock",
        systemPrompt: "garrison test",
        tools: [echoTool],
        workspace,
        signal,
        requestPermission,
      },
      sessionId,
    );
    return { engine, providerName: "mock-echo", model: model ?? "mock", workspace };
  };
}

async function bootGarrison() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-"));
  const sessions = new SessionManager({ home, factory: makeFactory(home) });
  const server = new GarrisonServer({ home, sessions, port: 0 });
  const { port } = await server.start();
  const token = await ensureToken(home); // read-or-create: returns the boot token
  return { home, sessions, server, port, token };
}

class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => ws.on("close", resolve));
    ws.on("message", (data) => {
      this.frames.push(JSON.parse(data.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
    ws.on("error", () => {});
  }

  static async open(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new TestClient(ws);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return client;
  }

  static async openAuthed(port, token, name = "test") {
    const client = await TestClient.open(port);
    client.send({ type: "hello", token, client: name, proto: 1 });
    await client.waitFor((f) => f.type === "welcome");
    return client;
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  async waitUntil(cond, timeoutMs = 8000) {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting; saw frames: ${this.frames.map((f) => f.type).join(", ")}`);
      }
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        const t = setTimeout(resolve, 100);
        t.unref?.();
      });
    }
  }

  async waitFor(pred, timeoutMs = 8000) {
    await this.waitUntil(() => this.frames.some(pred), timeoutMs);
    return this.frames.find(pred);
  }

  /** Ordering barrier: a round-trip proves all prior frames were processed. */
  async sync() {
    const before = this.frames.filter((f) => f.type === "sessions").length;
    this.send({ type: "sessions.list" });
    await this.waitUntil(() => this.frames.filter((f) => f.type === "sessions").length > before);
  }

  eventFrames(sessionId) {
    return this.frames.filter((f) => f.type === "event" && f.sessionId === sessionId);
  }
}

// ── 1. Boot + health ───────────────────────────────────────────────────────

test("garrison: boots on a random port, /health answers, authed client is welcomed", async () => {
  const { server, port, token } = await bootGarrison();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");
    assert.equal(body.sessions, 0);

    const client = await TestClient.open(port);
    client.send({ type: "hello", token, client: "test-suite", proto: 1 });
    const welcome = await client.waitFor((f) => f.type === "welcome");
    assert.deepEqual(welcome.sessions, []);
    client.ws.close();
  } finally {
    await server.close();
  }
});

// ── 2. Bad token rejected ──────────────────────────────────────────────────

test("garrison: a bad token is rejected with an error frame and the socket closes", async () => {
  const { server, port } = await bootGarrison();
  try {
    const wrong = await TestClient.open(port);
    wrong.send({ type: "hello", token: "0".repeat(32), client: "intruder", proto: 1 });
    const err = await wrong.waitFor((f) => f.type === "error");
    assert.match(err.message, /unauthorized/i);
    await wrong.closed;

    // A non-hello first frame is also a handshake failure.
    const rude = await TestClient.open(port);
    rude.send({ type: "sessions.list" });
    const err2 = await rude.waitFor((f) => f.type === "error");
    assert.match(err2.message, /hello/i);
    await rude.closed;
  } finally {
    await server.close();
  }
});

// ── 3. Two clients, identical event streams ────────────────────────────────

test("garrison: two attached clients receive identical event frame sequences", async () => {
  const { server, port, token } = await bootGarrison();
  try {
    const a = await TestClient.openAuthed(port, token, "a");
    const b = await TestClient.openAuthed(port, token, "b");

    a.send({ type: "session.create" });
    const created = await a.waitFor((f) => f.type === "session.created");
    const id = created.session.id;
    assert.equal(created.session.busy, false);
    assert.equal(created.session.provider, "mock-echo");

    a.send({ type: "session.attach", sessionId: id });
    b.send({ type: "session.attach", sessionId: id });
    await a.sync();
    await b.sync();

    a.send({ type: "session.send", sessionId: id, text: "to war" });
    await a.waitFor((f) => f.type === "event" && f.event.type === "turn_end");
    await b.waitFor((f) => f.type === "event" && f.event.type === "turn_end");

    const seqA = a.eventFrames(id);
    const seqB = b.eventFrames(id);
    assert.ok(seqA.length >= 3, "turn_start + deltas + message_done + turn_end");
    assert.deepEqual(seqA, seqB, "both clients saw the exact same frames in the same order");
    assert.equal(seqA[0].event.type, "turn_start");
    assert.equal(seqA[seqA.length - 1].event.type, "turn_end");

    a.ws.close();
    b.ws.close();
  } finally {
    await server.close();
  }
});

// ── 4. Killing one client mid-turn does not break the session ─────────────

test("garrison: a client dying mid-turn leaves the session alive for the other", async () => {
  const { server, port, token } = await bootGarrison();
  try {
    const a = await TestClient.openAuthed(port, token, "doomed");
    const b = await TestClient.openAuthed(port, token, "survivor");

    a.send({ type: "session.create" });
    const created = await a.waitFor((f) => f.type === "session.created");
    const id = created.session.id;
    a.send({ type: "session.attach", sessionId: id });
    b.send({ type: "session.attach", sessionId: id });
    await a.sync();
    await b.sync();

    // Long text => many text_delta chunks => the turn is genuinely in flight
    // when the doomed client is terminated.
    a.send({ type: "session.send", sessionId: id, text: "hold the line ".repeat(40) });
    await a.waitFor((f) => f.type === "event" && f.event.type === "turn_start");
    a.ws.terminate(); // hard kill, no close handshake

    await b.waitFor((f) => f.type === "event" && f.event.type === "turn_end");

    // The survivor keeps driving the same session.
    b.send({ type: "session.send", sessionId: id, text: "second wave" });
    await b.waitUntil(() => b.eventFrames(id).filter((f) => f.event.type === "turn_end").length >= 2);

    const starts = b.eventFrames(id).filter((f) => f.event.type === "turn_start");
    assert.equal(starts.length, 2, "survivor saw both turns");
    const echo = b.eventFrames(id).find(
      (f) => f.event.type === "message_done" && JSON.stringify(f.event.message).includes("second wave"),
    );
    assert.ok(echo, "second turn produced output after the first client died");

    b.send({ type: "sessions.list" });
    const listed = await b.waitFor(
      (f) => f.type === "sessions" && f.sessions.some((s) => s.id === id && s.busy === false),
    );
    assert.equal(listed.sessions.length, 1);
    b.ws.close();
  } finally {
    await server.close();
  }
});

// ── 5. Scheduler with fake timers ──────────────────────────────────────────

test("scheduler: heartbeat and dream hooks fire on ticks with no client attached", async () => {
  const intervals = [];
  let now = 0;
  let beats = 0;
  let dreams = 0;
  const sched = new Scheduler({
    hooks: {
      heartbeat: async () => { beats++; },
      dream: async () => { dreams++; },
    },
    heartbeatEveryMs: 1000,
    idleMs: 10_000,
    dreamCheckEveryMs: 500,
    lastActivityAt: () => 0,
    now: () => now,
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => {
      intervals.splice(intervals.indexOf(handle), 1);
    },
  });

  sched.start();
  assert.equal(intervals.length, 2, "one heartbeat timer + one dream-check timer");
  const heartbeatTimer = intervals.find((h) => h.ms === 1000);
  const dreamTimer = intervals.find((h) => h.ms === 500);
  const settle = () => new Promise((r) => setTimeout(r, 0));

  now = 1000;
  heartbeatTimer.fn();
  await settle();
  assert.equal(beats, 1, "heartbeat fired on its tick");

  now = 5000;
  dreamTimer.fn();
  await settle();
  assert.equal(dreams, 0, "not idle long enough — no dream");

  now = 20_000;
  assert.equal(sched.nextDreamAt(), 10_000, "dream was due at idleMs past last activity");
  dreamTimer.fn();
  await settle();
  assert.equal(dreams, 1, "dream fired once idle >= idleMs");

  dreamTimer.fn();
  await settle();
  assert.equal(dreams, 1, "no immediate re-dream — idle clock restarts after a dream");

  now = 31_000;
  dreamTimer.fn();
  await settle();
  assert.equal(dreams, 2, "dreams again after another full idle window");

  sched.stop();
  assert.equal(intervals.length, 0, "stop() cleared every timer");
});

// ── 6. Rollout persistence + rehydrate ─────────────────────────────────────

test("rollout: events persist as JSONL and rehydrate restores id, title, and history", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-"));
  const factory = makeFactory(home);

  const m1 = new SessionManager({ home, factory });
  const created = m1.create({});
  const events = [];
  const detach = m1.attach(created.id, (e) => events.push(e));
  await m1.send(created.id, "remember the war plans");
  await m1.flush();
  detach();
  assert.ok(events.some((e) => e.type === "turn_end"));

  const file = path.join(home, "garrison", "sessions", `${created.id}.jsonl`);
  const lines = (await fs.readFile(file, "utf8")).trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => typeof l.ts === "string" && typeof l.event?.type === "string"));
  assert.ok(lines.some((l) => l.event.type === "turn_start"));
  assert.ok(lines.some((l) => l.event.type === "message_done"));

  const telemetryDir = path.join(home, "telemetry");
  const frictionName = (await fs.readdir(telemetryDir)).find((name) => /^friction-.*\.jsonl$/.test(name));
  assert.ok(frictionName, "Garrison turn entered the shared friction stream");
  const friction = JSON.parse((await fs.readFile(path.join(telemetryDir, frictionName), "utf8")).trim());
  assert.equal(friction.schemaVersion, 2);
  assert.equal(friction.source, "garrison");
  assert.equal(friction.sessionId, created.id);
  assert.equal(friction.provider, "mock-echo");
  assert.equal(friction.model, "mock");
  assert.match(friction.workspaceHash, /^[a-f0-9]{64}$/);
  assert.ok(friction.turnId);

  const registryDir = path.join(telemetryDir, "session-locations");
  const registryNames = (await fs.readdir(registryDir)).filter((name) => name.endsWith(".json"));
  assert.equal(registryNames.length, 1);
  const location = JSON.parse(await fs.readFile(path.join(registryDir, registryNames[0]), "utf8"));
  assert.equal(location.sessionId, created.id);
  assert.equal(location.source, "garrison");
  assert.equal(location.rolloutPath, file);

  const prior = await rehydrateSessions(home);
  assert.equal(prior.length, 1);
  assert.equal(prior[0].id, created.id);
  assert.match(prior[0].title, /remember the war plans/);
  assert.equal(prior[0].messages.length, 2, "user message + assistant reply restored");
  assert.equal(prior[0].messages[0].role, "user");
  assert.equal(prior[0].messages[1].role, "assistant");

  // A fresh manager (a "daemon restart") rehydrates the session and the engine
  // carries the FULL prior history: the mock's stats probe counts messages it
  // was sent — 2 restored + 1 new = 3.
  const m2 = new SessionManager({ home, factory });
  const restored = await m2.rehydrate();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, created.id);
  assert.match(restored[0].title, /remember the war plans/);

  const replies = [];
  m2.attach(created.id, (e) => replies.push(e));
  await m2.send(created.id, "__mock_request_stats__");
  const done = replies.find((e) => e.type === "message_done");
  assert.ok(done, "rehydrated session ran a real turn");
  assert.match(done.message.content[0].text, /messages=3/, "restored history was sent to the provider");
  await m2.flush();
});

// ── 7. Busy session rejects concurrent send ────────────────────────────────

test("sessions: concurrent send on a busy session rejects cleanly", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-"));
  const m = new SessionManager({ home, factory: makeFactory(home) });
  const { id } = m.create({});
  const inFlight = m.send(id, "x".repeat(2000));
  await assert.rejects(() => m.send(id, "barge in"), /session busy/);
  await inFlight;
  await m.send(id, "after the turn"); // free again once the turn ends
  await m.flush();
});
