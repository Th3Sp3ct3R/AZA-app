// AgentComputer — the sandbox manager and its tool surface, exercised against
// a scripted fake wsl.exe so tests run anywhere (no WSL required).

import assert from "node:assert/strict";
import test from "node:test";

import {
  WslSandbox,
  SANDBOX_DISTRO,
  guiInputRefusal,
  makeAgentComputerTools,
  chooseDistroDir,
  formatGb,
} from "../packages/tools/dist/index.js";

/** A scripted runner: match wsl.exe argv against expectations in order. */
function scriptedRunner(script) {
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    for (const entry of script) {
      if (entry.match(args)) return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...entry.result };
    }
    return { stdout: "", stderr: `unscripted call: ${args.join(" ")}`, exitCode: 1, timedOut: false };
  };
  runner.calls = calls;
  return runner;
}

const provisionedScript = [
  { match: (a) => a[0] === "--status", result: { exitCode: 0 } },
  { match: (a) => a[0] === "--list", result: { stdout: `Ubuntu\n${SANDBOX_DISTRO}\n` } },
  { match: (a) => a.join(" ").includes("cat /etc/ares-computer-release"), result: { stdout: "version=1\nprovisionedAt=2026-08-19T00:00:00Z\n" } },
];

test("guiInputRefusal bans shell-driven GUI input and allows normal commands", () => {
  assert.match(guiInputRefusal("xdotool key Return") ?? "", /may not drive the GUI/);
  assert.match(guiInputRefusal("sudo apt install xte && xte 'key Return'") ?? "", /may not drive the GUI/);
  assert.equal(guiInputRefusal("python3 train.py --xdotoolish-name"), null);
  assert.equal(guiInputRefusal("ls -la && git status"), null);
});

test("exec runs as the sandbox user inside the distro with a cwd prefix", async () => {
  const runner = scriptedRunner([
    ...provisionedScript,
    { match: (a) => a.includes("bash"), result: { stdout: "hello\n", exitCode: 0 } },
  ]);
  const box = new WslSandbox(runner);
  const result = await box.exec("echo hello");
  assert.equal(result.stdout, "hello\n");
  const execCall = runner.calls.find((c) => c.at(-1)?.includes("echo hello"));
  assert.deepEqual(execCall.slice(0, 4), ["-d", SANDBOX_DISTRO, "-u", "ares"]);
  assert.match(execCall.at(-1), /^cd '\/home\/ares' 2>\/dev\/null; echo hello$/);
});

test("exec refuses to run before the sandbox is provisioned", async () => {
  const runner = scriptedRunner([
    { match: (a) => a[0] === "--status", result: { exitCode: 0 } },
    { match: (a) => a[0] === "--list", result: { stdout: "Ubuntu\n" } },
  ]);
  const box = new WslSandbox(runner);
  await assert.rejects(box.exec("echo hi"), /not set up yet/);
});

test("sandbox paths reject Windows paths and .. traversal; relative resolves under home", () => {
  const box = new WslSandbox(scriptedRunner(provisionedScript));
  assert.equal(box.resolveSandboxPath("notes.txt"), "/home/ares/notes.txt");
  assert.equal(box.resolveSandboxPath("/tmp/x"), "/tmp/x");
  assert.throws(() => box.resolveSandboxPath("C:\\Users\\x"), /Windows path/);
  assert.throws(() => box.resolveSandboxPath("../etc/passwd"), /'\.\.'/);
  assert.equal(box.uncPath("/home/ares/a.txt"), `\\\\wsl.localhost\\${SANDBOX_DISTRO}\\home\\ares\\a.txt`);
});

test("the display lease admits one holder and refuses a contested grab", () => {
  const box = new WslSandbox(scriptedRunner(provisionedScript));
  box.acquireLease(1, "agent", "pixel work");
  assert.equal(box.lease(1)?.holder, "agent");
  assert.throws(() => box.acquireLease(1, "owner", "grabbing"), /lease is held by agent/);
  box.releaseLease(1);
  box.acquireLease(1, "owner", "2FA");
  assert.equal(box.lease(1)?.holder, "owner");
  box.releaseLease(1);
});

test("ComputerExec tool surfaces the GUI-input doctrine as a correctable validation", async () => {
  const box = new WslSandbox(scriptedRunner(provisionedScript));
  const tools = makeAgentComputerTools({ sandbox: box });
  const exec = tools.find((t) => t.schema.name === "ComputerExec");
  const verdict = await exec.validateInput(
    { command: "xdotool click 1", description: "clicks", timeout: 1000 },
    {},
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /may not drive the GUI/);
  const fine = await exec.validateInput(
    { command: "uname -a", description: "kernel", timeout: 1000 },
    {},
  );
  assert.equal(fine.ok, true);
});

test("tool surface: safety classes match the sandbox-free / host-gated split", () => {
  const tools = makeAgentComputerTools({ sandbox: new WslSandbox(scriptedRunner(provisionedScript)) });
  const byName = new Map(tools.map((t) => [t.schema.name, t]));
  assert.deepEqual(
    [...byName.keys()].sort(),
    ["ComputerAdmin", "ComputerBrowser", "ComputerDesktop", "ComputerExec", "ComputerFile", "ComputerHandoff", "ComputerScreenshot", "ComputerTransfer"],
  );
  assert.equal(byName.get("ComputerScreenshot").schema.safety, "read-only");
  assert.equal(byName.get("ComputerExec").schema.safety, "workspace-write");
  // dynamic: reads are read-only, mutations are workspace-write
  assert.equal(byName.get("ComputerFile").effectiveSafety({ action: "read", path: "a" }), "read-only");
  assert.equal(byName.get("ComputerFile").effectiveSafety({ action: "write", path: "a", content: "x" }), "workspace-write");
  assert.equal(byName.get("ComputerBrowser").effectiveSafety({ action: "read", display: 1 }), "read-only");
  assert.equal(byName.get("ComputerBrowser").effectiveSafety({ action: "navigate", url: "https://x", display: 1 }), "workspace-write");
  // admin: status reads, rebuild/snapshot ask
  assert.equal(byName.get("ComputerAdmin").effectiveSafety({ action: "status", view_only: false }), "read-only");
  assert.equal(byName.get("ComputerAdmin").effectiveSafety({ action: "rebuild", view_only: false }), "external-state");
});

test("the computer can be pointed at any registered distro, and refuses unknown ones", async () => {
  const runner = scriptedRunner([
    { match: (a) => a[0] === "--status", result: { exitCode: 0 } },
    { match: (a) => a[0] === "--list", result: { stdout: `Ubuntu\n${SANDBOX_DISTRO}\nmy-custom-debian\n` } },
  ]);
  const box = new WslSandbox(runner);
  assert.deepEqual(await box.listDistros(), ["Ubuntu", SANDBOX_DISTRO, "my-custom-debian"]);
  await assert.rejects(box.adoptDistro("not-installed"), /has no distro named/);
  assert.equal(await box.distroName(), SANDBOX_DISTRO);
});

test("desktop input refuses while the owner holds the screen", async () => {
  const box = new WslSandbox(scriptedRunner(provisionedScript));
  box.acquireLease(1, "owner", "entering a 2FA code");
  await assert.rejects(box.desktopInput("click", { x: 10, y: 10 }), /owner is driving/);
  box.releaseLease(1);
});

test("ComputerDesktop is registered and is the only GUI-input path", () => {
  const tools = makeAgentComputerTools({ sandbox: new WslSandbox(scriptedRunner(provisionedScript)) });
  const desktop = tools.find((t) => t.schema.name === "ComputerDesktop");
  assert.ok(desktop, "the pixel driver must exist — a machine whose pointer never moves looks broken");
  assert.equal(desktop.schema.concurrency, "exclusive");
  assert.equal(desktop.schema.safety, "workspace-write");
  // exec still refuses to fake input, so this stays the single visible hand.
  assert.match(guiInputRefusal("xdotool click 1") ?? "", /may not drive the GUI/);
});

test("storage lands on a drive with room, and reports it in gigabytes", async () => {
  const chosen = await chooseDistroDir(1);
  assert.ok(chosen.dir.length > 0);
  assert.match(formatGb(3 * 1024 ** 3), /^3\.0 GB$/);
  // A 900GB requirement cannot be satisfied by a typical volume, so the
  // chooser falls back to the home directory rather than inventing a drive.
  const impossible = await chooseDistroDir(900 * 1024 ** 4);
  assert.ok(impossible.dir.length > 0);
});

test("manifest parses, tolerates a corrupt file, and validates package names", async () => {
  const runner = scriptedRunner([
    ...provisionedScript,
    { match: (a) => a.join(" ").includes(".ares-manifest.json"), result: { stdout: '{"packages":["ffmpeg","jq"]}' } },
  ]);
  const box = new WslSandbox(runner);
  assert.deepEqual(await box.manifest(), { packages: ["ffmpeg", "jq"] });
  await assert.rejects(box.manifestInstall("bad name; rm -rf /"), /not a valid Debian package name/);
});

// ── the machine's memory of itself: journal, facts, the prompt card ──────

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  machineCardPromptBlock,
  appendJournal,
  journalTail,
  updateFacts,
} from "../packages/tools/dist/index.js";

// Isolate every facts/journal write under a scratch home — these tests must
// never touch the owner's real ~/.ares/computer state.
process.env.ARES_HOME = mkdtempSync(join(tmpdir(), "ares-computer-test-"));

test("machine card: unprovisioned state pitches the computer instead of hiding it", async () => {
  // Earlier tests' status() calls may have stamped provisioned:true into the
  // scratch facts — this test is about the UNprovisioned card, so say so.
  await updateFacts({ provisioned: false });
  const card = machineCardPromptBlock();
  if (process.platform !== "win32") {
    assert.equal(card, "");
    return;
  }
  assert.match(card, /Your own computer/);
  assert.match(card, /not set up yet/);
  assert.match(card, /ComputerAdmin/);
});

test("machine card: provisioned state carries distro, deeds, and the routing rule", async (t) => {
  if (process.platform !== "win32") {
    t.skip("card is win32-only (WSL2)");
    return;
  }
  await updateFacts({ distro: "ares-computer", provisioned: true, freeSpace: "41.0 GB" });
  await appendJournal({ kind: "exec", detail: "built the mod zip", ok: true });
  const card = machineCardPromptBlock();
  assert.match(card, /ares-computer/);
  assert.match(card, /41\.0 GB/);
  assert.match(card, /built the mod zip/);
  assert.match(card, /Routing rule/);
  assert.match(card, /MACHINE\.md/);
  // failed deeds are marked, not hidden
  await appendJournal({ kind: "exec", detail: "tried the flaky build", ok: false });
  assert.match(machineCardPromptBlock(), /tried the flaky build \(failed\)/);
});

test("journal appends, tails in order, and never throws on garbage", async () => {
  await appendJournal({ kind: "browse", detail: "github.com/notifications", ok: true });
  const tail = await journalTail(2);
  assert.ok(tail.length >= 1);
  assert.equal(tail.at(-1).detail, "github.com/notifications");
  assert.ok(tail.every((e) => typeof e.t === "string" && e.t.includes("T")));
});

test("wake boots the machine and returns a report carrying MACHINE.md", async () => {
  const runner = scriptedRunner([
    ...provisionedScript,
    { match: (a) => a.at(-1)?.includes("test -S /tmp/.X11-unix/X1"), result: { exitCode: 0 } },
    {
      match: (a) => a.at(-1)?.includes("UPTIME="),
      result: { stdout: "UPTIME=3 hours\nDISK=41G\nPKGS=2\n---MACHINE---\n# MACHINE.md — this computer's own notes\nremember: chromium needs --no-sandbox\n" },
    },
    { match: (a) => a.at(-1)?.includes("convert"), result: { exitCode: 0 } },
  ]);
  const box = new WslSandbox(runner);
  // The journal mirror writes over \wsl.localhost — a REAL path. Stub it so
  // the test never touches a distro that happens to exist on the dev machine.
  box.writeFile = async () => {};
  const tools = makeAgentComputerTools({ sandbox: box });
  const admin = tools.find((t) => t.schema.name === "ComputerAdmin");
  const result = await admin.call({ action: "wake", task: "field test", view_only: false }, {});
  assert.match(result.output.report, /Awake at your computer/);
  assert.match(result.output.report, /3 hours/);
  assert.match(result.output.report, /chromium needs --no-sandbox/);
  assert.match(result.display, /field test/);
});

test("screen_off is registered and admin still gates rebuild as external-state", () => {
  const tools = makeAgentComputerTools({ sandbox: new WslSandbox(scriptedRunner(provisionedScript)) });
  const admin = tools.find((t) => t.schema.name === "ComputerAdmin");
  assert.equal(admin.effectiveSafety({ action: "wake", view_only: false }), "workspace-write");
  assert.equal(admin.effectiveSafety({ action: "screen_off", view_only: false }), "workspace-write");
  assert.equal(admin.effectiveSafety({ action: "rebuild", view_only: false }), "external-state");
});
