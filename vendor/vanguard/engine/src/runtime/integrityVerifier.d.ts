import type { VerificationResult, VerifierPort } from "../kernel/contracts.js";
export interface IntegrityVerifierOptions {
    readonly sourceRoot: string;
    readonly workspaceRoot: string;
    readonly protectedPaths?: readonly string[];
    readonly editableRoots?: readonly string[];
}
export declare class WorkspaceIntegrityVerifier implements VerifierPort {
    #private;
    readonly name = "workspace integrity";
    constructor(options: IntegrityVerifierOptions);
    verify(_candidate: string, _task: string): Promise<VerificationResult>;
}
