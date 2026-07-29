// Wire types for the daemon bridge + view-model interfaces (extracted from App.tsx).

import type { ReasoningLevel } from "./session";
import type { Prefs, PermSettings, EngineConfig } from "./prefs";

// ─── Bridge contract ───────────────────────────────────────────────────────

export interface AresEvent {
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
  data?: { kind?: string; stream?: string; text?: string; total?: number; activity?: string; tool?: string; image?: string; url?: string; title?: string; agentId?: string; event?: string; role?: string; phase?: string; status?: string; fleetId?: string; backend?: string; label?: string; line?: string; filesTouched?: number; version?: string };
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
