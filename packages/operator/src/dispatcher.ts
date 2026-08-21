// The Dispatcher — the bridge from the deterministic loop to clever work.
//
// QueryEngineDispatcher spawns a FRESH, scoped QueryEngine per step (this is
// the "mortal hands" rule from concept C1): durable state lives in the Goal,
// so each Worker boots clean, does one bounded step, and is thrown away before
// its context can rot. One impossible 10,000-step context becomes 10,000 fresh
// short ones.
//
// In O1 the verdict (`moved` / `goalMet`) is derived from the Worker's turn by
// `evaluate`. This is an explicit placeholder: O3 replaces it with a reality
// probe (the WorldModel), which is the only honest source of "is it actually
// done." The Dispatcher contract does not change when that lands.

import { createHash } from "node:crypto";
import {
  projectMessagesFromKernel,
  runForkedTurn,
  withComposedVerifiedChildSession,
  type EngineTool,
  type ForkedTurnResult,
  type Provider,
  type SessionKernelStore,
  type ToolPermissionRequest,
  type VerifierOptions,
} from "@ares/core";
import type { DispatchContext, Dispatcher, Goal, StepVerdict, VerificationSpec } from "./types.js";

/** Mirrors protocol's PermissionPromptDecision without coupling operator to it. */
type PermissionDecision = "allow_once" | "allow_always" | "deny";

export interface QueryEngineDispatcherOptions {
  provider: Provider;
  model: string;
  workspace: string;
  /** Scoped toolset for the Worker. Empty in O1 (the spine proves out first). */
  tools?: readonly EngineTool[];
  /**
   * Permit tools that can create more autonomous control loops. Off by default:
   * an Operator Worker is already an unattended child and must not recursively
   * create another Operator/fleet/schedule/external coding harness. Bounded Task
   * delegation remains available because its runner owns a non-recursive child
   * profile.
   */
  allowControlPlaneTools?: boolean;
  systemPrompt?: string;
  maxTurns?: number;
  /** O1 placeholder verdict derivation; O3 replaces with a reality probe. */
  evaluate?: (turnText: string, goal: Goal) => StepVerdict;
  /**
   * Permission gate for the Worker's tool calls. The operator loop runs
   * UNATTENDED, so the handler it supplies hard-denies anything that would need a
   * human (payments, credentials, sending mail, destructive shell) — nobody is
   * there to approve. Omitted ⇒ ask-tools throw, the legacy behavior.
   */
  requestPermission?: (request: ToolPermissionRequest) => Promise<PermissionDecision>;
  /** Canonical durable authority for Worker admissions, leases, messages, and tool effects. */
  sessionKernel?: SessionKernelStore;
  /** Optional owner-facing session that the durable Operator goal should link beneath. */
  parentSessionId?: string;
  telemetryDir?: string;
  sessionRegistryHome?: string;
  /** Production/test seam for the child-local continuous verifier. */
  childVerifierOptions?: Omit<VerifierOptions, "workspace">;
}

export class QueryEngineDispatcher implements Dispatcher {
  constructor(private readonly opts: QueryEngineDispatcherOptions) {}

  async runStep(goal: Goal, ctx: DispatchContext): Promise<StepVerdict> {
    const offeredTools = this.opts.tools ?? [];
    const tools = this.opts.allowControlPlaneTools
      ? offeredTools.filter((tool) => !OPERATOR_SESSION_TRANSITION_TOOLS.has(tool.schema.name))
      : scopeOperatorWorkerTools(this.opts.tools ?? []);
    // Mortal hands, one loop: each step is a fresh fork of the SAME QueryEngine
    // (fresh read-stamp isolation + a work-item seed, guaranteed by runForkedTurn)
    // rather than a hand-rolled engine faking a user turn.
    const fallbackStepIndex = goal.stepLog.length;
    const fallbackGoalKey = stableOperatorKey(goal.id);
    const result = this.opts.sessionKernel
      ? await this.runDurableStep(goal, ctx, tools)
      : await runForkedTurn({
          config: {
            provider: this.opts.provider,
            model: this.opts.model,
            systemPrompt: this.opts.systemPrompt ?? DEFAULT_WORKER_PROMPT,
            tools,
            workspace: this.opts.workspace,
            signal: ctx.signal,
            maxTurns: this.opts.maxTurns ?? 8,
            requestPermission: this.opts.requestPermission,
          },
          sessionId: `operator_step_${fallbackGoalKey}_${fallbackStepIndex}`,
          inputId: `operator_input_${fallbackGoalKey}_${fallbackStepIndex}`,
          seed: { kind: "work-item", text: buildStepPrompt(goal) },
        });

    // A failed/interrupted fork still returns whatever partial text it streamed.
    // Short-circuit BEFORE evaluate: otherwise defaultEvaluate sees moved=text>0
    // and a crashed fork masquerades as PROGRESS (resetting the no-progress
    // streak forever, and possibly self-certifying goalMet off partial prose).
    // 'failed' | 'interrupted' are forkedTurn's terminal-failure TurnEndStatus.
    if (result.status === "failed" || result.status === "interrupted") {
      return {
        moved: false,
        goalMet: false,
        workStatus: result.workStatus,
        evidence: `worker fork ${result.status}: ${result.streamedText.trim().slice(0, 200) || "(no output)"}`,
      };
    }

    // Loop termination is not proof of successful coding. A durable worker
    // whose newest mutation remains red/unverified cannot advance or complete
    // the Operator goal merely because its prose says it did.
    if (result.workStatus === "blocked" || result.workStatus === "unverified") {
      return {
        moved: false,
        goalMet: false,
        workStatus: result.workStatus,
        evidence: `worker changes ${result.workStatus}: ${result.streamedText.trim().slice(0, 180) || "verification did not establish a green result"}`,
      };
    }

    return {
      ...(this.opts.evaluate ?? defaultEvaluate)(result.streamedText, goal),
      workStatus: result.workStatus,
    };
  }

  private async runDurableStep(
    goal: Goal,
    ctx: DispatchContext,
    tools: readonly EngineTool[],
  ): Promise<Pick<ForkedTurnResult, "status" | "streamedText" | "workStatus">> {
    const kernel = this.opts.sessionKernel!;
    const goalKey = stableOperatorKey(goal.id);
    const goalSessionId = `operator_goal_${goalKey}`;
    let goalSession = kernel.getSession(goalSessionId);
    if (!goalSession) {
      const parent = this.opts.parentSessionId
        ? kernel.getSession(this.opts.parentSessionId)
        : null;
      goalSession = parent
        ? kernel.createChildSession({
            id: goalSessionId,
            parentSessionId: parent.id,
            relation: "operator-goal",
            externalKey: `goal:${goalKey}`,
            workspaceKey: this.opts.workspace,
            title: goal.statement.slice(0, 160),
            metadata: { goalId: goal.id },
          })
        : kernel.createSession({
            id: goalSessionId,
            workspaceKey: this.opts.workspace,
            title: goal.statement.slice(0, 160),
            metadata: { kind: "operator-goal", goalId: goal.id },
          });
    }

    const stepIndex = goal.stepLog.length;
    const worker = kernel.createChildSession({
      parentSessionId: goalSession.id,
      relation: "operator-step",
      externalKey: `step:${stepIndex}`,
      workspaceKey: this.opts.workspace,
      title: `Operator step ${stepIndex + 1}`,
      metadata: { goalId: goal.id, stepIndex },
    });
    const restoredMessages = projectMessagesFromKernel(kernel, worker.id);
    const recoveredText = lastAssistantText(restoredMessages);
    const workerSystemPrompt = this.opts.systemPrompt ?? DEFAULT_WORKER_PROMPT;
    return withComposedVerifiedChildSession({
      surface: "operator",
      workspace: this.opts.workspace,
      provider: this.opts.provider,
      model: this.opts.model,
      systemPrompt: workerSystemPrompt,
      tools,
      signal: ctx.signal,
      sessionId: worker.id,
      initialMessages: restoredMessages,
      maxTurns: this.opts.maxTurns ?? 8,
      requestPermission: this.opts.requestPermission,
      telemetryDir: this.opts.telemetryDir,
      sessionRegistryHome: this.opts.sessionRegistryHome,
      contextInputs: () => ({ goal }),
      sessionKernel: kernel,
      verifierOptions: this.opts.childVerifierOptions,
    }, async ({ session }) => {
      let status: ForkedTurnResult["status"] = "completed";
      let workStatus: ForkedTurnResult["workStatus"] = worker.workOutcome === "pending"
        ? "unverified"
        : worker.workOutcome;
      let streamedText = "";
      try {
        for await (const event of session.sendContent(
          [{ type: "text", text: buildStepPrompt(goal) }],
          { inputId: `operator_input_${goalKey}_${stepIndex}`, delivery: "queue" },
        )) {
          if (event.type === "text_delta") streamedText += event.text;
          else if (event.type === "turn_end") {
            status = event.status;
            workStatus = event.workStatus ?? "not_applicable";
          } else if (event.type === "error") status = "failed";
        }
      } catch {
        status = ctx.signal.aborted ? "interrupted" : "failed";
        workStatus = "unverified";
      }

      // If the process died after the child input was consumed but before the
      // GoalStore verdict landed, the same step/input key is a no-op on retry.
      // Recover the durable assistant evidence instead of redoing side effects.
      const finalText = streamedText.trim()
        ? streamedText
        : lastAssistantText(session.engine.history()) || recoveredText;
      if (!streamedText && recoveredText) {
        const durable = kernel.getSession(worker.id);
        if (durable?.executionState === "failed" || durable?.executionState === "interrupted") {
          status = durable.executionState;
        }
        if (durable) workStatus = durable.workOutcome === "pending" ? "unverified" : durable.workOutcome;
      }
      return { status, streamedText: finalText, workStatus };
    });
  }
}

/**
 * Control-plane tools are valid for the owner-facing agent, but handing them to
 * an unattended Operator Worker creates recursive autonomy with no new trust or
 * budget boundary. Keep the mutation/read/test tools and bounded Task subagents;
 * strip only surfaces that can launch another durable or external orchestrator.
 */
const OPERATOR_CONTROL_PLANE_TOOLS = new Set([
  "Operator",
  "Conductor",
  "StandingOrder",
  // A worker widening its own surveillance (or minting execute-mode watchers)
  // is the same class of escape as spawning another orchestrator.
  "Watcher",
  "CodingBackend",
  "Capability",
  "EnterPlanMode",
  "UpdatePlanDraft",
  "ExitPlanMode",
]);

const OPERATOR_SESSION_TRANSITION_TOOLS = new Set([
  "EnterPlanMode",
  "UpdatePlanDraft",
  "ExitPlanMode",
]);

export function scopeOperatorWorkerTools(tools: readonly EngineTool[]): EngineTool[] {
  return tools.filter((tool) => !OPERATOR_CONTROL_PLANE_TOOLS.has(tool.schema.name));
}

function stableOperatorKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function lastAssistantText(messages: readonly { role: string; content: readonly unknown[] }[]): string {
  const message = [...messages].reverse().find((entry) => entry.role === "assistant");
  if (!message) return "";
  return message.content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
    })
    .join("\n")
    .trim();
}

const DEFAULT_WORKER_PROMPT = `You are a Ares Operator Worker. You are handed ONE goal and the progress so far.
Do the single most useful next concrete step toward the goal — no more. Then state plainly what you did and whether the goal is now fully met. Be honest: only claim the goal is met when it truly is.`;

function buildStepPrompt(goal: Goal): string {
  const moved = goal.stepLog.filter((s) => s.moved).length;
  const lines = [`Goal: ${goal.statement}`, `Steps so far: ${goal.stepLog.length} (${moved} moved the gap).`];

  // Hand the worker the actual step history — without this, day 3's worker has
  // no idea what days 1-2 did beyond a number, and repeats or contradicts them.
  const recent = goal.stepLog.slice(-6);
  if (recent.length) {
    lines.push("", "What prior steps did (most recent last):");
    for (const s of recent) {
      const tag = s.goalMet ? "✓done" : s.moved ? "→moved" : "·no-op";
      lines.push(`- [${tag}] ${s.evidence?.replace(/\s+/g, " ").slice(0, 200) ?? "(no evidence recorded)"}`);
    }
  }

  // Give the worker the acceptance criteria so "done" means reality, not say-so.
  if (goal.verification) lines.push("", `Success is measured by: ${describeVerification(goal.verification)}`);
  if (goal.noProgressStreak > 0) {
    lines.push("", `Note: ${goal.noProgressStreak} recent step(s) made NO progress — try a different approach than before.`);
  }

  lines.push(
    "",
    "Take the single next concrete step toward this goal, then report what you did and whether the goal is now fully met.",
  );
  return lines.join("\n");
}

function describeVerification(v: VerificationSpec): string {
  switch (v.kind) {
    case "always":
      return v.summary ?? (v.met ? "marked met" : "manual judgement");
    case "file":
      return `file ${v.path}${v.contains ? ` contains "${v.contains}"` : " exists"}`;
    case "command":
      return `command \`${[v.cmd, ...(v.args ?? [])].join(" ")}\`${v.contains ? ` outputs "${v.contains}"` : ` exits ${v.expectExit ?? 0}`}`;
    case "http":
      return `GET ${v.url} returns ${v.expectStatus ?? 200}${v.contains ? ` containing "${v.contains}"` : ""}`;
  }
}

/**
 * O1 placeholder: a non-empty turn counts as progress; an explicit "met"
 * signal counts as completion. Deliberately naive — replaced by O3's reality
 * probe. Real convergence must never rest on the model's say-so.
 *
 * A `goalMet` derived from a REGEX over the Worker's prose has no world
 * corroboration behind it, so we always tag it `unverified`. The control loop
 * then demands a reality probe (the goal's VerificationSpec, or the WorldModel
 * for a spec-less goal) before it lets a step certify the goal done — and where
 * no probe can corroborate, the completion is recorded as real-but-unverified
 * rather than trusted blindly. This keeps the bare regex from self-certifying.
 */
export function defaultEvaluate(turnText: string, _goal: Goal): StepVerdict {
  const text = turnText.trim();
  const moved = text.length > 0;
  const goalMet = /\bgoal\s+(?:is\s+)?(?:now\s+)?(?:fully\s+)?met\b/i.test(text);
  return { moved, goalMet, unverified: goalMet || undefined, evidence: text.slice(0, 200) || undefined };
}
