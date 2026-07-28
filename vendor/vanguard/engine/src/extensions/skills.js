import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { asciiLowercase, compareOrdinal } from "../deterministicText.js";
export async function loadWorkspaceSkills(workspace, policy) {
    const candidates = [];
    for (const root of [...policy.roots].sort()) {
        const absolute = await workspace.existing(root);
        await collectSkillFiles(workspace, absolute, candidates, policy.maxFiles);
    }
    candidates.sort(compareOrdinal);
    if (candidates.length > policy.maxFiles)
        throw new Error(`Skill file count exceeds ${policy.maxFiles}.`);
    let totalBytes = 0;
    const names = new Set();
    const loaded = [];
    for (const skillFile of candidates) {
        const directory = path.dirname(skillFile);
        const resources = await collectResources(workspace, directory, policy);
        const descriptor = resources.find((resource) => asciiLowercase(path.basename(resource.path)) === "skill.md");
        if (descriptor === undefined)
            throw new Error(`Skill '${directory}' has no SKILL.md resource.`);
        totalBytes += resources.reduce((sum, resource) => sum + resource.bytes, 0);
        if (totalBytes > policy.maxTotalBytes)
            throw new Error(`Skill corpus exceeds ${policy.maxTotalBytes} bytes.`);
        const contents = await readFile(skillFile);
        if (contents.byteLength > policy.maxFileBytes)
            throw new Error(`Skill file '${skillFile}' exceeds ${policy.maxFileBytes} bytes.`);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
        const parsed = parseSkill(text, skillFile);
        if (names.has(parsed.metadata.name))
            throw new Error(`Duplicate skill name '${parsed.metadata.name}'.`);
        names.add(parsed.metadata.name);
        loaded.push({ ...parsed, directory, source: skillFile, resources });
    }
    return loaded;
}
export async function readSkillResource(workspace, skill, relativeResource, maxBytes) {
    if (relativeResource.length === 0 || path.isAbsolute(relativeResource))
        throw new Error("Skill resource paths must be relative.");
    const candidate = path.join(skill.directory, relativeResource);
    const relativeWorkspace = path.relative(workspace.root, candidate);
    const resolved = await workspace.existing(relativeWorkspace);
    const relativeSkill = path.relative(skill.directory, resolved);
    if (relativeSkill === ".." || relativeSkill.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSkill)) {
        throw new Error("Skill resource escapes its skill directory.");
    }
    const resource = skill.resources.find((entry) => path.resolve(entry.path) === path.resolve(resolved));
    if (resource === undefined)
        throw new Error("Skill resource was not present in the bounded manifest.");
    if (resource.bytes > maxBytes)
        throw new Error(`Skill resource exceeds ${maxBytes} bytes.`);
    return readFile(resolved);
}
async function collectSkillFiles(workspace, directory, output, maxFiles) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => compareOrdinal(a.name, b.name))) {
        if (output.length > maxFiles)
            return;
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
            continue;
        if (entry.isDirectory()) {
            const relative = path.relative(workspace.root, absolute);
            const resolved = await workspace.existing(relative);
            await collectSkillFiles(workspace, resolved, output, maxFiles);
        }
        else if (entry.isFile() && asciiLowercase(entry.name) === "skill.md") {
            const resolved = await realpath(absolute);
            assertInside(workspace.root, resolved, "Skill file");
            output.push(resolved);
        }
    }
}
async function collectResources(workspace, directory, policy) {
    const output = [];
    const walk = async (current) => {
        for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => compareOrdinal(a.name, b.name))) {
            const absolute = path.join(current, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                await walk(await workspace.existing(path.relative(workspace.root, absolute)));
                continue;
            }
            if (!entry.isFile())
                continue;
            if (output.length >= policy.maxFiles)
                throw new Error(`Skill resource count exceeds ${policy.maxFiles}.`);
            const resolved = await workspace.existing(path.relative(workspace.root, absolute));
            const stat = await lstat(resolved);
            if (stat.size > policy.maxFileBytes)
                throw new Error(`Skill resource '${resolved}' exceeds ${policy.maxFileBytes} bytes.`);
            const contents = await readFile(resolved);
            output.push({
                path: resolved,
                bytes: contents.byteLength,
                sha256: createHash("sha256").update(contents).digest("hex"),
                executable: false,
            });
        }
    };
    await walk(directory);
    return output.sort((left, right) => compareOrdinal(left.path, right.path));
}
function parseSkill(text, source) {
    if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
        throw new Error(`${source}: SKILL.md requires a YAML-like metadata header.`);
    }
    const normalized = text.replaceAll("\r\n", "\n");
    const end = normalized.indexOf("\n---\n", 4);
    if (end < 0)
        throw new Error(`${source}: SKILL.md metadata header is not closed.`);
    const header = normalized.slice(4, end);
    const metadata = {};
    for (const [index, line] of header.split("\n").entries()) {
        if (line.trim().length === 0)
            continue;
        const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.+)$/.exec(line);
        if (match === null)
            throw new Error(`${source}: invalid metadata line ${index + 1}.`);
        const key = match[1];
        if (!["name", "description", "version"].includes(key))
            throw new Error(`${source}: unknown metadata key '${key}'.`);
        if (metadata[key] !== undefined)
            throw new Error(`${source}: duplicate metadata key '${key}'.`);
        metadata[key] = unquote(match[2].trim());
    }
    const name = metadata.name;
    const description = metadata.description;
    if (name === undefined || !/^[a-z][a-z0-9_-]{0,63}$/.test(name))
        throw new Error(`${source}: skill name is invalid.`);
    if (description === undefined || description.length === 0 || description.length > 1_000)
        throw new Error(`${source}: skill description is invalid.`);
    const instructions = normalized.slice(end + 5).trim();
    if (instructions.length === 0)
        throw new Error(`${source}: skill instructions are empty.`);
    return {
        metadata: { name, description, ...(metadata.version === undefined ? {} : { version: metadata.version }) },
        instructions,
    };
}
function unquote(value) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function assertInside(root, candidate, label) {
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error(`${label} escapes workspace.`);
}
