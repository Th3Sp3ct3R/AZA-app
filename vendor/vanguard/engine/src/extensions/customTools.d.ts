import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import type { CustomToolDeclaration, ExtensionEffect, ExtensionPermissions } from "./config.js";
export { validateJsonSchema, validateSchemaDefinition } from "../jsonSchema.js";
export interface CustomToolImplementation {
    readonly definition: ToolDefinition & {
        readonly effect: ExtensionEffect;
    };
    /** Independently supplied by the implementation factory, not its config. */
    readonly implementationEffect: ExtensionEffect;
    readonly provenance: string;
    execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}
export interface RegisteredToolProvenance {
    readonly name: string;
    readonly effect: ExtensionEffect;
    readonly provenance: string;
}
/** Exact-match permission policy. Wildcards are deliberately unsupported. */
export declare class ExtensionPermissionPolicy {
    #private;
    constructor(permissions: ExtensionPermissions);
    authorizeTool(name: string, effect: ExtensionEffect): void;
    authorizeServer(name: string): void;
    authorizeHook(name: string): void;
    authorizeCommand(command: string): void;
}
export declare class CustomToolRegistry {
    #private;
    private readonly policy;
    private readonly declarations;
    constructor(policy: ExtensionPermissionPolicy, declarations: readonly CustomToolDeclaration[]);
    register(implementation: CustomToolImplementation): ToolPort;
    get(name: string): ToolPort | undefined;
    tools(): readonly ToolPort[];
    provenance(): readonly RegisteredToolProvenance[];
}
