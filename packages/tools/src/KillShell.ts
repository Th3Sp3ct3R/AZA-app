// KillShell — terminate a backgrounded shell.

import { z } from "zod";
import { buildTool } from "./_shared.js";
import type { ShellRegistry } from "./ShellRegistry.js";

const inputSchema = z
  .object({
    shell_id: z.string().describe("Shell id returned by Bash/PowerShell run_in_background=true."),
  })
  .strict();

export interface KillShellOutput {
  shell_id: string;
  killed: boolean;
  reason: string;
}

export function makeKillShellTool(registry: ShellRegistry) {
  return buildTool({
    name: "KillShell",
    description:
      "Terminate a background shell by id. Returns whether the kill landed. Useful for stopping dev servers, watchers, or runaway processes started with Bash/PowerShell run_in_background=true.",
    safety: "destructive",
    concurrency: "exclusive",
    inputZod: inputSchema,
    activityDescription: (i) => `KillShell ${i.shell_id}`,
    async call(i, ctx): Promise<{ output: KillShellOutput; display: string }> {
      const routedRegistry = ctx.shellRegistry ?? registry;
      if (!routedRegistry.has(i.shell_id, ctx.sessionId)) {
        return {
          output: { shell_id: i.shell_id, killed: false, reason: "unknown shell id" },
          display: `unknown shell: ${i.shell_id}`,
        };
      }
      // Capture status BEFORE the kill so a `killed:false` can be reported
      // HONESTLY: "already finished" (it wasn't running) vs "kill failed — the
      // process may still be running" (it WAS running and the kill didn't land).
      // Collapsing both into "already finished" would lie about a live process.
      const wasRunning = routedRegistry.get(i.shell_id, ctx.sessionId)?.status === "running";
      const killed = await routedRegistry.kill(i.shell_id, "user", ctx.sessionId);
      const reason = killed
        ? "killed"
        : wasRunning
          ? "kill failed — the process may still be running"
          : "already finished";
      return {
        output: { shell_id: i.shell_id, killed, reason },
        display: killed ? `killed ${i.shell_id}` : `${i.shell_id}: ${reason}`,
      };
    },
  });
}
