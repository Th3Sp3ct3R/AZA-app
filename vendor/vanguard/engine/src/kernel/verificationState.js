import { createHash } from "node:crypto";
import { logicalRunEvents } from "./logicalHistory.js";
const MAX_FAILURES = 8;
const MAX_EVIDENCE_BYTES = 4_000;
const EVIDENCE_PREVIEW_CHARACTERS = 2_000;
export class SealedVerificationState {
    #pending = new Map();
    #pendingOrder = [];
    #unresolved;
    static fromJournal(events) {
        const state = new SealedVerificationState();
        for (const event of logicalRunEvents(events))
            state.observe(event);
        return state;
    }
    observe(event) {
        if (event.type === "verification.started") {
            const data = record(event.data);
            if (typeof data?.id !== "string" || data.id.length === 0)
                return;
            this.#pending.set(data.id, {
                id: data.id,
                ...(validGeneration(data.workspaceGeneration)
                    ? { workspaceGeneration: data.workspaceGeneration }
                    : {}),
                results: [],
            });
            this.#pendingOrder = [...this.#pendingOrder.filter((id) => id !== data.id), data.id];
            return;
        }
        if (event.type === "verification.completed") {
            const result = parseVerificationResult(event.data);
            if (result === undefined || result.verifier === "completion evidence policy")
                return;
            const pending = this.#latestPending();
            if (pending !== undefined) {
                pending.results.push(result);
                return;
            }
            if (!result.passed) {
                this.#unresolved = unresolvedState(`legacy:${event.sequence}`, event.sequence, result.workspaceGeneration, [result]);
            }
            return;
        }
        if (event.type !== "verification.finished")
            return;
        const data = record(event.data);
        if (typeof data?.id !== "string" || data.id.length === 0)
            return;
        const pending = this.#pending.get(data.id);
        this.#pending.delete(data.id);
        this.#pendingOrder = this.#pendingOrder.filter((id) => id !== data.id);
        if (data.passed === true) {
            this.#unresolved = undefined;
            return;
        }
        if (data.passed !== false)
            return;
        const generation = validGeneration(data.workspaceGeneration)
            ? data.workspaceGeneration
            : pending?.workspaceGeneration;
        const failures = pending?.results.filter((result) => !result.passed) ?? [];
        this.#unresolved = unresolvedState(data.id, event.sequence, generation, failures);
    }
    snapshot() {
        return this.#unresolved === undefined
            ? null
            : JSON.parse(JSON.stringify(this.#unresolved));
    }
    regroundingClause() {
        if (this.#unresolved === undefined)
            return undefined;
        const generation = this.#unresolved.workspaceGeneration === undefined
            ? "an unknown workspace generation"
            : `workspace generation ${this.#unresolved.workspaceGeneration}`;
        return `The latest sealed completion claim remains failed at ${generation} `
            + `(${this.#unresolved.failures.length + this.#unresolved.omittedFailures} failed verifier(s)). `
            + "A proven plan milestone does not override this result: inspect sealedVerification in the inert runtime-state data, repair the candidate, and obtain a fresh sealed pass.";
    }
    #latestPending() {
        const id = this.#pendingOrder.at(-1);
        return id === undefined ? undefined : this.#pending.get(id);
    }
}
export function withSealedVerificationState(workingState, sealedVerification) {
    if (sealedVerification === null)
        return workingState;
    if (isRecord(workingState) && !("sealedVerification" in workingState)) {
        return { ...workingState, sealedVerification: sealedVerification };
    }
    return {
        workingState,
        sealedVerification: sealedVerification,
    };
}
function unresolvedState(claimId, finishedSequence, workspaceGeneration, results) {
    const failures = results.slice(0, MAX_FAILURES).map((result) => ({
        verifier: boundedVerifierName(result.verifier),
        evidence: boundedEvidence(result.evidence),
        ...(validGeneration(result.workspaceGeneration)
            ? { workspaceGeneration: result.workspaceGeneration }
            : {}),
    }));
    return {
        version: 1,
        unresolved: true,
        claimId,
        finishedSequence,
        ...(validGeneration(workspaceGeneration) ? { workspaceGeneration } : {}),
        failures,
        omittedFailures: Math.max(0, results.length - failures.length),
        requiredNextEvidence: "fresh-sealed-verification-pass",
    };
}
function parseVerificationResult(value) {
    const data = record(value);
    if (typeof data?.verifier !== "string" || typeof data.passed !== "boolean" || !("evidence" in data)) {
        return undefined;
    }
    return {
        verifier: data.verifier,
        passed: data.passed,
        evidence: data.evidence,
        ...(validGeneration(data.workspaceGeneration)
            ? { workspaceGeneration: data.workspaceGeneration }
            : {}),
    };
}
function boundedVerifierName(value) {
    const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    return normalized.length === 0 ? "sealed verifier" : normalized.slice(0, 160);
}
function boundedEvidence(value) {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= MAX_EVIDENCE_BYTES)
        return JSON.parse(serialized);
    return {
        truncated: true,
        bytes,
        sha256: createHash("sha256").update(serialized).digest("hex"),
        preview: serialized.slice(0, EVIDENCE_PREVIEW_CHARACTERS),
    };
}
function validGeneration(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
