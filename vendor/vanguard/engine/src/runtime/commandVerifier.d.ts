import type { VerificationResult, VerifierPort } from "../kernel/contracts.js";
import { ProcessTool } from "./processTool.js";
export interface VerificationCommand {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
}
export type VerificationEvidenceMode = "full" | "summary";
export declare class CommandVerifier implements VerifierPort {
    readonly name: string;
    private readonly processTool;
    private readonly check;
    private readonly evidenceMode;
    constructor(name: string, processTool: ProcessTool, check: VerificationCommand, evidenceMode?: VerificationEvidenceMode);
    verify(_candidate: string, task: string): Promise<VerificationResult>;
}
