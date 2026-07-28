import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { base64url, oauthFilePath, readJsonFile, removeFile, shortDetail, writeJsonFile } from "./store.js";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_PORT = 53692;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const REFRESH_SKEW_MS = 60_000;
const SCOPES = [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
].join(" ");
export const ANTHROPIC_OAUTH_BETA = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "fine-grained-tool-streaming-2025-05-14",
    "interleaved-thinking-2025-05-14",
].join(",");
export const ANTHROPIC_OAUTH_USER_AGENT = "claude-cli/2.1.160";
export const ANTHROPIC_OAUTH_X_APP = "cli";
export const ANTHROPIC_OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
function authFile() {
    return oauthFilePath("anthropic-oauth.json");
}
export function startAnthropicLogin() {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = verifier;
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return {
        authorizeUrl: url.toString(),
        pkceVerifier: verifier,
        state,
        port: CALLBACK_PORT,
        redirectUri: REDIRECT_URI,
    };
}
function page(title, body) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>`
        + `<body style="font-family:system-ui;background:#0a0a0a;color:#e6e6e6;display:flex;`
        + `align-items:center;justify-content:center;height:100vh;margin:0">`
        + `<h2 style="font-weight:500">${body}</h2></body></html>`;
}
export async function runAnthropicLoginFlow(openUrl, fetchImpl = fetch, timeoutMs = 300_000, force = false) {
    const existing = force ? null : await loadAnthropicTokens();
    if (existing !== null && Date.now() < existing.expiresAt - REFRESH_SKEW_MS)
        return existing;
    if (existing !== null && existing.refreshToken.length > 0) {
        try {
            return await refreshAnthropicTokens(existing, fetchImpl);
        }
        catch {
        }
    }
    const auth = startAnthropicLogin();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, tokens) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(deadline);
            server.close();
            if (error !== undefined)
                reject(error);
            else if (tokens !== undefined)
                resolve(tokens);
        };
        const server = createServer((request, response) => {
            const requestUrl = new URL(request.url ?? "/", REDIRECT_URI);
            if (requestUrl.pathname !== CALLBACK_PATH) {
                response.writeHead(404);
                response.end();
                return;
            }
            const providerError = requestUrl.searchParams.get("error");
            const code = requestUrl.searchParams.get("code") ?? "";
            const returnedState = requestUrl.searchParams.get("state") ?? "";
            const html = { "Content-Type": "text/html; charset=utf-8" };
            if (providerError !== null) {
                const description = requestUrl.searchParams.get("error_description");
                response.writeHead(400, html);
                response.end(page("Sign-in failed", "Claude sign-in was not completed. You can close this tab."));
                finish(new Error(`Claude authorization failed (${providerError})${description === null ? "" : `: ${description}`}`));
                return;
            }
            if (code.length === 0 || returnedState !== auth.state) {
                response.writeHead(400, html);
                response.end(page("Sign-in failed", "Claude sign-in failed. Close this tab and try again."));
                finish(new Error("Claude OAuth callback had a missing code or invalid state."));
                return;
            }
            void exchangeCode(code, auth.pkceVerifier, fetchImpl)
                .then((tokens) => {
                response.writeHead(200, html);
                response.end(page("Connected", "Signed in to Vanguard. You can close this tab."));
                finish(undefined, tokens);
            })
                .catch((error) => {
                response.writeHead(502, html);
                response.end(page("Sign-in failed", "Claude approved access, but the token exchange failed."));
                finish(error instanceof Error ? error : new Error(String(error)));
            });
        });
        const deadline = setTimeout(() => finish(new Error("Claude sign-in timed out after 5 minutes. Try again.")), timeoutMs);
        server.once("error", (error) => {
            finish(new Error(error.code === "EADDRINUSE"
                ? `Port ${CALLBACK_PORT} is already in use. Close another Claude sign-in and try again.`
                : `Could not start the Claude auth callback on ${REDIRECT_URI}: ${error.message}`));
        });
        server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
            try {
                openUrl(auth.authorizeUrl);
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
}
async function exchangeCode(code, verifier, fetchImpl) {
    const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": ANTHROPIC_OAUTH_USER_AGENT,
        },
        body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            state: verifier,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
        }),
    });
    if (!response.ok) {
        const detail = shortDetail(await response.text().catch(() => ""));
        throw new Error(`Claude token exchange failed (${response.status})${detail.length === 0 ? "" : `: ${detail}`}`);
    }
    const body = (await response.json());
    if (body.access_token === undefined || body.refresh_token === undefined) {
        throw new Error("Claude token exchange returned an incomplete token response.");
    }
    const scopes = body.scope?.split(/\s+/u).filter((scope) => scope.length > 0);
    const tokens = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
    };
    await saveAnthropicTokens(tokens);
    return tokens;
}
export async function finishAnthropicLogin(rawCode, pkceVerifier, expectedState, fetchImpl = fetch) {
    const raw = rawCode.trim();
    let code = raw;
    let state = "";
    try {
        const url = new URL(raw);
        code = url.searchParams.get("code") ?? "";
        state = url.searchParams.get("state") ?? "";
    }
    catch {
        const [first, second] = raw.split("#", 2);
        code = first ?? "";
        state = second ?? "";
    }
    if (code.length === 0)
        throw new Error("Claude authorization code is missing.");
    if (state.length > 0 && state !== expectedState)
        throw new Error("Claude OAuth state mismatch.");
    return exchangeCode(code, pkceVerifier, fetchImpl);
}
function validTokens(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    if (typeof row.accessToken !== "string" || row.accessToken.length === 0)
        return null;
    const scopes = Array.isArray(row.scopes)
        ? row.scopes.filter((scope) => typeof scope === "string")
        : undefined;
    return {
        accessToken: row.accessToken,
        refreshToken: typeof row.refreshToken === "string" ? row.refreshToken : "",
        expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : 0,
        ...(scopes === undefined ? {} : { scopes }),
    };
}
export async function loadAnthropicTokens() {
    return validTokens(await readJsonFile(authFile()));
}
export async function saveAnthropicTokens(tokens) {
    await writeJsonFile(authFile(), tokens);
}
export async function clearAnthropicTokens() {
    await removeFile(authFile());
}
export async function refreshAnthropicTokens(tokens, fetchImpl = fetch) {
    if (tokens.refreshToken.length === 0)
        throw new Error("Claude OAuth refresh token is missing.");
    const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": ANTHROPIC_OAUTH_USER_AGENT,
        },
        body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: tokens.refreshToken,
        }),
    });
    if (!response.ok) {
        const detail = shortDetail(await response.text().catch(() => ""));
        throw new Error(`Claude token refresh failed (${response.status})${detail.length === 0 ? "" : `: ${detail}`}`);
    }
    const body = (await response.json());
    if (body.access_token === undefined)
        throw new Error("Claude token refresh returned no access token.");
    const scopes = body.scope === undefined
        ? tokens.scopes
        : body.scope.split(/\s+/u).filter((scope) => scope.length > 0);
    const next = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? tokens.refreshToken,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        ...(scopes === undefined ? {} : { scopes }),
    };
    await saveAnthropicTokens(next);
    return next;
}
export async function resolveAnthropicAccessToken(fetchImpl = fetch) {
    const environmentToken = process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN?.trim();
    if (environmentToken !== undefined && environmentToken.length > 0)
        return environmentToken;
    const tokens = await loadAnthropicTokens();
    if (tokens === null)
        return null;
    if (Date.now() < tokens.expiresAt - REFRESH_SKEW_MS)
        return tokens.accessToken;
    try {
        return (await refreshAnthropicTokens(tokens, fetchImpl)).accessToken;
    }
    catch {
        return null;
    }
}
export async function fetchClaudeModels(fetchImpl = fetch) {
    const token = await resolveAnthropicAccessToken(fetchImpl);
    if (token === null)
        return null;
    try {
        const response = await fetchImpl("https://api.anthropic.com/v1/models?limit=100", {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": ANTHROPIC_OAUTH_BETA,
                "User-Agent": ANTHROPIC_OAUTH_USER_AGENT,
                "x-app": ANTHROPIC_OAUTH_X_APP,
            },
            signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok)
            return null;
        const body = (await response.json());
        if (!Array.isArray(body.data))
            return null;
        const models = [];
        for (const row of body.data) {
            if (row === null || typeof row !== "object")
                continue;
            const record = row;
            const id = record.id;
            if (typeof id !== "string" || id.length === 0)
                continue;
            models.push({ id, ...(typeof record.display_name === "string" ? { label: record.display_name } : {}) });
        }
        return models;
    }
    catch {
        return null;
    }
}
