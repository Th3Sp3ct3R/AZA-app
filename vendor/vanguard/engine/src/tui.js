import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { detectProjectVerification } from "./runtime/projectVerification.js";
import { isCleanGitRepository } from "./runtime/gitTree.js";
import { VanguardEngine } from "./engine/vanguardEngine.js";
import { PROVIDER_CHOICES, catalogModels, contextWindowTokens, defaultContextBytes, credentialVariable, defaultModel, parseSelectableProvider, providerChoice, supportsOAuth, } from "./inference/modelCatalog.js";
import { fetchClaudeModels, fetchCodexModels, fetchKimiModels, oauthLogin, oauthLogout, oauthStatus } from "./inference/oauth/index.js";
import { discoverOllamaModels, prepareOllamaModel } from "./inference/ollamaModels.js";
import { playIntroAnimation } from "./tuiIntro.js";
import { SelectCancelled, select } from "./tuiSelect.js";
import { InlineRenderer, ansi, bounded, elapsed, formatApprovalBlock, formatChatMessage, formatNote, formatToolCard, formatVerifiedSeal, hardTruncate, justifyAnsi, padAnsi, renderMarkdownLite, splitStreamableMarkdown, streamPrefix, stripAnsi, trimTo, } from "./tuiInline.js";
export { renderMarkdownLite, splitStreamableMarkdown } from "./tuiInline.js";
const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMMAND_LIST = [
    { command: "/help", summary: "Show every command and interaction" },
    { command: "/status", summary: "Provider, model, workspace, and session" },
    { command: "/verify", summary: "Switch between build and test proof" },
    { command: "/login", summary: "Connect a Claude, ChatGPT, or Kimi subscription" },
    { command: "/logout", summary: "Remove stored subscription credentials" },
    { command: "/exit", summary: "Close Vanguard cleanly" },
];
export async function runTui(startDirectory) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("The Vanguard TUI requires an interactive terminal.");
    if (process.env.VANGUARD_NO_INTRO === undefined)
        await playIntroAnimation();
    let config = await resolveConfiguration(startDirectory);
    let credential = installCredential(config);
    const engine = new VanguardEngine({ logger: () => { } });
    let sessionId;
    let contracted = false;
    let continuation;
    const ui = freshUiState(config);
    const terminalWidth = () => Math.max(40, process.stdout.columns ?? 100);
    const renderer = new InlineRenderer(process.stdout, terminalWidth);
    const fx = createTranscriptFx(renderer, terminalWidth);
    let frameActive = false;
    let suspended = false;
    let currentSessionId;
    let idleResolve;
    const submitComposer = (text) => {
        if (ui.turnActive && currentSessionId !== undefined) {
            try {
                const approval = ui.pendingApproval;
                engine.steer(currentSessionId, text);
                if (approval !== undefined) {
                    const choice = text === "1" ? "Approved once" : text === "2" ? "Approved for this session" : "Command denied";
                    fx.note(`${choice} — ${bounded(approval.command, 120)}; execution is resuming`);
                    delete ui.pendingApproval;
                }
                else {
                    ui.chat.push({ agentId: "you", message: text });
                    trimTo(ui.chat, 200);
                    fx.print(formatChatMessage("you", text, terminalWidth()));
                    fx.note("Steering delivered; it lands at the next decision boundary");
                }
            }
            catch (error) {
                fx.note(bounded(error instanceof Error ? error.message : String(error), 180));
            }
            return;
        }
        const resolve = idleResolve;
        idleResolve = undefined;
        resolve?.(text);
    };
    const onKeypress = composerKeypressHandler(ui, submitComposer, () => {
        if (ui.turnActive)
            ui.onCancel?.();
        else
            submitComposer("exit");
    }, () => printCommandList(fx));
    const onSigint = () => {
        if (ui.turnActive)
            ui.onCancel?.();
        else
            submitComposer("exit");
    };
    const animation = setInterval(() => {
        ui.frame += 1;
        if (frameActive && !suspended)
            renderer.setFooter(buildFooterLines(ui, config, terminalWidth()));
    }, 120);
    animation.unref();
    const enterFrame = () => {
        if (frameActive)
            return;
        frameActive = true;
        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("keypress", onKeypress);
        process.on("SIGINT", onSigint);
        fx.message("main", `Ready in ${config.workspace}. Ask about this repository, or tell me what you want to build.`);
        fx.note("/help lists commands · messages stay in your scrollback · type exit to leave");
        renderer.setFooter(buildFooterLines(ui, config, terminalWidth()));
    };
    const suspendFrame = async (action) => {
        if (!frameActive)
            return action();
        suspended = true;
        process.stdin.off("keypress", onKeypress);
        process.stdin.setRawMode(false);
        renderer.clearFooter();
        try {
            return await action();
        }
        finally {
            suspended = false;
            emitKeypressEvents(process.stdin);
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("keypress", onKeypress);
            renderer.setFooter(buildFooterLines(ui, config, terminalWidth()));
        }
    };
    const disposeFrame = () => {
        clearInterval(animation);
        process.removeListener("SIGINT", onSigint);
        if (!frameActive)
            return;
        frameActive = false;
        process.stdin.off("keypress", onKeypress);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        renderer.clearFooter();
    };
    const readInput = async () => {
        ui.quietDetail = "Ready for your next message";
        return (await new Promise((resolve) => { idleResolve = resolve; })).trim();
    };
    const say = (text) => {
        fx.print(text.split("\n").filter((line) => stripAnsi(line).trim().length > 0));
    };
    enterFrame();
    try {
        while (true) {
            const input = await readInput();
            if (isExitRequest(input))
                break;
            if (input === "/help") {
                say(` ${ansi.bold}Commands${ansi.reset}\n`
                    + ` ${ansi.violet}/login claude${ansi.reset}  ${ansi.dim}sign in with your Claude subscription (opens a browser)${ansi.reset}\n`
                    + ` ${ansi.violet}/login codex${ansi.reset}   ${ansi.dim}sign in with your ChatGPT subscription (opens a browser)${ansi.reset}\n`
                    + ` ${ansi.violet}/logout${ansi.reset}        ${ansi.dim}discard stored subscription tokens${ansi.reset}\n`
                    + ` ${ansi.violet}/verify${ansi.reset}        ${ansi.dim}what completion must prove: build or tests${ansi.reset}\n`
                    + ` ${ansi.violet}/status${ansi.reset}        ${ansi.dim}session, provider, and mode details${ansi.reset}\n`
                    + ` ${ansi.violet}/exit${ansi.reset}          ${ansi.dim}leave Vanguard (also: exit, quit)${ansi.reset}\n`
                    + ` ${ansi.dim}Anything else is a message: chat, ask about the repo, or request work.${ansi.reset}\n`
                    + ` ${ansi.dim}While a task runs: type to steer, Enter sends, ↑↓ history, Ctrl+K commands, Ctrl+C interrupts.${ansi.reset}\n`
                    + ` ${ansi.dim}Composer editing: Ctrl+A/E line ends, Ctrl+←→ word jumps, Ctrl+W deletes a word, Ctrl+U clears to start.${ansi.reset}\n`
                    + ` ${ansi.dim}Everything prints into your normal scrollback — scroll up any time; nothing is ever deleted.${ansi.reset}\n`);
                continue;
            }
            if (input === "/login" || input.startsWith("/login ")) {
                try {
                    const switched = await suspendFrame(() => loginCommand(input.slice("/login".length).trim(), config, sessionId !== undefined));
                    if (switched !== undefined) {
                        credential.restore();
                        config = switched;
                        credential = installCredential(config);
                    }
                }
                catch (error) {
                    say(`${ansi.red}${bounded(error instanceof Error ? error.message : String(error), 300)}${ansi.reset}`);
                }
                continue;
            }
            if (input === "/logout" || input.startsWith("/logout ")) {
                await suspendFrame(() => logoutCommand(input.slice("/logout".length).trim()));
                continue;
            }
            if (input === "/verify" || input.startsWith("/verify ")) {
                const switched = await suspendFrame(() => verifyCommand(input.slice("/verify".length).trim(), config, sessionId !== undefined));
                if (switched !== undefined)
                    config = switched;
                continue;
            }
            if (input === "/status") {
                const mode = config.direct
                    ? `${ansi.amber}direct — no baselines${ansi.reset}`
                    : config.inPlace ? `${ansi.amber}in-place${ansi.reset}` : "isolated copy";
                say(` ${ansi.dim}provider${ansi.reset}  ${config.provider} · ${config.model} ${ansi.dim}(${config.provider === "ollama" ? "local daemon / Ollama Cloud" : config.auth === "oauth" ? "subscription sign-in" : "API key"})${ansi.reset}\n`
                    + ` ${ansi.dim}project${ansi.reset}   ${config.workspace}\n`
                    + ` ${ansi.dim}mode${ansi.reset}      ${mode} · max ${config.maxSteps} steps\n`
                    + ` ${ansi.dim}verify${ansi.reset}    ${verificationSummary(config)}\n`
                    + ` ${ansi.dim}session${ansi.reset}   ${sessionId ?? "starts with your first message"}\n`);
                continue;
            }
            if (input.length === 0) {
                continue;
            }
            try {
                if (sessionId === undefined) {
                    const created = await engine.create({
                        workspace: config.workspace,
                        inPlace: config.inPlace,
                        direct: config.direct,
                        provider: config.provider,
                        auth: config.auth,
                        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
                        ...(config.detectedVerification || config.verifyMode === "tests"
                            ? {}
                            : { executionEvidence: "syntax" }),
                        model: config.model,
                        verification: config.verification,
                        adaptiveVerification: config.adaptiveVerification,
                        maxSteps: config.maxSteps,
                        maxDurationMs: 7_200_000,
                        commandTimeoutMs: 300_000,
                        commandIdleTimeoutMs: 90_000,
                        maxContextBytes: defaultContextBytes(config.model),
                        maxFailedVerificationAttempts: 3,
                        verifierEvidence: "summary",
                    });
                    sessionId = created.sessionId;
                }
                const modelMessage = continuation === undefined
                    ? input
                    : buildContinuationMessage(continuation, input);
                continuation = undefined;
                currentSessionId = sessionId;
                const turn = await runEngineTurn(engine, sessionId, modelMessage, config, ui, fx, terminalWidth, contracted, input);
                contracted = turn.contracted;
                if (turn.outcome?.status === "waiting_for_user") {
                    const question = turn.outcome.question ?? "Vanguard needs your answer to continue.";
                    ui.chat.push({ agentId: "main", message: question });
                    trimTo(ui.chat, 200);
                    fx.message("main", question);
                }
                if (turn.outcome?.status === "completed") {
                    if (config.inPlace)
                        continuation = turn.continuation;
                    fx.note(config.inPlace
                        ? `The work is live in ${path.basename(config.workspace)} — your next message keeps this task's context and builds on it.`
                        : `Verified in the isolated workspace — it is not in ${path.basename(config.workspace)} yet. See /status for the session path.`);
                    sessionId = undefined;
                    currentSessionId = undefined;
                    contracted = false;
                }
                if (turn.outcome?.status === "failed") {
                    fx.note("Keep talking to steer this session, or type exit.");
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                say(`${ansi.red}×${ansi.reset} ${ansi.dim}${bounded(message, 240)} — session kept alive; try again, rephrase, or type exit.${ansi.reset}`);
                continue;
            }
        }
    }
    finally {
        disposeFrame();
        if (ui.session !== undefined) {
            process.stdout.write(`\n ${ansi.dim}session${ansi.reset}  ${ui.session.sessionRoot}\n`
                + ` ${ansi.dim}journal${ansi.reset}  ${ui.session.journalFile}\n`
                + ` ${ansi.dim}resume${ansi.reset}   vanguard advance --session "${ui.session.sessionRoot}"\n`);
        }
        process.stdout.write(`${ansi.dim}See you next time.${ansi.reset}\n`);
        await engine.shutdown();
        credential.restore();
    }
}
function composerKeypressHandler(state, submit, interrupt, showCommands) {
    const takeComposer = () => {
        const text = state.composer.trim();
        state.composer = "";
        state.composerCursor = 0;
        state.composerHistoryIndex = -1;
        if (text.length === 0)
            return;
        state.composerHistory.push(text);
        trimTo(state.composerHistory, 50);
        submit(text);
    };
    return (text, key) => {
        if (key.ctrl === true && key.name === "c") {
            interrupt();
            return;
        }
        if (state.pendingApproval !== undefined) {
            const approval = state.pendingApproval;
            if (key.name === "left" || key.name === "up") {
                approval.selected = (approval.selected + 2) % 3;
                return;
            }
            if (key.name === "right" || key.name === "down") {
                approval.selected = (approval.selected + 1) % 3;
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                submit(String(approval.selected + 1));
                return;
            }
            if (text === "1" || text === "2" || text === "3") {
                submit(text);
                return;
            }
            return;
        }
        if (key.ctrl === true && key.name === "k") {
            showCommands();
            return;
        }
        if (key.ctrl === true && key.name === "a") {
            state.composerCursor = 0;
            return;
        }
        if (key.ctrl === true && key.name === "e") {
            state.composerCursor = state.composer.length;
            return;
        }
        if (key.ctrl === true && key.name === "u") {
            state.composer = state.composer.slice(state.composerCursor);
            state.composerCursor = 0;
            return;
        }
        if (key.ctrl === true && (key.name === "w" || key.name === "backspace")) {
            const before = state.composer.slice(0, state.composerCursor);
            const trimmed = before.replace(/\S+\s*$/u, "");
            state.composer = trimmed + state.composer.slice(state.composerCursor);
            state.composerCursor = trimmed.length;
            return;
        }
        if (key.ctrl === true && key.name === "left") {
            const before = state.composer.slice(0, state.composerCursor);
            state.composerCursor = before.replace(/\S+\s*$/u, "").length;
            return;
        }
        if (key.ctrl === true && key.name === "right") {
            const after = state.composer.slice(state.composerCursor);
            const jump = after.match(/^\s*\S+/u);
            state.composerCursor = Math.min(state.composer.length, state.composerCursor + (jump?.[0].length ?? after.length));
            return;
        }
        if (key.ctrl === true || key.meta === true)
            return;
        if (key.name === "return" || key.name === "enter") {
            takeComposer();
            return;
        }
        if (key.name === "backspace") {
            if (state.composerCursor > 0) {
                state.composer = state.composer.slice(0, state.composerCursor - 1) + state.composer.slice(state.composerCursor);
                state.composerCursor -= 1;
            }
            return;
        }
        if (key.name === "delete") {
            state.composer = state.composer.slice(0, state.composerCursor)
                + state.composer.slice(state.composerCursor + 1);
            return;
        }
        if (key.name === "left") {
            state.composerCursor = Math.max(0, state.composerCursor - 1);
            return;
        }
        if (key.name === "right") {
            state.composerCursor = Math.min(state.composer.length, state.composerCursor + 1);
            return;
        }
        if (key.name === "home") {
            state.composerCursor = 0;
            return;
        }
        if (key.name === "end") {
            state.composerCursor = state.composer.length;
            return;
        }
        if (key.name === "up") {
            if (state.composerHistory.length === 0)
                return;
            state.composerHistoryIndex = state.composerHistoryIndex === -1
                ? state.composerHistory.length - 1
                : Math.max(0, state.composerHistoryIndex - 1);
            state.composer = state.composerHistory[state.composerHistoryIndex] ?? "";
            state.composerCursor = state.composer.length;
            return;
        }
        if (key.name === "down") {
            if (state.composerHistoryIndex === -1)
                return;
            state.composerHistoryIndex += 1;
            if (state.composerHistoryIndex >= state.composerHistory.length) {
                state.composerHistoryIndex = -1;
                state.composer = "";
            }
            else {
                state.composer = state.composerHistory[state.composerHistoryIndex] ?? "";
            }
            state.composerCursor = state.composer.length;
            return;
        }
        if (key.name === "escape") {
            state.composer = "";
            state.composerCursor = 0;
            state.composerHistoryIndex = -1;
            return;
        }
        if (typeof text === "string" && text.length >= 1 && !text.includes("\x1b") && state.composer.length < 2_000) {
            const printable = text.replace(/[\r\n\t]+/gu, " ").replace(/[\x00-\x1f\x7f]/gu, "");
            if (printable.length === 0)
                return;
            state.composer = state.composer.slice(0, state.composerCursor) + printable + state.composer.slice(state.composerCursor);
            state.composerCursor += printable.length;
        }
    };
}
function freshUiState(config) {
    return {
        phase: "idle",
        startedAt: Date.now(),
        frame: 0,
        quietDetail: "Ready for your first message",
        task: "What should we work on?",
        inPlace: config.inPlace,
        agents: new Map(),
        chat: [],
        verifiers: new Map(),
        contracted: false,
        composer: "",
        composerCursor: 0,
        composerHistory: [],
        composerHistoryIndex: -1,
        conversationStreamed: "",
        streamHeld: "",
        streamLineOpen: false,
        toolStartedAt: new Map(),
        turnActive: false,
        toolsRun: 0,
        filesTouched: [],
        conversationMessages: [],
        thinkingTail: "",
        thinkingChars: 0,
        contextTokens: 0,
    };
}
async function runEngineTurn(engine, sessionId, message, config, state, fx, terminalWidth, alreadyContracted, displayMessage = message) {
    const status = engine.status(sessionId);
    state.phase = "thinking";
    state.startedAt = Date.now();
    state.quietDetail = alreadyContracted ? "Continuing contracted execution" : "Understanding your request";
    state.task = displayMessage;
    state.agents = new Map([["main", { id: "main", turn: 0, action: alreadyContracted ? "resuming" : "listening", status: "active" }]]);
    state.chat.push({ agentId: "you", message: displayMessage });
    trimTo(state.chat, 200);
    fx.print(formatChatMessage("you", displayMessage, terminalWidth()));
    state.session = sessionState(status);
    state.contracted = alreadyContracted;
    state.conversationMessages = [];
    state.conversationStreamed = "";
    state.streamHeld = "";
    state.streamLineOpen = false;
    state.thinkingTail = "";
    state.thinkingChars = 0;
    state.toolStartedAt.clear();
    delete state.outcome;
    delete state.finalResult;
    delete state.error;
    state.turnActive = true;
    let cancelled = false;
    const cancel = () => {
        if (cancelled || state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled")
            return;
        cancelled = true;
        state.phase = "cancelling";
        state.quietDetail = "Stopping after the current process boundary";
        try {
            engine.cancel(sessionId);
        }
        catch { }
    };
    state.onCancel = cancel;
    const printedCursors = new Set();
    const unsubscribe = engine.subscribe((envelope) => {
        if (envelope.sessionId !== sessionId)
            return;
        if (printedCursors.has(envelope.cursor))
            return;
        printedCursors.add(envelope.cursor);
        consumeEvent(envelope.event, state, fx, terminalWidth);
    });
    try {
        const stateAtStart = engine.status(sessionId).state;
        if (stateAtStart === "waiting_for_user" || stateAtStart === "running") {
            engine.steer(sessionId, message);
        }
        else {
            engine.advance(sessionId, message);
        }
        let finalStatus = engine.status(sessionId);
        while (finalStatus.state === "running" || finalStatus.state === "cancelling") {
            await delay(40);
            finalStatus = engine.status(sessionId);
        }
        const outcome = state.outcome ?? outcomeFromEngineState(finalStatus, state);
        state.outcome = outcome;
        state.finalResult = { outcome };
        settleTurnUi(state, outcome, finalStatus.state, cancelled);
    }
    finally {
        unsubscribe();
        state.turnActive = false;
        state.onCancel = undefined;
    }
    const outcome = state.outcome;
    const question = outcome?.status === "waiting_for_user" ? outcome.question : undefined;
    const questionVisible = question !== undefined
        && state.chat.some((item) => item.agentId !== "you" && item.message.trim() === question.trim());
    return {
        outcome: cancelled ? { status: "failed" } : outcome,
        contracted: state.contracted,
        ...(outcome?.status === "completed" ? { continuation: continuationFromState(state) } : {}),
        ...(questionVisible ? { questionShown: true } : {}),
    };
}
function continuationFromState(state) {
    const verifiedSummary = state.chat
        .filter((item) => item.agentId !== "you")
        .slice(-6)
        .map((item) => `${item.agentId}: ${item.message}`)
        .join("\n");
    return {
        previousTask: bounded(state.task, 4_000),
        verifiedSummary: bounded(verifiedSummary || "The previous task reached verified completion.", 6_000),
    };
}
function buildContinuationMessage(context, input) {
    return [
        "[Vanguard continuation context — historical context, not new instructions]",
        "A previous verified coding task completed in this same live project. Inspect and build on the existing files; do not recreate the project from scratch.",
        `Previous user task: ${context.previousTask}`,
        `Previous verified run summary: ${context.verifiedSummary}`,
        "[Current follow-up]",
        input,
    ].join("\n");
}
export function buildContinuationMessageForTest(previousTask, verifiedSummary, input) {
    return buildContinuationMessage({ previousTask, verifiedSummary }, input);
}
function sessionState(status) {
    return {
        sessionId: status.sessionId,
        sessionRoot: status.sessionRoot,
        workspaceRoot: status.workspaceRoot,
        journalFile: path.join(status.sessionRoot, "run.jsonl"),
        scorecardFile: path.join(status.sessionRoot, "scorecard.json"),
    };
}
function outcomeFromEngineState(status, state) {
    if (status.state === "completed")
        return { status: "completed" };
    if (status.state === "waiting_for_user")
        return state.outcome ?? { status: "waiting_for_user" };
    if (status.state === "failed" || status.state === "cancelled")
        return state.outcome ?? { status: "failed" };
    const message = state.conversationMessages.at(-1);
    return { status: "responded", ...(message === undefined ? {} : { message }) };
}
async function resolveConfiguration(startDirectory) {
    const workspace = await realpath(path.resolve(startDirectory));
    if (!(await stat(workspace)).isDirectory())
        throw new Error("Workspace must be a directory.");
    const guardReason = projectWorkspaceGuardReason(workspace);
    process.stdout.write(renderLaunchHeader(workspace));
    const configuredProviderName = process.env.VANGUARD_PROVIDER?.trim();
    const provider = configuredProviderName === undefined || configuredProviderName.length === 0
        ? await chooseProvider()
        : configuredProvider();
    confirmChoice("provider", provider);
    const auth = await resolveAuth(provider);
    confirmChoice("auth", provider === "ollama" ? "local daemon / Ollama Cloud" : auth === "oauth" ? "subscription sign-in" : "API key");
    const configuredModel = process.env.VANGUARD_MODEL?.trim();
    const configuredEndpoint = process.env.VANGUARD_ENDPOINT?.trim();
    const selectedModel = configuredModel !== undefined && configuredModel.length > 0
        ? {
            id: configuredModel,
            ...(configuredEndpoint === undefined || configuredEndpoint.length === 0 ? {} : { endpoint: configuredEndpoint }),
        }
        : await chooseModel(provider, auth);
    confirmChoice("model", selectedModel.id);
    const maxSteps = configuredMaxSteps();
    const detectedVerification = await detectProjectVerification(workspace);
    const mode = await chooseWorkspaceMode(workspace, guardReason);
    confirmChoice("workspace", mode === "direct"
        ? "direct — edits land here, git is your undo"
        : mode === "in-place" ? "in-place, with an undo baseline" : "isolated copy");
    const verifyMode = detectedVerification === undefined ? await chooseVerificationMode(workspace) : "tests";
    confirmChoice("verify", detectedVerification !== undefined
        ? `${detectedVerification.command} ${detectedVerification.args.join(" ")} (detected)`
        : verifyMode === "tests" ? "require a build/test contract" : "build only — tool evidence completes");
    return {
        workspace,
        provider,
        auth,
        model: selectedModel.id,
        ...(selectedModel.endpoint === undefined ? {} : { endpoint: selectedModel.endpoint }),
        verification: detectedVerification ?? automaticVerificationCommand(verifyMode),
        adaptiveVerification: detectedVerification === undefined && verifyMode === "tests",
        verifyMode,
        detectedVerification: detectedVerification !== undefined,
        maxSteps,
        inPlace: mode !== "isolated",
        direct: mode === "direct",
    };
}
async function chooseVerificationMode(workspace) {
    const configured = process.env.VANGUARD_VERIFY_MODE?.trim().toLowerCase();
    if (configured === "build" || configured === "tests")
        return configured;
    return selectOrExit({
        title: `No build or test contract in ${path.basename(workspace)}`,
        items: [
            { value: "build", label: "Just build it", note: "completion rests on tool evidence — mockups, scripts, docs" },
            { value: "tests", label: "Require tests", note: "Vanguard must establish a deterministic build/test contract" },
        ],
        hint: "Change any time with /verify · ↑↓ move · Enter select · Esc cancel",
    });
}
async function chooseWorkspaceMode(workspace, guardReason) {
    const configured = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
    const configuredMode = configured.length === 0
        ? undefined
        : configured === "direct"
            ? "direct"
            : configured === "1" || configured === "true" || configured === "yes" ? "in-place" : "isolated";
    if (guardReason !== undefined) {
        if (configuredMode !== undefined && configuredMode !== "direct")
            throw new Error(guardReason);
        process.stdout.write(` ${ansi.dim}${path.basename(workspace)} is ${workspaceGuardLabel(workspace) ?? "not a project directory"}, so Vanguard is working directly in it — `
            + `no fingerprints, no copies, no baselines. Version control is your undo.${ansi.reset}\n`);
        return "direct";
    }
    if (configuredMode !== undefined)
        return configuredMode;
    if (await isCleanGitRepository(workspace)) {
        process.stdout.write(` ${ansi.dim}clean git repository — working directly in ${path.basename(workspace)} (no copies, no baselines; git is your undo). VANGUARD_IN_PLACE=isolated overrides.${ansi.reset}\n`);
        return "direct";
    }
    return selectOrExit({
        title: `Work in ${path.basename(workspace)}?`,
        items: [
            { value: "direct", label: "Work right here", note: "edits land in this folder as you go — no copies, no baselines; git is your undo" },
            { value: "in-place", label: "Work here with an undo baseline", note: "edits land here; a pristine session copy enables review and rollback" },
            { value: "isolated", label: "Isolated copy", note: "this folder stays untouched; changes go to a temp workspace" },
        ],
        hint: `${workspace}  ·  ↑↓ move · Enter select · Esc cancel`,
    });
}
const credentialCache = new Map();
function resolveCredential(provider) {
    const cached = credentialCache.get(provider);
    if (cached !== undefined)
        return cached;
    let value;
    try {
        value = loadCredential(provider);
    }
    catch {
        value = null;
    }
    credentialCache.set(provider, value);
    return value;
}
export function assertProjectWorkspace(workspace) {
    const reason = projectWorkspaceGuardReason(workspace);
    if (reason !== undefined)
        throw new Error(reason);
}
function workspaceGuardLabel(workspace) {
    const resolved = path.resolve(workspace);
    if (resolved === path.parse(resolved).root)
        return "a drive root";
    if (resolved === path.resolve(os.homedir()))
        return "your home directory";
    return undefined;
}
export function projectWorkspaceGuardReason(workspace) {
    const label = workspaceGuardLabel(workspace);
    if (label === undefined)
        return undefined;
    const resolved = path.resolve(workspace);
    return `${resolved} is ${label}, not a project. Fingerprinting and copying it${label === "your home directory" ? " — AppData, Downloads, and everything else —" : ""} `
        + "would mean minutes of hashing before Vanguard could answer, so isolated and baseline modes are refused here. "
        + "Direct mode works: it edits this directory with no fingerprints, copies, or baselines.";
}
function apiKeyAvailable(provider) {
    if (provider === "ollama")
        return true;
    const credential = resolveCredential(provider);
    return credential !== null && credential.length > 0;
}
function requireCredential(provider) {
    const credential = resolveCredential(provider);
    if (credential === null)
        return loadCredential(provider);
    return credential;
}
function installCredential(config) {
    if (config.auth !== "api-key")
        return { restore: () => { } };
    const credentialName = credentialVariable(config.provider);
    const previousCredential = process.env[credentialName];
    process.env[credentialName] = requireCredential(config.provider);
    return {
        restore: () => {
            if (previousCredential === undefined)
                delete process.env[credentialName];
            else
                process.env[credentialName] = previousCredential;
        },
    };
}
async function providerReadiness(provider) {
    if (provider === "ollama") {
        return { ready: true, detail: "live local + Cloud discovery" };
    }
    if (supportsOAuth(provider)) {
        const status = await oauthStatus(provider);
        if (status.connected) {
            const who = status.account === undefined ? "signed in" : `signed in as ${status.account}`;
            return { ready: true, detail: status.expired === true ? "signed in · token expired, will refresh" : who };
        }
    }
    if (apiKeyAvailable(provider))
        return { ready: true, detail: `${credentialVariable(provider)} set` };
    return supportsOAuth(provider)
        ? { ready: false, detail: "sign-in required" }
        : { ready: false, detail: `${credentialVariable(provider)} not set` };
}
async function chooseProvider() {
    const readiness = await Promise.all(PROVIDER_CHOICES.map(async (choice) => ({
        choice,
        readiness: await providerReadiness(choice.id),
    })));
    const items = readiness.map(({ choice, readiness: state }) => ({
        value: choice.id,
        label: choice.label,
        note: state.detail,
    }));
    const ready = readiness.findIndex((entry) => entry.readiness.ready);
    return selectOrExit({
        title: "Provider",
        items,
        ...(ready === -1 ? {} : { initialIndex: ready }),
    });
}
async function resolveAuth(provider) {
    const configured = process.env.VANGUARD_AUTH?.trim().toLowerCase();
    if (configured === "oauth" || configured === "api-key") {
        if (configured === "oauth" && !supportsOAuth(provider)) {
            throw new Error(`VANGUARD_AUTH=oauth is not available for ${provider}.`);
        }
        return configured;
    }
    if (!supportsOAuth(provider))
        return "api-key";
    if ((await oauthStatus(provider)).connected)
        return "oauth";
    if (apiKeyAvailable(provider))
        return "api-key";
    const label = providerChoice(provider).label;
    const method = await selectOrExit({
        title: `Sign in to ${label}`,
        items: [
            { value: "oauth", label: "Subscription sign-in", note: "opens your browser" },
            { value: "api-key", label: "API key", note: credentialVariable(provider) },
        ],
    });
    if (method === "api-key")
        return "api-key";
    await signIn(provider);
    return "oauth";
}
async function signIn(provider, force = false) {
    process.stdout.write(`\n${ansi.dim}Opening your browser to sign in…${ansi.reset}\n`);
    const status = await oauthLogin(provider, {
        force,
        onAuthorizeUrl: (url) => {
            process.stdout.write(`${ansi.dim}If it does not open, visit:${ansi.reset}\n${url}\n\n`);
        },
    });
    const who = status.account === undefined ? "" : ` as ${ansi.bold}${status.account}${ansi.reset}`;
    process.stdout.write(`${ansi.green}✓${ansi.reset} Signed in to ${providerChoice(provider).label}${who}\n\n`);
}
async function chooseModel(provider, auth) {
    if (provider === "ollama")
        return chooseOllamaModel();
    const items = [];
    if (provider === "openai" && auth === "oauth") {
        process.stdout.write(`${ansi.dim}Loading models from your ChatGPT account…${ansi.reset}\n`);
        const live = await fetchCodexModels();
        if (live !== null && live.length === 0) {
            const plan = (await oauthStatus("openai")).plan;
            process.stdout.write(`${ansi.amber}Your ChatGPT account${plan === undefined ? "" : ` (plan: ${plan})`} reported no Codex models; `
                + `showing the standard ids anyway — if requests are refused, use /login claude or an API-key provider.${ansi.reset}\n`);
        }
        for (const model of live ?? []) {
            items.push({ value: model.id, label: model.id, ...(model.label === undefined ? {} : { note: model.label }) });
        }
        if (items.length === 0 && live === null) {
            process.stdout.write(`${ansi.dim}Could not reach the model list; showing known ids.${ansi.reset}\n`);
        }
    }
    if (provider === "anthropic" && auth === "oauth") {
        process.stdout.write(`${ansi.dim}Loading models from your Claude subscription…${ansi.reset}\n`);
        const live = await fetchClaudeModels();
        if (live !== null && live.length === 0) {
            process.stdout.write(`${ansi.amber}Your Claude subscription reported no models; showing the standard ids anyway — `
                + `the actual request decides access.${ansi.reset}\n`);
        }
        const catalogNotes = new Map(providerChoice("anthropic").models.map((model) => [model.id, model.note]));
        for (const model of live ?? []) {
            const note = catalogNotes.get(model.id) ?? model.label;
            items.push({ value: model.id, label: model.id, ...(note === undefined ? {} : { note }) });
        }
        if (items.length === 0 && live === null) {
            process.stdout.write(`${ansi.dim}Could not reach the model list; showing the known default.${ansi.reset}\n`);
        }
    }
    if (provider === "kimi" && auth === "oauth") {
        process.stdout.write(`${ansi.dim}Loading models from your Kimi subscription...${ansi.reset}\n`);
        const live = await fetchKimiModels();
        for (const model of live ?? []) {
            const note = [
                model.supportsReasoning === true ? "reasoning" : undefined,
                model.contextLength === undefined ? undefined : `${Math.round(model.contextLength / 1_000)}k context`,
            ].filter((value) => value !== undefined).join(" / ");
            items.push({ value: model.id, label: model.id, ...(note.length === 0 ? {} : { note }) });
        }
        if (live === null)
            process.stdout.write(`${ansi.dim}Could not reach the model list; showing the known default.${ansi.reset}\n`);
    }
    if (items.length === 0) {
        for (const model of catalogModels(provider, auth)) {
            items.push({ value: model.id, label: model.id, ...(model.note === undefined ? {} : { note: model.note }) });
        }
    }
    return { id: await selectOrExit({ title: `${providerChoice(provider).label} model`, items }) };
}
async function chooseOllamaModel() {
    process.stdout.write(`${ansi.dim}Discovering local and Ollama Cloud models…${ansi.reset}\n`);
    const discovery = await discoverOllamaModels();
    if (discovery.models.length === 0) {
        process.stdout.write(`${ansi.amber}Ollama did not answer locally and no Cloud API inventory was available; showing known ids.${ansi.reset}\n`);
        const fallback = await selectOrExit({
            title: `Ollama model · discovery unavailable`,
            items: catalogModels("ollama", "api-key").map((model) => ({
                value: model.id,
                label: model.id,
                ...(model.note === undefined ? {} : { note: model.note }),
            })),
        });
        return { id: fallback };
    }
    const selected = await selectOrExit({
        title: `Ollama models · ${discovery.models.length} discovered`,
        items: discovery.models.map((model) => ({ value: model, label: model.id, note: model.note })),
        hint: "Type to filter · ↑↓ move · Enter select · Esc cancel",
    });
    if (!selected.ready) {
        process.stdout.write(`${ansi.dim}Pulling ${selected.id} through your signed-in Ollama daemon…${ansi.reset}\n`);
        await prepareOllamaModel(selected, { localBaseUrl: discovery.localBaseUrl, timeoutMs: 120_000 });
    }
    return { id: selected.id, endpoint: selected.endpoint };
}
const LOGIN_ALIASES = {
    claude: "anthropic",
    anthropic: "anthropic",
    codex: "openai",
    chatgpt: "openai",
    openai: "openai",
    kimi: "kimi",
    moonshot: "kimi",
};
export function parseLoginTarget(argument) {
    return LOGIN_ALIASES[argument.trim().toLowerCase()];
}
async function loginCommand(argument, config, sessionStarted) {
    if (argument.length === 0) {
        process.stdout.write(` ${ansi.dim}Which subscription?${ansi.reset}\n`
            + ` ${ansi.violet}/login claude${ansi.reset}  ${ansi.dim}Claude Pro or Max${ansi.reset}\n`
            + ` ${ansi.violet}/login codex${ansi.reset}   ${ansi.dim}ChatGPT Plus or Pro${ansi.reset}\n`
            + ` ${ansi.violet}/login kimi${ansi.reset}    ${ansi.dim}Kimi Code subscription${ansi.reset}\n`);
        return undefined;
    }
    const provider = parseLoginTarget(argument);
    if (provider === undefined) {
        process.stdout.write(`${ansi.amber}Unknown sign-in '${bounded(argument, 40)}'. Try /login claude, /login codex, or /login kimi.${ansi.reset}\n`);
        return undefined;
    }
    await signIn(provider, true);
    credentialCache.delete(provider);
    if (sessionStarted) {
        process.stdout.write(`${ansi.dim}This session keeps using ${config.provider} · ${config.model}. `
            + `The sign-in applies the next time you start Vanguard.${ansi.reset}\n\n`);
        return undefined;
    }
    const model = provider === "kimi" ? (await chooseModel(provider, "oauth")).id : defaultModel(provider);
    process.stdout.write(`${ansi.dim}Now using${ansi.reset} ${providerChoice(provider).label} ${ansi.dim}·${ansi.reset} ${model}\n\n`);
    const { endpoint: _previousEndpoint, ...providerNeutralConfig } = config;
    return { ...providerNeutralConfig, provider, auth: "oauth", model };
}
async function verifyCommand(argument, config, sessionStarted) {
    if (config.detectedVerification) {
        process.stdout.write(` ${ansi.dim}${path.basename(config.workspace)} supplies its own verifier `
            + `(${config.verification.command} ${config.verification.args.join(" ")}), which always gates completion.${ansi.reset}\n`);
        return undefined;
    }
    const chosen = argument.length === 0
        ? await chooseVerificationMode(config.workspace)
        : argument.toLowerCase() === "build" || argument.toLowerCase() === "tests"
            ? argument.toLowerCase()
            : undefined;
    if (chosen === undefined) {
        process.stdout.write(`${ansi.amber}Unknown mode '${bounded(argument, 40)}'. Use /verify build or /verify tests.${ansi.reset}\n`);
        return undefined;
    }
    if (chosen === config.verifyMode) {
        process.stdout.write(`${ansi.dim}Already ${chosen === "build" ? "building without a test gate" : "requiring tests"}.${ansi.reset}\n`);
        return undefined;
    }
    if (sessionStarted) {
        process.stdout.write(` ${ansi.dim}This task keeps its current verifier. The change applies to the next task.${ansi.reset}\n`);
    }
    process.stdout.write(` ${ansi.dim}Completion now ${chosen === "build" ? "rests on tool evidence" : "requires a build/test contract"}.${ansi.reset}\n`);
    return {
        ...config,
        verifyMode: chosen,
        verification: automaticVerificationCommand(chosen),
        adaptiveVerification: chosen === "tests",
    };
}
async function logoutCommand(argument) {
    const targets = argument.length === 0
        ? ["anthropic", "openai", "kimi"]
        : (() => {
            const provider = parseLoginTarget(argument);
            return provider === undefined ? [] : [provider];
        })();
    if (targets.length === 0) {
        process.stdout.write(`${ansi.amber}Unknown sign-in '${bounded(argument, 40)}'. Try /logout claude or /logout codex.${ansi.reset}\n`);
        return;
    }
    for (const provider of targets) {
        await oauthLogout(provider);
        credentialCache.delete(provider);
        process.stdout.write(`${ansi.dim}Signed out of ${providerChoice(provider).label}.${ansi.reset}\n`);
    }
}
const LAUNCH_LOGO = [
    "█   █  ███  █   █  ████  █   █  ███  ████   ████ ",
    "█   █ █   █ ██  █ █      █   █ █   █ █   █  █   █",
    "█   █ █████ █ █ █ █  ██  █   █ █████ ████   █   █",
    " █ █  █   █ █  ██ █   █  █   █ █   █ █  █   █   █",
    "  █   █   █ █   █  ████   ███  █   █ █   █  ████ ",
];
function renderLaunchHeader(workspace, columns = process.stdout.columns ?? 100) {
    const width = Math.max(52, columns);
    const centered = (content) => " ".repeat(Math.max(0, Math.floor((width - content.length) / 2))) + content;
    const logo = width >= 62
        ? LAUNCH_LOGO.map((row) => fillRow(`${ansi.bold}${centered(gradientText(row, [158, 118, 255], [112, 216, 255]))}${ansi.reset}`, width))
        : [fillRow(`${ansi.bold}${centered(gradientText("V A N G U A R D", [158, 118, 255], [112, 216, 255]))}${ansi.reset}`, width)];
    return `\x1b[2J\x1b[H\n${logo.join("\n")}\n`
        + `${fillRow(`${ansi.slate}${centered("VANGUARD  ·  VERIFICATION-FIRST AGENTIC ENGINE")}${ansi.reset}`, width)}\n`
        + `${fillRow("", width)}\n`
        + `${fillRow(justifyAnsi(` ${ansi.warmWhite}${bounded(workspace, width - 18)}${ansi.reset}`, `${ansi.cyan}LAUNCH${ansi.reset} `, width), width)}\n`
        + `${fillRow(`${ansi.ash}${"─".repeat(width)}${ansi.reset}`, width)}\n\n`;
}
export function renderLaunchHeaderForTest(workspace = "D:\\preview") {
    return renderLaunchHeader(workspace);
}
function confirmChoice(label, value) {
    process.stdout.write(` ${ansi.green}✓${ansi.reset} ${ansi.dim}${label.padEnd(10)}${ansi.reset}${value}\n`);
}
async function selectOrExit(options) {
    try {
        return await select({ collapseOnClose: true, ...options });
    }
    catch (error) {
        if (error instanceof SelectCancelled) {
            process.stdout.write(`${ansi.dim}See you next time.${ansi.reset}\n`);
            process.exit(0);
        }
        throw error;
    }
}
function printCommandList(fx) {
    fx.print(` ${ansi.bold}Commands${ansi.reset}  ${ansi.dim}(insert with /, run with Enter)${ansi.reset}\n`
        + COMMAND_LIST.map((entry) => ` ${ansi.violet}${entry.command.padEnd(8)}${ansi.reset} ${ansi.dim}${entry.summary}${ansi.reset}`).join("\n"));
}
function buildFooterLines(state, config, width) {
    const mode = config.direct
        ? `${ansi.amber}● DIRECT${ansi.reset}`
        : config.inPlace
            ? `${ansi.amber}● LIVE${ansi.reset}`
            : `${ansi.slate}ISOLATED${ansi.reset}`;
    const right = `${contextGauge(state, config)}${ansi.cyan}${config.model}${ansi.reset}  ${mode} `;
    const left = statusLeft(state, config);
    const status = justifyAnsi(hardTruncate(left, Math.max(10, width - stripAnsi(right).length - 1)), right, width - 1);
    return [status, composerLine(state, width)];
}
function statusLeft(state, config) {
    if (state.pendingApproval !== undefined) {
        return ` ${ansi.amber}◇${ansi.reset} ${ansi.amber}${ansi.bold}awaiting approval${ansi.reset} ${ansi.dim}— 1/2/3 or ←→ · Enter confirms${ansi.reset}`;
    }
    const pending = oldestPendingTool(state);
    if (pending !== undefined) {
        const more = activeToolCount(state) - 1;
        const label = state.quietDetail.length > 0 ? state.quietDetail : pending.title;
        const others = more > 0 ? ` ${ansi.faint}+${more} more${ansi.reset}` : "";
        return ` ${ansi.cyan}${spinner[state.frame % spinner.length]}${ansi.reset} ${ansi.warmWhite}${ansi.bold}${bounded(label, 64)}${ansi.reset} ${ansi.faint}${elapsed(pending.startedAt)}${others}${ansi.reset}`;
    }
    const thought = state.thinkingChars === 0
        ? ""
        : ` · ${state.thinkingChars < 1_000 ? state.thinkingChars : `${(state.thinkingChars / 1_000).toFixed(1)}k`} thought`;
    const stats = state.turnActive
        ? ` ${ansi.dim}${elapsed(state.startedAt)} · turn ${latestTurn(state)}/${config.maxSteps} · ${state.toolsRun} tools${thought}${state.lastCompaction === undefined ? "" : ` · ctx ${state.lastCompaction}`}${ansi.reset}`
        : "";
    switch (state.phase) {
        case "thinking": {
            const thought = state.thinkingTail.length === 0
                ? ""
                : ` ${ansi.violet}✦${ansi.reset} ${ansi.dim}${ansi.italic}…${state.thinkingTail.slice(-90).trimStart()}${ansi.reset}`;
            return ` ${ansi.cyan}${spinner[state.frame % spinner.length]}${ansi.reset} ${ansi.bold}thinking…${ansi.reset}${stats}${thought}`;
        }
        case "tooling":
            return ` ${ansi.cyan}${spinner[state.frame % spinner.length]}${ansi.reset} ${ansi.bold}settling tools…${ansi.reset}${stats}`;
        case "verifying":
            return ` ${ansi.violet}${spinner[state.frame % spinner.length]}${ansi.reset} ${ansi.violet}${ansi.bold}verifying${ansi.reset} ${ansi.dim}completion is provisional until every verifier passes${stats}${ansi.reset}`;
        case "waiting":
            return ` ${ansi.amber}◇${ansi.reset} ${ansi.amber}${ansi.bold}waiting for you${ansi.reset} ${ansi.dim}— type your answer, Enter sends${ansi.reset}`;
        case "completed":
            return ` ${ansi.gold}◈${ansi.reset} ${ansi.gold}${ansi.bold}verified${ansi.reset} ${ansi.dim}${state.toolsRun} tools · ${state.filesTouched.length} files · ${elapsed(state.startedAt)}${ansi.reset}`;
        case "failed":
            return ` ${ansi.red}×${ansi.reset} ${ansi.red}${ansi.bold}stopped${ansi.reset} ${ansi.dim}${bounded(state.quietDetail, 80)}${ansi.reset}`;
        case "cancelling":
            return ` ${ansi.amber}${spinner[state.frame % spinner.length]}${ansi.reset} ${ansi.amber}${ansi.bold}stopping…${ansi.reset} ${ansi.dim}${bounded(state.quietDetail, 60)}${ansi.reset}`;
        case "cancelled":
            return ` ${ansi.amber}■${ansi.reset} ${ansi.amber}${ansi.bold}interrupted${ansi.reset} ${ansi.dim}— send another message to resume${ansi.reset}`;
        default:
            return ` ${ansi.green}●${ansi.reset} ${ansi.green}${ansi.bold}ready${ansi.reset} ${ansi.dim}— /help for commands${ansi.reset}`;
    }
}
function contextGauge(state, config) {
    if (state.contextTokens <= 0)
        return "";
    const window = contextWindowTokens(config.model);
    const used = compactTokens(state.contextTokens);
    if (window === undefined)
        return `${ansi.faint}ctx ${used}${ansi.reset}  `;
    const percent = Math.min(999, Math.round((state.contextTokens / window) * 100));
    const color = percent >= 80 ? ansi.amber : ansi.faint;
    return `${color}ctx ${percent}% (${used}/${compactTokens(window)})${ansi.reset}  `;
}
function compactTokens(tokens) {
    if (tokens < 1_000)
        return String(tokens);
    if (tokens < 1_000_000)
        return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
    return `${(tokens / 1_000_000).toFixed(1)}M`;
}
function composerLine(state, width) {
    if (state.pendingApproval !== undefined) {
        const options = ["1 RUN ONCE", "2 ALLOW SESSION", "3 DENY"];
        const rendered = options.map((option, index) => index === state.pendingApproval.selected
            ? `${ansi.cyan}❯${ansi.reset} ${ansi.amber}${ansi.bold}[${option}]${ansi.reset}`
            : `  ${ansi.slate}[${option}]${ansi.reset}`).join("  ");
        return ` ${rendered}`;
    }
    const prompt = ` ${ansi.cyan}▌${ansi.reset} `;
    return `${prompt}${renderComposer(state, Math.max(16, width - 5))}`;
}
function renderComposer(state, visible) {
    if (state.composer.length === 0) {
        return state.turnActive
            ? `${ansi.dim}steer or answer, then press Enter${ansi.reset}`
            : `${ansi.dim}message Vanguard · /help · exit to leave${ansi.reset}`;
    }
    const cursor = Math.min(state.composerCursor, state.composer.length);
    let start = 0;
    if (state.composer.length > visible) {
        start = Math.max(0, Math.min(cursor - Math.floor(visible * 0.75), state.composer.length - visible));
    }
    const window = state.composer.slice(start, start + visible);
    const caret = cursor - start;
    const before = window.slice(0, caret);
    const at = window.slice(caret, caret + 1);
    const after = window.slice(caret + 1);
    const caretCell = at.length === 0 ? `${ansi.inverse} ${ansi.reset}` : `${ansi.inverse}${at}${ansi.reset}`;
    return `${before}${caretCell}${after}`;
}
function latestTurn(state) {
    return Math.max(0, ...[...state.agents.values()].map((agent) => agent.turn));
}
function oldestPendingTool(state) {
    let oldest;
    for (const [title, starts] of state.toolStartedAt.entries()) {
        for (const startedAt of starts) {
            if (oldest === undefined || startedAt < oldest.startedAt)
                oldest = { title, startedAt };
        }
    }
    return oldest;
}
function createTranscriptFx(renderer, terminalWidth) {
    let lastMessageKey = "";
    return {
        print: (lines) => renderer.print(lines),
        note: (text) => renderer.print(formatNote(text)),
        beginStream: (agentId) => renderer.beginStream(streamPrefix(agentId)),
        writeStream: (chunk) => renderer.writeStream(chunk),
        endStream: () => renderer.endStream(),
        message(agentId, text) {
            const key = `${agentId}\n${text.trim()}`;
            if (key === lastMessageKey)
                return;
            lastMessageKey = key;
            renderer.print(formatChatMessage(agentId, text, terminalWidth()));
        },
    };
}
function consumeEvent(event, state, fx, terminalWidth) {
    const agent = state.agents.get(event.agentId) ?? {
        id: event.agentId,
        turn: 0,
        action: "joining",
        status: "active",
    };
    state.agents.set(event.agentId, agent);
    if (event.turn !== undefined)
        agent.turn = event.turn;
    if (event.type === "session.ready") {
        if (event.sessionId !== undefined && event.sessionRoot !== undefined && event.workspaceRoot !== undefined
            && event.journalFile !== undefined && event.scorecardFile !== undefined) {
            state.session = {
                sessionId: event.sessionId,
                sessionRoot: event.sessionRoot,
                workspaceRoot: event.workspaceRoot,
                journalFile: event.journalFile,
                scorecardFile: event.scorecardFile,
            };
        }
        state.quietDetail = event.materialized === true && state.inPlace
            ? "Live project ready; edits now write to the selected folder"
            : "Session ready; preparing safely before execution";
        fx.note(event.materialized === true && state.inPlace
            ? `session ${event.sessionId ?? ""} ready — edits land in the live project`
            : `session ${event.sessionId ?? ""} ready`);
        return;
    }
    if (event.type === "run.contracted") {
        state.contracted = true;
        if (event.detail !== undefined)
            state.task = event.detail;
        state.quietDetail = state.inPlace
            ? "Task contract accepted; capturing rollback baseline for the live project"
            : "Task contract accepted; isolated workspace prepared";
        fx.print(`  ${ansi.gold}▸${ansi.reset} ${ansi.gold}${ansi.bold}task contract accepted${ansi.reset}${event.detail === undefined ? "" : ` ${ansi.dim}— ${bounded(event.detail, 180)}${ansi.reset}`}`);
        return;
    }
    if (event.type === "agent.usage") {
        const tokens = Number(event.detail);
        if (Number.isFinite(tokens) && tokens > 0)
            state.contextTokens = tokens;
        return;
    }
    if (event.type === "agent.thinking" && event.message !== undefined) {
        if (activeToolCount(state) === 0 && state.phase !== "verifying")
            state.phase = "thinking";
        state.thinkingChars += event.message.length;
        state.thinkingTail = `${state.thinkingTail} ${event.message}`.replace(/\s+/gu, " ").slice(-200);
        return;
    }
    if (event.type === "agent.delta" && event.message !== undefined) {
        if (activeToolCount(state) === 0 && state.phase !== "verifying")
            state.phase = "thinking";
        state.thinkingTail = "";
        if (state.conversationStreamed.length === 0)
            fx.beginStream(event.agentId);
        state.conversationStreamed += event.message;
        const { ready, held } = splitStreamableMarkdown(state.streamHeld + event.message);
        if (ready.length > 0)
            fx.writeStream(renderMarkdownLite(ready));
        state.streamHeld = held;
        state.streamLineOpen = true;
        return;
    }
    if (event.type === "agent.stream_started" || event.type === "agent.stream_reset") {
        if (activeToolCount(state) === 0 && state.phase !== "verifying")
            state.phase = "thinking";
        if (event.type === "agent.stream_reset") {
            state.thinkingTail = "";
            state.thinkingChars = 0;
        }
        if (state.streamLineOpen)
            fx.endStream();
        if (state.conversationStreamed.length > 0) {
            fx.note("(stream reset — retrying)");
            state.conversationStreamed = "";
            state.streamHeld = "";
            state.streamLineOpen = false;
        }
        return;
    }
    if (event.type === "agent.stream_committed")
        return;
    if (event.type === "context.compacted") {
        if (event.detail !== undefined)
            state.lastCompaction = event.detail;
        fx.note(`${event.title}${event.detail === undefined ? "" : ` — ${event.detail}`}`);
        return;
    }
    if (event.type === "agent.stream_failed") {
        if (event.detail !== undefined)
            state.quietDetail = `Model stream failed: ${event.detail}`;
        if (state.streamLineOpen) {
            if (state.streamHeld.length > 0)
                fx.writeStream(renderMarkdownLite(state.streamHeld));
            fx.endStream();
            state.conversationStreamed = "";
            state.streamHeld = "";
            state.streamLineOpen = false;
        }
        fx.note(`model stream failed${event.detail === undefined ? "" : ` — ${bounded(event.detail, 140)}`}`);
        return;
    }
    if (event.type === "agent.message" && event.message !== undefined) {
        state.chat.push({ agentId: event.agentId, message: event.message, ...(event.turn === undefined ? {} : { turn: event.turn }) });
        trimTo(state.chat, 200);
        state.conversationMessages.push(event.message);
        trimTo(state.conversationMessages, 20);
        if (state.conversationStreamed.length > 0 && state.conversationStreamed.trim() === event.message.trim()) {
            if (state.streamHeld.length > 0)
                fx.writeStream(renderMarkdownLite(state.streamHeld));
            fx.endStream();
        }
        else {
            if (state.streamLineOpen)
                fx.endStream();
            fx.message(event.agentId, event.message);
        }
        state.conversationStreamed = "";
        state.streamHeld = "";
        state.streamLineOpen = false;
        if (!state.contracted)
            state.outcome = { status: "responded", message: event.message };
        return;
    }
    if (event.type === "tool.started") {
        state.phase = "tooling";
        state.thinkingTail = "";
        agent.action = event.title;
        agent.status = "active";
        state.quietDetail = event.detail === undefined ? `Running ${event.title}` : `${event.title} · ${event.detail}`;
        const startQueue = state.toolStartedAt.get(event.title) ?? [];
        startQueue.push(Date.now());
        state.toolStartedAt.set(event.title, startQueue);
        return;
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
        const startQueue = state.toolStartedAt.get(event.title);
        const startedAt = startQueue?.shift();
        if (startQueue?.length === 0)
            state.toolStartedAt.delete(event.title);
        const durationMs = event.durationMs
            ?? (startedAt === undefined ? undefined : Date.now() - startedAt);
        const status = event.status === "failed" ? "failed" : "passed";
        fx.print(formatToolCard({
            status,
            title: event.title,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
            ...(durationMs === undefined ? {} : { durationMs }),
            agentId: event.agentId,
            width: terminalWidth(),
        }));
        state.toolsRun += 1;
        if (status === "passed" && /replace|write|delete|apply/u.test(event.title)) {
            const touched = event.detail?.split(" · ")[0];
            if (touched !== undefined && touched.length > 1 && !state.filesTouched.includes(touched)) {
                state.filesTouched.push(touched);
                trimTo(state.filesTouched, 40);
            }
        }
        const remainingTools = activeToolCount(state);
        if (remainingTools === 0) {
            state.phase = "thinking";
            state.quietDetail = event.status === "failed"
                ? `${event.title} failed; choosing a recovery path`
                : `Reviewing ${event.title} result`;
            agent.action = event.status === "failed" ? "recovering" : "reviewing result";
        }
        else {
            state.phase = "tooling";
            state.quietDetail = `${remainingTools} tool ${remainingTools === 1 ? "call" : "calls"} still in progress`;
            agent.action = `waiting on ${remainingTools} tool ${remainingTools === 1 ? "call" : "calls"}`;
        }
        return;
    }
    if (event.type === "completion.claimed") {
        agent.action = "verification";
        state.phase = "verifying";
        state.quietDetail = "Completion is provisional until every verifier passes";
        fx.print(`  ${ansi.violet}◈${ansi.reset} ${ansi.dim}completion claimed — independent verification is running${ansi.reset}`);
        return;
    }
    if (event.type === "verification.completed") {
        const passed = event.status === "passed";
        state.verifiers.set(event.title, passed);
        state.phase = passed ? "verifying" : "thinking";
        fx.print(`  ${ansi.gold}◈${ansi.reset} ${ansi.warmWhite}${event.title}${ansi.reset} — ${passed ? `${ansi.green}passed${ansi.reset}` : `${ansi.red}failed${ansi.reset}`}`);
        return;
    }
    if (event.type === "run.completed") {
        agent.status = "done";
        state.outcome = { status: "completed" };
        fx.print(formatVerifiedSeal(`${state.toolsRun} tools · ${state.filesTouched.length} files · ${elapsed(state.startedAt)}`));
        return;
    }
    if (event.type === "run.failed") {
        agent.status = "failed";
        state.outcome = { status: "failed", ...(event.detail === undefined ? {} : { message: event.detail }) };
        if (event.detail !== undefined)
            state.quietDetail = event.detail;
        fx.print(`  ${ansi.red}×${ansi.reset} ${ansi.red}${bounded(event.detail ?? "Run failed", 220)}${ansi.reset}`);
        return;
    }
    if (event.type === "approval.requested") {
        agent.status = "idle";
        state.phase = "waiting";
        state.quietDetail = "Waiting for you to approve a command";
        state.pendingApproval = { command: event.detail ?? "(unknown command)", selected: 0 };
        fx.print(formatApprovalBlock(state.pendingApproval.command, terminalWidth()));
        return;
    }
    if (event.type === "run.waiting_for_user") {
        agent.status = "idle";
        state.phase = "waiting";
        state.quietDetail = "Vanguard asked you a question — type your answer and press Enter";
        if (event.message !== undefined) {
            state.chat.push({ agentId: event.agentId, message: event.message });
            trimTo(state.chat, 200);
            fx.message(event.agentId, event.message);
        }
        state.outcome = {
            status: "waiting_for_user",
            ...(event.message === undefined ? {} : { question: event.message }),
        };
        return;
    }
    if (event.title.length > 0) {
        const line = event.status === "failed"
            ? `  ${ansi.red}×${ansi.reset} ${ansi.red}${event.title}${event.detail === undefined ? "" : ` — ${bounded(event.detail, 160)}`}${ansi.reset}`
            : formatNote(`${event.title}${event.detail === undefined ? "" : ` — ${event.detail}`}`);
        fx.print(line);
    }
}
function settleTurnUi(state, outcome, engineState, cancelled) {
    if (cancelled || engineState === "cancelled") {
        state.phase = "cancelled";
        state.quietDetail = "Run interrupted; send another message to resume this session";
    }
    else if (outcome.status === "completed") {
        state.phase = "completed";
        state.quietDetail = "Independent verification accepted the result";
        const main = state.agents.get("main");
        if (main !== undefined)
            main.status = "done";
    }
    else if (outcome.status === "waiting_for_user") {
        state.phase = "waiting";
        state.quietDetail = "Vanguard is waiting for your answer";
    }
    else if (outcome.status === "failed") {
        state.phase = "failed";
        state.quietDetail = state.error ?? "Run stopped before verified completion";
    }
    else {
        state.phase = "idle";
        state.quietDetail = "Ready for your next message";
        const main = state.agents.get("main");
        if (main !== undefined) {
            main.status = "idle";
            main.action = "ready";
        }
    }
}
function activeToolCount(state) {
    let count = 0;
    for (const starts of state.toolStartedAt.values())
        count += starts.length;
    return count;
}
const silentFx = {
    print: () => { },
    note: () => { },
    beginStream: () => { },
    writeStream: () => { },
    endStream: () => { },
    message: () => { },
};
export function inspectTuiLifecycleForTest(events, terminalOutcome) {
    const state = {
        phase: "thinking",
        startedAt: Date.now(),
        frame: 0,
        quietDetail: "Understanding your request",
        task: "test",
        inPlace: false,
        agents: new Map([["main", { id: "main", turn: 0, action: "listening", status: "active" }]]),
        chat: [],
        verifiers: new Map(),
        contracted: true,
        composer: "",
        composerCursor: 0,
        composerHistory: [],
        composerHistoryIndex: -1,
        conversationStreamed: "",
        streamHeld: "",
        streamLineOpen: false,
        toolStartedAt: new Map(),
        turnActive: true,
        toolsRun: 0,
        filesTouched: [],
        conversationMessages: [],
        thinkingTail: "",
        thinkingChars: 0,
        contextTokens: 0,
    };
    for (const event of events)
        consumeEvent(event, state, silentFx, () => 100);
    if (terminalOutcome !== undefined)
        settleTurnUi(state, terminalOutcome, "idle", false);
    return {
        phase: state.phase,
        activeTools: activeToolCount(state),
        action: state.agents.get("main")?.action ?? "",
        detail: state.quietDetail,
        contextTokens: state.contextTokens,
    };
}
export function renderTranscriptForTest(events, width = 100) {
    let output = "";
    const renderer = new InlineRenderer({ write: (text) => { output += text; return true; } }, () => width);
    const fx = createTranscriptFx(renderer, () => width);
    const state = {
        phase: "thinking",
        startedAt: Date.now() - 65_000,
        frame: 3,
        quietDetail: "Understanding your request",
        task: "Repair the project and prove it works.",
        inPlace: false,
        agents: new Map([["main", { id: "main", turn: 0, action: "listening", status: "active" }]]),
        chat: [{ agentId: "you", message: "Repair the project and prove it works." }],
        verifiers: new Map(),
        contracted: true,
        composer: "",
        composerCursor: 0,
        composerHistory: [],
        composerHistoryIndex: -1,
        conversationStreamed: "",
        streamHeld: "",
        streamLineOpen: false,
        toolStartedAt: new Map(),
        turnActive: true,
        toolsRun: 0,
        filesTouched: [],
        conversationMessages: [],
        thinkingTail: "",
        thinkingChars: 0,
        contextTokens: 0,
    };
    for (const event of events)
        consumeEvent(event, state, fx, () => width);
    return flattenInlineProtocol(output);
}
export function flattenInlineProtocol(output) {
    const rows = [""];
    let at = 0;
    while (at < output.length) {
        const erase = output.slice(at).match(/^(?:\x1b\[(\d+)A)?\r\x1b\[J/);
        if (erase !== null) {
            const up = erase[1] === undefined ? 0 : Number(erase[1]);
            rows.splice(Math.max(0, rows.length - 1 - up));
            rows.push("");
            at += erase[0].length;
            continue;
        }
        if (output[at] === "\n") {
            rows.push("");
            at += 1;
            continue;
        }
        rows[rows.length - 1] = `${rows[rows.length - 1] ?? ""}${output[at] ?? ""}`;
        at += 1;
    }
    return rows.join("\n");
}
export function renderFooterForTest(phase = "thinking", width = 100) {
    const config = {
        workspace: "C:\\projects\\preview",
        provider: "deepseek",
        auth: "api-key",
        verifyMode: "tests",
        detectedVerification: true,
        model: "deepseek-v4-pro",
        verification: { command: "npm", args: ["test"] },
        adaptiveVerification: false,
        maxSteps: 240,
        inPlace: false,
        direct: false,
    };
    const state = {
        phase,
        startedAt: Date.now() - 65_000,
        frame: 3,
        quietDetail: "check_project · trusted project verification",
        task: "Repair the project and prove it works.",
        inPlace: false,
        agents: new Map([["main", { id: "main", turn: 7, action: "check_project", status: "active" }]]),
        chat: [],
        verifiers: new Map([["workspace integrity", true]]),
        contracted: true,
        composer: "",
        composerCursor: 0,
        composerHistory: [],
        composerHistoryIndex: -1,
        conversationStreamed: "",
        streamHeld: "",
        streamLineOpen: false,
        toolStartedAt: phase === "tooling" ? new Map([["check_project", [Date.now() - 12_000]]]) : new Map(),
        turnActive: true,
        toolsRun: 12,
        filesTouched: ["src/main.ts"],
        conversationMessages: [],
        thinkingTail: "",
        thinkingChars: 0,
        contextTokens: 0,
    };
    return buildFooterLines(state, config, width);
}
function verificationSummary(config) {
    if (config.detectedVerification) {
        return `${config.verification.command} ${config.verification.args.join(" ")} ${ansi.dim}(this project's own)${ansi.reset}`;
    }
    return config.verifyMode === "build"
        ? `${ansi.amber}build${ansi.reset} ${ansi.dim}· tool evidence only, no test gate · /verify tests to change${ansi.reset}`
        : `${ansi.dim}tests · Vanguard must establish a build/test contract · /verify build to change${ansi.reset}`;
}
function loadCredential(provider) {
    const variable = credentialVariable(provider);
    const existing = process.env[variable]?.trim();
    if (existing !== undefined && existing.length > 0)
        return existing;
    if (provider === "ollama")
        return "";
    if (process.platform !== "win32")
        throw new Error(`${variable} is not set.`);
    const script = path.join(repositoryRoot(), "scripts", "export-credential.ps1");
    const result = spawnSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", script,
        "-Provider", provider,
        "-Root", repositoryRoot(),
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 1_000_000 });
    const credential = result.status === 0 ? result.stdout.trim() : "";
    if (credential.length === 0) {
        const detail = result.stderr.trim();
        throw new Error(`${variable} is not available.${detail.length === 0 ? "" : ` ${bounded(detail, 180)}`}`);
    }
    return credential;
}
function repositoryRoot() {
    return path.resolve(import.meta.dirname, "..", "..");
}
function configuredProvider() {
    const configured = process.env.VANGUARD_PROVIDER?.trim() ?? "";
    const provider = parseSelectableProvider(configured);
    if (provider === undefined)
        throw new Error("VANGUARD_PROVIDER must be deepseek, openai, anthropic, kimi, or ollama.");
    return provider;
}
function isExitRequest(input) {
    return /^(exit|quit|\/exit|\/quit)$/i.test(input.trim());
}
function configuredMaxSteps() {
    const configured = process.env.VANGUARD_MAX_STEPS?.trim();
    const maxSteps = configured === undefined || configured.length === 0 ? 240 : Number(configured);
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 2_000) {
        throw new Error("VANGUARD_MAX_STEPS must be a whole number from 1 to 2000.");
    }
    return maxSteps;
}
function automaticVerificationCommand(mode) {
    return { command: "node", args: [path.join(import.meta.dirname, "autoVerify.js"), "--mode", mode] };
}
function gradientText(text, from, to) {
    const steps = Math.max(1, text.length - 1);
    return [...text].map((character, index) => {
        const t = index / steps;
        const r = Math.round(from[0] + (to[0] - from[0]) * t);
        const g = Math.round(from[1] + (to[1] - from[1]) * t);
        const b = Math.round(from[2] + (to[2] - from[2]) * t);
        return `\x1b[38;2;${r};${g};${b}m${character}`;
    }).join("");
}
function fillRow(value, width) {
    return padAnsi(value, width);
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
