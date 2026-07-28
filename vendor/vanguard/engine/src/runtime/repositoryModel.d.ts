import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import type { WorkspaceBoundary } from "./workspace.js";
export type SupportTier = "deep" | "generic";
export interface LanguageProfile {
    readonly language: string;
    readonly tier: SupportTier;
    readonly extensions: readonly string[];
}
/**
 * Language support tiers. Deep-tier languages have first-party CLIs Vanguard
 * drives for syntax/type/lint/targeted-test checks; every other language
 * falls back to generic build/test/syntax handling. Certification reports
 * deep-support and generic-support ecosystems separately.
 */
export declare const LANGUAGE_PROFILES: readonly LanguageProfile[];
export interface LanguagePresence {
    readonly language: string;
    readonly tier: SupportTier;
    readonly files: number;
}
export interface RepositoryModel {
    readonly languages: readonly LanguagePresence[];
    readonly primaryLanguage: string | undefined;
    readonly primaryTier: SupportTier | undefined;
    readonly buildSystems: readonly string[];
    readonly entryPoints: readonly string[];
    readonly testFiles: readonly string[];
    readonly generatedDirectories: readonly string[];
    readonly instructionFiles: readonly string[];
    readonly hasGit: boolean;
    readonly fileCount: number;
    readonly sampledFiles: boolean;
}
interface ScanOptions {
    readonly maxFiles?: number;
    /** Omit extension instruction file names from hermetic repository maps. */
    readonly includeInstructionFiles?: boolean;
}
/**
 * Builds a persistent repository model from a filesystem scan. Pure and
 * deterministic; the agent reads it through the repo_map tool for
 * expert context without spending a model turn per directory.
 */
export declare function buildRepositoryModel(root: string, options?: ScanOptions): Promise<RepositoryModel>;
/** Reads hierarchical repository instructions (AGENTS.md and friends). */
export declare function readRepositoryInstructions(root: string, files: readonly string[]): Promise<string[]>;
export declare class RepositoryMapTool implements ToolPort {
    private readonly workspace;
    private readonly options;
    readonly name = "repo_map";
    readonly definition: ToolDefinition;
    constructor(workspace: WorkspaceBoundary, options?: {
        readonly includeInstructions?: boolean;
    });
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export {};
