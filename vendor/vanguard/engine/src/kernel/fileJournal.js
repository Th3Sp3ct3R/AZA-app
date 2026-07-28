import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
export const JOURNAL_GENESIS_HASH = "0".repeat(64);
export class FileJournal {
    file;
    genesisHash;
    #lastHash;
    #writeChain = Promise.resolve();
    #events;
    #validBytes;
    constructor(file, genesisHash, envelopes, validBytes) {
        this.file = file;
        this.genesisHash = genesisHash;
        this.#lastHash = envelopes.at(-1)?.hash ?? genesisHash;
        this.#events = envelopes.map((envelope) => envelope.event);
        this.#validBytes = validBytes;
    }
    static async open(file, options = {}) {
        const absolute = path.resolve(file);
        const genesisHash = options.genesisHash ?? JOURNAL_GENESIS_HASH;
        if (!/^[a-f0-9]{64}$/.test(genesisHash))
            throw new Error("Journal genesis hash is malformed.");
        await mkdir(path.dirname(absolute), { recursive: true });
        try {
            await writeFile(absolute, "", { flag: "wx" });
        }
        catch (error) {
            if (!isExisting(error))
                throw error;
        }
        const { envelopes, byteLength } = await readValidatedJournal(absolute, genesisHash);
        return new FileJournal(absolute, genesisHash, envelopes, byteLength);
    }
    async append(event) {
        const operation = this.#writeChain.then(async () => {
            const previousHash = this.#lastHash;
            const hash = envelopeHash(previousHash, event);
            const envelope = { previousHash, hash, event };
            const line = `${JSON.stringify(envelope)}\n`;
            await appendFile(this.file, line, "utf8");
            this.#lastHash = hash;
            this.#events.push(event);
            this.#validBytes += Buffer.byteLength(line, "utf8");
        });
        this.#writeChain = operation.catch(() => undefined);
        return operation;
    }
    async readValidated() {
        await this.#writeChain;
        await this.#refresh();
        return [...this.#events];
    }
    async tip() {
        await this.#writeChain;
        await this.#refresh();
        return { hash: this.#lastHash, sequence: this.#events.at(-1)?.sequence ?? 0 };
    }
    async #refresh() {
        const size = (await stat(this.file)).size;
        if (size === this.#validBytes)
            return;
        const { envelopes, byteLength } = await readValidatedJournal(this.file, this.genesisHash);
        this.#events = envelopes.map((envelope) => envelope.event);
        this.#lastHash = envelopes.at(-1)?.hash ?? this.genesisHash;
        this.#validBytes = byteLength;
    }
}
async function readValidatedJournal(file, genesisHash) {
    const contents = await readFile(file, "utf8");
    const lines = contents.split("\n").filter((line) => line.length > 0);
    const envelopes = [];
    let previousHash = genesisHash;
    for (const [index, line] of lines.entries()) {
        const parsed = JSON.parse(line);
        if (parsed.previousHash !== previousHash || parsed.hash !== envelopeHash(previousHash, parsed.event)) {
            throw new Error(`Journal integrity failure at line ${index + 1}.`);
        }
        envelopes.push(parsed);
        previousHash = parsed.hash;
    }
    return { envelopes, byteLength: Buffer.byteLength(contents, "utf8") };
}
function envelopeHash(previousHash, event) {
    return createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
}
function isExisting(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
