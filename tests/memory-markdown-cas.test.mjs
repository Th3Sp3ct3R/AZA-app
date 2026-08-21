import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MemoryConflictError,
  MemoryTool,
  makeMemoryTool,
  memoryContentVersion,
} from "../packages/tools/dist/index.js";

function context(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

function input(action, overrides = {}) {
  return {
    action,
    scope: "project",
    category: "General",
    tags: [],
    limit: 100,
    ...overrides,
  };
}

async function temporaryDirectory(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("markdown memory serializes concurrent session writers without losing either add", async (t) => {
  const workspace = await temporaryDirectory(t, "ares-memory-session-cas-");
  const ctx = context(workspace);

  await Promise.all([
    MemoryTool.call(input("add", { content: "First concurrent fact" }), ctx),
    MemoryTool.call(input("add", { content: "Second concurrent fact" }), ctx),
  ]);

  const listed = await MemoryTool.call(input("list"), ctx);
  assert.deepEqual(
    new Set(listed.output.items.map((item) => item.content)),
    new Set(["First concurrent fact", "Second concurrent fact"]),
  );
  const raw = await fs.readFile(path.join(workspace, ".ares", "memory.md"), "utf8");
  assert.equal(listed.output.version, memoryContentVersion(raw));
  await assert.rejects(fs.stat(path.join(workspace, ".ares", "memory.md.ares-lock")), /ENOENT/);
});

test("expectedVersion makes concurrent same-snapshot updates an explicit conflict", async (t) => {
  const workspace = await temporaryDirectory(t, "ares-memory-version-cas-");
  const ctx = context(workspace);
  const added = await MemoryTool.call(input("add", { content: "Original" }), ctx);
  const id = added.output.items[0].id;
  const version = added.output.version;

  const outcomes = await Promise.allSettled([
    MemoryTool.call(input("update", { id, content: "Writer A", expectedVersion: version }), ctx),
    MemoryTool.call(input("update", { id, content: "Writer B", expectedVersion: version }), ctx),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected);
  assert.ok(rejected.reason instanceof MemoryConflictError);
  assert.equal(rejected.reason.code, "MEMORY_CONFLICT");
  assert.equal(rejected.reason.expectedVersion, version);
  assert.notEqual(rejected.reason.actualVersion, version);

  const listed = await MemoryTool.call(input("list"), ctx);
  assert.equal(listed.output.items.length, 1);
  assert.ok(["Writer A", "Writer B"].includes(listed.output.items[0].content));
});

test("exact-byte CAS preserves a non-cooperating edit made after Memory reads", async (t) => {
  const workspace = await temporaryDirectory(t, "ares-memory-external-cas-");
  const ctx = context(workspace);
  const added = await MemoryTool.call(input("add", { category: "Preferences", content: "Original" }), ctx);
  const id = added.output.items[0].id;
  const memoryPath = path.join(workspace, ".ares", "memory.md");
  const external = [
    "# Ares Memory",
    "",
    "## Preferences",
    `- [${id}] Human edit <!-- updated=2026-08-01T00:00:00.000Z -->`,
    "",
  ].join("\n");
  const racingTool = makeMemoryTool({
    beforeCommit: async () => fs.writeFile(memoryPath, external, "utf8"),
  });

  await assert.rejects(
    racingTool.call(
      input("update", { id, category: "Preferences", content: "Ares edit", expectedVersion: added.output.version }),
      ctx,
    ),
    (error) => {
      assert.ok(error instanceof MemoryConflictError);
      assert.equal(error.actualVersion, memoryContentVersion(external));
      return true;
    },
  );
  assert.equal(await fs.readFile(memoryPath, "utf8"), external);
});

test("user markdown memory commits directly under ARES_HOME with the same version contract", async (t) => {
  const root = await temporaryDirectory(t, "ares-user-memory-cas-");
  const workspace = path.join(root, "arbitrary-workspace");
  const home = path.join(root, "durable-home");
  await fs.mkdir(workspace);
  const previousHome = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = previousHome;
  });

  const result = await MemoryTool.call(
    input("add", { scope: "user", content: "Owner-wide preference" }),
    context(workspace),
  );
  const target = path.join(home, "memory.md");
  const raw = await fs.readFile(target, "utf8");
  assert.equal(result.output.path, target);
  assert.equal(result.output.version, memoryContentVersion(raw));
  assert.match(raw, /Owner-wide preference/);
  await assert.rejects(fs.stat(path.join(workspace, ".ares", "memory.md")), /ENOENT/);
});

test("a stale ownerless memory lease is quarantined and recovered", async (t) => {
  const workspace = await temporaryDirectory(t, "ares-memory-stale-lock-");
  const lock = path.join(workspace, ".ares", "memory.md.ares-lock");
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, "malformed abandoned lease\n", "utf8");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lock, old, old);

  const tool = makeMemoryTool({ lockStaleMs: 1_000, lockTimeoutMs: 1_000 });
  const listed = await tool.call(input("list"), context(workspace));
  assert.equal(listed.output.version, memoryContentVersion(""));
  await assert.rejects(fs.stat(lock), /ENOENT/);
});

test("cooperating writers in separate processes share the same durable memory lease", { timeout: 20_000 }, async (t) => {
  const root = await temporaryDirectory(t, "ares-memory-process-lock-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const firstReady = path.join(root, "first.ready");
  const secondReady = path.join(root, "second.ready");
  const release = path.join(root, "release");
  const toolsUrl = pathToFileURL(path.resolve("packages/tools/dist/index.js")).href;
  const childScript = `
    import { promises as fs } from "node:fs";
    import { makeMemoryTool } from ${JSON.stringify(toolsUrl)};
    const [role, workspace, ready, release] = process.argv.slice(1);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const exists = async (file) => fs.stat(file).then(() => true, () => false);
    const tool = makeMemoryTool(role === "first" ? {
      beforeCommit: async () => {
        await fs.writeFile(ready, "ready");
        while (!(await exists(release))) await wait(10);
      },
    } : {});
    if (role === "second") await fs.writeFile(ready, "ready");
    const result = await tool.call({
      action: "add", scope: "project", category: "General",
      content: role + " process fact", tags: [], limit: 20,
    }, {
      workspace, signal: new AbortController().signal,
      permissionMode: "workspace-write", fileReadStamps: new Map(),
    });
    process.stdout.write(result.output.version);
  `;

  const first = startChild(childScript, ["first", workspace, firstReady, release]);
  await waitForFile(firstReady);
  const second = startChild(childScript, ["second", workspace, secondReady, release]);
  await waitForFile(secondReady);
  await fs.writeFile(release, "release");
  await Promise.all([first.done, second.done]);

  const listed = await MemoryTool.call(input("list"), context(workspace));
  assert.deepEqual(
    new Set(listed.output.items.map((item) => item.content)),
    new Set(["first process fact", "second process fact"]),
  );
});

function startChild(script, args) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`memory child exited code=${code} signal=${signal}: ${stderr || stdout}`));
    });
  });
  return { child, done };
}

async function waitForFile(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await fs.stat(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}
