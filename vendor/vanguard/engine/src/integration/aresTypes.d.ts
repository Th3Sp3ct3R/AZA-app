import type { VanguardEngineEvent, VanguardEventPage, VanguardSessionConfig, VanguardSessionStatus } from "../engine/types.js";
export declare const ARES_VANGUARD_ADAPTER_VERSION: 1;
export type AresAdapterRoute = "vanguard" | "legacy" | "manual_recovery";
export type AresAdapterState = "idle" | "running" | "waiting_for_user" | "cancelling" | "cancelled" | "completed" | "failed" | "manual_recovery";
/**
 * Deliberately small Ares-facing event contract. It is structurally compatible
 * with a conventional TurnEvent consumer without importing Ares internals.
 */
export interface AresTurnEvent {
    readonly version: typeof ARES_VANGUARD_ADAPTER_VERSION;
    readonly sessionId: string;
    readonly cursor: number;
    readonly source: "vanguard" | "legacy" | "adapter";
    readonly kind: "assistant.delta" | "assistant.message" | "tool.started" | "tool.completed" | "tool.failed" | "verification.completed" | "turn.contracted" | "turn.waiting_for_user" | "turn.completed" | "turn.failed" | "recovery.scheduled" | "recovery.exhausted" | "context.compacted" | "route.changed" | "replay.gap" | "adapter.notice";
    readonly status: "pending" | "passed" | "failed" | "info";
    readonly upstreamCursor?: number;
    readonly agentId?: string;
    readonly title?: string;
    readonly message?: string;
    readonly detail?: string;
    readonly tool?: string;
    readonly replay?: {
        readonly requestedAfterCursor: number;
        readonly availableFromCursor: number;
    };
}
export interface AresTurnEventPage {
    readonly sessionId: string;
    readonly events: readonly AresTurnEvent[];
    readonly afterCursor: number;
    readonly latestCursor: number;
    readonly replayFloorCursor: number;
    /** Explicitly true when the caller requested events no longer retained. */
    readonly gap: boolean;
    readonly hasMore: boolean;
}
export interface AresAdapterSessionStatus {
    readonly sessionId: string;
    readonly route: AresAdapterRoute;
    readonly state: AresAdapterState;
    readonly latestCursor: number;
    readonly replayFloorCursor: number;
    readonly fallbackReason?: AresFallbackReason;
    readonly requiresManualRecovery: boolean;
}
export interface AresAdapterCreateInput {
    /** Durable host idempotency key; the same key must never describe different input. */
    readonly operationId: string;
    /** Used only for deterministic rollout and pseudonymization; never emitted. */
    readonly actorId: string;
    readonly optedIn: boolean;
    readonly vanguard: VanguardSessionConfig;
    readonly legacy: AresLegacyCreateInput;
}
export interface AresAdapterResumeInput {
    /** Used only for deterministic rollout and pseudonymization; never emitted. */
    readonly actorId: string;
    readonly optedIn: boolean;
    /** Identifies an existing Vanguard session; unsafe/ineligible resume never silently switches cores. */
    readonly vanguardSessionRoot: string;
    /** Used only by a later proven-pristine fallback after Vanguard resume succeeds. */
    readonly legacy: AresLegacyResumeInput;
}
export interface AresLegacyCreateInput {
    readonly workspace: string;
}
export interface AresLegacyResumeInput {
    readonly sessionRoot: string;
}
export interface AresLegacySessionStatus {
    readonly sessionId: string;
    readonly state: Exclude<AresAdapterState, "manual_recovery">;
    readonly workerActive: boolean;
    readonly workerGeneration: number;
    readonly ownerEpoch: number;
    readonly latestCursor: number;
    readonly replayFloorCursor: number;
}
export interface AresLegacyEvent {
    readonly cursor: number;
    readonly kind: AresTurnEvent["kind"];
    readonly status?: AresTurnEvent["status"];
    readonly title?: string;
    readonly message?: string;
    readonly detail?: string;
    readonly tool?: string;
}
export interface AresLegacyEventPage {
    readonly events: readonly AresLegacyEvent[];
    readonly latestCursor: number;
    readonly replayFloorCursor: number;
    readonly gap: boolean;
    readonly hasMore: boolean;
}
/**
 * Attests that the exact worker owned by a session can no longer execute.
 * A control-delivery acknowledgement or terminal-looking run event is not a
 * substitute: implementations must resolve only after the worker lifecycle
 * itself has settled and every deferred launch has been disarmed.
 */
export interface AresWorkerStopReceipt {
    readonly version: 1;
    readonly sessionId: string;
    readonly stopped: boolean;
    readonly workerGeneration: number;
    readonly ownerEpoch?: number;
}
/** Host-owned legacy core boundary. No Ares package is required by Vanguard. */
export interface AresLegacyCorePort {
    /** Must include sessions.executionTreeFenced; top-level process exit alone is insufficient. */
    capabilities(): readonly string[];
    /** MUST durably deduplicate this operationId across process restarts. */
    create(input: AresLegacyCreateInput, operationId: string): Promise<AresLegacySessionStatus>;
    resume(input: AresLegacyResumeInput): Promise<AresLegacySessionStatus>;
    send(sessionId: string, message: string): Promise<AresLegacySessionStatus>;
    steer(sessionId: string, message: string): Promise<AresLegacySessionStatus>;
    interrupt(sessionId: string): Promise<AresLegacySessionStatus>;
    stopAndWait(sessionId: string, timeoutMs?: number): Promise<AresWorkerStopReceipt>;
    status(sessionId: string): Promise<AresLegacySessionStatus>;
    events(sessionId: string, afterCursor: number, limit: number): Promise<AresLegacyEventPage>;
}
/** The exact public VanguardEngine surface consumed by the adapter. */
export interface AresVanguardEnginePort {
    /** Must include sessions.executionTreeFenced; top-level worker exit alone is insufficient. */
    capabilities(): readonly string[];
    /** MUST durably deduplicate this operationId across process restarts. */
    create(config: VanguardSessionConfig, operationId: string): Promise<VanguardSessionStatus>;
    resume(sessionRoot: string): Promise<VanguardSessionStatus>;
    advance(sessionId: string, message?: string): VanguardSessionStatus;
    steer(sessionId: string, message: string): VanguardSessionStatus;
    cancel(sessionId: string): VanguardSessionStatus;
    stopAndWait(sessionId: string, timeoutMs?: number): Promise<AresWorkerStopReceipt>;
    status(sessionId: string): VanguardSessionStatus;
    events(sessionId: string, afterCursor?: number, limit?: number): VanguardEventPage;
    subscribe(listener: (event: VanguardEngineEvent) => void): () => void;
}
export type AresFallbackReason = "rollout_ineligible" | "kill_switch" | "vanguard_startup_failure" | "vanguard_protocol_failure" | "vanguard_critical_failure" | "legacy_protocol_failure";
