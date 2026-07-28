export const DEFAULT_MODEL_PRICES = {
    "deepseek-v4-pro": { inputPerMillion: 0.28, cachedInputPerMillion: 0.028, outputPerMillion: 0.42 },
    "gpt-5.6": { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
    "claude-opus-4-8": { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
};
const EMPTY = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 0,
};
export class UsageLedger {
    model;
    #total = EMPTY;
    #lastCall;
    #prices;
    #latenciesMs = [];
    constructor(model, prices = DEFAULT_MODEL_PRICES) {
        this.model = model;
        this.#prices = prices;
    }
    observer() {
        return {
            delta: () => { },
            usage: (usage) => this.record(usage),
        };
    }
    record(usage) {
        const normalized = normalizeUsage(usage);
        if (normalized === undefined)
            return;
        this.#lastCall = normalized;
        this.#total = {
            inputTokens: this.#total.inputTokens + normalized.inputTokens,
            cachedInputTokens: this.#total.cachedInputTokens + normalized.cachedInputTokens,
            outputTokens: this.#total.outputTokens + normalized.outputTokens,
            reasoningTokens: this.#total.reasoningTokens + normalized.reasoningTokens,
            calls: this.#total.calls + 1,
        };
    }
    recordLatency(ms) {
        if (Number.isFinite(ms) && ms >= 0)
            this.#latenciesMs.push(ms);
    }
    usage() {
        return this.#total;
    }
    cacheEfficiency() {
        const rate = (usage) => usage === undefined || usage.inputTokens <= 0
            ? 0
            : Math.min(1, usage.cachedInputTokens / usage.inputTokens);
        return {
            calls: this.#total.calls,
            hitRate: rate(this.#total),
            lastCallHitRate: rate(this.#lastCall),
        };
    }
    latencyMs() {
        const totalMs = this.#latenciesMs.reduce((sum, value) => sum + value, 0);
        const calls = this.#latenciesMs.length;
        return { calls, totalMs, meanMs: calls === 0 ? 0 : totalMs / calls };
    }
    estimatedCost() {
        const price = this.#prices[this.model];
        if (price === undefined)
            return null;
        const uncachedInput = Math.max(0, this.#total.inputTokens - this.#total.cachedInputTokens);
        const inputCostUsd = (uncachedInput / 1_000_000) * price.inputPerMillion;
        const cachedInputCostUsd = (this.#total.cachedInputTokens / 1_000_000) * price.cachedInputPerMillion;
        const outputCostUsd = (this.#total.outputTokens / 1_000_000) * price.outputPerMillion;
        return {
            model: this.model,
            inputCostUsd: round6(inputCostUsd),
            cachedInputCostUsd: round6(cachedInputCostUsd),
            outputCostUsd: round6(outputCostUsd),
            totalCostUsd: round6(inputCostUsd + cachedInputCostUsd + outputCostUsd),
        };
    }
}
export function normalizeUsage(usage) {
    const record = asRecord(usage);
    if (record === undefined)
        return undefined;
    const promptTokens = numeric(record.prompt_tokens);
    if (promptTokens !== undefined) {
        const promptDetails = asRecord(record.prompt_tokens_details);
        const completionDetails = asRecord(record.completion_tokens_details);
        return {
            inputTokens: promptTokens,
            cachedInputTokens: numeric(promptDetails?.cached_tokens) ?? numeric(record.prompt_cache_hit_tokens) ?? 0,
            outputTokens: numeric(record.completion_tokens) ?? 0,
            reasoningTokens: numeric(completionDetails?.reasoning_tokens) ?? 0,
            calls: 1,
        };
    }
    const inputDetails = asRecord(record.input_tokens_details);
    const outputDetails = asRecord(record.output_tokens_details);
    if (inputDetails !== undefined || outputDetails !== undefined) {
        return {
            inputTokens: numeric(record.input_tokens) ?? 0,
            cachedInputTokens: numeric(inputDetails?.cached_tokens) ?? 0,
            outputTokens: numeric(record.output_tokens) ?? 0,
            reasoningTokens: numeric(outputDetails?.reasoning_tokens) ?? 0,
            calls: 1,
        };
    }
    const anthropicInput = numeric(record.input_tokens ?? record.inputTokens);
    const cacheRead = numeric(record.cache_read_input_tokens);
    const cacheWrite = numeric(record.cache_creation_input_tokens);
    if (anthropicInput !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
        const base = anthropicInput ?? 0;
        return {
            inputTokens: base + (cacheRead ?? 0) + (cacheWrite ?? 0),
            cachedInputTokens: cacheRead ?? 0,
            outputTokens: numeric(record.output_tokens ?? record.outputTokens) ?? 0,
            reasoningTokens: 0,
            calls: 1,
        };
    }
    return undefined;
}
function asRecord(value) {
    return value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
        ? value
        : undefined;
}
function numeric(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function round6(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}
