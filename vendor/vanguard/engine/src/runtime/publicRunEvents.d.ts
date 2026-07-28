import type { RunEvent } from "../kernel/contracts.js";
import type { StreamObserver } from "../inference/httpModel.js";
export declare const PUBLIC_EVENT_PREFIX = "@@VANGUARD_EVENT@@";
export interface PublicRunEvent {
    readonly type: string;
    readonly agentId: string;
    readonly sequence?: number;
    readonly turn?: number;
    readonly status?: "pending" | "passed" | "failed" | "info";
    readonly title: string;
    readonly detail?: string;
    readonly message?: string;
    readonly tool?: string;
    readonly sessionId?: string;
    readonly sessionRoot?: string;
    readonly workspaceRoot?: string;
    readonly journalFile?: string;
    readonly scorecardFile?: string;
    /** Runtime-owned workspace lifecycle state; never inferred by clients. */
    readonly materialized?: boolean;
    /** Runtime-measured execution cost of the exact tool call, when known. */
    readonly durationMs?: number;
}
export declare class PublicRunEventPresenter {
    #private;
    present(event: RunEvent): PublicRunEvent[];
}
export declare function encodePublicRunEvent(event: PublicRunEvent): string;
/**
 * Presents the provisional-stream lifecycle as public events. Deltas are
 * coalesced; pending text always flushes before the stream commits, so the
 * canonical agent.message never precedes its own provisional tail. A reset
 * discards provisional text instead of flushing it, preventing duplicated
 * output after a retry.
 */
export declare function createStreamLifecyclePresenter(emit: (event: PublicRunEvent) => void, markActivity?: () => void, coalesceMs?: number): StreamObserver;
