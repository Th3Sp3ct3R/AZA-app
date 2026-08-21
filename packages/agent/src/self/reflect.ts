// Reflection — the growth engine's brain. Pure logic over the self-model:
// given what Ares is and how reliably it performs, what should it *do* about
// itself? This is the upgrade from regex/threshold "dreaming" to real,
// outcome-grounded self-direction. It emits concrete, actionable directives;
// the agent (or heartbeat/dream) decides whether to act on them.

import type { ReflectionResult, ReflectionSurface } from "@ares/mind";
import type { Capability, SelfModel } from "./types.js";
import { reliabilityOf } from "./types.js";

export type DirectiveKind = "fix" | "acquire" | "prune";

export interface SelfDirective {
  kind: DirectiveKind;
  capabilityId: string;
  capabilityName: string;
  reason: string;
  suggestion: string;
  severity: number;
}

export interface ReflectOptions {
  minRuns?: number; // decided runs required before judging a skill
  failThreshold?: number; // fail rate at/above which a skill needs a fix
  staleDays?: number; // unused-for-this-long => candidate to prune
  now?: Date;
}

const DEFAULTS = { minRuns: 3, failThreshold: 0.5, staleDays: 45 };

export function reflect(model: SelfModel, opts: ReflectOptions = {}): SelfDirective[] {
  const minRuns = opts.minRuns ?? DEFAULTS.minRuns;
  const failThreshold = opts.failThreshold ?? DEFAULTS.failThreshold;
  const staleDays = opts.staleDays ?? DEFAULTS.staleDays;
  const now = opts.now ?? new Date();

  const directives: SelfDirective[] = [];

  for (const cap of Object.values(model.capabilities)) {
    if (cap.status === "removed") continue;

    // Outcomes are stronger evidence than the lifecycle label. In particular,
    // a capability created by a failed first attempt is correctly left in
    // `acquiring`; once repeated attempts prove that it never works, reflection
    // must diagnose/prune it instead of masking the failure as a generic
    // acquisition request forever.
    const decided = cap.outcomes.ok + cap.outcomes.fail;
    const rel = reliabilityOf(cap.outcomes);

    if (decided >= minRuns && cap.outcomes.ok === 0) {
      directives.push(pruneAlwaysFail(cap, decided));
      continue;
    }

    if (cap.status === "want" || cap.status === "acquiring") {
      directives.push(acquireDirective(cap));
      continue;
    }

    if (decided >= minRuns && rel !== null && rel <= 1 - failThreshold) {
      directives.push(fixDirective(cap, rel, decided));
      continue;
    }

    const stale = staleAgeDays(cap, now);
    if (stale !== null && stale >= staleDays && decided === 0) {
      directives.push(pruneStale(cap, stale));
    }
  }

  return directives.sort((a, b) => b.severity - a.severity);
}

/** This pass as a {@link ReflectionSurface}: same reflect(), uniform envelope. It
 *  only advises (the caller — dream/heartbeat — decides whether to act), so it
 *  persists nothing. */
export const selfModelReflectionSurface: ReflectionSurface<{ model: SelfModel; opts?: ReflectOptions }> = {
  name: "self-model",
  run({ model, opts }): ReflectionResult {
    const directives = reflect(model, opts ?? {});
    return { directives: directives.map((d) => `[${d.kind}] ${d.capabilityName}: ${d.reason}`) };
  },
};

function acquireDirective(cap: Capability): SelfDirective {
  return {
    kind: "acquire",
    capabilityId: cap.id,
    capabilityName: cap.name,
    reason: `'${cap.name}' is marked ${cap.status} — you flagged it as something you need but don't yet have.`,
    suggestion:
      "Acquire it: try existing tools/CLI first, then a package, then craft a skill with SkillCraft and run it with RunSkill. Update its status to 'have' once it works.",
    severity: 40,
  };
}

function pruneAlwaysFail(cap: Capability, decided: number): SelfDirective {
  return {
    kind: "prune",
    capabilityId: cap.id,
    capabilityName: cap.name,
    reason: `'${cap.name}' has never succeeded (${decided} attempt(s), 0 ok).${cap.outcomes.lastError ? ` Last error: ${cap.outcomes.lastError}` : ""}`,
    suggestion:
      "Rebuild it from scratch or retire it. If it's a skill, rewrite handler.js via SkillCraft update and re-run, or remove it if it's not worth keeping.",
    // Always-fail dominates flaky-but-sometimes-works (fix tops out ~150).
    severity: 200 + decided,
  };
}

function fixDirective(cap: Capability, rel: number, decided: number): SelfDirective {
  const failPct = Math.round((1 - rel) * 100);
  return {
    kind: "fix",
    capabilityId: cap.id,
    capabilityName: cap.name,
    reason: `'${cap.name}' is failing ${failPct}% of the time over ${decided} run(s).${cap.outcomes.lastError ? ` Last error: ${cap.outcomes.lastError}` : ""}`,
    suggestion:
      "Diagnose the recurring failure and repair it. If it's a skill, SkillCraft update the handler, then RunSkill to confirm the fix lands.",
    severity: 50 + failPct,
  };
}

function pruneStale(cap: Capability, ageDays: number): SelfDirective {
  return {
    kind: "prune",
    capabilityId: cap.id,
    capabilityName: cap.name,
    reason: `'${cap.name}' hasn't been used in ${ageDays} day(s) and has no recorded outcomes.`,
    suggestion: "Review whether it's still worth keeping. Exercise it once to prove it works, or remove it to keep your self-model honest.",
    severity: 10,
  };
}

function staleAgeDays(cap: Capability, now: Date): number | null {
  const ref = cap.outcomes.lastUsedAt ?? cap.updatedAt;
  const t = Date.parse(ref);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}
