import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SESSION_EXCLUDED_DIRECTORIES } from "../runtime/treeSnapshot.js";
export async function analyzePatch(sourceRoot, workspaceRoot) {
    const [before, after] = await Promise.all([files(sourceRoot), files(workspaceRoot)]);
    const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
        .filter((file) => !buffersEqual(before.get(file), after.get(file)))
        .sort();
    let filesAdded = 0;
    let filesDeleted = 0;
    let filesModified = 0;
    let beforeBytes = 0;
    let afterBytes = 0;
    let beforeLines = 0;
    let afterLines = 0;
    for (const file of changedFiles) {
        const oldValue = before.get(file);
        const newValue = after.get(file);
        if (oldValue === undefined)
            filesAdded += 1;
        else if (newValue === undefined)
            filesDeleted += 1;
        else
            filesModified += 1;
        beforeBytes += oldValue?.length ?? 0;
        afterBytes += newValue?.length ?? 0;
        beforeLines += textLines(oldValue);
        afterLines += textLines(newValue);
    }
    return { changedFiles, filesAdded, filesDeleted, filesModified, beforeBytes, afterBytes, beforeLines, afterLines };
}
const FILE_READ_CONCURRENCY = 16;
async function files(root) {
    const resolved = await realpath(root);
    const result = new Map();
    const queue = [resolved];
    const targets = [];
    while (queue.length) {
        const directory = queue.shift();
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!SESSION_EXCLUDED_DIRECTORIES.has(entry.name))
                    queue.push(absolute);
                continue;
            }
            if (entry.isFile())
                targets.push({ relative: path.relative(resolved, absolute).replaceAll("\\", "/"), absolute });
        }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(FILE_READ_CONCURRENCY, targets.length) }, async () => {
        while (next < targets.length) {
            const target = targets[next];
            next += 1;
            try {
                result.set(target.relative, await readFile(target.absolute));
            }
            catch (error) {
                const code = error?.code;
                if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")
                    throw error;
            }
        }
    }));
    return result;
}
function buffersEqual(left, right) {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}
function textLines(value) {
    if (value === undefined || value.includes(0))
        return 0;
    const text = value.toString("utf8");
    return text.length === 0 ? 0 : text.split(/\r?\n/u).length;
}
