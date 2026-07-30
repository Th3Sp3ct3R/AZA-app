// Prefs: persisted desktop preferences, themes, engine knobs, and the owner
// permission posture (extracted from App.tsx).

import { REASONING_LEVELS, type ReasoningLevel } from "./session";

// ─── Persistence ───────────────────────────────────────────────────────────

export type RouteLane = "chat" | "coding" | "research" | "tool-use";
export const ROUTE_LANES: RouteLane[] = ["chat", "coding", "research", "tool-use"];

export type Routing = Partial<Record<RouteLane, { provider: string; model: string }>>;

export interface Prefs {
  provider: string;
  model: string;
  reasoning: ReasoningLevel;
  /** ULTRA posture — the top of the effort slider. Pins reasoning to max and
   *  (once wired) routes the turn through the background orchestrator fleet. */
  ultra?: boolean;
  routing: Routing;
  routingMode: "manual" | "auto";
  /** Tool-call rendering: product = concise summaries; technical = raw input/output. */
  toolDisplay: "product" | "technical";
  /** Working-state EFFECTS. Photosensitive-safe by design: nothing flashes,
   *  nothing strobes. "glow" = a STATIC ember rim + slow ember drift while
   *  working; "minimal" = only the small header indicator; "off" = nothing.
   *  (Key name kept as flameMode for stored-prefs compatibility; old values
   *  immersive/combat→glow and clean→minimal migrate on load.) */
  flameMode: "glow" | "minimal" | "off";
  /** Agent-tunable effect accent — Ares sets this via its SetUiEffect tool
   *  when the owner asks for a different working animation ("make it blue",
   *  "calmer"). hue rotates the ember palette of the glow + header ring;
   *  speed paces the ring; label is a short caption shown while working. */
  uiEffect?: { hue?: number; speed?: "calm" | "steady" | "brisk"; label?: string };
  /** Pinned session ids (shown in their own rail section). */
  pinned: string[];
  /** Accent theme for the desktop chrome. */
  theme: ThemeName;
  /** Interface style — "modern" = the glass-forge reskin (floating smoked-glass
   *  surfaces over a cinematic obsidian canvas, copper accent, mint success;
   *  scoped under data-style="modern" in modern.css); "new" = the Forged skin
   *  (glass depth, spring motion, living gauges); "legacy" = the classic flat
   *  shell, pixel-identical to the pre-skin app. */
  uiStyle: "legacy" | "new" | "modern";
  /** Marks a post-glass-revamp save. Absent = pre-revamp prefs: a stored
   *  "new" was the old DEFAULT (not a choice), so it migrates to "modern"
   *  once; explicit re-picks of Forged after that stick. */
  uiStyleV2?: boolean;
  /** Advanced engine knobs (mirrors the daemon's EngineConfig). */
  engine: EngineConfig;
  /** Voice: speak Ares's replies aloud via the local sidecar (Kokoro TTS). */
  voiceEnabled?: boolean;
  /** Chosen TTS voice id (from the sidecar /voices catalog, or a skill provider). */
  voiceId?: string;
  /** Speech rate multiplier (0.5–2.0). */
  voiceSpeed?: number;
  /** Hands-free: "Hey Ares" wake word arms the mic (needs voice + sidecar). */
  wakeWord?: boolean;
  /** Speak a short heads-up when a background/other-session turn finishes. */
  voiceNotify?: boolean;
  /** Starred models in the discovery panel, as "provider/model" keys. */
  favoriteModels?: string[];
  /** Last-used models (newest first, max 6), as "provider/model" keys. */
  recentModels?: string[];
}

export type ThemeName = "rage" | "bronze" | "crimson" | "steel" | "nightfall" | "verdant" | "daylight";
export const THEMES: Array<{ id: ThemeName; label: string; hint: string; swatch: string }> = [
  { id: "rage", label: "Blood & Rage", hint: "obsidian scorched with ember — the god of war", swatch: "#d6402e" },
  { id: "bronze", label: "Bronze", hint: "the old warband gold", swatch: "#c79a4e" },
  { id: "crimson", label: "Crimson Banner", hint: "blood-red command", swatch: "#c0504a" },
  { id: "steel", label: "Steel Legion", hint: "cool tempered teal", swatch: "#7fa6a3" },
  { id: "nightfall", label: "Nightfall", hint: "violet dusk", swatch: "#8b8bd9" },
  { id: "verdant", label: "Verdant", hint: "emerald phalanx", swatch: "#74c39c" },
  { id: "daylight", label: "Daylight", hint: "the forge at high noon — light mode", swatch: "#f0e9e2" },
];

export interface EngineConfig {
  maxTurns?: number;
  gatherStallRounds?: number;
  toolResultChars?: number;
  operatorAutotick?: boolean;
  operatorTickMinutes?: number;
  subagentTurnLimit?: number;
  /** Owner opt-in: ComputerUse may drive real browser windows with the mouse. */
  computerUseBrowser?: boolean;
}

// WebKitGTK (the Linux webview) composites backdrop-filter and the edge-flame
// on the CPU — the whole app turns into a slideshow. Detect Linux once at boot
// and run in "lite" rendering mode (CSS strips the expensive effects); the
// flame defaults to clean there too. Windows/macOS keep the full show.
export const IS_LINUX = /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);
if (IS_LINUX) document.documentElement.dataset.perf = "lite";

export const PREFS_KEY = "ares.desktop.v3";
export function loadPrefs(): Prefs {
  const fallback: Prefs = {
    provider: "ollama",
    model: "qwen3-coder:480b-cloud",
    reasoning: "medium",
    routing: {},
    routingMode: "manual",
    toolDisplay: "product",
    flameMode: IS_LINUX ? "minimal" : "glow",
    pinned: [],
    theme: "rage",
    uiStyle: "modern",
    engine: {},
  };
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    const themeOk = THEMES.some((t) => t.id === raw.theme);
    const routing = raw.routing && typeof raw.routing === "object" ? raw.routing : {};
    return {
      provider: raw.provider ?? fallback.provider,
      model: raw.model ?? fallback.model,
      reasoning: REASONING_LEVELS.includes(raw.reasoning as ReasoningLevel) ? (raw.reasoning as ReasoningLevel) : "medium",
      // The old global "mode" dial mixed provider reasoning with fleet
      // orchestration and could silently stay ultra after the control vanished.
      // Autonomy is selected by the task/router now, never by stale UI state.
      ultra: false,
      routing,
      // Auto-routing is OPT-IN, never inferred. Previously an unset routingMode
      // flipped to "auto" whenever any lane assignment existed — so a user who
      // once tried routing found their manual model silently swapped per task
      // ("keeps flipping to random ones"). Unset now always means manual; auto
      // only when the user explicitly toggled it (which saves routingMode).
      routingMode: raw.routingMode === "auto" ? "auto" : "manual",
      toolDisplay: raw.toolDisplay === "technical" ? "technical" : "product",
      // Effects migration: the old strobing modes map onto their safe
      // equivalents — immersive/combat carried the glow, clean was quiet.
      flameMode:
        raw.flameMode === "glow" || raw.flameMode === "minimal" || raw.flameMode === "off"
          ? raw.flameMode
          : raw.flameMode === "clean"
            ? "minimal"
            : raw.flameMode === "immersive" || raw.flameMode === "combat"
              ? "glow"
              : fallback.flameMode,
      uiEffect:
        raw.uiEffect && typeof raw.uiEffect === "object"
          ? {
              hue: typeof raw.uiEffect.hue === "number" && Number.isFinite(raw.uiEffect.hue) ? ((raw.uiEffect.hue % 360) + 360) % 360 : undefined,
              speed: raw.uiEffect.speed === "calm" || raw.uiEffect.speed === "brisk" ? raw.uiEffect.speed : "steady",
              label: typeof raw.uiEffect.label === "string" ? raw.uiEffect.label.slice(0, 24) : undefined,
            }
          : undefined,
      pinned: Array.isArray(raw.pinned) ? raw.pinned.filter((p): p is string => typeof p === "string") : [],
      theme: themeOk ? (raw.theme as ThemeName) : "rage",
      // Glass-revamp migration: pre-V2 saves stored "new" as the mere DEFAULT,
      // not a choice — upgrade those to "modern" once. Post-V2 saves (any
      // value) are explicit picks and stick, so Forged stays selectable.
      uiStyle: raw.uiStyle === "legacy"
        ? "legacy"
        : raw.uiStyleV2 && raw.uiStyle === "new"
          ? "new"
          : "modern",
      uiStyleV2: true,
      engine: raw.engine && typeof raw.engine === "object" ? raw.engine : {},
      voiceEnabled: raw.voiceEnabled === true,
      voiceId: typeof raw.voiceId === "string" ? raw.voiceId : undefined,
      voiceSpeed: typeof raw.voiceSpeed === "number" && raw.voiceSpeed >= 0.5 && raw.voiceSpeed <= 2 ? raw.voiceSpeed : 1,
      wakeWord: raw.wakeWord === true,
      voiceNotify: raw.voiceNotify !== false, // default ON — a spoken heads-up is the point of voice

    };
  } catch {
    return fallback;
  }
}
export function savePrefs(p: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

// Owner permission posture — mirrors @ares/cli permissionPolicy.PermissionSettings.
// Defaults are the conservative baseline (guarded; sensitive asks; fleets inherit).
export interface PermSettings {
  mode: "guarded" | "free";
  fileWrite: boolean;
  shell: boolean;
  network: boolean;
  sensitive: boolean;
  fleetsInherit: boolean;
}
export const DEFAULT_PERMS: PermSettings = {
  mode: "guarded", fileWrite: true, shell: true, network: true, sensitive: false, fleetsInherit: true,
};
