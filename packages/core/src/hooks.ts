// Hooks — shell extension points for Ares sessions and tool calls.
//
// Config files:
//   ~/.ares/hooks.json
//   <workspace>/.ares/hooks.json
//
// Shape:
// {
//   "hooks": [
//     { "event": "PreToolUse", "matcher": "Bash(git *)", "command": "node scripts/check.js", "timeoutMs": 30000 },
//     { "event": "PostToolUse", "matcher": "Edit(*)", "command": "pnpm lint" },
//     { "event": "SessionStart", "command": "echo hello" }
//   ]
// }

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type HookEvent = "SessionStart" | "PreToolUse" | "PostToolUse";

export interface HookConfigEntry {
  event: HookEvent;
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface HookRunInput {
  event: HookEvent;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  workspace: string;
}

export interface HookRunResult {
  blocked: boolean;
  reminders: string[];
}

export class HookManager {
  private reminders: string[] = [];

  constructor(private readonly hooks: HookConfigEntry[]) {}

  static async load(workspace: string): Promise<HookManager> {
    const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
    const files = [path.join(home, "hooks.json"), path.join(workspace, ".ares", "hooks.json")];
    const hooks: HookConfigEntry[] = [];
    for (const file of files) {
      try {
        const json = JSON.parse(await fs.readFile(file, "utf8")) as { hooks?: HookConfigEntry[] };
        for (const hook of json.hooks ?? []) {
          if (hook.event && hook.command) hooks.push(hook);
        }
      } catch {
        // absent/invalid configs do not block startup
      }
    }
    return new HookManager(hooks);
  }

  drainReminders(): Array<{ text: string; source: "hook" }> {
    const out = this.reminders.map((text) => ({ text, source: "hook" as const }));
    this.reminders = [];
    return out;
  }

  async run(input: HookRunInput): Promise<HookRunResult> {
    const matching = this.hooks.filter(
      (hook) => hook.event === input.event && matchesHook(hook.matcher, input.toolName, input.input),
    );
    const reminders: string[] = [];
    let blocked = false;
    for (const hook of matching) {
      const result = await runHookCommand(hook, input);
      if (result.exitCode !== 0) {
        const msg = `${hook.event} hook failed (${hook.command}) for ${input.toolName ?? "session"}: exit ${result.exitCode ?? "killed"}\n${result.output}`;
        reminders.push(msg);
        this.reminders.push(msg);
        if (hook.event === "PreToolUse") blocked = true;
      }
    }
    return { blocked, reminders };
  }
}

function matchesHook(matcher: string | undefined, toolName: string | undefined, input: unknown): boolean {
  if (!matcher || matcher === "*") return true;
  const name = toolName ?? "";
  const command = input && typeof input === "object" ? String((input as Record<string, unknown>).command ?? "") : "";
  const simple = `${name}(${command || "*"})`;
  return wildcardToRegExp(matcher).test(simple) || wildcardToRegExp(matcher).test(name);
}

function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$", "i");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runHookCommand(
  hook: HookConfigEntry,
  input: HookRunInput,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    // Full payload goes on STDIN as one JSON line — env vars have a hard size
    // limit (~32KB/var on Windows) and a big tool input/output used to blow the
    // whole env block, failing the spawn, which the caller then treated as a
    // DENY. The env copies remain for simple hooks but are size-capped so they
    // can never crash the spawn again; a hook that needs the full data reads
    // stdin.
    const fullInput = safeJson(input.input);
    const fullOutput = safeJson(input.output);
    const stdinPayload = safeJson({
      event: input.event,
      tool: input.toolName ?? "",
      input: input.input ?? {},
      output: input.output ?? {},
      workspace: input.workspace,
    });
    const ENV_CAP = 8192; // well under the per-var limit, with headroom
    const capEnv = (s: string) => (s.length > ENV_CAP ? "" : s); // empty = "read stdin"
    const child = spawn(hook.command, {
      cwd: input.workspace,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        ARES_HOOK_EVENT: input.event,
        ARES_HOOK_TOOL: input.toolName ?? "",
        ARES_HOOK_INPUT: capEnv(fullInput),
        ARES_HOOK_OUTPUT: capEnv(fullOutput),
        // Signals to the hook that the full JSON is on stdin (always true).
        ARES_HOOK_STDIN: "1",
      },
    });
    // Deliver the payload and close stdin; ignore EPIPE if the hook doesn't read.
    try {
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdinPayload + "\n");
    } catch { /* hook closed stdin early */ }
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4000) output = output.slice(-4000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => child.kill(), hook.timeoutMs ?? 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output: output.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: err.message });
    });
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
