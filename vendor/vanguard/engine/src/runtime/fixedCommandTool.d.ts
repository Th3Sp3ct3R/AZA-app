import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { ProcessTool } from "./processTool.js";
export interface FixedCommand {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
}
export declare class FixedCommandTool implements ToolPort {
    readonly name: string;
    private readonly processTool;
    private readonly command;
    readonly definition: ToolDefinition;
    constructor(name: string, description: string, processTool: ProcessTool, command: FixedCommand);
    execute(_input: JsonValue, context: ToolContext): Promise<ToolResult>;
}
