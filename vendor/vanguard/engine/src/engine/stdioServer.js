import { VanguardEngine } from "./vanguardEngine.js";
import { NdjsonFramer, NdjsonWriter } from "./ndjson.js";
import { VANGUARD_PROTOCOL_VERSION, VanguardEngineError, } from "./types.js";
export class VanguardStdioServer {
    #input;
    #diagnostic;
    #engine;
    #writer;
    #framer;
    #writerCloseTimeoutMs;
    #maxOutputFrameBytes;
    #maxPendingInputFrames;
    #maxPendingInputBytes;
    #requestSlots;
    #lifecycleSlots;
    #handshaken = false;
    #finishing = false;
    #closing = false;
    #pendingInputFrames = 0;
    #pendingInputBytes = 0;
    #sessionTails = new Map();
    #closed;
    #resolveClosed;
    #unsubscribe;
    constructor(options) {
        this.#input = options.input;
        this.#diagnostic = options.diagnostic ?? process.stderr;
        this.#diagnostic.on("error", () => {
        });
        this.#writerCloseTimeoutMs = boundedTimeout(options.writerCloseTimeoutMs ?? 3_000, "writerCloseTimeoutMs");
        this.#maxOutputFrameBytes = boundedPositive(options.writer?.maxFrameBytes ?? 1_048_576, "writer.maxFrameBytes");
        if (this.#maxOutputFrameBytes < 4_096) {
            throw new VanguardEngineError("invalid_protocol_options", "writer.maxFrameBytes must be at least 4,096 bytes for a correlated protocol error.");
        }
        const maxInputFrameBytes = boundedPositive(options.maxInputFrameBytes ?? 1_048_576, "maxInputFrameBytes");
        this.#maxPendingInputFrames = boundedPositive(options.maxPendingInputFrames ?? 256, "maxPendingInputFrames");
        this.#maxPendingInputBytes = boundedPositive(options.maxPendingInputBytes ?? 8_388_608, "maxPendingInputBytes");
        if (this.#maxPendingInputBytes < maxInputFrameBytes) {
            throw new VanguardEngineError("invalid_protocol_options", "maxPendingInputBytes must be at least maxInputFrameBytes.");
        }
        const maxConcurrentRequests = boundedPositive(options.maxConcurrentRequests ?? 32, "maxConcurrentRequests");
        const maxConcurrentLifecycleRequests = boundedPositive(options.maxConcurrentLifecycleRequests ?? 4, "maxConcurrentLifecycleRequests");
        if (maxConcurrentLifecycleRequests > maxConcurrentRequests) {
            throw new VanguardEngineError("invalid_protocol_options", "maxConcurrentLifecycleRequests may not exceed maxConcurrentRequests.");
        }
        this.#requestSlots = new AsyncSemaphore(maxConcurrentRequests);
        this.#lifecycleSlots = new AsyncSemaphore(maxConcurrentLifecycleRequests);
        this.#engine = options.engine ?? new VanguardEngine({
            ...options.engineOptions,
            logger: (line) => this.#log(line),
        });
        this.#writer = new NdjsonWriter(options.output, options.writer);
        this.#closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
        this.#framer = new NdjsonFramer({
            maxFrameBytes: maxInputFrameBytes,
            onFrame: (frame) => this.#acceptFrame(frame),
            onError: (code, message) => {
                void this.#sendError(null, code, message, false);
            },
        });
        this.#unsubscribe = this.#engine.subscribe((event) => this.#publishEvent(event));
    }
    start() {
        this.#input.on("data", (chunk) => this.#framer.push(chunk));
        this.#input.once("end", () => {
            this.#framer.end();
            void this.#finish();
        });
        this.#input.once("close", () => { void this.#finish(); });
        this.#input.on("error", (error) => {
            this.#log(`Protocol input failed: ${error.message}`);
            void this.#finish();
        });
        this.#input.resume();
        return this.#closed;
    }
    async close() {
        await this.#finish();
        return this.#closed;
    }
    #acceptFrame(frame) {
        if (this.#closing)
            return;
        const bytes = Buffer.byteLength(frame, "utf8");
        if (this.#pendingInputFrames + 1 > this.#maxPendingInputFrames
            || this.#pendingInputBytes + bytes > this.#maxPendingInputBytes) {
            this.#log("Protocol input queue exceeded its bounded capacity; closing the connection fail-closed.");
            this.#input.pause();
            void this.#finish();
            return;
        }
        this.#pendingInputFrames += 1;
        this.#pendingInputBytes += bytes;
        let released = false;
        const release = () => {
            if (released)
                return;
            released = true;
            this.#pendingInputFrames -= 1;
            this.#pendingInputBytes -= bytes;
        };
        let raw;
        try {
            raw = JSON.parse(frame);
        }
        catch {
            this.#observeRequest(this.#sendError(null, "invalid_json", "Protocol frame is not valid JSON.", false), release);
            return;
        }
        const request = parseRequest(raw);
        if (request instanceof VanguardEngineError) {
            this.#observeRequest(this.#sendError(request.details?.requestId ?? null, request.code, request.message, request.retryable), release);
            return;
        }
        if (request.operation === "handshake") {
            this.#observeRequest(this.#handshake(request), release);
            return;
        }
        if (!this.#handshaken) {
            this.#observeRequest(this.#sendError(request.id, "handshake_required", "Handshake must be the first successful operation.", false), release);
            return;
        }
        this.#observeRequest(this.#scheduleRequest(request), release);
    }
    async #dispatchResponse(request) {
        if (request.protocolVersion !== VANGUARD_PROTOCOL_VERSION) {
            return protocolErrorResponse(request.id, "unsupported_version", "The request protocol version is unsupported.", false, { supportedVersions: [VANGUARD_PROTOCOL_VERSION] });
        }
        try {
            const result = await this.#dispatch(request);
            return {
                type: "response",
                protocolVersion: VANGUARD_PROTOCOL_VERSION,
                id: request.id,
                ok: true,
                result,
            };
        }
        catch (error) {
            const structured = toProtocolError(error);
            return protocolErrorResponse(request.id, structured.code, structured.message, structured.retryable, structured.details);
        }
    }
    #scheduleRequest(request) {
        const sessionId = sessionLane(request);
        let dispatch;
        if (sessionId === undefined) {
            dispatch = this.#runScheduledDispatch(request);
        }
        else {
            const prior = this.#sessionTails.get(sessionId) ?? Promise.resolve();
            dispatch = prior.then(() => this.#runScheduledDispatch(request));
            const tail = dispatch.then(() => { }, () => { });
            this.#sessionTails.set(sessionId, tail);
            void tail.finally(() => {
                if (this.#sessionTails.get(sessionId) === tail)
                    this.#sessionTails.delete(sessionId);
            });
        }
        return dispatch.then(async (response) => {
            if (this.#closing)
                return;
            await this.#writer.send(this.#prepareResponse(request, response));
        });
    }
    #prepareResponse(request, response) {
        if (encodedFrameBytes(response) <= this.#maxOutputFrameBytes)
            return response;
        if (request?.operation === "events" && response.ok === true) {
            const result = plainRecord(response.result);
            const events = Array.isArray(result?.events) ? result.events : undefined;
            if (result !== undefined && events !== undefined) {
                const baseResult = { ...result, events: [], hasMore: false };
                const baseResponse = { ...response, result: baseResult };
                let bytes = encodedFrameBytes(baseResponse);
                const selected = [];
                if (bytes <= this.#maxOutputFrameBytes) {
                    for (const event of events) {
                        const serialized = JSON.stringify(event);
                        if (serialized === undefined)
                            break;
                        const additional = Buffer.byteLength(serialized, "utf8") + (selected.length === 0 ? 0 : 1);
                        if (bytes + additional > this.#maxOutputFrameBytes)
                            break;
                        selected.push(event);
                        bytes += additional;
                    }
                    if (events.length === 0 || selected.length > 0) {
                        const fitted = {
                            ...response,
                            result: {
                                ...result,
                                events: selected,
                                hasMore: result.hasMore === true || selected.length < events.length,
                            },
                        };
                        if (encodedFrameBytes(fitted) <= this.#maxOutputFrameBytes)
                            return fitted;
                    }
                }
            }
        }
        const responseId = typeof response.id === "string" || response.id === null ? response.id : null;
        return protocolErrorResponse(request?.id ?? responseId, "response_too_large", "The correlated response exceeds the configured protocol frame limit; request a smaller page.", false);
    }
    async #runScheduledDispatch(request) {
        let releaseLifecycle;
        let releaseRequest;
        try {
            if (isLifecycleOperation(request.operation))
                releaseLifecycle = await this.#lifecycleSlots.acquire();
            releaseRequest = await this.#requestSlots.acquire();
            if (this.#closing)
                throw new Error("Protocol request scheduler is closed.");
            return await this.#dispatchResponse(request);
        }
        finally {
            releaseRequest?.();
            releaseLifecycle?.();
        }
    }
    #observeRequest(operation, release) {
        void operation.catch((error) => {
            if (!this.#closing) {
                this.#log(`Protocol request failed: ${error instanceof Error ? error.message : String(error)}`);
                void this.#finish();
            }
        }).finally(release);
    }
    async #handshake(request) {
        const versions = arrayOfNumbers(request.params?.versions);
        if (request.protocolVersion !== VANGUARD_PROTOCOL_VERSION || !versions.includes(VANGUARD_PROTOCOL_VERSION)) {
            await this.#sendError(request.id, "unsupported_version", "No mutually supported protocol version exists.", false, {
                supportedVersions: [VANGUARD_PROTOCOL_VERSION],
            });
            return;
        }
        this.#handshaken = true;
        const response = this.#prepareResponse(request, {
            type: "response",
            protocolVersion: VANGUARD_PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            result: {
                protocolVersion: VANGUARD_PROTOCOL_VERSION,
                capabilities: this.#engine.capabilities(),
                server: { name: "vanguard", version: "0.1.0" },
                limits: { eventReplayIsBounded: true },
            },
        });
        if (response.ok !== true)
            this.#handshaken = false;
        await this.#writer.send(response);
    }
    async #dispatch(request) {
        const params = request.params ?? {};
        switch (request.operation) {
            case "create":
                return this.#engine.create(requiredObject(params, "config"), optionalString(params, "operationId"));
            case "resume":
                return this.#engine.resume(requiredString(params, "sessionRoot"));
            case "advance":
                return this.#engine.advance(requiredString(params, "sessionId"), optionalString(params, "message"));
            case "steer":
                return this.#engine.steer(requiredString(params, "sessionId"), requiredString(params, "message"));
            case "cancel":
                return this.#engine.cancel(requiredString(params, "sessionId"));
            case "stopAndWait":
                return this.#engine.stopAndWait(requiredString(params, "sessionId"), optionalInteger(params, "timeoutMs") ?? 3_000);
            case "status":
                return this.#engine.status(requiredString(params, "sessionId"));
            case "events":
                return this.#engine.events(requiredString(params, "sessionId"), optionalInteger(params, "afterCursor") ?? 0, Math.min(optionalInteger(params, "limit") ?? 500, 128));
            default:
                throw new VanguardEngineError("unknown_operation", `Unknown protocol operation '${request.operation}'.`);
        }
    }
    #publishEvent(envelope) {
        if (this.#closing || !this.#handshaken)
            return;
        const frame = {
            type: "event",
            protocolVersion: VANGUARD_PROTOCOL_VERSION,
            sessionId: envelope.sessionId,
            cursor: envelope.cursor,
            event: envelope.event,
        };
        if (encodedFrameBytes(frame) > this.#maxOutputFrameBytes) {
            this.#log(`Public event ${envelope.cursor} exceeds the configured output frame limit; paged replay may return response_too_large.`);
            return;
        }
        void this.#writer.send(frame).catch((error) => {
            this.#log(`Protocol output stopped: ${error instanceof Error ? error.message : String(error)}`);
            void this.#finish();
        });
    }
    async #sendError(id, code, message, retryable, details) {
        if (this.#closing)
            return;
        try {
            await this.#writer.send(this.#prepareResponse(undefined, protocolErrorResponse(id, code, message, retryable, details)));
        }
        catch (error) {
            this.#log(`Protocol error response failed: ${error instanceof Error ? error.message : String(error)}`);
            await this.#finish();
        }
    }
    async #finish() {
        if (this.#finishing)
            return this.#closed;
        this.#finishing = true;
        this.#closing = true;
        this.#input.pause();
        this.#requestSlots.close();
        this.#lifecycleSlots.close();
        this.#unsubscribe();
        const receipt = await this.#engine.shutdown();
        if (!receipt.complete) {
            this.#log(`Engine shutdown incomplete; unresolved sessions: ${receipt.unresolvedSessionIds.join(", ") || "none"}; `
                + `unresolved operations: ${receipt.unresolvedOperations}`);
        }
        const outputDrained = await this.#writer.close(this.#writerCloseTimeoutMs).catch(() => false);
        if (!outputDrained)
            this.#log("Protocol output did not drain before the bounded shutdown deadline.");
        this.#resolveClosed(receipt);
        return receipt;
    }
    #log(line) {
        try {
            this.#diagnostic.write(`[Vanguard protocol] ${line.replaceAll("\0", "").slice(0, 8_000)}\n`);
        }
        catch {
        }
    }
}
export async function runStdioServer(options = {}) {
    const server = new VanguardStdioServer({
        input: process.stdin,
        output: process.stdout,
        diagnostic: process.stderr,
        ...(options.createOperationStore === undefined
            ? {}
            : { engineOptions: { createOperationStore: { root: options.createOperationStore } } }),
    });
    const receipt = await server.start();
    if (!receipt.complete)
        process.exitCode = 1;
}
function parseRequest(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return new VanguardEngineError("invalid_request", "Protocol requests must be JSON objects.");
    }
    const object = value;
    const requestId = typeof object.id === "string" ? object.id : undefined;
    const details = requestId === undefined ? undefined : { requestId };
    if (object.type !== "request")
        return new VanguardEngineError("invalid_request", "type must be 'request'.", false, details);
    if (requestId === undefined || requestId.length === 0 || requestId.length > 200) {
        return new VanguardEngineError("invalid_request_id", "id must be a non-empty string of at most 200 characters.");
    }
    if (!Number.isSafeInteger(object.protocolVersion)) {
        return new VanguardEngineError("invalid_request", "protocolVersion must be an integer.", false, details);
    }
    if (typeof object.operation !== "string" || object.operation.length === 0 || object.operation.length > 100) {
        return new VanguardEngineError("invalid_request", "operation must be a non-empty string.", false, details);
    }
    if (object.params !== undefined && (object.params === null || typeof object.params !== "object" || Array.isArray(object.params))) {
        return new VanguardEngineError("invalid_request", "params must be an object.", false, details);
    }
    return {
        type: "request",
        id: requestId,
        protocolVersion: object.protocolVersion,
        operation: object.operation,
        ...(object.params === undefined ? {} : { params: object.params }),
    };
}
function toProtocolError(error) {
    if (error instanceof VanguardEngineError)
        return error;
    return new VanguardEngineError("internal_error", "The engine could not complete the request.", true);
}
function requiredString(object, field) {
    const value = object[field];
    if (typeof value !== "string" || value.length === 0) {
        throw new VanguardEngineError("invalid_params", `${field} must be a non-empty string.`);
    }
    return value;
}
function optionalString(object, field) {
    if (object[field] === undefined)
        return undefined;
    return requiredString(object, field);
}
function optionalInteger(object, field) {
    const value = object[field];
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new VanguardEngineError("invalid_params", `${field} must be a non-negative integer.`);
    }
    return value;
}
function requiredObject(object, field) {
    const value = object[field];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new VanguardEngineError("invalid_params", `${field} must be an object.`);
    }
    return value;
}
function arrayOfNumbers(value) {
    return Array.isArray(value) ? value.filter((item) => Number.isSafeInteger(item)) : [];
}
function protocolErrorResponse(id, code, message, retryable, details) {
    return {
        type: "response",
        protocolVersion: VANGUARD_PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
    };
}
function encodedFrameBytes(value) {
    return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}
function plainRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function boundedTimeout(value, field) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
        throw new VanguardEngineError("invalid_protocol_options", `${field} must be between 1 and 300,000 ms.`);
    }
    return value;
}
function boundedPositive(value, field) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new VanguardEngineError("invalid_protocol_options", `${field} must be a positive integer.`);
    }
    return value;
}
function isLifecycleOperation(operation) {
    return operation === "create" || operation === "resume";
}
function sessionLane(request) {
    if (!["advance", "steer", "cancel", "stopAndWait", "status", "events"].includes(request.operation)) {
        return undefined;
    }
    const sessionId = request.params?.sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
class AsyncSemaphore {
    #limit;
    #active = 0;
    #closed = false;
    #waiters = [];
    constructor(limit) {
        this.#limit = limit;
    }
    acquire() {
        if (this.#closed)
            return Promise.reject(new Error("Protocol request scheduler is closed."));
        if (this.#active < this.#limit) {
            this.#active += 1;
            return Promise.resolve(this.#releaseHandle());
        }
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        const error = new Error("Protocol request scheduler is closed.");
        for (const waiter of this.#waiters.splice(0))
            waiter.reject(error);
    }
    #releaseHandle() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.#active -= 1;
            if (this.#closed)
                return;
            const waiter = this.#waiters.shift();
            if (waiter === undefined)
                return;
            this.#active += 1;
            waiter.resolve(this.#releaseHandle());
        };
    }
}
