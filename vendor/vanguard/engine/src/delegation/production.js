import { spawn } from "node:child_process";
import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileJournal } from "../kernel/fileJournal.js";
import { createSecretRedactor, sanitizePublicEvent } from "../engine/security.js";
import { PUBLIC_EVENT_PREFIX } from "../runtime/publicRunEvents.js";
import { applyReviewedManifest, reviewSessionChanges } from "../runtime/changeTransactions.js";
import { openCodingSession } from "../runtime/session.js";
const MAX_EVENT_LINE_BYTES = 64 * 1024;
const FORCE_CANCEL_AFTER_MS = 2_000;
export class CliDelegateRunner {
    #configuration;
    #cliFile;
    constructor(configuration) {
        assertPositive(configuration.maxDurationMs, "maxDurationMs");
        assertPositive(configuration.commandTimeoutMs, "commandTimeoutMs");
        assertPositive(configuration.maxContextBytes, "maxContextBytes");
        assertPositive(configuration.maxFailedVerificationAttempts, "maxFailedVerificationAttempts");
        validateEndpoint(configuration);
        this.#configuration = configuration;
        this.#cliFile = configuration.cliFile
            ?? fileURLToPath(new URL("../cli.js", import.meta.url));
    }
    start(request, hooks) {
        const args = this.#arguments(request);
        const child = spawn(process.execPath, args, {
            env: {
                ...process.env,
                VANGUARD_EVENT_STREAM: "1",
                VANGUARD_CONTROL_STREAM: "0",
                VANGUARD_DELEGATION_DEPTH: String(request.depth),
            },
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        const redact = createSecretRedactor();
        let buffer = Buffer.alloc(0);
        let sessionRoot;
        let scorecardFile;
        let protocolFailure;
        let cancelled = false;
        let forceTimer;
        const acceptLine = (line) => {
            if (!line.startsWith(PUBLIC_EVENT_PREFIX))
                return;
            if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
                protocolFailure ??= "Child emitted an oversized public event.";
                return;
            }
            try {
                const value = JSON.parse(line.slice(PUBLIC_EVENT_PREFIX.length));
                if (value === null || typeof value !== "object" || typeof value.type !== "string") {
                    protocolFailure ??= "Child emitted a malformed public event.";
                    return;
                }
                const event = sanitizePublicEvent(value);
                if (event.type === "session.ready") {
                    if (event.sessionRoot === undefined || event.scorecardFile === undefined) {
                        protocolFailure ??= "Child session event omitted canonical paths.";
                    }
                    else if (sessionRoot !== undefined
                        && (path.resolve(event.sessionRoot) !== path.resolve(sessionRoot)
                            || path.resolve(event.scorecardFile) !== path.resolve(scorecardFile))) {
                        protocolFailure ??= "Child changed its canonical session identity.";
                    }
                    else {
                        sessionRoot = event.sessionRoot;
                        scorecardFile = event.scorecardFile;
                    }
                }
                hooks.onEvent(event);
            }
            catch {
                protocolFailure ??= "Child emitted invalid public-event JSON.";
            }
        };
        child.stderr.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (true) {
                const newline = buffer.indexOf(0x0a);
                if (newline < 0)
                    break;
                const raw = buffer.subarray(0, newline);
                buffer = buffer.subarray(newline + 1);
                acceptLine((raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw).toString("utf8"));
            }
            if (buffer.length > MAX_EVENT_LINE_BYTES) {
                protocolFailure ??= "Child emitted an unterminated oversized diagnostic line.";
                buffer = Buffer.alloc(0);
            }
        });
        const cancelProcess = () => {
            if (child.exitCode !== null || child.signalCode !== null)
                return;
            child.kill();
            forceTimer ??= setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null)
                    child.kill("SIGKILL");
            }, FORCE_CANCEL_AFTER_MS);
            forceTimer.unref?.();
        };
        const hardTimer = setTimeout(cancelProcess, this.#configuration.maxDurationMs + 5_000);
        hardTimer.unref?.();
        const done = new Promise((resolve) => {
            let launchError;
            child.once("error", (error) => { launchError = redact(error.message); });
            child.once("close", (code, signal) => {
                clearTimeout(hardTimer);
                if (forceTimer !== undefined)
                    clearTimeout(forceTimer);
                if (buffer.length > 0)
                    acceptLine(buffer.toString("utf8"));
                const failure = launchError ?? protocolFailure;
                void this.#finish(request, {
                    code,
                    signal,
                    cancelled,
                    ...(sessionRoot === undefined ? {} : { sessionRoot }),
                    ...(scorecardFile === undefined ? {} : { scorecardFile }),
                    ...(failure === undefined ? {} : { failure }),
                }).then(resolve, (error) => resolve({
                    status: cancelled ? "cancelled" : "failed",
                    error: redact(error instanceof Error ? error.message : String(error)),
                }));
            });
        });
        return {
            done,
            cancel() {
                if (cancelled)
                    return;
                cancelled = true;
                cancelProcess();
            },
        };
    }
    #arguments(request) {
        const configuration = this.#configuration;
        const args = [
            this.#cliFile,
            "run",
            "--workspace", request.parentWorkspace,
            "--task", request.task,
            "--provider", configuration.provider,
            "--model", configuration.model,
            "--auth", configuration.auth ?? "api-key",
            "--agent-profile", request.profile ?? "coder",
            "--verify-command", configuration.verification.command,
            "--max-steps", String(request.maxSteps),
            "--max-duration-ms", String(configuration.maxDurationMs),
            "--command-timeout-ms", String(Math.min(configuration.commandTimeoutMs, configuration.maxDurationMs)),
            "--max-context-bytes", String(configuration.maxContextBytes),
            "--max-verification-attempts", String(configuration.maxFailedVerificationAttempts),
            "--disable-extensions", String(configuration.disableExtensions),
            "--security-profile", "guarded",
            "--restrict-process", "true",
            "--expose-raw-process", "false",
            "--verifier-evidence", "summary",
        ];
        if (configuration.endpoint !== undefined)
            args.push("--endpoint", configuration.endpoint);
        if (configuration.credentialVariable !== undefined)
            args.push("--credential-variable", configuration.credentialVariable);
        for (const argument of configuration.verification.args)
            args.push("--verify-arg", argument);
        if (configuration.publicCheck !== undefined) {
            args.push("--check-command", configuration.publicCheck.command);
            for (const argument of configuration.publicCheck.args)
                args.push("--check-arg", argument);
        }
        for (const scope of request.scopes)
            args.push("--editable-root", scope);
        for (const protectedPath of configuration.protectedPaths ?? [])
            args.push("--protect", protectedPath);
        return args;
    }
    async #finish(request, exit) {
        if (exit.cancelled)
            return { status: "cancelled", error: "Child was cancelled by its parent." };
        if (exit.failure !== undefined)
            return { status: "failed", error: exit.failure };
        if (exit.sessionRoot === undefined || exit.scorecardFile === undefined) {
            return {
                status: "failed",
                error: exit.code === 0
                    ? "Child completed without a canonical session/scorecard event."
                    : `Child exited ${exit.code ?? exit.signal ?? "without status"} before publishing a canonical scorecard.`,
            };
        }
        const sessionRoot = await realpath(path.resolve(exit.sessionRoot));
        const expectedScorecard = path.join(sessionRoot, "scorecard.json");
        if (path.resolve(exit.scorecardFile) !== expectedScorecard) {
            return { status: "failed", error: "Child scorecard escaped its canonical session root." };
        }
        const session = await openCodingSession(sessionRoot);
        if (await realpath(request.parentWorkspace) !== session.sourceRoot) {
            return { status: "failed", error: "Child session source does not match the parent workspace." };
        }
        const scorecard = JSON.parse(await readFile(expectedScorecard, "utf8"));
        if (scorecard.version !== 3 || scorecard.sessionId !== session.id
            || scorecard.sourceRoot !== session.sourceRoot || scorecard.workspaceRoot !== session.workspaceRoot
            || scorecard.provider !== this.#configuration.provider || scorecard.model !== this.#configuration.model
            || scorecard.task !== request.task) {
            return { status: "failed", error: "Child scorecard failed canonical identity checks." };
        }
        const journal = await FileJournal.open(path.join(sessionRoot, "run.jsonl"), {
            ...(session.journalGenesisHash === undefined ? {} : { genesisHash: session.journalGenesisHash }),
        });
        const events = await journal.readValidated();
        if (exit.code !== 0) {
            const failure = [...events].reverse().find((event) => event.type === "run.failed");
            if (failure === undefined || failure.data === null || Array.isArray(failure.data)
                || typeof failure.data !== "object" || typeof failure.data.reason !== "string"
                || failure.data.reason !== scorecard.outcome?.reason) {
                return { status: "failed", sessionRoot, error: "Child failure scorecard is not bound to its validated journal." };
            }
            const steps = Number.isSafeInteger(scorecard.outcome?.steps) && scorecard.outcome.steps >= 0
                ? scorecard.outcome.steps
                : undefined;
            const reason = typeof scorecard.outcome?.reason === "string"
                ? createSecretRedactor()(scorecard.outcome.reason)
                : `Child exited ${exit.code ?? exit.signal ?? "without status"}.`;
            return {
                status: "failed",
                sessionRoot,
                ...(steps === undefined ? {} : { steps }),
                error: reason,
            };
        }
        if (scorecard.outcome?.status !== "completed"
            || typeof scorecard.outcome.answer !== "string"
            || scorecard.grade?.verified !== true || !Number.isSafeInteger(scorecard.outcome.steps)
            || scorecard.grade.steps !== scorecard.outcome.steps
            || scorecard.outcome.steps < 1 || scorecard.outcome.steps > request.maxSteps) {
            return { status: "failed", error: "Child scorecard failed canonical verification checks." };
        }
        const steps = scorecard.outcome.steps;
        const completion = [...events].reverse().find((event) => event.type === "run.completed");
        if (completion === undefined || completion.data === null || Array.isArray(completion.data)
            || typeof completion.data !== "object" || completion.data.step !== steps
            || completion.data.answer !== scorecard.outcome.answer) {
            return { status: "failed", error: "Child scorecard is not bound to its validated completion event." };
        }
        const manifest = await reviewSessionChanges(session, journal);
        return {
            status: "completed",
            sessionRoot,
            ...(scorecard.outcome.answer === undefined ? {} : { answer: scorecard.outcome.answer }),
            steps,
            review: summarizeManifest(manifest),
        };
    }
}
export class TransactionalDelegateMerger {
    #parentWorkspace;
    constructor(parentWorkspace) {
        this.#parentWorkspace = path.resolve(parentWorkspace);
    }
    async merge(record, confirmation) {
        if (record.sessionRoot === undefined || record.review === undefined) {
            throw new Error("Delegate has no reviewed child session to merge.");
        }
        if (confirmation !== record.review.manifestHash)
            throw new Error("Delegate manifest confirmation mismatch.");
        const session = await openCodingSession(record.sessionRoot);
        if (session.sourceRoot !== await realpath(this.#parentWorkspace)) {
            throw new Error("Delegate session is not based on this parent workspace.");
        }
        const journal = await FileJournal.open(path.join(path.dirname(session.metadataFile), "run.jsonl"), {
            ...(session.journalGenesisHash === undefined ? {} : { genesisHash: session.journalGenesisHash }),
        });
        const events = await journal.readValidated();
        const priorApply = [...events].reverse().find((event) => {
            if (event.type !== "change.applied" || event.data === null || Array.isArray(event.data)
                || typeof event.data !== "object")
                return false;
            return event.data.manifestHash === confirmation && typeof event.data.transactionId === "string";
        });
        if (priorApply?.data !== null && priorApply?.data !== undefined && !Array.isArray(priorApply.data)
            && typeof priorApply.data === "object" && typeof priorApply.data.transactionId === "string") {
            return { transactionId: priorApply.data.transactionId };
        }
        const result = await applyReviewedManifest(session, journal, record.review.manifestHash, confirmation);
        return { transactionId: result.transactionId };
    }
}
function summarizeManifest(manifest) {
    const changedFiles = [...new Set(manifest.changes.flatMap((change) => change.kind === "rename" ? [change.fromPath, change.toPath] : [change.path]))].sort();
    return {
        manifestHash: manifest.manifestHash,
        changedFiles,
        filesAdded: manifest.changes.filter((change) => change.kind === "add").length,
        filesDeleted: manifest.changes.filter((change) => change.kind === "delete").length,
        filesModified: manifest.changes.filter((change) => change.kind === "modify" || change.kind === "rename").length,
    };
}
function assertPositive(value, name) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer.`);
}
function validateEndpoint(configuration) {
    if ((configuration.provider === "http" || configuration.provider === "openai-compatible") && configuration.endpoint === undefined) {
        throw new Error(`The delegated ${configuration.provider} provider requires an endpoint.`);
    }
    if (configuration.endpoint === undefined)
        return;
    const endpoint = new URL(configuration.endpoint);
    const secretParameter = [...endpoint.searchParams.keys()].find((name) => /(key|token|secret|auth|password|credential)/iu.test(name));
    if (endpoint.username.length > 0 || endpoint.password.length > 0 || secretParameter !== undefined) {
        throw new Error("Provider endpoint credentials are forbidden; supply credentials through the provider environment instead.");
    }
}
