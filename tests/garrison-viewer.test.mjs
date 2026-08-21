// The read-only viewer leg of the garrison. Pins:
//  1. GET /view serves the self-contained viewer page (no assets, no CSP holes
//     — a single HTML document).
//  2. The READ token authenticates and can list sessions + pull history, but
//     every write frame (session.send, session.create, session.interrupt,
//     permission.respond, approval.respond) is refused server-side — the
//     read/control split is a server wall, not client politeness.
//  3. The CONTROL token still has the full protocol.
//  4. session.history replays injected rollout entries, newest-N clamped.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GarrisonServer,
  ensureToken,
  ensureReadToken,
  viewerHtml,
} from "../packages/garrison/dist/index.js";

const wsModule = await import("ws").catch(
  () => import("../packages/garrison/node_modules/ws/wrapper.mjs"),
);
const WebSocket = wsModule.default ?? wsModule.WebSocket;

/** Minimal structural stand-in for SessionManager — the server only calls
 *  list/attach/send/interrupt/respondPermission/ensureLive here. */
function fakeSessions() {
  const sent = [];
  return {
    sent,
    list: () => [{ id: "s1", title: "hello world", model: "m", provider: "p", busy: false }],
    attach: () => () => {},
    ensureLive: async () => ({}),
    send: async (id, text) => {
      sent.push({ id, text });
    },
    interrupt: () => {},
    respondPermission: () => true,
    lastActivityAt: () => Date.now(),
    flush: async () => {},
  };
}

function connect(port, token, client = "test") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const frames = [];
    const waiters = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, client, proto: 1 })));
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    ws.on("error", reject);
    const next = () =>
      new Promise((res) => {
        const buffered = frames.shift();
        if (buffered) res(buffered);
        else waiters.push(res);
      });
    // First frame decides: welcome (authed) or error (rejected).
    next().then((first) => resolve({ ws, next, first, send: (f) => ws.send(JSON.stringify(f)) }));
  });
}

test("viewer page + read/control scope split + history replay", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-viewer-"));
  const sessions = fakeSessions();
  const historyEntries = Array.from({ length: 10 }, (_, i) => ({
    ts: new Date(1700000000000 + i * 1000).toISOString(),
    event: { type: "text_delta", text: `chunk${i}` },
  }));
  const server = new GarrisonServer({
    home,
    sessions,
    port: 0,
    history: async (sessionId, opts) => {
      assert.equal(sessionId, "s1");
      return opts?.limit ? historyEntries.slice(-opts.limit) : historyEntries;
    },
  });
  try {
    const { port } = await server.start();
    const controlToken = await ensureToken(home);
    const readToken = await ensureReadToken(home);
    assert.notEqual(controlToken, readToken);

    // 1. GET /view serves the page; it survives being fetched twice.
    const page = await (await fetch(`http://127.0.0.1:${port}/view`)).text();
    assert.match(page, /<!DOCTYPE html>/);
    assert.match(page, /read token/);
    assert.equal(page, viewerHtml());

    // 2. Read token: welcome + list + history work…
    const reader = await connect(port, readToken, "viewer");
    assert.equal(reader.first.type, "welcome");
    assert.equal(reader.first.sessions.length, 1);

    reader.send({ type: "session.history", sessionId: "s1", limit: 4 });
    const history = await reader.next();
    assert.equal(history.type, "session.history");
    assert.equal(history.entries.length, 4);
    assert.equal(history.entries[3].event.text, "chunk9");

    // …but every write frame is refused, and nothing reaches the manager.
    for (const frame of [
      { type: "session.send", sessionId: "s1", text: "do something" },
      { type: "session.create" },
      { type: "session.interrupt", sessionId: "s1" },
      { type: "permission.respond", sessionId: "s1", requestId: "r", decision: "allow_once" },
      { type: "approval.respond", approvalId: "a", verb: "approve" },
    ]) {
      reader.send(frame);
      const reply = await reader.next();
      assert.equal(reply.type, "error", `${frame.type} must be refused`);
      assert.match(reply.message, /read-only/);
    }
    assert.equal(sessions.sent.length, 0, "no send may reach the session manager from a read client");
    reader.ws.close();

    // 3. Control token keeps the full protocol (send reaches the manager).
    const controller = await connect(port, controlToken, "desktop");
    assert.equal(controller.first.type, "welcome");
    controller.send({ type: "session.send", sessionId: "s1", text: "real work" });
    // send() is fire-and-forget; give the microtask a beat.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(sessions.sent, [{ id: "s1", text: "real work" }]);
    controller.ws.close();

    // 4. A wrong token is still rejected outright.
    const stranger = await connect(port, "0".repeat(32));
    assert.equal(stranger.first.type, "error");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
