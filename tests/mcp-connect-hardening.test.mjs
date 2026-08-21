// MCP connect orchestration — first end-to-end coverage of the layer that had
// none. A single local HTTP server plays MCP endpoint + authorization server
// (RFC 9728 discovery → RFC 7591 registration → PKCE code exchange), and the
// "browser" is a fetch against the loopback callback. Pins:
//  1. The full happy path: connect → tokens in the VAULT (never in
//     mcp-remote.json) → post-connect tools/list VERIFICATION populates
//     toolCount/verified.
//  2. Reconnect preserves owner state (enabled:false pause, custom
//     displayName, headers) instead of wiping it.
//  3. setMcpServerToken (API-key connectors): pasted token lands in the vault
//     as a static bundle, resolves via getMcpAccessToken, never plaintext on
//     disk; a server that rejects the token yields verified:false (soft-fail,
//     tokens still stored).
//  4. Loopback port fallback: a squatter on the preferred port doesn't kill
//     the flow — the redirect URI carries the port actually bound.
//  5. Disconnect deletes the vault bundle.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  connectMcpServer,
  disconnectMcpServer,
  setMcpServerToken,
  getMcpAccessToken,
  getMcpCallCredentials,
  loadRemoteMcpServers,
} from "../packages/core/dist/index.js";

async function tmpHome() {
  return mkdtemp(path.join(tmpdir(), "ares-mcpconn-"));
}

/** One server that plays MCP endpoint AND authorization server. */
function fakeMcpWorld({ rejectBearer = false, toolCount = 2 } = {}) {
  const state = { issuedCode: "code-abc", accessToken: "tok-live-123", lastAuthQuery: null };
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const json = (body, status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const origin = `http://${req.headers.host}`;
    if (u.pathname === "/.well-known/oauth-protected-resource") {
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      });
    }
    if (u.pathname === "/register" && req.method === "POST") {
      return json({ client_id: "client-1" });
    }
    if (u.pathname === "/token" && req.method === "POST") {
      return json({ access_token: state.accessToken, refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" });
    }
    if (u.pathname === "/mcp" && req.method === "POST") {
      const auth = req.headers.authorization ?? "";
      if (rejectBearer || !auth.startsWith("Bearer ")) {
        return json({ error: "unauthorized" }, 401);
      }
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const rpc = JSON.parse(body || "{}");
        if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: rpc.id, result: {} }, 200, { "mcp-session-id": "sess-1" });
        if (rpc.method === "tools/list") {
          return json({ jsonrpc: "2.0", id: rpc.id, result: { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool${i}` })) } });
        }
        return json({ jsonrpc: "2.0", id: rpc.id, result: {} });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    state,
    start: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Drive the "browser": pull code+state out of the authorize URL and hit the
 *  loopback callback the way a redirect would. */
function browserApproves(authorizeUrl) {
  const u = new URL(authorizeUrl);
  const redirect = new URL(u.searchParams.get("redirect_uri"));
  redirect.searchParams.set("code", "code-abc");
  redirect.searchParams.set("state", u.searchParams.get("state"));
  return fetch(redirect).then((r) => r.text());
}

test("full connect: vault tokens, secret-free disk entry, verified toolCount", async () => {
  const home = await tmpHome();
  const world = fakeMcpWorld({ toolCount: 3 });
  try {
    const port = await world.start();
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    let authorizeUrl = "";
    const result = await connectMcpServer(mcpUrl, {
      name: "fakeco",
      home,
      port: 0, // ephemeral loopback for the callback
      timeoutMs: 15_000,
      onAuthorizeUrl: (u) => {
        authorizeUrl = u;
        void browserApproves(u);
      },
    });
    assert.equal(result.name, "fakeco");
    assert.equal(result.verified, true);
    assert.equal(result.toolCount, 3);
    assert.ok(authorizeUrl.includes("code_challenge="));

    // The on-disk entry never holds the token; the vault resolves it.
    const raw = await readFile(path.join(home, "mcp-remote.json"), "utf8");
    assert.ok(!raw.includes("tok-live-123"), "access token must not be on disk in mcp-remote.json");
    assert.equal((await loadRemoteMcpServers(home)).fakeco.oauth, true);
    assert.equal(await getMcpAccessToken("fakeco", home), "tok-live-123");

    // Disconnect deletes the vault bundle.
    assert.equal(await disconnectMcpServer("fakeco", home), true);
    assert.equal(await getMcpAccessToken("fakeco", home), null);
  } finally {
    await world.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("reconnect preserves pause state, display name and headers", async () => {
  const home = await tmpHome();
  const world = fakeMcpWorld();
  try {
    const port = await world.start();
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    await mkdir(home, { recursive: true });
    await writeFile(
      path.join(home, "mcp-remote.json"),
      JSON.stringify({
        servers: { fakeco: { url: mcpUrl, oauth: true, enabled: false, displayName: "Custom Name", headers: { "x-extra": "1" } } },
      }) + "\n",
      "utf8",
    );
    await connectMcpServer(mcpUrl, {
      name: "fakeco",
      home,
      port: 0,
      timeoutMs: 15_000,
      onAuthorizeUrl: (u) => void browserApproves(u),
    });
    const entry = (await loadRemoteMcpServers(home)).fakeco;
    assert.equal(entry.enabled, false, "a paused connector must stay paused across re-auth");
    assert.equal(entry.displayName, "Custom Name");
    // Headers moved into the encrypted vault (they routinely carry API keys);
    // they must survive re-auth there and never sit plaintext on disk again.
    assert.equal(entry.headers, undefined, "custom headers no longer live on disk");
    const creds = await getMcpCallCredentials("fakeco", home);
    assert.deepEqual(creds.headers, { "x-extra": "1" }, "custom headers survive re-auth in the vault");
  } finally {
    await world.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("port fallback: a busy preferred port falls back and the flow completes", async () => {
  const home = await tmpHome();
  const world = fakeMcpWorld();
  const squatter = createServer(() => {});
  try {
    const port = await world.start();
    const busyPort = await new Promise((resolve) => squatter.listen(0, "127.0.0.1", () => resolve(squatter.address().port)));
    let redirectPort = null;
    const result = await connectMcpServer(`http://127.0.0.1:${port}/mcp`, {
      name: "fallbackco",
      home,
      port: busyPort,
      timeoutMs: 15_000,
      onAuthorizeUrl: (u) => {
        redirectPort = Number(new URL(new URL(u).searchParams.get("redirect_uri")).port);
        void browserApproves(u);
      },
    });
    assert.equal(result.verified, true);
    assert.ok(redirectPort && redirectPort !== busyPort, `redirect port ${redirectPort} must differ from busy ${busyPort}`);
  } finally {
    await new Promise((resolve) => squatter.close(() => resolve()));
    await world.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("setMcpServerToken: vault-held static token, verified, never on disk", async () => {
  const home = await tmpHome();
  const world = fakeMcpWorld({ toolCount: 5 });
  try {
    const port = await world.start();
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const result = await setMcpServerToken(mcpUrl, "sk-pasted-secret", { name: "keyco", home });
    assert.equal(result.verified, true);
    assert.equal(result.toolCount, 5);

    const raw = await readFile(path.join(home, "mcp-remote.json"), "utf8");
    assert.ok(!raw.includes("sk-pasted-secret"), "pasted token must not be plaintext on disk");
    const entry = (await loadRemoteMcpServers(home)).keyco;
    assert.equal(entry.vault, true);
    assert.equal(entry.authToken, undefined);
    assert.equal(await getMcpAccessToken("keyco", home), "sk-pasted-secret");
  } finally {
    await world.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("verification soft-fails: rejected token reads verified:false, still stored", async () => {
  const home = await tmpHome();
  const world = fakeMcpWorld({ rejectBearer: true });
  try {
    const port = await world.start();
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const result = await setMcpServerToken(mcpUrl, "sk-bad", { name: "badco", home });
    assert.equal(result.verified, false);
    assert.match(result.verifyError, /rejected|401/i);
    // Stored anyway — the owner can retry or the server may recover.
    assert.equal(await getMcpAccessToken("badco", home), "sk-bad");
  } finally {
    await world.stop();
    await rm(home, { recursive: true, force: true });
  }
});
