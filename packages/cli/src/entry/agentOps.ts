// Extracted from entry.ts — agentOps.

import { createWorkspaceCheckpoint, restoreWorkspaceCheckpoint, loadStartupReminders, buildPromptCacheKey, routeModel, DEFAULT_PROVIDER_PROFILES, type ModelTask, type ModelTaskKind, type ModelRouteDecision, type RiskLevel, type PrivacyPosture, type QualityNeed, type CostPreference, type LatencyPreference, type ModelTouch } from "@ares/core";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { ReadTool, GlobTool, GrepTool, EditTool, WriteTool, ApplyIntentTool, MemoryTool, TodoStore, ShellRegistry, type RichToolContext, type FileReadStamp } from "@ares/tools";
import { notice } from "../terminalUi.js";
import { completeBootstrap, createMemoryStore, recordCardMemoryOnce, ensureAgentScaffold, exportHome, importHome, listSnapshots, loadAgentConfig, restoreSnapshot, runDeepDream, runRemDream, snapshotBrain } from "@ares/agent";
import { distillMissionCard, learningCardId, learningCardMemoryText, listLearningCards, loadLearningCard, saveLearningCard, type LearningCard, loadGoal, loadMissionContract, runEvalSuite, runGauntlet, CODING_GAUNTLET, CODING_GAUNTLET_V2, type EvalReport, type EvalTask } from "@ares/operator";
import { MemoryStore, withConsolidationLock } from "@ares/mind";
import { buildCodingTools } from "./engineTools.js";
import { AresCommandPermissionStore, AresPathPermissionStore } from "./permissions.js";
import { selectProvider } from "./providers.js";
import { AresRuntimeState, ParsedArgs, cliRuntimeContext, cliVersion, compactLine } from "./runtime.js";
import { buildSystemPrompt } from "./turnPipeline.js";

export async function agentCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] ?? "doctor";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const home = context.home;
  if (subcommand === "bootstrap") {
    const shouldComplete = args.flags.has("user") || args.flags.has("name");
    if (!shouldComplete) {
      const state = await ensureAgentScaffold({ home, workspace: context.workspace });
      process.stdout.write(notice("Agent Bootstrap", [state.message, `home ${state.home}`], state.required ? "warn" : "success"));
      return 0;
    }
    const state = await completeBootstrap(
      {
        userName: args.flags.get("user") ?? os.userInfo().username,
        userTimezone: args.flags.get("timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        languages: args.flags.get("languages") ?? "TypeScript",
        style: args.flags.get("style") ?? "direct, pragmatic, verify before claiming done",
        conventions: args.flags.get("conventions") ?? "follow project-local patterns",
        agentName: args.flags.get("name") ?? "Ares",
        creature: args.flags.get("creature") ?? "coding agent",
        vibe: args.flags.get("vibe") ?? "direct",
        emoji: args.flags.get("emoji") ?? "*",
      },
      { home, workspace: context.workspace },
    );
    process.stdout.write(notice("Agent Bootstrap", [state.message, `home ${state.home}`], "success"));
    return 0;
  }
  if (subcommand === "doctor") {
    const config = await loadAgentConfig(home);
    const store = await createMemoryStore(config, home);
    const status = store.status();
    process.stdout.write(notice("Agent Doctor", [
      `home ${home}`,
      `memory backend ${status.backend}`,
      `sqlite-vec loaded ${status.vectorEnabled ? "yes" : "no"}`,
      `store ${status.path}`,
      ...(status.warning ? [status.warning] : []),
    ], status.warning ? "warn" : "success"));
    return 0;
  }
  if (subcommand === "dream") {
    const phase = args.positionals[1] ?? "deep";
    const config = await loadAgentConfig(home);
    const result = await withConsolidationLock(context.mind.memoryFile, async () =>
      phase === "rem"
        ? runRemDream({ home, config })
        : runDeepDream({ home, workspace: context.workspace, config }));
    if (!result) {
      process.stdout.write(notice("Agent Dream", ["skipped — another Ares process holds the consolidation lock"], "warn"));
      return 0;
    }
    process.stdout.write(notice("Agent Dream", [result.report], "success"));
    return 0;
  }
  if (subcommand === "snapshot") {
    const snap = await snapshotBrain({ home, id: args.flags.get("id") });
    if (!snap) {
      process.stdout.write(notice("Agent Snapshot", ["No brain files yet — bootstrap first."], "warn"));
      return 0;
    }
    process.stdout.write(notice("Agent Snapshot", [
      `id ${snap.id}`,
      `dir ${snap.dir}`,
      `${snap.files.length} file(s) / ${snap.totalBytes} bytes`,
    ], "success"));
    return 0;
  }
  if (subcommand === "snapshots") {
    const list = await listSnapshots(home);
    if (list.length === 0) {
      process.stdout.write(notice("Agent Snapshots", ["No snapshots yet."], "warn"));
      return 0;
    }
    process.stdout.write(notice("Agent Snapshots", list.slice(0, 20).map((s) =>
      `${s.id}  ${s.createdAt}  ${s.files.length} files / ${s.totalBytes}b`,
    ), "info"));
    return 0;
  }
  if (subcommand === "restore") {
    const id = args.positionals[1] ?? args.flags.get("id");
    if (!id) {
      process.stderr.write("error: ares agent restore <snapshot-id>\n");
      return 2;
    }
    const result = await restoreSnapshot({ home, id });
    process.stdout.write(notice("Agent Restore", [
      `restored ${result.restored.length} file(s) to ${result.dest}`,
      ...result.restored.map((f) => `  ${f}`),
    ], "success"));
    return 0;
  }
  if (subcommand === "backup") {
    const dest = args.flags.get("dest") ?? args.positionals[1] ?? path.join(context.workspace, `ares-agent-backup-${Date.now()}.json`);
    const result = await exportHome({ home, dest });
    process.stdout.write(notice("Agent Backup", [
      `wrote ${result.files} file(s) / ${result.bytes} bytes`,
      `→ ${result.dest}`,
    ], "success"));
    return 0;
  }
  if (subcommand === "import") {
    const source = args.flags.get("source") ?? args.positionals[1];
    if (!source) {
      process.stderr.write("error: ares agent import <backup.json> [--overwrite]\n");
      return 2;
    }
    const overwrite = args.flags.get("overwrite") === "true" || args.flags.has("overwrite");
    const result = await importHome({ home, source, overwrite });
    process.stdout.write(notice("Agent Import", [
      `wrote ${result.files} file(s); skipped ${result.skipped} (already present)`,
      overwrite ? "overwrite mode: on" : "overwrite mode: off (pass --overwrite to replace existing files)",
    ], "success"));
    return 0;
  }
  process.stderr.write("error: usage: ares agent <bootstrap|doctor|dream|snapshot|snapshots|restore|backup|import>\n");
  return 2;
}

/**
 * C6 — `ares eval coding`: run the coding gauntlet against the selected
 * provider/model with the REAL tool harness, persist the report under
 * ~/.ares/gauntlet/, and print the scoreboard. The number every C-phase
 * change must move.
 */
function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trimEnd());
    });
  });
}

async function codingHarnessSourceIdentity(cwd: string): Promise<Record<string, unknown>> {
  try {
    const [revision, status, diff] = await Promise.all([
      gitOutput(cwd, ["rev-parse", "HEAD"]),
      gitOutput(cwd, ["status", "--porcelain=v1"]),
      gitOutput(cwd, ["diff", "--binary", "HEAD", "--"]),
    ]);
    const untracked = status.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
    const untrackedDigest = createHash("sha256");
    for (const relative of untracked.sort()) {
      const content = await readFile(path.resolve(cwd, relative)).catch(() => null);
      untrackedDigest.update(relative).update("\0");
      if (content) untrackedDigest.update(content);
      untrackedDigest.update("\0");
    }
    return {
      sourceRevision: revision,
      sourceDirty: status.length > 0,
      sourceFingerprint: createHash("sha256")
        .update(diff)
        .update("\0")
        .update(status)
        .update("\0")
        .update(untrackedDigest.digest("hex"))
        .digest("hex"),
    };
  } catch {
    return { sourceRevision: "unavailable", sourceDirty: null, sourceFingerprint: "unavailable" };
  }
}

async function gauntletCommand(args: ParsedArgs): Promise<number> {
  const selection = await selectProvider(args.flags);
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const runtime: AresRuntimeState = { permissionMode: "workspace-write" };
  const isolatedHomes: string[] = [];
  const evalShellRegistries: ShellRegistry[] = [];
  const suite = args.flags.get("suite") ?? "coding-v2";
  if (suite !== "coding-v1" && suite !== "coding-v2") {
    process.stderr.write("error: --suite must be coding-v1 or coding-v2\n");
    return 2;
  }
  const isMockProvider = selection.provider.name === "mock" || selection.provider.name.startsWith("mock-");
  // Host-process execution is the DEFAULT on this box (owner's call — it's a
  // personal machine). --require-isolated-eval (or ARES_REQUIRE_ISOLATED_EVAL=1)
  // restores the hard VM/container gate for cautious runs.
  const requireIsolation = args.flags.has("require-isolated-eval") || process.env.ARES_REQUIRE_ISOLATED_EVAL === "1";
  const allowUnsafeProcessEval = !requireIsolation ||
    args.flags.has("allow-unsafe-process-eval") || process.env.ARES_ALLOW_UNSAFE_PROCESS_EVAL === "1";
  if (!isMockProvider && !allowUnsafeProcessEval) {
    process.stderr.write(
      "error: isolation required: real-model coding eval executes candidate code in host processes. " +
      "Run inside a disposable VM/container, then pass --allow-unsafe-process-eval (or ARES_ALLOW_UNSAFE_PROCESS_EVAL=1).\n",
    );
    return 2;
  }
  if (!isMockProvider && !requireIsolation) {
    process.stderr.write("note: eval executes candidate code in host processes (no OS sandbox). --require-isolated-eval restores the gate.\n");
  }
  const sourceIdentity = await codingHarnessSourceIdentity(process.cwd());

  const report = await runGauntlet({
    provider: selection.provider,
    model: selection.model,
    keepWorkspaces: args.flags.has("keep"),
    suite,
    tasks: suite === "coding-v2" ? CODING_GAUNTLET_V2 : CODING_GAUNTLET,
    harness: args.flags.get("harness") !== "false" && !args.flags.has("no-harness"),
    harnessManifest: {
      ...sourceIdentity,
      aresVersion: await cliVersion(),
      providerSource: selection.source,
      subModel: selection.subModel ?? null,
      reasoning: "provider/default",
      permissionMode: runtime.permissionMode,
    },
    systemPrompt: (workspace) => buildSystemPrompt("workspace-write", cliRuntimeContext({ workspace, home: context.home })),
    tools: async (workspace) => {
      // Fresh harness per workspace — gauntlet runs must not share shell or
      // todo state across tasks.
      const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "ares-coding-eval-home-"));
      isolatedHomes.push(isolatedHome);
      const isolatedContext = cliRuntimeContext({ workspace, home: isolatedHome });
      const [pathPermissions, commandPermissions] = await Promise.all([
        AresPathPermissionStore.load(isolatedContext),
        AresCommandPermissionStore.load(isolatedContext),
      ]);
      const shellRegistry = new ShellRegistry();
      evalShellRegistries.push(shellRegistry);
      const todoStore = new TodoStore();
      const tools = await buildCodingTools(pathPermissions, commandPermissions, selection, runtime, isolatedContext, shellRegistry, todoStore, new Map(), { shell: !isMockProvider && allowUnsafeProcessEval });
      return {
        tools,
        dispose: async () => {
          await shellRegistry.killAll().catch(() => 0);
          await rm(isolatedHome, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    },
  }).finally(async () => {
    await Promise.all(evalShellRegistries.map((registry) => registry.killAll().catch(() => 0)));
    await Promise.all(isolatedHomes.map((home) => rm(home, { recursive: true, force: true }).catch(() => undefined)));
  });

  // Persist: one report per run, plus an append-only scoreboard for trends.
  const dir = path.join(context.home, "gauntlet");
  await mkdir(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const reportFile = path.join(dir, `${stamp}-${report.model.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (report.complete) {
    await appendFile(
      path.join(dir, "scoreboard.jsonl"),
      JSON.stringify({ at: report.startedAt, schemaVersion: report.schemaVersion, suite: report.suite, harness: report.harness, official: report.official, isolation: report.isolation, complete: report.complete, taskManifestHash: report.taskManifestHash, systemPromptHash: report.systemPromptHash, startupReminderHash: report.startupReminderHash, toolSchemaHash: report.toolSchemaHash, toolNames: report.toolNames, environment: report.environment, harnessManifest: report.harnessManifest, provider: report.provider, model: report.model, total: report.total, usage: report.usage, metrics: report.metrics, tasks: report.tasks.map((t) => ({ id: t.id, score: t.score, workStatus: t.workStatus, usage: t.usage })) }) + "\n",
      "utf8",
    );
  }

  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.complete && report.total >= 1 ? 0 : 1;
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = report.tasks.map((t) => {
    const bar = t.probes.map((p) => (p.met ? "+" : "-")).join("");
    return `${t.score === 1 ? "ok  " : t.score > 0 ? "part" : "FAIL"} ${pct(t.score).padStart(4)} [${bar}] ${t.title}${t.error ? ` — ${compactLine(t.error, 80)}` : ""}`;
  });
  lines.push("", `TOTAL ${pct(report.total)} — ${report.model} via ${report.provider} (${Math.round(report.durationMs / 1000)}s)`);
  lines.push(`integrity ${pct(report.metrics.integrityRate)} · verified ${pct(report.metrics.verifiedTaskRate)} · false-green ${pct(report.metrics.falseGreenRate)} · verified-mismatch ${pct(report.metrics.verifiedMismatchRate)}`);
  if (!report.complete) lines.push("INCOMPLETE — excluded from trend history");
  lines.push(`report: ${reportFile}`);
  process.stdout.write(notice(`Gauntlet · ${report.suite}`, lines, report.total >= 0.75 ? "success" : "warn"));
  return report.complete && report.total >= 1 ? 0 : 1;
}

export async function evalCommand(args: ParsedArgs): Promise<number> {
  if (args.positionals[0] === "coding") return gauntletCommand(args);
  const root = await mkdtemp(path.join(os.tmpdir(), "ares-eval-"));
  const tasks = builtInEvalTasks();
  let report: EvalReport;
  try {
    report = await runEvalSuite(tasks, { suite: "ares builtin", workspace: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.failed > 0 ? 1 : 0;
  }

  process.stdout.write(`ares eval: ${report.total} task(s)\n`);
  for (const result of report.results) {
    const prefix = result.status === "passed" ? "ok  " : "fail";
    process.stdout.write(`${prefix} ${result.name}${result.error ? `: ${result.error}` : ""}\n`);
  }
  if (report.failed > 0) {
    process.stdout.write(`\n${report.failed}/${report.total} eval task(s) failed. score=${report.score}\n`);
    return 1;
  }
  process.stdout.write(`\n${report.passed}/${report.total} eval task(s) passed. score=${report.score}\n`);
  return 0;
}

function builtInEvalTasks(): EvalTask[] {
  return [
    {
      id: "tool-read-numbered-content",
      name: "Read returns numbered content",
      category: "tools",
      async run({ workspace }) {
        await writeEvalFile(workspace, "src/a.ts", "export const a = 1;\n");
        const result = await ReadTool.call({ file_path: "src/a.ts" }, evalToolCtx(workspace));
        assertEval(result.output.content.includes("1\texport const a = 1;"), "missing numbered line");
        return { evidence: ["Read returned numbered source content."] };
      },
    },
    {
      id: "tool-glob-typescript",
      name: "Glob finds TypeScript files",
      category: "tools",
      async run({ workspace }) {
        await writeEvalFile(workspace, "src/b.ts", "export const b = 2;\n");
        const result = await GlobTool.call({ pattern: "src/*.ts", max_results: 50 }, evalToolCtx(workspace));
        assertEval(result.output.matches.some((m) => m.path.endsWith("b.ts")), "b.ts not matched");
        return { evidence: ["Glob matched the TypeScript fixture."] };
      },
    },
    {
      id: "tool-grep-regex",
      name: "Grep finds regex matches",
      category: "tools",
      async run({ workspace }) {
        await writeEvalFile(workspace, "src/c.ts", "function target() {}\n");
        const result = await GrepTool.call({
          pattern: "target",
          path: "src",
          output_mode: "content",
          max_results: 50,
          case_insensitive: false,
          context_before: 0,
          context_after: 0,
        }, evalToolCtx(workspace));
        assertEval(result.output.totalMatches >= 1, "target not found");
        return { evidence: ["Grep found the target fixture."] };
      },
    },
    {
      id: "tool-write-create",
      name: "Write creates files",
      category: "tools",
      async run({ workspace }) {
        const result = await WriteTool.call({ file_path: "src/write.txt", content: "created\n" }, evalToolCtx(workspace));
        assertEval(result.output.created === true, "file was not created");
        return { evidence: ["Write created a new workspace file."] };
      },
    },
    {
      id: "tool-edit-after-read",
      name: "Edit updates previously read files",
      category: "tools",
      async run({ workspace }) {
        const ctx = evalToolCtx(workspace);
        await writeEvalFile(workspace, "src/edit.txt", "old\n");
        await ReadTool.call({ file_path: "src/edit.txt" }, ctx);
        await EditTool.call({ file_path: "src/edit.txt", old_string: "old", new_string: "new", replace_all: false }, ctx);
        assertEval((await readFile(path.join(workspace, "src", "edit.txt"), "utf8")) === "new\n", "edit failed");
        return { evidence: ["Edit updated a previously read file."] };
      },
    },
    {
      id: "tool-apply-intent-full-file",
      name: "ApplyIntent materializes full-file sketches",
      category: "tools",
      async run({ workspace }) {
        const ctx = evalToolCtx(workspace);
        await writeEvalFile(workspace, "src/apply.ts", "export const value = 1;\n");
        await ReadTool.call({ file_path: "src/apply.ts" }, ctx);
        await ApplyIntentTool.call({ file_path: "src/apply.ts", instructions: "change value", sketch: "export const value = 2;\n" }, ctx);
        assertEval((await readFile(path.join(workspace, "src", "apply.ts"), "utf8")).includes("2"), "apply failed");
        return { evidence: ["ApplyIntent materialized a full-file sketch."] };
      },
    },
    {
      id: "workspace-checkpoint-restore",
      name: "Checkpoints restore workspace state",
      category: "workspace",
      async run({ workspace }) {
        await writeEvalFile(workspace, "src/check.txt", "before\n");
        const checkpoint = await createWorkspaceCheckpoint({ workspace, sessionId: "eval", turnSeq: 1 });
        await writeEvalFile(workspace, "src/check.txt", "after\n");
        await restoreWorkspaceCheckpoint(workspace, checkpoint.id);
        assertEval((await readFile(path.join(workspace, "src", "check.txt"), "utf8")) === "before\n", "restore failed");
        return { evidence: ["Checkpoint restored the original file state."] };
      },
    },
    {
      id: "memory-add-search",
      name: "Memory add and search persist facts",
      category: "memory",
      async run({ workspace }) {
        const ctx = evalToolCtx(workspace);
        await MemoryTool.call({ action: "add", scope: "project", category: "Preferences", content: "Use pnpm for scripts.", tags: ["tooling"], limit: 20 }, ctx);
        const found = await MemoryTool.call({ action: "search", scope: "project", category: "General", query: "pnpm", tags: [], limit: 20 }, ctx);
        assertEval(found.output.items.length === 1, "memory search missed item");
        return { evidence: ["Project memory recalled the persisted preference."] };
      },
    },
    {
      id: "startup-ares-md",
      name: "Startup context loads ARES.md",
      category: "startup",
      async run({ workspace }) {
        await writeEvalFile(workspace, "ARES.md", "Project rule: use tabs.\n");
        const reminders = await loadStartupReminders(workspace);
        assertEval(reminders.some((r) => r.source === "instructions" && r.text.includes("use tabs")), "ARES.md not loaded");
        return { evidence: ["Startup reminders included ARES.md instructions."] };
      },
    },
    {
      id: "prompt-cache-stable",
      name: "Prompt cache key is stable",
      category: "providers",
      async run() {
        const req = { system: "same", tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }] };
        assertEval(buildPromptCacheKey(req).key === buildPromptCacheKey(req).key, "cache key unstable");
        return { evidence: ["Prompt cache key was stable across identical requests."] };
      },
    },
  ];
}

function evalToolCtx(workspace: string): RichToolContext {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map<string, FileReadStamp>(),
  };
}

async function writeEvalFile(workspace: string, rel: string, content: string): Promise<void> {
  const file = path.join(workspace, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

function assertEval(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const MODEL_TASK_KINDS = ["chat", "code", "planning", "summarization", "memory", "review", "vision", "workshop", "tool-output-summary"];

function modelTaskFromFlags(flags: Map<string, string>): ModelTask {
  const rawKind = (flags.get("task") ?? "chat").trim();
  const kind = (MODEL_TASK_KINDS.includes(rawKind) ? rawKind : "chat") as ModelTaskKind;
  const task: ModelTask = { kind };
  const pick = <T extends string>(name: string, allowed: readonly string[]): T | undefined => {
    const v = flags.get(name)?.trim();
    return v && allowed.includes(v) ? (v as T) : undefined;
  };
  task.risk = pick<RiskLevel>("risk", ["low", "medium", "high"]);
  task.privacy = pick<PrivacyPosture>("privacy", ["local-required", "local-preferred", "cloud-ok", "cloud-required"]);
  task.quality = pick<QualityNeed>("quality", ["fast", "balanced", "best"]);
  task.cost = pick<CostPreference>("cost", ["cheap", "balanced", "premium-ok"]);
  task.latency = pick<LatencyPreference>("latency", ["low", "normal", "patient"]);
  const ctx = Number(flags.get("context"));
  if (Number.isFinite(ctx) && ctx > 0) task.contextTokens = ctx;
  const touches = flags.get("touches");
  if (touches) task.touches = touches.split(",").map((s) => s.trim()).filter(Boolean) as ModelTouch[];
  return task;
}

function routeDecisionLines(d: ModelRouteDecision): string[] {
  const lines: string[] = [];
  lines.push(`task: ${d.task.kind} · risk ${d.task.risk} · privacy ${d.task.privacy} · quality ${d.task.quality} · cost ${d.task.cost} · latency ${d.task.latency}`);
  if (d.selected) {
    lines.push("", `→ ${d.selected.family} (${d.selected.locality})${d.selected.modelClass ? ` · ${d.selected.modelClass}` : ""}`);
    if (d.fallback) lines.push(`  fallback: ${d.fallback.family} (${d.fallback.locality})`);
    lines.push(`  confidence ${Math.round(d.confidence * 100)}% · ${d.executable ? "executable" : "advisory only"}`);
  } else {
    lines.push("", "→ no route available for these constraints");
  }
  if (d.reasons.length) {
    lines.push("", "why:");
    for (const r of d.reasons) lines.push(`  - ${r}`);
  }
  if (d.warnings.length) {
    lines.push("", "warnings:");
    for (const w of d.warnings) lines.push(`  ! ${w}`);
  }
  return lines;
}

export async function modelsCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "route";
  if (sub !== "route") {
    process.stderr.write(
      `unknown models subcommand: ${sub}\n` +
        "usage: ares models route --task <kind> [--risk low|medium|high] [--privacy local-preferred|cloud-ok|…] [--quality fast|balanced|best] [--cost cheap|balanced|premium-ok] [--latency low|normal|patient] [--context N] [--touches a,b] [--json]\n",
    );
    return 2;
  }
  try {
    const decision = routeModel(modelTaskFromFlags(args.flags), { profiles: DEFAULT_PROVIDER_PROFILES });
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Model Route", routeDecisionLines(decision), decision.warnings.length ? "warn" : "info"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

function lessonLine(card: LearningCard): string {
  return `[${card.result}] ${compactLine(card.intent, 80)} · ${Math.round(card.confidence * 100)}% · ${card.id}`;
}

function learningCardLines(card: LearningCard, memoryWritten?: boolean): string[] {
  const lines: string[] = [
    `result: ${card.result}  ·  confidence ${Math.round(card.confidence * 100)}%`,
    `mission: ${compactLine(card.intent, 120)}`,
  ];
  if (card.goalStatement) lines.push(`goal: ${compactLine(card.goalStatement, 120)}`);
  if (card.whatWorked.length) {
    lines.push("", "what worked:");
    for (const w of card.whatWorked) lines.push(`  + ${compactLine(w, 120)}`);
  }
  if (card.whatFailed.length) {
    lines.push("", "what failed:");
    for (const f of card.whatFailed) lines.push(`  - ${compactLine(f, 120)}`);
  }
  if (card.reusableProcedure.length) {
    lines.push("", "reusable procedure:");
    card.reusableProcedure.forEach((p, i) => lines.push(`  ${i + 1}. ${compactLine(p, 120)}`));
  }
  if (card.tags.length) lines.push("", `tags: ${card.tags.join(", ")}`);
  if (memoryWritten !== undefined) {
    lines.push("", memoryWritten ? "✓ recorded into living memory" : "· already in living memory");
  }
  return lines;
}

export async function missionCommand(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext();
  const subcommand = (args.positionals[0] ?? "").toLowerCase();
  try {
    if (subcommand === "learn") {
      const contractId = args.positionals[1] ?? args.flags.get("contract");
      if (!contractId) {
        process.stderr.write("error: usage: ares mission learn <contractId>\n");
        return 2;
      }
      const contract = await loadMissionContract(context.home, contractId);
      if (!contract) {
        process.stderr.write(`error: mission contract not found: ${contractId}\n`);
        return 2;
      }
      const goal = contract.goalId ? (await loadGoal(context.home, contract.goalId)) ?? undefined : undefined;
      const card = distillMissionCard(contract, { goal });
      await saveLearningCard(context.home, card);
      // Feed the lesson into living memory exactly once (best-effort).
      let memoryWritten = false;
      try {
        const store = await MemoryStore.open(context.mind.memoryFile);
        memoryWritten = await recordCardMemoryOnce(store, {
          id: card.id,
          summary: learningCardMemoryText(card),
          tags: card.tags,
        });
      } catch {
        // memory feed is optional — the card itself is the durable record
      }
      if (args.flags.has("json")) {
        process.stdout.write(JSON.stringify({ ...card, memoryWritten }, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(notice(`Lesson ${card.id}`, learningCardLines(card, memoryWritten), card.result === "success" ? "success" : "warn"));
      return 0;
    }
    if (subcommand === "lessons") {
      const cards = await listLearningCards(context.home);
      if (args.flags.has("json")) {
        process.stdout.write(JSON.stringify(cards, null, 2) + "\n");
        return 0;
      }
      if (cards.length === 0) {
        process.stdout.write(notice("Lessons", ["No learning cards yet. Distill one: ares mission learn <contractId>"], "warn"));
        return 0;
      }
      process.stdout.write(notice(`Lessons · ${cards.length}`, cards.map(lessonLine), "info"));
      return 0;
    }
    if (subcommand === "lesson") {
      const id = args.positionals[1];
      if (!id) {
        process.stderr.write("error: usage: ares mission lesson <id>\n");
        return 2;
      }
      const card = (await loadLearningCard(context.home, id)) ?? (await loadLearningCard(context.home, learningCardId(id)));
      if (!card) {
        process.stderr.write(`error: lesson not found: ${id}\n`);
        return 2;
      }
      if (args.flags.has("json")) {
        process.stdout.write(JSON.stringify(card, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(notice(`Lesson ${card.id}`, learningCardLines(card), card.result === "success" ? "success" : "warn"));
      return 0;
    }
    process.stderr.write("error: usage: ares mission <learn <contractId> | lessons | lesson <id>>\n");
    return 2;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}
