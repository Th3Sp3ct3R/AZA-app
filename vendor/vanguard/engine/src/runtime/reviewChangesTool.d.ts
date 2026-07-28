import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
export declare class ReviewChangesTool implements ToolPort {
    private readonly sourceRoot;
    private readonly workspaceRoot;
    readonly name = "review_changes";
    readonly definition: ToolDefinition;
    constructor(sourceRoot: string, workspaceRoot: string);
    execute(_input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
