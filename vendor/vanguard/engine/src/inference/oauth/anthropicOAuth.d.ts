/** Beta flags a Claude subscription token must present to the Messages API. */
export declare const ANTHROPIC_OAUTH_BETA: string;
export declare const ANTHROPIC_OAUTH_USER_AGENT = "claude-cli/2.1.160";
export declare const ANTHROPIC_OAUTH_X_APP = "cli";
/**
 * Required byte-for-byte as system block 0 when authenticating with a
 * subscription token; the request is rejected without it. It names the
 * transport, not this agent — Vanguard's own system prompt follows it.
 */
export declare const ANTHROPIC_OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export interface AnthropicOAuthTokens {
    readonly accessToken: string;
    readonly refreshToken: string;
    /** Epoch ms when the access token expires. */
    readonly expiresAt: number;
    readonly scopes?: readonly string[];
}
export interface AnthropicAuthChallenge {
    readonly authorizeUrl: string;
    readonly pkceVerifier: string;
    readonly state: string;
    readonly port: number;
    readonly redirectUri: string;
}
export declare function startAnthropicLogin(): AnthropicAuthChallenge;
/**
 * Full loopback sign-in. A still-valid stored login is returned as-is and an
 * expiring one is refreshed silently; only a genuinely absent or rejected
 * credential opens the browser. Pass `force` to always re-authorize, which is
 * what an explicit `vanguard login` needs in order to switch accounts.
 */
export declare function runAnthropicLoginFlow(openUrl: (url: string) => void, fetchImpl?: typeof fetch, timeoutMs?: number, force?: boolean): Promise<AnthropicOAuthTokens>;
/** Complete a manually pasted callback URL or authorization code. */
export declare function finishAnthropicLogin(rawCode: string, pkceVerifier: string, expectedState: string, fetchImpl?: typeof fetch): Promise<AnthropicOAuthTokens>;
export declare function loadAnthropicTokens(): Promise<AnthropicOAuthTokens | null>;
export declare function saveAnthropicTokens(tokens: AnthropicOAuthTokens): Promise<void>;
export declare function clearAnthropicTokens(): Promise<void>;
/** Trade the refresh token for a fresh access token, persisting the result. */
export declare function refreshAnthropicTokens(tokens: AnthropicOAuthTokens, fetchImpl?: typeof fetch): Promise<AnthropicOAuthTokens>;
/**
 * Return a usable access token, refreshing transparently. Null means the owner
 * has not signed in — callers turn that into an actionable message rather than
 * an opaque 401 from the provider.
 */
export declare function resolveAnthropicAccessToken(fetchImpl?: typeof fetch): Promise<string | null>;
export interface ClaudeModel {
    readonly id: string;
    readonly label?: string;
}
/**
 * Ask the signed-in Claude subscription which models it actually serves.
 *
 * Advisory, exactly like the Codex listing: `null` means the question could
 * not be asked (offline, timeout, no token) and `[]` is a live "none" answer.
 * Either way the static catalog remains the fallback and the real completion
 * request stays the only authority — a listing must never veto a launch.
 */
export declare function fetchClaudeModels(fetchImpl?: typeof fetch): Promise<ClaudeModel[] | null>;
