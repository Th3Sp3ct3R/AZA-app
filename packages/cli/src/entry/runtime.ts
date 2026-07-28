// Extracted from entry.ts — runtime.

import { aresHome } from "@ares/core";
import { TERMINAL_PROVIDERS } from "./providers.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode } from "@ares/protocol";
import { type PermissionSettings } from "../permissionPolicy.js";
import { aresAgentHome } from "@ares/agent";
import { mindPaths } from "@ares/mind";
import { effectsPaths, type RailsContext } from "@ares/effects";

export interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  let command = "launcher";
  let rest = argv;
  if (argv[0] === "--help" || argv[0] === "-h") {
    command = argv[0];
    rest = argv.slice(1);
  } else if (argv[0] && !argv[0].startsWith("--")) {
    command = argv[0];
    rest = argv.slice(1);
  }
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, flags, positionals };
}

let cachedCliVersion: string | undefined;

/** The shipped CLI version, read from this package's own package.json instead
 *  of a hardcoded literal that goes stale every release (was "0.11.2" while
 *  the actual build had moved on). Walks up from dist/entry/ (or src/entry/)
 *  until it finds the package.json. */
export async function cliVersion(): Promise<string> {
  if (cachedCliVersion) return cachedCliVersion;
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    let version: string | undefined;
    for (let depth = 0; depth < 4 && !version; depth++) {
      dir = path.dirname(dir);
      const raw = await readFile(path.join(dir, "package.json"), "utf8").catch(() => null);
      if (raw) version = (JSON.parse(raw) as { version?: string }).version;
    }
    cachedCliVersion = version ?? "0.0.0";
  } catch {
    cachedCliVersion = "0.0.0";
  }
  return cachedCliVersion;
}

export interface AresRuntimeState {
  permissionMode: PermissionMode;
  /** Live owner permission posture (master + per-category + fleet inherit).
   *  Mutated by the set_permissions daemon command so toggles apply mid-session. */
  permissions?: PermissionSettings;
}

export interface CliRuntimeContext {
  workspace: string;
  home: string;
  aresHome: string;
  mind: ReturnType<typeof mindPaths>;
  effects: ReturnType<typeof effectsPaths>;
  selfTerritoryRoots: string[];
  browserFilmstripRoot: string;
  /**
   * Owner-approval hook for staged outward effects. Set by `garrison serve` so a
   * staged effect surfaces on the gateway and pauses for the owner. Unset on the
   * plain stdio paths → rails keep the legacy "hold, never commit" behavior.
   */
  approvals?: { requestApproval: RailsContext["requestApproval"] };
}

export function cliRuntimeContext(options: { workspace?: string; home?: string } = {}): CliRuntimeContext {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const home = aresAgentHome(options.home);
  return {
    workspace,
    home,
    // An explicit home is an isolation boundary (tests/evals/portable installs),
    // not merely a Mind-directory override. Permission and auth-adjacent state
    // must follow it instead of leaking back to the owner's global ~/.ares.
    aresHome: options.home ? path.resolve(options.home) : aresHome(),
    mind: mindPaths(home),
    effects: effectsPaths(home),
    selfTerritoryRoots: [home],
    browserFilmstripRoot: path.join(home, "operator", "browser", "filmstrip"),
  };
}

export function compactLine(text: string, limit: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= limit ? one : `${one.slice(0, Math.max(0, limit - 1))}…`;
}

export function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export async function printHelp(): Promise<void> {
  const providerList = TERMINAL_PROVIDERS.join("|");
  process.stdout.write(
    [
      `ares v${await cliVersion()} — autonomous AI agent`,
      "",
      "Commands:",
      "  ares launcher                                Open the provider/model launch deck.",
      `  ares chat [--provider ${providerList}] [--model X]`,
      "                              Open an interactive terminal prompt.",
      "  ares sessions               List saved workspace sessions.",
      "  ares checkpoints            List workspace checkpoints.",
      "  ares resume [session-id]     Resume a saved session (defaults to latest).",
      "  ares themes                 List terminal UI themes.",
      `  ares run --goal "<text>" [--provider ${providerList}] [--model X]`,
      "                              Run one turn, streaming TurnEvents as NDJSON.",
      "  ares daemon --json          Run NDJSON daemon mode for companion UIs.",
      "  ares agent bootstrap        Create or complete the v4 mind scaffold.",
      "  ares agent doctor           Show agent memory/backend status.",
      "  ares operator add --goal \"<text>\"    Create a durable long-horizon goal.",
      "                              Optional: --criteria \"A;B\" --constraint \"C\" --verify-file path [--verify-contains text].",
      "  ares operator draft --capability \"<name>\"",
      "                              Draft a capability before promotion.",
      "  ares operator acquire --capability \"email connector\" [--kind connector] [--ticks N]",
      "                              Register a missing capability and create its self-build goal.",
      "  ares operator promote --capability <id> --eval-report report.json [--evidence \"...\"]",
      "                              Promote only after verified outcomes, evidence, and evals.",
      "  ares operator review [--capability <id>] [--json]",
      "                              Inspect capability promotion/rejection status.",
      "  ares operator missions [--json]       Inspect mission contracts.",
      "  ares operator mission status <id> [--json]",
      "                              Inspect one mission contract.",
      "  ares operator list | status [id]     Inspect Operator goals.",
      "  ares operator run [--goal \"<text>\"] [--ticks N] [--provider X]",
      "                              Drive active goals via ephemeral QueryEngine workers.",
      "  ares operator caps | stats | attention [--json]",
      "                              Inspect capabilities, growth curve, and current attention queue.",
      "  ares operator trust [--json]         Earned leash per domain (the trust meter).",
      "  ares mind recall \"<cue>\" [--json]   Spreading-activation recall from Living Memory.",
      "  ares mind add --content \"<text>\" [--kind episodic|semantic|procedural]",
      "  ares mind list | doctor | consolidate [--json]",
      "                              Inspect, diagnose, or sleep-consolidate memory.",
      "  ares eval [--json]         Run the built-in harness regression eval suite.",
      "  ares eval coding [--suite coding-v2|coding-v1] [--no-harness] [--json]",
      "                              Run the coding gauntlet; real models require --allow-unsafe-process-eval inside an isolated VM/container.",
      "  ares login                  ChatGPT OAuth device-code flow.",
      "  ares doctor                 Show provider auth + Ollama Cloud health.",
      "  ares friction [--days N]    Telemetry report: tool errors, edit tiers, stalls, cache health.",
      "  ares help                   Print this help.",
      "",
      "Env vars:",
      "  ARES_OPENAI_OAUTH_TOKEN     ChatGPT OAuth access token (bypass file login).",
      "  ARES_REASONER, ARES_APPLY, ARES_SUMMARIZE",
      "                              Override Ollama Cloud slot models.",
      "  ARES_HOME                   Override auth/config dir (default ~/.ares).",
      "  ARES_RESUME_MESSAGES        Max replay messages before compaction (default 80, 0=all).",
      "  ARES_THEME                  UI theme: cyberpunk, minimal, matrix, neon, split, professional, amber, dashboard, light.",
      "",
      "Flags:",
      "  --theme NAME                Use a UI theme for this run.",
      "  --workspace PATH            Run Ares against a specific workspace.",
      "",
      "Double-click ares.bat or run `ares chat` for the interactive prompt.",
      "",
    ].join("\n"),
  );
}
