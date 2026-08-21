// BashOutput — poll a backgrounded shell for new output since last call.

import { z } from "zod";
import { buildTool } from "./_shared.js";
import type { ShellRegistry, ShellSnapshot } from "./ShellRegistry.js";

const inputSchema = z
  .object({
    shell_id: z.string().describe("Shell id returned by Bash/PowerShell run_in_background=true."),
    filter: z
      .string()
      .optional()
      .describe("Optional regex; only matching lines are returned. Unmatched lines are skipped (not buffered for later)."),
  })
  .strict();

export interface BashOutputResult {
  shell: ShellSnapshot;
  output: string;
  newChunks: number;
}

export function makeBashOutputTool(registry: ShellRegistry) {
  return buildTool({
    name: "BashOutput",
    description:
      "Retrieve new output from a background shell (one started with run_in_background=true). Returns only output since your last poll for this shell. Use with `filter` to grep on the fly. Returns the shell status so you know if it has exited.",
    safety: "read-only",
    concurrency: "parallel-safe",
    inputZod: inputSchema,
    activityDescription: (i) => `BashOutput ${i.shell_id}`,
    async call(i, ctx): Promise<{ output: BashOutputResult; display: string }> {
      const filter = i.filter ? new RegExp(i.filter) : undefined;
      const polled = (ctx.shellRegistry ?? registry).poll(i.shell_id, "bash-output-tool", filter, ctx.sessionId);
      if (!polled) {
        throw new Error(`unknown shell: ${i.shell_id}. Use Bash list to see active shells.`);
      }
      const result: BashOutputResult = {
        shell: polled.snapshot,
        output: polled.output,
        newChunks: polled.newChunks,
      };
      const status = polled.snapshot.status;
      const display = `${polled.newChunks} chunk${polled.newChunks === 1 ? "" : "s"} · status=${status}${
        polled.snapshot.exitCode !== null ? ` exit=${polled.snapshot.exitCode}` : ""
      }`;
      return { output: result, display };
    },
  });
}
