#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { logicalRunEvents } from "./kernel/logicalHistory.js";
import { nodePermissionFlag, resolveNodePackageManagerAlias } from "./runtime/nodePackageManager.js";
import { detectProjectVerification } from "./runtime/projectVerification.js";
import { SESSION_EXCLUDED_DIRECTORIES, TreeSnapshotCache, snapshotTree } from "./runtime/treeSnapshot.js";
import { isCleanGitRepository } from "./runtime/gitTree.js";
import { AdaptiveCommandVerifier, AgentKernel, CheckpointTool, CommandVerifier, adaptiveVerifyMode, isAdaptiveVerifyCommand, CreativeDirectionVerifier, RenderableArtifactVerifier, DeleteFileTool, FileJournal, HeadlessRenderTool, HttpModelAdapter, renderDoctorReport, runDoctor, CodeIntelTool, RepoMemoryStore, RepoMemoryTool, ScoutDelegateTool, ImageInspectionTool, JournalEvidenceResolver, GlobTool, ListFilesTool, ProcessTool, prewarmExecutionRuntime, ReadFileTool, ReplaceTextTool, ReviewChangesTool, RunCheckpointLedger, SearchTextTool, WorkspaceBoundary, WorkspaceIntegrityVerifier, WorkspaceMutationPolicy, WorkspaceVersionLedger, WriteFileTool, OAUTH_PROVIDER_LABELS, VANGUARD_PROVIDER_CONFIG_VERSION, createAnthropicModel, createCodingSession, createConfiguredProviderModel, isOAuthProvider, oauthLogin, oauthLogout, oauthStatus, vanguardHome, createDeepSeekModel, createOllamaModel, createSessionShell, materializeSessionWorkspace, analyzeTrajectory, analyzePatch, scoreExecutionQuality, classifyOutcome, contractCriterionIds, normalizeContract, openCodingSession, FixedCommandTool, PlanLedger, PlanTool, PostEditSyntaxChecker, PublicRunEventPresenter, RepositoryMapTool, StickyContextPolicy, SyntaxCheckTool, SyntaxCommandRunner, UsageLedger, extensionRuntimeState, resolveExtensions, ExtensionPermissionPolicy, FileExtensionAuditJournal, HookRunner, McpStdioClient, loadWorkspaceSkills, createStreamLifecyclePresenter, reviewSessionChanges, applyReviewedManifest, undoAppliedTransaction, createSessionCheckpoint, listSessionCheckpoints, latestDurableStateAnchor, restoreSessionCheckpoint, forkSessionCheckpoint, encodePublicRunEvent, resolveSecurityPolicy, DelegationCoordinator, CliDelegateRunner, TransactionalDelegateMerger, createDelegationTools, withSessionLease, } from "./index.js";
async function main() {
    const command = process.argv[2];
    if ((command === undefined || command === "tui") && process.stdin.isTTY && process.stdout.isTTY) {
        const { runTui } = await import("./tui.js");
        await runTui(process.cwd());
        return;
    }
    if (command === "--help" || command === "-h") {
        printUsage();
        return;
    }
    if (command === "login" || command === "logout" || command === "auth") {
        await authCommand(command, process.argv.slice(3));
        return;
    }
    if (command === "doctor") {
        const report = await runDoctor({
            workspaceRoot: process.cwd(),
            oauthConnected: async () => {
                const status = await oauthStatus("anthropic");
                return status.connected === true && status.expired !== true;
            },
        });
        process.stdout.write(`${renderDoctorReport(report)}\n`);
        process.exitCode = report.ready ? 0 : 1;
        return;
    }
    if (command === "advance") {
        await advanceCommand(process.argv.slice(3));
        return;
    }
    if (command === "serve") {
        if (process.argv[3] !== "--stdio") {
            throw new Error("Serve usage: vanguard serve --stdio [--create-store ABS_PATH]");
        }
        const values = parseArgumentMap(process.argv.slice(4));
        for (const key of values.keys()) {
            if (key !== "--create-store")
                throw new Error(`Unsupported serve option '${key}'.`);
        }
        const environmentStore = process.env.VANGUARD_CREATE_OPERATION_STORE;
        const createOperationStore = single(values, "--create-store")
            ?? (environmentStore === undefined || environmentStore.length === 0 ? undefined : environmentStore);
        if (createOperationStore !== undefined && (createOperationStore.length === 0 || !path.isAbsolute(createOperationStore))) {
            throw new Error("--create-store/VANGUARD_CREATE_OPERATION_STORE must be an absolute path.");
        }
        const { runStdioServer } = await import("./engine/stdioServer.js");
        await runStdioServer(createOperationStore === undefined ? {} : { createOperationStore });
        return;
    }
    if (command === "review" || command === "apply" || command === "undo") {
        await changeCommand(command, process.argv.slice(3));
        return;
    }
    if (command === "session") {
        await sessionCommand(process.argv.slice(3));
        return;
    }
    if (command !== "run" && command !== "resume") {
        printUsage();
        process.exitCode = 2;
        return;
    }
    await runCommand(command === "resume", process.argv.slice(3));
}
async function changeCommand(command, args) {
    const values = parseArgumentMap(args);
    const session = await openCodingSession(required(values, "--session"));
    if (session.direct === true) {
        throw new Error("This is a direct session: edits landed straight in the project with no baseline, so there is nothing to review, apply, or undo. Use version control (git diff, git checkout).");
    }
    if (session.inPlace === true && command !== "review") {
        throw new Error("This is an in-place session: changes are already live in the project, so apply/undo transactions do not exist. Use 'vanguard session restore' to roll back to a checkpoint.");
    }
    const container = path.dirname(session.metadataFile);
    const journal = await openSessionJournal(session, path.join(container, "run.jsonl"));
    if (command === "review") {
        process.stdout.write(`${JSON.stringify(await reviewSessionChanges(session, journal), null, 2)}\n`);
        return;
    }
    if (command === "apply") {
        const manifest = required(values, "--manifest");
        const confirmation = required(values, "--confirm");
        process.stdout.write(`${JSON.stringify(await applyReviewedManifest(session, journal, manifest, confirmation), null, 2)}\n`);
        return;
    }
    const transaction = required(values, "--apply");
    const confirmation = required(values, "--confirm");
    process.stdout.write(`${JSON.stringify(await undoAppliedTransaction(session, journal, transaction, confirmation), null, 2)}\n`);
}
async function sessionCommand(args) {
    const subcommand = args[0];
    if (subcommand === undefined)
        throw new Error("Session command requires checkpoint, list, restore, or fork.");
    const values = parseArgumentMap(args.slice(1));
    const session = await openCodingSession(required(values, "--session"));
    if (session.direct === true) {
        throw new Error("This is a direct session: it keeps no workspace baselines or checkpoints, so time travel does not exist. Use version control.");
    }
    const container = path.dirname(session.metadataFile);
    const journal = await openSessionJournal(session, path.join(container, "run.jsonl"));
    if (subcommand === "checkpoint") {
        const result = await createSessionCheckpoint(session, journal, single(values, "--label"));
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    if (subcommand === "list") {
        process.stdout.write(`${JSON.stringify({ sessionId: session.id, checkpoints: await listSessionCheckpoints(session) }, null, 2)}\n`);
        return;
    }
    if (subcommand === "restore") {
        const checkpoint = required(values, "--checkpoint");
        const result = await restoreSessionCheckpoint(session, journal, checkpoint, required(values, "--confirm"));
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    if (subcommand === "fork") {
        const result = await forkSessionCheckpoint(session, journal, required(values, "--checkpoint"));
        process.stdout.write(`${JSON.stringify({
            checkpointId: result.checkpointId,
            parentSessionId: result.parentSessionId,
            parentJournalHash: result.parentJournalHash,
            sessionId: result.session.id,
            sessionRoot: path.dirname(result.session.metadataFile),
            workspaceRoot: result.session.workspaceRoot,
            journalFile: result.journalFile,
        }, null, 2)}\n`);
        return;
    }
    throw new Error(`Unknown session command '${subcommand}'.`);
}
function openSessionJournal(session, file) {
    return FileJournal.open(file, {
        ...(session.journalGenesisHash === undefined ? {} : { genesisHash: session.journalGenesisHash }),
    });
}
async function runCommand(resuming, args) {
    const opened = resuming
        ? await openCodingSession(parseResumeSession(args))
        : await createCodingSession(requiredArgument(args, "--workspace"), await sessionModeFor(args, requiredArgument(args, "--workspace")));
    const container = path.dirname(opened.metadataFile);
    await withSessionLease(container, resuming ? "run.resume" : "run.start", async () => {
        const session = resuming ? await openCodingSession(container) : opened;
        const configurationFile = path.join(container, "run-config.json");
        const options = resuming
            ? await readRunConfiguration(configurationFile)
            : await parseOptions(args);
        if (resuming && options.task.length === 0) {
            await advanceSessionUnlocked(session, options, undefined);
            return;
        }
        if (!resuming) {
            await writeFile(configurationFile, JSON.stringify({ version: 1, options }, null, 2));
        }
        const journalFile = path.join(container, "run.jsonl");
        const scorecardFile = path.join(container, "scorecard.json");
        const fileJournal = await openSessionJournal(session, journalFile);
        emitSessionReady(session, container, journalFile, scorecardFile, resuming);
        const priorEvents = resuming ? await fileJournal.readValidated() : [];
        const runtime = await buildExecutionRuntime(session, options, fileJournal, false);
        const startedAt = Date.now();
        const runtimeTask = `${options.task}\n\nVanguard runtime mutation policy: ${runtime.mutationPolicyDescription}${runtime.taskAugmentation ?? ""}`;
        try {
            const outcome = await runWithBudgets(options, runtime.journalActivity, new AbortController(), (signal) => runtime.kernel.run(runtimeTask, signal, priorEvents));
            await writeScorecard({
                session, options, outcome, fileJournal, scorecardFile, journalFile, configurationFile,
                startedAt, resumed: resuming, usage: runtime.usage,
                delegation: runtime.delegationSnapshot?.(),
            });
            if (outcome.status !== "completed")
                process.exitCode = 1;
        }
        finally {
            await runtime.dispose?.();
        }
    });
}
async function advanceCommand(args) {
    const values = parseArgumentMap(args);
    const sessionPath = single(values, "--session");
    const message = single(values, "--message");
    if (sessionPath === undefined) {
        const workspace = required(values, "--workspace");
        const session = await createSessionShell(workspace, await sessionModeFor(args, workspace));
        const container = path.dirname(session.metadataFile);
        await withSessionLease(container, "advance", async () => {
            const options = await parseOptions(args, { requireTask: false });
            await writeFile(path.join(container, "run-config.json"), JSON.stringify({ version: 1, options }, null, 2));
            await advanceSessionUnlocked(session, options, message);
        });
        return;
    }
    const opened = await openCodingSession(sessionPath);
    const container = path.dirname(opened.metadataFile);
    await withSessionLease(container, "advance", async () => {
        const session = await openCodingSession(container);
        const options = await readRunConfiguration(path.join(container, "run-config.json"));
        await advanceSessionUnlocked(session, options, message);
    });
}
async function advanceSessionUnlocked(session, options, message) {
    const container = path.dirname(session.metadataFile);
    const journalFile = path.join(container, "run.jsonl");
    const scorecardFile = path.join(container, "scorecard.json");
    const configurationFile = path.join(container, "run-config.json");
    const fileJournal = await openSessionJournal(session, journalFile);
    emitSessionReady(session, container, journalFile, scorecardFile, session.materialized);
    let priorEvents = await fileJournal.readValidated();
    const startedAt = Date.now();
    let contracted = priorEvents.some((event) => event.type === "run.contracted" || event.type === "run.started");
    let pendingMessage = message;
    const controller = new AbortController();
    const userChannel = process.env.VANGUARD_CONTROL_STREAM === "1"
        ? new StdinUserChannel(() => controller.abort())
        : undefined;
    let disposeRuntime;
    try {
        if (!contracted) {
            const conversation = buildConversationRuntime(session, options, fileJournal, userChannel);
            const outcome = await runWithBudgets(options, conversation.journalActivity, controller, (signal) => conversation.kernel.advance(pendingMessage === undefined ? {} : { userMessage: pendingMessage }, signal, priorEvents));
            pendingMessage = undefined;
            if (outcome.status !== "contracted") {
                printAdvanceOutcome(outcome, session, container, journalFile);
                if (outcome.status === "failed")
                    process.exitCode = 1;
                return;
            }
            priorEvents = await fileJournal.readValidated();
            contracted = true;
        }
        if (!session.materialized) {
            streamPublicEvent({
                type: "session.mode",
                agentId: "main",
                status: "info",
                title: "Preparing workspace",
                detail: session.direct === true
                    ? "Direct session — nothing to copy"
                    : "Fingerprinting and copying the project (large or cloud-synced folders take longer; direct mode skips this)",
            });
            session = await materializeSessionWorkspace(session);
            if (session.inPlace === true) {
                process.stderr.write(session.direct === true
                    ? `[Vanguard] DIRECT MODE: edits write straight to ${session.workspaceRoot}. No baseline is kept; use version control.\n`
                    : `[Vanguard] IN-PLACE MODE: edits write directly to ${session.workspaceRoot}. A pristine baseline was captured for review and checkpoint rollback.\n`);
                streamPublicEvent({
                    type: "session.mode",
                    agentId: "main",
                    status: "info",
                    title: session.direct === true ? "Direct mode" : "In-place mode",
                    detail: `Edits write directly to ${session.workspaceRoot}`,
                });
            }
            emitSessionReady(session, container, journalFile, scorecardFile, true);
            if (session.sourceChangedDuringConversation === true) {
                process.stderr.write("[Vanguard] The original project changed during the conversation; the workspace copy uses the current state. Stale-content preconditions will force fresh reads before any edit.\n");
                streamPublicEvent({
                    type: "source.changed",
                    agentId: "main",
                    status: "info",
                    title: "Original project changed during conversation",
                    detail: "The workspace copy uses the current state",
                });
            }
        }
        const runtime = await buildExecutionRuntime(session, options, fileJournal, true, userChannel);
        disposeRuntime = runtime.dispose;
        const outcome = await runWithBudgets(options, runtime.journalActivity, controller, (signal) => runtime.kernel.advance(pendingMessage === undefined ? {} : { userMessage: pendingMessage }, signal, priorEvents));
        if (outcome.status === "completed" || outcome.status === "failed") {
            await writeScorecard({
                session, options, outcome, fileJournal, scorecardFile, journalFile, configurationFile,
                startedAt, resumed: true, usage: runtime.usage,
                delegation: runtime.delegationSnapshot?.(),
            });
        }
        else {
            printAdvanceOutcome(outcome, session, container, journalFile);
        }
        if (outcome.status === "failed")
            process.exitCode = 1;
    }
    finally {
        await disposeRuntime?.();
        userChannel?.close();
    }
}
function combinedObserver(presenter, usage) {
    const ledger = usage.observer();
    return {
        started: (attempt) => presenter.started?.(attempt),
        delta: (text) => presenter.delta(text),
        thinking: (text) => presenter.thinking?.(text),
        reset: () => presenter.reset?.(),
        committed: () => presenter.committed?.(),
        failed: (reason) => presenter.failed?.(reason),
        usage: (value) => {
            ledger.usage?.(value);
            presenter.usage?.(value);
        },
    };
}
function buildConversationRuntime(session, options, fileJournal, userChannel) {
    const source = new WorkspaceBoundary(session.sourceRoot);
    const versions = new WorkspaceVersionLedger();
    const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
    const { journal, journalActivity, markActivity } = instrumentJournal(fileJournal);
    const conversationTools = [
        new ListFilesTool(source),
        new SearchTextTool(source),
        new GlobTool(source),
        new ReadFileTool(source, 1_000_000, versions),
        new RepositoryMapTool(source, { includeInstructions: !options.disableExtensions }),
        new HeadlessRenderTool(source),
        new ImageInspectionTool(source),
        new CodeIntelTool(source),
    ];
    const kernel = new AgentKernel({
        model: createModel(options, createStreamPresenter(markActivity)),
        tools: [
            ...conversationTools,
            new ScoutDelegateTool(createModel(options), conversationTools),
        ],
        verifiers: [],
        journal,
        ...(options.extensions === undefined ? {} : { workingState: { snapshot: () => ({ extensions: options.extensions }) } }),
        taskAddendum: taskAddendum(options, mutationPolicy),
        ...(userChannel === undefined ? {} : { userChannel }),
        options: {
            maxSteps: options.maxSteps,
            maxContextBytes: options.maxContextBytes,
            maxRepeatedAction: 3,
            interactive: true,
        },
    });
    return { kernel, mutationPolicyDescription: mutationPolicy.describe(), journalActivity };
}
function commandApprover(userChannel) {
    return async (request, signal) => {
        const line = [request.command, ...request.args].join(" ");
        const ask = (title) => {
            streamPublicEvent({
                type: "approval.requested",
                agentId: "main",
                status: "info",
                title,
                detail: line,
                message: line,
            });
        };
        ask("Approval needed");
        userChannel.drain();
        for (;;) {
            const answer = await userChannel.wait(signal);
            if (answer === undefined)
                return "deny";
            const decision = parseApproval(answer);
            if (decision !== undefined)
                return decision;
            ask("Approval needed — answer 1, 2, or 3");
        }
    };
}
function parseApproval(answer) {
    const value = answer.trim().toLowerCase();
    if (value === "1" || value === "y" || value === "yes" || value === "once")
        return "once";
    if (value === "2" || value === "a" || value === "always")
        return "always";
    if (value === "3" || value === "n" || value === "no" || value === "deny")
        return "deny";
    return undefined;
}
async function buildExecutionRuntime(session, options, fileJournal, interactive, userChannel) {
    const container = path.dirname(session.metadataFile);
    const workspace = new WorkspaceBoundary(session.workspaceRoot);
    const versions = new WorkspaceVersionLedger();
    const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
    const commandTimeoutMs = Math.min(options.commandTimeoutMs, options.maxDurationMs);
    const idleOption = options.commandIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: Math.min(options.commandIdleTimeoutMs, commandTimeoutMs) };
    const agentAllowedCommands = options.restrictProcess
        ? [...new Set(["node", ...options.allowedCommands])]
        : [...new Set(["node", "npm", "npx", "git", options.verification.command, ...options.allowedCommands])];
    const processTool = new ProcessTool(workspace, {
        allowedCommands: agentAllowedCommands,
        ...(userChannel === undefined ? {} : { requestApproval: commandApprover(userChannel) }),
        commandAliases: commandAliases(session.workspaceRoot, options.restrictProcess, mutationPolicy.writableAbsoluteRoots(session.workspaceRoot)),
        deniedArgumentPrefixes: options.restrictProcess ? ["--allow-", "--no-permission", "--no-experimental-permission"] : [],
        deniedArgumentSubstrings: options.restrictProcess ? ["console.assert"] : [],
        timeoutMs: commandTimeoutMs,
        ...idleOption,
        maxOutputBytes: 2_000_000,
    });
    const verifierProcessTool = new ProcessTool(workspace, {
        allowedCommands: [options.verification.command],
        commandAliases: commandAliases(session.workspaceRoot, false, []),
        timeoutMs: commandTimeoutMs,
        ...idleOption,
        maxOutputBytes: 2_000_000,
    });
    const publicCheckTool = options.publicCheck === undefined ? undefined : new FixedCommandTool("check_project", "Run the project's trusted public compile and test command with its fixed arguments.", new ProcessTool(workspace, {
        allowedCommands: [options.publicCheck.command],
        commandAliases: commandAliases(session.workspaceRoot, false, []),
        timeoutMs: commandTimeoutMs,
        ...idleOption,
        maxOutputBytes: 2_000_000,
    }), options.publicCheck);
    const verifiers = [
        isAdaptiveVerifyCommand(options.verification)
            ? new AdaptiveCommandVerifier("adaptive verification", session.workspaceRoot, adaptiveVerifyMode(options.verification))
            : new CommandVerifier("required command", verifierProcessTool, options.verification, options.verifierEvidence),
    ];
    if (options.protectedPaths.length > 0 || options.editableRoots.length > 0) {
        verifiers.push(new WorkspaceIntegrityVerifier({
            sourceRoot: session.sourceRoot,
            workspaceRoot: session.workspaceRoot,
            protectedPaths: options.protectedPaths,
            editableRoots: options.editableRoots,
        }));
    }
    const extensionCloseables = [];
    const extensionTools = [];
    let hookRunner;
    let skillsAddendum = "";
    if (options.disableExtensions !== true) {
        const resolved = await resolveExtensions({ workspaceRoot: session.sourceRoot });
        const policy = new ExtensionPermissionPolicy(resolved.config.permissions);
        const needsAudit = resolved.config.mcp.length > 0 || resolved.config.hooks.length > 0;
        const audit = needsAudit
            ? await FileExtensionAuditJournal.open(path.join(container, "extension-audit.jsonl"))
            : undefined;
        for (const server of resolved.config.mcp) {
            const client = await McpStdioClient.connect(workspace, server, policy, audit);
            extensionTools.push(...client.tools());
            extensionCloseables.push(() => client.close());
        }
        if (resolved.config.hooks.length > 0) {
            hookRunner = new HookRunner(workspace, policy, resolved.config.hooks, audit);
        }
        const sourceBoundary = new WorkspaceBoundary(session.sourceRoot);
        const skillRoots = [];
        for (const root of resolved.config.skills.roots) {
            try {
                await sourceBoundary.existing(root);
                skillRoots.push(root);
            }
            catch {
            }
        }
        if (skillRoots.length > 0) {
            const skills = await loadWorkspaceSkills(sourceBoundary, { ...resolved.config.skills, roots: skillRoots });
            if (skills.length > 0) {
                skillsAddendum = "\n\nAvailable workspace skills (apply when relevant to the task):"
                    + skills.map((skill) => `\n### Skill: ${skill.metadata.name} — ${skill.metadata.description}\n${skill.instructions.trim()}`).join("");
            }
        }
    }
    const hasToolHooks = hookRunner !== undefined;
    const withToolHooks = (tool) => !hasToolHooks ? tool : {
        name: tool.name,
        definition: tool.definition,
        execute: async (input, context) => {
            await hookRunner.run("before-tool", context.signal);
            const result = await tool.execute(input, context);
            await hookRunner.run("after-tool", context.signal);
            return result;
        },
    };
    if (hookRunner !== undefined) {
        await hookRunner.run("before-run", new AbortController().signal);
    }
    const { journal, journalActivity, markActivity } = instrumentJournal(fileJournal);
    const priorEvents = await fileJournal.readValidated();
    const logicalPriorEvents = logicalRunEvents(priorEvents);
    const checkpointAnchor = latestDurableStateAnchor(logicalPriorEvents, "run.checkpoint");
    const checkpoint = await RunCheckpointLedger.open(path.join(container, "checkpoint.json"), {
        required: true,
        ...(checkpointAnchor === undefined ? {} : { expectedSha256: checkpointAnchor.sha256 }),
    });
    const contractedEvent = [...logicalPriorEvents].reverse().find((event) => event.type === "run.contracted");
    const contractedData = contractedEvent?.data;
    const contract = contractedData !== null && contractedData !== undefined
        && typeof contractedData === "object" && !Array.isArray(contractedData)
        ? normalizeContract(contractedData.contract)
        : undefined;
    const runtimeStartedAtMs = Date.now();
    const renderScanScope = () => ({ touchedPaths: versions.paths(), modifiedSinceMs: runtimeStartedAtMs });
    const completionRender = new HeadlessRenderTool(workspace);
    prewarmExecutionRuntime({ workspaceRoot: session.workspaceRoot, renderTool: completionRender });
    verifiers.push(new RenderableArtifactVerifier(workspace, contract, (relativePath, renderContext) => completionRender.execute({ path: relativePath }, renderContext), renderScanScope));
    if (contract?.creativeDirection !== undefined) {
        verifiers.push(new CreativeDirectionVerifier(createModel(options), workspace, contract, (relativePath, judgeContext) => completionRender.execute({ path: relativePath }, judgeContext), renderScanScope));
    }
    const evidenceResolver = new JournalEvidenceResolver(fileJournal);
    const plan = await PlanLedger.open(path.join(container, "plan.json"), contract === undefined ? [] : contractCriterionIds(contract), evidenceResolver, {
        required: true,
        ...(latestDurableStateAnchor(logicalPriorEvents, "update_plan") === undefined
            ? {}
            : { expectedSha256: latestDurableStateAnchor(logicalPriorEvents, "update_plan").sha256 }),
    });
    const usage = new UsageLedger(options.model);
    const delegationDepth = boundedEnvironmentInteger("VANGUARD_DELEGATION_DEPTH", 0, 0, 16);
    const delegationMaxDepth = boundedEnvironmentInteger("VANGUARD_DELEGATION_MAX_DEPTH", 1, 0, 4);
    const delegation = await DelegationCoordinator.open({
        storeFile: path.join(container, "delegations.json"),
        parentWorkspace: session.workspaceRoot,
        runner: new CliDelegateRunner({
            provider: options.provider,
            model: options.model,
            ...(options.auth === undefined ? {} : { auth: options.auth }),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
            ...(options.credentialVariable === undefined ? {} : { credentialVariable: options.credentialVariable }),
            verification: options.verification,
            ...(options.publicCheck === undefined ? {} : { publicCheck: options.publicCheck }),
            protectedPaths: options.protectedPaths,
            maxDurationMs: Math.min(options.maxDurationMs, 30 * 60 * 1_000),
            commandTimeoutMs,
            maxContextBytes: options.maxContextBytes,
            maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
            disableExtensions: options.disableExtensions,
        }),
        merger: new TransactionalDelegateMerger(session.workspaceRoot),
        depth: delegationDepth,
        maxDepth: delegationMaxDepth,
        maxConcurrent: boundedEnvironmentInteger("VANGUARD_DELEGATION_CONCURRENCY", 2, 1, 8),
        maxChildren: boundedEnvironmentInteger("VANGUARD_DELEGATION_MAX_CHILDREN", 6, 1, 16),
        maxChildSteps: Math.min(options.maxSteps, 80),
        maxTotalSteps: Math.max(Math.min(options.maxSteps * 2, 240), Math.min(options.maxSteps, 80)),
        onEvent: streamPublicEvent,
    });
    const delegationTools = delegationDepth < delegationMaxDepth && options.publicCheck !== undefined
        && options.agentProfile === "coder"
        ? createDelegationTools(delegation)
        : [];
    const workingState = {
        snapshot: () => ({
            checkpoint: checkpoint.snapshot(),
            plan: plan.snapshot(),
            delegations: JSON.parse(JSON.stringify(delegation.snapshot())),
            ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
        }),
    };
    const observer = interactive
        ? combinedObserver(createStreamPresenter(markActivity), usage)
        : { delta: () => { }, usage: (value) => usage.record(value) };
    const repoMemory = new RepoMemoryStore(session.sourceRoot);
    const memoryAddendum = await repoMemory.addendum();
    const executionObserveTools = [
        new ListFilesTool(workspace),
        new SearchTextTool(workspace),
        new GlobTool(workspace),
        new ReadFileTool(workspace, 1_000_000, versions),
        new RepositoryMapTool(workspace, { includeInstructions: !options.disableExtensions }),
        new CodeIntelTool(workspace),
    ];
    const postMutationSyntaxChecker = new PostEditSyntaxChecker(new SyntaxCommandRunner(), workspace);
    const profileTools = options.agentProfile === "coder" ? [
        new RepoMemoryTool(repoMemory),
        new WriteFileTool(workspace, versions, mutationPolicy),
        new ReplaceTextTool(workspace, versions, mutationPolicy),
        new DeleteFileTool(workspace, versions, mutationPolicy),
        ...(session.direct === true ? [] : [new ReviewChangesTool(session.pristineRoot ?? session.sourceRoot, session.workspaceRoot)]),
        new HeadlessRenderTool(workspace),
        new ImageInspectionTool(workspace),
        new SyntaxCheckTool(postMutationSyntaxChecker),
        new CheckpointTool(checkpoint),
        new PlanTool(plan, evidenceResolver),
        ...delegationTools,
        ...(publicCheckTool === undefined ? [] : [publicCheckTool]),
        ...(options.exposeRawProcess ? [processTool] : []),
        ...extensionTools,
    ] : [];
    const kernel = new AgentKernel({
        model: createModel(options, observer),
        contextPolicy: new StickyContextPolicy(),
        tools: [
            new ListFilesTool(workspace),
            new SearchTextTool(workspace),
            new GlobTool(workspace),
            new ReadFileTool(workspace, 1_000_000, versions),
            new ScoutDelegateTool(createModel(options), executionObserveTools),
            new CodeIntelTool(workspace),
            new RepositoryMapTool(workspace, { includeInstructions: !options.disableExtensions }),
            ...profileTools,
        ].map(withToolHooks),
        verifiers,
        journal,
        workingState,
        ...(session.direct === true ? {} : {
            workspaceState: {
                fingerprint: (() => {
                    const fingerprintCache = new TreeSnapshotCache();
                    return async () => (await snapshotTree(session.workspaceRoot, {
                        excludedDirectories: SESSION_EXCLUDED_DIRECTORIES,
                        cache: fingerprintCache,
                    })).rootHash;
                })(),
            },
        }),
        postMutationSyntaxCheck: async (relativePath) => {
            const result = await postMutationSyntaxChecker.check(relativePath);
            return { ok: result.ok, output: result };
        },
        plan,
        completionGates: [{ blockers: () => delegation.completionBlockers() }],
        taskAddendum: `${taskAddendum(options, mutationPolicy)}${options.agentProfile === "coder" ? "" : `\n\nThis is a runtime-enforced ${options.agentProfile} subagent. Only read-only workspace tools are available; return analysis, do not attempt edits.`}${session.direct === true
            ? "\n\nThis is a direct session: you are editing the real project with no isolated copy and no baseline, and no review_changes review tool exists. Rely on targeted reads, version control, and executable checks for confidence."
            : ""}${memoryAddendum}${skillsAddendum}`,
        ...(userChannel === undefined ? {} : { userChannel }),
        options: {
            maxSteps: options.maxSteps,
            maxContextBytes: options.maxContextBytes,
            maxRepeatedAction: 3,
            maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
            interactive,
            ...(options.executionEvidence === undefined ? {} : { executionEvidence: options.executionEvidence }),
        },
    });
    return {
        kernel,
        mutationPolicyDescription: mutationPolicy.describe(),
        ...(skillsAddendum.length === 0 ? {} : { taskAugmentation: skillsAddendum }),
        journalActivity,
        usage,
        delegationSnapshot: () => JSON.parse(JSON.stringify(delegation.snapshot())),
        dispose: async () => {
            if (hookRunner !== undefined) {
                await hookRunner.run("after-run", new AbortController().signal).catch(() => { });
            }
            for (const close of extensionCloseables)
                await close().catch(() => { });
            await delegation.close();
        },
    };
}
function taskAddendum(options, mutationPolicy) {
    const adaptive = options.adaptiveVerification === true
        ? "\nVanguard expert-mode contract: own the implementation end to end. This project did not have a recognized verification contract at launch. Establish an appropriate deterministic build/test contract as part of the work, use check_project throughout, and finish only when the automatic trusted verifier passes."
        : "";
    const instructions = options.extensionInstructions === undefined || options.extensionInstructions.length === 0
        ? ""
        : `\n\nResolved project instructions (with recorded provenance):\n${options.extensionInstructions}`;
    return `Vanguard runtime mutation policy: ${mutationPolicy.describe()}${adaptive}${instructions}`;
}
async function runWithBudgets(options, journalActivity, controller, run) {
    const durationTimer = setTimeout(() => controller.abort(), options.maxDurationMs);
    const heartbeatTimer = setInterval(() => {
        const quietMs = Date.now() - journalActivity();
        if (quietMs >= 45_000) {
            process.stderr.write(`[Vanguard] working: provider or tool response pending (${formatDuration(quietMs)} since last event)\n`);
        }
    }, 45_000);
    heartbeatTimer.unref();
    return run(controller.signal).finally(() => {
        clearTimeout(durationTimer);
        clearInterval(heartbeatTimer);
    });
}
async function writeScorecard(context) {
    const { session, options, outcome } = context;
    const events = await context.fileJournal.readValidated();
    const trajectory = analyzeTrajectory(events);
    const contracted = events.find((event) => event.type === "run.contracted")?.data;
    const contractedTask = contracted !== null && typeof contracted === "object" && !Array.isArray(contracted)
        && typeof contracted.task === "string" ? contracted.task : undefined;
    const task = options.task.length > 0 ? options.task : contractedTask ?? "";
    const patch = session.materialized
        ? await analyzePatch(session.sourceRoot, session.workspaceRoot)
        : emptyPatchMetrics();
    const verified = outcome.status === "completed";
    const classification = classifyOutcome(outcome);
    const executionQuality = scoreExecutionQuality(verified, trajectory, patch);
    const scorecard = {
        version: 3,
        sessionId: session.id,
        sourceRoot: session.sourceRoot,
        workspaceRoot: session.workspaceRoot,
        provider: options.provider,
        model: options.model,
        task,
        verification: options.verification,
        outcome,
        trajectory,
        patch,
        grade: {
            verified,
            classification,
            score: classification === "infrastructure_error" ? null : verified ? 1 : 0,
            executionQuality,
            steps: outcome.steps,
        },
        usage: context.usage?.usage() ?? null,
        estimatedCost: context.usage?.estimatedCost() ?? null,
        latency: context.usage?.latencyMs() ?? null,
        cacheEfficiency: context.usage?.cacheEfficiency() ?? null,
        durationMs: Date.now() - context.startedAt,
        journalFile: context.journalFile,
        completedAt: new Date().toISOString(),
        resumed: context.resumed,
        sessionFile: session.metadataFile,
        configurationFile: context.configurationFile,
        extensions: options.extensions ?? null,
        delegation: context.delegation ?? null,
    };
    await writeFile(context.scorecardFile, JSON.stringify(scorecard, null, 2));
    process.stdout.write(`${JSON.stringify({ ...scorecard, scorecardFile: context.scorecardFile }, null, 2)}\n`);
}
function emptyPatchMetrics() {
    return {
        changedFiles: [],
        filesAdded: 0,
        filesDeleted: 0,
        filesModified: 0,
        beforeBytes: 0,
        afterBytes: 0,
        beforeLines: 0,
        afterLines: 0,
    };
}
function printAdvanceOutcome(outcome, session, container, journalFile) {
    process.stdout.write(`${JSON.stringify({
        outcome,
        sessionId: session.id,
        sessionRoot: container,
        workspaceRoot: session.workspaceRoot,
        journalFile,
    }, null, 2)}\n`);
}
function emitSessionReady(session, container, journalFile, scorecardFile, resumed) {
    streamPublicEvent({
        type: "session.ready",
        agentId: "main",
        status: "info",
        title: resumed ? "Session resumed" : "Session created",
        sessionId: session.id,
        sessionRoot: container,
        workspaceRoot: session.workspaceRoot,
        journalFile,
        scorecardFile,
        materialized: session.materialized,
    });
}
async function authCommand(command, argv) {
    const target = argv[0];
    if (target !== undefined && !isOAuthProvider(target)) {
        throw new Error(`Unknown OAuth provider '${target}'. Use anthropic, openai, or kimi.`);
    }
    const providers = target === undefined ? ["anthropic", "openai", "kimi"] : [target];
    if (command === "auth") {
        for (const provider of providers) {
            const status = await oauthStatus(provider);
            const detail = !status.connected
                ? "not signed in"
                : `${status.account ?? "signed in"}${status.plan === undefined ? "" : ` · plan: ${status.plan}`}`
                    + `${status.expired === true ? " (token expired; refreshes on next request)" : ""}`;
            process.stdout.write(`${provider.padEnd(10)} ${detail}\n`);
        }
        process.stdout.write(`\nTokens: ${vanguardHome()}\n`);
        return;
    }
    if (command === "logout") {
        for (const provider of providers) {
            await oauthLogout(provider);
            process.stdout.write(`Signed out of ${OAUTH_PROVIDER_LABELS[provider]}.\n`);
        }
        return;
    }
    if (target === undefined)
        throw new Error("Login usage: vanguard login anthropic|openai|kimi");
    const provider = providers[0];
    process.stderr.write(`Opening your browser to sign in to ${OAUTH_PROVIDER_LABELS[provider]}…\n`);
    const status = await oauthLogin(provider, {
        force: true,
        onAuthorizeUrl: (url) => process.stderr.write(`If it does not open, visit:\n${url}\n\n`),
    });
    process.stdout.write(`Signed in to ${OAUTH_PROVIDER_LABELS[provider]}${status.account === undefined ? "" : ` as ${status.account}`}.\n`);
}
function configuredReasoningEffort(options) {
    const value = options.reasoningEffort ?? process.env.VANGUARD_REASONING_EFFORT ?? "medium";
    if (value !== "low" && value !== "medium" && value !== "high" && value !== "max") {
        throw new Error("Reasoning effort must be low, medium, high, or max.");
    }
    return value;
}
function openaiReasoningEffort(options) {
    const value = configuredReasoningEffort(options);
    return value === "max" ? "high" : value;
}
function kimiReasoning(options) {
    return { thinking: "enabled", effort: configuredReasoningEffort(options) };
}
function createModel(options, streamObserver) {
    const common = {
        model: options.model,
        timeoutMs: 600_000,
        maxAttempts: 4,
        ...(streamObserver === undefined ? {} : { streamObserver }),
    };
    if (options.auth === "oauth") {
        if (options.provider !== "openai" && options.provider !== "anthropic" && options.provider !== "kimi") {
            throw new Error("--auth oauth is available only for the openai, anthropic, and kimi providers.");
        }
        return createConfiguredProviderModel({
            version: VANGUARD_PROVIDER_CONFIG_VERSION,
            provider: options.provider,
            model: options.model,
            credential: { source: "oauth", provider: options.provider },
            ...(options.provider === "anthropic" ? { apiVersion: "2023-06-01" } : {}),
            ...(options.provider === "kimi" ? { reasoning: kimiReasoning(options) } : {}),
            ...(options.provider === "openai" ? { reasoning: { effort: openaiReasoningEffort(options) } } : {}),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }, common);
    }
    if (options.credentialVariable !== undefined && options.provider !== "http") {
        return createConfiguredProviderModel({
            version: VANGUARD_PROVIDER_CONFIG_VERSION,
            provider: options.provider,
            model: options.model,
            credential: { source: "environment", variable: options.credentialVariable },
            ...(options.provider === "openai-compatible" ? { wire: "openai-chat-completions" } : {}),
            ...(options.provider === "anthropic" ? { apiVersion: "2023-06-01" } : {}),
            ...(options.provider === "kimi" ? { reasoning: kimiReasoning(options) } : {}),
            ...(options.provider === "openai" ? { reasoning: { effort: openaiReasoningEffort(options) } } : {}),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }, common);
    }
    if (options.provider === "openai")
        return createConfiguredProviderModel({
            version: VANGUARD_PROVIDER_CONFIG_VERSION,
            provider: "openai",
            model: options.model,
            reasoning: { effort: openaiReasoningEffort(options) },
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }, common);
    if (options.provider === "anthropic")
        return createAnthropicModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
    if (options.provider === "deepseek")
        return createDeepSeekModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
    if (options.provider === "kimi")
        return createConfiguredProviderModel({
            version: VANGUARD_PROVIDER_CONFIG_VERSION,
            provider: "kimi",
            model: options.model,
            reasoning: kimiReasoning(options),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }, common);
    if (options.provider === "ollama")
        return createOllamaModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
    if (options.provider === "openai-compatible") {
        throw new Error("--credential-variable is required for the openai-compatible provider.");
    }
    if (options.endpoint === undefined)
        throw new Error("--endpoint is required for the http provider.");
    return new HttpModelAdapter({ endpoint: options.endpoint, timeoutMs: common.timeoutMs, maxAttempts: common.maxAttempts });
}
class StdinUserChannel {
    #queue = [];
    #waiters = [];
    #reader;
    #closed = false;
    constructor(onCancel) {
        const reader = createInterface({ input: process.stdin });
        this.#reader = reader;
        reader.on("line", (line) => {
            const trimmed = line.trim();
            if (trimmed.length === 0)
                return;
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed.type === "user_message" && typeof parsed.text === "string" && parsed.text.length > 0) {
                    const waiter = this.#waiters.shift();
                    if (waiter !== undefined)
                        waiter(parsed.text);
                    else
                        this.#queue.push(parsed.text);
                }
                else if (parsed.type === "cancel") {
                    onCancel();
                }
            }
            catch {
            }
        });
        reader.on("close", () => {
            this.#closed = true;
            for (const waiter of this.#waiters.splice(0))
                waiter(undefined);
        });
    }
    close() {
        this.#closed = true;
        this.#reader.close();
        process.stdin.pause();
        process.stdin.unref?.();
        for (const waiter of this.#waiters.splice(0))
            waiter(undefined);
    }
    drain() {
        return this.#queue.splice(0);
    }
    wait(signal) {
        const queued = this.#queue.shift();
        if (queued !== undefined)
            return Promise.resolve(queued);
        if (this.#closed || signal.aborted)
            return Promise.resolve(undefined);
        return new Promise((resolve) => {
            const waiter = (message) => {
                signal.removeEventListener("abort", onAbort);
                resolve(message);
            };
            const onAbort = () => {
                const index = this.#waiters.indexOf(waiter);
                if (index >= 0)
                    this.#waiters.splice(index, 1);
                resolve(undefined);
            };
            this.#waiters.push(waiter);
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }
}
function createStreamPresenter(markActivity) {
    return createStreamLifecyclePresenter(streamPublicEvent, markActivity);
}
function parseArgumentMap(args) {
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (key === undefined || !key.startsWith("--") || value === undefined) {
            throw new Error(`Invalid argument near '${key ?? "end of command"}'. Options require --name value pairs.`);
        }
        const existing = values.get(key) ?? [];
        existing.push(value);
        values.set(key, existing);
    }
    return values;
}
async function parseOptions(args, behavior = {}) {
    const requireTask = behavior.requireTask !== false;
    const values = parseArgumentMap(args);
    const workspace = required(values, "--workspace");
    const disableExtensionsRaw = single(values, "--disable-extensions");
    const disableExtensions = disableExtensionsRaw === undefined
        ? false
        : parseBoolean(disableExtensionsRaw, "--disable-extensions");
    const resolvedExtensions = await resolveExtensions({
        workspaceRoot: workspace,
        disableExtensions,
    });
    const task = await resolveTaskInput(values, requireTask);
    const provider = required(values, "--provider");
    if (provider !== "openai" && provider !== "anthropic" && provider !== "deepseek" && provider !== "kimi" && provider !== "ollama"
        && provider !== "openai-compatible" && provider !== "http") {
        throw new Error("--provider must be openai, anthropic, deepseek, kimi, ollama, openai-compatible, or http.");
    }
    const credentialVariable = single(values, "--credential-variable");
    if (provider === "openai-compatible" && credentialVariable === undefined) {
        throw new Error("--provider openai-compatible requires --credential-variable, an environment-variable name like OPENROUTER_API_KEY.");
    }
    if (credentialVariable !== undefined) {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(credentialVariable)) {
            throw new Error("--credential-variable must be an environment-variable name like OPENROUTER_API_KEY.");
        }
        if (provider === "http")
            throw new Error("--credential-variable is not supported for --provider http.");
    }
    const authRaw = single(values, "--auth");
    if (authRaw !== undefined && authRaw !== "api-key" && authRaw !== "oauth") {
        throw new Error("--auth must be api-key or oauth.");
    }
    const evidenceRaw = single(values, "--execution-evidence");
    if (evidenceRaw !== undefined && evidenceRaw !== "independent" && evidenceRaw !== "syntax") {
        throw new Error("--execution-evidence must be independent or syntax.");
    }
    if (authRaw === "oauth" && provider !== "openai" && provider !== "anthropic" && provider !== "kimi") {
        throw new Error("--auth oauth is available only for the openai, anthropic, and kimi providers.");
    }
    const agentProfileRaw = single(values, "--agent-profile") ?? "coder";
    if (agentProfileRaw !== "coder" && agentProfileRaw !== "explore" && agentProfileRaw !== "plan") {
        throw new Error("--agent-profile must be coder, explore, or plan.");
    }
    const model = required(values, "--model");
    const maxSteps = Number(single(values, "--max-steps") ?? "60");
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
        throw new Error("--max-steps must be a positive integer.");
    const maxDurationMs = Number(single(values, "--max-duration-ms") ?? "7200000");
    if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) {
        throw new Error("--max-duration-ms must be a positive integer.");
    }
    const maxContextBytes = Number(single(values, "--max-context-bytes") ?? "2000000");
    if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 1) {
        throw new Error("--max-context-bytes must be a positive integer.");
    }
    const maxFailedVerificationAttempts = Number(single(values, "--max-verification-attempts") ?? "3");
    if (!Number.isSafeInteger(maxFailedVerificationAttempts) || maxFailedVerificationAttempts < 1) {
        throw new Error("--max-verification-attempts must be a positive integer.");
    }
    const commandTimeoutMs = Number(single(values, "--command-timeout-ms") ?? "1800000");
    if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1) {
        throw new Error("--command-timeout-ms must be a positive integer.");
    }
    const commandIdleTimeoutRaw = single(values, "--command-idle-timeout-ms");
    const commandIdleTimeoutMs = commandIdleTimeoutRaw === undefined ? undefined : Number(commandIdleTimeoutRaw);
    if (commandIdleTimeoutMs !== undefined && (!Number.isSafeInteger(commandIdleTimeoutMs) || commandIdleTimeoutMs < 1)) {
        throw new Error("--command-idle-timeout-ms must be a positive integer.");
    }
    const reasoningEffort = single(values, "--reasoning-effort");
    if (reasoningEffort !== undefined && reasoningEffort !== "low" && reasoningEffort !== "medium"
        && reasoningEffort !== "high" && reasoningEffort !== "max") {
        throw new Error("--reasoning-effort must be low, medium, high, or max.");
    }
    const explicitCommand = single(values, "--verify-command");
    const detected = explicitCommand === undefined ? await detectProjectVerification(workspace) : undefined;
    const verification = explicitCommand === undefined
        ? detected
        : { command: explicitCommand, args: values.get("--verify-arg") ?? [] };
    if (verification === undefined) {
        throw new Error("Could not detect project verification. Supply --verify-command and repeat --verify-arg for its arguments.");
    }
    const publicCheckCommand = single(values, "--check-command");
    if (publicCheckCommand === undefined && values.has("--check-arg")) {
        throw new Error("--check-arg requires --check-command.");
    }
    const publicCheck = publicCheckCommand === undefined
        ? explicitCommand === undefined ? verification : undefined
        : { command: publicCheckCommand, args: values.get("--check-arg") ?? [] };
    const adaptiveVerification = single(values, "--adaptive-verification");
    const security = resolveSecurityPolicy({
        profile: parseSecurityProfile(single(values, "--security-profile") ?? "workspace"),
        ...(single(values, "--restrict-process") === undefined
            ? {}
            : { restrictProcess: parseBoolean(single(values, "--restrict-process"), "--restrict-process") }),
        ...(single(values, "--expose-raw-process") === undefined
            ? {}
            : { exposeRawProcess: parseBoolean(single(values, "--expose-raw-process"), "--expose-raw-process") }),
        ...(single(values, "--verifier-evidence") === undefined
            ? {}
            : { verifierEvidence: parseEvidenceMode(single(values, "--verifier-evidence")) }),
    });
    return {
        workspace,
        task,
        provider,
        model,
        agentProfile: agentProfileRaw,
        ...(authRaw === undefined ? {} : { auth: authRaw }),
        ...(evidenceRaw === undefined ? {} : { executionEvidence: evidenceRaw }),
        verification,
        ...(adaptiveVerification === undefined ? {} : { adaptiveVerification: parseBoolean(adaptiveVerification, "--adaptive-verification") }),
        allowedCommands: values.get("--allow-command") ?? [],
        protectedPaths: values.get("--protect") ?? [],
        editableRoots: values.get("--editable-root") ?? [],
        securityProfile: security.profile,
        restrictProcess: security.restrictProcess,
        exposeRawProcess: security.exposeRawProcess,
        disableExtensions,
        verifierEvidence: security.verifierEvidence,
        ...(publicCheck === undefined ? {} : { publicCheck }),
        maxSteps,
        maxDurationMs,
        commandTimeoutMs,
        ...(commandIdleTimeoutMs === undefined ? {} : { commandIdleTimeoutMs }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        maxContextBytes,
        maxFailedVerificationAttempts,
        ...(single(values, "--endpoint") === undefined ? {} : { endpoint: single(values, "--endpoint") }),
        ...(credentialVariable === undefined ? {} : { credentialVariable }),
        extensions: extensionRuntimeState(resolvedExtensions),
        ...(resolvedExtensions.instructions.length === 0 ? {} : { extensionInstructions: resolvedExtensions.instructions }),
    };
}
async function resolveTaskInput(values, requiredTask) {
    const inline = single(values, "--task");
    const file = single(values, "--task-file");
    if (inline !== undefined && file !== undefined) {
        throw new Error("--task and --task-file are mutually exclusive.");
    }
    if (file !== undefined) {
        if (file.length === 0)
            throw new Error("--task-file requires a path.");
        let bytes;
        try {
            bytes = await readFile(path.resolve(file));
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Unable to read --task-file '${file}': ${detail}`);
        }
        let task;
        try {
            task = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch {
            throw new Error(`--task-file is not valid UTF-8: ${file}`);
        }
        if (requiredTask && task.length === 0)
            throw new Error("--task-file must not be empty.");
        return task;
    }
    if (inline !== undefined) {
        if (requiredTask && inline.length === 0)
            throw new Error("--task is required.");
        return inline;
    }
    if (requiredTask)
        throw new Error("Supply exactly one of --task or --task-file.");
    return "";
}
async function readRunConfiguration(file) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed.version !== 1 || parsed.options === undefined) {
        throw new Error("Session run configuration is missing or unsupported.");
    }
    return {
        ...parsed.options,
        securityProfile: parsed.options.securityProfile ?? "workspace",
        commandTimeoutMs: parsed.options.commandTimeoutMs ?? 1_800_000,
        disableExtensions: parsed.options.disableExtensions ?? false,
        agentProfile: parsed.options.agentProfile ?? "coder",
    };
}
function parseResumeSession(args) {
    if (args.length !== 2 || args[0] !== "--session" || args[1] === undefined || args[1].length === 0) {
        throw new Error("Resume usage: vanguard resume --session SESSION_PATH");
    }
    return args[1];
}
function inPlaceRequested(args) {
    if (args.includes("--in-place"))
        return true;
    const environment = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
    return environment === "1" || environment === "true" || environment === "yes";
}
function directRequested(args) {
    if (args.includes("--direct"))
        return true;
    const environment = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
    return environment === "direct";
}
function isolatedRequested(args) {
    if (args.includes("--isolated"))
        return true;
    const environment = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
    return environment === "isolated" || environment === "off" || environment === "0" || environment === "no" || environment === "false";
}
async function sessionModeFor(args, workspace) {
    if (directRequested(args))
        return { inPlace: true, direct: true };
    if (inPlaceRequested(args))
        return { inPlace: true };
    if (isolatedRequested(args))
        return {};
    if (await isCleanGitRepository(workspace)) {
        process.stderr.write("vanguard: clean git repository — working directly in it (no copy, no baseline; git is your undo). --isolated overrides.\n");
        return { inPlace: true, direct: true };
    }
    return {};
}
function requiredArgument(args, name) {
    for (let index = 0; index < args.length; index += 2) {
        if (args[index] === name && args[index + 1] !== undefined)
            return args[index + 1];
    }
    throw new Error(`${name} is required.`);
}
function commandAliases(workspaceRoot, restricted, writableRoots) {
    const nodePrefix = restricted
        ? [
            nodePermissionFlag(),
            `--allow-fs-read=${workspaceRoot}`,
            ...writableRoots.map((root) => `--allow-fs-write=${root}`),
        ]
        : [];
    const npm = resolveNodePackageManagerAlias("npm");
    const npx = resolveNodePackageManagerAlias("npx");
    return {
        node: { executable: process.execPath, argsPrefix: nodePrefix },
        ...(npm === undefined ? {} : { npm: { executable: npm.executable, argsPrefix: [...npm.argsPrefix] } }),
        ...(npx === undefined ? {} : { npx: { executable: npx.executable, argsPrefix: [...npx.argsPrefix] } }),
    };
}
function parseBoolean(value, name) {
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    throw new Error(`${name} must be true or false.`);
}
function parseSecurityProfile(value) {
    if (value === "workspace" || value === "guarded")
        return value;
    throw new Error("--security-profile must be workspace or guarded.");
}
function parseEvidenceMode(value) {
    if (value === "full" || value === "summary")
        return value;
    throw new Error("--verifier-evidence must be full or summary.");
}
function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
    const raw = process.env[name];
    if (raw === undefined || raw.length === 0)
        return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return value;
}
function required(values, name) {
    const value = single(values, name);
    if (value === undefined || value.length === 0)
        throw new Error(`${name} is required.`);
    return value;
}
function single(values, name) {
    const all = values.get(name);
    if (all !== undefined && all.length > 1)
        throw new Error(`${name} may only be supplied once.`);
    return all?.[0];
}
function instrumentJournal(fileJournal) {
    let lastProgressAt = Date.now();
    let modelTurns = 0;
    const presenter = new PublicRunEventPresenter();
    const markActivity = () => { lastProgressAt = Date.now(); };
    const journal = {
        async append(event) {
            await fileJournal.append(event);
            markActivity();
            for (const publicEvent of presenter.present(event))
                streamPublicEvent(publicEvent);
            if (event.type === "model.decided") {
                modelTurns += 1;
                const decision = event.data;
                const action = decision.kind === "tools"
                    ? (decision.calls ?? []).map((call) => call.name ?? "unknown tool").join(", ")
                    : decision.kind === "tool" ? decision.call?.name ?? "unknown tool"
                        : decision.kind === "complete" ? "completion claim"
                            : decision.kind ?? "decision";
                process.stderr.write(`[Vanguard] turn ${modelTurns}: ${action}\n`);
            }
            else if (event.type === "verification.completed") {
                const verification = event.data;
                process.stderr.write(`[Vanguard] verifier ${verification.verifier ?? "unknown"}: ${verification.passed ? "passed" : "failed"}\n`);
            }
            else if (event.type === "run.failed") {
                const failure = event.data;
                process.stderr.write(`[Vanguard] stopped: ${failure.reason ?? "run failed"}\n`);
            }
        },
    };
    return { journal, journalActivity: () => lastProgressAt, markActivity };
}
function streamPublicEvent(event) {
    if (process.env.VANGUARD_EVENT_STREAM !== "1")
        return;
    process.stderr.write(encodePublicRunEvent(event));
}
function formatDuration(durationMs) {
    const seconds = Math.max(0, Math.floor(durationMs / 1_000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}
function printUsage() {
    process.stdout.write("Kimi Code: vanguard login kimi; use --provider kimi --model kimi-for-coding --auth oauth.\n\n");
    process.stdout.write(`Safe review/apply commands:\n  vanguard review --session SESSION_PATH\n  vanguard apply --session SESSION_PATH --manifest SHA256 --confirm SHA256\n  vanguard undo --session SESSION_PATH --apply TRANSACTION_ID --confirm TRANSACTION_ID\n  vanguard session checkpoint|list|restore|fork --session SESSION_PATH [options]\n\n`);
    process.stdout.write("Security profiles: --security-profile workspace (default) or guarded (no raw process, restricted mode, summary verifier evidence)\n\n");
    process.stdout.write("Hermetic evaluation: --disable-extensions true ignores every user/workspace extension layer.\n\n");
    process.stdout.write(`Vanguard expert coding agent\n\nUsage:\n  vanguard                         Start the conversational agent in the current directory\n  vanguard tui                     Start the conversational agent in the current directory\n  vanguard serve --stdio [--create-store ABS_PATH]\n                                   Start the versioned NDJSON engine protocol\n  vanguard advance --workspace PATH --provider P --model M [options] [--message TEXT]\n                                   Create a conversational session and advance it one turn\n  vanguard advance --session SESSION_PATH [--message TEXT]\n                                   Continue an existing conversational session\n  vanguard run --workspace PATH (--task TEXT | --task-file PATH) --provider openai|anthropic|deepseek --model MODEL [options]\n  vanguard resume --session SESSION_PATH\n  vanguard login anthropic|openai  Sign in with a Claude or ChatGPT subscription\n  vanguard logout [anthropic|openai]\n                                   Discard stored subscription tokens\n  vanguard auth [anthropic|openai] Show subscription sign-in status\n  vanguard doctor                  Check credentials, browser, and parser rungs; report degraded evidence capabilities\n\nDefault TUI overrides (each skips its launch selector):\n  VANGUARD_PROVIDER                deepseek, openai, anthropic, or ollama\n  VANGUARD_MODEL                   Provider model ID\n  VANGUARD_AUTH                    api-key or oauth (default: oauth when signed in)\n  VANGUARD_MAX_STEPS               Expert turn budget (default: 240)\n  VANGUARD_HOME                    Token directory (default: ~/.vanguard)\n  VANGUARD_CREATE_OPERATION_STORE  Absolute persistent store for idempotent stdio create\n\nAdvanced run options:\n  --task-file PATH        Read the task as strict UTF-8 instead of native-shell argument text\n  --verify-command CMD     Required sealed verifier executable when auto-detection is unavailable\n  --verify-arg ARG         Repeat for each sealed verifier argument\n  --check-command CMD      Trusted public compile/test executable exposed as check_project\n  --check-arg ARG          Repeat for each fixed public-check argument\n  --allow-command CMD      Repeat to expose another executable to the agent\n  --expose-raw-process BOOL Expose arbitrary allowlisted run_command calls (default: true)\n  --protect PATH           Repeat for files that must remain byte-identical\n  --editable-root PATH     Repeat to restrict all changes to these roots\n  --restrict-process BOOL  Confine Node subprocess filesystem access to the workspace\n  --verifier-evidence MODE Use full or summary verifier feedback\n  --adaptive-verification BOOL  Blank-project mode requiring the agent to establish a build/test contract\n  --auth MODE              api-key (default) or oauth for a Claude/ChatGPT subscription\n  --endpoint URL           Override provider endpoint, or required for provider=http\n  --max-steps N            Total agent step budget across resumes (default: 60)\n  --max-duration-ms N      Wall-clock budget per invocation (default: 7200000 / two hours)\n  --command-timeout-ms N   Per-build/test budget (default: 1800000 / thirty minutes)\n  --command-idle-timeout-ms N  Kill a command after N ms with no output (default: disabled; TUI: 90000)\n  --reasoning-effort LEVEL Reasoning depth for OpenAI and Kimi models: low, medium, high, or max (Kimi only; default: medium)\n  --max-context-bytes N    Provider context budget before evidence compaction (default: 2000000)\n  --max-verification-attempts N  Failed completion-claim budget (default: 3)\n`);
}
main().catch((error) => {
    const detail = error instanceof Error
        ? process.env.VANGUARD_DEBUG === "1" ? error.stack ?? error.message : error.message
        : String(error);
    process.stderr.write(`Vanguard failed: ${detail}\n`);
    process.exitCode = 1;
});
