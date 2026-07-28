// Session — wraps QueryEngine with persistence and lifecycle.
//
// One Session per conversation. Each turn:
//   1. session.send(text) returns AsyncGenerator<TurnEvent>
//   2. Every event is appended to <workspace>/.ares/sessions/<id>/events.jsonl
//   3. Caller (CLI or TUI) consumes the same stream for display
//
// Full DAG fork/diff/rollback come in M4; M1 provides linear rollout.

import { mkdir, appendFile, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  messageText,
  type ContentBlock,
  type TurnEvent,
  type SessionMeta,
  type RolloutEntry,
  type ProviderInfo,
  type Message,
  type ToolResultBlock,
  type Todo,
  type WorkStatus,
} from "@ares/protocol";
import { QueryEngine, stringifyModelToolOutput, type EngineTool, type Provider, type QueryEngineConfig } from "./queryEngine.js";
import type { ToolPermissionRequest } from "./queryEngine.js";
import type { PermissionPromptDecision, ReasoningLevel, Usage } from "@ares/protocol";
import type { HookManager } from "./hooks.js";
import { createWorkspaceCheckpoint, diffWorkspaceCheckpointUnified, isUnsnapshotableWorkspace } from "./checkpoints.js";
import { FrictionRecorder } from "./frictionLog.js";

type ReminderSource =
  | "verifier"
  | "compaction"
  | "hook"
  | "skill"
  | "memory"
  | "instructions"
  | "undo"
  | "heartbeat"
  | "dream"
  | "recall"
  | "self-revise";

function isOpaqueMutationTool(name: string | undefined): boolean {
  return name === "Bash" || name === "PowerShell" || name === "CodeMode" || name === "Task" || name === "Conductor";
}

export interface SessionOptions {
  workspace: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: readonly EngineTool[];
  signal?: AbortSignal;
  /** Optional pre-set sessionId (for resume). Defaults to a fresh id. */
  sessionId?: string;
  sessionMeta?: SessionMeta;
  initialMessages?: readonly Message[];
  /** Last TodoWrite snapshot restored independently of lossy message replay. */
  initialTodos?: readonly Todo[];
  initialSeq?: number;
  /** Pending system-reminders to inject at next turn_start. */
  drainSystemReminders?: () => Array<{ text: string; source: ReminderSource }>;
  /** C1 end-of-turn gate — see QueryEngineConfig.confirmTurnEnd. */
  confirmTurnEnd?: () => Promise<Array<{ text: string; source: "verifier" | "hook" }>>;
  requireVerificationEvidence?: boolean;
  verificationEvidence?: QueryEngineConfig["verificationEvidence"];
  outstandingVerificationRequired?: QueryEngineConfig["outstandingVerificationRequired"];
  persistedVerificationDebt?: QueryEngineConfig["persistedVerificationDebt"];
  persistedVerificationScopeComplete?: QueryEngineConfig["persistedVerificationScopeComplete"];
  observedMutationAt?: QueryEngineConfig["observedMutationAt"];
  /** Failure-signature recall — see QueryEngineConfig.recallFailureFix. */
  recallFailureFix?: (input: { tool: string; signature: string; error: string }) => Promise<string | null>;
  hookManager?: HookManager;
  requestPermission?: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision>;
  /**
   * Absolute paths the engine treats as "self-territory" — writes inside
   * these roots bypass the write-intent gate. Used to give the agent
   * unrestricted authority over its own brain (~/.ares/).
   */
  selfTerritoryRoots?: readonly string[];
  /** Reasoning dial for reasoning-capable models (owner-selectable, low→max). */
  reasoningLevel?: ReasoningLevel;
  /** Output-token cap per provider call. */
  maxOutputTokens?: number;
  /** Trim oldest history to keep estimated input under this many tokens. */
  contextBudgetTokens?: number;
  /** Hard ceiling on tool-calling turns before the engine stops (default 80). */
  maxTurns?: number;
  /** See QueryEngineConfig.onHistoryTrimmed — read-stamp invalidation on trim. */
  onHistoryTrimmed?: (dropped: readonly Message[]) => void;
  /** See QueryEngineConfig.summarizeSpan — smart compaction summarizer. */
  summarizeSpan?: (messages: readonly Message[]) => Promise<string>;
  /** See QueryEngineConfig.compactionThresholdTokens. */
  compactionThresholdTokens?: number;
}

export class Session {
  readonly meta: SessionMeta;
  /** Friction telemetry — one JSONL line per turn under ~/.ares/telemetry. */
  private readonly friction: FrictionRecorder;
  readonly engine: QueryEngine;
  private seq = 0;
  /** Serializes rollout appends off the hot path; ordered, never interleaved. */
  private ioChain: Promise<void> = Promise.resolve();
  private readonly eventsPath: string;
  private readonly metaPath: string;
  private metaWritten = false;
  private lastCheckpointId: string | undefined;
  private ioError: Error | null = null;
  private readonly eventObservers = new Set<(event: TurnEvent) => void>();
  /** Work truth from the most recent turn, used by post-turn learning. */
  lastWorkStatus: WorkStatus = "not_applicable";

  constructor(private readonly opts: SessionOptions) {
    const sessionId = opts.sessionMeta?.id ?? opts.sessionId ?? `sess_${randomUUID()}`;
    const providerInfo: ProviderInfo = { name: opts.provider.name, model: opts.model };
    this.meta = opts.sessionMeta ?? {
      id: sessionId,
      workspace: opts.workspace,
      provider: providerInfo,
      createdAt: new Date().toISOString(),
    };
    const sessionDir = path.join(opts.workspace, ".ares", "sessions", sessionId);
    this.eventsPath = path.join(sessionDir, "events.jsonl");
    this.metaPath = path.join(sessionDir, "meta.json");
    this.friction = new FrictionRecorder(sessionId);
    this.engine = new QueryEngine(
      {
        provider: opts.provider,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        tools: opts.tools,
        workspace: opts.workspace,
        signal: opts.signal,
        drainSystemReminders: opts.drainSystemReminders,
        confirmTurnEnd: opts.confirmTurnEnd,
        requireVerificationEvidence: opts.requireVerificationEvidence,
        verificationEvidence: opts.verificationEvidence,
        outstandingVerificationRequired: opts.outstandingVerificationRequired,
        persistedVerificationDebt: opts.persistedVerificationDebt,
        persistedVerificationScopeComplete: opts.persistedVerificationScopeComplete,
        observedMutationAt: opts.observedMutationAt,
        recallFailureFix: opts.recallFailureFix,
        hookManager: opts.hookManager,
        requestPermission: opts.requestPermission,
        selfTerritoryRoots: opts.selfTerritoryRoots,
        reasoningLevel: opts.reasoningLevel,
        maxOutputTokens: opts.maxOutputTokens,
        contextBudgetTokens: opts.contextBudgetTokens,
        maxTurns: opts.maxTurns,
        onHistoryTrimmed: opts.onHistoryTrimmed,
        summarizeSpan: opts.summarizeSpan,
        compactionThresholdTokens: opts.compactionThresholdTokens,
        beforeToolUseCheckpoint: async ({ toolUseId, toolName, targetFiles }) => {
          // A home-directory (or root) workspace is unsnapshotable: hashing the
          // user's entire digital life per Write is minutes of dead time and a
          // restore hazard. Tools still run; undo is unavailable there.
          if (isUnsnapshotableWorkspace(this.opts.workspace)) return null;
          const checkpoint = await createWorkspaceCheckpoint({
            workspace: this.opts.workspace,
            sessionId: this.meta.id,
            turnSeq: this.seq,
            parentCheckpointId: this.lastCheckpointId,
            label: `before ${toolName} ${toolUseId}`,
            // Declared-target tools (Edit/Write) snapshot incrementally — the
            // full-workspace walk only runs for shells/unknowable side effects.
            targetFiles,
          });
          this.lastCheckpointId = checkpoint.id;
          return { checkpointId: checkpoint.id, label: checkpoint.label };
        },
      },
      sessionId,
    );
    if (opts.initialMessages) this.engine.hydrate(opts.initialMessages);
    if (opts.initialTodos) this.engine.hydrateTodos(opts.initialTodos);
    if (opts.initialSeq) this.seq = opts.initialSeq;
    if (opts.sessionMeta) this.metaWritten = true;
  }

  /** Change the reasoning dial mid-session — applies to the next turn. */
  setReasoningLevel(level: ReasoningLevel): void {
    this.engine.setReasoningLevel(level);
  }

  setMaxTurns(maxTurns: number | undefined): void {
    this.engine.setMaxTurns(maxTurns);
  }

  /** Subscribe below every UI surface so durable state and verification taps
   * cannot be forgotten by one chat/daemon consumer. Returns an unsubscribe. */
  observeEvents(observer: (event: TurnEvent) => void): () => void {
    this.eventObservers.add(observer);
    return () => this.eventObservers.delete(observer);
  }

  /** Swap provider/model in place and persist the new session metadata. */
  async setProvider(
    provider: Provider,
    model: string,
    context?: Pick<SessionOptions, "contextBudgetTokens" | "compactionThresholdTokens" | "summarizeSpan">,
  ): Promise<void> {
    this.engine.setProvider(provider, model, context);
    this.meta.provider = { name: provider.name, model };
    await this.ensureSessionDir();
    await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2) + "\n", "utf8");
  }

  /** Persist provider work performed outside the main QueryEngine loop. */
  async recordAuxiliaryUsage(
    kind: "compaction" | "witness" | "memory" | "other",
    provider: string,
    model: string,
    usage: Usage,
  ): Promise<void> {
    await this.ensureSessionDir();
    this.persistEvent({
      type: "auxiliary_usage",
      kind,
      provider,
      model,
      usage: { ...usage, modelCalls: usage.modelCalls ?? 1 },
    });
    await this.flush();
  }

  /** Stop the in-flight turn; the session stays alive for the next message. */
  interrupt(): void {
    this.engine.interrupt();
  }

  /** Append a user message and stream the turn. Events persist to rollout. */
  async *send(text: string): AsyncGenerator<TurnEvent> {
    yield* this.sendContent([{ type: "text", text }]);
  }

  /** Append arbitrary user content (text + image blocks) and stream the turn. */
  async *sendContent(content: ContentBlock[]): AsyncGenerator<TurnEvent> {
    await this.ensureSessionDir();
    this.engine.appendUserMessageContent(content);
    yield* this.streamAndPersist();
  }

  /**
   * Re-stream the CURRENT pending turn without appending a new user message.
   * Used to retry a turn that died on a provider-level failure after switching
   * to a healthy provider — the engine re-runs the same pending user message.
   */
  async *resumeTurn(): AsyncGenerator<TurnEvent> {
    await this.ensureSessionDir();
    yield* this.streamAndPersist();
  }

  private async *streamAndPersist(): AsyncGenerator<TurnEvent> {
    const preToolCheckpoints = new Map<string, string>();
    const toolNames = new Map<string, string>();
    let observedMutationAt = 0;
    let verificationGenerationAtObservedMutation = this.opts.verificationEvidence?.().mutationGeneration ?? 0;
    try {
      for await (const rawEvent of this.engine.streamTurn()) {
        let event = rawEvent;
        if (event.type === "tool_start") toolNames.set(event.id, event.name);
        if (event.type === "checkpoint_created" && event.toolUseId && event.reason === "pre_tool") {
          preToolCheckpoints.set(event.toolUseId, event.checkpointId);
        }

        // Shell/CodeMode tools cannot declare touched files up front. Their
        // pre-tool checkpoint is a full workspace snapshot, so diff it now and
        // promote discovered changes onto tool_end. Every UI consumer already
        // schedules verification from tool_end.touchedFiles; this closes the
        // bypass without duplicating scheduling logic in each surface.
        let preparedDiff: Awaited<ReturnType<typeof diffWorkspaceCheckpointUnified>> | null = null;
        if (event.type === "tool_end" && (!event.touchedFiles || event.touchedFiles.length === 0)) {
          const checkpointId = preToolCheckpoints.get(event.id);
          if (checkpointId) {
            try {
              preparedDiff = await diffWorkspaceCheckpointUnified(this.opts.workspace, checkpointId);
            } catch (error) {
              // Opaque execution tools can mutate through arbitrary programs
              // (`node generator.mjs`, build scripts, formatters). If their
              // checkpoint diff fails, failing open would label the turn
              // not_applicable. Arm proof debt with an explicit sentinel and
              // surface the unavailable diff as a truncated workspace event.
              if (isOpaqueMutationTool(toolNames.get(event.id))) {
                const sentinel = path.resolve(this.opts.workspace, ".ares-unknown-mutation");
                const detail = error instanceof Error ? error.message : String(error);
                preparedDiff = {
                  files: [path.basename(sentinel)],
                  diff: `Checkpoint diff unavailable after ${toolNames.get(event.id)}: ${detail}`,
                  truncated: true,
                };
                event = { ...event, touchedFiles: [sentinel] };
              }
            }
            if (preparedDiff?.files.length) {
              event = {
                ...event,
                touchedFiles: preparedDiff.files.map((file) => path.resolve(this.opts.workspace, file)),
              };
            }
          } else if (isOpaqueMutationTool(toolNames.get(event.id))) {
            // Broad/home workspaces deliberately disable snapshots. Delegated
            // writers and arbitrary code execution must still fail closed:
            // exact files are unavailable, so arm an unknown mutation debt.
            const sentinel = path.resolve(this.opts.workspace, ".ares-unknown-mutation");
            preparedDiff = {
              files: [path.basename(sentinel)],
              diff: `Checkpoint unavailable after ${toolNames.get(event.id)}; workspace mutation scope is unknown.`,
              truncated: true,
            };
            event = { ...event, touchedFiles: [sentinel] };
          }
        }
        if (event.type === "tool_end" && event.touchedFiles?.length) {
          verificationGenerationAtObservedMutation = this.opts.verificationEvidence?.().mutationGeneration ?? verificationGenerationAtObservedMutation;
          observedMutationAt = Date.now();
        }
        if (event.type === "turn_end" && observedMutationAt > 0 && (!event.workStatus || event.workStatus === "not_applicable")) {
          const evidence = this.opts.verificationEvidence?.();
          const currentRun = evidence?.latestRunGeneration === evidence?.mutationGeneration;
          const newerRun = (evidence?.latestRunGeneration ?? -1) > verificationGenerationAtObservedMutation;
          const passedAfterMutation = currentRun && newerRun && evidence?.latestRunStatus === "passed" && evidence.latestRunStrength === "behavioral";
          const failedAfterMutation = currentRun && newerRun && evidence?.latestRunStatus === "failed";
          event = {
            ...event,
            workStatus: passedAfterMutation ? "verified" : failedAfterMutation ? "blocked" : "unverified",
          };
        }

        // Persistence is enqueued (not awaited) so a fast token stream never
        // waits on an NTFS append + Defender scan before reaching the consumer.
        this.persistEvent(event);
        this.notifyEvent(event);
        if (event.type === "turn_end") this.lastWorkStatus = event.workStatus ?? "not_applicable";
        // Friction telemetry rides the same tap — every surface (chat, TUI,
        // daemon) logs identically because they all stream through here.
        this.friction.record(event);
        // Durability barrier at the turn boundary: drain pending appends BEFORE
        // surfacing turn_end, so the rollout is complete on disk without holding
        // the turn "active" past the generator's return (which would reject the
        // user's immediate next message).
        if (event.type === "turn_end") await this.flush();
        yield event;

        if (event.type === "tool_end") {
          toolNames.delete(event.id);
          const checkpointId = preToolCheckpoints.get(event.id);
          if (!checkpointId) continue;
          const diff = preparedDiff ?? await diffWorkspaceCheckpointUnified(this.opts.workspace, checkpointId, event.touchedFiles).catch(() => null);
          if (!diff || !diff.diff) continue;
          const diffEvent: TurnEvent = {
            type: "workspace_diff",
            checkpointId,
            toolUseId: event.id,
            files: diff.files,
            diff: diff.diff,
            truncated: diff.truncated,
          };
          this.persistEvent(diffEvent);
          this.notifyEvent(diffEvent);
          yield diffEvent;
        }
      }
    } finally {
      // The turn's generator is done (completed, returned, or the consumer broke
      // out) — drop the engine's live abort controller so a Stop pressed before the
      // next turn arms its own is honored rather than swallowed (interrupt leak fix).
      this.engine.markTurnEnded();
    }
  }

  /** Read-only history snapshot. */
  history() {
    return this.engine.history();
  }

  /**
   * Persist an externally-driven engine event (the Vanguard drive) into this
   * session's rollout, so session history, restore after restart, and bug
   * reports include the turn — a drive conversation must be exactly as
   * durable as a native one.
   */
  async recordExternalEvent(event: TurnEvent): Promise<void> {
    await this.ensureSessionDir();
    this.persistEvent(event);
  }

  private async ensureSessionDir(): Promise<void> {
    // ALWAYS ensure the directory exists (mkdir recursive is idempotent + cheap).
    // A resumed/opened session is constructed with metaWritten=true on the
    // ASSUMPTION its dir is already on disk — but that's false when the dir was
    // never created (model_switch/setProvider firing before the first turn, or a
    // session opened into a fresh workspace). Gating the mkdir on metaWritten made
    // setProvider's writeFile(metaPath) ENOENT ("no such file … meta.json"). The
    // flag only governs the one-time meta WRITE, not directory creation.
    await mkdir(path.dirname(this.eventsPath), { recursive: true });
    if (this.metaWritten) return;
    await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2) + "\n", "utf8");
    this.metaWritten = true;
  }

  /**
   * Enqueue a rollout append WITHOUT blocking the caller. seq is assigned
   * synchronously (preserving order); the actual fs append is serialized on
   * ioChain so writes never interleave and the hot path never waits on disk.
   */
  private persistEvent(event: TurnEvent): void {
    const persistedEvent: TurnEvent =
      event.type === "turn_end"
        ? { ...event, provider: this.meta.provider.name, model: this.meta.provider.model }
        : event;
    const entry: RolloutEntry = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      event: persistedEvent,
    };
    const line = JSON.stringify(entry) + "\n";
    this.ioChain = this.ioChain
      .catch(() => undefined)
      .then(() => appendFile(this.eventsPath, line, "utf8"))
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        // Surface the FIRST failure immediately (disk full, perms, path gone) —
        // the rollout is the durable session history; silently losing it until
        // someone happens to await flush() was how sessions vanished with no
        // trace. Log once (not per-event) so a persistent fault isn't spammy.
        if (!this.ioError) {
          try {
            process.stderr.write(`[session] rollout persistence failing (${this.eventsPath}): ${err.message}\n`);
          } catch { /* stderr unavailable */ }
        }
        this.ioError = err;
      });
  }

  /** Await all pending rollout appends. */
  private async flush(): Promise<void> {
    await this.ioChain;
    if (this.ioError) {
      throw new Error(`session rollout persistence failed: ${this.ioError.message}`, { cause: this.ioError });
    }
  }

  private notifyEvent(event: TurnEvent): void {
    for (const observer of this.eventObservers) {
      try {
        observer(event);
      } catch {
        // Observability cannot invalidate a completed tool call or model turn.
      }
    }
  }
}

export interface SessionSummary {
  id: string;
  workspace: string;
  provider: ProviderInfo;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  preview: string;
  /** Owner-set custom name (meta.label). Falls back to the preview in the UI. */
  label?: string;
}

export interface SessionSnapshot {
  meta: SessionMeta;
  messages: Message[];
  /** Latest durable TodoWrite state, folded from rollout events. */
  todos: Todo[];
  nextSeq: number;
  eventCount: number;
  preview: string;
  compacted: boolean;
  omittedMessageCount: number;
  replayedMessageCount: number;
}

export interface LoadSessionSnapshotOptions {
  maxMessages?: number;
}

export async function listSessions(workspace: string, limit = 20): Promise<SessionSummary[]> {
  const root = path.join(workspace, ".ares", "sessions");
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const summaries = await Promise.all(
    dirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<SessionSummary | null> => {
        const sessionDir = path.join(root, entry.name);
        const meta = await readSessionMeta(sessionDir);
        if (!meta) return null;
        const eventsPath = path.join(sessionDir, "events.jsonl");
        const eventsText = await readFile(eventsPath, "utf8").catch(() => "");
        const eventCount = eventsText.trim() ? eventsText.trim().split(/\r?\n/).length : 0;
        const updated = await stat(eventsPath).catch(() => null);
        const preview = previewFromEvents(eventsText);
        return {
          id: meta.id,
          workspace: meta.workspace,
          provider: meta.provider,
          createdAt: meta.createdAt,
          updatedAt: updated?.mtime.toISOString() ?? meta.createdAt,
          eventCount,
          preview,
          label: meta.label,
        };
      }),
  );
  return summaries
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export async function loadSessionSnapshot(
  workspace: string,
  sessionId: string,
  opts: LoadSessionSnapshotOptions = {},
): Promise<SessionSnapshot> {
  const sessionDir = path.join(workspace, ".ares", "sessions", sessionId);
  const meta = await readSessionMeta(sessionDir);
  if (!meta) throw new Error(`session not found: ${sessionId}`);
  const eventsPath = path.join(sessionDir, "events.jsonl");
  const eventsText = await readFile(eventsPath, "utf8").catch(() => "");
  const entries = parseRolloutEntries(eventsText);
  const rawMessages = messagesFromRollout(entries);
  const todos = latestTodosFromRollout(entries);
  const replay = compactReplayMessages(rawMessages, sessionId, opts.maxMessages);
  const nextSeq = entries.length > 0 ? Math.max(...entries.map((entry) => entry.seq)) + 1 : 0;
  return {
    meta,
    messages: replay.messages,
    todos,
    nextSeq,
    eventCount: entries.length,
    preview: previewFromMessages(rawMessages),
    compacted: replay.compacted,
    omittedMessageCount: replay.omittedMessageCount,
    replayedMessageCount: replay.messages.length,
  };
}

function latestTodosFromRollout(entries: readonly RolloutEntry[]): Todo[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index].event;
    if (event.type === "todo_updated") return event.todos.map((todo) => ({ ...todo }));
  }
  return [];
}

/** The FULL raw rollout for a session — every persisted event, untouched by
 *  the compaction that loadSessionSnapshot applies. This is what a bug report
 *  ships so the owner can see exactly what the agent did: every tool call, its
 *  input/output, every error, and all generated code. Never trims content. */
export interface SessionRollout {
  meta: SessionMeta;
  entries: RolloutEntry[];
  eventCount: number;
  toolFailures: number;
}

export async function loadSessionRollout(workspace: string, sessionId: string): Promise<SessionRollout> {
  const sessionDir = path.join(workspace, ".ares", "sessions", path.basename(sessionId));
  const meta = await readSessionMeta(sessionDir);
  if (!meta) throw new Error(`session not found: ${sessionId}`);
  const eventsText = await readFile(path.join(sessionDir, "events.jsonl"), "utf8").catch(() => "");
  const entries = parseRolloutEntries(eventsText);
  const toolFailures = entries.filter((e) => e.event.type === "tool_error").length;
  return { meta, entries, eventCount: entries.length, toolFailures };
}

/** Permanently remove a session's on-disk transcript + metadata. Idempotent:
 *  a missing session resolves false rather than throwing. */
export async function deleteSession(workspace: string, sessionId: string): Promise<boolean> {
  const safe = path.basename(sessionId); // never escape the sessions root
  if (!safe || safe !== sessionId) return false;
  const sessionDir = path.join(workspace, ".ares", "sessions", safe);
  const meta = await readSessionMeta(sessionDir);
  if (!meta) return false;
  await rm(sessionDir, { recursive: true, force: true });
  return true;
}

/** Rename a session by setting its meta.label. Empty/whitespace clears the label
 *  (the UI falls back to the preview). Returns false if the session is missing. */
export async function renameSession(workspace: string, sessionId: string, label: string): Promise<boolean> {
  const safe = path.basename(sessionId);
  if (!safe || safe !== sessionId) return false;
  const sessionDir = path.join(workspace, ".ares", "sessions", safe);
  const meta = await readSessionMeta(sessionDir);
  if (!meta) return false;
  const trimmed = label.trim().slice(0, 120);
  const next: SessionMeta = { ...meta };
  if (trimmed) next.label = trimmed;
  else delete next.label;
  await writeFile(path.join(sessionDir, "meta.json"), JSON.stringify(next, null, 2) + "\n", "utf8");
  return true;
}

async function readSessionMeta(sessionDir: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

function parseRolloutEntries(text: string): RolloutEntry[] {
  const entries: RolloutEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as RolloutEntry);
    } catch {
      // Ignore a torn/corrupt tail line; the next append stays usable.
    }
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

function messagesFromRollout(entries: readonly RolloutEntry[]): Message[] {
  const messages: Message[] = [];
  let pendingToolResults: ToolResultBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({
      id: `replay_tool_${messages.length}`,
      role: "user", // Anthropic shape: tool_result blocks live in user-role messages
      content: pendingToolResults,
      createdAt: new Date().toISOString(),
      metadata: { source: "session-replay" },
    });
    pendingToolResults = [];
  };

  for (const entry of entries) {
    const event = entry.event;
    if (event.type === "turn_start") {
      flushToolResults();
      messages.push(event.userMessage);
      continue;
    }
    if (event.type === "message_done") {
      flushToolResults();
      messages.push(event.message);
      continue;
    }
    if (event.type === "tool_end") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: event.id,
        content: stringifyReplayOutput(event.output),
      });
      continue;
    }
    if (event.type === "tool_error") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: event.id,
        content: event.error,
        is_error: true,
      });
      continue;
    }
    if (event.type === "compaction" && Array.isArray(event.messages)) {
      pendingToolResults = [];
      messages.length = 0;
      messages.push(...event.messages);
    }
  }
  flushToolResults();
  return messages;
}

function stringifyReplayOutput(output: unknown): string {
  return stringifyModelToolOutput(output);
}

function compactReplayMessages(
  messages: readonly Message[],
  sessionId: string,
  maxMessages?: number,
): { messages: Message[]; compacted: boolean; omittedMessageCount: number } {
  if (!maxMessages || messages.length <= maxMessages) {
    return { messages: [...messages], compacted: false, omittedMessageCount: 0 };
  }

  const tailBudget = Math.max(4, maxMessages - 1);
  const tail = messages.slice(-tailBudget);
  while (tail.length > 0 && tail[0].role !== "user") tail.shift();
  if (tail.length === 0) tail.push(...messages.slice(-Math.min(tailBudget, messages.length)));

  const omitted = messages.slice(0, messages.length - tail.length);
  const summary: Message = {
    id: `session_summary_${sessionId}`,
    role: "system",
    content: [{ type: "text", text: buildReplaySummary(sessionId, omitted) }],
    createdAt: new Date().toISOString(),
    metadata: { source: "session-replay-compaction", omittedMessageCount: omitted.length },
  };
  return {
    messages: [summary, ...tail],
    compacted: true,
    omittedMessageCount: omitted.length,
  };
}

function buildReplaySummary(sessionId: string, omitted: readonly Message[]): string {
  const roleCounts = omitted.reduce<Record<string, number>>((counts, message) => {
    counts[message.role] = (counts[message.role] ?? 0) + 1;
    return counts;
  }, {});
  const toolResults = omitted.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
  const errorCount = toolResults.filter((block) => block.type === "tool_result" && block.is_error).length;
  const recentUsers = omitted
    .filter((message) => message.role === "user")
    .map((message) => messageText(message).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-8);
  const recentAssistants = omitted
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-5);

  const lines = [
    `Previous Ares session ${sessionId} was compacted before resume.`,
    `Older replay omitted ${omitted.length} message(s): user=${roleCounts.user ?? 0}, assistant=${roleCounts.assistant ?? 0}, tool=${roleCounts.tool ?? 0}.`,
    `Omitted tool result blocks: ${toolResults.length}, errors: ${errorCount}.`,
  ];
  if (recentUsers.length > 0) {
    lines.push("Recent omitted user requests:");
    for (const text of recentUsers) lines.push(`- ${truncateSummaryText(text)}`);
  }
  if (recentAssistants.length > 0) {
    lines.push("Recent omitted assistant replies:");
    for (const text of recentAssistants) lines.push(`- ${truncateSummaryText(text)}`);
  }
  lines.push("The exact event log remains on disk under .ares/sessions if a tool needs to inspect it.");
  return lines.join("\n");
}

function truncateSummaryText(text: string): string {
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function previewFromEvents(text: string): string {
  return previewFromMessages(messagesFromRollout(parseRolloutEntries(text)));
}

function previewFromMessages(messages: readonly Message[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const text = lastUser ? messageText(lastUser).replace(/\s+/g, " ").trim() : "";
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}
