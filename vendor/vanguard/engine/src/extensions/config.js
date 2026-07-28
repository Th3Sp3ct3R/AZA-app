import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceBoundary } from "../runtime/workspace.js";
import { compareOrdinal } from "../deterministicText.js";
const EFFECTS = ["observe", "mutate", "execute", "review", "state"];
const HOOK_WHEN = ["before-run", "after-run", "before-tool", "after-tool"];
const SAFE_DEFAULTS = {
    version: 1,
    permissions: { effects: ["observe", "review", "state"], customTools: [], mcpServers: [], hooks: [], commands: [] },
    skills: { roots: [".vanguard/skills"], maxFiles: 32, maxFileBytes: 128 * 1024, maxTotalBytes: 512 * 1024 },
    tools: [],
    mcp: [],
    hooks: [],
};
export async function resolveExtensions(options) {
    const workspace = new WorkspaceBoundary(options.workspaceRoot);
    const root = workspace.root;
    const working = await resolveWorkingDirectory(workspace, options.workingDirectory ?? ".");
    const provenance = [];
    const instructionParts = [];
    const maxInstructionBytes = bounded(options.maxInstructionBytes ?? 256 * 1024, 1, 4 * 1024 * 1024, "maxInstructionBytes");
    let effective = SAFE_DEFAULTS;
    if (options.disableExtensions !== true) {
        const userHome = await realpath(path.resolve(options.userHome ?? os.homedir()));
        const userAgents = path.join(userHome, ".vanguard", "AGENTS.md");
        await readInstructionFile(userAgents, "user", maxInstructionBytes, instructionParts, provenance, false);
        const userConfig = path.join(userHome, ".vanguard", "config.json");
        const layer = await readConfigFile(userConfig, "user", provenance, false);
        if (layer !== undefined) {
            effective = mergeLayer(effective, layer);
        }
        const directories = hierarchicalDirectories(root, working);
        for (const directory of directories) {
            const relativeDirectory = path.relative(root, directory);
            const agentsRelative = path.join(relativeDirectory, "AGENTS.md");
            const configRelative = path.join(relativeDirectory, ".vanguard", "config.json");
            await readWorkspaceInstruction(workspace, agentsRelative, maxInstructionBytes, instructionParts, provenance);
            const workspaceLayer = await readWorkspaceConfig(workspace, configRelative, provenance);
            if (workspaceLayer !== undefined) {
                assertDoesNotWiden(workspaceLayer.permissions, effective.permissions, configRelative);
                effective = mergeLayer(effective, workspaceLayer, effective.permissions);
            }
        }
    }
    const instructions = instructionParts.join("\n\n");
    if (Buffer.byteLength(instructions) > maxInstructionBytes) {
        throw new Error(`Combined AGENTS.md instructions exceed ${maxInstructionBytes} bytes.`);
    }
    return { config: effective, instructions, provenance };
}
function mergeLayer(current, layer, ceiling) {
    const requestedPermissions = {
        effects: layer.permissions?.effects ?? current.permissions.effects,
        customTools: layer.permissions?.customTools ?? current.permissions.customTools,
        mcpServers: layer.permissions?.mcpServers ?? current.permissions.mcpServers,
        hooks: layer.permissions?.hooks ?? current.permissions.hooks,
        commands: layer.permissions?.commands ?? current.permissions.commands,
    };
    const permissions = ceiling === undefined ? requestedPermissions : intersectPermissions(requestedPermissions, ceiling);
    return {
        version: 1,
        permissions,
        skills: {
            roots: layer.skills?.roots ?? current.skills.roots,
            maxFiles: layer.skills?.maxFiles ?? current.skills.maxFiles,
            maxFileBytes: layer.skills?.maxFileBytes ?? current.skills.maxFileBytes,
            maxTotalBytes: layer.skills?.maxTotalBytes ?? current.skills.maxTotalBytes,
        },
        tools: mergeNamed(current.tools, layer.tools),
        mcp: mergeNamed(current.mcp, layer.mcp),
        hooks: mergeNamed(current.hooks, layer.hooks),
    };
}
function mergeNamed(current, incoming) {
    if (incoming === undefined)
        return current;
    const merged = new Map(current.map((item) => [item.name, item]));
    for (const item of incoming)
        merged.set(item.name, item);
    return [...merged.values()].sort((left, right) => compareOrdinal(left.name, right.name));
}
function intersectPermissions(requested, ceiling) {
    return {
        effects: intersection(requested.effects, ceiling.effects),
        customTools: intersection(requested.customTools, ceiling.customTools),
        mcpServers: intersection(requested.mcpServers, ceiling.mcpServers),
        hooks: intersection(requested.hooks, ceiling.hooks),
        commands: intersection(requested.commands, ceiling.commands),
    };
}
function assertDoesNotWiden(requested, ceiling, source) {
    if (requested === undefined)
        return;
    for (const field of ["effects", "customTools", "mcpServers", "hooks", "commands"]) {
        const values = requested[field];
        if (values === undefined)
            continue;
        const allowed = new Set(ceiling[field]);
        const widened = values.filter((value) => !allowed.has(value));
        if (widened.length > 0) {
            throw new Error(`Workspace config '${source}' cannot widen ${field}: ${widened.join(", ")}.`);
        }
    }
}
function intersection(left, right) {
    const allowed = new Set(right);
    return [...new Set(left.filter((item) => allowed.has(item)))].sort();
}
async function resolveWorkingDirectory(workspace, relative) {
    if (path.isAbsolute(relative)) {
        const candidate = await realpath(relative);
        const rel = path.relative(workspace.root, candidate);
        if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
            throw new Error("workingDirectory escapes workspace.");
        return candidate;
    }
    return workspace.existing(relative);
}
function hierarchicalDirectories(root, working) {
    const relative = path.relative(root, working);
    if (relative === "")
        return [root];
    const output = [root];
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        output.push(cursor);
    }
    return output;
}
async function readWorkspaceInstruction(workspace, relative, maxBytes, parts, provenance) {
    try {
        const file = await workspace.existing(relative);
        await readInstructionFile(file, "workspace", maxBytes, parts, provenance, true);
    }
    catch (error) {
        if (!isMissing(error))
            throw error;
    }
}
async function readWorkspaceConfig(workspace, relative, provenance) {
    try {
        const file = await workspace.existing(relative);
        return readConfigFile(file, "workspace", provenance, true);
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
async function readInstructionFile(file, scope, maxBytes, parts, provenance, knownExisting) {
    try {
        const contents = await readFile(file);
        if (contents.byteLength > maxBytes)
            throw new Error(`Instruction file '${file}' exceeds ${maxBytes} bytes.`);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
        parts.push(`[Instructions: ${file}]\n${text}`);
        provenance.push(provenanceRecord("instructions", scope, file, contents));
    }
    catch (error) {
        if (!knownExisting && isMissing(error))
            return;
        throw error;
    }
}
async function readConfigFile(file, scope, provenance, knownExisting) {
    try {
        const contents = await readFile(file);
        if (contents.byteLength > 512 * 1024)
            throw new Error(`Config file '${file}' exceeds 524288 bytes.`);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
        const raw = JSON.parse(text);
        const parsed = parseLayer(raw, file);
        provenance.push(provenanceRecord("config", scope, file, contents));
        return parsed;
    }
    catch (error) {
        if (!knownExisting && isMissing(error))
            return undefined;
        throw error;
    }
}
function parseLayer(value, source) {
    const object = strictObject(value, source, ["version", "permissions", "skills", "tools", "mcp", "hooks"]);
    if (object.version !== 1)
        throw new Error(`${source}: version must be 1.`);
    return {
        ...(object.permissions === undefined ? {} : { permissions: parsePermissions(object.permissions, source) }),
        ...(object.skills === undefined ? {} : { skills: parseSkills(object.skills, source) }),
        ...(object.tools === undefined ? {} : { tools: array(object.tools, `${source}.tools`).map((item, index) => parseTool(item, `${source}.tools[${index}]`)) }),
        ...(object.mcp === undefined ? {} : { mcp: array(object.mcp, `${source}.mcp`).map((item, index) => parseMcp(item, `${source}.mcp[${index}]`)) }),
        ...(object.hooks === undefined ? {} : { hooks: array(object.hooks, `${source}.hooks`).map((item, index) => parseHook(item, `${source}.hooks[${index}]`)) }),
    };
}
function parsePermissions(value, source) {
    const object = strictObject(value, `${source}.permissions`, ["effects", "customTools", "mcpServers", "hooks", "commands"]);
    return {
        ...(object.effects === undefined ? {} : { effects: enumArray(object.effects, EFFECTS, `${source}.permissions.effects`) }),
        ...(object.customTools === undefined ? {} : { customTools: stringArray(object.customTools, `${source}.permissions.customTools`) }),
        ...(object.mcpServers === undefined ? {} : { mcpServers: stringArray(object.mcpServers, `${source}.permissions.mcpServers`) }),
        ...(object.hooks === undefined ? {} : { hooks: stringArray(object.hooks, `${source}.permissions.hooks`) }),
        ...(object.commands === undefined ? {} : { commands: stringArray(object.commands, `${source}.permissions.commands`) }),
    };
}
function parseSkills(value, source) {
    const object = strictObject(value, `${source}.skills`, ["roots", "maxFiles", "maxFileBytes", "maxTotalBytes"]);
    return {
        ...(object.roots === undefined ? {} : { roots: stringArray(object.roots, `${source}.skills.roots`) }),
        ...(object.maxFiles === undefined ? {} : { maxFiles: boundedNumber(object.maxFiles, 1, 1_000, `${source}.skills.maxFiles`) }),
        ...(object.maxFileBytes === undefined ? {} : { maxFileBytes: boundedNumber(object.maxFileBytes, 1, 4 * 1024 * 1024, `${source}.skills.maxFileBytes`) }),
        ...(object.maxTotalBytes === undefined ? {} : { maxTotalBytes: boundedNumber(object.maxTotalBytes, 1, 16 * 1024 * 1024, `${source}.skills.maxTotalBytes`) }),
    };
}
function parseTool(value, source) {
    const object = strictObject(value, source, ["name", "effect", "timeoutMs", "maxOutputBytes"]);
    return {
        name: namespacedName(object.name, `${source}.name`),
        effect: enumValue(object.effect, EFFECTS, `${source}.effect`),
        timeoutMs: boundedNumber(object.timeoutMs ?? 30_000, 1, 10 * 60_000, `${source}.timeoutMs`),
        maxOutputBytes: boundedNumber(object.maxOutputBytes ?? 256 * 1024, 1, 4 * 1024 * 1024, `${source}.maxOutputBytes`),
    };
}
function parseMcp(value, source) {
    const object = strictObject(value, source, ["name", "command", "args", "cwd", "tools", "timeoutMs", "maxFrameBytes"]);
    return {
        name: simpleName(object.name, `${source}.name`),
        command: nonemptyString(object.command, `${source}.command`),
        args: stringArray(object.args ?? [], `${source}.args`),
        cwd: nonemptyString(object.cwd ?? ".", `${source}.cwd`),
        tools: stringArray(object.tools ?? [], `${source}.tools`),
        timeoutMs: boundedNumber(object.timeoutMs ?? 30_000, 1, 10 * 60_000, `${source}.timeoutMs`),
        maxFrameBytes: boundedNumber(object.maxFrameBytes ?? 1024 * 1024, 1_024, 4 * 1024 * 1024, `${source}.maxFrameBytes`),
    };
}
function parseHook(value, source) {
    const object = strictObject(value, source, ["name", "when", "command", "args", "cwd", "timeoutMs", "failure"]);
    return {
        name: simpleName(object.name, `${source}.name`),
        when: enumValue(object.when, HOOK_WHEN, `${source}.when`),
        command: nonemptyString(object.command, `${source}.command`),
        args: stringArray(object.args ?? [], `${source}.args`),
        cwd: nonemptyString(object.cwd ?? ".", `${source}.cwd`),
        timeoutMs: boundedNumber(object.timeoutMs ?? 10_000, 1, 60_000, `${source}.timeoutMs`),
        failure: enumValue(object.failure ?? "fail-closed", ["fail-open", "fail-closed"], `${source}.failure`),
    };
}
function strictObject(value, source, keys) {
    if (value === null || Array.isArray(value) || typeof value !== "object")
        throw new Error(`${source} must be an object.`);
    const object = value;
    const unknown = Object.keys(object).filter((key) => !keys.includes(key)).sort();
    if (unknown.length > 0)
        throw new Error(`${source} contains unknown keys: ${unknown.join(", ")}.`);
    return object;
}
function array(value, source) {
    if (!Array.isArray(value))
        throw new Error(`${source} must be an array.`);
    return value;
}
function stringArray(value, source) {
    const values = array(value, source);
    if (!values.every((item) => typeof item === "string" && item.length > 0))
        throw new Error(`${source} must contain non-empty strings.`);
    return [...new Set(values)].sort();
}
function enumArray(value, allowed, source) {
    return stringArray(value, source).map((item) => enumValue(item, allowed, source));
}
function enumValue(value, allowed, source) {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`${source} must be one of: ${allowed.join(", ")}.`);
    return value;
}
function nonemptyString(value, source) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
        throw new Error(`${source} must be a non-empty string.`);
    return value;
}
function simpleName(value, source) {
    const name = nonemptyString(value, source);
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(name))
        throw new Error(`${source} is not a valid extension name.`);
    return name;
}
function namespacedName(value, source) {
    const name = nonemptyString(value, source);
    if (!/^[a-z][a-z0-9_-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/i.test(name))
        throw new Error(`${source} must be namespace.tool.`);
    return name;
}
function boundedNumber(value, min, max, source) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${source} must be an integer from ${min} to ${max}.`);
    return value;
}
function bounded(value, min, max, source) {
    return boundedNumber(value, min, max, source);
}
function provenanceRecord(kind, scope, file, contents) {
    return { kind, scope, file, sha256: createHash("sha256").update(contents).digest("hex") };
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function extensionRuntimeState(value) {
    return {
        config: {
            version: value.config.version,
            permissions: {
                effects: [...value.config.permissions.effects],
                customTools: [...value.config.permissions.customTools],
                mcpServers: [...value.config.permissions.mcpServers],
                hooks: [...value.config.permissions.hooks],
                commandCount: value.config.permissions.commands.length,
            },
            skills: value.config.skills,
            tools: value.config.tools,
            mcp: value.config.mcp.map((server) => ({ name: server.name, tools: [...server.tools] })),
            hooks: value.config.hooks.map((hook) => ({ name: hook.name, when: hook.when, failure: hook.failure })),
        },
        provenance: value.provenance,
        instructionBytes: Buffer.byteLength(value.instructions),
    };
}
