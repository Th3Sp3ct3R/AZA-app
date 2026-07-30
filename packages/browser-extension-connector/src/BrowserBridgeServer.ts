import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import net, { type Socket } from "node:net";

export interface BridgeServerOptions { port: number; hostToken: string; requestTimeoutMs?: number; }
export interface BridgeCommand { op: string; tabId?: number; params?: Record<string, unknown>; capabilities?: string[]; idempotencyKey?: string; }

export class BrowserBridgeServer {
  private server: net.Server | null = null;
  private socket: Socket | null = null;
  private ready = false;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(event: unknown) => void>();
  constructor(private readonly options: BridgeServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); });
    });
  }

  connected(): boolean { return this.ready && !!this.socket?.writable; }
  address(): { host: "127.0.0.1"; port: number } | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? { host: "127.0.0.1", port: address.port } : null;
  }
  onEvent(listener: (event: unknown) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  request(command: BridgeCommand): Promise<unknown> {
    if (!this.connected()) return Promise.reject(new Error("browser extension bridge is not connected"));
    const id = randomUUID();
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`browser bridge ${command.op} timed out; outcome may be unknown`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify({ v: 1, id, type: "command", ...command, at: new Date().toISOString() }) + "\n");
    });
  }

  async close(): Promise<void> {
    this.drop(new Error("browser bridge closed"));
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    let buffer = "";
    let stage: "hello" | "proof" | "ready" = "hello";
    let nonce = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 4 * 1024 * 1024) { socket.destroy(new Error("bridge frame overflow")); return; }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error("invalid bridge JSON")); return; }
        if (stage === "hello") {
          if (message.type !== "host.hello" || !safeEqual(message.token, this.options.hostToken)) { socket.destroy(new Error("host authentication failed")); return; }
          nonce = randomBytes(24).toString("base64url");
          socket.write(JSON.stringify({ v: 1, id: message.id, type: "daemon.challenge", nonce }) + "\n");
          stage = "proof";
          continue;
        }
        if (stage === "proof") {
          const expected = createHmac("sha256", this.options.hostToken).update(nonce).digest("base64url");
          if (message.type !== "host.proof" || !safeEqual(message.proof, expected)) { socket.destroy(new Error("host proof failed")); return; }
          this.drop(new Error("browser bridge connection replaced"));
          this.socket = socket; this.ready = true; stage = "ready";
          socket.write(JSON.stringify({ v: 1, id: message.id, type: "host.accepted" }) + "\n");
          continue;
        }
        this.route(message);
      }
    });
    socket.on("close", () => { if (this.socket === socket) this.drop(new Error("browser bridge disconnected")); });
    socket.on("error", () => {});
  }

  private route(message: any): void {
    if (message?.type === "result" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!; this.pending.delete(message.id); clearTimeout(pending.timer);
      message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error ?? "bridge command failed"));
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private drop(error: Error): void {
    this.ready = false;
    this.socket?.destroy(); this.socket = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

function safeEqual(a: unknown, b: unknown): boolean {
  const aa = Buffer.from(String(a ?? "")); const bb = Buffer.from(String(b ?? ""));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
