import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { durableStateSha256 } from "./durableState.js";
export class RunCheckpointLedger {
    #state;
    #file;
    constructor(initial, file) {
        this.#state = initial;
        this.#file = file;
    }
    static async open(file, anchor) {
        const absolute = path.resolve(file);
        try {
            const state = JSON.parse(await readFile(absolute, "utf8"));
            validateState(state);
            const actualSha256 = checkpointStateSha256(state);
            if (anchor?.required === true && anchor.expectedSha256 === undefined) {
                throw new Error("Persisted checkpoint has no committed journal anchor.");
            }
            if (anchor?.expectedSha256 !== undefined && actualSha256 !== anchor.expectedSha256) {
                throw new Error("Persisted checkpoint does not match its committed journal anchor.");
            }
            return new RunCheckpointLedger(state, absolute);
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
            if (anchor?.expectedSha256 !== undefined)
                throw new Error("Committed checkpoint state is missing from disk.");
            return new RunCheckpointLedger(undefined, absolute);
        }
    }
    async update(state) {
        this.#state = { ...state, revision: (this.#state?.revision ?? 0) + 1 };
        if (this.#file !== undefined)
            await atomicJsonWrite(this.#file, this.#state);
        return this.#state;
    }
    snapshot() {
        return this.#state === undefined ? null : this.#state;
    }
}
export class CheckpointTool {
    ledger;
    name = "run.checkpoint";
    definition = {
        name: this.name,
        description: "Persist concise working state that survives context compaction and provider retries.",
        inputSchema: {
            type: "object",
            properties: {
                summary: { type: "string", description: "Current understanding and approach." },
                completed: { type: "array", items: { type: "string" }, description: "Work proven complete." },
                next: { type: "array", items: { type: "string" }, description: "Ordered next actions." },
                evidence: { type: "array", items: { type: "string" }, description: "Tests, hashes, or observations supporting state." },
                risks: { type: "array", items: { type: "string" }, description: "Open uncertainties or regression risks." },
            },
            required: ["summary", "completed", "next", "evidence", "risks"],
            additionalProperties: false,
        },
        effect: "state",
    };
    constructor(ledger) {
        this.ledger = ledger;
    }
    async execute(input, _context) {
        if (input === null || Array.isArray(input) || typeof input !== "object") {
            throw new Error("Checkpoint input must be an object.");
        }
        const summary = input.summary;
        if (typeof summary !== "string" || summary.length === 0 || summary.length > 4_000) {
            throw new Error("Checkpoint summary must contain 1 to 4,000 characters.");
        }
        const state = await this.ledger.update({
            summary,
            completed: stringList(input.completed, "completed"),
            next: stringList(input.next, "next"),
            evidence: stringList(input.evidence, "evidence"),
            risks: stringList(input.risks, "risks"),
        });
        return { ok: true, output: { ...state, stateSha256: checkpointStateSha256(state) } };
    }
}
export function checkpointStateSha256(state) {
    return durableStateSha256(state);
}
function validateState(state) {
    if (!Number.isSafeInteger(state.revision) || state.revision < 1 || typeof state.summary !== "string") {
        throw new Error("Persisted checkpoint is malformed.");
    }
    for (const value of [state.completed, state.next, state.evidence, state.risks]) {
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
            throw new Error("Persisted checkpoint is malformed.");
        }
    }
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
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function stringList(value, name) {
    let normalized = value;
    if (typeof normalized === "string" && normalized.length <= 100_000) {
        try {
            normalized = JSON.parse(normalized);
        }
        catch { }
    }
    if (!Array.isArray(normalized)
        || normalized.length > 50
        || !normalized.every((item) => typeof item === "string" && item.length <= 1_000)) {
        throw new Error(`Checkpoint '${name}' must be an array of at most 50 strings, each at most 1,000 characters.`);
    }
    return normalized;
}
