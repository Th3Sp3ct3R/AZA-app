// Extracted from entry.ts — chat.

import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isReasoningLevel, reasoningLabel, REASONING_LEVELS } from "@ares/protocol";
import { chatHeader, availableThemes, dim, interactiveHelp, notice, promptLabel, providerError, setTheme, themeChanged, themesList, thinkingPrefix, toolEnd, toolError, toolStart } from "../terminalUi.js";
import { runInkChat, type InkChatSnapshot, type InkCommandResult } from "../inkTui.js";
import { runInkLauncher } from "../inkLauncher.js";
import { loadUiSettings, updateUiSettings } from "../uiSettings.js";
import { onLifecycle } from "@ares/agent";
import { briefingLines, buildBriefing, buildContinuitySummary, buildWorldGraph, checkpointDiffCommand, checkpointsCommand, continuityLines, doctorCommand, loginCommand, rollbackCommand, worldGraphLines } from "./introspect.js";
import { ProviderSelection, TERMINAL_PROVIDERS, daemonModelCatalog, defaultTerminalModel, providerFamilyForSelection } from "./providers.js";
import { ParsedArgs, cliRuntimeContext, printHelp } from "./runtime.js";
import { LiveSession, createSession, createSessionWithSelection, guardVisionForTurn, handleReasoningCommand } from "./sessionFactory.js";
import { promptPermission } from "./permissions.js";
import type { ToolPermissionRequest } from "@ares/core";
import type { PermissionPromptDecision } from "@ares/protocol";
import { applyTerminalAutoRouting, applyTerminalRoutingCommand, checkpointDiffLines, checkpointLines, colorUnifiedDiff, contentFromUserInput, doctorSummaryLines, inkHelpLines, legacyProgressText, persistTerminalModelPreference, printResumed, printSessions, requireResumeSessionId, resolveResumeSessionId, resumedLines, rollbackLines, saveTheme, sessionsLines, setTerminalProviderKey, switchTerminalModel, terminalKeyLines, terminalModelCatalogLines, terminalSettingsLines, themeLines, undoLines, usageMeter } from "./terminalLines.js";
import { disposeLiveSession, finishTurn, mindSessionEnded, prepareUserTurn } from "./turnPipeline.js";

export async function runCommand(args: ParsedArgs): Promise<number> {
  const goal = args.flags.get("goal");
  if (!goal) {
    process.stderr.write("error: --goal is required\n");
    return 2;
  }

  let live: LiveSession;
  try {
    live = await createSession(args);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  process.stderr.write(
    `ares: provider=${live.selection.provider.name} model=${live.selection.model} source=${live.selection.source} session=${live.session.meta.id}\n`,
  );

  const unsubLifecycle = onLifecycle((event) => {
    try {
      process.stdout.write(JSON.stringify({ type: "lifecycle", event }) + "\n");
    } catch {
      // ignore
    }
  });
  await prepareUserTurn(live, goal);
  let finalStatus: "completed" | "interrupted" | "failed" = "completed";
  const turnContent = await contentFromUserInput(goal, live.context.workspace);
  guardVisionForTurn(live, turnContent);
  for await (const event of live.session.sendContent(turnContent)) {
    if (event.type === "tool_end" && event.touchedFiles?.length) {
      live.verifier.scheduleFor(event.touchedFiles);
    }
    if (event.type === "turn_end") finalStatus = event.status;
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  // Keep turn_end as the final NDJSON line for downstream consumers — unsubscribe
  // before the post-turn / session-end hooks fire any additional lifecycle events.
  unsubLifecycle();
  await finishTurn(live, finalStatus);
  await disposeLiveSession(live);
  return 0;
}

export async function launcherCommand(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext();
  const settings = await loadUiSettings();
  const action = await runInkLauncher({
    workspace: context.workspace,
    settings,
    onSettingsChange: (patch) => {
      void updateUiSettings(patch);
    },
  });
  if (action.kind === "quit") return 0;
  if (action.kind === "login") return loginCommand();
  if (action.kind === "doctor") return doctorCommand();
  if (action.kind === "help") {
    await printHelp();
    return 0;
  }

  if (action.workspace) {
    const info = await stat(action.workspace).catch(() => null);
    if (!info?.isDirectory()) {
      process.stderr.write(`error: workspace is not a directory: ${action.workspace}\n`);
      return 2;
    }
    process.chdir(action.workspace);
  }
  setTheme(action.theme);
  await persistTerminalModelPreference(action.provider, action.model, {
    theme: action.theme,
    favoriteOllamaModels: action.favoriteOllamaModels,
    favoriteOpenAIModels: action.favoriteOpenAIModels,
  });
  args.flags.set("provider", action.provider);
  args.flags.set("model", action.model);
  args.flags.set("theme", action.theme);
  return chatCommand(args);
}

export async function chatCommand(args: ParsedArgs, resumeSessionId?: string): Promise<number> {
  // Permission seam: while Ink owns the terminal, the default raw-stderr
  // prompt is instantly painted over — the engine then waits forever on a
  // question nobody can see. The TUI registers an in-frame card handler here;
  // until (or unless) it does, fall back to the classic prompt.
  let inkPermissionHandler:
    | ((req: { toolName: string; reason: string; suggestion?: string }) => Promise<PermissionPromptDecision>)
    | null = null;
  const requestPermission = (req: ToolPermissionRequest): Promise<PermissionPromptDecision> =>
    inkPermissionHandler
      ? inkPermissionHandler({ toolName: req.toolName, reason: req.reason, suggestion: req.suggestion })
      : promptPermission(req);

  let live: LiveSession;
  try {
    const resumeTarget = resumeSessionId ?? (await resolveResumeSessionId(args.flags.get("resume")));
    live = await createSession(args, resumeTarget, requestPermission);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  if (stdin.isTTY && stdout.isTTY && process.env.ARES_LEGACY_TUI !== "1") {
    const snapshot = (): InkChatSnapshot => ({
      provider: live.selection.provider.name,
      model: live.selection.model,
      workspace: live.context.workspace,
      mode: live.runtime.permissionMode,
    });
    // Post-turn bookkeeping (Witness — a full model call — plus memory writes)
    // must NOT hold the UI "busy" after the answer has rendered. It runs
    // detached; the NEXT send awaits it first, so the cost hides in the user's
    // think-time instead of a dead spinner.
    let pendingFinish: Promise<void> = Promise.resolve();
    return await runInkChat({
      snapshot,
      resumedLines: live.resumed ? resumedLines(live.resumed) : undefined,
      listModelOptions: (provider) => daemonModelCatalog(provider),
      registerPermissionHandler: (handler) => {
        inkPermissionHandler = handler;
      },
      steer: (text) => {
        // Same contract as the daemon's steer verb: course-correct the LIVE
        // turn without restarting it (drained after the current tool round).
        live.queueSystemReminder(
          `The user STEERED mid-task: "${text}". Adjust course to honor this, but keep your current objective and everything you've already done — do not restart.`,
          "instructions",
        );
      },
      sendMessage: async (goal, onEvent) => {
        await pendingFinish;
        await applyTerminalAutoRouting(live, goal);
        await prepareUserTurn(live, goal);
        let finalStatus: "completed" | "interrupted" | "failed" = "completed";
        const turnContent = await contentFromUserInput(goal, live.context.workspace);
        guardVisionForTurn(live, turnContent);
        for await (const event of live.session.sendContent(turnContent)) {
          if (event.type === "tool_end" && event.touchedFiles?.length) {
            live.verifier.scheduleFor(event.touchedFiles);
          }
          if (event.type === "turn_end") finalStatus = event.status;
          onEvent(event);
        }
        pendingFinish = finishTurn(live, finalStatus).catch(() => {});
      },
      handleCommand: async (line): Promise<InkCommandResult> => {
        if (line === "/exit" || line === "/quit") {
          await pendingFinish; // don't lose detached post-turn bookkeeping on exit
          await disposeLiveSession(live);
          await mindSessionEnded();
          return { kind: "exit" };
        }
        if (line === "/help") return { kind: "handled", lines: inkHelpLines(), snapshot: snapshot() };
        if (line === "/settings") return { kind: "handled", lines: await terminalSettingsLines(live), snapshot: snapshot() };
        if (line === "/doctor") return { kind: "handled", lines: await doctorSummaryLines(), snapshot: snapshot() };
        if (line === "/keys") return { kind: "handled", lines: await terminalKeyLines(), snapshot: snapshot() };
        if (line === "/key" || line.startsWith("/key ")) {
          const rest = line.slice("/key".length).trim();
          const [provider, ...keyParts] = rest.split(/\s+/);
          if (!provider || keyParts.length === 0) return { kind: "handled", lines: ["Usage: /key <anthropic|deepseek|openrouter|ollama|brave> <value|clear>"], snapshot: snapshot() };
          return { kind: "handled", lines: await setTerminalProviderKey(provider.toLowerCase(), keyParts.join(" ")), snapshot: snapshot() };
        }
        if (line === "/models" || line.startsWith("/models ")) {
          return { kind: "handled", lines: await terminalModelCatalogLines(line.slice("/models".length).trim() || undefined), snapshot: snapshot() };
        }
        if (line === "/model" || line.startsWith("/model ")) {
          const rest = line.slice("/model".length).trim();
          if (!rest) {
            return {
              kind: "handled",
              lines: [
                `Current model: ${providerFamilyForSelection(live.selection)} / ${live.selection.model}`,
                `Usage: /model <${TERMINAL_PROVIDERS.join("|")}> [model-id]`,
                "Use /models <provider> to browse available ids.",
              ],
              snapshot: snapshot(),
            };
          }
          const [providerRaw, ...modelParts] = rest.split(/\s+/);
          const provider = providerRaw.toLowerCase();
          const settings = await loadUiSettings();
          const model = modelParts.join(" ").trim() || defaultTerminalModel(provider, settings);
          return { kind: "handled", lines: await switchTerminalModel(live, provider, model), snapshot: snapshot() };
        }
        if (line === "/routing" || line.startsWith("/routing ")) {
          return { kind: "handled", lines: await applyTerminalRoutingCommand(line.slice("/routing".length)), snapshot: snapshot() };
        }
        if (line === "/themes") return { kind: "handled", lines: themeLines(), snapshot: snapshot() };
        if (line === "/sessions") return { kind: "handled", lines: await sessionsLines(20, live.context), snapshot: snapshot() };
        if (line === "/plan") {
          live.runtime.permissionMode = "plan";
          await updateUiSettings({ dangerousBypass: false });
          return { kind: "handled", lines: ["Plan mode enabled. Writes are blocked."], snapshot: snapshot() };
        }
        if (line === "/code" || line === "/exitplan") {
          live.runtime.permissionMode = "workspace-write";
          await updateUiSettings({ dangerousBypass: false });
          return { kind: "handled", lines: ["Workspace-write mode restored."], snapshot: snapshot() };
        }
        if (line === "/danger" || line === "/bypass") {
          live.runtime.permissionMode = live.runtime.permissionMode === "bypass" ? "workspace-write" : "bypass";
          await updateUiSettings({ dangerousBypass: live.runtime.permissionMode === "bypass" });
          return {
            kind: "handled",
            lines: [
              live.runtime.permissionMode === "bypass"
                ? "Dangerous bypass enabled. Tool prompts are auto-allowed until you toggle it off."
                : "Dangerous bypass disabled. Workspace-write mode restored.",
            ],
            snapshot: snapshot(),
          };
        }
        if (line === "/checkpoints") return { kind: "handled", lines: await checkpointLines(live.context), snapshot: snapshot() };
        if (line.startsWith("/checkpoint-diff ")) {
          return { kind: "handled", lines: await checkpointDiffLines(line.slice("/checkpoint-diff ".length).trim(), live.context), snapshot: snapshot() };
        }
        if (line === "/undo" || line.startsWith("/undo ")) {
          return { kind: "handled", lines: await undoLines(live, line.slice("/undo".length)), snapshot: snapshot() };
        }
        if (line.startsWith("/rollback ")) {
          return { kind: "handled", lines: await rollbackLines(line.slice("/rollback ".length).trim(), live.context), snapshot: snapshot() };
        }
        if (line === "/theme" || line.startsWith("/theme ")) {
          const requested = line.split(/\s+/, 2)[1];
          if (!requested) return { kind: "handled", lines: themeLines(), snapshot: snapshot() };
          const selected = setTheme(requested);
          if (!selected) {
            return { kind: "handled", lines: [`Unknown theme: ${requested}`, `Available: ${availableThemes().join(", ")}`], snapshot: snapshot() };
          }
          await saveTheme(selected);
          return { kind: "handled", lines: [`Theme active: ${selected}`], snapshot: snapshot() };
        }
        if (line === "/resume" || line.startsWith("/resume ")) {
          const target = line.split(/\s+/, 2)[1] ?? "last";
          const sessionId = await requireResumeSessionId(target, live.context);
          await disposeLiveSession(live);
          live = await createSessionWithSelection(args, live.selection, sessionId, requestPermission);
          return { kind: "handled", lines: live.resumed ? resumedLines(live.resumed) : [`Resumed ${sessionId}`], snapshot: snapshot() };
        }
        if (line.startsWith("/workspace ")) {
          const target = line.slice("/workspace ".length).trim();
          const next = path.resolve(live.context.workspace, target);
          const info = await stat(next).catch(() => null);
          if (!info?.isDirectory()) return { kind: "handled", lines: [`Not a directory: ${next}`], snapshot: snapshot() };
          await disposeLiveSession(live);
          process.chdir(next);
          live = await createSessionWithSelection(args, live.selection, undefined, requestPermission);
          return { kind: "handled", lines: [`Active workspace is now ${live.context.workspace}`], snapshot: snapshot() };
        }
        if (line === "/reasoning" || line.startsWith("/reasoning ")) {
          const requested = line.split(/\s+/, 2)[1]?.toLowerCase();
          if (!requested) {
            // Report the LIVE engine dial, not the env/persisted value — those
            // lie once /reasoning has overridden them this session.
            const current = live.reasoningLevel;
            return {
              kind: "handled",
              lines: [`Reasoning: ${reasoningLabel(current)} (${current}). Change with /reasoning <${REASONING_LEVELS.join("|")}>.`],
              snapshot: snapshot(),
            };
          }
          if (!isReasoningLevel(requested)) {
            return { kind: "handled", lines: [`Unknown reasoning level: ${requested}`, `Available: ${REASONING_LEVELS.join(", ")}`], snapshot: snapshot() };
          }
          const change = await handleReasoningCommand(requested, [live]);
          const lines = [`Reasoning set to ${reasoningLabel(requested)} — applies on your next message.`];
          if (change.clearedEnvOverride) lines.push("(ARES_REASONING_LEVEL was overriding the dial — cleared for this session so your choice sticks.)");
          return { kind: "handled", lines, snapshot: snapshot() };
        }
        return { kind: "not-handled" };
      },
    });
  }

  process.stdout.write("\n" + chatHeader({
    provider: live.selection.provider.name,
    model: live.selection.model,
    workspace: live.context.workspace,
  }));
  if (live.resumed) printResumed(live.resumed);

  while (true) {
    const line = (await askLine(promptLabel(live.selection.model, live.context.workspace, live.runtime.permissionMode))).trim();
    if (!line) continue;
    if (line === "/exit" || line === "exit" || line === "/quit" || line === "quit") {
      await disposeLiveSession(live);
      process.stdout.write("bye\n");
      return 0;
    }
    if (line === "/help" || line === "help") {
      process.stdout.write(interactiveHelp());
      continue;
    }
    if (line === "/settings") {
      process.stdout.write(notice("Settings", await terminalSettingsLines(live), "info"));
      continue;
    }
    if (line === "/doctor" || line === "doctor") {
      await doctorCommand();
      continue;
    }
    if (line === "/keys") {
      process.stdout.write(notice("Keys", await terminalKeyLines(), "info"));
      continue;
    }
    if (line === "/key" || line.startsWith("/key ")) {
      const rest = line.slice("/key".length).trim();
      const [provider, ...keyParts] = rest.split(/\s+/);
      const lines = !provider || keyParts.length === 0
        ? ["Usage: /key <anthropic|deepseek|openrouter|ollama|brave> <value|clear>"]
        : await setTerminalProviderKey(provider.toLowerCase(), keyParts.join(" "));
      process.stdout.write(notice("Keys", lines, "info"));
      continue;
    }
    if (line === "/models" || line.startsWith("/models ")) {
      process.stdout.write(notice("Models", await terminalModelCatalogLines(line.slice("/models".length).trim() || undefined), "info"));
      continue;
    }
    if (line === "/model" || line.startsWith("/model ")) {
      const rest = line.slice("/model".length).trim();
      if (!rest) {
        process.stdout.write(notice("Model", [
          `Current model: ${providerFamilyForSelection(live.selection)} / ${live.selection.model}`,
          `Usage: /model <${TERMINAL_PROVIDERS.join("|")}> [model-id]`,
          "Use /models <provider> to browse available ids.",
        ], "info"));
        continue;
      }
      const [providerRaw, ...modelParts] = rest.split(/\s+/);
      const provider = providerRaw.toLowerCase();
      const settings = await loadUiSettings();
      const model = modelParts.join(" ").trim() || defaultTerminalModel(provider, settings);
      process.stdout.write(notice("Model", await switchTerminalModel(live, provider, model), "success"));
      continue;
    }
    if (line === "/routing" || line.startsWith("/routing ")) {
      process.stdout.write(notice("Routing", await applyTerminalRoutingCommand(line.slice("/routing".length)), "info"));
      continue;
    }
    if (line === "/reasoning" || line.startsWith("/reasoning ")) {
      const requested = line.split(/\s+/, 2)[1]?.toLowerCase();
      if (!requested) {
        // Live engine dial — not the env/persisted value, which lies after an
        // explicit /reasoning has overridden them this session.
        const current = live.reasoningLevel;
        process.stdout.write(notice("Reasoning", [`Reasoning: ${reasoningLabel(current)} (${current}). Change with /reasoning <${REASONING_LEVELS.join("|")}>.`], "info"));
        continue;
      }
      if (!isReasoningLevel(requested)) {
        process.stdout.write(notice("Reasoning", [`Unknown reasoning level: ${requested}`, `Available: ${REASONING_LEVELS.join(", ")}`], "error"));
        continue;
      }
      const change = await handleReasoningCommand(requested, [live]);
      const lines = [`Reasoning set to ${reasoningLabel(requested)} — applies on your next message.`];
      if (change.clearedEnvOverride) lines.push("(ARES_REASONING_LEVEL was overriding the dial — cleared for this session so your choice sticks.)");
      process.stdout.write(notice("Reasoning", lines, "success"));
      continue;
    }
    if (line === "/themes" || line === "themes") {
      process.stdout.write(themesList());
      continue;
    }
    if (line === "/theme" || line.startsWith("/theme ")) {
      const requested = line.split(/\s+/, 2)[1];
      if (!requested) {
        process.stdout.write(themesList());
        continue;
      }
      const selected = setTheme(requested);
      if (!selected) {
        process.stderr.write(notice("Theme", [`Unknown theme: ${requested}`, `Available: ${availableThemes().join(", ")}`], "error"));
        continue;
      }
      await saveTheme(selected);
      process.stdout.write(themeChanged(selected));
      process.stdout.write(chatHeader({
        provider: live.selection.provider.name,
        model: live.selection.model,
        workspace: live.context.workspace,
      }));
      continue;
    }
    if (line === "/sessions") {
      await printSessions();
      continue;
    }
    if (line === "/plan") {
      live.runtime.permissionMode = "plan";
      await updateUiSettings({ dangerousBypass: false });
      process.stdout.write(notice("Plan Mode", ["Writes are blocked. Use /code to return to workspace-write mode."], "warn"));
      continue;
    }
    if (line === "/code" || line === "/exitplan") {
      live.runtime.permissionMode = "workspace-write";
      await updateUiSettings({ dangerousBypass: false });
      process.stdout.write(notice("Plan Mode", ["Workspace-write mode restored."], "success"));
      continue;
    }
    if (line === "/danger" || line === "/bypass") {
      live.runtime.permissionMode = live.runtime.permissionMode === "bypass" ? "workspace-write" : "bypass";
      await updateUiSettings({ dangerousBypass: live.runtime.permissionMode === "bypass" });
      process.stdout.write(
        notice(
          "Danger",
          [
            live.runtime.permissionMode === "bypass"
              ? "Dangerous bypass enabled. Tool prompts are auto-allowed until toggled off."
              : "Dangerous bypass disabled. Workspace-write mode restored.",
          ],
          live.runtime.permissionMode === "bypass" ? "warn" : "success",
        ),
      );
      continue;
    }
    if (line === "/checkpoints") {
      await checkpointsCommand();
      continue;
    }
    if (line.startsWith("/checkpoint-diff ")) {
      await checkpointDiffCommand(line.slice("/checkpoint-diff ".length).trim());
      continue;
    }
    if (line === "/undo" || line.startsWith("/undo ")) {
      process.stdout.write(notice("Undo", await undoLines(live, line.slice("/undo".length)), "success"));
      continue;
    }
    if (line.startsWith("/rollback ")) {
      await rollbackCommand(line.slice("/rollback ".length).trim());
      continue;
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
      const target = line.split(/\s+/, 2)[1] ?? "last";
      try {
        const sessionId = await requireResumeSessionId(target, live.context);
        await disposeLiveSession(live);
        live = await createSessionWithSelection(args, live.selection, sessionId);
        if (live.resumed) printResumed(live.resumed);
      } catch (err) {
        process.stderr.write(notice("Resume", [err instanceof Error ? err.message : String(err)], "error"));
      }
      continue;
    }
    if (line === "/whathappened" || line === "/recap") {
      const summary = await buildContinuitySummary(live.context);
      process.stdout.write(notice("Ghost Continue", continuityLines(summary), summary.blocked.length ? "warn" : "info"));
      continue;
    }
    if (line === "/world") {
      const graph = await buildWorldGraph(live.context);
      process.stdout.write(notice("World Graph", worldGraphLines(graph), "info"));
      continue;
    }
    if (line === "/today" || line === "/briefing") {
      const briefing = await buildBriefing(live.context);
      process.stdout.write(notice("Today", briefingLines(briefing), briefing.decisionsNeeded.length ? "warn" : "info"));
      continue;
    }
    if (line.startsWith("/workspace ")) {
      const target = line.slice("/workspace ".length).trim();
      await disposeLiveSession(live);
      live = await switchWorkspace(args, live.selection, target);
      continue;
    }

    await applyTerminalAutoRouting(live, line);
    await renderTurn(live, line);
  }
}

async function askLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function switchWorkspace(
  args: ParsedArgs,
  selection: ProviderSelection,
  target: string,
): Promise<LiveSession> {
  const context = cliRuntimeContext();
  const next = path.resolve(context.workspace, target);
  const info = await stat(next).catch(() => null);
  if (!info?.isDirectory()) {
    process.stderr.write(notice("Workspace", [`Not a directory: ${next}`], "error"));
    return createSessionWithSelection(args, selection);
  }
  process.chdir(next);
  const live = await createSessionWithSelection(args, selection);
  process.stdout.write(notice("Workspace", [`Active workspace is now ${live.context.workspace}`], "success"));
  return live;
}

async function renderTurn(live: LiveSession, goal: string): Promise<void> {
  await prepareUserTurn(live, goal);
  let wroteText = false;
  let wroteThinking = false;
  let finalStatus: "completed" | "interrupted" | "failed" = "completed";
  const turnContent = await contentFromUserInput(goal, live.context.workspace);
  guardVisionForTurn(live, turnContent);
  for await (const event of live.session.sendContent(turnContent)) {
    if (event.type === "text_delta") {
      if (wroteThinking) {
        process.stderr.write("\n");
        wroteThinking = false;
      }
      process.stdout.write(event.text);
      wroteText = true;
      continue;
    }
    if (event.type === "thinking_delta") {
      if (!wroteThinking) process.stderr.write(thinkingPrefix());
      process.stderr.write(dim(event.text));
      wroteThinking = true;
      continue;
    }
    if (event.type === "tool_start") {
      if (wroteText) process.stdout.write("\n");
      if (wroteThinking) {
        process.stderr.write("\n");
        wroteThinking = false;
      }
      process.stderr.write(toolStart(event));
      wroteText = false;
      continue;
    }
    if (event.type === "tool_end") {
      if (event.touchedFiles?.length) live.verifier.scheduleFor(event.touchedFiles);
      process.stderr.write(toolEnd(event));
      continue;
    }
    if (event.type === "tool_progress") {
      const text = legacyProgressText(event.data);
      if (text) process.stderr.write(dim(text) + "\n");
      continue;
    }
    if (event.type === "workspace_diff") {
      process.stderr.write(colorUnifiedDiff(event.diff));
      continue;
    }
    if (event.type === "todo_updated") {
      process.stderr.write(notice("Todos", event.todos.map((todo) => `${todo.status.padEnd(11)} ${todo.status === "in_progress" ? todo.activeForm : todo.content}`), "info"));
      continue;
    }
    if (event.type === "checkpoint_created") {
      process.stderr.write(notice("Checkpoint", [`${event.checkpointId}${event.label ? ` ${event.label}` : ""}`], "muted"));
      continue;
    }
    if (event.type === "tool_error") {
      process.stderr.write(toolError(event));
      continue;
    }
    if (event.type === "error") {
      process.stderr.write(providerError(event.error.message));
      continue;
    }
    if (event.type === "turn_end") {
      finalStatus = event.status;
      if (wroteThinking) process.stderr.write("\n");
      if (wroteText) process.stdout.write("\n");
      if (event.status !== "completed") {
        process.stderr.write(notice("Turn", [`status ${event.status}`], "warn"));
      }
      process.stderr.write(dim(usageMeter(event.usage, event.durationMs)) + "\n");
      await finishTurn(live, finalStatus);
      return;
    }
    void event;
  }
  await finishTurn(live, finalStatus);
}
