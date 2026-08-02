// Shared tool-channel helpers for the Anthropic-shaped providers.
//
// Both live here so every provider that speaks the Anthropic message shape
// (anthropic, deepseek-anthropic, ollama's /v1/messages compat) uses ONE
// implementation — a fix here can't silently miss a sibling path the way three
// copy-pasted versions did.

import type { ContentBlock, Message } from "@ares/protocol";

/**
 * Repair tool-call pairing before sending to an Anthropic-shaped endpoint.
 *
 * Anthropic's rule is strict ADJACENCY, not mere existence: every `tool_use` in
 * an assistant message must be answered by a `tool_result` (same id) in the
 * message IMMEDIATELY AFTER it. The API 400s otherwise —
 *   "tool_use ids were found without tool_result blocks immediately after: <id>.
 *    Each tool_use block must have a corresponding tool_result block in the next
 *    message."
 * and once that shape is persisted, every subsequent turn re-sends it and 400s
 * identically — a permanently bricked session.
 *
 * The old check only asked "does a matching block exist ANYWHERE?" — so a pair
 * split by an intervening message (an interrupted turn where the user's next
 * message landed between the tool_use and its result, a compaction summary
 * inserted mid-pair, or a mid-conversation provider switch that reordered ids)
 * passed the sanitizer but still 400'd. We now validate by adjacency: a
 * `tool_use` is kept only when the very next message carries its `tool_result`,
 * and a `tool_result` only when the previous message emitted its `tool_use`.
 * Everything else is converted to plain text so the model keeps the context
 * without an invalid request. This repairs the persisted corruption on the way
 * out — the next send succeeds and the session un-bricks itself.
 */
export function sanitizeToolPairs(messages: readonly Message[]): Message[] {
  // A tool call is validly paired only when the tool_use and its tool_result sit
  // in adjacent messages (assistant → user). Compute that set in one pass.
  const pairedUses = new Set<ContentBlock>();
  const pairedResults = new Set<ContentBlock>();
  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    // Protocol history may use role:"tool" (OpenAI-style) or role:"user"
    // (Anthropic-style) for the immediately following result message.
    const nextRole = String(next.role);
    if (current.role !== "assistant" || (nextRole !== "user" && nextRole !== "tool")) continue;
    const resultsById = new Map<string, ContentBlock>();
    for (const block of next.content) {
      if (block.type === "tool_result" && !resultsById.has(block.tool_use_id)) resultsById.set(block.tool_use_id, block);
    }
    const seenUses = new Set<string>();
    for (const block of current.content) {
      if (block.type !== "tool_use" || seenUses.has(block.id)) continue;
      seenUses.add(block.id);
      const result = resultsById.get(block.id);
      if (result) {
        pairedUses.add(block);
        pairedResults.add(result);
      }
    }
  }
  return messages.map((m) => {
    const content = m.content.flatMap((b): ContentBlock[] => {
      if (b.type === "tool_use" && !pairedUses.has(b)) {
        return [{ type: "text", text: `[earlier ${b.name} tool call — result not retained]` }];
      }
      if (b.type === "tool_result" && !pairedResults.has(b)) {
        const text =
          typeof b.content === "string"
            ? b.content
            : b.content.map((x) => (x.type === "text" ? x.text : "[image]")).join("\n");
        return [{ type: "text", text: `[earlier tool result]\n${text}` }];
      }
      return [b];
    });
    return { ...m, content: toolResultsFirst(content) };
  });
}

/**
 * Anthropic-shaped endpoints require tool_result blocks to LEAD their message.
 * A text block sitting before a tool_result reads, to the API validator, as the
 * previous assistant's tool_use having no result "immediately after" — the same
 * 400 as a missing pair, and just as session-bricking once persisted. History
 * can legitimately reach that shape (e.g. a steer reminder injected into the
 * tool-results message of an interrupted turn by an older build), so normalize
 * on the way out: tool_results first, everything else after, each side keeping
 * its relative order. No-op (same array back) when the order is already valid.
 */
export function toolResultsFirst<T extends { type?: unknown }>(blocks: T[]): T[] {
  let sawOther = false;
  let misordered = false;
  for (const block of blocks) {
    if (block.type === "tool_result") {
      if (sawOther) {
        misordered = true;
        break;
      }
    } else {
      sawOther = true;
    }
  }
  if (!misordered) return blocks;
  return [...blocks.filter((b) => b.type === "tool_result"), ...blocks.filter((b) => b.type !== "tool_result")];
}

/**
 * Sentinel key a provider stashes on a tool_use input when the model's arguments
 * JSON could not be parsed. The provider CANNOT throw at the stream-parse site —
 * that would crash the SSE generator and fail the whole turn as a non-correctable
 * `provider_throw` — so it carries the correctable message forward instead. The
 * engine re-throws it per-tool (see normalizeToolInput in queryEngine), turning it
 * into an `is_error` tool_result the model can fix on its next turn.
 */
export const TOOL_ARGS_ERROR_KEY = "__tool_use_error__";

/**
 * Coerce a tool_use arguments JSON string into an object.
 *
 * On success: the parsed object. On failure (malformed or truncated JSON): THROWS
 * a correctable error wrapped in the codebase's `<tool_use_error>` envelope, so
 * the model learns its JSON was unparseable and re-emits valid JSON — instead of
 * the old `{__unparseable_args__: raw}` path, where the unknown key was stripped
 * and zod reported a generic "<field>: Required" the model couldn't act on.
 *
 * The envelope is the same convention `@ares/tools` uses for model-correctable
 * errors (`toolError`); inlined here because `@ares/core` does not depend on
 * `@ares/tools`.
 *
 * Stream-parse callers that cannot throw should catch this and stash
 * `{ [TOOL_ARGS_ERROR_KEY]: err.message }` as the input instead.
 */
export function coerceToolArgs(raw: string, toolName: string): Record<string, unknown> {
  const trimmed = raw.trim();
  // Empty args is a valid no-argument call ({}), not a parse failure.
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `<tool_use_error>${toolName}: the arguments JSON was malformed or truncated and could not be parsed. ` +
        `Re-emit the ${toolName} call with complete, valid JSON arguments.</tool_use_error>`,
    );
  }
  // A bare scalar / array parses but isn't a usable argument object.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `<tool_use_error>${toolName}: the arguments must be a JSON object, not ${Array.isArray(parsed) ? "an array" : typeof parsed}. ` +
        `Re-emit the ${toolName} call with a valid JSON arguments object.</tool_use_error>`,
    );
  }
  return parsed as Record<string, unknown>;
}
