import type { JsonValue, ToolResult } from "../kernel/contracts.js";
export declare class WorkspaceMutationPolicy {
    #private;
    constructor(editableRoots?: readonly string[], protectedPaths?: readonly string[]);
    check(relativePath: string): ToolResult | undefined;
    snapshot(): JsonValue;
    describe(): string;
    writableAbsoluteRoots(workspaceRoot: string): readonly string[];
}
