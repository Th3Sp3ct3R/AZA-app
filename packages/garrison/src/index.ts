// @ares/garrison — the Garrison: Ares's always-on daemon.
//
// Public surface:
//   - Wire protocol v1 types (the fixed client/server frame contract).
//   - ensureToken / constantTimeEqual — file-token auth.
//   - SessionManager + rehydrateSessions — N concurrent QueryEngine sessions
//     that outlive clients AND the daemon.
//   - Scheduler — heartbeat/dream ticks with injectable clocks.
//   - GarrisonServer — the localhost WebSocket+HTTP gateway.

export {
  PROTO_VERSION,
  DEFAULT_GARRISON_PORT,
  type GatewayClientFrame,
  type GatewayServerFrame,
  type SessionSummary,
  type GarrisonStatus,
} from "./protocol.js";

export { ensureToken, ensureReadToken, constantTimeEqual, garrisonDir, tokenPath, readTokenPath } from "./token.js";

export { viewerHtml } from "./viewer.js";

export {
  SessionManager,
  rehydrateSessions,
  rehydrateSession,
  sessionsDir,
  rolloutPath,
  SessionBusyError,
  UnknownSessionError,
  type SessionManagerOptions,
  type SessionFactory,
  type SessionFactoryRequest,
  type SessionFactoryResult,
  type SessionSubscriber,
  type SessionSendOptions,
  type RehydratedSession,
} from "./sessions.js";

export { Scheduler, type SchedulerOptions, type SchedulerHooks } from "./scheduler.js";

export {
  GarrisonServer,
  type GarrisonServerOptions,
  type ApprovalBridge,
  type ApprovalResponse,
} from "./server.js";

export { ChannelManager, type ChannelBridge, type ChannelManagerOptions } from "./channels.js";

export { ApprovalQueue, type ApprovalQueueOptions } from "./approvals.js";
