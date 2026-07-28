import type { ModelPort, TaskContract, ToolContext, ToolResult, VerificationResult, VerifierPort } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "./workspace.js";
/**
 * The judge rung: correctness verifiers prove "done"; this one rules on
 * "good". When a contract declares a creative direction, completion must
 * survive a model judgment of the rendered deliverable against that
 * direction — on vision-capable wires the judge sees the actual pixels via
 * the same inline-image channel the agent uses.
 *
 * The judge is deliberately scoped: it activates only when the contract
 * carries a creativeDirection AND a renderable deliverable exists. Judging
 * arbitrary code text against taste is noise, not verification, so with
 * nothing to look at it passes with an honest note instead of blocking on a
 * guess. An unreachable judge model also passes-with-note: taste must never
 * turn a provider outage into a failed run.
 */
export type DeliverableRenderer = (relativePath: string, context: ToolContext) => Promise<ToolResult>;
/**
 * Bounds for the fallback discovery scan. `touchedPaths` are files the session
 * observed or wrote through its own tools; `modifiedSinceMs` admits files a
 * subprocess produced during the run. Without a scope, any pre-existing
 * `.html` in the tree — a docs page, a coverage report — becomes the newest
 * renderable and drags a headless-browser launch into every completion
 * attempt of an unrelated task.
 */
export interface DeliverableScanScope {
    readonly touchedPaths: readonly string[];
    readonly modifiedSinceMs: number;
}
export interface RenderableDeliverable {
    readonly relative: string;
    /** Contract-listed deliverables must render; scan discoveries degrade politely. */
    readonly source: "contract" | "scan";
}
export declare class CreativeDirectionVerifier implements VerifierPort {
    private readonly judge;
    private readonly workspace;
    private readonly contract;
    private readonly renderer;
    private readonly scanScope?;
    readonly name = "creative direction";
    constructor(judge: ModelPort, workspace: WorkspaceBoundary, contract: TaskContract, renderer: DeliverableRenderer, scanScope?: (() => DeliverableScanScope) | undefined);
    verify(_candidate: string, task: string): Promise<VerificationResult>;
}
/** Model-independent completion gate for HTML/SVG artifacts. */
export declare class RenderableArtifactVerifier implements VerifierPort {
    #private;
    private readonly workspace;
    private readonly contract;
    private readonly renderer;
    private readonly scanScope?;
    readonly name = "renderable artifact runtime";
    constructor(workspace: WorkspaceBoundary, contract: TaskContract | undefined, renderer: DeliverableRenderer, scanScope?: (() => DeliverableScanScope) | undefined);
    verify(_candidate: string, task: string): Promise<VerificationResult>;
}
/**
 * The newest renderable deliverable: contract-listed paths win, then paths the
 * session touched through its own tools, then a bounded workspace scan limited
 * to files modified during this run (a subprocess may have produced them).
 * The scan stays mtime-anchored so the gate cannot be dodged by writing the
 * artifact outside the file tools — but a scope keeps a stale, unrelated
 * `.html` elsewhere in the tree from hijacking the completion gate.
 */
export declare function findRenderableDeliverable(workspace: WorkspaceBoundary, contract: TaskContract | undefined, scope?: DeliverableScanScope): Promise<RenderableDeliverable | undefined>;
