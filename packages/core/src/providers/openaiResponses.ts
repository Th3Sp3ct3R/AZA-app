// OpenAI Responses provider — ChatGPT OAuth → Codex backend, streaming.
//
// Ares only supports ChatGPT OAuth (not OPENAI_API_KEY). Requests always
// route to the Codex backend at chatgpt.com/backend-api/codex/responses.
//
// Input message shape is Anthropic SDK-compatible: tool results arrive
// as USER-role messages with tool_result content blocks. This provider
// translates them to the Responses API's function_call_output items at
// the wire edge.
//
// SSE events handled:
//   response.created
//   response.output_item.added            (text or function_call)
//   response.output_text.delta            (text chunk)
//   response.function_call_arguments.delta (tool args chunk)
//   response.function_call_arguments.done  (tool args complete)
//   response.output_item.done             (item complete)
//   response.completed                    (turn done + usage)
//   error                                 (terminal)

import type {
  Message,
  StreamEvent,
  Usage,
  StopReason,
  ContentBlock,
} from "@ares/protocol";
import { openAIReasoningEffort } from "@ares/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";
import { loadAuthToken, type AuthToken } from "./openaiAuth.js";
import { parseRetryAfterMs } from "./retryAfter.js";
import { buildPromptCacheKey } from "../promptCache.js";
import { createStallGuard, stallErrorEvent, type StallGuard } from "./stallGuard.js";
import { coerceToolArgs, sanitizeToolPairs, TOOL_ARGS_ERROR_KEY } from "./_toolPairs.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface OpenAIResponsesProviderOptions {
  /** Override the discovered auth token (tests). */
  auth?: AuthToken;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override URL (tests). */
  endpointUrl?: string;
}

export class OpenAIResponsesProvider implements Provider {
  readonly name = "openai-responses";
  private readonly fetchImpl: typeof fetch;
  private readonly overrideAuth?: AuthToken;
  private readonly overrideUrl?: string;

  constructor(opts: OpenAIResponsesProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.overrideAuth = opts.auth;
    this.overrideUrl = opts.endpointUrl;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const auth = this.overrideAuth ?? (await loadAuthToken());
    if (!auth) {
      yield {
        type: "error",
        error: {
          code: "no_auth",
          message: "No ChatGPT OAuth token. Run `ares login` to authorize.",
          retriable: false,
        },
      };
      return;
    }

    const url = this.overrideUrl ?? CODEX_RESPONSES_URL;
    const body = buildRequestBody(req);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${auth.token}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "ares",
      "User-Agent": "ares",
      version: "ares-ts",
    };
    if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;

    // Stall watchdog: abort the fetch when no bytes arrive for the stall
    // window so a hung Codex connection becomes a retriable error, not a freeze.
    const guard = createStallGuard(req.signal);
    let response: Response;
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

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      yield {
        type: "error",
        error: {
          code: `http_${response.status}`,
          message: `OpenAI Responses returned ${response.status}: ${text.slice(0, 500)}`,
          retriable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500,
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

    // Accumulation state for the in-flight message
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolUseByItemId = new Map<string, ToolUseEntry>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let messageId = "";

    const cancel = (): void => {
      void reader.cancel().catch(() => {});
    };

    while (true) {
      if (signal?.aborted) {
        cancel();
        guard?.dispose();
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
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines.
      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const event = parseSSEEvent(rawEvent);
        if (!event) continue;

        const evt = event.data as ResponsesEvent | null;
        if (!evt || !evt.type) continue;

        if (isReasoningDeltaEvent(evt)) {
          const delta = evt.delta ?? evt.text ?? "";
          if (delta) {
            thinkingParts.push(delta);
            yield { type: "thinking_delta", text: delta };
          }
          continue;
        }

        switch (evt.type) {
          case "response.created":
          case "response.in_progress":
            messageId = evt.response?.id ?? messageId;
            continue;

          case "response.output_item.added": {
            const item = evt.item;
            if (item?.type === "function_call") {
              const itemId = item.id ?? item.call_id ?? `call_${toolUseByItemId.size}`;
              const callId = item.call_id ?? itemId;
              // Reuse an entry a prior args event lazily created under any of
              // these ids (so accumulated argsText survives) instead of clobbering
              // it; fill in the real callId/name now that .added carries them.
              const existing =
                (item.id ? toolUseByItemId.get(item.id) : undefined) ??
                (item.call_id ? toolUseByItemId.get(item.call_id) : undefined) ??
                toolUseByItemId.get(itemId);
              const entry: ToolUseEntry = existing ?? { callId, name: "", argsText: "", completed: false };
              entry.callId = callId;
              if (item.name) entry.name = item.name;
              // Register the SAME entry under every id a later args event might
              // carry: item.id, item.call_id, and the synthetic fallback. Some
              // backends omit item.id here but stamp a real item_id on the
              // function_call_arguments.* events — keying by all three makes the
              // delta/done lookup resolve regardless of which id arrives.
              if (item.id) toolUseByItemId.set(item.id, entry);
              if (item.call_id) toolUseByItemId.set(item.call_id, entry);
              toolUseByItemId.set(itemId, entry);
              yield { type: "tool_use_start", id: callId, name: item.name ?? "" };
            }
            continue;
          }

          case "response.output_text.delta": {
            const delta = evt.delta ?? "";
            if (delta) {
              textParts.push(delta);
              yield { type: "text_delta", text: delta };
            }
            continue;
          }

          case "response.function_call_arguments.delta": {
            const itemId = evt.item_id ?? evt.id ?? "";
            const delta = evt.delta ?? "";
            if (!delta) continue;
            // Lazily create if output_item.added never registered this id (args
            // arriving before/without the added event) so the chunk is
            // accumulated, not silently dropped.
            const entry = getOrCreateToolEntry(toolUseByItemId, itemId);
            entry.argsText += delta;
            yield { type: "tool_use_input_delta", id: entry.callId, deltaJson: delta };
            continue;
          }

          case "response.function_call_arguments.done": {
            const itemId = evt.item_id ?? evt.id ?? "";
            // Lazily create for the same reason as .delta: a backend that skips
            // output_item.added still gets its args finalized rather than dropped.
            const entry = getOrCreateToolEntry(toolUseByItemId, itemId);
            if (entry.completed) continue;
            entry.completed = true;
            // evt.arguments carries the complete args on .done for backends that
            // never streamed deltas; prefer it when our accumulator is empty.
            const argsText = entry.argsText || evt.arguments || "";
            entry.argsText = argsText;
            yield {
              type: "tool_use_input_done",
              id: entry.callId,
              input: parseToolInput(argsText, entry.name),
            };
            continue;
          }

          case "response.output_item.done": {
            // Finalize a function_call whose args.done never fired (some backends
            // signal completion only via output_item.done). Without this the call
            // never gets a tool_use_input_done → the engine never executes it.
            const item = evt.item;
            if (item?.type !== "function_call") continue;
            const itemId = item.id ?? item.call_id ?? "";
            const entry = toolUseByItemId.get(itemId);
            if (!entry || entry.completed) continue;
            entry.completed = true;
            const argsText = entry.argsText || item.arguments || "";
            entry.argsText = argsText;
            yield {
              type: "tool_use_input_done",
              id: entry.callId,
              input: parseToolInput(argsText, entry.name),
            };
            continue;
          }

          case "response.completed": {
            usage = extractUsage(evt.response) ?? usage;
            stopReason = mapStopReason(evt.response);
            messageId = evt.response?.id ?? messageId;
            continue;
          }

          case "error": {
            guard?.dispose();
            {
              // Mirror the Anthropic provider: transient in-stream failures
              // (rate limits, overload, server errors) are retriable so the
              // engine's retry ladder gets a shot instead of failing the turn.
              const code = evt.error?.code ?? "stream_error";
              const retriable =
                /rate_limit|overloaded|server_error|api_error|timeout|too_many/i.test(code) ||
                /rate.?limit|overloaded|try again|timed? ?out/i.test(evt.error?.message ?? "");
              yield {
                type: "error",
                error: {
                  code,
                  message: evt.error?.message ?? "unknown stream error",
                  retriable,
                },
              };
            }
            return;
          }

          default:
            // Ignore unknown event types (forward-compat).
            continue;
        }
      }
    }

    guard?.dispose();

    // Build the final assistant Message.
    const content: ContentBlock[] = [];
    if (thinkingParts.length > 0) {
      content.push({ type: "thinking", text: thinkingParts.join("") });
    }
    if (textParts.length > 0) {
      content.push({ type: "text", text: textParts.join("") });
    }
    // One entry is registered under multiple keys (item.id / call_id / synthetic
    // fallback), so dedupe by entry identity before emitting tool_use blocks.
    const seenEntries = new Set<ToolUseEntry>();
    for (const entry of toolUseByItemId.values()) {
      if (seenEntries.has(entry)) continue;
      seenEntries.add(entry);
      // Backstop: an entry that never reached completed===true (no args.done and
      // no output_item.done) would otherwise ship as a tool_use the engine never
      // ran an input_done for — a silently-dropped orphan. Emit a synthesized
      // input_done so a partial call surfaces as a correctable per-tool is_error.
      if (!entry.completed) {
        entry.completed = true;
        yield {
          type: "tool_use_input_done",
          id: entry.callId,
          input: parseToolInput(entry.argsText, entry.name),
        };
      }
      content.push({
        type: "tool_use",
        id: entry.callId,
        name: entry.name,
        input: parseToolInput(entry.argsText, entry.name),
      });
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

// ─── Helpers ───────────────────────────────────────────────────────────

function buildRequestBody(req: ProviderRequest): Record<string, unknown> {
  const cache = buildPromptCacheKey(req);
  const level = req.reasoningLevel;
  return {
    model: req.model,
    instructions: req.system,
    // sanitizeToolPairs first: a function_call_output whose function_call was
    // dropped (compaction / interrupted turn / provider switch) is an orphan
    // the Codex backend 400s on. It folds orphans to plain text, same as the
    // Anthropic path.
    input: sanitizeToolPairs(req.messages).flatMap(toResponsesInputItems),
    store: false,
    prompt_cache_key: cache.key,
    tools: req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    ...(req.tools.length > 0 ? { tool_choice: req.toolChoice === "any" ? "required" : "auto" } : {}),
    stream: true,
    // Explicitly send `none` for Off: omitting this field lets several current
    // GPT models fall back to their own default, which made Off look fake.
    ...(level ? { reasoning: { effort: openAIReasoningEffort(level) } } : {}),
  };
}

// coerceToolArgs throws a correctable <tool_use_error> on malformed/truncated
// JSON. We CAN'T let that throw escape the SSE generator — it would fail the
// whole turn as a non-correctable provider_throw. Stash the message under the
// sentinel key instead; the engine re-throws it per-tool so the model sees an
// is_error tool_result naming the tool and learns its JSON was unparseable.
function parseToolInput(argsText: string, toolName: string): unknown {
  try {
    return coerceToolArgs(argsText, toolName);
  } catch (err) {
    return { [TOOL_ARGS_ERROR_KEY]: err instanceof Error ? err.message : String(err) };
  }
}

interface ToolUseEntry {
  callId: string;
  name: string;
  argsText: string;
  completed: boolean;
}

// Resolve the tool entry for an args event, creating one if output_item.added
// never registered it (args arriving before/without the added event). The
// synthetic callId reuses itemId so the engine still has a stable tool id to
// pair the result against.
function getOrCreateToolEntry(map: Map<string, ToolUseEntry>, itemId: string): ToolUseEntry {
  let entry = map.get(itemId);
  if (!entry) {
    entry = { callId: itemId || `call_${map.size}`, name: "", argsText: "", completed: false };
    map.set(itemId, entry);
  }
  return entry;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function toResponsesInputItems(m: Message): Record<string, unknown>[] {
  // Anthropic-shaped messages: tool_results live as USER-role content
  // blocks. Translate them to function_call_output items first; the
  // remaining text/image content (if any) flows through as a normal
  // input message.
  const items: Record<string, unknown>[] = [];
  const messageContent: Record<string, unknown>[] = [];
  // Images carried inside a tool_result can't ride the function_call_output
  // (its `output` is a plain string — JSON.stringify'ing an array dumps the
  // base64 as literal text and blinds the model). Collect them here and emit
  // them through the Responses input_image channel in a trailing user message.
  const toolResultImages: Record<string, unknown>[] = [];

  for (const b of m.content) {
    if (b.type === "tool_result") {
      let output: string;
      if (typeof b.content === "string") {
        output = b.content;
      } else {
        // Keep text as text; route images to the input_image channel below.
        const texts: string[] = [];
        for (const inner of b.content) {
          if (inner.type === "text") {
            texts.push(inner.text);
          } else if (inner.type === "image") {
            toolResultImages.push(toResponsesImage(inner));
            texts.push("[image returned to the model below]");
          }
        }
        output = texts.join("\n");
      }
      items.push({
        type: "function_call_output",
        call_id: b.tool_use_id,
        output,
      });
    } else if (b.type === "text") {
      messageContent.push({
        type: m.role === "assistant" ? "output_text" : "input_text",
        text: b.text,
      });
    } else if (b.type === "system_reminder") {
      messageContent.push({ type: "input_text", text: `<system-reminder>${b.text}</system-reminder>` });
    } else if (b.type === "image") {
      messageContent.push(toResponsesImage(b));
    } else if (b.type === "tool_use") {
      items.push({
        type: "function_call",
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input),
      });
    }
  }

  if (messageContent.length > 0) {
    items.unshift({
      type: "message",
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: messageContent,
    });
  }

  // Tool-result images ride the input_image channel in a user message AFTER
  // the function_call_output items (an output must immediately follow its
  // call; the image is conceptually the user handing the result back).
  if (toolResultImages.length > 0) {
    items.push({
      type: "message",
      role: "user",
      content: toolResultImages,
    });
  }

  return items;
}

function toResponsesImage(block: Extract<ContentBlock, { type: "image" }>): Record<string, unknown> {
  if (block.source.kind === "url") {
    return { type: "input_image", image_url: block.source.url };
  }
  return {
    type: "input_image",
    image_url: `data:${block.source.mediaType};base64,${block.source.data}`,
  };
}

function extractUsage(resp: ResponsesEvent["response"]): Usage | null {
  if (!resp?.usage) return null;
  return {
    inputTokens: resp.usage.input_tokens ?? 0,
    outputTokens: resp.usage.output_tokens ?? 0,
    cacheReadTokens: resp.usage.input_tokens_details?.cached_tokens,
    reasoningTokens: resp.usage.output_tokens_details?.reasoning_tokens,
  };
}

function mapStopReason(resp: ResponsesEvent["response"]): StopReason {
  switch (resp?.status) {
    case "completed":
      return "end_turn";
    case "incomplete":
      return resp.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "interrupted";
    case "failed":
      return "error";
    default:
      return "end_turn";
  }
}

// ─── SSE parsing ───────────────────────────────────────────────────────

interface ParsedSSE {
  event?: string;
  data: unknown;
}

function parseSSEEvent(raw: string): ParsedSSE | null {
  const lines = raw.split("\n");
  let event: string | undefined;
  let dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data: null };
  }
}

// ─── Loose Responses API event shape ───────────────────────────────────
// We type only the fields we read; everything else is forward-compatible.

interface ResponsesEvent {
  type: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  item_id?: string;
  id?: string;
  delta?: string;
  text?: string;
  // Complete args string some backends put on .done / output_item.done instead
  // of streaming deltas.
  arguments?: string;
  response?: {
    id?: string;
    status?: "completed" | "incomplete" | "failed" | "in_progress";
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  error?: { code?: string; message?: string };
}

function isReasoningDeltaEvent(evt: ResponsesEvent): boolean {
  return /reasoning|thinking/u.test(evt.type) && /delta/u.test(evt.type);
}

// Model discovery: the Codex backend does not expose /v1/models. The user
// selects their model explicitly via `ares model <id>` or --model flag.
