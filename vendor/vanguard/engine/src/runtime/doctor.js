import { SyntaxCommandRunner, loadWorkspaceTypeScript } from "./progressiveVerification.js";
import { SystemChromiumLocator } from "./headlessRenderTool.js";
const PROVIDER_CREDENTIAL_VARIABLES = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OLLAMA_API_KEY",
];
const SUPPORTED_NODE = { minimumMajor: 20, minimumMinor: 19, maximumMajorExclusive: 25 };
export async function runDoctor(options) {
    const environment = options.environment ?? process.env;
    const results = [
        nodeRuntime(),
        await providerCredentials(environment, options.oauthConnected),
        await visualRung(options.browserLocator ?? new SystemChromiumLocator()),
        await typescriptRung(options.workspaceRoot, options.typescriptLoader ?? loadWorkspaceTypeScript),
        await parserCli(options.syntaxRunner ?? new SyntaxCommandRunner(), options.workspaceRoot, "Python syntax rung", "python", ["-c", "print(1)"], "install Python 3 so Python edits get a real parse rung"),
        await parserCli(options.syntaxRunner ?? new SyntaxCommandRunner(), options.workspaceRoot, "Go syntax rung", "gofmt", [], "install Go so Go edits get a real parse rung", ""),
    ];
    return { results, ready: results.every((result) => result.status !== "missing") };
}
export function renderDoctorReport(report) {
    const marker = { ok: " OK ", degraded: "WARN", missing: "MISS" };
    const lines = report.results.flatMap((result) => [
        `[${marker[result.status]}] ${result.name} — ${result.detail}`,
        ...(result.remedy === undefined ? [] : [`       remedy: ${result.remedy}`]),
    ]);
    const verdict = report.ready
        ? "Ready to run. Degraded rungs above (if any) reduce evidence quality, not correctness."
        : "Not ready: fix the MISS findings above before running.";
    return `Vanguard doctor\n${lines.join("\n")}\n${verdict}`;
}
function nodeRuntime() {
    const version = process.versions.node;
    const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
    const supported = (major > SUPPORTED_NODE.minimumMajor
        || (major === SUPPORTED_NODE.minimumMajor && minor >= SUPPORTED_NODE.minimumMinor))
        && major < SUPPORTED_NODE.maximumMajorExclusive;
    return {
        name: "node runtime",
        status: supported ? "ok" : "degraded",
        detail: supported ? `v${version} — supported` : `v${version} — outside the supported range >=20.19 <25`,
        ...(supported ? {} : { remedy: "run Vanguard on a supported Node.js release" }),
    };
}
async function providerCredentials(environment, oauthConnected) {
    const present = PROVIDER_CREDENTIAL_VARIABLES.filter((variable) => {
        const value = environment[variable];
        return typeof value === "string" && value.trim().length > 0;
    });
    let oauth = false;
    if (oauthConnected !== undefined) {
        try {
            oauth = await oauthConnected();
        }
        catch {
            oauth = false;
        }
    }
    if (present.length === 0 && !oauth) {
        return {
            name: "provider credentials",
            status: "missing",
            detail: "no provider API key in the environment and no connected OAuth session",
            remedy: "set ANTHROPIC_API_KEY (or another provider key), or run `vanguard login`; a local Ollama endpoint needs no key",
        };
    }
    const sources = [...present, ...(oauth ? ["OAuth session"] : [])];
    return { name: "provider credentials", status: "ok", detail: sources.join(", ") };
}
async function visualRung(locator) {
    let browser;
    try {
        browser = await locator.locate();
    }
    catch {
        browser = undefined;
    }
    if (browser === undefined) {
        return {
            name: "visual rung (render_artifact)",
            status: "degraded",
            detail: "no system Chromium-family browser found; HTML deliverables cannot be rendered or screenshotted",
            remedy: "install Edge/Chrome/Chromium or set VANGUARD_BROWSER to a browser executable",
        };
    }
    return { name: "visual rung (render_artifact)", status: "ok", detail: browser };
}
async function typescriptRung(workspaceRoot, loader) {
    let module;
    try {
        module = await loader(workspaceRoot);
    }
    catch {
        module = undefined;
    }
    if (module === undefined) {
        return {
            name: "TypeScript syntax rung",
            status: "degraded",
            detail: "no resolvable `typescript` module; TypeScript edits fall back to the delimiter scan",
            remedy: "install typescript in the project (or globally) for a real parse rung",
        };
    }
    const version = module.version;
    return {
        name: "TypeScript syntax rung",
        status: "ok",
        detail: typeof version === "string" ? `typescript ${version}` : "typescript module resolvable",
    };
}
async function parserCli(runner, workspaceRoot, name, command, args, remedy, input) {
    try {
        const result = await runner.run(command, args, workspaceRoot, input);
        if (result.exitCode === 0)
            return { name, status: "ok", detail: `${command} available` };
        return { name, status: "degraded", detail: `${command} exited ${result.exitCode}`, remedy };
    }
    catch {
        return { name, status: "degraded", detail: `${command} not available`, remedy };
    }
}
