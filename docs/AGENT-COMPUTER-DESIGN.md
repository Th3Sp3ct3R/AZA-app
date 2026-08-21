# The Agent's Own Computer — design spec

Status: BUILT and FIELD-VERIFIED 2026-08-19 (all three phases; see
"Implementation" below). The owner drove the live desktop — Thunar, a
terminal, Chromium — over the noVNC screen. The shared-login symlink store is
deliberately deferred until two user-facing agents exist on one machine (the
sidebar-agents work in AGENT-SOCIETY-DESIGN.md).

Five things only a live run could teach, all fixed in the implementation:
1. **Chromium needs `--no-sandbox` inside WSL** — its own namespace sandbox
   cannot initialize, and it dies instantly without it. WSL *is* the sandbox.
   No GPU behind Xvfb either, so software GL is forced.
2. **`pgrep -f` self-matches.** Every liveness probe ran inside
   `bash -lc "<the whole command>"`, whose own cmdline CONTAINS the pattern —
   so every service read as "already running" while nothing ever launched.
   All probes are now the real thing: the X socket, the CDP endpoint, TCP ports.
3. **Background children are reaped** when the launching `wsl.exe` command
   exits. Long-lived services need `setsid` + `</dev/null`.
4. **WSLg exports Wayland env vars into every shell**, so `x11vnc` (and
   `xfce4-session`) announce "Wayland session — exiting" even when pointed at
   a plain Xvfb display. They launch with those variables stripped.
5. **A viewport is not a desktop.** With only a browser on a bare X root, the
   owner closed the browser window and saw *black*. The machine now runs a
   real XFCE session — window manager, panel, file manager, terminal, a
   generated wallpaper — so it reads as a computer, not a canvas. Also:
   killed Chrome leaves stale `Singleton*` profile locks that silently block
   the next launch, and a hard kill leaves a "Restore pages?" bubble.

Implementation map:
- `packages/tools/src/AgentComputer.ts` — WslSandbox manager + the 7 tools
  (ComputerExec / File / Screenshot / Browser / Transfer / Handoff / Admin),
  registered win32-only in `packages/cli/src/entry/engineTools.ts`.
- Daemon commands `computer_status` / `computer_setup` / `computer_screen`
  (`packages/cli/src/entry/daemon.ts`), allow-listed in `tauri/src-tauri/src/main.rs`,
  UI chip + events in `tauri/src/App.tsx` (footer, next to garrison).
- CLI: `ares computer status|setup|screen|exec|snapshot|rebuild`
  (`packages/cli/src/entry/computerCmd.ts`).
- Tests: `tests/agent-computer.test.mjs` (scripted fake wsl.exe).

Source: field study of xAI's Grok Bot desktop app
(2026-08-19), including its agent's own description of its runtime, verified by
it against its live machine. Treat the Grok details as *design intelligence*,
not gospel — but the shape held up under questioning and matches what we'd
derive independently.

## Why

Ares's ComputerUse drives the OWNER's machine. That is why it is gated,
premium, and permission-heavy — every click is on real state. An agent-owned
sandbox inverts the trade: long-running, login-requiring, mistake-tolerant
autonomy moves to a machine where nothing needs a prompt, and the owner's
Windows box stays what it already is — a second, guarded channel. We keep
Ares's edge (real local coding, fleets, the owner's repos) and add the thing
Grok Bot leads with.

The one-sentence mental model (Grok's, and correct):
**the chat is the control plane; the computer is a tool target; the model
never becomes the computer — it calls it.**

## Architecture

- Engine unchanged. queryEngine's tool loop IS the wire. The sandbox arrives
  as a new toolset (`AgentComputer`), not a new engine mode.
- **Both toolsets live at once; the target is named on the call.** No
  host-vs-sandbox session flag — real work uses both in one turn (pull a file
  off the host, work in the sandbox, copy the result back). A flag is too
  coarse. Host-side calls keep their existing permission gates; sandbox calls
  don't need them. (Grok patch #1.)
- Sandbox: headless Debian under **WSL2** (not Docker Desktop — keeps the
  installer story clean for external users; WSL2 can run Xvfb, VNC, and Chrome
  fine). A dedicated distro, e.g. `ares-computer`.
- Persistence contract: **the OS is disposable, /home is forever.**
  "Update the computer" = replace the distro image, keep the home volume
  (tar export/import of /home, or a separately mounted VHDX). Files, installs
  recorded in a manifest, and browser logins survive.
- The owner's real machine remains a SECOND permissioned channel — including
  file copy in/out of the sandbox, which is a host-side, gated operation.

## Displays and browsers (the part we'd have gotten wrong)

Verified Grok behavior, adopt as-is:

- **Displays are per user-facing agent, not per nested worker.** A background
  worker shares its parent agent's screen and takes the lease. Per-worker Xvfb
  would pay for desktops nobody watches and make the "look, it's working" pane
  meaningless. N Chromes only when N agents have a reason to be on screen.
  (Grok patch #3.)
- Per-agent **Xvfb display** (1280×800) — Chrome's single-instance rule steals
  windows onto the first display otherwise. One machine, N displays, N Chrome
  processes, one login session.
- Per-agent Chrome profile (profile lock demands it), with the **cookie and
  saved-password SQLite files symlinked into a shared store** so a login done
  once sticks for every agent. Local Storage stays per-agent — leveldb will
  not share. Sites that live on localStorage tokens will need per-agent
  sign-in; that is acceptable.
- **Screen ownership:** clicks/keystrokes belong to a desktop driver, and only
  one driver may own a display at a time (per-display lease/mutex).
- **Browser work prefers page-level CDP** — it does not take the mouse, so it
  runs concurrently with other work on the same machine.
- **Playwright rides the display's Chrome, never its own.** Reuse the existing
  Playwright stack via `connectOverCDP` into the Chrome that already owns the
  display; a Playwright-launched second browser splits the session from the
  VNC pane and the screenshots, and the login story falls apart. WebFetch
  stays what it is — no JS, no cookies, public pages — and does NOT run
  inside the sandbox Chrome. (Grok patch #2.)
- **exec may not drive the GUI.** No xdotool-from-shell fake clicks. Input
  goes through the desktop driver tool or not at all — this keeps the lease
  meaningful and the audit trail honest.

## Action API (tool surface)

Phase 1 set:

| Tool | Notes |
|---|---|
| `computer_exec` | shell in the sandbox; direct; no GUI input allowed |
| `computer_fs` | read/write/list under the sandbox home |
| `computer_screenshot` | read-only capture of a named display |
| `computer_cdp` | page-level browser control (navigate/read/click-by-node); mouse-free |

Phase 2/3 additions: `computer_desktop` (click/type under a display lease),
`computer_transfer` (host⇄sandbox copy, permissioned on the host side),
snapshot/reset.

## The watchable, grabbable screen

- Stream the desktop into an Ares pane VNC-style (noVNC embeds in the webview;
  we already did CDP live-streaming and the garrison /view page — same
  plumbing pattern).
- The stream is **writable**; "watch" vs "drive" is a product mode on top.
- **Handoff protocol** for 2FA / CAPTCHA / payments: the agent STOPS, the
  owner gets the desktop with an explicit "hand it back" control, then the
  agent continues. This slots perfectly into Ares's existing doctrine — Ares
  never handles credentials or CAPTCHAs itself; now it has somewhere to hand
  them.
- Proof-by-screenshot: the agent posting its own desktop into chat is the
  cheapest trust move in the product. The GUI screenshot gate extends to the
  sandbox unchanged.

## Second field round (v0.42.0) — what the owner hit next

1. **Storage default was the bug behind an 8-minute stall.** The machine
   defaulted under ARES_HOME, i.e. C:. On a box with 9.9 GB free there, the
   agent correctly reasoned "I need space before I can install" and spent
   **437 seconds in one command recursively sizing C:\\** before setup could
   start. Storage is now chosen by free space (roomiest fixed drive when the
   home drive is tight), refuses below ~8 GB with the exact fix, and
   `ComputerAdmin status` reports free space instantly — so nobody ever has
   to go measure a disk to answer "can this install?". The prompt also states
   that "set up your computer" is ONE call and forbids drive-wide scans.
2. **The distro is swappable.** `list_distros` / `use_distro` (and
   `ares computer distros|use`) adopt any registered WSL Linux — a custom
   Debian, an existing Ubuntu — instead of importing ours. Adopted machines
   reprovision on rebuild rather than being replaced.
3. **Sandbox-only mode.** A footer chip (and `ares computer mode sandbox`)
   confines Ares to its own machine: host shells, host GUI control, and host
   file writes are WITHHELD from the toolset, not merely discouraged — a
   prompt rule is not a boundary. Host reads stay; ComputerTransfer remains
   the sanctioned bridge. Flipping it on with no machine yet starts setup in
   the same gesture.
4. **The lag was self-inflicted.** `-noxdamage` made x11vnc poll the entire
   framebuffer every pass. Damage tracking is on now, with `-threads` and
   deferred updates. `-ncache` is deliberately NOT used: it grows the
   framebuffer vertically and noVNC renders that raw, which returned the
   desktop as a tall garbled stack.
5. **The invisible worker.** CDP never moves a pointer, so the owner watched
   results appear with no mouse — work that looks like magic reads as work
   that might not have happened. Two fixes: `-cursor most -cursorpos` draws
   the real pointer into the stream, and **ComputerDesktop** (xdotool behind
   the display lease) gives Ares a visible hand for GUI work, moving before
   it clicks so the motion is legible. Browser clicks also flash a marker at
   the element. exec is still forbidden from faking input, so this remains
   the single sanctioned input path.

## Third round (v0.43.0) — the machine becomes a PLACE, not an API

The under-use had one root: the model had no standing awareness it OWNED a
machine. Eight tool names in a schema are not a computer; a place you know,
remember, and return to is. Five moves close it:

1. **The machine card.** Every system prompt now carries a standing block
   (`machineCardPromptBlock`, mtime+length-cached, sync — prompt composition
   never awaits disk): distro, disk, uptime, where the browser sits, the last
   three deeds from the journal, and the routing rule. Unprovisioned machines
   get one pitch line instead — discovery without nagging. Facts refresh
   opportunistically: every `status()` call (the UI chip polls it), every
   browser navigate, every wake.
2. **The machine remembers itself.** `~/MACHINE.md` is seeded at provision as
   the machine's own memory file — the agent reads it on wake and extends it
   when it learns the box the hard way. `~/.local/bin` (on PATH) is the
   skills dir: worked-out procedures become scripts, not re-derivations. A
   host-side journal (`~/.ares/computer/journal.jsonl`, capped at 400 lines)
   records every exec/browse/desktop/transfer/install deed and is mirrored
   into the box on wake so the agent can grep its own past from inside.
3. **A real Debian.** Provision v2 installs systemd (+sysv, +libpam) and flips
   `wsl.conf` to `systemd=true` — ONLY after the packages provably landed; a
   boot flag pointing at a missing init would brick the distro. systemctl,
   journalctl and timers now answer, so the model's generic Linux knowledge is
   true on its own computer. Locale is generated (kills the apt/perl warning
   spam), a resident CLI toolkit lands (htop, jq, ripgrep, nano…), and the
   distro VHD is set sparse (`wsl --manage --set-sparse true`, best-effort) so
   deleted files give disk back to the host.
4. **The wake ritual.** `ComputerAdmin "wake"` (and `ares computer wake`) is
   the arrival: boots the desktop, stamps the current task + timestamp onto
   the wallpaper (every screenshot becomes self-documenting proof), syncs the
   journal into the box, and returns a boot report that INCLUDES MACHINE.md —
   one call leaves the agent standing at its machine already briefed.
5. **The rest of the lag was cosmetic physics.** xfwm4 compositing OFF
   (shadows/fades force whole-window damage x11vnc must re-encode), x11vnc
   `-nap` (naps when the screen is idle), noVNC `quality=6&compression=1`
   (the felt lag was JS decode + canvas blit in the webview, not bandwidth),
   Chromium `--disable-smooth-scrolling` (a wheel tick is one damage event,
   not thirty), and `screen_off` to stop paying for an audience of zero.

Routing doctrine now rides in the card: installs, downloads, scrapes,
untrusted code, and browser logins belong on the agent's machine; the owner's
machine is for their repos and apps. When the owner is watching, prefer the
visible hand (ComputerDesktop) over invisible CDP.

Four more live-only lessons from this round (all fixed in the implementation):

- **systemd splits the D-Bus world.** Login shells now export the USER bus
  (`/run/user/…/bus`), but xfconfd/xfdesktop live on the SESSION bus that
  dbus-launch created — so `xfdesktop --reload` answered "xfdesktop is not
  running" while it ran in plain sight, and xfconf writes landed in a parallel
  xfconfd nobody read. Fix: resolve the real bus off the running process's
  `/proc/<pid>/environ` (via `xargs -0`, which needs no escape sequences).
- **`xfdesktop --reload` does not re-read a same-path image.** The wallpaper
  stamp alternates between two files and flips the xfconf `last-image`
  property — a property CHANGE always repaints.
- **Screenshots were silently truncated to corruption.** The exec output cap
  (60k chars) ate every desktop PNG's base64 (~100-800k). Screenshot paths
  now carry their own cap.
- **A `void`'d write races CLI process exit.** Fire-and-forget journal/facts
  appends vanished when `ares computer wake` exited before the promise
  settled. Ritual paths await their bookkeeping.
- (And a meta-lesson that earns a rule: complex bash for the sandbox goes in
  a generated script FILE, not an inline `bash -lc` string — three quoting
  layers deep is where a `\0` becomes a real NUL byte and spawn refuses the
  whole command.)

## Boundaries that are doctrine, not detail

- **Per-owner sandbox.** Garrison/Telegram users never share a cookie store —
  one sandbox per owner identity, full stop. (Grok patch #4.)
- **The OS is disposable and we don't pretend otherwise.** A reinstall
  manifest (packages re-applied on rebuild) is a real upgrade over Grok's
  throw-away-and-hope, but home + logins are the only durable surface.

## Phases

1. **Headless learner.** WSL2 distro + exec/fs/screenshot/CDP, ONE display,
   ONE Chrome, persistent home. Both toolsets live, target named per call.
   The symlink login-store trick WAITS until two user-facing agents actually
   exist on the machine. This is enough to learn everything else against.
   *(Shipped with a full XFCE session on the display — see finding 5 above:
   a machine whose screen goes black when one app closes does not read as a
   computer, and the owner cannot use the handoff protocol on a black root.)*
2. **The pane.** noVNC stream in the desktop app, watch/drive toggle, the
   2FA handoff control, inline self-screenshots.
3. **Crew semantics.** Per-subagent displays, the shared login store
   (symlink trick), display leases, snapshot/reset ("fresh computer" button),
   distro-rebuild-keep-home updates.

## Open questions

- WSL2 availability/enablement UX on machines that never turned it on
  (installer detects, offers `wsl --install`, falls back to
  host-only ComputerUse).
- Multi-user: garrison/telegram sessions sharing one sandbox vs per-owner.
- Disk budget: Chrome + desktop in a distro ≈ 2–4 GB; home growth unbounded —
  needs the same ledger treatment as the session WAL.
- Whether Phase 1 should reuse the existing Playwright/WebFetch browser stack
  inside the sandbox instead of raw CDP plumbing.
