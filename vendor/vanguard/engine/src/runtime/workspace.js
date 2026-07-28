import { realpathSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
export class WorkspaceBoundary {
    root;
    constructor(root) {
        this.root = realpathSync.native(path.resolve(root));
    }
    lexical(relativePath) {
        if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
            throw new Error("Workspace paths must be non-empty and relative.");
        }
        const candidate = path.resolve(this.root, relativePath);
        this.#assertContained(candidate);
        return candidate;
    }
    async existing(relativePath) {
        const candidate = this.lexical(relativePath);
        const resolved = await realpath(candidate);
        this.#assertContained(resolved);
        return resolved;
    }
    async writable(relativePath) {
        const candidate = this.lexical(relativePath);
        let ancestor = path.dirname(candidate);
        while (true) {
            try {
                await lstat(ancestor);
                break;
            }
            catch (error) {
                if (!isMissing(error))
                    throw error;
                const parent = path.dirname(ancestor);
                if (parent === ancestor)
                    throw new Error("No existing workspace ancestor.");
                ancestor = parent;
            }
        }
        const resolvedAncestor = await realpath(ancestor);
        this.#assertContained(resolvedAncestor);
        await mkdir(path.dirname(candidate), { recursive: true });
        return candidate;
    }
    #assertContained(candidate) {
        const relative = path.relative(this.root, candidate);
        if (relative === "")
            return;
        if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
            throw new Error(`Path escapes workspace: ${candidate}`);
        }
    }
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
