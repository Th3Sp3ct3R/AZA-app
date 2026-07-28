import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "./workspace.js";
export declare class ImageInspectionTool implements ToolPort {
    #private;
    private readonly workspace;
    readonly name = "inspect_image";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
