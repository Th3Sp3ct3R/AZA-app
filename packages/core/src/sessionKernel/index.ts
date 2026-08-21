export {
  SessionKernelStore,
  LATEST_SESSION_KERNEL_SCHEMA_VERSION,
  type OpenSessionKernelOptions,
  type SessionKernelStoreOptions,
} from "./store.js";

export {
  RunCoordinator,
  RunLeaseCoordinator,
  type AcquireCoordinatedLeaseOptions,
  type CoordinatedRunLease,
  type CoordinatedRunContext,
  type CoordinatedRunWorker,
  type CoordinatorDrainResult,
  type RunLeaseCoordinatorOptions,
  type RunCoordinatorOptions,
  type RunWorkerResult,
} from "./coordinator.js";

export {
  SessionKernelError,
  SessionNotFoundError,
  IdempotencyConflictError,
  LeaseHeldError,
  StaleGenerationError,
  InvalidStateTransitionError,
  RevisionConflictError,
  PlanConflictError,
  type SessionKernelErrorCode,
} from "./errors.js";

export {
  loadBetterSqlite3,
  type BetterSqlite3Constructor,
  type BetterSqlite3DatabaseOptions,
  type SqliteDatabase,
  type SqliteRunResult,
  type SqliteStatement,
} from "./sqlite.js";

export {
  LATEST_SESSION_KERNEL_SCHEMA_VERSION as SCHEMA_VERSION,
  SESSION_KERNEL_APPLICATION_ID,
  configureSessionKernelDatabase,
  migrateSessionKernelDatabase,
} from "./migrations.js";

export type * from "./types.js";

export { openWorkspaceSessionKernel, workspaceSessionKernelPath } from "./workspace.js";
