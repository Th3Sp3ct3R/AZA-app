import type { Writable } from "node:stream";
export interface NdjsonFramerOptions {
    readonly maxFrameBytes?: number;
    readonly onFrame: (frame: string) => void;
    readonly onError: (code: "frame_too_large" | "invalid_utf8", message: string) => void;
}
/** Incremental LF/CRLF framing with bounded memory and oversize recovery. */
export declare class NdjsonFramer {
    #private;
    constructor(options: NdjsonFramerOptions);
    push(chunk: Buffer | string): void;
    end(): void;
}
export interface NdjsonWriterOptions {
    readonly maxFrameBytes?: number;
    readonly maxQueueBytes?: number;
}
/** Serialized writer that honors stream backpressure and bounds queued data. */
export declare class NdjsonWriter {
    #private;
    constructor(output: Writable, options?: NdjsonWriterOptions);
    send(value: unknown): Promise<void>;
    close(timeoutMs?: number): Promise<boolean>;
}
