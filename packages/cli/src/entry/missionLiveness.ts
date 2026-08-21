// Did the mission loop actually run?
//
// The cockpit reported "Mission loop: unknown — not yet instrumented" because
// nothing recorded whether runGoalToCompletion was ever invoked. That is the
// same gap that let reliabilityTriage sit dead across three releases: an
// uninstrumented subsystem and a broken one look identical from outside, so the
// honest report was "I cannot tell you".
//
// This is the smallest thing that closes it: a process-local record of the last
// run, written by the call sites. Deliberately not persisted — the question the
// panel answers is "is this working NOW", and a stale record from last week
// would be worse than an honest "hasn't run in this process".

export interface MissionRunRecord {
  at: number;
  goalId: string;
  /** Terminal status the loop returned the goal in. */
  status: string;
  /** 0..1 as reported by the goal. */
  progress: number;
  /** Steps logged on the goal when the loop returned. */
  steps: number;
  /** Ceiling the caller allowed, so an exhausted budget is visible rather than
   *  looking like a clean stop. */
  maxTicks?: number;
  durationMs: number;
  /** Set when the loop threw — a crash must never read as a quiet success. */
  error?: string;
}

let last: MissionRunRecord | null = null;
let runs = 0;

export function recordMissionRun(record: MissionRunRecord): void {
  last = record;
  runs++;
}

export function lastMissionRun(): { last: MissionRunRecord | null; runs: number } {
  return { last, runs };
}

/**
 * Wrap a mission-loop invocation so its outcome is always recorded — including
 * when it throws. A try/finally at each call site would drift; one helper does
 * not.
 */
export async function withMissionRunRecorded<T extends { id: string; status: string; progress?: number; stepLog?: unknown[] }>(
  goalId: string,
  maxTicks: number | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const goal = await run();
    recordMissionRun({
      at: Date.now(),
      goalId,
      status: goal.status,
      progress: goal.progress ?? 0,
      steps: goal.stepLog?.length ?? 0,
      maxTicks,
      durationMs: Date.now() - started,
    });
    return goal;
  } catch (err) {
    recordMissionRun({
      at: Date.now(),
      goalId,
      status: "threw",
      progress: 0,
      steps: 0,
      maxTicks,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
