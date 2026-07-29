import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBrowserTool } from "../packages/cli/dist/entry/browserBridge.js";
import { cliRuntimeContext } from "../packages/cli/dist/entry/runtime.js";

test("Browser tool reacquires a connector after its page is closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-browser-recovery-"));
  let creations = 0;
  let firstClosed = false;
  let closeCalls = 0;
  const createBrowser = async () => {
    creations++;
    const mine = creations;
    return {
      name: "fake",
      async state() {
        if (mine === 1 && firstClosed) throw new Error("Target page, context or browser has been closed");
        return { url: mine === 1 ? "https://first.test" : "https://recovered.test", title: mine === 1 ? "first" : "recovered" };
      },
      async close() { closeCalls++; },
      async navigate(url) { return { url, title: "fake" }; },
      async accessibilityTree() { return []; },
      async fillByLabel() {},
      async clickByRole() {},
      async screenshot() { return { format: "png", bytes: "" }; },
    };
  };
  const tool = makeBrowserTool({ browserFilmstripRoot: root }, createBrowser);
  const ctx = { signal: new AbortController().signal };
  try {
    const first = await tool.call({ action: "state" }, ctx);
    assert.equal(first.output.result.url, "https://first.test");
    firstClosed = true;
    const recovered = await tool.call({ action: "state" }, ctx);
    assert.equal(recovered.output.result.url, "https://recovered.test");
    assert.equal(creations, 2);
    assert.equal(closeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Browser handshake reports the exact CDP attachment and open tabs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-browser-handshake-"));
  const calls = [];
  const browser = {
    name: "fake",
    strategy: "cdp:http://127.0.0.1:9222",
    async state() { return { url: "https://example.test", title: "Existing tab" }; },
    async tabs() { return [{ index: 0, url: "https://example.test", title: "Existing tab", active: true }]; },
    async close() {},
    async navigate(url) { return { url, title: "Existing tab" }; },
    async accessibilityTree() { return []; },
    async fillByLabel() {},
    async clickByRole() {},
    async screenshot() { return { format: "png", bytes: "" }; },
  };
  const tool = makeBrowserTool({ browserFilmstripRoot: root }, async (opts) => {
    calls.push(opts);
    return browser;
  });
  try {
    const result = await tool.call(
      { action: "handshake", url: "http://127.0.0.1:9222" },
      { signal: new AbortController().signal },
    );
    assert.equal(result.output.status, "attached");
    assert.equal(result.output.browserStrategy, "cdp:http://127.0.0.1:9222");
    assert.equal(result.output.result.tabs.length, 1);
    assert.equal(calls[0].attachOnly, true);
    assert.equal(calls[0].cdpUrl, "http://127.0.0.1:9222");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Browser act batches a multi-control job and verifies only the final state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-browser-act-"));
  const previousHome = process.env.ARES_HOME;
  process.env.ARES_HOME = root;
  const calls = [];
  let url = "https://x.com/home";
  const browser = {
    name: "fake",
    async state() { return { url, title: "Profile" }; },
    async close() {},
    async attachToExisting(query) { calls.push(["attach", query]); return true; },
    async navigate(next) { calls.push(["open", next]); url = next; return { url, title: "Profile" }; },
    async accessibilityTree() { return []; },
    async fillByLabel(label, value) { calls.push(["fill", label, value]); },
    async clickByRole(role, name) { calls.push(["click", role, name]); },
    async screenshot() { calls.push(["screenshot"]); return { format: "png", bytes: "AA==" }; },
  };
  const tool = makeBrowserTool(cliRuntimeContext({ workspace: root, home: root }), async () => browser);
  const ctx = { signal: new AbortController().signal, requestPermission: async () => "allow_once" };
  try {
    const result = await tool.call({
      action: "act",
      steps: [
        { action: "open", url: "https://x.com/example" },
        { action: "click", role: "button", name: "Edit profile" },
        { action: "fill", label: "Bio", value: "Ares" },
        { action: "click", role: "button", name: "Save" },
      ],
    }, ctx);
    assert.equal(result.output.status, "committed");
    assert.equal(result.output.result.completed.length, 4);
    assert.equal(result.images.length, 1);
    assert.deepEqual(calls, [
      ["attach", "https://x.com/example"],
      ["open", "https://x.com/example"],
      ["click", "button", "Edit profile"],
      ["fill", "Bio", "Ares"],
      ["click", "button", "Save"],
      ["screenshot"],
    ]);
    const callCount = calls.length;
    const duplicate = await tool.call({
      action: "act",
      steps: [
        { action: "open", url: "https://x.com/example" },
        { action: "click", role: "button", name: "Edit profile" },
        { action: "fill", label: "Bio", value: "Ares" },
        { action: "click", role: "button", name: "Save" },
      ],
    }, ctx);
    assert.equal(duplicate.output.status, "duplicate_suppressed");
    assert.match(duplicate.output.note, /^ACTION NOT PERFORMED/);
    assert.equal(calls.length, callCount, "suppressed duplicate performs no browser actions");
  } finally {
    if (previousHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Browser click uses the live turn permission prompt and commits only after approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-browser-approval-"));
  const previousHome = process.env.ARES_HOME;
  process.env.ARES_HOME = root;
  let clicks = 0;
  const permissionRequests = [];
  const browser = {
    name: "fake",
    strategy: "cdp:http://127.0.0.1:9222",
    async state() { return { url: "https://x.com/example", title: "Post" }; },
    async close() {},
    async navigate(url) { return { url, title: "Post" }; },
    async accessibilityTree() { return []; },
    async fillByLabel() {},
    async clickByRole() { clicks++; },
    async screenshot() { return { format: "png", bytes: "AA==" }; },
  };
  const tool = makeBrowserTool(cliRuntimeContext({ workspace: root, home: root }), async () => browser);
  try {
    const result = await tool.call(
      { action: "click", role: "button", name: "Reply" },
      {
        workspace: root,
        signal: new AbortController().signal,
        async requestPermission(request) {
          permissionRequests.push(request);
          return "allow_once";
        },
      },
    );
    assert.equal(result.output.status, "committed");
    assert.equal(result.output.note, undefined);
    assert.equal(clicks, 1);
    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].toolName, "Browser");
    assert.match(permissionRequests[0].reason, /browser\.click/);
    const duplicate = await tool.call(
      { action: "click", role: "button", name: "Reply" },
      { workspace: root, signal: new AbortController().signal, async requestPermission() { return "allow_once"; } },
    );
    assert.equal(duplicate.output.status, "duplicate_suppressed");
    assert.equal(clicks, 1, "duplicate guard prevents a second outward click");
  } finally {
    if (previousHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Browser click reports an unmistakable non-action when the owner denies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-browser-denial-"));
  const previousHome = process.env.ARES_HOME;
  process.env.ARES_HOME = root;
  let clicks = 0;
  const browser = {
    name: "fake",
    async state() { return { url: "https://x.com/example", title: "Post" }; },
    async close() {},
    async navigate(url) { return { url, title: "Post" }; },
    async accessibilityTree() { return []; },
    async fillByLabel() {},
    async clickByRole() { clicks++; },
    async screenshot() { return { format: "png", bytes: "AA==" }; },
  };
  const tool = makeBrowserTool(cliRuntimeContext({ workspace: root, home: root }), async () => browser);
  try {
    const result = await tool.call(
      { action: "click", role: "button", name: "Reply" },
      {
        workspace: root,
        signal: new AbortController().signal,
        async requestPermission() { return "deny"; },
      },
    );
    assert.equal(result.output.status, "denied");
    assert.equal(clicks, 0);
    assert.match(result.output.note, /^ACTION NOT PERFORMED/);
  } finally {
    if (previousHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
