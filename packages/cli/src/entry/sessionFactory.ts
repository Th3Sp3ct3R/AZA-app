// Extracted from entry.ts — sessionFactory.

import { Session, ContinuousVerifier, HookManager, CodingJournal, loadStartupReminders, loadSessionSnapshot, openWorkspaceSessionKernel, type EngineTool, sideQuery, collectTrimmedFilePaths } from "@ares/core";
import { createHash } from "node:crypto";
import path from "node:path";
import { TodoStore, ShellRegistry, type FileReadStamp } from "@ares/tools";
import type { ContentBlock, Message, PermissionPromptDecision, ReasoningLevel } from "@ares/protocol";
import { isReasoningLevel } from "@ares/protocol";
import type { ToolPermissionRequest } from "@ares/core";
import { notice } from "../terminalUi.js";
import { loadUiSettings, updateUiSettings, type UiSettings } from "../uiSettings.js";
import { AresAgentRuntime, prepareAresAgent, readPersona, scanCapabilityRegistry, type CapabilityProvider, type PersonaDef } from "@ares/agent";
import { listCapabilities, seedAllCapabilities, writeCapabilitiesDoc } from "@ares/operator";
import { ManualReminderSource, applyEngineConfigEnv } from "./daemon.js";
import { buildEngineTools } from "./engineTools.js";
import { AresCommandPermissionStore, AresPathPermissionStore, promptPermission } from "./permissions.js";
import { ProviderSelection, daemonModelCatalog, providerFamilyForSelection, selectProvider } from "./providers.js";
import { AresRuntimeState, CliRuntimeContext, ParsedArgs, cliRuntimeContext } from "./runtime.js";
import { resumeMessageLimit } from "./terminalLines.js";
import { buildSystemPrompt, loadGitContext, loadLiveMindContext, recallFailureFixFromMemory } from "./turnPipeline.js";

function contextSourceHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Compile the environment detection plane from provider manifests instead of
 * teaching the core harness a permanent list of editors/engines. Newly forged
 * providers become visible on the next mutation without restarting Ares. */
function makeEnvironmentArtifactSignals(home: string, workspace: string) {
  let providers: CapabilityProvider[] = [];
  let refreshedAt = 0;
  return async (event: {
    toolName: string;
    input: unknown;
    output?: unknown;
    touchedFiles?: readonly string[];
  }): Promise<string[]> => {
    if (event.toolName === "Capability") refreshedAt = 0;
    const command = (event.toolName === "Bash" || event.toolName === "PowerShell") &&
      event.input && typeof event.input === "object" && !Array.isArray(event.input)
      ? String((event.input as Record<string, unknown>).command ?? "")
      : "";
    const files = event.touchedFiles ?? [];
    if (!command && files.length === 0) return [];

    const now = Date.now();
    if (now - refreshedAt > 1_000) {
      providers = (await scanCapabilityRegistry({ home, workspace })).providers
        .filter((provider) => provider.manifest.kind === "environment-provider");
      refreshedAt = now;
    }

    const signals: string[] = [];
    for (const provider of providers) {
      const fileMatch = provider.manifest.match.files
        .map((pattern) => ({ pattern, file: files.find((candidate) => manifestPatternMatches(pattern, candidate)) }))
        .find((match) => match.file);
      const commandPattern = command
        ? provider.manifest.match.commands.find((pattern) => manifestPatternMatches(pattern, command))
        : undefined;
      if (fileMatch?.file) signals.push(`provider:${provider.manifest.id}:file:${path.basename(fileMatch.file)}`);
      if (commandPattern) signals.push(`provider:${provider.manifest.id}:command:${commandPattern}`);
    }
    return signals;
  };
}

export function manifestPatternMatches(pattern: string, candidate: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").trim();
  const normalizedCandidate = candidate.replace(/\\/g, "/");
  if (!normalizedPattern) return false;
  if (!/[?*]/.test(normalizedPattern)) {
    return normalizedCandidate.toLowerCase().includes(normalizedPattern.toLowerCase());
  }
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/\u0000/g, ".*");
  return new RegExp(`(?:^|/)${source}(?:$|/)`, "i").test(normalizedCandidate);
}

export interface ResumedSessionInfo {
  id: string;
  eventCount: number;
  preview: string;
  replayedMessageCount: number;
  omittedMessageCount: number;
  compacted: boolean;
}

export interface LiveSession {
  session: Session;
  selection: ProviderSelection;
  context: CliRuntimeContext;
  runtime: AresRuntimeState;
  verifier: ContinuousVerifier;
  hooks: HookManager;
  shellRegistry: ShellRegistry;
  todoStore: TodoStore;
  /** The full engine tool set this session runs with — also used to arm
   *  Operator auto-tick workers from the daemon. */
  tools: readonly EngineTool[];
  agentRuntime?: AresAgentRuntime;
  queueSystemReminder(text: string, source?: ManualReminderSource): void;
  /**
   * Wear a persona (or null to drop it) for the rest of this conversation.
   *
   * Recomposes the system prompt and swaps it in place — message history is
   * untouched, so adopting mid-conversation keeps everything already said. This
   * lives on LiveSession rather than being rebuilt per channel because the same
   * recomposition (agent layer + live mind + git context) has to be reproduced
   * exactly; doing it in one place is what keeps the daemon, TUI, and Telegram
   * from drifting apart.
   */
  adoptPersona(persona: PersonaDef | null): void;
  /** The persona currently worn, or null. */
  activePersona(): PersonaDef | null;
  resumed?: ResumedSessionInfo;
  /** V6: living-memory ids injected into the current turn — settled at turn end. */
  lastRecallIds?: string[];
  /**
   * Durable copy of the last turn's recall, for display.
   *
   * lastRecallIds above is CONSUMED at turn end (finishTurn reads it, records
   * the outcome, then clears it), so anything reading it after a turn is
   * structurally guaranteed to see nothing. The cockpit read it and therefore
   * always reported "0 memories recalled" — which looked exactly like recall
   * being dead. This survives the turn so the panel can tell the difference,
   * and carries the outcome verdict so promotion/decay is visible rather than
   * merely asserted.
   */
  lastRecallSummary?: { ids: string[]; won: boolean; at: number };
  /** Lazy coding-only repository cartography cadence. */
  repositoryMapCodingTurns?: number;
  repositoryMapLastTurn?: number;
  repositoryMapTouchedCount?: number;
  repositoryMapText?: string;
  /** V5: the user message of the current turn, for the Witness snapshot. */
  lastUserMessage?: string;
  /** Terminal auto-routing lane currently owning this conversation. */
  routeLane?: string;
  /** The live reasoning dial for THIS session's engine — the source of truth the
   *  display reads (engine.cfg is private). Kept in lock-step with
   *  session.setReasoningLevel via handleReasoningCommand. Without this, /reasoning
   *  (no-arg) and /settings reported the env/persisted value, not what the engine
   *  is actually streaming with. */
  reasoningLevel: ReasoningLevel;
  /** Structured coding state that survives compaction and process restart. */
  codingJournal: CodingJournal;
}

/**
 * C1 — the end-of-turn gate, composed: flush+await the continuous verifier,
 * then hand any red verdicts to the engine, which injects them and keeps the
 * turn alive. The model cannot say "done" while its own edits are broken.
 */
export async function confirmTurnEndWith(
  verifier: ContinuousVerifier,
): Promise<Array<{ text: string; source: "verifier" | "hook" }>> {
  // A verdict that's about to land must not be abandoned: 10s was shorter than
  // a typical tsc/test run, so the gate saw "still running" twice, called
  // itself stuck, and let the turn end with the verdict never delivered.
  const settleMs = Number(process.env.ARES_VERIFY_SETTLE_MS) > 0 ? Number(process.env.ARES_VERIFY_SETTLE_MS) : 60_000;
  await verifier.settle(settleMs);
  return verifier
    .drainReminders()
    .map((r) => ({ text: `${r.text}

Fix this before finishing. The edited scope is red; establish whether this change introduced the failure or it is a documented baseline issue, and provide evidence either way.`, source: "verifier" as const }));
}

export async function createSession(
  args: ParsedArgs,
  resumeSessionId?: string,
  requestPermission: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision> = promptPermission,
  opts: { startAgentRuntime?: boolean; sessionId?: string; detachedStartupRecovery?: boolean } = {},
): Promise<LiveSession> {
  // Owner-stored service keys ride into the tool layer via env (WebSearch
  // reads ARES_BRAVE_API_KEY). Settings win only when the env isn't set.
  const settings = await loadUiSettings();
  if (settings.braveKey && !process.env.ARES_BRAVE_API_KEY) {
    process.env.ARES_BRAVE_API_KEY = settings.braveKey;
  }
  if (settings.tavilyKey && !process.env.ARES_TAVILY_API_KEY) {
    process.env.ARES_TAVILY_API_KEY = settings.tavilyKey;
  }
  const selection = await selectProvider(args.flags);
  return createSessionWithSelection(args, selection, resumeSessionId, requestPermission, opts);
}

// The reasoning dial the owner controls. Precedence: env override → persisted
// setting → "medium" (snappy-but-capable; a fresh session never burns minutes
// thinking on a trivial "hi", and the owner can crank it to high/max). Works
// for OpenAI (effort) and Ollama (thinking budget) alike — the providers
// translate it. The context budget trims oldest history so a long thread or a
// vision message can never hard-fail with context_length_exceeded.
export function resolveReasoningLevel(settings: UiSettings): ReasoningLevel {
  const env = process.env.ARES_REASONING_LEVEL?.toLowerCase();
  if (isReasoningLevel(env)) return env;
  if (isReasoningLevel(settings.reasoningLevel)) return settings.reasoningLevel;
  return "medium";
}

/** Was the env override (ARES_REASONING_LEVEL) what last resolved the dial?
 *  Used so an explicit /reasoning can tell the owner their persisted choice was
 *  being shadowed by the env, instead of silently ignoring it. */
function reasoningEnvOverrideActive(): boolean {
  return isReasoningLevel(process.env.ARES_REASONING_LEVEL?.toLowerCase());
}

/** Outcome of an explicit /reasoning <level>, so each dispatch site renders its
 *  own transport (NDJSON vs notice) from one source of truth. */
interface ReasoningChange {
  level: ReasoningLevel;
  appliedTo: number;
  /** True when an ARES_REASONING_LEVEL env override was shadowing the dial and we
   *  cleared it so the explicit choice wins this session. */
  clearedEnvOverride: boolean;
}

/**
 * THE one place /reasoning <level> is handled. The three former dispatch sites
 * (daemon, TUI, REPL) each reimplemented validate/set/persist and had already
 * drifted — the daemon applied to every open session, the others only the
 * primary, so changing the dial inside a spawned chat silently did nothing.
 *
 * Validates, sets the level on EVERY open session's engine (and mirrors it onto
 * each LiveSession.reasoningLevel so the display reads live state), persists, and
 * — crucially — clears any ARES_REASONING_LEVEL env override so the owner's
 * explicit choice wins for the rest of the session instead of being silently
 * re-floored to the env value on the next fresh session. Returns null when the
 * level is invalid (the caller renders the usage line).
 */
export async function handleReasoningCommand(
  level: ReasoningLevel,
  liveSessions: Iterable<LiveSession>,
): Promise<ReasoningChange> {
  // An explicit choice overrides the env precedence for THIS process — otherwise
  // ARES_REASONING_LEVEL would keep shadowing it on every /resume, /workspace, or
  // newly-spawned daemon card and the dial would appear to "snap back".
  const clearedEnvOverride = reasoningEnvOverrideActive();
  if (clearedEnvOverride) delete process.env.ARES_REASONING_LEVEL;
  let appliedTo = 0;
  for (const live of liveSessions) {
    live.session.setReasoningLevel(level);
    live.reasoningLevel = level;
    appliedTo++;
  }
  await updateUiSettings({ reasoningLevel: level });
  return { level, appliedTo, clearedEnvOverride };
}

/**
 * Best-known context window (tokens) for a model id. Used to size the
 * kept-history budget so a long session is not trimmed far below what the
 * model can actually hold — the "1M-context model still forgot my project"
 * bug. Conservative families fall back to a sane modern default.
 */
export function modelContextWindow(modelId: string): number {
  const id = (modelId ?? "").toLowerCase();
  if (/deepseek-v4|v4-pro|v4-flash/.test(id)) return 1_000_000;
  // V3.x is a 128k family — the old 1M (v3.2) / 160k (v3.1) figures were
  // over-estimates that let the kept-history budget grow past what the API
  // accepts, producing hard 400s deep into long sessions. `671b` is anchored
  // to deepseek ids so cogito-2.1:671b-cloud and friends don't match.
  if (/deepseek-v3\.1|deepseek-v3\.2|deepseek.*671b/.test(id)) return 128_000;
  // Opus 4.8+ ships the 1M window; earlier Claude models stay at 200k below.
  if (/opus-4-[89]|opus-5/.test(id)) return 1_000_000;
  if (/glm-5\.1/.test(id)) return 1_000_000;
  if (/glm-5|glm-4\.7|glm-4\.6/.test(id)) return 200_000;
  if (/qwen3-coder|qwen3\.5|qwen3-next|qwen3-vl/.test(id)) return 256_000;
  // Kimi K3 ships a 1M window; k3-256k is the clipped variant. Bare "k3"
  // (the subscription id) matches neither "kimi" nor "moonshot", so it must
  // be caught here or it falls to the 128k default and over-trims history.
  if (/(?:^|[^a-z0-9])k3(?:[^a-z0-9]|$)/.test(id)) return /256k/.test(id) ? 256_000 : 1_000_000;
  if (/kimi|moonshot/.test(id)) return 256_000;
  if (/gemini-3|gemini-2/.test(id)) return 1_000_000;
  if (/claude|sonnet|opus|haiku/.test(id)) return 200_000;
  if (/gpt-4\.1/.test(id)) return 1_000_000;
  if (/gpt-5/.test(id)) return 400_000;
  if (/o3|o4/.test(id)) return 200_000;
  if (/gpt-oss|gpt-4o|gpt-4-turbo|gpt-4/.test(id)) return 128_000;
  return 128_000; // sane default for a modern cloud model
}

/** A provider-level failure that retrying on the SAME provider can't fix — auth,
 *  missing model, or unreachable host. These (not tool bugs) are what made turns
 *  die mid-coding when the lane pointed at a flaky/unauthed model. */
export function isProviderFatalError(err: { code?: string; message?: string } | undefined): boolean {
  if (!err) return false;
  const blob = `${err.code ?? ""} ${err.message ?? ""}`.toLowerCase();
  // Context-limit / bad-request (400) errors are the PAYLOAD's fault, not the
  // provider's health — failing over ships the same oversized prompt to the next
  // provider and 400s identically (the cascade the user hit). Never fail over on
  // these; the engine's context-shrink retry handles them.
  if (/too long|too many tokens|maximum context|max context|context window|context_length|input length|exceeded max context|http_400|\b400\b/.test(blob)) return false;
  // 402 (out of balance) and no_auth/insufficient-balance are the TWO most common
  // unattended deaths — a balance runs dry or a key signs out mid-mission. They were
  // missing here, so failover never fired and a scheduled/autonomous run just died.
  // Sustained CAPACITY pressure earns a failover. By the time this is called
  // the engine has already ridden out its patient capacity ladder (~95s of
  // Overloadeds), so the provider really is not serving us — and a different
  // provider has entirely separate capacity. Without this, `overloaded_error`
  // matched nothing here (its message is just "Overloaded" — no http_5xx), the
  // self-healing loop never ran, and the turn died with zero model calls and
  // the user's message lost. Note isPermanentlyDeadError deliberately does NOT
  // match overload: congestion is temporary, so the provider is never retired.
  if (/overloaded|capacity|\b529\b|server is busy|service unavailable|temporarily unavailable/.test(blob)) return true;
  return /http_(401|402|403|404|5\d\d)|\b401\b|\b402\b|\b403\b|\b404\b|_throw|no_auth|unauthorized|forbidden|insufficient.?balance|out.?of.?balance|not ?found|fetch failed|unreachable|enotfound|econnrefused|etimedout/.test(
    blob,
  );
}

/**
 * Does this model see pixels? Best-known per-model-id vision capability, same
 * pattern style as modelContextWindow above. This exists because NOTHING else
 * threads vision metadata to the live turn — a user pasted a screenshot into a
 * pinned deepseek-v4-pro session and got "Can't view the image format
 * directly" while the app happily shipped the image to a blind model
 * (sess_e4c6022d). Conservative: unknown ids default to false so we never
 * skip escalation for a model that turns out blind.
 */
export function modelLikelyHasVision(modelId: string): boolean {
  const id = (modelId ?? "").toLowerCase();
  // Kimi went multimodal at K2.5: the coding-endpoint ids (kimi-for-coding,
  // k3, k3-256k) and K2.5+ all take image input per the live /models
  // metadata; only the original K2 line (k2, k2-0905, k2-thinking, k2:1t)
  // stays text-only via the blind list below.
  if (/kimi-for-coding|kimi-k2\.[5-9]|kimi-k[3-9]|(?:^|[^a-z0-9])k3(?:[^a-z0-9]|$)/.test(id)) return true;
  // Text-only families first — some ids would otherwise match broader patterns.
  if (/deepseek|gpt-oss|glm-|kimi-k|qwen3-coder|qwen3-next|minimax|gpt-3\.5|o1-mini|o3-mini/.test(id) && !/vl|vision/.test(id)) return false;
  if (/claude|sonnet|opus|haiku|fable|mythos/.test(id)) return true;
  if (/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|\bo3\b|\bo4\b|o3-pro|o4-mini/.test(id)) return true;
  if (/gemini|gemma3|gemma-3/.test(id)) return true;
  if (/qwen.{0,3}vl|llava|pixtral|minicpm-v|internvl|phi-4-multimodal|llama-3\.2.*vision|llama-4|grok-[34]/.test(id)) return true;
  if (/vision|multimodal/.test(id)) return true;
  return false;
}

/**
 * Pick a vision-capable selection for an image turn when the pinned model is
 * blind. Same candidate philosophy as pickHealthyFallback (never cascade off
 * the Ares Gateway onto local keys), but the requirement is "can actually see
 * the pasted image", and a family whose DEFAULT model is blind gets a known
 * vision model forced instead of being skipped.
 */
export async function pickVisionFallback(
  current: ProviderSelection,
  dead: ReadonlySet<string> = new Set(),
): Promise<ProviderSelection | null> {
  const settings = await loadUiSettings().catch(() => null);
  if (!settings) return null;
  const currentFamily = providerFamilyForSelection(current);
  // Gateway users route through the owner's metered keys — silently spending a
  // DIFFERENT key because they pasted an image defeats the product. Notice-only.
  if (currentFamily === "ares") return null;
  const candidates: Array<{ family: string; visionModel?: string; authed: boolean }> = [
    { family: "anthropic", authed: Boolean(settings.anthropicKey) || Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(process.env.ARES_ANTHROPIC_API_KEY) },
    // OpenRouter's default may be a text-only route; force a cheap vision model.
    { family: "openrouter", visionModel: "openai/gpt-4o-mini", authed: Boolean(settings.openRouterKey) },
  ];
  for (const c of candidates) {
    if (dead.has(c.family) || !c.authed) continue;
    try {
      const flags = new Map([["provider", c.family]]);
      let sel = await selectProvider(flags);
      if (!modelLikelyHasVision(sel.model)) {
        if (!c.visionModel) continue;
        sel = await selectProvider(new Map([["provider", c.family], ["model", c.visionModel]]));
      }
      return sel;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Terminal-path vision guard (no daemon routing available): when the turn
 * carries image blocks and the active model is blind, queue an honesty
 * reminder so the model says so instead of hallucinating the image.
 * The daemon path does full one-turn escalation; this is the floor.
 */
export function guardVisionForTurn(live: LiveSession, content: readonly ContentBlock[]): void {
  if (!content.some((block) => block.type === "image")) return;
  if (modelLikelyHasVision(live.selection.model)) return;
  live.queueSystemReminder(
    `The user attached an image, but the current model (${live.selection.model}) cannot see images. Say so plainly, suggest switching to a vision-capable model (Claude, GPT-4o, or Gemini), and work from the user's text only. Do NOT guess at the image's contents.`,
    "hook",
  );
}

/** Pick a healthy provider to fall back to when the current one is failing.
 *  Prefers Anthropic (most tool-reliable) when it's authenticated and isn't the
 *  one that just failed. Returns null when there's no better option. */
/**
 * A SIBLING model on the same provider, for capacity pressure only.
 *
 * Cross-provider failover is gated behind Auto routing because a pinned model
 * is a pin. But when the pinned model is merely *overloaded*, refusing to move
 * means losing the turn entirely — and staying inside the same provider and
 * account honours the pin far better than jumping to someone else's key. So on
 * capacity (and only capacity) we slide to the next model in that provider's
 * own catalog, which is what a person would do by hand.
 *
 * Returns null when the family has nothing else to offer.
 */
export async function pickCapacitySibling(
  current: ProviderSelection,
  exclude: ReadonlySet<string> = new Set(),
): Promise<ProviderSelection | null> {
  const family = providerFamilyForSelection(current);
  // The gateway routes server-side; picking its models for it is not our job.
  if (family === "ares") return null;
  const rows = await daemonModelCatalog(family).catch(() => []);
  const siblings = rows
    .map((row) => row.id)
    .filter((id) => id && id !== current.model && !exclude.has(id));
  if (siblings.length === 0) return null;
  for (const model of siblings) {
    try {
      return await selectProvider(new Map([["provider", family], ["model", model]]));
    } catch {
      // that id isn't selectable on this account — try the next
    }
  }
  return null;
}

export async function pickHealthyFallback(
  current: ProviderSelection,
  dead: ReadonlySet<string> = new Set(),
  options: { allowCrossProvider?: boolean } = {},
): Promise<ProviderSelection | null> {
  // Manual model selection is a pin, not a suggestion. Cross-provider failover
  // is only legal when the owner explicitly enables Auto routing.
  if (options.allowCrossProvider !== true) return null;
  const settings = await loadUiSettings().catch(() => null);
  if (!settings) return null;
  const currentFamily = providerFamilyForSelection(current);
  // The Ares Gateway IS the routing layer — it already picks the real provider
  // and key server-side. A gateway failure (out of credits, not entitled, no
  // house model) is a terminal, user-facing condition; cascading into the
  // owner's LOCAL keys would silently spend them and defeat the whole product.
  // Surface the gateway's own error instead of falling back.
  if (currentFamily === "ares") return null;
  // Order = most-likely-to-actually-work first. Anthropic (Claude sign-in or key)
  // before the pay-as-you-go balances that just ran dry. Ollama last (local/free
  // but often not running). openrouter's default model may itself be a deepseek
  // route, so if deepseek is dead, openrouter often is too — anthropic wins.
  const candidates: Array<{ family: string; authed: boolean }> = [
    { family: "anthropic", authed: Boolean(settings.anthropicKey) || Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(process.env.ARES_ANTHROPIC_API_KEY) },
    { family: "openrouter", authed: Boolean(settings.openRouterKey) },
    { family: "deepseek", authed: Boolean(settings.deepSeekKey) },
    { family: "ollama", authed: true },
  ];
  for (const c of candidates) {
    if (c.family === currentFamily || dead.has(c.family) || !c.authed) continue;
    try {
      return await selectProvider(new Map([["provider", c.family]]));
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * History budget keeps enough working context for coding without treating a
 * provider's marketing context limit as a target. Re-sending 600k+ tokens on
 * every tool round is expensive and usually less coherent than compacting.
 * Capped to keep cost/latency sane;
 * raise the cap with ARES_CONTEXT_BUDGET_CAP, or pin an exact budget with
 * ARES_CONTEXT_BUDGET. The old flat 24k/64k was the root cause of the
 * "forgot what it just built" amnesia on large-context models.
 */
export function chatContextBudget(selection: ProviderSelection): number {
  const env = Number(process.env.ARES_CONTEXT_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  const windowTokens = modelContextWindow(selection.model);
  // A large advertised window is an upper bound, not a spending target. The
  // old 800k default let a handful of tool rounds report millions of replayed
  // input tokens. Keep a generous working set and make giant-window sessions
  // an explicit opt-in through ARES_CONTEXT_BUDGET(_CAP).
  const cap = Number(process.env.ARES_CONTEXT_BUDGET_CAP) || 192_000;
  // Practical serving ceiling: ollama-cloud REJECTS or silently stalls on
  // prompts far below deepseek's marketing window — a session that grew to
  // ~335k input tokens got hard-rejected, then the retry stalled 90s×2+ (bug
  // 4a8ac088). Budget to what the serving layer actually handles so compaction
  // fires long before the provider chokes. ARES_CONTEXT_BUDGET overrides.
  const providerCap = /ollama/i.test(selection.provider?.name ?? "") ? 160_000 : Number.POSITIVE_INFINITY;
  return Math.max(32_000, Math.min(Math.floor(windowTokens * 0.75), cap, providerCap));
}

/**
 * Output-token ceiling per provider call. The old flat 8192 made large file
 * writes physically impossible — a Write whose JSON exceeds ~30KB truncates
 * mid tool_use and the call silently vanishes. Modern models stream far more;
 * scale the default to the model's window so big refactors/file generation
 * work, while small local models stay conservative. Override with
 * ARES_MAX_OUTPUT_TOKENS.
 */
export function chatMaxOutputTokens(selection?: ProviderSelection): number {
  const env = Number(process.env.ARES_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  if (!selection) return 8192;
  const window = modelContextWindow(selection.model);
  if (window >= 200_000) return 32_768; // Claude-class / large frontier models
  if (window >= 100_000) return 16_384;
  if (window >= 32_000) return 8_192;
  return 4_096; // small local models
}

const COMPACTION_INSTRUCTIONS =
  "You are compacting a long coding/agent session to free context. Write a dense, factual recap that lets the agent CONTINUE the work without the original transcript. This is a FACTUAL RECAP, not a continuation of the conversation — do not address the user, do not write a reply, just emit the structured recap. " +
  "Preserve specifics verbatim: file paths, function/symbol names, commands run and their outcomes, decisions and the reasons for them, values, and URLs. " +
  "Structure it as:\n" +
  "GOAL: what the user ultimately wants.\n" +
  "CONSTRAINTS: hard requirements, preferences, and explicit 'do NOT do X' rules stated earlier that must still hold. These are the first things lost across repeated compactions — carry them forward verbatim every time.\n" +
  "DONE: files created/edited (with paths) and what changed; key commands + results; decisions made.\n" +
  "STATE: what currently works and is verified vs. what is broken, in-progress, or unverified.\n" +
  "OPEN: unfinished threads and the concrete next steps.\n" +
  "FACTS: durable specifics to remember (paths, signatures, ids, config values).\n" +
  "Be concrete and terse — no preamble, no fluff. This recap REPLACES the transcript, so omitting a fact loses it.";

/** Flatten a span of messages into a plain-text transcript for the summarizer. */
function renderSpanForSummary(messages: readonly Message[]): string {
  const lines: string[] = [];
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…[${s.length - n} more chars]` : s);
  for (const m of messages) {
    for (const b of m.content as ContentBlock[]) {
      switch (b.type) {
        case "text":
          if (b.text.trim()) lines.push(`${m.role.toUpperCase()}: ${clip(b.text.trim(), 4000)}`);
          break;
        case "system_reminder":
          // A prior compaction recap is the canonical anchor for everything
          // before it. Clipping that recap during the next compaction causes
          // generational amnesia: constraints and settled decisions disappear
          // a little more on every epoch. Carry the complete anchor forward.
          lines.push(
            `[reminder] ${b.text.startsWith("Compacted memory —") ? b.text.trim() : clip(b.text.trim(), 1500)}`,
          );
          break;
        case "tool_use": {
          const input = clip(JSON.stringify(b.input ?? {}), 1500);
          lines.push(`  → ${b.name}(${input})`);
          break;
        }
        case "tool_result": {
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          lines.push(`  result: ${clip(text, 1500)}`);
          break;
        }
        case "image":
          lines.push(`  [image]`);
          break;
        // thinking blocks are intentionally omitted — not durable state
      }
    }
  }
  return lines.join("\n");
}

/**
 * Smart-compaction summarizer wired to the cheap sub-model (or the main model
 * via sideQuery when no sub-model pool exists). Returns "" on any failure so
 * the engine cleanly falls back to its deterministic ledger.
 */
export function makeSpanSummarizer(
  selection: ProviderSelection,
  onUsage?: (usage: import("@ares/protocol").Usage) => void | Promise<void>,
): (messages: readonly Message[], signal?: AbortSignal) => Promise<string> {
  return async (messages, signal) => {
    const transcript = renderSpanForSummary(messages);
    if (!transcript.trim()) return "";
    const configuredTimeout = Number(process.env.ARES_COMPACTION_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.max(1_000, Math.floor(configuredTimeout))
      : 30_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const summarizerSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    try {
      if (selection.subModel?.summarize) {
        return await selection.subModel.summarize({
          input: transcript,
          instructions: COMPACTION_INSTRUCTIONS,
          signal: summarizerSignal,
        });
      }
      return await sideQuery({
        provider: selection.provider,
        model: selection.model,
        system: COMPACTION_INSTRUCTIONS,
        user: transcript,
        maxOutputTokens: 2048,
        reasoningLevel: "off",
        onUsage,
        // Honor a stop during compaction — the engine threads the live turn
        // signal in, so aborting the turn no longer runs the summarizer to
        // completion against a dead turn.
        signal: summarizerSignal,
      });
    } catch {
      return "";
    }
  };
}

/**
 * Drop read stamps for files whose contents were trimmed out of the model's
 * visible history. Without this, the Read re-read guard refuses recovery reads
 * ("already in context") for content the model can no longer actually see, and
 * it edits blind — the amnesia spiral. Over-invalidation is harmless: worst
 * case is one extra Read of an unchanged file.
 */
export function invalidateTrimmedReadStamps(
  fileReadStamps: Map<string, FileReadStamp>,
  workspace: string,
  dropped: readonly Message[],
): void {
  const paths = collectTrimmedFilePaths(dropped);
  if (paths.length === 0) return;
  const targets = new Set(
    paths.map((p) => (path.isAbsolute(p) ? p : path.resolve(workspace, p)).toLowerCase()),
  );
  for (const key of [...fileReadStamps.keys()]) {
    if (targets.has(key.toLowerCase())) fileReadStamps.delete(key);
  }
}

export async function createSessionWithSelection(
  _args: ParsedArgs,
  selection: ProviderSelection,
  resumeSessionId?: string,
  requestPermission: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision> = promptPermission,
  opts: { startAgentRuntime?: boolean; sessionId?: string; detachedStartupRecovery?: boolean } = {},
): Promise<LiveSession> {
  const startAgentRuntime = opts.startAgentRuntime !== false;
  const context = cliRuntimeContext();
  const pathPermissions = await AresPathPermissionStore.load(context);
  const commandPermissions = await AresCommandPermissionStore.load(context);
  const settings = await loadUiSettings();
  applyEngineConfigEnv(settings.engine ?? {});
  // Guarded by default. Bypass mode requires an explicit owner opt-in.
  const guarded = settings.dangerousBypass !== true;
  const runtime: AresRuntimeState = {
    permissionMode: guarded ? "workspace-write" : "bypass",
    permissions: settings.permissions,
  };
  const sessionKernel = await openWorkspaceSessionKernel(context.workspace);
  if (resumeSessionId) {
    // Resume the mode the owner last chose. Deliberately NOT inferred from an
    // un-approved plan revision: a leftover draft used to force plan mode on
    // every resume, overriding an explicit switch to build.
    const durableSession = sessionKernel.getSession(resumeSessionId);
    if (durableSession?.workflowMode === "plan") {
      runtime.permissionMode = "plan";
    }
  }
  const shellRegistry = new ShellRegistry();
  const todoStore = new TodoStore();
  let codingJournal: CodingJournal | undefined;
  const verifier = new ContinuousVerifier({
    workspace: context.workspace,
    onEvent: (event) => {
      codingJournal?.recordVerifyEvent(event);
    },
  });
  const hooks = await HookManager.load(context.workspace);
  await hooks.run({ event: "SessionStart", workspace: context.workspace });
  const startupReminders = await loadStartupReminders(context.workspace);
  const isMockProvider = selection.provider.name === "mock" || selection.provider.name.startsWith("mock-");
  const agentEnabled =
    process.env.ARES_AGENT_ENABLED === "1" ||
    (!isMockProvider && process.env.ARES_AGENT_ENABLED !== "0");
  const agent = await prepareAresAgent({
    workspace: context.workspace,
    enabled: agentEnabled,
  });
  startupReminders.push(...agent.startupReminders);
  const manualReminders: Array<{ text: string; source: ManualReminderSource }> = [];
  const queueSystemReminder = (text: string, source: ManualReminderSource = "hook") => {
    manualReminders.push({ text, source });
  };
  const drainSystemReminders = () => [
    ...startupReminders.splice(0),
    ...manualReminders.splice(0),
    ...verifier.drainReminders(),
    ...hooks.drainReminders(),
  ];
  const fileReadStamps = new Map<string, FileReadStamp>();
  const tools = await buildEngineTools(
    pathPermissions,
    commandPermissions,
    selection,
    runtime,
    context,
    shellRegistry,
    todoStore,
    fileReadStamps,
    sessionKernel,
  );
  const environmentArtifactSignals = makeEnvironmentArtifactSignals(context.home, context.workspace);
  const onHistoryTrimmed = (dropped: readonly Message[]) =>
    invalidateTrimmedReadStamps(fileReadStamps, context.workspace, dropped);
  await seedAllCapabilities(context.home)
    .then(() => listCapabilities(context.home))
    .then((caps) => writeCapabilitiesDoc(context.home, caps))
    .catch(() => undefined);
  // Held so a persona swap can recompose the SAME prompt with one section
  // changed, instead of half-rebuilding it and silently dropping the mind or
  // git context.
  const promptTail = (await loadLiveMindContext(context)) + (await loadGitContext(context));
  // The per-model coding overlay is resolved from the LIVE selection, and read
  // at compose time rather than captured — a mid-session model switch (owner
  // pick or failover mutates `live.selection`) recomposes with the right
  // overlay on the next turn.
  //
  // Late-bound through a ref on purpose: `live` is constructed further down, so
  // naming it directly here put the closure in its temporal dead zone and every
  // daemon/session path threw "Cannot access 'live' before initialization" the
  // moment it composed a prompt.
  let liveRef: LiveSession | undefined;
  const promptModelOpts = () => {
    const active = liveRef?.selection ?? selection;
    return {
      providerFamily: providerFamilyForSelection(active),
      model: active.model,
      persona: { style: settings.personaStyle, custom: settings.personaCustom },
    };
  };
  const composeCurrentSystemPrompt = () =>
    agent.composeSystemPrompt(buildSystemPrompt(runtime.permissionMode, context, promptModelOpts())) + promptTail;
  runtime.composeChildSystemPrompt = async () =>
    agent.composeSystemPrompt(buildSystemPrompt(runtime.permissionMode, context, promptModelOpts())) +
    (await loadLiveMindContext(context)) +
    (await loadGitContext(context));
  const toolCatalogHash = contextSourceHash(JSON.stringify(tools.map((tool) => tool.schema)));
  const contextSourceVersions = () => ({
    compiler: "ares-interactive-context-v1",
    systemPromptSha256: contextSourceHash(composeCurrentSystemPrompt()),
    personaSha256: contextSourceHash(JSON.stringify(agent.activePersona() ?? null)),
    toolCatalogSha256: toolCatalogHash,
    livingMemoryAndGitSha256: contextSourceHash(promptTail),
    codingJournalSha256: contextSourceHash(JSON.stringify(codingJournal?.snapshot() ?? null)),
  });
  const systemPrompt = composeCurrentSystemPrompt();
  // agent.setPersona mutates the slot composeSystemPrompt reads, so this is the
  // whole implementation: set, recompose, swap. Every channel that goes through
  // composeSystemPrompt gets the persona for free.
  const makePersonaSwap = (session: Session) => (persona: PersonaDef | null) => {
    agent.setPersona(persona);
    session.setSystemPrompt(composeCurrentSystemPrompt());
  };
  let sessionRef: Session | undefined;
  const summarizeSpan = makeSpanSummarizer(selection, (usage) =>
    sessionRef?.recordAuxiliaryUsage("compaction", selection.provider.name, selection.model, usage),
  );
  if (resumeSessionId) {
    const snapshot = await loadSessionSnapshot(context.workspace, resumeSessionId, {
      maxMessages: resumeMessageLimit(),
    });
    todoStore.replace(snapshot.todos);
    const session = new Session({
      workspace: context.workspace,
      provider: selection.provider,
      model: selection.model,
      systemPrompt,
      tools,
      requestPermission,
      drainSystemReminders,
      confirmTurnEnd: () => confirmTurnEndWith(verifier),
      recallFailureFix: (input) => recallFailureFixFromMemory(context.mind.memoryFile, input),
      hookManager: hooks,
      sessionMeta: snapshot.meta,
      initialMessages: snapshot.messages,
      initialTodos: snapshot.todos,
      initialSeq: snapshot.nextSeq,
      requireVerificationEvidence: process.env.ARES_CODING_PROOF_GATE !== "0",
      verificationEvidence: () => verifier.evidenceSnapshot(),
      outstandingVerificationRequired: () => codingJournal?.verificationRequiredForCurrentTurn() ?? false,
      persistedVerificationDebt: () => codingJournal?.persistedVerificationDebtForCurrentTurn() ?? false,
      persistedVerificationScopeComplete: () => codingJournal?.persistedVerificationScopeCompleteForCurrentTurn() ?? true,
      observedMutationAt: () => codingJournal?.latestObservedMutationAtForCurrentTurn() ?? 0,
      specDocs: () => codingJournal?.specDocsForCurrentTurn() ?? [],
      selfTerritoryRoots: context.selfTerritoryRoots,
      reasoningLevel: resolveReasoningLevel(settings),
      maxOutputTokens: chatMaxOutputTokens(selection),
      contextBudgetTokens: chatContextBudget(selection),
      maxTurns: settings.engine?.maxTurns,
      fileReadStamps,
      onHistoryTrimmed,
      environmentArtifactSignals,
      summarizeSpan,
      contextSourceVersions,
      sessionKernel,
      detachedStartupRecovery: opts.detachedStartupRecovery,
    });
    sessionRef = session;
    shellRegistry.configureDurability({ kernel: sessionKernel, workspace: context.workspace });
    shellRegistry.registerSession(session.meta.id);
    runtime.onPermissionModeChanged = async (mode, opts) => {
      if (mode !== "plan") await session.approvePendingPlan();
      session.setWorkflowMode(mode === "plan" ? "plan" : "build", { ownerIntent: opts?.ownerIntent });
      session.setSystemPrompt(composeCurrentSystemPrompt());
    };
    runtime.onPlanStarted = (reason) => session.beginPlanDraft(reason);
    runtime.onPlanDraftUpdated = (plan) => session.recordPlanDraft(plan);
    runtime.currentPlan = () => session.activePlanBody();
    runtime.onPlanProposed = (plan) => session.recordPlanProposal(plan);
    runtime.onPlanApproved = (plan) => session.approvePlan(plan);
    codingJournal = await CodingJournal.open({ workspace: context.workspace, sessionId: session.meta.id });
    session.observeEvents((event) => codingJournal?.recordTurnEvent(event));
    const live: LiveSession = {
      session,
      selection,
      context,
      resumed: {
        id: snapshot.meta.id,
        eventCount: snapshot.eventCount,
        preview: snapshot.preview,
        replayedMessageCount: snapshot.replayedMessageCount,
        omittedMessageCount: snapshot.omittedMessageCount,
        compacted: snapshot.compacted,
      },
      runtime,
      verifier,
      hooks,
      shellRegistry,
      todoStore,
      tools,
      queueSystemReminder,
      reasoningLevel: resolveReasoningLevel(settings),
      codingJournal,
      adoptPersona: makePersonaSwap(session),
      activePersona: () => agent.activePersona(),
    };
    liveRef = live;
    live.agentRuntime = new AresAgentRuntime(agent, {
      workspace: context.workspace,
      sessionId: session.meta.id,
      queueReminder: (text, source) => queueSystemReminder(text, source),
    });
    if (startAgentRuntime) live.agentRuntime.start();
    // Re-wear the durably-recorded persona. Adoption used to live only in
    // process memory, so every restart silently took the persona off while the
    // roster still read as functional — the owner's explicit choice must
    // survive the daemon, like every other piece of session state.
    const durableSessionMeta = sessionKernel.getSession(session.meta.id)?.metadata;
    const wornPersonaName =
      durableSessionMeta && typeof durableSessionMeta === "object" && !Array.isArray(durableSessionMeta)
        ? (durableSessionMeta as Record<string, unknown>).activePersona
        : undefined;
    if (typeof wornPersonaName === "string" && wornPersonaName) {
      const worn = await readPersona(wornPersonaName, context.home).catch(() => null);
      if (worn) live.adoptPersona(worn);
    }
    return live;
  }
  const session = new Session({
    workspace: context.workspace,
    provider: selection.provider,
    model: selection.model,
    systemPrompt,
    tools,
    sessionId: opts.sessionId,
    requestPermission,
    drainSystemReminders,
    confirmTurnEnd: () => confirmTurnEndWith(verifier),
    requireVerificationEvidence: process.env.ARES_CODING_PROOF_GATE !== "0",
    verificationEvidence: () => verifier.evidenceSnapshot(),
    outstandingVerificationRequired: () => codingJournal?.verificationRequiredForCurrentTurn() ?? false,
    persistedVerificationDebt: () => codingJournal?.persistedVerificationDebtForCurrentTurn() ?? false,
    persistedVerificationScopeComplete: () => codingJournal?.persistedVerificationScopeCompleteForCurrentTurn() ?? true,
    observedMutationAt: () => codingJournal?.latestObservedMutationAtForCurrentTurn() ?? 0,
    specDocs: () => codingJournal?.specDocsForCurrentTurn() ?? [],
    recallFailureFix: (input) => recallFailureFixFromMemory(context.mind.memoryFile, input),
    hookManager: hooks,
    selfTerritoryRoots: context.selfTerritoryRoots,
    reasoningLevel: resolveReasoningLevel(settings),
    maxOutputTokens: chatMaxOutputTokens(selection),
    contextBudgetTokens: chatContextBudget(selection),
    maxTurns: settings.engine?.maxTurns,
    fileReadStamps,
    onHistoryTrimmed,
    environmentArtifactSignals,
    summarizeSpan,
    contextSourceVersions,
    sessionKernel,
    detachedStartupRecovery: opts.detachedStartupRecovery,
  });
  sessionRef = session;
  shellRegistry.configureDurability({ kernel: sessionKernel, workspace: context.workspace });
  shellRegistry.registerSession(session.meta.id);
  runtime.onPermissionModeChanged = async (mode, opts) => {
    if (mode !== "plan") await session.approvePendingPlan();
    session.setWorkflowMode(mode === "plan" ? "plan" : "build", { ownerIntent: opts?.ownerIntent });
    session.setSystemPrompt(composeCurrentSystemPrompt());
  };
  runtime.onPlanStarted = (reason) => session.beginPlanDraft(reason);
  runtime.onPlanDraftUpdated = (plan) => session.recordPlanDraft(plan);
  runtime.currentPlan = () => session.activePlanBody();
  runtime.onPlanProposed = (plan) => session.recordPlanProposal(plan);
  runtime.onPlanApproved = (plan) => session.approvePlan(plan);
  codingJournal = await CodingJournal.open({ workspace: context.workspace, sessionId: session.meta.id });
  session.observeEvents((event) => codingJournal?.recordTurnEvent(event));
  const live: LiveSession = { session, selection, context, runtime, verifier, hooks, shellRegistry, todoStore, tools, queueSystemReminder, reasoningLevel: resolveReasoningLevel(settings), codingJournal, adoptPersona: makePersonaSwap(session), activePersona: () => agent.activePersona() };
  liveRef = live;
  live.agentRuntime = new AresAgentRuntime(agent, {
    workspace: context.workspace,
    sessionId: session.meta.id,
    queueReminder: (text, source) => queueSystemReminder(text, source),
  });
  if (startAgentRuntime) live.agentRuntime.start();
  return live;
}
