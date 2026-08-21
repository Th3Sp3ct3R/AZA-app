// RunSkill — execute a skill you forged with SkillCraft.
//
// SkillCraft writes handler.js files; this tool runs them. Together they close
// the loop on self-extension: notice a gap -> craft a skill -> run it. The
// handler runs in an isolated child process (see skills/runtime.ts), so a
// crash or hang can never break the turn.
//
// Safety is "external-state": executing arbitrary self-authored code is riskier
// than authoring it, so it passes through the approval gate (except in bypass
// mode) the same way an outward-facing action would.

import { z } from "zod";
import { buildTool } from "@ares/tools";
import { aresAgentHome } from "../paths.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";
import { runSkill } from "../skills/runtime.js";
import { recordOutcome } from "../self/store.js";
import { SKILL_NAME, type CapabilityReceipt, type CapabilityScope } from "../skills/manifest.js";

const inputSchema = z
  .object({
    name: z
      .string()
      .regex(SKILL_NAME, "must be lowercase letters, digits, _ or - (no path separators or '..')")
      .describe("Name of the skill to run (the directory under ~/.ares/skills/). Must have a handler.js."),
    input: z
      .unknown()
      .optional()
      .describe("JSON-serializable value passed to the handler as its first argument."),
    target_root: z
      .string()
      .optional()
      .describe("Directory the skill should operate against. Absolute paths are allowed; relative paths resolve from the current workspace."),
    operation: z
      .string()
      .optional()
      .describe("Capability-provider operation. For provider skills this may instead be supplied as input.op."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe(
        "Hard timeout in milliseconds (default 30000, max 600000). Pass a generous value for heavy skills (image/video generation can take 30s–minutes) — RunSkill self-caps on this, so a too-small value is the only thing that aborts a working skill early.",
      ),
  })
  .strict();

export interface RunSkillOutput {
  name: string;
  scope: CapabilityScope;
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  targetRoot: string;
  touchedFiles: string[];
  receipt?: CapabilityReceipt;
}

export const RunSkillTool = buildTool({
  name: "RunSkill",
  description:
    "Execute one of your own skills by name — runs its handler.js in an isolated child process and returns the result. Use after SkillCraft to actually exercise a capability you built, or whenever a stored skill is the right tool for the job. The handler's default export is called as async (input, ctx) => result. This is your body in motion: skills are no longer documentation islands.",
  safety: "external-state",
  concurrency: "exclusive",
  // Self-capping: runSkill() enforces timeout_ms in an isolated child process and
  // honors the abort signal, so it CANNOT hang the turn. Disable the engine's
  // class-default watchdog (external-state = 20s) — it would otherwise fire before
  // a legitimately long skill (image/video generation runs 30s–minutes) finishes
  // and report a FALSE "aborted" while the work is still landing.
  watchdogTimeoutMs: 0,
  inputZod: inputSchema,
  activityDescription: (i) => `RunSkill ${i.name}`,

  async call(input, ctx): Promise<{ output: RunSkillOutput; touchedFiles?: string[]; display: string }> {
    const home = aresAgentHome(process.env.ARES_HOME);
    const run = await runSkill({
      home,
      name: input.name,
      input: input.input,
      timeoutMs: input.timeout_ms,
      signal: ctx.signal,
      workspace: ctx.workspace,
      targetRoot: input.target_root,
      sessionId: ctx.sessionId,
      operation: input.operation,
    });

    emitLifecycle({
      type: "skill_ran",
      name: run.name,
      ok: run.ok,
      durationMs: run.durationMs,
      gain: gainForTarget("SKILL", 1, run.ok ? "ran" : "failed"),
    });

    // Feed the outcome back into the self-model. Never let the growth engine
    // break a turn — a self-model write failure is logged, not thrown.
    try {
      await recordOutcome(home, {
        id: `skill/${run.name}`,
        kind: "skill",
        name: run.name,
        ok: run.ok,
        ms: run.durationMs,
        error: run.error,
        provenance: "SkillCraft",
      });
    } catch {
      // self-model is best-effort
    }

    const output: RunSkillOutput = {
      name: run.name,
      scope: run.scope,
      ok: run.ok,
      result: run.result,
      error: run.error,
      logs: run.logs,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      aborted: run.aborted,
      targetRoot: run.targetRoot,
      touchedFiles: run.touchedFiles,
      receipt: run.receipt,
    };

    const display = run.ok
      ? `+1 SKILL — ran ${run.name} (${run.durationMs}ms)`
      : `SKILL failed — ${run.name}: ${truncate(run.error ?? "unknown error", 80)}`;

    return { output, touchedFiles: run.touchedFiles.length ? run.touchedFiles : undefined, display };
  },
});

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
