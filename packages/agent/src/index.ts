export { aresAgentHome, agentPaths, workspaceToolsPath, type AgentPaths } from "./paths.js";
export { exists, readTextIfExists, writeFileAtomic, renderTemplate, nonCommentLines } from "./files.js";
export { readTemplate, type AgentTemplateName } from "./templates.js";
export { defaultAgentConfig, loadAgentConfig, expandHomePath, type AresAgentConfig, type SlotConfig } from "./config.js";
export {
  ensureAgentScaffold,
  completeBootstrap,
  ensureWorkspaceTools,
  bootstrapReminder,
  type BootstrapProfile,
  type BootstrapState,
} from "./bootstrap/bootstrap.js";
export { VIBE_RULES, vibeRulesMarkdown } from "./bootstrap/vibeRules.js";
export { loadAgentSystemContext, composeAgentSystemPrompt, resolveAgentName, type AgentSystemContext, type AgentContextBlock } from "./identity/context.js";
export { embedText, embedOptionsFromConfig, lexicalEmbedding, type EmbedOptions } from "./memory/embed.js";
export { createMemoryStore, formatRecallReminder, type MemoryStore } from "./memory/vectorStore.js";
export type { AddMemoryInput, MemoryCategory, MemoryEntry, MemoryStoreStatus, RecallInput, RecallResult, CanonicalMemoryInput } from "./memory/types.js";
export { memoryEntryToCanonical } from "./memory/types.js";
export { onLifecycle, emitLifecycle, type LifecycleEvent, type DreamPhase } from "./lifecycle/bus.js";
export { runHeartbeatTick, startHeartbeatLoop, heartbeatPass, heartbeatEveryMs, type HeartbeatResult } from "./heartbeat.js";
export {
  ReflectionScheduler,
  type ReflectionTrigger,
  type ReflectionPassFn,
  type ReflectionPassOutcome,
} from "./reflection/scheduler.js";
export { runLightDream, runDeepDream, runRemDream, type DreamResult } from "./dreaming.js";
export { recallForTurn, type RecallOptions } from "./recall.js";
export {
  unifiedRecallForTurn,
  type UnifiedRecallOptions,
  type UnifiedRecallResult,
  type UnifiedRecallItem,
  type UnifiedRecallOrigin,
  type VectorRecallConfig,
  type LivingRecaller,
} from "./memory/unifiedRecall.js";
export {
  deliberateForTurn,
  memoryGroundedPropose,
  type AdvisoryResult,
  type DeliberateOptions,
} from "./cognition/advisory.js";
export { recordCardMemoryOnce, type CardMemoryInput } from "./memory/cardMemory.js";
export { beforeAgentFinalizeSignal, reviseReflectionSurface, type ReviseSignal } from "./revise.js";
export { recordToolPattern, proposeSkills, type ToolPatternObservation, type SkillProposal } from "./skills.js";
export { prepareAresAgent, AresAgentRuntime, type PreparedAgent } from "./runtime.js";
export { BootstrapTool, type BootstrapToolOutput } from "./tools/Bootstrap.js";
export { SelfEvolveTool, type SelfEvolveOutput } from "./tools/SelfEvolve.js";
export { SkillCraftTool, type SkillCraftOutput } from "./tools/SkillCraft.js";
export { RunSkillTool, type RunSkillOutput } from "./tools/RunSkill.js";
export { runSkill, type RunSkillOptions, type SkillRunResult } from "./skills/runtime.js";
export { makeSkillHubTool, type SkillHubOutput } from "./tools/SkillHub.js";
export {
  skillHubProbe, skillHubList, skillHubGet, skillHubPublish, installHubSkill, readLocalSkillFiles,
  skillHubBase, type HubSkillMeta, type HubSkillFiles,
} from "./skills/hub.js";
export {
  emptyModel,
  loadSelfModel,
  saveSelfModel,
  getCapability,
  upsertCapability,
  dropCapability,
  recordOutcome,
  summarizeSelf,
  type UpsertCapabilityInput,
  type RecordOutcomeInput,
} from "./self/store.js";
export {
  reliabilityOf,
  type Capability,
  type CapabilityKind,
  type CapabilityStatus,
  type CapabilityOutcomes,
  type CapabilityReliability,
  type SelfModel,
  type SelfSummary,
} from "./self/types.js";
export { reflect, selfModelReflectionSurface, type SelfDirective, type DirectiveKind, type ReflectOptions } from "./self/reflect.js";
export { SelfTool, type SelfToolOutput } from "./tools/Self.js";
export { MissionTool, type MissionToolOutput } from "./tools/Mission.js";
export {
  createMission,
  planMission,
  startNextStep,
  completeStep,
  failStep,
  verifyMission,
  abandonMission,
  noteMission,
  nextDirective,
  statusLabel,
} from "./mission/loop.js";
export {
  saveMission,
  loadMission,
  listMissions,
  activeMission,
  resolveMission,
  newMissionId,
} from "./mission/store.js";
export {
  isTerminal as isMissionTerminal,
  summarize as summarizeMission,
  type Mission,
  type MissionStep,
  type MissionStatus,
  type StepStatus,
  type MissionDirective,
  type MissionPhase,
  type MissionSummary,
  type MissionLogEntry,
} from "./mission/types.js";
export { captureUserMessage, detectCaptures, type CaptureMatch, type CaptureResult } from "./capture.js";
export { countAppendedItems, gainForTarget } from "./voice.js";
export type { EvolutionGain } from "./lifecycle/bus.js";
export {
  snapshotBrain,
  listSnapshots,
  restoreSnapshot,
  exportHome,
  importHome,
  type SnapshotInfo,
} from "./persistence.js";

export {
  runWitness,
  vetCandidate,
  WITNESS_SYSTEM_PROMPT,
  type WitnessAsk,
  type WitnessCandidate,
  type WitnessKind,
  type WitnessOptions,
  type WitnessReport,
  type WitnessStore,
} from "./crucible/witness.js";
