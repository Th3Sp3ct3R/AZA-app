import type { PublicRunEvent } from "../runtime/publicRunEvents.js";
import type { CommandSpec } from "../runtime/projectVerification.js";
import type { SecurityProfile } from "../security/policy.js";
export declare const VANGUARD_PROTOCOL_VERSION: 1;
export declare const VANGUARD_PROTOCOL_CAPABILITIES: readonly ["sessions.create", "sessions.resume", "sessions.advance", "sessions.steer", "sessions.cancel", "sessions.stopAndWait", "sessions.status", "events.push", "events.replay"];
export declare const VANGUARD_IDEMPOTENT_CREATE_CAPABILITY: "sessions.create.idempotent";
export declare const VANGUARD_WORKER_FENCING_CAPABILITY: "sessions.workerFenced";
export declare const VANGUARD_EXECUTION_TREE_FENCING_CAPABILITY: "sessions.executionTreeFenced";
export type VanguardProvider = "openai" | "anthropic" | "deepseek" | "kimi" | "ollama" | "openai-compatible" | "http";
export interface VanguardSessionConfig {
    readonly workspace: string;
    /**
     * Edit the selected workspace directly while retaining a pristine session
     * baseline for review and rollback. This is persisted with the session so
     * embedded callers and resumed workers cannot disagree about where edits go.
     */
    readonly inPlace?: boolean;
    /** Edit the launch directory itself: no fingerprint, no copy, no baseline. Implies inPlace. */
    readonly direct?: boolean;
    readonly provider: VanguardProvider;
    readonly model: string;
    /**
     * Credential source for the provider. Defaults to `api-key` (the provider's
     * environment variable); `oauth` uses the subscription tokens minted by
     * `vanguard login` and is accepted only for openai, anthropic, and kimi.
     */
    readonly auth?: "api-key" | "oauth";
    /**
     * What the pre-claim gate accepts after a mutation. `syntax` suits a project
     * with no build/test contract, where no independent check exists to run.
     */
    readonly executionEvidence?: "independent" | "syntax";
    readonly endpoint?: string;
    /**
     * Environment variable naming the API key for an `openai-compatible`
     * endpoint (OpenRouter, gateways, self-hosted servers). Required for that
     * provider; the config carries only the variable name, never the value.
     */
    readonly credentialVariable?: string;
    readonly verification?: CommandSpec;
    readonly publicCheck?: CommandSpec;
    readonly adaptiveVerification?: boolean;
    readonly allowedCommands?: readonly string[];
    readonly protectedPaths?: readonly string[];
    readonly editableRoots?: readonly string[];
    /** Named, auditable runtime posture. Defaults to `workspace`. */
    readonly securityProfile?: SecurityProfile;
    readonly restrictProcess?: boolean;
    readonly exposeRawProcess?: boolean;
    readonly verifierEvidence?: "full" | "summary";
    readonly maxSteps?: number;
    readonly maxDurationMs?: number;
    readonly commandTimeoutMs?: number;
    /** Kill an agent-run command after this long with no output; unset disables the idle watchdog. */
    readonly commandIdleTimeoutMs?: number;
    readonly maxContextBytes?: number;
    readonly maxFailedVerificationAttempts?: number;
}
export type VanguardSessionState = "idle" | "running" | "waiting_for_user" | "cancelling" | "cancelled" | "completed" | "failed";
export interface VanguardSessionStatus {
    readonly sessionId: string;
    readonly sessionRoot: string;
    readonly sourceRoot: string;
    readonly workspaceRoot: string;
    readonly materialized: boolean;
    readonly state: VanguardSessionState;
    /** True while a deferred launch or exact worker generation is still live. */
    readonly workerActive?: boolean;
    /** Monotonic within one registered engine session. */
    readonly workerGeneration?: number;
    /** Durable create-store fencing epoch when this session is owned. */
    readonly ownerEpoch?: number;
    readonly latestCursor: number;
    readonly replayFloorCursor: number;
}
export interface VanguardEngineEvent {
    readonly sessionId: string;
    readonly cursor: number;
    readonly event: PublicRunEvent;
}
export interface VanguardEventPage {
    readonly sessionId: string;
    readonly events: readonly VanguardEngineEvent[];
    readonly afterCursor: number;
    readonly latestCursor: number;
    readonly replayFloorCursor: number;
    /** True when the requested cursor predates the bounded replay window. */
    readonly gap: boolean;
    readonly hasMore: boolean;
}
export interface VanguardRunExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
}
export interface VanguardRunHandle {
    readonly done: Promise<VanguardRunExit>;
    steer(message: string): void;
    cancel(): void;
}
export interface VanguardRunHooks {
    readonly onEvent: (event: PublicRunEvent) => void;
    readonly onLog: (line: string) => void;
}
/**
 * Injectable execution boundary used by the embedded engine and tests.
 *
 * Ownership transfer is atomic at `start`: a synchronous throw is permitted
 * only before any external execution can have been dispatched. Once dispatch
 * may have occurred, `start` must return a handle. Its `done` promise must
 * settle only after that exact execution generation has actually closed; a
 * rejection means closure is uncertain and therefore cannot prove stop.
 */
export interface VanguardRunnerPort {
    /**
     * Explicit trusted-host attestation that `done` proves closure of the whole
     * execution tree through an OS/container primitive, not merely the direct
     * runner child. The built-in CLI runner intentionally does not attest this.
     */
    readonly executionTreeFencing?: {
        readonly version: 1;
        readonly exactTreeClose: true;
    };
    start(sessionRoot: string, message: string | undefined, hooks: VanguardRunHooks): VanguardRunHandle;
}
export interface VanguardStopReceipt {
    readonly version: 1;
    readonly sessionId: string;
    readonly stopped: boolean;
    readonly state: VanguardSessionState;
    readonly workerGeneration: number;
    readonly ownerEpoch?: number;
}
export interface VanguardShutdownReceipt {
    readonly version: 1;
    readonly complete: boolean;
    readonly stoppedSessionIds: readonly string[];
    readonly unresolvedSessionIds: readonly string[];
    /** In-flight create/resume operations that have not crossed a safe boundary. */
    readonly unresolvedOperations: number;
}
export type VanguardCreateFaultPoint = "claim_persisted" | "session_persisted" | "receipt_persisted" | "ownership_acquired" | "registration_pre_publish";
export interface VanguardCreateFaultContext {
    /** SHA-256 of the opaque host operation ID; the raw ID is never persisted. */
    readonly operationIdSha256: string;
    readonly configSha256: string;
    readonly sessionId: string;
    readonly sessionRoot: string;
}
export interface VanguardCreateOperationStoreOptions {
    /**
     * Dedicated durable directory owned by Vanguard's create-operation store.
     * Every engine instance that may receive a retry for the same operation must
     * be configured with the same directory.
     */
    readonly root: string;
    /**
     * Durability test/chaos hook. Throwing simulates process loss after the
     * named boundary; a new engine must recover through the persisted claim.
     */
    readonly faultInjector?: (point: VanguardCreateFaultPoint, context: VanguardCreateFaultContext) => void | Promise<void>;
}
export interface VanguardEngineOptions {
    readonly runner?: VanguardRunnerPort;
    /** Maximum replayable public events retained per live session. */
    readonly maxReplayEvents?: number;
    /** Serialized replay retention per session; count-only bounds are insufficient. */
    readonly maxReplayBytesPerSession?: number;
    /** Bounds registered sessions and therefore total replay memory. */
    readonly maxSessions?: number;
    /** Bounds live steering accepted during one advance. */
    readonly maxSteeringBytesPerAdvance?: number;
    /** Bounds shutdown's proof wait; unresolved workers are reported, never hidden. */
    readonly shutdownTimeoutMs?: number;
    /** Enables restart-safe idempotent create when a host supplies operationId. */
    readonly createOperationStore?: VanguardCreateOperationStoreOptions;
    readonly logger?: (line: string) => void;
}
export declare class VanguardEngineError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown> | undefined;
    constructor(code: string, message: string, retryable?: boolean, details?: Record<string, unknown> | undefined);
}
