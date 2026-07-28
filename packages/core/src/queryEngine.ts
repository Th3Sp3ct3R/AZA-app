// QueryEngine — the streaming agent loop.
//
// Shape inspired by claude-code-main/src/query.ts and QueryEngine.ts:
//   one QueryEngine per conversation; one streamTurn() per user message.
// Mutable message history carries between turns; the loop continues while
// the assistant emits tool_use blocks.
//
// CONTRACT:
//   - QueryEngine does NOT write to stdout. It yields TurnEvents.
//   - CLI/TUI subscribes to the generator and decides what to render.
//   - All tool execution flows through here; observers see every step.

import {
  type ContentBlock,
  type ImageBlock,
  type Message,
  type StreamEvent,
  type TurnEvent,
  type Usage,
  type StopReason,
  type SafetyClass,
  type ToolSchema,
  type ToolUseBlock,
  type ToolResultBlock,
  type PermissionPromptDecision,
  type PermissionPromptSuggestion,
  type ReasoningLevel,
  type WorkStatus,
  isToolUseBlock,
} from "@ares/protocol";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { HookManager } from "./hooks.js";

// ─── Provider interface (what core asks of providers) ──────────────────

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ProviderToolDescriptor[];
  signal?: AbortSignal;
  /** Unified reasoning dial; each provider translates it (effort vs budget). */
  reasoningLevel?: ReasoningLevel;
  maxOutputTokens?: number;
  /** Structural act-first forcing: "any" REQUIRES a tool call this turn (used
   *  on the first agentic turn of a goal, and right after a research fleet
   *  returns — the two spots where "summarize and stop" wastes the work).
   *  Providers that can't honor it ignore it. */
  toolChoice?: "auto" | "any";
  /** Tactical phase hint. "routine" = a mid-loop continuation after a clean
   *  tool round — binary-dial reasoners (DeepSeek: every level is the same
   *  wire) use this to SKIP the reasoning pass entirely on such calls, which
   *  is the only real speed lever they have. "deep" (or absent) = full think. */
  reasoningPhase?: "deep" | "routine";
}

export interface ProviderToolDescriptor {
  name: string;
  description: string;
  input_schema: object;
}

export interface Provider {
  /** Display name: "openai-responses", "ollama-cloud-reasoner", "mock", etc. */
  readonly name: string;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent>;
}

// ─── Tool implementation interface (what the engine asks of tools) ─────
//
// We re-declare a minimal Tool shape here so @ares/core doesn't depend on
// @ares/tools. The real Tool<I, O> definition lives in @ares/tools/_shared.ts
// and is structurally compatible with this.

export interface EngineTool {
  readonly schema: ToolSchema;
  call(input: unknown, ctx: ToolCallContext): Promise<EngineToolResult>;
}

/** Per-file read bookkeeping. Structural type (the concrete one lives in
 *  @ares/tools) so each engine can own an isolated read-stamp map — a parent
 *  and its subagents must NOT share one, or a child's Read poisons the parent's
 *  re-read guard and falsely grants it read-before-write on unseen files. */
export interface FileReadStampLike {
  mtimeMs: number;
  size: number;
  hash?: string;
  lines?: number;
}

export interface ToolCallContext {
  workspace: string;
  signal: AbortSignal;
  /** Yield progress events from inside a long-running tool call. */
  emitProgress?(data: unknown): void;
  requestPermission?(request: ToolPermissionRequest): Promise<PermissionPromptDecision>;
  /** Engine-owned read-stamp map. When present, file tools MUST prefer it over
   *  any captured map so each engine (parent / subagent) stays isolated. */
  fileReadStamps?: Map<string, FileReadStampLike>;
}

export interface ToolPermissionRequest {
  id?: string;
  toolName: string;
  input: unknown;
  reason: string;
  suggestion?: PermissionPromptSuggestion;
}

export interface EngineToolResult {
  output: unknown;
  touchedFiles?: string[];
  display?: string;
  /**
   * Optional images the tool wants the MODEL to see (e.g. a ComputerUse or
   * Browser screenshot). When present, the tool_result is sent as a
   * text+image block array instead of a plain string, so a vision-capable
   * model literally sees the pixels. Requires a vision model.
   */
  images?: Array<{ mediaType: string; data: string }>;
}

// ─── Engine config ─────────────────────────────────────────────────────

export interface QueryEngineConfig {
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: readonly EngineTool[];
  workspace: string;
  signal?: AbortSignal;
  maxTurns?: number;
  /** Reasoning dial for reasoning-capable models. Owner-selectable (low→max);
   *  translated per provider (OpenAI effort, Ollama/Anthropic thinking budget). */
  reasoningLevel?: ReasoningLevel;
  /** Cap on output tokens per provider call. */
  maxOutputTokens?: number;
  /** Engine-owned read-stamp map, forwarded into every tool ctx. Subagent runs
   *  pass a fresh Map so they never share read state with the parent. */
  fileReadStamps?: Map<string, FileReadStampLike>;
  /** If > 0, the engine trims the OLDEST conversation history to keep the
   *  estimated input (system + tools + messages) under this many tokens, so a
   *  long thread can never hard-fail with context_length_exceeded. The pending
   *  user message and recent context are always kept. */
  contextBudgetTokens?: number;
  /** Optional pending system-reminders to inject at next turn_start. */
  drainSystemReminders?(): Array<{
    text: string;
    source:
      | "verifier"
      | "compaction"
      | "hook"
      | "skill"
      | "memory"
      | "instructions"
      | "undo"
      | "heartbeat"
      | "dream"
      | "recall"
      | "self-revise";
  }>;
  hookManager?: HookManager;
  /**
   * C1 — the end-of-turn gate. Called when the model wants to finish the turn
   * (no tool calls in its last message). Return reminders (e.g. settled
   * verifier failures on files this turn touched) and the engine injects them
   * and CONTINUES the loop instead of ending — the model cannot claim "done"
   * while its own edits are red. Pushes a NEW objection up to END_GATE_HARDCAP
   * (6) times per turn as long as the model keeps making progress; once it's
   * stuck re-claiming done against the SAME red checks (or hits that cap) the
   * turn ends honestly — surfacing the failures as UNRESOLVED, never an infinite
   * repair loop at the engine level.
   */
  confirmTurnEnd?(): Promise<Array<{ text: string; source: "verifier" | "hook" }>>;
  /** Require concrete successful proof after a tool reports changed files. */
  requireVerificationEvidence?: boolean;
  /** Host-owned automatic verifier evidence. Empty reminders alone are not
   * proof because they also mean no checks or skipped tooling. */
  verificationEvidence?(): {
    mutationGeneration: number;
    passedCommands: number;
    failedCommands: number;
    skippedCommands: number;
    latestPassedAt?: number;
    latestFailedAt?: number;
    latestRunGeneration?: number;
    latestRunStatus?: "passed" | "failed" | "cancelled" | "no_checks";
    latestRunStrength?: "syntax" | "static" | "behavioral";
    latestLabels?: string[];
  };
  /** Durable coding state from a previous turn still needs proof. */
  outstandingVerificationRequired?(): boolean;
  /** True only for debt carried into this turn (not mutations made now). */
  persistedVerificationDebt?(): boolean;
  /** False when durable touched-file history overflowed and tail checks are incomplete. */
  persistedVerificationScopeComplete?(): boolean;
  /** Latest exact mutation observed below the engine (e.g. checkpoint-derived shell diff). */
  observedMutationAt?(): number;
  /**
   * Failure-signature recall. When a tool fails the SAME way twice in a row (an
   * approach that's about to be declared dead), the engine asks the host whether
   * it has seen this failure before and how it was resolved. A returned hint is
   * injected so the model can apply the KNOWN fix instead of flailing — the agent
   * literally learning from its own past. Return null when nothing is remembered.
   * Called at most once per distinct signature per turn.
   */
  recallFailureFix?(input: { tool: string; signature: string; error: string }): Promise<string | null>;
  requestPermission?(request: ToolPermissionRequest): Promise<PermissionPromptDecision>;
  /**
   * When false, a PermissionDeniedError from a tool is an ORDINARY error result
   * the model can route around, instead of interrupting the whole turn.
   * Interactive sessions keep the default (true): the user said no, stop.
   * Child engines (subagents, operator forks) set false — one denied
   * out-of-workspace path used to kill an entire researcher fleet with
   * "(subagent produced no text output)" (bug report 96ca5473).
   */
  permissionDenialInterrupts?: boolean;
  beforeToolUseCheckpoint?(request: {
    toolUseId: string;
    toolName: string;
    input: unknown;
    safety: SafetyClass;
    /** The tool's declared target file(s), when analyzable (Edit/Write). Lets
     *  the host take an INCREMENTAL snapshot instead of a full workspace walk. */
    targetFiles?: string[];
  }): Promise<{ checkpointId: string; label?: string } | null>;
  /**
   * Absolute paths the engine considers "self-territory" — writes targeting
   * files inside these roots bypass the write-intent gate entirely. The agent
   * owns its own brain (~/.ares/) and never needs a permission ritual to edit it.
   */
  selfTerritoryRoots?: readonly string[];
  /**
   * Fired when context budgeting drops messages from the model's visible
   * history. The CLI uses this to invalidate fileReadStamps for files whose
   * Read results were trimmed — otherwise the Read re-read guard refuses the
   * re-read ("already in context") for content the model can no longer see,
   * and it edits blind. Over-invalidation is safe (worst case: one extra Read).
   */
  onHistoryTrimmed?(dropped: readonly Message[]): void;
  /**
   * Smart compaction. When the conversation crosses compactionThresholdTokens,
   * the engine keeps the most recent turns at full fidelity and hands the OLDER
   * span to this summarizer, then replaces that span with the returned recap —
   * the way Claude Code/Codex compact: a real model-written summary of what was
   * built, the current state, key files, and what's next. Without it, the
   * engine falls back to the deterministic ledger (lossy bullet list). The host
   * wires this to a cheap sub-model via sideQuery. The optional `signal` is the
   * turn's live abort signal — a Stop during compaction must abort the sub-model
   * mid-summary, not run it to completion before the turn can end.
   */
  summarizeSpan?(messages: readonly Message[], signal?: AbortSignal): Promise<string>;
  /**
   * Token threshold that triggers smart compaction (before the hard
   * contextBudgetTokens cap). Defaults to 80% of contextBudgetTokens.
   */
  compactionThresholdTokens?: number;
}

/**
 * Keep the provider's tool prefix proportional to the current job. A fresh
 * desktop session owns dozens of tools; serializing every schema on every
 * model round wastes thousands of input tokens and weakens tool selection.
 * Execution still resolves against the full set, and tools used in the recent
 * transcript remain advertised so multi-step work never loses its handles.
 */
export function selectToolsForTurn(tools: readonly EngineTool[], messages: readonly Message[]): readonly EngineTool[] {
  if (process.env.ARES_DYNAMIC_TOOLS === "0" || tools.length <= 12) return tools;

  let userText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    userText = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .toLowerCase();
    if (userText.trim()) break;
  }

  const wanted = new Set([
    "todowrite", "requestuseraction", "memory", "browser", "websearch",
    "webfetch", "imagesearch", "skillhub", "skillslist", "skillread",
  ]);
  const add = (...names: string[]) => names.forEach((name) => wanted.add(name.toLowerCase()));

  const coding = /\b(?:build|code|coding|implement|fix|debug|refactor|test|compile|html|css|javascript|typescript|python|repo|repository|file|folder|component|website|app|api|database|git|terminal|powershell|bash|install|package)\b/.test(userText)
    || /\b(?:make|create|design|develop|update|change)\b[^.?!]{0,80}\b(?:page|site|app|component|script|file|project)\b/.test(userText);
  const browser = /\b(?:browser|website|webpage|youtube|twitter|x\.com|google|search|navigate|tab|click|scroll|video|page|url|download)\b/.test(userText);
  const desktop = /\b(?:desktop|screen|window|mouse|keyboard|native app|computer use)\b/.test(userText);
  if (coding) {
    add(
      "read", "write", "edit", "applyintent", "glob", "grep", "codebasesearch",
      "lsp", "powershell", "bash", "findandedit", "codemode", "bashoutput",
      "killshell", "enterplanmode", "exitplanmode", "task", "conductor",
      "codingbackend", "deploy",
    );
  }
  if (browser) add("browser", "websearch", "webfetch", "imagesearch", "computeruse");
  if (desktop) add("computeruse", "powershell");
  if (/\b(?:email|mail|gmail)\b/.test(userText)) add("email", "gmail", "connect", "mcplisttools", "mcpcalltool");
  if (/\b(?:calendar|meeting|event|schedule)\b/.test(userText)) add("googlecalendar", "connect", "mcplisttools", "mcpcalltool");
  if (/\b(?:spotify|song|music|playlist)\b/.test(userText)) add("spotify", "connect");
  if (/\b(?:weather|forecast|temperature)\b/.test(userText)) add("weather");
  if (/\b(?:remind|reminder|alarm)\b/.test(userText)) add("remind");
  if (/\b(?:stripe|payment|invoice|subscription)\b/.test(userText)) add("stripe");
  if (/\b(?:deploy|publish|hosting|production)\b/.test(userText)) add("deploy");
  if (/\b(?:telegram)\b/.test(userText)) add("telegramsetup", "telegramroster", "connect");
  if (/\b(?:notion|slack|teams|drive|dropbox|github|gitlab|jira|atlassian|outlook|sharepoint|figma|box)\b/.test(userText)) add("connect", "mcplisttools", "mcpcalltool");
  if (/\b(?:skill|capability)\b/.test(userText)) add("skillcraft", "runskill", "skillhub", "skillslist", "skillread");
  if (/\b(?:mission|standing order|autonomous|operator)\b/.test(userText)) add("mission", "standingorder", "operator", "self", "selfevolve", "bootstrap");

  // Preserve schemas for recently used tools even if the newest user message is
  // a terse follow-up such as "do that again" or "now fix the second one".
  for (const message of messages.slice(-8)) {
    for (const block of message.content) {
      if (block.type === "tool_use" && typeof block.name === "string") wanted.add(block.name.toLowerCase());
    }
  }
  const selected = tools.filter((tool) => wanted.has(tool.schema.name.toLowerCase()));
  return selected.length > 0 ? selected : tools;
}

// ─── Context budgeting ─────────────────────────────────────────────────
//
// No tokenizer dependency: a ~4-chars/token heuristic plus a flat per-image
// cost. Good enough to keep a runaway thread from blowing the model's window —
// the goal is "never hard-fail with context_length_exceeded," not exactness.

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_FLOOR = 256; // a small image still costs something
const IMAGE_TOKEN_CAP = 2000; // providers downscale — per-image token cost is bounded
// A model only ever *charges* ~1600 tokens for a large image (it downscales),
// but the raw base64 payload still crosses the wire and hits the request-SIZE
// limit long before the token limit. So we bound token cost for window
// accounting (below) AND cap total image payload bytes separately (fitImagesToBudget).
const MAX_IMAGE_PAYLOAD_BYTES = (() => {
  const raw = Number(process.env.ARES_MAX_IMAGE_PAYLOAD_BYTES);
  // The binding limit is the DEFAULT transport: the Ares Gateway runs on Vercel,
  // whose serverless functions cap the request body at ~4.5MB and reject
  // overflow with a hard 413 (FUNCTION_PAYLOAD_TOO_LARGE) — no compaction, no
  // retry, just a dead turn. This cap is on DECODED bytes, but the wire body is
  // base64 (~1.33x bigger) plus the system prompt, tool defs, and text history,
  // so we leave generous headroom: 3MB decoded ≈ 4MB base64, fits under 4.5MB
  // with room for the rest. Anthropic-direct users (32MB API limit) who paste
  // large multi-image payloads can raise it via ARES_MAX_IMAGE_PAYLOAD_BYTES.
  return Number.isFinite(raw) && raw > 0 ? raw : 3 * 1024 * 1024;
})();

// Microcompact rung: cheaply clear OLD tool-output bodies (no model call) before
// the heavy summarizer fires, keeping the last N at full fidelity. Only bulky,
// re-derivable tool output (a Read can be re-Read, a Grep re-run) — assistant
// reasoning and user intent are never touched.
const MICROCOMPACT_TOOLS = new Set<string>([
  "Read", "Bash", "PowerShell", "Grep", "Glob", "WebSearch", "WebFetch",
  "CodebaseSearch", "Edit", "Write", "FindAndEdit",
]);
const MICROCOMPACT_KEEP_RECENT = 6;
const MICROCOMPACT_PLACEHOLDER =
  "[old tool output cleared to save context — re-run the tool or Read the file if you need it again]";

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Decoded byte size of a base64 payload (base64 encodes 3 bytes per 4 chars,
 *  minus padding). Cheap and allocation-free. */
function base64DecodedBytes(data: string): number {
  const len = data.length;
  if (len === 0) return 0;
  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/** A base64 image's token cost for WINDOW accounting is bounded — providers
 *  downscale, so even a huge frame charges ~1600 tokens, not the base64 length.
 *  We scale gently with decoded size (so many frames still add up and trigger
 *  image-dropping) but cap it, so one screenshot never falsely evicts real text.
 *  The wire-SIZE risk (a payload too big to send) is handled separately by
 *  MAX_IMAGE_PAYLOAD_BYTES in fitImagesToBudget. */
function estimateImageTokens(source: ImageBlock["source"]): number {
  if (source.kind === "base64") {
    const bytes = base64DecodedBytes(source.data);
    return Math.min(IMAGE_TOKEN_CAP, Math.max(IMAGE_TOKEN_FLOOR, Math.ceil(bytes / 900)));
  }
  return IMAGE_TOKEN_FLOOR; // url image — true size unknown, rough floor
}

/** Total decoded bytes of every base64 image in a message set — the real wire
 *  payload that must stay under the provider's request-size limit. */
function totalImagePayloadBytes(messages: readonly Message[]): number {
  let bytes = 0;
  const walk = (b: ContentBlock): void => {
    if (b.type === "image" && b.source.kind === "base64") bytes += base64DecodedBytes(b.source.data);
    else if (b.type === "tool_result" && Array.isArray(b.content)) {
      for (const c of b.content) walk(c as ContentBlock);
    }
  };
  for (const m of messages) for (const b of m.content) walk(b);
  return bytes;
}

function estimateBlockTokens(b: ContentBlock): number {
  switch (b.type) {
    case "text":
    case "thinking":
      return estimateTextTokens(b.text);
    case "system_reminder":
      return estimateTextTokens(b.text) + 8;
    case "tool_result":
      // tool_result content can be a string OR an array of text/image blocks
      // (ComputerUse returns screenshots here) — size each block for real.
      if (typeof b.content === "string") return estimateTextTokens(b.content);
      if (Array.isArray(b.content)) return b.content.reduce((s, c) => s + estimateBlockTokens(c as ContentBlock), 0);
      return estimateTextTokens(JSON.stringify(b.content));
    case "tool_use":
      return estimateTextTokens(b.name) + estimateTextTokens(JSON.stringify(b.input));
    case "image":
      return estimateImageTokens(b.source);
    default:
      return 0;
  }
}

function estimateMessageTokens(m: Message): number {
  let t = 8; // per-message role/framing overhead
  for (const b of m.content) t += estimateBlockTokens(b);
  return t;
}

/** A user message whose first block is a tool_result — would orphan into a
 *  function_call_output with no preceding call if it led the kept window. */
function leadsWithToolResult(m: Message): boolean {
  return m.role === "user" && m.content[0]?.type === "tool_result";
}

/** True when an assistant message carries nothing the user/model can act on —
 *  no non-whitespace text, no thinking, no tool calls. An end_turn with this is
 *  the "typing then nothing" silent-success path the engine must not bless. */
function messageHasNoVisibleOutput(m: Message): boolean {
  for (const b of m.content) {
    if (b.type === "tool_use") return false;
    if (b.type === "thinking" && b.text.trim()) return false;
    if (b.type === "text" && b.text.trim()) return false;
  }
  return true;
}

/**
 * Trim the OLDEST messages until the estimated total fits the budget. Always
 * keeps the final (pending) message and never leaves a leading orphan
 * tool_result. Returns the original array untouched when already within budget
 * or when budgeting is disabled.
 */
export function budgetMessages(
  messages: readonly Message[],
  budgetTokens: number,
  overheadTokens: number,
): { messages: Message[]; trimmed: number; dropped: Message[] } {
  if (budgetTokens <= 0 || messages.length <= 1) return { messages: [...messages], trimmed: 0, dropped: [] };
  let total = overheadTokens + messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  if (total <= budgetTokens) return { messages: [...messages], trimmed: 0, dropped: [] };

  const kept = [...messages];
  const dropped: Message[] = [];
  let trimmed = 0;
  while (total > budgetTokens && kept.length > 1) {
    const gone = kept.shift()!;
    total -= estimateMessageTokens(gone);
    dropped.push(gone);
    trimmed++;
  }
  while (kept.length > 1 && leadsWithToolResult(kept[0])) {
    const gone = kept.shift()!;
    total -= estimateMessageTokens(gone);
    dropped.push(gone);
    trimmed++;
  }
  return { messages: kept, trimmed, dropped };
}

const STALE_IMAGE_PLACEHOLDER = "[screenshot from an earlier step — omitted to save context]";

/**
 * Keep only the most recent `keepLast` images in the outbound history; replace
 * older ones (in tool_results or user content) with a text placeholder. A
 * vision-heavy loop (ComputerUse / browser) otherwise retains every screenshot,
 * and a dozen full frames balloon a single turn into millions of input tokens.
 * This rewrites only the OUTBOUND copy — the engine's stored history is intact.
 */
export function keepRecentImages(messages: readonly Message[], keepLast = 2): Message[] {
  let seen = 0;
  const out: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    let changed = false;
    const content = m.content.map((b): ContentBlock => {
      if (b.type === "image") {
        if (++seen > keepLast) {
          changed = true;
          return { type: "text", text: STALE_IMAGE_PLACEHOLDER };
        }
        return b;
      }
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        let innerChanged = false;
        const inner = b.content.map((c) => {
          if (c.type === "image") {
            if (++seen > keepLast) {
              innerChanged = true;
              return { type: "text" as const, text: STALE_IMAGE_PLACEHOLDER };
            }
          }
          return c;
        });
        if (innerChanged) {
          changed = true;
          return { ...b, content: inner };
        }
      }
      return b;
    });
    out.push(changed ? { ...m, content } : m);
  }
  return out.reverse();
}

/**
 * Trim images until the outbound payload fits the budget. budgetMessages drops
 * OLD whole messages, but the heaviest images are usually in the MOST RECENT
 * turn (a fresh ComputerUse screenshot) which budgeting must keep — so two
 * full-res frames alone can exceed the model's window. This drops images
 * (newest-kept-count 2 → 1 → 0) until the real estimate fits, guaranteeing we
 * never ship a payload over the limit even if it means sending zero screenshots.
 */
export function fitImagesToBudget(
  messages: readonly Message[],
  budgetTokens: number,
  overheadTokens: number,
): Message[] {
  for (const keep of [2, 1, 0]) {
    const trimmed = keepRecentImages(messages, keep);
    // Wire-size guard: even if the token budget says an image fits, a payload
    // over the provider's request-size limit hard-fails the call. Drop images
    // until BOTH the token estimate and the raw byte payload are safe.
    const payloadOk = totalImagePayloadBytes(trimmed) <= MAX_IMAGE_PAYLOAD_BYTES;
    if (budgetTokens <= 0) {
      if (payloadOk) return trimmed;
      continue;
    }
    const total = overheadTokens + trimmed.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (total <= budgetTokens && payloadOk) return trimmed;
  }
  return keepRecentImages(messages, 0);
}

/**
 * File paths referenced by tool_use blocks in a dropped history span — the
 * files whose contents the model can no longer see. Hosts use this to
 * invalidate read stamps so the Read re-read guard permits recovery reads.
 */
export function collectTrimmedFilePaths(dropped: readonly Message[]): string[] {
  const files = new Set<string>();
  for (const message of dropped) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as Record<string, unknown> | null;
      // Include the `file` alias: tool_use blocks are stored RAW (normalization
      // to file_path happens only at execution time), so a Read/Edit/Write that
      // came in as { file: ... } would otherwise leave the touched file off the
      // invalidation set and the re-read guard would block its recovery read.
      for (const key of ["file_path", "path", "notebook_path", "file"]) {
        const value = input?.[key];
        if (typeof value === "string" && value.trim()) files.add(value.trim());
      }
    }
  }
  return [...files];
}

/**
 * The context ledger — a deterministic digest of a dropped history span, so a
 * trimmed session keeps its bearings instead of going silently amnesiac.
 * No model call: user asks (first lines), tools used, and files touched are
 * extracted mechanically from the dropped messages. Capped hard.
 */
/** The file paths a summarized span was WORKING IN — the last `max` unique
 *  file_path inputs across Read/Edit/Write-class tool calls, most recent first.
 *  Feeds the post-compaction re-pin (current file state survives the summary). */
export function recentFilePathsFromSpan(span: readonly Message[], max: number): string[] {
  const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "ApplyIntent"]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = span.length - 1; i >= 0 && out.length < max; i--) {
    const m = span[i];
    if (m.role !== "assistant") continue;
    for (let j = m.content.length - 1; j >= 0 && out.length < max; j--) {
      const b = m.content[j] as { type?: string; name?: string; input?: { file_path?: unknown } };
      if (b.type !== "tool_use" || !b.name || !FILE_TOOLS.has(b.name)) continue;
      const fp = b.input?.file_path;
      if (typeof fp !== "string" || !fp.trim() || seen.has(fp)) continue;
      seen.add(fp);
      out.push(fp);
    }
  }
  return out;
}

export function buildContextLedger(dropped: readonly Message[]): string {
  if (dropped.length === 0) return "";
  const asks: string[] = [];
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();

  for (const message of dropped) {
    for (const block of message.content) {
      if (block.type === "text" && message.role === "user") {
        const firstLine = block.text.trim().split("\n")[0]?.trim();
        if (firstLine && asks.length < 6) asks.push(firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine);
      } else if (block.type === "tool_use") {
        toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
        const input = block.input as Record<string, unknown> | null;
        // `file` alias too — see collectTrimmedFilePaths; raw tool_use inputs
        // can carry the un-normalized key, so the ledger must list those files.
        for (const key of ["file_path", "path", "notebook_path", "file"]) {
          const value = input?.[key];
          if (typeof value === "string" && value.trim() && files.size < 24) files.add(value.trim());
        }
      }
    }
  }

  const lines = [`Context ledger — ${dropped.length} older message(s) were trimmed from your visible history to fit the model's context window. What that span contained:`];
  if (asks.length > 0) lines.push(`- Earlier user asks: ${asks.join(" | ")}`);
  if (toolCounts.size > 0) {
    const tools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => `${name}×${n}`);
    lines.push(`- Tools you already ran there: ${tools.join(", ")}`);
  }
  if (files.size > 0) lines.push(`- Files you already touched/read there: ${[...files].join(", ")}`);
  lines.push("Anything you remember doing in that span really happened — re-read files only if you need their CURRENT content. Stay on the original mission.");
  return lines.join("\n");
}

/**
 * Choose where to cut history for compaction: summarize the OLDEST messages,
 * keep the most recent `keepTokens` worth at full fidelity. Never splits a
 * tool_use from its tool_result (the kept window must not start with an orphan
 * tool_result), and always keeps at least `minKeep` recent messages. Returns
 * the split index — messages[0..split) get summarized, messages[split..] stay.
 * Returns 0 when there's nothing worth compacting.
 */
export function chooseCompactionSplit(
  messages: readonly Message[],
  keepTokens: number,
  minKeep = 4,
): number {
  if (messages.length <= minKeep + 1) return 0;
  // Walk from the newest message backward, accumulating tokens, until the kept
  // window is "full enough". Everything before that is the summarize span.
  let kept = 0;
  let split = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    kept += estimateMessageTokens(messages[i]);
    const keptCount = messages.length - i;
    if (kept >= keepTokens && keptCount >= minKeep) {
      split = i;
      break;
    }
    split = i;
  }
  // Don't leave the kept window opening on an orphan tool_result — pull the
  // boundary forward (keep more) until it leads cleanly.
  while (split < messages.length && leadsWithToolResult(messages[split])) {
    split++;
  }
  // Compacting fewer than 2 messages isn't worth a model call.
  if (split < 2) return 0;
  if (messages.length - split < minKeep) return 0;
  return split;
}

// ─── Implementation ────────────────────────────────────────────────────

export class QueryEngine {
  private readonly messages: Message[] = [];
  private readonly cfg: QueryEngineConfig;
  readonly sessionId: string;
  /** Per-turn abort controller — interrupt() stops the CURRENT turn without
   *  poisoning the session; the next turn gets a fresh controller. */
  private turnAbort: AbortController | null = null;
  /** An interrupt that arrived before this turn's controller existed (during the
   *  pre-stream preamble) — honored the instant the controller is created. */
  private interruptPending = false;
  /**
   * Live estimate→real token ratio, calibrated from the usage every provider
   * returns. The char-based estimator over-counts code/JSON and under-counts
   * dense scripts; this corrects budgeting/compaction to the model's ACTUAL
   * accounting so we never compact early or overflow late. 1.0 until the first
   * real datapoint; EWMA-smoothed and clamped so one weird turn can't wreck it.
   */
  private tokenScale = 1;
  /** Latest TodoWrite snapshot — so the end-of-turn gate can refuse a premature
   *  "done" while the model's own plan still has unfinished items. */
  private latestTodos: import("@ares/protocol").Todo[] = [];
  /** Whether the todo-completion gate has already fired this turn (fires once,
   *  then trusts the model — never an infinite "you have todos" loop). */
  private todoGateFired = false;
  /** Effort-dial override for the rest of THIS turn: set when a stalled attempt
   *  downgraded reasoning, cleared at the next turn start. */
  private turnReasoningOverride: ReasoningLevel | null = null;
  /** Did the previous tool round contain a failure? Failure recovery earns the
   *  full effort ceiling back (see tacticalReasoningLevel). */
  private lastRoundHadFailure = false;

  constructor(cfg: QueryEngineConfig, sessionId: string) {
    this.cfg = cfg;
    this.sessionId = sessionId;
  }

  /**
   * Task-adaptive reasoning dial. A reasoning model left on "high" burns minutes
   * (and tokens) thinking about "hi" or a one-line edit — the "stuck thinking
   * forever" complaint. This DOWN-shifts trivial turns and NEVER up-shifts past
   * the owner's chosen ceiling, so explicit control is preserved. Opt out with
   * ARES_ADAPTIVE_REASONING=0.
   */
  private effectiveReasoningLevel(): ReasoningLevel | undefined {
    // The most recent user turn's text (skip tool-result-only user messages).
    let text = "";
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "user") continue;
      const t = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (t) { text = t; break; }
    }
    return adaptiveReasoningLevel(this.cfg.reasoningLevel, text, process.env.ARES_ADAPTIVE_REASONING !== "0");
  }

  /**
   * The TACTICAL effort dial — deep thought where it pays, speed everywhere
   * else. A reasoning model at "max" burning a full thinking budget on EVERY
   * tool-loop continuation is the "worked 52s between two tool calls" complaint:
   * the opening plan deserves the ceiling; "I got the file contents, now call
   * Edit" does not. Policy: full ceiling on the FIRST model call of a turn and
   * whenever the previous round contained a tool failure (recovery = real
   * thinking); one notch lighter on routine continuations. Never up-shifts past
   * the owner's dial; ARES_TACTICAL_REASONING=0 opts out.
   */
  private tacticalReasoningLevel(iter: number): ReasoningLevel | undefined {
    const base = this.turnReasoningOverride ?? this.effectiveReasoningLevel();
    if (process.env.ARES_TACTICAL_REASONING === "0") return base;
    // Only high/max have a meaningful notch below; leave lighter dials alone.
    if (!base || base === "off" || base === "low" || base === "medium") return base;
    if (iter === 0 || this.lastRoundHadFailure) return base;
    return downshift(base, 1);
  }

  /** True when the trailing REAL user message is an autonomous work-item (goal
   *  mode: run/mission/operator/subagent) — the act-first tool_choice forcing
   *  applies only there, never to interactive chat. */
  private inGoalMode(): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "user") continue;
      if (!m.content.some((b) => b.type === "text")) continue; // tool-result plumbing
      return m.metadata?.source === "work-item";
    }
    return false;
  }

  /** Fold a real usage datapoint into the token-scale calibration (S4). */
  private calibrateTokens(estPromptTokens: number, usage: Usage): void {
    if (estPromptTokens < 500) return; // too small to be a stable signal
    // Provider adapters normalize inputTokens to total prompt tokens, including
    // cached reads/writes. Adding cache fields again double-counts OpenAI.
    const realPrompt = usage.inputTokens;
    if (realPrompt <= 0) return;
    const ratio = realPrompt / estPromptTokens;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const next = this.tokenScale * 0.7 + ratio * 0.3;
    this.tokenScale = Math.max(0.5, Math.min(2.5, next));
  }

  /**
   * Convert a tool's output to the model-facing tool_result text, capping size.
   * Over-budget results are SPILLED to disk in full and replaced with a head
   * preview + the file path the model can Read — so a giant file read or vision
   * dump never bloats the window or is silently truncated-and-lost (the old
   * behavior). Per-tool budget from schema.maxResultSizeChars (0 = uncapped, for
   * self-bounding tools); otherwise the engine default. Computed once and stored
   * in history, so the wire prefix stays prompt-cache-stable across turns.
   */
  private async capToolResultText(
    output: unknown,
    toolUseId: string,
    schema: ToolSchema,
    onSpillFailure?: (warning: string) => void,
  ): Promise<string> {
    const full = stringifyToolOutput(output);
    const budget = resolveToolResultBudget(schema);
    if (budget === 0 || full.length <= budget) return full;
    try {
      const dir = path.join(this.cfg.workspace, ".ares", "tool-results", this.sessionId);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${toolUseId}.txt`);
      await fs.writeFile(file, full, "utf8");
      const previewChars = Math.min(budget, 2_000);
      const omitted = full.length - previewChars;
      return `${full.slice(0, previewChars)}\n\n[tool result truncated for context: ${omitted} of ${full.length} chars omitted. FULL output saved to ${file} — Read that file (use offset/limit to page) for the rest.]`;
    } catch (err) {
      // Spill failed (read-only fs, disk full, etc.) — fall back to the prior
      // lossy truncation so the turn never dies on a bookkeeping error, but do
      // NOT swallow it silently: surface a warning so the model knows the full
      // output was dropped (not spilled to a Readable file) and can't trust the
      // "saved to <file>" affordance it would otherwise expect.
      const detail = err instanceof Error ? err.message : String(err);
      onSpillFailure?.(`tool result too large to spill to disk (${detail}) — output was truncated and the full text is NOT recoverable; re-run with a narrower scope if you need the rest`);
      return stringifyModelToolOutput(output);
    }
  }

  /** Stop the in-flight turn (provider stream + running tools see the abort).
   *  Safe to call when idle — the next turn is unaffected. */
  interrupt(): void {
    // A LIVE turn owns a controller — aborting it ends THIS turn, and that's all.
    // Only when there is no live controller (a Stop pressed in the gap before the
    // next turn arms its own, e.g. during the recall/compaction preamble) do we
    // carry the interrupt forward. Arming the pending flag while a turn is live was
    // the bug that let an interrupt leak into the FOLLOWING turn.
    if (this.turnAbort) this.turnAbort.abort();
    else this.interruptPending = true;
  }

  /** Called by the session the instant a turn's generator finishes (for any
   *  reason). Drops the live controller so a Stop between turns correctly arms the
   *  next turn instead of being swallowed by a stale, already-aborted controller. */
  markTurnEnded(): void {
    this.turnAbort = null;
  }

  /** The live signal for the current turn: external config signal merged with
   *  the per-turn interrupt controller. */
  private liveSignal(): AbortSignal {
    const turn = this.turnAbort?.signal;
    const outer = this.cfg.signal;
    if (turn && outer) return AbortSignal.any([turn, outer]);
    return turn ?? outer ?? new AbortController().signal;
  }

  /** Read-only snapshot of the conversation so far. */
  history(): readonly Message[] {
    return this.messages;
  }

  /** Change the reasoning dial mid-session — applies to the next turn. */
  setReasoningLevel(level: ReasoningLevel): void {
    this.cfg.reasoningLevel = level;
  }

  setMaxTurns(maxTurns: number | undefined): void {
    this.cfg.maxTurns = maxTurns;
  }

  /** Swap provider/model and all model-specific context controls in place. */
  setProvider(
    provider: Provider,
    model: string,
    context?: Pick<QueryEngineConfig, "contextBudgetTokens" | "compactionThresholdTokens" | "summarizeSpan">,
  ): void {
    this.cfg.provider = provider;
    this.cfg.model = model;
    if (context) {
      this.cfg.contextBudgetTokens = context.contextBudgetTokens;
      this.cfg.compactionThresholdTokens = context.compactionThresholdTokens;
      this.cfg.summarizeSpan = context.summarizeSpan;
    }
    this.tokenScale = 1;
  }

  hydrate(messages: readonly Message[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
  }

  /** Restore the last persisted TodoWrite snapshot on session resume. */
  hydrateTodos(todos: readonly import("@ares/protocol").Todo[]): void {
    this.latestTodos = todos.map((todo) => ({ ...todo }));
  }

  appendUserMessage(text: string): Message {
    return this.appendUserMessageContent([{ type: "text", text }]);
  }

  appendUserMessageContent(content: ContentBlock[]): Message {
    const message: Message = {
      id: cryptoId(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    return message;
  }

  /**
   * Seed a turn with a goal/work-item instead of a chat message. An autonomous
   * driver (operator step, subagent, Consciousness action) frames a directive
   * here rather than faking a user turn. It is still a trailing user-role message
   * (the API needs one to elicit an assistant turn), but tagged
   * `metadata.source = "work-item"` so chat-only consumers (intent gating,
   * episodic capture) can tell autonomous work from a real user message — the
   * one Crix chat-assumption baked into the loop's entry, generalized.
   */
  appendWorkItem(text: string): Message {
    const message: Message = {
      id: cryptoId(),
      role: "user",
      content: [{ type: "text", text }],
      createdAt: new Date().toISOString(),
      metadata: { source: "work-item" },
    };
    this.messages.push(message);
    return message;
  }

  /**
   * Smart compaction. When history exceeds the compaction threshold, summarize
   * the oldest span (via the host summarizer, or the deterministic ledger as a
   * fallback) into a single recap message and keep recent turns at full
   * fidelity. Mutates this.messages in place; returns the compaction event or
   * null. Never touches the pending user message (it stays last in `recent`).
   */
  /**
   * Microcompact rung — the cheap layer beneath compactIfNeeded. When history
   * passes ~60% of the heavy-compaction threshold, clear the BODIES of old
   * compactable tool_result blocks (keeping the most recent N) in place, with NO
   * model call. Bulky, re-derivable output (file reads, greps, vision dumps) is
   * what dominates a coding session's tokens; clearing it here usually keeps the
   * conversation under `threshold` so the expensive summarizer never fires —
   * and, unlike a blunt trim, it preserves every assistant reasoning step and
   * user message. Returns a UI event, or null when nothing was cleared.
   */
  private microcompactIfNeeded(): Extract<TurnEvent, { type: "system_reminder_injected" }> | null {
    const threshold =
      this.cfg.compactionThresholdTokens ??
      (this.cfg.contextBudgetTokens ? Math.floor(this.cfg.contextBudgetTokens * 0.8) : 0);
    if (threshold <= 0) return null;
    const est = this.messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (est * this.tokenScale <= threshold * 0.6) return null;

    // tool_result blocks only carry a tool_use_id — map ids to names via the
    // assistant's tool_use blocks to know which results are compactable.
    const compactableIds = new Set<string>();
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      for (const b of m.content) {
        if (b.type === "tool_use" && MICROCOMPACT_TOOLS.has(b.name)) compactableIds.add(b.id);
      }
    }
    if (compactableIds.size === 0) return null;

    // Keep the most recent N compactable results at full fidelity.
    const ordered: string[] = [];
    for (const m of this.messages) {
      for (const b of m.content) {
        if (b.type === "tool_result" && compactableIds.has(b.tool_use_id)) ordered.push(b.tool_use_id);
      }
    }
    const keep = new Set(ordered.slice(-MICROCOMPACT_KEEP_RECENT));

    let cleared = 0;
    let savedChars = 0;
    const clearedIds = new Set<string>();
    for (const m of this.messages) {
      for (const b of m.content) {
        if (
          b.type === "tool_result" &&
          compactableIds.has(b.tool_use_id) &&
          !keep.has(b.tool_use_id) &&
          typeof b.content === "string" &&
          b.content !== MICROCOMPACT_PLACEHOLDER
        ) {
          savedChars += b.content.length;
          b.content = MICROCOMPACT_PLACEHOLDER;
          clearedIds.add(b.tool_use_id);
          cleared++;
        }
      }
    }
    if (cleared === 0) return null;

    // The cleared Read/etc. bodies are GONE from the model's view — but their
    // read stamps survive. Without invalidating them, a recovery whole-file Read
    // trips the re-read guard and is told "its full contents are above / already
    // in context" — a flat LIE (the body is now the placeholder), and the model
    // edits blind. Heavy compaction avoids this via onHistoryTrimmed; microcompact
    // is a newer rung that bypassed it. Hand the host the tool_use blocks whose
    // output we cleared so it invalidates exactly those files' stamps.
    if (this.cfg.onHistoryTrimmed) {
      const clearedToolUses: Message[] = this.messages
        .filter((m) => m.role === "assistant")
        .map((m) => ({ ...m, content: m.content.filter((b) => b.type === "tool_use" && clearedIds.has(b.id)) }))
        .filter((m) => m.content.length > 0);
      if (clearedToolUses.length > 0) {
        try {
          this.cfg.onHistoryTrimmed(clearedToolUses);
        } catch {
          // host bookkeeping never kills a turn
        }
      }
    }
    return {
      type: "system_reminder_injected",
      text: `microcompacted ${cleared} old tool output(s) (~${Math.round(savedChars / CHARS_PER_TOKEN)} tokens freed) to defer heavy compaction`,
      source: "compaction",
    };
  }

  private async compactIfNeeded(): Promise<Extract<TurnEvent, { type: "compaction" }> | null> {
    const threshold =
      this.cfg.compactionThresholdTokens ??
      (this.cfg.contextBudgetTokens ? Math.floor(this.cfg.contextBudgetTokens * 0.8) : 0);
    if (threshold <= 0) return null;

    const estBefore = this.messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    // Compare in REAL tokens (calibrated) against the real-token threshold.
    if (estBefore * this.tokenScale <= threshold) return null;

    // Keep the most recent ~35% of the threshold at full fidelity. keepTokens is
    // in estimate units (chooseCompactionSplit sums the raw estimator), so divide
    // the real-token target back out by the calibration.
    const keepTokens = Math.max(4_000, Math.floor((threshold * 0.35) / this.tokenScale));
    const split = chooseCompactionSplit(this.messages, keepTokens);
    if (split <= 0) return null;

    const older = this.messages.slice(0, split);

    let summary = "";
    let method: "summary" | "ledger" = "summary";
    if (this.cfg.summarizeSpan) {
      try {
        // Thread the turn's live signal so a Stop during compaction aborts the
        // summarizer sub-model instead of letting it run to completion.
        summary = (await this.cfg.summarizeSpan(older, this.liveSignal())).trim();
      } catch {
        summary = "";
      }
    }
    if (!summary) {
      summary = buildContextLedger(older);
      method = "ledger";
    }
    if (!summary) return null;

    // Post-compact file re-injection: the summary remembers the WORK, but the
    // model also needs the CURRENT state of the files it was just editing —
    // without it, the first post-compaction edit is a blind edit against a
    // remembered (possibly stale) version. Re-pin the most recently touched
    // files from the summarized span, bounded so it can't undo the compaction.
    let filePins = "";
    for (const rel of recentFilePathsFromSpan(older, 5)) {
      const full = path.resolve(this.cfg.workspace, rel);
      try {
        const body = await fs.readFile(full, "utf8");
        if (body.length > 24_000) continue; // too big to re-pin — the model can Read it
        filePins += `\n\n=== CURRENT content of ${rel} (re-read after compaction) ===\n${body}`;
        if (filePins.length > 60_000) break;
      } catch {
        // deleted/unreadable since — skip
      }
    }

    const recap: Message = {
      id: cryptoId("compact"),
      role: "user",
      content: [
        {
          type: "system_reminder",
          text:
            `Compacted memory — the earlier part of this session was summarized to free context. ` +
            `Everything below really happened; treat it as established fact, do not redo it, and stay on the mission.\n\n${summary}` +
            (filePins
              ? `\n\nThe files you were working in, re-read AFTER compaction (this is their live current state — trust it over the summary):${filePins}`
              : ""),
        },
      ],
      createdAt: new Date().toISOString(),
    };

    // Persistently rewrite history to [recap, ...recent]. splice removes the
    // summarized span in place and prepends the recap, leaving the recent tail
    // (including the untouched pending user message) intact. Read stamps for
    // files in the summarized span are invalidated so recovery re-reads pass.
    this.messages.splice(0, split, recap);
    try {
      this.cfg.onHistoryTrimmed?.(older);
    } catch {
      // host bookkeeping never kills a turn
    }

    const estAfter = this.messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const tokensBefore = Math.round(estBefore * this.tokenScale);
    const tokensAfter = Math.round(estAfter * this.tokenScale);
    return {
      type: "compaction",
      summarizedMessages: older.length,
      tokensBefore,
      tokensAfter,
      method,
      messages: this.messages.map((message) => ({
        ...message,
        content: message.content.map((block) => ({ ...block })),
      })),
    };
  }

  // (compaction helper lives at module scope below: recentFilePathsFromSpan)

  async *streamTurn(): AsyncGenerator<TurnEvent> {
    const turnId = cryptoId("turn");
    const startedAt = Date.now();
    const userMessage = this.messages[this.messages.length - 1];
    if (!userMessage || userMessage.role !== "user") {
      throw new Error("streamTurn() requires a pending user message; call appendUserMessage() first");
    }

    // Arm the per-turn abort controller IMMEDIATELY — before turn_start, the
    // reminder yields, and (critically) the compaction model call below — so a
    // Stop pressed during the preamble actually aborts instead of no-opping.
    // Honor an interrupt that landed in the gap before this generator ran.
    this.turnAbort = new AbortController();
    if (this.interruptPending) this.turnAbort.abort();
    this.interruptPending = false;

    // Inject pending system-reminders into the user message before yielding
    // turn_start. The turn_start event remains first for stable rollout/daemon
    // consumers, and reminder telemetry follows immediately after.
    const reminders = this.cfg.drainSystemReminders?.() ?? [];
    // Reminders ride the FRONT of the pending user message — except when that
    // message carries tool_result blocks (resuming after an interrupted tool
    // batch, e.g. a mid-turn steer). Anthropic requires tool_result blocks to
    // be the first content of their message: a reminder unshifted ahead of
    // them 400s the request ("tool_use ids were found without tool_result
    // blocks immediately after"), and because this insert mutates persisted
    // history the same poison re-sends on every retry — a bricked session.
    // Insert after the last tool_result instead.
    const reminderInsertAt = userMessage.content.reduce(
      (after, block, index) => (block.type === "tool_result" ? index + 1 : after),
      0,
    );
    for (const r of reminders) {
      userMessage.content.splice(reminderInsertAt, 0, { type: "system_reminder", text: r.text });
    }

    yield { type: "turn_start", turnId, sessionId: this.sessionId, userMessage };
    for (const r of reminders) {
      yield { type: "system_reminder_injected", text: r.text, source: r.source };
    }

    // Microcompact rung (cheap, no model call): clear OLD tool-output bodies
    // first. This often keeps the conversation under the heavy-compaction
    // threshold so the expensive summarizer below never has to run.
    const micro = this.microcompactIfNeeded();
    if (micro) yield micro;

    // Smart compaction BEFORE the first model call: if the conversation has
    // grown past the threshold, summarize the old span into a recap and keep
    // recent turns whole — so a long session stays coherent instead of getting
    // its history bluntly trimmed mid-turn.
    const compaction = await this.compactIfNeeded();
    if (compaction) yield compaction;

    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
    let stopReason: StopReason = "end_turn";
    // Big autonomous builds legitimately run long; the adaptive convergence
    // guard below handles unproductive loops, so the hard ceiling is a
    // backstop, not a leash.
    const maxIters = this.cfg.maxTurns ?? 80;
    const gatherStallRounds = currentGatherStallRounds();
    // (turnAbort was already armed at the top of the turn — see above.)
    let ledgerAnnounced = false;
    let lastProgressIter = -1;
    let lastConvergenceIter = -Infinity;
    let endGateFired = 0;
    this.todoGateFired = false; // re-arm the todo-completion gate for this turn
    this.turnReasoningOverride = null; // effort dial resets each turn
    this.lastRoundHadFailure = false; // tactical dial starts clean
    // Signature of the last end-gate objection, so we can tell "the model made
    // progress on the failures" (new objection → keep pushing) from "the model
    // is stuck re-claiming done against the SAME red checks" (stop, but honestly).
    let lastGateSig = "";
    const END_GATE_HARDCAP = 6;
    // Repeated-failure circuit-breaker: tracks consecutive identical tool
    // failures (tool name + error signature). When the model bangs the same
    // dead approach, we inject a "change strategy" reminder instead of letting
    // it loop for minutes (e.g. retrying a missing browser install forever).
    const failStreak = new Map<string, number>();
    let breakerFired = false;
    // Failure signatures we've already asked memory about this turn (recall fires
    // at most once per distinct signature — no repeated lookups on every round).
    const recalledFailureSigs = new Set<string>();
    // S5 — signatures of every gather target seen this turn (novelty tracking).
    const seenGatherSigs = new Set<string>();
    // C3 — times we've auto-continued after the model hit its output-token cap.
    let maxTokensContinues = 0;
    // "typing then nothing" guard — times we've nudged the model after it ended
    // the turn with end_turn but EMPTY content (no text, no tool calls). Capped
    // at one retry so a model that genuinely has nothing to say still ends.
    let emptyTurnNudges = 0;
    // Loop precision (L-phase): catch spinning the failure-breaker misses —
    // identical SUCCESSFUL calls, A/B/A/B oscillation, and an absolute per-turn
    // tool-call ceiling. All fresh per turn, so lifecycle is automatic.
    const repeatStreak = new Map<string, number>();
    const roundSigHistory: string[] = [];
    let totalToolCalls = 0;
    let repeatBreakerFired = false;
    let oscillationFired = false;
    let ceilingNudged = false;
    // Coding completion truth. Tool-reported mutations arm the proof gate;
    // only a successful manual check or host verifier result AFTER the latest
    // mutation can mark the work verified.
    let lastMutationAt = 0;
    let manualVerificationAt = 0;
    let manualVerificationFailureCommand: string | null = null;
    let latestManualVerificationCommand: string | null = null;
    const changedFiles = new Set<string>();
    let proofGateFired = false;
    let unverifiedSurfaced = false;
    let workStatus: WorkStatus = "not_applicable";
    let verificationGenerationAtMutation = this.cfg.verificationEvidence?.().mutationGeneration ?? 0;
    const hasOutstandingVerification = (): boolean => this.cfg.outstandingVerificationRequired?.() === true;
    const hasPersistedVerificationDebt = (): boolean => this.cfg.persistedVerificationDebt?.() === true;
    const hasCompletePersistedVerificationScope = (): boolean => this.cfg.persistedVerificationScopeComplete?.() !== false;
    const requiresVerification = (): boolean => changedFiles.size > 0 || hasOutstandingVerification();
    const hasPostMutationProof = (): boolean => {
      const evidence = this.cfg.verificationEvidence?.();
      if (evidence) {
        const currentGenerationPassed =
          evidence.latestRunStatus === "passed" &&
          evidence.latestRunStrength === "behavioral" &&
          evidence.latestRunGeneration === evidence.mutationGeneration;
        if (
          currentGenerationPassed &&
          manualVerificationFailureCommand !== null
        ) {
          return false;
        }
        if (!currentGenerationPassed) {
          // Some file types have no automatic checker. A single anchored manual
          // command may satisfy that explicit no-check state, but can NEVER
          // override a failed/cancelled/superseded host run.
          const observedMutationAt = Math.max(lastMutationAt, this.cfg.observedMutationAt?.() ?? 0);
          const manualCoversPersistedOverflow = hasCompletePersistedVerificationScope() ||
            (latestManualVerificationCommand !== null && verificationCommandFamily(latestManualVerificationCommand) === latestManualVerificationCommand);
          return evidence.latestRunStatus === "no_checks" &&
            evidence.latestRunGeneration === evidence.mutationGeneration &&
            manualVerificationAt > 0 &&
            manualVerificationFailureCommand === null &&
            manualCoversPersistedOverflow &&
            (observedMutationAt === 0 || manualVerificationAt >= observedMutationAt);
        }
        // A current-turn mutation must cause a newer verifier generation. For
        // durable outstanding work, prepareUserTurn explicitly reschedules the
        // persisted touched files before streaming, so equality is expected.
        const hasCurrentTurnMutation = changedFiles.size > 0 || (this.cfg.observedMutationAt?.() ?? 0) > 0;
        if (
          hasPersistedVerificationDebt() &&
          !hasCompletePersistedVerificationScope()
        ) {
          return latestManualVerificationCommand !== null &&
            verificationCommandFamily(latestManualVerificationCommand) === latestManualVerificationCommand &&
            manualVerificationFailureCommand === null;
        }
        return hasPersistedVerificationDebt() && !hasCurrentTurnMutation
          ? true
          : (evidence.latestRunGeneration ?? -1) > verificationGenerationAtMutation;
      }
      return lastMutationAt > 0 &&
        manualVerificationFailureCommand === null &&
        manualVerificationAt >= lastMutationAt;
    };
    const resolvedWorkStatus = (): WorkStatus => {
      if (workStatus === "blocked") return "blocked";
      if (!requiresVerification()) return "not_applicable";
      return hasPostMutationProof() ? "verified" : "unverified";
    };

    for (let iter = 0; iter < maxIters; iter++) {
      // Honor a Stop at every iteration boundary — independent of provider
      // timing or whether a tool cooperated with its abort signal. Without this
      // an interrupt during/after a non-cooperative tool wouldn't be felt until
      // the next provider stream (many seconds), so Stop appeared dead.
      if (this.liveSignal().aborted) {
        yield { type: "turn_end", status: "interrupted", workStatus: resolvedWorkStatus(), usage: totalUsage, durationMs: Date.now() - startedAt };
        return;
      }
      // ─── Stream one assistant turn from the provider ─────────────────
      const pendingToolUses: Array<{ id: string; name: string; input: unknown }> = [];
      const toolNameById = new Map<string, string>();
      let assistantMessage: Message | null = null;
      let streamError: { code: string; message: string; retriable: boolean; retryAfterMs?: number } | null = null;

      try {
        const activeTools = selectToolsForTurn(this.cfg.tools, this.messages);
        const toolDescriptors = activeTools.map((t) => ({
          name: t.schema.name,
          description: t.schema.description,
          input_schema: t.schema.inputJsonSchema,
        }));
        const overheadTokens =
          estimateTextTokens(this.cfg.systemPrompt) +
          toolDescriptors.reduce(
            (s, t) => s + estimateTextTokens(t.name) + estimateTextTokens(t.description) + estimateTextTokens(JSON.stringify(t.input_schema)) + 8,
            0,
          );

        // Budget attempts are real-token targets; convert to estimate units via
        // the live calibration so budgetMessages (which sums the raw estimator)
        // enforces the model's ACTUAL window, not the char-heuristic's guess.
        const rawBudgetAttempts = contextBudgetAttempts(this.cfg.contextBudgetTokens ?? 0);
        const budgetAttempts = rawBudgetAttempts.map((b) => (b > 0 ? Math.max(1, Math.floor(b / this.tokenScale)) : b));
        let modelStarted = false;
        budgetLoop: for (let attempt = 0; attempt < budgetAttempts.length; attempt++) {
          // S1 — transient-failure retry. A retriable provider error (529
          // overloaded, 429, network blip, stream stall) that lands BEFORE any
          // model output is no longer a dead turn: back off and re-issue the
          // same request. Once tokens have streamed we can't safely re-issue, so
          // those surface as errors. Capped + abort-aware.
          let transientRetry = 0;
          retryStream: while (true) {
            pendingToolUses.length = 0;
            toolNameById.clear();
            assistantMessage = null;
            streamError = null;
            modelStarted = false;

            const budgeted = budgetMessages(this.messages, budgetAttempts[attempt], overheadTokens);
            if (budgeted.trimmed > 0) {
              // File contents in the dropped span are no longer visible to the
              // model — let the host invalidate read stamps so re-reads pass.
              try {
                this.cfg.onHistoryTrimmed?.(budgeted.dropped);
              } catch {
                // never let host bookkeeping kill a turn
              }
              // History was cut to fit — hand the model a deterministic ledger of
              // the dropped span so the mission survives the amnesia.
              const ledger = buildContextLedger(budgeted.dropped);
              if (ledger) {
                const head = budgeted.messages[0];
                if (head && head.role === "user") {
                  budgeted.messages[0] = {
                    ...head,
                    content: [{ type: "system_reminder" as const, text: ledger }, ...head.content],
                  };
                } else {
                  budgeted.messages.unshift({
                    id: cryptoId(),
                    role: "user",
                    content: [{ type: "system_reminder" as const, text: ledger }],
                    createdAt: new Date().toISOString(),
                  });
                }
                if (!ledgerAnnounced) {
                  ledgerAnnounced = true;
                  yield {
                    type: "system_reminder_injected",
                    text: `context ledger injected — ${budgeted.trimmed} trimmed message(s) summarized`,
                    source: "compaction",
                  };
                }
              }
            }
            // Drop screenshots until the payload actually fits the model window —
            // budget-aware, so a vision-heavy ComputerUse/browser loop can't ship
            // a prompt past the context limit (it keeps 2 recent frames, then 1,
            // then 0 as needed). budgetMessages already trimmed old whole messages.
            const outboundMessages = fitImagesToBudget(budgeted.messages, budgetAttempts[attempt], overheadTokens);
            const estPromptTokens =
              overheadTokens + outboundMessages.reduce((s, m) => s + estimateMessageTokens(m), 0);
            // Per-attempt abort: a stalled request is cut without killing the
            // turn — the stall guard fires it, the retry loop recovers.
            const attemptAbort = new AbortController();
            const stream = this.cfg.provider.stream({
              model: this.cfg.model,
              system: this.cfg.systemPrompt,
              messages: outboundMessages,
              tools: toolDescriptors,
              signal: AbortSignal.any([this.liveSignal(), attemptAbort.signal]),
              reasoningLevel: this.tacticalReasoningLevel(iter),
              maxOutputTokens: this.cfg.maxOutputTokens,
              // Act first: the opening call of an autonomous goal must DO
              // something (a tool call), not produce a plan-essay and stop.
              toolChoice: iter === 0 && this.inGoalMode() ? "any" : undefined,
              // Tactical phase for binary-dial reasoners: full think on the
              // opening call + failure recovery, skip the reasoning pass on
              // routine continuations. ARES_TACTICAL_REASONING=0 opts out.
              reasoningPhase:
                process.env.ARES_TACTICAL_REASONING !== "0" && iter > 0 && !this.lastRoundHadFailure
                  ? "routine"
                  : "deep",
            });

            let sawCommittedOutput = false;
            for await (const ev of guardStreamStalls(stream, {
              idleMs: streamIdleMs(),
              activeIdleMs: streamActiveIdleMs(),
              thinkCeilingMs: thinkCeilingMs(),
              onStall: () => attemptAbort.abort(),
            })) {
              if (
                ev.type === "error" &&
                isContextLimitError(ev.error) &&
                !modelStarted &&
                attempt < budgetAttempts.length - 1
              ) {
                streamError = ev.error;
                break;
              }

              // Forward every stream event to the consumer.
              yield ev;

              if (isModelOutputEvent(ev)) {
                modelStarted = true;
                if (ev.type !== "thinking_delta") sawCommittedOutput = true;
              }
              if (ev.type === "tool_use_start") {
                toolNameById.set(ev.id, ev.name);
              }
              if (ev.type === "tool_use_input_done") {
                const name = toolNameById.get(ev.id);
                if (name) pendingToolUses.push({ id: ev.id, name, input: ev.input });
              }
              if (ev.type === "message_done") {
                assistantMessage = ev.message;
                addUsageInto(totalUsage, ev.usage);
                stopReason = ev.stopReason;
                this.calibrateTokens(estPromptTokens, ev.usage);
              }
              if (ev.type === "error") {
                streamError = ev.error;
              }
            }

            // Some gateways occasionally close an otherwise healthy HTTP/SSE
            // response before sending a terminal message_done. When NOTHING was
            // committed, replaying the same request is safe and materially more
            // useful than failing the whole turn (production report
            // sess_ebed3deb). An owner interrupt is deliberately excluded: that
            // is handled as an interrupted turn below, never retried.
            if (!assistantMessage && !streamError && !this.liveSignal().aborted) {
              streamError = {
                code: "no_message_done",
                message: "provider closed stream without message_done",
                retriable: true,
              };
            }

            // Transient, pre-output failure → wait and retry the same request.
            // A stall is also retriable after thinking-only output: nothing was
            // committed to the conversation, so re-issuing is safe.
            if (
              streamError &&
              streamError.retriable &&
              !isContextLimitError(streamError) &&
              (!modelStarted || (isStallError(streamError) && !sawCommittedOutput)) &&
              !this.liveSignal().aborted &&
              transientRetry < MAX_TRANSIENT_RETRIES
            ) {
              transientRetry++;
              // Honor a server-provided reset window (Retry-After) when it's
              // longer than our exponential backoff — burning four 12s-capped
              // retries against a 30s 429 window just fails a turn that waiting
              // would have completed. The provider already clamps it to 60s.
              let waitMs = Math.max(transientBackoffMs(transientRetry), streamError.retryAfterMs ?? 0);
              let note = `provider hiccup (${streamError.code}); retrying in ${(waitMs / 1000).toFixed(1)}s — attempt ${transientRetry}/${MAX_TRANSIENT_RETRIES}`;
              if (isStallError(streamError)) {
                // Two consecutive stalls at the same window size usually mean the
                // provider is choking on the PROMPT itself (deepseek/ollama-cloud
                // stall silently on very large prompts) — re-issuing the same size
                // just burns another 90s of dead air. Shrink the history window
                // and go again instead (bug report 4a8ac088: 90s×2+ of silence).
                if (transientRetry >= 2 && !sawCommittedOutput && attempt < budgetAttempts.length - 1) {
                  yield {
                    type: "system_reminder_injected",
                    text: `Provider stalled ${transientRetry} times at this prompt size; retrying with a smaller recent-history window (${budgetAttempts[attempt + 1].toLocaleString()} tokens).`,
                    source: "compaction",
                  };
                  continue budgetLoop;
                }
                // The effort-dial cutoff: a stall already burned its wait — retry
                // promptly, one reasoning notch down (never below "low"), so the
                // turn completes at reduced effort instead of spinning forever.
                waitMs = 500;
                const current = this.turnReasoningOverride ?? this.effectiveReasoningLevel();
                if (process.env.ARES_STALL_DOWNGRADE !== "0" && current && current !== "off" && current !== "low") {
                  this.turnReasoningOverride = downshift(current, 1);
                  note = `${streamError.code === "reasoning_stall" ? "reasoning stalled" : "stream stalled"} at "${current}"; retrying at "${this.turnReasoningOverride}" — attempt ${transientRetry}/${MAX_TRANSIENT_RETRIES}`;
                } else {
                  note = `${streamError.code} — retrying — attempt ${transientRetry}/${MAX_TRANSIENT_RETRIES}`;
                }
              }
              yield { type: "system_reminder_injected", text: note, source: "instructions" };
              await abortableDelay(waitMs, this.liveSignal());
              if (this.liveSignal().aborted) break retryStream;
              continue retryStream;
            }
            break retryStream;
          }

          if (
            streamError &&
            isContextLimitError(streamError) &&
            !modelStarted &&
            attempt < budgetAttempts.length - 1
          ) {
            yield {
              type: "system_reminder_injected",
              text: `Provider rejected the prompt as too large; retrying with a smaller recent-history window (${budgetAttempts[attempt + 1].toLocaleString()} tokens).`,
              source: "compaction",
            };
            continue;
          }
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "error", error: { code: "provider_throw", message, retriable: false } };
        yield {
          type: "turn_end",
          status: "failed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      // guardStreamStalls intentionally swallows the AbortError raised while it
      // closes the provider iterator. Without this explicit branch, Stop fell
      // through to the missing-message guard and surfaced as a FAILED
      // `no_message_done` turn even though the abort worked.
      if (this.liveSignal().aborted) {
        yield {
          type: "turn_end",
          status: "interrupted",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      if (streamError) {
        // Provider-emitted errors were already forwarded from the stream. The
        // premature-close error is synthesized locally, so surface it once only
        // after its retry budget is exhausted.
        if (streamError.code === "no_message_done") {
          yield { type: "error", error: streamError };
        }
        yield {
          type: "turn_end",
          // A user interrupt surfaces as a provider abort error — report it as
          // interrupted, not failed.
          status: this.liveSignal().aborted ? "interrupted" : "failed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      if (!assistantMessage) {
        yield {
          type: "error",
          error: { code: "no_message_done", message: "provider closed stream without message_done", retriable: false },
        };
        yield {
          type: "turn_end",
          status: "failed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      this.messages.push(assistantMessage);

      // Reconcile the final message's tool_use blocks against what actually
      // streamed a tool_use_input_done. A provider can assemble a tool_use into
      // assistantMessage (from a content_block_start) yet never emit input_done —
      // e.g. the stream closed cleanly AFTER the block opened but BEFORE it
      // finished (a truncated-but-not-errored upstream, common on flaky links).
      // Such a call would never execute and never get a tool_result: on the next
      // request it's an orphan the model THINKS it ran. Add each to the run set
      // marked "truncated" so it gets a paired, correctable is_error instead —
      // the model re-issues it rather than believing it silently succeeded.
      const streamedToolIds = new Set(pendingToolUses.map((u) => u.id));
      const truncatedToolIds = new Set<string>();
      for (const block of assistantMessage.content) {
        if (block.type === "tool_use" && !streamedToolIds.has(block.id)) {
          truncatedToolIds.add(block.id);
          pendingToolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      // ─── Tool execution phase ────────────────────────────────────────
      if (pendingToolUses.length === 0) {
        // C3 — the model was cut off at its output-token ceiling mid-message
        // (no tool calls). Don't end the turn on a truncated answer: tell it to
        // continue exactly where it stopped, and loop. Capped so it can't spin.
        if (stopReason === "max_tokens" && maxTokensContinues < 3 && !this.liveSignal().aborted) {
          maxTokensContinues++;
          this.messages.push({
            id: cryptoId(),
            role: "user",
            content: [{
              type: "system_reminder",
              text: "Your previous message hit the output-token limit and was cut off mid-stream. Resume EXACTLY where you left off — pick up mid-thought, NO apology and NO recap, and do not repeat anything you already wrote. If a lot of work remains, break it into smaller pieces so each step fits within the limit instead of one giant output.",
            }],
            createdAt: new Date().toISOString(),
          });
          yield { type: "system_reminder_injected", text: "output truncated at token cap — continuing", source: "instructions" };
          continue;
        }
        // "Typing then nothing" guard: a valid message_done with end_turn but
        // EMPTY content (no text, no thinking, no tool calls) is the silent-success
        // path — the model produced literally nothing yet the turn ends "completed".
        // Nudge it once to actually produce output; if it stalls again, fall through
        // so the turn still ends instead of looping.
        if (
          stopReason === "end_turn" &&
          messageHasNoVisibleOutput(assistantMessage) &&
          emptyTurnNudges < 1 &&
          !this.liveSignal().aborted
        ) {
          emptyTurnNudges++;
          this.messages.push({
            id: cryptoId(),
            role: "user",
            content: [{
              type: "system_reminder",
              text: "You ended the turn without producing any output — no text and no tool calls. If the task is done, say so and summarize what you did; otherwise continue the work now.",
            }],
            createdAt: new Date().toISOString(),
          });
          yield { type: "system_reminder_injected", text: "empty assistant turn — nudging for output", source: "instructions" };
          continue;
        }
        // Todo-completion gate: if the model wrote a plan (TodoWrite) and is now
        // trying to end while items are still pending/in-progress, push back ONCE
        // — the "finish what you started" rule. Fires a single time per turn so a
        // genuinely-blocked plan can still end (the model just has to say why),
        // never an infinite loop. Skipped when aborted.
        if (
          !this.todoGateFired &&
          !this.liveSignal().aborted &&
          this.latestTodos.length > 0 &&
          hasUnfinishedTodos(this.latestTodos)
        ) {
          this.todoGateFired = true;
          const pending = this.latestTodos.filter((t) => t.status === "pending" || t.status === "in_progress");
          const list = pending.slice(0, 8).map((t) => `- [${t.status === "in_progress" ? ">" : " "}] ${t.status === "in_progress" ? t.activeForm : t.content}`).join("\n");
          this.messages.push({
            id: cryptoId(),
            role: "user",
            content: [{
              type: "system_reminder",
              text: `Your own todo list still has ${pending.length} unfinished item(s):\n${list}\nEither complete them now, or — if one is genuinely blocked or no longer needed — update the list (mark it done/removed) and state plainly why before finishing. Do not end with a silently-abandoned plan.`,
            }],
            createdAt: new Date().toISOString(),
          });
          yield { type: "system_reminder_injected", text: `todo gate: ${pending.length} unfinished item(s) — finish or explain`, source: "instructions" };
          continue;
        }
        // C1 end-of-turn gate: before accepting "done", give verification a
        // chance to object. The old logic fired at most twice then SILENTLY
        // accepted "done" even if checks were still red — which let the agent
        // declare victory over a failing build/test. New logic: keep pushing the
        // model as long as the objection is NEW (it's making progress), up to a
        // hard cap; but when it's stuck re-claiming done against the SAME red
        // checks (or hits the cap), end the turn HONESTLY — surface the failures
        // as UNRESOLVED rather than pretending success.
        if (this.cfg.confirmTurnEnd && !this.liveSignal().aborted) {
          let gateReminders: Array<{ text: string; source: "verifier" | "hook" }> = [];
          try {
            gateReminders = await this.cfg.confirmTurnEnd();
          } catch (err) {
            // FAIL CLOSED: a verifier that itself crashed (spawn failure, parse
            // error, settle() timeout rejection) must NOT silently bless the turn
            // as "completed" — that's the exact false-victory the gate exists to
            // prevent. Inject an UNRESOLVED objection so the model cannot claim
            // done over checks that never actually ran, and re-runs them.
            const detail = err instanceof Error ? err.message : String(err);
            gateReminders = [{
              text: `verification could not run: ${detail} — do not claim the task is complete; re-run the checks (build/test/typecheck) and confirm they pass before finishing.`,
              source: "verifier",
            }];
          }
          if (gateReminders.length > 0) {
            const sig = gateReminders.map((r) => r.text).join("");
            const stuck = sig === lastGateSig; // same objection as last time → no progress
            if (!stuck && endGateFired < END_GATE_HARDCAP) {
              lastGateSig = sig;
              endGateFired++;
              this.messages.push({
                id: cryptoId(),
                role: "user",
                content: gateReminders.map((r) => ({ type: "system_reminder" as const, text: r.text })),
                createdAt: new Date().toISOString(),
              });
              for (const r of gateReminders) {
                yield { type: "system_reminder_injected", text: r.text, source: r.source };
              }
              continue;
            }
            // Stuck or capped: do NOT loop forever, but do NOT bless it as done.
            // Surface every unresolved failure so the turn ends with the red
            // checks visible, not a clean "completed" over a broken result. The
            // turn STATUS stays "completed" (the loop terminated without hanging)
            // — escalation off the surfaced UNRESOLVED reminders is the harness's
            // job; see the C1-gate-honesty contract test.
            for (const r of gateReminders) {
              workStatus = "blocked";
              yield {
                type: "system_reminder_injected",
                text: `UNRESOLVED at turn end (verification still failing): ${r.text}`,
                source: r.source,
              };
            }
          }
        }
        // Post-edit proof gate. The verifier's empty reminder queue is NOT a
        // green verdict: it can also mean no command was derived or every tool
        // was skipped. Settle the normal end gate first, then require concrete
        // pass evidence newer than the last mutation. One retry gives the model
        // a chance to run the right package check; a second unsupported finish
        // ends honestly as UNVERIFIED rather than looping forever.
        if (
          this.cfg.requireVerificationEvidence &&
          workStatus !== "blocked" &&
          requiresVerification() &&
          !hasPostMutationProof() &&
          !this.liveSignal().aborted
        ) {
          workStatus = "unverified";
          if (!proofGateFired) {
            proofGateFired = true;
            const sample = [...changedFiles].slice(0, 8).map((file) => file.startsWith("<") ? file : path.relative(this.cfg.workspace, file)).join(", ");
            const scope = changedFiles.size > 0 ? `You changed ${changedFiles.size} file(s)` : "This long-running coding task still has unverified persisted changes";
            const text = `${scope}, but Ares has no complete all-green behavior-capable verifier run for the newest mutation generation${sample ? ` (${sample})` : ""}. Static syntax/type/lint checks are useful but do not prove requested behavior. Run the narrowest meaningful affected tests or real reproduction now. A skipped tool, an older run, one passing command inside a red run, or a verbal claim is not proof.`;
            this.messages.push({
              id: cryptoId(),
              role: "user",
              content: [{ type: "system_reminder", text }],
              createdAt: new Date().toISOString(),
            });
            yield { type: "system_reminder_injected", text, source: "verifier" };
            continue;
          }
          if (!unverifiedSurfaced) {
            unverifiedSurfaced = true;
            yield {
              type: "system_reminder_injected",
              text: "UNVERIFIED at turn end: coding changes remain, but no complete all-green behavior-capable check run is tied to the newest mutation generation. Static checks may pass, but requested behavior is not verified complete.",
              source: "verifier",
            };
          }
        } else if (requiresVerification() && hasPostMutationProof()) {
          workStatus = "verified";
        }
        // If we got here still capped at the output-token limit (the 3 auto-
        // continues at C3 were exhausted), the assistant's message is literally
        // truncated mid-stream. Don't let it read as a clean finish — say so, so
        // neither the model nor the user treats a chopped-off answer as complete.
        if (stopReason === "max_tokens" && !this.liveSignal().aborted) {
          yield {
            type: "system_reminder_injected",
            text: "Output is STILL truncated at the token cap after 3 continuations — this answer is INCOMPLETE, not a finished result.",
            source: "instructions",
          };
        }
        yield {
          type: "turn_end",
          status: this.liveSignal().aborted ? "interrupted" : "completed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      const resultByToolUseId = new Map<string, ToolResultBlock>();
      const runnable: Array<{ id: string; name: string; input: unknown; tool: EngineTool }> = [];
      for (const use of pendingToolUses) {
        // A tool_use that reached history but never finished streaming its
        // arguments (see reconciliation above): its args are partial, so do NOT
        // execute it — surface a correctable is_error so the model re-issues it.
        if (truncatedToolIds.has(use.id)) {
          const msg = `<tool_use_error>tool call '${use.name}' was truncated before its arguments finished streaming — re-issue it.</tool_use_error>`;
          yield { type: "tool_error", id: use.id, error: msg, durationMs: 0 };
          resultByToolUseId.set(use.id, { type: "tool_result", tool_use_id: use.id, content: msg, is_error: true });
          continue;
        }
        const tool = resolveEngineTool(this.cfg.tools, use.name);
        if (!tool) {
          const msg = `unknown tool: ${use.name}`;
          yield { type: "tool_error", id: use.id, error: msg, durationMs: 0 };
          resultByToolUseId.set(use.id, { type: "tool_result", tool_use_id: use.id, content: msg, is_error: true });
          continue;
        }

        // Malformed/truncated tool-call arguments: providers can't throw inside
        // their SSE stream (it fails the whole turn as provider_throw), so they
        // stash the correctable error under a sentinel key. Surface it here as a
        // per-tool is_error — exactly like the unknown-tool branch — so the model
        // re-emits valid JSON, instead of letting parseToolInputLenient strip the
        // key and report an opaque "<field>: Required".
        const argErr = toolArgsError(use.input);
        if (argErr) {
          yield { type: "tool_error", id: use.id, error: argErr, durationMs: 0 };
          resultByToolUseId.set(use.id, { type: "tool_result", tool_use_id: use.id, content: argErr, is_error: true });
          continue;
        }

        runnable.push({
          ...use,
          name: tool.schema.name,
          input: normalizeToolInput(tool.schema.name, use.input),
          tool,
        });
      }

      let interruptedByTool = false;
      for (const batch of buildDepAwareBatches(runnable, this.cfg.workspace)) {
        // Capture BEFORE yielding tool events to the host: Session/UI consumers
        // schedule verification while tool_end is yielded, so reading the
        // generation after yield would mistake the new generation for baseline.
        const verificationGenerationBeforeBatch = this.cfg.verificationEvidence?.().mutationGeneration ?? verificationGenerationAtMutation;
        const outcomes = yield* this.runToolBatch(batch);
        for (const outcome of outcomes) {
          resultByToolUseId.set(outcome.toolUseId, outcome.result);
          interruptedByTool ||= outcome.interrupted === true;
          if (outcome.touchedFiles?.length) {
            verificationGenerationAtMutation = verificationGenerationBeforeBatch;
            lastMutationAt = Math.max(lastMutationAt, outcome.finishedAt ?? Date.now());
            for (const file of outcome.touchedFiles) changedFiles.add(file);
            workStatus = "unverified";
          } else if (outcome.potentialMutation) {
            verificationGenerationAtMutation = verificationGenerationBeforeBatch;
            lastMutationAt = Math.max(lastMutationAt, outcome.finishedAt ?? Date.now());
            changedFiles.add("<shell-mediated workspace changes>");
            workStatus = "unverified";
          }
          if (outcome.verificationPassed) {
            if (
              !manualVerificationFailureCommand ||
              verificationCommandCovers(outcome.verificationCommand ?? "", manualVerificationFailureCommand)
            ) {
              manualVerificationAt = Math.max(manualVerificationAt, outcome.finishedAt ?? Date.now());
              latestManualVerificationCommand = outcome.verificationCommand ?? null;
              manualVerificationFailureCommand = null;
            }
          } else if (outcome.verificationAttempted) {
            manualVerificationFailureCommand = outcome.verificationCommand ?? "unknown verification command";
          }
        }
        if (interruptedByTool) {
          fillMissingToolResults(pendingToolUses, resultByToolUseId, "tool skipped after permission interruption");
          this.messages.push({
            id: cryptoId(),
            role: "user", // Anthropic shape: tool_result blocks live in user-role messages
            content: orderedToolResults(pendingToolUses, resultByToolUseId),
            createdAt: new Date().toISOString(),
          });
          yield {
            type: "turn_end",
            status: "interrupted",
            workStatus: resolvedWorkStatus(),
            usage: totalUsage,
            durationMs: Date.now() - startedAt,
          };
          return;
        }
      }

      // Feed all tool results back as one user-role message containing
      // tool_result content blocks (Anthropic SDK shape).
      this.messages.push({
        id: cryptoId(),
        role: "user",
        content: orderedToolResults(pendingToolUses, resultByToolUseId),
        createdAt: new Date().toISOString(),
      });

      // ── repeated-failure circuit-breaker ────────────────────────────────
      // Track this round's failures by (tool, error-signature). Any signature
      // seen 3× in a row means the model is looping a dead approach.
      const seenThisRound = new Set<string>();
      const errorTextBySig = new Map<string, string>();
      for (const use of pendingToolUses) {
        const result = resultByToolUseId.get(use.id);
        if (result?.is_error) {
          const errText = typeof result.content === "string" ? result.content : "";
          const sig = `${use.name}:${failureSignature(errText)}`;
          seenThisRound.add(sig);
          errorTextBySig.set(sig, errText);
          failStreak.set(sig, (failStreak.get(sig) ?? 0) + 1);
        }
      }
      // reset streaks for signatures that did NOT recur this round
      for (const sig of [...failStreak.keys()]) {
        if (!seenThisRound.has(sig)) failStreak.delete(sig);
      }
      // ── failure-signature recall ──────────────────────────────────────────
      // The SECOND identical failure is the moment to intervene — the model is
      // repeating a mistake but the breaker hasn't given up yet. Ask the host if
      // it remembers fixing this exact failure and inject the known fix, so the
      // agent applies its OWN past solution instead of flailing into the breaker.
      if (this.cfg.recallFailureFix) {
        for (const [sig, count] of failStreak.entries()) {
          if (count === 2 && !recalledFailureSigs.has(sig)) {
            recalledFailureSigs.add(sig);
            const tool = sig.split(":")[0];
            const hint = await this.cfg
              .recallFailureFix({ tool, signature: sig, error: errorTextBySig.get(sig) ?? "" })
              .catch(() => null);
            if (hint && hint.trim()) {
              this.messages.push({
                id: cryptoId(),
                role: "user",
                content: [{
                  type: "system_reminder",
                  text: `RECALLED FIX — you've hit this ${tool} failure before. Last time it was resolved by: ${hint.trim()}\nApply this before trying anything else.`,
                }],
                createdAt: new Date().toISOString(),
              });
              yield { type: "system_reminder_injected", text: `failure-recall: known fix for ${tool} surfaced`, source: "instructions" };
            }
          }
        }
      }
      const stuckSig = [...failStreak.entries()].find(([, n]) => n >= 3)?.[0];
      if (stuckSig && !breakerFired) {
        breakerFired = true;
        const toolName = stuckSig.split(":")[0];
        this.messages.push({
          id: cryptoId(),
          role: "user",
          content: [{
            type: "system_reminder",
            text: `STOP — you've called ${toolName} 3 times with the same failure. This approach is dead. Do NOT retry it or try to "install/fix" it. Either (a) achieve the goal a completely different way with a different tool, or (b) tell the user plainly what is blocked and what you'd need. For a missing browser, use WebFetch or ImageSearch instead. For anything else, change strategy now.`,
          }],
          createdAt: new Date().toISOString(),
        });
        yield { type: "system_reminder_injected", text: `circuit-breaker: ${toolName} dead-loop — forcing a strategy change`, source: "instructions" };
      } else if (!stuckSig) {
        breakerFired = false; // re-arm once the loop clears
      }

      // ── identical-call (no-op loop) + oscillation detectors ─────────────
      // The failure breaker only catches repeated FAILURES. These catch a model
      // re-issuing the identical SUCCESSFUL call (a no-op loop — e.g. the same
      // TodoWrite every round to game the gather-stall) and A/B/A/B oscillation.
      const roundSigs = new Set<string>();
      for (const use of pendingToolUses) roundSigs.add(canonicalCallSignature(use.name, use.input));
      for (const sig of roundSigs) repeatStreak.set(sig, (repeatStreak.get(sig) ?? 0) + 1);
      for (const sig of [...repeatStreak.keys()]) if (!roundSigs.has(sig)) repeatStreak.delete(sig);
      const repeatedSig = [...repeatStreak.entries()].find(([, n]) => n >= repeatCallLimit())?.[0];
      if (repeatedSig && !repeatBreakerFired) {
        repeatBreakerFired = true;
        // Show the REAL tool name, not the lowercased canonical key.
        const toolName = pendingToolUses.find((u) => canonicalCallSignature(u.name, u.input) === repeatedSig)?.name ?? repeatedSig.split("::")[0];
        this.messages.push({
          id: cryptoId(),
          role: "user",
          content: [{
            type: "system_reminder",
            text: `You've issued the identical ${toolName} call ${repeatCallLimit()} times in a row with no new input — a no-op loop even though it succeeds. Use the result you already have, or change approach.`,
          }],
          createdAt: new Date().toISOString(),
        });
        yield { type: "system_reminder_injected", text: `loop-guard: identical ${toolName} call repeated — nudging to converge`, source: "instructions" };
      } else if (!repeatedSig) {
        repeatBreakerFired = false; // re-arm once the repeat clears
      }

      const roundSig = [...roundSigs].sort().join("|");
      roundSigHistory.push(roundSig);
      if (roundSigHistory.length > 6) roundSigHistory.shift();
      const h = roundSigHistory;
      if (
        h.length >= 4 &&
        h[h.length - 1] === h[h.length - 3] &&
        h[h.length - 2] === h[h.length - 4] &&
        h[h.length - 1] !== h[h.length - 2] &&
        !oscillationFired
      ) {
        oscillationFired = true;
        this.messages.push({
          id: cryptoId(),
          role: "user",
          content: [{
            type: "system_reminder",
            text: `You are oscillating between two states without converging — pick ONE direction and commit, or tell the user what's blocking the decision.`,
          }],
          createdAt: new Date().toISOString(),
        });
        yield { type: "system_reminder_injected", text: "loop-guard: A/B oscillation detected — commit to one path", source: "instructions" };
      }

      // C1 mid-turn drain: verification that finished while tools ran reaches
      // the model NOW, in the same turn — not after it has already claimed done.
      const midTurn = this.cfg.drainSystemReminders?.() ?? [];
      if (midTurn.length > 0) {
        const last = this.messages[this.messages.length - 1];
        for (const r of midTurn) {
          last.content.push({ type: "system_reminder", text: r.text });
          yield { type: "system_reminder_injected", text: r.text, source: r.source };
        }
      }

      // Adaptive convergence guard: a build that is WRITING (edits, shells,
      // todos, subagents) may run as long as it needs — and a research turn
      // that is acquiring NEW sources (S5 novelty) is making progress too.
      // Only a model truly spinning (re-fetching the same URL, re-running the
      // same search with nothing new) trips the stall. Re-arms after each stall.
      let novelGather = false;
      for (const use of pendingToolUses) {
        if (!GATHER_TOOLS.has(use.name)) continue;
        const sig = gatherSignature(use.name, use.input);
        if (sig && !seenGatherSigs.has(sig)) {
          seenGatherSigs.add(sig);
          novelGather = true;
        }
      }
      if (novelGather || pendingToolUses.some((use) => PROGRESS_TOOLS.has(use.name))) {
        lastProgressIter = iter;
      }
      const gatherStall = iter - Math.max(lastProgressIter, lastConvergenceIter) >= gatherStallRounds;
      if (gatherStall) {
        lastConvergenceIter = iter;
        this.messages.push({
          id: cryptoId(),
          role: "user",
          content: [{
            type: "system_reminder",
            text: `You've made ${gatherStallRounds} consecutive tool rounds without producing anything (no edits, shells, todos, or subagents) — STOP gathering and act: either make the change / write the deliverable now with what you already have, or tell the user precisely what is blocking you. If the user asked to SEE images, include the URLs/screenshots you already captured. Do not start new searches, fetches, or browser actions before delivering.`,
          }],
          createdAt: new Date().toISOString(),
        });
        yield { type: "system_reminder_injected", text: "convergence: gather-stall detected — deliver now", source: "instructions" };
      }

      // Tactical dial input: a failed round earns the full effort ceiling back
      // on the next model call (recovery deserves real thinking).
      this.lastRoundHadFailure = pendingToolUses.some(
        (u) => resultByToolUseId.get(u.id)?.is_error === true,
      );

      // ── absolute per-turn tool-call ceiling (graceful end) ──────────────
      totalToolCalls += pendingToolUses.length;
      const ceiling = toolCallCeiling();
      if (totalToolCalls >= Math.floor(ceiling * 0.85) && !ceilingNudged) {
        ceilingNudged = true;
        this.messages.push({
          id: cryptoId(),
          role: "user",
          content: [{
            type: "system_reminder",
            text: `You're approaching this turn's tool-call ceiling (${totalToolCalls}/${ceiling}). Wrap up: deliver what you have now or state precisely what's blocking you.`,
          }],
          createdAt: new Date().toISOString(),
        });
        yield { type: "system_reminder_injected", text: "convergence: approaching tool-call ceiling — deliver now", source: "instructions" };
      }
      if (totalToolCalls >= ceiling) {
        // The tool_result for this round is already pushed above (no orphan
        // tool_use). End the turn — but do NOT blindly bless it "completed":
        // this exit lives in the tool branch and never reaches the end-gate, so
        // a turn that burned its whole budget on FAILING calls would otherwise be
        // reported as a clean success (false victory). If the final round was
        // nothing but errors, end "failed" and say so; otherwise end gracefully
        // with partial work preserved.
        const roundAllErrored =
          pendingToolUses.length > 0 && pendingToolUses.every((u) => resultByToolUseId.get(u.id)?.is_error === true);
        yield {
          type: "system_reminder_injected",
          text: roundAllErrored
            ? `Hit the tool-call ceiling (${totalToolCalls}/${ceiling}) with the final round entirely failing — turn ends UNRESOLVED, the work is NOT complete.`
            : `Hit the tool-call ceiling (${totalToolCalls}/${ceiling}) — turn ends with work possibly incomplete; partial results are preserved.`,
          source: "instructions",
        };
        // Status stays "completed" (the loop terminated without hanging) — the
        // honesty is carried by the UNRESOLVED reminder above, consistent with
        // the C1 end-gate contract (status reflects loop-termination; work-quality
        // failures are surfaced via reminders, not the status field).
        yield {
          type: "turn_end",
          status: "completed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      // Loop continues: provider will see the new tool_result message.
      void stopReason; // tracked for telemetry; not used to break the loop
    }

    // Exceeded maxTurns
    yield {
      type: "error",
      error: { code: "max_turns_exceeded", message: `exceeded ${maxIters} turn iterations`, retriable: false },
    };
    yield {
      type: "turn_end",
      status: "failed",
      workStatus: resolvedWorkStatus(),
      usage: totalUsage,
      durationMs: Date.now() - startedAt,
    };
  }

  private async *runToolBatch(
    uses: readonly ResolvedToolUse[],
  ): AsyncGenerator<TurnEvent, ToolExecutionOutcome[], void> {
    if (uses.length === 0) return [];

    const queue = new AsyncEventQueue<TurnEvent>();
    const outcomes: Array<ToolExecutionOutcome | undefined> = new Array(uses.length);
    let finished = 0;

    // Bounded concurrency: a batch of independent tools (disjoint Edits, or a
    // fan-out of Task subagents) runs in parallel, but at most N at a time so a
    // model emitting 20 Task calls can't open 20 concurrent provider streams.
    // Order is still deterministic — every result lands in outcomes[index]
    // regardless of finish order. ARES_MAX_TOOL_CONCURRENCY overrides the default.
    const limit = Math.min(toolConcurrencyLimit(), uses.length);
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex++;
        if (index >= uses.length) return;
        const use = uses[index];
        try {
          outcomes[index] = await this.executeToolUse(use, (event) => queue.push(event));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          queue.push({ type: "tool_error", id: use.id, error: message, durationMs: 0 });
          // A sibling's failure never poisons the others — it becomes its own
          // error result and the batch keeps draining.
          outcomes[index] = {
            toolUseId: use.id,
            interrupted: this.cfg.permissionDenialInterrupts !== false && isPermissionDeniedError(err),
            result: { type: "tool_result", tool_use_id: use.id, content: message, is_error: true },
          };
        } finally {
          finished++;
          queue.wake();
        }
      }
    };
    const workers = Array.from({ length: limit }, () => runWorker());

    while (finished < uses.length || queue.length > 0) {
      const event = await queue.shift();
      if (event) yield event;
    }

    await Promise.all(workers);
    return outcomes.filter((outcome): outcome is ToolExecutionOutcome => outcome !== undefined);
  }

  private async executeToolUse(
    use: ResolvedToolUse,
    emit: (event: TurnEvent) => void,
  ): Promise<ToolExecutionOutcome> {
    const preHook = this.cfg.hookManager
      ? await this.cfg.hookManager.run({
          event: "PreToolUse",
          toolName: use.name,
          input: use.input,
          workspace: this.cfg.workspace,
        })
      : null;
    if (preHook?.blocked) {
      const msg = preHook.reminders[0] ?? `PreToolUse hook blocked ${use.name}`;
      emit({ type: "tool_error", id: use.id, error: msg, durationMs: 0 });
      return {
        toolUseId: use.id,
        result: { type: "tool_result", tool_use_id: use.id, content: msg, is_error: true },
      };
    }

    if (shouldCheckpointBeforeTool(use.tool) && this.cfg.beforeToolUseCheckpoint) {
      // Declared single-file target (Edit/Write) → the host can snapshot
      // incrementally instead of walking the whole workspace before EVERY edit.
      const deps = analyzeToolDeps(use, this.cfg.workspace);
      // ARMOR: a checkpoint is a SAFETY NET, not a precondition — a snapshot
      // failure (locked file mid-walk, disk hiccup) must degrade to "no undo
      // for this call", never kill the tool. A real Write died on a checkpoint
      // EPERM before this guard existed.
      let checkpoint: { checkpointId: string; label?: string } | null = null;
      try {
        checkpoint = await this.cfg.beforeToolUseCheckpoint({
          toolUseId: use.id,
          toolName: use.name,
          input: use.input,
          safety: use.tool.schema.safety,
          targetFiles: deps.target && !deps.solo ? [deps.target] : undefined,
        });
      } catch (err) {
        emit({
          type: "system_reminder_injected",
          text: `checkpoint failed (${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}) — proceeding without undo for this call`,
          source: "instructions",
        });
      }
      if (checkpoint) {
        emit({
          type: "checkpoint_created",
          checkpointId: checkpoint.checkpointId,
          label: checkpoint.label,
          toolUseId: use.id,
          reason: "pre_tool",
        });
      }
    }

    emit({
      type: "tool_start",
      id: use.id,
      name: use.name,
      input: use.input,
      providerHint: use.tool.schema.providerHint,
      activityDescription: describeActivity(use.name, use.input),
    });

    const t0 = Date.now();
    try {
      // Holds the live watchdog control for THIS call so the permission prompt
      // can pause the clock (set below once withWatchdog invokes run()).
      let watchdog: WatchdogControl = NOOP_WATCHDOG;
      const ctx: ToolCallContext = {
        workspace: this.cfg.workspace,
        signal: this.liveSignal(),
        requestPermission: this.cfg.requestPermission
          ? async (request) => {
              const id = cryptoId("perm");
              const requestWithId = { ...request, id };
              emit({
                type: "permission_request",
                id,
                toolName: request.toolName,
                input: request.input,
                reason: request.reason,
                suggestion: request.suggestion,
              });
              // The human approval wait must NOT count against the tool watchdog
              // — the tool hasn't run yet, it's only waiting for a click. Pause
              // the clock across the prompt; the FULL deadline re-arms once the
              // decision lands, so the tool gets its real execution budget.
              //
              // But the wait is NOT infinite: if the host's prompt is broken or
              // unanswerable (a real 23-minute hang traced here — the raw-stderr
              // prompt was painted over by the TUI), a generous ceiling converts
              // the eternal wedge into a correctable deny the model can react to.
              watchdog.pause();
              try {
                const waitMs = Number(process.env.ARES_PERMISSION_WAIT_MS) > 0 ? Number(process.env.ARES_PERMISSION_WAIT_MS) : 10 * 60_000;
                let ceiling: ReturnType<typeof setTimeout> | undefined;
                const decision = await Promise.race([
                  this.cfg.requestPermission!(requestWithId),
                  new Promise<PermissionPromptDecision>((resolve) => {
                    ceiling = setTimeout(() => resolve("deny"), waitMs);
                    ceiling.unref?.();
                  }),
                ]).finally(() => clearTimeout(ceiling));
                emit({ type: "permission_response", id, decision });
                return decision;
              } finally {
                watchdog.resume();
              }
            }
          : undefined,
        emitProgress: (data) => emit({ type: "tool_progress", id: use.id, data }),
        fileReadStamps: this.cfg.fileReadStamps,
      };
      // Watchdog: bound this single tool call. The MERGED child signal replaces
      // ctx.signal so the tool's own fetch/child aborts on timeout — turning the
      // 5-minute hang into a fast, correctable is_error the model can adapt to.
      const result = await withWatchdog(
        watchdogTimeoutMsFor(use.tool.schema),
        this.liveSignal(),
        (signal, control) => {
          watchdog = control;
          return use.tool.call(use.input, { ...ctx, signal });
        },
      );
      const durationMs = Date.now() - t0;
      emit({
        type: "tool_end",
        id: use.id,
        output: result.output,
        touchedFiles: result.touchedFiles,
        durationMs,
        display: result.display,
      });
      if (use.name === "TodoWrite" && isTodoOutput(result.output)) {
        this.latestTodos = result.output.todos;
        emit({ type: "todo_updated", todos: result.output.todos });
      }
      if (this.cfg.hookManager) {
        // Guard the success-path hook the same way the catch-path one is: a
        // throwing PostToolUse hook must NOT fall through to the catch and
        // overwrite a tool that already SUCCEEDED (tool_end was emitted above)
        // with an is_error — that would lie to the model and risk re-running a
        // committed Write/Edit/Bash.
        try {
          await this.cfg.hookManager.run({
            event: "PostToolUse",
            toolName: use.name,
            input: use.input,
            output: result.output,
            workspace: this.cfg.workspace,
          });
        } catch {
          // a hook failure can never invalidate a successful tool result
        }
      }
      const modelText = await this.capToolResultText(result.output, use.id, use.tool.schema, (warning) =>
        emit({ type: "system_reminder_injected", text: `${use.name}: ${warning}`, source: "instructions" }),
      );
      const resultContent: ToolResultBlock["content"] =
        result.images && result.images.length > 0
          ? [
              { type: "text", text: modelText },
              ...result.images.map((img) => ({
                type: "image" as const,
                source: { kind: "base64" as const, mediaType: img.mediaType, data: img.data },
              })),
            ]
          : modelText;
      return {
        toolUseId: use.id,
        touchedFiles: result.touchedFiles,
        finishedAt: Date.now(),
        verificationAttempted: isManualVerificationCall(use.name, use.input),
        verificationCommand: manualVerificationCommand(use.name, use.input) ?? undefined,
        verificationPassed: isSuccessfulVerificationCall(use.name, use.input, result.output),
        potentialMutation: isPotentialCodeMutationCall(use.name, use.input),
        result: {
          type: "tool_result",
          tool_use_id: use.id,
          content: resultContent,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      // A watchdog abort gets an actionable message so the model changes course
      // instead of re-trying the same hang. Stays is_error so the circuit-breaker
      // accounting (failStreak) still counts it as a failure signal.
      const message =
        err instanceof ToolWatchdogError
          ? use.tool.schema.safety === "external-state"
            ? // An aborted fetch only stops the CLIENT — a POST that reached the
              // server may have COMMITTED. Never invite a blind retry (double
              // charge / double send); tell the model to verify first.
              `Tool ${use.name} exceeded its ${err.toolMs}ms watchdog and was aborted — but it MAY have already taken effect on the remote service. Do NOT blindly retry; verify the outcome first, then decide.`
            : `Tool ${use.name} exceeded its ${err.toolMs}ms watchdog and was aborted — result unavailable. Try a narrower input, a different approach, or proceed without it.`
          : err instanceof Error
            ? err.message
            : String(err);
      emit({ type: "tool_error", id: use.id, error: message, durationMs });
      if (this.cfg.hookManager) {
        // The PostToolUse hook runs in the catch path: a throw here would mask
        // the ORIGINAL tool error (the thing the model actually needs to see)
        // with an unrelated hook failure. Isolate it — the tool's own error is
        // already captured and returned below regardless.
        try {
          await this.cfg.hookManager.run({
            event: "PostToolUse",
            toolName: use.name,
            input: use.input,
            output: { error: message },
            workspace: this.cfg.workspace,
          });
        } catch {
          // hook bookkeeping never overrides the real tool error
        }
      }
      return {
        toolUseId: use.id,
        interrupted: this.cfg.permissionDenialInterrupts !== false && isPermissionDeniedError(err),
        finishedAt: Date.now(),
        verificationAttempted: isManualVerificationCall(use.name, use.input),
        verificationCommand: manualVerificationCommand(use.name, use.input) ?? undefined,
        result: {
          type: "tool_result",
          tool_use_id: use.id,
          content: message,
          is_error: true,
        },
      };
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface ResolvedToolUse {
  id: string;
  name: string;
  input: unknown;
  tool: EngineTool;
}

interface ToolExecutionOutcome {
  toolUseId: string;
  result: ToolResultBlock;
  interrupted?: boolean;
  touchedFiles?: string[];
  finishedAt?: number;
  verificationAttempted?: boolean;
  verificationCommand?: string;
  verificationPassed?: boolean;
  potentialMutation?: boolean;
}

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private waiters: Array<() => void> = [];

  get length(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }

  wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  async shift(): Promise<T | undefined> {
    if (this.items.length > 0) return this.items.shift();
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.items.shift();
  }
}

/**
 * Tools whose side effects we cannot analyze from input alone (shell commands,
 * sandboxed JS, agent dispatch) — must run solo so they can't race adjacent work.
 */
/** Max tools run concurrently within one batch (bounds Task fan-out / parallel
 *  Edits). Keeps the speedup of "a few specialists at once" without a 20-way
 *  provider storm. Override with ARES_MAX_TOOL_CONCURRENCY. */
const DEFAULT_TOOL_CONCURRENCY = 5;

function toolConcurrencyLimit(): number {
  const raw = Number(process.env.ARES_MAX_TOOL_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_TOOL_CONCURRENCY;
}

/** Error tag for a watchdog-aborted tool — distinct from a user/turn abort. */
export class ToolWatchdogError extends Error {
  constructor(public readonly toolMs: number) {
    super(`watchdog: tool exceeded ${toolMs}ms`);
    this.name = "ToolWatchdogError";
  }
}

/**
 * The watchdog deadline for one tool call. An explicit `watchdogTimeoutMs` on
 * the schema wins (including 0 = uncapped, for self-capping tools like
 * Bash/Task). Otherwise a class default by safety: networked external-state is
 * the tightest (a hung fetch is the classic stall), reads next, and
 * workspace-write/destructive get the most room. ARES_TOOL_WATCHDOG_MS overrides
 * the default globally (0 disables the watchdog everywhere).
 */
function watchdogTimeoutMsFor(schema: ToolSchema): number {
  if (typeof schema.watchdogTimeoutMs === "number") return Math.max(0, Math.floor(schema.watchdogTimeoutMs));
  const env = Number(process.env.ARES_TOOL_WATCHDOG_MS);
  if (Number.isFinite(env) && env >= 0) return Math.floor(env);
  switch (schema.safety) {
    case "external-state":
      return 20_000;
    case "workspace-write":
    case "destructive":
      return 60_000;
    default:
      return 30_000;
  }
}

/**
 * Run a tool under a deadline. timeoutMs<=0 is a byte-for-byte fast path (the
 * tool runs on the parent signal, unchanged). Otherwise a child controller is
 * merged with the parent (so interrupt()/cfg.signal STILL abort the tool), a
 * watchdog timer fires the child abort, and run() races an abort-reject. The
 * timer is unref'd — a pure backstop that never holds the event loop open.
 */
/** Lets a tool exclude a stretch from the watchdog clock — used for the human
 *  permission-prompt wait, which must NOT count as the tool timing out. */
interface WatchdogControl {
  /** Stop the deadline (e.g. while awaiting a permission click). */
  pause(): void;
  /** Re-arm the FULL deadline — the tool's real execution budget starts now. */
  resume(): void;
}

const NOOP_WATCHDOG: WatchdogControl = { pause() {}, resume() {} };

async function withWatchdog<T>(
  timeoutMs: number,
  parentSignal: AbortSignal,
  run: (signal: AbortSignal, control: WatchdogControl) => Promise<T>,
): Promise<T> {
  if (timeoutMs <= 0) return run(parentSignal, NOOP_WATCHDOG);
  const ctrl = new AbortController();
  const merged = AbortSignal.any([parentSignal, ctrl.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectWatchdog: ((e: Error) => void) | undefined;
  // NOT unref'd on purpose: while the tool is in flight the watchdog is ACTIVE
  // work (it must keep the loop alive to fire on a tool that hangs with no other
  // I/O pending — the exact case it exists for). The finally clears it the
  // instant the tool settles, so it never holds the process open after.
  const fire = () => {
    // Reject FIRST so Promise.race settles with the tagged ToolWatchdogError;
    // THEN abort so the (now-abandoned) tool's own signal/fetch tears down.
    rejectWatchdog?.(new ToolWatchdogError(timeoutMs));
    ctrl.abort();
  };
  const control: WatchdogControl = {
    pause() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    resume() {
      if (timer === undefined && !ctrl.signal.aborted) timer = setTimeout(fire, timeoutMs);
    },
  };
  const watchdog = new Promise<never>((_, reject) => {
    rejectWatchdog = reject;
  });
  timer = setTimeout(fire, timeoutMs);
  try {
    return await Promise.race([run(merged, control), watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SOLO_TOOL_NAMES = new Set([
  "Bash",
  "PowerShell",
  "CodeMode",
  "KillShell",
  "ApplyIntent",
  "FindAndEdit",
  "Memory",
  "EnterPlanMode",
  "ExitPlanMode",
]);

interface ToolDeps {
  /** Resolved absolute target path, if the tool acts on a single file. */
  target: string | null;
  /** Tool writes to its target (workspace-write or destructive safety). */
  isWrite: boolean;
  /** Tool must run alone — unknowable side effects. */
  solo: boolean;
}

function analyzeToolDeps(use: ResolvedToolUse, workspace: string): ToolDeps {
  const name = use.tool.schema.name;
  const safety = use.tool.schema.safety;
  const taskType = String(((use.input ?? {}) as Record<string, unknown>).subagent_type ?? "");
  const readOnlyTask = name === "Task" && taskType !== "general-purpose";
  const isWriteSafety = !readOnlyTask && (safety === "workspace-write" || safety === "destructive");

  if (SOLO_TOOL_NAMES.has(name)) {
    return { target: null, isWrite: isWriteSafety, solo: true };
  }

  const input = (use.input ?? {}) as Record<string, unknown>;
  const rawPath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : null;
  const target = rawPath ? path.resolve(workspace, rawPath) : null;

  // A tool with no analyzable target that either writes OR declares itself
  // "exclusive" must run solo — it could mutate shared state we can't reason
  // about. This catches ComputerUse (external-state, exclusive, no file target)
  // so parallel desktop actions can't interleave mouse/keyboard on the real
  // screen, while Edit/Write (also "exclusive" but with a resolvable target)
  // still batch across disjoint files via the target-conflict analysis below.
  if (!target && (isWriteSafety || use.tool.schema.concurrency === "exclusive")) {
    return { target: null, isWrite: isWriteSafety, solo: true };
  }

  return { target, isWrite: isWriteSafety, solo: false };
}

const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  readfile: "read",
  getfile: "read",
  writefile: "write",
  createfile: "write",
  editfile: "edit",
  patchfile: "edit",
  searchfiles: "grep",
  searchtext: "grep",
  findfiles: "glob",
  listfiles: "glob",
  websearchtool: "websearch",
  webfetchtool: "webfetch",
};

/**
 * Models disagree on tool naming conventions: Read, read_file, functions.Read,
 * and READ are all common. Resolve conservative aliases at the engine boundary
 * so provider quirks do not turn into invisible "unknown tool" failures.
 */
function resolveEngineTool(tools: readonly EngineTool[], requestedName: string): EngineTool | undefined {
  const exact = tools.find((tool) => tool.schema.name === requestedName);
  if (exact) return exact;

  const requestedKey = canonicalToolKey(requestedName);
  const aliasKey = TOOL_NAME_ALIASES[requestedKey] ?? requestedKey;
  return tools.find((tool) => canonicalToolKey(tool.schema.name) === aliasKey);
}

function canonicalToolKey(name: string): string {
  return name
    .trim()
    .replace(/^functions?[.:/]/i, "")
    .replace(/:\d+$/, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

/**
 * Normalize only high-confidence field aliases. The concrete tool still runs
 * its strict schema parser, so malformed model output fails loudly rather than
 * being guessed into a destructive action.
 */
/** Sentinel key providers stash an unparseable-args error under (see
 *  providers/_toolPairs.ts coerceToolArgs). Kept as a string literal here so the
 *  engine stays provider-agnostic. */
const TOOL_ARGS_ERROR_KEY = "__tool_use_error__";

/** If a tool_use's input is a stashed unparseable-args error, return its
 *  (already <tool_use_error>-enveloped) message; otherwise null. */
function toolArgsError(input: unknown): string | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const v = (input as Record<string, unknown>)[TOOL_ARGS_ERROR_KEY];
    if (typeof v === "string") return v;
  }
  return null;
}

function normalizeToolInput(toolName: string, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const next = { ...(input as Record<string, unknown>) };
  const copy = (target: string, ...sources: string[]) => {
    if (next[target] !== undefined) return;
    for (const source of sources) {
      if (next[source] !== undefined) {
        next[target] = next[source];
        return;
      }
    }
  };

  switch (toolName) {
    case "Read":
      copy("file_path", "path", "file");
      break;
    case "Write":
      copy("file_path", "path", "file");
      copy("content", "text", "data");
      break;
    case "Edit":
      copy("file_path", "path", "file");
      copy("old_string", "old", "old_text", "search");
      copy("new_string", "new", "new_text", "replacement");
      break;
    case "Grep":
      copy("pattern", "query", "search");
      // Native ripgrep / Claude-Code flag names the model is heavily trained on.
      // Alias them to Ares's schema fields so the lenient parser doesn't silently
      // STRIP them — a dropped `-i` turns a case-insensitive search case-SENSITIVE
      // with no signal, and the model reasons on a quietly-wrong (often empty)
      // result. (Unknown source keys are stripped after this copy; the value is
      // preserved on the aliased target.)
      copy("case_insensitive", "-i", "i", "ignore_case");
      copy("context_after", "-A", "after_context");
      copy("context_before", "-B", "before_context");
      copy("max_results", "head_limit", "limit", "max_count");
      // -C means "N lines of context on BOTH sides"; copy() only fills one target.
      if (next["-C"] !== undefined) {
        if (next["context_before"] === undefined) next["context_before"] = next["-C"];
        if (next["context_after"] === undefined) next["context_after"] = next["-C"];
      }
      break;
    case "Glob":
      copy("pattern", "query", "glob");
      copy("cwd", "path", "directory");
      break;
    case "WebSearch":
    case "ImageSearch":
      copy("query", "q", "search");
      break;
    case "WebFetch":
      copy("url", "link", "href");
      break;
    case "Bash":
    case "PowerShell":
      copy("command", "cmd", "script");
      break;
    default:
      break;
  }
  return next;
}

/**
 * Dependency-aware batcher. Within a batch, every tool may run in parallel.
 * A use joins the current batch unless any of these hold:
 *   - it is solo (and the batch is non-empty), or the batch already contains a solo
 *   - it writes a target another batch member already touches (read or write)
 *   - it reads a target another batch member writes
 *
 * Order across batches is preserved — never reorder model-emitted tool_use blocks.
 *
 * This is the OP upgrade over plain concurrency chunking: three Edits to
 * disjoint files now run in one batch (3× speedup) while Edit(a) + Read(a)
 * still serializes correctly.
 */
function buildDepAwareBatches(
  uses: readonly ResolvedToolUse[],
  workspace: string,
): ResolvedToolUse[][] {
  if (uses.length === 0) return [];

  const analyzed = uses.map((use) => ({ use, deps: analyzeToolDeps(use, workspace) }));
  const batches: ResolvedToolUse[][] = [];
  let current: typeof analyzed = [];

  const conflicts = (cand: (typeof analyzed)[number]): boolean => {
    if (current.length === 0) return false;
    if (cand.deps.solo) return true;
    if (current.some((m) => m.deps.solo)) return true;
    if (!cand.deps.target) return false;
    for (const member of current) {
      if (!member.deps.target) continue;
      if (member.deps.target !== cand.deps.target) continue;
      if (member.deps.isWrite || cand.deps.isWrite) return true;
    }
    return false;
  };

  const flush = () => {
    if (current.length > 0) {
      batches.push(current.map((x) => x.use));
      current = [];
    }
  };

  for (const item of analyzed) {
    if (conflicts(item)) flush();
    current.push(item);
    if (item.deps.solo) flush();
  }
  flush();
  return batches;
}

// Exported for unit tests in tests/v3-parallel-deps.test.mjs.
export const __internal = {
  analyzeToolDeps,
  buildDepAwareBatches,
  canonicalToolKey,
  canonicalCallSignature,
  normalizeToolInput,
  resolveEngineTool,
};

function orderedToolResults(
  uses: ReadonlyArray<{ id: string }>,
  results: ReadonlyMap<string, ToolResultBlock>,
): ToolResultBlock[] {
  return uses.map((use) => results.get(use.id)).filter((result): result is ToolResultBlock => result !== undefined);
}

function fillMissingToolResults(
  uses: ReadonlyArray<{ id: string }>,
  results: Map<string, ToolResultBlock>,
  message: string,
): void {
  for (const use of uses) {
    if (results.has(use.id)) continue;
    results.set(use.id, {
      type: "tool_result",
      tool_use_id: use.id,
      content: message,
      is_error: true,
    });
  }
}

function shouldCheckpointBeforeTool(tool: EngineTool): boolean {
  return tool.schema.safety === "workspace-write" || tool.schema.safety === "destructive";
}

function cryptoId(prefix = "id"): string {
  return `${prefix}_${randomUUID()}`;
}

function isPermissionDeniedError(err: unknown): boolean {
  return err instanceof Error && err.name === "PermissionDeniedError";
}

function addUsageInto(into: Usage, more: Usage): void {
  into.inputTokens += more.inputTokens;
  into.outputTokens += more.outputTokens;
  into.modelCalls = (into.modelCalls ?? 0) + (more.modelCalls ?? 1);
  if (more.cacheReadTokens) into.cacheReadTokens = (into.cacheReadTokens ?? 0) + more.cacheReadTokens;
  if (more.cacheWriteTokens) into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + more.cacheWriteTokens;
  if (more.reasoningTokens) into.reasoningTokens = (into.reasoningTokens ?? 0) + more.reasoningTokens;
}

export function stringifyModelToolOutput(output: unknown): string {
  const text = stringifyToolOutput(output);
  const maxChars = toolResultCharBudget();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[tool result truncated for model: ${text.length - maxChars} chars omitted; ask to read a narrower range if needed]`;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function toolResultCharBudget(): number {
  const raw = Number(process.env.ARES_TOOL_RESULT_CHARS);
  if (Number.isFinite(raw) && raw > 1_000) return Math.floor(raw);
  return 24_000;
}

/** Resolve a tool's inline-result budget: per-tool override (incl. 0 = uncapped,
 *  for self-bounding tools like Bash/Read) else the engine default. */
function resolveToolResultBudget(schema: ToolSchema): number {
  if (typeof schema.maxResultSizeChars === "number" && schema.maxResultSizeChars >= 0) {
    return schema.maxResultSizeChars;
  }
  return toolResultCharBudget();
}

/** A stable signature for a tool error — the first line, stripped of volatile
 *  bits (paths, numbers, ids) so "the same failure" matches across retries. */
function failureSignature(content: string): string {
  return content
    .split("\n")[0]
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/['"`].*?['"`]/g, "_")
    .slice(0, 80)
    .trim();
}

// ─── S1 transient-retry tuning ─────────────────────────────────────────
/** Max times a pre-output retriable provider error is retried before it
 *  surfaces as a failed turn. Override with ARES_PROVIDER_RETRIES. */
const MAX_TRANSIENT_RETRIES = (() => {
  const raw = Number(process.env.ARES_PROVIDER_RETRIES);
  return Number.isFinite(raw) && raw >= 0 && raw <= 10 ? Math.floor(raw) : 4;
})();

/** Exponential backoff with jitter for the Nth retry (1-indexed). Capped at 12s. */
function transientBackoffMs(attempt: number): number {
  const base = 800 * Math.pow(2, attempt - 1); // 800ms, 1.6s, 3.2s, 6.4s…
  const jitter = (attempt * 137) % 400; // deterministic, no Math.random in core
  return Math.min(12_000, base + jitter);
}

// ─── Stream stall guard (the effort-dial cutoff) ───────────────────────
/** No events at all for this long → the request is hung, not thinking. */
function streamIdleMs(): number {
  const raw = Number(process.env.ARES_STREAM_IDLE_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : 90_000;
}
/** Idle window ONCE real output has started. Providers that don't stream
 *  tool-input deltas go silent for minutes while the model writes a large
 *  file — a real user's Minecraft-clone build got cut mid-Write by the 90s
 *  guard. Post-output silence is normal work, not a hang; and a post-output
 *  cut can't even retry (content is committed), so it MUST be generous. */
function streamActiveIdleMs(): number {
  const raw = Number(process.env.ARES_STREAM_IDLE_ACTIVE_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : 360_000;
}
/** Reasoning-only output for this long → the model is spinning, not working. */
function thinkCeilingMs(): number {
  const raw = Number(process.env.ARES_THINK_CEILING_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : 180_000;
}

interface StallGuardOpts {
  idleMs: number;
  thinkCeilingMs: number;
  /** Idle window after ANY model output event (default: same as idleMs).
   *  Set higher in production: buffered tool-input writes are silent-but-alive. */
  activeIdleMs?: number;
  /** Called the moment a stall is declared — abort the underlying request. */
  onStall: () => void;
  now?: () => number;
}

/**
 * Wrap a provider stream with two watchdogs: an idle cutoff (no events at all)
 * and a thinking ceiling (reasoning deltas but never any committed output).
 * On stall it aborts the attempt via onStall and yields ONE synthetic retriable
 * error event, so the existing retry machinery handles recovery. Committed
 * output (text/tool-use/message) disarms the thinking ceiling permanently.
 */
export async function* guardStreamStalls(
  stream: AsyncIterable<StreamEvent>,
  opts: StallGuardOpts,
): AsyncGenerator<StreamEvent> {
  const now = opts.now ?? Date.now;
  const it = stream[Symbol.asyncIterator]();
  let thinkingStartedAt = 0;
  let committed = false;
  let sawOutput = false;
  try {
    while (true) {
      // The per-event deadline. Pre-output silence with NOTHING yet received
      // means a hung REQUEST (short window). But once ANY event has arrived —
      // committed output OR reasoning — the connection is demonstrably alive and
      // a following pause is the model composing a large buffered block server
      // side (a real surface build streamed thinking, then went quiet for >90s
      // assembling a huge canvas program, and the pre-output guard cut it —
      // orphaning the turn). So after output OR thinking, use the generous
      // window; the thinking ceiling below still clamps a reasoning-only spin.
      const alive = sawOutput || thinkingStartedAt > 0;
      let waitMs = alive ? (opts.activeIdleMs ?? opts.idleMs) : opts.idleMs;
      if (!committed && thinkingStartedAt > 0) {
        waitMs = Math.min(waitMs, Math.max(0, thinkingStartedAt + opts.thinkCeilingMs - now()));
      }
      const appliedIdleMs = waitMs;
      // Deliberately NOT unref'd: a wedged provider stream may hold no other
      // handles, and this timer firing is the only way the turn recovers.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"stall">((resolve) => {
        timer = setTimeout(() => resolve("stall"), waitMs);
      });
      const winner = await Promise.race([it.next(), timeout]).finally(() => clearTimeout(timer));
      if (winner === "stall") {
        const thinking = !committed && thinkingStartedAt > 0;
        opts.onStall();
        try {
          void it.return?.(undefined);
        } catch {
          // the aborted request may throw on close — irrelevant now
        }
        yield {
          type: "error",
          error: {
            code: thinking ? "reasoning_stall" : "stream_stall",
            message: thinking
              ? `model produced only reasoning for ${Math.round(opts.thinkCeilingMs / 1000)}s — cutting the attempt`
              : `no stream events for ${Math.round(appliedIdleMs / 1000)}s — cutting the attempt`,
            retriable: true,
          },
        };
        return;
      }
      if (winner.done) return;
      const ev = winner.value;
      if (isModelOutputEvent(ev)) sawOutput = true;
      if (ev.type === "thinking_delta") {
        if (thinkingStartedAt === 0) thinkingStartedAt = now();
      } else if (isModelOutputEvent(ev)) {
        committed = true;
      }
      yield ev;
    }
  } catch (err) {
    // An abort we triggered surfaces as a throw from the underlying iterator —
    // the synthetic stall error already covered it; anything else propagates.
    if (!(err instanceof Error && /abort/i.test(err.name + err.message))) throw err;
  }
}

/** A stall error minted by guardStreamStalls (safe to retry after thinking-only output). */
function isStallError(err: { code?: string } | null | undefined): boolean {
  return err?.code === "stream_stall" || err?.code === "reasoning_stall";
}

/** A delay that resolves immediately if the signal aborts mid-wait. Not
 *  unref'd on purpose: a mid-turn backoff is active work and must keep the
 *  event loop alive until it resolves (unlike a watchdog timer). */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── S5 research-novelty tracking ──────────────────────────────────────
/** Gather/read tools. A round using one of these counts as PROGRESS only when
 *  it acquires a NEW target — genuine multi-source research keeps moving; a
 *  model re-fetching the same URL or re-running the same search is spinning. */
const GATHER_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "ImageSearch",
  "Read",
  "Grep",
  "Glob",
  "CodebaseSearch",
  "Browser",
  "LSP",
]);

/** A stable signature for what a gather tool is acquiring. New signature =
 *  novel information = real research progress. */
function gatherSignature(name: string, input: unknown): string {
  const i = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const s = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");
  switch (name) {
    case "WebFetch":
      return `fetch:${s(i.url)}`;
    case "WebSearch":
    case "ImageSearch":
    case "CodebaseSearch":
      return `q:${name}:${s(i.query) || s(i.q) || s(i.search)}`;
    case "Read":
      return `read:${s(i.file_path) || s(i.path)}:${i.offset ?? ""}`;
    case "Grep":
      return `grep:${s(i.pattern)}:${s(i.path)}`;
    case "Glob":
      return `glob:${s(i.pattern)}`;
    case "Browser":
      return `browser:${s(i.action)}:${s(i.url)}`;
    case "LSP":
      return `lsp:${s(i.action)}:${s(i.file_path)}`;
    default:
      return `${name}:${s(i.query) || s(i.pattern) || s(i.url)}`;
  }
}

/** Tools whose use means the turn is PRODUCING, not just gathering. A round
 *  containing any of these resets the gather-stall convergence clock. */
const PROGRESS_TOOLS = new Set([
  "Write",
  "Edit",
  "ApplyIntent",
  "FindAndEdit",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "BashOutput",
  "KillShell",
  "TodoWrite",
  "Task",
  "Memory",
  "SelfEvolve",
  "SkillCraft",
  // Desktop control is real progress — a screenshot→click→verify GUI loop must
  // not be nagged to "stop gathering and deliver" mid-task.
  "ComputerUse",
]);

function manualVerificationCommand(name: string, input: unknown): string | null {
  if (name !== "Bash" && name !== "PowerShell") return null;
  const request = (input ?? {}) as Record<string, unknown>;
  if (request.run_in_background === true) return null;
  const command = String(request.command ?? "").trim().replace(/\s+/g, " ");
  // Manual proof is a fallback only when no structured host verifier exists.
  // Accept one anchored check command, never a substring or shell chain: this
  // rejects `echo test`, `pnpm test; exit 0`, pipelines, and verify-then-mutate.
  if (/[;&|><`]|\$\(/.test(command)) return null;
  if (/(?:^|\s)(?:--collect-only|--co|--no-run|--listtests|--list-tests|--dry-run|--help|--version|--showconfig|--show-config|--print-config|--passwithnotests|--allow-no-tests)(?:\s|$)/i.test(command)) return null;
  if (/^(?:npx\s+)?(?:tsc|eslint|vitest|jest)\s+-(?:v|h)$/i.test(command)) return null;
  if (!/^(?:node\s+--test\b|(?:pnpm|yarn)\s+(?:test|check|lint|build|typecheck)\b|npm\s+(?:test|run\s+(?:check|lint|build|typecheck))\b|npx\s+(?:tsc|eslint|vitest|jest)\b|(?:vitest|jest|pytest|ruff|mypy|tsc|eslint)\b|cargo\s+(?:test|check|clippy)\b|go\s+(?:test|build)\b)(?:\s+[^\r\n]*)?$/i.test(command)) {
    return null;
  }
  return command.toLowerCase();
}

function isManualVerificationCall(name: string, input: unknown): boolean {
  return manualVerificationCommand(name, input) !== null;
}

function verificationCommandFamily(command: string): string | null {
  const match = command.match(/^(node\s+--test|(?:pnpm|yarn)\s+(?:test|check|lint|build|typecheck)|npm\s+(?:test|run\s+(?:check|lint|build|typecheck))|npx\s+(?:tsc|eslint|vitest|jest)|(?:vitest|jest|pytest|ruff|mypy|tsc|eslint)|cargo\s+(?:test|check|clippy)|go\s+(?:test|build))\b/i);
  return match?.[1].toLowerCase().replace(/\s+/g, " ") ?? null;
}

function verificationCommandCovers(passingCommand: string, failedCommand: string): boolean {
  if (passingCommand === failedCommand) return true;
  const passingFamily = verificationCommandFamily(passingCommand);
  const failedFamily = verificationCommandFamily(failedCommand);
  return passingFamily !== null && passingFamily === failedFamily && passingCommand === passingFamily;
}

function isSuccessfulVerificationCall(name: string, input: unknown, output: unknown): boolean {
  if (!isManualVerificationCall(name, input)) return false;
  if (!output || typeof output !== "object") return false;
  const result = output as Record<string, unknown>;
  return result.exitCode === 0 && result.timedOut !== true;
}

function isPotentialCodeMutationCall(name: string, input: unknown): boolean {
  if (["Write", "Edit", "ApplyIntent", "FindAndEdit", "NotebookEdit"].includes(name)) return true;
  if (name !== "Bash" && name !== "PowerShell") return false;
  const command = String(((input ?? {}) as Record<string, unknown>).command ?? "");
  // Conservative shell mutation cues. The Session checkpoint diff is the final
  // authority and supplies exact files; this early signal merely arms the proof
  // gate before the inner engine tries to finish.
  return /(?:^|[\s;&|])(?:rm|mv|cp|mkdir|touch|sed\s+-i|git\s+(?:apply|checkout|restore|mv|rm)|npm\s+(?:install|uninstall)|pnpm\s+(?:add|remove|install)|yarn\s+(?:add|remove|install)|cargo\s+(?:add|remove)|apply_patch)\b|(?:>|>>|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)/i.test(command);
}

/** Consecutive gather-only tool rounds tolerated before the convergence
 *  reminder fires. Overridable for tests / unusual workloads. */
function currentGatherStallRounds(): number {
  const raw = Number(process.env.ARES_GATHER_STALL_ROUNDS);
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : 10;
}

/** A stable per-CALL signature (tool + canonicalized args), so "the identical
 *  call again" matches regardless of key order. Unlike gatherSignature (which is
 *  gather-tool-specific and tracks NEW targets), this keys on the WHOLE input —
 *  it catches a model re-issuing the exact same successful call in a no-op loop. */
function canonicalCallSignature(name: string, input: unknown): string {
  return `${canonicalToolKey(name)}::${stableArgsDigest(input)}`;
}

function stableArgsDigest(input: unknown): string {
  // HASH the full canonical args (not a 200-char truncation): two different
  // full-file Write/Edit payloads share a long boilerplate prefix, so truncating
  // collapsed them into one signature and falsely tripped the repeat/oscillation
  // detectors. A full-content hash makes distinct calls distinct.
  try {
    const raw =
      input === null || typeof input !== "object"
        ? String(input)
        : Object.keys(input as Record<string, unknown>)
            .sort()
            .map((k) => {
              const v = (input as Record<string, unknown>)[k];
              return `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`;
            })
            .join("&");
    return fnv1a(raw);
  } catch {
    return fnv1a(String(input));
  }
}

/** Tiny deterministic hash (FNV-1a, base36) — no crypto, no Math.random. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Threshold for the identical-call (no-op loop) detector. */
function repeatCallLimit(): number {
  const raw = Number(process.env.ARES_REPEAT_CALL_LIMIT);
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : 3;
}

/** Absolute per-turn tool-call ceiling — a graceful backstop that ends the turn
 *  cleanly (status 'completed', partial work preserved) rather than the failed
 *  max_turns_exceeded path. Default high enough no legit build hits it. */
function toolCallCeiling(): number {
  const raw = Number(process.env.ARES_MAX_TURN_TOOL_CALLS);
  return Number.isFinite(raw) && raw >= 10 ? Math.floor(raw) : 400;
}

function contextBudgetAttempts(configuredBudgetTokens: number): number[] {
  if (configuredBudgetTokens <= 0) return [0, 32_000, 16_000, 8_000, 4_000];
  const candidates = [
    configuredBudgetTokens,
    Math.floor(configuredBudgetTokens * 0.5),
    Math.floor(configuredBudgetTokens * 0.25),
    8_000,
    4_000,
  ];
  const seen = new Set<number>();
  return candidates
    .filter((budget) => budget > 0 && budget <= configuredBudgetTokens)
    .map((budget) => Math.floor(budget))
    .sort((a, b) => b - a)
    .filter((budget) => {
      if (seen.has(budget)) return false;
      seen.add(budget);
      return true;
    });
}

function isContextLimitError(error: { code: string; message: string }): boolean {
  const text = `${error.code} ${error.message}`.toLowerCase();
  return (
    text.includes("context_length_exceeded") ||
    text.includes("prompt too long") ||
    text.includes("prompt is too long") ||
    text.includes("max context") ||
    text.includes("context window") ||
    text.includes("maximum context") ||
    text.includes("input length") ||
    text.includes("too many tokens") ||
    text.includes("exceeded max context") ||
    // A too-big REQUEST BODY is the same recoverable condition as a too-long
    // prompt: shrink the recent-history window and retry. The Ares Gateway runs
    // on Vercel, whose serverless functions hard-cap the request body (~4.5MB)
    // and reject overflow with an HTTP 413 that never mentions "prompt" —
    // "Request Entity Too Large" / "FUNCTION_PAYLOAD_TOO_LARGE". Without these,
    // an oversized turn (a big pasted image, a long transcript) dead-loops:
    // every resend ships the same too-large body and 413s again, forever.
    text.includes("http_413") ||
    text.includes("entity too large") ||
    text.includes("payload too large") ||
    text.includes("payload_too_large")
  );
}

function isModelOutputEvent(ev: StreamEvent): boolean {
  return (
    ev.type === "text_delta" ||
    ev.type === "thinking_delta" ||
    ev.type === "tool_use_start" ||
    ev.type === "tool_use_input_delta" ||
    ev.type === "tool_use_input_done" ||
    ev.type === "message_done"
  );
}

function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed || p;
}

function hostOf(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
    return u.host.replace(/^www\./, "") || rawUrl;
  } catch {
    return rawUrl.replace(/^https?:\/\//, "").split(/[/?#]/)[0] || rawUrl;
  }
}

function summarizeShellCommand(raw: string, background: boolean): string {
  const cmd = raw.trim().replace(/\s+/g, " ");
  const lower = cmd.toLowerCase();
  const lead = (verb: string) => (background ? `${verb} in the background` : verb);
  // Git intents — narrate the topic, not the flags.
  const branch = /git\s+(?:checkout|switch)\s+(?:-b\s+)?([^\s&|;]+)/.exec(cmd);
  if (branch) return lead(`Switching to ${branch[1]}`);
  if (/git\s+commit/.test(lower)) return lead("Committing changes");
  if (/git\s+push/.test(lower)) return lead("Pushing to remote");
  if (/git\s+pull/.test(lower)) return lead("Pulling from remote");
  if (/git\s+status/.test(lower)) return lead("Checking git status");
  if (/git\s+(diff|log|show)/.test(lower)) return lead("Inspecting git history");
  if (/\bgit\b/.test(lower)) return lead("Running git");
  // Build / test / install intents.
  if (/(pnpm|npm|yarn).*(test|vitest|jest)|node --test|\bpytest\b|cargo test/.test(lower)) return lead("Running tests");
  if (/(pnpm|npm|yarn).*(build|lint|tsc)|cargo build|vite build/.test(lower)) return lead("Building the project");
  if (/(pnpm|npm|yarn)\s+(install|i|add)|cargo add/.test(lower)) return lead("Installing dependencies");
  // Generic: lead with the program name.
  const program = cmd.split(" ")[0]?.split(/[\\/]/).pop() || "command";
  return lead(`Running ${program}`);
}

// Topic-first narration of a tool run for the live UI ("Reading App.tsx",
// "Searching for useState", "Opening github.com", "Switching to main"). This is
// the SOLE producer the desktop/CLI activity surfaces read, so it carries the
// warmth — keyed on the real tool name + its actual arguments.
function describeActivity(toolName: string, input: unknown): string {
  const i = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const bg = i.run_in_background === true;

  switch (toolName) {
    case "Read": {
      const f = str(i.file_path);
      return f ? `Reading ${basenameOf(f)}` : "Reading a file";
    }
    case "Write": {
      const f = str(i.file_path);
      return f ? `Writing ${basenameOf(f)}` : "Writing a file";
    }
    case "Edit":
    case "ApplyIntent": {
      const f = str(i.file_path);
      return f ? `Editing ${basenameOf(f)}` : "Editing a file";
    }
    case "FindAndEdit": {
      const glob = str(i.file_glob);
      const pat = str(i.pattern);
      const verb = i.dry_run ? "Previewing edits" : "Replacing";
      if (pat && glob) return `${verb} ${pat} in ${glob}`;
      return glob ? `${verb} in ${glob}` : "Editing files";
    }
    case "Grep": {
      const pat = str(i.pattern);
      return pat ? `Searching for ${pat}` : "Searching the code";
    }
    case "Glob": {
      const pat = str(i.pattern);
      return pat ? `Finding ${pat}` : "Finding files";
    }
    case "CodebaseSearch": {
      const q = str(i.query);
      return q ? `Searching the codebase for ${q.slice(0, 60)}` : "Searching the codebase";
    }
    case "Bash":
    case "PowerShell": {
      const c = str(i.command);
      return c ? summarizeShellCommand(c, bg) : "Running a command";
    }
    case "BashOutput":
      return "Reading shell output";
    case "KillShell":
      return "Stopping a background shell";
    case "WebFetch": {
      const u = str(i.url);
      return u ? `Fetching ${hostOf(u)}` : "Fetching a page";
    }
    case "WebSearch": {
      const q = str(i.query);
      return q ? `Searching the web for ${q.slice(0, 60)}` : "Searching the web";
    }
    case "Browser": {
      const action = str(i.action);
      const u = str(i.url);
      // Honest targets: local files and the in-app engine are NOT "the web".
      const embedded = str(i.engine) === "embedded" || (!u && !!str(i.html));
      const target = (() => {
        if (!u) return embedded ? "your page in the Ares window" : "a page";
        try {
          const parsed = new URL(u.includes("://") ? u : `https://${u}`);
          if (parsed.protocol === "file:") return `local file ${decodeURIComponent(parsed.pathname.split("/").pop() ?? "")}`.trim();
          if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return `local app ${parsed.host}`;
          return parsed.host.replace(/^www\./, "") || u;
        } catch {
          return u;
        }
      })();
      if (action === "open") return `Opening ${target}`;
      if (action === "preview") return `Previewing ${target}`;
      if (action === "tree") return "Reading the page";
      if (action === "screenshot" || action === "filmstrip") return embedded ? "Reading the in-app page" : "Capturing the screen";
      if (action === "fill") return str(i.label) ? `Filling “${str(i.label)}”` : "Filling a field";
      if (action === "fill_selector") return str(i.selector) ? `Typing into ${str(i.selector)}` : "Filling a field";
      if (action === "click") return str(i.name) ? `Clicking “${str(i.name)}”` : "Clicking a control";
      if (action === "click_text") return str(i.query) ? `Clicking “${str(i.query)}”` : "Clicking a control";
      if (action === "console") return "Reading the console";
      if (action === "eval") return "Testing in the page";
      if (action === "state") return "Checking the page state";
      if (action === "close") return "Closing the browser";
      return embedded ? "Using the in-app browser" : "Browsing the web";
    }
    case "ComputerUse": {
      const action = str(i.action);
      if (action === "screenshot") return "Looking at the screen";
      if (action === "type") return "Typing on the desktop";
      if (action === "key") return str(i.key) ? `Pressing ${str(i.key)}` : "Pressing a key";
      if (action === "scroll") return "Scrolling the screen";
      if (action === "cursor") return "Checking the cursor";
      if (action && i.x !== undefined) return `${action} at ${i.x},${i.y}`;
      return action ? `Computer: ${action}` : "Operating the desktop";
    }
    case "Task": {
      const d = str(i.description);
      return d ? `Delegating: ${d.slice(0, 50)}` : "Delegating a subtask";
    }
    case "TodoWrite": {
      const todos = Array.isArray(i.todos) ? i.todos.length : 0;
      return todos ? `Updating ${todos} todo${todos === 1 ? "" : "s"}` : "Updating the plan";
    }
    case "Memory": {
      const action = str(i.action);
      if (action === "read") return "Recalling from memory";
      if (action === "append" || action === "write") return "Saving to memory";
      return "Working with memory";
    }
    case "LSP": {
      const f = str(i.file_path);
      const action = str(i.action) ?? "inspect";
      return f ? `Inspecting ${basenameOf(f)} (${action})` : "Inspecting code";
    }
    case "McpList":
    case "Mcp": {
      const server = str(i.server);
      const tool = str(i.tool);
      if (server && tool) return `Calling ${server}/${tool}`;
      if (server) return `Listing ${server} tools`;
      return "Listing MCP servers";
    }
    case "SkillsList":
    case "Skills": {
      const q = str(i.query);
      return q ? `Looking for skills like ${q}` : "Browsing skills";
    }
    case "SkillRead":
    case "RunSkill": {
      const n = str(i.name);
      return n ? `Running the ${n} skill` : "Running a skill";
    }
    case "CodeMode":
      return "Running a code batch";
    case "PlanMode":
      return "Entering plan mode";
    case "ExitPlanMode":
      return "Leaving plan mode";
    case "LivingMind": {
      const action = str(i.action);
      return action ? `Living memory: ${action}` : "Tending living memory";
    }
    case "Operator": {
      const action = str(i.action);
      return action ? `Operator: ${action}` : "Consulting the operator";
    }
    case "Mission": {
      const action = str(i.action);
      const goal = str(i.goal);
      if (goal) return `Mission — ${goal.slice(0, 48)}`;
      return action ? `Mission: ${action}` : "Working on a mission";
    }
    case "Self": {
      const action = str(i.action);
      return action ? `Self: ${action}` : "Reflecting on self";
    }
    case "SelfEvolve": {
      const target = str(i.target);
      return target ? `Evolving ${target}` : "Evolving itself";
    }
    case "SkillCraft": {
      const n = str(i.name);
      return n ? `Crafting the ${n} skill` : "Crafting a skill";
    }
    case "Bootstrap": {
      const agent = str(i.agent_name);
      return agent ? `Bootstrapping ${agent}` : "Bootstrapping the entity";
    }
    default:
      break;
  }

  // Generic fallback — still warmer than a bare tool name.
  const f = str(i.file_path) ?? str(i.path);
  if (f) return `${toolName} · ${basenameOf(f)}`;
  const c = str(i.command);
  if (c) return `${toolName} · ${c.slice(0, 50)}`;
  const q = str(i.pattern) ?? str(i.query);
  if (q) return `${toolName} · ${q.slice(0, 50)}`;
  return toolName;
}

/** Lower a reasoning level by N steps within the full provider-neutral ladder. */
function downshift(level: ReasoningLevel, steps: number): ReasoningLevel {
  const ladder: ReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const idx = ladder.indexOf(level);
  if (idx < 0) return level;
  return ladder[Math.max(0, idx - steps)];
}

/**
 * Task-adaptive reasoning selection (PURE, exported for tests). Given the owner's
 * chosen ceiling and the latest user text, returns the level to actually use this
 * turn. NEVER exceeds `base` (owner control is a ceiling); down-shifts trivial and
 * short single-clause turns so a reasoning model stops burning minutes on "hi" or
 * a one-line ask. `enabled=false` (owner opt-out) returns `base` unchanged.
 */
export function adaptiveReasoningLevel(
  base: ReasoningLevel | undefined,
  latestUserText: string,
  enabled = true,
): ReasoningLevel | undefined {
  if (!base || base === "off" || base === "minimal" || base === "low") return base;
  if (!enabled) return base;
  const text = latestUserText.trim();
  if (!text) return base;
  const words = text.split(/\s+/).length;
  // Deep-work verbs ALWAYS keep the ceiling, even in a terse "debug this" — these
  // are exactly the turns that earn max deliberation, so they beat every downshift.
  if (/\b(why|how|debug|design|plan|refactor|architect|analy[sz]e|investigate|trace|root cause)\b/i.test(text)) {
    return base;
  }
  // Pure greetings / acknowledgements, or very short non-work chatter → no thinking.
  const trivial =
    /^(hi|hey+|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|lol|bet|word|yes|no|yep|nope|got it|gotcha)\b/i.test(text) ||
    text.length < 24;
  if (trivial) return "off";
  // A short, single-clause ask doesn't need max-tier deliberation — one rung down
  // keeps it snappy without going blind.
  if (words <= 12) return downshift(base, 1);
  return base;
}

/** True if the plan still has unstarted or in-progress items. */
function hasUnfinishedTodos(todos: readonly import("@ares/protocol").Todo[]): boolean {
  return todos.some((t) => t.status === "pending" || t.status === "in_progress");
}

function isTodoOutput(output: unknown): output is { todos: import("@ares/protocol").Todo[] } {
  return Boolean(
    output &&
      typeof output === "object" &&
      Array.isArray((output as { todos?: unknown }).todos),
  );
}

// Re-export the ToolUseBlock type for downstream consumers that build messages.
export type { ToolUseBlock, ToolResultBlock };
export { isToolUseBlock };
export type { ContentBlock };
