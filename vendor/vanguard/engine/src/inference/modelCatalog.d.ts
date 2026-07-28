import type { ProviderIdentity } from "./providerProfiles.js";
import { type OAuthProvider } from "./oauth/index.js";
export type SelectableProvider = Extract<ProviderIdentity, "deepseek" | "openai" | "anthropic" | "kimi" | "ollama">;
export type AuthKind = "api-key" | "oauth";
export interface ModelChoice {
    readonly id: string;
    readonly note?: string;
}
export interface ProviderChoice {
    readonly id: SelectableProvider;
    readonly label: string;
    /** Auth methods this provider accepts, best first. */
    readonly auth: readonly AuthKind[];
    readonly credentialVariable: string;
    readonly models: readonly ModelChoice[];
    /**
     * Model ids a subscription sign-in accepts, when they differ from the API
     * ids. The Codex backend rejects bare API aliases (gpt-5.6 is API-only), so
     * offering the API list to a ChatGPT account produces instant HTTP 400s.
     */
    readonly oauthModels?: readonly ModelChoice[];
}
export declare const PROVIDER_CHOICES: readonly ProviderChoice[];
export declare function providerChoice(provider: SelectableProvider): ProviderChoice;
/** The static menu for a provider under a given auth method. */
export declare function catalogModels(provider: SelectableProvider, auth: AuthKind): readonly ModelChoice[];
export declare function supportsOAuth(provider: SelectableProvider): provider is SelectableProvider & OAuthProvider;
export declare function defaultModel(provider: SelectableProvider): string;
export declare function credentialVariable(provider: SelectableProvider): string;
export declare function parseSelectableProvider(value: string): SelectableProvider | undefined;
/**
 * The context-byte budget a session should start from for one exact model.
 * With a known window, the sticky-context epoch machinery compacts
 * proactively instead of only after a provider rejection; without one, the
 * broad ceiling plus learned adaptation applies.
 */
export declare function defaultContextBytes(model: string): number;
/** The published context window in tokens, when the model family is known. */
export declare function contextWindowTokens(model: string): number | undefined;
