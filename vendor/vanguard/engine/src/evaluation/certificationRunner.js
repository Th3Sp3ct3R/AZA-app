import { createHash, createHmac, randomUUID, verify as verifySignature } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalCertificationJson, evaluationTrackKey, validateAssignmentArtifacts, verifyEvaluatorEvidenceAttestation, } from "./certification.js";
const EXECUTION_GENESIS = "0".repeat(64);
const SHA256 = /^[a-f0-9]{64}$/u;
const ATTESTATION_EXPIRY_GRACE_MS = 15 * 60_000;
export class CertificationExecutionOrchestrator {
    #manifest;
    #publicArtifact;
    #privateArtifact;
    #authority;
    #adapter;
    #attestationVerifier;
    #store;
    #maxAttempts;
    #retryTimedOut;
    #now;
    #invocationId;
    constructor(manifest, publicArtifact, privateArtifact, authority, adapter, attestationVerifier, store, options = {}) {
        validateAssignmentArtifacts(manifest, publicArtifact, privateArtifact, authority);
        if (adapter.executionMode !== attestationVerifier.executionMode || adapter.adapterId === attestationVerifier.verifierId) {
            throw new Error("Execution adapter and independent isolation verifier modes/identities must match.");
        }
        if (adapter.executionMode === "externally-isolated"
            && (attestationVerifier.verifierId !== manifest.isolationPolicy.verifierId
                || attestationVerifier.policyId !== manifest.isolationPolicy.policyId)) {
            throw new Error("External isolation verifier does not match the frozen manifest policy.");
        }
        const maxAttempts = options.maxInfrastructureAttempts ?? 2;
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
            throw new Error("Infrastructure attempt budget must be between 1 and 5.");
        }
        this.#manifest = manifest;
        this.#publicArtifact = publicArtifact;
        this.#privateArtifact = privateArtifact;
        this.#authority = authority;
        this.#adapter = adapter;
        this.#attestationVerifier = attestationVerifier;
        this.#store = store;
        this.#maxAttempts = maxAttempts;
        this.#retryTimedOut = options.retryTimedOut ?? false;
        this.#now = options.now ?? (() => new Date());
        this.#invocationId = options.invocationId ?? randomUUID;
    }
    async run(signal = new AbortController().signal) {
        validateAssignmentArtifacts(this.#manifest, this.#publicArtifact, this.#privateArtifact, this.#authority);
        let ledger = await this.#store.load();
        validateExecutionLedger(ledger, this.#publicArtifact, this.#privateArtifact);
        let resumedOrphans = 0;
        let skippedCompleted = 0;
        let skippedExhausted = 0;
        let completed = 0;
        let failed = 0;
        let timedOut = 0;
        let scheduled = 0;
        const privateByRun = new Map(this.#privateArtifact.assignments.map((assignment) => [assignment.runId, assignment]));
        const taskById = new Map(this.#manifest.tasks.map((task) => [task.id, task]));
        const engineById = new Map(this.#manifest.engines.map((engine) => [engine.id, engine]));
        for (const publicAssignment of this.#publicArtifact.assignments) {
            if (signal.aborted)
                break;
            const prior = eventsFor(ledger, publicAssignment.runId);
            const latest = prior.at(-1);
            if (latest?.kind === "execution.completed") {
                skippedCompleted += 1;
                continue;
            }
            if (latest?.kind === "execution.started") {
                ledger = await appendExecutionEvent(this.#store, ledger, {
                    kind: "execution.interrupted",
                    runId: publicAssignment.runId,
                    attempt: latest.attempt,
                    assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
                    privateBindingSha256: latest.privateBindingSha256,
                    occurredAt: this.#now().toISOString(),
                    reason: "orphaned-on-resume",
                });
                resumedOrphans += 1;
            }
            const refreshed = eventsFor(ledger, publicAssignment.runId);
            const attempts = refreshed.filter((event) => event.kind === "execution.started").length;
            const terminal = refreshed.at(-1);
            const timeoutFinal = terminal?.kind === "execution.timed-out" && !this.#retryTimedOut;
            const infrastructureFinal = terminal?.kind === "execution.failed" && !terminal.retryable;
            if (attempts >= this.#maxAttempts || timeoutFinal || infrastructureFinal) {
                skippedExhausted += 1;
                continue;
            }
            const privateAssignment = privateByRun.get(publicAssignment.runId);
            const task = taskById.get(publicAssignment.taskId);
            const engine = engineById.get(privateAssignment.engineId);
            const attempt = attempts + 1;
            scheduled += 1;
            const invocationId = this.#invocationId();
            if (invocationId.trim().length === 0)
                throw new Error("Certification invocation id cannot be empty.");
            ledger = await appendExecutionEvent(this.#store, ledger, {
                kind: "execution.started",
                runId: publicAssignment.runId,
                attempt,
                assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
                privateBindingSha256: privateAssignment.privateBindingSha256,
                occurredAt: this.#now().toISOString(),
                invocationId,
            });
            const startedAt = this.#now().getTime();
            const request = deepFreeze(structuredClone({
                manifestSha256: this.#publicArtifact.manifestSha256,
                publicAssignment,
                privateAssignment,
                engine,
                task,
                attempt,
                invocationId,
                engineExecutionBindingSha256: certificationEngineExecutionBinding(this.#privateArtifact.privateBindingSalt, this.#publicArtifact.manifestSha256, publicAssignment, privateAssignment, engine, task, attempt, invocationId),
            }));
            try {
                const { outcome, isolationVerification } = await withTimeout(async (runSignal) => {
                    const candidate = await this.#adapter.run(request, runSignal);
                    validateExternalOutcome(this.#manifest, request, candidate);
                    if (candidate.executionMode !== this.#adapter.executionMode) {
                        throw new NonRetryableCertificationAdapterError("execution-mode-mismatch");
                    }
                    const verified = await this.#attestationVerifier.verify(request, candidate.isolation, runSignal);
                    validateIsolationVerification(this.#attestationVerifier, verified);
                    return { outcome: candidate, isolationVerification: verified };
                }, task.maxDurationMs, signal);
                const durationMs = Math.max(0, this.#now().getTime() - startedAt);
                const executionEvidenceSha256 = executionEvidence(outcome, isolationVerification);
                ledger = await appendExecutionEvent(this.#store, ledger, {
                    kind: "execution.completed",
                    runId: publicAssignment.runId,
                    attempt,
                    assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
                    privateBindingSha256: privateAssignment.privateBindingSha256,
                    occurredAt: this.#now().toISOString(),
                    durationMs,
                    executionEvidenceSha256,
                    isolationVerification,
                    outcome,
                });
                completed += 1;
            }
            catch (error) {
                if (signal.aborted) {
                    ledger = await appendExecutionEvent(this.#store, ledger, {
                        kind: "execution.interrupted",
                        runId: publicAssignment.runId,
                        attempt,
                        assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
                        privateBindingSha256: privateAssignment.privateBindingSha256,
                        occurredAt: this.#now().toISOString(),
                        reason: "evaluator-cancelled",
                    });
                    break;
                }
                const evidence = failureEvidence(error);
                if (error instanceof CertificationRunTimeoutError) {
                    ledger = await appendExecutionEvent(this.#store, ledger, {
                        kind: "execution.timed-out",
                        runId: publicAssignment.runId,
                        attempt,
                        assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
                        privateBindingSha256: privateAssignment.privateBindingSha256,
                        occurredAt: this.#now().toISOString(),
                        timeoutMs: task.maxDurationMs,
                        failureEvidenceSha256: evidence,
                    });
                    timedOut += 1;
                }
                else {
                    const classified = classifyAdapterFailure(error);
                    ledger = await appendExecutionEvent(this.#store, ledger, {
                        kind: "execution.failed",
                        runId: publicAssignment.runId,
                        attempt,
                        assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
                        privateBindingSha256: privateAssignment.privateBindingSha256,
                        occurredAt: this.#now().toISOString(),
                        failureCode: classified.code,
                        retryable: classified.retryable,
                        failureEvidenceSha256: evidence,
                    });
                    failed += 1;
                }
            }
        }
        return {
            scheduled,
            completed,
            failed,
            timedOut,
            resumedOrphans,
            skippedCompleted,
            skippedExhausted,
            ledgerHead: ledger.at(-1)?.hash ?? EXECUTION_GENESIS,
        };
    }
}
export class FileCertificationExecutionLedger {
    #file;
    #pending = Promise.resolve();
    constructor(file) {
        this.#file = path.resolve(file);
    }
    async load() {
        try {
            const parsed = JSON.parse(await readFile(this.#file, "utf8"));
            if (!Array.isArray(parsed))
                throw new Error("Execution ledger must be a JSON array.");
            return parsed;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return [];
            throw error;
        }
    }
    async append(expectedPreviousHash, entry) {
        const operation = this.#pending.then(async () => {
            const current = await this.load();
            validateExecutionLedger(current);
            const head = current.at(-1)?.hash ?? EXECUTION_GENESIS;
            if (head !== expectedPreviousHash || entry.previousHash !== head) {
                throw new Error("Execution ledger compare-and-swap conflict.");
            }
            const next = [...current, entry];
            validateExecutionLedger(next);
            await atomicPrivateJson(this.#file, next);
        });
        this.#pending = operation.catch(() => undefined);
        await operation;
    }
}
export class MemoryCertificationExecutionLedger {
    #entries;
    constructor(entries = []) {
        validateExecutionLedger(entries);
        this.#entries = [...entries];
    }
    async load() {
        return structuredClone(this.#entries);
    }
    async append(expectedPreviousHash, entry) {
        const head = this.#entries.at(-1)?.hash ?? EXECUTION_GENESIS;
        if (head !== expectedPreviousHash || entry.previousHash !== head)
            throw new Error("Execution ledger compare-and-swap conflict.");
        const next = [...this.#entries, entry];
        validateExecutionLedger(next);
        this.#entries = next;
    }
}
export async function appendExecutionEvent(store, ledger, event) {
    validateExecutionLedger(ledger);
    validateExecutionEvent(event);
    const previousHash = ledger.at(-1)?.hash ?? EXECUTION_GENESIS;
    const index = ledger.length + 1;
    const hash = executionLedgerHash(previousHash, index, event);
    const entry = { index, previousHash, hash, event };
    await store.append(previousHash, entry);
    return [...ledger, entry];
}
export function validateExecutionLedger(ledger, assignments, privateAssignments) {
    if (privateAssignments !== undefined && assignments === undefined) {
        throw new Error("Private execution bindings require the matching public assignment artifact.");
    }
    let previousHash = EXECUTION_GENESIS;
    const publicByRun = assignments === undefined
        ? undefined : new Map(assignments.assignments.map((assignment) => [assignment.runId, assignment]));
    const privateByRun = privateAssignments === undefined
        ? undefined : new Map(privateAssignments.assignments.map((assignment) => [assignment.runId, assignment]));
    for (const [offset, entry] of ledger.entries()) {
        assertExactKeys(entry, ["index", "previousHash", "hash", "event"], "certification execution ledger entry");
        validateExecutionEvent(entry.event);
        if (entry.index !== offset + 1 || entry.previousHash !== previousHash
            || entry.hash !== executionLedgerHash(previousHash, entry.index, entry.event)) {
            throw new Error(`Certification execution ledger integrity failure at entry ${offset + 1}.`);
        }
        const assignment = publicByRun?.get(entry.event.runId);
        if (publicByRun !== undefined && (assignment === undefined
            || assignment.assignmentBindingSha256 !== entry.event.assignmentBindingSha256)) {
            throw new Error(`Execution event is not bound to public assignment '${entry.event.runId}'.`);
        }
        const privateAssignment = privateByRun?.get(entry.event.runId);
        if (privateByRun !== undefined && (privateAssignment === undefined
            || privateAssignment.privateBindingSha256 !== entry.event.privateBindingSha256)) {
            throw new Error(`Execution event is not bound to private assignment '${entry.event.runId}'.`);
        }
        previousHash = entry.hash;
    }
    validateExecutionStateMachine(ledger);
}
export function executionEvidence(outcome, verification) {
    return digest({ outcome, isolationVerification: verification });
}
export function extractCertificationExecutionProofs(manifest, ledger, assignments, privateAssignments, authority) {
    validateAssignmentArtifacts(manifest, assignments, privateAssignments, authority);
    validateExecutionLedger(ledger, assignments, privateAssignments);
    const publicByRun = new Map(assignments.assignments.map((assignment) => [assignment.runId, assignment]));
    const privateByRun = new Map(privateAssignments.assignments.map((assignment) => [assignment.runId, assignment]));
    const taskById = new Map(manifest.tasks.map((task) => [task.id, task]));
    const engineById = new Map(manifest.engines.map((engine) => [engine.id, engine]));
    const proofs = [];
    for (const entry of ledger) {
        if (entry.event.kind !== "execution.completed")
            continue;
        const { event } = entry;
        if (eventsFor(ledger, event.runId).filter((candidate) => candidate.kind === "execution.started").length !== 1) {
            throw new Error(`Execution '${event.runId}' has multiple attempts without complete cost/intervention accounting.`);
        }
        const publicAssignment = publicByRun.get(event.runId);
        const privateAssignment = privateByRun.get(event.runId);
        const task = taskById.get(publicAssignment.taskId);
        const engine = engineById.get(privateAssignment.engineId);
        const started = eventsFor(ledger, event.runId).find((candidate) => candidate.kind === "execution.started");
        if (started?.kind !== "execution.started")
            throw new Error(`Execution '${event.runId}' lacks its signed start.`);
        const request = {
            manifestSha256: assignments.manifestSha256,
            publicAssignment,
            privateAssignment,
            engine,
            task,
            attempt: started.attempt,
            invocationId: started.invocationId,
            engineExecutionBindingSha256: certificationEngineExecutionBinding(privateAssignments.privateBindingSalt, assignments.manifestSha256, publicAssignment, privateAssignment, engine, task, started.attempt, started.invocationId),
        };
        revalidatePersistedExternalExecution(manifest, request, event);
        if (event.outcome.executionMode !== "externally-isolated"
            || event.isolationVerification.executionMode !== "externally-isolated") {
            throw new Error(`Execution '${event.runId}' is dry-run evidence and cannot support certification.`);
        }
        proofs.push({
            runId: event.runId,
            assignmentBindingSha256: event.assignmentBindingSha256,
            executionEvidenceSha256: event.executionEvidenceSha256,
            executionMode: "externally-isolated",
            success: event.outcome.success,
            interventions: event.outcome.interventions.length,
            usage: event.outcome.usage,
            costUsd: event.outcome.costUsd,
            durationMs: event.durationMs,
            criticalIncident: event.outcome.criticalIncident,
            isolationVerificationEvidenceSha256: event.isolationVerification.verificationEvidenceSha256,
        });
    }
    return proofs;
}
export class DeterministicDryRunAdapter {
    adapterId = "deterministic-dry-run/no-provider";
    executionMode = "dry-run";
    calls = 0;
    async run(request, signal) {
        if (signal.aborted)
            throw signal.reason;
        this.calls += 1;
        const evidence = digest({
            dryRun: true,
            runId: request.publicAssignment.runId,
            binding: request.publicAssignment.assignmentBindingSha256,
            attempt: request.attempt,
        });
        return {
            runId: request.publicAssignment.runId,
            assignmentBindingSha256: request.publicAssignment.assignmentBindingSha256,
            privateBindingSha256: request.privateAssignment.privateBindingSha256,
            executionMode: "dry-run",
            success: true,
            criticalIncident: false,
            toolCalls: 0,
            steps: 0,
            isolation: {
                workspaceId: `dry-${request.publicAssignment.runId.slice(0, 12)}`,
                mechanism: "fake-no-process",
                cleanAtStart: true,
                originalWorkspaceUnmodified: true,
                inputBundleSha256: request.task.inputBundleSha256,
                sourceSha256: request.task.sourceSha256,
                graderSha256: request.task.graderSha256,
                evidenceSha256: evidence,
                attestation: dryRunAttestation(request, evidence),
            },
            interventions: [],
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                providerReported: false,
                evidenceSha256: evidence,
            },
            costUsd: 0,
            costEvidenceSha256: evidence,
            graderEvidenceSha256: evidence,
            artifactEvidenceSha256: evidence,
            evaluatorAttestation: {
                protocolVersion: 1,
                kind: "execution-outcome",
                evaluatorId: "deterministic-dry-run/no-evaluator",
                keyId: "not-a-real-key",
                manifestSha256: request.manifestSha256,
                issuedAt: "1970-01-01T00:00:00.000Z",
                statementSha256: evidence,
                signatureBase64: Buffer.from(evidence).toString("base64"),
            },
        };
    }
}
export class DeterministicDryRunIsolationVerifier {
    verifierId = "deterministic-dry-run/attestation-verifier";
    policyId = "dry-run-only/not-certifiable";
    executionMode = "dry-run";
    async verify(request, evidence, signal) {
        if (signal.aborted)
            throw signal.reason;
        const expected = dryRunAttestation(request, evidence.evidenceSha256);
        if (canonicalCertificationJson(expected)
            !== canonicalCertificationJson(evidence.attestation)) {
            throw new NonRetryableCertificationAdapterError("dry-run-attestation-mismatch");
        }
        return {
            verifierId: this.verifierId,
            policyId: this.policyId,
            executionMode: "dry-run",
            verifiedAt: "1970-01-01T00:00:00.000Z",
            verificationEvidenceSha256: digest(expected),
            valid: true,
        };
    }
}
export class SignedIsolationAttestationVerifier {
    verifierId;
    policyId;
    executionMode = "externally-isolated";
    #issuers;
    #allowedMechanisms;
    #networkPolicySha256;
    #resourcePolicySha256;
    #now;
    constructor(policy, now = () => new Date()) {
        if ([policy.verifierId, policy.policyId].some((value) => value.trim().length === 0)
            || policy.trustedIssuers.length === 0 || policy.allowedMechanisms.length === 0
            || !SHA256.test(policy.networkPolicySha256) || !SHA256.test(policy.resourcePolicySha256)) {
            throw new Error("External isolation verifier requires an identity, policy, and trusted issuer.");
        }
        if (new Set(policy.trustedIssuers.map((issuer) => issuer.issuerId)).size !== policy.trustedIssuers.length) {
            throw new Error("Duplicate trusted isolation issuer.");
        }
        this.verifierId = policy.verifierId;
        this.policyId = policy.policyId;
        this.#issuers = new Map(policy.trustedIssuers.map((issuer) => [issuer.issuerId, issuer]));
        this.#allowedMechanisms = new Set(policy.allowedMechanisms);
        this.#networkPolicySha256 = policy.networkPolicySha256;
        this.#resourcePolicySha256 = policy.resourcePolicySha256;
        this.#now = now;
    }
    async verify(request, evidence, signal) {
        if (signal.aborted)
            throw signal.reason;
        const attestation = evidence.attestation;
        validateAttestationBinding(request, evidence);
        if (!this.#allowedMechanisms.has(attestation.mechanism)
            || attestation.networkPolicySha256 !== this.#networkPolicySha256
            || attestation.resourcePolicySha256 !== this.#resourcePolicySha256) {
            throw new NonRetryableCertificationAdapterError("isolation-policy-mismatch");
        }
        const issuer = this.#issuers.get(attestation.issuerId);
        if (issuer === undefined || issuer.keyId !== attestation.keyId) {
            throw new NonRetryableCertificationAdapterError("untrusted-isolation-attestation-issuer");
        }
        const statement = isolationAttestationStatement(attestation);
        const serialized = canonicalCertificationJson(statement);
        if (attestation.statementSha256 !== digest(statement)
            || !verifySignature(null, Buffer.from(serialized), issuer.publicKeyPem, Buffer.from(attestation.signatureBase64, "base64"))) {
            throw new NonRetryableCertificationAdapterError("invalid-isolation-attestation-signature");
        }
        const verifiedAt = this.#now();
        const now = verifiedAt.getTime();
        const issuedAt = Date.parse(attestation.issuedAt);
        const expiresAt = Date.parse(attestation.expiresAt);
        const maximumValidityMs = request.task.maxDurationMs + ATTESTATION_EXPIRY_GRACE_MS;
        if (now < issuedAt || now > expiresAt || expiresAt - issuedAt > maximumValidityMs) {
            throw new NonRetryableCertificationAdapterError("expired-isolation-attestation");
        }
        return {
            verifierId: this.verifierId,
            policyId: this.policyId,
            executionMode: "externally-isolated",
            verifiedAt: verifiedAt.toISOString(),
            verificationEvidenceSha256: digest({
                verifierId: this.verifierId,
                policyId: this.policyId,
                executionMode: this.executionMode,
                attestationStatementSha256: attestation.statementSha256,
            }),
            valid: true,
        };
    }
}
function validateExternalOutcome(manifest, request, outcome) {
    try {
        validateStoredOutcome(outcome);
    }
    catch {
        throw new NonRetryableCertificationAdapterError("invalid-outcome-schema");
    }
    if (outcome.runId !== request.publicAssignment.runId
        || outcome.assignmentBindingSha256 !== request.publicAssignment.assignmentBindingSha256
        || outcome.privateBindingSha256 !== request.privateAssignment.privateBindingSha256) {
        throw new NonRetryableCertificationAdapterError("assignment-binding-mismatch");
    }
    const isolation = outcome.isolation;
    if (!isolation.cleanAtStart || !isolation.originalWorkspaceUnmodified
        || isolation.inputBundleSha256 !== request.task.inputBundleSha256
        || isolation.sourceSha256 !== request.task.sourceSha256 || isolation.graderSha256 !== request.task.graderSha256
        || isolation.workspaceId.trim().length === 0 || isolation.mechanism.trim().length === 0
        || !SHA256.test(isolation.evidenceSha256)) {
        throw new NonRetryableCertificationAdapterError("isolation-evidence-mismatch");
    }
    validateAttestationBinding(request, isolation);
    for (const intervention of outcome.interventions) {
        if ([intervention.kind, intervention.actorId].some((value) => value.trim().length === 0)
            || !Number.isFinite(Date.parse(intervention.occurredAt)) || !SHA256.test(intervention.evidenceSha256)) {
            throw new NonRetryableCertificationAdapterError("invalid-intervention-evidence");
        }
    }
    if (outcome.executionMode === "externally-isolated"
        && (!manifest.isolationPolicy.allowedMechanisms.includes(isolation.mechanism)
            || isolation.attestation.networkPolicySha256 !== manifest.isolationPolicy.networkPolicySha256
            || isolation.attestation.resourcePolicySha256 !== manifest.isolationPolicy.resourcePolicySha256)) {
        throw new NonRetryableCertificationAdapterError("isolation-policy-mismatch");
    }
    validateRunnerUsage(outcome.usage);
    const trackPolicy = request.engine.trackPolicies[evaluationTrackKey(request.task)];
    if (trackPolicy === undefined)
        throw new NonRetryableCertificationAdapterError("missing-frozen-track-policy");
    if (!Number.isSafeInteger(outcome.toolCalls) || outcome.toolCalls < 0 || outcome.toolCalls > trackPolicy.toolCallBudget
        || !Number.isSafeInteger(outcome.steps) || outcome.steps < 0 || outcome.steps > trackPolicy.stepBudget
        || (outcome.usage.inputTokens !== null && outcome.usage.inputTokens > trackPolicy.inputTokenBudget)
        || (outcome.usage.outputTokens !== null && outcome.usage.outputTokens > trackPolicy.outputTokenBudget)) {
        throw new NonRetryableCertificationAdapterError("frozen-track-budget-exceeded");
    }
    if (outcome.costUsd !== null && (!Number.isFinite(outcome.costUsd) || outcome.costUsd < 0)) {
        throw new NonRetryableCertificationAdapterError("invalid-cost-evidence");
    }
    for (const value of [outcome.costEvidenceSha256, outcome.graderEvidenceSha256, outcome.artifactEvidenceSha256]) {
        if (!SHA256.test(value))
            throw new NonRetryableCertificationAdapterError("malformed-evidence-digest");
    }
    if (outcome.executionMode === "externally-isolated") {
        try {
            verifyEvaluatorEvidenceAttestation(manifest, outcome.evaluatorAttestation, externalRunOutcomeStatement(outcome), "execution-outcome");
        }
        catch {
            throw new NonRetryableCertificationAdapterError("invalid-evaluator-outcome-signature");
        }
    }
}
function revalidatePersistedExternalExecution(manifest, request, event) {
    if (event.outcome.executionMode !== "externally-isolated"
        || event.isolationVerification.executionMode !== "externally-isolated") {
        throw new Error(`Execution '${event.runId}' is dry-run/non-external evidence and cannot support certification.`);
    }
    validateExternalOutcome(manifest, request, event.outcome);
    if (event.durationMs > request.task.maxDurationMs) {
        throw new Error(`Execution '${event.runId}' exceeded its frozen duration budget.`);
    }
    const verification = event.isolationVerification;
    if (verification.verifierId !== manifest.isolationPolicy.verifierId
        || verification.policyId !== manifest.isolationPolicy.policyId
        || verification.valid !== true) {
        throw new Error(`Execution '${event.runId}' used an unfrozen isolation verifier policy.`);
    }
    const evidence = event.outcome.isolation;
    validateAttestationBinding(request, evidence);
    const attestation = evidence.attestation;
    const issuer = manifest.isolationPolicy.trustedIssuers.find((candidate) => candidate.issuerId === attestation.issuerId && candidate.keyId === attestation.keyId);
    if (issuer === undefined)
        throw new Error(`Execution '${event.runId}' used an untrusted isolation issuer.`);
    const statement = isolationAttestationStatement(attestation);
    const serialized = canonicalCertificationJson(statement);
    if (attestation.statementSha256 !== digest(statement)
        || !verifySignature(null, Buffer.from(serialized), issuer.publicKeyPem, Buffer.from(attestation.signatureBase64, "base64"))) {
        throw new Error(`Execution '${event.runId}' has an invalid persisted host signature.`);
    }
    const issuedAt = Date.parse(attestation.issuedAt);
    const expiresAt = Date.parse(attestation.expiresAt);
    const verifiedAt = Date.parse(verification.verifiedAt);
    const completedAt = Date.parse(event.occurredAt);
    const evaluatorIssuedAt = Date.parse(event.outcome.evaluatorAttestation.issuedAt);
    if (issuedAt < Date.parse(manifest.frozenAt) || verifiedAt < issuedAt || verifiedAt > expiresAt
        || evaluatorIssuedAt < issuedAt || evaluatorIssuedAt > completedAt
        || completedAt < verifiedAt || expiresAt - issuedAt > request.task.maxDurationMs + ATTESTATION_EXPIRY_GRACE_MS) {
        throw new Error(`Execution '${event.runId}' has stale/replayed isolation evidence.`);
    }
    const expectedVerificationEvidence = digest({
        verifierId: verification.verifierId,
        policyId: verification.policyId,
        executionMode: verification.executionMode,
        attestationStatementSha256: attestation.statementSha256,
    });
    if (verification.verificationEvidenceSha256 !== expectedVerificationEvidence) {
        throw new Error(`Execution '${event.runId}' has altered isolation verification evidence.`);
    }
}
export function externalRunOutcomeStatement(outcome) {
    const { evaluatorAttestation: _attestation, ...statement } = outcome;
    return statement;
}
function validateAttestationBinding(request, evidence) {
    assertExactKeys(evidence, [
        "workspaceId", "mechanism", "cleanAtStart", "originalWorkspaceUnmodified", "inputBundleSha256",
        "sourceSha256", "graderSha256", "evidenceSha256", "attestation",
    ], "isolation evidence");
    const { attestation } = evidence;
    assertExactKeys(attestation, [
        "runId", "manifestSha256", "assignmentBindingSha256", "privateBindingSha256",
        "engineExecutionBindingSha256", "attempt", "invocationId", "inputBundleSha256", "sourceSha256",
        "graderSha256", "workspaceId", "mechanism", "isolationEvidenceSha256", "networkPolicySha256",
        "resourcePolicySha256", "cleanAtStart", "originalWorkspaceUnmodified", "readOnlyInputs",
        "noHostCredentials", "disposableWorkspace", "teardownRequired", "issuerId", "keyId", "issuedAt",
        "expiresAt", "statementSha256", "signatureBase64",
    ], "host isolation attestation");
    if (attestation.runId !== request.publicAssignment.runId
        || attestation.manifestSha256 !== request.manifestSha256
        || attestation.assignmentBindingSha256 !== request.publicAssignment.assignmentBindingSha256
        || attestation.privateBindingSha256 !== request.privateAssignment.privateBindingSha256
        || attestation.engineExecutionBindingSha256 !== request.engineExecutionBindingSha256
        || attestation.attempt !== request.attempt
        || attestation.invocationId !== request.invocationId
        || evidence.inputBundleSha256 !== request.task.inputBundleSha256
        || evidence.sourceSha256 !== request.task.sourceSha256
        || evidence.graderSha256 !== request.task.graderSha256
        || attestation.inputBundleSha256 !== evidence.inputBundleSha256
        || attestation.sourceSha256 !== evidence.sourceSha256
        || attestation.graderSha256 !== evidence.graderSha256
        || attestation.workspaceId !== evidence.workspaceId
        || attestation.mechanism !== evidence.mechanism
        || attestation.isolationEvidenceSha256 !== evidence.evidenceSha256
        || attestation.cleanAtStart !== evidence.cleanAtStart
        || attestation.originalWorkspaceUnmodified !== evidence.originalWorkspaceUnmodified) {
        throw new NonRetryableCertificationAdapterError("isolation-attestation-binding-mismatch");
    }
    if ([attestation.issuerId, attestation.keyId, attestation.signatureBase64,
        attestation.invocationId].some((value) => value.trim().length === 0)
        || !Number.isSafeInteger(attestation.attempt) || attestation.attempt < 1
        || !SHA256.test(attestation.privateBindingSha256)
        || !SHA256.test(attestation.engineExecutionBindingSha256)
        || !SHA256.test(attestation.statementSha256)
        || !SHA256.test(attestation.networkPolicySha256) || !SHA256.test(attestation.resourcePolicySha256)
        || attestation.cleanAtStart !== true || attestation.originalWorkspaceUnmodified !== true
        || attestation.readOnlyInputs !== true || attestation.noHostCredentials !== true
        || attestation.disposableWorkspace !== true || attestation.teardownRequired !== true
        || !Number.isFinite(Date.parse(attestation.issuedAt)) || !Number.isFinite(Date.parse(attestation.expiresAt))
        || Date.parse(attestation.expiresAt) <= Date.parse(attestation.issuedAt)) {
        throw new NonRetryableCertificationAdapterError("malformed-isolation-attestation");
    }
}
function validateIsolationVerification(verifier, verification) {
    assertExactKeys(verification, ["verifierId", "policyId", "executionMode", "verifiedAt", "verificationEvidenceSha256", "valid"], "isolation verification");
    if (verification.valid !== true || verification.verifierId !== verifier.verifierId
        || verification.executionMode !== verifier.executionMode
        || verification.policyId.trim().length === 0 || !Number.isFinite(Date.parse(verification.verifiedAt))
        || !SHA256.test(verification.verificationEvidenceSha256)) {
        throw new NonRetryableCertificationAdapterError("invalid-isolation-verification-evidence");
    }
}
function validateRunnerUsage(usage) {
    for (const value of [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens]) {
        if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
            throw new NonRetryableCertificationAdapterError("invalid-usage-evidence");
        }
    }
    if (typeof usage.providerReported !== "boolean" || !SHA256.test(usage.evidenceSha256)
        || (usage.providerReported && (usage.inputTokens === null || usage.outputTokens === null))) {
        throw new NonRetryableCertificationAdapterError("invalid-usage-evidence");
    }
}
function validateExecutionEvent(event) {
    const common = ["kind", "runId", "attempt", "assignmentBindingSha256", "privateBindingSha256", "occurredAt"];
    const variant = event.kind === "execution.started" ? ["invocationId"]
        : event.kind === "execution.interrupted" ? ["reason"]
            : event.kind === "execution.timed-out" ? ["timeoutMs", "failureEvidenceSha256"]
                : event.kind === "execution.failed" ? ["failureCode", "retryable", "failureEvidenceSha256"]
                    : event.kind === "execution.completed"
                        ? ["durationMs", "executionEvidenceSha256", "isolationVerification", "outcome"]
                        : [];
    assertExactKeys(event, [...common, ...variant], "certification execution event");
    if (!SHA256.test(event.runId) || !SHA256.test(event.assignmentBindingSha256)
        || !SHA256.test(event.privateBindingSha256) || !Number.isSafeInteger(event.attempt) || event.attempt < 1
        || !Number.isFinite(Date.parse(event.occurredAt))) {
        throw new Error("Malformed certification execution event.");
    }
    if (event.kind === "execution.started") {
        if (event.invocationId.trim().length === 0)
            throw new Error("Execution start lacks an invocation id.");
    }
    else if (event.kind === "execution.interrupted") {
        if (event.reason !== "orphaned-on-resume" && event.reason !== "evaluator-cancelled") {
            throw new Error("Execution interruption reason is invalid.");
        }
    }
    else if (event.kind === "execution.timed-out") {
        if (!Number.isSafeInteger(event.timeoutMs) || event.timeoutMs < 1 || !SHA256.test(event.failureEvidenceSha256)) {
            throw new Error("Execution timeout evidence is invalid.");
        }
    }
    else if (event.kind === "execution.failed") {
        if (event.failureCode.trim().length === 0 || event.failureCode.length > 64
            || typeof event.retryable !== "boolean" || !SHA256.test(event.failureEvidenceSha256)) {
            throw new Error("Execution failure evidence is invalid.");
        }
    }
    else if (event.kind === "execution.completed") {
        if (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0
            || !SHA256.test(event.executionEvidenceSha256)) {
            throw new Error("Completed execution duration/evidence is invalid.");
        }
        validateStoredOutcome(event.outcome);
        validateIsolationVerification({
            verifierId: event.isolationVerification.verifierId,
            policyId: event.isolationVerification.policyId,
            executionMode: event.isolationVerification.executionMode,
            verify: async () => event.isolationVerification,
        }, event.isolationVerification);
        if (event.outcome.runId !== event.runId
            || event.outcome.assignmentBindingSha256 !== event.assignmentBindingSha256
            || event.outcome.privateBindingSha256 !== event.privateBindingSha256
            || event.executionEvidenceSha256 !== executionEvidence(event.outcome, event.isolationVerification)) {
            throw new Error("Completed execution event evidence binding is invalid.");
        }
    }
}
function validateStoredOutcome(outcome) {
    assertExactKeys(outcome, [
        "runId", "assignmentBindingSha256", "privateBindingSha256", "executionMode", "success", "criticalIncident",
        "toolCalls", "steps", "isolation", "interventions", "usage", "costUsd", "costEvidenceSha256",
        "graderEvidenceSha256", "artifactEvidenceSha256", "evaluatorAttestation",
    ], "external run outcome");
    assertExactKeys(outcome.isolation, [
        "workspaceId", "mechanism", "cleanAtStart", "originalWorkspaceUnmodified", "inputBundleSha256",
        "sourceSha256", "graderSha256", "evidenceSha256", "attestation",
    ], "isolation evidence");
    assertExactKeys(outcome.isolation.attestation, [
        "runId", "manifestSha256", "assignmentBindingSha256", "privateBindingSha256",
        "engineExecutionBindingSha256", "attempt", "invocationId", "inputBundleSha256", "sourceSha256",
        "graderSha256", "workspaceId", "mechanism", "isolationEvidenceSha256", "networkPolicySha256",
        "resourcePolicySha256", "cleanAtStart", "originalWorkspaceUnmodified", "readOnlyInputs",
        "noHostCredentials", "disposableWorkspace", "teardownRequired", "issuerId", "keyId", "issuedAt",
        "expiresAt", "statementSha256", "signatureBase64",
    ], "host isolation attestation");
    assertExactKeys(outcome.usage, ["inputTokens", "outputTokens", "cachedInputTokens", "providerReported", "evidenceSha256"], "execution usage evidence");
    assertExactKeys(outcome.evaluatorAttestation, [
        "protocolVersion", "kind", "evaluatorId", "keyId", "manifestSha256", "issuedAt", "statementSha256",
        "signatureBase64",
    ], "execution evaluator attestation");
    if (!SHA256.test(outcome.runId) || !SHA256.test(outcome.assignmentBindingSha256)
        || !SHA256.test(outcome.privateBindingSha256)
        || (outcome.executionMode !== "externally-isolated" && outcome.executionMode !== "dry-run")
        || typeof outcome.success !== "boolean" || typeof outcome.criticalIncident !== "boolean"
        || !Number.isSafeInteger(outcome.toolCalls) || outcome.toolCalls < 0
        || !Number.isSafeInteger(outcome.steps) || outcome.steps < 0) {
        throw new Error("Stored execution outcome metadata is invalid.");
    }
    validateRunnerUsage(outcome.usage);
    if (outcome.costUsd !== null && (!Number.isFinite(outcome.costUsd) || outcome.costUsd < 0)) {
        throw new Error("Stored execution cost is invalid.");
    }
    for (const value of [outcome.costEvidenceSha256, outcome.graderEvidenceSha256,
        outcome.artifactEvidenceSha256, outcome.isolation.evidenceSha256]) {
        if (!SHA256.test(value))
            throw new Error("Stored execution evidence digest is malformed.");
    }
    const evaluatorAttestation = outcome.evaluatorAttestation;
    if (evaluatorAttestation.protocolVersion !== 1 || evaluatorAttestation.kind !== "execution-outcome"
        || [evaluatorAttestation.evaluatorId, evaluatorAttestation.keyId,
            evaluatorAttestation.signatureBase64].some((value) => value.trim().length === 0)
        || !SHA256.test(evaluatorAttestation.manifestSha256)
        || !SHA256.test(evaluatorAttestation.statementSha256)
        || !Number.isFinite(Date.parse(evaluatorAttestation.issuedAt))) {
        throw new Error("Stored evaluator outcome attestation is malformed.");
    }
    for (const intervention of outcome.interventions) {
        assertExactKeys(intervention, ["kind", "actorId", "occurredAt", "evidenceSha256"], "intervention evidence");
        if ([intervention.kind, intervention.actorId].some((value) => value.trim().length === 0)
            || !Number.isFinite(Date.parse(intervention.occurredAt)) || !SHA256.test(intervention.evidenceSha256)) {
            throw new Error("Stored intervention evidence is invalid.");
        }
    }
}
function assertExactKeys(value, allowed, name) {
    const expected = new Set(allowed);
    const keys = Object.keys(value);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
        throw new Error(`Unexpected field in ${name}.`);
    }
}
function validateExecutionStateMachine(ledger) {
    const byRun = new Map();
    for (const entry of ledger)
        byRun.set(entry.event.runId, [...(byRun.get(entry.event.runId) ?? []), entry.event]);
    for (const [runId, events] of byRun) {
        let openAttempt = null;
        let completed = false;
        let lastAttempt = 0;
        for (const event of events) {
            if (event.privateBindingSha256 !== events[0].privateBindingSha256
                || event.assignmentBindingSha256 !== events[0].assignmentBindingSha256) {
                throw new Error(`Execution bindings changed mid-run for '${runId}'.`);
            }
            if (event.kind === "execution.started") {
                if (completed || openAttempt !== null || event.attempt !== lastAttempt + 1) {
                    throw new Error(`Invalid execution start transition for '${runId}'.`);
                }
                openAttempt = event.attempt;
                lastAttempt = event.attempt;
            }
            else {
                if (openAttempt !== event.attempt)
                    throw new Error(`Execution terminal event has no matching start for '${runId}'.`);
                openAttempt = null;
                if (event.kind === "execution.completed")
                    completed = true;
            }
        }
    }
}
function eventsFor(ledger, runId) {
    return ledger.filter((entry) => entry.event.runId === runId).map((entry) => entry.event);
}
function executionLedgerHash(previousHash, index, event) {
    return createHash("sha256").update(previousHash).update("\n").update(String(index)).update("\n")
        .update(canonicalCertificationJson(event)).digest("hex");
}
function digest(value) {
    return createHash("sha256").update(canonicalCertificationJson(value)).digest("hex");
}
function deepFreeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
export function certificationEngineExecutionBinding(privateBindingSalt, manifestDigest, publicAssignment, privateAssignment, engine, task, attempt, invocationId) {
    const trackPolicy = engine.trackPolicies[evaluationTrackKey(task)];
    if (trackPolicy === undefined)
        throw new Error(`Engine '${engine.id}' lacks frozen track '${task.category}'.`);
    return createHmac("sha256", privateBindingSalt).update(canonicalCertificationJson({
        manifestSha256: manifestDigest,
        runId: publicAssignment.runId,
        assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
        privateBindingSha256: privateAssignment.privateBindingSha256,
        engine,
        comparisonTrack: task.comparisonTrack,
        category: task.category,
        track: evaluationTrackKey(task),
        trackPolicy,
        taskId: task.id,
        inputBundleSha256: task.inputBundleSha256,
        sourceSha256: task.sourceSha256,
        graderSha256: task.graderSha256,
        attempt,
        invocationId,
    })).digest("hex");
}
export function isolationAttestationStatement(attestation) {
    return {
        runId: attestation.runId,
        manifestSha256: attestation.manifestSha256,
        assignmentBindingSha256: attestation.assignmentBindingSha256,
        privateBindingSha256: attestation.privateBindingSha256,
        engineExecutionBindingSha256: attestation.engineExecutionBindingSha256,
        attempt: attestation.attempt,
        invocationId: attestation.invocationId,
        inputBundleSha256: attestation.inputBundleSha256,
        sourceSha256: attestation.sourceSha256,
        graderSha256: attestation.graderSha256,
        workspaceId: attestation.workspaceId,
        mechanism: attestation.mechanism,
        isolationEvidenceSha256: attestation.isolationEvidenceSha256,
        networkPolicySha256: attestation.networkPolicySha256,
        resourcePolicySha256: attestation.resourcePolicySha256,
        cleanAtStart: attestation.cleanAtStart,
        originalWorkspaceUnmodified: attestation.originalWorkspaceUnmodified,
        readOnlyInputs: attestation.readOnlyInputs,
        noHostCredentials: attestation.noHostCredentials,
        disposableWorkspace: attestation.disposableWorkspace,
        teardownRequired: attestation.teardownRequired,
        issuerId: attestation.issuerId,
        keyId: attestation.keyId,
        issuedAt: attestation.issuedAt,
        expiresAt: attestation.expiresAt,
    };
}
function dryRunAttestation(request, evidenceSha256) {
    const unsigned = {
        runId: request.publicAssignment.runId,
        manifestSha256: request.manifestSha256,
        assignmentBindingSha256: request.publicAssignment.assignmentBindingSha256,
        privateBindingSha256: request.privateAssignment.privateBindingSha256,
        engineExecutionBindingSha256: request.engineExecutionBindingSha256,
        attempt: request.attempt,
        invocationId: request.invocationId,
        inputBundleSha256: request.task.inputBundleSha256,
        sourceSha256: request.task.sourceSha256,
        graderSha256: request.task.graderSha256,
        workspaceId: `dry-${request.publicAssignment.runId.slice(0, 12)}`,
        mechanism: "fake-no-process",
        isolationEvidenceSha256: evidenceSha256,
        networkPolicySha256: evidenceSha256,
        resourcePolicySha256: evidenceSha256,
        cleanAtStart: true,
        originalWorkspaceUnmodified: true,
        readOnlyInputs: true,
        noHostCredentials: true,
        disposableWorkspace: true,
        teardownRequired: true,
        issuerId: "deterministic-dry-run/no-host",
        keyId: "not-a-real-key",
        issuedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "9999-12-31T23:59:59.999Z",
    };
    return {
        ...unsigned,
        statementSha256: digest(unsigned),
        signatureBase64: Buffer.from(evidenceSha256).toString("base64"),
    };
}
function failureEvidence(error) {
    const failure = classifyAdapterFailure(error);
    return digest({ name: error instanceof Error ? error.name : typeof error, code: failure.code });
}
function classifyAdapterFailure(error) {
    if (error instanceof NonRetryableCertificationAdapterError)
        return { code: error.code, retryable: false };
    const code = typeof error?.code === "string"
        ? String(error.code).slice(0, 64) : "adapter-infrastructure-failure";
    return { code, retryable: true };
}
class NonRetryableCertificationAdapterError extends Error {
    code;
    constructor(code) {
        super(`Certification adapter rejected evidence: ${code}.`);
        this.name = "NonRetryableCertificationAdapterError";
        this.code = code;
    }
}
class CertificationRunTimeoutError extends Error {
    constructor() {
        super("Certification run exceeded its frozen timeout.");
        this.name = "CertificationRunTimeoutError";
    }
}
async function withTimeout(start, timeoutMs, parent) {
    let timer;
    let abortListener;
    const controller = new AbortController();
    const operation = start(controller.signal);
    const boundary = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            const error = new CertificationRunTimeoutError();
            controller.abort(error);
            reject(error);
        }, timeoutMs);
        abortListener = () => {
            const reason = parent.reason ?? new Error("Evaluator cancelled certification run.");
            controller.abort(reason);
            reject(reason);
        };
        parent.addEventListener("abort", abortListener, { once: true });
        if (parent.aborted)
            abortListener();
    });
    operation.catch(() => undefined);
    try {
        return await Promise.race([operation, boundary]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        if (abortListener !== undefined)
            parent.removeEventListener("abort", abortListener);
    }
}
async function atomicPrivateJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, file);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
