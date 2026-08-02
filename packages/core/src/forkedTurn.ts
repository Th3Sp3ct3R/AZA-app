// runForkedTurn — the ONE way to spawn a child run of the agent loop.
//
// Every autonomous driver (subagents, the operator dispatcher, and — later —
// Consciousness actions and Telegram missions) re-enters the SAME QueryEngine
// through here instead of hand-rolling `new QueryEngine + appendUserMessage +
// streamTurn`. Collapsing those duplicate drivers onto one primitive centralizes
// the two invariants that MUST hold for every fork:
//   1. a FRESH, empty fileReadStamps map — a child's Reads must never poison the
//      parent's re-read guard or grant it write-before-read on files the parent
//      never inspected (this is why the option type omits fileReadStamps: the
//      caller cannot pass one);
//   2. a goal/work-item seed by default (not a faked chat turn) so chat-only
//      consumers can tell autonomous work from a real user message.
// The child inherits every loop guard for free — watchdog, oscillation/ceiling/
// stall detection, the identity anchor, microcompact, and result spill.

import type { ContentBlock, Message, TurnEndStatus, TurnEvent, Usage } from "@ares/protocol";
import { QueryEngine, type QueryEngineConfig } from "./queryEngine.js";

export type ForkedTurnSeed =
  | { kind: "work-item"; text: string }
  | { kind: "chat"; text: string }
  | { kind: "content"; content: ContentBlock[] };

export interface ForkedTurnOptions {
  /**
   * Child engine config. `fileReadStamps` is intentionally OMITTED — every fork
   * gets a fresh empty map, set here and never by the caller, so read-stamp
   * isolation can't be accidentally broken at a call site.
   */
  config: Omit<QueryEngineConfig, "fileReadStamps">;
  sessionId: string;
  /** What seeds the turn. Defaults to a tagged work-item (autonomous), not chat. */
  seed: ForkedTurnSeed;
  /** Live per-event hook — e.g. surfacing a subagent's tool activity to the parent UI. */
  onEvent?: (event: TurnEvent) => void;
}

export interface ForkedTurnResult {
  /** The child engine, for callers that need its full history(). */
  engine: QueryEngine;
  /** Every TurnEvent the run emitted, in order. */
  events: TurnEvent[];
  history: readonly Message[];
  /** Concatenated text_delta across the run (operator step verdict reads this). */
  streamedText: string;
  /** Text of the last assistant message — the canonical answer/summary. */
  finalText: string;
  usage: Usage;
  status: TurnEndStatus;
}

export async function runForkedTurn(opts: ForkedTurnOptions): Promise<ForkedTurnResult> {
  // Child engines survive a permission denial: the denied tool call becomes an
  // ordinary error result the model routes around, instead of interrupting the
  // whole fork — one denied out-of-workspace Glob used to kill a 5-agent
  // researcher fleet with zero output (bug 96ca5473). Callers can override.
  const engine = new QueryEngine({ permissionDenialInterrupts: false, ...opts.config, fileReadStamps: new Map() }, opts.sessionId);

  switch (opts.seed.kind) {
    case "content":
      engine.appendUserMessageContent(opts.seed.content);
      break;
    case "chat":
      engine.appendUserMessage(opts.seed.text);
      break;
    case "work-item":
      engine.appendWorkItem(opts.seed.text);
      break;
  }

  const events: TurnEvent[] = [];
  let streamedText = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let status: TurnEndStatus = "completed";
  try {
    for await (const event of engine.streamTurn()) {
      events.push(event);
      opts.onEvent?.(event);
      if (event.type === "text_delta") streamedText += event.text;
      else if (event.type === "turn_end") {
        usage = event.usage;
        status = event.status;
      } else if (event.type === "error") {
        status = "failed";
      }
    }
  } catch {
    // A throw out of the loop is a failed fork, never a crash of the parent driver.
    status = "failed";
  }

  const history = engine.history();
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const finalText = lastAssistant
    ? lastAssistant.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim()
    : "";

  return { engine, events, history, streamedText, finalText, usage, status };
}
