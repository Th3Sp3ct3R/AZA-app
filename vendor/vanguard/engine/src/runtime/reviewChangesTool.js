import { analyzePatch } from "../gauntlet/diffMetrics.js";
export class ReviewChangesTool {
    sourceRoot;
    workspaceRoot;
    name = "review_changes";
    definition = {
        name: this.name,
        description: "Review final changed-file scope and aggregate code growth before completion.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        effect: "review",
        evidenceAuthority: "independent-review",
    };
    constructor(sourceRoot, workspaceRoot) {
        this.sourceRoot = sourceRoot;
        this.workspaceRoot = workspaceRoot;
    }
    async execute(_input, _context) {
        const patch = await analyzePatch(this.sourceRoot, this.workspaceRoot);
        const expansionRatio = patch.beforeLines === 0 ? null : round(patch.afterLines / patch.beforeLines);
        const reviewFlags = [];
        if (patch.beforeLines >= 10 && expansionRatio !== null && expansionRatio > 4) {
            reviewFlags.push("large-patch-expansion: re-read changed files and simplify duplication where possible");
        }
        if (patch.beforeLines === 0 && patch.afterLines > 300) {
            reviewFlags.push("large-new-code-surface: inspect added files for temporary harnesses and unnecessary code");
        }
        if (patch.changedFiles.length === 0)
            reviewFlags.push("no-workspace-changes");
        return {
            ok: true,
            output: {
                changedFiles: [...patch.changedFiles],
                filesAdded: patch.filesAdded,
                filesDeleted: patch.filesDeleted,
                filesModified: patch.filesModified,
                beforeBytes: patch.beforeBytes,
                afterBytes: patch.afterBytes,
                beforeLines: patch.beforeLines,
                afterLines: patch.afterLines,
                expansionRatio,
                reviewFlags,
            },
        };
    }
}
function round(value) {
    return Math.round(value * 1_000) / 1_000;
}
