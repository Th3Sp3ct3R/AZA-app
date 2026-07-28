import type { JsonValue, ModelPort, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
export declare class ScoutDelegateTool implements ToolPort {
    #private;
    readonly name = "delegate_scout";
    readonly definition: ToolDefinition;
    constructor(model: ModelPort, tools: readonly ToolPort[]);
    execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}
