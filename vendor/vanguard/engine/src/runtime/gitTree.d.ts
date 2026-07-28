/**
 * True only when `root` is inside a git work tree with no staged, unstaged,
 * or untracked-but-not-ignored changes. Any failure (no git binary, not a
 * repo, timeout) answers false so the caller keeps the isolated default.
 */
export declare function isCleanGitRepository(root: string): Promise<boolean>;
