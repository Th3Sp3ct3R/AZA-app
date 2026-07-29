# Ares deep-overhaul roadmap

This roadmap turns the current collection of agent features into one coherent,
observable system. The order is deliberate: provider truth and session isolation
come before autonomy polish, because every higher layer depends on them.

## Phase 0 — provider truth and safe switching (implemented in this pass)

- Give every selection a canonical provider family independent of its HTTP
  adapter. DeepSeek-via-Anthropic remains DeepSeek; Ares-via-Anthropic remains
  Ares.
- Treat manual selection as a strict pin. Cross-provider failover is legal only
  when the owner explicitly enables Auto routing.
- Preflight DeepSeek credentials/models and Ollama reachability/model presence
  before changing a live session or persisted defaults.
- Change only the active session. Existing sibling sessions retain their own
  provider, model, history, and active turn.
- On a failed selection, keep the current model and return an actionable failure
  event to the UI instead of silently routing elsewhere.

Exit criteria: selecting a broken provider never spends another provider's key,
never changes a sibling chat, and never lies in the footer about what ran.

## Phase 1 — live capability and health registry

- Replace UI regexes and hardcoded assumptions with daemon-issued model
  capabilities: reasoning levels, vision, tools, context window, locality,
  availability, price, and endpoint class.
- Add a provider health state machine: unknown, probing, ready, degraded,
  unauthorized, out-of-credit, unavailable model, and offline.
- Refresh catalogs incrementally and remove stale cloud aliases. Ollama cards
  should distinguish pulled-local, available-cloud, pull-required, and missing.
- Show `Pinned`, `Auto`, and the actual resolved provider/model as separate UI
  concepts. Never overwrite the requested choice with transport-adapter names.
- Add an explicit “test connection” action that performs a zero-conversation
  probe and reports latency plus failure category.

## Phase 2 — hard multi-session isolation

- Move provider selection, abort controllers, permission grants, voice turn
  ownership, browser targets, and verifier state into a session-scoped runtime
  container.
- Give each background session its own event sequence number and reject stale or
  cross-session UI events.
- Separate “default for new chats” from “change this chat.” Make both actions
  visible instead of coupling them.
- Add concurrency stress tests: two coding turns, a model switch, a permission
  prompt, and an interrupt occurring simultaneously with no state bleed.
- Persist resumable session state atomically so a daemon restart cannot attach a
  transcript to the wrong provider or browser target.

## Phase 3 — low-token agent loop

- Keep one immutable system-prompt prefix per session and cache it; send only
  compact state deltas after each tool batch.
- Use task-scoped tool working sets and load schemas on demand rather than
  shipping the whole tool universe every round.
- Store large tool results as artifacts with short model-facing summaries and
  targeted retrieval handles.
- Add hierarchical history: recent verbatim turns, a verified working-state
  ledger, and archived detail fetched only when relevant.
- Surface fresh input, cache-read input, tool-schema overhead, and compaction
  savings separately. Add per-turn token budgets with warnings before runaway
  loops.
- Target: routine browser turns below 20k fresh input and medium coding tasks
  below 100k fresh input unless the user explicitly expands the budget.

## Phase 4 — browser-first autonomy

- Create one Browser Target Broker that attaches to existing tabs through CDP,
  opens a new tab only when required, and never falls back to the OS cursor for
  ordinary web work.
- Render the Ares cursor overlay in every attached target, not only tabs Ares
  created. Preserve the user's physical mouse at all times.
- Use a perception/action loop based on DOM/accessibility snapshots first,
  screenshots second, and native ComputerUse only for non-browser applications.
- Batch safe action sequences, verify semantic outcomes instead of taking a full
  screenshot after every click, and recover from layout shifts by re-resolving
  targets rather than replaying coordinates.
- Add ownership indicators: current tab, action, reason, and a one-click pause or
  take-over control.

## Phase 5 — real-time voice and desktop presence

- Replace record-stop-upload transcription with a persistent low-latency audio
  stream, local VAD, partial transcripts, and endpointing tuned for conversation.
- Keep one warm STT/TTS sidecar with health supervision, bounded restart backoff,
  and a visible diagnostic reason when unavailable.
- Stream speech by sentence/semantic clause from a durable queue. Tool activity
  must never truncate the current utterance or split words across responses.
- Treat captions, spoken response, and chat text as three consumers of one
  ordered response stream so they cannot drift.
- In pill mode, use a separate click-through desktop presence surface for edge
  pulse and captions; the pill remains small and only owns core controls.
- Measure wake-word-to-listening, speech-end-to-partial, speech-end-to-final, and
  first-audio latency. Target sub-250ms wake registration and sub-700ms useful
  partial transcription on supported hardware.

## Phase 6 — one Forge and a quieter shell

- Merge Preview, Live, Sandbox, and Hollow into one Forge surface with internal
  execution states rather than four competing tabs.
- Make the left command rail collapsible and remember its state per window.
- Keep one compact pill icon; remove taskbar-style minimize semantics and focus
  chrome that changes color simply because the window gained focus.
- Use a consistent motion system for message arrival, tool progress, model
  switching, errors, voice state, and session transitions.
- Hide internal reminders, verifier directives, and transport diagnostics from
  the transcript; expose them in a dedicated inspect panel when requested.

## Phase 7 — collision-free local infrastructure

- Replace fixed ports with an atomic port broker: bind port `0`, reserve the
  assigned socket, then hand ownership to the service without a probe/rebind
  race.
- Publish service endpoints through one runtime registry instead of environment
  folklore. Include daemon, garrison, browser bridge, voice, presence, and OAuth
  callback endpoints.
- Use per-install and per-session namespaces plus authenticated local IPC so two
  Ares builds can run without stealing each other's services.
- Add orphan detection and lease expiry instead of killing processes by broad
  name or port matches.

## Phase 8 — observability and release gates

- Add a local run timeline containing requested route, actual route, preflight,
  retries, tool latency, verifier decisions, voice latency, and token sources.
- Redact credentials at the event boundary and export a small diagnostic bundle
  instead of entire multi-hundred-megabyte transcripts.
- Ship chaos tests for provider outages, expired keys, port collisions, daemon
  restarts, dropped CDP targets, voice-sidecar crashes, and simultaneous chats.
- Gate releases on provider-contract tests, session-isolation stress tests,
  browser autonomy benchmarks, voice latency budgets, and token-cost ceilings.

## Recommended release slices

1. `0.27.1`: provider identity, strict pinning, preflight, active-session model
   switching, prompt visibility/token fixes, and reasoning controls.
2. `0.28`: capability registry, provider health UI, session isolation, and
   collision-free port broker.
3. `0.29`: browser target broker and browser-first autonomy.
4. `0.30`: streaming voice pipeline, desktop presence, and compact pill.
5. `1.0`: unified Forge, measured reliability gates, and stable diagnostics.
