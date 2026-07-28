export interface PatchMetrics {
    readonly changedFiles: readonly string[];
    readonly filesAdded: number;
    readonly filesDeleted: number;
    readonly filesModified: number;
    readonly beforeBytes: number;
    readonly afterBytes: number;
    readonly beforeLines: number;
    readonly afterLines: number;
}
export declare function analyzePatch(sourceRoot: string, workspaceRoot: string): Promise<PatchMetrics>;
