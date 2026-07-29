// Conductor.ts — the model-facing shell over the deterministic runFleet runtime.
//
// The Ares agent AUTHORS a flat FleetSpec (the hardest element it faces is a
// shape-EXAMPLE object, not a JSON-Schema) and the runtime executes it
// start-to-finish. All the stateful failure modes — concurrency caps, abort
// cascade, schema retry, budget abort, pipeline barrier, journaling — live in
// runFleet, which the model never touches. Robust on ANY provider because every
// leaf inherits the parent's provider/model via runForkedTurn.
//
// This file owns the zod binding (the @ares/core runtime is deliberately
// zod-free). The schema seam is derived from a shape-EXAMPLE object so weak
// models can express "I want {summary:'...', score: 0}" without authoring a JSON
// Schema.

import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { mkdir, rm, cp, readdir } from "node:fs/promises";
import type { EngineTool, Provider } from "@ares/core";
import {
  runFleet,
  type ConductorDeps,
  type FleetSpec,
  type LeafValidator,
  type SchemaHinter,
  type ValidatorResult,
  type Worktree,
} from "@ares/core";
import { buildTool } from "./_shared.js";

/** All file paths under `dir`, relative to it (for the worktree merge). */
async function walkRelFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkRelFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

/** A copy-based isolation sandbox: an EMPTY temp dir a parallel build leaf writes
 *  its (new) files into. The runtime detects cross-leaf file overlap and merges
 *  the disjoint files back into the real workspace. No git dependency. */
async function makeCopyWorktree(label: string): Promise<Worktree> {
  const safe = label.replace(/[^a-zA-Z0-9-]/g, "_");
  const dir = path.join(os.tmpdir(), "ares-fleet-wt", `${Date.now().toString(36)}-${safe}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    changedFiles: () => walkRelFiles(dir),
    // Collect a per-file inventory instead of throwing on the first failed copy:
    // a mid-loop EACCES/ENOSPC/locked file would otherwise leave the workspace
    // half-merged AND let the exception escape runWorktreePhase (its try has only a
    // finally) — the phase never gets recorded and the model gets a stale summary
    // over a corrupted workspace. The caller turns {applied,failed} into an honest
    // failureReason listing exactly what was written vs failed (merge-honesty).
    applyTo: async (mainWorkspace: string) => {
      const applied: string[] = [];
      const failed: { rel: string; err: string }[] = [];
      for (const rel of await walkRelFiles(dir)) {
        try {
          const dest = path.join(mainWorkspace, rel);
          await mkdir(path.dirname(dest), { recursive: true });
          await cp(path.join(dir, rel), dest);
          applied.push(rel);
        } catch (e) {
          failed.push({ rel, err: e instanceof Error ? e.message : String(e) });
        }
      }
      return { applied, failed };
    },
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}

export interface ConductorToolDeps {
  provider: Provider;
  model: string;
  /** The parent catalog children are scoped from. MUST exclude the Conductor
   *  itself (and Task/Operator) to block recursive fleets — runFleet also rejects
   *  any whitelist naming those, but keep them out of the catalog too. */
  parentTools: readonly EngineTool[];
  baseSystemPrompt: string;
  subModel?: { summarize(req: { input: string; instructions?: string }): Promise<string> };
  defaultMaxTurns?: number;
  /** Unattended posture (default): non-read-only tools are stripped from each
   *  leaf's catalog so a child can't deny-loop on a human-gated tool. Set true
   *  only when the host arranged non-interactive auto-approve for writers. */
  allowWriteTools?: boolean;
  /** Policy-aware leaf permission (the owner's "fleets inherit my permissions"
   *  toggle). Forwarded to runFleet; absent → leaves deny everything. */
  leafRequestPermission?: ConductorDeps["leafRequestPermission"];
}

// ─── Shape-example → validator + hint ──────────────────────────────────────
//
// A shape-example is a plain object whose VALUES illustrate the expected types:
//   { "summary": "a one-line gist", "score": 0, "risks": ["..."] }
// We validate a candidate by structural type-match per key (string/number/
// boolean/array/object), tolerating extra keys (weak models add noise) and
// requiring every example key to be present with a type-compatible value.

type JsonType = "string" | "number" | "boolean" | "array" | "object" | "null";

function typeOfValue(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t as JsonType;
  return "string";
}

function matchShape(example: unknown, candidate: unknown, pathStr: string, issues: string[]): void {
  const et = typeOfValue(example);
  const ct = typeOfValue(candidate);
  if (et === "object") {
    if (ct !== "object") {
      issues.push(`${pathStr || "root"}: expected object, got ${ct}`);
      return;
    }
    const ex = example as Record<string, unknown>;
    const ca = candidate as Record<string, unknown>;
    for (const key of Object.keys(ex)) {
      if (!(key in ca)) {
        issues.push(`${pathStr ? pathStr + "." : ""}${key}: missing`);
        continue;
      }
      matchShape(ex[key], ca[key], `${pathStr ? pathStr + "." : ""}${key}`, issues);
    }
    return;
  }
  if (et === "array") {
    if (ct !== "array") {
      issues.push(`${pathStr || "root"}: expected array, got ${ct}`);
      return;
    }
    const exArr = example as unknown[];
    if (exArr.length > 0) {
      for (let i = 0; i < (candidate as unknown[]).length; i++) {
        matchShape(exArr[0], (candidate as unknown[])[i], `${pathStr}[${i}]`, issues);
      }
    }
    return;
  }
  // primitive: number↔number, boolean↔boolean; everything coerces to string OK.
  if (et === "number" && ct !== "number") issues.push(`${pathStr || "root"}: expected number, got ${ct}`);
  else if (et === "boolean" && ct !== "boolean") issues.push(`${pathStr || "root"}: expected boolean, got ${ct}`);
}

export const exampleValidator: LeafValidator = (
  schema: Record<string, unknown>,
  parsed: unknown,
): ValidatorResult => {
  const issues: string[] = [];
  matchShape(schema, parsed, "", issues);
  return issues.length === 0 ? { ok: true, value: parsed } : { ok: false, issues: issues.join("; ") };
};

export const exampleHinter: SchemaHinter = (schema) => JSON.stringify(schema, null, 2);

// ─── Input schema (the FleetSpec the model fills in) ───────────────────────

const agentSchema = z
  .object({
    role: z.string().min(1).describe("Short role label, e.g. 'security-angle'."),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Self-contained instructions. The agent sees NONE of your context. In a pipeline phase you may reference the prior stage with {{prev}} or {{prev.field}}.",
      ),
    tools: z
      .array(z.string())
      .optional()
      .describe("Optional tool-name whitelist. Omit for full (read-only) access."),
    schema: z
      .record(z.any())
      .optional()
      .describe(
        'Optional shape-EXAMPLE object (NOT JSON-Schema), e.g. {"summary":"...","score":0}. The leaf output is validated to match it.',
      ),
    maxTurns: z.number().int().positive().optional().describe("Per-agent turn ceiling."),
    scope: z
      .array(z.string())
      .optional()
      .describe(
        "WRITE agents only: path prefixes this agent owns (e.g. [\"src/api\"]). Required (and checked for overlap) when a parallel build phase sets isolation:'none'.",
      ),
  })
  .strict();

const phaseSchema = z
  .object({
    id: z.string().min(1).describe("Stable phase id (used for templates + journaling)."),
    kind: z
      .enum(["parallel", "pipeline"])
      .describe(
        "'parallel' = fan out all agents at once; 'pipeline' = run them in order, each seeded with the prior stage output.",
      ),
    agents: z.array(agentSchema).min(1).max(32),
    reduce: z
      .enum(["concat", "first", "judge"])
      .optional()
      .describe(
        "parallel only: 'concat' joins all outputs (default), 'first' keeps the first success, " +
          "'judge' runs ONE extra synthesis fork over all outputs (use for review/options PANELS).",
      ),
    judgeInstruction: z
      .string()
      .optional()
      .describe("'judge' only: how the synthesis fork should weigh the candidates (e.g. 'rank by severity, keep the top 3')."),
    build: z
      .boolean()
      .optional()
      .describe("BUILD phase: leaves get write tools (Bash/Edit/Write) to create files. Use kind:'pipeline' (serial writers) OR kind:'parallel' with isolation:'worktree'. Dangerous tools (payment/email/deploy/account/desktop) are still stripped."),
    repairRounds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("SELF-REPAIR: if the phase fails (or its last agent returns {ok:false}), re-run it up to N times with the failure injected — 'verify→fix→re-verify until green'. Put this on a verify phase whose agent has schema {ok:true,summary:'...'}."),
    isolation: z
      .enum(["worktree", "none"])
      .optional()
      .describe(
        "'worktree' runs a PARALLEL build phase's writers in isolated sandboxes, merged back file-disjoint (an overlap fails closed) — this is the DEFAULT for a parallel build phase with 2+ agents, so you rarely set it. 'none' opts out (shared workspace, faster) and is only accepted when EVERY agent declares a disjoint 'scope'.",
      ),
  })
  .strict();

const inputSchema = z
  .object({
    goal: z.string().optional().describe("Optional human label for the fleet."),
    plan: z
      .string()
      .optional()
      .describe("EASY MODE: a one-line goal (e.g. 'build a multiplayer FPS in the browser'). The planner expands it into a WIDE research→plan→build→verify fleet for you. Use this instead of authoring phases when you want a full build — omit 'phases' when you set 'plan'."),
    phases: z.array(phaseSchema).min(1).optional().describe("Phases run sequentially. Omit when you set 'plan' (the planner authors them)."),
    concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max in-flight forks in a parallel phase. Default 3 (clamped to 8); lower for local models."),
    maxTotalTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Hard ceiling on summed tokens across ALL forks. New forks stop being admitted on breach. Omit for a size-derived default."),
    maxWallClockMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Wall-clock backstop (ms). Aborts the whole fleet if it runs longer — catches a hung fork. Omit for a size-derived default."),
    resumeFleetId: z
      .string()
      .optional()
      .describe("Resume a prior fleet by its fleetId: completed leaves are reused from disk; only failed/missing ones re-run."),
  })
  .strict();

export function makeConductorTool(deps: ConductorToolDeps) {
  return buildTool({
    name: "Conductor",
    description: CONDUCTOR_DESCRIPTION,
    // Build phases and worktree merges can write the parent workspace. A
    // conservative parent checkpoint lets Session derive the exact merged diff
    // and schedule one authoritative parent-level verification generation.
    safety: "workspace-write",
    // It owns its own internal fan-out, so it must solo (no engine-level batching).
    concurrency: "exclusive",
    // Fleets legitimately run minutes; bounded by the parent's deadline signal.
    watchdogTimeoutMs: 0,
    inputZod: inputSchema,
    // WHEN-TO-SPAWN policy (deterministic, not model whim): a fleet must buy real
    // structure. A single phase with a single agent is just an inline task wearing
    // orchestration overhead — reject it with the fix. (A lone self-repairing
    // verify phase is exempt: repairRounds makes it a real loop, not one leaf.)
    validateInput: async (i) => {
      if (!i.plan && i.phases?.length === 1 && i.phases[0].agents.length === 1 && !(i.phases[0].repairRounds && i.phases[0].repairRounds > 0)) {
        return {
          ok: false,
          message:
            "This fleet is a single phase with a single agent — a fleet adds orchestration overhead " +
            "for zero parallelism. Run the task inline (or as one Task) instead; use Conductor only " +
            "for parallel fan-out, multi-stage pipelines, or a self-repairing verify phase.",
        };
      }
      // BUILD-DELIVERY guard: the #1 failure is a hand-authored fleet that
      // researches + plans for 20 minutes and writes ZERO code, because nothing
      // requires a build phase. If the goal clearly means "produce code" but no
      // phase has build:true, reject with the fix BEFORE the fleet burns time.
      // (Easy-mode `plan` is exempt — its planner always emits a build phase.)
      if (!i.plan && i.phases && i.phases.length > 0) {
        const hasBuildPhase = i.phases.some((p) => p.build === true);
        const goalText = i.goal ?? "";
        const buildIntent = /\b(build|implement|scaffold|develop|rebuild|reimplement|code\s*up|write\s+(the|a|an)\s)/i;
        // A goal that explicitly frames itself as research/analysis is allowed to be
        // build-phase-free even if it names "build" (e.g. "research how to build X") —
        // the user asked for findings, not code. Only a plain build directive is caught.
        const researchIntent = /\b(research|investigate|explore|survey|compare|evaluate|analy[sz]e|assess|feasibility|how\s+to|options?\s+for|approach(es)?\s+(to|for))\b/i;
        const looksLikeBuild = buildIntent.test(goalText) && !researchIntent.test(goalText);
        if (looksLikeBuild && !hasBuildPhase) {
          return {
            ok: false,
            message:
              "This fleet only researches/plans — no phase sets build:true, so it will write ZERO code, " +
              "yet the goal is to BUILD something. A research-only fleet for a build task is the #1 way to " +
              "burn 20 minutes and ship nothing. Fix it ONE of two ways: (a) add a build phase " +
              "(kind:'parallel' or 'pipeline', build:true) with file-disjoint agents that IMPLEMENT the code, " +
              "followed by a verify phase (repairRounds:3) that runs the build/tests and fails closed; or " +
              "(b) drop 'phases' entirely and use easy mode — {\"plan\":\"<one-line build goal>\"} — which " +
              "auto-authors research→plan→build→verify for you. Keep research to 1-2 phases; the deliverable is written, tested code.",
          };
        }
      }
      return { ok: true };
    },
    activityDescription: (i) =>
      i.plan
        ? `Conductor: planning a fleet for "${i.plan.slice(0, 60)}"`
        : `Conductor: ${i.goal ?? `${i.phases?.length ?? 0} phase(s)`} (${(i.phases ?? []).reduce((n, p) => n + p.agents.length, 0)} agents)`,
    async call(i, ctx) {
      const runtimeDeps: ConductorDeps = {
        provider: deps.provider,
        model: deps.model,
        parentTools: deps.parentTools,
        baseSystemPrompt: deps.baseSystemPrompt,
        workspace: ctx.workspace,
        signal: ctx.signal,
        emitProgress: ctx.emitProgress,
        subModel: deps.subModel ?? ctx.subModel,
        defaultMaxTurns: deps.defaultMaxTurns,
        allowWriteTools: deps.allowWriteTools,
        leafRequestPermission: deps.leafRequestPermission,
        validate: exampleValidator,
        schemaHint: exampleHinter,
        makeWorktree: makeCopyWorktree,
      };
      const result = await runFleet(i as FleetSpec, runtimeDeps);
      // Corrective hints — turn the runtime's failure signals into one-line advice
      // the model will actually read and apply next time (closes the learning loop).
      const stripped = result.phases.flatMap((p) => p.leaves.flatMap((l) => l.strippedTools));
      const unresolved = result.phases.reduce((n, p) => n + p.unresolvedTemplates, 0);
      const hints: string[] = [];
      if (stripped.length > 0)
        hints.push(
          `${stripped.length} write tool(s) were stripped (unattended posture). Serialize writers into ONE pipeline stage, or don't whitelist write tools in a fleet.`,
        );
      if (unresolved > 0)
        hints.push(
          `${unresolved} {{template}} ref(s) didn't resolve — a hand-off broke. Check that the referenced phase/field exists and the upstream stage emitted a schema.`,
        );
      if (result.budgetExceeded)
        hints.push("The token budget was hit; later forks were skipped. Raise maxTotalTokens or split into smaller fleets — then resumeFleetId to finish.");
      if (result.status !== "completed")
        hints.push(`Fleet ${result.status}. Re-run with resumeFleetId: "${result.fleetId}" to reuse completed leaves and only retry the rest.`);
      // BUILD-DELIVERY backstop: if the fleet completed but no phase built and no
      // leaf wrote a file, it only produced research/plans. Loudly tell the model
      // NOT to stop here — the user asked for working code, so it must now build.
      const hadBuildPhase = (i as FleetSpec).phases?.some((p) => p.build === true) ?? false;
      if (result.status === "completed" && !hadBuildPhase) {
        hints.unshift(
          "⚠ This fleet wrote NO code — it only researched/planned. Do NOT stop here or summarize and end the turn. " +
            "If the task was to build something, IMPLEMENT it now: scaffold the files and write the code with Write/Edit/Bash " +
            "(or run one more Conductor with a build:true phase). Research without a shipped build is a failed turn.",
        );
      }
      return {
        output: {
          fleetId: result.fleetId,
          status: result.status,
          budgetExceeded: result.budgetExceeded,
          ...(hints.length > 0 ? { hints } : {}),
          summary: result.summary,
          usage: result.usage,
          phases: result.phases.map((p) => ({
            id: p.id,
            kind: p.kind,
            status: p.status,
            failureReason: p.failureReason,
            unresolvedTemplates: p.unresolvedTemplates,
            agents: p.leaves.map((l) => ({
              role: l.role,
              status: l.status,
              schemaValid: l.schemaValid,
              unresolvedTemplates: l.unresolvedTemplates,
              strippedTools: l.strippedTools,
              structured: l.structured,
            })),
          })),
          manifestPath: result.manifestPath,
        },
        display: `Fleet ${result.status} — ${result.phases.length} phase(s), ${result.phases.reduce((n, p) => n + p.leaves.length, 0)} agents`,
      };
    },
  });
}

const CONDUCTOR_DESCRIPTION = `Author and run a deterministic agent FLEET for work with structure the model-driven Task tool can't guarantee: capped parallel fan-out, typed multi-stage pipelines, schema-validated outputs, build phases that write code, and a token budget.

EASY MODE (preferred for builds): set "plan" to a ONE-LINE goal — e.g. {"plan":"build a browser multiplayer FPS with Node/Vite"} — and the planner expands it into an adaptive research→plan→build→verify fleet. Omit "phases" when you use "plan". This is the right call for "build me X": you get a tooled, self-verifying fleet without hand-authoring it.

ADVANCED: emit "phases" yourself. Either way a deterministic runtime executes it start-to-finish — it owns concurrency, cancellation, schema retries, the pipeline hand-off barrier, build-phase write tools, and the budget. You do NOT manage the fan-out turn-by-turn.

REACH FOR THIS when a task has genuinely independent research questions,
file-disjoint implementation boundaries, or a staged integration/repair loop.
Default to 3-8 agents total and use fewer when the ownership graph is small;
exceed 8 only when the repository really has that many independent boundaries.
For "build me X", structure it as focused research → integration plan →
file-disjoint build → independent verify/repair. More agents are not progress
unless each owns distinct evidence or code.

WHEN TO USE — fan out ONLY for parallelizable read/search/analysis work or isolated write shards (disjoint files/dirs):
- Build something real: research the stack in parallel, then build modules in parallel, then verify.
- Survey N angles in parallel then JUDGE them into one answer (research, design options, code-review panels).
- A pipeline where each stage consumes the PREVIOUS stage's structured output (extract → transform → write).
- Any fan-out where you need a concurrency cap, a token budget, or schema-valid leaf outputs.

BUILD FLEETS MUST BUILD: for any goal that means "produce code" (build/implement/scaffold/develop/rebuild X), a hand-authored fleet with NO build:true phase is REJECTED — research + planning that never writes code is a failed turn, not a deliverable. Keep research to 1-2 phases, then a build phase (build:true, file-disjoint agents) and a verify phase (repairRounds). When unsure how to structure it, use easy mode ({"plan":"..."}) which always ends in build→verify.

WHEN NOT TO USE (rejected or wasteful):
- NEVER for a single-file edit or a task needing shared evolving context — run it inline. A fleet that is one phase with one agent is REJECTED (pure overhead; exception: a lone verify phase with repairRounds).
- A build-goal fleet with no build:true phase is REJECTED (see BUILD FLEETS MUST BUILD) — you would research forever and ship nothing.
- One phase per dependency step; add a new phase (a barrier) ONLY when a step needs ALL prior results. Independent work belongs in ONE parallel phase, not a chain.

WORKED EXAMPLE — a review panel that fans out, then synthesizes:
{ "goal": "review the diff",
  "phases": [
    { "id": "review", "kind": "parallel", "reduce": "judge",
      "judgeInstruction": "Merge into one deduplicated list ranked by severity; drop anything two reviewers didn't both raise.",
      "agents": [
        { "role": "correctness", "prompt": "Review the staged diff for correctness bugs. Return findings.", "tools": ["Read","Grep","Bash"], "schema": {"findings":[{"title":"...","severity":0}]} },
        { "role": "security",    "prompt": "Review the staged diff for security issues. Return findings.", "tools": ["Read","Grep","Bash"], "schema": {"findings":[{"title":"...","severity":0}]} },
        { "role": "perf",        "prompt": "Review the staged diff for performance issues. Return findings.", "tools": ["Read","Grep"], "schema": {"findings":[{"title":"...","severity":0}]} } ] } ],
  "concurrency": 3 }

NOTES:
- 'schema' is a shape-EXAMPLE object (values illustrate types), NOT JSON-Schema.
- reduce: 'judge' adds one synthesis fork over all siblings — far better than 'concat' for panels (you get a merged answer, not N raw opinions to digest yourself).
- In a pipeline, reference the prior stage with {{prev}} / {{prev.field}}; reference an earlier phase with {{phaseId.reduced}}. If a stage's schema fails OR a downstream {{prev.field}} doesn't resolve, the pipeline FAILS CLOSED — it does not run the next stage on garbage.
- TYPED HANDOFF: when the upstream stage declares a schema, every {{prev.field}} you write is checked against it BEFORE the stage runs — referencing a field the schema doesn't declare fails immediately with the declared field list. Only reference fields the upstream schema actually has.
- Each agent is STATELESS — make every prompt self-contained.
- Children run UNATTENDED but CAN research: read-only tools (Read/Grep/Glob/CodebaseSearch/LSP) AND safe research tools (WebFetch/WebSearch/ImageSearch) are available — whitelist them freely on research agents. Write/destructive/credential/payment/account tools are stripped unless the host enabled write mode; serialize writers into a single pipeline stage.
- SELF-REPAIR: put repairRounds (e.g. 3) on your VERIFY phase, whose agent returns schema {"ok":true,"summary":"..."}. If it reports ok:false the runtime re-runs it with the failure injected until green or rounds run out — this is how the fleet catches a broken build and FIXES it before finishing.
- PARALLEL BUILD: to build many modules at once, use kind:'parallel' + build:true with FILE-DISJOINT agents (each owns different files). Isolation defaults to 'worktree' automatically (isolated sandboxes, merged back; an overlap fails closed). To share the workspace directly set isolation:'none' — accepted only when every agent declares a disjoint 'scope' (path prefixes it owns). Serial build is just kind:'pipeline' + build:true.
- If a fleet aborts (budget/time/crash), re-run with resumeFleetId: <the returned fleetId> — completed leaves are reused, only the rest re-runs. The result's 'hints' tell you what to fix.`;
