import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSecretRedactor } from "../engine/security.js";
import { compareOrdinal } from "../deterministicText.js";
const AUDIT_GENESIS = "0".repeat(64);
export class FileExtensionAuditJournal {
    file;
    #lastHash;
    #tail = Promise.resolve();
    constructor(file, lastHash) {
        this.file = file;
        this.#lastHash = lastHash;
    }
    static async open(file) {
        const absolute = path.resolve(file);
        await mkdir(path.dirname(absolute), { recursive: true });
        try {
            await writeFile(absolute, "", { flag: "wx" });
        }
        catch (error) {
            if (!isExisting(error))
                throw error;
        }
        const envelopes = await readAudit(absolute);
        return new FileExtensionAuditJournal(absolute, envelopes.at(-1)?.hash ?? AUDIT_GENESIS);
    }
    record(event) {
        const operation = this.#tail.then(async () => {
            const previousHash = this.#lastHash;
            const hash = auditHash(previousHash, event);
            await appendFile(this.file, `${JSON.stringify({ previousHash, hash, event })}\n`, "utf8");
            this.#lastHash = hash;
        });
        this.#tail = operation.catch(() => undefined);
        return operation;
    }
    async readValidated() {
        await this.#tail;
        return (await readAudit(this.file)).map((entry) => entry.event);
    }
}
export class HookRunner {
    workspace;
    policy;
    hooks;
    audit;
    maxOutputBytes;
    #redact;
    #environment;
    constructor(workspace, policy, hooks, audit, environment = process.env, maxOutputBytes = 64 * 1024) {
        this.workspace = workspace;
        this.policy = policy;
        this.hooks = hooks;
        this.audit = audit;
        this.maxOutputBytes = maxOutputBytes;
        this.#redact = createSecretRedactor(environment);
        this.#environment = { ...environment };
    }
    async run(when, signal) {
        const outcomes = [];
        for (const hook of this.hooks.filter((candidate) => candidate.when === when)
            .sort((a, b) => compareOrdinal(a.name, b.name))) {
            this.policy.authorizeHook(hook.name);
            this.policy.authorizeCommand(hook.command);
            const outcome = await this.#execute(hook, signal);
            outcomes.push(outcome);
            await this.audit.record({
                type: "hook.outcome",
                name: hook.name,
                status: outcome.timedOut ? "timed-out" : outcome.passed ? "passed" : "failed",
                detail: outcome,
            });
            if (!outcome.passed && hook.failure === "fail-closed") {
                throw new Error(`Hook '${hook.name}' failed under fail-closed policy.`);
            }
        }
        return outcomes;
    }
    async #execute(hook, signal) {
        const cwd = await this.workspace.existing(hook.cwd ?? ".");
        return new Promise((resolve) => {
            const child = spawn(hook.command, [...hook.args], {
                cwd,
                shell: false,
                windowsHide: true,
                env: safeEnvironment(this.#environment),
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = Buffer.alloc(0);
            let stderr = Buffer.alloc(0);
            let settled = false;
            let timedOut = false;
            const append = (current, chunk) => Buffer.concat([current, chunk]).subarray(0, this.maxOutputBytes);
            const finish = (exitCode) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                const passed = !timedOut && !signal.aborted && exitCode === 0;
                resolve({
                    hook: hook.name,
                    when: hook.when,
                    passed,
                    blocked: !passed && hook.failure === "fail-closed",
                    exitCode,
                    stdout: this.#redact(stdout.toString("utf8")),
                    stderr: this.#redact(stderr.toString("utf8")),
                    timedOut,
                });
            };
            const abort = () => { child.kill(); finish(null); };
            child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
            child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
            child.on("error", (error) => {
                stderr = append(stderr, Buffer.from(error.message));
                finish(null);
            });
            child.on("close", (code) => finish(code));
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill();
                finish(null);
            }, hook.timeoutMs);
            signal.addEventListener("abort", abort, { once: true });
        });
    }
}
function safeEnvironment(environment) {
    const names = process.platform === "win32"
        ? ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "PATHEXT", "COMSPEC"]
        : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    const safe = {};
    for (const name of names)
        if (environment[name] !== undefined)
            safe[name] = environment[name];
    safe.VANGUARD_HOOK = "1";
    return safe;
}
async function readAudit(file) {
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const output = [];
    let previousHash = AUDIT_GENESIS;
    for (const [index, line] of lines.entries()) {
        const envelope = JSON.parse(line);
        if (envelope.previousHash !== previousHash || envelope.hash !== auditHash(previousHash, envelope.event)) {
            throw new Error(`Extension audit integrity failure at line ${index + 1}.`);
        }
        output.push(envelope);
        previousHash = envelope.hash;
    }
    return output;
}
function auditHash(previousHash, event) {
    return createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
}
function isExisting(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
