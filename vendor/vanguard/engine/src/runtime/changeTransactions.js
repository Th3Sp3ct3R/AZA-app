import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lowercaseInvariant } from "../deterministicText.js";
import { loadSessionBaseline } from "./session.js";
import { appendSessionEvent } from "./sessionJournal.js";
import { withSessionLease } from "./sessionLease.js";
import { SESSION_EXCLUDED_DIRECTORIES, assertSafeRelativePath, atomicWriteJson, copyFileWithMode, isSha256, linkSafePath, sha256, snapshotTree, } from "./treeSnapshot.js";
export async function reviewSessionChanges(session, journal) {
    return withSessionLease(path.dirname(session.metadataFile), "change.review", () => reviewSessionChangesUnlocked(session, journal));
}
async function reviewSessionChangesUnlocked(session, journal) {
    requireMaterialized(session);
    const baseline = await loadSessionBaseline(session);
    const candidate = await snapshotTree(session.workspaceRoot);
    const manifest = buildPatchManifest(session.id, baseline, candidate);
    const directory = path.join(path.dirname(session.metadataFile), "reviews");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${manifest.manifestHash}.json`);
    let created = false;
    try {
        await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        created = true;
    }
    catch (error) {
        if (!isExisting(error))
            throw error;
        const existing = await loadPatchManifest(file);
        if (JSON.stringify(existing) !== JSON.stringify(manifest))
            throw new Error("Reviewed manifest hash collision.");
    }
    try {
        await appendSessionEvent(journal, "change.reviewed", {
            manifestHash: manifest.manifestHash,
            baselineRootHash: manifest.baselineRootHash,
            candidateRootHash: manifest.candidateRootHash,
            changes: manifest.changes.length,
        });
    }
    catch (error) {
        if (created)
            await rm(file, { force: true });
        throw error;
    }
    return manifest;
}
export function buildPatchManifest(sessionId, baseline, candidate) {
    const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const after = new Map(candidate.entries.map((entry) => [entry.path, entry]));
    const deleted = [];
    const added = [];
    const changes = [];
    for (const entry of baseline.entries) {
        const current = after.get(entry.path);
        if (current === undefined)
            deleted.push(entry);
        else if (!sameEntry(entry, current)) {
            changes.push({
                kind: "modify",
                path: entry.path,
                before: entry,
                after: current,
                binary: entry.binary || current.binary,
                supported: entry.kind === "file" && current.kind === "file",
            });
        }
    }
    for (const entry of candidate.entries)
        if (!before.has(entry.path))
            added.push(entry);
    deleted.sort(entryOrder);
    added.sort(entryOrder);
    const usedAdded = new Set();
    const renamedDeleted = new Set();
    for (const prior of deleted) {
        if (prior.kind !== "file")
            continue;
        const replacement = added.find((entry) => !usedAdded.has(entry.path) && entry.kind === "file" && entry.sha256 === prior.sha256);
        if (replacement === undefined)
            continue;
        usedAdded.add(replacement.path);
        renamedDeleted.add(prior.path);
        changes.push({
            kind: "rename",
            fromPath: prior.path,
            toPath: replacement.path,
            before: prior,
            after: replacement,
            binary: prior.binary || replacement.binary,
            supported: true,
        });
    }
    for (const entry of deleted) {
        if (!renamedDeleted.has(entry.path))
            changes.push({
                kind: "delete",
                path: entry.path,
                before: entry,
                binary: entry.binary,
                supported: entry.kind === "file",
            });
    }
    for (const entry of added) {
        if (!usedAdded.has(entry.path))
            changes.push({
                kind: "add",
                path: entry.path,
                after: entry,
                binary: entry.binary,
                supported: entry.kind === "file",
            });
    }
    changes.sort(changeOrder);
    const core = {
        version: 1,
        sessionId,
        baselineRootHash: baseline.rootHash,
        candidateRootHash: candidate.rootHash,
        changes,
    };
    return { ...core, manifestHash: manifestDigest(core) };
}
export async function applyReviewedManifest(session, journal, manifestHash, confirmation, testOptions = {}) {
    if (session.inPlace === true) {
        throw new Error("In-place sessions have no apply step: changes are already live in the project.");
    }
    return withSessionLease(path.dirname(session.metadataFile), "change.apply", () => applyReviewedManifestUnlocked(session, journal, manifestHash, confirmation, testOptions));
}
async function applyReviewedManifestUnlocked(session, journal, manifestHash, confirmation, testOptions = {}) {
    requireMaterialized(session);
    if (!isSha256(manifestHash) || confirmation !== manifestHash) {
        throw new Error("Apply requires --manifest and an exact --confirm copy of its SHA-256 hash.");
    }
    return withSourceLock(session.sourceRoot, async () => {
        await recoverApplyTransactionsUnlocked(session);
        const manifest = await loadReviewedManifest(session, journal, manifestHash);
        if (manifest.changes.length === 0)
            throw new Error("Reviewed manifest has no changes to apply.");
        if (manifest.changes.some((change) => !change.supported)) {
            throw new Error("Reviewed manifest contains symbolic-link or unsupported filesystem changes.");
        }
        const baseline = await loadSessionBaseline(session);
        if (manifest.baselineRootHash !== baseline.rootHash)
            throw new Error("Reviewed manifest does not match the session baseline.");
        const [sourceNow, candidateNow] = await Promise.all([
            snapshotTree(session.sourceRoot),
            snapshotTree(session.workspaceRoot),
        ]);
        if (sourceNow.rootHash !== baseline.rootHash) {
            throw new Error(`Original project drifted since session materialization (${sourceNow.rootHash} != ${baseline.rootHash}); apply refused.`);
        }
        if (candidateNow.rootHash !== manifest.candidateRootHash) {
            throw new Error("Session workspace changed after review; generate and inspect a new manifest.");
        }
        const transitions = manifestTransitions(manifest);
        await validateTransitions(session, transitions);
        const transaction = await stageTransaction(session, manifest, transitions);
        let mutable = transaction;
        try {
            const [sourcePrepared, candidatePrepared] = await Promise.all([
                snapshotTree(session.sourceRoot),
                snapshotTree(session.workspaceRoot),
            ]);
            if (sourcePrepared.rootHash !== transaction.beforeRootHash) {
                throw new Error("Original project changed during apply staging; apply refused.");
            }
            if (candidatePrepared.rootHash !== transaction.afterRootHash) {
                throw new Error("Session workspace changed during apply staging; apply refused.");
            }
            mutable = await updateTransaction(session, { ...mutable, state: "applying" });
            mutable = await synchronizeTreeState(session.sourceRoot, transactionRoot(session, mutable.id), mutable, "after", testOptions);
            const applied = await snapshotTree(session.sourceRoot);
            if (applied.rootHash !== manifest.candidateRootHash) {
                throw new Error(`Apply postcondition failed (${applied.rootHash} != ${manifest.candidateRootHash}).`);
            }
            mutable = await updateTransaction(session, { ...mutable, state: "applied" });
            const result = {
                transactionId: mutable.id,
                manifestHash,
                beforeRootHash: mutable.beforeRootHash,
                afterRootHash: mutable.afterRootHash,
                changedPaths: mutable.transitions.map((transition) => transition.path),
            };
            await appendSessionEvent(journal, "change.applied", result);
            return result;
        }
        catch (error) {
            if (error instanceof SimulatedCrash)
                throw error;
            if (mutable.state === "prepared") {
                await updateTransaction(session, { ...mutable, state: "rolled_back", failure: errorMessage(error) });
                throw error;
            }
            try {
                mutable = await updateTransaction(session, {
                    ...mutable,
                    state: "rolling_back",
                    failure: errorMessage(error),
                });
                mutable = await synchronizeTreeState(session.sourceRoot, transactionRoot(session, mutable.id), mutable, "before");
                const restored = await snapshotTree(session.sourceRoot);
                if (restored.rootHash !== mutable.beforeRootHash)
                    throw new Error("Rollback postcondition failed.");
                await updateTransaction(session, { ...mutable, state: "rolled_back" });
            }
            catch (rollbackError) {
                throw new Error(`Apply failed (${errorMessage(error)}) and rollback failed (${errorMessage(rollbackError)}).`);
            }
            throw error;
        }
    });
}
export async function undoAppliedTransaction(session, journal, transactionId, confirmation, testOptions = {}) {
    return withSessionLease(path.dirname(session.metadataFile), "change.undo", () => undoAppliedTransactionUnlocked(session, journal, transactionId, confirmation, testOptions));
}
async function undoAppliedTransactionUnlocked(session, journal, transactionId, confirmation, testOptions = {}) {
    requireMaterialized(session);
    if (!/^apply-[a-f0-9-]+$/.test(transactionId) || confirmation !== transactionId) {
        throw new Error("Undo requires --apply and an exact --confirm copy of the transaction ID.");
    }
    return withSourceLock(session.sourceRoot, async () => {
        await recoverApplyTransactionsUnlocked(session);
        let transaction = await loadTransaction(session, transactionId);
        if (transaction.state !== "applied")
            throw new Error(`Transaction ${transactionId} is not currently applied.`);
        const sourceNow = await snapshotTree(session.sourceRoot);
        if (sourceNow.rootHash !== transaction.afterRootHash) {
            throw new Error("Original project changed after apply; undo refused to protect user edits.");
        }
        try {
            transaction = await updateTransaction(session, { ...transaction, state: "reverting", completedOperations: 0 });
            transaction = await synchronizeTreeState(session.sourceRoot, transactionRoot(session, transaction.id), transaction, "before", testOptions);
            const restored = await snapshotTree(session.sourceRoot);
            if (restored.rootHash !== transaction.beforeRootHash)
                throw new Error("Undo postcondition failed.");
            await updateTransaction(session, { ...transaction, state: "reverted" });
            const result = { transactionId, restoredRootHash: restored.rootHash };
            await appendSessionEvent(journal, "change.reverted", result);
            return result;
        }
        catch (error) {
            if (error instanceof SimulatedCrash)
                throw error;
            try {
                transaction = await synchronizeTreeState(session.sourceRoot, transactionRoot(session, transaction.id), transaction, "after");
                await updateTransaction(session, { ...transaction, state: "applied", completedOperations: 0 });
            }
            catch (rollbackError) {
                throw new Error(`Undo failed (${errorMessage(error)}) and rollback failed (${errorMessage(rollbackError)}).`);
            }
            throw error;
        }
    });
}
export async function recoverApplyTransactions(session) {
    return withSessionLease(path.dirname(session.metadataFile), "change.recovery", () => recoverApplyTransactionsUnlocked(session));
}
async function recoverApplyTransactionsUnlocked(session) {
    const directory = path.join(path.dirname(session.metadataFile), "transactions");
    let children;
    try {
        children = await readdir(directory);
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw error;
    }
    const recovered = [];
    for (const child of children.sort()) {
        if (!child.startsWith("apply-"))
            continue;
        const transaction = await loadTransaction(session, child);
        if (transaction.state === "prepared") {
            const current = await snapshotTree(session.sourceRoot);
            if (current.rootHash !== transaction.beforeRootHash) {
                throw new Error(`Prepared transaction ${child} found original-project drift; recovery refused.`);
            }
            await updateTransaction(session, { ...transaction, state: "rolled_back" });
            recovered.push(child);
        }
        else if (transaction.state === "applying" || transaction.state === "rolling_back") {
            await assertRecoverablePaths(session.sourceRoot, transaction.transitions);
            let current = await updateTransaction(session, { ...transaction, state: "rolling_back", completedOperations: 0 });
            current = await synchronizeTreeState(session.sourceRoot, transactionRoot(session, child), current, "before");
            const restored = await snapshotTree(session.sourceRoot);
            if (restored.rootHash !== current.beforeRootHash)
                throw new Error(`Crash recovery failed for ${child}.`);
            await updateTransaction(session, { ...current, state: "rolled_back" });
            recovered.push(child);
        }
        else if (transaction.state === "reverting") {
            await assertRecoverablePaths(session.sourceRoot, transaction.transitions);
            let current = await synchronizeTreeState(session.sourceRoot, transactionRoot(session, child), { ...transaction, completedOperations: 0 }, "after");
            const restored = await snapshotTree(session.sourceRoot);
            if (restored.rootHash !== current.afterRootHash)
                throw new Error(`Crash recovery failed for ${child}.`);
            await updateTransaction(session, { ...current, state: "applied", completedOperations: 0 });
            recovered.push(child);
        }
    }
    return recovered;
}
async function assertRecoverablePaths(root, transitions) {
    const current = new Map((await snapshotTree(root)).entries.map((entry) => [entry.path, entry]));
    for (const transition of transitions) {
        const entry = current.get(transition.path);
        if (entry === undefined)
            continue;
        if (transition.before !== undefined && sameEntry(entry, transition.before))
            continue;
        if (transition.after !== undefined && sameEntry(entry, transition.after))
            continue;
        throw new Error(`Transaction recovery found a user-modified path and refused to overwrite it: ${transition.path}`);
    }
}
async function stageTransaction(session, manifest, transitions) {
    const parent = path.join(path.dirname(session.metadataFile), "transactions");
    await mkdir(parent, { recursive: true });
    const id = `apply-${randomUUID()}`;
    const temporary = path.join(parent, `.${id}.tmp`);
    const stable = path.join(parent, id);
    const transaction = {
        version: 1,
        id,
        sessionId: session.id,
        manifestHash: manifest.manifestHash,
        sourceRoot: session.sourceRoot,
        beforeRootHash: manifest.baselineRootHash,
        afterRootHash: manifest.candidateRootHash,
        transitions,
        createdAt: new Date().toISOString(),
        state: "prepared",
        completedOperations: 0,
    };
    try {
        await mkdir(temporary, { recursive: false });
        for (const transition of transitions) {
            if (transition.before !== undefined) {
                await copyFileWithMode(await linkSafePath(session.sourceRoot, transition.path), path.join(temporary, "before", ...transition.path.split("/")), transition.before.mode);
            }
            if (transition.after !== undefined) {
                await copyFileWithMode(await linkSafePath(session.workspaceRoot, transition.path), path.join(temporary, "after", ...transition.path.split("/")), transition.after.mode);
            }
        }
        await atomicWriteJson(path.join(temporary, "transaction.json"), transaction);
        await rename(temporary, stable);
        return transaction;
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
    }
}
async function synchronizeTreeState(root, stagedRoot, initial, target, testOptions = {}) {
    let transaction = initial;
    let operations = transaction.completedOperations;
    const count = async () => {
        operations += 1;
        transaction = await updateTransactionByRoot(stagedRoot, { ...transaction, completedOperations: operations });
        if (testOptions.simulateCrashAfterOperation === operations)
            throw new SimulatedCrash("Simulated process crash.");
        if (testOptions.failAfterOperation === operations)
            throw new Error("Injected transactional failure.");
    };
    const removals = [...transaction.transitions].sort((left, right) => depth(right.path) - depth(left.path) || compareText(right.path, left.path));
    for (const transition of removals) {
        const destination = await linkSafePath(root, transition.path);
        try {
            const details = await lstat(destination);
            if (details.isSymbolicLink())
                throw new Error(`Refusing to mutate link: ${transition.path}`);
            if (details.isDirectory())
                await rmdir(destination);
            else
                await rm(destination, { force: true });
            await pruneEmptyParents(root, path.dirname(destination));
            await count();
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
        }
    }
    const writes = transaction.transitions
        .filter((transition) => transition[target] !== undefined)
        .sort((left, right) => depth(left.path) - depth(right.path) || compareText(left.path, right.path));
    for (const transition of writes) {
        const entry = transition[target];
        const destination = await linkSafePath(root, transition.path);
        const source = path.join(stagedRoot, target, ...transition.path.split("/"));
        const temporary = `${destination}.vanguard-${transaction.id}.tmp`;
        await copyFileWithMode(source, temporary, entry.mode);
        try {
            await rename(temporary, destination);
        }
        finally {
            await rm(temporary, { force: true });
        }
        await count();
    }
    return transaction;
}
async function pruneEmptyParents(root, starting) {
    const canonicalRoot = path.resolve(root);
    let cursor = starting;
    while (cursor !== canonicalRoot && path.relative(canonicalRoot, cursor) !== "") {
        try {
            if ((await readdir(cursor)).length > 0)
                return;
            await rmdir(cursor);
        }
        catch (error) {
            if (isMissing(error)) {
                cursor = path.dirname(cursor);
                continue;
            }
            return;
        }
        cursor = path.dirname(cursor);
    }
}
async function validateTransitions(session, transitions) {
    for (const transition of transitions) {
        assertChangePath(transition.path);
        if (transition.before?.kind === "symlink" || transition.after?.kind === "symlink") {
            throw new Error(`Symbolic-link changes are unsupported: ${transition.path}`);
        }
        await linkSafePath(session.sourceRoot, transition.path);
        await linkSafePath(session.workspaceRoot, transition.path);
    }
}
function manifestTransitions(manifest) {
    const transitions = new Map();
    const put = (value) => {
        const prior = transitions.get(value.path);
        const before = value.before ?? prior?.before;
        const after = value.after ?? prior?.after;
        transitions.set(value.path, {
            path: value.path,
            ...(before === undefined ? {} : { before }),
            ...(after === undefined ? {} : { after }),
        });
    };
    for (const change of manifest.changes) {
        if (change.kind === "rename") {
            put({ path: change.fromPath, before: change.before });
            put({ path: change.toPath, after: change.after });
        }
        else {
            put({
                path: change.path,
                ...(change.before === undefined ? {} : { before: change.before }),
                ...(change.after === undefined ? {} : { after: change.after }),
            });
        }
    }
    return [...transitions.values()].sort((left, right) => compareText(left.path, right.path));
}
async function loadReviewedManifest(session, journal, manifestHash) {
    const manifest = await loadPatchManifest(path.join(path.dirname(session.metadataFile), "reviews", `${manifestHash}.json`));
    if (manifest.sessionId !== session.id)
        throw new Error("Reviewed manifest belongs to a different session.");
    const reviewed = (await journal.readValidated()).some((event) => event.type === "change.reviewed"
        && event.data !== null && typeof event.data === "object" && !Array.isArray(event.data)
        && event.data.manifestHash === manifestHash);
    if (!reviewed)
        throw new Error("Manifest has no durable review event in this session.");
    return manifest;
}
async function loadPatchManifest(file) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    validatePatchManifest(parsed);
    return parsed;
}
function validatePatchManifest(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Patch manifest is malformed.");
    const manifest = value;
    if (manifest.version !== 1 || typeof manifest.sessionId !== "string"
        || !isSha256(manifest.baselineRootHash) || !isSha256(manifest.candidateRootHash)
        || !isSha256(manifest.manifestHash) || !Array.isArray(manifest.changes))
        throw new Error("Patch manifest is malformed.");
    for (const change of manifest.changes) {
        if (change === null || typeof change !== "object" || Array.isArray(change))
            throw new Error("Patch manifest is malformed.");
        const typed = change;
        if (typed.kind === "rename") {
            if (typeof typed.fromPath !== "string" || typeof typed.toPath !== "string")
                throw new Error("Patch manifest is malformed.");
            assertChangePath(typed.fromPath);
            assertChangePath(typed.toPath);
            validateEntry(typed.before, typed.fromPath);
            validateEntry(typed.after, typed.toPath);
            if (typed.before?.kind !== "file" || typed.after?.kind !== "file" || typed.supported !== true) {
                throw new Error("Patch manifest is malformed.");
            }
        }
        else if (typed.kind === "add" || typed.kind === "delete" || typed.kind === "modify") {
            if (typeof typed.path !== "string")
                throw new Error("Patch manifest is malformed.");
            assertChangePath(typed.path);
            if (typed.kind === "add") {
                if (typed.before !== undefined)
                    throw new Error("Patch manifest is malformed.");
                validateEntry(typed.after, typed.path);
            }
            else if (typed.kind === "delete") {
                if (typed.after !== undefined)
                    throw new Error("Patch manifest is malformed.");
                validateEntry(typed.before, typed.path);
            }
            else {
                validateEntry(typed.before, typed.path);
                validateEntry(typed.after, typed.path);
            }
            const supported = typed.before?.kind !== "symlink" && typed.after?.kind !== "symlink";
            if (typed.supported !== supported)
                throw new Error("Patch manifest is malformed.");
        }
        else
            throw new Error("Patch manifest is malformed.");
        if (typeof typed.binary !== "boolean" || typeof typed.supported !== "boolean")
            throw new Error("Patch manifest is malformed.");
    }
    const { manifestHash, ...core } = manifest;
    if (manifestDigest(core) !== manifestHash)
        throw new Error("Patch manifest integrity failure.");
}
async function loadTransaction(session, transactionId) {
    const file = path.join(transactionRoot(session, transactionId), "transaction.json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed.version !== 1 || parsed.id !== transactionId || parsed.sessionId !== session.id
        || typeof parsed.state !== "string" || !Array.isArray(parsed.transitions)
        || !isSha256(parsed.beforeRootHash) || !isSha256(parsed.afterRootHash))
        throw new Error(`Transaction ${transactionId} is malformed.`);
    return parsed;
}
async function updateTransaction(session, transaction) {
    return updateTransactionByRoot(transactionRoot(session, transaction.id), transaction);
}
async function updateTransactionByRoot(root, transaction) {
    await atomicWriteJson(path.join(root, "transaction.json"), transaction);
    return transaction;
}
function transactionRoot(session, id) {
    return path.join(path.dirname(session.metadataFile), "transactions", id);
}
async function withSourceLock(sourceRoot, action) {
    const directory = path.join(os.tmpdir(), "vanguard-apply-locks");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${sha256(lowercaseInvariant(path.resolve(sourceRoot)))}.lock`);
    let handle;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            handle = await open(file, "wx");
            await handle.writeFile(JSON.stringify({ pid: process.pid, sourceRoot, createdAt: new Date().toISOString() }), "utf8");
            break;
        }
        catch (error) {
            if (!isExisting(error))
                throw error;
            if (attempt === 0 && await removeStaleLock(file))
                continue;
            throw new Error("Another Vanguard apply/undo transaction is active for this project.");
        }
    }
    if (handle === undefined)
        throw new Error("Could not acquire the project transaction lock.");
    try {
        return await action();
    }
    finally {
        await handle.close();
        await rm(file, { force: true });
    }
}
async function removeStaleLock(file) {
    try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) < 1)
            return false;
        try {
            process.kill(parsed.pid, 0);
            return false;
        }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
                return false;
            await rm(file, { force: true });
            return true;
        }
    }
    catch {
        return false;
    }
}
function manifestDigest(core) {
    return sha256(JSON.stringify(core));
}
function sameEntry(left, right) {
    return left.kind === right.kind && left.sha256 === right.sha256 && left.mode === right.mode
        && left.size === right.size && left.linkTarget === right.linkTarget;
}
function entryOrder(left, right) {
    return compareText(left.path, right.path);
}
function changeOrder(left, right) {
    const leftKey = left.kind === "rename" ? `${left.fromPath}\0${left.toPath}` : left.path;
    const rightKey = right.kind === "rename" ? `${right.fromPath}\0${right.toPath}` : right.path;
    return compareText(leftKey, rightKey) || compareText(left.kind, right.kind);
}
function assertChangePath(relativePath) {
    assertSafeRelativePath(relativePath);
    if (SESSION_EXCLUDED_DIRECTORIES.has(relativePath.split("/")[0])) {
        throw new Error(`Patch path targets an excluded directory: ${relativePath}`);
    }
}
function validateEntry(value, expectedPath) {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Patch manifest is malformed.");
    }
    const entry = value;
    if (entry.path !== expectedPath || (entry.kind !== "file" && entry.kind !== "symlink")
        || !isSha256(entry.sha256) || !Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0
        || !Number.isSafeInteger(entry.mode) || (entry.mode ?? -1) < 0 || typeof entry.binary !== "boolean"
        || (entry.kind === "symlink" && typeof entry.linkTarget !== "string"))
        throw new Error("Patch manifest is malformed.");
}
function requireMaterialized(session) {
    if (!session.materialized)
        throw new Error("Session workspace has not been materialized.");
}
function depth(relativePath) {
    return relativePath.split("/").length;
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
class SimulatedCrash extends Error {
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isExisting(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
