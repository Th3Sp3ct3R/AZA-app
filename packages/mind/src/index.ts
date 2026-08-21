// @ares/mind — the Mind layer (Ares v6).
//
// M1 Living Memory: episodic + semantic + procedural memory in one substrate,
// strength-weighted (grows with use, fades when ignored), self-associating
// (spreading-activation recall), and self-consolidating (forgets the trivial,
// crystallizes the recurring). Pluggable home — point it at a flashdrive.
//
// M2 Cognition (the thought process) lands on top of this.

export {
  MemoryStore,
  consolidateReflectionSurface,
  synthesizeReflectionSurface,
  type AddInput,
  type ConsolidationReport,
  type SynthesisReport,
} from "./memory/store.js";
export {
  MemoryRouter,
  MEMORY_CHANNEL_POLICIES,
  type MemoryChannel,
  type ChannelPolicy,
  type DedupeRule,
  type RoutedWrite,
  type RouteReport,
  type RouteOptions,
  type RouterStoreLike,
  type SkipReason,
} from "./memory/router.js";
export { withConsolidationLock, type ConsolidationLockOptions } from "./memory/consolidationLock.js";
export { isOperationalNoise } from "./memory/noise.js";
export { diagnoseMemory, type MemoryDoctorReport, type DuplicateMemoryGroup } from "./memory/doctor.js";
export { recall, type RecallResult, type RecallOptions, type RecallVectors } from "./memory/recall.js";
export {
  EmbedIndex,
  ollamaEmbedder,
  cosine,
  contentHash,
  type Embedder,
  type OllamaEmbedderOptions,
} from "./memory/embedIndex.js";
export { migrateLegacyVectors, V4_PROVENANCE_TAG, type MigrateVectorsReport } from "./memory/migrateVectorStore.js";
export { buildIdf, idfWeight, jaccard, tokenizeSalient, type IdfMap } from "./memory/idf.js";
export {
  clusterByConcept,
  detectRecurringFailures,
  synthesizeCandidates,
  type InsightCandidate,
  type Phraser,
} from "./memory/synthesis.js";
export { currentStrength, reinforce, weaken, HALF_LIFE_MS } from "./memory/strength.js";
export {
  compileContext,
  budgetForMessage,
  estimateTokensDefault,
  type MemoryTier,
  type MemoryFragment,
  type ContextRequest,
  type ContextPacket,
  type CompiledFragment,
} from "./memory/contextCompiler.js";
export {
  loadMissionState,
  saveMissionState,
  loadProjectState,
  saveProjectState,
  missionFragments,
  renderMissionFragment,
  renderProjectFragment,
  inferProjectId,
  detectWorkspaceProjectId,
  safeProjectId,
  stateDir,
  defaultAresMission,
  defaultAresProject,
  MISSION_STATE_SCHEMA,
  PROJECT_STATE_SCHEMA,
  type MissionState,
  type ProjectState,
} from "./memory/missionState.js";
export {
  saveAfterAction,
  loadRecentAfterActions,
  applyAfterActionToProjectState,
  recordAfterAction,
  renderAfterActionFragment,
  summarizeRun,
  reflectOnRun,
  afterActionReflectionSurface,
  afterActionDir,
  AFTER_ACTION_SCHEMA,
  type AfterActionRecord,
  type AfterActionResult,
  type RunFacts,
  type ReflectOutcome,
} from "./memory/afterAction.js";
export {
  buildConversationDigest,
  mergeDurableFacts,
  conversationReflectionSurface,
  CONVERSATION_REFLECT_SYSTEM,
  DURABLE_FACTS_SCHEMA_HINT,
  type DurableFact,
  type DurableFactKind,
  type ReflectStoreLike,
  type MergeFactsResult,
} from "./memory/conversationReflect.js";
export { mindPaths, aresHome, type MindPaths } from "./paths.js";
export { MEMORY_SCHEMA_VERSION } from "./memory/types.js";
export type { MemoryNode, MemoryKind, HypothesisStatus, CrucibleCheck, EvidenceEntry, ReflectionSurface, ReflectionResult } from "./memory/types.js";

// ── M2: Cognition (the thought process) ───────────────────────────────────
export { consider, detectDrives, type ConsiderDeps, type ReasonOption, type CapabilityGap } from "./cognition/cognition.js";
export { ThoughtStream, thoughtGlyph } from "./cognition/stream.js";
export { classifyUserIntent, buildForegroundReminder, type UserIntent, type UserIntentKind } from "./cognition/intent.js";
export type { Thought, ThoughtKind, Intention, Deliberation, RecalledMemory } from "./cognition/types.js";
