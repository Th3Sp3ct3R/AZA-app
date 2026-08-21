// Heap pressure, watched from inside the process that is about to die.
//
// Field origin: coworkers reported "the more I use it the slower it starts to
// work", followed by `The Garrison went down (exit code 134)` — a V8 abort on
// the heap limit. Two things made that unfixable from the outside:
//
//   1. An OOM abort never runs `uncaughtException`. installGlobalCrashHandlers
//      writes nothing, so ~/.ares/crashes was EMPTY for exactly the crash we
//      most needed a record of.
//   2. Nothing measured the climb. The slowdown before the crash is the GC
//      thrashing against a limit it is about to hit, and it was invisible.
//
// So the daemon samples its own heap on a timer. Crossing "elevated" says so
// out loud; crossing "critical" is a request for the host to shed what it can
// (the daemon evicts idle sessions) AND the last chance to leave an artifact
// on disk while the process is still alive to write one.
//
// This module is deliberately pure — it takes readings and returns verdicts —
// so the thresholds and the anti-flap behaviour are testable without having to
// actually exhaust a heap.

import v8 from "node:v8";

export type HeapPressure = "ok" | "elevated" | "critical";

export interface HeapSample {
  usedBytes: number;
  limitBytes: number;
}

export interface HeapVerdict {
  pressure: HeapPressure;
  /** used / limit, clamped to [0, 1]. */
  ratio: number;
  usedMb: number;
  limitMb: number;
  /** The level differs from the last one reported. */
  changed: boolean;
  /** Say something now — level change, or a critical re-warn past the cooldown. */
  shouldReport: boolean;
  /** Shed memory now: critical, and the last relief is older than the cooldown. */
  shouldRelieve: boolean;
}

export interface HeapGuardOptions {
  /** Ratio at which we start saying so. Default 0.72. */
  elevatedRatio?: number;
  /** Ratio at which we start shedding. Default 0.86. */
  criticalRatio?: number;
  /** How much a ratio must fall BELOW a threshold to count as recovered.
   *  Without this a reading parked on the line flaps every sample. */
  hysteresis?: number;
  /** Minimum gap between two relief attempts / two critical reports. */
  cooldownMs?: number;
}

export class HeapGuard {
  private readonly elevatedRatio: number;
  private readonly criticalRatio: number;
  private readonly hysteresis: number;
  private readonly cooldownMs: number;
  private level: HeapPressure = "ok";
  private lastReliefAt = -Infinity;
  private lastCriticalReportAt = -Infinity;

  constructor(opts: HeapGuardOptions = {}) {
    this.elevatedRatio = opts.elevatedRatio ?? 0.72;
    this.criticalRatio = opts.criticalRatio ?? 0.86;
    this.hysteresis = opts.hysteresis ?? 0.05;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
  }

  /** Current level, without taking a reading. */
  get pressure(): HeapPressure {
    return this.level;
  }

  observe(sample: HeapSample, nowMs: number): HeapVerdict {
    const limit = sample.limitBytes > 0 ? sample.limitBytes : 0;
    const ratio = limit > 0 ? Math.min(1, Math.max(0, sample.usedBytes / limit)) : 0;
    const next = this.classify(ratio);
    const changed = next !== this.level;
    this.level = next;

    // A critical reading that has NOT changed level still deserves periodic
    // attention — it means we shed and it did not help.
    const criticalReWarn =
      next === "critical" && !changed && nowMs - this.lastCriticalReportAt >= this.cooldownMs;
    if (next === "critical" && (changed || criticalReWarn)) this.lastCriticalReportAt = nowMs;

    const shouldRelieve = next === "critical" && nowMs - this.lastReliefAt >= this.cooldownMs;
    if (shouldRelieve) this.lastReliefAt = nowMs;

    return {
      pressure: next,
      ratio,
      usedMb: Math.round(sample.usedBytes / 1024 / 1024),
      limitMb: Math.round(limit / 1024 / 1024),
      changed,
      shouldReport: changed || criticalReWarn,
      shouldRelieve,
    };
  }

  /** Thresholds rise sharply and fall slowly — see `hysteresis`. */
  private classify(ratio: number): HeapPressure {
    const criticalFloor =
      this.level === "critical" ? this.criticalRatio - this.hysteresis : this.criticalRatio;
    if (ratio >= criticalFloor) return "critical";
    const elevatedFloor =
      this.level === "ok" ? this.elevatedRatio : this.elevatedRatio - this.hysteresis;
    if (ratio >= elevatedFloor) return "elevated";
    return "ok";
  }
}

/**
 * Read this process's heap. `heap_size_limit` is the number V8 actually aborts
 * against (it moves with --max-old-space-size), so the ratio means the same
 * thing on an 8 GB laptop and a 64 GB desktop.
 */
export function readHeapSample(): HeapSample {
  const stats = v8.getHeapStatistics();
  return {
    // used_heap_size undercounts what keeps the process alive; total_heap_size
    // is what V8 has actually committed and is what it measures the limit
    // against. Use the larger of the two so we never under-report pressure.
    usedBytes: Math.max(stats.used_heap_size, stats.total_heap_size),
    limitBytes: stats.heap_size_limit,
  };
}
