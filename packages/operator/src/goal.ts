// Pure goal-state transitions — no I/O (mirrors agent/mission/loop.ts).
//
// Every function takes a Goal and returns a new Goal, so the store can persist
// and observers can diff. This is where the control-loop rules live as pure
// logic: a step that moves the gap resets the divergence streak; a run of
// no-progress steps trips divergence and blocks the goal for escalation.

import type { Goal, GoalStatus, GoalStepRecord, StepVerdict, VerificationSpec } from "./types.js";

const DEFAULT_MAX_NO_PROGRESS = 3;

// How many recent world fingerprints to remember for oscillation detection, and
// how many times a single state may recur within that window before we call it a
// cycle. A genuine convergence visits each intermediate state at most once; an
// A/B/A/B shuffler revisits the same handful of states over and over.
const FINGERPRINT_HISTORY = 6;
const OSCILLATION_RECURRENCE = 3;

export function createGoal(input: {
  id: string;
  statement: string;
  missionIds?: string[];
  maxNoProgress?: number;
  verification?: VerificationSpec;
  mode?: Goal["mode"];
  consent?: Goal["consent"];
  now?: Date;
}): Goal {
  const at = (input.now ?? new Date()).toISOString();
  const statement = input.statement.trim();
  if (!statement) throw new Error("createGoal requires a non-empty statement");
  return {
    id: input.id,
    statement,
    status: "active",
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.consent ? { consent: input.consent } : {}),
    missionIds: input.missionIds ?? [],
    progress: 0,
    noProgressStreak: 0,
    maxNoProgress: clampThreshold(input.maxNoProgress),
    verification: input.verification,
    stepLog: [],
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Mark a goal done because REALITY already satisfies it — no step required.
 * Used by the control loop's SENSE phase when a goal's probe is already green.
 */
export function completeGoal(goal: Goal, evidence: string, now = new Date()): Goal {
  if (goal.status !== "active") return goal;
  return { ...goal, status: "done", verdict: evidence.trim() || "goal met", inFlightStep: undefined, updatedAt: now.toISOString() };
}

export function isActive(goal: Goal): boolean {
  return goal.status === "active";
}

export function isTerminal(goal: Goal): boolean {
  return goal.status === "done" || goal.status === "abandoned";
}

/** The index the next dispatched step will occupy. Derived from durable state. */
export function nextStepIndex(goal: Goal): number {
  return goal.stepLog.length;
}

/**
 * Mark a step in-flight before ACT. Persisting this means a crash between ACT
 * and the verdict is visible on resume (O2 hardens this into idempotency keys).
 */
export function markInFlight(goal: Goal, now = new Date()): Goal {
  if (goal.status !== "active") return goal;
  return { ...goal, inFlightStep: goal.stepLog.length, updatedAt: now.toISOString() };
}

/**
 * Apply a Worker's verdict — the VERIFY/LEARN transition. Appends the step to
 * the durable log, advances progress, and resolves status:
 *   goalMet            → done
 *   moved              → keep going, streak reset
 *   no progress × N    → blocked (diverged; escalate rather than thrash)
 *   world oscillates   → blocked (the gap "moves" but only cycles A/B/A/B)
 *
 * `fingerprint` is the post-act world fingerprint (when the loop has one). It
 * feeds the oscillation ring: a Worker that shuffles the world every tick keeps
 * `moved=true` and so never trips the no-progress streak, but it only ever
 * revisits a small set of states. Catching that cycle blocks the goal for
 * escalation instead of letting it thrash to the tick ceiling.
 */
export function applyVerdict(goal: Goal, verdict: StepVerdict, now = new Date(), fingerprint?: string): Goal {
  if (goal.status !== "active") return goal;
  const at = now.toISOString();
  const index = goal.stepLog.length;
  const record: GoalStepRecord = {
    index,
    at,
    moved: verdict.moved,
    goalMet: verdict.goalMet,
    unverified: verdict.unverified || undefined,
    workStatus: verdict.workStatus,
    evidence: verdict.evidence?.trim() || undefined,
    prediction: verdict.prediction,
  };
  const stepLog = [...goal.stepLog, record];
  const progress = goal.progress + (verdict.moved ? 1 : 0);
  const noProgressStreak = verdict.moved ? 0 : goal.noProgressStreak + 1;

  // Roll the fingerprint ring forward, but only when the step claimed to move —
  // a no-progress step is already caught by the streak and shouldn't pollute the
  // cycle history (an unchanged fingerprint isn't oscillation).
  const recentFingerprints =
    verdict.moved && fingerprint !== undefined
      ? [...(goal.recentFingerprints ?? []), fingerprint].slice(-FINGERPRINT_HISTORY)
      : goal.recentFingerprints;

  let status: GoalStatus = "active";
  let verdictText = goal.verdict;
  if (verdict.goalMet) {
    status = "done";
    verdictText = record.evidence ?? "goal met";
    if (verdict.unverified) verdictText = `${verdictText} (unverified — no reality probe could corroborate)`;
  } else if (noProgressStreak >= goal.maxNoProgress) {
    status = "blocked";
    verdictText = `diverged: ${noProgressStreak} step(s) made no progress${record.evidence ? ` — ${record.evidence}` : ""}`;
  } else if (isOscillating(recentFingerprints)) {
    status = "blocked";
    verdictText = `diverged: world oscillated between ${new Set(recentFingerprints).size} states without converging${record.evidence ? ` — ${record.evidence}` : ""}`;
  }

  return {
    ...goal,
    stepLog,
    progress,
    noProgressStreak,
    recentFingerprints,
    status,
    verdict: verdictText,
    inFlightStep: undefined,
    updatedAt: at,
  };
}

/**
 * An A/B/A/B world: the fingerprint keeps changing (so `moved` stays true), but
 * it only ever revisits a small set of states. We call it a cycle once some state
 * recurs OSCILLATION_RECURRENCE times within the recent window AND the window has
 * stopped introducing new states (distinct states ≤ half the window). Genuine
 * convergence visits each intermediate state at most once, so it never trips this.
 */
function isOscillating(history: string[] | undefined): boolean {
  if (!history || history.length < FINGERPRINT_HISTORY) return false;
  const counts = new Map<string, number>();
  for (const fp of history) counts.set(fp, (counts.get(fp) ?? 0) + 1);
  const distinct = counts.size;
  const maxRecurrence = Math.max(...counts.values());
  return maxRecurrence >= OSCILLATION_RECURRENCE && distinct <= Math.floor(history.length / 2);
}

export function abandonGoal(goal: Goal, reason: string, now = new Date()): Goal {
  if (isTerminal(goal)) return goal;
  return { ...goal, status: "abandoned", verdict: reason.trim() || "manual stop", inFlightStep: undefined, updatedAt: now.toISOString() };
}

function clampThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_NO_PROGRESS;
  return Math.min(50, Math.max(1, Math.floor(value)));
}
