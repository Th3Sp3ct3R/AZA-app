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
//   7. Compaction replay: the post-compaction snapshot replaces stale history.
//   8. Canonical runtime: SessionManager drives Core Session without changing
//      the gateway contract and preserves its write-ahead admission event.
//   9. Admission fan-out: observer + stream delivery is identity-deduped.
//  10. Busy: a concurrent send on a legacy session is rejected cleanly.
//  11. Durable ingress: stable retries execute once; canonical queue/steer
//      admissions remain reachable while a turn is active.

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
import {
  QueryEngine,
  Session,
  MockEchoProvider,
  openWorkspaceSessionKernel,
} from "../packages/core/dist/index.js";

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
    const engine = QueryEngine.forTesting(
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

function makeCoreSessionFactory(workspace, sessionKernel, provider = new MockEchoProvider()) {
  return ({ sessionId, model, signal, requestPermission, initialMessages, initialEventCount }) => {
    const resolvedModel = model ?? "mock";
    const session = new Session({
      workspace,
      provider,
      model: resolvedModel,
      systemPrompt: "garrison core-session test",
      tools: [echoTool],
      signal,
      requestPermission,
      sessionId,
      initialMessages,
      initialSeq: initialEventCount,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
      sessionKernel,
    });
    return { session, providerName: "mock-echo", model: resolvedModel, workspace };
  };
}

function makeDualAdmissionFactory(workspace) {
  return ({ sessionId, model, signal, requestPermission }) => {
    const resolvedModel = model ?? "mock";
    const engine = QueryEngine.forTesting({
      workspace,
      provider: new MockEchoProvider(),
      model: resolvedModel,
      systemPrompt: "dual admission test",
      tools: [],
      signal,
      requestPermission,
    }, sessionId);
    const observers = new Set();
    const session = {
      engine,
      observeEvents(observer) {
        observers.add(observer);
        return () => observers.delete(observer);
      },
      interrupt() { engine.interrupt(); },
      async *sendContent(content, admission = {}) {
        const userMessage = engine.appendUserMessageContent(content);
        const admitted = {
          type: "input_admitted",
          inputId: admission.inputId ?? `dual-${userMessage.id}`,
          sessionId,
          delivery: admission.delivery ?? "queue",
          userMessage,
        };
        for (const observer of observers) observer(admitted);
        yield admitted; // simulate a future Core Session stream contract
        yield* engine.streamTurn();
      },
      async *send(text) {
        yield* this.sendContent([{ type: "text", text }]);
      },
    };
    return { session, providerName: "mock-echo", model: resolvedModel, workspace };
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

async function waitForCondition(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
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

test("rollout: compaction snapshot replaces stale history and admitted input is deduped", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-"));
  const dir = path.join(home, "garrison", "sessions");
  await fs.mkdir(dir, { recursive: true });

  const message = (id, role, text) => ({
    id,
    role,
    content: [{ type: "text", text }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const staleUser = message("stale-user", "user", "obsolete prompt");
  const staleAssistant = message("stale-assistant", "assistant", "obsolete reply");
  const recap = message("recap", "user", "Compacted recap of earlier work");
  const retained = message("retained", "assistant", "retained recent answer");
  const tailUser = message("tail-user", "user", "continue from compacted state");
  const tailAssistant = message("tail-assistant", "assistant", "continued");
  const events = [
    { type: "turn_start", turnId: "old", sessionId: "sess_compacted", userMessage: staleUser },
    { type: "message_done", message: staleAssistant },
    {
      type: "compaction",
      summarizedMessages: 2,
      tokensBefore: 10_000,
      tokensAfter: 1_000,
      method: "summary",
      messages: [recap, retained],
    },
    {
      type: "input_admitted",
      inputId: "input-tail",
      sessionId: "sess_compacted",
      delivery: "queue",
      userMessage: tailUser,
    },
    { type: "turn_start", turnId: "tail", sessionId: "sess_compacted", userMessage: tailUser },
    { type: "message_done", message: tailAssistant },
  ];
  const rollout = events
    .map((event, index) => JSON.stringify({ ts: new Date(index).toISOString(), event }))
    .join("\n");
  await fs.writeFile(path.join(dir, "sess_compacted.jsonl"), rollout + "\n", "utf8");

  const [restored] = await rehydrateSessions(home);
  assert.deepEqual(
    restored.messages.map((entry) => entry.id),
    ["recap", "retained", "tail-user", "tail-assistant"],
    "only the compacted baseline plus later messages survive, without admission/start duplication",
  );
});

test("sessions: canonical Core Session runtime preserves admission and resume history", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-core-session-"));
  const factory = makeCoreSessionFactory(home);
  const first = new SessionManager({ home, factory });
  const created = first.create();
  const firstEvents = [];
  first.attach(created.id, (event) => firstEvents.push(event));

  await first.send(created.id, "remember through the canonical runtime");
  await first.flush();
  assert.equal(firstEvents[0]?.type, "input_admitted", "write-ahead admission reaches Garrison clients first");
  assert.ok(firstEvents.some((event) => event.type === "turn_end"));

  const second = new SessionManager({ home, factory });
  const restored = await second.rehydrate();
  assert.equal(restored.length, 1);
  const resumedEvents = [];
  second.attach(created.id, (event) => resumedEvents.push(event));
  await second.send(created.id, "__mock_request_stats__");

  const done = resumedEvents.find((event) => event.type === "message_done");
  assert.ok(done);
  assert.match(done.message.content[0].text, /messages=3/, "Core Session resumed the Garrison transcript exactly");
  await second.flush();
});

test("sessions: admission delivered by observer and stream is persisted and fanned out once", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-dual-admission-"));
  const manager = new SessionManager({ home, factory: makeDualAdmissionFactory(home) });
  const created = manager.create();
  const events = [];
  manager.attach(created.id, (event) => events.push(event));
  await manager.send(created.id, "one logical input");
  await manager.flush();

  assert.equal(events.filter((event) => event.type === "input_admitted").length, 1);
  const rollout = await fs.readFile(path.join(home, "garrison", "sessions", `${created.id}.jsonl`), "utf8");
  const persisted = rollout.trim().split(/\r?\n/).map((line) => JSON.parse(line).event);
  assert.equal(persisted.filter((event) => event.type === "input_admitted").length, 1);
});

// ── 10. Legacy busy session rejects concurrent send ────────────────────────

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

// ── 11. Canonical durable ingress ──────────────────────────────────────────

test("gateway: retry after an ambiguous disconnect reuses one durable input", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-idempotent-"));
  const kernel = await openWorkspaceSessionKernel(home);
  let providerCalls = 0;
  let releaseProvider = () => {};
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  let markProviderStarted = () => {};
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const provider = {
    name: "gated-final",
    async *stream() {
      providerCalls += 1;
      if (providerCalls === 1) {
        markProviderStarted();
        await providerGate;
      }
      yield {
        type: "message_done",
        message: {
          id: `gateway-reply-${providerCalls}`,
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const sessions = new SessionManager({
    home,
    factory: makeCoreSessionFactory(home, kernel, provider),
  });
  const server = new GarrisonServer({ home, sessions, port: 0 });
  const { port } = await server.start();
  const token = await ensureToken(home);
  let first;
  let retry;
  try {
    first = await TestClient.openAuthed(port, token, "disconnecting-owner");
    first.send({ type: "session.create" });
    const created = await first.waitFor((frame) => frame.type === "session.created");
    const sessionId = created.session.id;
    const observed = [];
    sessions.attach(sessionId, (event) => observed.push(event));

    first.send({
      type: "session.send",
      sessionId,
      text: "perform one durable action",
      inputId: "owner-request-stable-1",
      delivery: "queue",
    });
    await first.waitFor(
      (frame) => frame.type === "event" && frame.event.type === "input_admitted",
    );
    await providerStarted;
    first.ws.terminate();
    releaseProvider();
    await waitForCondition(
      () => sessions.list().find((entry) => entry.id === sessionId)?.busy === false,
      "first durable send did not settle after its client disconnected",
    );

    retry = await TestClient.openAuthed(port, token, "retrying-owner");
    retry.send({
      type: "session.send",
      sessionId,
      text: "perform one durable action",
      inputId: "owner-request-stable-1",
      delivery: "queue",
    });
    await waitForCondition(
      () => observed.filter((event) => event.type === "input_admitted").length === 2,
      "retry did not acknowledge the original durable admission",
    );
    await waitForCondition(
      () => sessions.list().find((entry) => entry.id === sessionId)?.busy === false,
      "idempotent retry did not settle",
    );

    assert.equal(providerCalls, 1, "an ambiguous transport retry must not execute a second model/tool turn");
    assert.equal(kernel.getInput("owner-request-stable-1")?.state, "consumed");
    assert.equal(observed.filter((event) => event.type === "message_done").length, 1);
    assert.equal(observed.filter((event) => event.type === "turn_end").length, 1);
  } finally {
    releaseProvider();
    first?.ws.terminate();
    retry?.ws.terminate();
    await sessions.flush();
    await server.close();
    kernel.close();
  }
});

test("sessions: canonical runtime admits a concurrent queued input instead of rejecting busy", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-concurrent-"));
  const kernel = await openWorkspaceSessionKernel(home);
  let providerCalls = 0;
  let releaseFirst = () => {};
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let markFirstStarted = () => {};
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const provider = {
    name: "queue-gated-final",
    async *stream() {
      providerCalls += 1;
      const call = providerCalls;
      if (call === 1) {
        markFirstStarted();
        await firstGate;
      }
      yield {
        type: "message_done",
        message: {
          id: `queue-reply-${call}`,
          role: "assistant",
          content: [{ type: "text", text: `reply ${call}` }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const sessions = new SessionManager({
    home,
    factory: makeCoreSessionFactory(home, kernel, provider),
  });
  const { id } = sessions.create();
  const observed = [];
  sessions.attach(id, (event) => observed.push(event));
  let first;
  let second;
  try {
    first = sessions.send(id, "first", { inputId: "queued-a", delivery: "queue" });
    await firstStarted;
    second = sessions.send(id, "second", { inputId: "queued-b", delivery: "queue" });
    await waitForCondition(
      () => kernel.getInput("queued-b")?.state === "admitted",
      "second input did not cross the durable admission boundary while first was active",
    );

    assert.equal(sessions.list().find((entry) => entry.id === id)?.busy, true);
    assert.equal(providerCalls, 1, "provider execution must remain exclusive");
    assert.deepEqual(
      observed.filter((event) => event.type === "input_admitted").map((event) => event.inputId),
      ["queued-a", "queued-b"],
    );

    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(providerCalls, 2);
    assert.equal(kernel.getInput("queued-a")?.state, "consumed");
    assert.equal(kernel.getInput("queued-b")?.state, "consumed");
    assert.equal(sessions.list().find((entry) => entry.id === id)?.busy, false);
  } finally {
    releaseFirst();
    await Promise.allSettled([first, second].filter(Boolean));
    await sessions.flush();
    kernel.close();
  }
});

test("gateway: steer delivery and stable identity reach the canonical input ledger", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-steer-"));
  const kernel = await openWorkspaceSessionKernel(home);
  const sessions = new SessionManager({
    home,
    factory: makeCoreSessionFactory(home, kernel),
  });
  const server = new GarrisonServer({ home, sessions, port: 0 });
  const { port } = await server.start();
  const token = await ensureToken(home);
  let client;
  try {
    client = await TestClient.openAuthed(port, token, "steering-owner");
    client.send({ type: "session.create" });
    const created = await client.waitFor((frame) => frame.type === "session.created");
    client.send({
      type: "session.send",
      sessionId: created.session.id,
      text: "correct course",
      inputId: "owner-steer-1",
      delivery: "steer",
    });
    await client.waitFor(
      (frame) => frame.type === "event" && frame.event.type === "turn_end",
    );
    assert.equal(kernel.getInput("owner-steer-1")?.delivery, "steer");
    assert.equal(kernel.getInput("owner-steer-1")?.state, "consumed");
  } finally {
    client?.ws.terminate();
    await sessions.flush();
    await server.close();
    kernel.close();
  }
});

test("rehydration: canonical SQLite shadows stale Garrison rollout and metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-canonical-authority-"));
  const kernel = await openWorkspaceSessionKernel(home);
  try {
    kernel.createSession({
      id: "canonical-rehydrate",
      workspaceKey: home,
      title: "Canonical title",
      metadata: {
        provider: "canonical-provider",
        model: "canonical-model",
        createdAt: "2026-01-02T03:04:05.000Z",
      },
    });
    const lease = kernel.acquireRunnerLease("canonical-rehydrate", "rehydration-test", 5_000);
    const fence = {
      sessionId: lease.sessionId,
      generation: lease.generation,
      leaseToken: lease.leaseToken,
    };
    kernel.appendMessage(fence, {
      id: "canonical-user",
      role: "user",
      parts: [{ type: "text", data: { type: "text", text: "canonical history" } }],
    });
    kernel.appendMessage(fence, {
      id: "canonical-assistant",
      role: "assistant",
      model: "canonical-model",
      parts: [{ type: "text", data: { type: "text", text: "canonical reply" } }],
    });
    kernel.releaseRunnerLease(fence, {
      executionState: "completed",
      workOutcome: "not_applicable",
    });
    const canonicalEventCount = kernel.countEvents("canonical-rehydrate");

    const dir = path.join(home, "garrison", "sessions");
    await fs.mkdir(dir, { recursive: true });
    const staleUser = {
      id: "stale-user",
      role: "user",
      content: [{ type: "text", text: "STALE GARRISON HISTORY" }],
      createdAt: "2026-01-02T03:04:05.000Z",
    };
    await fs.writeFile(
      path.join(dir, "canonical-rehydrate.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), event: {
        type: "turn_start",
        turnId: "stale-turn",
        sessionId: "canonical-rehydrate",
        userMessage: staleUser,
      } })}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "canonical-rehydrate.meta.json"),
      JSON.stringify({
        id: "canonical-rehydrate",
        title: "Stale title",
        provider: "stale-provider",
        model: "stale-model",
      }),
      "utf8",
    );

    const [restored] = await rehydrateSessions(home, kernel);
    assert.equal(restored.canonical, true);
    assert.equal(restored.title, "Canonical title");
    assert.equal(restored.provider, "canonical-provider");
    assert.equal(restored.model, "canonical-model");
    assert.equal(restored.eventCount, canonicalEventCount);
    assert.deepEqual(
      restored.messages.map((entry) => entry.content[0]?.text),
      ["canonical history", "canonical reply"],
    );
  } finally {
    kernel.close();
  }
});

test("rehydration: canonical projection failures never fall through to Garrison JSON", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-canonical-corrupt-"));
  const kernel = await openWorkspaceSessionKernel(home);
  try {
    kernel.createSession({ id: "canonical-corrupt", workspaceKey: home });
    const lease = kernel.acquireRunnerLease("canonical-corrupt", "rehydration-corrupt-test", 5_000);
    const fence = {
      sessionId: lease.sessionId,
      generation: lease.generation,
      leaseToken: lease.leaseToken,
    };
    kernel.appendContextEpoch(fence, {
      reason: "malformed projection regression",
      summary: { text: "broken" },
      projection: [{ id: "missing-content", role: "assistant" }],
      sourceVersions: { lastMessageOrdinal: 0 },
    });
    kernel.releaseRunnerLease(fence, {
      executionState: "completed",
      workOutcome: "not_applicable",
    });
    const dir = path.join(home, "garrison", "sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "canonical-corrupt.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), event: {
        type: "turn_start",
        turnId: "stale-turn",
        sessionId: "canonical-corrupt",
        userMessage: {
          id: "stale-user",
          role: "user",
          content: [{ type: "text", text: "unsafe fallback" }],
          createdAt: new Date().toISOString(),
        },
      } })}\n`,
      "utf8",
    );

    await assert.rejects(rehydrateSessions(home, kernel), /(?:content|map)/i);
  } finally {
    kernel.close();
  }
});
