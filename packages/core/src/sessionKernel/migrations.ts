import type { SqliteDatabase } from "./sqlite.js";

export const SESSION_KERNEL_APPLICATION_ID = 0x41524553; // "ARES"
export const LATEST_SESSION_KERNEL_SCHEMA_VERSION = 8;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "canonical_session_kernel",
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        parent_session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
        root_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
        workspace_key TEXT,
        title TEXT,
        metadata_json TEXT,
        current_generation INTEGER NOT NULL DEFAULT 0 CHECK (current_generation >= 0),
        execution_state TEXT NOT NULL DEFAULT 'idle'
          CHECK (execution_state IN ('idle','admitted','running','waiting','completed','interrupted','failed')),
        work_outcome TEXT NOT NULL DEFAULT 'not_applicable'
          CHECK (work_outcome IN ('not_applicable','pending','verified','unverified','blocked')),
        current_context_epoch INTEGER NOT NULL DEFAULT 0 CHECK (current_context_epoch >= 0),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX sessions_parent_idx ON sessions(parent_session_id, created_at_ms);
      CREATE INDEX sessions_workspace_idx ON sessions(workspace_key, updated_at_ms);

      CREATE TABLE session_links (
        parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        child_session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        external_key TEXT,
        metadata_json TEXT,
        created_at_ms INTEGER NOT NULL,
        CHECK (parent_session_id <> child_session_id)
      );

      CREATE UNIQUE INDEX session_links_external_key_uq
        ON session_links(parent_session_id, relation, external_key)
        WHERE external_key IS NOT NULL;

      CREATE TABLE admitted_inputs (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        delivery TEXT NOT NULL CHECK (delivery IN ('queue','steer')),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted','claimed','consumed','cancelled')),
        claimed_generation INTEGER,
        admitted_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER,
        consumed_at_ms INTEGER,
        UNIQUE (session_id, idempotency_key),
        CHECK ((state = 'claimed') = (claimed_generation IS NOT NULL))
      );

      CREATE INDEX admitted_inputs_pending_idx
        ON admitted_inputs(session_id, state, delivery, admitted_at_ms, id);

      CREATE TABLE session_runs (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation > 0),
        runner_id TEXT NOT NULL,
        execution_state TEXT NOT NULL
          CHECK (execution_state IN ('idle','admitted','running','waiting','completed','interrupted','failed')),
        work_outcome TEXT NOT NULL
          CHECK (work_outcome IN ('not_applicable','pending','verified','unverified','blocked')),
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        error_json TEXT,
        PRIMARY KEY (session_id, generation)
      );

      CREATE TABLE runner_leases (
        session_id TEXT PRIMARY KEY NOT NULL,
        generation INTEGER NOT NULL,
        owner_id TEXT NOT NULL,
        lease_token TEXT NOT NULL UNIQUE,
        acquired_at_ms INTEGER NOT NULL,
        renewed_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        FOREIGN KEY (session_id, generation)
          REFERENCES session_runs(session_id, generation) ON DELETE CASCADE
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        input_id TEXT REFERENCES admitted_inputs(id) ON DELETE SET NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
        agent TEXT,
        model TEXT,
        metadata_json TEXT,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (session_id, ordinal)
      );

      CREATE INDEX messages_session_idx ON messages(session_id, ordinal);

      CREATE TABLE message_parts (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (message_id, ordinal)
      );

      CREATE TABLE tool_runs (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        call_key TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
        tool_name TEXT NOT NULL,
        execution_state TEXT NOT NULL
          CHECK (execution_state IN ('proposed','validated','authorized','checkpointed','executing','succeeded','failed','effect_unknown')),
        verification_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (verification_state IN ('pending','not_required','verified','unverified','blocked')),
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        checkpoint_id TEXT,
        effect_kind TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        settled_at_ms INTEGER,
        UNIQUE (session_id, call_key, attempt)
      );

      CREATE INDEX tool_runs_session_idx ON tool_runs(session_id, generation, created_at_ms);
      CREATE INDEX tool_runs_recovery_idx ON tool_runs(session_id, execution_state, generation);

      CREATE TABLE context_epochs (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        epoch INTEGER NOT NULL CHECK (epoch > 0),
        previous_epoch_id TEXT REFERENCES context_epochs(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        reason TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        source_versions_json TEXT NOT NULL,
        base_event_sequence INTEGER,
        token_count INTEGER CHECK (token_count IS NULL OR token_count >= 0),
        created_at_ms INTEGER NOT NULL,
        UNIQUE (session_id, epoch)
      );

      CREATE INDEX context_epochs_session_idx ON context_epochs(session_id, epoch DESC);

      CREATE TABLE plan_revisions (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        body TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('draft','awaiting_approval','approved','rejected','superseded','executing','completed','failed')),
        author TEXT,
        metadata_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (session_id, revision)
      );

      CREATE INDEX plan_revisions_session_idx ON plan_revisions(session_id, revision DESC);
      CREATE UNIQUE INDEX plan_revisions_one_executing_uq
        ON plan_revisions(session_id) WHERE status = 'executing';

      CREATE TABLE plan_approvals (
        id TEXT PRIMARY KEY NOT NULL,
        plan_revision_id TEXT NOT NULL UNIQUE REFERENCES plan_revisions(id) ON DELETE CASCADE,
        approver TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
        plan_hash TEXT NOT NULL,
        metadata_json TEXT,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        generation INTEGER,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX session_events_session_idx ON session_events(session_id, sequence);
      CREATE INDEX session_events_type_idx ON session_events(session_id, type, sequence);
    `,
  },
  {
    version: 2,
    name: "durable_plan_build_workflow",
    sql: `
      ALTER TABLE sessions ADD COLUMN workflow_mode TEXT NOT NULL DEFAULT 'build'
        CHECK (workflow_mode IN ('plan','build'));
      CREATE INDEX sessions_workflow_idx ON sessions(workflow_mode, updated_at_ms);
    `,
  },
  {
    version: 3,
    name: "deterministic_input_admission_order",
    sql: `
      ALTER TABLE admitted_inputs ADD COLUMN admission_sequence INTEGER;
      UPDATE admitted_inputs SET admission_sequence = rowid;
      CREATE UNIQUE INDEX admitted_inputs_admission_sequence_uq
        ON admitted_inputs(session_id, admission_sequence);
      DROP INDEX admitted_inputs_pending_idx;
      CREATE INDEX admitted_inputs_pending_idx
        ON admitted_inputs(session_id, state, delivery, admission_sequence);
    `,
  },
  {
    version: 4,
    name: "tool_mutation_reconciliation_identity",
    sql: `
      ALTER TABLE tool_runs ADD COLUMN mutation_transaction_id TEXT;
      CREATE INDEX tool_runs_mutation_transaction_idx
        ON tool_runs(session_id, mutation_transaction_id)
        WHERE mutation_transaction_id IS NOT NULL;
    `,
  },
  {
    version: 5,
    name: "durable_session_deletion_tombstones",
    sql: `
      CREATE TABLE session_tombstones (
        session_id TEXT PRIMARY KEY NOT NULL,
        parent_session_id TEXT,
        root_session_id TEXT NOT NULL,
        workspace_key TEXT,
        deletion_source TEXT NOT NULL
          CHECK (deletion_source IN ('canonical','legacy')),
        deleted_at_ms INTEGER NOT NULL
      );

      CREATE INDEX session_tombstones_workspace_idx
        ON session_tombstones(workspace_key, deleted_at_ms DESC);

      -- v4 used archived session rows as an in-progress deletion barrier.
      -- Preserve those identities permanently when upgrading, even if a
      -- later cleanup finalizes and removes the canonical session rows.
      INSERT INTO session_tombstones(
        session_id, parent_session_id, root_session_id, workspace_key,
        deletion_source, deleted_at_ms
      )
      SELECT id, parent_session_id, root_session_id, workspace_key,
             'canonical', updated_at_ms
      FROM sessions
      WHERE archived = 1;

      -- The store checks this explicitly to return a useful domain error. The
      -- trigger is the last-line invariant for migrations/importers that write
      -- sessions directly: a permanently deleted identity is never reusable.
      CREATE TRIGGER sessions_reject_tombstoned_insert
      BEFORE INSERT ON sessions
      WHEN EXISTS (
        SELECT 1 FROM session_tombstones WHERE session_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'session id was permanently deleted');
      END;

      CREATE TRIGGER sessions_reject_tombstoned_id_update
      BEFORE UPDATE OF id ON sessions
      WHEN EXISTS (
        SELECT 1 FROM session_tombstones WHERE session_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'session id was permanently deleted');
      END;
    `,
  },
  {
    version: 6,
    name: "durable_background_jobs",
    sql: `
      CREATE TABLE background_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        invocation_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('shell','task')),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','completed','failed','cancelled','orphaned')),
        description TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        child_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        pid INTEGER,
        process_token TEXT,
        state_path TEXT,
        output_path TEXT,
        output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
        exit_code INTEGER,
        owner_id TEXT,
        lease_expires_at_ms INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
        completion_input_id TEXT REFERENCES admitted_inputs(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        heartbeat_at_ms INTEGER,
        finished_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (session_id, kind, invocation_key),
        CHECK ((owner_id IS NULL) = (lease_expires_at_ms IS NULL)),
        CHECK (kind = 'task' OR child_session_id IS NULL)
      );

      CREATE INDEX background_jobs_session_idx
        ON background_jobs(session_id, status, created_at_ms);
      CREATE INDEX background_jobs_recovery_idx
        ON background_jobs(kind, status, lease_expires_at_ms, updated_at_ms);

      CREATE TABLE background_job_cursors (
        job_id TEXT NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
        consumer_key TEXT NOT NULL,
        cursor_bytes INTEGER NOT NULL DEFAULT 0 CHECK (cursor_bytes >= 0),
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (job_id, consumer_key)
      );
    `,
  },
  {
    version: 7,
    name: "detached_input_results",
    sql: `
      CREATE TABLE detached_input_results (
        input_id TEXT PRIMARY KEY NOT NULL REFERENCES admitted_inputs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation > 0),
        execution_state TEXT NOT NULL DEFAULT 'completed'
          CHECK (execution_state = 'completed'),
        work_outcome TEXT NOT NULL
          CHECK (work_outcome IN ('not_applicable','pending','verified','unverified','blocked')),
        output_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        settled_at_ms INTEGER NOT NULL
      );

      CREATE INDEX detached_input_results_session_idx
        ON detached_input_results(session_id, settled_at_ms, input_id);
    `,
  },
  {
    version: 8,
    name: "canonical_verification_mutation_scope",
    sql: `
      CREATE TABLE session_mutations (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation > 0),
        tool_run_id TEXT NOT NULL REFERENCES tool_runs(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL,
        affected_paths_json TEXT NOT NULL,
        scope_complete INTEGER NOT NULL DEFAULT 1 CHECK (scope_complete IN (0,1)),
        resolved_generation INTEGER,
        observed_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        UNIQUE (session_id, generation, tool_use_id),
        CHECK ((resolved_generation IS NULL) = (resolved_at_ms IS NULL))
      );

      CREATE INDEX session_mutations_unresolved_idx
        ON session_mutations(session_id, resolved_generation, generation, observed_at_ms);
      CREATE INDEX session_mutations_tool_run_idx
        ON session_mutations(tool_run_id);
    `,
  },
];

export function configureSessionKernelDatabase(db: SqliteDatabase): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  // Tool admission and settlement are side-effect barriers. FULL ensures the
  // corresponding WAL commit reaches stable storage before a tool is entered
  // or its result is exposed; NORMAL only guarantees database consistency, not
  // survival of the newest committed frame after power loss.
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.pragma("wal_autocheckpoint = 1000");
  db.pragma(`application_id = ${SESSION_KERNEL_APPLICATION_ID}`);
}

export function migrateSessionKernelDatabase(db: SqliteDatabase, nowMs: number): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all<{ version: number }>().map((row) => row.version),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at_ms) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        nowMs,
      );
      db.pragma(`user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure; rollback may itself fail after SQLite
        // automatically aborts a transaction.
      }
      throw error;
    }
  }

  const version = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get<{ version: number }>()?.version ?? 0;
  if (version > LATEST_SESSION_KERNEL_SCHEMA_VERSION) {
    throw new Error(
      `Session kernel schema ${version} is newer than supported version ${LATEST_SESSION_KERNEL_SCHEMA_VERSION}`,
    );
  }
  return version;
}
