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
  /** Session id → project name. Groups related sessions under a named,
   *  collapsible rail section. Client-side like `pinned`: sessions on disk
   *  are untouched, a project simply exists while it has members. */
  sessionProjects?: Record<string, string>;
  /** Project names whose rail section is currently collapsed. */
  collapsedProjects?: string[];
  /** Accent theme for the desktop chrome. Derived from surface + accent. */
  theme: ThemeName;
  /** The surface the UI is painted on (shell + neutral ramp). */
  surface: SurfaceName;
  /** The colour applied on top of that surface, via data-accent. */
  accent: AccentName;
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

export type ThemeName =
  | "rage" | "bronze" | "crimson" | "steel" | "nightfall" | "verdant" | "daylight"
  | "basic-light" | "basic-dark" | "basic-bronze" | "basic-violet" | "basic-steel";

/* ── Appearance, as two dials instead of one long list ──────────────────────
   The old panel offered a flat grid of every theme, which grew to twelve
   cards and read as clutter. Appearance is really two independent choices:
   the SURFACE you work on, and the ACCENT that colours it. Four surfaces × a
   row of swatches covers more combinations than the old list did, in a
   fraction of the space.

   `theme` and `uiStyle` remain the wire format the whole app already reads —
   surface/accent derive into them, so nothing downstream had to change. */
export type SurfaceName = "legacy" | "modern" | "basic-light" | "basic-dark";
export const SURFACES: Array<{ id: SurfaceName; label: string; hint: string }> = [
  { id: "modern", label: "Modern", hint: "Smoked glass over a cinematic canvas" },
  { id: "legacy", label: "Legacy", hint: "The classic flat obsidian shell" },
  { id: "basic-dark", label: "Basic dark", hint: "Flat neutral greys, no ornament" },
  { id: "basic-light", label: "Basic light", hint: "Flat white, no ornament" },
];

export type AccentName = "ember" | "bronze" | "crimson" | "steel" | "violet" | "verdant" | "blue";
export const ACCENTS: Array<{ id: AccentName; label: string; swatch: string }> = [
  { id: "ember", label: "Ember", swatch: "#e26634" },
  { id: "bronze", label: "Bronze", swatch: "#c79a4e" },
  { id: "crimson", label: "Crimson", swatch: "#c0504a" },
  { id: "steel", label: "Steel", swatch: "#6fb3ae" },
  { id: "violet", label: "Violet", swatch: "#8b8bd9" },
  { id: "verdant", label: "Verdant", swatch: "#6dc398" },
  { id: "blue", label: "Blue", swatch: "#2f6fed" },
];

/** The surface decides the shell; the accent is applied on top via data-accent. */
export function surfaceToStyle(surface: SurfaceName): Prefs["uiStyle"] {
  return surface === "legacy" ? "legacy" : "modern";
}
export function surfaceToTheme(surface: SurfaceName): ThemeName {
  if (surface === "basic-light") return "basic-light";
  if (surface === "basic-dark") return "basic-dark";
  return "rage"; // the obsidian base; data-accent supplies the colour
}
/** Migration: read a surface/accent pair out of a pre-split saved theme. */
function surfaceFromLegacy(theme: unknown, uiStyle: unknown): SurfaceName {
  if (theme === "basic-light" || theme === "daylight") return "basic-light";
  if (typeof theme === "string" && theme.startsWith("basic-")) return "basic-dark";
  return uiStyle === "legacy" ? "legacy" : "modern";
}
function accentFromLegacy(theme: unknown): AccentName {
  switch (theme) {
    case "bronze": case "basic-bronze": return "bronze";
    case "crimson": return "crimson";
    case "steel": case "basic-steel": return "steel";
    case "nightfall": case "basic-violet": return "violet";
    case "verdant": return "verdant";
    case "basic-light": case "basic-dark": return "blue";
    default: return "ember";
  }
}
export const THEMES: Array<{ id: ThemeName; label: string; hint: string; swatch: string }> = [
  { id: "rage", label: "Blood & Rage", hint: "obsidian scorched with ember — the god of war", swatch: "#d6402e" },
  { id: "bronze", label: "Bronze", hint: "the old warband gold", swatch: "#c79a4e" },
  { id: "crimson", label: "Crimson Banner", hint: "blood-red command", swatch: "#c0504a" },
  { id: "steel", label: "Steel Legion", hint: "cool tempered teal", swatch: "#7fa6a3" },
  { id: "nightfall", label: "Nightfall", hint: "violet dusk", swatch: "#8b8bd9" },
  { id: "verdant", label: "Verdant", hint: "emerald phalanx", swatch: "#74c39c" },
  { id: "daylight", label: "Daylight", hint: "the forge at high noon — light mode", swatch: "#f0e9e2" },
  // The two quiet ones: no forge, no ornament. Neutral greys, one blue accent,
  // flat surfaces — for working in a room where the war-band is too much.
  { id: "basic-light", label: "Basic (light)", hint: "clean, flat, neutral — no forge", swatch: "#ffffff" },
  { id: "basic-dark", label: "Basic (dark)", hint: "clean, flat, neutral — no forge", swatch: "#1e1e1e" },
  { id: "basic-bronze", label: "Basic (bronze)", hint: "the flat theme in warband gold", swatch: "#c79a4e" },
  { id: "basic-violet", label: "Basic (violet)", hint: "the flat theme in violet dusk", swatch: "#8b8bd9" },
  { id: "basic-steel", label: "Basic (steel)", hint: "the flat theme in tempered teal", swatch: "#6fb3ae" },
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
    surface: "modern",
    accent: "ember",
    uiStyle: "modern",
    engine: {},
  };
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    const themeOk = THEMES.some((t) => t.id === raw.theme);
    // Pre-split saves carry only `theme`; read a surface/accent pair out of it
    // so an existing user lands on the closest equivalent instead of a reset.
    const surface: SurfaceName = SURFACES.some((s) => s.id === raw.surface)
      ? (raw.surface as SurfaceName)
      : surfaceFromLegacy(raw.theme, raw.uiStyle);
    const accent: AccentName = ACCENTS.some((a) => a.id === raw.accent)
      ? (raw.accent as AccentName)
      : accentFromLegacy(raw.theme);
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
      sessionProjects:
        raw.sessionProjects && typeof raw.sessionProjects === "object"
          ? Object.fromEntries(
              Object.entries(raw.sessionProjects).filter(
                (pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].trim().length > 0,
              ),
            )
          : undefined,
      collapsedProjects: Array.isArray(raw.collapsedProjects)
        ? raw.collapsedProjects.filter((p): p is string => typeof p === "string")
        : undefined,
      surface,
      accent,
      // Derived, never authored: the surface owns the theme now. Kept in the
      // saved shape because the whole app reads prefs.theme.
      theme: raw.surface || !themeOk ? surfaceToTheme(surface) : (raw.theme as ThemeName),
      // Glass-revamp migration: pre-V2 saves stored "new" as the mere DEFAULT,
      // not a choice — upgrade those to "modern" once. Forged is no longer in
      // the picker, but a save that explicitly holds it still renders it.
      uiStyle: raw.uiStyleV2 && raw.uiStyle === "new" ? "new" : surfaceToStyle(surface),
      uiStyleV2: true,
      engine: raw.engine && typeof raw.engine === "object" ? raw.engine : {},
      voiceEnabled: raw.voiceEnabled === true,
      voiceId: typeof raw.voiceId === "string" ? raw.voiceId : undefined,
      voiceSpeed: typeof raw.voiceSpeed === "number" && raw.voiceSpeed >= 0.5 && raw.voiceSpeed <= 2 ? raw.voiceSpeed : 1,
      wakeWord: raw.wakeWord === true,
      voiceNotify: raw.voiceNotify !== false, // default ON — a spoken heads-up is the point of voice
      // These MUST round-trip: the returned literal is the whole Prefs from
      // here on, so any stored key omitted here is erased by the next
      // savePrefs. Dropping them lost every star/recent on each launch.
      favoriteModels: Array.isArray(raw.favoriteModels)
        ? raw.favoriteModels.filter((m): m is string => typeof m === "string")
        : undefined,
      recentModels: Array.isArray(raw.recentModels)
        ? raw.recentModels.filter((m): m is string => typeof m === "string").slice(0, 6)
        : undefined,
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
