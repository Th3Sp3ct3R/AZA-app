// Cross-platform `ares` CLI installer (from source).
//
// WHY a Node script and not a second shell/PowerShell pair: `pnpm install:cli`
// used to invoke powershell.exe unconditionally, so the very first command a
// contributor runs failed outright anywhere but Windows. The parts that matter
// — WHERE the launcher goes, WHAT it contains, whether it is safe to overwrite
// — are identical on every platform, so they live here once. Only the tail
// differs: on Windows we hand off to the existing, battle-tested install.ps1
// instead of reimplementing its user-PATH handling.
//
//   pnpm install:cli                        # default location
//   pnpm install:cli -- --dir <path>        # explicit destination
//   ARES_CLI_BIN_DIR=<path> pnpm install:cli
//
// POSIX posture, on purpose:
//   • never runs sudo, and the DEFAULT destination is a per-user directory.
//     An explicit --dir / ARES_CLI_BIN_DIR may point anywhere the invoking user
//     can write, including a shared one — that is the caller's choice;
//   • your PATH and your shell rc files are NEVER edited. If the target dir is
//     not already on PATH we say so and print a line you can add yourself.
//     Silently rewriting a shell profile is not something an installer should
//     do behind your back, and it is the single hardest thing to undo;
//   • ~/.ares (config, vault, sessions, memory) is never read, written, or
//     deleted — not by install, not by uninstall.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** First line of every launcher we generate. */
export const LAUNCHER_SHEBANG = "#!/bin/sh";

/**
 * Second line of every launcher we generate, matched EXACTLY.
 *
 * Ownership is decided on the anchored pair (line 1 + line 2), never on a
 * substring search and never on a prefix: `startsWith` would still claim
 * `# ares-cli-launcher:v1-mine`, and a bare `includes` would claim any script
 * that merely mentions Ares in a comment — uninstall would then delete it.
 * Human-facing text lives on line 3 so it can change without touching identity.
 * The `:v1` tag is what a future format change would bump.
 */
export const LAUNCHER_MARKER = "# ares-cli-launcher:v1";

/** The launcher's file name. Windows additionally gets an `ares.cmd` shim,
 *  which install.ps1 owns. */
export const LAUNCHER_NAME = "ares";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

/** Path of the built CLI entrypoint the launcher will exec. */
export function cliEntryPath(root = repoRoot) {
  return path.join(root, "packages", "cli", "dist", "entry.js");
}

/**
 * Which install path applies. Kept as a pure function so tests can assert that
 * Windows delegates to PowerShell WITHOUT running powershell.exe or touching a
 * real user PATH.
 */
export function resolvePlatformPlan(platform = process.platform) {
  return platform === "win32"
    ? { mode: "windows", script: path.join(repoRoot, "scripts", "install.ps1") }
    : { mode: "posix" };
}

/**
 * Parse the accepted flags. An unrecognised option is an ERROR, not something
 * to skip: silently ignoring `--dirr /tmp/x` would install to the default
 * prefix while the user believes they redirected it.
 *
 * `--` is accepted and ignored — `pnpm install:cli -- --dir X` forwards the
 * separator verbatim, so rejecting it would break the documented invocation.
 */
export function parseArgs(argv = []) {
  const parsed = { dir: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--dir requires a path (e.g. --dir ~/.local/bin).");
      }
      parsed.dir = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      parsed.dir = arg.slice("--dir=".length);
      if (!parsed.dir) throw new Error("--dir requires a path (e.g. --dir=~/.local/bin).");
      continue;
    }
    throw new Error(`Unknown option: ${arg}\nUsage: [--dir <path>] [--help]`);
  }
  return parsed;
}

/**
 * Reject paths containing a newline or carriage return.
 *
 * A newline survives single-quoting in `sh`, so the generated launcher would
 * still *work* — but a path like this is always a mistake or an injection
 * attempt, and a launcher whose body silently spans extra lines is not
 * something we want to hand a user. Failing loudly is the honest behavior.
 */
export function assertSafePath(value, label) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} contains a newline or carriage return, which is not supported: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Where the launcher goes, most explicit wins:
 *   1. --dir <path>          (one-off, what the tests use)
 *   2. ARES_CLI_BIN_DIR      (dedicated override)
 *   3. $XDG_BIN_HOME         (an optional override Ares honours; note it is NOT
 *                             part of the XDG Base Directory specification,
 *                             though many tools have converged on it)
 *   4. $HOME/.local/bin      (what every distro puts on PATH by default)
 * Throws with an actionable message when none of them can be resolved, rather
 * than silently installing into the process cwd.
 */
export function resolveBinDir({ env = process.env, argv = [] } = {}) {
  const explicit = parseArgs(argv).dir ?? env.ARES_CLI_BIN_DIR;
  if (explicit?.trim()) return path.resolve(assertSafePath(explicit.trim(), "Install directory"));
  if (env.XDG_BIN_HOME?.trim()) return path.resolve(assertSafePath(env.XDG_BIN_HOME.trim(), "XDG_BIN_HOME"));
  const home = env.HOME?.trim();
  if (home) return path.join(path.resolve(assertSafePath(home, "HOME")), ".local", "bin");
  throw new Error(
    "Cannot resolve an install directory: HOME is unset and neither --dir nor ARES_CLI_BIN_DIR was given.",
  );
}

/** Single-quote a string for POSIX sh. Handles spaces, and the embedded-quote
 *  case that naive quoting gets wrong (a workspace can live anywhere). */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * The PATH line we print when the destination is not on PATH.
 *
 * The destination is SINGLE-QUOTED, never interpolated into double quotes: a
 * directory containing `"`, `$(...)`, or backticks would otherwise turn the
 * suggestion into a command that runs something when the user pastes it. We
 * are handing a user a line to execute; it has to be safe by construction, not
 * by hoping paths are boring. `"$PATH"` stays expandable on purpose — that one
 * is ours, not user input.
 */
export function renderPathHint(binDir) {
  return `export PATH=${shellQuote(assertSafePath(binDir, "Install directory"))}:"$PATH"`;
}

/**
 * The launcher script.
 *
 * It prefers whatever `node` is on PATH so a later Node upgrade (nvm, a distro
 * package) keeps working, and falls back to the absolute interpreter that ran
 * the installer. That fallback is not belt-and-braces: a launcher started from
 * a .desktop entry or a systemd unit does NOT source your shell profile, so an
 * nvm-managed `node` is simply absent there — PATH-only would give a launcher
 * that works in your terminal and nowhere else.
 *
 * If BOTH are gone (Node uninstalled, nvm version pruned) the launcher says so
 * in words. Left to `exec`, the user would get a bare "not found" naming a path
 * they never typed.
 *
 * ARES_ENTRY is an ABSOLUTE path into this checkout: move or delete the
 * checkout and the launcher stops working — re-run the installer after moving.
 *
 * The two paths are quoted independently, and the output is deterministic (no
 * timestamps) so re-running the installer produces a byte-identical file —
 * which is what makes idempotence checkable.
 */
export function renderLauncher({ nodePath, entryPath }) {
  assertSafePath(nodePath, "Node interpreter path");
  assertSafePath(entryPath, "CLI entry path");
  return [
    LAUNCHER_SHEBANG,
    LAUNCHER_MARKER,
    "# Generated by scripts/install-cli.mjs — do not edit. Remove with: pnpm uninstall:cli",
    `ARES_ENTRY=${shellQuote(entryPath)}`,
    `ARES_NODE=${shellQuote(nodePath)}`,
    "if command -v node >/dev/null 2>&1; then",
    `  exec node "$ARES_ENTRY" "$@"`,
    "fi",
    `if [ -x "$ARES_NODE" ]; then`,
    `  exec "$ARES_NODE" "$ARES_ENTRY" "$@"`,
    "fi",
    `echo "ares: no usable Node found." >&2`,
    `echo "ares: neither 'node' on PATH nor $ARES_NODE (recorded at install time)." >&2`,
    `echo "ares: install Node 22+, then re-run 'pnpm install:cli' from your Ares checkout." >&2`,
    "exit 127",
    "",
  ].join("\n");
}

/** Whether a file's contents were produced by this installer. Both lines must
 *  match EXACTLY — see LAUNCHER_MARKER for why prefix/substring tests are unsafe. */
export function isAresLauncher(contents) {
  if (typeof contents !== "string") return false;
  const [first, second] = contents.split("\n");
  return first === LAUNCHER_SHEBANG && second === LAUNCHER_MARKER;
}

/**
 * Classify whatever currently occupies the launcher path.
 *
 * lstat, never stat: a SYMLINK must be refused whether it dangles or not. A
 * dangling one is the dangerous case — `existsSync` reports false, and a plain
 * write would then follow the link and create a file wherever it points,
 * outside the directory the user chose. We never create symlinks, so one here
 * is by definition not ours.
 */
export function inspectLauncherPath(target) {
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stats) return { kind: "absent" };
  if (stats.isSymbolicLink()) return { kind: "symlink" };
  if (!stats.isFile()) return { kind: "other" };
  const contents = fs.readFileSync(target, "utf8");
  return { kind: isAresLauncher(contents) ? "ours" : "foreign", contents, mode: stats.mode };
}

function refuseForeign(target, kind, verb) {
  const what =
    kind === "symlink"
      ? "it is a symlink, and Ares never creates one"
      : kind === "other"
        ? "it is not a regular file"
        : "it was not created by Ares";
  return new Error(
    `Refusing to ${verb} ${target}: ${what}.\n` +
      (verb === "overwrite"
        ? "Move it aside, or install elsewhere with `--dir <path>`."
        : "Nothing was removed. Delete it yourself if that is really what you want."),
  );
}

/**
 * Write `contents` to `target` atomically.
 *
 * The staging file lives inside a directory created by mkdtempSync, whose name
 * is unpredictable and which mkdtemp creates exclusively (it fails rather than
 * reuse an existing one). A predictable sibling name like `.ares.tmp-<pid>`
 * could be pre-created as a symlink by another user of a shared destination,
 * and the write would follow it. Because the staging dir is a fresh sibling of
 * the target, the final rename(2) stays on one filesystem and is atomic — an
 * interrupted install can never leave a truncated launcher on PATH.
 *
 * Only the directory this call created is ever removed, on success and on
 * failure alike.
 */
function writeFileAtomic(target, contents, mode) {
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(target), ".ares-install-"));
  try {
    const staged = path.join(stagingDir, path.basename(target));
    fs.writeFileSync(staged, contents, { mode });
    // writeFileSync's mode is subject to umask, so set it explicitly.
    fs.chmodSync(staged, mode);
    fs.renameSync(staged, target);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Install the POSIX launcher. Returns a result object instead of printing, so
 * tests can assert on the outcome; the CLI wrapper below does the printing.
 */
export function installPosixLauncher({
  binDir,
  entryPath = cliEntryPath(),
  nodePath = process.execPath,
  env = process.env,
} = {}) {
  assertSafePath(binDir, "Install directory");
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `CLI not built: ${entryPath} not found.\nRun \`pnpm build\` first, then re-run \`pnpm install:cli\`.`,
    );
  }

  const target = path.join(binDir, LAUNCHER_NAME);
  const existing = inspectLauncherPath(target);
  if (existing.kind === "symlink" || existing.kind === "other" || existing.kind === "foreign") {
    throw refuseForeign(target, existing.kind, "overwrite");
  }

  fs.mkdirSync(binDir, { recursive: true });
  const contents = renderLauncher({ nodePath, entryPath });

  // Already exactly right? Touch nothing — re-running the installer should not
  // rewrite a file (and bump its mtime) for no reason.
  if (existing.kind === "ours" && existing.contents === contents && (existing.mode & 0o111) === 0o111) {
    return { target, binDir, updated: true, unchanged: true, rewritten: false, onPath: isOnPath(binDir, env) };
  }

  writeFileAtomic(target, contents, 0o755);

  return {
    target,
    binDir,
    updated: existing.kind === "ours",
    unchanged: false,
    rewritten: true,
    onPath: isOnPath(binDir, env),
  };
}

/** True when `dir` is already one of the PATH entries. */
export function isOnPath(dir, env = process.env) {
  const raw = env.PATH ?? "";
  const target = path.resolve(dir);
  return raw
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => {
      try {
        return path.resolve(entry) === target;
      } catch {
        return false;
      }
    });
}

/**
 * Is this a help request? Checked BEFORE the platform split, and deliberately
 * NOT via parseArgs: install.ps1 has its own parameters (`-NoBuild`), and
 * running the POSIX parser over Windows argv would reject them as unknown
 * options instead of forwarding them. Only `-h`/`--help` is ours everywhere.
 */
export function isHelpRequest(argv = []) {
  return argv.includes("-h") || argv.includes("--help");
}

/** The exact PowerShell invocation used on Windows. Pure, so tests can assert
 *  that arguments are forwarded verbatim and in order without spawning
 *  anything — install.ps1 edits the real user PATH and must never run in CI. */
export function buildWindowsInvocation(argv = []) {
  const { script } = resolvePlatformPlan("win32");
  return {
    command: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...argv],
  };
}

/** Hand off to install.ps1 on Windows, preserving its exit code. Arguments go
 *  through the argv array — never concatenated into a command string. */
function runWindowsInstaller(argv) {
  const { command, args } = buildWindowsInvocation(argv);
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export const USAGE = `Usage: pnpm install:cli [-- --dir <path>]

  --dir <path>   where to put the \`ares\` launcher
  --help         show this message

Destination precedence: --dir, ARES_CLI_BIN_DIR, $XDG_BIN_HOME, $HOME/.local/bin.
Your PATH and shell config are never modified.`;

async function main(argv = process.argv.slice(2)) {
  // Help first, on every platform — forwarding --help to install.ps1 (which has
  // no such parameter) would turn a help request into a PowerShell error.
  if (isHelpRequest(argv)) {
    console.log(USAGE);
    return;
  }

  // Windows next, with argv untouched: install.ps1 owns its own flags
  // (`-NoBuild`), and validating them here would reject them.
  if (resolvePlatformPlan().mode === "windows") {
    process.exitCode = runWindowsInstaller(argv);
    return;
  }

  // POSIX only: now the POSIX option grammar applies.
  parseArgs(argv);
  const binDir = resolveBinDir({ argv });
  const result = installPosixLauncher({ binDir });

  console.log("");
  console.log("  Ares CLI installer");
  console.log(`  workspace: ${repoRoot}`);
  console.log("");
  const verb = result.unchanged ? "already installed" : result.updated ? "updated" : "installed";
  console.log(`  ${verb}: ${result.target}`);
  if (!result.onPath) {
    console.log("");
    console.log(`  NOTE: ${result.binDir} is not on your PATH.`);
    console.log("  Ares does not edit your shell config. For a POSIX shell (sh, bash, zsh), add:");
    console.log("");
    console.log(`    ${renderPathHint(result.binDir)}`);
    console.log("");
  }
  console.log("");
  console.log("  Done. Open a NEW terminal and run:  ares");
  console.log("");
}

// Only run when executed directly — uninstall-cli.mjs and the tests import the
// helpers above, and must not trigger an install by doing so.
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
