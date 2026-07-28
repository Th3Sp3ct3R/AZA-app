// Ares v2 wire protocol. Zero runtime dependencies. Pure types.
//
// Three layers:
//   1. ContentBlock / Message — what the model sees and emits.
//   2. StreamEvent — what providers yield as they stream.
//   3. TurnEvent — what QueryEngine yields to CLI/TUI (superset of StreamEvent).
//
// Tool implementations live in @ares/tools; this package only defines the
// SCHEMA shape providers receive. Each tool owns its own zod schema there.

// ─── Messages (Anthropic SDK shape) ─────────────────────────────────────
//
// Roles match @anthropic-ai/sdk: tool results are USER-role messages with
// tool_result content blocks. We do not use a separate "tool" role. This
// makes the wire format drop-in compatible with the Anthropic SDK — when
// we add a direct-Anthropic provider it's a passthrough; OpenAI Codex
// backend and Ollama Cloud translate the same shape at the provider edge.

export type Role = "system" | "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

export interface ImageBlock {
  type: "image";
  source:
    | { kind: "url"; url: string }
    | { kind: "base64"; mediaType: string; data: string };
}

export interface SystemReminderBlock {
  type: "system_reminder";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  signature?: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | SystemReminderBlock
  | ThinkingBlock;

export interface MessageMetadata {
  source?: string;
  tokenCount?: number;
  [key: string]: unknown;
}

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  createdAt: string;
  metadata?: MessageMetadata;
}

// ─── Stream Events (what providers yield) ───────────────────────────────

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Number of provider requests represented by this usage aggregate. */
  modelCalls?: number;
}

export interface StreamError {
  code: string;
  message: string;
  retriable: boolean;
  /** When a retriable error carries a server-provided reset window (HTTP
   *  `Retry-After`, in ms), the retry loop waits at least this long instead of
   *  burning its exponential backoff on a window that won't have elapsed. */
  retryAfterMs?: number;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string; signature?: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; deltaJson: string }
  | { type: "tool_use_input_done"; id: string; input: unknown }
  | { type: "message_done"; message: Message; usage: Usage; stopReason: StopReason }
  | { type: "error"; error: StreamError };

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "interrupted"
  | "error";

// ─── Turn Events (what QueryEngine yields to CLI/TUI) ───────────────────

export type TurnEvent =
  | StreamEvent
  | { type: "turn_start"; turnId: string; sessionId: string; userMessage: Message }
  | { type: "tool_start"; id: string; name: string; input: unknown; providerHint?: ProviderHint; activityDescription: string }
  | { type: "tool_progress"; id: string; data: unknown }
  | { type: "tool_end"; id: string; output: unknown; touchedFiles?: string[]; durationMs: number; display?: string }
  | { type: "tool_error"; id: string; error: string; durationMs: number }
  | { type: "permission_request"; id: string; toolName: string; input: unknown; reason: string; suggestion?: PermissionPromptSuggestion }
  | { type: "permission_response"; id: string; decision: PermissionPromptDecision }
  | { type: "verify_scheduled"; files: string[] }
  | { type: "verify_finished"; ok: boolean; output: string; durationMs: number }
  | {
      type: "system_reminder_injected";
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
    }
  | {
      type: "compaction";
      summarizedMessages: number;
      tokensBefore: number;
      tokensAfter: number;
      method: "summary" | "ledger";
      /** Exact post-compaction history so restart/resume preserves the same memory. */
      messages?: Message[];
    }
  | {
      type: "auxiliary_usage";
      kind: "compaction" | "witness" | "memory" | "other";
      provider: string;
      model: string;
      usage: Usage;
    }
  | { type: "self_revise"; attempt: number; reason: string }
  | { type: "heartbeat_tick"; reason: string; surfaced?: string }
  | { type: "dream_phase_started"; phase: "light" | "deep" | "rem" }
  | { type: "dream_phase_ended"; phase: "light" | "deep" | "rem"; promoted: number; pruned: number }
  | { type: "skill_proposed"; name: string; pendingApproval: boolean }
  | { type: "memory_recall_emitted"; count: number; topCategory: MemoryCategory }
  | { type: "soul_rule_promoted"; ruleText: string; sourceMemoryId: number }
  | { type: "todo_updated"; todos: Todo[] }
  | { type: "checkpoint_created"; checkpointId: string; label?: string; toolUseId?: string; reason?: "manual" | "pre_tool" | "post_tool" }
  | { type: "workspace_diff"; checkpointId: string; toolUseId?: string; files: string[]; diff: string; truncated: boolean }
  | { type: "subagent_start"; id: string; name: string; description: string }
  | { type: "subagent_end"; id: string; status: "completed" | "failed" | "cancelled"; summary: string }
  | {
      type: "turn_end";
      status: TurnEndStatus;
      /** Coding/work truth, independent of transport completion. */
      workStatus?: WorkStatus;
      usage: Usage;
      durationMs: number;
      /** Added by Session persistence for accurate historical attribution. */
      provider?: string;
      model?: string;
    };

export type TurnEndStatus = "completed" | "interrupted" | "failed";

/** Outcome of the requested work, separate from transport/execution status.
 * A turn can execute normally (`completed`) while its code remains red or has
 * no post-edit proof. Keeping the axes separate prevents provider failover from
 * treating an ordinary verification failure as a provider outage. */
export type WorkStatus = "verified" | "unverified" | "blocked" | "not_applicable";

// ─── Tools (schema-side; implementation lives in @ares/tools) ───────────

export type SafetyClass =
  | "read-only"        // file reads, grep, glob, list, web search
  | "workspace-write"  // edits within the workspace root
  | "destructive"      // rm -rf, db drop, irreversible
  | "external-state";  // network mutations, browser, posting

export type Concurrency = "exclusive" | "parallel-safe";

export type ProviderHint =
  | "reasoner"     // the main loop model
  | "apply"        // cheap fast apply-model (Ollama Cloud APPLY slot)
  | "summarize"    // tiny model for summarization / commit msgs / todos
  | "user-main";   // explicit caller-chosen

export interface ToolSchema {
  name: string;
  description: string;
  inputJsonSchema: object;
  safety: SafetyClass;
  concurrency: Concurrency;
  providerHint?: ProviderHint;
  /** When true, tool is omitted from initial prompt; loaded via ToolSearch. */
  deferLoading?: boolean;
  /** Per-tool execution watchdog. `0` = no watchdog (uncapped — for tools that
   *  self-cap, e.g. Bash/Task); omitted = the engine picks a class default from
   *  `safety`. Bounds a single tool call so a hung network fetch can't stall the
   *  whole turn for minutes. */
  watchdogTimeoutMs?: number;
  /** Max characters of this tool's result kept inline in the model's context.
   *  When the result exceeds it, the engine spills the full output to disk and
   *  hands the model a preview + a path it can re-Read — so a giant file read or
   *  vision dump can't bloat the window or be silently truncated-and-lost.
   *  Omitted = engine default; `0` = never spill (e.g. tools that self-bound).
   *  Wired in Phase 4 (tool-contract hardening); inert until then. */
  maxResultSizeChars?: number;
}

// ─── Permissions ────────────────────────────────────────────────────────

export type PermissionMode =
  | "ask"               // prompt on every workspace-write / external-state call
  | "auto-safe"         // auto-allow read-only and small workspace edits; ask on novel patterns
  | "workspace-write"   // allow all workspace edits without prompting; deny external
  | "bypass"            // allow everything (use with caution)
  | "plan";             // read-only enforced; non-read tools rejected

export type PermissionPromptDecision = "allow_once" | "allow_always" | "deny";
export type PermissionPromptSuggestion = PermissionPromptDecision;

export type PermissionDecision =
  | { kind: "allow"; reason?: string }
  | { kind: "ask"; prompt: string; suggestion?: PermissionPromptSuggestion }
  | { kind: "deny"; reason: string };

export type PermissionRuleEffect = "allow" | "ask" | "deny";
export type PermissionRuleSource = "user-global" | "project" | "session";

export interface PermissionRule {
  pattern: string;  // e.g. "Bash(git *)", "Edit(packages/secrets/**)"
  effect: PermissionRuleEffect;
  source: PermissionRuleSource;
}

// ─── Todos (TodoWrite tool format) ──────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Todo {
  id: string;
  content: string;      // imperative: "Run tests"
  activeForm: string;   // present continuous: "Running tests"
  status: TodoStatus;
}

// ─── Sessions / Rollouts / Checkpoints (DAG) ────────────────────────────

export interface ProviderInfo {
  name: string;
  model: string;
}

export interface SessionMeta {
  id: string;
  workspace: string;
  provider: ProviderInfo;
  createdAt: string;
  parentSessionId?: string;
  parentCheckpointId?: string;
  label?: string;
}

export interface RolloutEntry {
  ts: string;
  seq: number;
  event: TurnEvent;
}

export interface BlobRef {
  path: string;
  blobHash: string;   // blake3 hex
  mode: number;
}

export interface CheckpointMeta {
  id: string;                       // content-addressed: blake3 of fileManifest+parent
  sessionId: string;
  turnSeq: number;
  parentCheckpointId?: string;
  label?: string;
  createdAt: string;
  fileManifest: BlobRef[];
}

// ─── Memory ─────────────────────────────────────────────────────────────

export type MemoryScope = "user" | "project";
export type MemorySource = "user" | "agent" | "imported";
export type MemoryCategory = "SELF" | "USER" | "PROJECT" | "DECISION" | "FEEDBACK";

export interface MemoryRecord {
  id: string;
  title: string;
  body: string;
  tags: string[];
  scope: MemoryScope;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers (pure, no deps) ────────────────────────────────────────────

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result";
}

export function messageText(message: Message): string {
  return message.content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("");
}
