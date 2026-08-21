import path from "node:path";
import { aresHome } from "@ares/mind";

export interface AgentPaths {
  home: string;
  identity: string;
  soul: string;
  /** LAWS.md — the owner's standing orders, injected ALWAYS-ON (see laws.ts). */
  laws: string;
  user: string;
  heartbeat: string;
  memory: string;
  capabilities: string;
  config: string;
  bootstrap: string;
  vectorsDb: string;
  vectorsJson: string;
  memoryDir: string;
  transcriptsDir: string;
  skillsDir: string;
  dreamsDir: string;
  dreamsDiary: string;
  heartbeatState: string;
  missionsDir: string;
  selfDir: string;
  selfModel: string;
  /** The persona roster: <home>/roster/<name>/AGENT.md. Deliberately NOT
   *  ".ares/agents" — that name is already taken, workspace-side, by subagent
   *  run transcripts (core/subagents.ts writes .ares/agents/<runId>/). */
  rosterDir: string;
}

/** Resolve the agent home — delegates to the mind layer's resolution so the
 *  whole entity shares one home. */
export function aresAgentHome(explicit?: string): string {
  return aresHome(explicit);
}

export function agentPaths(home = aresAgentHome()): AgentPaths {
  return {
    home,
    identity: path.join(home, "IDENTITY.md"),
    soul: path.join(home, "SOUL.md"),
    laws: path.join(home, "LAWS.md"),
    user: path.join(home, "USER.md"),
    heartbeat: path.join(home, "HEARTBEAT.md"),
    memory: path.join(home, "MEMORY.md"),
    capabilities: path.join(home, "CAPABILITIES.md"),
    config: path.join(home, "config.json"),
    bootstrap: path.join(home, "BOOTSTRAP.md"),
    vectorsDb: path.join(home, "vectors.db"),
    vectorsJson: path.join(home, "vectors.json"),
    memoryDir: path.join(home, "memory"),
    transcriptsDir: path.join(home, "transcripts"),
    skillsDir: path.join(home, "skills"),
    dreamsDir: path.join(home, ".dreams"),
    dreamsDiary: path.join(home, "DREAMS.md"),
    heartbeatState: path.join(home, "memory", "heartbeat-state.json"),
    missionsDir: path.join(home, "missions"),
    selfDir: path.join(home, "self"),
    selfModel: path.join(home, "self", "model.json"),
    rosterDir: path.join(home, "roster"),
  };
}

export function workspaceToolsPath(workspace: string): string {
  return path.join(path.resolve(workspace), ".ares", "TOOLS.md");
}

