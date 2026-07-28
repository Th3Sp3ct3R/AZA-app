export declare const SESSION_EXCLUDED_DIRECTORIES: Set<string>;
export interface TreeSnapshotOptions {
    readonly excludedDirectories?: ReadonlySet<string>;
    readonly cache?: TreeSnapshotCache;
}
interface CachedFileEntry {
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly sha256: string;
    readonly binary: boolean;
    /** Wall-clock time this hash was computed from real file bytes. */
    readonly hashedAtMs: number;
}
/**
 * A stat-validated hash cache for repeated snapshots of one workspace root.
 * A cached hash is reused only when the file's current size, mtime, and ctime
 * are identical to the stat observed when the hash was computed AND the mtime
 * is strictly older than that computation by the racy slop. Any mismatch or
 * racy entry falls back to reading and hashing real bytes, so a cached
 * snapshot is byte-equivalent to an uncached one.
 */
export declare class TreeSnapshotCache {
    #private;
    bindRoot(root: string): void;
    lookup(absolutePath: string, stats: {
        size: number;
        mtimeMs: number;
        ctimeMs: number;
    }): CachedFileEntry | undefined;
    store(absolutePath: string, stats: {
        size: number;
        mtimeMs: number;
        ctimeMs: number;
    }, digest: string, binary: boolean): void;
    retainOnly(seen: ReadonlySet<string>): void;
}
export interface TreeEntry {
    readonly path: string;
    readonly kind: "file" | "symlink";
    readonly sha256: string;
    readonly size: number;
    readonly mode: number;
    readonly binary: boolean;
    readonly linkTarget?: string;
}
export interface TreeSnapshot {
    readonly version: 1;
    readonly rootHash: string;
    readonly entries: readonly TreeEntry[];
}
/** Run async filesystem operations with bounded parallelism. */
export declare function createFsLimiter(limit: number): <T>(operation: () => Promise<T>) => Promise<T>;
export declare function snapshotTree(root: string, options?: TreeSnapshotOptions): Promise<TreeSnapshot>;
export declare function validateTreeSnapshot(value: unknown): asserts value is TreeSnapshot;
export declare function readTreeSnapshot(file: string): Promise<TreeSnapshot>;
export declare function atomicWriteJson(file: string, value: unknown): Promise<void>;
export declare function safeRoot(root: string): Promise<string>;
/**
 * Resolves a relative path lexically and refuses every symbolic-link or
 * junction ancestor. The final component is checked when it exists. This is
 * deliberately stricter than realpath containment: apply operations never
 * write through a link even when that link currently resolves inside root.
 */
export declare function linkSafePath(root: string, relativePath: string): Promise<string>;
export declare function copyFileWithMode(source: string, destination: string, mode: number): Promise<void>;
export declare function assertSafeRelativePath(relativePath: string): void;
export declare function sha256(value: Buffer | string): string;
export declare function isSha256(value: unknown): value is string;
export {};
