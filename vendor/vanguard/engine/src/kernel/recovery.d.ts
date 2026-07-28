import type { FailureDescriptor, FailureSource, JsonValue, RecoveryDecision, RecoveryFeedback, RecoveryPort, RecoveryRequest, RunEvent, RunEventType } from "./contracts.js";
export interface RecoveryClock {
    now(): number;
    random(): number;
    sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export interface RecoveryOptions {
    readonly maxGlobalRetries: number;
    readonly maxRetriesPerClass: number;
    readonly classRetryOverrides: Readonly<Partial<Record<FailureDescriptor["code"], number>>>;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterRatio: number;
    readonly clock: RecoveryClock;
}
export type RecoveryConfiguration = Partial<Omit<RecoveryOptions, "clock" | "classRetryOverrides">> & {
    readonly clock?: RecoveryClock;
    readonly classRetryOverrides?: RecoveryOptions["classRetryOverrides"];
};
type RecoveryRecorder = (type: RunEventType, data: JsonValue) => Promise<void>;
/**
 * Owns every automatic retry budget. Its only durable inputs are journal
 * events, so a process restart cannot reset a hot provider/tool loop.
 */
export declare class RecoveryController implements RecoveryPort {
    #private;
    constructor(priorEvents: readonly RunEvent[], record: RecoveryRecorder, options?: RecoveryConfiguration);
    handle(request: RecoveryRequest, signal: AbortSignal): Promise<RecoveryDecision>;
}
export interface FailureClassificationContext {
    readonly source: FailureSource;
    readonly status?: number;
    readonly retryAfterMs?: number;
    readonly aborted?: boolean;
    readonly timedOut?: boolean;
}
/** Conservative classifier: ambiguity defaults to deterministic/no retry. */
export declare function classifyFailure(error: unknown, context: FailureClassificationContext): FailureDescriptor;
export declare function replanFeedback(failure: FailureDescriptor, remainingGlobalRetries: number, remainingClassRetries?: number): RecoveryFeedback;
export {};
