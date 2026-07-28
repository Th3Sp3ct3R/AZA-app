import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { type SupportTier } from "./repositoryModel.js";
import { WorkspaceBoundary } from "./workspace.js";
export type SyntaxCheckStatus = "passed" | "failed" | "inconclusive";
export interface SyntaxCheckResult {
    readonly status: SyntaxCheckStatus;
    /** Backward-compatible convenience: only a proven failure is false. */
    readonly ok: boolean;
    readonly tier: SupportTier | "unknown";
    readonly language: string;
    readonly detail: string;
    /** Hash of the exact workspace bytes that were checked. */
    readonly contentSha256: string;
}
/**
 * Runs a single command and reports success plus captured output. Injectable
 * so the progressive-verification ladder is testable without real toolchains.
 */
export interface CommandRunner {
    run(command: string, args: readonly string[], cwd: string, input?: string): Promise<{
        exitCode: number;
        output: string;
    }>;
}
/** Minimal surface of the `typescript` compiler module used by the syntax rung. */
export interface TypeScriptModuleLike {
    transpileModule(input: string, options: {
        fileName?: string;
        reportDiagnostics?: boolean;
        compilerOptions?: Record<string, unknown>;
    }): {
        diagnostics?: ReadonlyArray<TypeScriptDiagnosticLike>;
    };
    flattenDiagnosticMessageText(message: unknown, newLine: string): string;
    readonly DiagnosticCategory: {
        readonly Error: number;
    };
    readonly JsxEmit: {
        readonly Preserve: number;
    };
    readonly ScriptTarget: {
        readonly Latest: number;
    };
}
export interface TypeScriptDiagnosticLike {
    readonly category: number;
    readonly code: number;
    readonly messageText: unknown;
    readonly start?: number;
    readonly file?: {
        getLineAndCharacterOfPosition(position: number): {
            line: number;
            character: number;
        };
    };
}
export type TypeScriptLoader = (workspaceRoot: string) => Promise<TypeScriptModuleLike | undefined>;
/**
 * Resolves the `typescript` module for in-process parsing: the target
 * workspace's own installation wins (its parser matches the project's
 * language level), then Vanguard's, and a missing module is a normal
 * degradation to the structural rung — never an error.
 */
export declare function loadWorkspaceTypeScript(workspaceRoot: string): Promise<TypeScriptModuleLike | undefined>;
/**
 * The post-edit syntax rung. For a mutated file it runs the cheapest
 * available structural check: a first-party parse CLI for supported deep-tier
 * languages, an in-process compiler-API parse for TypeScript, a
 * delimiter-balance heuristic for brace languages without a resolvable
 * parser, and an explicit "no cheap check" result otherwise (never a false
 * pass). Higher rungs — targeted type/lint/test, milestone integration, the
 * sealed verifier, and independent patch review — sit above this in the CLI.
 */
export declare class PostEditSyntaxChecker {
    private readonly runner;
    private readonly workspace;
    private readonly typescriptLoader;
    private typescriptModule;
    /** Last result per file, keyed by content hash: re-checking an unchanged file is free. */
    private readonly resultCache;
    constructor(runner: CommandRunner, workspace: WorkspaceBoundary, typescriptLoader?: TypeScriptLoader);
    check(relativeFile: string): Promise<SyntaxCheckResult>;
    private checkUncached;
    /**
     * The in-process TypeScript parse rung. `transpileModule` surfaces only
     * syntactic diagnostics — no project graph, no type checking — which is
     * exactly the shape of this rung: it proves the edit parses, and leaves
     * types to the project's own tsc at the targeted-check rung.
     */
    private typescriptSyntax;
    private structural;
}
/**
 * A structural delimiter-balance check that ignores strings, template
 * literals, and comments. Not a parser — it catches the common broken-edit
 * signature (an unclosed brace/paren/bracket) cheaply and never false-passes
 * an obviously truncated edit.
 */
export declare function delimiterBalance(source: string): {
    ok: boolean;
    detail: string;
};
/**
 * Exposes the syntax rung as an observe tool so the model can self-check an
 * edit before spending a build. It never mutates and never gates on its own;
 * the kernel's completion policy still requires the sealed verifier.
 */
export declare class SyntaxCheckTool implements ToolPort {
    private readonly checker;
    readonly name = "verify_syntax";
    readonly definition: ToolDefinition;
    constructor(checker: PostEditSyntaxChecker);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
/**
 * A minimal, hard-allowlisted command runner for the fixed syntax-check
 * executables only. It never runs a shell and rejects any command outside
 * the syntax allowlist, so it cannot become a general process escape.
 */
export declare class SyntaxCommandRunner implements CommandRunner {
    private readonly timeoutMs;
    static readonly ALLOWED: Set<string>;
    constructor(timeoutMs?: number);
    run(command: string, args: readonly string[], cwd: string, input?: string): Promise<{
        exitCode: number;
        output: string;
    }>;
}
