// Ares-account sign-in — the "click to connect, no token paste" flow.
//
// This is a gateway-specific, code-exchange OAuth-lite tailored to doingteam.com
// (the Ares account site). It deliberately does NOT reuse the generic oauth.ts
// machinery: there's no per-user client_id/secret, no standard token endpoint,
// and the result is the ACCOUNT TOKEN that lands in settings.aresGatewayToken —
// after which every existing gateway call (/me, /models, /messages, /report)
// authenticates unchanged. OAuth here is just a nicer way to POPULATE that token.
//
// The 2-endpoint contract doingteam must expose (owner-confirmed):
//   1. GET  {base}/account/connect?redirect_uri=<loopback>&state=<s>
//        → after the user is signed in, 302 to
//          <loopback>?code=<short-lived>&state=<s>
//   2. POST {base}/api/gateway/v1/oauth/exchange  {code}
//        → { token: "ares_…" }   (the account gateway token)
// Plus an optional capability probe so the UI only shows the button when live:
//   3. GET  {base}/api/gateway/v1/oauth/config → { enabled: true }
//
// The code (not the token) rides the redirect URL, so the secret never sits in
// browser history / loopback logs — it's exchanged server-to-server over #2.

import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const DEFAULT_PORT = 53691;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#4ade80;margin:0 0 .5rem}p{margin:0;opacity:.7}</style></head>
<body><div class="card"><h1>Ares connected</h1><p>You can close this tab and return to Ares.</p></div></body></html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#f87171;margin:0 0 .5rem}p{margin:0;opacity:.7}</style></head>
<body><div class="card"><h1>Sign-in failed</h1><p>${msg}</p></div></body></html>`;

/** Normalize to the canonical gateway origin (apex → www; strip trailing slash). */
export function normalizeGatewayBase(base: string): string {
  const raw = (base || "https://www.doingteam.com").replace(/\/+$/, "");
  return raw.replace(/^(https?:\/\/)doingteam\.com/i, "$1www.doingteam.com");
}

export interface AresAuthorizeOptions {
  codeChallenge?: string;
  deviceName?: string;
}

export function buildAresAuthorizeUrl(base: string, redirectUri: string, state: string, opts: AresAuthorizeOptions = {}): string {
  const u = new URL(`${normalizeGatewayBase(base)}/account/connect`);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  if (opts.codeChallenge) {
    u.searchParams.set("code_challenge", opts.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  if (opts.deviceName) u.searchParams.set("device_name", opts.deviceName);
  return u.toString();
}

export interface AresExchangeOptions {
  codeVerifier?: string;
  redirectUri?: string;
  deviceName?: string;
  fetchImpl?: typeof fetch;
}

/** Server-to-server swap of the short-lived code for the account token. */
export async function exchangeAresCode(base: string, code: string, options: AresExchangeOptions | typeof fetch = {}): Promise<string> {
  const opts: AresExchangeOptions = typeof options === "function" ? { fetchImpl: options } : options;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${normalizeGatewayBase(base)}/api/gateway/v1/oauth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
      ...(opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}),
      ...(opts.deviceName ? { device_name: opts.deviceName } : {}),
    }),
  }).catch((err: unknown) => {
    throw new Error(`couldn't reach the Ares gateway to finish sign-in: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token exchange failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json().catch(() => ({}))) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token.trim()) {
    throw new Error("the gateway returned no token from the code exchange");
  }
  return body.token.trim();
}

/** Capability probe — is doingteam's OAuth live? Governs whether the UI shows
 *  the "Sign in" button, so nothing breaks before the endpoints ship. */
export async function probeAresOauth(base: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${normalizeGatewayBase(base)}/api/gateway/v1/oauth/config`);
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { enabled?: unknown };
    return body.enabled === true;
  } catch {
    return false;
  }
}

/** Spin up the one-shot loopback server and resolve the returned `code` once the
 *  browser redirect lands (state-validated). Self-destructs on hit/error/timeout. */
export function captureLoopbackCode(
  redirectUri: string,
  state: string,
  port: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let server: Server | undefined;
    const cleanup = () => { if (server) { try { server.close(); } catch { /* closed */ } server = undefined; } };
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); fn(); };

    const timer = setTimeout(
      () => done(() => reject(new Error(`sign-in timed out after ${Math.round(timeoutMs / 1000)}s`))),
      timeoutMs,
    );

    server = createServer((req, res) => {
      if (settled || !req.url) { res.end(); return; }
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== new URL(redirectUri).pathname) { res.statusCode = 404; res.end(); return; }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (err) {
        res.writeHead(400, { "content-type": "text/html" }); res.end(ERROR_HTML(err));
        return done(() => reject(new Error(`sign-in was denied: ${err}`)));
      }
      if (returnedState !== state) {
        res.writeHead(400, { "content-type": "text/html" }); res.end(ERROR_HTML("state mismatch"));
        return done(() => reject(new Error("sign-in state mismatch — possible CSRF; aborted")));
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/html" }); res.end(ERROR_HTML("no code returned"));
        return done(() => reject(new Error("no authorization code returned")));
      }
      res.writeHead(200, { "content-type": "text/html" }); res.end(SUCCESS_HTML);
      done(() => resolve(code));
    });
    server.on("error", (e) => done(() => reject(e)));
    server.listen(port, "127.0.0.1");
  });
}

export interface AresSigninOptions {
  /** Called with the authorize URL — the caller opens it in the browser. */
  onAuthorizeUrl?: (url: string) => void | Promise<void>;
  port?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Friendly label shown in the account's Devices list. */
  deviceName?: string;
  /** Injectable capture (tests) — defaults to the real loopback server. */
  captureCode?: (redirectUri: string, state: string, port: number, timeoutMs: number) => Promise<string>;
}

/** Run the full sign-in: authorize → capture code → exchange → return token.
 *  The caller persists the token into settings.aresGatewayToken. */
export async function runAresAccountSignin(base: string, opts: AresSigninOptions = {}): Promise<{ token: string; base: string }> {
  const normalized = normalizeGatewayBase(base);
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const state = randomBytes(16).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const deviceName = opts.deviceName?.trim() || "Ares desktop";
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const authorizeUrl = buildAresAuthorizeUrl(normalized, redirectUri, state, { codeChallenge, deviceName });
  await opts.onAuthorizeUrl?.(authorizeUrl);
  const capture = opts.captureCode ?? captureLoopbackCode;
  const code = await capture(redirectUri, state, port, timeoutMs);
  const token = await exchangeAresCode(normalized, code, { codeVerifier, redirectUri, deviceName, fetchImpl: opts.fetchImpl });
  return { token, base: normalized };
}
