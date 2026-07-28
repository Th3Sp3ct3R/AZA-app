import { randomUUID } from "node:crypto";
import { hostname, release, type as osType, arch } from "node:os";
import { oauthFilePath, readJsonFile, removeFile, shortDetail, writeJsonFile } from "./store.js";
export const KIMI_OAUTH_HOST = "https://auth.kimi.com";
export const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CHAT_COMPLETIONS_URL = `${KIMI_CODING_BASE_URL}/chat/completions`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const VERSION = "0.1.0";
const DEFAULT_INTERVAL_SECONDS = 5;
const REFRESH_MIN_SKEW_SECONDS = 300;
function tokenFile() { return oauthFilePath("kimi-oauth.json"); }
function deviceFile() { return oauthFilePath("kimi-device.json"); }
async function deviceId() {
    const stored = await readJsonFile(deviceFile());
    if (stored !== null && typeof stored === "object" && !Array.isArray(stored)
        && typeof stored.id === "string" && stored.id.length > 0) {
        return stored.id;
    }
    const id = randomUUID();
    await writeJsonFile(deviceFile(), { id });
    return id;
}
function ascii(value) {
    const clean = value.replace(/[^ -~]/gu, "").trim();
    return clean.length === 0 ? "unknown" : clean;
}
export async function kimiRequestHeaders() {
    return {
        "X-Msh-Platform": "kimi_code_cli",
        "X-Msh-Version": VERSION,
        "X-Msh-Device-Name": ascii(hostname()),
        "X-Msh-Device-Model": ascii(`${osType()} ${release()} ${arch()}`),
        "X-Msh-Os-Version": ascii(release()),
        "X-Msh-Device-Id": await deviceId(),
        "User-Agent": `Vanguard/${VERSION}`,
    };
}
async function postForm(path, body, fetchImpl) {
    const response = await fetchImpl(`${KIMI_OAUTH_HOST}${path}`, {
        method: "POST",
        headers: {
            ...await kimiRequestHeaders(),
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(30_000),
    });
    let parsed = {};
    try {
        parsed = await response.json();
    }
    catch { }
    return {
        status: response.status,
        body: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed : {},
    };
}
function responseError(body) {
    const value = body.error_description ?? body.message ?? body.error;
    return typeof value === "string" && value.length > 0 ? shortDetail(value) : "unexpected response";
}
function tokensFrom(body, priorRefreshToken) {
    const accessToken = body.access_token;
    const refreshToken = body.refresh_token ?? priorRefreshToken;
    const expiresIn = Number(body.expires_in);
    if (typeof accessToken !== "string" || accessToken.length === 0
        || typeof refreshToken !== "string" || refreshToken.length === 0
        || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error("Kimi OAuth returned an incomplete token response.");
    }
    return {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + expiresIn * 1_000,
        expiresIn,
        scope: typeof body.scope === "string" ? body.scope : "",
        tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    };
}
function validTokens(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    if (typeof row.accessToken !== "string" || row.accessToken.length === 0
        || typeof row.refreshToken !== "string" || row.refreshToken.length === 0)
        return null;
    return {
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : 0,
        expiresIn: typeof row.expiresIn === "number" ? row.expiresIn : 0,
        scope: typeof row.scope === "string" ? row.scope : "",
        tokenType: typeof row.tokenType === "string" ? row.tokenType : "Bearer",
    };
}
export async function loadKimiTokens() {
    return validTokens(await readJsonFile(tokenFile()));
}
export async function clearKimiTokens() { await removeFile(tokenFile()); }
export async function requestKimiDeviceAuthorization(fetchImpl = fetch) {
    const response = await postForm("/api/oauth/device_authorization", { client_id: KIMI_OAUTH_CLIENT_ID }, fetchImpl);
    const body = response.body;
    if (response.status !== 200)
        throw new Error(`Kimi device authorization failed (${response.status}): ${responseError(body)}`);
    if (typeof body.user_code !== "string" || typeof body.device_code !== "string"
        || typeof body.verification_uri_complete !== "string") {
        throw new Error("Kimi device authorization returned an incomplete response.");
    }
    const expiresIn = Number(body.expires_in ?? 900);
    const interval = Number(body.interval ?? DEFAULT_INTERVAL_SECONDS);
    return {
        userCode: body.user_code,
        deviceCode: body.device_code,
        verificationUri: typeof body.verification_uri === "string" ? body.verification_uri : body.verification_uri_complete,
        verificationUriComplete: body.verification_uri_complete,
        expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
        interval: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_SECONDS,
    };
}
async function pollKimiDeviceToken(deviceCode, fetchImpl) {
    const response = await postForm("/api/oauth/token", {
        client_id: KIMI_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
    }, fetchImpl);
    if (response.status === 200)
        return { kind: "success", tokens: tokensFrom(response.body) };
    const error = response.body.error;
    if (error === "authorization_pending" || error === "slow_down")
        return { kind: "pending", slowDown: error === "slow_down" };
    if (error === "expired_token")
        return { kind: "expired" };
    if (error === "access_denied")
        return { kind: "denied" };
    throw new Error(`Kimi device token polling failed (${response.status}): ${responseError(response.body)}`);
}
export async function runKimiLoginFlow(options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const existing = options.force === true ? null : await loadKimiTokens();
    if (existing !== null && Date.now() < existing.expiresAt - refreshSkewMs(existing))
        return existing;
    if (existing !== null) {
        try {
            return await refreshKimiTokens(existing, fetchImpl);
        }
        catch { }
    }
    const authorization = await requestKimiDeviceAuthorization(fetchImpl);
    options.onDeviceAuthorization?.(authorization);
    const timeoutMs = Math.min(options.timeoutMs ?? 900_000, authorization.expiresIn * 1_000);
    const deadline = Date.now() + timeoutMs;
    let intervalMs = authorization.interval * 1_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const result = await pollKimiDeviceToken(authorization.deviceCode, fetchImpl);
        if (result.kind === "success") {
            await writeJsonFile(tokenFile(), result.tokens);
            return result.tokens;
        }
        if (result.kind === "expired")
            throw new Error("Kimi sign-in code expired. Try again.");
        if (result.kind === "denied")
            throw new Error("Kimi sign-in was denied.");
        if (result.kind === "pending" && result.slowDown)
            intervalMs += 5_000;
    }
    throw new Error("Kimi sign-in timed out. Try again.");
}
function refreshSkewMs(tokens) {
    return Math.max(REFRESH_MIN_SKEW_SECONDS, tokens.expiresIn * 0.5) * 1_000;
}
let refreshInFlight = null;
export async function refreshKimiTokens(tokens, fetchImpl = fetch) {
    if (refreshInFlight !== null)
        return refreshInFlight;
    refreshInFlight = (async () => {
        try {
            let last;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    const response = await postForm("/api/oauth/token", {
                        client_id: KIMI_OAUTH_CLIENT_ID,
                        grant_type: "refresh_token",
                        refresh_token: tokens.refreshToken,
                    }, fetchImpl);
                    if (response.status === 200) {
                        const next = tokensFrom(response.body, tokens.refreshToken);
                        await writeJsonFile(tokenFile(), next);
                        return next;
                    }
                    if (response.status === 401 || response.status === 403 || response.body.error === "invalid_grant") {
                        throw new Error("Kimi subscription authorization expired; run `vanguard login kimi` again.");
                    }
                    last = new Error(`Kimi token refresh failed (${response.status}): ${responseError(response.body)}`);
                    if (!(response.status === 429 || response.status >= 500)) {
                        throw new Error(`Kimi token refresh was rejected: ${last.message}`);
                    }
                }
                catch (error) {
                    last = error instanceof Error ? error : new Error(String(error));
                    if (/authorization expired|refresh was rejected/u.test(last.message))
                        throw last;
                }
                if (attempt < 2)
                    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
            }
            throw last ?? new Error("Kimi token refresh failed.");
        }
        finally {
            refreshInFlight = null;
        }
    })();
    return refreshInFlight;
}
export async function resolveKimiAccessToken(fetchImpl = fetch) {
    const override = process.env.VANGUARD_KIMI_OAUTH_TOKEN?.trim();
    if (override !== undefined && override.length > 0)
        return override;
    let tokens = await loadKimiTokens();
    if (tokens === null)
        return null;
    if (Date.now() >= tokens.expiresAt - refreshSkewMs(tokens)) {
        try {
            tokens = await refreshKimiTokens(tokens, fetchImpl);
        }
        catch {
            return null;
        }
    }
    return tokens.accessToken;
}
export async function fetchKimiModels(fetchImpl = fetch) {
    const token = await resolveKimiAccessToken(fetchImpl);
    if (token === null)
        return null;
    try {
        const response = await fetchImpl(`${KIMI_CODING_BASE_URL}/models`, {
            headers: { ...await kimiRequestHeaders(), Accept: "application/json", Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok)
            return null;
        const body = await response.json();
        const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
        if (rows === null)
            return null;
        const models = [];
        for (const row of rows) {
            if (row === null || typeof row !== "object" || Array.isArray(row))
                continue;
            const value = row;
            if (typeof value.id !== "string" || value.id.length === 0)
                continue;
            const efforts = value.think_efforts !== null && typeof value.think_efforts === "object"
                ? value.think_efforts : undefined;
            models.push({
                id: value.id,
                ...(typeof value.context_length === "number" ? { contextLength: value.context_length } : {}),
                ...(typeof value.supports_reasoning === "boolean" ? { supportsReasoning: value.supports_reasoning } : {}),
                ...(value.supports_thinking_type === "only" || value.supports_thinking_type === "no" || value.supports_thinking_type === "both"
                    ? { thinkingType: value.supports_thinking_type } : {}),
                ...(Array.isArray(efforts?.valid_efforts) && efforts.valid_efforts.every((item) => typeof item === "string")
                    ? { efforts: efforts.valid_efforts } : {}),
                ...(typeof efforts?.default_effort === "string" ? { defaultEffort: efforts.default_effort } : {}),
            });
        }
        return models;
    }
    catch {
        return null;
    }
}
