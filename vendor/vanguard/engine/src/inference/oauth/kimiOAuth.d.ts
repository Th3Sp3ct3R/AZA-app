export declare const KIMI_OAUTH_HOST = "https://auth.kimi.com";
export declare const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export declare const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
export declare const KIMI_CHAT_COMPLETIONS_URL = "https://api.kimi.com/coding/v1/chat/completions";
export interface KimiOAuthTokens {
    readonly accessToken: string;
    readonly refreshToken: string;
    /** Epoch milliseconds. */
    readonly expiresAt: number;
    readonly expiresIn: number;
    readonly scope: string;
    readonly tokenType: string;
}
export interface KimiDeviceAuthorization {
    readonly userCode: string;
    readonly deviceCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete: string;
    readonly expiresIn: number;
    readonly interval: number;
}
export interface KimiModel {
    readonly id: string;
    readonly contextLength?: number;
    readonly supportsReasoning?: boolean;
    readonly thinkingType?: "only" | "no" | "both";
    readonly efforts?: readonly string[];
    readonly defaultEffort?: string;
}
export declare function kimiRequestHeaders(): Promise<Record<string, string>>;
export declare function loadKimiTokens(): Promise<KimiOAuthTokens | null>;
export declare function clearKimiTokens(): Promise<void>;
export declare function requestKimiDeviceAuthorization(fetchImpl?: typeof fetch): Promise<KimiDeviceAuthorization>;
export interface KimiLoginOptions {
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    readonly force?: boolean;
    readonly onDeviceAuthorization?: (authorization: KimiDeviceAuthorization) => void;
}
export declare function runKimiLoginFlow(options?: KimiLoginOptions): Promise<KimiOAuthTokens>;
export declare function refreshKimiTokens(tokens: KimiOAuthTokens, fetchImpl?: typeof fetch): Promise<KimiOAuthTokens>;
export declare function resolveKimiAccessToken(fetchImpl?: typeof fetch): Promise<string | null>;
export declare function fetchKimiModels(fetchImpl?: typeof fetch): Promise<KimiModel[] | null>;
