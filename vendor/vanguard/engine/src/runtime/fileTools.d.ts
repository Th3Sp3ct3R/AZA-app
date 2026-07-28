import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "./workspace.js";
import { WorkspaceMutationPolicy } from "./mutationPolicy.js";
import { WorkspaceVersionLedger } from "./versionLedger.js";
export declare class ReadFileTool implements ToolPort {
    private readonly workspace;
    private readonly maxFileBytes;
    private readonly versions?;
    readonly name = "read_file";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, maxFileBytes?: number, versions?: WorkspaceVersionLedger | undefined);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class WriteFileTool implements ToolPort {
    private readonly workspace;
    private readonly versions?;
    private readonly mutationPolicy?;
    readonly name = "write_file";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, versions?: WorkspaceVersionLedger | undefined, mutationPolicy?: WorkspaceMutationPolicy | undefined);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class ReplaceTextTool implements ToolPort {
    private readonly workspace;
    private readonly versions?;
    private readonly mutationPolicy?;
    readonly name = "edit_file";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, versions?: WorkspaceVersionLedger | undefined, mutationPolicy?: WorkspaceMutationPolicy | undefined);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class DeleteFileTool implements ToolPort {
    private readonly workspace;
    private readonly versions?;
    private readonly mutationPolicy?;
    readonly name = "delete_file";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, versions?: WorkspaceVersionLedger | undefined, mutationPolicy?: WorkspaceMutationPolicy | undefined);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class ListFilesTool implements ToolPort {
    private readonly workspace;
    private readonly maxEntries;
    readonly name = "list_dir";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, maxEntries?: number);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class SearchTextTool implements ToolPort {
    private readonly workspace;
    private readonly maxResults;
    private readonly maxFileBytes;
    readonly name = "grep";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, maxResults?: number, maxFileBytes?: number);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class GlobTool implements ToolPort {
    private readonly workspace;
    private readonly maxEntries;
    readonly name = "glob";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, maxEntries?: number);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare function contentHash(contents: string | Buffer): string;
/**
 * On OneDrive-synced folders the Windows sync client briefly holds a handle
 * on a freshly written file, so `rename(temp, dest)` EPERM-fails even though
 * nothing is actually wrong. Retry only the transient lock codes (EPERM,
 * EACCES, EBUSY) with a short backoff; anything else throws immediately.
 * The rename operation is injectable so the retry policy is testable.
 */
export declare function renameWithRetry(source: string, destination: string, renameOperation?: (source: string, destination: string) => Promise<void>): Promise<void>;
