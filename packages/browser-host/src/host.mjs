#!/usr/bin/env node
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";

const PROTOCOL = 1;
const MAX_NATIVE_IN = 4 * 1024 * 1024;
const MAX_NATIVE_OUT = 1024 * 1024;
const MAX_QUEUE = 256;
const home = process.env.ARES_HOME || path.join(homedir(), ".ares");
const configPath = process.env.ARES_BROWSER_BRIDGE_CONFIG || path.join(home, "browser-bridge", "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.host !== "127.0.0.1") throw new Error("browser bridge host must be 127.0.0.1");

let nativeBuffer = Buffer.alloc(0);
let socket = null;
let socketBuffer = "";
let daemonReady = false;
let paired = false;
let pairNonce = randomBytes(24).toString("base64url");
let reconnectMs = 250;
const queue = [];

const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const hmac = (secret, value) => createHmac("sha256", secret).update(value).digest("base64url");
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

function writeNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_OUT) {
    return writeNative({ v: PROTOCOL, id: message?.id, type: "result", ok: false, error: "native response exceeded 1 MB" });
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function sendSocket(message) {
  const line = JSON.stringify(message) + "\n";
  if (daemonReady && socket?.writable) socket.write(line);
  else {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(line);
  }
}

function flushQueue() {
  while (daemonReady && socket?.writable && queue.length) socket.write(queue.shift());
}

function connectDaemon() {
  if (!paired || socket) return;
  socket = net.createConnection({ host: "127.0.0.1", port: Number(config.port) });
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10_000);
  socket.on("connect", () => {
    reconnectMs = 250;
    socket.write(JSON.stringify({ v: PROTOCOL, id: crypto.randomUUID(), type: "host.hello", token: config.hostToken, at: new Date().toISOString() }) + "\n");
  });
  socket.on("data", (chunk) => {
    socketBuffer += chunk.toString("utf8");
    if (socketBuffer.length > MAX_NATIVE_IN) { socket.destroy(new Error("daemon frame overflow")); return; }
    let newline;
    while ((newline = socketBuffer.indexOf("\n")) >= 0) {
      const line = socketBuffer.slice(0, newline);
      socketBuffer = socketBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.type === "daemon.challenge") {
          socket.write(JSON.stringify({ v: PROTOCOL, id: message.id, type: "host.proof", proof: hmac(config.hostToken, message.nonce) }) + "\n");
        } else if (message.type === "host.accepted") {
          daemonReady = true;
          flushQueue();
        } else if (daemonReady) writeNative(message);
      } catch { /* malformed daemon line: ignore */ }
    }
  });
  const reconnect = () => {
    daemonReady = false;
    socket = null;
    if (paired) setTimeout(connectDaemon, reconnectMs).unref();
    reconnectMs = Math.min(reconnectMs * 2, 10_000);
  };
  socket.on("close", reconnect);
  socket.on("error", () => {});
}

async function onExtension(message) {
  if (!message || message.v !== PROTOCOL || typeof message.type !== "string") return;
  if (message.type === "extension.hello") {
    if (message.extensionId !== config.extensionId) {
      writeNative({ v: PROTOCOL, id: message.id, type: "result", ok: false, error: "extension id mismatch" });
      return;
    }
    pairNonce = randomBytes(24).toString("base64url");
    writeNative({ v: PROTOCOL, id: message.id, type: "host.challenge", nonce: pairNonce });
    return;
  }
  if (message.type === "pair.request") {
    if (!safeEqual(hash(message.code), hash(config.pairCode))) {
      writeNative({ v: PROTOCOL, id: message.id, type: "result", ok: false, error: "pairing code rejected" });
      return;
    }
    paired = true;
    connectDaemon();
    writeNative({ v: PROTOCOL, id: message.id, type: "pair.accepted", ok: true, pairSecret: config.pairSecret });
    return;
  }
  if (message.type === "pair.resume") {
    paired = safeEqual(message.nonce, pairNonce) && safeEqual(message.proof, hmac(config.pairSecret, pairNonce));
    if (paired) connectDaemon();
    writeNative(paired
      ? { v: PROTOCOL, id: message.id, type: "pair.accepted", ok: true }
      : { v: PROTOCOL, id: message.id, type: "result", ok: false, error: "pairing proof rejected" });
    return;
  }
  if (!paired) {
    writeNative({ v: PROTOCOL, id: message.id, type: "result", ok: false, error: "extension not paired" });
    return;
  }
  sendSocket(message);
}

process.stdin.on("data", (chunk) => {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
  if (nativeBuffer.length > MAX_NATIVE_IN + 4) throw new Error("native message overflow");
  while (nativeBuffer.length >= 4) {
    const size = nativeBuffer.readUInt32LE(0);
    if (size > MAX_NATIVE_IN) throw new Error("native message exceeds limit");
    if (nativeBuffer.length < size + 4) break;
    const body = nativeBuffer.subarray(4, size + 4);
    nativeBuffer = nativeBuffer.subarray(size + 4);
    try { void onExtension(JSON.parse(body.toString("utf8"))); } catch { /* ignore malformed extension frame */ }
  }
});
process.stdin.on("end", () => {
  paired = false;
  socket?.destroy();
  process.exit(0);
});
