import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile, } from "node:fs/promises";
import path from "node:path";
export const SESSION_EXCLUDED_DIRECTORIES = new Set([".git", ".vanguard", "node_modules"]);
const RACY_MTIME_SLOP_MS = 2_000;
export class TreeSnapshotCache {
    #root;
    #entries = new Map();
    bindRoot(root) {
        if (this.#root === undefined) {
            this.#root = root;
            return;
        }
        if (this.#root !== root) {
            throw new Error("Tree snapshot cache is bound to a different root.");
        }
    }
    lookup(absolutePath, stats) {
        const cached = this.#entries.get(absolutePath);
        if (cached === undefined)
            return undefined;
        if (cached.size !== stats.size || cached.mtimeMs !== stats.mtimeMs || cached.ctimeMs !== stats.ctimeMs)
            return undefined;
        if (cached.mtimeMs + RACY_MTIME_SLOP_MS >= cached.hashedAtMs)
            return undefined;
        return cached;
    }
    store(absolutePath, stats, digest, binary) {
        this.#entries.set(absolutePath, {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            ctimeMs: stats.ctimeMs,
            sha256: digest,
            binary,
            hashedAtMs: Date.now(),
        });
    }
    retainOnly(seen) {
        for (const key of this.#entries.keys()) {
            if (!seen.has(key))
                this.#entries.delete(key);
        }
    }
}
const SNAPSHOT_FS_CONCURRENCY = 16;
export function createFsLimiter(limit) {
    let active = 0;
    const waiters = [];
    return async (operation) => {
        if (active >= limit)
            await new Promise((resolve) => waiters.push(resolve));
        active += 1;
        try {
            return await operation();
        }
        finally {
            active -= 1;
            waiters.shift()?.();
        }
    };
}
export async function snapshotTree(root, options = {}) {
    const requestedRoot = path.resolve(root);
    const rootMetadata = await lstat(requestedRoot);
    if (rootMetadata.isSymbolicLink())
        throw new Error("Snapshot root cannot be a symbolic link or junction.");
    const absoluteRoot = await realpath(requestedRoot);
    if (!(await stat(absoluteRoot)).isDirectory())
        throw new Error("Snapshot root must be a directory.");
    const entries = [];
    const excludedDirectories = options.excludedDirectories ?? SESSION_EXCLUDED_DIRECTORIES;
    const cache = options.cache;
    cache?.bindRoot(absoluteRoot);
    const seenFiles = new Set();
    const limitFs = createFsLimiter(SNAPSHOT_FS_CONCURRENCY);
    const snapshotFile = async (absolute, relative, details) => {
        const cached = cache?.lookup(absolute, details);
        if (cached !== undefined) {
            seenFiles.add(absolute);
            entries.push({
                path: relative,
                kind: "file",
                sha256: cached.sha256,
                size: cached.size,
                mode: details.mode & 0o777,
                binary: cached.binary,
            });
            return;
        }
        let contents;
        try {
            contents = await limitFs(() => readFile(absolute));
        }
        catch (error) {
            if (isLockedError(error))
                return;
            throw error;
        }
        seenFiles.add(absolute);
        const digest = sha256(contents);
        const binary = contents.subarray(0, 8_192).includes(0);
        entries.push({
            path: relative,
            kind: "file",
            sha256: digest,
            size: contents.byteLength,
            mode: details.mode & 0o777,
            binary,
        });
        const settled = await limitFs(() => lstat(absolute)).catch(() => undefined);
        if (settled !== undefined
            && settled.isFile()
            && settled.size === contents.byteLength
            && settled.mtimeMs === details.mtimeMs
            && settled.ctimeMs === details.ctimeMs) {
            cache?.store(absolute, settled, digest, binary);
        }
    };
    const walk = async (directory) => {
        const children = await limitFs(() => readdir(directory, { withFileTypes: true }));
        const subdirectories = [];
        await Promise.all(children.map(async (child) => {
            const absolute = path.join(directory, child.name);
            if (child.isDirectory() && !child.isSymbolicLink()) {
                if (!excludedDirectories.has(child.name))
                    subdirectories.push(absolute);
                return;
            }
            const relative = normalizeRelative(path.relative(absoluteRoot, absolute));
            const details = await limitFs(() => lstat(absolute));
            if (details.isSymbolicLink()) {
                const target = await limitFs(() => readlink(absolute));
                entries.push({
                    path: relative,
                    kind: "symlink",
                    sha256: sha256(Buffer.from(target, "utf8")),
                    size: Buffer.byteLength(target),
                    mode: details.mode & 0o777,
                    binary: false,
                    linkTarget: target,
                });
            }
            else if (details.isDirectory()) {
                if (!excludedDirectories.has(child.name))
                    subdirectories.push(absolute);
            }
            else if (details.isFile()) {
                await snapshotFile(absolute, relative, details);
            }
        }));
        await Promise.all(subdirectories.map((subdirectory) => walk(subdirectory)));
    };
    await walk(absoluteRoot);
    cache?.retainOnly(seenFiles);
    entries.sort((left, right) => compareText(left.path, right.path));
    const canonical = JSON.stringify(entries);
    return { version: 1, rootHash: sha256(Buffer.from(canonical, "utf8")), entries };
}
export function validateTreeSnapshot(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Tree snapshot is malformed.");
    const snapshot = value;
    if (snapshot.version !== 1 || !isSha256(snapshot.rootHash) || !Array.isArray(snapshot.entries)) {
        throw new Error("Tree snapshot is malformed.");
    }
    let previous = "";
    for (const raw of snapshot.entries) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Tree snapshot is malformed.");
        const entry = raw;
        if (typeof entry.path !== "string"
            || (entry.kind !== "file" && entry.kind !== "symlink")
            || !isSha256(entry.sha256)
            || !Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0
            || !Number.isSafeInteger(entry.mode) || (entry.mode ?? -1) < 0
            || typeof entry.binary !== "boolean")
            throw new Error("Tree snapshot is malformed.");
        assertSafeRelativePath(entry.path);
        if (compareText(entry.path, previous) <= 0)
            throw new Error("Tree snapshot entries are not canonical.");
        if (entry.kind === "symlink" && typeof entry.linkTarget !== "string")
            throw new Error("Tree snapshot is malformed.");
        previous = entry.path;
    }
    const expected = sha256(Buffer.from(JSON.stringify(snapshot.entries), "utf8"));
    if (expected !== snapshot.rootHash)
        throw new Error("Tree snapshot integrity failure.");
}
export async function readTreeSnapshot(file) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    validateTreeSnapshot(parsed);
    return parsed;
}
export async function atomicWriteJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temporary, file);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
export async function safeRoot(root) {
    const requested = path.resolve(root);
    const requestedMetadata = await lstat(requested);
    if (requestedMetadata.isSymbolicLink())
        throw new Error("Boundary root cannot be a symbolic link or junction.");
    const resolved = await realpath(requested);
    if (!(await stat(resolved)).isDirectory())
        throw new Error("Boundary root must be a directory.");
    return resolved;
}
export async function linkSafePath(root, relativePath) {
    assertSafeRelativePath(relativePath);
    const canonicalRoot = await safeRoot(root);
    const nativeRelative = relativePath.split("/").join(path.sep);
    const candidate = path.resolve(canonicalRoot, nativeRelative);
    const relative = path.relative(canonicalRoot, candidate);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path escapes boundary: ${relativePath}`);
    }
    let cursor = canonicalRoot;
    for (const segment of nativeRelative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        try {
            const details = await lstat(cursor);
            if (details.isSymbolicLink())
                throw new Error(`Symbolic-link or junction path is not writable: ${relativePath}`);
        }
        catch (error) {
            if (isMissing(error))
                break;
            throw error;
        }
    }
    return candidate;
}
export async function copyFileWithMode(source, destination, mode) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    if (process.platform !== "win32")
        await chmod(destination, mode);
}
export function assertSafeRelativePath(relativePath) {
    if (relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
        throw new Error(`Unsafe relative path: ${relativePath}`);
    }
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized !== relativePath || normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
        throw new Error(`Unsafe relative path: ${relativePath}`);
    }
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function isSha256(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function normalizeRelative(value) {
    const normalized = value.replaceAll("\\", "/");
    assertSafeRelativePath(normalized);
    return normalized;
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isLockedError(error) {
    if (!(error instanceof Error) || !("code" in error))
        return false;
    return error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES";
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
