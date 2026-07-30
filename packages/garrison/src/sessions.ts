// SessionManager — the Garrison's session table. Each session owns a
// QueryEngine built by an injected SessionFactory (tests inject
// MockEchoProvider; production composition wires real providers/tools).
//
// CONTRACT:
//   - send() drives exactly one streamTurn() and fans every TurnEvent to all
//     attached subscribers, in order. Every subscriber sees the same sequence.
//   - Sessions survive subscriber detach; a session with zero subscribers
//     keeps running and keeps persisting its rollout.
//   - A busy session rejects a concurrent send with SessionBusyError — the
//     gateway turns that into a clean error frame.
//   - Every event appends (best-effort, ordered) to
//     <home>/garrison/sessions/<id>.jsonl as {ts,event}; a sidecar
//     <id>.meta.json carries id/title/provider/model/workspace/createdAt.
//
// REHYDRATION (what is and is not restored):
//   Restored — session ids, titles, provider/model/workspace hints (from
//   meta.json when present), and the full Message[] history reconstructed from
//   the rollout: turn_start carries the user message verbatim (including any
//   injected system_reminder blocks), message_done carries the assistant
//   message verbatim (including thinking and tool_use blocks), and tool
//   results are rebuilt as user-role tool_result messages from
//   tool_end/tool_error events, re-stringified through the same
//   stringifyModelToolOutput the live engine used.
//   NOT restored — a turn that died before message_done contributes only its
//   user message (no reply); pending permission prompts, busy flags, abort
//   state, and subscribers are all transient and start fresh; tool_result
//   content is byte-identical to what the model originally saw only when the
//   tool output was a string or JSON that round-trips stably.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  messageText,
  type Message,
  type PermissionPromptDecision,
  type ToolResultBlock,
  type TurnEvent,
} from "@ares/protocol";
import { FrictionRecorder, registerSessionLocation, stringifyModelToolOutput, type QueryEngine, type ToolPermissionRequest } from "@ares/core";
import type { SessionSummary } from "./protocol.js";
import { garrisonDir } from "./token.js";

// ─── Factory (injected composition seam) ───────────────────────────────

export interface SessionFactoryRequest {
  sessionId: string;
  /** Provider/model/workspace hints from the client frame; the factory interprets them. */
  provider?: string;
  model?: string;
  workspace?: string;
  /** Abort signal for this session's turns; interrupt() aborts it. Wire into QueryEngineConfig.signal. */
  signal: AbortSignal;
  /** Gateway-backed permission prompt; wire into QueryEngineConfig.requestPermission. */
  requestPermission: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision>;
}

export interface SessionFactoryResult {
  engine: QueryEngine;
  providerName: string;
  model: string;
  workspace: string;
}

export type SessionFactory = (req: SessionFactoryRequest) => SessionFactoryResult;

// ─── Errors (names are part of the gateway's error-frame contract) ──────

export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`unknown session: ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

export class SessionBusyError extends Error {
  constructor(sessionId: string) {
    super(`session busy: ${sessionId}`);
    this.name = "SessionBusyError";
  }
}

// ─── Manager ─────────────────────────────────────────────────────────────

export type SessionSubscriber = (event: TurnEvent) => void;

export interface SessionManagerOptions {
  home: string;
  factory: SessionFactory;
  /** Unanswered permission prompts auto-deny after this long (default 5 min). */
  permissionTimeoutMs?: number;
  now?: () => number;
}

interface LiveSession {
  id: string;
  title: string;
  titled: boolean;
  provider: string;
  model: string;
  workspace: string;
  createdAt: string;
  busy: boolean;
  engine: QueryEngine;
  friction: FrictionRecorder;
  controller: AbortController;
  subscribers: Set<SessionSubscriber>;
  /** Serializes rollout/meta writes so JSONL lines land in event order. */
  ioChain: Promise<void>;
  /** Original client hints, replayed when the engine is rebuilt after an interrupt. */
  requested: { provider?: string; model?: string; workspace?: string };
}

interface PendingPermission {
  resolve: (decision: PermissionPromptDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const FALLBACK_TITLE = "untitled session";
const TITLE_MAX_CHARS = 64;

export class SessionManager {
  private readonly live = new Map<string, LiveSession>();
  /** In-flight lazy rehydrations, deduped by id so two concurrent sends for the
   *  same just-restored session don't spawn it twice. */
  private readonly rehydrating = new Map<string, Promise<LiveSession | null>>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly home: string;
  private readonly factory: SessionFactory;
  private readonly permissionTimeoutMs: number;
  private readonly now: () => number;
  private readonly bootAt: number;
  private lastSend: number | undefined;

  constructor(opts: SessionManagerOptions) {
    this.home = opts.home;
    this.factory = opts.factory;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    this.bootAt = this.now();
  }

  create(opts: { provider?: string; model?: string; workspace?: string } = {}): SessionSummary {
    const session = this.spawn({ id: `sess_${randomUUID()}`, ...opts });
    return this.summarize(session);
  }

  has(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  list(): SessionSummary[] {
    return [...this.live.values()].map((s) => this.summarize(s));
  }

  /** Subscribe to a session's TurnEvents. Returns the detach function. */
  attach(sessionId: string, subscriber: SessionSubscriber): () => void {
    const session = this.get(sessionId);
    session.subscribers.add(subscriber);
    return () => session.subscribers.delete(subscriber);
  }

  /**
   * Append a user message and drive one full turn, fanning every event to all
   * subscribers. Resolves when the turn ends. Rejects immediately with
   * SessionBusyError when a turn is already in flight.
   */
  async send(sessionId: string, text: string): Promise<void> {
    // Self-heal: a session whose rollout is on disk but isn't live (it appeared
    // after boot, failed boot rehydration, or a client references it across a
    // restart) is lazily rebuilt from its rollout rather than rejected.
    const session = (await this.ensureLiveSession(sessionId)) ?? this.get(sessionId);
    if (session.busy) throw new SessionBusyError(sessionId);
    session.busy = true;
    this.lastSend = this.now();
    if (!session.titled) {
      session.title = deriveTitle(text);
      session.titled = true;
      this.queueMetaWrite(session);
    }
    try {
      session.engine.appendUserMessage(text);
      for await (const event of session.engine.streamTurn()) {
        this.appendRollout(session, event);
        session.friction.record(event);
        // Match Core Session's turn boundary: when a client observes turn_end,
        // the complete rollout and friction envelope are already durable. This
        // closes a real reboot/rehydration race exposed by the front-door test.
        if (event.type === "turn_end") {
          await Promise.all([session.ioChain, session.friction.settle()]);
        }
        this.fanOut(session, event);
      }
    } finally {
      session.busy = false;
      if (session.controller.signal.aborted) this.rebuildEngine(session);
      // Turn completion is the durability boundary for the shared telemetry
      // plane, matching core Session. Recording stays off the streaming path.
      await session.friction.settle();
    }
  }

  /**
   * Abort the in-flight turn. Best-effort: providers/tools that ignore the
   * signal finish their current step. Returns false when the session is idle.
   * The session itself stays alive — the engine is rebuilt (history intact)
   * with a fresh signal once the aborted turn unwinds.
   */
  interrupt(sessionId: string): boolean {
    const session = this.get(sessionId);
    if (!session.busy) return false;
    session.controller.abort();
    return true;
  }

  /** Resolve a pending permission prompt raised by a tool in this session. */
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionPromptDecision,
  ): boolean {
    const key = permissionKey(sessionId, requestId);
    const pending = this.pendingPermissions.get(key);
    if (!pending) return false;
    this.pendingPermissions.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  /** Epoch ms of the last send anywhere (boot time before the first send). */
  lastActivityAt(): number {
    return this.lastSend ?? this.bootAt;
  }

  /** Await all queued rollout/meta writes (tests and graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.live.values()].flatMap((s) => [s.ioChain, s.friction.settle()]));
  }

  /**
   * Recreate sessions from prior rollouts on disk. Already-live ids are left
   * alone; a factory failure skips that session (its files stay untouched).
   * Returns the summaries of what came back.
   */
  async rehydrate(): Promise<SessionSummary[]> {
    const prior = await rehydrateSessions(this.home);
    const restored: SessionSummary[] = [];
    for (const p of prior) {
      if (this.live.has(p.id)) continue;
      let session: LiveSession;
      try {
        session = this.spawn({
          id: p.id,
          provider: p.provider,
          model: p.model,
          workspace: p.workspace,
          createdAt: p.createdAt,
          title: p.title,
          titled: p.title !== FALLBACK_TITLE,
        });
      } catch {
        continue;
      }
      if (p.messages.length > 0) session.engine.hydrate(p.messages);
      restored.push(this.summarize(session));
    }
    return restored;
  }

  /**
   * Ensure a session is live, lazily rebuilding it from its rollout on disk when
   * it isn't already in memory. Returns its summary, or null when no such session
   * exists on disk (a genuinely unknown id). Unlike rehydrate(), this targets ONE
   * id on demand — the gateway calls it before attach/send so a session survives
   * a crash/restart even if it wasn't restored at boot.
   */
  async ensureLive(sessionId: string): Promise<SessionSummary | null> {
    const session = await this.ensureLiveSession(sessionId);
    return session ? this.summarize(session) : null;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private get(sessionId: string): LiveSession {
    const session = this.live.get(sessionId);
    if (!session) throw new UnknownSessionError(sessionId);
    return session;
  }

  /** live → in-flight rehydration → rollout-on-disk → null. Deduped per id. */
  private ensureLiveSession(sessionId: string): Promise<LiveSession | null> {
    const existing = this.live.get(sessionId);
    if (existing) return Promise.resolve(existing);
    const inflight = this.rehydrating.get(sessionId);
    if (inflight) return inflight;
    const job = (async (): Promise<LiveSession | null> => {
      const restored = await rehydrateSession(this.home, sessionId);
      if (!restored) return null;
      // A concurrent path may have spawned it while we read disk.
      const racewinner = this.live.get(sessionId);
      if (racewinner) return racewinner;
      let session: LiveSession;
      try {
        session = this.spawn({
          id: restored.id,
          provider: restored.provider,
          model: restored.model,
          workspace: restored.workspace,
          createdAt: restored.createdAt,
          title: restored.title,
          titled: restored.title !== FALLBACK_TITLE,
        });
      } catch {
        return null;
      }
      if (restored.messages.length > 0) session.engine.hydrate(restored.messages);
      return session;
    })().finally(() => this.rehydrating.delete(sessionId));
    this.rehydrating.set(sessionId, job);
    return job;
  }

  private spawn(p: {
    id: string;
    provider?: string;
    model?: string;
    workspace?: string;
    createdAt?: string;
    title?: string;
    titled?: boolean;
  }): LiveSession {
    const controller = new AbortController();
    const made = this.factory({
      sessionId: p.id,
      provider: p.provider,
      model: p.model,
      workspace: p.workspace,
      signal: controller.signal,
      requestPermission: this.permissionHandlerFor(p.id),
    });
    const friction = new FrictionRecorder(p.id, {
      dir: path.join(this.home, "telemetry"),
      source: "garrison",
      workspace: made.workspace,
      provider: made.providerName,
      model: made.model,
      location: {
        registryHome: this.home,
        rolloutPath: rolloutPath(this.home, p.id),
        metaPath: metaPath(this.home, p.id),
        format: "garrison-rollout-v1",
      },
    });
    const session: LiveSession = {
      id: p.id,
      title: p.title ?? FALLBACK_TITLE,
      titled: p.titled ?? false,
      provider: made.providerName,
      model: made.model,
      workspace: made.workspace,
      createdAt: p.createdAt ?? new Date(this.now()).toISOString(),
      busy: false,
      engine: made.engine,
      friction,
      controller,
      subscribers: new Set(),
      ioChain: fs
        .mkdir(sessionsDir(this.home), { recursive: true })
        .then(() => undefined)
        .catch(() => undefined),
      requested: { provider: p.provider, model: p.model, workspace: p.workspace },
    };
    this.live.set(p.id, session);
    this.queueMetaWrite(session);
    return session;
  }

  private summarize(s: LiveSession): SessionSummary {
    return { id: s.id, title: s.title, model: s.model, provider: s.provider, busy: s.busy };
  }

  private fanOut(session: LiveSession, event: TurnEvent): void {
    for (const subscriber of [...session.subscribers]) {
      try {
        subscriber(event);
      } catch {
        // A throwing subscriber never breaks the turn or its peers.
      }
    }
  }

  private appendRollout(session: LiveSession, event: TurnEvent): void {
    const line = JSON.stringify({ ts: new Date(this.now()).toISOString(), event }) + "\n";
    const file = rolloutPath(this.home, session.id);
    session.ioChain = session.ioChain
      .then(() => fs.appendFile(file, line, "utf8"))
      .catch(() => {
        // Best-effort: a failed disk write never breaks the live turn.
      });
  }

  private queueMetaWrite(session: LiveSession): void {
    const file = metaPath(this.home, session.id);
    const meta = {
      id: session.id,
      title: session.title,
      provider: session.provider,
      model: session.model,
      workspace: session.workspace,
      createdAt: session.createdAt,
    };
    session.ioChain = session.ioChain
      .then(() => fs.writeFile(file, JSON.stringify(meta, null, 2) + "\n", "utf8"))
      .catch(() => {});
  }

  private permissionHandlerFor(sessionId: string) {
    return (request: ToolPermissionRequest): Promise<PermissionPromptDecision> =>
      new Promise((resolve) => {
        const requestId = request.id ?? `perm_${randomUUID()}`;
        const key = permissionKey(sessionId, requestId);
        const timer = setTimeout(() => {
          this.pendingPermissions.delete(key);
          resolve("deny");
        }, this.permissionTimeoutMs);
        timer.unref?.();
        this.pendingPermissions.set(key, { resolve, timer });
      });
  }

  /**
   * After an interrupted turn, the old engine's signal is permanently aborted
   * (QueryEngine captures it at construction). Rebuild via the factory with a
   * fresh AbortController and carry the history over — public API only.
   */
  private rebuildEngine(session: LiveSession): void {
    try {
      const controller = new AbortController();
      const made = this.factory({
        sessionId: session.id,
        provider: session.requested.provider,
        model: session.requested.model,
        workspace: session.requested.workspace,
        signal: controller.signal,
        requestPermission: this.permissionHandlerFor(session.id),
      });
      made.engine.hydrate([...session.engine.history()]);
      session.engine = made.engine;
      session.controller = controller;
      session.provider = made.providerName;
      session.model = made.model;
      session.workspace = made.workspace;
      session.friction.updateContext({
        workspace: made.workspace,
        provider: made.providerName,
        model: made.model,
      });
      void registerSessionLocation({
        sessionId: session.id,
        source: "garrison",
        format: "garrison-rollout-v1",
        workspace: made.workspace,
        rolloutPath: rolloutPath(this.home, session.id),
        metaPath: metaPath(this.home, session.id),
      }, { home: this.home });
      this.queueMetaWrite(session);
    } catch {
      // Factory refused: keep the old engine — turns may report interrupted,
      // but the session and its history stay reachable.
    }
  }
}

function permissionKey(sessionId: string, requestId: string): string {
  return `${sessionId} ${requestId}`;
}

function deriveTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return FALLBACK_TITLE;
  return collapsed.length > TITLE_MAX_CHARS ? `${collapsed.slice(0, TITLE_MAX_CHARS - 1)}…` : collapsed;
}

// ─── Rollout files + rehydration ─────────────────────────────────────────

export function sessionsDir(home: string): string {
  return path.join(garrisonDir(home), "sessions");
}

export function rolloutPath(home: string, sessionId: string): string {
  return path.join(sessionsDir(home), `${sessionId}.jsonl`);
}

function metaPath(home: string, sessionId: string): string {
  return path.join(sessionsDir(home), `${sessionId}.meta.json`);
}

export interface RehydratedSession {
  id: string;
  title: string;
  provider?: string;
  model?: string;
  workspace?: string;
  createdAt?: string;
  /** Reconstructed history; empty when the rollout holds no message_done events. */
  messages: Message[];
  eventCount: number;
}

interface SessionMetaFile {
  id?: string;
  title?: string;
  provider?: string;
  model?: string;
  workspace?: string;
  createdAt?: string;
}

/**
 * List prior sessions from <home>/garrison/sessions, each with its
 * reconstructed Message[] history (see the file header for exactly what is
 * and is not restored). Missing dir or unreadable files yield an empty list /
 * skipped entries — boot never fails on a damaged rollout.
 */
export async function rehydrateSessions(home: string): Promise<RehydratedSession[]> {
  const dir = sessionsDir(home);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: RehydratedSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!id) continue;
    const text = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
    const events = parseRolloutLines(text);
    const messages = messagesFromRollout(events);
    const meta = await readMetaFile(metaPath(home, id));
    const title = nonEmpty(meta?.title) ?? titleFromMessages(messages) ?? FALLBACK_TITLE;
    out.push({
      id,
      title,
      provider: nonEmpty(meta?.provider),
      model: nonEmpty(meta?.model),
      workspace: nonEmpty(meta?.workspace),
      createdAt: nonEmpty(meta?.createdAt),
      messages,
      eventCount: events.length,
    });
  }
  return out.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/**
 * Reconstruct ONE session from its rollout on disk, or null when it has no
 * rollout file. Same restoration rules as rehydrateSessions (see file header).
 */
export async function rehydrateSession(home: string, sessionId: string): Promise<RehydratedSession | null> {
  const text = await fs.readFile(rolloutPath(home, sessionId), "utf8").catch(() => null);
  if (text === null) return null;
  const events = parseRolloutLines(text);
  const messages = messagesFromRollout(events);
  const meta = await readMetaFile(metaPath(home, sessionId));
  const title = nonEmpty(meta?.title) ?? titleFromMessages(messages) ?? FALLBACK_TITLE;
  return {
    id: sessionId,
    title,
    provider: nonEmpty(meta?.provider),
    model: nonEmpty(meta?.model),
    workspace: nonEmpty(meta?.workspace),
    createdAt: nonEmpty(meta?.createdAt),
    messages,
    eventCount: events.length,
  };
}

async function readMetaFile(file: string): Promise<SessionMetaFile | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as SessionMetaFile) : null;
  } catch {
    return null;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRolloutLines(text: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { event?: TurnEvent };
      if (entry && typeof entry === "object" && entry.event && typeof entry.event.type === "string") {
        events.push(entry.event);
      }
    } catch {
      // Torn/corrupt tail line — skip it; the file stays usable.
    }
  }
  return events;
}

/**
 * Rebuild the Message[] a hydrated engine needs: user messages from
 * turn_start, assistant messages from message_done, and tool_result user
 * messages reassembled from tool_end/tool_error events (Anthropic shape:
 * tool results ride in user-role messages).
 */
function messagesFromRollout(events: readonly TurnEvent[]): Message[] {
  const messages: Message[] = [];
  let pendingToolResults: ToolResultBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({
      id: `rehydrate_tool_${messages.length}`,
      role: "user",
      content: pendingToolResults,
      createdAt: new Date().toISOString(),
      metadata: { source: "garrison-rehydrate" },
    });
    pendingToolResults = [];
  };

  for (const event of events) {
    if (event.type === "turn_start") {
      flushToolResults();
      messages.push(event.userMessage);
    } else if (event.type === "message_done") {
      flushToolResults();
      messages.push(event.message);
    } else if (event.type === "tool_end") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: event.id,
        content: stringifyModelToolOutput(event.output),
      });
    } else if (event.type === "tool_error") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: event.id,
        content: event.error,
        is_error: true,
      });
    }
  }
  flushToolResults();
  return messages;
}

function titleFromMessages(messages: readonly Message[]): string | undefined {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return undefined;
  const text = messageText(firstUser).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1)}…` : text;
}
