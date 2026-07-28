// Tool<I, O> is the per-file tool contract used across @ares/tools.
//
// Every tool owns its schema, permission check, execution, and display text.

import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ToolSchema,
  SafetyClass,
  Concurrency,
  ProviderHint,
  PermissionDecision,
  PermissionMode,
} from "@ares/protocol";
import type { ToolCallContext, EngineToolResult } from "@ares/core";

export interface FileReadStamp {
  mtimeMs: number;
  size: number;
  /** sha256 of the file content at Read time. The mtime/size guard races on
   *  coarse-granularity filesystems (Windows mtime can be ~16ms); the hash is
   *  the exact "did this change since I last saw it" check Edit/Write use. */
  hash?: string;
  /** Total line count at Read time, so the re-read guard can report the real
   *  size instead of returning something indistinguishable from an empty file. */
  lines?: number;
  /** Set by an edit tool (Edit/FindAndEdit/ApplyIntent/CodeMode.write) when it
   *  stamps a file it WROTE. The stamp still exists so a follow-up edit's
   *  read-before-write + staleness checks pass, but the model never actually
   *  read the post-edit bytes — so Read's whole-file re-read guard must do a
   *  REAL read instead of pointing at content "already in context". A real Read
   *  re-stamps without this flag, clearing it. */
  writtenNotRead?: boolean;
}

/** Cheap, stable content hash for read-stamp staleness checks. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface RichToolContext extends ToolCallContext {
  permissionMode: PermissionMode;
  fileReadStamps: Map<string, FileReadStamp>;
  pathPermissions?: PathPermissionStore;
  commandPermissions?: CommandPermissionStore;
  subModel?: SubModelPool;
  /** Optional shell process registry — required for run_in_background. */
  shellRegistry?: import("./ShellRegistry.js").ShellRegistry;
  /** Optional todo store — used by TodoWrite. */
  todoStore?: import("./TodoWrite.js").TodoStore;
}

export type PathAccess = "read" | "write" | "execute" | "all";
export type PathGrantScope = "once" | "always";

export interface PathPermissionStore {
  isAllowed(absPath: string, access: PathAccess): boolean;
  grant(absPath: string, access: PathAccess, scope: PathGrantScope): Promise<void> | void;
}

export interface CommandPermissionStore {
  decide(toolName: string, command: string): PermissionDecision | null;
  /** Persist an "always allow this command" grant chosen at the prompt, so the
   *  next session doesn't re-ask. Optional: hosts without a writable store omit
   *  it and `allow_always` simply behaves like `allow_once` (the prior behavior). */
  grant?(toolName: string, command: string, scope: PathGrantScope): Promise<void> | void;
}

export interface SubModelPool {
  apply(req: { file: string; original: string; instructions: string; sketch: string }): Promise<string>;
  /** `signal` lets a Stop during compaction abort the summarizer instead of
   *  running the sub-model to completion against an already-dead turn. */
  summarize(req: { input: string; instructions?: string; signal?: AbortSignal }): Promise<string>;
}

export interface ToolResult<O> extends EngineToolResult {
  output: O;
  touchedFiles?: string[];
  display?: string;
  /** Images for the model to see (screenshots). See EngineToolResult.images. */
  images?: Array<{ mediaType: string; data: string }>;
}

/**
 * Result of a tool's semantic input check ({@link Tool.validateInput}). `ok:false`
 * carries a model-facing message the loop wraps as a correctable
 * `<tool_use_error>` so the model fixes the call on its next turn instead of the
 * tool throwing an opaque error. Wired in Phase 4 (tool-contract hardening).
 */
export type ToolInputValidation = { ok: true } | { ok: false; message: string };

export interface Tool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  readonly schema: ToolSchema;
  readonly inputZod: I;
  /** Optional semantic check run AFTER zod parse, BEFORE call(). See {@link ToolInputValidation}.
   *  Method syntax (not an arrow property) so the parameter stays bivariant —
   *  otherwise `Tool<ConcreteSchema>` would not be assignable to `Tool<ZodTypeAny>`. */
  validateInput?(input: z.infer<I>, ctx: RichToolContext): Promise<ToolInputValidation>;
  checkPermissions(input: z.infer<I>, ctx: RichToolContext): Promise<PermissionDecision>;
  call(input: z.infer<I>, ctx: RichToolContext): Promise<ToolResult<O>>;
  activityDescription(input: z.infer<I>): string;
  /** Command string for `allow_always` persistence (Bash/PowerShell); see ToolDef. */
  commandFor?(input: z.infer<I>): string | undefined;
}

export interface ToolDef<I extends z.ZodTypeAny, O> {
  name: string;
  description: string;
  safety: SafetyClass;
  concurrency: Concurrency;
  providerHint?: ProviderHint;
  deferLoading?: boolean;
  /** Per-tool execution watchdog (ms). 0 = uncapped (self-capping tools);
   *  omitted = engine picks a class default from `safety`. */
  watchdogTimeoutMs?: number;
  /** Max chars of result kept inline before the engine spills to disk (Phase 4). */
  maxResultSizeChars?: number;
  inputZod: I;
  /** Optional semantic input check (Phase 4). See {@link ToolInputValidation}. */
  validateInput?: (input: z.infer<I>, ctx: RichToolContext) => Promise<ToolInputValidation>;
  /** Per-INPUT effective safety for the permission decision (e.g. ComputerUse's
   *  screenshot is read-only while its click is external-state). Affects ONLY the
   *  permission gate — `schema.safety` stays the static class, so watchdog
   *  defaults and conductor tool filtering remain conservative. */
  dynamicSafety?: (input: z.infer<I>) => SafetyClass;
  checkPermissions?: (input: z.infer<I>, ctx: RichToolContext) => Promise<PermissionDecision>;
  call: (input: z.infer<I>, ctx: RichToolContext) => Promise<ToolResult<O>>;
  activityDescription: (input: z.infer<I>) => string;
  /** For command tools (Bash/PowerShell): the command string from the input, so
   *  the permission gate can persist an `allow_always` grant. Tools that aren't
   *  command-shaped omit this — then `allow_always` is honored for the turn but,
   *  as before, nothing is written. */
  commandFor?: (input: z.infer<I>) => string | undefined;
}

export function buildTool<I extends z.ZodTypeAny, O>(def: ToolDef<I, O>): Tool<I, O> {
  const inputJsonSchema = normalizeProviderJsonSchema(zodToJsonSchema(def.inputZod, {
    target: "openApi3",
    $refStrategy: "none",
  })) as object;

  const schema: ToolSchema = {
    name: def.name,
    description: def.description,
    inputJsonSchema,
    safety: def.safety,
    concurrency: def.concurrency,
    providerHint: def.providerHint,
    deferLoading: def.deferLoading,
    watchdogTimeoutMs: def.watchdogTimeoutMs,
    maxResultSizeChars: def.maxResultSizeChars,
  };

  const checkPermissions = async (
    input: z.infer<I>,
    ctx: RichToolContext,
  ): Promise<PermissionDecision> => {
    const base = defaultPermissionDecision(def, ctx, def.dynamicSafety?.(input));
    if (base.kind !== "allow") return base;
    return def.checkPermissions ? def.checkPermissions(input, ctx) : base;
  };

  return {
    schema,
    inputZod: def.inputZod,
    validateInput: def.validateInput,
    checkPermissions,
    call: def.call,
    activityDescription: def.activityDescription,
    commandFor: def.commandFor,
  };
}

/**
 * Parse tool input, tolerating extra keys the model invented. Tool schemas are
 * `.strict()`, so a single plausible-but-unknown param (e.g. `max_results` on a
 * tool that doesn't take it) made Zod reject the WHOLE call — a dominant cause
 * of "most tool calls failing" with models that habitually add params. We strip
 * unrecognized keys and retry; only GENUINE validation errors (missing/typed-
 * wrong fields) still throw, with a readable message the model can correct from.
 */
export function parseToolInputLenient<S extends z.ZodTypeAny>(schema: S, input: unknown, toolName: string): z.infer<S> {
  const first = schema.safeParse(input);
  if (first.success) return first.data;

  const unknownKeyIssues = first.error.issues.filter(
    (i): i is z.ZodIssue & { keys: string[] } => i.code === "unrecognized_keys",
  );
  if (unknownKeyIssues.length > 0) {
    const stripped = stripUnknownKeys(input, unknownKeyIssues);
    const retry = schema.safeParse(stripped);
    if (retry.success) return retry.data;
    return throwToolInputError(retry.error, toolName);
  }
  return throwToolInputError(first.error, toolName);
}

function stripUnknownKeys(input: unknown, issues: Array<{ path: (string | number)[]; keys: string[] }>): unknown {
  if (input === null || typeof input !== "object") return input;
  const clone: unknown = structuredClone(input);
  for (const issue of issues) {
    let node: unknown = clone;
    for (const seg of issue.path) {
      if (node && typeof node === "object") node = (node as Record<string | number, unknown>)[seg];
    }
    if (node && typeof node === "object") {
      for (const key of issue.keys) delete (node as Record<string, unknown>)[key];
    }
  }
  return clone;
}

function throwToolInputError(error: z.ZodError, toolName: string): never {
  const detail = error.issues
    .map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
  throw new Error(`${toolName}: invalid arguments — ${detail}`);
}

/**
 * Wrap a model-facing, correctable message in a recognizable envelope. The engine
 * surfaces a thrown error's `.message` as an `is_error` tool_result, so the model
 * sees `<tool_use_error>…</tool_use_error>` and learns to fix the CALL rather than
 * treating it as a runtime failure to retry blindly. Exported so individual tools
 * can throw correctable domain errors (e.g. Edit "old_string not found") in the
 * same recognizable shape as the loop's input-validation gate.
 */
export function toolError(message: string): Error {
  return new Error(`<tool_use_error>${message}</tool_use_error>`);
}

/** Tool names the user clicked "Allow always" on this process run. Backs the
 *  non-command allow_always path in adaptToolForEngine — session-scoped on
 *  purpose (a fresh daemon starts guarded again). */
const toolAlwaysGrants = new Set<string>();

export function adaptToolForEngine(
  tool: Tool<z.ZodTypeAny, unknown>,
  enrich: (base: ToolCallContext) => RichToolContext,
): { schema: ToolSchema; call: (input: unknown, ctx: ToolCallContext) => Promise<EngineToolResult> } {
  return {
    schema: tool.schema,
    async call(input, ctx) {
      // Two-stage input validation BEFORE the tool runs (CC pattern). Bad model
      // input becomes a recognizable, correctable <tool_use_error> the model fixes
      // on its next turn — instead of an opaque throw that reads like a tool crash
      // (a dominant cause of tool-call failures and dead-loop retries).
      let parsed: z.infer<typeof tool.inputZod>;
      try {
        // Stage 1 — shape: zod parse (lenient on extra keys), throws on genuine
        // type/required errors with a readable, field-level message.
        parsed = parseToolInputLenient(tool.inputZod, input, tool.schema.name);
      } catch (e) {
        throw toolError(e instanceof Error ? e.message : String(e));
      }
      const rich = enrich(ctx);
      // Stage 2 — semantics: optional tool-specific check (e.g. "old_string not
      // found", "path escapes workspace") AFTER parse, BEFORE permission/exec.
      if (tool.validateInput) {
        const verdict = await tool.validateInput(parsed, rich);
        if (!verdict.ok) throw toolError(verdict.message);
      }
      let decision = await tool.checkPermissions(parsed, rich);
      // "Allow always" for non-command tools (ComputerUse, Browser, …) grants
      // the TOOL for the rest of the process. Before this, allow_always was a
      // silent no-op for any tool without commandFor — the user clicked Always
      // and got re-prompted on the very next action (mid-automation, moving
      // their mouse to the dialog and wrecking the run).
      if (decision.kind === "ask" && toolAlwaysGrants.has(tool.schema.name)) {
        decision = { kind: "allow" };
      }
      if (decision.kind === "deny") {
        // A policy deny ("Read the file first", "disabled in plan mode") is a
        // correctable signal — envelope it like the validation gate so the model
        // treats it as "fix the call", not an opaque crash.
        throw toolError(decision.reason);
      }
      if (decision.kind === "ask") {
        if (!ctx.requestPermission) {
          throw new Error(`permission required: ${decision.prompt}`);
        }
        const answer = await ctx.requestPermission({
          toolName: tool.schema.name,
          input: parsed,
          reason: decision.prompt,
          suggestion: decision.suggestion,
        });
        if (answer === "deny") {
          const err = new Error(`permission denied: ${tool.schema.name}`);
          err.name = "PermissionDeniedError";
          throw err;
        }
        // Persist an explicit "always allow this command" so the next session
        // doesn't re-ask. Path tools self-persist inside call() via
        // resolveWorkspacePath; command tools (Bash/PowerShell) route through
        // here. Non-command tools get a process-lifetime tool-name grant.
        if (answer === "allow_always") {
          const command = tool.commandFor?.(parsed);
          if (command !== undefined) {
            await rich.commandPermissions?.grant?.(tool.schema.name, command, "always");
          } else {
            toolAlwaysGrants.add(tool.schema.name);
          }
        }
      }
      const result = await tool.call(parsed, rich);
      return {
        output: result.output,
        touchedFiles: result.touchedFiles,
        display: result.display,
        images: result.images,
      };
    },
  };
}

export const zPath = z.string().min(1).describe("Absolute or workspace-relative path.");
export const zAbsPath = zPath;

/**
 * Cheap, synchronous file-path sanity for validateInput hooks. Returns a
 * model-facing "how to fix it" sentence, or null when the path looks concrete.
 * Catches the burns that otherwise fail deep in fs: glob metacharacters (the
 * model pasted a pattern where a single path belongs), embedded newlines
 * (a copy-paste of two lines), and NUL bytes. `workspace` (optional) also flags
 * a RELATIVE path whose `..` segments climb out of the workspace — those calls
 * always fail or mis-prompt; an absolute path is the intentional form.
 */
export function pathInputProblem(inputPath: string, workspace?: string): string | null {
  if (inputPath.trim() === "") {
    return "file path is empty — pass an absolute or workspace-relative path.";
  }
  if (/[\n\r\0]/.test(inputPath)) {
    return "file path contains a newline or NUL — pass a single path with no line breaks.";
  }
  if (/[*?"<>|]/.test(inputPath.replace(/^[A-Za-z]:/, ""))) {
    return `"${inputPath}" contains glob/wildcard characters — pass ONE concrete file path (use Glob to find files by pattern).`;
  }
  if (workspace !== undefined && !path.isAbsolute(inputPath) && inputPath.split(/[\\/]/).includes("..")) {
    const resolved = path.resolve(workspace, inputPath);
    const rel = path.relative(path.resolve(workspace), resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return `"${inputPath}" climbs out of the workspace via '..' — pass the absolute path (${resolved}) if you really mean that location.`;
    }
  }
  return null;
}

/**
 * Topic-first narration for a shell command ("Switching to main", "Running
 * tests", "Committing changes"). Mirrors the engine's narrator so the CLI strip
 * and the desktop card read identically. Shared by Bash + PowerShell.
 */
export function describeShellActivity(rawCommand: string, background: boolean): string {
  const cmd = rawCommand.trim().replace(/\s+/g, " ");
  const lead = (verb: string) => (background ? `${verb} in the background` : verb);
  const branch = /git\s+(?:checkout|switch)\s+(?:-b\s+)?([^\s&|;]+)/.exec(cmd);
  if (branch) return lead(`Switching to ${branch[1]}`);
  if (/git\s+commit/i.test(cmd)) return lead("Committing changes");
  if (/git\s+push/i.test(cmd)) return lead("Pushing to remote");
  if (/git\s+pull/i.test(cmd)) return lead("Pulling from remote");
  if (/git\s+status/i.test(cmd)) return lead("Checking git status");
  if (/git\s+(diff|log|show)/i.test(cmd)) return lead("Inspecting git history");
  if (/(pnpm|npm|yarn).*(test|vitest|jest)|node --test|\bpytest\b|cargo test/i.test(cmd)) return lead("Running tests");
  if (/(pnpm|npm|yarn).*(build|lint|tsc)|cargo build|vite build/i.test(cmd)) return lead("Building the project");
  if (/(pnpm|npm|yarn)\s+(install|i|add)|cargo add/i.test(cmd)) return lead("Installing dependencies");
  const program = cmd.split(" ")[0]?.split(/[\\/]/).pop() || "command";
  return lead(`Running ${program}`);
}

/** Commands that can erase data or discard uncommitted work. */
export function destructiveShellDecision(command: string): PermissionDecision | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  const destructive =
    /(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:rmdir|unlink|shred)\b/i.test(normalized) ||
    /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--)\b/i.test(normalized) ||
    // `format(?!-)` matches the disk-format command ("format C:") but NOT the
    // benign PowerShell Format-* cmdlets (Format-Table/List/Hex/…) — `\bformat\b`
    // alone fired on every `... | Format-Table`, falsely prompting "can delete
    // data" on read-only commands. The destructive Format-Volume is caught below.
    /\b(?:mkfs(?:\.\w+)?|wipefs|format(?!-))\b/i.test(normalized) ||
    /\bRemove-Item\b/i.test(normalized) ||
    /(?:^|[;|]\s*)(?:del|erase|rd|rmdir)\s+(?:\/[a-z]+\s+)*/i.test(normalized) ||
    /\b(?:Clear-Disk|Format-Volume|Remove-Partition)\b/i.test(normalized);

  return destructive
    ? {
        kind: "ask",
        prompt: "This shell command can delete data or discard uncommitted work.",
        suggestion: "deny",
      }
    : null;
}

function defaultPermissionDecision<I extends z.ZodTypeAny, O>(
  def: ToolDef<I, O>,
  ctx: RichToolContext,
  safetyOverride?: SafetyClass,
): PermissionDecision {
  const safety = safetyOverride ?? def.safety;
  if (safety === "read-only") return { kind: "allow" };

  if (ctx.permissionMode === "plan") {
    return { kind: "deny", reason: `${def.name} is disabled in plan mode.` };
  }

  if (ctx.permissionMode === "bypass") return { kind: "allow" };

  if (ctx.permissionMode === "workspace-write") {
    if (safety === "workspace-write") return { kind: "allow" };
    if (safety === "external-state" || safety === "destructive") {
      return {
        kind: "ask",
        prompt: `${def.name} wants to perform a ${safety} action.`,
        suggestion: safety === "external-state" ? "allow_once" : "deny",
      };
    }
    return {
      kind: "deny",
      reason: `${def.name} is ${safety}; workspace-write mode only allows workspace edits.`,
    };
  }

  if (ctx.permissionMode === "auto-safe") {
    if (safety === "workspace-write") return { kind: "allow" };
    return {
      kind: "ask",
      prompt: `${def.name} wants to perform a ${safety} action.`,
      suggestion: safety === "external-state" ? "allow_once" : "deny",
    };
  }

  return {
    kind: "ask",
    prompt: `${def.name} wants to perform a ${safety} action.`,
    suggestion: safety === "workspace-write" ? "allow_once" : "deny",
  };
}

export function workspaceRoot(ctx: Pick<RichToolContext, "workspace">): string {
  return path.resolve(ctx.workspace);
}

export async function resolveWorkspacePath(
  ctx: Pick<RichToolContext, "workspace" | "pathPermissions" | "requestPermission" | "permissionMode">,
  inputPath: string | undefined,
  label = "path",
  access: PathAccess = "read",
): Promise<string> {
  const root = workspaceRoot(ctx);
  const candidate = path.resolve(root, inputPath ?? ".");
  if (!isInsideWorkspace(root, candidate) && !ctx.pathPermissions?.isAllowed(candidate, access)) {
    // Unleashed (bypass): the owner runs Ares on their own machine and points it
    // wherever they like (their Desktop, home dir, another repo). No
    // out-of-workspace permission ritual — that's exactly the friction the owner
    // posture drops. Workspace checkpoints only cover files under the workspace,
    // so out-of-workspace targets rely on safeOverwrite's per-file pre-write
    // backup (.ares/backups) to stay reversible — plus the effects ledger.
    if (ctx.permissionMode === "bypass") return candidate;
    if (!ctx.requestPermission) {
      throw permissionDenied(`${label} escapes workspace and no permission prompt is available: ${candidate}`);
    }
    const decision = await ctx.requestPermission({
      toolName: "Filesystem",
      input: { path: candidate, access },
      reason: `${label} is outside the workspace: ${candidate}`,
      suggestion: "allow_once",
    });
    if (decision === "deny") {
      throw permissionDenied(`${label} denied outside workspace: ${candidate}`);
    }
    // Grant the containing DIRECTORY (for read/write), not just the one file,
    // even for allow_once. Rationale: when the owner points Ares at an
    // out-of-workspace project and approves it, they mean "work on this project"
    // — not "this single file." File-level once-grants are why fleets/subagents
    // died instantly on the SECOND file: leaves share this store but have no
    // prompt (deny-stub), so a sibling read they never individually approved was
    // hard-denied. Dir-scope makes an approved project usable by the whole
    // session incl. leaves. once vs always now differs only in persistence, not
    // breadth; execute stays file-level (grantRootFor returns the file for exec).
    const grantPath = await grantRootFor(candidate, access);
    const grantAccess = decision === "allow_always" && access === "execute" ? "all" : access;
    await ctx.pathPermissions?.grant(grantPath, grantAccess, decision === "allow_always" ? "always" : "once");
    if (!ctx.pathPermissions?.isAllowed(candidate, access)) {
      throw permissionDenied(`${label} not granted outside workspace: ${candidate}`);
    }
  }
  return candidate;
}

async function grantRootFor(candidate: string, access: PathAccess): Promise<string> {
  const info = await fs.stat(candidate).catch(() => null);
  if (info?.isDirectory()) return candidate;
  if (access === "write" || access === "read") return path.dirname(candidate);
  return candidate;
}

function permissionDenied(message: string): Error {
  const err = new Error(message);
  err.name = "PermissionDeniedError";
  return err;
}

export function assertInsideWorkspace(root: string, candidate: string, label = "path"): void {
  if (isInsideWorkspace(root, candidate)) return;
  throw new Error(`${label} escapes workspace: ${candidate}`);
}

function isInsideWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return true;
  }
  return false;
}

function normalizeProviderJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeProviderJsonSchema);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (key === "default") continue;
    output[key] = normalizeProviderJsonSchema(child);
  }

  if (output.exclusiveMinimum === true && typeof output.minimum === "number") {
    output.exclusiveMinimum = output.minimum;
    delete output.minimum;
  } else if (output.exclusiveMinimum === false) {
    delete output.exclusiveMinimum;
  }

  if (output.exclusiveMaximum === true && typeof output.maximum === "number") {
    output.exclusiveMaximum = output.maximum;
    delete output.maximum;
  } else if (output.exclusiveMaximum === false) {
    delete output.exclusiveMaximum;
  }

  return output;
}
