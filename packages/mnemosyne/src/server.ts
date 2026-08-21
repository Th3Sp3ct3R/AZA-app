// The Mnemosyne server — the single writer over living memory, and the
// authority on bindings.
//
// Three processes (CLI, garrison, daemon) currently contend for
// ~/.ares/mind/memory.jsonl behind an advisory file lock. Mnemosyne is the
// structural fix: one process owns the store; everyone else speaks the wire.
// Clone of the garrison transport doctrine: node:http + ws on 127.0.0.1,
// GET /health, first frame is hello with the token, everything else is
// request/response with req/re correlation.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { MemoryStore } from "@ares/mind";
import { mnemosynePaths } from "./paths.js";
import { ensureToken, constantTimeEqual } from "./token.js";
import {
  addBinding,
  retireBinding,
  loadBindings,
  alwaysOnBindings,
  activeGuards,
  exportLawsFile,
  type Binding,
} from "./bindings.js";
import { evaluateGuards } from "./guards.js";
import { recordAttestations, complianceReport } from "./attest.js";
import { PROTO_VERSION, type MnemosyneClientFrame, type MnemosyneServerFrame } from "./protocol.js";

export interface MnemosyneServerOptions {
  home: string;
  port?: number;
  host?: string;
}

/** Render the always-on set in the same voice as lawsPromptBlock — the client
 *  injects this verbatim after doctrine, before surfaces. */
export function renderBindingBlock(bindings: readonly Binding[]): string {
  if (bindings.length === 0) return "";
  const lines = bindings.map((b) => `- [${b.class}] ${b.text}`);
  return [
    "## The owner's laws & your pacts — standing orders, ALWAYS in force",
    "",
    ...lines,
    "",
    "These override default habits and doctrine. Only hard safety floors",
    "(unrecoverable data loss, photosensitivity, the permission system) rank",
    "above them. A pact is your own given word — breaking one is worse than",
    "never having made it. You will be asked to attest to each of these after",
    "the turn; attest honestly.",
  ].join("\n");
}

export class MnemosyneServer {
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private store: MemoryStore | null = null;
  private token = "";
  private readonly authed = new Set<WebSocket>();
  private readonly opts: MnemosyneServerOptions;

  constructor(opts: MnemosyneServerOptions) {
    this.opts = opts;
  }

  async start(): Promise<{ host: string; port: number }> {
    const paths = mnemosynePaths(this.opts.home);
    await fs.mkdir(path.dirname(paths.memoryFile), { recursive: true });
    this.store = await MemoryStore.open(paths.memoryFile);
    this.token = await ensureToken(this.opts.home);

    const host = this.opts.host ?? process.env.ARES_MNEMOSYNE_HOST ?? "127.0.0.1";
    const requestedPort = this.opts.port ?? 0;

    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    // Same rule as per-socket errors: a transport hiccup must never become an
    // uncaughtException inside whatever process is hosting this server.
    this.wss.on("error", () => undefined);

    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(requestedPort, host, () => resolve());
    });
    const address = this.http.address();
    const port = typeof address === "object" && address ? address.port : requestedPort;
    return { host, port };
  }

  /**
   * Stop the listening server from holding the event loop open. An in-process
   * hosted server should die WITH its host, never keep it alive: a one-shot
   * CLI turn that ended up hosting must still exit cleanly.
   */
  unref(): void {
    this.http?.unref();
  }

  async close(): Promise<void> {
    for (const socket of this.authed) socket.close();
    this.authed.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.wss = null;
    this.http = null;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url === "/health") {
      const body = JSON.stringify({ ok: true, service: "mnemosyne", proto: PROTO_VERSION, memories: this.store?.count() ?? 0 });
      res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    res.writeHead(404).end();
  }

  private handleConnection(socket: WebSocket): void {
    socket.on("message", (data) => {
      void this.handleFrame(socket, data.toString()).catch((err) => {
        this.send(socket, { type: "error", message: err instanceof Error ? err.message : String(err) });
      });
    });
    socket.on("close", () => this.authed.delete(socket));
    // A peer that dies mid-connection (host tree-killed, ECONNRESET) emits
    // 'error'; with no listener that is an uncaughtException that takes the
    // HOSTING process down with it — a memory server must never be able to
    // kill its host over a dropped client.
    socket.on("error", () => {
      this.authed.delete(socket);
      try {
        socket.close();
      } catch {
        // already gone
      }
    });
  }

  private send(socket: WebSocket, frame: MnemosyneServerFrame): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // dying socket — close handler cleans up
    }
  }

  private async handleFrame(socket: WebSocket, raw: string): Promise<void> {
    let frame: MnemosyneClientFrame;
    try {
      frame = JSON.parse(raw) as MnemosyneClientFrame;
    } catch {
      this.send(socket, { type: "error", message: "malformed frame" });
      return;
    }
    if (!this.authed.has(socket)) {
      if (frame.type !== "hello") {
        this.send(socket, { type: "error", message: "hello first" });
        socket.close(1008, "unauthenticated");
        return;
      }
      if (frame.proto !== PROTO_VERSION || !constantTimeEqual(frame.token, this.token)) {
        this.send(socket, { type: "error", message: "bad token or protocol", re: frame.req });
        socket.close(1008, "unauthorized");
        return;
      }
      this.authed.add(socket);
      const bindings = await loadBindings(this.opts.home);
      this.send(socket, { type: "welcome", proto: PROTO_VERSION, bindings: bindings.length, memories: this.store?.count() ?? 0 });
      return;
    }
    await this.route(socket, frame);
  }

  private async route(socket: WebSocket, frame: MnemosyneClientFrame): Promise<void> {
    const store = this.store;
    if (!store) {
      this.send(socket, { type: "error", message: "store not open", re: frame.req });
      return;
    }
    switch (frame.type) {
      case "hello":
        this.send(socket, { type: "ok", re: frame.req });
        return;
      case "ping":
        this.send(socket, { type: "pong", re: frame.req });
        return;
      case "remember": {
        const node = await store.add({ kind: frame.kind, content: frame.content, tags: frame.tags, source: frame.source, scope: frame.scope });
        this.send(socket, { type: "remembered", node, re: frame.req });
        return;
      }
      case "recall": {
        const opts = { limit: frame.limit, scope: frame.scope };
        const items = frame.reinforce === false ? store.peek(frame.cue, opts) : await store.remember(frame.cue, opts);
        this.send(socket, { type: "recalled", items, re: frame.req });
        return;
      }
      case "bindings.list": {
        this.send(socket, { type: "bindings", list: await loadBindings(this.opts.home), re: frame.req });
        return;
      }
      case "bindings.add": {
        const binding = await addBinding(this.opts.home, { class: frame.class, text: frame.text, source: frame.source });
        if (binding.class === "law") await exportLawsFile(this.opts.home);
        this.send(socket, { type: "binding.added", binding, re: frame.req });
        return;
      }
      case "bindings.retire": {
        const removed = await retireBinding(this.opts.home, frame.id);
        if (removed) await exportLawsFile(this.opts.home);
        this.send(socket, removed ? { type: "ok", re: frame.req } : { type: "error", message: `no binding ${frame.id}`, re: frame.req });
        return;
      }
      case "bindings.packet": {
        const all = await loadBindings(this.opts.home);
        const alwaysOn = alwaysOnBindings(all);
        this.send(socket, {
          type: "bindings.packet",
          packetId: `pkt_${randomUUID().slice(0, 8)}`,
          bindings: alwaysOn,
          guards: activeGuards(all),
          promptBlock: renderBindingBlock(alwaysOn),
          re: frame.req,
        });
        return;
      }
      case "attest": {
        await recordAttestations(this.opts.home, frame.turnId, frame.outcomes);
        this.send(socket, { type: "ok", re: frame.req });
        return;
      }
      case "guards.eval": {
        const verdicts = evaluateGuards(activeGuards(await loadBindings(this.opts.home)), frame.action);
        this.send(socket, { type: "guards.verdict", verdicts, re: frame.req });
        return;
      }
      case "compliance": {
        this.send(socket, { type: "compliance", report: complianceReport(await loadBindings(this.opts.home)), re: frame.req });
        return;
      }
      default: {
        const exhaustive: never = frame;
        this.send(socket, { type: "error", message: `unknown frame ${JSON.stringify(exhaustive).slice(0, 80)}` });
      }
    }
  }
}
