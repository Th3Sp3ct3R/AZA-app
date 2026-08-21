// Contract for `ares attach` when it has no usable stdin (attachCommand in
// packages/cli/src/entry/garrisonCmd.ts).
//
// The regression this guards: readline closes as soon as stdin hits EOF, but
// every prompt() in attach is reached from a gateway frame — that is, from
// inside the websocket message handler. Prompting a closed readline throws
// ERR_USE_AFTER_CLOSE, and thrown there it is not caught, so `ares attach`
// died with a stack trace on any non-interactive invocation:
//
//   Error [ERR_USE_AFTER_CLOSE]: readline was closed
//       at Interface.prompt ... at WebSocket.<anonymous>
//
// The gateway here is a stand-in: it answers `hello` with a `welcome` carrying
// one session, which is the shortest path to a prompt() call. Everything runs
// against a temp ARES_HOME; nothing touches the real ~/.ares.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "packages", "cli", "dist", "entry.js");

/** A gateway that only knows how to greet, which is all attach needs to reach
 *  its first prompt(). Resolves once it is listening. */
async function startStubGateway() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type !== "hello") return;
      socket.send(
        JSON.stringify({
          type: "welcome",
          sessions: [
            {
              id: "sess-1",
              title: "existing conversation",
              busy: false,
              provider: "anthropic",
              model: "claude",
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, port: server.address().port };
}

function makeAresHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ares-attach-"));
  fs.mkdirSync(path.join(home, "garrison"), { recursive: true });
  fs.writeFileSync(path.join(home, "garrison", "token"), "0".repeat(32));
  return home;
}

/** Run `ares attach` with no stdin at all — stdio "ignore" hands the child
 *  /dev/null, exactly what a pipeline or a supervisor without a terminal does. */
function runAttach(port, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, "attach", "--url", `ws://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ARES_HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("close", (code, signal) => {
      clearTimeout(kill);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("attach detaches cleanly when stdin is closed instead of crashing", async (t) => {
  const { server, port } = await startStubGateway();
  const home = makeAresHome();
  t.after(() => {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const result = await runAttach(port, home);

  assert.doesNotMatch(
    result.stderr,
    /ERR_USE_AFTER_CLOSE/,
    "prompting a closed readline must not reach the websocket handler",
  );
  assert.doesNotMatch(result.stderr, /readline was closed/);
  assert.equal(result.signal, null, "must exit on its own, not be killed by the test timeout");
  assert.equal(result.code, 0, "EOF on stdin is a clean detach, not a failure");
  assert.match(result.stderr, /detached/, "and it says so");
});
