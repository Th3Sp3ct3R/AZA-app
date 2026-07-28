# Ares

**Ares** is a TypeScript-first autonomous + coding agent — *the battle-tested agent: it proves what it learns*. It pairs a streaming, multi-provider engine (Anthropic, OpenAI, Ollama Cloud, OpenRouter, DeepSeek) with a tool runtime, a continuous verifier, a multi-session daemon, a persistent agent "mind," audited side-effect rails, real desktop control, and an optional Tauri desktop shell.

[![CI](https://github.com/clout2buy/Ares/actions/workflows/ci.yml/badge.svg)](https://github.com/clout2buy/Ares/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

> ⚠️ **Status: experimental dev harness.** Ares is under active development and is not production software. Interfaces, on-disk formats, and command names change without notice; the autonomy/effects surfaces are powerful and only partially hardened. Run it on machines and accounts you control, and read the safety notes below before granting it real-world reach.

The repository is a pnpm workspace. Source lives under `packages/`; the optional desktop companion lives under `tauri/`.

## What Ares is

- **A streaming agent engine** (`@ares/core`) — sessions, query loop, provider adapters, prompt caching, compaction, subagents, and a continuous verifier that refuses to let the model declare "done" while its own edits are red.
- **A tool runtime** (`@ares/tools`) — file/edit/search/shell tools plus real-world reach (deploy, payments, email) behind permission gates and a structured risk classifier.
- **A persistent mind** (`@ares/agent`, `@ares/mind`) — identity, bootstrap, living memory with optional semantic recall, heartbeat, dreaming/consolidation, and self-reflection.
- **Durable autonomy** (`@ares/operator`) — long-lived goals, a background control loop, a capability graph, and attention ranking that advance work across restarts.
- **A conscience layer** (`@ares/effects`) — every outward effect flows through one choke point: kill-switch → idempotency → simulate → irreversibility gate → budget → ledger, with human approval for staged actions.
- **The Garrison** (`@ares/garrison`) — an always-on localhost daemon: N concurrent sessions that outlive both clients and the daemon (rehydrated from rollout), a WebSocket gateway, and a scheduler.
- **A desktop shell** (`tauri/`) — a Tauri app that talks to the daemon, with the in-progress HELM UI.

## Quick start

Requires **Node 22+** and **pnpm 10+** (`corepack enable` will provision pnpm).

```bash
git clone https://github.com/clout2buy/Ares.git
cd Ares
pnpm install
pnpm build
pnpm test          # build + node --test
```

Install `ares` as a global command so it works from any terminal:

```powershell
pnpm install:cli   # Windows: builds, adds `ares` to your user PATH (open a new shell)
```

Then `ares` launches the agent anywhere — say **"connect telegram"** and it walks you
through setup conversationally (no env vars). The desktop `.exe` installer registers the
same `ares` command automatically using its bundled runtime, so the terminal and UI are
the same agent over the same encrypted `~/.ares` vault.

Or run the CLI straight from the workspace (no install; on Windows you can also use `.\ares.bat`):

```bash
pnpm ares help                          # list commands
pnpm ares chat --provider mock          # interactive terminal chat (no API key)
pnpm ares run --goal "fix failing tests"
pnpm ares doctor                        # provider/runtime health
pnpm ares garrison serve                # start the always-on daemon + gateway
pnpm ares attach                        # attach a thin client to the gateway
pnpm ares mind consolidate              # prune, dedupe, crystallize memory
pnpm ares operator add --goal "ship a feature"
```

Desktop shell (optional):

```bash
pnpm --filter ares-tauri dev            # run the Tauri app in dev
pnpm desktop:installer                  # build the .exe (bundles a self-contained
                                        # runtime + registers the `ares` CLI on PATH)
```

## Safety & secrets

- **API keys and runtime state live outside the repo.** The durable home is `~/.ares` (`%USERPROFILE%\.ares` on Windows). Provider keys are stored there **AES-256-GCM encrypted at rest**, never committed. Repo-local `.ares/`, package `dist/`, Tauri build output, and screenshots are git-ignored. There are no secrets in this repository — verify before you fork.
- **Permission posture.** Interactive sessions run owner-local. Outward effects (shell, desktop control, deploy, payments, email, sending mail, credentials) pass through a structured gate: hard-blocked categories require explicit approval and are **denied outright when running unattended** (the background operator never autonomously moves money, leaks a credential, sends mail, or runs destructive shell). A kill switch halts all effects.
- **You are responsible for what you authorize.** Bypass/"unleashed" mode is a loud, audited, opt-in power-user choice. Treat desktop control and real-world connectors accordingly.

See `docs/DEVELOPMENT.md` for the full permission-mode and verification policy.

## Browser & CDP attach

Ares can drive a real browser. By default it launches a persistent-profile
Chrome/Edge under `~/.ares`. For logged-in sites, existing cookies, extensions,
and fewer anti-bot faceplants, point it at a **real running browser** over the
Chrome DevTools Protocol instead:

```bash
# Start Chrome (or Edge) with remote debugging on a profile of your choice:
chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.ares\cdp-profile"
# msedge.exe takes the same flags.

# Then tell Ares to attach:
set ARES_BROWSER_CDP_URL=http://127.0.0.1:9222   # Windows (PowerShell: $env:ARES_BROWSER_CDP_URL="...")
export ARES_BROWSER_CDP_URL=http://127.0.0.1:9222 # macOS/Linux
```

Launch-strategy order: configured CDP endpoint → localhost discovery →
detected Edge/Chrome exe (persistent `~/.ares` profile) → msedge channel →
chrome channel → bundled Chromium.

- `ARES_BROWSER_CDP_URL` — explicit endpoint, tried first. If it's unreachable,
  Ares falls back to launching its own browser.
- Local CDP discovery is on by default for `127.0.0.1:9222`; set
  `ARES_BROWSER_CDP_DISCOVERY=0` to disable it, or override probe ports with
  `ARES_BROWSER_CDP_PORTS=9222,9223`.

Use Browser `handshake` when attachment—not fallback—is required. It probes the
explicit/discovered CDP endpoint and fails if it cannot attach; it never quietly
launches a different profile. Chrome 136+ intentionally ignores remote-debugging
flags against the default Chrome profile, so use Ares's separate persistent
browser profile. Controlling arbitrary tabs in a normally launched default
profile requires an explicitly installed extension bridge; Ares does not bypass
that browser security boundary.

For an opt-in real-browser acceptance pass against Expand Testing's public
automation practice site, run `ARES_LIVE_BROWSER_HARNESS=1 pnpm test` (PowerShell:
`$env:ARES_LIVE_BROWSER_HARNESS="1"; pnpm test`).

> ⚠️ **CDP attach gives Ares control of that browser session** — every tab,
> cookie, and logged-in account in the profile you exposed. Use a dedicated
> `--user-data-dir` for anything sensitive, and remember the debugging port is
> unauthenticated to anything that can reach `127.0.0.1`.

## Packages

- `@ares/protocol` — shared event, provider, reasoning, and tool-call shapes.
- `@ares/core` — sessions, query engine, providers, checkpoints, subagents, verifier, hooks.
- `@ares/tools` — local tool catalog and executors.
- `@ares/agent` — identity, bootstrap, recall, heartbeat, dreaming, skills, self-reflection.
- `@ares/mind` — living memory, cognition, intent classification, diagnostics.
- `@ares/operator` — durable goals, control loop, capability graph, acquisition, attention.
- `@ares/effects` — budgets, ledger, kill switch, approval queue, side-effect rails.
- `@ares/connectors` — browser connector, browser effects, filmstrip proof.
- `@ares/garrison` — the always-on daemon (sessions, gateway, scheduler).
- `@ares/channels` — channel bridges as gateway clients (Telegram).
- `@ares/cli` — command-line and terminal UI entrypoint.

## Repository layout

```text
docs/                 Project docs and roadmap specs
packages/             Workspace packages
tauri/                Optional desktop companion (Tauri + React)
tests/                Node test suite (node --test)
```

## Development

```bash
pnpm lint      # TypeScript project check (tsc -b)
pnpm test      # build + node --test tests/*.test.mjs
pnpm verify    # check + test
pnpm clean     # remove generated build/log artifacts
```

For the Rust desktop shell:

```bash
cargo build --manifest-path tauri/src-tauri/Cargo.toml
cargo test  --manifest-path tauri/src-tauri/Cargo.toml
```

The quality rule: changes are backed by focused tests and reality checks. A clean build is not proof of user-facing behavior — verify commands, files, HTTP probes, browser state, or logs as appropriate.

## Roadmap

Near-term focus (see `docs/roadmap/` for the full specs):

- **Browser / CDP** — ship the Playwright runtime inside the Tauri bundle, attach to a real Chrome over CDP, persistent profiles/logins, and browser screenshots that actually reach a vision model.
- **Semantic memory** — graduate optional embedding-backed recall to the default, retire the legacy vector store, schedule consolidation.
- **Garrison** — broaden the gateway (approvals surface, per-session queuing, interrupt/steer routing) and the autonomy lifecycle.
- **HELM UI** — the desktop rewrite: shared-element session morph, append-only stream rendering, a live settings command-surface, and a tool-progress strip.

## License

[GNU AGPL-3.0-only](LICENSE). If you run a modified version of Ares as a network service, the AGPL requires you to offer your users the corresponding source.
