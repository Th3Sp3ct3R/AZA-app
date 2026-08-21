// Extracted from entry.ts — terminalLines.

import { Session, OllamaCloudPool, DEFAULT_OLLAMA_SLOTS, listWorkspaceCheckpoints, diffWorkspaceCheckpoint, restoreWorkspaceCheckpoint, authStatus, listSessions, type Provider, type SessionSummary, classifyLane } from "@ares/core";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { stdout } from "node:process";
import type { ContentBlock } from "@ares/protocol";
import { reasoningLabel, messageText } from "@ares/protocol";
import { z } from "zod";
import { availableThemes, dim, notice, setTheme, type ThemeName } from "../terminalUi.js";
import { loadUiSettings, updateUiSettings, type UiSettings } from "../uiSettings.js";
import { loadTelegramConfig } from "../telegramConfig.js";
import { NATIVE_OLLAMA_OPTS, ROUTE_LANES, TERMINAL_PROVIDERS, daemonModelCatalog, defaultTerminalModel, isTerminalProviderId, providerFamilyForSelection, selectProvider } from "./providers.js";
import { cliRuntimeContext } from "./runtime.js";
import { LiveSession, ResumedSessionInfo, chatContextBudget, makeSpanSummarizer } from "./sessionFactory.js";

export async function resolveResumeSessionId(target?: string, context = cliRuntimeContext()): Promise<string | undefined> {
  if (!target || target === "false") return undefined;
  if (target === "true" || target === "last" || target === "latest") {
    const [latest] = await listSessions(context.workspace, 1);
    return latest?.id;
  }
  return target;
}

export async function requireResumeSessionId(target?: string, context = cliRuntimeContext()): Promise<string> {
  const sessionId = await resolveResumeSessionId(target ?? "last", context);
  if (!sessionId) throw new Error("no saved sessions in this workspace");
  return sessionId;
}

function sessionSummaryLine(session: SessionSummary): string {
  const provider = `${session.provider.name}:${session.provider.model}`;
  const preview = session.preview || "(no user text)";
  const updated = new Date(session.updatedAt).toLocaleString();
  return `${session.id}  ${provider}  ${session.eventCount} events  ${updated}  ${preview}`;
}

export async function printSessions(limit = 20, context = cliRuntimeContext()): Promise<SessionSummary[]> {
  const sessions = await listSessions(context.workspace, limit);
  if (sessions.length === 0) {
    process.stdout.write(notice("Sessions", ["No saved sessions in this workspace yet."], "warn"));
    return sessions;
  }
  process.stdout.write(notice("Sessions", sessions.map(sessionSummaryLine), "info"));
  return sessions;
}

export function printResumed(resumed: ResumedSessionInfo): void {
  const lines = [
    `id ${resumed.id}`,
    `${resumed.eventCount} replayed event(s)`,
    `${resumed.replayedMessageCount} message(s) hydrated into model context`,
  ];
  if (resumed.compacted) lines.push(`${resumed.omittedMessageCount} older message(s) compacted into a replay summary`);
  if (resumed.preview) lines.push(`last user message: ${resumed.preview}`);
  process.stdout.write(notice("Resumed Session", lines, "success"));
}

export function resumedLines(resumed: ResumedSessionInfo): string[] {
  const lines = [
    `Resumed ${resumed.id}`,
    `${resumed.eventCount} replayed event(s)`,
    `${resumed.replayedMessageCount} message(s) hydrated into model context`,
  ];
  if (resumed.compacted) lines.push(`${resumed.omittedMessageCount} older message(s) compacted into a replay summary`);
  if (resumed.preview) lines.push(`last user message: ${resumed.preview}`);
  return lines;
}

export function inkHelpLines(): string[] {
  return [
    "/help                  Show this help.",
    "/settings              Show model, key, routing, Telegram, and runtime state.",
    "/doctor                Provider and runtime status.",
    "/models [provider]     List terminal model catalog for a provider.",
    "/model <provider> [id] Switch the live model (id omitted = saved/default).",
    "/keys                  Show saved API key status.",
    "/key <provider> <key>  Save or clear a provider key (use 'clear').",
    "/reasoning [level]     Show/set reasoning: off|low|medium|high|max.",
    "/routing ...           Show/set per-lane model routing.",
    "/themes                Show installed UI themes.",
    "/theme <name>          Switch theme without restarting.",
    "/sessions              List saved .ares sessions for this workspace.",
    "/plan                  Enter read-only planning mode.",
    "/code                  Exit planning mode and allow workspace writes.",
    "/danger                Toggle bypass mode for tool prompts.",
    "/checkpoints           List local workspace checkpoints.",
    "/checkpoint-diff <id>  Compare current workspace to a checkpoint.",
    "/undo [N]              Restore the latest pre-write checkpoint.",
    "/rollback <id>         Restore a checkpoint snapshot.",
    "/resume [id|last]      Replay a saved session into model context.",
    "/workspace <path>      Switch the active workspace for tool calls.",
    "/exit                  Close Ares.",
  ];
}

export function themeLines(): string[] {
  return availableThemes().map((name) => `${name}${name === currentThemeNameSafe() ? " (active)" : ""}`);
}

function currentThemeNameSafe(): string {
  try {
    return process.env.ARES_THEME ?? "amber";
  } catch {
    return "amber";
  }
}

export async function sessionsLines(limit = 20, context = cliRuntimeContext()): Promise<string[]> {
  const sessions = await listSessions(context.workspace, limit);
  if (sessions.length === 0) return ["No saved sessions in this workspace yet."];
  return sessions.map(sessionSummaryLine);
}

export async function doctorSummaryLines(): Promise<string[]> {
  const auth = await authStatus();
  const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS, ...NATIVE_OLLAMA_OPTS });
  const health = await pool.health();
  // OpenAI OAuth + Ollama aren't the only providers — terminalKeyStatus already
  // checks anthropic/deepseek/openrouter/ollama/brave keys correctly; reuse it
  // instead of leaving key-based providers silently unchecked.
  const keyStatus = terminalKeyStatus(await loadUiSettings());
  return [
    `OpenAI auth configured: ${auth.configured ? "yes" : "no"}`,
    `OpenAI auth mode: ${auth.mode}`,
    `OpenAI auth source: ${auth.source}`,
    ...(auth.email ? [`OpenAI email: ${auth.email}`] : []),
    `Ollama host: ${health.host}`,
    `Ollama reachable: ${health.reachable ? "yes" : "no"}`,
    `Ollama available models: ${health.availableModels.length}`,
    ...health.slots.map((slot) => `${slot.name}: ${slot.model} ${slot.present ? "[present]" : "[missing]"}`),
    ...keyStatus.map(([provider, saved]) => `${provider} key configured: ${saved ? "yes" : "no"}`),
  ];
}

export async function terminalSettingsLines(live: LiveSession): Promise<string[]> {
  const [settings, auth, telegram] = await Promise.all([
    loadUiSettings(),
    authStatus().catch(() => null),
    loadTelegramConfig().catch(() => null),
  ]);
  const routing = settings.routing ?? {};
  const keyStatus = terminalKeyStatus(settings);
  return [
    `current: ${providerFamilyForSelection(live.selection)} / ${live.selection.model}`,
    `reasoning: ${live.reasoningLevel} (${reasoningLabel(live.reasoningLevel)})`,
    `mode: ${live.runtime.permissionMode}`,
    `routing: ${settings.routingMode ?? "manual"}${Object.keys(routing).length ? ` (${Object.keys(routing).length} lane(s))` : ""}`,
    ...ROUTE_LANES.map((lane) => {
      const entry = routing[lane];
      return `  ${lane}: ${entry ? `${entry.family} / ${entry.model}` : "(main model)"}`;
    }),
    `keys: OpenAI OAuth ${auth?.configured ? "saved" : "not set"}; ${keyStatus.map(([provider, saved]) => `${provider} ${saved ? "saved" : "not set"}`).join("; ")}`,
    `telegram: ${telegram?.enabled && telegram.botToken && telegram.allowedChats.length ? `enabled (${telegram.allowedChats.length} chat)` : "not configured/enabled"}`,
    "commands: /model <provider> [model], /models [provider], /key <provider> <value|clear>, /routing, /reasoning <level>",
  ];
}

export function terminalKeyStatus(settings: UiSettings): Array<[string, boolean]> {
  // Mirror daemon_ready: a key in the environment counts as configured too.
  return [
    ["anthropic", Boolean(settings.anthropicKey || process.env.ANTHROPIC_API_KEY || process.env.ARES_ANTHROPIC_API_KEY)],
    ["deepseek", Boolean(settings.deepSeekKey || process.env.DEEPSEEK_API_KEY)],
    ["openrouter", Boolean(settings.openRouterKey || process.env.OPENROUTER_API_KEY)],
    ["ares", Boolean(settings.aresGatewayToken || process.env.ARES_GATEWAY_TOKEN)],
    ["ollama", Boolean(settings.ollamaApiKey || process.env.OLLAMA_API_KEY)],
    ["brave", Boolean(settings.braveKey || process.env.ARES_BRAVE_API_KEY)],
  ];
}

export async function terminalKeyLines(): Promise<string[]> {
  const settings = await loadUiSettings();
  return [
    "API key status:",
    ...terminalKeyStatus(settings).map(([provider, saved]) => `  ${provider.padEnd(10)} ${saved ? "saved" : "not set"}`),
    "OpenAI uses ChatGPT OAuth: run `ares login`.",
    "Set/clear: /key <anthropic|deepseek|openrouter|ollama|brave> <value|clear>",
  ];
}

export async function setTerminalProviderKey(provider: string, rawKey: string): Promise<string[]> {
  const key = rawKey.trim();
  const clear = key.length === 0 || key.toLowerCase() === "clear" || key.toLowerCase() === "unset";
  const value = clear ? "" : key;
  const patch: Partial<UiSettings> = {};
  if (provider === "openrouter") {
    patch.openRouterKey = value;
  } else if (provider === "deepseek") {
    patch.deepSeekKey = value;
  } else if (provider === "anthropic") {
    patch.anthropicKey = value;
  } else if (provider === "ollama") {
    patch.ollamaApiKey = value;
    if (value) process.env.OLLAMA_API_KEY = value;
    else delete process.env.OLLAMA_API_KEY;
  } else if (provider === "ares") {
    // Accepts '/key ares <token>' or '/key ares <url> <token>' (two words).
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      patch.aresGatewayUrl = parts[0].replace(/\/+$/, "");
      patch.aresGatewayToken = parts[1];
    } else {
      patch.aresGatewayToken = value;
    }
  } else if (provider === "brave") {
    patch.braveKey = value;
    if (value) process.env.ARES_BRAVE_API_KEY = value;
    else delete process.env.ARES_BRAVE_API_KEY;
  } else {
    return [`Unsupported key provider: ${provider}`, "Use: anthropic, deepseek, openrouter, ollama, brave, ares"];
  }
  await updateUiSettings(patch);
  return [`${provider} key ${clear ? "cleared" : "saved"} (encrypted at rest).`];
}

export async function terminalModelCatalogLines(providerRaw?: string): Promise<string[]> {
  const settings = await loadUiSettings();
  const provider = (providerRaw || settings.lastProvider || providerRaw || "ollama").toLowerCase();
  if (!isTerminalProviderId(provider)) {
    return [`Unknown provider: ${provider}`, `Available: ${TERMINAL_PROVIDERS.join(", ")}`];
  }
  const models = await daemonModelCatalog(provider);
  if (models.length === 0) return [`No model catalog available for ${provider}. You can still set an explicit id: /model ${provider} <model-id>`];
  const preferred = defaultTerminalModel(provider, settings);
  return [
    `${provider} models (${models.length})${preferred ? ` — current/default: ${preferred}` : ""}`,
    ...models.slice(0, 40).map((model) => {
      const mark = model.id === preferred ? "*" : " ";
      const hint = model.hint ? ` — ${model.hint}` : "";
      return `${mark} ${model.id}${hint}`;
    }),
    ...(models.length > 40 ? [`...${models.length - 40} more. Use the exact id with /model ${provider} <model-id>.`] : []),
  ];
}

export async function persistTerminalModelPreference(provider: string, model: string, extra: Partial<UiSettings> = {}): Promise<void> {
  const settings = await loadUiSettings();
  await updateUiSettings({
    ...extra,
    lastProvider: provider as UiSettings["lastProvider"],
    lastOpenAIModel: provider === "openai" ? model : settings.lastOpenAIModel,
    lastOllamaModel: provider === "ollama" ? model : settings.lastOllamaModel,
    lastAnthropicModel: provider === "anthropic" ? model : settings.lastAnthropicModel,
    lastDeepSeekModel: provider === "deepseek" ? model : settings.lastDeepSeekModel,
    lastOpenRouterModel: provider === "openrouter" ? model : settings.lastOpenRouterModel,
    // Same gap as the daemon's model_switch: Ares gateway + custom models
    // weren't being remembered. Persist them so a /model choice survives restart.
    lastAresModel: provider === "ares" ? model : settings.lastAresModel,
    lastCustomModel: provider === "custom" ? model : settings.lastCustomModel,
    lastMoaModel: provider === "moa" ? model : settings.lastMoaModel,
  });
}

export async function switchTerminalModel(live: LiveSession, provider: string, model: string, persist = true): Promise<string[]> {
  if (!isTerminalProviderId(provider)) return [`Unknown provider: ${provider}`, `Available: ${TERMINAL_PROVIDERS.join(", ")}`];
  const selection = await selectProvider(new Map([["provider", provider], ["model", model]]));
  await live.session.setProvider(selection.provider, selection.model, {
    contextBudgetTokens: chatContextBudget(selection),
    summarizeSpan: makeSpanSummarizer(selection, (usage) =>
      live.session.recordAuxiliaryUsage("compaction", selection.provider.name, selection.model, usage),
    ),
  });
  live.selection = selection;
  live.routeLane = undefined;
  if (persist) await persistTerminalModelPreference(provider, selection.model, { routingMode: "manual" });
  return [`Model switched: ${provider} / ${selection.model}`];
}

async function terminalRoutingLines(): Promise<string[]> {
  const settings = await loadUiSettings();
  const routing = settings.routing ?? {};
  return [
    `routing mode: ${settings.routingMode ?? "manual"}`,
    ...ROUTE_LANES.map((lane) => {
      const entry = routing[lane];
      return `${lane.padEnd(8)} ${entry ? `${entry.family} / ${entry.model}` : "(main model)"}`;
    }),
    "Set lane: /routing <chat|coding|research|tool-use> <provider> <model>",
    "Mode: /routing auto | /routing manual | /routing clear | /routing remove <lane>",
  ];
}

export async function applyTerminalRoutingCommand(raw: string): Promise<string[]> {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const settings = await loadUiSettings();
  const routing = { ...(settings.routing ?? {}) };
  const op = parts[0]?.toLowerCase();
  if (!op) return terminalRoutingLines();
  if (op === "auto" || op === "manual") {
    await updateUiSettings({ routingMode: op });
    return [`Routing mode set to ${op}.`];
  }
  if (op === "clear") {
    await updateUiSettings({ routing: {}, routingMode: "manual" });
    return ["Routing cleared."];
  }
  if (op === "remove") {
    const lane = parts[1] as keyof NonNullable<UiSettings["routing"]> | undefined;
    if (!lane || !ROUTE_LANES.includes(lane as (typeof ROUTE_LANES)[number])) return ["Usage: /routing remove <chat|coding|research|tool-use>"];
    delete routing[lane];
    await updateUiSettings({ routing, routingMode: Object.keys(routing).length ? settings.routingMode ?? "auto" : "manual" });
    return [`Removed routing for ${lane}.`];
  }
  const lane = op as keyof NonNullable<UiSettings["routing"]>;
  const provider = parts[1]?.toLowerCase();
  const model = parts.slice(2).join(" ");
  if (!ROUTE_LANES.includes(lane as (typeof ROUTE_LANES)[number]) || !provider || !model) {
    return ["Usage: /routing <chat|coding|research|tool-use> <provider> <model>"];
  }
  if (!isTerminalProviderId(provider) || provider === "mock") return [`Unsupported routing provider: ${provider}`, `Available: ${TERMINAL_PROVIDERS.filter((p) => p !== "mock").join(", ")}`];
  routing[lane] = { family: provider, model };
  await updateUiSettings({ routing, routingMode: "auto" });
  return [`${lane} lane routed to ${provider} / ${model}.`, "Routing mode set to auto."];
}

export async function applyTerminalAutoRouting(live: LiveSession, goal: string): Promise<void> {
  const settings = await loadUiSettings();
  if (settings.routingMode !== "auto") return;
  const recentGoals = live.session
    .history()
    .filter((message) => message.role === "user" && !message.content.some((block) => block.type === "tool_result"))
    .slice(-2)
    .map((message) => messageText(message));
  const lane = classifyLane([...recentGoals, goal].join("\n"));
  const assigned = settings.routing?.[lane];
  const currentProvider = providerFamilyForSelection(live.selection);
  const laneChanged = live.routeLane !== undefined && live.routeLane !== lane;
  const firstTurn = live.routeLane === undefined;
  const onAssigned = !!assigned && assigned.family === currentProvider && assigned.model === live.selection.model;
  if (assigned?.family && assigned.model && !onAssigned && (laneChanged || firstTurn)) {
    await switchTerminalModel(live, assigned.family, assigned.model, false).catch(() => undefined);
  }
  live.routeLane = lane;
}

export async function checkpointLines(context = cliRuntimeContext()): Promise<string[]> {
  const checkpoints = await listWorkspaceCheckpoints(context.workspace);
  if (checkpoints.length === 0) return ["No checkpoints in this workspace yet."];
  return checkpoints
    .slice(0, 20)
    .map((cp) => `${cp.id}  ${cp.createdAt}  ${cp.fileManifest.length} files${cp.label ? `  ${cp.label}` : ""}`);
}

export async function checkpointDiffLines(id: string, context = cliRuntimeContext()): Promise<string[]> {
  if (!id) return ["Usage: /checkpoint-diff <id>"];
  try {
    const diff = await diffWorkspaceCheckpoint(context.workspace, id);
    return [
      `added: ${diff.added.length}`,
      ...diff.added.slice(0, 20).map((f) => `+ ${f}`),
      `modified: ${diff.modified.length}`,
      ...diff.modified.slice(0, 20).map((f) => `~ ${f}`),
      `deleted: ${diff.deleted.length}`,
      ...diff.deleted.slice(0, 20).map((f) => `- ${f}`),
    ];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

export async function rollbackLines(id: string, context = cliRuntimeContext()): Promise<string[]> {
  if (!id) return ["Usage: /rollback <checkpoint-id>"];
  try {
    const result = await restoreWorkspaceCheckpoint(context.workspace, id);
    return [`restored ${result.restored} file(s)`, `deleted ${result.deleted} file(s)`];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

export async function undoLines(live: LiveSession, rawDepth = ""): Promise<string[]> {
  const depth = rawDepth.trim() ? Number(rawDepth.trim()) : 1;
  if (!Number.isInteger(depth) || depth < 1) return ["Usage: /undo [N]"];
  const checkpoints = await listWorkspaceCheckpoints(live.context.workspace);
  const target = checkpoints[depth - 1];
  if (!target) return [`No checkpoint ${depth} step(s) back.`];
  try {
    const result = await restoreWorkspaceCheckpoint(live.context.workspace, target.id);
    live.queueSystemReminder(
      `User invoked /undo ${depth}. Restored workspace to checkpoint ${target.id}. Re-read affected files before editing again.`,
      "undo",
    );
    return [
      `undid to ${target.id}`,
      `restored ${result.restored} file(s)`,
      `deleted ${result.deleted} file(s)`,
    ];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

export function resumeMessageLimit(): number | undefined {
  const raw = process.env.ARES_RESUME_MESSAGES;
  if (!raw) return 400;
  if (raw === "0" || raw.toLowerCase() === "all") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 80;
  return Math.max(8, Math.floor(parsed));
}

const GOD_OF_WAR_THEMES = new Set(["rage", "bronze", "crimson", "steel", "nightfall", "verdant"]);

export async function loadSavedTheme(): Promise<void> {
  const settings = await loadUiSettings();
  // Unify with the desktop, which only has god-of-war themes. A persisted
  // legacy terminal-only theme (amber/cyberpunk/graphite/…) maps to the rage
  // default so everyone gets the redesigned face; an explicit god-of-war pick
  // is honored.
  if (settings.theme && GOD_OF_WAR_THEMES.has(settings.theme)) setTheme(settings.theme);
  else setTheme("rage");
}

export async function saveTheme(name: string): Promise<void> {
  await updateUiSettings({ theme: name as ThemeName });
}

export async function contentFromUserInput(text: string, workspace: string): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [];
  const seen = new Set<string>();
  const maxImageCount = 8;
  const maxImageBase64Chars = 2_000_000;
  const maxTotalImageBase64Chars = 4_000_000;
  let imageCount = 0;
  let totalImageBase64Chars = 0;
  const reserveImage = (dataChars: number, label: string): void => {
    if (dataChars > maxImageBase64Chars) {
      throw new Error(`${label} is too large; each image must be about 1.5 MB or smaller after encoding`);
    }
    if (imageCount >= maxImageCount) {
      throw new Error(`too many image attachments; send at most ${maxImageCount} images in one message`);
    }
    if (totalImageBase64Chars + dataChars > maxTotalImageBase64Chars) {
      throw new Error("image attachments exceed the safe request budget; send fewer or smaller images");
    }
    imageCount++;
    totalImageBase64Chars += dataChars;
  };

  // Never silently turn an unsupported image into a giant text prompt. The
  // provider wire supports these four MIME types; Desktop mirrors this set.
  const supportedMediaTypes = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
  const anyImageDataUrlRe = /data:(image\/[a-z0-9.+-]+)[^,\r\n]*;base64,/gi;
  const imageDataUrlHeaders = [...text.matchAll(anyImageDataUrlRe)];
  for (const match of imageDataUrlHeaders) {
    const mediaType = match[1].toLowerCase();
    if (!supportedMediaTypes.has(mediaType)) {
      throw new Error(`unsupported image type ${mediaType}; use PNG, JPEG, WebP, or GIF`);
    }
  }
  const dataUrlRe = /data:(image\/(?:png|jpe?g|webp|gif))[^,\r\n]*;base64,([A-Za-z0-9+/=]+)/gi;
  let parsedImageDataUrls = 0;
  for (const match of text.matchAll(dataUrlRe)) {
    parsedImageDataUrls++;
    // Similar screenshots commonly share a long base64 prefix. The old
    // 80-character key silently collapsed distinct frames into one image.
    const key = match[0];
    if (seen.has(key)) continue;
    reserveImage(match[2].length, `inline ${match[1].toLowerCase()} image`);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match[2])) {
      throw new Error(`malformed base64 for inline ${match[1].toLowerCase()} image`);
    }
    seen.add(key);
    const mediaType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
    content.push({ type: "image", source: { kind: "base64", mediaType, data: match[2] } });
  }
  if (parsedImageDataUrls !== imageDataUrlHeaders.length) {
    throw new Error("malformed image data URL; use a complete base64-encoded PNG, JPEG, WebP, or GIF");
  }

  for (const candidate of imagePathCandidates(text)) {
    const resolved = path.resolve(workspace, candidate);
    if (seen.has(resolved)) continue;
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) continue;
    if (info.size > 15 * 1024 * 1024) {
      throw new Error(`image ${path.basename(resolved)} is larger than 15 MB; resize it and try again`);
    }
    const mediaType = mediaTypeForPath(resolved);
    if (!mediaType) continue;
    const bytes = await readFile(resolved);
    const encoded = bytes.toString("base64");
    reserveImage(encoded.length, `image ${path.basename(resolved)}`);
    seen.add(resolved);
    content.push({ type: "image", source: { kind: "base64", mediaType, data: encoded } });
  }

  const stripped = text.replace(dataUrlRe, "[attached image]").trim();
  content.unshift({ type: "text", text: stripped || "Please inspect the attached image." });
  return content;
}

function imagePathCandidates(text: string): string[] {
  const out: string[] = [];
  const quoted = /["']([^"']+\.(?:png|jpe?g|webp|gif))["']/gi;
  for (const match of text.matchAll(quoted)) out.push(match[1]);
  const bare = /(?:^|\s)(@?(?:[A-Za-z]:\\|\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])[^"'<>|?*\s]+\.(?:png|jpe?g|webp|gif))/gi;
  for (const match of text.matchAll(bare)) out.push(match[1].replace(/^@/, ""));
  return out;
}

function mediaTypeForPath(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

export function legacyProgressText(data: unknown): string | null {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : null;
  const obj = data as Record<string, unknown>;
  if (obj.kind === "shell_output") {
    const text = String(obj.text ?? "").trimEnd();
    return text ? `${obj.stream ?? "stdout"} ${text}`.slice(0, 240) : null;
  }
  if (obj.kind === "grep_match") return `grep ${obj.total ?? "?"} match(es)`;
  if (obj.kind === "lsp_init") return `starting ${obj.server ?? "LSP"}`;
  if (obj.kind === "lsp_ready") return `${obj.server ?? "LSP"} ready`;
  return JSON.stringify(obj).slice(0, 240);
}

export function colorUnifiedDiff(diff: string): string {
  const color = process.env.NO_COLOR ? false : Boolean(process.stderr.isTTY);
  const paint = (code: string, text: string) => (color ? `${code}${text}\x1b[0m` : text);
  return diff
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return paint("\x1b[32m", line);
      if (line.startsWith("-") && !line.startsWith("---")) return paint("\x1b[31m", line);
      if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) return paint("\x1b[36m", line);
      return dim(line);
    })
    .join("\n") + "\n";
}

export function usageMeter(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }, durationMs: number): string {
  const cached = usage.cacheReadTokens ?? 0;
  const denom = usage.inputTokens;
  const cachePct = denom > 0 ? Math.round((cached / denom) * 100) : 0;
  const inputPerM = Number(process.env.ARES_COST_INPUT_PER_MTOK ?? 0);
  const outputPerM = Number(process.env.ARES_COST_OUTPUT_PER_MTOK ?? 0);
  const cost =
    Number.isFinite(inputPerM) && Number.isFinite(outputPerM) && (inputPerM > 0 || outputPerM > 0)
      ? `$${(((Math.max(0, usage.inputTokens - cached) / 1_000_000) * inputPerM) + ((usage.outputTokens / 1_000_000) * outputPerM)).toFixed(4)}`
      : "$n/a";
  return `${cost} / ${Math.round(durationMs / 1000)}s / ${usage.inputTokens + usage.outputTokens} tokens / ${cachePct}% cached`;
}
