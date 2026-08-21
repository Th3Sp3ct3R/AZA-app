// Cross-platform `ares` CLI uninstaller — the exact inverse of install-cli.mjs.
//
//   pnpm uninstall:cli
//   pnpm uninstall:cli -- --dir <path>
//   ARES_CLI_BIN_DIR=<path> pnpm uninstall:cli
//
// It removes ONE thing: the launcher this repo's installer created, resolved
// through the same precedence rules so `--dir` round-trips. Three refusals are
// deliberate:
//   • a regular file without the Ares marker lines is left alone and reported
//     as an error — an uninstaller that deletes whatever it finds at a shared
//     prefix is a footgun, not a convenience;
//   • a SYMLINK at that path is left alone. Ares never creates one for this
//     launcher, so a link here cannot be identified as ours — and removing
//     something we cannot claim is not the uninstaller's call. (Unlinking a
//     symlink would remove the link, not its target; the refusal is caution
//     about ownership, not about destroying the target.);
//   • ~/.ares is never touched. Config, encrypted vault, sessions, memory and
//     identity survive uninstall by design; removing the launcher is not a
//     request to destroy the agent's state.
// Running it twice is a no-op, not an error.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LAUNCHER_NAME, inspectLauncherPath, isHelpRequest, parseArgs, resolveBinDir } from "./install-cli.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

/** Which uninstall path applies. Pure, so tests can assert the Windows branch
 *  without invoking powershell.exe or mutating a real user PATH. */
export function resolvePlatformPlan(platform = process.platform) {
  return platform === "win32"
    ? { mode: "windows", script: path.join(repoRoot, "scripts", "uninstall.ps1") }
    : { mode: "posix" };
}

/**
 * Remove the launcher from `binDir`.
 * Returns `{ removed: false, reason: "absent" }` when there is nothing to do,
 * and throws only when it found something it must NOT delete.
 */
export function uninstallPosixLauncher({ binDir } = {}) {
  const target = path.join(binDir, LAUNCHER_NAME);
  const found = inspectLauncherPath(target);

  if (found.kind === "absent") return { target, removed: false, reason: "absent" };
  if (found.kind !== "ours") {
    const what =
      found.kind === "symlink"
        ? "it is a symlink, and Ares never creates one"
        : found.kind === "other"
          ? "it is not a regular file"
          : "it was not created by Ares";
    throw new Error(
      `Refusing to delete ${target}: ${what}.\n` +
        "Nothing was removed. Delete it yourself if that is really what you want.",
    );
  }

  fs.rmSync(target);
  // The directory itself is left in place even when it ends up empty: it is a
  // shared user prefix (XDG_BIN_HOME / ~/.local/bin), not ours to remove.
  return { target, removed: true, reason: "removed" };
}

/** The exact PowerShell invocation used on Windows. Pure, so tests can assert
 *  verbatim argument forwarding without spawning anything — uninstall.ps1 edits
 *  the real user PATH and must never run in CI. */
export function buildWindowsInvocation(argv = []) {
  const { script } = resolvePlatformPlan("win32");
  return {
    command: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...argv],
  };
}

/** Hand off to uninstall.ps1 on Windows, preserving its exit code. Arguments go
 *  through the argv array — never concatenated into a command string. */
function runWindowsUninstaller(argv) {
  const { command, args } = buildWindowsInvocation(argv);
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export const USAGE = `Usage: pnpm uninstall:cli [-- --dir <path>]

  --dir <path>   where the \`ares\` launcher was installed
  --help         show this message

Removes only the launcher. Your ~/.ares config, vault, and sessions are left intact.`;

async function main(argv = process.argv.slice(2)) {
  // Same order as the installer: help everywhere, then Windows with argv
  // untouched, then the POSIX option grammar.
  if (isHelpRequest(argv)) {
    console.log(USAGE);
    return;
  }

  if (resolvePlatformPlan().mode === "windows") {
    process.exitCode = runWindowsUninstaller(argv);
    return;
  }

  parseArgs(argv);
  const binDir = resolveBinDir({ argv });
  const result = uninstallPosixLauncher({ binDir });

  console.log("");
  if (result.removed) console.log(`  removed launcher: ${result.target}`);
  else console.log(`  nothing to remove: ${result.target} is not installed`);
  console.log("  (your ~/.ares config, vault, and sessions were left intact)");
  console.log("");
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(scriptPath);
  } catch {
    return path.resolve(entry) === scriptPath;
  }
})();

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
