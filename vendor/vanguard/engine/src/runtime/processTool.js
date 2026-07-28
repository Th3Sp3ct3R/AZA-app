import { spawn } from "node:child_process";
import { objectInput, optionalStringField, stringArrayField, stringField } from "./input.js";
import { sanitizedChildEnvironment } from "../engine/security.js";
import { asciiLowercase } from "../deterministicText.js";
export class ProcessTool {
    workspace;
    name = "run_command";
    definition = {
        name: this.name,
        description: "Run one bounded allowlisted executable without a command shell and capture its exit state. Persistent development servers are rejected; use render_artifact for HTML evidence.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "Allowlisted executable name or path." },
                args: { type: "array", items: { type: "string" }, description: "Argument vector; no shell parsing occurs." },
                cwd: { type: "string", description: "Optional workspace-relative working directory." },
            },
            required: ["command", "args"],
            additionalProperties: false,
        },
        effect: "execute",
        evidenceAuthority: "independent-execution",
    };
    #allowedCommands;
    #timeoutMs;
    #idleTimeoutMs;
    #maxOutputBytes;
    #commandAliases;
    #deniedArgumentPrefixes;
    #deniedArgumentSubstrings;
    #environment;
    #requestApproval;
    constructor(workspace, options) {
        this.workspace = workspace;
        this.#requestApproval = options.requestApproval;
        this.#allowedCommands = new Set(options.allowedCommands.map(normalizeCommand));
        this.#commandAliases = new Map(Object.entries(options.commandAliases ?? {}).map(([name, alias]) => [normalizeCommand(name), alias]));
        this.#deniedArgumentPrefixes = options.deniedArgumentPrefixes ?? [];
        this.#deniedArgumentSubstrings = options.deniedArgumentSubstrings ?? [];
        this.#timeoutMs = options.timeoutMs ?? 120_000;
        this.#idleTimeoutMs = options.idleTimeoutMs;
        this.#maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
        this.#environment = options.environment ?? sanitizedChildEnvironment();
    }
    async execute(input, context) {
        const fields = objectInput(input);
        const command = stringField(fields, "command");
        const args = stringArrayField(fields, "args");
        const relativeCwd = optionalStringField(fields, "cwd") ?? ".";
        const normalized = normalizeCommand(command);
        if (!this.#allowedCommands.has(normalized)) {
            const approve = this.#requestApproval;
            if (approve === undefined) {
                return {
                    ok: false,
                    output: {
                        error: "Command is not allowed.",
                        command,
                        detail: "No owner is attached to approve it. Use an allowlisted command, or relaunch with --allow-command.",
                    },
                };
            }
            const decision = await approve({ command, args, cwd: relativeCwd }, context.signal);
            if (decision === "deny") {
                return {
                    ok: false,
                    output: { error: "The owner declined to run this command.", command, detail: "Do not ask for it again; find another way or ask what to do." },
                };
            }
            if (decision === "always")
                this.#allowedCommands.add(normalized);
        }
        const deniedArgument = args.find((argument) => this.#deniedArgumentPrefixes.some((prefix) => asciiLowercase(argument).startsWith(asciiLowercase(prefix))));
        if (deniedArgument !== undefined) {
            return { ok: false, output: { error: "Argument is blocked by process policy.", argument: deniedArgument } };
        }
        const deniedSubstring = this.#deniedArgumentSubstrings.find((substring) => args.some((argument) => asciiLowercase(argument).includes(asciiLowercase(substring))));
        if (deniedSubstring !== undefined) {
            return {
                ok: false,
                output: {
                    error: "Argument contains a construct blocked by process evidence policy.",
                    construct: deniedSubstring,
                    guidance: "Use an assertion library that throws and produces a non-zero exit code on failure.",
                },
            };
        }
        const persistentReason = persistentProcessReason(command, args);
        if (persistentReason !== undefined) {
            return {
                ok: false,
                output: {
                    error: "Persistent server commands are not valid bounded process evidence.",
                    detail: persistentReason,
                    guidance: "Use render_artifact to execute and inspect an HTML/SVG deliverable, or run a bounded test command that exits on its own.",
                },
            };
        }
        const cwd = await this.workspace.existing(relativeCwd);
        const alias = this.#commandAliases.get(normalizeCommand(command));
        return runProcess(alias?.executable ?? command, [...(alias?.argsPrefix ?? []), ...args], cwd, this.#timeoutMs, this.#maxOutputBytes, context.signal, this.#environment, this.#idleTimeoutMs);
    }
}
export function persistentProcessReason(command, args) {
    const executable = asciiLowercase(command.trim()).replaceAll("\\", "/").split("/").at(-1) ?? "";
    const lowered = args.map((argument) => asciiLowercase(argument.trim()));
    const joined = lowered.join(" ");
    if ((executable === "python" || executable === "python.exe" || executable === "py" || executable === "py.exe")
        && /(?:^|\s)-m\s+http\.server(?:\s|$)/u.test(joined)) {
        return "Python's http.server waits indefinitely for requests.";
    }
    if ((executable === "npm" || executable === "npm.cmd" || executable === "npm.exe")
        && lowered.some((argument) => /^(?:dev|start|serve|preview)$/u.test(argument))) {
        return "This npm lifecycle command normally runs a persistent development server.";
    }
    if (/^(?:vite|vite\.cmd|serve|serve\.cmd|http-server|http-server\.cmd)$/u.test(executable)) {
        return "This executable is a persistent development server.";
    }
    if ((executable === "cmd" || executable === "cmd.exe")
        && lowered.some((argument) => /(?:^|[\\/])(?:serve|server|dev)(?:\.[a-z0-9_-]+)?$/u.test(argument))) {
        return "The selected batch/script name indicates a persistent server launcher.";
    }
    return undefined;
}
async function runProcess(command, args, cwd, timeoutMs, maxOutputBytes, signal, environment, idleTimeoutMs) {
    if (signal.aborted)
        return { ok: false, output: { error: "Process aborted before launch." } };
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, shell: false, windowsHide: true, env: environment });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        let termination;
        let terminationEscalation;
        let containmentDeadline;
        let timer;
        let idleTimer;
        const armIdleWatchdog = () => {
            if (idleTimeoutMs === undefined || settled || termination !== undefined)
                return;
            if (idleTimer !== undefined)
                clearTimeout(idleTimer);
            idleTimer = setTimeout(() => terminate("idle"), idleTimeoutMs);
        };
        const append = (current, chunk) => {
            if (current.length >= maxOutputBytes)
                return current;
            const remaining = maxOutputBytes - current.length;
            return Buffer.concat([current, chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)]);
        };
        const onStdout = (chunk) => { stdout = append(stdout, chunk); armIdleWatchdog(); };
        const onStderr = (chunk) => { stderr = append(stderr, chunk); armIdleWatchdog(); };
        const stopCapture = () => {
            child.stdout.off("data", onStdout);
            child.stderr.off("data", onStderr);
            child.stdout.destroy();
            child.stderr.destroy();
        };
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            if (idleTimer !== undefined)
                clearTimeout(idleTimer);
            if (terminationEscalation !== undefined)
                clearTimeout(terminationEscalation);
            if (containmentDeadline !== undefined)
                clearTimeout(containmentDeadline);
            signal.removeEventListener("abort", abort);
            resolve(result);
        };
        const terminate = (reason) => {
            if (settled || termination !== undefined)
                return;
            termination = reason;
            if (timer !== undefined)
                clearTimeout(timer);
            if (idleTimer !== undefined)
                clearTimeout(idleTimer);
            try {
                child.kill("SIGTERM");
            }
            catch { }
            terminationEscalation = setTimeout(() => {
                if (settled)
                    return;
                try {
                    child.kill("SIGKILL");
                }
                catch { }
                containmentDeadline = setTimeout(() => {
                    stopCapture();
                    finish({
                        ok: false,
                        output: {
                            error: reason === "aborted"
                                ? "Process abort could not prove direct-child closure."
                                : reason === "idle"
                                    ? "Process idle-kill could not prove direct-child closure."
                                    : "Process timeout could not prove direct-child closure.",
                            containmentUncertain: true,
                            ...(reason === "timed_out" ? { timeoutMs } : {}),
                            ...(reason === "idle" && idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
                        },
                    });
                }, 1_000);
            }, 1_000);
        };
        const abort = () => terminate("aborted");
        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.on("error", (error) => {
            if (termination === undefined)
                finish({ ok: false, output: { error: error.message } });
        });
        child.on("close", (code, closeSignal) => finish(termination === undefined
            ? {
                ok: code === 0,
                output: { exitCode: code ?? -1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") },
            }
            : {
                ok: false,
                output: {
                    error: termination === "aborted"
                        ? "Process aborted."
                        : termination === "idle"
                            ? `Process produced no output for ${Math.round((idleTimeoutMs ?? 0) / 1_000)}s and was terminated as hung.`
                            : "Process timed out.",
                    ...(termination === "timed_out" ? { timeoutMs } : {}),
                    ...(termination === "idle" && idleTimeoutMs !== undefined ? {
                        idleTimeoutMs,
                        guidance: "The command never exited and went silent — typically a server, watcher, or a fixture holding a socket open. Make the command exit on its own (close servers/handles, use --run/--once modes), or print progress if it is legitimately long-running.",
                    } : {}),
                    exitCode: code ?? -1,
                    signal: closeSignal ?? "",
                    stdout: stdout.toString("utf8"),
                    stderr: stderr.toString("utf8"),
                    directChildClosed: true,
                },
            }));
        timer = setTimeout(() => terminate("timed_out"), timeoutMs);
        armIdleWatchdog();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted)
            abort();
    });
}
function normalizeCommand(command) {
    return asciiLowercase(command.trim());
}
