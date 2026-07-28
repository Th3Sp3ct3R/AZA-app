/**
 * Fire-and-forget warmup of lazily-initialized heavy tools, overlapped with
 * the model's first thinking time.
 *
 * The two known cold-start cliffs are the TypeScript compiler module (loaded
 * on the first `.ts` mutation's syntax rung) and the first headless-Chromium
 * launch (multiple seconds on a cold or antivirus-scanned machine). Both are
 * pure warmups: they change no observable behavior, produce no evidence, and
 * swallow their own failures — the real call sites still report real errors.
 *
 * VANGUARD_NO_PREWARM=1 disables everything (tests and constrained hosts).
 */
export declare function prewarmExecutionRuntime(options: {
    readonly workspaceRoot: string;
    readonly renderTool?: {
        warm(): Promise<void>;
    };
}): void;
