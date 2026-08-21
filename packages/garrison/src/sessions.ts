// SessionManager — the Garrison's session table. Each entry owns either the
// canonical Core Session runtime or a legacy QueryEngine built by an injected
// SessionFactory (tests and embedders can keep the small legacy seam while
// production gets the full durable session harness).
//
// CONTRACT:
//   - send() drives exactly one streamTurn() and fans every TurnEvent to all
//     attached subscribers, in order. Every subscriber sees the same sequence.
//   - Sessions survive subscriber detach; a session with zero subscribers
//     keeps running and keeps persisting its rollout.
//   - Legacy QueryEngine sessions reject a concurrent send with
//     SessionBusyError. Canonical Core Sessions durably admit concurrent queue
//     and steer inputs; their own runner owns serialization and recovery.
//   - Every event appends (best-effort, ordered) to
//     <home>/garrison/sessions/<id>.jsonl as {ts,event}; a sidecar
//     <id>.meta.json carries id/title/provider/model/workspace/createdAt.
//
// REHYDRATION (what is and is not restored):
//   Restored — session ids, titles, provider/model/workspace hints (from
//   meta.json when present), and the canonical Message[] history reconstructed
//   from the rollout. input_admitted/turn_start carry the user message verbatim
//   (and are identity-deduped), message_done carries the assistant message,
//   tool results are rebuilt as user-role tool_result messages, and a compaction
//   event replaces everything before it with the exact post-compaction snapshot.
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
import {
  FrictionRecorder,
  projectMessagesFromKernel,
  registerSessionLocation,
  stringifyModelToolOutput,
  type JsonValue,
  type QueryEngine,
  type SessionKernelStore,
  type SessionRecord,
  type ToolPermissionRequest,
} from "@ares/core";
import type { Session as CoreSession } from "@ares/core";
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
  /** Canonical replay state supplied when this is a resumed Garrison session. */
  initialMessages?: readonly Message[];
  /** Number of durable Garrison events already present for sequence continuity. */
  initialEventCount?: number;
  title?: string;
  createdAt?: string;
}

interface SessionFactoryMetadata {
  providerName: string;
  model: string;
  workspace: string;
}

/**
 * Backward-compatible composition seam. New hosts should return Core Session;
 * the QueryEngine arm remains for lightweight tests and existing embedders.
 */
export type SessionFactoryResult = SessionFactoryMetadata & (
  | { session: CoreSession; engine?: never }
  | { engine: QueryEngine; session?: never }
);

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

export interface SessionSendOptions {
  /** Stable client identity for one logical input. A retry must reuse it. */
  inputId?: string;
  /** Queue a later turn or steer the active turn at its next safe boundary. */
  delivery?: "queue" | "steer";
}

export interface SessionManagerOptions {
  home: string;
  factory: SessionFactory;
  /** Canonical authority used by production rehydration. When omitted, this
   * manager is an explicitly legacy JSON-rollout host. */
  sessionKernel?: SessionKernelStore;
  /** Unanswered permission prompts auto-deny after this long (default 5 min). */
  permissionTimeoutMs?: number;
  /**
   * Called after a turn reaches its durable turn_end boundary. This is the
   * garrison's operator wake producer — before it existed, `garrison serve`
   * had ZERO event producers and the background loop was pure 30-minute cron.
   * Best-effort: a throw never breaks the event stream.
   */
  onTurnSettled?: (sessionId: string) => void;
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
  /** Canonical sessions may have several admitted callers while exactly one
   * runner owns provider/tool execution. busy remains true until all settle. */
  inFlightSends: number;
  engine: QueryEngine;
  coreSession?: CoreSession;
  /** Legacy engines need Garrison telemetry; Core Session already owns it. */
  friction?: FrictionRecorder;
  /** Admissions mirrored through observeEvents; suppress if the runtime also
   * yields the same event on its public stream. Cleared at each turn boundary. */
  mirroredAdmissionIds: Set<string>;
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
  private readonly sessionKernel?: SessionKernelStore;
  private readonly permissionTimeoutMs: number;
  private readonly onTurnSettled?: (sessionId: string) => void;
  private readonly now: () => number;
  private readonly bootAt: number;
  private lastSend: number | undefined;

  constructor(opts: SessionManagerOptions) {
    this.home = opts.home;
    this.factory = opts.factory;
    this.sessionKernel = opts.sessionKernel;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 5 * 60_000;
    this.onTurnSettled = opts.onTurnSettled;
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
   * subscribers. Canonical sessions accept concurrent queue/steer admissions;
   * legacy engines reject overlap because they have no durable input queue.
   */
  async send(sessionId: string, text: string, options: SessionSendOptions = {}): Promise<void> {
    if (options.inputId !== undefined && (!options.inputId.trim() || options.inputId.length > 1_024)) {
      throw new Error("session inputId must be a non-empty string of at most 1024 characters");
    }
    const inputId = options.inputId ?? `input_${randomUUID()}`;
    const delivery = options.delivery ?? "queue";
    // Self-heal: a session whose rollout is on disk but isn't live (it appeared
    // after boot, failed boot rehydration, or a client references it across a
    // restart) is lazily rebuilt from its rollout rather than rejected.
    const session = (await this.ensureLiveSession(sessionId)) ?? this.get(sessionId);
    if (!session.coreSession && session.busy) throw new SessionBusyError(sessionId);
    if (!session.coreSession && delivery === "steer") {
      throw new Error("steer delivery requires a canonical Core Session");
    }
    session.inFlightSends += 1;
    session.busy = true;
    this.lastSend = this.now();
    if (!session.titled) {
      session.title = deriveTitle(text);
      session.titled = true;
      this.queueMetaWrite(session);
    }
    try {
      let events: AsyncIterable<TurnEvent>;
      if (session.coreSession) {
        events = session.coreSession.sendContent(
          [{ type: "text", text }],
          { inputId, delivery },
        );
      } else {
        session.engine.appendUserMessage(text);
        events = session.engine.streamTurn();
      }
      for await (const event of events) {
        if (event.type === "input_admitted" && session.mirroredAdmissionIds.delete(event.inputId)) {
          continue;
        }
        this.appendRollout(session, event);
        session.friction?.record(event);
        // Match Core Session's turn boundary: when a client observes turn_end,
        // the complete rollout and friction envelope are already durable. This
        // closes a real reboot/rehydration race exposed by the front-door test.
        if (event.type === "turn_end") {
          await Promise.all([session.ioChain, ...(session.friction ? [session.friction.settle()] : [])]);
          try {
            this.onTurnSettled?.(session.id);
          } catch {
            // a wake producer must never break the event stream
          }
        }
        this.fanOut(session, event);
      }
    } finally {
      session.inFlightSends = Math.max(0, session.inFlightSends - 1);
      session.busy = session.inFlightSends > 0;
      session.mirroredAdmissionIds.delete(inputId);
      if (!session.coreSession && session.controller.signal.aborted) this.rebuildEngine(session);
      // Turn completion is the durability boundary for the shared telemetry
      // plane, matching core Session. Recording stays off the streaming path.
      await session.friction?.settle();
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
    if (session.coreSession) session.coreSession.interrupt();
    else session.controller.abort();
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
    await Promise.all(
      [...this.live.values()].flatMap((s) => [s.ioChain, ...(s.friction ? [s.friction.settle()] : [])]),
    );
  }

  /**
   * Recreate sessions from prior rollouts on disk. Already-live ids are left
   * alone; a factory failure skips that session (its files stay untouched).
   * Returns the summaries of what came back.
   */
  async rehydrate(): Promise<SessionSummary[]> {
    const prior = await rehydrateSessions(this.home, this.sessionKernel);
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
          messages: p.messages,
          eventCount: p.eventCount,
        });
      } catch (error) {
        if (p.canonical) throw error;
        continue;
      }
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
      const restored = await rehydrateSession(this.home, sessionId, this.sessionKernel);
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
          messages: restored.messages,
          eventCount: restored.eventCount,
        });
      } catch (error) {
        if (restored.canonical) throw error;
        return null;
      }
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
    messages?: readonly Message[];
    eventCount?: number;
  }): LiveSession {
    const controller = new AbortController();
    const made = this.factory({
      sessionId: p.id,
      provider: p.provider,
      model: p.model,
      workspace: p.workspace,
      signal: controller.signal,
      requestPermission: this.permissionHandlerFor(p.id),
      initialMessages: p.messages,
      initialEventCount: p.eventCount,
      title: p.title,
      createdAt: p.createdAt,
    });
    const coreSession = "session" in made ? made.session : undefined;
    const engine = coreSession?.engine ?? ("engine" in made ? made.engine : undefined);
    if (!engine) throw new Error(`session factory returned no runtime for ${p.id}`);
    const friction = coreSession
      ? undefined
      : new FrictionRecorder(p.id, {
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
      inFlightSends: 0,
      engine,
      coreSession,
      friction,
      mirroredAdmissionIds: new Set(),
      controller,
      subscribers: new Set(),
      ioChain: fs
        .mkdir(sessionsDir(this.home), { recursive: true })
        .then(() => undefined)
        .catch(() => undefined),
      requested: { provider: p.provider, model: p.model, workspace: p.workspace },
    };
    if (p.messages && p.messages.length > 0) session.engine.hydrate(p.messages);
    if (coreSession) {
      // Core Session's write-ahead admission is observer-only (the turn stream
      // begins at turn_start). Mirror that durable event into the Garrison
      // rollout/fan-out so reconnecting clients and Garrison replay see the same
      // input identity the canonical kernel owns.
      coreSession.observeEvents((event) => {
        if (event.type !== "input_admitted") return;
        session.mirroredAdmissionIds.add(event.inputId);
        this.appendRollout(session, event);
        this.fanOut(session, event);
      });
    }
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
      // This path is legacy-only: canonical Core Session owns a per-turn abort
      // controller and never needs reconstruction after interrupt.
      if (!("engine" in made) || !made.engine) return;
      made.engine.hydrate([...session.engine.history()]);
      session.engine = made.engine;
      session.controller = controller;
      session.provider = made.providerName;
      session.model = made.model;
      session.workspace = made.workspace;
      session.friction?.updateContext({
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
  return `${sessionId}\0${requestId}`;
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
  /** Projection came from SQLite; failures must propagate rather than falling
   * through to the audit transcript. */
  canonical?: boolean;
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
export async function rehydrateSessions(
  home: string,
  kernel?: SessionKernelStore,
): Promise<RehydratedSession[]> {
  const dir = sessionsDir(home);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: RehydratedSession[] = [];
  const canonicalRows = kernel?.listSessions({ includeArchived: true }) ?? [];
  const canonicalIds = new Set(canonicalRows.map((session) => session.id));
  if (kernel) {
    for (const session of canonicalRows) {
      if (session.archived) continue;
      out.push(canonicalRehydratedSession(kernel, session));
    }
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!id || canonicalIds.has(id)) continue;
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
export async function rehydrateSession(
  home: string,
  sessionId: string,
  kernel?: SessionKernelStore,
): Promise<RehydratedSession | null> {
  if (!sessionId || path.basename(sessionId) !== sessionId) return null;
  const canonical = kernel?.getSession(sessionId) ?? null;
  if (canonical) {
    if (canonical.archived) return null;
    return canonicalRehydratedSession(kernel!, canonical);
  }
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

function canonicalRehydratedSession(
  kernel: SessionKernelStore,
  session: SessionRecord,
): RehydratedSession {
  // Projection is intentionally outside a catch. A canonical failure must stop
  // rehydration instead of quietly replaying the Garrison audit transcript.
  const messages = projectMessagesFromKernel(kernel, session.id);
  const metadata = session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata)
    ? session.metadata as Record<string, JsonValue>
    : {};
  const recordedModel = [...kernel.listMessages(session.id)].reverse().find((message) => message.model)?.model;
  return {
    id: session.id,
    title: session.title ?? titleFromMessages(messages) ?? FALLBACK_TITLE,
    provider: typeof metadata.provider === "string" ? metadata.provider : undefined,
    model: typeof metadata.model === "string" ? metadata.model : recordedModel ?? undefined,
    workspace: session.workspaceKey ?? undefined,
    createdAt: typeof metadata.createdAt === "string"
      ? metadata.createdAt
      : new Date(session.createdAtMs).toISOString(),
    messages,
    eventCount: kernel.countEvents(session.id),
    canonical: true,
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
 * Rebuild the Message[] a hydrated engine needs. This deliberately mirrors
 * Core Session replay: admission/turn-start user messages are identity-upserts,
 * tool results ride in user-role messages, and a compaction snapshot is an
 * authoritative replacement rather than one more batch appended to stale
 * pre-compaction history.
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
    if (event.type === "input_admitted" || event.type === "turn_start") {
      flushToolResults();
      const existing = messages.findIndex((message) => message.id === event.userMessage.id);
      if (existing >= 0) messages[existing] = event.userMessage;
      else messages.push(event.userMessage);
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
    } else if (event.type === "compaction" && Array.isArray(event.messages)) {
      // Tool results buffered from the superseded transcript must not leak
      // across the compaction boundary. The event carries the exact history the
      // live engine continued from, so it is the only valid replay baseline.
      pendingToolResults = [];
      messages.length = 0;
      messages.push(...event.messages);
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
