// The runtime permission gate — wires the @ares/effects policy BRAIN
// (evaluateAction) into the live tool-call gate.
//
// Until now the daemon gated tool calls with a single fragile regex
// (SENSITIVE_PERMISSION): it could only auto-allow or escalate, had no notion of
// a hard block, and no notion of whether a HUMAN was actually watching. This
// module replaces the guesswork with the structured risk classifier:
//
//   tool call ─▶ classify ─▶ ActionCategory ─▶ evaluateAction ─▶ allow|ask|deny
//
// The decisive new axis is `attended`. A staged/hard-blocked action with the
// owner present ESCALATES (they consciously approve a payment link, a send, a
// destructive shell). The SAME action under the unattended operator loop — where
// there is no human to ask — is DENIED. That is the real meaning of a hard
// block: Ares never autonomously moves money, leaks a credential, sends mail, or
// wipes data with nobody watching.
//
// The gate is PURE and only ever makes the existing posture STRICTER (an
// auto-allowed call can be upgraded to ask/deny, never the reverse), so it can't
// regress the freedom posture the owner chose.

import { evaluateAction, type ActionCategory, type ActionMode } from "@ares/effects";
import type { ToolPermissionRequest } from "@ares/core";

/**
 * The categories that ALWAYS need the owner's explicit yes — even when Ares is
 * running autonomously for a remote (Telegram) session. Money, mail, publishing
 * to the world, credentials, and irreversible data-wipes. Everything NOT on this
 * list (reading, web research/fetch, navigating, driving the desktop, editing
 * the workspace, ordinary shell) runs without nagging, because the whole point
 * of remote autonomy is that Ares moves while the owner is away.
 */
const REMOTE_GATED: ReadonlySet<ActionCategory> = new Set<ActionCategory>([
  "payment_or_purchase",
  "email_send",
  "browser_submit",
  "shell_destructive",
  "git_push",
  "credential_or_secret",
]);

/**
 * Permission posture for REMOTE sessions (Telegram). Autonomy-first: anything
 * that isn't outright dangerous just runs; the dangerous few escalate to the
 * owner's phone (and auto-deny — the safe failure — if unanswered before the
 * tool watchdog fires). PURE — no I/O.
 *
 *   allow → run it now, no prompt
 *   ask   → send Allow/Deny buttons to the owner's Telegram
 *   deny  → refuse outright
 */
export function remoteAutonomyDecision(request: ToolPermissionRequest): "allow" | "ask" | "deny" {
  // Exiting plan mode grants workspace-write authority and approves one exact
  // durable plan revision. A remote model can propose it, but only the owner
  // can cross this boundary; never let the autonomy default self-approve it.
  if (request.toolName === "ExitPlanMode") return "ask";
  const category = classifyToolRequest(request);
  // Benign / unclassified tools (Read, WebFetch, WebSearch, Weather, …) → run.
  if (category === null) return "allow";
  // The dangerous few → owner's phone.
  if (REMOTE_GATED.has(category)) return "ask";
  // Everything else — navigate, desktop control, file writes, ordinary shell — runs.
  return "allow";
}

/** What the gate tells its caller to do with a staged tool call. */
export type GateKind = "allow" | "ask" | "deny" | "defer";

export interface GateOutcome {
  /** allow = auto-approve · ask = escalate to the owner · deny = refuse · defer = no opinion (use legacy auto). */
  kind: GateKind;
  category: ActionCategory | null;
  hardBlocked: boolean;
  reason?: string;
}

export interface GateOptions {
  /** Is a human present to answer an approval prompt? Unattended ⇒ hard blocks DENY. */
  attended: boolean;
  /** Owner posture. Defaults to "act" — the desktop workspace-write posture. */
  mode?: ActionMode;
}

// Shell commands that erase data or discard uncommitted work. Mirrors
// destructiveShellDecision in @ares/tools (kept local so the gate is
// self-contained and independently testable).
const DESTRUCTIVE_SHELL =
  /(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+|(?:^|[;&|]\s*)(?:rmdir|unlink|shred)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--)\b|\b(?:mkfs(?:\.\w+)?|wipefs|format)\b|\bRemove-Item\b|(?:^|[;|]\s*)(?:del|erase|rd|rmdir)\s+|\b(?:Clear-Disk|Format-Volume|Remove-Partition)\b/i;

// Leading commands that only read. Anything not on this list is treated as
// mutating (safer default). git/PowerShell read verbs handled separately.
const READONLY_LEADERS = new Set([
  "ls", "dir", "pwd", "cd", "echo", "cat", "head", "tail", "less", "more",
  "wc", "grep", "rg", "find", "fd", "which", "type", "whoami", "id", "date",
  "env", "printenv", "uname", "hostname", "stat", "file", "du", "df", "tree",
  "ps", "top", "node", "python", "python3", "pip", "npm", "pnpm", "yarn",
  "test-path", "get-childitem", "get-content", "get-item", "get-process",
  "get-location", "select-string", "measure-object", "where-object",
]);

const GIT_READONLY = /^git\s+(status|log|diff|show|branch|remote|config\s+--get|rev-parse|describe|blame|ls-files|tag\b)/i;

function commandOf(request: ToolPermissionRequest): string {
  const input = request.input as { command?: unknown } | null | undefined;
  return typeof input?.command === "string" ? input.command : "";
}

/** The `action` discriminator for action-style tools (Gmail/Calendar/Connect). */
function actionOf(request: ToolPermissionRequest): string {
  const input = request.input as { action?: unknown } | null | undefined;
  return typeof input?.action === "string" ? input.action : "";
}

/** Classify a shell command line by what it can do to the machine. */
export function classifyShell(rawCommand: string): ActionCategory {
  const cmd = rawCommand.replace(/\s+/g, " ").trim();
  if (!cmd) return "shell_mutating";
  if (DESTRUCTIVE_SHELL.test(cmd)) return "shell_destructive";
  if (/\bgit\s+push\b/i.test(cmd)) return "git_push";
  if (GIT_READONLY.test(cmd)) return "shell_readonly";
  const leader = cmd.split(/[\s|;&]+/)[0]?.toLowerCase() ?? "";
  // A PowerShell read verb (Get-/Test-/Select-/Measure-) or an allowlisted
  // leader with no write-ish operator is read-only.
  if (/^(get|test|select|measure)-/.test(leader) || READONLY_LEADERS.has(leader)) {
    // Redirections / pipes into write commands still count as mutating.
    if (/>>?|\bSet-|\bOut-File\b|\bNew-Item\b|\b(install|add|publish|push)\b/i.test(cmd)) return "shell_mutating";
    return "shell_readonly";
  }
  return "shell_mutating";
}

/**
 * Map a tool-permission request to a structured ActionCategory, or null when the
 * gate has no structured opinion (benign tools — let the legacy auto decide).
 */
export function classifyToolRequest(request: ToolPermissionRequest): ActionCategory | null {
  const hay = `${request.toolName} ${request.reason}`.toLowerCase();
  // A credential/secret signal anywhere is a hard block regardless of tool.
  if (/\b(credential|secret|api[ _-]?key|password|passphrase|private key|oauth token)\b/.test(hay)) {
    return "credential_or_secret";
  }
  switch (request.toolName) {
    case "Bash":
    case "PowerShell":
      return classifyShell(commandOf(request));
    // ComputerUse drives the REAL desktop (mouse/keyboard/screen). No dedicated
    // category — treat as "unknown" so it's conservatively staged, never silent,
    // but never a hard block (the owner legitimately uses it).
    case "ComputerUse":
      return "unknown";
    case "Stripe":
      return "payment_or_purchase";
    case "Email":
      return "email_send";
    // Gmail SENDS mail (an outward effect) — only the 'send' action is gated; reads
    // are benign. The tool itself also asks on send (checkPermissions), but the
    // structured gate must classify it so the unattended posture DENIES it.
    case "Gmail":
      return actionOf(request) === "send" ? "email_send" : null;
    // Calendar create/delete mutates a real calendar + can send invites.
    case "GoogleCalendar":
      return actionOf(request) === "create_event" || actionOf(request) === "delete_event" ? "browser_submit" : null;
    // Connect storing credentials / disconnecting touches secrets + account state.
    case "Connect":
      return actionOf(request) === "set_credentials" || actionOf(request) === "disconnect" ? "credential_or_secret" : null;
    // Deploy publishes to a real host — external + irreversible, but a deliberate
    // capability the owner can approve. Treated like git_push (ask), not blocked.
    case "Deploy":
      return "git_push";
    case "Filesystem":
      return "file_write";
    case "Browser":
      return /\b(submit|checkout|buy|pay|purchase|order|confirm)\b/.test(hay) ? "browser_submit" : "browser_navigate";
    default:
      return null;
  }
}

/**
 * The gate. Classifies the request, runs the policy brain, and folds in the
 * attended axis. PURE — no I/O.
 */
export function gateToolPermission(request: ToolPermissionRequest, opts: GateOptions): GateOutcome {
  const category = classifyToolRequest(request);
  if (category === null) return { kind: "defer", category: null, hardBlocked: false };

  const evaluation = evaluateAction({ category }, { mode: opts.mode ?? "act" });
  const reason = evaluation.reasons[0];

  if (evaluation.hardBlocked) {
    return {
      kind: opts.attended ? "ask" : "deny",
      category,
      hardBlocked: true,
      reason: opts.attended
        ? `${reason} — requires your explicit approval (cannot be auto-allowed)`
        : `${reason} — denied: no owner present to approve (unattended)`,
    };
  }

  switch (evaluation.decision) {
    case "allow":
    case "log-only":
      return { kind: "allow", category, hardBlocked: false, reason };
    case "deny":
      return { kind: "deny", category, hardBlocked: false, reason };
    case "ask":
    case "preview-only":
    default:
      // Needs a human. Attended ⇒ escalate; unattended ⇒ refuse (nobody to ask).
      return {
        kind: opts.attended ? "ask" : "deny",
        category,
        hardBlocked: false,
        reason: opts.attended ? reason : `${reason} — denied: no owner present to approve (unattended)`,
      };
  }
}
