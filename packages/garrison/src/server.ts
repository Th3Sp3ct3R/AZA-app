// GarrisonServer — the gateway. One port carries both HTTP GET /health and the
// WebSocket clients speak gateway wire protocol v1 over (see protocol.ts).
//
// Auth: first frame MUST be hello with the <home>/garrison/token secret
// (constant-time compared); anything else gets an error frame and a 1008 close.
//
// Backpressure: a slow client must never stall the engine. Every outbound
// frame goes through a per-client bounded queue (default cap 1000). On
// overflow the oldest frames drop and ONE {"type":"error","message":"event
// stream gapped"} is prepended per gap episode (the flag resets when the
// queue drains). Control replies share the queue so per-client ordering holds.
//
// Binding: loopback (127.0.0.1) unless ARES_GARRISON_HOST overrides; port from
// the option, then ARES_GARRISON_PORT, then 7421. Tests pass port 0 and read
// the bound port from start()'s return value.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { ApprovalVerb, StagedApproval } from "@ares/effects";
import type { TurnEvent } from "@ares/protocol";
import { constantTimeEqual, ensureToken, ensureReadToken } from "./token.js";
import type { SessionManager } from "./sessions.js";
import type { Scheduler } from "./scheduler.js";
import { ChannelManager } from "./channels.js";
import { viewerHtml } from "./viewer.js";
import {
  DEFAULT_GARRISON_PORT,
  PROTO_VERSION,
  type GarrisonStatus,
  type GatewayClientFrame,
  type GatewayServerFrame,
} from "./protocol.js";

const GARRISON_VERSION = "0.5.0-alpha.1";
const DEFAULT_CLIENT_BUFFER_CAP = 1000;
const SEND_HIGH_WATER_BYTES = 1 << 20; // pause pumping while the socket has ≥1MiB unflushed
const DRAIN_RETRY_MS = 25;
const HELLO_TIMEOUT_MS = 10_000;

// ─── Approval bridge (stub seam — the effects wiring lands in a later phase) ─

export interface ApprovalResponse {
  approvalId: string;
  verb: ApprovalVerb;
  note?: string;
}

export interface ApprovalBridge {
  /** Called once at server start; cb fires for every newly staged effect. Returns unsubscribe. */
  subscribe(cb: (staged: StagedApproval) => void): () => void;
  /** Route an owner decision back to the approval queue. Optional until the Gate is wired. */
  respond?(decision: ApprovalResponse): void | Promise<void>;
  /** Outstanding staged effects — replayed to a client that connects mid-stage. */
  pending?(): StagedApproval[];
}

// ─── Server ──────────────────────────────────────────────────────────────

export interface GarrisonServerOptions {
  home: string;
  sessions: SessionManager;
  scheduler?: Scheduler;
  approvals?: ApprovalBridge;
  /** Runtime channel manager for Telegram bridge lifecycle. */
  channels?: ChannelManager;
  host?: string;
  /** Pass 0 to bind an ephemeral port (tests). */
  port?: number;
  version?: string;
  clientBufferCap?: number;
  /** Recorded-event replay for session.history frames (the viewer's back-scroll).
   *  Injected by the boot site (workspace rollouts live in @ares/core). */
  history?: (sessionId: string, opts?: { limit?: number }) => Promise<Array<{ ts?: string; event: TurnEvent }>>;
}

interface ClientConn {
  ws: WebSocket;
  authed: boolean;
  /** control = full protocol; read = list/attach/history/status only. */
  scope: "control" | "read";
  name: string;
  queue: GatewayServerFrame[];
  gapped: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  detachBySession: Map<string, () => void>;
}

export class GarrisonServer {
  private readonly opts: GarrisonServerOptions;
  private readonly clients = new Set<ClientConn>();
  private readonly bufferCap: number;
  private http: HttpServer | undefined;
  private wss: WebSocketServer | undefined;
  private token = "";
  private readToken = "";
  private startedAt = "";
  private boundHost = "";
  private boundPort = 0;
  private unsubscribeApprovals: (() => void) | undefined;

  constructor(opts: GarrisonServerOptions) {
    this.opts = opts;
    this.bufferCap = Math.max(8, opts.clientBufferCap ?? DEFAULT_CLIENT_BUFFER_CAP);
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.http) throw new Error("garrison server already started");
    this.token = await ensureToken(this.opts.home);
    this.readToken = await ensureReadToken(this.opts.home);
    this.startedAt = new Date().toISOString();
    const http = createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (ws) => this.handleConnection(ws));
    this.http = http;
    this.wss = wss;
    if (this.opts.approvals) {
      this.unsubscribeApprovals = this.opts.approvals.subscribe((staged) =>
        this.broadcast({ type: "approval.pending", staged }),
      );
    }

    const host = this.opts.host ?? process.env.ARES_GARRISON_HOST ?? "127.0.0.1";
    const port = this.opts.port ?? envPort();
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      http.once("error", onError);
      http.listen(port, host, () => {
        http.off("error", onError);
        resolve();
      });
    });
    const addr = http.address();
    this.boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
    this.boundHost = host;
    return { host: this.boundHost, port: this.boundPort };
  }

  get port(): number {
    return this.boundPort;
  }

  async close(): Promise<void> {
    this.unsubscribeApprovals?.();
    this.unsubscribeApprovals = undefined;
    if (this.opts.channels) await this.opts.channels.stopAll().catch(() => {});
    for (const client of [...this.clients]) this.dropClient(client, true);
    this.clients.clear();
    const wss = this.wss;
    const http = this.http;
    this.wss = undefined;
    this.http = undefined;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (http) {
      http.closeIdleConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/health" || url.startsWith("/health?"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          version: this.opts.version ?? GARRISON_VERSION,
          sessions: this.opts.sessions.list().length,
        }),
      );
      return;
    }
    // The read-only viewer: one self-contained page, no assets, no build step.
    // It speaks the same WS protocol back to this very port (read token).
    if (req.method === "GET" && (url === "/view" || url.startsWith("/view?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(viewerHtml());
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  }

  // ─── WebSocket lifecycle ───────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    const client: ClientConn = {
      ws,
      authed: false,
      scope: "control",
      name: "",
      queue: [],
      gapped: false,
      drainTimer: null,
      helloTimer: null,
      detachBySession: new Map(),
    };
    this.clients.add(client);
    client.helloTimer = setTimeout(() => this.rejectHandshake(client, "handshake timeout"), HELLO_TIMEOUT_MS);
    client.helloTimer.unref?.();

    ws.on("message", (data) => this.onMessage(client, data));
    ws.on("error", () => {
      // Socket errors surface as close; nothing to do here.
    });
    ws.on("close", () => {
      this.dropClient(client, false);
      this.clients.delete(client);
    });
  }

  private onMessage(client: ClientConn, data: RawData): void {
    let frame: GatewayClientFrame;
    try {
      const parsed: unknown = JSON.parse(rawToString(data));
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
        throw new Error("not a frame");
      }
      frame = parsed as GatewayClientFrame;
    } catch {
      if (!client.authed) {
        this.rejectHandshake(client, "malformed frame: expected a JSON object with a string `type`");
      } else {
        this.enqueueError(client, "malformed frame: expected a JSON object with a string `type`");
      }
      return;
    }
    if (!client.authed) {
      this.handleHello(client, frame);
      return;
    }
    this.route(client, frame);
  }

  private handleHello(client: ClientConn, frame: GatewayClientFrame): void {
    if (frame.type !== "hello") {
      this.rejectHandshake(client, "handshake required: the first frame must be hello");
      return;
    }
    if (frame.proto !== PROTO_VERSION) {
      this.rejectHandshake(client, `unsupported proto: expected ${PROTO_VERSION}`);
      return;
    }
    // The control token grants the full protocol; the read token grants a
    // list/attach/history view and nothing that moves a session. Check BOTH
    // unconditionally so timing doesn't leak which one almost matched.
    const isControl = typeof frame.token === "string" && constantTimeEqual(frame.token, this.token);
    const isRead = typeof frame.token === "string" && constantTimeEqual(frame.token, this.readToken);
    if (!isControl && !isRead) {
      this.rejectHandshake(client, "unauthorized: bad token");
      return;
    }
    client.scope = isControl ? "control" : "read";
    if (client.helloTimer) {
      clearTimeout(client.helloTimer);
      client.helloTimer = null;
    }
    client.authed = true;
    client.name = typeof frame.client === "string" && frame.client ? frame.client : "client";
    this.enqueueFrame(client, { type: "welcome", sessions: this.opts.sessions.list() });
    // Replay any approvals already waiting so a client that joins mid-stage sees
    // the pending decision instead of silence.
    const pending = this.opts.approvals?.pending?.() ?? [];
    for (const staged of pending) {
      this.enqueueFrame(client, { type: "approval.pending", staged });
    }
  }

  private route(client: ClientConn, frame: GatewayClientFrame): void {
    const sessions = this.opts.sessions;
    // The read scope's wall: nothing that creates, drives, or approves.
    if (
      client.scope === "read" &&
      (frame.type === "session.create" ||
        frame.type === "session.send" ||
        frame.type === "session.interrupt" ||
        frame.type === "permission.respond" ||
        frame.type === "approval.respond")
    ) {
      this.enqueueError(client, `read-only client: ${frame.type} is not permitted`);
      return;
    }
    switch (frame.type) {
      case "hello": {
        this.enqueueError(client, "already authenticated");
        return;
      }
      case "session.create": {
        try {
          const session = sessions.create({
            provider: frame.provider,
            model: frame.model,
            workspace: frame.workspace,
          });
          // The creator is auto-attached: a client that just made a session
          // always wants its events. Explicit session.attach stays for peers.
          const detach = sessions.attach(session.id, (event) =>
            this.enqueueFrame(client, { type: "event", sessionId: session.id, event }),
          );
          client.detachBySession.set(session.id, detach);
          // Broadcast the new session to every authenticated client so other
          // surfaces (desktop UI, terminal, companion apps) can attach and
          // follow the conversation in real time.
          this.broadcast({ type: "session.created", session });
        } catch (err) {
          this.enqueueError(client, errorMessage(err));
        }
        return;
      }
      case "session.attach": {
        if (typeof frame.sessionId !== "string") {
          this.enqueueError(client, "session.attach requires sessionId");
          return;
        }
        if (client.detachBySession.has(frame.sessionId)) return; // idempotent re-attach
        const sessionId = frame.sessionId;
        // Lazily rebuild the session from its rollout if it isn't live (survives a
        // crash/restart), then attach. ensureLive returns null for a genuinely
        // unknown id; attach then throws UnknownSessionError → one error frame.
        void (async () => {
          try {
            await sessions.ensureLive(sessionId);
            if (client.detachBySession.has(sessionId)) return; // raced a re-attach
            const detach = sessions.attach(sessionId, (event) =>
              this.enqueueFrame(client, { type: "event", sessionId, event }),
            );
            client.detachBySession.set(sessionId, detach);
          } catch (err) {
            this.enqueueError(client, errorMessage(err));
          }
        })();
        return;
      }
      case "session.send": {
        if (typeof frame.sessionId !== "string" || typeof frame.text !== "string") {
          this.enqueueError(client, "session.send requires sessionId and text");
          return;
        }
        if (
          frame.inputId !== undefined &&
          (typeof frame.inputId !== "string" || !frame.inputId.trim() || frame.inputId.length > 1_024)
        ) {
          this.enqueueError(client, "session.send inputId must be a non-empty string of at most 1024 characters");
          return;
        }
        if (frame.delivery !== undefined && frame.delivery !== "queue" && frame.delivery !== "steer") {
          this.enqueueError(client, "session.send delivery must be queue or steer");
          return;
        }
        // Fire-and-forget: the turn streams to subscribers; failures (busy,
        // unknown session, engine throw) come back as one error frame.
        sessions.send(frame.sessionId, frame.text, {
          inputId: frame.inputId,
          delivery: frame.delivery,
        }).catch((err) => this.enqueueError(client, errorMessage(err)));
        return;
      }
      case "session.interrupt": {
        if (typeof frame.sessionId !== "string") {
          this.enqueueError(client, "session.interrupt requires sessionId");
          return;
        }
        try {
          sessions.interrupt(frame.sessionId);
        } catch (err) {
          this.enqueueError(client, errorMessage(err));
        }
        return;
      }
      case "sessions.list": {
        this.enqueueFrame(client, { type: "sessions", sessions: sessions.list() });
        return;
      }
      case "session.history": {
        if (typeof frame.sessionId !== "string") {
          this.enqueueError(client, "session.history requires sessionId");
          return;
        }
        const history = this.opts.history;
        if (!history) {
          this.enqueueError(client, "history is not wired on this garrison");
          return;
        }
        const sessionId = frame.sessionId;
        const limit = typeof frame.limit === "number" && frame.limit > 0 ? Math.min(Math.floor(frame.limit), 5_000) : 1_000;
        void history(sessionId, { limit })
          .then((entries) => this.enqueueFrame(client, { type: "session.history", sessionId, entries: entries.slice(-limit) }))
          .catch((err) => this.enqueueError(client, errorMessage(err)));
        return;
      }
      case "status": {
        this.enqueueFrame(client, { type: "status", garrison: this.garrisonStatus() });
        return;
      }
      case "permission.respond": {
        if (
          typeof frame.sessionId !== "string" ||
          typeof frame.requestId !== "string" ||
          (frame.decision !== "allow_once" && frame.decision !== "allow_always" && frame.decision !== "deny")
        ) {
          this.enqueueError(client, "permission.respond requires sessionId, requestId, and a valid decision");
          return;
        }
        const handled = sessions.respondPermission(frame.sessionId, frame.requestId, frame.decision);
        if (!handled) this.enqueueError(client, `no pending permission: ${frame.requestId}`);
        return;
      }
      case "approval.respond": {
        const bridge = this.opts.approvals;
        if (!bridge?.respond) {
          this.enqueueError(client, "approval bridge not wired");
          return;
        }
        if (typeof frame.approvalId !== "string") {
          this.enqueueError(client, "approval.respond requires approvalId");
          return;
        }
        // respond() may throw synchronously (unknown id) OR reject — catch both
        // so either way the client gets an error frame, never an unhandled throw.
        try {
          Promise.resolve(
            bridge.respond({ approvalId: frame.approvalId, verb: frame.verb, note: frame.note }),
          ).catch((err) => this.enqueueError(client, errorMessage(err)));
        } catch (err) {
          this.enqueueError(client, errorMessage(err));
        }
        return;
      }
      // ── Channel lifecycle commands ─────────────────────────────────
      case "channel.configure": {
        if (!this.opts.channels) { this.enqueueError(client, "channel manager not wired"); return; }
        void (async () => {
          try {
            await this.opts.channels!.configure(frame.channel, frame.config);
            this.broadcastChannels();
          } catch (err) { this.enqueueError(client, errorMessage(err)); }
        })();
        return;
      }
      case "channel.start": {
        if (!this.opts.channels) { this.enqueueError(client, "channel manager not wired"); return; }
        void (async () => {
          try {
            await this.opts.channels!.start(frame.channel);
            this.broadcast({ type: "channel.event", channel: frame.channel, event: "started" });
            this.broadcastChannels();
          } catch (err) { this.enqueueError(client, errorMessage(err)); }
        })();
        return;
      }
      case "channel.stop": {
        if (!this.opts.channels) { this.enqueueError(client, "channel manager not wired"); return; }
        void (async () => {
          try {
            await this.opts.channels!.stop(frame.channel);
            this.broadcast({ type: "channel.event", channel: frame.channel, event: "stopped" });
            this.broadcastChannels();
          } catch (err) { this.enqueueError(client, errorMessage(err)); }
        })();
        return;
      }
      case "channel.status": {
        if (!this.opts.channels) { this.enqueueFrame(client, { type: "channel.status", channels: [] }); return; }
        this.enqueueFrame(client, { type: "channel.status", channels: this.opts.channels.status() });
        return;
      }
      case "channel.roster.add":
      case "channel.roster.remove": {
        if (!this.opts.channels) { this.enqueueError(client, "channel manager not wired"); return; }
        this.broadcastChannels();
        return;
      }
      case "channel.test": {
        if (!this.opts.channels) { this.enqueueError(client, "channel manager not wired"); return; }
        this.broadcast({ type: "channel.event", channel: frame.channel, event: "message",
          detail: frame.type === "channel.test" ? `test to ${frame.chatId}: ${frame.text.slice(0, 80)}` : undefined });
        return;
      }
      default: {
        this.enqueueError(client, `unknown frame type: ${(frame as { type: string }).type}`);
      }
    }
  }

  private garrisonStatus(): GarrisonStatus {
    const scheduler = this.opts.scheduler;
    const nextDream = scheduler?.nextDreamAt();
    return {
      startedAt: this.startedAt,
      heartbeatEveryMs: scheduler?.heartbeatEveryMs ?? 0,
      ...(nextDream !== undefined ? { nextDreamAt: new Date(nextDream).toISOString() } : {}),
      sessions: this.opts.sessions.list().length,
    };
  }

  // ─── Outbound queue (the backpressure bound) ───────────────────────────

  private enqueueFrame(client: ClientConn, frame: GatewayServerFrame): void {
    if (client.ws.readyState !== WebSocket.OPEN && client.ws.readyState !== WebSocket.CONNECTING) return;
    client.queue.push(frame);
    if (client.queue.length > this.bufferCap) {
      client.queue.splice(0, client.queue.length - this.bufferCap);
      if (!client.gapped) {
        client.gapped = true;
        client.queue.unshift({ type: "error", message: "event stream gapped" });
      }
    }
    this.pump(client);
  }

  private enqueueError(client: ClientConn, message: string): void {
    this.enqueueFrame(client, { type: "error", message });
  }

  /** Push current channel status to all authenticated clients. */
  private broadcastChannels(): void {
    const channels = this.opts.channels;
    if (!channels) return;
    const status = channels.status();
    this.broadcast({ type: "channel.status", channels: status });
    // Also push roster for each active channel
    for (const s of status) {
      if (!s.running) continue;
      const participants = channels.roster(s.channel);
      if (participants) {
        this.broadcast({ type: "channel.roster", channel: s.channel, participants });
      }
    }
  }

  private broadcast(frame: GatewayServerFrame): void {
    for (const client of this.clients) {
      if (client.authed) this.enqueueFrame(client, frame);
    }
  }

  private pump(client: ClientConn): void {
    while (
      client.queue.length > 0 &&
      client.ws.readyState === WebSocket.OPEN &&
      client.ws.bufferedAmount < SEND_HIGH_WATER_BYTES
    ) {
      const frame = client.queue.shift()!;
      try {
        client.ws.send(JSON.stringify(frame));
      } catch {
        return; // socket died mid-send; close handler cleans up
      }
    }
    if (client.queue.length === 0) {
      client.gapped = false;
      return;
    }
    if (client.ws.readyState !== WebSocket.OPEN && client.ws.readyState !== WebSocket.CONNECTING) return;
    if (!client.drainTimer) {
      client.drainTimer = setTimeout(() => {
        client.drainTimer = null;
        this.pump(client);
      }, DRAIN_RETRY_MS);
      client.drainTimer.unref?.();
    }
  }

  // ─── Teardown ──────────────────────────────────────────────────────────

  private rejectHandshake(client: ClientConn, message: string): void {
    try {
      client.ws.send(JSON.stringify({ type: "error", message } satisfies GatewayServerFrame));
    } catch {
      // Already gone.
    }
    client.ws.close(1008, "unauthorized");
  }

  private dropClient(client: ClientConn, terminate: boolean): void {
    if (client.helloTimer) {
      clearTimeout(client.helloTimer);
      client.helloTimer = null;
    }
    if (client.drainTimer) {
      clearTimeout(client.drainTimer);
      client.drainTimer = null;
    }
    for (const detach of client.detachBySession.values()) {
      try {
        detach();
      } catch {
        // Session may already be gone.
      }
    }
    client.detachBySession.clear();
    client.queue.length = 0;
    if (terminate) client.ws.terminate();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function envPort(): number {
  const raw = process.env.ARES_GARRISON_PORT;
  if (!raw) return DEFAULT_GARRISON_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_GARRISON_PORT;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
