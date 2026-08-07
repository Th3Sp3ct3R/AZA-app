// @ares/channels — chat surfaces as pure Garrison gateway clients.
// A channel holds zero entity state: it renders TurnEvents, forwards intents,
// and never imports from the daemon. First channel: Telegram.

export { TelegramApi, TelegramApiError } from "./telegram/api.js";
export type {
  TelegramApiOptions,
  FetchLike,
  FetchInit,
  FetchResponseLike,
  TgUpdate,
  TgMessage,
  TgChat,
  TgUser,
  TgCallbackQuery,
  TgVoice,
  TgAudio,
  TgFile,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  SendMessageOptions,
} from "./telegram/api.js";

export { TelegramBridge, chunkMessage, toTelegramText } from "./telegram/bridge.js";
export type { TelegramBridgeOptions, TelegramApiLike, BridgeTimers } from "./telegram/bridge.js";

export {
  emptyRoster,
  upsertParticipant,
  removeParticipant,
  markSeen,
  findByChat,
  isOwner,
  isAllowed,
  ownerChatIds,
  allowedChatIds,
  renderWho,
  seedOwners,
  loadRoster,
  saveRoster,
  rosterFile,
  type Participant,
  type ParticipantRole,
  type RosterData,
} from "./telegram/roster.js";

export {
  OperatorTelegramReporter,
  formatOperatorReport,
  formatWarMapBriefing,
  redactForTelegram,
} from "./telegram/operatorReport.js";
export type {
  OperatorEventLike,
  OperatorReportOptions,
  OperatorReporterOptions,
  WarMapBriefing,
} from "./telegram/operatorReport.js";

export {
  verifyTelegramToken,
  discoverChatFromUpdates,
  pollForOwnerChat,
} from "./telegram/setup.js";
export type { TelegramSetupApi, VerifyResult, DiscoveredChat } from "./telegram/setup.js";

export {
  parseTelegramCommand,
  handleTelegramCommand,
  classifyMissionAction,
  stableHash,
} from "./telegram/commands.js";
export type {
  TelegramCommand,
  TelegramCommandKind,
  TelegramCommandState,
  TelegramCommandDeps,
  TelegramCommandResult,
  MissionProposal,
  MissionSummary,
} from "./telegram/commands.js";

export {
  TelegramOutbound,
  createOutbound,
  type OutboundConfig,
  type OutboundMessage,
} from "./telegram/outbound.js";

export {
  TelegramScheduler,
  loadSchedule,
  saveSchedule,
  addAlarm,
  removeAlarm,
  listAlarms,
  renderAlarms,
  generateAlarmId,
  slotsToAlarms,
  DEFAULT_SLOTS,
  type Alarm,
  type ScheduleData,
  type CheckInSlot,
  type CheckInContext,
  type CheckInBuilder,
  type SchedulerOptions,
} from "./telegram/scheduler.js";

export {
  synthesize,
  textToVoice,
  listVoices,
  defaultVoice,
  type EdgeVoice,
  type SynthesizeOptions,
} from "./telegram/edgeTts.js";

export {
  transcribe,
  voiceToText,
  type TranscribeResult,
} from "./telegram/stt.js";

export { TelegramChannelAdapter } from "./telegram/adapter.js";
export type {
  ChannelBridgeContract,
  ChannelParticipant,
  TelegramChannelAdapterOptions,
} from "./telegram/adapter.js";

export {
  sendConnectMenu,
  handleConnectCallback,
  parseConnectCallback,
} from "./telegram/connect.js";
export type { ConnectFlowApi, ConnectFlowDeps } from "./telegram/connect.js";

export type {
  ClientFrame,
  ServerFrame,
  GatewaySessionInfo,
  GarrisonStatus,
  StagedApprovalFrame,
  ApprovalVerb,
  WebSocketLike,
  WebSocketCtor,
} from "./types.js";
