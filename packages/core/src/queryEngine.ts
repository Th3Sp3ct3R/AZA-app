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
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { HookInvocation, HookManager } from "./hooks.js";
import { verificationHintFor } from "./verifier.js";
import {
  RepositoryInstructionResolver,
  renderRepositoryInstructions,
  type RepositoryInstructionContext,
  type RepositoryInstructionClaim,
} from "./repositoryInstructions.js";

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
  /** True when a tool whose static schema is read-only can resolve to an
   * effectful class for some valid input. Durable hosts use this declaration
   * without guessing from the mere presence of an input classifier. */
  readonly mayHaveEffects?: boolean;
  /** Per-input effective class. Static schema safety is the conservative
   * fallback for malformed inputs and external tool adapters. */
  classifyInput?(input: unknown): { safety?: SafetyClass; concurrency?: ToolSchema["concurrency"] };
  /**
   * Crash-recovery contract for effects that do not use Ares' workspace
   * mutation journal (remote APIs, deploys, queues, device control, etc.).
   *
   * Reconciliation MUST be observational and idempotent. The engine may call
   * it after a process restart, but it never calls `call()` automatically in
   * response to an ambiguous result. `retry` is durable guidance for the
   * owner/model after reconciliation, not permission for blind replay.
   */
  readonly effectPolicy?: EngineToolEffectPolicy;
  call(input: unknown, ctx: ToolCallContext): Promise<EngineToolResult>;
}

export type ToolEffectRetryPolicy =
  | "never"
  | "after-reconciled-not-applied"
  | "idempotent-with-key";

export type ToolEffectReconciliationResult =
  | {
      disposition: "applied";
      evidence: unknown;
      /** Recovered canonical result, when the remote service can return it. */
      output?: unknown;
      touchedFiles?: string[];
    }
  | {
      disposition: "not-applied";
      evidence: unknown;
      reason?: string;
    }
  | {
      disposition: "indeterminate";
      evidence: unknown;
      reason: string;
    };

export interface ToolEffectReconciliationRequest {
  sessionId: string;
  toolRunId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  workspace: string;
  mutationTransactionId?: string;
  previousError?: unknown;
  /** Stable service-level key derived from persisted arguments, when the tool
   * declares `idempotent-with-key`. */
  idempotencyKey?: string;
  signal: AbortSignal;
}

export interface EngineToolEffectPolicy {
  /** What an owner may do only AFTER an observational reconciliation. */
  retry: ToolEffectRetryPolicy;
  /** Stable semantic version/key for audit events and policy migrations. */
  reconcilerKey?: string;
  idempotencyKey?(input: unknown): string | null | undefined;
  reconcile?(request: ToolEffectReconciliationRequest): Promise<ToolEffectReconciliationResult>;
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
  /** Durable owner of this tool call. Child agents use this to create an
   * addressable parent/child session edge instead of an orphan transcript. */
  sessionId: string;
  /** Provider-issued identity of this logical tool invocation. Hosts use it as
   * an idempotency key when a crashed turn is replayed, so Task/Conductor
   * reconnect to the original durable children instead of duplicating work. */
  toolUseId?: string;
  signal: AbortSignal;
  /** Yield progress events from inside a long-running tool call. */
  emitProgress?(data: unknown): void;
  requestPermission?(request: ToolPermissionRequest): Promise<PermissionPromptDecision>;
  /** Engine-owned read-stamp map. When present, file tools MUST prefer it over
   *  any captured map so each engine (parent / subagent) stays isolated. */
  fileReadStamps?: Map<string, FileReadStampLike>;
  /** Deterministic journal identity for workspace mutations made by this
   * logical tool call. Transactional mutators must pass it through. */
  mutationTransactionId?: string;
  /** Path-sensitive AGENTS/ARES/CLAUDE-style rules. The context and its claim
   * cache belong to this engine's Session; tools use it before file effects. */
  repositoryInstructions?: RepositoryInstructionContext;
}

export interface ToolPermissionRequest {
  id?: string;
  toolName: string;
  input: unknown;
  reason: string;
  suggestion?: PermissionPromptSuggestion;
  /**
   * This asks the owner to make a WORKFLOW decision, not to authorise a risky
   * effect — the plan→build crossing is the only one today.
   *
   * Free/YOLO mode blanket-approves permissions so Ares stops asking before
   * every write and shell call. That is right for safety gates and wrong here:
   * a request marked `ownerDecision` must reach a human even under YOLO,
   * because nobody turned on "auto-approve my judgement calls". Hosts that
   * auto-approve MUST honour this flag.
   */
  ownerDecision?: boolean;
  /** Host waiters must detach when this unanswered request loses authority.
   * The signal never aborts an effect after approval; it scopes only the
   * pending prompt. */
  signal?: AbortSignal;
}

export interface EngineToolResult {
  output: unknown;
  /** A completed tool call whose structured output represents a failure.
   * Unlike throwing, this preserves diagnostics (for example shell stdout,
   * stderr, exit code, and timeout state) while still producing an is_error
   * model result and a failed durable execution record. */
  failure?: string;
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

export interface ToolSettlementReceipt {
  /** Host-observed files not already declared by the implementation (for
   * example, files changed by a PostToolUse formatter hook). */
  touchedFiles?: string[];
}

/** A mid-turn user correction claimed by the host's durable inbox. The engine
 * appends the stable message at a settled model/tool boundary, then asks the
 * host to consume the corresponding input before another provider call. */
export interface ClaimedSteeringMessage {
  inputId: string;
  message: Message;
}

/** Result of asking the live engine to notice a newly durable steering input.
 * Provider attempts and optional maintenance are disposable; they can be
 * cancelled without ending the owner turn. An entered effect is never cut in
 * half, while queued/pre-effect work is paired as skipped before the correction
 * is installed. `idle` is deliberately non-latching: terminal steers inherit
 * the next FIFO generation rather than poisoning the dying one. */
export type SteeringPreemptionDisposition =
  | "provider_preempting"
  | "effect_settling"
  | "boundary_pending"
  | "idle";

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
  /** Session-owned repository instruction resolver. Direct QueryEngine callers
   * get a fresh resolver automatically; durable Session hosts inject one that
   * also restores/persists claims. */
  repositoryInstructions?: RepositoryInstructionContext;
  /** Canonical workflow posture used to pin plan-transition tools and suppress
   * write protocols during long planning conversations. */
  workflowMode?: () => "plan" | "build";
  /** Host-discovered environment-provider matchers. Core deliberately knows no
   * editor or engine names: providers declare file/command signals in their
   * manifests, and the host maps concrete outcomes to stable provider ids. */
  environmentArtifactSignals?(event: {
    toolName: string;
    input: unknown;
    output?: unknown;
    touchedFiles?: readonly string[];
  }): readonly string[] | Promise<readonly string[]>;
  /** If > 0, the engine trims the OLDEST conversation history to keep the
   *  estimated input (system + tools + messages) under this many tokens, so a
   *  long thread can never hard-fail with context_length_exceeded. The pending
   *  user message and recent context are always kept. */
  contextBudgetTokens?: number;
  /** Optional pending system-reminders to inject at next turn_start. */
  drainSystemReminders?(): Array<{
    text: string;
    instructionClaims?: RepositoryInstructionClaim[];
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
  /** Claim steering inputs under the active durable generation and persist
   * their stable user-message projections. Must not consume them yet: the
   * engine first installs every message into history at a safe boundary. */
  claimSteeringMessages?(): Promise<readonly ClaimedSteeringMessage[]>;
  /** Consume steering inputs after their messages are present in engine
   * history. A failure aborts the turn; lease release requeues unconsumed
   * claims, while stable message ids make the next attempt an exact-once upsert. */
  consumeSteeringInputs?(inputIds: readonly string[]): Promise<void>;
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
  /** Spec/requirements docs (e.g. the task .md) read during this coding
   *  objective. When non-empty, the engine forces a requirements-vs-artifacts
   *  diff before the first completion claim: re-open the spec, enumerate every
   *  explicit deliverable and verification artifact, and confirm each exists —
   *  the guard against silent scope reduction. */
  specDocs?(): string[];
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
  /** Write-ahead barrier immediately before a tool implementation is entered.
   * If this rejects, the tool receives no authority and cannot gain effects. */
  beforeToolExecution?(request: {
    toolUseId: string;
    toolName: string;
    input: unknown;
    safety: SafetyClass;
    checkpointId?: string;
    mutationTransactionId: string;
  }): Promise<void>;
  /** Durable settlement barrier. Called before tool_end/tool_error is exposed. */
  afterToolExecution?(result: {
    toolUseId: string;
    toolName: string;
    input: unknown;
    safety: SafetyClass;
    status: "succeeded" | "failed" | "effect_unknown";
    output?: unknown;
    error?: string;
    touchedFiles?: string[];
  }): Promise<void | ToolSettlementReceipt>;
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
  /** Include the complete post-compaction message projection on the public turn
   * event. Kernel-backed Session hosts persist directly from engine.history(),
   * so they disable this to avoid cloning and streaming megabytes of history. */
  includeCompactionProjectionInEvents?: boolean;
}

const DURABLE_EFFECT_HOST = Symbol("ares.query-engine.durable-effect-host");
const TEST_ONLY_EFFECT_HOST = Symbol("ares.query-engine.test-only-effect-host");
type QueryEngineEffectAuthority =
  | typeof DURABLE_EFFECT_HOST
  | typeof TEST_ONLY_EFFECT_HOST
  | undefined;

export type DurableQueryEngineConfig = QueryEngineConfig &
  Required<Pick<QueryEngineConfig, "beforeToolExecution" | "afterToolExecution">>;

/**
 * Keep the provider's tool prefix proportional to the current job. A fresh
 * desktop session owns dozens of tools; serializing every schema on every
 * model round wastes thousands of input tokens and weakens tool selection.
 * Execution still resolves against the full set, and tools used in the recent
 * transcript remain advertised so multi-step work never loses its handles.
 */
export interface ToolSelectionContext {
  providerName?: string;
  model?: string;
  workflowMode?: "plan" | "build";
}

export function selectToolsForTurn(
  tools: readonly EngineTool[],
  messages: readonly Message[],
  context: ToolSelectionContext = {},
): readonly EngineTool[] {
  const intentPruning = process.env.ARES_DYNAMIC_TOOLS !== "0" && tools.length > 12;
  const hasContractFilter = context.workflowMode !== undefined || !!context.providerName || !!context.model;
  if (!intentPruning && !hasContractFilter) return tools;

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

  // The coding core is ALWAYS offered, whatever the turn looks like. Pruning is a
  // token optimization and must never remove a core capability: intent detection
  // below is keyword-based, so "add a dark mode toggle", "upgrade the deps" and
  // "rename the User class" all read as non-coding. A turn that ships without Read
  // or Edit cannot do the work, and the model surfaces that as a malformed or
  // unknown tool call rather than a clean failure — which is indistinguishable
  // from the model being bad at coding. Intent only ever ADDS to this floor.
  const providerModel = `${context.providerName ?? ""} ${context.model ?? ""}`.toLowerCase();
  const patchProtocol = /(?:openai|codex|\bgpt[-_ ]|\bo[1-9](?:\b|-))/.test(providerModel);
  const primaryEditors = patchProtocol ? ["applypatch"] : ["write", "edit"];
  const wanted = new Set([
    "read", ...primaryEditors, "glob", "grep", "bash", "powershell",
    "todowrite", "requestuseraction", "memory", "browser", "websearch",
    "webfetch", "imagesearch", "skillhub", "skillslist", "skillread",
    "capability",
  ]);
  if (!intentPruning) {
    wanted.clear();
    for (const tool of tools) wanted.add(tool.schema.name.toLowerCase());
  }
  const add = (...names: string[]) => names.forEach((name) => wanted.add(name.toLowerCase()));

  const coding = /\b(?:build|code|coding|implement|fix|debug|refactor|test|compile|html|css|javascript|typescript|python|repo|repository|file|folder|component|website|app|api|database|git|terminal|powershell|bash|install|package)\b/.test(userText)
    || /\b(?:make|create|design|develop|update|change)\b[^.?!]{0,80}\b(?:page|site|app|component|script|file|project)\b/.test(userText);
  const browser = /\b(?:browser|website|webpage|youtube|twitter|x\.com|google|search|navigate|tab|click|scroll|video|page|url|download)\b/.test(userText);
  const desktop = /\b(?:desktop|screen|window|mouse|keyboard|native app|computer use)\b/.test(userText);
  if (coding) {
    add(
      "read", ...primaryEditors, "glob", "grep", "codebasesearch",
      "lsp", "powershell", "bash", "bashoutput",
      "killshell", "enterplanmode", "updateplandraft", "exitplanmode",
      "task", "taskoutput", "killtask", "conductor",
      "codingbackend", "deploy",
    );
  }
  if (/\b(?:background|detached)\s+(?:job|task|agent|shell|process)\b|\b(?:poll|stop|kill|cancel)\s+(?:the\s+)?(?:job|task|agent|shell|process)\b/.test(userText)) {
    add("task", "taskoutput", "killtask", "bashoutput", "killshell");
  }
  // Alternate editing protocols remain installed but are advertised only when
  // explicitly requested or already active in the transcript. This keeps each
  // model on one low-entropy edit contract instead of asking it to choose among
  // six overlapping schemas on every coding round.
  if (/\bapply[ _-]?patch\b/.test(userText)) add("applypatch");
  if (/\bapply[ _-]?intent\b/.test(userText)) add("applyintent");
  if (/\bfind[ _-]?and[ _-]?edit\b/.test(userText)) add("findandedit");
  if (/\bcode[ _-]?mode\b/.test(userText)) add("codemode");
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
  const recentlyUsed = new Set<string>();
  for (const message of messages.slice(-8)) {
    for (const block of message.content) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        const name = block.name.toLowerCase();
        recentlyUsed.add(name);
        wanted.add(name);
      }
      // The GUI ground-truth gate just demanded a screenshot: the screenshot
      // tools MUST be advertised or the model is ordered to use a tool it
      // cannot see (unknown-tool loop instead of compliance).
      if (block.type === "system_reminder" && /WINDOWED app artifact|GUI-UNVERIFIED/.test(block.text ?? "")) {
        add("computeruse", "browser");
      }
    }
  }
  const explicitlyRequested = new Set<string>();
  if (/\bapply[ _-]?patch\b/.test(userText)) explicitlyRequested.add("applypatch");
  if (/\bapply[ _-]?intent\b/.test(userText)) explicitlyRequested.add("applyintent");
  if (/\bfind[ _-]?and[ _-]?edit\b/.test(userText)) explicitlyRequested.add("findandedit");
  if (/\bcode[ _-]?mode\b/.test(userText)) explicitlyRequested.add("codemode");
  const primaryEditorSet = new Set(primaryEditors);
  for (const name of ["write", "edit", "applypatch", "applyintent", "findandedit", "codemode"]) {
    if (!primaryEditorSet.has(name) && !explicitlyRequested.has(name) && !recentlyUsed.has(name)) wanted.delete(name);
  }
  // Workflow transitions are a contract, not a lexical guess. A user can say
  // "let's think this through first" without any coding keyword and must still
  // receive EnterPlanMode; a planning turn always receives its living draft and
  // exact approval handoff tools.
  if (context.workflowMode === "build") {
    wanted.delete("updateplandraft");
    wanted.delete("exitplanmode");
    add("enterplanmode");
  }
  if (context.workflowMode === "plan") {
    wanted.delete("enterplanmode");
    for (const name of ["write", "edit", "applypatch", "applyintent", "findandedit", "codemode"]) {
      wanted.delete(name);
    }
    add("read", "glob", "grep", "codebasesearch", "lsp", "websearch", "webfetch", "imagesearch", "browser", "task", "capability", "updateplandraft", "exitplanmode");
  }
  const planMixedTools = new Set(["webfetch", "browser", "task", "updateplandraft", "exitplanmode"]);
  const selected = tools.filter((tool) => {
    const name = tool.schema.name.toLowerCase();
    if (!wanted.has(name)) return false;
    if (context.workflowMode !== "plan") return true;
    return tool.schema.safety === "read-only" || planMixedTools.has(name);
  });
  if (selected.length > 0) return selected;
  if (context.workflowMode === "plan") {
    // Never fail open to the complete write belt merely because a host supplied
    // a sparse or synthetic catalog.
    return tools.filter((tool) =>
      tool.schema.safety === "read-only" || planMixedTools.has(tool.schema.name.toLowerCase())
    );
  }
  return tools;
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

// Microcompact rung: cheaply clear OLD read-only tool-output bodies (no model
// call) before the heavy summarizer fires, keeping the last N at full fidelity.
// re-derivable tool output (a Read can be re-Read, a Grep re-run) — assistant
// reasoning and user intent are never touched.
const MICROCOMPACT_TOOLS = new Set<string>([
  "Read", "Grep", "Glob", "WebSearch", "WebFetch", "CodebaseSearch",
]);
const MICROCOMPACT_KEEP_RECENT = 6;
const MICROCOMPACT_TRIGGER_RATIO = 0.72;
const MICROCOMPACT_MIN_RESULTS = 8;
const MICROCOMPACT_MIN_SAVED_TOKENS = 8_000;
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
  // Hard floor on how few recent messages may survive trimming (mirrors
  // chooseCompactionSplit's minKeep). Without it, a budget below the fixed
  // overhead made this loop run to kept.length === 1 — the model got ONLY the
  // pending message and answered as if the rest of the conversation never
  // happened. Shipping a slightly over-budget prompt and letting the provider
  // say no is strictly better than silently erasing the conversation.
  minKeep = 4,
): { messages: Message[]; trimmed: number; dropped: Message[] } {
  if (budgetTokens <= 0 || messages.length <= 1) return { messages: [...messages], trimmed: 0, dropped: [] };
  let total = overheadTokens + messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  if (total <= budgetTokens) return { messages: [...messages], trimmed: 0, dropped: [] };

  const kept = [...messages];
  const dropped: Message[] = [];
  let trimmed = 0;
  const keepFloor = Math.max(1, minKeep);
  while (total > budgetTokens && kept.length > keepFloor) {
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
  let priorAnchor = "";

  for (const message of dropped) {
    for (const block of message.content) {
      if (block.type === "text" && message.role === "user") {
        const direction = block.text.replace(/\s+/g, " ").trim();
        if (direction) asks.push(direction.length > 360 ? `${direction.slice(0, 360)}…` : direction);
      } else if (
        block.type === "system_reminder" &&
        /^Compacted memory\b/i.test(block.text.trim())
      ) {
        // A failed later summarizer must never erase the durable mission/state
        // produced by an earlier successful compaction. Preserve the previous
        // recap's semantic body, but discard live file pins (they are re-read
        // below) and cap it so repeated fallback cannot grow recursively.
        const bodyStart = block.text.indexOf("\n\n");
        let body = bodyStart >= 0 ? block.text.slice(bodyStart + 2) : block.text;
        for (const marker of [
          "\n\nThe files you were working in, re-read AFTER compaction",
          "\n\nRepository instructions re-pinned after compaction",
        ]) {
          const at = body.indexOf(marker);
          if (at >= 0) body = body.slice(0, at);
        }
        priorAnchor = body.length > 24_000 ? `${body.slice(0, 24_000)}\n[prior anchor clipped]` : body;
      } else if (block.type === "tool_use") {
        toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
      }
    }
  }

  // Files are recency-sensitive. The old implementation stopped after the
  // first 24 paths, which retained abandoned early work and forgot the files
  // being edited immediately before compaction.
  const files: string[] = [];
  const seenFiles = new Set<string>();
  for (let i = dropped.length - 1; i >= 0 && files.length < 24; i--) {
    const message = dropped[i];
    for (let j = message.content.length - 1; j >= 0 && files.length < 24; j--) {
      const block = message.content[j];
      if (block.type !== "tool_use") continue;
      const input = block.input as Record<string, unknown> | null;
      for (const key of ["file_path", "path", "notebook_path", "file"]) {
        const value = input?.[key];
        if (typeof value !== "string") continue;
        const normalized = value.trim();
        if (!normalized || seenFiles.has(normalized)) continue;
        seenFiles.add(normalized);
        files.push(normalized);
        if (files.length >= 24) break;
      }
    }
  }

  const latestAsks: string[] = [];
  for (let i = asks.length - 1; i >= 0 && latestAsks.length < 8; i--) {
    if (!latestAsks.includes(asks[i])) latestAsks.unshift(asks[i]);
  }

  const lines = [`Context ledger — ${dropped.length} older message(s) were trimmed from your visible history to fit the model's context window. What that span contained:`];
  if (priorAnchor.trim()) lines.push(`- Prior durable mission/state (preserved from the previous compaction):\n${priorAnchor.trim()}`);
  if (latestAsks.length > 0) lines.push(`- Latest user directions and corrections: ${latestAsks.join(" | ")}`);
  if (toolCounts.size > 0) {
    const tools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => `${name}×${n}`);
    lines.push(`- Tools you already ran there: ${tools.join(", ")}`);
  }
  if (files.length > 0) lines.push(`- Most recent files you already touched/read there: ${files.join(", ")}`);
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
  // boundary backward (keep more) so the matching assistant tool_use stays.
  while (split > 0 && split < messages.length && leadsWithToolResult(messages[split])) {
    split--;
  }
  // Compacting fewer than 2 messages isn't worth a model call.
  if (split < 2) return 0;
  if (messages.length - split < minKeep) return 0;
  return split;
}

// ─── Implementation ────────────────────────────────────────────────────

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

interface ActiveProviderAttempt {
  id: string;
  steeringAbort: AbortController;
  supersededBySteering: boolean;
}

export class QueryEngine {
  private readonly messages: Message[] = [];
  private readonly cfg: QueryEngineConfig;
  readonly sessionId: string;
  /** Per-turn abort controller — interrupt() stops the CURRENT turn without
   *  poisoning the session; the next turn gets a fresh controller. */
  private turnAbort: AbortController | null = null;
  /** Current execution phase, used only to route a durable steering wake-up.
   * Provider attempts are speculative until their final Message is installed;
   * tools, by contrast, must always reach their settlement boundary. */
  private turnPhase: "idle" | "boundary" | "maintenance" | "provider" | "effect" | "terminal" = "idle";
  /** Monotonic wake generation for durable steers. It closes the window where
   * admission lands after an empty inbox poll but before provider/terminal
   * authority is armed. */
  private steeringWakeEpoch = 0;
  /** Abortable edge for awaits that are still strictly pre-effect (notably an
   * unanswered permission prompt). Replaced on every wake so already-settled
   * effects never inherit cancellation from an older correction. */
  private steeringWakeController = new AbortController();
  private activeProviderAttempt: ActiveProviderAttempt | null = null;
  /** Heavy compaction is speculative maintenance. A steer cancels it just like
   * a stale provider attempt, without committing a fallback ledger rewrite. */
  private activeMaintenanceAttempt: AbortController | null = null;
  /**
   * Live estimate→real token ratio, calibrated from the usage every provider
   * returns. The char-based estimator over-counts code/JSON and under-counts
   * dense scripts; this corrects budgeting/compaction to the model's ACTUAL
   * accounting so we never compact early or overflow late. 1.0 until the first
   * real datapoint; EWMA-smoothed and clamped so one weird turn can't wreck it.
   */
  private tokenScale = 1;
  /** The provider's REAL prompt ceiling, learned from rejections/stalls at
   *  specific ladder rungs (real-token units). The configured budget can be
   *  far above what the serving layer accepts (ollama num_ctx, gateway 413s);
   *  without this the ladder re-walked its guaranteed-failing prefix on every
   *  iteration — minutes of dead round trips per tool round. Null until a
   *  rung fails; reset on provider/model switch. */
  private learnedContextCeiling: number | null = null;
  /** Consecutive micro passes that ended still above the micro trigger. In the
   *  band between the micro trigger (0.72×threshold) and the full-compaction
   *  threshold, micro fires at every boundary, reclaims a few percent, and the
   *  real summarizer never runs — a field session logged 94 micro passes, 88 of
   *  them reclaiming under 10%. After 3 such passes the full compaction is
   *  forced even though the threshold hasn't been crossed. */
  private ineffectiveMicroStreak = 0;
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
  /** Effectful engines are constructed only by a durable Session host. The
   * explicit test factory exists so unit harnesses cannot accidentally become
   * production examples of an unledgered writer. */
  private readonly effectAuthority: QueryEngineEffectAuthority;

  constructor(
    cfg: QueryEngineConfig,
    sessionId: string,
    effectAuthority?: QueryEngineEffectAuthority,
  ) {
    const declaresEffects = cfg.tools.some((tool) =>
      tool.schema.safety !== "read-only" || tool.mayHaveEffects === true
    );
    const executableHooks = cfg.hookManager !== undefined;
    if ((declaresEffects || executableHooks) && effectAuthority === undefined) {
      throw new Error(
        "Effectful QueryEngine construction requires a durable Session host. " +
        "Use QueryEngine.hosted(...) with write-ahead/settlement callbacks; " +
        "unit tests must opt in explicitly with QueryEngine.forTesting(...).",
      );
    }
    if (
      effectAuthority === DURABLE_EFFECT_HOST &&
      (typeof cfg.beforeToolExecution !== "function" || typeof cfg.afterToolExecution !== "function")
    ) {
      throw new Error(
        "A durable QueryEngine host must provide both beforeToolExecution and afterToolExecution barriers.",
      );
    }
    this.cfg = {
      ...cfg,
      repositoryInstructions:
        cfg.repositoryInstructions ?? new RepositoryInstructionResolver(cfg.workspace),
    };
    this.sessionId = sessionId;
    this.effectAuthority = effectAuthority;
  }

  /** Construct an engine whose non-read-only tools are fenced by a durable
   * host. This is the production entry point used by Session. */
  static hosted(cfg: DurableQueryEngineConfig, sessionId: string): QueryEngine {
    return new QueryEngine(cfg, sessionId, DURABLE_EFFECT_HOST);
  }

  /** Explicit escape hatch for deterministic unit/evaluation harnesses. It is
   * deliberately noisy in the API and must never be used by a user-facing
   * session surface. */
  static forTesting(cfg: QueryEngineConfig, sessionId: string): QueryEngine {
    return new QueryEngine(cfg, sessionId, TEST_ONLY_EFFECT_HOST);
  }

  private assertEffectAuthority(toolName: string, safety: SafetyClass): void {
    if (safety === "read-only") return;
    if (this.effectAuthority === DURABLE_EFFECT_HOST || this.effectAuthority === TEST_ONLY_EFFECT_HOST) return;
    throw new Error(
      `${toolName} resolved to ${safety}, but this QueryEngine has no durable effect host; execution was blocked before the tool implementation.`,
    );
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

  /**
   * Field-debuggable wire log: one JSONL line per outbound provider call,
   * written BEFORE dispatch so a hang, stall, or oversized-payload rejection
   * still leaves evidence of exactly what was about to ship. This exists
   * because a field user watching "no stream events for 90s" had no way to
   * see WHAT was being sent or why it was that large — the record has to
   * exist even when the call never comes back. Bounded: rolls once past
   * ~8MB per session. ARES_WIRE_LOG=0 opts out; failures never touch the turn.
   */
  private async logWirePrompt(record: Record<string, unknown>): Promise<void> {
    if (process.env.ARES_WIRE_LOG === "0") return;
    try {
      const dir = path.join(this.cfg.workspace, ".ares", "wire-log");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${this.sessionId}.jsonl`);
      const st = await fs.stat(file).catch(() => null);
      if (st && st.size > 8 * 1024 * 1024) {
        // Windows rename refuses to clobber — clear the old generation first.
        await fs.rm(`${file}.1`, { force: true }).catch(() => {});
        await fs.rename(file, `${file}.1`).catch(() => {});
      }
      await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
    } catch {
      // Bookkeeping must never kill a turn.
    }
  }

  /** Size-first block digest for the wire log: enough to answer "what made
   *  this prompt huge" (a 5MB screenshot shows its real serialized size)
   *  without duplicating whole prompts to disk. */
  private wireBlockSummary(block: ContentBlock): Record<string, unknown> {
    const b = block as unknown as { type?: string; name?: string; text?: unknown };
    let chars: number;
    try {
      chars = JSON.stringify(block)?.length ?? 0;
    } catch {
      chars = -1;
    }
    const out: Record<string, unknown> = { type: b.type ?? "unknown", chars };
    if (typeof b.name === "string") out.tool = b.name;
    if (typeof b.text === "string" && b.text) out.head = b.text.slice(0, 160);
    return out;
  }

  /** Stop the currently armed turn (provider stream + running tools see the
   * abort). Idle and duplicate interrupts are strict no-ops; ownership of a
   * pre-stream cancellation belongs to Session's input/generation state, never
   * to an unbound flag that could poison the next turn. */
  interrupt(): boolean {
    if (!this.turnAbort || this.turnAbort.signal.aborted) return false;
    this.turnAbort.abort();
    return true;
  }

  /** Wake the current turn after a steering input is DURABLY admitted.
   *
   * During provider generation, the request is speculative: cancel that one
   * attempt, discard all of its uncommitted assistant/tool blocks, and let the
   * same streamTurn continue with the correction. During tool execution we do
   * not abort—the tool result must be paired and durably settled first. */
  requestSteeringPreemption(): SteeringPreemptionDisposition {
    if (!this.turnAbort) return "idle";
    if (this.turnPhase === "terminal") return "idle";
    this.steeringWakeEpoch++;
    const priorWake = this.steeringWakeController;
    this.steeringWakeController = new AbortController();
    priorWake.abort();
    if (this.turnPhase === "maintenance" && this.activeMaintenanceAttempt) {
      if (!this.activeMaintenanceAttempt.signal.aborted) this.activeMaintenanceAttempt.abort();
      return "boundary_pending";
    }
    const attempt = this.activeProviderAttempt;
    if (this.turnPhase === "provider" && attempt) {
      attempt.supersededBySteering = true;
      if (!attempt.steeringAbort.signal.aborted) attempt.steeringAbort.abort();
      return "provider_preempting";
    }
    if (this.turnPhase === "effect") return "effect_settling";
    return "boundary_pending";
  }

  /** Called by Session the instant a turn generator finishes. Dropping the
   * controller makes any later idle Stop a no-op instead of targeting a stale
   * generation or leaking into the next request. */
  markTurnEnded(): void {
    this.activeMaintenanceAttempt?.abort();
    this.activeMaintenanceAttempt = null;
    this.turnAbort = null;
    this.turnPhase = "idle";
    this.activeProviderAttempt = null;
  }

  /** Fence terminal emission before Session exposes it. Inputs admitted after
   * this point inherit the next FIFO generation; they cannot wake a dead owner
   * while its async generator is closing. */
  markTurnTerminal(): void {
    this.activeMaintenanceAttempt?.abort();
    this.activeMaintenanceAttempt = null;
    if (this.turnAbort) this.turnPhase = "terminal";
    this.activeProviderAttempt = null;
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

  /**
   * Replace the system prompt mid-session — applies to the next turn.
   *
   * Message history is deliberately untouched: this exists so a persona can be
   * adopted or dropped inside a live conversation without losing what has
   * already been said. The system prompt is sent fresh with every request, so
   * the swap is complete on the next turn with no re-hydration.
   */
  setSystemPrompt(systemPrompt: string): void {
    this.cfg.systemPrompt = systemPrompt;
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
    // The ceiling was evidence about the OLD provider/model's serving limit.
    this.learnedContextCeiling = null;
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

  appendUserMessageContent(
    content: ContentBlock[],
    identity: { id?: string; createdAt?: string; metadata?: Message["metadata"] } = {},
  ): Message {
    const message: Message = {
      id: identity.id ?? cryptoId(),
      role: "user",
      content,
      createdAt: identity.createdAt ?? new Date().toISOString(),
      ...(identity.metadata ? { metadata: identity.metadata } : {}),
    };
    this.messages.push(message);
    return message;
  }

  /** Apply every currently admitted steer at a point where no model stream or
   * tool effect is active. Durable claim/message projection happens in the host;
   * history installation precedes acknowledgement so any failure is replayable
   * without losing or duplicating the correction. */
  private async applySteeringAtBoundary(): Promise<number> {
    if (!this.cfg.claimSteeringMessages) return 0;
    const claimed = await this.cfg.claimSteeringMessages();
    if (claimed.length === 0) return 0;
    if (!this.cfg.consumeSteeringInputs) {
      throw new Error("claimSteeringMessages requires consumeSteeringInputs");
    }

    const inputIds = new Set<string>();
    const messages = new Map<string, Message>();
    for (const item of claimed) {
      if (!item.inputId || inputIds.has(item.inputId)) {
        throw new Error(`invalid or duplicate steering input id: ${item.inputId || "<empty>"}`);
      }
      if (!item.message.id || item.message.role !== "user") {
        throw new Error(`steering input ${item.inputId} must provide a stable user message`);
      }
      const duplicateMessage = messages.get(item.message.id);
      if (duplicateMessage && JSON.stringify(duplicateMessage) !== JSON.stringify(item.message)) {
        throw new Error(`steering message id conflict: ${item.message.id}`);
      }
      inputIds.add(item.inputId);
      messages.set(item.message.id, item.message);
    }

    for (const message of messages.values()) {
      const existing = this.messages.find((candidate) => candidate.id === message.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(message)) {
          throw new Error(`steering message history conflict: ${message.id}`);
        }
        continue;
      }
      this.messages.push({
        ...message,
        content: message.content.map((block) => ({ ...block })),
        ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
      });
    }

    await this.cfg.consumeSteeringInputs([...inputIds]);
    return inputIds.size;
  }

  /** Drain until no notification can have raced the inbox snapshot, then arm
   * provider authority in the same synchronous continuation. `null` means a
   * correction was installed and outbound context must be rebuilt. */
  private async armProviderAttemptAtBoundary(): Promise<NonNullable<QueryEngine["activeProviderAttempt"]> | null> {
    while (true) {
      const observedEpoch = this.steeringWakeEpoch;
      const applied = await this.applySteeringAtBoundary();
      if (applied > 0) return null;
      if (observedEpoch !== this.steeringWakeEpoch) continue;
      const attempt = {
        id: cryptoId("provider_attempt"),
        steeringAbort: new AbortController(),
        supersededBySteering: false,
      };
      // Keep this transition adjacent to the epoch comparison. A later wake
      // sees provider authority and aborts this exact disposable attempt.
      this.activeProviderAttempt = attempt;
      this.turnPhase = "provider";
      return attempt;
    }
  }

  /** Read through a method boundary so control-flow analysis does not retain a
   * stale property narrowing across awaited host/provider work. Those awaits
   * can synchronously route steering and replace or clear the active attempt. */
  private currentProviderAttempt(): ActiveProviderAttempt | null {
    return this.activeProviderAttempt;
  }

  /** Linearize successful completion against a concurrently admitted steer. */
  private async closeTurnAtBoundary(): Promise<boolean> {
    while (true) {
      const observedEpoch = this.steeringWakeEpoch;
      const applied = await this.applySteeringAtBoundary();
      if (applied > 0) return false;
      if (observedEpoch !== this.steeringWakeEpoch) continue;
      this.markTurnTerminal();
      return true;
    }
  }

  /** Construct the only externally visible terminal boundary. Calling this
   * before yielding makes late durable inputs belong to the next generation,
   * even while Session is still persisting the event. */
  private terminalTurnEvent(
    event: Extract<TurnEvent, { type: "turn_end" }>,
  ): Extract<TurnEvent, { type: "turn_end" }> {
    this.markTurnTerminal();
    return event;
  }

  /**
   * Seed a turn with a goal/work-item instead of a chat message. An autonomous
   * driver (operator step, subagent, Consciousness action) frames a directive
   * here rather than faking a user turn. It is still a trailing user-role message
   * (the API needs one to elicit an assistant turn), but tagged
   * `metadata.source = "work-item"` so chat-only consumers (intent gating,
   * episodic capture) can tell autonomous work from a real user message — the
   * one chat-assumption baked into the loop's entry, generalized.
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
   * passes the microcompaction watermark, clear a useful BATCH of old
   * compactable tool_result blocks (keeping the most recent N) in place, with NO
   * model call. Bulky, re-derivable output (file reads, greps, vision dumps) is
   * what dominates a coding session's tokens; clearing it here usually keeps the
   * conversation under `threshold` so the expensive summarizer never fires —
   * and, unlike a blunt trim, it preserves every assistant reasoning step and
   * user message. Returns a UI event, or null when nothing was cleared.
   */
  /** Compaction threshold in real tokens. Follows the LEARNED serving ceiling
   *  when the ladder has discovered the provider accepts less than the
   *  configured budget — otherwise compaction only fires after history is
   *  already unsendable and every iteration pays doomed round trips first. */
  private compactionThresholdTarget(): number {
    const base =
      this.cfg.compactionThresholdTokens ??
      (this.cfg.contextBudgetTokens ? Math.floor(this.cfg.contextBudgetTokens * 0.8) : 0);
    const learned = this.learnedContextCeiling;
    if (learned !== null && learned > 0) {
      const cap = Math.floor(learned * 0.8);
      return base > 0 ? Math.min(base, cap) : cap;
    }
    return base;
  }

  private microcompactIfNeeded(): {
    projection: Extract<TurnEvent, { type: "compaction" }>;
    reminder: Extract<TurnEvent, { type: "system_reminder_injected" }>;
  } | null {
    const threshold = this.compactionThresholdTarget();
    if (threshold <= 0) return null;
    const estBefore = this.messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (estBefore * this.tokenScale <= threshold * MICROCOMPACT_TRIGGER_RATIO) return null;

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

    const candidates: Array<{ block: ToolResultBlock; chars: number }> = [];
    for (const m of this.messages) {
      for (const b of m.content) {
        if (
          b.type === "tool_result" &&
          compactableIds.has(b.tool_use_id) &&
          !keep.has(b.tool_use_id) &&
          typeof b.content === "string" &&
          b.content !== MICROCOMPACT_PLACEHOLDER
        ) {
          candidates.push({ block: b, chars: b.content.length });
        }
      }
    }
    if (candidates.length === 0) return null;

    const savedChars = candidates.reduce((sum, candidate) => sum + candidate.chars, 0);
    const savedTokens = Math.round((savedChars / CHARS_PER_TOKEN) * this.tokenScale);
    // Once above the watermark, wait for a useful batch instead of rewriting a
    // full durable projection every time one additional result becomes old. A
    // single enormous result still crosses the savings threshold immediately.
    if (
      candidates.length < MICROCOMPACT_MIN_RESULTS &&
      savedTokens < MICROCOMPACT_MIN_SAVED_TOKENS
    ) {
      return null;
    }

    const clearedIds = new Set<string>();
    for (const candidate of candidates) {
      candidate.block.content = MICROCOMPACT_PLACEHOLDER;
      clearedIds.add(candidate.block.tool_use_id);
    }
    const cleared = candidates.length;

    // The cleared Read/etc. bodies are GONE from the model's view — but their
    // read stamps survive. Without invalidating them, a recovery whole-file Read
    // trips the re-read guard and is told "its full contents are above / already
    // in context" — a flat LIE (the body is now the placeholder), and the model
    // edits blind. Heavy compaction avoids this via onHistoryTrimmed; microcompact
    // is a newer rung that bypassed it. Hand the host the tool_use blocks whose
    // output we cleared so it invalidates exactly those files' stamps.
    if (this.cfg.fileReadStamps || this.cfg.onHistoryTrimmed) {
      const clearedToolUses: Message[] = this.messages
        .filter((m) => m.role === "assistant")
        .map((m) => ({ ...m, content: m.content.filter((b) => b.type === "tool_use" && clearedIds.has(b.id)) }))
        .filter((m) => m.content.length > 0);
      if (clearedToolUses.length > 0) {
        this.invalidateReadEvidence(clearedToolUses);
      }
    }
    const estAfter = this.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    // A micro pass that leaves the conversation above its own trigger did not
    // solve anything — it deferred nothing. Track the streak so compactIfNeeded
    // can escalate instead of letting micro thrash forever in the band below
    // the full-compaction threshold.
    this.ineffectiveMicroStreak =
      estAfter * this.tokenScale > threshold * MICROCOMPACT_TRIGGER_RATIO
        ? this.ineffectiveMicroStreak + 1
        : 0;
    return {
      projection: {
        type: "compaction",
        summarizedMessages: 0,
        tokensBefore: Math.round(estBefore * this.tokenScale),
        tokensAfter: Math.round(estAfter * this.tokenScale),
        method: "micro",
        // Clone the array so later engine mutations cannot change the durable
        // projection object while Session is committing it to SQLite/JSONL.
        messages: this.cfg.includeCompactionProjectionInEvents === false
          ? undefined
          : this.messages.map((message) => ({
              ...message,
              content: message.content.map((block) => ({ ...block })),
            })),
      },
      reminder: {
        type: "system_reminder_injected",
        text: `microcompacted ${cleared} old tool output(s) (~${Math.round(savedChars / CHARS_PER_TOKEN)} tokens freed) to defer heavy compaction`,
        source: "compaction",
      },
    };
  }

  private async compactIfNeeded(): Promise<Extract<TurnEvent, { type: "compaction" }> | null> {
    // A just-installed owner correction gets the next provider request before
    // optional maintenance. Provider budgeting still enforces the hard context
    // limit, and a later settled boundary can compact after the correction has
    // been answered or has produced tool results.
    if (this.messages.at(-1)?.metadata?.source === "steer") return null;
    const threshold = this.compactionThresholdTarget();
    if (threshold <= 0) return null;

    const estBefore = this.messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    // Compare in REAL tokens (calibrated) against the real-token threshold.
    // Escalation: three consecutive micro passes that couldn't get below the
    // micro trigger force the real summarizer even below the threshold —
    // otherwise the 0.72T..T band is a thrash zone micro can never exit.
    const forcedByMicroThrash = this.ineffectiveMicroStreak >= 3;
    if (!forcedByMicroThrash && estBefore * this.tokenScale <= threshold) return null;

    // Keep the most recent ~35% of the threshold at full fidelity. keepTokens is
    // in estimate units (chooseCompactionSplit sums the raw estimator), so divide
    // the real-token target back out by the calibration.
    const keepTokens = Math.max(4_000, Math.floor((threshold * 0.35) / this.tokenScale));
    const split = chooseCompactionSplit(this.messages, keepTokens);
    if (split <= 0) {
      // Nothing summarizable — a forced escalation must not re-force every
      // boundary; the streak rebuilds from live evidence if thrash continues.
      this.ineffectiveMicroStreak = 0;
      return null;
    }

    const older = this.messages.slice(0, split);

    const maintenanceAttempt = new AbortController();
    this.activeMaintenanceAttempt = maintenanceAttempt;
    this.turnPhase = "maintenance";
    const turnSignal = this.liveSignal();
    const maintenanceSignal = turnSignal.aborted
      ? turnSignal
      : AbortSignal.any([turnSignal, maintenanceAttempt.signal]);

    try {

    let summary = "";
    let method: "summary" | "ledger" = "summary";
    if (this.cfg.summarizeSpan) {
      try {
        // Compaction is speculative maintenance. Stop or steer cancels the
        // summarizer immediately, even if an adapter ignores its signal.
        summary = (await awaitWithAbort(
          this.cfg.summarizeSpan(older, maintenanceSignal),
          maintenanceSignal,
        )).trim();
      } catch {
        summary = "";
      }
    }
    // An aborted summarizer is not a summarizer failure. In particular, a
    // steer must not trigger a synchronous ledger fallback/rewrite before its
    // correction reaches the provider.
    if (maintenanceSignal.aborted) return null;
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
        const body = await fs.readFile(full, { encoding: "utf8", signal: maintenanceSignal });
        if (body.length > 24_000) continue; // too big to re-pin — the model can Read it
        filePins += `\n\n=== CURRENT content of ${rel} (re-read after compaction) ===\n${body}`;
        if (filePins.length > 60_000) break;
      } catch {
        // deleted/unreadable since — skip
      }
    }

    // Repository constraints are typed, pinned context—not lossy summary
    // material. Re-read every claimed rule and attach its current hash/body so
    // compaction cannot erase it and an on-disk rule change takes effect.
    let instructionPins = "";
    try {
      const activeInstructions = this.cfg.repositoryInstructions?.active();
      instructionPins = renderRepositoryInstructions(
        activeInstructions
          ? await awaitWithAbort(activeInstructions, maintenanceSignal)
          : [],
      );
    } catch {
      instructionPins = "";
    }
    if (maintenanceSignal.aborted) return null;

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
              : "") +
            (instructionPins
              ? `\n\nRepository instructions re-pinned after compaction:\n\n${instructionPins}`
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
    this.invalidateReadEvidence(older);

    const estAfter = this.messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const tokensBefore = Math.round(estBefore * this.tokenScale);
    const tokensAfter = Math.round(estAfter * this.tokenScale);
    this.ineffectiveMicroStreak = 0;
    return {
      type: "compaction",
      summarizedMessages: older.length,
      tokensBefore,
      tokensAfter,
      method,
      messages: this.cfg.includeCompactionProjectionInEvents === false
        ? undefined
        : this.messages.map((message) => ({
            ...message,
            content: message.content.map((block) => ({ ...block })),
          })),
    };
    } finally {
      if (this.activeMaintenanceAttempt === maintenanceAttempt) {
        this.activeMaintenanceAttempt = null;
        if (this.turnPhase === "maintenance") this.turnPhase = "boundary";
      }
    }
  }

  /** Compaction removed the model-visible bytes that justified every edit CAS.
   * Clear engine-owned evidence centrally so child surfaces remain safe even
   * when their host did not install a path-specific trim callback. */
  private invalidateReadEvidence(dropped: readonly Message[]): void {
    this.cfg.fileReadStamps?.clear();
    try {
      this.cfg.onHistoryTrimmed?.(dropped);
    } catch {
      // host bookkeeping never kills a turn
    }
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
    // reminder yields, and (critically) the compaction model call below. Session
    // owns cancellation before this point by durable input identity.
    this.turnAbort = new AbortController();
    this.turnPhase = "boundary";
    this.steeringWakeEpoch = 0;
    this.activeProviderAttempt = null;
    this.activeMaintenanceAttempt = null;

    // Inject pending system-reminders into the user message before yielding
    // turn_start. The turn_start event remains first for stable rollout/daemon
    // consumers, and reminder telemetry follows immediately after.
    const reminders = this.cfg.drainSystemReminders?.() ?? [];
    for (const reminder of reminders) {
      if (reminder.instructionClaims?.length) {
        this.cfg.repositoryInstructions?.claim(reminder.instructionClaims);
      }
    }
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
    if (micro) {
      // Commit the exact reduced projection before exposing the informational
      // reminder or making another provider call. A crash now resumes with the
      // same token footprint instead of re-inflating every old tool result.
      yield micro.projection;
      yield micro.reminder;
    }

    // Smart compaction BEFORE the first model call: if the conversation has
    // grown past the threshold, summarize the old span into a recap and keep
    // recent turns whole — so a long session stays coherent instead of getting
    // its history bluntly trimmed mid-turn.
    // Poll before arming maintenance as well as after it. The continuation from
    // an empty poll to compactIfNeeded's synchronous maintenance transition has
    // no await gap, while an already-admitted correction skips optional summary
    // work and reaches generation immediately.
    const steeringBeforeCompaction = await this.applySteeringAtBoundary();
    const compaction = steeringBeforeCompaction > 0 ? null : await this.compactIfNeeded();
    if (compaction) yield compaction;

    // A steer may arrive while the summarizer/file re-pin awaits. Fold it in
    // before the first provider request instead of making the user wait through
    // an obsolete model/tool batch. A Stop at the same point ends cleanly and
    // never falls through into provider execution.
    if (this.liveSignal().aborted) {
      yield this.terminalTurnEvent({
        type: "turn_end",
        status: "interrupted",
        workStatus: "not_applicable",
        usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    await this.applySteeringAtBoundary();

    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
    let stopReason: StopReason = "end_turn";
    // ZERO-OUTPUT stall counter, turn-scoped. When the provider commits NO
    // usable output repeatedly — nothing at all, or only reasoning that stalls
    // out — even after the prompt was shrunk, the prompt was never the
    // problem — the endpoint is down/misrouted/unable to finish. Without this
    // cap the shrink ladder walked every rung at 90s×2 per rung, across
    // iterations: a field user watched "no stream events for 90s" for 996
    // seconds against a dead glm endpoint before the turn finally failed.
    // Reset on any completed provider call (the provider is demonstrably
    // alive and able to finish).
    let zeroOutputStalls = 0;
    // Big autonomous builds legitimately run long. There is deliberately NO
    // meaningful default iteration cap: the loop-kill detectors below (dead
    // failure loops, no-op repeats, sustained oscillation) are the real
    // terminators, and a productive build may run for as many rounds as the
    // work takes. The default here is a runaway backstop only — an explicit
    // cfg.maxTurns (tests, subagents) or ARES_MAX_TURN_ITERS still binds.
    const maxIters = this.cfg.maxTurns ?? defaultMaxIters();
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
    // CUMULATIVE per-turn failure totals — never reset on non-recurrence. The
    // consecutive streak above catches tight loops; this catches the long
    // edit-build-fail treadmill it is blind to: a real session re-ran the same
    // failing build 14 times over two hours, each attempt separated by reads
    // and edits, so the streak reset every round and nothing ever intervened.
    const failTotal = new Map<string, number>();
    const grindNudgesFired = new Set<string>();
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
    let oscillationStreak = 0;
    let ceilingNudged = false;
    let shellEditHinted = false;
    // Sleep-polling detector. A pomodoro-clock task burned 26 browser calls and
    // 24 seconds of literal Start-Sleep trying to watch a timer tick in real
    // time, then still ended unverified — you cannot observe a minute-scale
    // rule by waiting for it. Counted across the turn (like the grind breaker,
    // not the tight-loop detector) because the sleeps are separated by work.
    let sleepCalls = 0;
    let sleepPollHinted = false;
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
    // GUI ground truth. Headless/unit green does not prove a window renders:
    // the BeanBrawl failure shipped a grey screen behind "27/27 tests pass".
    // Environment providers declare their own artifact matchers and evidence
    // operations; core only enforces that visual proof is newer than mutation.
    const guiSignals = new Set<string>();
    let guiGateFired = false;
    let guiUnverifiedSurfaced = false;
    let specGateFired = false;
    // Freshness is ordered by a monotonic per-turn counter, NOT by wall clock.
    // Two tool outcomes in the same turn routinely land in the same millisecond,
    // and `visualEvidence < lastMutation` then reads false — so a screenshot
    // taken BEFORE an edit counted as proof of the edit. A counter can't tie.
    let evidenceTick = 0;
    let lastMutationTick = 0;
    let visualEvidenceTick = 0;
    const guiNeedsVisualProof = (): boolean =>
      guiSignals.size > 0 && (visualEvidenceTick === 0 || visualEvidenceTick < lastMutationTick);
    let workStatus: WorkStatus = "not_applicable";
    let verificationGenerationAtMutation = this.cfg.verificationEvidence?.().mutationGeneration ?? 0;
    const hasOutstandingVerification = (): boolean => this.cfg.outstandingVerificationRequired?.() === true;
    const hasPersistedVerificationDebt = (): boolean => this.cfg.persistedVerificationDebt?.() === true;
    const hasCompletePersistedVerificationScope = (): boolean => this.cfg.persistedVerificationScopeComplete?.() !== false;
    const requiresVerification = (): boolean => changedFiles.size > 0 || hasOutstandingVerification();
    // The opencode reminder doctrine: remind on TRANSITION, stay silent on
    // standing state. Persisted debt from an old objective used to re-fire the
    // full verification nag on EVERY later turn — including pure conversation
    // ("do I serve it for webgpu?" earned a wall of proof demands). A turn
    // engages the gate only when IT did coding work: mutated files, observed a
    // durable mutation, or ran verification. Standing debt stays visible in
    // the durable-coding-state block and the journal without per-turn nagging.
    const hasCurrentTurnEngagement = (): boolean => {
      if (changedFiles.size > 0) return true;
      if ((this.cfg.observedMutationAt?.() ?? 0) > 0) return true;
      if (manualVerificationAt > 0) return true;
      // Fail closed on LOST scope: debt whose touched-file set didn't survive
      // (crash window, legacy restart) can't be silently adjudicated — we
      // don't even know what's owed, so every turn stays engaged until the
      // owner or the model re-establishes the scope.
      if (
        (this.cfg.persistedVerificationDebt?.() ?? false) &&
        !(this.cfg.persistedVerificationScopeComplete?.() ?? true)
      ) {
        return true;
      }
      // A verifier run that SETTLED against the current mutation generation is
      // engagement too — checks completing during this turn mean the coding
      // objective is actively being adjudicated, even without a fresh edit.
      // An idle verifier (stale generation, or no_checks echo) is not.
      const evidence = this.cfg.verificationEvidence?.();
      return Boolean(
        evidence &&
        evidence.latestRunGeneration === evidence.mutationGeneration &&
        (evidence.latestRunStatus === "passed" || evidence.latestRunStatus === "failed"),
      );
    };
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
      // A turn that did no coding work makes no claims to verify — its status
      // is not_applicable even while the JOURNAL still carries an old
      // objective's debt. Statuses describe turns; the journal describes work.
      if (!hasCurrentTurnEngagement()) return "not_applicable";
      // A GUI artifact without post-mutation visual proof can NEVER resolve
      // verified, no matter how green the headless checks are.
      if (guiNeedsVisualProof()) return "unverified";
      return hasPostMutationProof() ? "verified" : "unverified";
    };

    turnLoop: for (let iter = 0; iter < maxIters; iter++) {
      // Honor a Stop at every iteration boundary — independent of provider
      // timing or whether a tool cooperated with its abort signal. Without this
      // an interrupt during/after a non-cooperative tool wouldn't be felt until
      // the next provider stream (many seconds), so Stop appeared dead.
      if (this.liveSignal().aborted) {
        yield this.terminalTurnEvent({ type: "turn_end", status: "interrupted", workStatus: resolvedWorkStatus(), usage: totalUsage, durationMs: Date.now() - startedAt });
        return;
      }
      // The iteration edge is a safe steering boundary: the prior assistant
      // response and every requested tool result are settled, and the next
      // provider stream has not started. A steer admitted before the first call
      // is also folded in here without creating overlapping execution.
      await this.applySteeringAtBoundary();
      // Context is a loop invariant, not a turn-start chore. Tool results can
      // add far more tokens than the user's opening message, so re-evaluate at
      // every settled model boundary. We are between tool batches here: every
      // tool_use has a paired tool_result and no side effect is in flight.
      if (iter > 0) {
        const boundaryMicro = this.microcompactIfNeeded();
        if (boundaryMicro) {
          yield boundaryMicro.projection;
          yield boundaryMicro.reminder;
        }
        const boundaryCompaction = await this.compactIfNeeded();
        if (boundaryCompaction) yield boundaryCompaction;
        if (this.liveSignal().aborted) {
          yield this.terminalTurnEvent({ type: "turn_end", status: "interrupted", workStatus: resolvedWorkStatus(), usage: totalUsage, durationMs: Date.now() - startedAt });
          return;
        }
        // Maintenance is an awaited boundary too. Steering admitted while the
        // recap was being produced must reach the very next provider call.
        await this.applySteeringAtBoundary();
      }
      // ─── Stream one assistant turn from the provider ─────────────────
      const pendingToolUses: Array<{ id: string; name: string; input: unknown }> = [];
      const toolNameById = new Map<string, string>();
      let assistantMessage: Message | null = null;
      let streamError: { code: string; message: string; retriable: boolean; retryAfterMs?: number } | null = null;
      let terminalMessageEvent: Extract<StreamEvent, { type: "message_done" }> | null = null;
      let completedProviderAttemptId: string | null = null;
      let supersededProviderAttemptId: string | null = null;

      try {
        const activeTools = selectToolsForTurn(this.cfg.tools, this.messages, {
          providerName: this.cfg.provider.name,
          model: this.cfg.model,
          workflowMode: this.cfg.workflowMode?.(),
        });
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
        // Start the ladder from the learned serving ceiling, not the configured
        // budget — re-walking rungs the provider already rejected burns minutes
        // of stall watchdogs per iteration for a guaranteed failure.
        const configuredBudget = this.cfg.contextBudgetTokens ?? 0;
        const effectiveBudget =
          this.learnedContextCeiling !== null
            ? configuredBudget > 0
              ? Math.min(configuredBudget, this.learnedContextCeiling)
              : this.learnedContextCeiling
            : configuredBudget;
        // Every rung is FLOORED at overhead + a real slice of recent history.
        // The bottom rungs (8k/4k) sat below the fixed prompt overhead (system
        // prompt + tool schemas ≈ 10-25k estimate tokens), so reaching them
        // didn't produce a smaller prompt — it produced a historyless one:
        // budgetMessages stripped everything but the pending message and the
        // model denied instructions from two turns ago (field report,
        // 2026-08-05). Rungs that collapse to the same floored value dedupe
        // (walking three identical sizes burns stall-watchdog minutes for the
        // same guaranteed outcome); raw/scaled stay paired so ceiling-learning
        // keeps indexing the REAL rung values.
        const rawLadder = contextBudgetAttempts(effectiveBudget);
        const scaledOf = (raw: number) => (raw > 0 ? Math.max(1, Math.floor(raw / this.tokenScale)) : raw);
        // The TOP rung is configuration, not a guess: a deliberately tiny
        // budget (num_ctx-style, where the provider silently truncates instead
        // of rejecting) must be enforced proactively and exactly. The floor
        // therefore applies only to DESCENT rungs — and never exceeds the top
        // rung, so a tiny configured budget stays authoritative.
        const topScaled = scaledOf(rawLadder[0]);
        const rungFloor = Math.min(
          overheadTokens + MIN_RECENT_HISTORY_TOKENS,
          topScaled > 0 ? topScaled : Number.POSITIVE_INFINITY,
        );
        const budgetPairs: Array<{ raw: number; scaled: number }> = [];
        rawLadder.forEach((raw, i) => {
          const scaled = i === 0 || raw <= 0 ? scaledOf(raw) : Math.max(rungFloor, scaledOf(raw));
          if (!budgetPairs.some((p) => p.scaled === scaled)) budgetPairs.push({ raw, scaled });
        });
        // The raw bottom rung survives UNFLOORED as the true last resort: a
        // provider whose real window sits below the floor (tiny local models)
        // must still get a sendable prompt instead of a hard-failed turn.
        // Stall-driven shrink is capped two rungs above the end, so only hard
        // context-limit rejections can ever walk down here — and this final
        // rung is also the only one where budgetMessages may trim below the
        // recent-history keep-floor.
        const bottomRaw = rawLadder[rawLadder.length - 1];
        const bottomScaled = scaledOf(bottomRaw);
        if (bottomRaw > 0 && budgetPairs.length > 0 && bottomScaled < budgetPairs[budgetPairs.length - 1].scaled) {
          budgetPairs.push({ raw: bottomRaw, scaled: bottomScaled });
        }
        const budgetAttempts = budgetPairs.map((p) => p.scaled);
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
            terminalMessageEvent = null;
            completedProviderAttemptId = null;
            modelStarted = false;

            // Recent history survives trimming (minKeep 4) on DESCENT rungs —
            // stall/rejection-driven guesses may not erase the conversation
            // from the model's view. Two exceptions trim freely: the TOP rung
            // (the configured budget is authoritative — silently-truncating
            // providers need it enforced exactly) and the LAST rung, the
            // last resort reachable only by hard context-limit evidence,
            // where a pending-message-only prompt beats a hard-failed turn.
            const budgeted = budgetMessages(
              this.messages,
              budgetAttempts[attempt],
              overheadTokens,
              attempt === 0 || attempt === budgetAttempts.length - 1 ? 1 : 4,
            );
            if (budgeted.trimmed > 0) {
              // File contents in the dropped span are no longer visible to the
              // model — let the host invalidate read stamps so re-reads pass.
              this.invalidateReadEvidence(budgeted.dropped);
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
            // A boundary event above (for example a context-ledger notice) can
            // yield long enough for a steer to be admitted before the request is
            // armed. Re-snapshot the inbox and rebuild the prompt rather than
            // launching one knowingly stale provider attempt.
            const providerAttempt = await this.armProviderAttemptAtBoundary();
            if (!providerAttempt) {
              iter--;
              continue turnLoop;
            }
            // A provider attempt is speculative until its terminal Message is
            // installed. Steering owns a separate abort controller from Stop and
            // the stall watchdog: cancelling it discards only this attempt and
            // keeps the durable owner generation alive.
            const stallAbort = new AbortController();
            yield { type: "provider_attempt_started", attemptId: providerAttempt.id };

            let sawCommittedOutput = false;
            try {
              if (!providerAttempt.supersededBySteering) {
                const providerInterrupt = AbortSignal.any([this.liveSignal(), providerAttempt.steeringAbort.signal]);
                // Awaited so the record is durably on disk before the request
                // is armed — a call that never returns still leaves its shape.
                await this.logWirePrompt({
                  at: new Date().toISOString(),
                  attemptId: providerAttempt.id,
                  provider: this.cfg.provider.name,
                  model: this.cfg.model,
                  attempt,
                  budgetTokens: budgetAttempts[attempt],
                  estPromptTokens,
                  overheadTokens,
                  systemChars: this.cfg.systemPrompt.length,
                  toolCount: toolDescriptors.length,
                  trimmedMessages: budgeted.trimmed,
                  messages: outboundMessages.map((m) => ({
                    role: m.role,
                    estTokens: estimateMessageTokens(m),
                    blocks: m.content.map((b) => this.wireBlockSummary(b)),
                  })),
                });
                const stream = this.cfg.provider.stream({
                  model: this.cfg.model,
                  system: this.cfg.systemPrompt,
                  messages: outboundMessages,
                  tools: toolDescriptors,
                  signal: AbortSignal.any([providerInterrupt, stallAbort.signal]),
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

                for await (const ev of guardStreamStalls(stream, {
                  idleMs: streamIdleMs(),
                  activeIdleMs: streamActiveIdleMs(),
                  thinkCeilingMs: thinkCeilingMs(),
                  onStall: () => stallAbort.abort(),
                  interruptSignal: providerInterrupt,
                })) {
                  // requestSteeringPreemption() can win while the iterator has
                  // already produced one more event. Never expose that losing
                  // event or give it conversation authority.
                  if (providerAttempt.supersededBySteering) break;
                  if (
                    ev.type === "error" &&
                    isContextLimitError(ev.error) &&
                    !modelStarted &&
                    attempt < budgetAttempts.length - 1
                  ) {
                    streamError = ev.error;
                    break;
                  }

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
                    terminalMessageEvent = ev;
                    addUsageInto(totalUsage, ev.usage);
                    stopReason = ev.stopReason;
                    // The provider just completed a call — it is alive; the
                    // dead-endpoint stall counter starts over.
                    zeroOutputStalls = 0;
                    this.calibrateTokens(estPromptTokens, ev.usage);
                    // message_done is the durable assistant commit boundary. Hold
                    // it until the steering inbox has been checked below.
                    continue;
                  }
                  if (ev.type === "error") streamError = ev.error;

                  // Deltas are speculative UI output. The matching superseded
                  // event rolls them back if steering cancels this attempt.
                  yield ev;
                }
              }
            } finally {
              if (providerAttempt.supersededBySteering) {
                supersededProviderAttemptId = providerAttempt.id;
              } else {
                completedProviderAttemptId = providerAttempt.id;
              }
            }

            if (providerAttempt.supersededBySteering) {
              pendingToolUses.length = 0;
              toolNameById.clear();
              assistantMessage = null;
              terminalMessageEvent = null;
              streamError = null;
              if (this.activeProviderAttempt === providerAttempt) this.activeProviderAttempt = null;
              this.turnPhase = "boundary";
              break retryStream;
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
              transientRetry < (isCapacityError(streamError) ? MAX_CAPACITY_RETRIES : MAX_TRANSIENT_RETRIES)
            ) {
              transientRetry++;
              // Honor a server-provided reset window (Retry-After) when it's
              // longer than our exponential backoff — burning four 12s-capped
              // retries against a 30s 429 window just fails a turn that waiting
              // would have completed. The provider already clamps it to 60s.
              const capacity = isCapacityError(streamError);
              const retryBudget = capacity ? MAX_CAPACITY_RETRIES : MAX_TRANSIENT_RETRIES;
              let waitMs = Math.max(
                capacity ? capacityBackoffMs(transientRetry) : transientBackoffMs(transientRetry),
                streamError.retryAfterMs ?? 0,
              );
              let note = capacity
                ? `${this.cfg.model} is overloaded upstream — retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${transientRetry}/${retryBudget}). Your message is safe.`
                : `provider hiccup (${streamError.code}); retrying in ${(waitMs / 1000).toFixed(1)}s — attempt ${transientRetry}/${retryBudget}`;
              if (isStallError(streamError)) {
                // Fail fast on a request that will never complete: if four
                // attempts committed no usable output — nothing at all, or
                // only reasoning that stalled out — no smaller prompt is going
                // to fix it. Counting thinking-only stalls matters: a thinking
                // model sets modelStarted on its first thinking_delta, which
                // used to exempt it from this breaker entirely and let it walk
                // the ladder through 180-second silences all the way down.
                if (!sawCommittedOutput) zeroOutputStalls++;
                if (zeroOutputStalls >= 4) {
                  streamError = {
                    code: "provider_unresponsive",
                    message:
                      `${this.cfg.model} produced no committed output across ${zeroOutputStalls} attempts at multiple prompt sizes — ` +
                      `the provider endpoint looks unreachable, unresponsive, or unable to finish this request; the prompt is not the problem. ` +
                      `Switching model/provider or retrying later is the fix; resending the same request is not.`,
                    retriable: false,
                  };
                  break retryStream;
                }
                // Two consecutive stalls at the same window size usually mean the
                // provider is choking on the PROMPT itself (deepseek/ollama-cloud
                // stall silently on very large prompts) — re-issuing the same size
                // just burns another 90s of dead air. Shrink the history window
                // and go again instead (bug report 4a8ac088: 90s×2+ of silence).
                // At most TWO stall-driven shrinks per turn, and NEVER onto
                // the final rung (the minKeep=1 last resort): a stall is weak
                // evidence about prompt size, and unbounded descent is how a
                // run of reasoning stalls marched the window down to rungs
                // that couldn't hold any history at all. Context-limit
                // rejections (hard evidence) keep the full ladder.
                if (transientRetry >= 2 && !sawCommittedOutput && attempt < Math.min(2, budgetAttempts.length - 2)) {
                  // Shrink THIS attempt only — a stall is not evidence about
                  // prompt size (brownouts, sleep/wake, slow prefill all stall),
                  // so it must never teach a persistent ceiling. Learning here
                  // ratcheted sessions down to a few thousand tokens after one
                  // bad provider outage, with no recovery path.
                  yield {
                    type: "system_reminder_injected",
                    text: `Provider stalled ${transientRetry} times at this prompt size; retrying with a smaller recent-history window (${budgetAttempts[attempt + 1].toLocaleString()} tokens). Every outbound prompt's shape is logged in .ares/wire-log/${this.sessionId}.jsonl for diagnosis.`,
                    source: "compaction",
                  };
                  if (providerAttempt.supersededBySteering) {
                    supersededProviderAttemptId = providerAttempt.id;
                    pendingToolUses.length = 0;
                    assistantMessage = null;
                    terminalMessageEvent = null;
                    streamError = null;
                    if (this.activeProviderAttempt === providerAttempt) this.activeProviderAttempt = null;
                    this.turnPhase = "boundary";
                    break retryStream;
                  }
                  if (this.activeProviderAttempt === providerAttempt) this.activeProviderAttempt = null;
                  this.turnPhase = "boundary";
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
              await abortableDelay(
                waitMs,
                AbortSignal.any([this.liveSignal(), providerAttempt.steeringAbort.signal]),
              );
              if (providerAttempt.supersededBySteering) {
                supersededProviderAttemptId = providerAttempt.id;
                pendingToolUses.length = 0;
                assistantMessage = null;
                terminalMessageEvent = null;
                streamError = null;
                if (this.activeProviderAttempt === providerAttempt) this.activeProviderAttempt = null;
                this.turnPhase = "boundary";
                break retryStream;
              }
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
            // Hard evidence of the provider's real limit — remember it so the
            // next iteration's ladder starts at a rung that can fit. Floored:
            // a ceiling below 16k would put compaction's target under its own
            // keep-floor (compaction would then fire every single turn), and no
            // real serving layer rejects 16k prompts — below that, shrink this
            // attempt without persisting. Payload-size rejections (413) still
            // shrink THIS attempt — fewer messages and images genuinely shrink
            // the body — but teach nothing: they're evidence about request
            // BYTES (usually one big image), not the model's token window, and
            // learning them permanently crippled hours-long sessions.
            const learnedRung = budgetPairs[attempt + 1].raw;
            if (learnedRung >= 16_000 && !isPayloadSizeError(streamError)) {
              this.learnedContextCeiling = Math.min(
                this.learnedContextCeiling ?? Number.POSITIVE_INFINITY,
                learnedRung,
              );
            }
            yield {
              type: "system_reminder_injected",
              text: `Provider rejected the prompt as too large; retrying with a smaller recent-history window (${budgetAttempts[attempt + 1].toLocaleString()} tokens).`,
              source: "compaction",
            };
            const activeAfterBudgetNotice = this.currentProviderAttempt();
            if (activeAfterBudgetNotice?.supersededBySteering) {
              supersededProviderAttemptId = activeAfterBudgetNotice.id;
              pendingToolUses.length = 0;
              assistantMessage = null;
              terminalMessageEvent = null;
              streamError = null;
              this.activeProviderAttempt = null;
              this.turnPhase = "boundary";
              break;
            }
            this.activeProviderAttempt = null;
            this.turnPhase = "boundary";
            continue;
          }
          break;
        }
      } catch (err) {
        // An adapter may throw while its steering signal is closing. That
        // attempt has already lost authority; report no provider failure and
        // continue through the durable correction boundary below.
        if (!supersededProviderAttemptId) {
          const message = err instanceof Error ? err.message : String(err);
          this.markTurnTerminal();
          yield { type: "error", error: { code: "provider_throw", message, retriable: false } };
          yield this.terminalTurnEvent({
            type: "turn_end",
            status: "failed",
            workStatus: resolvedWorkStatus(),
            usage: totalUsage,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
      }

      // guardStreamStalls intentionally swallows the AbortError raised while it
      // closes the provider iterator. Without this explicit branch, Stop fell
      // through to the missing-message guard and surfaced as a FAILED
      // `no_message_done` turn even though the abort worked.
      if (this.liveSignal().aborted) {
        yield this.terminalTurnEvent({
          type: "turn_end",
          status: "interrupted",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const activeAfterStream = this.currentProviderAttempt();
      if (activeAfterStream?.supersededBySteering) {
        supersededProviderAttemptId = activeAfterStream.id;
      }

      if (supersededProviderAttemptId) {
        if (this.currentProviderAttempt()?.id === supersededProviderAttemptId) {
          this.activeProviderAttempt = null;
        }
        this.turnPhase = "boundary";
        yield {
          type: "provider_attempt_superseded",
          attemptId: supersededProviderAttemptId,
          reason: "steering",
        };
        // The steer may have been cancelled after it woke us. The provider
        // attempt is disposable either way: a missing claim is not authority to
        // fail the owner's still-live turn, so simply regenerate from history.
        await this.applySteeringAtBoundary();
        // Same durable input, same runner generation, fresh provider attempt.
        iter--;
        continue;
      }

      // Close the race between the provider's terminal frame and committing its
      // assistant Message. If a durable correction is already present, the old
      // response (including every proposed tool call) remains speculative and
      // is discarded without creating orphan tool_use blocks.
      let steeringAtCommit = await this.applySteeringAtBoundary();
      // applySteeringAtBoundary() awaits the host. A newly admitted steer can
      // wake the attempt after that host call took its empty snapshot but before
      // this continuation commits the Message. Re-check the attempt flag, then
      // take one more durable inbox snapshot before making the decision.
      const activeAtCommit = this.currentProviderAttempt();
      const racedAttemptId: string | null = activeAtCommit?.supersededBySteering
        ? activeAtCommit.id
        : null;
      if (racedAttemptId && steeringAtCommit === 0) {
        steeringAtCommit = await this.applySteeringAtBoundary();
      }
      if (steeringAtCommit > 0 || racedAttemptId) {
        const supersededAttemptId: string | null = racedAttemptId ?? this.currentProviderAttempt()?.id ?? completedProviderAttemptId;
        if (this.currentProviderAttempt()?.id === supersededAttemptId) this.activeProviderAttempt = null;
        this.turnPhase = "boundary";
        if (supersededAttemptId) {
          yield {
            type: "provider_attempt_superseded",
            attemptId: supersededAttemptId,
            reason: "steering",
          };
        }
        iter--;
        continue;
      }

      if (streamError) {
        this.activeProviderAttempt = null;
        this.turnPhase = "boundary";
        // Provider-emitted errors were already forwarded from the stream.
        // LOCALLY SYNTHESIZED errors were not: they replace streamError after
        // the raw event went out, so without this yield the diagnosis never
        // reaches the consumer — the unresponsive-breaker's "switch provider,
        // don't resend" verdict was invisible, and the turn just read as one
        // more stall.
        if (streamError.code === "no_message_done" || streamError.code === "provider_unresponsive") {
          this.markTurnTerminal();
          yield { type: "error", error: streamError };
        }
        yield this.terminalTurnEvent({
          type: "turn_end",
          // A user interrupt surfaces as a provider abort error — report it as
          // interrupted, not failed.
          status: this.liveSignal().aborted ? "interrupted" : "failed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (!assistantMessage) {
        this.activeProviderAttempt = null;
        this.turnPhase = "boundary";
        this.markTurnTerminal();
        yield {
          type: "error",
          error: { code: "no_message_done", message: "provider closed stream without message_done", retriable: false },
        };
        yield this.terminalTurnEvent({
          type: "turn_end",
          status: "failed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

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

      // Linearize provider completion before exposing message_done. Every tool
      // proposal inherits the current steering epoch; a later epoch may skip
      // only calls that have not crossed their implementation-entry boundary.
      const hasProposedTools = pendingToolUses.length > 0;
      const toolBatchSteeringEpoch = this.steeringWakeEpoch;
      this.activeProviderAttempt = null;
      this.turnPhase = hasProposedTools ? "effect" : "boundary";
      this.messages.push(assistantMessage);
      if (terminalMessageEvent) yield terminalMessageEvent;

      // ─── Tool execution phase ────────────────────────────────────────
      if (pendingToolUses.length === 0) {
        // A correction that arrived during this provider call preempts the
        // model's attempted finish. Install and acknowledge it, then give the
        // same active generation another model round to respond.
        if (await this.applySteeringAtBoundary() > 0) {
          iter--;
          continue;
        }
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
        // GUI ground-truth gate. A manifest-matched environment artifact can
        // pass every headless check and still open broken — pixels are proof. Require a
        // successful screenshot NEWER than the last mutation before accepting
        // "done". One push; a second unsupported finish ends honestly as
        // GUI-UNVERIFIED (and resolvedWorkStatus stays unverified).
        if (
          this.cfg.requireVerificationEvidence &&
          workStatus !== "blocked" &&
          requiresVerification() &&
          guiNeedsVisualProof() &&
          !this.liveSignal().aborted
        ) {
          // Without a screenshot-capable tool in the belt (headless workers,
          // non-Windows builds) demanding one is a dead order — skip straight
          // to the honest GUI-UNVERIFIED disclosure instead.
          const hasVisualTool = this.cfg.tools.some((t) => /^(?:computeruse|browser|capability)$/i.test(t.schema.name));
          if (!guiGateFired && hasVisualTool) {
            guiGateFired = true;
            const what = [...guiSignals].slice(0, 4).join(", ");
            const text = `This task produced a WINDOWED app artifact (${what}), and there is no screenshot of the running app newer than your last change. Headless boots and unit tests do not prove the UI renders — an app can pass every logic test and still open to a broken/grey screen. Use the matching environment Capability's read-only observation operation (acquire one if missing), ComputerUse {action:"screenshot"}, or Browser screenshot for a web UI. Inspect the fresh pixels and confirm what is on screen matches the claim. If this environment cannot expose pixels, say so plainly instead of claiming the UI works.`;
            this.messages.push({
              id: cryptoId(),
              role: "user",
              content: [{ type: "system_reminder", text }],
              createdAt: new Date().toISOString(),
            });
            yield { type: "system_reminder_injected", text, source: "verifier" };
            continue;
          }
          if (!guiUnverifiedSurfaced) {
            guiUnverifiedSurfaced = true;
            yield {
              type: "system_reminder_injected",
              text: "GUI-UNVERIFIED at turn end: a windowed-app artifact changed, but no screenshot of the running app was captured after the last change. The UI may not render as claimed.",
              source: "verifier",
            };
          }
        }
        // Spec-checklist gate: when a spec/requirements doc anchored this
        // coding objective, force one requirements-vs-artifacts diff before
        // the first completion claim — the guard against silent scope
        // reduction (spec demanded screenshots/commits/tests that were never
        // produced, yet "done" was claimed).
        {
          const specDocs = this.cfg.specDocs?.() ?? [];
          if (
            this.cfg.requireVerificationEvidence &&
            workStatus !== "blocked" &&
            requiresVerification() &&
            hasCurrentTurnEngagement() &&
            specDocs.length > 0 &&
            !specGateFired &&
            !this.liveSignal().aborted
          ) {
            specGateFired = true;
            const docs = specDocs.slice(0, 4).join(", ");
            const text = `Before finishing: re-open the task spec (${docs}) and diff it against what you actually produced. Enumerate every EXPLICIT deliverable and verification artifact it demands — files, screenshots, tests, builds, commits — and confirm each exists on disk right now. List anything missing or cut and why; do not silently reduce scope. If the spec calls for committed milestones, confirm the working tree is actually committed (git status), not just edited.`;
            this.messages.push({
              id: cryptoId(),
              role: "user",
              content: [{ type: "system_reminder", text }],
              createdAt: new Date().toISOString(),
            });
            yield { type: "system_reminder_injected", text, source: "verifier" };
            continue;
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
          hasCurrentTurnEngagement() &&
          !hasPostMutationProof() &&
          !this.liveSignal().aborted
        ) {
          workStatus = "unverified";
          if (!proofGateFired) {
            proofGateFired = true;
            const sample = [...changedFiles].slice(0, 8).map((file) => file.startsWith("<") ? file : path.relative(this.cfg.workspace, file)).join(", ");
            const scope = changedFiles.size > 0 ? `You changed ${changedFiles.size} file(s)` : "This long-running coding task still has unverified persisted changes";
            // Name what would actually count for THIS project — "run the
            // affected tests" is a dead instruction in a project with none.
            const projectHint = await verificationHintFor(this.cfg.workspace).catch(() => "");
            const text = `${scope}, but Ares has no complete all-green behavior-capable verifier run for the newest mutation generation${sample ? ` (${sample})` : ""}. Static syntax/type/lint checks are useful but do not prove requested behavior.${projectHint ? ` ${projectHint}` : " Run the narrowest meaningful affected tests or real reproduction now."} A skipped tool, an older run, one passing command inside a red run, or a verbal claim is not proof.`;
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
        if (!this.liveSignal().aborted && !(await this.closeTurnAtBoundary())) {
          iter--;
          continue;
        }
        yield this.terminalTurnEvent({
          type: "turn_end",
          status: this.liveSignal().aborted ? "interrupted" : "completed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const resultByToolUseId = new Map<string, ToolResultBlock>();
      const runnable: ResolvedToolUse[] = [];
      const steeringSkippedToolUseIds = new Set<string>();
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

        const normalizedInput = normalizeToolInput(tool.schema.name, use.input);
        let effectiveSafety = tool.schema.safety;
        try {
          effectiveSafety = tool.classifyInput?.(normalizedInput).safety ?? effectiveSafety;
        } catch {
          // malformed inputs retain the conservative static class
        }
        this.assertEffectAuthority(tool.schema.name, effectiveSafety);
        runnable.push({
          ...use,
          name: tool.schema.name,
          input: normalizedInput,
          tool,
          safety: effectiveSafety,
        });
      }

      let interruptedByTool = false;
      const useById = new Map(pendingToolUses.map((u) => [u.id, u] as const));
      for (const batch of buildDepAwareBatches(runnable, this.cfg.workspace)) {
        // Capture BEFORE yielding tool events to the host: Session/UI consumers
        // schedule verification while tool_end is yielded, so reading the
        // generation after yield would mistake the new generation for baseline.
        const verificationGenerationBeforeBatch = this.cfg.verificationEvidence?.().mutationGeneration ?? verificationGenerationAtMutation;
        const outcomes = yield* this.runToolBatch(batch, toolBatchSteeringEpoch);
        for (const outcome of outcomes) {
          resultByToolUseId.set(outcome.toolUseId, outcome.result);
          if (outcome.skippedBySteering) steeringSkippedToolUseIds.add(outcome.toolUseId);
          interruptedByTool ||= outcome.interrupted === true;
          evidenceTick++; // strictly increasing, in outcome order
          if (outcome.touchedFiles?.length) {
            verificationGenerationAtMutation = verificationGenerationBeforeBatch;
            lastMutationAt = Math.max(lastMutationAt, outcome.finishedAt ?? Date.now());
            lastMutationTick = evidenceTick;
            for (const file of outcome.touchedFiles) changedFiles.add(file);
            workStatus = "unverified";
          } else if (outcome.potentialMutation) {
            verificationGenerationAtMutation = verificationGenerationBeforeBatch;
            lastMutationAt = Math.max(lastMutationAt, outcome.finishedAt ?? Date.now());
            lastMutationTick = evidenceTick;
            changedFiles.add("<shell-mediated workspace changes>");
            workStatus = "unverified";
          }
          // GUI ground-truth tracking: collect windowed-app signals from this
          // outcome, and credit visual evidence from successful screenshot
          // calls (ComputerUse always captures pixels; Browser only counts
          // when the result actually carries an image — its embedded-engine
          // fallback is a self-flagged text snapshot).
          {
            const use = useById.get(outcome.toolUseId);
            if (use && outcome.result.is_error !== true) {
              const signalCountBefore = guiSignals.size;
              for (const sig of guiArtifactSignals(use.name, use.input, outcome.touchedFiles, outcome.output)) guiSignals.add(sig);
              const hostSignals = await this.cfg.environmentArtifactSignals?.({
                toolName: use.name,
                input: use.input,
                output: outcome.output,
                touchedFiles: outcome.touchedFiles,
              });
              for (const sig of hostSignals ?? []) guiSignals.add(sig);
              // External editor/environment mutations may not touch a workspace
              // file at all (for example, changing a live scene transform). A
              // newly armed provider signal is therefore itself mutation debt.
              if (
                guiSignals.size > signalCountBefore &&
                !outcome.touchedFiles?.length &&
                !outcome.potentialMutation
              ) {
                lastMutationAt = Math.max(lastMutationAt, outcome.finishedAt ?? Date.now());
                lastMutationTick = evidenceTick;
                changedFiles.add("<environment-provider state>");
                workStatus = "unverified";
              }
              if (isVisualEvidenceCall(use.name, use.input, outcome.result, outcome.output)) {
                visualEvidenceTick = evidenceTick;
              }
            }
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
          if (steeringSkippedToolUseIds.size > 0 && completedProviderAttemptId) {
            yield {
              type: "provider_attempt_effects_skipped",
              attemptId: completedProviderAttemptId,
              reason: "steering",
              toolUseIds: [...steeringSkippedToolUseIds],
            };
          }
          yield this.terminalTurnEvent({
            type: "turn_end",
            status: "interrupted",
            workStatus: resolvedWorkStatus(),
            usage: totalUsage,
            durationMs: Date.now() - startedAt,
          });
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
      if (steeringSkippedToolUseIds.size > 0 && completedProviderAttemptId) {
        yield {
          type: "provider_attempt_effects_skipped",
          attemptId: completedProviderAttemptId,
          reason: "steering",
          toolUseIds: [...steeringSkippedToolUseIds],
        };
      }
      this.turnPhase = "boundary";

      // Tools are fully settled and their results are paired in history. This
      // is the earliest safe point to apply steering admitted while a tool was
      // running; continue immediately so no convergence/end guard can consume
      // the correction without the model seeing it.
      if (await this.applySteeringAtBoundary() > 0) {
        // Owner steering grants the replacement response its own provider slot.
        // Otherwise maxTurns=1 can pair skipped effects correctly and then fail
        // before the model ever sees or answers the correction.
        iter--;
        continue;
      }

      // ── shell-regex file-edit hint (one-shot) ───────────────────────────
      // Editing files via shell regex replace (`-replace` + Set-Content, or
      // `sed -i`) fails SILENTLY when the pattern doesn't match — the command
      // "succeeds", the file is unchanged, and the model chases phantom bugs
      // (observed live: ~15 rounds lost to a project.godot no-op replace).
      // The Edit tool errors loudly on no-match; nudge toward it once.
      if (!shellEditHinted) {
        const shellRegexEdit = pendingToolUses.some((u) => {
          if (u.name !== "PowerShell" && u.name !== "Bash") return false;
          const cmd = (u.input as Record<string, unknown> | null | undefined)?.["command"];
          if (typeof cmd !== "string") return false;
          return /\bsed\s+(?:-\w*\s+)*-i\b/.test(cmd) ||
            (/-replace\s/.test(cmd) && /\b(?:set-content|out-file|add-content)\b/i.test(cmd));
        });
        if (shellRegexEdit) {
          shellEditHinted = true;
          this.messages.push({
            id: cryptoId(),
            role: "user",
            content: [{
              type: "system_reminder",
              text: "You edited a file via shell regex replace (`-replace`/`sed -i`). If the pattern doesn't match, that silently does NOTHING — the command still exits 0 and the file stays stale. Prefer the Edit tool: it fails loudly when the target string isn't found. If you reached for the shell because the replacement content is large (inlining a library, splicing in a generated file), use Edit's `new_string_from_file` instead — it reads the bytes straight off disk, so nothing is truncated and the match is still checked. If you keep the shell approach, verify the file actually changed (grep for the new value) before relying on it.",
            }],
            createdAt: new Date().toISOString(),
          });
          yield { type: "system_reminder_injected", text: "shell-regex file edit detected — Edit tool fails loudly, shell replace fails silently", source: "instructions" };
        }
      }

      // ── sleep-polling hint (one-shot) ───────────────────────────────────
      // Waiting in real time to observe time-dependent behaviour cannot prove
      // a minute-scale rule and eats the turn. Drive the logic instead.
      for (const use of pendingToolUses) {
        if (use.name !== "PowerShell" && use.name !== "Bash") continue;
        const cmd = (use.input as Record<string, unknown> | null | undefined)?.["command"];
        if (typeof cmd !== "string") continue;
        if (/^\s*(?:start-sleep|sleep)\b/i.test(cmd) || /\b(?:start-sleep\s+-seconds|sleep)\s+\d+\s*$/i.test(cmd)) {
          sleepCalls++;
        }
      }
      if (sleepCalls >= 3 && !sleepPollHinted) {
        sleepPollHinted = true;
        const text =
          "You've now slept 3+ times this turn to watch something happen. Real-time waiting cannot prove time-dependent behaviour (a timer, an interval, \"randomises every minute\") — the wait is always either too short to be evidence or too long to afford. Drive the logic directly instead: with Browser eval, call the page's own tick/update/randomise function in a loop and collect the outputs, or override the clock (Date.now / performance.now) and invoke the interval callback yourself. One eval that exercises 60 iterations is stronger proof than any number of screenshots spaced a minute apart. Reserve real sleeps for a process that genuinely needs boot time (a dev server), and even then poll its readiness, not the wall clock.";
        this.messages.push({
          id: cryptoId(),
          role: "user",
          content: [{ type: "system_reminder", text }],
          createdAt: new Date().toISOString(),
        });
        yield { type: "system_reminder_injected", text: "sleep-polling detected — drive the logic with eval instead of waiting", source: "instructions" };
      }

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
          // Cumulative grind counter. Shell failures get the command HEAD in
          // the key so a failing build and a failing test run don't pool into
          // one "exited with code #" bucket.
          const input = use.input as { command?: unknown } | undefined;
          const shellHead =
            (use.name === "Bash" || use.name === "PowerShell") && typeof input?.command === "string"
              ? `::${input.command.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase().slice(0, 48)}`
              : "";
          const grindKey = `${sig}${shellHead}`;
          failTotal.set(grindKey, (failTotal.get(grindKey) ?? 0) + 1);
        }
      }
      // reset streaks for signatures that did NOT recur this round
      for (const sig of [...failStreak.keys()]) {
        if (!seenThisRound.has(sig)) failStreak.delete(sig);
      }
      // ── grind breaker: the SAME failure accumulating across the turn ──────
      // Not a tight loop (edits and reads happen between attempts), so no
      // turn-kill — escalating strategy pressure instead. Fires once per
      // threshold per signature.
      for (const [grindKey, total] of failTotal.entries()) {
        const threshold = total >= 8 ? 8 : total >= 4 ? 4 : 0;
        if (threshold === 0) continue;
        const onceKey = `${grindKey}@${threshold}`;
        if (grindNudgesFired.has(onceKey)) continue;
        grindNudgesFired.add(onceKey);
        const text =
          threshold === 4
            ? `GRIND ALERT: this exact failure has now occurred 4 times this turn (${grindKey.split("::")[0]}). Tweaking and re-running is not converging. Before the next attempt: (1) read the COMPLETE error output — not the last lines, the first error; (2) reduce scope: reproduce the failure in the smallest unit (one file, one target, one test) instead of the full build; (3) state, in one sentence, what is different about the next attempt and why that difference addresses the actual error. If you cannot name a difference, the approach is wrong — change it.`
            : `GRIND STOP: 8 attempts have failed with this same signature. This approach is exhausted. Stop re-running it. Either take a fundamentally different route (different tool, different layer, question an assumption you have not verified), or report honestly to the user: what you tried, the exact error, and what you need from them. Continuing to grind the same failure is the one option that is no longer acceptable.`;
        this.messages.push({
          id: cryptoId(),
          role: "user",
          content: [{ type: "system_reminder", text }],
          createdAt: new Date().toISOString(),
        });
        yield {
          type: "system_reminder_injected",
          text: `grind-breaker: same failure ×${total} this turn — forcing a strategy re-think`,
          source: "instructions",
        };
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
      // ── loop-kill: dead failure loop ────────────────────────────────────
      // The breaker (3×) and failure-recall (2×) already intervened. A model
      // still re-issuing the SAME failing call after both interventions is
      // provably stuck — and with no default iteration cap, this terminator is
      // what ends the turn. Fail honestly with the loop named, never hang.
      const deadSig = [...failStreak.entries()].find(([, n]) => n >= loopKillLimit())?.[0];
      if (deadSig) {
        const toolName = deadSig.split(":")[0];
        this.markTurnTerminal();
        yield {
          type: "error",
          error: {
            code: "loop_detected",
            message: `stuck loop: ${toolName} failed identically ${failStreak.get(deadSig)} rounds in a row despite strategy-change interventions`,
            retriable: false,
          },
        };
        yield this.terminalTurnEvent({
          type: "turn_end",
          status: "failed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        });
        return;
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
      // ── loop-kill: no-op repeat loop ────────────────────────────────────
      // Identical SUCCESSFUL call still being re-issued long after the nudge
      // fired (3× warns, 3× the limit kills). Same contract as the failure
      // loop-kill: with no iteration cap, sustained no-op repetition must end
      // the turn honestly instead of burning tokens forever.
      const noopSig = [...repeatStreak.entries()].find(([, n]) => n >= repeatCallLimit() * 3)?.[0];
      if (noopSig) {
        const toolName = pendingToolUses.find((u) => canonicalCallSignature(u.name, u.input) === noopSig)?.name ?? noopSig.split("::")[0];
        this.markTurnTerminal();
        yield {
          type: "error",
          error: {
            code: "loop_detected",
            message: `stuck loop: identical ${toolName} call repeated ${repeatStreak.get(noopSig)} rounds with no new input despite convergence nudges`,
            retriable: false,
          },
        };
        yield this.terminalTurnEvent({
          type: "turn_end",
          status: "failed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
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
      const oscillating =
        h.length >= 4 &&
        h[h.length - 1] === h[h.length - 3] &&
        h[h.length - 2] === h[h.length - 4] &&
        h[h.length - 1] !== h[h.length - 2];
      // ── loop-kill: sustained oscillation ────────────────────────────────
      // The one-shot nudge below fires on the first detection; a model still
      // ping-ponging A/B/A/B many rounds later has ignored it. Terminate.
      oscillationStreak = oscillating ? oscillationStreak + 1 : 0;
      if (oscillationStreak >= loopKillLimit()) {
        this.markTurnTerminal();
        yield {
          type: "error",
          error: {
            code: "loop_detected",
            message: `stuck loop: A/B oscillation between two tool-call states persisted ${oscillationStreak} rounds despite the convergence nudge`,
            retriable: false,
          },
        };
        yield this.terminalTurnEvent({
          type: "turn_end",
          status: "failed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      if (oscillating && !oscillationFired) {
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
          if (r.instructionClaims?.length) {
            this.cfg.repositoryInstructions?.claim(r.instructionClaims);
          }
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
        if (!this.liveSignal().aborted && !(await this.closeTurnAtBoundary())) {
          iter--;
          continue;
        }
        yield this.terminalTurnEvent({
          type: "turn_end",
          status: "completed",
          workStatus: resolvedWorkStatus(),
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      // Loop continues: provider will see the new tool_result message.
      void stopReason; // tracked for telemetry; not used to break the loop
    }

    // Exceeded maxTurns
    this.markTurnTerminal();
    yield {
      type: "error",
      error: { code: "max_turns_exceeded", message: `exceeded ${maxIters} turn iterations`, retriable: false },
    };
    yield this.terminalTurnEvent({
      type: "turn_end",
      status: "failed",
      workStatus: resolvedWorkStatus(),
      usage: totalUsage,
      durationMs: Date.now() - startedAt,
    });
  }

  private async *runToolBatch(
    uses: readonly ResolvedToolUse[],
    effectEpoch: number,
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
          if (this.steeringWakeEpoch !== effectEpoch) {
            outcomes[index] = this.steeringSkippedToolOutcome(use, (event) => queue.push(event));
          } else {
            outcomes[index] = await this.executeToolUse(use, (event) => queue.push(event), effectEpoch);
          }
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

  private steeringSkippedToolOutcome(
    use: ResolvedToolUse,
    emit: (event: TurnEvent) => void,
    durationMs = 0,
    options: { message?: string; potentialMutation?: boolean } = {},
  ): ToolExecutionOutcome {
    const message = options.message ?? `tool call '${use.name}' skipped because the user steered before execution`;
    emit({ type: "tool_error", id: use.id, error: message, durationMs });
    return {
      toolUseId: use.id,
      skippedBySteering: true,
      potentialMutation: options.potentialMutation,
      finishedAt: Date.now(),
      result: {
        type: "tool_result",
        tool_use_id: use.id,
        content: message,
        is_error: true,
      },
    };
  }

  /**
   * PostToolUse hooks are executable host code, not harmless notifications.
   * Admit, checkpoint, execute, and settle each one as its own synthetic tool
   * run before the primary tool's terminal result becomes visible. A hook that
   * cannot be durably admitted is not executed. A non-zero exit is reported to
   * the model, but does not pretend the already-completed primary effect rolled
   * back or invite the model to repeat it.
   */
  private async settlePostToolHooks(
    use: ResolvedToolUse,
    primaryOutput: unknown,
    emit: (event: TurnEvent) => void,
  ): Promise<PostToolHookSettlement> {
    const manager = this.cfg.hookManager;
    if (!manager) return EMPTY_POST_TOOL_HOOK_SETTLEMENT;
    const hookInput = {
      event: "PostToolUse" as const,
      toolName: use.name,
      input: use.input,
      output: primaryOutput,
      workspace: this.cfg.workspace,
    };
    const invocations = manager.matching(hookInput);
    if (invocations.length === 0) return EMPTY_POST_TOOL_HOOK_SETTLEMENT;
    if (!this.cfg.beforeToolExecution || !this.cfg.afterToolExecution) {
      return {
        failures: invocations.map((invocation) =>
          `PostToolUse hook ${invocation.id} was not executed because this QueryEngine has no durable tool admission/settlement host.`
        ),
        touchedFiles: [],
      };
    }

    const failures: string[] = [];
    const touchedFiles = new Set<string>();
    for (const invocation of invocations) {
      const hookUseId = postToolHookUseId(this.sessionId, use.id, invocation);
      let checkpointId: string | undefined;
      if (this.cfg.beforeToolUseCheckpoint) {
        try {
          const checkpoint = await this.cfg.beforeToolUseCheckpoint({
            toolUseId: hookUseId,
            toolName: "PostToolUseHook",
            input: postToolHookArguments(use, invocation),
            safety: "external-state",
            // Hooks are arbitrary shell commands. Never narrow their snapshot
            // to the primary tool's declared target.
          });
          checkpointId = checkpoint?.checkpointId;
        } catch (error) {
          emit({
            type: "system_reminder_injected",
            text: `PostToolUse hook checkpoint failed (${errorMessage(error)}); the hook remains durable but workspace diff coverage may be incomplete.`,
            source: "hook",
          });
        }
      }

      const argumentsValue = postToolHookArguments(use, invocation);
      try {
        await this.cfg.beforeToolExecution?.({
          toolUseId: hookUseId,
          toolName: "PostToolUseHook",
          input: argumentsValue,
          safety: "external-state",
          checkpointId,
          mutationTransactionId: workspaceMutationTransactionId(this.sessionId, hookUseId),
        });
      } catch (error) {
        // Admission failed before host code was entered. The hook is skipped;
        // preserving primary progress is truthful and safer than executing an
        // unledgered command.
        failures.push(
          `PostToolUse hook ${invocation.id} was not executed because durable admission failed: ${errorMessage(error)}`,
        );
        continue;
      }

      let hookResult: Awaited<ReturnType<HookManager["runInvocation"]>>;
      try {
        hookResult = await manager.runInvocation(invocation, hookInput);
      } catch (error) {
        const message = `PostToolUse hook ${invocation.id} failed during execution/settlement: ${errorMessage(error)}`;
        // An exception escaped the command runner after durable admission. We
        // cannot prove whether host code entered, so ambiguity is terminal.
        await this.cfg.afterToolExecution?.({
          toolUseId: hookUseId,
          toolName: "PostToolUseHook",
          input: argumentsValue,
          safety: "external-state",
          status: "effect_unknown",
          error: `${message}\n\nThe hook may already have taken effect. Do not rerun the primary tool or hook blindly.`,
        });
        failures.push(message);
        continue;
      }

      const failed = hookResult.exitCode !== 0;
      const error = hookResult.reminders[0];
      // Keep this settlement outside the command-runner catch. If the durable
      // barrier itself fails, the primary terminal result must not be exposed;
      // recovery will see executing/effect_unknown rather than a second settle.
      const receipt = await this.cfg.afterToolExecution?.({
        toolUseId: hookUseId,
        toolName: "PostToolUseHook",
        input: argumentsValue,
        safety: "external-state",
        status: failed ? "failed" : "succeeded",
        output: {
          hookId: invocation.id,
          primaryToolUseId: use.id,
          entered: hookResult.entered,
          exitCode: hookResult.exitCode,
          output: hookResult.output,
        },
        ...(error ? { error } : {}),
      });
      for (const file of receipt?.touchedFiles ?? []) touchedFiles.add(file);
      if (error) failures.push(error);
    }
    return { failures, touchedFiles: [...touchedFiles] };
  }

  private async executeToolUse(
    use: ResolvedToolUse,
    emit: (event: TurnEvent) => void,
    effectEpoch: number,
  ): Promise<ToolExecutionOutcome> {
    const t0 = Date.now();
    let checkpointId: string | undefined;
    if (shouldCheckpointBeforeTool(use.safety) && this.cfg.beforeToolUseCheckpoint) {
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
          safety: use.safety,
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
        checkpointId = checkpoint.checkpointId;
        emit({
          type: "checkpoint_created",
          checkpointId: checkpoint.checkpointId,
          label: checkpoint.label,
          toolUseId: use.id,
          reason: "pre_tool",
        });
      }
    }

    // The call was dequeued before its checkpoint await. If steering advanced
    // while that non-effectful preparation ran, skip before durable admission.
    if (this.steeringWakeEpoch !== effectEpoch) {
      return this.steeringSkippedToolOutcome(use, emit, Date.now() - t0);
    }

    let executionAdmitted = false;
    let executionSettled = false;
    let executionSettlementAttempted = false;
    let toolImplementationEntered = false;
    let toolImplementationCompleted = false;
    let preHookMayHaveEffects = false;
    let postHooksAttempted = false;
    const runPostHooksOnce = async (output: unknown): Promise<PostToolHookSettlement> => {
      if (postHooksAttempted) {
        throw new Error(`PostToolUse hooks for ${use.id} were already attempted; refusing duplicate execution`);
      }
      postHooksAttempted = true;
      return this.settlePostToolHooks(use, output, emit);
    };
    try {
      // Holds the live watchdog control for THIS call so the permission prompt
      // can pause the clock (set below once withWatchdog invokes run()).
      let watchdog: WatchdogControl = NOOP_WATCHDOG;
      const ctx: ToolCallContext = {
        workspace: this.cfg.workspace,
        sessionId: this.sessionId,
        toolUseId: use.id,
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
                const wakeSignal = this.steeringWakeController.signal;
                if (this.steeringWakeEpoch !== effectEpoch) {
                  emit({ type: "permission_response", id, decision: "deny" });
                  throw new SteeringPermissionWakeError(use.name);
                }
                let onSteering: (() => void) | undefined;
                const steering = new Promise<{ kind: "steering" }>((resolve) => {
                  onSteering = () => resolve({ kind: "steering" });
                  if (wakeSignal.aborted) onSteering();
                  else wakeSignal.addEventListener("abort", onSteering, { once: true });
                });
                const inheritedSignals = [wakeSignal, this.liveSignal()];
                if (request.signal) inheritedSignals.push(request.signal);
                const permissionSignal = AbortSignal.any(inheritedSignals);
                const decision = Promise.race([
                  this.cfg.requestPermission!({ ...requestWithId, signal: permissionSignal }),
                  new Promise<PermissionPromptDecision>((resolve) => {
                    ceiling = setTimeout(() => resolve("deny"), waitMs);
                    ceiling.unref?.();
                  }),
                ])
                  .then((value) => ({ kind: "decision" as const, value }))
                  .catch((error: unknown) => {
                    // Abort-aware hosts conventionally reject rather than
                    // resolve when their waiter is cancelled. Steering still
                    // owns this boundary; only unrelated host failures escape.
                    if (wakeSignal.aborted || this.steeringWakeEpoch !== effectEpoch) {
                      return { kind: "steering" as const };
                    }
                    throw error;
                  });
                const outcome = await Promise.race([decision, steering]).finally(() => {
                  clearTimeout(ceiling);
                  if (onSteering) wakeSignal.removeEventListener("abort", onSteering);
                });
                if (
                  outcome.kind === "steering" ||
                  wakeSignal.aborted ||
                  this.steeringWakeEpoch !== effectEpoch
                ) {
                  // This is not an owner denial and must not trip the
                  // permission-interrupt path. Wake the surface with a synthetic
                  // deny, then unwind as a steering-specific pre-effect skip.
                  emit({ type: "permission_response", id, decision: "deny" });
                  throw new SteeringPermissionWakeError(use.name);
                }
                emit({ type: "permission_response", id, decision: outcome.value });
                return outcome.value;
              } finally {
                watchdog.resume();
              }
            }
          : undefined,
        emitProgress: (data) => emit({ type: "tool_progress", id: use.id, data }),
        fileReadStamps: this.cfg.fileReadStamps,
        mutationTransactionId: workspaceMutationTransactionId(this.sessionId, use.id),
        repositoryInstructions: this.cfg.repositoryInstructions,
      };
      // This await is the side-effect write-ahead boundary. SessionKernel records
      // the call (and checkpoint identity) before an adapted/native/MCP tool can
      // enter its implementation. A database failure therefore fails closed.
      await this.cfg.beforeToolExecution?.({
        toolUseId: use.id,
        toolName: use.name,
        input: use.input,
        safety: use.safety,
        checkpointId,
        mutationTransactionId: workspaceMutationTransactionId(this.sessionId, use.id),
      });
      executionAdmitted = true;
      // Admission is not implementation entry. A steer can land while SQLite,
      // checkpoint, or write-ahead work is awaited; settle the admitted record
      // as a paired failure without invoking hooks or the tool implementation.
      if (this.steeringWakeEpoch !== effectEpoch) {
        const message = `tool call '${use.name}' skipped because the user steered before execution`;
        executionSettlementAttempted = true;
        await this.cfg.afterToolExecution?.({
          toolUseId: use.id,
          toolName: use.name,
          input: use.input,
          safety: use.safety,
          status: "failed",
          error: message,
        });
        executionSettled = true;
        return this.steeringSkippedToolOutcome(use, emit, Date.now() - t0);
      }
      // Hooks are executable host code and may themselves touch the workspace.
      // They therefore run *inside* the durable tool boundary and after the
      // pre-tool checkpoint. A blocking hook settles the canonical call as a
      // failure before any model-visible error is exposed.
      const preHook = this.cfg.hookManager
        ? await this.cfg.hookManager.run({
            event: "PreToolUse",
            toolName: use.name,
            input: use.input,
            workspace: this.cfg.workspace,
          })
        : null;
      preHookMayHaveEffects = (preHook?.executed ?? 0) > 0;
      if (preHook?.blocked) {
        const baseMessage = preHook.reminders[0] ?? `PreToolUse hook blocked ${use.name}`;
        const message = preHookMayHaveEffects
          ? `${baseMessage}\n\nA PreToolUse hook ran before blocking, so its effect status is unknown. Inspect and reconcile the workspace before retrying.`
          : baseMessage;
        executionSettlementAttempted = true;
        await this.cfg.afterToolExecution?.({
          toolUseId: use.id,
          toolName: use.name,
          input: use.input,
          safety: use.safety,
          status: preHookMayHaveEffects ? "effect_unknown" : "failed",
          error: message,
        });
        executionSettled = true;
        emit({ type: "tool_error", id: use.id, error: message, durationMs: Date.now() - t0 });
        return {
          toolUseId: use.id,
          interrupted: false,
          finishedAt: Date.now(),
          result: { type: "tool_result", tool_use_id: use.id, content: message, is_error: true },
        };
      }
      // A PreToolUse hook is host code and may take arbitrarily long. Steering
      // that arrives while it runs must still fence the stale PRIMARY call. The
      // hook itself has already settled and cannot be undone; when one matched,
      // preserve that uncertainty in the durable receipt instead of claiming
      // the entire call was side-effect-free.
      if (this.steeringWakeEpoch !== effectEpoch) {
        const skipped = `tool call '${use.name}' skipped because the user steered before execution`;
        const message = preHookMayHaveEffects
          ? `${skipped}\n\nA PreToolUse hook already ran, so the hook's effect status is unknown. The primary tool implementation did not run; inspect any hook effects before retrying.`
          : skipped;
        executionSettlementAttempted = true;
        await this.cfg.afterToolExecution?.({
          toolUseId: use.id,
          toolName: use.name,
          input: use.input,
          safety: use.safety,
          status: preHookMayHaveEffects ? "effect_unknown" : "failed",
          error: message,
        });
        executionSettled = true;
        emit({ type: "tool_error", id: use.id, error: message, durationMs: Date.now() - t0 });
        return {
          toolUseId: use.id,
          skippedBySteering: true,
          potentialMutation: preHookMayHaveEffects,
          finishedAt: Date.now(),
          result: {
            type: "tool_result",
            tool_use_id: use.id,
            content: message,
            is_error: true,
          },
        };
      }
      // Never expose tool_start until the host's write-ahead admission is
      // durable. Consumers can now treat tool_start as proof that a canonical
      // tool record exists, even though adapted-tool validation/permission may
      // still reject before the implementation gains effects.
      emit({
        type: "tool_start",
        id: use.id,
        name: use.name,
        input: use.input,
        providerHint: use.tool.schema.providerHint,
        activityDescription: describeActivity(use.name, use.input),
      });
      // Watchdog: bound this single tool call. The MERGED child signal replaces
      // ctx.signal so the tool's own fetch/child aborts on timeout — turning the
      // 5-minute hang into a fast, correctable is_error the model can adapt to.
      const result = await withWatchdog(
        watchdogTimeoutMsFor(use.tool.schema),
        this.liveSignal(),
        (signal, control) => {
          watchdog = control;
          toolImplementationEntered = true;
          return use.tool.call(use.input, { ...ctx, signal });
        },
      );
      toolImplementationCompleted = true;
      const durationMs = Date.now() - t0;
      const declaredFailure = typeof result.failure === "string" ? result.failure.trim() || undefined : undefined;
      const postHooks = await runPostHooksOnce(
        declaredFailure ? { error: declaredFailure, output: result.output } : result.output,
      );
      const touchedFiles = mergeTouchedFiles(result.touchedFiles, postHooks.touchedFiles);
      for (const failure of postHooks.failures) {
        emit({
          type: "system_reminder_injected",
          text: `${failure}\n\nThe primary ${use.name} call already completed. Address the hook failure or inspect its effects; do not repeat the primary call solely because this hook failed.`,
          source: "hook",
        });
      }
      const durableOutput = postHooks.failures.length > 0
        ? { toolOutput: result.output, postToolHookFailures: postHooks.failures }
        : result.output;
      executionSettlementAttempted = true;
      await this.cfg.afterToolExecution?.({
        toolUseId: use.id,
        toolName: use.name,
        input: use.input,
        safety: use.safety,
        status: declaredFailure ? "failed" : "succeeded",
        output: durableOutput,
        ...(declaredFailure ? { error: declaredFailure } : {}),
        touchedFiles,
      });
      executionSettled = true;
      if (declaredFailure) {
        emit({
          type: "tool_error",
          id: use.id,
          error: declaredFailure,
          output: result.output,
          touchedFiles,
          durationMs,
        });
      } else {
        emit({
          type: "tool_end",
          id: use.id,
          output: result.output,
          touchedFiles,
          durationMs,
          display: result.display,
        });
      }
      if (!declaredFailure && use.name === "TodoWrite" && isTodoOutput(result.output)) {
        this.latestTodos = result.output.todos;
        emit({ type: "todo_updated", todos: result.output.todos });
      }
      const modelText = await this.capToolResultText(result.output, use.id, use.tool.schema, (warning) =>
        emit({ type: "system_reminder_injected", text: `${use.name}: ${warning}`, source: "instructions" }),
      );
      const hookFailureText = postHooks.failures.length > 0
        ? `\n\n<PostToolUse hook failures>\n${postHooks.failures.join("\n\n")}\n</PostToolUse hook failures>\nThe primary tool call already completed; do not blindly replay it.`
        : "";
      const modelResultText = (declaredFailure ? `${declaredFailure}\n\n${modelText}` : modelText) + hookFailureText;
      const resultContent: ToolResultBlock["content"] =
        result.images && result.images.length > 0
          ? [
              { type: "text", text: modelResultText },
              ...result.images.map((img) => ({
                type: "image" as const,
                source: { kind: "base64" as const, mediaType: img.mediaType, data: img.data },
              })),
            ]
          : modelResultText;
      return {
        toolUseId: use.id,
        output: result.output,
        touchedFiles,
        finishedAt: Date.now(),
        verificationAttempted: isManualVerificationCall(use.name, use.input),
        verificationCommand: manualVerificationCommand(use.name, use.input) ?? undefined,
        verificationPassed: !declaredFailure && isSuccessfulVerificationCall(use.name, use.input, result.output),
        potentialMutation: isPotentialCodeMutationCall(use.name, use.input),
        result: {
          type: "tool_result",
          tool_use_id: use.id,
          content: resultContent,
          ...(declaredFailure ? { is_error: true } : {}),
        },
      };
    } catch (err) {
      if (err instanceof SteeringPermissionWakeError) {
        // The adapter entered only far enough to ask for authority; the actual
        // operation never received approval. Settle the durable primary record
        // as failed (or effect_unknown when a pre-hook ran), do not run
        // PostToolUse hooks, and keep the owner generation alive so its newly
        // installed correction receives the next response.
        const message = preHookMayHaveEffects
          ? `${err.message}\n\nA PreToolUse hook already ran, so the hook's effect status is unknown. The permission-gated primary effect did not run; inspect any hook effects before retrying.`
          : err.message;
        if (executionAdmitted && !executionSettled) {
          executionSettlementAttempted = true;
          await this.cfg.afterToolExecution?.({
            toolUseId: use.id,
            toolName: use.name,
            input: use.input,
            safety: use.safety,
            status: preHookMayHaveEffects ? "effect_unknown" : "failed",
            error: message,
          });
          executionSettled = true;
        }
        return this.steeringSkippedToolOutcome(use, emit, Date.now() - t0, {
          message,
          potentialMutation: preHookMayHaveEffects,
        });
      }
      // A failed durable settlement barrier is not an ordinary tool failure.
      // Retrying that barrier here can conflict with a commit whose response
      // was lost. Leave the generation for canonical recovery instead.
      if (executionSettlementAttempted && !executionSettled) throw err;
      const durationMs = Date.now() - t0;
      // A watchdog abort gets an actionable message so the model changes course
      // instead of re-trying the same hang. Stays is_error so the circuit-breaker
      // accounting (failStreak) still counts it as a failure signal.
      const baseMessage =
        err instanceof ToolWatchdogError
          ? use.safety === "external-state"
            ? // An aborted fetch only stops the CLIENT — a POST that reached the
              // server may have COMMITTED. Never invite a blind retry (double
              // charge / double send); tell the model to verify first.
              `Tool ${use.name} exceeded its ${err.toolMs}ms watchdog and was aborted — but it MAY have already taken effect on the remote service. Do NOT blindly retry; verify the outcome first, then decide.`
            : `Tool ${use.name} exceeded its ${err.toolMs}ms watchdog and was aborted — result unavailable. Try a narrower input, a different approach, or proceed without it.`
          : err instanceof Error
            ? err.message
            : String(err);
      const effectUnknown =
        executionAdmitted &&
        !executionSettled &&
        (preHookMayHaveEffects ||
          (use.safety !== "read-only" &&
            !isPreEffectToolError(err) &&
            (toolImplementationEntered || toolImplementationCompleted || err instanceof ToolWatchdogError || this.liveSignal().aborted)));
      const message = effectUnknown
        ? `${baseMessage}\n\nThe tool's effect status is unknown. Inspect and reconcile the target state before retrying; do not repeat this call blindly.`
        : baseMessage;
      const postHooks = executionAdmitted && !postHooksAttempted
        ? await runPostHooksOnce({ error: message })
        : EMPTY_POST_TOOL_HOOK_SETTLEMENT;
      const touchedFiles = mergeTouchedFiles(undefined, postHooks.touchedFiles);
      const hookFailureText = postHooks.failures.length > 0
        ? `\n\n<PostToolUse hook failures>\n${postHooks.failures.join("\n\n")}\n</PostToolUse hook failures>\nThe primary call was already attempted; do not replay it solely because a hook failed.`
        : "";
      for (const failure of postHooks.failures) {
        emit({
          type: "system_reminder_injected",
          text: `${failure}\n\nDo not blindly replay ${use.name}; inspect the primary and hook effects independently.`,
          source: "hook",
        });
      }
      if (executionAdmitted && !executionSettled) {
        executionSettlementAttempted = true;
        await this.cfg.afterToolExecution?.({
          toolUseId: use.id,
          toolName: use.name,
          input: use.input,
          safety: use.safety,
          status: effectUnknown ? "effect_unknown" : "failed",
          error: message + hookFailureText,
          ...(postHooks.failures.length > 0
            ? { output: { postToolHookFailures: postHooks.failures } }
            : {}),
          touchedFiles,
        });
        executionSettled = true;
      }
      emit({ type: "tool_error", id: use.id, error: message + hookFailureText, touchedFiles, durationMs });
      return {
        toolUseId: use.id,
        touchedFiles,
        interrupted: this.cfg.permissionDenialInterrupts !== false && isPermissionDeniedError(err),
        finishedAt: Date.now(),
        verificationAttempted: isManualVerificationCall(use.name, use.input),
        verificationCommand: manualVerificationCommand(use.name, use.input) ?? undefined,
        result: {
          type: "tool_result",
          tool_use_id: use.id,
          content: message + hookFailureText,
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
  safety: SafetyClass;
}

function isPreEffectToolError(error: unknown): boolean {
  return !!error &&
    typeof error === "object" &&
    (error as { aresToolEffectPhase?: unknown }).aresToolEffectPhase === "pre-effect";
}

/** Stable across crash replay of the same provider tool-use identity. */
export function workspaceMutationTransactionId(sessionId: string, toolUseId: string): string {
  return `tool_${createHash("sha256").update(`${sessionId}\0${toolUseId}`).digest("hex").slice(0, 48)}`;
}

interface ToolExecutionOutcome {
  toolUseId: string;
  result: ToolResultBlock;
  /** The assistant proposal was canonical, but steering advanced before its
   * primary effect gained authority. Its paired error is authoritative; a
   * permission adapter or already-settled pre-hook may have run, with any hook
   * uncertainty carried separately as potentialMutation/effect_unknown. */
  skippedBySteering?: boolean;
  /** Structured output retained for this loop so generic provider receipts can
   * drive proof routing without reparsing capped model-facing text. */
  output?: unknown;
  interrupted?: boolean;
  touchedFiles?: string[];
  finishedAt?: number;
  verificationAttempted?: boolean;
  verificationCommand?: string;
  verificationPassed?: boolean;
  potentialMutation?: boolean;
}

interface PostToolHookSettlement {
  failures: string[];
  touchedFiles: string[];
}

const EMPTY_POST_TOOL_HOOK_SETTLEMENT: PostToolHookSettlement = Object.freeze({
  failures: [],
  touchedFiles: [],
});

function postToolHookUseId(sessionId: string, primaryToolUseId: string, hook: HookInvocation): string {
  return `posthook_${createHash("sha256")
    .update(`${sessionId}\0${primaryToolUseId}\0${hook.id}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function postToolHookArguments(use: ResolvedToolUse, hook: HookInvocation): Record<string, unknown> {
  return {
    event: "PostToolUse",
    hookId: hook.id,
    command: hook.command,
    matcher: hook.matcher ?? null,
    primaryToolUseId: use.id,
    primaryToolName: use.name,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeTouchedFiles(
  primary: readonly string[] | undefined,
  additional: readonly string[] | undefined,
): string[] | undefined {
  const merged = [...new Set([...(primary ?? []), ...(additional ?? [])])];
  return merged.length > 0 ? merged : undefined;
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
/** Internal control-flow marker: a durable correction woke a permission wait
 * before the owner granted authority, so no primary effect may begin. */
class SteeringPermissionWakeError extends Error {
  readonly aresToolEffectPhase = "pre-effect";

  constructor(toolName: string) {
    super(`tool call '${toolName}' skipped because the user steered before execution`);
    this.name = "SteeringPermissionWakeError";
  }
}

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
  "KillTask",
  "ApplyIntent",
  "FindAndEdit",
  "Memory",
  "EnterPlanMode",
  "UpdatePlanDraft",
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
  // Runtime-resolved calls carry the per-input safety classification, but
  // callers that construct a ResolvedToolUse directly (and older persisted
  // call shapes) only have the schema declaration. Never let a missing
  // override silently turn a workspace writer into a read-only dependency.
  const safety = use.safety ?? use.tool.schema.safety;
  const taskType = String(((use.input ?? {}) as Record<string, unknown>).subagent_type ?? "");
  // Unknown/custom personas are writers until proven otherwise. The previous
  // `!== general-purpose` shortcut classified every roster persona (including
  // full-belt forge agents) read-only and ran overlapping writers concurrently.
  const readOnlyTask = name === "Task" && new Set([
    "explorer",
    "researcher",
    "code-reviewer",
    "verifier",
  ]).has(taskType);
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

  // Weak/loosely-trained models sometimes emit a structured argument as a
  // JSON-ENCODED STRING ("todos": "[{...}]") instead of the actual array or
  // object — observed live: glm-5.2 failed TodoWrite twice this way. Coerce
  // any string value that parses to an array/object back to the real value
  // for parameters that are structurally ALWAYS non-scalar. Never applied to
  // free-text params (Write.content may legitimately start with "[").
  const parseStructured = (key: string) => {
    const v = next[key];
    if (typeof v !== "string") return;
    const s = v.trim();
    if (!(s.startsWith("[") || s.startsWith("{"))) return;
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === "object") next[key] = parsed;
    } catch {
      // leave as-is; schema validation reports the real error
    }
  };
  for (const key of ["todos", "edits", "target_paths"]) {
    if (key in next) parseStructured(key);
  }

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
      copy("target_paths", "targets", "paths");
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

function shouldCheckpointBeforeTool(safety: SafetyClass): boolean {
  return safety === "workspace-write" || safety === "destructive";
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

/**
 * CAPACITY pressure (Anthropic 529 `overloaded_error`, "server is busy",
 * upstream capacity refusals) is a queue depth problem, not a broken request:
 * the identical call usually succeeds a little later. The generic transient
 * budget (4 tries inside ~12s) was far too impatient for it — a real report
 * showed five straight Overloadeds in 20s and the turn died with ZERO model
 * calls, losing the user's message. These get their own, much more patient
 * ladder, and the daemon only fails over to another provider after it.
 */
function isCapacityError(error: { code: string; message: string }): boolean {
  const text = `${error.code} ${error.message}`.toLowerCase();
  return (
    text.includes("overloaded") ||
    text.includes("capacity") ||
    text.includes("http_529") ||
    /\b529\b/.test(text) ||
    text.includes("server is busy") ||
    text.includes("temporarily unavailable") ||
    text.includes("service unavailable") ||
    text.includes("http_503")
  );
}

/** Retries reserved for capacity pressure. Override with ARES_CAPACITY_RETRIES. */
const MAX_CAPACITY_RETRIES = (() => {
  const raw = Number(process.env.ARES_CAPACITY_RETRIES);
  return Number.isFinite(raw) && raw >= 0 && raw <= 20 ? Math.floor(raw) : 8;
})();

/** Patient backoff for capacity: ~1.5s, 3s, 6s, 12s, 20s, 20s… (cap 20s).
 *  Eight attempts ride out roughly 95s of provider congestion. The base and cap
 *  are tunable (ARES_CAPACITY_BACKOFF_MS / _MAX_MS) — useful on a chronically
 *  congested endpoint, and it lets the regression test exercise the real ladder
 *  without sleeping for 90 seconds. */
function capacityBackoffMs(attempt: number): number {
  const rawBase = Number(process.env.ARES_CAPACITY_BACKOFF_MS);
  const rawCap = Number(process.env.ARES_CAPACITY_BACKOFF_MAX_MS);
  const baseMs = Number.isFinite(rawBase) && rawBase >= 1 ? rawBase : 1_500;
  const capMs = Number.isFinite(rawCap) && rawCap >= 1 ? rawCap : 20_000;
  const base = baseMs * Math.pow(2, attempt - 1);
  const jitter = (attempt * 211) % Math.max(1, Math.round(baseMs * 0.4)); // deterministic; no Math.random in core
  return Math.min(capMs, base + jitter);
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
  /** Abort-like wake-up owned by the caller, distinct from the stall timer.
   * The guard races it against `iterator.next()` so even a provider that ignores
   * its request signal cannot hold the turn hostage after Stop or steering. */
  interruptSignal?: AbortSignal;
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
  let removeInterruptListener = (): void => {};
  const interrupted = opts.interruptSignal
    ? new Promise<"interrupt">((resolve) => {
        const signal = opts.interruptSignal!;
        const onAbort = () => resolve("interrupt");
        if (signal.aborted) {
          resolve("interrupt");
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        removeInterruptListener = () => signal.removeEventListener("abort", onAbort);
      })
    : null;
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
      const winner = await Promise.race([
        it.next(),
        timeout,
        ...(interrupted ? [interrupted] : []),
      ]).finally(() => clearTimeout(timer));
      if (winner === "interrupt") {
        // Do not await return(): a broken provider may also ignore iterator
        // closure. Its request signal is already aborted; the speculative
        // iterator is detached while QueryEngine advances to a safe boundary.
        try {
          const closing = it.return?.(undefined);
          if (closing) void closing.catch(() => undefined);
        } catch {
          // Provider cleanup is best-effort and has no conversation authority.
        }
        return;
      }
      if (winner === "stall") {
        const thinking = !committed && thinkingStartedAt > 0;
        opts.onStall();
        try {
          const closing = it.return?.(undefined);
          if (closing) void closing.catch(() => undefined);
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
      // Wire keepalive: the provider proved it's alive (SSE ping mid-prefill,
      // message_start before first token). Receiving it re-arms the deadline;
      // it is NOT output — the pre-output window stays in force between pings
      // — and it never reaches the consumer.
      if (ev.type === "stream_heartbeat") continue;
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
  } finally {
    removeInterruptListener();
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
  "TaskOutput",
  "KillTask",
  "TodoWrite",
  "Task",
  "Memory",
  "SelfEvolve",
  "SkillCraft",
  // Desktop control is real progress — a screenshot→click→verify GUI loop must
  // not be nagged to "stop gathering and deliver" mid-task.
  "ComputerUse",
]);

/** The anchored verification-command grammar shared by acceptance and family
 *  extraction. One alternation, one place to extend — the two regexes drifting
 *  apart is how a command could count as proof yet have no family (or vice
 *  versa). Covers the ecosystems real users ship in: JS/TS, Python, Rust, Go,
 *  .NET/C#, C/C++ (CMake/make/ctest), JVM (Gradle/Maven), Swift, Zig. */
const VERIFICATION_COMMAND_GRAMMAR =
  "node\\s+--test|" +
  "(?:pnpm|yarn)\\s+(?:test|check|lint|build|typecheck)|" +
  "npm\\s+(?:test|run\\s+(?:check|lint|build|typecheck))|" +
  "npx\\s+(?:tsc|eslint|vitest|jest)|" +
  "(?:vitest|jest|pytest|ruff|mypy|tsc|eslint)|" +
  "cargo\\s+(?:test|check|clippy|build)|" +
  "go\\s+(?:test|build|vet)|" +
  "dotnet\\s+(?:test|build)|" +
  "msbuild|" +
  "cmake\\s+--build|" +
  "ctest|" +
  "make|" +
  "(?:\\.[\\\\/])?gradlew?\\s+(?:test|build|check|assemble)|" +
  "mvn\\s+(?:test|verify|compile|package)|" +
  "python3?\\s+-m\\s+(?:pytest|unittest|compileall|py_compile)|" +
  "swift\\s+(?:build|test)|" +
  "zig\\s+build";

const VERIFICATION_ACCEPT_RE = new RegExp(`^(?:${VERIFICATION_COMMAND_GRAMMAR})(?:\\s+[^\\r\\n]*)?$`, "i");
const VERIFICATION_FAMILY_RE = new RegExp(`^(${VERIFICATION_COMMAND_GRAMMAR})\\b`, "i");

/** Unreal (and friends) build via an invoked script: PowerShell's call operator
 *  on a quoted path. `& "C:\...\Build.bat" Target Win64 Development` is ONE
 *  command, not a chain — normalize it to its script basename so the grammar
 *  and the chain filter below can treat it like any other verification tool. */
const CALL_OPERATOR_SCRIPT_RE = /^&\s+(['"])([^'"]+\.(?:bat|cmd|ps1|sh))\1(\s+[^\r\n]*)?$/i;
const VERIFICATION_SCRIPT_BASENAMES = /^(?:build|rebuild|runuat|rununrealbuildtool|buildgraph|verify|check|test|run-?tests?)\b/i;

function manualVerificationCommand(name: string, input: unknown): string | null {
  if (name !== "Bash" && name !== "PowerShell") return null;
  const request = (input ?? {}) as Record<string, unknown>;
  if (request.run_in_background === true) return null;
  let command = String(request.command ?? "").trim().replace(/\s+/g, " ");
  // A call-operator script invocation (Unreal's Build.bat / RunUAT.bat, a repo
  // verify.ps1) is proof-shaped when the script NAME says so. Normalized to
  // `script:<basename>` before the chain filter, which would otherwise read
  // the call operator itself as a chain.
  const script = command.match(CALL_OPERATOR_SCRIPT_RE);
  if (script) {
    const basename = script[2].split(/[\\/]/).at(-1) ?? "";
    if (!VERIFICATION_SCRIPT_BASENAMES.test(basename)) return null;
    const tail = (script[3] ?? "").trim();
    if (/[;&|><`]|\$\(/.test(tail)) return null;
    return `script:${basename.toLowerCase()}${tail ? ` ${tail.toLowerCase()}` : ""}`;
  }
  // Manual proof is a fallback only when no structured host verifier exists.
  // Accept one anchored check command, never a substring or shell chain: this
  // rejects `echo test`, `pnpm test; exit 0`, pipelines, and verify-then-mutate.
  if (/[;&|><`]|\$\(/.test(command)) return null;
  if (/(?:^|\s)(?:--collect-only|--co|--no-run|--listtests|--list-tests|--dry-run|--help|--version|--showconfig|--show-config|--print-config|--passwithnotests|--allow-no-tests)(?:\s|$)/i.test(command)) return null;
  if (/^(?:npx\s+)?(?:tsc|eslint|vitest|jest)\s+-(?:v|h)$/i.test(command)) return null;
  // `make clean` / `make install` mutate, they don't verify. Everything else
  // that reaches the grammar as `make [target]` is a build.
  if (/^make\s+(?:clean|distclean|install|uninstall)\b/i.test(command)) return null;
  if (!VERIFICATION_ACCEPT_RE.test(command)) return null;
  return command.toLowerCase();
}

function isManualVerificationCall(name: string, input: unknown): boolean {
  return manualVerificationCommand(name, input) !== null;
}

/** Families that invoke the package's own full JS test suite. A bare run of
 *  one of these executes a superset of any scoped JS test-runner invocation,
 *  and it is exactly the proof the verification hint instructs the model to
 *  produce — so it must clear a scoped red run. */
const JS_SUITE_FAMILIES = new Set(["npm test", "pnpm test", "yarn test"]);
const JS_TEST_RUNNER_FAMILIES = new Set(["node --test", "vitest", "jest", "npx vitest", "npx jest", ...JS_SUITE_FAMILIES]);

/** Family with cross-spelling aliases collapsed (`python -m pytest` ≡ `pytest`)
 *  so equivalent full-suite invocations cover each other's failures. */
function normalizedVerificationFamily(command: string): string | null {
  const family = verificationCommandFamily(command);
  return family?.replace(/^python3?\s+-m\s+pytest$/, "pytest") ?? null;
}

function verificationCommandFamily(command: string): string | null {
  // Script-invoked proof (Unreal Build.bat and friends): the family is the
  // script itself — a green `script:build.bat` covers a red `script:build.bat`.
  const script = command.match(/^(script:[^\s]+)/i);
  if (script) return script[1].toLowerCase();
  const match = command.match(VERIFICATION_FAMILY_RE);
  return match?.[1].toLowerCase().replace(/\s+/g, " ") ?? null;
}

function verificationCommandCovers(passingCommand: string, failedCommand: string): boolean {
  if (passingCommand === failedCommand) return true;
  // Only a BARE family invocation (the whole suite, not a re-scoped subset)
  // can cover a different failed command.
  if (passingCommand !== verificationCommandFamily(passingCommand)) return false;
  const passingFamily = normalizedVerificationFamily(passingCommand);
  const failedFamily = normalizedVerificationFamily(failedCommand);
  if (passingFamily === null) return false;
  if (passingFamily === failedFamily) return true;
  // The package suite runs every test the scoped runner ran — and it is the
  // exact proof deriveVerificationHint tells the model this gate accepts.
  // Without this, a red `node --test tests/x.test.mjs` followed by a green
  // `npm test` left the failure flag set FOREVER, vetoing even the host
  // verifier's green behavioral run (the coding-v2 atomic-state 20-turn burn).
  return JS_SUITE_FAMILIES.has(passingFamily) && failedFamily !== null && JS_TEST_RUNNER_FAMILIES.has(failedFamily);
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

/** Signals supplied by an engine-neutral Capability provider invocation. File
 * and command matching for direct Edit/shell calls belongs to the host's live
 * manifest registry (`environmentArtifactSignals`), not a baked-in list of
 * specific editors or engines in core. */
function guiArtifactSignals(
  toolName: string,
  _input: unknown,
  _touchedFiles?: readonly string[],
  output?: unknown,
): string[] {
  if (toolName !== "Capability" || !output || typeof output !== "object" || Array.isArray(output)) return [];
  const result = output as Record<string, unknown>;
  const provider = result.provider && typeof result.provider === "object" && !Array.isArray(result.provider)
    ? result.provider as Record<string, unknown>
    : null;
  if (provider?.kind !== "environment-provider") return [];
  const operation = typeof result.operation === "string" ? result.operation : "unknown";
  const operations = provider.operations && typeof provider.operations === "object" && !Array.isArray(provider.operations)
    ? provider.operations as Record<string, unknown>
    : {};
  const operationSpec = operations[operation] && typeof operations[operation] === "object" && !Array.isArray(operations[operation])
    ? operations[operation] as Record<string, unknown>
    : null;
  return operationSpec?.effect !== "read-only"
    ? [`provider:${String(provider.id ?? "environment")}:${operation}`]
    : [];
}

/** True when this successful call captured REAL pixels of a running UI.
 *  ComputerUse screenshot/zoom always grabs the screen; Browser screenshot
 *  counts only when the result actually carries an image block (its embedded
 *  fallback returns a self-flagged text snapshot that proves nothing). */
function isVisualEvidenceCall(toolName: string, input: unknown, result: ToolResultBlock, output?: unknown): boolean {
  const action =
    input && typeof input === "object" ? String((input as Record<string, unknown>)["action"] ?? "") : "";
  if (toolName === "ComputerUse") return action === "screenshot" || action === "zoom";
  if (toolName === "Browser") {
    if (!/^(?:screenshot|filmstrip)$/.test(action)) return false;
    return Array.isArray(result.content) && result.content.some((b) => (b as { type?: string }).type === "image");
  }
  if (toolName === "Capability" && output && typeof output === "object" && !Array.isArray(output)) {
    const receipt = (output as Record<string, unknown>).receipt;
    const evidence = receipt && typeof receipt === "object" && !Array.isArray(receipt)
      ? (receipt as Record<string, unknown>).evidence
      : null;
    return Array.isArray(evidence) && evidence.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const evidenceItem = item as Record<string, unknown>;
      return /(?:screenshot|frame|image|pixel|render|viewport)/i.test(String(evidenceItem.kind ?? "")) &&
        typeof evidenceItem.observedAt === "string";
    });
  }
  return false;
}

/** Threshold for the identical-call (no-op loop) detector. */
function repeatCallLimit(): number {
  const raw = Number(process.env.ARES_REPEAT_CALL_LIMIT);
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : 3;
}

/** Consecutive rounds of a provably-stuck pattern (identical failure, or
 *  sustained A/B oscillation) after which the turn is TERMINATED as
 *  loop_detected. This is the real stopping rule now that iterations are
 *  effectively unbounded: interventions fire at 2× (recall) and 3× (breaker);
 *  a model still looping at this count has ignored both. */
function loopKillLimit(): number {
  const raw = Number(process.env.ARES_LOOP_KILL_LIMIT);
  return Number.isFinite(raw) && raw >= 4 ? Math.floor(raw) : 8;
}

/** Default per-turn iteration backstop when cfg.maxTurns is not set. Loop-kill
 *  detectors are the real terminators; this only stops a pathological run that
 *  somehow evades every detector. */
function defaultMaxIters(): number {
  const raw = Number(process.env.ARES_MAX_TURN_ITERS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10_000;
}

/** Absolute per-turn tool-call ceiling — a graceful backstop that ends the turn
 *  cleanly (status 'completed', partial work preserved) rather than the failed
 *  max_turns_exceeded path. Default high enough no legit build hits it. */
function toolCallCeiling(): number {
  const raw = Number(process.env.ARES_MAX_TURN_TOOL_CALLS);
  // No practical tool-call limit by default: loop-kill detectors terminate
  // stuck turns, so a productive build may issue as many calls as it needs.
  // The default only backstops a pathological run that evades every detector.
  return Number.isFinite(raw) && raw >= 10 ? Math.floor(raw) : 5000;
}

/** Minimum estimate-tokens of RECENT HISTORY every ladder rung must be able to
 *  hold beyond the fixed prompt overhead. A rung smaller than the overhead
 *  made budgetMessages strip everything but the pending message — the model,
 *  knowing nothing the user said two turns ago, replied "you didn't tell me to
 *  do that" (field report, 2026-08-05). */
const MIN_RECENT_HISTORY_TOKENS = 12_000;

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

/** A too-big REQUEST BODY (HTTP 413 / payload too large). Subset of
 *  isContextLimitError: it still walks the shrink ladder (smaller history +
 *  fewer images genuinely shrinks the body), but it is evidence about BYTES,
 *  not about the model's token window — one oversized pasted image must never
 *  teach learnedContextCeiling and permanently cripple the session's context
 *  (field report, 2026-08-05: hours-long sessions losing recent turns). */
function isPayloadSizeError(error: { code: string; message: string }): boolean {
  const text = `${error.code} ${error.message}`.toLowerCase();
  return (
    text.includes("http_413") ||
    text.includes("entity too large") ||
    text.includes("payload too large") ||
    text.includes("payload_too_large")
  );
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
    case "TaskOutput":
      return "Reading background task status";
    case "KillTask":
      return "Stopping a background task";
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
    case "UpdatePlanDraft":
      return "Saving the living plan draft";
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
