export class NdjsonFramer {
    #maxFrameBytes;
    #onFrame;
    #onError;
    #buffer = Buffer.alloc(0);
    #discardingOversizedFrame = false;
    constructor(options) {
        this.#maxFrameBytes = boundedPositive(options.maxFrameBytes ?? 1_048_576, "maxFrameBytes");
        this.#onFrame = options.onFrame;
        this.#onError = options.onError;
    }
    push(chunk) {
        let incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        if (incoming.length === 0)
            return;
        if (this.#discardingOversizedFrame) {
            const newline = incoming.indexOf(0x0a);
            if (newline < 0)
                return;
            incoming = incoming.subarray(newline + 1);
            this.#discardingOversizedFrame = false;
            if (incoming.length === 0)
                return;
        }
        this.#buffer = Buffer.concat([this.#buffer, incoming]);
        while (true) {
            const newline = this.#buffer.indexOf(0x0a);
            if (newline < 0) {
                if (this.#buffer.length > this.#maxFrameBytes) {
                    this.#buffer = Buffer.alloc(0);
                    this.#discardingOversizedFrame = true;
                    this.#onError("frame_too_large", `Protocol frame exceeds ${this.#maxFrameBytes} bytes.`);
                }
                return;
            }
            const frame = this.#buffer.subarray(0, newline);
            this.#buffer = this.#buffer.subarray(newline + 1);
            this.#emitFrame(frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame);
        }
    }
    end() {
        if (this.#discardingOversizedFrame || this.#buffer.length === 0)
            return;
        const final = this.#buffer;
        this.#buffer = Buffer.alloc(0);
        this.#emitFrame(final.at(-1) === 0x0d ? final.subarray(0, -1) : final);
    }
    #emitFrame(frame) {
        if (frame.length === 0)
            return;
        if (frame.length > this.#maxFrameBytes) {
            this.#onError("frame_too_large", `Protocol frame exceeds ${this.#maxFrameBytes} bytes.`);
            return;
        }
        try {
            this.#onFrame(new TextDecoder("utf-8", { fatal: true }).decode(frame));
        }
        catch {
            this.#onError("invalid_utf8", "Protocol frames must be valid UTF-8.");
        }
    }
}
export class NdjsonWriter {
    #output;
    #maxFrameBytes;
    #maxQueueBytes;
    #queuedBytes = 0;
    #tail = Promise.resolve();
    #closed = false;
    #outputFailure;
    #rejectPendingWrite;
    #closeAbort = new AbortController();
    constructor(output, options = {}) {
        this.#output = output;
        this.#maxFrameBytes = boundedPositive(options.maxFrameBytes ?? 1_048_576, "maxFrameBytes");
        this.#maxQueueBytes = boundedPositive(options.maxQueueBytes ?? 8_388_608, "maxQueueBytes");
        if (this.#maxQueueBytes < this.#maxFrameBytes) {
            throw new Error("maxQueueBytes must be at least maxFrameBytes.");
        }
        this.#output.on("error", (error) => this.#failOutput(error));
        this.#output.on("close", () => this.#failOutput(new Error("Protocol output closed before its write completed.")));
    }
    send(value) {
        if (this.#closed)
            return Promise.reject(new Error("Protocol writer is closed."));
        const frame = `${JSON.stringify(value)}\n`;
        const bytes = Buffer.byteLength(frame);
        if (bytes > this.#maxFrameBytes)
            return Promise.reject(new Error("Outgoing protocol frame is too large."));
        if (this.#queuedBytes + bytes > this.#maxQueueBytes) {
            return Promise.reject(new Error("Protocol output queue exceeded its bounded capacity."));
        }
        this.#queuedBytes += bytes;
        const operation = this.#tail.then(() => this.#writeFrame(frame));
        this.#tail = operation.catch(() => { });
        return operation.finally(() => { this.#queuedBytes -= bytes; });
    }
    async close(timeoutMs = 3_000) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
            throw new Error("NdjsonWriter close timeout must be a positive integer no greater than 300,000 ms.");
        }
        this.#closed = true;
        let timer;
        const drained = await Promise.race([
            this.#tail.then(() => this.#outputFailure === undefined),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
        if (timer !== undefined)
            clearTimeout(timer);
        if (!drained) {
            this.#closeAbort.abort();
            await this.#tail;
        }
        return drained;
    }
    #writeFrame(frame) {
        if (this.#outputFailure !== undefined)
            return Promise.reject(this.#outputFailure);
        const signal = this.#closeAbort.signal;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
                if (settled)
                    return;
                settled = true;
                if (this.#rejectPendingWrite === rejectFromOutput)
                    this.#rejectPendingWrite = undefined;
                signal.removeEventListener("abort", onAbort);
                if (error === undefined)
                    resolve();
                else
                    reject(error);
            };
            const rejectFromOutput = (error) => finish(error);
            const onAbort = () => finish(new Error("Protocol output write was aborted during shutdown."));
            this.#rejectPendingWrite = rejectFromOutput;
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            try {
                this.#output.write(frame, "utf8", (error) => {
                    if (error !== undefined && error !== null) {
                        this.#failOutput(error);
                        return;
                    }
                    finish(this.#outputFailure);
                });
            }
            catch (error) {
                this.#failOutput(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    #failOutput(error) {
        this.#outputFailure ??= error;
        this.#rejectPendingWrite?.(this.#outputFailure);
    }
}
function boundedPositive(value, name) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer.`);
    return value;
}
