import type { JsonValue, RunEvent } from "./contracts.js";
export interface SealedVerifierFailure {
    readonly verifier: string;
    readonly evidence: JsonValue;
    readonly workspaceGeneration?: number;
}
export interface UnresolvedSealedVerification {
    readonly version: 1;
    readonly unresolved: true;
    readonly claimId: string;
    readonly finishedSequence: number;
    readonly workspaceGeneration?: number;
    readonly failures: readonly SealedVerifierFailure[];
    readonly omittedFailures: number;
    readonly requiredNextEvidence: "fresh-sealed-verification-pass";
}
/**
 * Runtime-derived state for the latest unresolved sealed-verifier claim.
 *
 * The journal remains the authority. This view exists so a failed completion
 * claim cannot disappear from the provider's dynamic tail merely because the
 * ordinary transcript was projected to fit a request budget. Completion
 * evidence-policy rejections are deliberately excluded: those are policy
 * feedback, not execution by a sealed verifier.
 */
export declare class SealedVerificationState {
    #private;
    static fromJournal(events: readonly RunEvent[]): SealedVerificationState;
    observe(event: RunEvent): void;
    snapshot(): UnresolvedSealedVerification | null;
    /** Fixed runtime prose only; verifier evidence remains inert state data. */
    regroundingClause(): string | undefined;
}
/** Adds unresolved verifier state without changing the normal working-state shape. */
export declare function withSealedVerificationState(workingState: JsonValue, sealedVerification: UnresolvedSealedVerification | null): JsonValue;
