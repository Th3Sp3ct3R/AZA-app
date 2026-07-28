import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { type TypeScriptLoader } from "./progressiveVerification.js";
import { WorkspaceBoundary } from "./workspace.js";
export declare class CodeIntelTool implements ToolPort {
    #private;
    private readonly workspace;
    private readonly typescriptLoader;
    readonly name = "code_intel";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, typescriptLoader?: TypeScriptLoader);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
