/**
 * Canonical types for the durable session kernel.
 *
 * The kernel deliberately separates transport/execution state from work truth.
 * A run may have finished successfully while the requested work is still
 * unverified or blocked.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type InputDelivery = "queue" | "steer";
export type InputState = "admitted" | "claimed" | "consumed" | "cancelled";

export type ExecutionState =
  | "idle"
  | "admitted"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed";

export type WorkOutcome = "not_applicable" | "pending" | "verified" | "unverified" | "blocked";
export type WorkflowMode = "plan" | "build";

export type BackgroundJobKind = "shell" | "task";
export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ToolExecutionState =
  | "proposed"
  | "validated"
  | "authorized"
  | "checkpointed"
  | "executing"
  | "succeeded"
  | "failed"
  | "effect_unknown";

export type ToolVerificationState = "pending" | "not_required" | "verified" | "unverified" | "blocked";

export type PlanStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "superseded"
  | "executing"
  | "completed"
  | "failed";

export interface SessionRecord {
  id: string;
  parentSessionId: string | null;
  rootSessionId: string;
  workspaceKey: string | null;
  title: string | null;
  metadata: JsonValue | null;
  currentGeneration: number;
  executionState: ExecutionState;
  workOutcome: WorkOutcome;
  currentContextEpoch: number;
  workflowMode: WorkflowMode;
  archived: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export type SessionDeletionSource = "canonical" | "legacy";

/** Append-only proof that a session identity was permanently deleted. Unlike
 * an archived session row, this record survives final canonical row cleanup. */
export interface SessionTombstoneRecord {
  sessionId: string;
  parentSessionId: string | null;
  rootSessionId: string;
  workspaceKey: string | null;
  deletionSource: SessionDeletionSource;
  deletedAtMs: number;
}

export interface SessionLinkRecord {
  parentSessionId: string;
  childSessionId: string;
  relation: string;
  externalKey: string | null;
  metadata: JsonValue | null;
  createdAtMs: number;
}

export interface AdmittedInputRecord {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  delivery: InputDelivery;
  payload: JsonValue;
  state: InputState;
  /** Monotonic per-session order assigned transactionally at admission. Wall
   * clock ties and caller-chosen ids never decide FIFO ownership. */
  admissionSequence: number;
  claimedGeneration: number | null;
  admittedAtMs: number;
  claimedAtMs: number | null;
  consumedAtMs: number | null;
}

export interface MessagePartInput {
  id?: string;
  type: string;
  data: JsonValue;
}

export interface MessagePartRecord {
  id: string;
  messageId: string;
  ordinal: number;
  type: string;
  data: JsonValue;
  createdAtMs: number;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  inputId: string | null;
  ordinal: number;
  role: MessageRole;
  agent: string | null;
  model: string | null;
  metadata: JsonValue | null;
  parts: MessagePartRecord[];
  createdAtMs: number;
}

export interface ToolRunRecord {
  id: string;
  sessionId: string;
  messageId: string | null;
  generation: number;
  callKey: string;
  attempt: number;
  toolName: string;
  executionState: ToolExecutionState;
  verificationState: ToolVerificationState;
  arguments: JsonValue;
  result: JsonValue | null;
  error: JsonValue | null;
  checkpointId: string | null;
  effectKind: string | null;
  mutationTransactionId: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  settledAtMs: number | null;
}

export interface ContextEpochRecord {
  id: string;
  sessionId: string;
  epoch: number;
  previousEpochId: string | null;
  generation: number;
  reason: string;
  summary: JsonValue;
  projection: JsonValue;
  sourceVersions: JsonValue;
  baseEventSequence: number | null;
  tokenCount: number | null;
  createdAtMs: number;
}

export interface PlanRevisionRecord {
  id: string;
  sessionId: string;
  revision: number;
  body: string;
  planHash: string;
  status: PlanStatus;
  author: string | null;
  metadata: JsonValue | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PlanApprovalRecord {
  id: string;
  planRevisionId: string;
  approver: string;
  decision: "approved" | "rejected";
  planHash: string;
  metadata: JsonValue | null;
  createdAtMs: number;
}

export interface SessionEventRecord {
  sequence: number;
  id: string;
  sessionId: string;
  generation: number | null;
  type: string;
  payload: JsonValue;
  createdAtMs: number;
}

export interface SessionRunRecord {
  sessionId: string;
  generation: number;
  runnerId: string;
  executionState: ExecutionState;
  workOutcome: WorkOutcome;
  startedAtMs: number;
  endedAtMs: number | null;
  error: JsonValue | null;
}

/** Exactly-once terminal delivery for an input whose original caller stream no
 * longer exists. Canonical messages hold the body; this row is the durable
 * acknowledgement a restarted host can query without replaying the request. */
export interface DetachedInputResultRecord {
  inputId: string;
  sessionId: string;
  generation: number;
  executionState: "completed";
  workOutcome: WorkOutcome;
  outputMessageId: string | null;
  settledAtMs: number;
}

/** Canonical affected-file scope tied to the generation/tool settlement that
 * observed it. Rows remain unresolved until a proof-bearing verified turn
 * clears them under a later/current fence. */
export interface SessionMutationRecord {
  id: string;
  sessionId: string;
  generation: number;
  toolRunId: string;
  toolUseId: string;
  affectedPaths: string[];
  scopeComplete: boolean;
  resolvedGeneration: number | null;
  observedAtMs: number;
  resolvedAtMs: number | null;
}

export interface RecordSessionMutationInput {
  toolRunId: string;
  toolUseId: string;
  affectedPaths: readonly string[];
  scopeComplete?: boolean;
}

export interface SettleDetachedInputResultInput {
  workOutcome: WorkOutcome;
  outputMessageId?: string | null;
}

/** Durable ownership and result ledger for work intentionally detached from a
 * foreground model turn. Output bodies live in an append-only spool; SQLite
 * stores their identity, byte extent, per-consumer cursors, and terminal truth. */
export interface BackgroundJobRecord {
  id: string;
  sessionId: string;
  invocationKey: string;
  kind: BackgroundJobKind;
  status: BackgroundJobStatus;
  description: string;
  request: JsonValue;
  result: JsonValue | null;
  error: JsonValue | null;
  childSessionId: string | null;
  pid: number | null;
  processToken: string | null;
  statePath: string | null;
  outputPath: string | null;
  outputBytes: number;
  exitCode: number | null;
  ownerId: string | null;
  leaseExpiresAtMs: number | null;
  cancelRequested: boolean;
  completionInputId: string | null;
  revision: number;
  createdAtMs: number;
  startedAtMs: number | null;
  heartbeatAtMs: number | null;
  finishedAtMs: number | null;
  updatedAtMs: number;
}

export interface RunFence {
  sessionId: string;
  generation: number;
  leaseToken: string;
}

export interface RunnerLease extends RunFence {
  ownerId: string;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
}

export interface CreateSessionInput {
  id?: string;
  workspaceKey?: string | null;
  title?: string | null;
  metadata?: JsonValue | null;
}

export interface CreateChildSessionInput extends CreateSessionInput {
  parentSessionId: string;
  relation: string;
  /** Stable task/fleet/operator key used to make child creation idempotent. */
  externalKey?: string | null;
  linkMetadata?: JsonValue | null;
}

export interface RecordSessionTombstoneInput {
  sessionId: string;
  parentSessionId?: string | null;
  rootSessionId?: string;
  workspaceKey?: string | null;
  deletionSource: SessionDeletionSource;
}

export interface AdmitInput {
  id?: string;
  sessionId: string;
  idempotencyKey: string;
  delivery: InputDelivery;
  payload: JsonValue;
}

/** Atomically make one admitted request terminal. A claimed request may only
 * be cancelled by the generation that owns it; an unclaimed request can be
 * cancelled by durable input identity before a runner starts. */
export interface CancelInputInput {
  sessionId: string;
  fence?: RunFence;
  /** Control-plane cancellation may use an exact claimed-generation CAS even
   * after that runner's lease expires. This cannot affect a replacement claim. */
  expectedGeneration?: number;
  reason?: JsonValue;
}

export interface CreateBackgroundJobInput {
  id?: string;
  sessionId: string;
  invocationKey: string;
  kind: BackgroundJobKind;
  description: string;
  request: JsonValue;
  childSessionId?: string | null;
  processToken?: string | null;
  statePath?: string | null;
  outputPath?: string | null;
}

export interface SettleBackgroundJobInput {
  status: Extract<BackgroundJobStatus, "completed" | "failed" | "cancelled" | "orphaned">;
  result?: JsonValue | null;
  error?: JsonValue | null;
  exitCode?: number | null;
  outputBytes?: number;
  /** When present, terminal settlement and owner-session notification are one
   * transaction. The stable input id/key makes repeated recovery idempotent. */
  completion?: {
    id: string;
    idempotencyKey: string;
    payload: JsonValue;
  };
}

export interface AppendMessageInput {
  id?: string;
  inputId?: string | null;
  role: MessageRole;
  agent?: string | null;
  model?: string | null;
  metadata?: JsonValue | null;
  parts?: readonly MessagePartInput[];
  /** Preserve the protocol message timestamp when the host already assigned
   * one. Omitting it uses the canonical store clock. */
  createdAtMs?: number;
}

export interface BeginToolRunInput {
  id?: string;
  messageId?: string | null;
  callKey: string;
  attempt?: number;
  toolName: string;
  arguments: JsonValue;
  effectKind?: string | null;
  mutationTransactionId?: string | null;
}

export interface ReconcileToolRunEffectInput {
  disposition: "fully_applied" | "not_applied" | "mixed" | "diverged";
  evidence: JsonValue;
  /** Identifies the observational authority that produced the disposition. */
  source?: "workspace-mutation" | "tool-reconciler" | "owner";
  retryPolicy?: "never" | "after-reconciled-not-applied" | "idempotent-with-key";
  reconcilerKey?: string | null;
  recoveredResult?: JsonValue | null;
  reason?: string | null;
  /** Canonical affected-file scope discovered by reconciliation. Commits with
   * the recovered disposition so a second crash cannot lose verifier debt. */
  mutation?: Omit<RecordSessionMutationInput, "toolRunId">;
}

export interface TransitionToolRunInput {
  expectedRevision?: number;
  result?: JsonValue | null;
  error?: JsonValue | null;
  checkpointId?: string | null;
  effectKind?: string | null;
  /** When terminal settlement has affected-file evidence, commit it in the
   * same transaction as the tool result so restart never needs JSONL scope. */
  mutation?: Omit<RecordSessionMutationInput, "toolRunId">;
}

export interface AppendContextEpochInput {
  id?: string;
  reason: string;
  summary: JsonValue;
  projection: JsonValue;
  sourceVersions?: JsonValue;
  baseEventSequence?: number | null;
  tokenCount?: number | null;
  /** Refresh the latest epoch in place when it has this reason and belongs to
   * the same generation. Intended for high-frequency, lossless projections such
   * as microcompaction; full semantic compactions remain immutable epochs. */
  coalesceLatest?: boolean;
}

export interface CreatePlanRevisionInput {
  id?: string;
  sessionId: string;
  body: string;
  author?: string | null;
  metadata?: JsonValue | null;
  fence?: RunFence;
}

export interface DecidePlanInput {
  planRevisionId: string;
  expectedPlanHash: string;
  approver: string;
  decision: "approved" | "rejected";
  metadata?: JsonValue | null;
}

/** One owner-approved transition from an immutable plan revision into build
 * authority. Approval, workflow mode, and the synthetic build handoff input
 * commit in one SQLite transaction so a crash cannot expose only half of the
 * transition. */
export interface ApprovePlanForBuildInput {
  planRevisionId: string;
  expectedPlanHash: string;
  approver: string;
  metadata?: JsonValue | null;
  handoff: {
    id: string;
    idempotencyKey: string;
    payload: JsonValue;
  };
}

export interface ApprovedPlanBuildHandoff {
  plan: PlanRevisionRecord;
  approval: PlanApprovalRecord;
  input: AdmittedInputRecord;
  inputInserted: boolean;
  session: SessionRecord;
}

export interface ReleaseLeaseInput {
  executionState: Exclude<ExecutionState, "running">;
  workOutcome: WorkOutcome;
  error?: JsonValue | null;
}

export interface SessionSnapshot {
  session: SessionRecord;
  lease: RunnerLease | null;
  latestRun: SessionRunRecord | null;
  pendingInputs: AdmittedInputRecord[];
  latestContextEpoch: ContextEpochRecord | null;
  activePlan: PlanRevisionRecord | null;
}
