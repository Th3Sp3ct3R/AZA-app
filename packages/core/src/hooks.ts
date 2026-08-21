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
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
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
  /** Number of matching shell hooks that actually entered execution. */
  executed: number;
}

/** Stable, serializable identity for one configured hook. QueryEngine uses the
 * id as part of the durable synthetic tool-use key, so a crash never turns a
 * half-finished hook into an anonymous side effect. */
export interface HookInvocation {
  id: string;
  event: HookEvent;
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface HookInvocationResult {
  invocation: HookInvocation;
  blocked: boolean;
  reminders: string[];
  /** True only after the child process emitted `spawn`. */
  entered: boolean;
  exitCode: number | null;
  output: string;
}

export class HookManager {
  private reminders: string[] = [];
  private readonly invocations: HookInvocation[];

  constructor(hooks: HookConfigEntry[]) {
    this.invocations = hooks.map((hook, index) => ({
      ...hook,
      id: `hook_${createHash("sha256")
        .update(`${index}\0${hook.event}\0${hook.matcher ?? ""}\0${hook.command}\0${hook.timeoutMs ?? ""}`)
        .digest("hex")
        .slice(0, 32)}`,
    }));
  }

  static async load(workspace: string): Promise<HookManager> {
    const hooks: HookConfigEntry[] = [];
    for (const file of hookConfigFiles(workspace)) {
      try {
        appendValidHooks(hooks, await fs.readFile(file, "utf8"));
      } catch {
        // absent/invalid configs do not block startup
      }
    }
    return new HookManager(hooks);
  }

  /** Synchronous twin for hosts whose public session factory is synchronous
   * (notably Garrison). Configuration files are tiny and this runs only while
   * composing a new session, never on the tool/event hot path. Keeping parsing
   * here guarantees sync and async child surfaces see the exact same hooks. */
  static loadSync(workspace: string): HookManager {
    const hooks: HookConfigEntry[] = [];
    for (const file of hookConfigFiles(workspace)) {
      try {
        appendValidHooks(hooks, readFileSync(file, "utf8"));
      } catch {
        // Match load(): absent/invalid configs do not block startup.
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
    const matching = this.matching(input);
    const reminders: string[] = [];
    let blocked = false;
    for (const invocation of matching) {
      const result = await this.runInvocation(invocation, input);
      reminders.push(...result.reminders);
      blocked ||= result.blocked;
    }
    return { blocked, reminders, executed: matching.length };
  }

  /** Resolve matching hooks without running them. This split lets the engine
   * durably admit/checkpoint each PostToolUse hook before entering host code. */
  matching(input: HookRunInput): HookInvocation[] {
    return this.invocations
      .filter(
        (hook) => hook.event === input.event && matchesHook(hook.matcher, input.toolName, input.input),
      )
      .map((hook) => ({ ...hook }));
  }

  /** Run exactly one previously resolved hook. */
  async runInvocation(invocation: HookInvocation, input: HookRunInput): Promise<HookInvocationResult> {
    if (invocation.event !== input.event) {
      throw new Error(`hook ${invocation.id} belongs to ${invocation.event}, not ${input.event}`);
    }
    const result = await runHookCommand(invocation, input);
    const reminders: string[] = [];
    if (result.exitCode !== 0) {
      const msg = `${invocation.event} hook failed (${invocation.command}) for ${input.toolName ?? "session"}: exit ${result.exitCode ?? "killed"}\n${result.output}`;
      reminders.push(msg);
      this.reminders.push(msg);
    }
    return {
      invocation,
      blocked: invocation.event === "PreToolUse" && reminders.length > 0,
      reminders,
      entered: result.entered,
      exitCode: result.exitCode,
      output: result.output,
    };
  }
}

function hookConfigFiles(workspace: string): string[] {
  const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
  return [path.join(home, "hooks.json"), path.join(workspace, ".ares", "hooks.json")];
}

function appendValidHooks(target: HookConfigEntry[], raw: string): void {
  const json = JSON.parse(raw) as { hooks?: HookConfigEntry[] };
  for (const hook of json.hooks ?? []) {
    if (hook.event && hook.command) target.push(hook);
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
  hook: HookInvocation,
  input: HookRunInput,
): Promise<{ entered: boolean; exitCode: number | null; output: string }> {
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
    let entered = false;
    child.once("spawn", () => {
      entered = true;
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
      resolve({ entered, exitCode: code, output: output.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ entered, exitCode: null, output: err.message });
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
