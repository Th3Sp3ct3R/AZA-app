import path from "node:path";
import { lowercaseInvariant } from "../deterministicText.js";
export class WorkspaceVersionLedger {
    #versions = new Map();
    #originals = new Map();
    record(relativePath, sha256) {
        const normalized = key(relativePath);
        this.#versions.set(normalized, sha256);
        this.#originals.set(normalized, relativePath);
    }
    get(relativePath) {
        return this.#versions.get(key(relativePath));
    }
    forget(relativePath) {
        const normalized = key(relativePath);
        this.#versions.delete(normalized);
        this.#originals.delete(normalized);
    }
    paths() {
        return [...this.#originals.values()];
    }
}
function key(relativePath) {
    const normalized = path.normalize(relativePath).replaceAll("\\", "/");
    return process.platform === "win32" ? lowercaseInvariant(normalized) : normalized;
}
