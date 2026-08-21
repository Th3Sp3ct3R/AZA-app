# Platform Support

What is **actually tested**, and by what. This page is deliberately narrow: it
covers installing and running the `ares` CLI from source. It makes no claim about
the desktop app, packaging, voice, or desktop control — those are tracked
separately and are not described here.

No entry below says "works on every Linux distribution". If a row is not in the
table, it has not been tested.

## CLI from source

The CI matrix is `ubuntu-latest` + `windows-latest`; the tests below run on both.

| Surface | Linux | macOS | Windows |
| --- | --- | --- | --- |
| `pnpm build`, `pnpm test` | covered by CI | not tested | covered by CI |
| Built CLI answers `ares help` through the installed launcher | covered by CI | not tested | n/a |
| POSIX launcher: install, reinstall, uninstall, refusals | covered by CI + manual run | not tested | n/a |
| `--help` on both scripts (no PowerShell handoff) | covered by CI | not tested | covered by CI |
| Windows dispatch to `scripts/install.ps1` | n/a | n/a | the dispatch decision is covered by CI; the PowerShell scripts themselves are unchanged and not newly tested |

**CPU architecture:** x86_64 only. Nothing here has been tested on aarch64.

**Manual run** of the install path: Fedora 44, x86_64, Node 24. Every POSIX
claim under [What `pnpm install:cli` does](#what-pnpm-installcli-does) was
exercised on that machine, always into a temporary prefix. Nothing about
Windows or macOS was:

- the destination chain, one level at a time — `--dir`, then
  `ARES_CLI_BIN_DIR`, then `$XDG_BIN_HOME`, then the `$HOME/.local/bin`
  default, confirming each beats the next and that only one file is written;
- `ares help` and `ares doctor` through the installed launcher, plus a
  `mock`-provider turn;
- reinstall over an existing launcher, compared byte for byte;
- the four refusals — a foreign regular file, a symlink, an unbuilt CLI, and
  uninstall against a file Ares did not write. The foreign file and the symlink
  were still intact afterwards;
- both fallbacks in the launcher: with `node` off PATH it used the absolute
  interpreter recorded at install time, and with that path made unreachable too
  it named both candidates on stderr and exited 127;
- uninstall twice — the second run reports nothing to remove and still exits 0;
- `pnpm test` in a redirected `HOME`: 1659 tests, 1655 passing, 4 skipped,
  matching the CI run.

One machine, one distribution, one run. That is the entire manual record; it is
not a statement that Fedora — or any release of it — is a supported platform.

**macOS** takes the same POSIX branch as Linux and is expected to behave
identically, but nothing exercises it — treat it as untested.

**Not covered by this page or this change:** the Tauri desktop app, AppImage /
`.deb` / RPM packaging, voice, browser detection, and desktop control. Nothing
here makes Fedora, Arch, or any distribution a supported target for those.

## What `pnpm install:cli` does

On Linux and macOS it writes a single `sh` launcher named `ares` and does
nothing else:

- **Destination**, most explicit first: `--dir <path>` → `ARES_CLI_BIN_DIR` →
  `$XDG_BIN_HOME` → `$HOME/.local/bin`. `XDG_BIN_HOME` is an optional override
  Ares honours; it is not part of the XDG Base Directory specification, though
  many tools have converged on it.
- **Never runs `sudo`,** and the default destination is a per-user directory.
  An explicit `--dir` or `ARES_CLI_BIN_DIR` may point anywhere the invoking
  user can write, including a shared directory — that is the caller's choice.
- **Your PATH and shell config are never modified.** If the destination is not
  already on PATH the installer says so and prints a line you can add yourself,
  with the directory single-quoted so a path containing spaces, quotes, or
  `$(...)` is safe to paste. The line is for POSIX shells (`sh`, `bash`,
  `zsh`); Fish uses different syntax and no Fish command is generated.
  Rewriting a shell profile behind the user's back is the least reversible
  thing an installer can do, so it does not happen.
- **Idempotent.** Re-running produces a byte-identical launcher; there is no
  second copy and no partial state.
- **It will not clobber a file it did not create.** If something else already
  occupies that path, install and uninstall both refuse and change nothing.
- **It requires a built CLI.** If `packages/cli/dist/entry.js` is missing it
  stops and tells you to run `pnpm build`, rather than installing a launcher
  that would fail at first use.
- The launcher prefers whatever `node` is on PATH, and falls back to the
  absolute interpreter that ran the installer. That fallback matters because a
  launcher started outside an interactive shell (a `.desktop` entry, a systemd
  unit) does not source your profile, so an nvm-managed `node` is not on its
  PATH. If neither is usable the launcher says so and exits 127.
- **It is tied to this checkout.** The launcher holds an absolute path to
  `packages/cli/dist/entry.js`, so moving or deleting the checkout breaks it.
  After a move, run `pnpm install:cli` again from the new location.

`pnpm uninstall:cli` removes that launcher and nothing else. The Ares home
(`~/.ares` — config, encrypted vault, sessions, memory, identity) is never read,
written, or deleted by either command.

On Windows, both commands hand off to the existing `scripts/install.ps1` and
`scripts/uninstall.ps1`. Their behavior is unchanged.

## System requirements

- **Node 22+** and **pnpm 10+** (the repo pins `pnpm@10.33.0`).
- A C/C++ toolchain if `better-sqlite3` has no prebuilt binary for your Node
  version — `pnpm install` compiles it from source in that case. Verified
  building on Node 24 with the toolchain a stock Fedora developer install
  already provides; no extra system packages were needed.
- `/bin/sh` — the generated launcher's shebang is `#!/bin/sh`, an absolute path,
  so a `sh` found only elsewhere on PATH will not do.

### Linux desktop extras

The desktop shell renders through WebKitGTK, which plays media through
GStreamer rather than bundling its own decoders. On a stock install without the
GStreamer plugin set, audio and video elements in the WebView fail at load with
`GStreamer element appsrc not found` and a run of `GST_IS_ELEMENT` assertion
failures. Everything else works; only in-WebView media is affected. Install the
usual plugin packages if you want it:

```bash
sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good   # Fedora
sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good  # Debian/Ubuntu
```

Reported on Fedora 44 / KDE Plasma on Wayland. Ares does not bundle these — a
media stack is the distribution's job, and shipping a second one is how you get
two broken ones.
