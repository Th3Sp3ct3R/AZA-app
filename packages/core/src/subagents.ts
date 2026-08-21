// Subagent registry + runner.
//
// A subagent is a durable child Session with a scoped tool whitelist and a
// focused system prompt. Its context, compaction epochs, and tool lifecycle
// survive restarts while the parent receives only a bounded final handoff.
//
// Built-in types (extend via SubagentRegistry.register):
//   general-purpose  — full tool access; for research that may write code
//   researcher       — read-only; returns structured findings report
//   code-reviewer    — read + lints; inspects the pending diff
//
// The Task tool (in @ares/tools) takes a SubagentRunner and calls run().
// The CLI builds the runner with the parent's provider so children use
// the same model.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Usage, WorkStatus } from "@ares/protocol";
import { runForkedTurn, type ForkedTurnResult } from "./forkedTurn.js";
import type { EngineTool, Provider, QueryEngineConfig } from "./queryEngine.js";
import { SubagentJournal, renderSubagentHandoff, type SubagentHandoff } from "./subagentJournal.js";
import { loadSessionSnapshot } from "./session.js";
import type { BackgroundJobRecord, JsonValue, SessionKernelStore } from "./sessionKernel/index.js";
import { withComposedVerifiedChildSession } from "./childSessionComposition.js";
import type { VerifierOptions } from "./verifier.js";

export interface SubagentTypeDef {
  name: string;
  description: string;
  /** Tool names the subagent is allowed to call. If undefined → all parent tools. */
  toolWhitelist?: readonly string[];
  /** Subagent-specific system prompt. Prepended ahead of the parent's base. */
  systemPrompt: string;
  /** Max iterations the inner QueryEngine will run before bailing. */
  maxTurns?: number;
  /** "fast" = run on the host's cheap/fast lane when one is wired (searching
   *  doesn't need the frontier model — this is what keeps wide exploration
   *  cheap and quick). Default: inherit the parent model. */
  modelPreference?: "fast" | "inherit";
}

export interface SubagentRunRequest {
  subagent_type: string;
  description: string;
  prompt: string;
  parentSessionId?: string;
  /** Stable parent tool-use identity. Replays of this invocation reconnect to
   * the same child and submit the same idempotent child input. */
  invocationId?: string;
  /** Continue an addressable durable child instead of spawning from zero. */
  taskId?: string;
  workspace: string;
  signal?: AbortSignal;
  /** Forward child activity to the parent so a running subagent isn't invisible. */
  onProgress?: (data: unknown) => void;
  /** Parent-session permission prompt, forwarded into the child engine so a
   *  subagent touching paths outside the workspace ASKS instead of hard-dying
   *  ("escapes workspace and no permission prompt is available"). The child's
   *  request pauses its own tool watchdog and surfaces in the parent UI like
   *  any other prompt; the resulting dir-scope grant lands in the shared
   *  path-permission store, unblocking sibling leaves without re-prompting. */
  requestPermission?: QueryEngineConfig["requestPermission"];
}

export interface SubagentRunResult {
  id: string;
  type: string;
  status: "completed" | "failed" | "cancelled";
  workStatus: WorkStatus;
  /** The summary text the subagent produced — fed back as the tool result. */
  summary: string;
  toolCallCount: number;
  durationMs: number;
  usage: Usage;
  /** Persistent transcript path under <workspace>/.ares/agents/<id>/. */
  transcriptPath: string;
  /** Structured flight-recorder handoff: what the child actually DID (from its
   *  engine events), not what its prose claims. Also rendered into `summary`. */
  handoff: SubagentHandoff;
}

export interface SubagentRunner {
  run(req: SubagentRunRequest): Promise<SubagentRunResult>;
  startBackground?(req: SubagentRunRequest): Promise<BackgroundSubagentStart>;
  getBackground?(jobId: string, parentSessionId: string): BackgroundSubagentSnapshot | null;
  cancelBackground?(jobId: string, parentSessionId: string): Promise<BackgroundSubagentSnapshot | null>;
  listTypes(): SubagentTypeDef[];
  has(name: string): boolean;
}

export interface BackgroundSubagentStart {
  jobId: string;
  taskId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "orphaned";
}

export interface BackgroundSubagentSnapshot extends BackgroundSubagentStart {
  description: string;
  result: JsonValue | null;
  error: JsonValue | null;
  cancelRequested: boolean;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

/** Owner-facing workflow transitions are bound to one conversation. Durable
 * Task children have independent execution context but no independent approval
 * channel, so inheriting these tools can only mutate a captured parent/global
 * runtime. Strip them even when a host accidentally passes a full catalog. */
export const SUBAGENT_SESSION_TRANSITION_TOOLS = new Set([
  "EnterPlanMode",
  "UpdatePlanDraft",
  "ExitPlanMode",
]);

export function scopeSubagentTools(
  parentTools: readonly EngineTool[],
  whitelist?: readonly string[],
): EngineTool[] {
  const whitelisted = whitelist
    ? parentTools.filter((tool) => whitelist.includes(tool.schema.name))
    : parentTools;
  return whitelisted.filter(
    (tool) => !SUBAGENT_SESSION_TRANSITION_TOOLS.has(tool.schema.name),
  );
}

// ─── Built-in subagent types ───────────────────────────────────────────

const RESEARCHER_PROMPT = `You are a focused RESEARCHER subagent inside the Ares harness.

Your job: investigate the question your parent asked and return ONE structured findings report. You have READ-ONLY tools. Do not attempt edits.

Process:
1. Use CodebaseSearch / Grep / Glob / Read aggressively to gather evidence.
2. Read every file path you reference to confirm what's actually there.
3. Use file_path:line_number for every claim you make.

Output format (return this and only this):
  ## Findings
  - <claim with file_path:line proof>
  - <claim with file_path:line proof>

  ## Open questions
  - <thing you couldn't confirm and why>

  ## Recommended next step
  <one sentence>

Be concise. Your parent will read your summary and decide next moves.`;

const CODE_REVIEWER_PROMPT = `You are a CODE REVIEWER subagent inside the Ares harness.

Your job: review the pending changes and return ONE structured review. You have READ + Lints + Bash (read-only commands like git diff) tools. Do not edit.

Process:
1. Run \`git diff\` (or whatever scope the parent passed) to see the changes.
2. Inspect changed files with Read.
3. Run Lints/Grep to find regressions, dead code, missing tests.
4. Cite every finding with file_path:line.

Output format:
  ## Blockers (must fix)
  - file:line — what + why + suggested fix

  ## Concerns (should consider)
  - file:line — what + why

  ## Nits (optional polish)
  - file:line — what

  ## Test coverage
  <one sentence on whether tests cover the change>

  ## Verdict
  ship / fix-blockers / needs-discussion`;

const GENERAL_PURPOSE_PROMPT = `You are a GENERAL-PURPOSE subagent inside the Ares harness.

You have full tool access. Your job: complete the task your parent assigned, then return a structured summary.

Process:
1. Use TodoWrite to plan if the task has 3+ steps.
2. Use tools to act. Read before Edit. Verify changes you made.
3. Be exhaustive — your parent is not watching the details. They only see your final summary.
4. Track file_path:line for every notable change.

Output format:
  ## Done
  - <what you completed, with file_path:line>

  ## Verified
  - <commands you ran and their result>

  ## Blockers
  - <anything you couldn't finish>

  ## Files changed
  - file/path:linecount`;

const VERIFIER_PROMPT = `You are a VERIFICATION specialist inside the Ares harness. Your job is NOT to confirm the work works — it is to try to BREAK it.

You have two documented failure patterns; catch yourself doing them and do the opposite:
1. Verification avoidance — faced with a check, you find reasons not to run it: you read the code, narrate what you WOULD test, write "PASS," and move on. Reading is not verification. Run it.
2. Seduced by the first 80% — a passing test suite or a polished surface makes you want to pass it, without noticing half the buttons do nothing, state vanishes on refresh, or the backend crashes on bad input. The last 20% is your entire value.

The caller may spot-check by RE-RUNNING your commands — if a PASS has no command output, or output that doesn't reproduce, your report is rejected.

You are TOOL-RESTRICTED: you have Read/Grep/Glob/Bash/PowerShell/WebFetch — NO Edit, Write, or Task. You physically cannot fix-and-pass. If something is broken, you report it broken. (You may write ephemeral scripts to a temp dir via Bash redirection when an inline command isn't enough; clean up.)

REQUIRED BASELINE (do these first, when applicable):
1. Read CLAUDE.md/README/package.json for the real build & test commands. If pointed at a plan/spec, read it — that's the success criteria.
2. Run the build. A broken build is an automatic FAIL.
3. Run the test suite. Failing tests are an automatic FAIL. (But test results are CONTEXT, not proof — the implementer is an LLM; its tests may be mock-heavy happy-path.)
4. Run type-checkers/linters if configured.
Then exercise the actual change directly (run it / call it / hit the endpoint) and check OUTPUTS against expectations — not just status codes.

ADVERSARIAL PROBES (pick the ones that fit — a PASS requires at least one, with its result):
- Boundary values: 0, -1, empty, huge, unicode, MAX_INT
- Concurrency: parallel requests to create-if-not-exists paths (duplicates? lost writes?)
- Idempotency: same mutating request twice
- Orphan ops: reference/delete IDs that don't exist
If all your checks are "returns 200" or "suite passes," you verified the happy path, not correctness. Go break something.

OUTPUT FORMAT — every check MUST be:
### Check: <what you're verifying>
**Command run:** <exact command>
**Output observed:** <actual output, copy-pasted, not paraphrased>
**Result: PASS** (or FAIL — with Expected vs Actual)

A check with no Command-run block is a SKIP, not a PASS.

End with EXACTLY one line the caller parses:
VERDICT: PASS
or
VERDICT: FAIL
or
VERDICT: PARTIAL

PARTIAL is for environmental limits ONLY (no test framework, tool unavailable, server won't start) — never for "I'm unsure if it's a bug." If you can run the check, decide PASS or FAIL.`;

const EXPLORER_PROMPT = `You are an EXPLORER subagent — a fast, read-only search specialist. The caller needs a CONCLUSION, not file dumps.

Rules:
- Sweep wide: Glob/Grep/CodebaseSearch across every plausible location and naming convention, then Read only the excerpts that decide the answer.
- Never paste large file bodies back. Cite findings as file_path:line with a one-line quote at most.
- Cover the misses too: say where you looked that turned up empty, so the caller doesn't re-search it.
- Finish with a tight summary: ANSWER (the conclusion), EVIDENCE (citations), NOT FOUND (searched-but-absent).
Speed matters — prefer three broad searches over ten narrow ones.`;

export const BUILT_IN_SUBAGENT_TYPES: SubagentTypeDef[] = [
  {
    name: "explorer",
    description:
      "Fast read-only search specialist for broad fan-out exploration — 'find every place X happens', 'which files own Y'. Runs on the cheap/fast model lane when available, so use it liberally to keep YOUR context lean: it reads the excerpts so you don't have to. Returns a conclusion with file:line citations, never file dumps.",
    toolWhitelist: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP"],
    systemPrompt: EXPLORER_PROMPT,
    maxTurns: 20,
    modelPreference: "fast",
  },
  {
    name: "verifier",
    description:
      "Adversarial verification subagent — 'done means proven'. Tool-restricted (Read/Grep/Glob/Bash/PowerShell/WebFetch; NO Edit/Write/Task) so it cannot fix-and-pass. Runs the real build/tests + adversarial probes and returns a VERDICT: PASS/FAIL/PARTIAL with copy-pasted command evidence. Invoke after non-trivial coding work (3+ edits, backend/infra changes) BEFORE claiming done — the caller may re-run its commands to confirm.",
    toolWhitelist: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP", "Bash", "PowerShell", "WebFetch"],
    systemPrompt: VERIFIER_PROMPT,
    maxTurns: 30,
  },
  {
    name: "general-purpose",
    description:
      "Full-access subagent for research tasks that may also need to write code. Best when the task is well-scoped and self-contained.",
    systemPrompt: GENERAL_PURPOSE_PROMPT,
    maxTurns: 40,
  },
  {
    name: "researcher",
    description:
      "Read-only subagent for 'where is X handled', 'how does Y work', 'find all uses of Z' style questions. Returns a structured findings report.",
    toolWhitelist: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP"],
    systemPrompt: RESEARCHER_PROMPT,
    maxTurns: 25,
  },
  {
    name: "code-reviewer",
    description:
      "Read + diagnostics subagent for reviewing pending changes. Returns structured findings (blockers / concerns / nits / verdict).",
    toolWhitelist: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP", "Bash", "PowerShell"],
    systemPrompt: CODE_REVIEWER_PROMPT,
    maxTurns: 20,
  },
];

// ─── Registry + Runner ─────────────────────────────────────────────────

export class SubagentRegistry {
  private readonly types = new Map<string, SubagentTypeDef>();

  constructor(initial: readonly SubagentTypeDef[] = BUILT_IN_SUBAGENT_TYPES) {
    for (const t of initial) this.types.set(t.name, t);
  }

  register(def: SubagentTypeDef): void {
    this.types.set(def.name, def);
  }

  list(): SubagentTypeDef[] {
    return [...this.types.values()];
  }

  get(name: string): SubagentTypeDef | undefined {
    return this.types.get(name);
  }
}

export interface SubagentRunnerOptions {
  registry: SubagentRegistry;
  /** Provider used by all subagent runs. Same model as the parent. */
  provider: Provider;
  model: string;
  /** Cheap/fast model id ON THE SAME PROVIDER for types that prefer it
   *  (explorer). Absent → those types inherit the parent model. */
  fastModel?: string;
  /** Full parent tool catalog. The runner filters by whitelist per type. */
  parentTools: readonly EngineTool[];
  /** Base system prompt the subagent sees AFTER its type-specific prompt. */
  baseSystemPrompt: string | (() => string | Promise<string>);
  /** Optional global ceiling layered over each subagent type's own limit. */
  maxTurns?: number | (() => number | undefined);
  /** Production path: children become normal durable Session rows. */
  sessionKernel?: SessionKernelStore;
  contextBudgetTokens?: number;
  compactionThresholdTokens?: number;
  summarizeSpan?: QueryEngineConfig["summarizeSpan"];
  /** Per-child verifier tuning/injection. A fresh ContinuousVerifier is still
   * constructed for every durable child Session. */
  childVerifierOptions?: Omit<VerifierOptions, "workspace">;
}

export class AresSubagentRunner implements SubagentRunner {
  private readonly backgroundOwnerId = `task-worker-${process.pid}-${randomUUID()}`;
  private readonly backgroundControllers = new Map<string, AbortController>();

  constructor(private readonly opts: SubagentRunnerOptions) {
    if (opts.sessionKernel) queueMicrotask(() => void this.recoverBackgroundTasks().catch(() => undefined));
  }

  listTypes(): SubagentTypeDef[] {
    return this.opts.registry.list();
  }

  has(name: string): boolean {
    return this.opts.registry.get(name) !== undefined;
  }

  async startBackground(req: SubagentRunRequest): Promise<BackgroundSubagentStart> {
    const kernel = this.opts.sessionKernel;
    if (!kernel) throw new Error("background Task requires the durable session kernel");
    if (!req.parentSessionId || !req.invocationId) {
      throw new Error("background Task requires a parent session and stable invocation id");
    }
    if (!this.has(req.subagent_type)) throw new Error(`unknown subagent_type: ${req.subagent_type}`);
    const taskId = req.taskId ?? stableScopedId("agent", req.parentSessionId, req.invocationId);
    const jobId = stableScopedId("taskjob", req.parentSessionId, req.invocationId);
    const request = backgroundRequestJson(req);
    const { record } = kernel.createBackgroundJob({
      id: jobId,
      sessionId: req.parentSessionId,
      invocationKey: req.invocationId,
      kind: "task",
      description: req.description,
      request,
    });
    if (!isTerminalBackgroundTask(record)) {
      queueMicrotask(() => void this.executeBackgroundTask(record.id, req.requestPermission).catch(() => undefined));
    }
    return { jobId: record.id, taskId, status: record.status };
  }

  getBackground(jobId: string, parentSessionId: string): BackgroundSubagentSnapshot | null {
    const kernel = this.opts.sessionKernel;
    if (!kernel) return null;
    const job = kernel.getBackgroundJob(jobId);
    if (!job || job.kind !== "task" || job.sessionId !== parentSessionId) return null;
    if (!isTerminalBackgroundTask(job) && (job.leaseExpiresAtMs ?? 0) <= Date.now()) {
      queueMicrotask(() => void this.executeBackgroundTask(job.id).catch(() => undefined));
    }
    return backgroundSnapshot(job);
  }

  async cancelBackground(jobId: string, parentSessionId: string): Promise<BackgroundSubagentSnapshot | null> {
    const kernel = this.opts.sessionKernel;
    if (!kernel) return null;
    const job = kernel.getBackgroundJob(jobId);
    if (!job || job.kind !== "task" || job.sessionId !== parentSessionId) return null;
    const requested = kernel.requestBackgroundJobCancellation(jobId);
    this.backgroundControllers.get(jobId)?.abort(new Error("background Task cancelled by owner"));
    if (requested.status === "queued") {
      const settled = kernel.settleBackgroundJob(jobId, {
        status: "cancelled",
        result: { jobId, taskId: requested.childSessionId, status: "cancelled" },
        completion: backgroundCompletion(requested, "cancelled", "Background task was cancelled before it started."),
      });
      return backgroundSnapshot(settled);
    }
    return backgroundSnapshot(requested);
  }

  async run(req: SubagentRunRequest): Promise<SubagentRunResult> {
    const def = this.opts.registry.get(req.subagent_type);
    if (!def) {
      throw new Error(
        `unknown subagent_type: ${req.subagent_type}. Available: ${this.listTypes()
          .map((t) => t.name)
          .join(", ")}`,
      );
    }

    const allowedTools = scopeSubagentTools(this.opts.parentTools, def.toolWhitelist);

    const replayChildId = req.parentSessionId && req.invocationId
      ? stableScopedId("agent", req.parentSessionId, req.invocationId)
      : undefined;
    const id = req.taskId ?? replayChildId ?? `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let resumeExisting = false;
    if (req.taskId && !this.opts.sessionKernel) {
      throw new Error("task_id continuation requires the durable session kernel");
    }
    if (this.opts.sessionKernel) {
      const existing = this.opts.sessionKernel.getSession(id);
      if (req.taskId || existing) {
        if (!existing) throw new Error(`unknown task_id: ${id}`);
        if (req.parentSessionId && existing.parentSessionId !== req.parentSessionId) {
          throw new Error(`task_id ${id} belongs to a different parent session`);
        }
        const metadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
          ? existing.metadata as Record<string, unknown>
          : {};
        if (typeof metadata.subagentType === "string" && metadata.subagentType !== req.subagent_type) {
          throw new Error(`task_id ${id} is type ${metadata.subagentType}, not ${req.subagent_type}`);
        }
        resumeExisting = true;
      } else if (req.parentSessionId) {
        if (!this.opts.sessionKernel.getSession(req.parentSessionId)) {
          this.opts.sessionKernel.createSession({
            id: req.parentSessionId,
            workspaceKey: path.resolve(req.workspace),
            metadata: { source: "legacy-host" },
          });
        }
        this.opts.sessionKernel.createChildSession({
          id,
          parentSessionId: req.parentSessionId,
          relation: "task",
          externalKey: req.invocationId ? `tool:${req.invocationId}` : id,
          workspaceKey: path.resolve(req.workspace),
          title: req.description,
          metadata: { subagentType: req.subagent_type, description: req.description },
        });
      }
    }
    const startedAt = Date.now();
    const transcriptDir = path.join(req.workspace, ".ares", "agents", id);
    // Flight recorder: fed live from the child's engine events, flushed to disk
    // incrementally so a crashed subagent leaves evidence. Never fails the run.
    const journal = new SubagentJournal(transcriptDir, {
      id,
      type: req.subagent_type,
      description: req.description,
    });

    const baseSystemPrompt = typeof this.opts.baseSystemPrompt === "function"
      ? await this.opts.baseSystemPrompt()
      : this.opts.baseSystemPrompt;
    const systemPrompt = `${def.systemPrompt}\n\n---\n\n${baseSystemPrompt}`;

    const configuredMaxTurns =
      typeof this.opts.maxTurns === "function" ? this.opts.maxTurns() : this.opts.maxTurns;
    const typeMaxTurns = def.maxTurns ?? 30;
    const maxTurns =
      configuredMaxTurns === undefined ? typeMaxTurns : Math.min(typeMaxTurns, configuredMaxTurns);

    // Re-enter the ONE loop as a fork: fresh read-stamp isolation + a work-item
    // seed (not a faked chat turn) are guaranteed inside runForkedTurn.
    // Fast-lane types (explorer) run on the cheap model when the host wired one
    // — searching doesn't need the frontier model, and it keeps fan-out cheap.
    const model =
      def.modelPreference === "fast" && this.opts.fastModel ? this.opts.fastModel : this.opts.model;
    // Fleet-board mirror: the desktop agent board renders `fleet_activity`
    // payloads (keyed on agentId), so every Task subagent ALSO announces its
    // lifecycle in that shape — phase "task" groups them apart from Conductor
    // phases. The `subagent_activity` emission stays: the step-detail label
    // in the transcript depends on it.
    const boardRole = req.description || req.subagent_type;
    const emitBoard = (data: Record<string, unknown>) =>
      req.onProgress?.({ kind: "fleet_activity", agentId: id, role: boardRole, phase: "task", ...data });
    const onEvent = (ev: import("@ares/protocol").TurnEvent) => {
      journal.record(ev);
      if (ev.type === "tool_start") {
        req.onProgress?.({
          kind: "subagent_activity",
          agentId: id,
          type: req.subagent_type,
          tool: ev.name,
          activity: ev.activityDescription,
        });
        emitBoard({ event: "tool", tool: ev.name, activity: ev.activityDescription });
      }
    };
    emitBoard({ event: "start" });
    let result: ForkedTurnResult;
    try {
      result = this.opts.sessionKernel
        ? await this.runDurableTurn({
          id,
          prompt: req.prompt,
          workspace: req.workspace,
          provider: this.opts.provider,
          model,
          systemPrompt,
          tools: allowedTools,
          signal: req.signal,
          maxTurns,
          requestPermission: req.requestPermission,
          onEvent,
          resume: Boolean(req.taskId || resumeExisting),
          inputId: req.invocationId
            ? stableScopedId("task_input", req.parentSessionId ?? id, req.invocationId)
            : undefined,
        })
      : await runForkedTurn({
          config: {
            provider: this.opts.provider,
            model,
            systemPrompt,
            tools: allowedTools,
            workspace: req.workspace,
            signal: req.signal,
            maxTurns,
            requestPermission: req.requestPermission,
          },
          sessionId: id,
          inputId: req.invocationId
            ? stableScopedId("task_input", req.parentSessionId ?? id, req.invocationId)
            : undefined,
          seed: { kind: "work-item", text: req.prompt },
          onEvent,
        });
    } catch (error) {
      // The board never shows a ghost agent: a thrown run settles as failed.
      emitBoard({ event: "done", status: "failed" });
      throw error;
    }

    const events = result.events;
    const usage: Usage = result.usage;
    const toolCallCount = events.filter((e) => e.type === "tool_start").length;
    const status: SubagentRunResult["status"] = result.status === "completed" ? "completed" : "failed";
    emitBoard({ event: "done", status });

    const hasAssistant = result.history.some((m) => m.role === "assistant");
    // A child that died before writing prose still owes the parent an
    // explanation — surface its last tool errors instead of the bare
    // "(subagent produced no text output)" that made fleet deaths undebuggable.
    const lastToolErrors = events
      .filter((e) => e.type === "tool_error")
      .slice(-3)
      .map((e) => `- ${String((e as { error?: unknown }).error ?? "").slice(0, 300)}`);
    const emptyText =
      (hasAssistant ? "(subagent produced no text output)" : "(subagent did not respond)") +
      (lastToolErrors.length ? `\nLast tool error(s):\n${lastToolErrors.join("\n")}` : "");
    const finalText = result.finalText || emptyText;

    // Structured handoff: what the child actually DID (from engine events), fed
    // back alongside its prose so the parent doesn't have to trust the claims.
    const handoff = await journal.finish(result.status);
    const summary = `${finalText}\n\n${renderSubagentHandoff(handoff)}`;

    // Persist transcript best-effort.
    let transcriptPath = path.join(transcriptDir, "transcript.jsonl");
    try {
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        path.join(transcriptDir, "meta.json"),
        JSON.stringify(
          {
            id,
            type: req.subagent_type,
            description: req.description,
            parentSessionId: req.parentSessionId,
            startedAt: new Date(startedAt).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            status,
            workStatus: result.workStatus,
            toolCallCount,
            usage,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      if (events.length > 0) {
        await appendFile(transcriptPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      }
    } catch {
      transcriptPath = "";
    }

    return {
      id,
      type: req.subagent_type,
      status,
      workStatus: result.workStatus,
      summary,
      toolCallCount,
      durationMs: Date.now() - startedAt,
      usage,
      transcriptPath,
      handoff,
    };
  }

  private async recoverBackgroundTasks(): Promise<void> {
    const kernel = this.opts.sessionKernel;
    if (!kernel) return;
    for (const job of kernel.listBackgroundJobs(undefined, {
      kind: "task",
      statuses: ["queued", "running"],
    })) {
      if (job.cancelRequested && job.status === "queued") {
        kernel.settleBackgroundJob(job.id, {
          status: "cancelled",
          result: { jobId: job.id, taskId: taskIdForBackgroundJob(job), status: "cancelled" },
          completion: backgroundCompletion(job, "cancelled", "Background task was cancelled before recovery."),
        });
        continue;
      }
      void this.executeBackgroundTask(job.id).catch(() => undefined);
    }
  }

  private scheduleBackgroundRecovery(job: BackgroundJobRecord): void {
    if (isTerminalBackgroundTask(job)) return;
    const delay = Math.max(50, Math.min(30_000, (job.leaseExpiresAtMs ?? Date.now()) - Date.now() + 25));
    const timer = setTimeout(() => void this.executeBackgroundTask(job.id).catch(() => undefined), delay);
    timer.unref();
  }

  private async executeBackgroundTask(
    jobId: string,
    requestPermission?: QueryEngineConfig["requestPermission"],
  ): Promise<void> {
    const kernel = this.opts.sessionKernel;
    if (!kernel || this.backgroundControllers.has(jobId)) return;
    const before = kernel.getBackgroundJob(jobId);
    if (!before || before.kind !== "task" || isTerminalBackgroundTask(before)) return;
    const persistedRequest = parseBackgroundRequest(before);
    // Several Session hosts may share one workspace kernel while exposing
    // different persona catalogs. A host that cannot execute this type must
    // leave it unclaimed for the compatible runner, not steal-and-fail it.
    if (persistedRequest && !this.has(persistedRequest.subagent_type)) return;
    if (before.cancelRequested) {
      if (before.ownerId && (before.leaseExpiresAtMs ?? 0) > Date.now()) {
        this.scheduleBackgroundRecovery(before);
        return;
      }
      kernel.settleBackgroundJob(jobId, {
        status: "cancelled",
        result: { jobId, taskId: taskIdForBackgroundJob(before), status: "cancelled" },
        completion: backgroundCompletion(before, "cancelled", "Background task cancellation was recovered after its worker stopped."),
      });
      return;
    }
    const claimed = kernel.claimBackgroundJob(jobId, this.backgroundOwnerId, 30_000);
    if (!claimed) {
      const latest = kernel.getBackgroundJob(jobId);
      if (latest && !isTerminalBackgroundTask(latest)) this.scheduleBackgroundRecovery(latest);
      return;
    }
    const req = persistedRequest ?? parseBackgroundRequest(claimed);
    if (!req) {
      kernel.settleBackgroundJob(jobId, {
        status: "failed",
        error: { message: "Durable background Task request is invalid" },
        completion: backgroundCompletion(claimed, "failed", "Background task could not resume: its durable request is invalid."),
      }, this.backgroundOwnerId);
      return;
    }

    const controller = new AbortController();
    this.backgroundControllers.set(jobId, controller);
    const heartbeat = setInterval(() => {
      const renewed = kernel.renewBackgroundJobLease(jobId, this.backgroundOwnerId, 30_000);
      if (!renewed || renewed.cancelRequested) {
        controller.abort(new Error(renewed?.cancelRequested
          ? "background Task cancellation requested"
          : "background Task worker lease lost"));
      }
    }, 5_000);
    heartbeat.unref();

    try {
      const result = await this.run({
        ...req,
        signal: controller.signal,
        requestPermission,
      });
      const current = kernel.getBackgroundJob(jobId);
      if (!current || isTerminalBackgroundTask(current)) return;
      if (current.ownerId !== this.backgroundOwnerId) return;
      kernel.attachBackgroundJobChild(jobId, result.id);
      const cancelled = current.cancelRequested || controller.signal.aborted;
      const status = cancelled ? "cancelled" : result.status === "completed" ? "completed" : "failed";
      const resultJson = subagentResultJson(result);
      kernel.settleBackgroundJob(jobId, {
        status,
        result: resultJson,
        ...(status === "failed" ? { error: { message: result.summary.slice(0, 2_000) } } : {}),
        completion: backgroundCompletion(
          current,
          status,
          renderBackgroundTaskCompletion(result, status),
        ),
      }, this.backgroundOwnerId);
    } catch (error) {
      const current = kernel.getBackgroundJob(jobId);
      if (!current || isTerminalBackgroundTask(current)) return;
      if (current.ownerId !== this.backgroundOwnerId) return;
      const cancelled = current.cancelRequested || controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      kernel.settleBackgroundJob(jobId, {
        status: cancelled ? "cancelled" : "failed",
        error: { message },
        result: { jobId, taskId: taskIdForBackgroundJob(current), status: cancelled ? "cancelled" : "failed" },
        completion: backgroundCompletion(
          current,
          cancelled ? "cancelled" : "failed",
          `Background task ${cancelled ? "was cancelled" : "failed"}: ${message}`,
        ),
      }, this.backgroundOwnerId);
    } finally {
      clearInterval(heartbeat);
      this.backgroundControllers.delete(jobId);
    }
  }

  private async runDurableTurn(input: {
    id: string;
    prompt: string;
    workspace: string;
    provider: Provider;
    model: string;
    systemPrompt: string;
    tools: readonly EngineTool[];
    signal?: AbortSignal;
    maxTurns: number;
    requestPermission?: QueryEngineConfig["requestPermission"];
    onEvent(event: import("@ares/protocol").TurnEvent): void;
    resume: boolean;
    inputId?: string;
  }): Promise<ForkedTurnResult> {
    const snapshot = input.resume
      ? await loadSessionSnapshot(input.workspace, input.id, { maxMessages: 10_000 })
      : null;
    return withComposedVerifiedChildSession({
      surface: "task",
      workspace: input.workspace,
      provider: input.provider,
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      signal: input.signal,
      sessionId: snapshot ? undefined : input.id,
      sessionMeta: snapshot?.meta,
      initialMessages: snapshot?.messages,
      initialTodos: snapshot?.todos,
      initialSeq: snapshot?.nextSeq,
      maxTurns: input.maxTurns,
      requestPermission: input.requestPermission,
      contextBudgetTokens: this.opts.contextBudgetTokens,
      compactionThresholdTokens: this.opts.compactionThresholdTokens,
      summarizeSpan: this.opts.summarizeSpan,
      sessionKernel: this.opts.sessionKernel!,
      verifierOptions: this.opts.childVerifierOptions,
    }, async ({ session }) => {
      const events: import("@ares/protocol").TurnEvent[] = [];
      let streamedText = "";
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let status: ForkedTurnResult["status"] = "completed";
      let workStatus: WorkStatus = "not_applicable";
      try {
        for await (const event of session.sendContent(
          [{ type: "text", text: input.prompt }],
          { inputId: input.inputId ?? `task_input_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}` },
        )) {
          events.push(event);
          input.onEvent(event);
          if (event.type === "text_delta") streamedText += event.text;
          else if (event.type === "turn_end") {
            usage = event.usage;
            status = event.status;
            workStatus = event.workStatus ?? "not_applicable";
          } else if (event.type === "error") {
            status = "failed";
          }
        }
      } catch {
        status = "failed";
        workStatus = "unverified";
      }
      // A replay of an already-consumed idempotent input intentionally yields no
      // new turn_end. Recover the canonical prior outcome instead of silently
      // downgrading verified work to not_applicable.
      if (events.length === 0) {
        const replayed = this.opts.sessionKernel?.getSession(input.id);
        if (replayed) {
          status = replayed.executionState === "completed" ? "completed" : "failed";
          workStatus = replayed.workOutcome === "pending" ? "unverified" : replayed.workOutcome;
        }
      }
      const history = session.history();
      const lastAssistant = [...history].reverse().find((message) => message.role === "assistant");
      const finalText = lastAssistant
        ? lastAssistant.content
            .filter((block): block is import("@ares/protocol").TextBlock => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .trim()
        : "";
      return {
        engine: session.engine,
        events,
        history,
        streamedText,
        finalText,
        usage,
        status,
        workStatus,
      };
    });
  }
}

function stableScopedId(prefix: string, ...parts: Array<string | undefined>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part ?? "");
    hash.update("\0");
  }
  return `${prefix}_${hash.digest("hex").slice(0, 32)}`;
}

function backgroundRequestJson(req: SubagentRunRequest): JsonValue {
  return {
    version: 1,
    subagentType: req.subagent_type,
    description: req.description,
    prompt: req.prompt,
    parentSessionId: req.parentSessionId ?? null,
    invocationId: req.invocationId ?? null,
    taskId: req.taskId ?? null,
    workspace: path.resolve(req.workspace),
  };
}

function parseBackgroundRequest(job: BackgroundJobRecord): SubagentRunRequest | null {
  const raw = job.request && typeof job.request === "object" && !Array.isArray(job.request)
    ? job.request as Record<string, JsonValue>
    : null;
  if (!raw || raw.version !== 1) return null;
  const subagentType = typeof raw.subagentType === "string" ? raw.subagentType : null;
  const description = typeof raw.description === "string" ? raw.description : null;
  const prompt = typeof raw.prompt === "string" ? raw.prompt : null;
  const parentSessionId = typeof raw.parentSessionId === "string" ? raw.parentSessionId : null;
  const invocationId = typeof raw.invocationId === "string" ? raw.invocationId : null;
  const workspace = typeof raw.workspace === "string" ? raw.workspace : null;
  if (!subagentType || !description || !prompt || !parentSessionId || !invocationId || !workspace) return null;
  return {
    subagent_type: subagentType,
    description,
    prompt,
    parentSessionId,
    invocationId,
    ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
    workspace,
  };
}

function taskIdForBackgroundJob(job: BackgroundJobRecord): string {
  if (job.childSessionId) return job.childSessionId;
  const req = parseBackgroundRequest(job);
  return req?.taskId ?? stableScopedId("agent", job.sessionId, job.invocationKey);
}

function backgroundSnapshot(job: BackgroundJobRecord): BackgroundSubagentSnapshot {
  return {
    jobId: job.id,
    taskId: taskIdForBackgroundJob(job),
    status: job.status,
    description: job.description,
    result: job.result,
    error: job.error,
    cancelRequested: job.cancelRequested,
    createdAtMs: job.createdAtMs,
    startedAtMs: job.startedAtMs,
    finishedAtMs: job.finishedAtMs,
  };
}

function isTerminalBackgroundTask(job: BackgroundJobRecord): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "orphaned";
}

function subagentResultJson(result: SubagentRunResult): JsonValue {
  return {
    agentId: result.id,
    taskId: result.id,
    type: result.type,
    status: result.status,
    workStatus: result.workStatus,
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    transcriptPath: result.transcriptPath,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ...(result.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: result.usage.cacheReadTokens }),
      ...(result.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: result.usage.cacheWriteTokens }),
      ...(result.usage.reasoningTokens === undefined ? {} : { reasoningTokens: result.usage.reasoningTokens }),
      ...(result.usage.modelCalls === undefined ? {} : { modelCalls: result.usage.modelCalls }),
    },
  };
}

function renderBackgroundTaskCompletion(
  result: SubagentRunResult,
  status: "completed" | "failed" | "cancelled",
): string {
  const summary = result.summary.length > 30_000
    ? `${result.summary.slice(0, 30_000)}\n… [summary truncated; full transcript: ${result.transcriptPath}]`
    : result.summary;
  return [
    `[background task ${result.id} ${status}/${result.workStatus}]`,
    summary,
    result.transcriptPath ? `Transcript: ${result.transcriptPath}` : "",
  ].filter(Boolean).join("\n\n");
}

function backgroundCompletion(
  job: BackgroundJobRecord,
  status: "completed" | "failed" | "cancelled" | "orphaned",
  text: string,
): { id: string; idempotencyKey: string; payload: JsonValue } {
  return {
    id: stableScopedId("input", job.sessionId, job.id, "completion"),
    idempotencyKey: `background-job:${job.id}:completion`,
    payload: {
      kind: "background-job-completion",
      jobId: job.id,
      taskId: taskIdForBackgroundJob(job),
      status,
      content: [{ type: "text", text }],
    },
  };
}
