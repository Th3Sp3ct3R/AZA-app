import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { compareOrdinal } from "../deterministicText.js";
import { FileJournal } from "../kernel/fileJournal.js";
import { createForkedCodingSession, } from "./session.js";
import { appendSessionEvent } from "./sessionJournal.js";
import { withSessionLease } from "./sessionLease.js";
import { SESSION_EXCLUDED_DIRECTORIES, atomicWriteJson, isSha256, snapshotTree, } from "./treeSnapshot.js";
export async function createSessionCheckpoint(session, journal, label) {
    return withSessionLease(path.dirname(session.metadataFile), "session.checkpoint", () => createSessionCheckpointUnlocked(session, journal, label));
}
async function createSessionCheckpointUnlocked(session, journal, label) {
    requireMaterialized(session);
    if (label !== undefined && (label.length === 0 || label.length > 200)) {
        throw new Error("Checkpoint labels must contain 1 to 200 characters.");
    }
    await recoverSessionRestoreUnlocked(session);
    const container = path.dirname(session.metadataFile);
    const parent = path.join(container, "time-travel", "checkpoints");
    await mkdir(parent, { recursive: true });
    const id = `checkpoint-${randomUUID()}`;
    const temporary = path.join(parent, `.${id}.tmp`);
    const stable = path.join(parent, id);
    const snapshot = await snapshotTree(session.workspaceRoot);
    const tip = await journal.tip();
    const prior = (await listSessionCheckpointsUnlocked(session)).at(-1);
    const checkpoint = {
        version: 1,
        id,
        sessionId: session.id,
        rootHash: snapshot.rootHash,
        journalHash: tip.hash,
        journalSequence: tip.sequence,
        ...(session.journalGenesisHash === undefined ? {} : { journalGenesisHash: session.journalGenesisHash }),
        ...(prior === undefined ? {} : { parentCheckpointId: prior.id }),
        ...(label === undefined ? {} : { label }),
        createdAt: new Date().toISOString(),
    };
    try {
        await mkdir(temporary, { recursive: false });
        await cp(session.workspaceRoot, path.join(temporary, "workspace"), {
            recursive: true,
            verbatimSymlinks: true,
            filter: (candidate) => !SESSION_EXCLUDED_DIRECTORIES.has(path.basename(candidate)),
        });
        const copied = await snapshotTree(path.join(temporary, "workspace"));
        if (copied.rootHash !== snapshot.rootHash)
            throw new Error("Checkpoint copy changed while it was captured.");
        await copyFile(journal.file, path.join(temporary, "run.jsonl"));
        await copyOptionalSessionState(container, temporary);
        await atomicWriteJson(path.join(temporary, "checkpoint.json"), checkpoint);
        await rename(temporary, stable);
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
    }
    try {
        await appendSessionEvent(journal, "session.checkpointed", {
            checkpointId: id,
            rootHash: snapshot.rootHash,
            journalHash: tip.hash,
            journalSequence: tip.sequence,
            ...(label === undefined ? {} : { label }),
        });
    }
    catch (error) {
        await rm(stable, { recursive: true, force: true });
        throw error;
    }
    return checkpoint;
}
export async function listSessionCheckpoints(session) {
    return withSessionLease(path.dirname(session.metadataFile), "session.list", () => listSessionCheckpointsUnlocked(session));
}
async function listSessionCheckpointsUnlocked(session) {
    const directory = path.join(path.dirname(session.metadataFile), "time-travel", "checkpoints");
    let children;
    try {
        children = await readdir(directory);
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw error;
    }
    const checkpoints = [];
    for (const child of children.sort()) {
        if (!child.startsWith("checkpoint-"))
            continue;
        checkpoints.push(await loadSessionCheckpoint(session, child));
    }
    checkpoints.sort((left, right) => compareOrdinal(left.createdAt, right.createdAt) || compareOrdinal(left.id, right.id));
    return checkpoints;
}
export async function restoreSessionCheckpoint(session, journal, checkpointId, confirmation, options = {}) {
    return withSessionLease(path.dirname(session.metadataFile), "session.restore", () => restoreSessionCheckpointUnlocked(session, journal, checkpointId, confirmation, options));
}
async function restoreSessionCheckpointUnlocked(session, journal, checkpointId, confirmation, options = {}) {
    requireMaterialized(session);
    assertCheckpointConfirmation(checkpointId, confirmation);
    await recoverSessionRestoreUnlocked(session);
    const checkpoint = await loadSessionCheckpoint(session, checkpointId);
    const container = path.dirname(session.metadataFile);
    const timeTravelRoot = path.join(container, "time-travel");
    const newWorkspace = path.join(container, "workspace.restore-new");
    const backupWorkspace = path.join(container, "workspace.restore-backup");
    const markerFile = path.join(timeTravelRoot, "restore.json");
    const stateNew = path.join(timeTravelRoot, "restore-state-new");
    const stateBackup = path.join(timeTravelRoot, "restore-state-backup");
    const checkpointWorkspace = path.join(timeTravelRoot, "checkpoints", checkpointId, "workspace");
    const before = await snapshotTree(session.workspaceRoot);
    const restoreId = `restore-${randomUUID()}`;
    const marker = (state) => ({
        version: 1,
        restoreId,
        checkpointId,
        state,
    });
    const captured = await snapshotTree(checkpointWorkspace);
    if (captured.rootHash !== checkpoint.rootHash)
        throw new Error("Checkpoint workspace failed its content hash.");
    await rm(newWorkspace, { recursive: true, force: true });
    await rm(backupWorkspace, { recursive: true, force: true });
    await rm(stateNew, { recursive: true, force: true });
    await rm(stateBackup, { recursive: true, force: true });
    try {
        await cp(checkpointWorkspace, newWorkspace, { recursive: true, verbatimSymlinks: true });
        await captureOptionalState(container, stateBackup);
        await captureOptionalState(path.join(timeTravelRoot, "checkpoints", checkpointId), stateNew);
        await writeRestoreMarker(markerFile, marker("prepared"));
        await rename(session.workspaceRoot, backupWorkspace);
        await writeRestoreMarker(markerFile, marker("old_moved"));
        await applyOptionalStateSnapshot(stateNew, container);
        if (options.simulateCrashAfterOldMove === true)
            throw new SimulatedRestoreCrash("Simulated restore crash.");
        await rename(newWorkspace, session.workspaceRoot);
        await writeRestoreMarker(markerFile, marker("new_moved"));
        const restored = await snapshotTree(session.workspaceRoot);
        if (restored.rootHash !== checkpoint.rootHash)
            throw new Error("Restored workspace failed its content hash.");
        const result = {
            restoreId,
            checkpointId,
            fromRootHash: before.rootHash,
            restoredRootHash: restored.rootHash,
            checkpointJournalHash: checkpoint.journalHash,
            checkpointJournalSequence: checkpoint.journalSequence,
            checkpointRootHash: checkpoint.rootHash,
        };
        await appendSessionEvent(journal, "session.restored", result);
        await writeRestoreMarker(markerFile, marker("committed"));
        await rm(backupWorkspace, { recursive: true, force: true });
        await rm(stateNew, { recursive: true, force: true });
        await rm(stateBackup, { recursive: true, force: true });
        await rm(markerFile, { force: true });
        return result;
    }
    catch (error) {
        if (error instanceof SimulatedRestoreCrash)
            throw error;
        await recoverSessionRestoreUnlocked(session);
        throw error;
    }
}
export async function recoverSessionRestore(session) {
    return withSessionLease(path.dirname(session.metadataFile), "session.restore-recovery", () => recoverSessionRestoreUnlocked(session));
}
async function recoverSessionRestoreUnlocked(session) {
    const container = path.dirname(session.metadataFile);
    const markerFile = path.join(container, "time-travel", "restore.json");
    try {
        const marker = JSON.parse(await readFile(markerFile, "utf8"));
        if (marker.version !== 1 || typeof marker.restoreId !== "string" || !/^restore-[a-f0-9-]+$/.test(marker.restoreId)
            || !isCheckpointId(marker.checkpointId)
            || !["prepared", "old_moved", "new_moved", "committed"].includes(marker.state ?? "")) {
            throw new Error("Restore recovery marker is malformed.");
        }
        const journalText = await readFile(path.join(container, "run.jsonl"), "utf8").catch(() => "");
        const journalCommitted = journalText.includes(marker.restoreId) && journalText.includes('"type":"session.restored"');
        if (marker.state === "committed" || journalCommitted) {
            await rm(path.join(container, "workspace.restore-backup"), { recursive: true, force: true });
            await rm(path.join(container, "workspace.restore-new"), { recursive: true, force: true });
            await rm(path.join(container, "time-travel", "restore-state-new"), { recursive: true, force: true });
            await rm(path.join(container, "time-travel", "restore-state-backup"), { recursive: true, force: true });
            await rm(markerFile, { force: true });
            return true;
        }
    }
    catch (error) {
        if (isMissing(error))
            return false;
        throw error;
    }
    const newWorkspace = path.join(container, "workspace.restore-new");
    const backupWorkspace = path.join(container, "workspace.restore-backup");
    const stateNew = path.join(container, "time-travel", "restore-state-new");
    const stateBackup = path.join(container, "time-travel", "restore-state-backup");
    if (await exists(stateBackup))
        await applyOptionalStateSnapshot(stateBackup, container);
    if (await exists(backupWorkspace)) {
        await rm(session.workspaceRoot, { recursive: true, force: true });
        await rename(backupWorkspace, session.workspaceRoot);
    }
    await rm(newWorkspace, { recursive: true, force: true });
    await rm(backupWorkspace, { recursive: true, force: true });
    await rm(stateNew, { recursive: true, force: true });
    await rm(stateBackup, { recursive: true, force: true });
    await rm(markerFile, { force: true });
    return true;
}
export async function forkSessionCheckpoint(parent, parentJournal, checkpointId) {
    return withSessionLease(path.dirname(parent.metadataFile), "session.fork", () => forkSessionCheckpointUnlocked(parent, parentJournal, checkpointId));
}
async function forkSessionCheckpointUnlocked(parent, parentJournal, checkpointId) {
    requireMaterialized(parent);
    const checkpoint = await loadSessionCheckpoint(parent, checkpointId);
    const checkpointRoot = path.join(path.dirname(parent.metadataFile), "time-travel", "checkpoints", checkpointId);
    const lineage = {
        parentSessionId: parent.id,
        parentCheckpointId: checkpointId,
        parentJournalHash: checkpoint.journalHash,
    };
    const child = await createForkedCodingSession(parent, path.join(checkpointRoot, "workspace"), lineage);
    const childContainer = path.dirname(child.metadataFile);
    const childJournalFile = path.join(childContainer, "run.jsonl");
    try {
        await copyFile(path.join(checkpointRoot, "run.jsonl"), childJournalFile);
        await restoreOptionalSessionState(checkpointRoot, childContainer);
        const childJournal = await FileJournal.open(childJournalFile, {
            ...(checkpoint.journalGenesisHash === undefined ? {} : { genesisHash: checkpoint.journalGenesisHash }),
        });
        const copiedTip = await childJournal.tip();
        if (copiedTip.hash !== checkpoint.journalHash || copiedTip.sequence !== checkpoint.journalSequence) {
            throw new Error("Fork journal does not end at the checkpoint branch point.");
        }
        await appendSessionEvent(childJournal, "session.forked", {
            role: "child",
            checkpointId,
            parentSessionId: parent.id,
            parentJournalHash: checkpoint.journalHash,
        });
        await appendSessionEvent(parentJournal, "session.forked", {
            role: "parent",
            checkpointId,
            childSessionId: child.id,
            parentJournalHash: checkpoint.journalHash,
        });
        return {
            checkpointId,
            parentSessionId: parent.id,
            parentJournalHash: checkpoint.journalHash,
            session: child,
            journalFile: childJournalFile,
        };
    }
    catch (error) {
        await rm(childContainer, { recursive: true, force: true });
        throw error;
    }
}
async function loadSessionCheckpoint(session, checkpointId) {
    if (!isCheckpointId(checkpointId))
        throw new Error("Checkpoint ID is malformed.");
    const file = path.join(path.dirname(session.metadataFile), "time-travel", "checkpoints", checkpointId, "checkpoint.json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed.version !== 1 || parsed.id !== checkpointId || parsed.sessionId !== session.id
        || !isSha256(parsed.rootHash) || !isSha256(parsed.journalHash)
        || !Number.isSafeInteger(parsed.journalSequence) || (parsed.journalSequence ?? -1) < 0
        || typeof parsed.createdAt !== "string")
        throw new Error(`Checkpoint ${checkpointId} is malformed.`);
    return parsed;
}
async function copyOptionalSessionState(container, destination) {
    for (const name of OPTIONAL_SESSION_STATE) {
        const source = path.join(container, name);
        if (await exists(source))
            await copyFile(source, path.join(destination, name));
    }
}
async function restoreOptionalSessionState(source, destination) {
    for (const name of OPTIONAL_SESSION_STATE) {
        const file = path.join(source, name);
        if (await exists(file))
            await copyFile(file, path.join(destination, name));
    }
}
const OPTIONAL_SESSION_STATE = [
    "run-config.json",
    "plan.json",
    "checkpoint.json",
    "delegations.json",
];
async function captureOptionalState(source, destination) {
    await mkdir(destination, { recursive: true });
    const present = [];
    for (const name of OPTIONAL_SESSION_STATE) {
        const file = path.join(source, name);
        if (!(await exists(file)))
            continue;
        await copyFile(file, path.join(destination, name));
        present.push(name);
    }
    await atomicWriteJson(path.join(destination, "presence.json"), { version: 1, present });
}
async function applyOptionalStateSnapshot(source, destination) {
    const parsed = JSON.parse(await readFile(path.join(source, "presence.json"), "utf8"));
    if (parsed.version !== 1 || !Array.isArray(parsed.present)
        || !parsed.present.every((name) => typeof name === "string" && OPTIONAL_SESSION_STATE.includes(name)))
        throw new Error("Restore state snapshot is malformed.");
    const present = new Set(parsed.present);
    for (const name of OPTIONAL_SESSION_STATE) {
        const target = path.join(destination, name);
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
async function writeRestoreMarker(file, marker) {
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWriteJson(file, marker);
}
function assertCheckpointConfirmation(checkpointId, confirmation) {
    if (!isCheckpointId(checkpointId) || confirmation !== checkpointId) {
        throw new Error("Restore requires --checkpoint and an exact --confirm copy of its ID.");
    }
}
function isCheckpointId(value) {
    return typeof value === "string" && /^checkpoint-[a-f0-9-]+$/.test(value);
}
function requireMaterialized(session) {
    if (!session.materialized)
        throw new Error("Session workspace has not been materialized.");
}
async function exists(file) {
    try {
        await stat(file);
        return true;
    }
    catch (error) {
        if (isMissing(error))
            return false;
        throw error;
    }
}
class SimulatedRestoreCrash extends Error {
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
