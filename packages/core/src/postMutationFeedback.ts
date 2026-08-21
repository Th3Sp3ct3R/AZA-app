// Bounded, hash-attributed feedback after coding mutations.
//
// This layer deliberately runs formatters in CHECK mode and language/build
// diagnostics in read-only modes. A formatter or type checker must never turn
// a successfully committed edit into an implicit rollback, nor may feedback be
// attributed to bytes that changed after the commit. Callers pass the hashes
// from the mutation receipt; every command is bracketed by fresh hash checks.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceMutationReceipt } from "./workspaceMutation.js";

export type PostMutationFeedbackKind = "format" | "diagnostics";
export type PostMutationFeedbackCheckStatus =
  | "passed"
  | "issues"
  | "timed_out"
  | "unavailable"
  | "failed"
  | "stale"
  | "skipped";

export interface PostMutationCommittedFile {
  path: string;
  /** SHA-256 of the committed bytes, or null when the commit deleted the path. */
  committedHash: string | null;
}

export interface PostMutationFeedbackFile {
  path: string;
  committedHash: string | null;
  observedHash: string | null;
  state: "exact" | "deleted" | "drifted" | "missing" | "unsupported";
}

export interface PostMutationFeedbackCheck {
  kind: PostMutationFeedbackKind;
  tool: string;
  cwd: string;
  command: string;
  args: string[];
  files: string[];
  /** Hashes that were revalidated immediately before and after this check. */
  committedHashes: Record<string, string>;
  status: PostMutationFeedbackCheckStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
  detail?: string;
}

export interface PostMutationFeedback {
  version: 1;
  workspace: string;
  status: "clean" | "issues" | "incomplete" | "stale" | "disabled" | "no_checks";
  startedAt: string;
  durationMs: number;
  files: PostMutationFeedbackFile[];
  checks: PostMutationFeedbackCheck[];
  detail?: string;
}

export interface PostMutationFeedbackOptions {
  enabled?: boolean;
  formatters?: boolean;
  diagnostics?: boolean;
  formatTimeoutMs?: number;
  diagnosticTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxFiles?: number;
  maxChecks?: number;
  maxOutputChars?: number;
  /** Known adapters only. This never enables arbitrary repository commands. */
  tools?: Partial<Record<KnownFeedbackTool, boolean>>;
}

type KnownFeedbackTool = "prettier" | "eslint" | "typescript" | "biome" | "ruff" | "rustfmt" | "cargo" | "gofmt" | "go";

interface FeedbackConfig {
  enabled: boolean;
  formatters: boolean;
  diagnostics: boolean;
  formatTimeoutMs: number;
  diagnosticTimeoutMs: number;
  totalTimeoutMs: number;
  maxFiles: number;
  maxChecks: number;
  maxOutputChars: number;
  tools: Partial<Record<KnownFeedbackTool, boolean>>;
}

interface CommandRunner {
  command: string;
  argsPrefix: string[];
  display: string;
}

interface DiscoveredCheck {
  kind: PostMutationFeedbackKind;
  tool: KnownFeedbackTool;
  cwd: string;
  runner: CommandRunner | null;
  args: string[];
  files: Array<{ path: string; committedHash: string }>;
  issuesOnOutput?: boolean;
  unavailableDetail?: string;
}

const DEFAULT_CONFIG: FeedbackConfig = {
  enabled: true,
  formatters: true,
  diagnostics: true,
  formatTimeoutMs: 4_000,
  diagnosticTimeoutMs: 12_000,
  totalTimeoutMs: 24_000,
  maxFiles: 40,
  maxChecks: 8,
  maxOutputChars: 16_000,
  tools: {},
};

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".mdx",
  ".yaml", ".yml", ".css", ".scss", ".less", ".html", ".graphql", ".vue", ".svelte",
  ".py", ".pyi", ".rs", ".go",
]);

const PRETTIER_CONFIGS = [
  ".prettierrc", ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml",
  ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts",
  "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts",
];
const ESLINT_CONFIGS = [
  "eslint.config.js", "eslint.config.cjs", "eslint.config.mjs", "eslint.config.ts",
  ".eslintrc", ".eslintrc.json", ".eslintrc.yaml", ".eslintrc.yml", ".eslintrc.js", ".eslintrc.cjs",
];
const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];

export class PostMutationFeedbackService {
  readonly workspace: string;

  constructor(workspace: string, private readonly options: PostMutationFeedbackOptions = {}) {
    this.workspace = path.resolve(workspace);
  }

  async inspect(committedFiles: readonly PostMutationCommittedFile[]): Promise<PostMutationFeedback> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const config = await loadConfig(this.workspace, this.options);
      const files = dedupeCommittedFiles(committedFiles).slice(0, config.maxFiles);
      const snapshots = await Promise.all(files.map((file) => inspectCommittedFile(file)));

      if (!config.enabled || process.env.ARES_POST_MUTATION_FEEDBACK === "0") {
        return result(this.workspace, "disabled", "Post-mutation feedback is disabled by configuration.", snapshots, [], startedAt, started);
      }

      const exact = snapshots
        .filter((file): file is PostMutationFeedbackFile & { committedHash: string } => file.state === "exact" && file.committedHash !== null)
        .filter((file) => TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase()));
      if (exact.length === 0) {
        const stale = snapshots.some((file) => file.state === "drifted" || file.state === "missing");
        return result(
          this.workspace,
          stale ? "stale" : "no_checks",
          stale ? "Committed bytes changed before feedback could be attributed." : "No supported committed text files require feedback.",
          snapshots,
          [],
          startedAt,
          started,
        );
      }

      const discovered = (await discoverChecks(this.workspace, exact, config)).slice(0, config.maxChecks);
      if (discovered.length === 0) {
        return result(this.workspace, "no_checks", "No explicitly configured formatter or diagnostic tool was discovered.", snapshots, [], startedAt, started);
      }

      const checks: PostMutationFeedbackCheck[] = [];
      let outputBudget = config.maxOutputChars;
      for (let index = 0; index < discovered.length; index++) {
        const check = discovered[index];
        const elapsed = Date.now() - started;
        const remaining = config.totalTimeoutMs - elapsed;
        if (remaining <= 0) {
          checks.push(skippedCheck(check, "The transaction feedback time budget was exhausted."));
          continue;
        }
        const requestedTimeout = check.kind === "format" ? config.formatTimeoutMs : config.diagnosticTimeoutMs;
        const outputLimit = Math.max(0, Math.min(4_000, outputBudget));
        const executed = await executeCheck(check, Math.min(requestedTimeout, remaining), outputLimit);
        outputBudget -= executed.output.length;
        checks.push(executed);
      }

      const currentSnapshots = await Promise.all(files.map((file) => inspectCommittedFile(file)));
      const status = feedbackStatus(checks, currentSnapshots);
      return result(this.workspace, status, undefined, currentSnapshots, checks, startedAt, started);
    } catch (error) {
      // Feedback is observational. A bug, malformed config, or missing binary
      // is model-visible but can never invalidate or roll back committed bytes.
      const files = await Promise.all(dedupeCommittedFiles(committedFiles).slice(0, DEFAULT_CONFIG.maxFiles).map((file) => inspectCommittedFile(file)))
        .catch(() => [] as PostMutationFeedbackFile[]);
      return result(this.workspace, "incomplete", `Feedback engine error: ${errorMessage(error)}`, files, [], startedAt, started);
    }
  }
}

export function committedFilesFromReceipt(receipt: WorkspaceMutationReceipt): PostMutationCommittedFile[] {
  const files: PostMutationCommittedFile[] = [];
  for (const operation of receipt.operations) {
    if (operation.kind === "add" || operation.kind === "update") {
      files.push({ path: operation.path, committedHash: operation.afterHash });
    } else if (operation.kind === "delete") {
      files.push({ path: operation.path, committedHash: null });
    } else {
      files.push({ path: operation.fromPath, committedHash: null });
      files.push({ path: operation.toPath, committedHash: operation.afterHash });
    }
  }
  return files;
}

export async function inspectPostMutationFeedback(
  workspace: string,
  committedFiles: readonly PostMutationCommittedFile[],
  options?: PostMutationFeedbackOptions,
): Promise<PostMutationFeedback> {
  return new PostMutationFeedbackService(workspace, options).inspect(committedFiles);
}

export function renderPostMutationFeedback(feedback: PostMutationFeedback): string {
  if (feedback.status === "disabled" || feedback.status === "no_checks") return "";
  const lines = [`Post-edit feedback (${feedback.status}; hash-attributed):`];
  for (const check of feedback.checks) {
    const mark = check.status === "passed" ? "PASS" : check.status.toUpperCase();
    lines.push(`- ${check.tool} ${check.kind}: ${mark} (${check.durationMs}ms)`);
    if (check.output) lines.push(indent(check.output, "  "));
    else if (check.detail) lines.push(`  ${check.detail}`);
  }
  if (feedback.checks.length === 0 && feedback.detail) lines.push(feedback.detail);
  return lines.join("\n");
}

async function discoverChecks(
  workspace: string,
  files: readonly (PostMutationFeedbackFile & { committedHash: string })[],
  config: FeedbackConfig,
): Promise<DiscoveredCheck[]> {
  const checks: DiscoveredCheck[] = [];
  const boundaries = new Map<string, string>();
  for (const file of files) boundaries.set(file.path, await discoveryBoundary(workspace, file.path));

  const biomeGroups = await groupByConfig(files, boundaries, BIOME_CONFIGS);
  const biomeFiles = new Set<string>();
  if (toolEnabled(config, "biome")) {
    for (const [configPath, group] of biomeGroups) {
      group.forEach((file) => biomeFiles.add(file.path));
      const cwd = path.dirname(configPath);
      const runner = await findNodePackageBin(cwd, boundaries.get(group[0].path)!, "@biomejs/biome", "biome");
      if (config.formatters) checks.push(commandCheck("format", "biome", cwd, runner, ["format", "--no-errors-on-unmatched", ...group.map((file) => file.path)], group));
      if (config.diagnostics) checks.push(commandCheck("diagnostics", "biome", cwd, runner, ["lint", "--no-errors-on-unmatched", ...group.map((file) => file.path)], group));
    }
  }

  if (config.formatters && toolEnabled(config, "prettier")) {
    const prettierGroups = await groupByConfig(files.filter((file) => !biomeFiles.has(file.path)), boundaries, PRETTIER_CONFIGS, "prettier");
    for (const [configPath, group] of prettierGroups) {
      const cwd = path.dirname(configPath);
      const runner = await findNodePackageBin(cwd, boundaries.get(group[0].path)!, "prettier", "prettier");
      const configArgs = path.basename(configPath) === "package.json" ? [] : ["--config", configPath];
      checks.push(commandCheck("format", "prettier", cwd, runner, ["--check", "--ignore-unknown", ...configArgs, ...group.map((file) => file.path)], group));
    }
  }

  if (config.diagnostics && toolEnabled(config, "eslint")) {
    const eslintFiles = files.filter((file) => /\.[cm]?[jt]sx?$/.test(path.extname(file.path).toLowerCase()) && !biomeFiles.has(file.path));
    const eslintGroups = await groupByConfig(eslintFiles, boundaries, ESLINT_CONFIGS, "eslintConfig");
    for (const [configPath, group] of eslintGroups) {
      const cwd = path.dirname(configPath);
      const runner = await findNodePackageBin(cwd, boundaries.get(group[0].path)!, "eslint", "eslint");
      checks.push(commandCheck("diagnostics", "eslint", cwd, runner, ["--format", "stylish", "--no-color", ...group.map((file) => file.path)], group));
    }
  }

  if (config.diagnostics && toolEnabled(config, "typescript")) {
    const tsFiles = files.filter((file) => /\.[cm]?[jt]sx?$/.test(path.extname(file.path).toLowerCase()));
    const tsGroups = await groupByConfig(tsFiles, boundaries, ["tsconfig.json", "jsconfig.json"]);
    for (const [configPath, group] of tsGroups) {
      const cwd = path.dirname(configPath);
      const runner = await findNodePackageBin(cwd, boundaries.get(group[0].path)!, "typescript", "tsc");
      checks.push(commandCheck("diagnostics", "typescript", cwd, runner, ["--project", configPath, "--noEmit", "--pretty", "false"], group));
    }
  }

  const pythonFiles = files.filter((file) => [".py", ".pyi"].includes(path.extname(file.path).toLowerCase()));
  if (pythonFiles.length > 0 && (toolEnabled(config, "ruff"))) {
    const ruffGroups = await groupByRuffConfig(pythonFiles, boundaries);
    for (const [configPath, group] of ruffGroups) {
      const cwd = path.dirname(configPath);
      const runner = await findNativeTool("ruff", cwd, boundaries.get(group[0].path)!);
      if (config.formatters) checks.push(commandCheck("format", "ruff", cwd, runner, ["format", "--check", ...group.map((file) => file.path)], group));
      if (config.diagnostics) checks.push(commandCheck("diagnostics", "ruff", cwd, runner, ["check", "--output-format", "concise", ...group.map((file) => file.path)], group));
    }
  }

  const rustFiles = files.filter((file) => path.extname(file.path).toLowerCase() === ".rs");
  const cargoGroups = await groupByConfig(rustFiles, boundaries, ["Cargo.toml"]);
  for (const [manifestPath, group] of cargoGroups) {
    const cwd = path.dirname(manifestPath);
    const boundary = boundaries.get(group[0].path)!;
    if (config.formatters && toolEnabled(config, "rustfmt")) {
      const runner = await findNativeTool("rustfmt", cwd, boundary);
      checks.push(commandCheck("format", "rustfmt", cwd, runner, ["--check", ...group.map((file) => file.path)], group));
    }
    if (config.diagnostics && toolEnabled(config, "cargo")) {
      const runner = await findNativeTool("cargo", cwd, boundary);
      checks.push(commandCheck("diagnostics", "cargo", cwd, runner, ["check", "--locked", "--manifest-path", manifestPath, "--message-format", "short", "--quiet"], group));
    }
  }

  const goFiles = files.filter((file) => path.extname(file.path).toLowerCase() === ".go");
  const goGroups = await groupByConfig(goFiles, boundaries, ["go.mod"]);
  for (const [manifestPath, group] of goGroups) {
    const cwd = path.dirname(manifestPath);
    const boundary = boundaries.get(group[0].path)!;
    if (config.formatters && toolEnabled(config, "gofmt")) {
      const runner = await findNativeTool("gofmt", cwd, boundary);
      checks.push({ ...commandCheck("format", "gofmt", cwd, runner, ["-d", ...group.map((file) => file.path)], group), issuesOnOutput: true });
    }
    if (config.diagnostics && toolEnabled(config, "go")) {
      const runner = await findNativeTool("go", cwd, boundary);
      checks.push(commandCheck("diagnostics", "go", cwd, runner, ["test", "-mod=readonly", "./..."], group));
    }
  }

  // Format feedback should arrive before potentially slower project-wide type
  // checks. Stable ordering also makes receipts/tests deterministic.
  return dedupeChecks(checks).sort((left, right) => {
    const kindOrder = (value: PostMutationFeedbackKind) => value === "format" ? 0 : 1;
    return kindOrder(left.kind) - kindOrder(right.kind) || left.tool.localeCompare(right.tool) || left.cwd.localeCompare(right.cwd);
  });
}

function commandCheck(
  kind: PostMutationFeedbackKind,
  tool: KnownFeedbackTool,
  cwd: string,
  runner: CommandRunner | null,
  args: string[],
  files: readonly (PostMutationFeedbackFile & { committedHash: string })[],
): DiscoveredCheck {
  return {
    kind,
    tool,
    cwd,
    runner,
    args,
    files: files.map((file) => ({ path: file.path, committedHash: file.committedHash })),
    unavailableDetail: runner ? undefined : `${tool} is configured for these files but no safe local/native executable was found.`,
  };
}

async function executeCheck(check: DiscoveredCheck, timeoutMs: number, outputLimit: number): Promise<PostMutationFeedbackCheck> {
  const base = checkResultBase(check);
  if (!check.runner) {
    return { ...base, status: "unavailable", exitCode: null, signal: null, durationMs: 0, output: "", outputTruncated: false, detail: check.unavailableDetail };
  }

  const before = await verifyCheckFiles(check.files);
  if (!before.exact) {
    return { ...base, status: "stale", exitCode: null, signal: null, durationMs: 0, output: "", outputTruncated: false, detail: before.detail };
  }

  const started = Date.now();
  const scratch = ["cargo", "ruff", "go"].includes(check.tool)
    ? await fs.mkdtemp(path.join(os.tmpdir(), `ares-${check.tool}-feedback-`))
    : null;
  const isolatedEnv: Record<string, string> = {};
  if (scratch && check.tool === "cargo") isolatedEnv.CARGO_TARGET_DIR = path.join(scratch, "target");
  if (scratch && check.tool === "ruff") isolatedEnv.RUFF_CACHE_DIR = path.join(scratch, "ruff-cache");
  if (scratch && check.tool === "go") isolatedEnv.GOCACHE = path.join(scratch, "go-cache");
  const run = await runBounded(check.runner.command, [...check.runner.argsPrefix, ...check.args], check.cwd, timeoutMs, outputLimit, isolatedEnv)
    .finally(() => scratch ? fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined) : undefined);
  const after = await verifyCheckFiles(check.files);
  let status: PostMutationFeedbackCheckStatus;
  let detail = run.detail;
  if (!after.exact) {
    status = "stale";
    detail = `Files changed while ${check.tool} was running; its output is not attributed to the committed hashes. ${after.detail ?? ""}`.trim();
  } else if (run.timedOut) {
    status = "timed_out";
  } else if (run.spawnError) {
    status = "unavailable";
  } else if (run.exitCode === 0 && !(check.issuesOnOutput && run.output.trim())) {
    status = "passed";
  } else if (run.exitCode === 1 || (run.exitCode === 0 && check.issuesOnOutput && run.output.trim())) {
    status = "issues";
  } else {
    status = "failed";
  }
  return {
    ...base,
    status,
    exitCode: run.exitCode,
    signal: run.signal,
    durationMs: Date.now() - started,
    output: run.output,
    outputTruncated: run.truncated,
    detail,
  };
}

function checkResultBase(check: DiscoveredCheck): Omit<PostMutationFeedbackCheck, "status" | "exitCode" | "signal" | "durationMs" | "output" | "outputTruncated" | "detail"> {
  return {
    kind: check.kind,
    tool: check.tool,
    cwd: check.cwd,
    command: check.runner?.display ?? check.tool,
    args: [...check.args],
    files: check.files.map((file) => file.path),
    committedHashes: Object.fromEntries(check.files.map((file) => [file.path, file.committedHash])),
  };
}

function skippedCheck(check: DiscoveredCheck, detail: string): PostMutationFeedbackCheck {
  return { ...checkResultBase(check), status: "skipped", exitCode: null, signal: null, durationMs: 0, output: "", outputTruncated: false, detail };
}

async function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  outputLimit: number,
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<{
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  spawnError: boolean;
  detail?: string;
}> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let spawnError = false;
    let detail: string | undefined;
    const capture = new BoundedCapture(outputLimit);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...envOverrides, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      });
    } catch (error) {
      resolve({ exitCode: null, signal: null, output: "", truncated: false, timedOut: false, spawnError: true, detail: errorMessage(error) });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => capture.push(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => capture.push(chunk));
    child.on("error", (error) => {
      spawnError = true;
      detail = error.message;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      detail = `Timed out after ${timeoutMs}ms.`;
      terminateProcessTree(child.pid);
    }, Math.max(1, timeoutMs));
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const captured = capture.finish();
      resolve({ exitCode, signal, output: captured.output, truncated: captured.truncated, timedOut, spawnError, detail });
    };
    child.on("close", finish);
  });
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.unref();
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
  }
}

class BoundedCapture {
  private text = "";
  private dropped = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer | string): void {
    const value = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk).replace(/\0/g, "");
    if (this.limit <= 0) {
      if (value) this.dropped = true;
      return;
    }
    if (this.text.length + value.length <= this.limit) {
      this.text += value;
      return;
    }
    this.dropped = true;
    const headSize = Math.ceil(this.limit * 0.65);
    const tailSize = this.limit - headSize;
    const combined = this.text + value;
    this.text = combined.slice(0, headSize) + combined.slice(-tailSize);
  }

  finish(): { output: string; truncated: boolean } {
    if (this.limit <= 0) return { output: "", truncated: this.dropped };
    const marker = this.dropped ? "\n...[diagnostic output truncated]...\n" : "";
    if (!this.dropped) return { output: this.text.trim(), truncated: false };
    const split = Math.ceil(this.text.length * 0.65);
    return { output: `${this.text.slice(0, split)}${marker}${this.text.slice(split)}`.trim(), truncated: true };
  }
}

async function inspectCommittedFile(file: PostMutationCommittedFile): Promise<PostMutationFeedbackFile> {
  const absolute = path.resolve(file.path);
  const observed = await inspectPath(absolute);
  const observedHash = observed.hash;
  let state: PostMutationFeedbackFile["state"];
  if (file.committedHash === null) state = !observed.exists ? "deleted" : "drifted";
  else if (observedHash === file.committedHash) state = "exact";
  else if (!observed.exists) state = "missing";
  else state = "drifted";
  if (state === "exact" && !TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) state = "unsupported";
  return { path: absolute, committedHash: file.committedHash, observedHash, state };
}

async function hashRegularFile(filePath: string): Promise<string | null> {
  return (await inspectPath(filePath)).hash;
}

async function inspectPath(filePath: string): Promise<{ exists: boolean; hash: string | null }> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat) return { exists: false, hash: null };
  if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true, hash: null };
  const bytes = await fs.readFile(filePath).catch(() => null);
  return { exists: true, hash: bytes ? createHash("sha256").update(bytes).digest("hex") : null };
}

async function verifyCheckFiles(files: readonly { path: string; committedHash: string }[]): Promise<{ exact: boolean; detail?: string }> {
  for (const file of files) {
    const actual = await hashRegularFile(file.path);
    if (actual !== file.committedHash) return { exact: false, detail: `${file.path} no longer matches committed SHA-256 ${file.committedHash}.` };
  }
  return { exact: true };
}

async function loadConfig(workspace: string, overrides: PostMutationFeedbackOptions): Promise<FeedbackConfig> {
  const configPath = path.join(workspace, ".ares", "post-mutation-feedback.json");
  let fromDisk: PostMutationFeedbackOptions = {};
  try {
    const text = await fs.readFile(configPath, "utf8");
    fromDisk = JSON.parse(text) as PostMutationFeedbackOptions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid post-mutation feedback config at ${configPath}: ${errorMessage(error)}`);
    }
  }
  const merged: PostMutationFeedbackOptions = { ...fromDisk, ...overrides, tools: { ...fromDisk.tools, ...overrides.tools } };
  return {
    enabled: merged.enabled ?? DEFAULT_CONFIG.enabled,
    formatters: merged.formatters ?? DEFAULT_CONFIG.formatters,
    diagnostics: merged.diagnostics ?? DEFAULT_CONFIG.diagnostics,
    formatTimeoutMs: clampInt(merged.formatTimeoutMs, 250, 8_000, DEFAULT_CONFIG.formatTimeoutMs),
    diagnosticTimeoutMs: clampInt(merged.diagnosticTimeoutMs, 500, 20_000, DEFAULT_CONFIG.diagnosticTimeoutMs),
    totalTimeoutMs: clampInt(merged.totalTimeoutMs, 1_000, 30_000, DEFAULT_CONFIG.totalTimeoutMs),
    maxFiles: clampInt(merged.maxFiles, 1, 100, DEFAULT_CONFIG.maxFiles),
    maxChecks: clampInt(merged.maxChecks, 1, 16, DEFAULT_CONFIG.maxChecks),
    maxOutputChars: clampInt(merged.maxOutputChars, 2_000, 24_000, DEFAULT_CONFIG.maxOutputChars),
    tools: merged.tools ?? {},
  };
}

async function groupByConfig<T extends PostMutationFeedbackFile & { committedHash: string }>(
  files: readonly T[],
  boundaries: ReadonlyMap<string, string>,
  names: readonly string[],
  packageField?: string,
): Promise<Map<string, T[]>> {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const config = await nearestConfig(path.dirname(file.path), boundaries.get(file.path)!, names, packageField);
    if (!config) continue;
    const group = groups.get(config) ?? [];
    group.push(file);
    groups.set(config, group);
  }
  return groups;
}

async function groupByRuffConfig<T extends PostMutationFeedbackFile & { committedHash: string }>(
  files: readonly T[],
  boundaries: ReadonlyMap<string, string>,
): Promise<Map<string, T[]>> {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const boundary = boundaries.get(file.path)!;
    let dir = path.dirname(file.path);
    while (true) {
      for (const name of ["ruff.toml", ".ruff.toml"]) {
        const candidate = path.join(dir, name);
        if (await isFile(candidate)) {
          const group = groups.get(candidate) ?? [];
          group.push(file);
          groups.set(candidate, group);
          dir = "";
          break;
        }
      }
      if (!dir) break;
      const pyproject = path.join(dir, "pyproject.toml");
      const text = await fs.readFile(pyproject, "utf8").catch(() => "");
      if (/^\s*\[tool\.ruff(?:\.|\])/m.test(text)) {
        const group = groups.get(pyproject) ?? [];
        group.push(file);
        groups.set(pyproject, group);
        break;
      }
      if (samePath(dir, boundary)) break;
      const parent = path.dirname(dir);
      if (parent === dir || !isInside(boundary, parent)) break;
      dir = parent;
    }
  }
  return groups;
}

async function nearestConfig(start: string, boundary: string, names: readonly string[], packageField?: string): Promise<string | null> {
  let dir = path.resolve(start);
  const stop = path.resolve(boundary);
  while (isInside(stop, dir)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isFile(candidate)) return candidate;
    }
    if (packageField) {
      const packagePath = path.join(dir, "package.json");
      const pkg = await readJson<Record<string, unknown>>(packagePath);
      if (pkg && Object.prototype.hasOwnProperty.call(pkg, packageField)) return packagePath;
    }
    if (samePath(dir, stop)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function discoveryBoundary(workspace: string, filePath: string): Promise<string> {
  if (isInside(workspace, filePath)) return workspace;
  // Explicitly approved external files are not forced back into the selected
  // workspace. Bound discovery to their nearest repository/project marker.
  let dir = path.dirname(path.resolve(filePath));
  let nearestProject: string | null = null;
  for (let depth = 0; depth < 16; depth++) {
    if (await pathExists(path.join(dir, ".git"))) return dir;
    if (!nearestProject && await hasAnyProjectMarker(dir)) nearestProject = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return nearestProject ?? path.dirname(path.resolve(filePath));
}

async function hasAnyProjectMarker(dir: string): Promise<boolean> {
  for (const name of ["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    if (await isFile(path.join(dir, name))) return true;
  }
  return false;
}

async function findNodePackageBin(start: string, boundary: string, packageName: string, binName: string): Promise<CommandRunner | null> {
  let dir = path.resolve(start);
  const stop = path.resolve(boundary);
  while (isInside(stop, dir)) {
    const packagePath = path.join(dir, "node_modules", ...packageName.split("/"), "package.json");
    const pkg = await readJson<{ bin?: string | Record<string, string> }>(packagePath);
    if (pkg?.bin) {
      const relativeBin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[binName] ?? Object.values(pkg.bin)[0];
      if (relativeBin) {
        const packageDir = path.dirname(packagePath);
        const binPath = path.resolve(packageDir, relativeBin);
        if (isInside(packageDir, binPath) && await isFile(binPath)) {
          if (/\.(?:c?js|mjs|ts)$/i.test(binPath) || path.extname(binPath) === "") {
            return { command: process.execPath, argsPrefix: [binPath], display: `${packageName}:${binName}` };
          }
          if (process.platform !== "win32" || /\.(?:exe|com)$/i.test(binPath)) {
            return { command: binPath, argsPrefix: [], display: `${packageName}:${binName}` };
          }
        }
      }
    }
    if (samePath(dir, stop)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function findNativeTool(name: string, start: string, boundary: string): Promise<CommandRunner | null> {
  for (let dir = path.resolve(start); isInside(boundary, dir); dir = path.dirname(dir)) {
    const candidates = process.platform === "win32"
      ? [path.join(dir, ".venv", "Scripts", `${name}.exe`), path.join(dir, "venv", "Scripts", `${name}.exe`)]
      : [path.join(dir, ".venv", "bin", name), path.join(dir, "venv", "bin", name)];
    for (const candidate of candidates) {
      if (await isFile(candidate)) return { command: candidate, argsPrefix: [], display: name };
    }
    if (samePath(dir, boundary) || path.dirname(dir) === dir) break;
  }
  const executable = await findOnPath(name);
  return executable ? { command: executable, argsPrefix: [], display: name } : null;
}

async function findOnPath(name: string): Promise<string | null> {
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(entry, name + extension);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

function dedupeChecks(checks: readonly DiscoveredCheck[]): DiscoveredCheck[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = `${check.kind}\0${check.tool}\0${normalizeKey(check.cwd)}\0${check.args.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeCommittedFiles(files: readonly PostMutationCommittedFile[]): PostMutationCommittedFile[] {
  const unique = new Map<string, PostMutationCommittedFile>();
  for (const file of files) unique.set(normalizeKey(path.resolve(file.path)), { path: path.resolve(file.path), committedHash: file.committedHash });
  return [...unique.values()];
}

function feedbackStatus(checks: readonly PostMutationFeedbackCheck[], files: readonly PostMutationFeedbackFile[]): PostMutationFeedback["status"] {
  if (files.some((file) => file.state === "drifted" || file.state === "missing") || checks.some((check) => check.status === "stale")) return "stale";
  if (checks.some((check) => check.status === "issues")) return "issues";
  if (checks.some((check) => ["timed_out", "unavailable", "failed", "skipped"].includes(check.status))) return "incomplete";
  return checks.length > 0 ? "clean" : "no_checks";
}

function result(
  workspace: string,
  status: PostMutationFeedback["status"],
  detail: string | undefined,
  files: PostMutationFeedbackFile[],
  checks: PostMutationFeedbackCheck[],
  startedAt: string,
  started: number,
): PostMutationFeedback {
  return { version: 1, workspace: path.resolve(workspace), status, startedAt, durationMs: Date.now() - started, files, checks, detail };
}

function toolEnabled(config: FeedbackConfig, tool: KnownFeedbackTool): boolean {
  return config.tools[tool] !== false;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return normalizeKey(left) === normalizeKey(right);
}

function normalizeKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function isFile(candidate: string): Promise<boolean> {
  const stat = await fs.stat(candidate).catch(() => null);
  return stat?.isFile() ?? false;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.stat(candidate).then(() => true).catch(() => false);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  return fs.readFile(filePath, "utf8").then((text) => JSON.parse(text) as T).catch(() => null);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function indent(value: string, prefix: string): string {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
