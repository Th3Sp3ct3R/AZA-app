// ChatGPT OAuth — device-code flow, Codex backend only.
//
// Ares does NOT support OPENAI_API_KEY anymore (see CHANGELOG). The
// canonical path is ChatGPT OAuth, which routes requests through the
// Codex backend at chatgpt.com.
//
// Token storage: %USERPROFILE%/.ares/auth.json (or $ARES_HOME/auth.json).
// Bypass for tests/CI: $ARES_OPENAI_OAUTH_TOKEN env var (still an OAuth
// access token — just sourced from env instead of file).

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const OAUTH_ISSUER = "https://auth.openai.com";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
// Loopback redirect — Codex CLI's registered callback. The browser does the
// authorize (clearing Cloudflare's challenge, which a server-side fetch can't),
// then redirects here with the code.
const CALLBACK_PORT = 1455;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const OAUTH_SCOPE = "openid profile email offline_access";

export type AuthMode = "chatgpt-oauth" | "none";
export type AuthSource = "env:ARES_OPENAI_OAUTH_TOKEN" | "file" | "none";

export interface AuthToken {
  token: string;
  source: Exclude<AuthSource, "none">;
  mode: Exclude<AuthMode, "none">;
  accountId?: string;
}

export interface AuthStatus {
  configured: boolean;
  source: AuthSource;
  mode: AuthMode;
  authPath: string;
  email?: string;
  planType?: string;
  accountId?: string;
  tokenPreview?: string;
}

interface AuthFile {
  mode: "chatgpt-oauth";
  tokens: {
    idToken: string;
    accessToken: string;
    refreshToken: string;
    accountId?: string;
    /** Epoch ms the access token expires. Absent on pre-refresh files. */
    expiresAt?: number;
  };
  profile: {
    email?: string;
    planType?: string;
    userId?: string;
  };
  lastRefresh: string;
}

// Serialize refreshes so N concurrent requests trigger ONE token refresh.
let refreshInFlight: Promise<AuthFile | null> | null = null;

export function aresHome(): string {
  return process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}

export function authFilePath(): string {
  return path.join(aresHome(), "auth.json");
}

/** Resolve the ChatGPT OAuth token. Env > file. Transparently refreshes an
 *  expired (or near-expiry) access token using the stored refresh token, so
 *  GPT keeps working instead of 401-ing after ~1h until a manual re-sign-in. */
export async function loadAuthToken(): Promise<AuthToken | null> {
  if (process.env.ARES_OPENAI_OAUTH_TOKEN) {
    return {
      token: process.env.ARES_OPENAI_OAUTH_TOKEN,
      source: "env:ARES_OPENAI_OAUTH_TOKEN",
      mode: "chatgpt-oauth",
    };
  }
  let file = await readAuthFile();
  if (!file) return null;
  const expiresAt = file.tokens.expiresAt ?? 0;
  const needsRefresh = expiresAt > 0 && Date.now() >= expiresAt - TOKEN_EXPIRY_SKEW_MS;
  if (needsRefresh && file.tokens.refreshToken) {
    const refreshed = await refreshOpenAIToken().catch(() => null);
    if (refreshed) file = refreshed;
  }
  return {
    token: file.tokens.accessToken,
    source: "file",
    mode: "chatgpt-oauth",
    accountId: file.tokens.accountId,
  };
}

/** Exchange the stored refresh token for a fresh access token. Coalesced so
 *  concurrent callers share one network round-trip. Returns null on failure
 *  (e.g. the refresh token itself was revoked → user must sign in again). */
export async function refreshOpenAIToken(fetchImpl: typeof fetch = fetch): Promise<AuthFile | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const file = await readAuthFile();
      if (!file?.tokens.refreshToken) return null;
      const res = await fetchImpl(`${OAUTH_ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: OAUTH_CLIENT_ID,
          refresh_token: file.tokens.refreshToken,
        }),
      });
      if (!res.ok) return null;
      const tok = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
      if (!tok.access_token) return null;
      const updated: AuthFile = {
        ...file,
        tokens: {
          ...file.tokens,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token ?? file.tokens.refreshToken,
          idToken: tok.id_token ?? file.tokens.idToken,
          expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
        },
        lastRefresh: new Date().toISOString(),
      };
      await writeAuthFile(updated);
      return updated;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function authStatus(): Promise<AuthStatus> {
  const authPath = authFilePath();
  const token = await loadAuthToken();
  if (!token) {
    return { configured: false, source: "none", mode: "none", authPath };
  }
  const file = token.source === "file" ? await readAuthFile() : null;
  return {
    configured: true,
    source: token.source,
    mode: token.mode,
    authPath,
    email: file?.profile.email,
    planType: file?.profile.planType,
    accountId: token.accountId,
    tokenPreview: token.token.slice(0, 8) + "…",
  };
}

async function readAuthFile(): Promise<AuthFile | null> {
  try {
    const raw = await readFile(authFilePath(), "utf8");
    return JSON.parse(raw) as AuthFile;
  } catch {
    return null;
  }
}

async function writeAuthFile(file: AuthFile): Promise<void> {
  const dir = aresHome();
  await mkdir(dir, { recursive: true });
  const path_ = authFilePath();
  await writeFile(path_, JSON.stringify(file, null, 2) + "\n", "utf8");
  if (process.platform !== "win32") {
    try {
      await chmod(path_, 0o600);
    } catch {
      // best-effort
    }
  }
}

// ─── Loopback authorization-code OAuth (ChatGPT) ───────────────────────
//
// The device-code endpoint is behind Cloudflare's bot challenge, so a
// server-side fetch gets an HTML "enable JavaScript" page instead of JSON.
// This flow opens the /authorize page in the user's REAL browser (which
// clears the challenge) and catches the redirect on a loopback server —
// exactly how the Anthropic sign-in and the Codex CLI work.

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface OpenAILoginOptions {
  /** Called with the authorize URL so the daemon can open the browser. */
  onAuthorizeUrl?: (url: string) => void;
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
}

interface CodeExchangeResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  account_id?: string;
}

/** Full loopback ChatGPT sign-in. Resolves with the stored auth file once the
 *  user approves in their browser; rejects on timeout / denial / exchange error. */
export async function runOpenAILoginFlow(opts: OpenAILoginOptions = {}): Promise<AuthFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.maxWaitMs ?? 5 * 60_000;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));

  const authorizeUrl = new URL(`${OAUTH_ISSUER}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", OAUTH_SCOPE);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("id_token_add_organizations", "true");
  authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, file?: AuthFile): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      server.close();
      if (error) reject(error);
      else if (file) resolve(file);
    };

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", REDIRECT_URI);
      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }
      const providerError = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code") ?? "";
      const returnedState = reqUrl.searchParams.get("state") ?? "";
      if (providerError) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h2>ChatGPT sign-in was not completed. You can close this tab.</h2></body></html>");
        finish(new Error(`ChatGPT authorization failed (${providerError})`));
        return;
      }
      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h2>ChatGPT sign-in failed. Close this tab and try again.</h2></body></html>");
        finish(new Error("ChatGPT OAuth callback had a missing code or invalid state."));
        return;
      }
      void exchangeAuthCode(code, verifier, fetchImpl)
        .then(async (file) => {
          await writeAuthFile(file);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h2>Signed in to Ares with ChatGPT. You can close this tab.</h2></body></html>");
          finish(undefined, file);
        })
        .catch((error: unknown) => {
          res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h2>ChatGPT approved access, but token exchange failed. Return to Ares for details.</h2></body></html>");
          finish(error instanceof Error ? error : new Error(String(error)));
        });
    });

    const deadline = setTimeout(() => finish(new Error("ChatGPT sign-in timed out after 5 minutes. Try again.")), timeoutMs);

    server.once("error", (error: NodeJS.ErrnoException) => {
      finish(new Error(
        error.code === "EADDRINUSE"
          ? `Port ${CALLBACK_PORT} is busy — close any other ChatGPT/Codex sign-in and try again.`
          : `Could not start the ChatGPT auth callback: ${error.message}`,
      ));
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      try {
        opts.onAuthorizeUrl?.(authorizeUrl.toString());
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function exchangeAuthCode(code: string, verifier: string, fetchImpl: typeof fetch): Promise<AuthFile> {
  const res = await fetchImpl(`${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH_CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    // Keep the error SHORT — the Cloudflare/HTML failure page must never be
    // dumped verbatim into the UI (that giant blob was the reported bug).
    const raw = (await res.text().catch(() => "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const detail = raw.length > 140 ? "the sign-in service returned an unexpected page (possibly a Cloudflare check)" : raw;
    throw new Error(`ChatGPT token exchange failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const tok = (await res.json()) as CodeExchangeResponse;
  return {
    mode: "chatgpt-oauth",
    tokens: {
      idToken: tok.id_token,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      accountId: tok.account_id ?? extractAccountId(tok.id_token),
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    },
    profile: extractProfile(tok.id_token),
    lastRefresh: new Date().toISOString(),
  };
}

export interface CodexModel {
  id: string;
  label?: string;
  description?: string;
}

/** Ask the authenticated ChatGPT/Codex account which models it ACTUALLY offers,
 *  returning the exact ids the backend accepts (no guessing from display labels).
 *  Empty on any failure so the caller falls back to the static list. */
export async function fetchCodexModels(fetchImpl: typeof fetch = fetch): Promise<CodexModel[]> {
  const auth = await loadAuthToken();
  if (!auth) return [];
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.token}`,
    originator: "ares",
    "User-Agent": "ares",
  };
  if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
  try {
    // codex/models 400s without a client_version; it's advisory, any recent
    // value is accepted. Returns the exact Codex model slugs for the account.
    const res = await fetchImpl("https://chatgpt.com/backend-api/codex/models?client_version=0.50.0", {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: unknown[]; data?: unknown[] };
    const rows = (Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : []) as Array<Record<string, unknown>>;
    const models: CodexModel[] = [];
    for (const row of rows) {
      const id = String(row.slug ?? row.id ?? row.model ?? row.name ?? "");
      if (!id) continue;
      const label = typeof row.title === "string" ? row.title
        : typeof row.display_name === "string" ? row.display_name
        : typeof row.name === "string" ? row.name : undefined;
      const description = typeof row.description === "string" ? row.description : undefined;
      models.push({ id, label, description });
    }
    return models;
  } catch {
    return [];
  }
}

/** Pull the ChatGPT account id from the id_token's org claims when present. */
function extractAccountId(idToken: string): string | undefined {
  try {
    const [, payload] = idToken.split(".");
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
    };
    return decoded["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

// ─── Device-code OAuth (ChatGPT) ───────────────────────────────────────

export interface DeviceCodeChallenge {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
}

export interface DeviceCodeLoginOptions {
  /** Called as soon as we have the user code so the CLI can print it. */
  onDeviceCode?: (code: DeviceCodeChallenge) => void | Promise<void>;
  /** Cap on total polling time. Default 10 minutes. */
  maxWaitMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

interface TokenExchangeResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account_id?: string;
}

/**
 * Begin a ChatGPT OAuth device-code login. Resolves once the user has
 * authorized in their browser (or rejects on timeout/cancel).
 */
export async function deviceCodeLogin(opts: DeviceCodeLoginOptions = {}): Promise<AuthFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;

  const dcRes = await fetchImpl(`${OAUTH_ISSUER}/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      scope: "openid profile email offline_access",
    }),
  });
  if (!dcRes.ok) throw new Error(`device-code request failed: ${dcRes.status} ${await dcRes.text()}`);
  const dc = (await dcRes.json()) as DeviceCodeResponse;

  await opts.onDeviceCode?.({
    verificationUrl: dc.verification_uri_complete ?? dc.verification_uri,
    userCode: dc.user_code,
    deviceAuthId: dc.device_code,
    intervalSeconds: dc.interval,
  });

  const deadline = Date.now() + Math.min(maxWaitMs, dc.expires_in * 1000);
  let interval = (dc.interval || 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const tRes = await fetchImpl(`${OAUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: OAUTH_CLIENT_ID,
        device_code: dc.device_code,
      }),
    });
    if (tRes.status === 200) {
      const tok = (await tRes.json()) as TokenExchangeResponse;
      const file: AuthFile = {
        mode: "chatgpt-oauth",
        tokens: {
          idToken: tok.id_token,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          accountId: tok.account_id,
        },
        profile: extractProfile(tok.id_token),
        lastRefresh: new Date().toISOString(),
      };
      await writeAuthFile(file);
      return file;
    }
    const body = (await tRes.json().catch(() => ({}))) as { error?: string };
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      interval += 5_000;
      continue;
    }
    if (body.error === "access_denied") throw new Error("user denied authorization");
    if (body.error === "expired_token") throw new Error("device code expired");
    throw new Error(`token exchange failed: ${tRes.status} ${JSON.stringify(body)}`);
  }
  throw new Error("login timed out");
}

function extractProfile(idToken: string): AuthFile["profile"] {
  try {
    const [, payload] = idToken.split(".");
    if (!payload) return {};
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      plan_type?: string;
      sub?: string;
    };
    return { email: decoded.email, planType: decoded.plan_type, userId: decoded.sub };
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export helpers tests might want
export { TOKEN_EXPIRY_SKEW_MS };
