// Owner-toggleable permission policy — the single, testable place that decides
// whether a tool action auto-approves, asks the owner, or (for a fleet leaf that
// cannot prompt) is denied.
//
// Defaults preserve the prior hardcoded behavior EXACTLY: in "guarded" mode
// non-sensitive actions flow freely and only the sensitive set (credentials,
// payments, email, destructive, ComputerUse) asks. The toggles let the owner
// loosen or tighten each category, flip the whole thing to "free" (act on
// everything without asking — the old dangerousBypass), and decide whether fleet
// subagents inherit that freedom (they have no human to prompt).

import type { ToolPermissionRequest } from "@ares/core";

export interface PermissionSettings {
  /** Master posture. "free" = act on everything without asking. Default "guarded". */
  mode?: "guarded" | "free";
  /** In guarded mode, auto-approve file writes/edits (else ask). Default true. */
  fileWrite?: boolean;
  /** In guarded mode, auto-approve shell/command execution (else ask). Default true. */
  shell?: boolean;
  /** In guarded mode, auto-approve web/network actions (else ask). Default true. */
  network?: boolean;
  /** In guarded mode, auto-approve the SENSITIVE set — credentials/payments/email/
   *  destructive/ComputerUse (else ask). Default false (these ask by default). */
  sensitive?: boolean;
  /** Fleet/subagent leaves act with the same auto-approve. They can't prompt, so
   *  when off, anything that would "ask" is denied for them. Default true. */
  fleetsInherit?: boolean;
}

export const DEFAULT_PERMISSIONS: Required<PermissionSettings> = {
  mode: "guarded",
  fileWrite: true,
  shell: true,
  network: true,
  sensitive: false,
  fleetsInherit: true,
};

/** Always-confirm set (in guarded mode, unless `sensitive` is toggled on). Mirrors
 *  the prior SENSITIVE_PERMISSION regex so default behavior is unchanged. */
export const SENSITIVE_PERMISSION = new RegExp(
  [
    "credential", "secret", "api[ _-]?key", "password", "passphrase", "private key",
    "payment", "purchase", "checkout", "billing", "charge", "credit card", "\\bcard\\b",
    "send (an )?email", "email[_ ]send", "send mail",
    "external account", "log ?in to", "sign ?in to", "oauth",
    "rm -rf", "wipe", "format disk", "drop database", "force[- ]?push", "delete account",
    "delete data", "discard uncommitted work", "destructive shell",
    "computer ?use", "control (the )?(mouse|keyboard|screen|desktop)",
    "\\bdeploy\\b", "\\bstripe\\b", "payment link", "\\bemail\\b",
    "request[_ ]?user[_ ]?action", "hand off", "needs you",
    "exit ?plan ?mode", "approve this plan", "leave plan mode",
  ].join("|"),
  "i",
);

export type PermissionCategory = "sensitive" | "fileWrite" | "shell" | "network" | "other";

/** Categorize a request. "sensitive" wins over everything (it's the always-ask set). */
export function classifyPermissionRequest(request: ToolPermissionRequest): PermissionCategory {
  const hay = `${request.toolName} ${request.reason ?? ""}`;
  if (SENSITIVE_PERMISSION.test(hay)) return "sensitive";
  const t = (request.toolName ?? "").toLowerCase();
  if (/write|edit|patch|forge|findandedit|codemode|apply/.test(t)) return "fileWrite";
  if (/bash|powershell|shell|kill|exec|command/.test(t)) return "shell";
  if (/web|browser|fetch|search|http|crawl|download/.test(t)) return "network";
  return "other";
}

export type PolicyOutcome = "allow" | "ask" | "deny";

/**
 * Decide a permission request against the owner's settings.
 * - "free" → allow everything.
 * - "guarded" → per-category auto-approve; "other" always flows (it's the safe
 *   long tail), sensitive defaults to ask.
 * - For a fleet leaf (opts.fleet): it cannot prompt, so an "ask" becomes "deny"
 *   unless `fleetsInherit` is on AND the policy said "allow".
 */
export function decidePermission(
  request: ToolPermissionRequest,
  settings: PermissionSettings | undefined,
  opts: { fleet?: boolean } = {},
): PolicyOutcome {
  const p = { ...DEFAULT_PERMISSIONS, ...(settings ?? {}) };
  const cat = classifyPermissionRequest(request);

  // A WORKFLOW decision is never auto-answered — not even in free/YOLO mode.
  // YOLO means "stop asking before you write files and run commands"; it does
  // not mean "decide on my behalf whether this plan is ready to build". A live
  // session had the plan→build crossing auto-approved 11ms after it was raised,
  // so the session left plan mode with nobody consulted. A fleet leaf can't
  // prompt, so for a leaf this is a refusal rather than a silent yes.
  if (request.ownerDecision) return opts.fleet ? "deny" : "ask";

  let outcome: "allow" | "ask";
  if (p.mode === "free") {
    outcome = "allow";
  } else {
    switch (cat) {
      case "sensitive": outcome = p.sensitive ? "allow" : "ask"; break;
      case "fileWrite": outcome = p.fileWrite ? "allow" : "ask"; break;
      case "shell": outcome = p.shell ? "allow" : "ask"; break;
      case "network": outcome = p.network ? "allow" : "ask"; break;
      default: outcome = "allow"; break; // "other" — the safe long tail, as before
    }
  }

  if (opts.fleet) {
    if (!p.fleetsInherit) return "deny";
    return outcome === "allow" ? "allow" : "deny"; // leaves can't prompt
  }
  return outcome;
}
