import { readdir } from "node:fs/promises";
import path from "node:path";
export function prewarmExecutionRuntime(options) {
    if (process.env.VANGUARD_NO_PREWARM === "1")
        return;
    void import("typescript").catch(() => undefined);
    const render = options.renderTool;
    if (render === undefined)
        return;
    void (async () => {
        try {
            if (await hasRenderableArtifact(options.workspaceRoot))
                await render.warm();
        }
        catch {
        }
    })();
}
const RENDERABLE = new Set([".html", ".htm", ".svg"]);
const SKIP_DIRECTORIES = new Set([".git", ".vanguard", "node_modules", "dist", "coverage", "build", "out"]);
const MAX_ENTRIES = 400;
const MAX_DEPTH = 2;
async function hasRenderableArtifact(root) {
    let scanned = 0;
    const queue = [{ directory: root, depth: 0 }];
    while (queue.length > 0 && scanned < MAX_ENTRIES) {
        const { directory, depth } = queue.shift();
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            scanned += 1;
            if (scanned >= MAX_ENTRIES)
                break;
            if (entry.isDirectory()) {
                if (depth < MAX_DEPTH && !SKIP_DIRECTORIES.has(entry.name)) {
                    queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
                }
                continue;
            }
            if (entry.isFile() && RENDERABLE.has(path.extname(entry.name).toLowerCase()))
                return true;
        }
    }
    return false;
}
