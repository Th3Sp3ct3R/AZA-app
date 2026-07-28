import type { JsonValue, ModelPort, VerificationResult, VerifierPort } from "../kernel/contracts.js";
import type { RepositoryModel } from "../runtime/repositoryModel.js";
export interface ExtensionIdentity {
    readonly name: string;
    readonly version: string;
    readonly provenance: string;
}
/** Wire-neutral model factory: implementations own HTTP, not Vanguard SDKs. */
export interface ProviderAdapterExtension extends ExtensionIdentity {
    readonly kind: "provider";
    create(configuration: Readonly<Record<string, JsonValue>>): ModelPort;
}
export interface RepositoryDetectorExtension extends ExtensionIdentity {
    readonly kind: "repository-detector";
    detect(root: string, signal: AbortSignal): Promise<Partial<RepositoryModel>>;
}
export interface VerifierExtension extends ExtensionIdentity {
    readonly kind: "verifier";
    create(configuration: Readonly<Record<string, JsonValue>>): VerifierPort;
}
export interface ReviewCandidate {
    readonly sourceRoot: string;
    readonly workspaceRoot: string;
    readonly task: string;
    readonly verification: readonly VerificationResult[];
}
export interface ReviewResult {
    readonly reviewer: string;
    readonly passed: boolean;
    readonly findings: readonly {
        readonly severity: "info" | "warning" | "error";
        readonly message: string;
        readonly file?: string;
    }[];
}
export interface ReviewerExtension extends ExtensionIdentity {
    readonly kind: "reviewer";
    review(candidate: ReviewCandidate, signal: AbortSignal): Promise<ReviewResult>;
}
export type VanguardExtension = ProviderAdapterExtension | RepositoryDetectorExtension | VerifierExtension | ReviewerExtension;
export interface ExtensionRegistryEntry {
    readonly kind: VanguardExtension["kind"];
    readonly name: string;
    readonly version: string;
    readonly provenance: string;
}
/** Registration only; loading/importing extensions remains an explicit host action. */
export declare class VanguardExtensionRegistry {
    #private;
    register(extension: VanguardExtension): void;
    get<T extends VanguardExtension["kind"]>(kind: T, name: string): Extract<VanguardExtension, {
        kind: T;
    }> | undefined;
    manifest(): readonly ExtensionRegistryEntry[];
}
