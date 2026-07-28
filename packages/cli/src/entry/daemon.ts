// Extracted from entry.ts — daemon.

import { authStatus, listSessions, loadSessionSnapshot, loadSessionRollout, deleteSession, renameSession, type Provider, classifyLane, runAnthropicLoginFlow, sideQuery, sideQueryJson, QueryEngine, installGlobalCrashHandlers, EventRing, probeCredentialEncryption, connectMcpServer, disconnectMcpServer, setMcpServerEnabled, loadRemoteMcpServers, connectorNameFromUrl, fetchOpenRouterModels, runOpenAILoginFlow } from "@ares/core";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import type { PermissionMode, PermissionPromptDecision, TurnEvent } from "@ares/protocol";
import { isReasoningLevel, REASONING_LEVELS, messageText, redactSecrets } from "@ares/protocol";
import type { ToolPermissionRequest, RouteAssignments } from "@ares/core";
import { notice } from "../terminalUi.js";
import { loadUiSettings, updateUiSettings, type UiSettings } from "../uiSettings.js";
import { DEFAULT_PERMISSIONS, decidePermission, type PermissionSettings } from "../permissionPolicy.js";
import { consciousnessStatus, downloadAllConsciousnessModels } from "../consciousness.js";
import { describeImage, engineStatus } from "../visionEngine.js";
import { prepareEngineBinary } from "../engineBinary.js";
import { captureScreen } from "../screenCapture.js";
import { ConsciousnessWatch, WATCHER_VOICE_PROMPT } from "../watch.js";
import { recordConsciousnessObservation } from "../consciousnessContext.js";
import { aresAgentHome, onLifecycle, runSkill, skillHubProbe, skillHubList, skillHubGet, skillHubPublish, installHubSkill, readLocalSkillFiles } from "@ares/agent";
import { QueryEngineDispatcher, OperatorBackgroundLoop, deriveLeash, domainOf, isOperatorPaused, listGoals, loadStandingOrders, materializeDueStandingOrders, type StandingOrder } from "@ares/operator";
import { MemoryStore, reflectOnRun, detectWorkspaceProjectId, loadProjectState, buildConversationDigest, mergeDurableFacts, CONVERSATION_REFLECT_SYSTEM, DURABLE_FACTS_SCHEMA_HINT, type DurableFact } from "@ares/mind";
import { OAUTH_PROVIDERS, PROVIDER_LABELS, startOAuthFlow, connectedProviders, getProviderConfig, setCredential, hasCredential, deleteCredential, clientIdName, clientSecretName, runAresAccountSignin, probeAresOauth } from "@ares/core";
import { KillSwitch } from "@ares/effects";
import { gateToolPermission } from "../policyGate.js";
import { embeddedBridge, setExtensionBrowserBridge } from "./browserBridge.js";
import { BrowserBridgeServer } from "@ares/browser-extension-connector";
import { garrisonCommand } from "./garrisonCmd.js";
import { createVanguardDrive } from "./vanguardHost.js";
import { cleanCommandId, normalizePermissionDecision } from "./permissions.js";
import { aresGatewayBase, daemonModelCatalog, fetchAresGatewayMe, fetchCustomOpenAiModels, postAresGatewayReport, preflightProviderSelection, providerFamilyForSelection, selectProvider, type ProviderSelection } from "./providers.js";
import { ParsedArgs, cliVersion } from "./runtime.js";
import { LiveSession, chatContextBudget, createSession, createSessionWithSelection, handleReasoningCommand, isProviderFatalError, makeSpanSummarizer, modelLikelyHasVision, pickHealthyFallback, pickVisionFallback, resolveReasoningLevel } from "./sessionFactory.js";
import { startGatewayMirror } from "./telegramWiring.js";
import { contentFromUserInput, undoLines } from "./terminalLines.js";
import { buildSystemPrompt, disposeLiveSession, finishTurn, gatherGitRunFacts, mindSessionEnded, prepareUserTurn } from "./turnPipeline.js";

interface DaemonInputCommand {
  type?: string;
  /** gateway_connect */
  token?: string;
  url?: string;
  /** bug_report — optional user description of what went wrong. */
  note?: string;
  /** discover_custom_models — OpenAI-compatible base URL to probe. */
  base?: string;
  goal?: string;
  /** Structured hands-free mode; excluded from goal classification/history. */
  voice?: boolean;
  command?: string;
  level?: string;
  id?: string;
  decision?: string;
  routing?: unknown;
  /** set_permissions payload — owner permission posture toggles. */
  permissions?: PermissionSettings;
  key?: string;
  model?: string;
  provider?: string;
  /** Custom OpenAI-compatible provider base URL (provider_key with provider="custom"). */
  baseUrl?: string;
  config?: unknown;
  name?: string;
  enabled?: boolean;
  days?: number;
  depth?: number;
  /** consciousness_look_away pause duration. */
  seconds?: number;
  text?: string;
  /** New session name for session_rename (empty clears the custom label). */
  label?: string;
  /** OAuth: provider id + app credentials for oauth_* commands. */
  clientId?: string;
  clientSecret?: string;
  /** Embedded-browser bridge result fields (webview_result). */
  cmdId?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  /** Which UI chat/session this command targets (multi-session daemon). */
  sessionId?: string;
  /** operator_control payload: "halt" engages the kill switch, "resume" releases it. */
  action?: string;
  /** operator_control halt reason (freeform, logged with the kill-switch flag file). */
  reason?: string;
  /** skill_invoke payload — JSON handed to the skill's handler(input, ctx). */
  input?: unknown;
  /** skill_invoke correlation id — echoed back in skill_result so the UI can
   *  match a response to the exact call (TTS utterances, surface clicks). */
  invokeId?: string;
}

const ROUTING_LANES = ["chat", "coding", "research", "tool-use"] as const;

/** Cap a bug-report rollout so even an extreme session gzips under the gateway's
 *  request-body limit. Deep-clones while truncating any single string over
 *  ~256KB (base64 images, huge tool outputs), then, if the whole thing is still
 *  over ~28MB serialized, keeps the MOST RECENT events (where the failure being
 *  reported usually is) and notes how many were dropped. */
function trimRolloutForReport(entries: unknown[]): unknown[] {
  const MAX_STRING = 256 * 1024;
  const MAX_TOTAL = 28 * 1024 * 1024;
  const truncateStrings = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[trimmed ${value.length - MAX_STRING} chars]` : value;
    }
    if (Array.isArray(value)) return value.map(truncateStrings);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = truncateStrings(v);
      return out;
    }
    return value;
  };
  const trimmed = entries.map(truncateStrings);
  if (JSON.stringify(trimmed).length <= MAX_TOTAL) return trimmed;
  // Still too big: keep the tail (recent events) that fits the budget.
  const kept: unknown[] = [];
  let size = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const len = JSON.stringify(trimmed[i]).length + 1;
    if (size + len > MAX_TOTAL) break;
    kept.unshift(trimmed[i]);
    size += len;
  }
  const dropped = trimmed.length - kept.length;
  if (dropped > 0) {
    kept.unshift({ ts: null, seq: -1, event: { type: "report_note", text: `[${dropped} earlier events omitted to fit the size limit]` } });
  }
  return kept;
}

/** Normalize the UI's {provider,model} routing table into core's {family,model}. */
function normalizeRoutingCommand(raw: unknown): RouteAssignments {
  const out: RouteAssignments = {};
  if (!raw || typeof raw !== "object") return out;
  for (const lane of ROUTING_LANES) {
    const entry = (raw as Record<string, unknown>)[lane];
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const family = typeof rec.family === "string" ? rec.family : typeof rec.provider === "string" ? rec.provider : "";
      const model = typeof rec.model === "string" ? rec.model : "";
      if (family && model) out[lane] = { family, model };
    }
  }
  return out;
}

/** Coerce the UI's engine-config payload into a clean EngineConfig. */
function normalizeEngineConfig(raw: unknown): import("../uiSettings.js").EngineConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : undefined;
  };
  return {
    maxTurns: num(r.maxTurns, 10, 1000),
    gatherStallRounds: num(r.gatherStallRounds, 2, 50),
    toolResultChars: num(r.toolResultChars, 2000, 200_000),
    operatorAutotick: typeof r.operatorAutotick === "boolean" ? r.operatorAutotick : undefined,
    operatorTickMinutes: num(r.operatorTickMinutes, 1, 720),
    subagentTurnLimit: num(r.subagentTurnLimit, 5, 200),
    computerUseBrowser: typeof r.computerUseBrowser === "boolean" ? r.computerUseBrowser : undefined,
  };
}

/** Apply the env-backed engine knobs immediately (no restart for these). */
export function applyEngineConfigEnv(cfg: import("../uiSettings.js").EngineConfig): void {
  if (cfg.gatherStallRounds) process.env.ARES_GATHER_STALL_ROUNDS = String(cfg.gatherStallRounds);
  if (cfg.toolResultChars) process.env.ARES_TOOL_RESULT_CHARS = String(cfg.toolResultChars);
  // The operator loop is opt-IN (ARES_OPERATOR_LOOP=1). The UI "autotick" toggle
  // drives it; an explicit false also trips the emergency kill so it's truly off.
  if (cfg.operatorAutotick === false) {
    process.env.ARES_OPERATOR_LOOP = "0";
    process.env.ARES_OPERATOR_AUTOTICK = "0";
  } else if (cfg.operatorAutotick === true) {
    process.env.ARES_OPERATOR_LOOP = "1";
    delete process.env.ARES_OPERATOR_AUTOTICK;
  }
  if (cfg.subagentTurnLimit) process.env.ARES_SUBAGENT_TURN_LIMIT = String(cfg.subagentTurnLimit);
  if (cfg.operatorTickMinutes) process.env.ARES_OPERATOR_TICK_MS = String(cfg.operatorTickMinutes * 60_000);
  // Owner opt-in: desktop control of real browser windows. Explicit false
  // clears it so flipping the toggle off takes effect without a restart.
  if (cfg.computerUseBrowser === true) process.env.ARES_COMPUTERUSE_ALLOW_BROWSER = "1";
  else if (cfg.computerUseBrowser === false) delete process.env.ARES_COMPUTERUSE_ALLOW_BROWSER;
}

/** A UI surface a skill contributes — a button (and, later, toggles/panels)
 *  that the app renders in the active-skills tray. Clicking it invokes the
 *  skill itself with `input` (the whole security model: a surface can only run
 *  its own skill). */
interface SkillSurface {
  id: string;
  label: string;
  icon?: string;
  kind?: "button" | "toggle";
  /** JSON passed to the skill's handler when the surface is activated. */
  input?: unknown;
  /** Optional hint shown on hover. */
  hint?: string;
}

interface DaemonSkillInfo {
  name: string;
  description: string;
  status: string;
  category: string;
  enabled: boolean;
  /** Capabilities this skill supplies (e.g. ["tts"]) — Ares routes the matching
   *  built-in through the toggled-on provider skill instead. */
  provides: string[];
  /** UI buttons this skill contributes to the active-skills tray. */
  surfaces: SkillSurface[];
  /** Whether this skill has executable code, versus prompt/docs only. */
  runnable: boolean;
  modifiedAt?: number;
}

/** Parse a `surfaces:` value (JSON array) into validated SkillSurface[]. Tolerant:
 *  a malformed value yields no surfaces rather than breaking the whole list. */
export function parseSurfaces(raw: string): SkillSurface[] {
  if (!raw || !raw.trim().startsWith("[")) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: SkillSurface[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const id = typeof s.id === "string" ? s.id : "";
    const label = typeof s.label === "string" ? s.label : "";
    if (!id || !label) continue;
    out.push({
      id,
      label,
      icon: typeof s.icon === "string" ? s.icon : undefined,
      kind: s.kind === "toggle" ? "toggle" : "button",
      input: s.input,
      hint: typeof s.hint === "string" ? s.hint : undefined,
    });
    if (out.length >= 12) break; // a tray, not a dashboard
  }
  return out;
}

export function inferSkillProvides(entryName: string, skillMd: string, surfaces: SkillSurface[], declared: string[]): string[] {
  const provides = new Set(declared.map((s) => s.trim()).filter(Boolean));
  const surfaceProvidesTts = surfaces.some((surface) => {
    const input = surface.input;
    return !!input && typeof input === "object" && (input as Record<string, unknown>).op === "tts";
  });
  const bodyClaimsTts =
    /\bprovides\s+(?:the\s+)?['"`]?tts['"`]?\s+capability\b/i.test(skillMd) ||
    /\btext[- ]to[- ]speech\b/i.test(skillMd) ||
    // Known voice engines named in the manifest are as clear a signal as any.
    /\b(piper|kokoro|elevenlabs|coqui)\b/i.test(skillMd);
  // "tts" anywhere in the skill's NAME (piper_tts, tts-eleven, my_tts…) — users
  // name their voice skills exactly this way and expect them to just be used.
  const nameSignalsTts = /(^|[_-])tts([_-]|$)/i.test(entryName);

  // A hand-authored voice provider should not fail silently because its
  // frontmatter omitted one line. The explicit `provides:` field still wins,
  // but a tts-ish name, a TTS surface, or a clear manifest body claim are
  // enough for the desktop to route speech through the provider.
  if (!provides.has("tts") && (nameSignalsTts || surfaceProvidesTts || bodyClaimsTts)) {
    provides.add("tts");
  }
  // Same courtesy for speech-to-text providers (whisper.cpp, Deepgram, …):
  // a transcribe surface, an stt name, or a clear body claim registers them.
  const surfaceProvidesStt = surfaces.some((surface) => {
    const input = surface.input;
    return !!input && typeof input === "object" && (input as Record<string, unknown>).op === "transcribe";
  });
  const bodyClaimsStt =
    /\bprovides\s+(?:the\s+)?['"`]?stt['"`]?\s+capability\b/i.test(skillMd) ||
    /\bspeech[- ]to[- ]text\b/i.test(skillMd);
  if (!provides.has("stt") && (entryName === "stt" || surfaceProvidesStt || bodyClaimsStt)) {
    provides.add("stt");
  }
  return [...provides];
}

/** List skills under ~/.ares/skills, parsing SKILL.md frontmatter + enabled set. */
async function daemonSkillsList(home: string): Promise<DaemonSkillInfo[]> {
  const settings = await loadUiSettings();
  const disabled = new Set(settings.disabledSkills ?? []);
  const skillsDir = path.join(aresAgentHome(home), "skills");
  let entries: import("node:fs").Dirent[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: DaemonSkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const md = path.join(skillsDir, entry.name, "SKILL.md");
    const text = await readFile(md, "utf8").catch(() => "");
    if (!text) continue;
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const field = (key: string) => fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
    // Multi-line frontmatter tolerance: authors write normal YAML —
    //   provides:
    //     - tts
    // or a surfaces JSON array spread over lines. Capture everything from the
    // key to the next top-level key and flatten it, so those parse instead of
    // silently yielding nothing (the old reader was strictly single-line).
    const fieldBlock = (key: string) => {
      const lines = (fm?.[1] ?? "").split("\n");
      const start = lines.findIndex((l) => l.startsWith(`${key}:`));
      if (start < 0) return "";
      const out: string[] = [lines[start].slice(key.length + 1)];
      for (let i = start + 1; i < lines.length; i++) {
        if (/^\S/.test(lines[i])) break; // next top-level key
        out.push(lines[i]);
      }
      return out.join("\n").trim();
    };
    const listField = (key: string) => {
      const inline = field(key);
      if (inline && !inline.startsWith("-")) return inline.split(",").map((s) => s.trim()).filter(Boolean);
      const block = fieldBlock(key);
      const items = [...block.matchAll(/^\s*-\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      return items.length > 0 ? items : inline.split(",").map((s) => s.trim()).filter(Boolean);
    };
    const declaredProvides = listField("provides");
    let surfaces = parseSurfaces(field("surfaces"));
    if (surfaces.length === 0) {
      const block = fieldBlock("surfaces").split("\n").map((l) => l.trim()).join(" ").trim();
      if (block.startsWith("[")) surfaces = parseSurfaces(block);
    }
    if (surfaces.length === 0) {
      const sj = await readFile(path.join(skillsDir, entry.name, "surfaces.json"), "utf8").catch(() => "");
      if (sj) surfaces = parseSurfaces(sj);
    }
    const provides = inferSkillProvides(entry.name, text, surfaces, declaredProvides);
    const handlerPath = path.join(skillsDir, entry.name, "handler.js");
    const handlerStat = await stat(handlerPath).catch(() => null);
    const manifestStat = await stat(md).catch(() => null);
    skills.push({
      name: entry.name,
      description: field("description") || "Local skill.",
      status: field("status") || "ready",
      category: field("category") || "general",
      enabled: !disabled.has(entry.name),
      provides,
      surfaces,
      runnable: !!handlerStat,
      modifiedAt: Math.max(handlerStat?.mtimeMs ?? 0, manifestStat?.mtimeMs ?? 0) || undefined,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** One row per connected remote MCP connector, shaped for the /mcp explorer. */
async function mcpDirectorySnapshot(): Promise<Array<{ name: string; url: string; displayName: string; oauth: boolean; connectedAt: string | null; enabled: boolean }>> {
  const servers = await loadRemoteMcpServers().catch(() => ({}));
  return Object.entries(servers).map(([name, e]) => ({
    name,
    url: e.url,
    displayName: e.displayName ?? name,
    oauth: !!e.oauth,
    connectedAt: e.connectedAt ?? null,
    enabled: e.enabled !== false,
  }));
}

interface UsageStats {
  sessions: number;
  apiCalls: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  auxiliaryTokensIn: number;
  auxiliaryTokensOut: number;
  daily: Array<{ date: string; in: number; out: number }>;
  models: Array<{ model: string; provider?: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number; costUsd?: number }>;
  /** Per-provider rollup (tokens, requests, estimated spend) — the DeepSeek-
   *  platform-style view. Cost is an estimate from live OpenRouter pricing
   *  where the model is listed there; undefined = unknown, 0 = local/free. */
  providers: Array<{ provider: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number; costUsd?: number }>;
}

/** Estimate spend for a model from live OpenRouter pricing (matched by id
 *  suffix). Local ollama = $0. Returns undefined when the price is unknown. */
function estimateCostUsd(
  provider: string,
  model: string,
  usage: { tokensIn: number; tokensOut: number; cacheReadTokens: number },
  orPrices: Map<string, { input: number; output: number }>,
): number | undefined {
  if (provider === "ollama" && !model.includes("cloud")) return 0;
  if (provider === "mock") return 0;
  const bare = model.toLowerCase();
  let price = orPrices.get(bare);
  if (!price) {
    for (const [id, p] of orPrices) {
      if (id.endsWith(`/${bare}`) || bare === id.split("/").pop()) {
        price = p;
        break;
      }
    }
  }
  if (!price) return undefined;
  // Cache reads bill at roughly a tenth of input on the major providers.
  const uncachedIn = Math.max(0, usage.tokensIn - usage.cacheReadTokens);
  return (uncachedIn / 1e6) * price.input + (usage.cacheReadTokens / 1e6) * price.input * 0.1 + (usage.tokensOut / 1e6) * price.output;
}

/** Aggregate usage across all on-disk sessions within the trailing window. */
async function daemonUsageStats(workspace: string, days: number): Promise<UsageStats> {
  const sessionsRoot = path.join(workspace, ".ares", "sessions");
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const daily = new Map<string, { in: number; out: number }>();
  const models = new Map<string, { provider: string; model: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number }>();
  const providers = new Map<string, { tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number }>();
  let sessions = 0;
  let apiCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let auxiliaryTokensIn = 0;
  let auxiliaryTokensOut = 0;
  let dirents: import("node:fs").Dirent[];
  try {
    const { readdir } = await import("node:fs/promises");
    dirents = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return {
      sessions: 0,
      apiCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      auxiliaryTokensIn: 0,
      auxiliaryTokensOut: 0,
      daily: [],
      models: [],
      providers: [],
    };
  }
  const { stat: statFn } = await import("node:fs/promises");
  for (const dir of dirents) {
    if (!dir.isDirectory()) continue;
    const sessionDir = path.join(sessionsRoot, dir.name);
    const st = await statFn(path.join(sessionDir, "events.jsonl")).catch(() => null);
    if (!st || st.mtimeMs < cutoff) continue;
    const metaRaw = await readFile(path.join(sessionDir, "meta.json"), "utf8").catch(() => "");
    let model = "unknown";
    let sessionProvider = "unknown";
    try {
      const meta = JSON.parse(metaRaw) as { provider?: { model?: string; name?: string } };
      if (meta.provider?.model) model = meta.provider.model;
      if (meta.provider?.name) sessionProvider = meta.provider.name;
    } catch {
      /* unknown model */
    }
    const eventsText = await readFile(path.join(sessionDir, "events.jsonl"), "utf8").catch(() => "");
    if (!eventsText) continue;
    let sIn = 0;
    let sOut = 0;
    let counted = false;
    for (const line of eventsText.split(/\r?\n/)) {
      if (!line) continue;
      let entry: {
        ts?: string | number;
        event?: {
          type?: string;
          model?: string;
          provider?: string;
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            modelCalls?: number;
          };
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ev = entry.event;
      if ((ev?.type !== "turn_end" && ev?.type !== "auxiliary_usage") || !ev.usage) continue;
      const inTok = ev.usage.inputTokens ?? 0;
      const outTok = ev.usage.outputTokens ?? 0;
      const cached = ev.usage.cacheReadTokens ?? 0;
      const calls = ev.usage.modelCalls ?? 1;
      const eventModel = ev.model || model;
      // Session persistence stamps provider on turn_end/auxiliary_usage — use
      // it for a real per-provider rollup (the old code discarded it).
      const eventProvider = (ev.provider || sessionProvider).toLowerCase();
      apiCalls += calls;
      tokensIn += inTok;
      tokensOut += outTok;
      cacheReadTokens += cached;
      if (ev.type === "auxiliary_usage") {
        auxiliaryTokensIn += inTok;
        auxiliaryTokensOut += outTok;
      }
      sIn += inTok;
      sOut += outTok;
      counted = true;
      const mKey = `${eventProvider} ${eventModel}`;
      const m = models.get(mKey) ?? { provider: eventProvider, model: eventModel, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, calls: 0 };
      m.tokensIn += inTok;
      m.tokensOut += outTok;
      m.cacheReadTokens += cached;
      m.calls += calls;
      models.set(mKey, m);
      const p = providers.get(eventProvider) ?? { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, calls: 0 };
      p.tokensIn += inTok;
      p.tokensOut += outTok;
      p.cacheReadTokens += cached;
      p.calls += calls;
      providers.set(eventProvider, p);
      // Per-entry timestamp beats file mtime: a week-long session no longer
      // dumps all its tokens onto its last-touched day.
      const entryMs = entry.ts ? new Date(entry.ts).getTime() : NaN;
      const day = new Date(Number.isFinite(entryMs) ? entryMs : st.mtimeMs).toISOString().slice(0, 10);
      const d = daily.get(day) ?? { in: 0, out: 0 };
      d.in += inTok;
      d.out += outTok;
      daily.set(day, d);
    }
    if (counted) sessions++;
  }
  // Live OpenRouter pricing turns tokens into estimated dollars where the
  // model is listed there (most frontier + open models are). Cached; a
  // network failure simply leaves cost undefined.
  const orPrices = new Map<string, { input: number; output: number }>();
  const orModels = await fetchOpenRouterModels().catch(() => []);
  for (const m of orModels) {
    if (m.promptPrice == null && m.completionPrice == null) continue;
    orPrices.set(m.id.toLowerCase(), { input: Number(m.promptPrice ?? 0) * 1e6, output: Number(m.completionPrice ?? 0) * 1e6 });
  }
  const dailyArr = [...daily.entries()].map(([date, v]) => ({ date, in: v.in, out: v.out })).sort((a, b) => a.date.localeCompare(b.date));
  const modelArr = [...models.values()]
    .map((v) => ({ ...v, costUsd: estimateCostUsd(v.provider, v.model, v, orPrices) }))
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
  const providerArr = [...providers.entries()]
    .map(([provider, v]) => {
      const providerModels = modelArr.filter((m) => m.provider === provider);
      const known = providerModels.filter((m) => m.costUsd !== undefined);
      // A provider's cost is only meaningful if every model under it priced.
      const costUsd = known.length === providerModels.length && providerModels.length > 0
        ? known.reduce((total, m) => total + (m.costUsd ?? 0), 0)
        : known.length > 0
          ? known.reduce((total, m) => total + (m.costUsd ?? 0), 0)
          : undefined;
      return { provider, ...v, costUsd };
    })
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
  return {
    sessions,
    apiCalls,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    auxiliaryTokensIn,
    auxiliaryTokensOut,
    daily: dailyArr,
    models: modelArr,
    providers: providerArr,
  };
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  shift(): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

class DaemonCommandRouter {
  private commands = new AsyncQueue<DaemonInputCommand>();
  private permissionResponses: DaemonInputCommand[] = [];
  private permissionWaiters: Array<{ id?: string; resolve: (command: DaemonInputCommand | null) => void }> = [];
  private closed = false;
  /** Out-of-band interrupt — fires immediately on parse, even mid-turn while
   *  the command loop is busy streaming. Carries the command so the handler can
   *  route to the right session. */
  onInterrupt: ((command: DaemonInputCommand) => void) | null = null;

  constructor(private readonly onError: (error: string) => void) {}

  start(rl: ReturnType<typeof createInterface>): void {
    void this.pump(rl);
  }

  nextCommand(): Promise<DaemonInputCommand | null> {
    return this.commands.shift();
  }

  async waitForPermission(request: ToolPermissionRequest): Promise<PermissionPromptDecision> {
    const response = await this.takePermissionResponse(request.id);
    if (!response) return "deny";
    const decision = normalizePermissionDecision(response.decision);
    if (!decision) {
      this.onError("permission_response requires decision: allow_once|allow_always|deny");
      return "deny";
    }
    return decision;
  }

  close(): void {
    this.closed = true;
    this.commands.close();
    for (const waiter of this.permissionWaiters.splice(0)) waiter.resolve(null);
  }

  private async pump(rl: ReturnType<typeof createInterface>): Promise<void> {
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let command: DaemonInputCommand;
        try {
          command = JSON.parse(line) as DaemonInputCommand;
        } catch {
          this.onError("invalid JSON command");
          continue;
        }
        if (command.type === "permission_response" || command.type === "permission") {
          this.pushPermissionResponse(command);
        } else if (command.type === "interrupt") {
          try {
            this.onInterrupt?.(command);
          } catch {
            // interrupting must never kill the daemon
          }
        } else {
          this.commands.push(command);
        }
      }
    } finally {
      this.close();
    }
  }

  private pushPermissionResponse(command: DaemonInputCommand): void {
    if (this.closed) return;
    const responseId = cleanCommandId(command.id);
    const waiterIndex = this.permissionWaiters.findIndex((waiter) => {
      if (!waiter.id || !responseId) return true;
      return waiter.id === responseId;
    });
    if (waiterIndex >= 0) {
      const [waiter] = this.permissionWaiters.splice(waiterIndex, 1);
      waiter.resolve(command);
      return;
    }
    this.permissionResponses.push(command);
  }

  private takePermissionResponse(id?: string): Promise<DaemonInputCommand | null> {
    const requestId = cleanCommandId(id);
    const responseIndex = this.permissionResponses.findIndex((command) => {
      const responseId = cleanCommandId(command.id);
      if (!requestId || !responseId) return true;
      return requestId === responseId;
    });
    if (responseIndex >= 0) {
      const [response] = this.permissionResponses.splice(responseIndex, 1);
      return Promise.resolve(response);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.permissionWaiters.push({ id: requestId, resolve }));
  }
}

export type ManualReminderSource =
  | "undo"
  | "hook"
  | "memory"
  | "instructions"
  | "heartbeat"
  | "dream"
  | "recall"
  | "self-revise";

export async function daemonCommand(args: ParsedArgs): Promise<number> {
  if (args.flags.get("json") !== "true" && !args.flags.has("json")) {
    process.stderr.write("error: daemon currently requires --json\n");
    return 2;
  }
  // Gateway account poll: when the owner-site token is configured, snapshot
  // /me every 20s — new credit grants become gateway_grant toasts in the UI,
  // and balance/model changes refresh the Account panel live. Silent on every
  // failure; a dead gateway can never affect the daemon.
  {
    let gwCursor: string | undefined;
    const gwPoll = setInterval(async () => {
      try {
        const settings = await loadUiSettings();
        if (!settings.aresGatewayToken) return;
        const me = await fetchAresGatewayMe(aresGatewayBase(settings), settings.aresGatewayToken, gwCursor);
        if (!me) return;
        for (const g of me.new_grants ?? []) {
          process.stdout.write(JSON.stringify({ type: "gateway_grant", amount_usd: g.amount_usd, reason: g.reason, at: g.at }) + "\n");
        }
        process.stdout.write(JSON.stringify({ type: "gateway_account", connected: true, ...me }) + "\n");
        gwCursor = me.server_time ?? gwCursor;
      } catch {
        // best-effort
      }
    }, 20_000);
    gwPoll.unref?.();
  }
  // Scrub the daemon's diagnostic stream. The desktop shell forwards this
  // process's stderr straight into the webview; a verbose provider/library debug
  // line with an embedded key would otherwise reach the UI (and a copied error
  // report) unredacted. stderr carries only free-text diagnostics here — the
  // structured protocol rides stdout — so redaction can never corrupt a payload.
  {
    const rawStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      try {
        if (typeof chunk === "string") return (rawStderrWrite as (c: string, ...r: unknown[]) => boolean)(redactSecrets(chunk), ...rest);
        if (chunk instanceof Uint8Array) {
          return (rawStderrWrite as (c: string, ...r: unknown[]) => boolean)(redactSecrets(Buffer.from(chunk).toString("utf8")), ...rest);
        }
      } catch {
        // never let redaction break diagnostics
      }
      return (rawStderrWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
  }
  const rl = createInterface({ input: stdin, output: stderr, terminal: false });
  const commands = new DaemonCommandRouter((error) => {
    process.stdout.write(JSON.stringify({ type: "daemon_error", error }) + "\n");
  });
  commands.start(rl);
  // Surface a plaintext-fallback vault loudly at startup — a leaked plaintext
  // credentials.json the owner never knew about was the worst security finding.
  void probeCredentialEncryption().then((enc) => {
    if (!enc.available) {
      process.stdout.write(
        JSON.stringify({
          type: "vault_warning",
          available: false,
          reason: enc.reason,
          message: "Credential encryption is unavailable; stored secrets are NOT encrypted at rest.",
        }) + "\n",
      );
    }
  });
  // The embedded-browser bridge speaks to the desktop UI over this daemon's
  // stdout (which the shell reads). webview_cmd goes out here; webview_result
  // comes back as a command (handled in the loop below).
  embeddedBridge.emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  // Desktop posture: give the agent real freedom so the flow isn't constantly
  // interrupted. Low-risk actions (web/browser/read/search/most tool use)
  // auto-approve; only genuinely sensitive ones (credentials, payments,
  // sending email, external accounts, destructive wipes) still ask the owner.
  const requestPermission = (request: ToolPermissionRequest): Promise<PermissionPromptDecision> => {
    // The owner is present at the desktop, so this is the ATTENDED gate: a
    // hard-blocked or staged action escalates to the owner rather than being
    // denied outright. The policy gate can only make things STRICTER than the
    // legacy regex (a structured risky category is upgraded to ask/deny); when it
    // has no opinion ("defer") we fall back to the existing auto decision so the
    // freedom posture for ordinary tools is untouched.
    const gate = gateToolPermission(request, { attended: true });
    if (gate.kind === "deny") return Promise.resolve("deny");
    // Owner permission policy (master/per-category toggles, read LIVE so the
    // Permissions tab applies mid-session). A soft gate "ask" (ComputerUse,
    // unknown categories) is subordinate to the owner's posture — otherwise
    // "free" mode would still nag on every desktop action, which is exactly
    // the regression the gate promises never to cause. Only a HARD block
    // (payments, email, credentials, destructive wipes) outranks the posture.
    const outcome = decidePermission(request, live?.runtime.permissions);
    if (gate.kind === "ask" && (gate.hardBlocked || outcome !== "allow")) {
      return commands.waitForPermission({ ...request, reason: gate.reason ?? request.reason });
    }
    return outcome === "allow" ? Promise.resolve("allow_once") : commands.waitForPermission(request);
  };
  let live: LiveSession;
  let browserExtensionBridge: BrowserBridgeServer | null = null;
  try {
    live = await createSession(args, undefined, requestPermission);
    const bridgeConfigPath = path.join(live.context.home, "browser-bridge", "config.json");
    try {
      const raw = JSON.parse(await readFile(bridgeConfigPath, "utf8")) as {
        host?: string;
        port?: number;
        hostToken?: string;
      };
      if (raw.host !== "127.0.0.1") throw new Error("host must be 127.0.0.1");
      if (!Number.isInteger(raw.port) || raw.port! < 1 || raw.port! > 65_535) throw new Error("port is invalid");
      if (typeof raw.hostToken !== "string" || raw.hostToken.length < 32) throw new Error("host token is invalid");
      browserExtensionBridge = new BrowserBridgeServer({ port: raw.port!, hostToken: raw.hostToken });
      await browserExtensionBridge.start();
      setExtensionBrowserBridge(browserExtensionBridge);
      process.stdout.write(JSON.stringify({ type: "browser_bridge_started", host: "127.0.0.1", port: raw.port }) + "\n");
    } catch (bridgeError) {
      if ((bridgeError as NodeJS.ErrnoException)?.code !== "ENOENT") {
        process.stdout.write(JSON.stringify({
          type: "browser_bridge_error",
          error: bridgeError instanceof Error ? bridgeError.message : String(bridgeError),
        }) + "\n");
      }
    }
  } catch (err) {
    setExtensionBrowserBridge(null);
    commands.close();
    rl.close();
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // ── multi-session registry ────────────────────────────────────────────────
  // Each UI chat card is an INDEPENDENT conversation with its own QueryEngine,
  // history, abort signal, tools, and checkpoints — no cross-talk. The bootstrap
  // session above becomes the entry for whichever card sends first; later cards
  // spawn fresh, lighter sessions (no duplicate background heartbeat). Every
  // event the daemon emits is tagged with its sessionId so the UI routes by id,
  // never by "active card".
  interface DaemonEntry {
    live: LiveSession;
    turnActive: boolean;
    pendingSteers: string[];
    landingSteers: Array<{ text: string; reminder: string }>;
    /** The lane (task domain) this session is currently on, for sticky auto
     *  routing — the model only switches when the lane actually changes. */
    lane?: string;
    /** Vanguard drive mode: sends route through the embedded Vanguard engine
     *  while the session keeps its Ares identity, selection, and transcript. */
    vanguardMode?: boolean;
    /** Where the drive engine works for this session; defaults to the Ares workspace. */
    vanguardWorkspace?: string;
  }
  const DEFAULT_SID = "__primary__";
  const sessions = new Map<string, DaemonEntry>();
  const primaryEntry: DaemonEntry = { live, turnActive: false, pendingSteers: [], landingSteers: [] };
  let mainSelection = live.selection;
  let mainProviderFamily = providerFamilyForSelection(live.selection);
  let activeTurns = 0;
  // Guards the long-running Consciousness model download so a second "awaken"
  // doesn't kick off a parallel pull; the controller lets "cancel" abort it.
  let consciousnessDownloading = false;
  let consciousnessAbort: AbortController | undefined;

  // Providers that failed THIS SESSION with a balance/auth error (402/401/403/
  // insufficient balance). They won't recover this instant, so we stop re-selecting
  // them — but a balance top-up or re-auth IS recoverable, so each is parked only
  // until a cooldown elapses, then auto-re-probed (the old behaviour kept them dead
  // for the whole session, so topping up DeepSeek never came back without a manual
  // model switch). A manual switch still clears them all immediately. Override the
  // cooldown with ARES_DEAD_PROVIDER_TTL_MS.
  const deadProviders = new Map<string, number>(); // family → epoch ms it may be re-probed
  const deadProviderTtlMs = Math.max(60_000, Number(process.env.ARES_DEAD_PROVIDER_TTL_MS) || 10 * 60_000);
  const markProviderDead = (family: string): void => {
    deadProviders.set(family, Date.now() + deadProviderTtlMs);
  };
  // Prune expired entries (cooldown elapsed → give the provider another chance) and
  // return the still-dead set — the single read path so re-probe is consistent.
  const liveDeadProviders = (): Set<string> => {
    const now = Date.now();
    for (const [family, until] of deadProviders) {
      if (now >= until) deadProviders.delete(family);
    }
    return new Set(deadProviders.keys());
  };
  const isProviderDead = (family: string): boolean => liveDeadProviders().has(family);
  const isPermanentlyDeadError = (blob: string): boolean =>
    /\b402\b|\b401\b|\b403\b|insufficient.?balance|unauthorized|forbidden|invalid.?api.?key|no_auth/i.test(blob);
  sessions.set(live.session.meta.id, primaryEntry);

  // Bounded tail of what the daemon was doing right before a crash — pulled by
  // the crash handler so a coworker's silent death leaves a diagnosable trail.
  const eventRing = new EventRing(40);

  const tagEmit = (sessionId: string | undefined, obj: Record<string, unknown>): void => {
    const payload = sessionId && sessionId !== DEFAULT_SID ? { ...obj, sessionId } : obj;
    eventRing.record({ at: Date.now(), ...payload });
    process.stdout.write(JSON.stringify(payload) + "\n");
  };

  // OS known folders for natural-language drive-workspace rebinding. Resolved
  // once through the shell so OneDrive-redirected Desktops resolve correctly;
  // falls back to the conventional %USERPROFILE% layout when the query fails.
  let knownFoldersPromise: Promise<Record<string, string>> | undefined;
  const resolveKnownFolder = async (name: string): Promise<string | undefined> => {
    knownFoldersPromise ??= new Promise((resolve) => {
      const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
      const fallback = {
        desktop: path.join(home, "Desktop"),
        documents: path.join(home, "Documents"),
        downloads: path.join(home, "Downloads"),
      };
      if (process.platform !== "win32") { resolve(fallback); return; }
      const script = "[Console]::Out.WriteLine([Environment]::GetFolderPath('Desktop'));"
        + "[Console]::Out.WriteLine([Environment]::GetFolderPath('MyDocuments'));"
        + "[Console]::Out.WriteLine((New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path)";
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      let out = "";
      child.stdout.on("data", (chunk) => { out += String(chunk); });
      const settle = (): void => {
        const [desktop, documents, downloads] = out.split(/\r?\n/u).map((line) => line.trim());
        resolve({
          desktop: desktop || fallback.desktop,
          documents: documents || fallback.documents,
          downloads: downloads || fallback.downloads,
        });
      };
      child.once("close", settle);
      child.once("error", () => resolve(fallback));
      setTimeout(() => { try { child.kill(); } catch { /* settled */ } }, 8_000).unref?.();
    });
    const folders = await knownFoldersPromise;
    const candidate = folders[name];
    if (!candidate) return undefined;
    return await stat(candidate).then((s) => (s.isDirectory() ? candidate : undefined)).catch(() => undefined);
  };

  // Vanguard drive mode: the second engine. Loads nothing until a session
  // with the mode enabled actually sends. Drive events persist into the same
  // per-session rollout the native engine uses, so history, restore, and bug
  // reports treat both engines identically.
  const vanguardDrive = createVanguardDrive(tagEmit, (sessionId, event) => {
    const entry = sessions.get(sessionId ?? DEFAULT_SID) ?? primaryEntry;
    void entry.live.session.recordExternalEvent(event as unknown as TurnEvent).catch(() => undefined);
  });

  // Crash safety net. The desktop bridge is a long-lived process on a coworker's
  // machine; until now an uncaught error or stray rejection could kill it with
  // nothing on disk. Now every fatal lands in ~/.ares/crashes and is surfaced to
  // the UI; a stray background rejection is logged but no longer takes the chat
  // down with it (see crashLog.ts for the posture).
  // handleSignals:false on purpose: the desktop manages this process's lifecycle
  // (normal close ends stdin → the command loop exits → the `finally` below runs
  // the FULL teardown, incl. agent-runtime flush). Catching signals here would
  // process.exit() straight past that teardown. We only want the uncaught/
  // rejection net + crash log.
  const uninstallCrashHandlers = installGlobalCrashHandlers({
    home: live.context.home,
    process: "daemon",
    handleSignals: false,
    getContext: () => ({
      activeSessions: sessions.size,
      activeTurns,
      provider: mainProviderFamily,
      model: mainSelection.model,
      deadProviders: [...liveDeadProviders()],
    }),
    getRecentEvents: () => eventRing.snapshot(),
    emit: (notice) =>
      process.stdout.write(
        JSON.stringify({ type: "daemon_crash", kind: notice.kind, message: notice.message, logFile: notice.logFile }) + "\n",
      ),
  });

  // ─── Consciousness: the always-on local watcher ──────────────────────────
  const consciousnessWatch = new ConsciousnessWatch({
    capture: () => captureScreen(),
    describe: (imagePath) => describeImage(live.context.home, imagePath),
    // Phrase a notable observation into one dry remark via the chat model. The
    // model gets final veto (returns NOTHING → the watcher stays silent).
    phrase: async (observation) => {
      // Ground STRICTLY in the current observation. No recent-context narrative —
      // that's what produced nonsense like "still working three distractions ago".
      if (/\b(unclear|uncertain|not sure|can't tell|cannot tell)\b/i.test(observation)) return null;
      try {
        const said = await sideQuery({
          provider: mainSelection.provider,
          model: mainSelection.model,
          system: WATCHER_VOICE_PROMPT,
          user:
            `This is what is on the user's screen RIGHT NOW (a literal description):\n"${observation}"\n\n` +
            `If there is something genuinely worth one calm remark, say it in ONE short sentence grounded ONLY in that description. ` +
            `Invent nothing — no past events, no "earlier", no continuity, nothing not stated above. ` +
            `If nothing is clearly worth saying, output exactly: NOTHING`,
          maxOutputTokens: 50,
        });
        const trimmed = said.trim().replace(/^["']|["']$/g, "");
        return !trimmed || /^nothing\b/i.test(trimmed) ? null : trimmed;
      } catch {
        return null; // phrasing failed — stay silent rather than blurt raw text
      }
    },
    emit: (event) => {
      process.stdout.write(JSON.stringify(event) + "\n");
      // Feed every observation into the peripheral-awareness buffer so the chat
      // agent has a SMALL, bounded sense of what the watcher sees (recordObservation
      // itself drops idle noise and caps the buffer — it never burns context).
      if (event.type === "consciousness_observation" && typeof event.observation === "string") {
        recordConsciousnessObservation({
          observation: event.observation,
          comment: typeof event.comment === "string" ? event.comment : null,
          at: typeof event.at === "number" ? event.at : Date.now(),
        });
      }
      // When the Watch decides to speak, surface it PROACTIVELY IN THE CHAT —
      // not just the settings panel. This is the whole point of the watcher.
      if (event.type === "consciousness_observation" && event.spoke === true && typeof event.comment === "string") {
        process.stdout.write(JSON.stringify({ type: "consciousness_say", text: event.comment }) + "\n");
      }
    },
    remember: (text) => {
      // Durable, dependency-free log of what the watcher chose to say — the
      // seed of "it remembers what it's been watching". Ensure the home exists
      // first so a fresh machine doesn't silently drop every observation.
      void mkdir(live.context.home, { recursive: true })
        .then(() =>
          appendFile(path.join(live.context.home, "consciousness-observations.jsonl"), JSON.stringify({ at: Date.now(), text }) + "\n"),
        )
        .catch(() => {});
    },
    enabled: () => true, // started/stopped explicitly; the gate is start/stop
    log: (line) => process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "consciousness", line } }) + "\n"),
  });
  const startConsciousnessWatch = (): void => consciousnessWatch.start();
  const stopConsciousnessWatch = (): void => consciousnessWatch.stop();
  // Resume the watch across restarts when the owner left Consciousness awake.
  void loadUiSettings()
    .then((s) => {
      if (s.consciousnessEnabled === true) startConsciousnessWatch();
    })
    .catch(() => {});

  // After-action reflection trigger: when a turn lands a NEW commit, summarize it
  // into the war map. Seed with the current HEAD so existing history isn't
  // re-reflected; reflectOnRun dedupes by SHA so a re-fire is a no-op. Disable
  // with ARES_REFLECT=0. Entirely best-effort — it never touches the turn.
  let lastReflectedSha = (await gatherGitRunFacts(live.context.workspace).catch(() => null))?.sha;
  const reflectAfterTurn = async (goal: string): Promise<void> => {
    if (process.env.ARES_REFLECT === "0") return;
    const facts = await gatherGitRunFacts(live.context.workspace).catch(() => null);
    if (!facts || facts.sha === lastReflectedSha) return; // no new commit this turn
    lastReflectedSha = facts.sha;
    const projectId = await detectWorkspaceProjectId(live.context.workspace).catch(() => undefined);
    const out = await reflectOnRun(
      {
        workspace: live.context.workspace,
        projectId,
        task: facts.subject || goal.slice(0, 120),
        result: "success",
        summary: facts.subject || `commit ${facts.sha.slice(0, 8)}`,
        commits: [facts.sha.slice(0, 10)],
        changedFiles: facts.changedFiles,
        sourcePointers: [facts.sha],
      },
      live.context.home,
    ).catch(() => null);
    if (out?.recorded) {
      tagEmit(undefined, { type: "lifecycle", event: { kind: "after_action", commit: facts.sha.slice(0, 10), task: facts.subject } });
    }
  };

  // Conversation reflection: every Nth completed turn, distill durable facts
  // (preferences, personal facts, decisions, relationships) from the recent chat
  // and write them to Living Memory once, deduped — so Ares learns from TALKING,
  // not just from commits, without ever re-reading the transcript. Token-smart:
  // a few short facts in, recalled compactly later. Best-effort; never blocks.
  const REFLECT_EVERY = Math.max(1, Number(process.env.ARES_REFLECT_EVERY) || 3);
  const convReflectTurns = new Map<string, number>();
  const reflectConversationAfterTurn = async (entry: DaemonEntry, sid: string): Promise<void> => {
    if (process.env.ARES_REFLECT === "0") return;
    const n = (convReflectTurns.get(sid) ?? 0) + 1;
    convReflectTurns.set(sid, n);
    if (n % REFLECT_EVERY !== 0) return; // throttle the side-call
    const turns = entry.live.session
      .history()
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.content.some((b) => b.type === "tool_result" || b.type === "tool_use"))
      .slice(-(2 * REFLECT_EVERY + 4))
      .map((m) => ({ role: m.role, text: messageText(m) }))
      .filter((t) => t.text.trim().length > 0 && !t.text.startsWith("(System:"));
    if (turns.length < 2) return;
    const digest = buildConversationDigest(turns);
    if (digest.length < 40) return;
    const sel = entry.live.selection;
    let facts: DurableFact[];
    try {
      facts = await sideQueryJson<DurableFact[]>({
        provider: sel.provider,
        model: sel.model,
        system: CONVERSATION_REFLECT_SYSTEM,
        user: digest,
        schemaHint: DURABLE_FACTS_SCHEMA_HINT,
        maxOutputTokens: 600,
      });
    } catch {
      return; // distillation failed — nothing learned this pass, no harm
    }
    if (!Array.isArray(facts) || facts.length === 0) return;
    try {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      const res = await mergeDurableFacts(store, facts);
      if (res.added > 0) {
        tagEmit(undefined, { type: "lifecycle", event: { kind: "reflected", added: res.added, facts: res.addedFacts.slice(0, 3) } });
      }
    } catch {
      // memory write is best-effort
    }
  };

  const resolveEntry = async (sessionId: string | undefined): Promise<DaemonEntry> => {
    const sid = sessionId || DEFAULT_SID;
    if (sid === DEFAULT_SID) return primaryEntry;
    const existing = sessions.get(sid);
    if (existing) return existing;
    // A new card → a fresh, fully-isolated session (no background heartbeat;
    // the primary owns the shared mind loop). Inherits the daemon's provider.
    const selection = await selectProvider(
      new Map([
        ["provider", mainProviderFamily],
        ["model", mainSelection.model],
      ]),
    );
    const saved = await loadSessionSnapshot(live.context.workspace, sid, { maxMessages: 1 })
      .then(() => true)
      .catch(() => false);
    const fresh = await createSessionWithSelection(
      args,
      selection,
      saved ? sid : undefined,
      requestPermission,
      { startAgentRuntime: false, sessionId: saved ? undefined : sid },
    );
    const entry: DaemonEntry = { live: fresh, turnActive: false, pendingSteers: [], landingSteers: [] };
    sessions.set(sid, entry);
    tagEmit(sid, { type: "session_opened", model: fresh.selection.model, provider: fresh.selection.provider.name });
    return entry;
  };

  commands.onInterrupt = (command) => {
    const sid = command.sessionId || DEFAULT_SID;
    const entry = sessions.get(sid);
    if (entry?.vanguardMode && vanguardDrive.isTurnActive(sid)) {
      vanguardDrive.interrupt(sid);
      tagEmit(command.sessionId, { type: "interrupted_by_user" });
      return;
    }
    if (!entry) {
      // Unknown/not-yet-spawned session id: do NOT silently interrupt the
      // primary (that was hitting the wrong target and leaving the real busy
      // session running). Abort every session that's actually mid-turn instead.
      let hit = false;
      for (const e of sessions.values()) {
        if (e.turnActive) { e.live.session.interrupt(); hit = true; }
      }
      if (!hit) primaryEntry.live.session.interrupt();
      tagEmit(command.sessionId, { type: "interrupted_by_user" });
      return;
    }
    entry.live.session.interrupt();
    tagEmit(command.sessionId, { type: "interrupted_by_user" });
    // Watchdog: the abort above should make the turn tear down promptly (the
    // engine now checks the signal every loop iteration). But if the turn is
    // genuinely wedged (a tool ignoring its signal, a stalled provider stream),
    // force the session free so it can accept new messages instead of rejecting
    // every send with "a turn is already running".
    if (entry.turnActive) {
      const wedged = entry;
      const t = setTimeout(() => {
        if (wedged.turnActive) {
          wedged.turnActive = false;
          tagEmit(command.sessionId, { type: "turn_end", status: "interrupted", usage: {}, durationMs: 0 });
        }
      }, 5000);
      t.unref?.();
    }
  };

  // Apply any persisted Advanced-tab engine knobs (env-backed ones) on boot.
  applyEngineConfigEnv((await loadUiSettings()).engine ?? {});

  // Operator auto-tick: while the daemon idles, durable missions ADVANCE — one
  // worker tick on the ATTENTION-SELECTED active goal per interval (not naive
  // active[0]). This now runs through the SAME OperatorBackgroundLoop that drives
  // garrisonCommand — one autonomy driver, one gate — instead of a hand-rolled
  // setInterval that omitted the pause gate, standing-order materialization, and
  // next-action awareness (the two drivers had already drifted). The stdio JSON
  // bridge transport is unchanged: the loop's events are mirrored to NDJSON below.
  //
  // OPT-IN: ARES_OPERATOR_LOOP=1, OR the owner has queued standing orders (adding a
  // recurring mission IS the opt-in — same widening as the garrison). The live
  // ARES_OPERATOR_AUTOTICK=0 kill switch and a live user turn both park ticks via
  // the pause gate, so the operator_autotick toggle still takes effect next tick.
  const daemonStandingAtStart = await loadStandingOrders(live.context.home).catch(() => [] as StandingOrder[]);
  // Build the loop whenever the opt-in holds (LOOP=1 or standing orders queued).
  // Do NOT gate construction on the ARES_OPERATOR_AUTOTICK kill switch: it's a
  // LIVE toggle handled by the paused() gate below, so a daemon booted with
  // autotick off (incl. the persisted UI setting) can still resume ticks when the
  // user flips it back on — without a restart. The loop ticks are cheap no-ops
  // while parked, exactly as the old per-tick-gated setInterval was.
  const autotickLoop =
    !(process.env.ARES_OPERATOR_LOOP === "1" || daemonStandingAtStart.length > 0)
      ? null
      : new OperatorBackgroundLoop(
          {
            home: live.context.home,
            workspace: live.context.workspace,
            dispatcher: new QueryEngineDispatcher({
              provider: live.selection.provider,
              model: live.selection.model,
              workspace: live.context.workspace,
              tools: live.tools,
              systemPrompt: buildSystemPrompt("workspace-write", live.context),
              // UNATTENDED gate: the owner isn't watching a background mission tick,
              // so anything that needs a human (payment, credential, send-mail,
              // destructive shell, computer-use) is hard-denied; only safe local
              // work flows.
              requestPermission: async (request) => {
                const gate = gateToolPermission(request, { attended: false });
                return gate.kind === "allow" ? "allow_once" : "deny";
              },
            }),
          },
          {
            everyMs: Math.max(60_000, Number(process.env.ARES_OPERATOR_TICK_MS) || 30 * 60_000),
            // Park a tick whenever a live user turn is in flight (never steal the
            // foreground), the kill switch is flipped (live operator_autotick
            // toggle), or a remote /pause is set — mirrors the garrison's gates.
            paused: async () =>
              activeTurns > 0 ||
              process.env.ARES_OPERATOR_AUTOTICK === "0" ||
              (await isOperatorPaused(live.context.home).catch(() => false)),
            // Materialize due standing orders into goals so the same tick runs them
            // (the inline setInterval omitted this — recurring missions never fired).
            beforeTick: async () => {
              const { fired } = await materializeDueStandingOrders(live.context.home).catch(() => ({ goals: [], fired: [] as StandingOrder[] }));
              for (const order of fired) {
                process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "standing_order_fired", id: order.id, statement: order.statement.slice(0, 120) } }) + "\n");
              }
            },
            // Idle awareness: surface (never auto-run) the active project's next moves.
            nextActions: async () => {
              const projectId = await detectWorkspaceProjectId(live.context.workspace).catch(() => undefined);
              const project = projectId ? await loadProjectState(projectId, live.context.home).catch(() => null) : null;
              return project?.nextActions ?? [];
            },
            emit: (event) => {
              // Unified lifecycle shape (matches garrison) PLUS the legacy
              // operator_autotick event for older UI builds that key on it.
              process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "operator", ...event } }) + "\n");
              if (event.type === "operator_tick") {
                process.stdout.write(
                  JSON.stringify({
                    type: "lifecycle",
                    event: { kind: "operator_autotick", goalId: event.goalId, statement: event.summary.slice(0, 120), status: event.status },
                  }) + "\n",
                );
              }
            },
            onError: () => {},
          },
        );
  autotickLoop?.start();
  const readySettings = await loadUiSettings();
  // "Configured" must mean USABLE, not just "pasted into ui.json". A provider is
  // configured if its key is in settings OR in the environment, plus OpenAI via
  // its ChatGPT OAuth session. Otherwise an env-keyed Ollama-Cloud user (the
  // default!) or an OAuth'd OpenAI user wrongly sees "only deepseek configured".
  const readyAuth = await authStatus().catch(() => null);
  process.stdout.write(
    JSON.stringify({
      type: "daemon_ready",
      sessionId: live.session.meta.id,
      provider: providerFamilyForSelection(live.selection),
      model: live.selection.model,
      reasoningLevel: resolveReasoningLevel(readySettings),
      routingMode: readySettings.routingMode ?? "manual",
      routing: readySettings.routing ?? {},
      engine: readySettings.engine ?? {},
      permissions: { ...DEFAULT_PERMISSIONS, ...(readySettings.permissions ?? {}) },
      keyStatus: {
        anthropic: Boolean(readySettings.anthropicKey || process.env.ANTHROPIC_API_KEY || process.env.ARES_ANTHROPIC_API_KEY),
        openai: Boolean(readyAuth?.configured),
        deepseek: Boolean(readySettings.deepSeekKey || process.env.DEEPSEEK_API_KEY),
        kimi: Boolean(readySettings.kimiKey || process.env.KIMI_API_KEY),
        openrouter: Boolean(readySettings.openRouterKey || process.env.OPENROUTER_API_KEY),
        ollama: Boolean(readySettings.ollamaApiKey || process.env.OLLAMA_API_KEY),
        brave: Boolean(readySettings.braveKey || process.env.ARES_BRAVE_API_KEY),
      },
    }) + "\n",
  );

  // Bridge lifecycle events (Bootstrap, SelfEvolve, capture, recall, dream,
  // skill_crafted, etc.) out as NDJSON so the Tauri shell can render +N
  // score popups and entity-status indicators. These are separate from the
  // per-turn TurnEvent stream — they're agent-evolution telemetry.
  const unsubscribeLifecycle = onLifecycle((event) => {
    if (activeTurns === 0) return; // only stream agent-evolution telemetry during live work
    try {
      process.stdout.write(JSON.stringify({ type: "lifecycle", event }) + "\n");
    } catch {
      // never let lifecycle bridging crash the daemon
    }
  });
  let unsubscribeGatewayMirror: (() => void) | undefined;
  startGatewayMirror(live.context, tagEmit).catch(() => {});

  try {
    while (true) {
      const command = await commands.nextCommand();
      if (!command) break;
      if (command.type === "exit") break;
      if (command.type === "vanguard_mode") {
        // Flip the drive engine for one session. The ack is what the UI's
        // shield button and shockwave overlay key off. An optional workspace
        // pins where the engine works ("build it in THIS folder").
        const entry = await resolveEntry(command.sessionId);
        entry.vanguardMode = (command as { enabled?: unknown }).enabled === true;
        const requestedWorkspace = (command as { workspace?: unknown }).workspace;
        if (typeof requestedWorkspace === "string" && requestedWorkspace.trim() !== "") {
          entry.vanguardWorkspace = path.resolve(requestedWorkspace.trim());
        }
        tagEmit(command.sessionId, {
          type: "vanguard_mode",
          enabled: entry.vanguardMode === true,
          workspace: entry.vanguardWorkspace ?? entry.live.context.workspace,
        });
        continue;
      }
      if (command.type === "reasoning") {
        const level = command.level?.toLowerCase();
        if (!isReasoningLevel(level)) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `reasoning requires level: ${REASONING_LEVELS.join("|")}` }) + "\n");
          continue;
        }
        // ONE handler for all three dispatch sites — validates, sets the dial on
        // EVERY open session (not just the primary, which used to miss spawned
        // chats), persists, and clears any env override so the explicit choice wins.
        const change = await handleReasoningCommand(
          level,
          [...new Set([primaryEntry, ...sessions.values()])].map((e) => e.live),
        );
        process.stdout.write(JSON.stringify({ type: "reasoning_set", level: change.level, clearedEnvOverride: change.clearedEnvOverride }) + "\n");
        continue;
      }
      if (command.type === "routing") {
        // Owner per-lane model assignments. Normalize {provider,model} → {family,model}
        // and persist; the live turn resolves via @ares/core resolveRoute().
        const routing = normalizeRoutingCommand(command.routing);
        await updateUiSettings({ routing });
        process.stdout.write(JSON.stringify({ type: "routing_set", routing }) + "\n");
        continue;
      }
      if (command.type === "routing_mode") {
        const routingMode = command.enabled === true ? "auto" : "manual";
        await updateUiSettings({ routingMode });
        process.stdout.write(JSON.stringify({ type: "routing_mode_set", routingMode }) + "\n");
        continue;
      }
      if (command.type === "set_permissions") {
        // Owner permission posture. Sanitize to known keys/types (never trust the
        // wire), apply LIVE to every open session, keep dangerousBypass in sync
        // (so the path-tool bypass + leash agree with "free"), and persist.
        const incoming = (command.permissions ?? {}) as Partial<PermissionSettings>;
        const permissions: PermissionSettings = {
          mode: incoming.mode === "free" ? "free" : "guarded",
          fileWrite: incoming.fileWrite !== false,
          shell: incoming.shell !== false,
          network: incoming.network !== false,
          sensitive: incoming.sensitive === true,
          fleetsInherit: incoming.fleetsInherit !== false,
        };
        const mode: PermissionMode = permissions.mode === "free" ? "bypass" : "workspace-write";
        live.runtime.permissionMode = mode;
        live.runtime.permissions = permissions;
        for (const e of sessions.values()) {
          e.live.runtime.permissionMode = mode;
          e.live.runtime.permissions = permissions;
        }
        await updateUiSettings({ permissions, dangerousBypass: permissions.mode === "free" });
        process.stdout.write(JSON.stringify({ type: "permissions_set", permissions }) + "\n");
        continue;
      }
      if (command.type === "consciousness_status") {
        const models = await consciousnessStatus(live.context.home);
        const settings = await loadUiSettings();
        const engine = await engineStatus(live.context.home);
        process.stdout.write(
          JSON.stringify({
            type: "consciousness_status",
            enabled: settings.consciousnessEnabled === true,
            downloading: consciousnessDownloading,
            watching: consciousnessWatch.isRunning(),
            engineStatus: { binaryInstalled: Boolean(engine.binary), available: engine.available },
            models,
          }) + "\n",
        );
        continue;
      }
      if (command.type === "consciousness_disable") {
        await updateUiSettings({ consciousnessEnabled: false });
        consciousnessAbort?.abort();
        stopConsciousnessWatch();
        process.stdout.write(JSON.stringify({ type: "consciousness_set", enabled: false }) + "\n");
        continue;
      }
      if (command.type === "consciousness_killswitch") {
        // Hard stop: blind the eyes and halt the download. The owner's brake.
        consciousnessAbort?.abort();
        stopConsciousnessWatch();
        await updateUiSettings({ consciousnessEnabled: false });
        process.stdout.write(JSON.stringify({ type: "consciousness_killed" }) + "\n");
        continue;
      }
      if (command.type === "consciousness_look_away") {
        // Pause the watch for N seconds (default 5 min) without disabling it.
        const seconds = typeof command.seconds === "number" ? command.seconds : 300;
        consciousnessWatch.pause(Math.max(1, seconds) * 1000);
        process.stdout.write(JSON.stringify({ type: "consciousness_paused", seconds }) + "\n");
        continue;
      }
      if (command.type === "consciousness_resume") {
        consciousnessWatch.resume();
        process.stdout.write(JSON.stringify({ type: "consciousness_resumed" }) + "\n");
        continue;
      }
      if (command.type === "consciousness_enable") {
        await updateUiSettings({ consciousnessEnabled: true });
        process.stdout.write(JSON.stringify({ type: "consciousness_set", enabled: true }) + "\n");
        // Start the watch right away (idempotent). It idles harmlessly until the
        // engine + weights are present — so it's running no matter how the
        // download/enable timing races.
        startConsciousnessWatch();
        // Pull any missing weights. Fire-and-forget so the command loop keeps
        // serving; a guard prevents overlapping downloads.
        if (!consciousnessDownloading) {
          consciousnessDownloading = true;
          consciousnessAbort = new AbortController();
          const ac = consciousnessAbort;
          void (async () => {
            try {
              await downloadAllConsciousnessModels(
                live.context.home,
                (p) => process.stdout.write(JSON.stringify({ type: "consciousness_progress", ...p }) + "\n"),
                (m) => process.stdout.write(JSON.stringify({ type: "consciousness_model_ready", id: m.id, filename: m.filename }) + "\n"),
                ac.signal,
              );
              // Install the local inference engine binary too — this is what
              // actually opens the eyes. Best-effort: if it fails, the models are
              // still down and the user can retry; the watch idles meanwhile.
              try {
                await prepareEngineBinary(
                  live.context.home,
                  (p) => process.stdout.write(JSON.stringify({ type: "consciousness_progress", ...p }) + "\n"),
                  ac.signal,
                );
                process.stdout.write(JSON.stringify({ type: "consciousness_model_ready", id: "engine", filename: "vision engine" }) + "\n");
              } catch (engineErr) {
                if (!ac.signal.aborted) {
                  process.stdout.write(
                    JSON.stringify({ type: "consciousness_error", error: `engine: ${engineErr instanceof Error ? engineErr.message : String(engineErr)}` }) + "\n",
                  );
                }
              }
              process.stdout.write(JSON.stringify({ type: "consciousness_ready" }) + "\n");
              startConsciousnessWatch();
            } catch (err) {
              if (ac.signal.aborted) {
                process.stdout.write(JSON.stringify({ type: "consciousness_cancelled" }) + "\n");
              } else {
                process.stdout.write(
                  JSON.stringify({ type: "consciousness_error", error: err instanceof Error ? err.message : String(err) }) + "\n",
                );
              }
            } finally {
              consciousnessDownloading = false;
              consciousnessAbort = undefined;
            }
          })();
        }
        continue;
      }
      if (command.type === "consciousness_cancel") {
        consciousnessAbort?.abort();
        process.stdout.write(JSON.stringify({ type: "consciousness_cancelled" }) + "\n");
        continue;
      }
      if (command.type === "model_switch") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const model = typeof command.model === "string" ? command.model.trim() : "";
        if (!provider || !model) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "model_switch requires provider and model" }) + "\n");
          continue;
        }
        try {
          const entry = await resolveEntry(command.sessionId);
          if (entry.turnActive) throw new Error("this chat is busy; stop the turn before changing its model");
          const flags = new Map<string, string>([["provider", provider], ["model", model]]);
          const selection = await selectProvider(flags);
          await preflightProviderSelection(selection);
          const previous = entry.live.selection;
          // The owner may have just repaired this provider; re-probe this one
          // without reviving unrelated providers that failed in other chats.
          deadProviders.delete(providerFamilyForSelection(selection));
          await entry.live.session.setProvider(selection.provider, selection.model, {
            contextBudgetTokens: chatContextBudget(selection),
            summarizeSpan: makeSpanSummarizer(selection, (usage) =>
              entry.live.session.recordAuxiliaryUsage("compaction", selection.provider.name, selection.model, usage),
            ),
          });
          entry.live.selection = selection;
          mainSelection = selection;
          mainProviderFamily = providerFamilyForSelection(selection);
          const settings = await loadUiSettings();
          await updateUiSettings({
            routingMode: "manual",
            lastProvider: provider as UiSettings["lastProvider"],
            lastOpenAIModel: provider === "openai" ? model : settings.lastOpenAIModel,
            lastOllamaModel: provider === "ollama" ? model : settings.lastOllamaModel,
            lastAnthropicModel: provider === "anthropic" ? model : settings.lastAnthropicModel,
            lastDeepSeekModel: provider === "deepseek" ? model : settings.lastDeepSeekModel,
            lastOpenRouterModel: provider === "openrouter" ? model : settings.lastOpenRouterModel,
            // Ares gateway + custom endpoints were omitted here, so picking one
            // of their models never persisted — next start snapped back to the
            // "ares-internal"/"" default. Remember them like every other provider.
            lastAresModel: provider === "ares" ? model : settings.lastAresModel,
            lastCustomModel: provider === "custom" ? model : settings.lastCustomModel,
            lastMoaModel: provider === "moa" ? model : settings.lastMoaModel,
          });
          tagEmit(command.sessionId, {
            type: "model_switched",
            provider: providerFamilyForSelection(selection),
            model: selection.model,
            previousProvider: providerFamilyForSelection(previous),
            previousModel: previous.model,
          });
        } catch (err) {
          const entry = await resolveEntry(command.sessionId).catch(() => null);
          tagEmit(command.sessionId, {
            type: "model_switch_failed",
            provider,
            model,
            currentProvider: entry ? providerFamilyForSelection(entry.live.selection) : mainProviderFamily,
            currentModel: entry?.live.selection.model ?? mainSelection.model,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (command.type === "provider_key") {
        // Generic per-provider credential drop: persist the owner's API key
        // (+ optional default model) for any keyed provider. Applied the next
        // time the daemon starts on that provider.
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const key = typeof command.key === "string" ? command.key.trim() : "";
        const model = typeof command.model === "string" && command.model.trim() ? command.model.trim() : undefined;
        const patch: Partial<UiSettings> = {};
        if (provider === "openrouter") {
          patch.openRouterKey = key;
          if (model) patch.lastOpenRouterModel = model;
        } else if (provider === "deepseek") {
          patch.deepSeekKey = key;
          if (model) patch.lastDeepSeekModel = model;
        } else if (provider === "anthropic") {
          patch.anthropicKey = key;
          if (model) patch.lastAnthropicModel = model;
        } else if (provider === "kimi") {
          patch.kimiKey = key;
          if (model) patch.lastKimiModel = model;
          if (key) process.env.KIMI_API_KEY = key;
          else delete process.env.KIMI_API_KEY;
        } else if (provider === "ollama") {
          patch.ollamaApiKey = key;
          if (model) patch.lastOllamaModel = model;
          if (key) process.env.OLLAMA_API_KEY = key;
          else delete process.env.OLLAMA_API_KEY;
        } else if (provider === "custom") {
          // Universal OpenAI-compatible provider: key + base URL (+ optional model).
          patch.customApiKey = key;
          const baseUrl = typeof command.baseUrl === "string" ? command.baseUrl.trim() : "";
          if (baseUrl) patch.customBaseUrl = baseUrl;
          if (model) patch.lastCustomModel = model;
        } else if (provider === "brave") {
          patch.braveKey = key;
          if (key) process.env.ARES_BRAVE_API_KEY = key; // live immediately, no restart
        } else {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `provider_key: unsupported provider "${provider}" (openrouter | deepseek | anthropic | kimi | ollama | custom | brave)` }) + "\n");
          continue;
        }
        await updateUiSettings(patch);
        process.stdout.write(JSON.stringify({ type: "provider_key_set", provider, hasKey: Boolean(key) }) + "\n");
        continue;
      }
      if (command.type === "openrouter_key") {
        // Persist the owner's OpenRouter key (+ optional default model). Applied
        // the next time the daemon starts on the openrouter provider.
        const patch: Partial<UiSettings> = { openRouterKey: typeof command.key === "string" ? command.key.trim() : "" };
        if (typeof command.model === "string" && command.model.trim()) patch.lastOpenRouterModel = command.model.trim();
        await updateUiSettings(patch);
        process.stdout.write(JSON.stringify({ type: "openrouter_key_set", hasKey: Boolean(patch.openRouterKey) }) + "\n");
        continue;
      }
      if (command.type === "undo") {
        const entry = await resolveEntry(command.sessionId);
        const depth = Number.isFinite(command.depth) ? String(command.depth) : "";
        const lines = await undoLines(entry.live, depth);
        tagEmit(command.sessionId, { type: "undo_result", text: lines.join("\n") });
        continue;
      }
      if (command.type === "sessions_list") {
        // The rail's source of truth — every session persisted to disk.
        const sessions = await listSessions(live.context.workspace, 100).catch(() => []);
        process.stdout.write(JSON.stringify({ type: "sessions_list", sessions }) + "\n");
        continue;
      }
      if (command.type === "model_catalog") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const models = await daemonModelCatalog(provider).catch(() => []);
        process.stdout.write(JSON.stringify({ type: "model_catalog", provider, models }) + "\n");
        continue;
      }
      if (command.type === "session_history") {
        // Read-only replay of a past session's transcript for the UI to render.
        const id = cleanCommandId(command.id);
        if (!id) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "session_history requires id" }) + "\n");
          continue;
        }
        try {
          const snap = await loadSessionSnapshot(live.context.workspace, id, { maxMessages: 400 });
          process.stdout.write(JSON.stringify({ type: "session_history", id, messages: snap.messages, meta: snap.meta }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `session_history: ${err instanceof Error ? err.message : String(err)}` }) + "\n");
        }
        continue;
      }
      if (command.type === "mcp_list") {
        process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
        continue;
      }
      if (command.type === "mcp_connect") {
        const url = typeof command.url === "string" ? command.url.trim() : "";
        if (!url) {
          process.stdout.write(JSON.stringify({ type: "mcp_connect_result", ok: false, error: "a connector URL is required" }) + "\n");
          continue;
        }
        const name = typeof command.name === "string" && command.name.trim() ? command.name.trim() : connectorNameFromUrl(url);
        // The OAuth dance can take minutes (the user authorizes in a browser), so
        // run it OFF the command loop and report via frames when it settles.
        void (async () => {
          try {
            const result = await connectMcpServer(url, {
              name,
              onAuthorizeUrl: (authUrl) => {
                // Reuse the existing oauth_url frame — the desktop opens it in the real browser.
                process.stdout.write(JSON.stringify({ type: "oauth_url", url: authUrl }) + "\n");
              },
            });
            process.stdout.write(JSON.stringify({ type: "mcp_connect_result", ok: true, name: result.name, toolCount: result.toolCount ?? null }) + "\n");
            process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
          } catch (err) {
            process.stdout.write(JSON.stringify({ type: "mcp_connect_result", ok: false, name, error: err instanceof Error ? err.message : String(err) }) + "\n");
          }
        })();
        continue;
      }
      if (command.type === "mcp_disconnect") {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        await disconnectMcpServer(name).catch(() => false);
        process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
        continue;
      }
      if (command.type === "mcp_toggle") {
        // Pause/resume a connector without dropping its OAuth tokens.
        const name = typeof command.name === "string" ? command.name.trim() : "";
        const enabled = command.enabled !== false;
        if (name) await setMcpServerEnabled(name, enabled).catch(() => false);
        process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
        continue;
      }
      if (command.type === "mcp_tools") {
        // Live tool listing for one connector — the /mcp explorer's expand row.
        // Runs off the command loop: a slow/unreachable server must not block chat.
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name) {
          process.stdout.write(JSON.stringify({ type: "mcp_tools", name, tools: [], error: "a connector name is required" }) + "\n");
          continue;
        }
        void (async () => {
          const { listMcpServerTools } = await import("@ares/tools");
          const out = await listMcpServerTools(live.context.workspace, name, 15_000).catch(
            (err) => ({ tools: [], error: err instanceof Error ? err.message : String(err) }),
          );
          process.stdout.write(JSON.stringify({ type: "mcp_tools", name, tools: out.tools, error: out.error ?? null }) + "\n");
        })();
        continue;
      }
      if (command.type === "mcp_search") {
        // Search the public MCP registry for connect-able (remote HTTP) servers.
        const text = typeof command.text === "string" ? command.text.trim() : "";
        void (async () => {
          try {
            const res = await fetch(
              `https://registry.modelcontextprotocol.io/v0/servers?limit=30&search=${encodeURIComponent(text)}`,
              { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
            );
            if (!res.ok) throw new Error(`registry ${res.status}`);
            const json = await res.json() as {
              servers?: Array<{
                server?: {
                  name?: string;
                  description?: string;
                  remotes?: Array<{ type?: string; url?: string; headers?: Array<{ isRequired?: boolean; isSecret?: boolean }> }>;
                };
                _meta?: Record<string, { isLatest?: boolean; status?: string }>;
              }>;
            };
            const seen = new Set<string>();
            const results: Array<{ name: string; fullName: string; description: string; url: string; needsKey: boolean }> = [];
            for (const row of json.servers ?? []) {
              const server = row.server;
              const official = row._meta?.["io.modelcontextprotocol.registry/official"];
              if (!server?.name || official?.isLatest === false || (official?.status && official.status !== "active")) continue;
              for (const remote of server.remotes ?? []) {
                const url = remote.url ?? "";
                if (!/^https:\/\//i.test(url) || seen.has(url)) continue;
                if (remote.type && !/^(streamable-http|sse|http)$/i.test(remote.type)) continue;
                seen.add(url);
                results.push({
                  name: server.name.split("/").pop() ?? server.name,
                  fullName: server.name,
                  description: (server.description ?? "").slice(0, 160),
                  url,
                  needsKey: (remote.headers ?? []).some((h) => h.isRequired && h.isSecret),
                });
                break; // one remote per server is enough for the gallery
              }
              if (results.length >= 12) break;
            }
            process.stdout.write(JSON.stringify({ type: "mcp_search_results", text, results }) + "\n");
          } catch (err) {
            process.stdout.write(JSON.stringify({ type: "mcp_search_results", text, results: [], error: err instanceof Error ? err.message : String(err) }) + "\n");
          }
        })();
        continue;
      }
      if (command.type === "ollama_pull") {
        // Download a library model through the LOCAL ollama daemon, streaming
        // /api/pull progress to the model panel. Runs off the command loop.
        const model = typeof command.model === "string" ? command.model.trim() : "";
        if (!model || !/^[a-z0-9._:\/-]+$/i.test(model)) {
          process.stdout.write(JSON.stringify({ type: "ollama_pull_done", model, ok: false, error: "a valid model name is required" }) + "\n");
          continue;
        }
        void (async () => {
          const host = (process.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
          try {
            const res = await fetch(`${host}/api/pull`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model }),
            });
            if (!res.ok || !res.body) throw new Error(res.status === 404 ? "model not found in the library" : `local Ollama isn't running (${res.status})`);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            let lastEmit = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.trim()) continue;
                let p: { status?: string; total?: number; completed?: number; error?: string };
                try {
                  p = JSON.parse(line);
                } catch {
                  continue;
                }
                if (p.error) throw new Error(p.error);
                const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : null;
                const now = Date.now();
                if (now - lastEmit > 300) {
                  lastEmit = now;
                  process.stdout.write(JSON.stringify({ type: "ollama_pull_progress", model, status: p.status ?? "", pct }) + "\n");
                }
              }
            }
            process.stdout.write(JSON.stringify({ type: "ollama_pull_done", model, ok: true }) + "\n");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const friendly = /fetch failed|ECONNREFUSED/i.test(msg) ? "Local Ollama isn't running — start the Ollama app, then try again." : msg;
            process.stdout.write(JSON.stringify({ type: "ollama_pull_done", model, ok: false, error: friendly }) + "\n");
          }
        })();
        continue;
      }
      if (command.type === "discover_custom_models") {
        // Server-side model discovery for the Custom (OpenAI-compatible)
        // provider — runs here in Node so CORS / browser-origin rejection
        // (NVIDIA, Google AI Studio, most hosted APIs) can't block it.
        const base = typeof command.base === "string" ? command.base : "";
        const key = typeof command.key === "string" ? command.key : "";
        const result = await fetchCustomOpenAiModels(base, key).catch((err) => ({
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        }));
        process.stdout.write(JSON.stringify({ type: "custom_models", ...result }) + "\n");
        continue;
      }
      if (command.type === "bug_report") {
        // Opt-in: the user pressed "Report bug". Ship the FULL raw rollout of a
        // session to the owner's gateway so coding failures can be diagnosed —
        // every tool call, its output, every error, and all generated code.
        const id = cleanCommandId(command.id);
        if (!id) {
          process.stdout.write(JSON.stringify({ type: "bug_report_result", ok: false, error: "no session to report" }) + "\n");
          continue;
        }
        try {
          const note = typeof command.note === "string" ? command.note.slice(0, 2000) : "";
          const rollout = await loadSessionRollout(live.context.workspace, id);
          const brSettings = await loadUiSettings();
          // Trim pathological bulk (base64 images, giant tool dumps) so even an
          // extreme transcript gzips under the platform limit. Truncates any
          // single oversized string; the diagnosis value is in the code + errors,
          // not a multi-MB embedded screenshot.
          const events = trimRolloutForReport(rollout.entries);
          const payload = {
            session_id: id,
            note,
            model: rollout.meta.provider?.model ?? "",
            app_version: await cliVersion(),
            os: `${process.platform} ${process.arch}`,
            event_count: rollout.eventCount,
            tool_failures: rollout.toolFailures,
            transcript: { meta: rollout.meta, events },
          };
          const result = await postAresGatewayReport(aresGatewayBase(brSettings), brSettings.aresGatewayToken, payload);
          process.stdout.write(JSON.stringify({ type: "bug_report_result", ...result }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({ type: "bug_report_result", ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
        }
        continue;
      }
      if (command.type === "webview_result") {
        // The UI finished an embedded-browser op — resolve the awaiting tool call.
        if (typeof command.cmdId === "string") {
          embeddedBridge.resolve(command.cmdId, { ok: command.ok !== false, result: command.result, error: typeof command.error === "string" ? command.error : undefined });
        }
        continue;
      }
      if (command.type === "session_delete") {
        const id = cleanCommandId(command.id);
        if (!id) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "session_delete requires id" }) + "\n");
          continue;
        }
        try {
          // Drop any live in-memory entry so a deleted session can't resurrect,
          // then remove it from disk. The primary session is never deleted.
          const entry = sessions.get(id);
          if (entry && entry !== primaryEntry) {
            try { entry.live.session.interrupt?.(); } catch { /* best-effort */ }
            await entry.live.verifier.cancel().catch(() => undefined);
            await entry.live.shellRegistry.killAll().catch(() => 0);
            const deadline = Date.now() + 5_000;
            while (entry.turnActive && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (entry.turnActive) throw new Error("session is still quiescing after interrupt; deletion refused to prevent rollout resurrection");
            await disposeLiveSession(entry.live);
            sessions.delete(id);
          }
          const ok = await deleteSession(live.context.workspace, id);
          process.stdout.write(JSON.stringify({ type: "session_deleted", id, ok }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `session_delete: ${err instanceof Error ? err.message : String(err)}` }) + "\n");
        }
        continue;
      }
      if (command.type === "session_rename") {
        const id = cleanCommandId(command.id);
        const label = typeof command.label === "string" ? command.label : "";
        if (!id) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "session_rename requires id" }) + "\n");
          continue;
        }
        try {
          const ok = await renameSession(live.context.workspace, id, label);
          process.stdout.write(JSON.stringify({ type: "session_renamed", id, label: label.trim().slice(0, 120), ok }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `session_rename: ${err instanceof Error ? err.message : String(err)}` }) + "\n");
        }
        continue;
      }
      if (command.type === "engine_config") {
        // Persist Advanced-tab knobs. Live ones (env-backed) apply immediately;
        // the rest take effect on the next session/turn.
        const cfg = normalizeEngineConfig(command.config);
        await updateUiSettings({ engine: cfg });
        applyEngineConfigEnv(cfg);
        for (const entry of new Set([primaryEntry, ...sessions.values()])) {
          if (!entry.turnActive) entry.live.session.setMaxTurns(cfg.maxTurns);
        }
        process.stdout.write(JSON.stringify({ type: "engine_config_set", config: cfg }) + "\n");
        continue;
      }
      if (command.type === "skills_list") {
        const skills = await daemonSkillsList(live.context.home).catch(() => []);
        process.stdout.write(JSON.stringify({ type: "skills_list", skills }) + "\n");
        continue;
      }
      if (command.type === "skill_toggle") {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "skill_toggle requires name" }) + "\n");
          continue;
        }
        const settings = await loadUiSettings();
        const disabled = new Set(settings.disabledSkills ?? []);
        const enabled = command.enabled !== false;
        if (!enabled) disabled.add(name);
        else disabled.delete(name);
        await updateUiSettings({ disabledSkills: [...disabled] });
        // The UI-settings list above only drives the display; runSkill() actually
        // enforces disablement by checking for this marker file on disk (matches
        // the same skillsDir convention as daemonSkillsList above).
        const markerFile = path.join(aresAgentHome(live.context.home), "skills", name, ".disabled");
        try {
          if (!enabled) {
            await mkdir(path.dirname(markerFile), { recursive: true });
            await writeFile(markerFile, "");
          } else {
            await rm(markerFile, { force: true });
          }
        } catch {
          // Best-effort: the UI-settings flag above still reflects intent even if
          // the skill directory doesn't exist yet (e.g. toggled before install).
        }
        process.stdout.write(JSON.stringify({ type: "skill_toggle_set", name, enabled }) + "\n");
        continue;
      }
      if (command.type === "skill_invoke") {
        // One generic path for BOTH a tray surface-button click and a capability
        // call (e.g. TTS through a provider skill). The app never runs arbitrary
        // skills — it can only invoke what's already installed + enabled, and a
        // surface can only run its own skill.
        const name = typeof command.name === "string" ? command.name.trim() : "";
        const invokeId = typeof command.invokeId === "string" ? command.invokeId : undefined;
        if (!name) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "skill_invoke requires name" }) + "\n");
          continue;
        }
        const settings = await loadUiSettings();
        if ((settings.disabledSkills ?? []).includes(name)) {
          process.stdout.write(JSON.stringify({ type: "skill_result", invokeId, name, ok: false, error: `skill '${name}' is disabled` }) + "\n");
          continue;
        }
        // Self-heal divergence: UI settings are the source of truth here, but
        // runSkill enforces the on-disk `.disabled` marker. A stale marker (a
        // best-effort write from an old toggle) would make an enabled skill
        // refuse to run — clear it before invoking.
        if (/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
          await rm(path.join(aresAgentHome(live.context.home), "skills", name, ".disabled"), { force: true }).catch(() => {});
        }
        const started = Date.now();
        const run = await runSkill({ home: live.context.home, name, input: command.input, timeoutMs: 60_000 }).catch(
          (err) => ({ ok: false, result: undefined, error: err instanceof Error ? err.message : String(err) }) as { ok: boolean; result?: unknown; error?: string },
        );
        process.stdout.write(JSON.stringify({
          type: "skill_result",
          invokeId,
          name,
          ok: run.ok,
          result: run.ok ? run.result : undefined,
          error: run.ok ? undefined : (run.error ?? "skill failed"),
          durationMs: Date.now() - started,
        }) + "\n");
        continue;
      }
      if (command.type === "skillhub_list") {
        const gwSettings = await loadUiSettings();
        const base = aresGatewayBase(gwSettings);
        const reachable = await skillHubProbe(base);
        const skills = reachable ? await skillHubList(base, typeof command.text === "string" ? command.text : "").catch(() => []) : [];
        process.stdout.write(JSON.stringify({ type: "skillhub_list", reachable, skills }) + "\n");
        continue;
      }
      if (command.type === "skillhub_install") {
        const gwSettings = await loadUiSettings();
        const base = aresGatewayBase(gwSettings);
        const id = typeof command.id === "string" ? command.id : "";
        const files = id ? await skillHubGet(base, id).catch(() => null) : null;
        if (!files) {
          process.stdout.write(JSON.stringify({ type: "skillhub_installed", ok: false, error: "skill not found on the hub" }) + "\n");
          continue;
        }
        const res = await installHubSkill(live.context.home, files).then((r) => ({ ok: true as const, ...r })).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
        process.stdout.write(JSON.stringify({ type: "skillhub_installed", ...res }) + "\n");
        continue;
      }
      if (command.type === "skillhub_publish") {
        const gwSettings = await loadUiSettings();
        const base = aresGatewayBase(gwSettings);
        const token = gwSettings.aresGatewayToken || process.env.ARES_GATEWAY_TOKEN || "";
        const name = typeof command.name === "string" ? command.name : "";
        const files = name ? await readLocalSkillFiles(live.context.home, name).catch(() => null) : null;
        if (!files) {
          process.stdout.write(JSON.stringify({ type: "skillhub_published", ok: false, error: "local skill not found" }) + "\n");
          continue;
        }
        const res = await skillHubPublish(base, token, files);
        process.stdout.write(JSON.stringify({ type: "skillhub_published", ...res }) + "\n");
        continue;
      }
      if (command.type === "usage_stats") {
        const days = Number(command.days) > 0 ? Math.floor(Number(command.days)) : 30;
        const stats = await daemonUsageStats(live.context.workspace, days).catch(() => null);
        process.stdout.write(JSON.stringify({ type: "usage_stats", days, stats }) + "\n");
        continue;
      }
      if (command.type === "anthropic_login_start") {
        // Loopback OAuth flow: start a local callback server, open the browser,
        // catch the redirect automatically, exchange for tokens, then emit done.
        const sid = command.sessionId;
        // force: an explicit sign-in click always re-authenticates — this is
        // also the only way to recover from a limit-broken or stale account.
        runAnthropicLoginFlow((url) => {
          tagEmit(sid, { type: "anthropic_login_url", url });
        }, fetch, 300_000, true)
          .then(() => {
            tagEmit(sid, { type: "anthropic_login_done", ok: true });
          })
          .catch((err: unknown) => {
            tagEmit(sid, { type: "anthropic_login_done", ok: false, error: err instanceof Error ? err.message : String(err) });
          });
        continue;
      }
      if (command.type === "anthropic_login_finish") {
        // No-op: finish is handled automatically by the loopback server.
        // Kept so older UI builds don't crash the daemon.
        continue;
      }
      if (command.type === "openai_login_start") {
        // ChatGPT OAuth (loopback authorization-code + PKCE). The browser does
        // the /authorize page — clearing Cloudflare's bot challenge, which a
        // server-side device-code fetch cannot — and we catch the redirect on
        // localhost:1455. Routes GPT usage through the ChatGPT subscription.
        const sid = command.sessionId;
        void runOpenAILoginFlow({
          onAuthorizeUrl: (url) => tagEmit(sid, { type: "openai_login_url", url }),
        })
          .then((file) => {
            tagEmit(sid, { type: "openai_login_done", ok: true, email: file.profile.email ?? null, plan: file.profile.planType ?? null });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            tagEmit(sid, { type: "openai_login_done", ok: false, error: msg.slice(0, 200) });
          });
        continue;
      }
      if (command.type === "openai_auth_status") {
        const status = await authStatus().catch(() => null);
        process.stdout.write(JSON.stringify({
          type: "openai_auth_status",
          configured: !!status?.configured,
          email: status?.email ?? null,
          plan: status?.planType ?? null,
        }) + "\n");
        continue;
      }
      if (command.type === "kimi_login_start") {
        // Kimi subscription sign-in (RFC 8628 device flow) through the embedded
        // Vanguard module, which owns the token store the drive engine and the
        // legacy kimi provider both read. The browser opens the verification
        // page with the code pre-filled; we also emit the URL for the UI card.
        const sid = command.sessionId;
        void (async () => {
          const vanguard = await import("vanguard") as {
            oauthLogin: (p: string, o?: { force?: boolean; onAuthorizeUrl?: (url: string) => void }) => Promise<{ connected: boolean; detail?: string }>;
          };
          return vanguard.oauthLogin("kimi", {
            force: true,
            onAuthorizeUrl: (url) => tagEmit(sid, { type: "kimi_login_url", url }),
          });
        })()
          .then((status) => {
            tagEmit(sid, { type: "kimi_login_done", ok: status.connected, detail: status.detail ?? null });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            tagEmit(sid, { type: "kimi_login_done", ok: false, error: msg.slice(0, 200) });
          });
        continue;
      }
      if (command.type === "kimi_auth_status") {
        const status = await (async () => {
          const vanguard = await import("vanguard") as {
            oauthStatus: (p: string) => Promise<{ connected: boolean; detail?: string }>;
          };
          return vanguard.oauthStatus("kimi");
        })().catch(() => null);
        process.stdout.write(JSON.stringify({
          type: "kimi_auth_status",
          configured: !!status?.connected,
          detail: status?.detail ?? null,
        }) + "\n");
        continue;
      }
      if (command.type === "operator_status") {
        const goals = await listGoals(live.context.home).catch(() => []);
        const active = goals.filter((g) => g.status === "active");
        // Trust meter: earned leash per domain, same derivation the effects
        // rails use — the HELM's Favor slate renders this.
        const trust = await (async () => {
          try {
            const store = await MemoryStore.open(live.context.mind.memoryFile);
            const nodes = store.all();
            const domains = new Set<string>(["browser"]);
            for (const node of nodes) {
              const domain = domainOf(node);
              if (domain) domains.add(domain);
            }
            return [...domains].sort().map((domain) => {
              const basis = deriveLeash(nodes, domain);
              return { domain, level: basis.level, proven: basis.proven.length };
            });
          } catch {
            return [];
          }
        })();
        process.stdout.write(
          JSON.stringify({
            type: "operator_status",
            autotick: process.env.ARES_OPERATOR_AUTOTICK !== "0",
            intervalMs: Math.max(60_000, Number(process.env.ARES_OPERATOR_TICK_MS) || 30 * 60_000),
            goals: goals.map((g) => ({ id: g.id, statement: g.statement.slice(0, 160), status: g.status, progress: g.progress, steps: g.stepLog?.length ?? 0 })),
            activeCount: active.length,
            trust,
          }) + "\n",
        );
        continue;
      }
      if (command.type === "gateway_connect" || command.type === "gateway_status") {
        // Ares Gateway account bridge (doingteam.com): connect persists the
        // URL+token; status (and the 20s poll below) snapshots /me for the
        // desktop Account panel. Grants surface as gateway_grant toasts.
        if (command.type === "gateway_connect") {
          const patch: Record<string, string> = {};
          if (typeof command.token === "string" && command.token.trim()) patch.aresGatewayToken = command.token.trim();
          if (typeof command.url === "string" && command.url.trim()) patch.aresGatewayUrl = command.url.trim().replace(/\/+$/, "");
          if (Object.keys(patch).length > 0) await updateUiSettings(patch);
        }
        const gwSettings = await loadUiSettings();
        const gwToken = gwSettings.aresGatewayToken;
        // Capability probe: does doingteam expose click-to-connect OAuth yet? The
        // desktop only shows the "Sign in" button when this is true, so the button
        // stays hidden (no broken UX) until the gateway endpoints go live.
        const oauthSupported = await probeAresOauth(aresGatewayBase(gwSettings)).catch(() => false);
        if (!gwToken) {
          process.stdout.write(JSON.stringify({ type: "gateway_account", connected: false, reason: "no token", oauthSupported }) + "\n");
          continue;
        }
        const me = await fetchAresGatewayMe(aresGatewayBase(gwSettings), gwToken);
        process.stdout.write(
          JSON.stringify(
            me
              ? { type: "gateway_account", connected: true, oauthSupported, ...me }
              : { type: "gateway_account", connected: false, reason: "unreachable or token rejected", oauthSupported },
          ) + "\n",
        );
        continue;
      }
      if (command.type === "gateway_signin") {
        // Click-to-connect: run the loopback code-exchange sign-in against
        // doingteam, then persist the returned account token into
        // aresGatewayToken — after which every gateway call authenticates with
        // no token paste. Fire-and-forget so the loop keeps serving; the desktop
        // opens the authorize URL from oauth_url and refreshes on oauth_connected.
        const siSettings = await loadUiSettings();
        const siBase = typeof command.url === "string" && command.url.trim()
          ? command.url.trim().replace(/\/+$/, "")
          : aresGatewayBase(siSettings);
        void runAresAccountSignin(siBase, {
          onAuthorizeUrl: (url) => { process.stdout.write(JSON.stringify({ type: "oauth_url", provider: "ares", url }) + "\n"); },
        })
          .then(async ({ token, base }) => {
            await updateUiSettings({ aresGatewayToken: token, aresGatewayUrl: base });
            process.stdout.write(JSON.stringify({ type: "oauth_connected", provider: "ares" }) + "\n");
            // Immediately snapshot the freshly-connected account for the panel.
            const me = await fetchAresGatewayMe(base, token).catch(() => null);
            process.stdout.write(
              JSON.stringify(me ? { type: "gateway_account", connected: true, oauthSupported: true, ...me } : { type: "gateway_account", connected: true, oauthSupported: true }) + "\n",
            );
          })
          .catch((err) => process.stdout.write(JSON.stringify({ type: "oauth_error", provider: "ares", error: err instanceof Error ? err.message : String(err) }) + "\n"));
        continue;
      }
      if (command.type === "operator_autotick") {
        // Live toggle of the unattended mission loop. The tick reads the env each
        // pass, so this takes effect on the next tick; also persisted so it sticks.
        const enabled = command.enabled !== false;
        if (enabled) delete process.env.ARES_OPERATOR_AUTOTICK;
        else process.env.ARES_OPERATOR_AUTOTICK = "0";
        const settings = await loadUiSettings();
        await updateUiSettings({ engine: { ...(settings.engine ?? {}), operatorAutotick: enabled } });
        process.stdout.write(JSON.stringify({ type: "operator_autotick_set", enabled }) + "\n");
        process.stdout.write(
          JSON.stringify({
            type: "operator_status",
            autotick: enabled,
            intervalMs: Math.max(60_000, Number(process.env.ARES_OPERATOR_TICK_MS) || 30 * 60_000),
            goals: (await listGoals(live.context.home).catch(() => [])).map((g) => ({ id: g.id, statement: g.statement.slice(0, 160), status: g.status, progress: g.progress, steps: g.stepLog?.length ?? 0 })),
            activeCount: (await listGoals(live.context.home).catch(() => [])).filter((g) => g.status === "active").length,
          }) + "\n",
        );
        continue;
      }
      if (command.type === "operator_control") {
        // Daemon-side entry point for the kill switch, alongside operator_status /
        // operator_autotick — so the Tauri desktop app can add a halt/resume button
        // without shelling out to the CLI. Mirrors `ares operator halt|resume`.
        const action = command.action === "resume" ? "resume" : command.action === "halt" ? "halt" : null;
        if (!action) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: 'operator_control requires action: "halt" | "resume"' }) + "\n");
          continue;
        }
        const killSwitch = new KillSwitch(live.context.effects.killSwitchFile);
        if (action === "halt") await killSwitch.engage(typeof command.reason === "string" ? command.reason : "manual");
        else await killSwitch.release();
        process.stdout.write(JSON.stringify({ type: "operator_control_set", action, engaged: await killSwitch.engaged() }) + "\n");
        continue;
      }
      if (command.type === "oauth_status") {
        // Report every provider: connected (tokens on file) + hasApp (client creds set).
        const home = live.context.home;
        const status = await connectedProviders(OAUTH_PROVIDERS, home).catch(() => ({}) as Record<string, boolean>);
        const providers = await Promise.all(
          Object.entries(OAUTH_PROVIDERS).map(async ([id, cfg]) => ({
            id,
            label: PROVIDER_LABELS[id] ?? id,
            connected: status[id] ?? false,
            hasApp: (await hasCredential(clientIdName(cfg), { home }).catch(() => false)) && (await hasCredential(clientSecretName(cfg), { home }).catch(() => false)),
          })),
        );
        process.stdout.write(JSON.stringify({ type: "oauth_status", providers }) + "\n");
        continue;
      }
      if (command.type === "oauth_set_credentials") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const cfg = getProviderConfig(provider);
        if (!cfg) { process.stdout.write(JSON.stringify({ type: "daemon_error", error: `oauth: unknown provider "${provider}"` }) + "\n"); continue; }
        const clientId = typeof command.clientId === "string" ? command.clientId.trim() : "";
        const clientSecret = typeof command.clientSecret === "string" ? command.clientSecret.trim() : "";
        if (!clientId || !clientSecret) { process.stdout.write(JSON.stringify({ type: "daemon_error", error: "oauth: clientId and clientSecret required" }) + "\n"); continue; }
        await setCredential(clientIdName(cfg), clientId, { home: live.context.home });
        await setCredential(clientSecretName(cfg), clientSecret, { home: live.context.home });
        process.stdout.write(JSON.stringify({ type: "oauth_credentials_set", provider }) + "\n");
        continue;
      }
      if (command.type === "oauth_start") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const cfg = getProviderConfig(provider);
        if (!cfg) { process.stdout.write(JSON.stringify({ type: "daemon_error", error: `oauth: unknown provider "${provider}"` }) + "\n"); continue; }
        // Spin up the loopback callback server, hand the consent URL to the UI to
        // open in the system browser, and emit the result. Fire-and-forget so the
        // command loop keeps serving while the owner authorizes.
        void startOAuthFlow({
          provider: cfg,
          home: live.context.home,
          onAuthorizeUrl: (url) => { process.stdout.write(JSON.stringify({ type: "oauth_url", provider, url }) + "\n"); },
          onSuccess: () => { process.stdout.write(JSON.stringify({ type: "oauth_connected", provider }) + "\n"); },
          onError: (err) => { process.stdout.write(JSON.stringify({ type: "oauth_error", provider, error: err.message }) + "\n"); },
        }).catch((err) => { process.stdout.write(JSON.stringify({ type: "oauth_error", provider, error: err instanceof Error ? err.message : String(err) }) + "\n"); });
        continue;
      }
      if (command.type === "oauth_disconnect") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const cfg = getProviderConfig(provider);
        if (!cfg) { process.stdout.write(JSON.stringify({ type: "daemon_error", error: `oauth: unknown provider "${provider}"` }) + "\n"); continue; }
        await deleteCredential(`oauth/${cfg.provider}`, { home: live.context.home }).catch(() => {});
        process.stdout.write(JSON.stringify({ type: "oauth_disconnected", provider }) + "\n");
        continue;
      }
      if (command.type === "steer") {
        // Steer: queue the user's mid-turn nudge into THAT session as a
        // high-priority reminder. The engine's mid-turn drain folds it in AFTER
        // the current tool batch, before the next model call — the model adapts
        // without losing context.
        const text = typeof command.goal === "string" ? command.goal : typeof command.text === "string" ? command.text : "";
        if (!text.trim()) {
          tagEmit(command.sessionId, { type: "daemon_error", error: "steer requires text" });
          continue;
        }
        const entry = sessions.get(command.sessionId || DEFAULT_SID);
        if (entry?.vanguardMode && vanguardDrive.isTurnActive(command.sessionId || DEFAULT_SID)) {
          // Vanguard steering lands at the engine's next decision boundary and
          // is journaled — no interrupt needed.
          vanguardDrive.steerTurn(command.sessionId || DEFAULT_SID, text.trim());
          tagEmit(command.sessionId, { type: "steer_queued", text: text.trim() });
          continue;
        }
        if (!entry?.turnActive) {
          tagEmit(command.sessionId, { type: "daemon_error", error: "there is no active turn to steer" });
          continue;
        }
        // Preempt a provider or tool that may never reach the old "safe"
        // reminder boundary. The turn runner resumes the same pending turn with
        // this steering text injected after the interrupt unwinds.
        entry.pendingSteers.push(text.trim());
        tagEmit(command.sessionId, { type: "steer_queued", text: text.trim() });
        entry.live.session.interrupt();
        continue;
      }
      if (command.type !== "send" || !command.goal) {
        tagEmit(command.sessionId, { type: "daemon_error", error: "expected {type:\"send\", goal:string}" });
        continue;
      }
      // Resolve (or lazily spawn) the target session. Then run the turn in the
      // BACKGROUND — the command loop keeps accepting commands so other sessions
      // stream concurrently and steer/interrupt land mid-turn.
      const sid = command.sessionId || DEFAULT_SID;
      const goal = command.goal;
      const voiceMode = command.voice === true;
      const entry = await resolveEntry(command.sessionId);
      if (entry.vanguardMode) {
        // Vanguard is driving this session. Mid-turn sends steer the live run;
        // otherwise the goal starts a fresh Vanguard turn in the background,
        // rendered through the normal transcript via translated events.
        if (vanguardDrive.isTurnActive(sid)) {
          vanguardDrive.steerTurn(sid, goal.trim());
          tagEmit(command.sessionId, { type: "steer_queued", text: goal.trim() });
          continue;
        }
        const settings = await loadUiSettings();
        // "Work in C:\X" just works: an absolute path in the goal that names a
        // real directory (or a file inside one) re-pins this session's drive
        // workspace — no prompt, no toggle dance. The ack refreshes the badge.
        // Natural-language locations work too: "on my desktop", "in my
        // documents" resolve through the OS known folders (OneDrive-redirected
        // desktops included), so "make a folder on my desktop called X" builds
        // exactly there instead of stating a workspace limitation.
        let rebindTarget: string | undefined;
        const mentioned = goal.match(/[A-Za-z]:[\\/][^\s"'`|<>*?]+/u)?.[0]?.replace(/[.,;:!?)\]]+$/u, "");
        if (mentioned) {
          const resolved = path.resolve(mentioned);
          rebindTarget = await stat(resolved).then((s) => (s.isDirectory() ? resolved : path.dirname(resolved))).catch(() => undefined);
        }
        if (!rebindTarget) {
          const known = goal.match(/\b(?:on|onto|in|into|to)\s+(?:my\s+|the\s+)?(desktop|documents|downloads)\b/iu)?.[1]?.toLowerCase();
          if (known) rebindTarget = await resolveKnownFolder(known);
        }
        if (rebindTarget && rebindTarget !== (entry.vanguardWorkspace ?? entry.live.context.workspace)) {
          entry.vanguardWorkspace = rebindTarget;
          tagEmit(command.sessionId, { type: "vanguard_mode", enabled: true, workspace: rebindTarget });
        }
        // Auto-routing applies to drive turns exactly like native ones: the
        // current message decides the lane, and a live lane assignment takes
        // the wheel. The drive rebinds its engine session on model change.
        let driveFamily = providerFamilyForSelection(entry.live.selection);
        let rawModel = entry.live.selection.model;
        let driveProviderName = entry.live.selection.provider.name;
        let routeSource: "assigned" | "main" = "main";
        if (settings.routingMode === "auto") {
          const goalLane = classifyLane(goal);
          const lane = goalLane !== "chat" ? goalLane
            : goal.trim().split(/\s+/u).length < 8 ? classifyLane([entry.lane ?? "", goal].join("\n")) : "chat";
          const assigned = settings.routing?.[lane];
          if (assigned?.family && assigned.model && !isProviderDead(assigned.family)) {
            driveFamily = assigned.family;
            rawModel = assigned.model;
            driveProviderName = assigned.family === "ollama" ? "ollama-cloud:assigned" : assigned.family;
            routeSource = "assigned";
          }
          entry.lane = lane;
          tagEmit(command.sessionId, { type: "route_resolved", model: rawModel, provider: driveFamily, lane, source: routeSource });
        }
        // Ollama Cloud models are addressed through the local daemon with a
        // :cloud suffix; the Ares selection stores the bare id. Without the
        // suffix the local daemon reports an unknown model and the turn dies.
        const driveModel = driveFamily === "ollama"
          && driveProviderName.startsWith("ollama-cloud")
          && !rawModel.includes(":")
          && !rawModel.endsWith("-cloud")
          ? `${rawModel}:cloud`
          : rawModel;
        void vanguardDrive.runTurn(sid, command.sessionId, goal, {
          workspace: entry.vanguardWorkspace ?? entry.live.context.workspace,
          family: driveFamily,
          model: driveModel,
          settings,
        });
        continue;
      }
      if (entry.turnActive) {
        // A send mid-turn IS steering — the owner talking over Ares ("hey
        // Ares, no—") must never bounce with an error. Same drain as steer.
        entry.pendingSteers.push(goal.trim());
        tagEmit(command.sessionId, { type: "steer_queued", text: goal.trim() });
        entry.live.session.interrupt();
        continue;
      }
      entry.turnActive = true;
      activeTurns++;
      void (async () => {
        // Auto routing is STICKY (S2): a model OWNS the conversation until the
        // task domain (lane) actually changes. No per-turn flip-flop and no
        // mid-conversation model swap — context and the prompt cache stay
        // coherent, so you never get quality/personality whiplash per message.
        try {
          const settings = await loadUiSettings();
          const recentGoals = entry.live.session
            .history()
            .filter((message) => message.role === "user" && !message.content.some((block) => block.type === "tool_result"))
            .slice(-2)
            .map((message) => messageText(message));
          // The CURRENT message decides the lane. Folding recent history into
          // the classification made coding stick: two prior coding messages
          // kept classifying a fresh chat message as "coding", so the route
          // never flipped back. History now only breaks ties for short
          // follow-ups ("yes do it") that carry no lane signal of their own.
          const goalLane = classifyLane(goal);
          const lane = goalLane !== "chat"
            ? goalLane
            : goal.trim().split(/\s+/u).length < 8
              ? classifyLane([...recentGoals, goal].join("\n"))
              : "chat";
          let model = entry.live.selection.model;
          let providerName = providerFamilyForSelection(entry.live.selection);
          let source: "assigned" | "main" | "sticky" = "main";
          if (settings.routingMode === "auto") {
            const assigned = settings.routing?.[lane];
            const onAssigned = !!assigned && assigned.family === providerName && assigned.model === model;
            const laneChanged = entry.lane !== undefined && entry.lane !== lane;
            const firstTurn = entry.lane === undefined;
            // A dead current provider (auth/limit-parked) forfeits stickiness:
            // without this, a broken model owns the conversation forever and
            // the assigned route never gets a chance to take over.
            const currentDead = isProviderDead(providerName);
            // Switch when the domain genuinely changed (or on the very first
            // turn, or to escape a dead model) and there's a live assignment
            // for the lane. Otherwise the current model keeps the conversation.
            if (assigned?.family && assigned.model && !onAssigned && !isProviderDead(assigned.family) && (laneChanged || firstTurn || currentDead)) {
              try {
                const sel = await selectProvider(new Map([["provider", assigned.family], ["model", assigned.model]]));
                await preflightProviderSelection(sel);
                await entry.live.session.setProvider(sel.provider, sel.model, {
                  contextBudgetTokens: chatContextBudget(sel),
                  summarizeSpan: makeSpanSummarizer(sel, (usage) =>
                    entry.live.session.recordAuxiliaryUsage("compaction", sel.provider.name, sel.model, usage),
                  ),
                });
                entry.live.selection = sel;
                model = sel.model;
                providerName = providerFamilyForSelection(sel);
                source = "assigned";
              } catch {
                // bad family / missing key → keep the current model
              }
            } else if (onAssigned) {
              source = "assigned";
            } else {
              source = "sticky"; // staying on the model that already owns this conversation
            }
            entry.lane = lane;
          }
          tagEmit(command.sessionId, { type: "route_resolved", model, provider: providerName, lane, source });
        } catch {
          // best-effort — never block a turn on attribution
        }
        const turnState = { status: "completed" as "completed" | "interrupted" | "failed", fatalProvider: null as string | null };
        // Restore the user's pinned model after a one-turn vision escalation.
        let revertSelection: ProviderSelection | null = null;
        let escalatedSelection: ProviderSelection | null = null;
        try {
          await prepareUserTurn(entry.live, goal);
          // ── Vision guard: never ship a pasted image to a blind model. ──
          // A pinned text-only model (deepseek et al) used to receive the image
          // blocks anyway and answer "can't view the image" or guess blind
          // (sess_e4c6022d). If this turn carries images and the active model
          // lacks vision, escalate JUST this turn to a vision-capable provider
          // (never off the Ares Gateway), or tell the model to be honest.
          const turnContent = await contentFromUserInput(goal, entry.live.context.workspace);
          if (voiceMode) turnContent.unshift({ type: "system_reminder", text: "<voice-mode/>" });
          const hasImages = turnContent.some((block) => block.type === "image");
          if (hasImages && !modelLikelyHasVision(entry.live.selection.model)) {
            const pinned = entry.live.selection;
            const visionSel = await pickVisionFallback(pinned, liveDeadProviders()).catch(() => null);
            if (visionSel) {
              await entry.live.session.setProvider(visionSel.provider, visionSel.model, {
                contextBudgetTokens: chatContextBudget(visionSel),
                summarizeSpan: makeSpanSummarizer(visionSel, (usage) =>
                  entry.live.session.recordAuxiliaryUsage("compaction", visionSel.provider.name, visionSel.model, usage),
                ),
              });
              entry.live.selection = visionSel;
              revertSelection = pinned;
              escalatedSelection = visionSel;
              tagEmit(sid, {
                type: "system_reminder_injected",
                source: "instructions",
                text: `Image attached — ${pinned.model} can't see images, so this turn runs on ${visionSel.provider.name}/${visionSel.model}. Your model choice is restored next turn.`,
              });
              tagEmit(sid, { type: "route_resolved", model: visionSel.model, provider: visionSel.provider.name, lane: entry.lane ?? "chat", source: "assigned" });
            } else {
              entry.live.queueSystemReminder(
                `The user attached an image, but the current model (${pinned.model}) cannot see images and no vision-capable provider is configured. Say so plainly, describe what you'd need (a vision model — e.g. Claude, GPT-4o, or Gemini — selected in the model picker), and work from the user's text only. Do NOT guess at the image's contents.`,
                "instructions",
              );
            }
          }
          const streamOnce = async (gen: AsyncGenerator<unknown>) => {
            for await (const event of gen) {
              const ev = event as { type: string; status?: "completed" | "interrupted" | "failed"; error?: { code?: string; message?: string }; touchedFiles?: string[]; text?: string };
              // Continuous verification, daemon path: every edited file feeds the
              // verifier (same as the chat paths); the engine's end-of-turn gate
              // settles it and refuses "done" over red verdicts.
              if (ev.touchedFiles?.length) entry.live.verifier.scheduleFor(ev.touchedFiles);
              if (ev.type === "turn_end" && ev.status) turnState.status = ev.status;
              if (ev.type === "error" && isProviderFatalError(ev.error)) {
                turnState.fatalProvider = `${ev.error?.code ?? "provider_error"}: ${ev.error?.message ?? ""}`.slice(0, 200);
              }
              if (ev.type === "system_reminder_injected" && typeof ev.text === "string") {
                const landed = entry.landingSteers.findIndex((steer) => steer.reminder === ev.text);
                if (landed >= 0) {
                  const [steer] = entry.landingSteers.splice(landed, 1);
                  tagEmit(sid, { type: "steer_applied", text: steer.text });
                }
              }
              // Steering preemption is internal. Keep the composer busy until
              // the automatically resumed attempt reaches its real turn_end.
              if (ev.type === "turn_end" && ev.status === "interrupted" && entry.pendingSteers.length > 0) continue;
              tagEmit(sid, event as Record<string, unknown>);
            }
          };
          await streamOnce(entry.live.session.sendContent(turnContent));

          // Queue steering only after the interrupted attempt unwinds. That
          // guarantees the resumed provider call receives it instead of draining
          // it immediately before an abort boundary.
          while (entry.pendingSteers.length > 0) {
            const steers = entry.pendingSteers.splice(0);
            for (const text of steers) {
              const reminder = `The user STEERED mid-task: "${text}". Adjust course to honor this, but keep your current objective and everything you've already done — do not restart.`;
              entry.landingSteers.push({ text, reminder });
              entry.live.queueSystemReminder(reminder, "instructions");
            }
            turnState.status = "completed";
            turnState.fatalProvider = null;
            await streamOnce(entry.live.session.resumeTurn());
          }

          // Self-healing fallback: if the turn died because the current provider
          // is unauthenticated / out of balance / unreachable, walk healthy
          // providers until one actually completes the turn — not just one hop.
          // Dead-on-balance providers are remembered so later turns skip them.
          let fallbackHops = 0;
          while (turnState.status === "failed" && turnState.fatalProvider && fallbackHops < 4) {
            fallbackHops++;
            // The provider that just failed: if it's a balance/auth death, retire
            // it for the session so we never waste another turn on it.
            if (isPermanentlyDeadError(turnState.fatalProvider)) {
              markProviderDead(providerFamilyForSelection(entry.live.selection));
            }
            const routingMode = (await loadUiSettings().catch(() => ({ routingMode: "manual" as const }))).routingMode;
            const fallback = await pickHealthyFallback(entry.live.selection, liveDeadProviders(), {
              allowCrossProvider: routingMode === "auto",
            }).catch(() => null);
            if (!fallback) {
              const onAres = providerFamilyForSelection(entry.live.selection) === "ares";
              tagEmit(sid, {
                type: "system_reminder_injected",
                source: "instructions",
                text: onAres
                  ? `Your Ares account couldn't run this turn (${turnState.fatalProvider}). Check your credits and granted models at doingteam.com → Account — you won't be switched to another provider's key.`
                  : routingMode !== "auto"
                    ? `Pinned provider ${providerFamilyForSelection(entry.live.selection)}/${entry.live.selection.model} failed (${turnState.fatalProvider}). The selection was kept. Enable Auto routing if you want cross-provider failover.`
                    : `All configured providers failed (${turnState.fatalProvider}). Add credit or a working API key in Settings → API Keys.`,
              });
              break;
            }
            await entry.live.session.setProvider(fallback.provider, fallback.model, {
              contextBudgetTokens: chatContextBudget(fallback),
              summarizeSpan: makeSpanSummarizer(fallback, (usage) =>
                entry.live.session.recordAuxiliaryUsage("compaction", fallback.provider.name, fallback.model, usage),
              ),
            });
            entry.live.selection = fallback;
            // Persist as the session default so the NEXT message starts on the
            // healthy provider instead of re-running the dead gauntlet.
            mainSelection = fallback;
            mainProviderFamily = providerFamilyForSelection(fallback);
            tagEmit(sid, {
              type: "system_reminder_injected",
              source: "instructions",
              text: `Provider failed (${turnState.fatalProvider}). Auto routing switched to ${providerFamilyForSelection(fallback)}/${fallback.model}.`,
            });
            tagEmit(sid, { type: "route_resolved", model: fallback.model, provider: providerFamilyForSelection(fallback), lane: entry.lane ?? "chat", source: "assigned" });
            // Reset and re-run; if THIS one also fails fatally the loop continues.
            turnState.status = "completed";
            turnState.fatalProvider = null;
            await streamOnce(entry.live.session.resumeTurn());
          }
          await finishTurn(entry.live, turnState.status);
          // A completed turn may have landed a commit — reflect it into the war
          // map. Fire-and-forget; reflection never delays or breaks the turn.
          if (turnState.status === "completed" && (entry.live.session.lastWorkStatus === "verified" || entry.live.session.lastWorkStatus === "not_applicable")) {
            void reflectAfterTurn(goal).catch(() => {});
            // Learn from the conversation too — durable facts/preferences → memory.
            void reflectConversationAfterTurn(entry, sid).catch(() => {});
          }
        } catch (err) {
          tagEmit(command.sessionId, { type: "error", error: { code: "turn_throw", message: err instanceof Error ? err.message : String(err), retriable: false } });
          tagEmit(command.sessionId, { type: "turn_end", status: "failed", usage: {}, durationMs: 0 });
        } finally {
          // A vision escalation was for THIS turn only — hand the conversation
          // back to the user's pinned model. If the failover loop replaced the
          // model mid-turn (provider death), its choice wins — don't revert onto
          // a pin that may itself be part of the problem.
          if (revertSelection && escalatedSelection && entry.live.selection === escalatedSelection) {
            try {
              const pinned = revertSelection;
              await entry.live.session.setProvider(pinned.provider, pinned.model, {
                contextBudgetTokens: chatContextBudget(pinned),
                summarizeSpan: makeSpanSummarizer(pinned, (usage) =>
                  entry.live.session.recordAuxiliaryUsage("compaction", pinned.provider.name, pinned.model, usage),
                ),
              });
              entry.live.selection = pinned;
            } catch {
              // keep the vision model rather than kill the session
            }
          }
          entry.turnActive = false;
          activeTurns--;
        }
      })();
    }
  } finally {
    setExtensionBrowserBridge(null);
    await vanguardDrive.shutdown().catch(() => undefined);
    await browserExtensionBridge?.close().catch(() => undefined);
    autotickLoop?.stop();
    uninstallCrashHandlers();
    commands.close();
    rl.close();
    unsubscribeLifecycle();
    try {
      unsubscribeGatewayMirror?.();
    } catch {
      // best-effort mirror teardown
    }
    // Tear down every session (the primary owns the shared mind loop).
    const allEntries = sessions.size > 0 ? [...sessions.values()] : [primaryEntry];
    for (const entry of allEntries) {
      try {
        await disposeLiveSession(entry.live);
      } catch {
        // best-effort teardown
      }
    }
    await mindSessionEnded();
    rl.close();
  }
  return 0;
}
