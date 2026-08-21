import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  IdempotencyConflictError,
  InvalidStateTransitionError,
  LeaseHeldError,
  PlanConflictError,
  RevisionConflictError,
  SessionKernelError,
  SessionNotFoundError,
  StaleGenerationError,
} from "./errors.js";
import { canonicalJson, parseJson } from "./json.js";
import {
  configureSessionKernelDatabase,
  LATEST_SESSION_KERNEL_SCHEMA_VERSION,
  migrateSessionKernelDatabase,
} from "./migrations.js";
import { loadBetterSqlite3, type BetterSqlite3Constructor, type SqliteDatabase } from "./sqlite.js";
import type {
  AdmitInput,
  AdmittedInputRecord,
  BackgroundJobRecord,
  BackgroundJobStatus,
  ApprovedPlanBuildHandoff,
  ApprovePlanForBuildInput,
  AppendContextEpochInput,
  AppendMessageInput,
  BeginToolRunInput,
  CancelInputInput,
  ContextEpochRecord,
  CreateChildSessionInput,
  CreateBackgroundJobInput,
  CreatePlanRevisionInput,
  CreateSessionInput,
  DecidePlanInput,
  DetachedInputResultRecord,
  ExecutionState,
  InputDelivery,
  JsonValue,
  MessagePartRecord,
  MessageRecord,
  PlanApprovalRecord,
  PlanRevisionRecord,
  PlanStatus,
  ReleaseLeaseInput,
  RecordSessionTombstoneInput,
  RecordSessionMutationInput,
  ReconcileToolRunEffectInput,
  RunFence,
  RunnerLease,
  SessionEventRecord,
  SessionLinkRecord,
  SessionMutationRecord,
  SessionRecord,
  SessionRunRecord,
  SettleDetachedInputResultInput,
  SessionSnapshot,
  SessionTombstoneRecord,
  SessionDeletionSource,
  SettleBackgroundJobInput,
  ToolExecutionState,
  ToolRunRecord,
  ToolVerificationState,
  TransitionToolRunInput,
  WorkOutcome,
  WorkflowMode,
} from "./types.js";

const DEFAULT_LEASE_TTL_MS = 30_000;
const MIN_LEASE_TTL_MS = 250;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface OpenSessionKernelOptions {
  filename: string;
  Database?: BetterSqlite3Constructor;
  now?: () => number;
  idFactory?: (kind: string) => string;
}

export interface SessionKernelStoreOptions {
  now?: () => number;
  idFactory?: (kind: string) => string;
  configure?: boolean;
  migrate?: boolean;
}

interface SessionRow {
  id: string;
  parent_session_id: string | null;
  root_session_id: string;
  workspace_key: string | null;
  title: string | null;
  metadata_json: string | null;
  current_generation: number;
  execution_state: ExecutionState;
  work_outcome: WorkOutcome;
  current_context_epoch: number;
  workflow_mode: WorkflowMode;
  archived: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface SessionTombstoneRow {
  session_id: string;
  parent_session_id: string | null;
  root_session_id: string;
  workspace_key: string | null;
  deletion_source: SessionDeletionSource;
  deleted_at_ms: number;
}

interface InputRow {
  id: string;
  session_id: string;
  idempotency_key: string;
  delivery: InputDelivery;
  payload_json: string;
  state: AdmittedInputRecord["state"];
  admission_sequence: number;
  claimed_generation: number | null;
  admitted_at_ms: number;
  claimed_at_ms: number | null;
  consumed_at_ms: number | null;
}

interface LeaseRow {
  session_id: string;
  generation: number;
  owner_id: string;
  lease_token: string;
  acquired_at_ms: number;
  renewed_at_ms: number;
  expires_at_ms: number;
}

interface RunRow {
  session_id: string;
  generation: number;
  runner_id: string;
  execution_state: ExecutionState;
  work_outcome: WorkOutcome;
  started_at_ms: number;
  ended_at_ms: number | null;
  error_json: string | null;
}

interface DetachedInputResultRow {
  input_id: string;
  session_id: string;
  generation: number;
  execution_state: "completed";
  work_outcome: WorkOutcome;
  output_message_id: string | null;
  settled_at_ms: number;
}

interface SessionMutationRow {
  id: string;
  session_id: string;
  generation: number;
  tool_run_id: string;
  tool_use_id: string;
  affected_paths_json: string;
  scope_complete: number;
  resolved_generation: number | null;
  observed_at_ms: number;
  resolved_at_ms: number | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  input_id: string | null;
  ordinal: number;
  role: MessageRecord["role"];
  agent: string | null;
  model: string | null;
  metadata_json: string | null;
  created_at_ms: number;
}

interface PartRow {
  id: string;
  message_id: string;
  ordinal: number;
  type: string;
  data_json: string;
  created_at_ms: number;
}

interface ToolRow {
  id: string;
  session_id: string;
  message_id: string | null;
  generation: number;
  call_key: string;
  attempt: number;
  tool_name: string;
  execution_state: ToolExecutionState;
  verification_state: ToolVerificationState;
  arguments_json: string;
  result_json: string | null;
  error_json: string | null;
  checkpoint_id: string | null;
  effect_kind: string | null;
  mutation_transaction_id: string | null;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  settled_at_ms: number | null;
}

interface EpochRow {
  id: string;
  session_id: string;
  epoch: number;
  previous_epoch_id: string | null;
  generation: number;
  reason: string;
  summary_json: string;
  projection_json: string;
  source_versions_json: string;
  base_event_sequence: number | null;
  token_count: number | null;
  created_at_ms: number;
}

interface PlanRow {
  id: string;
  session_id: string;
  revision: number;
  body: string;
  plan_hash: string;
  status: PlanStatus;
  author: string | null;
  metadata_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface ApprovalRow {
  id: string;
  plan_revision_id: string;
  approver: string;
  decision: PlanApprovalRecord["decision"];
  plan_hash: string;
  metadata_json: string | null;
  created_at_ms: number;
}

interface EventRow {
  sequence: number;
  id: string;
  session_id: string;
  generation: number | null;
  type: string;
  payload_json: string;
  created_at_ms: number;
}

interface BackgroundJobRow {
  id: string;
  session_id: string;
  invocation_key: string;
  kind: BackgroundJobRecord["kind"];
  status: BackgroundJobStatus;
  description: string;
  request_json: string;
  result_json: string | null;
  error_json: string | null;
  child_session_id: string | null;
  pid: number | null;
  process_token: string | null;
  state_path: string | null;
  output_path: string | null;
  output_bytes: number;
  exit_code: number | null;
  owner_id: string | null;
  lease_expires_at_ms: number | null;
  cancel_requested: number;
  completion_input_id: string | null;
  revision: number;
  created_at_ms: number;
  started_at_ms: number | null;
  heartbeat_at_ms: number | null;
  finished_at_ms: number | null;
  updated_at_ms: number;
}

const TOOL_TRANSITIONS: Readonly<Record<ToolExecutionState, ReadonlySet<ToolExecutionState>>> = {
  // `proposed -> executing` is the conservative adapter-entry path used when
  // validation and permission live inside an adapted tool. The more granular
  // validated/authorized path remains available only to runtimes that observe
  // those boundaries explicitly.
  proposed: new Set(["validated", "executing", "failed"]),
  validated: new Set(["authorized", "failed"]),
  authorized: new Set(["checkpointed", "executing", "failed"]),
  checkpointed: new Set(["executing", "failed"]),
  executing: new Set(["succeeded", "failed", "effect_unknown"]),
  effect_unknown: new Set(["succeeded", "failed"]),
  succeeded: new Set(),
  failed: new Set(),
};

const PLAN_TRANSITIONS: Readonly<Record<PlanStatus, ReadonlySet<PlanStatus>>> = {
  draft: new Set(["awaiting_approval", "superseded"]),
  awaiting_approval: new Set(["approved", "rejected", "superseded"]),
  approved: new Set(["executing", "superseded"]),
  executing: new Set(["completed", "failed"]),
  rejected: new Set(),
  superseded: new Set(),
  completed: new Set(),
  failed: new Set(),
};

export class SessionKernelStore {
  readonly schemaVersion: number;
  private readonly now: () => number;
  private readonly makeId: (kind: string) => string;
  private closed = false;
  private transactionDepth = 0;
  private savepointCounter = 0;

  static async open(options: OpenSessionKernelOptions): Promise<SessionKernelStore> {
    if (!options.filename.trim()) throw invalidArgument("filename must not be empty");
    if (options.filename !== ":memory:" && !options.filename.startsWith("file:")) {
      await mkdir(path.dirname(path.resolve(options.filename)), { recursive: true });
    }
    const Database = options.Database ?? (await loadBetterSqlite3());
    const db = new Database(options.filename);
    try {
      return new SessionKernelStore(db, options);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  constructor(
    private readonly db: SqliteDatabase,
    options: SessionKernelStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.makeId = options.idFactory ?? ((kind) => `${kind}_${randomUUID()}`);
    if (options.configure !== false) configureSessionKernelDatabase(db);
    this.schemaVersion =
      options.migrate === false
        ? Number(db.pragma("user_version", { simple: true }) ?? 0)
        : migrateSessionKernelDatabase(db, this.now());
    if (options.migrate !== false) this.pruneSupersededEpochs();
  }

  /** One-time-per-open sweep of the epoch bloat that predates per-append
   *  pruning: every compaction used to append a full message-history
   *  projection that nothing ever read again, growing one field workspace's
   *  kernel to 357MB. Deletes all but the latest two epochs per session, then
   *  VACUUMs only when the reclaimable fraction is large enough to be worth a
   *  blocking rebuild (a one-time cost on damaged stores, a no-op forever
   *  after). Best-effort: an sqlite hiccup here must never block opening. */
  private pruneSupersededEpochs(): void {
    try {
      this.db
        .prepare(
          `DELETE FROM context_epochs
           WHERE epoch < (
             SELECT MAX(e2.epoch) - 1 FROM context_epochs e2
             WHERE e2.session_id = context_epochs.session_id
           )`,
        )
        .run();
      const freelist = Number(this.db.pragma("freelist_count", { simple: true }) ?? 0);
      const pages = Number(this.db.pragma("page_count", { simple: true }) ?? 0);
      if (pages > 0 && freelist / pages > 0.5) this.db.exec("VACUUM");
    } catch {
      // maintenance only — the store is correct without it
    }
  }

  get journalMode(): string {
    this.assertOpen();
    return String(this.db.pragma("journal_mode", { simple: true }) ?? "");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): unknown {
    this.assertOpen();
    return this.db.pragma(`wal_checkpoint(${mode})`);
  }

  createSession(input: CreateSessionInput = {}): SessionRecord {
    const id = input.id ?? this.makeId("sess");
    assertIdentifier(id, "session id");
    const now = this.now();
    return this.immediate(() => {
      if (this.sessionRow(id)) throw invalidArgument(`Session already exists: ${id}`);
      this.assertSessionIdNotTombstoned(id);
      this.db
        .prepare(
          `INSERT INTO sessions(
             id, parent_session_id, root_session_id, workspace_key, title, metadata_json,
             created_at_ms, updated_at_ms
           ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          id,
          nullableText(input.workspaceKey),
          nullableText(input.title),
          jsonOrNull(input.metadata),
          now,
          now,
        );
      this.appendEventTx(id, null, "session.created", {
        parentSessionId: null,
        rootSessionId: id,
      }, now);
      return mapSession(this.requireSessionRow(id));
    });
  }

  createChildSession(input: CreateChildSessionInput): SessionRecord {
    assertIdentifier(input.parentSessionId, "parent session id");
    assertIdentifier(input.relation, "child relation");
    const now = this.now();
    return this.immediate(() => {
      const parent = this.requireSessionRow(input.parentSessionId);
      if (parent.archived === 1) throw invalidArgument(`Session is archived: ${parent.id}`);
      const externalKey = nullableText(input.externalKey);
      if (externalKey !== null) {
        const existing = this.db
          .prepare(
            `SELECT child_session_id FROM session_links
             WHERE parent_session_id = ? AND relation = ? AND external_key = ?`,
          )
          .get<{ child_session_id: string }>(parent.id, input.relation, externalKey);
        if (existing) {
          if (input.id !== undefined && input.id !== existing.child_session_id) {
            throw new IdempotencyConflictError(parent.id, `${input.relation}:${externalKey}`);
          }
          return mapSession(this.requireSessionRow(existing.child_session_id));
        }
      }

      const id = input.id ?? this.makeId("sess");
      assertIdentifier(id, "child session id");
      if (this.sessionRow(id)) throw invalidArgument(`Session already exists: ${id}`);
      this.assertSessionIdNotTombstoned(id);
      this.db
        .prepare(
          `INSERT INTO sessions(
             id, parent_session_id, root_session_id, workspace_key, title, metadata_json,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parent.id,
          parent.root_session_id,
          input.workspaceKey === undefined ? parent.workspace_key : nullableText(input.workspaceKey),
          nullableText(input.title),
          jsonOrNull(input.metadata),
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO session_links(
             parent_session_id, child_session_id, relation, external_key, metadata_json, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(parent.id, id, input.relation, externalKey, jsonOrNull(input.linkMetadata), now);
      this.appendEventTx(id, null, "session.created", {
        parentSessionId: parent.id,
        rootSessionId: parent.root_session_id,
        relation: input.relation,
        externalKey,
      }, now);
      this.appendEventTx(parent.id, null, "child.linked", {
        childSessionId: id,
        relation: input.relation,
        externalKey,
      }, now);
      return mapSession(this.requireSessionRow(id));
    });
  }

  getSession(sessionId: string): SessionRecord | null {
    this.assertOpen();
    const row = this.sessionRow(sessionId);
    return row ? mapSession(row) : null;
  }

  getSessionTombstone(sessionId: string): SessionTombstoneRecord | null {
    this.assertOpen();
    const row = this.sessionTombstoneRow(sessionId);
    return row ? mapSessionTombstone(row) : null;
  }

  isSessionTombstoned(sessionId: string): boolean {
    this.assertOpen();
    return this.sessionTombstoneRow(sessionId) !== undefined;
  }

  listSessionTombstones(): SessionTombstoneRecord[] {
    this.assertOpen();
    return this.db
      .prepare("SELECT * FROM session_tombstones ORDER BY deleted_at_ms DESC, session_id")
      .all<SessionTombstoneRow>()
      .map(mapSessionTombstone);
  }

  /** Record permanent deletion for a legacy JSON-only session. The insert is
   * idempotent and serialized against createSession by BEGIN IMMEDIATE. */
  recordSessionTombstone(
    input: RecordSessionTombstoneInput,
  ): { tombstone: SessionTombstoneRecord; inserted: boolean } {
    assertIdentifier(input.sessionId, "session id");
    if (input.parentSessionId !== undefined && input.parentSessionId !== null) {
      assertIdentifier(input.parentSessionId, "parent session id");
    }
    const rootSessionId = input.rootSessionId ?? input.sessionId;
    assertIdentifier(rootSessionId, "root session id");
    const now = this.now();
    return this.immediate(() => {
      if (this.sessionRow(input.sessionId)) {
        throw invalidArgument(`Cannot tombstone live session: ${input.sessionId}`);
      }
      const existing = this.sessionTombstoneRow(input.sessionId);
      if (existing) return { tombstone: mapSessionTombstone(existing), inserted: false };
      this.db.prepare(
        `INSERT INTO session_tombstones(
           session_id, parent_session_id, root_session_id, workspace_key,
           deletion_source, deleted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId,
        nullableText(input.parentSessionId),
        rootSessionId,
        nullableText(input.workspaceKey),
        input.deletionSource,
        now,
      );
      return {
        tombstone: mapSessionTombstone(this.requireSessionTombstoneRow(input.sessionId)),
        inserted: true,
      };
    });
  }

  /** Owner/model workflow transition. This is deliberately durable even while
   * no runner lease exists, so a multi-hour planning conversation survives a
   * process restart without silently regaining write tools. */
  setWorkflowMode(sessionId: string, mode: WorkflowMode): SessionRecord {
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireSessionRow(sessionId);
      if (row.workflow_mode === mode) return mapSession(row);
      this.db.prepare("UPDATE sessions SET workflow_mode = ?, updated_at_ms = ? WHERE id = ?")
        .run(mode, now, sessionId);
      this.appendEventTx(sessionId, null, "workflow.mode_changed", { mode }, now);
      return mapSession(this.requireSessionRow(sessionId));
    });
  }

  requireSession(sessionId: string): SessionRecord {
    this.assertOpen();
    return mapSession(this.requireSessionRow(sessionId));
  }

  /** Canonical session directory. Archived rows are deletion tombstones and
   * stay hidden unless a recovery/cleanup caller explicitly asks for them. */
  listSessions(options: { includeArchived?: boolean } = {}): SessionRecord[] {
    this.assertOpen();
    const rows = options.includeArchived
      ? this.db.prepare("SELECT * FROM sessions ORDER BY updated_at_ms DESC, id").all<SessionRow>()
      : this.db.prepare("SELECT * FROM sessions WHERE archived = 0 ORDER BY updated_at_ms DESC, id").all<SessionRow>();
    return rows.map(mapSession);
  }

  /** Idempotently reserve a durable detached-work identity before launching
   * any process or provider call. Replaying one tool-use id can therefore only
   * ever address the same job. */
  createBackgroundJob(
    input: CreateBackgroundJobInput,
  ): { record: BackgroundJobRecord; inserted: boolean } {
    assertIdentifier(input.sessionId, "background job session id");
    assertIdentifier(input.invocationKey, "background job invocation key");
    const id = input.id ?? this.makeId("job");
    assertIdentifier(id, "background job id");
    const requestJson = canonicalJson(input.request);
    const now = this.now();
    return this.immediate(() => {
      const session = this.requireSessionRow(input.sessionId);
      if (session.archived === 1) throw invalidArgument(`Session is archived: ${input.sessionId}`);
      const existing = this.db.prepare(
        "SELECT * FROM background_jobs WHERE session_id = ? AND kind = ? AND invocation_key = ?",
      ).get<BackgroundJobRow>(input.sessionId, input.kind, input.invocationKey);
      if (existing) {
        const same = (input.id === undefined || existing.id === input.id) &&
          existing.description === input.description &&
          existing.request_json === requestJson &&
          (input.childSessionId === undefined || existing.child_session_id === nullableText(input.childSessionId)) &&
          (input.processToken === undefined || existing.process_token === nullableText(input.processToken)) &&
          (input.statePath === undefined || existing.state_path === nullableText(input.statePath)) &&
          (input.outputPath === undefined || existing.output_path === nullableText(input.outputPath));
        if (!same) {
          throw new IdempotencyConflictError(input.sessionId, `background:${input.kind}:${input.invocationKey}`);
        }
        return { record: mapBackgroundJob(existing), inserted: false };
      }
      if (this.backgroundJobRow(id)) throw invalidArgument(`Background job already exists: ${id}`);
      if (input.childSessionId) this.requireSessionRow(input.childSessionId);
      this.db.prepare(
        `INSERT INTO background_jobs(
           id, session_id, invocation_key, kind, description, request_json,
           child_session_id, process_token, state_path, output_path,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.sessionId,
        input.invocationKey,
        input.kind,
        input.description,
        requestJson,
        nullableText(input.childSessionId),
        nullableText(input.processToken),
        nullableText(input.statePath),
        nullableText(input.outputPath),
        now,
        now,
      );
      this.appendEventTx(input.sessionId, null, "background_job.created", {
        jobId: id,
        kind: input.kind,
        invocationKey: input.invocationKey,
      }, now);
      return { record: mapBackgroundJob(this.requireBackgroundJobRow(id)), inserted: true };
    });
  }

  getBackgroundJob(jobId: string): BackgroundJobRecord | null {
    this.assertOpen();
    const row = this.backgroundJobRow(jobId);
    return row ? mapBackgroundJob(row) : null;
  }

  listBackgroundJobs(
    sessionId?: string,
    options: { kind?: BackgroundJobRecord["kind"]; statuses?: readonly BackgroundJobStatus[] } = {},
  ): BackgroundJobRecord[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (sessionId) {
      clauses.push("session_id = ?");
      params.push(sessionId);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.statuses?.length) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(",")})`);
      params.push(...options.statuses);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM background_jobs${where} ORDER BY created_at_ms, id`)
      .all<BackgroundJobRow>(...params)
      .map(mapBackgroundJob);
  }

  /** Record the OS-owned supervisor only after the detached launch has been
   * attempted. A queued row plus a supervisor state file remains recoverable if
   * the host dies between spawn and this commit. */
  markBackgroundJobRunning(
    jobId: string,
    runtime: {
      pid?: number | null;
      processToken?: string | null;
      statePath?: string | null;
      outputPath?: string | null;
      heartbeatAtMs?: number | null;
    } = {},
  ): BackgroundJobRecord {
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireBackgroundJobRow(jobId);
      if (isTerminalBackgroundJobStatus(row.status)) return mapBackgroundJob(row);
      if (row.kind === "task" && row.owner_id === null) {
        throw invalidArgument(`Task background job must be claimed before running: ${jobId}`);
      }
      this.db.prepare(
        `UPDATE background_jobs
         SET status = 'running', pid = COALESCE(?, pid),
             process_token = COALESCE(?, process_token),
             state_path = COALESCE(?, state_path), output_path = COALESCE(?, output_path),
             started_at_ms = COALESCE(started_at_ms, ?),
             heartbeat_at_ms = COALESCE(?, heartbeat_at_ms),
             updated_at_ms = ?, revision = revision + 1
         WHERE id = ?`,
      ).run(
        runtime.pid ?? null,
        nullableText(runtime.processToken),
        nullableText(runtime.statePath),
        nullableText(runtime.outputPath),
        now,
        runtime.heartbeatAtMs ?? null,
        now,
        jobId,
      );
      if (row.status !== "running") {
        this.appendEventTx(row.session_id, null, "background_job.running", { jobId }, now);
      }
      return mapBackgroundJob(this.requireBackgroundJobRow(jobId));
    });
  }

  /** Claim or steal an expired detached Task worker lease. The durable child
   * Session provides the inner exactly-once input boundary; this outer lease
   * prevents healthy hosts from pointlessly racing the same provider work. */
  claimBackgroundJob(jobId: string, ownerId: string, ttlMs = DEFAULT_LEASE_TTL_MS): BackgroundJobRecord | null {
    assertIdentifier(ownerId, "background job owner id");
    const ttl = boundedInteger(ttlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS, "background job lease ttl");
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireBackgroundJobRow(jobId);
      if (row.kind !== "task" || isTerminalBackgroundJobStatus(row.status) || row.cancel_requested === 1) return null;
      if (row.owner_id !== null && row.owner_id !== ownerId && (row.lease_expires_at_ms ?? 0) > now) return null;
      const changed = this.db.prepare(
        `UPDATE background_jobs
         SET status = 'running', owner_id = ?, lease_expires_at_ms = ?,
             started_at_ms = COALESCE(started_at_ms, ?), heartbeat_at_ms = ?,
             updated_at_ms = ?, revision = revision + 1
         WHERE id = ? AND kind = 'task' AND status IN ('queued','running')
           AND cancel_requested = 0
           AND (owner_id IS NULL OR owner_id = ? OR lease_expires_at_ms <= ?)`,
      ).run(ownerId, now + ttl, now, now, now, jobId, ownerId, now).changes;
      if (changed !== 1) return null;
      this.appendEventTx(row.session_id, null, "background_job.claimed", { jobId, ownerId }, now);
      return mapBackgroundJob(this.requireBackgroundJobRow(jobId));
    });
  }

  renewBackgroundJobLease(jobId: string, ownerId: string, ttlMs = DEFAULT_LEASE_TTL_MS): BackgroundJobRecord | null {
    const ttl = boundedInteger(ttlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS, "background job lease ttl");
    const now = this.now();
    return this.immediate(() => {
      const changed = this.db.prepare(
        `UPDATE background_jobs
         SET lease_expires_at_ms = ?, heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
         WHERE id = ? AND kind = 'task' AND status = 'running' AND owner_id = ?`,
      ).run(now + ttl, now, now, jobId, ownerId).changes;
      return changed === 1 ? mapBackgroundJob(this.requireBackgroundJobRow(jobId)) : null;
    });
  }

  requestBackgroundJobCancellation(jobId: string): BackgroundJobRecord {
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireBackgroundJobRow(jobId);
      if (isTerminalBackgroundJobStatus(row.status)) return mapBackgroundJob(row);
      this.db.prepare(
        `UPDATE background_jobs SET cancel_requested = 1, updated_at_ms = ?, revision = revision + 1 WHERE id = ?`,
      ).run(now, jobId);
      this.appendEventTx(row.session_id, null, "background_job.cancel_requested", { jobId }, now);
      return mapBackgroundJob(this.requireBackgroundJobRow(jobId));
    });
  }

  attachBackgroundJobChild(jobId: string, childSessionId: string): BackgroundJobRecord {
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireBackgroundJobRow(jobId);
      if (row.kind !== "task") throw invalidArgument(`Shell job cannot own a child session: ${jobId}`);
      const child = this.requireSessionRow(childSessionId);
      if (child.parent_session_id !== row.session_id) {
        throw invalidArgument(`Child ${childSessionId} does not belong to job parent ${row.session_id}`);
      }
      if (row.child_session_id && row.child_session_id !== childSessionId) {
        throw invalidArgument(`Background job ${jobId} already belongs to child ${row.child_session_id}`);
      }
      this.db.prepare(
        `UPDATE background_jobs SET child_session_id = ?, updated_at_ms = ?, revision = revision + 1 WHERE id = ?`,
      ).run(childSessionId, now, jobId);
      return mapBackgroundJob(this.requireBackgroundJobRow(jobId));
    });
  }

  updateBackgroundJobObservation(
    jobId: string,
    observation: { outputBytes?: number; heartbeatAtMs?: number | null; pid?: number | null },
  ): BackgroundJobRecord {
    const now = this.now();
    const outputBytes = observation.outputBytes === undefined
      ? undefined
      : boundedInteger(observation.outputBytes, 0, Number.MAX_SAFE_INTEGER, "background output bytes");
    return this.immediate(() => {
      this.requireBackgroundJobRow(jobId);
      this.db.prepare(
        `UPDATE background_jobs
         SET output_bytes = COALESCE(?, output_bytes),
             heartbeat_at_ms = COALESCE(?, heartbeat_at_ms),
             pid = COALESCE(?, pid), updated_at_ms = ?, revision = revision + 1
         WHERE id = ?`,
      ).run(outputBytes ?? null, observation.heartbeatAtMs ?? null, observation.pid ?? null, now, jobId);
      return mapBackgroundJob(this.requireBackgroundJobRow(jobId));
    });
  }

  settleBackgroundJob(jobId: string, input: SettleBackgroundJobInput, expectedOwnerId?: string): BackgroundJobRecord {
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireBackgroundJobRow(jobId);
      if (isTerminalBackgroundJobStatus(row.status)) {
        if (row.status !== input.status) {
          throw invalidArgument(`Background job ${jobId} is already ${row.status}, not ${input.status}`);
        }
        if (!input.completion || row.completion_input_id) return mapBackgroundJob(row);
        const admitted = this.admitInput({
          id: input.completion.id,
          sessionId: row.session_id,
          idempotencyKey: input.completion.idempotencyKey,
          delivery: "steer",
          payload: input.completion.payload,
        });
        this.db.prepare(
          `UPDATE background_jobs
           SET completion_input_id = ?, updated_at_ms = ?, revision = revision + 1
           WHERE id = ? AND completion_input_id IS NULL`,
        ).run(admitted.record.id, now, jobId);
        return mapBackgroundJob(this.requireBackgroundJobRow(jobId));
      }
      if (expectedOwnerId !== undefined && row.owner_id !== expectedOwnerId) {
        throw invalidArgument(`Background job ${jobId} is owned by another worker`);
      }
      const outputBytes = input.outputBytes === undefined
        ? row.output_bytes
        : boundedInteger(input.outputBytes, 0, Number.MAX_SAFE_INTEGER, "background output bytes");
      let completionInputId: string | null = row.completion_input_id;
      if (input.completion) {
        const admitted = this.admitInput({
          id: input.completion.id,
          sessionId: row.session_id,
          idempotencyKey: input.completion.idempotencyKey,
          delivery: "steer",
          payload: input.completion.payload,
        });
        completionInputId = admitted.record.id;
      }
      this.db.prepare(
        `UPDATE background_jobs
         SET status = ?, result_json = ?, error_json = ?, exit_code = ?,
             output_bytes = ?, owner_id = NULL, lease_expires_at_ms = NULL,
             completion_input_id = ?, finished_at_ms = ?, heartbeat_at_ms = ?,
             updated_at_ms = ?, revision = revision + 1
         WHERE id = ?`,
      ).run(
        input.status,
        jsonOrNull(input.result),
        jsonOrNull(input.error),
        input.exitCode ?? null,
        outputBytes,
        completionInputId,
        now,
        now,
        now,
        jobId,
      );
      this.appendEventTx(row.session_id, null, "background_job.settled", {
        jobId,
        status: input.status,
        completionInputId,
      }, now);
      return mapBackgroundJob(this.requireBackgroundJobRow(jobId));
    });
  }

  getBackgroundJobCursor(jobId: string, consumerKey: string): number {
    this.assertOpen();
    this.requireBackgroundJobRow(jobId);
    assertIdentifier(consumerKey, "background output consumer key");
    return this.db.prepare(
      "SELECT cursor_bytes FROM background_job_cursors WHERE job_id = ? AND consumer_key = ?",
    ).get<{ cursor_bytes: number }>(jobId, consumerKey)?.cursor_bytes ?? 0;
  }

  /** CAS cursor advancement: callers read the spool first and only acknowledge
   * bytes after a successful read, so a crash never silently skips output. */
  advanceBackgroundJobCursor(jobId: string, consumerKey: string, expectedBytes: number, nextBytes: number): boolean {
    const expected = boundedInteger(expectedBytes, 0, Number.MAX_SAFE_INTEGER, "expected background cursor");
    const next = boundedInteger(nextBytes, expected, Number.MAX_SAFE_INTEGER, "next background cursor");
    const now = this.now();
    return this.immediate(() => {
      this.requireBackgroundJobRow(jobId);
      assertIdentifier(consumerKey, "background output consumer key");
      const current = this.db.prepare(
        "SELECT cursor_bytes FROM background_job_cursors WHERE job_id = ? AND consumer_key = ?",
      ).get<{ cursor_bytes: number }>(jobId, consumerKey)?.cursor_bytes ?? 0;
      if (current !== expected) return false;
      this.db.prepare(
        `INSERT INTO background_job_cursors(job_id, consumer_key, cursor_bytes, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id, consumer_key) DO UPDATE
         SET cursor_bytes = excluded.cursor_bytes, updated_at_ms = excluded.updated_at_ms`,
      ).run(jobId, consumerKey, next, now);
      return true;
    });
  }

  setSessionTitle(sessionId: string, title: string | null): SessionRecord {
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireSessionRow(sessionId);
      if (row.archived === 1) throw invalidArgument(`Session is archived: ${sessionId}`);
      this.db.prepare("UPDATE sessions SET title = ?, updated_at_ms = ? WHERE id = ?")
        .run(nullableText(title), now, sessionId);
      this.appendEventTx(sessionId, null, "session.renamed", { title: nullableText(title) }, now);
      return mapSession(this.requireSessionRow(sessionId));
    });
  }

  /** Shallow-merge owner/runtime metadata without discarding durable fields
   * written by another subsystem (for example subagent type or createdAt). */
  mergeSessionMetadata(
    sessionId: string,
    patch: Readonly<Record<string, JsonValue>>,
  ): SessionRecord {
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireSessionRow(sessionId);
      if (row.archived === 1) throw invalidArgument(`Session is archived: ${sessionId}`);
      const parsed = parseJson(row.metadata_json);
      const current = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
      const metadata = { ...current, ...patch };
      const serialized = canonicalJson(metadata);
      if (serialized === row.metadata_json) return mapSession(row);
      this.db.prepare("UPDATE sessions SET metadata_json = ?, updated_at_ms = ? WHERE id = ?")
        .run(serialized, now, sessionId);
      this.appendEventTx(sessionId, null, "session.metadata_updated", {
        keys: Object.keys(patch).sort(),
      }, now);
      return mapSession(this.requireSessionRow(sessionId));
    });
  }

  /** Phase one of cross-store deletion. The whole descendant tree is hidden
   * first, making a crash during JSONL cleanup non-resurrecting. */
  prepareSessionDeletion(sessionId: string): SessionRecord[] {
    const now = this.now();
    return this.immediate(() => {
      this.requireSessionRow(sessionId);
      const lease = this.db.prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION ALL
           SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id
         )
         SELECT l.session_id FROM runner_leases l JOIN tree t ON t.id = l.session_id LIMIT 1`,
      ).get<{ session_id: string }>(sessionId);
      if (lease) throw invalidArgument(`Cannot delete session tree while ${lease.session_id} has an active runner lease`);
      const backgroundJob = this.db.prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION ALL
           SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id
         )
         SELECT j.id FROM background_jobs j JOIN tree t ON t.id = j.session_id
         WHERE j.status IN ('queued','running') LIMIT 1`,
      ).get<{ id: string }>(sessionId);
      if (backgroundJob) {
        throw invalidArgument(`Cannot delete session tree while background job ${backgroundJob.id} is active; cancel it first`);
      }
      this.db.prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION ALL
           SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id
         )
         UPDATE sessions SET archived = 1, updated_at_ms = ? WHERE id IN (SELECT id FROM tree)`,
      ).run(sessionId, now);
      return this.sessionTreeRows(sessionId).map(mapSession);
    });
  }

  /** Phase two of cross-store deletion. Only an already-hidden tree can be
   * purged; children are removed deepest-first because parent_session_id is
   * deliberately ON DELETE RESTRICT. */
  finalizeSessionDeletion(sessionId: string): boolean {
    return this.immediate(() => {
      if (!this.sessionRow(sessionId)) return false;
      const rows = this.sessionTreeRowsWithDepth(sessionId);
      if (rows.some((row) => row.archived !== 1)) {
        throw invalidArgument(`Session deletion was not prepared: ${sessionId}`);
      }
      const lease = this.db.prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION ALL
           SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id
         )
         SELECT l.session_id FROM runner_leases l JOIN tree t ON t.id = l.session_id LIMIT 1`,
      ).get<{ session_id: string }>(sessionId);
      if (lease) throw invalidArgument(`Cannot finalize deletion while ${lease.session_id} has an active runner lease`);
      const backgroundJob = this.db.prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION ALL
           SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id
         )
         SELECT j.id FROM background_jobs j JOIN tree t ON t.id = j.session_id
         WHERE j.status IN ('queued','running') LIMIT 1`,
      ).get<{ id: string }>(sessionId);
      if (backgroundJob) {
        throw invalidArgument(`Cannot finalize deletion while background job ${backgroundJob.id} is active`);
      }
      const now = this.now();
      const tombstone = this.db.prepare(
        `INSERT INTO session_tombstones(
           session_id, parent_session_id, root_session_id, workspace_key,
           deletion_source, deleted_at_ms
         ) VALUES (?, ?, ?, ?, 'canonical', ?)
         ON CONFLICT(session_id) DO NOTHING`,
      );
      // Tombstones and canonical-row removal commit in one SQLite transaction.
      // There is no crash window in which both authorities forget an id.
      for (const row of rows) {
        tombstone.run(
          row.id,
          row.parent_session_id,
          row.root_session_id,
          row.workspace_key,
          now,
        );
      }
      const remove = this.db.prepare("DELETE FROM sessions WHERE id = ?");
      for (const row of [...rows].sort((a, b) => b.tree_depth - a.tree_depth)) remove.run(row.id);
      return true;
    });
  }

  listChildSessions(parentSessionId: string): Array<{ session: SessionRecord; link: SessionLinkRecord }> {
    this.assertOpen();
    this.requireSessionRow(parentSessionId);
    const rows = this.db
      .prepare(
        `SELECT s.*, l.relation AS link_relation, l.external_key AS link_external_key,
                l.metadata_json AS link_metadata_json, l.created_at_ms AS link_created_at_ms
         FROM session_links l
         JOIN sessions s ON s.id = l.child_session_id
         WHERE l.parent_session_id = ?
         ORDER BY l.created_at_ms, s.id`,
      )
      .all<SessionRow & {
        link_relation: string;
        link_external_key: string | null;
        link_metadata_json: string | null;
        link_created_at_ms: number;
      }>(parentSessionId);
    return rows.map((row) => ({
      session: mapSession(row),
      link: {
        parentSessionId,
        childSessionId: row.id,
        relation: row.link_relation,
        externalKey: row.link_external_key,
        metadata: parseJson(row.link_metadata_json),
        createdAtMs: row.link_created_at_ms,
      },
    }));
  }

  admitInput(input: AdmitInput): { record: AdmittedInputRecord; inserted: boolean } {
    assertIdentifier(input.sessionId, "session id");
    assertIdentifier(input.idempotencyKey, "idempotency key");
    const payload = canonicalJson(input.payload);
    const now = this.now();
    return this.immediate(() => {
      const session = this.requireSessionRow(input.sessionId);
      if (session.archived === 1) throw invalidArgument(`Session is archived: ${input.sessionId}`);
      const existing = this.db
        .prepare("SELECT * FROM admitted_inputs WHERE session_id = ? AND idempotency_key = ?")
        .get<InputRow>(input.sessionId, input.idempotencyKey);
      if (existing) {
        if (existing.delivery !== input.delivery || existing.payload_json !== payload) {
          throw new IdempotencyConflictError(input.sessionId, input.idempotencyKey);
        }
        return { record: mapInput(existing), inserted: false };
      }

      const id = input.id ?? this.makeId("input");
      assertIdentifier(id, "input id");
      const admissionSequence = this.db
        .prepare(
          `SELECT COALESCE(MAX(admission_sequence), 0) + 1 AS next_sequence
           FROM admitted_inputs WHERE session_id = ?`,
        )
        .get<{ next_sequence: number }>(input.sessionId)!.next_sequence;
      this.db
        .prepare(
          `INSERT INTO admitted_inputs(
             id, session_id, idempotency_key, delivery, payload_json, admission_sequence, admitted_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.sessionId, input.idempotencyKey, input.delivery, payload, admissionSequence, now);
      this.db
        .prepare(
          `UPDATE sessions
           SET execution_state = CASE WHEN execution_state = 'running' THEN execution_state ELSE 'admitted' END,
               work_outcome = CASE WHEN execution_state = 'running' THEN work_outcome ELSE 'pending' END,
               updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(now, input.sessionId);
      this.appendEventTx(input.sessionId, null, "input.admitted", {
        inputId: id,
        idempotencyKey: input.idempotencyKey,
        delivery: input.delivery,
      }, now);
      return { record: mapInput(this.requireInputRow(id)), inserted: true };
    });
  }

  getInput(inputId: string): AdmittedInputRecord | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM admitted_inputs WHERE id = ?").get<InputRow>(inputId);
    return row ? mapInput(row) : null;
  }

  listInputs(sessionId: string, state?: AdmittedInputRecord["state"]): AdmittedInputRecord[] {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    const rows = state
      ? this.db
          .prepare("SELECT * FROM admitted_inputs WHERE session_id = ? AND state = ? ORDER BY admission_sequence")
          .all<InputRow>(sessionId, state)
      : this.db
          .prepare("SELECT * FROM admitted_inputs WHERE session_id = ? ORDER BY admission_sequence")
          .all<InputRow>(sessionId);
    return rows.map(mapInput);
  }

  /** Claim one caller-owned input by durable identity. Interactive senders use
   * this instead of the global FIFO selector so registration races can never
   * make one generator execute or stream another caller's request. */
  claimInput(fence: RunFence, inputId: string): AdmittedInputRecord {
    assertIdentifier(inputId, "input id");
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const row = this.requireInputRow(inputId);
      if (row.session_id !== fence.sessionId) throw invalidArgument("Input belongs to another session");
      if (row.state === "claimed" && row.claimed_generation === fence.generation) return mapInput(row);
      if (row.state !== "admitted") {
        throw new InvalidStateTransitionError("input", inputId, row.state, "claimed");
      }
      // This is the identity-bound claim primitive, not the recovery FIFO
      // selector. Interactive Session callers wait for their admission ticket
      // to reach the durable queue head before invoking it; keeping that wait
      // outside this transaction lets a caller claim only its own input even
      // when audit-flush scheduling differs from admission order. Recovery
      // callers that want global oldest-first selection use claimNextInput().
      const changed = this.db
        .prepare(
          `UPDATE admitted_inputs
           SET state = 'claimed', claimed_generation = ?, claimed_at_ms = ?
           WHERE id = ? AND state = 'admitted'`,
        )
        .run(fence.generation, now, inputId).changes;
      if (changed !== 1) throw new StaleGenerationError(fence.sessionId, fence.generation, "input claim raced");
      this.appendEventTx(fence.sessionId, fence.generation, "input.claimed", { inputId }, now);
      return mapInput(this.requireInputRow(inputId));
    });
  }

  claimNextInput(fence: RunFence, delivery?: InputDelivery): AdmittedInputRecord | null {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const row = delivery
        ? this.db
            .prepare(
              `SELECT * FROM admitted_inputs
               WHERE session_id = ? AND state = 'admitted' AND delivery = ?
               ORDER BY admission_sequence LIMIT 1`,
            )
            .get<InputRow>(fence.sessionId, delivery)
        : this.db
            .prepare(
              `SELECT * FROM admitted_inputs
               WHERE session_id = ? AND state = 'admitted'
               ORDER BY admission_sequence LIMIT 1`,
            )
            .get<InputRow>(fence.sessionId);
      if (!row) return null;
      const changed = this.db
        .prepare(
          `UPDATE admitted_inputs
           SET state = 'claimed', claimed_generation = ?, claimed_at_ms = ?
           WHERE id = ? AND state = 'admitted'`,
        )
        .run(fence.generation, now, row.id).changes;
      if (changed !== 1) throw new StaleGenerationError(fence.sessionId, fence.generation, "input claim raced");
      this.appendEventTx(fence.sessionId, fence.generation, "input.claimed", { inputId: row.id }, now);
      return mapInput(this.requireInputRow(row.id));
    });
  }

  claimSteeringInputs(fence: RunFence, limit = 100): AdmittedInputRecord[] {
    const boundedLimit = boundedInteger(limit, 1, 1_000, "steering input limit");
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const rows = this.db
        .prepare(
          `SELECT * FROM admitted_inputs
           WHERE session_id = ? AND state = 'admitted' AND delivery = 'steer'
           ORDER BY admission_sequence LIMIT ?`,
        )
        .all<InputRow>(fence.sessionId, boundedLimit);
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE admitted_inputs
             SET state = 'claimed', claimed_generation = ?, claimed_at_ms = ?
             WHERE id = ? AND state = 'admitted'`,
          )
          .run(fence.generation, now, row.id);
        this.appendEventTx(fence.sessionId, fence.generation, "input.claimed", { inputId: row.id }, now);
      }
      return rows.map((row) => mapInput(this.requireInputRow(row.id)));
    });
  }

  consumeInput(fence: RunFence, inputId: string): AdmittedInputRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const row = this.requireInputRow(inputId);
      if (row.session_id !== fence.sessionId) throw invalidArgument("Input belongs to another session");
      if (row.state === "consumed") return mapInput(row);
      if (row.state !== "claimed" || row.claimed_generation !== fence.generation) {
        throw new InvalidStateTransitionError("input", inputId, row.state, "consumed");
      }
      this.db
        .prepare(
          `UPDATE admitted_inputs
           SET state = 'consumed', claimed_generation = NULL, consumed_at_ms = ?
           WHERE id = ?`,
        )
        .run(now, inputId);
      this.appendEventTx(fence.sessionId, fence.generation, "input.consumed", { inputId }, now);
      return mapInput(this.requireInputRow(inputId));
    });
  }

  /** Cancel exactly one durable input. Claimed inputs use a generation fence or
   * exact generation CAS so Stop can never cancel a replacement runner's work. The
   * terminal `cancelled` state is deliberately outside release/recovery's
   * `claimed -> admitted` requeue predicate. */
  cancelInput(inputId: string, input: CancelInputInput): AdmittedInputRecord {
    assertIdentifier(inputId, "input id");
    const now = this.now();
    return this.immediate(() => {
      const row = this.requireInputRow(inputId);
      if (row.session_id !== input.sessionId) throw invalidArgument("Input belongs to another session");
      if (row.state === "cancelled" || row.state === "consumed") return mapInput(row);

      let generation: number | null = null;
      if (row.state === "claimed") {
        const fence = input.fence;
        if (fence && fence.sessionId !== input.sessionId) {
          throw invalidArgument("Cancellation fence belongs to another session");
        }
        if (fence) this.assertFenceTx(fence, now);
        const expectedGeneration = fence?.generation ?? input.expectedGeneration;
        if (expectedGeneration === undefined) {
          throw new InvalidStateTransitionError(
            "input",
            inputId,
            row.state,
            "cancelled without an expected generation",
          );
        }
        if (row.claimed_generation !== expectedGeneration) {
          throw new StaleGenerationError(input.sessionId, expectedGeneration, "input belongs to another generation");
        }
        generation = expectedGeneration;
      } else if (row.state === "admitted") {
        if (input.fence) {
          if (input.fence.sessionId !== input.sessionId) {
            throw invalidArgument("Cancellation fence belongs to another session");
          }
          this.assertFenceTx(input.fence, now);
          generation = input.fence.generation;
        }
      } else {
        throw new InvalidStateTransitionError("input", inputId, row.state, "cancelled");
      }

      const changed = row.state === "claimed"
        ? this.db
            .prepare(
              `UPDATE admitted_inputs
               SET state = 'cancelled', claimed_generation = NULL,
                   claimed_at_ms = NULL, consumed_at_ms = ?
               WHERE id = ? AND state = 'claimed' AND claimed_generation = ?`,
            )
            .run(now, inputId, generation).changes
        : this.db
            .prepare(
              `UPDATE admitted_inputs
               SET state = 'cancelled', claimed_generation = NULL,
                   claimed_at_ms = NULL, consumed_at_ms = ?
               WHERE id = ? AND state = 'admitted'`,
            )
            .run(now, inputId).changes;
      if (changed !== 1) {
        throw new StaleGenerationError(input.sessionId, generation ?? 0, "input cancellation raced");
      }

      this.appendEventTx(input.sessionId, generation, "input.cancelled", {
        inputId,
        reason: input.reason ?? null,
      }, now);

      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM admitted_inputs
           WHERE session_id = ? AND state IN ('admitted', 'claimed')`,
        )
        .get<{ count: number }>(input.sessionId)?.count ?? 0;
      const session = this.requireSessionRow(input.sessionId);
      if (pending === 0 && session.execution_state === "admitted") {
        this.db
          .prepare(
            `UPDATE sessions
             SET execution_state = 'idle', work_outcome = 'not_applicable', updated_at_ms = ?
             WHERE id = ? AND execution_state = 'admitted'`,
          )
          .run(now, input.sessionId);
      }
      return mapInput(this.requireInputRow(inputId));
    });
  }

  /** Consume an orphaned caller input and publish its detached terminal result
   * in the same transaction. A restart can therefore observe either a runnable
   * input or its result acknowledgement, never a consumed input with no result. */
  settleDetachedInputResult(
    fence: RunFence,
    inputId: string,
    input: SettleDetachedInputResultInput,
  ): DetachedInputResultRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const existing = this.detachedInputResultRow(inputId);
      if (existing) return mapDetachedInputResult(existing);
      const row = this.requireInputRow(inputId);
      if (row.session_id !== fence.sessionId) throw invalidArgument("Input belongs to another session");
      if (row.state !== "claimed" || row.claimed_generation !== fence.generation) {
        throw new InvalidStateTransitionError("input", inputId, row.state, "consumed-with-detached-result");
      }
      const outputMessageId = input.outputMessageId ?? null;
      if (outputMessageId) {
        const message = this.db.prepare("SELECT session_id FROM messages WHERE id = ?").get<{ session_id: string }>(outputMessageId);
        if (!message) throw invalidArgument(`Output message does not exist: ${outputMessageId}`);
        if (message.session_id !== fence.sessionId) throw invalidArgument("Output message belongs to another session");
      }
      this.db
        .prepare(
          `UPDATE admitted_inputs
           SET state = 'consumed', claimed_generation = NULL, consumed_at_ms = ?
           WHERE id = ? AND state = 'claimed' AND claimed_generation = ?`,
        )
        .run(now, inputId, fence.generation);
      this.db
        .prepare(
          `INSERT INTO detached_input_results(
             input_id, session_id, generation, execution_state, work_outcome,
             output_message_id, settled_at_ms
           ) VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
        )
        .run(inputId, fence.sessionId, fence.generation, input.workOutcome, outputMessageId, now);
      this.appendEventTx(fence.sessionId, fence.generation, "input.consumed", { inputId }, now);
      this.appendEventTx(fence.sessionId, fence.generation, "input.detached_result", {
        inputId,
        executionState: "completed",
        workOutcome: input.workOutcome,
        outputMessageId,
      }, now);
      return mapDetachedInputResult(this.requireDetachedInputResultRow(inputId));
    });
  }

  getDetachedInputResult(inputId: string): DetachedInputResultRecord | null {
    this.assertOpen();
    const row = this.detachedInputResultRow(inputId);
    return row ? mapDetachedInputResult(row) : null;
  }

  listDetachedInputResults(sessionId: string): DetachedInputResultRecord[] {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    return this.db
      .prepare(
        `SELECT * FROM detached_input_results
         WHERE session_id = ? ORDER BY settled_at_ms, input_id`,
      )
      .all<DetachedInputResultRow>(sessionId)
      .map(mapDetachedInputResult);
  }

  acquireRunnerLease(
    sessionId: string,
    ownerId: string,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RunnerLease {
    assertIdentifier(sessionId, "session id");
    assertIdentifier(ownerId, "runner owner id");
    const ttl = boundedInteger(ttlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS, "lease TTL");
    const now = this.now();
    return this.immediate(() => {
      const session = this.requireSessionRow(sessionId);
      if (session.archived === 1) throw invalidArgument(`Session is archived: ${sessionId}`);
      const existing = this.leaseRow(sessionId);
      if (existing && existing.expires_at_ms > now) {
        if (existing.owner_id === ownerId) return mapLease(existing);
        throw new LeaseHeldError(sessionId, existing.owner_id, existing.expires_at_ms);
      }

      if (existing) this.recoverExpiredLeaseTx(existing, now);
      const generation = session.current_generation + 1;
      const token = this.makeId("lease");
      const expires = now + ttl;
      this.db
        .prepare(
          `INSERT INTO session_runs(
             session_id, generation, runner_id, execution_state, work_outcome, started_at_ms
           ) VALUES (?, ?, ?, 'running', 'pending', ?)`,
        )
        .run(sessionId, generation, ownerId, now);
      this.db
        .prepare(
          `INSERT INTO runner_leases(
             session_id, generation, owner_id, lease_token, acquired_at_ms, renewed_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, generation, ownerId, token, now, now, expires);
      this.db
        .prepare(
          `UPDATE sessions
           SET current_generation = ?, execution_state = 'running', work_outcome = 'pending', updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(generation, now, sessionId);
      this.appendEventTx(sessionId, generation, "runner.acquired", { ownerId, expiresAtMs: expires }, now);
      return mapLease(this.requireLeaseRow(sessionId));
    });
  }

  renewRunnerLease(fence: RunFence, ttlMs = DEFAULT_LEASE_TTL_MS): RunnerLease {
    const ttl = boundedInteger(ttlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS, "lease TTL");
    const now = this.now();
    return this.immediate(() => {
      const lease = this.assertFenceTx(fence, now);
      const expires = now + ttl;
      this.db
        .prepare("UPDATE runner_leases SET renewed_at_ms = ?, expires_at_ms = ? WHERE session_id = ?")
        .run(now, expires, fence.sessionId);
      if (expires - lease.expires_at_ms >= Math.max(1_000, Math.floor(ttl / 2))) {
        this.appendEventTx(fence.sessionId, fence.generation, "runner.renewed", { expiresAtMs: expires }, now);
      }
      return mapLease(this.requireLeaseRow(fence.sessionId));
    });
  }

  isFenceCurrent(fence: RunFence): boolean {
    this.assertOpen();
    try {
      this.assertFenceTx(fence, this.now());
      return true;
    } catch (error) {
      if (error instanceof StaleGenerationError) return false;
      throw error;
    }
  }

  assertFence(fence: RunFence): RunnerLease {
    this.assertOpen();
    return mapLease(this.assertFenceTx(fence, this.now()));
  }

  releaseRunnerLease(fence: RunFence, input: ReleaseLeaseInput): SessionRunRecord {
    const now = this.now();
    return this.immediate(() => {
      const lease = this.assertFenceTx(fence, now);
      // No claim may outlive the lease that owns it. Completed inputs have
      // already been consumed; every remaining claim is incomplete and returns
      // to the inbox whether the host reports failure, interruption, or waiting.
      const requeued = this.db
        .prepare(
          `UPDATE admitted_inputs
           SET state = 'admitted', claimed_generation = NULL, claimed_at_ms = NULL
           WHERE session_id = ? AND state = 'claimed' AND claimed_generation = ?`,
        )
        .run(fence.sessionId, fence.generation).changes;
      if (requeued > 0) {
        this.appendEventTx(fence.sessionId, fence.generation, "input.requeued", { count: requeued }, now);
      }
      const pending = this.db
        .prepare("SELECT COUNT(*) AS count FROM admitted_inputs WHERE session_id = ? AND state = 'admitted'")
        .get<{ count: number }>(fence.sessionId)?.count ?? 0;
      const sessionExecutionState: ExecutionState = pending > 0 ? "admitted" : input.executionState;
      const sessionWorkOutcome = pending > 0 ? "pending" : input.workOutcome;
      this.db
        .prepare(
          `UPDATE session_runs
           SET execution_state = ?, work_outcome = ?, ended_at_ms = ?, error_json = ?
           WHERE session_id = ? AND generation = ?`,
        )
        .run(input.executionState, input.workOutcome, now, jsonOrNull(input.error), fence.sessionId, fence.generation);
      this.db
        .prepare(
          `UPDATE sessions
           SET execution_state = ?, work_outcome = ?, updated_at_ms = ?
           WHERE id = ? AND current_generation = ?`,
        )
        .run(sessionExecutionState, sessionWorkOutcome, now, fence.sessionId, fence.generation);
      this.db.prepare("DELETE FROM runner_leases WHERE session_id = ? AND lease_token = ?").run(
        fence.sessionId,
        lease.lease_token,
      );
      this.appendEventTx(fence.sessionId, fence.generation, "runner.released", {
        executionState: input.executionState,
        workOutcome: input.workOutcome,
        sessionExecutionState,
        sessionWorkOutcome,
        requeuedInputs: requeued,
      }, now);
      return mapRun(this.requireRunRow(fence.sessionId, fence.generation));
    });
  }

  getRunnerLease(sessionId: string): RunnerLease | null {
    this.assertOpen();
    const row = this.leaseRow(sessionId);
    return row ? mapLease(row) : null;
  }

  getRun(sessionId: string, generation: number): SessionRunRecord | null {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM session_runs WHERE session_id = ? AND generation = ?")
      .get<RunRow>(sessionId, generation);
    return row ? mapRun(row) : null;
  }

  appendMessage(fence: RunFence, input: AppendMessageInput): MessageRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      if (
        input.createdAtMs !== undefined &&
        (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0)
      ) {
        throw invalidArgument("Message createdAtMs must be a non-negative safe integer");
      }
      const messageCreatedAtMs = input.createdAtMs ?? now;
      if (input.inputId) {
        const admitted = this.requireInputRow(input.inputId);
        if (admitted.session_id !== fence.sessionId) throw invalidArgument("Input belongs to another session");
      }
      const id = input.id ?? this.makeId("msg");
      assertIdentifier(id, "message id");
      const ordinal =
        (this.db
          .prepare("SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM messages WHERE session_id = ?")
          .get<{ ordinal: number }>(fence.sessionId)?.ordinal ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO messages(
             id, session_id, input_id, ordinal, role, agent, model, metadata_json, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          fence.sessionId,
          input.inputId ?? null,
          ordinal,
          input.role,
          nullableText(input.agent),
          nullableText(input.model),
          jsonOrNull(input.metadata),
          messageCreatedAtMs,
        );
      let partOrdinal = 0;
      for (const part of input.parts ?? []) {
        partOrdinal += 1;
        const partId = part.id ?? this.makeId("part");
        assertIdentifier(partId, "message part id");
        assertIdentifier(part.type, "message part type");
        this.db
          .prepare(
            `INSERT INTO message_parts(id, message_id, ordinal, type, data_json, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(partId, id, partOrdinal, part.type, canonicalJson(part.data), now);
      }
      this.appendEventTx(fence.sessionId, fence.generation, "message.appended", {
        messageId: id,
        ordinal,
        role: input.role,
        inputId: input.inputId ?? null,
        partCount: partOrdinal,
      }, now);
      return this.requireMessage(id);
    });
  }

  getMessage(messageId: string): MessageRecord | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get<MessageRow>(messageId);
    return row ? this.mapMessage(row) : null;
  }

  listMessages(sessionId: string, afterOrdinal = 0): MessageRecord[] {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND ordinal > ? ORDER BY ordinal")
      .all<MessageRow>(sessionId, Math.max(0, Math.trunc(afterOrdinal)))
      .map((row) => this.mapMessage(row));
  }

  beginToolRun(fence: RunFence, input: BeginToolRunInput): ToolRunRecord {
    assertIdentifier(input.callKey, "tool call key");
    assertIdentifier(input.toolName, "tool name");
    const attempt = boundedInteger(input.attempt ?? 1, 1, 1_000_000, "tool attempt");
    const argumentsJson = canonicalJson(input.arguments);
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      if (input.messageId) {
        const message = this.requireMessageRow(input.messageId);
        if (message.session_id !== fence.sessionId) throw invalidArgument("Message belongs to another session");
      }
      const existing = this.db
        .prepare("SELECT * FROM tool_runs WHERE session_id = ? AND call_key = ? AND attempt = ?")
        .get<ToolRow>(fence.sessionId, input.callKey, attempt);
      if (existing) {
        if (
          existing.generation !== fence.generation ||
          existing.tool_name !== input.toolName ||
          existing.arguments_json !== argumentsJson ||
          existing.mutation_transaction_id !== nullableText(input.mutationTransactionId)
        ) {
          throw new IdempotencyConflictError(fence.sessionId, `tool:${input.callKey}:${attempt}`);
        }
        return mapTool(existing);
      }
      const id = input.id ?? this.makeId("tool");
      assertIdentifier(id, "tool run id");
      this.db
        .prepare(
          `INSERT INTO tool_runs(
             id, session_id, message_id, generation, call_key, attempt, tool_name,
             execution_state, verification_state, arguments_json, effect_kind, mutation_transaction_id,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          fence.sessionId,
          input.messageId ?? null,
          fence.generation,
          input.callKey,
          attempt,
          input.toolName,
          argumentsJson,
          nullableText(input.effectKind),
          nullableText(input.mutationTransactionId),
          now,
          now,
        );
      this.appendEventTx(fence.sessionId, fence.generation, "tool.proposed", {
        toolRunId: id,
        callKey: input.callKey,
        attempt,
        toolName: input.toolName,
      }, now);
      return mapTool(this.requireToolRow(id));
    });
  }

  transitionToolRun(
    fence: RunFence,
    toolRunId: string,
    target: ToolExecutionState,
    input: TransitionToolRunInput = {},
  ): ToolRunRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const row = this.requireToolRow(toolRunId);
      if (row.session_id !== fence.sessionId || row.generation !== fence.generation) {
        throw new StaleGenerationError(fence.sessionId, fence.generation, "tool run belongs to another generation");
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) {
        throw new RevisionConflictError("tool run", toolRunId, input.expectedRevision, row.revision);
      }
      const terminal = target === "succeeded" || target === "failed" || target === "effect_unknown";
      if (input.mutation && !terminal) {
        throw invalidArgument("Mutation scope can only be committed with terminal tool settlement");
      }
      if (row.execution_state === target) {
        if (input.mutation) {
          this.recordSessionMutationTx(fence, {
            ...input.mutation,
            toolRunId,
          }, now);
        }
        return mapTool(row);
      }
      if (!TOOL_TRANSITIONS[row.execution_state].has(target)) {
        throw new InvalidStateTransitionError("tool run", toolRunId, row.execution_state, target);
      }
      const resultJson = input.result === undefined ? row.result_json : jsonOrNull(input.result);
      const errorJson = input.error === undefined ? row.error_json : jsonOrNull(input.error);
      const checkpointId = input.checkpointId === undefined ? row.checkpoint_id : nullableText(input.checkpointId);
      const effectKind = input.effectKind === undefined ? row.effect_kind : nullableText(input.effectKind);
      this.db
        .prepare(
          `UPDATE tool_runs
           SET execution_state = ?, result_json = ?, error_json = ?, checkpoint_id = ?, effect_kind = ?,
               revision = revision + 1, updated_at_ms = ?,
               started_at_ms = CASE WHEN ? = 'executing' AND started_at_ms IS NULL THEN ? ELSE started_at_ms END,
               settled_at_ms = CASE WHEN ? = 1 THEN ? ELSE settled_at_ms END
           WHERE id = ? AND revision = ?`,
        )
        .run(
          target,
          resultJson,
          errorJson,
          checkpointId,
          effectKind,
          now,
          target,
          now,
          terminal ? 1 : 0,
          now,
          toolRunId,
          row.revision,
        );
      this.appendEventTx(fence.sessionId, fence.generation, `tool.${target}`, {
        toolRunId,
        callKey: row.call_key,
        revision: row.revision + 1,
      }, now);
      if (input.mutation) {
        this.recordSessionMutationTx(fence, {
          ...input.mutation,
          toolRunId,
        }, now);
      }
      return mapTool(this.requireToolRow(toolRunId));
    });
  }

  /** Dedicated recovery path for mutation scope discovered after a terminal
   * settlement (for example checkpoint reconciliation). Normal Session tools
   * pass `TransitionToolRunInput.mutation` so result + scope are atomic. */
  recordSessionMutation(fence: RunFence, input: RecordSessionMutationInput): SessionMutationRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      return this.recordSessionMutationTx(fence, input, now);
    });
  }

  listUnresolvedSessionMutations(sessionId: string): SessionMutationRecord[] {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    return this.db
      .prepare(
        `SELECT * FROM session_mutations
         WHERE session_id = ? AND resolved_generation IS NULL
         ORDER BY generation, observed_at_ms, id`,
      )
      .all<SessionMutationRow>(sessionId)
      .map(mapSessionMutation);
  }

  resolveSessionMutations(fence: RunFence): number {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const changed = this.db
        .prepare(
          `UPDATE session_mutations
           SET resolved_generation = ?, resolved_at_ms = ?
           WHERE session_id = ? AND resolved_generation IS NULL`,
        )
        .run(fence.generation, now, fence.sessionId).changes;
      if (changed > 0) {
        this.appendEventTx(fence.sessionId, fence.generation, "mutation_scope.resolved", {
          count: changed,
          resolvedGeneration: fence.generation,
        }, now);
      }
      return changed;
    });
  }

  setToolVerification(
    fence: RunFence,
    toolRunId: string,
    target: ToolVerificationState,
    evidence?: JsonValue,
  ): ToolRunRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const row = this.requireToolRow(toolRunId);
      if (row.session_id !== fence.sessionId || row.generation !== fence.generation) {
        throw new StaleGenerationError(fence.sessionId, fence.generation, "tool run belongs to another generation");
      }
      if (!isSettledToolState(row.execution_state)) {
        throw new InvalidStateTransitionError(
          "tool verification",
          toolRunId,
          row.execution_state,
          target,
        );
      }
      if (row.verification_state === target) return mapTool(row);
      if (row.verification_state === "verified" || row.verification_state === "not_required") {
        throw new InvalidStateTransitionError(
          "tool verification",
          toolRunId,
          row.verification_state,
          target,
        );
      }
      this.db
        .prepare(
          `UPDATE tool_runs
           SET verification_state = ?, revision = revision + 1, updated_at_ms = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(target, now, toolRunId, row.revision);
      this.appendEventTx(fence.sessionId, fence.generation, "tool.verification", {
        toolRunId,
        verificationState: target,
        evidence: evidence ?? null,
      }, now);
      return mapTool(this.requireToolRow(toolRunId));
    });
  }

  /** Resolve a previously unknown transactional file effect from its durable
   * mutation journal. This is an explicit reconciliation transition, not a
   * retry of the tool implementation. */
  reconcileToolRunEffect(
    fence: RunFence,
    toolRunId: string,
    input: ReconcileToolRunEffectInput,
  ): ToolRunRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const row = this.requireToolRow(toolRunId);
      if (row.session_id !== fence.sessionId) throw invalidArgument("Tool run belongs to another session");
      if (row.execution_state !== "effect_unknown") {
        if (input.mutation) {
          this.recordSessionMutationTx(fence, { ...input.mutation, toolRunId }, now);
        }
        return mapTool(row);
      }
      const target = input.disposition === "fully_applied"
        ? "succeeded"
        : input.disposition === "not_applied"
          ? "failed"
          : "effect_unknown";
      const verification = input.disposition === "fully_applied"
        ? "unverified"
        : input.disposition === "not_applied"
          ? "not_required"
          : "blocked";
      const source = input.source ?? "workspace-mutation";
      const result = input.disposition === "fully_applied"
        ? canonicalJson(input.recoveredResult ?? {
            recoveredEffect: input.evidence,
            reconciliationSource: source,
          })
        : row.result_json;
      const error = input.disposition === "fully_applied"
        ? row.error_json
        : canonicalJson({
            message: input.reason ?? (
              input.disposition === "not_applied"
                ? input.retryPolicy === "after-reconciled-not-applied" || input.retryPolicy === "idempotent-with-key"
                  ? "Observational reconciliation proved the prior effect was not applied. A new explicit attempt is allowed by the tool policy; Ares did not replay it automatically."
                  : "Observational reconciliation proved the prior effect was not applied. The tool policy forbids automatic or implicit retry."
                : "Effect reconciliation remains indeterminate. Do not retry the call until an owner resolves the target state."
            ),
            effectReconciliation: input.evidence,
            reconciliationSource: source,
            retryPolicy: input.retryPolicy ?? "never",
            reconcilerKey: input.reconcilerKey ?? null,
            reason: input.reason ?? null,
          });
      this.db.prepare(
        `UPDATE tool_runs
         SET execution_state = ?, verification_state = ?, result_json = ?, error_json = ?,
             revision = revision + 1, updated_at_ms = ?, settled_at_ms = ?
         WHERE id = ? AND revision = ?`,
      ).run(target, verification, result, error, now, now, toolRunId, row.revision);
      this.appendEventTx(fence.sessionId, fence.generation, "tool.effect_reconciled", {
        toolRunId,
        mutationTransactionId: row.mutation_transaction_id,
        source,
        disposition: input.disposition,
        evidence: input.evidence,
        retryPolicy: input.retryPolicy ?? null,
        reconcilerKey: input.reconcilerKey ?? null,
      }, now);
      if (input.mutation) {
        this.recordSessionMutationTx(fence, { ...input.mutation, toolRunId }, now);
      }
      return mapTool(this.requireToolRow(toolRunId));
    });
  }

  getToolRun(toolRunId: string): ToolRunRecord | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM tool_runs WHERE id = ?").get<ToolRow>(toolRunId);
    return row ? mapTool(row) : null;
  }

  listToolRuns(sessionId: string): ToolRunRecord[] {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    return this.db
      .prepare("SELECT * FROM tool_runs WHERE session_id = ? ORDER BY created_at_ms, id")
      .all<ToolRow>(sessionId)
      .map(mapTool);
  }

  appendContextEpoch(fence: RunFence, input: AppendContextEpochInput): ContextEpochRecord {
    assertIdentifier(input.reason, "context epoch reason");
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const session = this.requireSessionRow(fence.sessionId);
      const latest = this.db
        .prepare("SELECT * FROM context_epochs WHERE session_id = ? ORDER BY epoch DESC LIMIT 1")
        .get<EpochRow>(fence.sessionId);
      if (
        input.coalesceLatest === true &&
        input.id === undefined &&
        latest?.reason === input.reason &&
        latest.generation === fence.generation
      ) {
        // A microcompaction is a refreshed model-view checkpoint, not a new
        // semantic boundary. Replacing only the latest same-generation row is
        // safe because no later epoch can reference its previous projection.
        this.db
          .prepare(
            `UPDATE context_epochs
             SET summary_json = ?, projection_json = ?, source_versions_json = ?,
                 base_event_sequence = ?, token_count = ?, created_at_ms = ?
             WHERE id = ?`,
          )
          .run(
            canonicalJson(input.summary),
            canonicalJson(input.projection),
            canonicalJson(input.sourceVersions ?? {}),
            input.baseEventSequence ?? null,
            input.tokenCount ?? null,
            now,
            latest.id,
          );
        this.db
          .prepare("UPDATE sessions SET updated_at_ms = ? WHERE id = ?")
          .run(now, fence.sessionId);
        return mapEpoch(this.requireEpochRow(latest.id));
      }
      const epoch = session.current_context_epoch + 1;
      const id = input.id ?? this.makeId("ctx");
      assertIdentifier(id, "context epoch id");
      this.db
        .prepare(
          `INSERT INTO context_epochs(
             id, session_id, epoch, previous_epoch_id, generation, reason, summary_json,
             projection_json, source_versions_json, base_event_sequence, token_count, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          fence.sessionId,
          epoch,
          latest?.id ?? null,
          fence.generation,
          input.reason,
          canonicalJson(input.summary),
          canonicalJson(input.projection),
          canonicalJson(input.sourceVersions ?? {}),
          input.baseEventSequence ?? null,
          input.tokenCount ?? null,
          now,
        );
      this.db
        .prepare("UPDATE sessions SET current_context_epoch = ?, updated_at_ms = ? WHERE id = ?")
        .run(epoch, now, fence.sessionId);
      // Superseded epochs are dead weight: resume reads ONLY the latest
      // projection, nothing lists older epochs, and each row carries a full
      // message-history projection (megabytes on a long session). Left alone
      // they accumulated 357MB of sqlite in one field workspace. Keep the
      // previous one for forensics; the FK is ON DELETE SET NULL so the chain
      // degrades safely.
      this.db
        .prepare("DELETE FROM context_epochs WHERE session_id = ? AND epoch < ?")
        .run(fence.sessionId, epoch - 1);
      this.appendEventTx(fence.sessionId, fence.generation, "context.epoch_created", {
        contextEpochId: id,
        epoch,
        previousEpochId: latest?.id ?? null,
        reason: input.reason,
      }, now);
      return mapEpoch(this.requireEpochRow(id));
    });
  }

  getLatestContextEpoch(sessionId: string): ContextEpochRecord | null {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    const row = this.db
      .prepare("SELECT * FROM context_epochs WHERE session_id = ? ORDER BY epoch DESC LIMIT 1")
      .get<EpochRow>(sessionId);
    return row ? mapEpoch(row) : null;
  }

  listContextEpochs(sessionId: string): ContextEpochRecord[] {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    return this.db
      .prepare("SELECT * FROM context_epochs WHERE session_id = ? ORDER BY epoch")
      .all<EpochRow>(sessionId)
      .map(mapEpoch);
  }

  createPlanRevision(input: CreatePlanRevisionInput): PlanRevisionRecord {
    assertIdentifier(input.sessionId, "session id");
    if (!input.body.trim()) throw invalidArgument("Plan body must not be empty");
    const now = this.now();
    return this.immediate(() => {
      this.requireSessionRow(input.sessionId);
      if (input.fence) {
        if (input.fence.sessionId !== input.sessionId) throw invalidArgument("Plan fence belongs to another session");
        this.assertFenceTx(input.fence, now);
      }
      const executing = this.db
        .prepare("SELECT id FROM plan_revisions WHERE session_id = ? AND status = 'executing'")
        .get<{ id: string }>(input.sessionId);
      if (executing) {
        throw new PlanConflictError("Cannot revise a plan while another revision is executing", {
          sessionId: input.sessionId,
          executingPlanRevisionId: executing.id,
        });
      }
      const revision =
        (this.db
          .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM plan_revisions WHERE session_id = ?")
          .get<{ revision: number }>(input.sessionId)?.revision ?? 0) + 1;
      this.db
        .prepare(
          `UPDATE plan_revisions SET status = 'superseded', updated_at_ms = ?
           WHERE session_id = ? AND status IN ('draft','awaiting_approval','approved')`,
        )
        .run(now, input.sessionId);
      const id = input.id ?? this.makeId("plan");
      const hash = planHash(input.body);
      this.db
        .prepare(
          `INSERT INTO plan_revisions(
             id, session_id, revision, body, plan_hash, status, author, metadata_json,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          revision,
          input.body,
          hash,
          nullableText(input.author),
          jsonOrNull(input.metadata),
          now,
          now,
        );
      this.appendEventTx(input.sessionId, input.fence?.generation ?? null, "plan.revision_created", {
        planRevisionId: id,
        revision,
        planHash: hash,
      }, now);
      return mapPlan(this.requirePlanRow(id));
    });
  }

  requestPlanApproval(planRevisionId: string, expectedPlanHash: string, fence?: RunFence): PlanRevisionRecord {
    const now = this.now();
    return this.immediate(() => {
      const row = this.requirePlanRow(planRevisionId);
      if (fence) {
        if (fence.sessionId !== row.session_id) throw invalidArgument("Plan fence belongs to another session");
        this.assertFenceTx(fence, now);
      }
      this.assertPlanHash(row, expectedPlanHash);
      if (row.status === "awaiting_approval") return mapPlan(row);
      this.transitionPlanTx(row, "awaiting_approval", now);
      this.appendEventTx(row.session_id, fence?.generation ?? null, "plan.approval_requested", {
        planRevisionId,
        revision: row.revision,
        planHash: row.plan_hash,
      }, now);
      return mapPlan(this.requirePlanRow(planRevisionId));
    });
  }

  decidePlan(input: DecidePlanInput): { plan: PlanRevisionRecord; approval: PlanApprovalRecord } {
    assertIdentifier(input.approver, "plan approver");
    const now = this.now();
    return this.immediate(() => {
      const row = this.requirePlanRow(input.planRevisionId);
      this.assertPlanHash(row, input.expectedPlanHash);
      const target = input.decision === "approved" ? "approved" : "rejected";
      const existing = this.db
        .prepare("SELECT * FROM plan_approvals WHERE plan_revision_id = ?")
        .get<ApprovalRow>(row.id);
      if (existing) {
        if (existing.plan_hash !== row.plan_hash || existing.decision !== input.decision) {
          throw new PlanConflictError("Plan revision already has a different durable decision", {
            planRevisionId: row.id,
            planHash: row.plan_hash,
            existingDecision: existing.decision,
            requestedDecision: input.decision,
          });
        }
        // The exact decision already committed. It may have advanced from
        // approved -> executing/completed since then; never insert a duplicate
        // approval or force the state machine backwards on an idempotent retry.
        return { plan: mapPlan(row), approval: mapApproval(existing) };
      }
      this.transitionPlanTx(row, target, now);
      const approvalId = this.makeId("approval");
      this.db
        .prepare(
          `INSERT INTO plan_approvals(
             id, plan_revision_id, approver, decision, plan_hash, metadata_json, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          approvalId,
          row.id,
          input.approver,
          input.decision,
          row.plan_hash,
          jsonOrNull(input.metadata),
          now,
        );
      this.appendEventTx(row.session_id, null, `plan.${input.decision}`, {
        planRevisionId: row.id,
        revision: row.revision,
        planHash: row.plan_hash,
        approver: input.approver,
        approvalId,
      }, now);
      return {
        plan: mapPlan(this.requirePlanRow(row.id)),
        approval: mapApproval(this.requireApprovalRow(approvalId)),
      };
    });
  }

  /** Commit approval, synthetic build handoff admission, and durable build mode
   * as one crash-consistent owner transition. Nested public operations use
   * savepoints under this outer BEGIN IMMEDIATE transaction. */
  approvePlanForBuild(input: ApprovePlanForBuildInput): ApprovedPlanBuildHandoff {
    const now = this.now();
    return this.immediate(() => {
      const candidate = this.requirePlanRow(input.planRevisionId);
      const active = this.db
        .prepare(
          `SELECT * FROM plan_revisions
           WHERE session_id = ? AND status IN ('draft','awaiting_approval','approved','executing')
           ORDER BY revision DESC LIMIT 1`,
        )
        .get<PlanRow>(candidate.session_id);
      if (
        !active ||
        active.id !== candidate.id ||
        !["awaiting_approval", "approved", "executing"].includes(candidate.status)
      ) {
        throw new PlanConflictError("Only the active proposed revision can become the build handoff", {
          sessionId: candidate.session_id,
          requestedPlanRevisionId: candidate.id,
          requestedStatus: candidate.status,
          activePlanRevisionId: active?.id ?? null,
          activeStatus: active?.status ?? null,
        });
      }
      const decided = this.decidePlan({
        planRevisionId: input.planRevisionId,
        expectedPlanHash: input.expectedPlanHash,
        approver: input.approver,
        decision: "approved",
        metadata: input.metadata,
      });
      const admission = this.admitInput({
        id: input.handoff.id,
        sessionId: decided.plan.sessionId,
        idempotencyKey: input.handoff.idempotencyKey,
        delivery: "steer",
        payload: input.handoff.payload,
      });
      const session = this.setWorkflowMode(decided.plan.sessionId, "build");
      if (admission.inserted) {
        this.appendEventTx(decided.plan.sessionId, null, "plan.build_handoff_admitted", {
          planRevisionId: decided.plan.id,
          revision: decided.plan.revision,
          planHash: decided.plan.planHash,
          inputId: admission.record.id,
        }, now);
      }
      return {
        ...decided,
        input: admission.record,
        inputInserted: admission.inserted,
        session,
      };
    });
  }

  beginPlanExecution(fence: RunFence, planRevisionId: string, expectedPlanHash: string): PlanRevisionRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const row = this.requirePlanRow(planRevisionId);
      if (row.session_id !== fence.sessionId) throw invalidArgument("Plan belongs to another session");
      this.assertPlanHash(row, expectedPlanHash);
      const approval = this.db
        .prepare("SELECT * FROM plan_approvals WHERE plan_revision_id = ? AND decision = 'approved'")
        .get<ApprovalRow>(row.id);
      if (!approval || approval.plan_hash !== row.plan_hash) {
        throw new PlanConflictError("Plan revision does not have a matching durable approval", {
          planRevisionId,
          planHash: row.plan_hash,
        });
      }
      this.transitionPlanTx(row, "executing", now);
      this.appendEventTx(fence.sessionId, fence.generation, "plan.execution_started", {
        planRevisionId,
        revision: row.revision,
        planHash: row.plan_hash,
      }, now);
      return mapPlan(this.requirePlanRow(planRevisionId));
    });
  }

  finishPlanExecution(
    fence: RunFence,
    planRevisionId: string,
    status: "completed" | "failed",
  ): PlanRevisionRecord {
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      const row = this.requirePlanRow(planRevisionId);
      if (row.session_id !== fence.sessionId) throw invalidArgument("Plan belongs to another session");
      this.transitionPlanTx(row, status, now);
      this.appendEventTx(fence.sessionId, fence.generation, `plan.${status}`, {
        planRevisionId,
        revision: row.revision,
        planHash: row.plan_hash,
      }, now);
      return mapPlan(this.requirePlanRow(planRevisionId));
    });
  }

  getPlanRevision(planRevisionId: string): PlanRevisionRecord | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM plan_revisions WHERE id = ?").get<PlanRow>(planRevisionId);
    return row ? mapPlan(row) : null;
  }

  listPlanRevisions(sessionId: string): PlanRevisionRecord[] {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    return this.db
      .prepare("SELECT * FROM plan_revisions WHERE session_id = ? ORDER BY revision")
      .all<PlanRow>(sessionId)
      .map(mapPlan);
  }

  getActivePlan(sessionId: string): PlanRevisionRecord | null {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    const row = this.db
      .prepare(
        `SELECT * FROM plan_revisions
         WHERE session_id = ? AND status IN ('draft','awaiting_approval','approved','executing')
         ORDER BY revision DESC LIMIT 1`,
      )
      .get<PlanRow>(sessionId);
    return row ? mapPlan(row) : null;
  }

  /**
   * Retire an un-approved plan so an explicit owner mode change is never
   * blocked by a draft the model left behind.
   *
   * Only `draft` and `awaiting_approval` are retired — an `approved` or
   * `executing` plan is real committed work and is left alone. This is
   * deliberately NOT an approval path: the plan is superseded, never treated
   * as accepted, so the model can gain no write authority through it.
   */
  supersedeActivePlan(sessionId: string, reason: string): PlanRevisionRecord | null {
    assertIdentifier(sessionId, "session id");
    const now = this.now();
    return this.immediate(() => {
      this.requireSessionRow(sessionId);
      const row = this.db
        .prepare(
          `SELECT * FROM plan_revisions
           WHERE session_id = ? AND status IN ('draft','awaiting_approval')
           ORDER BY revision DESC LIMIT 1`,
        )
        .get<PlanRow>(sessionId);
      if (!row) return null;
      this.transitionPlanTx(row, "superseded", now);
      this.appendEventTx(sessionId, null, "plan.superseded", {
        planRevisionId: row.id,
        revision: row.revision,
        planHash: row.plan_hash,
        reason,
      }, now);
      return mapPlan(this.requirePlanRow(row.id));
    });
  }

  appendEvent(fence: RunFence, type: string, payload: JsonValue): SessionEventRecord {
    assertIdentifier(type, "event type");
    const now = this.now();
    return this.immediate(() => {
      this.assertFenceTx(fence, now);
      return this.appendEventTx(fence.sessionId, fence.generation, type, payload, now);
    });
  }

  listEvents(sessionId: string, options: { afterSequence?: number; limit?: number } = {}): SessionEventRecord[] {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    const after = Math.max(0, Math.trunc(options.afterSequence ?? 0));
    const limit = boundedInteger(options.limit ?? 1_000, 1, 10_000, "event limit");
    return this.db
      .prepare(
        `SELECT * FROM session_events
         WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
      )
      .all<EventRow>(sessionId, after, limit)
      .map(mapEvent);
  }

  countEvents(sessionId: string): number {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    return this.db.prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?")
      .get<{ count: number }>(sessionId)!.count;
  }

  getLatestEvent(sessionId: string, type: string): SessionEventRecord | null {
    this.assertOpen();
    this.requireSessionRow(sessionId);
    assertIdentifier(type, "event type");
    const row = this.db.prepare(
      "SELECT * FROM session_events WHERE session_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1",
    ).get<EventRow>(sessionId, type);
    return row ? mapEvent(row) : null;
  }

  snapshot(sessionId: string): SessionSnapshot {
    this.assertOpen();
    const session = this.requireSession(sessionId);
    const latestRunRow = this.db
      .prepare("SELECT * FROM session_runs WHERE session_id = ? ORDER BY generation DESC LIMIT 1")
      .get<RunRow>(sessionId);
    return {
      session,
      lease: this.getRunnerLease(sessionId),
      latestRun: latestRunRow ? mapRun(latestRunRow) : null,
      pendingInputs: this.listInputs(sessionId, "admitted"),
      latestContextEpoch: this.getLatestContextEpoch(sessionId),
      activePlan: this.getActivePlan(sessionId),
    };
  }

  private sessionTreeRows(sessionId: string): SessionRow[] {
    return this.db.prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM sessions WHERE id = ?
         UNION ALL
         SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id
       )
       SELECT s.* FROM sessions s JOIN tree t ON t.id = s.id`,
    ).all<SessionRow>(sessionId);
  }

  private sessionTreeRowsWithDepth(sessionId: string): Array<SessionRow & { tree_depth: number }> {
    return this.db.prepare(
      `WITH RECURSIVE tree(id, tree_depth) AS (
         SELECT id, 0 FROM sessions WHERE id = ?
         UNION ALL
         SELECT s.id, t.tree_depth + 1 FROM sessions s JOIN tree t ON s.parent_session_id = t.id
       )
       SELECT s.*, t.tree_depth FROM sessions s JOIN tree t ON t.id = s.id`,
    ).all<SessionRow & { tree_depth: number }>(sessionId);
  }

  private recoverExpiredLeaseTx(lease: LeaseRow, now: number): void {
    const reason: JsonValue = {
      code: "LEASE_EXPIRED",
      message: "The previous runner lease expired before it settled",
      previousOwnerId: lease.owner_id,
      previousGeneration: lease.generation,
    };
    this.db
      .prepare(
        `UPDATE tool_runs
         SET execution_state = 'effect_unknown', verification_state = 'unverified',
             error_json = ?, revision = revision + 1, updated_at_ms = ?, settled_at_ms = ?
         WHERE session_id = ? AND generation = ? AND execution_state = 'executing'`,
      )
      .run(canonicalJson(reason), now, now, lease.session_id, lease.generation);
    this.db
      .prepare(
        `UPDATE tool_runs
         SET execution_state = 'failed', verification_state = 'not_required',
             error_json = ?, revision = revision + 1, updated_at_ms = ?, settled_at_ms = ?
         WHERE session_id = ? AND generation = ?
           AND execution_state IN ('proposed','validated','authorized','checkpointed')`,
      )
      .run(canonicalJson(reason), now, now, lease.session_id, lease.generation);
    this.db
      .prepare(
        `UPDATE admitted_inputs
         SET state = 'admitted', claimed_generation = NULL, claimed_at_ms = NULL
         WHERE session_id = ? AND state = 'claimed' AND claimed_generation = ?`,
      )
      .run(lease.session_id, lease.generation);
    this.db
      .prepare(
        `UPDATE session_runs
         SET execution_state = 'interrupted',
             work_outcome = CASE WHEN work_outcome = 'pending' THEN 'unverified' ELSE work_outcome END,
             ended_at_ms = ?, error_json = ?
         WHERE session_id = ? AND generation = ? AND ended_at_ms IS NULL`,
      )
      .run(now, canonicalJson(reason), lease.session_id, lease.generation);
    this.db.prepare("DELETE FROM runner_leases WHERE session_id = ?").run(lease.session_id);
    this.appendEventTx(lease.session_id, lease.generation, "runner.lease_expired", reason, now);
  }

  private assertFenceTx(fence: RunFence, now: number): LeaseRow {
    const session = this.sessionRow(fence.sessionId);
    if (!session) throw new SessionNotFoundError(fence.sessionId);
    if (session.current_generation !== fence.generation) {
      throw new StaleGenerationError(
        fence.sessionId,
        fence.generation,
        `current generation is ${session.current_generation}`,
      );
    }
    const lease = this.leaseRow(fence.sessionId);
    if (!lease) throw new StaleGenerationError(fence.sessionId, fence.generation, "runner lease no longer exists");
    if (lease.generation !== fence.generation || lease.lease_token !== fence.leaseToken) {
      throw new StaleGenerationError(fence.sessionId, fence.generation, "runner lease token does not match");
    }
    if (lease.expires_at_ms <= now) {
      throw new StaleGenerationError(fence.sessionId, fence.generation, "runner lease has expired");
    }
    return lease;
  }

  private transitionPlanTx(row: PlanRow, target: PlanStatus, now: number): void {
    if (row.status === target) return;
    if (!PLAN_TRANSITIONS[row.status].has(target)) {
      throw new InvalidStateTransitionError("plan revision", row.id, row.status, target);
    }
    const changed = this.db
      .prepare("UPDATE plan_revisions SET status = ?, updated_at_ms = ? WHERE id = ? AND status = ?")
      .run(target, now, row.id, row.status).changes;
    if (changed !== 1) throw new PlanConflictError("Plan revision changed concurrently", { planRevisionId: row.id });
  }

  private assertPlanHash(row: PlanRow, expected: string): void {
    if (row.plan_hash !== expected) {
      throw new PlanConflictError("Plan content does not match the approved revision", {
        planRevisionId: row.id,
        expectedPlanHash: expected,
        actualPlanHash: row.plan_hash,
      });
    }
  }

  private appendEventTx(
    sessionId: string,
    generation: number | null,
    type: string,
    payload: JsonValue,
    now: number,
  ): SessionEventRecord {
    const id = this.makeId("evt");
    const result = this.db
      .prepare(
        `INSERT INTO session_events(id, session_id, generation, type, payload_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, generation, type, canonicalJson(payload), now);
    return {
      sequence: Number(result.lastInsertRowid),
      id,
      sessionId,
      generation,
      type,
      payload,
      createdAtMs: now,
    };
  }

  private recordSessionMutationTx(
    fence: RunFence,
    input: RecordSessionMutationInput,
    now: number,
  ): SessionMutationRecord {
    assertIdentifier(input.toolUseId, "tool use id");
    const toolRun = this.requireToolRow(input.toolRunId);
    if (toolRun.session_id !== fence.sessionId) {
      throw new StaleGenerationError(fence.sessionId, fence.generation, "mutation tool run belongs to another session");
    }
    if (!isSettledToolState(toolRun.execution_state)) {
      throw new InvalidStateTransitionError(
        "session mutation",
        input.toolRunId,
        toolRun.execution_state,
        "recorded",
      );
    }
    const uniquePaths = [...new Set(input.affectedPaths
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean))];
    if (uniquePaths.length === 0) throw invalidArgument("Mutation scope must contain at least one affected path");
    const incomingTruncated = uniquePaths.length > 240;
    const incomingPaths = uniquePaths.slice(0, 240);
    const incomingComplete = input.scopeComplete !== false && !incomingTruncated;
    const existing = this.db
      .prepare(
        `SELECT * FROM session_mutations
         WHERE session_id = ? AND generation = ? AND tool_use_id = ?`,
      )
      .get<SessionMutationRow>(fence.sessionId, fence.generation, input.toolUseId);
    if (existing) {
      if (existing.tool_run_id !== input.toolRunId) {
        throw new IdempotencyConflictError(fence.sessionId, `mutation:${fence.generation}:${input.toolUseId}`);
      }
      const priorValue = parseJson(existing.affected_paths_json);
      const priorPaths = Array.isArray(priorValue)
        ? priorValue.filter((value): value is string => typeof value === "string")
        : [];
      const combined = [...new Set([...priorPaths, ...incomingPaths])];
      const combinedTruncated = combined.length > 240;
      const affectedPaths = combined.slice(0, 240);
      const scopeComplete = existing.scope_complete === 1 && incomingComplete && !combinedTruncated;
      if (
        canonicalJson(affectedPaths) !== existing.affected_paths_json ||
        Number(scopeComplete) !== existing.scope_complete
      ) {
        this.db
          .prepare(
            `UPDATE session_mutations
             SET affected_paths_json = ?, scope_complete = ?
             WHERE id = ?`,
          )
          .run(canonicalJson(affectedPaths), scopeComplete ? 1 : 0, existing.id);
      }
      return mapSessionMutation(this.requireSessionMutationRow(existing.id));
    }

    const id = `mutation_${createHash("sha256")
      .update(`${fence.sessionId}\0${fence.generation}\0${input.toolUseId}`)
      .digest("hex")
      .slice(0, 32)}`;
    this.db
      .prepare(
        `INSERT INTO session_mutations(
           id, session_id, generation, tool_run_id, tool_use_id,
           affected_paths_json, scope_complete, observed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fence.sessionId,
        fence.generation,
        input.toolRunId,
        input.toolUseId,
        canonicalJson(incomingPaths),
        incomingComplete ? 1 : 0,
        now,
      );
    this.appendEventTx(fence.sessionId, fence.generation, "mutation_scope.recorded", {
      mutationId: id,
      toolRunId: input.toolRunId,
      toolUseId: input.toolUseId,
      affectedPaths: incomingPaths,
      scopeComplete: incomingComplete,
    }, now);
    return mapSessionMutation(this.requireSessionMutationRow(id));
  }

  private immediate<T>(operation: () => T): T {
    this.assertOpen();
    if (this.transactionDepth > 0) {
      const savepoint = `session_kernel_${++this.savepointCounter}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const result = operation();
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionKernelError("KERNEL_CLOSED", "Session kernel store is closed");
  }

  private sessionRow(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get<SessionRow>(id);
  }

  private sessionTombstoneRow(id: string): SessionTombstoneRow | undefined {
    return this.db
      .prepare("SELECT * FROM session_tombstones WHERE session_id = ?")
      .get<SessionTombstoneRow>(id);
  }

  private requireSessionTombstoneRow(id: string): SessionTombstoneRow {
    const row = this.sessionTombstoneRow(id);
    if (!row) throw new SessionKernelError("SESSION_NOT_FOUND", `Session tombstone does not exist: ${id}`);
    return row;
  }

  private assertSessionIdNotTombstoned(id: string): void {
    if (this.sessionTombstoneRow(id)) {
      throw invalidArgument(`Session was permanently deleted and cannot be recreated: ${id}`);
    }
  }

  private requireSessionRow(id: string): SessionRow {
    const row = this.sessionRow(id);
    if (!row) throw new SessionNotFoundError(id);
    return row;
  }

  private leaseRow(sessionId: string): LeaseRow | undefined {
    return this.db.prepare("SELECT * FROM runner_leases WHERE session_id = ?").get<LeaseRow>(sessionId);
  }

  private requireLeaseRow(sessionId: string): LeaseRow {
    const row = this.leaseRow(sessionId);
    if (!row) throw new StaleGenerationError(sessionId, -1, "runner lease does not exist");
    return row;
  }

  private requireRunRow(sessionId: string, generation: number): RunRow {
    const row = this.db
      .prepare("SELECT * FROM session_runs WHERE session_id = ? AND generation = ?")
      .get<RunRow>(sessionId, generation);
    if (!row) throw new StaleGenerationError(sessionId, generation, "session run does not exist");
    return row;
  }

  private requireInputRow(id: string): InputRow {
    const row = this.db.prepare("SELECT * FROM admitted_inputs WHERE id = ?").get<InputRow>(id);
    if (!row) throw new SessionKernelError("INPUT_NOT_FOUND", `Input does not exist: ${id}`, { inputId: id });
    return row;
  }

  private detachedInputResultRow(inputId: string): DetachedInputResultRow | undefined {
    return this.db
      .prepare("SELECT * FROM detached_input_results WHERE input_id = ?")
      .get<DetachedInputResultRow>(inputId);
  }

  private requireDetachedInputResultRow(inputId: string): DetachedInputResultRow {
    const row = this.detachedInputResultRow(inputId);
    if (!row) throw new SessionKernelError("INVALID_ARGUMENT", `Detached input result does not exist: ${inputId}`);
    return row;
  }

  private requireSessionMutationRow(id: string): SessionMutationRow {
    const row = this.db.prepare("SELECT * FROM session_mutations WHERE id = ?").get<SessionMutationRow>(id);
    if (!row) throw new SessionKernelError("INVALID_ARGUMENT", `Session mutation does not exist: ${id}`);
    return row;
  }

  private requireMessageRow(id: string): MessageRow {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get<MessageRow>(id);
    if (!row) throw new SessionKernelError("MESSAGE_NOT_FOUND", `Message does not exist: ${id}`, { messageId: id });
    return row;
  }

  private backgroundJobRow(id: string): BackgroundJobRow | undefined {
    return this.db.prepare("SELECT * FROM background_jobs WHERE id = ?").get<BackgroundJobRow>(id);
  }

  private requireBackgroundJobRow(id: string): BackgroundJobRow {
    const row = this.backgroundJobRow(id);
    if (!row) throw new SessionKernelError("INVALID_ARGUMENT", `Background job does not exist: ${id}`);
    return row;
  }

  private requireMessage(id: string): MessageRecord {
    return this.mapMessage(this.requireMessageRow(id));
  }

  private mapMessage(row: MessageRow): MessageRecord {
    const parts = this.db
      .prepare("SELECT * FROM message_parts WHERE message_id = ? ORDER BY ordinal")
      .all<PartRow>(row.id)
      .map(mapPart);
    return {
      id: row.id,
      sessionId: row.session_id,
      inputId: row.input_id,
      ordinal: row.ordinal,
      role: row.role,
      agent: row.agent,
      model: row.model,
      metadata: parseJson(row.metadata_json),
      parts,
      createdAtMs: row.created_at_ms,
    };
  }

  private requireToolRow(id: string): ToolRow {
    const row = this.db.prepare("SELECT * FROM tool_runs WHERE id = ?").get<ToolRow>(id);
    if (!row) throw new SessionKernelError("TOOL_RUN_NOT_FOUND", `Tool run does not exist: ${id}`, { toolRunId: id });
    return row;
  }

  private requireEpochRow(id: string): EpochRow {
    const row = this.db.prepare("SELECT * FROM context_epochs WHERE id = ?").get<EpochRow>(id);
    if (!row) throw new SessionKernelError("INVALID_ARGUMENT", `Context epoch does not exist: ${id}`);
    return row;
  }

  private requirePlanRow(id: string): PlanRow {
    const row = this.db.prepare("SELECT * FROM plan_revisions WHERE id = ?").get<PlanRow>(id);
    if (!row) throw new SessionKernelError("PLAN_NOT_FOUND", `Plan revision does not exist: ${id}`, { planRevisionId: id });
    return row;
  }

  private requireApprovalRow(id: string): ApprovalRow {
    const row = this.db.prepare("SELECT * FROM plan_approvals WHERE id = ?").get<ApprovalRow>(id);
    if (!row) throw new SessionKernelError("PLAN_NOT_FOUND", `Plan approval does not exist: ${id}`);
    return row;
  }
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id,
    workspaceKey: row.workspace_key,
    title: row.title,
    metadata: parseJson(row.metadata_json),
    currentGeneration: row.current_generation,
    executionState: row.execution_state,
    workOutcome: row.work_outcome,
    currentContextEpoch: row.current_context_epoch,
    workflowMode: row.workflow_mode,
    archived: row.archived === 1,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapSessionTombstone(row: SessionTombstoneRow): SessionTombstoneRecord {
  return {
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id,
    workspaceKey: row.workspace_key,
    deletionSource: row.deletion_source,
    deletedAtMs: row.deleted_at_ms,
  };
}

function mapInput(row: InputRow): AdmittedInputRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    delivery: row.delivery,
    payload: parseJson(row.payload_json)!,
    state: row.state,
    admissionSequence: row.admission_sequence,
    claimedGeneration: row.claimed_generation,
    admittedAtMs: row.admitted_at_ms,
    claimedAtMs: row.claimed_at_ms,
    consumedAtMs: row.consumed_at_ms,
  };
}

function mapLease(row: LeaseRow): RunnerLease {
  return {
    sessionId: row.session_id,
    generation: row.generation,
    leaseToken: row.lease_token,
    ownerId: row.owner_id,
    acquiredAtMs: row.acquired_at_ms,
    renewedAtMs: row.renewed_at_ms,
    expiresAtMs: row.expires_at_ms,
  };
}

function mapRun(row: RunRow): SessionRunRecord {
  return {
    sessionId: row.session_id,
    generation: row.generation,
    runnerId: row.runner_id,
    executionState: row.execution_state,
    workOutcome: row.work_outcome,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    error: parseJson(row.error_json),
  };
}

function mapDetachedInputResult(row: DetachedInputResultRow): DetachedInputResultRecord {
  return {
    inputId: row.input_id,
    sessionId: row.session_id,
    generation: row.generation,
    executionState: row.execution_state,
    workOutcome: row.work_outcome,
    outputMessageId: row.output_message_id,
    settledAtMs: row.settled_at_ms,
  };
}

function mapSessionMutation(row: SessionMutationRow): SessionMutationRecord {
  const value = parseJson(row.affected_paths_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    generation: row.generation,
    toolRunId: row.tool_run_id,
    toolUseId: row.tool_use_id,
    affectedPaths: Array.isArray(value)
      ? value.filter((path): path is string => typeof path === "string")
      : [],
    scopeComplete: row.scope_complete === 1,
    resolvedGeneration: row.resolved_generation,
    observedAtMs: row.observed_at_ms,
    resolvedAtMs: row.resolved_at_ms,
  };
}

function mapPart(row: PartRow): MessagePartRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    ordinal: row.ordinal,
    type: row.type,
    data: parseJson(row.data_json)!,
    createdAtMs: row.created_at_ms,
  };
}

function mapTool(row: ToolRow): ToolRunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    generation: row.generation,
    callKey: row.call_key,
    attempt: row.attempt,
    toolName: row.tool_name,
    executionState: row.execution_state,
    verificationState: row.verification_state,
    arguments: parseJson(row.arguments_json)!,
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),
    checkpointId: row.checkpoint_id,
    effectKind: row.effect_kind,
    mutationTransactionId: row.mutation_transaction_id,
    revision: row.revision,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    startedAtMs: row.started_at_ms,
    settledAtMs: row.settled_at_ms,
  };
}

function mapEpoch(row: EpochRow): ContextEpochRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    epoch: row.epoch,
    previousEpochId: row.previous_epoch_id,
    generation: row.generation,
    reason: row.reason,
    summary: parseJson(row.summary_json)!,
    projection: parseJson(row.projection_json)!,
    sourceVersions: parseJson(row.source_versions_json)!,
    baseEventSequence: row.base_event_sequence,
    tokenCount: row.token_count,
    createdAtMs: row.created_at_ms,
  };
}

function mapPlan(row: PlanRow): PlanRevisionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    revision: row.revision,
    body: row.body,
    planHash: row.plan_hash,
    status: row.status,
    author: row.author,
    metadata: parseJson(row.metadata_json),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapApproval(row: ApprovalRow): PlanApprovalRecord {
  return {
    id: row.id,
    planRevisionId: row.plan_revision_id,
    approver: row.approver,
    decision: row.decision,
    planHash: row.plan_hash,
    metadata: parseJson(row.metadata_json),
    createdAtMs: row.created_at_ms,
  };
}

function mapEvent(row: EventRow): SessionEventRecord {
  return {
    sequence: row.sequence,
    id: row.id,
    sessionId: row.session_id,
    generation: row.generation,
    type: row.type,
    payload: parseJson(row.payload_json)!,
    createdAtMs: row.created_at_ms,
  };
}

function mapBackgroundJob(row: BackgroundJobRow): BackgroundJobRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    invocationKey: row.invocation_key,
    kind: row.kind,
    status: row.status,
    description: row.description,
    request: parseJson(row.request_json)!,
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),
    childSessionId: row.child_session_id,
    pid: row.pid,
    processToken: row.process_token,
    statePath: row.state_path,
    outputPath: row.output_path,
    outputBytes: row.output_bytes,
    exitCode: row.exit_code,
    ownerId: row.owner_id,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    cancelRequested: row.cancel_requested === 1,
    completionInputId: row.completion_input_id,
    revision: row.revision,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    heartbeatAtMs: row.heartbeat_at_ms,
    finishedAtMs: row.finished_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function planHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function isSettledToolState(state: ToolExecutionState): boolean {
  return state === "succeeded" || state === "failed" || state === "effect_unknown";
}

function isTerminalBackgroundJobStatus(status: BackgroundJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "orphaned";
}

function jsonOrNull(value: JsonValue | null | undefined): string | null {
  return value === undefined || value === null ? null : canonicalJson(value);
}

function nullableText(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : value;
}

function assertIdentifier(value: string, label: string): void {
  if (!value.trim()) throw invalidArgument(`${label} must not be empty`);
  if (value.length > 1_024) throw invalidArgument(`${label} must be at most 1024 characters`);
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalidArgument(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function invalidArgument(message: string): SessionKernelError {
  return new SessionKernelError("INVALID_ARGUMENT", message);
}

export { LATEST_SESSION_KERNEL_SCHEMA_VERSION };
