// Verifies the GarrisonServer approval surface — the wiring that turns the
// effects conscience layer from "moral theater a unit test sees" into a live,
// actionable approval on every attached client.
//
//   runEffect stages ─▶ ApprovalQueue.requestApproval (pauses)
//                       ├─ GarrisonServer broadcasts approval.pending
//                       └─ owner approval.respond ─▶ queue resolves ─▶ commit/deny

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ApprovalQueue,
  GarrisonServer,
  SessionManager,
  ensureToken,
} from "../packages/garrison/dist/index.js";
import { runEffect, Ledger, Budget, KillSwitch } from "../packages/effects/dist/index.js";
import { QueryEngine, MockEchoProvider } from "../packages/core/dist/index.js";

const wsModule = await import("ws").catch(
  () => import("../packages/garrison/node_modules/ws/wrapper.mjs"),
);
const WebSocket = wsModule.default ?? wsModule.WebSocket;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEffect(o = {}) {
  const state = { committed: 0 };
  const effect = {
    kind: o.kind ?? "browser.submit",
    domain: o.domain ?? "browser",
    irreversibility: o.irreversibility ?? "irreversible", // stages at leash 1
    idempotencyKey: o.id ?? `eff-${o.n ?? 1}`,
    async simulate() {
      return o.preview ?? { would: "submit the form" };
    },
    async commit() {
      state.committed++;
      return "ok";
    },
  };
  return { effect, state };
}

const railsCtx = (queue) => ({
  ledger: Ledger.memory(),
  budget: new Budget({}),
  killSwitch: KillSwitch.memory(),
  leashOf: () => 1,
  requestApproval: queue.requestApproval,
});

// A near-instant wait for a queued microtask/timer to settle.
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── 1. ApprovalQueue unit behavior ───────────────────────────────────────────

test("queue: requestApproval pauses, respond resolves with verb + approver", async () => {
  const queue = new ApprovalQueue({ approver: "owner" });
  const seen = [];
  queue.subscribe((s) => seen.push(s));

  const decision = queue.requestApproval({ id: "k1", kind: "browser.submit", domain: "browser", irreversibility: "irreversible", reason: "needs leash" });
  await tick();
  assert.equal(seen.length, 1, "subscriber notified of the staged effect");
  assert.equal(queue.pending().length, 1);

  queue.respond({ approvalId: "k1", verb: "allow_once", note: "go" });
  const d = await decision;
  assert.equal(d.verb, "allow_once");
  assert.equal(d.approver, "owner");
  assert.equal(d.note, "go");
  assert.equal(queue.pending().length, 0, "no longer pending once answered");
});

test("queue: subscribe replays outstanding approvals to a late joiner", async () => {
  const queue = new ApprovalQueue();
  queue.requestApproval({ id: "k2", kind: "x", domain: "browser", irreversibility: "irreversible", reason: "r" });
  const late = [];
  queue.subscribe((s) => late.push(s));
  assert.equal(late.length, 1, "the already-staged effect was replayed");
  assert.equal(late[0].id, "k2");
});

test("queue: responding to an unknown approval throws", () => {
  const queue = new ApprovalQueue();
  assert.throws(() => queue.respond({ approvalId: "nope", verb: "deny" }), /no pending approval/);
});

test("queue: timeout auto-denies a forgotten prompt", async () => {
  const queue = new ApprovalQueue({ timeoutMs: 10 });
  const d = await queue.requestApproval({ id: "k3", kind: "x", domain: "browser", irreversibility: "irreversible", reason: "r" });
  assert.equal(d.verb, "deny");
  assert.match(d.note, /timed out/);
});

// ── 2. runEffect integration ─────────────────────────────────────────────────

test("rails: staged effect approved through the queue → committed", async () => {
  const queue = new ApprovalQueue({ approver: "owner" });
  const { effect, state } = makeEffect({ id: "submit-1" });
  const ctx = railsCtx(queue);

  const running = runEffect(effect, ctx);
  await tick();
  const pending = queue.pending();
  assert.equal(pending.length, 1, "the effect staged and is awaiting the owner");
  assert.equal(pending[0].id, "submit-1");

  queue.respond({ approvalId: "submit-1", verb: "allow_once" });
  const result = await running;
  assert.equal(result.status, "committed");
  assert.equal(state.committed, 1);
});

test("rails: staged effect denied through the queue → never commits", async () => {
  const queue = new ApprovalQueue();
  const { effect, state } = makeEffect({ id: "submit-2" });
  const running = runEffect(effect, railsCtx(queue));
  await tick();
  queue.respond({ approvalId: "submit-2", verb: "deny", note: "not this one" });
  const result = await running;
  assert.equal(result.status, "denied");
  assert.equal(state.committed, 0);
});

// ── 3. Live GarrisonServer surface ───────────────────────────────────────────

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

async function bootWithApprovals() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-approvals-"));
  const factory = ({ sessionId, model, signal, requestPermission }) => ({
    engine: QueryEngine.forTesting(
      { provider: new MockEchoProvider(), model: model ?? "mock", systemPrompt: "t", tools: [], workspace: home, signal, requestPermission },
      sessionId,
    ),
    providerName: "mock-echo",
    model: model ?? "mock",
    workspace: home,
  });
  const sessions = new SessionManager({ home, factory });
  const approvals = new ApprovalQueue({ approver: "owner" });
  const server = new GarrisonServer({ home, sessions, approvals, port: 0 });
  const { port } = await server.start();
  const token = await ensureToken(home);
  return { server, approvals, port, token };
}

test("garrison: a staged effect broadcasts approval.pending; respond resumes the commit", async () => {
  const { server, approvals, port, token } = await bootWithApprovals();
  try {
    const client = await TestClient.openAuthed(port, token);
    const { effect, state } = makeEffect({ id: "wire-1" });
    const running = runEffect(effect, railsCtx(approvals));

    const pending = await client.waitFor((f) => f.type === "approval.pending");
    assert.equal(pending.staged.id, "wire-1");
    assert.equal(pending.staged.domain, "browser");

    client.send({ type: "approval.respond", approvalId: "wire-1", verb: "allow_once" });
    const result = await running;
    assert.equal(result.status, "committed");
    assert.equal(state.committed, 1);
    client.ws.close();
  } finally {
    await server.close();
  }
});

test("garrison: a client connecting mid-stage gets the pending approval replayed", async () => {
  const { server, approvals, port, token } = await bootWithApprovals();
  try {
    // Stage BEFORE any client connects.
    const { effect } = makeEffect({ id: "wire-2" });
    const running = runEffect(effect, railsCtx(approvals));
    await tick();

    const latecomer = await TestClient.openAuthed(port, token, "late");
    const replayed = await latecomer.waitFor((f) => f.type === "approval.pending");
    assert.equal(replayed.staged.id, "wire-2", "the waiting decision was there on connect");

    latecomer.send({ type: "approval.respond", approvalId: "wire-2", verb: "deny" });
    const result = await running;
    assert.equal(result.status, "denied");
    latecomer.ws.close();
  } finally {
    await server.close();
  }
});

test("garrison: approval.respond for an unknown id returns an error frame", async () => {
  const { server, port, token } = await bootWithApprovals();
  try {
    const client = await TestClient.openAuthed(port, token);
    client.send({ type: "approval.respond", approvalId: "ghost", verb: "deny" });
    const err = await client.waitFor((f) => f.type === "error");
    assert.match(err.message, /no pending approval/);
    client.ws.close();
  } finally {
    await server.close();
  }
});
