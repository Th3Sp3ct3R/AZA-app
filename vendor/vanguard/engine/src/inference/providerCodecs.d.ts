import type { JsonValue, ModelDecision } from "../kernel/contracts.js";
import { HttpModelAdapter, type ModelWireCodec, type SerializableModelRequest, type StreamAccumulator, type InferenceDiagnostic, type StreamObserver } from "./httpModel.js";
import { type ProviderCapabilities, type ProviderCapabilityOverrides, type ProviderConnectionConfigV1, type ResolvedProviderProfile } from "./providerProfiles.js";
/**
 * Model families differ in tool-call reliability and narration habits; the
 * shared invariants above stay single-source while each family gets a short
 * style delta tuned to its observed failure modes.
 */
export type ModelFamily = "anthropic" | "openai" | "deepseek" | "local";
export interface ProviderModelOptions {
    readonly model: string;
    readonly endpoint?: string;
    readonly credentialVariable?: string;
    readonly capabilities?: ProviderCapabilityOverrides;
    readonly apiVersion?: string;
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly maxRetryAfterMs?: number;
    readonly fetchImplementation?: typeof fetch;
    readonly disableStreaming?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
    readonly onDiagnostic?: (diagnostic: InferenceDiagnostic) => void;
    /** Receives user-visible response text as it streams. */
    readonly onTextDelta?: (text: string) => void;
    /** Full provisional-stream lifecycle observer. Supersedes onTextDelta when set. */
    readonly streamObserver?: StreamObserver;
}
export type ConfiguredProviderRuntimeOptions = Omit<ProviderModelOptions, "model" | "endpoint" | "credentialVariable" | "capabilities" | "apiVersion">;
export declare function createOpenAIModel(options: ProviderModelOptions): HttpModelAdapter;
export declare function createAnthropicModel(options: ProviderModelOptions): HttpModelAdapter;
export declare function createDeepSeekModel(options: ProviderModelOptions): HttpModelAdapter;
export declare function createOllamaModel(options: ProviderModelOptions): HttpModelAdapter;
export declare function createConfiguredProviderModel(config: ProviderConnectionConfigV1 | ResolvedProviderProfile, options?: ConfiguredProviderRuntimeOptions): HttpModelAdapter;
/**
 * A stable cache-routing key for one prefix shape. Hashing the model, the mode
 * instructions, and the sorted tool names captures exactly what sits in the
 * cacheable prefix: it is identical on every turn of a session (so the backend
 * route is warm) yet distinct across modes or tool surfaces (so a cold prefix
 * never rides a mismatched cache bucket).
 */
export declare function promptCacheKey(model: string, instructions: string, tools: readonly {
    readonly name: string;
}[]): string;
export declare class OpenAIResponsesCodec implements ModelWireCodec {
    #private;
    private readonly model;
    private readonly capabilities;
    private readonly reasoningEffort?;
    constructor(model: string, capabilities?: ProviderCapabilities, reasoningEffort?: "low" | "medium" | "high" | undefined);
    encode(request: SerializableModelRequest): JsonValue;
    encodeStreaming(request: SerializableModelRequest): JsonValue;
    createStreamAccumulator(onTextDelta?: (text: string) => void, onThinkingDelta?: (text: string) => void): StreamAccumulator;
    decode(response: JsonValue): ModelDecision;
}
export declare class AnthropicMessagesCodec implements ModelWireCodec {
    #private;
    private readonly model;
    private readonly maxTokens;
    private readonly capabilities;
    private readonly thinkingBudgetTokens?;
    /** Prepend the OAuth contract identity block; set only for subscription tokens. */
    private readonly oauthIdentity;
    constructor(model: string, maxTokens?: number, capabilities?: ProviderCapabilities, thinkingBudgetTokens?: number | undefined, 
    /** Prepend the OAuth contract identity block; set only for subscription tokens. */
    oauthIdentity?: boolean);
    encode(request: SerializableModelRequest): JsonValue;
    encodeStreaming(request: SerializableModelRequest): JsonValue;
    createStreamAccumulator(onTextDelta?: (text: string) => void, onThinkingDelta?: (text: string) => void): StreamAccumulator;
    decode(response: JsonValue): ModelDecision;
}
export declare class OpenAIChatCompletionsCodec implements ModelWireCodec {
    #private;
    private readonly model;
    private readonly capabilities;
    private readonly family;
    private readonly kimi?;
    constructor(model: string, capabilities?: ProviderCapabilities, family?: ModelFamily, kimi?: {
        readonly maxCompletionTokens: number;
        readonly thinking: "enabled" | "disabled";
        readonly effort?: "low" | "medium" | "high" | "max";
    } | undefined);
    encode(request: SerializableModelRequest): JsonValue;
    encodeStreaming(request: SerializableModelRequest): JsonValue;
    createStreamAccumulator(onTextDelta?: (text: string) => void, onThinkingDelta?: (text: string) => void): StreamAccumulator;
    decode(response: JsonValue): ModelDecision;
}
