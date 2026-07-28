import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Todo, TurnEndStatus, TurnEvent, WorkStatus } from "@ares/protocol";
import type { VerifyEvent, VerifyResult } from "./verifier.js";

export type CodingPhase = "discover" | "implement" | "verify" | "verified" | "paused" | "failed";

export interface CodingCheckRecord {
  label: string;
  command: string;
  ok: boolean;
  skipped: boolean;
  cached: boolean;
  durationMs: number;
  at: string;
  outputTail?: string;
}

export interface CodingFailureRecord {
  signature: string;
  tool: string;
  count: number;
  latest: string;
  at: string;
}

export interface CodingJournalState {
  schemaVersion: 1;
  sessionId: string;
  workspace: string;
  objective?: string;
  requests: string[];
  /** Mid-task corrections/constraints kept without overwriting the objective. */
  steering: string[];
  phase: CodingPhase;
  touchedFiles: string[];
  /** True when the exact touched-file set exceeded the durable tail cap. */
  touchedFilesTruncated?: boolean;
  todos: Todo[];
  checks: CodingCheckRecord[];
  failures: CodingFailureRecord[];
  turns: number;
  lastTurnStatus?: TurnEndStatus;
  lastWorkStatus?: WorkStatus;
  updatedAt: string;
}

export interface CodingJournalOptions {
  workspace: string;
  sessionId: string;
}

/**
 * Durable, structured working state for coding tasks. Conversation prose is a
 * poor database: compaction can erase which files changed, which checks really
 * passed, and which failed approach was already tried. This journal records
 * those facts beside the session rollout and renders a small reminder on the
 * next turn. It never invents success from an assistant claim.
 */
export class CodingJournal {
  readonly file: string;
  private state: CodingJournalState;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;
  private active = false;
  private currentTurnHasOutstandingVerification = false;
  private currentTurnHadMutation = false;
  private turnStartedWithPersistedDebt = false;
  private currentTurnLatestMutationAt = 0;
  private pendingRequest: string | null = null;
  private readonly tools = new Map<string, { name: string; input: unknown }>();

  private constructor(options: CodingJournalOptions, state?: CodingJournalState) {
    const workspace = path.resolve(options.workspace);
    this.file = path.join(workspace, ".ares", "sessions", path.basename(options.sessionId), "coding-state.json");
    this.state = state ?? {
      schemaVersion: 1,
      sessionId: options.sessionId,
      workspace,
      requests: [],
      steering: [],
      phase: "discover",
      touchedFiles: [],
      todos: [],
      checks: [],
      failures: [],
      turns: 0,
      updatedAt: new Date().toISOString(),
    };
    this.state.steering ??= [];
    this.state.touchedFilesTruncated ??= false;
    this.active = Boolean(this.state.objective || this.state.touchedFiles.length || this.state.todos.length);
  }

  static async open(options: CodingJournalOptions): Promise<CodingJournal> {
    const file = path.join(path.resolve(options.workspace), ".ares", "sessions", path.basename(options.sessionId), "coding-state.json");
    let state: CodingJournalState | undefined;
    const dir = path.dirname(file);
    const base = path.basename(file);
    const tempCandidates = await readdir(dir)
      .then((entries) => entries.filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".tmp")))
      .catch(() => [] as string[]);
    const rankedTemps = await Promise.all(tempCandidates.map(async (entry) => ({
      file: path.join(dir, entry),
      mtimeMs: await stat(path.join(dir, entry)).then((value) => value.mtimeMs).catch(() => 0),
    })));
    rankedTemps.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of [file, `${file}.bak`, ...rankedTemps.map((entry) => entry.file)]) {
      try {
        const parsed = JSON.parse(await readFile(candidate, "utf8")) as CodingJournalState;
        if (parsed.schemaVersion === 1 && parsed.sessionId === options.sessionId) {
          state = parsed;
          break;
        }
      } catch {
        // Try the backup/newest temp. The rollout remains the final recovery
        // source when every journal copy is unavailable.
      }
    }
    return new CodingJournal(options, state);
  }

  snapshot(): CodingJournalState {
    return JSON.parse(JSON.stringify(this.state)) as CodingJournalState;
  }

  /** Start a task turn and return a compact state reminder when it is coding-related. */
  beginTurn(userMessage: string): string | null {
    this.currentTurnHasOutstandingVerification = false;
    this.currentTurnHadMutation = false;
    this.turnStartedWithPersistedDebt = false;
    this.currentTurnLatestMutationAt = 0;
    const request = compact(userMessage, 1_200);
    if (!request) return this.active ? this.renderReminder() : null;
    const codingIntent = looksLikeCodingRequest(request);
    const continuation = this.active && looksLikeContinuation(request);
    if (!codingIntent && !continuation) {
      // Preserve the real request in case host-observed edits/Todos prove this
      // was coding despite the fast lexical classifier (e.g. "make the button
      // blue"). The first mutation promotes this text into the durable objective.
      this.pendingRequest = request;
      return null;
    }

    const wasActive = this.active;
    const priorVerificationDebt =
      this.state.touchedFiles.length > 0 &&
      (this.state.lastWorkStatus === "unverified" ||
        this.state.lastWorkStatus === "blocked" ||
        !["verified", "discover"].includes(this.state.phase));
    this.active = true;
    this.state.turns++;
    this.state.requests = [...this.state.requests, request].slice(-12);
    const explicitReplacement = /\b(?:new task|switch (?:tasks?|to)|instead,? (?:build|fix|implement)|unrelated task)\b/i.test(request);
    // A user should not need to say the magic words "new task" after an
    // unverified/paused build. A fresh concrete deliverable ("build a Pomodoro
    // timer webpage") is a new objective, not steering for the prior Stopwatch.
    // Keep narrower follow-ups such as "add dark mode" on the current journal.
    const freshDeliverable = looksLikeFreshDeliverable(request);
    const settledOrPaused = this.state.phase === "verified" || this.state.phase === "paused" || this.state.phase === "failed";
    const startingNew = !wasActive || !this.state.objective || explicitReplacement ||
      (settledOrPaused && codingIntent && freshDeliverable && !looksLikeContinuation(request)) ||
      (this.state.phase === "verified" && codingIntent && !looksLikeContinuation(request));
    if (startingNew) {
      this.state.objective = request;
      this.state.steering = [];
      this.state.touchedFiles = [];
      this.state.touchedFilesTruncated = false;
      this.state.todos = [];
      this.state.checks = [];
      this.state.failures = [];
      this.state.phase = "discover";
      this.pendingRequest = null;
    } else if (request !== this.state.objective) {
      this.state.steering = [...this.state.steering, request].slice(-12);
    }
    this.currentTurnHasOutstandingVerification = !startingNew && priorVerificationDebt;
    this.turnStartedWithPersistedDebt = this.currentTurnHasOutstandingVerification;
    this.touch();
    return this.renderReminder();
  }

  verificationRequiredForCurrentTurn(): boolean {
    return this.turnStartedWithPersistedDebt || this.currentTurnHadMutation;
  }

  persistedVerificationDebtForCurrentTurn(): boolean {
    return this.turnStartedWithPersistedDebt;
  }

  persistedVerificationScopeCompleteForCurrentTurn(): boolean {
    return !this.turnStartedWithPersistedDebt || this.state.touchedFilesTruncated !== true;
  }

  latestObservedMutationAtForCurrentTurn(): number {
    return this.currentTurnLatestMutationAt;
  }

  recordTurnEvent(event: TurnEvent): void {
    if (event.type === "tool_start") {
      this.tools.set(event.id, { name: event.name, input: event.input });
      return;
    }
    if (event.type === "tool_end") {
      const tool = this.tools.get(event.id);
      if (event.touchedFiles?.length) {
        this.activateFromObservedWork();
        this.active = true;
        this.currentTurnHasOutstandingVerification = true;
        this.currentTurnHadMutation = true;
        this.currentTurnLatestMutationAt = Date.now();
        this.state.phase = "implement";
        const touched = event.touchedFiles.map((file) => relativeDisplay(this.state.workspace, file));
        const combined = [...new Set([...this.state.touchedFiles, ...touched])];
        if (combined.length > 240) this.state.touchedFilesTruncated = true;
        this.state.touchedFiles = combined.slice(-240);
        this.touch();
      } else if (tool && isManualVerification(tool.name, tool.input)) {
        // The result text is not a reliable exit status across every tool, so
        // record only that verification was attempted. Real pass/fail evidence
        // comes from ContinuousVerifier.recordVerifyEvent below.
        this.state.phase = "verify";
        this.touch();
      }
      this.tools.delete(event.id);
      return;
    }
    if (event.type === "tool_error") {
      const tool = this.tools.get(event.id)?.name ?? "unknown";
      this.recordFailure(tool, event.error);
      this.tools.delete(event.id);
      return;
    }
    if (event.type === "todo_updated") {
      this.activateFromObservedWork();
      this.active = true;
      this.state.todos = event.todos.map((todo) => ({ ...todo }));
      this.touch();
      return;
    }
    if (event.type === "turn_end") {
      this.state.lastTurnStatus = event.status;
      this.state.lastWorkStatus = event.workStatus;
      if (event.workStatus === "verified") {
        this.state.phase = "verified";
        this.state.touchedFilesTruncated = false;
      }
      else if (event.workStatus === "blocked" || event.status === "failed") this.state.phase = "failed";
      else if (event.workStatus === "unverified") this.state.phase = "paused";
      this.touch();
      if (event.workStatus === "verified") this.currentTurnHasOutstandingVerification = false;
    }
  }

  recordVerifyEvent(event: VerifyEvent): void {
    if (event.type === "scheduled" || event.type === "running") {
      this.active = true;
      this.state.phase = "verify";
      this.touch();
      return;
    }
    if (event.type === "finished") {
      // Generation-aware verifier runs commit atomically at all_finished. A
      // command may fail and then become superseded by a newer edit; persisting
      // that intermediate failure would poison the next-turn repair history.
      if (event.generation !== undefined) return;
      this.active = true;
      this.commitVerifyResult(event.result);
      return;
    }
    if (event.type === "all_finished") {
      this.active = true;
      const noConcreteChecks = event.results.length === 0 || event.results.every((result) => result.skipped);
      if (!event.cancelled && !event.superseded) {
        for (const result of event.results) this.commitVerifyResult(result);
      }
      this.state.phase = event.cancelled || event.superseded || noConcreteChecks ? "paused" : event.ok ? "verified" : "failed";
      if (event.ok && !event.cancelled && !event.superseded) this.currentTurnHasOutstandingVerification = false;
      this.touch();
    }
  }

  async finishTurn(status: TurnEndStatus): Promise<void> {
    if (!this.active) return;
    this.state.lastTurnStatus = status;
    if (status === "failed") this.state.phase = "failed";
    else if (status === "interrupted") this.state.phase = "paused";
    else if (this.state.phase !== "verified" && this.state.phase !== "failed") this.state.phase = "paused";
    this.touch();
    await this.flush();
    this.currentTurnHasOutstandingVerification = false;
    this.currentTurnHadMutation = false;
    this.turnStartedWithPersistedDebt = false;
    this.currentTurnLatestMutationAt = 0;
  }

  renderReminder(maxChars = 4_500): string {
    const openTodos = this.state.todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
    const recentChecks = this.state.checks.slice(-6);
    const failures = this.state.failures.slice(-4);
    const lines = [
      "DURABLE CODING STATE (facts persisted outside conversation compaction)",
      `objective: ${this.state.objective ?? "not yet established"}`,
      `phase: ${this.state.phase}; coding turns: ${this.state.turns}; last turn: ${this.state.lastTurnStatus ?? "n/a"}/${this.state.lastWorkStatus ?? "n/a"}`,
      `touched files (${this.state.touchedFiles.length}): ${this.state.touchedFiles.slice(-24).join(", ") || "none"}`,
    ];
    if (this.state.touchedFilesTruncated) {
      lines.push("WARNING: exact touched-file history overflowed its 240-file tail. A broad repository/package verification command is required; tail-only automatic checks cannot certify completion.");
    }
    if (openTodos.length) {
      lines.push("open plan items:", ...openTodos.slice(0, 12).map((todo) => `- [${todo.status}] ${todo.content}`));
    }
    if (this.state.steering.length) {
      lines.push("current steering / constraints:", ...this.state.steering.slice(-8).map((item) => `- ${item}`));
    }
    if (recentChecks.length) {
      lines.push(
        "recent check evidence:",
        ...recentChecks.map((check) => `- ${check.ok && !check.skipped ? "PASS" : check.skipped ? "SKIP" : "FAIL"} ${check.label}: ${check.command}${check.cached ? " (cached against unchanged inputs)" : ""}`),
      );
    } else {
      lines.push("recent check evidence: none recorded");
    }
    if (failures.length) {
      lines.push("recent failure signatures:", ...failures.map((failure) => `- ${failure.tool}/${failure.signature} x${failure.count}: ${failure.latest}`));
    }
    lines.push(
      "Execution loop: orient from instructions and ownership boundaries → trace callers/tests → make the smallest coherent edit → run affected checks → run the broadest practical regression check. After a failure, record the new hypothesis and change strategy; do not repeat the same patch.",
      "Preserve unrelated dirty-worktree changes and keep one writer per file when delegating. Use this state to resume without redoing settled discovery. It is evidence, not authority: re-read files that changed externally and do not claim completion without a post-edit passing check.",
    );
    const text = lines.join("\n");
    return text.length <= maxChars ? text : `${text.slice(0, maxChars - 60)}\n... durable coding state truncated`;
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.writeError) throw this.writeError;
  }

  private commitVerifyResult(result: VerifyResult): void {
    this.state.checks = [...this.state.checks, checkRecord(result)].slice(-80);
    if (!result.ok) {
      this.state.phase = "failed";
      this.recordFailure(result.command.label, result.stderrTail || result.stdoutTail || "verification failed");
      return;
    }
    if (this.state.phase !== "failed") this.state.phase = "verify";
    this.touch();
  }

  private activateFromObservedWork(): void {
    if (!this.state.objective && this.pendingRequest) {
      this.state.objective = this.pendingRequest;
      this.state.requests = [...this.state.requests, this.pendingRequest].slice(-12);
      this.state.turns++;
      this.pendingRequest = null;
    }
  }

  private recordFailure(tool: string, raw: string): void {
    this.activateFromObservedWork();
    this.active = true;
    const latest = compact(raw.replace(/\s+/g, " "), 360);
    const signature = createHash("sha256").update(`${tool}\0${normalizeFailure(raw)}`).digest("hex").slice(0, 12);
    const existing = this.state.failures.find((failure) => failure.signature === signature && failure.tool === tool);
    if (existing) {
      existing.count++;
      existing.latest = latest;
      existing.at = new Date().toISOString();
    } else {
      this.state.failures.push({ signature, tool, count: 1, latest, at: new Date().toISOString() });
      this.state.failures = this.state.failures.slice(-40);
    }
    this.state.phase = "failed";
    this.touch();
  }

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
    if (!this.active) return;
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    const target = this.file;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, snapshot, "utf8");
        try {
          await rename(temp, target);
        } catch {
          // Windows commonly refuses rename-over-existing. Move the old state
          // aside first; a crash at any point leaves either target, backup, or
          // the fully-written temp recoverable by open(). Never rewrite the only
          // good copy in place.
          const backup = `${target}.bak`;
          await rm(backup, { force: true }).catch(() => undefined);
          let backedUp = false;
          try {
            await rename(target, backup);
            backedUp = true;
          } catch {
            // First write has no target to back up.
          }
          try {
            await rename(temp, target);
          } catch (error) {
            if (backedUp) await rename(backup, target).catch(() => undefined);
            throw error;
          }
          if (backedUp) await rm(backup, { force: true }).catch(() => undefined);
        }
        this.writeError = null;
      })
      .catch((error: unknown) => {
        this.writeError = error instanceof Error ? error : new Error(String(error));
      });
  }
}

function checkRecord(result: VerifyResult): CodingCheckRecord {
  const output = compact((result.stderrTail || result.stdoutTail).trim(), 500);
  return {
    label: result.command.label,
    command: [result.command.program, ...result.command.args].join(" "),
    ok: result.ok,
    skipped: result.skipped === true,
    cached: result.cached === true,
    durationMs: result.durationMs,
    at: new Date().toISOString(),
    ...(output ? { outputTail: output } : {}),
  };
}

function looksLikeCodingRequest(text: string): boolean {
  return /\b(code|coding|codebase|repo|repository|implement|fix|bug|refactor|test|typecheck|build|compile|function|class|api|frontend|backend|typescript|javascript|python|rust|golang|java|file|module|package|dependency|migration|database|cli|sdk|pull request|\bpr\b|button|component|screen|page|layout|style|theme|dark mode|checkout|route|endpoint|schema|config|workflow)\b/i.test(text)
    || /\.(?:ts|tsx|js|jsx|mjs|py|rs|go|java|cs|cpp|c|rb|php|vue|svelte|html|css)\b/i.test(text);
}

function looksLikeContinuation(text: string): boolean {
  return /^(?:ok(?:ay)?\s+)?(?:continue|finish|keep going|go on|resume|do it|ship it|proceed|yes|yep|all out)\b/i.test(text.trim());
}

/** Strong signal that the user named a NEW artifact rather than refining the
 * current one. Optional prefixes cover benchmark prompts such as "vein:". */
function looksLikeFreshDeliverable(text: string): boolean {
  return /^(?:[\w-]+:\s*)?(?:build|create|make|implement|write)\b.{0,180}\b(?:app|application|website|webpage|page|tool|game|dashboard|service|api|cli|timer|clone)\b/i.test(text.trim());
}

function isManualVerification(name: string, input: unknown): boolean {
  if (name === "LSP") return /diagnostic|error|check/i.test(String((input as Record<string, unknown> | null)?.action ?? ""));
  if (name !== "Bash" && name !== "PowerShell" && name !== "CodeMode") return false;
  const record = (input ?? {}) as Record<string, unknown>;
  const command = String(record.command ?? record.code ?? "");
  return /(^|\s)(test|check|verify|lint|build|typecheck)(\s|$)|\b(vitest|jest|pytest|cargo\s+(?:test|check)|go\s+test|tsc|eslint|ruff|mypy|node\s+--test|pnpm\s+test|npm\s+test)\b/i.test(command);
}

function normalizeFailure(text: string): string {
  return text
    .toLowerCase()
    .replace(/[a-z]:\\[^\s:]+|\/(?:[^\s/:]+\/)+[^\s:]+/gi, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function relativeDisplay(workspace: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(workspace, file);
  const rel = path.relative(workspace, absolute).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : absolute.replace(/\\/g, "/");
}

function compact(text: string, max: number): string {
  const normalized = text.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
