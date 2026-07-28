import { asciiLowercase, asciiUppercase } from "../deterministicText.js";
const DEFAULT_OPTIONS = {
    maxGlobalRetries: 8,
    maxRetriesPerClass: 3,
    classRetryOverrides: {},
    baseDelayMs: 250,
    maxDelayMs: 15_000,
    jitterRatio: 0.2,
    clock: {
        now: () => Date.now(),
        random: () => Math.random(),
        sleep: delay,
    },
};
export class RecoveryController {
    #options;
    #record;
    #usedByClass = new Map();
    #usedGlobal = 0;
    constructor(priorEvents, record, options = {}) {
        this.#options = {
            ...DEFAULT_OPTIONS,
            ...options,
            classRetryOverrides: options.classRetryOverrides ?? DEFAULT_OPTIONS.classRetryOverrides,
            clock: options.clock ?? DEFAULT_OPTIONS.clock,
        };
        this.#record = record;
        validateOptions(this.#options);
        for (const event of priorEvents) {
            if (event.type !== "recovery.decided")
                continue;
            const data = recordValue(event.data);
            if (data?.retry !== true)
                continue;
            const failure = recordValue(data.failure);
            const code = failure?.code;
            if (!isFailureCode(code))
                continue;
            this.#usedGlobal += 1;
            this.#usedByClass.set(code, (this.#usedByClass.get(code) ?? 0) + 1);
        }
    }
    async handle(request, signal) {
        const classLimit = this.#options.classRetryOverrides[request.failure.code]
            ?? this.#options.maxRetriesPerClass;
        const classUsed = this.#usedByClass.get(request.failure.code) ?? 0;
        const operationHasAttempts = request.attempt < request.maxAttempts;
        const globallyAvailable = this.#usedGlobal < this.#options.maxGlobalRetries;
        const classAvailable = classUsed < classLimit;
        const eligible = request.failure.disposition === "transient"
            && request.failure.retryable
            && request.idempotent
            && operationHasAttempts
            && globallyAvailable
            && classAvailable
            && !signal.aborted;
        const reason = eligible
            ? "safe_idempotent_transient"
            : nonRetryReason(request, signal, globallyAvailable, classAvailable, operationHasAttempts);
        const delayMs = eligible ? this.#backoff(request.failure, classUsed) : undefined;
        if (eligible) {
            this.#usedGlobal += 1;
            this.#usedByClass.set(request.failure.code, classUsed + 1);
        }
        const remainingGlobalRetries = Math.max(0, this.#options.maxGlobalRetries - this.#usedGlobal);
        const remainingClassRetries = Math.max(0, classLimit - (this.#usedByClass.get(request.failure.code) ?? 0));
        const feedback = recoveryFeedback(request.failure, eligible, remainingGlobalRetries, remainingClassRetries, delayMs);
        const decision = {
            retry: eligible,
            reason,
            failure: request.failure,
            feedback,
            ...(delayMs === undefined ? {} : { delayMs }),
        };
        await this.#record("recovery.decided", asJson({
            operation: request.operation,
            attempt: request.attempt,
            maxAttempts: request.maxAttempts,
            idempotent: request.idempotent,
            retry: eligible,
            reason,
            failure: request.failure,
            feedback,
            ...(delayMs === undefined ? {} : { delayMs }),
            budget: {
                usedGlobal: this.#usedGlobal,
                maxGlobal: this.#options.maxGlobalRetries,
                usedClass: this.#usedByClass.get(request.failure.code) ?? 0,
                maxClass: classLimit,
            },
        }));
        if (!eligible) {
            if (request.failure.disposition === "transient" && request.failure.retryable && request.idempotent) {
                await this.#record("recovery.exhausted", asJson({
                    operation: request.operation,
                    reason,
                    failure: request.failure,
                    attempt: request.attempt,
                    remainingGlobalRetries,
                    remainingClassRetries,
                }));
            }
            return decision;
        }
        await this.#record("recovery.delayed", asJson({
            operation: request.operation,
            failureCode: request.failure.code,
            delayMs: delayMs,
            attempt: request.attempt,
            retryAttempt: request.attempt + 1,
            scheduledAt: this.#options.clock.now(),
        }));
        try {
            await this.#options.clock.sleep(delayMs, signal);
        }
        catch (error) {
            await this.#record("recovery.exhausted", asJson({
                operation: request.operation,
                reason: "aborted_during_backoff",
                failure: classifyFailure(error, { source: request.failure.source, aborted: true }),
                attempt: request.attempt,
            }));
            throw error;
        }
        return decision;
    }
    #backoff(failure, classUsed) {
        if (failure.retryAfterMs !== undefined)
            return Math.max(0, Math.round(failure.retryAfterMs));
        const exponential = Math.min(this.#options.maxDelayMs, this.#options.baseDelayMs * 2 ** classUsed);
        const random = Math.min(1, Math.max(0, this.#options.clock.random()));
        const jitter = 1 + (random * 2 - 1) * this.#options.jitterRatio;
        return Math.max(0, Math.round(exponential * jitter));
    }
}
export function classifyFailure(error, context) {
    const existing = failureDescriptor(error);
    if (existing !== undefined)
        return existing;
    const message = boundedMessage(error);
    const lower = asciiLowercase(message);
    const status = context.status ?? numericProperty(error, "status");
    const retryAfterMs = context.retryAfterMs ?? numericProperty(error, "retryAfterMs");
    const code = asciiUppercase(stringProperty(error, "code"));
    const providerKind = asciiLowercase(stringProperty(error, "kind"));
    const providerDeclaredRetryable = booleanProperty(error, "retryable");
    const base = {
        version: 1,
        message,
        ...(status === undefined ? {} : { status }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
    if (context.source === "policy" || isPolicyMessage(lower)) {
        return { ...base, code: "policy_denied", source: "policy", disposition: "policy", retryable: false };
    }
    if (context.source === "context") {
        const budget = lower.includes("budget") || lower.includes("maximum") || lower.includes("too large") || lower.includes("token");
        return {
            ...base,
            code: budget ? "context_budget" : "context_invalid",
            source: "context",
            disposition: budget ? "environment" : "deterministic",
            retryable: false,
        };
    }
    if (context.timedOut === true || status === 408 || lower.includes("timed out") || lower.includes("timeout")) {
        if (context.source === "provider") {
            return { ...base, code: "provider_timeout", source: "provider", disposition: "transient", retryable: true };
        }
        return { ...base, code: "process_timeout", source: context.source, disposition: "environment", retryable: false };
    }
    if (context.aborted === true || lower.includes("abort") || lower.includes("cancelled") || lower.includes("canceled")) {
        return { ...base, code: "cancelled", source: context.source, disposition: "cancelled", retryable: false };
    }
    if (context.source === "provider") {
        if (lower.includes("truncated at max_tokens")) {
            return {
                ...base,
                code: "provider_protocol_invalid",
                source: "provider",
                disposition: "deterministic",
                retryable: false,
            };
        }
        if (providerKind === "protocol" && providerDeclaredRetryable === true
            && (status === undefined || status < 400)) {
            return {
                ...base,
                code: "provider_protocol_invalid",
                source: "provider",
                disposition: "transient",
                retryable: true,
            };
        }
        if (status === 409)
            return { ...base, code: "provider_conflict", source: "provider", disposition: "transient", retryable: true };
        if (status === 429)
            return { ...base, code: "provider_rate_limited", source: "provider", disposition: "transient", retryable: true };
        if (status !== undefined && status >= 500) {
            return { ...base, code: "provider_unavailable", source: "provider", disposition: "transient", retryable: true };
        }
        if (status === 401 || status === 403) {
            return { ...base, code: "provider_authentication", source: "provider", disposition: "environment", retryable: false };
        }
        if (lower.includes("missing credential") || lower.includes("api key") || lower.includes("authentication")) {
            return { ...base, code: "provider_authentication", source: "provider", disposition: "environment", retryable: false };
        }
        if (status !== undefined && status >= 400) {
            return { ...base, code: "provider_request_invalid", source: "provider", disposition: "deterministic", retryable: false };
        }
        if (isDisconnect(lower, code)) {
            return { ...base, code: "provider_disconnect", source: "provider", disposition: "transient", retryable: true };
        }
    }
    if (context.source === "verifier") {
        const returnedFailure = lower.includes("returned failure") || lower.includes("did not pass") || lower.includes("verification failed");
        const disconnected = isDisconnect(lower, code);
        return {
            ...base,
            code: returnedFailure ? "verifier_failed" : "verifier_exception",
            source: "verifier",
            disposition: disconnected ? "transient" : "deterministic",
            retryable: disconnected,
        };
    }
    if (context.source === "process") {
        if (code === "ENOENT" || lower.includes("not recognized") || lower.includes("command not found")) {
            return { ...base, code: "environment_missing_dependency", source: "environment", disposition: "environment", retryable: false };
        }
        if (hasNonZeroExit(error) || lower.includes("exit code") || lower.includes("exited with")) {
            return { ...base, code: "process_exit", source: "process", disposition: "deterministic", retryable: false };
        }
    }
    if (code === "EACCES" || code === "EPERM" || code === "ENOSPC" || lower.includes("permission denied")) {
        return { ...base, code: "environment_io", source: "environment", disposition: "environment", retryable: false };
    }
    if (context.source === "environment") {
        return { ...base, code: "environment_io", source: "environment", disposition: "environment", retryable: false };
    }
    if (isDisconnect(lower, code)) {
        return { ...base, code: "tool_transient", source: context.source, disposition: "transient", retryable: true };
    }
    if (context.source === "tool") {
        return { ...base, code: "tool_failed", source: "tool", disposition: "deterministic", retryable: false };
    }
    return { ...base, code: "unknown_failure", source: context.source, disposition: "deterministic", retryable: false };
}
export function replanFeedback(failure, remainingGlobalRetries, remainingClassRetries = 0) {
    const guidance = failure.disposition === "policy"
        ? "The same policy-denied action was repeated. Do not bypass the boundary; update the plan to use permitted operations and checkpoint that route before acting."
        : failure.disposition === "environment"
            ? "The same environment-dependent action failed repeatedly. Diagnose or repair the prerequisite, then update the plan and checkpoint a different executable route."
            : "The same deterministic action failed repeatedly. Do not replay it. Inspect the evidence, change the approach, update the durable plan, and checkpoint the new hypothesis before acting again.";
    return {
        action: "replan_and_checkpoint",
        guidance,
        remainingGlobalRetries,
        remainingClassRetries,
    };
}
function recoveryFeedback(failure, retry, remainingGlobalRetries, remainingClassRetries, delayMs) {
    if (retry) {
        return {
            action: "retry_scheduled",
            guidance: "Vanguard classified this as transient and will retry the same safe, idempotent operation once after backoff.",
            ...(delayMs === undefined ? {} : { retryDelayMs: delayMs }),
            remainingGlobalRetries,
            remainingClassRetries,
        };
    }
    if (failure.disposition === "policy") {
        return {
            action: "respect_policy",
            guidance: "Do not repeat or bypass this action. Choose an operation permitted by the declared workspace/process policy, or ask the user to change the policy.",
            remainingGlobalRetries,
            remainingClassRetries,
        };
    }
    if (failure.disposition === "environment") {
        return {
            action: "repair_environment",
            guidance: "Automatic replay is unsafe or ineffective. Inspect the environment/configuration, repair the prerequisite, then run a fresh diagnostic action.",
            remainingGlobalRetries,
            remainingClassRetries,
        };
    }
    if (failure.disposition === "cancelled") {
        return {
            action: "stop_cancelled",
            guidance: "The operation was cancelled. Do not resume it unless the user starts or steers the run again.",
            remainingGlobalRetries,
            remainingClassRetries,
        };
    }
    if (failure.disposition === "transient") {
        return {
            action: "change_approach",
            guidance: "The fault appears transient, but replaying this operation could duplicate a mutation, process side effect, or verification claim. Inspect the resulting state before choosing a fresh action.",
            remainingGlobalRetries,
            remainingClassRetries,
        };
    }
    return {
        action: "change_approach",
        guidance: "This failure is deterministic. Read the evidence, change the input or implementation, and do not replay the identical action.",
        remainingGlobalRetries,
        remainingClassRetries,
    };
}
function nonRetryReason(request, signal, globallyAvailable, classAvailable, operationHasAttempts) {
    if (signal.aborted || request.failure.disposition === "cancelled")
        return "cancelled";
    if (!request.idempotent)
        return "unsafe_or_non_idempotent";
    if (request.failure.disposition !== "transient" || !request.failure.retryable)
        return `non_transient_${request.failure.disposition}`;
    if (!operationHasAttempts)
        return "operation_attempt_limit";
    if (!globallyAvailable)
        return "global_retry_budget_exhausted";
    if (!classAvailable)
        return "class_retry_budget_exhausted";
    return "retry_not_permitted";
}
function validateOptions(options) {
    for (const [label, value] of [
        ["maxGlobalRetries", options.maxGlobalRetries],
        ["maxRetriesPerClass", options.maxRetriesPerClass],
        ["baseDelayMs", options.baseDelayMs],
        ["maxDelayMs", options.maxDelayMs],
    ]) {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new Error(`Recovery ${label} must be a non-negative integer.`);
    }
    if (!Number.isFinite(options.jitterRatio) || options.jitterRatio < 0 || options.jitterRatio > 1) {
        throw new Error("Recovery jitterRatio must be between zero and one.");
    }
    for (const [code, value] of Object.entries(options.classRetryOverrides)) {
        if (!isFailureCode(code) || !Number.isSafeInteger(value) || value < 0) {
            throw new Error(`Invalid recovery class override: ${code}.`);
        }
    }
}
function failureDescriptor(error) {
    if (error === null || typeof error !== "object")
        return undefined;
    const candidate = "failure" in error ? error.failure : error;
    if (candidate === null || typeof candidate !== "object")
        return undefined;
    const value = candidate;
    return value.version === 1 && isFailureCode(value.code) && isFailureSource(value.source)
        && isDisposition(value.disposition) && typeof value.retryable === "boolean" && typeof value.message === "string"
        ? value
        : undefined;
}
function boundedMessage(error) {
    let value;
    if (error instanceof Error)
        value = error.message;
    else if (typeof error === "string")
        value = error;
    else {
        try {
            value = JSON.stringify(error);
        }
        catch {
            value = String(error);
        }
    }
    return (value || "Unknown failure").slice(0, 2_000);
}
function numericProperty(value, key) {
    if (value === null || typeof value !== "object" || !(key in value))
        return undefined;
    const candidate = value[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}
function booleanProperty(value, key) {
    if (value === null || typeof value !== "object" || !(key in value))
        return undefined;
    const candidate = value[key];
    return typeof candidate === "boolean" ? candidate : undefined;
}
function stringProperty(value, key) {
    if (value === null || typeof value !== "object" || !(key in value))
        return "";
    const candidate = value[key];
    return typeof candidate === "string" ? candidate : "";
}
function hasNonZeroExit(value) {
    if (value === null || typeof value !== "object")
        return false;
    const direct = numericProperty(value, "exitCode");
    if (direct !== undefined)
        return direct !== 0;
    if ("output" in value)
        return hasNonZeroExit(value.output);
    return false;
}
function isPolicyMessage(lower) {
    return lower.includes("policy") || lower.includes("outside the declared editable roots")
        || lower.includes("not allowed") || lower.includes("not permitted") || lower.includes("protected path");
}
function isDisconnect(lower, code) {
    return ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]
        .includes(code)
        || lower.includes("fetch failed") || lower.includes("connection lost") || lower.includes("connection reset")
        || lower.includes("socket hang up") || lower.includes("network error") || lower.includes("disconnected");
}
function recordValue(value) {
    return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
        ? value : undefined;
}
function isFailureCode(value) {
    return typeof value === "string" && FAILURE_CODES.has(value);
}
function isFailureSource(value) {
    return typeof value === "string" && FAILURE_SOURCES.has(value);
}
function isDisposition(value) {
    return typeof value === "string" && FAILURE_DISPOSITIONS.has(value);
}
const FAILURE_CODES = new Set([
    "provider_timeout", "provider_rate_limited", "provider_conflict", "provider_unavailable",
    "provider_disconnect", "provider_protocol_invalid", "provider_authentication", "provider_request_invalid", "tool_transient",
    "tool_failed", "process_exit", "process_timeout", "verifier_failed", "verifier_exception",
    "policy_denied", "context_budget", "context_invalid", "environment_missing_dependency",
    "environment_io", "cancelled", "unknown_failure",
]);
const FAILURE_SOURCES = new Set(["provider", "tool", "process", "verifier", "policy", "context", "environment"]);
const FAILURE_DISPOSITIONS = new Set(["transient", "deterministic", "policy", "environment", "cancelled"]);
function asJson(value) {
    return value;
}
async function delay(milliseconds, signal) {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error("Recovery backoff aborted."));
        };
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
    });
}
