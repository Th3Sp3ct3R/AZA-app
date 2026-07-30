// MCP — minimal stdio client tools.
//
// Loads servers from .ares/mcp.json and ~/.ares/mcp.json. The config shape
// mirrors common MCP clients:
// { "servers": { "name": { "command": "node", "args": ["server.js"], "env": {} } } }

import { z } from "zod";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTool, toolError } from "./_shared.js";
import { getMcpAccessToken } from "@ares/core";

const listInputSchema = z
  .object({
    server: z.string().optional().describe("Optional server name. Omit to list configured servers and tools."),
    timeout_ms: z.number().int().positive().max(60_000).default(20_000),
  })
  .strict();

const callInputSchema = z
  .object({
    server: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
    timeout_ms: z.number().int().positive().max(120_000).default(60_000),
  })
  .strict();

interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** A remote MCP server reachable over Streamable HTTP. `url` is the message
 *  endpoint; `authToken` (or an explicit Authorization in `headers`) is the
 *  bearer used on every request. Remote connectors persisted by the OAuth
 *  gallery live in ~/.ares/mcp-remote.json in this shape. */
interface RemoteServerConfig {
  url: string;
  headers?: Record<string, string>;
  authToken?: string;
  /** OAuth connector — the bearer lives in the encrypted vault, not here. */
  oauth?: boolean;
  /** Injected at load time (the config-map key) so the vault token resolves. */
  serverName?: string;
}

type McpServerConfig = StdioServerConfig | RemoteServerConfig;

function isRemote(cfg: McpServerConfig): cfg is RemoteServerConfig {
  return typeof (cfg as RemoteServerConfig).url === "string" && (cfg as RemoteServerConfig).url.length > 0;
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface McpListOutput {
  configFiles: string[];
  servers: Array<{ name: string; tools?: unknown[]; error?: string }>;
}

export interface McpCallOutput {
  server: string;
  tool: string;
  result: unknown;
}

export const McpListToolsTool = buildTool({
  name: "McpListTools",
  description:
    "List MCP servers and their exposed tools from .ares/mcp.json and ~/.ares/mcp.json. Use before McpCallTool when the user configured MCP servers.",
  safety: "external-state",
  concurrency: "parallel-safe",
  inputZod: listInputSchema,
  activityDescription: (i) => (i.server ? `Listing MCP tools from ${i.server}` : "Listing MCP servers"),

  async call(i, ctx): Promise<{ output: McpListOutput; display: string }> {
    const loaded = await loadMcpConfig(ctx.workspace);
    const selected = Object.entries(loaded.servers).filter(([name]) => !i.server || name === i.server);
    const servers: McpListOutput["servers"] = [];
    for (const [name, cfg] of selected) {
      try {
        const result = await withMcpClient(cfg, i.timeout_ms, async (client) => await client.request("tools/list", {}));
        servers.push({ name, tools: (result as { tools?: unknown[] }).tools ?? [] });
      } catch (err) {
        servers.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      output: { configFiles: loaded.configFiles, servers },
      display: `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`,
    };
  },
});

/** Tool listing for the desktop `/mcp` explorer: connects to one named server
 *  (even a paused one — the panel shows what it WOULD provide) and returns its
 *  tools. Not agent-facing; the daemon calls this on behalf of the panel. */
export async function listMcpServerTools(
  workspace: string,
  server: string,
  timeoutMs?: number,
): Promise<{ tools: Array<{ name: string; description?: string }>; error?: string }> {
  const loaded = await loadMcpConfig(workspace, true);
  const cfg = loaded.servers[server];
  if (!cfg) return { tools: [], error: `unknown MCP server: ${server}` };
  try {
    const result = await withMcpClient(cfg, timeoutMs ?? 15_000, async (client) => await client.request("tools/list", {}));
    const raw = (result as { tools?: unknown[] }).tools ?? [];
    const tools = raw
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({
        name: typeof t.name === "string" ? t.name : "",
        description: typeof t.description === "string" ? t.description : undefined,
      }))
      .filter((t) => t.name);
    return { tools };
  } catch (err) {
    return { tools: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export const McpCallTool = buildTool({
  name: "McpCallTool",
  description:
    "Call a tool exposed by a configured MCP stdio server. Run McpListTools first to discover available tools and schemas.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: callInputSchema,
  activityDescription: (i) => `MCP ${i.server}/${i.tool}`,

  async call(i, ctx): Promise<{ output: McpCallOutput; display: string }> {
    const loaded = await loadMcpConfig(ctx.workspace);
    const cfg = loaded.servers[i.server];
    if (!cfg) throw new Error(`Unknown MCP server: ${i.server}`);
    const result = await withMcpClient(
      cfg,
      i.timeout_ms,
      async (client) =>
        await client.request("tools/call", {
          name: i.tool,
          arguments: i.arguments,
        }),
    );
    // A tools/call can succeed at the JSON-RPC layer yet report a tool-level
    // failure via isError. Surface it as a thrown is_error tool_result like every
    // other tool, so the engine's failure-breakers fire instead of the model
    // having to spot a buried "isError":true in the JSON.
    if (result != null && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
      throw toolError(`${i.server}/${i.tool}: ${extractMcpErrorText(result)}`);
    }
    return {
      output: { server: i.server, tool: i.tool, result },
      display: `called ${i.server}/${i.tool}`,
    };
  },
});

// Pull a human-readable message out of a tools/call result's content array.
// MCP content blocks are typically [{ type:"text", text:"…" }]; we join the text
// blocks and fall back to a stringified result when no text is present.
function extractMcpErrorText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block != null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter((t) => t.length > 0)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "tool reported an error";
}

async function loadMcpConfig(workspace: string, includeDisabled = false): Promise<{ servers: Record<string, McpServerConfig>; configFiles: string[] }> {
  const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
  // mcp-remote.json is written by the connector gallery (remote HTTP servers);
  // mcp.json is the classic hand-authored (usually stdio) config.
  const candidates = [
    path.join(home, "mcp.json"),
    path.join(home, "mcp-remote.json"),
    path.join(workspace, ".ares", "mcp.json"),
  ];
  const servers: Record<string, McpServerConfig> = {};
  const configFiles: string[] = [];
  for (const file of candidates) {
    try {
      const json = JSON.parse(await fs.readFile(file, "utf8")) as McpConfig;
      const entries = json.servers ?? json.mcpServers ?? {};
      for (const [name, cfg] of Object.entries(entries)) {
        // A paused connector (enabled:false from the /mcp toggle) keeps its
        // tokens but contributes no tools.
        if (!includeDisabled && (cfg as { enabled?: boolean }).enabled === false) continue;
        servers[name] = cfg;
      }
      configFiles.push(file);
    } catch {
      // absent or invalid; ignore here so the tool still reports what is available
    }
  }
  // Tag remote entries with their name so the OAuth-token resolver can find the
  // matching vault bundle at call-time.
  for (const [name, cfg] of Object.entries(servers)) {
    if (isRemote(cfg)) (cfg as RemoteServerConfig).serverName = name;
  }
  return { servers, configFiles };
}

class StdioMcpClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  // The child's first spawn 'error' (e.g. ENOENT for a missing command). It can
  // fire before any request is enqueued, so we stash it and let initialize()/
  // request() reject with it immediately instead of stalling until the timeout.
  spawnError: Error | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      void chunk;
    });
    // A bad/missing server command emits an async 'error' (ENOENT is common on a
    // first run). Unhandled, that becomes an uncaught exception that can crash the
    // daemon — so reject all in-flight requests, mirroring the "close" handler.
    child.on("error", (err) => {
      this.spawnError = err instanceof Error ? err : new Error(String(err));
      for (const p of this.pending.values()) p.reject(this.spawnError);
      this.pending.clear();
    });
    // A write to a dead child's stdin would otherwise raise its own unhandled
    // stream error; swallow it — the 'error'/'close' handlers already reject.
    child.stdin.on("error", () => {});
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ares", version: "0.11.2" },
    });
    this.notify("notifications/initialized", {});
  }

  request(method: string, params: unknown): Promise<unknown> {
    // If the child already failed to spawn, fail fast instead of writing to a dead
    // stdin and waiting out the Promise.race timeout.
    if (this.spawnError) return Promise.reject(this.spawnError);
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    this.writeMessage(msg);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private writeMessage(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lenMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lenMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      // A malformed frame must not kill the client and orphan in-flight requests;
      // drop the bad frame and keep draining so well-formed frames still resolve.
      try {
        this.handleMessage(JSON.parse(body) as { id?: number; result?: unknown; error?: { message?: string } });
      } catch {
        // unparseable JSON-RPC frame; skip it
      }
    }
  }

  private handleMessage(msg: { id?: number; result?: unknown; error?: { message?: string } }): void {
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP error"));
    else pending.resolve(msg.result);
  }
}

/** The subset of the client both transports share — enough for list/call. */
interface McpClient {
  initialize(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
}

/** MCP over Streamable HTTP (the remote-connector transport). One JSON-RPC
 *  request per POST; the server answers with either a JSON body or an SSE
 *  stream whose `data:` event carries the response. A session id handed back on
 *  initialize is echoed on every later request. Injectable fetch for tests. */
export class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private readonly protocolVersion = "2025-06-18";

  constructor(
    private readonly url: string,
    private readonly baseHeaders: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "ares", version: "1" },
    });
    // Best-effort per spec; a server that rejects the notification must not
    // break the session, so swallow errors here.
    await this.send("notifications/initialized", {}, true).catch(() => undefined);
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.send(method, params, false);
  }

  private async send(method: string, params: unknown, isNotification: boolean): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    if (!isNotification) body.id = this.nextId++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocolVersion,
      ...this.baseHeaders,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (isNotification) return undefined;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`MCP server rejected auth (HTTP ${res.status}) — reconnect this connector`);
    }
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} from ${this.url}`);

    const ctype = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const message = ctype.includes("text/event-stream") ? parseSseJsonRpc(text) : safeJson(text);
    if (message == null) throw new Error("MCP server returned an empty/unparseable response");
    if (message.error) throw new Error(message.error.message ?? "MCP error");
    return message.result;
  }
}

/** Pull the first JSON-RPC response object out of an SSE body (the `data:`
 *  lines of the last event that parses as a JSON-RPC message). */
function parseSseJsonRpc(text: string): { result?: unknown; error?: { message?: string } } | null {
  let last: { result?: unknown; error?: { message?: string } } | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    const parsed = safeJson(data);
    if (parsed && ("result" in parsed || "error" in parsed)) last = parsed;
  }
  return last;
}

function safeJson(text: string): { result?: unknown; error?: { message?: string } } | null {
  try {
    return JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  } catch {
    return null;
  }
}

async function withMcpClient<T>(
  cfg: McpServerConfig,
  timeoutMs: number,
  fn: (client: McpClient) => Promise<T>,
): Promise<T> {
  if (isRemote(cfg)) {
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
    // OAuth connectors carry no secret on disk — resolve a fresh (auto-refreshed)
    // access token from the encrypted vault at call-time. A manually pasted
    // authToken is used as-is. Either way it becomes the bearer.
    let bearer = cfg.authToken;
    if (cfg.oauth && cfg.serverName) {
      bearer = (await getMcpAccessToken(cfg.serverName).catch(() => null)) ?? bearer;
    }
    if (bearer && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${bearer}`;
    }
    const client = new HttpMcpClient(cfg.url, headers);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        (async () => {
          await client.initialize();
          return await fn(client);
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const child = spawn(cfg.command, cfg.args ?? [], {
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.env ?? {}) },
    windowsHide: true,
  });
  const client = new StdioMcpClient(child);
  // Capture the handle so we can clear it after the race settles; an un-cleared
  // timer keeps the event loop alive and can fire a late no-op rejection. unref()
  // also stops it from holding the process open on its own.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  // A spawn 'error' (e.g. ENOENT) can fire before/around initialize(); surface it
  // as an immediate rejection rather than stalling until the timeout. If the error
  // already happened, reject synchronously via spawnError.
  const spawnFailed = new Promise<never>((_, reject) => {
    if (client.spawnError) reject(client.spawnError);
    else child.once("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
  try {
    return await Promise.race([
      (async () => {
        await client.initialize();
        return await fn(client);
      })(),
      spawnFailed,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
