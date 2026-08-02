// Kimi OAuth — the native RFC 8628 device flow that replaced the removed
// embedded engine's token store.
//
// Everything here drives an INJECTED fetch and an ARES_HOME pointed at a temp
// dir, so no test ever touches the owner's real ~/.ares/kimi-auth.json or the
// network. The flow's two load-bearing behaviours are the ones a real sign-in
// depends on: `authorization_pending` must keep polling rather than throw, and
// a near-expiry token must refresh BEFORE it is handed to a provider — an
// expired credential mid-turn is exactly the failure this owns.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  requestKimiDeviceAuthorization,
  pollKimiDeviceToken,
  runKimiLoginFlow,
  resolveKimiTokens,
  resolveKimiAccessToken,
  saveKimiTokens,
  kimiAuthStatus,
  kimiAuthFilePath,
  fetchKimiModels,
} from "../packages/core/dist/index.js";

/** Builds a fetch stand-in that replays a scripted queue of JSON responses. */
function scriptedFetch(steps) {
  const calls = [];
  const queue = [...steps];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : "" });
    const next = queue.shift() ?? { ok: false, body: { error: "no_more_steps" } };
    return {
      ok: next.ok !== false,
      status: next.status ?? (next.ok === false ? 400 : 200),
      json: async () => next.body,
    };
  };
  impl.calls = calls;
  return impl;
}

async function withTempHome(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ares-kimi-"));
  const priorHome = process.env.ARES_HOME;
  const priorToken = process.env.ARES_KIMI_OAUTH_TOKEN;
  process.env.ARES_HOME = dir;
  delete process.env.ARES_KIMI_OAUTH_TOKEN;
  try {
    await run(dir);
  } finally {
    if (priorHome === undefined) delete process.env.ARES_HOME; else process.env.ARES_HOME = priorHome;
    if (priorToken === undefined) delete process.env.ARES_KIMI_OAUTH_TOKEN; else process.env.ARES_KIMI_OAUTH_TOKEN = priorToken;
    await rm(dir, { recursive: true, force: true });
  }
}

test("device authorization returns the code and the URL the human visits", async () => {
  const fetchImpl = scriptedFetch([{
    body: {
      device_code: "dev-123", user_code: "WXYZ-7788",
      verification_uri: "https://auth.kimi.com/device",
      verification_uri_complete: "https://auth.kimi.com/device?user_code=WXYZ-7788",
      interval: 3, expires_in: 600,
    },
  }]);
  const auth = await requestKimiDeviceAuthorization(fetchImpl);
  assert.equal(auth.deviceCode, "dev-123");
  assert.equal(auth.userCode, "WXYZ-7788");
  assert.equal(auth.verificationUriComplete, "https://auth.kimi.com/device?user_code=WXYZ-7788");
  assert.equal(auth.intervalSeconds, 3);
  assert.match(fetchImpl.calls[0].url, /\/api\/oauth\/device_authorization$/);
  assert.match(fetchImpl.calls[0].body, /client_id=/);
});

test("polling distinguishes pending, slow_down, success and hard failure", async () => {
  const pending = await pollKimiDeviceToken("d", scriptedFetch([{ ok: false, body: { error: "authorization_pending" } }]));
  assert.equal(pending.state, "pending");

  const slow = await pollKimiDeviceToken("d", scriptedFetch([{ ok: false, body: { error: "slow_down" } }]));
  assert.equal(slow.state, "slow_down");

  const denied = await pollKimiDeviceToken("d", scriptedFetch([{ ok: false, body: { error: "access_denied" } }]));
  assert.equal(denied.state, "failed");

  const ready = await pollKimiDeviceToken("d", scriptedFetch([{
    body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "coding" },
  }]));
  assert.equal(ready.state, "ready");
  assert.equal(ready.tokens.accessToken, "at-1");
});

test("the full login flow polls through pending and persists the tokens", async () => {
  await withTempHome(async () => {
    const fetchImpl = scriptedFetch([
      { body: { device_code: "dev-9", user_code: "AAAA-1111", verification_uri: "https://auth.kimi.com/device", interval: 0.01, expires_in: 600 } },
      { ok: false, body: { error: "authorization_pending" } },
      { body: { access_token: "at-final", refresh_token: "rt-final", expires_in: 7200, scope: "coding" } },
    ]);
    let announced = null;
    const tokens = await runKimiLoginFlow({ force: true, fetchImpl, onAuthorize: (a) => { announced = a; } });

    assert.equal(tokens.accessToken, "at-final");
    assert.equal(announced.userCode, "AAAA-1111", "the host must get the code to render before polling");

    const onDisk = JSON.parse(await readFile(kimiAuthFilePath(), "utf8"));
    assert.equal(onDisk.refreshToken, "rt-final");
    assert.ok(onDisk.expiresAt > Date.now(), "expiry must be stored as absolute epoch ms");
  });
});

test("a near-expiry token refreshes before it is handed out", async () => {
  await withTempHome(async () => {
    // Inside the 5-minute skew, so a read must renew rather than return it.
    await saveKimiTokens({ accessToken: "stale", refreshToken: "rt-old", expiresAt: Date.now() + 60_000, scope: "coding" });
    const fetchImpl = scriptedFetch([
      { body: { access_token: "fresh", refresh_token: "rt-new", expires_in: 3600, scope: "coding" } },
    ]);
    const resolved = await resolveKimiTokens(fetchImpl);
    assert.equal(resolved.accessToken, "fresh");
    assert.match(fetchImpl.calls[0].body, /grant_type=refresh_token/);

    const onDisk = JSON.parse(await readFile(kimiAuthFilePath(), "utf8"));
    assert.equal(onDisk.accessToken, "fresh", "the refreshed token must be written back");
  });
});

test("a comfortably valid token is returned without a network call", async () => {
  await withTempHome(async () => {
    await saveKimiTokens({ accessToken: "good", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, scope: "coding" });
    const fetchImpl = scriptedFetch([]);
    assert.equal((await resolveKimiTokens(fetchImpl)).accessToken, "good");
    assert.equal(fetchImpl.calls.length, 0, "a valid token must not hit the network");
  });
});

test("the env override wins and never reads the token store", async () => {
  await withTempHome(async () => {
    process.env.ARES_KIMI_OAUTH_TOKEN = "ci-token";
    assert.equal(await resolveKimiAccessToken(scriptedFetch([])), "ci-token");
    const status = await kimiAuthStatus();
    assert.equal(status.connected, true);
    assert.equal(status.source, "env:ARES_KIMI_OAUTH_TOKEN");
  });
});

test("signed out reports disconnected rather than throwing", async () => {
  await withTempHome(async () => {
    assert.equal(await resolveKimiAccessToken(scriptedFetch([])), null);
    const status = await kimiAuthStatus();
    assert.equal(status.connected, false);
    assert.equal(status.source, "none");
  });
});

test("model discovery maps the OpenAI-compatible roster and degrades to null", async () => {
  await withTempHome(async () => {
    const ok = scriptedFetch([{
      body: { data: [
        { id: "kimi-for-coding", context_length: 262144, thinking_type: "yes" },
        { id: "kimi-for-coding-highspeed", context_length: 131072, thinking_type: "no" },
      ] },
    }]);
    const models = await fetchKimiModels("api-key", ok);
    assert.equal(models.length, 2);
    assert.equal(models[0].supportsReasoning, true);
    assert.equal(models[1].supportsReasoning, false);
    assert.equal(models[1].contextLength, 131072);
    assert.match(ok.calls[0].url, /\/models$/);

    // No credential at all → null, so the picker falls back to its static row.
    assert.equal(await fetchKimiModels(undefined, scriptedFetch([])), null);
  });
});
