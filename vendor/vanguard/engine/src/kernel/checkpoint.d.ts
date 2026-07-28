import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult, WorkingStatePort } from "./contracts.js";
import { type DurableStateAnchorRequirement } from "./durableState.js";
export interface CheckpointState {
    readonly revision: number;
    readonly summary: string;
    readonly completed: readonly string[];
    readonly next: readonly string[];
    readonly evidence: readonly string[];
    readonly risks: readonly string[];
}
export declare class RunCheckpointLedger implements WorkingStatePort {
    #private;
    constructor(initial?: CheckpointState, file?: string);
    static open(file: string, anchor?: DurableStateAnchorRequirement): Promise<RunCheckpointLedger>;
    update(state: Omit<CheckpointState, "revision">): Promise<CheckpointState>;
    snapshot(): JsonValue;
}
export declare class CheckpointTool implements ToolPort {
    private readonly ledger;
    readonly name = "run.checkpoint";
    readonly definition: ToolDefinition;
    constructor(ledger: RunCheckpointLedger);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare function checkpointStateSha256(state: CheckpointState): string;
