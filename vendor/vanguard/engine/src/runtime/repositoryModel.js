import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { objectInput, optionalStringField } from "./input.js";
export const LANGUAGE_PROFILES = [
    { language: "TypeScript", tier: "deep", extensions: [".ts", ".tsx", ".mts", ".cts"] },
    { language: "JavaScript", tier: "deep", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
    { language: "Python", tier: "deep", extensions: [".py", ".pyi"] },
    { language: "Rust", tier: "deep", extensions: [".rs"] },
    { language: "Go", tier: "deep", extensions: [".go"] },
    { language: "Java", tier: "generic", extensions: [".java"] },
    { language: "Kotlin", tier: "generic", extensions: [".kt", ".kts"] },
    { language: "C#", tier: "generic", extensions: [".cs"] },
    { language: "C/C++", tier: "generic", extensions: [".c", ".h", ".cc", ".cpp", ".hpp"] },
    { language: "Ruby", tier: "generic", extensions: [".rb"] },
    { language: "PHP", tier: "generic", extensions: [".php"] },
];
const EXTENSION_TO_PROFILE = new Map(LANGUAGE_PROFILES.flatMap((profile) => profile.extensions.map((extension) => [extension, profile])));
const IGNORED_DIRECTORIES = new Set([
    ".git", ".vanguard", "node_modules", "dist", "build", "target", "out", "coverage",
    ".venv", "venv", "__pycache__", ".next", ".turbo", "vendor", ".gradle",
]);
const BUILD_SYSTEM_MARKERS = [
    { file: "package.json", system: "npm" },
    { file: "pnpm-lock.yaml", system: "pnpm" },
    { file: "yarn.lock", system: "yarn" },
    { file: "pyproject.toml", system: "python/pyproject" },
    { file: "setup.py", system: "python/setuptools" },
    { file: "requirements.txt", system: "python/pip" },
    { file: "Cargo.toml", system: "cargo" },
    { file: "go.mod", system: "go modules" },
    { file: "pom.xml", system: "maven" },
    { file: "build.gradle", system: "gradle" },
    { file: "build.gradle.kts", system: "gradle" },
    { file: "Gemfile", system: "bundler" },
    { file: "CMakeLists.txt", system: "cmake" },
    { file: "Makefile", system: "make" },
];
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".vanguard/rules.md"];
export async function buildRepositoryModel(root, options = {}) {
    const resolved = path.resolve(root);
    const maxFiles = options.maxFiles ?? 20_000;
    const languageCounts = new Map();
    const buildSystems = new Set();
    const entryPoints = [];
    const testFiles = [];
    const generatedDirectories = [];
    const instructionFiles = [];
    let fileCount = 0;
    let sampledFiles = false;
    let hasGit = false;
    const queue = [resolved];
    while (queue.length > 0) {
        const directory = queue.shift();
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const absolute = path.join(directory, entry.name);
            const relative = path.relative(resolved, absolute).replaceAll("\\", "/");
            if (entry.isDirectory()) {
                if (entry.name === ".git") {
                    hasGit = true;
                    continue;
                }
                if (IGNORED_DIRECTORIES.has(entry.name)) {
                    generatedDirectories.push(relative);
                    continue;
                }
                queue.push(absolute);
                continue;
            }
            if (!entry.isFile())
                continue;
            fileCount += 1;
            if (fileCount > maxFiles) {
                sampledFiles = true;
                continue;
            }
            const marker = BUILD_SYSTEM_MARKERS.find((candidate) => candidate.file === entry.name);
            if (marker !== undefined && directory === resolved)
                buildSystems.add(marker.system);
            if (options.includeInstructionFiles !== false
                && INSTRUCTION_FILES.some((name) => relative === name || relative.endsWith(`/${name}`))) {
                instructionFiles.push(relative);
            }
            const profile = EXTENSION_TO_PROFILE.get(path.extname(entry.name).toLowerCase());
            if (profile !== undefined) {
                const existing = languageCounts.get(profile.language) ?? { tier: profile.tier, files: 0 };
                existing.files += 1;
                languageCounts.set(profile.language, existing);
                if (isTestFile(relative) && testFiles.length < 200)
                    testFiles.push(relative);
                else if (isEntryPoint(entry.name, relative) && entryPoints.length < 40)
                    entryPoints.push(relative);
            }
        }
    }
    const languages = [...languageCounts.entries()]
        .map(([language, value]) => ({ language, tier: value.tier, files: value.files }))
        .sort((left, right) => right.files - left.files);
    return {
        languages,
        primaryLanguage: languages[0]?.language,
        primaryTier: languages[0]?.tier,
        buildSystems: [...buildSystems].sort(),
        entryPoints: entryPoints.sort(),
        testFiles: testFiles.sort(),
        generatedDirectories: generatedDirectories.sort(),
        instructionFiles: instructionFiles.sort(),
        hasGit,
        fileCount,
        sampledFiles,
    };
}
function isTestFile(relative) {
    const base = relative.toLowerCase();
    return /(^|\/)(test|tests|__tests__|spec)\//.test(base)
        || /\.(test|spec)\.[a-z]+$/.test(base)
        || /_test\.[a-z]+$/.test(base)
        || /(^|\/)test_[^/]+\.py$/.test(base);
}
function isEntryPoint(name, relative) {
    const lower = name.toLowerCase();
    if (["main.rs", "main.go", "index.ts", "index.js", "index.mjs", "main.py", "__main__.py", "cli.ts", "cli.js", "app.ts", "app.py", "server.ts", "server.js"].includes(lower)) {
        return true;
    }
    const depth = relative.split("/").length;
    return depth <= 2 && (lower.startsWith("main.") || lower.startsWith("index."));
}
export async function readRepositoryInstructions(root, files) {
    const contents = [];
    for (const relative of files.slice(0, 8)) {
        try {
            const absolute = path.join(root, relative);
            if ((await stat(absolute)).size > 64_000)
                continue;
            contents.push(`# ${relative}\n${await readFile(absolute, "utf8")}`);
        }
        catch { }
    }
    return contents;
}
export class RepositoryMapTool {
    workspace;
    options;
    name = "repo_map";
    definition = {
        name: this.name,
        description: "Return a structured map of the repository or one workspace-relative directory: languages and their support tier, build systems, entry points, test topology, generated directories, and git presence. Use this first on an unfamiliar project instead of listing directories by hand.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Optional workspace-relative directory. Omit it, or use '.' or an empty string, for the repository root." },
            },
            additionalProperties: false,
        },
        effect: "observe",
    };
    constructor(workspace, options = {}) {
        this.workspace = workspace;
        this.options = options;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        for (const field of Object.keys(fields)) {
            if (field !== "path")
                throw new Error(`Unknown field '${field}' for ${this.name}.`);
        }
        const requestedPath = optionalStringField(fields, "path") ?? ".";
        const relativePath = requestedPath.trim().length === 0 ? "." : requestedPath;
        const root = relativePath === "." ? this.workspace.root : await this.workspace.existing(relativePath);
        if (!(await stat(root)).isDirectory()) {
            return { ok: false, output: { error: "Path is not a directory.", path: relativePath } };
        }
        const includeInstructions = this.options.includeInstructions !== false;
        const model = await buildRepositoryModel(root, { includeInstructionFiles: includeInstructions });
        const instructions = includeInstructions
            ? await readRepositoryInstructions(root, model.instructionFiles)
            : [];
        return {
            ok: true,
            output: {
                path: relativePath,
                ...model,
                instructions,
            },
        };
    }
}
