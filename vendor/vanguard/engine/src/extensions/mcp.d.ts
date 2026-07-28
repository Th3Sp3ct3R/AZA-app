import type { JsonValue, ToolPort, ToolResult } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "../runtime/workspace.js";
import type { McpServerDeclaration } from "./config.js";
import { ExtensionPermissionPolicy } from "./customTools.js";
import type { ExtensionAuditPort } from "./hooks.js";
export interface McpToolDescriptor {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
}
export interface McpClientState {
    readonly server: string;
    readonly protocolVersion: string;
    readonly capabilities: JsonValue;
    readonly tools: readonly McpToolDescriptor[];
}
/** Bounded, allowlisted MCP stdio client. No SDK and no shell. */
export declare class McpStdioClient {
    #private;
    private readonly declaration;
    private readonly policy;
    private readonly audit;
    private constructor();
    static connect(workspace: WorkspaceBoundary, declaration: McpServerDeclaration, policy: ExtensionPermissionPolicy, audit: ExtensionAuditPort, environment?: NodeJS.ProcessEnv): Promise<McpStdioClient>;
    state(): McpClientState;
    tools(namespace?: string): readonly ToolPort[];
    callTool(name: string, input: JsonValue): Promise<ToolResult>;
    close(): Promise<void>;
}
