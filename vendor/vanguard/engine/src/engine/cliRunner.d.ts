import type { VanguardRunHandle, VanguardRunHooks, VanguardRunnerPort } from "./types.js";
/** Runs the established CLI runtime behind a narrow, sanitized event seam. */
export declare class CliVanguardRunner implements VanguardRunnerPort {
    #private;
    constructor(cliFile?: string);
    start(sessionRoot: string, message: string | undefined, hooks: VanguardRunHooks): VanguardRunHandle;
}
