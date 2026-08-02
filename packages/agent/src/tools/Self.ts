// Self — the agent's hands on its own self-model.
//
// SelfEvolve rewrites the prose mind (IDENTITY/SOUL/USER). Self operates on the
// structured capability graph: read what you are and how reliably you perform
// (status), get concrete self-improvement directives (reflect), declare a
// capability you want but don't have yet (want), or retire one (drop). This is
// how Ares answers "what am I good at, what do I keep failing, what should I
// become next" with data instead of vibes.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildTool } from "@ares/tools";
import { aresAgentHome } from "../paths.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";
import {
  dropCapability,
  loadSelfModel,
  summarizeSelf,
  upsertCapability,
} from "../self/store.js";
import { reflect, type SelfDirective } from "../self/reflect.js";
import type { Capability, CapabilityKind, SelfSummary } from "../self/types.js";

const ACTIONS = ["status", "reflect", "want", "drop", "logs"] as const;
const KINDS = ["skill", "tool", "package", "mission"] as const;

const inputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe(
        "status: summarize what you are (capabilities, reliability, flaky/top). reflect: get concrete self-improvement directives grounded in your outcome history. want: declare a capability you need but don't have yet (so reflect will tell you to acquire it). drop: retire a capability node. logs: read your own runtime diagnostics — per-turn friction telemetry (tool errors, stalls, failed turns) and recent crash records. When the user asks to see 'your logs', this is what they mean — NOT your memory markdown files.",
      ),
    name: z.string().optional().describe("Capability name. Required for 'want'."),
    kind: z.enum(KINDS).optional().describe("Capability kind for 'want' (default skill)."),
    description: z.string().optional().describe("What this capability is / why you want it. For 'want'."),
    id: z.string().optional().describe("Capability id (e.g. skill/foo). Required for 'drop'."),
    days: z.number().int().min(1).max(90).optional().describe("For 'logs': how many days back to summarize (default 7)."),
  })
  .strict();

export interface SelfToolOutput {
  action: string;
  summary?: SelfSummary;
  capabilities?: Array<Pick<Capability, "id" | "name" | "kind" | "status"> & { runs: number; reliability: number | null }>;
  directives?: SelfDirective[];
  capability?: Capability;
  dropped?: boolean;
  logs?: SelfLogsReport;
}

// ─── logs: runtime diagnostics (friction telemetry + crashes) ─────────────
//
// "Can you see your own log?" used to get answered with memory markdown
// because the engine had no way to reach its real diagnostics. This reads the
// per-turn friction JSONL (~/.ares/telemetry/friction-YYYY-MM.jsonl) and the
// crash directory — counts and ratios only, never chat content.

interface FrictionLine {
  at: string;
  sessionId: string;
  status: string;
  durationMs: number;
  tools?: Record<string, { calls: number; errors: number }>;
  stalls?: number;
  compactions?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface SelfLogsReport {
  days: number;
  telemetryDir: string;
  turns: number;
  completed: number;
  failed: number;
  interrupted: number;
  stalls: number;
  compactions: number;
  /** Tools ranked by error count (only those with at least one error). */
  toolErrors: Array<{ tool: string; calls: number; errors: number }>;
  /** The most recent problem turns — failed, stalled, or tool-erroring. */
  recentIssues: Array<{ at: string; sessionId: string; status: string; stalls: number; toolErrors: string[] }>;
  crashes: Array<{ file: string; at: string }>;
}

async function readSelfLogs(home: string, days: number): Promise<SelfLogsReport> {
  const dir = path.join(home, "telemetry");
  const cutoff = Date.now() - days * 86_400_000;
  const report: SelfLogsReport = {
    days,
    telemetryDir: dir,
    turns: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    stalls: 0,
    compactions: 0,
    toolErrors: [],
    recentIssues: [],
    crashes: [],
  };
  const toolAgg = new Map<string, { calls: number; errors: number }>();
  const issues: SelfLogsReport["recentIssues"] = [];

  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.startsWith("friction-") && f.endsWith(".jsonl"))
    .sort();
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let turn: FrictionLine;
      try {
        turn = JSON.parse(line) as FrictionLine;
      } catch {
        continue;
      }
      if (Date.parse(turn.at) < cutoff) continue;
      report.turns++;
      if (turn.status === "completed") report.completed++;
      else if (turn.status === "failed") report.failed++;
      else if (turn.status === "interrupted") report.interrupted++;
      report.stalls += turn.stalls ?? 0;
      report.compactions += turn.compactions ?? 0;
      const erroring: string[] = [];
      for (const [name, t] of Object.entries(turn.tools ?? {})) {
        const agg = toolAgg.get(name) ?? { calls: 0, errors: 0 };
        agg.calls += t.calls;
        agg.errors += t.errors;
        toolAgg.set(name, agg);
        if (t.errors > 0) erroring.push(`${name} ${t.errors}/${t.calls}`);
      }
      if (turn.status === "failed" || (turn.stalls ?? 0) > 0 || erroring.length > 0) {
        issues.push({ at: turn.at, sessionId: turn.sessionId, status: turn.status, stalls: turn.stalls ?? 0, toolErrors: erroring });
      }
    }
  }
  report.toolErrors = [...toolAgg.entries()]
    .filter(([, t]) => t.errors > 0)
    .map(([tool, t]) => ({ tool, ...t }))
    .sort((a, b) => b.errors - a.errors);
  report.recentIssues = issues.slice(-12).reverse();

  const crashDir = path.join(home, "crashes");
  const crashFiles = (await readdir(crashDir).catch(() => [] as string[])).sort().slice(-10).reverse();
  for (const f of crashFiles) {
    const st = await stat(path.join(crashDir, f)).catch(() => null);
    if (st && st.mtimeMs >= cutoff) report.crashes.push({ file: path.join(crashDir, f), at: new Date(st.mtimeMs).toISOString() });
  }
  return report;
}

export const SelfTool = buildTool({
  name: "Self",
  description:
    "Inspect and steer your own machine-readable self-model. status = what you are + how reliably you perform; reflect = outcome-grounded directives for what to fix, acquire, or prune; want = flag a capability gap to close; drop = retire a capability; logs = your real runtime diagnostics (per-turn telemetry: failed turns, stalls, tool errors, crashes) — use this when asked to look at your own logs. Self-territory under ~/.ares/self/ — no permission ritual. Read your status at the start of a session and reflect when idle.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Self ${i.action}${i.name ? ` ${i.name}` : ""}`,

  async call(input): Promise<{ output: SelfToolOutput; display: string }> {
    const home = aresAgentHome(process.env.ARES_HOME);
    const model = await loadSelfModel(home);

    switch (input.action) {
      case "status": {
        const summary = summarizeSelf(model);
        const capabilities = Object.values(model.capabilities)
          .filter((c) => c.status !== "removed")
          .map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            status: c.status,
            runs: c.outcomes.runs,
            reliability: c.outcomes.ok + c.outcomes.fail === 0 ? null : c.outcomes.ok / (c.outcomes.ok + c.outcomes.fail),
          }))
          .sort((a, b) => b.runs - a.runs);
        const relPct = summary.reliability === null ? "n/a" : `${Math.round(summary.reliability * 100)}%`;
        return {
          output: { action: "status", summary, capabilities },
          display: `self: ${summary.total} cap (${summary.skills} skill), ${summary.totalRuns} runs, ${relPct} reliable`,
        };
      }

      case "reflect": {
        const directives = reflect(model);
        emitLifecycle({
          type: "self_reflected",
          directives: directives.length,
          topKind: directives[0]?.kind,
          gain: directives.length > 0 ? gainForTarget("SELF", directives.length, "reflected") : undefined,
        });
        return {
          output: { action: "reflect", directives },
          display: directives.length === 0 ? "reflect: nothing to act on — self looks healthy" : `reflect: ${directives.length} directive(s), top=${directives[0].kind} ${directives[0].capabilityName}`,
        };
      }

      case "want": {
        if (!input.name || !input.name.trim()) throw new Error("Self.want requires a name");
        const kind: CapabilityKind = input.kind ?? "skill";
        const id = input.id ?? `${kind}/${slug(input.name)}`;
        const capability = await upsertCapability(home, {
          id,
          kind,
          name: input.name,
          status: "want",
          description: input.description,
          provenance: "self.want",
        });
        return {
          output: { action: "want", capability },
          display: `+1 CAPABILITY — want ${input.name} [${id}]`,
        };
      }

      case "drop": {
        if (!input.id) throw new Error("Self.drop requires an id (e.g. skill/foo)");
        const dropped = await dropCapability(home, input.id);
        return {
          output: { action: "drop", dropped },
          display: dropped ? `dropped ${input.id}` : `no capability ${input.id}`,
        };
      }

      case "logs": {
        const days = input.days ?? 7;
        const logs = await readSelfLogs(home, days);
        const worst = logs.toolErrors[0];
        return {
          output: { action: "logs", logs },
          display:
            logs.turns === 0
              ? `logs: no telemetry in the last ${days}d (${logs.telemetryDir})`
              : `logs ${days}d: ${logs.turns} turns (${logs.failed} failed, ${logs.stalls} stalls, ${logs.crashes.length} crashes)${worst ? `, worst tool ${worst.tool} ${worst.errors}/${worst.calls}` : ""}`,
        };
      }

      default:
        throw new Error(`Self: unsupported action ${String(input.action)}`);
    }
  },
});

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
