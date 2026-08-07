// Gateway wire protocol v1 — the FIXED CONTRACT between the Garrison and every
// channel client (desktop, CLI, Telegram, ...). Discriminated unions on `type`,
// type-only imports, zero runtime dependencies.
//
// Transport: WebSocket on 127.0.0.1 (ARES_GARRISON_HOST to override), port from
// ARES_GARRISON_PORT or 7421, plus HTTP GET /health on the same port. The first
// client frame MUST be `hello` carrying the token from <home>/garrison/token;
// the server answers `welcome` or sends `error` and closes.

import type { PermissionPromptDecision, TurnEvent } from "@ares/protocol";
import type { ApprovalVerb, StagedApproval } from "@ares/effects";

export const PROTO_VERSION = 1 as const;
export const DEFAULT_GARRISON_PORT = 7421;

/** One live (or rehydrated) session as clients see it. */
export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  provider: string;
  busy: boolean;
}

/** Daemon vitals reported by the `status` frame. */
export interface GarrisonStatus {
  /** ISO timestamp of daemon boot. */
  startedAt: string;
  /** 0 when no scheduler is wired. */
  heartbeatEveryMs: number;
  /** ISO timestamp of the next dream eligibility, when a dream hook exists. */
  nextDreamAt?: string;
  sessions: number;
}

// ─── Client → server ────────────────────────────────────────────────────

export type GatewayClientFrame =
  | { type: "hello"; token: string; client: string; proto: typeof PROTO_VERSION }
  | { type: "session.create"; provider?: string; model?: string; workspace?: string }
  | { type: "session.attach"; sessionId: string }
  | { type: "session.send"; sessionId: string; text: string }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "sessions.list" }
  | { type: "status" }
  | {
      type: "permission.respond";
      sessionId: string;
      requestId: string;
      decision: PermissionPromptDecision;
    }
  | { type: "approval.respond"; approvalId: string; verb: ApprovalVerb; note?: string }
  // ── Channel management (Telegram, etc.) → server ─────────────────
  | {
      type: "channel.configure";
      channel: string;
      config: { token?: string; allowedChats?: number[]; ownerChatIds?: number[] };
    }
  | { type: "channel.start"; channel: string }
  | { type: "channel.stop"; channel: string }
  | { type: "channel.status" }
  | {
      type: "channel.roster.add";
      channel: string;
      chatId: number;
      name?: string;
      role?: "owner" | "member";
    }
  | { type: "channel.roster.remove"; channel: string; chatId: number }
  | { type: "channel.test"; channel: string; chatId: number; text: string };

// ─── Server → client ────────────────────────────────────────────────────

export type GatewayServerFrame =
  | { type: "welcome"; sessions: SessionSummary[] }
  | { type: "session.created"; session: SessionSummary }
  /** TurnEvents pass through VERBATIM — clients render exactly what the engine yielded. */
  | { type: "event"; sessionId: string; event: TurnEvent }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "status"; garrison: GarrisonStatus }
  | { type: "approval.pending"; staged: StagedApproval }
  | { type: "error"; message: string }
  // ── Channel status / roster events → client ─────────────────────
  | {
      type: "channel.status";
      channels: ChannelStatus[];
    }
  | {
      type: "channel.roster";
      channel: string;
      participants: ChannelParticipant[];
    }
  | {
      type: "channel.event";
      channel: string;
      event: "started" | "stopped" | "connected" | "disconnected" | "message";
      detail?: string;
    };

/** Runtime status of a single channel bridge. */
export interface ChannelStatus {
  channel: string;
  running: boolean;
  connected: boolean;
  configured: boolean;
  participantCount: number;
  lastError?: string;
  uptimeMs?: number;
}

/** One participant in a channel roster. */
export interface ChannelParticipant {
  chatId: number;
  name: string;
  role: "owner" | "member";
  addedAt: string;
  lastSeenAt?: string;
}
