import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "./workspace.js";
/** What the owner decided about running one command that is not allowlisted. */
export type CommandApproval = "once" | "always" | "deny";
export interface CommandApprovalRequest {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
}
export interface ProcessToolOptions {
    readonly allowedCommands: readonly string[];
    readonly commandAliases?: Readonly<Record<string, {
        readonly executable: string;
        readonly argsPrefix: readonly string[];
    }>>;
    readonly deniedArgumentPrefixes?: readonly string[];
    readonly deniedArgumentSubstrings?: readonly string[];
    readonly timeoutMs?: number;
    /**
     * Kill the child after this long without a byte on stdout or stderr.
     *
     * The flat timeout above is sized for the longest legitimate build, so a
     * process that will never exit — a server the persistent-shape guard did
     * not recognize, a test fixture waiting on a socket that never closes —
     * silently occupies the whole budget. Silence is the tell: real builds and
     * test runners keep talking. Undefined disables the watchdog.
     */
    readonly idleTimeoutMs?: number;
    readonly maxOutputBytes?: number;
    /** Explicit child environment. Defaults to a credential/preload-sanitized copy. */
    readonly environment?: NodeJS.ProcessEnv;
    /**
     * Ask the owner about a command outside the allowlist.
     *
     * Without this the allowlist is the whole conversation: anything unlisted is
     * refused flatly, the person watching is never told, and the agent can only
     * guess around it. Supplied only when a human is actually attached; a headless
     * run keeps the fixed allowlist and refuses, because nobody could answer.
     * `always` widens the allowlist for the rest of this session only — it is
     * never written to disk and never outlives the process.
     */
    readonly requestApproval?: (request: CommandApprovalRequest, signal: AbortSignal) => Promise<CommandApproval>;
}
export declare class ProcessTool implements ToolPort {
    #private;
    private readonly workspace;
    readonly name = "run_command";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, options: ProcessToolOptions);
    execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}
/** Reject common server launch shapes before they can occupy a tool turn until timeout. */
export declare function persistentProcessReason(command: string, args: readonly string[]): string | undefined;
