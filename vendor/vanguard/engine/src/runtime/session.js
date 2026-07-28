import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readlink, readdir, readFile, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asciiLowercase, compareOrdinal } from "../deterministicText.js";
import { SESSION_EXCLUDED_DIRECTORIES, atomicWriteJson, createFsLimiter, readTreeSnapshot, snapshotTree, } from "./treeSnapshot.js";
export async function createCodingSession(source, options = {}) {
    return materializeSessionWorkspace(await createSessionShell(source, options));
}
export async function createSessionShell(source, options = {}) {
    const sourceRoot = await realpath(path.resolve(source));
    if (!(await stat(sourceRoot)).isDirectory())
        throw new Error("Workspace must be a directory.");
    const direct = options.direct === true;
    const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-"));
    const workspaceRoot = path.join(container, "workspace");
    const id = path.basename(container);
    const session = {
        id,
        sourceRoot,
        workspaceRoot,
        metadataFile: path.join(container, "session.json"),
        baselineFile: path.join(container, "baseline.json"),
        materialized: false,
        ...(direct ? {} : { sourceFingerprint: await fingerprintSessionSource(sourceRoot) }),
        ...(direct || options.inPlace === true ? { inPlace: true } : {}),
        ...(direct ? { direct: true } : {}),
        createdAt: new Date().toISOString(),
    };
    await writeSessionMetadata(session);
    return session;
}
export async function createSessionShellAt(source, container, initialize, options = {}) {
    if (options.direct === true) {
        throw new Error("Durable sessions are identified by their source fingerprint, which direct mode never computes. Create a direct session without a durable container.");
    }
    const sourceRoot = await realpath(path.resolve(source));
    if (!(await stat(sourceRoot)).isDirectory())
        throw new Error("Workspace must be a directory.");
    const requestedContainer = path.resolve(container);
    const parent = path.dirname(requestedContainer);
    await mkdir(parent, { recursive: true });
    const existing = await openExistingSession(requestedContainer, sourceRoot);
    if (existing !== undefined)
        return assertRequestedSessionMode(existing, options);
    const staging = path.join(parent, `.${path.basename(requestedContainer)}.${randomUUID()}.tmp`);
    const session = {
        id: path.basename(requestedContainer),
        sourceRoot,
        workspaceRoot: path.join(requestedContainer, "workspace"),
        metadataFile: path.join(requestedContainer, "session.json"),
        baselineFile: path.join(requestedContainer, "baseline.json"),
        materialized: false,
        sourceFingerprint: await fingerprintSessionSource(sourceRoot),
        ...(options.inPlace === true ? { inPlace: true } : {}),
        createdAt: new Date().toISOString(),
    };
    await mkdir(staging);
    try {
        await writeSessionMetadataTo(path.join(staging, "session.json"), session);
        await initialize?.(staging, session);
        await syncFile(path.join(staging, "session.json"));
        await syncDirectoryBestEffort(staging);
        try {
            await rename(staging, requestedContainer);
            await syncDirectoryBestEffort(parent);
        }
        catch (error) {
            const winner = await openExistingSession(requestedContainer, sourceRoot);
            if (winner === undefined)
                throw error;
            return assertRequestedSessionMode(winner, options);
        }
        return openCodingSession(requestedContainer);
    }
    finally {
        await rm(staging, { recursive: true, force: true });
    }
}
function assertRequestedSessionMode(session, options) {
    if ((session.inPlace === true) !== (options.inPlace === true) || session.direct === true) {
        throw new Error("The existing durable session uses a different workspace mode.");
    }
    return session;
}
export async function materializeSessionWorkspace(session, options = {}) {
    if (session.materialized)
        return session;
    if (session.direct === true) {
        const materialized = { ...session, materialized: true };
        await writeSessionMetadata(materialized);
        return { ...materialized, workspaceRoot: session.sourceRoot };
    }
    const container = await realpath(path.dirname(session.metadataFile));
    if (path.dirname(session.workspaceRoot) !== container)
        throw new Error("Session workspace is outside its container.");
    const sourceFingerprintBeforeCopy = await fingerprintSessionSource(session.sourceRoot);
    const sourceChanged = session.sourceFingerprint !== undefined
        && sourceFingerprintBeforeCopy !== session.sourceFingerprint;
    const temporary = path.join(container, `.workspace-${randomUUID()}.tmp`);
    try {
        await (options.copyWorkspace ?? copySessionWorkspace)(session.sourceRoot, temporary);
        const sourceFingerprintAfterCopy = await fingerprintSessionSource(session.sourceRoot);
        if (sourceFingerprintAfterCopy !== sourceFingerprintBeforeCopy) {
            throw new Error("Source changed while materializing the session workspace; no workspace was published.");
        }
        const copiedFingerprint = await fingerprintSessionSource(temporary);
        if (copiedFingerprint !== sourceFingerprintAfterCopy) {
            throw new Error("Materialized workspace copy does not match the source; no workspace was published.");
        }
        const baseline = await snapshotTree(temporary);
        await rm(session.workspaceRoot, { recursive: true, force: true });
        await rename(temporary, session.workspaceRoot);
        await atomicWriteJson(session.baselineFile, baseline);
    }
    finally {
        await rm(temporary, { recursive: true, force: true });
    }
    const materialized = {
        ...session,
        materialized: true,
        ...(sourceChanged ? { sourceChangedDuringConversation: true } : {}),
    };
    await writeSessionMetadata(materialized);
    if (session.inPlace === true) {
        return {
            ...materialized,
            workspaceRoot: session.sourceRoot,
            pristineRoot: path.join(container, "workspace"),
        };
    }
    return materialized;
}
async function copySessionWorkspace(sourceRoot, destinationRoot) {
    await mkdir(destinationRoot, { recursive: true });
    const fileJobs = [];
    const queue = [{ source: sourceRoot, destination: destinationRoot }];
    while (queue.length > 0) {
        const { source, destination } = queue.shift();
        for (const entry of await readdir(source, { withFileTypes: true })) {
            const sourcePath = path.join(source, entry.name);
            if (!shouldCopy(sourcePath))
                continue;
            const destinationPath = path.join(destination, entry.name);
            const details = await lstat(sourcePath);
            if (details.isSymbolicLink()) {
                const target = await readlink(sourcePath);
                const targetIsDirectory = await stat(sourcePath).then((meta) => meta.isDirectory(), () => false);
                await symlink(target, destinationPath, targetIsDirectory ? "junction" : "file");
            }
            else if (details.isDirectory()) {
                await mkdir(destinationPath, { recursive: true });
                queue.push({ source: sourcePath, destination: destinationPath });
            }
            else if (details.isFile()) {
                fileJobs.push(async () => {
                    try {
                        await copyFile(sourcePath, destinationPath);
                    }
                    catch (error) {
                        if (!isLockedFileError(error))
                            throw error;
                    }
                });
            }
        }
    }
    await runFilePool(fileJobs);
}
export async function createForkedCodingSession(parent, checkpointWorkspace, lineage) {
    const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-"));
    const workspaceRoot = path.join(container, "workspace");
    const baselineFile = path.join(container, "baseline.json");
    const metadataFile = path.join(container, "session.json");
    try {
        await copySessionWorkspace(checkpointWorkspace, workspaceRoot);
        const baseline = await loadSessionBaseline(parent);
        await atomicWriteJson(baselineFile, baseline);
        const session = {
            id: path.basename(container),
            sourceRoot: parent.sourceRoot,
            workspaceRoot,
            metadataFile,
            baselineFile,
            materialized: true,
            ...(parent.sourceFingerprint === undefined ? {} : { sourceFingerprint: parent.sourceFingerprint }),
            ...(parent.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
            ...(parent.journalGenesisHash === undefined ? {} : { journalGenesisHash: parent.journalGenesisHash }),
            lineage,
            createdAt: new Date().toISOString(),
        };
        await writeSessionMetadata(session);
        return session;
    }
    catch (error) {
        await rm(container, { recursive: true, force: true });
        throw error;
    }
}
export async function openCodingSession(location) {
    let requested = path.resolve(location);
    const metadata = await stat(requested);
    if (metadata.isFile())
        requested = path.dirname(requested);
    if (asciiLowercase(path.basename(requested)) === "workspace")
        requested = path.dirname(requested);
    const container = await realpath(requested);
    const metadataFile = path.join(container, "session.json");
    const parsed = JSON.parse(await readFile(metadataFile, "utf8"));
    if (typeof parsed.id !== "string" || typeof parsed.sourceRoot !== "string" || typeof parsed.workspaceRoot !== "string") {
        throw new Error("Session metadata is malformed.");
    }
    const materialized = parsed.materialized !== false;
    const direct = parsed.direct === true;
    const expectedWorkspace = path.join(container, "workspace");
    if (path.resolve(parsed.workspaceRoot) !== expectedWorkspace) {
        throw new Error("Session workspace does not belong to the requested session container.");
    }
    if (materialized && !direct)
        await recoverInterruptedWorkspaceSwap(container, expectedWorkspace);
    const sourcePath = path.resolve(parsed.sourceRoot);
    if ((await lstat(sourcePath)).isSymbolicLink()) {
        throw new Error("Session source root was replaced by a symbolic link or junction.");
    }
    if (materialized && !direct && (await lstat(expectedWorkspace)).isSymbolicLink()) {
        throw new Error("Session workspace root was replaced by a symbolic link or junction.");
    }
    const workspaceRoot = materialized && !direct
        ? await realpath(parsed.workspaceRoot)
        : path.join(container, "workspace");
    if (path.dirname(workspaceRoot) !== container) {
        throw new Error("Session workspace does not belong to the requested session container.");
    }
    const lineage = validateLineage(parsed.lineage);
    const inPlace = parsed.inPlace === true || direct;
    const resolvedSource = await realpath(sourcePath);
    return {
        id: parsed.id,
        sourceRoot: resolvedSource,
        workspaceRoot: inPlace && materialized ? resolvedSource : workspaceRoot,
        metadataFile,
        baselineFile: path.join(container, "baseline.json"),
        materialized,
        ...(typeof parsed.sourceFingerprint === "string" ? { sourceFingerprint: parsed.sourceFingerprint } : {}),
        ...(parsed.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
        ...(typeof parsed.journalGenesisHash === "string" ? { journalGenesisHash: parsed.journalGenesisHash } : {}),
        ...(lineage === undefined ? {} : { lineage }),
        ...(inPlace ? { inPlace: true } : {}),
        ...(inPlace && materialized && !direct ? { pristineRoot: workspaceRoot } : {}),
        ...(direct ? { direct: true } : {}),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
    };
}
export async function loadSessionBaseline(session) {
    if (session.direct === true) {
        throw new Error("Direct sessions record no baseline: edits land straight in the project, so there is nothing to diff, apply, or undo. Use version control.");
    }
    if (!session.materialized)
        throw new Error("Session workspace has not been materialized.");
    try {
        return await readTreeSnapshot(session.baselineFile);
    }
    catch (error) {
        if (isMissing(error)) {
            throw new Error("Session predates deterministic baselines and cannot be safely applied; create a new session.");
        }
        throw error;
    }
}
const LARGE_FILE_IDENTITY_BYTES = 8 * 1024 * 1024;
const FILE_IO_CONCURRENCY = 8;
const FINGERPRINT_RACY_MTIME_SLOP_MS = 2_000;
class SourceFingerprintCache {
    #entries = new Map();
    lookup(absolutePath, stats) {
        const cached = this.#entries.get(absolutePath);
        if (cached === undefined)
            return undefined;
        if (cached.size !== stats.size || cached.mtimeMs !== stats.mtimeMs || cached.ctimeMs !== stats.ctimeMs)
            return undefined;
        if (cached.mtimeMs + FINGERPRINT_RACY_MTIME_SLOP_MS >= cached.hashedAtMs)
            return undefined;
        return cached.digest;
    }
    store(absolutePath, stats, digest) {
        this.#entries.set(absolutePath, {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            ctimeMs: stats.ctimeMs,
            digest,
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
const SOURCE_FINGERPRINT_CACHE_ROOTS = 8;
const sourceFingerprintCaches = new Map();
function sourceFingerprintCacheFor(root) {
    const key = path.resolve(root);
    const existing = sourceFingerprintCaches.get(key);
    if (existing !== undefined)
        return existing;
    if (sourceFingerprintCaches.size >= SOURCE_FINGERPRINT_CACHE_ROOTS) {
        const oldest = sourceFingerprintCaches.keys().next().value;
        if (oldest !== undefined)
            sourceFingerprintCaches.delete(oldest);
    }
    const created = new SourceFingerprintCache();
    sourceFingerprintCaches.set(key, created);
    return created;
}
async function runFilePool(jobs, limit = FILE_IO_CONCURRENCY) {
    const results = new Array(jobs.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
        while (true) {
            const index = next;
            next += 1;
            if (index >= jobs.length)
                return;
            results[index] = await jobs[index]();
        }
    });
    await Promise.all(workers);
    return results;
}
export async function fingerprintSessionSource(root) {
    const cache = sourceFingerprintCacheFor(root);
    const entries = [];
    const hashJobs = [];
    const seenFiles = new Set();
    const limitFs = createFsLimiter(FINGERPRINT_FS_CONCURRENCY);
    const walk = async (directory) => {
        const children = await limitFs(() => readdir(directory, { withFileTypes: true }));
        const subdirectories = [];
        await Promise.all(children.map(async (entry) => {
            const absolute = path.join(directory, entry.name);
            const relative = path.relative(root, absolute).replaceAll("\\", "/");
            const details = await limitFs(() => lstat(absolute));
            if (details.isSymbolicLink()) {
                const target = await limitFs(() => readlink(absolute));
                entries.push(JSON.stringify(["link", relative, target]));
            }
            else if (details.isDirectory()) {
                if (!SESSION_EXCLUDED_DIRECTORIES.has(entry.name)) {
                    entries.push(JSON.stringify(["directory", relative, details.mode & 0o7777]));
                    subdirectories.push(absolute);
                }
            }
            else if (details.isFile()) {
                if (details.size > LARGE_FILE_IDENTITY_BYTES) {
                    entries.push(JSON.stringify(["file", relative, details.mode & 0o7777, details.size, `large:${details.size}`]));
                    return;
                }
                const cached = cache.lookup(absolute, details);
                if (cached !== undefined) {
                    seenFiles.add(absolute);
                    entries.push(JSON.stringify(["file", relative, details.mode & 0o7777, details.size, cached]));
                    return;
                }
                hashJobs.push(async () => {
                    const digest = await hashStableFileOrLocked(absolute, details);
                    if (digest === undefined)
                        return undefined;
                    seenFiles.add(absolute);
                    cache.store(absolute, details, digest);
                    return JSON.stringify(["file", relative, details.mode & 0o7777, details.size, digest]);
                });
            }
            else {
                throw new Error(`Source contains unsupported filesystem entry: ${relative}`);
            }
        }));
        await Promise.all(subdirectories.map((subdirectory) => walk(subdirectory)));
    };
    await walk(root);
    for (const hashed of await runFilePool(hashJobs)) {
        if (hashed !== undefined)
            entries.push(hashed);
    }
    cache.retainOnly(seenFiles);
    entries.sort(compareOrdinal);
    return createHash("sha256").update(entries.join("\n")).digest("hex");
}
const FINGERPRINT_FS_CONCURRENCY = 16;
export function isLockedFileError(error) {
    if (!(error instanceof Error) || !("code" in error))
        return false;
    return error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES";
}
async function hashStableFileOrLocked(file, observed) {
    try {
        return await hashStableFile(file, observed);
    }
    catch (error) {
        if (isLockedFileError(error))
            return undefined;
        throw error;
    }
}
async function hashStableFile(file, observed) {
    const handle = await open(file, "r");
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameFileVersion(observed, opened)) {
            throw new Error(`Source file changed while fingerprinting: ${file}`);
        }
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
        const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(file)]);
        if (!afterPath.isFile() || !sameFileVersion(opened, afterHandle) || !sameFileVersion(afterHandle, afterPath)) {
            throw new Error(`Source file changed while fingerprinting: ${file}`);
        }
        return hash.digest("hex");
    }
    finally {
        await handle.close();
    }
}
function sameFileVersion(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && (left.mode & 0o7777) === (right.mode & 0o7777)
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}
async function writeSessionMetadata(session) {
    await writeSessionMetadataTo(session.metadataFile, session);
}
async function writeSessionMetadataTo(file, session) {
    const canonicalWorkspaceRoot = session.inPlace === true
        ? path.join(path.dirname(session.metadataFile), "workspace")
        : session.workspaceRoot;
    await atomicWriteJson(file, {
        id: session.id,
        sourceRoot: session.sourceRoot,
        workspaceRoot: canonicalWorkspaceRoot,
        materialized: session.materialized,
        ...(session.sourceFingerprint === undefined ? {} : { sourceFingerprint: session.sourceFingerprint }),
        ...(session.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
        ...(session.journalGenesisHash === undefined ? {} : { journalGenesisHash: session.journalGenesisHash }),
        ...(session.lineage === undefined ? {} : { lineage: session.lineage }),
        ...(session.inPlace === true ? { inPlace: true } : {}),
        ...(session.direct === true ? { direct: true } : {}),
        createdAt: session.createdAt,
    });
}
async function openExistingSession(container, sourceRoot) {
    try {
        const metadata = await lstat(container);
        if (metadata.isSymbolicLink())
            throw new Error("Session container cannot be a symbolic link or junction.");
        if (!metadata.isDirectory())
            throw new Error("Session container must be a directory.");
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
    const session = await openCodingSession(container);
    if (path.resolve(session.sourceRoot) !== path.resolve(sourceRoot)) {
        throw new Error("Existing durable session belongs to a different source workspace.");
    }
    return session;
}
async function syncFile(file) {
    const handle = await open(file, "r+");
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function syncDirectoryBestEffort(directory) {
    let handle;
    try {
        handle = await open(directory, "r");
        await handle.sync();
    }
    catch (error) {
        if (!(error instanceof Error && "code" in error
            && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(error.code))))
            throw error;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
function shouldCopy(candidate) {
    return !SESSION_EXCLUDED_DIRECTORIES.has(path.basename(candidate));
}
function validateLineage(value) {
    if (value === undefined)
        return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Session lineage is malformed.");
    const lineage = value;
    if (typeof lineage.parentSessionId !== "string"
        || typeof lineage.parentCheckpointId !== "string"
        || typeof lineage.parentJournalHash !== "string"
        || !/^[a-f0-9]{64}$/.test(lineage.parentJournalHash))
        throw new Error("Session lineage is malformed.");
    return lineage;
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function recoverInterruptedWorkspaceSwap(container, workspaceRoot) {
    const marker = path.join(container, "time-travel", "restore.json");
    try {
        const parsed = JSON.parse(await readFile(marker, "utf8"));
        if (parsed.version !== 1 || typeof parsed.restoreId !== "string" || !/^restore-[a-f0-9-]+$/.test(parsed.restoreId)
            || typeof parsed.checkpointId !== "string"
            || !/^checkpoint-[a-f0-9-]+$/.test(parsed.checkpointId)
            || !["prepared", "old_moved", "new_moved", "committed"].includes(parsed.state ?? ""))
            throw new Error("Restore recovery marker is malformed.");
        const journal = await readFile(path.join(container, "run.jsonl"), "utf8").catch(() => "");
        if (parsed.state === "committed" || (journal.includes(parsed.restoreId) && journal.includes('"type":"session.restored"'))) {
            await rm(path.join(container, "workspace.restore-backup"), { recursive: true, force: true });
            await rm(path.join(container, "workspace.restore-new"), { recursive: true, force: true });
            await rm(path.join(container, "time-travel", "restore-state-new"), { recursive: true, force: true });
            await rm(path.join(container, "time-travel", "restore-state-backup"), { recursive: true, force: true });
            await rm(marker, { force: true });
            return;
        }
    }
    catch (error) {
        if (isMissing(error))
            return;
        throw error;
    }
    const backup = path.join(container, "workspace.restore-backup");
    const staged = path.join(container, "workspace.restore-new");
    const stateBackup = path.join(container, "time-travel", "restore-state-backup");
    await restoreOptionalStateBackup(stateBackup, container);
    try {
        await stat(backup);
        await rm(workspaceRoot, { recursive: true, force: true });
        await rename(backup, workspaceRoot);
    }
    catch (error) {
        if (!isMissing(error))
            throw error;
    }
    await rm(staged, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    await rm(path.join(container, "time-travel", "restore-state-new"), { recursive: true, force: true });
    await rm(stateBackup, { recursive: true, force: true });
    await rm(marker, { force: true });
}
async function restoreOptionalStateBackup(source, container) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path.join(source, "presence.json"), "utf8"));
    }
    catch (error) {
        if (isMissing(error))
            return;
        throw error;
    }
    const allowed = ["run-config.json", "plan.json", "checkpoint.json", "delegations.json"];
    if (parsed.version !== 1 || !Array.isArray(parsed.present)
        || !parsed.present.every((name) => typeof name === "string" && allowed.includes(name)))
        throw new Error("Restore state backup is malformed.");
    const present = new Set(parsed.present);
    for (const name of allowed) {
        const target = path.join(container, name);
        if (!present.has(name)) {
            await rm(target, { force: true });
            continue;
        }
        const temporary = `${target}.restore.tmp`;
        await copyFile(path.join(source, name), temporary);
        try {
            await rm(target, { force: true });
            await rename(temporary, target);
        }
        finally {
            await rm(temporary, { force: true });
        }
    }
}
