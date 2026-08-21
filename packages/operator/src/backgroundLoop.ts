import { decideAttention, attentionItemsFromGoals, type AttentionDecision } from "./attention.js";
import { tickGoal, type ControlLoopContext } from "./controlLoop.js";
import { Scheduler } from "./scheduler.js";
import { activeGoals } from "./store.js";
import { checkWatchers, type WatcherExecutionRequest } from "./watchers.js";
import type { Goal } from "./types.js";

/**
 * The composition roots' shared heartbeat: ARES_OPERATOR_TICK_MS, floored at
 * one minute, default 30 minutes. This literal used to be duplicated across
 * four call sites (two live loops, two report-only status frames) — the
 * report-only copies were guaranteed to drift the day the default changed.
 */
export function operatorTickIntervalMs(env: Record<string, string | undefined> = process.env): number {
  return Math.max(60_000, Number(env.ARES_OPERATOR_TICK_MS) || 30 * 60_000);
}

export type OperatorWakeReason = "manual" | "interval" | "event";

export interface OperatorBackgroundTick {
  reason: OperatorWakeReason;
  decision: AttentionDecision;
  ran: Goal[];
  /** The wakes this tick consumed. Empty on a plain interval heartbeat. */
  events: unknown[];
}

/** The lifecycle vocabulary the daemon surfaces for the background loop. */
export type OperatorBackgroundEvent =
  | { type: "operator_started"; everyMs: number }
  | { type: "operator_tick"; reason: OperatorWakeReason; goalId: string; status: Goal["status"]; summary: string }
  | { type: "operator_idle"; reason: OperatorWakeReason; summary: string; suggestions: string[] }
  | { type: "operator_error"; message: string }
  | { type: "operator_stopped" }
  | { type: "operator_woken"; reason: OperatorWakeReason; events: number }
  | { type: "watcher_fired"; id: string; label: string; goalId: string; summary: string };

export interface OperatorBackgroundLoopOptions {
  everyMs?: number;
  emit?: (event: OperatorBackgroundEvent) => void;
  onError?: (err: unknown) => void;
  /**
   * Mission-aware idle: when there's no active goal to advance, the loop surfaces
   * these as SUGGESTIONS (logged, never auto-executed) — e.g. the active project
   * packet's nextActions. Keeps idle ticks aware of the war map without turning
   * into a 3 AM chaos goblin.
   */
  nextActions?: () => readonly string[] | Promise<readonly string[]>;
  /** Pause gate: when this returns true, a tick is skipped (remote /pause). */
  paused?: () => boolean | Promise<boolean>;
  /**
   * Runs at the START of every (unpaused) tick, before goals are read. The daemon
   * uses this to materialize DUE standing orders into fresh goals, so the same
   * tick picks them up and executes them. Best-effort: a throw is swallowed.
   */
  beforeTick?: () => void | Promise<void>;
  /**
   * The live consent gate handed through to execute-mode watchers. Absent
   * (the daemon today) every watcher trip stays plan-only.
   */
  requestExecution?: (request: WatcherExecutionRequest) => Promise<"allow_once" | "allow_always" | "deny">;
}

/**
 * Opt-IN gate for the background loop. It runs ONLY when ARES_OPERATOR_LOOP=1,
 * and an emergency kill (ARES_OPERATOR_AUTOTICK=0) always wins. Default: OFF —
 * autonomy is deliberate, never a surprise.
 */
export function operatorLoopEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.ARES_OPERATOR_AUTOTICK === "0") return false;
  return env.ARES_OPERATOR_LOOP === "1";
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 240);
}

/**
 * Always-on driver for the Operator.
 *
 * Scheduler wakes are event-first and interval-second; this loop adds the
 * missing attention decision before it spends a worker tick. One wake advances
 * exactly one ATTENTION-SELECTED goal (never naive active[0]), which keeps
 * background autonomy responsive without stealing the foreground turn. A failing
 * goal tick is isolated — it surfaces operator_error and the loop keeps running.
 */
export class OperatorBackgroundLoop {
  private controller = new AbortController();
  private readonly scheduler: Scheduler;
  private readonly everyMs: number;
  private ticking = false;

  constructor(
    private readonly ctx: ControlLoopContext,
    private readonly opts: OperatorBackgroundLoopOptions = {},
  ) {
    this.everyMs = opts.everyMs ?? 60_000;
    this.scheduler = new Scheduler({
      everyMs: this.everyMs,
      onTick: async (reason) => {
        await this.tickOnce(reason);
      },
      onError: (err) => {
        this.emit({ type: "operator_error", message: errMessage(err) });
        this.opts.onError?.(err);
      },
    });
  }

  start(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.scheduler.start();
    this.emit({ type: "operator_started", everyMs: this.everyMs });
  }

  stop(): void {
    this.scheduler.stop();
    this.controller.abort();
    this.emit({ type: "operator_stopped" });
  }

  get started(): boolean {
    return this.scheduler.started;
  }

  enqueueEvent(event: unknown): void {
    this.scheduler.enqueueEvent(event);
  }

  pendingEvents(): number {
    return this.scheduler.pendingEvents();
  }

  async tickOnce(reason: OperatorWakeReason = "manual"): Promise<OperatorBackgroundTick> {
    // Backpressure: one tick at a time. A second wake while a tick is in flight
    // is dropped (the Scheduler also guards interval/event overlap).
    if (this.ticking) return { reason, decision: decideAttention([]), ran: [], events: [] };
    this.ticking = true;
    try {
      // Remote pause: skip the tick entirely, but stay alive (a /resume
      // reactivates). Deliberately BEFORE the drain — a parked tick must not
      // swallow the wakes it isn't going to act on.
      if (await this.isPaused()) {
        this.emit({ type: "operator_idle", reason, summary: "paused", suggestions: [] });
        return { reason, decision: decideAttention([]), ran: [], events: [] };
      }
      // Drain what woke us. Nothing consumed this queue before, so producers had
      // no way to hand the loop a payload and the array only ever grew.
      const events = this.scheduler.drainEvents();
      if (events.length > 0) this.emit({ type: "operator_woken", reason, events: events.length });
      // Materialize due standing orders into goals BEFORE reading the goal set, so
      // a recurring mission becomes runnable on the very tick it comes due.
      if (this.opts.beforeTick) {
        try { await this.opts.beforeTick(); } catch { /* never let a hook kill the tick */ }
      }
      // Condition watchers: probe reality, propose — or, with live owner
      // consent, execute — when one trips. Runs before the goal read so a
      // fresh goal is runnable this same tick, and receives the drained wake
      // events so wakeOn watchers probe now instead of at their next cadence.
      try {
        const watched = await checkWatchers(this.ctx.home, {
          workspace: this.ctx.workspace,
          signal: this.controller.signal,
          requestExecution: this.opts.requestExecution,
          wokenBy: events,
        });
        for (const f of watched.fired) {
          this.emit({ type: "watcher_fired", id: f.watcher.id, label: f.watcher.label, goalId: f.goalId, summary: f.summary });
        }
      } catch {
        // a watcher pass never kills the tick
      }
      const goals = await activeGoals(this.ctx.home);
      const decision = decideAttention(attentionItemsFromGoals(goals));

      const selectedGoalId = decision.selected?.id.startsWith("goal:")
        ? decision.selected.id.slice("goal:".length)
        : undefined;
      const goal = selectedGoalId ? goals.find((g) => g.id === selectedGoalId) : undefined;

      if (!goal) {
        // Nothing urgent to advance — stay mission-aware: surface (don't run) the
        // next strategic moves, so idle time still knows the war map.
        const suggestions = (await this.resolveNextActions()).slice(0, 5);
        this.emit({ type: "operator_idle", reason, summary: decision.summary, suggestions });
        return { reason, decision, ran: [], events };
      }

      try {
        const next = await tickGoal({ ...this.ctx, signal: this.ctx.signal ?? this.controller.signal }, goal);
        this.emit({ type: "operator_tick", reason, goalId: next.id, status: next.status, summary: decision.summary });
        return { reason, decision, ran: [next], events };
      } catch (err) {
        // A failed worker tick never kills the loop — record it and move on.
        this.emit({ type: "operator_error", message: errMessage(err) });
        return { reason, decision, ran: [], events };
      }
    } finally {
      this.ticking = false;
    }
  }

  private async isPaused(): Promise<boolean> {
    if (!this.opts.paused) return false;
    try {
      return (await this.opts.paused()) === true;
    } catch {
      return false;
    }
  }

  private async resolveNextActions(): Promise<readonly string[]> {
    if (!this.opts.nextActions) return [];
    try {
      return (await this.opts.nextActions()) ?? [];
    } catch {
      return [];
    }
  }

  private emit(event: OperatorBackgroundEvent): void {
    try {
      this.opts.emit?.(event);
    } catch {
      // a bad emitter never breaks the loop
    }
  }
}
