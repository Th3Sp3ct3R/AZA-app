import type { OAuthProvider } from "./oauth/index.js";
export declare const VANGUARD_PROVIDER_CONFIG_VERSION: 1;
export type ProviderIdentity = "openai" | "anthropic" | "deepseek" | "kimi" | "ollama" | "openai-compatible";
export type ProviderWireProtocol = "openai-responses" | "openai-chat-completions" | "anthropic-messages";
export interface ProviderCapabilities {
    readonly streaming: boolean;
    readonly parallelToolCalls: boolean;
    readonly streamUsage: boolean;
    /** Preserve opaque reasoning/thinking items for the provider's next turn. */
    readonly continuationReplay: boolean;
}
export interface ProviderCapabilityOverrides {
    readonly streaming?: boolean;
    readonly parallelToolCalls?: boolean;
    readonly streamUsage?: boolean;
    readonly continuationReplay?: boolean;
}
export interface EnvironmentCredentialConfig {
    readonly source: "environment";
    readonly variable: string;
}
/**
 * A subscription credential minted by Vanguard's own OAuth flow and held in
 * ~/.vanguard. Unlike an API key it is short-lived and refreshed per request,
 * so the profile records only which provider issued it — never a token value,
 * and never a token this process did not mint.
 */
export interface OAuthCredentialConfig {
    readonly source: "oauth";
    readonly provider: OAuthProvider;
}
export type ProviderCredentialConfig = EnvironmentCredentialConfig | OAuthCredentialConfig;
/**
 * Optional reasoning configuration. Each field is honored only by the wire
 * contract that can express it and rejected everywhere else, so a config
 * cannot silently claim reasoning that the provider never performs.
 */
export interface ProviderReasoningConfig {
    /** Anthropic Messages extended thinking budget in tokens (min 1024). */
    readonly thinkingBudgetTokens?: number;
    /** OpenAI Responses reasoning effort. */
    readonly effort?: "low" | "medium" | "high" | "max";
    /** Kimi Chat Completions thinking mode. */
    readonly thinking?: "enabled" | "disabled";
}
/**
 * Portable, versioned provider connection configuration. It contains only
 * credential provenance, never credential values.
 */
export interface ProviderConnectionConfigV1 {
    readonly version: typeof VANGUARD_PROVIDER_CONFIG_VERSION;
    readonly provider: ProviderIdentity;
    readonly model: string;
    readonly endpoint?: string;
    readonly wire?: ProviderWireProtocol;
    readonly credential?: ProviderCredentialConfig;
    readonly capabilities?: ProviderCapabilityOverrides;
    /** Required header version for Anthropic Messages; ignored nowhere else. */
    readonly apiVersion?: string;
    /** Maximum output tokens per response; defaults to 16384. */
    readonly maxOutputTokens?: number;
    readonly reasoning?: ProviderReasoningConfig;
}
export interface EnvironmentCredentialProvenance {
    readonly source: "environment";
    readonly variable: string;
    readonly present: boolean;
}
export interface OAuthCredentialProvenance {
    readonly source: "oauth";
    readonly provider: OAuthProvider;
    /**
     * An OAuth token is read (and refreshed) from disk when a request is built,
     * not when the profile resolves, so presence is deliberately not asserted
     * here. Profile resolution stays synchronous and side-effect free.
     */
    readonly resolvedAtRequestTime: true;
}
export type CredentialProvenance = EnvironmentCredentialProvenance | OAuthCredentialProvenance;
export interface ResolvedProviderProfile {
    readonly version: typeof VANGUARD_PROVIDER_CONFIG_VERSION;
    readonly provider: ProviderIdentity;
    readonly model: string;
    readonly endpoint: string;
    readonly wire: ProviderWireProtocol;
    readonly credential: ProviderCredentialConfig;
    readonly credentialProvenance: CredentialProvenance;
    readonly capabilities: ProviderCapabilities;
    readonly apiVersion?: string;
    readonly maxOutputTokens: number;
    readonly reasoning?: ProviderReasoningConfig;
    /**
     * Local inference servers such as Ollama accept unauthenticated loopback
     * requests; when true, a missing credential variable sends no Authorization
     * header instead of failing the request.
     */
    readonly credentialOptional: boolean;
}
/**
 * Resolves capabilities for one exact provider/model profile. Vanguard never
 * guesses from model-name substrings: explicit per-profile declarations win,
 * otherwise only public wire-contract capabilities are used.
 */
export declare function resolveProviderProfile(input: ProviderConnectionConfigV1, environment?: NodeJS.ProcessEnv): ResolvedProviderProfile;
export declare function readProviderProfile(file: string, environment?: NodeJS.ProcessEnv): Promise<ResolvedProviderProfile>;
/** A diagnostic-safe projection; credential values are impossible to include. */
export declare function describeProviderProfile(profile: ResolvedProviderProfile): Record<string, unknown>;
