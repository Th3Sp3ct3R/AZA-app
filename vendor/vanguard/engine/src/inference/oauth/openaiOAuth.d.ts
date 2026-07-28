/** The only endpoint a ChatGPT subscription token can call. */
export declare const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export interface OpenAIOAuthProfile {
    readonly email?: string;
    readonly planType?: string;
    readonly userId?: string;
}
export interface OpenAIOAuthTokens {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly idToken: string;
    /** Epoch ms when the access token expires. */
    readonly expiresAt: number;
    /** Sent as ChatGPT-Account-ID; required for org-scoped accounts. */
    readonly accountId?: string;
    readonly profile: OpenAIOAuthProfile;
}
export interface OpenAILoginOptions {
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    /** Always re-authorize instead of reusing a stored login, so accounts can be switched. */
    readonly force?: boolean;
}
/** Full loopback ChatGPT sign-in; reuses or refreshes a stored login first. */
export declare function runOpenAILoginFlow(openUrl: (url: string) => void, options?: OpenAILoginOptions): Promise<OpenAIOAuthTokens>;
export declare function loadOpenAITokens(): Promise<OpenAIOAuthTokens | null>;
/**
 * The account's subscription tier. Prefers the stored profile but falls back to
 * the id_token, so a login written before the plan claim was parsed correctly
 * still reports its plan without forcing a re-login.
 */
export declare function openAIPlanType(tokens: OpenAIOAuthTokens): string | undefined;
export declare function saveOpenAITokens(tokens: OpenAIOAuthTokens): Promise<void>;
export declare function clearOpenAITokens(): Promise<void>;
export declare function refreshOpenAITokens(tokens: OpenAIOAuthTokens, fetchImpl?: typeof fetch): Promise<OpenAIOAuthTokens>;
export interface OpenAIAccessToken {
    readonly token: string;
    readonly accountId?: string;
}
/** Return a usable ChatGPT access token, refreshing transparently. */
export declare function resolveOpenAIAccessToken(fetchImpl?: typeof fetch): Promise<OpenAIAccessToken | null>;
export interface CodexModel {
    readonly id: string;
    readonly label?: string;
}
/**
 * Ask the signed-in account which Codex models it actually offers.
 *
 * The empty/failed distinction still matters — `null` means the question could
 * not be asked (offline, timeout, no token); `[]` is a live endpoint answering
 * "none" — but the answer is advisory either way. The listing has mis-reported
 * real plans (Pro Lite answered `[]` while its Codex access worked), so
 * callers must degrade an empty answer to the static catalog with a warning
 * rather than refusing to run; the actual completion request is the only
 * authority on access.
 */
export declare function fetchCodexModels(fetchImpl?: typeof fetch): Promise<CodexModel[] | null>;
