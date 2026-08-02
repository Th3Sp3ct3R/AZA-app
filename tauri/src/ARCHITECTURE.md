# Ares Desktop UI Architecture

React 19 + Vite, spoken to by the daemon over an NDJSON stdio protocol
(bridged through the Rust shell). `App.tsx` is the shell; extracted modules
live beside it.

## Layout

| Path | What lives there |
| --- | --- |
| `state/events.ts` | The wire: `AresEvent` + view-model interfaces for every daemon event |
| `state/session.ts` | Session view-model: `Item`/`ToolStep`/`SessionVm`, the shared `nextKey` counter, `freshSession`, history/summary hydration |
| `state/foldEvent.ts` | THE transcript reducer — pure, no React. Every daemon event folds into a session VM here (tool cards, permission cards, notices) |
| `state/prefs.ts` | Prefs type, themes, localStorage persistence |
| `models/catalog.ts` | Model catalog data + `useModelCatalog` (per-provider discovery incl. OpenRouter cache) |
| `lib/format.ts`, `lib/markdown.ts` | Pure formatting + markdown-lite rendering |
| `voice/streamSpeech.ts` | Streaming-TTS sentence chunking |
| `newStyle.tsx` | Shared style context, springs, token-flow strip |
| `voice.ts` | TTS/STT engines, wake word |
| `LivingSurface.tsx`, `UpdateBanner.tsx`, `WhatsNew.tsx` | Standalone surfaces |
| `App.tsx` | The remaining shell (~8k lines): App() with daemon bridge + event ingestion, voice bus, forge/browser panel, pill mode, and the not-yet-extracted components |
| `styles.css` | ONE global stylesheet. **Order-sensitive** (theme + perf-lite overrides live at the bottom; `.ares[data-*]` specificity repairs are deliberate). Never alphabetize, dedupe, or split casually |

## Phase 2 (not yet done — extraction targets in App.tsx)

- Leaf components → `components/`: transcript family (ItemView, DiffCard,
  ToolGroup, MermaidDiagram…), settings family (Settings, ModelPicker,
  panes), fx (Flames), Composer, EmbeddedBrowser,
  Palette, RoutingPanel, HelmView, SkillDock, and friends.
- Feature hooks: useDaemon (single `listen()` subscription + a handler map
  for the ~70-case event switch), usePrefs, useVoiceBus, useForge,
  usePillMode, useOAuthCards.
- Rules learned from the map: keep ONE event subscription; `nextKey` must
  stay a single module counter; module-scope singletons (mermaid loader,
  spokenBuf refs, STT key) move with their consumer; the root div's
  data-attributes/CSS vars stay in App().

## Verify

`npx tsc --noEmit -p tsconfig.json` and `npx vite build` in `tauri/`.
The daemon protocol is the API — event names/shapes come from
`packages/cli/src/entry/daemon.ts`; new daemon commands must be allowlisted
in `src-tauri/main.rs`.
