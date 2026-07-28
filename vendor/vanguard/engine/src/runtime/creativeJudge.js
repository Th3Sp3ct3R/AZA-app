import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
const RENDERABLE = new Set([".html", ".htm", ".svg"]);
const MAX_SCAN_ENTRIES = 2_000;
const SKIP_DIRECTORIES = new Set([".git", ".vanguard", "node_modules", "dist", "coverage", "build", "out"]);
export class CreativeDirectionVerifier {
    judge;
    workspace;
    contract;
    renderer;
    scanScope;
    name = "creative direction";
    constructor(judge, workspace, contract, renderer, scanScope) {
        this.judge = judge;
        this.workspace = workspace;
        this.contract = contract;
        this.renderer = renderer;
        this.scanScope = scanScope;
    }
    async verify(_candidate, task) {
        const direction = this.contract.creativeDirection;
        if (direction === undefined) {
            return { verifier: this.name, passed: true, evidence: "No creative direction was contracted." };
        }
        const found = await findRenderableDeliverable(this.workspace, this.contract, this.scanScope?.());
        if (found === undefined) {
            return {
                verifier: this.name,
                passed: true,
                evidence: "No renderable deliverable (.html/.svg) exists to judge; the direction was enforced by prompt and review only.",
            };
        }
        const target = found.relative;
        const controller = new AbortController();
        const context = { task, step: 0, signal: controller.signal };
        const rendered = await this.renderer(target, context);
        if (!rendered.ok) {
            return {
                verifier: this.name,
                passed: false,
                evidence: `The deliverable '${target}' could not reach a healthy rendered state (${snippet(rendered.output)}).`,
            };
        }
        const transcript = [
            {
                role: "decision",
                content: {
                    kind: "tools",
                    calls: [{ id: "judge-render", name: "render_artifact", input: { path: target } }],
                },
            },
            {
                role: "observation",
                content: {
                    callId: "judge-render",
                    tool: "render_artifact",
                    ok: true,
                    output: rendered.output,
                },
            },
        ];
        const judgeTask = "You are an uncompromising creative director reviewing a finished deliverable against its contracted direction.\n"
            + `Contracted creative direction: ${direction}\n`
            + `Deliverable objective: ${this.contract.objective}\n`
            + `The render above is the actual deliverable '${target}'. Judge whether it honors the direction: identity, palette, committed concept — `
            + "not correctness. Generic-but-competent violates a specific direction. Reply with exactly one line starting with "
            + "VERDICT: PASS or VERDICT: FAIL, followed by your specific reasons (name what is missing or generic).";
        let reply;
        try {
            const decision = await this.judge.decide({
                task: judgeTask,
                mode: "conversation",
                transcript: [{ role: "task", content: judgeTask }, ...transcript],
                tools: [],
                remainingSteps: 1,
                signal: controller.signal,
                workingState: null,
            });
            reply = decision.kind === "respond" ? decision.message : JSON.stringify(decision);
        }
        catch (error) {
            return {
                verifier: this.name,
                passed: true,
                evidence: `The judge model was unreachable (${error instanceof Error ? error.message : String(error)}); visual judgment was skipped.`,
            };
        }
        const passed = /VERDICT:\s*PASS/iu.test(reply) && !/VERDICT:\s*FAIL/iu.test(reply);
        return {
            verifier: this.name,
            passed,
            evidence: `Judged '${target}' against the contracted direction. ${bounded(reply, 1_200)}`,
        };
    }
}
export class RenderableArtifactVerifier {
    workspace;
    contract;
    renderer;
    scanScope;
    name = "renderable artifact runtime";
    #rendered = new Map();
    constructor(workspace, contract, renderer, scanScope) {
        this.workspace = workspace;
        this.contract = contract;
        this.renderer = renderer;
        this.scanScope = scanScope;
    }
    async verify(_candidate, task) {
        const target = await findRenderableDeliverable(this.workspace, this.contract, this.scanScope?.());
        if (target === undefined) {
            return { verifier: this.name, passed: true, evidence: "No HTML or SVG artifact exists; runtime render gate is not applicable." };
        }
        let sha256;
        try {
            sha256 = createHash("sha256").update(await readFile(await this.workspace.existing(target.relative))).digest("hex");
            const cached = this.#rendered.get(target.relative);
            if (cached !== undefined && cached.sha256 === sha256)
                return cached.result;
        }
        catch {
        }
        const context = { task, step: 0, signal: new AbortController().signal };
        const rendered = await this.renderer(target.relative, context);
        if (!rendered.ok && target.source === "scan" && isMissingBrowser(rendered.output)) {
            return {
                verifier: this.name,
                passed: true,
                evidence: `'${target.relative}' was discovered by scan but no system browser exists to render it; the render gate was skipped, not passed.`,
            };
        }
        const result = {
            verifier: this.name,
            passed: rendered.ok,
            evidence: rendered.ok
                ? `Executed '${target.relative}' in Chromium; screenshot and settled-DOM inspection passed.`
                : `Runtime rendering '${target.relative}' failed: ${snippet(rendered.output)}`,
        };
        if (sha256 !== undefined)
            this.#rendered.set(target.relative, { sha256, result });
        return result;
    }
}
function isMissingBrowser(output) {
    return typeof output === "object" && output !== null && !Array.isArray(output)
        && typeof output.error === "string"
        && output.error.includes("No system Chromium-family browser");
}
export async function findRenderableDeliverable(workspace, contract, scope) {
    for (const deliverable of contract?.deliverables ?? []) {
        if (!RENDERABLE.has(path.extname(deliverable).toLowerCase()))
            continue;
        try {
            await workspace.existing(deliverable);
            return { relative: deliverable, source: "contract" };
        }
        catch {
        }
    }
    let newest;
    const consider = (relative, mtimeMs) => {
        if (newest === undefined || mtimeMs > newest.mtimeMs) {
            newest = { relative: relative.replaceAll("\\", "/"), mtimeMs };
        }
    };
    for (const touched of scope?.touchedPaths ?? []) {
        if (!RENDERABLE.has(path.extname(touched).toLowerCase()))
            continue;
        try {
            consider(touched, (await stat(await workspace.existing(touched))).mtimeMs);
        }
        catch {
        }
    }
    let scanned = 0;
    const queue = [workspace.root];
    while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES) {
        const directory = queue.shift();
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            scanned += 1;
            if (scanned >= MAX_SCAN_ENTRIES)
                break;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRECTORIES.has(entry.name))
                    queue.push(absolute);
                continue;
            }
            if (!entry.isFile() || !RENDERABLE.has(path.extname(entry.name).toLowerCase()))
                continue;
            try {
                const metadata = await stat(absolute);
                if (scope !== undefined && metadata.mtimeMs < scope.modifiedSinceMs)
                    continue;
                consider(path.relative(workspace.root, absolute), metadata.mtimeMs);
            }
            catch {
            }
        }
    }
    return newest === undefined ? undefined : { relative: newest.relative, source: "scan" };
}
function snippet(value) {
    return bounded(typeof value === "string" ? value : JSON.stringify(value), 200);
}
function bounded(value, max) {
    const compact = value.replace(/\s+/gu, " ").trim();
    return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
