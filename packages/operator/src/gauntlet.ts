// The coding gauntlet (ARES C6) — the referee that refuses to care about
// your feelings.
//
// Every task is a real miniature repo materialized into a fresh temp
// workspace. The candidate (any provider/model) gets one engine session and
// the tools the composition root hands it. Scoring is reality probes ONLY:
// tests pass, commands print the right thing, files exist with the right
// bones. No LLM judges, no partial credit for confident prose.
//
// "Ares makes any model code better" stops being a claim and becomes a
// number: run the gauntlet with the harness features on and off, same model,
// and read the difference. Every C-phase change must move this number.

import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Session, ContinuousVerifier, CodingJournal, repositoryMapReminder, type EngineTool, type Provider } from "@ares/core";
import { runProbe, type ProbeResult } from "./probe.js";
import type { VerificationSpec } from "./types.js";

export const GAUNTLET_SCHEMA_VERSION = 2;

export interface GauntletTask {
  id: string;
  title: string;
  /** The user prompt the candidate receives. */
  prompt: string;
  /** Workspace setup: relative path → file content. */
  files: Record<string, string>;
  /** Reality probes scored against the workspace after the run. */
  probes: VerificationSpec[];
  /** Engine iteration cap for this task (default 16). */
  maxTurns?: number;
  /** Files whose byte content must remain identical to the fixture. */
  protectedFiles?: string[];
  /** When true, any failed probe gates the task score to zero. */
  allProbesRequired?: boolean;
}

export interface GauntletProbeOutcome {
  met: boolean;
  summary: string;
}

export interface GauntletUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  modelCalls: number;
}

export interface GauntletTaskResult {
  id: string;
  title: string;
  /** met probes / total probes, 0..1. */
  score: number;
  probes: GauntletProbeOutcome[];
  toolCalls: number;
  durationMs: number;
  changedFiles: string[];
  integrityPassed: boolean;
  verificationToolCalls: number;
  usage: GauntletUsage;
  workStatus?: "verified" | "unverified" | "blocked" | "not_applicable";
  claimedComplete: boolean;
  error?: string;
}

export interface GauntletReport {
  schemaVersion: number;
  suite: string;
  harness: boolean;
  /** Process isolation cannot guarantee hidden tests or network denial. */
  official: false;
  isolation: "process";
  /** False when cancellation/infra stopped before every task was scored. */
  complete: boolean;
  taskManifestHash: string;
  systemPromptHash: string;
  startupReminderHash: string;
  toolSchemaHash: string;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    aresVersion: string;
    verifier: Record<string, string>;
  };
  harnessManifest: Record<string, unknown>;
  toolNames: string[];
  features: {
    session: true;
    repositoryMap: boolean;
    codingJournal: true;
    continuousVerifier: boolean;
    proofGate: boolean;
  };
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  usage: GauntletUsage;
  /** Mean task score, 0..1 — THE number. */
  total: number;
  metrics: {
    integrityRate: number;
    verifiedTaskRate: number;
    falseGreenRate: number;
    verifiedMismatchRate: number;
    tokensPerScorePoint: number;
  };
  tasks: GauntletTaskResult[];
}

export interface GauntletOptions {
  provider: Provider;
  model: string;
  /** Tool composition per workspace — the harness under test. */
  tools: (workspace: string) =>
    | readonly EngineTool[]
    | { tools: readonly EngineTool[]; dispose?: () => void | Promise<void> }
    | Promise<readonly EngineTool[] | { tools: readonly EngineTool[]; dispose?: () => void | Promise<void> }>;
  tasks?: readonly GauntletTask[];
  suite?: string;
  workspaceRoot?: string;
  signal?: AbortSignal;
  now?: () => Date;
  /** Keep task workspaces on disk for post-mortems. */
  keepWorkspaces?: boolean;
  /** Probe seam for tests. */
  probe?: (spec: VerificationSpec, ctx: { workspace: string; signal?: AbortSignal }) => Promise<ProbeResult>;
  systemPrompt?: string | ((workspace: string, task: GauntletTask) => string | Promise<string>);
  /** Caller-supplied source/provider/runtime identity for reproducible trends. */
  harnessManifest?: Record<string, unknown>;
  /** Run with the verification harness (ContinuousVerifier end-gate) ON. This is
   *  the single biggest coding-quality feature — the model can't finish a turn
   *  while its own edits leave the workspace red. Default ON; set false for the
   *  A/B baseline that proves the harness moves the number. */
  harness?: boolean;
}

const GAUNTLET_SYSTEM = `You are Ares running a scored coding evaluation. The workspace contains one task. Work it to completion with your tools: read what exists, make the change, and VERIFY it yourself (run the tests or the command) before finishing. Reality is scored after you stop — unverified claims earn nothing.`;

function emptyGauntletUsage(): GauntletUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, modelCalls: 0 };
}

function addGauntletUsage(current: GauntletUsage, next?: Partial<GauntletUsage>): GauntletUsage {
  return {
    inputTokens: current.inputTokens + (next?.inputTokens ?? 0),
    outputTokens: current.outputTokens + (next?.outputTokens ?? 0),
    cacheReadTokens: current.cacheReadTokens + (next?.cacheReadTokens ?? 0),
    cacheWriteTokens: current.cacheWriteTokens + (next?.cacheWriteTokens ?? 0),
    reasoningTokens: current.reasoningTokens + (next?.reasoningTokens ?? 0),
    modelCalls: current.modelCalls + (next?.modelCalls ?? 0),
  };
}

function usageFromToolOutput(output: unknown): Partial<GauntletUsage> | undefined {
  if (!output || typeof output !== "object") return undefined;
  const usage = (output as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? usage as Partial<GauntletUsage> : undefined;
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, normalize(child)]));
  };
  return JSON.stringify(normalize(value));
}

function normalizePromptForHash(prompt: string, workspace: string): string {
  const variants = [...new Set([workspace, workspace.replace(/\\/g, "/")])].sort((a, b) => b.length - a.length);
  return variants.reduce((text, value) => value ? text.split(value).join("<WORKSPACE>") : text, prompt);
}

function hasCompletionClaim(text: string): boolean {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .some((sentence) =>
      /\b(?:done|fixed|complete|completed|implemented|passes|passing|verified)\b/i.test(sentence) &&
      !/\b(?:not|isn't|wasn't|aren't|unable|couldn't|cannot|can't|unverified|incomplete|blocked|failed|failing)\b/i.test(sentence));
}

function isToolHarness(
  value: readonly EngineTool[] | { tools: readonly EngineTool[]; dispose?: () => void | Promise<void> },
): value is { tools: readonly EngineTool[]; dispose?: () => void | Promise<void> } {
  return !Array.isArray(value) && "tools" in value;
}

export async function runGauntlet(opts: GauntletOptions): Promise<GauntletReport> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const tasks = opts.tasks ?? CODING_GAUNTLET;
  const probe = opts.probe ?? ((spec, ctx) => runProbe(spec, ctx));
  const root = opts.workspaceRoot ?? tmpdir();
  const results: GauntletTaskResult[] = [];
  const observedToolNames = new Set<string>();
  const observedToolSchemas = new Map<string, unknown>();
  const usedSystemPrompts: string[] = [];
  const usedStartupReminders: string[] = [];

  for (const task of tasks) {
    if (opts.signal?.aborted) break;
    const t0 = Date.now();
    let workspace: string | null = null;
    let toolCalls = 0;
    let verificationToolCalls = 0;
    let finalWorkStatus: GauntletTaskResult["workStatus"];
    let assistantText = "";
    let usage = emptyGauntletUsage();
    const activeToolNames = new Map<string, string>();
    let baseline = new Map<string, string>();
    let error: string | undefined;
    let disposeTaskTools: (() => void | Promise<void>) | undefined;
    try {
      workspace = await mkdtemp(path.join(root, `gauntlet-${task.id}-`));
      for (const [rel, content] of Object.entries(task.files)) {
        const target = fixturePath(workspace, rel);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
      for (const protectedFile of task.protectedFiles ?? []) fixturePath(workspace, protectedFile);
      baseline = await snapshotFixture(workspace);

      // The verification harness under test: when on, edits schedule a narrow
      // verify, and the end-gate refuses to let the turn finish while the
      // workspace is red — the exact feature this gauntlet exists to measure.
      const harnessOn = opts.harness !== false;
      const sessionId = `gauntlet_${task.id}`;
      const journal = await CodingJournal.open({ workspace, sessionId });
      const verifier = harnessOn ? new ContinuousVerifier({ workspace, onEvent: (event) => journal.recordVerifyEvent(event) }) : null;
      const startup = harnessOn
        ? [{ text: await repositoryMapReminder(workspace), source: "instructions" as const }]
        : [];
      const stateReminder = journal.beginTurn(task.prompt);
      if (stateReminder) startup.push({ text: stateReminder, source: "instructions" as const });
      usedStartupReminders.push(`${task.id}\0${startup.map((reminder) => normalizePromptForHash(reminder.text, workspace!)).join("\n\0")}`);
      const toolHarness = await opts.tools(workspace);
      const taskTools = isToolHarness(toolHarness) ? toolHarness.tools : toolHarness;
      disposeTaskTools = isToolHarness(toolHarness) ? toolHarness.dispose : undefined;
      for (const tool of taskTools) {
        observedToolNames.add(tool.schema.name);
        observedToolSchemas.set(tool.schema.name, tool.schema);
      }
      const taskSystemPrompt = typeof opts.systemPrompt === "function"
        ? await opts.systemPrompt(workspace, task)
        : opts.systemPrompt ?? GAUNTLET_SYSTEM;
      usedSystemPrompts.push(`${task.id}\0${normalizePromptForHash(taskSystemPrompt, workspace)}`);
      const session = new Session({
          provider: opts.provider,
          model: opts.model,
          systemPrompt: taskSystemPrompt,
          tools: taskTools,
          workspace,
          signal: opts.signal,
          sessionId,
          maxTurns: task.maxTurns ?? 16,
          ...(verifier
            ? {
                drainSystemReminders: () => [...startup.splice(0), ...verifier.drainReminders()],
                confirmTurnEnd: async () => {
                  await verifier.settle(60_000);
                  return verifier.drainReminders();
                },
                requireVerificationEvidence: true,
                verificationEvidence: () => verifier.evidenceSnapshot(),
              }
            : { drainSystemReminders: () => startup.splice(0) }),
        });
      session.observeEvents((event) => journal.recordTurnEvent(event));
      let finalStatus: "completed" | "interrupted" | "failed" = "completed";
      try {
        for await (const event of session.send(task.prompt)) {
          if (event.type === "tool_start") {
            toolCalls++;
            activeToolNames.set(event.id, event.name);
            if (isVerificationToolCall(event.name, event.input)) verificationToolCalls++;
          }
          if (event.type === "tool_end") {
            if (event.touchedFiles?.length) verifier?.scheduleFor(event.touchedFiles);
            const toolName = activeToolNames.get(event.id);
            if (toolName === "Task" || toolName === "Conductor") {
              usage = addGauntletUsage(usage, usageFromToolOutput(event.output));
            }
            activeToolNames.delete(event.id);
          }
          if (event.type === "error" && !error) error = event.error.message;
          if (event.type === "text_delta") assistantText += event.text;
          if (event.type === "turn_end") {
            finalStatus = event.status;
            finalWorkStatus = event.workStatus;
            usage = addGauntletUsage(usage, event.usage);
          }
        }
      } finally {
        try {
          await journal.finishTurn(finalStatus);
        } catch (journalError) {
          error ??= `coding journal persistence failed: ${journalError instanceof Error ? journalError.message : String(journalError)}`;
        }
        await verifier?.cancel();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // Quiesce candidate-owned background processes before freezing bytes for
    // grading. Otherwise a watcher can mutate protected files between the hash
    // and copy, or leak state into later tasks.
    if (disposeTaskTools) {
      try {
        await disposeTaskTools();
      } catch (disposeError) {
        error ??= `candidate tool teardown failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`;
      }
    }

    // Freeze the candidate BEFORE executing any grader code. Probes run against
    // a disposable copy of this scoring snapshot, so a stateful test cannot
    // rewrite protected files and restore them before the integrity comparison.
    let gradingWorkspace: string | null = null;
    let finalFixture = new Map<string, string>();
    if (workspace) {
      try {
        finalFixture = await snapshotFixture(workspace);
        gradingWorkspace = await mkdtemp(path.join(root, `gauntlet-grade-${task.id}-`));
        await copyScoredFixture(workspace, gradingWorkspace);
      } catch (err) {
        error ??= `could not freeze candidate: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const changedFiles = changedFixtureFiles(baseline, finalFixture);
    const protectedFiles = (task.protectedFiles ?? []).map(normalizeRel);
    const integrityPassed = workspace !== null && gradingWorkspace !== null && protectedFiles.every((file) =>
      baseline.has(file) && finalFixture.has(file) && baseline.get(file) === finalFixture.get(file));

    // Reality is scored even when the candidate run errored, but never execute
    // a candidate-modified protected test. Partial work still counts exactly as
    // much as the frozen fixture proves.
    const probeOutcomes: GauntletProbeOutcome[] = [];
    for (let probeIndex = 0; probeIndex < task.probes.length; probeIndex++) {
      const spec = task.probes[probeIndex];
      if (!integrityPassed) {
        probeOutcomes.push({ met: false, summary: "protected fixture integrity failed; probe not executed" });
        continue;
      }
      let probeWorkspace: string | null = null;
      try {
        if (gradingWorkspace) {
          probeWorkspace = await mkdtemp(path.join(root, `gauntlet-probe-${task.id}-${probeIndex}-`));
          await copyScoredFixture(gradingWorkspace, probeWorkspace);
        }
        const result = probeWorkspace
          ? await probe(spec, { workspace: probeWorkspace, signal: opts.signal })
          : { met: false, summary: "workspace never materialized" };
        const afterProbe = probeWorkspace ? await snapshotFixture(probeWorkspace) : new Map<string, string>();
        const probeIntegrity = protectedFiles.every((file) =>
          finalFixture.has(file) && afterProbe.has(file) && finalFixture.get(file) === afterProbe.get(file));
        probeOutcomes.push({
          met: result.met && probeIntegrity,
          summary: probeIntegrity ? result.summary : `${result.summary}; probe mutated a protected file`,
        });
      } catch (err) {
        probeOutcomes.push({ met: false, summary: `probe threw: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        if (probeWorkspace) await rm(probeWorkspace, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const met = probeOutcomes.filter((p) => p.met).length;
    const probeScore = task.probes.length > 0 ? met / task.probes.length : 0;
    const functionalScore = task.allProbesRequired && met !== task.probes.length ? 0 : probeScore;
    results.push({
      id: task.id,
      title: task.title,
      score: integrityPassed ? functionalScore : 0,
      probes: probeOutcomes,
      toolCalls,
      durationMs: Date.now() - t0,
      changedFiles,
      integrityPassed,
      verificationToolCalls,
      usage,
      claimedComplete: finalWorkStatus === "verified" || hasCompletionClaim(assistantText),
      ...(finalWorkStatus ? { workStatus: finalWorkStatus } : {}),
      ...(error ? { error } : {}),
    });

    if (workspace && !opts.keepWorkspaces) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
    if (gradingWorkspace) {
      await rm(gradingWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const finishedAt = now();
  const total = tasks.length > 0 ? results.reduce((sum, result) => sum + result.score, 0) / tasks.length : 0;
  const complete = results.length === tasks.length && !opts.signal?.aborted && results.every((result) => !result.error);
  const verifiedTasks = results.filter((result) => result.workStatus === "verified").length;
  const verifiedMismatches = results.filter((result) => result.workStatus === "verified" && result.score < 1).length;
  const completionClaims = results.filter((result) => result.claimedComplete).length;
  const falseGreens = results.filter((result) => result.claimedComplete && result.score < 1).length;
  const totalUsage = results.reduce((sum, result) => addGauntletUsage(sum, result.usage), emptyGauntletUsage());
  const earnedScorePoints = results.reduce((sum, result) => sum + result.score, 0);
  return {
    schemaVersion: GAUNTLET_SCHEMA_VERSION,
    suite: opts.suite ?? "coding-v1",
    harness: opts.harness !== false,
    official: false,
    isolation: "process",
    complete,
    taskManifestHash: createHash("sha256").update(canonicalJson(tasks)).digest("hex"),
    systemPromptHash: createHash("sha256").update(usedSystemPrompts.join("\n\0\n") || GAUNTLET_SYSTEM).digest("hex"),
    startupReminderHash: createHash("sha256").update(usedStartupReminders.join("\n\0\n")).digest("hex"),
    toolSchemaHash: createHash("sha256").update(canonicalJson([...observedToolSchemas.entries()].sort(([a], [b]) => a.localeCompare(b)))).digest("hex"),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      aresVersion: process.env.npm_package_version ?? "unknown",
      verifier: Object.fromEntries([
        "ARES_VERIFY_DEBOUNCE_MS",
        "ARES_VERIFY_COMMAND_TIMEOUT_MS",
        "ARES_VERIFY_CACHE_MAX",
        "ARES_CODING_PROOF_GATE",
      ].map((key) => [key, process.env[key] ?? "<default>"])),
    },
    harnessManifest: opts.harnessManifest ?? {},
    toolNames: [...observedToolNames].sort(),
    features: {
      session: true,
      repositoryMap: opts.harness !== false,
      codingJournal: true,
      continuousVerifier: opts.harness !== false,
      proofGate: opts.harness !== false,
    },
    provider: opts.provider.name,
    model: opts.model,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    usage: totalUsage,
    total,
    metrics: {
      integrityRate: tasks.length ? results.filter((result) => result.integrityPassed).length / tasks.length : 0,
      verifiedTaskRate: tasks.length ? verifiedTasks / tasks.length : 0,
      falseGreenRate: completionClaims ? falseGreens / completionClaims : 0,
      verifiedMismatchRate: verifiedTasks ? verifiedMismatches / verifiedTasks : 0,
      tokensPerScorePoint: earnedScorePoints > 0 ? (totalUsage.inputTokens + totalUsage.outputTokens) / earnedScorePoints : 0,
    },
    tasks: results,
  };
}

// ─── coding-v1: the seed suite ─────────────────────────────────────────────
//
// Small on purpose: each task is one canonical failure mode, runs in seconds,
// and is scored by running real code. Friend-challenge tasks get appended
// here as they're collected — beating THEIR benchmarks is the point.

const SNAPSHOT_IGNORED_DIRS = new Set([".ares", ".git", "node_modules", "dist", "coverage", "target"]);

function fixturePath(workspace: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`fixture path must be relative: ${JSON.stringify(relativePath)}`);
  }
  const target = path.resolve(workspace, relativePath);
  const rel = path.relative(path.resolve(workspace), target);
  if (!rel || rel === "." || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) {
    throw new Error(`fixture path escapes workspace: ${relativePath}`);
  }
  return target;
}

async function copyScoredFixture(source: string, destination: string): Promise<void> {
  const pending: Array<{ source: string; destination: string }> = [{ source, destination }];
  while (pending.length) {
    const current = pending.shift()!;
    const entries = await readdir(current.source, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const from = path.join(current.source, entry.name);
      const to = path.join(current.destination, entry.name);
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRS.has(entry.name)) continue;
        await mkdir(to, { recursive: true });
        pending.push({ source: from, destination: to });
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(from);
      if (info.size > 3_000_000) continue;
      await copyFile(from, to);
    }
  }
}

async function snapshotFixture(workspace: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const pending = [workspace];
  while (pending.length) {
    const dir = pending.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRS.has(entry.name)) continue;
        pending.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const absolute = path.join(dir, entry.name);
        const info = await stat(absolute).catch(() => null);
        if (!info || info.size > 3_000_000) continue;
        const content = await readFile(absolute).catch(() => null);
        if (!content) continue;
        snapshot.set(normalizeRel(path.relative(workspace, absolute)), createHash("sha256").update(content).digest("hex"));
      }
    }
  }
  return snapshot;
}

function changedFixtureFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

function normalizeRel(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isVerificationToolCall(name: string, input: unknown): boolean {
  if (name !== "Bash" && name !== "PowerShell") return false;
  const command = String(((input ?? {}) as Record<string, unknown>).command ?? "");
  return /(^|\s)(test|check|verify|lint|build|typecheck)(\s|$)|\b(vitest|jest|pytest|cargo\s+(?:test|check)|go\s+test|tsc|eslint|ruff|node\s+--test)\b/i.test(command);
}

export const CODING_GAUNTLET: GauntletTask[] = [
  {
    id: "fix-failing-test",
    title: "Fix the bug the test exposes (do not touch the test)",
    prompt:
      "The test in math.test.mjs is failing. Find the bug, fix it WITHOUT changing the test, and run the test to confirm it passes.",
    files: {
      "math.mjs": "export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n",
      "math.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add, mul } from "./math.mjs";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-1, 1), 0);\n});\n\ntest("mul", () => {\n  assert.equal(mul(3, 4), 12);\n});\n',
    },
    protectedFiles: ["math.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "math.test.mjs"], expectExit: 0, timeoutMs: 30_000 },
      { kind: "file", path: "math.test.mjs", contains: "add(2, 3), 5" },
    ],
  },
  {
    id: "implement-to-spec",
    title: "Implement a module to satisfy an existing test suite",
    prompt:
      "Implement slugify.mjs exporting `slugify(text)` so every test in slugify.test.mjs passes. Run the tests to confirm.",
    files: {
      "slugify.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "./slugify.mjs";\n\ntest("lowercases", () => assert.equal(slugify("Hello"), "hello"));\ntest("spaces to dashes", () => assert.equal(slugify("hello world"), "hello-world"));\ntest("strips punctuation", () => assert.equal(slugify("hello, world!"), "hello-world"));\ntest("collapses dashes", () => assert.equal(slugify("a  --  b"), "a-b"));\ntest("trims edge dashes", () => assert.equal(slugify("  hi  "), "hi"));\n',
    },
    protectedFiles: ["slugify.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "slugify.test.mjs"], expectExit: 0, timeoutMs: 30_000 },
      { kind: "file", path: "slugify.mjs", contains: "export" },
    ],
  },
  {
    id: "cross-file-bug",
    title: "Trace a bug across module boundaries",
    prompt:
      'Running `node app.mjs` prints "listening on undefined". Fix the codebase so it prints "listening on 8080". Run it to confirm.',
    files: {
      "config.mjs": "export const config = {\n  portt: 8080,\n  host: \"127.0.0.1\",\n};\n",
      "app.mjs": 'import { config } from "./config.mjs";\n\nconsole.log(`listening on ${config.port}`);\n',
    },
    probes: [
      { kind: "command", cmd: "node", args: ["app.mjs"], expectExit: 0, contains: "listening on 8080", timeoutMs: 15_000 },
    ],
  },
  {
    id: "holo-viewer",
    title: "The Holotable task — generate a hologram-style 3D viewer",
    prompt:
      "Create holo.html: a SELF-CONTAINED hologram-style 3D viewer using three.js from a CDN. Requirements: dark background; a procedurally-built mech/robot from primitive geometries (no external model files); bronze wireframe + additive-glow materials; an exploded-view range slider that smoothly moves the parts outward from the core along their assembly axes and back; orbit controls (drag to rotate, wheel to zoom); a small HUD label naming the focused part. One file, opens directly in a browser, no build step.",
    files: {
      "README.md": "# Holotable task\nDeliver holo.html per the prompt. It will be structurally scored.\n",
    },
    probes: [
      { kind: "file", path: "holo.html", contains: "three" },
      { kind: "file", path: "holo.html", contains: "exploded" },
      { kind: "file", path: "holo.html", contains: "input" },
      { kind: "file", path: "holo.html", contains: "wireframe" },
    ],
    maxTurns: 24,
  },
];

// coding-v2: multi-module tasks that require navigation, compatibility
// reasoning, test integrity, and post-edit proof. Fixtures are dependency-free
// Node repositories so the score measures coding rather than package installs.
export const CODING_GAUNTLET_V2: GauntletTask[] = [
  {
    id: "event-contract-migration",
    title: "Migrate an event contract across producer, storage, and consumers",
    prompt:
      "Completed jobs intermittently disappear from the dashboard after a protocol rollout. Establish one canonical completion event across the repo while remaining able to read legacy persisted events. Preserve unknown event variants, do not mutate input objects, do not edit tests, and run the full test suite.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "packages/protocol/events.mjs": `export const EVENT_TYPES = Object.freeze({ JOB_COMPLETED: "job.completed", JOB_FAILED: "job.failed" });
export function createCompleted(jobId, result) { return { type: "job_done", jobId, result }; }
export function normalizeEvent(event) { return event; }
`,
      "packages/worker/emitter.mjs": `import { createCompleted } from "../protocol/events.mjs";
export function emitCompletion(bus, jobId, result) { const event = createCompleted(jobId, result); bus.publish(event); return event; }
`,
      "packages/dashboard/reducer.mjs": `import { EVENT_TYPES, normalizeEvent } from "../protocol/events.mjs";
export function reduceDashboard(state, raw) { const event = normalizeEvent(raw); if (event.type !== EVENT_TYPES.JOB_COMPLETED) return state; return { ...state, completed: [...state.completed, event.jobId] }; }
`,
      "packages/dashboard/format.mjs": `export function formatJob(job) { return job.label ? job.label + " (" + job.id + ")" : job.id; }
`,
      "packages/storage/eventStore.mjs": `export function serializeEvent(event) { return JSON.stringify(event); }
export function deserializeEvent(line) { return JSON.parse(line); }
`,
      "packages/api/jobHandler.mjs": `import { emitCompletion } from "../worker/emitter.mjs";
export async function completeJob(bus, job) { return emitCompletion(bus, job.id, await job.run()); }
`,
      "packages/cli/renderEvent.mjs": `export function renderEvent(event) { return event.type + ":" + (event.jobId ?? "unknown"); }
`,
      "packages/telemetry/counts.mjs": `export function countByType(events) { return events.reduce((out, event) => ({ ...out, [event.type]: (out[event.type] ?? 0) + 1 }), {}); }
`,
      "packages/shared/assert.mjs": `export function invariant(value, message) { if (!value) throw new Error(message); }
`,
      "docs/events.md": "Canonical completion events use job.completed. Historical stores may contain job_done.\n",
      "tests/event-flow.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { emitCompletion } from "../packages/worker/emitter.mjs";
import { reduceDashboard } from "../packages/dashboard/reducer.mjs";
import { deserializeEvent } from "../packages/storage/eventStore.mjs";
test("producer and dashboard share the canonical completion contract", () => { let published; const event = emitCompletion({ publish: value => { published = value; } }, "j-1", { ok: true }); assert.equal(event.type, "job.completed"); assert.deepEqual(published, event); assert.deepEqual(reduceDashboard({ completed: [] }, event), { completed: ["j-1"] }); });
test("legacy persisted completion events migrate on read", () => { assert.deepEqual(deserializeEvent('{"type":"job_done","jobId":"old"}'), { type: "job.completed", jobId: "old" }); });
`,
    },
    protectedFiles: ["tests/event-flow.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/event-flow.test.mjs"], expectExit: 0, timeoutMs: 30_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./packages/protocol/events.mjs').then(({normalizeEvent})=>{const x={type:'other',n:1};const y=normalizeEvent(x);if(y!==x||y.type!=='other')process.exit(7);const old={type:'job_done',jobId:'x'};const next=normalizeEvent(old);if(next===old||next.type!=='job.completed'||old.type!=='job_done')process.exit(8)})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 40,
  },
  {
    id: "atomic-state-persistence",
    title: "Make state persistence atomic under injected I/O failure",
    prompt:
      "A process crash during state persistence occasionally leaves an unreadable state file. Fix the persistence boundary so an interrupted write preserves the previous valid file and a successful write becomes visible atomically. Work through the repository abstraction, keep callers compatible, do not edit tests, and verify both success and failure paths.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/io/atomicStore.mjs": `export async function writeJson(adapter, file, value) { const body = JSON.stringify(value, null, 2) + "\\n"; await adapter.writeFile(file, body); }
export async function readJson(adapter, file) { return JSON.parse(await adapter.readFile(file)); }
`,
      "src/io/nodeAdapter.mjs": `import { readFile, rename, rm, writeFile } from "node:fs/promises";
export const nodeAdapter = { readFile: file => readFile(file, "utf8"), writeFile: (file, body) => writeFile(file, body, "utf8"), rename, rm: file => rm(file, { force: true }) };
`,
      "src/state/stateRepository.mjs": `import { readJson, writeJson } from "../io/atomicStore.mjs";
export class StateRepository { constructor(adapter, file) { this.adapter = adapter; this.file = file; } load() { return readJson(this.adapter, this.file); } save(value) { return writeJson(this.adapter, this.file, value); } }
`,
      "src/state/schema.mjs": `export function validateState(value) { if (!value || typeof value.version !== "number") throw new Error("invalid state"); return value; }
`,
      "src/service/checkpointService.mjs": `export async function checkpoint(repo, state) { await repo.save({ ...state, saved: true }); return state; }
`,
      "src/cli/saveCommand.mjs": `export async function saveCommand(service, input) { await service(input); return "saved"; }
`,
      "src/logging/logger.mjs": `export const logger = { info() {}, error() {} };
`,
      "src/constants.mjs": `export const STATE_VERSION = 1;
`,
      "docs/persistence.md": "State saves must never expose a partial JSON document.\n",
      "tests/atomic-store.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { writeJson } from "../src/io/atomicStore.mjs";
function fake(initial, failWrite = false) { const files = new Map([["state.json", initial]]); const calls = []; return { files, calls, adapter: { async readFile(file) { return files.get(file); }, async writeFile(file, body) { calls.push(["write", file]); if (failWrite) throw new Error("disk full"); files.set(file, body); }, async rename(from, to) { calls.push(["rename", from, to]); files.set(to, files.get(from)); files.delete(from); }, async rm(file) { calls.push(["rm", file]); files.delete(file); } } }; }
test("successful save writes a temporary file then atomically renames", async () => { const f = fake('{"old":true}'); await writeJson(f.adapter, "state.json", { next: true }); assert.equal(JSON.parse(f.files.get("state.json")).next, true); assert.equal(f.calls[0][0], "write"); assert.notEqual(f.calls[0][1], "state.json"); assert.deepEqual(f.calls[1], ["rename", f.calls[0][1], "state.json"]); });
test("failed temporary write preserves previous state", async () => { const old = '{"old":true}'; const f = fake(old, true); await assert.rejects(writeJson(f.adapter, "state.json", { next: true }), /disk full/); assert.equal(f.files.get("state.json"), old); });
`,
    },
    protectedFiles: ["tests/atomic-store.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/atomic-store.test.mjs"], expectExit: 0, timeoutMs: 30_000 },
      { kind: "file", path: "src/io/atomicStore.mjs", contains: "rename" },
    ],
    maxTurns: 40,
  },
  {
    id: "rename-cache-invalidation",
    title: "Invalidate a dependency cache correctly across rename and delete",
    prompt:
      "After a watched source file is renamed, queries sometimes return stale symbols from the old path and miss dependents of the new path. Diagnose the ownership chain and fix rename/delete invalidation without turning every event into a full cache clear. Preserve unrelated entries, do not edit tests, and run the suite.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/cache/chunkCache.mjs": `export class ChunkCache { constructor() { this.items = new Map(); } get(path) { return this.items.get(path); } set(path, value) { this.items.set(path, value); } delete(path) { this.items.delete(path); } keys() { return [...this.items.keys()]; } }
`,
      "src/graph/dependencyIndex.mjs": `export class DependencyIndex { constructor() { this.byFile = new Map(); } set(file, deps) { this.byFile.set(file, new Set(deps)); } remove(file) { this.byFile.delete(file); for (const deps of this.byFile.values()) deps.delete(file); } dependents(file) { return [...this.byFile].filter(([, deps]) => deps.has(file)).map(([name]) => name); } }
`,
      "src/watch/fileEvents.mjs": `export function applyFileEvent(cache, graph, event) { if (event.kind === "rename") { cache.delete(event.path); graph.remove(event.path); return; } if (event.kind === "delete") { cache.delete(event.path); graph.remove(event.path); } }
`,
      "src/search/searchService.mjs": `export function cachedSearch(cache, file, compute) { const hit = cache.get(file); if (hit) return hit; const value = compute(file); cache.set(file, value); return value; }
`,
      "src/watch/eventTypes.mjs": `export const FILE_EVENTS = Object.freeze({ RENAME: "rename", DELETE: "delete", CHANGE: "change" });
`,
      "src/path/normalize.mjs": `export const normalizePath = value => value.replaceAll("\\\\", "/");
`,
      "src/index.mjs": `export { applyFileEvent } from "./watch/fileEvents.mjs"; export { ChunkCache } from "./cache/chunkCache.mjs"; export { DependencyIndex } from "./graph/dependencyIndex.mjs";
`,
      "src/telemetry/events.mjs": `export function recordEvent() {}
`,
      "src/config/defaults.mjs": `export const DEFAULT_CACHE_SIZE = 256;
`,
      "docs/cache.md": "Rename events contain oldPath and path (the new path).\n",
      "tests/rename-cache.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { applyFileEvent, ChunkCache, DependencyIndex } from "../src/index.mjs";
test("rename evicts both path identities and stale graph edges only", () => { const cache = new ChunkCache(); cache.set("old.ts", "old"); cache.set("new.ts", "preexisting"); cache.set("keep.ts", "keep"); const graph = new DependencyIndex(); graph.set("consumer.ts", ["old.ts"]); graph.set("keep.ts", ["shared.ts"]); applyFileEvent(cache, graph, { kind: "rename", oldPath: "old.ts", path: "new.ts" }); assert.deepEqual(cache.keys(), ["keep.ts"]); assert.deepEqual(graph.dependents("old.ts"), []); assert.equal(graph.byFile.has("old.ts"), false); assert.equal(graph.byFile.has("new.ts"), false); assert.deepEqual(graph.dependents("shared.ts"), ["keep.ts"]); });
test("delete evicts its exact entry", () => { const cache = new ChunkCache(); const graph = new DependencyIndex(); cache.set("gone.ts", 1); cache.set("keep.ts", 2); graph.set("gone.ts", []); applyFileEvent(cache, graph, { kind: "delete", path: "gone.ts" }); assert.deepEqual(cache.keys(), ["keep.ts"]); });
`,
    },
    protectedFiles: ["tests/rename-cache.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/rename-cache.test.mjs"], expectExit: 0, timeoutMs: 30_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/index.mjs').then(({applyFileEvent,ChunkCache,DependencyIndex})=>{const c=new ChunkCache();const g=new DependencyIndex();c.set('a',1);c.set('b',2);c.set('z',3);g.set('x',['a']);g.set('y',['b']);applyFileEvent(c,g,{kind:'rename',oldPath:'a',path:'b'});if(c.get('a')||c.get('b')||c.get('z')!==3||g.dependents('a').length)process.exit(9)})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 40,
  },
  {
    id: "backward-config-migration",
    title: "Migrate configuration while keeping old callers and round trips valid",
    prompt:
      "Version-1 config files still load, but their string port leaks into runtime and saving them loses unrelated user fields. Implement a backward-compatible v1-to-v2 normalization and stable round trip used by CLI and server callers. Keep unknown fields, reject invalid ports, do not edit tests, and verify the repository.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/config/defaults.mjs": `export const DEFAULT_CONFIG = { version: 2, server: { host: "127.0.0.1", port: 8080 } };
`,
      "src/config/loadConfig.mjs": `import { DEFAULT_CONFIG } from "./defaults.mjs";
export function normalizeConfig(raw) { if (!raw) return structuredClone(DEFAULT_CONFIG); if (raw.version === 1) return { version: 2, server: { host: raw.host ?? DEFAULT_CONFIG.server.host, port: raw.port ?? DEFAULT_CONFIG.server.port } }; return raw; }
`,
      "src/config/saveConfig.mjs": `export function serializeConfig(config) { return JSON.stringify({ version: config.version, server: config.server }, null, 2) + "\\n"; }
`,
      "src/config/configRepository.mjs": `import { normalizeConfig } from "./loadConfig.mjs"; import { serializeConfig } from "./saveConfig.mjs";
export class ConfigRepository { constructor(io, file) { this.io = io; this.file = file; } async load() { return normalizeConfig(JSON.parse(await this.io.read(this.file))); } async save(value) { await this.io.write(this.file, serializeConfig(value)); } }
`,
      "src/server/startServer.mjs": `export function serverAddress(config) { return config.server.host + ":" + config.server.port; }
`,
      "src/cli/configCommand.mjs": `export function printConfig(config) { return JSON.stringify(config); }
`,
      "src/api/settingsHandler.mjs": `export function settingsResponse(config) { return { status: 200, body: config }; }
`,
      "src/validation/ports.mjs": `export function isPort(value) { return Number.isInteger(value) && value > 0 && value <= 65535; }
`,
      "src/index.mjs": `export { normalizeConfig } from "./config/loadConfig.mjs"; export { serializeConfig } from "./config/saveConfig.mjs";
`,
      "docs/config.md": "v1: {version:1,host,port}; v2: {version:2,server:{host,port}}. Unknown top-level fields belong to the user and must round-trip.\n",
      "tests/config-migration.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, serializeConfig } from "../src/index.mjs";
test("v1 normalizes port and preserves user fields", () => { const raw = { version: 1, host: "0.0.0.0", port: "9090", theme: "dark", plugin: { enabled: true } }; const next = normalizeConfig(raw); assert.deepEqual(next.server, { host: "0.0.0.0", port: 9090 }); assert.equal(next.version, 2); assert.equal(next.theme, "dark"); assert.deepEqual(next.plugin, { enabled: true }); assert.equal(raw.version, 1); });
test("normalized config round trips without dropping fields", () => { const next = normalizeConfig({ version: 1, port: "3000", extra: 7 }); assert.deepEqual(JSON.parse(serializeConfig(next)), next); });
test("invalid legacy ports are rejected", () => { for (const port of ["zero", 0, 70000]) assert.throws(() => normalizeConfig({ version: 1, port }), /port/i); });
`,
    },
    protectedFiles: ["tests/config-migration.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/config-migration.test.mjs"], expectExit: 0, timeoutMs: 30_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/index.mjs').then(({normalizeConfig,serializeConfig})=>{const v2={version:2,server:{host:'x',port:42},custom:{a:1}};const n=normalizeConfig(v2);if(n!==v2||JSON.parse(serializeConfig(n)).custom.a!==1)process.exit(6)})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 40,
  },
];
