import type { JsonValue, ToolDefinition } from "../kernel/contracts.js";
export type ExtensionEffect = NonNullable<ToolDefinition["effect"]>;
export type HookFailurePolicy = "fail-open" | "fail-closed";
export type HookWhen = "before-run" | "after-run" | "before-tool" | "after-tool";
export interface ExtensionPermissions {
    readonly effects: readonly ExtensionEffect[];
    readonly customTools: readonly string[];
    readonly mcpServers: readonly string[];
    readonly hooks: readonly string[];
    readonly commands: readonly string[];
}
export interface SkillPolicyConfig {
    readonly roots: readonly string[];
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
}
export interface CustomToolDeclaration {
    readonly name: string;
    readonly effect: ExtensionEffect;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
}
export interface McpServerDeclaration {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly tools: readonly string[];
    readonly timeoutMs: number;
    readonly maxFrameBytes: number;
}
export interface HookDeclaration {
    readonly name: string;
    readonly when: HookWhen;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly failure: HookFailurePolicy;
}
export interface EffectiveExtensionConfig {
    readonly version: 1;
    readonly permissions: ExtensionPermissions;
    readonly skills: SkillPolicyConfig;
    readonly tools: readonly CustomToolDeclaration[];
    readonly mcp: readonly McpServerDeclaration[];
    readonly hooks: readonly HookDeclaration[];
}
export interface ExtensionProvenance {
    readonly kind: "config" | "instructions";
    readonly scope: "user" | "workspace";
    readonly file: string;
    readonly sha256: string;
}
export interface ResolvedExtensions {
    readonly config: EffectiveExtensionConfig;
    readonly instructions: string;
    readonly provenance: readonly ExtensionProvenance[];
}
export interface ResolveExtensionOptions {
    readonly workspaceRoot: string;
    readonly workingDirectory?: string;
    readonly userHome?: string;
    /** Skip every user and workspace extension layer for hermetic evaluation. */
    readonly disableExtensions?: boolean;
    readonly maxInstructionBytes?: number;
}
/**
 * Resolves user then workspace layers deterministically. Workspace permission
 * declarations are narrowing assertions: a project file that asks for any
 * capability outside the user ceiling is rejected instead of silently
 * escalating or being ignored.
 */
export declare function resolveExtensions(options: ResolveExtensionOptions): Promise<ResolvedExtensions>;
/** JSON-safe representation for journals and scorecards. */
export declare function extensionRuntimeState(value: ResolvedExtensions): JsonValue;
