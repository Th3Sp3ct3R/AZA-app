// Extracted from entry.ts — turnPipeline.

import { repositoryMapReminder, runReliabilityTriage, sideQuery, sideQueryJson, writeCrashLogSync } from "@ares/core";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { PermissionMode } from "@ares/protocol";
import { messageText } from "@ares/protocol";
import { notice } from "../terminalUi.js";
import { cachedUiSettings } from "../uiSettings.js";
import { consciousnessContextReminder } from "../consciousnessContext.js";
import { deliberateForTurn, emitLifecycle, gainForTarget, lawsPromptBlock, unifiedRecallForTurn, runWitness } from "@ares/agent";
import { listCapabilities } from "@ares/operator";
import { buildForegroundReminder, classifyUserIntent, MemoryRouter, MemoryStore, withConsolidationLock } from "@ares/mind";
import { SessionManager, GarrisonServer } from "@ares/garrison";
import { CliRuntimeContext, cliRuntimeContext, compactLine } from "./runtime.js";
import { LiveSession } from "./sessionFactory.js";
import { mnemosyneRecaller } from "./mnemosyneRuntime.js";
import { machineCardPromptBlock } from "@ares/tools";
import { composeSystemPrompt, type PersonaConfig, type ProviderFamily } from "./prompt/index.js";

// ─── live Mind bridge (v6) — wires Living Memory + learned capabilities into
// the ACTUAL conversation, so Ares recalls, captures, and knows itself instead
// of behaving like a fresh chatbot every turn. Read-only/best-effort: the Mind
// must never break a turn.
const LIVE_MEMORY_ITEM_CHARS = 420;

let reliabilityMaintenance: Promise<void> | null = null;
let lastReliabilityMaintenanceErrorAt = 0;

/** Outcome of the most recent triage run in this process. */
export interface TriageLivenessRecord {
  at: number;
  files: number;
  observations: number;
  candidates: number;
  /**
   * Why the run did no work, when it deliberately did none.
   *
   * Load-bearing: triage returns an EMPTY run (files: 0) when it is throttled by
   * cadence, disabled, lock-contended, or under test. Without this field a
   * deliberate skip is indistinguishable from the v0.29 blindness bug, and the
   * cockpit reports a healthy throttle as "dead".
   */
  skipped?: "disabled" | "test" | "cadence" | "locked";
}

// The result used to be discarded (`.then(() => undefined)`), which is exactly
// how triage sat DEAD for three releases: it ran, read zero rollout files
// because of a realpath guard, reported coverage.files === 0, and nobody ever
// saw the number. Keeping the last run lets the cockpit show a zero as a zero.
let lastTriage: TriageLivenessRecord | null = null;

export function lastTriageRun(): TriageLivenessRecord | null {
  return lastTriage;
}

function scheduleReliabilityMaintenance(live: LiveSession): void {
  if (reliabilityMaintenance) return;
  setImmediate(() => {
    if (reliabilityMaintenance) return;
    reliabilityMaintenance = runReliabilityTriage({
      home: live.context.aresHome,
      workspace: live.context.workspace,
    }).then((run) => {
      lastTriage = {
        at: Date.now(),
        files: run?.coverage?.files ?? 0,
        observations: run?.coverage?.observations ?? 0,
        candidates: run?.newCandidates?.length ?? 0,
        skipped: run?.skipped,
      };
    }).catch((error: unknown) => {
      const now = Date.now();
      if (now - lastReliabilityMaintenanceErrorAt < 60 * 60_000) return;
      lastReliabilityMaintenanceErrorAt = now;
      writeCrashLogSync(live.context.aresHome, {
        at: new Date(now).toISOString(),
        kind: "manual",
        process: "reliability-triage",
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        process.stderr.write("[triage] maintenance failed; run `ares triage scan` for details.\n");
      } catch { /* diagnostics stay best-effort */ }
    }).finally(() => {
      reliabilityMaintenance = null;
    });
  });
}

const LIVE_MEMORY_BLOCK_CHARS = 2_400;

// Hard token budget for the injected memory block. The tiered context compiler
// packs recalled fragments under this ceiling (procedural > semantic) so a big
// recall never quietly eats the model's window. Override with ARES_MEMORY_TOKEN_BUDGET.
const LIVE_MEMORY_TOKEN_BUDGET = (() => {
  const raw = Number(process.env.ARES_MEMORY_TOKEN_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 700;
})();

/**
 * Inject the repo's current git state into the session prompt — branch, short
 * status, and the last few commits — so the model stops spending its first
 * tool calls rediscovering the project every session (the way Claude Code does).
 * Best-effort and cheap; silent when the cwd isn't a git repo.
 */
function gitRun(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let settled = false;
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      // A killed child's partial stdout is indistinguishable from a clean
      // result — resolve empty so callers treat a timeout as "no data".
      settle("");
    }, 3000);
    // Never let the kill timer keep the process alive past a fast git exit.
    (timer as { unref?: () => void }).unref?.();
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => settle(""));
    child.on("close", () => settle(out.trim()));
  });
}

/** Facts about the current HEAD commit for the after-action reflection trigger. */
export async function gatherGitRunFacts(workspace: string): Promise<{ sha: string; subject: string; changedFiles: string[] } | null> {
  const sha = await gitRun(workspace, ["rev-parse", "HEAD"]);
  if (!sha) return null; // not a git repo / no commits
  const subject = await gitRun(workspace, ["log", "-1", "--format=%s"]);
  const filesRaw = await gitRun(workspace, ["show", "--name-only", "--format=", "HEAD"]);
  const changedFiles = filesRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
  return { sha, subject, changedFiles };
}

export async function loadGitContext(context: CliRuntimeContext): Promise<string> {
  const cwd = context.workspace;
  const run = (args: string[]): Promise<string> => gitRun(cwd, args);
  try {
    const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch) return ""; // not a git repo
    const [status, log] = await Promise.all([
      run(["status", "-s", "--untracked-files=no"]),
      run(["log", "-5", "--oneline", "--no-decorate"]),
    ]);
    const lines = ["", "## Git", `- Branch: ${branch}`];
    if (status) {
      const trimmed = status.split("\n").slice(0, 30).join("\n");
      lines.push("- Uncommitted changes (tracked):", "```", trimmed, "```");
    } else {
      lines.push("- Working tree clean (tracked files)");
    }
    if (log) lines.push("- Recent commits:", "```", log, "```");
    return lines.join("\n") + "\n";
  } catch {
    return "";
  }
}

export async function loadLiveMindContext(context: CliRuntimeContext): Promise<string> {
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    const caps = await listCapabilities(context.home);
    const learned = caps.filter((c) => c.status === "mastered" || c.status === "have");
    const known = store
      .all()
      .filter((n) => n.kind === "semantic" && !/^Recurring theme "/.test(n.content))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 8);
    if (learned.length === 0 && known.length === 0) return "";
    const lines: string[] = [
      "",
      "# Your living memory & learned capabilities",
      "This is continuous you — not a fresh assistant booting from zero. The items below are things you actually know and can do, accumulated over time. Draw on them naturally; never announce that you're 'checking memory'.",
    ];
    if (known.length) {
      lines.push("", "What you know:");
      for (const n of known) lines.push(`- ${compactLine(n.content, LIVE_MEMORY_ITEM_CHARS)}`);
    }
    if (learned.length) {
      lines.push("", "Capabilities you can rely on:");
      for (const c of learned) lines.push(`- ${c.name}${c.skillRef ? ` (skill: ${c.skillRef})` : ""}`);
    }
    return lines.join("\n") + "\n";
  } catch {
    return "";
  }
}

/**
 * Host side of engine failure-signature recall: when a tool has failed the same
 * way twice, look in living memory for a remembered fix for that error and hand
 * it back as a short hint. Best-effort and read-only — a lookup never reinforces
 * or mutates memory, and never throws into the turn. Only distilled knowledge
 * (procedural/insight/semantic) counts as a "fix"; raw episodic replay is ignored.
 */
export async function recallFailureFixFromMemory(
  memoryFile: string | undefined,
  input: { tool: string; signature: string; error: string },
): Promise<string | null> {
  if (!memoryFile) return null;
  try {
    const store = await MemoryStore.open(memoryFile);
    // Cue on the error text (the durable part), not the volatile tool id.
    const cue = `${input.tool} ${input.error}`.slice(0, 300).trim();
    if (!cue) return null;
    const peek = (store as { peek?: (c: string, o?: { limit?: number }) => unknown }).peek;
    const entries = typeof peek === "function"
      ? await Promise.resolve(peek.call(store, cue, { limit: 3 }))
      : await store.remember(cue, { limit: 3 });
    const list = Array.isArray(entries) ? entries : [];
    const FIX_KINDS = new Set(["procedural", "insight", "semantic", "belief"]);
    for (const r of list as Array<{ node?: { content?: string; kind?: string } }>) {
      const kind = r.node?.kind;
      const content = r.node?.content?.trim();
      if (content && (!kind || FIX_KINDS.has(kind))) return content.slice(0, 300);
    }
    return null;
  } catch {
    return null; // memory must never break a turn
  }
}

/** Remove inline image bytes from semantic/lifecycle channels. The exact image
 * blocks still travel through Session content; memory, routing telemetry, and
 * the coding journal need only a stable attachment marker. Mirroring megabytes
 * of base64 through lifecycle IPC was enough to stall Desktop during image
 * steering. */
export function semanticUserMessage(userMessage: string): string {
  return userMessage
    .replace(/data:image\/[a-z0-9.+-]+[^,\r\n]*;base64,[^\s]+/gi, "[attached image]")
    .trim();
}

export async function prepareUserTurn(live: LiveSession, userMessage: string): Promise<void> {
  const semanticMessage = semanticUserMessage(userMessage);
  await live.agentRuntime?.beforeTurn(semanticMessage);
  await mindBeforeTurn(live, semanticMessage);
  const codingState = live.codingJournal.beginTurn(semanticMessage);
  if (codingState) {
    live.queueSystemReminder(codingState, "instructions");
    if (process.env.ARES_REPO_MAP !== "0") {
      live.repositoryMapCodingTurns = (live.repositoryMapCodingTurns ?? 0) + 1;
      const snapshot = live.codingJournal.snapshot();
      const priorTouchedCount = live.repositoryMapTouchedCount ?? 0;
      const newlyTouched = snapshot.touchedFiles.slice(priorTouchedCount);
      const boundaryChanged = newlyTouched.some((file) =>
        /(^|\/)(?:package\.json|pnpm-workspace\.yaml|tsconfig(?:\.[^.]+)?\.json|pyproject\.toml|cargo\.toml|go\.mod|agents\.md)$/i.test(file.replace(/\\/g, "/")),
      );
      const due = !live.repositoryMapText || boundaryChanged ||
        live.repositoryMapCodingTurns - (live.repositoryMapLastTurn ?? 0) >= 6;
      if (due) {
        const map = await repositoryMapReminder(live.context.workspace).catch(() => "");
        if (map) {
          live.repositoryMapText = map;
          live.repositoryMapLastTurn = live.repositoryMapCodingTurns;
          live.repositoryMapTouchedCount = snapshot.touchedFiles.length;
          live.queueSystemReminder(map, "instructions");
        }
      }
    }
    if (live.codingJournal.persistedVerificationDebtForCurrentTurn()) {
      const persistedFiles = live.codingJournal.snapshot().touchedFiles.map((file) =>
        path.isAbsolute(file) ? file : path.resolve(live.context.workspace, file),
      );
      if (persistedFiles.length) live.verifier.scheduleFor(persistedFiles);
    }
    // Unlike the session-creation prompt, this captures the CURRENT dirty tree
    // after prior edits or external changes in a long-running task.
    const git = await loadGitContext(live.context);
    if (git) live.queueSystemReminder(`CURRENT REPOSITORY DELTA${git}`, "instructions");
  }
  // Peripheral awareness: a bounded note of what the local watcher has recently
  // seen, injected only when something fresh is buffered (usually nothing). The
  // reminder is hard-capped in items + chars so it can't dominate the window.
  const awareness = consciousnessContextReminder();
  if (awareness) live.queueSystemReminder(awareness, "memory");
  live.queueSystemReminder(buildForegroundReminder(semanticMessage), "instructions");
}

async function mindBeforeTurn(live: LiveSession, userMessage: string): Promise<void> {
  const text = userMessage.trim();
  if (!text) return;
  try {
    const intent = classifyUserIntent(text);
    // Single canonical recall: v6 living memory (source of truth) merged with the
    // legacy v4 vector store, surfaced as ONE reminder. The turn never reads the
    // two substrates as separate stores again.
    //
    // When Mnemosyne is reachable (or this process can host it), living recall
    // goes through the single-writer server instead of opening memory.jsonl
    // here — reinforcement is a WRITE, and this was the per-turn contention
    // point. Null (disabled/unavailable) falls through to the direct open
    // inside unifiedRecallForTurn, byte-for-byte the pre-Mnemosyne path.
    const livingViaMnemosyne = await mnemosyneRecaller(
      live.context.aresHome,
      live.context.mind.memoryFile,
    ).catch(() => null);
    const prepared = live.agentRuntime?.prepared;
    const recall = await unifiedRecallForTurn({
      query: text,
      workspace: live.context.workspace,
      livingMemoryFile: live.context.mind.memoryFile,
      openLiving: livingViaMnemosyne ? async () => livingViaMnemosyne : undefined,
      shouldRecall: intent.shouldRecall,
      limit: 5,
      itemChars: LIVE_MEMORY_ITEM_CHARS,
      blockChars: LIVE_MEMORY_BLOCK_CHARS,
      tokenBudget: LIVE_MEMORY_TOKEN_BUDGET,
      vector: prepared?.enabled
        ? { config: prepared.config, home: prepared.home, useOllama: process.env.ARES_AGENT_OLLAMA_RECALL === "1" }
        : undefined,
      // TENANT ISOLATION GAP: this call site has no per-conversation identifier
      // to derive a scope from — a Telegram chatId never survives the trip. The
      // bridge (packages/channels/src/telegram/bridge.ts) maps chatId -> sessionId
      // and sends only { sessionId, text } over the gateway wire; the gateway
      // server (@ares/garrison SessionManager/GarrisonServer) terminates that
      // mapping and hands entry.ts nothing but the session's LiveSession, which
      // never carries chatId or owner/guest role. Defaulting to "owner" here is
      // honest for the single-tenant path (CLI/desktop) but does NOT isolate
      // Telegram guests from the owner's memory pool — that requires the gateway
      // (garrison) to thread chatId/role through session state, and bridge.ts to
      // stop only prepending an identity NOTE to the text (withIdentity()) and
      // instead pass a structured scope. Not fixable from entry.ts alone.
      scope: "owner",
    });
    live.lastRecallIds = recall.livingIds;
    live.lastUserMessage = text;
    if (recall.reminder) {
      live.queueSystemReminder(recall.reminder, "memory");
      const count = recall.items.length;
      emitLifecycle({ type: "recall_surfaced", count, gain: gainForTarget("RECALL", count) });
    }
    // Advisory cognition (Phase 2C step 3): think WITH what was just recalled and
    // offer a non-binding suggestion. Reuses the unified recall (no second query),
    // never writes a decision, and is gated so trivial turns skip it entirely.
    const advisory = await deliberateForTurn({
      situation: text,
      recalled: recall.living,
      shouldDeliberate: intent.shouldRecall,
      emit: (t) => emitLifecycle({ type: "thought", kind: t.kind, text: t.text }),
    });
    if (advisory.reminder) {
      live.queueSystemReminder(advisory.reminder, "memory");
    }
    // Capture the user's message as an episodic memory — this is how Ares learns over time.
    if (intent.shouldCapture) {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      await new MemoryRouter(store).write("manual", [{ kind: "episodic", content: text.slice(0, 400), source: live.session.meta.id }]);
    }
  } catch {
    // never break a turn over memory
  }
}

/**
 * Turn epilogue (ARES V5+V6). Three steps, all best-effort:
 *   1. the agent runtime's own afterTurn lifecycle;
 *   2. V6 consequence settling — every living memory injected into this turn
 *      gets the outcome recorded (win on completed, loss otherwise) so strength
 *      tracks usefulness, not recall popularity;
 *   3. V5 Witness — a cheap sideQuery fork reviews the finished turn and may
 *      write candidate hypotheses into living memory.
 * Nothing here may break the session loop.
 */
export async function finishTurn(
  live: LiveSession,
  finalStatus: "completed" | "interrupted" | "failed",
): Promise<void> {
  if (
    finalStatus !== "completed" ||
    live.session.lastWorkStatus === "unverified" ||
    live.session.lastWorkStatus === "blocked"
  ) {
    await live.verifier.cancel().catch(() => undefined);
  }
  await live.agentRuntime?.afterTurn(finalStatus);
  try {
    await live.codingJournal.finishTurn(finalStatus);
  } catch (error) {
    live.queueSystemReminder(
      `Coding journal persistence failed: ${error instanceof Error ? error.message : String(error)}. Re-establish task state from the rollout and repository before continuing; do not assume the prior turn's working state was saved.`,
      "instructions",
    );
  }

  // V6 — settle the artifacts that were in play.
  // Reliability reconciliation is post-turn and globally idempotent. Every
  // Core session reaches this seam, while the collector's cross-process lease and
  // durable cadence prevent live sessions from duplicating work. Collection
  // only files redacted candidates; it never launches a model, shell, or edit.
  scheduleReliabilityMaintenance(live);

  const ids = live.lastRecallIds ?? [];
  live.lastRecallIds = undefined;
  {
    // Keep a durable copy BEFORE the consuming branch below, and unconditionally
    // — a turn that recalled nothing is itself a reportable fact, and the
    // cockpit cannot distinguish "recalled nothing" from "I read the field too
    // late" unless this is always written.
    const workStatus = live.session.lastWorkStatus;
    live.lastRecallSummary = {
      ids: [...ids],
      won: finalStatus === "completed" && (workStatus === "verified" || workStatus === "not_applicable"),
      at: Date.now(),
    };
  }
  if (ids.length > 0) {
    try {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      const workStatus = live.session.lastWorkStatus;
      await store.recordOutcome(ids, {
        won: finalStatus === "completed" && (workStatus === "verified" || workStatus === "not_applicable"),
        note: `in play for a turn that ${finalStatus} with work status ${workStatus}`,
      });
    } catch {
      // consequence settling never breaks the loop
    }
  }

  // V5 — the Witness reviews substantive turns. Interrupted turns teach nothing
  // reliable; failed turns are reviewed (failures carry feedback/belief signal).
  const userMessage = live.lastUserMessage;
  live.lastUserMessage = undefined;
  if (!userMessage || finalStatus === "interrupted") return;
  if (finalStatus === "completed" && (live.session.lastWorkStatus === "unverified" || live.session.lastWorkStatus === "blocked")) return;
  if (process.env.ARES_WITNESS === "0" || !live.agentRuntime?.prepared.enabled) return;
  try {
    const intent = classifyUserIntent(userMessage);
    if (intent.lowSignal || !intent.shouldCapture) return;
    const history = live.session.engine.history();
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    const assistantText = lastAssistant ? messageText(lastAssistant) : "";
    if (!assistantText) return;
    const store = await MemoryStore.open(live.context.mind.memoryFile);
    const report = await runWitness({
      conversation: { user: userMessage, assistant: assistantText, status: finalStatus },
      store,
      source: live.session.meta.id,
      // The Witness runs on post-turn settling — an unbounded model call here
      // means the turn never finishes settling. witness.ts forwards this
      // signal into ask(); sideQuery also carries its own 60s default now.
      signal: AbortSignal.timeout(60_000),
      ask: ({ system, user, schemaHint, signal }) =>
        sideQueryJson({
          provider: live.selection.provider,
          model: live.selection.model,
          system,
          user,
          schemaHint,
          signal,
          onUsage: (usage) =>
            live.session.recordAuxiliaryUsage(
              "witness",
              live.selection.provider.name,
              live.selection.model,
              usage,
            ),
        }),
    });
    if (report.accepted.length > 0) {
      emitLifecycle({
        type: "capture_detected",
        kinds: report.accepted.map((n) => n.tags?.find((t) => t.startsWith("crucible:")) ?? "candidate"),
        excerpt: report.accepted[0].content.slice(0, 120),
        gain: gainForTarget("MEMORY", report.accepted.length, "hypotheses"),
      });
    }
  } catch {
    // the Witness is opportunistic — a failed review costs nothing
  }
}

/** Release process-local helpers when a live session is discarded. Durable
 * background supervisors intentionally survive ordinary host/session teardown;
 * session deletion and evaluation cleanup call killAll explicitly. */
export async function disposeLiveSession(live: LiveSession): Promise<void> {
  await live.verifier.cancel().catch(() => undefined);
  live.shellRegistry.detachAll();
  await live.agentRuntime?.sessionEnded().catch(() => undefined);
  live.agentRuntime?.stop();
}

export async function mindSessionEnded(): Promise<void> {
  try {
    const memoryFile = cliRuntimeContext().mind.memoryFile;
    const store = await MemoryStore.open(memoryFile);
    // sleep: forget the trivial, crystallize recurring themes — skipped when
    // another Ares process (daemon/garrison) holds the consolidation lock.
    await withConsolidationLock(memoryFile, () => store.consolidate());
  } catch {
    // never fatal
  }
}

/**
 * Compose the system prompt.
 *
 * The persona, the shared craft core, and the per-model overlay live in
 * `./prompt/` — this function now owns only the SURFACES: tool doctrine that
 * isn't in the tool schemas, workflow modes, and the environment block.
 *
 * `opts.providerFamily`/`opts.model` select the coding overlay. Callers that
 * know the live selection should pass it; omitting it simply drops the overlay
 * rather than guessing a family, so a caller that can't know stays correct.
 */
export function buildSystemPrompt(
  permissionMode: PermissionMode = "workspace-write",
  context = cliRuntimeContext(),
  opts: { providerFamily?: ProviderFamily; model?: string; persona?: PersonaConfig } = {},
): string {
  const platform = process.platform === "win32" ? "Windows (PowerShell first)" : process.platform;
  const cwd = context.workspace;
  const today = new Date().toISOString().slice(0, 10);

  return composeSystemPrompt({
    persona: opts.persona,
    providerFamily: opts.providerFamily,
    model: opts.model,
    // The owner's standing orders — read fresh (mtime-cached) on every
    // compose, so a law recorded this turn is in force in the very next
    // provider call, in EVERY session, agent runtime or not.
    laws: lawsPromptBlock(),
    surfaces: {
      tools: promptToolSurfaces(),
      workflows: promptWorkflowSurfaces(permissionMode),
      environment: promptEnvironment(permissionMode, cwd, platform, today),
    },
  });
}

/**
 * Tool doctrine that is NOT already in the tool schemas.
 *
 * The old prompt spent 4,660 chars paraphrasing tool descriptions the model
 * receives anyway. What survives here is the cross-cutting operational
 * knowledge a schema can't carry — the ComputerUse coordinate contract, the
 * search/browse convergence budget, the hand-off rule — plus the unavailability
 * rules, which exist because retrying an uninstalled tool wastes whole turns.
 */
function promptToolSurfaces(): string {
  return `## Tool doctrine

- **WebSearch/WebFetch has two modes — pick deliberately.** *Quick lookup* (docs, an API signature, an error message) CONVERGES FAST: at most 2-3 distinct queries, fetch a page at most once with a \`prompt\` naming exactly what to extract, hard cap ~6 web calls, then act. Don't re-search the same thing reworded. *Deep research* (the owner asks you to research, compare, evaluate or decide) follows the research doctrine below and the quick caps do not apply.
- **To SHOW the owner images**, call **ImageSearch** — one call returns direct image URLs. Put 3-6 in your reply as \`![caption](url)\`; the chat renders them inline. Don't browse stock-photo sites for this; they wall off headless browsers and burn the turn.
- **ComputerUse** (Windows) drives the REAL desktop — use it for the owner's MACHINE and native apps, not for files or code. Doctrine: **screenshot FIRST**, act on what you SEE, screenshot again to VERIFY. (1) Click/move coordinates are in the pixel space of the LAST image you were shown, top-left origin. (2) To open an app or settings page use \`launch\` (e.g. text=\`chrome\` key=\`chrome://extensions\`), never hunt for the Win key. (3) If a target is small, \`zoom\` into its region for a precisely-clickable native-resolution view before clicking. (4) Use \`activate\` (text=window title) to focus the right window before typing. Every move lands on the owner's real machine — be deliberate, and confirm anything destructive or outward-facing.
- **When a tool reports it is unavailable** (\`BROWSER_UNAVAILABLE\`, \`COMPUTER_USE_UNAVAILABLE\`), it is not installed in this build. Do NOT try to install it and do NOT retry — switch approach immediately (WebFetch for page text, ImageSearch for image URLs) and say what you'd have preferred.
- **RequestUserAction** is for a wall only a human can clear — a 2FA code, a captcha, a real payment, a login you can't complete. Call it with what you finished, what the owner must do, and how to resume, then STOP and deliver that as your reply. Never guess a code, never loop on the wall, never fail silently. This is the difference between "it gave up" and "it handed off cleanly."
- **Deploy / Stripe / Email** are real-world reach: publish a built site and return the live URL, create a payment link, send a report. All three need their key in the environment and ALL confirm with the owner before acting. If a key is missing, name the exact env var rather than pretending you acted.
- **Background work is durable, and you own every job you start.** \`Bash run_in_background\` + \`BashOutput\` + \`KillShell\` for dev servers, watchers and long builds — keep the returned shell_id, do useful work, poll when the output matters. \`Task run_in_background\` detaches a subagent for real parallelism; its status and completion survive a restart. Use them for genuine concurrency, not to avoid owning the main decision. The rules:
  - **Background it only when you will come back for it.** A command you need the result of is a foreground command. Backgrounding is for work that must keep running WHILE you do something else — not a way to escape a slow command.
  - **Poll what you started.** \`BashOutput\` before you rely on it. A job you never polled is a job you cannot claim anything about; "started the server" is not "the server is up".
  - **Stop what you started.** \`KillShell\` the moment a job stops earning its keep. A dev server that outlives the task is not a convenience, it's a process the owner never asked for holding a port.
  - **\`BackgroundTasks\` list before you finish.** If a turn started background work, check it before your final message and either stop it or SAY it is still running, what it is, and how to stop it. Never end a turn quietly leaving something running.
  - **Never background anything that grabs the screen** — a game, an installer, a GUI app, anything that steals focus or opens a window — unless the owner asked for exactly that, in this turn. Launching a window nobody asked for, on a loop, with no way to see why, is the single worst thing a background job can do.
  - **A suspended job is an offer, not a queue.** Stopping a turn, or closing the app, suspends the background work it started; those show as suspended+resumable. Resume one only when the owner asks for it. Never resume on your own initiative at the start of a session.
- **LSP** (go_to_definition / go_to_references / hover) before any risky refactor. **McpListTools/McpCallTool** only when the owner configured MCP servers. **SkillsList/SkillRead** when a reusable local workflow clearly applies. **CodeMode** for read-heavy batch analysis that would otherwise be many repetitive calls.`;
}

/** Workflow surfaces: long-horizon missions, research rigour, the app loop,
 *  the plan/build boundary, capability acquisition, and hooks. */
function promptWorkflowSurfaces(permissionMode: PermissionMode): string {
  return `## Durable missions — the Operator

For work that should OUTLIVE this conversation — "build and launch X over the coming days", a multi-session migration, anything with milestones — use the **Operator** tool. \`create\` a durable goal with a verification probe once the owner commits (confirm scope first; a durable goal is a contract, not a note). \`run\` ticks goals forward; \`status\`/\`list\` report honestly from the step log. \`acquire\` when you hit a missing capability, instead of working around the same gap repeatedly. TodoWrite is for THIS turn; the Operator is for outcomes that must survive the session.

## Deep research

When the owner wants real research, deliver an analyst-grade product, not a search dump:

1. **Decompose** into 2-5 sub-questions. With 3+, fan out parallel **Task** \`researcher\` subagents in ONE turn, each told exactly what to return (claims + source URLs).
2. **Triangulate.** A load-bearing claim needs 2+ independent sources or an explicit single-source flag. Prefer primary sources over blog summaries. Note disagreement instead of silently picking one.
3. **Date-stamp.** Today is in the environment block — check publication dates and say when data may be stale.
4. **Synthesise**: lead with the answer, then evidence, then caveats. Cite inline as [source](url) next to each claim — never a bare "sources say".
5. **Label confidence**: confirmed (2+ sources) / likely (one strong source) / uncertain. Never present uncertain as confirmed.

## App development — own the loop

1. **Scaffold deliberately.** Match the stack the repo already has; greenfield defaults to the lightest thing that ships (single HTML file > vite app > full framework). Don't add deps you don't need.
2. **Run it for real.** Start servers/builds with **Bash run_in_background**, read **BashOutput** for errors, **KillShell** when done — and check **BackgroundTasks** before you finish so nothing is left running behind you. Code that has never run is a draft. If the app under test LAUNCHES something (a game, a desktop window, an installer), run it once, in the foreground, with a timeout — never on a watcher that can relaunch it.
3. **Verify against the RUNNING app**, not the source: hit the endpoint, run the CLI, load the page, read the log line.
4. **For anything with a UI, DRIVE IT.** A self-contained \`.html\` goes through **Browser** with \`engine:"embedded"\`, \`action:"preview"\`, \`html:"<contents>"\` — it renders inside the Ares window and you drive it directly (\`click_text\`, \`fill_selector\`, \`eval\`, \`console\`, \`screenshot\`). A dev server or multi-file app uses the default Playwright engine against its URL. Either way, test it like a human — click the buttons, play the game, submit the form, read the console — fix what breaks, repeat. THEN report.
5. **Show, don't describe.** HTML/SVG you write auto-opens in the Forge panel. When a visual communicates better than prose — findings, comparisons, status, metrics, timelines — forge a self-contained styled \`.html\` HUD (dark theme, no external deps, data inlined) instead of a wall of text.
6. **Big builds scale out:** TodoWrite the plan, parallelise independent modules via **Task** \`general-purpose\`, then run a **Task** \`code-reviewer\` pass and fix what it finds BEFORE declaring done.

## Plan mode

Plan/build is an owner-controlled workflow boundary, not a tone. If the owner asks you to implement, fix or build, stay in build mode and act — don't force a planning ceremony onto ordinary coding. If they want to explore a consequential design or ambiguous implementation before committing changes, recommend plan mode and enter it when they agree.

In plan mode (current mode: \`${permissionMode}\`; the UI shows \`PLAN MODE\`), workspace writes, effectful shell calls, mutating environment operations and acquisition Workers are blocked. You may inspect, research, ask questions, use read-only subagents, and talk for as many turns as needed. Keep the living plan current with **UpdatePlanDraft** after material discoveries; it is durably revisioned across compaction and restart. Never imply you are implementing while planning. When the plan is ready call **ExitPlanMode** without repeating the body. Only the owner's explicit approval restores execution authority; a denial means keep planning.

## Environment control

Don't guess at live visual state from serialised coordinates. When work depends on seeing or controlling an editor, renderer, simulator, design tool or game engine, use **Capability list/resolve** to find a matching provider. If the operation you need is missing and you are in build mode, call **Capability ensure** so Ares creates and verifies a reusable adapter — don't wait to be told to inspect your own capability gap. After any visual mutation, invoke a read-only observation that returns fresh screenshot evidence and inspect it before correcting again or claiming success. In plan mode you may resolve and healthcheck read-only providers, but ensure/mutation waits for the approved build handoff.

## Hooks

The owner may configure shell hooks (PreToolUse, PostToolUse, SessionStart) in \`.ares/hooks.json\` or \`~/.ares/hooks.json\`. If a hook blocks a tool you'll see a \`<system-reminder>\` explaining why; adjust and try again.`;
}

/** Response shape, reach, hard rules, and the live environment block. */
/** Sandbox-only mode is a withheld-tools boundary, not a suggestion — but the
 *  model still has to KNOW, or it spends the turn reaching for a shell that
 *  isn't there and reporting itself broken. Read synchronously from the cached
 *  settings snapshot so composing a prompt never awaits disk. */
function sandboxModeBlock(): string {
  if (cachedUiSettings()?.computerMode !== "sandbox") return "";
  return `## SANDBOX-ONLY MODE IS ON

The owner has confined you to YOUR OWN computer. Host shells, host GUI control, and host file writes are not in your toolset this session — that is deliberate, not a malfunction. Do every piece of work through the Computer* tools. You may still READ the owner's files, and ComputerTransfer moves files between the two machines with their approval. If a request truly requires changing the owner's machine, say so and ask them to turn sandbox-only off.

`;
}

function promptEnvironment(permissionMode: PermissionMode, cwd: string, platform: string, today: string): string {
  // The machine card: standing awareness that Ares HAS a computer of its own —
  // what's on it, what it last did there, and the routing rule for using it.
  // Synchronous (mtime-cached files); empty off-win32 or when nothing is known.
  return `${machineCardPromptBlock()}${sandboxModeBlock()}## Response shape

Match output length to task complexity. Most replies are ≤4 lines excluding tool calls and code. Skip preamble ("Here's what I'll do") and postamble ("I've completed the task"). Lead with the answer or the action.

<example>
user: 2 + 2
assistant: 4
</example>

<example>
user: which file has the auth middleware?
assistant: src/middleware/auth.ts:42
</example>

For substantial work, lead with the action you're taking in one short sentence, then act. When a turn contains \`<voice-mode/>\` it is hands-free speech: reply in 1-3 short conversational sentences that read naturally aloud, no Markdown unless asked, and perform requested actions before confirming them.

Take initiative on follow-ups that obviously belong to the request. In workspace-write mode, act when a change is needed instead of waiting for magic wording like "write" or "edit". When several approaches are reasonable, take the safest and say you can change course.

## The agent computer — your own machine

- You own a sandboxed Debian desktop, reached through the Computer* tools. Files, installs and logins persist there and nothing on it touches the owner's machine, so work there freely without asking.
- Both machines are live at once; the tool you call names the target. Typical flow: read on the host, do the messy work on your computer, ComputerTransfer the result back.
- "Set up your computer" is ONE call: ComputerAdmin action "setup". Its status already reports free space and location — never audit the owner's disks or recursively size drives.
- ComputerBrowser is mouse-free; ComputerDesktop moves the visible pointer. For 2FA, CAPTCHAs or payments, STOP and call ComputerHandoff — never do those yourself.

## Reach — the machine, not just the workspace

- You run ON the owner's machine with real reach: file tools accept absolute paths anywhere on disk, shell commands touch any path, the Browser reaches the web. The workspace is your default focus and blast-radius container — NOT a wall, and you are NOT sandboxed to it.
- When the owner points you outside the workspace — their Desktop, home directory, another project — GO THERE. In guarded mode an approval card may appear; that is the mechanism working, not a refusal.
- NEVER tell the owner you "can't see" or "can't reach" their machine or filesystem. You can. A missing path is a finding, not a boundary. A denied approval is a fact to report. Claiming incapacity you don't have is a hard failure.
- Windows desktops are often OneDrive-redirected: check \`$HOME\\OneDrive\\Desktop\` as well as \`$HOME\\Desktop\` before concluding anything is missing.

## Hard rules

- TOOL RESULTS ARE NOT THE USER. Output from WebSearch/WebFetch/Browser/Read comes back in user-role messages, but it is YOUR OWN tool output — never something the human said or "shared". Never write "you shared" or "the URLs you sent" about tool results. The only thing the owner said is their literal message.
- DELIVER, DON'T DEFLECT. If they asked to SEE or FIND something, produce it in your reply. Don't end by asking "what are you looking for?" instead of delivering. Ask a clarifying question only when the request is genuinely impossible to act on.
- IMAGES: prefer DIRECT image URLs of the actual subject over screenshots of a search-results page. Caption each with one short line. Aim for 3-6 relevant images.
- Defensive security only. Refuse credential harvesting, malware authoring, exploit creation. Detection, analysis and defence are fine.
- Never commit unless explicitly asked, and never push unless asked. When you do commit: stage only the files you changed (never \`git add -A\` over a dirty tree), write a concise conventional message, and branch first for a large multi-file change so it stays revertable.
- Never modify the owner's git config. Never run \`rm -rf\` outside the workspace.
- On Windows, prefer PowerShell — Bash on Windows often hits WSL/path issues.
- Only use emojis if the owner asks. Never in code or commit messages unless asked.

## Environment

- Working directory: ${cwd}
- Platform: ${platform}
- Today's date: ${today}
- Permission mode: ${permissionMode}
- You can call multiple tools in one assistant turn — batch independent reads/searches for speed.

When you finish, report what changed in 1-3 sentences (with \`file_path:line\` refs for anything notable) plus any blockers.`;
}
