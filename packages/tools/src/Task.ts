// Task — spawn a subagent with a scoped tool whitelist.
//
// The model sees `subagent_type` as one of the registered types (e.g.
// general-purpose, researcher, code-reviewer). Each type has its own
// tool whitelist and system prompt. The subagent runs to completion in
// isolation and returns ONE summary string — the parent context stays
// clean.
//
// Tool description aggressively pushes the model to use Task for
// search-heavy or context-heavy tasks (the goal: subagents used
// NATURALLY without explicit user prompting).

import { z } from "zod";
import type { ToolCallContext } from "@ares/core";
import type { WorkStatus } from "@ares/protocol";
import { buildTool } from "./_shared.js";

export interface SubagentRunner {
  run(req: {
    subagent_type: string;
    description: string;
    prompt: string;
    parentSessionId?: string;
    /** Stable identity of the parent Task tool call. A replay after a crash
     * must resume the same child and input, not spawn duplicate work. */
    invocationId?: string;
    taskId?: string;
    workspace: string;
    signal?: AbortSignal;
    /** Forward child activity (tool_start/tool_end) so the UI isn't a silent
     *  "Delegating…" for up to 40 inner turns. */
    onProgress?: (data: unknown) => void;
    /** Bubble the child's permission prompts to the PARENT session's prompt.
     *  Without this, a subagent that touches anything outside the workspace
     *  hard-fails ("escapes workspace and no permission prompt is available")
     *  — the exact way a 5-researcher fan-out died 5/5 when the user's mods
     *  lived in a sibling folder the fleet had never been granted. */
    requestPermission?: ToolCallContext["requestPermission"];
  }): Promise<{
    id: string;
    type: string;
    status: "completed" | "failed" | "cancelled";
    workStatus: WorkStatus;
    summary: string;
    toolCallCount: number;
    durationMs: number;
    transcriptPath: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;
  startBackground?(req: {
    subagent_type: string;
    description: string;
    prompt: string;
    parentSessionId?: string;
    invocationId?: string;
    taskId?: string;
    workspace: string;
    requestPermission?: ToolCallContext["requestPermission"];
  }): Promise<{ jobId: string; taskId: string; status: BackgroundTaskStatus }>;
  getBackground?(jobId: string, parentSessionId: string): BackgroundTaskSnapshot | null;
  cancelBackground?(jobId: string, parentSessionId: string): Promise<BackgroundTaskSnapshot | null>;
  listTypes(): Array<{ name: string; description: string }>;
  has(name: string): boolean;
}

export interface TaskOutput {
  agentId: string;
  taskId: string;
  type: string;
  status: "completed" | "failed" | "cancelled";
  workStatus: WorkStatus;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  transcriptPath: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; modelCalls?: number };
}

export type BackgroundTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "orphaned";

export interface TaskBackgroundOutput {
  jobId: string;
  taskId: string;
  status: BackgroundTaskStatus;
  description: string;
}

export interface BackgroundTaskSnapshot extends TaskBackgroundOutput {
  result: unknown;
  error: unknown;
  cancelRequested: boolean;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

const inputSchema = z
  .object({
    description: z
      .string()
      .min(1)
      .describe("3-5 word task label shown in the UI (e.g. 'Find auth handler')."),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Self-contained instructions for the subagent. Be DETAILED — the subagent has none of your conversation context. Include exactly what to research/produce.",
      ),
    subagent_type: z
      .string()
      .min(1)
      .describe(
        "Which subagent type to spawn. Common: 'general-purpose' (full tools, can edit), 'researcher' (read-only investigation), 'code-reviewer' (review pending diff).",
      ),
    task_id: z
      .string()
      .min(1)
      .optional()
      .describe("Durable task id returned by an earlier Task call. Set it to continue that exact child with its prior context."),
    run_in_background: z
      .boolean()
      .default(false)
      .describe("Detach this subagent from the foreground turn. Returns durable job_id/task_id immediately; poll with TaskOutput or cancel with KillTask. The child resumes after an Ares restart."),
  })
  .strict();

export function makeTaskTool(runner: SubagentRunner) {
  return buildTool({
    name: "Task",
    description: buildTaskDescription(runner),
    // General-purpose children can write the parent workspace. Classify the
    // wrapper conservatively so the parent takes a full pre-tool checkpoint;
    // Session diffs it afterward and promotes exact child edits into journal +
    // verifier evidence. Read-only researchers pay a cached checkpoint, but no
    // delegated writer can bypass parent completion proof.
    safety: "workspace-write",
    // Parallel-safe so adjacent Task calls batch and fan out concurrently
    // (subagents are isolated engines; researcher/code-reviewer are read-only).
    // The engine now solos any tool that declares "exclusive", so this is the
    // explicit opt-in to concurrent fan-out.
    concurrency: "parallel-safe",
    // Uncapped: a subagent legitimately runs for minutes. It still inherits the
    // parent's (now deadline-bearing) signal, so a truly hung child is bounded
    // by the parent's own watchdog rather than an arbitrary subagent cap.
    watchdogTimeoutMs: 0,
    dynamicSafety: (i) => new Set(["explorer", "researcher", "code-reviewer", "verifier"]).has(i.subagent_type)
      ? "read-only"
      : "workspace-write",
    inputZod: inputSchema,
    activityDescription: (i) => `Task[${i.subagent_type}] ${i.description}`,
    async checkPermissions(i, ctx) {
      if (!runner.has(i.subagent_type)) {
        return {
          kind: "deny",
          reason: `unknown subagent_type: ${i.subagent_type}. Available: ${runner
            .listTypes()
            .map((t) => t.name)
            .join(", ")}`,
        };
      }
      if (ctx.permissionMode === "plan" && i.subagent_type === "general-purpose") {
        return {
          kind: "deny",
          reason: "general-purpose subagents are disabled in plan mode; use researcher or code-reviewer.",
        };
      }
      return { kind: "allow" };
    },
    async call(i, ctx): Promise<{ output: TaskOutput | TaskBackgroundOutput; display: string }> {
      if (i.run_in_background) {
        if (!runner.startBackground) throw new Error("background Task requires a durable subagent runner");
        const started = await runner.startBackground({
          subagent_type: i.subagent_type,
          description: i.description,
          prompt: i.prompt,
          parentSessionId: ctx.sessionId,
          invocationId: ctx.toolUseId,
          taskId: i.task_id,
          workspace: ctx.workspace,
          requestPermission: ctx.requestPermission,
        });
        return {
          output: {
            jobId: started.jobId,
            taskId: started.taskId,
            status: started.status,
            description: i.description,
          },
          display: `background ${i.subagent_type} → ${started.status} (${started.jobId})`,
        };
      }
      const result = await runner.run({
        subagent_type: i.subagent_type,
        description: i.description,
        prompt: i.prompt,
        parentSessionId: ctx.sessionId,
        invocationId: ctx.toolUseId,
        taskId: i.task_id,
        workspace: ctx.workspace,
        signal: ctx.signal,
        onProgress: ctx.emitProgress,
        // The parent's live prompt: child permission requests surface in the
        // parent UI mid-run. Grants land in the SHARED path-permission store
        // (dir-scoped), so one approval unblocks every sibling leaf.
        requestPermission: ctx.requestPermission,
      });
      // A subagent that did NOT complete is a FAILURE, not a result. Surface it
      // as a tool error (is_error) so the parent can't read a dead subagent as
      // success — the exact bug where a fleet died 8/8 yet reported "done".
      if (result.status !== "completed") {
        throw new Error(
          `subagent ${result.type} ${result.status}: ${result.summary || "no summary"}` +
            (result.transcriptPath ? ` (transcript: ${result.transcriptPath})` : ""),
        );
      }
      return {
        output: {
          agentId: result.id,
          taskId: result.id,
          type: result.type,
          status: result.status,
          workStatus: result.workStatus,
          summary: result.summary,
          toolCallCount: result.toolCallCount,
          durationMs: result.durationMs,
          transcriptPath: result.transcriptPath,
          usage: result.usage,
        },
        display: `${result.type} → ${result.status}/${result.workStatus} (${result.toolCallCount} tool calls, ${(result.durationMs / 1000).toFixed(1)}s)`,
      };
    },
  });
}

const taskOutputInputSchema = z.object({
  job_id: z.string().min(1).describe("Durable jobId returned by Task run_in_background=true."),
}).strict();

export function makeTaskOutputTool(runner: SubagentRunner) {
  return buildTool({
    name: "TaskOutput",
    description:
      "Poll a detached Task by durable job_id. Returns running/terminal truth and the complete structured result. A completed job is also injected exactly once into the parent session at its next safe boundary.",
    safety: "read-only",
    concurrency: "parallel-safe",
    inputZod: taskOutputInputSchema,
    activityDescription: (i) => `TaskOutput ${i.job_id}`,
    async call(i, ctx): Promise<{ output: BackgroundTaskSnapshot; display: string }> {
      if (!runner.getBackground) throw new Error("TaskOutput requires a durable subagent runner");
      const job = runner.getBackground(i.job_id, ctx.sessionId);
      if (!job) throw new Error(`unknown background task: ${i.job_id}`);
      return {
        output: job,
        display: `${job.jobId} · ${job.status}${job.cancelRequested ? " · cancellation requested" : ""}`,
      };
    },
  });
}

const killTaskInputSchema = z.object({
  job_id: z.string().min(1).describe("Durable jobId returned by Task run_in_background=true."),
}).strict();

export function makeKillTaskTool(runner: SubagentRunner) {
  return buildTool({
    name: "KillTask",
    description:
      "Request cancellation of a detached Task. Cancellation is durable: a remote/current worker observes it through the job lease heartbeat, and a queued job cannot start afterward.",
    safety: "destructive",
    concurrency: "exclusive",
    inputZod: killTaskInputSchema,
    activityDescription: (i) => `KillTask ${i.job_id}`,
    async call(i, ctx): Promise<{ output: BackgroundTaskSnapshot; display: string }> {
      if (!runner.cancelBackground) throw new Error("KillTask requires a durable subagent runner");
      const job = await runner.cancelBackground(i.job_id, ctx.sessionId);
      if (!job) throw new Error(`unknown background task: ${i.job_id}`);
      return {
        output: job,
        display: `${job.jobId} · ${job.status}${job.cancelRequested ? " · cancellation requested" : ""}`,
      };
    },
  });
}

function buildTaskDescription(runner: SubagentRunner): string {
  const types = runner.listTypes();
  const typeList = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return `Spawn a subagent to handle a focused sub-task autonomously. The subagent has its OWN context (no shared memory with you) and returns a single summary string when done.

WHEN TO USE (delegate when it creates parallelism or protects the parent context):
- "find all uses of X" / "where is Y handled" / "how does Z work" — use 'researcher'
- Review pending changes — use 'code-reviewer'
- A bounded subsystem task with a clear handoff that would otherwise consume 5+ noisy tool calls — use 'general-purpose'
- Anything where the raw tool output would otherwise bloat YOUR context

WHEN NOT TO USE:
- Reading a single known file (use Read directly)
- One-off Grep with a known pattern
- Simple edits in the current conversation
- Work whose conclusion or file ownership you have not defined yet — investigate/decide at the parent first

New subagents start with isolated context, so make the first prompt SELF-CONTAINED. Every result returns a durable taskId. For a follow-up, pass that value as task_id: the SAME child session resumes with its prior reads, decisions, tool outcomes, and compacted context instead of rediscovering the repository.

Two more rules that decide whether delegation actually helps:
- NEVER delegate the understanding. The subagent gathers evidence; YOU draw the conclusion. Don't write "investigate X and do what your findings suggest" — decide the direction yourself and give it a concrete objective. For a known lookup, hand it the exact command/pattern; for an open investigation, hand it the precise question.
- Be explicit about WRITE vs. RESEARCH. Say whether the subagent should change files or only report back. A 'researcher' can't write; a 'general-purpose' can — pick deliberately, and if it may edit, tell it exactly what.

Available subagent types:
${typeList}

Subagent results come back as one summary message; YOUR context never sees the intermediate tool calls. The result also reports workStatus (verified/unverified/blocked) separately from whether the child loop merely completed. This is the cheapest way to keep your context window healthy on large repos.

For a genuinely independent, long-running unit, set run_in_background=true. The call returns a durable jobId/taskId immediately; continue foreground work, poll with TaskOutput only when you need status, and use KillTask to cancel. Detached work survives an Ares host restart and its terminal handoff is injected once at the parent's next safe boundary.`;
}
