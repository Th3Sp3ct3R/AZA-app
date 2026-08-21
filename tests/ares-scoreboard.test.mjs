// The scoreboard reader — the half of the benchmark that was missing.
//
// `ares eval coding` has been appending every completed run to
// ~/.ares/gauntlet/scoreboard.jsonl since C6. Nothing ever read it. These tests
// pin the reader: comparable runs group into cells, cells trend, harness-on vs
// harness-off pairs into a delta, and a new run is judged against its own
// history on the axes that still discriminate at frontier tier — tokens per
// score point, verified rate, false-green rate, duration — NOT the score, which
// coding-v3 proved saturates.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseScoreboard,
  scoreboardCellKey,
  summarizeCells,
  harnessDeltas,
  detectRegression,
  renderTrend,
} from "../packages/operator/dist/index.js";

function row(overrides = {}) {
  const {
    inputTokens = 1000,
    outputTokens = 0,
    total = 1,
    tokensPerScorePoint = inputTokens + outputTokens,
    verifiedTaskRate = 0.8,
    falseGreenRate = 0,
    integrityRate = 1,
    verifiedMismatchRate = 0,
    ...rest
  } = overrides;
  return {
    at: "2026-08-15T05:18:19.759Z",
    schemaVersion: 2,
    suite: "coding-v3",
    harness: true,
    official: false,
    isolation: "process",
    complete: true,
    taskManifestHash: "manifest-a",
    systemPromptHash: "prompt-a",
    startupReminderHash: "reminder-a",
    toolSchemaHash: "tools-a",
    provider: "openrouter",
    model: "deepseek-v4-pro",
    total,
    durationMs: 60_000,
    usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, modelCalls: 4 },
    metrics: { integrityRate, verifiedTaskRate, falseGreenRate, verifiedMismatchRate, tokensPerScorePoint },
    ...rest,
  };
}

const lines = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// ─── parsing ────────────────────────────────────────────────────────────────

test("scoreboard: parses JSONL and survives junk without losing good rows", () => {
  const text = [
    JSON.stringify(row({ at: "2026-08-15T05:00:00.000Z" })),
    "",
    "{ not json",
    JSON.stringify({ at: "x", suite: "coding-v3" }), // missing required fields
    JSON.stringify(row({ at: "2026-08-15T06:00:00.000Z" })),
  ].join("\n");
  const rows = parseScoreboard(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.at), ["2026-08-15T05:00:00.000Z", "2026-08-15T06:00:00.000Z"]);
});

test("scoreboard: incomplete runs are excluded from trend history", () => {
  const rows = parseScoreboard(lines(row({ complete: false }), row({ at: "2026-08-15T07:00:00.000Z" })));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].at, "2026-08-15T07:00:00.000Z");
});

test("scoreboard: rows sort by time regardless of file order", () => {
  const rows = parseScoreboard(lines(
    row({ at: "2026-08-15T09:00:00.000Z" }),
    row({ at: "2026-08-15T08:00:00.000Z" }),
  ));
  assert.deepEqual(rows.map((r) => r.at), ["2026-08-15T08:00:00.000Z", "2026-08-15T09:00:00.000Z"]);
});

// ─── comparability ──────────────────────────────────────────────────────────

test("scoreboard: the cell key is what makes two runs comparable", () => {
  const base = row();
  // Same suite, tasks, model, provider, harness → same cell.
  assert.equal(scoreboardCellKey(base), scoreboardCellKey(row({ at: "later" })));
  // A changed harness, model, provider, suite, or task manifest is a DIFFERENT
  // experiment and must never be trended against the old one.
  assert.notEqual(scoreboardCellKey(base), scoreboardCellKey(row({ harness: false })));
  assert.notEqual(scoreboardCellKey(base), scoreboardCellKey(row({ model: "other" })));
  assert.notEqual(scoreboardCellKey(base), scoreboardCellKey(row({ provider: "anthropic" })));
  assert.notEqual(scoreboardCellKey(base), scoreboardCellKey(row({ suite: "coding-v2" })));
  assert.notEqual(scoreboardCellKey(base), scoreboardCellKey(row({ taskManifestHash: "manifest-b" })));
  // The prompt and tool schemas CHANGE when the harness changes — that is the
  // thing under test, so they must not split the cell.
  assert.equal(scoreboardCellKey(base), scoreboardCellKey(row({ systemPromptHash: "p2", toolSchemaHash: "t2" })));
});

test("scoreboard: cells summarize with run counts and median-not-mean", () => {
  const cells = summarizeCells(parseScoreboard(lines(
    row({ at: "2026-08-15T01:00:00.000Z", inputTokens: 100 }),
    row({ at: "2026-08-15T02:00:00.000Z", inputTokens: 200 }),
    // An outlier run must not drag the central estimate the way a mean would.
    row({ at: "2026-08-15T03:00:00.000Z", inputTokens: 6000 }),
    row({ at: "2026-08-15T04:00:00.000Z", harness: false, inputTokens: 500 }),
  )));
  assert.equal(cells.length, 2);
  const on = cells.find((c) => c.harness);
  assert.equal(on.runs, 3);
  assert.equal(on.tokensPerScorePoint.median, 200);
  assert.equal(on.tokensPerScorePoint.latest, 6000);
  assert.equal(on.firstAt, "2026-08-15T01:00:00.000Z");
  assert.equal(on.lastAt, "2026-08-15T03:00:00.000Z");
  const off = cells.find((c) => !c.harness);
  assert.equal(off.runs, 1);
});

// ─── the A/B the whole benchmark exists for ─────────────────────────────────

test("scoreboard: harness delta pairs on/off and says which way it paid", () => {
  const [delta] = harnessDeltas(summarizeCells(parseScoreboard(lines(
    row({ at: "2026-08-15T05:18:19.759Z", suite: "coding-v2", inputTokens: 250_693, verifiedTaskRate: 0.75 }),
    row({ at: "2026-08-15T05:28:36.077Z", suite: "coding-v2", harness: false, inputTokens: 413_979, verifiedTaskRate: 0.5 }),
  ))));
  assert.equal(delta.suite, "coding-v2");
  assert.equal(delta.onRuns, 1);
  assert.equal(delta.offRuns, 1);
  // Harness ON costs 250k/point vs 413k/point OFF → it pays for itself.
  assert.ok(delta.tokenRatio > 1.6 && delta.tokenRatio < 1.7, `ratio ${delta.tokenRatio}`);
  assert.equal(delta.paysOff, true);
  assert.ok(Math.abs(delta.verifiedDelta - 0.25) < 1e-9);
  // n=1 per side is a signal to re-measure, not a verdict — say so.
  assert.equal(delta.confidence, "advisory");
});

test("scoreboard: a harness that costs more and buys nothing is reported as such", () => {
  // The real coding-v3 numbers: same score, same verified rate, 24% MORE tokens.
  const [delta] = harnessDeltas(summarizeCells(parseScoreboard(lines(
    row({ at: "2026-08-15T06:19:16.130Z", inputTokens: 131_446, verifiedTaskRate: 0.8 }),
    row({ at: "2026-08-15T06:24:52.463Z", harness: false, inputTokens: 105_780, verifiedTaskRate: 0.8 }),
  ))));
  assert.ok(delta.tokenRatio < 1, `ratio ${delta.tokenRatio}`);
  assert.equal(delta.paysOff, false);
  assert.equal(delta.verifiedDelta, 0);
  assert.equal(delta.scoreDelta, 0);
});

test("scoreboard: an unpaired cell produces no delta", () => {
  assert.deepEqual(harnessDeltas(summarizeCells(parseScoreboard(lines(row())))), []);
});

test("scoreboard: deltas never pair across different task manifests", () => {
  assert.deepEqual(
    harnessDeltas(summarizeCells(parseScoreboard(lines(
      row(),
      row({ harness: false, taskManifestHash: "manifest-b" }),
    )))),
    [],
  );
});

// ─── the gate ───────────────────────────────────────────────────────────────

test("regression: a token-cost blowout fails even when the score is still perfect", () => {
  const history = parseScoreboard(lines(
    row({ at: "2026-08-15T01:00:00.000Z", inputTokens: 100_000 }),
    row({ at: "2026-08-15T02:00:00.000Z", inputTokens: 100_000 }),
  ));
  const verdict = detectRegression(row({ at: "2026-08-15T03:00:00.000Z", inputTokens: 200_000 }), history);
  assert.equal(verdict.regressed, true);
  assert.equal(verdict.confidence, "gated");
  assert.ok(verdict.findings.some((f) => f.axis === "tokensPerScorePoint"));
  // The score axis is untouched — proving the gate does not depend on it.
  assert.ok(!verdict.findings.some((f) => f.axis === "total"));
});

test("regression: verified rate falling is a regression; rising is not", () => {
  const history = parseScoreboard(lines(
    row({ at: "2026-08-15T01:00:00.000Z", verifiedTaskRate: 0.8 }),
    row({ at: "2026-08-15T02:00:00.000Z", verifiedTaskRate: 0.8 }),
  ));
  const fell = detectRegression(row({ at: "2026-08-15T03:00:00.000Z", verifiedTaskRate: 0.5 }), history);
  assert.ok(fell.findings.some((f) => f.axis === "verifiedTaskRate"));
  const rose = detectRegression(row({ at: "2026-08-15T03:00:00.000Z", verifiedTaskRate: 1 }), history);
  assert.equal(rose.regressed, false);
});

test("regression: a score drop and a false-green climb are both caught", () => {
  const history = parseScoreboard(lines(
    row({ at: "2026-08-15T01:00:00.000Z" }),
    row({ at: "2026-08-15T02:00:00.000Z" }),
  ));
  const scored = detectRegression(row({ at: "2026-08-15T03:00:00.000Z", total: 0.6 }), history);
  assert.ok(scored.findings.some((f) => f.axis === "total"));
  const lying = detectRegression(row({ at: "2026-08-15T03:00:00.000Z", falseGreenRate: 0.5 }), history);
  assert.ok(lying.findings.some((f) => f.axis === "falseGreenRate"));
});

test("regression: noise inside tolerance is not a regression", () => {
  const history = parseScoreboard(lines(
    row({ at: "2026-08-15T01:00:00.000Z", inputTokens: 100_000 }),
    row({ at: "2026-08-15T02:00:00.000Z", inputTokens: 100_000 }),
  ));
  const verdict = detectRegression(row({ at: "2026-08-15T03:00:00.000Z", inputTokens: 110_000 }), history);
  assert.equal(verdict.regressed, false);
});

test("regression: one prior run is advisory, never a hard gate", () => {
  const history = parseScoreboard(lines(row({ at: "2026-08-15T01:00:00.000Z", inputTokens: 100_000 })));
  const verdict = detectRegression(row({ at: "2026-08-15T02:00:00.000Z", inputTokens: 500_000 }), history);
  assert.equal(verdict.baselineRuns, 1);
  assert.equal(verdict.confidence, "advisory");
  assert.equal(verdict.regressed, false, "n=1 baselines are too noisy to fail a build");
  assert.ok(verdict.findings.length > 0, "but the finding is still reported");
});

test("regression: no comparable history is not a failure", () => {
  const verdict = detectRegression(row(), parseScoreboard(lines(row({ model: "someone-else" }))));
  assert.equal(verdict.baselineRuns, 0);
  assert.equal(verdict.regressed, false);
  assert.equal(verdict.confidence, "none");
  assert.deepEqual(verdict.findings, []);
});

test("regression: the run being judged is never its own baseline", () => {
  const current = row({ at: "2026-08-15T03:00:00.000Z", inputTokens: 200_000 });
  const history = parseScoreboard(lines(
    row({ at: "2026-08-15T01:00:00.000Z", inputTokens: 100_000 }),
    row({ at: "2026-08-15T02:00:00.000Z", inputTokens: 100_000 }),
    current,
  ));
  const verdict = detectRegression(current, history);
  assert.equal(verdict.baselineRuns, 2);
  assert.equal(verdict.regressed, true);
});

test("regression: duration blowout is caught, and missing durations are tolerated", () => {
  const history = parseScoreboard(lines(
    row({ at: "2026-08-15T01:00:00.000Z", durationMs: 60_000 }),
    row({ at: "2026-08-15T02:00:00.000Z", durationMs: 60_000 }),
  ));
  const slow = detectRegression(row({ at: "2026-08-15T03:00:00.000Z", durationMs: 300_000 }), history);
  assert.ok(slow.findings.some((f) => f.axis === "durationMs"));
  // Rows written before durationMs was recorded must not crash or fabricate.
  const legacy = parseScoreboard(lines(
    row({ at: "2026-08-15T01:00:00.000Z", durationMs: undefined }),
    row({ at: "2026-08-15T02:00:00.000Z", durationMs: undefined }),
  ));
  const verdict = detectRegression(row({ at: "2026-08-15T03:00:00.000Z", durationMs: 300_000 }), legacy);
  assert.ok(!verdict.findings.some((f) => f.axis === "durationMs"));
});

// ─── rendering ──────────────────────────────────────────────────────────────

test("scoreboard: the trend renders cells, deltas, and an empty-history line", () => {
  const rows = parseScoreboard(lines(
    row({ at: "2026-08-15T06:19:16.130Z", inputTokens: 131_446 }),
    row({ at: "2026-08-15T06:24:52.463Z", harness: false, inputTokens: 105_780 }),
  ));
  const text = renderTrend(rows);
  assert.match(text, /coding-v3/);
  assert.match(text, /deepseek-v4-pro/);
  assert.match(text, /harness/i);
  assert.match(text, /131k|131,446|131446/);
  assert.match(renderTrend([]), /no completed runs/i);
});
