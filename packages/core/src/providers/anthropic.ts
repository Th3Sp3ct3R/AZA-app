// Anthropic provider — Messages API v1, streaming SSE, prompt caching.
//
// Ares's wire protocol IS the Anthropic SDK message shape, so request
// translation is near-passthrough: system_reminder blocks render as
// <system-reminder> text, image sources rename their discriminants, and
// unsigned thinking blocks are dropped from replayed history (the API
// rejects thinking blocks without a valid signature).
//
// Prompt caching: cache_control {type:"ephemeral"} breakpoints on the
// LAST tool definition and the system block. Tools render before system
// in Anthropic's prefix, so these two breakpoints cache the full stable
// prefix — what makes a Crucible side-fork (sideQuery) cost cents.
//
// Auth: ARES_ANTHROPIC_API_KEY, then ANTHROPIC_API_KEY, or an injected
// {apiKey}. Fetch and endpoint are injectable for tests.
//
// SSE events handled:
//   message_start         (id + input/cache token usage)
//   content_block_start   (text | thinking | tool_use → tool_use_start)
//   content_block_delta   (text_delta | thinking_delta | input_json_delta | signature_delta)
//   content_block_stop    (tool_use → tool_use_input_done with parsed input)
//   message_delta         (stop_reason + output token usage)
//   message_stop          (assemble message_done)
//   ping                  (ignored)
//   error                 (terminal; overloaded/api errors are retriable)

import type {
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  Usage,
} from "@ares/protocol";
import { anthropicReasoningEffort, deepSeekReasoningEffort, reasoningEnabled, thinkingBudgetTokens } from "@ares/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";
import { createStallGuard, stallErrorEvent, type StallGuard } from "./stallGuard.js";
import { parseRetryAfterMs } from "./retryAfter.js";
import { coerceToolArgs, sanitizeToolPairs, toolResultsFirst, TOOL_ARGS_ERROR_KEY } from "./_toolPairs.js";
import {
  resolveAnthropicAccessToken,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_IDENTITY,
  ANTHROPIC_OAUTH_USER_AGENT,
  ANTHROPIC_OAUTH_X_APP,
} from "./anthropicAuth.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Default model for the "anthropic" router lane. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";

/** Model generations that take {type:"adaptive"} thinking (no token budgets). */
export function usesAdaptiveThinking(model: string): boolean {
  // Substring match: any model id CONTAINING "fable" routes to the adaptive
  // branch (covers fable-class ids); no capability lookup.
  return /fable|claude-fable/i.test(model);
}

/** Claude families with native adaptive thinking. */
export function usesNativeAdaptiveThinking(model: string): boolean {
  return /(?:fable|mythos)-?5|opus-4-[678]|sonnet-(?:4-6|5)/i.test(model);
}

/** Claude families with native output_config.effort support. */
export function supportsAnthropicEffort(model: string): boolean {
  return /(?:fable|mythos)-?5|opus-4-[5-8]|sonnet-(?:4-6|5)/i.test(model);
}

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export type AnthropicDialect = "anthropic" | "deepseek";

export interface AnthropicProviderOptions {
  /** Override the API key (tests / injected config). Falls back to
   *  ARES_ANTHROPIC_API_KEY, then ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override URL (tests / proxies). */
  endpointUrl?: string;
  /** Wire dialect. "deepseek" targets DeepSeek's Anthropic-compatible endpoint
   *  (https://api.deepseek.com/anthropic): echo UNSIGNED thinking (DeepSeek 400s
   *  on tool loops without the reasoning echo), send NO cache_control (ignored —
   *  DeepSeek auto KV-caches server-side), and enable thinking WITHOUT
   *  budget_tokens / max_tokens inflation (budget is ignored). Defaults to "anthropic". */
  dialect?: AnthropicDialect;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly fetchImpl: typeof fetch;
  private readonly overrideKey?: string;
  private readonly overrideUrl?: string;
  private readonly dialect: AnthropicDialect;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.overrideKey = opts.apiKey;
    this.overrideUrl = opts.endpointUrl;
    this.dialect = opts.dialect ?? "anthropic";
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const apiKey =
      this.overrideKey ||
      process.env.ARES_ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      "";
    // Prefer an explicit API key; otherwise fall back to a Claude subscription
    // OAuth token (Pro/Max). The two use different auth headers.
    const oauthToken = apiKey ? null : await resolveAnthropicAccessToken(this.fetchImpl);
    if (!apiKey && !oauthToken) {
      yield {
        type: "error",
        error: {
          code: "no_auth",
          // The desktop watches for "no_auth" + anthropic to prompt a browser sign-in.
          message: "Not signed in to Anthropic. Sign in with your Claude account, or set an API key.",
          retriable: false,
        },
      };
      return;
    }
    if (req.signal?.aborted) return;

    const url = this.overrideUrl ?? ANTHROPIC_MESSAGES_URL;
    const body = buildMessagesBody(req, this.dialect);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    // Opt-in beta flags (e.g. a long-context beta) without a code change:
    // ARES_ANTHROPIC_BETA="context-1m-..." — comma-merged with any auth beta.
    const extraBeta = (process.env.ARES_ANTHROPIC_BETA ?? "").trim();
    if (extraBeta) headers["anthropic-beta"] = extraBeta;
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    } else if (oauthToken) {
      headers["Authorization"] = `Bearer ${oauthToken}`;
      headers["anthropic-beta"] = extraBeta ? `${ANTHROPIC_OAUTH_BETA},${extraBeta}` : ANTHROPIC_OAUTH_BETA;
      headers["User-Agent"] = ANTHROPIC_OAUTH_USER_AGENT;
      headers["x-app"] = ANTHROPIC_OAUTH_X_APP;
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      const existingSystem = Array.isArray(body.system) ? body.system : [];
      // Block 0 stays byte-identical — it's the required OAuth contract string
      // (the token is rejected otherwise; see ares-anthropic.test.mjs). The
      // "Claude Code" identity leak is neutralized at the INSTRUCTION level by the
      // always-on identity anchor in composeAgentSystemPrompt, which explicitly
      // names "Claude Code" as a transport label, not the agent's name.
      body.system = [
        { type: "text", text: ANTHROPIC_OAUTH_IDENTITY },
        ...existingSystem,
      ];
    }

    // Stall watchdog: abort the fetch when no bytes arrive for the stall
    // window so a hung connection becomes a retriable error, not a freeze.
    const guard = createStallGuard(req.signal);
    let response: Response;
    let consumedErrorText: string | undefined;
    for (;;) {
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: guard.signal,
        });
      } catch (err) {
        guard.dispose();
        if (guard.stalled()) {
          yield stallErrorEvent();
          return;
        }
        if (req.signal?.aborted || isAbortError(err)) return;
        yield {
          type: "error",
          error: {
            code: "network_error",
            message: err instanceof Error ? err.message : String(err),
            retriable: true,
          },
        };
        return;
      }
      guard.reset();
      // Act-first forcing is best-effort: if THIS endpoint rejects tool_choice
      // (Anthropic disallows it with extended thinking; a compat layer may not
      // support it at all), strip it and retry once instead of failing the turn.
      if (!response.ok && response.status === 400 && body.tool_choice) {
        void response.text().catch(() => "");
        delete body.tool_choice;
        continue;
      }
      // Tactical thinking-skip is best-effort too: if the endpoint 400s when a
      // routine round omitted the thinking pass (e.g. it insists thinking stay
      // enabled once history carries thinking blocks), re-enable and retry once.
      if (
        !response.ok &&
        response.status === 400 &&
        this.dialect === "deepseek" &&
        body.thinking === undefined &&
        reasoningEnabled(req.reasoningLevel)
      ) {
        void response.text().catch(() => "");
        body.thinking = { type: "enabled" };
        continue;
      }
      // Cross-provider/model thinking blocks carry signatures Anthropic can't
      // validate ("Invalid `signature` in `thinking` block") — this happens
      // after a model/provider switch replays another engine's reasoning. Strip
      // EVERY thinking block from history and retry once; they're the model's
      // own scratch reasoning, never required for a correct fresh answer.
      if (!response.ok && response.status === 400) {
        const errText = await response.text().catch(() => "");
        if (/signature/i.test(errText) && /thinking/i.test(errText)) {
          let stripped = false;
          for (const msg of (body.messages as Array<{ content?: unknown }>)) {
            if (Array.isArray(msg.content)) {
              const content = msg.content as Array<{ type?: string }>;
              const kept = content.filter((b) => b.type !== "thinking");
              if (kept.length !== content.length) {
                msg.content = kept;
                stripped = true;
              }
            }
          }
          if (stripped) {
            body.thinking = undefined; // don't re-request thinking on the clean retry
            continue;
          }
        }
        // Not a signature issue (or nothing left to strip) — surface it with the
        // text we already read (can't re-read a consumed body).
        consumedErrorText = errText;
      }
      break;
    }

    if (!response.ok) {
      // Surface the body verbatim: the engine's context-limit matcher
      // reads it ("prompt is too long"), and 529s carry overloaded_error.
      const text = consumedErrorText ?? await response.text().catch(() => "");
      yield {
        type: "error",
        error: {
          code: `http_${response.status}`,
          message: `Anthropic returned ${response.status}: ${text.slice(0, 500)}`,
          retriable:
            response.status === 429 ||
            response.status >= 500 ||
            text.includes("overloaded_error"),
          retryAfterMs: parseRetryAfterMs(response.headers),
        },
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: { code: "no_body", message: "Response had no body", retriable: false },
      };
      return;
    }

    yield* this.parseSSE(response.body, req.signal, guard);
  }

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    guard?: StallGuard,
  ): AsyncGenerator<StreamEvent> {
    const decoder = new TextDecoder("utf8");
    const reader = body.getReader();
    let buffer = "";

    const blocks = new Map<number, BlockState>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let messageId = "";

    const cancel = (): void => {
      void reader.cancel().catch(() => {});
    };

    read: while (true) {
      if (signal?.aborted) {
        cancel();
        return;
      }
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        guard?.dispose();
        if (guard?.stalled()) {
          yield stallErrorEvent();
          return;
        }
        if (signal?.aborted || isAbortError(err)) return;
        yield {
          type: "error",
          error: {
            code: "stream_read_error",
            message: err instanceof Error ? err.message : String(err),
            retriable: true,
          },
        };
        return;
      }
      guard?.reset();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        if (signal?.aborted) {
          cancel();
          return;
        }
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseAnthropicSSE(raw);
        if (!evt || !evt.type) continue; // malformed data line → skip

        switch (evt.type) {
          case "message_start": {
            messageId = evt.message?.id ?? messageId;
            const u = evt.message?.usage;
            if (u) usage = mergeUsage(usage, u);
            continue;
          }

          case "content_block_start": {
            if (typeof evt.index !== "number") continue;
            const cb = evt.content_block;
            if (cb?.type === "text") {
              blocks.set(evt.index, freshBlock("text"));
            } else if (cb?.type === "thinking") {
              blocks.set(evt.index, freshBlock("thinking"));
            } else if (cb?.type === "tool_use") {
              const toolId = cb.id ?? `toolu_${evt.index}`;
              const toolName = cb.name ?? "";
              const state = freshBlock("tool_use");
              state.toolId = toolId;
              state.toolName = toolName;
              blocks.set(evt.index, state);
              yield { type: "tool_use_start", id: toolId, name: toolName };
            }
            // Unknown block kinds (redacted_thinking, server tools): ignore.
            continue;
          }

          case "content_block_delta": {
            if (typeof evt.index !== "number") continue;
            const block = blocks.get(evt.index);
            if (!block) continue;
            const d = evt.delta;
            if (d?.type === "text_delta" && d.text) {
              block.text += d.text;
              yield { type: "text_delta", text: d.text };
            } else if (d?.type === "thinking_delta" && d.thinking) {
              block.thinking += d.thinking;
              yield { type: "thinking_delta", text: d.thinking };
            } else if (d?.type === "input_json_delta" && d.partial_json !== undefined) {
              block.partialJson += d.partial_json;
              if (block.toolId) {
                yield { type: "tool_use_input_delta", id: block.toolId, deltaJson: d.partial_json };
              }
            } else if (d?.type === "signature_delta" && d.signature) {
              // Captured so replayed assistant turns keep valid thinking blocks.
              block.signature += d.signature;
            }
            continue;
          }

          case "content_block_stop": {
            if (typeof evt.index !== "number") continue;
            const block = blocks.get(evt.index);
            if (!block || block.kind !== "tool_use" || !block.toolId) continue;
            yield {
              type: "tool_use_input_done",
              id: block.toolId,
              input: parseToolInput(block.partialJson, block.toolName ?? ""),
            };
            continue;
          }

          case "message_delta": {
            if (evt.usage) usage = mergeUsage(usage, evt.usage);
            stopReason = mapStopReason(evt.delta?.stop_reason) ?? stopReason;
            continue;
          }

          case "message_stop": {
            cancel();
            break read;
          }

          case "error": {
            const kind = evt.error?.type ?? "stream_error";
            // An in-stream rate_limit_error is the same condition as an HTTP 429
            // (which the !response.ok path retries) — it just arrives after the
            // stream opened. Mark it retriable so an arrival-time technicality
            // doesn't fail a turn the 429 path would have retried. (No Retry-After
            // is carried on the SSE error frame, so the engine's transient
            // backoff governs the wait.)
            yield {
              type: "error",
              error: {
                code: kind,
                message: evt.error?.message ?? "Anthropic stream error",
                retriable:
                  kind === "overloaded_error" ||
                  kind === "api_error" ||
                  kind === "rate_limit_error",
              },
            };
            cancel();
            return;
          }

          default:
            continue; // ping + unknown event types (forward-compat)
        }
      }
    }

    guard?.dispose();
    if (signal?.aborted) return;

    // Assemble the final assistant message in wire (index) order. Reached
    // via message_stop, or stream close — emit what accumulated either way
    // so the engine always sees a terminal event.
    const content: ContentBlock[] = [];
    for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
      const block = blocks.get(idx)!;
      if (block.kind === "text" && block.text) {
        content.push({ type: "text", text: block.text });
      } else if (block.kind === "thinking" && block.thinking) {
        content.push({
          type: "thinking",
          text: block.thinking,
          ...(block.signature ? { signature: block.signature } : {}),
        });
      } else if (block.kind === "tool_use" && block.toolId) {
        content.push({
          type: "tool_use",
          id: block.toolId,
          name: block.toolName ?? "",
          input: parseToolInput(block.partialJson, block.toolName ?? ""),
        });
      }
    }

    const message: Message = {
      id: messageId || `msg_${Date.now().toString(36)}`,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    };
    yield { type: "message_done", message, usage, stopReason };
  }
}

// ─── Request building ───────────────────────────────────────────────────

// sanitizeToolPairs lives in ./_toolPairs.js — shared with the deepseek dialect
// and ollama's Anthropic-compat path so a fix can't miss a sibling.

/** A single Anthropic wire message: role + already-mapped content blocks. */
interface WireMessage {
  role: "assistant" | "user";
  content: Record<string, unknown>[];
}

/**
 * Enforce tool-call adjacency on the FINAL wire messages — the last line of
 * defense against the "tool_use ids without tool_result immediately after" 400
 * that permanently bricks a session (every resend re-emits the same body). Runs
 * on the built structure, so it catches orphans introduced AFTER
 * sanitizeToolPairs by mapping/filtering, not just those present in the source
 * history.
 *
 * A tool_use survives only if the very next message carries its tool_result; a
 * tool_result survives only if the previous message emitted its tool_use.
 * Anything else becomes plain text (context preserved, request valid). Messages
 * emptied by the rewrite are dropped, and — since dropping can itself break a
 * newly-adjacent pair — the sweep repeats until it reaches a fixed point.
 */
export function stripUnpairedWireToolBlocks(messages: WireMessage[]): WireMessage[] {
  let current = messages;
  for (let pass = 0; pass < 6; pass++) {
    const pairedUses = new Set<Record<string, unknown>>();
    const pairedResults = new Set<Record<string, unknown>>();
    for (let i = 0; i < current.length - 1; i++) {
      const source = current[i];
      const target = current[i + 1];
      if (source.role !== "assistant" || target.role !== "user") continue;
      const resultsById = new Map<string, Record<string, unknown>>();
      for (const block of target.content) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string" && !resultsById.has(block.tool_use_id)) {
          resultsById.set(block.tool_use_id, block);
        }
      }
      const seenUses = new Set<string>();
      for (const block of source.content) {
        if (block.type !== "tool_use" || typeof block.id !== "string" || seenUses.has(block.id)) continue;
        seenUses.add(block.id);
        const result = resultsById.get(block.id);
        if (result) {
          pairedUses.add(block);
          pairedResults.add(result);
        }
      }
    }
    let changed = false;
    const rewritten = current.map((m) => {
      const content = m.content.map((b) => {
        if (b.type === "tool_use" && typeof b.id === "string" && !pairedUses.has(b)) {
          changed = true;
          return { type: "text", text: `[earlier ${String(b.name ?? "tool")} call — result not retained]` };
        }
        if (b.type === "tool_result" && typeof b.tool_use_id === "string" && !pairedResults.has(b)) {
          changed = true;
          const c = b.content;
          const text =
            typeof c === "string"
              ? c
              : Array.isArray(c)
                ? c.map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : "[content]")).join("\n")
                : "";
          return { type: "text", text: `[earlier tool result]\n${text}` };
        }
        return b;
      });
      return { role: m.role, content };
    });
    const filtered = rewritten.filter((m) => m.content.length > 0);
    current = filtered;
    if (!changed) break;
  }
  // Ordering, not just presence: a tool_result behind a text block 400s the
  // same way as a missing one ("tool_use ids … without tool_result blocks
  // immediately after"). The rewrite above can itself create that shape (an
  // orphaned result converted to text ahead of a surviving result), and
  // poisoned histories persisted by older builds already have it — so the last
  // touch on the wire is always results-first.
  return current.map((m) => (m.role === "user" ? { role: m.role, content: toolResultsFirst(m.content) } : m));
}

function buildMessagesBody(
  req: ProviderRequest,
  dialect: AnthropicDialect = "anthropic",
): Record<string, unknown> {
  const isDeepseek = dialect === "deepseek";
  const outputAllowance = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const wireMessages = sanitizeToolPairs(req.messages)
    .map((m) => ({
      // Anthropic accepts only user/assistant; stray system-role history
      // (rare — the prompt rides req.system) folds into the user turn.
      role: m.role === "assistant" ? "assistant" : ("user" as "assistant" | "user"),
      content: m.content
        .map((b) => toAnthropicContentBlock(b, dialect))
        .filter((b): b is Record<string, unknown> => b !== null),
    }))
    .filter((m) => m.content.length > 0);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: outputAllowance,
    stream: true,
    // Final adjacency sweep on the ACTUAL wire messages. sanitizeToolPairs runs
    // on req.messages, but the .map/.filter above can still empty and DROP a
    // message afterwards (e.g. an assistant turn whose only siblings were
    // unsigned thinking blocks that map to null) — which re-orphans a tool_use
    // sanitize had certified against the pre-filter layout. Anthropic then 400s
    // on exactly this built body, permanently bricking the session because the
    // poison is reintroduced after the repair on every resend. Sweeping the wire
    // structure last guarantees what we send is valid no matter how upstream
    // reshaped it.
    messages: stripUnpairedWireToolBlocks(wireMessages),
  };

  // Reasoning dial → extended thinking. Fable-class models removed
  // budget_tokens in favor of adaptive thinking and 400 on the enabled+budget
  // shape; older models still take explicit budgets (and require max_tokens to
  // exceed the budget, so grow the ceiling to leave room for visible output).
  // reasoningEnabled() (not bare truthiness) so "off" sends NO thinking block on
  // any branch — presence of the field, even enabled with a 0 budget, turns
  // thinking back on / 400s the adaptive-only models.
  if (isDeepseek && req.reasoningLevel === "off") {
    body.thinking = { type: "disabled" };
  } else if (reasoningEnabled(req.reasoningLevel)) {
    if (isDeepseek) {
      // DeepSeek ignores budget_tokens; enable thinking and do NOT inflate
      // max_tokens (the budget branch would grow the ceiling for nothing).
      //
      // TACTICAL: DeepSeek's dial is binary on the wire (every enabled level is
      // identical), so a "routine" continuation — mid tool loop, previous round
      // clean — SKIPS the thinking pass entirely. That's the difference between
      // "52s of reasoning before calling Edit" and just calling Edit. History
      // rendering stays byte-identical (echoed thinking blocks untouched) so
      // the server-side KV cache keeps its prefix. If the endpoint rejects the
      // mix, the 400 self-heal in stream() re-adds thinking and retries.
      if (req.reasoningPhase !== "routine") {
        body.thinking = { type: "enabled" };
      }
      body.output_config = { effort: deepSeekReasoningEffort(req.reasoningLevel) };
    } else if (usesNativeAdaptiveThinking(req.model)) {
      // Current Claude families pair adaptive thinking with a real effort wire.
      // This is the control the old desktop dial claimed to expose but never sent.
      body.thinking = { type: "adaptive" };
      body.output_config = { effort: anthropicReasoningEffort(req.reasoningLevel, req.model) };
    } else {
      const budget = thinkingBudgetTokens(req.reasoningLevel);
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.max_tokens = budget + outputAllowance;
      if (supportsAnthropicEffort(req.model)) {
        body.output_config = { effort: anthropicReasoningEffort(req.reasoningLevel, req.model) };
      }
    }
  }

  if (req.system) {
    // DeepSeek ignores cache_control (it auto KV-caches server-side on stable
    // prefixes), so omit it there; keep the byte-stable system block either way.
    body.system = [
      isDeepseek
        ? { type: "text", text: req.system }
        : { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
    ];
  }

  if (req.tools.length > 0) {
    body.tools = req.tools.map((t, index) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      ...(!isDeepseek && index === req.tools.length - 1
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    }));
    // Act-first forcing: "any" structurally REQUIRES a tool call (the engine
    // sets it on the first agentic turn of a goal + right after a fleet
    // returns). Anthropic disallows forced tool use WITH extended thinking —
    // thinking needs a free-form assistant turn — so thinking wins when both
    // are requested EXCEPT on DeepSeek, whose /anthropic dialect accepts both.
    if (req.toolChoice === "any" && (isDeepseek || !reasoningEnabled(req.reasoningLevel))) {
      body.tool_choice = { type: "any" };
    }
  }

  // S3 — rolling conversation cache breakpoint. The system + last-tool
  // breakpoints only cache the STATIC prefix; without a breakpoint inside the
  // message history, every turn of a long session re-bills the entire growing
  // transcript. Mark the last block of the most recent message: Anthropic caches
  // that prefix, and the next turn's longest-prefix match reuses all the shared
  // history (cache reads are ~10% the price of fresh input). Moves forward every
  // turn, so the cached span grows with the conversation. 3 breakpoints total
  // (system + tools + history), under the 4-breakpoint ceiling.
  if (!isDeepseek) {
    const msgs = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      const lastBlock = lastMsg.content[lastMsg.content.length - 1];
      if (lastBlock && typeof lastBlock === "object") {
        lastBlock.cache_control = { type: "ephemeral" };
      }
    }
  }

  return body;
}

function toAnthropicContentBlock(
  block: ContentBlock,
  dialect: AnthropicDialect = "anthropic",
): Record<string, unknown> | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "system_reminder":
      return { type: "text", text: `<system-reminder>${block.text}</system-reminder>` };
    case "image":
      return toAnthropicImage(block);
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content:
          typeof block.content === "string"
            ? block.content
            : block.content.map((inner) =>
                inner.type === "image" ? toAnthropicImage(inner) : { type: "text", text: inner.text },
              ),
        ...(block.is_error ? { is_error: true } : {}),
      };
    case "thinking":
      // Genuine Anthropic replays thinking only WITH the server-issued signature
      // (unsigned is rejected) → drop unsigned. DeepSeek has no signatures and
      // 400s a tool loop unless reasoning is echoed → emit unsigned thinking.
      if (block.signature) {
        return { type: "thinking", thinking: block.text, signature: block.signature };
      }
      return dialect === "deepseek" ? { type: "thinking", thinking: block.text } : null;
  }
}

function toAnthropicImage(block: Extract<ContentBlock, { type: "image" }>): Record<string, unknown> {
  if (block.source.kind === "url") {
    return { type: "image", source: { type: "url", url: block.source.url } };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: block.source.mediaType, data: block.source.data },
  };
}

// ─── Stream-side helpers ────────────────────────────────────────────────

interface BlockState {
  kind: "text" | "thinking" | "tool_use";
  text: string;
  thinking: string;
  signature: string;
  partialJson: string;
  toolId?: string;
  toolName?: string;
}

function freshBlock(kind: BlockState["kind"]): BlockState {
  return { kind, text: "", thinking: "", signature: "", partialJson: "" };
}

function parseToolInput(partialJson: string, toolName: string): unknown {
  // coerceToolArgs throws a correctable <tool_use_error> on malformed/truncated
  // JSON. We CAN'T let that throw escape the SSE generator — it would fail the
  // whole turn as a non-correctable provider_throw. Stash the message under the
  // sentinel key instead; the engine re-throws it per-tool so the model sees an
  // is_error tool_result naming the tool and learns its JSON was unparseable
  // (the old {__unparseable_args__} sentinel was stripped by zod → opaque
  // "<field>: Required").
  try {
    return coerceToolArgs(partialJson, toolName);
  } catch (err) {
    return { [TOOL_ARGS_ERROR_KEY]: err instanceof Error ? err.message : String(err) };
  }
}

function mergeUsage(prev: Usage, wire: AnthropicWireUsage): Usage {
  const cacheReadTokens = wire.cache_read_input_tokens ?? prev.cacheReadTokens;
  const cacheWriteTokens = wire.cache_creation_input_tokens ?? prev.cacheWriteTokens;
  const freshInput = wire.input_tokens;
  return {
    inputTokens:
      freshInput === undefined
        ? prev.inputTokens
        : freshInput + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    outputTokens: wire.output_tokens ?? prev.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function mapStopReason(raw: string | undefined): StopReason | null {
  switch (raw) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return null;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// ─── model listing ─────────────────────────────────────────────────────

/** Fetch the models available to an Anthropic API key.
 *  Mirrors fetchOpenRouterModels/fetchDeepSeekModels's shape and
 *  error-handling in openrouter.ts: throws on a non-ok response so the
 *  caller can catch it and fall back to the hardcoded catalog. */
export async function fetchAnthropicModels(apiKey: string): Promise<Array<{ id: string; label?: string }>> {
  if (!apiKey) return [];
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Anthropic models ${res.status}`);
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows
    .filter((row) => typeof row.id === "string" && row.id.length > 0)
    .map((row) => ({
      id: String(row.id),
      label: typeof row.display_name === "string" ? row.display_name : undefined,
    }));
}

// ─── Anthropic SSE event shape (only the fields we read) ───────────────

interface AnthropicWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicSSEEvent {
  type?: string;
  index?: number;
  message?: { id?: string; usage?: AnthropicWireUsage };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: AnthropicWireUsage;
  error?: { type?: string; message?: string };
}

function parseAnthropicSSE(raw: string): AnthropicSSEEvent | null {
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as AnthropicSSEEvent;
  } catch {
    return null;
  }
}
