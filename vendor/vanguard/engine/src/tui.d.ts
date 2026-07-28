import type { PublicRunEvent } from "./runtime/publicRunEvents.js";
import { type OAuthProvider } from "./inference/oauth/index.js";
export { renderMarkdownLite, splitStreamableMarkdown } from "./tuiInline.js";
type Phase = "idle" | "thinking" | "tooling" | "waiting" | "verifying" | "completed" | "failed" | "cancelling" | "cancelled";
interface TurnOutcome {
    readonly status: string;
    readonly message?: string;
    readonly question?: string;
}
export declare function runTui(startDirectory: string): Promise<void>;
export declare function buildContinuationMessageForTest(previousTask: string, verifiedSummary: string, input: string): string;
/**
 * Refuse the directories that are never a project.
 *
 * Starting a session fingerprints the whole source tree (session.ts hashes every
 * file to bind the workspace to a known baseline), and later materializes a copy
 * of it. That is cheap for a repository and pathological for a home directory or
 * a drive root: Vanguard would sit there hashing AppData for many minutes with
 * nothing on screen, which reads as a hang rather than as work. Refusing early,
 * by name, is cheaper and clearer than any progress bar over the same mistake.
 */
export declare function assertProjectWorkspace(workspace: string): void;
/** The full refusal for fingerprinting modes in a guarded directory; direct mode is exempt. */
export declare function projectWorkspaceGuardReason(workspace: string): string | undefined;
export declare function parseLoginTarget(argument: string): OAuthProvider | undefined;
export declare function renderLaunchHeaderForTest(workspace?: string): string;
export declare function inspectTuiLifecycleForTest(events: readonly PublicRunEvent[], terminalOutcome?: TurnOutcome): {
    phase: Phase;
    activeTools: number;
    action: string;
    detail: string;
    contextTokens: number;
};
/** Feed events through consumeEvent and capture exactly what the user would see. */
export declare function renderTranscriptForTest(events: readonly PublicRunEvent[], width?: number): string;
/**
 * Replay the inline renderer's erase-append-repaint protocol into the final
 * screen content (scrollback plus live region). The renderer re-paints the
 * open stream row and footer on every frame; asserting on raw concatenated
 * writes would count those repaints as duplicate text when a real terminal
 * erased them.
 */
export declare function flattenInlineProtocol(output: string): string;
/** The footer a representative running state would pin under the transcript. */
export declare function renderFooterForTest(phase?: Phase, width?: number): string[];
