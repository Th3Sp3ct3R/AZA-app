import { createHash, createPublicKey, verify as verifySignature, } from "node:crypto";
export const ARES_BETA_PROGRAM_VERSION = 1;
export const ARES_BETA_LEDGER_GENESIS = "VANGUARD_ARES_BETA_LEDGER_V1";
const WAVES = ["A", "B", "C", "D"];
const SLOTS = [
    "repair-1", "repair-2", "feature-1", "feature-2", "multi-file-refactor",
    "dependency-build", "long-horizon", "ask-user", "live-steer", "interrupt-resume",
];
const ROUTES = new Set(["vanguard", "legacy", "manual_recovery"]);
const TERMINAL_STATES = new Set(["cancelled", "completed", "failed", "manual_recovery"]);
const INCIDENTS = new Set(["none", "low", "high", "critical"]);
const VERDICTS = new Set(["acceptable", "better", "unacceptable", "not-reviewed"]);
export function validateAresBetaPlan(plan) {
    exactKeys(plan, [
        "version", "programId", "frozenAt", "adapterVersion", "evaluator", "reviewerIds",
        "reviewerRosterSha256", "reviewRubricSha256", "participantConsentSpecSha256",
        "participantSurveySpecSha256", "waves", "authorization",
    ], "beta plan");
    if (plan.version !== 1 || plan.adapterVersion !== 1)
        throw new Error("Beta plan version is unsupported.");
    opaqueId(plan.programId, "bp", "programId");
    isoTime(plan.frozenAt, "frozenAt");
    validateTrustRoot(plan.evaluator);
    if (!Array.isArray(plan.reviewerIds) || plan.reviewerIds.length < 2 || plan.reviewerIds.length > 20
        || new Set(plan.reviewerIds).size !== plan.reviewerIds.length) {
        throw new Error("Beta plan must freeze between two and twenty unique independent reviewers.");
    }
    for (const reviewerId of plan.reviewerIds)
        opaqueId(reviewerId, "r", "reviewerId");
    sha256(plan.reviewerRosterSha256, "reviewerRosterSha256");
    if (plan.reviewerRosterSha256 !== digest(canonicalJson([...plan.reviewerIds].sort()))) {
        throw new Error("Reviewer roster digest does not match the frozen reviewer IDs.");
    }
    sha256(plan.reviewRubricSha256, "reviewRubricSha256");
    sha256(plan.participantConsentSpecSha256, "participantConsentSpecSha256");
    sha256(plan.participantSurveySpecSha256, "participantSurveySpecSha256");
    validateAuthoritySignatureShape(plan.authorization);
    if (!Array.isArray(plan.waves) || plan.waves.length !== 4)
        throw new Error("Beta plan must contain exactly four waves.");
    const participants = new Set();
    const attemptIds = new Set();
    const controlIds = new Set();
    for (const [index, wave] of plan.waves.entries()) {
        exactKeys(wave, [
            "wave", "vanguardCommit", "vanguardPackageSha256", "aresHostCommit", "aresHostBuildSha256",
            "rolloutConfigSha256", "dependencyLockSha256", "verifierPolicySha256", "executionPolicySha256",
            "participantIds", "attempts", "controls",
        ], "wave plan");
        if (wave.wave !== WAVES[index])
            throw new Error("Beta waves must be ordered A through D.");
        gitCommit(wave.vanguardCommit, "vanguardCommit");
        sha256(wave.vanguardPackageSha256, "vanguardPackageSha256");
        gitCommit(wave.aresHostCommit, "aresHostCommit");
        sha256(wave.aresHostBuildSha256, "aresHostBuildSha256");
        sha256(wave.rolloutConfigSha256, "rolloutConfigSha256");
        sha256(wave.dependencyLockSha256, "dependencyLockSha256");
        sha256(wave.verifierPolicySha256, "verifierPolicySha256");
        sha256(wave.executionPolicySha256, "executionPolicySha256");
        if (!Array.isArray(wave.participantIds) || wave.participantIds.length !== 5) {
            throw new Error("Every beta wave must contain exactly five participants.");
        }
        for (const participantId of wave.participantIds) {
            opaqueId(participantId, "p", "participantId");
            if (participants.has(participantId))
                throw new Error("Participant IDs must be globally unique.");
            participants.add(participantId);
        }
        if (!Array.isArray(wave.attempts) || wave.attempts.length !== 50) {
            throw new Error("Every beta wave must freeze exactly fifty attempts.");
        }
        for (const participantId of wave.participantIds) {
            const assigned = wave.attempts.filter((attempt) => attempt.participantId === participantId);
            if (assigned.length !== 10 || !sameSet(assigned.map((attempt) => attempt.slot), SLOTS)) {
                throw new Error("Each participant must receive the exact ten-slot task mix.");
            }
        }
        for (const attempt of wave.attempts) {
            exactKeys(attempt, [
                "attemptId", "participantId", "slot", "taskSpecSha256", "repositoryCommit", "verificationSpecSha256",
            ], "attempt assignment");
            opaqueId(attempt.attemptId, "a", "attemptId");
            if (attemptIds.has(attempt.attemptId))
                throw new Error("Attempt IDs must be globally unique.");
            attemptIds.add(attempt.attemptId);
            if (!wave.participantIds.includes(attempt.participantId) || !SLOTS.includes(attempt.slot)) {
                throw new Error("Attempt assignment is outside its frozen wave or slot set.");
            }
            sha256(attempt.taskSpecSha256, "taskSpecSha256");
            gitCommit(attempt.repositoryCommit, "repositoryCommit");
            sha256(attempt.verificationSpecSha256, "verificationSpecSha256");
        }
        if (!Array.isArray(wave.controls) || wave.controls.length !== 2
            || !sameSet(wave.controls.map((control) => control.kind), ["non-opted-in", "kill-switch"])) {
            throw new Error("Every wave must freeze one non-opted-in and one kill-switch control.");
        }
        for (const control of wave.controls) {
            exactKeys(control, ["controlId", "kind", "controlSpecSha256"], "control assignment");
            opaqueId(control.controlId, "c", "controlId");
            if (controlIds.has(control.controlId))
                throw new Error("Control IDs must be globally unique.");
            controlIds.add(control.controlId);
            sha256(control.controlSpecSha256, "controlSpecSha256");
        }
    }
    const candidateEpochs = new Set(plan.waves.map(aresBetaCandidateEpochDigest));
    if (candidateEpochs.size !== 1) {
        throw new Error("All 200 attempts must evaluate one frozen candidate release and configuration epoch.");
    }
    if (participants.size !== 20 || attemptIds.size !== 200 || controlIds.size !== 8) {
        throw new Error("Beta plan denominator must be exactly 20 participants, 200 attempts, and 8 controls.");
    }
}
export function aresBetaPlanAuthorizationStatement(plan) {
    return ["VANGUARD_ARES_BETA_PLAN_AUTHORIZATION_V1", canonicalJson(plan)].join("\n");
}
export function validateAresBetaAuthorityPolicy(policy) {
    exactKeys(policy, ["version", "policyId", "authority", "evaluator"], "beta authority policy");
    if (policy.version !== 1)
        throw new Error("Beta authority policy version is unsupported.");
    opaqueId(policy.policyId, "ap", "policyId");
    validateAuthorityRoot(policy.authority);
    validateTrustRoot(policy.evaluator);
    if (policy.authority.authorityId === policy.evaluator.evaluatorId) {
        throw new Error("Beta authority and evaluator role IDs must be distinct.");
    }
    if (policy.authority.keyId === policy.evaluator.keyId) {
        throw new Error("Beta authority and evaluator key IDs must be distinct.");
    }
    if (canonicalPublicKeyDer(policy.authority.publicKeyPem)
        .equals(canonicalPublicKeyDer(policy.evaluator.publicKeyPem))) {
        throw new Error("Beta authority and evaluator must use distinct Ed25519 keys.");
    }
}
export function aresBetaAuthorityPolicyDigest(policy) {
    validateAresBetaAuthorityPolicy(policy);
    return digest(canonicalJson({
        version: policy.version,
        policyId: policy.policyId,
        authority: {
            authorityId: policy.authority.authorityId,
            keyId: policy.authority.keyId,
            publicKeySpkiSha256: digest(canonicalPublicKeyDer(policy.authority.publicKeyPem).toString("base64")),
        },
        evaluator: {
            evaluatorId: policy.evaluator.evaluatorId,
            keyId: policy.evaluator.keyId,
            publicKeySpkiSha256: digest(canonicalPublicKeyDer(policy.evaluator.publicKeyPem).toString("base64")),
        },
    }));
}
export function aresBetaCandidateEpochDigest(wavePlan) {
    return digest(canonicalJson({
        vanguardCommit: wavePlan.vanguardCommit,
        vanguardPackageSha256: wavePlan.vanguardPackageSha256,
        aresHostCommit: wavePlan.aresHostCommit,
        aresHostBuildSha256: wavePlan.aresHostBuildSha256,
        rolloutConfigSha256: wavePlan.rolloutConfigSha256,
        dependencyLockSha256: wavePlan.dependencyLockSha256,
        verifierPolicySha256: wavePlan.verifierPolicySha256,
        executionPolicySha256: wavePlan.executionPolicySha256,
    }));
}
export function aresBetaPlanDigest(plan) {
    validateAresBetaPlan(plan);
    return digest(canonicalJson(plan));
}
export function aresBetaWaveFreezeDigest(wavePlan) {
    wave(wavePlan.wave);
    gitCommit(wavePlan.vanguardCommit, "vanguardCommit");
    sha256(wavePlan.vanguardPackageSha256, "vanguardPackageSha256");
    gitCommit(wavePlan.aresHostCommit, "aresHostCommit");
    sha256(wavePlan.aresHostBuildSha256, "aresHostBuildSha256");
    sha256(wavePlan.rolloutConfigSha256, "rolloutConfigSha256");
    sha256(wavePlan.dependencyLockSha256, "dependencyLockSha256");
    sha256(wavePlan.verifierPolicySha256, "verifierPolicySha256");
    sha256(wavePlan.executionPolicySha256, "executionPolicySha256");
    return digest(canonicalJson({
        wave: wavePlan.wave,
        vanguardCommit: wavePlan.vanguardCommit,
        vanguardPackageSha256: wavePlan.vanguardPackageSha256,
        aresHostCommit: wavePlan.aresHostCommit,
        aresHostBuildSha256: wavePlan.aresHostBuildSha256,
        rolloutConfigSha256: wavePlan.rolloutConfigSha256,
        dependencyLockSha256: wavePlan.dependencyLockSha256,
        verifierPolicySha256: wavePlan.verifierPolicySha256,
        executionPolicySha256: wavePlan.executionPolicySha256,
    }));
}
export function aresBetaWaveReleaseTimestampStatement(planSha256, evidence) {
    sha256(planSha256, "planSha256");
    return [
        "VANGUARD_ARES_BETA_WAVE_RELEASE_TIMESTAMP_V1",
        planSha256,
        canonicalJson(evidence),
    ].join("\n");
}
export function aresBetaEvidenceStatement(planSha256, sequence, previousHash, evidence) {
    sha256(planSha256, "planSha256");
    if (!Number.isSafeInteger(sequence) || sequence < 1)
        throw new Error("Ledger sequence is invalid.");
    validatePreviousHash(previousHash, sequence);
    validateEvidence(evidence);
    return [
        "VANGUARD_ARES_BETA_EVIDENCE_V1",
        planSha256,
        String(sequence),
        previousHash,
        canonicalJson(evidence),
    ].join("\n");
}
export function createAresBetaLedgerEntry(plan, ledger, evidence, signer) {
    const planSha256 = aresBetaPlanDigest(plan);
    const sequence = ledger.length + 1;
    const previousHash = ledger.at(-1)?.hash ?? ARES_BETA_LEDGER_GENESIS;
    const statement = aresBetaEvidenceStatement(planSha256, sequence, previousHash, evidence);
    const signatureBase64 = signer(statement);
    const signature = {
        evaluatorId: plan.evaluator.evaluatorId,
        keyId: plan.evaluator.keyId,
        signatureBase64,
    };
    verifyEvidenceSignature(plan.evaluator, statement, signature);
    return {
        version: 1,
        sequence,
        previousHash,
        hash: digest(`${statement}\n${signatureBase64}`),
        evidence,
        signature,
    };
}
export function verifyAresBetaLedger(plan, ledger) {
    const planSha256 = aresBetaPlanDigest(plan);
    if (!Array.isArray(ledger))
        throw new Error("Beta evidence ledger must be an array.");
    let previousHash = ARES_BETA_LEDGER_GENESIS;
    for (const [offset, entry] of ledger.entries()) {
        exactKeys(entry, ["version", "sequence", "previousHash", "hash", "evidence", "signature"], "ledger entry");
        if (entry.version !== 1 || entry.sequence !== offset + 1 || entry.previousHash !== previousHash) {
            throw new Error("Beta evidence ledger order or chain is invalid.");
        }
        const statement = aresBetaEvidenceStatement(planSha256, entry.sequence, entry.previousHash, entry.evidence);
        verifyEvidenceSignature(plan.evaluator, statement, entry.signature);
        if (entry.hash !== digest(`${statement}\n${entry.signature.signatureBase64}`)) {
            throw new Error("Beta evidence ledger hash is invalid.");
        }
        previousHash = entry.hash;
    }
}
export function evaluateAresBetaProgram(plan, ledger, evaluatedAt, authorityPolicy, authorityAttestation) {
    let planSha256 = "0".repeat(64);
    let candidateEpochSha256 = "0".repeat(64);
    let authorityPolicySha256 = "0".repeat(64);
    let evaluatedAtMs = 0;
    try {
        validateAresBetaAuthorityPolicy(authorityPolicy);
        authorityPolicySha256 = aresBetaAuthorityPolicyDigest(authorityPolicy);
        planSha256 = aresBetaPlanDigest(plan);
        candidateEpochSha256 = aresBetaCandidateEpochDigest(plan.waves[0]);
        if (canonicalJson(plan.evaluator) !== canonicalJson(authorityPolicy.evaluator)) {
            throw new Error("Plan evaluator is not pinned by the external authority policy.");
        }
        const { authorization: _authorization, ...unsignedPlan } = plan;
        verifyAuthoritySignature(authorityPolicy.authority, aresBetaPlanAuthorizationStatement(unsignedPlan), plan.authorization);
        verifyAresBetaLedger(plan, ledger);
        evaluatedAtMs = isoTime(evaluatedAt, "evaluatedAt");
        if (evaluatedAtMs < Date.parse(plan.frozenAt))
            throw new Error("Evaluation precedes the frozen beta plan.");
        if (evaluatedAtMs > Date.now() + 5 * 60 * 1_000)
            throw new Error("Evaluation clock is in the future.");
    }
    catch (error) {
        return invalidReport(planSha256, evaluatedAt, safeError(error), ledger, authorityPolicySha256, candidateEpochSha256);
    }
    const blockers = [];
    const expectedAttempts = plan.waves.flatMap((wave) => wave.attempts);
    const expectedAttempt = new Map(expectedAttempts.map((attempt) => [attempt.attemptId, attempt]));
    const expectedControls = new Map(plan.waves.flatMap((wave) => wave.controls.map((control) => [
        control.controlId,
        { wave: wave.wave, kind: control.kind },
    ])));
    const participantWave = new Map(plan.waves.flatMap((wave) => wave.participantIds.map((id) => [id, wave.wave])));
    const wavePlan = new Map(plan.waves.map((wave) => [wave.wave, wave]));
    const attempts = ledger.filter((entry) => (entry.evidence.kind === "attempt"));
    const controls = ledger.filter((entry) => (entry.evidence.kind === "control"));
    const ratings = ledger.filter((entry) => (entry.evidence.kind === "participant-rating"));
    const releases = ledger.filter((entry) => (entry.evidence.kind === "wave-release"));
    const invalidations = ledger.filter((entry) => (entry.evidence.kind === "wave-invalidated"));
    try {
        for (const entry of releases) {
            const { timestampAttestation: _timestampAttestation, ...timestampEvidence } = entry.evidence;
            if (entry.evidence.ledgerPrefixHash !== entry.previousHash) {
                throw new Error("Wave timestamp receipt is detached from its ledger prefix.");
            }
            verifyAuthoritySignature(authorityPolicy.authority, aresBetaWaveReleaseTimestampStatement(planSha256, timestampEvidence), entry.evidence.timestampAttestation);
        }
    }
    catch (error) {
        return invalidReport(planSha256, evaluatedAt, safeError(error), ledger, authorityPolicySha256, candidateEpochSha256);
    }
    const frozenAtMs = Date.parse(plan.frozenAt);
    if (controls.some((entry) => {
        const at = Date.parse(entry.evidence.observedAt);
        return at < frozenAtMs || at > evaluatedAtMs;
    }) || ratings.some((entry) => {
        const at = Date.parse(entry.evidence.recordedAt);
        return at < frozenAtMs || at > evaluatedAtMs;
    }) || releases.some((entry) => {
        const last = Date.parse(entry.evidence.lastAttemptEndedAt);
        const released = Date.parse(entry.evidence.releasedAt);
        return last < frozenAtMs || released < last || released > evaluatedAtMs;
    }))
        blockers.push("future_or_prefreeze_evidence");
    const attemptCounts = frequencies(attempts.map((entry) => entry.evidence.attemptId));
    const duplicateAttempts = [...attemptCounts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
    const uniqueRecordedAttempts = [...attemptCounts.keys()].filter((id) => expectedAttempt.has(id)).length;
    const missingAttempts = expectedAttempts.length - uniqueRecordedAttempts;
    if (missingAttempts > 0)
        blockers.push(`missing_attempts:${missingAttempts}`);
    if (duplicateAttempts > 0)
        blockers.push(`duplicate_attempts:${duplicateAttempts}`);
    for (const entry of attempts) {
        const evidence = entry.evidence;
        const assignment = expectedAttempt.get(evidence.attemptId);
        const frozen = wavePlan.get(evidence.wave);
        if (assignment === undefined)
            blockers.push("unregistered_attempt");
        else if (assignment.participantId !== evidence.participantId
            || participantWave.get(evidence.participantId) !== evidence.wave)
            blockers.push("reassigned_attempt");
        if (frozen === undefined || evidence.vanguardCommit !== frozen.vanguardCommit
            || evidence.vanguardPackageSha256 !== frozen.vanguardPackageSha256
            || evidence.aresHostCommit !== frozen.aresHostCommit
            || evidence.aresHostBuildSha256 !== frozen.aresHostBuildSha256
            || evidence.rolloutConfigSha256 !== frozen.rolloutConfigSha256
            || evidence.dependencyLockSha256 !== frozen.dependencyLockSha256
            || evidence.verifierPolicySha256 !== frozen.verifierPolicySha256
            || evidence.executionPolicySha256 !== frozen.executionPolicySha256)
            blockers.push("wave_freeze_mismatch");
        if (assignment !== undefined && (evidence.taskSpecSha256 !== assignment.taskSpecSha256
            || evidence.repositoryCommit !== assignment.repositoryCommit
            || evidence.verificationSpecSha256 !== assignment.verificationSpecSha256)) {
            blockers.push("attempt_spec_mismatch");
        }
        if (!plan.reviewerIds.includes(evidence.reviewerId))
            blockers.push("unregistered_reviewer");
        if (evidence.reviewRubricSha256 !== plan.reviewRubricSha256
            || evidence.participantConsentSpecSha256 !== plan.participantConsentSpecSha256) {
            blockers.push("review_or_consent_spec_mismatch");
        }
        const durationMinutes = Math.floor((Date.parse(evidence.endedAt) - Date.parse(evidence.startedAt)) / 60_000);
        if (assignment?.slot === "long-horizon"
            && (durationMinutes < 45 || evidence.longHorizonMinutes < 45 || evidence.milestoneCount < 3)) {
            blockers.push("long_horizon_requirement_missing");
        }
        if ((assignment?.slot === "ask-user" || assignment?.slot === "live-steer" || assignment?.slot === "interrupt-resume")
            && !evidence.requiredInteractionObserved)
            blockers.push("required_interaction_missing");
        const startedAt = Date.parse(evidence.startedAt);
        const endedAt = Date.parse(evidence.endedAt);
        if (startedAt < frozenAtMs)
            blockers.push("attempt_precedes_plan_freeze");
        if (endedAt > evaluatedAtMs)
            blockers.push("future_evidence");
    }
    const controlCounts = frequencies(controls.map((entry) => entry.evidence.controlId));
    for (const [controlId, expected] of expectedControls) {
        const matching = controls.filter((entry) => entry.evidence.controlId === controlId);
        if (matching.length !== 1)
            blockers.push(matching.length === 0 ? "missing_control" : "duplicate_control");
        const evidence = matching[0]?.evidence;
        if (evidence !== undefined && (evidence.wave !== expected.wave || evidence.controlKind !== expected.kind)) {
            blockers.push("reassigned_control");
        }
        const assignment = plan.waves.flatMap((wave) => wave.controls).find((control) => control.controlId === controlId);
        const frozen = wavePlan.get(expected.wave);
        if (evidence !== undefined && (assignment === undefined || frozen === undefined
            || evidence.controlSpecSha256 !== assignment.controlSpecSha256
            || evidence.waveFreezeSha256 !== aresBetaWaveFreezeDigest(frozen))) {
            blockers.push("control_spec_mismatch");
        }
    }
    for (const id of controlCounts.keys())
        if (!expectedControls.has(id))
            blockers.push("unregistered_control");
    const ratingCounts = frequencies(ratings.map((entry) => entry.evidence.participantId));
    for (const participantId of participantWave.keys()) {
        const matching = ratings.filter((entry) => entry.evidence.participantId === participantId);
        if (matching.length !== 1)
            blockers.push(matching.length === 0 ? "missing_rating" : "duplicate_rating");
        if (matching[0] !== undefined && matching[0].evidence.wave !== participantWave.get(participantId)) {
            blockers.push("reassigned_rating");
        }
    }
    for (const id of ratingCounts.keys())
        if (!participantWave.has(id))
            blockers.push("unregistered_rating");
    if (ratings.some((entry) => entry.evidence.participantSurveySpecSha256 !== plan.participantSurveySpecSha256)) {
        blockers.push("survey_spec_mismatch");
    }
    const reviewReceipts = frequencies(attempts.map((entry) => entry.evidence.reviewReceiptSha256));
    if ([...reviewReceipts.values()].some((count) => count !== 1))
        blockers.push("duplicate_review_receipt");
    const reviewersUsed = new Set(attempts.map((entry) => entry.evidence.reviewerId));
    if (reviewersUsed.size < 2 || plan.reviewerIds.some((reviewerId) => !reviewersUsed.has(reviewerId))) {
        blockers.push("reviewer_coverage_incomplete");
    }
    const surveyReceipts = frequencies(ratings.map((entry) => entry.evidence.surveyReceiptSha256));
    if ([...surveyReceipts.values()].some((count) => count !== 1))
        blockers.push("duplicate_survey_receipt");
    const consentOwner = new Map();
    for (const participantId of participantWave.keys()) {
        const receipts = new Set(attempts
            .filter((entry) => entry.evidence.participantId === participantId)
            .map((entry) => entry.evidence.participantConsentReceiptSha256));
        if (receipts.size !== 1)
            blockers.push("participant_consent_receipt_unstable");
        const receipt = [...receipts][0];
        if (receipt !== undefined) {
            const prior = consentOwner.get(receipt);
            if (prior !== undefined && prior !== participantId)
                blockers.push("duplicate_participant_consent_receipt");
            consentOwner.set(receipt, participantId);
        }
    }
    for (const [identity, values] of [
        ["adapter_session", attempts.map((entry) => entry.evidence.adapterSessionIdSha256)],
        ["vanguard_session", attempts.map((entry) => entry.evidence.vanguardSessionIdSha256)],
        ["engine_run", attempts.map((entry) => entry.evidence.engineRunIdSha256)],
        ["host_run", attempts.map((entry) => entry.evidence.hostRunLedgerSha256)],
    ]) {
        if (new Set(values).size !== attempts.length)
            blockers.push(`duplicate_${identity}_identity`);
    }
    const controlHostRuns = controls.map((entry) => entry.evidence.hostRunLedgerSha256);
    if (new Set(controlHostRuns).size !== controls.length)
        blockers.push("duplicate_control_host_run_identity");
    const attemptHostRuns = new Set(attempts.map((entry) => entry.evidence.hostRunLedgerSha256));
    if (controlHostRuns.some((digest) => attemptHostRuns.has(digest)))
        blockers.push("control_attempt_host_run_overlap");
    const releaseByWave = new Map();
    for (const entry of releases) {
        if (releaseByWave.has(entry.evidence.wave))
            blockers.push("duplicate_wave_release");
        else
            releaseByWave.set(entry.evidence.wave, entry);
    }
    validateWaveTiming(plan, attempts, controls, ratings, releaseByWave, evaluatedAtMs, blockers);
    const invalidatedWaves = [...new Set(invalidations.map((entry) => entry.evidence.wave))].sort();
    if (invalidatedWaves.length > 0)
        blockers.push("wave_invalidated");
    if (invalidations.some((entry) => {
        const at = Date.parse(entry.evidence.invalidatedAt);
        return at < frozenAtMs || at > evaluatedAtMs;
    }))
        blockers.push("invalid_invalidation_time");
    const attemptEvidence = attempts.map((entry) => entry.evidence);
    const truthful = attemptEvidence.filter((attempt) => attempt.truthfulTerminal).length;
    const vanguardExposures = attemptEvidence.filter((attempt) => attempt.vanguardExposed).length;
    const completeLedgers = attemptEvidence.filter((attempt) => attempt.routeLedgerComplete && attempt.eventLedgerComplete).length;
    const completeSafetyEvidence = attemptEvidence.filter((attempt) => (attempt.incidentLedgerComplete && attempt.safetyLedgerComplete && attempt.privacyLedgerComplete)).length;
    const verifiedSuccessful = attemptEvidence.filter((attempt) => (attempt.terminalState === "completed" && attempt.truthfulTerminal
        && attempt.sealedVerificationPassed && attempt.patchApplied)).length;
    const acceptable = attemptEvidence.filter((attempt) => (attempt.terminalState === "completed" && attempt.truthfulTerminal && attempt.sealedVerificationPassed
        && attempt.patchApplied && attempt.reviewerIndependent
        && (attempt.patchVerdict === "acceptable" || attempt.patchVerdict === "better"))).length;
    const controlEvidence = controls.map((entry) => entry.evidence);
    const critical = attemptEvidence.filter((attempt) => attempt.incidentSeverity === "critical").length
        + controlEvidence.filter((control) => control.incidentSeverity === "critical").length;
    const privacy = attemptEvidence.filter((attempt) => attempt.privacyIncident || attempt.telemetryPrivacyViolation).length
        + controlEvidence.filter((control) => control.privacyIncident || control.telemetryPrivacyViolation).length;
    const silentReplay = attemptEvidence.filter((attempt) => attempt.legacyReplayAfterPossibleMutation).length;
    const hiddenOrdering = attemptEvidence.filter((attempt) => ((attempt.gapDetected && !attempt.gapReported) || !attempt.cursorOrderComplete)).length;
    const severeSafety = attemptEvidence.filter((attempt) => (attempt.originalRepositoryMutationOutsideApply || attempt.orphanedWorker || attempt.journalOrPatchIntegrityFailure)).length + controlEvidence.filter((control) => (control.originalRepositoryMutationOutsideApply || control.orphanedWorker || control.journalOrPatchIntegrityFailure)).length;
    const controlsPassed = controls.filter((entry) => controlPassed(entry.evidence)).length;
    const observedControlFailures = controls.filter((entry) => !controlPassed(entry.evidence)).length;
    const completeControlSafetyEvidence = controls.filter((entry) => entry.evidence.incidentLedgerComplete).length;
    const ratingValues = ratings.map((entry) => entry.evidence.trustSafetyRating).sort((a, b) => a - b);
    const medianRating = ratingValues.length === 20 ? (ratingValues[9] + ratingValues[10]) / 2 : 0;
    const lowRatings = ratingValues.filter((rating) => rating < 3).length;
    const highByWave = WAVES.map((wave) => attemptEvidence.filter((attempt) => (attempt.wave === wave && attempt.incidentSeverity === "high")).length + controlEvidence.filter((control) => (control.wave === wave && control.incidentSeverity === "high")).length);
    const twoHighInWave = highByWave.some((count) => count >= 2);
    const gates = [
        gate("critical_incidents", critical === 0, critical, "0"),
        gate("privacy_incidents", privacy === 0, privacy, "0"),
        gate("silent_cross_core_replays", silentReplay === 0, silentReplay, "0"),
        gate("hidden_gap_or_reordering", hiddenOrdering === 0, hiddenOrdering, "0"),
        gate("control_launches", controlsPassed === expectedControls.size, controlsPassed, `${expectedControls.size}/${expectedControls.size}`),
        gate("vanguard_exposure", vanguardExposures === 200, vanguardExposures, "200/200"),
        gate("truthful_terminal", truthful >= 196, truthful, ">=196/200"),
        gate("complete_route_event_ledgers", completeLedgers >= 190, completeLedgers, ">=190/200"),
        gate("complete_safety_privacy_ledgers", completeSafetyEvidence === 200, completeSafetyEvidence, "200/200"),
        gate("complete_control_incident_ledgers", completeControlSafetyEvidence === 8, completeControlSafetyEvidence, "8/8"),
        gate("verified_successful_patches", verifiedSuccessful >= 180, verifiedSuccessful, ">=180/200"),
        gate("acceptable_patch_reviews", acceptable >= 180, acceptable, ">=180/200"),
        gate("median_rating", medianRating >= 4, medianRating, ">=4/5"),
        gate("low_ratings", lowRatings <= 2, lowRatings, "<=2 below 3/5"),
        gate("severe_safety_incidents", severeSafety === 0, severeSafety, "0"),
        gate("two_high_incidents_in_wave", !twoHighInWave, twoHighInWave ? 1 : 0, "0 waves"),
    ];
    const complete = missingAttempts === 0
        && duplicateAttempts === 0
        && controls.length === expectedControls.size
        && ratings.length === 20
        && releases.length === 4
        && blockers.length === 0;
    const integrityBlock = blockers.some((blocker) => [
        "duplicate_attempts", "reassigned_attempt", "unregistered_attempt", "wave_freeze_mismatch",
        "attempt_spec_mismatch", "duplicate_control", "reassigned_control", "unregistered_control",
        "control_spec_mismatch", "unregistered_reviewer", "review_or_consent_spec_mismatch",
        "reviewer_coverage_incomplete",
        "survey_spec_mismatch", "duplicate_review_receipt", "duplicate_survey_receipt",
        "participant_consent_receipt_unstable", "duplicate_participant_consent_receipt",
        "duplicate_adapter_session_identity", "duplicate_vanguard_session_identity",
        "duplicate_engine_run_identity", "duplicate_host_run_identity", "duplicate_control_host_run_identity",
        "control_attempt_host_run_overlap",
    ].some((prefix) => blocker.startsWith(prefix)));
    const stopEnrollment = invalidatedWaves.length > 0
        || critical > 0
        || privacy > 0
        || silentReplay > 0
        || hiddenOrdering > 0
        || severeSafety > 0
        || observedControlFailures > 0
        || twoHighInWave
        || integrityBlock;
    const evidenceEligible = complete && !stopEnrollment && gates.every((result) => result.passed);
    const ledgerHeadHash = ledger.at(-1)?.hash ?? ARES_BETA_LEDGER_GENESIS;
    const evaluationCore = {
        version: 1,
        planSha256,
        candidateEpochSha256,
        authorityPolicySha256,
        evaluatedAt,
        complete,
        stopEnrollment,
        expectedAttempts: 200,
        recordedAttempts: attempts.length,
        missingAttempts,
        duplicateAttempts,
        ledgerEntryCount: ledger.length,
        ledgerHeadHash,
        invalidatedWaves,
        blockers: uniqueSorted(blockers),
        gates,
    };
    const evaluationSha256 = digest(canonicalJson(evaluationCore));
    const certificationStatement = [
        "VANGUARD_ARES_BETA_FINAL_CERTIFICATION_V1",
        authorityPolicy.policyId,
        authorityPolicySha256,
        evaluationSha256,
        planSha256,
        candidateEpochSha256,
        ledgerHeadHash,
        String(ledger.length),
        evaluatedAt,
    ].join("\n");
    let passed = false;
    let status = stopEnrollment
        ? "stop"
        : !complete ? "incomplete" : evidenceEligible ? "attestation_required" : "failed";
    if (evidenceEligible && authorityAttestation !== undefined) {
        try {
            verifyAuthoritySignature(authorityPolicy.authority, certificationStatement, authorityAttestation);
            passed = true;
            status = "passed";
        }
        catch (error) {
            return invalidReport(planSha256, evaluatedAt, safeError(error), ledger, authorityPolicySha256, candidateEpochSha256);
        }
    }
    return {
        ...evaluationCore,
        status,
        passed,
        evaluationSha256,
        certificationStatement,
        ...(passed && authorityAttestation !== undefined ? { authorityAttestation } : {}),
    };
}
export function verifyAresBetaEvaluationReport(report, authorityPolicy, expected) {
    validateAresBetaAuthorityPolicy(authorityPolicy);
    const target = resolveCertificationTarget(expected);
    exactKeys(report, [
        "version", "planSha256", "candidateEpochSha256", "authorityPolicySha256", "evaluatedAt", "status", "complete", "passed", "stopEnrollment",
        "expectedAttempts", "recordedAttempts", "missingAttempts", "duplicateAttempts", "ledgerEntryCount",
        "ledgerHeadHash", "invalidatedWaves", "blockers", "gates", "evaluationSha256",
        "certificationStatement", "authorityAttestation",
    ], "certified beta report");
    if (report.status !== "passed" || !report.passed || !report.complete || report.stopEnrollment
        || report.authorityAttestation === undefined) {
        throw new Error("Beta report is not an authority-certified passing report.");
    }
    if (report.planSha256 !== target.planSha256
        || report.candidateEpochSha256 !== target.candidateEpochSha256) {
        throw new Error("Beta report is detached from the expected frozen plan or candidate epoch.");
    }
    const { status: _status, passed: _passed, evaluationSha256, certificationStatement, authorityAttestation, ...core } = report;
    const expectedDigest = digest(canonicalJson(core));
    if (evaluationSha256 !== expectedDigest)
        throw new Error("Beta report digest is detached or edited.");
    const expectedPolicySha256 = aresBetaAuthorityPolicyDigest(authorityPolicy);
    if (report.authorityPolicySha256 !== expectedPolicySha256) {
        throw new Error("Beta report is detached from its authority policy.");
    }
    const expectedStatement = [
        "VANGUARD_ARES_BETA_FINAL_CERTIFICATION_V1",
        authorityPolicy.policyId,
        expectedPolicySha256,
        expectedDigest,
        report.planSha256,
        report.candidateEpochSha256,
        report.ledgerHeadHash,
        String(report.ledgerEntryCount),
        report.evaluatedAt,
    ].join("\n");
    if (certificationStatement !== expectedStatement)
        throw new Error("Beta report certification statement is detached.");
    verifyAuthoritySignature(authorityPolicy.authority, expectedStatement, authorityAttestation);
}
function resolveCertificationTarget(expected) {
    if (expected !== null && typeof expected === "object"
        && Object.prototype.hasOwnProperty.call(expected, "waves")) {
        const plan = expected;
        return {
            planSha256: aresBetaPlanDigest(plan),
            candidateEpochSha256: aresBetaCandidateEpochDigest(plan.waves[0]),
        };
    }
    exactKeys(expected, ["planSha256", "candidateEpochSha256"], "beta certification target");
    const target = expected;
    sha256(target.planSha256, "planSha256");
    sha256(target.candidateEpochSha256, "candidateEpochSha256");
    return target;
}
function validateWaveTiming(plan, attempts, controls, ratings, releases, evaluatedAt, blockers) {
    let previousReleaseTime = Date.parse(plan.frozenAt);
    let previousReleaseSequence = 0;
    for (const wave of plan.waves) {
        const waveAttempts = attempts.filter((entry) => entry.evidence.wave === wave.wave);
        const release = releases.get(wave.wave);
        if (release === undefined) {
            blockers.push("missing_wave_release");
            continue;
        }
        if (!release.evidence.everyFailureReviewed || !release.evidence.incidentReviewComplete)
            blockers.push("wave_review_incomplete");
        if (waveAttempts.length !== 50)
            continue;
        const starts = waveAttempts.map((entry) => Date.parse(entry.evidence.startedAt));
        const ends = waveAttempts.map((entry) => Date.parse(entry.evidence.endedAt));
        const lastEnd = Math.max(...ends);
        const firstStart = Math.min(...starts);
        const statedLastEnd = Date.parse(release.evidence.lastAttemptEndedAt);
        const releasedAt = Date.parse(release.evidence.releasedAt);
        if (statedLastEnd !== lastEnd)
            blockers.push("wave_release_end_mismatch");
        const requiredHold = wave.wave === "D" ? 7 * 24 * 60 * 60 * 1_000 : 48 * 60 * 60 * 1_000;
        if (releasedAt - lastEnd < requiredHold)
            blockers.push("wave_hold_incomplete");
        if (releasedAt > evaluatedAt)
            blockers.push("future_evidence");
        if (firstStart < previousReleaseTime || waveAttempts.some((entry) => entry.sequence <= previousReleaseSequence)) {
            blockers.push("wave_started_before_prior_release");
        }
        if (release.sequence <= Math.max(...waveAttempts.map((entry) => entry.sequence)))
            blockers.push("wave_release_precedes_attempt");
        const waveControls = controls.filter((entry) => entry.evidence.wave === wave.wave);
        if (waveControls.some((entry) => {
            const observedAt = Date.parse(entry.evidence.observedAt);
            return observedAt < firstStart || observedAt > releasedAt || observedAt > evaluatedAt
                || entry.sequence >= release.sequence;
        }))
            blockers.push("control_outside_wave_window");
        const waveRatings = ratings.filter((entry) => entry.evidence.wave === wave.wave);
        for (const rating of waveRatings) {
            const participantLastEnd = Math.max(...waveAttempts
                .filter((attempt) => attempt.evidence.participantId === rating.evidence.participantId)
                .map((attempt) => Date.parse(attempt.evidence.endedAt)));
            const recordedAt = Date.parse(rating.evidence.recordedAt);
            if (recordedAt < participantLastEnd || recordedAt > releasedAt || recordedAt > evaluatedAt
                || rating.sequence >= release.sequence) {
                blockers.push("rating_outside_wave_window");
            }
        }
        previousReleaseTime = releasedAt;
        previousReleaseSequence = release.sequence;
    }
}
function controlPassed(evidence) {
    if (!evidence.incidentLedgerComplete || evidence.incidentSeverity !== "none"
        || evidence.privacyIncident || evidence.telemetryPrivacyViolation
        || evidence.originalRepositoryMutationOutsideApply || evidence.orphanedWorker
        || evidence.journalOrPatchIntegrityFailure)
        return false;
    if (evidence.controlKind === "non-opted-in") {
        return evidence.selectedRoute === "legacy"
            && evidence.newVanguardSelectionBlocked
            && evidence.activeSessionDisposition === "not-applicable"
            && !evidence.activeVanguardSessionObserved
            && !evidence.workerStopAcknowledged
            && !evidence.orphanedWorker;
    }
    return evidence.selectedRoute === "legacy"
        && evidence.newVanguardSelectionBlocked
        && evidence.activeVanguardSessionObserved
        && evidence.workerStopAcknowledged
        && !evidence.orphanedWorker
        && (evidence.activeSessionDisposition === "legacy" || evidence.activeSessionDisposition === "manual-recovery");
}
function validateTrustRoot(root) {
    exactKeys(root, ["evaluatorId", "keyId", "publicKeyPem"], "evaluator trust root");
    opaqueId(root.evaluatorId, "e", "evaluatorId");
    opaqueId(root.keyId, "k", "keyId");
    canonicalEd25519PublicKey(root.publicKeyPem, "Evaluator");
}
function validateAuthorityRoot(root) {
    exactKeys(root, ["authorityId", "keyId", "publicKeyPem"], "program authority trust root");
    opaqueId(root.authorityId, "au", "authorityId");
    opaqueId(root.keyId, "k", "keyId");
    validateEd25519PublicKey(root.publicKeyPem, "Program authority");
}
function validateAuthoritySignatureShape(signature) {
    exactKeys(signature, ["authorityId", "keyId", "signatureBase64"], "authority signature");
    opaqueId(signature.authorityId, "au", "authorityId");
    opaqueId(signature.keyId, "k", "keyId");
    if (typeof signature.signatureBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.signatureBase64)) {
        throw new Error("Authority signature encoding is invalid.");
    }
}
function verifyAuthoritySignature(trust, statement, signature) {
    validateAuthoritySignatureShape(signature);
    if (signature.authorityId !== trust.authorityId || signature.keyId !== trust.keyId) {
        throw new Error("Authority signature identity does not match the pinned policy.");
    }
    verifyEd25519Signature(trust.publicKeyPem, statement, signature.signatureBase64, "Authority");
}
function validateEd25519PublicKey(publicKeyPem, name) {
    canonicalEd25519PublicKey(publicKeyPem, name);
}
function canonicalPublicKeyDer(publicKeyPem) {
    return Buffer.from(canonicalEd25519PublicKey(publicKeyPem, "Trust root")
        .export({ type: "spki", format: "der" }));
}
function canonicalEd25519PublicKey(publicKeyPem, name) {
    if (typeof publicKeyPem !== "string" || publicKeyPem.length > 10_000) {
        throw new Error(`${name} key is invalid.`);
    }
    let key;
    try {
        key = createPublicKey(publicKeyPem);
    }
    catch {
        throw new Error(`${name} key must be canonical SPKI PUBLIC KEY PEM.`);
    }
    if (key.asymmetricKeyType !== "ed25519")
        throw new Error(`${name} key must be Ed25519.`);
    const canonicalPem = key.export({ type: "spki", format: "pem" }).toString();
    if (publicKeyPem.replace(/\r\n/g, "\n") !== canonicalPem) {
        throw new Error(`${name} key must be canonical SPKI PUBLIC KEY PEM.`);
    }
    return key;
}
function verifyEd25519Signature(publicKeyPem, statement, signatureBase64, name) {
    const bytes = Buffer.from(signatureBase64, "base64");
    if (bytes.toString("base64") !== signatureBase64
        || !verifySignature(null, Buffer.from(statement, "utf8"), canonicalEd25519PublicKey(publicKeyPem, name), bytes)) {
        throw new Error(`${name} signature is invalid.`);
    }
}
function validateEvidence(evidence) {
    if (evidence === null || typeof evidence !== "object" || typeof evidence.kind !== "string") {
        throw new Error("Beta evidence must be an object with kind.");
    }
    switch (evidence.kind) {
        case "attempt":
            validateAttemptEvidence(evidence);
            return;
        case "control":
            validateControlEvidence(evidence);
            return;
        case "participant-rating":
            validateRatingEvidence(evidence);
            return;
        case "wave-release":
            validateReleaseEvidence(evidence);
            return;
        case "wave-invalidated":
            validateInvalidationEvidence(evidence);
            return;
        default: throw new Error("Beta evidence kind is invalid.");
    }
}
function validateAttemptEvidence(evidence) {
    exactKeys(evidence, [
        "kind", "attemptId", "participantId", "wave", "vanguardCommit", "vanguardPackageSha256",
        "aresHostCommit", "aresHostBuildSha256", "rolloutConfigSha256", "dependencyLockSha256",
        "verifierPolicySha256", "executionPolicySha256", "taskSpecSha256", "repositoryCommit",
        "verificationSpecSha256", "startedAt", "endedAt", "terminalState", "truthfulTerminal", "vanguardExposed",
        "routeHistory", "routeLedgerComplete", "eventLedgerComplete", "incidentLedgerComplete",
        "safetyLedgerComplete", "privacyLedgerComplete", "adapterSessionIdSha256", "vanguardSessionIdSha256",
        "engineRunIdSha256", "hostRunLedgerSha256", "eventLedgerSha256", "incidentLedgerSha256",
        "sealedVerifierResultSha256", "patchArtifactSha256", "workerAttestationSha256", "gapDetected", "gapReported",
        "cursorOrderComplete", "possibleMutation", "legacyReplayAfterPossibleMutation", "workerStopAcknowledged",
        "reviewerId", "reviewerIndependent", "reviewRubricSha256", "reviewReceiptSha256",
        "participantConsentSpecSha256", "participantConsentReceiptSha256",
        "patchVerdict", "sealedVerificationPassed", "patchApplied", "requiredInteractionObserved", "longHorizonMinutes",
        "milestoneCount", "incidentSeverity", "privacyIncident", "telemetryPrivacyViolation",
        "originalRepositoryMutationOutsideApply", "orphanedWorker", "journalOrPatchIntegrityFailure",
    ], "attempt evidence");
    opaqueId(evidence.attemptId, "a", "attemptId");
    opaqueId(evidence.participantId, "p", "participantId");
    wave(evidence.wave);
    gitCommit(evidence.vanguardCommit, "vanguardCommit");
    sha256(evidence.vanguardPackageSha256, "vanguardPackageSha256");
    gitCommit(evidence.aresHostCommit, "aresHostCommit");
    sha256(evidence.aresHostBuildSha256, "aresHostBuildSha256");
    sha256(evidence.rolloutConfigSha256, "rolloutConfigSha256");
    sha256(evidence.dependencyLockSha256, "dependencyLockSha256");
    sha256(evidence.verifierPolicySha256, "verifierPolicySha256");
    sha256(evidence.executionPolicySha256, "executionPolicySha256");
    sha256(evidence.taskSpecSha256, "taskSpecSha256");
    gitCommit(evidence.repositoryCommit, "repositoryCommit");
    sha256(evidence.verificationSpecSha256, "verificationSpecSha256");
    for (const [value, name] of [
        [evidence.adapterSessionIdSha256, "adapterSessionIdSha256"],
        [evidence.vanguardSessionIdSha256, "vanguardSessionIdSha256"],
        [evidence.engineRunIdSha256, "engineRunIdSha256"],
        [evidence.hostRunLedgerSha256, "hostRunLedgerSha256"],
        [evidence.eventLedgerSha256, "eventLedgerSha256"],
        [evidence.incidentLedgerSha256, "incidentLedgerSha256"],
        [evidence.sealedVerifierResultSha256, "sealedVerifierResultSha256"],
        [evidence.patchArtifactSha256, "patchArtifactSha256"],
        [evidence.workerAttestationSha256, "workerAttestationSha256"],
        [evidence.reviewRubricSha256, "reviewRubricSha256"],
        [evidence.reviewReceiptSha256, "reviewReceiptSha256"],
        [evidence.participantConsentSpecSha256, "participantConsentSpecSha256"],
        [evidence.participantConsentReceiptSha256, "participantConsentReceiptSha256"],
    ])
        sha256(value, name);
    const start = isoTime(evidence.startedAt, "startedAt");
    const end = isoTime(evidence.endedAt, "endedAt");
    if (end < start)
        throw new Error("Attempt end precedes start.");
    if (!TERMINAL_STATES.has(evidence.terminalState))
        throw new Error("Attempt terminal state is not terminal.");
    if (!Array.isArray(evidence.routeHistory) || evidence.routeHistory.length < 1 || evidence.routeHistory.length > 50
        || evidence.routeHistory.some((route) => !ROUTES.has(route)))
        throw new Error("Attempt route history is invalid.");
    opaqueId(evidence.reviewerId, "r", "reviewerId");
    if (!VERDICTS.has(evidence.patchVerdict) || !INCIDENTS.has(evidence.incidentSeverity)) {
        throw new Error("Attempt verdict or incident severity is invalid.");
    }
    integers(evidence.longHorizonMinutes, evidence.milestoneCount);
    for (const value of [
        evidence.truthfulTerminal, evidence.vanguardExposed, evidence.routeLedgerComplete, evidence.eventLedgerComplete,
        evidence.incidentLedgerComplete, evidence.safetyLedgerComplete, evidence.privacyLedgerComplete,
        evidence.gapDetected, evidence.gapReported, evidence.cursorOrderComplete,
        evidence.possibleMutation, evidence.legacyReplayAfterPossibleMutation, evidence.workerStopAcknowledged,
        evidence.reviewerIndependent, evidence.sealedVerificationPassed, evidence.patchApplied,
        evidence.requiredInteractionObserved, evidence.privacyIncident,
        evidence.telemetryPrivacyViolation, evidence.originalRepositoryMutationOutsideApply,
        evidence.orphanedWorker, evidence.journalOrPatchIntegrityFailure,
    ])
        if (typeof value !== "boolean")
            throw new Error("Attempt boolean evidence is invalid.");
    if (!evidence.gapDetected && evidence.gapReported)
        throw new Error("A nonexistent gap cannot be reported.");
    if (!evidence.vanguardExposed || evidence.routeHistory[0] !== "vanguard") {
        throw new Error("A beta task attempt must be genuinely exposed to Vanguard.");
    }
    if (new Set(evidence.routeHistory).size !== evidence.routeHistory.length
        || evidence.routeHistory.some((route) => route === "legacy")) {
        throw new Error("Task route history violates the Vanguard/manual-recovery DFA.");
    }
    const finalRoute = evidence.routeHistory.at(-1);
    if ((finalRoute === "manual_recovery") !== (evidence.terminalState === "manual_recovery")) {
        throw new Error("Task terminal state contradicts its final route.");
    }
    if (evidence.gapDetected && (!evidence.gapReported || finalRoute !== "manual_recovery"
        || evidence.terminalState !== "manual_recovery" || evidence.eventLedgerComplete)) {
        throw new Error("Replay-gap evidence contradicts fail-closed routing.");
    }
    if (evidence.patchApplied && (!evidence.sealedVerificationPassed || evidence.terminalState !== "completed")) {
        throw new Error("Applied patch evidence contradicts completion or sealed verification.");
    }
    if (evidence.patchApplied && !evidence.possibleMutation) {
        throw new Error("Applied patch evidence contradicts the mutation record.");
    }
    const actualDurationMinutes = Math.floor((end - start) / 60_000);
    if (evidence.longHorizonMinutes > actualDurationMinutes) {
        throw new Error("Claimed long-horizon minutes exceed wall-clock attempt duration.");
    }
    if ((evidence.patchVerdict === "acceptable" || evidence.patchVerdict === "better")
        && (!evidence.reviewerIndependent || !evidence.patchApplied || !evidence.sealedVerificationPassed)) {
        throw new Error("Positive review evidence is detached from a verified applied patch.");
    }
    const firstVanguard = evidence.routeHistory.indexOf("vanguard");
    const legacyAfterVanguard = firstVanguard >= 0
        && evidence.routeHistory.slice(firstVanguard + 1).includes("legacy");
    const derivedReplayAfterMutation = evidence.possibleMutation && legacyAfterVanguard;
    if (evidence.legacyReplayAfterPossibleMutation !== derivedReplayAfterMutation) {
        throw new Error("Mutation replay evidence contradicts the route history.");
    }
    if (evidence.orphanedWorker === evidence.workerStopAcknowledged) {
        throw new Error("Worker stop acknowledgement contradicts orphan evidence.");
    }
}
function validateControlEvidence(evidence) {
    exactKeys(evidence, [
        "kind", "controlId", "wave", "controlKind", "controlSpecSha256", "waveFreezeSha256",
        "observedAt", "selectedRoute",
        "newVanguardSelectionBlocked", "activeSessionDisposition", "hostRunLedgerSha256",
        "incidentLedgerSha256", "incidentLedgerComplete", "activeVanguardSessionObserved",
        "workerStopAcknowledged", "orphanedWorker", "incidentSeverity", "privacyIncident",
        "telemetryPrivacyViolation", "originalRepositoryMutationOutsideApply", "journalOrPatchIntegrityFailure",
    ], "control evidence");
    opaqueId(evidence.controlId, "c", "controlId");
    wave(evidence.wave);
    if (evidence.controlKind !== "non-opted-in" && evidence.controlKind !== "kill-switch") {
        throw new Error("Control kind is invalid.");
    }
    sha256(evidence.controlSpecSha256, "controlSpecSha256");
    sha256(evidence.waveFreezeSha256, "waveFreezeSha256");
    sha256(evidence.hostRunLedgerSha256, "hostRunLedgerSha256");
    sha256(evidence.incidentLedgerSha256, "incidentLedgerSha256");
    if (!INCIDENTS.has(evidence.incidentSeverity))
        throw new Error("Control incident severity is invalid.");
    isoTime(evidence.observedAt, "observedAt");
    if (!ROUTES.has(evidence.selectedRoute) || typeof evidence.newVanguardSelectionBlocked !== "boolean"
        || typeof evidence.incidentLedgerComplete !== "boolean"
        || typeof evidence.activeVanguardSessionObserved !== "boolean"
        || typeof evidence.workerStopAcknowledged !== "boolean"
        || typeof evidence.orphanedWorker !== "boolean"
        || typeof evidence.privacyIncident !== "boolean"
        || typeof evidence.telemetryPrivacyViolation !== "boolean"
        || typeof evidence.originalRepositoryMutationOutsideApply !== "boolean"
        || typeof evidence.journalOrPatchIntegrityFailure !== "boolean"
        || !["not-applicable", "legacy", "manual-recovery", "unconfirmed"].includes(evidence.activeSessionDisposition)) {
        throw new Error("Control evidence is invalid.");
    }
    if (evidence.activeVanguardSessionObserved
        && evidence.workerStopAcknowledged === evidence.orphanedWorker) {
        throw new Error("Active control worker acknowledgement contradicts orphan evidence.");
    }
    if (!evidence.activeVanguardSessionObserved && (evidence.workerStopAcknowledged || evidence.orphanedWorker)) {
        throw new Error("Inactive control cannot claim worker-stop or orphan evidence.");
    }
}
function validateRatingEvidence(evidence) {
    exactKeys(evidence, [
        "kind", "participantId", "wave", "recordedAt", "trustSafetyRating",
        "participantSurveySpecSha256", "surveyReceiptSha256",
    ], "rating evidence");
    opaqueId(evidence.participantId, "p", "participantId");
    wave(evidence.wave);
    isoTime(evidence.recordedAt, "recordedAt");
    sha256(evidence.participantSurveySpecSha256, "participantSurveySpecSha256");
    sha256(evidence.surveyReceiptSha256, "surveyReceiptSha256");
    if (![1, 2, 3, 4, 5].includes(evidence.trustSafetyRating))
        throw new Error("Participant rating is invalid.");
}
function validateReleaseEvidence(evidence) {
    exactKeys(evidence, [
        "kind", "wave", "lastAttemptEndedAt", "releasedAt", "everyFailureReviewed", "incidentReviewComplete",
        "ledgerPrefixHash", "timestampAttestation",
    ], "wave release evidence");
    wave(evidence.wave);
    isoTime(evidence.lastAttemptEndedAt, "lastAttemptEndedAt");
    isoTime(evidence.releasedAt, "releasedAt");
    sha256(evidence.ledgerPrefixHash, "ledgerPrefixHash");
    validateAuthoritySignatureShape(evidence.timestampAttestation);
    if (typeof evidence.everyFailureReviewed !== "boolean" || typeof evidence.incidentReviewComplete !== "boolean") {
        throw new Error("Wave release review flags are invalid.");
    }
}
function validateInvalidationEvidence(evidence) {
    exactKeys(evidence, ["kind", "wave", "invalidatedAt", "reason"], "wave invalidation evidence");
    wave(evidence.wave);
    isoTime(evidence.invalidatedAt, "invalidatedAt");
    if (!["engine-changed", "config-changed", "verifier-changed", "eligibility-changed", "incident", "integrity"]
        .includes(evidence.reason))
        throw new Error("Wave invalidation reason is invalid.");
}
function verifyEvidenceSignature(trust, statement, signature) {
    exactKeys(signature, ["evaluatorId", "keyId", "signatureBase64"], "evidence signature");
    if (signature.evaluatorId !== trust.evaluatorId || signature.keyId !== trust.keyId
        || typeof signature.signatureBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.signatureBase64)) {
        throw new Error("Beta evidence signature identity or encoding is invalid.");
    }
    const bytes = Buffer.from(signature.signatureBase64, "base64");
    if (bytes.toString("base64") !== signature.signatureBase64
        || !verifySignature(null, Buffer.from(statement, "utf8"), canonicalEd25519PublicKey(trust.publicKeyPem, "Evaluator"), bytes)) {
        throw new Error("Beta evidence signature is invalid.");
    }
}
function invalidReport(planSha256, evaluatedAt, blocker, ledger = [], authorityPolicySha256 = "0".repeat(64), candidateEpochSha256 = "0".repeat(64)) {
    const core = {
        version: 1,
        planSha256,
        candidateEpochSha256,
        authorityPolicySha256,
        evaluatedAt: typeof evaluatedAt === "string" ? evaluatedAt : "invalid",
        complete: false,
        stopEnrollment: true,
        expectedAttempts: 200,
        recordedAttempts: 0,
        missingAttempts: 200,
        duplicateAttempts: 0,
        ledgerEntryCount: Array.isArray(ledger) ? ledger.length : 0,
        ledgerHeadHash: Array.isArray(ledger) ? ledger.at(-1)?.hash ?? ARES_BETA_LEDGER_GENESIS : ARES_BETA_LEDGER_GENESIS,
        invalidatedWaves: [],
        blockers: [blocker],
        gates: [],
    };
    return {
        ...core,
        status: "invalid",
        passed: false,
        evaluationSha256: digest(canonicalJson(core)),
        certificationStatement: "",
    };
}
function gate(id, passed, value, requirement) {
    return { id, passed, value, requirement };
}
function exactKeys(value, allowed, context) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${context} must be an object.`);
    const keys = Object.keys(value).sort();
    const expected = [...allowed].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new Error(`${context} contains missing or forbidden fields.`);
    }
}
function opaqueId(value, prefix, name) {
    if (typeof value !== "string" || !(new RegExp(`^${prefix}_[a-f0-9]{24}$`)).test(value)) {
        throw new Error(`${name} must be an opaque ${prefix}_ pseudonym.`);
    }
}
function gitCommit(value, name) {
    if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
        throw new Error(`${name} must be a full hexadecimal Git object ID.`);
    }
}
function sha256(value, name) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        throw new Error(`${name} must be SHA-256 hex.`);
}
function isoTime(value, name) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
        throw new Error(`${name} must be a UTC ISO timestamp.`);
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        throw new Error(`${name} is invalid.`);
    return parsed;
}
function wave(value) {
    if (!WAVES.includes(value))
        throw new Error("Beta wave is invalid.");
}
function integers(...values) {
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
        throw new Error("Attempt numeric evidence is invalid.");
}
function validatePreviousHash(value, sequence) {
    if (sequence === 1 ? value !== ARES_BETA_LEDGER_GENESIS : !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error("Ledger previous hash is invalid.");
    }
}
function sameSet(actual, expected) {
    return actual.length === expected.length && new Set(actual).size === expected.length
        && expected.every((value) => actual.includes(value));
}
function frequencies(values) {
    const output = new Map();
    for (const value of values)
        output.set(value, (output.get(value) ?? 0) + 1);
    return output;
}
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}
function safeError(error) {
    const message = error instanceof Error ? error.message : "invalid beta evidence";
    return `invalid_evidence:${message.replace(/[^a-z0-9 _.-]/gi, "").slice(0, 160)}`;
}
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("Canonical beta evidence cannot contain non-finite numbers.");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value !== "object")
        throw new Error("Canonical beta evidence contains an unsupported value.");
    return `{${Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
        .join(",")}}`;
}
