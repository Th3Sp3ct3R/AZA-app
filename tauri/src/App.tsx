// Ares desktop — v3.
//
// Anatomy:
//   titlebar     — draggable strip: brand, daemon pill, window controls
//   left rail    — new session, sessions inbox, settings, status dot
//   center       — chat: turns, tool-step cards, thinking, permissions, usage
//   composer     — model + reasoning + routing chips, autosizing input
//   footer       — ambient telemetry + Garrison log + manual restart
//   the Forge    — right side panel: artifact preview / live HTML sandbox /
//                  the holo 3D engine. Real documents over the asset protocol
//                  so their scripts actually run.
//
// Design law: flat obsidian, one bronze accent, steel = success, crimson =
// danger. Motion everywhere, but small: entrances, sweeps, pulses.
//
// Daemon bridge: ares_start_daemon / ares_drain_events polling +
// ares:event-buffered push, ares_send, ares_restart_daemon, ares_set_reasoning,
// ares_set_routing, ares_permission_response, ares_forge_write. The shell now
// watches the child and emits desktop_daemon_exited when it dies — the UI
// surfaces the stderr tail and auto-restarts the Garrison.
//
// In a plain browser (no native bridge) the app runs in DEMO mode.

import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, PhysicalSize, PhysicalPosition } from "@tauri-apps/api/window";
// The REAL holotable BUILD engine — same module the CLI's `ares holo` uses.
// Any model plugged into Ares emits a HoloSpec (*.holo.json) and this renders
// it: exploded view, assembly steps, wiring overlay, BOM with STL export.
import { buildHolotableHtml, validateHoloSpec, type HoloSpec } from "../../packages/cli/src/holotable";
import { redactSecrets } from "../../packages/protocol/src/secretRedact";
import { UpdateBanner } from "./UpdateBanner";
import { WhatsNew } from "./WhatsNew";
import { StyleCtx, SpringNumber, SpringHeight, TokenFlowStrip, pushTokenFlow, useNewStyle } from "./newStyle";
import { CHANGELOG } from "./changelog";
import "./styles.css";

// The app version, injected by Vite's `define`. Guarded with typeof so that even
// if the build ever fails to substitute the token (which white-screened the app
// on a past update), this resolves to a harmless fallback instead of throwing a
// ReferenceError that takes the whole UI down.
const APP_VERSION: string = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

// ─── Bridge contract ───────────────────────────────────────────────────────

interface AresEvent {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  toolName?: string;
  status?: string;
  source?: string;
  reason?: string;
  decision?: string;
  level?: string;
  provider?: string;
  model?: string;
  code?: number | null;
  durationMs?: number;
  touchedFiles?: string[];
  activityDescription?: string;
  display?: string;
  output?: unknown;
  input?: unknown;
  /** tool_use_input_delta — partial JSON of the tool input being authored. */
  deltaJson?: string;
  /** tool_progress — live sub-tool output (shell chunks, grep ticks, subagent activity, live browser frames, Conductor fleet activity). */
  data?: { kind?: string; stream?: string; text?: string; total?: number; activity?: string; tool?: string; image?: string; agentId?: string; event?: string; role?: string; phase?: string; status?: string; fleetId?: string; backend?: string; label?: string; line?: string; filesTouched?: number; version?: string };
  /** compaction event fields */
  summarizedMessages?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  method?: "summary" | "ledger";
  error?: unknown;
  event?: AresEvent;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number; modelCalls?: number };
  todos?: Array<{ id?: string; content?: string; activeForm?: string; status?: string }>;
  files?: string[];
  diff?: string;
  truncated?: boolean;
  description?: string;
  summary?: string;
  // settings/usage/skills/operator command replies
  skills?: unknown;
  stats?: unknown;
  sessions?: unknown;
  models?: unknown;
  messages?: unknown;
  meta?: unknown;
  goals?: unknown;
  activeCount?: number;
  autotick?: boolean;
  trust?: unknown;
  // gateway account frames
  connected?: boolean;
  balance_usd?: number;
  new_grants?: unknown;
  amount_usd?: number;
  profile?: unknown;
  lane?: string;
  routingMode?: "manual" | "auto";
  routing?: Prefs["routing"];
  reasoningLevel?: ReasoningLevel;
  sessionId?: string;
  hasKey?: boolean;
  keyStatus?: Record<string, boolean>;
  permissions?: Partial<PermSettings>;
  engine?: EngineConfig;
  // anthropic oauth
  url?: string;
  verifier?: string;
  state?: string;
  ok?: boolean;
  label?: string;
  providers?: unknown;
  // consciousness (embedded local watcher) command replies
  enabled?: boolean;
  downloading?: boolean;
  watching?: boolean;
  pct?: number;
  receivedBytes?: number;
  totalBytes?: number;
  filename?: string;
  engineStatus?: { binaryInstalled?: boolean; available?: boolean };
  seconds?: number;
  observation?: string;
  comment?: string | null;
  spoke?: boolean;
  at?: number;
}

interface ConsciousnessModelVm {
  id: string;
  role: string;
  label: string;
  filename: string;
  bytes: number;
  present: boolean;
  downloadedBytes: number;
}
interface ConsciousnessVm {
  enabled: boolean;
  downloading: boolean;
  ready: boolean;
  watching: boolean;
  paused: boolean;
  engineInstalled: boolean;
  engineAvailable: boolean;
  error?: string;
  models: ConsciousnessModelVm[];
  /** model id → download percent */
  progress: Record<string, number>;
  lastObservation?: string;
  lastComment?: string;
  lastObservationAt?: number;
}

interface OAuthProviderVm {
  id: string;
  label: string;
  connected: boolean;
  hasApp: boolean;
}

/** A connected remote MCP server (the /mcp Directory). */
interface McpConnectorVm {
  name: string;
  url: string;
  displayName?: string;
  oauth?: boolean;
  connectedAt?: string | null;
}

/** Ares Gateway account snapshot (doingteam.com /me via the daemon bridge). */
interface GatewayAccountVm {
  connected?: boolean;
  reason?: string;
  /** doingteam advertises click-to-connect OAuth — gates the "Sign in" button
   *  so it only appears once the gateway endpoints are live. */
  oauthSupported?: boolean;
  profile?: { display_name?: string | null; avatar_url?: string | null; status?: string };
  balance_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  models?: Array<{ id: string; display_name?: string; is_free?: boolean; is_house?: boolean; cap_remaining_microcents?: number }>;
}

interface BufferedEvent {
  seq: number;
  event: AresEvent;
}

interface DaemonStatus {
  running: boolean;
  root?: string | null;
  provider?: string | null;
  model?: string | null;
}

interface OllamaModelInfo {
  id: string;
  hint: string;
  size?: number | null;
  parameters?: string | null;
  family?: string | null;
  contextWindow?: number | null;
  capabilities?: string[];
}

interface OllamaDiscovery {
  host: string;
  reachable: boolean;
  models: OllamaModelInfo[];
  error?: string | null;
}

function hasNativeBridge(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

// ─── View model ────────────────────────────────────────────────────────────

type ReasoningLevel = "low" | "medium" | "high" | "max";
const REASONING_LEVELS: ReasoningLevel[] = ["low", "medium", "high", "max"];

// The effort SLIDER: model reasoning low→max, plus ULTRA at the very top — which
// is not a model dial but a posture: unleash a background fleet (the orchestrator).
// "ultra" is kept as a separate Prefs.ultra flag so a daemon reasoning echo can
// never clobber it; when ultra is on, the model dial is pinned to "max".
const EFFORT_STEPS = ["low", "medium", "high", "max", "ultra"] as const;
type EffortStep = (typeof EFFORT_STEPS)[number];
const EFFORT_META: Record<EffortStep, { label: string; hint: string }> = {
  low: { label: "low", hint: "snappy — minimal deliberation" },
  medium: { label: "medium", hint: "balanced thinking for everyday work" },
  high: { label: "high", hint: "deep passes for hard problems" },
  max: { label: "max", hint: "everything the model has" },
  ultra: { label: "ULTRA", hint: "unleash the fleet — background agents orchestrated in parallel" },
};

interface ToolStep {
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

type Item =
  | { kind: "user"; key: string; text: string }
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

interface SessionVm {
  id: string;
  title: string;
  items: Item[];
  busy: boolean;
  tokensIn: number;
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

interface CodingBackendVm {
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

interface FleetAgentVm {
  role: string;
  phase: string;
  status: "running" | "done" | "failed";
  tool?: string;
  activity?: string;
  resumed?: boolean;
}
interface FleetVm {
  active: boolean;
  /** The runFleet id — lets the UI offer a resume of an aborted run. */
  fleetId?: string;
  /** Set on turn-end when the fleet left failed/incomplete leaves behind. */
  canResume?: boolean;
  /** Insertion-ordered agents keyed by agentId. */
  agents: Array<{ id: string } & FleetAgentVm>;
}

let keySeq = 0;
const nextKey = () => `i${++keySeq}`;

/** OS notification via the WebView's native Notification API — no Tauri plugin
 *  needed. Makes background missions, permission gates, and daemon death visible
 *  when you're working in another app. */
function fireNotification(title: string, body: string): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification(title, { body: body.slice(0, 240) });
  } catch {
    /* notifications are best-effort */
  }
}

function freshSession(): SessionVm {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${++keySeq}`;
  return {
    id: `sess_${random}`,
    title: "New session",
    items: [],
    busy: false,
    tokensIn: 0,
    tokensOut: 0,
    todos: [],
    loaded: true,
  };
}

interface SessionSummaryWire {
  id: string;
  provider?: { name?: string; model?: string };
  updatedAt?: string;
  preview?: string;
  label?: string;
}

interface MessageWire {
  id?: string;
  role?: string;
  content?: Array<Record<string, unknown>>;
}

function sessionFromSummary(summary: SessionSummaryWire): SessionVm {
  return {
    id: summary.id,
    title: compact(summary.label || summary.preview || "Saved session", 42),
    items: [],
    busy: false,
    tokensIn: 0,
    tokensOut: 0,
    todos: [],
    loaded: false,
    updatedAt: summary.updatedAt,
    turnModel: summary.provider?.model,
    turnProvider: summary.provider?.name,
  };
}

function sessionFromHistory(id: string, rawMessages: unknown, meta: unknown): SessionVm {
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
      const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
      if (text) items.push({ kind: "user", key: nextKey(), text });
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
    tokensOut: 0,
    todos: [],
    loaded: true,
    loading: false,
    turnModel: provider?.model,
    turnProvider: provider?.name,
  };
}

const PREVIEWABLE = /\.(html?|svg)$/i;
const HOLO_SPEC_FILE = /\.holo\.json$/i;

/** Fold one daemon event into the session — pure-ish, works on a draft copy. */
function foldEvent(s: SessionVm, e: AresEvent): SessionVm {
  const items = [...s.items];
  const last = items[items.length - 1];
  const session = { ...s, items };

  const openAssistant = (): Extract<Item, { kind: "assistant" }> => {
    if (last?.kind === "assistant" && last.streaming) return last;
    const fresh: Extract<Item, { kind: "assistant" }> = {
      kind: "assistant",
      key: nextKey(),
      text: "",
      thinking: "",
      streaming: true,
      model: session.turnModel,
      lane: session.turnLane,
      provider: session.turnProvider,
    };
    items.push(fresh);
    return fresh;
  };

  switch (e.type) {
    case "turn_start":
      session.busy = true;
      session.activity = "marshalling";
      session.fleet = undefined; // clear last turn's fleet board
      session.codingBackend = undefined; // and last turn's delegation cut-scene (fresh elapsed clock)
      break;
    case "consciousness_say": {
      // A proactive remark from the Watch — drop it into the conversation as a
      // finalized assistant bubble (never streaming, never sets busy).
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const text = (e.text ?? "").trim();
      if (text) {
        items.push({
          kind: "assistant",
          key: nextKey(),
          text,
          thinking: "",
          streaming: false,
          proactive: true,
        });
      }
      break;
    }
    case "route_resolved": {
      // The daemon resolved which model+lane handles this turn — attach it so
      // the user can SEE routing working, per message.
      session.turnModel = typeof e.model === "string" ? e.model : session.turnModel;
      session.turnLane = typeof e.lane === "string" ? e.lane : session.turnLane;
      session.turnProvider = typeof e.provider === "string" ? e.provider : session.turnProvider;
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, model: session.turnModel, lane: session.turnLane, provider: session.turnProvider };
      }
      break;
    }
    case "text_delta": {
      const a = openAssistant();
      items[items.length - 1] = { ...a, text: a.text + (e.text ?? "") };
      session.activity = "writing";
      break;
    }
    case "thinking_delta": {
      const a = openAssistant();
      items[items.length - 1] = { ...a, thinking: a.thinking + (e.text ?? "") };
      session.activity = "thinking";
      break;
    }
    case "tool_use_start": {
      // The model just BEGAN authoring this tool call — surface it instantly,
      // before the input finishes streaming. tool_start upgrades this step.
      const step: ToolStep = {
        id: e.id ?? nextKey(),
        label: `${e.name ?? "tool"} · drafting…`,
        name: e.name ?? "tool",
        status: "drafting",
        draftChars: 0,
        draftHead: "",
      };
      session.activity = `drafting ${e.name ?? "tool"}`;
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const tail = items[items.length - 1];
      if (tail?.kind === "tools") items[items.length - 1] = { ...tail, steps: [...tail.steps, step], finishedAt: undefined };
      else items.push({ kind: "tools", key: nextKey(), steps: [step], startedAt: Date.now() });
      break;
    }
    case "tool_use_input_delta": {
      // Live authorship progress: byte counter + early file_path so a big
      // Write shows itself materializing instead of seconds of dead air.
      const delta = typeof e.deltaJson === "string" ? e.deltaJson : "";
      if (!delta) break;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === e.id && st.status === "drafting");
        if (idx !== -1) {
          const steps = [...it.steps];
          const prev = steps[idx];
          const draftChars = (prev.draftChars ?? 0) + delta.length;
          const draftHead = (prev.draftHead ?? "").length < 2048 ? (prev.draftHead ?? "") + delta : prev.draftHead ?? "";
          const target = draftTargetPath(draftHead);
          const size = draftChars >= 1024 ? `${(draftChars / 1024).toFixed(1)}KB` : `${draftChars}ch`;
          const label = target
            ? `${prev.name} · ${target} — writing ${size}`
            : `${prev.name} · drafting ${size}`;
          steps[idx] = { ...prev, draftChars, draftHead, label };
          items[i] = { ...it, steps };
          session.activity = label;
        }
        break;
      }
      break;
    }
    case "tool_start": {
      const step: ToolStep = {
        id: e.id ?? nextKey(),
        label: e.activityDescription ?? toolStartLabel(e.name ?? "tool", e.input),
        name: e.name ?? "tool",
        status: "running",
        inputJson: e.input !== undefined ? compact(stringify(e.input), 1200) : undefined,
      };
      session.activity = step.label;
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      // Upgrade the drafting skeleton for this id if one exists (the input
      // finished streaming and the tool is now actually executing).
      let upgraded = false;
      for (let i = items.length - 1; i >= 0 && !upgraded; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === step.id);
        if (idx !== -1) {
          const steps = [...it.steps];
          steps[idx] = step;
          items[i] = { ...it, steps, finishedAt: undefined };
          upgraded = true;
        }
        break;
      }
      if (!upgraded) {
        const tail = items[items.length - 1];
        if (tail?.kind === "tools") items[items.length - 1] = { ...tail, steps: [...tail.steps, step], finishedAt: undefined };
        else items.push({ kind: "tools", key: nextKey(), steps: [step], startedAt: Date.now() });
      }
      break;
    }
    case "tool_progress": {
      // Live sub-tool output — shell stdout/stderr stream, grep tick counts,
      // subagent activity. Previously produced + transported, then dropped here,
      // so a 5-minute build looked frozen. Append shell output to the matching
      // step's bounded live tail; surface grep/subagent ticks as the step label.
      const d = e.data;
      if (!d) break;
      // Conductor fleet board — one row per leaf agent, grouped by phase.
      if (d.kind === "fleet_activity" && d.event === "fleet_start") {
        session.fleet = { active: true, fleetId: d.fleetId, agents: session.fleet?.agents ?? [] };
        break;
      }
      if (d.kind === "fleet_activity" && typeof d.agentId === "string") {
        const agents = [...(session.fleet?.agents ?? [])];
        const at = agents.findIndex((a) => a.id === d.agentId);
        const ev = d.event as string | undefined;
        const resolved: FleetAgentVm["status"] =
          ev === "done" ? (d.status === "completed" ? "done" : "failed") : ev === "resumed" ? "done" : "running";
        const base = at === -1
          ? { id: d.agentId, role: String(d.role ?? "agent"), phase: String(d.phase ?? ""), status: "running" as FleetAgentVm["status"], tool: undefined as string | undefined, activity: undefined as string | undefined, resumed: false }
          : agents[at];
        const next = {
          ...base,
          status: ev === "tool" ? base.status : resolved,
          tool: typeof d.tool === "string" ? d.tool : base.tool,
          activity: typeof d.activity === "string" ? d.activity : base.activity,
          resumed: ev === "resumed" ? true : base.resumed,
        };
        if (at === -1) agents.push(next);
        else agents[at] = next;
        session.fleet = { ...session.fleet, active: true, agents };
        break;
      }
      // Delegation cut-scene — Ares handing a job to Claude Code / Codex on the
      // Ares account. These events already flowed here but were dropped; now they
      // drive the animated scene.
      if (d.kind === "coding_backend") {
        const prev = session.codingBackend;
        const phase = (typeof d.phase === "string" ? d.phase : prev?.phase ?? "detect") as CodingBackendVm["phase"];
        const line = typeof d.line === "string" ? d.line.trim() : "";
        const lines = line ? [...(prev?.lines ?? []), line].slice(-6) : prev?.lines ?? [];
        // Count edited files live from Claude Code's stream-json tool_use blocks.
        let filesTouched = typeof d.filesTouched === "number" ? d.filesTouched : prev?.filesTouched ?? 0;
        if (line && /"type"\s*:\s*"tool_use"/.test(line) && /"name"\s*:\s*"(Edit|Write|MultiEdit|NotebookEdit|Update)"/.test(line)) {
          filesTouched = (prev?.filesTouched ?? 0) + 1;
        }
        session.codingBackend = {
          backend: typeof d.backend === "string" ? d.backend : prev?.backend ?? "claude",
          label: typeof d.label === "string" ? d.label : prev?.label ?? "Claude Code",
          phase,
          lines,
          filesTouched,
          startedTick: prev?.startedTick ?? Date.now(),
        };
        break;
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === e.id);
        if (idx === -1) continue;
        const steps = [...it.steps];
        const step = { ...steps[idx] };
        if (d.kind === "shell_output" && typeof d.text === "string") {
          const tail = (step.liveTail ?? "") + d.text;
          const lines = tail.split("\n");
          step.liveTail = lines.length > 200 ? lines.slice(-200).join("\n") : tail;
        } else if (d.kind === "grep_match" && typeof d.total === "number") {
          step.detail = `${d.total} match${d.total === 1 ? "" : "es"}…`;
        } else if (d.kind === "subagent_activity" && typeof d.activity === "string") {
          step.detail = d.activity;
        }
        steps[idx] = step;
        items[i] = { ...it, steps };
        break;
      }
      break;
    }
    case "tool_end":
    case "tool_error": {
      if (e.type === "tool_end") {
        for (const f of e.touchedFiles ?? []) {
          if ((PREVIEWABLE.test(f) || HOLO_SPEC_FILE.test(f)) && !items.some((it) => it.kind === "artifact" && it.path === f)) {
            items.push({ kind: "artifact", key: nextKey(), path: f, label: f.split(/[\\/]/).pop() ?? f });
          }
        }
      }
      let matched = false;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === e.id);
        if (idx === -1) continue;
        const steps = [...it.steps];
        steps[idx] = {
          ...steps[idx],
          status: e.type === "tool_end" ? "ok" : "error",
          durationMs: e.durationMs,
          detail: e.type === "tool_end" ? compact(e.display ?? stringify(e.output), 1600) : compact(String(e.error ?? "failed"), 1600),
        };
        items[i] = {
          ...it,
          steps,
          finishedAt: steps.every((step) => step.status !== "running" && step.status !== "drafting") ? Date.now() : it.finishedAt,
        };
        matched = true;
        break;
      }
      // Orphan tool_error (e.g. the model called a tool that doesn't exist —
      // no tool_start ever fired). Surface it: an invisible failure reads as
      // "the agent is doing nothing" when it's actually erroring.
      if (!matched && e.type === "tool_error") {
        const step: ToolStep = {
          id: e.id ?? nextKey(),
          label: "unrecognized tool call",
          name: "tool",
          status: "error",
          durationMs: e.durationMs,
          detail: compact(String(e.error ?? "failed"), 1600),
        };
        const tail = items[items.length - 1];
        if (tail?.kind === "tools") items[items.length - 1] = { ...tail, steps: [...tail.steps, step] };
        else items.push({ kind: "tools", key: nextKey(), steps: [step], startedAt: Date.now() });
      }
      break;
    }
    case "permission_request":
      items.push({ kind: "permission", key: nextKey(), id: e.id ?? "", toolName: e.toolName ?? "tool", reason: e.reason ?? "" });
      break;
    case "permission_response": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "permission" && it.id === e.id) {
          items[i] = { ...it, decided: e.decision ?? "decided" };
          break;
        }
      }
      break;
    }
    case "system_reminder_injected": {
      // Most injected context is prompt assembly — memory recall, loaded
      // instructions, the foreground-intent reminder, dream/heartbeat/skill/hook
      // notes. It steers the model but is pure noise in the transcript: a bare
      // "hi" was dumping the whole "Loaded global memory… / Foreground request
      // (greeting): hi" trace. Hide that, but KEEP the genuinely user-facing
      // runtime notices (provider failover, token-cap, loop/circuit guards).
      // The model still receives every reminder — only the UI rendering changes.
      const src = e.source ?? "context";
      const text = e.text ?? "";
      const NOISE = new Set(["memory", "recall", "dream", "heartbeat", "hook", "skill", "compaction", "undo"]);
      const isStartupNoise = src === "instructions" && /^(Loaded |Foreground request)/i.test(text);
      if (NOISE.has(src) || isStartupNoise) break;
      const tone = src === "verifier" ? "warn" : "dim";
      items.push({ kind: "notice", key: nextKey(), text: compact(text, 400), tone });
      break;
    }
    case "compaction": {
      const before = typeof e.tokensBefore === "number" ? e.tokensBefore : 0;
      const after = typeof e.tokensAfter === "number" ? e.tokensAfter : 0;
      const n = typeof e.summarizedMessages === "number" ? e.summarizedMessages : 0;
      const how = e.method === "ledger" ? "digest" : "summary";
      const k = (t: number) => (t >= 1000 ? `${Math.round(t / 1000)}k` : `${t}`);
      session.activity = "compacting memory";
      items.push({
        kind: "notice",
        key: nextKey(),
        text: `Compacted ${n} older message${n === 1 ? "" : "s"} into a ${how} · ${k(before)}→${k(after)} tokens`,
        tone: "dim",
      });
      break;
    }
    case "todo_updated":
      session.todos = (e.todos ?? []).map((t, i) => ({
        id: t.id ?? `t${i}`,
        content: t.content ?? "",
        activeForm: t.activeForm ?? t.content ?? "",
        status: t.status ?? "pending",
      }));
      {
        const current = session.todos.find((t) => t.status === "in_progress");
        if (current) session.activity = current.activeForm || current.content;
      }
      break;
    case "workspace_diff":
      if (e.diff && e.diff.trim()) {
        items.push({ kind: "diff", key: nextKey(), files: e.files ?? [], diff: compact(e.diff, 12_000), truncated: e.truncated ?? false });
      }
      break;
    case "undo_result":
      items.push({ kind: "notice", key: nextKey(), text: e.text ?? "Workspace restored.", tone: "warn" });
      break;
    case "subagent_start":
      items.push({ kind: "subagent", key: nextKey(), id: e.id ?? nextKey(), name: e.name ?? "worker", description: e.description ?? "", status: "running" });
      session.activity = `worker · ${e.description ?? e.name ?? "spawned"}`;
      break;
    case "subagent_end": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "subagent" && it.id === e.id) {
          items[i] = { ...it, status: (e.status as "completed" | "failed" | "cancelled") ?? "completed", summary: compact(e.summary ?? "", 600) };
          break;
        }
      }
      break;
    }
    case "turn_end": {
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const input = e.usage?.inputTokens ?? 0;
      const output = e.usage?.outputTokens ?? 0;
      items.push({
        kind: "usage",
        key: nextKey(),
        input,
        output,
        cacheRead: e.usage?.cacheReadTokens ?? 0,
        modelCalls: e.usage?.modelCalls ?? 1,
        durationMs: e.durationMs ?? 0,
        status: e.status ?? "completed",
        model: session.turnModel,
        lane: session.turnLane,
        provider: session.turnProvider,
      });
      session.busy = false;
      session.steerQueued = 0;
      session.tokensIn += input;
      session.tokensOut += output;
      if (session.fleet) {
        // If any leaf failed/aborted (or never finished), keep the board up with a
        // resume affordance instead of hiding it. Otherwise hide on completion.
        const incomplete = session.fleet.agents.some((a) => a.status === "failed" || a.status === "running");
        session.fleet = { ...session.fleet, active: false, canResume: incomplete && !!session.fleet.fleetId };
      }
      break;
    }
    case "steer_applied": {
      // The daemon folded a queued steer into the live turn — mark it landed.
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === "steer" && !(items[i] as Extract<Item, { kind: "steer" }>).landed) {
          items[i] = { ...(items[i] as Extract<Item, { kind: "steer" }>), landed: true };
          break;
        }
      }
      session.steerQueued = Math.max(0, (session.steerQueued ?? 0) - 1);
      session.activity = "steering";
      break;
    }
    case "daemon_error":
      items.push({ kind: "notice", key: nextKey(), text: compact(stringify(e.error ?? "daemon error"), 500), tone: "bad" });
      break;
    case "error": {
      const errObj = e.error as { code?: string; message?: string } | undefined;
      const msg = errObj?.message ?? (typeof e.error === "string" ? e.error : e.text ?? "error");
      // Missing Anthropic auth → an actionable in-chat sign-in prompt, not a dead error.
      if (errObj?.code === "no_auth" && /anthropic|claude/i.test(msg)) {
        items.push({ kind: "authPrompt", key: nextKey(), provider: "anthropic", text: msg });
      } else {
        items.push({ kind: "notice", key: nextKey(), text: compact(msg, 500), tone: "bad" });
      }
      session.busy = false;
      break;
    }
    case "desktop_error":
      items.push({ kind: "notice", key: nextKey(), text: compact(e.text ?? "desktop error", 500), tone: "bad" });
      break;
    default:
      break;
  }
  return session;
}

// ─── Small utilities ───────────────────────────────────────────────────────

/** Coarse action family for a tool — drives the verb, the glyph, and the
 *  human roll-up summary. Keep in sync with toolGlyph (which folds create→edit
 *  for the icon, but the summary wants them split). */
type ToolKind = "read" | "search" | "edit" | "create" | "shell" | "web" | "task" | "other";
function toolKind(name: string): ToolKind {
  if (/^(Write)$/i.test(name)) return "create";
  if (/^(Edit|ApplyIntent|FindAndEdit|NotebookEdit|MultiEdit)$/i.test(name)) return "edit";
  if (/^(Read|Glob|NotebookRead|LS)$/i.test(name)) return "read";
  if (/^(Grep|CodebaseSearch|WebSearch|Search)$/i.test(name)) return "search";
  if (/^(Bash|PowerShell|BashOutput|KillShell|Shell)$/i.test(name)) return "shell";
  if (/^(WebFetch|Browser|Fetch)/i.test(name)) return "web";
  if (/^(Task|Operator|Agent)$/i.test(name)) return "task";
  return "other";
}

/** Present-tense verb for an in-flight call — "Editing", "Creating", "Running". */
function toolVerb(name: string): string {
  switch (toolKind(name)) {
    case "create": return "Creating";
    case "edit": return "Editing";
    case "read": return "Reading";
    case "search": return /websearch/i.test(name) ? "Searching the web for" : "Searching";
    case "shell": return "Running";
    case "web": return "Fetching";
    case "task": return "Delegating";
    default: return name;
  }
}

/** Human, verb-first label for a tool call from its name + input —
 *  "Creating ares-fact.html", "Searching validateSession", "Running npm test".
 *  The daemon doesn't always send an activityDescription, and a bare tool name
 *  ("tools ran") tells the user nothing about what's actually happening. */
function toolStartLabel(name: string, input: unknown): string {
  const rec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const firstString = (...keys: string[]) => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const verb = toolVerb(name);
  const path = firstString("file_path", "path", "notebook_path");
  const target = path || firstString("pattern", "query", "url", "command", "description", "goal");
  if (!target) return verb === name ? name : `${verb}…`;
  // For paths, show the last 1–2 segments; for everything else, a clipped phrase.
  const segs = target.split(/[\\/]/).filter(Boolean);
  const compactTarget = path && segs.length > 2 ? segs.slice(-2).join("/") : target;
  const short = compactTarget.length > 64 ? `${compactTarget.slice(0, 64)}…` : compactTarget;
  return verb === name ? `${name} · ${short}` : `${verb} ${short}`;
}

/** A transparent one-line roll-up of a finished tool group — "Read 3 files ·
 *  edited 2 · ran 1 command" instead of the opaque "6 actions · 6 done". */
function summarizeSteps(steps: ToolStep[]): string {
  const counts: Record<ToolKind, number> = { read: 0, search: 0, edit: 0, create: 0, shell: 0, web: 0, task: 0, other: 0 };
  for (const s of steps) counts[toolKind(s.name)]++;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (counts.create) parts.push(`created ${plural(counts.create, "file", "files")}`);
  if (counts.edit) parts.push(`edited ${plural(counts.edit, "file", "files")}`);
  if (counts.read) parts.push(`read ${plural(counts.read, "file", "files")}`);
  if (counts.search) parts.push(`${plural(counts.search, "search", "searches")}`);
  if (counts.shell) parts.push(`ran ${plural(counts.shell, "command", "commands")}`);
  if (counts.web) parts.push(`fetched ${plural(counts.web, "page", "pages")}`);
  if (counts.task) parts.push(`${plural(counts.task, "delegation", "delegations")}`);
  if (counts.other) parts.push(`${plural(counts.other, "action", "actions")}`);
  // Capitalize the first word so it reads like a sentence fragment.
  const joined = parts.join(" · ");
  return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : `${steps.length} actions`;
}

function compact(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Pull a file_path (or path/url) out of PARTIAL tool-input JSON while the
 *  model is still authoring it — so a streaming Write names its target file
 *  long before the input is complete. Returns a short basename-ish label. */
function draftTargetPath(partialJson: string): string {
  const m = /"(?:file_path|path|notebook_path|url)"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(partialJson);
  if (!m) return "";
  let raw = m[1];
  try {
    raw = JSON.parse(`"${raw}"`) as string;
  } catch {
    /* partial escape at the cut point — use as-is */
  }
  const parts = raw.split(/[\\/]/).filter(Boolean);
  const short = parts.length > 2 ? parts.slice(-2).join("/") : raw;
  return short.length > 48 ? `…${short.slice(-48)}` : short;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 1) ?? String(v);
  } catch {
    return String(v);
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtBytes(n?: number | null): string {
  if (!n) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${n} B`;
}

const escapeHtml = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markdown-lite renderer: fenced code, headings, lists, links, bold/italic,
 *  inline code. Escape-first, so the output is injection-safe. */
const IMG_URL_SRC = String.raw`https?:[^\s<>"')]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s<>"')]*)?`;

function inlineMd(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/!\[([^\]\n]*)\]\((https?:[^)\s]+)\)/g, '<span class="imgWrap"><img src="$2" alt="$1" loading="lazy" /><em>$1</em></span>')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(new RegExp(`(^|\\s)(${IMG_URL_SRC})`, "gi"), '$1<span class="imgWrap"><img src="$2" loading="lazy" /></span>');
}

/** Render a markdown table block (rows already split, header + separator + body). */
function renderTable(rows: string[]): string {
  const cells = (line: string) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(rows[0]);
  const body = rows.slice(2).filter((r) => r.trim());
  let html = '<div class="tableWrap"><table><thead><tr>';
  for (const h of header) html += `<th>${inlineMd(h)}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of body) {
    const c = cells(row);
    html += "<tr>";
    for (let i = 0; i < header.length; i++) html += `<td>${inlineMd(c[i] ?? "")}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  return html;
}

/** Markdown → HTML for a PROSE segment (no fences). Tables, headings, lists,
 *  rules, inline. Escape-first, injection-safe. */
function renderMarkdown(text: string): string {
  const lines = escapeHtml(text).split("\n");
  let html = "";
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      html += "</ul>";
      listOpen = false;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // table: a | row | followed by a |---|---| separator
    if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      closeList();
      const tableRows = [raw, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        tableRows.push(lines[j]);
        j++;
      }
      html += renderTable(tableRows);
      i = j - 1;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(raw)) {
      closeList();
      html += '<hr class="rule" />';
      continue;
    }
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!listOpen) {
        html += "<ul>";
        listOpen = true;
      }
      html += `<li>${inlineMd(li[1])}</li>`;
      continue;
    }
    closeList();
    if (h) {
      const level = Math.min(h[1].length + 2, 5);
      html += `<h${level}>${inlineMd(h[2])}</h${level}>`;
    } else {
      html += inlineMd(raw) + "\n";
    }
  }
  closeList();
  return html;
}

type RichSegment =
  | { kind: "prose"; content: string }
  | { kind: "code"; lang: string; content: string }
  | { kind: "mermaid"; content: string; complete: boolean }
  | { kind: "chart"; content: string; complete: boolean };

/** Split assistant text on fenced blocks, classifying mermaid/chart/code.
 *  Handles an unterminated trailing fence (mid-stream). */
function splitRich(text: string): RichSegment[] {
  const segments: RichSegment[] = [];
  const fence = /```(\w*)\n?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let inFence = false;
  let lang = "";
  let fenceStart = 0;
  while ((m = fence.exec(text))) {
    if (!inFence) {
      if (m.index > last) segments.push({ kind: "prose", content: text.slice(last, m.index) });
      inFence = true;
      lang = (m[1] || "").toLowerCase();
      fenceStart = fence.lastIndex;
    } else {
      const body = text.slice(fenceStart, m.index).replace(/\n$/, "");
      pushFence(segments, lang, body, true);
      inFence = false;
      last = fence.lastIndex;
    }
  }
  if (inFence) {
    // unterminated — still streaming this block
    pushFence(segments, lang, text.slice(fenceStart), false);
  } else if (last < text.length) {
    segments.push({ kind: "prose", content: text.slice(last) });
  }
  return segments;
}

function pushFence(segments: RichSegment[], lang: string, content: string, complete: boolean): void {
  if (lang === "mermaid") segments.push({ kind: "mermaid", content, complete });
  else if (lang === "chart") segments.push({ kind: "chart", content, complete });
  else segments.push({ kind: "code", lang, content });
}

// ─── Persistence ───────────────────────────────────────────────────────────

type RouteLane = "chat" | "coding" | "research" | "tool-use";
const ROUTE_LANES: RouteLane[] = ["chat", "coding", "research", "tool-use"];

type Routing = Partial<Record<RouteLane, { provider: string; model: string }>>;

interface Prefs {
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
  /** Screen flame border intensity while working — immersive (default tongues),
   *  clean (no border, just a soft ember rim), or combat (hotter, taller). */
  flameMode: "immersive" | "clean" | "combat";
  /** Pinned session ids (shown in their own rail section). */
  pinned: string[];
  /** Accent theme for the desktop chrome. */
  theme: ThemeName;
  /** Interface style — "new" = the Forged skin (glass depth, spring motion,
   *  living gauges); "legacy" = the classic flat shell, pixel-identical to
   *  the pre-skin app. Everything new is scoped under data-style="new". */
  uiStyle: "legacy" | "new";
  /** Advanced engine knobs (mirrors the daemon's EngineConfig). */
  engine: EngineConfig;
}

type ThemeName = "rage" | "bronze" | "crimson" | "steel" | "nightfall" | "verdant" | "daylight";
const THEMES: Array<{ id: ThemeName; label: string; hint: string; swatch: string }> = [
  { id: "rage", label: "Blood & Rage", hint: "obsidian scorched with ember — the god of war", swatch: "#d6402e" },
  { id: "bronze", label: "Bronze", hint: "the old warband gold", swatch: "#c79a4e" },
  { id: "crimson", label: "Crimson Banner", hint: "blood-red command", swatch: "#c0504a" },
  { id: "steel", label: "Steel Legion", hint: "cool tempered teal", swatch: "#7fa6a3" },
  { id: "nightfall", label: "Nightfall", hint: "violet dusk", swatch: "#8b8bd9" },
  { id: "verdant", label: "Verdant", hint: "emerald phalanx", swatch: "#74c39c" },
  { id: "daylight", label: "Daylight", hint: "the forge at high noon — light mode", swatch: "#f0e9e2" },
];

interface EngineConfig {
  maxTurns?: number;
  gatherStallRounds?: number;
  toolResultChars?: number;
  operatorAutotick?: boolean;
  operatorTickMinutes?: number;
  subagentTurnLimit?: number;
}

// WebKitGTK (the Linux webview) composites backdrop-filter and the edge-flame
// on the CPU — the whole app turns into a slideshow. Detect Linux once at boot
// and run in "lite" rendering mode (CSS strips the expensive effects); the
// flame defaults to clean there too. Windows/macOS keep the full show.
const IS_LINUX = /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);
if (IS_LINUX) document.documentElement.dataset.perf = "lite";

const PREFS_KEY = "ares.desktop.v3";
function loadPrefs(): Prefs {
  const fallback: Prefs = {
    provider: "ollama",
    model: "qwen3-coder:480b-cloud",
    reasoning: "medium",
    routing: {},
    routingMode: "manual",
    toolDisplay: "product",
    flameMode: IS_LINUX ? "clean" : "immersive",
    pinned: [],
    theme: "rage",
    uiStyle: "new",
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
      ultra: raw.ultra === true,
      routing,
      // Auto-routing is OPT-IN, never inferred. Previously an unset routingMode
      // flipped to "auto" whenever any lane assignment existed — so a user who
      // once tried routing found their manual model silently swapped per task
      // ("keeps flipping to random ones"). Unset now always means manual; auto
      // only when the user explicitly toggled it (which saves routingMode).
      routingMode: raw.routingMode === "auto" ? "auto" : "manual",
      toolDisplay: raw.toolDisplay === "technical" ? "technical" : "product",
      flameMode: raw.flameMode === "clean" || raw.flameMode === "combat" || raw.flameMode === "immersive" ? raw.flameMode : fallback.flameMode,
      pinned: Array.isArray(raw.pinned) ? raw.pinned.filter((p): p is string => typeof p === "string") : [],
      theme: themeOk ? (raw.theme as ThemeName) : "rage",
      uiStyle: raw.uiStyle === "legacy" ? "legacy" : "new",
      engine: raw.engine && typeof raw.engine === "object" ? raw.engine : {},
    };
  } catch {
    return fallback;
  }
}
function savePrefs(p: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

// ─── Model catalog: every provider lists its models ────────────────────────

interface ModelOption {
  id: string;
  label?: string;
  hint?: string;
  group: string;
  capabilities?: string[];
  /** Rich prose (OpenRouter) shown on the discovery card. */
  description?: string;
  /** Context window in tokens (OpenRouter) — shown as a big stat on the detail page. */
  contextLength?: number;
  /** $ per million tokens (OpenRouter): input = prompt, output = completion. */
  pricing?: { input?: number; output?: number };
}

const OLLAMA_CLOUD_MODELS: ModelOption[] = [
  { id: "qwen3-coder:480b-cloud", hint: "top coding reasoner", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "qwen3-coder-next:cloud", hint: "agentic coding", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "qwen3.5:397b-cloud", hint: "large multimodal reasoner", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning", "vision"] },
  { id: "qwen3.5:cloud", hint: "cloud default", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "qwen3-next:80b-cloud", hint: "efficient thinking", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v4-pro:cloud", hint: "frontier agentic reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v4-flash:cloud", hint: "fast long-context reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v3.2:cloud", hint: "efficient reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v3.1:671b-cloud", hint: "hybrid thinking", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "glm-5.1:cloud", hint: "flagship agentic engineering", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "glm-5:cloud", hint: "complex systems engineering", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "glm-4.7:cloud", hint: "coding capability", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "glm-4.6:cloud", hint: "agentic coding", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "kimi-k2.6:cloud", hint: "multimodal agentic coding", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning", "vision"] },
  { id: "kimi-k2.5:cloud", hint: "multimodal agentic", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning", "vision"] },
  { id: "kimi-k2:1t-cloud", hint: "long-horizon coding", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "kimi-k2-thinking:cloud", hint: "thinking model", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "minimax-m2.7:cloud", hint: "coding and productivity", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "minimax-m2.5:cloud", hint: "productivity coding", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "minimax-m2.1:cloud", hint: "multilingual coding", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "minimax-m2:cloud", hint: "efficient agentic workflows", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "gpt-oss:120b-cloud", hint: "open reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "devstral-2:123b-cloud", hint: "codebase agents", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "mistral-large-3:675b-cloud", hint: "enterprise multimodal", group: "Ollama Cloud · general", capabilities: ["tools", "vision"] },
  { id: "nemotron-3-super:cloud", hint: "multi-agent reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "cogito-2.1:671b-cloud", hint: "general reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "devstral-small-2:24b-cloud", hint: "fast codebase editing", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "nemotron-3-nano:30b-cloud", hint: "efficient agentic work", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "qwen3-vl:235b-instruct-cloud", hint: "multimodal instruction", group: "Ollama Cloud · vision", capabilities: ["tools", "vision"] },
  { id: "rnj-1:8b-cloud", hint: "code and STEM utility", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "gpt-oss:20b-cloud", hint: "quick summaries", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "gemma3:4b-cloud", hint: "compact vision utility", group: "Ollama Cloud · fast", capabilities: ["vision"] },
  { id: "ministral-3:3b-cloud", hint: "small utility", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "gemini-3-flash-preview:cloud", hint: "fast multimodal", group: "Ollama Cloud · vision", capabilities: ["tools", "vision"] },
  { id: "gemma4:31b-cloud", hint: "multimodal reasoning", group: "Ollama Cloud · vision", capabilities: ["reasoning", "vision"] },
  { id: "gemma3:27b-cloud", hint: "capable vision model", group: "Ollama Cloud · vision", capabilities: ["vision"] },
  { id: "gemma3:12b-cloud", hint: "balanced vision model", group: "Ollama Cloud · vision", capabilities: ["vision"] },
  { id: "qwen3-vl:235b-cloud", hint: "vision-language reasoning", group: "Ollama Cloud · vision", capabilities: ["tools", "reasoning", "vision"] },
  { id: "ministral-3:14b-cloud", hint: "edge-capable multimodal", group: "Ollama Cloud · vision", capabilities: ["tools", "vision"] },
  { id: "ministral-3:8b-cloud", hint: "small multimodal", group: "Ollama Cloud · vision", capabilities: ["tools", "vision"] },
];

const OPENAI_MODELS: ModelOption[] = [
  { id: "gpt-5.5", hint: "flagship — deep reasoning", group: "OpenAI" },
  { id: "gpt-5.5-codex", hint: "agentic coding tuned", group: "OpenAI" },
  { id: "gpt-5.1", hint: "previous flagship", group: "OpenAI" },
  { id: "gpt-5.1-codex", hint: "coding tuned", group: "OpenAI" },
  { id: "gpt-5", hint: "stable baseline", group: "OpenAI" },
  { id: "gpt-5-mini", hint: "fast + cheap", group: "OpenAI" },
];

const ANTHROPIC_MODELS: ModelOption[] = [
  { id: "claude-fable-5", hint: "flagship — adaptive thinking", group: "Anthropic" },
  { id: "claude-opus-4-8", hint: "deep reasoning workhorse", group: "Anthropic" },
  { id: "claude-sonnet-4-6", hint: "balanced speed / depth", group: "Anthropic" },
  { id: "claude-haiku-4-5-20251001", hint: "fast + cheap", group: "Anthropic" },
];

const DEEPSEEK_MODELS: ModelOption[] = [
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", hint: "frontier coding + reasoning · 1M context", group: "DeepSeek", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", hint: "fast agentic reasoning · 1M context", group: "DeepSeek", capabilities: ["tools", "reasoning"] },
];

const MOCK_MODELS: ModelOption[] = [{ id: "mock-echo", hint: "offline echo provider for UI testing", group: "Mock" }];

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  ollama: OLLAMA_CLOUD_MODELS[0].id,
  openai: OPENAI_MODELS[0].id,
  anthropic: ANTHROPIC_MODELS[0].id,
  deepseek: DEEPSEEK_MODELS[0].id,
  openrouter: "openai/gpt-4o-mini",
  ares: "ares-internal",
  mock: MOCK_MODELS[0].id,
};

function defaultModelForProvider(provider: string): string {
  return PROVIDER_DEFAULT_MODELS[provider] ?? "";
}

let openRouterCache: ModelOption[] | null = null;

async function fetchOpenRouterModels(): Promise<ModelOption[]> {
  if (openRouterCache) return openRouterCache;
  const res = await fetch("https://openrouter.ai/api/v1/models", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{
      id?: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      description?: string;
      supported_parameters?: string[];
      architecture?: { input_modalities?: string[] };
    }>;
  };
  const models = (body.data ?? [])
    .filter((m): m is typeof m & { id: string } => Boolean(m.id))
    .map((m) => {
      const ctx = m.context_length ? `${Math.round(m.context_length / 1000)}k ctx` : "";
      const inPrice = m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : undefined;
      const outPrice = m.pricing?.completion ? Number(m.pricing.completion) * 1e6 : undefined;
      const price = inPrice !== undefined ? `$${inPrice.toFixed(2)}/M in` : "";
      const capabilities = [
        ...(m.supported_parameters ?? []).filter((p) => p === "tools" || p === "reasoning" || p === "structured_outputs"),
        ...((m.architecture?.input_modalities ?? []).includes("image") ? ["vision"] : []),
        ...(Number(m.pricing?.prompt ?? "1") === 0 ? ["free"] : []),
      ];
      return {
        id: m.id,
        label: m.name,
        hint: [ctx, price].filter(Boolean).join(" · "),
        group: "OpenRouter",
        capabilities: [...new Set(capabilities)],
        description: m.description?.trim() || undefined,
        contextLength: m.context_length,
        pricing: (inPrice !== undefined || outPrice !== undefined) ? { input: inPrice, output: outPrice } : undefined,
      };
    });
  models.sort((a, b) => a.id.localeCompare(b.id));
  openRouterCache = models;
  return models;
}

function mergeModelOptions(...lists: ModelOption[][]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const list of lists) {
    for (const model of list) {
      const prior = byId.get(model.id);
      byId.set(model.id, {
        ...prior,
        ...model,
        capabilities: [...new Set([...(prior?.capabilities ?? []), ...(model.capabilities ?? [])])],
      });
    }
  }
  return [...byId.values()];
}

function useModelCatalog(provider: string, native: boolean) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    const onCatalog = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: string; models?: ModelOption[] }>).detail;
      if (!live || detail?.provider !== provider || !Array.isArray(detail.models)) return;
      setModels((current) => mergeModelOptions(current, detail.models ?? []));
      if (provider === "ares") setLoading(false);
    };
    const requestDaemonCatalog = () => {
      if (!native) return;
      void invoke("ares_daemon_command", { command: { type: "model_catalog", provider } }).catch(() => null);
    };
    const onDaemonReady = () => requestDaemonCatalog();
    window.addEventListener("ares:model-catalog", onCatalog);
    window.addEventListener("ares:daemon-ready", onDaemonReady);

    const run = async () => {
      if (provider === "mock") {
        setModels(MOCK_MODELS);
        return;
      }
      if (provider === "custom") {
        // Models discovered from the owner's custom OpenAI-compatible endpoint
        // (Settings → Keys → Custom provider). Empty until they run Discover.
        setModels(readCustomModels().map((id) => ({ id, group: "Custom provider" })));
        return;
      }
      if (provider === "openai") {
        setModels(OPENAI_MODELS);
        return;
      }
      if (provider === "anthropic") {
        setModels(ANTHROPIC_MODELS);
        return;
      }
      if (provider === "ares") {
        // The Ares tab lists ONLY what the gateway granted this account —
        // white-labeled display names, never the local ollama/openai catalogs.
        setModels([]);
        if (native) {
          setLoading(true);
          requestDaemonCatalog();
        } else {
          setModels([{ id: "ares-internal", hint: "connect your account — get a token at doingteam.com → Account", group: "Ares Gateway" }]);
        }
        return;
      }
      if (provider === "deepseek") {
        setModels(DEEPSEEK_MODELS);
        requestDaemonCatalog();
        return;
      }
      if (provider === "openrouter") {
        setLoading(true);
        setModels([]);
        requestDaemonCatalog();
        try {
          const fetched = await fetchOpenRouterModels();
          if (live) setModels(fetched);
        } catch (err) {
          if (live) {
            setError(String(err instanceof Error ? err.message : err));
            setModels([]);
          }
        } finally {
          if (live) setLoading(false);
        }
        return;
      }
      if (provider === "moa") {
        // Ensembles come from the daemon catalog ("Mixture of Agents" group).
        setModels([]);
        requestDaemonCatalog();
        return;
      }
      // ollama: curated cloud + whatever is installed locally
      setModels(OLLAMA_CLOUD_MODELS);
      requestDaemonCatalog();
      if (!native) return;
      setLoading(true);
      try {
        const found = await invoke<OllamaDiscovery>("ares_ollama_models");
        if (!live) return;
        const local = (found.models ?? []).map((m) => ({
          id: m.id,
          hint: [m.hint, fmtBytes(m.size)].filter(Boolean).join(" · "),
          group: "Local Ollama",
          capabilities: m.capabilities ?? [],
        }));
        setModels((current) => mergeModelOptions(current, local));
        if (found.error && !found.reachable) setError(found.error);
      } catch (err) {
        if (live) setError(String(err));
      } finally {
        if (live) setLoading(false);
      }
    };
    void run();
    return () => {
      live = false;
      window.removeEventListener("ares:model-catalog", onCatalog);
      window.removeEventListener("ares:daemon-ready", onDaemonReady);
    };
  }, [provider, native]);

  return { models, loading, error };
}

// ─── The Forge: built-in holo engine + sandbox seeds ───────────────────────

// The holotable showpiece (MECH_SPEC) renders by default; agent-forged
// *.holo.json specs replace it. Built lazily — the engine HTML is ~40KB.
let holoDefaultCache: string | null = null;
function holoDefaultHtml(): string {
  holoDefaultCache ??= buildHolotableHtml();
  return holoDefaultCache;
}

const SANDBOX_SEED = `<!doctype html>
<html>
<head>
<style>
  body { margin:0; height:100vh; display:grid; place-content:center; gap:16px;
         background:#0c0a0b; color:#c79a4e; font-family:Consolas,monospace; text-align:center; }
  h1 { font-size:14px; letter-spacing:.4em; margin:0; }
  button { background:none; border:1px solid #c79a4e66; color:#e3b86a; padding:10px 18px;
           border-radius:10px; font:inherit; cursor:pointer; }
  button:hover { background:#c79a4e22; }
</style>
</head>
<body>
  <h1>THE FORGE · SANDBOX</h1>
  <p id="out">Edit the HTML on the left, then Run. Scripts are live.</p>
  <button onclick="document.getElementById('out').textContent='It runs. ' + new Date().toLocaleTimeString()">prove it</button>
</body>
</html>`;

type ForgeTab = "preview" | "sandbox" | "holo" | "live";

interface ForgeState {
  open: boolean;
  tab: ForgeTab;
  artifact?: { path: string; label: string };
}

// ─── Demo feed (browser preview) ───────────────────────────────────────────

function demoSession(): SessionVm {
  let s = freshSession();
  s.title = "Refactor the auth flow";
  const feed: AresEvent[] = [
    { type: "turn_start" },
    { type: "route_resolved", model: "minimax-m2", lane: "coding" },
    { type: "thinking_delta", text: "The login handler validates sessions in two places — I should unify them before touching the middleware." },
    { type: "text_delta", text: "I'll unify the session validation first, then update the middleware. Let me look at what exists.\n" },
    { type: "tool_start", id: "t1", name: "Grep", activityDescription: "Searching for validateSession" },
    { type: "tool_end", id: "t1", durationMs: 312, display: "src/auth/session.ts:42\nsrc/middleware/guard.ts:18" },
    { type: "tool_start", id: "t2", name: "Read", activityDescription: "Reading session.ts" },
    { type: "tool_end", id: "t2", durationMs: 95, display: "export function validateSession(token: string) { … }" },
    { type: "tool_start", id: "t3", name: "Edit", activityDescription: "Editing guard.ts" },
    { type: "tool_end", id: "t3", durationMs: 141, display: "guard.ts now delegates to validateSession()" },
    { type: "text_delta", text: "Done. `guard.ts` now delegates to the canonical `validateSession()` — one source of truth.\n\n```ts\nimport { validateSession } from \"../auth/session\";\n\nexport const guard = (req) => validateSession(req.token);\n```\n\nThe verifier ran the touched tests: **green**." },
    { type: "turn_end", status: "completed", durationMs: 8400, usage: { inputTokens: 12480, outputTokens: 642 } },
  ];
  // Replicates the deepseek-via-ollama cadence that produced render bugs:
  // thinking-only rounds, each followed by a single tool call, reused ids.
  const deepseekRounds: AresEvent[] = [
    { type: "thinking_delta", text: "The user wants to see cow pictures. I'll use the Browser tool headless to search for cow images." },
    { type: "tool_start", id: "functions.Browser:0", name: "Browser", input: { action: "open", url: "https://pexels.com" } },
    { type: "tool_error", id: "functions.Browser:0", error: "Playwright is not installed", durationMs: 41 },
    { type: "thinking_delta", text: "The browser tool needs Playwright installed. Let me install it and then try again." },
    { type: "tool_start", id: "functions.Bash:0", name: "Bash", input: { command: "pnpm add -w playwright" } },
    { type: "tool_end", id: "functions.Bash:0", durationMs: 9000, display: "added playwright" },
    { type: "thinking_delta", text: "Playwright is installed. Now let me try the browser again." },
    { type: "text_delta", text: "---\n" },
    { type: "text_delta", text: "Stock sites are blocking the headless browser. Let me pull image URLs from image search instead.\n\n" },
    { type: "text_delta", text: "Here's how the tools compare:\n\n| Tool | Best for | Watch out |\n|---|---|---|\n| Edit | one-line surgical fixes | fails if the string appears twice |\n| ApplyIntent | large rewrites | adds APPLY-slot latency |\n| ImageSearch | direct image URLs | no content filtering |\n\nAnd the agent's mental model:\n\n```mermaid\ngraph TD\n  USER[You] --> PLAN[Plan]\n  PLAN --> ACT[Act with tools]\n  ACT --> VERIFY{Verify}\n  VERIFY -->|green| DONE[Deliver]\n  VERIFY -->|red| ACT\n```\n\nTool-call latency, lower is better:\n\n```chart\nRead: 95\nGrep: 312\nEdit: 141\nWebFetch: 1400\n```\n" },
  ];
  for (const e of [...feed, ...deepseekRounds]) s = foldEvent(s, e);
  s.items.unshift({ kind: "user", key: nextKey(), text: "unify the duplicated session validation, then make the middleware use it" });
  s.items.push({ kind: "artifact", key: nextKey(), path: "holo-arm.html", label: "holo-arm.html" });
  s.items.push({ kind: "permission", key: nextKey(), id: "demo-perm", toolName: "Bash", reason: "git push origin main — outward effect, staged for your approval" });
  return s;
}

// ─── First-run key gate ──────────────────────────────────────────────────────
//
// A brand-new user who launches with zero API keys used to be able to type and
// send — then the turn would die deep in the provider with a cryptic auth error.
// This intercepts that: once the daemon reports its key status and NOTHING is
// usable (no provider key AND no reachable local Ollama), we put a calm welcome
// in front of the chat that routes straight to Settings → API Keys. It's
// dismissible (so a power user spinning up Ollama isn't trapped) and re-appears
// next launch while still unconfigured. It auto-closes the moment a key lands.

function noUsableKeys(keyStatus: Record<string, boolean>): boolean {
  const known = Object.values(keyStatus);
  return known.length > 0 && known.every((v) => !v);
}

function FirstRunGate({
  active,
  onOpenKeys,
  onConnectAres,
}: {
  active: boolean;
  onOpenKeys: () => void;
  onConnectAres: () => void;
}): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  // Re-arm if keys disappear again (e.g. the user clears them mid-session).
  useEffect(() => {
    if (!active) setDismissed(false);
  }, [active]);
  if (!active || dismissed) return null;
  return (
    <div className="scrim center" role="dialog" aria-modal="true" aria-labelledby="frgTitle">
      <div className="wnCard frgCard" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="wnGlow" aria-hidden="true" />
        <div className="wnMark" aria-hidden="true" />
        <header className="wnHead">
          <div className="wnKicker">
            <span className="wnSpark" aria-hidden="true">✦</span>
            Welcome to Ares
          </div>
          <h2 id="frgTitle" className="wnTitle">One quick step to begin</h2>
          <p className="wnTagline">
            Ares needs a way to think. Connect your Ares account for models with zero setup —
            or bring your own: add a provider key (Anthropic, OpenAI, OpenRouter, DeepSeek, or
            any OpenAI-compatible endpoint), or point it at a local Ollama. About a minute.
          </p>
        </header>
        <footer className="wnFoot">
          <button className="wnOlderToggle" onClick={() => setDismissed(true)}>
            I'll use local Ollama
          </button>
          <button className="wnGhost" onClick={onOpenKeys}>
            Add an API key
          </button>
          {/* The zero-setup path: one account, models included. Made primary. */}
          <button className="wnGo" onClick={onConnectAres} autoFocus>
            Connect Ares account
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── App ───────────────────────────────────────────────────────────────────

type DaemonState = "starting" | "running" | "stopped" | "error";

// Owner permission posture — mirrors @ares/cli permissionPolicy.PermissionSettings.
// Defaults are the conservative baseline (guarded; sensitive asks; fleets inherit).
interface PermSettings {
  mode: "guarded" | "free";
  fileWrite: boolean;
  shell: boolean;
  network: boolean;
  sensitive: boolean;
  fleetsInherit: boolean;
}
const DEFAULT_PERMS: PermSettings = {
  mode: "guarded", fileWrite: true, shell: true, network: true, sensitive: false, fleetsInherit: true,
};

const MAX_AUTO_RESTARTS = 3;

function App() {
  const native = useMemo(hasNativeBridge, []);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [daemon, setDaemon] = useState<DaemonState>(native ? "starting" : "running");
  const [sessions, setSessions] = useState<SessionVm[]>(() => (native ? [freshSession()] : [demoSession()]));
  const [activeId, setActiveId] = useState<string>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("model");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [consciousness, setConsciousness] = useState<ConsciousnessVm>({
    enabled: false,
    downloading: false,
    ready: false,
    watching: false,
    paused: false,
    engineInstalled: false,
    engineAvailable: false,
    models: [],
    progress: {},
  });
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [permissions, setPermissions] = useState<PermSettings>(DEFAULT_PERMS);
  const [opStatus, setOpStatus] = useState<{ activeCount: number; goals: Array<{ id: string; statement: string; status: string; progress: number }>; autotick: boolean; trust?: Array<{ domain: string; level: number; proven: number }> } | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderVm[]>([]);
  // Ares Gateway account (doingteam.com): live snapshot + grant toasts.
  const [gatewayAccount, setGatewayAccount] = useState<GatewayAccountVm | null>(null);
  const [gatewayToasts, setGatewayToasts] = useState<Array<{ id: number; text: string }>>([]);
  const gwToastId = useRef(0);
  const pushGatewayToast = useCallback((text: string) => {
    const id = ++gwToastId.current;
    setGatewayToasts((t) => [...t, { id, text }]);
    setTimeout(() => setGatewayToasts((t) => t.filter((x) => x.id !== id)), 6500);
  }, []);
  const [strike, setStrike] = useState(0);
  // The embedded live browser: latest JPEG frame Ares streamed while driving its
  // own browser (cursor, clicks, navigation) — shown in the Forge "Live" tab.
  const [liveBrowser, setLiveBrowser] = useState<{ frame: string; at: number } | null>(null);
  // The INTERACTIVE embedded browser — Ares drives its own self-contained HTML
  // apps/games in-window (same-origin), no Playwright. Driven via webview_cmd.
  const embeddedRef = useRef<EmbeddedBrowserHandle>(null);
  const [embeddedActive, setEmbeddedActive] = useState(false);
  const [embeddedActivity, setEmbeddedActivity] = useState("");
  const [forge, setForge] = useState<ForgeState>({ open: false, tab: "sandbox" });
  const [forgeWidth, setForgeWidth] = useState(() => Math.min(560, Math.round(window.innerWidth * 0.36)));
  const [view, setView] = useState<"chat" | "artifacts" | "helm">("chat");
  const [sessionQuery, setSessionQuery] = useState("");
  const [garrisonOpen, setGarrisonOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modelPopOpen, setModelPopOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [cronOpen, setCronOpen] = useState(false);
  // Bug report: opt-in upload of the full session transcript to the gateway.
  const [reportOpen, setReportOpen] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  // Connector Directory (/mcp): remote MCP servers connected via OAuth.
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [mcpConnectors, setMcpConnectors] = useState<McpConnectorVm[]>([]);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  // Channel bridge state (Telegram, etc.) — pushed from garrison via channel.status/channel.roster.
  const [channelStatus, setChannelStatus] = useState<Array<{ channel: string; running: boolean; connected: boolean; configured: boolean; participantCount: number; lastError?: string }>>([]);
  const [channelRoster, setChannelRoster] = useState<Record<string, Array<{ chatId: number; name: string; role: string; addedAt: string; lastSeenAt?: string }>>>({});
  // Channel config form state
  const [channelToken, setChannelToken] = useState("");
  const [channelAllowedChats, setChannelAllowedChats] = useState("");
  const [channelBusy, setChannelBusy] = useState(false);
  // Floating-pill mode: shrink the window to an always-on-top mic bar.
  const [pill, setPill] = useState(false);
  const [pinTop, setPinTop] = useState(true);
  const prePillGeom = useRef<{ size: PhysicalSize; pos: PhysicalPosition } | null>(null);
  const [anthropicAuth, setAnthropicAuth] = useState<{ open: boolean; status: "idle" | "opening" | "waiting" | "done" | "error"; error?: string }>({ open: false, status: "idle" });
  const oauthCtx = useRef<{ verifier: string; state: string }>({ verifier: "", state: "" });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [bootGone, setBootGone] = useState(false);
  // Universal splash dismiss — covers the web/demo build too (the native daemon
  // connect path also clears it; whichever fires first wins, both idempotent).
  useEffect(() => {
    const t = window.setTimeout(() => setBootGone(true), 2150);
    return () => window.clearTimeout(t);
  }, []);
  const lastSeq = useRef(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef("");
  const prefsRef = useRef(prefs);
  const restartAttempts = useRef(0);
  const pendingGoal = useRef<{ goal: string; sessionId: string } | null>(null);
  const stderrTail = useRef<string[]>([]);
  prefsRef.current = prefs;

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  activeRef.current = active?.id ?? "";

  const apply = useCallback((fn: (s: SessionVm) => SessionVm) => {
    setSessions((prev) => prev.map((s) => (s.id === activeRef.current || (!activeRef.current && s === prev[0]) ? fn(s) : s)));
  }, []);

  /** Apply an update to a SPECIFIC session by id — used to route daemon events
   *  to the right chat, so concurrent sessions never bleed into each other. */
  const applyTo = useCallback((sessionId: string, fn: (s: SessionVm) => SessionVm) => {
    setSessions((prev) => {
      const hit = prev.some((s) => s.id === sessionId);
      if (!hit) {
        // Untagged/legacy event: route to the ACTIVE card, else the one that's
        // busy, else the first. (New cards unshift to index 0, so prev[0] is the
        // newest empty card — the wrong target.)
        const target =
          prev.find((s) => s.id === activeRef.current) ?? prev.find((s) => s.busy) ?? prev[0];
        return prev.map((s) => (s === target ? fn(s) : s));
      }
      return prev.map((s) => (s.id === sessionId ? fn(s) : s));
    });
  }, []);

  const pushLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev.slice(-240), line]);
  }, []);

  /** Serialize the current session (turns, tool calls, failures) + the Garrison
   *  log into a plain-text report and save it — so feedback is one click + a
   *  file attach. Captures everything that broke, not just the visible chat. */
  const exportSessionLog = useCallback(async () => {
    const s = active;
    const out: string[] = [];
    out.push(`ARES SESSION LOG`);
    out.push(`exported: ${new Date().toISOString()}`);
    out.push(`provider: ${prefs.provider} · model: ${prefs.model} · routing: ${prefs.routingMode}`);
    out.push(`tokens: up ${s?.tokensIn ?? 0} / down ${s?.tokensOut ?? 0}`);
    out.push("=".repeat(64));
    for (const it of s?.items ?? []) {
      if (it.kind === "user") out.push(`\n[USER] ${it.text}`);
      else if (it.kind === "assistant") {
        const who = `ARES${it.model ? ` ${it.model}` : ""}${it.provider ? `/${it.provider}` : ""}${it.proactive ? " (proactive)" : ""}`;
        if (it.thinking) out.push(`\n[${who} · thinking] ${it.thinking}`);
        out.push(`\n[${who}] ${it.text}`);
      } else if (it.kind === "tools") {
        for (const st of it.steps) {
          const tag = st.status === "error" ? "TOOL FAILED" : "TOOL";
          out.push(`  [${tag}] ${st.name} · ${st.status}${st.durationMs ? ` · ${st.durationMs}ms` : ""}`);
          // Tool inputs/results routinely carry API keys pasted into a prompt or
          // echoed back from a provider error — scrub before this leaves the app
          // as an exported file the owner might paste into a bug report.
          if (st.inputJson) out.push(`      input: ${redactSecrets(st.inputJson)}`);
          if (st.detail) out.push(`      ${st.status === "error" ? "error" : "result"}: ${redactSecrets(st.detail)}`);
        }
      } else if (it.kind === "diff") out.push(`  [DIFF] ${(it.files ?? []).join(", ")}`);
      else if (it.kind === "subagent") out.push(`  [SUBAGENT] ${it.name} · ${it.status}${it.summary ? ` — ${it.summary}` : ""}`);
    }
    out.push("\n" + "=".repeat(64));
    out.push("GARRISON LOG (last 240 lines — includes provider switches, errors):");
    out.push(...logLines);
    const content = out.join("\n");
    if (native) {
      try {
        const path = await invoke<string>("ares_export_log", { content });
        pushLog(`[export] session log saved → ${path}`);
      } catch (err) {
        pushLog(`[export] failed: ${String(err)}`);
      }
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
      a.download = `ares-session-${Date.now()}.txt`;
      a.click();
    }
  }, [active, logLines, prefs, native, pushLog]);

  /** Send a control command to the daemon (sessions_list, skills_list, etc.). */
  const daemonCmd = useCallback(
    (command: Record<string, unknown>) => {
      if (!native) return;
      void invoke("ares_daemon_command", { command }).catch(() => null);
    },
    [native],
  );

  // HELM live feed: while the war room is visible, re-scry on open, every 5s,
  // and on every busy flip (turn start/end) so missions, todos, and cost move
  // without touching ⟳. Gated on view so the idle app costs nothing.
  const helmBusy = Boolean(active?.busy);
  useEffect(() => {
    if (view !== "helm" || !native || daemon === "stopped" || daemon === "error") return;
    const scry = () => {
      daemonCmd({ type: "operator_status" });
      daemonCmd({ type: "usage_stats", days: 14 });
    };
    scry();
    const timer = window.setInterval(scry, 5_000);
    return () => window.clearInterval(timer);
  }, [view, native, daemon, helmBusy, daemonCmd]);

  const restartDaemon = useCallback(
    (provider?: string, model?: string) => {
      if (!native) return;
      setDaemon("starting");
      void invoke<DaemonStatus>("ares_restart_daemon", {
        provider: provider ?? prefsRef.current.provider,
        model: model ?? prefsRef.current.model,
      })
        .then((st) => setDaemon(st.running ? "running" : "stopped"))
        .catch((err) => {
          setDaemon("error");
          apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
        });
    },
    [native, apply],
  );

  /** Push routing + reasoning into a freshly-ready daemon, flush queued goal. */
  const onDaemonReady = useCallback((event?: AresEvent) => {
    restartAttempts.current = 0;
    setDaemon("running");
    if (!native) return;
    if (event?.sessionId) {
      setSessions((prev) => {
        if (prev.some((session) => session.id === event.sessionId)) return prev;
        const emptyIndex = prev.findIndex(
          (session) => session.loaded !== false && session.items.length === 0 && session.title === "New session",
        );
        if (emptyIndex < 0) return prev;
        const next = [...prev];
        const oldId = next[emptyIndex].id;
        next[emptyIndex] = { ...next[emptyIndex], id: event.sessionId! };
        setActiveId((current) => (!current || current === oldId ? event.sessionId! : current));
        return next;
      });
    }
    if (event?.provider && event.model) {
      const next: Prefs = {
        ...prefsRef.current,
        provider: event.provider,
        model: event.model,
        reasoning: REASONING_LEVELS.includes(event.reasoningLevel as ReasoningLevel)
          ? (event.reasoningLevel as ReasoningLevel)
          : prefsRef.current.reasoning,
        routingMode: event.routingMode ?? prefsRef.current.routingMode,
        routing: event.routing ?? prefsRef.current.routing,
        engine: event.engine ?? prefsRef.current.engine,
      };
      prefsRef.current = next;
      setPrefs(next);
      savePrefs(next);
    }
    if (event?.keyStatus) setKeyStatus(event.keyStatus);
    if (event?.permissions) setPermissions({ ...DEFAULT_PERMS, ...event.permissions });
    void invoke("ares_set_reasoning", { level: prefsRef.current.reasoning }).catch(() => null);
    if (Object.keys(prefsRef.current.routing).length > 0) {
      void invoke("ares_set_routing", { routing: prefsRef.current.routing }).catch(() => null);
    }
    void invoke("ares_daemon_command", {
      command: { type: "routing_mode", enabled: prefsRef.current.routingMode === "auto" },
    }).catch(() => null);
    // populate the status bar's mission count + rail's disk-session log
    void invoke("ares_daemon_command", { command: { type: "operator_status" } }).catch(() => null);
    void invoke("ares_daemon_command", { command: { type: "sessions_list" } }).catch(() => null);
    const queued = pendingGoal.current;
    if (queued) {
      pendingGoal.current = null;
      void invoke("ares_send", { goal: queued.goal, sessionId: queued.sessionId }).catch((err) => {
        applyTo(queued.sessionId, (s) => ({ ...foldEvent(s, { type: "desktop_error", text: String(err) }), busy: false }));
      });
    }
  }, [native, applyTo]);

  // ── daemon boot + event ingestion (native only) ──────────────────────────
  useEffect(() => {
    if (!native) return;
    let mounted = true;
    let poller: number | null = null;
    let unlisten: (() => void) | undefined;

    const handleShellEvent = (e: AresEvent): boolean => {
      switch (e.type) {
        case "daemon_ready":
          pushLog(`[garrison] ready · session ${e.sessionId ?? ""}`);
          onDaemonReady(e);
          window.dispatchEvent(new CustomEvent("ares:daemon-ready"));
          return true;
        case "daemon_stderr": {
          const line = e.text ?? "";
          stderrTail.current = [...stderrTail.current.slice(-19), line];
          pushLog(`[stderr] ${line}`);
          return true;
        }
        case "daemon_stdout":
          pushLog(`[stdout] ${e.text ?? ""}`);
          return true;
        case "interrupted_by_user":
          pushLog("[garrison] turn interrupted by user");
          // The daemon confirmed the abort — free the session that owned the
          // turn (not just whatever card is focused now) so its composer unlocks.
          applyTo(e.sessionId ?? activeRef.current, (s) => ({ ...s, busy: false, steerQueued: 0, activity: undefined }));
          return true;
        case "reasoning_set":
        case "routing_set":
        case "routing_mode_set":
        case "model_switched":
        case "openrouter_key_set":
        case "provider_key_set":
        case "engine_config_set":
        case "skill_toggle_set":
          pushLog(`[garrison] ${e.type}`);
          if (e.type === "provider_key_set" && e.provider) {
            setKeyStatus((current) => ({ ...current, [e.provider!]: e.hasKey === true }));
          }
          if (e.type === "skill_toggle_set") daemonCmd({ type: "skills_list" });
          return true;
        case "anthropic_login_url": {
          // Daemon started the loopback server and opened the browser — just
          // show the waiting state. Code arrives automatically via the redirect.
          if (e.url) void invoke("ares_open_url", { url: String(e.url) }).catch(() => null);
          setAnthropicAuth({ open: true, status: "waiting" });
          return true;
        }
        case "anthropic_login_done": {
          if (e.ok) {
            setAnthropicAuth({ open: true, status: "done" });
            window.setTimeout(() => {
              daemonCmd({ type: "model_switch", provider: prefsRef.current.provider, model: prefsRef.current.model });
              setAnthropicAuth({ open: false, status: "idle" });
            }, 1400);
          } else {
            setAnthropicAuth({ open: true, status: "error", error: String(e.error ?? "sign-in failed") });
          }
          return true;
        }
        case "consciousness_status": {
          const models = Array.isArray(e.models) ? (e.models as ConsciousnessModelVm[]) : [];
          setConsciousness((c) => ({
            ...c,
            enabled: e.enabled === true,
            downloading: e.downloading === true,
            watching: e.watching === true,
            engineInstalled: e.engineStatus?.binaryInstalled === true,
            engineAvailable: e.engineStatus?.available === true,
            models,
            ready: models.length > 0 && models.every((m) => m.present),
          }));
          return true;
        }
        case "consciousness_set":
          setConsciousness((c) => ({
            ...c,
            enabled: e.enabled === true,
            watching: e.enabled === true ? c.watching : false,
            paused: e.enabled === true ? c.paused : false,
            error: undefined,
          }));
          return true;
        case "consciousness_observation":
          setConsciousness((c) => ({
            ...c,
            watching: true,
            paused: false,
            lastObservation: e.observation,
            lastComment: e.spoke && e.comment ? e.comment : c.lastComment,
            lastObservationAt: typeof e.at === "number" ? e.at : Date.now(),
          }));
          if (e.spoke && e.comment) pushLog(`[watch] ${e.comment}`);
          return true;
        case "consciousness_killed":
          setConsciousness((c) => ({ ...c, enabled: false, watching: false, paused: false }));
          pushLog("[watch] killswitch — consciousness halted");
          return true;
        case "consciousness_paused":
          setConsciousness((c) => ({ ...c, watching: false, paused: true }));
          pushLog(`[watch] looking away${typeof e.seconds === "number" ? ` (${e.seconds}s)` : ""}`);
          return true;
        case "consciousness_resumed":
          setConsciousness((c) => ({ ...c, paused: false }));
          daemonCmd({ type: "consciousness_status" });
          return true;
        case "consciousness_cancelled":
          daemonCmd({ type: "consciousness_status" });
          return true;
        case "consciousness_progress": {
          if (e.id) {
            const id = e.id;
            const pct = e.pct ?? 0;
            setConsciousness((c) => ({ ...c, downloading: true, progress: { ...c.progress, [id]: pct } }));
          }
          return true;
        }
        case "consciousness_model_ready":
          daemonCmd({ type: "consciousness_status" });
          return true;
        case "consciousness_ready":
          setConsciousness((c) => ({ ...c, downloading: false, ready: true }));
          daemonCmd({ type: "consciousness_status" });
          return true;
        case "consciousness_error":
          setConsciousness((c) => ({ ...c, downloading: false, error: String(e.error ?? "download failed") }));
          return true;
        case "skills_list":
          setSkills(Array.isArray(e.skills) ? (e.skills as SkillInfo[]) : []);
          return true;
        case "usage_stats":
          setUsageStats((e.stats as UsageStats | null) ?? null);
          return true;
        case "model_catalog":
          window.dispatchEvent(new CustomEvent("ares:model-catalog", {
            detail: {
              provider: e.provider,
              models: Array.isArray(e.models) ? e.models : [],
            },
          }));
          return true;
        case "operator_status":
          setOpStatus({
            activeCount: typeof e.activeCount === "number" ? e.activeCount : 0,
            goals: Array.isArray(e.goals) ? (e.goals as Array<{ id: string; statement: string; status: string; progress: number }>) : [],
            autotick: e.autotick !== false,
            trust: Array.isArray(e.trust) ? (e.trust as Array<{ domain: string; level: number; proven: number }>) : [],
          });
          return true;
        case "gateway_account":
          setGatewayAccount(e as unknown as GatewayAccountVm);
          return true;
        case "gateway_grant": {
          // A credit grant landed while the app is open — ember toast, live.
          const usd = typeof e.amount_usd === "number" ? `+$${e.amount_usd.toFixed(2)}` : "+credits";
          pushGatewayToast(`${usd} credits${e.reason ? ` — ${e.reason}` : ""}`);
          return true;
        }
        case "bug_report_result": {
          setReportBusy(false);
          pushGatewayToast(e.ok ? "🐛 Bug report sent — thank you, this helps improve Ares." : `Report failed: ${e.error ? stringify(e.error) : "unknown"}`);
          if (e.ok) setReportOpen(false);
          return true;
        }
        case "custom_models":
          // Server-side discovery result for the Custom provider card to consume.
          window.dispatchEvent(new CustomEvent("ares:custom-models", { detail: e }));
          return true;
        case "mcp_directory": {
          const list = (e as { connectors?: unknown }).connectors;
          if (Array.isArray(list)) setMcpConnectors(list as McpConnectorVm[]);
          return true;
        }
        case "mcp_connect_result":
          setMcpConnecting(null);
          pushGatewayToast(e.ok ? `🔌 Connected ${e.name ?? "connector"} — its tools are live.` : `Connect failed: ${e.error ? stringify(e.error) : "unknown"}`);
          return true;
        case "channel.status":
          if (Array.isArray((e as any).channels)) setChannelStatus((e as any).channels);
          return true;
        case "channel.roster":
          setChannelRoster((prev: any) => ({ ...prev, [(e as any).channel]: (e as any).participants }));
          return true;
        case "channel.event":
          pushLog(`[${(e as any).channel}] ${(e as any).event}${(e as any).detail ? `: ${(e as any).detail}` : ""}`);
          return true;
        case "oauth_status":
          if (Array.isArray(e.providers)) setOauthProviders(e.providers as OAuthProviderVm[]);
          return true;
        case "oauth_url":
          // The daemon's callback server is up; open the consent page in the
          // user's REAL browser (codecs, logins, no automation flags).
          if (e.url) void invoke("ares_open_url", { url: e.url }).catch(() => null);
          return true;
        case "oauth_connected":
          pushLog(`[oauth] ${e.provider ?? "service"} connected`);
          if (e.provider === "ares") pushGatewayToast("🐉 Ares account connected — models and credits are live.");
          else daemonCmd({ type: "oauth_status" });
          return true;
        case "oauth_disconnected":
        case "oauth_credentials_set":
          daemonCmd({ type: "oauth_status" });
          return true;
        case "oauth_error":
          pushLog(`[oauth] ${e.provider ?? "service"} failed: ${e.error ? stringify(e.error) : "unknown"}`);
          if (e.provider === "ares") pushGatewayToast(`Sign-in failed: ${e.error ? stringify(e.error) : "unknown"}`);
          return true;
        case "sessions_list": {
          const disk = Array.isArray(e.sessions) ? (e.sessions as SessionSummaryWire[]) : [];
          pushLog(`[garrison] ${disk.length} sessions on disk`);
          setSessions((current) => {
            const byId = new Map(current.map((session) => [session.id, session]));
            const merged = disk.map((summary) => {
              const existing = byId.get(summary.id);
              if (!existing) return sessionFromSummary(summary);
              // A rename done on disk (meta.label) should refresh the rail title.
              if (summary.label) {
                const next = compact(summary.label, 42);
                if (existing.title !== next) return { ...existing, title: next };
              }
              return existing;
            });
            const localOnly = current.filter((session) => !disk.some((summary) => summary.id === session.id));
            return [...localOnly, ...merged];
          });
          return true;
        }
        case "session_deleted": {
          if (e.id && e.ok !== false) {
            setSessions((current) => current.filter((session) => session.id !== e.id));
            if (activeRef.current === e.id) activeRef.current = "";
          }
          return true;
        }
        case "session_renamed": {
          if (e.id && e.ok !== false) {
            const label = typeof e.label === "string" ? e.label : "";
            setSessions((current) => current.map((session) => (
              session.id === e.id ? { ...session, title: label ? compact(label, 42) : session.title } : session
            )));
          }
          return true;
        }
        case "session_history":
          if (e.id) {
            const hydrated = sessionFromHistory(e.id, e.messages, e.meta);
            setSessions((current) => current.map((session) => (
              session.id === e.id ? { ...hydrated, updatedAt: session.updatedAt } : session
            )));
          }
          return true;
        case "lifecycle":
          pushLog(`[lifecycle] ${compact(stringify(e.event ?? {}), 200)}`);
          return true;
        case "desktop_daemon_started":
          pushLog(`[shell] daemon started (${e.provider ?? "default"} / ${e.model ?? "default"})`);
          return true;
        case "desktop_daemon_restarting":
          setDaemon("starting");
          pushLog("[shell] daemon restarting");
          return true;
        case "desktop_daemon_stopped":
          setDaemon("stopped");
          pushLog("[shell] daemon stopped");
          return true;
        case "desktop_daemon_stream_closed":
          pushLog("[shell] daemon stream closed");
          return true;
        case "desktop_daemon_exited": {
          pushLog(`[shell] daemon exited · code ${e.code ?? "unknown"}`);
          setDaemon("error");
          const tail = stderrTail.current.slice(-4).join("\n");
          const attempt = restartAttempts.current;
          const willRetry = attempt < MAX_AUTO_RESTARTS;
          const errorText =
            `The Garrison went down (exit code ${e.code ?? "unknown"}).` +
            (tail ? `\n${tail}` : "") +
            (willRetry ? `\nRestarting… (attempt ${attempt + 1}/${MAX_AUTO_RESTARTS})` : "\nAuto-restart limit reached — use Restart in the status bar.");
          // A daemon crash kills every in-flight turn, not just the one the
          // user is currently looking at — sweep ALL busy sessions so
          // background cards don't stay stuck forever with no error shown.
          setSessions((prev) =>
            prev.map((s) => (s.busy ? { ...foldEvent(s, { type: "desktop_error", text: errorText }), busy: false } : s)),
          );
          if (willRetry) {
            restartAttempts.current += 1;
            window.setTimeout(() => restartDaemon(), 900 * (attempt + 1));
          }
          return true;
        }
        default:
          return false;
      }
    };

    const ingest = (buffered: BufferedEvent) => {
      if (!mounted || buffered.seq <= lastSeq.current) return;
      lastSeq.current = buffered.seq;
      if (handleShellEvent(buffered.event)) return;
      // Route the event to the session it belongs to (multi-session daemon
      // tags every event with sessionId). Untagged events go to the active card.
      const sid = (buffered.event as { sessionId?: string }).sessionId;
      // Surface attention-worthy events as OS notifications when you're not
      // looking at this session/window — so overnight & background work is visible.
      const ev = buffered.event;
      // Feed the composer's token-flow strip: count every streamed character of
      // the session you're LOOKING at (text, thinking, tool-input authoring).
      // One integer addition on a module-level accumulator — no React involved.
      if (!sid || sid === activeRef.current) {
        if ((ev.type === "text_delta" || ev.type === "thinking_delta") && ev.text) pushTokenFlow(ev.text.length);
        else if (ev.type === "tool_use_input_delta" && ev.deltaJson) pushTokenFlow(ev.deltaJson.length);
      }
      const elsewhere = document.hidden || (!!sid && sid !== activeRef.current);
      if (ev.type === "permission_request" && elsewhere) {
        fireNotification("Ares needs your approval", ev.reason || ev.toolName || "A tool needs your OK");
      } else if (ev.type === "turn_end" && elsewhere) {
        fireNotification("Ares finished a task", "A background turn just completed.");
      }
      // Live browser frame — Ares driving its own embedded browser. Don't fold
      // into the transcript; push it to the Forge "Live" panel and open it.
      if (ev.type === "tool_progress" && ev.data?.kind === "browser_frame" && ev.data.image) {
        setLiveBrowser({ frame: ev.data.image, at: Date.now() });
        setForge((f) => (f.open && f.tab === "live" ? f : { ...f, open: true, tab: "live" }));
        return;
      }
      // Embedded-browser command from the daemon — drive Ares's in-app browser and
      // return the result over the same channel. This is the request/response
      // bridge that lets the agent operate its own embedded browser.
      if ((ev as { type?: string }).type === "webview_cmd") {
        const c = ev as unknown as { cmdId?: string; op?: string; html?: string; query?: string; selector?: string; value?: string; js?: string; onlyErrors?: boolean };
        void (async () => {
          let ok = true, result: unknown, error: string | undefined;
          try {
            if (c.op === "load") {
              setEmbeddedActive(true);
              setForge((f) => ({ ...f, open: true, tab: "live" }));
              let h = embeddedRef.current;
              for (let i = 0; i < 40 && !h; i++) { await new Promise((r) => setTimeout(r, 33)); h = embeddedRef.current; }
              if (!h) throw new Error("embedded browser unavailable");
              result = await h.load(c.html ?? "");
            } else {
              const h = embeddedRef.current;
              if (!h) throw new Error("nothing loaded — call load first");
              if (c.op === "click") result = await h.click(c.query ?? "");
              else if (c.op === "type") result = await h.type(c.selector ?? "", c.value ?? "");
              else if (c.op === "eval") result = await h.evalJs(c.js ?? "");
              else if (c.op === "console") result = h.getConsole(c.onlyErrors);
              else if (c.op === "snapshot") result = h.snapshot();
              else throw new Error(`unknown webview op: ${c.op}`);
            }
          } catch (err) { ok = false; error = err instanceof Error ? err.message : String(err); }
          if (native) void invoke("ares_daemon_command", { command: { type: "webview_result", cmdId: c.cmdId, ok, result, error } }).catch(() => {});
        })();
        return;
      }
      const fold = (s: SessionVm) => {
        const next = foldEvent(s, buffered.event);
        if (next.title === "New session") {
          const firstUser = next.items.find((i) => i.kind === "user");
          if (firstUser && firstUser.kind === "user") next.title = compact(firstUser.text, 42);
        }
        return next;
      };
      if (sid) applyTo(sid, fold);
      else apply(fold);
    };

    const poll = async () => {
      try {
        const events = await invoke<BufferedEvent[]>("ares_drain_events", { after: lastSeq.current });
        for (const b of events) ingest(b);
      } catch {
        /* daemon between states */
      }
    };

    const boot = async () => {
      try {
        unlisten = await listen<BufferedEvent>("ares:event-buffered", (ev) => ingest(ev.payload));
      } catch {
        /* polling covers it */
      }
      try {
        const state = await invoke<DaemonStatus>("ares_start_daemon", { provider: prefsRef.current.provider, model: prefsRef.current.model });
        if (!mounted) return;
        setDaemon(state.running ? "running" : "stopped");
      } catch (err) {
        if (!mounted) return;
        setDaemon("error");
        apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
      }
      // A touch longer so the boot can play its full three-beat ignition + a
      // forge-bloom exit (Boot owns the exit anim; this is the hard unmount).
      window.setTimeout(() => mounted && setBootGone(true), 2150);
      void poll();
      // The push listener (ares:event-buffered) carries events in real time;
      // this poll is just a slow reconciliation net for any missed push, so it
      // runs every 4s instead of hammering every 1s (B5 — lower idle CPU).
      poller = window.setInterval(() => void poll(), 4000);
    };
    void boot();
    return () => {
      mounted = false;
      if (poller !== null) window.clearInterval(poller);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  // autoscroll ONLY when the user is already near the bottom — reading history
  // mid-stream never yanks them down. A "jump to latest" pill appears otherwise.
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [active?.items, pinned]);

  const onChatScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setPinned(nearBottom);
  }, []);
  const jumpToLatest = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, []);

  // ── intents ──────────────────────────────────────────────────────────────
  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Slash command: "/mcp" (or /connectors) opens the connector Directory
    // instead of sending a message — the one-word way in the user asked for.
    if (/^\/(mcp|connectors?)$/i.test(trimmed)) {
      setDirectoryOpen(true);
      daemonCmd({ type: "mcp_list" });
      return;
    }
    const sid = activeRef.current;
    // ULTRA posture: steer the agent toward the Conductor fleet for this turn.
    // Prepended to the GOAL the daemon receives (provider-agnostic) but NOT shown
    // in the transcript — the user's message stays clean.
    const ultraDirective = prefsRef.current.ultra
      ? "[ULTRA MODE — fleet by default] Run this task as a parallel agent FLEET unless it is trivial or purely conversational (a one-line answer, a single tiny edit, a greeting). Your FIRST move should be the Conductor tool: author a FleetSpec that fans out the independent angles, then reduce:\"judge\" to synthesize — do NOT do it as one linear pass and do NOT hand-roll what a fleet should do. Any task with research, multi-file or multi-angle review, design options, audits, refactors, or broad sweeps QUALIFIES — when in doubt, spawn the fleet. If you genuinely cannot decompose it, say so in one line, then proceed normally.\n\n---\n\n"
      : "";
    const goal = ultraDirective + trimmed;
    applyTo(sid, (s) => ({
      ...s,
      title: s.title === "New session" ? compact(trimmed, 42) : s.title,
      items: [...s.items, { kind: "user", key: nextKey(), text: trimmed }],
      busy: true,
    }));
    if (native) {
      if (daemon !== "running") {
        pendingGoal.current = { goal, sessionId: sid };
        applyTo(sid, (s) => foldEvent(s, { type: "system_reminder_injected", source: "verifier", text: "Garrison is down — restarting, your message is queued." }));
        restartDaemon();
        return;
      }
      void invoke("ares_send", { goal, sessionId: sid }).catch((err) => {
        pendingGoal.current = { goal: trimmed, sessionId: sid };
        applyTo(sid, (s) => ({ ...foldEvent(s, { type: "desktop_error", text: `${String(err)} — restarting the Garrison, message queued.` }), busy: true }));
        restartDaemon();
      });
    } else {
      window.setTimeout(() => apply((s) => foldEvent(s, { type: "turn_start" })), 150);
      // Demo mode shows the delegation CHOICE popup when asked which coder to use.
      if (/should i|which coder|use claude code or|do it yourself/i.test(trimmed)) {
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "permission_request", id: "demo-offer", toolName: "CodingBackend:offer", reason: "Hand this to Claude Code (runs on your Ares account — no login needed), or have Ares do it directly?" })), 400);
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "turn_end", status: "completed", durationMs: 600, usage: { inputTokens: 500, outputTokens: 0 } })), 700);
        return;
      }
      // Demo mode shows the delegation cut-scene when the message mentions a
      // backend — so the feature is visible without a daemon (and demoable).
      if (/claude code|codex|delegate/i.test(trimmed)) {
        const backend = /codex/i.test(trimmed) ? "codex" : "claude";
        const label = backend === "codex" ? "Codex" : "Claude Code";
        const cb = (data: Record<string, unknown>, t: number) =>
          window.setTimeout(() => apply((s) => foldEvent(s, { type: "tool_progress", id: "demo-cb", data: { kind: "coding_backend", backend, label, ...data } })), t);
        cb({ phase: "detect" }, 300);
        cb({ phase: "running", version: "1.0.0" }, 1400);
        cb({ phase: "running", line: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/mod.lua"}}]}}' }, 2500);
        cb({ phase: "running", line: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/hud.lua"}}]}}' }, 3600);
        cb({ phase: "done", filesTouched: 2 }, 4800);
        const reply = `Demo — I delegated to ${label} on the Ares account. In the installed app this drives the real CLI, no login needed.`;
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "text_delta", text: reply })), 5100);
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "turn_end", status: "completed", durationMs: 5400, usage: { inputTokens: 4000, outputTokens: 300 } })), 5400);
        return;
      }
      // ULTRA in demo mode shows a sample fleet so the board is visible without a daemon.
      if (prefsRef.current.ultra) {
        const fa = (data: Record<string, unknown>, t: number) =>
          window.setTimeout(() => apply((s) => foldEvent(s, { type: "tool_progress", id: "demo-fleet", data })), t);
        const crew = [
          { id: "a1", role: "correctness", phase: "review" },
          { id: "a2", role: "security", phase: "review" },
          { id: "a3", role: "performance", phase: "review" },
        ];
        crew.forEach((c, i) => {
          fa({ kind: "fleet_activity", event: "start", agentId: c.id, role: c.role, phase: c.phase }, 300 + i * 250);
          fa({ kind: "fleet_activity", event: "tool", agentId: c.id, role: c.role, phase: c.phase, tool: "Grep", activity: "scanning the diff" }, 1200 + i * 350);
          fa({ kind: "fleet_activity", event: "done", agentId: c.id, role: c.role, phase: c.phase, status: "completed" }, 3200 + i * 600);
        });
        fa({ kind: "fleet_activity", event: "start", agentId: "judge", role: "review-judge", phase: "review" }, 5200);
        fa({ kind: "fleet_activity", event: "done", agentId: "judge", role: "review-judge", phase: "review", status: "completed" }, 6400);
        const reply = "Demo fleet complete — 3 reviewers fanned out, one judge synthesized. In the installed app this is a real Conductor run.";
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "text_delta", text: reply })), 6700);
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "turn_end", status: "completed", durationMs: 7000, usage: { inputTokens: 9000, outputTokens: 600 } })), 7000);
        return;
      }
      const reply = "Demo mode — no daemon attached. In the installed app this streams from the Garrison.";
      reply.split(" ").forEach((word, i) => {
        window.setTimeout(() => {
          pushTokenFlow(word.length + 1); // demo mode still animates the token-flow strip
          apply((s) => foldEvent(s, { type: "text_delta", text: `${word} ` }));
        }, 300 + i * 40);
      });
      window.setTimeout(
        () => apply((s) => foldEvent(s, { type: "turn_end", status: "completed", durationMs: 1400, usage: { inputTokens: 220, outputTokens: 18 } })),
        400 + reply.split(" ").length * 40,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, daemon, applyTo]);

  /** Steer: queue a message mid-turn; the daemon folds it in at a safe boundary. */
  const steer = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const sid = activeRef.current;
    applyTo(sid, (s) => ({
      ...s,
      items: [...s.items, { kind: "steer", key: nextKey(), text: trimmed }],
      steerQueued: (s.steerQueued ?? 0) + 1,
    }));
    if (native) void invoke("ares_daemon_command", { command: { type: "steer", text: trimmed, sessionId: sid } }).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, applyTo]);

  const stopTurn = useCallback(() => {
    const sid = activeRef.current;
    // Free the UI immediately — never wait on the daemon round-trip. If the turn
    // is wedged (no turn_end ever arrives) waiting would leave Stop feeling dead
    // and the composer frozen. Clearing busy + steer here re-enables input now;
    // the daemon abort below tears down the real turn.
    applyTo(sid, (s) => ({
      ...s,
      busy: false,
      steerQueued: 0,
      activity: undefined,
      items: s.items.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it)),
    }));
    if (native) void invoke("ares_interrupt", { sessionId: sid }).catch(() => null);
    else applyTo(sid, (s) => foldEvent(s, { type: "turn_end", status: "interrupted", durationMs: 0 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, applyTo]);

  const undoLastChange = useCallback(() => {
    if (!native || daemon !== "running" || active?.busy) return;
    daemonCmd({ type: "undo", sessionId: activeRef.current, depth: 1 });
  }, [active?.busy, daemon, daemonCmd, native]);

  /** Kick off the Anthropic (Claude Pro/Max) browser sign-in. */
  const startAnthropicSignIn = useCallback(() => {
    setAnthropicAuth({ open: true, status: "opening" });
    if (native) daemonCmd({ type: "anthropic_login_start" });
    else setAnthropicAuth({ open: true, status: "error", error: "sign-in needs the daemon (installed app)." });
  }, [native, daemonCmd]);

  // finishAnthropicSignIn no longer needed — loopback flow handles it automatically.

  const openSession = useCallback((id: string) => {
    setActiveId(id);
    setView("chat");
    const target = sessions.find((session) => session.id === id);
    if (native && target && target.loaded === false && !target.loading) {
      setSessions((current) => current.map((session) => (
        session.id === id ? { ...session, loading: true } : session
      )));
      daemonCmd({ type: "session_history", id });
    }
  }, [daemonCmd, native, sessions]);

  const newSession = () => {
    // A new chat is just a new card — the multi-session daemon lazily spawns an
    // isolated session for it on first message. NEVER restart the daemon here
    // (that would kill every other running chat).
    const fresh = freshSession();
    setSessions((prev) => [fresh, ...prev]);
    openSession(fresh.id);
  };

  const respondPermission = (id: string, decision: string) => {
    // Route the answer to the session that actually raised this prompt (B4) —
    // a permission request from a background chat must never resolve into
    // whatever card happens to be focused now.
    const owner = sessions.find((s) => s.items.some((it) => it.kind === "permission" && it.id === id));
    if (owner) applyTo(owner.id, (s) => foldEvent(s, { type: "permission_response", id, decision }));
    else apply((s) => foldEvent(s, { type: "permission_response", id, decision }));
    if (native) void invoke("ares_permission_response", { id, decision }).catch(() => null);
  };

  const applySettings = (next: Prefs, keys: Record<string, string>) => {
    setPrefs(next);
    savePrefs(next);
    setSettingsOpen(false);
    if (!native) return;
    const applyLive = async () => {
      // Persist settings through the live daemon. Normal preferences must not
      // kill in-memory sessions or force a transcript restore.
      for (const [provider, key] of Object.entries(keys)) {
        if (!key.trim()) continue;
        await invoke("ares_set_provider_key", {
          provider,
          key: key.trim(),
          model: provider === next.provider ? next.model : null,
        }).catch(() => null);
      }
      if (Object.keys(next.routing).length > 0 || Object.keys(prefs.routing).length > 0) {
        await invoke("ares_set_routing", { routing: next.routing }).catch(() => null);
      }
      await invoke("ares_daemon_command", {
        command: { type: "routing_mode", enabled: next.routingMode === "auto" },
      }).catch(() => null);
      await invoke("ares_daemon_command", { command: { type: "engine_config", config: next.engine } }).catch(() => null);
      await invoke("ares_set_reasoning", { level: next.reasoning }).catch(() => null);
      if (next.provider !== prefs.provider || next.model !== prefs.model) {
        await invoke("ares_daemon_command", {
          command: { type: "model_switch", provider: next.provider, model: next.model },
        }).catch(() => null);
      }
    };
    void applyLive();
  };

  const currentEffort: EffortStep = prefs.ultra ? "ultra" : prefs.reasoning;
  // One control for the whole slider. ULTRA pins the model dial to "max" and
  // raises the fleet flag; every other step is a plain reasoning level.
  const setEffort = (step: EffortStep) => {
    const ultra = step === "ultra";
    const reasoning: ReasoningLevel = ultra ? "max" : step;
    const p = { ...prefs, reasoning, ultra };
    setPrefs(p);
    savePrefs(p);
    // The daemon only knows the four model levels — ultra rides as "max" until
    // the orchestrator is wired to consume the fleet flag.
    if (native) void invoke("ares_set_reasoning", { level: reasoning }).catch(() => null);
  };
  const cycleReasoning = () => {
    const next = EFFORT_STEPS[(EFFORT_STEPS.indexOf(currentEffort) + 1) % EFFORT_STEPS.length];
    setEffort(next);
  };

  const FLAME_MODES: Prefs["flameMode"][] = ["immersive", "clean", "combat"];
  const cycleFlame = () => {
    const next = FLAME_MODES[(FLAME_MODES.indexOf(prefs.flameMode) + 1) % FLAME_MODES.length];
    const p = { ...prefs, flameMode: next };
    setPrefs(p);
    savePrefs(p);
  };

  // ── the Forge ─────────────────────────────────────────────────────────────
  const [sandboxCode, setSandboxCode] = useState(SANDBOX_SEED);
  const [sandboxSrc, setSandboxSrc] = useState<{ src?: string; srcdoc?: string } | null>(null);
  const [holoSrc, setHoloSrc] = useState<{ src?: string; srcdoc?: string } | null>(null);

  const [holoMeta, setHoloMeta] = useState<string>("MECH MK I — built-in showpiece");

  /** Render an agent-forged HoloSpec through the real holotable engine. */
  const openHoloSpec = useCallback(
    async (path: string, label: string) => {
      try {
        const raw = native ? await invoke<string>("ares_read_text_file", { path }) : "";
        const spec = JSON.parse(raw) as HoloSpec;
        validateHoloSpec(spec);
        const html = buildHolotableHtml({ spec });
        if (native) {
          const out = await invoke<string>("ares_forge_write", { name: "holo-spec", html });
          setHoloSrc({ src: `${convertFileSrc(out)}?t=${Date.now()}` });
        } else {
          setHoloSrc({ srcdoc: html });
        }
        setHoloMeta(`${spec.title} — ${spec.parts.length} parts · ${spec.wires?.length ?? 0} wires · ${spec.steps?.length ?? 0} steps`);
        setForge({ open: true, tab: "holo", artifact: { path, label } });
      } catch (err) {
        apply((s) => foldEvent(s, { type: "desktop_error", text: `holotable: ${String(err instanceof Error ? err.message : err)}` }));
      }
    },
    [native, apply],
  );

  const openArtifact = (path: string, label: string) => {
    if (HOLO_SPEC_FILE.test(path)) {
      void openHoloSpec(path, label);
      return;
    }
    // A pre-built holotable HTML (filename contains "holo") belongs in the HOLO
    // section, not the flat preview — otherwise the holo panel looks redundant.
    if (/holo[\w-]*\.html?$/i.test(path)) {
      if (native) {
        setHoloSrc({ src: `${convertFileSrc(path)}?t=${Date.now()}` });
        setHoloMeta(label);
        setForge({ open: true, tab: "holo", artifact: { path, label } });
        return;
      }
    }
    setForge({ open: true, tab: "preview", artifact: { path, label } });
  };

  const runSandbox = useCallback(
    async (code: string) => {
      if (native) {
        try {
          const path = await invoke<string>("ares_forge_write", { name: "sandbox", html: code });
          setSandboxSrc({ src: `${convertFileSrc(path)}?t=${Date.now()}` });
        } catch (err) {
          apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
        }
      } else {
        setSandboxSrc({ srcdoc: code });
      }
    },
    [native, apply],
  );

  const igniteHolo = useCallback(async () => {
    if (holoSrc) return;
    if (native) {
      try {
        const path = await invoke<string>("ares_forge_write", { name: "holo", html: holoDefaultHtml() });
        setHoloSrc({ src: `${convertFileSrc(path)}?t=${Date.now()}` });
      } catch (err) {
        apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
      }
    } else {
      setHoloSrc({ srcdoc: holoDefaultHtml() });
    }
  }, [native, holoSrc, apply]);

  useEffect(() => {
    if (forge.open && forge.tab === "holo") void igniteHolo();
    if (forge.open && forge.tab === "sandbox" && !sandboxSrc) void runSandbox(SANDBOX_SEED);
  }, [forge, igniteHolo, runSandbox, sandboxSrc]);

  // Web links in the transcript/vault are <a target="_blank">, which a Tauri
  // webview won't route to the system browser on its own. Intercept clicks and
  // hand them to the validated ares_open_url command so cited sources actually open.
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      const anchor = (ev.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      ev.preventDefault();
      void invoke("ares_open_url", { url: href }).catch(() => null);
    };
    document.addEventListener("click", onClick);
    // Ask once for OS-notification permission so background/permission alerts work.
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission().catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    return () => document.removeEventListener("click", onClick);
  }, []);

  // auto-open the Forge when an artifact lands
  const artifactCount = active?.items.filter((i) => i.kind === "artifact").length ?? 0;
  const lastArtifactCount = useRef(artifactCount);
  useEffect(() => {
    if (artifactCount > lastArtifactCount.current) {
      const latest = [...(active?.items ?? [])].reverse().find((i) => i.kind === "artifact");
      if (latest && latest.kind === "artifact") {
        setForge({ open: true, tab: "preview", artifact: { path: latest.path, label: latest.label } });
      }
    }
    lastArtifactCount.current = artifactCount;
  }, [artifactCount, active?.items]);

  const onForgeGrip = (down: React.PointerEvent) => {
    down.preventDefault();
    const startX = down.clientX;
    const startW = forgeWidth;
    const move = (e: PointerEvent) => {
      const w = Math.min(Math.max(startW + (startX - e.clientX), 340), Math.round(window.innerWidth * 0.62));
      setForgeWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── command palette (Ctrl+K) ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setPaletteOpen(false);
        setModelPopOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Notify themeable canvases (mermaid diagrams) so they re-tint on a war-band switch.
  useEffect(() => {
    window.dispatchEvent(new Event("ares-theme"));
  }, [prefs.theme]);

  const paletteActions: PaletteAction[] = [
    { label: "New session", hint: "fresh Garrison session", run: newSession },
    { label: "Undo last agent change", hint: "restore the latest workspace checkpoint", run: undoLastChange },
    { label: forge.open ? "Close the Forge" : "Open the Forge", hint: "artifact / sandbox / holotable panel", run: () => setForge((f) => ({ ...f, open: !f.open })) },
    { label: "Forge: preview", hint: "latest artifact", run: () => setForge((f) => ({ ...f, open: true, tab: "preview" })) },
    { label: "Forge: sandbox", hint: "live HTML scratchpad", run: () => setForge((f) => ({ ...f, open: true, tab: "sandbox" })) },
    { label: "Forge: holotable", hint: "3D build engine", run: () => setForge((f) => ({ ...f, open: true, tab: "holo" })) },
    { label: "Settings", hint: "provider · model · keys", run: () => setSettingsOpen(true) },
    { label: "Connectors — the Directory", hint: "/mcp · connect tools & apps", run: () => { setDirectoryOpen(true); daemonCmd({ type: "mcp_list" }); } },
    { label: "Switch model", hint: `current: ${prefs.routingMode === "auto" ? "routing (auto)" : prefs.model}`, run: () => setModelPopOpen(true) },
    { label: "Routing — the war table", hint: "per-lane model assignments", run: () => setRoutingOpen(true) },
    { label: `Reasoning effort (now ${prefs.reasoning})`, hint: "low / medium / high / max", run: () => setReasoningOpen(true) },
    { label: "Garrison: restart", hint: "bounce the daemon", run: () => { restartAttempts.current = 0; restartDaemon(); } },
    { label: "Garrison: panel", hint: "status + live log", run: () => setGarrisonOpen(true) },
    ...sessions.map((s) => ({ label: `Jump: ${s.title}`, hint: "session", run: () => openSession(s.id) })),
  ];

  // ── window chrome ─────────────────────────────────────────────────────────
  const dragWindow = (e: React.MouseEvent) => {
    if (!native || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea")) return;
    if (e.detail === 2) {
      void invoke("ares_window_toggle_maximize").catch(() => null);
    } else {
      void getCurrentWindow()
        .startDragging()
        .catch(() => null);
    }
  };

  // ── floating pill: condense Ares to an always-on-top mic bar ───────────────
  const PILL_W = 320;
  const PILL_H = 60;
  const enterPill = useCallback(async () => {
    if (native) {
      try {
        const w = getCurrentWindow();
        const [size, pos] = await Promise.all([w.outerSize(), w.outerPosition()]);
        prePillGeom.current = { size, pos };
        await w.setResizable(false);
        await w.setAlwaysOnTop(pinTop);
        await w.setSize(new LogicalSize(PILL_W, PILL_H));
        // tuck it to the top-right of where the window was
        const sf = await w.scaleFactor();
        await w.setPosition(new PhysicalPosition(Math.round(pos.x + size.width - PILL_W * sf), pos.y));
      } catch {
        /* even if the window ops fail, still show the pill UI */
      }
    }
    setPill(true);
  }, [native, pinTop]);

  const exitPill = useCallback(async () => {
    if (native) {
      try {
        const w = getCurrentWindow();
        await w.setAlwaysOnTop(false);
        await w.setResizable(true);
        const g = prePillGeom.current;
        if (g) {
          await w.setSize(g.size);
          await w.setPosition(g.pos);
        } else {
          await w.setSize(new LogicalSize(1280, 820));
        }
      } catch {
        /* ignore — UI still expands */
      }
    }
    setPill(false);
  }, [native]);

  const togglePinTop = useCallback(async () => {
    const next = !pinTop;
    setPinTop(next);
    if (native && pill) {
      try { await getCurrentWindow().setAlwaysOnTop(next); } catch { /* noop */ }
    }
  }, [native, pill, pinTop]);

  const routedLanes = ROUTE_LANES.filter((l) => prefs.routing[l]);
  // The model that ACTUALLY handled this session's last turn (sticky/lane/
  // In MANUAL mode the footer is SOLID: it always shows the model the user
  // picked (prefs.model), never the per-turn model — so a one-off route or a
  // transient failover can't make the readout look like the selection changed.
  // What actually ran is still surfaced per-message (the assistant badge). In
  // auto mode the routed per-turn model IS the point, so show it there.
  const liveModelId = prefs.routingMode === "auto" ? (active?.turnModel ?? "routing (auto)") : prefs.model;
  // Gateway models are white-labeled: the footer chip shows the friendly name
  // ("Model Ares (in house)"), never the raw virtual id or the upstream model.
  // "ares-internal" is the house sentinel — resolve it to the crowned model's name.
  const houseModel = gatewayAccount?.models?.find((m) => m.is_house);
  const liveModel =
    liveModelId === "ares-internal"
      ? houseModel?.display_name ?? "Ares (in house)"
      : gatewayAccount?.models?.find((m) => m.id === liveModelId)?.display_name ?? liveModelId;

  // ── rail: search, pins, and the artifact vault ───────────────────────────
  const q = sessionQuery.trim().toLowerCase();
  const visibleSessions = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  const pinnedSessions = visibleSessions.filter((s) => prefs.pinned.includes(s.id));
  const unpinnedSessions = visibleSessions.filter((s) => !prefs.pinned.includes(s.id));
  const togglePin = (id: string) => {
    const pinned = prefs.pinned.includes(id) ? prefs.pinned.filter((p) => p !== id) : [...prefs.pinned, id];
    const next = { ...prefs, pinned };
    setPrefs(next);
    savePrefs(next);
  };

  /** Rename a session: optimistic title update, then persist via the daemon. */
  const renameSession = (id: string, label: string) => {
    const clean = label.trim().slice(0, 120);
    setSessions((current) => current.map((s) => (s.id === id ? { ...s, title: clean ? compact(clean, 42) : s.title } : s)));
    daemonCmd({ type: "session_rename", id, label: clean });
  };

  /** Close (delete) a session: drop it locally, persist, and leave the active
   *  session sane. The primary in-memory session is never deleted on disk but
   *  vanishes from the rail until its next turn re-registers it. */
  const closeSession = (id: string) => {
    setSessions((current) => {
      const next = current.filter((s) => s.id !== id);
      if (activeRef.current === id) {
        const fallback = next[0]?.id ?? "";
        activeRef.current = fallback;
        if (fallback) setTimeout(() => openSession(fallback), 0);
      }
      return next;
    });
    if (prefs.pinned.includes(id)) {
      const cleaned = { ...prefs, pinned: prefs.pinned.filter((p) => p !== id) };
      setPrefs(cleaned);
      savePrefs(cleaned);
    }
    daemonCmd({ type: "session_delete", id });
  };

  /** The vault: every image, file, and link Ares produced, across sessions. */
  const vault = useMemo(() => collectVault(sessions), [sessions]);
  const vaultCount = vault.images.length + vault.files.length + vault.links.length;

  // God-of-War drivers for the whole shell: --heat (molten temperature) and
  // --draft (daemon-gated ambient). Every ember, glow, and rune reads these.
  const heat = Math.min(
    1,
    (daemon === "running" ? 0.3 : daemon === "starting" ? 0.18 : 0.05) +
      (active?.busy ? 0.4 : 0) +
      Math.min(0.15, (opStatus?.activeCount ?? 0) * 0.05),
  );
  const draft = daemon === "running" ? 1 : daemon === "starting" ? 0.5 : 0.1;
  // Each agent action STRIKES — a felt ember-flare + micro-shake. Driven off the
  // activity ticker so it fires once per tool, decoupled from event internals.
  const activity = active?.activity;
  useEffect(() => {
    if (active?.busy && activity) setStrike((n) => n + 1);
  }, [activity]);

  return (
    <StyleCtx.Provider value={prefs.uiStyle}>
    <div
      className="ares"
      data-daemon={daemon}
      data-theme={prefs.theme}
      data-flame={prefs.flameMode}
      data-style={prefs.uiStyle}
      data-panel={forge.open ? "1" : "0"}
      data-working={active?.busy ? "1" : "0"}
      data-pill={pill ? "1" : "0"}
      data-ultra={prefs.ultra ? "1" : "0"}
      style={{ ["--forge-w" as string]: `${forgeWidth}px`, ["--heat" as string]: heat.toFixed(3), ["--draft" as string]: draft.toFixed(3) }}
    >
      {pill ? (
        <PillBar
          daemon={daemon}
          busy={active?.busy ?? false}
          activity={activity ?? ""}
          pinTop={pinTop}
          onTogglePin={togglePinTop}
          onExpand={exitPill}
          onSend={(t) => send(t)}
          onStop={stopTurn}
          native={native}
        />
      ) : null}
      {!bootGone ? <Boot /> : null}
      <UpdateBanner />
      <WhatsNew />
      <FirstRunGate
        active={native && daemon !== "starting" && noUsableKeys(keyStatus)}
        onOpenKeys={() => {
          setSettingsTab("keys");
          setSettingsOpen(true);
        }}
        onConnectAres={() => {
          setSettingsTab("account");
          setSettingsOpen(true);
        }}
      />
      <Backdrop />
      <div className="embers" aria-hidden="true" />
      <div className="workGlow" aria-hidden="true" />
      <ScreenFlame />
      {prefs.ultra ? <HackerRain active={active?.busy ?? false} /> : null}
      {strike > 0 ? <div className="strikeFlash" key={strike} aria-hidden="true" /> : null}
      {/* Turbulence filter that makes the composer's flame rim actually lick + flicker. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          {/* coarse slow sway for the flame body — higher octaves for organic
             noise, then a soft blur so the displaced edge reads as fire, not a
             jagged stretched polygon. */}
          <filter id="flameTurbCoarse" x="-50%" y="-50%" width="200%" height="200%">
            <feTurbulence type="fractalNoise" baseFrequency="0.011 0.026" numOctaves={4} seed={5} result="n">
              <animate attributeName="baseFrequency" dur="3s" values="0.011 0.024;0.016 0.038;0.011 0.024" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale={13} xChannelSelector="R" yChannelSelector="G" result="d" />
            <feGaussianBlur in="d" stdDeviation="1.1" />
          </filter>
          {/* medium licking for the mid layer */}
          <filter id="flameTurb" x="-40%" y="-40%" width="180%" height="180%">
            <feTurbulence type="fractalNoise" baseFrequency="0.018 0.046" numOctaves={3} seed={3} result="n">
              <animate attributeName="baseFrequency" dur="1.5s" values="0.018 0.042;0.028 0.072;0.018 0.042" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale={8} xChannelSelector="R" yChannelSelector="G" result="d" />
            <feGaussianBlur in="d" stdDeviation="0.7" />
          </filter>
          {/* fast fine crackle for the white-hot core */}
          <filter id="flameTurbFine" x="-40%" y="-40%" width="180%" height="180%">
            <feTurbulence type="fractalNoise" baseFrequency="0.038 0.086" numOctaves={3} seed={8} result="n">
              <animate attributeName="baseFrequency" dur="0.85s" values="0.038 0.078;0.056 0.122;0.038 0.078" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale={5} xChannelSelector="R" yChannelSelector="G" result="d" />
            <feGaussianBlur in="d" stdDeviation="0.4" />
          </filter>
          {/* body: deep red → orange, fading translucent at the tips */}
          <linearGradient id="flameGradBack" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--blood)" stopOpacity={0.95} />
            <stop offset="35%" stopColor="var(--ember)" stopOpacity={0.85} />
            <stop offset="72%" stopColor="var(--ember)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--ember)" stopOpacity={0} />
          </linearGradient>
          {/* mid: orange → gold, soft fade */}
          <linearGradient id="flameGradMid" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--ember)" stopOpacity={0.98} />
            <stop offset="40%" stopColor="var(--ember-hi)" stopOpacity={0.95} />
            <stop offset="75%" stopColor="#ffd98a" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#ffd98a" stopOpacity={0} />
          </linearGradient>
          {/* core: gold → white-hot tips */}
          <linearGradient id="flameGradCore" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--ember-hi)" stopOpacity={0} />
            <stop offset="45%" stopColor="#ffe8b0" stopOpacity={0.7} />
            <stop offset="80%" stopColor="#fff7e6" stopOpacity={0.95} />
            <stop offset="100%" stopColor="#fffdf7" stopOpacity={1} />
          </linearGradient>
        </defs>
      </svg>

      <header className="titlebar" onMouseDown={dragWindow}>
        <button
          className="brand brandBtn"
          data-open={accountMenuOpen ? "1" : "0"}
          onMouseDown={(ev) => ev.stopPropagation()}
          onClick={() => {
            setAccountMenuOpen((v) => !v);
            if (!accountMenuOpen) daemonCmd({ type: "gateway_status" });
          }}
          title="Ares account"
        >
          <div className="emblem" aria-hidden="true" />
          <h1>ARES</h1>
          <span>the battle-tested agent</span>
          {gatewayAccount?.connected ? (
            <em className="brandCredits">${(gatewayAccount.balance_usd ?? 0).toFixed(2)}</em>
          ) : null}
          <i className="brandCaret" aria-hidden="true">▾</i>
        </button>
        {accountMenuOpen ? (
          <div className="accountMenu" onMouseDown={(ev) => ev.stopPropagation()}>
            {gatewayAccount?.connected ? (
              <>
                <div className="amHead">
                  <div className="gwAvatar">
                    {gatewayAccount.profile?.avatar_url ? (
                      <img src={gatewayAccount.profile.avatar_url} alt="" />
                    ) : (
                      <span>{(gatewayAccount.profile?.display_name ?? "A").slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="amWho">
                    <strong>{gatewayAccount.profile?.display_name ?? "warrior"}</strong>
                    <span className="gwStatus" data-status={gatewayAccount.profile?.status ?? ""}>{gatewayAccount.profile?.status}</span>
                  </div>
                </div>
                <div className="amWallet">
                  <div className="amWalletBig">${(gatewayAccount.balance_usd ?? 0).toFixed(2)}</div>
                  <div className="amWalletSub">credits · ${(gatewayAccount.usage?.cost_usd ?? 0).toFixed(4)} spent today</div>
                </div>
                <div className="amSectionLabel">Models you can use</div>
                <div className="amModels">
                  {(gatewayAccount.models ?? []).length === 0 ? (
                    <div className="amEmpty">No models assigned yet — the owner grants them.</div>
                  ) : (
                    (gatewayAccount.models ?? []).map((m) => {
                      const active = prefs.provider === "ares" && prefs.model === m.id;
                      const limit = m.is_free
                        ? "free"
                        : typeof m.cap_remaining_microcents === "number"
                          ? `$${(m.cap_remaining_microcents / 1e6).toFixed(2)} left`
                          : "wallet";
                      return (
                        <button
                          key={m.id}
                          className="amModelRow"
                          data-active={active ? "1" : "0"}
                          title={active ? "current model" : "use this model"}
                          onClick={() => {
                            const next = { ...prefsRef.current, provider: "ares", model: m.id };
                            setPrefs(next as Prefs);
                            prefsRef.current = next as Prefs;
                            savePrefs(next as Prefs);
                            daemonCmd({ type: "model_switch", provider: "ares", model: m.id });
                            setAccountMenuOpen(false);
                          }}
                        >
                          <span className="amModelName">
                            {m.is_house ? <em className="gwHouse">ARES</em> : null}
                            {m.display_name ?? m.id}
                          </span>
                          <span className="amModelLimit" data-free={m.is_free ? "1" : "0"}>{limit}</span>
                          {active ? <span className="amModelDot" aria-hidden="true">●</span> : null}
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="amFoot">
                  <span className="amUsageLine">{(gatewayAccount.usage?.input_tokens ?? 0).toLocaleString()} in · {(gatewayAccount.usage?.output_tokens ?? 0).toLocaleString()} out today</span>
                  <button className="amManage" onClick={() => { setAccountMenuOpen(false); setSettingsOpen(true); setSettingsTab("account"); }}>Manage →</button>
                </div>
              </>
            ) : (
              <>
                <div className="amEmpty">Connect your Ares account to route through the gateway with your credits.</div>
                <button className="amAction" onClick={() => { setAccountMenuOpen(false); setSettingsOpen(true); setSettingsTab("account"); }}>
                  Connect account →
                </button>
              </>
            )}
          </div>
        ) : null}
        <div className="titleDrag" />
        <span className="pill" data-state={daemon}>
          {daemon === "running" ? "ONLINE" : daemon.toUpperCase()}
        </span>
        <div className="winControls">
          <button className="winPill" aria-label="condense to floating pill" title="Condense to a floating pill" onClick={() => void enterPill()}>
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1.5" y="4.5" width="11" height="5" rx="2.5" />
              <circle cx="4.2" cy="7" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {native ? (
            <>
            <button aria-label="minimize" onClick={() => void invoke("ares_window_minimize").catch(() => null)}>
              <svg viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5" /></svg>
            </button>
            <button aria-label="maximize" onClick={() => void invoke("ares_window_toggle_maximize").catch(() => null)}>
              <svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" rx="1" /></svg>
            </button>
            <button aria-label="close" className="winClose" onClick={() => void invoke("ares_window_close").catch(() => null)}>
              <svg viewBox="0 0 10 10"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" /><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" /></svg>
            </button>
            </>
          ) : null}
        </div>
      </header>

      <aside className="rail">
        <button className="primary" onClick={newSession}>
          + New session
        </button>

        <nav className="railNav">
          <button data-on={view === "chat" ? "1" : "0"} onClick={() => setView("chat")}>
            <i className="glyph" data-glyph="task" /> Sessions
          </button>
          <button
            className="helmNav"
            data-on={view === "helm" ? "1" : "0"}
            onClick={() => {
              setView("helm");
              setForge((current) => ({ ...current, open: false }));
              daemonCmd({ type: "operator_status" });
              daemonCmd({ type: "usage_stats", days: 14 });
            }}
          >
            <i className="glyph" data-glyph="dot" /> HELM
            {opStatus?.activeCount ? <em>{opStatus.activeCount}</em> : null}
          </button>
          <button
            data-on={view === "artifacts" ? "1" : "0"}
            onClick={() => {
              setView("artifacts");
              setForge((current) => ({ ...current, open: false }));
            }}
          >
            <i className="glyph" data-glyph="file" /> Artifacts
            {vaultCount > 0 ? <em>{vaultCount}</em> : null}
          </button>
        </nav>

        <input
          className="railSearch"
          value={sessionQuery}
          placeholder="Search sessions…"
          spellCheck={false}
          onChange={(e) => setSessionQuery(e.target.value)}
        />

        {pinnedSessions.length > 0 ? (
          <>
            <div className="railLabel">Pinned</div>
            <nav className="sessionList pinnedList">
              {pinnedSessions.map((s) => (
                <SessionRow key={s.id} s={s} activeId={active?.id ?? ""} pinned onSelect={openSession} onPin={togglePin} onRename={renameSession} onClose={closeSession} />
              ))}
            </nav>
          </>
        ) : null}

        <div className="railLabel">Sessions</div>
        <nav className="sessionList">
          {unpinnedSessions.map((s) => (
            <SessionRow key={s.id} s={s} activeId={active?.id ?? ""} onSelect={openSession} onPin={togglePin} onRename={renameSession} onClose={closeSession} />
          ))}
        </nav>

        <div className="railFoot">
          <button className="ghost" disabled={!native || daemon !== "running" || active?.busy} onClick={undoLastChange}>
            Undo last agent change
          </button>
          <button className="ghost" onClick={() => setForge((f) => ({ ...f, open: !f.open, tab: f.open ? f.tab : f.artifact ? "preview" : "sandbox" }))}>
            {forge.open ? "Close the Forge" : "Open the Forge"}
          </button>
          <button className="ghost" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <div className="daemonDot" title={`daemon: ${daemon}`}>
            <i data-state={daemon} />
            <span>{daemon === "running" ? "Garrison up" : daemon}</span>
          </div>
        </div>
      </aside>

      <main className="stage" data-view={view}>
        <header className="stageHead">
          <div>
            <h2>{active?.title ?? "Session"}</h2>
            <span>
              {prefs.routingMode === "auto" ? `routing · ${liveModel}` : `${prefs.provider} / ${prefs.model}`}
              {prefs.routingMode === "auto" && routedLanes.length > 0 ? ` · ${routedLanes.length} lane${routedLanes.length === 1 ? "" : "s"}` : ""}
            </span>
          </div>
        </header>

        {view === "helm" ? (
          <HelmView
            daemon={daemon}
            opStatus={opStatus}
            usage={usageStats}
            keyStatus={keyStatus}
            sessions={sessions}
            active={active}
            onOpenSession={openSession}
            onToggleAutotick={() => daemonCmd({ type: "operator_autotick", enabled: !(opStatus?.autotick ?? true) })}
            onRefresh={() => { daemonCmd({ type: "operator_status" }); daemonCmd({ type: "usage_stats", days: 14 }); }}
          />
        ) : view === "artifacts" ? (
          <ArtifactsPage
            vault={vault}
            onOpenFile={(path, label) => openArtifact(path, label)}
            onReturn={() => setView("chat")}
            onJump={openSession}
          />
        ) : (
          <div className="chat" ref={scroller} onScroll={onChatScroll}>
            {active?.loading ? (
              <div className="empty">
                <div className="wordmark">LOADING</div>
                <p className="wordmarkSub">Restoring this session from its durable event log.</p>
              </div>
            ) : active && active.items.length === 0 ? (
              <div className="empty">
                <div className="wordmark">ARES</div>
                <p className="wordmarkSub">Name the mission. I'll plan it, build it, verify it — and show you proof.</p>
                <div className="starters">
                  {[
                    "Audit this repo and list the top risks",
                    "Build me a landing page and preview it",
                    "Design a robot arm on the holotable",
                  ].map((qq) => (
                    <button key={qq} className="starter" onClick={() => send(qq)}>
                      {qq}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {active?.items.map((item) => (
              <ItemView key={item.key} item={item} onPermission={respondPermission} onArtifact={openArtifact} onSignIn={startAnthropicSignIn} toolDisplay={prefs.toolDisplay} />
            ))}
            {active?.busy ? (
              <div className="working">
                <span className="workingForge" />
                <span className="workingLabel" key={active.activity ?? "working"}>
                  {active.activity ?? "working"}
                </span>
              </div>
            ) : null}
            {!pinned ? (
              <button className="jumpLatest" onClick={jumpToLatest} title="jump to latest">
                ↓ latest
              </button>
            ) : null}
          </div>
        )}

        {active?.fleet && active.fleet.agents.length > 0 && (active.fleet.active || active.fleet.canResume) ? (
          <FleetPanel
            fleet={active.fleet}
            onResume={(fleetId) =>
              send(`Resume the agent fleet "${fleetId}" — author a Conductor FleetSpec with resumeFleetId: "${fleetId}" so the completed leaves are reused from disk and only the failed/incomplete ones re-run.`)
            }
          />
        ) : null}

        {active?.codingBackend ? <CodingBackendScene vm={active.codingBackend} /> : null}

        {view !== "helm" ? (
          <Composer
            busy={active?.busy ?? false}
            model={liveModel}
            autoRouting={prefs.routingMode === "auto"}
            reasoning={prefs.reasoning}
            routedLanes={routedLanes}
            todos={active?.todos ?? []}
            steerQueued={active?.steerQueued ?? 0}
            onSend={send}
            onSteer={steer}
            onStop={stopTurn}
            onModelChip={() => setModelPopOpen(true)}
            onReasoningChip={cycleReasoning}
            onRoutingChip={() => setRoutingOpen(true)}
          />
        ) : null}

        <footer className="statusBar">
          <div className="statusGroup">
            <button className="statusSeg" onClick={() => setGarrisonOpen(true)} title="Garrison panel — status, log, restart">
              <i className="dot" data-state={daemon} /><b>garrison</b><span>{daemon}</span>
            </button>
            <button className="statusSeg" onClick={() => setModelPopOpen(true)} title={prefs.routingMode === "auto" ? "auto-routing — model that handled the last turn" : "switch provider / model"}>
              <b>model</b><span>{liveModel}</span>
            </button>
            <button className="statusSeg" data-ultra={prefs.ultra ? "1" : "0"} onClick={() => setReasoningOpen(true)} title="reasoning effort — slide to ULTRA to unleash the fleet">
              <b>mode</b><span>{prefs.ultra ? "ultra" : prefs.reasoning}</span>
            </button>
            <button className="statusSeg" onClick={() => setRoutingOpen(true)} title="per-lane model routing">
              <b>route</b><span>{prefs.routingMode === "auto" ? `auto · ${routedLanes.length}` : routedLanes.length > 0 ? `ready · ${routedLanes.length}` : "off"}</span>
            </button>
            <button
              className="statusSeg"
              onClick={() => {
                daemonCmd({ type: "operator_status" });
                setCronOpen(true);
              }}
              title="durable missions (Operator)"
            >
              <i className="dot" data-state={opStatus?.activeCount ? "running" : "stopped"} /><b>missions</b><span>{opStatus?.activeCount ?? 0}</span>
            </button>
            <button className="statusSeg" onClick={cycleFlame} title="screen flame border — immersive / clean / combat">
              <b>flame</b><span>{prefs.flameMode}</span>
            </button>
          </div>
          <span className="grow" />
          <div className="statusGroup">
            {native && daemon !== "running" && daemon !== "starting" ? (
              <button className="statusAction" onClick={() => { restartAttempts.current = 0; restartDaemon(); }}>
                ⟳ Restart
              </button>
            ) : null}
            <button className="statusAction" onClick={() => void exportSessionLog()} title="Export this session (chat + tool calls + errors) to a file for feedback">
              ⤓ Export
            </button>
            <button
              className="statusAction"
              onClick={() => setReportOpen(true)}
              disabled={!active?.id}
              title="Report a bug — upload this whole chat (all code, tool calls, errors) so the owner can diagnose and improve Ares"
            >
              🐛 Report bug
            </button>
            <button className="statusAction" onClick={() => setPaletteOpen(true)} title="command palette">
              ⌘ Ctrl+K
            </button>
            <span className="hudReadout" title="tokens in / out this session">
              ↑<SpringNumber value={active?.tokensIn ?? 0} format={fmtTokens} /> ↓<SpringNumber value={active?.tokensOut ?? 0} format={fmtTokens} />
            </span>
            <span className="hudVersion">v{APP_VERSION}</span>
          </div>
        </footer>
      </main>

      {forge.open ? (
        <aside className="forge">
          <div className="forgeGrip" onPointerDown={onForgeGrip} />
          <header>
            <strong>THE FORGE</strong>
            <nav className="forgeTabs">
              {(["preview", "sandbox", "holo", "live"] as ForgeTab[]).map((t) => (
                <button key={t} data-on={forge.tab === t ? "1" : "0"} data-live={t === "live" && liveBrowser && Date.now() - liveBrowser.at < 4000 ? "1" : "0"} onClick={() => setForge((f) => ({ ...f, tab: t }))}>
                  {t === "live" && liveBrowser && Date.now() - liveBrowser.at < 4000 ? "● live" : t}
                </button>
              ))}
            </nav>
            <button className="ghost" onClick={() => setForge((f) => ({ ...f, open: false }))}>
              Close
            </button>
          </header>

          {forge.tab === "preview" ? (
            forge.artifact ? (
              <div className="forgeBody">
                <div className="forgeMeta">{forge.artifact.label}</div>
                <iframe
                  title={forge.artifact.label}
                  src={native ? convertFileSrc(forge.artifact.path) : undefined}
                  srcDoc={native ? undefined : holoDefaultHtml()}
                  sandbox="allow-scripts"
                />
              </div>
            ) : (
              <div className="forgeEmpty">
                <div className="emptyEmblem" aria-hidden="true" />
                <p>No artifact yet. When Ares forges an HTML or SVG file, it lands here.</p>
              </div>
            )
          ) : null}

          {forge.tab === "sandbox" ? (
            <div className="forgeBody sandbox">
              <div className="sandboxBar">
                <span>live HTML — scripts run for real</span>
                <button className="primary tiny" onClick={() => void runSandbox(sandboxCode)}>
                  ▶ Run
                </button>
              </div>
              <textarea className="sandboxCode" value={sandboxCode} onChange={(e) => setSandboxCode(e.target.value)} spellCheck={false} />
              <iframe title="sandbox" src={sandboxSrc?.src} srcDoc={sandboxSrc?.srcdoc} sandbox="allow-scripts" />
            </div>
          ) : null}

          {forge.tab === "holo" ? (
            <div className="forgeBody">
              <div className="forgeMeta">{holoMeta}</div>
              <iframe title="holo" src={holoSrc?.src} srcDoc={holoSrc?.srcdoc} sandbox="allow-scripts allow-pointer-lock allow-downloads" />
            </div>
          ) : null}

          {forge.tab === "live" ? (
            <div className="forgeBody liveBrowser">
              <div className="forgeMeta">
                {embeddedActive
                  ? <><i className="liveDot" /> {embeddedActivity || "Ares is driving its own browser — in-window"}</>
                  : liveBrowser && Date.now() - liveBrowser.at < 4000
                    ? <><i className="liveDot" /> Ares is driving the browser — watch the cursor</>
                    : "Ares's embedded browser — appears here when it tests a page or UI"}
              </div>
              {/* interactive embedded browser (Ares's own HTML apps/games) */}
              <div className="liveStage embed" data-on={embeddedActive ? "1" : "0"}>
                <EmbeddedBrowser ref={embeddedRef} onActivity={setEmbeddedActivity} />
              </div>
              {/* streamed Playwright frames (localhost / real web), when not embedded */}
              {!embeddedActive && liveBrowser ? (
                <div className="liveStage">
                  <img src={`data:image/jpeg;base64,${liveBrowser.frame}`} alt="Ares live browser" />
                </div>
              ) : null}
              {!embeddedActive && !liveBrowser ? (
                <div className="forgeEmpty">
                  <div className="emptyEmblem" aria-hidden="true" />
                  <p>When Ares tests a page, app, or game it built, you'll watch it here — cursor moving, clicking, navigating at human speed. Just like it has its own browser.</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </aside>
      ) : null}

      {gatewayToasts.length > 0 ? (
        <div className="gwToasts">
          {gatewayToasts.map((t) => (
            <div key={t.id} className="gwToast">
              🔥 {t.text}
            </div>
          ))}
        </div>
      ) : null}
      {settingsOpen ? (
        <Settings
          prefs={prefs}
          onApply={applySettings}
          onClose={() => setSettingsOpen(false)}
          native={native}
          skills={skills}
          usage={usageStats}
          keyStatus={keyStatus}
          gatewayAccount={gatewayAccount}
          permissions={permissions}
          onPermissions={(next) => {
            setPermissions(next);
            daemonCmd({ type: "set_permissions", permissions: next });
          }}
          oauthProviders={oauthProviders}
          consciousness={consciousness}
          onDaemonCommand={daemonCmd}
          onLivePref={(patch) => {
            const next = { ...prefs, ...patch };
            setPrefs(next);
            savePrefs(next);
          }}
          onAnthropicSignIn={startAnthropicSignIn}
          initialTab={settingsTab}
          channelStatus={channelStatus}
          channelRoster={channelRoster}
          channelToken={channelToken}
          onChannelToken={setChannelToken}
          channelAllowedChats={channelAllowedChats}
          onChannelAllowedChats={setChannelAllowedChats}
          channelBusy={channelBusy}
          onChannelBusy={setChannelBusy}
          onPushLog={pushLog}
        />
      ) : null}

      {reportOpen ? (
        <BugReportModal
          busy={reportBusy}
          sessionTitle={active?.title ?? "this session"}
          connected={Boolean(gatewayAccount?.connected)}
          onClose={() => (reportBusy ? null : setReportOpen(false))}
          onSend={(note) => {
            if (!active?.id) return;
            setReportBusy(true);
            daemonCmd({ type: "bug_report", id: active.id, note });
          }}
        />
      ) : null}

      {directoryOpen ? (
        <ConnectorDirectory
          connectors={mcpConnectors}
          connecting={mcpConnecting}
          onClose={() => setDirectoryOpen(false)}
          onConnect={(url, name) => {
            setMcpConnecting(name);
            daemonCmd({ type: "mcp_connect", url, name });
          }}
          onDisconnect={(name) => daemonCmd({ type: "mcp_disconnect", name })}
        />
      ) : null}

      {modelPopOpen ? (
        <ModelPopover
          prefs={prefs}
          native={native}
          onClose={() => setModelPopOpen(false)}
          onPickAuto={() => {
            setModelPopOpen(false);
            // Toggle: if auto is already on, clicking the card turns it OFF (back
            // to the manual main model) — previously there was no way to disable.
            const enabled = prefs.routingMode !== "auto";
            const next = { ...prefs, routingMode: (enabled ? "auto" : "manual") as "auto" | "manual" };
            setPrefs(next);
            savePrefs(next);
            // Reflect the switch in the footer/composer NOW. liveModel prefers the
            // session's turnModel (the model that handled the last turn); without
            // clearing it, the readout would keep showing the previous turn's model
            // and the user's pick would look like it "did nothing".
            apply((s) => ({ ...s, turnModel: enabled ? undefined : next.model, turnProvider: enabled ? undefined : next.provider }));
            daemonCmd({ type: "routing_mode", enabled });
          }}
          onPick={(provider, model) => {
            setModelPopOpen(false);
            const next = { ...prefs, provider, model, routingMode: "manual" as const };
            setPrefs(next);
            savePrefs(next);
            // Immediately show the picked model in the footer/composer. The next
            // turn's route_resolved event overwrites this with whatever actually
            // ran (failover-aware), but until then the readout must match the pick.
            apply((s) => ({ ...s, turnModel: model, turnProvider: provider, turnLane: undefined }));
            if (native) {
              if (daemon === "running") {
                void invoke("ares_daemon_command", { command: { type: "model_switch", provider, model } }).catch((err) => {
                  apply((s) => foldEvent(s, { type: "desktop_error", text: `model switch failed: ${String(err)}` }));
                });
              } else {
                restartAttempts.current = 0;
                restartDaemon(provider, model);
              }
            }
          }}
        />
      ) : null}

      {paletteOpen ? <Palette actions={paletteActions} onClose={() => setPaletteOpen(false)} /> : null}

      {anthropicAuth.open ? (
        <AnthropicSignIn
          status={anthropicAuth.status}
          error={anthropicAuth.error}
          onRetry={startAnthropicSignIn}
          onClose={() => setAnthropicAuth({ open: false, status: "idle" })}
        />
      ) : null}

      {cronOpen ? (
        <div className="paletteScrim" onClick={() => setCronOpen(false)}>
          <div className="palette missionsPop" onClick={(e) => e.stopPropagation()}>
            <div className="popTitle">
              Durable missions
              <span className="missionsTick" data-on={opStatus?.autotick ? "1" : "0"}>{opStatus?.autotick ? "auto-tick on" : "auto-tick off"}</span>
            </div>
            {!opStatus || opStatus.goals.length === 0 ? (
              <div className="paneEmpty">
                No durable missions yet. Ask Ares to "create a durable goal to …" and it advances while idle.
              </div>
            ) : (
              <div className="missionsList">
                {opStatus.goals.map((g) => (
                  <div key={g.id} className="missionRow" data-status={g.status}>
                    <div className="missionDot" data-status={g.status} />
                    <div className="missionInfo">
                      <strong>{g.statement}</strong>
                      <span>{g.status} · {g.progress} step{g.progress === 1 ? "" : "s"}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {reasoningOpen ? (
        <div className="paletteScrim" onClick={() => setReasoningOpen(false)}>
          <div className="palette reasoningPop" onClick={(e) => e.stopPropagation()}>
            <div className="popTitle">Reasoning effort</div>
            <ReasoningSlider value={currentEffort} onChange={setEffort} />
          </div>
        </div>
      ) : null}

      {routingOpen ? (
        <RoutingPanel
          prefs={prefs}
          native={native}
          onClose={() => setRoutingOpen(false)}
          onApply={(routing) => {
            const routingMode = Object.keys(routing).length > 0 ? "auto" as const : "manual" as const;
            const p = { ...prefs, routing, routingMode };
            setPrefs(p);
            savePrefs(p);
            if (native) {
              void invoke("ares_set_routing", { routing }).catch(() => null);
              daemonCmd({ type: "routing_mode", enabled: routingMode === "auto" });
            }
            setRoutingOpen(false);
          }}
        />
      ) : null}

      {garrisonOpen ? (
        <div className="scrim" onClick={() => setGarrisonOpen(false)}>
          <div className="drawer wide consoleDrawer" onClick={(e) => e.stopPropagation()}>
            <header className="consoleHead">
              <h3>Daemon Console</h3>
              <span className="pill" data-state={daemon}>
                <i className="dot" data-state={daemon} />{daemon.toUpperCase()}
              </span>
              <span className="grow" />
              <button
                className="ghost"
                title="Copy the log — paste it when reporting a bug"
                onClick={() => void navigator.clipboard?.writeText(logLines.join("\n")).catch(() => null)}
              >
                ⧉ Copy
              </button>
              <button
                className="ghost"
                onClick={() => {
                  restartAttempts.current = 0;
                  restartDaemon();
                }}
              >
                ⟳ Restart
              </button>
              {native ? (
                <button className="ghost danger" onClick={() => void invoke("ares_stop_daemon").catch(() => null)}>
                  ■ Stop
                </button>
              ) : null}
              <button className="ghost" onClick={() => setGarrisonOpen(false)}>
                Close
              </button>
            </header>
            <pre className="logView">{logLines.length ? logLines.join("\n") : "No daemon output yet — the Garrison hasn't written to stderr."}</pre>
            <footer className="consoleFoot">
              {logLines.length} line{logLines.length === 1 ? "" : "s"} · live stdout/stderr from the Garrison daemon
            </footer>
          </div>
        </div>
      ) : null}
    </div>
    </StyleCtx.Provider>
  );
}

// ─── Command palette ───────────────────────────────────────────────────────

interface PaletteAction {
  label: string;
  hint?: string;
  run: () => void;
}

function Palette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const q = query.trim().toLowerCase();
  const filtered = q ? actions.filter((a) => a.label.toLowerCase().includes(q) || (a.hint ?? "").toLowerCase().includes(q)) : actions;
  const sel = Math.min(cursor, Math.max(0, filtered.length - 1));

  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search actions and sessions…"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter" && filtered[sel]) {
              filtered[sel].run();
              onClose();
            }
          }}
        />
        <div className="paletteList">
          {filtered.map((a, i) => (
            <button
              key={a.label}
              data-on={i === sel ? "1" : "0"}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                a.run();
                onClose();
              }}
            >
              <span>{a.label}</span>
              {a.hint ? <em>{a.hint}</em> : null}
            </button>
          ))}
          {filtered.length === 0 ? <div className="paletteEmpty">nothing matches</div> : null}
        </div>
      </div>
    </div>
  );
}

// ─── Routing panel — per-lane model assignments, its own surface ───────────

const LANE_HINTS: Record<RouteLane, string> = {
  chat: "conversation, quick answers, summaries",
  coding: "edits, builds, refactors, debugging",
  research: "planning, analysis, deep reads",
  "tool-use": "tool-output digestion, mechanical steps",
};

function RoutingPanel({
  prefs,
  native,
  onApply,
  onClose,
}: {
  prefs: Prefs;
  native: boolean;
  onApply: (routing: Routing) => void;
  onClose: () => void;
}) {
  const [routing, setRouting] = useState<Routing>(prefs.routing);
  const setLane = (lane: RouteLane, entry: { provider: string; model: string } | undefined) => {
    const next = { ...routing };
    if (entry) next[lane] = entry;
    else delete next[lane];
    setRouting(next);
  };
  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette routingPop" onClick={(e) => e.stopPropagation()}>
        <div className="routingHead">
          <div>
            <strong>The War Table</strong>
            <span>Assign a model to each kind of work. Any assignment turns on auto-routing; unset lanes use your main model ({prefs.model}).</span>
          </div>
          <button className="ghost popClose" onClick={onClose}>Close</button>
        </div>
        <div className="routingPopBody">
          {ROUTE_LANES.map((lane) => {
            const entry = routing[lane];
            const open = !!entry;
            return (
              <div key={lane} className="routeLane" data-on={open ? "1" : "0"}>
                <button className="laneToggle" onClick={() => setLane(lane, entry ? undefined : { provider: prefs.provider, model: prefs.model })}>
                  <i />
                  <span className="laneName">{lane}</span>
                  <em className="laneHint">{LANE_HINTS[lane]}</em>
                  {entry ? <span className="laneModel">{entry.model}</span> : <span className="laneFallback">main model</span>}
                </button>
                {entry ? (
                  <div className="laneBody">
                    <div className="segment mini">
                      {PROVIDERS.filter((p) => p !== "mock").map((p) => (
                        <button
                          key={p}
                          data-on={entry.provider === p ? "1" : "0"}
                          onClick={() => setLane(lane, { provider: p, model: defaultModelForProvider(p) })}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                    <ModelPicker
                      provider={entry.provider}
                      value={entry.model}
                      onPick={(id) => setLane(lane, { ...entry, model: id })}
                      native={native}
                      compact
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
          {!native ? <p className="keyHint">demo mode — assignments persist locally and apply when the daemon is attached.</p> : null}
        </div>
        <div className="routingPopFoot">
          <button className="primary" onClick={() => onApply(routing)}>
            Apply routing
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Model hot-swap popover ────────────────────────────────────────────────

// A curated set of popular remote MCP servers. The URLs are the servers'
// message endpoints; connecting runs the generic OAuth flow. "Add by URL"
// below the gallery covers everything not listed (the long tail is huge).
interface ConnectorPreset {
  id: string;
  label: string;
  url: string;
  blurb: string;
  glyph: string;
}
const CONNECTOR_PRESETS: ConnectorPreset[] = [
  { id: "notion", label: "Notion", url: "https://mcp.notion.com/mcp", blurb: "Search & update your Notion workspace", glyph: "📝" },
  { id: "linear", label: "Linear", url: "https://mcp.linear.app/sse", blurb: "Issues, projects & team workflows", glyph: "📐" },
  { id: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp", blurb: "Search, query & debug errors", glyph: "🛡️" },
  { id: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", blurb: "Repos, issues, PRs & code search", glyph: "🐙" },
  { id: "vercel", label: "Vercel", url: "https://mcp.vercel.com", blurb: "Deployments, projects & logs", glyph: "▲" },
  { id: "atlassian", label: "Atlassian", url: "https://mcp.atlassian.com/v1/sse", blurb: "Jira & Confluence", glyph: "🔵" },
  { id: "asana", label: "Asana", url: "https://mcp.asana.com/sse", blurb: "Tasks, projects & goals", glyph: "🎯" },
  { id: "stripe", label: "Stripe", url: "https://mcp.stripe.com", blurb: "Payments & financial data", glyph: "💳" },
  { id: "cloudflare", label: "Cloudflare", url: "https://docs.mcp.cloudflare.com/sse", blurb: "Docs, Workers & platform", glyph: "☁️" },
  { id: "supabase", label: "Supabase", url: "https://mcp.supabase.com/mcp", blurb: "Databases, auth & storage", glyph: "🟢" },
  { id: "huggingface", label: "Hugging Face", url: "https://huggingface.co/mcp", blurb: "Models, datasets & Spaces", glyph: "🤗" },
  { id: "square", label: "Square", url: "https://mcp.squareup.com/sse", blurb: "Payments & merchant data", glyph: "⬜" },
];

function ConnectorDirectory({
  connectors,
  connecting,
  onConnect,
  onDisconnect,
  onClose,
}: {
  connectors: McpConnectorVm[];
  connecting: string | null;
  onConnect: (url: string, name: string) => void;
  onDisconnect: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const connectedNames = new Set(connectors.map((c) => c.name));
  const q = query.trim().toLowerCase();
  const shown = q ? CONNECTOR_PRESETS.filter((p) => `${p.label} ${p.blurb}`.toLowerCase().includes(q)) : CONNECTOR_PRESETS;

  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette directory" onClick={(e) => e.stopPropagation()}>
        <header className="dirHead">
          <div>
            <strong>Directory</strong>
            <em>Connect tools & apps — Ares does the OAuth, then their tools are live for the agent.</em>
          </div>
          <button className="ghost" onClick={onClose}>Close</button>
        </header>

        <input className="dirSearch" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search connectors…" spellCheck={false} autoFocus />

        {connectors.length ? (
          <>
            <div className="dirSectionLabel">Connected</div>
            <div className="dirConnected">
              {connectors.map((c) => (
                <div key={c.name} className="dirConnRow">
                  <span className="dirConnName">🔌 {c.displayName ?? c.name}</span>
                  <span className="dirConnUrl">{c.url}</span>
                  <button className="dirDisconnect" onClick={() => onDisconnect(c.name)}>Disconnect</button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="dirSectionLabel">Popular</div>
        <div className="dirGallery">
          {shown.map((p) => {
            const isConnected = connectedNames.has(p.id) || connectedNames.has(p.label.toLowerCase());
            const isConnecting = connecting === p.id;
            return (
              <button
                key={p.id}
                className="dirCard"
                data-connected={isConnected ? "1" : "0"}
                disabled={isConnected || isConnecting || connecting !== null}
                onClick={() => onConnect(p.url, p.id)}
                title={p.url}
              >
                <span className="dirCardGlyph">{p.glyph}</span>
                <span className="dirCardBody">
                  <strong>{p.label}</strong>
                  <em>{p.blurb}</em>
                </span>
                <span className="dirCardAction">{isConnected ? "✓ connected" : isConnecting ? "connecting…" : "+ connect"}</span>
              </button>
            );
          })}
          {shown.length === 0 ? <div className="dirEmpty">No preset matches — add it by URL below.</div> : null}
        </div>

        <div className="dirSectionLabel">Add any MCP server by URL</div>
        <div className="dirCustom">
          <input
            className="dirSearch"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder="https://mcp.example.com/sse"
            spellCheck={false}
          />
          <button
            className="primary"
            disabled={!/^https?:\/\//i.test(customUrl.trim()) || connecting !== null}
            onClick={() => {
              const url = customUrl.trim();
              try {
                const host = new URL(url).host.replace(/^www\.|^mcp\.|^api\./, "").split(".")[0];
                onConnect(url, host || "connector");
                setCustomUrl("");
              } catch { /* invalid url ignored (button is gated anyway) */ }
            }}
          >
            Connect
          </button>
        </div>
        <p className="dirFootnote">
          A browser window opens for you to approve access. Tokens are stored encrypted on your machine — never in plain text.
        </p>
      </div>
    </div>
  );
}

function BugReportModal({
  busy,
  sessionTitle,
  connected,
  onSend,
  onClose,
}: {
  busy: boolean;
  sessionTitle: string;
  connected: boolean;
  onSend: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette bugReport" onClick={(e) => e.stopPropagation()}>
        <header className="bugReportHead">
          <strong>🐛 Report a bug</strong>
          <em>{sessionTitle}</em>
        </header>
        <p className="bugReportBlurb">
          This uploads the <b>whole chat</b> — every message, all generated code, every tool call and its
          result, and any errors — to your Ares account so the owner can see exactly what went wrong and improve
          Ares. Nothing is sent unless you press Send.
        </p>
        {!connected ? (
          <div className="bugReportWarn">You're not connected to your Ares account. Connect at doingteam.com → Account first, or this will fail.</div>
        ) : null}
        <label className="bugReportLabel">
          What went wrong? <span>(optional, but it helps)</span>
        </label>
        <textarea
          className="bugReportNote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. asked for a snake game — it created the HTML but the arrow keys don't move the snake, and it claimed it was done"
          rows={4}
          autoFocus
          spellCheck
        />
        <div className="bugReportActions">
          <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={() => onSend(note.trim())} disabled={busy}>
            {busy ? "Sending…" : "Send report"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelPopover({
  prefs,
  native,
  onPickAuto,
  onPick,
  onClose,
}: {
  prefs: Prefs;
  native: boolean;
  onPickAuto: () => void;
  onPick: (provider: string, model: string) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState(prefs.provider);
  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette modelSwap" onClick={(e) => e.stopPropagation()}>
        <button className="autoRoutePick" data-on={prefs.routingMode === "auto" ? "1" : "0"} onClick={onPickAuto} title={prefs.routingMode === "auto" ? "Routing is ON — click to switch back to a single manual model" : "Enable per-lane auto routing"}>
          <span>
            <strong>Routing (Auto){prefs.routingMode === "auto" ? " · ON" : ""}</strong>
            <em>{prefs.routingMode === "auto" ? "click to disable — pick a model below for manual" : "classifies each turn and uses your lane assignments"}</em>
          </span>
          <i>{prefs.routingMode === "auto" ? "ON" : `${Object.keys(prefs.routing).length} lanes`}</i>
        </button>
        <div className="segment">
          {PROVIDERS.map((p) => (
            <button key={p} data-on={provider === p ? "1" : "0"} onClick={() => setProvider(p)}>
              {p}
            </button>
          ))}
        </div>
        <ModelPicker provider={provider} value={prefs.provider === provider ? prefs.model : ""} onPick={(id) => onPick(provider, id)} native={native} searchOnly />
      </div>
    </div>
  );
}

// ─── The vault: cross-session artifact aggregation ─────────────────────────

interface VaultEntry {
  key: string;
  label: string;
  url: string;
  session: string;
  sessionId: string;
}
interface Vault {
  images: VaultEntry[];
  files: VaultEntry[];
  links: VaultEntry[];
}

const VAULT_IMG = /https?:[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s<>"')\]]*)?/gi;
const VAULT_LINK = /https?:\/\/[^\s<>"')\]]+/gi;

function collectVault(sessions: SessionVm[]): Vault {
  const images: VaultEntry[] = [];
  const files: VaultEntry[] = [];
  const links: VaultEntry[] = [];
  const seen = new Set<string>();
  const push = (list: VaultEntry[], entry: VaultEntry) => {
    if (seen.has(entry.url)) return;
    seen.add(entry.url);
    list.push(entry);
  };
  for (const s of sessions) {
    for (const item of s.items) {
      if (item.kind === "artifact") {
        push(files, { key: item.key, label: item.label, url: item.path, session: s.title, sessionId: s.id });
      } else if (item.kind === "assistant" && item.text) {
        for (const m of item.text.matchAll(VAULT_IMG)) {
          push(images, { key: `${item.key}-${images.length}`, label: m[0].split("/").pop()?.split("?")[0] ?? "image", url: m[0], session: s.title, sessionId: s.id });
        }
        for (const m of item.text.matchAll(VAULT_LINK)) {
          if (/\.(?:png|jpe?g|webp|gif|avif)/i.test(m[0])) continue;
          push(links, { key: `${item.key}-l${links.length}`, label: m[0].replace(/^https?:\/\//, "").slice(0, 70), url: m[0], session: s.title, sessionId: s.id });
        }
      }
    }
  }
  return { images, files, links };
}

function ArtifactsPage({
  vault,
  onOpenFile,
  onReturn,
  onJump,
}: {
  vault: Vault;
  onOpenFile: (path: string, label: string) => void;
  onReturn: () => void;
  onJump: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "images" | "files" | "links">("all");
  const [query, setQuery] = useState("");
  const ql = query.trim().toLowerCase();
  const match = (e: VaultEntry) => !ql || e.label.toLowerCase().includes(ql) || e.url.toLowerCase().includes(ql);
  const images = vault.images.filter(match);
  const files = vault.files.filter(match);
  const links = vault.links.filter(match);
  const total = vault.images.length + vault.files.length + vault.links.length;
  const visibleTotal =
    (filter === "all" || filter === "images" ? images.length : 0) +
    (filter === "all" || filter === "files" ? files.length : 0) +
    (filter === "all" || filter === "links" ? links.length : 0);

  return (
    <div className="vault">
      <header className="vaultHero">
        <div>
          <span className="vaultEyebrow">Cross-session output</span>
          <h2>Artifact Vault</h2>
          <p>Everything Ares creates, discovers, and cites, organized in one durable workspace.</p>
        </div>
        <div className="vaultMetric" aria-label={`${total} artifacts`}>
          <strong>{total}</strong>
          <span>{total === 1 ? "artifact" : "artifacts"}</span>
        </div>
      </header>

      <div className="vaultHead">
        <input value={query} placeholder="Search artifacts…" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        <nav aria-label="Artifact filters">
          {(
            [
              ["all", total],
              ["images", vault.images.length],
              ["files", vault.files.length],
              ["links", vault.links.length],
            ] as Array<["all" | "images" | "files" | "links", number]>
          ).map(([f, n]) => (
            <button key={f} data-on={filter === f ? "1" : "0"} onClick={() => setFilter(f)}>
              {f} <em>{n}</em>
            </button>
          ))}
        </nav>
      </div>

      <div className="vaultScroll">
        {total === 0 ? (
          <div className="vaultEmpty">
            <div className="emptyEmblem" aria-hidden="true" />
            <strong>The vault is ready.</strong>
            <p>Images Ares finds, previewable files it writes, and links it cites will appear here automatically.</p>
            <button className="primary tiny" onClick={onReturn}>Return to session</button>
          </div>
        ) : visibleTotal === 0 ? (
          <div className="vaultEmpty compact">
            <i className="glyph" data-glyph="search" />
            <strong>No matching artifacts</strong>
            <p>Try another search or switch back to All.</p>
            <button
              className="ghost"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Clear filters
            </button>
          </div>
        ) : null}

        {(filter === "all" || filter === "images") && images.length > 0 ? (
          <>
            <div className="vaultLabel">Images</div>
            <div className="vaultGrid">
              {images.map((e) => (
                <figure key={e.key} className="vaultCard">
                  <img src={e.url} loading="lazy" alt={e.label} />
                  <figcaption>
                    <strong>{e.label}</strong>
                    <button onClick={() => onJump(e.sessionId)}>{e.session}</button>
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        ) : null}

        {(filter === "all" || filter === "files") && files.length > 0 ? (
          <>
            <div className="vaultLabel">Files</div>
            <div className="vaultTable">
              {files.map((e) => (
                <div key={e.key} className="vaultRow">
                  <i className="glyph" data-glyph="file" />
                  <button className="vaultName" onClick={() => onOpenFile(e.url, e.label)}>
                    {e.label}
                  </button>
                  <span className="vaultLoc">{e.url}</span>
                  <button className="vaultSession" onClick={() => onJump(e.sessionId)}>
                    {e.session}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {(filter === "all" || filter === "links") && links.length > 0 ? (
          <>
            <div className="vaultLabel">Links</div>
            <div className="vaultTable">
              {links.map((e) => (
                <div key={e.key} className="vaultRow">
                  <i className="glyph" data-glyph="web" />
                  <a className="vaultName" href={e.url} target="_blank" rel="noreferrer">
                    {e.label}
                  </a>
                  <span className="vaultLoc">{e.url}</span>
                  <button className="vaultSession" onClick={() => onJump(e.sessionId)}>
                    {e.session}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── HELM — "The Scrying Basin of Ares" ─────────────────────────────────────
// A God-of-War war-room: a molten scrying basin at the heart, six augury slates
// of live daemon data orbiting it, an omen ledger below. Everything heats, cools,
// boils and stirs off two drivers written to the root: --heat (0..1 molten temp)
// and --draft (0..1 daemon-gated ambient). Each agent action STIRS the basin.

function kfmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
}

function HelmView({
  daemon,
  opStatus,
  usage,
  keyStatus,
  sessions,
  active,
  onOpenSession,
  onToggleAutotick,
  onRefresh,
}: {
  daemon: DaemonState;
  opStatus: { activeCount: number; goals: Array<{ id: string; statement: string; status: string; progress: number }>; autotick: boolean; trust?: Array<{ domain: string; level: number; proven: number }> } | null;
  usage: UsageStats | null;
  keyStatus: Record<string, boolean>;
  sessions: SessionVm[];
  active: SessionVm | undefined;
  onOpenSession: (id: string) => void;
  onToggleAutotick: () => void;
  onRefresh: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const busy = Boolean(active?.busy);
  const activity = active?.activity ?? "";
  const [stir, setStir] = useState(0);

  // Heat/draft drivers — written straight to the node so the whole temple
  // re-tempers without per-frame React renders.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const base = daemon === "running" ? 0.34 : daemon === "starting" ? 0.2 : 0.06;
    const missionHeat = Math.min(0.18, (opStatus?.activeCount ?? 0) * 0.06);
    const heat = Math.min(1, base + (busy ? 0.42 : 0) + missionHeat);
    const draft = daemon === "running" ? 1 : daemon === "starting" ? 0.5 : 0.08;
    el.style.setProperty("--heat", heat.toFixed(3));
    el.style.setProperty("--draft", draft.toFixed(3));
    el.dataset.daemon = daemon;
    el.dataset.working = busy ? "1" : "0";
  }, [daemon, busy, opStatus?.activeCount]);

  // Action-as-heartbeat: each new activity string spikes a stir/shockwave.
  useEffect(() => {
    if (!activity) return;
    setStir((n) => n + 1);
  }, [activity]);

  const onMove = (e: React.MouseEvent) => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const tx = ((e.clientX - r.left) / r.width - 0.5) * 5;
    const ty = ((e.clientY - r.top) / r.height - 0.5) * 5;
    el.style.setProperty("--tilt-x", `${(-ty).toFixed(2)}deg`);
    el.style.setProperty("--tilt-y", `${tx.toFixed(2)}deg`);
  };

  const goals = opStatus?.goals ?? [];
  const activeGoals = goals.filter((g) => g.status === "active");
  const wonGoals = goals.filter((g) => g.status === "completed" || g.status === "done");
  const todos = active?.todos ?? [];
  const recentSessions = sessions.filter((s) => s.loaded !== false || s.items.length > 0).slice(0, 6);
  const services = [
    { id: "anthropic", label: "Anthropic" }, { id: "openrouter", label: "OpenRouter" },
    { id: "deepseek", label: "DeepSeek" }, { id: "ollama", label: "Ollama" }, { id: "brave", label: "Brave" },
  ];
  const connected = services.filter((s) => keyStatus[s.id]).length;
  const daily = usage?.daily ?? [];
  const peak = Math.max(1, ...daily.map((d) => d.in + d.out));

  return (
    <div className="helm-root" ref={rootRef} onMouseMove={onMove} data-daemon={daemon}>
      {/* ambient ember field — gated by --draft */}
      <div className="helm-embers" aria-hidden="true" />
      <div className="helm-vignette" aria-hidden="true" />

      {/* LINTEL — top ticker */}
      <div className="helm-lintel">
        <span className="helm-rune">⚔</span>
        <div className="helm-ticker">
          <span data-on={busy ? "1" : "0"}>{busy ? (activity || "Ares moves…") : daemon === "running" ? "The Garrison stands. Ares awaits the word." : `Daemon ${daemon}`}</span>
        </div>
        <button className="helm-refresh" onClick={onRefresh} title="Re-scry">⟳</button>
      </div>

      {/* CENTER GRID — basin flanked by three slates per side */}
      <div className="helm-content">
        {/* THE OMPHALOS — molten scrying basin */}
        <div className={busy ? "helm-basin working" : "helm-basin"} data-stir={stir % 2}>
          <ScryingBasin heat={busy ? 1 : 0.4} />
          <div className="helm-basin-core">
            <div className="helm-basin-count">{opStatus?.activeCount ?? 0}</div>
            <div className="helm-basin-label">{(opStatus?.activeCount ?? 0) === 1 ? "MISSION" : "MISSIONS"}</div>
            <div className="helm-basin-state" data-state={daemon}>{daemon === "running" ? "GARRISON UP" : daemon.toUpperCase()}</div>
          </div>
          {/* shockwave keyed to each stir */}
          <span key={stir} className="helm-shock" aria-hidden="true" />
        </div>

        <div className="helm-slate slate-war">
          <h4>Omen of War</h4>
          {activeGoals.length === 0 ? (
            <p className="helm-empty">No missions march. Queue one and Ares hunts unattended.</p>
          ) : (
            <ul className="helm-missions">
              {activeGoals.slice(0, 4).map((g) => (
                <li key={g.id}>
                  <span className="helm-mtext">{compact(g.statement, 54)}</span>
                  <span className="helm-bar"><i style={{ width: `${Math.round((g.progress ?? 0) * 100)}%` }} /></span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="helm-slate slate-plan">
          <h4>Pythia's Plan</h4>
          {todos.length === 0 ? (
            <p className="helm-empty">{busy ? "Ares deliberates…" : "Silent. No plan etched."}</p>
          ) : (
            <ul className="helm-todos">
              {todos.slice(0, 5).map((t) => (
                <li key={t.id} data-status={t.status}>
                  <i className="helm-glyph" />{compact(t.status === "in_progress" ? t.activeForm : t.content, 48)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="helm-slate slate-cost">
          <h4>Entrails of Cost</h4>
          <div className="helm-cost">
            <div><b><SpringNumber value={Math.max(0, (usage?.tokensIn ?? 0) - (usage?.cacheReadTokens ?? 0))} format={kfmt} /></b><span>fresh in</span></div>
            <div><b><SpringNumber value={usage?.tokensOut ?? 0} format={kfmt} /></b><span>out</span></div>
            <div><b><SpringNumber value={usage?.apiCalls ?? 0} format={kfmt} /></b><span>calls</span></div>
          </div>
          <div className="helm-cost-cached">
            cached <SpringNumber value={usage?.cacheReadTokens ?? 0} format={kfmt} /> · {usage && usage.tokensIn > 0 ? Math.round((usage.cacheReadTokens / usage.tokensIn) * 100) : 0}% reused
          </div>
          <div className="helm-spark">
            {daily.slice(-14).map((d, i) => (
              <span key={i} title={d.date} style={{ height: `${Math.max(6, Math.round(((d.in + d.out) / peak) * 100))}%` }} />
            ))}
          </div>
        </div>

        <div className="helm-slate slate-auguries">
          <h4>Auguries · {connected}/{services.length}</h4>
          <ul className="helm-augur">
            {services.map((s) => (
              <li key={s.id} data-on={keyStatus[s.id] ? "1" : "0"}><i />{s.label}</li>
            ))}
          </ul>
        </div>

        <div className="helm-slate slate-memory">
          <h4>Stelae of Memory · {sessions.length}</h4>
          {recentSessions.length === 0 ? (
            <p className="helm-empty">No engraved sessions yet.</p>
          ) : (
            <ul className="helm-stelae">
              {recentSessions.map((s) => (
                <li key={s.id}><button onClick={() => onOpenSession(s.id)}>{compact(s.title, 40)}</button></li>
              ))}
            </ul>
          )}
        </div>

        <div className="helm-slate slate-favor">
          <h4>Favor of Ares</h4>
          <div className="helm-gauge" data-state={daemon}>
            <div className="helm-gauge-fill" />
            <span>{daemon === "running" ? "FAVORED" : daemon.toUpperCase()}</span>
          </div>
          {(opStatus?.trust ?? []).length > 0 ? (
            <ul className="helm-trust" title="Earned leash — trust the Crucible has proven, domain by domain">
              {(opStatus?.trust ?? []).slice(0, 4).map((t) => (
                <li key={t.domain}>
                  <span className="helm-trust-domain">{t.domain}</span>
                  <span className="helm-trust-pips">
                    {[1, 2, 3, 4, 5].map((p) => <i key={p} data-lit={p <= t.level ? "1" : "0"} />)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <button className="helm-toggle" data-on={opStatus?.autotick ? "1" : "0"} onClick={onToggleAutotick}>
            <i />{opStatus?.autotick ? "Unattended hunt: ON" : "Unattended hunt: OFF"}
          </button>
        </div>
      </div>

      {/* OMEN LEDGER — recent victories */}
      <div className="helm-ledger">
        <span className="helm-rune">𐤀</span>
        {wonGoals.length === 0 ? (
          <span className="helm-ledger-empty">Victories will be carved here as missions fall.</span>
        ) : (
          <div className="helm-ledger-scroll">
            {wonGoals.slice(0, 8).map((g) => <span key={g.id} className="helm-tablet">✓ {compact(g.statement, 40)}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

// The molten basin surface — SVG feTurbulence + displacement (the WebGL-free
// "never blank" path from the design), with rotating rune rings and a pulsing
// core light whose intensity rides --heat.
function ScryingBasin({ heat }: { heat: number }) {
  return (
    <svg className="helm-basin-svg" viewBox="0 0 400 400" aria-hidden="true">
      <defs>
        <radialGradient id="moltenPool" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--ember-hi, #ffd27a)" stopOpacity={0.95} />
          <stop offset="34%" stopColor="var(--ember, #e08b2e)" stopOpacity={0.9} />
          <stop offset="68%" stopColor="var(--blood, #7a1f12)" stopOpacity={0.92} />
          <stop offset="100%" stopColor="#1a0d08" stopOpacity={1} />
        </radialGradient>
        <radialGradient id="poolGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--ember-hi, #ffd27a)" stopOpacity={0.9} />
          <stop offset="55%" stopColor="var(--accent, #c79a4e)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--accent, #c79a4e)" stopOpacity={0} />
        </radialGradient>
        <filter id="boil" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves={2} seed={7} result="noise">
            <animate attributeName="baseFrequency" dur={`${(9 - heat * 4).toFixed(1)}s`} values="0.010 0.018;0.020 0.030;0.010 0.018" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale={heat > 0.7 ? 26 : 16} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      {/* outer rune ring */}
      <circle className="helm-ring-outer" cx="200" cy="200" r="186" />
      <circle className="helm-ring-mid" cx="200" cy="200" r="158" />
      {/* the molten surface */}
      <circle cx="200" cy="200" r="140" fill="url(#moltenPool)" filter="url(#boil)" className="helm-pool" />
      {/* fresnel rim */}
      <circle cx="200" cy="200" r="140" fill="none" stroke="var(--ember-hi, #ffd27a)" strokeOpacity={0.5} strokeWidth={2} className="helm-pool-rim" />
      {/* core light */}
      <circle cx="200" cy="200" r="120" fill="url(#poolGlow)" className="helm-pool-glow" />
    </svg>
  );
}

function SessionRow({
  s,
  activeId,
  pinned,
  onSelect,
  onPin,
  onRename,
  onClose,
}: {
  s: SessionVm;
  activeId: string;
  pinned?: boolean;
  onSelect: (id: string) => void;
  onPin: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onClose: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.title);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(s.title);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, s.title]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== s.title) onRename(s.id, next);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={s.id === activeId ? "session on editing" : "session editing"}>
        <input
          ref={inputRef}
          className="sessionRename"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className={s.id === activeId ? "session on" : "session"}>
      <button className="sessionMain" onClick={() => onSelect(s.id)} onDoubleClick={() => setEditing(true)} title="Double-click to rename">
        <i data-busy={s.busy ? "1" : "0"} />
        <span>{s.title}</span>
      </button>
      <div className="sessionActions">
        <button className="rowBtn" title="Rename" onClick={() => setEditing(true)}>✎</button>
        <button className="pinBtn" data-pinned={pinned ? "1" : "0"} title={pinned ? "unpin" : "pin"} onClick={() => onPin(s.id)}>
          {pinned ? "◆" : "◇"}
        </button>
        {confirming ? (
          <button className="rowBtn danger" title="Confirm delete" onClick={() => { onClose(s.id); setConfirming(false); }}>✓</button>
        ) : (
          <button className="rowBtn" title="Close session" onClick={() => { setConfirming(true); setTimeout(() => setConfirming(false), 2600); }}>✕</button>
        )}
      </div>
    </div>
  );
}

// ─── The live fleet board — Conductor agents, grouped by phase ──────────────
// ─── The delegation cut-scene — Ares handing a job to Claude Code / Codex ────
// A little animated stage: Ares (the dragon) beams a task across to the chosen
// backend's character, a phase timeline lights up (detect → install → running →
// done), and Ares narrates. Pure CSS/emoji — no assets, CSP-safe.
const CODING_CHARS: Record<string, { glyph: string; accent: string }> = {
  claude: { glyph: "✳", accent: "#d9935a" },
  codex: { glyph: "◆", accent: "#74c39c" },
};
const CODING_PHASES: Array<CodingBackendVm["phase"]> = ["detect", "install", "running", "done"];
function codingNarration(vm: CodingBackendVm): string {
  switch (vm.phase) {
    case "detect": return `Sizing up the job — is ${vm.label} here?`;
    case "install": return `Bringing ${vm.label} online…`;
    case "running": return `${vm.label} is on it — I'm driving. This is overpowered.`;
    case "done": return `Done — ${vm.filesTouched} file${vm.filesTouched === 1 ? "" : "s"} touched. Completely overpowered. 🔥`;
    case "failed": return `${vm.label} choked. I've got it from here.`;
    default: return "";
  }
}
function CodingBackendScene({ vm }: { vm: CodingBackendVm }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (vm.phase === "done" || vm.phase === "failed") return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [vm.phase]);
  const backend = CODING_CHARS[vm.backend] ?? CODING_CHARS.claude;
  const elapsed = Math.max(0, Math.round((Date.now() - vm.startedTick) / 1000));
  const running = vm.phase === "running";
  const activeIdx = CODING_PHASES.indexOf(vm.phase === "failed" ? "running" : vm.phase);
  const lastLine = vm.lines[vm.lines.length - 1];
  return (
    <div className="cbScene" data-phase={vm.phase} data-backend={vm.backend} style={{ ["--cb-accent" as string]: backend.accent }}>
      <div className="cbStage">
        <div className="cbChar cbAres" title="Ares">
          <span className="cbAvatar">🐉</span>
          <span className="cbName">Ares</span>
        </div>
        <div className="cbBeam" aria-hidden="true"><i /><i /><i /></div>
        <div className="cbChar cbBackend" title={vm.label}>
          <span className="cbAvatar">{backend.glyph}</span>
          <span className="cbName">{vm.label}</span>
        </div>
      </div>
      <div className="cbBubble">{codingNarration(vm)}</div>
      <div className="cbTimeline">
        {CODING_PHASES.map((p, i) => (
          <div key={p} className="cbStep" data-state={vm.phase === "done" || i < activeIdx ? "done" : i === activeIdx ? "active" : "todo"}>
            <i className="cbStepDot" /><span>{p}</span>
          </div>
        ))}
      </div>
      <div className="cbMeta">
        {running && lastLine ? <span className="cbLive" title={lastLine}>{lastLine.slice(0, 84)}</span> : <span className="cbLive cbLiveIdle">{running ? "streaming…" : vm.phase}</span>}
        <span className="cbTally">{vm.filesTouched} file{vm.filesTouched === 1 ? "" : "s"}</span>
        <span className="cbClock">{elapsed}s</span>
      </div>
    </div>
  );
}

function FleetPanel({ fleet, onResume }: { fleet: FleetVm; onResume: (fleetId: string) => void }) {
  const agents = fleet.agents;
  const total = agents.length;
  const done = agents.filter((a) => a.status === "done").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const running = agents.filter((a) => a.status === "running").length;
  const phases: string[] = [];
  for (const a of agents) if (!phases.includes(a.phase)) phases.push(a.phase);
  return (
    <div className="fleetPanel" data-active={fleet.active ? "1" : "0"}>
      <div className="fleetHead">
        <span className="fleetTitle"><i className="fleetPulse" />FLEET</span>
        <span className="fleetCounts">
          {running > 0 ? <em data-k="run">{running} running</em> : null}
          <em data-k="done">{done} done</em>
          {failed > 0 ? <em data-k="fail">{failed} failed</em> : null}
          <em data-k="total">/ {total}</em>
          {fleet.canResume && fleet.fleetId ? (
            <button className="fleetResume" onClick={() => onResume(fleet.fleetId!)} title="re-run the failed leaves; completed ones are reused from disk">
              ↻ Resume
            </button>
          ) : null}
        </span>
      </div>
      <div className="fleetBody">
        {phases.map((ph) => (
          <div key={ph} className="fleetPhase">
            <div className="fleetPhaseName">{ph}</div>
            <div className="fleetAgents">
              {agents.filter((a) => a.phase === ph).map((a) => (
                <div key={a.id} className="fleetAgent" data-status={a.status}>
                  <i className="fleetDot" />
                  <span className="fleetRole">{a.role}</span>
                  <span className="fleetAct">
                    {a.resumed ? "reused" : a.status === "running" ? (a.activity || a.tool || "working…") : a.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── The effort slider — low → max → ULTRA (with the fleet ignition) ─────────
function ReasoningSlider({ value, onChange }: { value: EffortStep; onChange: (s: EffortStep) => void }) {
  const idx = EFFORT_STEPS.indexOf(value);
  const ignited = value === "ultra";
  const pct = (idx / (EFFORT_STEPS.length - 1)) * 100;
  return (
    <div className={ignited ? "effortSlider ignited" : "effortSlider"} data-step={value}>
      <div className="effortTrack">
        <div className="effortFill" style={{ width: `${pct}%` }} />
        <div className="effortFlame" aria-hidden="true" />
        <div className="effortThumb" style={{ left: `${pct}%` }} />
        <input
          className="effortRange"
          type="range"
          min={0}
          max={EFFORT_STEPS.length - 1}
          step={1}
          value={idx}
          aria-label="reasoning effort"
          onChange={(e) => onChange(EFFORT_STEPS[Number(e.target.value)])}
        />
      </div>
      <div className="effortLabels">
        {EFFORT_STEPS.map((s) => (
          <button
            key={s}
            className="effortLabel"
            data-on={s === value ? "1" : "0"}
            data-ultra={s === "ultra" ? "1" : "0"}
            onClick={() => onChange(s)}
          >
            {EFFORT_META[s].label}
          </button>
        ))}
      </div>
      <div className="effortHint">{EFFORT_META[value].hint}</div>
    </div>
  );
}

// ─── Dictation (speech → text) ───────────────────────────────────────────────
// Mic → MediaRecorder (webm/opus) → Google Speech REST. Same public Chromium key
// the rest of Ares uses for voice notes; the webview reaches the API directly
// (verified: no CORS wall), so this needs no daemon, no native bridge, no keys.
const STT_KEY_ENC = "QUl6YVN5Qk90aTRtTS02eDlXRG5aSWpJZXlFVTIxT3BCWHFXQmd3";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1)); // strip the data: prefix
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Base64 payload of a data URL (the part that actually crosses the wire).
function dataUrlB64Len(dataUrl: string): number {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.length - i - 1 : dataUrl.length;
}

// Vision-safe downscale, done in the webview with a plain <canvas> — no deps.
// WHY THIS EXISTS: the Ares Gateway rides Vercel, whose serverless transport
// hard-caps the request body at ~4.5MB. A raw pasted screenshot (often 5–12MB)
// used to sail past the old client guard, 413 at the gateway, and — because the
// same oversized body was resent every turn — LOCK the session dead (a real
// user sat stranded for 8h overnight). Models already downscale images to
// ~1568px on the long edge, so shrinking to that here costs the model nothing
// while cutting multi-MB pastes to a few hundred KB. We re-encode as JPEG and
// step quality/size down until the payload is comfortably under budget.
const MAX_ATTACH_B64 = 2_000_000; // ~1.5MB decoded — leaves room for text + a 2nd image under 4.5MB
const MAX_IMG_EDGE = 1568; // Anthropic's long-edge downscale target; larger buys no quality
async function downscaleAttachment(dataUrl: string): Promise<string> {
  // Already small — leave it byte-for-byte (keeps PNG alpha / exact pixels).
  if (dataUrlB64Len(dataUrl) <= MAX_ATTACH_B64) return dataUrl;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = dataUrl;
    });
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (!w || !h) return dataUrl;
    const scale = Math.min(1, MAX_IMG_EDGE / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const render = (cw: number, ch: number): HTMLCanvasElement | null => {
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // JPEG has no alpha — white-fill first so transparent PNGs don't go black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      return canvas;
    };
    let canvas = render(w, h);
    if (!canvas) return dataUrl;
    // Step quality down, then halve dimensions, until it fits the wire budget.
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const out = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlB64Len(out) <= MAX_ATTACH_B64) return out;
    }
    for (let pass = 0; pass < 3; pass++) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      canvas = render(w, h);
      if (!canvas) break;
      const out = canvas.toDataURL("image/jpeg", 0.6);
      if (dataUrlB64Len(out) <= MAX_ATTACH_B64) return out;
    }
    return canvas ? canvas.toDataURL("image/jpeg", 0.4) : dataUrl; // best effort
  } catch {
    return dataUrl; // never block a paste on a processing failure — the daemon guard is the backstop
  }
}

async function transcribeSpeech(blob: Blob, language = "en-US"): Promise<string> {
  const key = atob(STT_KEY_ENC);
  const content = await blobToBase64(blob);
  const res = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { encoding: "WEBM_OPUS", languageCode: language, model: "default", enableAutomaticPunctuation: true },
      audio: { content },
    }),
  });
  if (!res.ok) throw new Error(`stt ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  return (data.results ?? []).map((r) => r.alternatives?.[0]?.transcript ?? "").join(" ").trim();
}

type DictState = "idle" | "recording" | "thinking" | "error";
/** Click to record, click to stop → transcribe → onText. Auto-stops on unmount. */
function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictState>("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const stop = useCallback(() => {
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        cleanupStream();
        const blob = new Blob(chunksRef.current, { type: mime });
        if (!blob.size) { setState("idle"); return; }
        setState("thinking");
        try {
          const txt = await transcribeSpeech(blob);
          setState("idle");
          if (txt) onTextRef.current(txt);
        } catch {
          setState("error");
          setTimeout(() => setState("idle"), 2400);
        }
      };
      rec.start();
      recRef.current = rec;
      setState("recording");
    } catch {
      cleanupStream();
      setState("error");
      setTimeout(() => setState("idle"), 2400);
    }
  }, []);

  const toggle = useCallback(() => {
    setState((s) => {
      if (s === "recording") { stop(); return s; }
      if (s === "idle" || s === "error") { void start(); }
      return s;
    });
  }, [start, stop]);

  useEffect(() => () => { stop(); cleanupStream(); }, [stop]);

  return { state, toggle };
}

const MicGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
    <path d="M3.5 7.5 A4.5 4.5 0 0 0 12.5 7.5 M8 12 L8 14.5 M5.5 14.5 L10.5 14.5" />
  </svg>
);

// ─── The floating pill — Ares condensed to an always-on-top mic bar ──────────
function PillBar({
  daemon,
  busy,
  activity,
  pinTop,
  onTogglePin,
  onExpand,
  onSend,
  onStop,
  native,
}: {
  daemon: DaemonState;
  busy: boolean;
  activity: string;
  pinTop: boolean;
  onTogglePin: () => void;
  onExpand: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  native: boolean;
}) {
  const dictation = useDictation((t) => { if (t) onSend(t); });
  const label =
    dictation.state === "recording" ? "listening…" :
    dictation.state === "thinking" ? "transcribing…" :
    dictation.state === "error" ? "mic blocked" :
    busy ? (activity || "working…") :
    daemon === "running" ? "ready" : daemon;

  const onDrag = (e: React.MouseEvent) => {
    if (!native || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().startDragging().catch(() => null);
  };

  return (
    <div className="pillBar" data-busy={busy ? "1" : "0"} onMouseDown={onDrag}>
      <div className="pillMark" aria-hidden="true" />
      <span className="pillStatus">
        <i className="dot" data-state={busy ? "running" : daemon} />
        <em>{label}</em>
      </span>
      <span className="pillGrow" />
      <button className="pillMic" data-state={dictation.state} onClick={dictation.toggle} title={dictation.state === "recording" ? "stop & send" : "speak to Ares"}>
        {dictation.state === "thinking" ? <i className="pillSpin" /> : <MicGlyph />}
      </button>
      {busy ? (
        <button className="pillBtn" onClick={onStop} title="stop the turn">
          <svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
        </button>
      ) : null}
      <button className="pillBtn" data-on={pinTop ? "1" : "0"} onClick={onTogglePin} title={pinTop ? "always-on-top: ON" : "always-on-top: OFF"}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 2 L11 2 L10 7 L13 10 L3 10 L6 7 Z M8 10 L8 14" />
        </svg>
      </button>
      <button className="pillBtn" onClick={onExpand} title="expand Ares">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 2 L14 2 L14 7 M14 2 L8.5 7.5 M7 14 L2 14 L2 9 M2 14 L7.5 8.5" />
        </svg>
      </button>
    </div>
  );
}

// ─── Composer ───────────────────────────────────────────────────────────────
// Owns its OWN text state so keystrokes never re-render the transcript. Sends,
// or steers mid-turn (queue a message the daemon folds in at a safe boundary).

const Composer = React.memo(function Composer({
  busy,
  model,
  autoRouting,
  reasoning,
  routedLanes,
  todos,
  steerQueued,
  onSend,
  onSteer,
  onStop,
  onModelChip,
  onReasoningChip,
  onRoutingChip,
}: {
  busy: boolean;
  model: string;
  autoRouting: boolean;
  reasoning: ReasoningLevel;
  routedLanes: RouteLane[];
  todos: Array<{ id: string; content: string; activeForm: string; status: string }>;
  steerQueued: number;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onStop: () => void;
  onModelChip: () => void;
  onReasoningChip: () => void;
  onRoutingChip: () => void;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachmentsState] = useState<Array<{ name: string; dataUrl: string }>>([]);
  // Mirrors `attachments` synchronously. Refs update immediately (unlike state,
  // which is batched/rendered-on-a-delay) — submit() reads THIS after awaiting
  // in-flight reads below, since the `attachments` state variable itself would
  // still be the stale value captured when this render's submit closure formed.
  const attachmentsRef = useRef<Array<{ name: string; dataUrl: string }>>([]);
  const setAttachments = (updater: (prev: Array<{ name: string; dataUrl: string }>) => Array<{ name: string; dataUrl: string }>) => {
    attachmentsRef.current = updater(attachmentsRef.current);
    setAttachmentsState(attachmentsRef.current);
  };
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // In-flight FileReader reads from a paste/drop that haven't landed in
  // `attachments` yet. FileReader is async — pasting a screenshot and
  // immediately hitting Enter (a completely normal motion) could fire submit()
  // before the read finishes, silently sending text-only with the image gone
  // and no error shown ("Ares can't see my pasted image"). submit() awaits
  // these before deciding what to send.
  const pendingReads = useRef<Set<Promise<void>>>(new Set());
  // Dictation drops the transcript into the draft (appended), then focuses.
  const dictation = useDictation((t) => {
    setText((prev) => (prev.trim() ? prev.replace(/\s+$/, "") + " " : "") + t);
    ref.current?.focus();
  });

  const addFiles = (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue; // vision models read images
      if (file.size > 15 * 1024 * 1024) continue;
      const read: Promise<void> = new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result ?? "");
          if (!dataUrl.startsWith("data:image/")) {
            resolve();
            return;
          }
          // Shrink to a vision-safe size BEFORE it becomes an attachment, so an
          // oversized paste can never reach the gateway and 413 the turn.
          void downscaleAttachment(dataUrl)
            .then((processed) => {
              setAttachments((prev) => [...prev, { name: file.name || "pasted-image", dataUrl: processed }]);
            })
            .finally(() => resolve());
        };
        reader.onerror = () => resolve(); // never hang submit() on an unreadable file
        reader.readAsDataURL(file);
      });
      pendingReads.current.add(read);
      void read.finally(() => pendingReads.current.delete(read));
    }
  };

  const submit = async () => {
    if (pendingReads.current.size > 0) await Promise.all(pendingReads.current);
    const t = text.trim();
    const currentAttachments = attachmentsRef.current;
    if (!t && currentAttachments.length === 0) return;
    // The daemon's contentFromUserInput parses data:image URLs out of the goal
    // into image blocks — so we just append them to the message text.
    const payload = [t, ...currentAttachments.map((a) => a.dataUrl)].filter(Boolean).join("\n");
    if (busy) onSteer(payload);
    else onSend(payload);
    setText("");
    setAttachments(() => []);
    if (ref.current) ref.current.style.height = "auto";
  };
  return (
    <div className="composer">
      {todos.length > 0 ? <TodoPanel todos={todos} /> : null}
      {/* Model / reasoning / routing live in the bottom HUD only — no duplicate
         control strip over the input. Just a contextual steer indicator here. */}
      {busy && steerQueued > 0 ? (
        <div className="chips">
          <span className="chip steerChip">{steerQueued} steer queued</span>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="attachments">
          {attachments.map((a, idx) => (
            <span className="attachChip" key={idx} title={a.name}>
              <img src={a.dataUrl} alt={a.name} />
              <span className="attachName">{a.name}</span>
              <button onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))} aria-label="remove">
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div
        className="composerRow"
        data-busy={busy ? "1" : "0"}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (e.dataTransfer?.files?.length) {
            e.preventDefault();
            addFiles(Array.from(e.dataTransfer.files));
          }
        }}
      >
        <textarea
          ref={ref}
          value={text}
          placeholder={busy ? "Steer the agent… (sent at the next safe moment)" : "Message Ares…  (paste or drop an image)"}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
          }}
          onPaste={(e) => {
            const imageItems = Array.from(e.clipboardData?.items ?? []).filter((it) => it.type.startsWith("image/"));
            if (imageItems.length) {
              e.preventDefault();
              addFiles(imageItems.map((it) => it.getAsFile()).filter((f): f is File => !!f));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="mic"
          data-state={dictation.state}
          onClick={dictation.toggle}
          aria-label="dictate"
          title={dictation.state === "recording" ? "stop & transcribe" : dictation.state === "error" ? "mic unavailable" : "speak to type"}
        >
          {dictation.state === "thinking" ? <i className="micSpin" /> : <MicGlyph />}
        </button>
        {busy ? (
          <>
            {text.trim() ? (
              <button className="send steer" onClick={() => void submit()} aria-label="steer" title="queue this — folded in at a safe moment">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3 L8 13 M3 8 L13 8" />
                </svg>
              </button>
            ) : null}
            <button className="send stop" onClick={onStop} aria-label="stop" title="stop this turn">
              <svg viewBox="0 0 16 16" fill="currentColor">
                <rect x="4" y="4" width="8" height="8" rx="1.5" />
              </svg>
            </button>
          </>
        ) : (
          <button className="send" onClick={() => void submit()} disabled={!text.trim() && attachments.length === 0} aria-label="send">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 8 L14 2 L10.5 14 L8 9 Z" />
            </svg>
          </button>
        )}
      </div>
      {/* new-style only: a slim pulse line whose amplitude rides tokens/sec.
          Renders null in legacy mode / at rest / under reduced motion. */}
      <TokenFlowStrip busy={busy} />
    </div>
  );
});

// ─── Transcript items ──────────────────────────────────────────────────────

// Build a flame-tongue silhouette path from per-tongue tip heights. `sharp`
// pulls the control points toward the tip so tongues taper to a point (real
// flames lick to thin tips, not rounded bumps).
function flamePath(tips: number[], W: number, base: number, sharp = 0.16): string {
  const step = W / tips.length;
  let d = `M0,${base}`;
  tips.forEach((h, i) => {
    const x0 = i * step, xc = x0 + step / 2, x1 = x0 + step;
    d += ` C ${(x0 + step * 0.28).toFixed(1)},${(base - h * 0.28).toFixed(1)} ${(xc - step * sharp).toFixed(1)},${(h * 1.05).toFixed(1)} ${xc.toFixed(1)},${h.toFixed(1)}`;
    d += ` C ${(xc + step * sharp).toFixed(1)},${(h * 1.05).toFixed(1)} ${(x1 - step * 0.28).toFixed(1)},${(base - h * 0.28).toFixed(1)} ${x1.toFixed(1)},${base}`;
  });
  return d + ` L${W},${base} Z`;
}

// ─── Embedded interactive browser — Ares's OWN in-app browser ───────────────
// For Ares's self-contained HTML apps/games: renders same-origin so Ares can
// reach in and DRIVE it — a real cursor glides to controls (curved + eased),
// hovers, presses, clicks; types char-by-char; reads console; evaluates JS.
// Zero Playwright, fully in-window, the owner watches it happen.

export interface EmbeddedBrowserHandle {
  load: (html: string) => Promise<{ ok: boolean }>;
  click: (query: string) => Promise<{ ok: boolean; matched?: string; error?: string }>;
  type: (selector: string, value: string) => Promise<{ ok: boolean; error?: string }>;
  evalJs: (js: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  getConsole: (onlyErrors?: boolean) => { type: string; text: string }[];
  snapshot: () => { title: string; text: string; controls: string[] };
}

const EmbeddedBrowser = React.forwardRef<EmbeddedBrowserHandle, { paceMs?: number; onActivity?: (label: string) => void }>(
  function EmbeddedBrowser({ paceMs = 460, onActivity }, ref) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const cur = useRef({ x: 200, y: 160 });
    const consoleBuf = useRef<{ type: string; text: string }[]>([]);

    const doc = () => iframeRef.current?.contentDocument ?? null;
    const win = () => iframeRef.current?.contentWindow as (Window & typeof globalThis) | null;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

    const ensureCursor = () => {
      const d = doc();
      if (!d || !d.body || d.getElementById("__ares_cur")) return;
      const c = d.createElement("div");
      c.id = "__ares_cur";
      c.style.cssText =
        "position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:filter 90ms ease;will-change:transform;filter:drop-shadow(0 2px 5px rgba(0,0,0,.55))";
      c.innerHTML =
        '<svg width="24" height="24" viewBox="0 0 26 26"><path d="M3,2 L3,20 L8,15 L11,23 L14,22 L11,14 L18,14 Z" fill="#fff" stroke="#d6402e" stroke-width="1.7" stroke-linejoin="round"/></svg>';
      d.body.appendChild(c);
      const st = d.createElement("style");
      st.textContent = "@keyframes __ar{0%{transform:translate(-50%,-50%) scale(.2);opacity:.95}100%{transform:translate(-50%,-50%) scale(2);opacity:0}}";
      d.head.appendChild(st);
    };
    const moveCur = (x: number, y: number, scale = 1) => {
      const c = doc()?.getElementById("__ares_cur");
      if (c) (c as HTMLElement).style.transform = `translate(${x - 3}px,${y - 2}px) scale(${scale})`;
    };
    const ripple = (x: number, y: number) => {
      const d = doc();
      if (!d) return;
      const r = d.createElement("div");
      r.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:34px;height:34px;border:2.5px solid #d6402e;border-radius:50%;z-index:2147483646;pointer-events:none;animation:__ar .5s ease-out forwards`;
      d.body.appendChild(r);
      setTimeout(() => r.remove(), 560);
    };

    const glide = async (tx: number, ty: number) => {
      ensureCursor();
      const sx = cur.current.x, sy = cur.current.y;
      const dx = tx - sx, dy = ty - sy, dist = Math.hypot(dx, dy);
      if (dist < 1.5) { cur.current = { x: tx, y: ty }; moveCur(tx, ty); return; }
      const bow = Math.min(dist * 0.16, 70) * (Math.random() < 0.5 ? 1 : -1);
      const mx = (sx + tx) / 2 - (dy / dist) * bow, my = (sy + ty) / 2 + (dx / dist) * bow;
      const steps = Math.max(14, Math.min(44, Math.round(dist / 9)));
      for (let i = 1; i <= steps; i++) {
        const t = easeInOut(i / steps), u = 1 - t;
        const x = u * u * sx + 2 * u * t * mx + t * t * tx;
        const y = u * u * sy + 2 * u * t * my + t * t * ty;
        moveCur(x, y);
        cur.current = { x, y };
        // fire a real hover on whatever's under the cursor (cosmetic — never let it break the action)
        try {
          const w = win();
          const el = doc()?.elementFromPoint(x, y);
          if (w && el && typeof w.MouseEvent === "function") el.dispatchEvent(new w.MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
        } catch { /* ignore hover */ }
        await sleep(paceMs / steps);
      }
      cur.current = { x: tx, y: ty };
    };

    const findEl = (query: string): HTMLElement | null => {
      const d = doc();
      if (!d) return null;
      // CSS selector first
      try { const byCss = d.querySelector(query) as HTMLElement | null; if (byCss) return byCss; } catch { /* not a selector */ }
      // visible text match on clickable-ish elements
      const cands = [...d.querySelectorAll("button,a,[role=button],input,summary,label,[onclick],.btn,td,li,span,div")] as HTMLElement[];
      const q = query.trim().toLowerCase();
      return cands.find((e) => (e.textContent ?? "").trim().toLowerCase() === q)
        ?? cands.find((e) => (e.textContent ?? "").trim().toLowerCase().includes(q))
        ?? null;
    };

    const hookConsole = () => {
      const w = win();
      if (!w || (w as unknown as { __aresHooked?: boolean }).__aresHooked) return;
      (w as unknown as { __aresHooked?: boolean }).__aresHooked = true;
      const wrap = (type: string, orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
        consoleBuf.current.push({ type, text: args.map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 1500) });
        if (consoleBuf.current.length > 300) consoleBuf.current.shift();
        orig(...args);
      };
      try {
        w.console.log = wrap("log", w.console.log.bind(w.console));
        w.console.warn = wrap("warn", w.console.warn.bind(w.console));
        w.console.error = wrap("error", w.console.error.bind(w.console));
        w.addEventListener("error", (e) => consoleBuf.current.push({ type: "error", text: String((e as ErrorEvent).message) }));
      } catch { /* cross-origin — can't hook */ }
    };

    useImperativeHandle(ref, () => ({
      load: (html: string) =>
        new Promise((resolve) => {
          const f = iframeRef.current;
          if (!f) return resolve({ ok: false });
          consoleBuf.current = [];
          cur.current = { x: 200, y: 160 };
          const onLoad = () => {
            f.removeEventListener("load", onLoad);
            hookConsole();
            ensureCursor();
            resolve({ ok: true });
          };
          f.addEventListener("load", onLoad);
          f.srcdoc = html;
        }),
      click: async (query: string) => {
        const el = findEl(query);
        if (!el) return { ok: false, error: `no element matching "${query}"` };
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        await sleep(180);
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        onActivity?.(`Clicking ${(el.textContent ?? el.tagName).trim().slice(0, 30)}`);
        await glide(cx, cy);
        await sleep(120);
        moveCur(cx, cy, 0.8); await sleep(90); moveCur(cx, cy, 1);
        ripple(cx, cy);
        const W = win()!;
        // press feedback, then ONE real click (el.click fires the native handler) —
        // don't also dispatch a synthetic 'click' or it double-fires onclick.
        for (const t of ["mousedown", "mouseup"]) el.dispatchEvent(new W.MouseEvent(t, { bubbles: true, clientX: cx, clientY: cy }));
        if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
        else el.dispatchEvent(new W.MouseEvent("click", { bubbles: true, clientX: cx, clientY: cy }));
        await sleep(220);
        return { ok: true, matched: (el.textContent ?? el.tagName).trim().slice(0, 60) };
      },
      type: async (selector: string, value: string) => {
        const el = findEl(selector) as HTMLInputElement | null;
        if (!el) return { ok: false, error: `no field matching "${selector}"` };
        const r = el.getBoundingClientRect();
        await glide(r.left + r.width / 2, r.top + r.height / 2);
        el.focus();
        onActivity?.(`Typing into ${selector}`);
        const W = win()!;
        el.value = "";
        for (const chr of value) {
          el.value += chr;
          el.dispatchEvent(new W.Event("input", { bubbles: true }));
          await sleep(55);
        }
        el.dispatchEvent(new W.Event("change", { bubbles: true }));
        return { ok: true };
      },
      evalJs: async (js: string) => {
        const w = win();
        if (!w) return { ok: false, error: "no window" };
        try { return { ok: true, result: (w as unknown as { eval: (s: string) => unknown }).eval(`(()=>{return (${js})})()`) }; }
        catch (e) { try { return { ok: true, result: (w as unknown as { eval: (s: string) => unknown }).eval(`(()=>{${js}})()`) }; } catch (e2) { return { ok: false, error: String(e2 instanceof Error ? e2.message : e2) }; } }
      },
      getConsole: (onlyErrors?: boolean) => onlyErrors ? consoleBuf.current.filter((c) => c.type === "error" || c.type === "warn") : consoleBuf.current.slice(),
      snapshot: () => {
        const d = doc();
        const controls = d ? ([...d.querySelectorAll("button,a,[role=button],input,select,summary")] as HTMLElement[]).map((e) => (e.textContent ?? (e as HTMLInputElement).placeholder ?? e.tagName).trim().slice(0, 40)).filter(Boolean).slice(0, 40) : [];
        return { title: d?.title ?? "", text: (d?.body?.innerText ?? "").slice(0, 4000), controls };
      },
    }), [paceMs, onActivity]);

    return (
      <iframe
        ref={iframeRef}
        title="Ares embedded browser"
        className="embeddedBrowserFrame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"
      />
    );
  },
);

// A layered strip of real fire: a deep-red body, an orange mid, and a white-hot
// core — each its own tongue shape, gradient, turbulence and flicker rate, so it
// reads as volumetric flame, not a glow.
function FlameStrip() {
  const W = 280, base = 22;
  // Back body: tall, broad, fewer tongues. Mid: medium. Core: short, sharp, many.
  const back = flamePath([16, 9, 19, 6, 14, 10, 18, 7, 15, 11, 17, 8], W, base, 0.24);
  const mid = flamePath([12, 6, 15, 4, 10, 8, 14, 5, 11, 7, 13, 5, 12, 9, 15, 6], W, base, 0.16);
  const core = flamePath([7, 3, 9, 2, 6, 4, 8, 3, 6, 5, 7, 3, 8, 4, 6, 3, 7, 4, 8, 3], W, base, 0.1);
  return (
    <svg viewBox={`0 0 ${W} ${base}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="flame-back" d={back} fill="url(#flameGradBack)" filter="url(#flameTurbCoarse)" />
      <path className="flame-mid" d={mid} fill="url(#flameGradMid)" filter="url(#flameTurb)" />
      <path className="flame-core" d={core} fill="url(#flameGradCore)" filter="url(#flameTurbFine)" />
    </svg>
  );
}

// The whole-UI flame border: four edge strips licking inward. Shown when working.
function ScreenFlame() {
  return (
    <div className="screenFlame" aria-hidden="true">
      <div className="fStrip edge-top"><FlameStrip /></div>
      <div className="fStrip edge-bottom"><FlameStrip /></div>
      <div className="fStrip edge-left"><FlameStrip /></div>
      <div className="fStrip edge-right"><FlameStrip /></div>
    </div>
  );
}

// ─── Hacker rain — the ULTRA working effect. When the fleet is running, the
// flame rims become Matrix-style digital rain (purple in nightfall, else green),
// raining on the edges until the turn finishes. Center is masked out via CSS.
function HackerRain({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const root = document.querySelector(".ares") ?? document.documentElement;
    const theme = root.getAttribute("data-theme");
    const color = theme === "nightfall" ? "#b9a8ff" : "#5cf08a"; // purple or matrix-green
    const fontSize = 14;
    const glyphs = "アァカサタナハマヤラ0123456789ABCDEF<>/\\|=+*#".split("");
    let w = 0, h = 0, cols = 0, drops: number[] = [], raf = 0;
    const resize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
      cols = Math.ceil(w / fontSize);
      drops = Array.from({ length: cols }, () => Math.floor(Math.random() * -60));
    };
    resize();
    window.addEventListener("resize", resize);
    const draw = () => {
      ctx.fillStyle = "rgba(6,5,8,0.10)"; // fade trail
      ctx.fillRect(0, 0, w, h);
      ctx.font = `${fontSize}px "Cascadia Code", monospace`;
      for (let i = 0; i < cols; i++) {
        const ch = glyphs[(Math.random() * glyphs.length) | 0];
        const x = i * fontSize;
        const y = drops[i] * fontSize;
        // lead glyph brighter than the trail
        ctx.fillStyle = Math.random() > 0.92 ? "#ffffff" : color;
        ctx.fillText(ch, x, y);
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [active]);
  if (!active) return null;
  return <canvas ref={ref} className="hackerRain" aria-hidden="true" />;
}

const ItemView = React.memo(function ItemView({
  item,
  onPermission,
  onArtifact,
  onSignIn,
  toolDisplay,
}: {
  item: Item;
  onPermission: (id: string, decision: string) => void;
  onArtifact: (path: string, label: string) => void;
  onSignIn?: () => void;
  toolDisplay?: "product" | "technical";
}) {
  if (item.kind === "authPrompt") {
    return (
      <div className="authPrompt">
        <div className="authPromptMark" aria-hidden="true" />
        <div className="authPromptBody">
          <strong>Sign in to use this model</strong>
          <span>{item.text}</span>
        </div>
        <button className="primary" onClick={() => onSignIn?.()}>
          ◆ Sign in with Claude
        </button>
      </div>
    );
  }
  if (item.kind === "artifact") {
    return (
      <button className="artifact" onClick={() => onArtifact(item.path, item.label)}>
        <i aria-hidden="true" />
        <span>
          <strong>{item.label}</strong>
          <em>{HOLO_SPEC_FILE.test(item.path) ? "hologram spec — open on the holotable" : "artifact forged — open in the panel"}</em>
        </span>
        <span className="artifactGo">PREVIEW ▸</span>
      </button>
    );
  }
  if (item.kind === "user") {
    return (
      <div className="turn user">
        <div className="bubble">{item.text}</div>
      </div>
    );
  }
  if (item.kind === "steer") {
    return (
      <div className="turn user steer" data-landed={item.landed ? "1" : "0"}>
        <div className="bubble">
          <span className="steerTag">{item.landed ? "steered" : "steer queued"}</span>
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="turn assistant" data-streaming={item.streaming ? "1" : "0"} data-proactive={item.proactive ? "1" : "0"}>
        {item.proactive ? (
          <div className="watchBadge" title="Ares noticed this on your screen — unprompted">
            <span aria-hidden="true">👁</span> watching
          </div>
        ) : null}
        {item.model ? (
          <div className="modelBadge" data-lane={item.lane ?? ""} title={`handled by ${item.model}${item.provider ? ` (${item.provider})` : ""}${item.lane ? ` · ${item.lane} lane` : ""}`}>
            <i className="glyph" data-glyph="task" /> {item.model}
            {item.provider ? <em className="providerTag">{item.provider}</em> : null}
            {item.lane ? <em>{item.lane}</em> : null}
          </div>
        ) : null}
        {item.thinking ? <ThinkingView text={item.thinking} /> : null}
        {item.text ? <RichContent text={item.text} /> : null}
      </div>
    );
  }
  if (item.kind === "diff") return <DiffCard item={item} />;
  if (item.kind === "subagent") {
    return (
      <div className="subagent" data-status={item.status}>
        <i className="lane" />
        <div className="subagentBody">
          <strong>
            {item.name}
            <em>{item.status === "running" ? "deployed" : item.status}</em>
          </strong>
          <span>{item.description}</span>
          {item.summary ? <p>{item.summary}</p> : null}
        </div>
      </div>
    );
  }
  if (item.kind === "tools") return <ToolGroup item={item} technical={toolDisplay === "technical"} />;
  if (item.kind === "usage") {
    return (
      <div className="usage" data-status={item.status}>
        {item.status !== "completed" ? `${item.status} · ` : ""}
        {fmtMs(item.durationMs)} · {item.modelCalls} call{item.modelCalls === 1 ? "" : "s"} · ↑{fmtTokens(item.input)} ↓{fmtTokens(item.output)}
        {item.cacheRead > 0 ? ` · ${Math.round((item.cacheRead / Math.max(1, item.input)) * 100)}% cached` : ""}
        {item.model ? <span className="usageModelTag">{item.model}{item.provider ? ` (${item.provider})` : ""}{item.lane ? ` · ${item.lane}` : ""}</span> : null}
      </div>
    );
  }
  if (item.kind === "permission" && item.toolName === "CodingBackend:offer") {
    // The delegation choice popup: Ares asks whether to hand the job to an
    // external coder or do it itself. Claude Code = allow, Ares = deny; Codex
    // is gated until the gateway speaks the OpenAI wire.
    return (
      <div className="cbOffer" data-decided={item.decided ? "1" : "0"}>
        <div className="cbOfferHead">
          <span className="cbOfferSpark" aria-hidden="true">🐉</span>
          <strong>How should I build this?</strong>
        </div>
        <span className="cbOfferReason">{item.reason || "Delegate this, or do it myself?"}</span>
        {item.decided ? (
          <em className="gateDecided">{item.decided === "deny" ? "Ares is handling it" : "delegated ⚡"}</em>
        ) : (
          <div className="cbOfferActions">
            <button className="cbOfferPick cbOfferClaude" onClick={() => onPermission(item.id, "allow_once")}>
              <span className="cbOfferGlyph">✳</span><span>Use Claude Code</span><small>on your Ares account</small>
            </button>
            <button className="cbOfferPick cbOfferCodex" disabled title="Coming soon — needs the gateway's OpenAI-compatible route">
              <span className="cbOfferGlyph">◆</span><span>Codex</span><small>soon</small>
            </button>
            <button className="cbOfferPick cbOfferSelf" onClick={() => onPermission(item.id, "deny")}>
              <span className="cbOfferGlyph">🐉</span><span>Ares does it</span><small>in-house</small>
            </button>
          </div>
        )}
      </div>
    );
  }
  if (item.kind === "permission") {
    return (
      <div className="gate" data-decided={item.decided ? "1" : "0"}>
        <span className="gateIcon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
          </svg>
        </span>
        <div className="gateBody">
          <strong>Approval needed</strong>
          <span className="gateReason">
            <b>{item.toolName}</b> · {item.reason || "wants to act"}
          </span>
        </div>
        {item.decided ? (
          <em className="gateDecided">{item.decided}</em>
        ) : (
          <div className="gateActions">
            <button className="gateAllow" onClick={() => onPermission(item.id, "allow_once")}>Allow</button>
            <button className="gateAlways" onClick={() => onPermission(item.id, "allow_always")}>Always</button>
            <button className="gateDeny" onClick={() => onPermission(item.id, "deny")}>Deny</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="notice" data-tone={item.tone}>
      {item.text}
    </div>
  );
});

function DiffCard({ item }: { item: Extract<Item, { kind: "diff" }> }) {
  const [open, setOpen] = useState(false);
  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const line of item.diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    return { add, del };
  }, [item.diff]);
  const names = item.files.map((f) => f.split(/[\\/]/).pop() ?? f);
  return (
    <div className="diffCard" data-open={open ? "1" : "0"}>
      <button className="diffHead" onClick={() => setOpen(!open)}>
        <i className="caret" data-open={open ? "1" : "0"} />
        <span className="diffFiles">{names.slice(0, 3).join(", ")}{names.length > 3 ? ` +${names.length - 3}` : ""}</span>
        <span className="diffStat add">+{stats.add}</span>
        <span className="diffStat del">−{stats.del}</span>
      </button>
      {open ? (
        <pre className="diffBody">
          {item.diff.split("\n").map((line, i) => (
            <span
              key={i}
              data-kind={
                line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")
                  ? "meta"
                  : line.startsWith("@@")
                    ? "hunk"
                    : line.startsWith("+")
                      ? "add"
                      : line.startsWith("-")
                        ? "del"
                        : "ctx"
              }
            >
              {line}
              {"\n"}
            </span>
          ))}
          {item.truncated ? <span data-kind="meta">… diff truncated</span> : null}
        </pre>
      ) : null}
    </div>
  );
}

function TodoPanel({ todos }: { todos: SessionVm["todos"] }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  return (
    <div className="todoPanel" data-open={open ? "1" : "0"}>
      <button className="todoHead" onClick={() => setOpen(!open)}>
        <span className="todoTitle">PLAN</span>
        <span className="todoProgress">
          <i style={{ width: `${todos.length ? Math.round((done / todos.length) * 100) : 0}%` }} />
        </span>
        <span className="todoCount">
          {done}/{todos.length}
        </span>
        {!open && current ? <span className="todoCurrent">{current.activeForm || current.content}</span> : null}
      </button>
      {open ? (
        <ul>
          {todos.map((t) => (
            <li key={t.id} data-status={t.status}>
              <i />
              <span>{t.status === "in_progress" ? t.activeForm || t.content : t.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The rich assistant body — prose with tables, plus live mermaid diagrams and
 *  charts rendered as real visuals (no HTML file needed). */
const RichContent = React.memo(function RichContent({ text }: { text: string }) {
  const segments = useMemo(() => splitRich(text), [text]);
  return (
    <div className="prose">
      {segments.map((seg, i) => {
        if (seg.kind === "prose") return <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />;
        if (seg.kind === "code")
          return (
            <pre key={i}>
              {seg.lang ? <span className="codeLang">{seg.lang}</span> : null}
              <code>{seg.content}</code>
            </pre>
          );
        if (seg.kind === "mermaid") return <MermaidDiagram key={i} code={seg.content} complete={seg.complete} />;
        return <ChartBlock key={i} spec={seg.content} complete={seg.complete} />;
      })}
    </div>
  );
});

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  // Just resolve the module — initialization happens per-render so diagrams
  // pick up the live war-band tokens (and re-tint when the theme changes).
  mermaidReady ??= import("mermaid").then((m) => m.default);
  return mermaidReady;
}

/** Read the active theme's tokens off the shell so the diagram matches the room. */
function mermaidThemeVars() {
  const el = document.querySelector(".ares") ?? document.documentElement;
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const accent = v("--accent", "#d6402e");
  return {
    background: "transparent",
    primaryColor: v("--panel-2", "#1e1213"),
    primaryBorderColor: accent,
    primaryTextColor: v("--text", "#f0e3da"),
    lineColor: accent,
    secondaryColor: v("--panel", "#160d0e"),
    tertiaryColor: v("--bg-raised", "#120c0d"),
    fontFamily: "Cascadia Code, ui-monospace, monospace",
    fontSize: "13px",
  };
}

let mermaidSeq = 0;
function MermaidDiagram({ code, complete }: { code: string; complete: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState(false);
  // Re-tint when the war-band changes — App dispatches "ares-theme" on switch.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const bump = () => setThemeTick((n) => n + 1);
    window.addEventListener("ares-theme", bump);
    return () => window.removeEventListener("ares-theme", bump);
  }, []);
  useEffect(() => {
    if (!complete || !code.trim()) return;
    let alive = true;
    void loadMermaid().then(async (mermaid) => {
      try {
        // Re-initialize with the live theme tokens right before rendering so the
        // diagram always matches the active war-band.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: mermaidThemeVars() });
        const { svg } = await mermaid.render(`aresmmd${++mermaidSeq}`, code.trim());
        if (alive && ref.current) {
          ref.current.innerHTML = svg;
          setErr(false);
        }
      } catch {
        if (alive) setErr(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [code, complete, themeTick]);
  if (!complete) return <div className="mermaidBlock building">◆ diagram building…</div>;
  if (err)
    return (
      <pre className="mermaidFallback">
        <span className="codeLang">mermaid</span>
        <code>{code}</code>
      </pre>
    );
  return <div className="mermaidBlock" ref={ref} />;
}

interface ChartDatum {
  label: string;
  value: number;
}
/** A ```chart block — either JSON [{label,value}] or "label: value" lines. */
function ChartBlock({ spec, complete }: { spec: string; complete: boolean }) {
  const data = useMemo<ChartDatum[]>(() => {
    if (!complete) return [];
    const trimmed = spec.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((d) => ({ label: String(d.label ?? d.name ?? ""), value: Number(d.value ?? d.y ?? 0) })).filter((d) => d.label);
    } catch {
      /* not JSON — try line format */
    }
    return trimmed
      .split("\n")
      .map((line) => {
        const m = line.match(/^\s*(.+?)\s*[:|]\s*(-?[\d.]+)/);
        return m ? { label: m[1].trim(), value: Number(m[2]) } : null;
      })
      .filter((d): d is ChartDatum => d !== null && Number.isFinite(d.value));
  }, [spec, complete]);
  if (!complete) return <div className="mermaidBlock building">◆ chart building…</div>;
  if (data.length === 0)
    return (
      <pre className="mermaidFallback">
        <span className="codeLang">chart</span>
        <code>{spec}</code>
      </pre>
    );
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  return (
    <div className="chartBlock">
      {data.map((d, i) => (
        <div key={i} className="chartRow">
          <span className="chartLabel">{d.label}</span>
          <span className="chartTrack">
            <span className="chartFill" style={{ width: `${(Math.abs(d.value) / max) * 100}%` }} />
          </span>
          <span className="chartVal">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button className="thinking" data-open={open ? "1" : "0"} onClick={() => setOpen(!open)}>
      <span className="thinkLabel">thinking</span>
      <span className="thinkText">{open ? text : compact(text, 140)}</span>
    </button>
  );
}

// A SINGLE tool card that MORPHS as the agent works: one icon slot crossfades
// through each tool (Read→Edit→Run…), the title rewrites to the live action, and
// when the batch finishes it collapses to "N tools attempted · …". The full
// per-step breakdown stays one click away. One reused card, not a stack.
function ToolGroup({ item, technical }: { item: Extract<Item, { kind: "tools" }>; technical?: boolean }) {
  const [open, setOpen] = useState(false);
  const newStyle = useNewStyle();
  const running = item.steps.some((s) => s.status === "running" || s.status === "drafting");
  const failed = item.steps.some((s) => s.status === "error");
  const wallElapsed = item.finishedAt === undefined ? 0 : Math.max(0, item.finishedAt - item.startedAt);
  const slowestStep = item.steps.reduce((n, s) => Math.max(n, s.durationMs ?? 0), 0);
  const elapsed = wallElapsed > 0 ? wallElapsed : slowestStep;
  const runningSteps = item.steps.filter((s) => s.status === "running" || s.status === "drafting");
  const doneCount = item.steps.filter((s) => s.status === "ok").length;
  const failedCount = item.steps.filter((s) => s.status === "error").length;
  const total = item.steps.length;
  // The step the card is currently "wearing": the first live one, else the last.
  const current = runningSteps[0] ?? item.steps[item.steps.length - 1];
  const activeGlyph = toolGlyph(current?.name ?? "");

  const title = running ? current?.label ?? "working…" : `${total} tool${total === 1 ? "" : "s"} attempted`;
  const subline = running
    ? `${doneCount}/${total} done${runningSteps.length > 1 ? ` · ${runningSteps.length} running` : ""}`
    : `${summarizeSteps(item.steps)}${failed ? ` · ${failedCount} failed` : ""} · ${fmtMs(elapsed)}`;

  // New style: a finished card COLLAPSES to a compact ✓ line (height-spring via
  // SpringHeight); clicking it re-expands the full breakdown. Legacy keeps the
  // classic always-full card — `compactDone` is impossible there.
  const compactDone = newStyle && !running && !open;

  const inner = compactDone ? (
    <button className="toolDoneLine" data-failed={failed ? "1" : "0"} onClick={() => setOpen(true)} title="show the full tool breakdown">
      <i className="doneMark" aria-hidden="true">{failed ? "✕" : "✓"}</i>
      <span className="doneSummary">
        {total} tool{total === 1 ? "" : "s"} · {summarizeSteps(item.steps)}
        {failed ? ` · ${failedCount} failed` : ""}
      </span>
      <em className="doneTime">{fmtMs(elapsed)}</em>
    </button>
  ) : (
    <>
      <button className="toolCardHead" onClick={() => setOpen(!open)}>
        <span className="toolCardIcon">
          {/* keyed so the glyph re-animates (morphs) each time the active tool changes */}
          <i className="glyph morphGlyph" key={`${activeGlyph}-${running ? current?.id : "done"}`} data-glyph={activeGlyph} data-status={running ? current?.status : failed ? "error" : "ok"} />
        </span>
        <span className="toolCardBody">
          <span className="toolCardTitle" key={title}>{title}</span>
          <span className="toolCardSub">{subline}</span>
        </span>
        <span className="toolCardTrail">
          {item.steps.slice(-14).map((s) => <i key={s.id} className="glyph mini" data-glyph={toolGlyph(s.name)} data-status={s.status} />)}
        </span>
        <i className="caret" data-open={open ? "1" : "0"} />
      </button>
      {running && current?.liveTail && !open ? (
        <pre className="stepLiveTail cardTail">{current.liveTail.split("\n").slice(-10).join("\n")}</pre>
      ) : null}
      {open ? (
        <div className="toolBody">
          {item.steps.map((s) => (
            <ToolStepRow key={s.id} step={s} technical={technical} />
          ))}
        </div>
      ) : null}
    </>
  );

  const state = failed ? "error" : running ? "running" : "ok";
  if (newStyle) {
    return (
      <SpringHeight className="toolCard" attrs={{ "data-state": state, "data-open": open ? "1" : "0", "data-compact": compactDone ? "1" : "0" }}>
        {inner}
      </SpringHeight>
    );
  }
  return (
    <div className="toolCard" data-state={state} data-open={open ? "1" : "0"}>
      {inner}
    </div>
  );
}

/** Tiny glyph class per tool family — rendered as CSS-drawn icons. Derived from
 *  toolKind so the icon, the verb, and the roll-up summary never disagree. */
function toolGlyph(name: string): string {
  switch (toolKind(name)) {
    case "read": return "file";
    case "search": return "search";
    case "create": return "create";
    case "edit": return "edit";
    case "shell": return "shell";
    case "web": return "web";
    case "task": return "task";
    default: return "dot";
  }
}

function ToolStepRow({ step, technical }: { step: ToolStep; technical?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="toolStep" data-status={step.status}>
      <button onClick={() => setOpen(!open)}>
        <i className="glyph" data-glyph={toolGlyph(step.name)} />
        <span className="stepLabel">{step.label}</span>
        <span className="stepMeta">{step.status === "drafting" ? "✎…" : step.status === "running" ? "…" : step.durationMs !== undefined ? fmtMs(step.durationMs) : ""}</span>
      </button>
      {step.status === "running" && step.liveTail ? (
        <pre className="stepLiveTail">{step.liveTail.split("\n").slice(-12).join("\n")}</pre>
      ) : null}
      {open ? (
        <>
          {technical && step.inputJson ? (
            <pre className="stepIo">
              <b>input</b>
              {"\n"}
              {step.inputJson}
            </pre>
          ) : null}
          {step.detail ? (
            <pre className="stepIo">
              {technical ? <b>output{"\n"}</b> : null}
              {step.detail}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ─── Boot + Settings ───────────────────────────────────────────────────────

/** The backdrop — a war-god's command table. Layered, parallaxed, alive:
 *  a slow astrolabe of concentric rings + tick marks, the great helm at the
 *  edge of vision, crossed spears, and a drifting depth field. Pure SVG/CSS,
 *  GPU-cheap, sits behind everything at low opacity. */
function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <svg className="astrolabe" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="agrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#d6402e" stopOpacity="0.0" />
            <stop offset="72%" stopColor="#d6402e" stopOpacity="0.0" />
            <stop offset="100%" stopColor="#d6402e" stopOpacity="0.12" />
          </radialGradient>
        </defs>
        <g className="ringSlow" stroke="#d6402e" fill="none">
          <circle cx="500" cy="500" r="470" strokeOpacity="0.06" strokeWidth="1" />
          <circle cx="500" cy="500" r="470" stroke="url(#agrad)" strokeWidth="40" />
          {Array.from({ length: 72 }).map((_, i) => {
            const a = (i / 72) * Math.PI * 2;
            const long = i % 6 === 0;
            const r1 = long ? 446 : 458;
            return (
              <line
                key={i}
                x1={500 + Math.cos(a) * r1}
                y1={500 + Math.sin(a) * r1}
                x2={500 + Math.cos(a) * 470}
                y2={500 + Math.sin(a) * 470}
                strokeOpacity={long ? 0.16 : 0.08}
                strokeWidth={long ? 1.4 : 0.8}
              />
            );
          })}
        </g>
        <g className="ringMid" stroke="#d6402e" fill="none" strokeOpacity="0.09">
          <circle cx="500" cy="500" r="360" strokeWidth="1" strokeDasharray="3 9" />
          <circle cx="500" cy="500" r="300" strokeWidth="1" />
        </g>
        <g className="ringFast" stroke="#ff6a44" fill="none" strokeOpacity="0.14">
          <circle cx="500" cy="500" r="230" strokeWidth="1.2" strokeDasharray="60 30 12 30" />
        </g>
      </svg>
      <div className="helm" />
      <div className="depthField" />
    </div>
  );
}

const BOOT_LOG = [
  "MOUNTING THE GARRISON",
  "BINDING TOOL ARSENAL",
  "RAISING THE FORGE",
  "OPENING THE GATES",
];

function Boot() {
  const [logIdx, setLogIdx] = useState(0);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setLogIdx((i) => Math.min(i + 1, BOOT_LOG.length - 1)), 320);
    // Forge-bloom exit just before the parent unmounts — the splash blooms hot
    // and dissolves into the live shell instead of vanishing instantly.
    const ex = window.setTimeout(() => setExiting(true), 1820);
    return () => { window.clearInterval(t); window.clearTimeout(ex); };
  }, []);
  return (
    <div className="boot" data-exit={exiting ? "1" : "0"}>
      <div className="bootHero" aria-hidden="true" />
      <div className="bootVignette" aria-hidden="true" />
      <div className="bootEmbers" aria-hidden="true" />
      <div className="bootCore">
        <div className="bootEmblem" aria-hidden="true">
          <span className="bootRing bootRing1" />
          <span className="bootRing bootRing2" />
          <span className="bootSigil" />
        </div>
        <div className="bootWord">ARES</div>
        <div className="bootSub">THE BATTLE-TESTED AGENT</div>
        <div className="bootBar"><i style={{ width: `${((logIdx + 1) / BOOT_LOG.length) * 100}%` }} /></div>
        <div className="bootStatus" key={logIdx}>{BOOT_LOG[logIdx]}</div>
      </div>
    </div>
  );
}

// Ares (the owner gateway) leads; mock is dev-only and hidden from users.
const PROVIDERS = ["ares", "ollama", "openai", "anthropic", "deepseek", "openrouter", "custom", "moa"];

// ─── Custom (OpenAI-compatible) provider: bring-your-own URL + key + discovery ──
// Point Ares at ANY OpenAI-compatible endpoint and pull its full model list from
// {base}/models. Self-contained: persists base URL + discovered models in
// localStorage (so the model picker can offer them) and ships key+url+model to the
// daemon via the provider_key command.
const CUSTOM_BASE_LS = "ares.custom.baseUrl";
const CUSTOM_MODELS_LS = "ares.custom.models";
const CUSTOM_MODEL_LS = "ares.custom.model";

function readCustomModels(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CUSTOM_MODELS_LS) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Known OpenAI-compatible providers — click one and the base URL fills itself
// so nobody has to hunt for it. keyUrl points at where to mint a key.
interface ProviderPreset {
  id: string;
  label: string;
  base: string;
  keyUrl?: string;
  keyHint?: string;
  sample?: string;
  keyless?: boolean;
}
const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "google", label: "Google AI Studio", base: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/app/apikey", keyHint: "AIza… key — set it to unrestricted", sample: "gemini-2.5-flash" },
  { id: "nvidia", label: "NVIDIA NIM", base: "https://integrate.api.nvidia.com/v1", keyUrl: "https://build.nvidia.com", keyHint: "nvapi-… key", sample: "meta/llama-3.1-70b-instruct" },
  { id: "groq", label: "Groq", base: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", keyHint: "gsk_… key", sample: "llama-3.3-70b-versatile" },
  { id: "xai", label: "xAI (Grok)", base: "https://api.x.ai/v1", keyUrl: "https://console.x.ai", keyHint: "xai-… key", sample: "grok-4" },
  { id: "together", label: "Together", base: "https://api.together.xyz/v1", keyUrl: "https://api.together.ai/settings/api-keys", sample: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "fireworks", label: "Fireworks", base: "https://api.fireworks.ai/inference/v1", keyUrl: "https://fireworks.ai/account/api-keys", sample: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  { id: "mistral", label: "Mistral", base: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys", sample: "mistral-large-latest" },
  { id: "deepinfra", label: "DeepInfra", base: "https://api.deepinfra.com/v1/openai", keyUrl: "https://deepinfra.com/dash/api_keys", sample: "meta-llama/Llama-3.3-70B-Instruct" },
  { id: "cerebras", label: "Cerebras", base: "https://api.cerebras.ai/v1", keyUrl: "https://cloud.cerebras.ai", sample: "llama-3.3-70b" },
  { id: "perplexity", label: "Perplexity", base: "https://api.perplexity.ai", keyUrl: "https://www.perplexity.ai/settings/api", sample: "sonar-pro" },
  { id: "openai", label: "OpenAI", base: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-… key", sample: "gpt-5.5" },
  { id: "lmstudio", label: "LM Studio (local)", base: "http://localhost:1234/v1", keyless: true, keyHint: "no key needed", sample: "" },
  { id: "vllm", label: "vLLM (local)", base: "http://localhost:8000/v1", keyless: true, keyHint: "no key needed", sample: "" },
];

function CustomProviderBlock({
  onDaemonCommand,
  native,
}: {
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
  native: boolean;
}) {
  const [base, setBase] = useState<string>(() => {
    try { return window.localStorage.getItem(CUSTOM_BASE_LS) ?? ""; } catch { return ""; }
  });
  const [key, setKey] = useState<string>("");
  const [models, setModels] = useState<string[]>(() => readCustomModels());
  const [model, setModel] = useState<string>(() => {
    try { return window.localStorage.getItem(CUSTOM_MODEL_LS) ?? ""; } catch { return ""; }
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [presetId, setPresetId] = useState<string>("");
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);

  const applyModels = useCallback((ids: string[]) => {
    setModels(ids);
    setModel((cur) => (!cur || !ids.includes(cur) ? ids[0] : cur));
    try { window.localStorage.setItem(CUSTOM_MODELS_LS, JSON.stringify(ids)); } catch { /* ignore */ }
    setOk(true);
    setMsg(`Found ${ids.length} model${ids.length === 1 ? "" : "s"}.`);
  }, []);

  const discover = useCallback(async () => {
    const root = base.trim().replace(/\/+$/, "");
    if (!root) { setOk(false); setMsg("Pick a provider above, or enter a base URL — e.g. https://api.together.xyz/v1"); return; }
    setBusy(true); setOk(null); setMsg("Discovering models…");

    // Preferred path: ask the daemon to fetch server-side (Node, no CORS) so
    // hosts that block browser requests (NVIDIA, Google, most) still work.
    if (native) {
      const done = await new Promise<boolean>((resolve) => {
        const onResult = (ev: Event) => {
          const d = (ev as CustomEvent<{ ok?: boolean; models?: string[]; error?: string }>).detail;
          window.removeEventListener("ares:custom-models", onResult);
          window.clearTimeout(timer);
          if (d?.ok && Array.isArray(d.models) && d.models.length) {
            applyModels(d.models);
          } else {
            setOk(false);
            setMsg(d?.error ? String(d.error) : "no models returned. You can still type a model id by hand below.");
          }
          resolve(true);
        };
        const timer = window.setTimeout(() => {
          window.removeEventListener("ares:custom-models", onResult);
          resolve(false); // daemon didn't answer — fall through to the browser attempt
        }, 12000);
        window.addEventListener("ares:custom-models", onResult);
        onDaemonCommand({ type: "discover_custom_models", base: root, key: key.trim() });
      });
      if (done) { setBusy(false); return; }
    }

    // Fallback: direct browser fetch (works for CORS-friendly / local endpoints).
    try {
      const res = await fetch(`${root}/models`, {
        headers: key.trim() ? { Authorization: `Bearer ${key.trim()}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown[]; models?: unknown[] };
      const list = (body.data ?? body.models ?? []) as Array<string | { id?: string }>;
      const ids = list
        .map((m) => (typeof m === "string" ? m : m?.id))
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .sort((a, b) => a.localeCompare(b));
      if (!ids.length) throw new Error("the endpoint returned no models");
      applyModels(ids);
    } catch (err) {
      setOk(false);
      setMsg(
        `Couldn't reach ${root}/models — ${err instanceof Error ? err.message : String(err)}. ` +
        `Make sure the key is valid and unrestricted, or just type a model id by hand below.`,
      );
    } finally {
      setBusy(false);
    }
  }, [base, key, native, onDaemonCommand, applyModels]);

  const choosePreset = useCallback((p: ProviderPreset) => {
    setPresetId(p.id);
    setBase(p.base);
    setModels([]);
    setModel(p.sample ?? "");
    setOk(null);
    setMsg(p.keyless ? "No key needed — click Discover (make sure the local server is running)." : `Paste your ${p.label} key, then Discover.`);
  }, []);

  const save = useCallback(() => {
    const root = base.trim().replace(/\/+$/, "");
    const chosen = model.trim();
    try {
      window.localStorage.setItem(CUSTOM_BASE_LS, root);
      window.localStorage.setItem(CUSTOM_MODEL_LS, chosen);
    } catch { /* ignore */ }
    onDaemonCommand({ type: "provider_key", provider: "custom", key: key.trim(), baseUrl: root, model: chosen });
    setOk(true);
    setMsg("Saved. Pick “custom” as your provider to use it.");
  }, [base, key, model, onDaemonCommand]);

  return (
    <div className="customProv">
      <div className="keyGroupLabel">Custom provider · OpenAI-compatible</div>
      <p className="keyHint" style={{ margin: "0 0 8px" }}>
        Pick a provider below and the base URL fills itself — just paste your key and Discover. Or point Ares at
        any OpenAI-compatible endpoint by hand. Discovery runs through Ares (not the browser), so hosts that block
        browser requests still work.
      </p>
      <div className="presetGallery">
        {PROVIDER_PRESETS.map((p) => (
          <button
            key={p.id}
            className="presetChip"
            data-on={presetId === p.id ? "1" : "0"}
            onClick={() => choosePreset(p)}
            title={p.base}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset ? (
        <p className="keyHint presetHint">
          {preset.keyHint ? <span>{preset.keyHint}</span> : null}
          {preset.keyUrl ? (
            <>
              {preset.keyHint ? " · " : null}
              <a href="#" onClick={(e) => { e.preventDefault(); if (native) void invoke("ares_open_url", { url: preset.keyUrl }).catch(() => null); }}>
                get a key ↗
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <input
        className="keyInput"
        placeholder="Base URL — e.g. https://api.together.xyz/v1"
        value={base}
        onChange={(e) => { setBase(e.target.value); setPresetId(""); }}
      />
      <input
        className="keyInput"
        type="password"
        placeholder="API key (leave blank for keyless local endpoints)"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <div className="customProvRow">
        <button className="provChip" disabled={busy || !base.trim()} onClick={() => void discover()}>
          {busy ? "Discovering…" : "Discover models"}
        </button>
        {models.length ? (
          <select className="customProvModel" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input
            className="keyInput customProvModelText"
            placeholder="…or type a model id"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
        <button className="primary" disabled={!base.trim() || !model.trim()} onClick={save}>Save</button>
      </div>
      {msg ? <p className="keyHint" data-ok={ok === null ? "" : ok ? "1" : "0"}>{msg}</p> : null}
    </div>
  );
}
/** Providers that take a pasted API key (the rest use OAuth / local daemon / nothing). */
const KEYED_PROVIDERS: Array<{ id: string; label: string; placeholder: string }> = [
  { id: "anthropic", label: "Anthropic API key", placeholder: "sk-ant-… (stored by the daemon)" },
  { id: "deepseek", label: "DeepSeek API key", placeholder: "sk-… official api.deepseek.com access" },
  { id: "openrouter", label: "OpenRouter API key", placeholder: "sk-or-… (stored by the daemon)" },
  { id: "ollama", label: "Ollama Cloud API key", placeholder: "cloud catalog; auth for OLLAMA_HOST=https://ollama.com" },
];

// A small brand glyph per model so the picker reads like a gallery, not a
// wall of ids. Keyed off the catalog group first, then the id prefix that
// OpenRouter-style ids carry ("openai/…", "anthropic/…").
function modelGlyph(m: { id: string; group?: string }): string {
  const g = (m.group ?? "").toLowerCase();
  if (g.includes("ares")) return "⚔️";
  if (g.includes("anthropic")) return "🔶";
  if (g.includes("openai")) return "🟢";
  if (g.includes("deepseek")) return "🐋";
  if (g.includes("ollama")) return "🦙";
  if (g.includes("openrouter")) return "🧭";
  if (g.includes("custom")) return "🔧";
  if (g.includes("mixture") || g.includes("moa")) return "🜲";
  if (g.includes("mock")) return "🎭";
  const prefix = m.id.split("/")[0]?.toLowerCase() ?? "";
  const byPrefix: Record<string, string> = {
    openai: "🟢", anthropic: "🔶", google: "🔵", "meta-llama": "🦙", meta: "🦙",
    mistralai: "🌫️", deepseek: "🐋", qwen: "🟣", "x-ai": "✖️", cohere: "🔗",
  };
  return byPrefix[prefix] ?? "🔥";
}

function ModelPicker({
  provider,
  value,
  onPick,
  native,
  searchOnly,
  compact,
}: {
  provider: string;
  value: string;
  onPick: (id: string) => void;
  native: boolean;
  /** Hide the free-text id input — rows are the only way to pick (hot-swap popover). */
  searchOnly?: boolean;
  /** Dense variant for routing lanes — shows the selected model + a compact list. */
  compact?: boolean;
}) {
  const { models, loading, error } = useModelCatalog(provider, native);
  const [open, setOpen] = useState(Boolean(searchOnly || compact));
  const [query, setQuery] = useState("");
  const [capability, setCapability] = useState<"all" | "tools" | "reasoning" | "vision" | "free">("all");
  // The model DETAIL page — click a card's ⓘ to open a big, readable view.
  const [detail, setDetail] = useState<ModelOption | null>(null);
  const q = query.trim().toLowerCase();
  const byCapability = capability === "all" ? models : models.filter((model) => model.capabilities?.includes(capability));
  const filtered = q
    ? byCapability.filter((m) =>
        [m.id, m.label ?? "", m.hint ?? "", ...(m.capabilities ?? [])].join(" ").toLowerCase().includes(q),
      )
    : byCapability;
  const groups = [...new Set(filtered.map((m) => m.group))];
  const capabilityCount = (name: Exclude<typeof capability, "all">) => models.filter((m) => m.capabilities?.includes(name)).length;
  const choose = (id: string) => {
    onPick(id);
    if (!searchOnly && !compact) setOpen(false);
  };
  // Show the friendly name for the current pick when the catalog knows one
  // (e.g. "Model Ares (in house)" instead of a raw virtual id).
  const valueLabel = models.find((m) => m.id === value)?.label ?? value;

  return (
    <div className={compact ? "modelPicker compact" : "modelPicker"}>
      {compact && value ? <div className="lanePicked" title={value}>{value}</div> : null}
      {!searchOnly && !compact ? (
        <button className="modelCurrent" data-open={open ? "1" : "0"} onClick={() => setOpen((current) => !current)}>
          <span>
            <strong>{valueLabel || "Choose a model"}</strong>
            <em>{loading ? "Loading catalog..." : `${models.length} available models`}</em>
          </span>
          <i>{open ? "Close" : "Change"}</i>
        </button>
      ) : null}
      {open && !searchOnly && !compact ? (
        <input value={value} onChange={(e) => onPick(e.target.value)} spellCheck={false} placeholder="model id" />
      ) : null}
      {open ? <div className="modelSearchRow">
        <input
          className="modelSearch"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={loading ? "loading models…" : `search ${models.length} models`}
          spellCheck={false}
        />
        <span>{filtered.length}</span>
      </div> : null}
      {open ? <div className="modelFilters" aria-label="model capability filters">
        <button data-on={capability === "all" ? "1" : "0"} onClick={() => setCapability("all")}>all</button>
        {(["tools", "reasoning", "vision", "free"] as const).map((name) => {
          const count = capabilityCount(name);
          return (
            <button key={name} data-on={capability === name ? "1" : "0"} disabled={count === 0} onClick={() => setCapability(name)}>
              {name} <em>{count}</em>
            </button>
          );
        })}
      </div> : null}
      {error ? <div className="modelError">{error}</div> : null}
      {open ? <div className="modelList">
        {groups.map((g) => (
          <React.Fragment key={g}>
            <div className="modelGroup">
              <span>{g}</span>
              <em>{filtered.filter((m) => m.group === g).length}</em>
            </div>
            {filtered
              .filter((m) => m.group === g)
              .map((m, i) => (
                <button key={m.id} className="modelRow" data-on={m.id === value ? "1" : "0"} style={{ ["--i" as string]: i }} onClick={() => choose(m.id)}>
                  <span className="modelGlyph" aria-hidden="true">{modelGlyph(m)}</span>
                  <span className="modelIdentity">
                    {/* Friendly name leads (white-labeled for gateway models); raw id demotes to a tag. */}
                    <span className="modelId">{m.label ?? m.id}</span>
                    <span className="modelTags">
                      {m.label && m.label !== m.id ? <span className="modelLabel">{m.id}</span> : null}
                      {m.capabilities?.slice(0, 3).map((cap) => <i key={cap}>{cap}</i>)}
                    </span>
                    {/* The discovery blurb — OpenRouter's per-model description, clamped
                        to two lines (full text on hover). This is what turns the list
                        into a "browse the good stuff" experience. */}
                    {m.description ? <span className="modelDesc" title={m.description}>{m.description}</span> : null}
                  </span>
                  {m.hint ? <span className="modelHint">{m.hint}</span> : null}
                  {!compact ? (
                    <span
                      className="modelInfo"
                      role="button"
                      tabIndex={0}
                      title="Details"
                      aria-label={`Details for ${m.label ?? m.id}`}
                      onClick={(e) => { e.stopPropagation(); setDetail(m); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setDetail(m); } }}
                    >ⓘ</span>
                  ) : null}
                  <span className="modelTick" aria-hidden="true" />
                </button>
              ))}
          </React.Fragment>
        ))}
        {!loading && filtered.length === 0 ? <div className="modelHintEmpty">no models match</div> : null}
      </div> : null}
      {detail ? (
        <ModelDetail
          model={detail}
          selected={detail.id === value}
          onUse={(id) => { choose(id); setDetail(null); }}
          onBack={() => setDetail(null)}
        />
      ) : null}
    </div>
  );
}

// The big, readable model page — opened from a card's ⓘ. Shows the full
// description, context window, per-Mtok pricing, and every capability, with a
// primary "Use this model" action. Overlays the picker so all mount sites work.
function ModelDetail({ model, selected, onUse, onBack }: { model: ModelOption; selected: boolean; onUse: (id: string) => void; onBack: () => void }) {
  const price = model.pricing;
  const ctxK = model.contextLength ? Math.round(model.contextLength / 1000) : undefined;
  const isFree = model.capabilities?.includes("free");
  return (
    <div className="modelDetail" role="dialog" aria-label={`${model.label ?? model.id} details`}>
      <button className="mdBack" onClick={onBack}>← Back to models</button>
      <div className="mdHead">
        <span className="mdGlyph" aria-hidden="true">{modelGlyph(model)}</span>
        <div className="mdTitle">
          <strong>{model.label ?? model.id}</strong>
          <span className="mdSub">{model.group}{model.label && model.label !== model.id ? ` · ${model.id}` : ""}</span>
        </div>
      </div>
      <div className="mdStats">
        {ctxK ? <div className="mdStat"><b>{ctxK >= 1000 ? `${(ctxK / 1000).toFixed(ctxK % 1000 ? 1 : 0)}M` : `${ctxK}k`}</b><span>context</span></div> : null}
        {isFree ? <div className="mdStat mdFree"><b>FREE</b><span>no token cost</span></div>
          : price?.input !== undefined ? <div className="mdStat"><b>${price.input.toFixed(2)}</b><span>/M input</span></div> : null}
        {!isFree && price?.output !== undefined ? <div className="mdStat"><b>${price.output.toFixed(2)}</b><span>/M output</span></div> : null}
      </div>
      {model.capabilities && model.capabilities.length > 0 ? (
        <div className="mdCaps">
          {model.capabilities.map((c) => <span key={c} className="mdCap" data-cap={c}>{c}</span>)}
        </div>
      ) : null}
      {model.description ? <p className="mdDesc">{model.description}</p>
        : model.hint ? <p className="mdDesc mdDescThin">{model.hint}</p>
        : <p className="mdDesc mdDescThin">No description available for this model.</p>}
      <button className="mdUse" data-on={selected ? "1" : "0"} onClick={() => onUse(model.id)}>
        {selected ? "✓ Current model" : "Use this model"}
      </button>
    </div>
  );
}

type SettingsTab = "account" | "model" | "appearance" | "skills" | "usage" | "routing" | "keys" | "services" | "consciousness" | "channels" | "permissions" | "advanced" | "updates" | "about";

interface SkillInfo {
  name: string;
  description: string;
  status: string;
  category: string;
  enabled: boolean;
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
  models: Array<{ model: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number }>;
}

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; glyph: string }> = [
  { id: "model", label: "Model", glyph: "task" },
  { id: "account", label: "Ares Account", glyph: "dot" },
  { id: "routing", label: "Routing", glyph: "search" },
  { id: "appearance", label: "Appearance", glyph: "edit" },
  { id: "skills", label: "Skills & Tools", glyph: "file" },
  { id: "usage", label: "Usage", glyph: "web" },
  { id: "keys", label: "API Keys", glyph: "shell" },
  { id: "services", label: "Services", glyph: "web" },
  { id: "consciousness", label: "Consciousness", glyph: "dot" },
  { id: "channels", label: "Channels", glyph: "web" },
  { id: "permissions", label: "Permissions", glyph: "shell" },
  { id: "advanced", label: "Advanced", glyph: "dot" },
  { id: "updates", label: "What's New", glyph: "dot" },
  { id: "about", label: "About", glyph: "dot" },
];

/** Ares Account — connect to the owner's gateway (doingteam.com), then live
 *  credits / usage / models. Data arrives via gateway_account daemon frames;
 *  grants toast app-wide the moment the owner pushes them. */
function GatewayAccountPane({
  account,
  onDaemonCommand,
  onUseModel,
  activeModel,
}: {
  account: GatewayAccountVm | null;
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
  /** Clicking a granted model switches the live session to it. */
  onUseModel?: (id: string) => void;
  activeModel?: string | null;
}) {
  const [url, setUrl] = useState("https://www.doingteam.com");
  const [token, setToken] = useState("");
  useEffect(() => {
    onDaemonCommand({ type: "gateway_status" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const connected = account?.connected === true;
  return (
    <div className="settingsPane">
      <h3 className="paneTitle">Ares Account</h3>
      {!connected ? (
        <div className="gwConnect">
          {/* Preferred path when the gateway supports it: one-click browser
              sign-in, no token paste. Gated on oauthSupported so it stays hidden
              until doingteam's OAuth endpoints go live. */}
          {account?.oauthSupported ? (
            <>
              <p className="paneHint">
                Sign in with your <strong>doingteam.com</strong> account — models, credits, and usage sync live. No token to copy.
              </p>
              <button
                className="btn gwSignin"
                onClick={() => onDaemonCommand({ type: "gateway_signin", url: url.trim() })}
              >
                Sign in with doingteam
              </button>
              <details className="gwPasteFallback">
                <summary>Paste a token instead</summary>
                <input className="txt" placeholder="gateway url" value={url} onChange={(ev) => setUrl(ev.target.value)} />
                <input
                  className="txt"
                  placeholder="ares_… token (shown once on the site)"
                  type="password"
                  value={token}
                  onChange={(ev) => setToken(ev.target.value)}
                />
                <button
                  className="btn"
                  disabled={!token.trim()}
                  onClick={() => {
                    onDaemonCommand({ type: "gateway_connect", url: url.trim(), token: token.trim() });
                    setToken("");
                  }}
                >
                  Connect
                </button>
              </details>
            </>
          ) : (
            <>
              <p className="paneHint">
                Sign up at <strong>doingteam.com</strong>, then Account → <em>Connect Ares</em> gives you a token. Paste it
                here — credits, models, and usage sync live.
              </p>
              <input className="txt" placeholder="gateway url" value={url} onChange={(ev) => setUrl(ev.target.value)} />
              <input
                className="txt"
                placeholder="ares_… token (shown once on the site)"
                type="password"
                value={token}
                onChange={(ev) => setToken(ev.target.value)}
              />
              <button
                className="btn"
                disabled={!token.trim()}
                onClick={() => {
                  onDaemonCommand({ type: "gateway_connect", url: url.trim(), token: token.trim() });
                  setToken("");
                }}
              >
                Connect
              </button>
            </>
          )}
          {account?.reason ? <p className="paneHint gwBad">Not connected: {account.reason}</p> : null}
        </div>
      ) : (
        <div className="gwAccount">
          <div className="gwRow">
            <div className="gwAvatar">
              {account?.profile?.avatar_url ? (
                <img src={account.profile.avatar_url} alt="" />
              ) : (
                <span>{(account?.profile?.display_name ?? "A").slice(0, 1).toUpperCase()}</span>
              )}
            </div>
            <div>
              <strong>{account?.profile?.display_name ?? "warrior"}</strong>
              <span className="gwStatus" data-status={account?.profile?.status ?? ""}> {account?.profile?.status}</span>
            </div>
            <div className="gwBalance">${(account?.balance_usd ?? 0).toFixed(2)}</div>
          </div>
          <div className="gwUsage">
            today · {(account?.usage?.input_tokens ?? 0).toLocaleString()} in / {(account?.usage?.output_tokens ?? 0).toLocaleString()} out
            · ${(account?.usage?.cost_usd ?? 0).toFixed(4)}
          </div>
          <div className="gwModels">
            {(account?.models ?? []).map((m) => (
              <button
                key={m.id}
                className="gwModel gwModelBtn"
                data-active={activeModel === m.id ? "1" : "0"}
                title="use this model"
                onClick={() => onUseModel?.(m.id)}
              >
                <span>
                  {m.is_house ? <em className="gwHouse">ARES</em> : null} {m.display_name ?? m.id}
                </span>
                <span className="gwModelMeta">
                  {m.is_free ? <em className="gwFree">FREE</em> : null}
                  {typeof m.cap_remaining_microcents === "number" ? (
                    <em className="gwCap">${(m.cap_remaining_microcents / 1e6).toFixed(2)} left</em>
                  ) : null}
                  {activeModel === m.id ? <em className="gwActive">●</em> : null}
                </span>
              </button>
            ))}
            {(account?.models ?? []).length === 0 ? <p className="paneHint">No models assigned yet — the owner grants them.</p> : null}
          </div>
          <button className="btn subtle" onClick={() => onDaemonCommand({ type: "gateway_status" })}>
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}

function Settings({
  prefs,
  onApply,
  onClose,
  native,
  skills,
  usage,
  keyStatus,
  gatewayAccount,
  permissions,
  onPermissions,
  oauthProviders,
  consciousness,
  onDaemonCommand,
  onLivePref,
  onAnthropicSignIn,
  initialTab,
  channelStatus,
  channelRoster,
  channelToken,
  onChannelToken,
  channelAllowedChats,
  onChannelAllowedChats,
  channelBusy,
  onChannelBusy,
  onPushLog,
}: {
  prefs: Prefs;
  onApply: (p: Prefs, keys: Record<string, string>) => void;
  onClose: () => void;
  native: boolean;
  skills: SkillInfo[];
  usage: UsageStats | null;
  keyStatus: Record<string, boolean>;
  gatewayAccount: GatewayAccountVm | null;
  permissions: PermSettings;
  onPermissions: (next: PermSettings) => void;
  oauthProviders: OAuthProviderVm[];
  consciousness: ConsciousnessVm;
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
  onLivePref: (patch: Partial<Prefs>) => void;
  onAnthropicSignIn: () => void;
  initialTab?: SettingsTab;
  // Channel bridge state (Telegram, etc.)
  channelStatus: Array<{ channel: string; running: boolean; connected: boolean; configured: boolean; participantCount: number; lastError?: string }>;
  channelRoster: Record<string, Array<{ chatId: number; name: string; role: string; addedAt: string; lastSeenAt?: string }>>;
  channelToken: string;
  onChannelToken: (v: string) => void;
  channelAllowedChats: string;
  onChannelAllowedChats: (v: string) => void;
  channelBusy: boolean;
  onChannelBusy: (v: boolean) => void;
  onPushLog: (line: string) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "model");
  const [draft, setDraftPrefs] = useState<Prefs>(prefs);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const providerModels = useRef<Record<string, string>>({ [prefs.provider]: prefs.model });

  // pull live data when entering data-backed tabs
  useEffect(() => {
    if (!native) return;
    if (tab === "skills") onDaemonCommand({ type: "skills_list" });
    if (tab === "usage") onDaemonCommand({ type: "usage_stats", days: 30 });
    if (tab === "consciousness") onDaemonCommand({ type: "consciousness_status" });
    if (tab === "channels") onDaemonCommand({ type: "channel.status" });
  }, [tab, native, onDaemonCommand]);

  const setEngine = (patch: Partial<EngineConfig>) => setDraftPrefs({ ...draft, engine: { ...draft.engine, ...patch } });
  const setProvider = (provider: string) => {
    providerModels.current[draft.provider] = draft.model;
    setDraftPrefs({
      ...draft,
      provider,
      model: providerModels.current[provider] ?? defaultModelForProvider(provider),
    });
  };
  const setModel = (model: string) => {
    providerModels.current[draft.provider] = model;
    setDraftPrefs({ ...draft, model });
  };
  const closeSettings = () => {
    if (draft.theme !== prefs.theme) onLivePref({ theme: prefs.theme });
    onClose();
  };

  return (
    <div className="scrim center" onClick={closeSettings}>
      <div className="settingsShell" onClick={(e) => e.stopPropagation()}>
        <aside className="settingsNav">
          <div className="settingsBrand">
            <div className="settingsHeroMark" aria-hidden="true" />
            <strong>Settings</strong>
          </div>
          {SETTINGS_TABS.map((t) => (
            <button key={t.id} data-on={tab === t.id ? "1" : "0"} onClick={() => setTab(t.id)}>
              <i className="glyph" data-glyph={t.glyph} /> {t.label}
            </button>
          ))}
          <div className="settingsNavFoot">
            <button className="ghost" onClick={closeSettings}>
              Close
            </button>
          </div>
        </aside>

        <div className="settingsMain">
          {tab === "model" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Model</h3>
              <p className="paneHint">The main model for new sessions. Hot-swap the active chat from the composer.</p>
              <label className="fieldLabel">Provider</label>
              <div className="provGrid">
                {PROVIDERS.map((p) => (
                  <button key={p} className="provChip" data-on={draft.provider === p ? "1" : "0"} onClick={() => setProvider(p)}>
                    <i className="provDot" data-provider={p} />
                    <span>{p}</span>
                  </button>
                ))}
              </div>
              <label className="fieldLabel">Model</label>
              <ModelPicker provider={draft.provider} value={draft.model} onPick={setModel} native={native} />
              <label className="fieldLabel">Reasoning effort</label>
              <div className="segment">
                {REASONING_LEVELS.map((r) => (
                  <button key={r} data-on={draft.reasoning === r ? "1" : "0"} onClick={() => setDraftPrefs({ ...draft, reasoning: r })}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "routing" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Routing — the war table</h3>
              <p className="paneHint">Assign a model to each task lane. Unassigned lanes use the main model.</p>
              {ROUTE_LANES.map((lane) => {
                const entry = draft.routing[lane];
                const setLane = (e: { provider: string; model: string } | undefined) => {
                  const routing = { ...draft.routing };
                  if (e) routing[lane] = e;
                  else delete routing[lane];
                  setDraftPrefs({ ...draft, routing });
                };
                return (
                  <div key={lane} className="routeLane" data-on={entry ? "1" : "0"}>
                    <button className="laneToggle" onClick={() => setLane(entry ? undefined : { provider: draft.provider, model: draft.model })}>
                      <i />
                      <span>{lane}</span>
                      <em>{LANE_HINTS[lane]}</em>
                    </button>
                    {entry ? (
                      <div className="laneBody">
                        <div className="segment mini">
                          {PROVIDERS.filter((p) => p !== "mock").map((p) => (
                            <button
                              key={p}
                              data-on={entry.provider === p ? "1" : "0"}
                              onClick={() => setLane({ provider: p, model: defaultModelForProvider(p) })}
                            >
                              {p}
                            </button>
                          ))}
                        </div>
                        <ModelPicker provider={entry.provider} value={entry.model} onPick={(id) => setLane({ ...entry, model: id })} native={native} compact />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {tab === "appearance" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Appearance</h3>
              <label className="fieldLabel">Interface style</label>
              <div className="displayModes">
                <button
                  data-on={draft.uiStyle === "new" ? "1" : "0"}
                  onClick={() => {
                    setDraftPrefs({ ...draft, uiStyle: "new" });
                    onLivePref({ uiStyle: "new" }); // display-only — preview instantly
                  }}
                >
                  <strong>Forged</strong>
                  <span>Glass depth, spring motion, living gauges.</span>
                </button>
                <button
                  data-on={draft.uiStyle === "legacy" ? "1" : "0"}
                  onClick={() => {
                    setDraftPrefs({ ...draft, uiStyle: "legacy" });
                    onLivePref({ uiStyle: "legacy" });
                  }}
                >
                  <strong>Legacy</strong>
                  <span>The classic flat obsidian shell.</span>
                </button>
              </div>
              <label className="fieldLabel">Tool call display</label>
              <div className="displayModes">
                <button data-on={draft.toolDisplay === "product" ? "1" : "0"} onClick={() => setDraftPrefs({ ...draft, toolDisplay: "product" })}>
                  <strong>Product</strong>
                  <span>Concise, human-friendly tool activity.</span>
                </button>
                <button data-on={draft.toolDisplay === "technical" ? "1" : "0"} onClick={() => setDraftPrefs({ ...draft, toolDisplay: "technical" })}>
                  <strong>Technical</strong>
                  <span>Raw tool inputs and outputs, full detail.</span>
                </button>
              </div>
              <label className="fieldLabel">Accent theme</label>
              <div className="themeGrid">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className="themeCard"
                    data-on={draft.theme === t.id ? "1" : "0"}
                    onClick={() => {
                      setDraftPrefs({ ...draft, theme: t.id });
                      onLivePref({ theme: t.id }); // display-only — preview instantly
                    }}
                  >
                    <span className="themeSwatch" style={{ background: t.swatch }} />
                    <strong>{t.label}</strong>
                    <em>{t.hint}</em>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "skills" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Skills & Tools</h3>
              <p className="paneHint">Skills Ares has learned or you've installed, under ~/.ares/skills. Toggle to enable per session.</p>
              {skills.length === 0 ? (
                <div className="paneEmpty">No skills yet. Ares proposes skills from repeated workflows; approved ones land here.</div>
              ) : (
                <div className="skillList">
                  {skills.map((s) => (
                    <div key={s.name} className="skillRow">
                      <div className="skillInfo">
                        <strong>
                          {s.name}
                          <span className="skillCat">{s.category}</span>
                        </strong>
                        <span>{s.description}</span>
                      </div>
                      <button
                        className="toggle"
                        data-on={s.enabled ? "1" : "0"}
                        onClick={() => onDaemonCommand({ type: "skill_toggle", name: s.name, enabled: !s.enabled })}
                      >
                        <i />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {tab === "usage" ? <UsagePane usage={usage} onDaemonCommand={onDaemonCommand} native={native} /> : null}

          {tab === "account" ? (
            <GatewayAccountPane account={gatewayAccount} onDaemonCommand={onDaemonCommand} activeModel={draft.provider === "ares" ? draft.model : null} onUseModel={(id) => { onLivePref({ provider: "ares", model: id }); onDaemonCommand({ type: "model_switch", provider: "ares", model: id }); }} />
          ) : null}
          {tab === "keys" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">API Keys</h3>
              <p className="paneHint">Keys are encrypted by the daemon under ~/.ares and never enter this window's storage.</p>
              <div className="keyRegistry">
                <div className="keyGroupLabel">Sign in</div>
                <div className="keyRegRow signInRow">
                  <div className="keyRegName">
                    <i className="provDot" data-provider="anthropic" />
                    <strong>Claude (Pro / Max)</strong>
                  </div>
                  <button className="ghost signInBtn" onClick={onAnthropicSignIn}>
                    ◆ Sign in with browser
                  </button>
                </div>
                <p className="keyHint" style={{ margin: "0 0 6px" }}>Use your Claude subscription — no API key needed.</p>
                <div className="keyGroupLabel">API keys</div>
                {KEYED_PROVIDERS.map((kp) => (
                  <div key={kp.id} className="keyRegRow">
                    <div className="keyRegName">
                      <i className="provDot" data-provider={kp.id} />
                      <strong>{kp.label}</strong>
                      <span className="keyState" data-on={keyStatus[kp.id] ? "1" : "0"}>
                        {keyStatus[kp.id] ? "saved" : "not set"}
                      </span>
                    </div>
                    <input value={keys[kp.id] ?? ""} type="password" placeholder={kp.placeholder} onChange={(e) => setKeys({ ...keys, [kp.id]: e.target.value })} />
                    {keyStatus[kp.id] ? (
                      <button className="ghost keyClear" onClick={() => onDaemonCommand({ type: "provider_key", provider: kp.id, key: "" })}>
                        Clear
                      </button>
                    ) : null}
                  </div>
                ))}
                <CustomProviderBlock onDaemonCommand={onDaemonCommand} native={native} />
                <div className="keyGroupLabel">Tools</div>
                <div className="keyRegRow">
                  <div className="keyRegName">
                    <i className="provDot" data-provider="brave" />
                    <strong>Brave Search</strong>
                    <span className="keyState" data-on={keyStatus.brave ? "1" : "0"}>
                      {keyStatus.brave ? "saved" : "not set"}
                    </span>
                  </div>
                  <input value={keys.brave ?? ""} type="password" placeholder="BSA… — upgrades web + image search" onChange={(e) => setKeys({ ...keys, brave: e.target.value })} />
                  {keyStatus.brave ? (
                    <button className="ghost keyClear" onClick={() => onDaemonCommand({ type: "provider_key", provider: "brave", key: "" })}>
                      Clear
                    </button>
                  ) : null}
                </div>
              </div>
              <p className="keyHint">OpenAI uses ChatGPT OAuth. Local Ollama needs no key; the Ollama key enables direct ollama.com cloud discovery and inference.</p>
            </div>
          ) : null}

          {tab === "channels" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Channels</h3>
              <p className="paneHint">Configure and manage messaging channel bridges (Telegram, etc.). Start a bridge to let Ares chat through your bot.</p>

              {/* ── Telegram bridge ── */}
              <div className="engineRow" style={{ marginTop: 16 }}>
                <div className="engineInfo">
                  <strong>Telegram</strong>
                  <span>{(() => { const s = channelStatus.find(c => c.channel === "telegram"); return s?.running ? "🟢 Running" : s?.configured ? "🟡 Configured" : "⚪ Not configured"; })()}</span>
                </div>
                <div className="engineActions">
                  {channelStatus.find(c => c.channel === "telegram")?.running ? (
                    <button className="amAction" onClick={() => { onChannelBusy(true); onDaemonCommand({ type: "channel.stop", channel: "telegram" }); setTimeout(() => onChannelBusy(false), 2000); }} disabled={channelBusy}>Stop</button>
                  ) : (
                    <button className="amAction" onClick={() => { onChannelBusy(true); onDaemonCommand({ type: "channel.start", channel: "telegram" }); setTimeout(() => onChannelBusy(false), 2000); }} disabled={channelBusy}>Start</button>
                  )}
                </div>
              </div>

              {/* Bot token */}
              <label className="fieldLabel" style={{ marginTop: 12 }}>Bot Token</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="keyInput" type="password" value={channelToken}
                  onChange={(e) => onChannelToken(e.target.value)}
                  placeholder="123456:ABC-DEF..." style={{ flex: 1 }} />
                <button className="amAction"
                  onClick={() => {
                    if (!channelToken.trim()) return;
                    const chats = channelAllowedChats.split(",").map((s: string) => Number(s.trim())).filter((n: number) => !isNaN(n));
                    onDaemonCommand({ type: "channel.configure", channel: "telegram", config: { token: channelToken.trim(), allowedChats: chats } });
                    onPushLog("[channels] telegram configured");
                  }}>Save</button>
              </div>

              {/* Allowed chats */}
              <label className="fieldLabel" style={{ marginTop: 12 }}>Allowed Chat IDs</label>
              <input className="keyInput" value={channelAllowedChats}
                onChange={(e) => onChannelAllowedChats(e.target.value)}
                placeholder="123456789, 987654321 (comma-separated Telegram chat IDs)" />

              {/* Status */}
              {channelStatus.filter(c => c.channel === "telegram").map(c => (
                <div key={c.channel} className="engineRow" style={{ marginTop: 12 }}>
                  <div className="engineInfo">
                    <span>Participants: {c.participantCount}</span>
                    {c.lastError ? <span style={{ color: "var(--text-error)" }}>{c.lastError}</span> : null}
                  </div>
                </div>
              ))}

              {/* Roster */}
              {channelRoster["telegram"]?.length ? (
                <div style={{ marginTop: 12 }}>
                  <label className="fieldLabel">Roster</label>
                  <div className="status-table" style={{ marginTop: 4 }}>
                    <div className="data-row head"><span>Chat ID</span><span>Name</span><span>Role</span></div>
                    {channelRoster["telegram"].map(p => (
                      <div className="data-row" key={p.chatId}>
                        <code>{p.chatId}</code><span>{p.name}</span><span className="aza-badge aza-badge-muted">{p.role}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <p className="paneHint" style={{ marginTop: 16 }}>
                Create a bot with <b>@BotFather</b> on Telegram, paste the token above, then add your chat ID. Send <b>/start</b> to your bot — the bridge auto-discovers your chat. Start the bridge to go live.
              </p>
            </div>
          ) : null}

          {tab === "permissions" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Permissions</h3>
              <p className="paneHint">Decide what Ares does on its own vs. what it asks you first. Applies on the next turn.</p>
              <div className="engineRow">
                <div className="engineInfo">
                  <strong>Act freely (no prompts)</strong>
                  <span>Ares acts on everything without asking — files, commands, web, even sensitive actions. Off = guarded (sensitive asks).</span>
                </div>
                <button className="toggle" data-on={permissions.mode === "free" ? "1" : "0"}
                  onClick={() => onPermissions({ ...permissions, mode: permissions.mode === "free" ? "guarded" : "free" })}>
                  <i />
                </button>
              </div>
              {(["fileWrite", "shell", "network", "sensitive"] as const).map((cat) => {
                const meta = {
                  fileWrite: ["Auto-approve file writes", "Create/edit files without asking."],
                  shell: ["Auto-approve shell commands", "Run terminal commands without asking."],
                  network: ["Auto-approve web & network", "Fetch pages and call the web without asking."],
                  sensitive: ["Auto-approve sensitive actions", "Credentials, payments, email, destructive, computer control. Off by default — these ask."],
                }[cat];
                const on = permissions.mode === "free" ? true : permissions[cat];
                return (
                  <div className="engineRow" key={cat} data-dim={permissions.mode === "free" ? "1" : "0"}>
                    <div className="engineInfo">
                      <strong>{meta[0]}</strong>
                      <span>{meta[1]}</span>
                    </div>
                    <button className="toggle" data-on={on ? "1" : "0"} disabled={permissions.mode === "free"}
                      onClick={() => onPermissions({ ...permissions, [cat]: !permissions[cat] })}>
                      <i />
                    </button>
                  </div>
                );
              })}
              <div className="engineRow">
                <div className="engineInfo">
                  <strong>Fleets inherit my permissions</strong>
                  <span>Background agents (ULTRA fleets) act on what you've allowed. Off = fleets can only read, never act.</span>
                </div>
                <button className="toggle" data-on={permissions.fleetsInherit ? "1" : "0"}
                  onClick={() => onPermissions({ ...permissions, fleetsInherit: !permissions.fleetsInherit })}>
                  <i />
                </button>
              </div>
            </div>
          ) : null}

          {tab === "advanced" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Advanced</h3>
              <p className="paneHint">Run-tuning knobs. Most apply on the next turn; the toggle and intervals apply live.</p>
              <EngineRow label="Max agent turns" hint="Hard ceiling on tool-calling rounds before Ares stops." value={draft.engine.maxTurns ?? 80} onChange={(v) => setEngine({ maxTurns: v })} />
              <EngineRow label="Gather-stall rounds" hint="Consecutive gather-only rounds before the deliver-now nudge." value={draft.engine.gatherStallRounds ?? 10} onChange={(v) => setEngine({ gatherStallRounds: v })} />
              <EngineRow label="Tool result char cap" hint="Max chars of a tool result fed back to the model." value={draft.engine.toolResultChars ?? 24000} onChange={(v) => setEngine({ toolResultChars: v })} />
              <EngineRow label="Subagent turn limit" hint="Max turns a delegated subagent may take." value={draft.engine.subagentTurnLimit ?? 50} onChange={(v) => setEngine({ subagentTurnLimit: v })} />
              <div className="engineRow">
                <div className="engineInfo">
                  <strong>Operator auto-tick</strong>
                  <span>Advance durable missions while the daemon idles.</span>
                </div>
                <button className="toggle" data-on={draft.engine.operatorAutotick !== false ? "1" : "0"} onClick={() => setEngine({ operatorAutotick: !(draft.engine.operatorAutotick !== false) })}>
                  <i />
                </button>
              </div>
              <EngineRow label="Auto-tick interval (min)" hint="Minutes between idle mission ticks." value={draft.engine.operatorTickMinutes ?? 30} onChange={(v) => setEngine({ operatorTickMinutes: v })} />
            </div>
          ) : null}

          {tab === "services" ? (
            <ServicesPane native={native} providers={oauthProviders} onDaemonCommand={onDaemonCommand} />
          ) : null}

          {tab === "consciousness" ? (
            <ConsciousnessPane native={native} state={consciousness} onDaemonCommand={onDaemonCommand} />
          ) : null}

          {tab === "updates" ? (
            <div className="settingsPane updatesPane">
              <div className="updatesHead">
                <div>
                  <h3 className="updatesTitle">What's New</h3>
                  <p className="paneHint">Every release, kept here so you can read it any time — not just when the popup flashes by.</p>
                </div>
                <button
                  className="updatesReplay"
                  onClick={() => window.dispatchEvent(new CustomEvent("ares:show-whatsnew"))}
                >
                  Show release popup
                </button>
              </div>
              <div className="updatesList">
                {CHANGELOG.map((e) => (
                  <div key={e.version} className="updatesEntry">
                    <div className="updatesEntryHead">
                      <span className="updatesVer">v{e.version}</span>
                      <span className="updatesEntryTitle">{e.title}</span>
                      <span className="updatesDate">{e.date}</span>
                    </div>
                    <p className="updatesTagline">{e.tagline}</p>
                    <ul className="updatesHighlights">
                      {e.highlights.map((h) => (
                        <li key={h.title}>
                          <span className="updatesIcon" aria-hidden="true">{h.icon}</span>
                          <span><strong>{h.title}</strong> — {h.blurb}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "about" ? (
            <div className="settingsPane aboutPane">
              <div className="aboutMark" aria-hidden="true" />
              <h3 className="aboutName">ARES</h3>
              <p className="aboutTag">the battle-tested agent</p>
              <div className="aboutGrid">
                <div><span>Version</span><strong>v{APP_VERSION}</strong></div>
                <div><span>Engine</span><strong>queryEngine · 80-turn default</strong></div>
                <div><span>Providers</span><strong>ollama · openai · anthropic · deepseek · openrouter</strong></div>
                <div><span>Daemon</span><strong>{native ? "attached" : "demo mode"}</strong></div>
              </div>
              <p className="paneHint">A general-purpose autonomous agent — elite at coding, research, and durable missions.</p>
            </div>
          ) : null}
        </div>

        <footer className="settingsFooter">
          <span className="settingsFooterHint">Applies live where safe · no session restart</span>
          <button className="primary" onClick={() => onApply(draft, keys)}>
            Apply changes
          </button>
        </footer>
      </div>
    </div>
  );
}

const SERVICE_PROVIDERS = [
  { id: "google", label: "Google", desc: "Calendar, Gmail, Contacts" },
  { id: "spotify", label: "Spotify", desc: "Music playback & playlists" },
  { id: "github", label: "GitHub", desc: "Repos, issues, PRs" },
  { id: "discord", label: "Discord", desc: "Guilds & messages" },
  { id: "reddit", label: "Reddit", desc: "Posts & messages" },
  { id: "notion", label: "Notion", desc: "Pages & databases" },
  { id: "slack", label: "Slack", desc: "Channels & messages" },
  { id: "todoist", label: "Todoist", desc: "Tasks & projects" },
  { id: "twitch", label: "Twitch", desc: "Streams & subscriptions" },
  { id: "linkedin", label: "LinkedIn", desc: "Profile & connections" },
  { id: "dropbox", label: "Dropbox", desc: "Files & sharing" },
];

function ServicesPane({
  native,
  providers,
  onDaemonCommand,
}: {
  native: boolean;
  providers: OAuthProviderVm[];
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
}) {
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Fetch live status whenever the pane mounts.
  useEffect(() => {
    if (native) onDaemonCommand({ type: "oauth_status" });
  }, [native]);

  // Stop the connecting spinner once the provider reports connected.
  useEffect(() => {
    if (pending && providers.find((p) => p.id === pending)?.connected) setPending(null);
  }, [providers, pending]);

  const byId = (id: string) => providers.find((p) => p.id === id);

  const connect = (id: string) => {
    setPending(id);
    onDaemonCommand({ type: "oauth_start", provider: id });
    // Safety: clear the spinner after the flow's own timeout window.
    setTimeout(() => setPending((p) => (p === id ? null : p)), 60_000);
  };
  const disconnect = (id: string) => onDaemonCommand({ type: "oauth_disconnect", provider: id });
  const saveCredentials = (id: string) => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    onDaemonCommand({ type: "oauth_set_credentials", provider: id, clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    setSetupFor(null); setClientId(""); setClientSecret("");
  };

  return (
    <div className="settingsPane">
      <h3 className="paneTitle">Connected Services</h3>
      <p className="paneHint">
        Sign in so Ares can manage your calendar, play music, send emails, and more — through YOUR account.
        {!native && " (Connect to the daemon to manage services.)"}
      </p>
      <div className="servicesGrid">
        {SERVICE_PROVIDERS.map((svc) => {
          const p = byId(svc.id);
          const connected = p?.connected ?? false;
          const hasApp = p?.hasApp ?? false;
          const isPending = pending === svc.id;
          return (
            <div key={svc.id} className="serviceCard" data-connected={connected ? "1" : "0"}>
              <div className="serviceInfo">
                <strong>{svc.label}</strong>
                <span>{svc.desc}</span>
              </div>
              <div className="serviceActions">
                {connected ? (
                  <>
                    <span className="serviceStatus connected">Connected</span>
                    <button className="ghost small" onClick={() => disconnect(svc.id)} disabled={!native}>Disconnect</button>
                  </>
                ) : isPending ? (
                  <span className="serviceStatus" style={{ color: "var(--bronze-hi)" }}>Authorizing…</span>
                ) : hasApp ? (
                  <button className="primary small" onClick={() => connect(svc.id)} disabled={!native}>Connect</button>
                ) : (
                  <button className="ghost small" onClick={() => setSetupFor(setupFor === svc.id ? null : svc.id)} disabled={!native}>
                    {setupFor === svc.id ? "Cancel" : "Set up app"}
                  </button>
                )}
              </div>
              {setupFor === svc.id ? (
                <div className="serviceSetup">
                  <p className="paneHint">
                    Register an OAuth app on {svc.label}'s developer console, set the redirect URI to
                    <code> http://localhost:53691/oauth/callback</code>, then paste its credentials:
                  </p>
                  <input className="keyInput" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                  <input className="keyInput" placeholder="Client Secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
                  <button className="primary small" onClick={() => saveCredentials(svc.id)} disabled={!clientId.trim() || !clientSecret.trim()}>Save credentials</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="paneHint" style={{ marginTop: "1rem" }}>
        Connecting opens your browser to sign in — Ares acts through your real account, never a bot.
        You can also connect from Telegram with /connect. Browser-only services (DoorDash, Amazon, OpenTable)
        work through Ares's browser automation — no sign-in needed.
      </p>
    </div>
  );
}

function AnthropicSignIn({
  status,
  error,
  onRetry,
  onClose,
}: {
  status: "idle" | "opening" | "waiting" | "done" | "error";
  error?: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="scrim center" onClick={onClose}>
      <div className="authModal" onClick={(e) => e.stopPropagation()}>
        <div className="authModalMark" aria-hidden="true" />
        <h3>Sign in with Claude</h3>
        {status === "done" ? (
          <p className="authOk">✓ Signed in — reconnecting the Garrison…</p>
        ) : status === "error" ? (
          <>
            <p className="authErr">{error ?? "Sign-in failed."}</p>
            <div className="authActions">
              <button className="ghost" onClick={onClose}>Cancel</button>
              <button className="primary" onClick={onRetry}>Try again</button>
            </div>
          </>
        ) : (
          <>
            <p className="authModalHint">
              Use your Claude Pro or Max subscription — no API key, no per-token billing. Approve access in the browser window that just opened and you'll be signed in automatically.
            </p>
            <ol className="authSteps">
              <li data-on="1">Browser opened to Claude</li>
              <li data-on={status === "waiting" ? "1" : "0"}>Approve access</li>
              <li data-on="0">Signing in automatically…</li>
            </ol>
            <div className="authActions">
              <button className="ghost" onClick={onRetry}>Reopen browser</button>
              <button className="ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ConsciousnessPane({
  native,
  state,
  onDaemonCommand,
}: {
  native: boolean;
  state: ConsciousnessVm;
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
}) {
  const readyCount = state.models.filter((m) => m.present).length;
  const totalCount = state.models.length || 3;
  const phase = !state.enabled
    ? "Dormant"
    : state.downloading
      ? "Awakening…"
      : state.paused
        ? "Looking away"
        : state.ready
          ? "Awake"
          : "Enabled";
  const toggle = () =>
    onDaemonCommand({ type: state.enabled ? "consciousness_disable" : "consciousness_enable" });

  return (
    <div className="settingsPane">
      <h3 className="paneTitle">Consciousness</h3>
      <p className="paneHint">
        An embedded local brain that watches the screen and powers memory — it runs <em>inside</em> Ares,
        with no provider, key, or network. Awakening pulls its models once (~600&nbsp;MB): a tiny vision
        model (the eyes) and an embedding model (vector memory).
      </p>

      <div className="consciousHead">
        <div>
          <span className="consciousPhase" data-awake={state.ready ? "1" : "0"} data-on={state.enabled ? "1" : "0"}>
            {phase}
          </span>
          <span className="paneHint"> · {readyCount}/{totalCount} models ready</span>
        </div>
        <div className="consciousBtns">
          {state.downloading ? (
            <button className="provChip" disabled={!native} onClick={() => onDaemonCommand({ type: "consciousness_cancel" })}>
              Cancel
            </button>
          ) : null}
          <button className="provChip" data-on={state.enabled ? "1" : "0"} disabled={!native || state.downloading} onClick={toggle}>
            {state.enabled ? "Make dormant" : "Awaken"}
          </button>
        </div>
      </div>

      {state.models.length > 0 || state.enabled ? (
        <div className="consciousModels">
          {state.models.map((m) => {
            const pct = m.present ? 100 : state.progress[m.id] ?? 0;
            const right = m.present ? "ready" : state.downloading ? `${pct}%` : `${(m.bytes / 1048576).toFixed(0)} MB`;
            return (
              <div key={m.id} className="consciousModel">
                <div className="consciousModelHead">
                  <span>{m.label}</span>
                  <span className="paneHint">{right}</span>
                </div>
                <div className="updateBanner__bar">
                  <div className="updateBanner__barFill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          {state.enabled ? (
            (() => {
              const epct = state.engineInstalled ? 100 : state.progress.engine ?? 0;
              const right = state.engineInstalled ? "installed" : state.downloading ? `${epct}%` : "~16 MB";
              return (
                <div className="consciousModel">
                  <div className="consciousModelHead">
                    <span>Vision engine (llama.cpp)</span>
                    <span className="paneHint">{right}</span>
                  </div>
                  <div className="updateBanner__bar">
                    <div className="updateBanner__barFill" style={{ width: `${epct}%` }} />
                  </div>
                </div>
              );
            })()
          ) : null}
        </div>
      ) : null}

      {state.error ? <p className="paneHint" style={{ color: "var(--crimson)" }}>{state.error}</p> : null}

      {state.enabled ? (
        <div className="consciousWatch">
          <div className="consciousModelHead">
            <strong>The eyes</strong>
            <span className="paneHint">
              {state.paused
                ? "looking away"
                : state.engineAvailable
                  ? state.watching
                    ? "watching"
                    : "ready"
                  : state.engineInstalled
                    ? "engine present, models pending"
                    : "engine not installed"}
            </span>
          </div>
          {!state.engineInstalled ? (
            <p className="paneHint">
              The local vision engine binary isn't installed yet. Drop a <code>llama-mtmd-cli</code> build into{" "}
              <code>&lt;home&gt;/engine</code> (or set <code>ARES_LLAMA_MTMD</code>) and the eyes open — no other change needed.
            </p>
          ) : null}
          {state.lastComment ? (
            <p className="consciousRemark">“{state.lastComment}”</p>
          ) : state.lastObservation ? (
            <p className="paneHint">Watching quietly · last read: {state.lastObservation}</p>
          ) : null}
          <div className="consciousBtns" style={{ marginTop: 12 }}>
            {state.paused ? (
              <button className="provChip" data-on="1" disabled={!native} onClick={() => onDaemonCommand({ type: "consciousness_resume" })}>
                Resume
              </button>
            ) : (
              <button className="provChip" disabled={!native || !state.watching} onClick={() => onDaemonCommand({ type: "consciousness_look_away", seconds: 300 })}>
                Look away (5 min)
              </button>
            )}
            <button className="provChip" data-danger="1" disabled={!native} onClick={() => onDaemonCommand({ type: "consciousness_killswitch" })}>
              Killswitch
            </button>
          </div>
        </div>
      ) : null}

      <p className="paneHint">
        Local + private: screen frames are read by the on-device model and never leave the machine. It stays silent
        unless something's genuinely worth a word.
      </p>
    </div>
  );
}

function EngineRow({
  label,
  hint,
  value,
  onChange,
  min = 1,
  max = 1_000_000,
  step = 1,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="engineRow">
      <div className="engineInfo">
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          // Ignore empty/NaN (a cleared field shouldn't silently become 0 and
          // hobble the agent) and clamp to the knob's safe range.
          const raw = Number(e.target.value);
          if (e.target.value === "" || !Number.isFinite(raw)) return;
          onChange(Math.min(max, Math.max(min, Math.round(raw))));
        }}
      />
    </div>
  );
}

function UsagePane({ usage, onDaemonCommand, native }: { usage: UsageStats | null; onDaemonCommand: (cmd: Record<string, unknown>) => void; native: boolean }) {
  const [range, setRange] = useState(30);
  const maxDay = useMemo(() => Math.max(1, ...(usage?.daily ?? []).map((d) => d.in + d.out)), [usage]);
  return (
    <div className="settingsPane">
      <div className="usageHead">
        <h3 className="paneTitle">Usage</h3>
        <div className="segment mini">
          {[7, 30, 90].map((d) => (
            <button key={d} data-on={range === d ? "1" : "0"} onClick={() => { setRange(d); if (native) onDaemonCommand({ type: "usage_stats", days: d }); }}>
              {d}d
            </button>
          ))}
        </div>
      </div>
      {!usage ? (
        <div className="paneEmpty">{native ? "Loading usage…" : "Usage history needs the daemon."}</div>
      ) : (
        <>
          <div className="usageStats">
            <div className="usageCard"><span>Sessions</span><strong>{usage.sessions}</strong></div>
            <div className="usageCard"><span>API calls</span><strong>{usage.apiCalls}</strong></div>
            <div className="usageCard"><span>Tokens in</span><strong>{fmtTokens(usage.tokensIn)}</strong></div>
            <div className="usageCard"><span>Tokens out</span><strong>{fmtTokens(usage.tokensOut)}</strong></div>
            <div className="usageCard"><span>Cache reads</span><strong>{fmtTokens(usage.cacheReadTokens)}</strong></div>
            <div className="usageCard"><span>Agent overhead</span><strong>{fmtTokens(usage.auxiliaryTokensIn + usage.auxiliaryTokensOut)}</strong></div>
          </div>
          {usage.daily.length > 0 ? (
            <>
              <label className="fieldLabel">Daily tokens</label>
              <div className="usageChart">
                {usage.daily.map((d) => (
                  <div key={d.date} className="usageBar" title={`${d.date}: ↑${fmtTokens(d.in)} ↓${fmtTokens(d.out)}`}>
                    <span className="barIn" style={{ height: `${((d.in + d.out) / maxDay) * 100}%` }} />
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {usage.models.length > 0 ? (
            <>
              <label className="fieldLabel">Top models</label>
              <div className="usageTable">
                {usage.models.slice(0, 8).map((m) => (
                  <div key={m.model} className="usageRow">
                    <span className="usageModel">{m.model}</span>
                    <span className="usageCalls">{m.calls} calls</span>
                    <span className="usageTok">↑{fmtTokens(m.tokensIn)} ↓{fmtTokens(m.tokensOut)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

// ─── Mount ─────────────────────────────────────────────────────────────────

class AresErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface the failure in a controlled way instead of letting the WebView
    // show the generic "Something went wrong" crash page.
    console.error("Ares UI crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="errorBoundary">
          <div className="errorBoundaryMark" aria-hidden="true"></div>
          <h2>Ares hit a rendering problem</h2>
          <p>{this.state.error?.message ?? "Something went wrong."}</p>
          <button onClick={() => this.setState({ hasError: false, error: undefined })} className="primary">
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Catch top-level runtime errors and promise rejections so a single bad event
// or effect doesn't hard-crash the WebView renderer.
window.addEventListener("error", (e) => {
  console.error("Ares unhandled error:", e.error);
  e.preventDefault();
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("Ares unhandled rejection:", e.reason);
  e.preventDefault();
});

const rootEl = document.getElementById("root");
if (rootEl) {
  // Vite HMR re-evaluates this module — reuse the root across hot reloads.
  const holder = window as unknown as { __aresRoot?: ReturnType<typeof createRoot> };
  holder.__aresRoot ??= createRoot(rootEl);
  holder.__aresRoot.render(
    <AresErrorBoundary>
      <App />
    </AresErrorBoundary>,
  );
}
