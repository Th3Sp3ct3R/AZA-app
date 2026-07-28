import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { asciiLowercase, lowercaseInvariant } from "../deterministicText.js";
export function nodePermissionFlag(version = process.versions.node) {
    const major = Number(version.split(".", 1)[0]);
    if (!Number.isSafeInteger(major) || major < 20) {
        throw new Error(`Unsupported Node version for the permission model: ${version}.`);
    }
    return major >= 22 ? "--permission" : "--experimental-permission";
}
export function resolveNodePackageManagerAlias(manager, environment = process.env, nodeExecutable = process.execPath) {
    const entrypoint = `${manager}-cli.js`;
    const candidates = [];
    const npmExecPath = environment.npm_execpath?.trim();
    if (npmExecPath !== undefined && npmExecPath.length > 0) {
        candidates.push(manager === "npm" ? npmExecPath : path.join(path.dirname(npmExecPath), entrypoint));
    }
    const executableDirectory = path.dirname(nodeExecutable);
    candidates.push(path.join(executableDirectory, "node_modules", "npm", "bin", entrypoint));
    const prefix = environment.npm_config_prefix?.trim();
    if (prefix !== undefined && prefix.length > 0) {
        candidates.push(path.join(prefix, "node_modules", "npm", "bin", entrypoint), path.join(prefix, "lib", "node_modules", "npm", "bin", entrypoint));
    }
    for (const directory of (environment.PATH ?? environment.Path ?? "").split(path.delimiter)) {
        if (directory.length === 0)
            continue;
        candidates.push(path.join(directory, "node_modules", "npm", "bin", entrypoint), path.join(directory, "..", "npm", "bin", entrypoint));
        for (const commandName of process.platform === "win32"
            ? [manager, `${manager}.cmd`, `${manager}.ps1`]
            : [manager]) {
            const command = path.join(directory, commandName);
            if (!existsSync(command))
                continue;
            try {
                const resolved = realpathSync(command);
                if (asciiLowercase(path.basename(resolved)) === entrypoint)
                    candidates.push(resolved);
            }
            catch {
            }
        }
    }
    const seen = new Set();
    for (const candidate of candidates) {
        const normalized = path.resolve(candidate);
        const key = process.platform === "win32" ? lowercaseInvariant(normalized) : normalized;
        if (seen.has(key))
            continue;
        seen.add(key);
        if (asciiLowercase(path.basename(normalized)) !== entrypoint)
            continue;
        if (!existsSync(normalized))
            continue;
        return { executable: nodeExecutable, argsPrefix: [normalized] };
    }
    return undefined;
}
