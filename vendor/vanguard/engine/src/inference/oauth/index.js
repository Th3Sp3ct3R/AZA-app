import { spawn } from "node:child_process";
import { clearAnthropicTokens, loadAnthropicTokens, runAnthropicLoginFlow, } from "./anthropicOAuth.js";
import { clearOpenAITokens, loadOpenAITokens, openAIPlanType, runOpenAILoginFlow, } from "./openaiOAuth.js";
import { clearKimiTokens, loadKimiTokens, runKimiLoginFlow, } from "./kimiOAuth.js";
import { vanguardHome } from "./store.js";
export const OAUTH_PROVIDER_LABELS = {
    anthropic: "Claude (Pro / Max subscription)",
    openai: "ChatGPT (Plus / Pro subscription)",
    kimi: "Kimi Code subscription",
};
export function isOAuthProvider(value) {
    return value === "anthropic" || value === "openai" || value === "kimi";
}
export function openBrowser(url) {
    const [command, args] = process.platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", url]]
        : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
    try {
        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => { });
        child.unref();
    }
    catch {
    }
}
export async function oauthStatus(provider) {
    const home = vanguardHome();
    if (provider === "anthropic") {
        const tokens = await loadAnthropicTokens();
        if (tokens === null)
            return { provider, connected: false, home };
        return {
            provider,
            connected: true,
            expiresAt: tokens.expiresAt,
            expired: Date.now() >= tokens.expiresAt,
            home,
        };
    }
    if (provider === "kimi") {
        const tokens = await loadKimiTokens();
        if (tokens === null)
            return { provider, connected: false, home };
        return {
            provider,
            connected: true,
            expiresAt: tokens.expiresAt,
            expired: Date.now() >= tokens.expiresAt,
            home,
        };
    }
    const tokens = await loadOpenAITokens();
    if (tokens === null)
        return { provider, connected: false, home };
    const account = tokens.profile.email ?? tokens.accountId;
    return {
        provider,
        connected: true,
        expiresAt: tokens.expiresAt,
        expired: Date.now() >= tokens.expiresAt,
        ...(account === undefined ? {} : { account }),
        ...(openAIPlanType(tokens) === undefined ? {} : { plan: openAIPlanType(tokens) }),
        home,
    };
}
export async function oauthLogin(provider, options = {}) {
    const open = (url) => {
        options.onAuthorizeUrl?.(url);
        openBrowser(url);
    };
    if (provider === "anthropic") {
        await runAnthropicLoginFlow(open, options.fetchImpl ?? fetch, options.timeoutMs ?? 300_000, options.force === true);
    }
    else if (provider === "openai") {
        await runOpenAILoginFlow(open, {
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.force === undefined ? {} : { force: options.force }),
        });
    }
    else
        await runKimiLoginFlow({
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.force === undefined ? {} : { force: options.force }),
            onDeviceAuthorization: (authorization) => open(authorization.verificationUriComplete),
        });
    return oauthStatus(provider);
}
export async function oauthLogout(provider) {
    if (provider === "anthropic")
        await clearAnthropicTokens();
    else if (provider === "openai")
        await clearOpenAITokens();
    else
        await clearKimiTokens();
}
export { ANTHROPIC_OAUTH_BETA, ANTHROPIC_OAUTH_IDENTITY, ANTHROPIC_OAUTH_USER_AGENT, ANTHROPIC_OAUTH_X_APP, clearAnthropicTokens, fetchClaudeModels, finishAnthropicLogin, loadAnthropicTokens, refreshAnthropicTokens, resolveAnthropicAccessToken, runAnthropicLoginFlow, saveAnthropicTokens, startAnthropicLogin, } from "./anthropicOAuth.js";
export { CODEX_RESPONSES_URL, clearOpenAITokens, fetchCodexModels, loadOpenAITokens, openAIPlanType, refreshOpenAITokens, resolveOpenAIAccessToken, runOpenAILoginFlow, } from "./openaiOAuth.js";
export { KIMI_CHAT_COMPLETIONS_URL, KIMI_CODING_BASE_URL, KIMI_OAUTH_CLIENT_ID, KIMI_OAUTH_HOST, clearKimiTokens, fetchKimiModels, loadKimiTokens, kimiRequestHeaders, refreshKimiTokens, requestKimiDeviceAuthorization, resolveKimiAccessToken, runKimiLoginFlow, } from "./kimiOAuth.js";
export { vanguardHome } from "./store.js";
