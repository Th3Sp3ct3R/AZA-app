import type { SessionKernelStore } from "@ares/core";
import type { PermissionMode } from "@ares/protocol";
import type { PlanModeState } from "@ares/tools";

/** The narrow canonical Session surface needed by plan-mode tools. Keeping this
 * structural makes the registry independently testable without weakening the
 * rule that Session owns plan persistence and workflow transitions. */
export interface CanonicalPlanSession {
  beginPlanDraft(reason: string): Promise<void>;
  recordPlanDraft(body: string): Promise<void>;
  activePlanBody(): string | null;
  recordPlanProposal(body: string): Promise<void>;
  approvePlan(body: string, approver?: string): Promise<void>;
  approvePendingPlan(approver?: string): Promise<void>;
  setWorkflowMode(mode: "plan" | "build", opts?: { ownerIntent?: boolean }): void;
  setSystemPrompt(systemPrompt: string): void;
}

export interface SessionPlanModeRegistryOptions {
  kernel: SessionKernelStore;
  defaultPermissionMode: Exclude<PermissionMode, "plan">;
  sessionFor(sessionId: string): CanonicalPlanSession | undefined;
  systemPromptFor(mode: PermissionMode, sessionId: string): string;
}

/**
 * Per-session workflow composition for hosts that reuse one EngineTool catalog.
 *
 * Each PlanModeState is a separate mutable cell keyed by canonical Session id.
 * Its callbacks delegate every proposal/approval/mode change to that Session,
 * so a transition is durably fenced by the SessionKernel rather than living in
 * a process-global UI bit.
 */
export class SessionPlanModeRegistry {
  private readonly states = new Map<string, PlanModeState>();

  constructor(private readonly options: SessionPlanModeRegistryOptions) {}

  stateFor(sessionId: string): PlanModeState {
    let state = this.states.get(sessionId);
    if (state) return state;

    state = {
      permissionMode: this.canonicalModeFor(sessionId),
      onPlanStarted: async (reason) => {
        await this.requireSession(sessionId).beginPlanDraft(reason);
      },
      onPlanDraftUpdated: async (body) => {
        await this.requireSession(sessionId).recordPlanDraft(body);
      },
      currentPlan: () => this.requireSession(sessionId).activePlanBody(),
      onPlanProposed: async (body) => {
        await this.requireSession(sessionId).recordPlanProposal(body);
      },
      onPlanApproved: async (body) => {
        await this.requireSession(sessionId).approvePlan(body, "owner");
      },
      onPermissionModeChanged: async (mode, opts) => {
        const session = this.requireSession(sessionId);
        if (mode !== "plan") await session.approvePendingPlan("owner-transition");
        session.setWorkflowMode(mode === "plan" ? "plan" : "build", { ownerIntent: opts?.ownerIntent });
        session.setSystemPrompt(this.options.systemPromptFor(mode, sessionId));
      },
    };
    this.states.set(sessionId, state);
    return state;
  }

  /** Reconcile a rehydrated/replaced live Session with canonical workflow truth
   * before its first prompt is composed. */
  refresh(sessionId: string): PlanModeState {
    const state = this.stateFor(sessionId);
    state.permissionMode = this.canonicalModeFor(sessionId);
    return state;
  }

  release(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /**
   * `workflowMode` is the single source of truth for plan/build.
   *
   * This used to ALSO infer plan mode from an un-approved plan revision, which
   * silently overrode the owner: every `refresh()` re-derived the mode, so a
   * leftover draft snapped the session back to plan after the owner had chosen
   * build. Entering plan mode already persists `workflowMode: "plan"` (the
   * EnterPlanMode tool transitions before it drafts), so the durable flag alone
   * survives restart and compaction without fighting the owner's choice.
   */
  private canonicalModeFor(sessionId: string): PermissionMode {
    const durable = this.options.kernel.getSession(sessionId);
    if (durable?.workflowMode === "plan") return "plan";
    return this.options.defaultPermissionMode;
  }

  private requireSession(sessionId: string): CanonicalPlanSession {
    const session = this.options.sessionFor(sessionId);
    if (!session) {
      throw new Error(`plan transition for unattached session ${sessionId}`);
    }
    return session;
  }
}
