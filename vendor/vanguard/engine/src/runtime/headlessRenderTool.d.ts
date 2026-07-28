import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "./workspace.js";
export interface BrowserLocator {
    /** Absolute path of a runnable Chromium-family browser, or undefined. */
    locate(): Promise<string | undefined>;
}
export interface RenderProcessRunner {
    run(executable: string, args: readonly string[], timeoutMs: number): Promise<{
        exitCode: number;
        output: string;
    }>;
}
/**
 * Finds a first-party Chromium-family browser without a shell and without
 * model influence: an explicit VANGUARD_BROWSER override wins, then the
 * platform's well-known Edge/Chrome/Chromium installation paths.
 */
export declare class SystemChromiumLocator implements BrowserLocator {
    #private;
    locate(): Promise<string | undefined>;
}
export declare class HeadlessRenderRunner implements RenderProcessRunner {
    run(executable: string, args: readonly string[], timeoutMs: number): Promise<{
        exitCode: number;
        output: string;
    }>;
}
export declare class HeadlessRenderTool implements ToolPort {
    #private;
    private readonly workspace;
    private readonly locator;
    private readonly runner;
    private readonly timeoutMs;
    readonly name = "render_artifact";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, locator?: BrowserLocator, runner?: RenderProcessRunner, timeoutMs?: number);
    /**
     * Best-effort cold-start warmup: locate the browser and run one headless
     * about:blank launch so the OS has the executable and its libraries in the
     * file cache before the first real render. The first Chromium launch on a
     * cold (or antivirus-scanned) machine costs multiple seconds; overlapping
     * it with the model's own thinking time makes the first real render cheap.
     * Never throws — a warmup must not be able to fail a run.
     */
    warm(): Promise<void>;
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
/**
 * Chromium's serialized post-script DOM closes a gap screenshots cannot: a
 * polished loading veil can look intentional even when the application behind
 * it never booted. Treat an active loading status or explicitly visible alert
 * as a runtime failure. This is deliberately semantic and framework-agnostic.
 */
export declare function inspectRenderedDom(output: string): string | undefined;
