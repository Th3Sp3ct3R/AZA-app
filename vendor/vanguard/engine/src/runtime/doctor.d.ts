import type { CommandRunner, TypeScriptLoader } from "./progressiveVerification.js";
import type { BrowserLocator } from "./headlessRenderTool.js";
/**
 * `vanguard doctor`: one-shot, offline environment diagnostics.
 *
 * Vanguard's capability rungs degrade honestly at runtime — no browser means
 * no visual evidence, no resolvable `typescript` module means the delimiter
 * fallback, no python means no Python parse rung. Honest degradation is
 * correct mid-run and invisible at setup: nothing tells the operator a rung
 * is dead until a task needed it. The doctor surfaces every degraded rung
 * before a run, with a remedy per finding.
 *
 * Every check is local and fast: environment variables, the OAuth token
 * store, executable discovery, and module resolution. The doctor never calls
 * a provider, so a clean bill of health means "correctly configured", not
 * "the provider is up".
 */
export type DoctorStatus = "ok" | "degraded" | "missing";
export interface DoctorResult {
    readonly name: string;
    readonly status: DoctorStatus;
    readonly detail: string;
    readonly remedy?: string;
}
export interface DoctorReport {
    readonly results: readonly DoctorResult[];
    /** True when nothing run-blocking is missing; degraded rungs stay ready. */
    readonly ready: boolean;
}
export interface DoctorOptions {
    readonly workspaceRoot: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly browserLocator?: BrowserLocator;
    readonly typescriptLoader?: TypeScriptLoader;
    readonly syntaxRunner?: CommandRunner;
    /** Local OAuth token-store probe; never a network call. */
    readonly oauthConnected?: () => Promise<boolean>;
}
export declare function runDoctor(options: DoctorOptions): Promise<DoctorReport>;
export declare function renderDoctorReport(report: DoctorReport): string;
