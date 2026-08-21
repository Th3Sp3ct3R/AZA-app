// Wire types for the daemon bridge + view-model interfaces (extracted from App.tsx).

import type { ReasoningLevel } from "./session";
import type { Prefs, PermSettings, EngineConfig } from "./prefs";

// ─── Bridge contract ───────────────────────────────────────────────────────

export interface AresEvent {
  type: string;
  id?: string;
  text?: string;
  /** computer_setup_progress — one provisioning progress line. */
  line?: string;
  /** computer_setup_done / generic result payloads. */
  result?: unknown;
  /** computer_mode — provisioning kicked off alongside the mode switch. */
  setupStarted?: boolean;
  name?: string;
  toolName?: string;
  status?: string;
  /** Stable input identity for send/steer admission and settlement events. */
  inputId?: string;
  /** Desktop-only recovery payload for an ordinary input that never crossed a
   * daemon transport boundary before the owner pressed Stop. */
  images?: string[];
  /** Startup-recovery visibility: exact durable IDs and current hand-off phase. */
  inputIds?: string[];
  count?: number;
  phase?: string;
  /** Provider stream-attempt identity. Superseded attempts are UI-rollback
   * fences; they are not whole-turn cancellation. */
  attemptId?: string;
  /** Exact never-started effects skipped after an assistant commit. */
  toolUseIds?: string[];
  /** Session's post-durability routing result for a steer. */
  disposition?: "provider_preempting" | "effect_settling" | "boundary_pending" | "idle";
  /** Provider message terminal reason. */
  stopReason?: string;
  /** Steering delivery state reported by the daemon. */
  steerPhase?: "idle" | "preparing" | "generation" | "action" | "boundary" | "settling";
  delivery?: "interrupting_generation" | "waiting_for_action" | "waiting_for_owner_admission" | "next_boundary" | "queue" | "steer";
  retryable?: boolean;
  settled?: boolean;
  /** Host epilogue released this owner but already scheduled exact successor work. */
  continuing?: boolean;
  /** turn_end only — the engine's work-truth verdict for the turn. Drives the
   *  "finished but UNVERIFIED" disclosure so a turn that changed code without
   *  a passing check never reads as a clean finish. */
  workStatus?: "not_applicable" | "unverified" | "verified" | "blocked";
  source?: string;
  reason?: string;
  decision?: string;
  level?: string;
  /** roster_list / persona_changed / persona_suggested — the persona roster and
   *  whichever one this session is currently wearing (null = plain Ares). */
  personas?: unknown;
  active?: unknown;
  persona?: unknown;
  /** Trigger phrases that fired, so the UI can show WHY a persona stepped in. */
  matched?: unknown;
  /** cognitive_state payload. Deliberately NOT `state` — that name is already
   *  taken on this type by daemon/consciousness status strings. */
  cognitive?: unknown;
  /** bug_report_result: where the report was written locally when the gateway
   *  upload didn't happen (no account) or didn't succeed. */
  savedPath?: unknown;
  origin?: string;
  provider?: string;
  model?: string;
  currentProvider?: string;
  currentModel?: string;
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
  data?: { kind?: string; stream?: string; text?: string; total?: number; activity?: string; tool?: string; image?: string; url?: string; title?: string; agentId?: string; event?: string; role?: string; phase?: string; status?: string; fleetId?: string; backend?: string; label?: string; line?: string; filesTouched?: number; version?: string; phaseKind?: string; build?: boolean; failureReason?: string; contract?: { deliverables?: Array<{ pattern: string; met: boolean }> }; goal?: string };
  /** compaction event fields */
  summarizedMessages?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  method?: "micro" | "summary" | "ledger";
  /** workflow_mode_set — the mode the session ACTUALLY holds after the toggle. */
  mode?: string;
  /** persona_style_set — the voice layer the daemon persisted. */
  style?: string;
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
  /** operator_status — the operator scheduler is halted (owner pressed Halt). */
  halted?: boolean;
  /** fleets_list reply — every Conductor fleet the daemon knows about. */
  fleets?: FleetSummaryWire[];
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
  // daemon_memory_pressure / session_evicted — the daemon watching its own heap
  // so the climb toward an exit-134 abort is visible instead of silent.
  pressure?: "ok" | "elevated" | "critical";
  usedMb?: number;
  limitMb?: number;
  percent?: number;
  residentSessions?: number;
  evictedSessions?: number;
  idleMs?: number;
  // interrupt_pending / interrupt_forced — how long a Stop has sat unsettled,
  // when a second Stop escalates, and what a forced stop actually killed.
  stalledMs?: number;
  forceAvailableInMs?: number;
  killed?: number;
  // background_jobs / background_suspended — the durable shell jobs a session
  // owns, so the desktop can show and stop them instead of the owner finding
  // out via Task Manager. subagents_list replies reuse this field with the
  // SubagentJobWire shape — narrow by event type at the handler.
  jobs?: BackgroundJobVm[] | SubagentJobWire[];
  running?: number;
  resumable?: number;
  from?: string;
}

/** One fleet from a fleets_list reply — the HELM Fleets history ledger. */
export interface FleetSummaryWire {
  fleetId: string;
  goal?: string;
  status?: string;
  startedAt?: string | number;
  finishedAt?: string | number;
  phases?: Array<{
    id: string;
    kind?: string;
    status?: string;
    build?: boolean;
    agents?: Array<{ role?: string; status?: string; workStatus?: string }>;
  }>;
  manifestPath?: string;
}

/** One background Task subagent from a subagents_list reply. */
export interface SubagentJobWire {
  jobId: string;
  kind?: string;
  description?: string;
  status: string;
  startedAt?: string | number;
  finishedAt?: string | number;
  sessionId?: string;
}

/** One durable background shell, as the daemon reports it. */
export interface BackgroundJobVm {
  id: string;
  description: string;
  command: string;
  cwd?: string;
  status: "running" | "exited" | "killed" | "errored" | "orphaned";
  exitCode?: number | null;
  startedAt?: string;
  /** Stopped because the host went away (Stop, or the app closing). */
  suspended?: boolean;
  stoppedReason?: string;
  /** Can be relaunched exactly as it was — only ever on an explicit ask. */
  resumable?: boolean;
  sessionId?: string;
}

export interface ConsciousnessModelVm {
  id: string;
  role: string;
  label: string;
  filename: string;
  bytes: number;
  present: boolean;
  downloadedBytes: number;
}
export interface ConsciousnessVm {
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

export interface OAuthProviderVm {
  id: string;
  label: string;
  connected: boolean;
  hasApp: boolean;
}

/** A connected remote MCP server (the /mcp explorer). */
export interface McpConnectorVm {
  name: string;
  url: string;
  displayName?: string;
  oauth?: boolean;
  connectedAt?: string | null;
  /** false = paused via the explorer toggle (tokens kept, tools unloaded). */
  enabled?: boolean;
}

/** A composer "/" command (rendered in the slash menu, Enter runs it). */
export interface SlashAction {
  id: string;
  icon: string;
  label: string;
  hint: string;
  run: () => void;
}

/** A connect-able remote server from the public MCP registry. */
export interface McpRegistryResult {
  name: string;
  fullName: string;
  description: string;
  url: string;
  needsKey: boolean;
}

/** One connector's live tool listing, as fetched for the explorer's expand row. */
export interface McpToolsVm {
  loading: boolean;
  tools: Array<{ name: string; description?: string }>;
  error?: string | null;
}

/** Ares Gateway account snapshot (doingteam.com /me via the daemon bridge). */
export interface GatewayAccountVm {
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

export interface BufferedEvent {
  seq: number;
  event: AresEvent;
}

export interface DaemonStatus {
  running: boolean;
  root?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface OllamaModelInfo {
  id: string;
  hint: string;
  size?: number | null;
  parameters?: string | null;
  family?: string | null;
  contextWindow?: number | null;
  capabilities?: string[];
}

export interface OllamaDiscovery {
  host: string;
  reachable: boolean;
  models: OllamaModelInfo[];
  error?: string | null;
}

export type PresenceMode = "idle" | "listening" | "working" | "speaking" | "heard";

export interface PresenceSnapshot {
  visible: boolean;
  mode: PresenceMode;
  caption: string;
  detail: string;
}
