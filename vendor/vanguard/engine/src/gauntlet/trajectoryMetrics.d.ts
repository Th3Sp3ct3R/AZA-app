import type { RunEvent } from "../kernel/contracts.js";
export interface TrajectoryMetrics {
    readonly modelDecisions: number;
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly localTestFailures: number;
    readonly testHarnessFailures: number;
    readonly toolFrictionFailures: number;
    readonly completionClaims: number;
    readonly verificationAttempts: number;
    readonly verificationFailures: number;
    readonly policyBlocks: number;
    /** Durable/logical history rewrites. Legacy unclassified events count here. */
    readonly contextCompactions: number;
    /** Per-request bounded views that leave durable/logical history unchanged. */
    readonly contextProjections: number;
    readonly recoveryDecisions: number;
    readonly retriesScheduled: number;
    readonly retriesExhausted: number;
    readonly replansRequired: number;
    readonly recoveryDelayMs: number;
    readonly failuresByCode: Readonly<Record<string, number>>;
    readonly failuresByDisposition: Readonly<Record<string, number>>;
    readonly toolCallsByName: Readonly<Record<string, number>>;
}
export declare function analyzeTrajectory(events: readonly RunEvent[]): TrajectoryMetrics;
