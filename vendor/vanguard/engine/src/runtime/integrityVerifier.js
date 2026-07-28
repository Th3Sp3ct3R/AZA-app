import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SESSION_EXCLUDED_DIRECTORIES } from "./treeSnapshot.js";
export class WorkspaceIntegrityVerifier {
    name = "workspace integrity";
    #sourceRoot;
    #workspaceRoot;
    #protectedPaths;
    #editableRoots;
    constructor(options) {
        this.#sourceRoot = path.resolve(options.sourceRoot);
        this.#workspaceRoot = path.resolve(options.workspaceRoot);
        this.#protectedPaths = new Set((options.protectedPaths ?? []).map(normalizeRelative));
        this.#editableRoots = (options.editableRoots ?? []).map(normalizeRelative);
    }
    async verify(_candidate, _task) {
        const [source, workspace] = await Promise.all([
            snapshot(this.#sourceRoot),
            snapshot(this.#workspaceRoot),
        ]);
        const allPaths = new Set([...source.keys(), ...workspace.keys()]);
        const changedPaths = [...allPaths]
            .filter((file) => source.get(file) !== workspace.get(file))
            .sort();
        const protectedViolations = changedPaths.filter((file) => this.#protectedPaths.has(file));
        const scopeViolations = this.#editableRoots.length === 0
            ? []
            : changedPaths.filter((file) => !this.#editableRoots.some((root) => file === root || file.startsWith(`${root}/`)));
        const evidence = { changedPaths, protectedViolations, scopeViolations };
        return {
            verifier: this.name,
            passed: protectedViolations.length === 0 && scopeViolations.length === 0,
            evidence,
        };
    }
}
async function snapshot(root) {
    const resolvedRoot = await realpath(root);
    const result = new Map();
    const queue = [resolvedRoot];
    while (queue.length > 0) {
        const directory = queue.shift();
        if (directory === undefined)
            break;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            const relative = normalizeRelative(path.relative(resolvedRoot, absolute));
            if (entry.isDirectory()) {
                if (!SESSION_EXCLUDED_DIRECTORIES.has(entry.name))
                    queue.push(absolute);
                continue;
            }
            if (entry.isSymbolicLink()) {
                result.set(relative, "symbolic-link");
                continue;
            }
            if (entry.isFile()) {
                result.set(relative, createHash("sha256").update(await readFile(absolute)).digest("hex"));
            }
        }
    }
    return result;
}
function normalizeRelative(relative) {
    const normalized = relative.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    if (normalized.length === 0 || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
        throw new Error(`Integrity path must be a non-empty relative path: ${relative}`);
    }
    return normalized;
}
