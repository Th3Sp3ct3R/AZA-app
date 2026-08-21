// cdpRender — dependency-free JS rendering for WebFetch over raw CDP.
//
// JS-heavy SPAs return an empty shell to a plain fetch. When a Chromium debug
// endpoint is reachable (the same ARES_BROWSER_CDP_URL / port-9222 convention
// the Playwright connector uses), render the page in a throwaway tab over a
// raw WebSocket CDP session — no Playwright, no new dependency — and return
// the hydrated HTML. Callers degrade gracefully when no browser is reachable.

export interface CdpRenderOptions {
  /** Hard cap on the whole render (connect + navigate + settle + extract). */
  timeoutMs?: number;
  /** Post-load settle for late XHR/hydration, bounded by timeoutMs. */
  settleMs?: number;
  /** Explicit debug endpoint (http://host:port). Overrides env + discovery. */
  endpoint?: string;
  signal?: AbortSignal;
}

export interface JsRenderer {
  /** Returns the hydrated document HTML. Throws when no browser is reachable. */
  render(url: string, opts?: CdpRenderOptions): Promise<string>;
}

const DEFAULT_RENDER_TIMEOUT_MS = 10_000;

/**
 * Cheap "this page needs JavaScript" detector: a noscript warning, an empty
 * SPA root element, or near-zero visible text despite sizeable script-bearing
 * markup. `text` is the htmlToText rendering of `html`.
 */
export function looksJsGated(html: string, text: string): boolean {
  if (!/<script[\s>]/i.test(html)) return false;
  if (
    /<noscript[^>]*>[\s\S]*?(enable\s+javascript|javascript\s+is\s+(?:required|disabled|needed)|work(?:s)?\s+properly\s+without\s+javascript)[\s\S]*?<\/noscript>/i.test(
      html,
    )
  ) {
    return true;
  }
  if (/<(div|main|section)\b[^>]*\bid=["']?(root|app|__next|___gatsby|q-app)["']?[^>]*>\s*<\/\1>/i.test(html)) {
    return true;
  }
  return text.trim().length < 200 && html.length > 1_500;
}

function parsePorts(raw: string | undefined): number[] {
  const ports = (raw ?? "")
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0);
  return ports.length > 0 ? ports : [9222];
}

/**
 * Find a live Chromium debug endpoint and return its browser WebSocket URL,
 * or null. Explicit endpoint (arg / ARES_BROWSER_CDP_URL) wins; otherwise
 * probe localhost ports (ARES_BROWSER_CDP_PORTS, default 9222) unless
 * discovery is disabled (ARES_BROWSER_CDP_DISCOVERY=0) — the same knobs the
 * Playwright connector honors.
 */
export async function discoverCdpEndpoint(opts: { endpoint?: string } = {}): Promise<string | null> {
  const explicit = opts.endpoint ?? process.env.ARES_BROWSER_CDP_URL?.trim();
  const bases = explicit
    ? [explicit]
    : process.env.ARES_BROWSER_CDP_DISCOVERY === "0"
      ? []
      : parsePorts(process.env.ARES_BROWSER_CDP_PORTS).map((p) => `http://127.0.0.1:${p}`);
  for (const base of bases) {
    try {
      const res = await fetch(new URL("/json/version", base), { signal: AbortSignal.timeout(1_500) });
      if (!res.ok) continue;
      const info = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch {
      // dead port — try the next candidate
    }
  }
  return null;
}

// ─── Minimal CDP client (global WebSocket, flattened sessions) ─────────

interface WsLike {
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export class CdpClient {
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private readonly eventListeners: Array<(e: CdpEvent) => void> = [];

  private constructor(private readonly ws: WsLike) {}

  static connect(wsUrl: string, timeoutMs: number): Promise<CdpClient> {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
    if (!Ctor) throw new Error("global WebSocket is unavailable in this runtime");
    const ws = new Ctor(wsUrl);
    const client = new CdpClient(ws);
    ws.addEventListener("message", (ev) => client.onMessage(ev.data));
    ws.addEventListener("close", () => client.failAll(new Error("CDP connection closed")));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timed out after ${timeoutMs}ms`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(client);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${wsUrl}`));
      });
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  onEvent(listener: (e: CdpEvent) => void): void {
    this.eventListeners.push(listener);
  }

  close(): void {
    this.failAll(new Error("CDP connection closed"));
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private onMessage(data: unknown): void {
    let msg: {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      for (const l of this.eventListeners) l(msg as CdpEvent);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/**
 * Render `url` in a throwaway tab of an attached Chromium and return the
 * hydrated document HTML. Hard-capped at ~10s end to end; the tab is always
 * closed. Throws when no debug endpoint is reachable.
 */
export async function renderOverCdp(url: string, opts: CdpRenderOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const wsUrl = await discoverCdpEndpoint(opts);
  if (!wsUrl) {
    throw new Error(
      "no Chromium debug endpoint reachable (set ARES_BROWSER_CDP_URL or start a browser with --remote-debugging-port=9222)",
    );
  }
  const client = await CdpClient.connect(wsUrl, Math.min(3_000, timeoutMs));
  const onAbort = () => client.close();
  opts.signal?.addEventListener("abort", onAbort);
  let targetId: string | undefined;
  try {
    const remaining = () => Math.max(250, deadline - Date.now());
    targetId = (await client.send("Target.createTarget", { url: "about:blank" }, undefined, remaining()))
      .targetId as string;
    const sessionId = (await client.send("Target.attachToTarget", { targetId, flatten: true }, undefined, remaining()))
      .sessionId as string;
    await client.send("Page.enable", {}, sessionId, remaining());
    const loaded = new Promise<void>((resolve) => {
      client.onEvent((e) => {
        if (e.method === "Page.loadEventFired" && e.sessionId === sessionId) resolve();
      });
    });
    await client.send("Page.navigate", { url }, sessionId, remaining());
    await Promise.race([loaded, sleep(remaining())]);
    const settle = Math.min(opts.settleMs ?? 800, Math.max(0, deadline - Date.now()));
    if (settle > 0) await sleep(settle);
    const evaluated = await client.send(
      "Runtime.evaluate",
      { expression: "document.documentElement.outerHTML", returnByValue: true },
      sessionId,
      remaining(),
    );
    const html = (evaluated.result as { value?: unknown } | undefined)?.value;
    if (typeof html !== "string" || html.length === 0) throw new Error("CDP render returned no document");
    return html;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (targetId) await client.send("Target.closeTarget", { targetId }, undefined, 2_000).catch(() => {});
    client.close();
  }
}

/** Default renderer wired into WebFetch; tests inject a fake instead. */
export const cdpRenderer: JsRenderer = { render: renderOverCdp };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}
