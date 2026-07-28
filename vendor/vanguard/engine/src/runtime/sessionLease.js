import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
export async function acquireSessionLease(sessionRoot, operation) {
    const root = path.resolve(sessionRoot);
    const boundedOperation = operation.trim();
    if (boundedOperation.length === 0 || boundedOperation.length > 128) {
        throw new Error("Session lease operation must contain 1 to 128 characters.");
    }
    const lock = path.join(root, ".session.lock");
    const token = randomUUID();
    const record = {
        version: 1,
        token,
        pid: process.pid,
        operation: boundedOperation,
        acquiredAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const staging = path.join(root, `.session-lock-${token}-${attempt}.tmp`);
        try {
            await mkdir(staging);
            await writeFile(path.join(staging, "owner.json"), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
            await rename(staging, lock);
            return {
                root,
                operation: boundedOperation,
                release: () => releaseSessionLease(lock, root, record),
            };
        }
        catch (error) {
            await rm(staging, { recursive: true, force: true });
            if (!isExisting(error))
                throw error;
            const owner = await readLeaseRecord(lock);
            if (processIsAlive(owner.pid)) {
                throw new Error(`Session is busy: PID ${owner.pid} owns '${owner.operation}' since ${owner.acquiredAt}.`);
            }
            const stale = path.join(root, `.session-lock-stale-${randomUUID()}`);
            try {
                await rename(lock, stale);
            }
            catch (renameError) {
                if (isMissing(renameError) || isExisting(renameError))
                    continue;
                throw renameError;
            }
            await rm(stale, { recursive: true, force: true });
        }
    }
    throw new Error("Session lease arbitration did not converge.");
}
export async function withSessionLease(sessionRoot, operation, work) {
    const lease = await acquireSessionLease(sessionRoot, operation);
    try {
        return await work();
    }
    finally {
        await lease.release();
    }
}
async function releaseSessionLease(lock, root, expected) {
    const owner = await readLeaseRecord(lock);
    if (owner.token !== expected.token || owner.pid !== expected.pid) {
        throw new Error("Session lease ownership changed before release; refusing to remove another owner.");
    }
    const releasing = path.join(root, `.session-lock-release-${expected.token}`);
    await rename(lock, releasing);
    await rm(releasing, { recursive: true, force: true });
}
async function readLeaseRecord(lock) {
    const metadata = await lstat(lock);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Session lease path is not a safe directory.");
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
    }
    catch (error) {
        throw new Error(`Session lease owner record is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Session lease owner record is malformed.");
    }
    const record = parsed;
    if (record.version !== 1 || typeof record.token !== "string" || !/^[a-f0-9-]{36}$/iu.test(record.token)
        || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) < 1
        || typeof record.operation !== "string" || record.operation.length === 0 || record.operation.length > 128
        || typeof record.acquiredAt !== "string" || Number.isNaN(Date.parse(record.acquiredAt))) {
        throw new Error("Session lease owner record is malformed.");
    }
    return record;
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
            return false;
        return true;
    }
}
function isExisting(error) {
    return error instanceof Error && "code" in error
        && (error.code === "EEXIST" || error.code === "ENOTEMPTY" || error.code === "EPERM");
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
