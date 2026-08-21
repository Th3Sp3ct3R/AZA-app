// Extracted from entry.ts — permissions.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { type PathAccess, type PathGrantScope, type PathPermissionStore, type CommandPermissionStore } from "@ares/tools";
import type { PermissionPromptDecision, PermissionRule, PermissionRuleEffect } from "@ares/protocol";
import type { ToolPermissionRequest } from "@ares/core";
import { permissionPrompt } from "../terminalUi.js";
import { CliRuntimeContext } from "./runtime.js";

interface StoredPathGrant {
  path: string;
  access: PathAccess;
}

interface StoredPathPermissions {
  alwaysAllow: StoredPathGrant[];
}

export class AresPathPermissionStore implements PathPermissionStore {
  private onceAllow: StoredPathGrant[] = [];

  private constructor(
    private readonly filePath: string,
    private readonly selfRoot: string,
    private readonly persisted: StoredPathPermissions,
  ) {}

  static async load(context: CliRuntimeContext): Promise<AresPathPermissionStore> {
    const filePath = path.join(context.aresHome, "path-permissions.json");
    let persisted: StoredPathPermissions = { alwaysAllow: [] };
    try {
      persisted = JSON.parse(await readFile(filePath, "utf8")) as StoredPathPermissions;
      persisted.alwaysAllow ??= [];
    } catch {
      // First run.
    }
    return new AresPathPermissionStore(filePath, context.home, persisted);
  }

  isAllowed(absPath: string, access: PathAccess): boolean {
    const candidate = path.resolve(absPath);
    if ((access === "read" || access === "write") && pathContains(this.selfRoot, candidate)) {
      return true;
    }
    return [...this.onceAllow, ...this.persisted.alwaysAllow].some(
      (grant) => accessCovers(grant.access, access) && pathContains(grant.path, candidate),
    );
  }

  async grant(absPath: string, access: PathAccess, scope: PathGrantScope): Promise<void> {
    const grant = { path: path.resolve(absPath), access };
    if (scope === "once") {
      this.onceAllow.push(grant);
      return;
    }
    if (!this.persisted.alwaysAllow.some((g) => g.path === grant.path && g.access === grant.access)) {
      this.persisted.alwaysAllow.push(grant);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.persisted, null, 2) + "\n", "utf8");
    }
  }
}

interface StoredCommandPermissions {
  rules?: Array<{
    pattern: string;
    effect: PermissionRuleEffect;
  }>;
}

export class AresCommandPermissionStore implements CommandPermissionStore {
  private constructor(
    private readonly rules: PermissionRule[],
    private readonly userGlobalPath: string,
  ) {}

  static async load(context: CliRuntimeContext): Promise<AresCommandPermissionStore> {
    const files = [
      path.join(context.aresHome, "command-permissions.json"),
      path.join(context.workspace, ".ares", "command-permissions.json"),
    ];
    const rules: PermissionRule[] = [];
    for (const file of files) {
      try {
        const json = JSON.parse(await readFile(file, "utf8")) as StoredCommandPermissions;
        for (const rule of json.rules ?? []) {
          rules.push({
            pattern: rule.pattern,
            effect: rule.effect,
            source: file.startsWith(path.join(context.workspace, ".ares")) ? "project" : "user-global",
          });
        }
      } catch {
        // No command rules configured.
      }
    }
    return new AresCommandPermissionStore(rules, files[0]);
  }

  /** Persist an "always allow this command" grant chosen at the prompt. Without
   *  this, picking "allow always" on a Bash/PowerShell command behaved exactly
   *  like "allow once" — the store was read-only, so the next session re-asked. */
  async grant(toolName: string, command: string, scope: PathGrantScope): Promise<void> {
    if (scope !== "always") return;
    const pattern = `${toolName}(${command})`;
    if (this.rules.some((r) => r.pattern === pattern && r.effect === "allow")) return;
    // Effective immediately this session…
    this.rules.push({ pattern, effect: "allow", source: "user-global" });
    // …and written to the user-global store so the next session won't re-ask.
    let stored: StoredCommandPermissions = { rules: [] };
    try {
      stored = JSON.parse(await readFile(this.userGlobalPath, "utf8")) as StoredCommandPermissions;
    } catch {
      // First grant — the file doesn't exist yet.
    }
    const existing = stored.rules ?? [];
    if (!existing.some((r) => r.pattern === pattern && r.effect === "allow")) {
      stored.rules = [...existing, { pattern, effect: "allow" }];
      await mkdir(path.dirname(this.userGlobalPath), { recursive: true });
      await writeFile(this.userGlobalPath, JSON.stringify(stored, null, 2) + "\n", "utf8");
    }
  }

  decide(toolName: string, command: string) {
    const target = `${toolName}(${command})`;
    const rule = [...this.rules].reverse().find((r) => wildcardToRegExp(r.pattern).test(target));
    if (!rule) return null;
    if (rule.effect === "allow") return { kind: "allow" as const, reason: `matched ${rule.pattern}` };
    if (rule.effect === "deny") return { kind: "deny" as const, reason: `${toolName} denied by rule ${rule.pattern}` };
    return {
      kind: "ask" as const,
      prompt: `${toolName} matched command permission rule ${rule.pattern}`,
      suggestion: "allow_once" as const,
    };
  }
}

function accessCovers(granted: PathAccess, requested: PathAccess): boolean {
  if (granted === "all") return true;
  if (granted === requested) return true;
  return granted === "write" && requested === "read";
}

function pathContains(rootPath: string, candidate: string): boolean {
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$", "i");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePermissionDecision(value: unknown): PermissionPromptDecision | null {
  return value === "allow_once" || value === "allow_always" || value === "deny" ? value : null;
}

export function cleanCommandId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Sensitive categories that ALWAYS ask the owner, even in the freedom posture.
// Everything else auto-approves so the agent's flow isn't interrupted.
const SENSITIVE_PERMISSION = new RegExp(
  [
    "credential", "secret", "api[ _-]?key", "password", "passphrase", "private key",
    "payment", "purchase", "checkout", "billing", "charge", "credit card", "\\bcard\\b",
    "send (an )?email", "email[_ ]send", "send mail",
    "external account", "log ?in to", "sign ?in to", "oauth",
    "rm -rf", "wipe", "format disk", "drop database", "force[- ]?push", "delete account",
    "delete data", "discard uncommitted work", "destructive shell",
    // ComputerUse drives the real machine — always confirm with the owner in
    // guarded mode (bypass/unleashed still flows, by the owner's own choice).
    "computer ?use", "control (the )?(mouse|keyboard|screen|desktop)",
    // Outward-facing / money tools always confirm — publishing, charging, mailing.
    "\\bdeploy\\b", "\\bstripe\\b", "payment link", "\\bemail\\b",
    // The agent explicitly handing a blocked step (2FA/captcha/payment) to the owner.
    "request[_ ]?user[_ ]?action", "hand off", "needs you",
  ].join("|"),
  "i",
);

function autoPermissionDecision(request: ToolPermissionRequest): PermissionPromptDecision | null {
  const hay = `${request.toolName} ${request.reason}`;
  if (SENSITIVE_PERMISSION.test(hay)) return null; // escalate to the owner
  return "allow_once"; // flow freely
}

export async function promptPermission(request: ToolPermissionRequest): Promise<PermissionPromptDecision> {
  if (request.signal?.aborted) return "deny";
  process.stderr.write("\n" + permissionPrompt(request));
  const key = await readPermissionKey(request.signal);
  process.stderr.write(`${key}\n`);
  if (key === "1") return "allow_once";
  if (key === "2") return "allow_always";
  return "deny";
}

async function readPermissionKey(signal?: AbortSignal): Promise<"1" | "2" | "3"> {
  const stream = stdin as typeof stdin & {
    setRawMode?: (mode: boolean) => void;
    isRaw?: boolean;
  };
  if (!stdin.isTTY || !stream.setRawMode) {
    return readPermissionLine(signal);
  }

  return new Promise((resolve) => {
    const wasRaw = stream.isRaw === true;
    let settled = false;
    const cleanup = () => {
      stdin.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      if (!wasRaw) stream.setRawMode?.(false);
      stdin.pause();
    };
    const settle = (key: "1" | "2" | "3") => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(key);
    };
    const onAbort = () => settle("3");
    const onData = (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        process.stderr.write("\n");
        process.exit(130);
      }
      if (key === "1" || key === "2" || key === "3") {
        settle(key);
        return;
      }
      process.stderr.write("\x07");
    };
    stream.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readPermissionLine(signal?: AbortSignal): Promise<"1" | "2" | "3"> {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    while (true) {
      let answer: string;
      try {
        answer = (await rl.question("Choose 1, 2, or 3: ", { signal })).trim();
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "3";
        throw error;
      }
      if (answer === "1" || answer === "2" || answer === "3") return answer;
      process.stderr.write("Please enter 1, 2, or 3.\n");
    }
  } finally {
    rl.close();
  }
}
