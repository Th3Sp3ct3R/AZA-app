// subagentJournal.ts — the subagent flight recorder + structured handoff.
//
// THE GAP THIS FILLS: a subagent run used to return only its final prose — the
// parent had no structured record of what the child actually DID. The journal
// is fed from the child engine's own TurnEvents (tool_start/tool_end/tool_error),
// never from re-parsing text, and is flushed to disk INCREMENTALLY so a crashed
// subagent leaves evidence. When the run ends (or dies) it collapses into a
// compact SubagentHandoff the parent model sees alongside the summary — what the
// child touched, not what it claims.
//
// Bounded by construction (~last 50 entries, trimmed strings): this is a flight
// recorder, not a transcript (transcript.jsonl already exists next door). Every
// disk write is best-effort and serialized — a journal failure must NEVER fail
// the subagent run.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TurnEndStatus, TurnEvent } from "@ares/protocol";

export interface SubagentJournalEntry {
  seq: number;
  tool: string;
  /** Trimmed activityDescription — what the call was aimed at. */
  target: string;
  /** true = succeeded, false = errored, undefined = still in flight (crash evidence). */
  ok?: boolean;
  error?: string;
  ms?: number;
}

export interface SubagentHandoff {
  outcome: "completed" | "error" | "turn-limit";
  filesTouched: string[];
  commandsRun: number;
  toolCalls: number;
  /** Last few tool errors, trimmed. */
  errors: string[];
  /** '' when the journal could not be persisted. */
  journalPath: string;
}

const MAX_ENTRIES = 50;
const MAX_FILES = 40;
const MAX_ERRORS = 4;
const TARGET_CHARS = 100;
const ERROR_CHARS = 140;
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);

function trim(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export class SubagentJournal {
  private readonly entries: SubagentJournalEntry[] = [];
  private readonly pending = new Map<string, SubagentJournalEntry>();
  private readonly filesTouched = new Set<string>();
  private readonly errors: string[] = [];
  private seq = 0;
  private dropped = 0;
  private commandsRun = 0;
  private toolCalls = 0;
  private turnLimitHit = false;
  private outcome: SubagentHandoff["outcome"] | "running" = "running";
  private writeChain: Promise<void> = Promise.resolve();
  private writeFailed = false;
  readonly journalPath: string;

  constructor(
    dir: string,
    private readonly meta: { id: string; type: string; description: string },
  ) {
    this.journalPath = path.join(dir, "journal.json");
  }

  /** Feed one child TurnEvent. Never throws — recording is best-effort. */
  record(ev: TurnEvent): void {
    try {
      this.recordUnsafe(ev);
    } catch {
      // a flight-recorder glitch must never fail the flight
    }
  }

  private recordUnsafe(ev: TurnEvent): void {
    if (ev.type === "tool_start") {
      this.toolCalls++;
      if (COMMAND_TOOLS.has(ev.name)) this.commandsRun++;
      const entry: SubagentJournalEntry = {
        seq: ++this.seq,
        tool: ev.name,
        target: trim(ev.activityDescription || "", TARGET_CHARS),
      };
      this.push(entry);
      this.pending.set(ev.id, entry);
      this.flush(); // in-flight entry on disk = crash evidence of what it was doing
    } else if (ev.type === "tool_end") {
      const entry = this.pending.get(ev.id);
      if (entry) {
        entry.ok = true;
        entry.ms = ev.durationMs;
        this.pending.delete(ev.id);
      }
      for (const f of ev.touchedFiles ?? []) {
        if (this.filesTouched.size < MAX_FILES) this.filesTouched.add(f);
      }
      this.flush();
    } else if (ev.type === "tool_error") {
      const entry = this.pending.get(ev.id);
      const msg = trim(ev.error, ERROR_CHARS);
      // Shell-like tools may write files before returning a non-zero exit. The
      // protocol carries that partial mutation scope on tool_error; retain it
      // in the factual handoff just like a successful tool_end.
      for (const f of ev.touchedFiles ?? []) {
        if (this.filesTouched.size < MAX_FILES) this.filesTouched.add(f);
      }
      if (entry) {
        entry.ok = false;
        entry.error = msg;
        entry.ms = ev.durationMs;
        this.pending.delete(ev.id);
        this.errors.push(`${entry.tool}: ${msg}`);
      } else {
        this.errors.push(msg);
      }
      while (this.errors.length > MAX_ERRORS) this.errors.shift();
      this.flush();
    } else if (ev.type === "error") {
      if (ev.error.code === "max_turns_exceeded" || ev.error.code === "loop_detected") this.turnLimitHit = true;
      else {
        this.errors.push(trim(ev.error.message, ERROR_CHARS));
        while (this.errors.length > MAX_ERRORS) this.errors.shift();
      }
    }
  }

  private push(entry: SubagentJournalEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
      this.dropped++;
    }
  }

  /** Collapse the recorder into the handoff. Awaits the final disk flush (never
   *  rejects) so journalPath is real — or '' when persistence failed. */
  async finish(status: TurnEndStatus): Promise<SubagentHandoff> {
    this.outcome = this.turnLimitHit ? "turn-limit" : status === "completed" ? "completed" : "error";
    this.flush();
    await this.writeChain;
    return {
      outcome: this.outcome,
      filesTouched: [...this.filesTouched],
      commandsRun: this.commandsRun,
      toolCalls: this.toolCalls,
      errors: [...this.errors],
      journalPath: this.writeFailed ? "" : this.journalPath,
    };
  }

  /** Await the last scheduled disk write (never rejects) — mid-run checkpoint. */
  async flushed(): Promise<void> {
    await this.writeChain;
  }

  /** Serialized, best-effort rewrite of journal.json (small: ≤50 compact entries). */
  private flush(): void {
    const snapshot =
      JSON.stringify(
        {
          ...this.meta,
          outcome: this.outcome,
          toolCalls: this.toolCalls,
          commandsRun: this.commandsRun,
          filesTouched: [...this.filesTouched],
          errors: [...this.errors],
          dropped: this.dropped,
          entries: this.entries,
        },
        null,
        2,
      ) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(path.dirname(this.journalPath), { recursive: true });
        await writeFile(this.journalPath, snapshot, "utf8");
        this.writeFailed = false;
      } catch {
        this.writeFailed = true; // journal loss is survivable; the run is not sacrificed
      }
    });
  }
}

/** Render the handoff for the parent model — compact (~600 chars), factual. */
export function renderSubagentHandoff(h: SubagentHandoff): string {
  const lines: string[] = [];
  lines.push(
    `── subagent handoff ── outcome: ${h.outcome} | tool calls: ${h.toolCalls} | commands run: ${h.commandsRun}`,
  );
  if (h.filesTouched.length > 0) {
    const shown = h.filesTouched.slice(0, 8);
    const more = h.filesTouched.length - shown.length;
    lines.push(`files touched (${h.filesTouched.length}): ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  } else {
    lines.push("files touched: none");
  }
  if (h.errors.length > 0) {
    lines.push(`recent errors:`);
    for (const e of h.errors) lines.push(`  - ${e}`);
  }
  if (h.journalPath) lines.push(`journal: ${h.journalPath}`);
  const rendered = lines.join("\n");
  return rendered.length > 700 ? rendered.slice(0, 699) + "…" : rendered;
}
