#!/usr/bin/env node
// ares — v2 CLI entrypoint.
//
// Commands:
//   ares chat                                      interactive terminal loop
//   ares run --goal "<text>" [--provider openai|ollama] [--model X]
//   ares login                                      OAuth device-code
//   ares doctor                                     auth + ollama health
//   ares help
//
// `run` emits NDJSON for automation; `chat` renders a human terminal loop.

import { stat } from "node:fs/promises";
import path from "node:path";
import { availableThemes, setTheme, themeChanged } from "./terminalUi.js";
import { parseArgs } from "./entry/args.js";
// Static, NOT lazy wait import(). The packaged runtime is an esbuild ESM
// bundle, and ink -> yoga-layout carries a top-level await; a dynamic import of
// any module in that graph compiles to an async `__esm` initializer that can
// deadlock, which surfaces as the CLI exiting 0 with no output (v0.29.0 shipped
// this and broke daemon/chat/garrison). Keep these static.
import { agentCommand, evalCommand, missionCommand, modelsCommand } from "./entry/agentOps.js";
import { chatCommand, launcherCommand, runCommand } from "./entry/chat.js";
import { daemonCommand } from "./entry/daemon.js";
import { attachCommand, garrisonCommand } from "./entry/garrisonCmd.js";
import { holoCommand } from "./entry/holoCmd.js";
import { checkpointsCommand, doctorCommand, frictionCommand, loginCommand, recapCommand, resumeCommand, sessionsCommand, themesCommand, todayCommand, worldCommand } from "./entry/introspect.js";
import { mindCommand } from "./entry/mindCmd.js";
import { operatorCommand } from "./entry/operatorCmd.js";
import { printHelp } from "./entry/runtime.js";
import { telegramCommand } from "./entry/telegramWiring.js";
import { loadSavedTheme, saveTheme } from "./entry/terminalLines.js";
import { triageCommand } from "./entry/triage.js";

function bridgeLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith("CRIX_")) continue;
    const aresKey = `ARES_${key.slice("CRIX_".length)}`;
    if (env[aresKey] === undefined) env[aresKey] = env[key];
  }
}

const INTERACTIVE_THEME_COMMANDS = new Set([
  "launcher",
  "menu",
  "chat",
  "cli",
  "shell",
  "run",
]);

async function main(): Promise<void> {
  // Rebrand compat: mirror legacy CRIX_* env vars onto ARES_* before anything
  // reads configuration.
  bridgeLegacyEnv();
  const args = parseArgs(process.argv.slice(2));
  const requestedTheme = args.flags.get("theme");
  if (requestedTheme) {
    const selected = setTheme(requestedTheme);
    if (!selected) {
      process.stderr.write(`error: unknown theme "${requestedTheme}". Available: ${availableThemes().join(", ")}\n`);
      process.exit(2);
    }
  } else if (INTERACTIVE_THEME_COMMANDS.has(args.command)) {
    await loadSavedTheme();
  }
  await applyWorkspaceFlag(args.flags);
  switch (args.command) {
    case "launcher":
    case "menu": {
      process.exit(await launcherCommand(args));
      return;
    }
    case "chat":
    case "cli":
    case "shell": {
      process.exit(await chatCommand(args));
      return;
    }
    case "run": {
      process.exit(await runCommand(args));
      return;
    }
    case "daemon": {
      process.exit(await daemonCommand(args));
      return;
    }
    case "agent": {
      process.exit(await agentCommand(args));
      return;
    }
    case "operator": {
      process.exit(await operatorCommand(args));
      return;
    }
    case "mind": {
      process.exit(await mindCommand(args));
      return;
    }
    case "garrison": {
      process.exit(await garrisonCommand(args));
      return;
    }
    case "attach": {
      process.exit(await attachCommand(args));
      return;
    }
    case "telegram": {
      process.exit(await telegramCommand(args));
      return;
    }
    case "holo": {
      process.exit(await holoCommand(args));
      return;
    }
    case "eval": {
      process.exit(await evalCommand(args));
      return;
    }
    case "sessions": {
      process.exit(await sessionsCommand());
      return;
    }
    case "checkpoints": {
      process.exit(await checkpointsCommand());
      return;
    }
    case "themes": {
      process.exit(themesCommand());
      return;
    }
    case "theme": {
      const selected = setTheme(args.positionals[0] ?? args.flags.get("name") ?? "");
      if (!selected) {
        process.stderr.write(`error: usage: ares theme <${availableThemes().join("|")}>\n`);
        process.exit(2);
      }
      await saveTheme(selected);
      process.stdout.write(themeChanged(selected));
      return;
    }
    case "resume": {
      process.exit(await resumeCommand(args));
      return;
    }
    case "recap":
    case "whathappened": {
      process.exit(await recapCommand(args));
      return;
    }
    case "world": {
      process.exit(await worldCommand(args));
      return;
    }
    case "today":
    case "briefing": {
      process.exit(await todayCommand(args));
      return;
    }
    case "models": {
      process.exit(await modelsCommand(args));
      return;
    }
    case "mission": {
      process.exit(await missionCommand(args));
      return;
    }
    case "login": {
      process.exit(await loginCommand());
      return;
    }
    case "doctor": {
      process.exit(await doctorCommand());
      return;
    }
    case "friction": {
      process.exit(await frictionCommand(args));
      return;
    }
    case "triage": {
      process.exit(await triageCommand(args));
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      await printHelp();
      return;
    }
    default:
      process.stderr.write(`error: unknown command "${args.command}". Run \`ares help\`.\n`);
      process.exit(2);
  }
}

async function applyWorkspaceFlag(flags: Map<string, string>): Promise<void> {
  const requested = flags.get("workspace") ?? flags.get("cwd");
  if (!requested) return;
  const target = path.resolve(process.cwd(), requested);
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) {
    process.stderr.write(`error: workspace is not a directory: ${target}\n`);
    process.exit(2);
  }
  process.chdir(target);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
