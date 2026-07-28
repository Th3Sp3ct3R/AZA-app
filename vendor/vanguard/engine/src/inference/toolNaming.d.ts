import type { ToolDefinition } from "../kernel/contracts.js";
/** One provider's documented tool-name constraint. */
export interface ToolNamingRules {
    /** Used in diagnostics; the provider's own name. */
    readonly vendor: string;
    readonly maxLength: number;
}
/** OpenAI Responses and Chat Completions: ^[a-zA-Z0-9_-]+$, 64 characters. */
export declare const OPENAI_TOOL_NAMING: ToolNamingRules;
/** Anthropic Messages: ^[a-zA-Z0-9_-]{1,128}$, as the API's own 400 states. */
export declare const ANTHROPIC_TOOL_NAMING: ToolNamingRules;
/** The vendor spelling of an internal name, with no mapping state required. */
export declare function sanitizeToolName(internalName: string): string;
/**
 * Translates tool names between Vanguard's internal spelling and one provider's.
 *
 * A codec holds one of these and uses exactly three calls: `register` at the top
 * of encode, `toVendor` wherever a name goes onto the wire, and `toInternal`
 * wherever one comes back.
 */
export declare class ToolNameTranslator {
    #private;
    private readonly rules;
    constructor(rules: ToolNamingRules);
    /** Rebuild the mapping for one request; call at the top of encode(). */
    register(tools: readonly ToolDefinition[]): void;
    /** Internal name to the spelling this provider accepts. */
    toVendor(internalName: string): string;
    /**
     * A name off the wire back to its internal spelling. Falls back to the control
     * table, then to the name as given, so decoding never depends on having
     * encoded first.
     */
    toInternal(vendorName: string): string;
}
