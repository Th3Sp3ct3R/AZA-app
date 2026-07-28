import { compareOrdinal, lowercaseInvariant } from "../deterministicText.js";
import { validateJsonSchema, validateSchemaDefinition } from "../jsonSchema.js";
export { validateJsonSchema, validateSchemaDefinition } from "../jsonSchema.js";
export class ExtensionPermissionPolicy {
    #effects;
    #tools;
    #servers;
    #hooks;
    #commands;
    constructor(permissions) {
        this.#effects = new Set(permissions.effects);
        this.#tools = new Set(permissions.customTools);
        this.#servers = new Set(permissions.mcpServers);
        this.#hooks = new Set(permissions.hooks);
        this.#commands = new Set(permissions.commands.map(normalizeCommand));
    }
    authorizeTool(name, effect) {
        if (!this.#tools.has(name))
            throw new Error(`Custom tool '${name}' is not permitted.`);
        if (!this.#effects.has(effect))
            throw new Error(`Custom tool '${name}' effect '${effect}' is not permitted.`);
    }
    authorizeServer(name) {
        if (!this.#servers.has(name))
            throw new Error(`MCP server '${name}' is not permitted.`);
    }
    authorizeHook(name) {
        if (!this.#hooks.has(name))
            throw new Error(`Hook '${name}' is not permitted.`);
    }
    authorizeCommand(command) {
        if (!this.#commands.has(normalizeCommand(command)))
            throw new Error(`Extension command '${command}' is not permitted.`);
    }
}
export class CustomToolRegistry {
    policy;
    declarations;
    #tools = new Map();
    #provenance = new Map();
    constructor(policy, declarations) {
        this.policy = policy;
        this.declarations = declarations;
    }
    register(implementation) {
        const name = implementation.definition.name;
        assertNamespaced(name);
        if (implementation.definition.effect !== implementation.implementationEffect) {
            throw new Error(`Custom tool '${name}' effect declaration does not match its implementation metadata.`);
        }
        if (this.#tools.has(name))
            throw new Error(`Custom tool '${name}' is already registered.`);
        const declaration = this.declarations.find((item) => item.name === name);
        if (declaration === undefined)
            throw new Error(`Custom tool '${name}' has no config declaration.`);
        if (declaration.effect !== implementation.definition.effect) {
            throw new Error(`Custom tool '${name}' effect does not match config provenance.`);
        }
        this.policy.authorizeTool(name, declaration.effect);
        validateSchemaDefinition(implementation.definition.inputSchema, `${name} input schema`);
        const tool = new GuardedCustomTool(implementation, declaration);
        this.#tools.set(name, tool);
        this.#provenance.set(name, { name, effect: declaration.effect, provenance: implementation.provenance });
        return tool;
    }
    get(name) {
        return this.#tools.get(name);
    }
    tools() {
        return [...this.#tools.values()].sort((left, right) => compareOrdinal(left.name, right.name));
    }
    provenance() {
        return [...this.#provenance.values()].sort((left, right) => compareOrdinal(left.name, right.name));
    }
}
class GuardedCustomTool {
    implementation;
    declaration;
    name;
    definition;
    constructor(implementation, declaration) {
        this.implementation = implementation;
        this.declaration = declaration;
        this.name = implementation.definition.name;
        const { evidenceAuthority: _untrustedEvidenceAuthority, ...definition } = implementation.definition;
        this.definition = definition;
    }
    async execute(input, context) {
        const errors = validateJsonSchema(input, this.definition.inputSchema);
        if (errors.length > 0)
            return { ok: false, output: { error: "Input schema validation failed.", details: [...errors] } };
        const controller = new AbortController();
        let settleGuard;
        const guard = new Promise((resolve) => { settleGuard = resolve; });
        const abort = () => {
            settleGuard({ ok: false, output: { error: "Custom tool aborted." } });
            controller.abort();
        };
        context.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => {
            settleGuard({ ok: false, output: { error: "Custom tool timed out.", timeoutMs: this.declaration.timeoutMs } });
            controller.abort();
        }, this.declaration.timeoutMs);
        try {
            const result = await Promise.race([
                this.implementation.execute(input, { ...context, signal: controller.signal }),
                guard,
            ]);
            const serialized = JSON.stringify(result.output);
            if (serialized === undefined)
                return { ok: false, output: { error: "Custom tool returned a non-JSON output." } };
            const bytes = Buffer.byteLength(serialized);
            if (bytes > this.declaration.maxOutputBytes) {
                return { ok: false, output: { error: "Custom tool output exceeded its cap.", bytes, maxOutputBytes: this.declaration.maxOutputBytes } };
            }
            return result;
        }
        catch (error) {
            return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
        }
        finally {
            clearTimeout(timer);
            context.signal.removeEventListener("abort", abort);
        }
    }
}
function assertNamespaced(name) {
    if (!/^[a-z][a-z0-9_-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/i.test(name))
        throw new Error(`Custom tool '${name}' must be namespace.tool.`);
}
function normalizeCommand(command) {
    return process.platform === "win32" ? lowercaseInvariant(command.trim()) : command.trim();
}
