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

import type { ContentBlock, Message, TurnEndStatus, TurnEvent, Usage, WorkStatus } from "@ares/protocol";
import { QueryEngine, type QueryEngineConfig } from "./queryEngine.js";
import { projectMessagesFromKernel, Session } from "./session.js";
import { openWorkspaceSessionKernel } from "./sessionKernel/workspace.js";

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
  /** Stable logical input identity when the caller can replay one invocation. */
  inputId?: string;
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
  /** Proof-bearing work truth is independent from loop termination. */
  workStatus: WorkStatus;
}

export async function runForkedTurn(opts: ForkedTurnOptions): Promise<ForkedTurnResult> {
  // Child engines survive a permission denial: the denied tool call becomes an
  // ordinary error result the model routes around, instead of interrupting the
  // whole fork — one denied out-of-workspace Glob used to kill a 5-agent
  // researcher fleet with zero output (bug 96ca5473). Callers can override.
  const config = {
    permissionDenialInterrupts: false,
    ...opts.config,
    fileReadStamps: new Map(),
  };
  const requiresDurableHost = config.hookManager !== undefined || config.tools.some((tool) =>
    tool.schema.safety !== "read-only" || tool.mayHaveEffects === true
  );

  let engine: QueryEngine;
  let stream: AsyncGenerator<TurnEvent>;
  let durableWorkStatus: WorkStatus | undefined;
  if (requiresDurableHost) {
    // Compatibility callers used to be able to fork an effectful tool catalog
    // without providing a kernel. Do not revive that as an unledgered escape
    // hatch: lazily attach the target workspace's canonical store and execute
    // through the same hosted Session barriers as every production surface.
    const sessionKernel = await openWorkspaceSessionKernel(config.workspace);
    const restoredMessages = sessionKernel.getSession(opts.sessionId)
      ? projectMessagesFromKernel(sessionKernel, opts.sessionId)
      : [];
    const session = new Session({
      ...config,
      sessionId: opts.sessionId,
      sessionKernel,
      initialMessages: restoredMessages,
    });
    await session.waitForStartupRecovery();
    engine = session.engine;
    const canonical = sessionKernel.getSession(opts.sessionId);
    durableWorkStatus = canonical?.workOutcome === "pending"
      ? "unverified"
      : canonical?.workOutcome;
    stream = session.sendContent(forkSeedContent(opts.seed), {
      ...(opts.inputId ? { inputId: opts.inputId } : {}),
      source: opts.seed.kind === "work-item" ? "work-item" : "user-input",
    });
  } else {
    engine = new QueryEngine(config, opts.sessionId);
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
    stream = engine.streamTurn();
  }

  const events: TurnEvent[] = [];
  let streamedText = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let status: TurnEndStatus = "completed";
  let workStatus: WorkStatus = "not_applicable";
  try {
    for await (const event of stream) {
      events.push(event);
      opts.onEvent?.(event);
      if (event.type === "text_delta") streamedText += event.text;
      else if (event.type === "turn_end") {
        usage = event.usage;
        status = event.status;
        workStatus = event.workStatus ?? "not_applicable";
      } else if (event.type === "error") {
        status = "failed";
      }
    }
  } catch {
    // A throw out of the loop is a failed fork, never a crash of the parent driver.
    status = "failed";
  }

  if (events.every((event) => event.type !== "turn_end") && durableWorkStatus) {
    workStatus = durableWorkStatus;
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

  return { engine, events, history, streamedText, finalText, usage, status, workStatus };
}

function forkSeedContent(seed: ForkedTurnSeed): ContentBlock[] {
  return seed.kind === "content"
    ? seed.content.map((block) => ({ ...block }))
    : [{ type: "text", text: seed.text }];
}
