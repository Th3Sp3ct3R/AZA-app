import path from "node:path";
import { normalizeDecision } from "../kernel/contracts.js";
import { classifyFailure } from "../kernel/recovery.js";
export class InferenceError extends Error {
    kind;
    status;
    retryable;
    retryAfterMs;
    constructor(kind, message, status, retryable = false, retryAfterMs) {
        super(sanitizeDiagnostic(message));
        this.kind = kind;
        this.status = status;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        this.name = "InferenceError";
    }
}
export class HttpModelAdapter {
    options;
    #codec;
    #fetch;
    #timeoutMs;
    #maxAttempts;
    #retryBaseMs;
    #maxRetryAfterMs;
    constructor(options) {
        this.options = options;
        this.#codec = options.codec ?? new VanguardJsonCodec();
        this.#fetch = options.fetchImplementation ?? fetch;
        this.#timeoutMs = options.timeoutMs ?? 120_000;
        this.#maxAttempts = options.maxAttempts ?? 3;
        this.#retryBaseMs = options.retryBaseMs ?? 250;
        this.#maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
        if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 2_147_483_647) {
            throw new Error("HTTP model timeoutMs must be an integer between 1 and 2147483647.");
        }
        if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 20) {
            throw new Error("HTTP model maxAttempts must be an integer between 1 and 20.");
        }
        if (!Number.isSafeInteger(this.#retryBaseMs) || this.#retryBaseMs < 0) {
            throw new Error("HTTP model retryBaseMs must be a non-negative integer.");
        }
        if (!Number.isSafeInteger(this.#maxRetryAfterMs) || this.#maxRetryAfterMs < 0) {
            throw new Error("HTTP model maxRetryAfterMs must be a non-negative integer.");
        }
        new URL(options.endpoint);
    }
    async decide(request) {
        const serializable = {
            task: request.task,
            mode: request.mode,
            transcript: request.transcript,
            tools: request.tools,
            remainingSteps: request.remainingSteps,
            workingState: request.workingState,
        };
        const observer = this.#observer();
        const streaming = this.#codec.encodeStreaming !== undefined
            && this.#codec.createStreamAccumulator !== undefined
            && this.options.disableStreaming !== true
            && process.env.VANGUARD_NO_STREAM !== "1";
        const body = JSON.stringify(streaming
            ? this.#codec.encodeStreaming(serializable)
            : this.#codec.encode(serializable));
        captureWireBody(this.options.endpoint, body);
        let headers;
        try {
            headers = await this.options.headerProvider?.headers() ?? {};
        }
        catch (error) {
            const failure = this.#failure("authentication", error, 1);
            observer?.failed?.(failure.message);
            if (request.recovery !== undefined) {
                try {
                    await request.recovery.handle({
                        operation: "provider.headers",
                        attempt: 1,
                        maxAttempts: 1,
                        idempotent: true,
                        failure: classifyFailure(failure, { source: "provider" }),
                    }, request.signal);
                }
                catch (recoveryError) {
                    throw markRecoveryHandled(recoveryError);
                }
                throw markRecoveryHandled(failure);
            }
            throw failure;
        }
        const sensitiveValues = sensitiveHeaderValues(headers);
        let lastError;
        let visibleText = false;
        for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
            const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
            const attemptSignal = AbortSignal.any([request.signal, timeoutSignal]);
            const fail = (error) => {
                const marked = error instanceof RecoveryHandledError;
                const source = marked && error.cause !== undefined ? error.cause : error;
                const failure = this.#normalizeFailure(source, request.signal, timeoutSignal, sensitiveValues);
                observer?.failed?.(failure.message);
                this.#diagnostic(failure.kind, attempt, failure.message, failure.status, failure.retryAfterMs);
                return marked ? markRecoveryHandled(failure) : failure;
            };
            try {
                this.#diagnostic("request", attempt, "Inference request started.");
                const response = await this.#fetch(this.options.endpoint, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...headers },
                    body,
                    signal: attemptSignal,
                });
                if (!response.ok) {
                    const detail = sanitizeDiagnostic((await response.text()).slice(0, 8_000), 2_000, sensitiveValues);
                    const error = httpFailure(response.status, detail, parseRetryAfter(response.headers, this.#maxRetryAfterMs));
                    throw error;
                }
                if (streaming && isEventStream(response)) {
                    if (visibleText) {
                        observer?.reset?.();
                        visibleText = false;
                    }
                    observer?.started?.(attempt);
                    const accumulator = this.#codec.createStreamAccumulator((text) => {
                        visibleText = true;
                        observer?.delta(text);
                    }, (text) => observer?.thinking?.(text));
                    const stallMs = Number(process.env.VANGUARD_STREAM_STALL_MS) > 0
                        ? Number(process.env.VANGUARD_STREAM_STALL_MS)
                        : 120_000;
                    const stall = new AbortController();
                    attemptSignal.addEventListener("abort", () => stall.abort(), { once: true });
                    let stallTimer;
                    const armStallWatchdog = () => {
                        if (stallTimer !== undefined)
                            clearTimeout(stallTimer);
                        stallTimer = setTimeout(() => stall.abort(), stallMs);
                    };
                    try {
                        armStallWatchdog();
                        await consumeServerSentEvents(response, accumulator, AbortSignal.any([attemptSignal, stall.signal]), armStallWatchdog);
                    }
                    catch (error) {
                        reportPartialUsage(accumulator, observer);
                        if (stall.signal.aborted && !attemptSignal.aborted) {
                            throw new InferenceError("timeout", `Inference stream stalled for ${stallMs}ms without an SSE chunk.`, undefined, true);
                        }
                        if (error instanceof SyntaxError || error instanceof StreamProtocolError) {
                            const detail = error instanceof StreamProtocolError
                                ? error.message
                                : "Provider stream contained malformed JSON.";
                            throw new InferenceError("protocol", detail, response.status, true);
                        }
                        throw error;
                    }
                    finally {
                        if (stallTimer !== undefined)
                            clearTimeout(stallTimer);
                    }
                    let canonical;
                    try {
                        canonical = accumulator.finish();
                    }
                    catch (error) {
                        reportPartialUsage(accumulator, observer);
                        const detail = error instanceof Error ? error.message : String(error);
                        throw new InferenceError("protocol", detail, response.status, true);
                    }
                    reportUsage(canonical, observer);
                    const decision = this.#decode(canonical, response.status);
                    observer?.committed?.();
                    return decision;
                }
                let canonical;
                try {
                    canonical = await response.json();
                }
                catch {
                    throw new InferenceError("protocol", "Provider returned malformed JSON.", response.status, true);
                }
                reportUsage(canonical, observer);
                const decision = this.#decode(canonical, response.status);
                observer?.committed?.();
                return decision;
            }
            catch (error) {
                const normalized = this.#normalizeFailure(error, request.signal, timeoutSignal, sensitiveValues);
                lastError = normalized;
                if (request.signal.aborted) {
                    throw fail(request.recovery === undefined ? normalized : markRecoveryHandled(normalized));
                }
                const failure = classifyFailure(normalized, {
                    source: "provider",
                    ...(normalized.status === undefined ? {} : { status: normalized.status }),
                    ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
                    timedOut: timeoutSignal.aborted,
                });
                let retry = false;
                if (request.recovery !== undefined) {
                    if (visibleText) {
                        observer?.reset?.();
                        visibleText = false;
                    }
                    try {
                        retry = (await request.recovery.handle({
                            operation: "provider.http_request",
                            attempt,
                            maxAttempts: this.#maxAttempts,
                            idempotent: true,
                            failure,
                        }, request.signal)).retry;
                    }
                    catch (recoveryError) {
                        throw fail(markRecoveryHandled(recoveryError));
                    }
                }
                else if (failure.disposition === "transient" && failure.retryable && attempt < this.#maxAttempts) {
                    if (visibleText) {
                        observer?.reset?.();
                        visibleText = false;
                    }
                    try {
                        const wait = Math.min(this.#maxRetryAfterMs, failure.retryAfterMs ?? this.#backoff(attempt));
                        this.#diagnostic("retry", attempt, "Retrying after a transient inference failure.", failure.status, wait);
                        await delay(wait, request.signal);
                    }
                    catch (delayError) {
                        throw fail(delayError);
                    }
                    retry = true;
                }
                if (retry && attempt < this.#maxAttempts) {
                    this.#diagnostic("retry", attempt, "Recovery approved a transient inference retry.", failure.status, failure.retryAfterMs);
                    continue;
                }
                throw fail(request.recovery === undefined ? normalized : markRecoveryHandled(normalized));
            }
        }
        const terminal = this.#normalizeFailure(lastError, request.signal, new AbortController().signal, sensitiveValues);
        observer?.failed?.(terminal.message);
        throw request.recovery === undefined ? terminal : markRecoveryHandled(terminal);
    }
    #observer() {
        const source = this.options.streamObserver
            ?? (this.options.onTextDelta === undefined ? undefined : { delta: this.options.onTextDelta });
        if (source === undefined)
            return undefined;
        const safely = (action) => {
            try {
                action?.();
            }
            catch { }
        };
        return {
            started: (attempt) => safely(() => source.started?.(attempt)),
            delta: (text) => safely(() => source.delta(text)),
            thinking: (text) => safely(() => source.thinking?.(text)),
            reset: () => safely(() => source.reset?.()),
            committed: () => safely(() => source.committed?.()),
            failed: (reason) => safely(() => source.failed?.(reason)),
            usage: (usage) => safely(() => source.usage?.(usage)),
        };
    }
    #decode(canonical, status) {
        try {
            return this.#codec.decode(canonical);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new InferenceError("protocol", detail, status, true);
        }
    }
    #failure(kind, error, attempt) {
        const failure = error instanceof Error ? error.message : String(error);
        const normalized = new InferenceError(kind, failure);
        this.#diagnostic(kind, attempt, normalized.message);
        return normalized;
    }
    #normalizeFailure(error, callerSignal, timeoutSignal, sensitiveValues = []) {
        if (error instanceof InferenceError)
            return error;
        if (callerSignal.aborted)
            return new InferenceError("cancelled", "Inference request cancelled.");
        if (timeoutSignal.aborted) {
            return new InferenceError("timeout", `Inference request timed out after ${this.#timeoutMs}ms.`, undefined, true);
        }
        const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error), 2_000, sensitiveValues);
        return new InferenceError("transport", message, undefined, true);
    }
    #backoff(attempt) {
        return Math.min(this.#maxRetryAfterMs, this.#retryBaseMs * 2 ** Math.max(0, attempt - 1));
    }
    #diagnostic(kind, attempt, message, status, retryAfterMs) {
        try {
            this.options.onDiagnostic?.({
                kind,
                attempt,
                ...(status === undefined ? {} : { status }),
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                message: sanitizeDiagnostic(message),
            });
        }
        catch {
        }
    }
}
export class EnvironmentBearerHeaders {
    variable;
    environment;
    constructor(variable, environment = process.env) {
        this.variable = variable;
        this.environment = environment;
    }
    async headers() {
        const secret = this.environment[this.variable];
        if (secret === undefined || secret.length === 0) {
            throw new Error(`Missing credential environment variable: ${this.variable}`);
        }
        return { authorization: `Bearer ${secret}` };
    }
    provenance() {
        return {
            source: "environment",
            variable: this.variable,
            present: typeof this.environment[this.variable] === "string" && this.environment[this.variable].length > 0,
        };
    }
}
export class OptionalBearerHeaders {
    variable;
    environment;
    constructor(variable, environment = process.env) {
        this.variable = variable;
        this.environment = environment;
    }
    async headers() {
        const secret = this.environment[this.variable];
        if (secret === undefined || secret.length === 0)
            return {};
        return { authorization: `Bearer ${secret}` };
    }
    provenance() {
        return {
            source: "environment",
            variable: this.variable,
            present: typeof this.environment[this.variable] === "string" && this.environment[this.variable].length > 0,
            optional: true,
        };
    }
}
export class VanguardJsonCodec {
    encode(request) {
        return request;
    }
    decode(response) {
        if (response === null || Array.isArray(response) || typeof response !== "object") {
            throw new Error("Inference response must be an object.");
        }
        const decision = normalizeDecision(response);
        if (decision === undefined)
            throw new Error("Inference response is not a valid Vanguard decision.");
        return decision;
    }
}
function isEventStream(response) {
    const contentType = response.headers.get("content-type");
    if (contentType === null || contentType.trim().length === 0)
        return true;
    return contentType.includes("text/event-stream");
}
function reportUsage(canonical, observer) {
    if (observer?.usage === undefined)
        return;
    if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object")
        return;
    const direct = canonical.usage;
    if (direct !== undefined && direct !== null) {
        observer.usage(direct);
        return;
    }
    const nested = canonical.response;
    if (nested !== null && nested !== undefined && !Array.isArray(nested) && typeof nested === "object"
        && nested.usage !== undefined && nested.usage !== null) {
        observer.usage(nested.usage);
    }
}
async function consumeServerSentEvents(response, accumulator, signal, onChunk) {
    if (response.body === null)
        throw new Error("Streaming response has no body.");
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines = [];
    let terminated = false;
    const dispatch = () => {
        if (dataLines.length === 0)
            return;
        const data = dataLines.join("\n");
        dataLines = [];
        if (data.trim() === "[DONE]") {
            if (terminated)
                throw new StreamProtocolError("Provider stream repeated its terminal [DONE] marker.");
            try {
                accumulator.terminal?.("[DONE]");
            }
            catch (error) {
                throw asStreamProtocolError(error);
            }
            terminated = true;
            return;
        }
        if (terminated)
            throw new StreamProtocolError("Provider stream contained data after its terminal [DONE] marker.");
        try {
            accumulator.feed(data);
        }
        catch (error) {
            throw asStreamProtocolError(error);
        }
    };
    const processLine = (line) => {
        if (line.length === 0) {
            dispatch();
            return;
        }
        if (terminated) {
            throw new StreamProtocolError("Provider stream contained data after its terminal [DONE] marker.");
        }
        if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
        }
    };
    const chunks = signal === undefined
        ? response.body
        : abortableChunks(response.body, signal);
    for await (const chunk of chunks) {
        if (signal?.aborted)
            throw new Error("Streaming response cancelled.");
        onChunk?.();
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n");
        while (boundary !== -1) {
            processLine(buffer.slice(0, boundary).replace(/\r$/, ""));
            buffer = buffer.slice(boundary + 1);
            boundary = buffer.indexOf("\n");
        }
        if (terminated) {
            buffer += decoder.decode();
            if (buffer.trim().length > 0) {
                throw new StreamProtocolError("Provider stream contained trailing bytes after its terminal [DONE] marker.");
            }
            return;
        }
    }
    buffer += decoder.decode();
    if (buffer.length > 0)
        processLine(buffer.replace(/\r$/, ""));
    dispatch();
}
class StreamProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = "StreamProtocolError";
    }
}
async function* abortableChunks(body, signal) {
    const reader = body.getReader();
    const interrupted = new Promise((_resolve, reject) => {
        const cancel = () => reject(new Error("Streaming response cancelled."));
        if (signal.aborted) {
            cancel();
            return;
        }
        signal.addEventListener("abort", cancel, { once: true });
    });
    interrupted.catch(() => { });
    try {
        while (true) {
            const next = await Promise.race([reader.read(), interrupted]);
            if (next.done === true)
                return;
            yield next.value;
        }
    }
    finally {
        void Promise.resolve(reader.cancel()).catch(() => { });
        reader.releaseLock();
    }
}
function asStreamProtocolError(error) {
    if (error instanceof StreamProtocolError)
        return error;
    if (error instanceof SyntaxError)
        return new StreamProtocolError("Provider stream contained malformed JSON.");
    return new StreamProtocolError(error instanceof Error ? error.message : String(error));
}
class RecoveryHandledError extends Error {
    recoveryHandled = true;
    constructor(error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        super(cause.message, { cause });
        this.name = cause.name;
    }
}
function markRecoveryHandled(error) {
    return error instanceof RecoveryHandledError ? error : new RecoveryHandledError(error);
}
function reportPartialUsage(accumulator, observer) {
    if (observer?.usage === undefined)
        return;
    const usage = accumulator.partialUsage?.();
    if (usage !== undefined)
        observer.usage(usage);
}
export function parseRetryAfter(headers, maximumMs = 60_000) {
    const raw = headers.get("retry-after");
    if (raw === null)
        return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.min(maximumMs, seconds * 1_000);
    const date = Date.parse(raw);
    return Number.isNaN(date) ? undefined : Math.min(maximumMs, Math.max(0, date - Date.now()));
}
function httpFailure(status, detail, retryAfterMs) {
    const context = status === 413 || /(?:context(?:_| )?(?:length|window)|maximum context|too many tokens|prompt.{0,24}too long|input.{0,24}tokens|request.{0,24}too large)/iu.test(detail);
    const kind = context ? "context_length"
        : status === 401 || status === 403 ? "authentication"
            : status === 429 ? "rate_limit"
                : status >= 500 ? "server"
                    : "invalid_request";
    const retryable = !context && (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
    return new InferenceError(kind, `Inference endpoint returned HTTP ${status}: ${detail}`, status, retryable, retryAfterMs);
}
export function sanitizeDiagnostic(value, maximumLength = 2_000, sensitiveValues = []) {
    let sanitized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "?");
    sanitized = sanitized
        .replace(/(Bearer\s+)[^\s"',}]+/giu, "$1[REDACTED]")
        .replace(/(["']?(?:api[_-]?key|authorization|token|password|secret)["']?\s*[:=]\s*["'])[^"']+(["'])/giu, "$1[REDACTED]$2")
        .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
    for (const sensitive of [...new Set(sensitiveValues)].sort((left, right) => right.length - left.length)) {
        if (sensitive.length > 0)
            sanitized = sanitized.replaceAll(sensitive, "[REDACTED]");
    }
    return sanitized.length <= maximumLength ? sanitized : `${sanitized.slice(0, maximumLength)}…`;
}
let wireCaptureSequence = 0;
function captureWireBody(endpoint, body) {
    const directory = process.env.VANGUARD_WIRE_CAPTURE;
    if (directory === undefined || directory === "")
        return;
    wireCaptureSequence += 1;
    const name = `wire-${String(wireCaptureSequence).padStart(3, "0")}-${Date.now()}.json`;
    void import("node:fs/promises").then(async (fs) => {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, name), JSON.stringify({ endpoint, body: JSON.parse(body) }, null, 2), "utf8");
    }).catch(() => undefined);
}
function sensitiveHeaderValues(headers) {
    const values = [];
    for (const [name, value] of Object.entries(headers)) {
        if (!/(?:authorization|api-key|token|secret)/iu.test(name))
            continue;
        values.push(value);
        const bearer = /^Bearer\s+(.+)$/iu.exec(value)?.[1];
        if (bearer !== undefined)
            values.push(bearer);
    }
    return values;
}
async function delay(milliseconds, signal) {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error("Inference retry aborted."));
        };
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
    });
}
