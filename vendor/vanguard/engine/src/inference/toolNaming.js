import { CONTROL_TOOL_NAMES, LEGACY_TOOL_NAMES } from "../kernel/contracts.js";
export const OPENAI_TOOL_NAMING = { vendor: "OpenAI", maxLength: 64 };
export const ANTHROPIC_TOOL_NAMING = { vendor: "Anthropic", maxLength: 128 };
const DISALLOWED = /[^a-zA-Z0-9_-]/gu;
export function sanitizeToolName(internalName) {
    return internalName.replace(DISALLOWED, "_");
}
const CONTROL_VENDOR_NAMES = Object.fromEntries([
    ...Object.values(CONTROL_TOOL_NAMES).map((name) => [sanitizeToolName(name), name]),
    ...Object.entries(LEGACY_TOOL_NAMES).map(([legacy, current]) => [sanitizeToolName(legacy), current]),
]);
export class ToolNameTranslator {
    rules;
    #vendorToInternal = new Map();
    constructor(rules) {
        this.rules = rules;
    }
    register(tools) {
        this.#vendorToInternal.clear();
        for (const tool of tools) {
            const vendorName = this.toVendor(tool.name);
            const existing = this.#vendorToInternal.get(vendorName);
            if (existing !== undefined && existing !== tool.name) {
                throw new Error(`${this.rules.vendor} tool-name collision between '${existing}' and '${tool.name}'.`);
            }
            this.#vendorToInternal.set(vendorName, tool.name);
        }
    }
    toVendor(internalName) {
        const safe = sanitizeToolName(internalName);
        if (safe.length === 0 || safe.length > this.rules.maxLength) {
            throw new Error(`Tool name cannot be mapped to ${this.rules.vendor}: ${internalName}`);
        }
        return safe;
    }
    toInternal(vendorName) {
        return this.#vendorToInternal.get(vendorName) ?? CONTROL_VENDOR_NAMES[vendorName] ?? vendorName;
    }
}
