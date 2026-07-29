# The Mega Prompt — a ground-up personal coding agent

Copy everything below the line and send it to Ares (or any capable agent) from inside the target repo.

---

Build me a personal AI coding agent as a Windows desktop app, from the ground up, in THIS repo you're connected to. This is a long-term personal project: it starts as an elite coding agent and will grow into a general agent over time, so every architectural choice must leave room to grow. Work in phases, and after each phase: build it, run it, verify it actually works end to end, and commit. Never move to the next phase on top of something broken or unverified. Ask me at most a handful of questions up front if something truly blocks you — otherwise make strong, conventional choices and keep moving.

## What this is
A native-feeling desktop EXE (like Claude Code with a beautiful face): a chat window where I talk to a model that can actually DO things in a project folder — read, search, edit, write files, and run commands — with everything it does shown live in clean, collapsible tool cards. Provider is DeepSeek, using MY API key. Personal project, one user: me.

## Stack (use exactly this unless something is impossible)
- **Tauri v2** for the shell (small, fast EXE + installer + built-in updater), **React + TypeScript + Vite** for the UI. No Electron.
- All agent logic in TypeScript in a clean core module (`src/core/` or a workspace package), completely separate from the UI. The UI talks to the core only through a typed event stream. This separation is non-negotiable — it's what lets a CLI or other frontends exist later.
- DeepSeek via its OpenAI-compatible API (`https://api.deepseek.com`), streaming (SSE) always. Handle tool/function calling per their docs.
- No cloud services beyond the DeepSeek API. Everything else is local.

## Phase 1 — the spine (chat that streams)
- Tauri app boots to a single chat window. First run shows a polished onboarding screen: explain in one sentence what the app is, ask for the DeepSeek API key, and VALIDATE it live against the API (list models or a 1-token ping) with a clear success/failure state before letting me in. Store the key locally (encrypted or at minimum OS-scoped app data — never in the repo, never logged).
- Model picker in the header between the two DeepSeek models — `deepseek-chat` and `deepseek-reasoner` — as a clean toggle, with a one-line hint under each (fast everyday vs. deep thinking). Remember my choice.
- Streaming chat with markdown rendering (code blocks with syntax highlighting + a copy button). If the reasoner model emits reasoning content, render it as a collapsed "thinking…" section above the reply, not mixed into it.
- A **context meter** always visible: tokens used vs. the model's window (128K), as a subtle gauge that shifts color as it fills. Show per-model context correctly.
- Verify: I can enter a key, get it validated, pick a model, have a streamed conversation, and watch the context meter move. Commit.

## Phase 2 — hands (the tool loop, coding-first)
- Implement a proper agent loop: model requests tool calls → app executes them → results go back → repeat until the model answers. Parallel-safe, with a per-tool timeout and a hard cap on rounds per turn so it can never spin forever.
- Tools, minimal but excellent — each with a strict schema, workspace-rooted paths (NOTHING outside the project folder without me approving it), and truncated outputs so a huge file can't blow the context:
  - `read_file` (line-numbered, offset/limit), `write_file`, `edit_file` (exact string replace that FAILS loudly when the target text isn't found — never fuzzy-guess),
  - `list_dir` / `glob`, `grep` (ripgrep if available, else a JS fallback),
  - `run_command` (shell, cwd = workspace, streamed output, kill button, and my approval required for anything destructive or non-allowlisted).
- **Tool cards** in the transcript — this is where the app should feel great: each call renders as a compact card with an icon, a human title ("Read src/main.ts", "Ran pnpm test — 34 passed"), a live spinner while running, and a click-to-expand body showing exact input/output (diff view for edits). Errors show red with the actual message. Cards animate in smoothly; a dozen fast calls must read as a tidy timeline, not spam.
- System prompt that makes it a serious coding agent: workspace-aware (inject the folder tree, top-level README, detected package manager), edits over rewrites, verify-after-change (run the build/tests after editing when they exist), honest about failures, concise in chat.
- Verify: ask it to "add a --help flag to my CLI" in a real repo and watch it read → edit → run tests, with every step visible in cards. Commit.

## Phase 3 — a face worth shipping (design pass)
- One cohesive dark theme, designed, not defaulted: a near-black base, ONE accent color used sparingly (meter, active states, streaming cursor), one good font (Inter or Geist; JetBrains Mono for code), consistent 8px spacing rhythm, soft rounded corners, subtle borders instead of hard lines. Design tokens as CSS variables so I can retheme in one file.
- Motion everywhere it matters and nowhere else: messages fade+rise in, tool cards expand with a spring, the send button breathes while streaming, panel transitions ~150–250ms. Never let animation block input. Keep it 60fps — virtualize the transcript if long chats get heavy.
- The window is frameless with a custom titlebar (drag region, minimize/close), resizes responsively down to small widths without clipping, and remembers size/position.
- Quality-of-life: Enter to send / Shift+Enter newline, Esc to stop a streaming turn (abort cleanly, keep partial output), a stop button during turns, session list in a slim sidebar (rename/delete), sessions persisted to disk and restored on launch.
- Verify by USING it and screenshotting; iterate until it genuinely looks like a product you'd pay for. Commit.

## Phase 4 — ship it to myself (installer + auto-update). Do not skip this.
- Wire the **Tauri updater**: generate a signing keypair (tell me exactly what to back up and where), embed the public key, and set the updater endpoint to this repo's GitHub Releases `latest.json`.
- GitHub Actions workflow: pushing a version tag (`v*`) builds the signed Windows installer (NSIS `-setup.exe`), generates `latest.json` + signatures, and publishes a GitHub Release. Document the 3-step release ritual in the README (bump version → tag → push).
- In-app: check for updates on launch (and every few hours). When a new release exists, a polished non-blocking banner appears — version, one-line notes, an **Update now** button that downloads, verifies the signature, installs, and relaunches. One click, ease of access — this is how I'll consume every improvement I make.
- Verify FOR REAL: cut v0.1.0, install it, bump to v0.1.1, push the tag, and confirm the running app offers and completes the update. This must work before the project is "done".

## Phase 5 — the coding edge (make it actually good)
- Context management: when the conversation nears the model's window, summarize the oldest turns into a compact recap instead of dying; keep recent tool results intact; show a small "compacted" notice in the transcript. The context meter must reflect reality.
- Cost/usage line per turn (tokens in/out; DeepSeek prices) in a subtle footer.
- A `TODO.md`-style plan the agent maintains for multi-step tasks, rendered as a checklist panel that ticks live.
- Simple safety rails: an allowlist of always-OK commands (build/test/lint), approval dialogs for everything else, and a global "stop everything" that aborts tools + stream instantly.
- Round out with 15–20 unit tests on the core (tool schemas, edit-string failure cases, context budgeter, loop caps) wired into CI so a bad tag can't ship.

## The growth path (design for it now, build later)
Keep the tool registry, system prompt assembly, and provider client pluggable — later this gains: more providers, sub-agents, web search/fetch, MCP connectors, skills, voice. Don't build any of that now; just don't paint it into a corner (e.g., provider behind an interface, tools as self-describing modules, events as a typed union).

## Ground rules
- After EVERY phase: `build` clean, app launches, feature verified by actually driving it, then a descriptive commit. Small commits over hero commits.
- TypeScript strict; no `any` sprawl. Errors surface in the UI — nothing fails silently, ever. If a stream dies mid-turn, say so in the transcript and offer retry.
- The README always reflects reality: setup, dev, release, updater key backup.
- If a choice is 60/40, pick and note it in the commit message. If it's genuinely 50/50 and expensive to reverse, ask me.

Start with Phase 1 now. Give me a 5-line plan of what you're about to do first, then build.
