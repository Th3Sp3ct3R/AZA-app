// OpenRouter provider — OpenAI Chat Completions, streaming.
//
// OpenRouter (https://openrouter.ai) is an OpenAI-compatible gateway to many
// models. Auth is a Bearer API key the OWNER pastes in-app (never hard-coded).
// We translate Ares's Anthropic-shaped messages (tool_result as USER content,
// tool_use as ASSISTANT content) into OpenAI chat messages at the wire edge.
//
// SSE: each `data:` line is a chat.completion.chunk with choices[0].delta
// carrying either `content` (text) or `tool_calls` (indexed deltas whose
// function.arguments accumulate). A final chunk (stream_options.include_usage)
// carries `usage`. The stream terminates with `data: [DONE]`.

import type {
  Message,
  StreamEvent,
  Usage,
  StopReason,
  ContentBlock,
} from "@ares/protocol";
import { openAIReasoningEffort, reasoningEnabled } from "@ares/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";
import { createStallGuard, stallErrorEvent, type StallGuard } from "./stallGuard.js";
import { parseRetryAfterMs } from "./retryAfter.js";
import { coerceToolArgs, TOOL_ARGS_ERROR_KEY } from "./_toolPairs.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

type OpenAIChatFlavor = "openrouter" | "deepseek";

export interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  /** Override base URL (tests). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Internal compatibility profile used by OpenAI-compatible providers. */
  flavor?: OpenAIChatFlavor;
  /** Provider name exposed to the engine and telemetry. */
  providerName?: string;
}

export class OpenRouterProvider implements Provider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly flavor: OpenAIChatFlavor;

  constructor(opts: OpenRouterProviderOptions) {
    this.name = opts.providerName ?? "openrouter";
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? OPENROUTER_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.flavor = opts.flavor ?? "openrouter";
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    if (!this.apiKey) {
      yield {
        type: "error",
        error: {
          code: "no_auth",
          message: `No ${this.name === "deepseek" ? "DeepSeek" : "OpenRouter"} API key. Add one in Settings > API Keys.`,
          retriable: false,
        },
      };
      return;
    }

    const body = buildChatBody(this.model || req.model, req, this.flavor);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.flavor === "openrouter") {
      headers["HTTP-Referer"] = "https://ares.dev";
      headers["X-Title"] = "Ares";
    }

    // Stall watchdog: abort the fetch when no bytes arrive for the stall
    // window so a hung connection becomes a retriable error, not a freeze.
    const guard = createStallGuard(req.signal);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
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
      yield {
        type: "error",
        error: { code: "network_error", message: err instanceof Error ? err.message : String(err), retriable: true },
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
          message: `OpenRouter returned ${response.status}: ${text.slice(0, 500)}`,
          retriable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500,
          retryAfterMs: parseRetryAfterMs(response.headers),
        },
      };
      return;
    }
    if (!response.body) {
      yield { type: "error", error: { code: "no_body", message: "Response had no body", retriable: false } };
      return;
    }

    yield* this.parseSSE(response.body, this.model || req.model, guard);
  }

  private async *parseSSE(body: ReadableStream<Uint8Array>, model: string, guard?: StallGuard): AsyncGenerator<StreamEvent> {
    const decoder = new TextDecoder("utf8");
    const reader = body.getReader();
    let buffer = "";

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const reasoningDetails: unknown[] = [];
    // Tool calls accumulated under a STABLE key. Upstreams that stream parallel
    // tool_calls sometimes omit `index` on the deltas; keying by `index ?? 0`
    // then collapses every concurrent call onto bucket 0 (second clobbers first,
    // args concatenate into one corrupt blob). Prefer the call id, fall back to
    // the wire index, and only as a last resort a monotonic counter — so a
    // single normal call still accumulates correctly and parallel calls stay
    // separate even when the upstream is sloppy about index/id.
    const tools = new Map<string, { id: string; name: string; argsText: string; started: boolean }>();
    const indexToKey = new Map<number, string>();
    let anonToolSeq = 0;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    const flushLine = function* (line: string): Generator<StreamEvent> {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(data) as ChatChunk;
      } catch {
        return;
      }
      if (chunk.usage) {
        // DeepSeek auto-caches the stable prompt prefix and reports the hit;
        // OpenRouter/OpenAI report cached_tokens. Surface either so caching is
        // visible and billed correctly instead of looking like full input each turn.
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens;
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
          ...(typeof cached === "number" ? { cacheReadTokens: cached } : {}),
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta;
      if (delta?.content) {
        textParts.push(delta.content);
        yield { type: "text_delta", text: delta.content };
      }
      const thinking = delta?.reasoning_content ?? delta?.reasoning;
      if (thinking) {
        thinkingParts.push(thinking);
        yield { type: "thinking_delta", text: thinking };
      }
      if (Array.isArray(delta?.reasoning_details)) {
        reasoningDetails.push(...delta.reasoning_details);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          // Resolve a stable accumulation key. id wins (globally unique across
          // parallel calls); otherwise the wire index (mapped to whatever key it
          // first resolved to, so an id arriving later reuses the same entry);
          // otherwise a per-stream counter so id-less, index-less deltas don't
          // all pile onto one bucket.
          let key: string;
          if (tc.id) {
            key = `id:${tc.id}`;
            // If an earlier index-only delta already opened this call under an
            // `idx:` key, migrate that buffer to the id key so args don't split.
            if (typeof tc.index === "number" && !tools.has(key)) {
              const priorKey = indexToKey.get(tc.index);
              if (priorKey && priorKey !== key) {
                const prior = tools.get(priorKey);
                if (prior) {
                  tools.delete(priorKey);
                  tools.set(key, prior);
                }
              }
            }
            if (typeof tc.index === "number") indexToKey.set(tc.index, key);
          } else if (typeof tc.index === "number") {
            key = indexToKey.get(tc.index) ?? `idx:${tc.index}`;
            indexToKey.set(tc.index, key);
          } else {
            key = `anon:${anonToolSeq++}`;
          }
          let entry = tools.get(key);
          if (!entry) {
            entry = { id: tc.id ?? key, name: tc.function?.name ?? "", argsText: "", started: false };
            tools.set(key, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (!entry.started && entry.name) {
            entry.started = true;
            yield { type: "tool_use_start", id: entry.id, name: entry.name };
          }
          if (tc.function?.arguments) {
            entry.argsText += tc.function.arguments;
            yield { type: "tool_use_input_delta", id: entry.id, deltaJson: tc.function.arguments };
          }
        }
      }
      if (choice.finish_reason) {
        stopReason = mapFinish(choice.finish_reason);
      }
    };

    try {
      while (true) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (err) {
          if (guard?.stalled()) {
            yield stallErrorEvent();
            return;
          }
          throw err;
        }
        guard?.reset();
        const { done, value } = step;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          yield* flushLine(line);
        }
      }
      if (buffer.trim()) yield* flushLine(buffer);
    } finally {
      guard?.dispose();
      reader.releaseLock();
    }

    // assemble the final message
    const content: ContentBlock[] = [];
    const thinking = thinkingParts.join("");
    if (thinking) content.push({ type: "thinking", text: thinking });
    const text = textParts.join("");
    if (text) content.push({ type: "text", text });
    for (const entry of [...tools.values()]) {
      let input: Record<string, unknown>;
      try {
        // coerceToolArgs THROWS a <tool_use_error>-wrapped message on malformed
        // or truncated JSON. We're inside the SSE generator, so we cannot let it
        // propagate — that fails the whole turn as provider_throw. Stash the
        // message under the sentinel key; the engine re-throws it per-tool into a
        // correctable is_error tool_result the model can fix next turn.
        input = coerceToolArgs(entry.argsText, entry.name);
      } catch (err) {
        input = { [TOOL_ARGS_ERROR_KEY]: err instanceof Error ? err.message : String(err) };
      }
      yield { type: "tool_use_input_done", id: entry.id, input };
      content.push({ type: "tool_use", id: entry.id, name: entry.name, input });
    }
    if (tools.size > 0) stopReason = "tool_use";

    const message: Message = {
      id: `msg_${Date.now().toString(36)}`,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
      ...(reasoningDetails.length > 0
        ? { metadata: { openrouterReasoningDetails: reasoningDetails } }
        : {}),
    };
    yield { type: "message_done", message, usage, stopReason };
  }
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: unknown[];
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    /** OpenAI / OpenRouter style cached-prompt accounting. */
    prompt_tokens_details?: { cached_tokens?: number };
    /** DeepSeek style: tokens served from / missed by its automatic context cache. */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

// ─── request building ──────────────────────────────────────────────────────

function buildChatBody(model: string, req: ProviderRequest, flavor: OpenAIChatFlavor): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push(...toChatHistory(req.messages, flavor));
  return {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
          tool_choice: req.toolChoice === "any" ? "required" : "auto",
        }
      : {}),
    ...(flavor === "deepseek" && req.reasoningLevel === "off"
      ? { thinking: { type: "disabled" } }
      : reasoningEnabled(req.reasoningLevel)
      ? flavor === "deepseek"
        ? {
            thinking: { type: "enabled" },
            reasoning_effort: req.reasoningLevel === "xhigh" || req.reasoningLevel === "max" ? "max" : "high",
          }
        : // reasoningEnabled() guarantees a defined, non-"off" level here.
          { reasoning: { effort: openAIReasoningEffort(req.reasoningLevel!) } }
      : {}),
  };
}

/**
 * Convert retained Ares history into a valid OpenAI chat chain.
 *
 * Context trimming, interrupted turns, or old rollout data can leave a
 * tool_result without the assistant tool_call it answers. OpenAI-compatible
 * APIs reject the whole request in that case. Preserve complete pairs exactly;
 * turn orphaned results into ordinary user context so the model still knows
 * what happened without receiving an invalid role:"tool" message.
 */
function toChatHistory(messages: readonly Message[], flavor: OpenAIChatFlavor): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let pendingToolIds = new Set<string>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "assistant") {
      const converted = toChatMessages(message, flavor)[0];
      const next = messages[index + 1];
      const returnedIds = new Set(
        next?.content
          .filter((block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result")
          .map((block) => block.tool_use_id) ?? [],
      );
      const calls = Array.isArray(converted.tool_calls)
        ? (converted.tool_calls as Array<Record<string, unknown>>)
        : [];
      const pairedCalls = calls.filter((call) => returnedIds.has(String(call.id ?? "")));

      if (pairedCalls.length > 0) {
        converted.tool_calls = pairedCalls;
        pendingToolIds = new Set(pairedCalls.map((call) => String(call.id)));
      } else {
        delete converted.tool_calls;
        pendingToolIds.clear();
        if ((converted.content === null || converted.content === "") && calls.length > 0) {
          converted.content = "[Earlier tool request omitted because its matching result is unavailable.]";
        }
      }
      out.push(converted);
      continue;
    }

    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      const orphanText: string[] = [];
      for (const block of toolResults) {
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        if (pendingToolIds.has(block.tool_use_id)) {
          out.push({ role: "tool", tool_call_id: block.tool_use_id, content });
          pendingToolIds.delete(block.tool_use_id);
        } else {
          orphanText.push(`[Retained tool result ${block.tool_use_id}]\n${content}`);
        }
      }

      const remainder = message.content.filter((block) => block.type !== "tool_result");
      if (orphanText.length > 0) {
        remainder.push({ type: "text", text: orphanText.join("\n\n") });
      }
      if (remainder.length > 0) {
        out.push(...toChatMessages({ ...message, content: remainder }, flavor));
      }
      pendingToolIds.clear();
      continue;
    }

    pendingToolIds.clear();
    out.push(...toChatMessages(message, flavor));
  }

  return out;
}

/** Convert one Anthropic-shaped message into one or more OpenAI chat messages. */
function toChatMessages(m: Message, flavor: OpenAIChatFlavor): Record<string, unknown>[] {
  // tool_result blocks become standalone role:"tool" messages
  const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
  if (toolResults.length > 0) {
    return toolResults.map((b) => ({
      role: "tool",
      tool_call_id: b.tool_use_id,
      content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
    }));
  }

  if (m.role === "assistant") {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    for (const b of m.content) {
      if (b.type === "text") textParts.push(b.text);
      else if (b.type === "thinking") thinkingParts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
    }
    const msg: Record<string, unknown> = {
      role: "assistant",
      // DeepSeek V4 and several OpenRouter upstreams require non-null assistant
      // content on tool-call messages. Empty string is accepted gateway-wide.
      content: textParts.join(""),
    };
    if (thinkingParts.length > 0) {
      if (flavor === "deepseek") {
        msg.reasoning_content = thinkingParts.join("");
      } else {
        const details = m.metadata?.openrouterReasoningDetails;
        if (Array.isArray(details) && details.length > 0) {
          msg.reasoning_details = details;
        } else {
          // OpenRouter accepts reasoning_content as an alias, but `reasoning`
          // is its normalized field and works across upstream model families.
          msg.reasoning = thinkingParts.join("");
        }
      }
    }
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    return [msg];
  }

  // user / system: text + images as content parts
  const parts: Record<string, unknown>[] = [];
  for (const b of m.content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "system_reminder") parts.push({ type: "text", text: `<system-reminder>${b.text}</system-reminder>` });
    else if (b.type === "image") {
      const url = b.source.kind === "url" ? b.source.url : `data:${b.source.mediaType};base64,${b.source.data}`;
      parts.push({ type: "image_url", image_url: { url } });
    }
  }
  // collapse to a plain string when it's only text (smaller + widely supported)
  const onlyText = parts.length > 0 && parts.every((p) => p.type === "text");
  const content = onlyText ? parts.map((p) => (p as { text: string }).text).join("") : parts;
  return [{ role: m.role === "system" ? "system" : "user", content }];
}

function mapFinish(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

// ─── model listing (public endpoint, no auth required) ───────────────────────

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: string;
  completionPrice?: string;
  description?: string;
  supportedParameters?: string[];
  inputModalities?: string[];
}

export interface DeepSeekProviderOptions {
  apiKey?: string;
  model: string;
  /** Override base URL (tests). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** DeepSeek V4 over its OpenAI-compatible Chat Completions API. */
export class DeepSeekProvider extends OpenRouterProvider {
  constructor(opts: DeepSeekProviderOptions) {
    super({
      apiKey: opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
      model: opts.model,
      baseUrl: opts.baseUrl ?? DEEPSEEK_BASE_URL,
      fetchImpl: opts.fetchImpl,
      flavor: "deepseek",
      providerName: "deepseek",
    });
  }
}

export interface DeepSeekModel {
  id: string;
  ownedBy?: string;
}

/** Fetch OpenRouter's public model catalog. No key needed to list. */
export async function fetchOpenRouterModels(opts: { baseUrl?: string; fetchImpl?: typeof fetch; apiKey?: string } = {}): Promise<OpenRouterModel[]> {
  const base = opts.baseUrl ?? OPENROUTER_BASE_URL;
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await f(`${base}/models`, { headers });
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows.map((r) => ({
    id: String(r.id),
    name: typeof r.name === "string" ? r.name : String(r.id),
    contextLength: typeof r.context_length === "number" ? r.context_length : undefined,
    promptPrice: typeof (r.pricing as Record<string, unknown> | undefined)?.prompt === "string" ? String((r.pricing as Record<string, unknown>).prompt) : undefined,
    completionPrice: typeof (r.pricing as Record<string, unknown> | undefined)?.completion === "string" ? String((r.pricing as Record<string, unknown>).completion) : undefined,
    description: typeof r.description === "string" ? r.description : undefined,
    supportedParameters: Array.isArray(r.supported_parameters)
      ? r.supported_parameters.filter((value): value is string => typeof value === "string")
      : undefined,
    inputModalities: Array.isArray((r.architecture as Record<string, unknown> | undefined)?.input_modalities)
      ? ((r.architecture as Record<string, unknown>).input_modalities as unknown[]).filter((value): value is string => typeof value === "string")
      : undefined,
  }));
}

/** Fetch the models currently enabled for a DeepSeek API key. */
export async function fetchDeepSeekModels(opts: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<DeepSeekModel[]> {
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) return [];
  const base = opts.baseUrl ?? DEEPSEEK_BASE_URL;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`DeepSeek models ${res.status}`);
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return (Array.isArray(json.data) ? json.data : [])
    .filter((row) => typeof row.id === "string" && row.id.length > 0)
    .map((row) => ({
      id: String(row.id),
      ownedBy: typeof row.owned_by === "string" ? row.owned_by : undefined,
    }));
}
