// BackgroundTasks — see, stop, and resume the background work THIS session owns.
//
// Until now the model could start background shells (Bash run_in_background),
// poll one by id (BashOutput), and kill one by id (KillShell) — but there was
// no way to ask "what is still running?". BashOutput's own error text told the
// model to "use Bash list to see active shells", a command that does not exist.
// So a turn that launched a dev server and moved on had no way to find it
// again, and neither did the next turn, or the next session. Work nobody can
// enumerate is work nobody can stop.
//
// This is that missing surface, and it is deliberately session-scoped: a job
// belongs to the session that started it, and no other session can see or touch
// it.

import { z } from "zod";
import { buildTool } from "./_shared.js";
import type { ShellRegistry, ShellSnapshot } from "./ShellRegistry.js";

const inputSchema = z
  .object({
    action: z
      .enum(["list", "stop", "resume"])
      .default("list")
      .describe("list = every background job this session owns; stop = end one; resume = relaunch one that was suspended."),
    shell_id: z.string().optional().describe("Required for stop and resume."),
  })
  .strict();

export interface BackgroundTasksOutput {
  jobs: ShellSnapshot[];
  running: number;
  resumable: number;
  /** Present for stop/resume — what actually happened to the named job. */
  action?: { shell_id: string; outcome: string };
}

/** One line per job, in the order a person would want to read them. */
function line(job: ShellSnapshot): string {
  const state = job.suspended
    ? `suspended${job.resumable ? ", resumable" : ""}${job.stoppedReason ? ` (${job.stoppedReason})` : ""}`
    : job.status;
  const exit = job.exitCode === null || job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
  return `${job.id} · ${state}${exit} · ${job.description} · ${job.command.slice(0, 80)}`;
}

export function makeBackgroundTasksTool(registry: ShellRegistry) {
  return buildTool({
    name: "BackgroundTasks",
    description:
      "List, stop, or resume the background jobs this session owns. Use `list` before you finish a turn that started background work — anything still running is something the user will be left with. Jobs are stopped automatically when a turn is interrupted or the app closes, and stopped-that-way jobs show as suspended+resumable; `resume` relaunches one exactly as it was. Nothing resumes on its own.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: inputSchema,
    activityDescription: (i) =>
      i.action === "stop"
        ? `Stopping background job ${i.shell_id ?? ""}`
        : i.action === "resume"
          ? `Resuming background job ${i.shell_id ?? ""}`
          : "Checking background jobs",
    async call(i, ctx): Promise<{ output: BackgroundTasksOutput; display: string }> {
      const routed = ctx.shellRegistry ?? registry;
      let action: BackgroundTasksOutput["action"];

      if (i.action === "stop" || i.action === "resume") {
        if (!i.shell_id) throw new Error(`BackgroundTasks ${i.action} requires shell_id`);
        if (i.action === "stop") {
          const wasRunning = routed.get(i.shell_id, ctx.sessionId)?.status === "running";
          const killed = await routed.kill(i.shell_id, "user", ctx.sessionId);
          action = {
            shell_id: i.shell_id,
            outcome: killed
              ? "stopped"
              : wasRunning
                ? "stop failed — the process may still be running"
                : "was already finished",
          };
        } else {
          const resumed = await routed.resume(i.shell_id, ctx.sessionId);
          action = { shell_id: resumed.id, outcome: `resumed as ${resumed.id} (${resumed.status})` };
        }
      }

      const jobs = routed.list(ctx.sessionId);
      const running = jobs.filter((job) => job.status === "running").length;
      const resumable = jobs.filter((job) => job.resumable === true).length;
      const body = jobs.length ? jobs.map(line).join("\n") : "No background jobs in this session.";
      return {
        output: { jobs, running, resumable, ...(action ? { action } : {}) },
        display: action
          ? `${action.shell_id}: ${action.outcome} · ${running} still running`
          : `${jobs.length} job${jobs.length === 1 ? "" : "s"} · ${running} running · ${resumable} resumable\n${body}`,
      };
    },
  });
}
