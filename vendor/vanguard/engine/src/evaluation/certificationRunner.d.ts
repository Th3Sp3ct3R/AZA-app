import type { JsonValue } from "../kernel/contracts.js";
import type { CertificationManifest, CertificationIsolationPolicy, CertificationExecutionProof, EvaluatorEvidenceAttestation, EvaluationEngine, EvaluationTask, ExternalEvaluatorAuthority, NormalizedUsageEvidence, PrivateAssignment, PrivateAssignmentArtifact, PublicAssignment, PublicAssignmentArtifact } from "./certification.js";
export interface EvaluatorRunRequest {
    readonly manifestSha256: string;
    readonly publicAssignment: PublicAssignment;
    readonly privateAssignment: PrivateAssignment;
    readonly engine: EvaluationEngine;
    readonly task: EvaluationTask;
    readonly attempt: number;
    /** Unique per scheduled attempt; prevents replay after crash recovery. */
    readonly invocationId: string;
    /**
     * Evaluator-keyed commitment to the private mapping, full engine pin,
     * category track policy, task, attempt, and invocation. Safe to journal.
     */
    readonly engineExecutionBindingSha256: string;
}
export interface IsolationEvidence {
    readonly workspaceId: string;
    readonly mechanism: string;
    readonly cleanAtStart: boolean;
    readonly originalWorkspaceUnmodified: boolean;
    readonly inputBundleSha256: string;
    readonly sourceSha256: string;
    readonly graderSha256: string;
    readonly evidenceSha256: string;
    readonly attestation: HostIsolationAttestation;
}
export interface HostIsolationAttestation {
    readonly runId: string;
    readonly manifestSha256: string;
    readonly assignmentBindingSha256: string;
    readonly privateBindingSha256: string;
    readonly engineExecutionBindingSha256: string;
    readonly attempt: number;
    readonly invocationId: string;
    readonly inputBundleSha256: string;
    readonly sourceSha256: string;
    readonly graderSha256: string;
    readonly workspaceId: string;
    readonly mechanism: string;
    readonly isolationEvidenceSha256: string;
    readonly networkPolicySha256: string;
    readonly resourcePolicySha256: string;
    readonly cleanAtStart: true;
    readonly originalWorkspaceUnmodified: true;
    readonly readOnlyInputs: true;
    readonly noHostCredentials: true;
    readonly disposableWorkspace: true;
    readonly teardownRequired: true;
    readonly issuerId: string;
    readonly keyId: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly statementSha256: string;
    readonly signatureBase64: string;
}
export interface IsolationAttestationVerification {
    readonly verifierId: string;
    readonly policyId: string;
    readonly executionMode: "externally-isolated" | "dry-run";
    readonly verifiedAt: string;
    readonly verificationEvidenceSha256: string;
    readonly valid: true;
}
export interface InterventionEvidence {
    readonly kind: string;
    readonly actorId: string;
    readonly occurredAt: string;
    readonly evidenceSha256: string;
}
export interface ExternalRunOutcome {
    readonly runId: string;
    readonly assignmentBindingSha256: string;
    readonly privateBindingSha256: string;
    readonly executionMode: "externally-isolated" | "dry-run";
    readonly success: boolean;
    readonly criticalIncident: boolean;
    readonly toolCalls: number;
    readonly steps: number;
    readonly isolation: IsolationEvidence;
    readonly interventions: readonly InterventionEvidence[];
    readonly usage: NormalizedUsageEvidence;
    readonly costUsd: number | null;
    readonly costEvidenceSha256: string;
    readonly graderEvidenceSha256: string;
    readonly artifactEvidenceSha256: string;
    readonly evaluatorAttestation: EvaluatorEvidenceAttestation;
}
/** Implemented by the external evaluator, never by the candidate engine. */
export interface ExternalRunAdapter {
    readonly adapterId: string;
    readonly executionMode: "externally-isolated" | "dry-run";
    run(request: EvaluatorRunRequest, signal: AbortSignal): Promise<ExternalRunOutcome>;
}
/** A separately configured trust root verifies host/container attestations. */
export interface IsolationAttestationVerifierPort {
    readonly verifierId: string;
    readonly policyId: string;
    readonly executionMode: "externally-isolated" | "dry-run";
    verify(request: EvaluatorRunRequest, evidence: IsolationEvidence, signal: AbortSignal): Promise<IsolationAttestationVerification>;
}
interface ExecutionEventBase {
    readonly runId: string;
    readonly attempt: number;
    readonly assignmentBindingSha256: string;
    readonly privateBindingSha256: string;
    readonly occurredAt: string;
}
export type CertificationExecutionEvent = (ExecutionEventBase & {
    readonly kind: "execution.started";
    readonly invocationId: string;
}) | (ExecutionEventBase & {
    readonly kind: "execution.interrupted";
    readonly reason: "orphaned-on-resume" | "evaluator-cancelled";
}) | (ExecutionEventBase & {
    readonly kind: "execution.timed-out";
    readonly timeoutMs: number;
    readonly failureEvidenceSha256: string;
}) | (ExecutionEventBase & {
    readonly kind: "execution.failed";
    readonly failureCode: string;
    readonly retryable: boolean;
    readonly failureEvidenceSha256: string;
}) | (ExecutionEventBase & {
    readonly kind: "execution.completed";
    readonly durationMs: number;
    readonly executionEvidenceSha256: string;
    readonly isolationVerification: IsolationAttestationVerification;
    readonly outcome: ExternalRunOutcome;
});
export interface CertificationExecutionLedgerEntry {
    readonly index: number;
    readonly previousHash: string;
    readonly hash: string;
    readonly event: CertificationExecutionEvent;
}
/**
 * append is compare-and-swap: a durable implementation must reject the write
 * when expectedPreviousHash is no longer its current head.
 */
export interface CertificationExecutionLedgerPort {
    load(): Promise<readonly CertificationExecutionLedgerEntry[]>;
    append(expectedPreviousHash: string, entry: CertificationExecutionLedgerEntry): Promise<void>;
}
export interface CertificationExecutionOptions {
    readonly maxInfrastructureAttempts?: number;
    readonly retryTimedOut?: boolean;
    readonly now?: () => Date;
    readonly invocationId?: () => string;
}
export interface CertificationExecutionSummary {
    readonly scheduled: number;
    readonly completed: number;
    readonly failed: number;
    readonly timedOut: number;
    readonly resumedOrphans: number;
    readonly skippedCompleted: number;
    readonly skippedExhausted: number;
    readonly ledgerHead: string;
}
export declare class CertificationExecutionOrchestrator {
    #private;
    constructor(manifest: CertificationManifest, publicArtifact: PublicAssignmentArtifact, privateArtifact: PrivateAssignmentArtifact, authority: ExternalEvaluatorAuthority, adapter: ExternalRunAdapter, attestationVerifier: IsolationAttestationVerifierPort, store: CertificationExecutionLedgerPort, options?: CertificationExecutionOptions);
    run(signal?: AbortSignal): Promise<CertificationExecutionSummary>;
}
export declare class FileCertificationExecutionLedger implements CertificationExecutionLedgerPort {
    #private;
    constructor(file: string);
    load(): Promise<readonly CertificationExecutionLedgerEntry[]>;
    append(expectedPreviousHash: string, entry: CertificationExecutionLedgerEntry): Promise<void>;
}
export declare class MemoryCertificationExecutionLedger implements CertificationExecutionLedgerPort {
    #private;
    constructor(entries?: readonly CertificationExecutionLedgerEntry[]);
    load(): Promise<readonly CertificationExecutionLedgerEntry[]>;
    append(expectedPreviousHash: string, entry: CertificationExecutionLedgerEntry): Promise<void>;
}
export declare function appendExecutionEvent(store: CertificationExecutionLedgerPort, ledger: readonly CertificationExecutionLedgerEntry[], event: CertificationExecutionEvent): Promise<readonly CertificationExecutionLedgerEntry[]>;
export declare function validateExecutionLedger(ledger: readonly CertificationExecutionLedgerEntry[], assignments?: PublicAssignmentArtifact, privateAssignments?: PrivateAssignmentArtifact): void;
export declare function executionEvidence(outcome: ExternalRunOutcome, verification: IsolationAttestationVerification): string;
export declare function extractCertificationExecutionProofs(manifest: CertificationManifest, ledger: readonly CertificationExecutionLedgerEntry[], assignments: PublicAssignmentArtifact, privateAssignments: PrivateAssignmentArtifact, authority: ExternalEvaluatorAuthority): readonly CertificationExecutionProof[];
/** A no-network adapter used only to test evaluator plumbing and resume. */
export declare class DeterministicDryRunAdapter implements ExternalRunAdapter {
    readonly adapterId = "deterministic-dry-run/no-provider";
    readonly executionMode: "dry-run";
    calls: number;
    run(request: EvaluatorRunRequest, signal: AbortSignal): Promise<ExternalRunOutcome>;
}
/** Test-only trust root; its mode prevents use with a real execution adapter. */
export declare class DeterministicDryRunIsolationVerifier implements IsolationAttestationVerifierPort {
    readonly verifierId = "deterministic-dry-run/attestation-verifier";
    readonly policyId = "dry-run-only/not-certifiable";
    readonly executionMode: "dry-run";
    verify(request: EvaluatorRunRequest, evidence: IsolationEvidence, signal: AbortSignal): Promise<IsolationAttestationVerification>;
}
/**
 * Verifies an Ed25519 statement produced by an external container/VM host.
 * The candidate process supplies the statement but cannot mint a signature
 * for a trust root configured by the independent evaluator.
 */
export declare class SignedIsolationAttestationVerifier implements IsolationAttestationVerifierPort {
    #private;
    readonly verifierId: string;
    readonly policyId: string;
    readonly executionMode: "externally-isolated";
    constructor(policy: CertificationIsolationPolicy, now?: () => Date);
    verify(request: EvaluatorRunRequest, evidence: IsolationEvidence, signal: AbortSignal): Promise<IsolationAttestationVerification>;
}
export declare function externalRunOutcomeStatement(outcome: ExternalRunOutcome): JsonValue;
export declare function certificationEngineExecutionBinding(privateBindingSalt: string, manifestDigest: string, publicAssignment: PublicAssignment, privateAssignment: PrivateAssignment, engine: EvaluationEngine, task: EvaluationTask, attempt: number, invocationId: string): string;
export declare function isolationAttestationStatement(attestation: HostIsolationAttestation): JsonValue;
export {};
