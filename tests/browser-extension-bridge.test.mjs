import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import net from "node:net";
import test from "node:test";

import { BrowserBridgeServer } from "../packages/browser-extension-connector/dist/index.js";

function lines(socket, onLine) {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onLine(JSON.parse(line));
    }
  });
}

test("browser extension bridge authenticates the native host and routes one command", async (t) => {
  const hostToken = "test-token-that-is-long-enough-for-real-config";
  const bridge = new BrowserBridgeServer({ port: 0, hostToken, requestTimeoutMs: 1_000 });
  await bridge.start();
  t.after(() => bridge.close());
  const address = bridge.address();
  assert.ok(address);

  const socket = net.createConnection(address);
  t.after(() => socket.destroy());
  const accepted = new Promise((resolve, reject) => {
    socket.once("error", reject);
    lines(socket, (message) => {
      if (message.type === "daemon.challenge") {
        const proof = createHmac("sha256", hostToken).update(message.nonce).digest("base64url");
        socket.write(`${JSON.stringify({ v: 1, id: message.id, type: "host.proof", proof })}\n`);
      } else if (message.type === "host.accepted") {
        resolve();
      } else if (message.type === "command") {
        socket.write(`${JSON.stringify({ v: 1, id: message.id, type: "result", ok: true, result: { title: "Live tab" } })}\n`);
      }
    });
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`${JSON.stringify({ v: 1, id: "hello", type: "host.hello", token: hostToken })}\n`);
  await accepted;
  assert.equal(bridge.connected(), true);
  assert.deepEqual(await bridge.request({ op: "page.state", tabId: 7 }), { title: "Live tab" });
});

test("browser extension bridge rejects a host with the wrong token", async (t) => {
  const bridge = new BrowserBridgeServer({ port: 0, hostToken: "correct-token" });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = net.createConnection(bridge.address());
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.write(`${JSON.stringify({ v: 1, id: "bad", type: "host.hello", token: "wrong-token" })}\n`);
  await closed;
  assert.equal(bridge.connected(), false);
});
