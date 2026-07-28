import type { PatchMetrics } from "./diffMetrics.js";
import type { TrajectoryMetrics } from "./trajectoryMetrics.js";
export interface ExecutionQuality {
    readonly score: number;
    readonly cleanFirstPass: boolean;
    readonly patchExpansionRatio: number | null;
    readonly productiveTestFailures: number;
    readonly writeIterations: number;
    readonly reviewFlags: readonly string[];
    readonly penalties: {
        readonly toolFriction: number;
        readonly verificationFailures: number;
        readonly repeatedCompletionClaims: number;
    };
}
type QualityTrajectory = Pick<TrajectoryMetrics, "toolCallsByName" | "toolFrictionFailures" | "verificationFailures" | "completionClaims" | "localTestFailures"> & Partial<TrajectoryMetrics>;
export declare function scoreExecutionQuality(verified: boolean, trajectory: QualityTrajectory, patch: PatchMetrics): ExecutionQuality;
export {};
