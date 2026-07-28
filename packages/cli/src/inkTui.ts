import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import type { PermissionMode, Todo, TurnEvent, Usage } from "@ares/protocol";
import { availableThemes, currentThemeName, type ThemeName } from "./terminalUi.js";
import { modelContextWindow } from "./entry/sessionFactory.js";
import { renderMarkdown, type MdLine, type MdSpan, type MdTheme } from "./mdRender.js";
import { flameLine, moltenCursor, forgeStrike, type FxSpan, type FxPalette } from "./tuiFx.js";
import { ChatMain, mapTone } from "./ui/chat/ChatMain.js";
import { PermissionCard } from "./ui/chat/PermissionCard.js";
import { TodoStrip } from "./ui/chat/TodoStrip.js";
import { SLATE } from "./ui/theme.js";
import {
  diffHeaderLabel,
  diffLineSpans,
  easeToward,
  endsWithContinuation,
  fleetGlyph,
  fleetSummary,
  foldFleetRows,
  formatDuration,
  groupDiffByFile,
  motionEnabled,
  normalizeInputChunk,
  reduceFleet,
  searchHistory,
  shimmerSpans,
  stripContinuation,
  type DiffLineTheme,
  type FleetState,
} from "./tuiElite.js";
import { onLifecycle, type LifecycleEvent } from "@ares/agent";
import {
  disableMouseTracking,
  enableMouseTracking,
  isMouseFragment,
  parseSgrMouse,
  type SgrMouseEvent,
} from "./mouseInput.js";
import {
  CHROME_SEPARATOR,
  CHROME_START_COL,
  MODAL_BODY_START_ROW,
  MODAL_TAB_ROW,
  SLIDER_LEVELS,
  SURGE_TICKS,
  SURGE_TICK_MS,
  TOOLBAR_ITEMS,
  indexForKey,
  keyForIndex,
  modalHitTest,
  parseReasoningLevel,
  sliderFillColor,
  sliderFlameRow,
  sliderIndexAt,
  sliderSpans,
  surgeFrame,
  terminalRowToAppRow,
  textWidth,
  toolbarHitTest,
  SLATE_HEADER_MODEL_ROW,
  slateModelSpan,
  permHitTest,
  ultraBadgeFrame,
  type SliderTokens,
} from "./tuiChrome.js";

// Weirdcore score popup. Every evolution event emits a gain { target, delta }.
// The TUI shows the last few as floating +N TARGET cards that fade out.
interface Pulse {
  id: number;
  type: LifecycleEvent["type"];
  target: string;
  delta: number;
  kind?: string;
  createdAt: number;
}

function shouldSurfacePulse(event: LifecycleEvent): event is LifecycleEvent & { gain: { target: string; delta: number; kind?: string } } {
  return "gain" in event && typeof (event as { gain?: unknown }).gain === "object" && (event as { gain?: { target?: string } }).gain?.target != null;
}

export interface InkChatSnapshot {
  provider: string;
  model: string;
  workspace: string;
  mode: PermissionMode;
}

export interface InkCommandResult {
  kind: "handled" | "not-handled" | "exit";
  lines?: string[];
  snapshot?: InkChatSnapshot;
}

export interface InkChatOptions {
  snapshot(): InkChatSnapshot;
  resumedLines?: string[];
  sendMessage(goal: string, onEvent: (event: TurnEvent) => void): Promise<void>;
  handleCommand(line: string): Promise<InkCommandResult>;
  /** Structured model catalog per provider, for the ⌃M picker. */
  listModelOptions?(provider: string): Promise<Array<{ id: string; label?: string; hint?: string }>>;
  /** Hands the TUI the live permission seam: the host routes the engine's
   *  requestPermission through the handler registered here, so prompts render
   *  as an IN-FRAME card (keys 1/2/3 or click) instead of a raw-stderr prompt
   *  Ink instantly paints over — which hung turns forever. */
  registerPermissionHandler?(
    handler: (req: { toolName: string; reason: string; suggestion?: string }) => Promise<"allow_once" | "allow_always" | "deny">,
  ): void;
  /** Mid-turn steering: a line typed while busy is queued into the live turn
   *  (the engine drains reminders after every tool round) instead of dropped. */
  steer?(text: string): void;
}

/** One pending permission ask — the card renders it; a key/click resolves it. */
interface PendingPermission {
  toolName: string;
  reason: string;
  suggestion?: string;
  resolve: (d: "allow_once" | "allow_always" | "deny") => void;
}

interface LogLine {
  id: number;
  tone: "user" | "assistant" | "tool" | "error" | "notice" | "muted" | "diff-add" | "diff-del" | "diff-meta" | "diff-file" | "verify";
  text: string;
  meta?: string;
  /** For tool lines: the outcome appended on tool_end (▸ Name … ✓ result). */
  result?: { ok: boolean; text: string; durationMs?: number };
  /** A wrapped continuation of the line above — render without repeating the label. */
  cont?: boolean;
  /** diff-file cards: hunk body lines shown while expanded. */
  detail?: string[];
  /** diff-file cards: expanded while the turn streams, collapsed on completion. */
  expanded?: boolean;
  /** diff-file cards: add/del counts for the colored header. */
  adds?: number;
  dels?: number;
  /** tool lines: wall-clock start for the live elapsed readout. */
  startedAt?: number;
}

interface RuntimeStats {
  turns: number;
  tools: number;
  errors: number;
  checkpoints: number;
  durationMs: number;
  usage: Usage;
}

interface DeckTheme {
  title: string;
  borderStyle: "single" | "round" | "bold" | "double" | "classic";
  frame: string;
  accent: string;
  accent2: string;
  accent3: string;
  text: string;
  dim: string;
  panel: string;
  input: string;
  user: string;
  assistant: string;
  tool: string;
  error: string;
  success: string;
  warn: string;
}

const h = React.createElement;

// God-of-war themes — exact desktop palette in 24-bit hex (Ink renders hex via
// chalk). `rage` is the default face: warm-black, crimson, ember, warm-tan text.
const DECK_THEMES: Record<ThemeName, DeckTheme> = {
  rage: {
    title: "RAGE", borderStyle: "round", frame: "#d6402e",
    accent: "#ff6a44", accent2: "#ffb24d", accent3: "#ff6a30",
    text: "#ece3d9", dim: "#8b756d", panel: "#d6402e", input: "#d6402e",
    user: "#ece3d9", assistant: "#ece3d9", tool: "#ff6a44",
    error: "#ff5740", success: "#6dc398", warn: "#ffb24d",
  },
  bronze: {
    title: "BRONZE", borderStyle: "round", frame: "#c79a4e",
    accent: "#e6bd72", accent2: "#ffd877", accent3: "#e0a93c",
    text: "#ece0cf", dim: "#8b7a5d", panel: "#c79a4e", input: "#c79a4e",
    user: "#ece0cf", assistant: "#ece0cf", tool: "#e6bd72",
    error: "#e36258", success: "#6dc398", warn: "#ffd877",
  },
  crimson: {
    title: "CRIMSON", borderStyle: "round", frame: "#c0504a",
    accent: "#e87a72", accent2: "#ff9a8f", accent3: "#e36258",
    text: "#ece0dd", dim: "#9b756d", panel: "#c0504a", input: "#c0504a",
    user: "#ece0dd", assistant: "#ece0dd", tool: "#e87a72",
    error: "#ff5740", success: "#6dc398", warn: "#ffb24d",
  },
  steel: {
    title: "STEEL", borderStyle: "round", frame: "#6fb3ae",
    accent: "#a6e0da", accent2: "#95e6dd", accent3: "#5fb8b0",
    text: "#dceae9", dim: "#6d8b87", panel: "#6fb3ae", input: "#6fb3ae",
    user: "#dceae9", assistant: "#dceae9", tool: "#a6e0da",
    error: "#ff5740", success: "#6dc398", warn: "#ffb24d",
  },
  nightfall: {
    title: "NIGHTFALL", borderStyle: "round", frame: "#8b8bd9",
    accent: "#b6b6f5", accent2: "#c4b6ff", accent3: "#9a8bef",
    text: "#e3e3f0", dim: "#6d6d8b", panel: "#8b8bd9", input: "#8b8bd9",
    user: "#e3e3f0", assistant: "#e3e3f0", tool: "#b6b6f5",
    error: "#ff5740", success: "#6dc398", warn: "#ffb24d",
  },
  verdant: {
    title: "VERDANT", borderStyle: "round", frame: "#6dc398",
    accent: "#9fe7bd", accent2: "#93eab8", accent3: "#59c08c",
    text: "#dceae3", dim: "#6d8b7a", panel: "#6dc398", input: "#6dc398",
    user: "#dceae3", assistant: "#dceae3", tool: "#9fe7bd",
    error: "#ff5740", success: "#6dc398", warn: "#ffd877",
  },
  cyberpunk: {
    title: "CYBERPUNK",
    borderStyle: "round",
    frame: "magenta",
    accent: "magenta",
    accent2: "cyan",
    accent3: "blue",
    text: "white",
    dim: "gray",
    panel: "magenta",
    input: "magenta",
    user: "cyan",
    assistant: "white",
    tool: "magenta",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  minimal: {
    title: "MINIMALIST",
    borderStyle: "single",
    frame: "gray",
    accent: "cyan",
    accent2: "white",
    accent3: "blue",
    text: "white",
    dim: "gray",
    panel: "gray",
    input: "blue",
    user: "cyan",
    assistant: "white",
    tool: "blue",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  matrix: {
    title: "HACKER TERMINAL",
    borderStyle: "classic",
    frame: "green",
    accent: "green",
    accent2: "green",
    accent3: "yellow",
    text: "green",
    dim: "gray",
    panel: "green",
    input: "green",
    user: "green",
    assistant: "white",
    tool: "green",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  neon: {
    title: "NEON BLUE",
    borderStyle: "round",
    frame: "blue",
    accent: "blue",
    accent2: "cyan",
    accent3: "magenta",
    text: "white",
    dim: "gray",
    panel: "blue",
    input: "cyan",
    user: "cyan",
    assistant: "white",
    tool: "blue",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  split: {
    title: "SPLIT PANEL",
    borderStyle: "round",
    frame: "magenta",
    accent: "magenta",
    accent2: "blue",
    accent3: "cyan",
    text: "white",
    dim: "gray",
    panel: "magenta",
    input: "magenta",
    user: "magenta",
    assistant: "white",
    tool: "blue",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  professional: {
    title: "BOXED PROFESSIONAL",
    borderStyle: "single",
    frame: "white",
    accent: "white",
    accent2: "gray",
    accent3: "green",
    text: "white",
    dim: "gray",
    panel: "gray",
    input: "white",
    user: "white",
    assistant: "white",
    tool: "gray",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  amber: {
    title: "MODERN DARK",
    borderStyle: "round",
    frame: "yellow",
    accent: "yellow",
    accent2: "white",
    accent3: "cyan",
    text: "white",
    dim: "gray",
    panel: "yellow",
    input: "yellow",
    user: "yellow",
    assistant: "white",
    tool: "cyan",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  dashboard: {
    title: "DASHBOARD",
    borderStyle: "round",
    frame: "cyan",
    accent: "cyan",
    accent2: "blue",
    accent3: "magenta",
    text: "white",
    dim: "gray",
    panel: "cyan",
    input: "cyan",
    user: "cyan",
    assistant: "white",
    tool: "blue",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  light: {
    title: "CLEAN LIGHT",
    borderStyle: "round",
    frame: "blue",
    accent: "blue",
    accent2: "cyan",
    accent3: "green",
    text: "black",
    dim: "gray",
    panel: "blue",
    input: "blue",
    user: "blue",
    assistant: "black",
    tool: "cyan",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  midnight: {
    title: "MIDNIGHT",
    borderStyle: "round",
    frame: "blue",
    accent: "blueBright",
    accent2: "magentaBright",
    accent3: "cyanBright",
    text: "white",
    dim: "gray",
    panel: "blue",
    input: "blueBright",
    user: "cyanBright",
    assistant: "white",
    tool: "magentaBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellowBright",
  },
  "mono-pro": {
    title: "MONO PRO",
    borderStyle: "single",
    frame: "gray",
    accent: "whiteBright",
    accent2: "white",
    accent3: "whiteBright",
    text: "white",
    dim: "gray",
    panel: "gray",
    input: "whiteBright",
    user: "whiteBright",
    assistant: "white",
    tool: "white",
    error: "redBright",
    success: "white",
    warn: "yellowBright",
  },
  solarized: {
    title: "SOLARIZED",
    borderStyle: "round",
    frame: "yellow",
    accent: "yellowBright",
    accent2: "cyanBright",
    accent3: "blueBright",
    text: "white",
    dim: "gray",
    panel: "yellow",
    input: "yellowBright",
    user: "cyanBright",
    assistant: "white",
    tool: "blueBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellow",
  },
  synthwave: {
    title: "SYNTHWAVE",
    borderStyle: "double",
    frame: "magentaBright",
    accent: "magentaBright",
    accent2: "cyanBright",
    accent3: "blueBright",
    text: "white",
    dim: "blueBright",
    panel: "magenta",
    input: "magentaBright",
    user: "cyanBright",
    assistant: "white",
    tool: "magentaBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellowBright",
  },
  graphite: {
    title: "GRAPHITE",
    borderStyle: "single",
    frame: "gray",
    accent: "whiteBright",
    accent2: "cyanBright",
    accent3: "greenBright",
    text: "white",
    dim: "gray",
    panel: "gray",
    input: "cyanBright",
    user: "cyanBright",
    assistant: "white",
    tool: "greenBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellowBright",
  },
  oxide: {
    title: "OXIDE",
    borderStyle: "round",
    frame: "red",
    accent: "redBright",
    accent2: "yellowBright",
    accent3: "cyanBright",
    text: "white",
    dim: "gray",
    panel: "red",
    input: "yellowBright",
    user: "yellowBright",
    assistant: "white",
    tool: "cyanBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellowBright",
  },
};

// Motion gate — non-TTY or ARES_NO_MOTION=1 renders static (no shimmer,
// no spinner ticks, gauge jumps instead of easing).
const MOTION = motionEnabled();

// ⌃P command palette — the desktop has a command surface; the terminal didn't.
const PALETTE: { cmd: string; desc: string }[] = [
  { cmd: "/help", desc: "show every command" },
  { cmd: "/model", desc: "switch the live model" },
  { cmd: "/models", desc: "list models for a provider" },
  { cmd: "/reasoning", desc: "set reasoning low|medium|high|max" },
  { cmd: "/routing", desc: "per-lane model routing" },
  { cmd: "/theme", desc: "switch theme — rage, bronze, crimson, steel…" },
  { cmd: "/themes", desc: "list installed themes" },
  { cmd: "/plan", desc: "read-only planning mode" },
  { cmd: "/code", desc: "exit plan, allow workspace writes" },
  { cmd: "/danger", desc: "toggle bypass — auto-approve tools" },
  { cmd: "/sessions", desc: "list saved sessions" },
  { cmd: "/resume", desc: "replay a session into context" },
  { cmd: "/checkpoints", desc: "list workspace checkpoints" },
  { cmd: "/undo", desc: "restore the last pre-write checkpoint" },
  { cmd: "/keys", desc: "API key status" },
  { cmd: "/settings", desc: "model, keys, routing, runtime" },
  { cmd: "/doctor", desc: "provider + runtime health" },
  { cmd: "/workspace", desc: "switch the active workspace" },
  { cmd: "/exit", desc: "close Ares" },
];

function filterPalette(query: string): { cmd: string; desc: string }[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return PALETTE;
  return PALETTE.filter((c) => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
}

// Live activity spinner — braille frames, the "Claude is working" pulse next to
// streaming text and running tools.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ⌃O / "/model" model+provider picker — scroll, don't type names.
const PICKER_PROVIDERS = ["ollama", "openai", "anthropic", "openrouter", "deepseek", "ares"];

// ─── Clickable chrome geometry (shared with the tuiChrome hit-tests) ─────────
// The owner's device has NO arrow keys: everything below is mouse-first with
// number-key fallbacks. Overlays REPLACE the main view (anchored app row 1) so
// modalHitTest's row math is exact; the toolbar pins to the frame's bottom row.
const SETTINGS_TABS = ["Providers", "Models", "Appearance", "Effort", "Engine"];
const SETTINGS_PROVIDERS_TAB = 0;
const SETTINGS_MODELS_TAB = 1;
const SETTINGS_APPEARANCE_TAB = 2;
const SETTINGS_EFFORT_TAB = 3;
const SETTINGS_ENGINE_TAB = 4;
/** Providers whose keys can be set from the Providers tab — mirrors the
 *  desktop Settings → API Keys card and dispatches the same /key command. */
const KEY_PROVIDERS = ["anthropic", "openrouter", "deepseek", "openai", "brave", "ares"] as const;
// Effort slider geometry: the bar starts after chrome padding + the "🔥 " prefix,
// and its body rows sit at fixed app rows so clicks/drags map deterministically.
const EFFORT_BAR_START = CHROME_START_COL + textWidth("🔥 ");
const EFFORT_FLAME_ROW = MODAL_BODY_START_ROW;
const EFFORT_LABEL_ROW = MODAL_BODY_START_ROW + 2;
// The fixed ramp the slider burns through regardless of theme:
// steel → ember → crimson → gold (desktop palette hexes).
function sliderTokensFrom(theme: DeckTheme): SliderTokens {
  return { steel: "#6fb3ae", ember: "#ff6a44", crimson: "#d6402e", gold: "#ffd877", dim: theme.dim };
}

/** Bridge the active theme into the fire palette so every God-of-War theme
 *  (rage, bronze, crimson, steel, nightfall, verdant) re-tints the flames. */
function fxPaletteFrom(theme: DeckTheme): FxPalette {
  return { ember: theme.accent, crimson: theme.accent3 ?? theme.accent, gold: theme.accent2, steel: theme.text, dim: theme.dim };
}

/** Render FX spans as an Ink Text run — the one adapter from the pure fire
 *  library to the terminal. */
function fxSpans(spans: FxSpan[], keyBase: string): React.ReactNode[] {
  return spans.map((s, i) => h(Text, { key: `${keyBase}-${i}`, color: s.color, bold: s.bold, dimColor: s.dim }, s.text));
}

export async function runInkChat(options: InkChatOptions): Promise<number> {
  process.stdout.write("\u001b[?1049l\u001b[?1002l\u001b[?1006l\u001b[?1000l\u001b[?25h\u001b[2J\u001b[3J\u001b[H");
  const instance = render(h(AresInkApp, { options }), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    alternateScreen: false,
    exitOnCtrlC: true,
  });
  try {
    const result = await instance.waitUntilExit();
    return typeof result === "number" ? result : 0;
  } finally {
    // Belt-and-braces: the mount effect's cleanup and mouseInput's process
    // hooks also restore, but this is the common exit path — NEVER hand the
    // owner back a terminal stuck in mouse mode.
    disableMouseTracking();
  }
}

function AresInkApp({ options }: { options: InkChatOptions }) {
  const app = useApp();
  const { rows, columns } = useWindowSize();
  const theme = deckTheme();
  const [snapshot, setSnapshot] = useState(options.snapshot());
  const [lines, setLines] = useState<LogLine[]>(() =>
    (options.resumedLines ?? []).map((text, index) => ({ id: index + 1, tone: "notice", text })),
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  // Ctrl+R reverse-search over history — live match preview in the composer.
  const [rsOpen, setRsOpen] = useState(false);
  const [rsQuery, setRsQuery] = useState("");
  const [rsSkip, setRsSkip] = useState(0);
  // Live Conductor fleet panel (fleet_activity riding tool_progress).
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const fleetRef = useRef<FleetState | null>(null);
  const fleetToolRef = useRef<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSel, setPaletteSel] = useState(0);
  const [spin, setSpin] = useState(0);
  const [activity, setActivity] = useState<string | null>(null);
  // When the current turn began — drives the live "working Ns" timer in slate.
  const turnStartedAt = useRef<number | null>(null);
  // Cumulative reasoning chars this turn (~4 chars/token) — the live "thinking"
  // counter that keeps a deep-reasoning model from looking frozen.
  const thinkingChars = useRef(0);
  // ── In-frame permission prompts ──────────────────────────────────────────
  // The engine's requestPermission lands here (via registerPermissionHandler);
  // one card shows at a time, parallel asks queue behind it.
  const [perm, setPerm] = useState<PendingPermission | null>(null);
  const permRef = useRef<PendingPermission | null>(null);
  const permQueue = useRef<PendingPermission[]>([]);
  permRef.current = perm;
  useEffect(() => {
    options.registerPermissionHandler?.(
      (req) =>
        new Promise((resolve) => {
          const pending: PendingPermission = { ...req, resolve };
          if (permRef.current) permQueue.current.push(pending);
          else setPerm(pending);
        }),
    );
  }, [options]);
  const decidePermission = useCallback((decision: "allow_once" | "allow_always" | "deny") => {
    const current = permRef.current;
    if (!current) return;
    current.resolve(decision);
    setPerm(permQueue.current.shift() ?? null);
  }, []);
  // Fullscreen overlays — each REPLACES the main view (anchored at app row 1)
  // so every row is deterministic for the tuiChrome hit-tests.
  const [overlay, setOverlay] = useState<"models" | "effort" | "settings" | null>(null);
  const [settingsTab, setSettingsTab] = useState(0);
  const [ovScroll, setOvScroll] = useState(0);
  /** Non-null while the "custom model id" row is capturing typed text. */
  const [mpCustom, setMpCustom] = useState<string | null>(null);
  /** Masked key entry on the Providers tab: which provider + typed value. */
  const [keyCapture, setKeyCapture] = useState<{ provider: string; value: string } | null>(null);
  /** Live info lines for the Providers (/keys) and Engine (/settings) tabs. */
  const [settingsInfo, setSettingsInfo] = useState<string[]>([]);
  // Effort dial — local mirror of the host's /reasoning level, seeded lazily
  // the first time an effort surface opens (parsed from the live /reasoning line).
  const [effortLevel, setEffortLevel] = useState(2);
  const effortKnown = useRef(false);
  // THE ULTRA SURGE tick (null = idle) + the slow post-surge badge breathe.
  const [surgeTick, setSurgeTick] = useState<number | null>(null);
  const [pulseTick, setPulseTick] = useState(0);
  const dragEffort = useRef(false);
  const [mpProvider, setMpProvider] = useState(0);
  const [mpModels, setMpModels] = useState<Array<{ id: string; label?: string; hint?: string }>>([]);
  const [mpSel, setMpSel] = useState(0);
  const [mpLoading, setMpLoading] = useState(false);
  const [stats, setStats] = useState<RuntimeStats>({
    turns: 0,
    tools: 0,
    errors: 0,
    checkpoints: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const assistantRef = useRef("");
  const lineId = useRef((options.resumedLines?.length ?? 0) + 1);
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number | null>(null);

  // ─── Evolution pulses — weirdcore +N score popups ────────────────────
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const pulseId = useRef(1);
  const [frameTick, setFrameTick] = useState(0);
  useEffect(() => {
    const unsubscribe = onLifecycle((event) => {
      if (!shouldSurfacePulse(event)) return;
      const gain = event.gain;
      const id = pulseId.current++;
      setPulses((prev) => [...prev.slice(-3), {
        id,
        type: event.type,
        target: gain.target,
        delta: gain.delta,
        kind: gain.kind,
        createdAt: Date.now(),
      }]);
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrameTick((t) => t + 1);
      const now = Date.now();
      setPulses((prev) => prev.filter((p) => now - p.createdAt < 9_000));
    }, 250);
    return () => clearInterval(timer);
  }, []);
  void frameTick;

  // Fast spinner tick — runs ONLY while a turn is in flight, so idle is free.
  // Also drives the shimmer band and live tool-elapsed readouts. Static when
  // motion is disabled (non-TTY / ARES_NO_MOTION=1).
  useEffect(() => {
    if (!busy || !MOTION) {
      setSpin(0);
      return;
    }
    const id = setInterval(() => setSpin((s) => (s + 1) % 3600), 90);
    return () => clearInterval(id);
  }, [busy]);
  const frame = MOTION ? SPINNER[spin % SPINNER.length] : "…";

  // Load the model catalog for the picker's current provider (async, cancellable).
  useEffect(() => {
    if (overlay !== "models" || !options.listModelOptions) return;
    let cancelled = false;
    setMpLoading(true);
    options
      .listModelOptions(PICKER_PROVIDERS[mpProvider])
      .then((rows) => {
        if (cancelled) return;
        setMpModels(rows);
        setMpSel(0);
        setOvScroll(0);
        setMpLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMpModels([]);
        setMpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overlay, mpProvider, options]);

  // Providers/Engine tabs show live host state — quiet /keys | /settings
  // queries, refetched on tab entry (and after a key save via keyCapture).
  useEffect(() => {
    if (overlay !== "settings" || (settingsTab !== SETTINGS_PROVIDERS_TAB && settingsTab !== SETTINGS_ENGINE_TAB)) return;
    if (keyCapture != null) return; // wait until the save lands
    let cancelled = false;
    options
      .handleCommand(settingsTab === SETTINGS_PROVIDERS_TAB ? "/keys" : "/settings")
      .then((r) => {
        if (!cancelled && r.kind === "handled") setSettingsInfo(r.lines ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [overlay, settingsTab, keyCapture, options]);

  // Seed the effort dial from the host's LIVE /reasoning level the first time
  // an effort surface opens — quiet query, no lines appended to the stream.
  useEffect(() => {
    if (overlay !== "effort" && overlay !== "settings") return;
    if (effortKnown.current) return;
    let cancelled = false;
    options
      .handleCommand("/reasoning")
      .then((result) => {
        if (cancelled) return;
        const level = parseReasoningLevel(result.lines ?? []);
        if (level) setEffortLevel(Math.max(0, SLIDER_LEVELS.indexOf(level)));
        effortKnown.current = true;
      })
      .catch(() => {
        effortKnown.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [overlay, options]);

  // THE ULTRA SURGE driver — one self-stopping chain of 80ms timeouts (~1.2s),
  // then the badge takes over. Never starts when motion is disabled.
  useEffect(() => {
    if (surgeTick == null) return;
    if (!MOTION || surgeTick >= SURGE_TICKS) {
      setSurgeTick(null);
      return;
    }
    const id = setTimeout(() => setSurgeTick((t) => (t == null ? null : t + 1)), SURGE_TICK_MS);
    return () => clearTimeout(id);
  }, [surgeTick]);

  // Post-surge ✦ U L T R A ✦ breathe — slow 600ms crimson↔gold pulse, only
  // while an effort surface is on screen at MAX and no surge is running.
  useEffect(() => {
    const effortVisible = overlay === "effort" || (overlay === "settings" && settingsTab === SETTINGS_EFFORT_TAB);
    if (!MOTION || !effortVisible || effortLevel !== SLIDER_LEVELS.length - 1 || surgeTick != null) return;
    const id = setInterval(() => setPulseTick((t) => t + 1), 600);
    return () => clearInterval(id);
  }, [overlay, settingsTab, effortLevel, surgeTick]);

  const layout = useMemo(() => {
    // Clean single-stream (the approved mockup) — the conversation is the page,
    // no side rail / status panel. Header + stream + input + status bar.
    const screenWidth = Math.max(60, columns - 2);
    const screenHeight = Math.max(18, rows - 1);
    const mainWidth = screenWidth;
    // −13: toolbar row (−1 from −11) + the header's living flame divider (−1).
    const mainHeight = Math.max(7, screenHeight - 13);
    return { mainWidth, mainHeight, screenWidth, screenHeight };
  }, [columns, rows]);

  // Overlay list capacity + effort-bar width — the SAME numbers the renderer
  // uses, so the mouse hit-tests can never drift from the pixels.
  const overlayCapacity = Math.max(4, layout.screenHeight - MODAL_BODY_START_ROW - 2);
  const effortBarWidth = Math.max(12, Math.min(30, layout.screenWidth - 16));

  const visibleLogRows = Math.max(5, layout.mainHeight - 3);
  const maxScrollOffset = Math.max(0, lines.length + (assistantDraft ? 1 : 0) - visibleLogRows);
  const scrollUp = useCallback((amount = visibleLogRows) => {
    setScrollOffset((prev) => Math.min(maxScrollOffset, prev + amount));
  }, [maxScrollOffset, visibleLogRows]);
  const scrollDown = useCallback((amount = visibleLogRows) => {
    setScrollOffset((prev) => Math.max(0, prev - amount));
  }, [visibleLogRows]);

  // Terminal mouse mode: ?1002 (press/drag/release) + ?1006 (SGR encoding).
  // Gated on TTY + ARES_NO_MOUSE inside enableMouseTracking; cleanup runs on
  // unmount AND on process exit/signals (mouseInput's hooks) — a terminal left
  // in mouse mode is broken for the user.
  useEffect(() => {
    if (!process.stdin.isTTY) return;
    if (!enableMouseTracking()) return;
    const stdinStream = process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => void };
    stdinStream.setRawMode?.(true);
    return () => disableMouseTracking();
  }, []);

  const append = useCallback((tone: LogLine["tone"], text: string, meta?: string) => {
    // Assistant replies keep their full multi-line body in ONE LogLine so the
    // markdown renderer sees fenced code blocks / lists whole. Every other tone
    // stays split-per-line (tool flow, diffs, notices render one line each).
    if (tone === "assistant") {
      setLines((prev) => [...prev, { id: lineId.current++, tone, text, meta }].slice(-600));
      return;
    }
    const chunks = text.split(/\r?\n/).filter((line) => line.length > 0);
    setLines((prev) => {
      const next = [...prev];
      const list = chunks.length > 0 ? chunks : [text];
      list.forEach((chunk, i) => {
        next.push({ id: lineId.current++, tone, text: chunk, meta, cont: i > 0 });
      });
      return next.slice(-600);
    });
  }, []);

  const flushAssistant = useCallback(() => {
    const text = assistantRef.current.trimEnd();
    if (!text) return;
    assistantRef.current = "";
    setAssistantDraft("");
    append("assistant", text, "reply");
  }, [append]);

  // Paired tool flow: tool_start opens a "▸ Name desc" line; tool_end/_error
  // stamps the ✓/✗ result onto that SAME line — keyed by the tool_use id, not
  // a single ref. The old single-ref version broke on PARALLEL tool calls:
  // three tools fired together, each start clobbered the ref, so only the
  // last-started line ever completed — the rest spun at "21m…" forever while
  // their results landed as orphan lines. THE hang illusion, fixed for real.
  const toolLinesById = useRef(new Map<string, number>());
  const appendToolLine = useCallback((toolUseId: string, name: string, desc: string) => {
    const id = lineId.current++;
    setLines((prev) => [...prev, { id, tone: "tool" as const, text: desc, meta: name, startedAt: Date.now() }].slice(-600));
    toolLinesById.current.set(toolUseId, id);
  }, []);
  const finishToolLine = useCallback((toolUseId: string, ok: boolean, text: string, durationMs?: number) => {
    const id = toolLinesById.current.get(toolUseId);
    toolLinesById.current.delete(toolUseId);
    if (id == null) {
      append(ok ? "tool" : "error", text, ok ? "ok" : "tool");
      return;
    }
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, startedAt: undefined, result: { ok, text, durationMs } } : l)));
  }, [append]);
  // A turn boundary settles any line whose completion event never arrived, so
  // nothing can spin past its turn (belt-and-suspenders on top of id pairing).
  const settleOrphanToolLines = useCallback(() => {
    const orphaned = new Set(toolLinesById.current.values());
    toolLinesById.current.clear();
    if (orphaned.size === 0) return;
    setLines((prev) =>
      prev.map((l) => (orphaned.has(l.id) && l.startedAt != null ? { ...l, startedAt: undefined, result: { ok: false, text: "no result before turn end" } } : l)),
    );
  }, []);

  // Per-file diff cards: the newest file's hunk stays expanded while the turn
  // streams; older cards (and everything on tool completion) collapse to the
  // `▸ path (+adds −dels)` header line — scrollback stays minimal.
  const appendDiffGrouped = useCallback((diff: string) => {
    const groups = groupDiffByFile(diff);
    if (groups.length === 0) return;
    setLines((prev) => {
      const next = prev.map((l) => (l.tone === "diff-file" && l.expanded ? { ...l, expanded: false } : l));
      groups.forEach((g, i) => {
        next.push({
          id: lineId.current++,
          tone: "diff-file" as const,
          text: diffHeaderLabel(g),
          meta: g.path,
          adds: g.adds,
          dels: g.dels,
          detail: g.lines.slice(0, 40),
          expanded: i === groups.length - 1,
        });
      });
      return next.slice(-600);
    });
  }, []);
  const collapseDiffCards = useCallback(() => {
    setLines((prev) =>
      prev.some((l) => l.tone === "diff-file" && l.expanded)
        ? prev.map((l) => (l.tone === "diff-file" && l.expanded ? { ...l, expanded: false } : l))
        : prev,
    );
  }, []);

  // Fleet lifecycle: progress payloads build the live panel; when the owning
  // Conductor tool call ends (or the turn does), collapse to a one-line summary.
  const applyFleetProgress = useCallback((toolId: string, data: unknown) => {
    fleetRef.current = reduceFleet(fleetRef.current, data);
    fleetToolRef.current = toolId;
    setFleet(fleetRef.current);
  }, []);
  const finalizeFleet = useCallback(() => {
    const state = fleetRef.current;
    fleetRef.current = null;
    fleetToolRef.current = null;
    if (state) {
      append("notice", fleetSummary(state), "fleet");
      setFleet(null);
    }
  }, [append]);

  const handleEvent = useCallback(
    (event: TurnEvent) => {
      if (event.type === "text_delta") {
        assistantRef.current += event.text;
        setAssistantDraft(assistantRef.current);
        setActivity("responding");
        return;
      }
      if (event.type === "thinking_delta") {
        // Live reasoning telemetry — deep thinking must LOOK alive. ~4 chars/token.
        thinkingChars.current += event.text.length;
        setActivity("thinking");
        return;
      }
      if (event.type === "tool_start") {
        flushAssistant();
        setActivity(event.name);
        appendToolLine(event.id, event.name, event.activityDescription);
        return;
      }
      if (event.type === "tool_end") {
        setActivity("responding");
        setStats((prev) => ({ ...prev, tools: prev.tools + 1 }));
        finishToolLine(event.id, true, event.display ?? "", event.durationMs);
        collapseDiffCards();
        if (fleetToolRef.current === event.id) finalizeFleet();
        return;
      }
      if (event.type === "tool_progress") {
        const obj = event.data as Record<string, unknown> | null;
        if (obj && typeof obj === "object" && obj.kind === "fleet_activity") {
          applyFleetProgress(event.id, obj);
          return;
        }
        const text = progressText(event.data);
        if (text) append("muted", text, "progress");
        return;
      }
      if (event.type === "workspace_diff") {
        appendDiffGrouped(event.diff);
        return;
      }
      if (event.type === "tool_error") {
        setStats((prev) => ({ ...prev, errors: prev.errors + 1 }));
        finishToolLine(event.id, false, event.error, event.durationMs);
        collapseDiffCards();
        if (fleetToolRef.current === event.id) finalizeFleet();
        return;
      }
      if (event.type === "todo_updated") {
        setTodos(event.todos);
        return;
      }
      if (event.type === "checkpoint_created") {
        setStats((prev) => ({ ...prev, checkpoints: prev.checkpoints + 1 }));
        append("muted", `${event.checkpointId}${event.label ? ` ${event.label}` : ""}`, "checkpoint");
        return;
      }
      if (event.type === "system_reminder_injected") {
        // Verifier verdicts and compaction notices carry real user-facing
        // signal. Everything else (memory weave, identity anchor, foreground
        // framing) is INTERNAL prompt plumbing — dumping it into the stream
        // was the single ugliest thing in the TUI. Collapse to one dim pulse
        // per source and never repeat back-to-back.
        if (event.source === "verifier") {
          append("verify", event.text, event.source);
        } else if (event.source === "compaction") {
          append("muted", event.text.split("\n")[0].slice(0, 120), "compaction");
        } else if (event.source === "instructions" && /retrying|stalled|provider hiccup|switched to/i.test(event.text)) {
          // Provider retry/stall/failover notes are the only heartbeat the user
          // gets during dead air — swallowing them read as a frozen turn.
          append("muted", event.text.split("\n")[0].slice(0, 120), "retry");
        }
        // Everything else (memory weave, identity anchor, foreground framing) is
        // INTERNAL prompt plumbing with zero user value. It is NOT shown — dumping
        // "⟡ … woven in" into the stream every turn was pure noise.
        return;
      }
      if (event.type === "error") {
        setStats((prev) => ({ ...prev, errors: prev.errors + 1 }));
        append("error", event.error.message, event.error.code);
        return;
      }
      if (event.type === "turn_end") {
        flushAssistant();
        collapseDiffCards();
        finalizeFleet();
        settleOrphanToolLines();
        // A permission ask can't outlive its turn — deny + drain so no dead
        // card lingers (its awaiter is gone; resolving is a harmless no-op).
        if (permRef.current) {
          permRef.current.resolve("deny");
          for (const p of permQueue.current) p.resolve("deny");
          permQueue.current = [];
          setPerm(null);
        }
        setStats((prev) => ({
          ...prev,
          turns: prev.turns + 1,
          durationMs: prev.durationMs + event.durationMs,
          usage: {
            inputTokens: prev.usage.inputTokens + event.usage.inputTokens,
            outputTokens: prev.usage.outputTokens + event.usage.outputTokens,
            cacheReadTokens: (prev.usage.cacheReadTokens ?? 0) + (event.usage.cacheReadTokens ?? 0),
            cacheWriteTokens: (prev.usage.cacheWriteTokens ?? 0) + (event.usage.cacheWriteTokens ?? 0),
            reasoningTokens: (prev.usage.reasoningTokens ?? 0) + (event.usage.reasoningTokens ?? 0),
          },
        }));
      }
    },
    [append, flushAssistant, appendToolLine, finishToolLine, settleOrphanToolLines, appendDiffGrouped, collapseDiffCards, applyFleetProgress, finalizeFleet],
  );

  const submit = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      // Mid-turn STEERING: typing while Ares works no longer dies at the door.
      // The line rides the engine's reminder drain and reaches the model within
      // one tool round — course-correct without killing the turn.
      if (busy) {
        if (!line.startsWith("/") && options.steer) {
          options.steer(line);
          setInput("");
          history.current.push(line);
          historyIndex.current = null;
          append("user", `↳ ${line}`, "steer");
          append("muted", "steering — applies within a tool round", "steer");
        }
        return;
      }
      // /model and /models open the scrollable picker, not a text dump.
      if ((line === "/model" || line === "/models") && options.listModelOptions) {
        setInput("");
        setMpProvider(Math.max(0, PICKER_PROVIDERS.indexOf(snapshot.provider)));
        setMpSel(0);
        setOvScroll(0);
        setMpCustom(null);
        setOverlay("models");
        return;
      }
      setInput("");
      setScrollOffset(0);
      history.current.push(line);
      historyIndex.current = null;
      append("user", line, "send");
      turnStartedAt.current = Date.now();
      thinkingChars.current = 0;
      setBusy(true);
      try {
        if (line.startsWith("/")) {
          const result = await options.handleCommand(line);
          if (result.snapshot) setSnapshot(result.snapshot);
          if (result.kind === "exit") {
            app.exit(0);
            return;
          }
          if (result.kind === "handled") {
            for (const output of result.lines ?? []) append("notice", output, "command");
            return;
          }
          append("error", `Unknown command: ${line}`, "command");
          return;
        }

        await options.sendMessage(line, handleEvent);
        setSnapshot(options.snapshot());
      } catch (err) {
        append("error", err instanceof Error ? err.message : String(err), "runtime");
      } finally {
        flushAssistant();
        setBusy(false);
        setActivity(null);
      }
    },
    [append, app, busy, flushAssistant, handleEvent, options, snapshot],
  );

  // ─── Mouse routing — SGR events → toolbar / overlay geometry / scroll ──────
  // Plain closures (recreated per render) so they always see live state; the
  // useInput handler below re-subscribes every render anyway.
  const effortSurfaceActive = overlay === "effort" || (overlay === "settings" && settingsTab === SETTINGS_EFFORT_TAB);

  /** Set + dispatch an effort level through the host's real /reasoning path.
   *  Landing on MAX ignites THE ULTRA SURGE (motion-gated; static renders the
   *  settled badge). */
  const commitEffort = (idx: number) => {
    const clamped = Math.max(0, Math.min(SLIDER_LEVELS.length - 1, idx));
    setEffortLevel(clamped);
    effortKnown.current = true;
    if (clamped === SLIDER_LEVELS.length - 1 && MOTION) setSurgeTick(0);
    void submit(`/reasoning ${SLIDER_LEVELS[clamped]}`);
  };

  /** Row index → action for the models overlay. The row AFTER the last model
   *  is the "custom model id" row, which flips into text-input mode. */
  const selectModelRow = (idx: number) => {
    if (idx < 0 || idx > mpModels.length) return;
    setMpSel(idx);
    if (idx === mpModels.length) {
      setMpCustom("");
      return;
    }
    const m = mpModels[idx];
    if (!m) return;
    setOverlay(null);
    void submit(`/model ${PICKER_PROVIDERS[mpProvider]} ${m.id}`);
  };

  const openModelsOverlay = () => {
    setMpProvider(Math.max(0, PICKER_PROVIDERS.indexOf(snapshot.provider)));
    setMpSel(0);
    setOvScroll(0);
    setMpCustom(null);
    setOverlay("models");
  };

  const toolbarAction = (id: string) => {
    if (id === "models") {
      openModelsOverlay();
    } else if (id === "effort") {
      setOverlay("effort");
    } else if (id === "themes") {
      setSettingsTab(SETTINGS_APPEARANCE_TAB);
      setOvScroll(0);
      setOverlay("settings");
    } else if (id === "settings") {
      setSettingsTab(0);
      setOvScroll(0);
      setOverlay("settings");
    } else if (id === "ultra") {
      // The headline button: slam the dial to MAX and let the surge rip.
      setOverlay("effort");
      commitEffort(SLIDER_LEVELS.length - 1);
    }
  };

  /** Click/drag on the effort slider band (flame row → labels row): x maps to
   *  the nearest level stop; drags track live, release commits. */
  const effortMouse = (event: SgrMouseEvent, appRow: number) => {
    const inBand = appRow >= EFFORT_FLAME_ROW && appRow <= EFFORT_LABEL_ROW;
    const idx = sliderIndexAt(event.x, EFFORT_BAR_START, effortBarWidth);
    if (event.kind === "down" && inBand) {
      dragEffort.current = true;
      setEffortLevel(idx);
      return;
    }
    if (event.kind === "drag" && dragEffort.current) {
      setEffortLevel(idx);
      return;
    }
    if (event.kind === "up" && dragEffort.current) {
      dragEffort.current = false;
      commitEffort(idx);
    }
  };

  const handleMouseEvent = (event: SgrMouseEvent) => {
    const appRow = terminalRowToAppRow(event.y, rows, layout.screenHeight);
    if (overlay) {
      if (event.kind === "wheel-up" || event.kind === "wheel-down") {
        if (effortSurfaceActive) {
          // Wheel nudges the dial: up = hotter, down = cooler.
          const next = Math.max(0, Math.min(SLIDER_LEVELS.length - 1, effortLevel + (event.kind === "wheel-up" ? 1 : -1)));
          if (next !== effortLevel) commitEffort(next);
          return;
        }
        const total =
          overlay === "models"
            ? mpModels.length + 1
            : overlay === "settings" && settingsTab === SETTINGS_APPEARANCE_TAB
              ? availableThemes().length
              : 0;
        const maxScroll = Math.max(0, total - overlayCapacity);
        setOvScroll((s) => Math.max(0, Math.min(maxScroll, s + (event.kind === "wheel-down" ? 2 : -2))));
        return;
      }
      if (overlay === "models") {
        if (mpCustom != null || event.kind !== "down") return;
        const visible = Math.max(0, Math.min(overlayCapacity, mpModels.length + 1 - ovScroll));
        const hit = modalHitTest(event.x, appRow, PICKER_PROVIDERS, visible);
        if (!hit) return;
        if (hit.kind === "tab") {
          setMpProvider(hit.index);
          setMpSel(0);
          setOvScroll(0);
          return;
        }
        selectModelRow(ovScroll + hit.index);
        return;
      }
      if (overlay === "effort") {
        effortMouse(event, appRow);
        return;
      }
      // settings — tabs row first, then the active tab's surface.
      if (event.kind === "down" && appRow === MODAL_TAB_ROW) {
        const hit = modalHitTest(event.x, appRow, SETTINGS_TABS, 0);
        if (hit && hit.kind === "tab") {
          setSettingsTab(hit.index);
          setOvScroll(0);
        }
        return;
      }
      if (settingsTab === SETTINGS_EFFORT_TAB) {
        effortMouse(event, appRow);
        return;
      }
      if (settingsTab === SETTINGS_APPEARANCE_TAB && event.kind === "down") {
        const themes = availableThemes();
        const visible = Math.max(0, Math.min(overlayCapacity, themes.length - ovScroll));
        const hit = modalHitTest(event.x, appRow, SETTINGS_TABS, visible);
        if (hit && hit.kind === "item") {
          const name = themes[ovScroll + hit.index];
          if (name) void submit(`/theme ${name}`);
        }
        return;
      }
      if (settingsTab === SETTINGS_PROVIDERS_TAB && event.kind === "down" && keyCapture == null) {
        const hit = modalHitTest(event.x, appRow, SETTINGS_TABS, KEY_PROVIDERS.length);
        if (hit && hit.kind === "item") {
          const provider = KEY_PROVIDERS[hit.index];
          if (provider) setKeyCapture({ provider, value: "" });
        }
        return;
      }
      if (settingsTab === SETTINGS_MODELS_TAB && event.kind === "down") {
        // One row: jump to the full picker (same surface as ⌃O / toolbar).
        const hit = modalHitTest(event.x, appRow, SETTINGS_TABS, 1);
        if (hit && hit.kind === "item") openModelsOverlay();
        return;
      }
      return;
    }
    // Main view: wheel scrolls the stream, clicks land on the bottom toolbar.
    if (event.kind === "wheel-up") {
      scrollUp(Math.max(3, Math.floor(visibleLogRows / 2)));
      return;
    }
    if (event.kind === "wheel-down") {
      scrollDown(Math.max(3, Math.floor(visibleLogRows / 2)));
      return;
    }
    if (event.kind === "down") {
      // Permission card buttons (slate geometry: buttons row = screenH-6).
      if (permRef.current && process.env.ARES_TUI !== "classic") {
        const decision = permHitTest(event.x, appRow, layout.screenHeight);
        if (decision) {
          decidePermission(decision as "allow_once" | "allow_always" | "deny");
          return;
        }
      }
      // Slate header: the model chip (row 1, ` ARES  {model} ▾`) opens the picker.
      if (process.env.ARES_TUI !== "classic" && appRow === SLATE_HEADER_MODEL_ROW) {
        const span = slateModelSpan(snapshot.model);
        if (event.x >= span.start && event.x <= span.end) {
          toolbarAction("models");
          return;
        }
      }
      const id = toolbarHitTest(event.x, appRow, layout.screenHeight, layout.screenWidth);
      if (id) toolbarAction(id);
    }
  };

  useInput((value, key) => {
    // Explicit bracketed paste beats every other classifier — pasted text can
    // contain "<" runs that would otherwise read as mouse fragments.
    if (!busy && !paletteOpen && !overlay && !rsOpen && /\x1b?\[20[01]~/.test(value)) {
      setInput((prev) => prev + normalizeInputChunk(value).text);
      return;
    }
    const mouseEvents = parseSgrMouse(value);
    if (mouseEvents || isMouseFragment(value)) {
      for (const event of mouseEvents ?? []) handleMouseEvent(event);
      return;
    }
    if (value.includes("\u001b[<")) return;
    if (key.ctrl && value === "c") {
      app.exit(130);
      return;
    }
    // Permission card — the human's answer beats every other keybinding while
    // a tool waits. 1/y allow once · 2/a always · 3/n/esc deny.
    if (perm) {
      if (value === "1" || value === "y") {
        decidePermission("allow_once");
        return;
      }
      if (value === "2" || value === "a") {
        decidePermission("allow_always");
        return;
      }
      if (value === "3" || value === "n" || key.escape) {
        decidePermission("deny");
        return;
      }
      return; // swallow everything else — the card owns the keyboard
    }
    // ⌃P command palette — fuzzy command picker (the desktop has one; now so does this).
    if (paletteOpen) {
      if (key.escape || (key.ctrl && value === "p")) {
        setPaletteOpen(false);
        setInput("");
        return;
      }
      const filtered = filterPalette(input);
      if (key.upArrow) {
        setPaletteSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setPaletteSel((s) => Math.min(Math.max(0, filtered.length - 1), s + 1));
        return;
      }
      if (key.return) {
        const pick = filtered[Math.min(paletteSel, Math.max(0, filtered.length - 1))];
        setPaletteOpen(false);
        setInput("");
        if (pick) void submit(pick.cmd);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        setPaletteSel(0);
        return;
      }
      if (value && !key.ctrl && !key.meta) {
        setInput((prev) => prev + value.replace(/\r?\n/g, ""));
        setPaletteSel(0);
      }
      return;
    }
    if (key.ctrl && value === "p" && !overlay) {
      setPaletteOpen(true);
      setPaletteSel(0);
      setInput("");
      return;
    }
    // Fullscreen overlays — number keys 1-9/a-z select, Tab cycles tabs, Esc
    // closes, Enter confirms. Arrows are SUPPORTED but never required (the
    // owner's device has none). Everything here is also mouse-clickable.
    if (overlay) {
      // "Custom model id" text capture beats every other key.
      if (overlay === "settings" && keyCapture != null) {
        // Masked API-key entry: typed/pasted chars accumulate hidden; Enter
        // dispatches the SAME /key command the composer accepts, Esc bails.
        if (key.escape) {
          setKeyCapture(null);
          return;
        }
        if (key.return) {
          const { provider, value } = keyCapture;
          setKeyCapture(null);
          const trimmed = value.trim();
          if (trimmed) void submit(`/key ${provider} ${trimmed}`);
          return;
        }
        if (key.backspace || key.delete) {
          setKeyCapture((c) => (c ? { ...c, value: c.value.slice(0, -1) } : c));
          return;
        }
        if (value && !key.ctrl && !key.meta && !key.tab) {
          const clean = normalizeInputChunk(value).text.replace(/[\r\n\t ]/g, "");
          setKeyCapture((c) => (c ? { ...c, value: c.value + clean } : c));
        }
        return;
      }
      if (overlay === "models" && mpCustom != null) {
        if (key.escape) {
          setMpCustom(null);
          return;
        }
        if (key.return) {
          const id = mpCustom.trim();
          setMpCustom(null);
          if (id) {
            setOverlay(null);
            void submit(`/model ${PICKER_PROVIDERS[mpProvider]} ${id}`);
          }
          return;
        }
        if (key.backspace || key.delete) {
          setMpCustom((c) => (c ?? "").slice(0, -1));
          return;
        }
        if (value && !key.ctrl && !key.meta && !key.tab) {
          // normalizeInputChunk strips bracketed-paste markers so a pasted
          // model id lands clean; ids are single-line, so newlines drop too.
          setMpCustom((c) => (c ?? "") + normalizeInputChunk(value).text.replace(/[\r\n\t]/g, ""));
        }
        return;
      }
      if (key.escape || (key.ctrl && value === "o")) {
        setOverlay(null);
        setSurgeTick(null);
        dragEffort.current = false;
        return;
      }
      if (key.tab) {
        if (overlay === "models") {
          setMpProvider((p) => (p + 1) % PICKER_PROVIDERS.length);
          setMpSel(0);
          setOvScroll(0);
        } else if (overlay === "settings") {
          setSettingsTab((t) => (t + 1) % SETTINGS_TABS.length);
          setOvScroll(0);
        }
        return;
      }
      if (effortSurfaceActive) {
        // The dial: 1-5 = off·low·medium·high·MAX. ←→ nudge if present.
        if (/^[1-5]$/.test(value)) {
          commitEffort(Number(value) - 1);
          return;
        }
        if (key.leftArrow) {
          commitEffort(effortLevel - 1);
          return;
        }
        if (key.rightArrow) {
          commitEffort(effortLevel + 1);
          return;
        }
        if (key.return) {
          setOverlay(null);
          return;
        }
        return;
      }
      if (overlay === "models") {
        if (key.leftArrow) {
          setMpProvider((p) => (p - 1 + PICKER_PROVIDERS.length) % PICKER_PROVIDERS.length);
          setMpSel(0);
          setOvScroll(0);
          return;
        }
        if (key.rightArrow) {
          setMpProvider((p) => (p + 1) % PICKER_PROVIDERS.length);
          setMpSel(0);
          setOvScroll(0);
          return;
        }
        if (key.upArrow || key.downArrow) {
          const total = mpModels.length + 1; // + custom-id row
          const next = key.upArrow ? Math.max(0, mpSel - 1) : Math.min(total - 1, mpSel + 1);
          setMpSel(next);
          // Keep the selection visible: follow it past either window edge.
          setOvScroll((sc) => (next < sc ? next : next >= sc + overlayCapacity ? next - overlayCapacity + 1 : sc));
          return;
        }
        if (key.return) {
          selectModelRow(mpSel);
          return;
        }
        const ki = indexForKey(value);
        if (ki != null && ki <= mpModels.length) selectModelRow(ki);
        return;
      }
      // settings — Appearance items select by number key (Effort handled above).
      if (settingsTab === SETTINGS_APPEARANCE_TAB) {
        const ki = indexForKey(value);
        if (ki != null) {
          const name = availableThemes()[ki];
          if (name) void submit(`/theme ${name}`);
        }
        return;
      }
      if (settingsTab === SETTINGS_PROVIDERS_TAB) {
        const ki = indexForKey(value);
        const provider = ki != null ? KEY_PROVIDERS[ki] : undefined;
        if (provider) setKeyCapture({ provider, value: "" });
        return;
      }
      if (settingsTab === SETTINGS_MODELS_TAB && (key.return || indexForKey(value) === 0)) {
        openModelsOverlay();
        return;
      }
      return;
    }
    if (key.ctrl && value === "o") {
      openModelsOverlay();
      return;
    }
    if (key.ctrl && value === "l") {
      setLines([]);
      setScrollOffset(0);
      return;
    }
    if (key.pageUp) {
      scrollUp();
      return;
    }
    if (key.pageDown) {
      scrollDown();
      return;
    }
    if (key.home) {
      setScrollOffset(maxScrollOffset);
      return;
    }
    if (key.end) {
      setScrollOffset(0);
      return;
    }
    if (!input && value === "!") {
      void submit("/danger");
      return;
    }
    if (!input && value === "[") {
      scrollUp(Math.max(3, Math.floor(visibleLogRows / 2)));
      return;
    }
    if (!input && value === "]") {
      scrollDown(Math.max(3, Math.floor(visibleLogRows / 2)));
      return;
    }
    if (busy) return;
    // Ctrl+R reverse-search over history — live match preview; Ctrl+R again
    // cycles older matches, enter accepts, esc cancels.
    if (rsOpen) {
      if (key.escape) {
        setRsOpen(false);
        return;
      }
      if (key.ctrl && value === "r") {
        setRsSkip((s) => s + 1);
        return;
      }
      if (key.return || key.tab) {
        const match = searchHistory(history.current, rsQuery, rsSkip);
        setRsOpen(false);
        if (match) setInput(match.text);
        return;
      }
      if (key.backspace || key.delete) {
        setRsQuery((q) => q.slice(0, -1));
        setRsSkip(0);
        return;
      }
      if (value && !key.ctrl && !key.meta) {
        setRsQuery((q) => q + value.replace(/[\r\n]/g, ""));
        setRsSkip(0);
      }
      return;
    }
    if (key.ctrl && value === "r") {
      setRsOpen(true);
      setRsQuery("");
      setRsSkip(0);
      return;
    }
    // Bracketed paste / multi-line chunk — becomes ONE buffered multi-line
    // input, verbatim. Never submits.
    {
      const chunk = normalizeInputChunk(value);
      if (chunk.paste) {
        setInput((prev) => prev + chunk.text);
        return;
      }
    }
    // Ctrl+J (raw \n) inserts a newline for multi-line composing.
    if ((key.ctrl && value === "j") || value === "\n") {
      setInput((prev) => prev + "\n");
      return;
    }
    if (key.return) {
      // Trailing "\" continues onto the next line instead of submitting.
      if (endsWithContinuation(input)) {
        setInput(stripContinuation(input) + "\n");
        return;
      }
      void submit(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl && value === "u") {
      setInput("");
      return;
    }
    if (key.upArrow) {
      if (history.current.length === 0) return;
      const next = historyIndex.current === null ? history.current.length - 1 : Math.max(0, historyIndex.current - 1);
      historyIndex.current = next;
      setInput(history.current[next] ?? "");
      return;
    }
    if (key.downArrow) {
      if (historyIndex.current === null) return;
      const next = historyIndex.current + 1;
      if (next >= history.current.length) {
        historyIndex.current = null;
        setInput("");
      } else {
        historyIndex.current = next;
        setInput(history.current[next] ?? "");
      }
      return;
    }
    if (key.escape) {
      setInput("");
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      setInput((prev) => prev + value.replace(/\r?\n/g, ""));
    }
  });

  const displayLines = assistantDraft
    ? [...lines, { id: -1, tone: "assistant" as const, text: assistantDraft, meta: "stream" }]
    : lines;
  const bottom = Math.max(0, displayLines.length - scrollOffset);
  const start = Math.max(0, bottom - visibleLogRows);
  const visibleLines = displayLines.slice(start, bottom);

  // A modal REPLACES the main view — fullscreen, anchored at app row 1 — so
  // every row matches the tuiChrome hit-test geometry exactly.
  if (overlay) {
    return h(OverlayView, {
      theme,
      overlay,
      width: layout.screenWidth,
      height: layout.screenHeight,
      providerIdx: mpProvider,
      models: mpModels,
      sel: mpSel,
      loading: mpLoading,
      custom: mpCustom,
      scroll: ovScroll,
      capacity: overlayCapacity,
      settingsTab,
      keyCapture,
      settingsInfo,
      effortLevel,
      surgeTick,
      pulseTick,
      barWidth: effortBarWidth,
    });
  }

  // ── Slate rebuild (now the DEFAULT; ARES_TUI=classic opts out) ────────────
  // Renders the new ground-up main screen. Overlays (model picker/settings) fall
  // through to the classic modal path below for now.
  if (process.env.ARES_TUI !== "classic") {
    const slateLines = visibleLines.map((l) => {
      const isTool = l.tone === "tool";
      const running = isTool && l.startedAt != null && !l.result;
      const resultText = l.result?.text ?? "";
      const resultLines = resultText.split("\n").filter((s) => s.trim().length > 0);
      // Done tool cards show the first result line as the head; the next few
      // lines become the dim preview so rich outputs (weather, test runs) keep
      // their substance without flooding the stream.
      const extra = resultLines.slice(1, 5).map((s) => s.trim().slice(0, 160));
      if (resultLines.length > 5) extra.push(`… +${resultLines.length - 5} more lines`);
      const mapped = mapTone(l.tone);
      return {
        tone: mapped,
        text: isTool ? (running ? l.text : resultLines[0] ?? l.text) : l.text,
        name: isTool ? l.meta || l.text.split(/\s+/)[0] : undefined,
        ok: l.result?.ok,
        running,
        elapsed:
          running && l.startedAt != null
            ? formatDuration(Date.now() - l.startedAt)
            : l.result?.durationMs
              ? formatDuration(l.result.durationMs)
              : undefined,
        preview: !running && extra.length > 0 ? extra : undefined,
        stream: l.meta === "stream",
        md: l.tone === "assistant",
      };
    });
    const slateFleet =
      fleet && fleet.active && fleet.agents.length > 0
        ? {
            summary: fleetSummary(fleet),
            rows: foldFleetRows(fleet.agents, 8).shown.map((a, i, arr) => ({
              glyph: fleetGlyph(a.status),
              name: a.agentId,
              activity: a.activity || a.phase || a.role || a.status,
              last: i === arr.length - 1,
            })),
          }
        : undefined;
    return h(ChatMain, {
      snapshot: { model: snapshot.model, workspace: snapshot.workspace, mode: snapshot.mode },
      lines: slateLines,
      stats: {
        msgs: stats.turns,
        tokens: stats.usage.inputTokens + stats.usage.outputTokens,
        total: stats.durationMs > 0 ? stats.durationMs / 1000 : undefined,
        turnElapsed: busy && turnStartedAt.current != null ? (Date.now() - turnStartedAt.current) / 1000 : undefined,
        tools: stats.tools,
        agents: fleet?.agents?.length,
      },
      busy,
      tick: spin,
      input,
      thinking: busy,
      thinkingTokens: activity === "thinking" && thinkingChars.current > 0 ? Math.round(thinkingChars.current / 4) : undefined,
      currentTool: activity && activity !== "responding" && activity !== "thinking" ? activity : undefined,
      fleet: slateFleet,
      scrolled: scrollOffset,
      todosNode: todos.length > 0 ? h(TodoStrip, { theme: SLATE, todos, width: layout.screenWidth }) : undefined,
      paletteNode: paletteOpen ? h(CommandPalette, { theme, query: input, selected: paletteSel, width: layout.screenWidth }) : undefined,
      permNode: perm
        ? h(PermissionCard, { theme: SLATE, toolName: perm.toolName, reason: perm.reason, suggestion: perm.suggestion, tick: spin, width: layout.screenWidth })
        : undefined,
      themeName: "slate",
      version: process.env.npm_package_version ?? "",
      width: layout.screenWidth,
      height: layout.screenHeight,
    });
  }

  return h(
    Box,
    { flexDirection: "column", width: layout.screenWidth, height: layout.screenHeight },
    h(Header, { snapshot, stats, theme, width: layout.screenWidth, tick: spin, busy }),
    h(LogPanel, {
      theme,
      lines: visibleLines,
      totalLines: displayLines.length,
      start,
      scrollOffset,
      spinner: busy ? frame : "",
      width: layout.screenWidth,
      height: layout.mainHeight,
    }),
    todos.length > 0 ? h(TodosStrip, { theme, todos }) : null,
    fleet && fleet.active ? h(FleetPanel, { theme, fleet, spinner: busy ? frame : "⚔", width: layout.screenWidth }) : null,
    pulses.length > 0 ? h(EvolutionPulses, { theme, pulses, width: layout.screenWidth }) : null,
    paletteOpen ? h(CommandPalette, { theme, query: input, selected: paletteSel, width: layout.screenWidth }) : null,
    // Flex spacer: pins the bottom cluster (status → input → toolbar) to the
    // frame's true bottom, so the toolbar row = screenHeight for hit-testing.
    h(Box, { flexGrow: 1 }),
    perm
      ? h(PermissionCard, { theme: SLATE, toolName: perm.toolName, reason: perm.reason, suggestion: perm.suggestion, tick: spin, width: layout.screenWidth })
      : null,
    h(StatusBar, { theme, snapshot, stats, busy, width: layout.screenWidth }),
    h(InputDeck, {
      theme,
      snapshot,
      busy,
      activity,
      spinner: busy ? frame : "",
      tick: spin,
      input,
      rsearch: rsOpen ? { query: rsQuery, match: searchHistory(history.current, rsQuery, rsSkip)?.text ?? null } : null,
      stats,
      width: layout.screenWidth,
    }),
    h(Toolbar, { theme, width: layout.screenWidth }),
  );
}

function Header({ snapshot, stats, theme, width, tick, busy }: { snapshot: InkChatSnapshot; stats: RuntimeStats; theme: DeckTheme; width: number; tick: number; busy: boolean }) {
  void stats;
  const model = compactModel(snapshot.model, 30);
  const folder = snapshot.workspace.split(/[\\/]/).filter(Boolean).pop() ?? snapshot.workspace;
  const palette = fxPaletteFrom(theme);
  // A living flame divider under the header — burns hot while a turn streams,
  // idles as low coals otherwise (motion-gated: static coals when off).
  const flame = motionEnabled()
    ? flameLine(busy ? tick : Math.floor(tick / 3), Math.max(1, width - 2), palette)
    : flameLine(0, Math.max(1, width - 2), { ...palette, ember: palette.dim, gold: palette.steel });
  // One slim line — no border, no chip boxes. The conversation is the page.
  return h(
    Box,
    { flexDirection: "column", width },
    h(
      Box,
      { width, justifyContent: "space-between", paddingX: 1 },
      h(
        Box,
        { gap: 1 },
        h(Text, { color: theme.accent3, bold: true }, "⚔"),
        h(Text, { color: theme.accent, bold: true }, "ARES"),
        h(Text, { color: theme.dim }, model),
      ),
      h(
        Box,
        { gap: 1 },
        h(Text, { color: theme.dim }, folder),
        h(Text, { color: theme.dim }, "·"),
        h(Text, { color: theme.accent2 }, theme.title.toLowerCase()),
      ),
    ),
    h(Box, { width, paddingX: 1, marginBottom: 1 }, ...fxSpans(flame, "hdrflame")),
  );
}

function LogPanel({
  theme,
  lines,
  totalLines,
  start,
  scrollOffset,
  spinner,
  width,
  height,
}: {
  theme: DeckTheme;
  lines: LogLine[];
  totalLines: number;
  start: number;
  scrollOffset: number;
  spinner: string;
  width: number;
  height: number;
}) {
  // Clean full-bleed conversation stream — no panel chrome. A subtle scroll
  // indicator appears only when the user has scrolled up.
  return h(
    Box,
    { flexDirection: "column", width, height, flexShrink: 1, paddingX: 1 },
    scrollOffset > 0
      ? h(
          Box,
          { justifyContent: "flex-end" },
          h(Text, { color: theme.warn }, `▴ ${start + 1}-${start + lines.length}/${totalLines} · End ↓`),
        )
      : null,
    lines.length === 0
      ? h(EmptyState, { theme })
      : lines.map((line) => h(LogText, { key: line.id, line, theme, spinner })),
  );
}

function EmptyState({ theme }: { theme: DeckTheme }) {
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { color: theme.accent3, bold: true }, "▲ Ares stands ready."),
    h(Text, { color: theme.dim }, "Speak, and it moves — files, shell, web, the whole arsenal."),
    h(Text, { color: theme.dim }, "⌃P commands · ⌃O models (or /model) · click the toolbar below · /help for the full loadout."),
  );
}

// Desktop-parity telemetry strip. Left: a live context-window fuel gauge (the
// exe's headline meter) that shifts calm→amber→crimson as the window fills.
// Right: tokens · cost · cache · elapsed · tools — the numbers the desktop shows.
// Rendered as its own band above the composer so the readout is always visible,
// not buried in a one-line status like before.
function StatusBar({
  theme,
  snapshot,
  stats,
  busy,
  width,
}: {
  theme: DeckTheme;
  snapshot: InkChatSnapshot;
  stats: RuntimeStats;
  busy: boolean;
  width: number;
}) {
  const target = contextFillPercent(stats.usage, snapshot.model);
  // The gauge eases toward its target instead of jumping — a short lerp loop
  // that self-stops once settled. Plain fallback: snap straight to target.
  const [eased, setEased] = useState(target);
  useEffect(() => {
    if (!MOTION) {
      setEased(target);
      return;
    }
    const id = setInterval(() => {
      setEased((prev) => {
        const next = easeToward(prev, target);
        if (next === target) clearInterval(id);
        return next;
      });
    }, 80);
    return () => clearInterval(id);
  }, [target]);
  const fill = Math.round(eased);
  const fc = fillColor(fill, theme);
  const gaugeW = width < 70 ? 8 : 14;
  const tokens = compactNumber(stats.usage.inputTokens + stats.usage.outputTokens);
  const cost = formatCost(stats.usage);
  const cache = cachePercent(stats.usage);
  const elapsed = `${Math.round(stats.durationMs / 1000)}s`;
  // Health dot: crimson while a turn is in flight, calm success when idle+clean,
  // amber if the session has logged errors.
  const dotColor = busy ? theme.warn : stats.errors > 0 ? theme.error : theme.success;
  const sep = () => h(Text, { color: theme.dim }, "·");
  return h(
    Box,
    { flexDirection: "column", width, marginTop: 1 },
    h(Text, { color: theme.frame }, "─".repeat(Math.max(0, width - 2))),
    h(
      Box,
      { width, justifyContent: "space-between", paddingX: 1 },
      // Left cluster: context fuel gauge.
      h(
        Box,
        { gap: 1, flexShrink: 1 },
        h(Text, { color: dotColor, bold: true }, "●"),
        h(Text, { color: theme.dim }, "ctx"),
        h(Text, { color: fc }, fillBar(fill, gaugeW)),
        h(Text, { color: fc, bold: true }, `${fill}%`),
      ),
      // Right cluster: the usage numbers the desktop surfaces.
      h(
        Box,
        { gap: 1 },
        h(Text, { color: theme.text }, `${tokens} tok`),
        sep(),
        h(Text, { color: cost === "$n/a" ? theme.dim : theme.success, bold: cost !== "$n/a" }, cost),
        sep(),
        h(Text, { color: theme.accent3 }, `${cache} cache`),
        sep(),
        h(Text, { color: theme.accent2 }, elapsed),
        sep(),
        h(Text, { color: theme.tool }, `${stats.tools}⚒`),
      ),
    ),
  );
}

function InputDeck({
  theme,
  snapshot,
  busy,
  activity,
  spinner,
  tick,
  input,
  rsearch,
  stats,
  width,
}: {
  theme: DeckTheme;
  snapshot: InkChatSnapshot;
  busy: boolean;
  activity: string | null;
  spinner: string;
  tick: number;
  input: string;
  rsearch: { query: string; match: string | null } | null;
  stats: RuntimeStats;
  width: number;
}) {
  void stats;
  const plan = snapshot.mode === "plan";
  const danger = snapshot.mode === "bypass";
  const promptTag = plan ? "❯ [plan] " : danger ? "❯ [!] " : "❯ ";
  const promptColor = danger ? theme.error : theme.accent;
  // Multi-line composing: first row carries the prompt + status; continuation
  // rows render behind a `… ` gutter (trailing "\" or ⌃J adds lines).
  const inputLines = input.split("\n");
  const first = inputLines[0] ?? "";
  const rest = inputLines.slice(1);
  const label = activity ?? "working";
  // Streaming shimmer: a bright band sweeps the activity label while tokens
  // stream; plain fallback renders static amber text.
  const statusNode = busy
    ? h(
        Box,
        null,
        h(Text, { color: theme.accent3, bold: true }, `${spinner || "▲"} `),
        ...(MOTION
          ? shimmerSpans(label, tick).map((s, i) =>
              h(Text, { key: i, color: s.hot ? theme.accent2 : theme.dim, bold: s.hot }, s.text),
            )
          : [h(Text, { key: 0, color: theme.warn }, label)]),
      )
    : h(Text, { color: theme.dim }, `${snapshot.mode} · ⌃P palette`);
  return h(
    Box,
    { flexDirection: "column", width },
    h(
      Box,
      { justifyContent: "space-between", paddingX: 1 },
      h(
        Box,
        { flexShrink: 1 },
        h(Text, { color: promptColor, bold: true }, promptTag),
        h(Text, { color: input.length > 0 ? theme.text : theme.dim, wrap: "truncate" }, input.length > 0 ? first : "message ares"),
        // Molten caret: a slow ember/gold breathing block at the ready prompt.
        busy || rest.length > 0
          ? null
          : MOTION
            ? (() => {
                const c = moltenCursor(tick, fxPaletteFrom(theme));
                return h(Text, { color: c.color, bold: c.bold, dimColor: c.dim }, c.text);
              })()
            : h(Text, { color: theme.accent, bold: true }, "▏"),
      ),
      statusNode,
    ),
    ...rest.map((line, i) =>
      h(
        Box,
        { key: i, paddingX: 1 },
        h(Text, { color: theme.dim }, "… "),
        h(Text, { color: theme.text, wrap: "truncate" }, line),
        !busy && i === rest.length - 1 ? h(Text, { color: theme.accent, bold: true }, "▏") : null,
      ),
    ),
    rsearch
      ? h(
          Box,
          { paddingX: 1 },
          h(Text, { color: theme.accent2, bold: true }, "(reverse-i-search) "),
          h(Text, { color: theme.text }, `'${rsearch.query}'`),
          h(Text, { color: theme.dim }, ": "),
          rsearch.match
            ? h(Text, { color: theme.accent, wrap: "truncate" }, rsearch.match)
            : h(Text, { color: theme.dim, italic: true }, rsearch.query ? "no match" : "type to search · ⌃R next · enter accept"),
        )
      : null,
  );
}

// ─── Bottom toolbar — the always-visible click bar ───────────────────────────
// One row pinned to the frame's bottom: ⚔ Models ▾ · 🔥 Effort · 🎨 Themes ·
// ⚙ Settings · ✦ Ultra. Rendered as one Text per label so the column spans
// match toolbarButtons() exactly (separators are dead zones on purpose).
function Toolbar({ theme, width }: { theme: DeckTheme; width: number }) {
  const colors: Record<string, string> = {
    models: theme.accent,
    effort: theme.warn,
    themes: theme.accent2,
    settings: theme.text,
    ultra: theme.accent3,
  };
  return h(
    Box,
    { width, paddingX: 1 },
    ...TOOLBAR_ITEMS.flatMap((item, i) => [
      i > 0 ? h(Text, { key: `sep-${item.id}`, color: theme.dim }, CHROME_SEPARATOR) : null,
      h(Text, { key: item.id, color: colors[item.id] ?? theme.text, bold: item.id === "ultra" }, item.label),
    ]),
  );
}

// ─── Fullscreen overlays ─────────────────────────────────────────────────────
// A modal replaces the main view and anchors at app row 1 with NO borders
// (borders would shift every row), so the geometry is exactly what
// modalHitTest() assumes: row 1 title · row 2 tabs · row 3 hint · rows 4… body.

interface OverlayProps {
  theme: DeckTheme;
  overlay: "models" | "effort" | "settings";
  width: number;
  height: number;
  providerIdx: number;
  models: Array<{ id: string; label?: string; hint?: string }>;
  sel: number;
  loading: boolean;
  custom: string | null;
  scroll: number;
  capacity: number;
  settingsTab: number;
  keyCapture: { provider: string; value: string } | null;
  settingsInfo: string[];
  effortLevel: number;
  surgeTick: number | null;
  pulseTick: number;
  barWidth: number;
}

function OverlayView(p: OverlayProps) {
  const { theme } = p;
  const tokens = sliderTokensFrom(theme);
  // The surge sweeps (nearly) the full modal width, not just the bar.
  const surge = p.surgeTick != null ? surgeFrame(p.surgeTick, Math.max(10, p.width - 4), tokens) : null;
  const surging = surge != null && !surge.done;
  const title = p.overlay === "models" ? "⚔ MODELS" : p.overlay === "effort" ? "🔥 EFFORT" : "⚙ SETTINGS";
  // Title jitter: ±1 column while the surge runs; a steady 1-space indent idle.
  const titlePad = " ".repeat(Math.max(0, 1 + (surging ? surge.titleOffset : 0)));
  const tabs = p.overlay === "models" ? PICKER_PROVIDERS : p.overlay === "settings" ? SETTINGS_TABS : [];
  const activeTab = p.overlay === "models" ? p.providerIdx : p.overlay === "settings" ? p.settingsTab : -1;
  const provider = PICKER_PROVIDERS[p.providerIdx];
  const hint =
    p.overlay === "models"
      ? p.loading
        ? `loading ${provider}…`
        : p.models.length === 0
          ? `no models for ${provider} — check key / connection`
          : `${p.models.length} models · ${provider}`
      : p.overlay === "effort"
        ? "slide right. burn hotter."
        : SETTINGS_TABS[p.settingsTab] === "Appearance"
          ? "click a theme — it applies live"
          : `settings · ${SETTINGS_TABS[p.settingsTab].toLowerCase()}`;
  const footer =
    p.overlay === "models"
      ? "click / 1-9 a-z select · tab provider · enter confirm · wheel scroll · esc close"
      : p.overlay === "effort"
        ? "click or drag the bar · 1-5 levels · wheel nudge · esc close"
        : "click a tab (or Tab to cycle) · number keys select · esc close";
  const body =
    p.overlay === "models"
      ? modelsOverlayBody(p)
      : p.overlay === "effort"
        ? effortBody(p, tokens, surge)
        : settingsBody(p, tokens, surge);
  return h(
    Box,
    { flexDirection: "column", width: p.width, height: p.height },
    // row 1 — title (strobe-colored + jittering during THE ULTRA SURGE)
    h(
      Box,
      { paddingX: 1, justifyContent: "space-between" },
      h(Text, { color: surging ? surge.color : theme.accent, bold: true }, `${titlePad}${title}`),
      h(Text, { color: theme.dim }, "esc close"),
    ),
    // row 2 — clickable tabs (kept even when empty so body rows stay put)
    h(
      Box,
      { paddingX: 1 },
      tabs.length === 0
        ? h(Text, { color: theme.dim }, "reasoning dial")
        : h(
            Text,
            {},
            ...tabs.flatMap((tab, i) => [
              i > 0 ? h(Text, { key: `s${i}`, color: theme.dim }, CHROME_SEPARATOR) : null,
              // Highlight via color/bold/underline ONLY — width must not change
              // or the modalTabSpans hit-test drifts.
              h(Text, { key: tab, color: i === activeTab ? theme.accent2 : theme.dim, bold: i === activeTab, underline: i === activeTab }, tab),
            ]),
          ),
    ),
    // row 3 — hint
    h(Box, { paddingX: 1 }, h(Text, { color: theme.dim, wrap: "truncate" }, hint)),
    // rows 4… — body (each entry is exactly ONE terminal row)
    ...body,
    h(Box, { flexGrow: 1 }),
    h(Box, { paddingX: 1 }, h(Text, { color: theme.dim, wrap: "truncate" }, footer)),
  );
}

// Models overlay body: one row per model (windowed by scroll/capacity), each
// prefixed with its selection key; the final row opens the custom-id input.
function modelsOverlayBody(p: OverlayProps): React.ReactNode[] {
  const { theme } = p;
  if (p.custom != null) {
    return [
      h(
        Box,
        { key: "custom", paddingX: 1 },
        h(Text, { color: theme.accent2, bold: true }, "◇ custom model id: "),
        h(Text, { color: theme.text }, p.custom),
        h(Text, { color: theme.accent, bold: true }, "▏"),
        h(Text, { color: theme.dim }, "  (enter apply · esc back)"),
      ),
    ];
  }
  const items = p.models.map((m, i) => ({ abs: i, label: m.label ?? m.id, hint: m.hint ?? m.id, custom: false }));
  items.push({ abs: p.models.length, label: "◇ custom model id…", hint: "type any id", custom: true });
  const shown = items.slice(p.scroll, p.scroll + p.capacity);
  return shown.map((item) => {
    const active = item.abs === p.sel;
    const keyGlyph = keyForIndex(item.abs) ?? "·";
    return h(
      Box,
      { key: item.abs, paddingX: 1, justifyContent: "space-between" },
      h(
        Text,
        { color: item.custom ? theme.accent3 : active ? theme.accent2 : theme.text, bold: active, wrap: "truncate" },
        `${active ? "▸" : " "}${keyGlyph} ${item.label}`,
      ),
      h(Text, { color: theme.dim, wrap: "truncate" }, item.hint),
    );
  });
}

// The effort dial — the centerpiece. Four fixed rows (flames / bar / level
// labels / status-badge) whose app rows match EFFORT_FLAME_ROW…EFFORT_LABEL_ROW
// for click/drag mapping. During THE ULTRA SURGE the first three rows are
// replaced by the strobing wave.
function effortBody(p: OverlayProps, tokens: SliderTokens, surge: ReturnType<typeof surgeFrame> | null): React.ReactNode[] {
  const { theme } = p;
  if (surge && !surge.done) {
    return [
      h(Box, { key: "sa", paddingX: 1 }, h(Text, { color: surge.color, wrap: "truncate" }, surge.above)),
      h(Box, { key: "sb", paddingX: 1 }, h(Text, { color: surge.color, bold: true, wrap: "truncate" }, surge.bar)),
      h(Box, { key: "sc", paddingX: 1 }, h(Text, { color: surge.color, wrap: "truncate" }, surge.below)),
      h(Box, { key: "sd", paddingX: 1 }, h(Text, { color: tokens.gold, bold: true }, "⇪ MAXIMUM EFFORT")),
    ];
  }
  const level = p.effortLevel;
  const isMax = level === SLIDER_LEVELS.length - 1;
  const flames = sliderFlameRow(level, p.barWidth);
  const spans = sliderSpans(level, p.barWidth, tokens);
  // Static fallback renders the settled gold badge (tick 1); motion breathes.
  const badge = ultraBadgeFrame(MOTION ? p.pulseTick : 1, tokens);
  const barIndent = " ".repeat(EFFORT_BAR_START - CHROME_START_COL); // aligns flames/labels with the bar
  return [
    // flames accumulate above the filled span as the dial climbs
    h(Box, { key: "flames", paddingX: 1 }, h(Text, { color: tokens.ember, wrap: "truncate" }, `${barIndent}${flames || " "}`)),
    // the bar itself: 🔥 ────●────── ULTRA
    h(
      Box,
      { key: "bar", paddingX: 1 },
      h(Text, {}, "🔥 "),
      ...spans.map((s, i) => h(Text, { key: i, color: s.color, bold: s.bold }, s.text)),
      h(Text, { color: isMax ? tokens.gold : theme.dim, bold: isMax }, " ULTRA"),
    ),
    // numbered level labels (1-5 are live keys)
    h(
      Box,
      { key: "labels", paddingX: 1 },
      h(Text, {}, barIndent),
      ...SLIDER_LEVELS.flatMap((name, i) => [
        i > 0 ? h(Text, { key: `g${i}`, color: theme.dim }, "  ") : null,
        h(
          Text,
          { key: name, color: i === level ? sliderFillColor(i, tokens) : theme.dim, bold: i === level },
          `${i + 1} ${i === SLIDER_LEVELS.length - 1 ? "MAX" : name}`,
        ),
      ]),
    ),
    // status row: the persistent pulsing ULTRA badge at MAX, else the dispatch preview
    h(
      Box,
      { key: "status", paddingX: 1 },
      h(Text, {}, barIndent),
      isMax
        ? h(Text, { color: badge.color, bold: true }, badge.text)
        : h(Text, { color: theme.dim }, `dispatches /reasoning ${SLIDER_LEVELS[level]}`),
    ),
  ];
}

// Settings overlay body, per tab. Appearance + Effort are live; the rest are
// structured placeholders with the tab plumbing (click/Tab/hit-test) ready.
function settingsBody(p: OverlayProps, tokens: SliderTokens, surge: ReturnType<typeof surgeFrame> | null): React.ReactNode[] {
  const { theme } = p;
  if (p.settingsTab === SETTINGS_EFFORT_TAB) return effortBody(p, tokens, surge);
  if (p.settingsTab === SETTINGS_APPEARANCE_TAB) {
    const themes = availableThemes();
    const current = currentThemeName();
    const shown = themes.slice(p.scroll, p.scroll + p.capacity);
    return shown.map((name, i) => {
      const abs = p.scroll + i;
      const active = name === current;
      return h(
        Box,
        { key: name, paddingX: 1, justifyContent: "space-between" },
        h(Text, { color: active ? theme.accent2 : theme.text, bold: active, wrap: "truncate" }, `${active ? "✓" : " "}${keyForIndex(abs) ?? "·"} ${name}`),
        h(Text, { color: theme.dim, wrap: "truncate" }, DECK_THEMES[name]?.title.toLowerCase() ?? ""),
      );
    });
  }
  if (p.settingsTab === SETTINGS_PROVIDERS_TAB) {
    // Masked key entry replaces the list while typing — same rhythm as the
    // custom-model capture, but the value renders as dots, never plaintext.
    if (p.keyCapture) {
      const dots = "•".repeat(Math.min(48, p.keyCapture.value.length)) || " ";
      return [
        h(Box, { key: "kc1", paddingX: 1 }, h(Text, { color: theme.accent2, bold: true }, `${p.keyCapture.provider} API key`)),
        h(Box, { key: "kc2", paddingX: 1 }, h(Text, { color: theme.text }, `▸ ${dots}▌`)),
        h(Box, { key: "kc3", paddingX: 1 }, h(Text, { color: theme.dim }, "paste or type · Enter saves · Esc cancels — stored encrypted, shown never")),
      ];
    }
    const rows = KEY_PROVIDERS.map((name, i) =>
      h(
        Box,
        { key: name, paddingX: 1, justifyContent: "space-between" },
        h(Text, { color: theme.text, wrap: "truncate" }, `${keyForIndex(i) ?? "·"} ${name}`),
        h(Text, { color: theme.dim }, "set key ▸"),
      ),
    );
    const info = p.settingsInfo.slice(0, Math.max(0, p.capacity - KEY_PROVIDERS.length - 1)).map((line, i) =>
      h(Box, { key: `ki${i}`, paddingX: 1 }, h(Text, { color: theme.dim, wrap: "truncate" }, line)),
    );
    return [...rows, h(Box, { key: "ksp", paddingX: 1 }, h(Text, { color: theme.dim }, "─".repeat(24))), ...info];
  }
  if (p.settingsTab === SETTINGS_MODELS_TAB) {
    return [
      h(Box, { key: "m1", paddingX: 1 }, h(Text, { color: theme.text }, `${keyForIndex(0) ?? "·"} Open the full model picker ⏎`)),
      h(Box, { key: "m2", paddingX: 1 }, h(Text, { color: theme.dim }, "provider tabs · live catalogs · custom ids — also ⌃O or ⚔ Models in the toolbar")),
    ];
  }
  // Engine tab: the live /settings snapshot, read-only — the knobs themselves
  // are daemon-side; visibility parity now, editing lands with the daemon UI.
  const engineInfo = p.settingsInfo.slice(0, Math.max(2, p.capacity - 1)).map((line, i) =>
    h(Box, { key: `e${i}`, paddingX: 1 }, h(Text, { color: i === 0 ? theme.text : theme.dim, wrap: "truncate" }, line)),
  );
  return engineInfo.length
    ? engineInfo
    : [h(Box, { key: "e0", paddingX: 1 }, h(Text, { color: theme.dim }, "loading engine settings…"))];
}

function CommandPalette({ theme, query, selected, width }: { theme: DeckTheme; query: string; selected: number; width: number }) {
  const filtered = filterPalette(query);
  const sel = filtered.length ? Math.min(selected, filtered.length - 1) : 0;
  const MAX = 8;
  const start = filtered.length > MAX ? Math.min(Math.max(0, sel - Math.floor(MAX / 2)), filtered.length - MAX) : 0;
  const shown = filtered.slice(start, start + MAX);
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      borderStyle: theme.borderStyle,
      borderColor: theme.accent,
      paddingX: 1,
      marginTop: 1,
    },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { color: theme.accent, bold: true }, "▲ COMMAND PALETTE"),
      h(Text, { color: theme.dim }, `${filtered.length} · ↑↓ select · enter run · esc close`),
    ),
    filtered.length === 0
      ? h(Text, { color: theme.dim }, "  no matching command")
      : shown.map((cmd, i) => {
          const active = start + i === sel;
          return h(
            Box,
            { key: cmd.cmd, justifyContent: "space-between" },
            h(Text, { color: active ? theme.accent2 : theme.tool, bold: active }, `${active ? "▸ " : "  "}${cmd.cmd}`),
            h(Text, { color: theme.dim, wrap: "truncate" }, cmd.desc),
          );
        }),
  );
}

function LogText({ line, theme, spinner }: { line: LogLine; theme: DeckTheme; spinner: string }) {
  // Tool flow: indented, dim — "  ↳ bash  npm test … (spinner) → ✓ result".
  if (line.tone === "tool") {
    const name = line.meta ?? "tool";
    const r = line.result;
    // Running: animated spinner + live elapsed. Done: one ✓/✗ line + duration.
    const elapsed = line.startedAt != null ? formatDuration(Date.now() - line.startedAt) : "";
    // Forge-strike: when a tool FIRES, the leading glyph is a hammer-on-anvil
    // spark burst for its first ~7 frames (a felt "the god acts" beat), then
    // it settles to the normal ↳ arrow. Cools on its own (forgeStrike → []).
    const strikeTick = MOTION && line.startedAt != null && !r ? Math.floor((Date.now() - line.startedAt) / 90) : -1;
    const strike = strikeTick >= 0 ? forgeStrike(strikeTick, fxPaletteFrom(theme)) : [];
    const lead = line.cont
      ? h(Text, { color: theme.dim }, "    ")
      : strike.length > 0
        ? h(Box, null, h(Text, { color: theme.dim }, "  "), ...fxSpans(strike, `strike-${line.id}`), h(Text, null, " "))
        : h(Text, { color: theme.dim }, "  ↳ ");
    return h(
      Box,
      { justifyContent: "space-between" },
      h(
        Box,
        { flexShrink: 1 },
        lead,
        line.cont ? null : h(Text, { color: theme.accent2 }, `${name} `),
        h(Text, { color: theme.dim, wrap: "truncate" }, line.text),
      ),
      r
        ? h(
            Text,
            { color: r.ok ? theme.success : theme.error },
            ` ${r.ok ? "✓" : "✗"}${r.durationMs != null ? ` ${formatDuration(r.durationMs)}` : ""}${r.text ? ` · ${truncateTail(r.text, 26)}` : ""}`,
          )
        : h(Text, { color: theme.accent3, bold: true }, ` ${spinner || "…"}${elapsed ? ` ${elapsed}` : ""}`),
    );
  }
  // Per-file diff card: `▸ path (+adds −dels)` header; the newest card keeps
  // its hunk expanded (syntax-colored) while the turn streams, then collapses.
  if (line.tone === "diff-file") {
    const header = h(
      Box,
      null,
      h(Text, { color: theme.dim }, `  ${line.expanded ? "▾ " : "▸ "}`),
      h(Text, { color: theme.accent2, bold: true }, line.meta ?? "(diff)"),
      h(Text, { color: theme.dim }, " ("),
      h(Text, { color: theme.success }, `+${line.adds ?? 0}`),
      h(Text, { color: theme.dim }, " "),
      h(Text, { color: theme.error }, `−${line.dels ?? 0}`),
      h(Text, { color: theme.dim }, ")"),
    );
    if (!line.expanded || !line.detail || line.detail.length === 0) return header;
    const dt = diffThemeFrom(theme);
    return h(
      Box,
      { flexDirection: "column" },
      header,
      ...line.detail.map((row, i) =>
        h(
          Text,
          { key: i, wrap: "truncate" },
          h(Text, { color: theme.dim }, "    "),
          ...diffLineSpans(row, dt).map((span, j) => h(Text, spanProps(span, theme.dim, j), span.text)),
        ),
      ),
    );
  }
  // Verifier objections — amber, indented, never dressed up as success.
  if (line.tone === "verify") {
    return h(Text, { color: theme.warn, wrap: "truncate" }, `${line.cont ? "    " : "  ⚠ "}${line.text}`);
  }
  // You: ember ❯ then your words. Ares: plain warm text, no label — the page IS Ares.
  if (line.tone === "user") {
    return h(
      Box,
      null,
      h(Text, { color: theme.accent, bold: true }, line.cont ? "  " : "❯ "),
      h(Text, { color: theme.user, wrap: "truncate" }, line.text),
    );
  }
  if (line.tone === "assistant") {
    const streaming = line.meta === "stream" && spinner;
    // Rich markdown: headings, bold/italic, inline code, fenced code blocks with
    // syntax tinting, lists, quotes, links. Pure renderer → styled line data.
    const md = renderMarkdown(line.text, mdThemeFrom(theme));
    return h(
      Box,
      { flexDirection: "column" },
      ...md.map((mdLine, idx) =>
        h(MdLineView, {
          key: idx,
          line: mdLine,
          fallback: theme.assistant,
          // Spinner rides the last rendered line while streaming.
          spinner: streaming && idx === md.length - 1 ? spinner : "",
          spinnerColor: theme.accent3,
        }),
      ),
    );
  }
  // verifier-success / notice / error / muted / diff — subtle, indented.
  const color = toneColor(line.tone, theme);
  const prefix = line.cont ? "  " : line.tone === "error" ? "  ✗ " : line.tone === "notice" ? "  " : "  ";
  return h(Text, { color, wrap: "truncate" }, `${prefix}${line.text}`);
}

// Map the TUI's DeckTheme onto the renderer's structural MdTheme.
function mdThemeFrom(theme: DeckTheme): MdTheme {
  return {
    text: theme.assistant,
    dim: theme.dim,
    accent: theme.accent,
    accent2: theme.accent2,
    accent3: theme.accent3,
    success: theme.success,
    warn: theme.warn,
    error: theme.error,
  };
}

// Map the TUI's DeckTheme onto the diff renderer's structural DiffLineTheme.
function diffThemeFrom(theme: DeckTheme): DiffLineTheme {
  return { add: theme.success, del: theme.error, meta: theme.accent2, dim: theme.dim, text: theme.text };
}

// Render one MdLine: a row of styled spans, plus an optional trailing spinner.
// Code/heading lines keep their leading structure; prose truncates to width to
// preserve the old single-stream behavior (the outer panel controls width).
function MdLineView({
  line,
  fallback,
  spinner,
  spinnerColor,
}: {
  line: MdLine;
  fallback: string;
  spinner: string;
  spinnerColor: string;
}) {
  if (line.kind === "blank" && line.spans.length === 0) {
    // Preserve blank lines for paragraph spacing, but keep the spinner visible.
    return h(
      Box,
      null,
      h(Text, {}, " "),
      spinner ? h(Text, { color: spinnerColor, bold: true }, spinner) : null,
    );
  }
  // Code blocks are indented and allowed to wrap (they read better wrapped than
  // chopped); prose truncates so a long line never breaks the single-stream
  // layout — matching the old assistant behavior.
  const wrapMode: "wrap" | "truncate" = line.kind === "code" ? "wrap" : "truncate";
  const indent = line.kind === "code" ? "  " : "";
  return h(
    Box,
    null,
    indent ? h(Text, { color: "gray" }, indent) : null,
    h(
      Text,
      { wrap: wrapMode },
      ...line.spans.map((span, i) => h(Text, spanProps(span, fallback, i), span.text)),
    ),
    spinner ? h(Text, { color: spinnerColor, bold: true }, ` ${spinner}`) : null,
  );
}

function spanProps(span: MdSpan, fallback: string, key: number): Record<string, unknown> {
  return {
    key,
    color: span.color ?? fallback,
    bold: span.bold ? true : undefined,
    italic: span.italic ? true : undefined,
    dimColor: span.dim ? true : undefined,
  };
}

function truncateTail(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

function TodosStrip({ theme, todos }: { theme: DeckTheme; todos: Todo[] }) {
  return h(
    Box,
    {
      borderStyle: theme.borderStyle,
      borderColor: theme.frame,
      paddingX: 1,
      marginTop: 1,
    },
    h(Text, { color: theme.accent, bold: true }, "TODOS "),
    ...todos.slice(0, 3).map((todo) => h(Text, { key: todo.id, color: todo.status === "completed" ? theme.success : theme.warn }, `${todoMarker(todo)} ${todo.status === "in_progress" ? todo.activeForm : todo.content}  `)),
  );
}

// Live Conductor fleet panel — one line per agent while a fleet runs, bounded
// to 12 rows + "+N more". Collapses to a one-line summary on completion.
function FleetPanel({ theme, fleet, spinner, width }: { theme: DeckTheme; fleet: FleetState; spinner: string; width: number }) {
  const { shown, hidden } = foldFleetRows(fleet.agents, 12);
  const running = fleet.agents.filter((a) => a.status === "running").length;
  return h(
    Box,
    { flexDirection: "column", width, borderStyle: theme.borderStyle, borderColor: theme.accent3, paddingX: 1, marginTop: 1 },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { color: theme.accent3, bold: true }, `⚔ FLEET${fleet.fleetId ? ` ${fleet.fleetId}` : ""}`),
      h(Text, { color: theme.dim }, `${fleet.agents.length} agents · ${running} running`),
    ),
    ...shown.map((agent) => {
      const color =
        agent.status === "done" ? theme.success : agent.status === "failed" ? theme.error : agent.status === "resumed" ? theme.accent2 : theme.warn;
      const glyph = agent.status === "running" ? (spinner || fleetGlyph(agent.status)) : fleetGlyph(agent.status);
      return h(
        Box,
        { key: agent.agentId },
        h(Text, { color, bold: agent.status === "running" }, `${glyph} `),
        h(Text, { color: theme.text, bold: agent.status === "running" }, agent.agentId),
        h(Text, { color: theme.accent2 }, ` [${agent.phase || agent.role}]`),
        h(Text, { color: theme.dim, wrap: "truncate" }, ` ${agent.activity}`),
      );
    }),
    hidden > 0 ? h(Text, { color: theme.dim }, `  +${hidden} more`) : null,
  );
}

// When slate is active, even the classic-rendered surfaces (overlays, launcher
// fallbacks) borrow slate's cool palette so nothing flashes fire-orange over the
// new main screen.
const SLATE_DECK: DeckTheme = {
  title: "SLATE", borderStyle: "round", frame: SLATE.line,
  accent: SLATE.primary, accent2: SLATE.secondary, accent3: SLATE.primaryDim,
  text: SLATE.text, dim: SLATE.muted, panel: SLATE.surface, input: SLATE.surfaceAlt,
  user: SLATE.text, assistant: SLATE.text, tool: SLATE.active,
  error: SLATE.danger, success: SLATE.success, warn: SLATE.warn,
};

function deckTheme(): DeckTheme {
  if (process.env.ARES_TUI !== "classic") return SLATE_DECK;
  return DECK_THEMES[currentThemeName()] ?? DECK_THEMES.rage;
}

function toneColor(tone: LogLine["tone"], theme: DeckTheme): string {
  if (tone === "diff-add") return theme.success;
  if (tone === "diff-del") return theme.error;
  if (tone === "diff-meta") return theme.accent2;
  if (tone === "user") return theme.user;
  if (tone === "assistant") return theme.assistant;
  if (tone === "tool") return theme.tool;
  if (tone === "verify") return theme.warn;
  if (tone === "error") return theme.error;
  if (tone === "notice") return theme.accent2;
  return theme.dim;
}

function progressText(data: unknown): string | null {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : null;
  const obj = data as Record<string, unknown>;
  if (obj.kind === "shell_output") {
    const text = String(obj.text ?? "").trimEnd();
    if (!text) return null;
    return `${obj.stream ?? "stdout"} ${text}`.slice(0, 240);
  }
  if (obj.kind === "grep_match") {
    return `grep ${obj.total ?? "?"} match(es)${obj.file ? ` ${obj.file}:${obj.line ?? ""}` : ""}`;
  }
  if (obj.kind === "lsp_init") return `starting ${obj.server ?? "LSP"}`;
  if (obj.kind === "lsp_ready") return `${obj.server ?? "LSP"} ready`;
  return JSON.stringify(obj).slice(0, 240);
}

function todoMarker(todo: Todo): string {
  if (todo.status === "completed") return "[x]";
  if (todo.status === "in_progress") return "[>]";
  return "[ ]";
}

function compactModel(model: string, max: number): string {
  if (model.length <= max) return model;
  return `${model.slice(0, Math.max(0, max - 4))}...`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function EvolutionPulses({ theme, pulses, width }: { theme: DeckTheme; pulses: Pulse[]; width: number }) {
  // Weirdcore card row. Each pulse renders as "+N TARGET" with a bracketed
  // kind tag if present. Older pulses dim out as they age.
  const now = Date.now();
  return h(
    Box,
    {
      flexDirection: "row",
      width,
      gap: 1,
      paddingX: 1,
      marginTop: 1,
    },
    ...pulses.map((p) => {
      const age = now - p.createdAt;
      const dimming = age > 5_000;
      const fading = age > 7_500;
      const color = pulseColor(p, theme);
      const label = `+${p.delta} ${p.target}`;
      const tag = p.kind ? `[${p.kind}]` : "";
      return h(
        Box,
        {
          key: p.id,
          borderStyle: "round",
          borderColor: fading ? theme.dim : color,
          paddingX: 1,
        },
        h(Text, { color: fading ? theme.dim : dimming ? theme.text : color, bold: !fading }, label),
        tag ? h(Text, { color: theme.dim }, ` ${tag}`) : null,
      );
    }),
  );
}

function pulseColor(p: Pulse, theme: DeckTheme): string {
  if (p.type === "bootstrap_complete") return theme.success;
  if (p.type === "self_evolve") return theme.accent;
  if (p.type === "capture_detected") return theme.accent2;
  if (p.type === "recall_surfaced") return theme.accent3;
  if (p.type === "skill_crafted") return theme.warn;
  if (p.type === "capability_changed") return theme.tool;
  if (p.type === "dream_phase_ended") return theme.accent3;
  return theme.text;
}

function cachePercent(usage: Usage): string {
  const cached = usage.cacheReadTokens ?? 0;
  const denom = usage.inputTokens;
  if (denom <= 0) return "0%";
  return `${Math.round((cached / denom) * 100)}%`;
}

function formatCost(usage: Usage): string {
  const inputPerM = Number(process.env.ARES_COST_INPUT_PER_MTOK ?? 0);
  const outputPerM = Number(process.env.ARES_COST_OUTPUT_PER_MTOK ?? 0);
  const cacheReadPerM = Number(process.env.ARES_COST_CACHE_READ_PER_MTOK ?? inputPerM);
  if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM) || (inputPerM <= 0 && outputPerM <= 0)) {
    return "$n/a";
  }
  const uncachedInput = Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0));
  const cost =
    (uncachedInput / 1_000_000) * inputPerM +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * cacheReadPerM +
    (usage.outputTokens / 1_000_000) * outputPerM;
  return `$${cost.toFixed(4)}`;
}

// Premium block-glyph gauge for the status bar — reads as a solid fuel bar,
// matching the desktop's context meter rather than ASCII #/-.
function fillBar(percent: number, width: number): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

// A model's context window for the fill gauge. Override via
// ARES_CONTEXT_WINDOW_TOKENS; otherwise the ONE canonical table the budgeter
// uses — a gauge that disagrees with the budgeter lies exactly when it
// matters (1M-window models like Opus 4.8 / DeepSeek v4 / GLM 5.1).
function contextWindowFor(model: string): number {
  const override = Number(process.env.ARES_CONTEXT_WINDOW_TOKENS);
  if (Number.isFinite(override) && override > 0) return override;
  return modelContextWindow(model);
}

// Context-fill percentage from the last request's prompt size — the single most
// useful "how full is the window" readout, exactly what the desktop surfaces.
function contextFillPercent(usage: Usage, model: string): number {
  const window = contextWindowFor(model);
  if (window <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((usage.inputTokens / window) * 100)));
}

// Health color for the context gauge: calm accent under load, amber as it fills,
// crimson near the compaction ceiling — a glanceable "am I about to compact" cue.
function fillColor(percent: number, theme: DeckTheme): string {
  if (percent >= 85) return theme.error;
  if (percent >= 65) return theme.warn;
  return theme.success;
}

// (SGR mouse parsing + terminal mouse-mode management live in mouseInput.ts;
// hit-test/slider/surge geometry lives in tuiChrome.ts — both pure-tested.)
