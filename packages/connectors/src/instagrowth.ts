// InstagrowthConnector — bridges the instagrowth-saas MCP server into
// the Ares Garrison so the Tauri desktop and any garrison client can
// manage Instagram accounts, reaction schedules, targets, and DM outreach
// directly through the agent.
//
// The connector spawns the instagrowth-connector as an MCP child process
// (stdio transport) and exposes its 28 tools as garrison-registered tools.

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const INSTAGROWTH_DIR = join(homedir(), "VAN", "instagrowth-saas", "instagrowth-connector");

export interface IgToolCall {
  name: string;
  params: Record<string, unknown>;
}

export interface IgToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface IgAccount {
  id: number;
  username: string;
  login_required: boolean;
  proxy: string | null;
  status: string;
}

export interface IgAccountCreateInput {
  username: string;
  password: string;
  proxy?: string;
  user_id?: number;
}

export class InstagrowthConnector {
  private proc: ChildProcess | null = null;
  private ready = false;
  private tools: string[] = [];

  /** Start the instagrowth MCP server as a child process. */
  async start(): Promise<void> {
    if (!existsSync(INSTAGROWTH_DIR)) {
      throw new Error(`instagrowth-connector not found at ${INSTAGROWTH_DIR}`);
    }

    return new Promise((resolve, reject) => {
      this.proc = spawn("node", ["--input-type=commonjs", "-e", `
        const { createMcpServer } = require("${INSTAGROWTH_DIR}/mcp-server.js");
        const server = createMcpServer();
        process.on("message", async (msg) => {
          try {
            const result = await server.callTool(msg.name, msg.params);
            process.send?.({ id: msg.id, ok: true, data: result });
          } catch (err) {
            process.send?.({ id: msg.id, ok: false, error: err.message });
          }
        });
        process.send?.({ type: "ready", tools: server.listTools().map(t => t.name) });
      `], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        cwd: INSTAGROWTH_DIR,
      });

      this.proc.on("message", (msg: any) => {
        if (msg.type === "ready") {
          this.tools = msg.tools;
          this.ready = true;
          resolve();
        }
      });

      this.proc.on("error", reject);
      this.proc.stderr?.on("data", (d) => {/* suppress */});

      setTimeout(() => { if (!this.ready) reject(new Error("instagrowth startup timeout")); }, 10000);
    });
  }

  /** Call an instagrowth tool. */
  async call(name: string, params: Record<string, unknown> = {}): Promise<IgToolResult> {
    if (!this.ready || !this.proc) throw new Error("instagrowth connector not started");

    return new Promise((resolve) => {
      const id = Date.now();
      const handler = (msg: any) => {
        if (msg.id === id) {
          this.proc?.removeListener("message", handler);
          resolve(msg);
        }
      };
      this.proc!.on("message", handler);
      this.proc!.send({ id, name, params });
    });
  }

  /** List available tools. */
  listTools(): string[] {
    return [...this.tools];
  }

  /** Shorthand: list all accounts. */
  async listAccounts(): Promise<IgAccount[]> {
    const r = await this.call("accounts_list", { limit: 200 });
    if (!r.ok) throw new Error(r.error);
    return (r.data as any).accounts || [];
  }

  /** Shorthand: get account stats. */
  async accountStats(): Promise<{ total: number; active: number; login_required: number }> {
    const r = await this.call("accounts_stats");
    if (!r.ok) throw new Error(r.error);
    return r.data as any;
  }

  /** Shorthand: add a new Instagram account. */
  async createAccount(input: IgAccountCreateInput): Promise<{ status: string; account_id: number; username: string }> {
    const r = await this.call("accounts_add", input as any);
    if (!r.ok) throw new Error(r.error);
    return r.data as any;
  }

  /** Shorthand: trigger relogin for accounts needing it. */
  async triggerRelogin(accountId?: number, username?: string): Promise<any> {
    const r = await this.call("accounts_trigger_relogin", accountId ? { account_id: accountId } : username ? { username } : {});
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  /** Shorthand: list reaction schedules. */
  async listReactionSchedules(status?: string): Promise<any[]> {
    const r = await this.call("reactions_list_schedules", status ? { status } : {});
    if (!r.ok) throw new Error(r.error);
    return (r.data as any).schedules || [];
  }

  /** Shorthand: add a reaction target to a schedule. */
  async addReactionTarget(scheduleId: number, target: string): Promise<any> {
    const r = await this.call("reactions_add_target", { schedule_id: scheduleId, target });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

/** Singleton — created lazily, shared across the garrison. */
let instance: InstagrowthConnector | null = null;

export function getInstagrowth(): InstagrowthConnector {
  if (!instance) instance = new InstagrowthConnector();
  return instance;
}
