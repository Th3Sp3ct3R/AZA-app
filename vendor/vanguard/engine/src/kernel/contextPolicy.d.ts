import { type ContextPolicyPort, type TranscriptEntry } from "./contracts.js";
export declare class EvidenceContextPolicy implements ContextPolicyPort {
    select(task: string, transcript: readonly TranscriptEntry[], maxBytes: number, reservedTail?: readonly TranscriptEntry[]): readonly TranscriptEntry[];
}
