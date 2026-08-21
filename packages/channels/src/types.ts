// Gateway wire protocol v1 — the channel-side copy of the frame contract.
// The Garrison owns the canonical server; channels deliberately do NOT import
// from @ares/garrison (parallel build, no cycle). These shapes mirror the
// fixed v1 contract exactly: hello/welcome handshake, session intents,
// TurnEvent fan-out, and the Gate's approval frames.

import type { PermissionPromptDecision, TurnEvent } from "@ares/protocol";

/** Session summary as the gateway reports it (welcome / sessions / session.created). */
export interface GatewaySessionInfo {
  id: string;
  title?: string;
  model?: string;
  provider?: string;
  busy?: boolean;
}

/** Mirrors @ares/effects ApprovalVerb without taking the dependency. */
export type ApprovalVerb = "allow_once" | "allow_always" | "deny";

/** A staged effect waiting at the Gate, as broadcast by the gateway. */
export interface StagedApprovalFrame {
  id: string;
  kind?: string;
  domain?: string;
  reason?: string;
  preview?: unknown;
}

export interface GarrisonStatus {
  startedAt: string;
  heartbeatEveryMs: number;
  nextDreamAt?: string;
  sessions: number;
}

export type ClientFrame =
  | { type: "hello"; token: string; client: string; proto: 1 }
  | { type: "session.create"; provider?: string; model?: string; workspace?: string }
  | { type: "session.attach"; sessionId: string }
  | {
      type: "session.send";
      sessionId: string;
      text: string;
      inputId?: string;
      delivery?: "queue" | "steer";
    }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "sessions.list" }
  | { type: "status" }
  | { type: "permission.respond"; sessionId: string; requestId: string; decision: PermissionPromptDecision }
  | { type: "approval.respond"; approvalId: string; verb: ApprovalVerb; note?: string };

export type ServerFrame =
  | { type: "welcome"; sessions: GatewaySessionInfo[] }
  | { type: "session.created"; session: GatewaySessionInfo }
  | { type: "event"; sessionId: string; event: TurnEvent }
  | { type: "sessions"; sessions: GatewaySessionInfo[] }
  | { type: "status"; garrison: GarrisonStatus }
  | { type: "approval.pending"; staged: StagedApprovalFrame }
  | { type: "error"; message: string };

/** Minimal structural WebSocket — satisfied by `ws` and by injected fakes. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;
