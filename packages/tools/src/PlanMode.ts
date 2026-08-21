// Plan mode tools — let the model explicitly enter/exit read-only planning.

import { z } from "zod";
import { buildTool } from "./_shared.js";
import type { PermissionMode } from "@ares/protocol";

export interface PlanModeState {
  permissionMode: PermissionMode;
  /** `opts.ownerIntent` is set only when the owner drove the change directly.
   *  The PlanMode tools below never set it — a model-driven transition must
   *  stay subject to the host's plan-approval guard. */
  onPermissionModeChanged?(
    mode: PermissionMode,
    opts?: { ownerIntent?: boolean },
  ): Promise<void> | void;
  /** Create or recover the durable draft as soon as planning starts. */
  onPlanStarted?(reason: string): Promise<void> | void;
  /** Persist a living revision while the planning conversation continues. */
  onPlanDraftUpdated?(plan: string): Promise<void> | void;
  /** Return the exact active durable draft for an argument-free handoff. */
  currentPlan?(): Promise<string | null> | string | null;
  /** Persist the exact plan before write access can be restored. */
  onPlanProposed?(plan: string): Promise<void> | void;
  /** Atomically mark the proposed plan approved at the build transition. */
  onPlanApproved?(plan: string): Promise<void> | void;
}

/**
 * A host may compose one immutable tool catalog for many live Sessions (the
 * Garrison does). Resolve the mutable workflow state from the tool-call's
 * session id instead of capturing one process-global runtime in that case.
 * The object form remains the single-session/interactive convenience API.
 */
export type PlanModeStateSource =
  | PlanModeState
  | ((context: { sessionId: string }) => PlanModeState);

function resolveState(
  source: PlanModeStateSource,
  context: { sessionId: string },
): PlanModeState {
  return typeof source === "function" ? source(context) : source;
}

async function transition(state: PlanModeState, mode: PermissionMode): Promise<void> {
  const previous = state.permissionMode;
  state.permissionMode = mode;
  try {
    await state.onPermissionModeChanged?.(mode);
  } catch (error) {
    state.permissionMode = previous;
    throw error;
  }
}

const enterSchema = z
  .object({
    reason: z.string().default("Planning requested."),
  })
  .strict();

const exitSchema = z
  .object({
    plan: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional final markdown plan. Omit it to submit the exact active UpdatePlanDraft revision.",
      ),
  })
  .strict();

const updateSchema = z
  .object({
    plan: z.string().min(1).describe("Complete markdown body for the current living plan revision."),
  })
  .strict();

export function makeEnterPlanModeTool(source: PlanModeStateSource) {
  return buildTool({
    name: "EnterPlanMode",
    description:
      "Switch Ares into plan mode. In plan mode, write tools are blocked and the UI shows [PLAN]. Use when the user asks to plan before coding.",
    safety: "read-only",
    concurrency: "exclusive",
    inputZod: enterSchema,
    activityDescription: () => "Entering plan mode",
    async call(i, ctx): Promise<{ output: { mode: PermissionMode; reason: string }; display: string }> {
      const state = resolveState(source, ctx);
      await transition(state, "plan");
      await state.onPlanStarted?.(i.reason);
      return { output: { mode: state.permissionMode, reason: i.reason }, display: "[PLAN] enabled" };
    },
  });
}

/** Persist the plan throughout investigation instead of waiting for exit. */
export function makeUpdatePlanDraftTool(source: PlanModeStateSource) {
  return buildTool({
    name: "UpdatePlanDraft",
    description:
      "Replace the durable living plan draft with this complete markdown body. Call after material discoveries or decisions so a long planning conversation can resume exactly after compaction or restart.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: updateSchema,
    async validateInput(_input, ctx) {
      const state = resolveState(source, ctx);
      return state.onPlanDraftUpdated
        ? { ok: true }
        : { ok: false, message: "This host has no durable plan-draft channel." };
    },
    activityDescription: () => "Saving the living plan draft",
    async call(i, ctx): Promise<{ output: { mode: PermissionMode; plan: string }; display: string }> {
      const state = resolveState(source, ctx);
      if (state.permissionMode !== "plan") {
        throw new Error("UpdatePlanDraft is available only while plan mode is active.");
      }
      await state.onPlanDraftUpdated!(i.plan);
      return {
        output: { mode: state.permissionMode, plan: i.plan },
        display: "[PLAN] durable draft updated",
      };
    },
  });
}

export function makeExitPlanModeTool(source: PlanModeStateSource) {
  return buildTool({
    name: "ExitPlanMode",
    description:
      "Present the completed markdown plan for owner approval. This does not restore build authority by itself; only an explicit approval switches the session to build mode.",
    safety: "read-only",
    concurrency: "exclusive",
    inputZod: exitSchema,
    async validateInput(i, ctx) {
      if (i.plan?.trim()) return { ok: true };
      const active = await resolveState(source, ctx).currentPlan?.();
      return active?.trim()
        ? { ok: true }
        : {
            ok: false,
            message: "No durable plan draft exists. Call UpdatePlanDraft or pass plan markdown.",
          };
    },
    activityDescription: () => "Exiting plan mode",
    async call(i, ctx): Promise<{ output: { mode: PermissionMode; plan: string; approved: boolean }; display: string }> {
      const state = resolveState(source, ctx);
      const plan = i.plan ?? await state.currentPlan?.();
      if (!plan?.trim()) throw new Error("No durable plan draft exists.");
      // Plan mode's contract is "the user accepts or refines" — the model must
      // not unilaterally restore write access. Require an explicit host approval
      // when one is available; only then leave plan mode.
      await state.onPlanProposed?.(plan);
      // A host without an approval channel cannot silently turn a planning
      // conversation into write authority. An explicit host command (/code)
      // remains available as the user's transition.
      if (!ctx.requestPermission) {
        return {
          output: { mode: state.permissionMode, plan, approved: false },
          display: "[PLAN] plan saved — explicit user approval is required to build",
        };
      }
      // `ownerDecision` marks this as a WORKFLOW question, not a safety gate.
      //
      // Free/YOLO mode exists so Ares stops asking permission to write files and
      // run commands — it must not also answer "is this plan good enough to
      // start building?" on the owner's behalf. It did: a real session showed
      // this request auto-approved 11 MILLISECONDS after it was raised, so the
      // model called ExitPlanMode itself and the session flipped straight into
      // build with nobody consulted. That makes this tool's own contract — "only
      // an explicit approval switches the session to build mode" — a lie, and it
      // is exactly the "it flipped into build on its own" the owner reported.
      const decision = await ctx.requestPermission({
        toolName: "ExitPlanMode",
        input: { plan },
        reason: "Ready to build? Approve this exact plan to enter build mode and allow execution.",
        suggestion: "allow_once",
        ownerDecision: true,
      });
      if (decision === "deny") {
        return {
          output: { mode: state.permissionMode, plan, approved: false },
          display: "[PLAN] plan declined — staying in plan mode",
        };
      }
      await state.onPlanApproved?.(plan);
      await transition(state, "workspace-write");
      return { output: { mode: state.permissionMode, plan, approved: true }, display: "[PLAN] disabled" };
    },
  });
}
