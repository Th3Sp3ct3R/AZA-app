import type { AresAdapterRoute, AresAdapterState } from "./aresTypes.js";
export declare const ARES_BETA_PROGRAM_VERSION: 1;
export declare const ARES_BETA_LEDGER_GENESIS = "VANGUARD_ARES_BETA_LEDGER_V1";
export type AresBetaWave = "A" | "B" | "C" | "D";
export type AresBetaAttemptSlot = "repair-1" | "repair-2" | "feature-1" | "feature-2" | "multi-file-refactor" | "dependency-build" | "long-horizon" | "ask-user" | "live-steer" | "interrupt-resume";
export type AresBetaControlKind = "non-opted-in" | "kill-switch";
export interface AresBetaEvaluatorTrustRoot {
    readonly evaluatorId: string;
    readonly keyId: string;
    readonly publicKeyPem: string;
}
export interface AresBetaAuthorityTrustRoot {
    readonly authorityId: string;
    readonly keyId: string;
    readonly publicKeyPem: string;
}
/** This policy is supplied by the verifier/host, never read from the plan. */
export interface AresBetaAuthorityPolicy {
    readonly version: typeof ARES_BETA_PROGRAM_VERSION;
    readonly policyId: string;
    readonly authority: AresBetaAuthorityTrustRoot;
    readonly evaluator: AresBetaEvaluatorTrustRoot;
}
export interface AresBetaAuthoritySignature {
    readonly authorityId: string;
    readonly keyId: string;
    readonly signatureBase64: string;
}
export interface AresBetaAttemptAssignment {
    readonly attemptId: string;
    readonly participantId: string;
    readonly slot: AresBetaAttemptSlot;
    readonly taskSpecSha256: string;
    readonly repositoryCommit: string;
    readonly verificationSpecSha256: string;
}
export interface AresBetaControlAssignment {
    readonly controlId: string;
    readonly kind: AresBetaControlKind;
    readonly controlSpecSha256: string;
}
export interface AresBetaWavePlan {
    readonly wave: AresBetaWave;
    readonly vanguardCommit: string;
    readonly vanguardPackageSha256: string;
    readonly aresHostCommit: string;
    readonly aresHostBuildSha256: string;
    readonly rolloutConfigSha256: string;
    readonly dependencyLockSha256: string;
    readonly verifierPolicySha256: string;
    readonly executionPolicySha256: string;
    readonly participantIds: readonly string[];
    readonly attempts: readonly AresBetaAttemptAssignment[];
    readonly controls: readonly AresBetaControlAssignment[];
}
export interface AresBetaPlan {
    readonly version: typeof ARES_BETA_PROGRAM_VERSION;
    readonly programId: string;
    readonly frozenAt: string;
    readonly adapterVersion: 1;
    readonly evaluator: AresBetaEvaluatorTrustRoot;
    readonly reviewerIds: readonly string[];
    readonly reviewerRosterSha256: string;
    readonly reviewRubricSha256: string;
    readonly participantConsentSpecSha256: string;
    readonly participantSurveySpecSha256: string;
    readonly waves: readonly AresBetaWavePlan[];
    readonly authorization: AresBetaAuthoritySignature;
}
export type AresBetaUnsignedPlan = Omit<AresBetaPlan, "authorization">;
export type AresBetaIncidentSeverity = "none" | "low" | "high" | "critical";
export type AresBetaPatchVerdict = "acceptable" | "better" | "unacceptable" | "not-reviewed";
export interface AresBetaAttemptEvidence {
    readonly kind: "attempt";
    readonly attemptId: string;
    readonly participantId: string;
    readonly wave: AresBetaWave;
    readonly vanguardCommit: string;
    readonly vanguardPackageSha256: string;
    readonly aresHostCommit: string;
    readonly aresHostBuildSha256: string;
    readonly rolloutConfigSha256: string;
    readonly dependencyLockSha256: string;
    readonly verifierPolicySha256: string;
    readonly executionPolicySha256: string;
    readonly taskSpecSha256: string;
    readonly repositoryCommit: string;
    readonly verificationSpecSha256: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly terminalState: AresAdapterState;
    readonly truthfulTerminal: boolean;
    readonly vanguardExposed: boolean;
    readonly routeHistory: readonly AresAdapterRoute[];
    readonly routeLedgerComplete: boolean;
    readonly eventLedgerComplete: boolean;
    readonly incidentLedgerComplete: boolean;
    readonly safetyLedgerComplete: boolean;
    readonly privacyLedgerComplete: boolean;
    readonly adapterSessionIdSha256: string;
    readonly vanguardSessionIdSha256: string;
    readonly engineRunIdSha256: string;
    readonly hostRunLedgerSha256: string;
    readonly eventLedgerSha256: string;
    readonly incidentLedgerSha256: string;
    readonly sealedVerifierResultSha256: string;
    readonly patchArtifactSha256: string;
    readonly workerAttestationSha256: string;
    readonly gapDetected: boolean;
    readonly gapReported: boolean;
    readonly cursorOrderComplete: boolean;
    readonly possibleMutation: boolean;
    readonly legacyReplayAfterPossibleMutation: boolean;
    readonly workerStopAcknowledged: boolean;
    readonly reviewerId: string;
    readonly reviewerIndependent: boolean;
    readonly reviewRubricSha256: string;
    readonly reviewReceiptSha256: string;
    readonly participantConsentSpecSha256: string;
    readonly participantConsentReceiptSha256: string;
    readonly patchVerdict: AresBetaPatchVerdict;
    readonly sealedVerificationPassed: boolean;
    readonly patchApplied: boolean;
    readonly requiredInteractionObserved: boolean;
    readonly longHorizonMinutes: number;
    readonly milestoneCount: number;
    readonly incidentSeverity: AresBetaIncidentSeverity;
    readonly privacyIncident: boolean;
    readonly telemetryPrivacyViolation: boolean;
    readonly originalRepositoryMutationOutsideApply: boolean;
    readonly orphanedWorker: boolean;
    readonly journalOrPatchIntegrityFailure: boolean;
}
export interface AresBetaControlEvidence {
    readonly kind: "control";
    readonly controlId: string;
    readonly wave: AresBetaWave;
    readonly controlKind: AresBetaControlKind;
    readonly controlSpecSha256: string;
    readonly waveFreezeSha256: string;
    readonly observedAt: string;
    readonly selectedRoute: AresAdapterRoute;
    readonly newVanguardSelectionBlocked: boolean;
    readonly activeSessionDisposition: "not-applicable" | "legacy" | "manual-recovery" | "unconfirmed";
    readonly activeVanguardSessionObserved: boolean;
    readonly workerStopAcknowledged: boolean;
    readonly orphanedWorker: boolean;
    readonly incidentSeverity: AresBetaIncidentSeverity;
    readonly privacyIncident: boolean;
    readonly telemetryPrivacyViolation: boolean;
    readonly originalRepositoryMutationOutsideApply: boolean;
    readonly journalOrPatchIntegrityFailure: boolean;
    readonly hostRunLedgerSha256: string;
    readonly incidentLedgerSha256: string;
    readonly incidentLedgerComplete: boolean;
}
export interface AresBetaParticipantRatingEvidence {
    readonly kind: "participant-rating";
    readonly participantId: string;
    readonly wave: AresBetaWave;
    readonly recordedAt: string;
    readonly trustSafetyRating: 1 | 2 | 3 | 4 | 5;
    readonly participantSurveySpecSha256: string;
    readonly surveyReceiptSha256: string;
}
export interface AresBetaWaveReleaseEvidence {
    readonly kind: "wave-release";
    readonly wave: AresBetaWave;
    readonly lastAttemptEndedAt: string;
    readonly releasedAt: string;
    readonly everyFailureReviewed: boolean;
    readonly incidentReviewComplete: boolean;
    readonly ledgerPrefixHash: string;
    readonly timestampAttestation: AresBetaAuthoritySignature;
}
export interface AresBetaWaveInvalidatedEvidence {
    readonly kind: "wave-invalidated";
    readonly wave: AresBetaWave;
    readonly invalidatedAt: string;
    readonly reason: "engine-changed" | "config-changed" | "verifier-changed" | "eligibility-changed" | "incident" | "integrity";
}
export type AresBetaEvidence = AresBetaAttemptEvidence | AresBetaControlEvidence | AresBetaParticipantRatingEvidence | AresBetaWaveReleaseEvidence | AresBetaWaveInvalidatedEvidence;
export interface AresBetaEvidenceSignature {
    readonly evaluatorId: string;
    readonly keyId: string;
    readonly signatureBase64: string;
}
export interface AresBetaLedgerEntry {
    readonly version: typeof ARES_BETA_PROGRAM_VERSION;
    readonly sequence: number;
    readonly previousHash: string;
    readonly hash: string;
    readonly evidence: AresBetaEvidence;
    readonly signature: AresBetaEvidenceSignature;
}
export interface AresBetaGateResult {
    readonly id: string;
    readonly passed: boolean;
    readonly value: number | string;
    readonly requirement: string;
}
export interface AresBetaEvaluationReport {
    readonly version: typeof ARES_BETA_PROGRAM_VERSION;
    readonly planSha256: string;
    readonly candidateEpochSha256: string;
    readonly authorityPolicySha256: string;
    readonly evaluatedAt: string;
    readonly status: "invalid" | "incomplete" | "stop" | "failed" | "attestation_required" | "passed";
    readonly complete: boolean;
    readonly passed: boolean;
    readonly stopEnrollment: boolean;
    readonly expectedAttempts: number;
    readonly recordedAttempts: number;
    readonly missingAttempts: number;
    readonly duplicateAttempts: number;
    readonly ledgerEntryCount: number;
    readonly ledgerHeadHash: string;
    readonly invalidatedWaves: readonly AresBetaWave[];
    readonly blockers: readonly string[];
    readonly gates: readonly AresBetaGateResult[];
    readonly evaluationSha256: string;
    readonly certificationStatement: string;
    readonly authorityAttestation?: AresBetaAuthoritySignature;
}
/** Out-of-band binding supplied by the deployment gate when the full plan is unavailable. */
export interface AresBetaCertificationTarget {
    readonly planSha256: string;
    readonly candidateEpochSha256: string;
}
/** Validates the frozen denominator and all public-key/assignment invariants. */
export declare function validateAresBetaPlan(plan: AresBetaPlan): void;
/** Canonical statement authorized by a trust root supplied outside the plan. */
export declare function aresBetaPlanAuthorizationStatement(plan: AresBetaUnsignedPlan): string;
export declare function validateAresBetaAuthorityPolicy(policy: AresBetaAuthorityPolicy): void;
/** Stable semantic digest of the out-of-band trust policy and its key roots. */
export declare function aresBetaAuthorityPolicyDigest(policy: AresBetaAuthorityPolicy): string;
export declare function aresBetaCandidateEpochDigest(wavePlan: AresBetaWavePlan): string;
export declare function aresBetaPlanDigest(plan: AresBetaPlan): string;
/** Digest of the executable artifacts/policies frozen for one wave. */
export declare function aresBetaWaveFreezeDigest(wavePlan: AresBetaWavePlan): string;
export declare function aresBetaWaveReleaseTimestampStatement(planSha256: string, evidence: Omit<AresBetaWaveReleaseEvidence, "timestampAttestation">): string;
/** Canonical, domain-separated statement signed by the independent beta evaluator. */
export declare function aresBetaEvidenceStatement(planSha256: string, sequence: number, previousHash: string, evidence: AresBetaEvidence): string;
/** Creates the next envelope. The signer owns the private key; Vanguard never does. */
export declare function createAresBetaLedgerEntry(plan: AresBetaPlan, ledger: readonly AresBetaLedgerEntry[], evidence: AresBetaEvidence, signer: (statement: string) => string): AresBetaLedgerEntry;
/** Verifies every chain link, exact schema, frozen-plan binding, and evaluator signature. */
export declare function verifyAresBetaLedger(plan: AresBetaPlan, ledger: readonly AresBetaLedgerEntry[]): void;
/**
 * Evaluates only externally supplied, signed evidence. Missing rows remain in
 * the frozen denominator and no incomplete/invalidated program can pass.
 */
export declare function evaluateAresBetaProgram(plan: AresBetaPlan, ledger: readonly AresBetaLedgerEntry[], evaluatedAt: string, authorityPolicy: AresBetaAuthorityPolicy, authorityAttestation?: AresBetaAuthoritySignature): AresBetaEvaluationReport;
/** Verifies a detached report after storage or transport. */
export declare function verifyAresBetaEvaluationReport(report: AresBetaEvaluationReport, authorityPolicy: AresBetaAuthorityPolicy, expected: AresBetaPlan | AresBetaCertificationTarget): void;
