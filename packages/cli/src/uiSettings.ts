import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { aresHome } from "@ares/core";
import type { ReasoningLevel } from "@ares/protocol";
import type { RouteAssignments } from "@ares/core";
import type { ThemeName } from "./terminalUi.js";
import type { PermissionSettings } from "./permissionPolicy.js";
import { encryptSecret, decryptSecret } from "./keyVault.js";

/** Settings fields that hold secrets — encrypted at rest, decrypted on load. */
const SECRET_FIELDS = [
  "openRouterKey",
  "anthropicKey",
  "braveKey",
  "tavilyKey",
  "deepSeekKey",
  "kimiKey",
  "aresGatewayToken",
  "ollamaApiKey",
  "customApiKey",
  "telegramBotToken",
] as const;

async function decryptSecretFields(settings: UiSettings): Promise<UiSettings> {
  const next = { ...settings };
  for (const field of SECRET_FIELDS) {
    if (typeof next[field] === "string") next[field] = await decryptSecret(next[field]);
  }
  return next;
}

async function encryptSecretFields(settings: UiSettings): Promise<UiSettings> {
  const next = { ...settings };
  for (const field of SECRET_FIELDS) {
    if (typeof next[field] === "string") next[field] = await encryptSecret(next[field]);
  }
  return next;
}

export interface UiSettings {
  theme?: ThemeName;
  lastProvider?: "openai" | "ollama" | "mock" | "openrouter" | "anthropic" | "deepseek" | "ares" | "custom" | "moa";
  lastOpenAIModel?: string;
  lastOllamaModel?: string;
  favoriteOllamaModels?: string[];
  favoriteOpenAIModels?: string[];
  dangerousBypass?: boolean;
  /** Owner-selected reasoning dial (low→max). Applies across providers. */
  reasoningLevel?: ReasoningLevel;
  /** Owner-assigned per-lane model routing (chat/coding/research/tool-use). */
  routing?: RouteAssignments;
  /** Explicit model selection mode. Auto applies routing lanes per turn. */
  routingMode?: "manual" | "auto";
  /** OpenRouter API key (owner-pasted in-app). Bearer auth for openrouter.ai. */
  openRouterKey?: string;
  /** Last OpenRouter model id the owner selected. */
  lastOpenRouterModel?: string;
  /** Anthropic API key (owner-pasted in-app). x-api-key auth for api.anthropic.com. */
  anthropicKey?: string;
  /** Ares Gateway (doingteam.com) — account base URL + bearer token. */
  aresGatewayUrl?: string;
  aresGatewayToken?: string;
  lastAresModel?: string;
  /** Brave Search API key — upgrades WebSearch from DDG scrape to the Brave API. */
  braveKey?: string;
  /** Tavily Search API key — agent-grade search, tried after Brave, before DDG. */
  tavilyKey?: string;
  /** Last Anthropic model id the owner selected. */
  lastAnthropicModel?: string;
  /** DeepSeek API key for the official api.deepseek.com endpoint. */
  deepSeekKey?: string;
  /** Last DeepSeek model id the owner selected. */
  lastDeepSeekModel?: string;
  /** Kimi (Moonshot) API key for the api.kimi.com coding endpoint. */
  kimiKey?: string;
  /** Last Kimi model id the owner selected. */
  lastKimiModel?: string;
  /** Ollama Cloud API key for direct ollama.com catalog and model access. */
  ollamaApiKey?: string;
  /** Custom OpenAI-compatible provider — base URL ending in the API root, e.g.
   *  https://api.together.xyz/v1 or http://localhost:1234/v1 (LM Studio). Ares
   *  hits {base}/chat/completions for chat and {base}/models for discovery. */
  customBaseUrl?: string;
  /** Custom provider API key — Bearer auth against customBaseUrl (encrypted). */
  customApiKey?: string;
  /** Last model id selected on the custom provider (from /models discovery). */
  lastCustomModel?: string;
  /** Last Mixture-of-Agents ensemble picked (e.g. "moa-council"). */
  lastMoaModel?: string;
  /** Advanced engine knobs surfaced in the desktop Advanced tab. */
  engine?: EngineConfig;
  /** Owner-toggleable permission posture (master + per-category + fleet inherit).
   *  Absent → DEFAULT_PERMISSIONS (guarded; sensitive asks; fleets inherit). */
  permissions?: PermissionSettings;
  /** Skills the owner has disabled (by name). Absent = all enabled. */
  disabledSkills?: string[];
  /** Telegram bot token (from @BotFather) — encrypted at rest. */
  telegramBotToken?: string;
  /** Allowlisted Telegram chat ids (comma-separated). Only these can command Ares. */
  telegramAllowedChats?: string;
  /** Default chat id for outbound reports / briefings. */
  telegramDefaultChatId?: string;
  /** Whether the Telegram bridge should auto-start with the daemon. */
  telegramEnabled?: boolean;
  /** Whether Consciousness (the embedded local watcher brain) is awakened.
   *  When true, Ares pulls its local vision + embedding models and — in later
   *  stages — runs the always-on screen-watch loop. */
  consciousnessEnabled?: boolean;
}

/** Advanced run-tuning knobs. All optional; absent → engine defaults. */
export interface EngineConfig {
  /** Hard ceiling on tool-calling turns before the engine stops (default 80). */
  maxTurns?: number;
  /** Consecutive gather-only rounds before the convergence nudge (default 10). */
  gatherStallRounds?: number;
  /** Model-facing tool-result char cap (default 24000). */
  toolResultChars?: number;
  /** Operator auto-tick on/off while idle (default true). */
  operatorAutotick?: boolean;
  /** Operator auto-tick interval in minutes (default 30). */
  operatorTickMinutes?: number;
  /** Subagent turn limit (default 50). */
  subagentTurnLimit?: number;
  /** Let ComputerUse activate/drive REAL browser windows with the physical
   *  mouse (default false — web content must not reach the desktop input). */
  computerUseBrowser?: boolean;
}

export function uiSettingsPath(): string {
  return path.join(aresHome(), "ui.json");
}

export async function loadUiSettings(): Promise<UiSettings> {
  try {
    const parsed = JSON.parse(await readFile(uiSettingsPath(), "utf8")) as UiSettings;
    const decrypted = await decryptSecretFields(parsed);
    return {
      ...decrypted,
      favoriteOllamaModels: decrypted.favoriteOllamaModels ?? [],
      favoriteOpenAIModels: decrypted.favoriteOpenAIModels ?? [],
    };
  } catch {
    return { favoriteOllamaModels: [], favoriteOpenAIModels: [] };
  }
}

export async function saveUiSettings(settings: UiSettings): Promise<void> {
  const filePath = uiSettingsPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  // Secrets are encrypted at rest; the in-memory settings stay plaintext.
  const onDisk = await encryptSecretFields(settings);
  await writeFile(filePath, JSON.stringify(onDisk, null, 2) + "\n", "utf8");
}

export async function updateUiSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
  const next = { ...(await loadUiSettings()), ...patch };
  await saveUiSettings(next);
  return next;
}
