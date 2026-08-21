// @ares/core — runtime kernel for Ares v2.
//
// Public surface:
//   - QueryEngine: the streaming agent loop.
//   - Provider interface + reference implementations.
//
// Everything is event-driven; no direct stdout/stderr writes from this package.

export {
  QueryEngine,
  budgetMessages,
  buildContextLedger,
  recentFilePathsFromSpan,
  collectTrimmedFilePaths,
  chooseCompactionSplit,
  stringifyModelToolOutput,
  adaptiveReasoningLevel,
  guardStreamStalls,
  type QueryEngineConfig,
  type DurableQueryEngineConfig,
  type Provider,
  type ProviderRequest,
  type ProviderToolDescriptor,
  type EngineTool,
  type EngineToolEffectPolicy,
  type EngineToolResult,
  type ToolEffectReconciliationRequest,
  type ToolEffectReconciliationResult,
  type ToolEffectRetryPolicy,
  type ToolSettlementReceipt,
  type ToolCallContext,
  type ToolPermissionRequest,
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  isToolUseBlock,
} from "./queryEngine.js";

export {
  runForkedTurn,
  type ForkedTurnOptions,
  type ForkedTurnResult,
  type ForkedTurnSeed,
} from "./forkedTurn.js";

export { MockEchoProvider } from "./providers/mock.js";
export { MoaProvider, type MoaMember, type MoaProviderOptions } from "./providers/moa.js";
export { parseRetryAfterMs } from "./providers/retryAfter.js";

export {
  AnthropicProvider,
  ANTHROPIC_MESSAGES_URL,
  DEFAULT_ANTHROPIC_MODEL,
  fetchAnthropicModels,
  stripUnpairedWireToolBlocks,
  type AnthropicProviderOptions,
} from "./providers/anthropic.js";

export {
  startAnthropicLogin,
  finishAnthropicLogin,
  runAnthropicLoginFlow,
  loadAnthropicTokens,
  clearAnthropicTokens,
  resolveAnthropicAccessToken,
  type AnthropicOAuthTokens,
  type AnthropicAuthChallenge,
} from "./providers/anthropicAuth.js";

export {
  runKimiLoginFlow,
  requestKimiDeviceAuthorization,
  pollKimiDeviceToken,
  refreshKimiTokens,
  forceRefreshKimiAccessToken,
  resolveKimiTokens,
  resolveKimiAccessToken,
  loadKimiTokens,
  saveKimiTokens,
  kimiAuthStatus,
  kimiAuthFilePath,
  kimiLogout,
  fetchKimiModels,
  KIMI_CODING_BASE_URL,
  type KimiModel,
  type KimiTokens,
  type KimiAuthStatus,
  type KimiDeviceAuthorization,
  type KimiLoginOptions,
} from "./providers/kimiAuth.js";

export {
  sideQuery,
  sideQueryJson,
  extractFirstJson,
  type SideQueryOptions,
  type SideQueryJsonOptions,
} from "./sideQuery.js";

export {
  runFleet,
  resolveTemplates,
  validateSpec,
  MAX_AGENTS_PER_PHASE,
  MAX_AGENTS_PER_FLEET,
  MAX_CONCURRENCY,
  FORBIDDEN_CHILD_TOOLS,
  type FleetSpec,
  type FleetPhaseSpec,
  type FleetAgentSpec,
  type FleetPersonaDef,
  type FleetReduce,
  type FleetResult,
  type PhaseResult,
  type LeafResult,
  type ConductorDeps,
  type LeafValidator,
  type SchemaHinter,
  type ValidatorResult,
  type RunAgentFn,
  type RunAgentArgs,
  type RunAgentResult,
  type Worktree,
} from "./conductor.js";

export {
  SubagentRegistry,
  AresSubagentRunner,
  BUILT_IN_SUBAGENT_TYPES,
  SUBAGENT_SESSION_TRANSITION_TOOLS,
  scopeSubagentTools,
  type SubagentRunner,
  type SubagentRunnerOptions,
  type SubagentTypeDef,
  type SubagentRunRequest,
  type SubagentRunResult,
  type BackgroundSubagentStart,
  type BackgroundSubagentSnapshot,
} from "./subagents.js";

export {
  SubagentJournal,
  renderSubagentHandoff,
  type SubagentHandoff,
  type SubagentJournalEntry,
} from "./subagentJournal.js";

export {
  FrictionRecorder,
  summarizeFriction,
  telemetryDir,
  type FrictionTurn,
  type FrictionSummary,
  type FrictionSource,
  type FrictionDiagnostic,
  type FrictionSessionLocation,
  type FrictionRecorderOptions,
} from "./frictionLog.js";

export {
  ContinuousVerifier,
  deriveNarrowVerify,
  deriveScopedVerify,
  findRelatedTestFiles,
  triageVerifyOutput,
  type VerifierOptions,
  type VerifyCommand,
  type VerifyResult,
  type VerifyEvent,
  type WorkspaceSetup,
  type CommandRunner,
  type VerifyCacheStats,
  type VerificationEvidenceSnapshot,
} from "./verifier.js";

export {
  createVerifiedChildSession,
  confirmChildTurnEnd,
  loadChildVerificationDebt,
  type ChildVerificationDebt,
  type VerifiedChildSession,
  type VerifiedChildSessionOptions,
} from "./childSessionVerifier.js";

export {
  CHILD_SESSION_COMPOSITION_PROFILES,
  composeVerifiedChildSession,
  composeVerifiedChildSessionSync,
  withComposedVerifiedChildSession,
  type ChildSessionSurface,
  type ChildSessionCleanupPolicy,
  type ChildSessionCompositionOptions,
  type ChildSessionCompositionReceipt,
  type ComposedVerifiedChildSession,
} from "./childSessionComposition.js";

export {
  buildRepositoryMap,
  renderRepositoryMap,
  repositoryMapReminder,
  type RepositoryMap,
  type RepositoryPackageMap,
  type RepositoryMapOptions,
} from "./repoCartography.js";

export {
  CodingJournal,
  normalizeFailure,
  failureDigest,
  type CodingJournalOptions,
  type CodingJournalState,
  type CodingPhase,
  type CodingCheckRecord,
  type CodingFailureRecord,
} from "./codingJournal.js";

export {
  registerSessionLocation,
  listRegisteredSessionLocations,
  readSessionLocation,
  writeSessionLocationAtomic,
  sessionLocationRegistryDir,
  sessionLocationFile,
  hashWorkspaceIdentity,
  type SessionLocation,
  type SessionLocationRecord,
  type SessionLocationSource,
  type SessionRolloutFormat,
  type RegisterSessionLocationInput,
  type SessionRegistryOptions,
} from "./sessionRegistry.js";

export {
  runReliabilityTriage,
  listReliabilityFindings,
  loadReliabilityFinding,
  resolveReliabilitySource,
  updateReliabilityFindingStatus,
  reliabilityTriagePaths,
  type ReliabilityFindingStatus,
  type ReliabilitySeverity,
  type ReliabilityCategory,
  type ReliabilitySignalKind,
  type ReliabilityEvidence,
  type ReliabilityFinding,
  type ReliabilityTriageHealth,
  type ReliabilityTriageCoverage,
  type ReliabilityTriageRun,
  type ReliabilityTriageOptions,
  type ReliabilityTriagePaths,
} from "./reliabilityTriage.js";

export {
  HookManager,
  type HookConfigEntry,
  type HookEvent,
  type HookInvocation,
  type HookInvocationResult,
  type HookRunInput,
  type HookRunResult,
} from "./hooks.js";

export {
  generatePkce,
  discoverMcpAuth,
  registerMcpClient,
  buildMcpAuthorizeUrl,
  exchangeMcpCode,
  refreshMcpToken,
  type McpAuthServer,
  type McpClientRegistration,
  type McpTokenResponse,
} from "./mcpOAuth.js";

export {
  connectMcpServer,
  disconnectMcpServer,
  setMcpServerEnabled,
  setMcpServerToken,
  probeMcpTools,
  getMcpAccessToken,
  getMcpCallCredentials,
  loadRemoteMcpServers,
  connectorNameFromUrl,
  type RemoteMcpEntry,
  type ConnectMcpOptions,
  type ConnectMcpResult,
  type SetMcpTokenResult,
  type McpProbeResult,
} from "./mcpConnect.js";

export {
  Session,
  SessionNotFoundError,
  DEFAULT_SESSION_LEASE_TTL_MS,
  MIN_SESSION_LEASE_TTL_MS,
  MAX_SESSION_LEASE_TTL_MS,
  MIN_SESSION_LEASE_HEARTBEAT_MS,
  MAX_SESSION_LEASE_HEARTBEAT_MS,
  resolveSessionLeaseTiming,
  listSessions,
  loadSessionSnapshot,
  projectMessagesFromKernel,
  loadSessionRollout,
  deleteSession,
  renameSession,
  type SessionOptions,
  type SessionLeaseTiming,
  type SessionSummary,
  type SessionSnapshot,
  type SessionRollout,
  type LoadSessionSnapshotOptions,
} from "./session.js";

export {
  planArtifactPath,
  planArtifactRelativePath,
  renderApprovedPlanBuildHandoff,
  renderPlanArtifact,
  writePlanArtifact,
} from "./planArtifact.js";

export {
  createWorkspaceCheckpoint,
  listWorkspaceCheckpoints,
  loadWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  diffWorkspaceCheckpointUnified,
  restoreWorkspaceCheckpoint,
  isUnsnapshotableWorkspace,
  type CreateCheckpointOptions,
} from "./checkpoints.js";

export {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
} from "./providers/openaiResponses.js";

export {
  loadAuthToken,
  authStatus,
  authFilePath,
  aresHome,
  deviceCodeLogin,
  runOpenAILoginFlow,
  refreshOpenAIToken,
  fetchCodexModels,
  type CodexModel,
  type AuthToken,
  type AuthStatus,
  type AuthMode,
  type AuthSource,
  type DeviceCodeChallenge,
  type DeviceCodeLoginOptions,
  type OpenAILoginOptions,
} from "./providers/openaiAuth.js";

export {
  OllamaCloudPool,
  DEFAULT_OLLAMA_SLOTS,
  OLLAMA_CLOUD_MODELS,
  ollamaCloudModelsFor,
  fetchOllamaLibraryModels,
  type SlotName,
  type SlotConfig,
  type OllamaCloudPoolOptions,
  type OllamaCloudModel,
  type OllamaLibraryModel,
} from "./providers/ollamaCloud.js";

export {
  DeepSeekProvider,
  OpenRouterProvider,
  fetchDeepSeekModels,
  fetchOpenRouterModels,
  DEEPSEEK_BASE_URL,
  OPENROUTER_BASE_URL,
  type DeepSeekProviderOptions,
  type DeepSeekModel,
  type OpenRouterProviderOptions,
  type OpenRouterModel,
} from "./providers/openrouter.js";

export { narrowToolSchema } from "./providers/toolSchema.js";

export { buildPromptCacheKey, type PromptCacheKey } from "./promptCache.js";

export {
  getCredential,
  setCredential,
  deleteCredential,
  listCredentialNames,
  hasCredential,
  encryptSecret,
  decryptSecret,
  probeCredentialEncryption,
  EncryptionUnavailableError,
  type CredentialLookup,
} from "./credentials.js";

export {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshTokens,
  getValidAccessToken,
  storeTokens,
  loadTokens,
  isExpired,
  clientIdName,
  clientSecretName,
  type OAuthProviderConfig,
  type OAuthTokens,
  type OAuthDeps,
} from "./oauth.js";

export {
  OAUTH_PROVIDERS,
  PROVIDER_LABELS,
  getProviderConfig,
  listProviders,
} from "./oauthProviders.js";

export {
  startOAuthFlow,
  connectedProviders,
  type OAuthFlowOptions,
} from "./oauthCallback.js";

export {
  runAresAccountSignin,
  buildAresAuthorizeUrl,
  exchangeAresCode,
  probeAresOauth,
  captureLoopbackCode,
  normalizeGatewayBase,
  type AresSigninOptions,
} from "./aresAccountAuth.js";

export {
  routeModel,
  resolveRoute,
  laneForTask,
  classifyLane,
  taskDefaults,
  ROUTE_LANES,
  DEFAULT_PROVIDER_PROFILES,
  type RouteLane,
  type RouteAssignment,
  type RouteAssignments,
  type ResolvedRoute,
  type ModelTask,
  type ModelTaskKind,
  type ModelRoute,
  type ModelRouteDecision,
  type ModelRoutingPolicy,
  type ModelProviderProfile,
  type ModelCapability,
  type RiskLevel,
  type PrivacyPosture,
  type QualityNeed,
  type CostPreference,
  type LatencyPreference,
  type Locality,
  type ModelTouch,
} from "./modelRouter.js";

export {
  loadStartupReminders,
  loadMemoryReminders,
  loadInstructionReminders,
  type StartupReminder,
  type StartupReminderSource,
} from "./startupContext.js";

export {
  RepositoryInstructionResolver,
  REPOSITORY_INSTRUCTION_FILES,
  MAX_REPOSITORY_INSTRUCTION_CHARS,
  renderRepositoryInstructions,
  repositoryInstructionClaimsFromMessages,
  isRepositoryInstructionClaim,
  type RepositoryInstructionContext,
  type RepositoryInstructionClaim,
  type ResolvedRepositoryInstruction,
} from "./repositoryInstructions.js";

export {
  crashDir,
  writeCrashLogSync,
  installGlobalCrashHandlers,
  EventRing,
  type CrashKind,
  type CrashRecord,
  type CrashHandlerOptions,
} from "./crashLog.js";

export {
  HeapGuard,
  readHeapSample,
  type HeapPressure,
  type HeapSample,
  type HeapVerdict,
  type HeapGuardOptions,
} from "./memoryGuard.js";

export {
  parsePatch,
  parsePatchText,
  PatchParseError,
  type Hunk,
  type UpdateFileChunk,
  type ApplyPatchArgs,
  type ParseMode,
  BEGIN_PATCH_MARKER,
  END_PATCH_MARKER,
  ADD_FILE_MARKER,
  DELETE_FILE_MARKER,
  UPDATE_FILE_MARKER,
  MOVE_TO_MARKER,
  EOF_MARKER,
  CHANGE_CONTEXT_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
} from "./applyPatch/parser.js";

export {
  WorkspaceMutationService,
  WorkspaceMutationError,
  applyWorkspaceMutation,
  rollbackWorkspaceMutation,
  reconcileWorkspaceMutation,
  workspaceContentHash,
  type WorkspaceMutationOperation,
  type WorkspaceMutationOptions,
  type WorkspaceMutationReceiptOperation,
  type WorkspaceMutationReceipt,
  type WorkspaceMutationReconciliation,
  type WorkspaceMutationErrorCode,
  type ReconciledPathState,
} from "./workspaceMutation.js";

export {
  PostMutationFeedbackService,
  committedFilesFromReceipt,
  inspectPostMutationFeedback,
  renderPostMutationFeedback,
  type PostMutationCommittedFile,
  type PostMutationFeedback,
  type PostMutationFeedbackFile,
  type PostMutationFeedbackCheck,
  type PostMutationFeedbackKind,
  type PostMutationFeedbackCheckStatus,
  type PostMutationFeedbackOptions,
} from "./postMutationFeedback.js";

export * from "./sessionKernel/index.js";
