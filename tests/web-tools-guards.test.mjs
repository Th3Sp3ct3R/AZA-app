// WebFetch SSRF-gate loopback semantics + WebSearch fallback-chain semantics.
//
// Field origin (2026-08-02 session review):
//  - WebFetch refused 127.0.0.1, blocking the owner's own dev-server probe —
//    the core coding verify loop. Explicit loopback is now allowed; covert
//    loopback (public host resolving/redirecting onto it) stays blocked.
//  - A keyless setup surfaced "SearXNG: no instance URL" as a tool error
//    whenever the DuckDuckGo scrape found nothing: unconfigured backends were
//    held as the chain's error instead of being skipped.

import test from "node:test";
import assert from "node:assert/strict";

import { assertPublicHost, withFallback } from "../packages/tools/dist/index.js";

// ── WebFetch: assertPublicHost ────────────────────────────────────────────────

test("explicit loopback is allowed for the owner's own dev server", async () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "::1"]) {
    const r = await assertPublicHost(host, { allowLoopback: true });
    assert.equal(r.ok, true, `${host} should be allowed with allowLoopback`);
  }
});

test("loopback is refused when allowLoopback is not granted (redirect posture)", async () => {
  for (const host of ["localhost", "127.0.0.1", "::1"]) {
    const r = await assertPublicHost(host, {});
    assert.equal(r.ok, false, `${host} must be blocked without allowLoopback`);
  }
});

test("LAN, CGNAT, and metadata ranges stay blocked even with allowLoopback", async () => {
  for (const host of ["10.0.0.5", "192.168.1.20", "172.16.9.9", "169.254.169.254", "100.64.0.1"]) {
    const r = await assertPublicHost(host, { allowLoopback: true });
    assert.equal(r.ok, false, `${host} must stay blocked — allowLoopback is loopback-only`);
  }
});

test("internal-suffix hostnames stay blocked", async () => {
  for (const host of ["gateway.internal", "printer.local"]) {
    const r = await assertPublicHost(host, { allowLoopback: true });
    assert.equal(r.ok, false, `${host} must stay blocked`);
  }
});

// ── WebSearch: withFallback ───────────────────────────────────────────────────

const unconfigured = (name, message) => ({
  name,
  async search() {
    throw new Error(message);
  },
});

test("unconfigured backends are skipped — zero results from a live backend is the answer", async () => {
  const chain = withFallback([
    unconfigured("Brave", "Brave search: no API key"),
    unconfigured("SearXNG", "SearXNG: no instance URL"),
    { name: "DDG", async search() { return []; } },
  ]);
  const results = await chain.search("anything", new AbortController().signal);
  assert.deepEqual(results, []);
});

test("a real backend failure is reported, not the config fast-fail", async () => {
  const chain = withFallback([
    unconfigured("SearXNG", "SearXNG: no instance URL"),
    { name: "DDG", async search() { throw new Error("DDG returned 503"); } },
  ]);
  await assert.rejects(
    () => chain.search("anything", new AbortController().signal),
    /DDG returned 503/,
  );
});

test("nothing configured at all yields an actionable configuration error", async () => {
  const chain = withFallback([
    unconfigured("Brave", "Brave search: no API key"),
    unconfigured("SearXNG", "SearXNG: no instance URL"),
  ]);
  await assert.rejects(
    () => chain.search("anything", new AbortController().signal),
    /No search backend is configured.*Brave.*SearXNG/s,
  );
});

test("first backend with results wins without touching later backends", async () => {
  let ddgCalled = false;
  const chain = withFallback([
    { name: "Brave", async search() { return [{ title: "hit", url: "https://x.example", snippet: "s" }]; } },
    { name: "DDG", async search() { ddgCalled = true; return []; } },
  ]);
  const results = await chain.search("anything", new AbortController().signal);
  assert.equal(results.length, 1);
  assert.equal(ddgCalled, false);
});
