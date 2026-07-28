import type { ContextPolicyPort, CompletionGatePort, JournalPort, JsonValue, ModelPort, TaskContract, PlanStatusPort, ToolPort, UserChannelPort, VerifierPort, VerificationResult, WorkingStatePort, WorkspaceStatePort, RunEvent } from "./contracts.js";
import { type RecoveryConfiguration } from "./recovery.js";
export interface RunOptions {
    readonly maxSteps: number;
    readonly maxRepeatedAction: number;
    readonly maxFailedVerificationAttempts: number;
    readonly maxCompletionEvidenceAttempts: number;
    readonly maxContextBytes: number;
    readonly maxConversationTurnSteps: number;
    readonly maxConsecutiveNarrations: number;
    /** Consecutive successful observe-only batches that add no new evidence before an actionable replan is injected. */
    readonly observationStagnationSoftLimit: number;
    /** Consecutive successful observe-only batches that add no new evidence before the run is bounded. */
    readonly observationStagnationHardLimit: number;
    /** Steps between runtime re-grounding notes during planned execution. */
    readonly regroundIntervalSteps: number;
    /**
     * Decision steps between full out-of-band workspace fingerprints. Tool
     * batches, post-inference, verification, and resume boundaries are always
     * checked exactly; this interval only paces the redundant pre-decision
     * check, whose unique coverage window (batch end → next decision) is tiny.
     * 1 restores the check-every-step behavior.
     */
    readonly boundaryFingerprintIntervalSteps: number;
    /**
     * What the pre-claim execution-evidence gate accepts after a mutation.
     *
     * `independent` — the default: only a real executable check (a project check
     * or an authorized process run) clears the gate. Correct for a codebase.
     *
     * `syntax` — a passing verify_syntax on the mutated file also clears it. For
     * a deliverable with nothing to execute (a static page, a document), the
     * independent gate is unsatisfiable: there is no command whose success would
     * mean anything, so the agent invents throwaway harnesses to appease it and
     * burns its budget. Syntax is then the strongest evidence that exists, and
     * the sealed verifier still runs unconditionally either way.
     */
    readonly executionEvidence: "independent" | "syntax";
    /** Total attempts for one safe, read-only tool action (initial + retries). */
    readonly maxToolRecoveryAttempts: number;
    /** Total attempts for a provider decision when the adapter has no retry loop. */
    readonly maxModelRecoveryAttempts: number;
    /**
     * Whether a user is available to answer questions. When false the kernel
     * does not offer `ask_user` and rejects ask_user decisions with feedback
     * instead of pausing, so headless runs cannot dead-end.
     */
    readonly interactive: boolean;
}
export type RunOutcome = {
    readonly status: "responded";
    readonly message: string;
    readonly steps: number;
} | {
    readonly status: "waiting_for_user";
    readonly question: string;
    readonly steps: number;
} | {
    readonly status: "contracted";
    readonly contract: TaskContract;
    readonly steps: number;
} | {
    readonly status: "completed";
    readonly answer: string;
    readonly steps: number;
    readonly verification: readonly VerificationResult[];
} | {
    readonly status: "failed";
    readonly reason: string;
    readonly steps: number;
};
export interface AdvanceInput {
    /** Starts execution directly on a fresh journal (the non-conversational path). */
    readonly task?: string;
    /** A new user message: a conversation turn or the answer to a pending question. */
    readonly userMessage?: string;
    /** When resuming, requires the journaled task to match this text. */
    readonly expectedTask?: string;
}
export interface KernelDependencies {
    readonly model: ModelPort;
    readonly tools: readonly ToolPort[];
    readonly verifiers: readonly VerifierPort[];
    readonly journal: JournalPort;
    readonly contextPolicy?: ContextPolicyPort;
    readonly workingState?: WorkingStatePort;
    /** Detects any reviewable workspace delta caused by tools or verifiers. */
    readonly workspaceState?: WorkspaceStatePort;
    /**
     * Runtime-owned parse of a freshly mutated file. When present, every
     * successful mutation is syntax-checked automatically right after its batch
     * — no model turn, and the journaled observation satisfies the same gates a
     * model-called verify_syntax would. The model only re-checks when it needs
     * a parse before its next decision.
     */
    readonly postMutationSyntaxCheck?: (relativePath: string) => Promise<{
        ok: boolean;
        output: JsonValue;
    }>;
    /** Runtime-owned policy text appended to the task when a contract is accepted. */
    readonly taskAddendum?: string;
    /** Live user-message channel enabling mid-run steering and in-process answers. */
    readonly userChannel?: UserChannelPort;
    /** Read-only view of the runtime-owned plan; activates the plan gates. */
    readonly plan?: PlanStatusPort;
    /** Runtime-owned asynchronous work that must settle before completion. */
    readonly completionGates?: readonly CompletionGatePort[];
    /** Durable retry budgets and an injectable clock for deterministic tests. */
    readonly recovery?: RecoveryConfiguration;
    readonly options?: Partial<RunOptions>;
}
export declare class AgentKernel {
    #private;
    constructor(dependencies: KernelDependencies);
    /**
     * Compatibility entry: starts (or resumes) direct execution of a task.
     * Equivalent to advance({ task }) on a fresh journal.
     */
    run(task: string, signal?: AbortSignal, priorEvents?: readonly RunEvent[]): Promise<RunOutcome>;
    /**
     * Advances the session by one interaction: a conversation turn, an answer
     * to a pending question, or continued execution. Returns when the session
     * yields control (responded / waiting_for_user / contracted) or the run
     * terminates (completed / failed).
     */
    advance(input: AdvanceInput, signal?: AbortSignal, priorEvents?: readonly RunEvent[]): Promise<RunOutcome>;
}
/**
 * The plan-free small-change lane: this many narrow exact-text replacements
 * may proceed without a durable plan, and a passing verify_syntax satisfies
 * the pre-claim execution-evidence gate while inside it. Sealed completion
 * verification is unaffected.
 */
export declare const SMALL_CHANGE_MUTATION_BUDGET = 3;
