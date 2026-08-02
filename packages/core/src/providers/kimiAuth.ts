// Kimi OAuth — RFC 8628 device-code flow against auth.kimi.com.
//
// Kimi's coding endpoint (api.kimi.com/coding/v1) accepts either a plain API key
// or a subscription access token minted by this flow. Credential precedence is
// owned by the provider factory: stored key → KIMI_API_KEY → this token store.
//
// Token storage: %USERPROFILE%/.ares/kimi-auth.json (or $ARES_HOME/kimi-auth.json),
// chmod 600 where the platform supports it — the same posture as auth.json.
// Bypass for tests/CI: $ARES_KIMI_OAUTH_TOKEN (still an access token, just sourced
// from env instead of disk).
//
// Refresh happens on read, not on a timer: a token within REFRESH_SKEW_MS of expiry
// is renewed before it is handed out, so a long session never fails mid-turn on an
// expired credential.

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OAUTH_HOST = "https://auth.kimi.com";
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_AUTHORIZATION_PATH = "/api/oauth/device_authorization";
const TOKEN_PATH = "/api/oauth/token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Renew this far ahead of expiry so a token never dies mid-turn. */
const REFRESH_SKEW_MS = 300_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** The device code itself expires; never poll longer than the flow can succeed. */
const DEFAULT_LOGIN_TIMEOUT_MS = 900_000;

export interface KimiTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms the access token expires. */
  expiresAt: number;
  scope: string;
}

export interface KimiAuthStatus {
  connected: boolean;
  source: "env:ARES_KIMI_OAUTH_TOKEN" | "file" | "none";
  authPath: string;
  expiresAt?: number;
  detail?: string;
}

export interface KimiDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Pre-filled variant when the server supplies one — what we actually open. */
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export interface KimiLoginOptions {
  /** Ignore an existing valid token and re-authorize from scratch. */
  force?: boolean;
  /** Surfaced so a host can render the code/URL card before polling starts. */
  onAuthorize?: (authorization: KimiDeviceAuthorization) => void;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export function aresHome(): string {
  return process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}

export function kimiAuthFilePath(): string {
  return path.join(aresHome(), "kimi-auth.json");
}

/**
 * POSTs a form body and returns the parsed JSON regardless of status — the device
 * flow signals `authorization_pending` and `slow_down` through 4xx bodies, so a
 * status check alone cannot distinguish "still waiting" from "actually broken".
 */
async function postForm(
  endpoint: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(`${OAUTH_HOST}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
    signal,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body is still meaningful as a status; leave body empty.
  }
  return { ok: response.ok, status: response.status, body };
}

function tokensFromBody(body: Record<string, unknown>, priorRefreshToken?: string): KimiTokens {
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Kimi token response carried no access_token");
  }
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token.length > 0
    ? body.refresh_token
    : priorRefreshToken;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("Kimi token response carried no refresh_token");
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1_000 : 3_600_000),
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

export async function loadKimiTokens(): Promise<KimiTokens | null> {
  try {
    const raw = await readFile(kimiAuthFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<KimiTokens>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      scope: typeof parsed.scope === "string" ? parsed.scope : "",
    };
  } catch {
    return null;
  }
}

export async function saveKimiTokens(tokens: KimiTokens): Promise<void> {
  const file = kimiAuthFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(tokens, null, 2) + "\n", "utf8");
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows and some mounts don't honour POSIX modes — not fatal.
  }
}

export async function kimiLogout(): Promise<boolean> {
  try {
    await rm(kimiAuthFilePath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Step 1 of RFC 8628: ask for a device code + the URL the human visits. */
export async function requestKimiDeviceAuthorization(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<KimiDeviceAuthorization> {
  const { ok, body } = await postForm(DEVICE_AUTHORIZATION_PATH, { client_id: OAUTH_CLIENT_ID }, fetchImpl, signal);
  if (!ok || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    const detail = body.error_description ?? body.error ?? "device authorization failed";
    throw new Error(`Kimi device authorization failed: ${String(detail)}`);
  }
  const interval = Number(body.interval);
  const expiresIn = Number(body.expires_in);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: typeof body.verification_uri === "string" ? body.verification_uri : `${OAUTH_HOST}/device`,
    verificationUriComplete: typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : undefined,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_SECONDS,
    expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
  };
}

type PollOutcome =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "ready"; tokens: KimiTokens }
  | { state: "failed"; error: string };

/** Step 2: one poll of the token endpoint. Never throws on a protocol-level wait. */
export async function pollKimiDeviceToken(
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PollOutcome> {
  const { ok, body } = await postForm(TOKEN_PATH, {
    client_id: OAUTH_CLIENT_ID,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT,
  }, fetchImpl, signal);
  if (ok && typeof body.access_token === "string") {
    return { state: "ready", tokens: tokensFromBody(body) };
  }
  const error = typeof body.error === "string" ? body.error : "";
  if (error === "authorization_pending") return { state: "pending" };
  if (error === "slow_down") return { state: "slow_down" };
  const detail = body.error_description ?? body.error ?? "token exchange failed";
  return { state: "failed", error: String(detail) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The whole flow: authorize, hand the code/URL to the host, then poll to the
 * device code's own deadline. Returns the stored tokens.
 */
export async function runKimiLoginFlow(options: KimiLoginOptions = {}): Promise<KimiTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.force !== true) {
    const existing = await resolveKimiTokens(fetchImpl);
    if (existing !== null) return existing;
  }

  const authorization = await requestKimiDeviceAuthorization(fetchImpl, options.signal);
  options.onAuthorize?.(authorization);

  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS, authorization.expiresInSeconds * 1_000);
  const deadline = Date.now() + timeoutMs;
  let intervalMs = authorization.intervalSeconds * 1_000;

  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new Error("Kimi sign-in cancelled");
    await sleep(intervalMs);
    const outcome = await pollKimiDeviceToken(authorization.deviceCode, fetchImpl, options.signal);
    if (outcome.state === "ready") {
      await saveKimiTokens(outcome.tokens);
      return outcome.tokens;
    }
    // The server asks us to back off by bumping the interval, per RFC 8628 §3.5.
    if (outcome.state === "slow_down") intervalMs += DEFAULT_POLL_INTERVAL_SECONDS * 1_000;
    if (outcome.state === "failed") throw new Error(`Kimi sign-in failed: ${outcome.error}`);
  }
  throw new Error("Kimi sign-in timed out before the code was approved");
}

export async function refreshKimiTokens(
  tokens: KimiTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<KimiTokens | null> {
  const { ok, body } = await postForm(TOKEN_PATH, {
    client_id: OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  }, fetchImpl);
  if (!ok) return null;
  try {
    const refreshed = tokensFromBody(body, tokens.refreshToken);
    await saveKimiTokens(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

/**
 * Stored tokens, refreshed if they are at or near expiry. Null when the owner has
 * never signed in (or the refresh token has been revoked and must be re-minted).
 */
export async function resolveKimiTokens(fetchImpl: typeof fetch = fetch): Promise<KimiTokens | null> {
  const stored = await loadKimiTokens();
  if (stored === null) return null;
  if (stored.expiresAt - REFRESH_SKEW_MS > Date.now()) return stored;
  return await refreshKimiTokens(stored, fetchImpl);
}

/**
 * The credential the Kimi provider actually sends. Env override first so CI and
 * tests never touch the owner's real token store.
 */
export async function resolveKimiAccessToken(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const fromEnv = process.env.ARES_KIMI_OAUTH_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const tokens = await resolveKimiTokens(fetchImpl);
  return tokens?.accessToken ?? null;
}

export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";

export interface KimiModel {
  id: string;
  contextLength?: number;
  supportsReasoning?: boolean;
  thinkingType?: string;
}

/**
 * Live model discovery for the picker. Kimi's coding endpoint is OpenAI-compatible,
 * so this is a plain `GET /models`. Returns null on any failure — the caller keeps a
 * static fallback list so the picker is never empty when the owner is signed out or
 * offline. `credential` lets the caller pass an API key; without one we fall back to
 * the OAuth token.
 */
export async function fetchKimiModels(
  credential?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly KimiModel[] | null> {
  const token = credential !== undefined && credential !== "" ? credential : await resolveKimiAccessToken(fetchImpl);
  if (token === null || token === "") return null;
  try {
    const response = await fetchImpl(`${KIMI_CODING_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    const models: KimiModel[] = [];
    for (const row of body.data) {
      const entry = row as Record<string, unknown>;
      if (typeof entry.id !== "string" || entry.id.length === 0) continue;
      const context = Number(entry.context_length ?? entry.max_context_length);
      const thinking = typeof entry.thinking_type === "string" ? entry.thinking_type : undefined;
      models.push({
        id: entry.id,
        contextLength: Number.isFinite(context) && context > 0 ? context : undefined,
        supportsReasoning: thinking === undefined ? undefined : thinking !== "no",
        thinkingType: thinking,
      });
    }
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export async function kimiAuthStatus(): Promise<KimiAuthStatus> {
  const authPath = kimiAuthFilePath();
  const fromEnv = process.env.ARES_KIMI_OAUTH_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { connected: true, source: "env:ARES_KIMI_OAUTH_TOKEN", authPath, detail: "environment token" };
  }
  const stored = await loadKimiTokens();
  if (stored === null) return { connected: false, source: "none", authPath };
  return {
    connected: true,
    source: "file",
    authPath,
    expiresAt: stored.expiresAt,
    detail: stored.expiresAt > Date.now() ? "subscription" : "expired — will refresh on next use",
  };
}
