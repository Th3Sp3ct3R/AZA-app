// MnemosyneClient — the thin wire client every process uses instead of opening
// the memory file itself. Request/response with req/re correlation over one
// WebSocket. asLivingRecaller() adapts it to the exact structural interface
// unifiedRecallForTurn already accepts, so the CLI can swap the local store for
// the server without touching recall logic.

import WebSocket from "ws";
import type { MemoryKind, MemoryNode, RecallResult } from "@ares/mind";
import type { Binding, BindingClass, BindingSource } from "./bindings.js";
import type { AttestOutcome, ComplianceReport } from "./attest.js";
import type { GuardVerdict } from "./guards.js";
import { PROTO_VERSION, type MnemosyneClientFrame, type MnemosyneServerFrame } from "./protocol.js";

const REQUEST_TIMEOUT_MS = 10_000;

export interface MnemosyneClientOptions {
  url: string;
  token: string;
  client?: string;
}

interface Pending {
  resolve: (frame: MnemosyneServerFrame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class MnemosyneClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly opts: MnemosyneClientOptions) {}

  async connect(): Promise<{ bindings: number; memories: number }> {
    const socket = new WebSocket(this.opts.url);
    this.socket = socket;
    socket.on("message", (data) => this.onFrame(data.toString()));
    socket.on("close", () => this.failAll(new Error("mnemosyne connection closed")));
    socket.on("error", () => this.failAll(new Error("mnemosyne connection error")));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (err) => reject(err));
    });
    const welcome = await new Promise<MnemosyneServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("hello timed out")), REQUEST_TIMEOUT_MS);
      this.pending.set("__hello__", { resolve: (f) => { clearTimeout(timer); resolve(f); }, reject, timer });
      socket.send(JSON.stringify({ type: "hello", token: this.opts.token, client: this.opts.client ?? "ares", proto: PROTO_VERSION } satisfies MnemosyneClientFrame));
    });
    if (welcome.type !== "welcome") throw new Error(welcome.type === "error" ? welcome.message : "unexpected hello reply");
    return { bindings: welcome.bindings, memories: welcome.memories };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  /**
   * Stop this connection from holding the event loop open. A one-shot CLI turn
   * that adopted Mnemosyne must still exit when its work is done; the socket
   * stays fully usable, it just no longer counts as a reason to stay alive.
   */
  unref(): void {
    const socket = this.socket as (WebSocket & { _socket?: { unref?: () => void } }) | null;
    socket?._socket?.unref?.();
  }

  private onFrame(raw: string): void {
    let frame: MnemosyneServerFrame;
    try {
      frame = JSON.parse(raw) as MnemosyneServerFrame;
    } catch {
      return;
    }
    if (frame.type === "welcome" || (frame.type === "error" && !("re" in frame && frame.re))) {
      const hello = this.pending.get("__hello__");
      if (hello) {
        this.pending.delete("__hello__");
        clearTimeout(hello.timer);
        hello.resolve(frame);
        return;
      }
    }
    const re = "re" in frame ? frame.re : undefined;
    if (!re) return;
    const pending = this.pending.get(re);
    if (!pending) return;
    this.pending.delete(re);
    clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private request(frame: MnemosyneClientFrame & { req?: string }): Promise<MnemosyneServerFrame> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const req = `r${++this.seq}`;
    return new Promise<MnemosyneServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req);
        reject(new Error(`mnemosyne request ${frame.type} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...frame, req }));
    });
  }

  private async expect<T extends MnemosyneServerFrame["type"]>(
    frame: MnemosyneClientFrame,
    type: T,
  ): Promise<Extract<MnemosyneServerFrame, { type: T }>> {
    const reply = await this.request(frame);
    if (reply.type === "error") throw new Error(reply.message);
    if (reply.type !== type) throw new Error(`expected ${type}, got ${reply.type}`);
    return reply as Extract<MnemosyneServerFrame, { type: T }>;
  }

  async remember(kind: MemoryKind, content: string, opts: { tags?: string[]; source?: string; scope?: string } = {}): Promise<MemoryNode> {
    return (await this.expect({ type: "remember", kind, content, ...opts }, "remembered")).node;
  }

  async recall(cue: string, opts: { limit?: number; scope?: string; reinforce?: boolean } = {}): Promise<RecallResult[]> {
    return (await this.expect({ type: "recall", cue, ...opts }, "recalled")).items;
  }

  async listBindings(): Promise<Binding[]> {
    return (await this.expect({ type: "bindings.list" }, "bindings")).list;
  }

  async addBinding(cls: BindingClass, text: string, source?: BindingSource): Promise<Binding> {
    return (await this.expect({ type: "bindings.add", class: cls, text, source }, "binding.added")).binding;
  }

  async retireBinding(id: string): Promise<void> {
    await this.expect({ type: "bindings.retire", id }, "ok");
  }

  async bindingsPacket(): Promise<Extract<MnemosyneServerFrame, { type: "bindings.packet" }>> {
    return this.expect({ type: "bindings.packet" }, "bindings.packet");
  }

  async attest(turnId: string, outcomes: Array<{ bindingId: string; outcome: AttestOutcome; note?: string }>): Promise<void> {
    await this.expect({ type: "attest", turnId, outcomes }, "ok");
  }

  async evalGuards(action: string): Promise<GuardVerdict[]> {
    return (await this.expect({ type: "guards.eval", action }, "guards.verdict")).verdicts;
  }

  async compliance(): Promise<ComplianceReport> {
    return (await this.expect({ type: "compliance" }, "compliance")).report;
  }

  /**
   * Adapt to the LivingRecaller structural interface unifiedRecallForTurn
   * accepts ({remember, peek}) — the drop-in seam for CLI adoption. peek maps
   * to reinforce:false so read-only inspection never mutates memory strength.
   */
  asLivingRecaller(): {
    remember: (cue: string, opts?: { limit?: number; scope?: string }) => Promise<RecallResult[]>;
    peek: (cue: string, opts?: { limit?: number; scope?: string }) => Promise<RecallResult[]>;
  } {
    return {
      remember: (cue, opts = {}) => this.recall(cue, { ...opts, reinforce: true }),
      peek: (cue, opts = {}) => this.recall(cue, { ...opts, reinforce: false }),
    };
  }
}
