export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface ToolCall {
    readonly id: string;
    readonly name: string;
    readonly input: JsonValue;
}
/**
 * A task contract is the explicit boundary between conversation and execution.
 * Mutation and execution tools become available only after a contract exists.
 * Beyond the objective and observable criteria, a durable engineering
 * contract records what must NOT change, what is out of scope, and what the
 * model assumed — so long-horizon work cannot silently drift.
 */
export interface TaskContract {
    readonly objective: string;
    readonly successCriteria: readonly string[];
    readonly constraints?: readonly string[];
    readonly nonGoals?: readonly string[];
    readonly assumptions?: readonly string[];
    readonly riskLevel?: "low" | "medium" | "high";
    readonly requiredVerification?: readonly string[];
    readonly deliverables?: readonly string[];
    /**
     * For user-facing deliverables: the named concept, identity, and attitude
     * the work commits to. Correctness gates prove "done"; this is the part of
     * the contract that defines "good", and it survives re-grounding with the
     * rest of the contract text.
     */
    readonly creativeDirection?: string;
    readonly notes?: string;
}
export type KernelMode = "conversation" | "execution";
/**
 * Names of the control surface the kernel offers to the model as synthetic
 * tools. They are decisions, not ToolPorts: codecs decode calls to these
 * names into typed decisions and the kernel never dispatches them.
 */
export declare const CONTROL_TOOL_NAMES: {
    readonly ask: "ask_user";
    readonly execute: "execute_task";
    readonly complete: "complete_task";
};
/** The runtime-owned plan tool; its presence activates the plan gates. */
export declare const PLAN_TOOL_NAME = "update_plan";
/**
 * Pre-rename spellings of the built-in tools, kept so journals written before
 * the flat snake_case names replay against the tools they meant. Decode-only:
 * nothing ever advertises or emits these names.
 */
export declare const LEGACY_TOOL_NAMES: Readonly<Record<string, string>>;
/** The kernel's read-only view of the runtime-owned plan. */
/** Result of a runtime-owned stale-proof refresh on the plan ledger. */
export interface PlanProofRefresh {
    /** True when stale proofs were re-bound to fresh evidence and persisted as a new revision. */
    readonly refreshed: boolean;
    readonly revision?: number;
    readonly stateSha256?: string;
    readonly milestones?: number;
    /** Milestones still stale after the attempt, as "id - title" labels. */
    readonly remaining: readonly string[];
}
export interface PlanStatusPort {
    /** True until an initial plan has been materialized. */
    isEmpty(): boolean;
    /** Milestones not yet proven or invalidated, as "id — title" labels. */
    unproven(): readonly string[];
    /** Proven milestones whose executable evidence is no longer current. */
    evidenceBlockers?(): Promise<readonly string[]>;
    /**
     * Runtime-owned staleness repair: re-bind proven-but-stale milestones to
     * fresh current-generation execution/review evidence derived from the
     * journal, persisting through the same validated revision path a
     * model-driven update_plan would take. Never proves an unproven milestone.
     */
    refreshStaleProofs?(): Promise<PlanProofRefresh>;
    /**
     * Ownership-boundary drift guard: when milestones declare scope, a mutation
     * of a workspace path that no non-invalidated milestone owns returns the
     * rejection reason; undefined means the path is in scope (or no scope is
     * declared anywhere, which keeps scope-free plans unrestricted).
     */
    scopeBlocker?(relativePath: string): string | undefined;
}
/**
 * Runtime-owned work that must settle before a completion claim can be
 * verified. This intentionally stays generic: delegation, background
 * verification, or future durable jobs can all participate without teaching
 * the kernel their domain-specific state machines.
 */
export interface CompletionGatePort {
    /** Human-readable blockers. An empty list means the gate is open. */
    blockers(): readonly string[];
}
export type ModelDecision = {
    readonly kind: "respond";
    readonly message: string;
    readonly continuation?: JsonValue;
} | {
    readonly kind: "ask_user";
    readonly question: string;
    readonly continuation?: JsonValue;
} | {
    readonly kind: "execute";
    readonly contract: TaskContract;
    readonly continuation?: JsonValue;
} | {
    readonly kind: "tools";
    readonly calls: readonly ToolCall[];
    readonly continuation?: JsonValue;
} | {
    readonly kind: "complete";
    readonly answer: string;
    readonly continuation?: JsonValue;
};
/**
 * Normalizes a journaled or wire decision into the current ModelDecision
 * shape. Accepts the legacy single-call `{ kind: "tool", call }` form so
 * existing journals remain resumable. Returns undefined for unrecognized
 * shapes.
 */
export declare function normalizeDecision(value: JsonValue): ModelDecision | undefined;
export declare function normalizeContract(value: JsonValue | undefined): TaskContract | undefined;
export declare function renderContract(contract: TaskContract): string;
export interface TranscriptEntry {
    /**
     * `history` is runtime-authored, inert context. It must never be interpreted
     * as a human instruction or as the answer to a pending `ask_user` call.
     * `runtime` is fixed runtime guidance, distinct from actual human input so
     * context selection can preserve the latest human correction precisely. It
     * must never contain raw model- or workspace-authored prose.
     */
    readonly role: "task" | "user" | "runtime" | "history" | "decision" | "observation" | "verification";
    readonly content: JsonValue;
}
/** Inert logical tail entry for model/workspace-authored working-state data. */
export declare function workingStateTailEntry(workingState: JsonValue): TranscriptEntry;
/**
 * Exact dynamic tail sent to providers and reserved by the context budget.
 * When a real human message exists, repeat it after inert state so no
 * model/workspace-authored string can become the final authoritative user
 * message on the wire.
 */
export declare function workingStateTailEntries(workingState: JsonValue, transcript: readonly TranscriptEntry[]): readonly TranscriptEntry[];
export interface ModelRequest {
    readonly task: string;
    readonly mode: KernelMode;
    readonly transcript: readonly TranscriptEntry[];
    readonly tools: readonly ToolDefinition[];
    readonly remainingSteps: number;
    readonly signal: AbortSignal;
    readonly workingState: JsonValue;
    /** Provider adapters use this instead of maintaining hidden retry state. */
    readonly recovery?: RecoveryPort;
}
export interface ModelPort {
    decide(request: ModelRequest): Promise<ModelDecision>;
}
export interface ToolContext {
    readonly task: string;
    readonly step: number;
    readonly signal: AbortSignal;
}
export interface ToolResult {
    readonly ok: boolean;
    readonly output: JsonValue;
}
/**
 * Explicit runtime authority for tool results that may prove a plan
 * milestone. A tool's broad `effect` is not evidence authority: arbitrary
 * execute tools (including extensions and raw process access) remain
 * ineligible unless trusted runtime code opts them into one of these narrow
 * classes.
 */
export type ToolEvidenceAuthority = "independent-execution" | "independent-review";
/**
 * The journaled and transcripted record of one tool call's outcome. `callId`
 * and `tool` bind the observation to its originating call so batched calls
 * remain unambiguous for providers, metrics, and resume.
 */
export interface ToolObservation {
    /**
     * Runtime-owned, journal-scoped handle for citing this exact observation as
     * plan evidence. Unlike provider call ids, this value is unique per model
     * decision/call position and is never sent back as a provider continuation
     * identifier.
     */
    readonly evidenceId?: string;
    /** Runtime-owned authority copied from the registered ToolDefinition. */
    readonly evidenceAuthority?: ToolEvidenceAuthority;
    /** Runtime-owned candidate-workspace epoch at which this result was made. */
    readonly workspaceGeneration?: number;
    /** True only on a successful mutation that advanced workspaceGeneration. */
    readonly workspaceMutation?: true;
    /**
     * Runtime-computed: a passing verify_syntax that satisfied the post-change
     * execution-evidence gate inside the bounded plan-free small-change lane.
     * This is deliberately distinct from evidenceAuthority so it can never be
     * cited as plan-milestone execution proof.
     */
    readonly smallChangeExecutionEvidence?: true;
    /**
     * Runtime-measured wall-clock cost of this exact call's execution, from
     * dispatch to settled result. Presentation-grade truth: without it, clients
     * can only bracket whole batches (fingerprints, journaling, and all) and
     * every per-tool number they show is fiction.
     */
    readonly durationMs?: number;
    readonly callId: string;
    readonly tool: string;
    readonly ok: boolean;
    readonly output?: JsonValue;
    readonly error?: string;
    /** Stable machine-readable diagnosis supplied by the recovery runtime. */
    readonly failure?: FailureDescriptor;
    /** Actionable next step; unlike the raw error, this is safe to plan from. */
    readonly recovery?: RecoveryFeedback;
}
export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
    readonly effect?: "observe" | "mutate" | "execute" | "review" | "state";
    /**
     * Opt-in plan-proof authority. This must agree with `effect`; the kernel
     * rejects mismatches. Omission is deliberately fail-closed.
     */
    readonly evidenceAuthority?: ToolEvidenceAuthority;
}
export type FailureSource = "provider" | "tool" | "process" | "verifier" | "policy" | "context" | "environment";
export type FailureDisposition = "transient" | "deterministic" | "policy" | "environment" | "cancelled";
/** Versioned failure taxonomy shared by adapters, journals, and scorecards. */
export interface FailureDescriptor {
    readonly version: 1;
    readonly code: "provider_timeout" | "provider_rate_limited" | "provider_conflict" | "provider_unavailable" | "provider_disconnect" | "provider_protocol_invalid" | "provider_authentication" | "provider_request_invalid" | "tool_transient" | "tool_failed" | "process_exit" | "process_timeout" | "verifier_failed" | "verifier_exception" | "policy_denied" | "context_budget" | "context_invalid" | "environment_missing_dependency" | "environment_io" | "cancelled" | "unknown_failure";
    readonly source: FailureSource;
    readonly disposition: FailureDisposition;
    readonly retryable: boolean;
    readonly message: string;
    readonly status?: number;
    readonly retryAfterMs?: number;
}
export interface RecoveryFeedback {
    readonly action: "retry_scheduled" | "change_approach" | "repair_environment" | "respect_policy" | "replan_and_checkpoint" | "stop_cancelled";
    readonly guidance: string;
    readonly retryDelayMs?: number;
    readonly remainingGlobalRetries: number;
    readonly remainingClassRetries: number;
}
export interface RecoveryRequest {
    readonly operation: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly idempotent: boolean;
    readonly failure: FailureDescriptor;
}
export interface RecoveryDecision {
    readonly retry: boolean;
    readonly reason: string;
    readonly failure: FailureDescriptor;
    readonly feedback: RecoveryFeedback;
    readonly delayMs?: number;
}
/** Runtime-owned recovery port; implementations journal budgets and delays. */
export interface RecoveryPort {
    handle(request: RecoveryRequest, signal: AbortSignal): Promise<RecoveryDecision>;
}
export interface ToolPort {
    readonly name: string;
    readonly definition: ToolDefinition;
    execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}
export interface ContextPolicyPort {
    select(task: string, transcript: readonly TranscriptEntry[], maxBytes: number, reservedTail?: readonly TranscriptEntry[]): readonly TranscriptEntry[];
}
/**
 * A live channel of user messages arriving while the kernel runs. Drained
 * messages are journaled and injected at the next decision boundary, so
 * steering is durable and never interrupts an in-flight tool call.
 */
export interface UserChannelPort {
    /** Returns and removes every message queued since the last drain. */
    drain(): readonly string[];
    /**
     * Waits for the next user message. Resolves undefined when the channel
     * closes or the signal aborts, in which case the kernel pauses durably.
     */
    wait(signal: AbortSignal): Promise<string | undefined>;
}
export interface WorkingStatePort {
    snapshot(): JsonValue;
}
/** Runtime-owned fingerprint of the reviewable candidate workspace. */
export interface WorkspaceStatePort {
    fingerprint(): Promise<string>;
}
export interface VerificationResult {
    readonly verifier: string;
    readonly passed: boolean;
    readonly evidence: JsonValue;
    /** Runtime-owned candidate-workspace epoch for journaled verification. */
    readonly workspaceGeneration?: number;
}
export interface VerifierPort {
    readonly name: string;
    verify(candidate: string, task: string): Promise<VerificationResult>;
}
export type RunEventType = "run.started" | "run.resumed" | "run.contracted" | "run.waiting_for_user" | "user.message" | "runtime.note" | "context.compacted" | "model.decided" | "tool.completed" | "tool.failed" | "verification.started" | "verification.completed" | "verification.finished" | "recovery.decided" | "recovery.delayed" | "recovery.exhausted" | "recovery.replan_required" | "run.completed" | "run.failed" | "change.reviewed" | "change.applied" | "change.reverted" | "session.checkpointed" | "session.restored" | "session.forked" | "workspace.observed" | "workspace.changed";
export interface RunEvent {
    readonly sequence: number;
    readonly type: RunEventType;
    readonly data: JsonValue;
}
export interface JournalPort {
    append(event: RunEvent): Promise<void>;
}
