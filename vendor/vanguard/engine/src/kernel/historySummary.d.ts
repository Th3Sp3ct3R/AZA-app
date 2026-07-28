import type { TranscriptEntry } from "./contracts.js";
/**
 * Replaces an old tool-call/result causal chunk with inert runtime history.
 *
 * Provider APIs interpret assistant continuations as executable tool calls,
 * while user messages carry human authority. This representation uses neither:
 * only bounded runtime-derived metadata and a digest survive. Provider call
 * IDs, raw arguments, outputs, continuations, and free-form previews never
 * cross the compaction boundary. Runtime evidence IDs are deliberately safe
 * to retain so a later plan revision can cite an exact old observation.
 * Workspace-relative paths are JSON-escaped and clearly labelled as untrusted
 * identifiers rather than instructions.
 */
export declare function summarizeHistoricalToolExchange(entries: readonly TranscriptEntry[]): TranscriptEntry;
