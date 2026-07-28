import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { objectInput, stringField } from "./input.js";
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 800;
const MIN_VIEWPORT = 240;
const MAX_VIEWPORT = 3_840;
const RENDER_TIMEOUT_MS = renderTimeoutMs();
const VIRTUAL_TIME_BUDGET_MS = 8_000;
const RENDER_OUTPUT_DIRECTORY = ".vanguard/renders";
const RENDERABLE_EXTENSIONS = new Set([".html", ".htm", ".svg"]);
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const MAX_INLINE_IMAGE_BYTES = 96_000;
export class SystemChromiumLocator {
    #located;
    locate() {
        this.#located ??= this.#find();
        return this.#located;
    }
    async #find() {
        for (const candidate of browserCandidates()) {
            try {
                await access(candidate);
                return candidate;
            }
            catch {
            }
        }
        return undefined;
    }
}
function browserCandidates() {
    const override = process.env.VANGUARD_BROWSER;
    const candidates = override === undefined || override.length === 0 ? [] : [override];
    if (process.platform === "win32") {
        const roots = [
            process.env["ProgramFiles"],
            process.env["ProgramFiles(x86)"],
            process.env["LocalAppData"],
        ].filter((root) => typeof root === "string" && root.length > 0);
        for (const root of roots) {
            candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(root, "Google", "Chrome", "Application", "chrome.exe"), path.join(root, "Chromium", "Application", "chrome.exe"));
        }
    }
    else if (process.platform === "darwin") {
        candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium");
    }
    else {
        candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium");
    }
    return candidates;
}
export class HeadlessRenderRunner {
    async run(executable, args, timeoutMs) {
        return new Promise((resolve, reject) => {
            const child = spawn(executable, [...args], { windowsHide: true, shell: false });
            let output = "";
            let capturedBytes = 0;
            const capture = (chunk) => {
                if (capturedBytes >= MAX_CAPTURED_OUTPUT_BYTES)
                    return;
                const slice = chunk.subarray(0, MAX_CAPTURED_OUTPUT_BYTES - capturedBytes);
                output += slice.toString("utf8");
                capturedBytes += slice.length;
            };
            child.stdout.on("data", capture);
            child.stderr.on("data", capture);
            child.stdin.end();
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`Headless render timed out after ${timeoutMs}ms. Raise VANGUARD_RENDER_TIMEOUT_MS for heavy pages.`));
            }, timeoutMs);
            timer.unref();
            child.once("error", (error) => { clearTimeout(timer); reject(error); });
            child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output }); });
        });
    }
}
export class HeadlessRenderTool {
    workspace;
    locator;
    runner;
    timeoutMs;
    name = "render_artifact";
    definition = {
        name: this.name,
        description: "Execute a workspace HTML or SVG file in a headless system browser, reject visible failure/loading shells, and capture a PNG screenshot under .vanguard/renders/. On vision-capable providers a small enough screenshot is attached to this result as an image; otherwise analyze it with inspect_image. Fails honestly when no system browser exists or the page does not reach a settled DOM.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Workspace-relative .html, .htm, or .svg file to render." },
                width: { type: "integer", minimum: MIN_VIEWPORT, maximum: MAX_VIEWPORT, description: `Viewport width in pixels; defaults to ${DEFAULT_VIEWPORT_WIDTH}.` },
                height: { type: "integer", minimum: MIN_VIEWPORT, maximum: MAX_VIEWPORT, description: `Viewport height in pixels; defaults to ${DEFAULT_VIEWPORT_HEIGHT}.` },
                inline: { type: "boolean", description: "Attach the screenshot bytes to this result for vision judgment; defaults to true. Captures over the inline byte budget always fall back to the on-disk file." },
            },
            required: ["path"],
            additionalProperties: false,
        },
        effect: "execute",
        evidenceAuthority: "independent-execution",
    };
    constructor(workspace, locator = new SystemChromiumLocator(), runner = new HeadlessRenderRunner(), timeoutMs = RENDER_TIMEOUT_MS) {
        this.workspace = workspace;
        this.locator = locator;
        this.runner = runner;
        this.timeoutMs = timeoutMs;
    }
    #warmed = false;
    async warm() {
        if (this.#warmed)
            return;
        this.#warmed = true;
        const browser = await this.locator.locate();
        if (browser === undefined)
            return;
        const profileDirectory = path.join(os.tmpdir(), `vanguard-warm-${randomUUID()}`);
        try {
            await this.runner.run(browser, [
                "--headless=new",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--mute-audio",
                `--user-data-dir=${profileDirectory}`,
                "--dump-dom",
                "about:blank",
            ], Math.min(this.timeoutMs, 20_000));
        }
        catch {
        }
        finally {
            await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const relativePath = stringField(fields, "path");
        const width = integerField(fields, "width") ?? DEFAULT_VIEWPORT_WIDTH;
        const height = integerField(fields, "height") ?? DEFAULT_VIEWPORT_HEIGHT;
        const inline = fields.inline !== false;
        if (width < MIN_VIEWPORT || width > MAX_VIEWPORT || height < MIN_VIEWPORT || height > MAX_VIEWPORT) {
            throw new Error(`Viewport dimensions must be integers from ${MIN_VIEWPORT} through ${MAX_VIEWPORT}.`);
        }
        const extension = path.extname(relativePath).toLowerCase();
        if (!RENDERABLE_EXTENSIONS.has(extension)) {
            return { ok: false, output: { error: "render_artifact accepts .html, .htm, and .svg files." } };
        }
        const sourceFile = await this.workspace.existing(relativePath);
        const browser = await this.locator.locate();
        if (browser === undefined) {
            return {
                ok: false,
                output: {
                    error: "No system Chromium-family browser (Edge, Chrome, Chromium) was found, so the page cannot be rendered. Set VANGUARD_BROWSER to a browser executable to enable visual evidence.",
                },
            };
        }
        const screenshotRelative = renderOutputPath(relativePath, width, height);
        const screenshotAbsolute = await this.workspace.writable(screenshotRelative);
        await rm(screenshotAbsolute, { force: true });
        const profileDirectory = path.join(os.tmpdir(), `vanguard-render-${randomUUID()}`);
        try {
            const attempts = [];
            let rendered = false;
            for (const headlessFlag of ["--headless=new", "--headless"]) {
                const args = [
                    headlessFlag,
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-extensions",
                    "--disable-sync",
                    "--hide-scrollbars",
                    "--mute-audio",
                    "--force-device-scale-factor=1",
                    `--user-data-dir=${profileDirectory}`,
                    `--window-size=${width},${height}`,
                    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
                    "--dump-dom",
                    `--screenshot=${screenshotAbsolute}`,
                    pathToFileURL(sourceFile).href,
                ];
                const result = await this.runner.run(browser, args, this.timeoutMs);
                if (result.exitCode === 0 && await isNonEmptyFile(screenshotAbsolute)) {
                    const runtimeFailure = inspectRenderedDom(result.output);
                    if (runtimeFailure !== undefined) {
                        return {
                            ok: false,
                            output: {
                                error: "The page rendered pixels but did not reach a healthy settled DOM.",
                                browser: path.basename(browser),
                                sourcePath: relativePath,
                                runtimeFailure,
                            },
                        };
                    }
                    rendered = true;
                    break;
                }
                attempts.push(`${headlessFlag}: exit ${result.exitCode}${result.output.trim().length === 0 ? "" : ` — ${compact(result.output)}`}`);
            }
            if (!rendered) {
                return {
                    ok: false,
                    output: {
                        error: "The headless browser did not produce a screenshot.",
                        browser: path.basename(browser),
                        attempts,
                    },
                };
            }
            const screenshot = await readFile(screenshotAbsolute);
            let inlineImage = screenshot;
            let inlineScale = 1;
            if (inline && screenshot.byteLength > MAX_INLINE_IMAGE_BYTES) {
                const shrunk = await this.#downscaleScreenshot(browser, screenshotAbsolute, width, height, profileDirectory);
                if (shrunk !== undefined) {
                    inlineImage = shrunk.bytes;
                    inlineScale = shrunk.scale;
                }
            }
            const inlined = inline && inlineImage.byteLength <= MAX_INLINE_IMAGE_BYTES;
            return {
                ok: true,
                output: {
                    path: screenshotRelative,
                    sourcePath: relativePath,
                    browser: path.basename(browser),
                    width,
                    height,
                    bytes: screenshot.byteLength,
                    sha256: createHash("sha256").update(screenshot).digest("hex"),
                    runtimeInspection: "settled DOM; no active loading status or visible failure alert",
                    ...(inlined
                        ? {
                            image: {
                                mediaType: "image/png",
                                base64: inlineImage.toString("base64"),
                                ...(inlineScale === 1 ? {} : { note: `downscaled to ${Math.round(inlineScale * 100)}% for the inline budget; the full-resolution PNG is at the recorded path` }),
                            },
                        }
                        : {
                            imageOmitted: inline
                                ? `screenshot is ${screenshot.byteLength} bytes and could not be downscaled under the ${MAX_INLINE_IMAGE_BYTES}-byte inline budget; judge via inspect_image`
                                : "inline attachment was disabled for this call",
                        }),
                    note: "This PNG is the real rendered page. Judge the deliverable from it, never from the source text.",
                },
            };
        }
        finally {
            await rm(profileDirectory, { recursive: true, force: true });
        }
    }
    async #downscaleScreenshot(browser, screenshotAbsolute, width, height, profileParent) {
        for (const scale of [0.55, 0.4, 0.3]) {
            const scaledWidth = Math.max(MIN_VIEWPORT, Math.round(width * scale));
            const scaledHeight = Math.max(MIN_VIEWPORT, Math.round(height * scale));
            const wrapper = path.join(profileParent, `downscale-${Math.round(scale * 100)}.html`);
            const output = path.join(profileParent, `downscale-${Math.round(scale * 100)}.png`);
            try {
                await writeFile(wrapper, [
                    "<!doctype html><html><head><style>",
                    "html,body{margin:0;padding:0;background:#fff;overflow:hidden}",
                    `img{display:block;width:${scaledWidth}px;height:${scaledHeight}px}`,
                    "</style></head><body>",
                    `<img src="${pathToFileURL(screenshotAbsolute).href}">`,
                    "</body></html>",
                ].join(""), "utf8");
                const result = await this.runner.run(browser, [
                    "--headless=new",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-extensions",
                    "--hide-scrollbars",
                    "--mute-audio",
                    "--force-device-scale-factor=1",
                    `--user-data-dir=${path.join(profileParent, `downscale-profile-${Math.round(scale * 100)}`)}`,
                    `--window-size=${scaledWidth},${scaledHeight}`,
                    `--screenshot=${output}`,
                    pathToFileURL(wrapper).href,
                ], Math.min(this.timeoutMs, 30_000));
                if (result.exitCode !== 0 || !(await isNonEmptyFile(output)))
                    continue;
                const bytes = await readFile(output);
                if (bytes.byteLength <= MAX_INLINE_IMAGE_BYTES)
                    return { bytes, scale };
            }
            catch {
            }
        }
        return undefined;
    }
}
export function inspectRenderedDom(output) {
    const htmlStart = output.search(/<(?:!doctype\s+html|html)\b/iu);
    if (htmlStart === -1)
        return "Chromium produced no serialized DOM; script execution could not be verified.";
    const html = output.slice(htmlStart);
    const startTag = /<([a-z][a-z0-9-]*)\b([^>]*)>/giu;
    for (const match of html.matchAll(startTag)) {
        const tag = match[1];
        const attributes = match[2] ?? "";
        if (isExplicitlyHidden(attributes))
            continue;
        const role = attributeValue(attributes, "role")?.toLowerCase();
        const classes = (attributeValue(attributes, "class") ?? "").toLowerCase().split(/\s+/u);
        const content = [attributeValue(attributes, "aria-label"), elementText(html, tag, (match.index ?? 0) + match[0].length)]
            .filter((value) => value !== undefined && value.length > 0)
            .join(" ");
        const inlineStyle = attributeValue(attributes, "style") ?? "";
        const alertIsActive = classes.some((name) => /^(?:visible|show|shown|active|error|open)$/u.test(name))
            || /display\s*:\s*(?:block|flex|grid)/iu.test(inlineStyle);
        if (role === "alert" && alertIsActive) {
            return `visible alert${content.length === 0 ? "" : `: ${content}`}`;
        }
        if (role === "status" && !hasInactiveClass(classes)
            && /\b(?:initiali[sz](?:e|ing)|loading|booting|starting|connecting|please wait)\b/iu.test(content)) {
            return `active loading status: ${content}`;
        }
    }
    return undefined;
}
function attributeValue(attributes, name) {
    const expression = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu");
    const match = expression.exec(attributes);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}
function isExplicitlyHidden(attributes) {
    if (/(?:^|\s)hidden(?:\s|=|$)/iu.test(attributes))
        return true;
    if (attributeValue(attributes, "aria-hidden")?.toLowerCase() === "true")
        return true;
    return /display\s*:\s*none/iu.test(attributeValue(attributes, "style") ?? "");
}
function hasInactiveClass(classes) {
    return classes.some((name) => /^(?:hidden|hide|inactive|complete|completed|ready|sr-only)$/u.test(name));
}
function elementText(html, tag, contentStart) {
    void tag;
    return html.slice(contentStart, Math.min(html.length, contentStart + 1_000))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
        .replace(/<[^>]+>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 300);
}
function renderOutputPath(relativePath, width, height) {
    const flattened = relativePath
        .replaceAll("\\", "/")
        .replaceAll("/", "_")
        .replace(/[^A-Za-z0-9._-]/gu, "_");
    return `${RENDER_OUTPUT_DIRECTORY}/${flattened}.${width}x${height}.png`;
}
async function isNonEmptyFile(absolutePath) {
    try {
        const metadata = await stat(absolutePath);
        return metadata.isFile() && metadata.size > 0;
    }
    catch {
        return false;
    }
}
function compact(value, max = 400) {
    const flattened = value.replace(/\s+/gu, " ").trim();
    return flattened.length <= max ? flattened : `${flattened.slice(0, max - 1)}…`;
}
function renderTimeoutMs() {
    const parsed = Number.parseInt(process.env.VANGUARD_RENDER_TIMEOUT_MS ?? "", 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 120_000;
}
function integerField(fields, name) {
    const value = fields[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`Field '${name}' must be an integer.`);
    }
    return value;
}
