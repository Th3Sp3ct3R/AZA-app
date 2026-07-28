import { type ContextPolicyPort, type TranscriptEntry } from "./contracts.js";
/** Raised instead of silently sending a request larger than the sealed budget. */
export declare class ContextBudgetExceededError extends Error {
    readonly requiredBytes: number;
    readonly budgetBytes: number;
    constructor(requiredBytes: number, budgetBytes: number);
}
export declare class StickyContextPolicy implements ContextPolicyPort {
    #private;
    select(task: string, transcript: readonly TranscriptEntry[], maxBytes: number, reservedTail?: readonly TranscriptEntry[]): readonly TranscriptEntry[];
}
