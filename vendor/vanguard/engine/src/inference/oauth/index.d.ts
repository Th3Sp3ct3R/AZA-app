export type OAuthProvider = "anthropic" | "openai" | "kimi";
export declare const OAUTH_PROVIDER_LABELS: Readonly<Record<OAuthProvider, string>>;
export declare function isOAuthProvider(value: string): value is OAuthProvider;
export interface OAuthStatus {
    readonly provider: OAuthProvider;
    readonly connected: boolean;
    /** Epoch ms; absent when not connected. */
    readonly expiresAt?: number;
    readonly expired?: boolean;
    readonly account?: string;
    /** Subscription tier as the provider reports it, e.g. "plus", "pro", "prolite". */
    readonly plan?: string;
    readonly home: string;
}
/**
 * Open the system browser. Detached and fully redirected so a browser that logs
 * to stdout can never corrupt the TUI's frame, and so Vanguard's exit does not
 * wait on it.
 */
export declare function openBrowser(url: string): void;
export declare function oauthStatus(provider: OAuthProvider): Promise<OAuthStatus>;
export interface LoginOptions {
    /** Receives the authorize URL so a caller can print it before the browser opens. */
    readonly onAuthorizeUrl?: (url: string) => void;
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    /**
     * Re-authorize even when a valid token is stored. An explicit `vanguard login`
     * sets this: without it, signing in while already connected would report
     * success while silently keeping the previous account.
     */
    readonly force?: boolean;
}
/** Run the interactive sign-in for one provider. Resolves once tokens are stored. */
export declare function oauthLogin(provider: OAuthProvider, options?: LoginOptions): Promise<OAuthStatus>;
export declare function oauthLogout(provider: OAuthProvider): Promise<void>;
export { ANTHROPIC_OAUTH_BETA, ANTHROPIC_OAUTH_IDENTITY, ANTHROPIC_OAUTH_USER_AGENT, ANTHROPIC_OAUTH_X_APP, clearAnthropicTokens, fetchClaudeModels, finishAnthropicLogin, loadAnthropicTokens, refreshAnthropicTokens, resolveAnthropicAccessToken, runAnthropicLoginFlow, saveAnthropicTokens, startAnthropicLogin, } from "./anthropicOAuth.js";
export type { AnthropicAuthChallenge, AnthropicOAuthTokens, ClaudeModel } from "./anthropicOAuth.js";
export { CODEX_RESPONSES_URL, clearOpenAITokens, fetchCodexModels, loadOpenAITokens, openAIPlanType, refreshOpenAITokens, resolveOpenAIAccessToken, runOpenAILoginFlow, } from "./openaiOAuth.js";
export type { CodexModel, OpenAIAccessToken, OpenAIOAuthTokens } from "./openaiOAuth.js";
export { KIMI_CHAT_COMPLETIONS_URL, KIMI_CODING_BASE_URL, KIMI_OAUTH_CLIENT_ID, KIMI_OAUTH_HOST, clearKimiTokens, fetchKimiModels, loadKimiTokens, kimiRequestHeaders, refreshKimiTokens, requestKimiDeviceAuthorization, resolveKimiAccessToken, runKimiLoginFlow, } from "./kimiOAuth.js";
export type { KimiDeviceAuthorization, KimiModel, KimiOAuthTokens } from "./kimiOAuth.js";
export { vanguardHome } from "./store.js";
