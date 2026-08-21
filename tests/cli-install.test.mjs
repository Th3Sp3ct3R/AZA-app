// Contract for the from-source CLI install/uninstall path (scripts/install-cli.mjs,
// scripts/uninstall-cli.mjs).
//
// Every test here works inside a mkdtemp directory and passes an explicit
// `--dir` / binDir, and every spawned process gets a temp HOME and ARES_HOME.
// Nothing in this file may write to the real $HOME, ~/.local/bin, ~/.ares, or
// /usr/local/bin — the installer's whole point is that it is confined to a user
// prefix, and a test suite that installed into the real one would be proving
// the opposite.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LAUNCHER_MARKER,
  LAUNCHER_NAME,
  LAUNCHER_SHEBANG,
  assertSafePath,
  buildWindowsInvocation,
  cliEntryPath,
  inspectLauncherPath,
  installPosixLauncher,
  isAresLauncher,
  isHelpRequest,
  isOnPath,
  parseArgs,
  renderLauncher,
  renderPathHint,
  resolveBinDir,
  resolvePlatformPlan,
  shellQuote,
} from "../scripts/install-cli.mjs";
import {
  buildWindowsInvocation as buildWindowsUninstallInvocation,
  resolvePlatformPlan as resolveUninstallPlan,
  uninstallPosixLauncher,
} from "../scripts/uninstall-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const isWindows = process.platform === "win32";

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ares-cli-install-${label}-`));
}

/** A stand-in for a built CLI so these tests never depend on `dist` freshness. */
function fakeEntry(dir) {
  const entry = path.join(dir, "entry.js");
  fs.writeFileSync(entry, "process.stdout.write('fake ares\\n');\n");
  return entry;
}

/** Environment for spawned launchers: no real user directory is reachable. */
function isolatedEnv(home) {
  return {
    ...process.env,
    HOME: home,
    ARES_HOME: path.join(home, ".ares"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    ARES_AGENT_ENABLED: "0",
  };
}

// ── destination resolution ────────────────────────────────────────────────

// Absolute-path fixtures are normalised through path.resolve on both sides so
// these assertions hold on Windows too (where "\home\x" resolves to "C:\home\x").
const HOME_FIXTURE = path.resolve(path.join(path.sep, "home", "someone"));

test("install: default Linux destination is XDG_BIN_HOME, else ~/.local/bin", () => {
  assert.equal(
    resolveBinDir({ env: { HOME: HOME_FIXTURE }, argv: [] }),
    path.join(HOME_FIXTURE, ".local", "bin"),
  );

  const xdg = path.join(HOME_FIXTURE, "bin");
  assert.equal(resolveBinDir({ env: { HOME: HOME_FIXTURE, XDG_BIN_HOME: xdg }, argv: [] }), xdg);
});

test("install: explicit override beats the env, and --dir beats ARES_CLI_BIN_DIR", () => {
  const xdg = path.join(HOME_FIXTURE, "bin");
  const fromEnv = path.resolve(path.join(path.sep, "opt", "from-env"));
  const fromFlag = path.resolve(path.join(path.sep, "opt", "from-flag"));

  // dedicated variable wins over XDG + HOME
  assert.equal(
    resolveBinDir({ env: { HOME: HOME_FIXTURE, XDG_BIN_HOME: xdg, ARES_CLI_BIN_DIR: fromEnv }, argv: [] }),
    fromEnv,
  );

  // the most explicit input of all wins
  assert.equal(
    resolveBinDir({
      env: { HOME: HOME_FIXTURE, XDG_BIN_HOME: xdg, ARES_CLI_BIN_DIR: fromEnv },
      argv: ["--dir", fromFlag],
    }),
    fromFlag,
  );
  assert.equal(resolveBinDir({ env: {}, argv: [`--dir=${fromFlag}`] }), fromFlag);
});

test("install: an unresolvable destination fails loudly instead of writing to cwd", () => {
  const cwdBefore = fs.readdirSync(process.cwd()).length;
  assert.throws(() => resolveBinDir({ env: {}, argv: [] }), /HOME is unset/);
  // no XDG_* fallback silently kicks in either
  assert.throws(
    () => resolveBinDir({ env: { XDG_CONFIG_HOME: "/tmp/x", XDG_DATA_HOME: "/tmp/y" }, argv: [] }),
    /HOME is unset/,
  );
  assert.equal(fs.readdirSync(process.cwd()).length, cwdBefore, "nothing was written to the cwd");
});

// ── argument parsing ──────────────────────────────────────────────────────

test("install: --dir parsing accepts both spellings and the `--` separator", () => {
  assert.equal(parseArgs(["--dir", "/tmp/x"]).dir, "/tmp/x");
  assert.equal(parseArgs(["--dir=/tmp/x"]).dir, "/tmp/x");
  // pnpm forwards the separator verbatim: `pnpm install:cli -- --dir X`
  assert.equal(parseArgs(["--", "--dir", "/tmp/x"]).dir, "/tmp/x");
  assert.equal(parseArgs([]).dir, undefined);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("install: an unknown option is an error, never silently ignored", () => {
  // Ignoring a typo'd flag would install to the default prefix while the user
  // believes they redirected it.
  assert.throws(() => parseArgs(["--dirr", "/tmp/x"]), /Unknown option: --dirr/);
  assert.throws(() => parseArgs(["--force"]), /Unknown option: --force/);
  assert.throws(() => parseArgs(["oops"]), /Unknown option: oops/);
  assert.throws(() => parseArgs(["--dir"]), /--dir requires a path/);
  assert.throws(() => parseArgs(["--dir", "--help"]), /--dir requires a path/);
  assert.throws(() => parseArgs(["--dir="]), /--dir requires a path/);
});

// ── platform dispatch ─────────────────────────────────────────────────────

test("install/uninstall: win32 dispatches to the existing PowerShell scripts", () => {
  // Asserted purely on the plan — no powershell.exe is spawned and no user PATH
  // is read or modified, so this runs identically on every platform.
  const install = resolvePlatformPlan("win32");
  assert.equal(install.mode, "windows");
  assert.equal(path.basename(install.script), "install.ps1");
  assert.ok(fs.existsSync(install.script), "install.ps1 must still ship for the Windows path");

  const uninstall = resolveUninstallPlan("win32");
  assert.equal(uninstall.mode, "windows");
  assert.equal(path.basename(uninstall.script), "uninstall.ps1");
  assert.ok(fs.existsSync(uninstall.script), "uninstall.ps1 must still ship for the Windows path");

  for (const platform of ["linux", "darwin", "freebsd"]) {
    assert.equal(resolvePlatformPlan(platform).mode, "posix");
    assert.equal(resolveUninstallPlan(platform).mode, "posix");
  }
});

test("dispatch: help is detected before the platform split, PowerShell flags are not", () => {
  assert.equal(isHelpRequest(["-h"]), true);
  assert.equal(isHelpRequest(["--help"]), true);
  assert.equal(isHelpRequest(["--", "--help"]), true);
  assert.equal(isHelpRequest(["--dir", "/tmp/x", "--help"]), true);

  // install.ps1 owns `-NoBuild`. Treating it as a help request — or running the
  // POSIX parser over it — would break the Windows path that worked before.
  assert.equal(isHelpRequest(["-NoBuild"]), false);
  assert.equal(isHelpRequest([]), false);
  assert.equal(isHelpRequest(["--dir", "/tmp/x"]), false);
  assert.equal(isHelpRequest(["-Help"]), false, "PowerShell-style -Help is not our flag");
});

test("dispatch: Windows arguments are forwarded verbatim and in order", () => {
  // Asserted on the constructed invocation. install.ps1 / uninstall.ps1 edit the
  // real user PATH, so they are never actually executed here.
  const script = resolvePlatformPlan("win32").script;
  const argv = ["-NoBuild", "--dir", "C:\\Program Files\\Ares bin", "-Verbose"];
  const { command, args } = buildWindowsInvocation(argv);

  assert.equal(command, "powershell");
  assert.deepEqual(args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...argv]);
  // byte-identical, same order, nothing dropped, added, reordered, or re-quoted
  assert.deepEqual(args.slice(5), argv);
  assert.equal(args.slice(5).join("\u0000"), argv.join("\u0000"));

  const uninstall = buildWindowsUninstallInvocation(["-NoBuild"]);
  assert.equal(path.basename(uninstall.args[4]), "uninstall.ps1");
  assert.deepEqual(uninstall.args.slice(5), ["-NoBuild"]);

  // an empty argv forwards nothing extra
  assert.equal(buildWindowsInvocation([]).args.length, 5);
});

test("dispatch: unknown options are still rejected on the POSIX branch", () => {
  // The relaxation above is scoped to Windows: parseArgs, which only the POSIX
  // branch calls, must keep refusing anything it does not know — including the
  // PowerShell flags that Windows forwards happily.
  assert.throws(() => parseArgs(["-NoBuild"]), /Unknown option: -NoBuild/);
  assert.throws(() => parseArgs(["-Verbose"]), /Unknown option: -Verbose/);
  assert.throws(() => parseArgs(["--dirr", "/tmp/x"]), /Unknown option: --dirr/);
});

test("package.json wires both commands through the cross-platform dispatcher", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["install:cli"], "node scripts/install-cli.mjs");
  assert.equal(pkg.scripts["uninstall:cli"], "node scripts/uninstall-cli.mjs");
});

// ── launcher contents ─────────────────────────────────────────────────────

test("install: the launcher quotes both paths independently", () => {
  const entry = "/home/a b/Ares Workspace/packages/cli/dist/entry.js";
  const node = "/home/a b/n o d e/bin/node";
  const script = renderLauncher({ nodePath: node, entryPath: entry });

  assert.match(script, /^#!\/bin\/sh\n/);
  // each path gets its own quoted assignment — neither is interpolated into
  // the other's command line
  assert.ok(script.includes(`ARES_ENTRY='${entry}'`), "entry path must be single-quoted verbatim");
  assert.ok(script.includes(`ARES_NODE='${node}'`), "node path must be single-quoted verbatim");
  assert.ok(script.includes(`exec node "$ARES_ENTRY" "$@"`), "PATH node must be preferred");
  assert.ok(script.includes(`exec "$ARES_NODE" "$ARES_ENTRY" "$@"`), "absolute node is the fallback");
  assert.ok(isAresLauncher(script));

  // the embedded-apostrophe case naive quoting gets wrong
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
  const tricky = renderLauncher({ nodePath: "/n/node", entryPath: "/a/it's/$(rm -rf x)/`id`/e.js" });
  assert.ok(tricky.includes(`ARES_ENTRY='/a/it'\\''s/$(rm -rf x)/\`id\`/e.js'`));
});

test("install: a path containing a newline is rejected outright", () => {
  // It would survive sh single-quoting, but a launcher whose body silently
  // spans extra lines is never what the user meant.
  assert.throws(() => renderLauncher({ nodePath: "/n/node", entryPath: "/a/b\nc/entry.js" }), /newline/);
  assert.throws(() => renderLauncher({ nodePath: "/n/no\nde", entryPath: "/a/entry.js" }), /newline/);
  assert.throws(() => resolveBinDir({ env: {}, argv: ["--dir", "/tmp/a\nb"] }), /newline/);
  assert.throws(() => resolveBinDir({ env: { HOME: "/home/a\rb" }, argv: [] }), /carriage return/);
  assert.throws(() => assertSafePath("x\ny", "Thing"), /Thing contains a newline/);
});

test("install: rendering is deterministic (idempotence is checkable)", () => {
  const args = { nodePath: "/usr/bin/node", entryPath: "/srv/ares/entry.js" };
  assert.equal(renderLauncher(args), renderLauncher(args));
});

test("install: ownership requires both marker lines to match exactly", () => {
  assert.ok(isAresLauncher(renderLauncher({ nodePath: "/n", entryPath: "/e" })));
  assert.equal(LAUNCHER_MARKER, "# ares-cli-launcher:v1");

  const foreign = [
    // exact marker followed by extra characters — a prefix test would claim it
    `${LAUNCHER_SHEBANG}\n${LAUNCHER_MARKER} and then some\n`,
    // marker used as a prefix of a longer tag
    `${LAUNCHER_SHEBANG}\n${LAUNCHER_MARKER}-mine\n`,
    `${LAUNCHER_SHEBANG}\n# ares-cli-launcher:v10\n`,
    // marker present, but on another line
    `${LAUNCHER_SHEBANG}\n# my own wrapper\n${LAUNCHER_MARKER}\n`,
    // different shebang
    `#!/bin/bash\n${LAUNCHER_MARKER}\n`,
    `#!/usr/bin/env sh\n${LAUNCHER_MARKER}\n`,
    // merely mentioned in a comment
    `#!/bin/bash\n# a wrapper around ${LAUNCHER_MARKER} for my own use\nexec ares "$@"\n`,
    // right shebang, wrong second line
    `${LAUNCHER_SHEBANG}\n# something else entirely\n`,
    `${LAUNCHER_SHEBANG}\n`,
    "",
  ];
  for (const contents of foreign) {
    assert.equal(isAresLauncher(contents), false, `must not claim: ${JSON.stringify(contents.slice(0, 60))}`);
  }
  assert.equal(isAresLauncher(undefined), false);

  // the human-facing text lives on line 3, so identity survives its rewording
  const lines = renderLauncher({ nodePath: "/n", entryPath: "/e" }).split("\n");
  assert.equal(lines[1], LAUNCHER_MARKER, "line 2 is identity only");
  assert.match(lines[2], /do not edit/i, "line 3 carries the human note");
});

// ── the PATH hint is a line the user will paste into a shell ───────────────

test("install: the PATH hint single-quotes the destination", () => {
  assert.equal(renderPathHint("/opt/bin"), `export PATH='/opt/bin':"$PATH"`);
  // "$PATH" stays expandable on purpose — that part is ours, not user input
  assert.ok(renderPathHint("/opt/bin").endsWith(`:"$PATH"`));
  assert.throws(() => renderPathHint("/opt/a\nb"), /newline/);
});

test("install: a hostile destination cannot inject into the PATH hint", { skip: isWindows }, () => {
  // Space, apostrophe, $(), backticks and a double quote — all in one path.
  const sandbox = tempDir("hint");
  const hostile = `${sandbox}/we ird/it's/$(touch pwned-subshell)/\`touch pwned-backtick\`/qu"ote`;
  const hint = renderPathHint(hostile);

  // Evaluated by a real /bin/sh: allowed here precisely because the thing under
  // test IS a generated shell line.
  const result = spawnSync("/bin/sh", ["-c", `PATH=/base; ${hint}; printf %s "$PATH"`], {
    encoding: "utf8",
    cwd: sandbox,
    env: { PATH: "/usr/bin:/bin" },
  });

  assert.equal(result.status, 0, `hint failed to evaluate: ${result.stderr}`);
  assert.equal(result.stdout, `${hostile}:/base`, "the hint must produce exactly dir + old PATH");
  // nothing in the path was executed
  assert.equal(fs.existsSync(path.join(sandbox, "pwned-subshell")), false, "$() must not run");
  assert.equal(fs.existsSync(path.join(sandbox, "pwned-backtick")), false, "backticks must not run");
  assert.equal(fs.readdirSync(sandbox).length, 0, "the hint must create nothing at all");

  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("install: the PATH hint is not advertised as a Fish command", () => {
  // `export PATH=...` is not valid Fish; naming Fish here would hand users a
  // line that cannot work in their shell. Only POSIX shells are claimed.
  const source = fs.readFileSync(path.join(root, "scripts", "install-cli.mjs"), "utf8");
  assert.equal(/fish/i.test(source), false, "install-cli.mjs must not mention Fish");
  assert.match(source, /POSIX shell \(sh, bash, zsh\)/);
});

// ── install / reinstall / uninstall on disk ───────────────────────────────

test("install: writes an executable launcher into a temp prefix", { skip: isWindows }, () => {
  const bin = tempDir("bin");
  const src = tempDir("src");
  const entry = fakeEntry(src);

  const result = installPosixLauncher({ binDir: bin, entryPath: entry, env: { PATH: "" } });

  assert.equal(result.target, path.join(bin, LAUNCHER_NAME));
  assert.equal(result.updated, false);
  assert.equal(result.onPath, false);
  const stat = fs.statSync(result.target);
  assert.equal(stat.mode & 0o777, 0o755, "launcher must be 0755 regardless of umask");
  assert.ok(isAresLauncher(fs.readFileSync(result.target, "utf8")));
  assert.deepEqual(fs.readdirSync(bin), [LAUNCHER_NAME], "no staging file left behind");

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("install: refuses when the CLI has not been built", { skip: isWindows }, () => {
  const bin = tempDir("nobuild");
  assert.throws(
    () => installPosixLauncher({ binDir: bin, entryPath: path.join(bin, "absent.js") }),
    /CLI not built[\s\S]*pnpm build/,
  );
  assert.equal(fs.existsSync(path.join(bin, LAUNCHER_NAME)), false);
  fs.rmSync(bin, { recursive: true, force: true });
});

test("install: creates a missing destination directory", { skip: isWindows }, () => {
  const parent = tempDir("mkdir");
  const bin = path.join(parent, "nested", "bin");
  const src = tempDir("src");

  installPosixLauncher({ binDir: bin, entryPath: fakeEntry(src), env: { PATH: "" } });
  assert.ok(fs.existsSync(path.join(bin, LAUNCHER_NAME)));

  fs.rmSync(parent, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("install: a second run does not rewrite an already-correct launcher", { skip: isWindows }, () => {
  const bin = tempDir("idem");
  const src = tempDir("src");
  const entry = fakeEntry(src);

  const first = installPosixLauncher({ binDir: bin, entryPath: entry, env: { PATH: "" } });
  const before = fs.readFileSync(first.target, "utf8");
  const mtimeBefore = fs.statSync(first.target).mtimeMs;

  const second = installPosixLauncher({ binDir: bin, entryPath: entry, env: { PATH: "" } });

  assert.equal(second.updated, true, "second run must recognise the existing launcher");
  assert.equal(second.unchanged, true, "same inputs must be detected as already installed");
  assert.equal(second.rewritten, false, "an already-correct launcher must not be rewritten");
  assert.equal(fs.readFileSync(second.target, "utf8"), before);
  assert.equal(fs.statSync(second.target).mtimeMs, mtimeBefore, "mtime must be untouched");
  assert.deepEqual(fs.readdirSync(bin), [LAUNCHER_NAME], "no duplicate, no staging file");

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("install: repairs a launcher that lost its executable bit", { skip: isWindows }, () => {
  const bin = tempDir("chmod");
  const src = tempDir("src");
  const entry = fakeEntry(src);

  const { target } = installPosixLauncher({ binDir: bin, entryPath: entry, env: { PATH: "" } });
  fs.chmodSync(target, 0o644);

  const again = installPosixLauncher({ binDir: bin, entryPath: entry, env: { PATH: "" } });
  assert.equal(again.rewritten, true, "a non-executable launcher must be repaired");
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("install: refuses to overwrite a foreign regular file", { skip: isWindows }, () => {
  const bin = tempDir("foreign-install");
  const src = tempDir("src");
  const target = path.join(bin, LAUNCHER_NAME);
  const foreign = "#!/bin/sh\necho someone else's ares\n";
  fs.writeFileSync(target, foreign);

  assert.throws(
    () => installPosixLauncher({ binDir: bin, entryPath: fakeEntry(src) }),
    /not created by Ares/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), foreign);

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("install: refuses a symlink at the launcher path, live or dangling", { skip: isWindows }, () => {
  const bin = tempDir("symlink-install");
  const src = tempDir("src");
  const victimDir = tempDir("victim");
  const target = path.join(bin, LAUNCHER_NAME);

  // 1. dangling symlink — the dangerous case: existsSync() reports false, so a
  //    naive write would follow the link and create a file outside the prefix.
  const outside = path.join(victimDir, "outside.txt");
  fs.symlinkSync(outside, target);
  assert.throws(() => installPosixLauncher({ binDir: bin, entryPath: fakeEntry(src) }), /symlink/);
  assert.equal(fs.existsSync(outside), false, "nothing may be created through the dangling link");
  assert.ok(fs.lstatSync(target).isSymbolicLink(), "the link itself must survive");

  // 2. live symlink pointing at a real file
  fs.rmSync(target);
  fs.writeFileSync(outside, "precious\n");
  fs.symlinkSync(outside, target);
  assert.throws(() => installPosixLauncher({ binDir: bin, entryPath: fakeEntry(src) }), /symlink/);
  assert.equal(fs.readFileSync(outside, "utf8"), "precious\n", "the link target must be untouched");

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(victimDir, { recursive: true, force: true });
});

test("install: refuses a non-regular file (a directory) at the launcher path", { skip: isWindows }, () => {
  const bin = tempDir("dir-install");
  const src = tempDir("src");
  fs.mkdirSync(path.join(bin, LAUNCHER_NAME));

  assert.throws(
    () => installPosixLauncher({ binDir: bin, entryPath: fakeEntry(src) }),
    /not a regular file/,
  );

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("uninstall: removes only the Ares launcher and is idempotent", { skip: isWindows }, () => {
  const bin = tempDir("uninstall");
  const src = tempDir("src");
  const neighbour = path.join(bin, "unrelated-tool");
  fs.writeFileSync(neighbour, "#!/bin/sh\necho keep me\n");

  const installed = installPosixLauncher({ binDir: bin, entryPath: fakeEntry(src), env: { PATH: "" } });

  const first = uninstallPosixLauncher({ binDir: bin });
  assert.equal(first.removed, true);
  assert.equal(fs.existsSync(installed.target), false);
  assert.ok(fs.existsSync(neighbour), "a neighbouring tool must survive");

  // second run: a no-op, not an error
  const second = uninstallPosixLauncher({ binDir: bin });
  assert.equal(second.removed, false);
  assert.equal(second.reason, "absent");
  assert.ok(fs.existsSync(bin), "the shared prefix itself is never removed");

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("uninstall: refuses to delete a foreign file at the launcher path", { skip: isWindows }, () => {
  const bin = tempDir("foreign-uninstall");
  const target = path.join(bin, LAUNCHER_NAME);
  const contents = "#!/bin/sh\necho not ours\n";
  fs.writeFileSync(target, contents);

  assert.throws(() => uninstallPosixLauncher({ binDir: bin }), /not created by Ares/);
  assert.equal(fs.readFileSync(target, "utf8"), contents, "the foreign file must be untouched");

  fs.rmSync(bin, { recursive: true, force: true });
});

test("uninstall: never follows or removes a symlink", { skip: isWindows }, () => {
  const bin = tempDir("symlink-uninstall");
  const victimDir = tempDir("victim-uninstall");
  const target = path.join(bin, LAUNCHER_NAME);

  // Worst case: the link points at a REAL Ares launcher elsewhere, so a
  // content check alone would report "ours". Ares never creates a symlink for
  // this launcher, so one here cannot be claimed — it is left alone.
  const elsewhere = path.join(victimDir, "ares");
  installPosixLauncher({ binDir: victimDir, entryPath: fakeEntry(victimDir), env: { PATH: "" } });
  fs.symlinkSync(elsewhere, target);

  assert.throws(() => uninstallPosixLauncher({ binDir: bin }), /symlink/);
  assert.ok(fs.existsSync(elsewhere), "the link target must survive");
  assert.ok(fs.lstatSync(target).isSymbolicLink(), "the link itself must survive");
  assert.equal(inspectLauncherPath(target).kind, "symlink");

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(victimDir, { recursive: true, force: true });
});

test("uninstall: leaves an Ares data directory completely alone", { skip: isWindows }, () => {
  const bin = tempDir("data-bin");
  const src = tempDir("src");
  // A stand-in for ~/.ares: config, encrypted vault, sessions, memory.
  const aresHome = tempDir("data-home");
  const files = {
    "config.json": '{"provider":"mock"}',
    ".keysecret": "not-a-real-secret",
    "memory.md": "# memory\n",
  };
  fs.mkdirSync(path.join(aresHome, "sessions"), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(aresHome, name), body);
  fs.writeFileSync(path.join(aresHome, "sessions", "s1.jsonl"), "{}\n");

  installPosixLauncher({ binDir: bin, entryPath: fakeEntry(src), env: { PATH: "" } });
  uninstallPosixLauncher({ binDir: bin });

  for (const [name, body] of Object.entries(files)) {
    assert.equal(fs.readFileSync(path.join(aresHome, name), "utf8"), body, `${name} must survive uninstall`);
  }
  assert.ok(fs.existsSync(path.join(aresHome, "sessions", "s1.jsonl")), "sessions must survive uninstall");

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(aresHome, { recursive: true, force: true });
});

// ── PATH warning ──────────────────────────────────────────────────────────

test("install: reports whether the destination is on PATH (without editing it)", () => {
  const dir = path.resolve(path.join(path.sep, "opt", "ares", "bin"));
  const other = path.resolve(path.join(path.sep, "usr", "bin"));

  assert.equal(isOnPath(dir, { PATH: [other, dir].join(path.delimiter) }), true);
  assert.equal(isOnPath(dir, { PATH: other }), false);
  assert.equal(isOnPath(dir, { PATH: "" }), false);
  assert.equal(isOnPath(dir, {}), false);
  // trailing-separator entries must not read as a miss
  assert.equal(isOnPath(dir, { PATH: [`${dir}${path.sep}`, other].join(path.delimiter) }), true);
});

// ── end-to-end: the installed launcher really runs the real CLI ───────────

test("install: the installed launcher runs `ares help` against the built CLI", { skip: isWindows }, (t) => {
  const entry = cliEntryPath(root);
  if (!fs.existsSync(entry)) {
    t.skip("CLI not built (run `pnpm build`) — end-to-end launcher check skipped");
    return;
  }

  const bin = tempDir("e2e");
  const home = tempDir("e2e-home");
  const { target } = installPosixLauncher({ binDir: bin, entryPath: entry, env: { PATH: "" } });

  const result = spawnSync(target, ["help"], { encoding: "utf8", env: isolatedEnv(home) });

  assert.equal(result.status, 0, `launcher failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /ares v\d+\.\d+\.\d+/);

  uninstallPosixLauncher({ binDir: bin });
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("install: a launcher under a path with spaces and an apostrophe still runs", { skip: isWindows }, (t) => {
  const entry = cliEntryPath(root);
  if (!fs.existsSync(entry)) {
    t.skip("CLI not built (run `pnpm build`) — spaced-path launcher check skipped");
    return;
  }

  const parent = tempDir("spaces");
  // The apostrophe is the case naive single-quoting breaks on.
  const bin = path.join(parent, "Ares Workspace", "tim's user bin");
  const home = tempDir("spaces-home");
  const { target } = installPosixLauncher({ binDir: bin, entryPath: entry, env: { PATH: "" } });

  const result = spawnSync(target, ["help"], { encoding: "utf8", env: isolatedEnv(home) });

  assert.equal(result.status, 0, `spaced-path launcher failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /ares v\d+\.\d+\.\d+/);

  fs.rmSync(parent, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// ── --help is handled before any platform dispatch ────────────────────────

for (const script of ["install-cli.mjs", "uninstall-cli.mjs"]) {
  test(`${script}: --help exits 0 and never reaches PowerShell`, () => {
    // Runs on Linux AND Windows in CI. On Windows this proves --help is parsed
    // before the handoff: install.ps1 has no such parameter, so a delegated
    // run would fail instead of printing usage.
    const home = tempDir("help-home");
    const prefix = tempDir("help-prefix");

    const result = spawnSync(process.execPath, [path.join(root, "scripts", script), "--help"], {
      encoding: "utf8",
      env: { ...isolatedEnv(home), ARES_CLI_BIN_DIR: prefix },
      windowsHide: true,
    });

    assert.equal(result.status, 0, `--help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /^Usage: pnpm (un)?install:cli/m);
    assert.match(result.stdout, /--dir <path>/);
    assert.match(result.stdout, /--help/);
    assert.equal(result.stderr, "", "help must not write to stderr");
    // no PowerShell error leaked through, and nothing was installed
    assert.equal(/ParameterBindingException|powershell|\.ps1/i.test(result.stdout + result.stderr), false);
    assert.deepEqual(fs.readdirSync(prefix), [], "no launcher may be created by --help");

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(prefix, { recursive: true, force: true });
  });
}

// ── staging is unpredictable and symlink-proof ────────────────────────────

test("install: staging is not a predictable sibling name", { skip: isWindows }, () => {
  const bin = tempDir("staging");
  const src = tempDir("src");
  const victimDir = tempDir("staging-victim");

  // The old scheme was `.ares.tmp-<pid>` — pre-creatable as a symlink by
  // anyone else who can write to a shared destination.
  const guessable = path.join(bin, `.${LAUNCHER_NAME}.tmp-${process.pid}`);
  const victim = path.join(victimDir, "victim.txt");
  fs.writeFileSync(victim, "precious\n");
  fs.symlinkSync(victim, guessable);

  const { target } = installPosixLauncher({ binDir: bin, entryPath: fakeEntry(src), env: { PATH: "" } });

  assert.equal(fs.readFileSync(victim, "utf8"), "precious\n", "no write may follow the planted symlink");
  assert.ok(isAresLauncher(fs.readFileSync(target, "utf8")));
  assert.ok(fs.lstatSync(guessable).isSymbolicLink(), "the planted link is not ours to remove");

  // Only the launcher and the pre-existing (foreign) link remain: the staging
  // directory this call created was cleaned up.
  assert.deepEqual(
    fs.readdirSync(bin).sort(),
    [`.${LAUNCHER_NAME}.tmp-${process.pid}`, LAUNCHER_NAME].sort(),
    "no staging directory may survive a successful install",
  );

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(victimDir, { recursive: true, force: true });
});

test("install: a failed write leaves no staging directory behind", { skip: isWindows }, () => {
  const bin = tempDir("staging-fail");
  const src = tempDir("src");
  const entry = fakeEntry(src);

  // Read-only destination: mkdtemp inside it fails, so the install throws.
  fs.chmodSync(bin, 0o500);
  assert.throws(() => installPosixLauncher({ binDir: bin, entryPath: entry, env: { PATH: "" } }));
  fs.chmodSync(bin, 0o700);
  assert.deepEqual(fs.readdirSync(bin), [], "a failed install must leave nothing behind");

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("install: with no Node anywhere, the launcher explains itself", { skip: isWindows }, () => {
  const bin = tempDir("nonode");
  const src = tempDir("src");
  const { target } = installPosixLauncher({
    binDir: bin,
    entryPath: fakeEntry(src),
    // an interpreter path that will not exist by the time the launcher runs
    nodePath: path.join(src, "vanished", "node"),
    env: { PATH: "" },
  });

  // PATH emptied so `command -v node` also misses: both strategies fail.
  const result = spawnSync(target, ["help"], { encoding: "utf8", env: { PATH: "" } });

  assert.equal(result.status, 127, "a missing interpreter must exit 127");
  assert.match(result.stderr, /no usable Node found/);
  assert.match(result.stderr, /install Node 22\+/);

  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});
