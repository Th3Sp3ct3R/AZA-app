// Friction telemetry — the "know exactly what to upgrade" spine.
//
// Every turn on every surface (chat, TUI, desktop daemon) folds its TurnEvents
// into one compact record and appends ONE JSONL line to
// ~/.ares/telemetry/friction-YYYY-MM.jsonl. This is the raw material for the
// gap-closing loop: which tools error, which Edit tier landed, how often turns
// stall or verify red, and how well the prompt cache is working. Local-only,
// no content — counts and ratios, never user text or file contents.
//
// Disable with ARES_TELEMETRY=0. Writes are best-effort and serialized; a
// telemetry failure can never affect a turn.

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { aresHome } from "./providers/openaiAuth.js";
import type { TurnEvent } from "@ares/protocol";

export interface FrictionTurn {
  at: string;
  sessionId: string;
  status: "completed" | "interrupted" | "failed" | "unknown";
  durationMs: number;
  /** Per-tool call/error counts, keyed by tool name. */
  tools: Record<string, { calls: number; errors: number }>;
  /** Which Edit matching tier landed (exact/whitespace/anchor) or missed. */
  editTiers: { exact: number; whitespace: number; anchor: number; miss: number };
  /** Stream stalls cut by the effort dial this turn. */
  stalls: number;
  reasoningStalls: number;
  /** Verifier red-flag reminders injected (continuous verify + end gate). */
  verifyReminders: number;
  compactions: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  /** cacheRead / input — the prompt-cache health signal (null when no input). */
  cacheReadRatio: number | null;
}

export function telemetryDir(home = aresHome()): string {
  return path.join(home, "telemetry");
}

function emptyTurn(sessionId: string): FrictionTurn {
  return {
    at: new Date().toISOString(),
    sessionId,
    status: "unknown",
    durationMs: 0,
    tools: {},
    editTiers: { exact: 0, whitespace: 0, anchor: 0, miss: 0 },
    stalls: 0,
    reasoningStalls: 0,
    verifyReminders: 0,
    compactions: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    cacheReadRatio: null,
  };
}

export class FrictionRecorder {
  private turn: FrictionTurn;
  private readonly nameById = new Map<string, string>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly enabled: boolean;
  private readonly dir: string;

  constructor(
    private readonly sessionId: string,
    dir?: string,
  ) {
    this.dir = dir ?? telemetryDir();
    // `node --test` constructs many real Sessions. Those used to append their
    // fake tool failures into the owner's ~/.ares telemetry (190/190 Browser
    // failures in the live dashboard). Explicit test directories still record,
    // so FrictionRecorder itself remains fully testable.
    this.enabled = process.env.ARES_TELEMETRY !== "0" && (dir !== undefined || !process.env.NODE_TEST_CONTEXT);
    this.turn = emptyTurn(sessionId);
  }

  /** Fold one TurnEvent. Cheap, synchronous, never throws. */
  record(ev: TurnEvent): void {
    if (!this.enabled) return;
    try {
      switch (ev.type) {
        case "tool_use_start": {
          this.nameById.set(ev.id, ev.name);
          break;
        }
        case "tool_end": {
          const name = this.nameById.get(ev.id) ?? "unknown";
          const t = (this.turn.tools[name] ??= { calls: 0, errors: 0 });
          t.calls++;
          if (name === "Edit") {
            const layer = (ev.output as { layer?: string } | undefined)?.layer;
            if (layer === "exact" || layer === "whitespace" || layer === "anchor") this.turn.editTiers[layer]++;
          }
          break;
        }
        case "tool_error": {
          const name = this.nameById.get(ev.id) ?? "unknown";
          const t = (this.turn.tools[name] ??= { calls: 0, errors: 0 });
          t.calls++;
          t.errors++;
          if (name === "Edit") this.turn.editTiers.miss++;
          break;
        }
        case "error": {
          const code = ev.error?.code;
          if (code === "stream_stall") this.turn.stalls++;
          if (code === "reasoning_stall") {
            this.turn.stalls++;
            this.turn.reasoningStalls++;
          }
          break;
        }
        case "system_reminder_injected": {
          if (ev.source === "verifier") this.turn.verifyReminders++;
          if (ev.source === "compaction") this.turn.compactions++;
          break;
        }
        case "turn_end": {
          this.turn.status = ev.status ?? "unknown";
          this.turn.durationMs = ev.durationMs ?? 0;
          const u = ev.usage;
          if (u) {
            this.turn.usage = {
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              cacheReadTokens: u.cacheReadTokens ?? 0,
            };
            this.turn.cacheReadRatio =
              this.turn.usage.inputTokens > 0
                ? Math.round((this.turn.usage.cacheReadTokens / this.turn.usage.inputTokens) * 1000) / 1000
                : null;
          }
          this.flushTurn();
          break;
        }
        default:
          break;
      }
    } catch {
      // telemetry never breaks a turn
    }
  }

  /** Snapshot of the CURRENT (unflushed) turn — for tests and live surfaces. */
  snapshot(): FrictionTurn {
    return JSON.parse(JSON.stringify(this.turn)) as FrictionTurn;
  }

  /** Append the finished turn as one JSONL line and reset. Best-effort. */
  private flushTurn(): void {
    const line = JSON.stringify(this.turn) + "\n";
    const file = path.join(this.dir, `friction-${this.turn.at.slice(0, 7)}.jsonl`);
    this.turn = emptyTurn(this.sessionId);
    this.nameById.clear();
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, line, "utf8");
      })
      .catch(() => undefined);
  }

  /** Await pending writes (tests / clean shutdown). */
  settle(): Promise<void> {
    return this.writeChain;
  }
}

// ─── Aggregation for `ares friction` ─────────────────────────────────────

export interface FrictionSummary {
  turns: number;
  completed: number;
  failed: number;
  tools: Record<string, { calls: number; errors: number }>;
  editTiers: FrictionTurn["editTiers"];
  stalls: number;
  reasoningStalls: number;
  verifyReminders: number;
  compactions: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  avgCacheReadRatio: number | null;
}

/** Aggregate the last `days` of friction lines from a telemetry dir. */
export async function summarizeFriction(dir = telemetryDir(), days = 7): Promise<FrictionSummary> {
  const cutoff = Date.now() - days * 86_400_000;
  const summary: FrictionSummary = {
    turns: 0,
    completed: 0,
    failed: 0,
    tools: {},
    editTiers: { exact: 0, whitespace: 0, anchor: 0, miss: 0 },
    stalls: 0,
    reasoningStalls: 0,
    verifyReminders: 0,
    compactions: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    avgCacheReadRatio: null,
  };
  let ratioSum = 0;
  let ratioN = 0;
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files.filter((f) => f.startsWith("friction-") && f.endsWith(".jsonl")).sort()) {
    const raw = await readFile(path.join(dir, f), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let turn: FrictionTurn;
      try {
        turn = JSON.parse(line) as FrictionTurn;
      } catch {
        continue;
      }
      if (Date.parse(turn.at) < cutoff) continue;
      summary.turns++;
      if (turn.status === "completed") summary.completed++;
      if (turn.status === "failed") summary.failed++;
      for (const [name, t] of Object.entries(turn.tools ?? {})) {
        const agg = (summary.tools[name] ??= { calls: 0, errors: 0 });
        agg.calls += t.calls;
        agg.errors += t.errors;
      }
      for (const k of ["exact", "whitespace", "anchor", "miss"] as const) {
        summary.editTiers[k] += turn.editTiers?.[k] ?? 0;
      }
      summary.stalls += turn.stalls ?? 0;
      summary.reasoningStalls += turn.reasoningStalls ?? 0;
      summary.verifyReminders += turn.verifyReminders ?? 0;
      summary.compactions += turn.compactions ?? 0;
      summary.totalInputTokens += turn.usage?.inputTokens ?? 0;
      summary.totalCacheReadTokens += turn.usage?.cacheReadTokens ?? 0;
      if (typeof turn.cacheReadRatio === "number") {
        ratioSum += turn.cacheReadRatio;
        ratioN++;
      }
    }
  }
  summary.avgCacheReadRatio = ratioN > 0 ? Math.round((ratioSum / ratioN) * 1000) / 1000 : null;
  return summary;
}
