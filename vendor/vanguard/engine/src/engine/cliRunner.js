import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PUBLIC_EVENT_PREFIX } from "../runtime/publicRunEvents.js";
import { createSecretRedactor, sanitizePublicEvent } from "./security.js";
const MAX_DIAGNOSTIC_LINE_BYTES = 64 * 1024;
const MAX_CONTROL_QUEUE_BYTES = 1_048_576;
export class CliVanguardRunner {
    #cliFile;
    constructor(cliFile = fileURLToPath(new URL("../cli.js", import.meta.url))) {
        this.#cliFile = cliFile;
    }
    start(sessionRoot, message, hooks) {
        const redact = createSecretRedactor();
        const args = [this.#cliFile, "advance", "--session", sessionRoot];
        if (message !== undefined)
            args.push("--message", message);
        const child = spawn(process.execPath, args, {
            env: {
                ...process.env,
                VANGUARD_EVENT_STREAM: "1",
                VANGUARD_CONTROL_STREAM: "1",
            },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        let stderrBuffer = Buffer.alloc(0);
        child.stderr.on("data", (chunk) => {
            try {
                stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
                while (true) {
                    const newline = stderrBuffer.indexOf(0x0a);
                    if (newline < 0)
                        break;
                    const raw = stderrBuffer.subarray(0, newline);
                    stderrBuffer = stderrBuffer.subarray(newline + 1);
                    const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1).toString("utf8") : raw.toString("utf8");
                    receiveLine(line, hooks, redact);
                }
                if (stderrBuffer.length > MAX_DIAGNOSTIC_LINE_BYTES) {
                    const truncated = redact(stderrBuffer.subarray(0, MAX_DIAGNOSTIC_LINE_BYTES).toString("utf8"));
                    safeLog(hooks, `${truncated}…`);
                    stderrBuffer = Buffer.alloc(0);
                }
            }
            catch (error) {
                stderrBuffer = Buffer.alloc(0);
                safeLog(hooks, `Worker diagnostic stream failed: ${safeRedact(redact, errorMessage(error))}`);
            }
        });
        child.stdout.on("data", () => { });
        let cancelled = false;
        let forceTimer;
        let controlQueue = [];
        let controlQueueBytes = 0;
        let waitingForDrain = false;
        let controlClosed = false;
        const clearControls = () => {
            controlClosed = true;
            controlQueue = [];
            controlQueueBytes = 0;
        };
        child.stdin.once("error", clearControls);
        child.stdin.once("close", clearControls);
        const flushControls = () => {
            if (waitingForDrain || controlClosed || child.stdin.destroyed || !child.stdin.writable)
                return;
            while (controlQueue.length > 0) {
                const next = controlQueue.shift();
                controlQueueBytes -= next.bytes;
                try {
                    if (!child.stdin.write(next.frame, "utf8")) {
                        waitingForDrain = true;
                        child.stdin.once("drain", () => {
                            waitingForDrain = false;
                            flushControls();
                        });
                        return;
                    }
                }
                catch (error) {
                    clearControls();
                    safeLog(hooks, `Worker control stream failed: ${safeRedact(redact, errorMessage(error))}`);
                    return;
                }
            }
        };
        const send = (value, required) => {
            if (controlClosed || child.stdin.destroyed || !child.stdin.writable) {
                if (required)
                    throw new Error("Worker control channel is closed.");
                return;
            }
            const frame = `${JSON.stringify(value)}\n`;
            const bytes = Buffer.byteLength(frame);
            if (controlQueueBytes + bytes > MAX_CONTROL_QUEUE_BYTES) {
                if (required)
                    throw new Error("Worker control queue is full.");
                return;
            }
            controlQueue.push({ frame, bytes });
            controlQueueBytes += bytes;
            flushControls();
            if (required && controlClosed)
                throw new Error("Worker control channel is closed.");
        };
        const done = new Promise((resolve) => {
            child.once("error", (error) => {
                safeLog(hooks, `Worker launch failed: ${safeRedact(redact, error.message)}`);
            });
            child.once("close", (code, signal) => {
                try {
                    clearControls();
                    if (stderrBuffer.length > 0)
                        receiveLine(stderrBuffer.toString("utf8"), hooks, redact);
                    if (forceTimer !== undefined)
                        clearTimeout(forceTimer);
                }
                finally {
                    resolve({ code, signal });
                }
            });
        });
        return {
            done,
            steer(message) {
                if (message.length > 0)
                    send({ type: "user_message", text: message }, true);
            },
            cancel() {
                if (cancelled)
                    return;
                cancelled = true;
                controlQueue = [];
                controlQueueBytes = 0;
                send({ type: "cancel" }, false);
                forceTimer = setTimeout(() => {
                    try {
                        if (child.exitCode === null && child.signalCode === null)
                            child.kill();
                    }
                    catch (error) {
                        safeLog(hooks, `Worker force-stop failed: ${safeRedact(redact, errorMessage(error))}`);
                    }
                }, 2_000);
                forceTimer.unref?.();
            },
        };
    }
}
function receiveLine(line, hooks, redact) {
    if (line.startsWith(PUBLIC_EVENT_PREFIX)) {
        try {
            const parsed = JSON.parse(line.slice(PUBLIC_EVENT_PREFIX.length));
            if (parsed !== null && typeof parsed === "object" && typeof parsed.type === "string") {
                safeEvent(hooks, sanitizePublicEvent(parsed));
                return;
            }
        }
        catch {
            safeLog(hooks, "Worker emitted a malformed public event.");
            return;
        }
    }
    if (line.length > 0)
        safeLog(hooks, safeRedact(redact, line.slice(0, MAX_DIAGNOSTIC_LINE_BYTES)));
}
function safeEvent(hooks, event) {
    try {
        hooks.onEvent(event);
    }
    catch {
    }
}
function safeLog(hooks, line) {
    try {
        hooks.onLog(line);
    }
    catch {
    }
}
function safeRedact(redact, text) {
    try {
        return redact(text);
    }
    catch {
        return "[diagnostic unavailable]";
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
