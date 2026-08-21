import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Daemons spawned below persist REAL session rollouts into <cwd>/.ares —
// a temp workspace keeps them out of the repo's own .ares directory.
const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ares-v4-ws-"));
const cliEntry = path.join(__dirname, "..", "packages", "cli", "dist", "entry.js");

test("V4 V10: themes command exposes clean graphite and oxide themes", () => {
  const result = spawnSync(process.execPath, [cliEntry, "themes"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /graphite/);
  assert.match(result.stdout, /oxide/);
});

test("V4 V10: daemon --json emits ready event for companion UI protocol", () => {
  const result = spawnSync(process.execPath, [cliEntry, "daemon", "--json", "--provider", "mock"], {
    input: JSON.stringify({ type: "exit" }) + "\n",
    encoding: "utf8",
    windowsHide: true,
    cwd: workspaceRoot,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /daemon_ready/);
});

test("V4 V10: daemon permission_response unblocks a pending tool", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-perm-home-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-perm-outside-"));
  const outsideFile = path.join(outside, "outside.txt");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "ui.json"), JSON.stringify({ dangerousBypass: false }, null, 2) + "\n", "utf8");
  writeFileSync(outsideFile, "permission bridge works\n", "utf8");

  const child = spawn(process.execPath, [cliEntry, "daemon", "--json", "--provider", "mock"], {
    cwd: workspaceRoot,
    env: { ...process.env, ARES_HOME: home, ARES_AGENT_ENABLED: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const events = [];
  let stdoutBuffer = "";
  let stderr = "";
  let sentGoal = false;
  let answeredPermission = false;
  let settled = false;

  const writeCommand = (command) => {
    child.stdin.write(JSON.stringify(command) + "\n");
  };

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`daemon permission test timed out\nstdout=${stdoutBuffer}\nstderr=${stderr}`));
      }, 45_000); // CLI cold boot is 6-10s on Windows (module graph + AV scan) — 12s flaked

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          events.push(event);
          if (event.type === "daemon_ready" && !sentGoal) {
            sentGoal = true;
            writeCommand({ type: "send", goal: `__mock_read_tool__ ${outsideFile}` });
          }
          if (event.type === "permission_request" && !answeredPermission) {
            answeredPermission = true;
            writeCommand({ type: "permission_response", id: event.id, decision: "allow_once" });
          }
          if (event.type === "turn_end") {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        }
      });

      child.on("exit", (code) => {
        if (settled) return;
        clearTimeout(timeout);
        reject(new Error(`daemon exited before turn_end: ${code}\nstderr=${stderr}`));
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    writeCommand({ type: "exit" });
    child.kill();
    // Wait for the child to actually die — on Windows a just-killed node can
    // hold CPU/AV attention for seconds and starve the NEXT test's cold boot.
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 5_000).unref?.();
    });
  }

  const types = events.map((event) => event.type);
  assert.ok(types.includes("permission_request"), "expected a permission_request event");
  assert.ok(types.includes("permission_response"), "expected a permission_response event");
  assert.ok(types.includes("tool_end"), "expected the approved tool to finish");
  assert.equal(events.findLast((event) => event.type === "turn_end")?.status, "completed");
});

test("V4 V10: daemon fresh sessions pass context budget and chat tuning", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-budget-home-"));
  mkdirSync(home, { recursive: true });

  const child = spawn(process.execPath, [cliEntry, "daemon", "--json", "--provider", "mock"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ARES_HOME: home,
      ARES_AGENT_ENABLED: "0",
      ARES_CONTEXT_BUDGET: "900",
      ARES_MAX_OUTPUT_TOKENS: "123",
      ARES_REASONING_LEVEL: "low",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const events = [];
  let stdoutBuffer = "";
  let stderr = "";
  let sentLong = false;
  let sentStats = false;
  let turnEnds = 0;
  let settled = false;

  const writeCommand = (command) => {
    child.stdin.write(JSON.stringify(command) + "\n");
  };

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`daemon budget test timed out\nstdout=${stdoutBuffer}\nstderr=${stderr}`));
      }, 45_000); // CLI cold boot is 6-10s on Windows (module graph + AV scan) — 12s flaked

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          events.push(event);
          if (event.type === "daemon_ready" && !sentLong) {
            sentLong = true;
            writeCommand({ type: "send", goal: `long ${"x".repeat(18_000)}` });
          }
          if (event.type === "turn_end") {
            turnEnds++;
            if (turnEnds === 1 && !sentStats) {
              sentStats = true;
              writeCommand({ type: "send", goal: "__mock_request_stats__" });
            } else if (turnEnds === 2) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        }
      });

      child.on("exit", (code) => {
        if (settled) return;
        clearTimeout(timeout);
        reject(new Error(`daemon exited before budget probe completed: ${code}\nstderr=${stderr}`));
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    writeCommand({ type: "exit" });
    child.kill();
    // Wait for the child to actually die — on Windows a just-killed node can
    // hold CPU/AV attention for seconds and starve the NEXT test's cold boot.
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 5_000).unref?.();
    });
  }

  const statsText = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.text)
    .join("")
    .match(/messages=\d+ chars=\d+ reasoning=\w+ maxOutput=\d+/)?.[0];
  assert.ok(statsText, "expected mock request stats in the second turn");
  assert.match(statsText, /messages=1\b/, statsText);
  assert.match(statsText, /reasoning=low\b/, statsText);
  assert.match(statsText, /maxOutput=123\b/, statsText);
  const chars = Number(statsText.match(/chars=(\d+)/)?.[1] ?? 0);
  assert.ok(chars < 200, `expected old giant history to be trimmed, saw ${statsText}`);
});
