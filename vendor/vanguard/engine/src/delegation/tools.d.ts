import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { DelegationCoordinator } from "./coordinator.js";
export declare function createDelegationTools(coordinator: DelegationCoordinator): readonly ToolPort[];
/**
 * Kimi-style single subagent surface backed by Vanguard's real durable child
 * scheduler. The profile is enforced again by the child CLI: explore/plan
 * children receive no mutating, process, extension, or nested-delegation tools.
 */
export declare class DelegateAgentTool implements ToolPort {
    private readonly coordinator;
    readonly name = "delegate_agent";
    readonly definition: ToolDefinition;
    constructor(coordinator: DelegationCoordinator);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
/** Item-template fan-out equivalent to Kimi's AgentSwarm, with Vanguard's
 * stricter scheduler budgets and transactional patch boundary retained. */
export declare class DelegateSwarmTool implements ToolPort {
    private readonly coordinator;
    readonly name = "delegate_swarm";
    readonly definition: ToolDefinition;
    constructor(coordinator: DelegationCoordinator);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
/**
 * Hypothesis racing: when a fix has resisted sequential attempts, run 2-3
 * competing approaches as isolated children simultaneously and keep the
 * first that completes. Losers are cancelled; the winner's reviewed patch
 * still requires the ordinary explicit delegate_merge confirmation, so
 * racing changes speed, never safety.
 */
export declare class DelegateRaceTool implements ToolPort {
    private readonly coordinator;
    readonly name = "delegate_race";
    readonly definition: ToolDefinition;
    constructor(coordinator: DelegationCoordinator);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class DelegateStartTool implements ToolPort {
    private readonly coordinator;
    readonly name = "delegate_start";
    readonly definition: ToolDefinition;
    constructor(coordinator: DelegationCoordinator);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class DelegateStatusTool implements ToolPort {
    private readonly coordinator;
    readonly name = "delegate_status";
    readonly definition: ToolDefinition;
    constructor(coordinator: DelegationCoordinator);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class DelegateWaitTool implements ToolPort {
    private readonly coordinator;
    readonly name = "delegate_wait";
    readonly definition: ToolDefinition;
    constructor(coordinator: DelegationCoordinator);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class DelegateCancelTool implements ToolPort {
    private readonly coordinator;
    readonly name = "delegate_cancel";
    readonly definition: ToolDefinition;
    constructor(coordinator: DelegationCoordinator);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
export declare class DelegateMergeTool implements ToolPort {
    private readonly coordinator;
    readonly name = "delegate_merge";
    readonly definition: ToolDefinition;
    constructor(coordinator: DelegationCoordinator);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
