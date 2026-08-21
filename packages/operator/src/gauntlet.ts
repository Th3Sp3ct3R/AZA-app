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
// coding-v3: the de-saturation suite. coding-v2 pinned at 100% for
// deepseek-v4-pro with AND without the harness (2026-08-15 baseline), so it
// can no longer rank anything. v3 targets failure modes frontier models still
// get wrong: byte-boundary streaming, cancellation composed with queueing,
// algorithmic complexity under a real clock, red-herring debugging where the
// "obviously wrong" code is load-bearing, and a versioned migration chain.
// Fixtures stay dependency-free Node; probes stay reality-only.
export const CODING_GAUNTLET_V3: GauntletTask[] = [
  {
    id: "stream-frame-parser",
    title: "Make a streaming frame parser chunk-boundary safe",
    prompt:
      "Streaming clients report corrupted text when multi-byte characters straddle network chunks, and the final event of a response is silently dropped. Fix src/frameParser.mjs so the emitted frames are identical no matter how the byte stream is chunked — including one byte at a time. Keep the public API (constructor(onFrame), push(bytes), flush()). Do not edit tests; run the suite to confirm.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/frameParser.mjs": `export class FrameParser {
  constructor(onFrame) { this.onFrame = onFrame; this.tail = ""; }
  push(chunk) {
    const text = this.tail + Buffer.from(chunk).toString("utf8");
    const lines = text.split("\\n");
    this.tail = lines.pop() ?? "";
    for (const line of lines) { if (line.length > 0) this.onFrame(JSON.parse(line)); }
  }
  flush() { this.tail = ""; }
}
`,
      "src/transport.mjs": `export async function pump(stream, parser) { for await (const chunk of stream) parser.push(chunk); parser.flush(); }
`,
      "src/metrics.mjs": `export function frameCounter() { let n = 0; return { count: () => n, tick: () => { n++; } }; }
`,
      "docs/protocol.md": "Frames are newline-delimited JSON. CRLF and LF both terminate a frame; blank lines are ignored; a final frame may arrive without a trailing newline and is emitted on flush(). Payloads are UTF-8 and may be split at ANY byte boundary.\n",
      "tests/frame-parser.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { FrameParser } from "../src/frameParser.mjs";

const doc = '{"id":1,"note":"h\\u00e9llo \\ud83c\\udf0d"}\\r\\n\\r\\n{"id":2,"note":"ok"}\\n{"id":3,"note":"\\u672b\\u5c3e"}';
const bytes = Buffer.from(doc, "utf8");
const expected = [
  { id: 1, note: "h\\u00e9llo \\ud83c\\udf0d" },
  { id: 2, note: "ok" },
  { id: 3, note: "\\u672b\\u5c3e" },
];

function collect(chunks) {
  const frames = [];
  const parser = new FrameParser((frame) => frames.push(frame));
  for (const chunk of chunks) parser.push(chunk);
  parser.flush();
  return frames;
}

test("every two-chunk split of the byte stream yields identical frames", () => {
  for (let split = 0; split <= bytes.length; split++) {
    assert.deepEqual(collect([bytes.subarray(0, split), bytes.subarray(split)]), expected, "split at byte " + split);
  }
});

test("one byte per chunk", () => {
  const chunks = [];
  for (let i = 0; i < bytes.length; i++) chunks.push(bytes.subarray(i, i + 1));
  assert.deepEqual(collect(chunks), expected);
});

test("flush emits a final frame that has no trailing newline", () => {
  assert.deepEqual(collect([Buffer.from('{"only":true}', "utf8")]), [{ only: true }]);
});

test("flush is safe on an empty stream", () => {
  assert.deepEqual(collect([]), []);
});
`,
    },
    protectedFiles: ["tests/frame-parser.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/frame-parser.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/frameParser.mjs').then(({FrameParser})=>{const doc='{\"a\":\"\\ud83c\\udf0d\\u00e9\"}\\n{\"b\":2}';const bytes=Buffer.from(doc,'utf8');const out=[];const p=new FrameParser(f=>out.push(f));for(const b of bytes)p.push(Uint8Array.of(b));p.flush();if(JSON.stringify(out)!==JSON.stringify([{a:'\\ud83c\\udf0d\\u00e9'},{b:2}]))process.exit(9)})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 48,
  },
  {
    id: "async-mutex-cancellation",
    title: "Make lock cancellation compose with the waiter queue",
    prompt:
      "Under load, aborting a queued request occasionally deadlocks the whole job runner: the lock is never handed to the next waiter, or is handed to a request that already gave up. Fix src/mutex.mjs so cancellation composes with the queue: acquire(signal) rejects on abort (including an already-aborted signal) without ever corrupting the lock, and release() always hands the lock to the next LIVE waiter or frees it. Keep the caller-facing contract; do not edit tests; run the suite.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/mutex.mjs": `export class Mutex {
  constructor() { this.locked = false; this.queue = []; }
  acquire(signal) {
    if (!this.locked) { this.locked = true; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve });
      signal?.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) next.resolve();
    else this.locked = false;
  }
}
`,
      "src/withLock.mjs": `export async function withLock(mutex, signal, fn) { await mutex.acquire(signal); try { return await fn(); } finally { mutex.release(); } }
`,
      "src/jobRunner.mjs": `import { withLock } from "./withLock.mjs";
export function makeRunner(mutex) { return (signal, job) => withLock(mutex, signal, job); }
`,
      "src/backoff.mjs": `export function backoffMs(attempt) { return Math.min(30000, 250 * 2 ** attempt); }
`,
      "docs/locking.md": "Contract: acquire(signal?) resolves when the lock is held and rejects if the signal aborts first (an already-aborted signal rejects immediately and never joins the queue). release() hands the lock to the oldest live waiter, skipping aborted ones, or frees the lock when none remain.\n",
      "tests/mutex.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { Mutex } from "../src/mutex.mjs";
import { withLock } from "../src/withLock.mjs";

test("aborting a queued waiter hands the lock to the next live waiter", { timeout: 5000 }, async () => {
  const m = new Mutex();
  await m.acquire();
  const controller = new AbortController();
  const doomed = m.acquire(controller.signal);
  doomed.catch(() => {});
  const order = [];
  const survivor = m.acquire().then(() => order.push("survivor"));
  controller.abort();
  await assert.rejects(doomed);
  m.release();
  await survivor;
  assert.deepEqual(order, ["survivor"]);
  m.release();
  await m.acquire();
  m.release();
});

test("an already-aborted signal is rejected without corrupting the lock", { timeout: 5000 }, async () => {
  const m = new Mutex();
  await m.acquire();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(m.acquire(controller.signal));
  m.release();
  await m.acquire();
  m.release();
});

test("aborting every queued waiter then releasing frees the lock", { timeout: 5000 }, async () => {
  const m = new Mutex();
  await m.acquire();
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const waiters = controllers.map((ctrl) => m.acquire(ctrl.signal).catch(() => "aborted"));
  for (const ctrl of controllers) ctrl.abort();
  assert.deepEqual(await Promise.all(waiters), ["aborted", "aborted", "aborted", "aborted", "aborted"]);
  m.release();
  await m.acquire();
  m.release();
});

test("waiters acquire in FIFO order", { timeout: 5000 }, async () => {
  const m = new Mutex();
  await m.acquire();
  const order = [];
  const first = m.acquire().then(() => { order.push(1); m.release(); });
  const second = m.acquire().then(() => { order.push(2); m.release(); });
  m.release();
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]);
});

test("withLock releases the lock when the body throws", { timeout: 5000 }, async () => {
  const m = new Mutex();
  await assert.rejects(withLock(m, undefined, async () => { throw new Error("boom"); }), /boom/);
  await m.acquire();
  m.release();
});
`,
    },
    protectedFiles: ["tests/mutex.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/mutex.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/mutex.mjs').then(async({Mutex})=>{const guard=setTimeout(()=>process.exit(8),2000);const m=new Mutex();await m.acquire();const ac=new AbortController();ac.abort();let rejected=false;try{await m.acquire(ac.signal)}catch{rejected=true}if(!rejected)process.exit(7);m.release();await m.acquire();clearTimeout(guard);m.release()})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 48,
  },
  {
    id: "interval-aggregation-perf",
    title: "Scale the concurrency report without changing its semantics",
    prompt:
      "The daily concurrency report went from seconds to being killed by the scheduler as traffic grew (~150k sessions, ~150k sampled timestamps). Rewrite concurrencyAt in src/report.mjs to handle that size with IDENTICAL semantics: start inclusive, end exclusive, unsorted inputs allowed, inputs never mutated. The grader runs the full 150k x 150k workload under a hard timeout, so an O(n*m) scan cannot pass. Do not edit tests; run the suite and demonstrate the speed yourself.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/report.mjs": `export function concurrencyAt(intervals, timestamps) {
  return timestamps.map((t) => intervals.filter((iv) => iv.start <= t && t < iv.end).length);
}
`,
      "src/loadSessions.mjs": `export function toIntervals(rows) { return rows.map((row) => ({ start: row.startedAt, end: row.endedAt })); }
`,
      "src/render.mjs": `export function renderReport(counts) { return counts.join("\\n"); }
`,
      "docs/report.md": "concurrencyAt(intervals, timestamps): for each timestamp t, the number of intervals with start <= t < end. Inputs may be unsorted; the function must not mutate them. Empty intervals (start === end) are never active.\n",
      "tests/report.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { concurrencyAt } from "../src/report.mjs";

test("boundary semantics: start inclusive, end exclusive", () => {
  const intervals = [{ start: 0, end: 10 }, { start: 5, end: 5 }, { start: 10, end: 20 }, { start: 3, end: 12 }];
  assert.deepEqual(concurrencyAt(intervals, [0, 3, 5, 9, 10, 12, 19, 20, -1]), [1, 2, 2, 2, 2, 1, 1, 0, 0]);
});

test("inputs may be unsorted and must not be mutated", () => {
  const intervals = [{ start: 7, end: 9 }, { start: 1, end: 4 }];
  const snapshot = JSON.stringify(intervals);
  const timestamps = [8, 2, 8];
  assert.deepEqual(concurrencyAt(intervals, timestamps), [1, 1, 1]);
  assert.equal(JSON.stringify(intervals), snapshot);
  assert.deepEqual(timestamps, [8, 2, 8]);
});

test("agrees with a brute-force reference on a deterministic fixture", () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const intervals = Array.from({ length: 500 }, () => { const start = Math.floor(rnd() * 1000); return { start, end: start + Math.floor(rnd() * 50) }; });
  const timestamps = Array.from({ length: 500 }, () => Math.floor(rnd() * 1000));
  const expected = timestamps.map((t) => intervals.filter((iv) => iv.start <= t && t < iv.end).length);
  assert.deepEqual(concurrencyAt(intervals, timestamps), expected);
});
`,
    },
    protectedFiles: ["tests/report.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/report.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/report.mjs').then(({concurrencyAt})=>{let s=1;const rnd=()=>((s=s*48271%2147483647)/2147483647);const n=150000;const intervals=Array.from({length:n},()=>{const a=Math.floor(rnd()*1e6);return{start:a,end:a+1+Math.floor(rnd()*5000)}});const ts=Array.from({length:n},()=>Math.floor(rnd()*1e6));const t0=Date.now();const out=concurrencyAt(intervals,ts);const dt=Date.now()-t0;if(!Array.isArray(out)||out.length!==n)process.exit(7);for(let k=0;k<300;k++){const i=Math.floor(k*n/300);const t=ts[i];let c=0;for(const iv of intervals){if(iv.start<=t&&t<iv.end)c++}if(out[i]!==c)process.exit(8)}if(dt>20000)process.exit(9)})"], expectExit: 0, timeoutMs: 30_000 },
    ],
    maxTurns: 48,
  },
  {
    id: "phantom-flake",
    title: "Find the real dedupe bug behind a misleading incident report",
    prompt:
      "Field report from ops: 'Payments occasionally process twice. We are pretty sure it is the LRU in src/cache.mjs - it DELETES entries during get(), which looks completely wrong. Same batch, same event, gets through dedupe twice.' Investigate and fix the double-processing for good. Careful: parts of this system look strange but are correct and load-bearing, and the protected tests pin their exact behavior. Do not edit tests; run the suite.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/cache.mjs": `export class LruCache {
  constructor(capacity) { this.capacity = capacity; this.map = new Map(); }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }
  has(key) { return this.map.has(key); }
  get size() { return this.map.size; }
}
`,
      "src/dedupe.mjs": `export function eventKey(event) { return JSON.stringify(event); }
export class Deduper {
  constructor(cache) { this.cache = cache; }
  isDuplicate(event) {
    const key = eventKey(event);
    if (this.cache.has(key)) { this.cache.get(key); return true; }
    this.cache.set(key, true);
    return false;
  }
}
`,
      "src/pipeline.mjs": `import { Deduper } from "./dedupe.mjs";
export function processBatch(deduper, events, handler) { const out = []; for (const event of events) { if (deduper.isDuplicate(event)) continue; out.push(handler(event)); } return out; }
export { Deduper };
`,
      "src/journal.mjs": `export function journalLine(event) { return new Array(0).concat(event.id ?? "unknown").join(""); }
`,
      "docs/incident-4711.md": "INC-4711: duplicate payment processing. Ops suspects src/cache.mjs (get() deletes the entry it reads!). Events for the same payment arrive from BOTH the worker fleet and the API gateway; the two producers serialize fields in different orders.\n",
      "tests/dedupe.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../src/cache.mjs";
import { Deduper } from "../src/dedupe.mjs";
import { processBatch } from "../src/pipeline.mjs";

test("the same logical event is suppressed regardless of producer key order", () => {
  const deduper = new Deduper(new LruCache(64));
  const fromWorker = { id: "p-9", amount: 25, meta: { region: "eu", retry: 0 } };
  const fromApi = { meta: { retry: 0, region: "eu" }, amount: 25, id: "p-9" };
  const handled = processBatch(deduper, [fromWorker, fromApi], (event) => event.id);
  assert.deepEqual(handled, ["p-9"]);
});

test("array order stays meaningful: reordered arrays are DIFFERENT events", () => {
  const deduper = new Deduper(new LruCache(64));
  const handled = processBatch(deduper, [
    { id: "a", steps: [1, 2] },
    { id: "a", steps: [2, 1] },
    { id: "b", steps: [1, 2] },
  ], (event) => event.id);
  assert.deepEqual(handled, ["a", "a", "b"]);
});

test("the read-refresh LRU eviction order is load-bearing and must not change", () => {
  const cache = new LruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  assert.equal(cache.has("a"), true, "recently-read key survives");
  assert.equal(cache.has("b"), false, "least-recently-used key is evicted");
  assert.equal(cache.has("c"), true);
});
`,
    },
    protectedFiles: ["tests/dedupe.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/dedupe.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/dedupe.mjs').then(({eventKey})=>{const a=eventKey({x:{b:1,a:[{z:1,y:2}]},n:0});const b=eventKey({n:0,x:{a:[{y:2,z:1}],b:1}});if(a!==b)process.exit(7);const c=eventKey({t:[1,2]});const d=eventKey({t:[2,1]});if(c===d)process.exit(8)})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 48,
  },
  {
    id: "schema-chain-migration",
    title: "Chain versioned migrations without losing user data",
    prompt:
      "Documents persist in three historical shapes (see docs/migrations.md). Old documents lose user fields on load, v1 inputs get mutated in place, and invalid documents slip through unvalidated. Make migrate(doc) in src/migrate.mjs bring ANY supported version to v3: unknown top-level fields survive every hop, inputs are never mutated, a current v3 document is returned as the same reference, empty v1 tags become an empty list, and invalid documents are rejected with an error whose message contains 'invalid'. Do not edit tests; run the suite.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/migrate.mjs": `export function migrate(doc) {
  if (!doc || typeof doc !== "object") throw new Error("invalid document");
  if (doc.version === 3) return doc;
  if (doc.version === 2) return { version: 3, profile: { name: doc.name }, tags: doc.tags, rev: 0 };
  if (doc.version === 1) { doc.tags = doc.tags.split(","); doc.version = 2; return migrate(doc); }
  throw new Error("unsupported version " + doc.version);
}
`,
      "src/render.mjs": `export function title(doc) { return doc.profile.name + " (rev " + doc.rev + ")"; }
`,
      "src/api.mjs": `import { migrate } from "./migrate.mjs";
export function loadDocument(raw) { return migrate(JSON.parse(raw)); }
`,
      "docs/migrations.md": "v1: {version:1, name, tags:'a,b' (comma string; empty string means no tags)}. v2: {version:2, name, tags:[...]}. v3 (current): {version:3, profile:{name}, tags:[...], rev}. Unknown top-level fields belong to the user and must survive migration. Inputs are immutable. Rejections throw errors whose message contains 'invalid'.\n",
      "tests/migrate.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../src/migrate.mjs";

test("v1 documents reach v3 with unknown fields intact and input untouched", () => {
  const v1 = { version: 1, name: "alpha", tags: "red,blue", starred: true, owner: { id: 7 } };
  const snapshot = JSON.stringify(v1);
  const out = migrate(v1);
  assert.equal(out.version, 3);
  assert.deepEqual(out.profile, { name: "alpha" });
  assert.deepEqual(out.tags, ["red", "blue"]);
  assert.equal(out.rev, 0);
  assert.equal(out.starred, true);
  assert.deepEqual(out.owner, { id: 7 });
  assert.equal(JSON.stringify(v1), snapshot, "input document must not be mutated");
});

test("empty v1 tags become an empty list", () => {
  assert.deepEqual(migrate({ version: 1, name: "e", tags: "" }).tags, []);
});

test("v2 documents reach v3 with unknown fields intact", () => {
  const v2 = { version: 2, name: "beta", tags: ["x"], pinned: "yes" };
  const out = migrate(v2);
  assert.deepEqual(out.profile, { name: "beta" });
  assert.deepEqual(out.tags, ["x"]);
  assert.equal(out.pinned, "yes");
});

test("a current document is returned as the same reference and migration is idempotent", () => {
  const v3 = { version: 3, profile: { name: "gamma" }, tags: [], rev: 4, extra: 1 };
  assert.equal(migrate(v3), v3);
  const migrated = migrate({ version: 1, name: "d", tags: "x" });
  assert.deepEqual(migrate(migrated), migrated);
});

test("invalid documents are rejected", () => {
  assert.throws(() => migrate({ version: 1, name: "x", tags: 5 }), /invalid/i);
  assert.throws(() => migrate({ version: 2, name: "x", tags: "not-an-array" }), /invalid/i);
  assert.throws(() => migrate({ version: 9 }), /invalid/i);
  assert.throws(() => migrate(null), /invalid/i);
});
`,
    },
    protectedFiles: ["tests/migrate.test.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/migrate.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/migrate.mjs').then(({migrate})=>{const v1={version:1,name:'n',tags:'a',keep:{deep:true}};const out=migrate(v1);if(v1.version!==1||typeof v1.tags!=='string')process.exit(7);if(out.keep?.deep!==true||out.version!==3)process.exit(8);const v3={version:3,profile:{name:'z'},tags:['t'],rev:2};if(migrate(v3)!==v3)process.exit(9)})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 48,
  },
];

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

// coding-v4: the spec-completeness suite. v2 AND v3 both pinned at 100% for
// deepseek-v4-pro (2026-08-15 baselines) — once a model can iterate the visible
// tests to green, any suite whose probes mirror those tests saturates. v4's
// gradient comes from the gap the harness cannot close for the model: each
// fixture ships a RICH spec document, deliberately THIN visible tests, and
// hidden probes drawn from the spec's long tail. Iterating the visible suite
// to green scores zero unless the implementation honored the whole spec.
// Fixtures stay dependency-free Node; probes stay reality-only.
export const CODING_GAUNTLET_V4: GauntletTask[] = [
  {
    id: "glob-contract",
    title: "Implement the documented glob contract, not the visible tests",
    prompt:
      "The ignore-list feature mis-matches paths: patterns cross directory boundaries, character classes don't work, and there is no way to escape a literal star. Reimplement match() in src/glob.mjs so it satisfies docs/glob-spec.md COMPLETELY — the spec, not the test file, is the contract (the visible tests cover only a fraction of it). Keep the public API. Do not edit tests; run the suite to confirm the basics.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/glob.mjs": `// match(pattern, path) — see docs/glob-spec.md for the full contract.
export function match(pattern, path) {
  const source = pattern.replace(/[.+^$\{\}()|]/g, "\\\\$&").replace(/\\*/g, ".*").replace(/\\?/g, ".");
  return new RegExp("^" + source + "$").test(path);
}
`,
      "src/segments.mjs": `/** Split a normalized pathspec into segments. "" has NO segments. */
export function segmentsOf(spec) { return spec === "" ? [] : spec.split("/"); }
`,
      "src/pathspec.mjs": `/** Normalize a user path: strip leading/trailing slashes, collapse runs. */
export function normalizePath(raw) { return raw.replace(/\\/+/g, "/").replace(/^\\/|\\/$/g, ""); }
`,
      "src/ignore.mjs": `import { match } from "./glob.mjs";
import { normalizePath } from "./pathspec.mjs";
/** The consumer: filter out paths matching ANY ignore pattern. */
export function filterIgnored(paths, patterns) {
  return paths.filter((p) => !patterns.some((pat) => match(pat, normalizePath(p))));
}
`,
      "docs/glob-spec.md": `# Glob contract

match(pattern, path): both arguments are already-normalized "/"-separated
specs — no leading or trailing slash. Matching is case-sensitive. The empty
pattern matches only the empty path.

Segment semantics (the separator is sacred):
- A pattern is split on "/" into segments; so is the path. Nothing below ever
  matches a "/" — only the segment rules can consume separators.
- A segment consisting EXACTLY of \`**\` matches ZERO OR MORE whole path
  segments. \`a/**/b\` therefore matches \`a/b\`, \`a/x/b\`, and \`a/x/y/b\`.
  A trailing \`a/**\` matches \`a\` itself. A bare \`**\` matches every path,
  including the empty one.
- A \`**\` that is NOT a whole segment is not special: \`a**b\` behaves exactly
  like \`a*b\`.

Within one segment:
- \`*\` matches zero or more characters.
- \`?\` matches exactly one character.
- \`[...]\` matches one character from the set. \`[!...]\` negates the set.
  \`-\` denotes an inclusive range unless it is the first or last character in
  the set (then it is a literal \`-\`). A \`]\` as the FIRST set character
  (after any \`!\`) is a literal \`]\`. An unclosed \`[\` is a literal \`[\`.
- \`\\\\x\` makes the next character literal — \`\\\\*\` matches a real star,
  \`\\\\[\` a real bracket, \`\\\\\\\\\` a real backslash.
`,
      "tests/glob.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { match } from "../src/glob.mjs";

test("* stays inside its segment", () => {
  assert.equal(match("*", "a"), true);
  assert.equal(match("*", "a/b"), false);
  assert.equal(match("src/*.mjs", "src/glob.mjs"), true);
  assert.equal(match("src/*.mjs", "src/deep/glob.mjs"), false);
});

test("** crosses segments", () => {
  assert.equal(match("src/**/index.mjs", "src/a/b/index.mjs"), true);
  assert.equal(match("**", "any/path/at/all"), true);
});

test("? matches exactly one character", () => {
  assert.equal(match("a?c", "abc"), true);
  assert.equal(match("a?c", "ac"), false);
});

test("a simple character class", () => {
  assert.equal(match("[ab]x", "ax"), true);
  assert.equal(match("[ab]x", "cx"), false);
});
`,
    },
    protectedFiles: ["tests/glob.test.mjs", "docs/glob-spec.md"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/glob.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      // The long tail the visible tests never mention: ** matching zero
      // segments, negated classes, literal ] and -, escapes, unclosed [.
      { kind: "command", cmd: "node", args: ["-e", "import('./src/glob.mjs').then(({match})=>{const C=[['a/**/b','a/b',1],['a/**','a',1],['**','',1],['[!a]','b',1],['[!a]','a',0],['[]]',']',1],['[a-]','-',1],['[a-]','a',1],['[a-c]x','bx',1],['[a-c]x','dx',0],['a**b','axyb',1],['a**b','a/b',0],['[','[',1],['a/*','a',0]];for(const[p,s,e]of C){if(match(p,s)!==!!e){console.error('FAIL',p,s);process.exit(9)}}})"], expectExit: 0, timeoutMs: 15_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/glob.mjs').then(({match})=>{const C=[['\\\\*','*',1],['\\\\*','x',0],['\\\\[a]','[a]',1],['a\\\\\\\\b','a\\\\b',1]];for(const[p,s,e]of C){if(match(p,s)!==!!e){console.error('FAIL',JSON.stringify(p),JSON.stringify(s));process.exit(9)}}})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 48,
  },
  {
    id: "incremental-rebuild",
    title: "Interface-hash cutoff for the incremental rebuild planner",
    prompt:
      "The build farm rebuilds the world on every commit: the planner ignores interface hashes, its ordering is nondeterministic, and a dependency cycle crashes it with a stack overflow instead of a diagnosis. Reimplement plan() in src/plan.mjs to satisfy docs/rebuild-spec.md COMPLETELY — the spec, not the visible tests, is the contract. Keep the public API. Do not edit tests.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/plan.mjs": `// plan(graph, changedIds, previousIfaces) — see docs/rebuild-spec.md.
export function plan(graph, changedIds, previousIfaces) {
  const out = [];
  const visit = (id) => {
    if (!out.includes(id)) out.push(id);
    for (const [node, deps] of Object.entries(graph.deps ?? {})) {
      if (deps.includes(id)) visit(node);
    }
  };
  for (const id of changedIds) visit(id);
  return out;
}
`,
      "src/graph.mjs": `/** Dependents index: for each node, who depends on it. */
export function dependentsOf(graph) {
  const rev = {};
  for (const node of graph.nodes) rev[node.id] = [];
  for (const [id, deps] of Object.entries(graph.deps ?? {})) {
    for (const dep of deps) (rev[dep] ??= []).push(id);
  }
  return rev;
}
`,
      "src/iface.mjs": `/** Current interface signature of a node, "" when undeclared. */
export function ifaceOf(graph, id) { return graph.nodes.find((n) => n.id === id)?.iface ?? ""; }
`,
      "src/errors.mjs": `export class CycleError extends Error { constructor(msg) { super(msg); this.name = "CycleError"; } }
export class UnknownNodeError extends Error { constructor(msg) { super(msg); this.name = "UnknownNodeError"; } }
`,
      "docs/rebuild-spec.md": `# Incremental rebuild contract

plan(graph, changedIds, previousIfaces) -> string[]

- graph: { nodes: [{ id, iface }], deps: { [id]: [dependencyIds] } }.
  \`iface\` is the node's CURRENT public-interface signature.
- previousIfaces: { [id]: string } — the signature each node had after the
  last successful build.
- changedIds: nodes whose sources changed.

Which nodes rebuild:
1. Every changed node rebuilds.
2. A node rebuilds when at least one of its DIRECT dependencies rebuilt AND
   that dependency's interface actually changed (\`graph\` iface !==
   \`previousIfaces\` entry). This is the interface cutoff: a dependency that
   rebuilt but kept its interface stops the wave — its dependents do NOT
   rebuild on its account.
3. Rule 2 cascades: a node that rebuilds this way propagates onward only per
   rule 2 applied to ITS interface.

Ordering:
- Dependencies before dependents, always.
- Nodes not ordered by that rule are sorted alphabetically by id. The result
  is fully deterministic.

Errors (thrown, never returned):
- A dependency cycle among nodes that would need rebuilding throws CycleError
  (name "CycleError") whose message contains the cycle's member ids sorted
  alphabetically and joined with ", " (comma, space).
- A changedId absent from graph.nodes throws UnknownNodeError (name
  "UnknownNodeError") whose message contains the id.
`,
      "tests/plan.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/plan.mjs";

const chain = {
  nodes: [{ id: "a", iface: "A1" }, { id: "b", iface: "B0" }, { id: "c", iface: "C0" }],
  deps: { b: ["a"], c: ["b"] },
};

test("an interface change propagates down a chain", () => {
  assert.deepEqual(plan(chain, ["a"], { a: "A0", b: "B9", c: "C0" }), ["a", "b", "c"]);
});

test("an unchanged interface stops the wave immediately", () => {
  assert.deepEqual(plan(chain, ["a"], { a: "A1", b: "B0", c: "C0" }), ["a"]);
});

test("dependencies come before dependents", () => {
  const out = plan(chain, ["a"], { a: "A0", b: "B0", c: "C0" });
  assert.ok(out.indexOf("a") < out.indexOf("b"));
});
`,
    },
    protectedFiles: ["tests/plan.test.mjs", "docs/rebuild-spec.md"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/plan.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      // Diamond with the cutoff on both arms: a's interface changed so b and c
      // rebuild, but neither b nor c changed ITS interface, so d must not.
      { kind: "command", cmd: "node", args: ["-e", "import('./src/plan.mjs').then(({plan})=>{const g={nodes:[{id:'a',iface:'A1'},{id:'b',iface:'B'},{id:'c',iface:'C'},{id:'d',iface:'D'}],deps:{b:['a'],c:['a'],d:['b','c']}};const out=plan(g,['a'],{a:'A0',b:'B',c:'C',d:'D'});if(JSON.stringify(out)!==JSON.stringify(['a','b','c']))process.exit(9)})"], expectExit: 0, timeoutMs: 15_000 },
      // Independent changed roots order alphabetically; a changed node with an
      // unchanged interface rebuilds itself without propagating.
      { kind: "command", cmd: "node", args: ["-e", "import('./src/plan.mjs').then(({plan})=>{const g={nodes:[{id:'z',iface:'Z'},{id:'m',iface:'M'},{id:'q',iface:'Q'}],deps:{q:['z']}};const out=plan(g,['z','m'],{z:'Z',m:'M0',q:'Q'});if(JSON.stringify(out)!==JSON.stringify(['m','z']))process.exit(9)})"], expectExit: 0, timeoutMs: 15_000 },
      // The error contract: CycleError with sorted members; UnknownNodeError.
      { kind: "command", cmd: "node", args: ["-e", "import('./src/plan.mjs').then(({plan})=>{const g={nodes:[{id:'x',iface:'X1'},{id:'y',iface:'Y1'}],deps:{x:['y'],y:['x']}};try{plan(g,['x'],{x:'X0',y:'Y0'});process.exit(9)}catch(e){if(e.name!=='CycleError'||!e.message.includes('x, y'))process.exit(8)}try{plan({nodes:[{id:'a',iface:'A'}],deps:{}},['ghost'],{a:'A'});process.exit(7)}catch(e){if(e.name!=='UnknownNodeError'||!e.message.includes('ghost'))process.exit(6)}})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 48,
  },
  {
    id: "deterministic-cache",
    title: "An LRU+TTL cache whose every observable behavior is specified",
    prompt:
      "The session cache returns stale entries after expiry, evicts the wrong key under pressure, and peeking at a value changes the eviction order. Reimplement src/cache.mjs against docs/cache-spec.md COMPLETELY — every method's interaction with recency, expiry, and capacity is specified there, and the spec (not the thin visible tests) is the contract. Time comes ONLY from the injected clock. Do not edit tests.",
    files: {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
      "src/cache.mjs": `// Cache — see docs/cache-spec.md for the full contract.
export class Cache {
  constructor({ capacity, defaultTtlMs, clock }) {
    this.capacity = capacity; this.defaultTtlMs = defaultTtlMs; this.clock = clock ?? (() => 0);
    this.map = new Map();
  }
  set(key, value, opts = {}) {
    if (this.map.size >= this.capacity && !this.map.has(key)) {
      const newest = [...this.map.keys()].pop();
      this.map.delete(newest);
    }
    this.map.set(key, { value, at: this.clock(), ttl: opts.ttlMs ?? this.defaultTtlMs });
  }
  get(key) { return this.map.get(key)?.value; }
  peek(key) { const e = this.map.get(key); if (e) { this.map.delete(key); this.map.set(key, e); } return e?.value; }
  has(key) { return this.map.has(key); }
  delete(key) { return this.map.delete(key); }
  size() { return this.map.size; }
  entries() { return [...this.map.entries()].map(([k, e]) => [k, e.value]); }
}
`,
      "src/clock.mjs": `/** A manual test clock: now() reads, advance(ms) moves forward. */
export function manualClock(start = 0) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  return clock;
}
`,
      "src/sessionStore.mjs": `import { Cache } from "./cache.mjs";
/** The consumer: sessions live 30 minutes unless touched. */
export function makeSessionStore(clock) {
  return new Cache({ capacity: 1000, defaultTtlMs: 30 * 60_000, clock });
}
`,
      "src/metrics.mjs": `export function hitCounter() { let hit = 0, miss = 0; return { hit: () => hit++, miss: () => miss++, ratio: () => (hit + miss === 0 ? 0 : hit / (hit + miss)) }; }
`,
      "docs/cache-spec.md": `# Cache contract

new Cache({ capacity, defaultTtlMs?, clock? }) — clock is () => milliseconds
and is the ONLY source of time. capacity is the maximum number of LIVE
(non-expired) entries.

Expiry:
- An entry's ttl is opts.ttlMs when given, else defaultTtlMs; when neither is
  set the entry never expires. An entry is expired once clock() >= insertion
  time + ttl. ttlMs < 0 throws RangeError; ttlMs of 0 means "expires
  immediately".
- Expired entries are invisible everywhere: get/peek return undefined, has()
  is false, size() and entries() exclude them (and prune them), and they are
  removed before any eviction decision.

Recency:
- get(key) and set(key) mark the key most-recently-used. peek(key) and
  has(key) must NOT change recency.
- set() on an EXISTING key updates the value, refreshes recency, and restarts
  its expiry from now.

Eviction:
- Only inserting a NEW key can evict, and only when live size === capacity
  after pruning expired entries: the LEAST-recently-used live entry is
  evicted.

Reads:
- get(key): live value or undefined.
- peek(key): live value or undefined, no recency change.
- has(key): boolean, no recency change.
- delete(key): true when a live entry was removed.
- size(): count of live entries.
- entries(): [key, value] pairs of live entries, LEAST-recently-used first.
`,
      "tests/cache.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { Cache } from "../src/cache.mjs";
import { manualClock } from "../src/clock.mjs";

test("expired entries are invisible to get", () => {
  const clock = manualClock();
  const cache = new Cache({ capacity: 4, defaultTtlMs: 100, clock });
  cache.set("a", 1);
  clock.advance(99);
  assert.equal(cache.get("a"), 1);
  clock.advance(1);
  assert.equal(cache.get("a"), undefined);
});

test("capacity evicts the least recently used", () => {
  const cache = new Cache({ capacity: 2, clock: manualClock() });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
});
`,
    },
    protectedFiles: ["tests/cache.test.mjs", "docs/cache-spec.md"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/cache.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      // peek/has must not refresh recency — the eviction order proves it.
      { kind: "command", cmd: "node", args: ["-e", "Promise.all([import('./src/cache.mjs'),import('./src/clock.mjs')]).then(([{Cache},{manualClock}])=>{const c=new Cache({capacity:2,clock:manualClock()});c.set('a',1);c.set('b',2);c.peek('a');c.has('a');c.set('x',9);if(c.get('a')!==undefined||c.get('b')!==2)process.exit(9)})"], expectExit: 0, timeoutMs: 15_000 },
      // set() on an existing key restarts expiry; expired entries free capacity
      // before any eviction happens.
      { kind: "command", cmd: "node", args: ["-e", "Promise.all([import('./src/cache.mjs'),import('./src/clock.mjs')]).then(([{Cache},{manualClock}])=>{const clock=manualClock();const c=new Cache({capacity:2,defaultTtlMs:100,clock});c.set('a',1);clock.advance(60);c.set('a',2);clock.advance(60);if(c.get('a')!==2)process.exit(9);clock.advance(41);c.set('p',1);c.set('q',2);if(c.size()!==2)process.exit(8);clock.advance(200);c.set('r',3);if(c.size()!==1||c.get('r')!==3)process.exit(7)})"], expectExit: 0, timeoutMs: 15_000 },
      // entries() order, ttlMs:0, and the RangeError contract.
      { kind: "command", cmd: "node", args: ["-e", "Promise.all([import('./src/cache.mjs'),import('./src/clock.mjs')]).then(([{Cache},{manualClock}])=>{const c=new Cache({capacity:3,clock:manualClock()});c.set('a',1);c.set('b',2);c.set('c',3);c.get('a');if(JSON.stringify(c.entries())!==JSON.stringify([['b',2],['c',3],['a',1]]))process.exit(9);c.set('z',0,{ttlMs:0});if(c.has('z')!==false)process.exit(8);try{c.set('n',1,{ttlMs:-5});process.exit(7)}catch(e){if(e.name!=='RangeError')process.exit(6)}})"], expectExit: 0, timeoutMs: 15_000 },
    ],
    maxTurns: 48,
  },
];

/**
 * The suite registry — the ONE place a new tier is added. The CLI resolves
 * --suite through this instead of a hardcoded allow-list + ternary, so v5+
 * is a single-file change here.
 */
export const GAUNTLET_SUITES: Record<string, GauntletTask[]> = {
  "coding-v1": CODING_GAUNTLET,
  "coding-v2": CODING_GAUNTLET_V2,
  "coding-v3": CODING_GAUNTLET_V3,
  "coding-v4": CODING_GAUNTLET_V4,
};
