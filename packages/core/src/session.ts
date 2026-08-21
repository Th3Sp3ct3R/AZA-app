// Session — wraps QueryEngine with persistence and lifecycle.
//
// One Session per conversation. Each turn:
//   1. session.send(text) returns AsyncGenerator<TurnEvent>
//   2. Every event is appended to <workspace>/.ares/sessions/<id>/events.jsonl
//   3. Caller (CLI or TUI) consumes the same stream for display
//
// Full DAG fork/diff/rollback come in M4; M1 provides linear rollout.

import { mkdir, appendFile, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  messageText,
  type ContentBlock,
  type TurnEvent,
  type SessionMeta,
  type RolloutEntry,
  type ProviderInfo,
  type Message,
  type ToolResultBlock,
  type Todo,
  type WorkStatus,
} from "@ares/protocol";
import {
  QueryEngine,
  stringifyModelToolOutput,
  type ClaimedSteeringMessage,
  type EngineTool,
  type Provider,
  type QueryEngineConfig,
  type ToolSettlementReceipt,
} from "./queryEngine.js";
import type { ToolPermissionRequest } from "./queryEngine.js";
import type { PermissionPromptDecision, ReasoningLevel, Usage } from "@ares/protocol";
import type { HookManager } from "./hooks.js";
import { createWorkspaceCheckpoint, diffWorkspaceCheckpointUnified, isUnsnapshotableWorkspace } from "./checkpoints.js";
import { FrictionRecorder } from "./frictionLog.js";
import { WorkspaceMutationService } from "./workspaceMutation.js";
import { planArtifactRelativePath, renderApprovedPlanBuildHandoff, writePlanArtifact } from "./planArtifact.js";
import { PlanConflictError, StaleGenerationError } from "./sessionKernel/errors.js";
import { RunLeaseCoordinator, type CoordinatedRunLease } from "./sessionKernel/coordinator.js";
import { openWorkspaceSessionKernel, workspaceSessionKernelPath } from "./sessionKernel/workspace.js";
import type { AdmittedInputRecord, ExecutionState, JsonValue, MessageRecord, PlanRevisionRecord, RunFence, SessionKernelStore, SessionRecord, WorkOutcome } from "./sessionKernel/index.js";
import {
  RepositoryInstructionResolver,
  repositoryInstructionClaimsFromMessages,
  isRepositoryInstructionClaim,
  type RepositoryInstructionContext,
  type RepositoryInstructionClaim,
} from "./repositoryInstructions.js";

type ReminderSource =
  | "verifier"
  | "compaction"
  | "hook"
  | "skill"
  | "memory"
  | "instructions"
  | "undo"
  | "heartbeat"
  | "dream"
  | "recall"
  | "self-revise";

function isOpaqueMutationTool(name: string | undefined): boolean {
  return name === "Bash" || name === "PowerShell" || name === "CodeMode" || name === "Task" ||
    name === "Conductor" || name === "PostToolUseHook";
}

function isAttachedControlInput(input: AdmittedInputRecord): boolean {
  const payload = input.payload;
  return input.delivery === "steer" &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload.kind === "approved-plan-build-handoff" || payload.kind === "background-job-completion");
}

function isTransactionalMutationTool(name: string): boolean {
  return name === "Write" || name === "Edit" || name === "ApplyPatch" ||
    name === "ApplyIntent" || name === "FindAndEdit" || name === "CodeMode";
}

function externalReconciliationTimeoutMs(): number {
  const configured = Number(process.env.ARES_EFFECT_RECONCILE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 100
    ? Math.min(Math.trunc(configured), 5 * 60_000)
    : 30_000;
}

function toolUseIdFromCallKey(callKey: string): string {
  const separator = callKey.indexOf(":");
  return separator >= 0 ? callKey.slice(separator + 1) : callKey;
}

/** Task is conservatively declared workspace-write because general-purpose
 * children can edit. Its two built-in investigation roles are read-only by
 * contract and remain available while the canonical session is planning. */
function isPlanSafeDelegation(toolName: string, input: unknown): boolean {
  if (toolName === "UpdatePlanDraft") return true;
  if (toolName === "WebFetch" || toolName === "WebSearch" || toolName === "ImageSearch") return true;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const fields = input as Record<string, unknown>;
  if (toolName === "Task") {
    return fields.subagent_type === "researcher" || fields.subagent_type === "code-reviewer";
  }
  if (toolName === "Browser") {
    return new Set([
      "open",
      "handshake",
      "tabs",
      "attach",
      "preview",
      "tree",
      "screenshot",
      "console",
      "state",
      "filmstrip",
    ]).has(String(fields.action ?? ""));
  }
  return false;
}

export const DEFAULT_SESSION_LEASE_TTL_MS = 30_000;
export const MIN_SESSION_LEASE_TTL_MS = 250;
export const MAX_SESSION_LEASE_TTL_MS = 5 * 60_000;
export const MIN_SESSION_LEASE_HEARTBEAT_MS = 50;
export const MAX_SESSION_LEASE_HEARTBEAT_MS = 60_000;

export interface SessionLeaseTiming {
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
}

/** Normalize owner/env timing without allowing a typo to disable expiry or put
 * the heartbeat at the lease boundary. At least two heartbeat opportunities fit
 * inside every lease; the default is 10s heartbeats on a 30s recovery window. */
export function resolveSessionLeaseTiming(
  input: Partial<SessionLeaseTiming> = {},
): SessionLeaseTiming {
  const leaseTtlMs = boundedLeaseMilliseconds(
    input.leaseTtlMs,
    DEFAULT_SESSION_LEASE_TTL_MS,
    MIN_SESSION_LEASE_TTL_MS,
    MAX_SESSION_LEASE_TTL_MS,
  );
  const defaultHeartbeat = Math.max(
    MIN_SESSION_LEASE_HEARTBEAT_MS,
    Math.min(10_000, Math.floor(leaseTtlMs / 3)),
  );
  const maxHeartbeat = Math.max(
    MIN_SESSION_LEASE_HEARTBEAT_MS,
    Math.min(MAX_SESSION_LEASE_HEARTBEAT_MS, Math.floor(leaseTtlMs / 3)),
  );
  return {
    leaseTtlMs,
    heartbeatIntervalMs: boundedLeaseMilliseconds(
      input.heartbeatIntervalMs,
      defaultHeartbeat,
      MIN_SESSION_LEASE_HEARTBEAT_MS,
      maxHeartbeat,
    ),
  };
}

function boundedLeaseMilliseconds(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function environmentMilliseconds(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface SessionOptions {
  workspace: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: readonly EngineTool[];
  signal?: AbortSignal;
  /** Optional pre-set sessionId (for resume). Defaults to a fresh id. */
  sessionId?: string;
  sessionMeta?: SessionMeta;
  initialMessages?: readonly Message[];
  /** Last TodoWrite snapshot restored independently of lossy message replay. */
  initialTodos?: readonly Todo[];
  initialSeq?: number;
  /** Pending system-reminders to inject at next turn_start. */
  drainSystemReminders?: () => Array<{
    text: string;
    source: ReminderSource;
    instructionClaims?: RepositoryInstructionClaim[];
  }>;
  /** C1 end-of-turn gate — see QueryEngineConfig.confirmTurnEnd. */
  confirmTurnEnd?: () => Promise<Array<{ text: string; source: "verifier" | "hook" }>>;
  requireVerificationEvidence?: boolean;
  verificationEvidence?: QueryEngineConfig["verificationEvidence"];
  outstandingVerificationRequired?: QueryEngineConfig["outstandingVerificationRequired"];
  persistedVerificationDebt?: QueryEngineConfig["persistedVerificationDebt"];
  persistedVerificationScopeComplete?: QueryEngineConfig["persistedVerificationScopeComplete"];
  observedMutationAt?: QueryEngineConfig["observedMutationAt"];
  specDocs?: QueryEngineConfig["specDocs"];
  /** Failure-signature recall — see QueryEngineConfig.recallFailureFix. */
  recallFailureFix?: (input: { tool: string; signature: string; error: string }) => Promise<string | null>;
  hookManager?: HookManager;
  requestPermission?: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision>;
  /** Child/fork policy: a denied capability is an ordinary tool error when
   * false, allowing the model to route around it. */
  permissionDenialInterrupts?: boolean;
  /**
   * Absolute paths the engine treats as "self-territory" — writes inside
   * these roots bypass the write-intent gate. Used to give the agent
   * unrestricted authority over its own brain (~/.ares/).
   */
  selfTerritoryRoots?: readonly string[];
  /** Reasoning dial for reasoning-capable models (owner-selectable, low→max). */
  reasoningLevel?: ReasoningLevel;
  /** Output-token cap per provider call. */
  maxOutputTokens?: number;
  /** Trim oldest history to keep estimated input under this many tokens. */
  contextBudgetTokens?: number;
  /** Explicit hard ceiling on tool-calling turns. Unset = effectively
   *  unbounded (huge backstop); loop-kill detectors terminate stuck turns. */
  maxTurns?: number;
  /** Session-owned read-before-write evidence. A fresh map is created when the
   * host does not supply one, so sibling/child sessions can never authorize an
   * edit using bytes read by another conversation. */
  fileReadStamps?: NonNullable<QueryEngineConfig["fileReadStamps"]>;
  /** See QueryEngineConfig.onHistoryTrimmed — read-stamp invalidation on trim. */
  onHistoryTrimmed?: (dropped: readonly Message[]) => void;
  /** See QueryEngineConfig.environmentArtifactSignals — supplied by the host's
   * live, extensible environment-provider registry. */
  environmentArtifactSignals?: QueryEngineConfig["environmentArtifactSignals"];
  /** See QueryEngineConfig.summarizeSpan — smart compaction summarizer. */
  summarizeSpan?: QueryEngineConfig["summarizeSpan"];
  /** See QueryEngineConfig.compactionThresholdTokens. */
  compactionThresholdTokens?: number;
  /** Hash/version manifest for every host-composed context source. Captured in
   * each durable compaction epoch so restart can distinguish a faithful replay
   * from a prompt/persona/tool/memory/journal drift. Values must be compact. */
  contextSourceVersions?: () => Readonly<Record<string, JsonValue>>;
  /** Explicit friction directory for isolated tests/portable runtimes. */
  telemetryDir?: string;
  /** Explicit global home for the session-location registry. */
  sessionRegistryHome?: string;
  /** Canonical transactional store. JSONL remains a human-readable audit log,
   * but admission, leases, messages, tool effects, plans, and context epochs
   * are fenced through this SQLite authority. */
  sessionKernel?: SessionKernelStore;
  /** Durable runner lease expiry. Defaults to ARES_SESSION_LEASE_TTL_MS or 30s;
   * clamped to 250ms..5min. A crashed process can be replaced after this window. */
  sessionLeaseTtlMs?: number;
  /** Lease renewal cadence. Defaults to ARES_SESSION_LEASE_HEARTBEAT_MS or one
   * third of TTL; clamped to 50ms..min(60s, TTL/3). */
  sessionLeaseHeartbeatMs?: number;
  /** Run pre-existing durable inputs from a detached constructor task. This is
   * enabled by default for standalone Session hosts. Evented hosts such as the
   * desktop daemon disable it and recover through their ordinary visible send
   * pipeline after transport observers are ready. */
  detachedStartupRecovery?: boolean;
}

export class Session {
  readonly meta: SessionMeta;
  /** Friction telemetry — one JSONL line per turn under ~/.ares/telemetry. */
  private readonly friction: FrictionRecorder;
  readonly engine: QueryEngine;
  private seq = 0;
  /** Serializes rollout appends off the hot path; ordered, never interleaved. */
  private ioChain: Promise<void> = Promise.resolve();
  private readonly eventsPath: string;
  private readonly metaPath: string;
  private metaWritten = false;
  private lastCheckpointId: string | undefined;
  private ioError: Error | null = null;
  private readonly eventObservers = new Set<(event: TurnEvent) => void>();
  /**
   * The Session, not a UI flag, owns execution. Every send/resume acquires this
   * FIFO lease before touching QueryEngine state. This remains held until the
   * underlying generator really ends, so a frontend timeout can never create
   * overlapping turns in the same session.
   */
  private runTail: Promise<void> = Promise.resolve();
  private readonly kernel?: SessionKernelStore;
  private readonly kernelLeaseTtlMs: number;
  private readonly kernelLeaseHeartbeatMs: number;
  private readonly kernelLeaseCoordinator?: RunLeaseCoordinator;
  private baseSystemPrompt: string;
  private mirroredPlanKey: string | null = null;
  private kernelFence: RunFence | null = null;
  private kernelLease: CoordinatedRunLease | null = null;
  private readonly kernelToolRuns = new Map<string, string>();
  /** Durable identity of the request currently owning provider/tool execution.
   * Stop is bound to this id (and, for kernel runs, its generation fence). */
  private activeInputId: string | null = null;
  /** Exact input ids cancelled before admission/provider arming. Unlike the old
   * engine-wide pending bit, these requests can never affect a later input. */
  private readonly pendingInputCancellations = new Set<string>();
  private startupRecoveryPromise: Promise<void> = Promise.resolve();
  private startupRecoveryError: unknown;
  /** Work truth from the most recent turn, used by post-turn learning. */
  lastWorkStatus: WorkStatus = "not_applicable";

  constructor(private readonly opts: SessionOptions) {
    const sessionId = opts.sessionMeta?.id ?? opts.sessionId ?? `sess_${randomUUID()}`;
    const providerInfo: ProviderInfo = { name: opts.provider.name, model: opts.model };
    this.meta = opts.sessionMeta ?? {
      id: sessionId,
      workspace: opts.workspace,
      provider: providerInfo,
      createdAt: new Date().toISOString(),
    };
    this.baseSystemPrompt = opts.systemPrompt;
    this.kernel = opts.sessionKernel;
    const leaseTiming = resolveSessionLeaseTiming({
      leaseTtlMs: opts.sessionLeaseTtlMs ?? environmentMilliseconds("ARES_SESSION_LEASE_TTL_MS"),
      heartbeatIntervalMs:
        opts.sessionLeaseHeartbeatMs ?? environmentMilliseconds("ARES_SESSION_LEASE_HEARTBEAT_MS"),
    });
    this.kernelLeaseTtlMs = leaseTiming.leaseTtlMs;
    this.kernelLeaseHeartbeatMs = leaseTiming.heartbeatIntervalMs;
    this.kernelLeaseCoordinator = this.kernel
      ? new RunLeaseCoordinator({
          store: this.kernel,
          ownerId: `session_runner_${process.pid}_${randomUUID()}`,
          leaseTtlMs: this.kernelLeaseTtlMs,
          heartbeatIntervalMs: this.kernelLeaseHeartbeatMs,
          retryIntervalMs: Math.max(10, Math.min(75, this.kernelLeaseHeartbeatMs)),
        })
      : undefined;
    if (this.kernel) {
      const existing = this.kernel.getSession(sessionId);
      if (!existing) {
        this.kernel.createSession({
          id: sessionId,
          workspaceKey: path.resolve(opts.workspace),
          title: this.meta.label ?? null,
          metadata: {
            provider: providerInfo.name,
            model: providerInfo.model,
            createdAt: this.meta.createdAt,
          },
        });
      } else {
        const metadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
          ? existing.metadata as Record<string, JsonValue>
          : {};
        this.kernel.mergeSessionMetadata(sessionId, {
          provider: providerInfo.name,
          model: providerInfo.model,
          createdAt: typeof metadata.createdAt === "string" ? metadata.createdAt : this.meta.createdAt,
        });
      }
      const durableSession = this.kernel.getSession(sessionId);
      const durablePlan = this.kernel.getActivePlan(sessionId);
      if (
        durableSession?.workflowMode === "build" &&
        durablePlan &&
        (durablePlan.status === "approved" || durablePlan.status === "executing")
      ) {
        // Upgrade/restart reconciliation: older approved sessions may predate
        // the synthetic handoff. The deterministic admission is idempotent and
        // commits before the first provider call in this process.
        this.approvePlanRevisionForBuild(durablePlan, "session-recovery");
      }
    }
    const repositoryInstructionResolver = new RepositoryInstructionResolver(opts.workspace);
    const durableMetadata = this.kernel?.getSession(sessionId)?.metadata;
    const durableInstructionClaims =
      durableMetadata && typeof durableMetadata === "object" && !Array.isArray(durableMetadata)
        ? (durableMetadata as Record<string, JsonValue>).repositoryInstructionClaims
        : undefined;
    if (Array.isArray(durableInstructionClaims)) {
      const restoredClaims: RepositoryInstructionClaim[] = [];
      for (const value of durableInstructionClaims) {
        if (!isRepositoryInstructionClaim(value)) continue;
        restoredClaims.push({ path: value.path, contentHash: value.contentHash });
      }
      repositoryInstructionResolver.claim(restoredClaims);
    }
    repositoryInstructionResolver.claim(
      repositoryInstructionClaimsFromMessages(opts.initialMessages),
    );
    const persistRepositoryInstructionClaims = () => {
      this.kernel?.mergeSessionMetadata(sessionId, {
        repositoryInstructionClaims: repositoryInstructionResolver.claims().map((claim) => ({
          path: claim.path,
          contentHash: claim.contentHash,
        })),
      });
    };
    const repositoryClaimFingerprint = () =>
      JSON.stringify(repositoryInstructionResolver.claims());
    const repositoryInstructions: RepositoryInstructionContext = {
      resolve: async (targetPath) => {
        const before = repositoryClaimFingerprint();
        const result = await repositoryInstructionResolver.resolve(targetPath);
        if (repositoryClaimFingerprint() !== before) {
          persistRepositoryInstructionClaims();
        }
        return result;
      },
      claim: (claims) => {
        const before = repositoryClaimFingerprint();
        repositoryInstructionResolver.claim(claims);
        if (repositoryClaimFingerprint() !== before) {
          persistRepositoryInstructionClaims();
        }
      },
      claims: () => repositoryInstructionResolver.claims(),
      active: async () => {
        const before = repositoryClaimFingerprint();
        const active = await repositoryInstructionResolver.active();
        if (repositoryClaimFingerprint() !== before) persistRepositoryInstructionClaims();
        return active;
      },
    };
    const sessionDir = path.join(opts.workspace, ".ares", "sessions", sessionId);
    this.eventsPath = path.join(sessionDir, "events.jsonl");
    this.metaPath = path.join(sessionDir, "meta.json");
    this.friction = new FrictionRecorder(sessionId, {
      dir: opts.telemetryDir,
      source: "core",
      workspace: opts.workspace,
      provider: providerInfo.name,
      model: providerInfo.model,
      location: {
        registryHome: opts.sessionRegistryHome,
        rolloutPath: this.eventsPath,
        metaPath: this.metaPath,
        format: "core-rollout-v1",
      },
    });
    this.engine = QueryEngine.hosted(
      {
        provider: opts.provider,
        model: opts.model,
        systemPrompt: this.systemPromptWithActiveBuildPlan(opts.systemPrompt),
        tools: opts.tools,
        workspace: opts.workspace,
        signal: opts.signal,
        drainSystemReminders: opts.drainSystemReminders,
        claimSteeringMessages: async () => this.claimKernelSteeringMessages(),
        consumeSteeringInputs: async (inputIds) => this.consumeKernelSteeringInputs(inputIds),
        confirmTurnEnd: opts.confirmTurnEnd,
        requireVerificationEvidence: opts.requireVerificationEvidence,
        verificationEvidence: opts.verificationEvidence,
        outstandingVerificationRequired: opts.outstandingVerificationRequired,
        persistedVerificationDebt: opts.persistedVerificationDebt,
        persistedVerificationScopeComplete: opts.persistedVerificationScopeComplete,
        observedMutationAt: opts.observedMutationAt,
        specDocs: opts.specDocs,
        recallFailureFix: opts.recallFailureFix,
        hookManager: opts.hookManager,
        requestPermission: opts.requestPermission,
        permissionDenialInterrupts: opts.permissionDenialInterrupts,
        selfTerritoryRoots: opts.selfTerritoryRoots,
        reasoningLevel: opts.reasoningLevel,
        maxOutputTokens: opts.maxOutputTokens,
        contextBudgetTokens: opts.contextBudgetTokens,
        maxTurns: opts.maxTurns,
        fileReadStamps: opts.fileReadStamps ?? new Map(),
        repositoryInstructions,
        workflowMode: () => this.kernel?.getSession(sessionId)?.workflowMode ?? "build",
        environmentArtifactSignals: opts.environmentArtifactSignals,
        onHistoryTrimmed: opts.onHistoryTrimmed,
        summarizeSpan: opts.summarizeSpan,
        compactionThresholdTokens: opts.compactionThresholdTokens,
        includeCompactionProjectionInEvents: !this.kernel,
        beforeToolUseCheckpoint: async ({ toolUseId, toolName, targetFiles }) => {
          // A home-directory (or root) workspace is unsnapshotable: hashing the
          // user's entire digital life per Write is minutes of dead time and a
          // restore hazard. Tools still run; undo is unavailable there.
          if (isUnsnapshotableWorkspace(this.opts.workspace)) return null;
          const checkpoint = await createWorkspaceCheckpoint({
            workspace: this.opts.workspace,
            sessionId: this.meta.id,
            turnSeq: this.seq,
            parentCheckpointId: this.lastCheckpointId,
            label: `before ${toolName} ${toolUseId}`,
            // Declared-target tools (Edit/Write) snapshot incrementally — the
            // full-workspace walk only runs for shells/unknowable side effects.
            targetFiles,
          });
          this.lastCheckpointId = checkpoint.id;
          return { checkpointId: checkpoint.id, label: checkpoint.label };
        },
        beforeToolExecution: async (request) => this.beginKernelTool(request),
        afterToolExecution: async (result) => this.settleKernelTool(result),
      },
      sessionId,
    );
    if (opts.initialMessages) this.engine.hydrate(opts.initialMessages);
    if (opts.initialTodos) this.engine.hydrateTodos(opts.initialTodos);
    if (opts.initialSeq) this.seq = opts.initialSeq;
    if (opts.sessionMeta) this.metaWritten = true;
    if (opts.detachedStartupRecovery !== false) this.scheduleStartupOrphanDrain();
  }

  /** Change the reasoning dial mid-session — applies to the next turn. */
  setReasoningLevel(level: ReasoningLevel): void {
    this.engine.setReasoningLevel(level);
  }

  setMaxTurns(maxTurns: number | undefined): void {
    this.engine.setMaxTurns(maxTurns);
  }

  /** Swap the system prompt in place, keeping all message history — how a
   *  persona is adopted or dropped mid-conversation. Applies to the next turn. */
  setSystemPrompt(systemPrompt: string): void {
    this.baseSystemPrompt = systemPrompt;
    this.engine.setSystemPrompt(this.systemPromptWithActiveBuildPlan(systemPrompt));
  }

  /**
   * `ownerIntent` marks a transition the owner asked for directly (the desktop
   * mode toggle, `/code`, `/plan`) as opposed to one the model drove.
   *
   * The guard below exists to stop the *model* from talking its way out of plan
   * mode without approval, but it was also rejecting the owner's own click: a
   * draft plan the model started and never proposed cannot be approved by
   * `approvePendingPlan`, so the throw left the session stuck in plan mode with
   * no way out. An owner transition supersedes that un-approved draft instead —
   * the plan is discarded, never approved, so no write authority is smuggled in.
   */
  setWorkflowMode(mode: "plan" | "build", opts: { ownerIntent?: boolean } = {}): void {
    if (this.kernel && mode === "build") {
      const plan = this.kernel.getActivePlan(this.meta.id);
      if (plan?.status === "draft" || plan?.status === "awaiting_approval") {
        if (!opts.ownerIntent) {
          throw new PlanConflictError("Cannot enter build mode without exact approval of the active plan", {
            sessionId: this.meta.id,
            planRevisionId: plan.id,
            planHash: plan.planHash,
            status: plan.status,
          });
        }
        this.kernel.supersedeActivePlan(this.meta.id, "owner-workflow-toggle");
      }
    }
    this.kernel?.setWorkflowMode(this.meta.id, mode);
    this.engine.setSystemPrompt(this.systemPromptWithActiveBuildPlan(this.baseSystemPrompt));
  }

  /** Subscribe below every UI surface so durable state and verification taps
   * cannot be forgotten by one chat/daemon consumer. Returns an unsubscribe. */
  observeEvents(observer: (event: TurnEvent) => void): () => void {
    this.eventObservers.add(observer);
    return () => this.eventObservers.delete(observer);
  }

  /** Swap provider/model in place and persist the new session metadata. */
  async setProvider(
    provider: Provider,
    model: string,
    context?: Pick<SessionOptions, "contextBudgetTokens" | "compactionThresholdTokens" | "summarizeSpan">,
  ): Promise<void> {
    this.engine.setProvider(provider, model, context);
    this.kernel?.mergeSessionMetadata(this.meta.id, {
      provider: provider.name,
      model,
    });
    this.meta.provider = { name: provider.name, model };
    this.friction.updateContext({ provider: provider.name, model });
    await this.ensureSessionDir();
    await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2) + "\n", "utf8");
  }

  /** Persist provider work performed outside the main QueryEngine loop. */
  async recordAuxiliaryUsage(
    kind: "compaction" | "witness" | "memory" | "other",
    provider: string,
    model: string,
    usage: Usage,
  ): Promise<void> {
    await this.ensureSessionDir();
    this.persistEvent({
      type: "auxiliary_usage",
      kind,
      provider,
      model,
      usage: { ...usage, modelCalls: usage.modelCalls ?? 1 },
    });
    await this.flush();
  }

  /** Stop exactly one in-flight/admitted request. Returns true only when a live
   * or not-yet-admitted input accepted cancellation. Idle and duplicate Stop
   * calls are no-ops and can never poison the next turn. */
  interrupt(inputId?: string): boolean {
    const targetInputId = inputId || this.activeInputId;
    if (!targetInputId) return false;

    if (this.kernel) {
      const input = this.kernel.getInput(targetInputId);
      if (input) {
        if (input.sessionId !== this.meta.id) return false;
        if (input.state === "cancelled" || input.state === "consumed") return false;
        if (input.state === "claimed") {
          const fence = this.kernelFence;
          if (
            !fence ||
            this.activeInputId !== targetInputId ||
            input.claimedGeneration !== fence.generation
          ) {
            // A steer claimed by the active owner is already past its durable
            // acceptance boundary: its stable canonical message may already be
            // installed in provider history. Cancelling only the inbox row at
            // that point would leave a "cancelled" correction that still
            // affects recovery, or make the acknowledgement throw and fail the
            // owner generation. Queued/admitted steers remain cancellable; once
            // claimed they settle exactly once with their owner.
            return false;
          }
          try {
            this.kernel.cancelInput(targetInputId, {
              sessionId: this.meta.id,
              expectedGeneration: fence.generation,
              reason: { code: "USER_CANCELLED", message: "The user stopped this turn" },
            });
          } catch (error) {
            if (!(error instanceof StaleGenerationError)) throw error;
            // A replacement generation won the CAS. Revoke this stale host's
            // provider/tool signal, but never cancel the replacement's claim.
            this.engine.interrupt();
            return false;
          }
        } else {
          this.kernel.cancelInput(targetInputId, {
            sessionId: this.meta.id,
            reason: { code: "USER_CANCELLED", message: "The user stopped this turn before execution" },
          });
        }
        this.pendingInputCancellations.delete(targetInputId);
      } else {
        // The daemon can own a request id while it is still routing/preparing
        // content. Bind Stop to that exact future admission rather than arming a
        // session-global interrupt that could hit the following message.
        if (this.pendingInputCancellations.has(targetInputId)) return false;
        this.pendingInputCancellations.add(targetInputId);
      }
    } else {
      if (this.pendingInputCancellations.has(targetInputId)) return false;
      this.pendingInputCancellations.add(targetInputId);
    }

    if (this.activeInputId === targetInputId) this.engine.interrupt();
    return true;
  }

  /** Wait for any inputs that were already pending when this Session host was
   * constructed. Recovery runs detached, but callers and tests can await this
   * durable boundary to surface a provider/reconciliation failure explicitly. */
  async waitForStartupRecovery(): Promise<void> {
    await this.startupRecoveryPromise;
    if (this.startupRecoveryError !== undefined) throw this.startupRecoveryError;
  }

  /** Snapshot the exact non-control inputs a host-managed recovery will own.
   * This is intentionally synchronous so an evented host can expose a Stop
   * target before waiting for a crashed runner lease to expire. */
  pendingHostManagedStartupRecovery(): AdmittedInputRecord[] {
    if (!this.kernel) return [];
    return this.kernel
      .listInputs(this.meta.id)
      .filter((input) =>
        (input.state === "admitted" || input.state === "claimed") && !isAttachedControlInput(input),
      );
  }

  /** Normalize a crashed runner generation without executing its inputs.
   *
   * Evented hosts call this only after their command transport and observers
   * are ready, then feed the returned canonical IDs through their normal send
   * path. Acquiring the replacement fence performs the same expired-lease and
   * unknown-effect reconciliation as an ordinary run; releasing it immediately
   * leaves every non-control input admitted and provider execution untouched. */
  async prepareHostManagedStartupRecovery(): Promise<AdmittedInputRecord[]> {
    if (!this.kernel) return [];
    if (this.opts.detachedStartupRecovery !== false) {
      throw new Error("host-managed startup recovery requires detachedStartupRecovery: false");
    }
    const pending = () => this.pendingHostManagedStartupRecovery();
    if (pending().length === 0) return [];

    // Reserve the process-local runner while the durable coordinator waits for
    // a crashed owner's lease to expire. No caller in this Session can overtake
    // the recovery fence and block forever behind a still-claimed input.
    const release = await this.acquireRunLease();
    let executionState: Exclude<ExecutionState, "running"> = "idle";
    let workOutcome: WorkOutcome = "not_applicable";
    let kernelError: JsonValue | null = null;
    try {
      await this.ensureSessionDir();
      await this.beginKernelRun();
      return pending();
    } catch (error) {
      executionState = "failed";
      workOutcome = "unverified";
      kernelError = errorToKernelJson(error);
      throw error;
    } finally {
      // beginKernelRun installs the fence before unknown-effect reconciliation;
      // release it even when that reconciliation throws.
      try {
        if (this.kernelFence && this.kernelLease) {
          this.finishKernelRun(executionState, workOutcome, kernelError);
        }
      } finally {
        // Process-local FIFO release is unconditional even if durable/plan
        // settlement itself throws.
        release();
      }
    }
  }

  /** Append a user message and stream the turn. Events persist to rollout. */
  async *send(text: string): AsyncGenerator<TurnEvent> {
    yield* this.sendContent([{ type: "text", text }]);
  }

  /** Append arbitrary user content (text + image blocks) and stream the turn. */
  async *sendContent(
    content: ContentBlock[],
    admission: {
      inputId?: string;
      delivery?: "queue" | "steer";
      source?: "user-input" | "work-item";
      /** Stop after durable steer admission + live routing. The active engine
       * claims the correction from its durable inbox; if the owner has already
       * crossed its terminal fence, the host can later run the same input ID
       * through its full ordinary preparation/routing pipeline. */
      admitOnlySteer?: boolean;
      /** Host-managed crash recovery for this exact pre-existing input. Lets an
       * orphaned queue owner reclaim its generation ahead of later attached
       * steers and rebuilds the canonical resume boundary before execution. */
      recoverExistingInput?: boolean;
    } = {},
  ): AsyncGenerator<TurnEvent> {
    const inputKey = admission.inputId ?? `input_${randomUUID()}`;
    // Legacy/non-kernel sessions retain their historical whole-call FIFO.
    // Kernel sessions admit first so an input is durable and observable even
    // while another turn owns provider/tool execution. They reserve admission
    // order synchronously, but wait for execution only after the audit barrier.
    let release: (() => void) | undefined;
    let runLeaseReservation: Promise<() => void> | undefined;
    let ownsActiveInput = false;
    let ownsKernelRun = false;
    let attemptedKernelRun = false;
    if (!this.kernel) {
      release = await this.acquireRunLease();
      this.activeInputId = inputKey;
      ownsActiveInput = true;
    }
    let executionState: Exclude<ExecutionState, "running"> = "interrupted";
    let workOutcome: WorkOutcome = "unverified";
    let kernelError: JsonValue | null = null;
    try {
      await this.ensureSessionDir();
      const delivery = admission.delivery ?? "queue";
      let userMessage: Message;
      let admittedInput: AdmittedInputRecord | null = null;
      let restoreExistingInput = false;
      if (admission.recoverExistingInput && !this.kernel) {
        throw new Error("recoverExistingInput requires a durable session kernel");
      }

      if (this.kernel) {
        if (admission.recoverExistingInput) {
          if (this.opts.detachedStartupRecovery !== false) {
            throw new Error("recoverExistingInput requires host-managed startup recovery");
          }
          const existing = this.kernel.getInput(inputKey);
          if (!existing || existing.sessionId !== this.meta.id) {
            throw new Error(`startup recovery input ${inputKey} does not exist in this session`);
          }
        }
        const result = this.kernel.admitInput({
          id: inputKey,
          sessionId: this.meta.id,
          idempotencyKey: inputKey,
          delivery,
          // Preserve the original canonical payload for ordinary user input.
          // Older/crash-admitted records contain only `content`; adding an
          // explicit default during transport retry would turn the same
          // idempotency key into a false conflict. Work items are the only
          // non-default source and therefore the only source persisted here.
          payload: toKernelJson(admission.source === "work-item"
            ? { content, source: "work-item" }
            : { content }),
        });
        admittedInput = result.record;
        if (admission.recoverExistingInput && result.inserted) {
          throw new Error(`startup recovery input ${inputKey} did not already exist`);
        }
        restoreExistingInput = admission.recoverExistingInput === true && !result.inserted;
        if (
          this.pendingInputCancellations.delete(inputKey) &&
          admittedInput.state !== "cancelled" &&
          admittedInput.state !== "consumed"
        ) {
          admittedInput = this.kernel.cancelInput(inputKey, {
            sessionId: this.meta.id,
            reason: { code: "USER_CANCELLED", message: "The user stopped this turn before execution" },
          });
        }
        userMessage = messageForKernelInput(this.meta.id, admittedInput);
      } else {
        userMessage = this.engine.appendUserMessageContent(content);
      }
      const admitted: TurnEvent = {
        type: "input_admitted",
        inputId: admittedInput?.id ?? inputKey,
        sessionId: this.meta.id,
        delivery,
        userMessage,
      };
      // Admission is the write-ahead boundary. If this cannot become durable,
      // the provider must not start and tools must not gain side effects.
      this.persistEvent(admitted);
      this.notifyEvent(admitted);
      // Reserve the process-local ticket in the same synchronous admission
      // continuation, so caller scheduling and audit I/O latency cannot reorder
      // execution. Do not WAIT for the ticket until the portable audit flushes.
      if (
        this.kernel &&
        !admission.admitOnlySteer &&
        admittedInput?.state !== "consumed" &&
        admittedInput?.state !== "cancelled"
      ) {
        runLeaseReservation = this.acquireRunLease();
      }
      // SQLite admission is the canonical crash-recoverable boundary. Route a
      // live correction in this same synchronous continuation so the owner
      // cannot launch a stale tool while the compatibility JSONL append is
      // flushing. Publication still waits for that audit barrier below.
      let routedSteer: Extract<TurnEvent, { type: "steer_routed" }> | null = null;
      if (
        this.kernel &&
        delivery === "steer" &&
        admittedInput &&
        !isAttachedControlInput(admittedInput) &&
        this.kernel.getInput(admittedInput.id)?.state === "admitted"
      ) {
        routedSteer = {
          type: "steer_routed",
          inputId: admittedInput.id,
          disposition: this.engine.requestSteeringPreemption(),
        };
      }
      await this.flush();

      // Steering is an in-band correction to the generation that is already
      // running, not a second turn waiting behind it. QueryEngine already saw
      // the canonical SQLite admission above; now that the portable audit is
      // durable too, expose the exact synchronous routing decision to surfaces.
      if (routedSteer) {
        this.persistEvent(routedSteer);
        this.notifyEvent(routedSteer);
      }
      // Admission-only callers never enter run settlement, even when this is an
      // idempotent replay of a claimed/consumed/cancelled row. In particular,
      // they cannot append a synthetic turn_end against the active owner's
      // kernel fence or acquire/release any run lease.
      if (admission.admitOnlySteer) return;

      if (!this.kernel) {
        if (this.pendingInputCancellations.delete(inputKey)) {
          executionState = "interrupted";
          workOutcome = "not_applicable";
          const terminal = immediateInterruptedTurnEnd();
          await this.persistImmediateTurnEnd(terminal);
          yield terminal;
          return;
        }
        for await (const event of this.streamAndPersist()) {
          if (event.type === "turn_end") {
            executionState = event.status;
            workOutcome = event.workStatus ?? "not_applicable";
          }
          yield event;
        }
        return;
      }

      // Re-sending an idempotency key acknowledges the original admission but
      // never creates a second logical request after it has settled.
      if (admittedInput?.state === "cancelled") {
        executionState = "interrupted";
        workOutcome = "not_applicable";
        const terminal = immediateInterruptedTurnEnd();
        await this.persistImmediateTurnEnd(terminal);
        yield terminal;
        return;
      }
      if (admittedInput?.state === "consumed") {
        executionState = "completed";
        workOutcome = this.kernel.getSession(this.meta.id)?.workOutcome ?? "not_applicable";
        return;
      }

      release = await (runLeaseReservation ?? this.acquireRunLease());
      // Admission and the FIFO wait are intentionally separate. The input may
      // have settled while this caller waited behind its predecessor (for
      // example, a concurrent retry of the same idempotency key).
      const currentInput = this.kernel.getInput(admittedInput!.id);
      if (currentInput?.state === "cancelled") {
        executionState = "interrupted";
        workOutcome = "not_applicable";
        const terminal = immediateInterruptedTurnEnd();
        await this.persistImmediateTurnEnd(terminal);
        yield terminal;
        return;
      }
      if (currentInput?.state === "consumed") {
        executionState = "completed";
        workOutcome = this.kernel.getSession(this.meta.id)?.workOutcome ?? "not_applicable";
        return;
      }

      if (!(await this.waitUntilKernelInputHead(admittedInput!.id, restoreExistingInput))) {
        const settled = this.kernel.getInput(admittedInput!.id);
        if (settled?.state === "cancelled") {
          executionState = "interrupted";
          workOutcome = "not_applicable";
          const terminal = immediateInterruptedTurnEnd();
          await this.persistImmediateTurnEnd(terminal);
          yield terminal;
        } else {
          executionState = "completed";
          workOutcome = this.kernel.getSession(this.meta.id)?.workOutcome ?? "not_applicable";
        }
        return;
      }
      // beginKernelRun installs the durable lease/fence before effect
      // reconciliation. Remember entry before awaiting so a reconciliation
      // throw still releases that newly installed authority in finally.
      attemptedKernelRun = true;
      const fence = await this.beginKernelRun();
      ownsKernelRun = true;
      const claimable = this.kernel.getInput(admittedInput!.id);
      if (claimable?.state === "cancelled") {
        executionState = "interrupted";
        workOutcome = "not_applicable";
        const terminal = immediateInterruptedTurnEnd();
        await this.persistImmediateTurnEnd(terminal);
        yield terminal;
        return;
      }
      if (claimable?.state === "consumed") {
        executionState = "completed";
        workOutcome = this.kernel.getSession(this.meta.id)?.workOutcome ?? "not_applicable";
        return;
      }
      // A sender claims only the input it admitted. Global-oldest selection is
      // reserved for explicit recovery (`resumeTurn`): audit-flush scheduling
      // can change local FIFO registration order, but must never let caller B
      // execute or stream caller A's request.
      const claimed = this.kernel.claimInput(fence, admittedInput!.id);
      this.activeInputId = claimed.id;
      ownsActiveInput = true;
      if (restoreExistingInput) {
        this.restoreKernelResumeBoundary(fence, claimed);
      } else {
        const canonicalProjection = projectMessagesFromKernel(this.kernel, this.meta.id);
        if (canonicalProjection.length > 0) this.engine.hydrate(canonicalProjection);
        const queuedMessage = messageForKernelInput(this.meta.id, claimed);
        if (!this.engine.history().some((message) => message.id === queuedMessage.id)) {
          this.engine.appendUserMessageContent(queuedMessage.content, {
            id: queuedMessage.id,
            createdAt: queuedMessage.createdAt,
            metadata: queuedMessage.metadata,
          });
        }
        if (!this.kernel.getMessage(queuedMessage.id)) {
          this.kernel.appendMessage(fence, {
            id: queuedMessage.id,
            inputId: claimed.id,
            role: "user",
            metadata: toKernelJson(queuedMessage.metadata ?? {}),
            parts: queuedMessage.content.map((block) => ({ type: block.type, data: toKernelJson(block) })),
            createdAtMs: protocolMessageCreatedAtMs(queuedMessage.createdAt),
          });
        }
      }

      // A Stop can land after the generation claims its input but before the
      // engine generator arms its controller. The durable cancelled state is
      // authoritative and prevents provider/tool execution in that narrow gap.
      if (this.kernel.getInput(claimed.id)?.state === "cancelled") {
        executionState = "interrupted";
        workOutcome = "not_applicable";
        const cancelled = immediateInterruptedTurnEnd();
        await this.persistImmediateTurnEnd(cancelled);
        yield cancelled;
        return;
      }

      let terminal: Extract<TurnEvent, { type: "turn_end" }> | null = null;
      for await (const event of this.streamAndPersist()) {
        if (event.type === "turn_end") {
          terminal = event;
          executionState = event.status;
          workOutcome = event.workStatus ?? "not_applicable";
          // Settle synchronously before exposing the terminal event. Most UI
          // consumers stop at turn_end; requiring one more generator advance
          // left terminal work claimed and therefore runnable after release.
          // Failed provider runs deliberately remain claimed here so lease
          // release can requeue them for resume.
          this.settleOwnedInputAtTerminal(fence, claimed.id, event);
        }
        yield event;
      }
      if (!terminal) throw new Error("session runner ended without a durable turn boundary");
    } catch (error) {
      executionState = "failed";
      workOutcome = "unverified";
      kernelError = errorToKernelJson(error);
      throw error;
    } finally {
      if (ownsActiveInput && this.activeInputId === inputKey) this.activeInputId = null;
      try {
        if (ownsKernelRun || attemptedKernelRun) {
          this.finishKernelRun(executionState, workOutcome, kernelError);
        }
      } finally {
        // A failed audit barrier still has a reserved FIFO ticket. Release it
        // when its predecessor completes without delaying the admission failure
        // or permanently wedging every later sender behind an abandoned ticket.
        // This local FIFO release is unconditional even if durable/plan
        // settlement itself throws.
        if (!release && runLeaseReservation) {
          void runLeaseReservation.then((reservedRelease) => reservedRelease(), () => undefined);
        }
        release?.();
      }
    }
  }

  /**
   * Re-stream the CURRENT pending turn without appending a new user message.
   * Used to retry a turn that died on a provider-level failure after switching
   * to a healthy provider — the engine re-runs the same pending user message.
   */
  async *resumeTurn(): AsyncGenerator<TurnEvent> {
    const release = await this.acquireRunLease();
    let ownedInputId: string | null = null;
    let executionState: Exclude<ExecutionState, "running"> = "interrupted";
    let workOutcome: WorkOutcome = "unverified";
    let kernelError: JsonValue | null = null;
    try {
      await this.ensureSessionDir();
      const resumeCandidateId = this.kernel
        ?.listInputs(this.meta.id)
        .find((input) => input.state === "admitted" && !isAttachedControlInput(input))
        ?.id;
      const fence = this.kernel ? await this.beginKernelRun() : null;
      const claimed = fence ? this.kernel!.claimNextInput(fence) : null;
      if (fence && !claimed) {
        if (resumeCandidateId && this.kernel!.getInput(resumeCandidateId)?.state === "cancelled") {
          executionState = "interrupted";
          workOutcome = "not_applicable";
          const cancelled = immediateInterruptedTurnEnd();
          await this.persistImmediateTurnEnd(cancelled);
          yield cancelled;
        } else {
          executionState = "idle";
          workOutcome = "not_applicable";
        }
        return;
      }
      if (claimed && fence) {
        this.activeInputId = claimed.id;
        ownedInputId = claimed.id;
        this.restoreKernelResumeBoundary(fence, claimed);
        if (this.kernel!.getInput(claimed.id)?.state === "cancelled") {
          executionState = "interrupted";
          workOutcome = "not_applicable";
          const cancelled = immediateInterruptedTurnEnd();
          await this.persistImmediateTurnEnd(cancelled);
          yield cancelled;
          return;
        }
      }
      let terminal: Extract<TurnEvent, { type: "turn_end" }> | null = null;
      for await (const event of this.streamAndPersist()) {
        if (event.type === "turn_end") {
          terminal = event;
          executionState = event.status;
          workOutcome = event.workStatus ?? "not_applicable";
          if (claimed && fence) this.settleOwnedInputAtTerminal(fence, claimed.id, event);
        }
        yield event;
      }
      if (!terminal) throw new Error("session runner ended without a durable turn boundary");
    } catch (error) {
      executionState = "failed";
      workOutcome = "unverified";
      kernelError = errorToKernelJson(error);
      throw error;
    } finally {
      if (ownedInputId && this.activeInputId === ownedInputId) this.activeInputId = null;
      try {
        this.finishKernelRun(executionState, workOutcome, kernelError);
      } finally {
        release();
      }
    }
  }

  /** Start plan mode with a recoverable artifact immediately. Re-entering an
   * existing draft heals its projection instead of manufacturing revisions. */
  async beginPlanDraft(reason: string): Promise<void> {
    if (!this.kernel) return;
    const active = this.kernel.getActivePlan(this.meta.id);
    if (active?.status === "draft" || active?.status === "awaiting_approval") {
      await this.mirrorPlanArtifact(active);
      return;
    }
    const intent = reason.trim() || "Planning requested.";
    await this.recordPlanDraft(
      `# Plan\n\n> Living draft — update this artifact as investigation changes the approach.\n\n## Intent\n\n${intent}\n\n## Working plan\n\n- Inspect the relevant system and constraints.\n- Record decisions, implementation steps, and verification before approval.`,
    );
  }

  /** Persist a living, unapproved plan revision and atomically refresh its
   * stable human-readable projection. Updating an awaiting revision creates a
   * new hash-bound draft so approval can never carry across changed bytes. */
  async recordPlanDraft(body: string): Promise<void> {
    if (!this.kernel) return;
    const active = this.kernel.getActivePlan(this.meta.id);
    const reusable = active &&
      (active.status === "draft" || active.status === "awaiting_approval") &&
      active.body === body;
    const plan = reusable
      ? active
      : this.kernel.createPlanRevision({
          sessionId: this.meta.id,
          body,
          author: "assistant",
          fence: this.kernelFence ?? undefined,
          metadata: { source: "living-plan-draft" },
        });
    await this.mirrorPlanArtifact(plan);
  }

  activePlanBody(): string | null {
    return this.kernel?.getActivePlan(this.meta.id)?.body ?? null;
  }

  /** Persist the exact markdown revision and atomically refresh its stable,
   * human-readable projection. Re-proposing identical active bytes heals the
   * artifact without manufacturing another revision. */
  async recordPlanProposal(body: string): Promise<void> {
    if (!this.kernel) return;
    const active = this.kernel.getActivePlan(this.meta.id);
    let plan: PlanRevisionRecord;
    if (active?.body === body) {
      plan = active;
    } else {
      plan = this.kernel.createPlanRevision({
        sessionId: this.meta.id,
        body,
        author: "assistant",
        fence: this.kernelFence ?? undefined,
      });
    }
    if (plan.status === "draft") {
      plan = this.kernel.requestPlanApproval(plan.id, plan.planHash, this.kernelFence ?? undefined);
    }
    await this.mirrorPlanArtifact(plan);
  }

  /** Approval is hash-bound to the currently proposed bytes. A changed plan
   * cannot inherit approval from an older revision. Approval, durable build
   * mode, and the synthetic handoff input are one SQLite transaction. */
  async approvePlan(body: string, approver = "owner"): Promise<void> {
    if (!this.kernel) return;
    const plan = this.kernel.getActivePlan(this.meta.id);
    if (
      !plan ||
      plan.body !== body ||
      !["awaiting_approval", "approved", "executing"].includes(plan.status)
    ) {
      throw new Error("the approved plan does not match the active durable revision");
    }
    const approved = this.approvePlanRevisionForBuild(plan, approver);
    this.engine.setSystemPrompt(this.systemPromptWithActiveBuildPlan(this.baseSystemPrompt));
    await this.mirrorPlanArtifact(approved);
  }

  async approvePendingPlan(approver = "owner-command"): Promise<void> {
    if (!this.kernel) return;
    const plan = this.kernel.getActivePlan(this.meta.id);
    if (!plan || !["awaiting_approval", "approved", "executing"].includes(plan.status)) return;
    const approved = this.approvePlanRevisionForBuild(plan, approver);
    this.engine.setSystemPrompt(this.systemPromptWithActiveBuildPlan(this.baseSystemPrompt));
    await this.mirrorPlanArtifact(approved);
  }

  private approvePlanRevisionForBuild(plan: PlanRevisionRecord, approver: string): PlanRevisionRecord {
    if (!this.kernel) throw new Error("cannot approve a plan without a session kernel");
    const handoffText = renderApprovedPlanBuildHandoff(plan);
    const handoffId = `plan_handoff_${createHash("sha256")
      .update(`${this.meta.id}\0${plan.id}\0${plan.planHash}`)
      .digest("hex")
      .slice(0, 32)}`;
    const result = this.kernel.approvePlanForBuild({
      planRevisionId: plan.id,
      expectedPlanHash: plan.planHash,
      approver,
      metadata: {
        source: "owner-plan-approval",
        artifactPath: planArtifactRelativePath(this.meta.id).split(path.sep).join("/"),
      },
      handoff: {
        id: handoffId,
        idempotencyKey: handoffId,
        payload: toKernelJson({
          kind: "approved-plan-build-handoff",
          planRevisionId: plan.id,
          planHash: plan.planHash,
          revision: plan.revision,
          artifactPath: planArtifactRelativePath(this.meta.id).split(path.sep).join("/"),
          content: [{ type: "system_reminder", text: handoffText }],
        }),
      },
    });
    return result.plan;
  }

  private systemPromptWithActiveBuildPlan(base: string): string {
    if (!this.kernel) return base;
    const session = this.kernel.getSession(this.meta.id);
    const plan = this.kernel.getActivePlan(this.meta.id);
    if (
      session?.workflowMode !== "build" ||
      !plan ||
      (plan.status !== "approved" && plan.status !== "executing")
    ) return base;
    return `${base.trimEnd()}\n\n## Approved build handoff (durably pinned until settlement)\n\n${renderApprovedPlanBuildHandoff(plan)}`;
  }

  private async mirrorPlanArtifact(plan: PlanRevisionRecord): Promise<void> {
    await writePlanArtifact(this.opts.workspace, plan);
    this.mirroredPlanKey = `${plan.id}:${plan.planHash}`;
  }

  /** Claim every currently admitted steer under this generation and commit its
   * stable message projection before exposing it to QueryEngine history. The
   * input remains claimed until QueryEngine confirms history installation. */
  private claimKernelSteeringMessages(): ClaimedSteeringMessage[] {
    if (!this.kernel || !this.kernelFence) return [];
    const fence = this.kernelFence;
    const claimed = this.kernel.claimSteeringInputs(fence);
    return claimed.map((input) => {
      const message = messageForKernelInput(this.meta.id, input);
      const existing = this.kernel!.getMessage(message.id);
      if (existing && existing.inputId !== input.id) {
        throw new Error(`steering message ${message.id} belongs to input ${existing.inputId ?? "<none>"}`);
      }
      if (!existing) {
        this.kernel!.appendMessage(fence, {
          id: message.id,
          inputId: input.id,
          role: "user",
          metadata: toKernelJson(message.metadata ?? {}),
          parts: message.content.map((block) => ({ type: block.type, data: toKernelJson(block) })),
          createdAtMs: protocolMessageCreatedAtMs(message.createdAt),
        });
      }
      return { inputId: input.id, message };
    });
  }

  /** Acknowledge only after QueryEngine has installed the correction in its
   * history. If this throws, runner release requeues the unconsumed claim; the
   * stable message id makes the next boundary an upsert rather than a duplicate. */
  private consumeKernelSteeringInputs(inputIds: readonly string[]): void {
    if (inputIds.length === 0) return;
    if (!this.kernel || !this.kernelFence) {
      throw new Error("cannot consume steering inputs without an active kernel generation");
    }
    for (const inputId of new Set(inputIds)) {
      this.kernel.consumeInput(this.kernelFence, inputId);
    }
  }

  /** Rebuild provider history from the canonical ledger before retrying an
   * admitted input. If the model's final assistant message was committed but
   * its turn_end boundary was lost, resume with an explicit user-role recovery
   * boundary instead of replaying the original request. Tool pairs are repaired
   * by projectMessagesFromKernel from the durable tool ledger first, so settled
   * effects are represented as results and must not be executed again. */
  private restoreKernelResumeBoundary(fence: RunFence, claimed: AdmittedInputRecord): void {
    if (!this.kernel) throw new Error("cannot restore a resume boundary without a session kernel");

    const projection = projectMessagesFromKernel(this.kernel, this.meta.id);
    if (projection.length > 0) this.engine.hydrate(projection);

    const queuedMessage = messageForKernelInput(this.meta.id, claimed);
    const storedQueuedMessage = this.kernel.getMessage(queuedMessage.id);
    if (storedQueuedMessage && storedQueuedMessage.inputId !== claimed.id) {
      throw new Error(
        `queued message ${queuedMessage.id} belongs to input ${storedQueuedMessage.inputId ?? "<none>"}`,
      );
    }
    if (!storedQueuedMessage) {
      this.kernel.appendMessage(fence, {
        id: queuedMessage.id,
        inputId: claimed.id,
        role: "user",
        metadata: toKernelJson(queuedMessage.metadata ?? {}),
        parts: queuedMessage.content.map((block) => ({ type: block.type, data: toKernelJson(block) })),
        createdAtMs: protocolMessageCreatedAtMs(queuedMessage.createdAt),
      });
      if (!this.engine.history().some((message) => message.id === queuedMessage.id)) {
        this.engine.appendUserMessageContent(queuedMessage.content, {
          id: queuedMessage.id,
          createdAt: queuedMessage.createdAt,
          metadata: queuedMessage.metadata,
        });
      }
    }

    // A pending user/tool-result message is already a valid provider boundary.
    // Only an assistant tail proves that model output crossed durable storage
    // before the enclosing turn boundary was committed.
    if (this.engine.history().at(-1)?.role !== "assistant") return;

    const recoveryId = `kernel_recovery_${createHash("sha256")
      .update(`${this.meta.id}\0${claimed.id}\0${fence.generation}`)
      .digest("hex")
      .slice(0, 32)}`;
    const createdAt = new Date().toISOString();
    const metadata: Message["metadata"] = {
      source: "session-kernel-recovery",
      inputId: claimed.id,
      generation: fence.generation,
    };
    const content: ContentBlock[] = [{
      type: "system_reminder",
      text: [
        "RECOVERY BOUNDARY: The prior assistant response and every settled tool result above are canonical.",
        "The durable turn_end boundary was lost after that response was stored.",
        "Do not repeat any tool call, workspace mutation, or external effect already represented in the history.",
        "Finalize the prior answer, or continue only work that is explicitly unresolved by the recovered history.",
      ].join(" "),
    }];
    const storedRecovery = this.kernel.getMessage(recoveryId);
    if (storedRecovery && storedRecovery.inputId !== claimed.id) {
      throw new Error(
        `recovery message ${recoveryId} belongs to input ${storedRecovery.inputId ?? "<none>"}`,
      );
    }
    if (!storedRecovery) {
      this.kernel.appendMessage(fence, {
        id: recoveryId,
        inputId: claimed.id,
        role: "user",
        metadata: toKernelJson(metadata ?? {}),
        parts: content.map((block) => ({ type: block.type, data: toKernelJson(block) })),
        createdAtMs: protocolMessageCreatedAtMs(createdAt),
      });
    }
    if (!this.engine.history().some((message) => message.id === recoveryId)) {
      this.engine.appendUserMessageContent(content, { id: recoveryId, createdAt, metadata });
    }
  }

  /** Reserve the first process-local execution ticket synchronously during
   * construction. Every pending runnable input observed here predates any
   * caller that can obtain this Session instance, so later sender streams can
   * admit durably but cannot overtake recovery. */
  private scheduleStartupOrphanDrain(): void {
    if (!this.kernel) return;
    const orphanInputIds = this.kernel
      .listInputs(this.meta.id)
      .filter((input) =>
        (input.state === "admitted" || input.state === "claimed") && !isAttachedControlInput(input),
      )
      .map((input) => input.id);
    if (orphanInputIds.length === 0) return;

    // Calling acquireRunLease reserves runTail before its first await. Keep the
    // reservation even while the prior owner's durable lease is still alive;
    // RunLeaseCoordinator will wait for settlement or expiry without allowing
    // a new local sender to become the executor of somebody else's input.
    const reservation = this.acquireRunLease();
    const recovery = reservation.then(async (release) => {
      try {
        await this.drainStartupOrphans(orphanInputIds);
      } finally {
        release();
      }
    });
    this.startupRecoveryPromise = recovery.catch((error: unknown) => {
      this.startupRecoveryError = error;
      try {
        process.stderr.write(
          `[session] detached startup recovery paused for ${this.meta.id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } catch {
        // The durable input/result state remains authoritative without stderr.
      }
    });
  }

  private async drainStartupOrphans(orphanInputIds: readonly string[]): Promise<void> {
    if (!this.kernel) return;
    await this.ensureSessionDir();
    for (const inputId of orphanInputIds) {
      const beforeLease = this.kernel.getInput(inputId);
      if (
        !beforeLease ||
        beforeLease.state === "consumed" ||
        beforeLease.state === "cancelled" ||
        isAttachedControlInput(beforeLease)
      ) {
        continue;
      }

      let executionState: Exclude<ExecutionState, "running"> = "interrupted";
      let workOutcome: WorkOutcome = "unverified";
      let kernelError: JsonValue | null = null;
      let fence: RunFence | null = null;
      let ownsActiveInput = false;
      try {
        fence = await this.beginKernelRun();
        const current = this.kernel.getInput(inputId);
        // Another healthy host may have completed this exact orphan while this
        // coordinator waited on its lease. Acquiring a no-op generation is safe
        // and lets us release/wake local callers without replaying anything.
        if (!current || current.state === "consumed" || current.state === "cancelled") {
          executionState = "idle";
          workOutcome = "not_applicable";
          continue;
        }
        if (current.state !== "admitted") {
          throw new Error(`orphan input ${inputId} was not claimable after coordinator takeover`);
        }

        const claimed = this.kernel.claimInput(fence, inputId);
        this.activeInputId = claimed.id;
        ownsActiveInput = true;
        this.kernel.appendEvent(fence, "input.detached_recovery_started", toKernelJson({ inputId }));
        this.restoreKernelResumeBoundary(fence, claimed);
        if (this.kernel.getInput(claimed.id)?.state === "cancelled") {
          executionState = "interrupted";
          workOutcome = "not_applicable";
          await this.persistImmediateTurnEnd(immediateInterruptedTurnEnd());
          continue;
        }
        let terminal: Extract<TurnEvent, { type: "turn_end" }> | null = null;
        let outputMessageId: string | null = null;
        for await (const event of this.streamAndPersist()) {
          if (event.type === "message_done") {
            outputMessageId = kernelStoredMessageId(this.meta.id, event.message.id);
          }
          if (event.type === "turn_end") {
            terminal = event;
            executionState = event.status;
            workOutcome = event.workStatus ?? "not_applicable";
          }
        }
        if (!terminal) throw new Error("detached session runner ended without a durable turn boundary");
        if (terminal.status !== "completed") {
          throw new Error(`detached recovery for input ${inputId} ended ${terminal.status}`);
        }

        // Consumption and the queryable result acknowledgement are one SQLite
        // transaction. A power loss cannot strand a consumed input without a
        // result, and a retry can never publish a second logical result.
        this.kernel.settleDetachedInputResult(fence, inputId, {
          workOutcome,
          outputMessageId,
        });
      } catch (error) {
        executionState = "failed";
        workOutcome = "unverified";
        kernelError = errorToKernelJson(error);
        if (fence && this.kernel.isFenceCurrent(fence)) {
          this.kernel.appendEvent(fence, "input.detached_recovery_failed", toKernelJson({
            inputId,
            error: kernelError,
          }));
        }
        throw error;
      } finally {
        if (ownsActiveInput && this.activeInputId === inputId) this.activeInputId = null;
        this.finishKernelRun(executionState, workOutcome, kernelError);
      }
    }
  }

  private async beginKernelRun(): Promise<RunFence> {
    if (!this.kernel) throw new Error("session kernel is not configured");
    if (this.kernelFence) return this.kernelFence;
    if (!this.kernelLeaseCoordinator) throw new Error("session run coordinator is not configured");
    const lease = await this.kernelLeaseCoordinator.acquire(this.meta.id, {
      signal: this.opts.signal,
      waitForLease: true,
      onLeaseLost: () => {
        // Losing the generation fence revokes authority immediately. Interrupt
        // provider/tools; the replacement owner will reconcile unknown effects.
        this.engine.interrupt();
      },
    });
    const fence: RunFence = lease.context;
    this.kernelLease = lease;
    this.kernelFence = fence;
    this.kernelToolRuns.clear();
    await this.reconcileUnknownToolEffects(fence);
    return fence;
  }

  private async reconcileUnknownToolEffects(fence: RunFence): Promise<void> {
    if (!this.kernel) return;
    for (const toolRun of this.kernel.listToolRuns(this.meta.id)) {
      if (toolRun.executionState !== "effect_unknown") continue;
      if (toolRun.mutationTransactionId) {
        await this.reconcileWorkspaceMutationToolRun(fence, toolRun.id, toolRun.mutationTransactionId);
      }
      // The journal reconciler may have settled the run. Only an unresolved
      // effect reaches the tool-specific observational contract.
      if (this.kernel.getToolRun(toolRun.id)?.executionState !== "effect_unknown") continue;
      await this.reconcileExternalToolRun(fence, toolRun.id);
    }
  }

  private async reconcileWorkspaceMutationToolRun(
    fence: RunFence,
    toolRunId: string,
    transactionId: string,
  ): Promise<void> {
    if (!this.kernel) return;
    try {
      const reconciliation = await new WorkspaceMutationService(this.opts.workspace).reconcile(transactionId);
      const recoveredTool = this.kernel.getToolRun(toolRunId);
      const mutation = reconciliation.disposition !== "not_applied" && reconciliation.paths.length > 0
        ? {
            toolUseId: recoveredTool ? toolUseIdFromCallKey(recoveredTool.callKey) : toolRunId,
            affectedPaths: reconciliation.paths.map((entry) => entry.path),
            scopeComplete: true,
          }
        : undefined;
      this.kernel.reconcileToolRunEffect(fence, toolRunId, {
        disposition: reconciliation.disposition,
        evidence: toKernelJson(reconciliation),
        source: "workspace-mutation",
        retryPolicy: "after-reconciled-not-applied",
        ...(mutation ? { mutation } : {}),
      });
    } catch {
      // No journal means this was not a WorkspaceMutationService-backed effect,
      // or its journal itself is unavailable. Preserve effect_unknown rather
      // than manufacturing certainty.
    }
  }

  private async reconcileExternalToolRun(fence: RunFence, toolRunId: string): Promise<void> {
    if (!this.kernel) return;
    const toolRun = this.kernel.getToolRun(toolRunId);
    if (!toolRun || toolRun.executionState !== "effect_unknown") return;
    const tool = this.opts.tools.find((candidate) => candidate.schema.name === toolRun.toolName);
    const policy = tool?.effectPolicy;
    if (!tool || !policy?.reconcile) {
      this.kernel.appendEvent(fence, "tool.reconciliation_blocked", toKernelJson({
        toolRunId,
        toolName: toolRun.toolName,
        retryPolicy: policy?.retry ?? "never",
        reason: policy
          ? "tool declares no observational reconciler"
          : "tool has no external-effect recovery contract",
      }));
      return;
    }

    const toolUseId = toolUseIdFromCallKey(toolRun.callKey);
    let idempotencyKey: string | undefined;
    try {
      idempotencyKey = policy.idempotencyKey?.(toolRun.arguments) ?? undefined;
    } catch {
      idempotencyKey = undefined;
    }
    const retryPolicy = policy.retry === "idempotent-with-key" && !idempotencyKey
      ? "never"
      : policy.retry;
    const controller = new AbortController();
    const inherited = this.opts.signal;
    const abortFromParent = () => controller.abort(inherited?.reason);
    inherited?.addEventListener("abort", abortFromParent, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`reconciler ${policy.reconcilerKey ?? toolRun.toolName} timed out`);
        controller.abort(error);
        reject(error);
      }, externalReconciliationTimeoutMs());
      timeout.unref?.();
    });
    const abortFailure = new Promise<never>((_resolve, reject) => {
      const aborted = () => reject(controller.signal.reason ?? new Error("effect reconciliation aborted"));
      if (controller.signal.aborted) aborted();
      else controller.signal.addEventListener("abort", aborted, { once: true });
    });
    try {
      const result = await Promise.race([
        policy.reconcile({
          sessionId: this.meta.id,
          toolRunId,
          toolUseId,
          toolName: toolRun.toolName,
          input: toolRun.arguments,
          workspace: this.opts.workspace,
          ...(toolRun.mutationTransactionId
            ? { mutationTransactionId: toolRun.mutationTransactionId }
            : {}),
          previousError: toolRun.error,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          signal: controller.signal,
        }),
        timeoutFailure,
        abortFailure,
      ]);
      const disposition = result.disposition === "applied"
        ? "fully_applied"
        : result.disposition === "not-applied"
          ? "not_applied"
          : "diverged";
      this.kernel.reconcileToolRunEffect(fence, toolRunId, {
        disposition,
        evidence: toKernelJson({
          evidence: result.evidence,
          ...(result.disposition === "applied" && result.touchedFiles?.length
            ? { touchedFiles: result.touchedFiles }
            : {}),
        }),
        source: "tool-reconciler",
        retryPolicy,
        reconcilerKey: policy.reconcilerKey ?? toolRun.toolName,
        ...(result.disposition === "applied" && result.output !== undefined
          ? { recoveredResult: toKernelJson(result.output) }
          : {}),
        ...(result.disposition !== "applied" && result.reason
          ? { reason: result.reason }
          : {}),
        ...(result.disposition === "applied" && result.touchedFiles?.length
          ? {
              mutation: {
                toolUseId,
                affectedPaths: result.touchedFiles.map((file) =>
                  path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.opts.workspace, file)),
                scopeComplete: true,
              },
            }
          : {}),
      });
    } catch (error) {
      // Reconciler errors and timeouts never become replay authority. Preserve
      // effect_unknown and leave an auditable, model-projectable reason.
      this.kernel.appendEvent(fence, "tool.reconciliation_failed", toKernelJson({
        toolRunId,
        toolName: toolRun.toolName,
        retryPolicy,
        reconcilerKey: policy.reconcilerKey ?? toolRun.toolName,
        error: errorToKernelJson(error),
      }));
    } finally {
      if (timeout) clearTimeout(timeout);
      inherited?.removeEventListener("abort", abortFromParent);
    }
  }

  /** Caller-bound generators wait until their own durable admission reaches
   * the queue head. This preserves admission order across Session instances
   * and processes without ever streaming another caller's input. */
  private async waitUntilKernelInputHead(
    inputId: string,
    recoverExistingOwner = false,
  ): Promise<boolean> {
    if (!this.kernel) return true;
    // Wall-clock ceiling: a stranded admitted input owned by a dead generator
    // (e.g. a steer whose caller crashed) can sit at the head forever, and this
    // poll would spin eternally with the turn never settling. On deadline we
    // return false — the caller path already handles false honestly (cancelled
    // → interrupted terminal, otherwise settle as completed without claiming).
    const deadline = Date.now() + 60_000;
    while (true) {
      const own = this.kernel.getInput(inputId);
      if (!own || own.state === "cancelled" || own.state === "consumed") return false;
      const pending = this.kernel
        .listInputs(this.meta.id)
        .filter((input) => input.state === "admitted" || input.state === "claimed");
      const runnablePending = pending.filter((input) => {
        const attachedControlInput = isAttachedControlInput(input);
        // A plan handoff has no caller/generator of its own. The next real
        // build generation drains it through drainKernelSteering(), pins it in
        // context, and consumes it atomically; letting it own the admission
        // head would deadlock the very build request meant to execute it.
        return !attachedControlInput;
      });
      // Steers are an urgent, independently FIFO lane. In particular, a
      // correction whose acknowledgement failed must be able to replay without
      // executing an older, failed queue input owned by another generator.
      // Normal queue work yields to an admitted steer, then remains FIFO within
      // its own lane. Active-turn steers are usually consumed by the current
      // generation before their caller reaches this boundary.
      const head = recoverExistingOwner && own.delivery === "queue"
        ? runnablePending.find((input) => input.delivery === "queue")
        : own.delivery === "steer"
        ? runnablePending.find((input) => input.delivery === "steer")
        : runnablePending.find((input) => input.delivery === "steer") ??
          runnablePending.find((input) => input.delivery === "queue");
      if (head?.id === inputId && head.state === "admitted") return true;
      if (Date.now() >= deadline) {
        try {
          process.stderr.write(
            `[session] waitUntilKernelInputHead: input ${inputId} did not reach the queue head within 60s ` +
            `(head=${head ? `${head.id} (${head.delivery}/${head.state})` : "none"}); settling without claiming\n`,
          );
        } catch { /* stderr unavailable */ }
        return false;
      }
      await this.waitForKernelProgress(50);
    }
  }

  private async waitForKernelProgress(milliseconds: number): Promise<void> {
    const signal = this.opts.signal;
    if (signal?.aborted) throw signal.reason ?? new Error("session wait aborted");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, milliseconds);
      function done() {
        signal?.removeEventListener("abort", aborted);
        resolve();
      }
      function aborted() {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("session wait aborted"));
      }
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  private finishKernelRun(
    executionState: Exclude<ExecutionState, "running">,
    workOutcome: WorkOutcome,
    error: JsonValue | null,
  ): void {
    if (!this.kernel || !this.kernelFence || !this.kernelLease) return;
    const fence = this.kernelFence;
    const lease = this.kernelLease;
    this.kernelFence = null;
    this.kernelLease = null;
    this.kernelToolRuns.clear();

    try {
      const plan = this.kernel.getActivePlan(this.meta.id);
      if (plan?.status === "executing") {
        if (workOutcome === "verified") this.kernel.finishPlanExecution(fence, plan.id, "completed");
        else if (executionState === "failed" || workOutcome === "blocked") {
          this.kernel.finishPlanExecution(fence, plan.id, "failed");
        }
      }
      this.engine.setSystemPrompt(this.systemPromptWithActiveBuildPlan(this.baseSystemPrompt));
    } catch (planError) {
      // Release the generation even when plan projection settlement itself is
      // broken. Remaining claims are requeued; the caller still receives the
      // plan error rather than leaving a healthy heartbeat owner forever.
      lease.release({
        executionState: "failed",
        workOutcome: "unverified",
        error: errorToKernelJson(planError),
      });
      throw planError;
    }
    lease.release({ executionState, workOutcome, error });
  }

  /** Settle the exact input owned by one explicit terminal boundary.
   *
   * A completed turn is consumed. An interrupted turn is terminal too: Stop
   * already cancelled its row, while permission denial and other engine-owned
   * interruptions arrive here with the row still claimed and must be cancelled
   * before releaseRunnerLease can requeue it ahead of the next user message.
   * Failed turns intentionally remain claimed so lease release makes them
   * resumable. Steering preemption never calls this with `interrupted`; it
   * wakes the same QueryEngine turn and continues to a later terminal boundary.
   */
  private settleOwnedInputAtTerminal(
    fence: RunFence,
    inputId: string,
    event: Extract<TurnEvent, { type: "turn_end" }>,
  ): void {
    if (!this.kernel) return;
    const input = this.kernel.getInput(inputId);
    if (input?.state !== "claimed") return;
    if (event.status === "completed") {
      this.kernel.consumeInput(fence, inputId);
      return;
    }
    if (event.status === "interrupted") {
      this.kernel.cancelInput(inputId, {
        sessionId: this.meta.id,
        fence,
        reason: {
          code: "TURN_INTERRUPTED",
          message: "The active turn reached an explicit interrupted terminal boundary",
        },
      });
    }
  }

  private async beginKernelTool(
    request: Parameters<NonNullable<QueryEngineConfig["beforeToolExecution"]>>[0],
  ): Promise<void> {
    if (!this.kernel || !this.kernelFence) return;
    const fence = this.kernelFence;
    const session = this.kernel.requireSession(this.meta.id);
    const activePlan = this.kernel.getActivePlan(this.meta.id);
    const planSafeDelegation = isPlanSafeDelegation(request.toolName, request.input);
    if (request.safety !== "read-only" && !planSafeDelegation) {
      if (
        session.workflowMode === "plan" ||
        activePlan?.status === "draft" ||
        activePlan?.status === "awaiting_approval"
      ) {
        throw new PlanConflictError("Write capability is unavailable until the active plan revision is exactly approved", {
          sessionId: this.meta.id,
          workflowMode: session.workflowMode,
          planRevisionId: activePlan?.id ?? null,
          planHash: activePlan?.planHash ?? null,
          planStatus: activePlan?.status ?? null,
          toolName: request.toolName,
        });
      }
      if (activePlan?.status === "approved") {
        this.kernel.beginPlanExecution(fence, activePlan.id, activePlan.planHash);
        this.engine.setSystemPrompt(this.systemPromptWithActiveBuildPlan(this.baseSystemPrompt));
      }
    }
    let toolRun = this.kernel.beginToolRun(fence, {
      callKey: `${fence.generation}:${request.toolUseId}`,
      toolName: request.toolName,
      arguments: toKernelJson(request.input),
      effectKind: request.safety,
      mutationTransactionId: isTransactionalMutationTool(request.toolName)
        ? request.mutationTransactionId
        : null,
    });
    // This hook runs before the adapted tool performs its own Zod/semantic
    // validation and permission policy. Record only the truthful fact that the
    // adapter lifecycle is now active; never manufacture `validated` or
    // `authorized` states before the owner/policy has actually decided.
    toolRun = this.kernel.transitionToolRun(fence, toolRun.id, "executing", {
      checkpointId: request.checkpointId ?? null,
    });
    this.kernelToolRuns.set(request.toolUseId, toolRun.id);
  }

  private async settleKernelTool(
    result: Parameters<NonNullable<QueryEngineConfig["afterToolExecution"]>>[0],
  ): Promise<void | ToolSettlementReceipt> {
    if (!this.kernel || !this.kernelFence) return;
    const toolRunId = this.kernelToolRuns.get(result.toolUseId);
    if (!toolRunId) throw new Error(`missing durable tool run for ${result.toolUseId}`);
    const pendingToolRun = this.kernel.getToolRun(toolRunId);
    if (!pendingToolRun) throw new Error(`durable tool run disappeared for ${result.toolUseId}`);
    const mutation = await this.canonicalMutationScope(result, pendingToolRun.checkpointId);
    const target = result.status;
    let settled = this.kernel.transitionToolRun(this.kernelFence, toolRunId, target, {
      ...(result.output === undefined ? {} : { result: toKernelJson(result.output) }),
      ...(result.error === undefined ? {} : { error: toKernelJson({ message: result.error }) }),
      ...(mutation ? { mutation } : {}),
    });
    if (target === "effect_unknown" && settled.mutationTransactionId) {
      await this.reconcileWorkspaceMutationToolRun(
        this.kernelFence,
        settled.id,
        settled.mutationTransactionId,
      );
      settled = this.kernel.getToolRun(toolRunId) ?? settled;
    }
    if (settled.executionState === "succeeded" && result.safety === "read-only") {
      this.kernel.setToolVerification(this.kernelFence, toolRunId, "not_required");
    } else if (settled.executionState !== "succeeded" && settled.verificationState === "pending") {
      this.kernel.setToolVerification(this.kernelFence, toolRunId, "blocked", {
        status: settled.executionState,
        error: result.error ?? null,
      });
    }

    if (result.toolName !== "PostToolUseHook") return;
    let touchedFiles: string[] = [];
    let diffUnavailable: string | null = null;
    if (settled.checkpointId) {
      try {
        const diff = await diffWorkspaceCheckpointUnified(this.opts.workspace, settled.checkpointId);
        touchedFiles = diff.files.map((file) => path.resolve(this.opts.workspace, file));
        if (diff.diff || touchedFiles.length > 0) {
          this.kernel.appendEvent(this.kernelFence, "hook.workspace_observed", toKernelJson({
            toolRunId,
            checkpointId: settled.checkpointId,
            files: touchedFiles,
            diff: diff.diff,
            truncated: diff.truncated,
          }));
        }
      } catch (error) {
        diffUnavailable = error instanceof Error ? error.message : String(error);
      }
    } else {
      diffUnavailable = "workspace checkpoint unavailable";
    }
    if (diffUnavailable) {
      // Shell hooks have arbitrary write reach. If their diff cannot be
      // observed, arm proof debt rather than silently claiming no mutation.
      const sentinel = path.resolve(this.opts.workspace, ".ares-unknown-hook-mutation");
      touchedFiles = [sentinel];
      this.kernel.appendEvent(this.kernelFence, "hook.workspace_observation_failed", toKernelJson({
        toolRunId,
        checkpointId: settled.checkpointId,
        reason: diffUnavailable,
        sentinel,
      }));
    }
    return touchedFiles.length > 0 ? { touchedFiles } : undefined;
  }

  /** Produce canonical affected-file scope before terminal tool settlement.
   * Known tool output wins; opaque tools fall back to their pre-effect
   * checkpoint. If exact enumeration is unavailable, persist a sentinel and
   * incomplete-scope bit so restart fails closed instead of trusting JSONL. */
  private async canonicalMutationScope(
    result: Parameters<NonNullable<QueryEngineConfig["afterToolExecution"]>>[0],
    checkpointId: string | null,
  ): Promise<{
    toolUseId: string;
    affectedPaths: string[];
    scopeComplete: boolean;
  } | undefined> {
    let scopeComplete = true;
    let affectedPaths = (result.touchedFiles ?? [])
      .filter((file): file is string => typeof file === "string" && file.trim().length > 0)
      .map((file) => path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.opts.workspace, file));
    affectedPaths = [...new Set(affectedPaths)];

    if (affectedPaths.length === 0 && checkpointId) {
      try {
        const diff = await diffWorkspaceCheckpointUnified(this.opts.workspace, checkpointId);
        affectedPaths = diff.files.map((file) => path.resolve(this.opts.workspace, file));
        scopeComplete = !diff.truncated;
      } catch {
        if (isOpaqueMutationTool(result.toolName) && result.safety !== "read-only") {
          affectedPaths = [path.resolve(this.opts.workspace, ".ares-unknown-mutation")];
          scopeComplete = false;
        }
      }
    } else if (
      affectedPaths.length === 0 &&
      !checkpointId &&
      isOpaqueMutationTool(result.toolName) &&
      result.safety !== "read-only"
    ) {
      affectedPaths = [path.resolve(this.opts.workspace, ".ares-unknown-mutation")];
      scopeComplete = false;
    }
    if (affectedPaths.length === 0) return undefined;
    if (affectedPaths.length > 240) scopeComplete = false;
    return {
      toolUseId: result.toolUseId,
      affectedPaths: affectedPaths.slice(0, 240),
      scopeComplete,
    };
  }

  private async acquireRunLease(): Promise<() => void> {
    const previous = this.runTail;
    let release!: () => void;
    this.runTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  private async *streamAndPersist(): AsyncGenerator<TurnEvent> {
    const preToolCheckpoints = new Map<string, string>();
    const toolNames = new Map<string, string>();
    let observedMutationAt = 0;
    let verificationGenerationAtObservedMutation = this.opts.verificationEvidence?.().mutationGeneration ?? 0;
    try {
      for await (const rawEvent of this.engine.streamTurn()) {
        let event = rawEvent;
        if (event.type === "tool_start") toolNames.set(event.id, event.name);
        if (event.type === "checkpoint_created" && event.toolUseId && event.reason === "pre_tool") {
          preToolCheckpoints.set(event.toolUseId, event.checkpointId);
        }

        // Shell/CodeMode tools cannot declare touched files up front. Their
        // pre-tool checkpoint is a full workspace snapshot, so diff it now and
        // promote discovered changes onto the completed terminal event. A
        // shell failure may have mutated files before exiting non-zero or
        // throwing, so tool_error cannot bypass mutation accounting or
        // verification debt. Validation/pre-hook failures simply diff empty.
        let preparedDiff: Awaited<ReturnType<typeof diffWorkspaceCheckpointUnified>> | null = null;
        if (
          (event.type === "tool_end" || event.type === "tool_error") &&
          (!event.touchedFiles || event.touchedFiles.length === 0)
        ) {
          const checkpointId = preToolCheckpoints.get(event.id);
          if (checkpointId) {
            try {
              preparedDiff = await diffWorkspaceCheckpointUnified(this.opts.workspace, checkpointId);
            } catch (error) {
              // Opaque execution tools can mutate through arbitrary programs
              // (`node generator.mjs`, build scripts, formatters). If their
              // checkpoint diff fails, failing open would label the turn
              // not_applicable. Arm proof debt with an explicit sentinel and
              // surface the unavailable diff as a truncated workspace event.
              if (isOpaqueMutationTool(toolNames.get(event.id))) {
                const sentinel = path.resolve(this.opts.workspace, ".ares-unknown-mutation");
                const detail = error instanceof Error ? error.message : String(error);
                preparedDiff = {
                  files: [path.basename(sentinel)],
                  diff: `Checkpoint diff unavailable after ${toolNames.get(event.id)}: ${detail}`,
                  truncated: true,
                };
                event = { ...event, touchedFiles: [sentinel] };
              }
            }
            if (preparedDiff?.files.length) {
              event = {
                ...event,
                touchedFiles: preparedDiff.files.map((file) => path.resolve(this.opts.workspace, file)),
              };
            }
          } else if (isOpaqueMutationTool(toolNames.get(event.id))) {
            // Broad/home workspaces deliberately disable snapshots. Delegated
            // writers and arbitrary code execution must still fail closed:
            // exact files are unavailable, so arm an unknown mutation debt.
            const sentinel = path.resolve(this.opts.workspace, ".ares-unknown-mutation");
            preparedDiff = {
              files: [path.basename(sentinel)],
              diff: `Checkpoint unavailable after ${toolNames.get(event.id)}; workspace mutation scope is unknown.`,
              truncated: true,
            };
            event = { ...event, touchedFiles: [sentinel] };
          }
        }
        if (
          (event.type === "tool_end" || event.type === "tool_error") &&
          event.touchedFiles?.length
        ) {
          verificationGenerationAtObservedMutation = this.opts.verificationEvidence?.().mutationGeneration ?? verificationGenerationAtObservedMutation;
          observedMutationAt = Date.now();
        }
        if (event.type === "turn_end" && observedMutationAt > 0 && (!event.workStatus || event.workStatus === "not_applicable")) {
          const evidence = this.opts.verificationEvidence?.();
          const currentRun = evidence?.latestRunGeneration === evidence?.mutationGeneration;
          const newerRun = (evidence?.latestRunGeneration ?? -1) > verificationGenerationAtObservedMutation;
          const passedAfterMutation = currentRun && newerRun && evidence?.latestRunStatus === "passed" && evidence.latestRunStrength === "behavioral";
          const failedAfterMutation = currentRun && newerRun && evidence?.latestRunStatus === "failed";
          event = {
            ...event,
            workStatus: passedAfterMutation ? "verified" : failedAfterMutation ? "blocked" : "unverified",
          };
        }

        // QueryEngine has already made its completion decision. Fence its
        // terminal phase before persistence/yield so a steer admitted while the
        // generator closes becomes the next FIFO input instead of a lost wake-up
        // against the dead owner.
        if (event.type === "turn_end") this.engine.markTurnTerminal();

        // SQLite is the canonical projection and is committed synchronously at
        // each settled boundary. JSONL below remains the readable audit stream.
        this.persistKernelEvent(event);

        // Persistence is enqueued (not awaited) so a fast token stream never
        // waits on an NTFS append + Defender scan before reaching the consumer.
        this.persistEvent(event);
        this.notifyEvent(event);
        if (event.type === "turn_end") this.lastWorkStatus = event.workStatus ?? "not_applicable";
        // Friction telemetry rides the same tap — every surface (chat, TUI,
        // daemon) logs identically because they all stream through here.
        this.friction.record(event);
        // Durability barrier at the turn boundary: drain pending appends BEFORE
        // surfacing turn_end, so the rollout is complete on disk without holding
        // the turn "active" past the generator's return (which would reject the
        // user's immediate next message).
        if (event.type === "turn_end") await this.flush();
        yield event;

        if (event.type === "tool_end" || event.type === "tool_error") {
          toolNames.delete(event.id);
          const checkpointId = preToolCheckpoints.get(event.id);
          if (!checkpointId) continue;
          const diff = preparedDiff ?? await diffWorkspaceCheckpointUnified(this.opts.workspace, checkpointId, event.touchedFiles).catch(() => null);
          if (!diff || !diff.diff) continue;
          const diffEvent: TurnEvent = {
            type: "workspace_diff",
            checkpointId,
            toolUseId: event.id,
            files: diff.files,
            diff: diff.diff,
            truncated: diff.truncated,
          };
          this.persistEvent(diffEvent);
          this.notifyEvent(diffEvent);
          yield diffEvent;
        }
      }
    } finally {
      // The turn's generator is done (completed, returned, or the consumer
      // broke out). Drop its controller so later idle Stop calls cannot target a
      // stale generation or leak into the next request.
      this.engine.markTurnEnded();
    }
  }

  /** Persist a terminal boundary for a request cancelled before QueryEngine
   * starts streaming. This mirrors streamAndPersist's settlement tap so every
   * observer, audit log, kernel generation, and friction record agrees. */
  private async persistImmediateTurnEnd(
    event: Extract<TurnEvent, { type: "turn_end" }>,
  ): Promise<void> {
    this.persistKernelEvent(event);
    this.persistEvent(event);
    this.notifyEvent(event);
    this.lastWorkStatus = event.workStatus ?? "not_applicable";
    this.friction.record(event);
    await this.flush();
  }

  /** Read-only history snapshot. */
  history() {
    return this.engine.history();
  }

  private async ensureSessionDir(): Promise<void> {
    // ALWAYS ensure the directory exists (mkdir recursive is idempotent + cheap).
    // A resumed/opened session is constructed with metaWritten=true on the
    // ASSUMPTION its dir is already on disk — but that's false when the dir was
    // never created (model_switch/setProvider firing before the first turn, or a
    // session opened into a fresh workspace). Gating the mkdir on metaWritten made
    // setProvider's writeFile(metaPath) ENOENT ("no such file … meta.json"). The
    // flag only governs the one-time meta WRITE, not directory creation.
    await mkdir(path.dirname(this.eventsPath), { recursive: true });
    if (this.kernel) {
      const latestPlan = this.kernel.listPlanRevisions(this.meta.id).at(-1);
      const key = latestPlan ? `${latestPlan.id}:${latestPlan.planHash}` : null;
      if (latestPlan && this.mirroredPlanKey !== key) await this.mirrorPlanArtifact(latestPlan);
    }
    if (this.metaWritten) return;
    await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2) + "\n", "utf8");
    this.metaWritten = true;
  }

  /**
   * Enqueue a rollout append WITHOUT blocking the caller. seq is assigned
   * synchronously (preserving order); the actual fs append is serialized on
   * ioChain so writes never interleave and the hot path never waits on disk.
   */
  private persistEvent(event: TurnEvent): void {
    // Live-stream ephemera never lands in the rollout. Replay reconstructs
    // history from turn_start/message_done/tool_end/tool_error/compaction;
    // tool_progress exists only to animate the in-flight UI — and the browser
    // tool's frames are ~85KB of base64 JPEG apiece, which once ballooned a
    // session log to 355MB and froze every full-file reader in the app.
    if (event.type === "tool_progress") return;
    const persistedEvent: TurnEvent =
      event.type === "turn_end"
        ? { ...event, provider: this.meta.provider.name, model: this.meta.provider.model }
        : event.type === "compaction" && this.kernel
          // SQLite is canonical for kernel-backed sessions and already stores
          // the exact projection. Duplicating the entire message history into
          // every JSONL audit event made microcompaction O(history × epochs) and
          // accounted for 290 MiB in one two-hour session. Keep only the small
          // audit facts here; legacy/kernel-less sessions retain the projection.
          ? { ...event, messages: undefined }
          : event;
    const entry: RolloutEntry = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      event: persistedEvent,
    };
    const line = JSON.stringify(entry) + "\n";
    this.ioChain = this.ioChain
      .catch(() => undefined)
      .then(() => appendFile(this.eventsPath, line, "utf8"))
      .then(() => {
        // A later successful append means the fault was transient (Defender /
        // OneDrive briefly locking the file, EPERM/EBUSY). Clear the latch so
        // one hiccup doesn't poison every subsequent flush() with "rollout
        // persistence failed" for the rest of the session.
        if (this.ioError) {
          try {
            process.stderr.write(`[session] rollout persistence recovered (${this.eventsPath})\n`);
          } catch { /* stderr unavailable */ }
          this.ioError = null;
        }
      })
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        // Surface the FIRST failure immediately (disk full, perms, path gone) —
        // the rollout is the durable session history; silently losing it until
        // someone happens to await flush() was how sessions vanished with no
        // trace. Log once (not per-event) so a persistent fault isn't spammy.
        if (!this.ioError) {
          try {
            process.stderr.write(`[session] rollout persistence failing (${this.eventsPath}): ${err.message}\n`);
          } catch { /* stderr unavailable */ }
        }
        this.ioError = err;
      });
  }

  /** Await all pending rollout appends. */
  private async flush(): Promise<void> {
    await Promise.all([this.ioChain, this.friction.settle()]);
    if (this.ioError) {
      throw new Error(`session rollout persistence failed: ${this.ioError.message}`, { cause: this.ioError });
    }
  }

  private persistKernelEvent(event: TurnEvent): void {
    if (!this.kernel || !this.kernelFence) return;
    const fence = this.kernelFence;
    if (event.type === "provider_attempt_superseded") {
      // Provider deltas are disposable UI telemetry, but the decision to
      // abandon an attempt for owner steering is part of canonical execution
      // history. Together with the adjacent input.claimed/input.consumed rows,
      // this proves restart never treated the obsolete draft as authoritative.
      this.kernel.appendEvent(fence, "provider.attempt_superseded", toKernelJson({
        attemptId: event.attemptId,
        reason: event.reason,
      }));
      return;
    }
    if (event.type === "provider_attempt_effects_skipped") {
      // message_done is already canonical in this case. Persist only the audit
      // fact that these never-started proposals were paired and skipped; unlike
      // provider.attempt_superseded, restart must retain the assistant Message.
      this.kernel.appendEvent(fence, "provider.attempt_effects_skipped", toKernelJson({
        attemptId: event.attemptId,
        reason: event.reason,
        toolUseIds: event.toolUseIds,
      }));
      return;
    }
    if (event.type === "message_done") {
      const storedMessageId = kernelStoredMessageId(this.meta.id, event.message.id);
      if (!this.kernel.getMessage(storedMessageId)) {
        this.kernel.appendMessage(fence, {
          id: storedMessageId,
          role: event.message.role,
          model: this.meta.provider.model,
          metadata: kernelMessageMetadata(event.message.metadata, event.message.id),
          parts: event.message.content.map((block) => ({ type: block.type, data: toKernelJson(block) })),
          createdAtMs: protocolMessageCreatedAtMs(event.message.createdAt),
        });
      }
      return;
    }
    if (event.type === "compaction") {
      const projection = event.messages ?? [...this.engine.history()];
      const recap = projection[0]?.content.find((block) => block.type === "system_reminder");
      const storedMessages = this.kernel.listMessages(this.meta.id);
      const hostSourceVersions = this.opts.contextSourceVersions?.() ?? {};
      this.kernel.appendContextEpoch(fence, {
        reason: event.method === "micro" ? "context-microcompaction" : "context-compaction",
        summary: toKernelJson({
          method: event.method,
          summarizedMessages: event.summarizedMessages,
          text: recap?.type === "system_reminder" ? recap.text : "",
        }),
        projection: toKernelJson(projection),
        sourceVersions: {
          ...hostSourceVersions,
          protocol: 1,
          projection: "ares-message-v1",
          lastMessageOrdinal: storedMessages.at(-1)?.ordinal ?? 0,
        },
        tokenCount: event.tokensAfter,
        coalesceLatest: event.method === "micro",
      });
      return;
    }
    if (event.type === "tool_end" || event.type === "tool_error") {
      const messageId = `toolmsg_${createHash("sha256")
        .update(`${this.meta.id}\0${fence.generation}\0${event.id}\0${event.type}`)
        .digest("hex")
        .slice(0, 32)}`;
      if (!this.kernel.getMessage(messageId)) {
        const block: ToolResultBlock = event.type === "tool_end"
          ? {
              type: "tool_result",
              tool_use_id: event.id,
              content: stringifyModelToolOutput(event.output),
            }
          : {
              type: "tool_result",
              tool_use_id: event.id,
              content: event.output === undefined
                ? event.error
                : `${event.error}\n\n${stringifyModelToolOutput(event.output)}`,
              is_error: true,
            };
        this.kernel.appendMessage(fence, {
          id: messageId,
          role: "tool",
          metadata: { source: "tool-result", generation: fence.generation },
          parts: [{ type: "tool_result", data: toKernelJson(block) }],
        });
      }
      return;
    }
    if (event.type === "todo_updated") {
      this.kernel.appendEvent(fence, "todo.updated", toKernelJson({ todos: event.todos }));
      return;
    }
    if (event.type === "turn_end") {
      const outcome = event.workStatus ?? "not_applicable";
      for (const tool of this.kernel.listToolRuns(this.meta.id)) {
        if (tool.generation !== fence.generation || tool.verificationState !== "pending") continue;
        const verification =
          outcome === "verified" ? "verified" :
          outcome === "blocked" ? "blocked" :
          outcome === "unverified" ? "unverified" :
          tool.executionState === "succeeded" ? "not_required" : "blocked";
        this.kernel.setToolVerification(fence, tool.id, verification, {
          turnStatus: event.status,
          workOutcome: outcome,
        });
      }
      this.kernel.appendEvent(fence, "turn.ended", toKernelJson({
        status: event.status,
        workOutcome: outcome,
        usage: event.usage,
        durationMs: event.durationMs,
      }));
      // Only a proof-bearing verified terminal boundary clears canonical
      // mutation debt. Resolve after turn.ended is durable so a crash can be
      // conservatively over-red, never falsely green.
      if (event.status === "completed" && outcome === "verified") {
        this.kernel.resolveSessionMutations(fence);
      }
    }
  }

  private notifyEvent(event: TurnEvent): void {
    for (const observer of this.eventObservers) {
      try {
        observer(event);
      } catch {
        // Observability cannot invalidate a completed tool call or model turn.
      }
    }
  }
}

const KERNEL_WIRE_MESSAGE_ID = "__aresWireMessageId";

/** SQLite message ids are globally unique; provider ids are only scoped to a
 * conversation and several providers legitimately reuse them. */
function kernelStoredMessageId(sessionId: string, wireMessageId: string): string {
  return `kmsg_${createHash("sha256")
    .update(`${sessionId}\0${wireMessageId}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function kernelMessageMetadata(metadata: unknown, wireMessageId: string): JsonValue {
  const encoded = toKernelJson(metadata ?? {});
  if (encoded && typeof encoded === "object" && !Array.isArray(encoded)) {
    return { ...encoded, [KERNEL_WIRE_MESSAGE_ID]: wireMessageId };
  }
  return { [KERNEL_WIRE_MESSAGE_ID]: wireMessageId, providerMetadata: encoded };
}

function toKernelJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value, (_key, child) =>
      typeof child === "bigint" ? child.toString() : child,
    );
    return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
  } catch {
    return { unavailable: true, preview: String(value).slice(0, 2_000) };
  }
}

function errorToKernelJson(error: unknown): JsonValue {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { message: String(error) };
}

function immediateInterruptedTurnEnd(): Extract<TurnEvent, { type: "turn_end" }> {
  return {
    type: "turn_end",
    status: "interrupted",
    workStatus: "not_applicable",
    usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
    durationMs: 0,
  };
}

function messageForKernelInput(sessionId: string, input: AdmittedInputRecord): Message {
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as Record<string, JsonValue>
    : {};
  const rawContent = payload.content;
  if (!Array.isArray(rawContent)) throw new Error(`admitted input ${input.id} has no content array`);
  const id = `msg_${createHash("sha256").update(`${sessionId}\0${input.id}`).digest("hex").slice(0, 32)}`;
  return {
    id,
    role: "user",
    content: rawContent as unknown as ContentBlock[],
    createdAt: new Date(input.admittedAtMs).toISOString(),
    metadata: {
      source: input.delivery === "steer"
        ? "steer"
        : payload.source === "work-item"
          ? "work-item"
          : "user-input",
    },
  };
}

export interface SessionSummary {
  id: string;
  workspace: string;
  provider: ProviderInfo;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  preview: string;
  /** Persisted workflow mode so every client can render the real authority
   * after restart instead of guessing from a transient tool card. */
  workflowMode?: "plan" | "build";
  /** Owner-set custom name (meta.label). Falls back to the preview in the UI. */
  label?: string;
}

export interface SessionSnapshot {
  meta: SessionMeta;
  messages: Message[];
  /** Latest durable TodoWrite state, folded from rollout events. */
  todos: Todo[];
  nextSeq: number;
  eventCount: number;
  preview: string;
  compacted: boolean;
  omittedMessageCount: number;
  replayedMessageCount: number;
}

export interface LoadSessionSnapshotOptions {
  maxMessages?: number;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export async function listSessions(workspace: string, limit = 20): Promise<SessionSummary[]> {
  const kernel = await openExistingWorkspaceSessionKernel(workspace);
  const canonicalRows = kernel?.listSessions({ includeArchived: true }) ?? [];
  // Archived rows protect an in-progress two-phase deletion; permanent
  // tombstones continue protecting the id after final row cleanup.
  const canonicalIds = new Set(canonicalRows.map((session) => session.id));
  const canonical = (kernel
    ? canonicalRows
        .filter((session) => !session.archived)
        .map((session) => canonicalSessionSummary(workspace, kernel, session))
    : []);

  const root = path.join(workspace, ".ares", "sessions");
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const legacy = await Promise.all(
    dirs
      .filter((entry) =>
        entry.isDirectory() &&
        !canonicalIds.has(entry.name) &&
        !kernel?.isSessionTombstoned(entry.name)
      )
      .map(async (entry): Promise<SessionSummary | null> => {
        const sessionDir = path.join(root, entry.name);
        const meta = await readSessionMeta(sessionDir);
        if (!meta) return null;
        const eventsPath = path.join(sessionDir, "events.jsonl");
        const scan = await scanRolloutForListing(eventsPath);
        const updated = await stat(eventsPath).catch(() => null);
        return {
          id: meta.id,
          workspace: meta.workspace,
          provider: meta.provider,
          createdAt: meta.createdAt,
          updatedAt: updated?.mtime.toISOString() ?? meta.createdAt,
          eventCount: scan.eventCount,
          preview: scan.preview,
          workflowMode: meta.workflowMode ?? "build",
          label: meta.label,
        };
      }),
  );
  return [...canonical, ...legacy]
    .filter((s): s is SessionSummary => s !== null)
    // Empty bootstrap husks stay OFF the rail. Every daemon boot creates a
    // fresh primary session; ones the owner never typed into have no preview
    // and no label, and they accumulated one "Saved session" row per app
    // restart. A session earns a rail card by having content or a name.
    .filter((s) => Boolean(s.label) || Boolean(s.preview?.trim()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(0, Math.trunc(limit)));
}

export async function loadSessionSnapshot(
  workspace: string,
  sessionId: string,
  opts: LoadSessionSnapshotOptions = {},
): Promise<SessionSnapshot> {
  const sessionDir = sessionDirectory(workspace, sessionId);
  const eventsPath = path.join(sessionDir, "events.jsonl");
  const kernel = await openExistingWorkspaceSessionKernel(workspace);
  const canonical = kernel?.getSession(sessionId) ?? null;
  if (!canonical && kernel?.isSessionTombstoned(sessionId)) {
    throw new SessionNotFoundError(sessionId);
  }
  // JSONL is only an audit sidecar once a canonical row exists. Resume must
  // remain available when that sidecar is missing or unreadable; legacy-only
  // sessions still require a readable rollout.
  // Canonical sessions reconstruct from SQLite. Parsing a legacy audit sidecar
  // here used to load hundreds of megabytes (mostly duplicated compaction
  // projections) merely to discover its last sequence number.
  const entries = canonical
    ? []
    : parseRolloutEntries(await readOptionalFile(eventsPath));

  let meta: SessionMeta;
  let rawMessages: Message[];
  let todos: Todo[];
  let eventCount: number;
  if (canonical) {
    if (canonical.archived) throw new SessionNotFoundError(sessionId);
    // Once a canonical row exists, every projection error is fatal. Falling
    // back to a stale JSON transcript here can blindly replay settled effects.
    rawMessages = projectMessagesFromKernel(kernel!, sessionId);
    meta = sessionMetaFromKernel(workspace, kernel!, canonical);
    const todoEvent = kernel!.getLatestEvent(sessionId, "todo.updated");
    const durableTodos = todoEvent && typeof todoEvent.payload === "object" && !Array.isArray(todoEvent.payload)
      ? (todoEvent.payload as Record<string, JsonValue>).todos
      : null;
    todos = Array.isArray(durableTodos) ? durableTodos as unknown as Todo[] : [];
    eventCount = kernel!.countEvents(sessionId);
  } else {
    const legacyMeta = await readSessionMeta(sessionDir);
    if (!legacyMeta) throw new SessionNotFoundError(sessionId);
    meta = legacyMeta;
    rawMessages = messagesFromRollout(entries);
    todos = latestTodosFromRollout(entries);
    eventCount = entries.length;
  }
  const replay = compactReplayMessages(rawMessages, sessionId, opts.maxMessages);
  const auditNextSeq = canonical ? await nextRolloutSequenceFromTail(eventsPath) : undefined;
  const nextSeq = canonical
    ? auditNextSeq === undefined
      ? 0
      : auditNextSeq ?? kernel!.countEvents(sessionId)
    : entries.length > 0
      ? Math.max(...entries.map((entry) => entry.seq)) + 1
      : 0;
  return {
    meta,
    messages: replay.messages,
    todos,
    nextSeq,
    eventCount,
    preview: previewFromMessages(rawMessages),
    compacted: replay.compacted,
    omittedMessageCount: replay.omittedMessageCount,
    replayedMessageCount: replay.messages.length,
  };
}

async function openExistingWorkspaceSessionKernel(workspace: string): Promise<SessionKernelStore | null> {
  const filename = workspaceSessionKernelPath(workspace);
  let info;
  try {
    info = await stat(filename);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile()) throw new Error(`session kernel path is not a file: ${filename}`);
  // Do not catch this open. A corrupt/locked/newer canonical database is a
  // recovery error, never permission to continue from a stale JSON audit log.
  return openWorkspaceSessionKernel(workspace);
}

function canonicalSessionSummary(
  workspace: string,
  kernel: SessionKernelStore,
  session: SessionRecord,
): SessionSummary {
  const messages = projectMessagesFromKernel(kernel, session.id);
  const meta = sessionMetaFromKernel(workspace, kernel, session);
  return {
    id: session.id,
    workspace: meta.workspace,
    provider: meta.provider,
    createdAt: meta.createdAt,
    updatedAt: new Date(session.updatedAtMs).toISOString(),
    eventCount: kernel.countEvents(session.id),
    preview: previewFromMessages(messages),
    workflowMode: session.workflowMode,
    ...(session.title ? { label: session.title } : {}),
  };
}

function sessionMetaFromKernel(
  workspace: string,
  kernel: SessionKernelStore,
  session: SessionRecord,
): SessionMeta {
  const metadata = session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata)
    ? session.metadata as Record<string, JsonValue>
    : {};
  const records = kernel.listMessages(session.id);
  const recordedModel = [...records].reverse().find((message) => message.model)?.model;
  const provider = typeof metadata.provider === "string" && metadata.provider.trim()
    ? metadata.provider
    : "unknown";
  const model = typeof metadata.model === "string" && metadata.model.trim()
    ? metadata.model
    : recordedModel ?? "unknown";
  const createdAt = typeof metadata.createdAt === "string" && metadata.createdAt.trim()
    ? metadata.createdAt
    : new Date(session.createdAtMs).toISOString();
  return {
    id: session.id,
    workspace: session.workspaceKey ?? path.resolve(workspace),
    provider: { name: provider, model },
    createdAt,
    workflowMode: session.workflowMode,
    ...(session.title ? { label: session.title } : {}),
  };
}

function sessionDirectory(workspace: string, sessionId: string): string {
  const safe = path.basename(sessionId);
  if (!safe || safe !== sessionId) throw new SessionNotFoundError(sessionId);
  return path.join(workspace, ".ares", "sessions", safe);
}

async function readOptionalFile(filename: string): Promise<string> {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return "";
    throw error;
  }
}

/** Read only the tail of the portable JSONL audit to recover its sequence.
 * SQLite-backed resume never needs the event bodies. If an old gigantic final
 * line exceeds the bounded window, callers fall back to the monotonic kernel
 * event sequence instead of allocating the whole file. */
async function nextRolloutSequenceFromTail(filename: string): Promise<number | null | undefined> {
  let handle;
  try {
    handle = await open(filename, "r");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.size <= 0) return 0;
    const length = Math.min(info.size, 256 * 1024);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (info.size > length) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as { seq?: unknown };
        if (typeof entry.seq === "number" && Number.isFinite(entry.seq)) {
          return Math.max(0, Math.floor(entry.seq) + 1);
        }
      } catch {
        // A torn final line is expected after a crash; inspect the one before it.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Deterministic canonical-store projector used by resume and recovery tests. */
export function projectMessagesFromKernel(kernel: SessionKernelStore, sessionId: string): Message[] {
  const epoch = kernel.getLatestContextEpoch(sessionId);
  let messages: Message[] = [];
  let afterOrdinal = 0;
  if (epoch && Array.isArray(epoch.projection)) {
    messages = (epoch.projection as unknown as Message[]).map((message) => ({
      ...message,
      content: message.content.map((block) => ({ ...block })),
    }));
    if (epoch.sourceVersions && typeof epoch.sourceVersions === "object" && !Array.isArray(epoch.sourceVersions)) {
      const ordinal = (epoch.sourceVersions as Record<string, JsonValue>).lastMessageOrdinal;
      if (typeof ordinal === "number") afterOrdinal = ordinal;
    }
  }
  const records = kernel.listMessages(sessionId, afterOrdinal);
  let pendingToolResults: ToolResultBlock[] = [];
  let pendingToolCreatedAtMs: number | null = null;
  const flushTools = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({
      id: `kernel_tools_${sessionId}_${messages.length}`,
      role: "user",
      content: pendingToolResults,
      createdAt: new Date(pendingToolCreatedAtMs ?? 0).toISOString(),
      metadata: { source: "session-kernel" },
    });
    pendingToolResults = [];
    pendingToolCreatedAtMs = null;
  };
  for (const record of records) {
    const blocks = record.parts.map((part) => part.data as unknown as ContentBlock);
    if (record.role === "tool") {
      if (pendingToolCreatedAtMs === null) pendingToolCreatedAtMs = record.createdAtMs;
      for (const block of blocks) if (block.type === "tool_result") pendingToolResults.push(block);
      continue;
    }
    flushTools();
    messages.push(kernelRecordToMessage(record, blocks));
  }
  flushTools();
  return repairSettledToolPairs(kernel, sessionId, messages);
}

/** Repair the narrow crash window between durable tool settlement and the
 * model-visible tool_result projection. Provider conversations must never
 * resume with a dangling assistant tool_use: that can provoke an invalid
 * request or a blind duplicate mutation. The tool ledger is authoritative. */
function repairSettledToolPairs(
  kernel: SessionKernelStore,
  sessionId: string,
  input: readonly Message[],
): Message[] {
  const messages = input.map((message) => ({
    ...message,
    content: message.content.map((block) => ({ ...block })),
  }));
  const runsByUseId = new Map<string, ReturnType<SessionKernelStore["listToolRuns"]>[number]>();
  for (const run of kernel.listToolRuns(sessionId)) {
    const separator = run.callKey.indexOf(":");
    const toolUseId = separator >= 0 ? run.callKey.slice(separator + 1) : run.callKey;
    const prior = runsByUseId.get(toolUseId);
    if (!prior || run.createdAtMs >= prior.createdAtMs) runsByUseId.set(toolUseId, run);
  }

  for (let index = 0; index < messages.length; index++) {
    const assistant = messages[index];
    if (assistant.role !== "assistant") continue;
    const uses = assistant.content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
    if (uses.length === 0) continue;

    const next = messages[index + 1];
    const nextIsToolResults = next?.role === "user" && next.content.some((block) => block.type === "tool_result");
    const existing = new Map<string, ToolResultBlock>();
    if (nextIsToolResults) {
      for (const block of next.content) {
        if (block.type === "tool_result") existing.set(block.tool_use_id, block);
      }
    }
    for (const use of uses) {
      if (existing.has(use.id)) continue;
      const run = runsByUseId.get(use.id);
      existing.set(use.id, recoveredToolResult(use.id, use.name, run));
    }

    // Normalize even a complete projection. Parallel tool settlements are
    // persisted in completion order, but providers require the result batch to
    // follow the assistant's tool_use order on every live and restart path.
    const ordered = uses.map((use) => existing.get(use.id)!).filter(Boolean);
    if (nextIsToolResults) {
      const useIds = new Set(uses.map((use) => use.id));
      const extraToolResults = next.content.filter(
        (block): block is ToolResultBlock => block.type === "tool_result" && !useIds.has(block.tool_use_id),
      );
      const nonToolBlocks = next.content.filter((block) => block.type !== "tool_result");
      messages[index + 1] = { ...next, content: [...ordered, ...extraToolResults, ...nonToolBlocks] };
    } else {
      messages.splice(index + 1, 0, {
        id: `kernel_recovered_tools_${sessionId}_${index}`,
        role: "user",
        content: ordered,
        createdAt: new Date().toISOString(),
        metadata: { source: "session-kernel-recovery" },
      });
      index += 1;
    }
  }
  return messages;
}

function recoveredToolResult(
  toolUseId: string,
  toolName: string,
  run: ReturnType<SessionKernelStore["listToolRuns"]>[number] | undefined,
): ToolResultBlock {
  if (run?.executionState === "succeeded") {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: stringifyModelToolOutput(run.result),
    };
  }
  if (run?.executionState === "failed") {
    const failure = kernelToolErrorText(run.error) || `${toolName} failed before its result reached the model.`;
    // A declared failure may still have a complete, authoritative result (the
    // shell contract records stdout/stderr/exit/timedOut this way). Preserve it
    // across the post-settlement crash window instead of degrading recovery to
    // the short error string and forcing the model to rerun for diagnostics.
    const diagnostics = run.result === null ? "" : stringifyModelToolOutput(run.result);
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: diagnostics ? `${failure}\n\n${diagnostics}` : failure,
      is_error: true,
    };
  }
  if (run?.executionState === "effect_unknown" || run?.executionState === "executing") {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: `${toolName} was interrupted with an unknown effect. Do not blindly retry; inspect or reconcile the target state first.`,
      is_error: true,
    };
  }
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: run
      ? `${toolName} did not cross a settled execution boundary. No successful effect is recorded; re-evaluate before retrying.`
      : `${toolName} has no durable execution record. It did not cross the harness admission boundary and may be planned again.`,
    is_error: true,
  };
}

function kernelToolErrorText(error: JsonValue | null): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, JsonValue>).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function kernelRecordToMessage(record: MessageRecord, content: ContentBlock[]): Message {
  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? { ...(record.metadata as Record<string, JsonValue>) }
    : null;
  const wireId = typeof metadata?.[KERNEL_WIRE_MESSAGE_ID] === "string"
    ? metadata[KERNEL_WIRE_MESSAGE_ID] as string
    : record.id;
  if (metadata) delete metadata[KERNEL_WIRE_MESSAGE_ID];
  return {
    // Provider message IDs are part of the wire conversation and must be
    // restored exactly even though SQLite uses a session-namespaced primary key.
    id: wireId,
    role: record.role === "tool" ? "user" : record.role,
    content,
    createdAt: new Date(record.createdAtMs).toISOString(),
    ...(metadata && Object.keys(metadata).length > 0
      ? { metadata: metadata as Message["metadata"] }
      : {}),
  };
}

function protocolMessageCreatedAtMs(createdAt: string): number | undefined {
  const parsed = Date.parse(createdAt);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function latestTodosFromRollout(entries: readonly RolloutEntry[]): Todo[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index].event;
    if (event.type === "todo_updated") return event.todos.map((todo) => ({ ...todo }));
  }
  return [];
}

/** The FULL raw rollout for a session — every persisted event, untouched by
 *  the compaction that loadSessionSnapshot applies. This is what a bug report
 *  ships so the owner can see exactly what the agent did: every tool call, its
 *  input/output, every error, and all generated code. Never trims content. */
export interface SessionRollout {
  meta: SessionMeta;
  entries: RolloutEntry[];
  eventCount: number;
  toolFailures: number;
}

export async function loadSessionRollout(workspace: string, sessionId: string): Promise<SessionRollout> {
  const sessionDir = sessionDirectory(workspace, sessionId);
  const kernel = await openExistingWorkspaceSessionKernel(workspace);
  const canonical = kernel?.getSession(sessionId) ?? null;
  if (canonical?.archived) throw new SessionNotFoundError(sessionId);
  if (!canonical && kernel?.isSessionTombstoned(sessionId)) throw new SessionNotFoundError(sessionId);
  const meta = canonical
    ? sessionMetaFromKernel(workspace, kernel!, canonical)
    : await readSessionMeta(sessionDir);
  if (!meta) throw new SessionNotFoundError(sessionId);
  const eventsText = await readOptionalFile(path.join(sessionDir, "events.jsonl"));
  const entries = parseRolloutEntries(eventsText);
  const toolFailures = entries.filter((e) => e.event.type === "tool_error").length;
  return { meta, entries, eventCount: entries.length, toolFailures };
}

/** Permanently remove a session's on-disk transcript + metadata. Idempotent:
 *  a missing session resolves false rather than throwing. */
export async function deleteSession(workspace: string, sessionId: string): Promise<boolean> {
  let sessionDir: string;
  try {
    sessionDir = sessionDirectory(workspace, sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) return false;
    throw error;
  }
  const kernel = await openExistingWorkspaceSessionKernel(workspace);
  const canonical = kernel?.getSession(sessionId) ?? null;
  if (canonical) {
    // Tombstone the whole child tree before touching JSON. If the process dies
    // mid-cleanup, list/resume still see the canonical archived rows and cannot
    // resurrect stale transcripts. Final purge happens only after every audit
    // directory is gone.
    const tree = kernel!.prepareSessionDeletion(sessionId);
    for (const session of tree) {
      await rm(sessionDirectory(workspace, session.id), { recursive: true, force: true });
    }
    return kernel!.finalizeSessionDeletion(sessionId);
  }
  if (kernel?.isSessionTombstoned(sessionId)) {
    // A restored sidecar is inert. Cleaning it is best-effort/idempotent; the
    // already-committed deletion remains authoritative even if this rm fails.
    await rm(sessionDir, { recursive: true, force: true });
    return false;
  }
  const meta = await readSessionMeta(sessionDir);
  if (!meta) return false;
  // Legacy-only sessions have no row to archive. Commit the durable identity
  // barrier before deleting JSON so a crash or backup restore cannot make it
  // resumable again. Opening the kernel here intentionally upgrades deletion
  // from filesystem-only semantics even in an otherwise legacy workspace.
  const authority = kernel ?? await openWorkspaceSessionKernel(workspace);
  const recorded = authority.recordSessionTombstone({
    sessionId,
    rootSessionId: sessionId,
    workspaceKey: path.resolve(workspace),
    deletionSource: "legacy",
  });
  await rm(sessionDir, { recursive: true, force: true });
  return recorded.inserted;
}

/** Rename a session by setting its meta.label. Empty/whitespace clears the label
 *  (the UI falls back to the preview). Returns false if the session is missing. */
export async function renameSession(workspace: string, sessionId: string, label: string): Promise<boolean> {
  let sessionDir: string;
  try {
    sessionDir = sessionDirectory(workspace, sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) return false;
    throw error;
  }
  const kernel = await openExistingWorkspaceSessionKernel(workspace);
  const canonical = kernel?.getSession(sessionId) ?? null;
  const trimmed = label.trim().slice(0, 120);
  if (canonical) {
    if (canonical.archived) return false;
    kernel!.setSessionTitle(sessionId, trimmed || null);
    // Keep the human-readable sidecar useful, but never make its availability
    // part of canonical rename success.
    const next = sessionMetaFromKernel(workspace, kernel!, kernel!.requireSession(sessionId));
    await mkdir(sessionDir, { recursive: true }).then(() =>
      writeFile(path.join(sessionDir, "meta.json"), JSON.stringify(next, null, 2) + "\n", "utf8"),
    ).catch(() => undefined);
    return true;
  }
  if (kernel?.isSessionTombstoned(sessionId)) return false;
  const meta = await readSessionMeta(sessionDir);
  if (!meta) return false;
  const next: SessionMeta = { ...meta };
  if (trimmed) next.label = trimmed;
  else delete next.label;
  await writeFile(path.join(sessionDir, "meta.json"), JSON.stringify(next, null, 2) + "\n", "utf8");
  return true;
}

async function readSessionMeta(sessionDir: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

function parseRolloutEntries(text: string): RolloutEntry[] {
  const entries: RolloutEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as RolloutEntry);
    } catch {
      // Ignore a torn/corrupt tail line; the next append stays usable.
    }
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

function messagesFromRollout(entries: readonly RolloutEntry[]): Message[] {
  const messages: Message[] = [];
  let pendingToolResults: ToolResultBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({
      id: `replay_tool_${messages.length}`,
      role: "user", // Anthropic shape: tool_result blocks live in user-role messages
      content: pendingToolResults,
      createdAt: new Date().toISOString(),
      metadata: { source: "session-replay" },
    });
    pendingToolResults = [];
  };

  for (const entry of entries) {
    const event = entry.event;
    if (event.type === "input_admitted" || event.type === "turn_start") {
      flushToolResults();
      // `turn_start` may be emitted repeatedly when a settled prompt is retried
      // after provider failover. Stable message identity makes replay an upsert,
      // not an inference that every lifecycle event is a new user message.
      const existing = messages.findIndex((message) => message.id === event.userMessage.id);
      if (existing >= 0) messages[existing] = event.userMessage;
      else messages.push(event.userMessage);
      continue;
    }
    if (event.type === "message_done") {
      flushToolResults();
      messages.push(event.message);
      continue;
    }
    if (event.type === "tool_end") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: event.id,
        content: stringifyReplayOutput(event.output),
      });
      continue;
    }
    if (event.type === "tool_error") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: event.id,
        content: event.output === undefined
          ? event.error
          : `${event.error}\n\n${stringifyReplayOutput(event.output)}`,
        is_error: true,
      });
      continue;
    }
    if (event.type === "compaction" && Array.isArray(event.messages)) {
      pendingToolResults = [];
      messages.length = 0;
      messages.push(...event.messages);
    }
  }
  flushToolResults();
  return messages;
}

function stringifyReplayOutput(output: unknown): string {
  return stringifyModelToolOutput(output);
}

function compactReplayMessages(
  messages: readonly Message[],
  sessionId: string,
  maxMessages?: number,
): { messages: Message[]; compacted: boolean; omittedMessageCount: number } {
  if (!maxMessages || messages.length <= maxMessages) {
    return { messages: [...messages], compacted: false, omittedMessageCount: 0 };
  }

  const tailBudget = Math.max(4, maxMessages - 1);
  const tail = messages.slice(-tailBudget);
  while (tail.length > 0 && tail[0].role !== "user") tail.shift();
  if (tail.length === 0) tail.push(...messages.slice(-Math.min(tailBudget, messages.length)));

  const omitted = messages.slice(0, messages.length - tail.length);
  const summary: Message = {
    id: `session_summary_${sessionId}`,
    role: "system",
    content: [{ type: "text", text: buildReplaySummary(sessionId, omitted) }],
    createdAt: new Date().toISOString(),
    metadata: { source: "session-replay-compaction", omittedMessageCount: omitted.length },
  };
  return {
    messages: [summary, ...tail],
    compacted: true,
    omittedMessageCount: omitted.length,
  };
}

function buildReplaySummary(sessionId: string, omitted: readonly Message[]): string {
  const roleCounts = omitted.reduce<Record<string, number>>((counts, message) => {
    counts[message.role] = (counts[message.role] ?? 0) + 1;
    return counts;
  }, {});
  const toolResults = omitted.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
  const errorCount = toolResults.filter((block) => block.type === "tool_result" && block.is_error).length;
  const recentUsers = omitted
    .filter((message) => message.role === "user")
    .map((message) => messageText(message).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-8);
  const recentAssistants = omitted
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-5);

  const lines = [
    `Previous Ares session ${sessionId} was compacted before resume.`,
    `Older replay omitted ${omitted.length} message(s): user=${roleCounts.user ?? 0}, assistant=${roleCounts.assistant ?? 0}, tool=${roleCounts.tool ?? 0}.`,
    `Omitted tool result blocks: ${toolResults.length}, errors: ${errorCount}.`,
  ];
  if (recentUsers.length > 0) {
    lines.push("Recent omitted user requests:");
    for (const text of recentUsers) lines.push(`- ${truncateSummaryText(text)}`);
  }
  if (recentAssistants.length > 0) {
    lines.push("Recent omitted assistant replies:");
    for (const text of recentAssistants) lines.push(`- ${truncateSummaryText(text)}`);
  }
  lines.push("The exact event log remains on disk under .ares/sessions if a tool needs to inspect it.");
  return lines.join("\n");
}

function truncateSummaryText(text: string): string {
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

/**
 * One bounded pass over a rollout for the session picker: count events and
 * find the newest user words WITHOUT loading the file into memory. The picker
 * lists every session on disk, so it must never pay for a pathological log —
 * a filmstrip-heavy rollout once reached 355MB and a readFile-per-session
 * listing froze the whole app. Only the last turn_start (and, if newer, the
 * last compaction snapshot) is ever parsed.
 */
async function scanRolloutForListing(eventsPath: string): Promise<{ eventCount: number; preview: string }> {
  let eventCount = 0;
  let lastTurnStart = "";
  let lastCompaction = "";
  let compactionIsNewer = false;
  try {
    const lines = createInterface({ input: createReadStream(eventsPath, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      eventCount += 1;
      // The entry's own event tag is the only place this substring appears
      // unescaped — the same text inside message content is quote-escaped.
      if (line.includes('"event":{"type":"turn_start"')) {
        lastTurnStart = line;
        compactionIsNewer = false;
      } else if (line.includes('"event":{"type":"compaction"')) {
        lastCompaction = line;
        compactionIsNewer = true;
      }
    }
  } catch {
    return { eventCount: 0, preview: "" };
  }
  const candidates = compactionIsNewer ? [lastCompaction, lastTurnStart] : [lastTurnStart, lastCompaction];
  for (const raw of candidates) {
    if (!raw) continue;
    const event = parseRolloutEntries(raw)[0]?.event;
    if (event?.type === "turn_start") {
      const preview = previewFromMessages([event.userMessage]);
      if (preview) return { eventCount, preview };
    } else if (event?.type === "compaction" && Array.isArray(event.messages)) {
      const preview = previewFromMessages(event.messages);
      if (preview) return { eventCount, preview };
    }
  }
  return { eventCount, preview: "" };
}

function previewFromMessages(messages: readonly Message[]): string {
  // Walk PAST user-role messages that carry no prose. Tool results are
  // projected as user messages of tool_result blocks — and a session closed
  // mid-tool gets one appended by repairSettledToolPairs — so "the last user
  // message" is often text-less. An empty preview here gets the whole session
  // husk-filtered off the rail on relaunch, so keep walking back to the last
  // thing the owner actually typed.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = messageText(message).replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    return text.length > 90 ? `${text.slice(0, 87)}...` : text;
  }
  return "";
}
