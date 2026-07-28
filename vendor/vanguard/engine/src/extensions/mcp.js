import { spawn } from "node:child_process";
import { NdjsonFramer, NdjsonWriter } from "../engine/ndjson.js";
import { createSecretRedactor } from "../engine/security.js";
import { validateJsonSchema, validateSchemaDefinition } from "../jsonSchema.js";
import { compareOrdinal } from "../deterministicText.js";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26"]);
export class McpStdioClient {
    declaration;
    policy;
    audit;
    #writer;
    #pending = new Map();
    #redact;
    #child;
    #nextId = 1;
    #closed = false;
    #cleanupDone = false;
    #state;
    constructor(declaration, policy, audit, child, environment) {
        this.declaration = declaration;
        this.policy = policy;
        this.audit = audit;
        this.#child = child;
        this.#redact = createSecretRedactor(environment);
        this.#writer = new NdjsonWriter(child.stdin, {
            maxFrameBytes: declaration.maxFrameBytes,
            maxQueueBytes: declaration.maxFrameBytes * 4,
        });
        const framer = new NdjsonFramer({
            maxFrameBytes: declaration.maxFrameBytes,
            onFrame: (frame) => this.#receive(frame),
            onError: (code, message) => this.#fail(new Error(`MCP ${code}: ${message}`)),
        });
        child.stdout.on("data", (chunk) => framer.push(chunk));
        child.stdout.on("end", () => framer.end());
        child.on("error", (error) => this.#fail(error));
        child.on("close", () => this.#fail(new Error(`MCP server '${declaration.name}' disconnected.`)));
        let stderrBytes = 0;
        child.stderr.on("data", (chunk) => {
            stderrBytes += chunk.byteLength;
            if (stderrBytes > declaration.maxFrameBytes)
                this.#fail(new Error("MCP stderr exceeded its bounded capacity."));
        });
    }
    static async connect(workspace, declaration, policy, audit, environment = process.env) {
        policy.authorizeServer(declaration.name);
        policy.authorizeCommand(declaration.command);
        const cwd = await workspace.existing(declaration.cwd);
        const child = spawn(declaration.command, [...declaration.args], {
            cwd,
            shell: false,
            windowsHide: true,
            env: safeEnvironment(environment),
            stdio: ["pipe", "pipe", "pipe"],
        });
        const client = new McpStdioClient(declaration, policy, audit, child, environment);
        await audit.record({ type: "mcp.lifecycle", name: declaration.name, status: "started", detail: { pid: child.pid ?? null } });
        try {
            await client.#initialize();
            return client;
        }
        catch (error) {
            await client.close();
            throw error;
        }
    }
    state() {
        if (this.#state === undefined)
            throw new Error("MCP client is not initialized.");
        return this.#state;
    }
    tools(namespace = `mcp_${this.declaration.name}`) {
        return this.state().tools.map((descriptor) => new McpToolPort(this, descriptor, namespace));
    }
    async callTool(name, input) {
        const descriptor = this.state().tools.find((tool) => tool.name === name);
        if (descriptor === undefined)
            return { ok: false, output: { error: `MCP tool '${name}' is not allowlisted.` } };
        const validation = validateJsonSchema(input, descriptor.inputSchema);
        if (validation.length > 0)
            return { ok: false, output: { error: "MCP tool input validation failed.", details: [...validation] } };
        try {
            const result = await this.#request("tools/call", { name, arguments: input });
            const bounded = JSON.stringify(result);
            if (bounded === undefined || Buffer.byteLength(bounded) > this.declaration.maxFrameBytes) {
                return { ok: false, output: { error: "MCP tool result exceeded its cap." } };
            }
            const redacted = redactJson(result, this.#redact);
            const isError = redacted !== null && !Array.isArray(redacted) && typeof redacted === "object" && redacted.isError === true;
            return { ok: !isError, output: redacted };
        }
        catch (error) {
            return { ok: false, output: { error: this.#redact(error instanceof Error ? error.message : String(error)) } };
        }
    }
    async close() {
        if (this.#cleanupDone)
            return;
        this.#cleanupDone = true;
        this.#closed = true;
        this.#fail(new Error(`MCP server '${this.declaration.name}' closed.`));
        await this.#writer.close().catch(() => undefined);
        if (!this.#child.killed)
            this.#child.kill();
        await this.audit.record({ type: "mcp.lifecycle", name: this.declaration.name, status: "stopped", detail: {} });
    }
    async #initialize() {
        const result = await this.#request("initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "vanguard", version: "0.1.0" },
        });
        if (result === null || Array.isArray(result) || typeof result !== "object")
            throw new Error("MCP initialize result is malformed.");
        const protocolVersion = result.protocolVersion;
        if (typeof protocolVersion !== "string" || !SUPPORTED_PROTOCOLS.has(protocolVersion)) {
            throw new Error(`MCP server selected unsupported protocol '${String(protocolVersion)}'.`);
        }
        const capabilities = result.capabilities;
        if (capabilities === null || Array.isArray(capabilities) || typeof capabilities !== "object")
            throw new Error("MCP capabilities are malformed.");
        await this.#notify("notifications/initialized", {});
        const listed = await this.#request("tools/list", {});
        if (listed === null || Array.isArray(listed) || typeof listed !== "object" || !Array.isArray(listed.tools)) {
            throw new Error("MCP tools/list result is malformed.");
        }
        const allowed = new Set(this.declaration.tools);
        const tools = listed.tools.map(parseToolDescriptor).filter((tool) => allowed.has(tool.name));
        const missing = this.declaration.tools.filter((name) => !tools.some((tool) => tool.name === name));
        if (missing.length > 0)
            throw new Error(`MCP server did not provide allowlisted tools: ${missing.join(", ")}.`);
        this.#state = { server: this.declaration.name, protocolVersion, capabilities, tools: tools.sort((a, b) => compareOrdinal(a.name, b.name)) };
    }
    #request(method, params) {
        if (this.#closed)
            return Promise.reject(new Error("MCP client is closed."));
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`MCP request '${method}' timed out.`));
            }, this.declaration.timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            void this.#writer.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    #notify(method, params) {
        return this.#writer.send({ jsonrpc: "2.0", method, params });
    }
    #receive(frame) {
        let value;
        try {
            value = JSON.parse(frame);
        }
        catch {
            this.#fail(new Error("MCP server emitted malformed JSON."));
            return;
        }
        if (value === null || Array.isArray(value) || typeof value !== "object") {
            this.#fail(new Error("MCP server emitted a non-object response."));
            return;
        }
        const response = value;
        if (response.jsonrpc !== "2.0" || !Number.isSafeInteger(response.id)) {
            if (!("method" in value))
                this.#fail(new Error("MCP response envelope is malformed."));
            return;
        }
        const pending = this.#pending.get(response.id);
        if (pending === undefined) {
            this.#fail(new Error(`MCP response has unknown id '${response.id}'.`));
            return;
        }
        clearTimeout(pending.timer);
        this.#pending.delete(response.id);
        if (response.error !== undefined)
            pending.reject(new Error(`MCP ${response.error.code}: ${response.error.message}`));
        else if (response.result === undefined)
            pending.reject(new Error("MCP response has neither result nor error."));
        else
            pending.resolve(response.result);
    }
    #fail(error) {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
        if (!this.#closed) {
            this.#closed = true;
            if (!this.#child.killed)
                this.#child.kill();
        }
    }
}
class McpToolPort {
    client;
    descriptor;
    name;
    definition;
    constructor(client, descriptor, namespace) {
        this.client = client;
        this.descriptor = descriptor;
        if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(namespace))
            throw new Error("MCP namespace is invalid.");
        this.name = `${namespace}.${descriptor.name}`;
        this.definition = {
            name: this.name,
            description: descriptor.description,
            inputSchema: descriptor.inputSchema,
            effect: "execute",
        };
    }
    execute(input, _context) {
        return this.client.callTool(this.descriptor.name, input);
    }
}
function parseToolDescriptor(value) {
    if (value === null || Array.isArray(value) || typeof value !== "object")
        throw new Error("MCP tool descriptor is malformed.");
    if (typeof value.name !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/i.test(value.name))
        throw new Error("MCP tool name is invalid.");
    if (typeof value.description !== "string")
        throw new Error(`MCP tool '${value.name}' description is invalid.`);
    if (value.inputSchema === null || Array.isArray(value.inputSchema) || typeof value.inputSchema !== "object") {
        throw new Error(`MCP tool '${value.name}' input schema is invalid.`);
    }
    validateSchemaDefinition(value.inputSchema, `MCP tool '${value.name}' input schema`);
    return { name: value.name, description: value.description, inputSchema: value.inputSchema };
}
function redactJson(value, redact) {
    if (typeof value === "string")
        return redact(value);
    if (Array.isArray(value))
        return value.map((item) => redactJson(item, redact));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactJson(child, redact)]));
    }
    return value;
}
function safeEnvironment(environment) {
    const names = process.platform === "win32"
        ? ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "PATHEXT", "COMSPEC"]
        : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    const safe = {};
    for (const name of names)
        if (environment[name] !== undefined)
            safe[name] = environment[name];
    safe.VANGUARD_MCP = "1";
    return safe;
}
