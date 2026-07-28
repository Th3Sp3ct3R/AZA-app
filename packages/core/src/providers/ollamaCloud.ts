// OllamaCloudPool — exploit Ollama Cloud's 3 concurrent model slots.
//
// Three roles, each pinned to a model:
//   REASONER  — main agent loop (the user's choice)
//   APPLY     — ApplyIntent + FindAndEdit per-location LLM
//   SUMMARIZE — WebFetch summary, todo derivation, commit messages
//
// The pool serializes per-slot but parallelizes across slots, so the
// REASONER can think while APPLY is materializing the previous edit and
// SUMMARIZE is compacting an oversized tool result. End-to-end latency
// drops below single-model harnesses because the slow steps overlap.
//
// Routes through local Ollama at http://127.0.0.1:11434 (which proxies
// to the Cloud). Discovery via /api/tags at startup.

import type {
  ContentBlock,
  Message,
  StreamEvent,
  Usage,
  StopReason,
} from "@ares/protocol";
import { thinkingBudgetTokens, reasoningEnabled } from "@ares/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";
import { createStallGuard, stallErrorEvent } from "./stallGuard.js";
import { parseRetryAfterMs } from "./retryAfter.js";
import { sanitizeToolPairs, coerceToolArgs, TOOL_ARGS_ERROR_KEY } from "./_toolPairs.js";

export type SlotName = "reasoner" | "apply" | "summarize";

export interface SlotConfig {
  /** Ollama model id, e.g. "qwen3-coder:480b-cloud", "gpt-oss:20b-cloud". */
  model: string;
}

export interface OllamaCloudPoolOptions {
  /** Ollama HTTP host. Default http://127.0.0.1:11434. */
  host?: string;
  /** Slot configuration. All three required. */
  slots: Record<SlotName, SlotConfig>;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /**
   * When true, hit Ollama Cloud's Anthropic-compatible /v1/messages
   * endpoint instead of /api/chat. Since Ares's wire protocol is
   * already Anthropic-shape, this path needs ZERO translation —
   * messages, content blocks, tools, and tool_use/tool_result all
   * pass through unchanged. Default toggled by
   * ARES_OLLAMA_ANTHROPIC_COMPAT=1.
   */
  useAnthropicCompat?: boolean;
  /** Optional bearer token for direct ollama.com requests. */
  apiKey?: string;
}

interface SlotState {
  model: string;
  inFlight: Promise<unknown> | null;
}

export class OllamaCloudPool {
  readonly host: string;
  readonly useAnthropicCompat: boolean;
  /** Set when /v1/messages 404s — this Ollama predates the compat endpoint. */
  private compatUnsupported = false;
  private readonly slots: Map<SlotName, SlotState>;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey?: string;

  constructor(opts: OllamaCloudPoolOptions) {
    // Anthropic-style env vars take precedence so the standard
    //   ANTHROPIC_BASE_URL=http://localhost:11434
    //   ANTHROPIC_AUTH_TOKEN=ollama
    //   ANTHROPIC_API_KEY=""
    // setup that Ollama documents for Anthropic-SDK compat "just works".
    const anthropicBase = process.env.ANTHROPIC_BASE_URL;
    const anthropicToken =
      process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || undefined;

    this.host = normalizeOllamaHost(opts.host ?? anthropicBase ?? process.env.OLLAMA_HOST);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiKey = opts.apiKey ?? anthropicToken ?? process.env.OLLAMA_API_KEY;
    // Compat is the DEFAULT: /v1/messages streams tool-input deltas (live
    // tool authorship in the UI) and needs zero translation from Ares's
    // Anthropic-shaped wire protocol. Opt out with
    // ARES_OLLAMA_ANTHROPIC_COMPAT=0; old Ollama builds without the endpoint
    // fall back to /api/chat automatically on the first 404/405.
    this.useAnthropicCompat =
      opts.useAnthropicCompat ??
      (process.env.ARES_OLLAMA_ANTHROPIC_COMPAT !== "0");
    this.slots = new Map(
      (Object.entries(opts.slots) as Array<[SlotName, SlotConfig]>).map(([name, cfg]) => [
        name,
        { model: cfg.model, inFlight: null },
      ]),
    );
  }

  /** Get a Provider bound to a specific slot. Used by QueryEngine. */
  provider(slot: SlotName): Provider {
    return new OllamaSlotProvider(this, slot);
  }

  /** The slot's configured model id. */
  modelFor(slot: SlotName): string {
    const s = this.slots.get(slot);
    if (!s) throw new Error(`unknown slot: ${slot}`);
    return s.model;
  }

  /**
   * Stream from a given slot. Respects the per-slot single-concurrency
   * cap by awaiting the prior inFlight promise.
   */
  async *stream(slot: SlotName, req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const s = this.slots.get(slot);
    if (!s) {
      yield {
        type: "error",
        error: { code: "unknown_slot", message: `unknown slot: ${slot}`, retriable: false },
      };
      return;
    }

    // Serialize per-slot. (Other slots may proceed in parallel.)
    while (s.inFlight) {
      try {
        await s.inFlight;
      } catch {
        // The previous request failing on this slot doesn't block us.
      }
    }

    const { promise, generator } = this.dispatch(s.model, req);
    s.inFlight = promise;
    try {
      for await (const event of generator) yield event;
    } finally {
      s.inFlight = null;
    }
  }

  /** APPLY slot one-shot helper: materialize an edit from intent + sketch. */
  async apply(req: {
    file: string;
    original: string;
    instructions: string;
    sketch: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const system =
      "You are an apply-model. Given an ORIGINAL file, an INSTRUCTION, and a SKETCH that uses `// ... existing code ...` markers for unchanged regions, output ONLY the final file content. No commentary. No code fences.";
    const userText = `ORIGINAL (${req.file}):\n\`\`\`\n${req.original}\n\`\`\`\n\nINSTRUCTION:\n${req.instructions}\n\nSKETCH:\n\`\`\`\n${req.sketch}\n\`\`\``;
    return await this.collectText("apply", system, userText, req.signal);
  }

  /** SUMMARIZE slot one-shot helper. */
  async summarize(req: { input: string; instructions?: string; signal?: AbortSignal }): Promise<string> {
    const system =
      req.instructions ??
      "Summarize the following content in 5 sentences or fewer. Plain prose. No preamble.";
    return await this.collectText("summarize", system, req.input, req.signal);
  }

  /** Probe Ollama for installed models. Returns model ids, or [] if unreachable. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${this.host}/api/tags`, { signal });
      if (!res.ok) return [];
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      return (json.models ?? []).map((m) => m.name ?? "").filter((n) => n.length > 0);
    } catch {
      return [];
    }
  }

  /** Probe reachable + slot-models present. Used by `ares doctor`. */
  async health(): Promise<{
    reachable: boolean;
    host: string;
    availableModels: string[];
    slots: Array<{ name: SlotName; model: string; present: boolean }>;
  }> {
    const available = await this.listModels();
    const reachable = available.length > 0 || (await this.ping());
    const slots = (Object.keys(Object.fromEntries(this.slots)) as SlotName[]).map((name) => {
      const model = this.modelFor(name);
      return { name, model, present: available.includes(model) };
    });
    return { reachable, host: this.host, availableModels: available, slots };
  }

  private async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.host}/`);
      return res.ok || res.status === 404; // Ollama root returns "Ollama is running"
    } catch {
      return false;
    }
  }

  // ─── internals ─────────────────────────────────────────────────────

  private dispatch(model: string, req: ProviderRequest): {
    promise: Promise<void>;
    generator: AsyncGenerator<StreamEvent>;
  } {
    let resolveDone!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const self = this;
    const generator = (async function* (): AsyncGenerator<StreamEvent> {
      try {
        if (self.useAnthropicCompat && !self.compatUnsupported) {
          yield* self.callAnthropicMessages(model, req);
        } else {
          yield* self.callOllamaChat(model, req);
        }
        resolveDone();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "error", error: { code: "ollama_throw", message, retriable: true } };
        resolveDone();
      }
    })();

    return { promise, generator };
  }

  private async *callOllamaChat(
    model: string,
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent> {
    const messages = toOllamaMessages(req.messages);

    const body = {
      model,
      messages,
      tools:
        req.tools.length > 0
          ? req.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              },
            }))
          : undefined,
      stream: true,
      options: { num_ctx: ollamaNumCtx(), temperature: 0.2 },
      // Reasoning dial → native /api/chat "think" field. Ollama's documented think
      // enum is low|medium|high (plus a boolean) — NOT "max" — so clamp max→high
      // (mirrors openAIReasoningEffort) to avoid a 400 on models that validate it,
      // while still letting the owner's dial bite here. Gate on reasoningEnabled so
      // "off"/undefined omit think entirely (a present field re-enables thinking).
      ...(req.reasoningLevel === "off"
        ? { think: false }
        : reasoningEnabled(req.reasoningLevel)
        ? { think: req.reasoningLevel === "xhigh" || req.reasoningLevel === "max" ? "high" : req.reasoningLevel === "minimal" ? "low" : req.reasoningLevel }
        : {}),
      // Inject the system prompt as a leading system message — Ollama
      // doesn't have a separate `system` field at the chat-level API.
      ...(req.system
        ? {
            messages: [
              { role: "system", content: req.system },
              ...messages,
            ],
          }
        : {}),
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const guard = createStallGuard(req.signal);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}/api/chat`, {
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
      throw err;
    }
    guard.reset();

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield {
        type: "error",
        error: {
          code: `http_${res.status}`,
          message: `Ollama returned ${res.status}: ${text.slice(0, 500)}`,
          retriable: res.status >= 500,
        },
      };
      return;
    }

    if (!res.body) {
      yield {
        type: "error",
        error: { code: "no_body", message: "Ollama returned no body", retriable: false },
      };
      return;
    }

    const decoder = new TextDecoder("utf8");
    const reader = res.body.getReader();
    let buffer = "";

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    const thinkingState: ThinkingTagState = { inThinking: false, buffer: "" };
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    while (true) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (err) {
        guard.dispose();
        if (guard.stalled()) {
          yield stallErrorEvent();
          return;
        }
        throw err;
      }
      guard.reset();
      const { done, value } = step;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          continue;
        }

        if (chunk.message?.thinking) {
          const delta = chunk.message.thinking;
          thinkingParts.push(delta);
          yield { type: "thinking_delta", text: delta };
        }

        if (chunk.message?.content) {
          for (const part of splitThinkingDelta(chunk.message.content, thinkingState)) {
            if (part.type === "thinking") {
              thinkingParts.push(part.text);
              yield { type: "thinking_delta", text: part.text };
            } else {
              const clean = stripControlTokens(part.text);
              if (clean) {
                textParts.push(clean);
                yield { type: "text_delta", text: clean };
              }
            }
          }
        }

        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            const id = tc.id ?? `call_${toolCalls.length + 1}`;
            const name = tc.function?.name ?? "";
            const argRaw = tc.function?.arguments;
            // Native /api/chat may hand back args as a JSON string or an already-
            // parsed object. For strings, route through coerceToolArgs so a
            // malformed/truncated payload becomes a correctable tool_use_error the
            // model can fix — never throw here (inside the SSE generator).
            let input: Record<string, unknown> | unknown;
            if (typeof argRaw === "string") {
              try {
                input = coerceToolArgs(argRaw, name || "tool");
              } catch (err) {
                input = { [TOOL_ARGS_ERROR_KEY]: err instanceof Error ? err.message : String(err) };
              }
            } else {
              input = argRaw ?? {};
            }
            yield { type: "tool_use_start", id, name };
            const json = JSON.stringify(input);
            yield { type: "tool_use_input_delta", id, deltaJson: json };
            yield { type: "tool_use_input_done", id, input };
            toolCalls.push({ id, name, input });
          }
        }

        if (chunk.done) {
          usage = {
            inputTokens: chunk.prompt_eval_count ?? 0,
            outputTokens: chunk.eval_count ?? 0,
          };
          stopReason = chunk.done_reason === "length" ? "max_tokens" : "end_turn";
        }
      }
    }

    guard.dispose();

    for (const part of flushThinkingState(thinkingState)) {
      if (part.type === "thinking") {
        thinkingParts.push(part.text);
        yield { type: "thinking_delta", text: part.text };
      } else {
        const clean = stripControlTokens(part.text);
        if (clean) {
          textParts.push(clean);
          yield { type: "text_delta", text: clean };
        }
      }
    }

    const content: ContentBlock[] = [];
    if (thinkingParts.length > 0) content.push({ type: "thinking", text: thinkingParts.join("") });
    if (textParts.length > 0) content.push({ type: "text", text: textParts.join("") });
    for (const tc of toolCalls) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }

    const message: Message = {
      id: `msg_${Date.now().toString(36)}`,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    };
    yield { type: "message_done", message, usage, stopReason };
  }

  // ─── Anthropic-compat path: POST /v1/messages ───────────────────────
  //
  // Because Ares's wire protocol IS the Anthropic SDK shape, this is a
  // direct passthrough. The messages, content blocks, tools, and
  // tool_use/tool_result all serialize as Anthropic expects with no
  // translation. We only need to parse Anthropic's SSE events back into
  // our StreamEvent union.
  //
  // Triggered by Anthropic-style env vars:
  //   ANTHROPIC_BASE_URL=http://localhost:11434
  //   ANTHROPIC_AUTH_TOKEN=ollama
  //   ANTHROPIC_API_KEY=""
  // — the canonical Ollama Anthropic-compat setup.
  private async *callAnthropicMessages(
    model: string,
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent> {
    let body = buildAnthropicMessagesBody(model, req, true);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const guard = createStallGuard(req.signal);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}/v1/messages`, {
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
      throw err;
    }
    guard.reset();

    if (!res.ok && (res.status === 404 || res.status === 405)) {
      // This Ollama predates /v1/messages — remember and fall back to
      // /api/chat for this and every future call.
      guard.dispose();
      this.compatUnsupported = true;
      yield* this.callOllamaChat(model, req);
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (hasCacheControl(body) && cacheControlMayBeUnsupported(res.status, text)) {
        body = buildAnthropicMessagesBody(model, req, false);
        try {
          res = await this.fetchImpl(`${this.host}/v1/messages`, {
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
          throw err;
        }
        guard.reset();
        if (res.ok) {
          // Continue into the normal streaming parser below with the retried response.
        } else {
          const retryText = await res.text().catch(() => "");
          yield {
            type: "error",
            error: {
              code: `http_${res.status}`,
              message: `Ollama Anthropic-compat returned ${res.status}: ${retryText.slice(0, 500)}`,
              retriable: res.status >= 500 || res.status === 429,
            },
          };
          return;
        }
      } else {
        yield {
          type: "error",
          error: {
            code: `http_${res.status}`,
            message: `Ollama Anthropic-compat returned ${res.status}: ${text.slice(0, 500)}`,
            retriable: res.status >= 500 || res.status === 429,
          },
        };
        return;
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield {
        type: "error",
        error: {
          code: `http_${res.status}`,
          message: `Ollama Anthropic-compat returned ${res.status}: ${text.slice(0, 500)}`,
          retriable: res.status >= 500 || res.status === 429,
          retryAfterMs: parseRetryAfterMs(res.headers),
        },
      };
      return;
    }
    if (!res.body) {
      yield { type: "error", error: { code: "no_body", message: "no body", retriable: false } };
      return;
    }

    // ─── Parse Anthropic SSE ────────────────────────────────────────
    // event types: message_start, content_block_start, content_block_delta,
    // content_block_stop, message_delta, message_stop, ping, error.
    const decoder = new TextDecoder("utf8");
    const reader = res.body.getReader();
    let buffer = "";

    // Per-index accumulators (Anthropic indexes content blocks)
    interface BlockState {
      type: "text" | "tool_use" | "thinking";
      text: string;            // for text blocks
      thinking: string;        // for thinking blocks
      toolId?: string;
      toolName?: string;
      partialJson: string;     // for tool_use blocks
    }
    const blocks = new Map<number, BlockState>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let messageId = "";

    while (true) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (err) {
        guard.dispose();
        if (guard.stalled()) {
          yield stallErrorEvent();
          return;
        }
        throw err;
      }
      guard.reset();
      const { done, value } = step;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseAnthropicSSE(raw);
        if (!evt) continue;

        switch (evt.type) {
          case "message_start": {
            messageId = evt.message?.id ?? "";
            if (evt.message?.usage) {
              const cacheReadTokens = evt.message.usage.cache_read_input_tokens;
              const cacheWriteTokens = evt.message.usage.cache_creation_input_tokens;
              usage = {
                inputTokens:
                  (evt.message.usage.input_tokens ?? 0) +
                  (cacheReadTokens ?? 0) +
                  (cacheWriteTokens ?? 0),
                outputTokens: evt.message.usage.output_tokens ?? 0,
                cacheReadTokens,
                cacheWriteTokens,
              };
            }
            continue;
          }
          case "content_block_start": {
            const cb = evt.content_block;
            if (cb?.type === "text") {
              blocks.set(evt.index!, { type: "text", text: "", thinking: "", partialJson: "" });
            } else if (cb?.type === "tool_use") {
              blocks.set(evt.index!, {
                type: "tool_use",
                text: "",
                thinking: "",
                partialJson: "",
                toolId: cb.id,
                toolName: cb.name,
              });
              yield { type: "tool_use_start", id: cb.id!, name: cb.name! };
            } else if (cb?.type === "thinking") {
              blocks.set(evt.index!, { type: "thinking", text: "", thinking: "", partialJson: "" });
            }
            continue;
          }
          case "content_block_delta": {
            const block = blocks.get(evt.index!);
            if (!block) continue;
            const d = evt.delta;
            if (d?.type === "text_delta" && d.text) {
              block.text += d.text;
              yield { type: "text_delta", text: d.text };
            } else if (d?.type === "input_json_delta" && d.partial_json !== undefined) {
              block.partialJson += d.partial_json;
              if (block.toolId) {
                yield {
                  type: "tool_use_input_delta",
                  id: block.toolId,
                  deltaJson: d.partial_json,
                };
              }
            } else if (d?.type === "thinking_delta" && d.thinking) {
              block.thinking += d.thinking;
              yield { type: "thinking_delta", text: d.thinking };
            }
            continue;
          }
          case "content_block_stop": {
            const block = blocks.get(evt.index!);
            if (!block || block.type !== "tool_use" || !block.toolId) continue;
            // coerceToolArgs THROWS on malformed/truncated JSON; we're inside the
            // SSE generator, so we MUST catch and stash the correctable message
            // under TOOL_ARGS_ERROR_KEY — throwing here would fail the whole turn
            // as provider_throw instead of letting the engine re-prompt the model.
            let input: Record<string, unknown>;
            try {
              input = coerceToolArgs(block.partialJson, block.toolName ?? "tool");
            } catch (err) {
              input = { [TOOL_ARGS_ERROR_KEY]: err instanceof Error ? err.message : String(err) };
            }
            yield { type: "tool_use_input_done", id: block.toolId, input };
            continue;
          }
          case "message_delta": {
            if (evt.usage?.output_tokens !== undefined) {
              usage = { ...usage, outputTokens: evt.usage.output_tokens };
            }
            const sr = evt.delta?.stop_reason;
            if (sr === "end_turn") stopReason = "end_turn";
            else if (sr === "tool_use") stopReason = "tool_use";
            else if (sr === "max_tokens") stopReason = "max_tokens";
            else if (sr === "stop_sequence") stopReason = "stop_sequence";
            continue;
          }
          case "message_stop":
          case "ping":
          case undefined:
            continue;
          case "error": {
            yield {
              type: "error",
              error: {
                code: evt.error?.type ?? "stream_error",
                message: evt.error?.message ?? "anthropic-compat stream error",
                retriable: false,
              },
            };
            return;
          }
        }
      }
    }

    guard.dispose();

    // Build final assistant message
    const content: ContentBlock[] = [];
    // Iterate in index order so output mirrors the wire ordering
    const orderedIndices = [...blocks.keys()].sort((a, b) => a - b);
    for (const idx of orderedIndices) {
      const block = blocks.get(idx)!;
      if (block.type === "text" && block.text) {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && block.thinking) {
        content.push({ type: "thinking", text: block.thinking });
      } else if (block.type === "tool_use" && block.toolId && block.toolName) {
        let input: Record<string, unknown>;
        try {
          input = coerceToolArgs(block.partialJson, block.toolName);
        } catch (err) {
          input = { [TOOL_ARGS_ERROR_KEY]: err instanceof Error ? err.message : String(err) };
        }
        content.push({ type: "tool_use", id: block.toolId, name: block.toolName, input });
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

  private async collectText(
    slot: SlotName,
    system: string,
    userText: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const messages: Message[] = [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: userText }],
        createdAt: new Date().toISOString(),
      },
    ];
    const parts: string[] = [];
    for await (const ev of this.stream(slot, {
      model: this.modelFor(slot),
      system,
      messages,
      tools: [],
      signal,
    })) {
      if (ev.type === "text_delta") parts.push(ev.text);
      if (ev.type === "error") throw new Error(`${slot} slot: ${ev.error.message}`);
    }
    return parts.join("");
  }
}

class OllamaSlotProvider implements Provider {
  readonly name: string;
  constructor(private readonly pool: OllamaCloudPool, private readonly slot: SlotName) {
    this.name = `ollama-cloud:${slot}`;
  }
  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    yield* this.pool.stream(this.slot, req);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function buildAnthropicMessagesBody(
  model: string,
  req: ProviderRequest,
  withCacheControl: boolean,
): Record<string, unknown> {
  const outputAllowance = req.maxOutputTokens ?? 8192;
  // Drop orphaned tool_use/tool_result pairs before mapping — otherwise the
  // Anthropic-compat endpoint 400s on a tool_result whose tool_use was dropped
  // (compaction, interrupted turn, provider switch). Mirrors anthropic.ts.
  const body: Record<string, unknown> = {
    model,
    max_tokens: outputAllowance,
    stream: true,
    messages: sanitizeToolPairs(req.messages)
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role,
        content: m.content.map((b) => toAnthropicContentBlock(b)),
      })),
  };

  // Reasoning dial → extended thinking. Anthropic requires max_tokens to exceed
  // the thinking budget, so grow the ceiling to leave room for the visible reply.
  // Gate on reasoningEnabled: "off" must send NO thinking block (a present block,
  // even with a 0 budget, turns thinking back on / 400s on adaptive-only models).
  const level = req.reasoningLevel;
  if (level !== undefined && reasoningEnabled(level)) {
    const budget = thinkingBudgetTokens(level);
    body.thinking = { type: "enabled", budget_tokens: budget };
    body.max_tokens = budget + outputAllowance;
  }

  if (req.system) {
    body.system = withCacheControl
      ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
      : req.system;
  }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t, index) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      ...(withCacheControl && index === req.tools.length - 1
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    }));
  }
  return body;
}

function ollamaNumCtx(): number {
  const raw = Number(process.env.ARES_OLLAMA_NUM_CTX);
  if (Number.isFinite(raw) && raw >= 8_192) return Math.floor(raw);
  return 65_536;
}

function toAnthropicContentBlock(block: ContentBlock): Record<string, unknown> {
  if (block.type === "system_reminder") {
    return { type: "text", text: `<system-reminder>${block.text}</system-reminder>` };
  }
  if (block.type === "thinking") {
    // Ares's ThinkingBlock carries the reasoning under `text`, but the Anthropic
    // wire shape names the field `thinking`. The old catch-all fallthrough passed
    // it as {type:"thinking", text:"..."}, which the compat endpoint rejects /
    // ignores. Map text -> thinking explicitly. Note: Ollama-generated thinking has
    // no signature, so this mirrors anthropic.ts's *deepseek* branch (lenient
    // compat) — NOT the strict Anthropic dialect, which drops unsigned thinking.
    // Safe because Ollama's /v1/messages compat layer doesn't enforce signatures.
    return { type: "thinking", thinking: block.text };
  }
  if (block.type === "image") {
    if (block.source.kind === "url") {
      return { type: "image", source: { type: "url", url: block.source.url } };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.source.mediaType,
        data: block.source.data,
      },
    };
  }
  return block as unknown as Record<string, unknown>;
}

function hasCacheControl(body: Record<string, unknown>): boolean {
  return JSON.stringify(body).includes("\"cache_control\"");
}

function cacheControlMayBeUnsupported(status: number, text: string): boolean {
  return status === 400 && /cache_control|extra|unknown|invalid/i.test(text);
}

interface OllamaMessage {
  role: string;
  content?: string;
  images?: string[];
  tool_calls?: Array<{
    type: "function";
    function: {
      index: number;
      name: string;
      arguments: unknown;
    };
  }>;
  tool_name?: string;
}

function toOllamaMessages(messages: readonly Message[]): OllamaMessage[] {
  // Anthropic-shaped messages: tool_result blocks live inside user-role
  // messages alongside text. Ollama native /api/chat wants separate
  // tool-role messages and identifies the target function by tool_name,
  // not by tool_call_id.
  const out: OllamaMessage[] = [];
  const toolNameById = new Map<string, string>();

  for (const m of messages) {
    const images = m.content.flatMap((b) =>
      b.type === "image" && b.source.kind === "base64" ? [b.source.data] : [],
    );
    const text = m.content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "system_reminder") return `<system-reminder>${b.text}</system-reminder>`;
        if (b.type === "image" && b.source.kind === "url") return `[image: ${b.source.url}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");

    const toolUses = m.content.filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use",
    );
    const toolCalls = toolUses.map((b, index) => {
      toolNameById.set(b.id, b.name);
      return {
        type: "function" as const,
        function: { index, name: b.name, arguments: b.input },
      };
    });

    if (text.length > 0 || toolCalls.length > 0 || images.length > 0) {
      out.push({
        role: m.role,
        ...(text.length > 0 ? { content: text } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }

    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      out.push({
        role: "tool",
        tool_name: toolNameById.get(b.tool_use_id) ?? b.tool_use_id,
        content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      });
    }
  }

  return out;
}

interface OllamaChunk {
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string | Record<string, unknown> };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ─── Anthropic SSE event shape (only fields we read) ───────────────────

interface ThinkingTagState {
  inThinking: boolean;
  buffer: string;
}

type ThinkingSplitPart = { type: "text" | "thinking"; text: string };

// Strip stray model control/channel tokens that some local models (e.g. gemma4
// via Ollama's harmony-style parser) leak into visible content — these showed up
// in chat as garbage like "thought\n<channel|>" or "<|tool_response>".
function stripControlTokens(text: string): string {
  // Only strip the actual control TOKENS (the angle-bracket/pipe markers) — never
  // bare words like "final"/"thought", which are legitimate prose.
  return text
    .replace(/<\|[^>]*?>/g, "")                                  // <|tool_response>, <|...>
    .replace(/<[^>\s]*?\|>/g, "")                                // <channel|>, <turn|>
    .replace(/<\/?(?:start_of_turn|end_of_turn|eos|bos|pad|unk|mask)\b[^>]*>/gi, "");
}

function splitThinkingDelta(delta: string, state: ThinkingTagState): ThinkingSplitPart[] {
  state.buffer += delta;
  const out: ThinkingSplitPart[] = [];
  while (state.buffer.length > 0) {
    if (state.inThinking) {
      const close = state.buffer.indexOf("</think>");
      if (close === -1) {
        const keep = partialTagSuffixLength(state.buffer, "</think>");
        const emitLength = state.buffer.length - keep;
        if (emitLength > 0) {
          out.push({ type: "thinking", text: state.buffer.slice(0, emitLength) });
          state.buffer = state.buffer.slice(emitLength);
        }
        break;
      }
      if (close > 0) out.push({ type: "thinking", text: state.buffer.slice(0, close) });
      state.buffer = state.buffer.slice(close + "</think>".length);
      state.inThinking = false;
      continue;
    }

    const open = state.buffer.indexOf("<think>");
    if (open === -1) {
      const keep = partialTagSuffixLength(state.buffer, "<think>");
      const emitLength = state.buffer.length - keep;
      if (emitLength > 0) {
        out.push({ type: "text", text: state.buffer.slice(0, emitLength) });
        state.buffer = state.buffer.slice(emitLength);
      }
      break;
    }
    if (open > 0) out.push({ type: "text", text: state.buffer.slice(0, open) });
    state.buffer = state.buffer.slice(open + "<think>".length);
    state.inThinking = true;
  }
  return out.filter((part) => part.text.length > 0);
}

function flushThinkingState(state: ThinkingTagState): ThinkingSplitPart[] {
  if (!state.buffer) return [];
  const part: ThinkingSplitPart = {
    type: state.inThinking ? "thinking" : "text",
    text: state.buffer,
  };
  state.buffer = "";
  state.inThinking = false;
  return part.text.length > 0 ? [part] : [];
}

function partialTagSuffixLength(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let length = max; length > 0; length--) {
    if (tag.startsWith(buffer.slice(-length))) return length;
  }
  return 0;
}

interface AnthropicSSEEvent {
  type?:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop"
    | "ping"
    | "error";
  index?: number;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: { type?: "text" | "tool_use" | "thinking"; id?: string; name?: string };
  delta?: {
    type?: "text_delta" | "input_json_delta" | "thinking_delta";
    text?: string;
    partial_json?: string;
    thinking?: string;
    stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

function parseAnthropicSSE(raw: string): AnthropicSSEEvent | null {
  const lines = raw.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
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

// ─── Ollama Cloud model catalog ────────────────────────────────────────
//
// Curated list of cloud models the model picker shows. The user can
// still type any model id Ollama recognizes (or whatever appears in
// /api/tags) — this is just the discovery shortlist.
//
// Source: https://ollama.com/search?c=cloud (verified manually; the
// web summary occasionally hallucinates names).

function normalizeOllamaHost(raw?: string): string {
  const fallback = "http://127.0.0.1:11434";
  const input = (raw ?? fallback).trim();
  let value = input.length > 0 ? input : fallback;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fallback;
  }

  const bindHosts = new Set(["0.0.0.0", "::", "[::]"]);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (bindHosts.has(url.hostname)) {
    url.hostname = "127.0.0.1";
  }
  if (!url.port && (bindHosts.has(url.hostname) || localHosts.has(url.hostname))) {
    url.port = "11434";
  }
  return url.toString().replace(/\/$/, "");
}

export interface OllamaCloudModel {
  id: string;
  /** Bucket the picker groups by. */
  role: "reasoner" | "apply" | "summarize" | "general";
  /** Short capability hint shown in the picker. */
  hint: string;
}

// ─── Ollama LIBRARY catalog (ollama.com/library) ───────────────────────
//
// The full public library — every model whether the user pulled it or not,
// so the discovery panel can show the same browse experience as ollama.com
// (blurb, capabilities, pull count, updated). Parsed from the library HTML:
// there is no public JSON API, but the page is server-rendered with stable
// `x-test-*` markers on every card, which makes it safely regex-parseable.

export interface OllamaLibraryModel {
  name: string;
  description?: string;
  /** Raw ollama capability tags: tools, thinking, vision, embedding. */
  capabilities: string[];
  /** Model has a hosted :cloud variant on ollama.com. */
  cloud: boolean;
  /** Human pull count, e.g. "225.9K". */
  pulls?: string;
  tagCount?: number;
  /** Relative age, e.g. "3 weeks ago". */
  updated?: string;
}

let ollamaLibraryCache: { at: number; models: OllamaLibraryModel[] } | null = null;

/** Fetch + parse the ollama.com library (cached 1h). Returns [] on any failure —
 *  the catalog must degrade, never break the picker. */
export async function fetchOllamaLibraryModels(opts: { fetchImpl?: typeof fetch; force?: boolean } = {}): Promise<OllamaLibraryModel[]> {
  if (!opts.force && ollamaLibraryCache && Date.now() - ollamaLibraryCache.at < 60 * 60 * 1000) {
    return ollamaLibraryCache.models;
  }
  const f = opts.fetchImpl ?? fetch;
  let html = "";
  try {
    const res = await f("https://ollama.com/library?sort=popular", {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return ollamaLibraryCache?.models ?? [];
    html = await res.text();
  } catch {
    return ollamaLibraryCache?.models ?? [];
  }
  const models: OllamaLibraryModel[] = [];
  // One <li> card per model; anchor href carries the name. Split on the card
  // anchors so each chunk holds exactly one model's markup.
  const chunks = html.split(/<a href="\/library\//).slice(1);
  for (const chunk of chunks) {
    const name = chunk.match(/^([a-z0-9._-]+)"/i)?.[1];
    if (!name) continue;
    const description = chunk.match(/<p class="max-w-lg[^"]*">([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, "").trim();
    const capabilities = [...chunk.matchAll(/x-test-capability[^>]*>([a-z]+)</g)].map((m) => m[1]);
    const cloud = />cloud</.test(chunk);
    const pulls = chunk.match(/x-test-pull-count>([^<]+)</)?.[1]?.trim();
    const tagCount = Number(chunk.match(/x-test-tag-count>([^<]+)</)?.[1]) || undefined;
    const updated = chunk.match(/x-test-updated>([^<]+)</)?.[1]?.trim();
    models.push({ name, description, capabilities, cloud, pulls, tagCount, updated });
  }
  if (models.length > 0) ollamaLibraryCache = { at: Date.now(), models };
  return models;
}

export const OLLAMA_CLOUD_MODELS: readonly OllamaCloudModel[] = [
  // Engineering / agentic reasoners.
  { id: "qwen3-coder:480b-cloud",              role: "reasoner",  hint: "Qwen3 Coder 480B - top coding reasoner" },
  { id: "qwen3-coder-next:cloud",              role: "reasoner",  hint: "Qwen3 Coder Next - agentic coding" },
  { id: "qwen3.5:397b-cloud",                  role: "reasoner",  hint: "Qwen3.5 397B - large multimodal reasoner" },
  { id: "qwen3.5:cloud",                       role: "reasoner",  hint: "Qwen3.5 - cloud default" },
  { id: "qwen3-next:80b-cloud",                role: "reasoner",  hint: "Qwen3 Next 80B - efficient thinking" },
  { id: "deepseek-v4-pro:cloud",               role: "reasoner",  hint: "DeepSeek V4 Pro - frontier reasoning" },
  { id: "deepseek-v4-flash:cloud",             role: "reasoner",  hint: "DeepSeek V4 Flash - fast long-context reasoning" },
  { id: "deepseek-v3.2:cloud",                 role: "reasoner",  hint: "DeepSeek V3.2 - efficient reasoning" },
  { id: "deepseek-v3.1:671b-cloud",            role: "reasoner",  hint: "DeepSeek V3.1 671B - hybrid thinking" },
  { id: "glm-5.1:cloud",                       role: "reasoner",  hint: "GLM-5.1 - flagship agentic engineering" },
  { id: "glm-5:cloud",                         role: "reasoner",  hint: "GLM-5 - complex systems engineering" },
  { id: "glm-4.7:cloud",                       role: "reasoner",  hint: "GLM-4.7 - coding capability" },
  { id: "glm-4.6:cloud",                       role: "reasoner",  hint: "GLM-4.6 - agentic coding" },
  { id: "kimi-k2.6:cloud",                     role: "reasoner",  hint: "Kimi K2.6 - multimodal agentic coding" },
  { id: "kimi-k2.5:cloud",                     role: "reasoner",  hint: "Kimi K2.5 - multimodal agentic" },
  { id: "kimi-k2:1t-cloud",                    role: "reasoner",  hint: "Kimi K2 1T - long-horizon coding" },
  { id: "kimi-k2-thinking:cloud",              role: "reasoner",  hint: "Kimi K2 Thinking - thinking model" },
  { id: "minimax-m2.7:cloud",                  role: "reasoner",  hint: "MiniMax M2.7 - coding and productivity" },
  { id: "minimax-m2.5:cloud",                  role: "reasoner",  hint: "MiniMax M2.5 - productivity coding" },
  { id: "minimax-m2.1:cloud",                  role: "reasoner",  hint: "MiniMax M2.1 - multilingual coding" },
  { id: "minimax-m2:cloud",                    role: "reasoner",  hint: "MiniMax M2 - efficient agentic workflows" },
  { id: "gpt-oss:120b-cloud",                  role: "reasoner",  hint: "GPT-OSS 120B - open reasoning" },
  { id: "devstral-2:123b-cloud",               role: "reasoner",  hint: "Devstral 2 123B - codebase agents" },
  { id: "mistral-large-3:675b-cloud",          role: "reasoner",  hint: "Mistral Large 3 675B - enterprise multimodal" },
  { id: "nemotron-3-super:cloud",              role: "reasoner",  hint: "Nemotron 3 Super - multi-agent reasoning" },
  { id: "cogito-2.1:671b-cloud",               role: "reasoner",  hint: "Cogito 2.1 671B - general reasoning" },

  // Fast apply / edit models.
  { id: "devstral-small-2:24b-cloud",          role: "apply",     hint: "Devstral Small 2 24B - codebase editing" },
  { id: "nemotron-3-nano:30b-cloud",           role: "apply",     hint: "Nemotron 3 Nano 30B - efficient agentic work" },
  { id: "qwen3-vl:235b-instruct-cloud",        role: "apply",     hint: "Qwen3-VL 235B Instruct - multimodal instruction" },
  { id: "rnj-1:8b-cloud",                      role: "apply",     hint: "RNJ-1 8B - code and STEM utility" },

  // Summarizers / compact utility models.
  { id: "gpt-oss:20b-cloud",                   role: "summarize", hint: "GPT-OSS 20B - quick summaries" },
  { id: "gemma3:4b-cloud",                     role: "summarize", hint: "Gemma 3 4B - compact vision utility" },
  { id: "ministral-3:3b-cloud",                role: "summarize", hint: "Ministral 3 3B - small utility" },

  // Multimodal / general cloud choices.
  { id: "gemini-3-flash-preview:cloud",        role: "general",   hint: "Gemini 3 Flash Preview - fast multimodal" },
  { id: "gemma4:31b-cloud",                    role: "general",   hint: "Gemma 4 31B - multimodal reasoning" },
  { id: "gemma3:27b-cloud",                    role: "general",   hint: "Gemma 3 27B - capable vision model" },
  { id: "gemma3:12b-cloud",                    role: "general",   hint: "Gemma 3 12B - balanced vision model" },
  { id: "qwen3-vl:235b-cloud",                 role: "general",   hint: "Qwen3-VL 235B - vision-language reasoning" },
  { id: "ministral-3:14b-cloud",               role: "general",   hint: "Ministral 3 14B - edge-capable multimodal" },
  { id: "ministral-3:8b-cloud",                role: "general",   hint: "Ministral 3 8B - small multimodal" },
];

/** Sub-list filtered by intended role. */
export function ollamaCloudModelsFor(role: OllamaCloudModel["role"]): readonly OllamaCloudModel[] {
  return OLLAMA_CLOUD_MODELS.filter((m) => m.role === role);
}

// ─── Defaults a fresh CLI uses if the user doesn't override ────────────

export const DEFAULT_OLLAMA_SLOTS: Record<SlotName, SlotConfig> = {
  reasoner: { model: process.env.ARES_REASONER ?? "qwen3-coder:480b-cloud" },
  apply: { model: process.env.ARES_APPLY ?? "devstral-small-2:24b-cloud" },
  summarize: { model: process.env.ARES_SUMMARIZE ?? "gpt-oss:20b-cloud" },
};
