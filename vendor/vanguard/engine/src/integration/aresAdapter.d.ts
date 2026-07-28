import { AresBetaTelemetry } from "./betaTelemetry.js";
import { type AresRouteClaimStorePort } from "./aresRouteClaimStore.js";
import { type AresAdapterCreateInput, type AresAdapterResumeInput, type AresAdapterSessionStatus, type AresLegacyCorePort, type AresTurnEvent, type AresTurnEventPage, type AresVanguardEnginePort } from "./aresTypes.js";
import { type AresRolloutConfigProvider, type AresVanguardRolloutConfig } from "./rollout.js";
export interface AresVanguardAdapterOptions {
    readonly vanguard: AresVanguardEnginePort;
    readonly legacy: AresLegacyCorePort;
    /** Host-owned durable route arbitration. Required before either core may be dispatched. */
    readonly routeClaims: AresRouteClaimStorePort;
    /** Static config or live provider. The default is strictly off. */
    readonly rollout?: AresVanguardRolloutConfig | AresRolloutConfigProvider;
    readonly telemetry?: AresBetaTelemetry;
    readonly maxReplayEvents?: number;
    /** Bounds queued push callbacks before they collapse into one replay reconciliation. */
    readonly maxPendingPushEvents?: number;
    readonly maxSessions?: number;
    /** Maximum wait for foreign-port work during kill-switch/shutdown barriers. */
    readonly barrierTimeoutMs?: number;
    /** Deadline for each async foreign-port operation before fail-closed recovery. */
    readonly foreignOperationTimeoutMs?: number;
    readonly logger?: (line: string) => void;
    readonly now?: () => number;
}
/**
 * Additive Ares integration boundary. Vanguard is never selected unless the
 * rollout policy says yes. The adapter consumes only Vanguard's public engine
 * contract and produces its own minimal, dependency-free TurnEvent contract.
 */
export declare class AresVanguardAdapter {
    #private;
    constructor(options: AresVanguardAdapterOptions);
    create(input: AresAdapterCreateInput): Promise<AresAdapterSessionStatus>;
    resume(input: AresAdapterResumeInput): Promise<AresAdapterSessionStatus>;
    send(sessionId: string, message: string): Promise<AresAdapterSessionStatus>;
    steer(sessionId: string, message: string): Promise<AresAdapterSessionStatus>;
    interrupt(sessionId: string): Promise<AresAdapterSessionStatus>;
    status(sessionId: string): Promise<AresAdapterSessionStatus>;
    events(sessionId: string, afterCursor?: number, limit?: number): Promise<AresTurnEventPage>;
    subscribe(listener: (event: AresTurnEvent) => void): () => void;
    /** Applies a live emergency kill switch to every Vanguard-routed session. */
    enforceKillSwitch(): Promise<AresAdapterBarrierReport>;
    shutdown(): Promise<AresAdapterBarrierReport>;
}
export interface AresAdapterBarrierReport {
    readonly complete: boolean;
    readonly unresolvedStarts: number;
    readonly unresolvedSessions: number;
    readonly unresolvedForeignOperations: number;
}
