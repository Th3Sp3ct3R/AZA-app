import type { Readable, Writable } from "node:stream";
import { VanguardEngine } from "./vanguardEngine.js";
import { type NdjsonWriterOptions } from "./ndjson.js";
import { type VanguardEngineOptions, type VanguardShutdownReceipt } from "./types.js";
export interface VanguardStdioServerOptions {
    readonly input: Readable;
    readonly output: Writable;
    readonly diagnostic?: Writable;
    readonly engine?: VanguardEngine;
    readonly engineOptions?: VanguardEngineOptions;
    readonly maxInputFrameBytes?: number;
    /** Bounds admitted/in-flight request strings, including gated lifecycle work. */
    readonly maxPendingInputFrames?: number;
    readonly maxPendingInputBytes?: number;
    /** Bounds all concurrently executing requests; queued frames remain byte-bounded. */
    readonly maxConcurrentRequests?: number;
    /** Separately bounds filesystem-heavy create/resume work. */
    readonly maxConcurrentLifecycleRequests?: number;
    readonly writer?: NdjsonWriterOptions;
    /** Bounds protocol-output drain during teardown. Defaults to 3 seconds. */
    readonly writerCloseTimeoutMs?: number;
}
/** A single-connection, versioned stdio protocol server. */
export declare class VanguardStdioServer {
    #private;
    constructor(options: VanguardStdioServerOptions);
    start(): Promise<VanguardShutdownReceipt>;
    close(): Promise<VanguardShutdownReceipt>;
}
export interface RunStdioServerOptions {
    readonly createOperationStore?: string;
}
export declare function runStdioServer(options?: RunStdioServerOptions): Promise<void>;
