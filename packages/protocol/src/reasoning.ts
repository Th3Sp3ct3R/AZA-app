// Unified reasoning levels — one dial the owner controls, translated per provider.
//
// Different backends express "think harder" differently: OpenAI's Responses API
// takes reasoning.effort (a string); Anthropic-shaped reasoners (Ollama Cloud)
// take thinking.budget_tokens (a number). Ares exposes ONE concept — a level —
// and each provider translates it at the wire edge, so the same setting works on
// OpenAI and Ollama alike.

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const REASONING_LEVELS: readonly ReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * Is extended thinking on at all? "off" disables it entirely — callers MUST gate
 * every provider's thinking/reasoning field on this and send NO such field when
 * off (presence of the field, even with a zero budget, turns thinking back on).
 */
export function reasoningEnabled(level: ReasoningLevel | undefined): level is ReasoningLevel {
  return !!level && level !== "off";
}

/** Human-facing label shared by desktop and terminal surfaces. */
export function reasoningLabel(level: ReasoningLevel): string {
  if (level === "off") return "Off";
  if (level === "xhigh") return "X-High";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/**
 * OpenAI Responses `reasoning.effort`. Current reasoning models accept the
 * none→xhigh ladder. Ares's UI-only `max` ceiling maps to OpenAI's deepest wire
 * value (`xhigh`) rather than silently collapsing to `high`.
 */
export function openAIReasoningEffort(level: ReasoningLevel): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  switch (level) {
    case "off":
      return "none";
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "xhigh";
  }
}

/** Claude Messages `output_config.effort`, model-capability clamped. */
export function anthropicReasoningEffort(level: ReasoningLevel, model = ""): "low" | "medium" | "high" | "xhigh" | "max" {
  const supportsXHigh = /(?:fable|mythos)-?5|opus-4-[78]|sonnet-5/i.test(model);
  switch (level) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return supportsXHigh ? "xhigh" : "high";
    case "max":
      return "max";
  }
}

/** DeepSeek V4 exposes only high/max (plus a separate thinking toggle). */
export function deepSeekReasoningEffort(level: ReasoningLevel): "high" | "max" {
  return level === "xhigh" || level === "max" ? "max" : "high";
}

/**
 * Anthropic / Ollama-reasoner `thinking.budget_tokens`. Must stay below the
 * request's max_tokens — the provider bumps max_tokens to fit (see ollamaCloud).
 *
 * "off" returns 0 only for exhaustiveness — callers MUST check reasoningEnabled()
 * first and send NO thinking block when off (an enabled block with a 0 budget
 * still turns thinking on / 400s on adaptive-only models).
 */
export function thinkingBudgetTokens(level: ReasoningLevel): number {
  switch (level) {
    case "off":
      return 0;
    case "minimal":
      return 1_024;
    case "low":
      return 2_048;
    case "medium":
      return 8_192;
    case "high":
      return 16_384;
    case "xhigh":
      return 32_768;
    case "max":
      return 65_536;
  }
}
