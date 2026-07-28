import type { VerificationResult, VerifierPort } from "../kernel/contracts.js";
import { type CommandSpec } from "./projectVerification.js";
/**
 * Reserved verification-command name that the runtime executes in-process via
 * {@link AdaptiveCommandVerifier} instead of spawning an executable. It makes
 * adaptive verification available to every embedder — including hosts that
 * bundle Vanguard into a single file, where no packaged script path exists on
 * disk. Spelled with a colon so no real executable can collide with it.
 */
export declare const ADAPTIVE_VERIFY_COMMAND = "vanguard:adaptive-verify";
export declare function isAdaptiveVerifyCommand(specification: {
    readonly command: string;
}): boolean;
/** The mode carried in a builtin adaptive verification command's args. */
export declare function adaptiveVerifyMode(specification: {
    readonly args: readonly string[];
}): VerificationMode;
export interface AutomaticVerificationResult {
    readonly status: "passed" | "failed" | "missing" | "not_required";
    readonly commands: readonly CommandSpec[];
    readonly exitCode: number;
}
/**
 * How hard a missing verification contract is.
 *
 * `tests` — the default and the strict reading: no contract is a failure, so the
 * agent must establish a deterministic build/test contract before it can claim
 * completion. Right for a codebase.
 *
 * `build` — verify what exists, do not demand what does not. A detected contract
 * still runs and still gates completion; only its *absence* stops being fatal.
 * Without this, a deliverable with no natural test — a static page, a script, a
 * document — can never be completed no matter what the agent produces, because
 * the sealed verifier fails before it is even asked about the work.
 */
export type VerificationMode = "tests" | "build";
export declare function parseVerificationMode(value: string | undefined): VerificationMode;
export declare function runAutomaticVerification(workspace: string, mode?: VerificationMode, sink?: (line: string) => void): Promise<AutomaticVerificationResult>;
/**
 * The builtin adaptive verifier: same behavior as the packaged autoVerify
 * shim, executed in-process with captured output, so it works in any host —
 * bundled or not — and in any workspace, project or blank.
 */
export declare class AdaptiveCommandVerifier implements VerifierPort {
    readonly name: string;
    private readonly workspaceRoot;
    private readonly mode;
    constructor(name: string, workspaceRoot: string, mode: VerificationMode);
    verify(_candidate: string, _task: string): Promise<VerificationResult>;
}
