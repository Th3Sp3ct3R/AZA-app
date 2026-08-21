// MCP connect — turns the OAuth brain (mcpOAuth.ts) into a one-click action:
// discover → dynamically register → PKCE authorize (loopback callback) →
// exchange → persist → VERIFY. Tokens are stored ENCRYPTED in the credential
// vault; the on-disk server list (~/.ares/mcp-remote.json) never holds a
// secret. The tools layer resolves a fresh access token at call-time via
// getMcpAccessToken (which refreshes transparently), so connectors keep
// working across restarts.
//
// Hardening (2026-08-11):
//   - post-connect verification: a tools/list probe with the fresh token, so
//     "connected" means the server actually accepts it (toolCount populated;
//     an issued-but-rejected token no longer reads as success);
//   - reconnect preserves state: enabled:false pauses, custom headers and
//     display names survive a re-auth instead of being wiped;
//   - API-key connectors: setMcpServerToken stores a pasted token in the SAME
//     encrypted vault (as a static bundle) — never plaintext on disk;
//   - loopback port fallback: a busy 53682 falls back to an ephemeral port and
//     registers the redirect URI with the port actually bound.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCredential, setCredential, deleteCredential } from "./credentials.js";
import {
  discoverMcpAuth,
  registerMcpClient,
  generatePkce,
  buildMcpAuthorizeUrl,
  exchangeMcpCode,
  refreshMcpToken,
} from "./mcpOAuth.js";

const DEFAULT_PORT = 53682; // distinct from the provider-OAuth loopback (53691)
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MCP_PROTOCOL_VERSION = "2025-06-18";

function aresHome(home?: string): string {
  return home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}
function remoteConfigPath(home?: string): string {
  return path.join(aresHome(home), "mcp-remote.json");
}
function tokenKey(name: string): string {
  return `mcp.token.${name}`;
}

/** A connector as stored on disk — no secret here, only where to reach it and
 *  how its bearer resolves. `oauth` = vault-held OAuth bundle (auto-refresh);
 *  `vault` = vault-held static token (pasted API key, no refresh). `authToken`
 *  is only the legacy manual-paste path and is discouraged — new pastes go
 *  through setMcpServerToken into the vault. */
export interface RemoteMcpEntry {
  url: string;
  oauth?: boolean;
  /** Static vault token connector (API key pasted by the owner). */
  vault?: boolean;
  authToken?: string;
  headers?: Record<string, string>;
  displayName?: string;
  connectedAt?: string;
  /** false = connected but paused: tokens stay in the vault, tools don't load.
   *  Absent means enabled (back-compat with pre-toggle entries). */
  enabled?: boolean;
}

/** The encrypted-at-rest OAuth bundle (JSON) kept in the vault per connector.
 *  A static (pasted) token is the same shape with no refresh material. */
interface McpTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  /** Custom request headers swept out of the on-disk entry — headers routinely
   *  carry API keys (x-api-key et al.) and must live encrypted like tokens. */
  headers?: Record<string, string>;
}

export async function loadRemoteMcpServers(home?: string): Promise<Record<string, RemoteMcpEntry>> {
  try {
    const raw = await fs.readFile(remoteConfigPath(home), "utf8");
    const parsed = JSON.parse(raw) as { servers?: Record<string, RemoteMcpEntry> };
    const servers = parsed.servers ?? {};
    await sweepPlaintextSecrets(servers, home);
    return servers;
  } catch {
    return {};
  }
}

/**
 * One-way migration: legacy `authToken` and custom `headers` used to sit in
 * plaintext in ~/.ares/mcp-remote.json while everything else lived in the
 * AES-256-GCM vault. Sweep them into the connector's vault bundle and strip
 * them from disk. Vault write FIRST, strip second — a failed encryption leaves
 * the secret where it was rather than losing it. Idempotent: a clean file is
 * untouched.
 */
async function sweepPlaintextSecrets(servers: Record<string, RemoteMcpEntry>, home?: string): Promise<void> {
  let dirty = false;
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry.authToken && !entry.headers) continue;
    try {
      const raw = await getCredential(tokenKey(name), { home });
      let bundle: McpTokenBundle | null = null;
      if (raw) {
        try { bundle = JSON.parse(raw) as McpTokenBundle; } catch { bundle = null; }
      }
      bundle ??= { accessToken: "", tokenEndpoint: "", clientId: "", resource: entry.url };
      // The vault is the newer authority: an already-vaulted token or header
      // wins over the plaintext leftover it superseded.
      if (entry.authToken && !bundle.accessToken) bundle.accessToken = entry.authToken;
      if (entry.headers) bundle.headers = { ...entry.headers, ...(bundle.headers ?? {}) };
      await setCredential(tokenKey(name), JSON.stringify(bundle), { home });
      if (entry.authToken && !entry.oauth) entry.vault = true;
      delete entry.authToken;
      delete entry.headers;
      dirty = true;
    } catch {
      // Encryption unavailable or vault unwritable: leave this entry's
      // plaintext alone — worse than un-migrated is silently lost.
    }
  }
  if (dirty) await saveRemoteMcpServers(servers, home);
}

async function saveRemoteMcpServers(servers: Record<string, RemoteMcpEntry>, home?: string): Promise<void> {
  const dir = aresHome(home);
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  await fs.writeFile(remoteConfigPath(home), JSON.stringify({ servers }, null, 2) + "\n", "utf8");
}

/** Pause/resume a connector without touching its vault tokens — the `/mcp`
 *  panel's toggle. Unknown names are a no-op (returns false). */
export async function setMcpServerEnabled(name: string, enabled: boolean, home?: string): Promise<boolean> {
  const servers = await loadRemoteMcpServers(home);
  const entry = servers[name];
  if (!entry) return false;
  entry.enabled = enabled;
  await saveRemoteMcpServers(servers, home);
  return true;
}

/** Derive a stable, human-ish connector name from a URL host when the caller
 *  doesn't supply one (e.g. "mcp.notion.com" → "notion"). */
export function connectorNameFromUrl(url: string): string {
  try {
    const host = new URL(url).host.replace(/^www\./, "");
    const parts = host.split(".");
    // drop a leading "mcp"/"api" and the TLD → the brand in the middle.
    const meaningful = parts.filter((p) => p !== "mcp" && p !== "api" && p !== "server");
    return (meaningful[meaningful.length - 2] ?? meaningful[0] ?? host).toLowerCase();
  } catch {
    return "connector";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Parse a Streamable-HTTP reply that may be plain JSON or a single-shot SSE. */
async function readJsonRpcBody(res: Response): Promise<unknown> {
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim());
      } catch {
        // keep scanning
      }
    }
    throw new Error("no JSON-RPC payload in SSE reply");
  }
  return JSON.parse(text);
}

export interface McpProbeResult {
  toolCount: number;
}

/**
 * Verify a bearer against a live MCP server: initialize, then tools/list, and
 * count. This is what makes "connected" mean something — a token the server
 * rejects fails HERE, at connect time, not on the agent's first tool call.
 */
export async function probeMcpTools(
  url: string,
  bearer: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<McpProbeResult> {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (bearer) baseHeaders.authorization = `Bearer ${bearer}`;
  const init = await fetchImpl(url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ares", version: "connect-verify" },
      },
    }),
  });
  if (init.status === 401 || init.status === 403) {
    throw new Error(`the server rejected the token (HTTP ${init.status})`);
  }
  if (!init.ok) throw new Error(`initialize failed (HTTP ${init.status})`);
  await readJsonRpcBody(init).catch(() => undefined); // some servers reply with an empty ack
  const session = init.headers.get("mcp-session-id");
  const listHeaders = session ? { ...baseHeaders, "mcp-session-id": session } : baseHeaders;
  const list = await fetchImpl(url, {
    method: "POST",
    headers: listHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  if (!list.ok) throw new Error(`tools/list failed (HTTP ${list.status})`);
  const body = (await readJsonRpcBody(list)) as { result?: { tools?: unknown[] }; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "tools/list returned an error");
  return { toolCount: body.result?.tools?.length ?? 0 };
}

export interface ConnectMcpOptions {
  name?: string;
  displayName?: string;
  home?: string;
  port?: number;
  timeoutMs?: number;
  /** The daemon opens this in the user's real browser (emits an oauth_url frame). */
  onAuthorizeUrl: (url: string) => void;
  /** Test seam for the verification probe's HTTP. */
  fetchImpl?: FetchLike;
}

export interface ConnectMcpResult {
  name: string;
  url: string;
  /** Populated by the post-connect tools/list probe (undefined when unverified). */
  toolCount?: number;
  /** True when the fresh token was proven against the server's tools/list. */
  verified: boolean;
  /** Why verification failed, when it did. Tokens are stored either way. */
  verifyError?: string;
}

/** Bind on the preferred port; a busy port falls back to an ephemeral one so
 *  two concurrent connects (or a squatter on 53682) can't kill the flow. */
function listenWithFallback(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server.removeListener("error", onError);
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : preferred);
        });
        return;
      }
      reject(err);
    };
    server.once("error", onError);
    server.listen(preferred, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : preferred);
    });
  });
}

/** Run the full OAuth connect for a remote MCP server. Resolves once the user
 *  authorizes in their browser and tokens are stored; rejects on denial/timeout. */
export async function connectMcpServer(url: string, opts: ConnectMcpOptions): Promise<ConnectMcpResult> {
  const name = (opts.name ?? connectorNameFromUrl(url)).trim();
  const home = opts.home;

  // Discovery needs no port — do it before binding so a dead server fails fast.
  const authServer = await discoverMcpAuth(url);
  if (!authServer.registrationEndpoint) {
    // Some servers require a pre-registered client. Surface a clear next step
    // instead of failing deep in the flow.
    throw new Error(
      `${name} doesn't support automatic app registration. It may need a token you paste directly (use the token field), or a pre-registered client.`,
    );
  }

  // The callback context is populated AFTER the port is known (registration
  // needs the real redirect URI). Requests racing ahead of it get a 503.
  let ctx: {
    state: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
  } | null = null;

  const tokens = await new Promise<Awaited<ReturnType<typeof exchangeMcpCode>>>((resolve, reject) => {
    let settled = false;
    let server: Server | undefined;
    const cleanup = () => { try { server?.close(); } catch { /* closed */ } server = undefined; };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; cleanup();
      reject(new Error(`connecting ${name} timed out — authorization wasn't completed`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    server = createServer(async (req, res) => {
      if (settled) { res.end(); return; }
      if (!ctx) { res.writeHead(503); res.end("Not ready"); return; }
      const u = new URL(req.url ?? "/", ctx.redirectUri);
      if (u.pathname !== "/oauth/callback") { res.writeHead(404); res.end("Not found"); return; }
      const code = u.searchParams.get("code");
      const returnedState = u.searchParams.get("state");
      const error = u.searchParams.get("error");
      if (error) {
        settled = true; clearTimeout(timer); res.writeHead(200, { "content-type": "text/html" });
        res.end(resultHtml(false, `Authorization was denied (${error}).`)); cleanup();
        reject(new Error(`authorization denied: ${error}`)); return;
      }
      if (!code || returnedState !== ctx.state) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(resultHtml(false, "State mismatch or missing code.")); return;
      }
      try {
        const tok = await exchangeMcpCode({
          tokenEndpoint: authServer.tokenEndpoint,
          clientId: ctx.clientId,
          clientSecret: ctx.clientSecret,
          code,
          verifier: ctx.verifier,
          redirectUri: ctx.redirectUri,
          resource: authServer.resource,
        });
        settled = true; clearTimeout(timer); res.writeHead(200, { "content-type": "text/html" });
        res.end(resultHtml(true, `${name} is connected. Return to Ares.`)); cleanup();
        resolve(tok);
      } catch (err) {
        settled = true; clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(200, { "content-type": "text/html" }); res.end(resultHtml(false, msg)); cleanup();
        reject(err instanceof Error ? err : new Error(msg));
      }
    });

    void (async () => {
      const port = await listenWithFallback(server!, opts.port ?? DEFAULT_PORT);
      const redirectUri = `http://localhost:${port}/oauth/callback`;
      const reg = await registerMcpClient(authServer.registrationEndpoint!, redirectUri);
      const pkce = generatePkce();
      const state = randomBytes(16).toString("hex");
      ctx = { state, verifier: pkce.verifier, redirectUri, clientId: reg.clientId, clientSecret: reg.clientSecret };
      opts.onAuthorizeUrl(
        buildMcpAuthorizeUrl({
          authorizationEndpoint: authServer.authorizationEndpoint,
          clientId: reg.clientId,
          redirectUri,
          challenge: pkce.challenge,
          state,
          scopes: authServer.scopesSupported,
          resource: authServer.resource,
        }),
      );
    })().catch(fail);
  });

  // Persist: encrypted token bundle in the vault, secret-free entry on disk.
  // A re-auth must not clobber the vaulted custom headers the owner configured.
  const priorHeaders = await vaultedHeaders(name, home);
  const bundle: McpTokenBundle = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    tokenEndpoint: authServer.tokenEndpoint,
    clientId: ctx!.clientId,
    clientSecret: ctx!.clientSecret,
    resource: authServer.resource,
    ...(priorHeaders ? { headers: priorHeaders } : {}),
  };
  await setCredential(tokenKey(name), JSON.stringify(bundle), { home });
  const servers = await loadRemoteMcpServers(home);
  // A RE-connect must not wipe what the owner configured: the pause state,
  // custom headers, and display name all survive re-auth.
  const prev = servers[name];
  servers[name] = {
    ...prev,
    url,
    oauth: true,
    vault: undefined,
    authToken: undefined,
    displayName: opts.displayName ?? prev?.displayName ?? name,
    connectedAt: new Date().toISOString(),
  };
  await saveRemoteMcpServers(servers, home);

  // Post-connect verification: prove the token against tools/list. Failure does
  // NOT roll back the stored tokens (the server may be briefly unhappy) — it is
  // surfaced so the UI says "connected but unverified" instead of lying.
  try {
    const probe = await probeMcpTools(url, tokens.accessToken, opts.fetchImpl);
    return { name, url, toolCount: probe.toolCount, verified: true };
  } catch (err) {
    return { name, url, verified: false, verifyError: err instanceof Error ? err.message : String(err) };
  }
}

export interface SetMcpTokenResult {
  name: string;
  url: string;
  toolCount?: number;
  verified: boolean;
  verifyError?: string;
}

/**
 * Connect a server with a PASTED token (API-key connectors — the registry rows
 * flagged needsKey, and servers without dynamic registration). The token goes
 * into the encrypted vault as a static bundle — NEVER plaintext on disk — and
 * is verified against tools/list before we call it connected.
 */
export async function setMcpServerToken(
  url: string,
  token: string,
  opts: { name?: string; displayName?: string; home?: string; fetchImpl?: FetchLike } = {},
): Promise<SetMcpTokenResult> {
  const name = (opts.name ?? connectorNameFromUrl(url)).trim();
  const trimmed = token.trim();
  if (!trimmed) throw new Error("a connector token can't be empty");
  const priorHeaders = await vaultedHeaders(name, opts.home);
  const bundle: McpTokenBundle = {
    accessToken: trimmed,
    tokenEndpoint: "",
    clientId: "",
    resource: url,
    ...(priorHeaders ? { headers: priorHeaders } : {}),
  };
  await setCredential(tokenKey(name), JSON.stringify(bundle), { home: opts.home });
  const servers = await loadRemoteMcpServers(opts.home);
  const prev = servers[name];
  servers[name] = {
    ...prev,
    url,
    oauth: undefined,
    vault: true,
    authToken: undefined,
    displayName: opts.displayName ?? prev?.displayName ?? name,
    connectedAt: new Date().toISOString(),
  };
  await saveRemoteMcpServers(servers, opts.home);
  try {
    const probe = await probeMcpTools(url, trimmed, opts.fetchImpl);
    return { name, url, toolCount: probe.toolCount, verified: true };
  } catch (err) {
    return { name, url, verified: false, verifyError: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a connector: delete its on-disk entry and its vault token. */
export async function disconnectMcpServer(name: string, home?: string): Promise<boolean> {
  const servers = await loadRemoteMcpServers(home);
  if (!servers[name]) return false;
  delete servers[name];
  await saveRemoteMcpServers(servers, home);
  await deleteCredential(tokenKey(name), { home }).catch(() => undefined);
  return true;
}

/** Return a VALID access token for a connected server, refreshing transparently
 *  when the stored one is near expiry. Used by the tools layer at call-time so a
 *  live token never has to sit in the on-disk config. Returns null when the
 *  connector isn't vault-connected (the caller falls back to authToken). */
export async function getMcpAccessToken(name: string, home?: string, now: () => number = Date.now): Promise<string | null> {
  const raw = await getCredential(tokenKey(name), { home });
  if (!raw) return null;
  let bundle: McpTokenBundle;
  try { bundle = JSON.parse(raw) as McpTokenBundle; } catch { return null; }
  const skewMs = 60_000;
  const fresh = bundle.expiresAt == null || bundle.expiresAt - now() > skewMs;
  if (fresh) return bundle.accessToken;
  if (!bundle.refreshToken) return bundle.accessToken; // can't refresh; try it anyway
  try {
    const next = await refreshMcpToken({
      tokenEndpoint: bundle.tokenEndpoint,
      clientId: bundle.clientId,
      clientSecret: bundle.clientSecret,
      refreshToken: bundle.refreshToken,
      resource: bundle.resource,
    }, { now });
    const updated: McpTokenBundle = { ...bundle, accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt };
    await setCredential(tokenKey(name), JSON.stringify(updated), { home });
    return next.accessToken;
  } catch {
    return bundle.accessToken; // refresh failed; hand back the stale token so the call can surface a clean 401
  }
}

/** The vault bundle's custom headers for a connector, if any. */
async function vaultedHeaders(name: string, home?: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = await getCredential(tokenKey(name), { home });
    if (!raw) return undefined;
    return (JSON.parse(raw) as McpTokenBundle).headers;
  } catch {
    return undefined;
  }
}

/**
 * Everything the tools layer needs to authenticate one MCP call: a fresh
 * bearer (transparently refreshed, same path as getMcpAccessToken) plus the
 * vault-held custom headers the on-disk entry no longer carries.
 */
export async function getMcpCallCredentials(
  name: string,
  home?: string,
  now: () => number = Date.now,
): Promise<{ bearer: string | null; headers: Record<string, string> }> {
  const raw = await getCredential(tokenKey(name), { home });
  if (!raw) return { bearer: null, headers: {} };
  let bundle: McpTokenBundle;
  try {
    bundle = JSON.parse(raw) as McpTokenBundle;
  } catch {
    return { bearer: null, headers: {} };
  }
  const bearer = await getMcpAccessToken(name, home, now);
  return { bearer: bearer || (bundle.accessToken || null), headers: bundle.headers ?? {} };
}

function resultHtml(ok: boolean, msg: string): string {
  const color = ok ? "#4ade80" : "#f87171";
  const title = ok ? "Connected" : "Connection failed";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:${color};margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>
<body><div class="card"><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}
