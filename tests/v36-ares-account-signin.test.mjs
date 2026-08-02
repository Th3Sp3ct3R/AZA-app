// Ares-account sign-in (click-to-connect, code-exchange OAuth-lite over loopback).
// Locks the contract that lets the harness connect to the account with NO token
// paste: authorize URL shape, state handling, server-to-server code exchange,
// and the capability probe that gates the UI button. Network + loopback are
// injected, so nothing real is contacted.

import test from "node:test";
import assert from "node:assert/strict";

import {
  runAresAccountSignin,
  buildAresAuthorizeUrl,
  exchangeAresCode,
  probeAresOauth,
  normalizeGatewayBase,
  captureLoopbackCode,
} from "../packages/core/dist/index.js";

const BASE = "https://www.doingteam.com";

function fakeFetch(routes) {
  return async (url, init) => {
    const u = String(url);
    for (const r of routes) {
      if (u.includes(r.match)) {
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => r.json ?? {},
          text: async () => r.text ?? "",
        };
      }
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

// ── URL + normalization ──────────────────────────────────────────────────────

test("buildAresAuthorizeUrl: points at /account/connect with redirect + state", () => {
  const url = buildAresAuthorizeUrl(BASE, "http://127.0.0.1:53691/oauth/callback", "abc123", {
    codeChallenge: "challenge-123",
    deviceName: "Ares desktop",
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://www.doingteam.com/account/connect");
  assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:53691/oauth/callback");
  assert.equal(u.searchParams.get("state"), "abc123");
  assert.equal(u.searchParams.get("code_challenge"), "challenge-123");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("device_name"), "Ares desktop");
});

test("normalizeGatewayBase: apex → www, trailing slash stripped", () => {
  assert.equal(normalizeGatewayBase("https://doingteam.com/"), "https://www.doingteam.com");
  assert.equal(normalizeGatewayBase("https://www.doingteam.com//"), "https://www.doingteam.com");
});

// ── Code exchange (server-to-server) ─────────────────────────────────────────

test("exchangeAresCode: POSTs the code and returns the token", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ token: "ares_live_tok" }), text: async () => "" };
  };
  const token = await exchangeAresCode(BASE, "the-code", {
    codeVerifier: "verifier",
    redirectUri: "http://127.0.0.1:53691/oauth/callback",
    deviceName: "My Ares",
    fetchImpl,
  });
  assert.equal(token, "ares_live_tok");
  assert.match(seen.url, /\/api\/gateway\/v1\/oauth\/exchange$/);
  assert.equal(seen.body.code, "the-code");
  assert.equal(seen.body.code_verifier, "verifier");
  assert.equal(seen.body.redirect_uri, "http://127.0.0.1:53691/oauth/callback");
  assert.equal(seen.body.device_name, "My Ares");
});

test("exchangeAresCode: a non-2xx exchange throws a clear error", async () => {
  const fetchImpl = fakeFetch([{ match: "/oauth/exchange", status: 401, text: "bad code" }]);
  await assert.rejects(() => exchangeAresCode(BASE, "x", fetchImpl), /token exchange failed \(401\)/);
});

test("exchangeAresCode: a response with no token throws", async () => {
  const fetchImpl = fakeFetch([{ match: "/oauth/exchange", json: {} }]);
  await assert.rejects(() => exchangeAresCode(BASE, "x", fetchImpl), /no token/);
});

// ── Capability probe (gates the UI button) ───────────────────────────────────

test("probeAresOauth: true only when the gateway advertises enabled:true", async () => {
  assert.equal(await probeAresOauth(BASE, fakeFetch([{ match: "/oauth/config", json: { enabled: true } }])), true);
  assert.equal(await probeAresOauth(BASE, fakeFetch([{ match: "/oauth/config", json: { enabled: false } }])), false);
  assert.equal(await probeAresOauth(BASE, fakeFetch([{ match: "/oauth/config", status: 404 }])), false);
  // Endpoint doesn't exist yet (network throw) → false, button stays hidden.
  assert.equal(await probeAresOauth(BASE, async () => { throw new Error("ENOTFOUND"); }), false);
});

// ── Full flow with injected capture + fetch ──────────────────────────────────

test("runAresAccountSignin: authorize → capture code → exchange → token", async () => {
  let authorizeUrl = null;
  let capturedArgs = null;
  const token = await runAresAccountSignin(BASE, {
    onAuthorizeUrl: (u) => { authorizeUrl = u; },
    captureCode: async (redirectUri, state, port) => {
      capturedArgs = { redirectUri, state, port };
      return "code-xyz";
    },
    deviceName: "Studio PC",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.device_name, "Studio PC");
      assert.equal(body.redirect_uri, "http://127.0.0.1:53691/oauth/callback");
      assert.ok(body.code_verifier.length >= 43);
      return { ok: true, status: 200, json: async () => ({ token: "ares_from_flow" }), text: async () => "" };
    },
  });

  assert.equal(token.token, "ares_from_flow");
  assert.equal(token.base, "https://www.doingteam.com");
  // The authorize URL carried the SAME state the capture validated against.
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.equal(capturedArgs.state, state);
  assert.equal(capturedArgs.redirectUri, "http://127.0.0.1:53691/oauth/callback");
  const auth = new URL(authorizeUrl);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("device_name"), "Studio PC");
  assert.ok(auth.searchParams.get("code_challenge"));
});

test("runAresAccountSignin: a capture failure (denied/timeout) propagates", async () => {
  await assert.rejects(
    () => runAresAccountSignin(BASE, {
      captureCode: async () => { throw new Error("sign-in was denied: access_denied"); },
      fetchImpl: fakeFetch([]),
    }),
    /access_denied/,
  );
});

// ── Real loopback server: the security-relevant state check over a socket ─────

const PORT = 53699; // off the default 53691 to avoid clashes
const REDIRECT = `http://127.0.0.1:${PORT}/oauth/callback`;

test("captureLoopbackCode: resolves the code when state matches", async () => {
  const p = captureLoopbackCode(REDIRECT, "st8", PORT, 5000);
  // Hit the callback the way the browser redirect would.
  const res = await fetch(`http://127.0.0.1:${PORT}/oauth/callback?code=good-code&state=st8`);
  await res.text();
  assert.equal(await p, "good-code");
});

test("captureLoopbackCode: rejects a state mismatch (CSRF guard)", async () => {
  const p = captureLoopbackCode(REDIRECT, "expected", PORT, 5000);
  // Attach the rejection handler BEFORE firing the request so the (synchronous)
  // rejection on callback isn't briefly unhandled.
  const rejection = assert.rejects(() => p, /state mismatch/);
  const res = await fetch(`http://127.0.0.1:${PORT}/oauth/callback?code=x&state=forged`);
  await res.text();
  await rejection;
});
