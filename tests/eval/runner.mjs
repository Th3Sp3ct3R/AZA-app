// Ares coding-agent eval harness — the SHIPPED, committed scoreboard.
//
// This is the real, runnable complement to the ephemeral `ares gauntlet`
// command. The benchmark tasks live in the repo (tests/eval/tasks/*.json) and
// this runner drives the REAL QueryEngine loop against each one, grades the
// resulting workspace with REAL probes (running node, comparing file bytes),
// and prints a scoreboard: per-task pass/fail, overall success rate, token
// usage, and wall-clock timings.
//
// Two modes:
//   --provider mock   (default) — a deterministic scripted provider that
//                     produces the correct solution for each known task by
//                     driving the same Write/Edit tools a real agent would.
//                     This exercises the full engine + tool + GRADING path
//                     with no network. It validates the HARNESS, not agent
//                     skill (see README.md — a solved-by-construction mock
//                     scores ~100% by design).
//   --provider anthropic|openai|...  — plugs a real model into the same
//                     `runAgentOnTask` seam. THIS is what produces real
//                     quality numbers.
//
// Usage:
//   node tests/eval/runner.mjs                      # mock mode, all tasks
//   node tests/eval/runner.mjs --provider anthropic # real model
//   node tests/eval/runner.mjs --task fix-off-by-one # single task
//   node tests/eval/runner.mjs --json              # machine-readable output
//
// Exit code: 0 if every task passed, 1 otherwise (CI-friendly). The test
// harness (tests/eval-harness.test.mjs) imports runEval() directly instead.

import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { QueryEngine } from "../../packages/core/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(__dirname, "tasks");

// ---------------------------------------------------------------------------
// Task loading
// ---------------------------------------------------------------------------

/** Load and validate every task spec from tests/eval/tasks/. */
export async function loadTasks() {
  const files = (await readdir(TASKS_DIR)).filter((f) => f.endsWith(".json")).sort();
  const tasks = [];
  for (const file of files) {
    const raw = await readFile(path.join(TASKS_DIR, file), "utf8");
    let spec;
    try {
      spec = JSON.parse(raw);
    } catch (e) {
      throw new Error(`task ${file} is not valid JSON: ${e.message}`);
    }
    validateTask(spec, file);
    tasks.push(spec);
  }
  return tasks;
}

function validateTask(spec, file) {
  if (!spec.id) throw new Error(`task ${file} missing id`);
  if (!spec.prompt) throw new Error(`task ${spec.id} missing prompt`);
  if (!spec.grade || !spec.grade.type) throw new Error(`task ${spec.id} missing grade.type`);
  const gt = spec.grade.type;
  if (!["fileContains", "fileEquals", "command"].includes(gt)) {
    throw new Error(`task ${spec.id} has unknown grade.type: ${gt}`);
  }
  if ((gt === "fileContains" || gt === "fileEquals") && (!spec.grade.path || spec.grade.value === undefined)) {
    throw new Error(`task ${spec.id} grade ${gt} requires path + value`);
  }
  if (gt === "command" && !spec.grade.command) {
    throw new Error(`task ${spec.id} grade command requires a command`);
  }
}

// ---------------------------------------------------------------------------
// Grading — REAL probes against the produced workspace.
// ---------------------------------------------------------------------------

/**
 * Grade a workspace against a task's spec. Returns { passed, detail }.
 * This logic is deterministic and does not touch any model — it is the part
 * of the harness that must be trustworthy regardless of provider.
 */
export function gradeTask(task, workspace) {
  const grade = task.grade;
  try {
    if (grade.type === "fileContains") {
      const target = path.join(workspace, grade.path);
      if (!existsSync(target)) return { passed: false, detail: `file not found: ${grade.path}` };
      const content = readFileSync(target, "utf8");
      const ok = content.includes(grade.value);
      return { passed: ok, detail: ok ? "contains marker" : `missing marker: ${JSON.stringify(grade.value)}` };
    }
    if (grade.type === "fileEquals") {
      const target = path.join(workspace, grade.path);
      if (!existsSync(target)) return { passed: false, detail: `file not found: ${grade.path}` };
      const content = readFileSync(target, "utf8");
      const ok = content === grade.value;
      return { passed: ok, detail: ok ? "exact match" : "content differs from expected" };
    }
    if (grade.type === "command") {
      // `shell: true` uses the platform default shell but preserves the
      // command's own quoting (node -e "..." with ! and nested quotes survives
      // on both cmd.exe and POSIX sh — verified on Windows).
      const proc = spawnSync(grade.command, {
        cwd: workspace,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        shell: true,
      });
      const ok = proc.status === 0;
      const detail = ok
        ? "command exited 0"
        : `command exited ${proc.status}: ${(proc.stderr || proc.stdout || "").trim().split("\n").slice(-3).join(" | ")}`;
      return { passed: ok, detail };
    }
    return { passed: false, detail: `unknown grade type ${grade.type}` };
  } catch (e) {
    return { passed: false, detail: `grader error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Workspace seeding
// ---------------------------------------------------------------------------

export async function seedWorkspace(task) {
  const ws = await mkdtemp(path.join(tmpdir(), `ares-eval-${task.id}-`));
  for (const [rel, content] of Object.entries(task.seedFiles || {})) {
    const target = path.join(ws, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return ws;
}

// ---------------------------------------------------------------------------
// Tools — self-contained Write / Edit that a real agent (or the scripted
// mock) drives. Mirrors the shape @ares/tools ships, but with no permission
// or workspace-service dependencies so the harness stays self-contained.
// ---------------------------------------------------------------------------

function evalTools(workspace) {
  const write = {
    schema: {
      name: "Write",
      description: "Create or overwrite a file with the given content.",
      inputJsonSchema: {
        type: "object",
        properties: { file_path: { type: "string" }, content: { type: "string" } },
        required: ["file_path", "content"],
      },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call(input) {
      const target = path.resolve(workspace, input.file_path);
      if (!target.startsWith(path.resolve(workspace))) throw new Error("path escapes workspace");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, input.content ?? "", "utf8");
      return { output: `wrote ${input.file_path}`, touchedFiles: [input.file_path] };
    },
  };
  const edit = {
    schema: {
      name: "Edit",
      description: "Replace an exact string in a file with a new string.",
      inputJsonSchema: {
        type: "object",
        properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        required: ["file_path", "old_string", "new_string"],
      },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call(input) {
      const target = path.resolve(workspace, input.file_path);
      if (!target.startsWith(path.resolve(workspace))) throw new Error("path escapes workspace");
      const current = readFileSync(target, "utf8");
      if (!current.includes(input.old_string)) throw new Error(`old_string not found in ${input.file_path}`);
      const next = current.replace(input.old_string, input.new_string);
      await writeFile(target, next, "utf8");
      return { output: `edited ${input.file_path}`, touchedFiles: [input.file_path] };
    },
  };
  return [write, edit];
}

// ---------------------------------------------------------------------------
// The pluggable agent seam. A real provider gets driven here through the same
// engine loop the product uses. `runAgentOnTask(task, provider, ...)` is the
// ONE seam you swap to benchmark a real model.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are Ares, an expert coding agent. Complete the user's coding task by writing files with the Write tool " +
  "and modifying files with the Edit tool. Make the smallest correct change. When finished, stop.";

/**
 * Drive the REAL QueryEngine loop for one task against `provider`, returning
 * usage + tool-call stats. Works identically for the scripted mock provider
 * and any real Provider implementation.
 */
export async function runAgentOnTask(task, provider, { model = "eval", workspace, maxTurns = 6, systemPrompt = SYSTEM_PROMPT }) {
  const engine = QueryEngine.forTesting(
    {
      provider,
      model,
      systemPrompt,
      tools: evalTools(workspace),
      workspace,
      maxTurns,
    },
    `sess_eval_${task.id}`,
  );

  engine.appendUserMessage(task.prompt);

  let toolCalls = 0;
  let toolErrors = 0;
  let stalls = 0;
  let lastUsage = { inputTokens: 0, outputTokens: 0 };
  let error = null;
  try {
    for await (const event of engine.streamTurn()) {
      if (event.type === "tool_end") toolCalls += 1;
      if (event.type === "tool_error") toolErrors += 1;
      if (event.type === "error") {
        if (event.error?.code === "stream_stall" || event.error?.code === "reasoning_stall") stalls += 1;
        else error = `${event.error?.code ?? "provider_error"}: ${event.error?.message ?? ""}`.slice(0, 200);
      }
      if (event.type === "turn_end" && event.usage) lastUsage = event.usage;
    }
  } catch (e) {
    error = e.message;
  }
  return {
    toolCalls,
    toolErrors,
    stalls,
    inputTokens: lastUsage.inputTokens ?? 0,
    outputTokens: lastUsage.outputTokens ?? 0,
    cacheReadTokens: lastUsage.cacheReadTokens ?? 0,
    error,
  };
}

// ---------------------------------------------------------------------------
// Scripted mock provider — deterministic, no network. It reads the pending
// tool-result state to decide whether to act (first turn) or stop (after the
// tool ran), exactly like a well-behaved real agent. The per-task solutions
// live in SOLUTIONS; a task with no scripted solution is emitted as a no-op so
// it deterministically FAILS grading (proving the scoreboard reports failures,
// not just successes).
// ---------------------------------------------------------------------------

const SOLUTIONS = {
  "implement-pure-function": [
    {
      name: "Write",
      input: {
        file_path: "slugify.mjs",
        content:
          "export function slugify(text) {\n" +
          "  return String(text)\n" +
          "    .toLowerCase()\n" +
          "    .replace(/[^a-z0-9]+/g, '-')\n" +
          "    .replace(/^-+|-+$/g, '');\n" +
          "}\n",
      },
    },
  ],
  "fix-off-by-one": [
    { name: "Edit", input: { file_path: "range.mjs", old_string: "i < end", new_string: "i <= end" } },
  ],
  "add-input-validation": [
    {
      name: "Edit",
      input: {
        file_path: "divide.mjs",
        old_string: "  return a / b;",
        new_string: "  if (b === 0) throw new Error('divide by zero');\n  return a / b;",
      },
    },
  ],
  "refactor-extract-helper": [
    {
      name: "Write",
      input: {
        file_path: "stats.mjs",
        content:
          "export function sum(nums) {\n" +
          "  let total = 0;\n" +
          "  for (const n of nums) total += n;\n" +
          "  return total;\n" +
          "}\n\n" +
          "export function mean(nums) {\n" +
          "  return sum(nums) / nums.length;\n" +
          "}\n\n" +
          "export function variance(nums) {\n" +
          "  const m = mean(nums);\n" +
          "  return sum(nums.map((n) => (n - m) ** 2)) / nums.length;\n" +
          "}\n",
      },
    },
  ],
  "make-failing-test-pass": [
    {
      name: "Write",
      input: {
        file_path: "fizzbuzz.mjs",
        content:
          "export function fizzbuzz(n) {\n" +
          "  if (n % 15 === 0) return 'FizzBuzz';\n" +
          "  if (n % 3 === 0) return 'Fizz';\n" +
          "  if (n % 5 === 0) return 'Buzz';\n" +
          "  return String(n);\n" +
          "}\n",
      },
    },
  ],
  "parse-query-string": [
    {
      name: "Write",
      input: {
        file_path: "qs.mjs",
        content:
          "export function parseQuery(str) {\n" +
          "  const out = {};\n" +
          "  if (!str) return out;\n" +
          "  for (const pair of str.split('&')) {\n" +
          "    if (!pair) continue;\n" +
          "    const eq = pair.indexOf('=');\n" +
          "    if (eq === -1) {\n" +
          "      out[decodeURIComponent(pair)] = '';\n" +
          "    } else {\n" +
          "      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));\n" +
          "    }\n" +
          "  }\n" +
          "  return out;\n" +
          "}\n",
      },
    },
  ],
  "fix-async-race": [
    {
      name: "Write",
      input: {
        file_path: "fetchAll.mjs",
        content:
          "export async function fetchAll(ids, fetchOne) {\n" +
          "  return Promise.all(ids.map((id) => fetchOne(id)));\n" +
          "}\n",
      },
    },
  ],
  "implement-debounce": [
    {
      name: "Write",
      input: {
        file_path: "debounce.mjs",
        content:
          "export function debounce(fn, waitMs) {\n" +
          "  let timer;\n" +
          "  return function (...args) {\n" +
          "    clearTimeout(timer);\n" +
          "    timer = setTimeout(() => fn.apply(this, args), waitMs);\n" +
          "  };\n" +
          "}\n",
      },
    },
  ],
  "add-config-field": [
    { name: "Write", input: { file_path: "config.json", content: '{\n  "name": "demo",\n  "timeoutMs": 5000\n}\n' } },
    {
      name: "Write",
      input: {
        file_path: "getTimeout.mjs",
        content:
          "import { readFileSync } from 'node:fs';\n" +
          "import { fileURLToPath } from 'node:url';\n" +
          "import { dirname, join } from 'node:path';\n\n" +
          "export function getTimeout() {\n" +
          "  const here = dirname(fileURLToPath(import.meta.url));\n" +
          "  const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));\n" +
          "  return cfg.timeoutMs;\n" +
          "}\n",
      },
    },
  ],
  "write-license-header": [
    {
      name: "Edit",
      input: {
        file_path: "lib.mjs",
        old_string: "export const VERSION = '1.0.0';",
        new_string: "// SPDX-License-Identifier: MIT\nexport const VERSION = '1.0.0';",
      },
    },
  ],
  "write-exact-package-json": [
    {
      name: "Write",
      input: { file_path: "manifest.json", content: '{\n  "name": "widget",\n  "version": "0.1.0",\n  "type": "module"\n}\n' },
    },
  ],
  "implement-clamp": [
    {
      name: "Write",
      input: {
        file_path: "clamp.mjs",
        content:
          "export function clamp(value, min, max) {\n" +
          "  if (value < min) return min;\n" +
          "  if (value > max) return max;\n" +
          "  return value;\n" +
          "}\n",
      },
    },
  ],
};

/**
 * Build a scripted provider for one task. It emits the task's solution tool
 * calls on the first turn, then a plain "done" message once tool results have
 * come back. Drives the real engine loop end-to-end.
 */
export function makeScriptedProvider(task) {
  // Tasks may carry their own scripted solution (self-contained task files);
  // the legacy SOLUTIONS map covers the original suite.
  const steps = task.mockSolution ?? SOLUTIONS[task.id] ?? [];
  return {
    name: "scripted-mock",
    async *stream(req) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      const sawToolResult = lastUser?.content?.some((b) => b.type === "tool_result");
      if (!sawToolResult && steps.length > 0) {
        const content = steps.map((s, i) => ({ type: "tool_use", id: `tu_${i}`, name: s.name, input: s.input }));
        for (const block of content) {
          yield { type: "tool_use_start", id: block.id, name: block.name };
          yield { type: "tool_use_input_done", id: block.id, input: block.input };
        }
        yield {
          type: "message_done",
          message: { id: "m_act", role: "assistant", content, createdAt: new Date().toISOString() },
          usage: { inputTokens: 24, outputTokens: 12 * steps.length },
          stopReason: "tool_use",
        };
        return;
      }
      const text = steps.length > 0 ? "Done." : "I could not determine a solution.";
      yield { type: "text_delta", text };
      yield {
        type: "message_done",
        message: { id: "m_done", role: "assistant", content: [{ type: "text", text }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 8, outputTokens: text.length },
        stopReason: "end_turn",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Real-provider factory. Extend this to benchmark actual models. Kept minimal
// on purpose — the seam is `runAgentOnTask`, this just resolves a Provider.
// ---------------------------------------------------------------------------

async function resolveProvider(name, task) {
  if (name === "mock") return { provider: makeScriptedProvider(task), model: "scripted-mock" };

  const core = await import("../../packages/core/dist/index.js");
  if (name === "anthropic") {
    let key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      // Fall back to the key the owner saved in Ares settings (decrypted the
      // same way the product loads it) so `--provider anthropic` just works.
      try {
        const ui = await import("../../packages/cli/dist/uiSettings.js");
        key = (await ui.loadUiSettings()).anthropicKey || undefined;
      } catch {
        // settings unavailable — fall through to the explicit error
      }
    }
    if (!key) throw new Error("ANTHROPIC_API_KEY is required for --provider anthropic (or save a key in Ares settings)");
    const model = process.env.ARES_EVAL_MODEL || core.DEFAULT_ANTHROPIC_MODEL;
    return { provider: new core.AnthropicProvider({ apiKey: key }), model };
  }
  if (name === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is required for --provider openai");
    return { provider: new core.OpenAIResponsesProvider({ apiKey: key }), model: process.env.ARES_EVAL_MODEL || "gpt-4.1" };
  }
  if (name === "openrouter") {
    let key = process.env.OPENROUTER_API_KEY;
    let settingsModel;
    try {
      const ui = await import("../../packages/cli/dist/uiSettings.js");
      const settings = await ui.loadUiSettings();
      key = key || settings.openRouterKey || undefined;
      settingsModel = settings.lastOpenRouterModel;
    } catch {
      // settings unavailable — env only
    }
    if (!key) throw new Error("OPENROUTER_API_KEY is required for --provider openrouter (or save a key in Ares settings)");
    const model = process.env.ARES_EVAL_MODEL || settingsModel || "anthropic/claude-sonnet-4.5";
    return { provider: new core.OpenRouterProvider({ apiKey: key, model }), model };
  }
  throw new Error(`unknown provider '${name}'. Known: mock, anthropic, openai, openrouter`);
}

// ---------------------------------------------------------------------------
// The eval driver + scoreboard.
// ---------------------------------------------------------------------------

/**
 * Run the eval over `tasks`. Returns a structured scoreboard object.
 * `providerName` selects the model; for anything but "mock" a real key/network
 * is required.
 */
export async function runEval({ tasks, providerName = "mock", keepWorkspaces = false, systemPrompt } = {}) {
  const allTasks = tasks ?? (await loadTasks());
  const results = [];
  const suiteStart = Date.now();

  for (const task of allTasks) {
    const workspace = await seedWorkspace(task);
    const taskStart = Date.now();
    let run;
    try {
      const { provider, model } = await resolveProvider(providerName, task);
      run = await runAgentOnTask(task, provider, { model, workspace, ...(systemPrompt ? { systemPrompt } : {}) });
    } catch (e) {
      run = { toolCalls: 0, inputTokens: 0, outputTokens: 0, error: e.message };
    }
    const grade = gradeTask(task, workspace);
    const durationMs = Date.now() - taskStart;

    results.push({
      id: task.id,
      title: task.title || task.id,
      passed: grade.passed,
      detail: grade.detail,
      toolCalls: run.toolCalls,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      error: run.error,
      durationMs,
    });

    if (!keepWorkspaces) await rm(workspace, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const scoreboard = {
    schemaVersion: 1,
    suite: "coding-eval-v1",
    provider: providerName,
    taskCount: results.length,
    passed,
    failed: results.length - passed,
    successRate: results.length ? passed / results.length : 0,
    totalInputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
    totalOutputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
    totalDurationMs: Date.now() - suiteStart,
    tasks: results,
  };
  return scoreboard;
}

// ---------------------------------------------------------------------------
// Pretty-printer for CLI use.
// ---------------------------------------------------------------------------

export function formatScoreboard(board) {
  const lines = [];
  lines.push("");
  lines.push(`Ares Coding-Agent Eval — suite ${board.suite} — provider: ${board.provider}`);
  lines.push("=".repeat(72));
  const idW = Math.max(4, ...board.tasks.map((t) => t.id.length));
  lines.push(`${"TASK".padEnd(idW)}  RESULT  TOOLS   IN/OUT tok    TIME    DETAIL`);
  lines.push("-".repeat(72));
  for (const t of board.tasks) {
    const res = t.passed ? "PASS  " : "FAIL  ";
    const io = `${t.inputTokens}/${t.outputTokens}`.padEnd(11);
    const time = `${t.durationMs}ms`.padEnd(7);
    const detail = t.error ? `error: ${t.error}` : t.detail;
    lines.push(`${t.id.padEnd(idW)}  ${res}  ${String(t.toolCalls).padEnd(6)} ${io}  ${time} ${detail}`);
  }
  lines.push("-".repeat(72));
  const pct = (board.successRate * 100).toFixed(1);
  lines.push(`SUCCESS RATE: ${board.passed}/${board.taskCount} (${pct}%)`);
  lines.push(`TOKENS: ${board.totalInputTokens} in / ${board.totalOutputTokens} out`);
  lines.push(`WALL CLOCK: ${board.totalDurationMs}ms total`);
  lines.push("=".repeat(72));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entrypoint.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { provider: "mock", json: false, task: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") args.provider = argv[++i];
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node tests/eval/runner.mjs [--provider mock|anthropic|openai] [--task <id>] [--json]\n" +
        "  mock (default): deterministic, no network — validates the harness plumbing.\n" +
        "  anthropic/openai: real model — set ANTHROPIC_API_KEY / OPENAI_API_KEY and ARES_EVAL_MODEL.",
    );
    return;
  }
  let tasks = await loadTasks();
  if (args.task) {
    tasks = tasks.filter((t) => t.id === args.task);
    if (tasks.length === 0) {
      console.error(`no task with id '${args.task}'`);
      process.exit(2);
    }
  }
  const board = await runEval({ tasks, providerName: args.provider });
  if (args.json) console.log(JSON.stringify(board, null, 2));
  else console.log(formatScoreboard(board));
  process.exit(board.failed === 0 ? 0 : 1);
}

// Run as a script (not when imported by the test harness).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
