import { execFile } from "node:child_process";
const GIT_TIMEOUT_MS = 5_000;
function git(root, args) {
    return new Promise((resolve) => {
        execFile("git", ["-C", root, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error === null ? stdout : undefined));
    });
}
export async function isCleanGitRepository(root) {
    const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside?.trim() !== "true")
        return false;
    const status = await git(root, ["status", "--porcelain"]);
    return status !== undefined && status.trim().length === 0;
}
