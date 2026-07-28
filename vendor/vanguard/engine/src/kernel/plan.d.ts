import type { JsonValue, PlanProofRefresh, PlanStatusPort, RunEvent, TaskContract, ToolContext, ToolDefinition, ToolEvidenceAuthority, ToolPort, ToolResult } from "./contracts.js";
import { type DurableStateAnchorRequirement } from "./durableState.js";
export type MilestoneStatus = "pending" | "active" | "blocked" | "proven" | "invalidated";
export type EvidenceKind = "tool" | "verification" | "user";
/** A model claim. The runtime resolves it to one exact successful event. */
export interface EvidenceClaim {
    readonly kind: EvidenceKind;
    readonly sequence?: number;
    /** Runtime-owned journal handle preferred for fresh tool citations. */
    readonly evidenceId?: string;
    /** Provider continuation id retained for old journals and legacy models. */
    readonly callId?: string;
    readonly tool?: string;
    readonly verifier?: string;
    readonly exactText?: string;
}
/** Canonical, runtime-bound evidence persisted in the plan. */
export interface EvidenceRef extends EvidenceClaim {
    readonly sequence: number;
    readonly sha256: string;
    /** Runtime-derived authority; model-supplied copies are never accepted. */
    readonly evidenceAuthority?: ToolEvidenceAuthority;
    /** Candidate-workspace epoch in which executable evidence was produced. */
    readonly workspaceGeneration?: number;
}
export interface PlanInvalidation {
    readonly reason: string;
    readonly supersededBy: string;
    readonly evidence: EvidenceRef & {
        readonly kind: "user";
    };
}
export interface PlanMilestone {
    readonly id: string;
    readonly title: string;
    readonly acceptanceCriteria: readonly string[];
    readonly dependsOn: readonly string[];
    /** Stable task-contract criterion IDs owned by this milestone. */
    readonly covers: readonly string[];
    readonly status: MilestoneStatus;
    readonly evidence: readonly EvidenceRef[];
    readonly scope: readonly string[];
    readonly note?: string;
    readonly invalidation?: PlanInvalidation;
}
export interface PlanRevision {
    readonly revision: number;
    readonly summary: string;
    readonly at: string;
}
export interface PlanState {
    readonly revision: number;
    readonly requiredCriteria: readonly string[];
    readonly milestones: readonly PlanMilestone[];
    readonly history: readonly PlanRevision[];
}
export interface EvidenceResolverPort {
    resolve(claim: EvidenceClaim): Promise<EvidenceRef | undefined>;
    /** Revalidate an exact persisted reference without requiring it to be fresh. */
    revalidate?(reference: EvidenceRef): Promise<EvidenceRef | undefined>;
    /** Recent fresh runtime-authorized proof handles for actionable recovery. */
    eligibleToolEvidence?(limit?: number): Promise<readonly {
        evidenceId: string;
        tool: string;
        evidenceAuthority: ToolEvidenceAuthority;
    }[]>;
}
interface JournalReader {
    readValidated(): Promise<readonly RunEvent[]>;
}
/** Resolves claims only against successful, hash-chained journal events. */
export declare class JournalEvidenceResolver implements EvidenceResolverPort {
    #private;
    private readonly journal;
    constructor(journal: JournalReader);
    resolve(claim: EvidenceClaim): Promise<EvidenceRef | undefined>;
    revalidate(reference: EvidenceRef): Promise<EvidenceRef | undefined>;
    eligibleToolEvidence(limit?: number): Promise<readonly {
        evidenceId: string;
        tool: string;
        evidenceAuthority: ToolEvidenceAuthority;
    }[]>;
}
export declare function contractCriterionIds(contract: TaskContract): readonly string[];
/** Runtime-owned durable plan with monotonic, non-weakening revisions. */
export declare class PlanLedger implements PlanStatusPort {
    #private;
    constructor(initial?: PlanState, file?: string, requiredCriteria?: readonly string[], evidenceResolver?: EvidenceResolverPort);
    static open(file: string, requiredCriteria?: readonly string[], evidenceResolver?: EvidenceResolverPort, anchor?: DurableStateAnchorRequirement): Promise<PlanLedger>;
    isEmpty(): boolean;
    unproven(): readonly string[];
    /**
     * Keep authentic historical proof auditable after a mutation/restore, but
     * fail completion closed until every proven milestone is refreshed in the
     * current workspace generation.
     */
    evidenceBlockers(): Promise<readonly string[]>;
    attachEvidenceResolver(resolver: EvidenceResolverPort | undefined): void;
    /**
     * Runtime-owned staleness repair. A proven milestone whose evidence went
     * stale (a later mutation/restore advanced the workspace generation) is
     * re-bound to a fresh, eligible journal event — the exact refresh the model
     * could request via update_plan, derived without spending a model turn.
     * The write goes through the ordinary validated revision path, so the
     * strictly-newer-generation rule, monotonicity, and persistence integrity
     * all still hold; a refresh can never prove an unproven milestone, weaken a
     * milestone, or bind evidence the journal does not contain.
     */
    refreshStaleProofs(): Promise<PlanProofRefresh>;
    /**
     * Ownership-boundary drift guard. Scope entries are workspace-relative
     * paths, directory prefixes, or globs. Enforcement activates only when at
     * least one non-invalidated milestone declares scope, so scope-free plans
     * stay unrestricted; once ownership is declared anywhere, a mutation of a
     * path outside every declared scope is plan drift and returns a rejection
     * reason with the current owners.
     */
    scopeBlocker(relativePath: string): string | undefined;
    requiredCriteria(): readonly string[];
    state(): PlanState | undefined;
    snapshot(): JsonValue;
    update(summary: string, milestones: readonly PlanMilestone[]): Promise<PlanState>;
}
export declare class PlanTool implements ToolPort {
    #private;
    private readonly ledger;
    private readonly evidenceResolver?;
    readonly name = "update_plan";
    readonly definition: ToolDefinition;
    constructor(ledger: PlanLedger, evidenceResolver?: EvidenceResolverPort | undefined);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare function planStateSha256(state: PlanState): string;
export {};
