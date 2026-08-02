// Local reliability triage: turn Ares's disconnected diagnostic planes into a
// durable, deterministic review queue.
//
// This collector is intentionally NOT an agent. Raw rollout/crash text is
// untrusted data: the scanner only parses typed failure events, redacts and
// bounds excerpts, clusters stable signatures, and writes candidate findings.
// It never executes a recovered command, edits a workspace, creates a goal, or
// calls a model. Human approval is a state transition, not permission to run.

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "@ares/protocol";
import { failureDigest } from "./codingJournal.js";
import { aresHome } from "./providers/openaiAuth.js";
import {
  listRegisteredSessionLocations,
  type SessionLocation,
} from "./sessionRegistry.js";

export type ReliabilityFindingStatus =
  | "watching"
  | "candidate"
  | "acknowledged"
  | "dismissed"
  | "resolved";

export type ReliabilitySeverity = "critical" | "high" | "medium" | "low";
export type ReliabilityCategory = "product" | "environment" | "task";
export type ReliabilitySignalKind =
  | "crash"
  | "engine_error"
  | "tool_error"
  | "failed_turn"
  | "failed_subagent";

export interface ReliabilityEvidence {
  source: "session" | "garrison" | "friction" | "crash";
  at: string;
  /** Diagnostic text is untrusted, redacted, single-line, and bounded. */
  summary: string;
  /** Opaque local pointer; raw paths live only in the private triage state. */
  sourceRef: string;
  sessionId?: string;
  turnId?: string;
  seq?: number;
  tool?: string;
  code?: string;
}

export interface ReliabilityFinding {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  kind: ReliabilitySignalKind;
  title: string;
  category: ReliabilityCategory;
  severity: ReliabilitySeverity;
  confidence: "high" | "medium" | "low";
  status: ReliabilityFindingStatus;
  occurrences: number;
  distinctSessions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  /** Hashed exact set for stable distinct-session counts without raw-id growth. */
  sessionHashes?: string[];
  /** Bounded correlation keys make rescans/truncation idempotent. */
  observationKeys: string[];
  evidence: ReliabilityEvidence[];
  suggestedAction: string;
  projectHash?: string;
  openedAt?: string;
  acknowledgedAt?: string;
  dismissedAt?: string;
  resolvedAt?: string;
  statusNote?: string;
  recurrenceCount?: number;
}

export interface ReliabilityTriageHealth {
  frictionTurns: number;
  failedTurns: number;
  interruptedTurns: number;
  stalls: number;
  reasoningStalls: number;
  verifierReminders: number;
  toolCalls: number;
  toolErrors: number;
  crashRecords: number;
  sessionEvents: number;
}

export interface ReliabilityTriageCoverage {
  files: number;
  bytesRead: number;
  malformedLines: number;
  skippedBytes: number;
  observations: number;
  duplicateObservations: number;
}

export interface ReliabilityTriageRun {
  schemaVersion: 1;
  at: string;
  home: string;
  workspace: string;
  skipped?: "disabled" | "test" | "cadence" | "locked";
  health: ReliabilityTriageHealth;
  coverage: ReliabilityTriageCoverage;
  newCandidates: string[];
  reopened: string[];
  updated: string[];
  openFindings: number;
  watchingFindings: number;
  warnings: string[];
}

export interface ReliabilityTriageOptions {
  home?: string;
  /** Additional Ares homes whose local telemetry/registry planes should join the scan. */
  homes?: string[];
  workspace?: string;
  /** Extra roots from callers that know about non-default workspaces. */
  workspaces?: string[];
  now?: Date;
  lookbackDays?: number;
  minimumIntervalMs?: number;
  force?: boolean;
  persist?: boolean;
  allowInTests?: boolean;
  /** Manual backfill: stream history from byte zero instead of the recent tail. */
  fullHistory?: boolean;
  /** Work budget for one pass; automatic maintenance defaults to 64 MiB. */
  maxBytesPerRun?: number;
  /** Test/diagnostic seams; production values remain bounded by the hard caps. */
  maxObservationsPerRun?: number;
  maxClustersPerRun?: number;
}

export interface ReliabilityTriagePaths {
  root: string;
  findingsDir: string;
  runsDir: string;
  stateFile: string;
  lockFile: string;
}

interface FileCursor {
  offset: number;
  toolNames?: Record<string, string>;
  sessionId?: string;
  turnId?: string;
  turnHadDiagnostic?: boolean;
}

interface ReliabilityTriageState {
  schemaVersion: 1;
  lastRunAt?: string;
  cursors: Record<string, FileCursor>;
  seen: string[];
  sources: Record<string, string>;
  backfillPending?: boolean;
}

interface InputFile {
  source: ReliabilityEvidence["source"];
  file: string;
  /** Root that owns home-local telemetry/crash/Garrison layouts. */
  homeRoot?: string;
  workspace?: string;
  sessionId?: string;
  projectHash?: string;
}

interface ObservationPolicy {
  category: ReliabilityCategory;
  severity: ReliabilitySeverity;
  confidence: ReliabilityFinding["confidence"];
  minOccurrences: number;
  minSessions: number;
  suggestedAction: string;
}

interface Observation {
  key: string;
  fingerprint: string;
  findingId: string;
  kind: ReliabilitySignalKind;
  title: string;
  at: string;
  policy: ObservationPolicy;
  evidence: ReliabilityEvidence;
  sourceFile: string;
  projectHash?: string;
}

interface ParsedLine {
  raw: string;
  row: unknown;
  /** Absolute byte offset immediately after this JSONL record's newline. */
  endOffset: number;
}

interface ReadResult {
  lines: ParsedLine[];
  cursor: FileCursor;
  bytesRead: number;
  malformed: number;
  skippedBytes: number;
  eof: boolean;
}

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_BYTES_PER_FILE = 16 * 1024 * 1024;
const MAX_FULL_HISTORY_BYTES_PER_FILE = 512 * 1024 * 1024;
const MAX_BYTES_PER_RUN = 512 * 1024 * 1024;
const DEFAULT_AUTOMATIC_BYTES_PER_RUN = 64 * 1024 * 1024;
const MAX_EVIDENCE = 6;
const MAX_OBSERVATION_KEYS = 2_048;
const MAX_STATE_SEEN = 50_000;
const MAX_RUN_FILES = 30;
const LOCK_STALE_MS = 15 * 60_000;
const MAX_OBSERVATIONS_PER_RUN = 10_000;
const MAX_CLUSTERS_PER_RUN = 1_000;

export function reliabilityTriagePaths(home = aresHome()): ReliabilityTriagePaths {
  const root = path.join(path.resolve(home), "triage");
  return {
    root,
    findingsDir: path.join(root, "findings"),
    runsDir: path.join(root, "runs"),
    stateFile: path.join(root, "state.json"),
    lockFile: path.join(root, "scan.lock"),
  };
}

export async function runReliabilityTriage(
  options: ReliabilityTriageOptions = {},
): Promise<ReliabilityTriageRun> {
  const now = options.now ?? new Date();
  const home = path.resolve(options.home ?? aresHome());
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const paths = reliabilityTriagePaths(home);
  const empty = emptyRun(now, home, workspace);
  if (process.env.ARES_SELF_TRIAGE === "0" && !options.force) {
    return { ...empty, skipped: "disabled" };
  }
  if (process.env.NODE_TEST_CONTEXT && !options.allowInTests) {
    return { ...empty, skipped: "test" };
  }
  if (
    process.env.NODE_TEST_CONTEXT &&
    options.allowInTests &&
    (!options.home || !options.workspace)
  ) {
    return { ...empty, skipped: "test" };
  }

  const persist = options.persist !== false;
  let release: (() => Promise<void>) | null = null;
  if (persist) {
    await fs.mkdir(paths.root, { recursive: true });
    release = await acquireLock(paths.lockFile, now);
    if (!release) return { ...empty, skipped: "locked" };
  }

  try {
    const state = await loadState(paths.stateFile);
    const minimumIntervalMs = nonNegativeNumber(
      options.minimumIntervalMs,
      envNumber("ARES_SELF_TRIAGE_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    );
    if (
      !options.force &&
      !state.backfillPending &&
      state.lastRunAt &&
      now.getTime() - Date.parse(state.lastRunAt) < minimumIntervalMs
    ) {
      return { ...empty, skipped: "cadence" };
    }

    const workspaces = uniquePaths([
      workspace,
      ...(options.workspaces ?? []),
      ...configuredTriageWorkspaces(),
      ...(!process.env.NODE_TEST_CONTEXT ? defaultDesktopWorkspaces() : []),
    ]);
    const sourceHomes = uniquePaths([
      home,
      ...(options.homes ?? []),
      ...(!process.env.NODE_TEST_CONTEXT ? defaultAresHomes() : []),
    ]);
    const files = await collectInputFiles(sourceHomes, workspaces);
    const findings = await loadFindingMap(paths.findingsDir);
    const stateSeen = new Set(state.seen);
    const groups = new Map<string, Observation[]>();
    const run = emptyRun(now, home, workspace);
    run.coverage.files = files.length;
    const cutoff = now.getTime() -
      Math.max(1, options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 86_400_000;
    const runByteBudget = Math.min(
      MAX_BYTES_PER_RUN,
      Math.max(
        MAX_BYTES_PER_FILE,
        options.maxBytesPerRun ?? (options.force ? MAX_BYTES_PER_RUN : DEFAULT_AUTOMATIC_BYTES_PER_RUN),
      ),
    );
    let budgetExhausted = false;
    let safetyCapReached = false;
    let novelObservations = 0;
    const observationCap = positiveCappedNumber(
      options.maxObservationsPerRun,
      MAX_OBSERVATIONS_PER_RUN,
    );
    const clusterCap = positiveCappedNumber(
      options.maxClustersPerRun,
      MAX_CLUSTERS_PER_RUN,
    );

    inputLoop: for (const input of files) {
      const runRemaining = runByteBudget - run.coverage.bytesRead;
      if (runRemaining <= 0) {
        run.warnings.push("Run byte budget reached; remaining sources resume on the next pass.");
        budgetExhausted = true;
        break;
      }
      const key = fileKey(input.file);
      let cursor: FileCursor = options.fullHistory
        ? { offset: 0 }
        : (state.cursors[key] ?? { offset: 0 });
      const budget = Math.min(MAX_FULL_HISTORY_BYTES_PER_FILE, runRemaining);
      let consumed = 0;
      let fileEof = false;
      do {
        const beforeOffset = cursor.offset;
        const chunkStartCursor = cloneCursor(cursor);
        const chunkBytes = Math.min(MAX_BYTES_PER_FILE, budget - consumed);
        const read = await readNewLines(input.file, cursor, {
          maxBytes: chunkBytes,
          tailInitial: false,
        }).catch((error: unknown) => {
          run.warnings.push(
            "Could not read " + input.source + " source src_" +
              sha(fileKey(input.file)).slice(0, 16) + ": " + errorText(error),
          );
          return null;
        });
        if (!read) break;
        fileEof = read.eof;
        cursor = read.cursor;
        state.cursors[key] = cursor;
        consumed += read.bytesRead;
        run.coverage.bytesRead += read.bytesRead;
        run.coverage.malformedLines += read.malformed;
        run.coverage.skippedBytes += read.skippedBytes;

        for (const line of read.lines) {
          const parsed = parseInputLine(input, line, cursor, run.health);
          const prospectiveKeys = new Set<string>();
          const novel: Observation[] = [];
          for (const observation of parsed) {
            if (Date.parse(observation.at) < cutoff) continue;
            run.coverage.observations++;
            const existing = findings.get(observation.findingId);
            if (
              stateSeen.has(observation.key) ||
              prospectiveKeys.has(observation.key) ||
              existing?.observationKeys.includes(observation.key)
            ) {
              run.coverage.duplicateObservations++;
              continue;
            }
            prospectiveKeys.add(observation.key);
            novel.push(observation);
          }

          const newGroupIds = new Set(
            novel
              .map((observation) => observation.findingId)
              .filter((id) => !groups.has(id)),
          );
          const observationOverflow = novelObservations + novel.length > observationCap;
          const clusterOverflow = groups.size + newGroupIds.size > clusterCap;
          if (observationOverflow || clusterOverflow) {
            const warning = observationOverflow
              ? "Observation safety cap reached; remaining signals resume on the next pass."
              : "Cluster safety cap reached; remaining signals resume on the next pass.";
            if (!run.warnings.includes(warning)) run.warnings.push(warning);
            // The whole chunk is replayed next pass. Newly accepted keys make
            // its prefix cheap/idempotent, while no record beyond either cap is
            // ever marked consumed.
            cursor = chunkStartCursor;
            state.cursors[key] = cursor;
            safetyCapReached = true;
            break;
          }

          for (const observation of novel) {
            novelObservations++;
            state.sources[observation.evidence.sourceRef] = observation.sourceFile;
            const bucket = groups.get(observation.findingId) ?? [];
            stateSeen.add(observation.key);
            bucket.push(observation);
            groups.set(observation.findingId, bucket);
          }
        }
        if (safetyCapReached) break;
        if (read.bytesRead === 0 || cursor.offset <= beforeOffset) break;
      } while (consumed < budget);
      if (safetyCapReached) break inputLoop;
      if (!fileEof) budgetExhausted = true;
      if (options.fullHistory && !fileEof && consumed >= budget) {
        run.warnings.push(
          "Full-history cap reached for src_" + sha(fileKey(input.file)).slice(0, 16) + ".",
        );
      }
    }

    for (const [id, observations] of groups) {
      const before = findings.get(id);
      const merged = mergeFinding(before, observations, now);
      findings.set(id, merged.finding);
      run.updated.push(id);
      if (merged.opened) run.newCandidates.push(id);
      if (merged.reopened) run.reopened.push(id);
      if (persist) {
        await writeJsonAtomic(
          path.join(paths.findingsDir, id + ".json"),
          merged.finding,
        );
      }
    }

    state.lastRunAt = now.toISOString();
    state.backfillPending = (budgetExhausted || safetyCapReached) || undefined;
    state.seen = [...stateSeen].slice(-MAX_STATE_SEEN);
    const all = [...findings.values()];
    run.openFindings = all.filter((f) =>
      f.status === "candidate" ||
      f.status === "acknowledged"
    ).length;
    run.watchingFindings = all.filter((f) => f.status === "watching").length;
    if (persist) {
      await writeJsonAtomic(paths.stateFile, state);
      await writeRun(paths.runsDir, run);
    }
    return run;
  } finally {
    await release?.();
  }
}

export async function listReliabilityFindings(
  home = aresHome(),
): Promise<ReliabilityFinding[]> {
  const findings = [...(await loadFindingMap(reliabilityTriagePaths(home).findingsDir)).values()];
  return findings.sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) ||
    b.lastSeenAt.localeCompare(a.lastSeenAt)
  );
}

export async function loadReliabilityFinding(
  home: string,
  id: string,
): Promise<ReliabilityFinding | null> {
  if (!/^rel_[a-f0-9]{16}$/.test(id)) return null;
  return readJson<ReliabilityFinding>(
    path.join(reliabilityTriagePaths(home).findingsDir, id + ".json"),
  );
}

export async function resolveReliabilitySource(
  home: string,
  sourceRef: string,
): Promise<string | null> {
  if (!/^src_[a-f0-9]{16}$/.test(sourceRef)) return null;
  const state = await loadState(reliabilityTriagePaths(home).stateFile);
  return state.sources[sourceRef] ?? null;
}

export async function updateReliabilityFindingStatus(
  home: string,
  id: string,
  status: Extract<
    ReliabilityFindingStatus,
    "acknowledged" | "dismissed" | "resolved"
  >,
  note = "",
  now = new Date(),
): Promise<ReliabilityFinding> {
  const paths = reliabilityTriagePaths(home);
  await fs.mkdir(paths.root, { recursive: true });
  const release = await acquireLock(paths.lockFile, now);
  if (!release) throw new Error("reliability triage is busy; try again shortly");
  try {
    const finding = await loadReliabilityFinding(home, id);
    if (!finding) throw new Error("unknown reliability finding: " + id);
    if (
      status === "acknowledged" &&
      finding.status !== "candidate" &&
      finding.status !== "acknowledged"
    ) {
      throw new Error("only an active candidate can be acknowledged");
    }
    const at = now.toISOString();
    const next: ReliabilityFinding = {
      ...finding,
      status,
      updatedAt: at,
      statusNote: note.trim().slice(0, 500) || undefined,
      acknowledgedAt: status === "acknowledged" ? at : undefined,
      dismissedAt: status === "dismissed" ? at : undefined,
      resolvedAt: status === "resolved" ? at : undefined,
    };
    await writeJsonAtomic(path.join(paths.findingsDir, id + ".json"), next);
    return next;
  } finally {
    await release();
  }
}

function emptyRun(now: Date, home: string, workspace: string): ReliabilityTriageRun {
  return {
    schemaVersion: 1,
    at: now.toISOString(),
    home,
    workspace,
    health: {
      frictionTurns: 0,
      failedTurns: 0,
      interruptedTurns: 0,
      stalls: 0,
      reasoningStalls: 0,
      verifierReminders: 0,
      toolCalls: 0,
      toolErrors: 0,
      crashRecords: 0,
      sessionEvents: 0,
    },
    coverage: {
      files: 0,
      bytesRead: 0,
      malformedLines: 0,
      skippedBytes: 0,
      observations: 0,
      duplicateObservations: 0,
    },
    newCandidates: [],
    reopened: [],
    updated: [],
    openFindings: 0,
    watchingFindings: 0,
    warnings: [],
  };
}

async function collectInputFiles(homes: string[], workspaces: string[]): Promise<InputFile[]> {
  const files: InputFile[] = [];
  for (const home of homes) {
    const registered = await listRegisteredSessionLocations({ home }).catch(
      () => [] as SessionLocation[],
    );
    for (const location of registered) {
      files.push({
        source: location.source === "garrison" ? "garrison" : "session",
        file: location.rolloutPath,
        homeRoot: location.source === "garrison" ? home : undefined,
        sessionId: location.sessionId,
        projectHash: location.workspaceHash,
      });
    }
  }

  for (const workspace of workspaces) {
    const root = path.join(workspace, ".ares", "sessions");
    for (const dir of await safeDirectories(root)) {
      files.push({
        source: "session",
        file: path.join(root, dir, "events.jsonl"),
        workspace,
        sessionId: dir,
        projectHash: hashPath(workspace),
      });
    }
  }

  for (const home of homes) {
    const homeSessions = path.join(home, "sessions");
    for (const dir of await safeDirectories(homeSessions)) {
      files.push({
        source: "session",
        file: path.join(homeSessions, dir, "events.jsonl"),
        homeRoot: home,
        workspace: home,
        sessionId: dir,
        projectHash: hashPath(home),
      });
    }

    for (const name of await safeFiles(path.join(home, "telemetry"))) {
      if (/^friction-\d{4}-\d{2}\.jsonl$/.test(name)) {
        files.push({
          source: "friction",
          file: path.join(home, "telemetry", name),
          homeRoot: home,
        });
      }
    }
    for (const name of await safeFiles(path.join(home, "crashes"))) {
      if (name.endsWith(".jsonl")) {
        files.push({ source: "crash", file: path.join(home, "crashes", name), homeRoot: home });
      }
    }
    for (const name of await safeFiles(path.join(home, "garrison", "sessions"))) {
      if (name.endsWith(".jsonl")) {
        files.push({
          source: "garrison",
          file: path.join(home, "garrison", "sessions", name),
          homeRoot: home,
          sessionId: name.slice(0, -".jsonl".length),
        });
      }
    }
  }

  const unique = new Map<string, InputFile>();
  for (const input of files) {
    if (!isExpectedInputLayout(input)) continue;
    const info = await fs.lstat(input.file).catch(() => null);
    // lstat (not stat) is the symlinked-FILE guard: a rollout path that is
    // itself a link never gets read.
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    // The remaining risk is a symlinked ANCESTOR redirecting us out of the
    // tree, so require the canonical path to still live under the canonical
    // declared root.
    //
    // This used to demand realpath(file) === file, which conflated "escaped
    // the tree" with "the path simply wasn't canonical" — and on Windows it is
    // very often not. A GitHub runner's os.tmpdir() is C:\Users\RUNNER~1\…
    // (an 8.3 short name) whose realpath is C:\Users\runneradmin\…, so every
    // input was silently discarded and self-triage read NOTHING: no findings,
    // no warning, just a clean empty run. The same held for any owner whose
    // workspace sat behind a junction, a mapped drive, or a short-name
    // profile directory.
    const real = await fs.realpath(input.file).catch(() => null);
    if (!real) continue;
    const declaredRoot = input.workspace ?? input.homeRoot;
    if (declaredRoot) {
      const realRoot = await fs.realpath(declaredRoot).catch(() => null);
      if (!realRoot || !isPathWithin(realRoot, real)) continue;
    }
    unique.set(fileKey(real), input);
  }
  return [...unique.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function isExpectedInputLayout(input: InputFile): boolean {
  const file = path.resolve(input.file);
  const home = input.homeRoot;
  if (input.source === "friction") {
    return Boolean(home) && isPathWithin(path.join(home!, "telemetry"), file) &&
      /^friction-\d{4}-\d{2}\.jsonl$/.test(path.basename(file));
  }
  if (input.source === "crash") {
    return Boolean(home) && isPathWithin(path.join(home!, "crashes"), file) && file.endsWith(".jsonl");
  }
  if (input.source === "garrison") {
    return Boolean(home) && isPathWithin(path.join(home!, "garrison", "sessions"), file) &&
      path.basename(file) === (input.sessionId ?? path.basename(file, ".jsonl")) + ".jsonl";
  }
  if (path.basename(file) !== "events.jsonl") return false;
  const sessionDir = path.dirname(file);
  if (input.sessionId && path.basename(sessionDir) !== input.sessionId) return false;
  const sessionsDir = path.dirname(sessionDir);
  return path.basename(sessionsDir) === "sessions" &&
    (path.basename(path.dirname(sessionsDir)) === ".ares" ||
      (Boolean(home) && fileKey(sessionsDir) === fileKey(path.join(home!, "sessions"))));
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readNewLines(
  file: string,
  prior: FileCursor,
  options: { maxBytes: number; tailInitial: boolean },
): Promise<ReadResult> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    let start = Number.isFinite(prior.offset) ? Math.max(0, prior.offset) : 0;
    let skippedBytes = 0;
    if (start > stat.size) start = 0;
    let initialTail = false;
    if (options.tailInitial && start === 0 && stat.size > options.maxBytes) {
      start = stat.size - options.maxBytes;
      skippedBytes = start;
      initialTail = true;
    }
    const length = Math.min(options.maxBytes, Math.max(0, stat.size - start));
    if (length === 0) {
      return {
        lines: [],
        cursor: { ...prior, offset: stat.size },
        bytesRead: 0,
        malformed: 0,
        skippedBytes,
        eof: true,
      };
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const data = buffer.subarray(0, bytesRead);
    let from = 0;
    if (initialTail) {
      const firstBreak = data.indexOf(10);
      if (firstBreak < 0) {
        return {
          lines: [],
          cursor: { ...prior, offset: start + bytesRead },
          bytesRead,
          malformed: 1,
          skippedBytes: skippedBytes + bytesRead,
          eof: start + bytesRead >= stat.size,
        };
      }
      from = firstBreak + 1;
      skippedBytes += from;
    }
    const lastBreak = data.lastIndexOf(10);
    if (lastBreak < from) {
      // A partial EOF record must remain for the next pass. A record that fills
      // the whole safety chunk is oversized; skip a bounded segment so one
      // hostile/huge JSON value cannot wedge this file's cursor forever.
      const oversized = bytesRead >= options.maxBytes;
      return {
        lines: [],
        cursor: { ...prior, offset: oversized ? start + bytesRead : start },
        bytesRead,
        malformed: oversized ? 1 : 0,
        skippedBytes: skippedBytes + (oversized ? bytesRead : 0),
        eof: oversized && start + bytesRead >= stat.size,
      };
    }
    // Never consume a suffix without a newline: writers may be midway through
    // the append, and advancing would permanently lose the completed record.
    const to = lastBreak + 1;
    const lines: ParsedLine[] = [];
    let malformed = 0;
    let lineStart = from;
    for (let index = from; index < to; index++) {
      if (data[index] !== 10) continue;
      const raw = data.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
      const endOffset = start + index + 1;
      lineStart = index + 1;
      if (!raw.trim()) {
        lines.push({ raw, row: undefined, endOffset });
        continue;
      }
      try {
        lines.push({ raw, row: JSON.parse(raw) as unknown, endOffset });
      } catch {
        malformed++;
        lines.push({ raw, row: undefined, endOffset });
      }
    }
    return {
      lines,
      cursor: { ...prior, offset: start + to },
      bytesRead,
      malformed,
      skippedBytes,
      eof: start + to >= stat.size,
    };
  } finally {
    await handle.close();
  }
}

function parseInputLine(
  input: InputFile,
  line: ParsedLine,
  cursor: FileCursor,
  health: ReliabilityTriageHealth,
): Observation[] {
  if (input.source === "friction") {
    return parseFriction(input, line, health);
  }
  if (input.source === "crash") {
    return parseCrash(input, line, health);
  }
  return parseSessionEvent(input, line, cursor, health);
}

function parseFriction(
  input: InputFile,
  line: ParsedLine,
  health: ReliabilityTriageHealth,
): Observation[] {
  const row = recordOf(line.row);
  if (!row) return [];
  health.frictionTurns++;
  const status = stringOf(row.status);
  if (status === "failed") health.failedTurns++;
  if (status === "interrupted") health.interruptedTurns++;
  health.stalls += numberOf(row.stalls);
  health.reasoningStalls += numberOf(row.reasoningStalls);
  health.verifierReminders += numberOf(row.verifyReminders);
  const tools = recordOf(row.tools);
  if (tools) {
    for (const value of Object.values(tools)) {
      const counts = recordOf(value);
      health.toolCalls += numberOf(counts?.calls);
      health.toolErrors += numberOf(counts?.errors);
    }
  }

  const diagnostics = Array.isArray(row.diagnostics) ? row.diagnostics.slice(0, 64) : [];
  const observations: Observation[] = [];
  for (const item of diagnostics) {
    const diagnostic = recordOf(item);
    if (!diagnostic) continue;
    const kind = stringOf(diagnostic.kind);
    if (kind === "verification") continue;
    const sample = stringOf(diagnostic.sample) || stringOf(diagnostic.code) || "failure";
    const tool = stringOf(diagnostic.tool) || undefined;
    const code = stringOf(diagnostic.code) || undefined;
    // Recompute through the shared normalizer so the safe envelope and its raw
    // rollout collapse to the same occurrence despite using different source
    // schemas. The envelope's own signature remains useful to other readers.
    const signature = failureDigest(
      kind === "subagent_error" ? "subagent" : (tool ?? code ?? kind),
      sample,
    );
    const sessionId = stringOf(row.sessionId) || undefined;
    const turnId = stringOf(row.turnId) || undefined;
    const sourceKind: ReliabilitySignalKind =
      kind === "tool_error" ? "tool_error" :
      kind === "subagent_error" ? "failed_subagent" :
      kind === "failed_turn" ? "failed_turn" :
      "engine_error";
    observations.push(
      makeObservation({
        source: "friction",
        sourceFile: input.file,
        sourceKind,
        at: validIso(stringOf(row.at)),
        summary: sample,
        signature,
        sessionId,
        turnId,
        tool,
        code,
        projectHash: stringOf(row.workspaceHash) || stringOf(row.projectHash) || undefined,
      }),
    );
  }
  if (status === "failed" && observations.length === 0) {
    const sample = "turn ended with failed status and no typed diagnostic";
    observations.push(
      makeObservation({
        source: "friction",
        sourceFile: input.file,
        sourceKind: "failed_turn",
        at: validIso(stringOf(row.at)),
        summary: sample,
        signature: failureDigest("failed_turn", sample),
        sessionId: stringOf(row.sessionId) || undefined,
        turnId: stringOf(row.turnId) || undefined,
        code: "failed_status",
        projectHash: stringOf(row.workspaceHash) || stringOf(row.projectHash) || undefined,
      }),
    );
  }
  return observations;
}

function parseCrash(
  input: InputFile,
  line: ParsedLine,
  health: ReliabilityTriageHealth,
): Observation[] {
  const row = recordOf(line.row);
  if (!row) return [];
  health.crashRecords++;
  const processName = stringOf(row.process) || "process";
  const crashKind = stringOf(row.kind) || "crash";
  const summary = stringOf(row.message) || "process terminated without a message";
  return [
    makeObservation({
      source: "crash",
      sourceFile: input.file,
      sourceKind: "crash",
      at: validIso(stringOf(row.at)),
      summary,
      signature: failureDigest(processName + ":" + crashKind, summary),
      seq: line.endOffset,
      code: crashKind,
      tool: processName,
    }),
  ];
}

function parseSessionEvent(
  input: InputFile,
  line: ParsedLine,
  cursor: FileCursor,
  health: ReliabilityTriageHealth,
): Observation[] {
  const wrapper = recordOf(line.row);
  const event = recordOf(wrapper?.event ?? line.row);
  if (!event) return [];
  health.sessionEvents++;
  const type = stringOf(event.type);
  const at = validIso(stringOf(wrapper?.ts));
  const seq = finiteNumber(wrapper?.seq);
  if (type === "turn_start") {
    cursor.sessionId = stringOf(event.sessionId) || input.sessionId;
    cursor.turnId = stringOf(event.turnId) || undefined;
    cursor.turnHadDiagnostic = false;
    return [];
  }
  if (type === "tool_use_start" || type === "tool_start") {
    const id = stringOf(event.id);
    const name = stringOf(event.name);
    if (id && name) {
      const names = cursor.toolNames ?? {};
      names[id] = name;
      cursor.toolNames = trimRecord(names, 256);
    }
    return [];
  }
  if (type === "tool_end") {
    const id = stringOf(event.id);
    if (id && cursor.toolNames) delete cursor.toolNames[id];
    return [];
  }
  if (type === "tool_error") {
    cursor.turnHadDiagnostic = true;
    const id = stringOf(event.id);
    const tool = (id && cursor.toolNames?.[id]) || "unknown";
    if (id && cursor.toolNames) delete cursor.toolNames[id];
    const summary = stringOf(event.error) || "tool failed without a diagnostic";
    health.toolErrors++;
    return [
      makeObservation({
        source: input.source,
        sourceFile: input.file,
        sourceKind: "tool_error",
        at,
        summary,
        signature: failureDigest(tool, summary),
        sessionId: cursor.sessionId ?? input.sessionId,
        turnId: cursor.turnId,
        seq,
        tool,
        workspace: input.workspace,
        projectHash: input.projectHash,
      }),
    ];
  }
  if (type === "error") {
    cursor.turnHadDiagnostic = true;
    const error = recordOf(event.error);
    const code = stringOf(error?.code) || "unknown";
    const summary = stringOf(error?.message) || "engine failed without a diagnostic";
    return [
      makeObservation({
        source: input.source,
        sourceFile: input.file,
        sourceKind: "engine_error",
        at,
        summary,
        signature: failureDigest(code, summary),
        sessionId: cursor.sessionId ?? input.sessionId,
        turnId: cursor.turnId,
        seq,
        code,
        workspace: input.workspace,
        projectHash: input.projectHash,
      }),
    ];
  }
  if (type === "subagent_end" && stringOf(event.status) === "failed") {
    cursor.turnHadDiagnostic = true;
    const summary = stringOf(event.summary) || "subagent failed without a diagnostic";
    return [
      makeObservation({
        source: input.source,
        sourceFile: input.file,
        sourceKind: "failed_subagent",
        at,
        summary,
        signature: failureDigest("subagent", summary),
        sessionId: cursor.sessionId ?? input.sessionId,
        turnId: cursor.turnId,
        seq,
        workspace: input.workspace,
        projectHash: input.projectHash,
      }),
    ];
  }
  if (type === "turn_end") {
    const status = stringOf(event.status);
    if (status === "failed") health.failedTurns++;
    if (status === "interrupted") health.interruptedTurns++;
    if (status === "failed" && !cursor.turnHadDiagnostic) {
      return [
        makeObservation({
          source: input.source,
          sourceFile: input.file,
          sourceKind: "failed_turn",
          at,
          summary: "turn ended failed without a preceding typed diagnostic",
          signature: failureDigest(
            "failed_turn",
            stringOf(event.provider) + ":" + stringOf(event.model),
          ),
          sessionId: cursor.sessionId ?? input.sessionId,
          turnId: cursor.turnId,
          seq,
          code: stringOf(event.provider) || undefined,
          workspace: input.workspace,
          projectHash: input.projectHash,
        }),
      ];
    }
  }
  return [];
}

function makeObservation(input: {
  source: ReliabilityEvidence["source"];
  sourceFile: string;
  sourceKind: ReliabilitySignalKind;
  at: string;
  summary: string;
  signature: string;
  sessionId?: string;
  turnId?: string;
  seq?: number;
  tool?: string;
  code?: string;
  workspace?: string;
  projectHash?: string;
}): Observation {
  const safe = redactDiagnostic(input.summary, input.workspace);
  const safeTool = sanitizeDiagnosticLabel(input.tool, 80);
  const safeCode = sanitizeDiagnosticLabel(input.code, 80);
  const safeSessionId = opaqueDiagnosticId(input.sessionId, "session");
  const safeTurnId = opaqueDiagnosticId(input.turnId, "turn");
  const scope = input.sourceKind === "failed_subagent"
    ? "subagent"
    : (safeTool ?? safeCode ?? input.sourceKind);
  // Hash only the redacted form: rotating credentials must not fragment one
  // cluster or leak dictionary-correlation through a durable digest.
  const signature = failureDigest(scope, safe);
  const policy = classify(input.sourceKind, safeTool, safeCode, safe);
  const fingerprint = [
    input.sourceKind,
    safeTool ?? "",
    safeCode ?? "",
    signature,
  ].join("|").toLowerCase();
  const findingId = "rel_" + sha(fingerprint).slice(0, 16);
  const correlation = safeSessionId && safeTurnId
    ? safeSessionId + ":" + safeTurnId + ":" + signature
    : input.sourceFile + ":" + String(input.seq ?? "") + ":" + signature;
  const sourceRef = "src_" + sha(fileKey(input.sourceFile)).slice(0, 16);
  return {
    key: sha(correlation),
    fingerprint,
    findingId,
    kind: input.sourceKind,
    title: titleFor(input.sourceKind, safeTool, safeCode, safe),
    at: input.at,
    policy,
    evidence: {
      source: input.source,
      at: input.at,
      summary: safe,
      sourceRef,
      sessionId: safeSessionId,
      turnId: safeTurnId,
      seq: input.seq,
      tool: safeTool,
      code: safeCode,
    },
    sourceFile: input.sourceFile,
    projectHash: /^[a-f0-9]{16,64}$/i.test(input.projectHash ?? "")
      ? input.projectHash
      : undefined,
  };
}

function classify(
  kind: ReliabilitySignalKind,
  tool: string | undefined,
  code: string | undefined,
  summary: string,
): ObservationPolicy {
  const signal = ((code ?? "") + " " + summary).toLowerCase();
  if (kind === "crash") {
    return {
      category: "product",
      severity: "critical",
      confidence: "high",
      minOccurrences: 1,
      minSessions: 0,
      suggestedAction: "Reproduce from the crash record and recent-event tail; fix in an isolated worktree, then run the full verification gate.",
    };
  }
  if (
    /(?:^|\D)(?:401|403)(?:\D|$)|\bauth(?:entication|orization)?\b|\bapi.?key\b|\bcredential|\bnot signed in\b|\blogin required\b|\bunauthori[sz]ed\b/.test(signal)
  ) {
    return {
      category: "environment",
      severity: "low",
      confidence: "high",
      minOccurrences: Number.MAX_SAFE_INTEGER,
      minSessions: Number.MAX_SAFE_INTEGER,
      suggestedAction: "Repair account or credential configuration; do not open a product-code repair from this signal alone.",
    };
  }
  if (
    /\b(?:eperm|eacces|ebusy|enoent|permission denied|resource busy|locked)\b/.test(signal)
  ) {
    return {
      category: "environment",
      severity: "low",
      confidence: "medium",
      minOccurrences: Number.MAX_SAFE_INTEGER,
      minSessions: Number.MAX_SAFE_INTEGER,
      suggestedAction: "Confirm filesystem permissions, locks, and path existence before treating this as an Ares defect.",
    };
  }
  if (
    kind === "engine_error" &&
    /\b(?:429|rate.?limit|model not found|not_found_error|econnreset|enotfound|dns failure)\b/.test(signal)
  ) {
    return {
      category: "environment",
      severity: "low",
      confidence: "medium",
      minOccurrences: Number.MAX_SAFE_INTEGER,
      minSessions: Number.MAX_SAFE_INTEGER,
      suggestedAction: "Check provider availability, model configuration, and network health before opening a product repair.",
    };
  }
  if (
    kind === "tool_error" &&
    /\bno extension browser tab attached\b/.test(signal)
  ) {
    return {
      category: "environment",
      severity: "low",
      confidence: "high",
      minOccurrences: Number.MAX_SAFE_INTEGER,
      minSessions: Number.MAX_SAFE_INTEGER,
      suggestedAction: "Attach or pair an extension tab; open a product repair only if the bridge reports a transport failure after pairing.",
    };
  }
  if (
    kind === "tool_error" &&
    /\b(?:locator|selector|element not found|click_text|fill_selector|no controllable open tab matched|cannot activate browser windows)\b/.test(signal) &&
    !/\b(?:bridge|connector|host|socket|watchdog)\b/.test(signal)
  ) {
    return {
      category: "task",
      severity: "low",
      confidence: "high",
      minOccurrences: Number.MAX_SAFE_INTEGER,
      minSessions: Number.MAX_SAFE_INTEGER,
      suggestedAction: "Treat as page/task state unless the browser transport itself reports a liveness failure.",
    };
  }
  if (
    kind === "tool_error" &&
    /\b(?:must be|required|requires|invalid input|non-empty|old_string|not found|malformed|usage:)\b/.test(signal) &&
    !/\b(?:bridge|connector|host|socket|watchdog)\b/.test(signal)
  ) {
    return {
      category: "task",
      severity: "low",
      confidence: "medium",
      minOccurrences: Number.MAX_SAFE_INTEGER,
      minSessions: Number.MAX_SAFE_INTEGER,
      suggestedAction: "Treat as task-level tool feedback unless a separate infrastructure signal recurs across sessions.",
    };
  }
  if (
    /\b(?:watchdog|timed out|timeout|result unavailable|bridge|websocket|socket closed|disconnected|not paired|cdp)\b/.test(signal)
  ) {
    return {
      category: "product",
      severity: "high",
      confidence: "high",
      minOccurrences: 2,
      minSessions: 1,
      suggestedAction: "Build a deterministic repro around the affected transport/tool and add a liveness regression test before repair.",
    };
  }
  if (
    kind === "engine_error" &&
    /\b(?:stream_stall|reasoning_stall|provider_throw|no_message_done|max_turns_exceeded|loop_detected)\b/.test(signal)
  ) {
    return {
      category: "product",
      severity: "high",
      confidence: "high",
      minOccurrences: 1,
      minSessions: 1,
      suggestedAction: "Reproduce the engine lifecycle failure from the rollout and pin it with a focused stream/turn regression test.",
    };
  }
  if (
    kind === "engine_error" &&
    /tool_use.+without.+tool_result|invalid.+signature.+thinking block/.test(signal)
  ) {
    return {
      category: "product",
      severity: "high",
      confidence: "high",
      minOccurrences: 1,
      minSessions: 1,
      suggestedAction: "Reproduce the provider-history invariant, repair pairing/signature sanitation, and add a cross-provider replay regression test.",
    };
  }
  if (kind === "failed_turn") {
    return {
      category: "product",
      severity: "medium",
      confidence: "low",
      minOccurrences: 2,
      minSessions: 2,
      suggestedAction: "Instrument the missing error boundary first; a failed turn without a typed diagnostic is itself the defect.",
    };
  }
  return {
    category: "product",
    severity: "medium",
    confidence: "low",
    minOccurrences: 3,
    minSessions: 2,
    suggestedAction: "Confirm recurrence across independent sessions and derive a minimal deterministic repro before repair.",
  };
}

function titleFor(
  kind: ReliabilitySignalKind,
  tool: string | undefined,
  code: string | undefined,
  summary: string,
): string {
  if (kind === "crash") return (tool ?? "Ares") + " " + (code ?? "process") + " crash";
  if (kind === "failed_turn") return "Turns fail without a typed diagnostic";
  if (kind === "failed_subagent") return "Subagents fail with the same signature";
  if (/tool_use.+without.+tool_result/i.test(summary)) return "Provider history contains orphaned tool calls";
  if (/invalid.+signature.+thinking block/i.test(summary)) return "Provider rejects stale thinking signatures";
  if (kind === "engine_error") return "Engine " + (code ?? "unknown") + " failures";
  if (/watchdog|timed out|timeout/i.test(summary)) {
    return (tool ?? "Unknown tool") + " watchdog failures";
  }
  if (/bridge|websocket|not paired|cdp/i.test(summary)) {
    return (tool ?? "Browser") + " bridge failures";
  }
  return (tool ?? "Unknown tool") + " repeated tool failures";
}

function mergeFinding(
  existing: ReliabilityFinding | undefined,
  observations: Observation[],
  now: Date,
): { finding: ReliabilityFinding; opened: boolean; reopened: boolean } {
  const first = observations[0];
  const keys = new Set(existing?.observationKeys ?? []);
  const sessions = new Set(existing?.sessionIds ?? []);
  const sessionHashes = new Set(
    existing?.sessionHashes ?? (existing?.sessionIds ?? []).map((id) => sha(id)),
  );
  let occurrences = existing?.occurrences ?? 0;
  let firstSeenAt = existing?.firstSeenAt ?? first.at;
  let lastSeenAt = existing?.lastSeenAt ?? first.at;
  let projectHash = existing?.projectHash;
  const evidence = [...(existing?.evidence ?? [])];
  let newestNewAt = "";
  for (const observation of observations) {
    if (keys.has(observation.key)) continue;
    keys.add(observation.key);
    occurrences++;
    if (observation.evidence.sessionId) {
      sessions.add(observation.evidence.sessionId);
      sessionHashes.add(sha(observation.evidence.sessionId));
    }
    if (observation.at < firstSeenAt) firstSeenAt = observation.at;
    if (observation.at > lastSeenAt) lastSeenAt = observation.at;
    if (observation.at > newestNewAt) newestNewAt = observation.at;
    projectHash ??= observation.projectHash;
    evidence.push(observation.evidence);
  }
  const distinctSessions = Math.max(existing?.distinctSessions ?? 0, sessionHashes.size);
  const eligible =
    first.policy.category === "product" &&
    occurrences >= first.policy.minOccurrences &&
    distinctSessions >= first.policy.minSessions;
  let status: ReliabilityFindingStatus =
    existing?.status ??
    (first.policy.category === "product" ? "watching" :
      first.policy.category === "task" ? "dismissed" : "watching");
  let opened = false;
  let reopened = false;
  let recurrenceCount = existing?.recurrenceCount ?? 0;
  if (eligible && status === "watching") {
    status = "candidate";
    opened = true;
  } else if (
    eligible &&
    (status === "resolved" || status === "dismissed") &&
    newestNewAt > (status === "resolved" ? (existing?.resolvedAt ?? "") : (existing?.dismissedAt ?? "")) &&
    (status === "resolved" || distinctSessions > (existing?.distinctSessions ?? 0))
  ) {
    status = "candidate";
    reopened = true;
    recurrenceCount++;
  }
  const at = now.toISOString();
  const finding: ReliabilityFinding = {
    schemaVersion: 1,
    id: first.findingId,
    fingerprint: first.fingerprint,
    kind: first.kind,
    title: first.title,
    category: first.policy.category,
    severity: first.policy.severity,
    confidence: first.policy.confidence,
    status,
    occurrences,
    distinctSessions,
    firstSeenAt,
    lastSeenAt,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    sessionIds: [...sessions].slice(-64),
    sessionHashes: [...sessionHashes].slice(-4_096),
    observationKeys: [...keys].slice(-MAX_OBSERVATION_KEYS),
    evidence: evidence
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-MAX_EVIDENCE),
    suggestedAction: first.policy.suggestedAction,
    projectHash,
    openedAt: opened || reopened ? at : existing?.openedAt,
    acknowledgedAt: existing?.acknowledgedAt,
    dismissedAt: reopened && existing?.status === "dismissed" ? undefined : existing?.dismissedAt,
    resolvedAt: reopened ? undefined : existing?.resolvedAt,
    statusNote: reopened ? undefined : existing?.statusNote,
    recurrenceCount: recurrenceCount || undefined,
  };
  return { finding, opened, reopened };
}

function redactDiagnostic(value: string, workspace?: string): string {
  const home = escapeRegExp(os.homedir().replace(/\\/g, "/"));
  let text = redactSecrets(String(value ?? ""));
  if (workspace) {
    for (const form of [path.resolve(workspace), path.resolve(workspace).replace(/\\/g, "/")]) {
      text = text.replace(new RegExp(escapeRegExp(form), "gi"), "<workspace>");
    }
  }
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(new RegExp(home, "gi"), "<home>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "<home>")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g, "<path>")
    .replace(/\/(?:[^/\s]+\/){2,}[^/\s]*/g, "<path>")
    .replace(/\b(?:req|toolu|call|turn|sess)_[A-Za-z0-9_-]{12,}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function loadState(file: string): Promise<ReliabilityTriageState> {
  const parsed = await readJson<ReliabilityTriageState>(file);
  if (parsed?.schemaVersion === 1 && parsed.cursors && Array.isArray(parsed.seen)) {
    return { ...parsed, sources: parsed.sources ?? {} };
  }
  return { schemaVersion: 1, cursors: {}, seen: [], sources: {} };
}

async function loadFindingMap(dir: string): Promise<Map<string, ReliabilityFinding>> {
  const map = new Map<string, ReliabilityFinding>();
  const names = new Set(
    (await safeFiles(dir))
      .map((name) => name.endsWith(".json.bak") ? name.slice(0, -4) : name)
      .filter((name) => /^rel_[a-f0-9]{16}\.json$/.test(name)),
  );
  for (const name of names) {
    const finding = await readJson<ReliabilityFinding>(path.join(dir, name));
    if (finding?.schemaVersion === 1 && finding.id) map.set(finding.id, finding);
  }
  return map;
}

async function writeRun(dir: string, run: ReliabilityTriageRun): Promise<void> {
  const stamp = run.at.replace(/[:.]/g, "-");
  const persisted = { ...run, home: "<ares-home>", workspace: "<workspace>" };
  await writeJsonAtomic(path.join(dir, "run-" + stamp + ".json"), persisted);
  const names = (await safeFiles(dir))
    .filter((name) => /^run-.*\.json$/.test(name))
    .sort()
    .reverse();
  await Promise.all(
    names.slice(MAX_RUN_FILES).map((name) =>
      fs.rm(path.join(dir, name), { force: true }).catch(() => undefined)
    ),
  );
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await fs.rename(temp, file);
      await fs.rm(file + ".bak", { force: true }).catch(() => undefined);
      return;
    } catch {
      // Windows does not reliably replace an existing rename destination.
    }
    const backup = file + ".bak";
    const liveValid = await readJsonFile<unknown>(file) !== null;
    let backedUp = await fs.stat(backup).then(() => true).catch(() => false);
    if (liveValid) {
      await fs.rm(backup, { force: true }).catch(() => undefined);
      backedUp = false;
      try {
        await fs.rename(file, backup);
        backedUp = true;
      } catch { /* another writer moved it */ }
    } else {
      // Never replace a valid backup with a torn live generation.
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
    try {
      await fs.rename(temp, file);
    } catch (error) {
      if (backedUp) await fs.rename(backup, file).catch(() => undefined);
      throw error;
    }
    if (backedUp) await fs.rm(backup, { force: true }).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function acquireLock(
  file: string,
  _now: Date,
): Promise<(() => Promise<void>) | null> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return async () => {
        const lock = await readJson<{ token?: string }>(file);
        if (lock?.token === token) await fs.rm(file, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = await readJson<{ token?: string; pid?: number }>(file);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;
      if (observed?.pid && processIsAlive(observed.pid)) return null;

      // Quarantine the exact stale generation before retrying. Re-read its
      // token after the atomic rename so a contender cannot trick us into
      // deleting a freshly-created lease that reused the same path.
      const quarantine = file + ".stale." + randomUUID();
      try {
        await fs.rename(file, quarantine);
      } catch {
        return null;
      }
      const moved = await readJson<{ token?: string }>(quarantine);
      if (moved?.token !== observed?.token) {
        const current = await fs.stat(file).catch(() => null);
        if (!current) await fs.rename(quarantine, file).catch(() => undefined);
        return null;
      }
      await fs.rm(quarantine, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  const primary = await readJsonFile<T>(file);
  if (primary !== null) return primary;
  const backup = await readJsonFile<T>(file + ".bak");
  if (backup === null) return null;

  // A Windows crash can land after live -> .bak but before temp -> live.
  // Reading the backup in place avoids clobbering a concurrent fresh writer;
  // the next locked write promotes a new live generation and cleans it up.
  return backup;
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function safeDirectories(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

async function safeFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

function defaultDesktopWorkspaces(): string[] {
  if (process.platform !== "win32") return [];
  return [path.join(os.homedir(), "Desktop", "Ares Workspace")];
}

function defaultAresHomes(): string[] {
  const homes = [path.join(os.homedir(), ".ares")];
  if (process.platform === "win32" && process.env.APPDATA) {
    homes.push(path.join(process.env.APPDATA, "Ares", "home"));
  }
  return homes;
}

function configuredTriageWorkspaces(): string[] {
  const configured = process.env.ARES_TRIAGE_WORKSPACES?.trim();
  if (!configured) return [];
  return configured.split(path.delimiter).map((value) => value.trim()).filter(Boolean);
}

function uniquePaths(values: string[]): string[] {
  const result = new Map<string, string>();
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    result.set(fileKey(resolved), resolved);
  }
  return [...result.values()];
}

function fileKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function cloneCursor(cursor: FileCursor): FileCursor {
  return {
    ...cursor,
    ...(cursor.toolNames ? { toolNames: { ...cursor.toolNames } } : {}),
  };
}

function hashPath(value: string): string {
  return sha(fileKey(value)).slice(0, 16);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizeDiagnosticLabel(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const redacted = redactSecrets(value).trim();
  if (/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(redacted) && redacted.length <= max) {
    return redacted;
  }
  return redacted ? "label_" + sha(redacted).slice(0, 16) : undefined;
}

function opaqueDiagnosticId(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined;
  return prefix + "_" + sha(value).slice(0, 16);
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validIso(value: string): string {
  return Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : new Date(0).toISOString();
}

function trimRecord(value: Record<string, string>, max: number): Record<string, string> {
  const entries = Object.entries(value);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - max)));
}

function severityRank(value: ReliabilitySeverity): number {
  return value === "critical" ? 0 : value === "high" ? 1 : value === "medium" ? 2 : 3;
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function positiveCappedNumber(value: number | undefined, cap: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return cap;
  return Math.min(cap, Math.max(1, Math.floor(value)));
}

function errorText(value: unknown): string {
  return redactDiagnostic(value instanceof Error ? value.message : String(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}
