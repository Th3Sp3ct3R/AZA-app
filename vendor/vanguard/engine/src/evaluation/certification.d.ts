import type { JsonValue } from "../kernel/contracts.js";
export type EvaluationLayer = "canary" | "shadow" | "holdout";
export type ComparisonTrack = "harness-controlled" | "product-native";
export interface EvaluationTrackPolicy {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly toolCallBudget: number;
    readonly stepBudget: number;
    readonly inputTokenBudget: number;
    readonly outputTokenBudget: number;
    readonly commandArguments: readonly string[];
}
export interface EvaluationEngine {
    readonly id: string;
    readonly version: string;
    readonly command: string;
    readonly executableSha256: string;
    readonly environmentSha256: string;
    readonly authMode: "api-key" | "oauth" | "local";
    /** Frozen per task category/track; no runtime defaulting is permitted. */
    readonly trackPolicies: Readonly<Record<string, EvaluationTrackPolicy>>;
}
/**
 * repositoryId names the concrete repository snapshot. Related repositories
 * (for example a fork and its upstream) share an independenceGroupId and are
 * therefore sampled as one statistical unit. independenceEvidenceSha256 binds
 * the external evaluator's relationship/provenance record without exposing it.
 */
export interface EvaluationTask {
    readonly id: string;
    readonly layer: EvaluationLayer;
    readonly category: string;
    readonly comparisonTrack: ComparisonTrack;
    readonly language: string;
    readonly repositoryId: string;
    readonly independenceGroupId: string;
    readonly independenceEvidenceSha256: string;
    /** Digest of the exact prompt/specification and every immutable task input. */
    readonly inputBundleSha256: string;
    readonly sourceSha256: string;
    readonly graderSha256: string;
    readonly maxDurationMs: number;
    /** Must be zero for every never-run holdout at freeze time. */
    readonly priorRunCount: number;
}
export interface MaintainabilityReviewPolicy {
    readonly rubricId: string;
    readonly rubricSha256: string;
    readonly requiredPrimaryReviewers: 2;
    readonly disagreementThreshold: number;
}
export interface TrustedIsolationIssuer {
    readonly issuerId: string;
    readonly keyId: string;
    readonly publicKeyPem: string;
}
export interface CertificationIsolationPolicy {
    readonly verifierId: string;
    readonly policyId: string;
    readonly allowedMechanisms: readonly string[];
    readonly networkPolicySha256: string;
    readonly resourcePolicySha256: string;
    readonly trustedIssuers: readonly TrustedIsolationIssuer[];
}
export interface EvaluatorSigningKey {
    readonly evaluatorId: string;
    readonly keyId: string;
    readonly publicKeyPem: string;
}
export interface CertificateThresholds {
    readonly parityOverallLowerBound: number;
    readonly parityCategoryLowerBound: number;
    readonly superiorityOverallLowerBound: number;
    readonly maintainabilityLowerBound: number;
    readonly maxCostRatio: number;
    readonly maxInterventionDelta: number;
    readonly confidence: number;
}
export interface CertificationManifest {
    readonly schemaVersion: 3;
    readonly program: string;
    readonly frozenAt: string;
    readonly vanguardCommit: string;
    readonly evaluatorId: string;
    readonly externalEvaluator: boolean;
    readonly repetitions: number;
    readonly minPairedTasks: number;
    readonly minIndependentGroups: number;
    readonly minCategoryIndependentGroups: number;
    readonly bootstrapSamples: number;
    readonly seed: string;
    readonly engines: readonly EvaluationEngine[];
    readonly tasks: readonly EvaluationTask[];
    readonly reviewPolicy: MaintainabilityReviewPolicy;
    readonly isolationPolicy: CertificationIsolationPolicy;
    readonly evaluatorSigningKey: EvaluatorSigningKey;
    readonly thresholds: CertificateThresholds;
}
export interface PublicAssignment {
    readonly runId: string;
    readonly taskId: string;
    readonly repetition: number;
    readonly alias: string;
    readonly ordinal: number;
    readonly assignmentBindingSha256: string;
}
export interface PrivateAssignment extends PublicAssignment {
    readonly engineId: string;
    readonly privateBindingSha256: string;
}
export interface PublicAssignmentArtifact {
    readonly schemaVersion: 1;
    readonly audience: "public-runners-and-reviewers";
    readonly manifestSha256: string;
    readonly assignments: readonly PublicAssignment[];
}
export interface PrivateAssignmentArtifact {
    readonly schemaVersion: 1;
    readonly audience: "external-evaluator-only";
    readonly evaluatorId: string;
    readonly manifestSha256: string;
    /** Evaluator-only HMAC key; never copy this field into runner/reviewer artifacts. */
    readonly privateBindingSalt: string;
    readonly assignments: readonly PrivateAssignment[];
}
/** Exists only inside the external evaluator boundary. Never serialize it. */
export interface EvaluatorAssignmentBundle {
    readonly publicArtifact: PublicAssignmentArtifact;
    readonly privateArtifact: PrivateAssignmentArtifact;
}
declare const AUTHORITY: unique symbol;
export interface ExternalEvaluatorAuthority {
    readonly evaluatorId: string;
    readonly manifestSha256: string;
    readonly [AUTHORITY]: true;
}
export interface MaintainabilityReview {
    readonly runId: string;
    readonly reviewerId: string;
    readonly score: number;
    readonly rubricSha256: string;
    readonly evidenceSha256: string;
    readonly conflictDisclosureSha256: string;
    readonly submittedAt: string;
    readonly blinded: true;
    readonly independent: true;
}
export interface MaintainabilityAdjudication {
    readonly runId: string;
    readonly adjudicatorId: string;
    readonly score: number;
    readonly evidenceSha256: string;
    readonly rationale: string;
    readonly submittedAt: string;
    readonly blinded: true;
    readonly independent: true;
}
export interface MaintainabilityAssessment {
    readonly primaryReviews: readonly MaintainabilityReview[];
    readonly adjudication: MaintainabilityAdjudication | null;
}
export interface NormalizedUsageEvidence {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cachedInputTokens: number | null;
    readonly providerReported: boolean;
    readonly evidenceSha256: string;
}
export interface BlindRunResult {
    readonly runId: string;
    readonly taskId: string;
    readonly repetition: number;
    readonly alias: string;
    readonly assignmentBindingSha256: string;
    readonly executionEvidenceSha256: string;
    readonly executionMode: "externally-isolated";
    readonly success: boolean;
    readonly maintainability: MaintainabilityAssessment;
    readonly interventions: number;
    readonly usage: NormalizedUsageEvidence;
    readonly costUsd: number | null;
    readonly durationMs: number;
    readonly criticalIncident: boolean;
    readonly evaluatorId: string;
    readonly evaluatorAttestation: EvaluatorEvidenceAttestation;
}
export interface EvaluatorEvidenceAttestation {
    readonly protocolVersion: 1;
    readonly kind: "execution-outcome" | "reviewed-result";
    readonly evaluatorId: string;
    readonly keyId: string;
    readonly manifestSha256: string;
    readonly issuedAt: string;
    readonly statementSha256: string;
    readonly signatureBase64: string;
}
export interface CertificationLedgerEntry {
    readonly index: number;
    readonly previousHash: string;
    readonly hash: string;
    readonly result: BlindRunResult;
}
/** Sanitized projection of a completed evaluator execution-ledger entry. */
export interface CertificationExecutionProof {
    readonly runId: string;
    readonly assignmentBindingSha256: string;
    readonly executionEvidenceSha256: string;
    readonly executionMode: "externally-isolated";
    readonly success: boolean;
    readonly interventions: number;
    readonly usage: NormalizedUsageEvidence;
    readonly costUsd: number | null;
    readonly durationMs: number;
    readonly criticalIncident: boolean;
    readonly isolationVerificationEvidenceSha256: string;
}
export interface ConfidenceInterval {
    readonly estimate: number;
    readonly lower: number;
    readonly upper: number;
    /** Number of independent groups, not repetitions, used by the bootstrap. */
    readonly samples: number;
    readonly pairedTasks: number;
    readonly pairedRuns: number;
}
export interface CompetitorComparison {
    readonly competitor: string;
    readonly pairedTasks: number;
    readonly pairedRepositories: number;
    readonly independentGroups: number;
    readonly successDifference: ConfidenceInterval;
    readonly maintainabilityDifference: ConfidenceInterval;
    readonly categorySuccess: Readonly<Record<string, ConfidenceInterval>>;
    readonly comparisonTracks: Readonly<Record<ComparisonTrack, ComparisonTrackComparison>>;
    readonly interventionDelta: number;
    readonly costRatio: number | null;
    readonly parity: boolean;
    readonly superiority: boolean;
    readonly reasons: readonly string[];
}
export interface CertificateReport {
    readonly manifestSha256: string;
    readonly outcome: "not-certifiable" | "none" | "overall-parity" | "parity-with-scoped-superiority" | "overall-superiority";
    readonly certifiable: boolean;
    readonly comparisons: readonly CompetitorComparison[];
    readonly blockers: readonly string[];
}
export declare function validateCertificationManifest(manifest: CertificationManifest): void;
export interface ComparisonTrackComparison {
    readonly independentGroups: number;
    readonly successDifference: ConfidenceInterval;
    readonly maintainabilityDifference: ConfidenceInterval;
    readonly categorySuccess: Readonly<Record<string, ConfidenceInterval>>;
    readonly interventionDelta: number;
    readonly costRatio: number | null;
    readonly parity: boolean;
    readonly reasons: readonly string[];
}
export declare function manifestSha256(manifest: CertificationManifest): string;
export declare function authorizeExternalEvaluator(manifest: CertificationManifest, evaluatorId: string): ExternalEvaluatorAuthority;
export declare function createBlindedAssignments(manifest: CertificationManifest, blindingSecret: string): EvaluatorAssignmentBundle;
export declare function validateAssignmentArtifacts(manifest: CertificationManifest, publicArtifact: PublicAssignmentArtifact, privateArtifact: PrivateAssignmentArtifact, authority: ExternalEvaluatorAuthority): void;
export declare function appendCertificationResult(manifest: CertificationManifest, ledger: readonly CertificationLedgerEntry[], result: BlindRunResult): readonly CertificationLedgerEntry[];
export declare function validateCertificationLedger(manifest: CertificationManifest, ledger: readonly CertificationLedgerEntry[]): void;
export declare function evaluateCertificate(manifest: CertificationManifest, publicArtifact: PublicAssignmentArtifact, privateArtifact: PrivateAssignmentArtifact, ledger: readonly CertificationLedgerEntry[], executionProofs: readonly CertificationExecutionProof[], authority: ExternalEvaluatorAuthority): CertificateReport;
export declare function estimateCertificationCost(manifest: Pick<CertificationManifest, "engines" | "tasks" | "repetitions">, assumptions: Readonly<Record<string, {
    readonly meanCostPerTaskUsd: number;
}>>): {
    readonly runs: number;
    readonly estimatedUsd: number;
    readonly missingEngines: readonly string[];
};
export declare function maintainabilityScore(manifest: CertificationManifest, result: BlindRunResult): number;
export declare function evaluationTrackKey(task: Pick<EvaluationTask, "comparisonTrack" | "category">): string;
export declare function canonicalCertificationJson(value: JsonValue): string;
export declare function blindRunResultStatement(result: BlindRunResult): JsonValue;
export declare function verifyEvaluatorEvidenceAttestation(manifest: CertificationManifest, attestation: EvaluatorEvidenceAttestation, statement: JsonValue, expectedKind: EvaluatorEvidenceAttestation["kind"]): void;
export declare function evaluatorEvidenceSigningEnvelope(attestation: Omit<EvaluatorEvidenceAttestation, "signatureBase64">): JsonValue;
export {};
