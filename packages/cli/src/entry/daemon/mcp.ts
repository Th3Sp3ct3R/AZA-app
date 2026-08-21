// Remote-MCP directory snapshot for the daemon's mcp_* commands.

import { loadRemoteMcpServers } from "@ares/core";

/** One row per connected remote MCP connector, shaped for the /mcp explorer. */
export async function mcpDirectorySnapshot(): Promise<Array<{ name: string; url: string; displayName: string; oauth: boolean; connectedAt: string | null; enabled: boolean }>> {
  const servers = await loadRemoteMcpServers().catch(() => ({}));
  return Object.entries(servers).map(([name, e]) => ({
    name,
    url: e.url,
    displayName: e.displayName ?? name,
    oauth: !!e.oauth,
    connectedAt: e.connectedAt ?? null,
    enabled: e.enabled !== false,
  }));
}
