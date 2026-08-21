// What Ares actually knows and is doing — assembled for the owner to read.
//
// Why this file exists, precisely:
//
// Ares reported four capabilities as missing — learning from repeated tool
// errors, selective outcome-driven memory, post-timeout verification, and a
// durable mission loop. All four already existed in code. What did NOT exist
// was any way to see them, so a subsystem that had quietly died was
// indistinguishable from one that was never built.
//
// That is not hypothetical. reliabilityTriage — the exact "learn from repeated
// failures" machinery — silently read ZERO files on Windows for three releases
// while the whole suite stayed green, because nothing ever surfaced its output.
// It was not missing. It was dead and invisible.
//
// So this module reads the state that already exists and makes it legible. It
// deliberately introduces no new tracking: every field below is sourced from
// something the engine, verifier, journal or operator was already recording.
// If a section comes back empty, that is a FINDING about that subsystem, not a
// gap in this file — which is the entire point.
//
// Read-only by construction. Assembling a snapshot must never mutate agent
// state, so nothing here writes, and every source is wrapped so a broken
// subsystem degrades to `null` (reported as unavailable) instead of taking the
// command down with it.

import path from "node:path";
import { readdir } from "node:fs/promises";
import { listGoals, loadMissionContract, missionContractSummary } from "@ares/operator";
import type { CodingJournalState } from "@ares/core";
import type { LiveSession } from "../sessionFactory.js";
import type { TriageLivenessRecord } from "../turnPipeline.js";
import { lastMissionRun } from "../missionLiveness.js";

/** One thing Ares is pursuing, and where it has got to. */
export interface MissionWire {
  id: string;
  statement: string;
  status: string;
  /** 0..1 */
  progress: number;
  steps: number;
  /** Mission-contract summary when one exists — what "done" is defined as. */
  contract?: string;
}

/** A check that was actually run, with the proof. */
export interface EvidenceWire {
  label: string;
  command: string;
  /** "pass" | "fail" | "skip" — skipped is NOT a pass, and is never shown as one. */
  verdict: "pass" | "fail" | "skip";
  cached: boolean;
  durationMs: number;
  at: string;
  /** Tail of the real output. Absent when the runner captured none. */
  outputTail?: string;
}

/** A tool failure that has happened more than once, and what came of it. */
export interface FailureWire {
  tool: string;
  signature: string;
  count: number;
  latest: string;
  at: string;
}

export interface RecalledMemoryWire {
  id: string;
  /** Whether this recall was still in play at the end of the turn. */
  used: boolean;
}

/** Per-subsystem liveness. A zero must read as a zero, never as silence. */
export interface LivenessWire {
  subsystem: string;
  /** "live" = ran and produced something; "idle" = ran, produced nothing (may
   *  be legitimate); "dead" = should have run and did not; "unknown" = not
   *  instrumented yet — stated plainly rather than implied to be fine. */
  state: "live" | "idle" | "dead" | "unknown";
  detail: string;
  lastRunAt?: string;
}

export interface CognitiveStateWire {
  sessionId: string;
  at: string;
  /** What I'm pursuing. */
  missions: MissionWire[];
  /** The current objective for THIS session's work, from the coding journal. */
  objective?: string;
  phase?: string;
  /** Mid-task corrections the owner steered in, kept distinct from the objective. */
  steering: string[];
  currentStep?: string;
  todos: Array<{ content: string; status: string }>;
  /** What proves it. */
  evidence: EvidenceWire[];
  /** What I am NOT sure about. */
  uncertainty: string[];
  workStatus?: string;
  /** What I remembered, and whether it survived the turn. */
  recalled: RecalledMemoryWire[];
  /** What went wrong, repeatedly. */
  failures: FailureWire[];
  /** What I retried or worked around. */
  recovery: string[];
  /** What is waiting on the owner. */
  blockedApprovals: Array<{ tool: string; reason: string; at: string }>;
  /** Files this objective touched. */
  touchedFiles: string[];
  /** Is each subsystem actually alive? */
  liveness: LivenessWire[];
}

/** Everything the daemon must hand in; kept explicit so this stays pure-ish. */
export interface CognitiveStateSources {
  live: LiveSession;
  /** Approvals currently parked waiting for the owner. */
  pendingApprovals: ReadonlyArray<{ tool: string; reason?: string; at: number }>;
  /** Last reliability-triage run, if this process has done one. */
  lastTriage?: TriageLivenessRecord | null;
}

/** Why triage did no work, in the owner's language. Each of these is a HEALTHY
 *  state — the point of naming them is so none of them can look like a fault. */
const TRIAGE_SKIP_COPY: Record<"disabled" | "test" | "cadence" | "locked", string> = {
  cadence: "Skipped this turn — it already scanned recently and runs on a cadence, not every turn.",
  disabled: "Turned off (ARES_SELF_TRIAGE=0), so it is not scanning at all.",
  locked: "Another process was already scanning, so this run stood down to avoid clobbering it.",
  test: "Not scanning under test conditions.",
};

const MAX_EVIDENCE = 8;
const MAX_FAILURES = 6;
const MAX_TOUCHED = 20;

/**
 * Build the snapshot. Never throws: each section is independently guarded so
 * one broken subsystem cannot blank the whole cockpit — the owner would then be
 * back to guessing, which is the problem this solves.
 */
export async function assembleCognitiveState(sources: CognitiveStateSources): Promise<CognitiveStateWire> {
  const { live, pendingApprovals, lastTriage } = sources;
  const journal: CodingJournalState | null = safe(() => live.codingJournal?.snapshot() ?? null, null);

  const missions = await safeAsync(async () => {
    const goals = await listGoals(live.context.home);
    const active = goals.filter((g) => g.status === "active").slice(0, 6);
    return Promise.all(
      active.map(async (g): Promise<MissionWire> => {
        // A goal's mission contract is what "done" actually means. Surfacing it
        // is what stops "progress: 0.7" from being a number with no referent.
        const contract = await loadMissionContract(live.context.home, g.id).catch(() => null);
        return {
          id: g.id,
          statement: g.statement.slice(0, 200),
          status: g.status,
          progress: g.progress ?? 0,
          steps: g.stepLog?.length ?? 0,
          contract: contract ? missionContractSummary(contract).slice(0, 240) : undefined,
        };
      }),
    );
  }, [] as MissionWire[]);

  const evidence: EvidenceWire[] = (journal?.checks ?? [])
    .slice(-MAX_EVIDENCE)
    .reverse()
    .map((c) => ({
      label: c.label,
      command: c.command,
      // A skip is reported as a skip. Collapsing skip into pass is exactly how
      // "verified" starts meaning nothing.
      verdict: c.skipped ? "skip" : c.ok ? "pass" : "fail",
      cached: c.cached,
      durationMs: c.durationMs,
      at: c.at,
      outputTail: c.outputTail,
    }));

  const failures: FailureWire[] = (journal?.failures ?? [])
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FAILURES)
    .map((f) => ({ tool: f.tool, signature: f.signature.slice(0, 16), count: f.count, latest: f.latest.slice(0, 300), at: f.at }));

  // Uncertainty is derived from the engine's OWN gates rather than invented, so
  // the panel can never disagree with what the completion gate believed.
  const uncertainty: string[] = [];
  const workStatus = journal?.lastWorkStatus;
  // workStatus is a snapshot taken AT TURN END. The verifier is debounced, so a
  // green run can land a second or two later — leaving the panel asserting
  // "nothing proved this" directly above a PASS row. Both are true of different
  // moments; presenting them as simultaneous reads as self-contradiction and
  // teaches the owner to distrust the panel. So reconcile explicitly.
  const verifierSnapshot = safe(() => live.verifier.evidenceSnapshot(), null);
  const passedSinceTurnEnd =
    workStatus === "unverified" &&
    !!verifierSnapshot?.latestPassedAt &&
    !!journal?.updatedAt &&
    verifierSnapshot.latestPassedAt >= new Date(journal.updatedAt).getTime() - 1_000;
  if (workStatus === "unverified" && !passedSinceTurnEnd) {
    uncertainty.push("The last turn changed things but no check proved them — treat any \"done\" from it as unproven.");
  } else if (passedSinceTurnEnd) {
    uncertainty.push(
      "The turn ended before its checks finished, so it was recorded UNVERIFIED — but a check has passed since. The work is probably sound; the verdict was a timing artifact, not a failure.",
    );
  }
  if (workStatus === "blocked") uncertainty.push("The last turn was blocked before it could finish.");
  if (live.codingJournal?.verificationRequiredForCurrentTurn()) uncertainty.push("This objective still owes a verification run.");
  if (live.codingJournal?.persistedVerificationDebtForCurrentTurn()) uncertainty.push("There is carried-over verification debt from an earlier turn.");
  if (!live.codingJournal?.persistedVerificationScopeCompleteForCurrentTurn()) uncertainty.push("Not every part of the requested scope has been verified.");
  const failedEvidence = evidence.filter((e) => e.verdict === "fail");
  if (failedEvidence.length > 0) uncertainty.push(`${failedEvidence.length} check(s) are currently red: ${failedEvidence.map((e) => e.label).join(", ")}.`);
  const stale = evidence.filter((e) => e.cached);
  if (stale.length > 0) uncertainty.push(`${stale.length} check(s) were reused from cache rather than re-run.`);

  // Recovery: a repeated failure whose count later stopped climbing is the only
  // honest signal available here without new tracking. Reported as observed
  // behaviour, never as a claim that the fix worked.
  const recovery = failures
    .filter((f) => f.count > 1)
    .map((f) => `${f.tool} failed ${f.count}× on the same signature — strategy change was demanded after each.`);

  const todos = (journal?.todos ?? []).slice(0, 12).map((t) => ({ content: t.content, status: t.status }));
  const currentStep = (journal?.todos ?? []).find((t) => t.status === "in_progress")?.activeForm;

  // Read the DURABLE summary, not live.lastRecallIds — that field is consumed
  // and cleared by finishTurn, so reading it post-turn always yielded 0 and made
  // working recall look dead. Mid-turn the raw field is the only thing set, so
  // fall back to it there.
  const recallSummary = live.lastRecallSummary;
  const recalled: RecalledMemoryWire[] = recallSummary
    ? recallSummary.ids.map((id) => ({ id, used: recallSummary.won }))
    : (live.lastRecallIds ?? []).map((id) => ({ id, used: false }));

  return {
    sessionId: live.session.meta.id,
    at: new Date().toISOString(),
    missions,
    objective: journal?.objective,
    phase: journal?.phase,
    steering: (journal?.steering ?? []).slice(-4),
    currentStep,
    todos,
    evidence,
    uncertainty,
    workStatus,
    recalled,
    failures,
    recovery,
    blockedApprovals: pendingApprovals.map((p) => ({
      tool: p.tool,
      reason: p.reason ?? "needs your approval",
      at: new Date(p.at).toISOString(),
    })),
    touchedFiles: (journal?.touchedFiles ?? []).slice(0, MAX_TOUCHED),
    liveness: assembleLiveness({
      journal,
      live,
      lastTriage,
      recalledCount: recalled.length,
      rolloutsOnDisk: await countRollouts(live.context.workspace),
    }),
  };
}

/** How many session rollouts exist for this workspace. Cheap: one readdir. */
async function countRollouts(workspace: string): Promise<number> {
  try {
    const dir = path.join(workspace, ".ares", "sessions");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * Per-subsystem liveness.
 *
 * The distinction that matters is idle-vs-dead. "Ran and found nothing" is
 * often correct; "never ran" almost never is. Collapsing them is what let
 * triage sit dead across three releases, so they are separate states here and
 * every one carries a human-readable reason.
 */
function assembleLiveness(input: {
  journal: CodingJournalState | null;
  live: LiveSession;
  lastTriage?: TriageLivenessRecord | null;
  recalledCount: number;
  /** Rollout files present under <workspace>/.ares/sessions — the denominator
   *  that tells "nothing to read" apart from "cannot read what is there". */
  rolloutsOnDisk: number;
}): LivenessWire[] {
  const { journal, live, lastTriage, recalledCount, rolloutsOnDisk } = input;
  const out: LivenessWire[] = [];

  // Coding journal — durable working state.
  out.push(
    journal
      ? {
          subsystem: "Working state (journal)",
          state: journal.turns > 0 ? "live" : "idle",
          detail: journal.turns > 0
            ? `${journal.turns} turn(s) recorded · ${journal.checks.length} check(s) · ${journal.failures.length} failure signature(s)`
            : "Open, nothing recorded yet this session.",
          lastRunAt: journal.updatedAt,
        }
      : { subsystem: "Working state (journal)", state: "dead", detail: "No journal is open for this session — durable working state is NOT being kept." },
  );

  // Verifier — the evidence source.
  const ev = safe(() => live.verifier.evidenceSnapshot(), null);
  out.push(
    ev
      ? {
          subsystem: "Continuous verification",
          state: ev.finishedCommands > 0 ? "live" : ev.scheduledRuns > 0 ? "idle" : "idle",
          detail: ev.finishedCommands > 0
            ? `${ev.passedCommands} passed / ${ev.failedCommands} failed / ${ev.skippedCommands} skipped · latest: ${ev.latestRunStatus ?? "n/a"}${ev.latestRunStrength ? ` (${ev.latestRunStrength})` : ""}`
            : ev.scheduledRuns > 0
              ? `${ev.scheduledRuns} run(s) scheduled, none finished yet.`
              : "Nothing scheduled — no files have changed this session.",
          lastRunAt: ev.latestFinishedAt ? new Date(ev.latestFinishedAt).toISOString() : undefined,
        }
      : { subsystem: "Continuous verification", state: "dead", detail: "The verifier did not answer — evidence is NOT being collected." },
  );

  // Memory recall. The three-way split matters: a turn that recalled nothing is
  // different from a turn that never asked, and both are different from recall
  // being broken. Only the durable summary can tell them apart.
  const summary = live.lastRecallSummary;
  out.push({
    subsystem: "Memory recall",
    state: !summary ? "unknown" : recalledCount > 0 ? "live" : "idle",
    detail: !summary
      ? "No turn has completed yet in this session, so recall has not been exercised."
      : recalledCount > 0
        ? `${recalledCount} memory node(s) injected into the last turn, then ${summary.won ? "REINFORCED" : "weakened"} by its outcome.`
        : "Recall ran for the last turn and selected nothing. Legitimate when the message needs no history — suspicious if it never changes.",
    lastRunAt: summary ? new Date(summary.at).toISOString() : undefined,
  });

  // Reliability triage. Reading zero files is the v0.29-0.30 Windows failure
  // mode — but ONLY if there were files to read. A fresh workspace has no
  // rollouts yet, and calling that "dead" is the same idle-vs-dead conflation
  // this panel exists to kill, just pointed the other way. `rolloutsOnDisk`
  // decides between them instead of guessing.
  out.push(
    lastTriage
      ? {
          subsystem: "Reliability triage",
          // Order matters: a DELIBERATE skip is checked before any zero-coverage
          // inference. Triage returns an empty run when throttled by cadence,
          // disabled, or lock-contended, and reading that as death is a false
          // alarm that trains the owner to ignore this row.
          state: lastTriage.skipped
            ? "idle"
            : lastTriage.files > 0
              ? (lastTriage.observations > 0 ? "live" : "idle")
              : rolloutsOnDisk > 0
                ? "dead"
                : "idle",
          detail: lastTriage.skipped
            ? TRIAGE_SKIP_COPY[lastTriage.skipped]
            : lastTriage.files > 0
              ? `${lastTriage.files} file(s) · ${lastTriage.observations} observation(s) · ${lastTriage.candidates} candidate(s).`
              : rolloutsOnDisk > 0
                ? `Ran but read ZERO of the ${rolloutsOnDisk} rollout(s) on disk — it is finding nothing because it cannot see them (the v0.29-0.30 Windows failure mode).`
                : "Ran with no rollouts on disk yet — nothing to learn from so far, which is expected in a fresh workspace.",
          lastRunAt: new Date(lastTriage.at).toISOString(),
        }
      : { subsystem: "Reliability triage", state: "unknown", detail: "Has not run in this process yet." },
  );

  // Mission loop. Now recorded at the call sites, so this can distinguish
  // "never invoked in this process" from "ran and stalled" — and an exhausted
  // tick budget from a clean finish, which otherwise both read as a quiet stop.
  const mission = lastMissionRun();
  out.push(
    mission.last
      ? {
          subsystem: "Mission loop",
          state: mission.last.error ? "dead" : mission.last.steps > 0 ? "live" : "idle",
          detail: mission.last.error
            ? `Last run THREW: ${mission.last.error.slice(0, 160)}`
            : `${mission.runs} run(s) this process · last: goal ${mission.last.goalId} → ${mission.last.status}, ${mission.last.steps} step(s), ${Math.round(mission.last.progress * 100)}%${
                mission.last.maxTicks && mission.last.steps >= mission.last.maxTicks
                  ? ` — stopped at its ${mission.last.maxTicks}-tick ceiling, not because it was finished`
                  : ""
              }.`,
          lastRunAt: new Date(mission.last.at).toISOString(),
        }
      : {
          subsystem: "Mission loop",
          state: "idle",
          detail: "Has not been invoked in this process. Reachable via the Operator tool.",
        },
  );

  return out;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
