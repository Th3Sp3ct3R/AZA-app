import type { JsonValue, ModelPort, TranscriptEntry } from "./contracts.js";
export type OverflowSourceKind = "task" | "latest_user" | "fresh_tool_exchange" | "working_state";
export interface OverflowDelegationRecord {
    readonly kind: OverflowSourceKind;
    readonly sha256: string;
    readonly sourceBytes: number;
    readonly chunks: number;
    readonly digest: string;
}
export interface OverflowProjection {
    readonly task: string;
    readonly transcript: readonly TranscriptEntry[];
    readonly workingState: JsonValue;
    readonly delegations: readonly OverflowDelegationRecord[];
}
export interface OverflowProjectionRequest {
    readonly task: string;
    readonly transcript: readonly TranscriptEntry[];
    readonly workingState: JsonValue;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
    readonly cachedDigests?: ReadonlyMap<string, string>;
}
/**
 * Builds a bounded provider-facing projection when exact irreducible context
 * cannot fit. The durable journal remains byte-exact. Large sources are mapped
 * through isolated, tool-free model calls and reduced hierarchically; hashes
 * bind every digest to its source so a resume can reuse the journaled result.
 */
export declare class ModelContextOverflowDelegate {
    #private;
    constructor(model: ModelPort);
    project(request: OverflowProjectionRequest): Promise<OverflowProjection>;
}
export declare function delegatedSourceKey(kind: OverflowSourceKind, source: string): string;
export declare function hasDelegatedSource(transcript: readonly TranscriptEntry[], kind: OverflowSourceKind, source: string): boolean;
