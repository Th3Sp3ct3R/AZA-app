import type { SkillPolicyConfig } from "./config.js";
import { WorkspaceBoundary } from "../runtime/workspace.js";
export interface SkillMetadata {
    readonly name: string;
    readonly description: string;
    readonly version?: string;
}
export interface SkillResource {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly executable: false;
}
export interface LoadedSkill {
    readonly metadata: SkillMetadata;
    readonly instructions: string;
    readonly directory: string;
    readonly source: string;
    readonly resources: readonly SkillResource[];
}
/**
 * Portable, data-only SKILL.md discovery. Files are decoded and hashed, never
 * imported, required, spawned, or interpreted as scripts.
 */
export declare function loadWorkspaceSkills(workspace: WorkspaceBoundary, policy: SkillPolicyConfig): Promise<readonly LoadedSkill[]>;
export declare function readSkillResource(workspace: WorkspaceBoundary, skill: LoadedSkill, relativeResource: string, maxBytes: number): Promise<Uint8Array>;
