// Session view model: Item/ToolStep/SessionVm types, the shared keySeq/nextKey
// counter, and the session builders (extracted from App.tsx).

import { compact, stringify, splitDataImages } from "../lib/format";

// ─── View model ────────────────────────────────────────────────────────────

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
// Preview iframes ran with only `allow-scripts`, so previewed apps lived in an
// opaque origin where localStorage/IndexedDB/cookies, alert/confirm/prompt,
// forms, popups and same-origin fetch all threw or no-op'd — the app "broke"
// vs. running standalone. Grant the fuller set (same posture as the embedded
// browser) so a previewed app behaves the way it does on its own. This is the
// user's OWN generated code in their OWN desktop app, so same-origin is fine.
export const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";

export const REASONING_LEVELS: ReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const EFFORT_META: Record<ReasoningLevel, { label: string; hint: string }> = {
  off: { label: "Off", hint: "no deliberate reasoning; fastest response" },
  minimal: { label: "Minimal", hint: "a featherweight reasoning pass" },
  low: { label: "Low", hint: "fast, economical, and direct" },
  medium: { label: "Medium", hint: "balanced depth for everyday work" },
  high: { label: "High", hint: "deep reasoning for difficult work" },
  xhigh: { label: "X-High", hint: "long-horizon agentic reasoning" },
  max: { label: "Max", hint: "the provider's absolute capability ceiling" },
};

/**
 * Effort ladders DISCOVERED from the daemon's model catalog, keyed
 * "provider/model". The daemon derives these from each model's real capability
 * (OpenRouter's supported-parameters, Kimi's supportsReasoning, the per-family
 * table in providers.ts) — see effortLadderFor there. This registry is the
 * bridge: the effort panel renders exactly what was discovered, so a newly
 * released model brings its own correct ladder with it and nothing here needs
 * hand-editing.
 */
const discoveredLadders = new Map<string, ReasoningLevel[]>();

/** Record ladders from a model_catalog frame. Unknown rungs are dropped so a
 *  future provider string can never inject a level the app can't render. */
export function recordEffortLadders(
  provider: string,
  models: Array<{ id?: string; effortLevels?: string[] }>,
): void {
  for (const model of models) {
    if (!model?.id || !Array.isArray(model.effortLevels)) continue;
    const ladder = model.effortLevels.filter((level): level is ReasoningLevel =>
      (REASONING_LEVELS as string[]).includes(level),
    );
    discoveredLadders.set(`${provider.toLowerCase()}/${model.id.toLowerCase()}`, ladder);
  }
}

/** The discovered ladder for a model, or undefined if we've never seen it. */
export function discoveredEffortLadder(provider: string, model: string): ReasoningLevel[] | undefined {
  return discoveredLadders.get(`${provider.toLowerCase()}/${model.toLowerCase()}`);
}

export function effortLevelsFor(provider: string, model: string): ReasoningLevel[] {
  // Native truth first: whatever the daemon discovered for THIS model.
  const discovered = discoveredEffortLadder(provider, model);
  if (discovered) return discovered;

  // Fallback heuristic — only for models we have not discovered yet (offline,
  // signed out, or a provider that publishes nothing). Kept deliberately small.
  const p = provider.toLowerCase();
  const m = model.toLowerCase();
  if (p === "kimi" || /^k\d(?:-|$)|kimi/.test(m)) return ["high", "max"];
  if (/deepseek-v4|deepseek-v3\.2/.test(m) || p === "deepseek") return ["off", "high", "max"];
  if (/claude|fable|mythos|opus|sonnet/.test(m) || p === "anthropic") {
    if (/(?:fable|mythos)-?5|opus-4-[78]|sonnet-5/.test(m)) return ["low", "medium", "high", "xhigh", "max"];
    if (/opus-4-6|sonnet-4-6/.test(m)) return ["low", "medium", "high", "max"];
    return ["off", "low", "medium", "high", "max"];
  }
  if (/gpt-|o[134](?:-|$)/.test(m) || p === "openai") return ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (p === "ollama") return ["off", "low", "medium", "high"];
  return ["off", "low", "medium", "high", "xhigh", "max"];
}

/**
 * The effort this model will ACTUALLY run at.
 *
 * A saved preference outlives the model it was chosen for: pin Opus at
 * "medium", switch to Kimi K3 (which offers only high/max), and the status bar
 * kept claiming "medium" — a level the provider silently ignores. Clamp to the
 * nearest rung the model really honours so what's displayed is what happens.
 * Returns the saved level untouched when the model has no dial at all.
 */
export function effectiveEffort(provider: string, model: string, level: ReasoningLevel): ReasoningLevel {
  const ladder = effortLevelsFor(provider, model);
  if (ladder.length === 0 || ladder.includes(level)) return level;
  const want = REASONING_LEVELS.indexOf(level);
  let best = ladder[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const rung of ladder) {
    const gap = Math.abs(REASONING_LEVELS.indexOf(rung) - want);
    if (gap < bestGap) {
      bestGap = gap;
      best = rung;
    }
  }
  return best;
}

export function effortWireLabel(provider: string, model: string, level: ReasoningLevel): string {
  const m = model.toLowerCase();
  if (/deepseek-v4|deepseek-v3\.2/.test(m) || provider.toLowerCase() === "deepseek") return level === "off" ? "thinking.disabled" : `reasoning_effort: ${level === "max" || level === "xhigh" ? "max" : "high"}`;
  if (/claude|fable|mythos|opus|sonnet/.test(m) || provider.toLowerCase() === "anthropic") return `output_config.effort: ${level}`;
  if (/gpt-|o[134](?:-|$)/.test(m) || provider.toLowerCase() === "openai") return `reasoning.effort: ${level === "off" ? "none" : level === "max" ? "xhigh" : level}`;
  return `native effort: ${level}`;
}
export interface ToolStep {
  id: string;
  label: string;
  name: string;
  /** "drafting" = the model is still authoring this call's input (streaming). */
  status: "drafting" | "running" | "ok" | "error";
  durationMs?: number;
  detail?: string;
  /** Raw tool input — shown in "technical" tool-display mode. */
  inputJson?: string;
  /** Streaming-authorship progress (chars of input JSON received so far). */
  draftChars?: number;
  /** First ~2KB of the streaming input — used to surface file_path early. */
  draftHead?: string;
  /** Live sub-tool output tail (last ~200 lines of shell stdout/stderr). */
  liveTail?: string;
}

export type Item =
  | { kind: "user"; key: string; text: string; images?: string[] }
  | { kind: "steer"; key: string; text: string; landed?: boolean }
  | { kind: "assistant"; key: string; text: string; thinking: string; streaming: boolean; model?: string; lane?: string; provider?: string; proactive?: boolean }
  | { kind: "tools"; key: string; steps: ToolStep[]; startedAt: number; finishedAt?: number }
  | {
      kind: "usage";
      key: string;
      input: number;
      output: number;
      cacheRead: number;
      modelCalls: number;
      durationMs: number;
      status: string;
      model?: string;
      lane?: string;
      provider?: string;
    }
  | { kind: "permission"; key: string; id: string; toolName: string; reason: string; decided?: string }
  | { kind: "notice"; key: string; text: string; tone: "dim" | "warn" | "bad" }
  | { kind: "authPrompt"; key: string; provider: string; text: string }
  | { kind: "artifact"; key: string; path: string; label: string }
  | { kind: "diff"; key: string; files: string[]; diff: string; truncated: boolean }
  | { kind: "subagent"; key: string; id: string; name: string; description: string; status: "running" | "completed" | "failed" | "cancelled"; summary?: string };

export interface SessionVm {
  id: string;
  title: string;
  items: Item[];
  busy: boolean;
  tokensIn: number;
  /** Portion of tokensIn served from the provider prompt cache. */
  cacheReadTokens: number;
  tokensOut: number;
  /** Live one-liner of what the agent is doing right now (the activity ticker). */
  activity?: string;
  /** The agent's live plan — mirrors its TodoWrite state. */
  todos: Array<{ id: string; content: string; activeForm: string; status: string }>;
  /** Steer messages queued mid-turn, awaiting a safe injection boundary. */
  steerQueued?: number;
  /** Model + lane the daemon resolved for the current turn (routing transparency). */
  turnModel?: string;
  turnLane?: string;
  turnProvider?: string;
  /** False for a disk summary whose transcript has not been requested yet. */
  loaded?: boolean;
  loading?: boolean;
  updatedAt?: string;
  /** Live Conductor fleet — populated from fleet_activity progress events. */
  fleet?: FleetVm;
  /** Live delegation cut-scene — populated from coding_backend progress events
   *  while Ares drives an external coder (Claude Code / Codex) on the account. */
  codingBackend?: CodingBackendVm;
}

export interface CodingBackendVm {
  /** "claude" | "codex" — which little character Ares is working with. */
  backend: string;
  label: string;
  /** The act of the cut-scene. */
  phase: "detect" | "install" | "running" | "done" | "failed";
  /** Bounded recent activity lines from the backend (stdout/stream-json). */
  lines: string[];
  /** Files the backend has touched so far (parsed live from stream-json). */
  filesTouched: number;
  /** When it started (for the elapsed readout). Set from the render clock. */
  startedTick: number;
}

export interface FleetAgentVm {
  role: string;
  phase: string;
  status: "running" | "done" | "failed";
  tool?: string;
  activity?: string;
  resumed?: boolean;
}
export interface FleetVm {
  active: boolean;
  /** The runFleet id — lets the UI offer a resume of an aborted run. */
  fleetId?: string;
  /** Set on turn-end when the fleet left failed/incomplete leaves behind. */
  canResume?: boolean;
  /** Insertion-ordered agents keyed by agentId. */
  agents: Array<{ id: string } & FleetAgentVm>;
}

export let keySeq = 0;
export const nextKey = () => `i${++keySeq}`;

/** OS notification via the WebView's native Notification API — no Tauri plugin
 *  needed. Makes background missions, permission gates, and daemon death visible
 *  when you're working in another app. */
export function fireNotification(title: string, body: string): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification(title, { body: body.slice(0, 240) });
  } catch {
    /* notifications are best-effort */
  }
}

export function freshSession(): SessionVm {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${++keySeq}`;
  return {
    id: `sess_${random}`,
    title: "New session",
    items: [],
    busy: false,
    tokensIn: 0,
    cacheReadTokens: 0,
    tokensOut: 0,
    todos: [],
    loaded: true,
  };
}

export interface SessionSummaryWire {
  id: string;
  provider?: { name?: string; model?: string };
  updatedAt?: string;
  preview?: string;
  label?: string;
}

export interface MessageWire {
  id?: string;
  role?: string;
  content?: Array<Record<string, unknown>>;
}

export function sessionFromSummary(summary: SessionSummaryWire): SessionVm {
  return {
    id: summary.id,
    title: compact(summary.label || summary.preview || "Saved session", 42),
    items: [],
    busy: false,
    tokensIn: 0,
    cacheReadTokens: 0,
    tokensOut: 0,
    todos: [],
    loaded: false,
    updatedAt: summary.updatedAt,
    turnModel: summary.provider?.model,
    turnProvider: summary.provider?.name,
  };
}

export function sessionFromHistory(id: string, rawMessages: unknown, meta: unknown): SessionVm {
  const messages = Array.isArray(rawMessages) ? (rawMessages as MessageWire[]) : [];
  const items: Item[] = [];
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
      const thinking = blocks.filter((b) => b.type === "thinking").map((b) => String(b.text ?? "")).join("");
      if (text || thinking) {
        items.push({ kind: "assistant", key: nextKey(), text, thinking, streaming: false });
      }
      const tools = blocks
        .filter((b) => b.type === "tool_use")
        .map((b, index): ToolStep => ({
          id: String(b.id ?? `replay-tool-${index}`),
          label: String(b.name ?? "Tool"),
          name: String(b.name ?? "Tool"),
          status: "ok",
          inputJson: stringify(b.input ?? {}),
        }));
      if (tools.length > 0) items.push({ kind: "tools", key: nextKey(), steps: tools, startedAt: 0, finishedAt: 0 });
      continue;
    }
    if (message.role === "user") {
      const rawText = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
      // Real image content blocks from the saved turn, plus any data URLs that
      // were embedded in the text — both become visible thumbnails, not blobs.
      const blockImages = blocks
        .filter((b) => b.type === "image")
        .map((b) => {
          const src = b as { source?: { data?: string; media_type?: string; type?: string; url?: string } };
          if (src.source?.url) return src.source.url;
          if (src.source?.data) return `data:${src.source.media_type ?? "image/png"};base64,${src.source.data}`;
          return "";
        })
        .filter(Boolean);
      const { text, images: inlineImages } = splitDataImages(rawText);
      const images = [...blockImages, ...inlineImages];
      if (text || images.length) items.push({ kind: "user", key: nextKey(), text, images: images.length ? images : undefined });
      // system_reminder blocks on saved user turns are internal context assembly
      // (memory/instructions/recall) — never user-facing. Don't replay them.
    }
  }
  const firstUser = items.find((item): item is Extract<Item, { kind: "user" }> => item.kind === "user");
  const provider = (meta && typeof meta === "object" ? (meta as { provider?: { name?: string; model?: string } }).provider : undefined);
  return {
    id,
    title: compact(firstUser?.text || "Saved session", 42),
    items,
    busy: false,
    tokensIn: 0,
    cacheReadTokens: 0,
    tokensOut: 0,
    todos: [],
    loaded: true,
    loading: false,
    turnModel: provider?.model,
    turnProvider: provider?.name,
  };
}

export const PREVIEWABLE = /\.(html?|svg)$/i;
export const HOLO_SPEC_FILE = /\.holo\.json$/i;
