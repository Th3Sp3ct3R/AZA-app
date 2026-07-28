import type { JsonValue } from "../kernel/contracts.js";
import type { StreamObserver } from "./httpModel.js";
export interface NormalizedUsage {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly calls: number;
}
export interface EstimatedCost {
    readonly model: string;
    readonly inputCostUsd: number;
    readonly cachedInputCostUsd: number;
    readonly outputCostUsd: number;
    readonly totalCostUsd: number;
}
export interface ModelPrice {
    /** USD per million input (uncached) tokens. */
    readonly inputPerMillion: number;
    /** USD per million cached input tokens. */
    readonly cachedInputPerMillion: number;
    /** USD per million output tokens. */
    readonly outputPerMillion: number;
}
/**
 * Published list prices as of the frozen evaluation window. Overridable via
 * configuration; unknown models produce a null cost estimate rather than a
 * fabricated one, so cost is never silently invented.
 */
export declare const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>>;
/**
 * Accumulates provider usage across a session, normalizing the three wire
 * shapes (Chat Completions, Anthropic Messages, OpenAI Responses) into one
 * schema. Feeds the scorecard's usage and estimated-cost fields.
 */
export interface CacheEfficiency {
    /** Calls whose usage payload carried recognizable token counts. */
    readonly calls: number;
    /** Fraction of all input tokens served from the provider's cache, 0..1. */
    readonly hitRate: number;
    /** Cache hit rate of the most recent call alone, 0..1. */
    readonly lastCallHitRate: number;
}
export declare class UsageLedger {
    #private;
    private readonly model;
    constructor(model: string, prices?: Readonly<Record<string, ModelPrice>>);
    observer(): Pick<StreamObserver, "delta" | "usage">;
    record(usage: JsonValue): void;
    recordLatency(ms: number): void;
    usage(): NormalizedUsage;
    /**
     * How much of the input stream providers served from cache. A hit rate near
     * zero on a long run means the request prefix is unstable and every step is
     * paying full-price prefill; near one means the epoch prefix is holding.
     */
    cacheEfficiency(): CacheEfficiency;
    latencyMs(): {
        calls: number;
        totalMs: number;
        meanMs: number;
    };
    estimatedCost(): EstimatedCost | null;
}
/**
 * Normalizes one provider usage object. Returns undefined when the payload
 * carries no recognizable token counts.
 */
export declare function normalizeUsage(usage: JsonValue): NormalizedUsage | undefined;
