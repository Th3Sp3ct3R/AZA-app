// Operator → Telegram reports. The voice outside the app: background autonomy
// becomes visible as compact mission updates ("Operator online", "worked a
// mission → done", "error", a daily war-map status) instead of "trust me bro" in
// daemon form. Pure formatters + a best-effort sender — a Telegram failure must
// never reach the operator loop, and secrets/home paths are redacted.
//
// First version is Level-1 REPORTS only. Inbound remote commands + the approval
// gate already live in TelegramBridge; richer orchestration is a later commit.

import type { TelegramApiLike } from "./bridge.js";

/** Mirror of @ares/operator's OperatorBackgroundEvent (decoupled — channels must
 *  not depend on operator). Only the fields a report needs. */
export interface OperatorEventLike {
  // operator_woken has no formatter on purpose: a wake is bookkeeping, and the
  // work it leads to reports itself. It falls through to null.
  type: "operator_started" | "operator_tick" | "operator_idle" | "operator_error" | "operator_stopped" | "operator_woken" | "watcher_fired";
  everyMs?: number;
  goalId?: string;
  status?: string;
  summary?: string;
  suggestions?: string[];
  message?: string;
  id?: string;
  label?: string;
}

export interface WarMapBriefing {
  project?: string;
  campaign?: string;
  nextActions?: readonly string[];
  lastGate?: string;
  recentAction?: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot token
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
  /\b(?:api[_-]?key|token|secret|password|passphrase)\s*[:=]\s*\S+/gi,
];

/** Strip obvious secrets and collapse user-home paths to ~ before anything ships. */
export function redactForTelegram(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  // Home directories — never leak the owner's username / machine layout.
  out = out.replace(/[A-Za-z]:\\Users\\[^\\/\s]+/g, "~").replace(/\/(?:home|Users)\/[^/\s]+/g, "~");
  return out;
}

function clip(text: string, n: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export interface OperatorReportOptions {
  /** When true, idle ticks are reported too (otherwise suppressed — no spam). */
  debug?: boolean;
}

/**
 * Format one operator event into a compact Telegram line, or null to SUPPRESS it.
 * Idle is suppressed unless debug — the loop ticks often and "still nothing" is
 * not a notification. No essays, no "Ares has awakened beneath the moon."
 */
export function formatOperatorReport(event: OperatorEventLike, opts: OperatorReportOptions = {}): string | null {
  switch (event.type) {
    case "operator_started":
      return `🜂 Operator online — advancing missions every ${Math.max(1, Math.round((event.everyMs ?? 60_000) / 60_000))}m.`;
    case "operator_tick":
      return redactForTelegram(`⚙ ${clip(event.summary ?? event.goalId ?? "mission", 160)} → ${event.status ?? "ticked"}`);
    case "operator_error":
      return redactForTelegram(`⚠ Operator error: ${clip(event.message ?? "unknown", 200)}`);
    case "operator_stopped":
      return "🜂 Operator stopped.";
    case "operator_idle":
      if (!opts.debug) return null; // don't spam idle every tick
      return redactForTelegram(`· Idle — next: ${(event.suggestions ?? []).slice(0, 3).join("; ") || "nothing queued"}`);
    case "watcher_fired":
      // A condition tripped and Ares queued a PLAN-ONLY proposal — worth the ping.
      return redactForTelegram(`👁 ${clip(event.label ?? "watcher", 60)} tripped — ${clip(event.summary ?? "", 140)}. Proposal queued for your approval.`);
    default:
      return null;
  }
}

/** A compact war-map status (the daily / on-start briefing). */
export function formatWarMapBriefing(b: WarMapBriefing): string {
  const lines = ["🜂 Ares — status"];
  if (b.project) lines.push(`Project: ${b.project}`);
  if (b.campaign) lines.push(`Campaign: ${clip(b.campaign, 200)}`);
  if (b.recentAction) lines.push(`Last: ${clip(b.recentAction, 180)}`);
  if (b.lastGate) lines.push(`Gate: ${clip(b.lastGate, 80)}`);
  if (b.nextActions && b.nextActions.length) lines.push(`Next: ${b.nextActions.slice(0, 3).map((a) => clip(a, 80)).join("; ")}`);
  return redactForTelegram(lines.join("\n"));
}

export interface OperatorReporterOptions {
  api: TelegramApiLike;
  chatIds: readonly number[];
  debug?: boolean;
  log?: (line: string) => void;
}

/**
 * Sends operator reports to the configured chats. Every send is best-effort and
 * isolated: a Telegram outage logs a warning and the operator loop never feels it.
 */
export class OperatorTelegramReporter {
  constructor(private readonly opts: OperatorReporterOptions) {}

  /** Report an operator event (suppressed events are a no-op). NEVER throws. */
  async report(event: OperatorEventLike): Promise<void> {
    const text = formatOperatorReport(event, { debug: this.opts.debug });
    if (text) await this.send(text);
  }

  /** Send an arbitrary compact message (e.g. a war-map briefing). NEVER throws. */
  async send(text: string): Promise<void> {
    for (const chatId of this.opts.chatIds) {
      try {
        await this.opts.api.sendMessage(chatId, text);
      } catch (err) {
        this.opts.log?.(`telegram report to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
