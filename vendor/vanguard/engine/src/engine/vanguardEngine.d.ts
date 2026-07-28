import { type VanguardEngineEvent, type VanguardEngineOptions, type VanguardEventPage, type VanguardSessionConfig, type VanguardShutdownReceipt, type VanguardSessionStatus, type VanguardStopReceipt } from "./types.js";
/**
 * Public, transport-neutral Vanguard engine.
 *
 * The engine owns durable sessions, lifecycle, sanitized event ordering, and
 * replay. The default runner delegates execution to the established CLI
 * runtime; embedders may inject another runner without changing the protocol.
 */
export declare class VanguardEngine {
    #private;
    constructor(options?: VanguardEngineOptions);
    capabilities(): readonly string[];
    create(config: VanguardSessionConfig, operationId?: string): Promise<VanguardSessionStatus>;
    /** Registers an existing durable session and reconstructs replayable events. */
    resume(sessionRoot: string): Promise<VanguardSessionStatus>;
    /** Starts one non-blocking advance; events arrive through subscribe/events. */
    advance(sessionId: string, message?: string): VanguardSessionStatus;
    steer(sessionId: string, message: string): VanguardSessionStatus;
    cancel(sessionId: string): VanguardSessionStatus;
    /**
     * Delivers cancellation and waits for the exact current worker generation
     * to settle. A terminal event alone is never accepted as proof of stop.
     */
    stopAndWait(sessionId: string, timeoutMs?: number): Promise<VanguardStopReceipt>;
    status(sessionId: string): VanguardSessionStatus;
    events(sessionId: string, afterCursor?: number, limit?: number): VanguardEventPage;
    subscribe(listener: (event: VanguardEngineEvent) => void): () => void;
    shutdown(): Promise<VanguardShutdownReceipt>;
}
