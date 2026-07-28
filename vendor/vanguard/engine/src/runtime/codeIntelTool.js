import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { objectInput, stringField } from "./input.js";
import { loadWorkspaceTypeScript } from "./progressiveVerification.js";
const MAX_PROJECT_FILES = 4_000;
const MAX_RESULTS = 60;
export class CodeIntelTool {
    workspace;
    typescriptLoader;
    name = "code_intel";
    definition = {
        name: this.name,
        description: "Symbol-aware navigation via the project's own TypeScript compiler: exact definition sites, every reference (callers included), or hover type info for a named symbol. Far more precise than grep for 'who calls this' and 'where is this defined' questions in TypeScript/JavaScript projects.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Workspace-relative file that contains an occurrence of the symbol." },
                line: { type: "integer", minimum: 1, description: "1-based line number of that occurrence." },
                symbol: { type: "string", description: "The identifier on that line to analyze." },
                query: { type: "string", enum: ["definition", "references", "info"], description: "What to look up." },
            },
            required: ["path", "line", "symbol", "query"],
            additionalProperties: false,
        },
        effect: "observe",
    };
    #service;
    constructor(workspace, typescriptLoader = loadWorkspaceTypeScript) {
        this.workspace = workspace;
        this.typescriptLoader = typescriptLoader;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const relativePath = stringField(fields, "path");
        const symbol = stringField(fields, "symbol");
        const query = stringField(fields, "query");
        const line = fields.line;
        if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
            throw new Error("Field 'line' must be a positive integer.");
        }
        if (query !== "definition" && query !== "references" && query !== "info") {
            throw new Error("Field 'query' must be definition, references, or info.");
        }
        const runtime = await this.#languageService();
        if (runtime === null) {
            return {
                ok: false,
                output: { error: "Code intelligence needs a resolvable `typescript` module and a tsconfig in this workspace; use grep instead." },
            };
        }
        const absolute = await this.workspace.existing(relativePath);
        let text;
        try {
            text = readFileSync(absolute, "utf8");
        }
        catch {
            return { ok: false, output: { error: "The file could not be read." } };
        }
        const lines = text.split(/\r?\n/u);
        const lineText = lines[line - 1];
        if (lineText === undefined) {
            return { ok: false, output: { error: `The file has only ${lines.length} lines.` } };
        }
        const column = lineText.indexOf(symbol);
        if (column === -1) {
            return { ok: false, output: { error: `'${symbol}' does not occur on line ${line}. Line content: ${lineText.trim().slice(0, 200)}` } };
        }
        const position = lines.slice(0, line - 1).reduce((sum, current) => sum + current.length + 1, 0) + column;
        const normalizedAbsolute = absolute.replaceAll("\\", "/");
        if (query === "info") {
            const info = runtime.service.getQuickInfoAtPosition(normalizedAbsolute, position);
            if (info === undefined)
                return { ok: false, output: { error: `No type information at '${symbol}' (${relativePath}:${line}).` } };
            return {
                ok: true,
                output: {
                    symbol,
                    type: (info.displayParts ?? []).map((part) => part.text).join("").slice(0, 1_000),
                    documentation: (info.documentation ?? []).map((part) => part.text).join("\n").slice(0, 1_000),
                },
            };
        }
        const spans = query === "definition"
            ? runtime.service.getDefinitionAtPosition(normalizedAbsolute, position)
            : runtime.service.getReferencesAtPosition(normalizedAbsolute, position);
        if (spans === undefined || spans.length === 0) {
            return { ok: false, output: { error: `No ${query} results for '${symbol}' (${relativePath}:${line}).` } };
        }
        const results = [];
        for (const span of spans.slice(0, MAX_RESULTS)) {
            const location = this.#locate(span.fileName, span.textSpan.start);
            if (location === undefined)
                continue;
            results.push({
                path: location.relative,
                line: location.line,
                text: location.lineText.trim().slice(0, 240),
                ...(query === "references" && span.isWriteAccess === true ? { write: true } : {}),
            });
        }
        return {
            ok: true,
            output: { symbol, query, results, ...(spans.length > MAX_RESULTS ? { truncated: true, total: spans.length } : {}) },
        };
    }
    #locate(fileName, start) {
        try {
            const text = readFileSync(fileName, "utf8");
            const before = text.slice(0, start);
            const line = before.split("\n").length;
            const lineText = text.split(/\r?\n/u)[line - 1] ?? "";
            const relative = path.relative(this.workspace.root, fileName).replaceAll("\\", "/");
            return { relative: relative.startsWith("..") ? fileName.replaceAll("\\", "/") : relative, line, lineText };
        }
        catch {
            return undefined;
        }
    }
    async #languageService() {
        if (this.#service !== undefined)
            return this.#service;
        const module = await this.typescriptLoader(this.workspace.root).catch(() => undefined);
        const ts = module;
        if (ts === undefined || typeof ts.createLanguageService !== "function") {
            this.#service = null;
            return null;
        }
        const configFile = ts.findConfigFile(this.workspace.root, ts.sys.fileExists.bind(ts.sys));
        if (configFile === undefined) {
            this.#service = null;
            return null;
        }
        const parsedJson = ts.readConfigFile(configFile, ts.sys.readFile.bind(ts.sys));
        if (parsedJson.config === undefined) {
            this.#service = null;
            return null;
        }
        const parsed = ts.parseJsonConfigFileContent(parsedJson.config, ts.sys, path.dirname(configFile));
        if (parsed.fileNames.length === 0 || parsed.fileNames.length > MAX_PROJECT_FILES) {
            this.#service = null;
            return null;
        }
        const rootFiles = parsed.fileNames.map((file) => file.replaceAll("\\", "/"));
        const version = (file) => {
            try {
                const metadata = statSync(file);
                return `${metadata.mtimeMs}:${metadata.size}`;
            }
            catch {
                return "missing";
            }
        };
        const host = {
            getScriptFileNames: () => [...rootFiles],
            getScriptVersion: version,
            getScriptSnapshot: (file) => {
                try {
                    return ts.ScriptSnapshot.fromString(readFileSync(file, "utf8"));
                }
                catch {
                    return undefined;
                }
            },
            getCurrentDirectory: () => this.workspace.root,
            getCompilationSettings: () => parsed.options,
            getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
            fileExists: ts.sys.fileExists.bind(ts.sys),
            readFile: ts.sys.readFile.bind(ts.sys),
            readDirectory: ts.sys.readDirectory.bind(ts.sys),
            directoryExists: ts.sys.directoryExists.bind(ts.sys),
            getDirectories: ts.sys.getDirectories.bind(ts.sys),
            useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        };
        this.#service = { service: ts.createLanguageService(host), ts, rootFiles };
        return this.#service;
    }
}
