// Durable workspace mutation transactions.
//
// Every caller supplies the complete intended file-set up front. The service
// acquires normalized in-process and cross-process path locks, validates every precondition,
// stages and fsyncs replacement bytes, and only then changes user files. Since
// ordinary filesystems cannot atomically commit several paths together, each
// transition is journaled and backed up so a failed or interrupted transaction
// can be reconciled or rolled back without guessing what reached disk.

import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

export type WorkspaceMutationOperation =
  | {
      kind: "add";
      path: string;
      content: string | Uint8Array;
      mode?: number;
    }
  | {
      kind: "update";
      path: string;
      content: string | Uint8Array;
      /** SHA-256 of the exact bytes the caller used as its base. */
      expectedHash: string;
      /** Optional mode CAS used by isolated branches and chmod-aware editors. */
      expectedMode?: number;
      /** Final mode. Omit to preserve the current mode. */
      mode?: number;
    }
  | {
      kind: "delete";
      path: string;
      /** SHA-256 of the exact bytes the caller intends to delete. */
      expectedHash: string;
      expectedMode?: number;
    }
  | {
      kind: "rename";
      fromPath: string;
      toPath: string;
      /** SHA-256 of the exact source bytes the caller used as its base. */
      expectedHash: string;
      expectedMode?: number;
      /** Final bytes at the destination. Omit for a byte-for-byte move. */
      content?: string | Uint8Array;
    };

export interface WorkspaceMutationOptions {
  label?: string;
  /** Optional idempotency/debugging identifier. Must be filesystem-safe. */
  transactionId?: string;
}

export type WorkspaceMutationReceiptOperation =
  | {
      kind: "add";
      path: string;
      afterHash: string;
      bytes: number;
      mode: number;
    }
  | {
      kind: "update";
      path: string;
      beforeHash: string;
      afterHash: string;
      bytes: number;
      backupPath: string;
      /** Mode of the before-state kept in backupPath. */
      mode: number;
      /** Mode installed with the after-state. */
      afterMode?: number;
    }
  | {
      kind: "delete";
      path: string;
      beforeHash: string;
      backupPath: string;
      mode: number;
    }
  | {
      kind: "rename";
      fromPath: string;
      toPath: string;
      beforeHash: string;
      afterHash: string;
      bytes: number;
      backupPath: string;
      mode: number;
    };

/** The original filesystem node parked by an update/delete/rename. Ares keeps
 * this node reachable after commit because an external editor may still hold
 * an open descriptor to it and write after the source path has been renamed.
 * The immutable `backupPath` on the receipt remains the rollback base; this
 * artifact is specifically the live, potentially editor-mutated generation. */
export interface WorkspaceMutationRetainedSourceGeneration {
  operation: number;
  sourcePath: string;
  artifactPath: string;
  expectedHash: string;
  expectedMode: number;
}

export interface WorkspaceMutationReceipt {
  version: 1;
  id: string;
  workspace: string;
  label: string;
  status: "committed";
  createdAt: string;
  committedAt: string;
  journalPath: string;
  receiptPath: string;
  touchedFiles: string[];
  operations: WorkspaceMutationReceiptOperation[];
  /** At most one live source generation per update/delete/rename operation. */
  retainedSourceGenerations: WorkspaceMutationRetainedSourceGeneration[];
}

export type ReconciledPathState = "before" | "after" | "missing" | "diverged";

export interface WorkspaceMutationReconciliation {
  transactionId: string;
  transactionStatus: "committed" | "incomplete" | "rolled_back";
  disposition: "fully_applied" | "not_applied" | "mixed" | "diverged";
  canRollback: boolean;
  /** True when a retained source generation has received external bytes or is
   * no longer available. The committed workspace state is reported separately
   * by `disposition`; callers can review these bytes without undoing it. */
  hasRetainedSourceChanges: boolean;
  retainedSourceGenerations: Array<WorkspaceMutationRetainedSourceGeneration & {
    actualHash: string | null;
    actualMode: number | null;
    state: "expected" | "modified" | "missing";
  }>;
  paths: Array<{
    path: string;
    beforeHash: string | null;
    afterHash: string | null;
    actualHash: string | null;
    beforeMode: number | null;
    afterMode: number | null;
    actualMode: number | null;
    state: ReconciledPathState;
  }>;
}

export type WorkspaceMutationErrorCode =
  | "INVALID_REQUEST"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_CONFLICT"
  | "BASE_MISMATCH"
  | "TARGET_EXISTS"
  | "TARGET_MISSING"
  | "UNSUPPORTED_FILE_TYPE"
  | "COMMIT_FAILED"
  | "ROLLBACK_FAILED"
  | "TRANSACTION_NOT_FOUND"
  | "TRANSACTION_ALREADY_EXISTS";

export class WorkspaceMutationError extends Error {
  readonly code: WorkspaceMutationErrorCode;
  readonly transactionId?: string;
  readonly actionable: string;

  constructor(
    code: WorkspaceMutationErrorCode,
    message: string,
    actionable: string,
    transactionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceMutationError";
    this.code = code;
    this.actionable = actionable;
    this.transactionId = transactionId;
  }
}

interface ExistingFile {
  bytes: Buffer;
  hash: string;
  mode: number;
  /** Filesystem generation observed with the base bytes. Hash catches in-place
   * edits; identity catches an atomic same-content replacement. */
  identity: FileIdentity;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

type SourceState = "untouched" | "expected_parked" | "foreign_preserved" | "foreign_quarantined";

type PreparedOperation =
  | {
      index: number;
      kind: "add";
      path: string;
      after: Buffer;
      afterHash: string;
      mode: number;
      stagePath: string;
      installedIdentity?: FileIdentity;
    }
  | {
      index: number;
      kind: "update";
      path: string;
      before: ExistingFile;
      after: Buffer;
      afterHash: string;
      backupPath: string;
      stagePath: string;
      tombstonePath: string;
      retainedSourcePath: string;
      parkedPath?: string;
      mode: number;
      sourceState: SourceState;
      installedIdentity?: FileIdentity;
    }
  | {
      index: number;
      kind: "delete";
      path: string;
      before: ExistingFile;
      backupPath: string;
      tombstonePath: string;
      retainedSourcePath: string;
      parkedPath?: string;
      sourceState: SourceState;
    }
  | {
      index: number;
      kind: "rename";
      fromPath: string;
      toPath: string;
      before: ExistingFile;
      after: Buffer;
      afterHash: string;
      backupPath: string;
      stagePath: string;
      tombstonePath: string;
      retainedSourcePath: string;
      parkedPath?: string;
      sourceState: SourceState;
      installedIdentity?: FileIdentity;
    };

type ParkableOperation = Extract<PreparedOperation, { kind: "update" | "delete" | "rename" }>;

class SourceGenerationConflict extends Error {
  constructor(
    readonly sourcePath: string,
    readonly expectedHash: string,
    readonly actualHash: string | null,
    readonly disposition: "source_preserved" | "foreign_generation_quarantined",
    readonly quarantinePath?: string,
    options?: ErrorOptions,
  ) {
    super(
      disposition === "source_preserved"
        ? `External edit won the source race at ${sourcePath}; its generation was preserved.`
        : `External edit won the source race at ${sourcePath}; its moved generation is preserved at ${quarantinePath}.`,
      options,
    );
    this.name = "SourceGenerationConflict";
  }
}

interface JournalBegin {
  event: "begin";
  version: 1;
  id: string;
  workspace: string;
  label: string;
  createdAt: string;
  operations: WorkspaceMutationReceiptOperation[];
}

interface LoadedTransaction {
  begin: JournalBegin;
  receipt: WorkspaceMutationReceipt | null;
  rolledBack: boolean;
  retainedSourceGenerations: WorkspaceMutationRetainedSourceGeneration[];
}

/** Every Ares session in this process serializes here; a filesystem lease below
 * extends the same canonical-path ordering across cooperating processes. */
const pathLockTails = new Map<string, Promise<void>>();
const CROSS_PROCESS_LOCK_WAIT_MS = 10_000;
const MALFORMED_LOCK_STALE_MS = 60_000;

export function workspaceContentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(toBuffer(content)).digest("hex");
}

export class WorkspaceMutationService {
  readonly workspace: string;
  readonly journalRoot: string;
  readonly lockRoot: string;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
    this.journalRoot = path.join(this.workspace, ".ares", "mutations");
    this.lockRoot = path.join(this.workspace, ".ares", "mutation-locks");
  }

  async apply(
    operations: readonly WorkspaceMutationOperation[],
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationReceipt> {
    if (operations.length === 0) {
      throw mutationError(
        "INVALID_REQUEST",
        "Workspace mutation contains no operations.",
        "Provide at least one add, update, delete, or rename operation.",
      );
    }

    const id = validateTransactionId(options.transactionId ?? randomUUID());
    const label = options.label?.trim() || "workspace-mutation";
    const txDir = path.join(this.journalRoot, id);
    const journalPath = path.join(txDir, "journal.jsonl");
    const receiptPath = path.join(txDir, "receipt.json");
    const resolved = operations.map((operation) => this.resolveOperation(operation));
    const lockKeys = await this.lockKeysFor(resolved);
    const release = await acquirePathLocks(lockKeys);
    let releaseCrossProcess: (() => Promise<void>) | undefined;

    try {
      await this.assertWorkspaceDirectory();
      releaseCrossProcess = await acquireCrossProcessPathLocks(this.lockRoot, lockKeys);
      if (await pathExists(txDir)) {
        throw mutationError(
          "TRANSACTION_ALREADY_EXISTS",
          `Mutation transaction '${id}' already exists.`,
          "Use a fresh transaction id, or reconcile the existing transaction before retrying.",
          id,
        );
      }

      // All filesystem and CAS checks happen while every affected path is
      // locked and before a user file is changed.
      const prepared = await this.prepare(resolved, id, txDir);
      await fs.mkdir(txDir, { recursive: true });
      const receiptOperations = prepared.map(toReceiptOperation);
      const begin: JournalBegin = {
        event: "begin",
        version: 1,
        id,
        workspace: this.workspace,
        label,
        createdAt: new Date().toISOString(),
        operations: receiptOperations,
      };
      await appendJournal(journalPath, begin);

      // Backups and same-directory staged files are fully durable before the
      // first target path is parked or replaced.
      try {
        await this.materializeAssets(prepared, journalPath, id);
      } catch (error) {
        await appendJournal(journalPath, {
          event: "prepare_failed",
          at: new Date().toISOString(),
          error: errorMessage(error),
        }).catch(() => undefined);
        await cleanupPreparedAssets(prepared);
        throw error;
      }
      await appendJournal(journalPath, { event: "prepared", at: new Date().toISOString() });

      try {
        for (const operation of prepared) {
          await this.commitOperation(operation, journalPath);
        }
        await this.verifyAfterStates(prepared);
        const committedAt = new Date().toISOString();
        await appendJournal(journalPath, { event: "commit_complete", at: committedAt });

        const receipt: WorkspaceMutationReceipt = {
          version: 1,
          id,
          workspace: this.workspace,
          label,
          status: "committed",
          createdAt: begin.createdAt,
          committedAt,
          journalPath,
          receiptPath,
          touchedFiles: touchedFiles(receiptOperations),
          operations: receiptOperations,
          retainedSourceGenerations: retainedSourceDescriptors(prepared),
        };
        await writeNewDurableJson(receiptPath, receipt);
        await appendJournal(journalPath, { event: "receipt_written", at: new Date().toISOString(), receiptPath });
        await cleanupPreparedAssets(prepared);
        await appendJournal(journalPath, { event: "cleanup_complete", at: new Date().toISOString() });
        return receipt;
      } catch (error) {
        await appendJournal(journalPath, {
          event: "commit_failed",
          at: new Date().toISOString(),
          error: errorMessage(error),
        }).catch(() => undefined);
        const rollbackErrors = await this.restorePreparedBeforeStates(prepared, journalPath);
        if (rollbackErrors.length > 0) {
          await appendJournal(journalPath, {
            event: "reconcile_required",
            at: new Date().toISOString(),
            errors: rollbackErrors,
          }).catch(() => undefined);
          throw mutationError(
            "ROLLBACK_FAILED",
            `Mutation '${id}' failed and automatic rollback could not restore every path: ${rollbackErrors.join("; ")}`,
            `Run reconcile('${id}') and restore from the backups recorded in ${journalPath}.`,
            id,
            error,
          );
        }
        await appendJournal(journalPath, { event: "automatic_rollback_complete", at: new Date().toISOString() });
        if (error instanceof SourceGenerationConflict) {
          throw mutationError(
            "BASE_MISMATCH",
            `Mutation '${id}' stopped because ${error.sourcePath} changed after validation; ` +
              (error.disposition === "source_preserved"
                ? "the external generation remains at the user path."
                : `the raced generation is recoverable at ${error.quarantinePath}.`),
            "Re-read the file and regenerate the mutation against its current bytes. No Ares replacement was committed.",
            id,
            error,
          );
        }
        throw mutationError(
          "COMMIT_FAILED",
          `Mutation '${id}' failed; all affected paths were rolled back. ${errorMessage(error)}`,
          "Inspect the reported filesystem error, then recompute the patch against current files and retry.",
          id,
          error,
        );
      }
    } finally {
      try {
        await releaseCrossProcess?.();
      } finally {
        release();
      }
    }
  }

  /** Apply the exact inverse of a committed transaction. The inverse is itself
   * a normal durable transaction with fresh CAS checks and its own receipt. */
  async rollback(transactionId: string): Promise<WorkspaceMutationReceipt> {
    const id = validateTransactionId(transactionId);
    const loaded = await this.loadTransaction(id);
    if (!loaded.receipt) {
      throw mutationError(
        "INVALID_REQUEST",
        `Mutation '${id}' has no committed receipt.`,
        `Call reconcile('${id}') to inspect its on-disk state before choosing a recovery action.`,
        id,
      );
    }
    if (loaded.rolledBack) {
      throw mutationError(
        "INVALID_REQUEST",
        `Mutation '${id}' was already rolled back.`,
        "No action is required.",
        id,
      );
    }

    const reverse: WorkspaceMutationOperation[] = [];
    for (const operation of [...loaded.receipt.operations].reverse()) {
      switch (operation.kind) {
        case "add":
          reverse.push({ kind: "delete", path: operation.path, expectedHash: operation.afterHash });
          break;
        case "update":
          reverse.push({
            kind: "update",
            path: operation.path,
            expectedHash: operation.afterHash,
            expectedMode: operation.afterMode ?? operation.mode,
            content: await fs.readFile(operation.backupPath),
            mode: operation.mode,
          });
          break;
        case "delete":
          reverse.push({
            kind: "add",
            path: operation.path,
            content: await fs.readFile(operation.backupPath),
            mode: operation.mode,
          });
          break;
        case "rename":
          reverse.push({
            kind: "rename",
            fromPath: operation.toPath,
            toPath: operation.fromPath,
            expectedHash: operation.afterHash,
            content: await fs.readFile(operation.backupPath),
          });
          break;
      }
    }

    const rollbackReceipt = await this.apply(reverse, { label: `rollback:${id}` });
    await appendJournal(loaded.beginPath, {
      event: "manual_rollback_complete",
      at: new Date().toISOString(),
      rollbackTransactionId: rollbackReceipt.id,
    });
    return rollbackReceipt;
  }

  /** Compare every affected path with the durable before/after hashes. This is
   * intentionally read-only: callers can decide whether to roll back, retry,
   * or preserve an external edit instead of an eager recovery overwriting it. */
  async reconcile(transactionId: string): Promise<WorkspaceMutationReconciliation> {
    const id = validateTransactionId(transactionId);
    const loaded = await this.loadTransaction(id);
    const states = stateMap(loaded.begin.operations);
    const paths: WorkspaceMutationReconciliation["paths"] = [];
    const retainedSourceGenerations: WorkspaceMutationReconciliation["retainedSourceGenerations"] = [];
    let beforeCount = 0;
    let afterCount = 0;
    let divergedCount = 0;

    for (const [filePath, expected] of states) {
      const actual = await readRegularFile(filePath, false);
      const actualHash = actual?.hash ?? null;
      const actualMode = actual?.mode ?? null;
      let state: ReconciledPathState;
      if (actualHash === expected.afterHash && actualMode === expected.afterMode) {
        state = "after";
        afterCount++;
      } else if (actualHash === expected.beforeHash && actualMode === expected.beforeMode) {
        state = "before";
        beforeCount++;
      } else if (actualHash === null) {
        state = "missing";
        divergedCount++;
      } else {
        state = "diverged";
        divergedCount++;
      }
      paths.push({
        path: filePath,
        beforeHash: expected.beforeHash,
        afterHash: expected.afterHash,
        actualHash,
        beforeMode: expected.beforeMode,
        afterMode: expected.afterMode,
        actualMode,
        state,
      });
    }

    const retainedDescriptors = loaded.receipt?.retainedSourceGenerations ?? loaded.retainedSourceGenerations;
    for (const descriptor of retainedDescriptors) {
      const actual = await readRegularFile(descriptor.artifactPath, false);
      retainedSourceGenerations.push({
        ...descriptor,
        actualHash: actual?.hash ?? null,
        actualMode: actual?.mode ?? null,
        state: !actual
          ? "missing"
          : actual.hash === descriptor.expectedHash && actual.mode === descriptor.expectedMode
            ? "expected"
            : "modified",
      });
    }

    const fullyApplied = afterCount === paths.length;
    const notApplied = beforeCount === paths.length;
    return {
      transactionId: id,
      transactionStatus: loaded.rolledBack ? "rolled_back" : loaded.receipt ? "committed" : "incomplete",
      disposition: fullyApplied
        ? "fully_applied"
        : notApplied
          ? "not_applied"
          : divergedCount > 0
            ? "diverged"
            : "mixed",
      canRollback: fullyApplied && loaded.receipt !== null && !loaded.rolledBack,
      hasRetainedSourceChanges: retainedSourceGenerations.some((entry) => entry.state !== "expected"),
      retainedSourceGenerations,
      paths,
    };
  }

  private async assertWorkspaceDirectory(): Promise<void> {
    const stat = await fs.stat(this.workspace).catch(() => null);
    if (!stat?.isDirectory()) {
      throw mutationError(
        "INVALID_REQUEST",
        `Workspace does not exist or is not a directory: ${this.workspace}`,
        "Open an existing workspace directory before applying file changes.",
      );
    }
  }

  private resolveOperation(operation: WorkspaceMutationOperation): WorkspaceMutationOperation {
    switch (operation.kind) {
      case "add":
        return { ...operation, path: this.resolvePath(operation.path, "add path") };
      case "update":
      case "delete":
        validateHash(operation.expectedHash, `${operation.kind} expectedHash`);
        return { ...operation, path: this.resolvePath(operation.path, `${operation.kind} path`) };
      case "rename":
        validateHash(operation.expectedHash, "rename expectedHash");
        return {
          ...operation,
          fromPath: this.resolvePath(operation.fromPath, "rename source"),
          toPath: this.resolvePath(operation.toPath, "rename destination"),
        };
    }
  }

  private resolvePath(input: string, label: string): string {
    if (!input || input.includes("\0")) {
      throw mutationError("INVALID_REQUEST", `${label} is empty or invalid.`, "Pass one concrete workspace-relative path.");
    }
    const absolute = path.resolve(this.workspace, input);
    const relative = path.relative(this.workspace, absolute);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw mutationError(
        "PATH_OUTSIDE_WORKSPACE",
        `${label} is outside the workspace: ${absolute}`,
        "Use a path inside the active workspace.",
      );
    }
    if (isInside(this.journalRoot, absolute)) {
      throw mutationError(
        "PATH_CONFLICT",
        `${label} targets Ares's mutation journal: ${absolute}`,
        "Choose a project file outside .ares/mutations.",
      );
    }
    if (normalizePathKey(absolute) === normalizePathKey(this.lockRoot) || isInside(this.lockRoot, absolute)) {
      throw mutationError(
        "PATH_CONFLICT",
        `${label} targets Ares's mutation lock directory: ${absolute}`,
        "Choose a project file outside .ares/mutation-locks.",
      );
    }
    return absolute;
  }

  private async lockKeysFor(operations: readonly WorkspaceMutationOperation[]): Promise<string[]> {
    await this.assertWorkspaceDirectory();
    const realWorkspace = await fs.realpath(this.workspace);
    const paths: string[] = [];
    for (const operation of operations) {
      if (operation.kind === "rename") paths.push(operation.fromPath, operation.toPath);
      else paths.push(operation.path);
    }
    const keys = await Promise.all(paths.map((filePath) => canonicalLockKey(realWorkspace, filePath)));
    return [...new Set(keys)].sort();
  }

  private async prepare(
    operations: readonly WorkspaceMutationOperation[],
    id: string,
    txDir: string,
  ): Promise<PreparedOperation[]> {
    const claimed = new Map<string, string>();
    const prepared: PreparedOperation[] = [];

    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      if (operation.kind === "rename") {
        claimPath(claimed, operation.fromPath, `rename source #${index + 1}`);
        claimPath(claimed, operation.toPath, `rename destination #${index + 1}`);
      } else {
        claimPath(claimed, operation.path, `${operation.kind} #${index + 1}`);
      }

      switch (operation.kind) {
        case "add": {
          await assertParentDoesNotEscape(this.workspace, operation.path);
          if (await pathExists(operation.path)) {
            throw mutationError(
              "TARGET_EXISTS",
              `Cannot add ${operation.path}: a filesystem entry already exists there.`,
              "Use an update hunk for an existing file, or choose a new path.",
              id,
            );
          }
          const after = toBuffer(operation.content);
          prepared.push({
            index,
            kind: "add",
            path: operation.path,
            after,
            afterHash: workspaceContentHash(after),
            mode: operation.mode ?? 0o666,
            stagePath: stagePathFor(operation.path, id, index),
          });
          break;
        }
        case "update": {
          const before = await requireExpectedFile(
            operation.path,
            operation.expectedHash,
            id,
            "update",
            operation.expectedMode,
          );
          const after = toBuffer(operation.content);
          const afterHash = workspaceContentHash(after);
          const mode = operation.mode ?? before.mode;
          if (afterHash === before.hash && mode === before.mode) {
            throw mutationError(
              "INVALID_REQUEST",
              `Update for ${operation.path} is a no-op; its bytes and mode are unchanged.`,
              "Remove the no-op hunk or change its replacement text or mode.",
              id,
            );
          }
          prepared.push({
            index,
            kind: "update",
            path: operation.path,
            before,
            after,
            afterHash,
            backupPath: path.join(txDir, `before-${pad(index)}.bin`),
            stagePath: stagePathFor(operation.path, id, index),
            tombstonePath: tombstonePathFor(operation.path, id, index),
            retainedSourcePath: path.join(txDir, `source-generation-${pad(index)}.bin`),
            mode,
            sourceState: "untouched",
          });
          break;
        }
        case "delete": {
          const before = await requireExpectedFile(
            operation.path,
            operation.expectedHash,
            id,
            "delete",
            operation.expectedMode,
          );
          prepared.push({
            index,
            kind: "delete",
            path: operation.path,
            before,
            backupPath: path.join(txDir, `before-${pad(index)}.bin`),
            tombstonePath: tombstonePathFor(operation.path, id, index),
            retainedSourcePath: path.join(txDir, `source-generation-${pad(index)}.bin`),
            sourceState: "untouched",
          });
          break;
        }
        case "rename": {
          if (normalizePathKey(operation.fromPath) === normalizePathKey(operation.toPath)) {
            throw mutationError(
              "PATH_CONFLICT",
              `Rename source and destination resolve to the same path: ${operation.fromPath}`,
              "Remove the move directive or choose a distinct destination.",
              id,
            );
          }
          const before = await requireExpectedFile(
            operation.fromPath,
            operation.expectedHash,
            id,
            "rename",
            operation.expectedMode,
          );
          await assertParentDoesNotEscape(this.workspace, operation.toPath);
          if (await pathExists(operation.toPath)) {
            throw mutationError(
              "TARGET_EXISTS",
              `Cannot rename to ${operation.toPath}: the destination already exists.`,
              "Delete or update the destination explicitly; ApplyPatch will not overwrite it implicitly.",
              id,
            );
          }
          const after = operation.content === undefined ? before.bytes : toBuffer(operation.content);
          prepared.push({
            index,
            kind: "rename",
            fromPath: operation.fromPath,
            toPath: operation.toPath,
            before,
            after,
            afterHash: workspaceContentHash(after),
            backupPath: path.join(txDir, `before-${pad(index)}.bin`),
            stagePath: stagePathFor(operation.toPath, id, index),
            tombstonePath: tombstonePathFor(operation.fromPath, id, index),
            retainedSourcePath: path.join(txDir, `source-generation-${pad(index)}.bin`),
            sourceState: "untouched",
          });
          break;
        }
      }
    }
    return prepared;
  }

  private async materializeAssets(
    operations: readonly PreparedOperation[],
    journalPath: string,
    transactionId: string,
  ): Promise<void> {
    for (const operation of operations) {
      if (operation.kind !== "add") {
        await writeNewDurableFile(operation.backupPath, operation.before.bytes, operation.before.mode);
      }
      if (operation.kind === "add" || operation.kind === "update" || operation.kind === "rename") {
        const target = operation.kind === "rename" ? operation.toPath : operation.path;
        await fs.mkdir(path.dirname(target), { recursive: true });
        const mode = operation.kind === "add" || operation.kind === "update" ? operation.mode : operation.before.mode;
        await writeNewDurableFile(operation.stagePath, operation.after, mode);
      }
      await appendJournal(journalPath, {
        event: "assets_ready",
        at: new Date().toISOString(),
        transactionId,
        operation: operation.index,
      });
    }
  }

  private async commitOperation(operation: PreparedOperation, journalPath: string): Promise<void> {
    await appendJournal(journalPath, {
      event: "operation_start",
      at: new Date().toISOString(),
      operation: operation.index,
      kind: operation.kind,
    });

    if (operation.kind === "add") {
      await installNewFile(operation.stagePath, operation.path, (identity) => {
        operation.installedIdentity = identity;
      });
      await verifyPathState(operation.path, operation.afterHash, operation.mode);
    } else if (operation.kind === "update") {
      await parkOperationSource(operation, journalPath);
      await appendJournal(journalPath, { event: "source_parked", at: new Date().toISOString(), operation: operation.index });
      await installNewFile(operation.stagePath, operation.path, (identity) => {
        operation.installedIdentity = identity;
      });
      await verifyPathState(operation.path, operation.afterHash, operation.mode);
    } else if (operation.kind === "delete") {
      await parkOperationSource(operation, journalPath);
      await appendJournal(journalPath, { event: "source_parked", at: new Date().toISOString(), operation: operation.index });
    } else {
      await parkOperationSource(operation, journalPath);
      await appendJournal(journalPath, { event: "source_parked", at: new Date().toISOString(), operation: operation.index });
      await installNewFile(operation.stagePath, operation.toPath, (identity) => {
        operation.installedIdentity = identity;
      });
      await verifyPathHash(operation.toPath, operation.afterHash);
    }

    await appendJournal(journalPath, { event: "operation_complete", at: new Date().toISOString(), operation: operation.index });
  }

  private async verifyAfterStates(operations: readonly PreparedOperation[]): Promise<void> {
    for (const operation of operations) {
      if (operation.kind === "add" || operation.kind === "update") {
        await verifyPathState(operation.path, operation.afterHash, operation.mode);
      } else if (operation.kind === "delete") {
        if (await pathExists(operation.path)) throw new Error(`Deleted path reappeared during commit: ${operation.path}`);
      } else {
        if (await pathExists(operation.fromPath)) throw new Error(`Rename source still exists after commit: ${operation.fromPath}`);
        await verifyPathHash(operation.toPath, operation.afterHash);
      }
    }
  }

  private async restorePreparedBeforeStates(
    operations: readonly PreparedOperation[],
    journalPath: string,
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const operation of [...operations].reverse()) {
      try {
        await restoreBefore(operation);
        await appendJournal(journalPath, {
          event: "operation_rolled_back",
          at: new Date().toISOString(),
          operation: operation.index,
        });
      } catch (error) {
        errors.push(`operation ${operation.index + 1}: ${errorMessage(error)}`);
      }
    }
    // A rollback error means at least one tombstone or stage may be the only
    // recoverable generation. Preserve the whole transaction asset set rather
    // than making the error irreversible during cleanup.
    if (errors.length === 0) await cleanupPreparedAssets(operations);
    return errors;
  }

  private async loadTransaction(id: string): Promise<LoadedTransaction & { beginPath: string }> {
    const txDir = path.join(this.journalRoot, id);
    const beginPath = path.join(txDir, "journal.jsonl");
    let text: string;
    try {
      text = await fs.readFile(beginPath, "utf8");
    } catch (error) {
      if (errno(error) === "ENOENT") {
        throw mutationError(
          "TRANSACTION_NOT_FOUND",
          `Mutation transaction '${id}' was not found.`,
          `Check the transaction id under ${this.journalRoot}.`,
          id,
        );
      }
      throw error;
    }
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const begin = events.find((event) => event.event === "begin") as unknown as JournalBegin | undefined;
    if (!begin || begin.version !== 1 || begin.id !== id) {
      throw mutationError(
        "INVALID_REQUEST",
        `Mutation journal '${beginPath}' is invalid or unsupported.`,
        "Preserve the journal and inspect it manually before changing affected files.",
        id,
      );
    }
    const receipt = await readJson<WorkspaceMutationReceipt>(path.join(txDir, "receipt.json"));
    const rolledBack = events.some((event) => event.event === "manual_rollback_complete");
    const retainedSourceGenerations = parseRetainedSourceEvents(events, this.workspace);
    return { begin, beginPath, receipt, rolledBack, retainedSourceGenerations };
  }
}

export async function applyWorkspaceMutation(
  workspace: string,
  operations: readonly WorkspaceMutationOperation[],
  options?: WorkspaceMutationOptions,
): Promise<WorkspaceMutationReceipt> {
  return new WorkspaceMutationService(workspace).apply(operations, options);
}

export async function rollbackWorkspaceMutation(
  workspace: string,
  transactionId: string,
): Promise<WorkspaceMutationReceipt> {
  return new WorkspaceMutationService(workspace).rollback(transactionId);
}

export async function reconcileWorkspaceMutation(
  workspace: string,
  transactionId: string,
): Promise<WorkspaceMutationReconciliation> {
  return new WorkspaceMutationService(workspace).reconcile(transactionId);
}

function retainedSourceDescriptors(
  operations: readonly PreparedOperation[],
): WorkspaceMutationRetainedSourceGeneration[] {
  const descriptors: WorkspaceMutationRetainedSourceGeneration[] = [];
  for (const operation of operations) {
    if (operation.kind === "add" || !operation.parkedPath) continue;
    descriptors.push({
      operation: operation.index,
      sourcePath: operation.kind === "rename" ? operation.fromPath : operation.path,
      artifactPath: operation.parkedPath,
      expectedHash: operation.before.hash,
      expectedMode: operation.before.mode,
    });
  }
  return descriptors;
}

function parseRetainedSourceEvents(
  events: readonly Record<string, unknown>[],
  workspace: string,
): WorkspaceMutationRetainedSourceGeneration[] {
  const result = new Map<number, WorkspaceMutationRetainedSourceGeneration>();
  for (const event of events) {
    if (event.event !== "source_retained" || !Number.isInteger(event.operation) ||
        typeof event.sourcePath !== "string" || typeof event.artifactPath !== "string" ||
        typeof event.expectedHash !== "string" || typeof event.expectedMode !== "number") continue;
    const artifactPath = path.resolve(event.artifactPath);
    if (normalizePathKey(artifactPath) !== normalizePathKey(workspace) && !isInside(workspace, artifactPath)) continue;
    result.set(event.operation as number, {
      operation: event.operation as number,
      sourcePath: path.resolve(event.sourcePath),
      artifactPath,
      expectedHash: event.expectedHash,
      expectedMode: event.expectedMode,
    });
  }
  return [...result.values()].sort((left, right) => left.operation - right.operation);
}

function toReceiptOperation(operation: PreparedOperation): WorkspaceMutationReceiptOperation {
  switch (operation.kind) {
    case "add":
      return {
        kind: "add",
        path: operation.path,
        afterHash: operation.afterHash,
        bytes: operation.after.byteLength,
        mode: operation.mode,
      };
    case "update":
      return {
        kind: "update",
        path: operation.path,
        beforeHash: operation.before.hash,
        afterHash: operation.afterHash,
        bytes: operation.after.byteLength,
        backupPath: operation.backupPath,
        mode: operation.before.mode,
        afterMode: operation.mode,
      };
    case "delete":
      return {
        kind: "delete",
        path: operation.path,
        beforeHash: operation.before.hash,
        backupPath: operation.backupPath,
        mode: operation.before.mode,
      };
    case "rename":
      return {
        kind: "rename",
        fromPath: operation.fromPath,
        toPath: operation.toPath,
        beforeHash: operation.before.hash,
        afterHash: operation.afterHash,
        bytes: operation.after.byteLength,
        backupPath: operation.backupPath,
        mode: operation.before.mode,
      };
  }
}

function stateMap(operations: readonly WorkspaceMutationReceiptOperation[]): Map<string, {
  beforeHash: string | null;
  afterHash: string | null;
  beforeMode: number | null;
  afterMode: number | null;
}> {
  const result = new Map<string, {
    beforeHash: string | null;
    afterHash: string | null;
    beforeMode: number | null;
    afterMode: number | null;
  }>();
  for (const operation of operations) {
    if (operation.kind === "add") {
      result.set(operation.path, {
        beforeHash: null,
        afterHash: operation.afterHash,
        beforeMode: null,
        afterMode: operation.mode,
      });
    } else if (operation.kind === "update") {
      result.set(operation.path, {
        beforeHash: operation.beforeHash,
        afterHash: operation.afterHash,
        beforeMode: operation.mode,
        afterMode: operation.afterMode ?? operation.mode,
      });
    } else if (operation.kind === "delete") {
      result.set(operation.path, {
        beforeHash: operation.beforeHash,
        afterHash: null,
        beforeMode: operation.mode,
        afterMode: null,
      });
    } else {
      result.set(operation.fromPath, {
        beforeHash: operation.beforeHash,
        afterHash: null,
        beforeMode: operation.mode,
        afterMode: null,
      });
      result.set(operation.toPath, {
        beforeHash: null,
        afterHash: operation.afterHash,
        beforeMode: null,
        afterMode: operation.mode,
      });
    }
  }
  return result;
}

function touchedFiles(operations: readonly WorkspaceMutationReceiptOperation[]): string[] {
  const result = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "rename") {
      result.add(operation.fromPath);
      result.add(operation.toPath);
    } else {
      result.add(operation.path);
    }
  }
  return [...result];
}

async function restoreBefore(operation: PreparedOperation): Promise<void> {
  if (operation.kind === "add") {
    await removeInstalledGeneration(operation.path, operation.afterHash, operation.installedIdentity);
    await removeIfExists(operation.stagePath);
    return;
  }

  if (operation.sourceState === "foreign_preserved") {
    if (operation.kind !== "delete") await removeIfExists(operation.stagePath);
    return;
  }
  if (operation.sourceState === "foreign_quarantined") {
    throw new Error(
      `external source generation is quarantined at ${operation.parkedPath ?? operation.tombstonePath}; ` +
      `the current user path was not overwritten`,
    );
  }

  const parkedPath = operation.parkedPath ?? operation.tombstonePath;

  if (operation.kind === "rename") {
    await removeInstalledGeneration(
      operation.toPath,
      operation.afterHash,
      operation.installedIdentity,
      parkedPath,
    );
    await restoreExistingPath(operation.fromPath, parkedPath, operation.backupPath, operation.before);
    await removeIfExists(operation.stagePath);
    return;
  }

  if (operation.kind === "update") {
    const current = await readRegularFile(operation.path, false);
    if (current?.hash === operation.before.hash && current.mode === operation.before.mode) {
      await removeIfExists(operation.stagePath);
      return;
    }
    if (current && current.hash !== operation.afterHash) {
      throw new Error(
        `external path ${operation.path} was preserved; the original generation remains recoverable at ` +
        parkedPath,
      );
    }
    await removeInstalledGeneration(
      operation.path,
      operation.afterHash,
      operation.installedIdentity,
      parkedPath,
    );
    await restoreExistingPath(operation.path, parkedPath, operation.backupPath, operation.before);
    await removeIfExists(operation.stagePath);
    return;
  }

  await restoreExistingPath(operation.path, parkedPath, operation.backupPath, operation.before);
}

async function restoreExistingPath(
  target: string,
  tombstone: string,
  backup: string,
  expected: ExistingFile,
): Promise<void> {
  const current = await readRegularFile(target, false);
  if (current?.hash === expected.hash) return;
  if (current) {
    throw new Error(
      `external path ${target} was preserved; the parked generation remains recoverable at ${tombstone}`,
    );
  }

  const parked = await readRegularFile(tombstone, false);
  if (parked?.hash === expected.hash) {
    const restored = await moveRegularFileExclusive(tombstone, target, expected.mode);
    if (!restored) throw new Error(`refusing to overwrite a recreated path during rollback: ${target}`);
    return;
  }
  const backupBytes = await fs.readFile(backup);
  if (workspaceContentHash(backupBytes) !== expected.hash) throw new Error(`rollback backup hash mismatch: ${backup}`);
  const staged = `${target}.ares-restore-${randomUUID()}.stage`;
  await writeNewDurableFile(staged, backupBytes, expected.mode);
  await installNewFile(staged, target);
  await verifyPathHash(target, expected.hash);
}

async function cleanupPreparedAssets(operations: readonly PreparedOperation[]): Promise<void> {
  for (const operation of operations) {
    if (operation.kind === "add") {
      await removeIfExists(operation.stagePath).catch(() => undefined);
    } else if (operation.kind === "delete") {
      if (!operation.parkedPath || normalizePathKey(operation.parkedPath) !== normalizePathKey(operation.tombstonePath)) {
        await removeIfExists(operation.tombstonePath).catch(() => undefined);
      }
    } else {
      await removeIfExists(operation.stagePath).catch(() => undefined);
      if (!operation.parkedPath || normalizePathKey(operation.parkedPath) !== normalizePathKey(operation.tombstonePath)) {
        await removeIfExists(operation.tombstonePath).catch(() => undefined);
      }
    }
  }
}

async function parkOperationSource(operation: ParkableOperation, journalPath: string): Promise<void> {
  const source = operation.kind === "rename" ? operation.fromPath : operation.path;
  try {
    await parkExpectedFile(operation, source, operation.tombstonePath, operation.before);
    const retained = retainedSourceDescriptors([operation])[0];
    if (!retained) throw new Error(`parked source generation has no recovery path: ${source}`);
    await appendJournal(journalPath, {
      event: "source_retained",
      at: new Date().toISOString(),
      ...retained,
    });
  } catch (error) {
    if (error instanceof SourceGenerationConflict) {
      await appendJournal(journalPath, {
        event: "source_generation_conflict",
        at: new Date().toISOString(),
        operation: operation.index,
        sourcePath: error.sourcePath,
        expectedHash: error.expectedHash,
        actualHash: error.actualHash,
        disposition: error.disposition,
        quarantinePath: error.quarantinePath ?? null,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function parkExpectedFile(
  operation: ParkableOperation,
  source: string,
  tombstone: string,
  expected: ExistingFile,
): Promise<void> {
  const justBefore = await readRegularFile(source, false);
  if (!sameFileGeneration(justBefore, expected)) {
    operation.sourceState = "foreign_preserved";
    throw sourceGenerationConflict(source, expected, justBefore, "source_preserved");
  }
  if (await pathExists(tombstone)) throw new Error(`transaction tombstone already exists: ${tombstone}`);

  try {
    await fs.rename(source, tombstone);
  } catch (error) {
    const current = await readRegularFile(source, false);
    if (!sameFileGeneration(current, expected)) {
      operation.sourceState = "foreign_preserved";
      throw sourceGenerationConflict(source, expected, current, "source_preserved", undefined, error);
    }
    throw error;
  }
  await syncDirectory(path.dirname(source));

  const moved = await readRegularFile(tombstone, false);
  if (sameFileGeneration(moved, expected)) {
    // Do not ever unlink the parked inode after a successful commit. An
    // external editor can still hold an open descriptor and write to it after
    // this validation. Move that very inode under the durable transaction (or
    // retain the source-adjacent tombstone if the path crosses a mount) so all
    // such late bytes remain addressable for reconciliation.
    operation.parkedPath = await relocateParkedGeneration(tombstone, operation.retainedSourcePath);
    operation.sourceState = "expected_parked";
    return;
  }

  operation.sourceState = "foreign_quarantined";
  operation.parkedPath = tombstone;
  if (moved && await moveRegularFileExclusive(tombstone, source, moved.mode)) {
    operation.sourceState = "foreign_preserved";
    throw sourceGenerationConflict(source, expected, moved, "source_preserved");
  }
  throw sourceGenerationConflict(
    source,
    expected,
    moved,
    "foreign_generation_quarantined",
    tombstone,
  );
}

async function relocateParkedGeneration(tombstone: string, retainedPath: string): Promise<string> {
  if (await pathExists(retainedPath)) throw new Error(`retained source path already exists: ${retainedPath}`);
  try {
    await renameDurably(tombstone, retainedPath);
    return retainedPath;
  } catch (error) {
    // A source can live beneath a workspace sub-mount while the journal lives
    // on the workspace device. Copying would sever an editor's open descriptor
    // from the recovery artifact, so cross-device/unsupported relocation keeps
    // the original inode at its source-adjacent tombstone instead.
    const retained = await readRegularFile(retainedPath, false);
    const adjacent = await readRegularFile(tombstone, false);
    if (retained && !adjacent) return retainedPath;
    if (adjacent) return tombstone;
    throw new Error(
      `parked source generation disappeared while moving ${tombstone} to ${retainedPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function sourceGenerationConflict(
  source: string,
  expected: ExistingFile,
  actual: ExistingFile | null,
  disposition: "source_preserved" | "foreign_generation_quarantined",
  quarantinePath?: string,
  cause?: unknown,
): SourceGenerationConflict {
  return new SourceGenerationConflict(
    source,
    expected.hash,
    actual?.hash ?? null,
    disposition,
    quarantinePath,
    cause === undefined ? undefined : { cause },
  );
}

function sameFileGeneration(actual: ExistingFile | null, expected: ExistingFile): boolean {
  if (!actual || actual.hash !== expected.hash || actual.mode !== expected.mode) return false;
  const left = actual.identity;
  const right = expected.identity;
  if (left.dev === right.dev && left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.birthtimeMs === right.birthtimeMs;
}

async function installNewFile(
  stage: string,
  target: string,
  claimIdentity?: (identity: FileIdentity) => void,
): Promise<void> {
  if (await pathExists(target)) throw new Error(`refusing to overwrite unexpected path: ${target}`);
  const staged = await readRegularFile(stage, true);
  if (!staged) throw new Error(`staged file disappeared before installation: ${stage}`);
  try {
    // Hard-linking a same-directory stage is an atomic create-if-absent. Unlike
    // rename, it cannot silently replace a file created by an external process.
    await fs.link(stage, target);
    claimIdentity?.(staged.identity);
    await fs.unlink(stage);
  } catch (error) {
    const code = errno(error);
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV") throw error;
    const handle = await fs.open(target, "wx", staged.mode);
    let installedIdentity: FileIdentity;
    try {
      await handle.writeFile(staged.bytes);
      await handle.chmod(staged.mode);
      await handle.sync();
      // On inode-less filesystems size/mtime/birthtime are the generation
      // identity. Claim only the fully written, chmodded, fsynced generation;
      // the empty exclusive-create identity cannot authorize rollback.
      installedIdentity = fileIdentity(await handle.stat());
    } finally {
      await handle.close();
    }
    claimIdentity?.(installedIdentity);
    await fs.unlink(stage);
  }
  await syncDirectory(path.dirname(target));
}

/** Restore or return a parked generation without a check-then-rename gap. Hard
 * link/copy creation is exclusive, so an editor that recreates `target` wins
 * and its bytes are never overwritten. */
async function moveRegularFileExclusive(source: string, target: string, mode: number): Promise<boolean> {
  if (await pathExists(target)) return false;
  const sourceFile = await readRegularFile(source, true);
  if (!sourceFile) throw new Error(`parked file disappeared before restoration: ${source}`);
  let installedIdentity: FileIdentity;
  try {
    await fs.link(source, target);
    installedIdentity = sourceFile.identity;
  } catch (error) {
    if (errno(error) === "EEXIST") return false;
    const code = errno(error);
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV") throw error;
    let handle;
    try {
      handle = await fs.open(target, "wx", mode);
      try {
        await handle.writeFile(sourceFile.bytes);
        await handle.chmod(mode);
        await handle.sync();
        installedIdentity = fileIdentity(await handle.stat());
      } finally {
        await handle.close();
      }
    } catch (writeError) {
      if (errno(writeError) === "EEXIST") return false;
      throw writeError;
    }
  }
  await syncDirectory(path.dirname(target));
  const installed = await readRegularFile(target, false);
  if (!installed || installed.hash !== sourceFile.hash || installed.mode !== mode ||
      !sameFileIdentity(installed.identity, installedIdentity)) return false;
  await fs.unlink(source);
  await syncDirectory(path.dirname(source));
  return true;
}

async function renameDurably(source: string, target: string): Promise<void> {
  await fs.rename(source, target);
  await syncDirectory(path.dirname(target));
  if (path.dirname(source) !== path.dirname(target)) await syncDirectory(path.dirname(source));
}

async function removeInstalledGeneration(
  filePath: string,
  expectedHash: string,
  installedIdentity: FileIdentity | undefined,
  recoveryPath?: string,
): Promise<void> {
  const existing = await readRegularFile(filePath, false);
  if (!existing) return;
  if (!installedIdentity || existing.hash !== expectedHash ||
      !sameFileIdentity(existing.identity, installedIdentity)) {
    throw new Error(
      `external or unowned path ${filePath} was preserved during rollback` +
      (recoveryPath ? `; the parked generation remains recoverable at ${recoveryPath}` : ""),
    );
  }
  await fs.unlink(filePath);
  await syncDirectory(path.dirname(filePath));
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (left.dev === right.dev && left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.birthtimeMs === right.birthtimeMs;
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

async function requireExpectedFile(
  filePath: string,
  expectedHash: string,
  transactionId: string,
  action: string,
  expectedMode?: number,
): Promise<ExistingFile> {
  const existing = await readRegularFile(filePath, true);
  if (!existing) {
    throw mutationError(
      "TARGET_MISSING",
      `Cannot ${action} ${filePath}: the file does not exist.`,
      "Re-read the workspace and regenerate the patch against the current file tree.",
      transactionId,
    );
  }
  if (existing.hash !== expectedHash) {
    throw mutationError(
      "BASE_MISMATCH",
      `Cannot ${action} ${filePath}: expected base ${expectedHash}, found ${existing.hash}.`,
      "The file changed after the patch was computed. Re-read it and regenerate the patch; no files were changed.",
      transactionId,
    );
  }
  if (expectedMode !== undefined && existing.mode !== expectedMode) {
    throw mutationError(
      "BASE_MISMATCH",
      `Cannot ${action} ${filePath}: expected mode ${formatMode(expectedMode)}, found ${formatMode(existing.mode)}.`,
      "The file mode changed after the mutation was computed. Re-read it and regenerate the mutation; no files were changed.",
      transactionId,
    );
  }
  return existing;
}

async function readRegularFile(filePath: string, failOnUnsupported: boolean): Promise<ExistingFile | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let listed: Stats;
    try {
      listed = await fs.lstat(filePath);
    } catch (error) {
      if (errno(error) === "ENOENT") return null;
      throw error;
    }
    if (!listed.isFile() || listed.isSymbolicLink()) {
      if (!failOnUnsupported) return null;
      throw mutationError(
        "UNSUPPORTED_FILE_TYPE",
        `Mutation target is not a regular file: ${filePath}`,
        "Apply patches only to regular files; handle directories and symbolic links explicitly outside this tool.",
      );
    }

    let handle;
    try {
      handle = await fs.open(filePath, "r");
    } catch (error) {
      if (errno(error) === "ENOENT") continue;
      throw error;
    }
    try {
      const openedBefore = await handle.stat();
      if (!openedBefore.isFile() || !sameFilesystemNode(listed, openedBefore)) continue;
      const bytes = await handle.readFile();
      const openedAfter = await handle.stat();
      if (!sameOpenFileVersion(openedBefore, openedAfter)) continue;
      const listedAfter = await fs.lstat(filePath).catch((error) => {
        if (errno(error) === "ENOENT") return null;
        throw error;
      });
      if (!listedAfter?.isFile() || listedAfter.isSymbolicLink() ||
          !sameFilesystemNode(openedAfter, listedAfter)) continue;
      return {
        bytes,
        hash: workspaceContentHash(bytes),
        mode: openedAfter.mode & 0o7777,
        identity: fileIdentity(openedAfter),
      };
    } finally {
      await handle.close();
    }
  }
  throw mutationError(
    "BASE_MISMATCH",
    `File changed repeatedly while Ares was reading its generation: ${filePath}`,
    "Wait for the external editor to settle, then re-read the file and retry the mutation.",
  );
}

function fileIdentity(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

function sameFilesystemNode(left: Stats, right: Stats): boolean {
  if (left.dev === right.dev && left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return left.size === right.size && left.birthtimeMs === right.birthtimeMs;
}

function sameOpenFileVersion(left: Stats, right: Stats): boolean {
  return sameFilesystemNode(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    (left.mode & 0o7777) === (right.mode & 0o7777);
}

async function verifyPathHash(filePath: string, expectedHash: string): Promise<void> {
  const existing = await readRegularFile(filePath, true);
  if (!existing || existing.hash !== expectedHash) {
    throw new Error(`post-write verification failed for ${filePath}; expected SHA-256 ${expectedHash}`);
  }
}

async function verifyPathState(filePath: string, expectedHash: string, expectedMode: number): Promise<void> {
  const existing = await readRegularFile(filePath, true);
  if (!existing || existing.hash !== expectedHash || existing.mode !== expectedMode) {
    throw new Error(
      `post-write verification failed for ${filePath}; expected SHA-256 ${expectedHash} ` +
        `and mode ${formatMode(expectedMode)}, found ${existing?.hash ?? "missing"} ` +
        `and ${existing ? formatMode(existing.mode) : "missing"}`,
    );
  }
}

async function assertParentDoesNotEscape(workspace: string, target: string): Promise<void> {
  const realWorkspace = await fs.realpath(workspace);
  let probe = path.dirname(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = await fs.lstat(probe);
      if (stat.isSymbolicLink()) {
        const canonical = await fs.realpath(probe);
        if (!isInside(realWorkspace, canonical) && normalizePathKey(realWorkspace) !== normalizePathKey(canonical)) {
          throw mutationError(
            "PATH_OUTSIDE_WORKSPACE",
            `Mutation path resolves through a link outside the workspace: ${target}`,
            "Choose a path whose real parent directory is inside the active workspace.",
          );
        }
      } else if (!stat.isDirectory()) {
        throw mutationError(
          "UNSUPPORTED_FILE_TYPE",
          `Parent path is not a directory: ${probe}`,
          "Choose a valid file path beneath a directory.",
        );
      }
      const canonical = await fs.realpath(probe);
      if (!isInside(realWorkspace, canonical) && normalizePathKey(realWorkspace) !== normalizePathKey(canonical)) {
        throw mutationError(
          "PATH_OUTSIDE_WORKSPACE",
          `Mutation path resolves outside the workspace: ${target}`,
          "Choose a path whose real parent directory is inside the active workspace.",
        );
      }
      void missing;
      return;
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      missing.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

async function canonicalLockKey(realWorkspace: string, target: string): Promise<string> {
  let probe = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = await fs.realpath(probe);
      if (!isInside(realWorkspace, canonical) && normalizePathKey(realWorkspace) !== normalizePathKey(canonical)) {
        throw mutationError(
          "PATH_OUTSIDE_WORKSPACE",
          `Mutation path resolves outside the workspace: ${target}`,
          "Choose a path inside the active workspace.",
        );
      }
      return normalizePathKey(path.join(canonical, ...suffix));
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

async function acquirePathLocks(keys: readonly string[]): Promise<() => void> {
  const releases: Array<() => void> = [];
  for (const key of [...new Set(keys)].sort()) releases.push(await acquirePathLock(key));
  return () => {
    for (const release of releases.reverse()) release();
  };
}

interface CrossProcessLockRecord {
  version: 1;
  token: string;
  pid: number;
  pathKey: string;
  createdAt: string;
}

interface ObservedCrossProcessLock {
  record: CrossProcessLockRecord | null;
  mtimeMs: number;
  dev: number;
  ino: number;
  size: number;
}

/** Cooperative Ares processes serialize on the same canonical file keys.
 * Uncooperative editors are still fenced by generation checks at rename time. */
async function acquireCrossProcessPathLocks(
  lockRoot: string,
  keys: readonly string[],
): Promise<() => Promise<void>> {
  await fs.mkdir(lockRoot, { recursive: true });
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const key of [...new Set(keys)].sort()) {
      releases.push(await acquireCrossProcessPathLock(lockRoot, key));
    }
  } catch (error) {
    for (const release of releases.reverse()) await release().catch(() => undefined);
    throw error;
  }
  return async () => {
    for (const release of releases.reverse()) await release();
  };
}

async function acquireCrossProcessPathLock(lockRoot: string, key: string): Promise<() => Promise<void>> {
  const lockPath = path.join(lockRoot, `${workspaceContentHash(key)}.lock`);
  const token = randomUUID();
  const startedAt = Date.now();
  for (;;) {
    const record: CrossProcessLockRecord = {
      version: 1,
      token,
      pid: process.pid,
      pathKey: key,
      createdAt: new Date().toISOString(),
    };
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await removeIfExists(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return () => releaseCrossProcessPathLock(lockPath, token);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }

    if (await reclaimAbandonedCrossProcessLock(lockPath)) continue;
    if (Date.now() - startedAt >= CROSS_PROCESS_LOCK_WAIT_MS) {
      throw mutationError(
        "PATH_CONFLICT",
        `Another Ares process still holds the workspace mutation lock for ${key}.`,
        "Wait for that mutation to settle, then re-read the file and retry against its current hash.",
      );
    }
    await delay(20);
  }
}

async function reclaimAbandonedCrossProcessLock(lockPath: string): Promise<boolean> {
  const observed = await readCrossProcessLock(lockPath);
  if (!observed) return true;
  if (observed.record) {
    if (processIsAlive(observed.record.pid)) return false;
  } else if (Date.now() - observed.mtimeMs < MALFORMED_LOCK_STALE_MS) {
    return false;
  }

  const quarantine = `${lockPath}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantine);
  } catch (error) {
    return errno(error) === "ENOENT";
  }
  const moved = await readCrossProcessLock(quarantine);
  if (!moved || !sameCrossProcessLockGeneration(observed, moved)) {
    if (!(await pathExists(lockPath))) await fs.rename(quarantine, lockPath).catch(() => undefined);
    return false;
  }
  await removeIfExists(quarantine).catch(() => undefined);
  return true;
}

async function readCrossProcessLock(lockPath: string): Promise<ObservedCrossProcessLock | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
    let record: CrossProcessLockRecord | null = null;
    try {
      const parsed = JSON.parse(raw) as Partial<CrossProcessLockRecord>;
      if (parsed.version === 1 && typeof parsed.token === "string" &&
          Number.isInteger(parsed.pid) && typeof parsed.pathKey === "string") {
        record = parsed as CrossProcessLockRecord;
      }
    } catch {
      // A creator can be observed between exclusive create and metadata fsync.
    }
    return { record, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino, size: stat.size };
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

function sameCrossProcessLockGeneration(
  left: ObservedCrossProcessLock,
  right: ObservedCrossProcessLock,
): boolean {
  if (left.record?.token || right.record?.token) return left.record?.token === right.record?.token;
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function releaseCrossProcessPathLock(lockPath: string, token: string): Promise<void> {
  const observed = await readCrossProcessLock(lockPath);
  if (!observed || observed.record?.token !== token) return;
  await removeIfExists(lockPath);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquirePathLock(key: string): Promise<() => void> {
  const previous = pathLockTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(() => gate);
  pathLockTails.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (pathLockTails.get(key) === tail) {
      void tail.finally(() => {
        if (pathLockTails.get(key) === tail) pathLockTails.delete(key);
      });
    }
  };
}

async function appendJournal(journalPath: string, event: object): Promise<void> {
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  const handle = await fs.open(journalPath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(journalPath));
}

async function writeNewDurableJson(filePath: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeNewDurableFile(filePath, bytes, 0o600);
}

async function writeNewDurableFile(filePath: string, bytes: Uint8Array, mode = 0o666): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeIfExists(filePath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(directory: string): Promise<void> {
  // Directory fsync is available on POSIX. Windows rejects opening directories;
  // the file itself is still fsynced and rename remains atomic there.
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

function claimPath(claimed: Map<string, string>, filePath: string, owner: string): void {
  const key = normalizePathKey(filePath);
  const prior = claimed.get(key);
  if (prior) {
    throw mutationError(
      "PATH_CONFLICT",
      `Mutation path ${filePath} is used by both ${prior} and ${owner}.`,
      "Combine changes to each file into one operation so the transaction has one unambiguous before/after state per path.",
    );
  }
  claimed.set(key, owner);
}

function normalizePathKey(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function stagePathFor(target: string, transactionId: string, index: number): string {
  return path.join(path.dirname(target), `.ares-${transactionId}-${pad(index)}.stage`);
}

function tombstonePathFor(target: string, transactionId: string, index: number): string {
  return path.join(path.dirname(target), `.ares-${transactionId}-${pad(index)}.old`);
}

function pad(index: number): string {
  return String(index).padStart(4, "0");
}

function validateHash(hash: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw mutationError(
      "INVALID_REQUEST",
      `${label} must be a SHA-256 hex digest.`,
      "Hash the exact base bytes immediately before constructing the mutation.",
    );
  }
}

function validateTransactionId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw mutationError(
      "INVALID_REQUEST",
      `Invalid mutation transaction id: ${JSON.stringify(id)}`,
      "Use 1-128 letters, digits, dots, underscores, or hyphens.",
    );
  }
  return id;
}

function mutationError(
  code: WorkspaceMutationErrorCode,
  message: string,
  actionable: string,
  transactionId?: string,
  cause?: unknown,
): WorkspaceMutationError {
  return new WorkspaceMutationError(code, message, actionable, transactionId, cause === undefined ? undefined : { cause });
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMode(mode: number): string {
  return `0o${(mode & 0o7777).toString(8)}`;
}
