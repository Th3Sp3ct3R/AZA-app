// Bash — execute a shell command with timeout or as a background process.

import { z } from "zod";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildTool,
  describeShellActivity,
  destructiveShellDecision,
  resolveWorkspacePath,
} from "./_shared.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

const inputSchema = z
  .object({
    command: z.string().min(1).describe("Bash command line. Quote paths with spaces."),
    description: z.string().describe("5-10 word active-voice summary, e.g. 'List files in current directory'."),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS)
      .describe(`Timeout in milliseconds (max ${MAX_TIMEOUT_MS}, foreground only).`),
    cwd: z.string().optional().describe("Working directory. Defaults to workspace."),
    run_in_background: z
      .boolean()
      .default(false)
      .describe(
        "When true, the shell runs in the background and the tool returns a shell_id immediately. Poll output with BashOutput, terminate with KillShell. Use for dev servers, watchers, builds you want to monitor.",
      ),
  })
  .strict();

export interface BashOutput {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface BashBackgroundOutput {
  shell_id: string;
  command: string;
  status: "running";
  description: string;
  cwd: string;
}

export const BashTool = buildTool({
  name: "Bash",
  description:
    "Run a bash/POSIX command. By default runs foreground until completion. Set run_in_background=true to launch it in the background — the tool returns a shell_id immediately; use BashOutput to poll new output and KillShell to terminate. On Windows, prefer PowerShell unless POSIX shell syntax is specifically required. Commands ALREADY run from the workspace root — do NOT prefix `cd <workspace>`; set the `cwd` field only to run in a different directory. ALWAYS quote paths that contain spaces (the workspace path can contain spaces, e.g. \"Ares Workspace\") — unquoted spaced paths break the shell; this matters most when launching a detached/new-window process where you must include the path yourself.",
  safety: "workspace-write",
  concurrency: "exclusive",
  // Self-capping: Bash has its own per-command timeout + run_in_background.
  // Uncapped so a legit long build/test isn't severed by the class default.
  watchdogTimeoutMs: 0,
  inputZod: inputSchema,
  activityDescription: (i) => describeShellActivity(i.command, i.run_in_background === true),
  commandFor: (i) => i.command,
  async checkPermissions(i, ctx) {
    const configured = ctx.commandPermissions?.decide("Bash", i.command);
    // A configured/stored deny|ask wins as before.
    if (configured && configured.kind !== "allow") return configured;
    // An EXPLICIT prior allow (configured or `allow_always`-persisted) must win
    // over the destructive heuristic — otherwise destructiveShellDecision's
    // {kind:'ask'} short-circuited the `??` below and silently re-prompted on a
    // command the user already granted. Only re-ask for destructive commands
    // that were NEVER approved.
    if (configured?.kind === "allow") return configured;
    return destructiveShellDecision(i.command) ?? { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: unknown; display: string }> {
    const cwd = await resolveWorkspacePath(ctx, i.cwd, "cwd", "execute");
    const bash = await resolveBashProgram();

    if (i.run_in_background) {
      if (!ctx.shellRegistry) {
        throw new Error("run_in_background requires a shell registry on the session context");
      }
      // Await the real launch — spawn() now resolves only after the child
      // actually started (or throws toolError if it failed to), so we never
      // return a false {status:'running'} for a process that never ran.
      const snap = await ctx.shellRegistry.spawn({
        program: bash,
        args: ["-lc", i.command],
        cwd,
        description: i.description,
      });
      const output: BashOutput | BashBackgroundOutput = {
        shell_id: snap.id,
        command: snap.command,
        status: "running",
        description: snap.description,
        cwd: snap.cwd,
      };
      return {
        output,
        display: `[background] ${snap.id}: ${i.command.slice(0, 50)}`,
      };
    }

    const result = await runShell(bash, ["-lc", i.command], cwd, i.timeout, ctx.signal, (stream, text) => {
      ctx.emitProgress?.({ kind: "shell_output", stream, text });
    });
    const output: BashOutput | BashBackgroundOutput = result;
    return {
      output,
      display: result.timedOut
        ? `Bash timed out after ${i.timeout}ms`
        : result.exitCode === 0
        ? `Bash exited 0 in ${result.durationMs}ms`
        : `Bash failed with exit ${result.exitCode} in ${result.durationMs}ms`,
    };
  },
});

export async function runShell(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  onOutput?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<BashOutput> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // Own abort handling instead of passing `signal` to spawn. On Windows the
    // built-in path kills only PowerShell/cmd, leaving grandchildren alive with
    // inherited stdout handles so the Promise never reaches `close`.
    const child = spawn(program, args, { cwd, windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const killTree = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        });
      } else {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    };
    const onAbort = () => killTree();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) queueMicrotask(onAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      // On win32 kill the whole tree — child.kill() leaves grandchildren (dev
      // servers, watchers) alive holding ports. taskkill /T /F reaps them.
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        });
      } else {
        child.kill();
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      onOutput?.("stdout", decodeOutput(chunk));
      while (stdoutBytes > MAX_OUTPUT_CHARS * 4 && stdoutChunks.length > 1) {
        stdoutBytes -= stdoutChunks.shift()?.length ?? 0;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      onOutput?.("stderr", decodeOutput(chunk));
      while (stderrBytes > MAX_OUTPUT_CHARS * 4 && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks.shift()?.length ?? 0;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const stdout = decodeOutput(Buffer.concat(stdoutChunks));
      const stderr = decodeOutput(Buffer.concat(stderrChunks));
      const truncatedOut = stdout.length > MAX_OUTPUT_CHARS;
      const truncatedErr = stderr.length > MAX_OUTPUT_CHARS;
      resolve({
        command: `${program} ${args.join(" ")}`,
        exitCode: code,
        stdout: truncatedOut ? stdout.slice(-MAX_OUTPUT_CHARS) : stdout,
        stderr: truncatedErr ? stderr.slice(-MAX_OUTPUT_CHARS) : stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: truncatedOut || truncatedErr,
      });
    });
  });
}

let cachedBashProgram: Promise<string> | null = null;

export function resolveBashProgram(): Promise<string> {
  cachedBashProgram ??= resolveBashProgramUncached();
  return cachedBashProgram;
}

async function resolveBashProgramUncached(): Promise<string> {
  if (process.env.ARES_BASH) return process.env.ARES_BASH;
  if (process.platform !== "win32") return "bash";

  const candidates = unique([
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ...pathCandidates("bash.exe"),
    ...pathCandidates("bash"),
  ]);

  for (const candidate of candidates) {
    if (isWindowsWslLauncher(candidate)) continue;
    if (!(await exists(candidate))) continue;
    if (await bashWorks(candidate)) return candidate;
  }

  // Last resort: let spawn surface the real failure. This keeps non-Git
  // Windows hosts honest instead of silently pretending PowerShell is Bash.
  return "bash";
}

function pathCandidates(bin: string): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, bin));
}

function isWindowsWslLauncher(candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  return normalized.includes("\\windows\\system32\\bash.exe") || normalized.includes("\\windowsapps\\bash.exe");
}

async function exists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function bashWorks(candidate: string): Promise<boolean> {
  const probe = await runShell(candidate, ["-lc", "printf __ares_bash_probe__"], process.cwd(), 5000, new AbortController().signal).catch(() => null);
  return probe?.exitCode === 0 && probe.stdout.includes("__ares_bash_probe__");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function decodeOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  let oddNulls = 0;
  for (let i = 1; i < buf.length; i += 2) {
    if (buf[i] === 0) oddNulls++;
  }
  if (oddNulls > buf.length / 8) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}
