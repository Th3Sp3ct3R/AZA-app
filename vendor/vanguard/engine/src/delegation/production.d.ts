import type { CommandSpec } from "../runtime/projectVerification.js";
import type { DelegateExecutionRequest, DelegateMergePort, DelegateRecord, DelegateRunHandle, DelegateRunHooks, DelegateRunnerPort } from "./coordinator.js";
export interface DelegateChildConfiguration {
    readonly provider: "openai" | "anthropic" | "deepseek" | "kimi" | "ollama" | "openai-compatible" | "http";
    readonly model: string;
    readonly auth?: "api-key" | "oauth";
    readonly endpoint?: string;
    /** Env variable naming the key for an openai-compatible endpoint; children inherit the env itself. */
    readonly credentialVariable?: string;
    readonly verification: CommandSpec;
    readonly publicCheck?: CommandSpec;
    readonly protectedPaths?: readonly string[];
    /** Hard wall-clock cap inherited from, and no greater than, the parent. */
    readonly maxDurationMs: number;
    readonly commandTimeoutMs: number;
    readonly maxContextBytes: number;
    readonly maxFailedVerificationAttempts: number;
    /** Preserve the parent's complete extension-isolation policy in every child. */
    readonly disableExtensions: boolean;
    /** Injectable compiled entry point for integration tests. */
    readonly cliFile?: string;
}
/**
 * Spawns the compiled Vanguard direct-execution path in an isolated coding
 * session. Credentials are inherited through the process environment and are
 * never copied into the delegation ledger, command line, or result manifest.
 */
export declare class CliDelegateRunner implements DelegateRunnerPort {
    #private;
    constructor(configuration: DelegateChildConfiguration);
    start(request: DelegateExecutionRequest, hooks: DelegateRunHooks): DelegateRunHandle;
}
/** Applies a reviewed child patch into the disposable parent workspace. */
export declare class TransactionalDelegateMerger implements DelegateMergePort {
    #private;
    constructor(parentWorkspace: string);
    merge(record: DelegateRecord, confirmation: string): Promise<{
        readonly transactionId: string;
    }>;
}
