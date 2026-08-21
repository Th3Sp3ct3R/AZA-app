// sideQuery — the cheap one-shot judgment primitive.
//
// Fires ONE non-tool streaming call against a provider and concatenates
// the text. The Witness, session titling, and memory selection all share
// this shape. Economics: pass the SAME system prompt as the parent
// session and a cache-capable provider (Anthropic cache_control, OpenAI
// prompt_cache_key) serves the fork from its cached prefix — the
// per-call volatile parts (user text, schema hint) ride the user turn,
// so the prefix stays byte-stable.

import type { Message, ReasoningLevel, Usage } from "@ares/protocol";
import type { Provider } from "./queryEngine.js";

export interface SideQueryOptions {
  provider: Provider;
  model: string;
  system: string;
  user: string;
  signal?: AbortSignal;
  /** Wall-clock deadline for the whole call. Default 60s — auxiliary
   *  judgments run on post-turn settling paths, and a half-open socket
   *  with no deadline used to hang settling forever. */
  timeoutMs?: number;
  /** Output ceiling for the reply. Default 1024 — judgments are short. */
  maxOutputTokens?: number;
  reasoningLevel?: ReasoningLevel;
  /** Receives provider-reported usage for this auxiliary call. */
  onUsage?: (usage: Usage) => void | Promise<void>;
}

export interface SideQueryJsonOptions extends SideQueryOptions {
  /** Shape description appended to the USER turn (never the system
   *  prompt — that would invalidate the shared cached prefix). */
  schemaHint: string;
}

/** Run one non-tool streaming call; return the concatenated text.
 *  Throws if the provider emits an error event. */
export async function sideQuery(opts: SideQueryOptions): Promise<string> {
  const messages: Message[] = [
    {
      id: `sq_${Date.now().toString(36)}`,
      role: "user",
      content: [{ type: "text", text: opts.user }],
      createdAt: new Date().toISOString(),
    },
  ];

  const parts: string[] = [];
  // Provider output ceilings are advisory: some OpenAI-compatible endpoints
  // ignore or reject the wire field entirely. Auxiliary calls must still be
  // bounded because they run on the critical path (compaction, reflection,
  // watcher phrasing). Enforce a conservative local character ceiling too and
  // abort the stream once it is reached.
  const outputTokens = opts.maxOutputTokens ?? 1024;
  const outputChars = Math.max(256, outputTokens * 4);
  const outputAbort = new AbortController();
  // Always carry a wall-clock deadline: providers abort the underlying fetch
  // on this signal, so a half-open socket becomes a clean end-of-stream (or
  // AbortError rejection) instead of hanging post-turn settling forever.
  const signal = AbortSignal.any([
    ...(opts.signal ? [opts.signal] : []),
    outputAbort.signal,
    AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  ]);
  let chars = 0;
  for await (const ev of opts.provider.stream({
    model: opts.model,
    system: opts.system,
    messages,
    tools: [],
    signal,
    reasoningLevel: opts.reasoningLevel,
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
  })) {
    if (ev.type === "text_delta") {
      const remaining = outputChars - chars;
      if (remaining <= 0) {
        outputAbort.abort(new Error("sideQuery output ceiling reached"));
        break;
      }
      const text = ev.text.length > remaining ? ev.text.slice(0, remaining) : ev.text;
      parts.push(text);
      chars += text.length;
      if (chars >= outputChars) {
        outputAbort.abort(new Error("sideQuery output ceiling reached"));
        break;
      }
    } else if (ev.type === "error") {
      throw new Error(`sideQuery(${opts.provider.name}): ${ev.error.message}`);
    } else if (ev.type === "message_done") {
      await opts.onUsage?.({ ...ev.usage, modelCalls: ev.usage.modelCalls ?? 1 });
    }
  }
  return parts.join("");
}

/** sideQuery + parse: extract the first JSON object/array from the reply
 *  (tolerating code fences and surrounding prose). Throws with the raw
 *  reply text when nothing parseable comes back. */
export async function sideQueryJson<T = unknown>(opts: SideQueryJsonOptions): Promise<T> {
  const raw = await sideQuery({
    ...opts,
    user: `${opts.user}\n\nReply with ONLY JSON matching this shape: ${opts.schemaHint}`,
  });
  const extracted = extractFirstJson(raw);
  if (!extracted.ok) {
    throw new Error(`sideQueryJson: could not parse JSON from reply:\n${raw}`);
  }
  return extracted.value as T;
}

// ─── JSON extraction ────────────────────────────────────────────────────

export function extractFirstJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  const text = unfence(raw);
  // Try each bracket position in turn: prose can contain an inline brace BEFORE
  // the real JSON (e.g. "result {as requested}: {\"answer\":1}"), so a failed
  // parse at the first bracket must not abandon the scan (finding #6).
  for (let start = nextBracket(text, 0); start !== -1; start = nextBracket(text, start + 1)) {
    const parsed = tryBalancedFrom(text, start);
    if (parsed.ok) return parsed;
  }
  return { ok: false };
}

/** Parse a single balanced {...}/[...] starting exactly at `start`. */
function tryBalancedFrom(text: string, start: number): { ok: true; value: unknown } | { ok: false } {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(text.slice(start, i + 1)) };
        } catch {
          return { ok: false };
        }
      }
    }
  }
  return { ok: false };
}

function unfence(raw: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return fence ? fence[1] : raw;
}

/** First '{' or '[' at or after `from`, or -1. */
function nextBracket(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") return i;
  }
  return -1;
}
