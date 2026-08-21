// AgentComputer — the agent's own computer: a sandboxed Debian under WSL2.
//
// Design: docs/AGENT-COMPUTER-DESIGN.md. The chat stays the control plane and
// this machine is a tool TARGET — the model never becomes the computer, it
// calls it. Host tools and these tools are both live in every session; the
// target is named by which tool is called (no session flag).
//
// The sandbox is where autonomy runs free: exec/files/browser inside it are
// workspace-write class (auto-allowed under the owner's normal posture), while
// anything crossing to the HOST (ComputerTransfer) walks the same path
// permission gates as every host file tool. Doctrine carried in code:
//   - exec may not drive the GUI (no xdotool/xte from the shell) — input
//     belongs to a display driver holding the lease, or to the owner.
//   - browser work is page-level CDP against the Chrome that OWNS the display
//     (never a second browser), so it runs mouse-free beside other work.
//   - 2FA/CAPTCHA/payments are a stop-and-hand-back: ComputerHandoff pauses,
//     the owner drives the screen, then hands it back.
//   - the OS is disposable; /home (files + browser logins) is the only
//     durable surface. Rebuild = fresh rootfs + same home + manifest replay.

import { spawn } from "node:child_process";
import { promises as fs, createWriteStream, statSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { PermissionDecision, SafetyClass } from "@ares/protocol";
import {
  buildTool,
  resolveWorkspacePath,
  toolError,
  type RichToolContext,
  type Tool,
  type ToolResult,
} from "./_shared.js";
import { CdpClient } from "./cdpRender.js";

export const SANDBOX_DISTRO = "ares-computer";
const SANDBOX_USER = "ares";
const SANDBOX_HOME = `/home/${SANDBOX_USER}`;
/** display N ⇒ CDP 9620+N, VNC 5900+N, noVNC 6080+N. Distinct from the host
 *  browser's 9222 convention so sandbox Chrome never collides with it. */
const CDP_PORT_BASE = 9620;
const VNC_PORT_BASE = 5900;
const NOVNC_PORT_BASE = 6080;
const DEFAULT_DISPLAY = 1;
const SCREEN_GEOMETRY = "1280x800x24";
const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
const EXEC_MAX_TIMEOUT_MS = 900_000;
const OUTPUT_CAP_CHARS = 60_000;
const MANIFEST_PATH = `${SANDBOX_HOME}/.ares-manifest.json`;
const RELEASE_MARKER = "/etc/ares-computer-release";
const PROVISION_VERSION = 2;
/** How many journal lines the machine keeps (host-side, mirrored into the box
 *  on wake). Small on purpose: this is a memory of DEEDS, not a debug log. */
const JOURNAL_KEEP = 400;
const JOURNAL_PRUNE_AT = 600;

/** The Debian rootfs comes from Docker Hub's official `library/debian` image:
 *  token → manifest list → amd64 manifest → the single gzip layer, which IS a
 *  root filesystem tar.gz that `wsl --import` eats directly. Overridable for
 *  mirrors/airgap via ARES_COMPUTER_ROOTFS_URL or a pre-placed local tar. */
const DOCKERHUB_DEBIAN_TAGS = ["trixie-slim", "bookworm-slim", "stable-slim"];

/** Everything the sandbox needs for exec + browser + screenshot + the watchable
 *  screen. x11-apps carries xwd (root-display capture); imagemagick converts;
 *  novnc+websockify serve the Phase-2 pane with zero frontend bundling. */
const BASE_PACKAGES = [
  "sudo", "curl", "ca-certificates", "git", "python3", "unzip", "procps", "psmisc",
  "xvfb", "x11-apps", "imagemagick", "x11vnc", "novnc", "websockify",
  "chromium", "fonts-liberation", "fonts-noto-color-emoji",
  // A REAL desktop, not just a viewport. Without a window manager and a panel
  // the screen is a bare X root: close the one app and the owner sees black.
  // XFCE gives wallpaper, taskbar, file manager, and a terminal — the machine
  // reads as a computer someone could sit down at.
  "xfce4-session", "xfwm4", "xfdesktop4", "xfce4-panel", "xfce4-appfinder",
  "thunar", "xfce4-terminal", "mousepad", "xfconf", "dbus-x11",
  // Looks matter here: this screen is a product surface the owner watches.
  // Stock XFCE over VNC reads as a 2009 lab machine; a dark theme, real
  // icons, and a hinted font make it read as Ares's computer.
  "greybird-gtk-theme", "papirus-icon-theme", "fonts-dejavu-core", "fonts-hack",
  // The visible hand. Without a pixel driver the owner watches the screen and
  // sees results appear with no pointer ever moving — work that looks like it
  // happened by magic reads as work that might not have happened at all.
  "xdotool",
  // A REAL Debian, not a container that happens to boot. systemd makes the
  // machine behave the way every model's Linux knowledge assumes: systemctl
  // answers, journalctl exists, timers can schedule work. Without it the
  // agent hand-rolls setsid daemons and its generic Debian knowledge is
  // quietly false on its own computer. (wsl.conf flips systemd=true only
  // AFTER these packages land — a boot flag pointing at a missing init would
  // brick the distro.)
  "systemd", "systemd-sysv", "libpam-systemd", "dbus",
  // Locale, or every apt/perl run spews "setting locale failed" warnings that
  // eat context and read as breakage.
  "locales",
  // The resident toolkit a person would expect on their own machine. Small,
  // boring, and the difference between "a rootfs" and "my computer".
  "htop", "nano", "less", "jq", "ripgrep", "wget", "openssh-client", "file", "zip",
];

/** Seeded at provision as the machine's OWN memory file — the agent reads it
 *  on wake and extends it as it learns the box. Never overwritten once
 *  present: the whole point is that its contents accrue. */
const MACHINE_MD_SEED = `# MACHINE.md — this computer's own notes

This is YOUR computer (Debian under WSL2). You maintain this file: when you
learn something about this machine the hard way, write it down here so you
never pay for the same discovery twice. The OS is disposable; this home
directory — including this file — survives every rebuild.

## Layout
- ~/work            — projects live here
- ~/.local/bin      — your own scripts (on PATH). When you work out a useful
                      procedure, save it here as a script and note it below.
- ~/.ares/journal.jsonl — synced copy of your action journal (grep it to
                      recall how you did something last time)
- ~/.ares-manifest.json — apt packages replayed on OS rebuild (use
                      ComputerAdmin manifest_install, not bare apt, for
                      anything you want to keep)

## Known facts about this box
- Chromium requires --no-sandbox here (WSL is the sandbox; its own cannot init).
- No GPU behind Xvfb: software GL only. Heavy WebGL pages will be slow.
- The screen is 1280x800. The desktop is XFCE; the panel, Thunar and a
  terminal are real and usable.
- systemd is live: systemctl / journalctl / systemd timers all work.
- git identity: set user.email before pushing to GitHub (use the account's
  noreply address — GitHub rejects pushes exposing a private email).

## Procedures I have saved
(none yet — add entries as ~/.local/bin grows)
`;

/** Terminal UIs (opencode, lazygit, starship…) draw with Nerd Font glyphs that
 *  no Debian package ships; without them the screen is full of tofu boxes.
 *  Best-effort at provision time — a failed download never blocks setup. */
const NERD_FONT_URL =
  "https://github.com/ryanoasis/nerd-fonts/releases/latest/download/NerdFontsSymbolsOnly.zip";

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Injectable process runner so unit tests never touch a real wsl.exe. */
export type WslRunner = (
  args: readonly string[],
  opts?: { timeoutMs?: number; maxOutputChars?: number },
) => Promise<SandboxExecResult>;

export interface SandboxStatus {
  wslAvailable: boolean;
  distroRegistered: boolean;
  provisioned: boolean;
  provisionVersion?: number;
  distroDir?: string;
  /** Set when WSL exists but distros cannot START — e.g. the Windows
   *  "Virtual Machine Platform" feature is off or BIOS virtualization is
   *  disabled. Fix: `wsl.exe --install --no-distribution` (elevated) + reboot. */
  blocked?: "vm-platform";
  displays: Array<{ display: number; lease: DisplayLease | null; cdpPort: number; novncPort: number }>;
}

/** Does this wsl.exe stderr/stdout describe the disabled-VM-platform state? */
export function vmPlatformBlocked(output: string): boolean {
  return /Virtual Machine Platform|HCS_E_HYPERV_NOT_INSTALLED|enablevirtualization/i.test(output);
}

export interface DisplayLease {
  holder: "owner" | "agent";
  reason: string;
  since: string;
}

export interface SandboxConfig {
  distroDir: string;
  rootfsTar?: string;
  provisionedAt?: string;
  provisionVersion?: number;
  /** WSL distro name. Defaults to `ares-computer`; set to any registered
   *  distro to adopt a machine the owner already built. */
  distro?: string;
  /** True when the distro was adopted rather than imported by us — rebuild
   *  then means "reprovision", never "unregister and replace". */
  adopted?: boolean;
  /** Where the rootfs came from, for provenance in status output. */
  rootfsSource?: string;
}

/** A drive that could hold the machine, newest disk-space reading. */
export interface DriveSpace {
  drive: string;
  freeBytes: number;
}

function aresHome(): string {
  return process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}

function configPath(): string {
  return path.join(aresHome(), "computer", "config.json");
}

/** Free space on the volume holding `target`, or null when unknowable. */
export async function driveFreeBytes(target: string): Promise<number | null> {
  try {
    const stats = await (fs as unknown as {
      statfs: (p: string) => Promise<{ bsize: number; bavail: number }>;
    }).statfs(target);
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

/**
 * Where the machine should live. The old default — always under ARES_HOME —
 * silently targeted C:, and on a box whose system drive is nearly full that
 * turns "set up your computer" into a disk-space emergency (observed: the
 * agent spent 8 minutes recursively sizing C:\ before it could even start).
 * Pick the roomiest fixed drive instead, preferring the home drive when it
 * has space, and never pretending a full disk is fine.
 */
export async function chooseDistroDir(minBytes = 12 * 1024 ** 3): Promise<{ dir: string; drives: DriveSpace[] }> {
  const explicit = process.env.ARES_COMPUTER_DIR;
  const homeDir = path.join(aresHome(), "computer", "distro");
  if (explicit) return { dir: explicit, drives: [] };
  if (process.platform !== "win32") return { dir: homeDir, drives: [] };

  const drives: DriveSpace[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    const free = await driveFreeBytes(root);
    if (free !== null) drives.push({ drive: letter, freeBytes: free });
  }
  const homeLetter = path.parse(path.resolve(homeDir)).root.slice(0, 1).toUpperCase();
  const home = drives.find((d) => d.drive === homeLetter);
  if (home && home.freeBytes >= minBytes) return { dir: homeDir, drives };
  const roomiest = [...drives].sort((a, b) => b.freeBytes - a.freeBytes)[0];
  if (roomiest && roomiest.freeBytes >= minBytes && roomiest.drive !== homeLetter) {
    return { dir: path.join(`${roomiest.drive}:\\`, "Ares-Computer", "distro"), drives };
  }
  return { dir: homeDir, drives };
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function loadConfig(): Promise<SandboxConfig | null> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as SandboxConfig;
    return typeof parsed.distroDir === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function saveConfig(config: SandboxConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ── the machine's memory of itself: journal + facts + the prompt card ────
//
// The gap that made the computer under-used was not capability — it was that
// the model had no standing awareness it OWNED a machine. These three pieces
// close it: a journal of deeds (host-side, mirrored into the box on wake), a
// facts snapshot refreshed opportunistically by every status/tool call, and a
// synchronous prompt card composed from both so every system prompt says
// "here is your computer, here is what you last did on it".

function journalPath(): string {
  return path.join(aresHome(), "computer", "journal.jsonl");
}

function factsPath(): string {
  return path.join(aresHome(), "computer", "facts.json");
}

export interface JournalEntry {
  t: string;
  kind: string;
  detail: string;
  ok?: boolean;
}

/** Opportunistically-learned machine facts, for the prompt card. Every field
 *  optional: the card renders whatever is known and omits the rest. */
export interface MachineFacts {
  distro?: string;
  provisioned?: boolean;
  provisionVersion?: number;
  blocked?: string;
  freeSpace?: string;
  uptime?: string;
  packages?: number;
  lastUrl?: string;
  lastTitle?: string;
  lastWake?: string;
  screenUrl?: string;
  updatedAt?: string;
}

/** Fire-and-forget journal append with occasional pruning. Never throws, never
 *  awaited by callers — a failed diary line must not fail the deed. */
export async function appendJournal(entry: Omit<JournalEntry, "t">): Promise<void> {
  try {
    const file = journalPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
    await fs.appendFile(file, line + "\n", "utf8");
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length > JOURNAL_PRUNE_AT) {
      await fs.writeFile(file, lines.slice(-JOURNAL_KEEP).join("\n") + "\n", "utf8");
    }
  } catch { /* the journal is memory, not a transaction log */ }
}

export async function journalTail(count = 3): Promise<JournalEntry[]> {
  try {
    const raw = await fs.readFile(journalPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0).slice(-count);
    return lines.map((l) => JSON.parse(l) as JournalEntry);
  } catch {
    return [];
  }
}

export async function updateFacts(patch: Partial<MachineFacts>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(factsPath()), { recursive: true });
    let current: MachineFacts = {};
    try {
      current = JSON.parse(await fs.readFile(factsPath(), "utf8")) as MachineFacts;
    } catch { /* first write */ }
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await fs.writeFile(factsPath(), JSON.stringify(merged, null, 2) + "\n", "utf8");
  } catch { /* facts are advisory */ }
}

/** mtime-cached snapshot for the SYNCHRONOUS prompt path (same pattern as
 *  cachedUiSettings): prompt composition may never await disk. */
let cardCache: { stamp: string; value: string } | null = null;

/**
 * The machine card: a standing block for the system prompt. This is what makes
 * the computer a PLACE the agent knows it has, instead of eight tool names it
 * might remember. Three states:
 *  - no WSL/no config yet  → one line saying its computer can be set up;
 *  - registered, provisioned → the full card (distro, disk, last deeds, rules);
 *  - anything in between → the shortest true statement plus the fix.
 */
export function machineCardPromptBlock(): string {
  if (process.platform !== "win32") return "";
  let factsRaw = "";
  let journalRaw = "";
  let factsStamp = 0;
  let journalStamp = 0;
  try {
    factsStamp = statSyncMs(factsPath());
    factsRaw = readFileSyncSafe(factsPath());
  } catch { /* absent is a valid state */ }
  try {
    journalStamp = statSyncMs(journalPath());
    journalRaw = readFileSyncSafe(journalPath());
  } catch { /* absent is a valid state */ }
  // Content length rides along with mtime: two writes inside one mtime tick
  // (fast successive tool calls) must still invalidate the card.
  const stamp = `${factsStamp}:${journalStamp}:${factsRaw.length}:${journalRaw.length}`;
  if (cardCache?.stamp === stamp) return cardCache.value;

  let facts: MachineFacts = {};
  try { facts = JSON.parse(factsRaw) as MachineFacts; } catch { /* unreadable = unknown */ }
  let value: string;
  if (!facts.provisioned) {
    value = `## Your own computer

You can have a computer of your own — a sandboxed Debian Linux with a desktop, browser, and persistent home, separate from the owner's machine. It is not set up yet${facts.blocked ? ` (blocked: ${facts.blocked})` : ""}. One call provisions it: ComputerAdmin action "setup" (a few minutes, ~2 GB). Offer it when a task wants installs, downloads, logins, or room to make mistakes.

`;
  } else {
    const lines: JournalEntry[] = journalRaw
      .split("\n")
      .filter((l) => l.length > 0)
      .slice(-3)
      .map((l) => { try { return JSON.parse(l) as JournalEntry; } catch { return null; } })
      .filter((e): e is JournalEntry => e !== null);
    const deeds = lines.length > 0
      ? lines.map((e) => `- ${e.t.slice(0, 16).replace("T", " ")} ${e.kind}: ${e.detail}${e.ok === false ? " (failed)" : ""}`).join("\n")
      : "- (nothing yet — this machine is fresh)";
    const versionNote = facts.provisionVersion !== undefined && facts.provisionVersion < PROVISION_VERSION
      ? `\nOS image is v${facts.provisionVersion} (current is v${PROVISION_VERSION}) — ComputerAdmin "setup" upgrades in place.`
      : "";
    value = `## Your own computer — \`${facts.distro ?? SANDBOX_DISTRO}\`

A real Debian machine that is YOURS: XFCE desktop on display :1 (1280x800), Chromium with persistent logins, systemd, a home directory that survives OS rebuilds.${facts.freeSpace ? ` Disk: ${facts.freeSpace} free.` : ""}${facts.uptime ? ` Up ${facts.uptime}.` : ""}${facts.lastUrl ? `\nBrowser was last at: ${facts.lastTitle ? `${facts.lastTitle} — ` : ""}${facts.lastUrl}` : ""}${facts.screenUrl ? `\nWatchable screen: ${facts.screenUrl}` : ""}
Your memory there: ~/MACHINE.md (read it on wake; extend it when you learn the box), ~/.local/bin (your saved scripts, on PATH), ~/.ares/journal.jsonl (what you did before).
Recent deeds:
${deeds}${versionNote}

**Routing rule:** work that installs software, downloads files, scrapes, runs untrusted code, or needs a browser login belongs on YOUR computer (Computer* tools) — not the owner's machine. The owner's machine is for their repos and their apps. Start a session of real work there with ComputerAdmin "wake" (boots it, stamps the current task on the wallpaper, returns a status report). When the owner is watching your screen, prefer ComputerDesktop for GUI work — your hand should be visible; CDP (ComputerBrowser) is for headless speed. 2FA/CAPTCHA/payments: ComputerHandoff, always.

`;
  }
  cardCache = { stamp, value };
  return value;
}

// Sync fs shims for the prompt path only (composition may never await disk).
function statSyncMs(file: string): number {
  return statSync(file).mtimeMs;
}
function readFileSyncSafe(file: string): string {
  return readFileSync(file, "utf8");
}

const defaultRunner: WslRunner = (args, opts = {}) =>
  new Promise((resolve) => {
    const timeoutMs = Math.min(opts.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS);
    const cap = opts.maxOutputChars ?? OUTPUT_CAP_CHARS;
    // WSL_UTF8=1 makes wsl.exe's own output UTF-8 instead of UTF-16, so
    // management commands (--list, --status) and Linux output decode alike.
    const child = spawn("wsl.exe", args as string[], {
      env: { ...process.env, WSL_UTF8: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already dead */ }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${error.message}`.trim(), exitCode: 127, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, cap),
        stderr: stderr.slice(0, cap),
        exitCode: code ?? 1,
        timedOut,
      });
    });
  });

/** GUI input from the shell is banned by doctrine: input belongs to a display
 *  driver holding the lease, or to the owner via the screen. Returns the
 *  refusal message, or null when the command is fine. */
export function guiInputRefusal(command: string): string | null {
  if (/\b(xdotool|xte|ydotool|wtype|xvkbd)\b/i.test(command)) {
    return (
      "Refused: shell commands may not drive the GUI (xdotool/xte/…). Input belongs to a " +
      "display driver holding the screen lease, or to the owner. Use ComputerBrowser for " +
      "page-level browser control (it runs mouse-free), or ComputerHandoff to let the owner drive."
    );
  }
  return null;
}

/** One shared sandbox per owner. Garrison/Telegram tenants must NOT share this
 *  (cookie store = the owner's logins); hosts wire tenant isolation upstream. */
export class WslSandbox {
  private readonly run: WslRunner;
  private readonly leases = new Map<number, DisplayLease>();
  private provisionChecked = false;
  private setupInFlight: Promise<string> | null = null;
  /** Which WSL distro is "the computer". Owner-swappable: any registered
   *  distro can be adopted, so a custom Debian/Ubuntu build works as-is. */
  private distro = process.env.ARES_COMPUTER_DISTRO ?? SANDBOX_DISTRO;
  private distroResolved = false;

  constructor(runner: WslRunner = defaultRunner) {
    this.run = runner;
  }

  /** Adopt whatever distro the stored config names before any call uses it. */
  private async resolveDistro(): Promise<void> {
    if (this.distroResolved) return;
    this.distroResolved = true;
    if (process.env.ARES_COMPUTER_DISTRO) return; // env wins
    const config = await loadConfig();
    if (config?.distro) this.distro = config.distro;
  }

  /** The distro currently acting as the computer. */
  async distroName(): Promise<string> {
    await this.resolveDistro();
    return this.distro;
  }

  // ── status & provisioning ─────────────────────────────────────────────

  async wslAvailable(): Promise<boolean> {
    const result = await this.run(["--status"], { timeoutMs: 15_000 });
    return result.exitCode === 0;
  }

  /** Every distro registered with WSL, for "switch the computer to this one". */
  async listDistros(): Promise<string[]> {
    const result = await this.run(["--list", "--quiet"], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /** Point the computer at an already-installed distro (the owner's own
   *  Debian/Ubuntu/custom build). Provisioning then adds only what is
   *  missing; rebuild will reprovision instead of replacing their OS. */
  async adoptDistro(name: string): Promise<string> {
    const available = await this.listDistros();
    if (!available.includes(name)) {
      throw new Error(`WSL has no distro named "${name}". Registered: ${available.join(", ") || "(none)"}`);
    }
    const existing = (await loadConfig()) ?? { distroDir: "" };
    await saveConfig({ ...existing, distro: name, adopted: true, provisionVersion: undefined });
    this.distro = name;
    this.distroResolved = true;
    this.provisionChecked = false;
    return `The agent computer now points at "${name}". Run setup to add anything it is missing (user, desktop, browser, screen).`;
  }

  async distroRegistered(): Promise<boolean> {
    await this.resolveDistro();
    const result = await this.run(["--list", "--quiet"], { timeoutMs: 15_000 });
    return result.exitCode === 0 &&
      result.stdout.split(/\r?\n/).map((line) => line.trim()).includes(this.distro);
  }

  async status(): Promise<SandboxStatus> {
    const wslAvailable = await this.wslAvailable();
    const distroRegistered = wslAvailable && (await this.distroRegistered());
    let provisioned = false;
    let provisionVersion: number | undefined;
    let blocked: "vm-platform" | undefined;
    if (distroRegistered) {
      const marker = await this.execRoot(`cat ${RELEASE_MARKER} 2>/dev/null || true`, 20_000);
      const match = /version=(\d+)/.exec(marker.stdout);
      if (match) {
        provisioned = true;
        provisionVersion = Number(match[1]);
      } else if (vmPlatformBlocked(`${marker.stderr}\n${marker.stdout}`)) {
        blocked = "vm-platform";
      }
    }
    const config = await loadConfig();
    // Every status call refreshes the prompt card's facts — the UI chip polls
    // this, so the card stays warm without any dedicated plumbing. Awaited:
    // a void'd write races CLI process exit and silently vanishes.
    await updateFacts({
      distro: this.distro,
      provisioned,
      provisionVersion,
      ...(blocked ? { blocked } : { blocked: undefined }),
    });
    return {
      wslAvailable,
      distroRegistered,
      provisioned,
      provisionVersion,
      ...(blocked ? { blocked } : {}),
      distroDir: config?.distroDir,
      displays: [...this.leases.entries()].map(([display, lease]) => ({
        display,
        lease,
        cdpPort: CDP_PORT_BASE + display,
        novncPort: NOVNC_PORT_BASE + display,
      })),
    };
  }

  /** Import (downloading a rootfs if needed) + first-boot provision. Idempotent
   *  and single-flight: concurrent setups await the same run. */
  async setup(onProgress?: (line: string) => void): Promise<string> {
    if (this.setupInFlight) return this.setupInFlight;
    this.setupInFlight = (async () => {
      try {
        return await this.setupInner(onProgress ?? (() => {}));
      } finally {
        this.setupInFlight = null;
      }
    })();
    return this.setupInFlight;
  }

  private async setupInner(progress: (line: string) => void): Promise<string> {
    if (!(await this.wslAvailable())) {
      throw new Error(
        "WSL2 is not available on this machine. Run `wsl --install` from an elevated terminal, reboot, then retry.",
      );
    }
    const steps: string[] = [];
    if (!(await this.distroRegistered())) {
      // Choose storage BEFORE downloading anything, and say where it went.
      // Defaulting under ARES_HOME quietly targeted C:; on a full system
      // drive that turned setup into a disk hunt instead of an install.
      const stored = await loadConfig();
      const chosen = stored?.distroDir ? { dir: stored.distroDir, drives: [] as DriveSpace[] } : await chooseDistroDir();
      const config: SandboxConfig = stored ?? { distroDir: chosen.dir };
      config.distroDir = chosen.dir;
      const free = await driveFreeBytes(path.parse(path.resolve(chosen.dir)).root);
      if (free !== null && free < 8 * 1024 ** 3) {
        throw new Error(
          `Not enough room for the agent computer: ${formatGb(free)} free on ${path.parse(path.resolve(chosen.dir)).root} ` +
            `(about 8 GB needed). Free some space, or point it at another drive with ARES_COMPUTER_DIR ` +
            `(e.g. ARES_COMPUTER_DIR=D:\\Ares-Computer\\distro) and run setup again.`,
        );
      }
      progress(`installing to ${chosen.dir}${free !== null ? ` (${formatGb(free)} free)` : ""}`);
      await fs.mkdir(config.distroDir, { recursive: true });
      const tar = await this.obtainRootfs(config, progress);
      progress(`importing ${this.distro} from ${path.basename(tar)}…`);
      const imported = await this.run(
        ["--import", this.distro, config.distroDir, tar, "--version", "2"],
        { timeoutMs: 300_000 },
      );
      if (imported.exitCode !== 0) {
        const detail = imported.stderr || imported.stdout;
        if (vmPlatformBlocked(detail)) {
          throw new Error(
            "WSL2 cannot start virtual machines on this PC yet. One-time fix (needs admin + a reboot): " +
              "run `wsl.exe --install --no-distribution` from an elevated terminal, reboot, then run setup again. " +
              "If it still fails, enable virtualization (SVM/VT-x) in the BIOS.",
          );
        }
        throw new Error(`wsl --import failed: ${detail}`);
      }
      config.rootfsTar = tar;
      await saveConfig(config);
      steps.push("imported distro");
    }
    // First-boot provision (idempotent; runs as root before the default user
    // exists). Package install is the long pole — give it real time.
    progress("provisioning user + wsl.conf…");
    const base = await this.execRoot(
      [
        `id -u ${SANDBOX_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${SANDBOX_USER}`,
        `mkdir -p /etc/sudoers.d && printf '%s\\n' '${SANDBOX_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${SANDBOX_USER}`,
        `printf '[user]\\ndefault=${SANDBOX_USER}\\n[boot]\\nsystemd=false\\n' > /etc/wsl.conf`,
      ].join(" && "),
      60_000,
    );
    if (base.exitCode !== 0) throw new Error(`sandbox user provisioning failed: ${base.stderr || base.stdout}`);
    progress("installing packages (Chrome, display, VNC — this can take a few minutes)…");
    const install = await this.execRoot(
      `export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq --no-install-recommends ${BASE_PACKAGES.join(" ")}`,
      840_000,
    );
    if (install.exitCode !== 0) throw new Error(`package install failed: ${(install.stderr || install.stdout).slice(-800)}`);
    progress("adding terminal glyph fonts…");
    await this.execRoot(
      `mkdir -p /usr/local/share/fonts/nerd && cd /usr/local/share/fonts/nerd && ` +
        `curl -sfL -o nf.zip ${NERD_FONT_URL} && unzip -o -q nf.zip && rm -f nf.zip && fc-cache -f >/dev/null 2>&1; true`,
      180_000,
    );
    progress("locale + systemd boot…");
    // Locale first (kills the "setting locale failed" spam every apt/perl run
    // otherwise emits), then flip wsl.conf to systemd — ONLY now, after the
    // systemd packages are provably installed. A boot flag pointing at a
    // missing init strands the distro; order is the safety here.
    await this.execRoot(
      [
        `sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || true`,
        `locale-gen >/dev/null 2>&1 || true`,
        `printf 'LANG=en_US.UTF-8\\n' > /etc/default/locale`,
        `printf '[user]\\ndefault=${SANDBOX_USER}\\n[boot]\\nsystemd=true\\n' > /etc/wsl.conf`,
      ].join("; "),
      120_000,
    );
    progress("seeding the machine's home (MACHINE.md, ~/.local/bin, ~/work)…");
    // The home layout that makes it THE AGENT'S machine rather than a rootfs:
    // a memory file it maintains, a scripts dir on PATH, a projects dir, and a
    // git identity. Seeded once — never overwritten (the contents accrue).
    const seedB64 = Buffer.from(MACHINE_MD_SEED, "utf8").toString("base64");
    await this.execRoot(
      [
        `su - ${SANDBOX_USER} -c 'mkdir -p ~/work ~/.local/bin ~/.ares'`,
        `su - ${SANDBOX_USER} -c 'test -f ~/MACHINE.md || (echo ${seedB64} | base64 -d > ~/MACHINE.md)'`,
        `su - ${SANDBOX_USER} -c 'git config --global init.defaultBranch main 2>/dev/null; git config --global user.name Ares 2>/dev/null; true'`,
      ].join(" && "),
      60_000,
    );
    await this.execRoot(
      [
        `printf 'version=${PROVISION_VERSION}\\nprovisionedAt=%s\\n' "$(date -u +%FT%TZ)" > ${RELEASE_MARKER}`,
        `su - ${SANDBOX_USER} -c 'test -f ${MANIFEST_PATH} || printf "{\\"packages\\":[]}\\n" > ${MANIFEST_PATH}'`,
      ].join(" && "),
      30_000,
    );
    // Terminate so /etc/wsl.conf's default user takes effect on next start.
    await this.run(["--terminate", this.distro], { timeoutMs: 20_000 });
    // Sparse VHD: the distro's virtual disk gives space back to the host as
    // files are deleted, instead of growing monotonically forever. Per-distro
    // and safe; older wsl.exe builds just don't have the flag — best-effort.
    await this.run(["--manage", this.distro, "--set-sparse", "true"], { timeoutMs: 30_000 });
    const config = (await loadConfig())!;
    await saveConfig({ ...config, provisionedAt: new Date().toISOString(), provisionVersion: PROVISION_VERSION });
    steps.push("provisioned Debian + packages");
    this.provisionChecked = true;
    return steps.length > 0 ? steps.join("; ") : "already provisioned";
  }

  private async obtainRootfs(config: SandboxConfig, progress: (line: string) => void): Promise<string> {
    const dir = path.join(aresHome(), "computer");
    await fs.mkdir(dir, { recursive: true });
    for (const name of ["rootfs.tar.xz", "rootfs.tar.gz", "rootfs.tar"]) {
      const local = path.join(dir, name);
      if (await fs.stat(local).then((s) => s.size > 1_000_000, () => false)) return local;
    }
    let lastError = "";
    // Explicit mirror/airgap override first.
    const override = process.env.ARES_COMPUTER_ROOTFS_URL;
    if (override) {
      progress(`downloading Debian rootfs: ${override}`);
      try {
        const response = await fetch(override, { redirect: "follow" });
        if (response.ok && response.body) {
          const target = path.join(dir, override.endsWith(".xz") ? "rootfs.tar.xz" : "rootfs.tar.gz");
          await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target));
          return target;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    for (const tag of DOCKERHUB_DEBIAN_TAGS) {
      progress(`downloading Debian rootfs from Docker Hub: debian:${tag}`);
      try {
        const target = path.join(dir, "rootfs.tar.gz");
        await downloadDebianRootfsLayer(tag, target);
        return target;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`could not download a Debian rootfs (${lastError}). Place one at ${path.join(dir, "rootfs.tar.gz")} and retry.`);
  }

  private async requireProvisioned(): Promise<void> {
    if (this.provisionChecked) return;
    const current = await this.status();
    if (!current.wslAvailable) {
      throw toolError("The agent computer needs WSL2, which is not available. Ask the owner to run `wsl --install` (elevated) and reboot, or use host tools instead.");
    }
    if (!current.distroRegistered || !current.provisioned) {
      throw toolError("The agent computer is not set up yet. Run ComputerAdmin with action \"setup\" first (downloads ~40MB rootfs + installs packages; takes a few minutes).");
    }
    this.provisionChecked = true;
  }

  // ── exec & files ──────────────────────────────────────────────────────

  /** Run a command inside the sandbox as the agent user. */
  async exec(command: string, opts: { timeoutMs?: number; cwd?: string; user?: string; maxOutputChars?: number } = {}): Promise<SandboxExecResult> {
    await this.requireProvisioned();
    const cwd = opts.cwd ?? SANDBOX_HOME;
    const wrapped = `cd ${shellQuote(cwd)} 2>/dev/null; ${command}`;
    return this.run(
      ["-d", this.distro, "-u", opts.user ?? SANDBOX_USER, "--", "bash", "-lc", wrapped],
      { timeoutMs: opts.timeoutMs, maxOutputChars: opts.maxOutputChars },
    );
  }

  /** Root exec that skips the provision gate — used BY provisioning/admin. */
  private execRoot(command: string, timeoutMs: number): Promise<SandboxExecResult> {
    return this.run(["-d", this.distro, "-u", "root", "--", "bash", "-lc", command], { timeoutMs });
  }

  /** Map a sandbox absolute path to its \\wsl.localhost UNC equivalent. */
  uncPath(sandboxPath: string): string {
    const absolute = sandboxPath.startsWith("/") ? sandboxPath : `${SANDBOX_HOME}/${sandboxPath}`;
    return `\\\\wsl.localhost\\${this.distro}${absolute.replace(/\//g, "\\")}`;
  }

  resolveSandboxPath(input: string): string {
    if (/^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\")) {
      throw toolError(`"${input}" is a Windows path — sandbox paths are Linux paths like /home/${SANDBOX_USER}/project or a relative path under the home directory.`);
    }
    const absolute = input.startsWith("/") ? input : `${SANDBOX_HOME}/${input}`;
    if (absolute.split("/").includes("..")) {
      throw toolError(`"${input}" contains '..' — pass a direct path.`);
    }
    return absolute;
  }

  async readFile(sandboxPath: string, maxChars = 200_000): Promise<string> {
    await this.requireProvisioned();
    await this.exec("true", { timeoutMs: 20_000 }); // ensure the distro is running for UNC access
    const text = await fs.readFile(this.uncPath(sandboxPath), "utf8");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]` : text;
  }

  async writeFile(sandboxPath: string, content: string): Promise<void> {
    await this.requireProvisioned();
    const absolute = this.resolveSandboxPath(sandboxPath);
    await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(absolute))}`, { timeoutMs: 20_000 });
    await fs.writeFile(this.uncPath(absolute), content, "utf8");
  }

  // ── display, browser, screen ──────────────────────────────────────────

  async ensureDisplay(display = DEFAULT_DISPLAY): Promise<void> {
    await this.requireProvisioned();
    // Probe the X socket, never `pgrep -f`: every check runs inside a
    // `bash -lc "<the whole command>"`, whose own cmdline CONTAINS the search
    // pattern — so pgrep -f matches the checking shell itself and every
    // service looks permanently "already running" while nothing ever starts.
    const check = await this.exec(`test -S /tmp/.X11-unix/X${display}`, { timeoutMs: 20_000 });
    if (check.exitCode === 0) return;
    // setsid + </dev/null: `wsl.exe -- bash -lc "… &"` reaps plain background
    // children when the launching command exits, so services must be fully
    // detached from the session to outlive the call that started them.
    await this.exec(
      `setsid nohup Xvfb :${display} -screen 0 ${SCREEN_GEOMETRY} -nolisten tcp </dev/null >/tmp/xvfb-${display}.log 2>&1 & sleep 0.8`,
      { timeoutMs: 20_000 },
    );
    await this.ensureDesktop(display);
  }

  /** Start the XFCE session on a display so the screen shows an actual desktop
   *  — wallpaper, panel, window manager — instead of a black root window with
   *  one app floating on it. Idempotent; a session already running is left be. */
  async ensureDesktop(display = DEFAULT_DISPLAY): Promise<void> {
    const session = await this.exec(`command -v xfce4-session >/dev/null`, { timeoutMs: 20_000 });
    if (session.exitCode !== 0) return; // desktop packages absent — headless is still fine
    const running = await this.exec(`pgrep -u ${SANDBOX_USER} -x xfwm4 >/dev/null`, { timeoutMs: 20_000 });
    if (running.exitCode === 0) {
      // Session is up; styling is separately marker-guarded and must still run
      // (it was skipped entirely while this returned early).
      await this.styleDesktop(display);
      return;
    }
    // Same WSLg-Wayland strip as x11vnc: xfce4-session refuses to start a
    // second session when it thinks a Wayland one is already live.
    await this.exec(
      `mkdir -p /tmp/xdg-${SANDBOX_USER} && chmod 700 /tmp/xdg-${SANDBOX_USER}; ` +
        `env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE DISPLAY=:${display} XDG_RUNTIME_DIR=/tmp/xdg-${SANDBOX_USER} ` +
        `setsid nohup dbus-launch --exit-with-session xfce4-session ` +
        `</dev/null >/tmp/xfce-${display}.log 2>&1 & sleep 3`,
      { timeoutMs: 40_000 },
    );
    await this.styleDesktop(display);
  }

  /** One-time desktop dressing: a deliberate backdrop instead of bare black.
   *  Installing xfdesktop without recommends leaves no wallpaper image, and an
   *  unstyled black root reads as "broken" rather than "idle". Marker-guarded
   *  so the owner's own later choices are never overwritten. */
  private async styleDesktop(display: number): Promise<void> {
    // v2 marker: v1-styled machines restyle ONCE to pick up compositing-off
    // and the session-bus fix below; after that the owner's choices stand.
    const marker = `${SANDBOX_HOME}/.ares-desktop-styled-v2`;
    const done = await this.exec(`test -f ${shellQuote(marker)}`, { timeoutMs: 15_000 });
    if (done.exitCode === 0) return;
    const env = `env DISPLAY=:${display} XDG_RUNTIME_DIR=/tmp/xdg-${SANDBOX_USER}`;
    // Under systemd, login shells export DBUS_SESSION_BUS_ADDRESS pointing at
    // the USER bus (/run/user/…/bus) — but xfconfd/xfdesktop live on the
    // SESSION bus dbus-launch created. xfconf-query on the wrong bus writes
    // settings into a parallel xfconfd nobody reads. Resolve the real bus off
    // the running window manager (xargs -0: no escape sequences to mangle
    // through the shell layers), export it for every command in this chain.
    const busPrelude =
      `wmpid=$(pgrep -u ${SANDBOX_USER} -x xfwm4 | head -1); ` +
      `if [ -n "$wmpid" ]; then sbus=$(xargs -0 -n1 < /proc/$wmpid/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-); fi; ` +
      `if [ -n "\${sbus:-}" ]; then export DBUS_SESSION_BUS_ADDRESS="$sbus"; else unset DBUS_SESSION_BUS_ADDRESS; fi`;
    // The backdrop property path embeds the RandR OUTPUT name, which under
    // Xvfb is "screen" — not the "monitor0" every xfce guide assumes. Read it
    // from xrandr instead of guessing, or the settings land on a path
    // xfdesktop never reads and the root stays black.
    const output = await this.exec(
      `${env} xrandr --listmonitors 2>/dev/null | awk 'NR==2 {print $NF}'`,
      { timeoutMs: 20_000 },
    );
    const monitor = output.stdout.trim() || "screen";
    const wallpaper = `${SANDBOX_HOME}/.ares-wallpaper.png`;
    const q = `${env} xfconf-query -c xfce4-desktop`;
    const xs = `${env} xfconf-query -c xsettings`;
    const wm = `${env} xfconf-query -c xfwm4`;
    const base = `/backdrop/screen0/monitor${monitor}/workspace0`;
    const theme = await this.exec(`test -d /usr/share/themes/Greybird-dark`, { timeoutMs: 15_000 });
    const icons = await this.exec(`test -d /usr/share/icons/Papirus-Dark`, { timeoutMs: 15_000 });
    await this.exec(
      [
        busPrelude,
        // A generated wallpaper beats a color property: it always matches the
        // geometry and needs no extra package (ImageMagick is already here).
        // Radial base first so the backdrop exists even where the wordmark
        // step fails for want of a usable font.
        `convert -size 1280x800 radial-gradient:'#1c2230'-'#06080c' ${shellQuote(wallpaper)} 2>/dev/null || true`,
        // A quiet, wide-tracked wordmark — present, not shouting.
        `convert ${shellQuote(wallpaper)} -fill '#e28c50' -alpha set -channel A ` +
          `-pointsize 58 -kerning 26 -gravity center -family 'DejaVu Sans' ` +
          `-annotate +0+0 'ARES' -channel RGBA ${shellQuote(wallpaper)} 2>/dev/null || true`,
        `${q} -p ${base}/last-image -n -t string -s ${shellQuote(wallpaper)}`,
        `${q} -p ${base}/image-style -n -t int -s 5`,
        `${q} -p ${base}/color-style -n -t int -s 0`,
        // Bare desktop: the Home/File System icons are clutter on a machine
        // whose file manager is one menu click away.
        `${q} -p /desktop-icons/style -n -t int -s 0`,
        // Dark chrome + real icons + a hinted font. Applied through xsettings
        // so it lands live on a running session, no restart.
        ...(theme.exitCode === 0
          ? [
              `${xs} -p /Net/ThemeName -n -t string -s 'Greybird-dark'`,
              `${wm} -p /general/theme -n -t string -s 'Greybird-dark'`,
              `${wm} -p /general/title_font -n -t string -s 'DejaVu Sans Bold 9'`,
            ]
          : []),
        // Compositing OFF: shadows/fades force whole-window damage on every
        // event, which x11vnc then re-encodes — the classic VNC lag source.
        // Over this screen nobody can see the difference; they CAN feel it.
        `${wm} -p /general/use_compositing -n -t bool -s false`,
        ...(icons.exitCode === 0 ? [`${xs} -p /Net/IconThemeName -n -t string -s 'Papirus-Dark'`] : []),
        `${xs} -p /Gtk/FontName -n -t string -s 'DejaVu Sans 10'`,
        `${xs} -p /Gtk/MonospaceFontName -n -t string -s 'DejaVu Sans Mono 10'`,
        `${xs} -p /Xft/Antialias -n -t int -s 1`,
        `${xs} -p /Xft/Hinting -n -t int -s 1`,
        `${xs} -p /Xft/HintStyle -n -t string -s 'hintslight'`,
        `${xs} -p /Xft/RGBA -n -t string -s 'rgb'`,
        `touch ${shellQuote(marker)}`,
      ].join("; "),
      { timeoutMs: 60_000 },
    );
  }

  /** The Chrome that OWNS this display. Playwright/CDP callers must attach to
   *  it (connectOverCDP semantics) — never launch a second browser, or the
   *  session splits from the screen and the login story falls apart. */
  async ensureBrowser(display = DEFAULT_DISPLAY): Promise<{ cdpPort: number }> {
    await this.ensureDisplay(display);
    const cdpPort = CDP_PORT_BASE + display;
    const profile = `${SANDBOX_HOME}/.profiles/agent-${display}`;
    // Ask the debug endpoint itself — the browser answering IS the liveness
    // test (and pgrep -f would match this very shell; see ensureDisplay).
    const check = await this.exec(`curl -sf -m 2 http://127.0.0.1:${cdpPort}/json/version >/dev/null`, { timeoutMs: 20_000 });
    if (check.exitCode !== 0) {
      // A killed/crashed Chrome leaves Singleton{Lock,Socket,Cookie} behind.
      // The next launch sees them, tries to hand off to the dead instance, and
      // exits silently — the profile looks "in use" forever. No process owns
      // this profile right now, so the locks are stale by definition.
      await this.exec(
        `rm -f ${shellQuote(`${profile}/SingletonLock`)} ${shellQuote(`${profile}/SingletonSocket`)} ${shellQuote(`${profile}/SingletonCookie`)}`,
        { timeoutMs: 20_000 },
      );
      // --no-sandbox: Chrome's own setuid/namespace sandbox can't initialize
      //   inside the WSL container, so without this the browser dies on launch.
      //   The sandbox IS the WSL guest; Chrome is already contained.
      // --disable-dev-shm-usage: WSL's /dev/shm is tiny; keep tabs off it.
      // --disable-gpu + SwiftShader: no GPU under Xvfb — force software GL so
      //   pages render instead of hanging on a missing context.
      // A hard kill leaves exit_type "Crashed" in Preferences, which greets the
      // next launch (and every screenshot) with a "Restore pages?" bubble. The
      // OS is disposable here and sessions are not; mark the profile clean.
      await this.exec(
        `f=${shellQuote(`${profile}/Default/Preferences`)}; [ -f "$f" ] && ` +
          `sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$f" || true`,
        { timeoutMs: 20_000 },
      );
      await this.exec(
        `mkdir -p ${shellQuote(profile)} && DISPLAY=:${display} setsid nohup chromium ` +
          `--no-first-run --no-default-browser-check --disable-features=TranslateUI ` +
          `--disable-session-crashed-bubble --disable-infobars --hide-crash-restore-bubble ` +
          `--no-sandbox --disable-dev-shm-usage --disable-gpu --use-gl=angle --use-angle=swiftshader ` +
          // Smooth scrolling under software GL is dozens of interpolation
          // frames x11vnc must re-encode per wheel tick; snap-scrolling is
          // one damage event and reads FASTER on the streamed screen.
          `--disable-smooth-scrolling ` +
          `--remote-debugging-port=${cdpPort} --remote-allow-origins=* ` +
          `--user-data-dir=${shellQuote(profile)} --window-size=1280,760 --window-position=0,0 ` +
          `--start-maximized about:blank </dev/null >/tmp/chromium-${display}.log 2>&1 & sleep 2.5`,
        { timeoutMs: 30_000 },
      );
    }
    return { cdpPort };
  }

  /** The watchable, grabbable screen: x11vnc + noVNC (websockify) so the pane
   *  is one URL — http://localhost:<port>/vnc.html — with zero frontend deps. */
  async ensureScreen(display = DEFAULT_DISPLAY, viewOnly = false): Promise<{ url: string; novncPort: number }> {
    await this.ensureDisplay(display);
    const vncPort = VNC_PORT_BASE + display;
    const novncPort = NOVNC_PORT_BASE + display;
    // TCP probes over bash's /dev/tcp — same self-match reason as above.
    const vnc = await this.exec(`(exec 3<>/dev/tcp/127.0.0.1/${vncPort}) 2>/dev/null`, { timeoutMs: 20_000 });
    if (vnc.exitCode !== 0) {
      // WSLg exports WAYLAND_DISPLAY/XDG_SESSION_TYPE into every WSL shell.
      // x11vnc sniffs those, declares "Wayland session — exiting", and dies —
      // even though the display we hand it is a plain Xvfb X server. Strip
      // them for this process so it sees the X11 world it is actually serving.
      //
      // Performance and the cursor, both learned the hard way:
      //   -noxdamage was making it POLL the whole 1280x800 framebuffer every
      //     pass — the single biggest source of the lag. XDAMAGE works fine on
      //     Xvfb, so let it tell us what actually changed.
      //   -threads serves the client off the polling loop.
      //   -cursor most -cursorpos DRAWS the pointer into the stream. Without
      //     it the owner watches work happen with no visible mouse at all.
      //   NO -ncache: it grows the framebuffer vertically for offscreen
      //     caching, and noVNC renders that raw — the desktop came back as a
      //     tall garbled stack. Speed has to come from damage tracking alone.
      await this.exec(
        `env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE -u XDG_RUNTIME_DIR DISPLAY=:${display} ` +
          `setsid nohup x11vnc -display :${display} -rfbport ${vncPort} -localhost -forever -shared -nopw ` +
          `-threads -xdamage -wait 10 -defer 10 -nap -cursor most -cursorpos -nolookup ` +
          `</dev/null >/tmp/x11vnc-${display}.log 2>&1 & sleep 1.2`,
        { timeoutMs: 25_000 },
      );
    }
    const web = await this.exec(`(exec 3<>/dev/tcp/127.0.0.1/${novncPort}) 2>/dev/null`, { timeoutMs: 20_000 });
    if (web.exitCode !== 0) {
      // websockify binds all interfaces so Windows can reach it across the WSL
      // NAT boundary (x11vnc itself stays -localhost, inside the guest).
      await this.exec(
        `setsid nohup websockify --web=/usr/share/novnc ${novncPort} localhost:${vncPort} ` +
          `</dev/null >/tmp/novnc-${display}.log 2>&1 & sleep 0.8`,
        { timeoutMs: 20_000 },
      );
    }
    // resize=scale, not off: the guest screen is a fixed 1280x800 and the
    // owner's window never is, so "off" greeted them with scrollbars around a
    // clipped desktop. Scaling fits the whole machine in whatever window it
    // opens in.
    // quality=6 (tight JPEG), not 9: the felt lag lives in noVNC's JS decode
    // and canvas blit inside a webview that is already running the whole app —
    // q6 is visually indistinguishable on a desktop and far less to decode.
    // compression=1 keeps zlib nearly free on loopback.
    const params = `autoconnect=1&resize=scale&quality=6&compression=1&show_dot=1${viewOnly ? "&view_only=1" : ""}`;
    const url = `http://localhost:${novncPort}/vnc.html?${params}`;
    await updateFacts({ screenUrl: url });
    return { url, novncPort };
  }

  /** Stop the screen pipeline (x11vnc + websockify). The desktop keeps
   *  running; only the streaming stops. Watching costs a full-time framebuffer
   *  poller — when nobody is looking, the machine should not pay for an
   *  audience of zero. */
  async screenOff(display = DEFAULT_DISPLAY): Promise<string> {
    await this.requireProvisioned();
    // Kill by PORT, never `pkill -f`: this whole command runs inside a
    // `bash -lc "<command>"` whose own cmdline contains any -f pattern — the
    // shell would match and kill itself (the same self-match that once made
    // every liveness probe lie). fuser is process-name-blind and port-exact.
    await this.exec(
      `fuser -k -TERM ${NOVNC_PORT_BASE + display}/tcp 2>/dev/null; fuser -k -TERM ${VNC_PORT_BASE + display}/tcp 2>/dev/null; true`,
      { timeoutMs: 20_000 },
    );
    await updateFacts({ screenUrl: undefined });
    return `screen streaming stopped on :${display} (desktop still running; "screen" restarts it)`;
  }

  // ── the wake ritual ───────────────────────────────────────────────────

  /**
   * Arriving at the machine, as a visible event: boot the desktop, stamp the
   * current task onto the wallpaper, sync the journal into the box, and return
   * a boot report that INCLUDES ~/MACHINE.md — so one call leaves the agent
   * standing at its own computer already knowing everything it ever learned
   * about it. Idempotent; cheap when everything is already up.
   */
  async wake(task?: string, display = DEFAULT_DISPLAY): Promise<string> {
    await this.ensureDisplay(display);
    // One combined probe: uptime, disk, package count, machine notes.
    const probe = await this.exec(
      [
        `printf 'UPTIME=%s\\n' "$(uptime -p 2>/dev/null | sed 's/^up //')"`,
        `printf 'DISK=%s\\n' "$(df -h ${SANDBOX_HOME} 2>/dev/null | awk 'NR==2 {print $4}')"`,
        `printf 'PKGS=%s\\n' "$(jq -r '.packages | length' ${MANIFEST_PATH} 2>/dev/null || echo 0)"`,
        `echo '---MACHINE---'`,
        `head -c 6000 ${SANDBOX_HOME}/MACHINE.md 2>/dev/null || echo '(no MACHINE.md — old provision; run ComputerAdmin setup to upgrade)'`,
      ].join("; "),
      { timeoutMs: 30_000 },
    );
    const [meta = "", machineMd = ""] = probe.stdout.split("---MACHINE---");
    const uptime = /UPTIME=(.*)/.exec(meta)?.[1]?.trim() || undefined;
    const disk = /DISK=(.*)/.exec(meta)?.[1]?.trim() || undefined;
    const pkgs = Number(/PKGS=(.*)/.exec(meta)?.[1] ?? "0") || 0;
    // Mirror the host-side journal into the box so the agent can grep its own
    // past from inside (`grep how-i-did ~/.ares/journal.jsonl`).
    const tail = await journalTail(JOURNAL_KEEP);
    if (tail.length > 0) {
      await this.writeFile(`${SANDBOX_HOME}/.ares/journal.jsonl`, tail.map((e) => JSON.stringify(e)).join("\n") + "\n").catch(() => {});
    }
    await this.stampWallpaper(task, display).catch(() => { /* decoration */ });
    await updateFacts({ uptime, packages: pkgs, lastWake: new Date().toISOString(), ...(disk ? { freeSpace: `${disk} (home)` } : {}) });
    await appendJournal({ kind: "wake", detail: task ? `woke for: ${task}` : "woke", ok: true });
    const deeds = tail.slice(-3).map((e) => `  - ${e.t.slice(0, 16).replace("T", " ")} ${e.kind}: ${e.detail}`).join("\n");
    return [
      `Awake at your computer (${this.distro}).${uptime ? ` Up ${uptime}.` : ""}${disk ? ` ${disk} free in home.` : ""} ${pkgs} manifest package(s).`,
      task ? `Task stamped on the wallpaper: ${task}` : "",
      deeds ? `Last deeds:\n${deeds}` : "",
      machineMd.trim() ? `\n── ~/MACHINE.md ──\n${machineMd.trim()}` : "",
    ].filter((s) => s.length > 0).join("\n");
  }

  /** Repaint the wallpaper as a status board: the wordmark, the current task,
   *  and the wake timestamp — so every screenshot and every glance at the
   *  screen answers "what is this machine doing right now" by itself.
   *
   *  Repaint mechanics, live-verified the hard way:
   *  - `xfdesktop --reload` does NOT re-read an image whose path is unchanged,
   *    so the stamp alternates between two files and flips the xfconf
   *    `last-image` property — a property CHANGE always repaints.
   *  - xfconf/xfdesktop live on the SESSION bus dbus-launch created, which
   *    under systemd is NOT the login shell's user bus (/run/user/…/bus). The
   *    real address is read off the running xfdesktop's /proc environ.
   *  - Runs as a generated script FILE, not an inline bash -lc string: three
   *    quoting layers deep is where a `\0` becomes a real NUL byte and spawn
   *    refuses the whole command (also live-verified, unfortunately).
   */
  async stampWallpaper(task?: string, display = DEFAULT_DISPLAY): Promise<void> {
    const when = new Date().toISOString().slice(0, 16).replace("T", " ");
    // ImageMagick text safety: strip characters that would break -annotate.
    const taskLine = (task ?? "").replace(/[^\w .,:;()/'"@#&+-]/g, " ").slice(0, 72);
    const script = [
      "#!/bin/bash",
      "set -u",
      `A=${SANDBOX_HOME}/.ares-wallpaper.png`,
      `B=${SANDBOX_HOME}/.ares-wallpaper-b.png`,
      `pid=$(pgrep -u ${SANDBOX_USER} -x xfdesktop | head -1)`,
      `bus=""`,
      // The \0 must reach tr as its two-character escape — this is a script
      // FILE, so the backslash survives (no shell re-parse on the way in).
      String.raw`[ -n "$pid" ] && bus=$(tr '\0' '\n' < /proc/$pid/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)`,
      String.raw`mon=$(env DISPLAY=:` + String(display) + String.raw` xrandr --listmonitors 2>/dev/null | awk 'NR==2 {print $NF}')`,
      `mon=\${mon:-screen}`,
      `prop=/backdrop/screen0/monitor\$mon/workspace0/last-image`,
      `cur=""`,
      `[ -n "$bus" ] && cur=$(env DBUS_SESSION_BUS_ADDRESS="$bus" DISPLAY=:${display} xfconf-query -c xfce4-desktop -p $prop 2>/dev/null || true)`,
      `target=$A; [ "$cur" = "$A" ] && target=$B`,
      `convert -size 1280x800 radial-gradient:'#1c2230'-'#06080c' "$target"`,
      `convert "$target" -fill '#e28c50' -pointsize 58 -kerning 26 -gravity center -family 'DejaVu Sans' -annotate +0-40 'ARES' "$target"`,
      ...(taskLine
        ? [`convert "$target" -fill '#c8d2e0' -pointsize 20 -gravity center -family 'DejaVu Sans' -annotate +0+30 ${shellQuote(taskLine)} "$target"`]
        : []),
      `convert "$target" -fill '#5a6478' -pointsize 13 -gravity southeast -family 'DejaVu Sans' -annotate +18+14 ${shellQuote(`awake ${when}`)} "$target"`,
      `if [ -n "$bus" ]; then`,
      `  env DBUS_SESSION_BUS_ADDRESS="$bus" DISPLAY=:${display} xfconf-query -c xfce4-desktop -p $prop -n -t string -s "$target"`,
      `else`,
      // No live session bus (xfdesktop died or never started): start xfdesktop
      // detached — the fresh instance reads the property, which still points
      // at whichever file the last successful stamp wrote.
      `  env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE DISPLAY=:${display} XDG_RUNTIME_DIR=/tmp/xdg-${SANDBOX_USER} setsid nohup xfdesktop </dev/null >/tmp/xfdesktop-${display}.log 2>&1 &`,
      `fi`,
      `true`,
    ].join("\n");
    await this.writeFile("/tmp/.ares-stamp.sh", script + "\n");
    await this.exec("bash /tmp/.ares-stamp.sh", { timeoutMs: 40_000 });
  }

  // ── the visible hand: pixel input under a display lease ───────────────

  /**
   * Real pointer/keyboard input on the sandbox desktop. This is the ONE path
   * allowed to drive the GUI (exec is refused by doctrine), it takes the
   * display lease because a screen has one mouse, and it is deliberately
   * visible: the owner watching the pane sees the cursor travel and click.
   */
  async desktopInput(
    action: "move" | "click" | "double_click" | "right_click" | "type" | "key" | "drag" | "scroll",
    opts: { x?: number; y?: number; toX?: number; toY?: number; text?: string; key?: string; amount?: number; display?: number } = {},
  ): Promise<string> {
    const display = opts.display ?? DEFAULT_DISPLAY;
    await this.ensureDisplay(display);
    const held = this.leases.get(display);
    if (held && held.holder === "owner") {
      throw toolError(`the owner is driving display :${display} right now (${held.reason}). Wait for the hand-back before using the mouse.`);
    }
    const x = `env DISPLAY=:${display} xdotool`;
    // Move visibly before acting: a cursor that teleports and clicks in the
    // same frame is indistinguishable from nothing happening.
    const at = opts.x !== undefined && opts.y !== undefined
      ? `${x} mousemove --sync ${Math.round(opts.x)} ${Math.round(opts.y)}; sleep 0.15; `
      : "";
    let command: string;
    switch (action) {
      case "move":
        command = `${x} mousemove --sync ${Math.round(opts.x ?? 0)} ${Math.round(opts.y ?? 0)}`;
        break;
      case "click":
        command = `${at}${x} click 1`;
        break;
      case "double_click":
        command = `${at}${x} click --repeat 2 --delay 120 1`;
        break;
      case "right_click":
        command = `${at}${x} click 3`;
        break;
      case "type":
        if (opts.text === undefined) throw toolError("type requires text.");
        command = `${at}${x} type --delay 25 -- ${shellQuote(opts.text)}`;
        break;
      case "key":
        if (!opts.key) throw toolError("key requires a key name, e.g. Return, ctrl+c, alt+Tab.");
        if (!/^[A-Za-z0-9_+ -]{1,60}$/.test(opts.key)) throw toolError(`"${opts.key}" is not a valid key spec.`);
        command = `${at}${x} key --clearmodifiers ${opts.key}`;
        break;
      case "scroll":
        command = `${at}${x} click --repeat ${Math.max(1, Math.min(20, opts.amount ?? 3))} ${(opts.amount ?? 3) < 0 ? 4 : 5}`;
        break;
      default: {
        if (opts.toX === undefined || opts.toY === undefined) throw toolError("drag requires toX and toY.");
        command = `${at}${x} mousedown 1; ${x} mousemove --sync ${Math.round(opts.toX)} ${Math.round(opts.toY)}; sleep 0.15; ${x} mouseup 1`;
      }
    }
    const lease = this.acquireLease(display, "agent", `desktop ${action}`);
    try {
      const result = await this.exec(command, { timeoutMs: 30_000 });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).slice(0, 300);
        if (/xdotool: (command )?not found|No such file/i.test(detail)) {
          throw toolError("xdotool is not installed on the agent computer — run ComputerAdmin manifest_install with package \"xdotool\".");
        }
        throw toolError(`desktop ${action} failed: ${detail}`);
      }
      const pos = await this.exec(`env DISPLAY=:${display} xdotool getmouselocation --shell 2>/dev/null | tr '\\n' ' '`, { timeoutMs: 15_000 });
      return `${action} done${pos.stdout.trim() ? ` (${pos.stdout.trim()})` : ""}`;
    } finally {
      if (this.leases.get(display) === lease) this.releaseLease(display);
    }
  }

  // ── the display lease ─────────────────────────────────────────────────

  lease(display: number): DisplayLease | null {
    return this.leases.get(display) ?? null;
  }

  /** One input owner per screen at a time. CDP work is mouse-free and never
   *  needs the lease; pixel drivers and the owner's drive-mode do. */
  acquireLease(display: number, holder: "owner" | "agent", reason: string): DisplayLease {
    const current = this.leases.get(display);
    if (current && current.holder !== holder) {
      throw toolError(`display :${display} lease is held by ${current.holder} (${current.reason}) since ${current.since}. Release it first (owner: hand the screen back; agent: finish or release).`);
    }
    const lease: DisplayLease = { holder, reason, since: new Date().toISOString() };
    this.leases.set(display, lease);
    return lease;
  }

  releaseLease(display: number): void {
    this.leases.delete(display);
  }

  // ── browser over CDP (page-level, mouse-free) ─────────────────────────

  private async cdp<T>(display: number, action: (client: CdpClient, sessionId: string) => Promise<T>): Promise<T> {
    const { cdpPort } = await this.ensureBrowser(display);
    const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
    const wsUrl = version?.webSocketDebuggerUrl as string | undefined;
    if (!wsUrl) throw toolError("sandbox Chrome's debug endpoint is not answering — try ComputerAdmin action \"setup\" or a plain ComputerExec `pkill chromium` then retry.");
    const client = await CdpClient.connect(wsUrl, 5_000);
    try {
      // Attach to the page tab that owns the screen — create one only when the
      // browser has none (fresh boot). Never a throwaway second tab: what the
      // model does must be what the screen shows.
      const targets = (await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`)) as unknown as Array<Record<string, unknown>> | null;
      let targetId = (targets ?? []).find((t) => t.type === "page" && !String(t.url).startsWith("devtools:"))?.id as string | undefined;
      if (!targetId) {
        targetId = (await client.send("Target.createTarget", { url: "about:blank" })).targetId as string;
      }
      const sessionId = (await client.send("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;
      return await action(client, sessionId);
    } finally {
      client.close();
    }
  }

  async browserNavigate(url: string, display = DEFAULT_DISPLAY, settleMs = 1_200): Promise<{ title: string; url: string }> {
    return this.cdp(display, async (client, sessionId) => {
      await client.send("Page.enable", {}, sessionId);
      const loaded = new Promise<void>((resolve) => {
        client.onEvent((e) => {
          if (e.method === "Page.loadEventFired" && e.sessionId === sessionId) resolve();
        });
      });
      await client.send("Page.navigate", { url }, sessionId, 15_000);
      await Promise.race([loaded, sleep(12_000)]);
      await sleep(settleMs);
      const identity = await this.pageIdentity(client, sessionId);
      // The card remembers where the browser sits, so the next session opens
      // knowing "Chrome is on github.com/notifications" instead of guessing.
      await updateFacts({ lastUrl: identity.url, lastTitle: identity.title });
      return identity;
    });
  }

  private async pageIdentity(client: CdpClient, sessionId: string): Promise<{ title: string; url: string }> {
    const result = await client.send(
      "Runtime.evaluate",
      { expression: "JSON.stringify({ title: document.title, url: location.href })", returnByValue: true },
      sessionId,
    );
    try {
      return JSON.parse(String((result.result as { value?: unknown })?.value ?? "{}")) as { title: string; url: string };
    } catch {
      return { title: "", url: "" };
    }
  }

  async browserRead(display = DEFAULT_DISPLAY, maxChars = 18_000): Promise<{ title: string; url: string; text: string }> {
    return this.cdp(display, async (client, sessionId) => {
      const identity = await this.pageIdentity(client, sessionId);
      const evaluated = await client.send(
        "Runtime.evaluate",
        { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
        sessionId,
        10_000,
      );
      let text = String((evaluated.result as { value?: unknown })?.value ?? "");
      text = text.replace(/\n{3,}/g, "\n\n").trim();
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… [truncated]`;
      return { ...identity, text };
    });
  }

  async browserEval(expression: string, display = DEFAULT_DISPLAY): Promise<string> {
    return this.cdp(display, async (client, sessionId) => {
      const evaluated = await client.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
        15_000,
      );
      const err = (evaluated.exceptionDetails as { exception?: { description?: string } } | undefined);
      if (err) throw toolError(`page eval failed: ${err.exception?.description ?? "exception"}`);
      const value = (evaluated.result as { value?: unknown })?.value;
      return typeof value === "string" ? value : JSON.stringify(value ?? null);
    });
  }

  async browserClick(selector: string, display = DEFAULT_DISPLAY): Promise<string> {
    // CDP clicks never move the pointer, so on the watched screen a page just
    // changes by itself. Flash a marker where the click lands: the owner can
    // see WHERE the agent acted, which is the whole value of watching.
    return this.browserEval(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return "no element matches";
        el.scrollIntoView({ block: "center" });
        try {
          const r = el.getBoundingClientRect();
          const dot = document.createElement("div");
          dot.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;width:26px;height:26px;" +
            "border:2px solid #e28c50;border-radius:50%;background:rgba(226,140,80,.28);" +
            "transition:opacity .5s ease,transform .5s ease;" +
            "left:" + (r.left + r.width / 2 - 13) + "px;top:" + (r.top + r.height / 2 - 13) + "px;";
          document.body.appendChild(dot);
          requestAnimationFrame(() => { dot.style.opacity = "0"; dot.style.transform = "scale(2.2)"; });
          setTimeout(() => dot.remove(), 900);
        } catch { /* marker is decoration; never block the click */ }
        el.click();
        return "clicked";
      })()`,
      display,
    );
  }

  async browserType(selector: string, text: string, display = DEFAULT_DISPLAY): Promise<string> {
    // Native value setter + input/change events so React/Vue-controlled inputs
    // actually observe the change (plain .value writes are swallowed).
    return this.browserEval(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return "no element matches";
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else if ("value" in el) el.value = ${JSON.stringify(text)};
        else { el.textContent = ${JSON.stringify(text)}; }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "typed";
      })()`,
      display,
    );
  }

  async browserScreenshot(display = DEFAULT_DISPLAY): Promise<string> {
    return this.cdp(display, async (client, sessionId) => {
      const shot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId, 15_000);
      const data = shot.data as string | undefined;
      if (!data) throw toolError("page screenshot returned no data");
      return data;
    });
  }

  /** Whole-desktop capture (read-only) — what a human at the machine sees. */
  async desktopScreenshot(display = DEFAULT_DISPLAY): Promise<string> {
    await this.ensureDisplay(display);
    // A 1280x800 PNG runs 100-800KB of base64 — far past the default 60k
    // output cap, which silently truncated every capture into a corrupt image
    // (found live: "saved exactly 60000 chars"). Screenshots get their own cap.
    const result = await this.exec(
      `DISPLAY=:${display} xwd -root -silent | convert xwd:- png:- | base64 -w0`,
      { timeoutMs: 30_000, maxOutputChars: 8_000_000 },
    );
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw toolError(`desktop capture failed: ${(result.stderr || result.stdout).slice(0, 400)}`);
    }
    return result.stdout.trim();
  }

  // ── manifest, snapshot, rebuild ───────────────────────────────────────

  async manifest(): Promise<{ packages: string[] }> {
    const raw = await this.exec(`cat ${MANIFEST_PATH} 2>/dev/null || printf '{"packages":[]}'`, { timeoutMs: 20_000 });
    try {
      const parsed = JSON.parse(raw.stdout) as { packages?: unknown };
      return { packages: Array.isArray(parsed.packages) ? parsed.packages.filter((p): p is string => typeof p === "string") : [] };
    } catch {
      return { packages: [] };
    }
  }

  /** Install a package AND record it, so it survives OS rebuilds. Anything
   *  installed outside this evaporates on rebuild — by design. */
  async manifestInstall(pkg: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(pkg)) throw toolError(`"${pkg}" is not a valid Debian package name.`);
    const install = await this.exec(
      `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${pkg}`,
      { timeoutMs: 600_000 },
    );
    if (install.exitCode !== 0) throw toolError(`apt install ${pkg} failed: ${(install.stderr || install.stdout).slice(-500)}`);
    const manifest = await this.manifest();
    if (!manifest.packages.includes(pkg)) {
      manifest.packages.push(pkg);
      await this.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
    }
    return `${pkg} installed and recorded in the rebuild manifest (${manifest.packages.length} extra package(s)).`;
  }

  /** Full-distro snapshot tar (OS + home) for point-in-time restore. */
  async snapshot(): Promise<string> {
    const config = await loadConfig();
    const dir = path.join(config?.distroDir ? path.dirname(config.distroDir) : path.join(aresHome(), "computer"), "snapshots");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `ares-computer-${new Date().toISOString().replace(/[:.]/g, "-")}.tar`);
    const result = await this.run(["--export", this.distro, target], { timeoutMs: 600_000 });
    if (result.exitCode !== 0) throw new Error(`snapshot failed: ${result.stderr || result.stdout}`);
    return target;
  }

  /** The durability contract in action: fresh OS, same home. Exports /home,
   *  unregisters, reimports the cached rootfs, reprovisions, restores home,
   *  replays the manifest. */
  async rebuild(onProgress?: (line: string) => void): Promise<string> {
    const progress = onProgress ?? (() => {});
    const config = await loadConfig();
    if (!config?.rootfsTar || !(await fs.stat(config.rootfsTar).then(() => true, () => false))) {
      throw new Error("no cached rootfs tar — run setup once before rebuild.");
    }
    progress("exporting /home…");
    const homeTarSandbox = "/tmp/ares-home-backup.tar.gz";
    const exported = await this.exec(`tar -C /home -czf ${homeTarSandbox} ${SANDBOX_USER}`, { timeoutMs: 600_000 });
    if (exported.exitCode !== 0) throw new Error(`home export failed: ${exported.stderr}`);
    const hostHomeTar = path.join(path.dirname(configPath()), "home-backup.tar.gz");
    await fs.copyFile(this.uncPath(homeTarSandbox), hostHomeTar);
    const manifest = await this.manifest();
    progress("replacing the OS…");
    await this.run(["--unregister", this.distro], { timeoutMs: 120_000 });
    const imported = await this.run(
      ["--import", this.distro, config.distroDir, config.rootfsTar, "--version", "2"],
      { timeoutMs: 300_000 },
    );
    if (imported.exitCode !== 0) throw new Error(`reimport failed: ${imported.stderr || imported.stdout}`);
    this.provisionChecked = false;
    await this.setupInner(progress);
    progress("restoring home + replaying the manifest…");
    const restoreTarget = this.uncPath("/tmp/ares-home-restore.tar.gz");
    await this.exec("true", { timeoutMs: 30_000 });
    await fs.copyFile(hostHomeTar, restoreTarget);
    const restored = await this.execRoot(
      `tar -C /home -xzf /tmp/ares-home-restore.tar.gz && chown -R ${SANDBOX_USER}:${SANDBOX_USER} /home/${SANDBOX_USER}`,
      300_000,
    );
    if (restored.exitCode !== 0) throw new Error(`home restore failed: ${restored.stderr}`);
    if (manifest.packages.length > 0) {
      await this.execRoot(
        `export DEBIAN_FRONTEND=noninteractive && apt-get install -y -qq --no-install-recommends ${manifest.packages.join(" ")}`,
        840_000,
      );
    }
    return `rebuilt: fresh OS, home preserved, ${manifest.packages.length} manifest package(s) replayed.`;
  }
}

// ── module-level singleton (one sandbox per owner/process) ───────────────

let sandboxSingleton: WslSandbox | null = null;
export function getAgentComputer(): WslSandbox {
  sandboxSingleton ??= new WslSandbox();
  return sandboxSingleton;
}

// ── the tools ─────────────────────────────────────────────────────────────

const execInput = z
  .object({
    command: z.string().min(1).describe("Shell command to run inside the agent computer (bash)."),
    description: z.string().describe("5-10 word active-voice summary."),
    timeout: z.number().int().positive().max(EXEC_MAX_TIMEOUT_MS).default(EXEC_DEFAULT_TIMEOUT_MS)
      .describe(`Timeout in ms (max ${EXEC_MAX_TIMEOUT_MS}).`),
    cwd: z.string().optional().describe(`Working directory inside the sandbox. Defaults to ${SANDBOX_HOME}.`),
  })
  .strict();

export interface ComputerExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const fileInput = z
  .object({
    action: z.enum(["read", "write", "list"]).describe("File operation inside the agent computer."),
    path: z.string().min(1).describe(`Sandbox path (absolute like ${SANDBOX_HOME}/notes.txt, or relative to the home directory).`),
    content: z.string().optional().describe("File content for write."),
  })
  .strict();

const screenshotInput = z
  .object({
    display: z.number().int().min(1).max(9).default(DEFAULT_DISPLAY).describe("Which sandbox display to capture."),
  })
  .strict();

const browserInput = z
  .object({
    action: z
      .enum(["navigate", "read", "click", "type", "eval", "screenshot"])
      .describe("Page-level browser action on the sandbox Chrome (mouse-free CDP: never takes the screen lease)."),
    url: z.string().optional().describe("URL for navigate."),
    selector: z.string().optional().describe("CSS selector for click/type."),
    text: z.string().optional().describe("Text for type."),
    expression: z.string().optional().describe("JavaScript for eval (page context, awaits promises)."),
    display: z.number().int().min(1).max(9).default(DEFAULT_DISPLAY).describe("Which display's Chrome to drive."),
  })
  .strict();

const transferInput = z
  .object({
    direction: z.enum(["to_computer", "to_host"]).describe("to_computer: host file → sandbox. to_host: sandbox file → host."),
    host_path: z.string().min(1).describe("Host (Windows) file path — gated by normal host path permissions."),
    computer_path: z.string().min(1).describe("Sandbox file path."),
  })
  .strict();

const handoffInput = z
  .object({
    reason: z.string().min(1).describe("What the owner must do on the screen (e.g. 'complete the GitHub 2FA prompt', 'solve the CAPTCHA', 'approve the payment')."),
    display: z.number().int().min(1).max(9).default(DEFAULT_DISPLAY),
  })
  .strict();

const desktopInput = z
  .object({
    action: z
      .enum(["move", "click", "double_click", "right_click", "type", "key", "drag", "scroll"])
      .describe("Pixel-level input on the agent computer's desktop. Visible: the pointer actually moves."),
    x: z.number().int().min(0).max(4096).optional().describe("Target X (screen is 1280x800)."),
    y: z.number().int().min(0).max(4096).optional().describe("Target Y."),
    to_x: z.number().int().min(0).max(4096).optional().describe("Drag destination X."),
    to_y: z.number().int().min(0).max(4096).optional().describe("Drag destination Y."),
    text: z.string().optional().describe("Text to type."),
    key: z.string().optional().describe("Key spec for key, e.g. Return, ctrl+s, alt+Tab."),
    amount: z.number().int().min(-20).max(20).optional().describe("Scroll clicks; negative scrolls up."),
    display: z.number().int().min(1).max(9).default(DEFAULT_DISPLAY),
  })
  .strict();

const adminInput = z
  .object({
    action: z
      .enum(["status", "setup", "wake", "screen", "screen_off", "manifest_list", "manifest_install", "snapshot", "rebuild", "list_distros", "use_distro"])
      .describe("status: availability, storage, leases. setup: provision the computer. wake: arrive at your machine — boots the desktop, stamps the task on the wallpaper, returns a boot report WITH your ~/MACHINE.md notes (start real work sessions with this). screen: start the watchable screen and return its URL. screen_off: stop streaming when nobody is watching. manifest_*: rebuild-surviving packages. snapshot: full-image export. rebuild: fresh OS, same home. list_distros / use_distro: see or switch which WSL Linux acts as the computer."),
    package: z.string().optional().describe("Debian package name for manifest_install."),
    distro: z.string().optional().describe("WSL distro name for use_distro — adopt an existing Linux install as the computer."),
    task: z.string().optional().describe("wake: what you're about to work on — stamped onto the wallpaper so the screen narrates itself."),
    view_only: z.boolean().default(false).describe("screen: open in watch mode (no input)."),
  })
  .strict();

export interface AgentComputerToolsOptions {
  sandbox?: WslSandbox;
}

/** The AgentComputer toolset. Registered ALONGSIDE host tools (both live; the
 *  target is named by which tool is called). Windows-only for now (WSL2). */
export function makeAgentComputerTools(options: AgentComputerToolsOptions = {}): Tool<z.ZodTypeAny, unknown>[] {
  const box = options.sandbox ?? getAgentComputer();

  const computerExec = buildTool({
    name: "ComputerExec",
    description:
      "Run a shell command on YOUR OWN COMPUTER — a real Debian (systemd, apt, your home) separate from the owner's machine. " +
      "Files, installs, and browser logins persist there; nothing touches the host. Install tools freely (record keepers via ComputerAdmin manifest_install so they survive OS rebuilds). " +
      "Your memory lives there too: ~/MACHINE.md holds what you've learned about the box (extend it when you learn something the hard way), " +
      "~/.local/bin is on PATH — save reusable procedures there as scripts instead of re-deriving them. " +
      "GUI input from the shell is refused — use ComputerDesktop for the visible hand, ComputerBrowser for web work, ComputerHandoff for things only the owner may do.",
    safety: "workspace-write",
    concurrency: "parallel-safe",
    watchdogTimeoutMs: 0,
    inputZod: execInput,
    activityDescription: (i) => `Computer: ${i.description || i.command.slice(0, 60)}`,
    async validateInput(i) {
      const refusal = guiInputRefusal(i.command);
      return refusal ? { ok: false, message: refusal } : { ok: true };
    },
    async call(i): Promise<ToolResult<ComputerExecOutput>> {
      const result = await box.exec(i.command, { timeoutMs: i.timeout, cwd: i.cwd });
      void appendJournal({ kind: "exec", detail: i.description || i.command.slice(0, 80), ok: result.exitCode === 0 && !result.timedOut });
      const display = result.timedOut
        ? `timed out after ${i.timeout}ms`
        : `exit ${result.exitCode}`;
      return {
        output: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: result.timedOut },
        display,
      };
    },
  });

  const computerFile = buildTool({
    name: "ComputerFile",
    description:
      "Read, write, or list files on the agent's own computer (the sandboxed Linux). Paths are Linux paths; " +
      `relative paths resolve under ${SANDBOX_HOME}. For host files use the normal Read/Write tools; to move a file between host and computer use ComputerTransfer.`,
    safety: "workspace-write",
    concurrency: "parallel-safe",
    inputZod: fileInput,
    dynamicSafety: (i) => (i.action === "write" ? "workspace-write" : "read-only") as SafetyClass,
    activityDescription: (i) => `Computer ${i.action}: ${i.path}`,
    async call(i): Promise<ToolResult<{ action: string; path: string; content?: string; entries?: string }>> {
      const absolute = box.resolveSandboxPath(i.path);
      if (i.action === "read") {
        const content = await box.readFile(absolute);
        return { output: { action: i.action, path: absolute, content }, display: `${content.length} chars` };
      }
      if (i.action === "write") {
        if (i.content === undefined) throw toolError("write requires content.");
        await box.writeFile(absolute, i.content);
        return { output: { action: i.action, path: absolute }, display: `wrote ${i.content.length} chars` };
      }
      const listed = await box.exec(`ls -la ${shellQuote(absolute)}`, { timeoutMs: 20_000 });
      if (listed.exitCode !== 0) throw toolError(`list failed: ${listed.stderr.slice(0, 300)}`);
      return { output: { action: i.action, path: absolute, entries: listed.stdout }, display: `listed ${absolute}` };
    },
  });

  const computerScreenshot = buildTool({
    name: "ComputerScreenshot",
    description:
      "Capture the agent computer's whole desktop (what a human at that machine would see). Read-only. " +
      "For a crisp shot of just the web page, prefer ComputerBrowser action \"screenshot\".",
    safety: "read-only",
    concurrency: "parallel-safe",
    inputZod: screenshotInput,
    activityDescription: (i) => `Computer desktop :${i.display}`,
    async call(i): Promise<ToolResult<{ display: number; note: string }>> {
      const data = await box.desktopScreenshot(i.display);
      return {
        output: { display: i.display, note: "desktop screenshot attached" },
        display: `captured :${i.display}`,
        images: [{ mediaType: "image/png", data }],
      };
    },
  });

  const computerBrowser = buildTool({
    name: "ComputerBrowser",
    description:
      "Drive the sandbox Chrome on the agent's own computer via page-level CDP — mouse-free, runs beside other work, " +
      "and attaches to the SAME Chrome the screen shows (logins persist across tasks). Actions: navigate, read (title/url/text), " +
      "click (CSS selector), type (selector + text), eval (page JS), screenshot (the page). " +
      "When a site demands 2FA/CAPTCHA/payment, STOP and call ComputerHandoff — never attempt those yourself.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: browserInput,
    dynamicSafety: (i) => (["read", "screenshot"].includes(i.action) ? "read-only" : "workspace-write") as SafetyClass,
    activityDescription: (i) => `Computer browser ${i.action}${i.url ? `: ${i.url.slice(0, 60)}` : i.selector ? `: ${i.selector.slice(0, 40)}` : ""}`,
    async call(i): Promise<ToolResult<Record<string, unknown>>> {
      if (i.action === "navigate") {
        if (!i.url) throw toolError("navigate requires url.");
        const page = await box.browserNavigate(i.url, i.display);
        void appendJournal({ kind: "browse", detail: page.title ? `${page.title} — ${page.url}`.slice(0, 110) : page.url.slice(0, 110), ok: true });
        return { output: { ...page }, display: `→ ${page.title || page.url}` };
      }
      if (i.action === "read") {
        const page = await box.browserRead(i.display);
        return { output: { ...page }, display: `${page.title || page.url} (${page.text.length} chars)` };
      }
      if (i.action === "click") {
        if (!i.selector) throw toolError("click requires selector.");
        const result = await box.browserClick(i.selector, i.display);
        if (result !== "clicked") throw toolError(`click: ${result} for selector ${i.selector}`);
        return { output: { result }, display: `clicked ${i.selector}` };
      }
      if (i.action === "type") {
        if (!i.selector || i.text === undefined) throw toolError("type requires selector and text.");
        const result = await box.browserType(i.selector, i.text, i.display);
        if (result !== "typed") throw toolError(`type: ${result} for selector ${i.selector}`);
        return { output: { result }, display: `typed into ${i.selector}` };
      }
      if (i.action === "eval") {
        if (!i.expression) throw toolError("eval requires expression.");
        const value = await box.browserEval(i.expression, i.display);
        return { output: { value: value.slice(0, 20_000) }, display: "evaluated" };
      }
      const data = await box.browserScreenshot(i.display);
      return {
        output: { note: "page screenshot attached" },
        display: "page captured",
        images: [{ mediaType: "image/png", data }],
      };
    },
  });

  const computerTransfer = buildTool({
    name: "ComputerTransfer",
    description:
      "Copy ONE file between the owner's machine and the agent's computer. The host side is gated by normal " +
      "path permissions (the sandbox side is free). to_computer: host → sandbox. to_host: sandbox → host.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: transferInput,
    activityDescription: (i) => `Transfer ${i.direction === "to_computer" ? "→ computer" : "→ host"}: ${path.basename(i.host_path)}`,
    async call(i, ctx): Promise<ToolResult<{ direction: string; host: string; computer: string; bytes: number }>> {
      const hostAccess = i.direction === "to_computer" ? "read" : "write";
      const hostPath = await resolveWorkspacePath(ctx, i.host_path, "host_path", hostAccess);
      const sandboxPath = box.resolveSandboxPath(i.computer_path);
      if (i.direction === "to_computer") {
        const bytes = (await fs.stat(hostPath)).size;
        await box.exec(`mkdir -p ${shellQuote(path.posix.dirname(sandboxPath))}`, { timeoutMs: 20_000 });
        await fs.copyFile(hostPath, box.uncPath(sandboxPath));
        void appendJournal({ kind: "transfer", detail: `${path.basename(hostPath)} → computer (${bytes} bytes)`, ok: true });
        return { output: { direction: i.direction, host: hostPath, computer: sandboxPath, bytes }, display: `${bytes} bytes → computer` };
      }
      await box.exec("true", { timeoutMs: 20_000 });
      await fs.mkdir(path.dirname(hostPath), { recursive: true });
      await fs.copyFile(box.uncPath(sandboxPath), hostPath);
      const bytes = (await fs.stat(hostPath)).size;
      void appendJournal({ kind: "transfer", detail: `${path.posix.basename(sandboxPath)} → host (${bytes} bytes)`, ok: true });
      return {
        output: { direction: i.direction, host: hostPath, computer: sandboxPath, bytes },
        display: `${bytes} bytes → host`,
        touchedFiles: [hostPath],
      };
    },
  });

  const computerHandoff = buildTool({
    name: "ComputerHandoff",
    description:
      "STOP and hand the agent computer's screen to the owner for something only they may do — 2FA codes, CAPTCHAs, " +
      "payments, credentials. Starts the watchable screen, releases the input lease, and waits for the owner to finish " +
      "and hand it back. Call this the moment such a wall appears; never attempt those actions yourself.",
    safety: "read-only",
    concurrency: "exclusive",
    watchdogTimeoutMs: 0,
    inputZod: handoffInput,
    activityDescription: (i) => `Hand the screen to the owner: ${i.reason.slice(0, 60)}`,
    async checkPermissions(i): Promise<PermissionDecision> {
      const { url } = await box.ensureScreen(i.display, false);
      box.releaseLease(i.display);
      box.acquireLease(i.display, "owner", i.reason);
      return {
        kind: "ask",
        prompt:
          `Ares needs you at its computer's screen: ${i.reason}\n` +
          `Open ${url} , do it there, then click Allow to hand the screen back (Deny cancels the task step).`,
        suggestion: "allow_once",
      };
    },
    async call(i): Promise<ToolResult<{ display: number; result: string }>> {
      // Reaching call() means the owner clicked Allow — the hand-back.
      box.releaseLease(i.display);
      box.acquireLease(i.display, "agent", "resumed after owner handoff");
      box.releaseLease(i.display);
      return {
        output: { display: i.display, result: "owner completed the handoff — screen is back; continue the task" },
        display: "screen handed back",
      };
    },
  });

  const computerDesktop = buildTool({
    name: "ComputerDesktop",
    description:
      "Move the mouse, click, type, or drag on the agent computer's DESKTOP — real pixel input, so the owner watching the screen sees the pointer move and act. " +
      "Use it for GUI apps (file manager, editors, installers) and for anything the browser tools cannot reach. " +
      "It takes the screen's input lease for the moment it runs, so it refuses while the owner is driving. " +
      "For web pages prefer ComputerBrowser (page-level, mouse-free, runs beside other work); this is the hand, not the highway.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: desktopInput,
    activityDescription: (i) =>
      `Computer desktop ${i.action}${i.x !== undefined ? ` @${i.x},${i.y}` : ""}${i.text ? `: ${i.text.slice(0, 30)}` : ""}`,
    async call(i): Promise<ToolResult<{ action: string; result: string }>> {
      const result = await box.desktopInput(i.action, {
        x: i.x, y: i.y, toX: i.to_x, toY: i.to_y,
        text: i.text, key: i.key, amount: i.amount, display: i.display,
      });
      void appendJournal({ kind: "desktop", detail: `${i.action}${i.text ? `: ${i.text.slice(0, 40)}` : i.key ? `: ${i.key}` : ""}`, ok: true });
      return { output: { action: i.action, result }, display: result };
    },
  });

  const computerAdmin = buildTool({
    name: "ComputerAdmin",
    description:
      "Manage YOUR OWN computer: wake (arrive — boots the desktop, stamps the task on the wallpaper, returns your ~/MACHINE.md notes; " +
      "start real work sessions with this), status (availability, leases, disk), setup (first-time provision — downloads a Debian rootfs " +
      "and installs the base kit), screen (start the watchable noVNC screen and return its URL for the owner) / screen_off (stop streaming), " +
      "manifest_list / manifest_install (packages that survive OS rebuilds), snapshot (full-image export), " +
      "rebuild (fresh OS, SAME home + logins, manifest replayed).",
    safety: "workspace-write",
    concurrency: "exclusive",
    watchdogTimeoutMs: 0,
    inputZod: adminInput,
    dynamicSafety: (i) =>
      (i.action === "status" || i.action === "manifest_list"
        ? "read-only"
        : i.action === "rebuild" || i.action === "snapshot"
          ? "external-state"
          : "workspace-write") as SafetyClass,
    activityDescription: (i) => `Computer ${i.action}`,
    async call(i): Promise<ToolResult<Record<string, unknown>>> {
      if (i.action === "status") {
        const status = await box.status();
        // Storage is reported HERE, instantly, so nobody ever needs to go
        // measure the disk to find out whether setup can proceed.
        const target = status.distroDir ?? (await chooseDistroDir()).dir;
        const free = await driveFreeBytes(path.parse(path.resolve(target)).root);
        return {
          output: {
            ...status,
            distro: await box.distroName(),
            plannedDir: target,
            freeSpace: free !== null ? formatGb(free) : "unknown",
          },
          display: status.provisioned
            ? `computer ready (${await box.distroName()})`
            : status.blocked === "vm-platform"
              ? "blocked: enable Virtual Machine Platform + reboot"
              : status.distroRegistered ? "registered, not provisioned" : "not set up",
        };
      }
      if (i.action === "list_distros") {
        const distros = await box.listDistros();
        const current = await box.distroName();
        return {
          output: { distros, current },
          display: `${distros.length} WSL distro(s); current: ${current}`,
        };
      }
      if (i.action === "use_distro") {
        if (!i.distro) throw toolError("use_distro requires distro (see list_distros).");
        const result = await box.adoptDistro(i.distro);
        return { output: { result }, display: result };
      }
      if (i.action === "setup") {
        const lines: string[] = [];
        const result = await box.setup((line) => lines.push(line));
        void appendJournal({ kind: "setup", detail: result.slice(0, 100), ok: true });
        return { output: { result, log: lines }, display: result };
      }
      if (i.action === "wake") {
        const report = await box.wake(i.task);
        return { output: { report }, display: i.task ? `awake — ${i.task.slice(0, 60)}` : "awake at the computer" };
      }
      if (i.action === "screen") {
        const screen = await box.ensureScreen(DEFAULT_DISPLAY, i.view_only);
        return {
          output: { url: screen.url, viewOnly: i.view_only },
          display: `screen at ${screen.url}`,
        };
      }
      if (i.action === "screen_off") {
        const result = await box.screenOff(DEFAULT_DISPLAY);
        return { output: { result }, display: result };
      }
      if (i.action === "manifest_list") {
        const manifest = await box.manifest();
        return { output: { ...manifest }, display: `${manifest.packages.length} manifest package(s)` };
      }
      if (i.action === "manifest_install") {
        if (!i.package) throw toolError("manifest_install requires package.");
        const result = await box.manifestInstall(i.package);
        void appendJournal({ kind: "install", detail: i.package, ok: true });
        return { output: { result }, display: result };
      }
      if (i.action === "snapshot") {
        const file = await box.snapshot();
        return { output: { file }, display: `snapshot: ${file}`, touchedFiles: [file] };
      }
      const lines: string[] = [];
      const result = await box.rebuild((line) => lines.push(line));
      void appendJournal({ kind: "rebuild", detail: result.slice(0, 100), ok: true });
      return { output: { result, log: lines }, display: result };
    },
  });

  return [
    computerExec,
    computerFile,
    computerScreenshot,
    computerBrowser,
    computerDesktop,
    computerTransfer,
    computerHandoff,
    computerAdmin,
  ] as Tool<z.ZodTypeAny, unknown>[];
}

/** Pull the single rootfs layer of the official Debian image from Docker Hub's
 *  registry (anonymous pull token). Debian images are one gzip layer — exactly
 *  a root filesystem tarball, which `wsl --import` accepts as-is. */
async function downloadDebianRootfsLayer(tag: string, target: string): Promise<void> {
  const tokenResponse = await fetch(
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/debian:pull",
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!tokenResponse.ok) throw new Error(`registry token: HTTP ${tokenResponse.status}`);
  const token = ((await tokenResponse.json()) as { token?: string }).token;
  if (!token) throw new Error("registry token response carried no token");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: [
      "application/vnd.docker.distribution.manifest.list.v2+json",
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
      "application/vnd.oci.image.manifest.v1+json",
    ].join(", "),
  };
  const base = "https://registry-1.docker.io/v2/library/debian";
  const indexResponse = await fetch(`${base}/manifests/${tag}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!indexResponse.ok) throw new Error(`manifest ${tag}: HTTP ${indexResponse.status}`);
  let manifest = (await indexResponse.json()) as {
    manifests?: Array<{ digest: string; platform?: { architecture?: string; os?: string } }>;
    layers?: Array<{ digest: string; size?: number }>;
  };
  if (Array.isArray(manifest.manifests)) {
    const amd64 = manifest.manifests.find((m) => m.platform?.architecture === "amd64" && m.platform?.os === "linux");
    if (!amd64) throw new Error(`no linux/amd64 manifest for debian:${tag}`);
    const leafResponse = await fetch(`${base}/manifests/${amd64.digest}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!leafResponse.ok) throw new Error(`leaf manifest: HTTP ${leafResponse.status}`);
    manifest = (await leafResponse.json()) as typeof manifest;
  }
  const layer = manifest.layers?.[0];
  if (!layer || manifest.layers!.length !== 1) {
    throw new Error(`debian:${tag} is not a single-layer image (${manifest.layers?.length ?? 0} layers)`);
  }
  const blobResponse = await fetch(`${base}/blobs/${layer.digest}`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "follow",
    signal: AbortSignal.timeout(600_000),
  });
  if (!blobResponse.ok || !blobResponse.body) throw new Error(`layer blob: HTTP ${blobResponse.status}`);
  await pipeline(Readable.fromWeb(blobResponse.body as never), createWriteStream(target));
  const size = (await fs.stat(target)).size;
  if (size < 5_000_000) throw new Error(`layer blob suspiciously small (${size} bytes)`);
}

// ── small helpers ────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
