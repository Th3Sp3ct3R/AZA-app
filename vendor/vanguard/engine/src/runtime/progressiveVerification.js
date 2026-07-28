import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { LANGUAGE_PROFILES } from "./repositoryModel.js";
const SYNTAX_STRATEGIES = [
    {
        language: "JavaScript",
        tier: "deep",
        extensions: [".js", ".jsx", ".mjs", ".cjs"],
        command: (file) => ({ command: "node", args: ["--check", file] }),
    },
    {
        language: "Python",
        tier: "deep",
        extensions: [".py", ".pyi"],
        command: (_file, contents) => ({
            command: "python",
            args: ["-c", "import ast,sys; ast.parse(sys.stdin.read(), filename='<vanguard-workspace>')"],
            input: contents,
        }),
    },
    {
        language: "Go",
        tier: "deep",
        extensions: [".go"],
        command: (file) => ({ command: "gofmt", args: ["-e", file] }),
    },
    {
        language: "TypeScript",
        tier: "deep",
        extensions: [".ts", ".tsx", ".mts", ".cts"],
        command: () => null,
    },
    {
        language: "Rust",
        tier: "deep",
        extensions: [".rs"],
        command: () => null,
    },
];
const EXTENSION_TO_STRATEGY = new Map(SYNTAX_STRATEGIES.flatMap((strategy) => strategy.extensions.map((extension) => [extension, strategy])));
export async function loadWorkspaceTypeScript(workspaceRoot) {
    try {
        const require = createRequire(path.join(workspaceRoot, "package.json"));
        return require("typescript");
    }
    catch {
    }
    try {
        const imported = await import("typescript");
        return imported.default ?? imported;
    }
    catch {
        return undefined;
    }
}
export class PostEditSyntaxChecker {
    runner;
    workspace;
    typescriptLoader;
    typescriptModule;
    resultCache = new Map();
    constructor(runner, workspace, typescriptLoader = loadWorkspaceTypeScript) {
        this.runner = runner;
        this.workspace = workspace;
        this.typescriptLoader = typescriptLoader;
    }
    async check(relativeFile) {
        const absoluteFile = await this.workspace.existing(relativeFile);
        const contents = await readFile(absoluteFile, "utf8");
        const contentSha256 = createHash("sha256").update(contents).digest("hex");
        const cached = this.resultCache.get(relativeFile);
        if (cached?.sha256 === contentSha256)
            return cached.result;
        const result = await this.checkUncached(relativeFile, absoluteFile, contents, contentSha256);
        this.resultCache.set(relativeFile, { sha256: contentSha256, result });
        return result;
    }
    async checkUncached(relativeFile, absoluteFile, contents, contentSha256) {
        const extension = path.extname(relativeFile).toLowerCase();
        const strategy = EXTENSION_TO_STRATEGY.get(extension);
        const profile = LANGUAGE_PROFILES.find((candidate) => candidate.extensions.includes(extension));
        if (strategy?.language === "TypeScript") {
            return this.typescriptSyntax(relativeFile, contents, strategy, contentSha256);
        }
        if (strategy !== undefined) {
            const spec = strategy.command(absoluteFile, contents);
            if (spec !== null) {
                try {
                    const result = await this.runner.run(spec.command, spec.args, this.workspace.root, spec.input);
                    const status = result.exitCode === 0 ? "passed" : "failed";
                    return {
                        status,
                        ok: status !== "failed",
                        tier: strategy.tier,
                        language: strategy.language,
                        detail: result.exitCode === 0 ? "syntax ok" : truncate(result.output),
                        contentSha256,
                    };
                }
                catch (error) {
                    return this.structural(relativeFile, contents, strategy.language, strategy.tier, contentSha256);
                }
            }
            return this.structural(relativeFile, contents, strategy.language, strategy.tier, contentSha256);
        }
        if (profile !== undefined) {
            return this.structural(relativeFile, contents, profile.language, profile.tier, contentSha256);
        }
        return {
            status: "inconclusive",
            ok: true,
            tier: "unknown",
            language: "unknown",
            detail: "no syntax parser for this file type",
            contentSha256,
        };
    }
    async typescriptSyntax(relativeFile, contents, strategy, contentSha256) {
        this.typescriptModule ??= this.typescriptLoader(this.workspace.root).catch(() => undefined);
        const ts = await this.typescriptModule;
        if (ts === undefined) {
            return this.structural(relativeFile, contents, strategy.language, strategy.tier, contentSha256);
        }
        let failures;
        let render;
        try {
            const result = ts.transpileModule(contents, {
                fileName: relativeFile,
                reportDiagnostics: true,
                compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest },
            });
            failures = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
            render = (diagnostic) => {
                const position = diagnostic.file !== undefined && diagnostic.start !== undefined
                    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
                    : undefined;
                const location = position === undefined ? "" : ` at ${position.line + 1}:${position.character + 1}`;
                return `TS${diagnostic.code}${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
            };
        }
        catch {
            return this.structural(relativeFile, contents, strategy.language, strategy.tier, contentSha256);
        }
        if (failures.length === 0) {
            return {
                status: "passed",
                ok: true,
                tier: strategy.tier,
                language: strategy.language,
                detail: "syntax ok (TypeScript parse)",
                contentSha256,
            };
        }
        return {
            status: "failed",
            ok: false,
            tier: strategy.tier,
            language: strategy.language,
            detail: truncate(failures.slice(0, 5).map(render).join("; ")),
            contentSha256,
        };
    }
    structural(file, contents, language, tier, contentSha256) {
        const balance = delimiterBalance(contents);
        return {
            status: balance.ok ? "inconclusive" : "failed",
            ok: balance.ok,
            tier,
            language,
            detail: balance.ok
                ? "delimiter scan found no obvious truncation; no parser proof is available"
                : `unbalanced ${balance.detail} in ${file}`,
            contentSha256,
        };
    }
}
export function delimiterBalance(source) {
    const stack = [];
    const pairs = { ")": "(", "]": "[", "}": "{" };
    let inString = null;
    let inLineComment = false;
    let inBlockComment = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];
        if (inLineComment) {
            if (char === "\n")
                inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (char === "*" && next === "/") {
                inBlockComment = false;
                index += 1;
            }
            continue;
        }
        if (inString !== null) {
            if (char === "\\") {
                index += 1;
                continue;
            }
            if (char === inString)
                inString = null;
            continue;
        }
        if (char === "/" && next === "/") {
            inLineComment = true;
            index += 1;
            continue;
        }
        if (char === "/" && next === "*") {
            inBlockComment = true;
            index += 1;
            continue;
        }
        if (char === "#") {
            inLineComment = true;
            continue;
        }
        if (char === "\"" || char === "'" || char === "`") {
            inString = char;
            continue;
        }
        if (char === "(" || char === "[" || char === "{") {
            stack.push(char);
            continue;
        }
        if (char === ")" || char === "]" || char === "}") {
            const expected = pairs[char];
            if (stack.pop() !== expected)
                return { ok: false, detail: `'${char}'` };
        }
    }
    if (inString !== null)
        return { ok: false, detail: "unterminated string" };
    if (stack.length > 0)
        return { ok: false, detail: `unclosed '${stack.at(-1)}'` };
    return { ok: true, detail: "balanced" };
}
export class SyntaxCheckTool {
    checker;
    name = "verify_syntax";
    definition = {
        name: this.name,
        description: "Cheaply check whether a file you just wrote is structurally valid (parse/delimiter check) before running an expensive build. Reports the language support tier. Passing here does not replace the sealed verifier.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Workspace-relative path of the file to check." },
            },
            required: ["path"],
            additionalProperties: false,
        },
        effect: "observe",
    };
    constructor(checker) {
        this.checker = checker;
    }
    async execute(input, _context) {
        if (input === null || Array.isArray(input) || typeof input !== "object") {
            throw new Error("Syntax check input must be an object.");
        }
        const file = input.path;
        if (typeof file !== "string") {
            throw new Error("Syntax check requires string 'path'.");
        }
        const result = await this.checker.check(file);
        return { ok: result.ok, output: result };
    }
}
function truncate(value, max = 400) {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
export class SyntaxCommandRunner {
    timeoutMs;
    static ALLOWED = new Set(["node", "python", "python3", "gofmt"]);
    constructor(timeoutMs = 15_000) {
        this.timeoutMs = timeoutMs;
    }
    async run(command, args, cwd, input) {
        if (!SyntaxCommandRunner.ALLOWED.has(command)) {
            throw new Error(`Syntax runner refuses non-allowlisted command: ${command}`);
        }
        return new Promise((resolve, reject) => {
            const child = spawn(command, [...args], { cwd, windowsHide: true, shell: false });
            let output = "";
            let capturedBytes = 0;
            const maxOutputBytes = 8_000;
            const capture = (chunk) => {
                if (capturedBytes >= maxOutputBytes)
                    return;
                const remaining = maxOutputBytes - capturedBytes;
                const slice = chunk.subarray(0, remaining);
                output += slice.toString("utf8");
                capturedBytes += slice.length;
            };
            child.stdout.on("data", capture);
            child.stderr.on("data", capture);
            if (input === undefined)
                child.stdin.end();
            else
                child.stdin.end(input, "utf8");
            const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("syntax check timed out")); }, this.timeoutMs);
            timer.unref();
            child.once("error", (error) => { clearTimeout(timer); reject(error); });
            child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output }); });
        });
    }
}
