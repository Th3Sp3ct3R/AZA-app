import { compareOrdinal } from "../deterministicText.js";
export class VanguardExtensionRegistry {
    #entries = new Map();
    register(extension) {
        assertIdentity(extension);
        const key = `${extension.kind}:${extension.name}`;
        if (this.#entries.has(key))
            throw new Error(`Extension '${key}' is already registered.`);
        this.#entries.set(key, extension);
    }
    get(kind, name) {
        return this.#entries.get(`${kind}:${name}`);
    }
    manifest() {
        return [...this.#entries.values()]
            .map(({ kind, name, version, provenance }) => ({ kind, name, version, provenance }))
            .sort((left, right) => compareOrdinal(`${left.kind}:${left.name}`, `${right.kind}:${right.name}`));
    }
}
function assertIdentity(extension) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(extension.name))
        throw new Error("Extension name is invalid.");
    if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(extension.version))
        throw new Error("Extension version must be semantic.");
    if (extension.provenance.trim().length === 0)
        throw new Error("Extension provenance is required.");
}
