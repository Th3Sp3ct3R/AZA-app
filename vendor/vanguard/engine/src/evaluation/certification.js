import { createHash, createHmac, createPublicKey, verify as verifySignature } from "node:crypto";
import { compareOrdinal } from "../deterministicText.js";
const AUTHORITY = Symbol("vanguard.external-evaluator-authority");
const GENESIS = "0".repeat(64);
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/u;
export function validateCertificationManifest(manifest) {
    assertExactKeys(manifest, [
        "schemaVersion", "program", "frozenAt", "vanguardCommit", "evaluatorId", "externalEvaluator",
        "repetitions", "minPairedTasks", "minIndependentGroups", "minCategoryIndependentGroups",
        "bootstrapSamples", "seed", "engines", "tasks", "reviewPolicy", "isolationPolicy",
        "evaluatorSigningKey", "thresholds",
    ], "certification manifest");
    if (manifest.schemaVersion !== 3 || manifest.program.trim().length === 0)
        throw new Error("Unsupported certification manifest.");
    if (manifest.seed.trim().length === 0)
        throw new Error("Certification seed cannot be empty.");
    if (!Number.isSafeInteger(manifest.repetitions) || manifest.repetitions < 1 || manifest.repetitions > 20) {
        throw new Error("Certification repetitions must be between 1 and 20.");
    }
    if (!Number.isSafeInteger(manifest.minPairedTasks) || manifest.minPairedTasks < 30) {
        throw new Error("Certification requires at least 30 paired tasks.");
    }
    if (!Number.isSafeInteger(manifest.minIndependentGroups) || manifest.minIndependentGroups < 12) {
        throw new Error("Certification requires at least 12 independent repository groups.");
    }
    if (!Number.isSafeInteger(manifest.minCategoryIndependentGroups) || manifest.minCategoryIndependentGroups < 3) {
        throw new Error("Certification requires at least 3 independent groups per category.");
    }
    if (!Number.isSafeInteger(manifest.bootstrapSamples) || manifest.bootstrapSamples < 1_000) {
        throw new Error("Certification requires at least 1,000 bootstrap samples.");
    }
    if (!manifest.externalEvaluator || manifest.evaluatorId.trim().length === 0) {
        throw new Error("Certification must be frozen and scored by an identified external evaluator.");
    }
    const evaluatorKey = manifest.evaluatorSigningKey;
    assertExactKeys(evaluatorKey, ["evaluatorId", "keyId", "publicKeyPem"], "external evaluator signing key");
    if (evaluatorKey.evaluatorId !== manifest.evaluatorId || evaluatorKey.keyId.trim().length === 0) {
        throw new Error("Certification must freeze the external evaluator signing identity.");
    }
    validateEd25519PublicKey(evaluatorKey.publicKeyPem, "external evaluator");
    const isolationPolicy = manifest.isolationPolicy;
    assertExactKeys(isolationPolicy, ["verifierId", "policyId", "allowedMechanisms", "networkPolicySha256", "resourcePolicySha256", "trustedIssuers"], "isolation policy");
    if ([isolationPolicy.verifierId, isolationPolicy.policyId].some((value) => value.trim().length === 0)
        || isolationPolicy.trustedIssuers.length === 0 || isolationPolicy.allowedMechanisms.length === 0
        || isolationPolicy.allowedMechanisms.some((mechanism) => mechanism.trim().length === 0)
        || !SHA256.test(isolationPolicy.networkPolicySha256) || !SHA256.test(isolationPolicy.resourcePolicySha256)) {
        throw new Error("Certification must freeze an isolation verifier policy and trust roots.");
    }
    unique(isolationPolicy.allowedMechanisms, "isolation mechanism");
    unique(isolationPolicy.trustedIssuers.map((issuer) => issuer.issuerId), "isolation issuer id");
    unique(isolationPolicy.trustedIssuers.map((issuer) => issuer.keyId), "isolation issuer key id");
    const evaluatorSpki = canonicalEd25519Spki(evaluatorKey.publicKeyPem, "external evaluator");
    const isolationSpkis = new Set();
    for (const issuer of isolationPolicy.trustedIssuers) {
        assertExactKeys(issuer, ["issuerId", "keyId", "publicKeyPem"], "trusted isolation issuer");
        if (issuer.keyId.trim().length === 0)
            throw new Error("Isolation issuer key id cannot be empty.");
        validateEd25519PublicKey(issuer.publicKeyPem, `isolation issuer '${issuer.issuerId}'`);
        const issuerSpki = canonicalEd25519Spki(issuer.publicKeyPem, `isolation issuer '${issuer.issuerId}'`);
        if (issuer.issuerId === evaluatorKey.evaluatorId || issuer.keyId === evaluatorKey.keyId
            || issuerSpki === evaluatorSpki) {
            throw new Error("The external evaluator and isolation issuer must use independent identities and Ed25519 keys.");
        }
        if (isolationSpkis.has(issuerSpki)) {
            throw new Error("Trusted isolation issuers must not reuse the same Ed25519 key.");
        }
        isolationSpkis.add(issuerSpki);
    }
    if (!GIT_OBJECT_ID.test(manifest.vanguardCommit))
        throw new Error("Vanguard candidate commit must be a full Git object id.");
    if (!Number.isFinite(Date.parse(manifest.frozenAt)))
        throw new Error("Certification freeze time is invalid.");
    const engines = unique(manifest.engines.map((engine) => engine.id), "engine id");
    if (!engines.includes("vanguard") || engines.length < 3) {
        throw new Error("Certification requires Vanguard and at least two competitor engines.");
    }
    for (const engine of manifest.engines) {
        assertExactKeys(engine, [
            "id", "version", "command", "executableSha256", "environmentSha256", "authMode", "trackPolicies",
        ], "certification engine");
        if ([engine.id, engine.version, engine.command].some((value) => value.trim().length === 0)
            || !SHA256.test(engine.executableSha256) || !SHA256.test(engine.environmentSha256)
            || !["api-key", "oauth", "local"].includes(engine.authMode)) {
            throw new Error(`Engine '${engine.id}' is not fully pinned.`);
        }
    }
    unique(manifest.tasks.map((task) => task.id), "task id");
    for (const task of manifest.tasks) {
        assertExactKeys(task, [
            "id", "layer", "category", "comparisonTrack", "language", "repositoryId", "independenceGroupId",
            "independenceEvidenceSha256", "inputBundleSha256", "sourceSha256", "graderSha256", "maxDurationMs",
            "priorRunCount",
        ], "certification task");
        if (task.id.trim().length === 0 || !["canary", "shadow", "holdout"].includes(task.layer)
            || !["harness-controlled", "product-native"].includes(task.comparisonTrack)) {
            throw new Error("Certification task has an invalid id or evaluation layer.");
        }
        if (!Number.isSafeInteger(task.priorRunCount) || task.priorRunCount < 0) {
            throw new Error(`Task '${task.id}' has an invalid prior-run count.`);
        }
    }
    const holdout = manifest.tasks.filter((task) => task.layer === "holdout");
    if (holdout.length < manifest.minPairedTasks) {
        throw new Error(`Holdout has ${holdout.length} tasks; ${manifest.minPairedTasks} are required.`);
    }
    const comparisonTracks = new Set(holdout.map((task) => task.comparisonTrack));
    if (comparisonTracks.size !== 2 || !comparisonTracks.has("harness-controlled") || !comparisonTracks.has("product-native")) {
        throw new Error("Holdout must include both harness-controlled and product-native comparison tracks.");
    }
    const previouslyVisibleSources = new Set(manifest.tasks.filter((task) => task.layer !== "holdout")
        .map((task) => task.sourceSha256));
    if (holdout.some((task) => previouslyVisibleSources.has(task.sourceSha256))) {
        throw new Error("Holdout reuses a source snapshot from a previously visible evaluation layer.");
    }
    const previouslyVisibleInputs = new Set(manifest.tasks.filter((task) => task.layer !== "holdout")
        .map((task) => task.inputBundleSha256));
    if (holdout.some((task) => previouslyVisibleInputs.has(task.inputBundleSha256))) {
        throw new Error("Holdout reuses an input bundle from a previously visible evaluation layer.");
    }
    const repositoryGroups = new Map();
    const sourceGroups = new Map();
    for (const task of manifest.tasks) {
        if (!SHA256.test(task.inputBundleSha256) || !SHA256.test(task.sourceSha256) || !SHA256.test(task.graderSha256)
            || !SHA256.test(task.independenceEvidenceSha256)) {
            throw new Error(`Task '${task.id}' lacks frozen input/source/grader/independence digests.`);
        }
        if ([task.repositoryId, task.independenceGroupId, task.category, task.language].some((value) => value.trim().length === 0)) {
            throw new Error(`Task '${task.id}' lacks repository/group provenance.`);
        }
        const prior = repositoryGroups.get(task.repositoryId);
        if (prior !== undefined && (prior.groupId !== task.independenceGroupId || prior.evidence !== task.independenceEvidenceSha256)) {
            throw new Error(`Repository '${task.repositoryId}' has inconsistent independence provenance.`);
        }
        repositoryGroups.set(task.repositoryId, { groupId: task.independenceGroupId, evidence: task.independenceEvidenceSha256 });
        const priorSource = sourceGroups.get(task.sourceSha256);
        if (priorSource !== undefined && (priorSource.groupId !== task.independenceGroupId
            || priorSource.evidence !== task.independenceEvidenceSha256)) {
            throw new Error(`Source snapshot '${task.sourceSha256}' is assigned to inconsistent independence groups.`);
        }
        sourceGroups.set(task.sourceSha256, {
            groupId: task.independenceGroupId,
            evidence: task.independenceEvidenceSha256,
        });
        if (!Number.isSafeInteger(task.maxDurationMs) || task.maxDurationMs < 1_000) {
            throw new Error(`Task '${task.id}' has an invalid duration budget.`);
        }
        if (task.layer === "holdout" && task.priorRunCount !== 0) {
            throw new Error(`Holdout task '${task.id}' was already run and is contaminated.`);
        }
    }
    const tracks = new Set(holdout.map(evaluationTrackKey));
    for (const engine of manifest.engines) {
        if (new Set(Object.keys(engine.trackPolicies)).size !== tracks.size
            || [...tracks].some((track) => engine.trackPolicies[track] === undefined)
            || Object.keys(engine.trackPolicies).some((track) => !tracks.has(track))) {
            throw new Error(`Engine '${engine.id}' does not pin exactly the frozen holdout tracks.`);
        }
        for (const [track, policy] of Object.entries(engine.trackPolicies)) {
            assertExactKeys(policy, [
                "provider", "model", "reasoningEffort", "toolCallBudget", "stepBudget", "inputTokenBudget",
                "outputTokenBudget", "commandArguments",
            ], "engine track policy");
            if ([policy.provider, policy.model, policy.reasoningEffort].some((value) => value.trim().length === 0)
                || !Number.isSafeInteger(policy.toolCallBudget) || policy.toolCallBudget < 1
                || !Number.isSafeInteger(policy.stepBudget) || policy.stepBudget < 1
                || !Number.isSafeInteger(policy.inputTokenBudget) || policy.inputTokenBudget < 1
                || !Number.isSafeInteger(policy.outputTokenBudget) || policy.outputTokenBudget < 1
                || !Array.isArray(policy.commandArguments)
                || policy.commandArguments.some((argument) => typeof argument !== "string")) {
                throw new Error(`Engine '${engine.id}' has an unpinned model/effort/tool budget for track '${track}'.`);
            }
        }
    }
    const independentGroups = new Set(holdout.map((task) => task.independenceGroupId));
    if (independentGroups.size < manifest.minIndependentGroups) {
        throw new Error(`Holdout has ${independentGroups.size} independent groups; ${manifest.minIndependentGroups} are required.`);
    }
    for (const category of new Set(holdout.map((task) => task.category))) {
        const groups = new Set(holdout.filter((task) => task.category === category).map((task) => task.independenceGroupId));
        if (groups.size < manifest.minCategoryIndependentGroups) {
            throw new Error(`Category '${category}' has only ${groups.size} independent groups.`);
        }
    }
    const review = manifest.reviewPolicy;
    assertExactKeys(review, ["rubricId", "rubricSha256", "requiredPrimaryReviewers", "disagreementThreshold"], "maintainability review policy");
    if (review.requiredPrimaryReviewers !== 2 || review.rubricId.trim().length === 0 || !SHA256.test(review.rubricSha256)) {
        throw new Error("Maintainability policy must freeze a rubric and require exactly two primary reviewers.");
    }
    if (!Number.isFinite(review.disagreementThreshold) || review.disagreementThreshold <= 0 || review.disagreementThreshold > 1) {
        throw new Error("Maintainability disagreement threshold must be in (0,1].");
    }
    const t = manifest.thresholds;
    assertExactKeys(t, [
        "parityOverallLowerBound", "parityCategoryLowerBound", "superiorityOverallLowerBound",
        "maintainabilityLowerBound", "maxCostRatio", "maxInterventionDelta", "confidence",
    ], "certificate thresholds");
    for (const [name, value] of Object.entries(t)) {
        if (!Number.isFinite(value))
            throw new Error(`Threshold '${name}' is not finite.`);
    }
    for (const comparisonTrack of comparisonTracks) {
        const trackTasks = holdout.filter((task) => task.comparisonTrack === comparisonTrack);
        const trackGroups = new Set(trackTasks.map((task) => task.independenceGroupId));
        if (trackGroups.size < manifest.minIndependentGroups) {
            throw new Error(`Comparison track '${comparisonTrack}' has only ${trackGroups.size} independent groups.`);
        }
        for (const category of new Set(holdout.map((task) => task.category))) {
            const groups = new Set(trackTasks.filter((task) => task.category === category)
                .map((task) => task.independenceGroupId));
            if (groups.size < manifest.minCategoryIndependentGroups) {
                throw new Error(`Comparison track '${comparisonTrack}' category '${category}' has only ${groups.size} independent groups.`);
            }
        }
    }
    for (const category of new Set(holdout.filter((task) => task.comparisonTrack === "harness-controlled")
        .map((task) => task.category))) {
        const key = `harness-controlled:${category}`;
        const baseline = manifest.engines[0].trackPolicies[key];
        for (const engine of manifest.engines.slice(1)) {
            const candidate = engine.trackPolicies[key];
            if (candidate.provider !== baseline.provider || candidate.model !== baseline.model
                || candidate.reasoningEffort !== baseline.reasoningEffort
                || candidate.toolCallBudget !== baseline.toolCallBudget || candidate.stepBudget !== baseline.stepBudget
                || candidate.inputTokenBudget !== baseline.inputTokenBudget || candidate.outputTokenBudget !== baseline.outputTokenBudget) {
                throw new Error(`Harness-controlled track '${category}' does not freeze the same model/effort/budgets for every engine.`);
            }
        }
    }
    if (t.confidence < 0.95 || t.confidence >= 1)
        throw new Error("Confidence must be in [0.95, 1).");
    for (const [name, value] of Object.entries({
        parityOverallLowerBound: t.parityOverallLowerBound,
        parityCategoryLowerBound: t.parityCategoryLowerBound,
        superiorityOverallLowerBound: t.superiorityOverallLowerBound,
        maintainabilityLowerBound: t.maintainabilityLowerBound,
    })) {
        if (value < -1 || value > 1)
            throw new Error(`Difference threshold '${name}' must be in [-1, 1].`);
    }
    if (t.parityOverallLowerBound < -0.1 || t.parityCategoryLowerBound < -0.1
        || t.maintainabilityLowerBound < -0.1) {
        throw new Error("Non-inferiority margins cannot be weaker than -0.10.");
    }
    if (t.superiorityOverallLowerBound <= 0
        || t.superiorityOverallLowerBound <= t.parityOverallLowerBound) {
        throw new Error("Superiority must require a positive margin above the overall parity margin.");
    }
    if (t.maxCostRatio <= 0 || t.maxCostRatio > 2) {
        throw new Error("Maximum cost ratio must be in (0, 2].");
    }
    if (t.maxInterventionDelta > 0) {
        throw new Error("Vanguard cannot require more human interventions than a baseline.");
    }
}
export function manifestSha256(manifest) {
    return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
export function authorizeExternalEvaluator(manifest, evaluatorId) {
    validateCertificationManifest(manifest);
    if (evaluatorId !== manifest.evaluatorId)
        throw new Error("Evaluator authority does not match the frozen manifest.");
    return { evaluatorId, manifestSha256: manifestSha256(manifest), [AUTHORITY]: true };
}
export function createBlindedAssignments(manifest, blindingSecret) {
    validateCertificationManifest(manifest);
    if (Buffer.byteLength(blindingSecret) < 32)
        throw new Error("Blinding secret must contain at least 32 bytes.");
    const digest = manifestSha256(manifest);
    const assignmentKey = createHmac("sha256", blindingSecret)
        .update(`vanguard-certification-assignments\0${manifest.seed}\0${digest}`)
        .digest();
    const privateBindingSalt = createHmac("sha256", blindingSecret)
        .update(`vanguard-certification-private-bindings\0${manifest.seed}\0${digest}`)
        .digest("hex");
    const publicAssignments = [];
    const privateAssignments = [];
    for (const task of manifest.tasks.filter((candidate) => candidate.layer === "holdout")) {
        for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
            const engines = cryptographicShuffle([...manifest.engines], assignmentKey, canonicalJson({ purpose: "engine-permutation", taskId: task.id, repetition }));
            for (const [ordinal, engine] of engines.entries()) {
                const alias = `E${ordinal + 1}`;
                const runId = createHmac("sha256", blindingSecret)
                    .update(`${digest}\0${task.id}\0${repetition}\0${engine.id}`)
                    .digest("hex");
                const core = { runId, taskId: task.id, repetition, alias, ordinal };
                const assignmentBindingSha256 = bindingSha256(digest, core);
                const publicAssignment = { ...core, assignmentBindingSha256 };
                publicAssignments.push(publicAssignment);
                privateAssignments.push({
                    ...publicAssignment,
                    engineId: engine.id,
                    privateBindingSha256: keyedBindingSha256(privateBindingSalt, digest, { ...publicAssignment, engineId: engine.id }),
                });
            }
        }
    }
    return {
        publicArtifact: {
            schemaVersion: 1,
            audience: "public-runners-and-reviewers",
            manifestSha256: digest,
            assignments: cryptographicShuffle(publicAssignments, assignmentKey, canonicalJson({ purpose: "public-assignment-order", manifestSha256: digest })),
        },
        privateArtifact: {
            schemaVersion: 1,
            audience: "external-evaluator-only",
            evaluatorId: manifest.evaluatorId,
            manifestSha256: digest,
            privateBindingSalt,
            assignments: privateAssignments,
        },
    };
}
export function validateAssignmentArtifacts(manifest, publicArtifact, privateArtifact, authority) {
    assertAuthority(manifest, authority);
    const digest = manifestSha256(manifest);
    if (publicArtifact.schemaVersion !== 1 || publicArtifact.audience !== "public-runners-and-reviewers") {
        throw new Error("Invalid public assignment artifact audience.");
    }
    assertExactKeys(publicArtifact, ["schemaVersion", "audience", "manifestSha256", "assignments"], "public assignment artifact");
    if (privateArtifact.schemaVersion !== 1 || privateArtifact.audience !== "external-evaluator-only") {
        throw new Error("Invalid private assignment artifact audience.");
    }
    assertExactKeys(privateArtifact, ["schemaVersion", "audience", "evaluatorId", "manifestSha256", "privateBindingSalt", "assignments"], "private assignment artifact");
    if (publicArtifact.manifestSha256 !== digest || privateArtifact.manifestSha256 !== digest) {
        throw new Error("Assignment artifacts do not match the frozen manifest.");
    }
    if (privateArtifact.evaluatorId !== authority.evaluatorId)
        throw new Error("Private mapping belongs to a different evaluator.");
    if (!SHA256.test(privateArtifact.privateBindingSalt))
        throw new Error("Private assignment binding salt is malformed.");
    const expected = manifest.tasks.filter((task) => task.layer === "holdout").length * manifest.repetitions * manifest.engines.length;
    if (publicArtifact.assignments.length !== expected || privateArtifact.assignments.length !== expected) {
        throw new Error(`Assignment coverage is incomplete: expected ${expected} public/private assignments.`);
    }
    unique(publicArtifact.assignments.map((assignment) => assignment.runId), "public run id");
    unique(privateArtifact.assignments.map((assignment) => assignment.runId), "private run id");
    const privateByRun = new Map(privateArtifact.assignments.map((assignment) => [assignment.runId, assignment]));
    const taskIds = new Set(manifest.tasks.filter((task) => task.layer === "holdout").map((task) => task.id));
    for (const assignment of publicArtifact.assignments) {
        assertExactKeys(assignment, ["runId", "taskId", "repetition", "alias", "ordinal", "assignmentBindingSha256"], "public assignment");
        validatePublicAssignment(digest, assignment, taskIds, manifest);
        const privateAssignment = privateByRun.get(assignment.runId);
        if (privateAssignment === undefined || !samePublicAssignment(assignment, privateAssignment)) {
            throw new Error(`Public/private mapping mismatch for '${assignment.runId}'.`);
        }
        const expectedPrivate = keyedBindingSha256(privateArtifact.privateBindingSalt, digest, { ...assignment, engineId: privateAssignment.engineId });
        if (privateAssignment.privateBindingSha256 !== expectedPrivate) {
            throw new Error(`Private assignment binding mismatch for '${assignment.runId}'.`);
        }
    }
    const engineIds = new Set(manifest.engines.map((engine) => engine.id));
    for (const assignment of privateArtifact.assignments) {
        assertExactKeys(assignment, ["runId", "taskId", "repetition", "alias", "ordinal", "assignmentBindingSha256", "engineId", "privateBindingSha256"], "private assignment");
        if (!engineIds.has(assignment.engineId))
            throw new Error(`Unknown engine '${assignment.engineId}' in private mapping.`);
    }
    for (const task of manifest.tasks.filter((candidate) => candidate.layer === "holdout")) {
        for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
            const group = privateArtifact.assignments.filter((assignment) => assignment.taskId === task.id && assignment.repetition === repetition);
            if (new Set(group.map((assignment) => assignment.engineId)).size !== manifest.engines.length
                || new Set(group.map((assignment) => assignment.alias)).size !== manifest.engines.length) {
                throw new Error(`Assignment engine/alias coverage failed for '${task.id}' repetition ${repetition}.`);
            }
        }
    }
}
export function appendCertificationResult(manifest, ledger, result) {
    validateBlindRunResult(manifest, result);
    if (ledger.some((entry) => entry.result.runId === result.runId))
        throw new Error(`Duplicate result for run '${result.runId}'.`);
    validateCertificationLedger(manifest, ledger);
    const previousHash = ledger.at(-1)?.hash ?? GENESIS;
    const index = ledger.length + 1;
    const hash = ledgerHash(previousHash, index, result);
    return [...ledger, { index, previousHash, hash, result }];
}
export function validateCertificationLedger(manifest, ledger) {
    let previousHash = GENESIS;
    for (const [offset, entry] of ledger.entries()) {
        assertExactKeys(entry, ["index", "previousHash", "hash", "result"], "certification result ledger entry");
        if (entry.index !== offset + 1 || entry.previousHash !== previousHash
            || entry.hash !== ledgerHash(previousHash, entry.index, entry.result)) {
            throw new Error(`Certification ledger integrity failure at entry ${offset + 1}.`);
        }
        validateBlindRunResult(manifest, entry.result);
        previousHash = entry.hash;
    }
}
export function evaluateCertificate(manifest, publicArtifact, privateArtifact, ledger, executionProofs, authority) {
    const blockers = [];
    try {
        validateCertificationManifest(manifest);
    }
    catch (error) {
        blockers.push(message(error));
    }
    const digest = manifestSha256(manifest);
    try {
        validateAssignmentArtifacts(manifest, publicArtifact, privateArtifact, authority);
    }
    catch (error) {
        blockers.push(message(error));
    }
    try {
        validateCertificationLedger(manifest, ledger);
    }
    catch (error) {
        blockers.push(message(error));
    }
    for (const proof of executionProofs) {
        try {
            validateExecutionProof(proof);
        }
        catch (error) {
            blockers.push(message(error));
        }
    }
    const byRun = new Map(ledger.map((entry) => [entry.result.runId, entry.result]));
    if (new Set(executionProofs.map((proof) => proof.runId)).size !== executionProofs.length) {
        blockers.push("Duplicate external execution proof.");
    }
    const proofByRun = new Map(executionProofs.map((proof) => [proof.runId, proof]));
    const privateByRun = new Map(privateArtifact.assignments.map((assignment) => [assignment.runId, assignment]));
    for (const assignment of publicArtifact.assignments) {
        const result = byRun.get(assignment.runId);
        if (result === undefined) {
            blockers.push(`Missing result for ${assignment.runId}.`);
            continue;
        }
        if (result.taskId !== assignment.taskId || result.repetition !== assignment.repetition || result.alias !== assignment.alias
            || result.assignmentBindingSha256 !== assignment.assignmentBindingSha256) {
            blockers.push(`Blinded result metadata mismatch for ${assignment.runId}.`);
        }
        if (result.evaluatorId !== manifest.evaluatorId)
            blockers.push(`Result ${assignment.runId} came from a different evaluator.`);
        if (result.costUsd === null)
            blockers.push(`Result ${assignment.runId} lacks complete cost evidence.`);
        if (!hasCompleteProviderUsage(result.usage)) {
            blockers.push(`Result ${assignment.runId} lacks complete provider-reported usage evidence.`);
        }
        const proof = proofByRun.get(assignment.runId);
        if (proof === undefined) {
            blockers.push(`Missing external execution proof for ${assignment.runId}.`);
        }
        else if (!resultMatchesExecution(result, proof)) {
            blockers.push(`Reviewed result does not match external execution evidence for ${assignment.runId}.`);
        }
    }
    for (const result of byRun.values()) {
        if (result.criticalIncident)
            blockers.push(`Critical incident in run ${result.runId}.`);
        if (!privateByRun.has(result.runId))
            blockers.push(`Unassigned result ${result.runId}.`);
    }
    if (byRun.size !== publicArtifact.assignments.length)
        blockers.push("Result count does not equal the blinded assignment count.");
    if (proofByRun.size !== publicArtifact.assignments.length)
        blockers.push("Execution proof count does not equal the blinded assignment count.");
    if (blockers.length > 0) {
        return { manifestSha256: digest, outcome: "not-certifiable", certifiable: false, comparisons: [], blockers: [...new Set(blockers)] };
    }
    const unblinded = privateArtifact.assignments.map((assignment) => {
        const task = manifest.tasks.find((candidate) => candidate.id === assignment.taskId);
        return { ...assignment, result: byRun.get(assignment.runId), task };
    });
    const competitors = manifest.engines.map((engine) => engine.id).filter((id) => id !== "vanguard");
    const comparisons = competitors.map((competitor) => compareEngine(manifest, unblinded, competitor));
    const allParity = comparisons.every((comparison) => comparison.parity);
    const allSuperiority = comparisons.every((comparison) => comparison.superiority);
    const anySuperiority = comparisons.some((comparison) => comparison.superiority);
    const outcome = allSuperiority
        ? "overall-superiority"
        : allParity && anySuperiority
            ? "parity-with-scoped-superiority"
            : allParity ? "overall-parity" : "none";
    return { manifestSha256: digest, outcome, certifiable: true, comparisons, blockers: [] };
}
function resultMatchesExecution(result, proof) {
    return proof.executionMode === "externally-isolated"
        && result.runId === proof.runId
        && result.assignmentBindingSha256 === proof.assignmentBindingSha256
        && result.executionEvidenceSha256 === proof.executionEvidenceSha256
        && result.success === proof.success
        && result.interventions === proof.interventions
        && canonicalJson(result.usage) === canonicalJson(proof.usage)
        && result.costUsd === proof.costUsd
        && result.durationMs === proof.durationMs
        && result.criticalIncident === proof.criticalIncident
        && SHA256.test(proof.isolationVerificationEvidenceSha256);
}
function validateExecutionProof(proof) {
    assertExactKeys(proof, [
        "runId", "assignmentBindingSha256", "executionEvidenceSha256", "executionMode", "success", "interventions",
        "usage", "costUsd", "durationMs", "criticalIncident", "isolationVerificationEvidenceSha256",
    ], "certification execution proof");
    assertExactKeys(proof.usage, ["inputTokens", "outputTokens", "cachedInputTokens", "providerReported", "evidenceSha256"], "execution proof usage");
    if (!SHA256.test(proof.runId) || !SHA256.test(proof.assignmentBindingSha256)
        || !SHA256.test(proof.executionEvidenceSha256) || !SHA256.test(proof.isolationVerificationEvidenceSha256)
        || proof.executionMode !== "externally-isolated" || typeof proof.success !== "boolean"
        || typeof proof.criticalIncident !== "boolean" || !Number.isSafeInteger(proof.interventions) || proof.interventions < 0
        || !Number.isSafeInteger(proof.durationMs) || proof.durationMs < 0
        || proof.costUsd === null || !Number.isFinite(proof.costUsd) || proof.costUsd < 0) {
        throw new Error("Certification execution proof is malformed or incomplete.");
    }
    validateUsage(proof.usage);
}
function compareEngine(manifest, runs, competitor) {
    const vanguard = new Map(runs.filter((run) => run.engineId === "vanguard")
        .map((run) => [`${run.taskId}:${run.repetition}`, run]));
    const pairs = runs.filter((run) => run.engineId === competitor)
        .map((other) => ({ vanguard: vanguard.get(`${other.taskId}:${other.repetition}`), other }))
        .filter((pair) => pair.vanguard !== undefined);
    const reasons = [];
    const pairedTasks = new Set(pairs.map((pair) => pair.other.taskId)).size;
    const pairedRepositories = new Set(pairs.map((pair) => pair.other.task.repositoryId)).size;
    const independentGroups = new Set(pairs.map((pair) => pair.other.task.independenceGroupId)).size;
    if (pairedTasks < manifest.minPairedTasks)
        reasons.push(`Only ${pairedTasks} paired tasks; ${manifest.minPairedTasks} required.`);
    if (independentGroups < manifest.minIndependentGroups) {
        reasons.push(`Only ${independentGroups} independent groups; ${manifest.minIndependentGroups} required.`);
    }
    const success = clusterBootstrapDifference(pairs.map((pair) => observation(pair.other, Number(pair.vanguard.result.success) - Number(pair.other.result.success))), manifest, `success:${competitor}`);
    const maintainability = clusterBootstrapDifference(pairs.map((pair) => observation(pair.other, maintainabilityScore(manifest, pair.vanguard.result) - maintainabilityScore(manifest, pair.other.result))), manifest, `maintainability:${competitor}`);
    const categories = {};
    for (const category of new Set(pairs.map((pair) => pair.other.task.category))) {
        const categoryPairs = pairs.filter((pair) => pair.other.task.category === category);
        categories[category] = clusterBootstrapDifference(categoryPairs.map((pair) => observation(pair.other, Number(pair.vanguard.result.success) - Number(pair.other.result.success))), manifest, `category:${competitor}:${category}`);
    }
    const comparisonTracks = Object.fromEntries(["harness-controlled", "product-native"].map((track) => [
        track,
        compareTrack(manifest, pairs, competitor, track),
    ]));
    for (const [track, comparison] of Object.entries(comparisonTracks)) {
        reasons.push(...comparison.reasons.map((reason) => `Comparison track '${track}': ${reason}`));
    }
    const interventionDelta = groupedEstimate(pairs.map((pair) => observation(pair.other, pair.vanguard.result.interventions - pair.other.result.interventions)));
    const vanguardCost = sumKnown(pairs.map((pair) => pair.vanguard.result.costUsd));
    const competitorCost = sumKnown(pairs.map((pair) => pair.other.result.costUsd));
    const costRatio = vanguardCost === null || competitorCost === null || competitorCost === 0
        ? null : vanguardCost / competitorCost;
    const t = manifest.thresholds;
    if (success.lower <= t.parityOverallLowerBound)
        reasons.push("Overall success parity lower bound was missed.");
    if (maintainability.lower <= t.maintainabilityLowerBound)
        reasons.push("Maintainability non-inferiority was missed.");
    for (const [category, interval] of Object.entries(categories)) {
        if (interval.samples < manifest.minCategoryIndependentGroups) {
            reasons.push(`Category '${category}' lacks independent-group coverage.`);
        }
        else if (interval.lower <= t.parityCategoryLowerBound)
            reasons.push(`Category '${category}' missed non-inferiority.`);
    }
    if (interventionDelta > t.maxInterventionDelta)
        reasons.push("Human intervention delta exceeded the threshold.");
    if (costRatio !== null && costRatio > t.maxCostRatio)
        reasons.push("Cost ratio exceeded the threshold.");
    if (costRatio === null)
        reasons.push("Cost parity could not be computed from complete provider usage.");
    const parity = reasons.length === 0;
    const superiority = parity && success.lower >= t.superiorityOverallLowerBound;
    return {
        competitor,
        pairedTasks,
        pairedRepositories,
        independentGroups,
        successDifference: success,
        maintainabilityDifference: maintainability,
        categorySuccess: categories,
        comparisonTracks,
        interventionDelta: round6(interventionDelta),
        costRatio: costRatio === null ? null : round6(costRatio),
        parity,
        superiority,
        reasons,
    };
}
function compareTrack(manifest, pairs, competitor, track) {
    const trackPairs = pairs.filter((pair) => pair.other.task.comparisonTrack === track);
    const independentGroups = new Set(trackPairs.map((pair) => pair.other.task.independenceGroupId)).size;
    const success = clusterBootstrapDifference(trackPairs.map((pair) => observation(pair.other, Number(pair.vanguard.result.success) - Number(pair.other.result.success))), manifest, `comparison-track:success:${competitor}:${track}`);
    const maintainability = clusterBootstrapDifference(trackPairs.map((pair) => observation(pair.other, maintainabilityScore(manifest, pair.vanguard.result) - maintainabilityScore(manifest, pair.other.result))), manifest, `comparison-track:maintainability:${competitor}:${track}`);
    const categories = {};
    for (const category of new Set(trackPairs.map((pair) => pair.other.task.category))) {
        const categoryPairs = trackPairs.filter((pair) => pair.other.task.category === category);
        categories[category] = clusterBootstrapDifference(categoryPairs.map((pair) => observation(pair.other, Number(pair.vanguard.result.success) - Number(pair.other.result.success))), manifest, `comparison-track:category:${competitor}:${track}:${category}`);
    }
    const interventionDelta = groupedEstimate(trackPairs.map((pair) => observation(pair.other, pair.vanguard.result.interventions - pair.other.result.interventions)));
    const vanguardCost = sumKnown(trackPairs.map((pair) => pair.vanguard.result.costUsd));
    const competitorCost = sumKnown(trackPairs.map((pair) => pair.other.result.costUsd));
    const costRatio = vanguardCost === null || competitorCost === null || competitorCost === 0
        ? null : vanguardCost / competitorCost;
    const reasons = [];
    const thresholds = manifest.thresholds;
    if (independentGroups < manifest.minIndependentGroups)
        reasons.push("insufficient independent-group coverage");
    if (success.lower <= thresholds.parityOverallLowerBound)
        reasons.push("success non-inferiority was missed");
    if (maintainability.lower <= thresholds.maintainabilityLowerBound)
        reasons.push("maintainability non-inferiority was missed");
    for (const [category, interval] of Object.entries(categories)) {
        if (interval.samples < manifest.minCategoryIndependentGroups) {
            reasons.push(`category '${category}' lacks independent-group coverage`);
        }
        else if (interval.lower <= thresholds.parityCategoryLowerBound) {
            reasons.push(`category '${category}' missed non-inferiority`);
        }
    }
    if (interventionDelta > thresholds.maxInterventionDelta)
        reasons.push("human intervention delta exceeded the threshold");
    if (costRatio === null)
        reasons.push("cost parity could not be computed");
    else if (costRatio > thresholds.maxCostRatio)
        reasons.push("cost ratio exceeded the threshold");
    return {
        independentGroups,
        successDifference: success,
        maintainabilityDifference: maintainability,
        categorySuccess: categories,
        interventionDelta: round6(interventionDelta),
        costRatio: costRatio === null ? null : round6(costRatio),
        parity: reasons.length === 0,
        reasons,
    };
}
function observation(run, difference) {
    return {
        taskId: run.taskId,
        repositoryId: run.task.repositoryId,
        groupId: run.task.independenceGroupId,
        repetition: run.repetition,
        category: run.task.category,
        comparisonTrack: run.task.comparisonTrack,
        difference,
    };
}
function clusterBootstrapDifference(observations, manifest, salt) {
    if (observations.length === 0)
        return { estimate: 0, lower: -1, upper: 1, samples: 0, pairedTasks: 0, pairedRuns: 0 };
    const groups = groupedValues(observations);
    const values = [...groups.values()];
    const rng = seededRandom(`${manifest.seed}:${salt}`);
    const draws = [];
    for (let sample = 0; sample < manifest.bootstrapSamples; sample += 1) {
        let total = 0;
        for (let index = 0; index < values.length; index += 1) {
            total += values[Math.floor(rng() * values.length)];
        }
        draws.push(total / values.length);
    }
    draws.sort((a, b) => a - b);
    const alpha = (1 - manifest.thresholds.confidence) / 2;
    return {
        estimate: round6(mean(values)),
        lower: round6(draws[Math.floor(alpha * (draws.length - 1))]),
        upper: round6(draws[Math.ceil((1 - alpha) * (draws.length - 1))]),
        samples: values.length,
        pairedTasks: new Set(observations.map((item) => item.taskId)).size,
        pairedRuns: observations.length,
    };
}
function groupedEstimate(observations) {
    return mean([...groupedValues(observations).values()]);
}
function groupedValues(observations) {
    const taskValues = new Map();
    const taskGroups = new Map();
    for (const item of observations) {
        const key = `${item.repositoryId}\0${item.taskId}`;
        taskValues.set(key, [...(taskValues.get(key) ?? []), item.difference]);
        taskGroups.set(key, item.groupId);
    }
    const groupTasks = new Map();
    for (const [task, repetitions] of taskValues) {
        const group = taskGroups.get(task);
        groupTasks.set(group, [...(groupTasks.get(group) ?? []), mean(repetitions)]);
    }
    return new Map([...groupTasks].map(([group, tasks]) => [group, mean(tasks)]));
}
export function estimateCertificationCost(manifest, assumptions) {
    const holdoutTasks = manifest.tasks.filter((task) => task.layer === "holdout").length;
    const missingEngines = manifest.engines.filter((engine) => assumptions[engine.id] === undefined).map((engine) => engine.id);
    const estimatedUsd = manifest.engines.reduce((sum, engine) => sum + (assumptions[engine.id]?.meanCostPerTaskUsd ?? 0) * holdoutTasks * manifest.repetitions, 0);
    return {
        runs: holdoutTasks * manifest.engines.length * manifest.repetitions,
        estimatedUsd: round6(estimatedUsd),
        missingEngines,
    };
}
export function maintainabilityScore(manifest, result) {
    validateMaintainability(manifest, result);
    const reviews = result.maintainability.primaryReviews;
    const disagreement = Math.abs(reviews[0].score - reviews[1].score);
    return disagreement > manifest.reviewPolicy.disagreementThreshold
        ? result.maintainability.adjudication.score
        : mean(reviews.map((review) => review.score));
}
export function evaluationTrackKey(task) {
    return `${task.comparisonTrack}:${task.category}`;
}
function validateBlindRunResult(manifest, result) {
    assertExactKeys(result, [
        "runId", "taskId", "repetition", "alias", "assignmentBindingSha256", "executionEvidenceSha256",
        "executionMode", "success", "maintainability", "interventions", "usage", "costUsd", "durationMs",
        "criticalIncident", "evaluatorId", "evaluatorAttestation",
    ], "blinded reviewed result");
    assertExactKeys(result.maintainability, ["primaryReviews", "adjudication"], "maintainability assessment");
    assertExactKeys(result.usage, ["inputTokens", "outputTokens", "cachedInputTokens", "providerReported", "evidenceSha256"], "usage evidence");
    assertExactKeys(result.evaluatorAttestation, [
        "protocolVersion", "kind", "evaluatorId", "keyId", "manifestSha256", "issuedAt", "statementSha256",
        "signatureBase64",
    ], "evaluator evidence attestation");
    if (!SHA256.test(result.runId) || !SHA256.test(result.assignmentBindingSha256)
        || !SHA256.test(result.executionEvidenceSha256))
        throw new Error("Certification result has malformed evidence binding.");
    if (result.executionMode !== "externally-isolated") {
        throw new Error("Dry/local execution evidence cannot enter the certification result ledger.");
    }
    if (!Number.isSafeInteger(result.interventions) || result.interventions < 0)
        throw new Error("Interventions must be non-negative.");
    if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 0)
        throw new Error("Duration must be a non-negative integer.");
    if (result.costUsd !== null && (!Number.isFinite(result.costUsd) || result.costUsd < 0))
        throw new Error("Cost must be null or non-negative.");
    validateUsage(result.usage);
    validateMaintainability(manifest, result);
    const attestedAt = Date.parse(result.evaluatorAttestation.issuedAt);
    const evidenceTimes = [
        ...result.maintainability.primaryReviews.map((review) => Date.parse(review.submittedAt)),
        ...(result.maintainability.adjudication === null
            ? []
            : [Date.parse(result.maintainability.adjudication.submittedAt)]),
    ];
    if (evidenceTimes.some((submittedAt) => submittedAt > attestedAt)) {
        throw new Error("Reviewed-result attestation predates its maintainability evidence.");
    }
    verifyEvaluatorEvidenceAttestation(manifest, result.evaluatorAttestation, blindRunResultStatement(result), "reviewed-result");
}
function validateMaintainability(manifest, result) {
    const reviews = result.maintainability.primaryReviews;
    if (reviews.length !== manifest.reviewPolicy.requiredPrimaryReviewers) {
        throw new Error("Each result requires exactly two primary maintainability reviews.");
    }
    unique(reviews.map((review) => review.reviewerId), "maintainability reviewer");
    const forbidden = new Set([manifest.evaluatorId, ...manifest.engines.map((engine) => engine.id)]);
    for (const review of reviews) {
        assertExactKeys(review, [
            "runId", "reviewerId", "score", "rubricSha256", "evidenceSha256", "conflictDisclosureSha256",
            "submittedAt", "blinded", "independent",
        ], "maintainability review");
        if (review.runId !== result.runId || review.blinded !== true || review.independent !== true) {
            throw new Error("Maintainability review is not independently blinded and run-bound.");
        }
        if (forbidden.has(review.reviewerId) || review.reviewerId.trim().length === 0) {
            throw new Error("Maintainability reviewer is not independent of evaluator/engines.");
        }
        if (!validScore(review.score) || review.rubricSha256 !== manifest.reviewPolicy.rubricSha256
            || !SHA256.test(review.evidenceSha256) || !SHA256.test(review.conflictDisclosureSha256)
            || !Number.isFinite(Date.parse(review.submittedAt))) {
            throw new Error("Maintainability review lacks valid frozen-rubric evidence.");
        }
    }
    const disagreement = Math.abs(reviews[0].score - reviews[1].score);
    const adjudication = result.maintainability.adjudication;
    if (disagreement > manifest.reviewPolicy.disagreementThreshold && adjudication === null) {
        throw new Error("Maintainability disagreement requires blinded independent adjudication evidence.");
    }
    if (disagreement <= manifest.reviewPolicy.disagreementThreshold && adjudication !== null) {
        throw new Error("Maintainability adjudication is only permitted for material reviewer disagreement.");
    }
    if (adjudication !== null) {
        assertExactKeys(adjudication, [
            "runId", "adjudicatorId", "score", "evidenceSha256", "rationale", "submittedAt", "blinded", "independent",
        ], "maintainability adjudication");
        if (adjudication.runId !== result.runId || adjudication.blinded !== true || adjudication.independent !== true
            || forbidden.has(adjudication.adjudicatorId) || reviews.some((review) => review.reviewerId === adjudication.adjudicatorId)
            || !validScore(adjudication.score) || !SHA256.test(adjudication.evidenceSha256)
            || adjudication.rationale.trim().length === 0 || !Number.isFinite(Date.parse(adjudication.submittedAt))) {
            throw new Error("Maintainability adjudication lacks independent blinded evidence.");
        }
    }
}
function validateUsage(usage) {
    for (const value of [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens]) {
        if (value !== null && (!Number.isSafeInteger(value) || value < 0))
            throw new Error("Usage tokens must be null or non-negative integers.");
    }
    if (typeof usage.providerReported !== "boolean" || !SHA256.test(usage.evidenceSha256)) {
        throw new Error("Usage evidence digest/provider flag is malformed.");
    }
    if (usage.providerReported && (usage.inputTokens === null || usage.outputTokens === null)) {
        throw new Error("Provider-reported usage cannot omit input/output token counts.");
    }
}
function validatePublicAssignment(digest, assignment, taskIds, manifest) {
    if (!SHA256.test(assignment.runId) || !taskIds.has(assignment.taskId)
        || !Number.isSafeInteger(assignment.repetition) || assignment.repetition < 1 || assignment.repetition > manifest.repetitions
        || !Number.isSafeInteger(assignment.ordinal) || assignment.ordinal < 0 || assignment.ordinal >= manifest.engines.length
        || assignment.alias !== `E${assignment.ordinal + 1}`) {
        throw new Error(`Malformed public assignment '${assignment.runId}'.`);
    }
    const { assignmentBindingSha256: _ignored, ...core } = assignment;
    if (assignment.assignmentBindingSha256 !== bindingSha256(digest, core)) {
        throw new Error(`Public assignment binding mismatch for '${assignment.runId}'.`);
    }
}
function assertAuthority(manifest, authority) {
    if (authority[AUTHORITY] !== true || authority.evaluatorId !== manifest.evaluatorId
        || authority.manifestSha256 !== manifestSha256(manifest)) {
        throw new Error("External evaluator authority is invalid for this manifest.");
    }
}
function samePublicAssignment(left, right) {
    return left.runId === right.runId && left.taskId === right.taskId && left.repetition === right.repetition
        && left.alias === right.alias && left.ordinal === right.ordinal
        && left.assignmentBindingSha256 === right.assignmentBindingSha256;
}
function bindingSha256(manifestDigest, value) {
    return createHash("sha256").update(manifestDigest).update("\n").update(canonicalJson(value)).digest("hex");
}
function hasCompleteProviderUsage(usage) {
    return usage.providerReported === true && usage.inputTokens !== null
        && usage.outputTokens !== null && usage.cachedInputTokens !== null;
}
function keyedBindingSha256(key, manifestDigest, value) {
    return createHmac("sha256", key).update(manifestDigest).update("\n")
        .update(canonicalJson(value)).digest("hex");
}
function ledgerHash(previousHash, index, result) {
    return createHash("sha256").update(previousHash).update("\n").update(String(index)).update("\n")
        .update(canonicalJson(result)).digest("hex");
}
export function canonicalCertificationJson(value) {
    return canonicalJson(value);
}
export function blindRunResultStatement(result) {
    const { evaluatorAttestation: _attestation, ...statement } = result;
    return statement;
}
export function verifyEvaluatorEvidenceAttestation(manifest, attestation, statement, expectedKind) {
    const key = manifest.evaluatorSigningKey;
    if (attestation.protocolVersion !== 1 || attestation.kind !== expectedKind
        || attestation.evaluatorId !== manifest.evaluatorId || attestation.evaluatorId !== key.evaluatorId
        || attestation.keyId !== key.keyId || attestation.manifestSha256 !== manifestSha256(manifest)
        || !Number.isFinite(Date.parse(attestation.issuedAt))
        || Date.parse(attestation.issuedAt) < Date.parse(manifest.frozenAt)
        || !SHA256.test(attestation.statementSha256) || attestation.signatureBase64.trim().length === 0) {
        throw new Error("External evaluator evidence attestation is not bound to the frozen manifest/key.");
    }
    const serialized = canonicalJson(statement);
    const envelope = canonicalJson(evaluatorEvidenceSigningEnvelope(attestation));
    if (attestation.statementSha256 !== createHash("sha256").update(serialized).digest("hex")
        || !verifySignature(null, Buffer.from(envelope), key.publicKeyPem, Buffer.from(attestation.signatureBase64, "base64"))) {
        throw new Error("External evaluator evidence signature is invalid.");
    }
}
export function evaluatorEvidenceSigningEnvelope(attestation) {
    return {
        protocol: "vanguard-certification-evaluator-evidence",
        protocolVersion: attestation.protocolVersion,
        kind: attestation.kind,
        manifestSha256: attestation.manifestSha256,
        evaluatorId: attestation.evaluatorId,
        keyId: attestation.keyId,
        issuedAt: attestation.issuedAt,
        statementSha256: attestation.statementSha256,
    };
}
function canonicalJson(value) {
    return JSON.stringify(value, (_key, item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item))
            return item;
        return Object.fromEntries(Object.entries(item).sort(([left], [right]) => compareOrdinal(left, right)));
    });
}
function seededRandom(seed) {
    let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
    };
}
function unique(values, name) {
    const result = [...new Set(values)];
    if (result.length !== values.length)
        throw new Error(`Duplicate ${name}.`);
    return result;
}
function cryptographicShuffle(values, key, domain) {
    const shuffledValues = [...values];
    let counter = 0n;
    const randomBelow = (exclusiveMaximum) => {
        if (exclusiveMaximum <= 1)
            return 0;
        const modulus = BigInt(exclusiveMaximum);
        const range = 1n << 64n;
        const rejectionLimit = range - range % modulus;
        for (;;) {
            const counterBytes = Buffer.alloc(8);
            counterBytes.writeBigUInt64BE(counter);
            counter += 1n;
            const block = createHmac("sha256", key)
                .update("vanguard-certification-shuffle-v1\0")
                .update(domain)
                .update("\0")
                .update(counterBytes)
                .digest();
            for (let offset = 0; offset < block.length; offset += 8) {
                const candidate = block.readBigUInt64BE(offset);
                if (candidate < rejectionLimit)
                    return Number(candidate % modulus);
            }
        }
    };
    for (let index = shuffledValues.length - 1; index > 0; index -= 1) {
        const other = randomBelow(index + 1);
        [shuffledValues[index], shuffledValues[other]] = [shuffledValues[other], shuffledValues[index]];
    }
    return shuffledValues;
}
function assertExactKeys(value, allowed, name) {
    const expected = new Set(allowed);
    const keys = Object.keys(value);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
        throw new Error(`Unexpected field in ${name}.`);
    }
}
function validateEd25519PublicKey(publicKeyPem, name) {
    try {
        const key = createPublicKey(publicKeyPem);
        if (key.asymmetricKeyType !== "ed25519")
            throw new Error("wrong key type");
    }
    catch {
        throw new Error(`Certification ${name} key must be a valid Ed25519 public key.`);
    }
}
function canonicalEd25519Spki(publicKeyPem, name) {
    try {
        const key = createPublicKey(publicKeyPem);
        if (key.asymmetricKeyType !== "ed25519")
            throw new Error("wrong key type");
        return key.export({ type: "spki", format: "der" }).toString("hex");
    }
    catch {
        throw new Error(`Certification ${name} key must be a valid Ed25519 public key.`);
    }
}
function validScore(value) {
    return Number.isFinite(value) && value >= 0 && value <= 1;
}
function mean(values) {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function sumKnown(values) {
    return values.some((value) => value === null) ? null : values.reduce((sum, value) => sum + (value ?? 0), 0);
}
function round6(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
