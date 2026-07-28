import type { JsonValue, ModelDecision, ModelPort, ModelRequest } from "../kernel/contracts.js";
export interface SerializableModelRequest {
    readonly task: string;
    readonly mode: ModelRequest["mode"];
    readonly transcript: ModelRequest["transcript"];
    readonly tools: ModelRequest["tools"];
    readonly remainingSteps: number;
    readonly workingState: ModelRequest["workingState"];
}
/**
 * Rebuilds a provider's canonical response object from its SSE stream, so
 * the non-streaming decode path stays the single source of decision truth.
 */
export interface StreamAccumulator {
    /** Feeds one SSE data payload (the JSON text after "data:"). */
    feed(data: string): void;
    /** Records an out-of-band SSE terminal marker such as `data: [DONE]`. */
    terminal?(marker: "[DONE]"): void;
    /** Returns the reconstructed canonical response object. */
    finish(): JsonValue;
    /** Usage observed before a stream failed to reach a canonical response. */
    partialUsage?(): JsonValue | undefined;
}
export interface ModelWireCodec {
    encode(request: SerializableModelRequest): JsonValue;
    decode(response: JsonValue): ModelDecision;
    /** Optional streaming support: the encode payload with stream flags set. */
    encodeStreaming?(request: SerializableModelRequest): JsonValue;
    /**
     * Optional streaming support: an accumulator for one response. Only
     * user-visible text may reach onTextDelta — never reasoning or thinking.
     * Reasoning/thinking deltas may reach onThinkingDelta for live progress
     * display; the two channels never mix.
     */
    createStreamAccumulator?(onTextDelta?: (text: string) => void, onThinkingDelta?: (text: string) => void): StreamAccumulator;
}
export interface HeaderProvider {
    headers(): Promise<Readonly<Record<string, string>>>;
    /** Diagnostic-safe credential source metadata; never a credential value. */
    provenance?(): Readonly<Record<string, string | boolean>>;
}
/**
 * Observes the provisional-stream lifecycle of one model decision. Deltas
 * are provisional until committed; a reset means previously observed text
 * must be discarded because the attempt is being replayed.
 */
export interface StreamObserver {
    /** A streaming attempt has begun; any provisional text belongs to it. */
    started?(attempt: number): void;
    /** User-visible provisional text. Never reasoning or thinking. */
    delta(text: string): void;
    /** Live reasoning/thinking progress. Display-only; never part of the reply. */
    thinking?(text: string): void;
    /** Discard all provisional text; the response is being retried. */
    reset?(): void;
    /** The decision decoded successfully; provisional text is now final. */
    committed?(): void;
    /** The decision failed after all retries; provisional text is void. */
    failed?(reason: string): void;
    /** Provider-reported usage metadata for every completed, billable attempt. */
    usage?(usage: JsonValue): void;
}
export interface HttpModelOptions {
    readonly endpoint: string;
    readonly codec?: ModelWireCodec;
    readonly headerProvider?: HeaderProvider;
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly retryBaseMs?: number;
    /** Upper bound applied to provider Retry-After hints. Defaults to 60s. */
    readonly maxRetryAfterMs?: number;
    readonly fetchImplementation?: typeof fetch;
    /** Receives user-visible text as it streams. Enables SSE when the codec supports it. */
    readonly onTextDelta?: (text: string) => void;
    /** Full provisional-stream lifecycle observer. Supersedes onTextDelta when set. */
    readonly streamObserver?: StreamObserver;
    /** Forces the non-streaming request path even when the codec supports SSE. */
    readonly disableStreaming?: boolean;
    /** Receives sanitized lifecycle diagnostics only; headers and bodies are never included. */
    readonly onDiagnostic?: (diagnostic: InferenceDiagnostic) => void;
}
export type InferenceFailureKind = "authentication" | "rate_limit" | "context_length" | "invalid_request" | "server" | "protocol" | "transport" | "cancelled" | "timeout";
export interface InferenceDiagnostic {
    readonly kind: InferenceFailureKind | "retry" | "request";
    readonly attempt: number;
    readonly status?: number;
    readonly retryAfterMs?: number;
    readonly message: string;
}
export declare class InferenceError extends Error {
    readonly kind: InferenceFailureKind;
    readonly status?: number | undefined;
    readonly retryable: boolean;
    readonly retryAfterMs?: number | undefined;
    constructor(kind: InferenceFailureKind, message: string, status?: number | undefined, retryable?: boolean, retryAfterMs?: number | undefined);
}
export declare class HttpModelAdapter implements ModelPort {
    #private;
    private readonly options;
    constructor(options: HttpModelOptions);
    decide(request: ModelRequest): Promise<ModelDecision>;
}
export declare class EnvironmentBearerHeaders implements HeaderProvider {
    private readonly variable;
    private readonly environment;
    constructor(variable: string, environment?: NodeJS.ProcessEnv);
    headers(): Promise<Readonly<Record<string, string>>>;
    provenance(): Readonly<Record<string, string | boolean>>;
}
/**
 * Bearer headers for local inference servers: a present credential is sent,
 * a missing one sends no Authorization header at all. Only profiles that
 * declare credentialOptional (Ollama) may use this provider.
 */
export declare class OptionalBearerHeaders implements HeaderProvider {
    private readonly variable;
    private readonly environment;
    constructor(variable: string, environment?: NodeJS.ProcessEnv);
    headers(): Promise<Readonly<Record<string, string>>>;
    provenance(): Readonly<Record<string, string | boolean>>;
}
export declare class VanguardJsonCodec implements ModelWireCodec {
    encode(request: SerializableModelRequest): JsonValue;
    decode(response: JsonValue): ModelDecision;
}
export declare function parseRetryAfter(headers: Headers, maximumMs?: number): number | undefined;
export declare function sanitizeDiagnostic(value: string, maximumLength?: number, sensitiveValues?: readonly string[]): string;
