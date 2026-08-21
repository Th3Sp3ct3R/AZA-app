// The scoreboard reader — the half of the benchmark that was missing.
//
// C6 has been appending every completed gauntlet run to
// ~/.ares/gauntlet/scoreboard.jsonl since it shipped. Nothing ever read it.
// A write-only ledger is not a trend; it is a diary no one opens.
//
// coding-v3 taught the lesson this file is built around: at frontier tier the
// SCORE saturates. deepseek-v4-pro cleared v2 and v3 at 100% with the harness
// on AND off, so `total` can no longer gate anything. What still moves is the
// cost of the win — tokens per score point, wall-clock, the verified rate, and
// the false-green rate. Those are the axes this reader trends and the gate
// defends. The score axis remains: it still ranks weaker models, which is the
// whole "Ares makes any model code better" claim.
//
// Two rules keep the numbers honest:
//
//   1. COMPARABILITY. A run is only ever compared against runs of the same
//      suite, the same task manifest, the same provider/model, and the same
//      harness setting. Change the tasks and you have a new experiment, not a
//      regression. Note what is deliberately NOT in the key: the system-prompt
//      and tool-schema hashes. Those change precisely when the harness changes,
//      and the harness is the thing under test.
//   2. HONEST n. A single prior run is far too noisy to fail a build on. One
//      baseline reports findings as advisory; two or more earn the gate.

import type { GauntletUsage } from "./gauntlet.js";

export interface ScoreboardMetrics {
  integrityRate: number;
  verifiedTaskRate: number;
  falseGreenRate: number;
  verifiedMismatchRate: number;
  tokensPerScorePoint: number;
}

export interface ScoreboardRow {
  at: string;
  schemaVersion?: number;
  suite: string;
  harness: boolean;
  complete: boolean;
  taskManifestHash: string;
  provider: string;
  model: string;
  total: number;
  /** Absent on rows written before the appender recorded it. */
  durationMs?: number;
  usage: GauntletUsage;
  metrics: ScoreboardMetrics;
  harnessManifest?: Record<string, unknown>;
}

export interface CellStat {
  median: number;
  latest: number;
}

export interface ScoreboardCell {
  key: string;
  suite: string;
  taskManifestHash: string;
  provider: string;
  model: string;
  harness: boolean;
  runs: number;
  firstAt: string;
  lastAt: string;
  /** Newest first — the source rows behind this cell. */
  rows: ScoreboardRow[];
  total: CellStat;
  tokensPerScorePoint: CellStat;
  verifiedTaskRate: CellStat;
  falseGreenRate: CellStat;
  integrityRate: CellStat;
  totalTokens: CellStat;
  /** Null when no run in the cell recorded a duration. */
  durationMs: CellStat | null;
}

export interface HarnessDelta {
  suite: string;
  taskManifestHash: string;
  provider: string;
  model: string;
  onRuns: number;
  offRuns: number;
  /** off ÷ on tokens-per-score-point. >1 means the harness earns its keep. */
  tokenRatio: number;
  /** on − off. */
  verifiedDelta: number;
  scoreDelta: number;
  paysOff: boolean;
  /** "advisory" until both sides have at least two runs. */
  confidence: "advisory" | "measured";
}

export type RegressionAxis =
  | "total"
  | "tokensPerScorePoint"
  | "verifiedTaskRate"
  | "falseGreenRate"
  | "durationMs";

export interface RegressionFinding {
  axis: RegressionAxis;
  baseline: number;
  current: number;
  /** Human-readable statement of the move, direction included. */
  summary: string;
}

export interface RegressionVerdict {
  /** True only when the findings are backed by enough baseline runs to gate. */
  regressed: boolean;
  confidence: "none" | "advisory" | "gated";
  baselineRuns: number;
  findings: RegressionFinding[];
}

export interface RegressionThresholds {
  /** Baseline runs required before findings can fail a build. */
  minBaselineRuns?: number;
  /** Fractional token-cost growth tolerated before it counts. */
  tokenTolerance?: number;
  /** Fractional wall-clock growth tolerated before it counts. */
  durationTolerance?: number;
  /** Absolute score drop tolerated. */
  scoreTolerance?: number;
  /** Absolute verified-rate drop tolerated. */
  verifiedTolerance?: number;
  /** Absolute false-green climb tolerated. */
  falseGreenTolerance?: number;
}

const DEFAULT_THRESHOLDS: Required<RegressionThresholds> = {
  minBaselineRuns: 2,
  tokenTolerance: 0.25,
  durationTolerance: 0.5,
  scoreTolerance: 0.02,
  verifiedTolerance: 0.1,
  falseGreenTolerance: 0.05,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asUsage(value: unknown): GauntletUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const read = (key: string) => (isFiniteNumber(usage[key]) ? usage[key] as number : 0);
  return {
    inputTokens: read("inputTokens"),
    outputTokens: read("outputTokens"),
    cacheReadTokens: read("cacheReadTokens"),
    cacheWriteTokens: read("cacheWriteTokens"),
    reasoningTokens: read("reasoningTokens"),
    modelCalls: read("modelCalls"),
  };
}

function asMetrics(value: unknown): ScoreboardMetrics | null {
  if (!value || typeof value !== "object") return null;
  const metrics = value as Record<string, unknown>;
  if (!isFiniteNumber(metrics.tokensPerScorePoint)) return null;
  const read = (key: string) => (isFiniteNumber(metrics[key]) ? metrics[key] as number : 0);
  return {
    integrityRate: read("integrityRate"),
    verifiedTaskRate: read("verifiedTaskRate"),
    falseGreenRate: read("falseGreenRate"),
    verifiedMismatchRate: read("verifiedMismatchRate"),
    tokensPerScorePoint: metrics.tokensPerScorePoint as number,
  };
}

/** One JSONL row → a typed row, or null if it can't be trusted. */
export function parseScoreboardRow(value: unknown): ScoreboardRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  // Incomplete runs were aborted or errored partway. They are already excluded
  // at write time; excluding them again here keeps hand-edited files honest.
  if (row.complete !== true) return null;
  if (typeof row.at !== "string" || !row.at) return null;
  if (typeof row.suite !== "string" || !row.suite) return null;
  if (typeof row.provider !== "string" || !row.provider) return null;
  if (typeof row.model !== "string" || !row.model) return null;
  if (typeof row.taskManifestHash !== "string" || !row.taskManifestHash) return null;
  if (typeof row.harness !== "boolean") return null;
  if (!isFiniteNumber(row.total)) return null;
  const usage = asUsage(row.usage);
  const metrics = asMetrics(row.metrics);
  if (!usage || !metrics) return null;
  return {
    at: row.at,
    ...(isFiniteNumber(row.schemaVersion) ? { schemaVersion: row.schemaVersion } : {}),
    suite: row.suite,
    harness: row.harness,
    complete: true,
    taskManifestHash: row.taskManifestHash,
    provider: row.provider,
    model: row.model,
    total: row.total,
    ...(isFiniteNumber(row.durationMs) ? { durationMs: row.durationMs } : {}),
    usage,
    metrics,
    ...(row.harnessManifest && typeof row.harnessManifest === "object"
      ? { harnessManifest: row.harnessManifest as Record<string, unknown> }
      : {}),
  };
}

/**
 * Read the append-only scoreboard. Malformed lines are skipped rather than
 * fatal — a truncated final write must never cost you the whole history.
 * Returns oldest-first.
 */
export function parseScoreboard(text: string): ScoreboardRow[] {
  const rows: ScoreboardRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const row = parseScoreboardRow(parsed);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * The comparability key. Two runs may be trended against each other only when
 * this matches: same tasks, same model, same harness setting. The prompt and
 * tool-schema hashes are deliberately excluded — they move when the harness
 * moves, and that is the experiment, not the contamination.
 */
export function scoreboardCellKey(row: Pick<ScoreboardRow, "suite" | "taskManifestHash" | "provider" | "model" | "harness">): string {
  return [row.suite, row.taskManifestHash, row.provider, row.model, row.harness ? "harness" : "bare"].join("|");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median resists the one pathological run; latest shows where you are now. */
function statOf(rows: ScoreboardRow[], pick: (row: ScoreboardRow) => number): CellStat {
  return { median: median(rows.map(pick)), latest: pick(rows[rows.length - 1]) };
}

function optionalStat(rows: ScoreboardRow[], pick: (row: ScoreboardRow) => number | undefined): CellStat | null {
  const present = rows.filter((row) => isFiniteNumber(pick(row)));
  if (present.length === 0) return null;
  return statOf(present, (row) => pick(row) as number);
}

/** Group comparable runs and reduce each group to its central estimate. */
export function summarizeCells(rows: readonly ScoreboardRow[]): ScoreboardCell[] {
  const groups = new Map<string, ScoreboardRow[]>();
  for (const row of rows) {
    const key = scoreboardCellKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const cells: ScoreboardCell[] = [];
  for (const [key, group] of groups) {
    const ordered = [...group].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const head = ordered[0];
    cells.push({
      key,
      suite: head.suite,
      taskManifestHash: head.taskManifestHash,
      provider: head.provider,
      model: head.model,
      harness: head.harness,
      runs: ordered.length,
      firstAt: head.at,
      lastAt: ordered[ordered.length - 1].at,
      rows: [...ordered].reverse(),
      total: statOf(ordered, (row) => row.total),
      tokensPerScorePoint: statOf(ordered, (row) => row.metrics.tokensPerScorePoint),
      verifiedTaskRate: statOf(ordered, (row) => row.metrics.verifiedTaskRate),
      falseGreenRate: statOf(ordered, (row) => row.metrics.falseGreenRate),
      integrityRate: statOf(ordered, (row) => row.metrics.integrityRate),
      totalTokens: statOf(ordered, (row) => row.usage.inputTokens + row.usage.outputTokens),
      durationMs: optionalStat(ordered, (row) => row.durationMs),
    });
  }
  return cells.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.key.localeCompare(b.key)));
}

/**
 * The A/B the benchmark exists for: same tasks, same model, harness on vs off.
 * `tokenRatio` is off ÷ on, so >1 means the harness bought the same score for
 * fewer tokens. A ratio below 1 with no verified-rate or score gain is the
 * harness costing more and buying nothing — say it plainly.
 */
export function harnessDeltas(cells: readonly ScoreboardCell[]): HarnessDelta[] {
  const pairs = new Map<string, { on?: ScoreboardCell; off?: ScoreboardCell }>();
  for (const cell of cells) {
    const key = [cell.suite, cell.taskManifestHash, cell.provider, cell.model].join("|");
    const pair = pairs.get(key) ?? {};
    if (cell.harness) pair.on = cell;
    else pair.off = cell;
    pairs.set(key, pair);
  }
  const deltas: HarnessDelta[] = [];
  for (const { on, off } of pairs.values()) {
    if (!on || !off) continue;
    const tokenRatio = on.tokensPerScorePoint.median > 0
      ? off.tokensPerScorePoint.median / on.tokensPerScorePoint.median
      : 0;
    const verifiedDelta = on.verifiedTaskRate.median - off.verifiedTaskRate.median;
    const scoreDelta = on.total.median - off.total.median;
    deltas.push({
      suite: on.suite,
      taskManifestHash: on.taskManifestHash,
      provider: on.provider,
      model: on.model,
      onRuns: on.runs,
      offRuns: off.runs,
      tokenRatio,
      verifiedDelta,
      scoreDelta,
      paysOff: scoreDelta > 0 || verifiedDelta > 0 || tokenRatio > 1.02,
      confidence: Math.min(on.runs, off.runs) >= 2 ? "measured" : "advisory",
    });
  }
  return deltas.sort((a, b) => a.suite.localeCompare(b.suite) || a.model.localeCompare(b.model));
}

function ratioFinding(
  axis: RegressionAxis,
  baseline: number,
  current: number,
  tolerance: number,
  unit: string,
): RegressionFinding | null {
  if (baseline <= 0) return null;
  const growth = current / baseline - 1;
  if (growth <= tolerance) return null;
  return {
    axis,
    baseline,
    current,
    summary: `${axis} rose ${Math.round(growth * 100)}% (${formatCompact(baseline)}${unit} → ${formatCompact(current)}${unit})`,
  };
}

function dropFinding(axis: RegressionAxis, baseline: number, current: number, tolerance: number): RegressionFinding | null {
  const drop = baseline - current;
  if (drop <= tolerance) return null;
  return {
    axis,
    baseline,
    current,
    summary: `${axis} fell ${Math.round(drop * 100)} points (${Math.round(baseline * 100)}% → ${Math.round(current * 100)}%)`,
  };
}

function climbFinding(axis: RegressionAxis, baseline: number, current: number, tolerance: number): RegressionFinding | null {
  const climb = current - baseline;
  if (climb <= tolerance) return null;
  return {
    axis,
    baseline,
    current,
    summary: `${axis} climbed ${Math.round(climb * 100)} points (${Math.round(baseline * 100)}% → ${Math.round(current * 100)}%)`,
  };
}

/**
 * Judge a run against its own history. The baseline is every comparable run
 * that came BEFORE it — a run is never its own baseline, and a later run never
 * grades an earlier one.
 */
export function detectRegression(
  current: ScoreboardRow,
  history: readonly ScoreboardRow[],
  thresholds: RegressionThresholds = {},
): RegressionVerdict {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const key = scoreboardCellKey(current);
  const baseline = history.filter((row) => scoreboardCellKey(row) === key && row.at < current.at);
  if (baseline.length === 0) {
    return { regressed: false, confidence: "none", baselineRuns: 0, findings: [] };
  }

  const findings: RegressionFinding[] = [];
  const push = (finding: RegressionFinding | null) => {
    if (finding) findings.push(finding);
  };

  push(dropFinding("total", median(baseline.map((row) => row.total)), current.total, limits.scoreTolerance));
  push(ratioFinding(
    "tokensPerScorePoint",
    median(baseline.map((row) => row.metrics.tokensPerScorePoint)),
    current.metrics.tokensPerScorePoint,
    limits.tokenTolerance,
    "",
  ));
  push(dropFinding(
    "verifiedTaskRate",
    median(baseline.map((row) => row.metrics.verifiedTaskRate)),
    current.metrics.verifiedTaskRate,
    limits.verifiedTolerance,
  ));
  push(climbFinding(
    "falseGreenRate",
    median(baseline.map((row) => row.metrics.falseGreenRate)),
    current.metrics.falseGreenRate,
    limits.falseGreenTolerance,
  ));
  // Duration only when both sides recorded it — legacy rows predate the field
  // and must not be filled in with a guess.
  const timedBaseline = baseline.map((row) => row.durationMs).filter(isFiniteNumber);
  if (timedBaseline.length > 0 && isFiniteNumber(current.durationMs)) {
    push(ratioFinding("durationMs", median(timedBaseline), current.durationMs, limits.durationTolerance, "ms"));
  }

  const confidence = baseline.length >= limits.minBaselineRuns ? "gated" : "advisory";
  return {
    regressed: confidence === "gated" && findings.length > 0,
    confidence,
    baselineRuns: baseline.length,
    findings,
  };
}

export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** The human-readable trend: one line per comparable cell, then the A/B. */
export function renderTrend(rows: readonly ScoreboardRow[]): string {
  const cells = summarizeCells(rows);
  if (cells.length === 0) return "no completed runs on the scoreboard yet\n";
  const lines: string[] = [];
  for (const cell of cells) {
    const duration = cell.durationMs ? ` · ${Math.round(cell.durationMs.median / 1000)}s` : "";
    lines.push(
      `${cell.suite} · ${cell.model} via ${cell.provider} · harness ${cell.harness ? "ON " : "OFF"} · ${cell.runs} run${cell.runs === 1 ? "" : "s"}`,
    );
    lines.push(
      `  score ${pct(cell.total.median)} · ${formatCompact(cell.tokensPerScorePoint.median)} tok/point · ` +
      `verified ${pct(cell.verifiedTaskRate.median)} · false-green ${pct(cell.falseGreenRate.median)}${duration}`,
    );
    lines.push(`  last ${cell.lastAt}`);
  }
  const deltas = harnessDeltas(cells);
  if (deltas.length > 0) {
    lines.push("", "harness A/B (off ÷ on tokens per score point):");
    for (const delta of deltas) {
      const verdict = delta.paysOff
        ? `harness pays — ${delta.tokenRatio.toFixed(2)}x cheaper per point`
        : `harness costs ${Math.round((1 / Math.max(delta.tokenRatio, 1e-9) - 1) * 100)}% more per point and buys nothing measurable`;
      lines.push(
        `  ${delta.suite} · ${delta.model}: ${verdict} · verified ${delta.verifiedDelta >= 0 ? "+" : ""}${Math.round(delta.verifiedDelta * 100)} pts ` +
        `· n=${delta.onRuns}/${delta.offRuns}${delta.confidence === "advisory" ? " (advisory — re-measure)" : ""}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
