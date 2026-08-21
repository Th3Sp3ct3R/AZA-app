// PowerShell — execute a PowerShell command with timeout.
//
// Windows-first tool. Uses pwsh.exe if available (PowerShell 7+),
// otherwise falls back to powershell.exe (Windows PowerShell 5.1).

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildTool,
  describeShellActivity,
  destructiveShellDecision,
  irrecoverableShellRefusal,
  resolveWorkspacePath,
  shellInputSchema,
  shellRepositoryInstructionDecision,
} from "./_shared.js";
import { runShell } from "./Bash.js";

const inputSchema = shellInputSchema("PowerShell command line.");

export const PowerShellTool = buildTool({
  name: "PowerShell",
  description:
    "Run a PowerShell command. Foreground by default; pass run_in_background=true for dev servers/watchers/builds — returns a shell_id, then use BashOutput to poll. Use this on Windows for native PowerShell syntax; use Bash for POSIX scripts. Commands ALREADY run from the workspace root — do NOT prefix `cd <workspace>`; set the `cwd` field only to run in a different directory. ALWAYS quote paths that contain spaces (the workspace path can contain spaces, e.g. \"Ares Workspace\") — an unquoted spaced path makes `cd`/`Set-Location` fail with 'positional parameter' errors; this matters most when launching a detached/new-window process where you must include the path yourself.",
  safety: "workspace-write",
  concurrency: "exclusive",
  // Self-capping (own per-command timeout + run_in_background) — uncapped here.
  watchdogTimeoutMs: 0,
  inputZod: inputSchema,
  activityDescription: (i) => describeShellActivity(i.command, i.run_in_background === true),
  commandFor: (i) => i.command,
  async checkPermissions(i, ctx) {
    const instructionDecision = await shellRepositoryInstructionDecision(ctx, i.cwd, i.target_paths);
    if (instructionDecision) return instructionDecision;
    const configured = ctx.commandPermissions?.decide("PowerShell", i.command);
    // An explicit persisted/user grant is authoritative. Without this early
    // return the generic destructive heuristic could silently override an
    // "allow always" decision on every subsequent PowerShell invocation.
    if (configured) return configured;
    return destructiveShellDecision(i.command) ?? { kind: "allow" };
  },

  async call(i, ctx) {
    // See Bash.call — refused at execution because bypass mode auto-allows
    // every permission prompt, and this loss cannot be undone.
    const refusal = irrecoverableShellRefusal(i.command);
    if (refusal) throw new Error(refusal);
    const cwd = await resolveWorkspacePath(ctx, i.cwd, "cwd", "execute");
    const pwsh = (await which("pwsh")) ?? (await which("powershell"));
    if (!pwsh) throw new Error("Neither pwsh nor powershell found on PATH");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", i.command];

    if (i.run_in_background) {
      if (!ctx.shellRegistry) {
        throw new Error("run_in_background requires a shell registry on the session context");
      }
      // Await the real launch — spawn() now resolves only after the child
      // actually started (or throws toolError if it failed to), so we never
      // return a false {status:'running'} for a process that never ran.
      const snap = await ctx.shellRegistry.spawn({
        program: pwsh,
        args,
        cwd,
        description: i.description,
        sessionId: ctx.sessionId,
        invocationKey: ctx.toolUseId ?? `legacy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
      });
      const output: unknown = {
        shell_id: snap.id,
        command: snap.command,
        status: snap.status,
        description: snap.description,
        cwd: snap.cwd,
        exitCode: snap.exitCode,
        ...(snap.outputPath ? { outputPath: snap.outputPath } : {}),
      };
      return {
        output,
        display: `[background] ${snap.id}: ${i.command.slice(0, 50)}`,
      };
    }

    const captureDir = path.join(ctx.workspace, ".ares", "shell-output", ctx.sessionId);
    await fs.mkdir(captureDir, { recursive: true });
    const capturePath = path.join(captureDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.log`);
    const result = await runShell(pwsh, args, cwd, i.timeout, ctx.signal, (stream, text) => {
      ctx.emitProgress?.({ kind: "shell_output", stream, text });
    }, capturePath);
    const output: unknown = result;
    const failure = result.timedOut
      ? `PowerShell timed out after ${i.timeout}ms`
      : result.exitCode === 0
        ? undefined
        : `PowerShell exited with code ${result.exitCode ?? "unknown"}`;
    return {
      output,
      ...(failure ? { failure } : {}),
      display: result.timedOut
        ? `PowerShell timed out after ${i.timeout}ms`
        : result.exitCode === 0
        ? `PowerShell exited 0 in ${result.durationMs}ms`
        : `PowerShell failed with exit ${result.exitCode} in ${result.durationMs}ms`,
    };
  },
});

async function which(bin: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const p of paths) {
    for (const ext of exts) {
      const candidate = path.join(p, bin + ext);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}
