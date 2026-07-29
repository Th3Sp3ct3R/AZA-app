// MCP connect — turns the OAuth brain (mcpOAuth.ts) into a one-click action:
// discover → dynamically register → PKCE authorize (loopback callback) →
// exchange → persist. Tokens are stored ENCRYPTED in the credential vault; the
// on-disk server list (~/.ares/mcp-remote.json) never holds a secret. The tools
// layer resolves a fresh access token at call-time via getMcpAccessToken (which
// refreshes transparently), so connectors keep working across restarts.

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
 *  that it authenticates via the vault-held OAuth bundle. `authToken` is only
 *  used for the manual paste-a-token path (no OAuth). */
export interface RemoteMcpEntry {
  url: string;
  oauth?: boolean;
  authToken?: string;
  displayName?: string;
  connectedAt?: string;
  /** false = connected but paused: tokens stay in the vault, tools don't load.
   *  Absent means enabled (back-compat with pre-toggle entries). */
  enabled?: boolean;
}

/** The encrypted-at-rest OAuth bundle (JSON) kept in the vault per connector. */
interface McpTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
}

export async function loadRemoteMcpServers(home?: string): Promise<Record<string, RemoteMcpEntry>> {
  try {
    const raw = await fs.readFile(remoteConfigPath(home), "utf8");
    const parsed = JSON.parse(raw) as { servers?: Record<string, RemoteMcpEntry> };
    return parsed.servers ?? {};
  } catch {
    return {};
  }
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

export interface ConnectMcpOptions {
  name?: string;
  displayName?: string;
  home?: string;
  port?: number;
  timeoutMs?: number;
  /** The daemon opens this in the user's real browser (emits an oauth_url frame). */
  onAuthorizeUrl: (url: string) => void;
}

export interface ConnectMcpResult {
  name: string;
  url: string;
  toolCount?: number;
}

/** Run the full OAuth connect for a remote MCP server. Resolves once the user
 *  authorizes in their browser and tokens are stored; rejects on denial/timeout. */
export async function connectMcpServer(url: string, opts: ConnectMcpOptions): Promise<ConnectMcpResult> {
  const name = (opts.name ?? connectorNameFromUrl(url)).trim();
  const home = opts.home;
  const port = opts.port ?? DEFAULT_PORT;
  const redirectUri = `http://localhost:${port}/oauth/callback`;

  const authServer = await discoverMcpAuth(url);
  if (!authServer.registrationEndpoint) {
    // Some servers require a pre-registered client. Surface a clear next step
    // instead of failing deep in the flow.
    throw new Error(
      `${name} doesn't support automatic app registration. It may need a token you paste directly, or a pre-registered client.`,
    );
  }
  const reg = await registerMcpClient(authServer.registrationEndpoint, redirectUri);
  const pkce = generatePkce();
  const state = randomBytes(16).toString("hex");
  const authorizeUrl = buildMcpAuthorizeUrl({
    authorizationEndpoint: authServer.authorizationEndpoint,
    clientId: reg.clientId,
    redirectUri,
    challenge: pkce.challenge,
    state,
    scopes: authServer.scopesSupported,
    resource: authServer.resource,
  });

  const tokens = await new Promise<Awaited<ReturnType<typeof exchangeMcpCode>>>((resolve, reject) => {
    let settled = false;
    let server: Server | undefined;
    const cleanup = () => { try { server?.close(); } catch { /* closed */ } server = undefined; };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; cleanup();
      reject(new Error(`connecting ${name} timed out — authorization wasn't completed`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    server = createServer(async (req, res) => {
      if (settled) { res.end(); return; }
      const u = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (u.pathname !== "/oauth/callback") { res.writeHead(404); res.end("Not found"); return; }
      const code = u.searchParams.get("code");
      const returnedState = u.searchParams.get("state");
      const error = u.searchParams.get("error");
      if (error) {
        settled = true; clearTimeout(timer); res.writeHead(200, { "content-type": "text/html" });
        res.end(resultHtml(false, `Authorization was denied (${error}).`)); cleanup();
        reject(new Error(`authorization denied: ${error}`)); return;
      }
      if (!code || returnedState !== state) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(resultHtml(false, "State mismatch or missing code.")); return;
      }
      try {
        const tok = await exchangeMcpCode({
          tokenEndpoint: authServer.tokenEndpoint,
          clientId: reg.clientId,
          clientSecret: reg.clientSecret,
          code,
          verifier: pkce.verifier,
          redirectUri,
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
    server.on("error", (err) => { if (!settled) { settled = true; clearTimeout(timer); cleanup(); reject(err); } });
    server.listen(port, "127.0.0.1", () => opts.onAuthorizeUrl(authorizeUrl));
  });

  // Persist: encrypted token bundle in the vault, secret-free entry on disk.
  const bundle: McpTokenBundle = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    tokenEndpoint: authServer.tokenEndpoint,
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    resource: authServer.resource,
  };
  await setCredential(tokenKey(name), JSON.stringify(bundle), { home });
  const servers = await loadRemoteMcpServers(home);
  servers[name] = { url, oauth: true, displayName: opts.displayName ?? name, connectedAt: new Date().toISOString() };
  await saveRemoteMcpServers(servers, home);
  return { name, url };
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
 *  connector isn't OAuth-connected (the caller falls back to authToken). */
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

function resultHtml(ok: boolean, msg: string): string {
  const color = ok ? "#4ade80" : "#f87171";
  const title = ok ? "Connected" : "Connection failed";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:${color};margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>
<body><div class="card"><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}
