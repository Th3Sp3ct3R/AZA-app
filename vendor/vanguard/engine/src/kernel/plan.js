import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLAN_TOOL_NAME } from "./contracts.js";
import { durableStateSha256 } from "./durableState.js";
import { journalWorkspaceGeneration, validWorkspaceGeneration } from "./evidenceAuthority.js";
import { logicalRunEvents } from "./logicalHistory.js";
export class JournalEvidenceResolver {
    journal;
    constructor(journal) {
        this.journal = journal;
    }
    async resolve(claim) {
        return this.#resolve(claim, true);
    }
    async revalidate(reference) {
        return this.#resolve(reference, false);
    }
    async eligibleToolEvidence(limit = 8) {
        const auditEvents = await this.journal.readValidated();
        const events = logicalRunEvents(auditEvents);
        const candidates = [];
        for (const event of [...events].reverse()) {
            const data = eligibleToolData(event, auditEvents, true);
            if (data === undefined || typeof data.evidenceId !== "string" || typeof data.tool !== "string")
                continue;
            candidates.push({
                evidenceId: data.evidenceId,
                tool: data.tool,
                evidenceAuthority: data.evidenceAuthority,
            });
            if (candidates.length >= limit)
                break;
        }
        return candidates;
    }
    async #resolve(claim, requireCurrent) {
        const auditEvents = await this.journal.readValidated();
        const events = logicalRunEvents(auditEvents);
        const latestUser = [...events].reverse().find((event) => event.type === "user.message");
        if (claim.kind === "tool") {
            let event;
            if (claim.sequence !== undefined) {
                const exactSequence = events.find((candidate) => candidate.sequence === claim.sequence);
                if (exactSequence === undefined)
                    return undefined;
                const data = eligibleToolData(exactSequence, auditEvents, requireCurrent);
                if (data === undefined)
                    return undefined;
                if (claim.evidenceId !== undefined && data.evidenceId !== claim.evidenceId)
                    return undefined;
                if (claim.callId !== undefined && data.callId !== claim.callId)
                    return undefined;
                event = exactSequence;
            }
            else if (typeof claim.evidenceId === "string") {
                const matches = events.filter((candidate) => eligibleToolData(candidate, auditEvents, requireCurrent)?.evidenceId === claim.evidenceId);
                if (matches.length !== 1)
                    return undefined;
                event = matches[0];
            }
            else if (typeof claim.callId === "string") {
                const terminal = [...events].reverse().find((candidate) => {
                    if (candidate.type !== "tool.completed" && candidate.type !== "tool.failed")
                        return false;
                    return record(candidate.data)?.callId === claim.callId;
                });
                if (terminal === undefined || eligibleToolData(terminal, auditEvents, requireCurrent) === undefined)
                    return undefined;
                event = terminal;
            }
            else {
                return undefined;
            }
            if (event === undefined)
                return undefined;
            const data = eligibleToolData(event, auditEvents, requireCurrent);
            if (data === undefined)
                return undefined;
            return canonicalEvidence({
                kind: "tool",
                ...(typeof data.evidenceId === "string" ? { evidenceId: data.evidenceId } : {}),
                callId: data.callId,
                tool: data.tool,
                evidenceAuthority: data.evidenceAuthority,
                workspaceGeneration: data.workspaceGeneration,
            }, event);
        }
        const candidates = claim.sequence === undefined
            ? [...events].reverse()
            : events.filter((event) => event.sequence === claim.sequence);
        for (const event of candidates) {
            const data = record(event.data);
            if (claim.kind === "verification") {
                if (event.type !== "verification.completed" || data?.passed !== true)
                    continue;
                if (typeof claim.verifier !== "string" || data?.verifier !== claim.verifier)
                    continue;
                const workspaceGeneration = eligibleWorkspaceGeneration(event, auditEvents, requireCurrent);
                if (workspaceGeneration === undefined)
                    continue;
                return canonicalEvidence({ ...claim, workspaceGeneration }, event);
            }
            if (claim.kind === "user") {
                if (event.type !== "user.message")
                    continue;
                if (claim.sequence === undefined && event !== latestUser)
                    continue;
                if (typeof claim.exactText !== "string")
                    continue;
                if (record(event.data)?.text !== claim.exactText)
                    continue;
                return canonicalEvidence(claim, event);
            }
        }
        return undefined;
    }
}
const MILESTONE_STATUSES = ["pending", "active", "blocked", "proven", "invalidated"];
const PLAN_INVALIDATION_APPROVAL_PREFIX = "VANGUARD_PLAN_INVALIDATION_APPROVAL ";
function planInvalidationApprovalText(milestoneId, supersededBy) {
    return `${PLAN_INVALIDATION_APPROVAL_PREFIX}${JSON.stringify({ milestoneId, supersededBy })}`;
}
export function contractCriterionIds(contract) {
    return [
        ...contract.successCriteria.map((_criterion, index) => `success-${index + 1}`),
        ...(contract.requiredVerification ?? []).map((_criterion, index) => `verification-${index + 1}`),
        ...(contract.deliverables ?? []).map((_criterion, index) => `deliverable-${index + 1}`),
    ];
}
export class PlanLedger {
    #state;
    #file;
    #requiredCriteria;
    #evidenceResolver;
    constructor(initial, file, requiredCriteria = [], evidenceResolver) {
        this.#state = initial;
        this.#file = file;
        this.#requiredCriteria = initial?.requiredCriteria ?? uniqueStrings(requiredCriteria, "required criteria", 100);
        this.#evidenceResolver = evidenceResolver;
    }
    static async open(file, requiredCriteria = [], evidenceResolver, anchor) {
        const absolute = path.resolve(file);
        try {
            const parsed = JSON.parse(await readFile(absolute, "utf8"));
            const state = migratePersistedPlan(parsed, requiredCriteria);
            validatePlanState(state);
            const actualSha256 = planStateSha256(state);
            if (anchor?.required === true && anchor.expectedSha256 === undefined) {
                throw new Error("Persisted plan has no committed journal anchor.");
            }
            if (anchor?.expectedSha256 !== undefined && actualSha256 !== anchor.expectedSha256) {
                throw new Error("Persisted plan does not match its committed journal anchor.");
            }
            if (evidenceResolver !== undefined)
                await validatePersistedEvidence(state, evidenceResolver);
            const requested = uniqueStrings(requiredCriteria, "required criteria", 100);
            if (requested.length > 0 && JSON.stringify(requested) !== JSON.stringify(state.requiredCriteria)) {
                throw new Error("Persisted plan criterion IDs do not match the contracted task.");
            }
            return new PlanLedger(state, absolute, state.requiredCriteria, evidenceResolver);
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
            if (anchor?.expectedSha256 !== undefined)
                throw new Error("Committed plan state is missing from disk.");
            return new PlanLedger(undefined, absolute, requiredCriteria, evidenceResolver);
        }
    }
    isEmpty() {
        return this.#state === undefined;
    }
    unproven() {
        if (this.#state === undefined)
            return [];
        return this.#state.milestones
            .filter((milestone) => milestone.status !== "proven" && milestone.status !== "invalidated")
            .map((milestone) => `${milestone.id} — ${milestone.title}`);
    }
    async evidenceBlockers() {
        if (this.#state === undefined || this.#evidenceResolver === undefined)
            return [];
        const blockers = [];
        for (const milestone of this.#state.milestones) {
            if (milestone.status !== "proven")
                continue;
            let current = true;
            for (const reference of milestone.evidence) {
                if (reference.kind !== "tool" && reference.kind !== "verification")
                    continue;
                const resolved = await this.#evidenceResolver.resolve(reference);
                if (resolved === undefined || !sameEvidence(reference, resolved)) {
                    current = false;
                    break;
                }
            }
            if (!current)
                blockers.push(`${milestone.id} - ${milestone.title}`);
        }
        return blockers;
    }
    attachEvidenceResolver(resolver) {
        if (resolver !== undefined)
            this.#evidenceResolver = resolver;
    }
    async refreshStaleProofs() {
        if (this.#state === undefined || this.#evidenceResolver === undefined) {
            return { refreshed: false, remaining: [] };
        }
        const resolver = this.#evidenceResolver;
        const stale = new Set();
        for (const milestone of this.#state.milestones) {
            if (milestone.status !== "proven")
                continue;
            let current = true;
            for (const reference of milestone.evidence) {
                if (reference.kind !== "tool" && reference.kind !== "verification")
                    continue;
                const resolved = await resolver.resolve(reference);
                if (resolved === undefined || !sameEvidence(reference, resolved)) {
                    current = false;
                    break;
                }
            }
            if (!current)
                stale.add(milestone.id);
        }
        if (stale.size === 0)
            return { refreshed: false, remaining: [] };
        const labels = () => this.#state.milestones
            .filter((milestone) => stale.has(milestone.id))
            .map((milestone) => `${milestone.id} - ${milestone.title}`);
        const candidates = await resolver.eligibleToolEvidence?.(24) ?? [];
        if (candidates.length === 0)
            return { refreshed: false, remaining: labels() };
        const milestones = [];
        for (const milestone of this.#state.milestones) {
            if (!stale.has(milestone.id)) {
                milestones.push(milestone);
                continue;
            }
            const authorities = new Set(milestone.evidence
                .filter((reference) => reference.kind === "tool")
                .map((reference) => reference.evidenceAuthority));
            const pick = candidates.find((candidate) => authorities.has(candidate.evidenceAuthority)) ?? candidates[0];
            const resolved = await resolver.resolve({ kind: "tool", evidenceId: pick.evidenceId });
            milestones.push(resolved === undefined ? milestone : { ...milestone, evidence: [resolved] });
        }
        try {
            const next = await this.update("runtime refresh: re-bound stale proof to fresh current-generation evidence", milestones);
            return {
                refreshed: true,
                revision: next.revision,
                stateSha256: planStateSha256(next),
                milestones: next.milestones.length,
                remaining: await this.evidenceBlockers(),
            };
        }
        catch {
            return { refreshed: false, remaining: labels() };
        }
    }
    scopeBlocker(relativePath) {
        if (this.#state === undefined)
            return undefined;
        const scoped = this.#state.milestones.filter((milestone) => milestone.status !== "invalidated" && milestone.scope.length > 0);
        if (scoped.length === 0)
            return undefined;
        const target = normalizeScopePath(relativePath);
        for (const milestone of scoped) {
            if (milestone.scope.some((entry) => scopeEntryMatches(entry, target)))
                return undefined;
        }
        const owners = scoped
            .map((milestone) => `${milestone.id} owns [${milestone.scope.join(", ")}]`)
            .join("; ");
        return `Path '${relativePath}' is outside every declared milestone scope (${owners}). `
            + "This mutation is plan drift. Work within the declared scope, or first revise the plan "
            + "with update_plan, adding a milestone that owns this path, before mutating it.";
    }
    requiredCriteria() {
        return this.#requiredCriteria;
    }
    state() {
        return this.#state;
    }
    snapshot() {
        if (this.#state === undefined) {
            return { requiredCriteria: [...this.#requiredCriteria], revision: 0, milestones: [] };
        }
        return {
            revision: this.#state.revision,
            requiredCriteria: [...this.#state.requiredCriteria],
            milestones: this.#state.milestones.map((milestone) => ({
                id: milestone.id,
                title: milestone.title,
                status: milestone.status,
                acceptanceCriteria: [...milestone.acceptanceCriteria],
                dependsOn: [...milestone.dependsOn],
                covers: [...milestone.covers],
                evidence: milestone.evidence.map((evidence) => ({ ...evidence })),
                scope: [...milestone.scope],
                ...(milestone.note === undefined ? {} : { note: milestone.note }),
                ...(milestone.invalidation === undefined ? {} : { invalidation: milestone.invalidation }),
            })),
        };
    }
    async update(summary, milestones) {
        const revision = (this.#state?.revision ?? 0) + 1;
        const history = [
            ...(this.#state?.history ?? []),
            { revision, summary, at: new Date().toISOString() },
        ].slice(-100);
        const next = {
            revision,
            requiredCriteria: this.#requiredCriteria,
            milestones,
            history,
        };
        validateNewInvalidationTransitions(this.#state, next);
        validatePlanState(next);
        validateRevision(this.#state, next);
        if (this.#file !== undefined)
            await atomicJsonWrite(this.#file, next);
        this.#state = next;
        return next;
    }
}
export class PlanTool {
    ledger;
    evidenceResolver;
    name = PLAN_TOOL_NAME;
    definition;
    constructor(ledger, evidenceResolver) {
        this.ledger = ledger;
        this.evidenceResolver = evidenceResolver;
        ledger.attachEvidenceResolver(evidenceResolver);
        const criteria = ledger.requiredCriteria();
        this.definition = {
            name: this.name,
            description: "Establish or revise the durable engineering plan. Revisions are monotonic: never delete or weaken a milestone. Proven milestones require fresh runtime-authorized independent execution/review or sealed-verifier evidence; reads, writes, state tools, and unmarked execute tools cannot prove work. Cite an eligible successful tool result with exactly {\"kind\":\"tool\",\"evidenceId\":\"<observation evidenceId>\"}; Vanguard derives its provider call id, tool, authority, workspace generation, journal sequence, and hash. If no successful observation includes evidenceAuthority, keep milestones active and run an independent check instead of guessing an ID. Legacy callId-only citations remain supported. Never invent runtime fields or copy output text. Initial plans cannot contain invalidations. A later invalidation requires the latest user message to be exactly `VANGUARD_PLAN_INVALIDATION_APPROVAL {\"milestoneId\":\"<invalidated-id>\",\"supersededBy\":\"<superseding-id>\"}`. The non-invalidated superseder must inherit every acceptance criterion and contract criterion, and must remain unproven in that revision until later executable proof."
                + (criteria.length === 0 ? "" : ` Contract criterion IDs that must be covered exactly: ${criteria.join(", ")}.`),
            inputSchema: {
                type: "object",
                properties: {
                    summary: { type: "string" },
                    note: { type: "string", description: "Optional progress note for provider compatibility; milestone notes remain authoritative." },
                    milestones: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string" },
                                title: { type: "string" },
                                acceptanceCriteria: { type: "array", items: { type: "string" } },
                                dependsOn: { type: "array", items: { type: "string" } },
                                covers: { type: "array", items: { type: "string" } },
                                status: { type: "string", enum: [...MILESTONE_STATUSES] },
                                evidence: { type: "array", items: evidenceSchema() },
                                scope: { type: "array", items: { type: "string" }, description: "Workspace-relative paths, directory prefixes, or globs this milestone owns. Once any milestone declares scope, mutating a path outside every declared scope is rejected as plan drift; claim new paths by adding a milestone. Declare scope on every milestone or on none." },
                                note: { type: "string" },
                                invalidation: {
                                    type: "object",
                                    properties: {
                                        reason: { type: "string" },
                                        supersededBy: { type: "string" },
                                        evidence: evidenceSchema(),
                                    },
                                    required: ["reason", "supersededBy", "evidence"],
                                    additionalProperties: false,
                                },
                            },
                            required: ["id", "title", "acceptanceCriteria", "dependsOn", "covers", "status", "evidence", "scope"],
                            additionalProperties: false,
                        },
                    },
                },
                required: ["summary", "milestones"],
                additionalProperties: false,
            },
            effect: "state",
        };
    }
    async execute(input, _context) {
        if (input === null || Array.isArray(input) || typeof input !== "object") {
            throw new Error("Plan input must be an object.");
        }
        const summary = input.summary;
        if (typeof summary !== "string" || summary.length === 0 || summary.length > 2_000) {
            throw new Error("Plan summary must contain 1 to 2,000 characters.");
        }
        if (!Array.isArray(input.milestones))
            throw new Error("Plan milestones must be an array.");
        const drafts = input.milestones.map(parseMilestoneDraft);
        const milestones = [];
        for (const draft of drafts) {
            const evidence = await this.#resolveAll(draft.evidence, draft.id);
            const priorMilestone = this.ledger.state()?.milestones.find((milestone) => milestone.id === draft.id);
            const invalidation = draft.invalidation === undefined
                ? undefined
                : {
                    reason: draft.invalidation.reason,
                    supersededBy: draft.invalidation.supersededBy,
                    evidence: await this.#resolveInvalidationEvidence(draft, priorMilestone),
                };
            const { evidence: _claims, invalidation: _invalidationClaim, ...base } = draft;
            milestones.push({
                ...base,
                evidence,
                ...(invalidation === undefined ? {} : { invalidation }),
            });
        }
        const state = await this.ledger.update(summary, milestones);
        return {
            ok: true,
            output: {
                revision: state.revision,
                stateSha256: planStateSha256(state),
                milestones: state.milestones.length,
                unproven: [...this.ledger.unproven()],
            },
        };
    }
    async #resolveInvalidationEvidence(draft, prior) {
        const invalidation = draft.invalidation;
        const carried = prior?.status === "invalidated" ? prior.invalidation : undefined;
        if (carried !== undefined
            && invalidation.reason === carried.reason
            && invalidation.supersededBy === carried.supersededBy
            && invalidation.evidence.kind === "user"
            && invalidation.evidence.exactText === carried.evidence.exactText) {
            const revalidated = await this.evidenceResolver?.resolve(carried.evidence);
            if (revalidated?.kind !== "user" || !sameEvidence(carried.evidence, revalidated)) {
                throw new Error(`Milestone '${draft.id}' carried invalidation no longer resolves to its canonical user authorization.`);
            }
            return carried.evidence;
        }
        return this.#resolveUser(invalidation.evidence, draft.id, invalidation.supersededBy);
    }
    async #resolveAll(claims, milestone) {
        const resolved = [];
        for (const claim of claims) {
            const reference = await this.evidenceResolver?.resolve(claim);
            if (reference === undefined) {
                const eligible = await this.evidenceResolver?.eligibleToolEvidence?.();
                const recovery = eligible === undefined || eligible.length === 0
                    ? "No fresh eligible tool proof exists yet; keep the milestone active and run a successful independent execution or review before retrying."
                    : `Fresh eligible tool proof: ${eligible.map((item) => `${item.evidenceId} (${item.tool}, ${item.evidenceAuthority})`).join(", ")}.`;
                throw new Error(`Milestone '${milestone}' cites evidence that does not resolve to one fresh runtime-authorized execution/review or sealed-verifier journal event. For tool evidence use exactly {"kind":"tool","evidenceId":"<eligible successful observation evidenceId>"}; reads, mutations, state operations, and unmarked execute tools are not proof. ${recovery}`);
            }
            resolved.push(reference);
        }
        return resolved;
    }
    async #resolveUser(claim, milestone, supersededBy) {
        if (claim.kind !== "user")
            throw new Error(`Milestone '${milestone}' invalidation requires user evidence.`);
        const requiredText = planInvalidationApprovalText(milestone, supersededBy);
        if (claim.exactText !== requiredText) {
            throw new Error(`Milestone '${milestone}' invalidation requires this exact latest user message: ${requiredText}`);
        }
        const reference = await this.evidenceResolver?.resolve(claim);
        if (reference?.kind !== "user") {
            throw new Error(`Milestone '${milestone}' invalidation does not match the latest exact user message. Required: ${requiredText}`);
        }
        return reference;
    }
}
export function planStateSha256(state) {
    return durableStateSha256(state);
}
function parseMilestoneDraft(value) {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new Error("Each milestone must be an object.");
    }
    const id = expectBoundedString(value.id, "id", 64);
    const status = value.status;
    if (!MILESTONE_STATUSES.includes(status)) {
        throw new Error(`Milestone '${id}' has an invalid status.`);
    }
    const invalidationValue = value.invalidation;
    const invalidation = invalidationValue === undefined
        ? undefined
        : parseInvalidation(invalidationValue, id);
    return {
        id,
        title: expectBoundedString(value.title, "title", 300),
        acceptanceCriteria: stringList(value.acceptanceCriteria, `${id}.acceptanceCriteria`),
        dependsOn: stringList(value.dependsOn, `${id}.dependsOn`),
        covers: stringList(value.covers, `${id}.covers`),
        status: status,
        evidence: evidenceClaims(value.evidence, `${id}.evidence`),
        scope: stringList(value.scope, `${id}.scope`),
        ...(typeof value.note === "string" && value.note.length > 0 ? { note: value.note.slice(0, 1_000) } : {}),
        ...(invalidation === undefined ? {} : { invalidation }),
    };
}
function parseInvalidation(value, id) {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new Error(`Milestone '${id}' invalidation must be an object.`);
    }
    return {
        reason: expectBoundedString(value.reason, `${id}.invalidation.reason`, 1_000),
        supersededBy: expectBoundedString(value.supersededBy, `${id}.invalidation.supersededBy`, 64),
        evidence: evidenceClaim(value.evidence, `${id}.invalidation.evidence`),
    };
}
function validatePlanState(state) {
    if (!Number.isSafeInteger(state.revision) || state.revision < 1)
        throw new Error("Persisted plan is malformed.");
    if (!Array.isArray(state.milestones) || state.milestones.length < 1 || state.milestones.length > 24) {
        throw new Error("A materialized plan holds between 1 and 24 milestones.");
    }
    const required = new Set(uniqueStrings(state.requiredCriteria, "required criteria", 100));
    const activelyCovered = new Set();
    const ids = new Set();
    for (const milestone of state.milestones) {
        if (ids.has(milestone.id))
            throw new Error(`Milestone id '${milestone.id}' is duplicated.`);
        ids.add(milestone.id);
        for (const criterion of milestone.covers) {
            if (!required.has(criterion))
                throw new Error(`Milestone '${milestone.id}' covers unknown criterion '${criterion}'.`);
            if (milestone.status !== "invalidated")
                activelyCovered.add(criterion);
        }
        if (milestone.status === "proven") {
            if (milestone.evidence.length === 0
                || !milestone.evidence.some((evidence) => evidence.kind === "tool" || evidence.kind === "verification")) {
                throw new Error(`Milestone '${milestone.id}' cannot be proven without successful executable evidence.`);
            }
        }
        if (milestone.status === "invalidated" && milestone.invalidation === undefined) {
            throw new Error(`Milestone '${milestone.id}' cannot be invalidated without user evidence and a superseding milestone.`);
        }
        if (milestone.status !== "invalidated" && milestone.invalidation !== undefined) {
            throw new Error(`Milestone '${milestone.id}' carries invalidation data but is not invalidated.`);
        }
    }
    for (const criterion of required) {
        if (!activelyCovered.has(criterion)) {
            throw new Error(`Contract criterion '${criterion}' is not covered by any non-invalidated milestone.`);
        }
    }
    for (const milestone of state.milestones) {
        for (const dependency of milestone.dependsOn) {
            if (!ids.has(dependency))
                throw new Error(`Milestone '${milestone.id}' depends on unknown milestone '${dependency}'.`);
        }
        if (milestone.invalidation !== undefined) {
            const superseding = state.milestones.find((candidate) => candidate.id === milestone.invalidation.supersededBy);
            if (superseding === undefined || superseding.status === "invalidated" || superseding.id === milestone.id) {
                throw new Error(`Milestone '${milestone.id}' has no active superseding milestone.`);
            }
            const requiredApproval = planInvalidationApprovalText(milestone.id, superseding.id);
            if (milestone.invalidation.evidence.exactText !== requiredApproval) {
                throw new Error(`Milestone '${milestone.id}' invalidation lacks the required structured human approval: ${requiredApproval}`);
            }
            for (const criterion of milestone.acceptanceCriteria) {
                if (!superseding.acceptanceCriteria.includes(criterion)) {
                    throw new Error(`Superseding milestone '${superseding.id}' must inherit acceptance criterion '${criterion}' from '${milestone.id}'.`);
                }
            }
            for (const criterion of milestone.covers) {
                if (!superseding.covers.includes(criterion)) {
                    throw new Error(`Superseding milestone '${superseding.id}' must inherit contract criterion '${criterion}' from '${milestone.id}'.`);
                }
            }
            if (superseding.status === "proven") {
                const authorizationSequence = milestone.invalidation.evidence.sequence;
                const executableProof = superseding.evidence.filter((evidence) => evidence.kind === "tool" || evidence.kind === "verification");
                if (executableProof.some((evidence) => evidence.sequence <= authorizationSequence)) {
                    throw new Error(`Superseding milestone '${superseding.id}' must use fresh executable proof recorded after the structured human approval for '${milestone.id}'.`);
                }
            }
        }
    }
    assertAcyclic(state.milestones);
}
function validateRevision(previous, next) {
    if (previous === undefined) {
        const invalidated = next.milestones.find((milestone) => milestone.status === "invalidated");
        if (invalidated !== undefined) {
            throw new Error(`Initial plan cannot invalidate milestone '${invalidated.id}'. Establish it first, then request explicit human approval in a later revision.`);
        }
        return;
    }
    const nextById = new Map(next.milestones.map((milestone) => [milestone.id, milestone]));
    for (const prior of previous.milestones) {
        const current = nextById.get(prior.id);
        if (current === undefined)
            throw new Error(`Plan revision cannot delete milestone '${prior.id}'.`);
        for (const field of ["title", "acceptanceCriteria", "dependsOn", "covers", "scope"]) {
            if (JSON.stringify(prior[field]) !== JSON.stringify(current[field])) {
                throw new Error(`Plan revision cannot weaken or rewrite '${prior.id}.${field}'. Add a superseding milestone instead.`);
            }
        }
        if ((prior.status === "proven" || prior.status === "invalidated") && current.status !== prior.status) {
            throw new Error(`Terminal milestone '${prior.id}' cannot move back from ${prior.status}.`);
        }
        if (prior.status === "invalidated"
            && JSON.stringify(prior.invalidation) !== JSON.stringify(current.invalidation)) {
            throw new Error(`Terminal milestone '${prior.id}' invalidation authorization is immutable.`);
        }
        if (prior.status !== "invalidated" && current.status === "invalidated") {
            const superseding = nextById.get(current.invalidation.supersededBy);
            if (superseding?.status === "proven") {
                throw new Error(`Superseding milestone '${superseding.id}' cannot be proven in the same revision that invalidates '${prior.id}'. Record the approved invalidation first, then prove the superseder with fresh executable evidence in a later revision.`);
            }
        }
        if (prior.status === "proven"
            && JSON.stringify(prior.evidence) !== JSON.stringify(current.evidence)
            && !isStrictlyNewerExecutableEvidence(prior.evidence, current.evidence)) {
            throw new Error(`Proven milestone '${prior.id}' evidence is immutable except for a complete refresh in a newer workspace generation.`);
        }
    }
}
function validateNewInvalidationTransitions(previous, next) {
    if (previous === undefined)
        return;
    const nextById = new Map(next.milestones.map((milestone) => [milestone.id, milestone]));
    for (const prior of previous.milestones) {
        const current = nextById.get(prior.id);
        if (prior.status === "invalidated" || current?.status !== "invalidated" || current.invalidation === undefined) {
            continue;
        }
        const superseding = nextById.get(current.invalidation.supersededBy);
        const hasCanonicalApproval = current.invalidation.evidence.exactText
            === planInvalidationApprovalText(current.id, current.invalidation.supersededBy);
        const preservesAcceptance = superseding !== undefined
            && current.acceptanceCriteria.every((criterion) => superseding.acceptanceCriteria.includes(criterion));
        const preservesCoverage = superseding !== undefined
            && current.covers.every((criterion) => superseding.covers.includes(criterion));
        if (superseding?.status === "proven" && hasCanonicalApproval && preservesAcceptance && preservesCoverage) {
            throw new Error(`Superseding milestone '${superseding.id}' cannot be proven in the same revision that invalidates '${prior.id}'. Record the approved invalidation first, then prove the superseder with fresh executable evidence in a later revision.`);
        }
    }
}
function isStrictlyNewerExecutableEvidence(prior, current) {
    const priorGenerations = prior
        .filter((evidence) => evidence.kind === "tool" || evidence.kind === "verification")
        .map((evidence) => evidence.workspaceGeneration);
    const currentGenerations = current
        .filter((evidence) => evidence.kind === "tool" || evidence.kind === "verification")
        .map((evidence) => evidence.workspaceGeneration);
    if (priorGenerations.length === 0 || currentGenerations.length === 0
        || priorGenerations.some((generation) => !validWorkspaceGeneration(generation))
        || currentGenerations.some((generation) => !validWorkspaceGeneration(generation)))
        return false;
    const priorMaximum = Math.max(...priorGenerations);
    return currentGenerations.every((generation) => generation > priorMaximum);
}
async function validatePersistedEvidence(state, resolver) {
    for (const milestone of state.milestones) {
        for (const reference of milestone.evidence) {
            const resolved = resolver.revalidate === undefined
                ? await resolver.resolve(reference)
                : await resolver.revalidate(reference);
            if (resolved === undefined || !sameEvidence(reference, resolved)) {
                throw new Error(`Persisted plan evidence integrity failure in milestone '${milestone.id}'.`);
            }
        }
        if (milestone.invalidation !== undefined) {
            const resolved = resolver.revalidate === undefined
                ? await resolver.resolve(milestone.invalidation.evidence)
                : await resolver.revalidate(milestone.invalidation.evidence);
            if (resolved === undefined || !sameEvidence(milestone.invalidation.evidence, resolved)) {
                throw new Error(`Persisted plan invalidation integrity failure in milestone '${milestone.id}'.`);
            }
        }
    }
}
function sameEvidence(left, right) {
    return left.kind === right.kind
        && left.sequence === right.sequence
        && left.sha256 === right.sha256
        && left.evidenceAuthority === right.evidenceAuthority
        && left.workspaceGeneration === right.workspaceGeneration
        && left.evidenceId === right.evidenceId
        && left.callId === right.callId
        && left.tool === right.tool
        && left.verifier === right.verifier
        && left.exactText === right.exactText;
}
function assertAcyclic(milestones) {
    const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
        if (visiting.has(id))
            throw new Error(`Plan dependency cycle includes '${id}'.`);
        if (visited.has(id))
            return;
        visiting.add(id);
        for (const dependency of byId.get(id)?.dependsOn ?? [])
            visit(dependency);
        visiting.delete(id);
        visited.add(id);
    };
    for (const milestone of milestones)
        visit(milestone.id);
}
function evidenceSchema() {
    return {
        description: "Evidence selector. For a new successful tool citation, send exactly {\"kind\":\"tool\",\"evidenceId\":\"<observation evidenceId>\"}. Legacy callId-only selectors remain supported. Runtime-owned provider id, sequence, tool, and sha256 values are derived and must not be guessed.",
        oneOf: [
            {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["tool"] },
                    evidenceId: { type: "string", description: "Exact runtime-owned evidenceId from one successful tool observation." },
                    callId: { type: "string", description: "Optional copied legacy identifier; ignored when evidenceId is present." },
                    tool: { type: "string", description: "Optional copied tool label; runtime identity remains journal-derived." },
                },
                required: ["kind", "evidenceId"],
                additionalProperties: false,
            },
            {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["tool"] },
                    callId: { type: "string", description: "Exact callId from one successful tool observation." },
                    tool: { type: "string", description: "Optional copied tool label; runtime identity remains journal-derived." },
                },
                required: ["kind", "callId"],
                additionalProperties: false,
            },
            {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["verification"] },
                    sequence: { type: "integer", minimum: 1 },
                    verifier: { type: "string" },
                },
                required: ["kind", "verifier"],
                additionalProperties: false,
            },
            {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["user"] },
                    exactText: { type: "string" },
                },
                required: ["kind", "exactText"],
                additionalProperties: false,
            },
        ],
    };
}
function evidenceClaims(value, name) {
    if (!Array.isArray(value) || value.length > 20)
        throw new Error(`Plan '${name}' must be an array of at most 20 evidence claims.`);
    return value.map((item, index) => evidenceClaim(item, `${name}[${index}]`));
}
function evidenceClaim(value, name) {
    if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
        throw new Error(`Plan '${name}' must be a structured evidence object.`);
    }
    if (value.kind !== "tool" && value.kind !== "verification" && value.kind !== "user") {
        throw new Error(`Plan '${name}' has an invalid evidence kind.`);
    }
    const optional = (field) => {
        const item = value[field];
        if (item === undefined)
            return undefined;
        if (typeof item !== "string" || item.length === 0 || item.length > 4_000) {
            throw new Error(`Plan '${name}.${field}' must be a bounded string.`);
        }
        return item;
    };
    if (value.kind === "tool") {
        const evidenceId = optional("evidenceId");
        if (evidenceId !== undefined) {
            return { kind: "tool", evidenceId };
        }
        const callId = optional("callId");
        if (callId === undefined) {
            throw new Error(`Plan '${name}.evidenceId' (or legacy callId) is required for tool evidence.`);
        }
        return { kind: "tool", callId };
    }
    if (value.kind === "user") {
        const exactText = optional("exactText");
        if (exactText === undefined)
            throw new Error(`Plan '${name}.exactText' is required for user evidence.`);
        return { kind: "user", exactText };
    }
    const sequence = value.sequence;
    if (sequence !== undefined && (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1)) {
        throw new Error(`Plan '${name}.sequence' must be a positive integer.`);
    }
    const callId = optional("callId");
    const tool = optional("tool");
    const verifier = optional("verifier");
    const exactText = optional("exactText");
    return {
        kind: value.kind,
        ...(typeof sequence === "number" ? { sequence } : {}),
        ...(callId === undefined ? {} : { callId }),
        ...(tool === undefined ? {} : { tool }),
        ...(verifier === undefined ? {} : { verifier }),
        ...(exactText === undefined ? {} : { exactText }),
    };
}
function successfulToolData(event) {
    if (event.type !== "tool.completed")
        return undefined;
    const data = record(event.data);
    return data?.ok === true && typeof data.callId === "string" && typeof data.tool === "string"
        ? data
        : undefined;
}
function eligibleToolData(event, events, requireCurrent) {
    const data = successfulToolData(event);
    if (data === undefined)
        return undefined;
    const authority = data.evidenceAuthority;
    if (authority !== "independent-execution" && authority !== "independent-review")
        return undefined;
    if (eligibleWorkspaceGeneration(event, events, requireCurrent) === undefined)
        return undefined;
    return data;
}
function eligibleWorkspaceGeneration(event, events, requireCurrent) {
    const value = record(event.data)?.workspaceGeneration;
    if (!validWorkspaceGeneration(value))
        return undefined;
    const atEvent = journalWorkspaceGeneration(events, event.sequence);
    if (atEvent === undefined || value !== atEvent)
        return undefined;
    if (requireCurrent && value !== journalWorkspaceGeneration(events))
        return undefined;
    return value;
}
function canonicalEvidence(claim, event) {
    return {
        ...claim,
        sequence: event.sequence,
        sha256: createHash("sha256").update(JSON.stringify({
            sequence: event.sequence,
            type: event.type,
            data: event.data,
        })).digest("hex"),
    };
}
function migratePersistedPlan(value, requestedCriteria) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Persisted plan is malformed.");
    const state = value;
    const requiredCriteria = Array.isArray(state.requiredCriteria)
        ? uniqueStrings(state.requiredCriteria, "required criteria", 100)
        : uniqueStrings(requestedCriteria, "required criteria", 100);
    const milestones = Array.isArray(state.milestones) ? state.milestones.map((raw) => {
        const item = raw;
        const legacyEvidence = !Array.isArray(item.evidence)
            || item.evidence.some((evidence) => typeof evidence === "string");
        const legacyInvalidation = item.status === "invalidated" && item.invalidation === undefined;
        return {
            ...item,
            covers: Array.isArray(item.covers) ? item.covers : [],
            evidence: legacyEvidence ? [] : item.evidence,
            status: legacyEvidence && item.status === "proven" || legacyInvalidation ? "active" : item.status,
            ...(legacyEvidence || legacyInvalidation
                ? { note: `${item.note ?? ""}${item.note ? " " : ""}Legacy unbound evidence was rejected during migration.` }
                : {}),
        };
    }) : [];
    return {
        revision: state.revision,
        requiredCriteria,
        milestones,
        history: Array.isArray(state.history) ? state.history : [],
    };
}
function expectBoundedString(value, name, max) {
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
        throw new Error(`Milestone ${name} must contain 1 to ${max} characters.`);
    }
    return value;
}
function stringList(value, name) {
    if (!Array.isArray(value))
        throw new Error(`Plan '${name}' must be an array.`);
    return uniqueStrings(value, name, 50);
}
function uniqueStrings(value, name, maxItems) {
    if (value.length > maxItems || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 1_000)) {
        throw new Error(`Plan '${name}' must contain at most ${maxItems} unique bounded strings.`);
    }
    const result = value;
    if (new Set(result).size !== result.length)
        throw new Error(`Plan '${name}' cannot contain duplicates.`);
    return [...result];
}
async function atomicJsonWrite(file, state) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
        await rename(temporary, file);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
function normalizeScopePath(value) {
    const normalized = value
        .replaceAll("\\", "/")
        .replace(/^\.\//u, "")
        .replace(/\/+$/u, "")
        .replace(/\/{2,}/gu, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function scopeEntryMatches(entry, normalizedTarget) {
    const scope = normalizeScopePath(entry);
    if (scope.length === 0)
        return false;
    if (!/[*?[]/u.test(scope)) {
        return scope === "." || scope === normalizedTarget || normalizedTarget.startsWith(`${scope}/`);
    }
    let regex = "";
    let index = 0;
    while (index < scope.length) {
        const char = scope[index];
        if (char === "*") {
            if (scope[index + 1] === "*") {
                if (scope[index + 2] === "/") {
                    regex += "(?:[^/]+/)*";
                    index += 3;
                }
                else {
                    regex += ".*";
                    index += 2;
                }
            }
            else {
                regex += "[^/]*";
                index += 1;
            }
        }
        else if (char === "?") {
            regex += "[^/]";
            index += 1;
        }
        else if (char === "[") {
            const closing = scope.indexOf("]", index + 2);
            if (closing === -1 || scope.slice(index + 1, closing).includes("/"))
                return false;
            regex += `[${scope.slice(index + 1, closing).replaceAll("\\", "\\\\")}]`;
            index = closing + 1;
        }
        else {
            regex += char.replace(/[.+^${}()|\\]/u, "\\$&");
            index += 1;
        }
    }
    let matcher;
    try {
        matcher = new RegExp(`^${regex}$`, "u");
    }
    catch {
        return false;
    }
    if (!scope.includes("/")) {
        const basename = normalizedTarget.split("/").at(-1) ?? normalizedTarget;
        return matcher.test(basename);
    }
    return matcher.test(normalizedTarget);
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
