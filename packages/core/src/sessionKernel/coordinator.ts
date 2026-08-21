import { randomUUID } from "node:crypto";
import { LeaseHeldError, SessionKernelError, StaleGenerationError } from "./errors.js";
import type { SessionKernelStore } from "./store.js";
import type {
  ExecutionState,
  JsonValue,
  ReleaseLeaseInput,
  RunFence,
  RunnerLease,
  SessionRunRecord,
  WorkOutcome,
} from "./types.js";

export interface RunWorkerResult {
  executionState: Exclude<ExecutionState, "running" | "admitted">;
  workOutcome: WorkOutcome;
  error?: JsonValue | null;
}

export interface CoordinatedRunContext extends RunFence {
  ownerId: string;
  signal: AbortSignal;
  /** Throws when another runner generation has taken ownership. */
  assertCurrent(): RunnerLease;
  /** Explicit renewal for workers that know they are entering a long sync phase. */
  renew(): RunnerLease;
}

export type CoordinatedRunWorker = (context: CoordinatedRunContext) => Promise<RunWorkerResult>;

export interface RunLeaseCoordinatorOptions {
  store: SessionKernelStore;
  ownerId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  /** Poll cadence only when a caller explicitly asks to wait for another
   * generation to settle or expire. Immediate coordinators still fail fast. */
  retryIntervalMs?: number;
}

export interface AcquireCoordinatedLeaseOptions {
  signal?: AbortSignal;
  /** False by default. Interactive/recovery Session owners wait; competing
   * dispatchers normally fail fast so a duplicate wake is observable. */
  waitForLease?: boolean;
  /** Called exactly once when renewal proves this generation lost authority. */
  onLeaseLost?: (error: unknown) => void;
}

export interface CoordinatedRunLease {
  readonly context: CoordinatedRunContext;
  /** Atomically settles the run and relinquishes the durable generation.
   * Idempotent after a successful release. */
  release(result: ReleaseLeaseInput): SessionRunRecord;
}

export interface RunCoordinatorOptions {
  store: SessionKernelStore;
  worker: CoordinatedRunWorker;
  ownerId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
}

export interface CoordinatorDrainResult {
  sessionId: string;
  generation: number;
  cycles: number;
  /** May be `admitted` when another durable input arrived before release. */
  executionState: ExecutionState;
  workOutcome: WorkOutcome;
  error?: JsonValue | null;
}

interface SessionSlot {
  dirty: boolean;
  promise: Promise<CoordinatorDrainResult>;
  controller: AbortController;
}

interface ActiveLease {
  controller: AbortController;
  settled: boolean;
  /** Idempotent teardown (clear heartbeat, detach listeners, drop from active).
   * Installed by acquire(); shutdown() runs it so an aborted lease can never
   * keep renewing on its heartbeat interval after the coordinator is closed. */
  cleanup?: () => void;
}

/**
 * The single lease lifecycle used by interactive Sessions and background
 * RunCoordinators. It owns acquisition retry, fencing, heartbeat revocation,
 * release, and shutdown; workers only own the work performed inside a fence.
 */
export class RunLeaseCoordinator {
  readonly ownerId: string;
  private readonly store: SessionKernelStore;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly active = new Set<ActiveLease>();
  private closed = false;

  constructor(options: RunLeaseCoordinatorOptions) {
    this.store = options.store;
    this.ownerId = options.ownerId ?? `runner_${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? Math.max(100, Math.min(10_000, Math.floor(this.leaseTtlMs / 3)));
    this.retryIntervalMs = options.retryIntervalMs ?? Math.max(25, Math.min(250, this.heartbeatIntervalMs));
    if (!this.ownerId.trim()) throw new SessionKernelError("INVALID_ARGUMENT", "Coordinator ownerId must not be empty");
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 50) {
      throw new SessionKernelError(
        "INVALID_ARGUMENT",
        "Coordinator heartbeatIntervalMs must be an integer of at least 50ms",
      );
    }
    if (!Number.isSafeInteger(this.retryIntervalMs) || this.retryIntervalMs < 1) {
      throw new SessionKernelError(
        "INVALID_ARGUMENT",
        "Coordinator retryIntervalMs must be a positive integer",
      );
    }
  }

  async acquire(
    sessionId: string,
    options: AcquireCoordinatedLeaseOptions = {},
  ): Promise<CoordinatedRunLease> {
    if (this.closed) throw new SessionKernelError("KERNEL_CLOSED", "Run lease coordinator is closed");
    let durableLease: RunnerLease;
    while (true) {
      throwIfAborted(options.signal);
      try {
        durableLease = this.store.acquireRunnerLease(sessionId, this.ownerId, this.leaseTtlMs);
        break;
      } catch (error) {
        if (!(error instanceof LeaseHeldError) || !options.waitForLease) throw error;
        await abortableDelay(this.retryIntervalMs, options.signal);
      }
    }

    const fence: RunFence = {
      sessionId: durableLease.sessionId,
      generation: durableLease.generation,
      leaseToken: durableLease.leaseToken,
    };
    const controller = new AbortController();
    const state: ActiveLease = { controller, settled: false };
    this.active.add(state);
    let leaseFailure: unknown;
    let released: SessionRunRecord | undefined;
    let lossNotified = false;
    const inherited = options.signal;
    const abortFromParent = () => controller.abort(inherited?.reason ?? new Error("Run lease aborted"));
    if (inherited?.aborted) abortFromParent();
    else inherited?.addEventListener("abort", abortFromParent, { once: true });

    const cleanup = () => {
      clearInterval(heartbeat);
      inherited?.removeEventListener("abort", abortFromParent);
      this.active.delete(state);
    };
    state.cleanup = cleanup;
    const loseLease = (error: unknown) => {
      if (leaseFailure === undefined) leaseFailure = error;
      if (!controller.signal.aborted) controller.abort(error);
      if (!lossNotified) {
        lossNotified = true;
        try {
          options.onLeaseLost?.(error);
        } catch {
          // Revocation cannot be vetoed by an observability callback.
        }
      }
    };
    const heartbeat = setInterval(() => {
      if (state.settled || controller.signal.aborted) return;
      try {
        this.store.renewRunnerLease(fence, this.leaseTtlMs);
      } catch (error) {
        loseLease(error);
      }
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();

    const context: CoordinatedRunContext = {
      ...fence,
      ownerId: this.ownerId,
      signal: controller.signal,
      assertCurrent: () => this.store.assertFence(fence),
      renew: () => {
        try {
          return this.store.renewRunnerLease(fence, this.leaseTtlMs);
        } catch (error) {
          loseLease(error);
          throw error;
        }
      },
    };

    return {
      context,
      release: (result) => {
        if (released) return released;
        if (state.settled) {
          throw new StaleGenerationError(sessionId, fence.generation, "run lease is already settling");
        }
        state.settled = true;
        cleanup();
        if (leaseFailure !== undefined) throw leaseFailure;
        released = this.store.releaseRunnerLease(fence, result);
        return released;
      },
    };
  }

  async shutdown(reason: unknown = new Error("Run lease coordinator shut down")): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Snapshot first: cleanup() deletes from this.active while we iterate.
    for (const lease of [...this.active]) {
      lease.controller.abort(reason);
      // Aborting alone leaves the heartbeat interval alive — the lease would
      // keep renewing forever after shutdown. Run the same teardown release()
      // does (clearInterval + listener removal + active.delete).
      lease.cleanup?.();
    }
  }
}

/**
 * In-process serialization and wakeup coalescing around the durable lease.
 *
 * One callback executes at a time per session. Multiple wakeups that arrive
 * before execution starts collapse into one cycle; wakeups received while the
 * worker is running collapse into one additional cycle. The SQLite lease is the
 * cross-process authority, so a second coordinator cannot run the same session.
 */
export class RunCoordinator {
  readonly ownerId: string;
  private readonly store: SessionKernelStore;
  private readonly worker: CoordinatedRunWorker;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly leases: RunLeaseCoordinator;
  private readonly slots = new Map<string, SessionSlot>();
  private closed = false;

  constructor(options: RunCoordinatorOptions) {
    this.store = options.store;
    this.worker = options.worker;
    this.ownerId = options.ownerId ?? `runner_${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? Math.max(100, Math.min(10_000, Math.floor(this.leaseTtlMs / 3)));
    if (!this.ownerId.trim()) throw new SessionKernelError("INVALID_ARGUMENT", "Coordinator ownerId must not be empty");
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 50) {
      throw new SessionKernelError(
        "INVALID_ARGUMENT",
        "Coordinator heartbeatIntervalMs must be an integer of at least 50ms",
      );
    }
    this.leases = new RunLeaseCoordinator({
      store: this.store,
      ownerId: this.ownerId,
      leaseTtlMs: this.leaseTtlMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });
  }

  get activeSessionIds(): string[] {
    return [...this.slots.keys()];
  }

  wake(sessionId: string): Promise<CoordinatorDrainResult> {
    if (this.closed) throw new SessionKernelError("KERNEL_CLOSED", "Run coordinator is closed");
    const active = this.slots.get(sessionId);
    if (active) {
      active.dirty = true;
      return active.promise;
    }

    const controller = new AbortController();
    const placeholder = {} as SessionSlot;
    const promise = this.drain(sessionId, placeholder, controller);
    const slot: SessionSlot = Object.assign(placeholder, { dirty: false, promise, controller });
    this.slots.set(sessionId, slot);
    void promise.then(
      () => {
        if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
      },
      () => {
        if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
      },
    );
    return promise;
  }

  abort(sessionId: string, reason: unknown = new Error("Run coordinator aborted")): boolean {
    const slot = this.slots.get(sessionId);
    if (!slot) return false;
    slot.controller.abort(reason);
    return true;
  }

  async shutdown(reason: unknown = new Error("Run coordinator shut down")): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.slots.values()];
    for (const slot of pending) slot.controller.abort(reason);
    await Promise.allSettled(pending.map((slot) => slot.promise));
    await this.leases.shutdown(reason);
  }

  private async drain(
    sessionId: string,
    slot: SessionSlot,
    controller: AbortController,
  ): Promise<CoordinatorDrainResult> {
    const lease = await this.leases.acquire(sessionId, {
      signal: controller.signal,
      onLeaseLost: (error) => controller.abort(error),
    });
    const fence: RunFence = lease.context;
    let cycles = 0;
    let finalResult: RunWorkerResult = { executionState: "idle", workOutcome: "not_applicable" };
    const context = lease.context;

    try {
      do {
        slot.dirty = false;
        if (controller.signal.aborted) throw abortReason(controller.signal);
        this.store.assertFence(fence);
        finalResult = await this.worker(context);
        cycles += 1;
        this.store.assertFence(fence);
      } while (slot.dirty && !controller.signal.aborted);

      const released = lease.release(finalResult);
      return {
        sessionId,
        generation: fence.generation,
        cycles,
        executionState: released.executionState,
        workOutcome: released.workOutcome,
        error: released.error,
      };
    } catch (error) {
      const release: ReleaseLeaseInput = {
        executionState: controller.signal.aborted ? "interrupted" : "failed",
        workOutcome: "unverified",
        error: errorJson(error),
      };
      try {
        lease.release(release);
      } catch (releaseError) {
        if (!(releaseError instanceof StaleGenerationError)) {
          // Preserve the worker/revocation error. A failed cleanup must not
          // transform it into apparent success, but stale release is expected
          // after another generation has already taken over.
          if (error === undefined) throw releaseError;
        }
      }
      throw error;
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Run was aborted");
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Run was aborted"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Run was aborted");
}

function errorJson(error: unknown): JsonValue {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error instanceof SessionKernelError ? { code: error.code } : {}),
    };
  }
  if (typeof error === "string") return { message: error };
  return { message: "Unknown runner failure" };
}
