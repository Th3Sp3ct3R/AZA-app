import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { detectProjectVerification } from "./projectVerification.js";
import { resolveNodePackageManagerAlias } from "./nodePackageManager.js";
import { asciiLowercase } from "../deterministicText.js";
export const ADAPTIVE_VERIFY_COMMAND = "vanguard:adaptive-verify";
export function isAdaptiveVerifyCommand(specification) {
    return specification.command === ADAPTIVE_VERIFY_COMMAND;
}
export function adaptiveVerifyMode(specification) {
    const flag = specification.args.indexOf("--mode");
    return parseVerificationMode(flag === -1 ? undefined : specification.args[flag + 1]);
}
export function parseVerificationMode(value) {
    return value?.trim().toLowerCase() === "build" ? "build" : "tests";
}
export async function runAutomaticVerification(workspace, mode = "tests", sink) {
    const out = sink ?? ((line) => process.stdout.write(`${line}\n`));
    const err = sink ?? ((line) => process.stderr.write(`${line}\n`));
    const detected = await detectProjectVerification(workspace);
    const commands = detected === undefined ? await fallbackCommands(workspace) : [detected];
    if (commands.length === 0) {
        if (mode === "build") {
            out("[verify] no build or test contract in this project; completion rests on tool evidence "
                + "(files written and syntax-checked), not on an independent test run.");
            return { status: "not_required", commands: [], exitCode: 0 };
        }
        err("Vanguard could not find a project verification contract. "
            + "Create a package.json test/check/build script, Gradle wrapper, pyproject.toml, Cargo.toml, pom.xml, or CMakeLists.txt.");
        return { status: "missing", commands: [], exitCode: 2 };
    }
    for (const command of commands) {
        out(`[verify] ${command.command} ${command.args.join(" ")}`);
        const exitCode = await runCommand(command, workspace, sink);
        if (exitCode !== 0)
            return { status: "failed", commands, exitCode };
    }
    return { status: "passed", commands, exitCode: 0 };
}
export class AdaptiveCommandVerifier {
    name;
    workspaceRoot;
    mode;
    constructor(name, workspaceRoot, mode) {
        this.name = name;
        this.workspaceRoot = workspaceRoot;
        this.mode = mode;
    }
    async verify(_candidate, _task) {
        const lines = [];
        let bytes = 0;
        const collect = (line) => {
            if (bytes >= 262_144)
                return;
            bytes += line.length + 1;
            lines.push(line.slice(0, 8_192));
        };
        const result = await runAutomaticVerification(this.workspaceRoot, this.mode, collect);
        return {
            verifier: this.name,
            passed: result.exitCode === 0,
            evidence: {
                status: result.status,
                exitCode: result.exitCode,
                commands: result.commands.map((command) => `${command.command} ${command.args.join(" ")}`),
                output: lines.join("\n"),
            },
        };
    }
}
async function fallbackCommands(workspace) {
    if (await exists(path.join(workspace, "CMakeLists.txt"))) {
        return [
            { command: "cmake", args: ["-S", ".", "-B", ".vanguard-build"] },
            { command: "cmake", args: ["--build", ".vanguard-build", "--config", "Release"] },
        ];
    }
    return [];
}
async function runCommand(specification, workspace, sink) {
    const resolved = resolveCommand(specification);
    return await new Promise((resolve) => {
        const child = spawn(resolved.command, resolved.args, {
            cwd: workspace,
            shell: false,
            windowsHide: true,
            stdio: sink === undefined ? "inherit" : ["ignore", "pipe", "pipe"],
        });
        if (sink !== undefined) {
            const forward = (chunk) => {
                for (const line of String(chunk).split(/\r?\n/u))
                    if (line.length > 0)
                        sink(line);
            };
            child.stdout?.on("data", forward);
            child.stderr?.on("data", forward);
        }
        child.once("error", (error) => {
            if (sink === undefined)
                process.stderr.write(`${error.message}\n`);
            else
                sink(error.message);
            resolve(1);
        });
        child.once("close", (code) => resolve(code ?? 1));
    });
}
function resolveCommand(specification) {
    if (asciiLowercase(specification.command) !== "npm")
        return specification;
    const npm = resolveNodePackageManagerAlias("npm");
    if (npm === undefined) {
        throw new Error("Could not locate npm-cli.js. Install npm with Node or launch Vanguard from an npm-managed environment.");
    }
    return { command: npm.executable, args: [...npm.argsPrefix, ...specification.args] };
}
async function exists(file) {
    try {
        await access(file);
        return true;
    }
    catch {
        return false;
    }
}
