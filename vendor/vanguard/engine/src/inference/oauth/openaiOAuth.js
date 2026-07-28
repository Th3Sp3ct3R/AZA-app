import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { base64url, decodeJwtClaims, oauthFilePath, readJsonFile, removeFile, shortDetail, writeJsonFile } from "./store.js";
const OAUTH_ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT = 1455;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid profile email offline_access";
const REFRESH_SKEW_MS = 60_000;
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
function authFile() {
    return oauthFilePath("openai-oauth.json");
}
function page(title, body) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>`
        + `<body style="font-family:system-ui;background:#0a0a0a;color:#e6e6e6;display:flex;`
        + `align-items:center;justify-content:center;height:100vh;margin:0">`
        + `<h2 style="font-weight:500">${body}</h2></body></html>`;
}
export async function runOpenAILoginFlow(openUrl, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const existing = options.force === true ? null : await loadOpenAITokens();
    if (existing !== null && Date.now() < existing.expiresAt - REFRESH_SKEW_MS)
        return existing;
    if (existing !== null && existing.refreshToken.length > 0) {
        try {
            return await refreshOpenAITokens(existing, fetchImpl);
        }
        catch {
        }
    }
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(24));
    const authorizeUrl = new URL(`${OAUTH_ISSUER}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("scope", SCOPE);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("id_token_add_organizations", "true");
    authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
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
                response.writeHead(400, html);
                response.end(page("Sign-in failed", "ChatGPT sign-in was not completed. You can close this tab."));
                finish(new Error(`ChatGPT authorization failed (${providerError})`));
                return;
            }
            if (code.length === 0 || returnedState !== state) {
                response.writeHead(400, html);
                response.end(page("Sign-in failed", "ChatGPT sign-in failed. Close this tab and try again."));
                finish(new Error("ChatGPT OAuth callback had a missing code or invalid state."));
                return;
            }
            void exchangeCode(code, verifier, fetchImpl)
                .then((tokens) => {
                response.writeHead(200, html);
                response.end(page("Connected", "Signed in to Vanguard with ChatGPT. You can close this tab."));
                finish(undefined, tokens);
            })
                .catch((error) => {
                response.writeHead(502, html);
                response.end(page("Sign-in failed", "ChatGPT approved access, but the token exchange failed."));
                finish(error instanceof Error ? error : new Error(String(error)));
            });
        });
        const deadline = setTimeout(() => finish(new Error("ChatGPT sign-in timed out after 5 minutes. Try again.")), timeoutMs);
        server.once("error", (error) => {
            finish(new Error(error.code === "EADDRINUSE"
                ? `Port ${CALLBACK_PORT} is already in use. Close any other ChatGPT or Codex sign-in and try again.`
                : `Could not start the ChatGPT auth callback on ${REDIRECT_URI}: ${error.message}`));
        });
        server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
            try {
                openUrl(authorizeUrl.toString());
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
}
function authClaims(idToken) {
    const auth = decodeJwtClaims(idToken)["https://api.openai.com/auth"];
    if (auth === null || typeof auth !== "object" || Array.isArray(auth))
        return {};
    return auth;
}
function readProfile(idToken) {
    const claims = decodeJwtClaims(idToken);
    const email = typeof claims.email === "string" ? claims.email : undefined;
    const nested = authClaims(idToken).chatgpt_plan_type;
    const planType = typeof nested === "string"
        ? nested
        : typeof claims.plan_type === "string" ? claims.plan_type : undefined;
    const userId = typeof claims.sub === "string" ? claims.sub : undefined;
    return {
        ...(email === undefined ? {} : { email }),
        ...(planType === undefined ? {} : { planType }),
        ...(userId === undefined ? {} : { userId }),
    };
}
function readAccountId(idToken) {
    const accountId = authClaims(idToken).chatgpt_account_id;
    return typeof accountId === "string" ? accountId : undefined;
}
async function postToken(body, fetchImpl, action) {
    const response = await fetchImpl(`${OAUTH_ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(body).toString(),
    });
    if (!response.ok) {
        const detail = shortDetail(await response.text().catch(() => ""));
        throw new Error(`ChatGPT ${action} failed (${response.status})${detail.length === 0 ? "" : `: ${detail}`}`);
    }
    return (await response.json());
}
async function exchangeCode(code, verifier, fetchImpl) {
    const body = await postToken({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
    }, fetchImpl, "token exchange");
    if (body.access_token === undefined || body.refresh_token === undefined) {
        throw new Error("ChatGPT token exchange returned an incomplete token response.");
    }
    const idToken = body.id_token ?? "";
    const accountId = body.account_id ?? readAccountId(idToken);
    const tokens = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        idToken,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        ...(accountId === undefined ? {} : { accountId }),
        profile: readProfile(idToken),
    };
    await saveOpenAITokens(tokens);
    return tokens;
}
function validTokens(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    if (typeof row.accessToken !== "string" || row.accessToken.length === 0)
        return null;
    const profile = row.profile !== undefined && typeof row.profile === "object" && !Array.isArray(row.profile)
        ? row.profile
        : {};
    return {
        accessToken: row.accessToken,
        refreshToken: typeof row.refreshToken === "string" ? row.refreshToken : "",
        idToken: typeof row.idToken === "string" ? row.idToken : "",
        expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : 0,
        ...(typeof row.accountId === "string" ? { accountId: row.accountId } : {}),
        profile,
    };
}
export async function loadOpenAITokens() {
    return validTokens(await readJsonFile(authFile()));
}
export function openAIPlanType(tokens) {
    if (tokens.profile.planType !== undefined)
        return tokens.profile.planType;
    const claim = authClaims(tokens.idToken).chatgpt_plan_type;
    return typeof claim === "string" ? claim : undefined;
}
export async function saveOpenAITokens(tokens) {
    await writeJsonFile(authFile(), tokens);
}
export async function clearOpenAITokens() {
    await removeFile(authFile());
}
let refreshInFlight = null;
export async function refreshOpenAITokens(tokens, fetchImpl = fetch) {
    if (refreshInFlight !== null)
        return refreshInFlight;
    if (tokens.refreshToken.length === 0)
        throw new Error("ChatGPT OAuth refresh token is missing.");
    refreshInFlight = (async () => {
        try {
            const body = await postToken({
                grant_type: "refresh_token",
                client_id: CLIENT_ID,
                refresh_token: tokens.refreshToken,
            }, fetchImpl, "token refresh");
            if (body.access_token === undefined)
                throw new Error("ChatGPT token refresh returned no access token.");
            const idToken = body.id_token ?? tokens.idToken;
            const accountId = tokens.accountId ?? readAccountId(idToken);
            const next = {
                accessToken: body.access_token,
                refreshToken: body.refresh_token ?? tokens.refreshToken,
                idToken,
                expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
                ...(accountId === undefined ? {} : { accountId }),
                profile: idToken.length > 0 ? readProfile(idToken) : tokens.profile,
            };
            await saveOpenAITokens(next);
            return next;
        }
        finally {
            refreshInFlight = null;
        }
    })();
    return refreshInFlight;
}
export async function resolveOpenAIAccessToken(fetchImpl = fetch) {
    const environmentToken = process.env.VANGUARD_OPENAI_OAUTH_TOKEN?.trim();
    if (environmentToken !== undefined && environmentToken.length > 0)
        return { token: environmentToken };
    let tokens = await loadOpenAITokens();
    if (tokens === null)
        return null;
    if (Date.now() >= tokens.expiresAt - REFRESH_SKEW_MS) {
        try {
            tokens = await refreshOpenAITokens(tokens, fetchImpl);
        }
        catch {
            return null;
        }
    }
    return {
        token: tokens.accessToken,
        ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId }),
    };
}
export async function fetchCodexModels(fetchImpl = fetch) {
    const auth = await resolveOpenAIAccessToken(fetchImpl);
    if (auth === null)
        return null;
    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${auth.token}`,
        originator: "vanguard",
        "User-Agent": "vanguard",
    };
    if (auth.accountId !== undefined)
        headers["ChatGPT-Account-ID"] = auth.accountId;
    try {
        const response = await fetchImpl("https://chatgpt.com/backend-api/codex/models?client_version=0.50.0", {
            headers,
            signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok)
            return null;
        const body = (await response.json());
        const rows = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : null;
        if (rows === null)
            return null;
        const models = [];
        for (const row of rows) {
            if (row === null || typeof row !== "object")
                continue;
            const record = row;
            const id = record.slug ?? record.id ?? record.model ?? record.name;
            if (typeof id !== "string" || id.length === 0)
                continue;
            const label = record.title ?? record.display_name ?? record.name;
            models.push({ id, ...(typeof label === "string" ? { label } : {}) });
        }
        return models;
    }
    catch {
        return null;
    }
}
