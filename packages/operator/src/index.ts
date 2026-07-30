// @ares/operator — the durable autonomy spine (Ares v5).
//
// The Operator is the WILL: a small, boring, always-on supervisor that holds
// long-horizon goals and drives them to reality-verified completion through
// ephemeral QueryEngine Workers (the HANDS), surviving the process dying.
//
// O1 ships the spine on a software world: GoalStore + Scheduler + ControlLoop
// + Dispatcher. Effects/rails (O2), reality verification (O3), and the
// compounding capability graph (O4) bolt on above this without changing it.
//
// Boundary: like @ares/agent, nothing in @ares/core or @ares/tools imports
// this package — the will sits on top of the hands, never the reverse.

export {
  createGoal,
  applyVerdict,
  completeGoal,
  markInFlight,
  abandonGoal,
  isActive,
  isTerminal,
  nextStepIndex,
} from "./goal.js";

export { newGoalId, saveGoal, loadGoal, listGoals, activeGoals } from "./store.js";

export {
  tickGoal,
  tickAll,
  runGoalToCompletion,
  type ControlLoopContext,
} from "./controlLoop.js";

export {
  QueryEngineDispatcher,
  defaultEvaluate,
  type QueryEngineDispatcherOptions,
} from "./dispatcher.js";

export { Scheduler, type SchedulerOptions } from "./scheduler.js";

export {
  decideAttention,
  rankAttentionItem,
  attentionItemsFromGoals,
  attentionItemsFromCapabilities,
  type AttentionDecision,
  type AttentionItem,
  type AttentionItemKind,
  type RankedAttentionItem,
} from "./attention.js";

export {
  OperatorBackgroundLoop,
  operatorLoopEnabled,
  type OperatorBackgroundLoopOptions,
  type OperatorBackgroundTick,
  type OperatorBackgroundEvent,
  type OperatorWakeReason,
} from "./backgroundLoop.js";

export {
  readOperatorControl,
  setOperatorControl,
  isOperatorPaused,
  type OperatorControl,
} from "./control.js";

export { operatorPaths, type OperatorPaths } from "./paths.js";

export {
  STANDING_ORDER_SCHEMA,
  MIN_CADENCE_MS,
  newStandingOrderId,
  normalizeStandingOrder,
  saveStandingOrder,
  loadStandingOrders,
  addStandingOrder,
  removeStandingOrder,
  setStandingOrderEnabled,
  dueStandingOrders,
  materializeDueStandingOrders,
  renderStandingOrders,
  type StandingOrder,
  type MaterializeResult,
} from "./standingOrders.js";

export { runProbe, type ProbeResult, type ProbeContext } from "./probe.js";

export { WorldModel, type WorldSource, type WorldSnapshot } from "./worldModel.js";

export {
  MISSION_CONTRACT_SCHEMA_VERSION,
  createMissionContract,
  missionContractFromGoal,
  addMissionEvidence,
  addMissionBlocker,
  markMissionProbePending,
  recordMissionProbeResult,
  missionContractCanComplete,
  missionContractUnmetRequirements,
  missionContractNextVerificationAction,
  verificationSpecSummary,
  resolveMissionBlocker,
  setMissionNextAction,
  abandonMissionContract,
  missionContractSummary,
  normalizeMissionContract,
  newMissionContractId,
  saveMissionContract,
  loadMissionContract,
  listMissionContracts,
  type AcceptanceCriterion,
  type AcceptanceCriterionStatus,
  type MissionBlocker,
  type MissionConstraint,
  type MissionContract,
  type MissionContractStatus,
  type MissionEvidence,
  type MissionEvidenceKind,
  type MissionNextAction,
  type MissionProgressState,
  type MissionVerificationProbe,
  type MissionVerificationProbeStatus,
} from "./missionContract.js";

export {
  summarizeContinuity,
  type ContinuitySummary,
  type ContinuityMissionView,
  type ContinuityAdvisory,
  type SummarizeContinuityInput,
} from "./continuity.js";

export {
  assembleWorldGraph,
  ARES_SUBSYSTEMS,
  type WorldGraph,
  type WorldEntity,
  type WorldRelation,
  type WorldEntityKind,
  type WorldRelationKind,
  type WorldSubsystemInput,
  type WorldMemoryInput,
  type AssembleWorldGraphInput,
} from "./worldGraph.js";

export {
  rankBriefing,
  type DailyBriefing,
  type BriefingFocusItem,
  type BriefingDecisionItem,
  type BriefingShippedItem,
  type BriefingSuggestion,
  type RankBriefingInput,
} from "./briefing.js";

export {
  LEARNING_CARD_SCHEMA_VERSION,
  distillMissionCard,
  learningCardId,
  learningCardMemoryText,
  selectRelevantLessons,
  saveLearningCard,
  loadLearningCard,
  learningCardExists,
  listLearningCards,
  type LearningCard,
  type MissionResult,
} from "./learningCard.js";

export { autoEmitLearningCard, isContractTerminal, type AutoEmitOptions } from "./learningEmit.js";

export {
  ensureGoalMissionContract,
  goalCanCompleteFromMission,
  markGoalProbePending,
  recordGoalBlocker,
  recordGoalProbeResult,
  recordGoalStepProgress,
  type GoalMissionAttachment,
  type EnsureGoalMissionOptions,
} from "./missionExecution.js";

export {
  EVAL_REPORT_SCHEMA_VERSION,
  runEvalSuite,
  assertEvalReport,
  parseEvalReportJson,
  stableTaskId,
  type EvalContext,
  type EvalReport,
  type EvalTask,
  type EvalTaskOutcome,
  type EvalTaskResult,
  type EvalTaskStatus,
  type RunEvalSuiteOptions,
} from "./evalHarness.js";

// ── O4: the compounding capability graph ──────────────────────────────────
export {
  createCapability,
  beginLearning,
  recordOutcome,
  reliabilityOf,
  canCrystallize,
  crystallize,
  markRotted,
  markForbidden,
  isReusable,
  addMethod,
  DEFAULT_MASTERY_SUCCESSES,
  type CapabilityNode,
  type CapabilityStatus,
  type CapabilitySource,
  type CapabilityOutcomes,
  type MethodKind,
  type MethodRung,
} from "./capability.js";

export { novelDelta, reusedSubskills, factor, novelDeltaCurve } from "./graph.js";

export {
  seedNativeCapabilities,
  seedToolCapabilities,
  seedSkillCapabilities,
  seedAllCapabilities,
  NATIVE_CAPABILITY_SEEDS,
  TOOL_CAPABILITY_SEEDS,
  TOOL_CAPABILITY_MAP,
  type NativeCapabilitySeed,
  type CapabilitySeed,
  type SeedNativeCapabilitiesReport,
} from "./seed.js";

export { renderCapabilitiesDoc, writeCapabilitiesDoc } from "./ledger.js";

export {
  acquireCapability,
  listAcquisitions,
  type Acquisition,
  type AcquisitionKind,
  type AcquisitionStatus,
  type AcquisitionResult,
  type AcquireCapabilityInput,
} from "./acquisition.js";

export {
  slugify,
  saveCapability,
  loadCapability,
  listCapabilities,
  writeCrystallizedSkill,
} from "./graphStore.js";

export {
  draftCapability,
  capabilityEvidence,
  assessPromotionReadiness,
  promoteCapability,
  rejectCapabilityDraft,
  type CapabilityEvidence,
  type CapabilityEvidenceKind,
  type PromotionPolicy,
  type PromotionReadiness,
  type PromotionResult,
} from "./promotion.js";

export {
  capabilityReviewItem,
  capabilityReviewLine,
  capabilityReviewQueue,
  type CapabilityReviewItem,
  type CapabilityReviewStatus,
} from "./capabilityReview.js";

export {
  driveLearning,
  nextLearningPhase,
  type LearningPhase,
  type LearnDeps,
  type LearnAttemptResult,
  type LearnEvent,
} from "./learn.js";

// ── O5: the two ladders (method + perception) ─────────────────────────────
export {
  resolveMethod,
  acquireMethod,
  isAvailable,
  METHOD_RANK,
  type MethodEnvironment,
  type MethodResolution,
  type AcquireDeps,
  type AcquireResult,
} from "./method.js";

export { routePerception, PERCEPTION_RANK, type PerceptionRung, type PerceptionNeed } from "./perception.js";

export type {
  Goal,
  GoalStatus,
  GoalStepRecord,
  StepVerdict,
  VerificationSpec,
  Dispatcher,
  DispatchContext,
  OperatorEvent,
} from "./types.js";
export {
  runCrucibleTrials,
  checkToSpec,
  recordOf,
  type TrialAction,
  type TrialReport,
  type TrialStore,
  type TrialVerdict,
  type CrucibleTrialOptions,
} from "./crucible.js";
export {
  TrustGovernor,
  deriveLeash,
  domainOf,
  type LeashBasis,
  type LeashChange,
  type LeashAppender,
  type TrustGovernorOptions,
} from "./leash.js";
export {
  runGauntlet,
  CODING_GAUNTLET,
  CODING_GAUNTLET_V2,
  GAUNTLET_SCHEMA_VERSION,
  type GauntletTask,
  type GauntletTaskResult,
  type GauntletReport,
  type GauntletOptions,
  type GauntletProbeOutcome,
} from "./gauntlet.js";
