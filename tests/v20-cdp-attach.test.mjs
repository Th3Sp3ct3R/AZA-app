// Verifies the browser acquisition strategy order with CDP attach in front:
//   1. explicit CDP endpoint → attach to the user's real running browser
//   2. opt-in localhost discovery (gated; never grabs a random browser)
//   3-6. launch a persistent-profile browser (the existing fallback chain)
// The Playwright module is injected as a fake so ordering is provable with no
// real browser.

import test from "node:test";
import assert from "node:assert/strict";

import { acquireBrowserPage, parseCdpPorts } from "../packages/connectors/dist/index.js";

const fakePage = (tag) => ({ __tag: tag });
const fakeContext = (tag) => ({
  pages: () => [fakePage(tag)],
  newPage: async () => fakePage(`${tag}:new`),
  close: async () => {},
});
const fakeBrowser = (tag) => {
  let closed = false;
  return {
    contexts: () => [fakeContext(tag)],
    newContext: async () => fakeContext(`${tag}:new`),
    close: async () => { closed = true; },
    wasClosed: () => closed,
  };
};

/** A fake Playwright that records connect/launch calls and can be told to fail either. */
function fakePw({ cdp = "ok", launch = "ok" } = {}) {
  const calls = { connect: [], launch: [] };
  const browsers = [];
  const contexts = [];
  return {
    calls,
    browsers,
    contexts,
    chromium: {
      async connectOverCDP(url) {
        calls.connect.push(url);
        if (cdp === "fail") throw new Error("ECONNREFUSED");
        const b = fakeBrowser(`cdp:${url}`);
        browsers.push(b);
        return b;
      },
      async launchPersistentContext(dir, opts) {
        calls.launch.push({ dir, opts });
        if (launch === "fail") throw new Error("no executable");
        const c = fakeContext(`launch:${opts.channel ?? opts.executablePath ?? "bundled"}`);
        contexts.push(c);
        return c;
      },
    },
  };
}

const base = {
  executablePath: "C:/Edge/msedge.exe",
  headless: true,
  userDataDir: "/tmp/ares-profile",
  viewport: { width: 1280, height: 800 },
};

// ── 1. CDP URL present and connect succeeds → no launch attempt ────────────────

test("cdp: explicit URL that connects wins, and no browser is launched", async () => {
  const pw = fakePw({ cdp: "ok" });
  const acquired = await acquireBrowserPage(pw, { ...base, cdpUrl: "http://127.0.0.1:9222" });
  assert.equal(acquired.strategy, "cdp:http://127.0.0.1:9222");
  assert.deepEqual(pw.calls.connect, ["http://127.0.0.1:9222"]);
  assert.equal(pw.calls.launch.length, 0, "attach means NEVER launch a sterile browser");
});

test("cdp: close() on an attached browser disconnects, never kills the real one", async () => {
  const pw = fakePw({ cdp: "ok" });
  const acquired = await acquireBrowserPage(pw, { ...base, cdpUrl: "http://127.0.0.1:9222" });
  await acquired.close();
  assert.equal(pw.browsers[0].wasClosed(), true, "Playwright connection released (disconnect)");
});

// ── 2. CDP URL present and connect fails → falls back to the launch chain ──────

test("cdp: a configured-but-unreachable endpoint falls back to launching", async () => {
  const pw = fakePw({ cdp: "fail", launch: "ok" });
  const acquired = await acquireBrowserPage(pw, { ...base, cdpUrl: "http://127.0.0.1:9222" });
  assert.deepEqual(pw.calls.connect, ["http://127.0.0.1:9222"], "it tried the endpoint");
  assert.match(acquired.strategy, /^launch:/, "then fell back to launching");
  assert.ok(pw.calls.launch.length >= 1);
});

test("handshake: attach-only failure never launches a replacement browser", async () => {
  const pw = fakePw({ cdp: "fail", launch: "ok" });
  await assert.rejects(
    () => acquireBrowserPage(pw, { ...base, cdpUrl: "http://127.0.0.1:9222", requireCdp: true }),
    /BROWSER_ATTACH_UNAVAILABLE/,
  );
  assert.deepEqual(pw.calls.connect, ["http://127.0.0.1:9222"]);
  assert.equal(pw.calls.launch.length, 0, "an attach handshake must never substitute a different browser");
});

// ── 3. No CDP URL → current behavior unchanged (no connect, straight to launch) ─

test("no cdp: behavior is unchanged — straight to the launch chain, no connect", async () => {
  const pw = fakePw();
  const acquired = await acquireBrowserPage(pw, { ...base });
  assert.equal(pw.calls.connect.length, 0, "no CDP probing without configuration");
  assert.match(acquired.strategy, /^launch:executable:/, "detected exe is first launch attempt");
});

// ── Discovery is gated (the no-creepy-cousin rule) ────────────────────────────

test("discovery: OFF by default — no localhost probing without the flag", async () => {
  const pw = fakePw();
  await acquireBrowserPage(pw, { ...base }); // discovery undefined/false
  assert.equal(pw.calls.connect.length, 0, "Ares never grabs a random open browser on its own");
});

test("discovery: ON probes the configured ports in order, before launching", async () => {
  const pw = fakePw({ cdp: "fail" }); // probes fail so we can see all attempts
  await acquireBrowserPage(pw, { ...base, discovery: true, discoveryPorts: [9222, 9333] });
  assert.deepEqual(pw.calls.connect, ["http://127.0.0.1:9222", "http://127.0.0.1:9333"]);
});

test("discovery: an explicit URL is tried before discovered ports", async () => {
  const pw = fakePw({ cdp: "fail" });
  await acquireBrowserPage(pw, { ...base, cdpUrl: "http://host:1234", discovery: true, discoveryPorts: [9222] });
  assert.deepEqual(pw.calls.connect, ["http://host:1234", "http://127.0.0.1:9222"]);
});

// ── parseCdpPorts ─────────────────────────────────────────────────────────────

test("parseCdpPorts: parses a csv list, ignores junk, undefined when empty", () => {
  assert.deepEqual(parseCdpPorts("9222, 9223"), [9222, 9223]);
  assert.deepEqual(parseCdpPorts("9222,nonsense,70000,-1"), [9222]);
  assert.equal(parseCdpPorts(""), undefined);
  assert.equal(parseCdpPorts(undefined), undefined);
});

// ── Total failure surfaces a clear error ──────────────────────────────────────

test("acquire: everything failing throws a clear BROWSER_UNAVAILABLE", async () => {
  const pw = fakePw({ cdp: "fail", launch: "fail" });
  await assert.rejects(
    () => acquireBrowserPage(pw, { ...base, cdpUrl: "http://127.0.0.1:9222" }),
    /BROWSER_UNAVAILABLE/,
  );
});
