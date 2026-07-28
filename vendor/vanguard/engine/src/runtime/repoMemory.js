import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { objectInput, stringField } from "./input.js";
const MAX_ENTRIES = 40;
const MAX_FACT_LENGTH = 500;
const INJECTED_ENTRIES = 5;
const KINDS = ["command", "convention", "gotcha", "fact"];
const DECAY_MS = 14 * 24 * 60 * 60 * 1_000;
export class RepoMemoryStore {
    now;
    #file;
    #entries;
    constructor(workspaceRoot, now = Date.now) {
        this.now = now;
        this.#file = path.join(workspaceRoot, ".vanguard", "memory.json");
    }
    async entries() {
        if (this.#entries !== undefined)
            return this.#entries;
        try {
            const parsed = JSON.parse(await readFile(this.#file, "utf8"));
            this.#entries = Array.isArray(parsed.entries)
                ? parsed.entries.filter(isMemoryEntry).slice(0, MAX_ENTRIES)
                : [];
        }
        catch {
            this.#entries = [];
        }
        return this.#entries;
    }
    score(entry) {
        const age = Math.max(0, this.now() - entry.lastTouchedAt);
        return entry.confirmations - entry.refutations * 2 - age / DECAY_MS;
    }
    async remember(kind, fact) {
        const entries = [...await this.entries()];
        const normalized = fact.trim();
        const existing = entries.find((entry) => entry.fact.toLowerCase() === normalized.toLowerCase());
        if (existing !== undefined)
            return this.#touch(existing.id, 1);
        const entry = {
            id: randomUUID().slice(0, 8),
            kind,
            fact: normalized,
            createdAt: this.now(),
            lastTouchedAt: this.now(),
            confirmations: 1,
            refutations: 0,
        };
        entries.push(entry);
        entries.sort((left, right) => this.score(right) - this.score(left));
        this.#entries = entries.slice(0, MAX_ENTRIES);
        await this.#persist();
        return entry;
    }
    async confirm(id) {
        return this.#touch(id, 1);
    }
    async refute(id) {
        return this.#touch(id, -1);
    }
    async forget(id) {
        const entries = [...await this.entries()];
        const remaining = entries.filter((entry) => entry.id !== id);
        if (remaining.length === entries.length)
            return false;
        this.#entries = remaining;
        await this.#persist();
        return true;
    }
    async addendum() {
        const entries = [...await this.entries()]
            .filter((entry) => this.score(entry) > -1)
            .sort((left, right) => this.score(right) - this.score(left))
            .slice(0, INJECTED_ENTRIES);
        if (entries.length === 0)
            return "";
        const lines = entries.map((entry) => `- [${entry.id}] (${entry.kind}) ${entry.fact}`);
        return "\n\nDurable repository memory (recorded in prior sessions; verify before relying on it, and use memory_note to confirm, refute, or add):\n"
            + lines.join("\n");
    }
    async #touch(id, direction) {
        const entries = [...await this.entries()];
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1)
            throw new Error(`No memory entry '${id}' exists.`);
        const current = entries[index];
        const updated = {
            ...current,
            lastTouchedAt: this.now(),
            confirmations: current.confirmations + (direction === 1 ? 1 : 0),
            refutations: current.refutations + (direction === -1 ? 1 : 0),
        };
        entries[index] = updated;
        this.#entries = entries;
        await this.#persist();
        return updated;
    }
    async #persist() {
        await mkdir(path.dirname(this.#file), { recursive: true });
        const temporary = `${this.#file}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify({ version: 1, entries: this.#entries ?? [] }, null, 2), { encoding: "utf8", flag: "wx" });
            await rename(temporary, this.#file);
        }
        finally {
            await rm(temporary, { force: true });
        }
    }
}
function isMemoryEntry(value) {
    if (value === null || typeof value !== "object")
        return false;
    const entry = value;
    return typeof entry.id === "string"
        && KINDS.includes(entry.kind)
        && typeof entry.fact === "string" && entry.fact.length > 0 && entry.fact.length <= MAX_FACT_LENGTH
        && typeof entry.createdAt === "number"
        && typeof entry.lastTouchedAt === "number"
        && typeof entry.confirmations === "number"
        && typeof entry.refutations === "number";
}
export class RepoMemoryTool {
    store;
    name = "memory_note";
    definition = {
        name: this.name,
        description: "Record, confirm, refute, or forget a durable fact about THIS repository (working commands, conventions, gotchas). Facts persist across sessions; the strongest few are injected into future runs, weak ones are forgotten automatically. Record only what future sessions cannot cheaply re-derive.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["remember", "confirm", "refute", "forget", "list"], description: "What to do." },
                kind: { type: "string", enum: [...KINDS], description: "Category, for remember." },
                fact: { type: "string", description: `The durable fact, for remember; at most ${MAX_FACT_LENGTH} characters.` },
                id: { type: "string", description: "Entry id, for confirm/refute/forget." },
            },
            required: ["action"],
            additionalProperties: false,
        },
        effect: "state",
    };
    constructor(store) {
        this.store = store;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const action = stringField(fields, "action");
        if (action === "remember") {
            const fact = stringField(fields, "fact");
            if (fact.trim().length === 0 || fact.length > MAX_FACT_LENGTH) {
                throw new Error(`Memory facts must contain 1 to ${MAX_FACT_LENGTH} characters.`);
            }
            const kind = fields.kind ?? "fact";
            if (!KINDS.includes(kind))
                throw new Error("Memory kind must be command, convention, gotcha, or fact.");
            const entry = await this.store.remember(kind, fact);
            return { ok: true, output: { id: entry.id, kind: entry.kind, fact: entry.fact } };
        }
        if (action === "list") {
            const entries = await this.store.entries();
            return {
                ok: true,
                output: {
                    entries: entries.map((entry) => ({
                        id: entry.id,
                        kind: entry.kind,
                        fact: entry.fact,
                        standing: Math.round(this.store.score(entry) * 10) / 10,
                    })),
                },
            };
        }
        const id = stringField(fields, "id");
        if (action === "confirm")
            return { ok: true, output: { id: (await this.store.confirm(id)).id, confirmed: true } };
        if (action === "refute")
            return { ok: true, output: { id: (await this.store.refute(id)).id, refuted: true } };
        if (action === "forget")
            return { ok: true, output: { id, forgotten: await this.store.forget(id) } };
        throw new Error("Memory action must be remember, confirm, refute, forget, or list.");
    }
}
