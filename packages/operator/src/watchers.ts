// Condition watchers — Ares notices, then PROPOSES. Initiative v2.
//
// A watcher binds a reality probe (the same VerificationSpec vocabulary goals
// use) to a proposal. On each background tick the loop checks the DUE watchers;
// when one's condition trips (build red, endpoint down, file gone), it
// materializes a PLANNING-ONLY goal — "investigate and propose for the owner's
// approval". An execute-mode watcher may instead materialize an EXECUTION goal,
// but only through a LIVE consent gate (the garrison approval queue): the owner
// answers per-trip, and any deny/timeout/absent gate degrades to plan-only.
// Either way the unattended policy gate stays the wall underneath — consent
// widens what the goal may be, never what the worker's tools may do.
//
// Re-fire discipline (what keeps this from being a nag):
//   - fingerprint dedupe: a failing build that keeps failing the SAME way never
//     re-proposes; when the fingerprint changes (new error), it may.
//   - recovery re-arms: when the condition clears, the fingerprint resets, so
//     the next breakage fires fresh.
//   - one proposal in flight: while the last proposal goal is still active, the
//     watcher stays quiet.
//
// One JSON file per watcher under ~/.ares/operator/watchers/. Atomic writes,
// tolerant reads — same resume-safe discipline as goals and standing orders.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "@ares/agent";
import { operatorPaths } from "./paths.js";
import { createGoal } from "./goal.js";
import { newGoalId, saveGoal, loadGoal } from "./store.js";
import { runProbe } from "./probe.js";
import type { Goal, VerificationSpec } from "./types.js";

export const WATCHER_SCHEMA = 1;
/** Probes can spawn processes — one minute is the floor between checks. */
export const MIN_WATCHER_CADENCE_MS = 60_000;
/** Bound one tick's probe work; the rest wait for the next tick (cheapest-starved-first). */
export const MAX_PROBES_PER_TICK = 5;

export interface Watcher {
  schemaVersion: number;
  id: string;
  /** Short human name, e.g. "build failing" — used in reports and the proposal. */
  label: string;
  /** The reality probe. Same serializable vocabulary as goal verification. */
  condition: VerificationSpec;
  /** Fire when the probe is red ("unmet", the default) or green ("met"). */
  fireWhen: "met" | "unmet";
  /** What to investigate/propose when it fires. Becomes a planning-only goal. */
  proposal: string;
  /**
   * "plan" (default): a trip materializes a plan-only proposal — today's whole
   * behavior. "execute": a trip may materialize an EXECUTION goal, but ONLY
   * through a live consent gate — no gate wired, or the owner denies, and it
   * falls back to plan-only. Consent widens what the goal may be, never what
   * the worker's tools may do: the unattended policy gate stays underneath.
   */
  mode?: "plan" | "execute";
  /**
   * Event kinds (e.g. "turn_settled") that mark this watcher due IMMEDIATELY
   * on a matching wake, instead of waiting out its cadence. Still floored by
   * MIN_WATCHER_CADENCE_MS between probes — a wake storm must not become a
   * probe storm.
   */
  wakeOn?: string[];
  /** How often to CHECK the condition. Clamped to >= MIN_WATCHER_CADENCE_MS. */
  cadenceMs: number;
  enabled: boolean;
  createdAt: string;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  /** The fingerprint of the state we already proposed about — the dedupe key. */
  lastFingerprint?: string;
  /** The last proposal goal — while it's still active, the watcher stays quiet. */
  lastGoalId?: string;
  fireCount: number;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function watcherFile(home: string | undefined, id: string): string {
  return path.join(operatorPaths(home).watchersDir, `${sanitizeId(id)}.json`);
}

export function newWatcherId(now = new Date()): string {
  return `w_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;
}

export function normalizeWatcher(
  input: Partial<Watcher> & { label: string; condition: VerificationSpec; proposal: string },
  now = new Date(),
): Watcher {
  return {
    schemaVersion: WATCHER_SCHEMA,
    id: input.id ?? newWatcherId(now),
    label: input.label.trim(),
    condition: input.condition,
    fireWhen: input.fireWhen ?? "unmet",
    proposal: input.proposal.trim(),
    mode: input.mode === "execute" ? "execute" : "plan",
    wakeOn: Array.isArray(input.wakeOn)
      ? input.wakeOn.filter((k): k is string => typeof k === "string" && k.trim().length > 0).slice(0, 16)
      : undefined,
    cadenceMs: Math.max(MIN_WATCHER_CADENCE_MS, Math.floor(input.cadenceMs ?? 15 * 60_000)),
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? now.toISOString(),
    lastCheckedAt: input.lastCheckedAt,
    lastFiredAt: input.lastFiredAt,
    lastFingerprint: input.lastFingerprint,
    lastGoalId: input.lastGoalId,
    fireCount: input.fireCount ?? 0,
  };
}

export async function saveWatcher(home: string | undefined, watcher: Watcher): Promise<string> {
  const file = watcherFile(home, watcher.id);
  await writeFileAtomic(file, JSON.stringify(watcher, null, 2) + "\n");
  return file;
}

export async function loadWatchers(home?: string): Promise<Watcher[]> {
  const dir = operatorPaths(home).watchersDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const watchers: Watcher[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      watchers.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Watcher);
    } catch {
      // skip a corrupt watcher file
    }
  }
  return watchers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function addWatcher(
  home: string | undefined,
  input: {
    label: string;
    condition: VerificationSpec;
    proposal: string;
    cadenceMs?: number;
    fireWhen?: "met" | "unmet";
    mode?: "plan" | "execute";
    wakeOn?: string[];
  },
  now = new Date(),
): Promise<Watcher> {
  const watcher = normalizeWatcher(input, now);
  if (!watcher.label) throw new Error("a watcher needs a label");
  if (!watcher.proposal) throw new Error("a watcher needs a proposal — what should Ares plan when it fires?");
  await saveWatcher(home, watcher);
  return watcher;
}

export async function removeWatcher(home: string | undefined, id: string): Promise<boolean> {
  try {
    await fs.unlink(watcherFile(home, id));
    return true;
  } catch {
    return false;
  }
}

export async function setWatcherEnabled(home: string | undefined, id: string, enabled: boolean): Promise<boolean> {
  const watchers = await loadWatchers(home);
  const watcher = watchers.find((w) => w.id === id);
  if (!watcher) return false;
  watcher.enabled = enabled;
  await saveWatcher(home, watcher);
  return true;
}

/** The watchers due for a CHECK: enabled, and never checked or past cadence. */
export function dueWatchers(watchers: readonly Watcher[], now: Date): Watcher[] {
  const t = now.getTime();
  return watchers
    .filter((w) => {
      if (!w.enabled) return false;
      if (!w.lastCheckedAt) return true;
      return t - Date.parse(w.lastCheckedAt) >= w.cadenceMs;
    })
    .sort((a, b) => Date.parse(a.lastCheckedAt ?? "1970") - Date.parse(b.lastCheckedAt ?? "1970"));
}

export interface FiredWatcher {
  watcher: Watcher;
  goalId: string;
  /** The probe's account of why it fired — for reports. */
  summary: string;
}

export interface CheckWatchersResult {
  /** Watchers whose probes actually ran this tick. */
  checked: number;
  goals: Goal[];
  fired: FiredWatcher[];
}

/** What the consent gate is asked when an execute-mode watcher trips. */
export interface WatcherExecutionRequest {
  watcherId: string;
  label: string;
  proposal: string;
  /** The condition state this consent covers — same key as the dedupe. */
  fingerprint: string;
  summary: string;
}

export interface CheckWatchersContext {
  workspace?: string;
  signal?: AbortSignal;
  /**
   * The live consent gate for execute-mode watchers. Resolving "allow_once"
   * materializes an execution goal; anything else — deny, timeout, throw, or
   * simply no gate wired (the daemon today) — falls back to plan-only.
   */
  requestExecution?: (request: WatcherExecutionRequest) => Promise<"allow_once" | "allow_always" | "deny">;
  /** The wake events this tick drained — routes wakeOn watchers to "due now". */
  wokenBy?: readonly unknown[];
}

/** Event kinds present in a drained wake payload ({ kind: string } shaped). */
function wakeKinds(events: readonly unknown[] | undefined): Set<string> {
  const kinds = new Set<string>();
  for (const event of events ?? []) {
    if (event && typeof event === "object" && typeof (event as { kind?: unknown }).kind === "string") {
      kinds.add((event as { kind: string }).kind);
    }
  }
  return kinds;
}

/**
 * Watchers made due by a matching wake event: enabled, subscribed to one of the
 * drained kinds, and past the probe floor. This is what turns the queue from a
 * counted-and-discarded payload into routing — a watcher on "turn_settled"
 * probes seconds after the turn, not up to 30 minutes later.
 */
export function wakeMatchedWatchers(
  watchers: readonly Watcher[],
  events: readonly unknown[] | undefined,
  now: Date,
): Watcher[] {
  const kinds = wakeKinds(events);
  if (kinds.size === 0) return [];
  const t = now.getTime();
  return watchers.filter((w) => {
    if (!w.enabled || !w.wakeOn?.some((k) => kinds.has(k))) return false;
    if (!w.lastCheckedAt) return true;
    return t - Date.parse(w.lastCheckedAt) >= MIN_WATCHER_CADENCE_MS;
  });
}

/**
 * Probe every DUE watcher (bounded per tick) and materialize a PLANNING-ONLY
 * proposal goal for each newly-tripped condition. Stamps check/fire state so a
 * stuck-red condition proposes once, not every tick. Never throws — a probe
 * error reads as "condition unmet" via the probe's own error summary.
 */
export async function checkWatchers(
  home: string | undefined,
  ctx: CheckWatchersContext = {},
  now = new Date(),
): Promise<CheckWatchersResult> {
  const resolvedHome = operatorPaths(home).home;
  const all = await loadWatchers(home);
  // Wake-matched watchers jump the cadence queue; cadence-due fill the rest.
  const merged = new Map<string, Watcher>();
  for (const w of wakeMatchedWatchers(all, ctx.wokenBy, now)) merged.set(w.id, w);
  for (const w of dueWatchers(all, now)) if (!merged.has(w.id)) merged.set(w.id, w);
  const due = [...merged.values()].slice(0, MAX_PROBES_PER_TICK);
  const goals: Goal[] = [];
  const fired: FiredWatcher[] = [];
  for (const watcher of due) {
    const probe = await runProbe(watcher.condition, { workspace: ctx.workspace, signal: ctx.signal });
    watcher.lastCheckedAt = now.toISOString();
    const triggered = watcher.fireWhen === "met" ? probe.met : !probe.met;
    if (!triggered) {
      // Recovery re-arms: the next breakage is a NEW event, not a dupe.
      watcher.lastFingerprint = undefined;
      await saveWatcher(home, watcher);
      continue;
    }
    const fingerprint = probe.fingerprint ?? probe.summary;
    const sameProposal = watcher.lastFingerprint !== undefined && watcher.lastFingerprint === fingerprint;
    const inFlight = watcher.lastGoalId ? (await loadGoal(resolvedHome, watcher.lastGoalId))?.status === "active" : false;
    if (sameProposal || inFlight) {
      await saveWatcher(home, watcher);
      continue;
    }
    // Execute-mode watchers ask the LIVE consent gate; everything else — plan
    // mode, no gate wired, a deny, a timeout, a gate crash — is plan-only.
    // The consented statement drops the plan-only prefix; the per-tool
    // unattended policy gate underneath is untouched either way.
    let consented = false;
    if (watcher.mode === "execute" && ctx.requestExecution) {
      try {
        const verdict = await ctx.requestExecution({
          watcherId: watcher.id,
          label: watcher.label,
          proposal: watcher.proposal,
          fingerprint,
          summary: probe.summary,
        });
        consented = verdict === "allow_once" || verdict === "allow_always";
      } catch {
        // an unreachable gate can only ever narrow to plan-only, never widen
      }
    }
    const goal = createGoal({
      id: newGoalId(now),
      statement: consented
        ? `Execute — the owner approved this action: ${watcher.proposal} ` +
          `(watcher "${watcher.label}" tripped: ${probe.summary})`
        : `Plan ONLY — do NOT execute. Investigate and propose changes for the owner's approval: ` +
          `${watcher.proposal} (watcher "${watcher.label}" tripped: ${probe.summary})`,
      mode: consented ? "execute" : "plan",
      consent: consented ? { approvalId: `${watcher.id}:${fingerprint}`, at: now.toISOString() } : undefined,
      now,
    });
    await saveGoal(resolvedHome, goal);
    watcher.lastFiredAt = now.toISOString();
    watcher.lastFingerprint = fingerprint;
    watcher.lastGoalId = goal.id;
    watcher.fireCount = (watcher.fireCount ?? 0) + 1;
    await saveWatcher(home, watcher);
    goals.push(goal);
    fired.push({ watcher, goalId: goal.id, summary: probe.summary });
  }
  return { checked: due.length, goals, fired };
}

/** Human-readable list for Telegram/CLI. */
export function renderWatchers(watchers: readonly Watcher[]): string {
  if (watchers.length === 0) return "No watchers. Add one and Ares keeps an eye on it, proposing — never acting — when it trips.";
  return watchers
    .map((w) => {
      const mins = Math.round(w.cadenceMs / 60_000);
      const cadence = mins >= 60 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h` : `${mins}m`;
      const fired = w.lastFiredAt ? `last fired ${new Date(w.lastFiredAt).toLocaleString()}` : "never fired";
      return `${w.enabled ? "👁" : "⚪"} ${w.id} · ${w.label} · every ${cadence} · ${fired} (${w.fireCount}×)\n   ${w.proposal}`;
    })
    .join("\n");
}
