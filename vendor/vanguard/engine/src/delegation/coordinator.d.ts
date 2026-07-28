import type { PublicRunEvent } from "../runtime/publicRunEvents.js";
export type DelegateState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "merged";
export type DelegateProfile = "coder" | "explore" | "plan";
export interface DelegateRequest {
    readonly task: string;
    readonly scopes: readonly string[];
    readonly maxSteps: number;
    readonly profile?: DelegateProfile;
}
export interface DelegateReview {
    readonly manifestHash: string;
    readonly changedFiles: readonly string[];
    readonly filesAdded: number;
    readonly filesDeleted: number;
    readonly filesModified: number;
}
export interface DelegateRunResult {
    readonly status: "completed" | "failed" | "cancelled";
    readonly sessionRoot?: string;
    readonly answer?: string;
    readonly steps?: number;
    readonly review?: DelegateReview;
    readonly error?: string;
}
export interface DelegateRunHooks {
    readonly onEvent: (event: PublicRunEvent) => void;
}
export interface DelegateRunHandle {
    readonly done: Promise<DelegateRunResult>;
    cancel(): void;
}
export interface DelegateRunnerPort {
    start(request: DelegateExecutionRequest, hooks: DelegateRunHooks): DelegateRunHandle;
}
export interface DelegateExecutionRequest extends DelegateRequest {
    readonly id: string;
    readonly parentWorkspace: string;
    readonly depth: number;
}
export interface DelegateMergePort {
    merge(record: DelegateRecord, confirmation: string): Promise<{
        readonly transactionId: string;
    }>;
}
export interface DelegateRecord extends DelegateRequest {
    readonly id: string;
    readonly state: DelegateState;
    readonly depth: number;
    readonly createdAt: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly sessionRoot?: string;
    readonly answer?: string;
    readonly steps?: number;
    readonly review?: DelegateReview;
    readonly error?: string;
    readonly mergeTransactionId?: string;
}
export interface DelegationCoordinatorOptions {
    readonly storeFile: string;
    readonly parentWorkspace: string;
    readonly runner: DelegateRunnerPort;
    readonly merger: DelegateMergePort;
    readonly depth?: number;
    readonly maxDepth?: number;
    readonly maxConcurrent?: number;
    readonly maxChildren?: number;
    readonly maxChildSteps?: number;
    readonly maxTotalSteps?: number;
    readonly onEvent?: (event: PublicRunEvent) => void;
}
/**
 * Durable, bounded scheduler for real isolated child executions.
 *
 * Children never mutate the parent workspace directly. A successful child
 * returns a Phase-5 review manifest; only an explicit, hash-confirmed merge
 * may apply it, with the merger responsible for drift/conflict checks.
 */
export declare class DelegationCoordinator {
    #private;
    private constructor();
    static open(options: DelegationCoordinatorOptions): Promise<DelegationCoordinator>;
    start(request: DelegateRequest): Promise<DelegateRecord>;
    list(): readonly DelegateRecord[];
    get(id: string): DelegateRecord;
    wait(id: string, timeoutMs?: number): Promise<DelegateRecord>;
    cancel(id: string): Promise<DelegateRecord>;
    merge(id: string, confirmation: string): Promise<DelegateRecord>;
    completionBlockers(): readonly string[];
    snapshot(): {
        readonly depth: number;
        readonly active: number;
        readonly children: readonly DelegateRecord[];
    };
    close(): Promise<void>;
}
