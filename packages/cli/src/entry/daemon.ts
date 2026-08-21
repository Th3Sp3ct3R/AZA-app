// Extracted from entry.ts — daemon.

/** How long an accepted-but-unsettled Stop must sit before a second Stop is
 *  allowed to force-kill what the turn is blocked on. Long enough that an
 *  ordinary unwind finishes first; short enough that nobody waits forever. */
const FORCE_STOP_AFTER_MS = 12_000;

/** After a forced abort, how long the killed turn gets to unwind on its own
 *  before the daemon declares it a zombie and releases the session entry.
 *  Covers the awaits a process kill cannot break (a hung verifier drain, a
 *  dead promise) — the class that used to wedge "stopping safely" until the
 *  app was restarted. Longer than the cancelled-turn finishTurn bound (15s):
 *  a healthy-but-slow settle must finish, not get zombified mid-write. */
const FORCE_STOP_RELEASE_GRACE_MS = 20_000;

import { authStatus, listSessions, loadSessionSnapshot, loadSessionRollout, deleteSession, renameSession, SessionNotFoundError, type Provider, classifyLane, runAnthropicLoginFlow, loadAnthropicTokens, sideQuery, sideQueryJson, QueryEngine, installGlobalCrashHandlers, EventRing, HeapGuard, readHeapSample, writeCrashLogSync, openWorkspaceSessionKernel, probeCredentialEncryption, connectMcpServer, disconnectMcpServer, setMcpServerEnabled, setMcpServerToken, connectorNameFromUrl, runOpenAILoginFlow, runKimiLoginFlow, kimiAuthStatus } from "@ares/core";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import type { ContentBlock, PermissionMode, PermissionPromptDecision, TurnEvent } from "@ares/protocol";
import { isReasoningLevel, REASONING_LEVELS, messageText, redactSecrets } from "@ares/protocol";
import type { ToolPermissionRequest } from "@ares/core";
import { notice } from "../terminalUi.js";
import { loadUiSettings, updateUiSettings, type UiSettings } from "../uiSettings.js";
import { DEFAULT_PERMISSIONS, decidePermission, type PermissionSettings } from "../permissionPolicy.js";
import { consciousnessStatus, downloadAllConsciousnessModels } from "../consciousness.js";
import { describeImage, engineStatus } from "../visionEngine.js";
import { prepareEngineBinary } from "../engineBinary.js";
import { captureScreen } from "../screenCapture.js";
import { ConsciousnessWatch, WATCHER_VOICE_PROMPT } from "../watch.js";
import { recordConsciousnessObservation } from "../consciousnessContext.js";
import { aresAgentHome, deletePersona, listPersonas, loadAgentConfig, onLifecycle, runDeepDream, runSkill, skillHubProbe, skillHubList, skillHubGet, skillHubPublish, installHubSkill, readLocalSkillFiles, writePersona } from "@ares/agent";
import { adoptPersonaByName, applyPersonaToolResult, newPersonaGate, personaForMessage, personaToWire, type PersonaGate } from "./daemon/personas.js";
import { assembleCognitiveState } from "./daemon/cognitiveState.js";
import { QueryEngineDispatcher, OperatorBackgroundLoop, deriveLeash, domainOf, isOperatorPaused, listGoals, loadStandingOrders, materializeDueStandingOrders, loadWatchers, operatorTickIntervalMs, type StandingOrder } from "@ares/operator";
import { MemoryStore, mindPaths, reflectOnRun, detectWorkspaceProjectId, loadProjectState, buildConversationDigest, mergeDurableFacts, withConsolidationLock, CONVERSATION_REFLECT_SYSTEM, DURABLE_FACTS_SCHEMA_HINT, type DurableFact } from "@ares/mind";
import { OAUTH_PROVIDERS, PROVIDER_LABELS, startOAuthFlow, connectedProviders, getProviderConfig, setCredential, hasCredential, deleteCredential, clientIdName, clientSecretName, runAresAccountSignin, probeAresOauth } from "@ares/core";
import { KillSwitch } from "@ares/effects";
import { gateToolPermission } from "../policyGate.js";
import { embeddedBridge, setExtensionBrowserBridge } from "./browserBridge.js";
import { getAgentComputer } from "@ares/tools";
import { BrowserBridgeServer } from "@ares/browser-extension-connector";
import { garrisonCommand } from "./garrisonCmd.js";
import { fileURLToPath } from "node:url";
import { cleanCommandId } from "./permissions.js";
import { aresGatewayBase, daemonModelCatalog, fetchAresGatewayMe, fetchCustomOpenAiModels, postAresGatewayReport, preflightProviderSelection, providerFamilyForSelection, selectProvider, type ProviderSelection } from "./providers.js";
import { ParsedArgs, cliVersion, transitionPermissionMode } from "./runtime.js";
import { LiveSession, chatContextBudget, createSession, createSessionWithSelection, handleReasoningCommand, isProviderFatalError, makeSpanSummarizer, modelLikelyHasVision, pickCapacitySibling, pickHealthyFallback, pickVisionFallback, resolveReasoningLevel } from "./sessionFactory.js";
import { startGatewayMirror } from "./telegramWiring.js";
import { contentFromUserInput, undoLines } from "./terminalLines.js";
import { buildSystemPrompt, disposeLiveSession, finishTurn, gatherGitRunFacts, lastTriageRun, mindSessionEnded, prepareUserTurn, semanticUserMessage } from "./turnPipeline.js";

// Satellite modules (extracted, closure-free helpers — command handlers and
// their shared mutable state stay in this file):
//   daemon/engineConfig.ts — normalizeEngineConfig, applyEngineConfigEnv, ManualReminderSource
//   daemon/routing.ts      — ROUTING_LANES, normalizeRoutingCommand
//   daemon/report.ts       — trimRolloutForReport (bug_report rollout capping)
//   daemon/skills.ts       — SkillSurface/DaemonSkillInfo, parseSurfaces, inferSkillProvides, daemonSkillsList
//   daemon/usageStats.ts   — UsageStats, daemonUsageStats (+ OpenRouter cost estimation)
//   daemon/protocol.ts     — DaemonInputCommand, AsyncQueue, DaemonCommandRouter (NDJSON stdin plumbing)
//   daemon/mcp.ts          — mcpDirectorySnapshot
import { applyEngineConfigEnv, normalizeEngineConfig } from "./daemon/engineConfig.js";
import { normalizeRoutingCommand } from "./daemon/routing.js";
import { saveReportLocally, trimRolloutForReport } from "./daemon/report.js";
import { daemonSkillsList } from "./daemon/skills.js";
import { daemonUsageStats } from "./daemon/usageStats.js";
import { DaemonCommandRouter, type DaemonInputCommand } from "./daemon/protocol.js";
import { mcpDirectorySnapshot } from "./daemon/mcp.js";

// Back-compat re-exports: garrisonCmd.ts + sessionFactory.ts import these from
// "./daemon.js", and the root tests import them from the compiled
// dist/entry/daemon.js. Keep them exported here even though they now live in
// the daemon/ satellites.
export { applyEngineConfigEnv, type ManualReminderSource } from "./daemon/engineConfig.js";
export { parseSurfaces, inferSkillProvides } from "./daemon/skills.js";

export async function daemonCommand(args: ParsedArgs): Promise<number> {
  /** When THIS host started. The fence between "work a previous Ares left
   *  running" and work a live sibling host owns. */
  const hostStartedAt = Date.now();
  if (args.flags.get("json") !== "true" && !args.flags.has("json")) {
    process.stderr.write("error: daemon currently requires --json\n");
    return 2;
  }
  // Gateway account poll: when the owner-site token is configured, snapshot
  // /me every 20s — new credit grants become gateway_grant toasts in the UI,
  // and balance/model changes refresh the Account panel live. Silent on every
  // failure; a dead gateway can never affect the daemon.
  {
    let gwCursor: string | undefined;
    const gwPoll = setInterval(async () => {
      try {
        const settings = await loadUiSettings();
        if (!settings.aresGatewayToken) return;
        const me = await fetchAresGatewayMe(aresGatewayBase(settings), settings.aresGatewayToken, gwCursor);
        if (!me) return;
        for (const g of me.new_grants ?? []) {
          process.stdout.write(JSON.stringify({ type: "gateway_grant", amount_usd: g.amount_usd, reason: g.reason, at: g.at }) + "\n");
        }
        process.stdout.write(JSON.stringify({ type: "gateway_account", connected: true, ...me }) + "\n");
        gwCursor = me.server_time ?? gwCursor;
      } catch {
        // best-effort
      }
    }, 20_000);
    gwPoll.unref?.();
  }
  // Scrub the daemon's diagnostic stream. The desktop shell forwards this
  // process's stderr straight into the webview; a verbose provider/library debug
  // line with an embedded key would otherwise reach the UI (and a copied error
  // report) unredacted. stderr carries only free-text diagnostics here — the
  // structured protocol rides stdout — so redaction can never corrupt a payload.
  {
    const rawStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      try {
        if (typeof chunk === "string") return (rawStderrWrite as (c: string, ...r: unknown[]) => boolean)(redactSecrets(chunk), ...rest);
        if (chunk instanceof Uint8Array) {
          return (rawStderrWrite as (c: string, ...r: unknown[]) => boolean)(redactSecrets(Buffer.from(chunk).toString("utf8")), ...rest);
        }
      } catch {
        // never let redaction break diagnostics
      }
      return (rawStderrWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
  }
  const rl = createInterface({ input: stdin, output: stderr, terminal: false });
  const commands = new DaemonCommandRouter((error) => {
    process.stdout.write(JSON.stringify({ type: "daemon_error", error }) + "\n");
  });
  commands.start(rl);
  // Surface a plaintext-fallback vault loudly at startup — a leaked plaintext
  // credentials.json the owner never knew about was the worst security finding.
  void probeCredentialEncryption().then((enc) => {
    if (!enc.available) {
      process.stdout.write(
        JSON.stringify({
          type: "vault_warning",
          available: false,
          reason: enc.reason,
          message: "Credential encryption is unavailable; stored secrets are NOT encrypted at rest.",
        }) + "\n",
      );
    }
  });
  // The embedded-browser bridge speaks to the desktop UI over this daemon's
  // stdout (which the shell reads). webview_cmd goes out here; webview_result
  // comes back as a command (handled in the loop below).
  embeddedBridge.emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  // Desktop posture: give the agent real freedom so the flow isn't constantly
  // interrupted. Low-risk actions (web/browser/read/search/most tool use)
  // auto-approve; only genuinely sensitive ones (credentials, payments,
  // sending email, external accounts, destructive wipes) still ask the owner.
  // Approvals currently parked waiting for the owner. Tracked here (rather than
  // inferred later) because "what is blocked on me" is otherwise invisible —
  // the prompt is in flight, not in any store, so nothing could report it.
  const pendingApprovals = new Map<string, { tool: string; reason?: string; at: number }>();
  let approvalSeq = 0;

  const requestPermission = (request: ToolPermissionRequest): Promise<PermissionPromptDecision> => {
    // The owner is present at the desktop, so this is the ATTENDED gate: a
    // hard-blocked or staged action escalates to the owner rather than being
    // denied outright. The policy gate can only make things STRICTER than the
    // legacy regex (a structured risky category is upgraded to ask/deny); when it
    // has no opinion ("defer") we fall back to the existing auto decision so the
    // freedom posture for ordinary tools is untouched.
    const gate = gateToolPermission(request, { attended: true });
    if (gate.kind === "deny") return Promise.resolve("deny");
    // Owner permission policy (master/per-category toggles, read LIVE so the
    // Permissions tab applies mid-session). A soft gate "ask" (ComputerUse,
    // unknown categories) is subordinate to the owner's posture — otherwise
    // "free" mode would still nag on every desktop action, which is exactly
    // the regression the gate promises never to cause. Only a HARD block
    // (payments, email, credentials, destructive wipes) outranks the posture.
    const outcome = decidePermission(request, live?.runtime.permissions);
    // One wrapper for both escalation paths so a parked approval can never be
    // recorded on one branch and missed on the other.
    const park = (req: ToolPermissionRequest): Promise<PermissionPromptDecision> => {
      const key = `ap_${++approvalSeq}`;
      pendingApprovals.set(key, { tool: req.toolName, reason: req.reason, at: Date.now() });
      return commands.waitForPermission(req).finally(() => pendingApprovals.delete(key));
    };
    if (gate.kind === "ask" && (gate.hardBlocked || outcome !== "allow")) {
      return park({ ...request, reason: gate.reason ?? request.reason });
    }
    return outcome === "allow" ? Promise.resolve("allow_once") : park(request);
  };
  let live: LiveSession;
  let browserExtensionBridge: BrowserBridgeServer | null = null;
  try {
    live = await createSession(args, undefined, requestPermission, {
      // The daemon owns a richer visible pipeline than Session itself: routing,
      // preparation, persona, vision, failover, verification, and NDJSON events.
      // Never let the constructor execute recovered work behind that pipeline.
      detachedStartupRecovery: false,
    });
    const bridgeConfigPath = path.join(live.context.home, "browser-bridge", "config.json");
    try {
      const raw = JSON.parse(await readFile(bridgeConfigPath, "utf8")) as {
        host?: string;
        port?: number;
        hostToken?: string;
      };
      if (raw.host !== "127.0.0.1") throw new Error("host must be 127.0.0.1");
      if (!Number.isInteger(raw.port) || raw.port! < 1 || raw.port! > 65_535) throw new Error("port is invalid");
      if (typeof raw.hostToken !== "string" || raw.hostToken.length < 32) throw new Error("host token is invalid");
      browserExtensionBridge = new BrowserBridgeServer({ port: raw.port!, hostToken: raw.hostToken });
      await browserExtensionBridge.start();
      setExtensionBrowserBridge(browserExtensionBridge);
      process.stdout.write(JSON.stringify({ type: "browser_bridge_started", host: "127.0.0.1", port: raw.port }) + "\n");
    } catch (bridgeError) {
      if ((bridgeError as NodeJS.ErrnoException)?.code !== "ENOENT") {
        process.stdout.write(JSON.stringify({
          type: "browser_bridge_error",
          error: bridgeError instanceof Error ? bridgeError.message : String(bridgeError),
        }) + "\n");
      }
    }
  } catch (err) {
    setExtensionBrowserBridge(null);
    commands.close();
    rl.close();
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // ── multi-session registry ────────────────────────────────────────────────
  // Each UI chat card is an INDEPENDENT conversation with its own QueryEngine,
  // history, abort signal, tools, and checkpoints — no cross-talk. The bootstrap
  // session above becomes the entry for whichever card sends first; later cards
  // spawn fresh, lighter sessions (no duplicate background heartbeat). Every
  // event the daemon emits is tagged with its sessionId so the UI routes by id,
  // never by "active card".
  interface DaemonEntry {
    live: LiveSession;
    turnActive: boolean;
    /** Durable identity of the ordinary input that owns this daemon turn. */
    activeInputId?: string;
    /** Stop was accepted; no new send may be inferred as steering until the
     * owner generator and its post-turn settlement have actually unwound. */
    cancelRequested: boolean;
    /** When Stop was accepted — a Stop that never settles becomes force-eligible. */
    cancelRequestedAt?: number;
    forceStopRequested?: boolean;
    /** Inputs whose turn was force-released after the forced abort itself
     * failed to unwind the generator. The zombie turn's catch/finally must
     * become a no-op: the daemon already declared the turn settled and may be
     * running a successor on this entry (or a rehydrated one). */
    zombieTurnInputIds?: Set<string>;
    /** Steers admitted against the active turn and not yet acknowledged. */
    pendingSteerInputIds: Set<string>;
    /** Admission/drain tasks, including the rare steer that becomes the next
     * turn after the prior generation crossed its terminal boundary. */
    pendingSteerTasks: Map<string, Promise<void>>;
    /** Admission tickets serialize attachment parsing plus the SQLite flush,
     * while each steer remains free to settle independently afterward. */
    steerAdmissionTail: Promise<void>;
    /** Steers routed after QueryEngine's terminal fence. They re-enter the
     * ordinary daemon turn pipeline only after the owner wrapper releases. */
    deferredSteers: Map<string, { text: string; sessionId?: string }>;
    /** Exact deferred correction handed from a settled owner to the ordinary
     * command runner. Stop remains bound to this ID until that runner marks it
     * active; there must never be an observable idle gap between the two. */
    successorHandoff?: { inputId: string; sessionId?: string; cancelRequested: boolean };
    /** Bounded same-process replay fence for acknowledgements that arrive after
     * the admission task has already left pendingSteerTasks. */
    settledSteerInputIds: Set<string>;
    /** Corrections received before the owner input crosses SQLite admission.
     * They flush synchronously from that owner's input_admitted observer, after
     * its FIFO reservation is guaranteed to win. */
    preparingSteers: Map<string, { text: string; sessionId?: string }>;
    /** Truthful live boundary for steering. A provider attempt can be superseded
     * immediately; an executing tool must settle before its correction lands. */
    steeringPhase: "idle" | "preparing" | "generation" | "action" | "boundary" | "settling";
    /** Parallel tool calls share one action boundary. */
    activeToolIds: Set<string>;
    /** Canonical crash-recovered inputs waiting to re-enter the ordinary daemon
     * send path. Only one is scheduled at a time so every turn is observable. */
    startupRecoveryQueue: Array<{ inputId: string; goal: string; sessionId?: string }>;
    /** Exact recovered input currently scheduled or executing. */
    startupRecoveryInputId?: string;
    /** The exact ID above is waiting for crashed-lease takeover, before it can
     * be safely cancelled or admitted by this daemon generation. */
    startupRecoveryPreparing: boolean;
    /** Stop arrived during that takeover window and must be applied immediately
     * after the old claim is requeued, before ordinary execution begins. */
    startupRecoveryCancelRequested: boolean;
    /** Prevent duplicate lease takeover/listing for one hosted Session. */
    startupRecoveryPrepared: boolean;
    /** The lane (task domain) this session is currently on, for sticky auto
     *  routing — the model only switches when the lane actually changes. */
    lane?: string;
    /** What the owner has already decided about personas in this session, so
     *  "Back to Ares" survives the next message instead of being undone by the
     *  first keyword that matches. */
    personaGate: PersonaGate;
    /** Last time anything touched this session. Drives idle eviction — a
     *  resident session is a whole transcript held in memory. */
    lastActiveAt: number;
    /** When the active turn began. Scopes an interrupt's background sweep to
     *  the work that turn started. */
    turnStartedAt?: number;
  }
  const DEFAULT_SID = "__primary__";
  const sessions = new Map<string, DaemonEntry>();
  const primaryEntry: DaemonEntry = {
    live,
    turnActive: false,
    cancelRequested: false,
    pendingSteerInputIds: new Set(),
    pendingSteerTasks: new Map(),
    steerAdmissionTail: Promise.resolve(),
    deferredSteers: new Map(),
    settledSteerInputIds: new Set(),
    preparingSteers: new Map(),
    steeringPhase: "idle",
    activeToolIds: new Set(),
    startupRecoveryQueue: [],
    startupRecoveryPrepared: false,
    startupRecoveryPreparing: false,
    startupRecoveryCancelRequested: false,
    personaGate: newPersonaGate(),
    lastActiveAt: Date.now(),
  };
  let mainSelection = live.selection;
  let mainProviderFamily = providerFamilyForSelection(live.selection);
  let activeTurns = 0;
  // Guards the long-running Consciousness model download so a second "awaken"
  // doesn't kick off a parallel pull; the controller lets "cancel" abort it.
  let consciousnessDownloading = false;
  let consciousnessAbort: AbortController | undefined;

  // Providers that failed THIS SESSION with a balance/auth error (402/401/403/
  // insufficient balance). They won't recover this instant, so we stop re-selecting
  // them — but a balance top-up or re-auth IS recoverable, so each is parked only
  // until a cooldown elapses, then auto-re-probed (the old behaviour kept them dead
  // for the whole session, so topping up DeepSeek never came back without a manual
  // model switch). A manual switch still clears them all immediately. Override the
  // cooldown with ARES_DEAD_PROVIDER_TTL_MS.
  const deadProviders = new Map<string, number>(); // family → epoch ms it may be re-probed
  const deadProviderTtlMs = Math.max(60_000, Number(process.env.ARES_DEAD_PROVIDER_TTL_MS) || 10 * 60_000);
  const markProviderDead = (family: string): void => {
    deadProviders.set(family, Date.now() + deadProviderTtlMs);
  };
  // Prune expired entries (cooldown elapsed → give the provider another chance) and
  // return the still-dead set — the single read path so re-probe is consistent.
  const liveDeadProviders = (): Set<string> => {
    const now = Date.now();
    for (const [family, until] of deadProviders) {
      if (now >= until) deadProviders.delete(family);
    }
    return new Set(deadProviders.keys());
  };
  const isProviderDead = (family: string): boolean => liveDeadProviders().has(family);
  const isPermanentlyDeadError = (blob: string): boolean =>
    /\b402\b|\b401\b|\b403\b|insufficient.?balance|unauthorized|forbidden|invalid.?api.?key|no_auth/i.test(blob);
  sessions.set(live.session.meta.id, primaryEntry);

  // Bounded tail of what the daemon was doing right before a crash — pulled by
  // the crash handler so a coworker's silent death leaves a diagnosable trail.
  const eventRing = new EventRing(40);

  const tagEmit = (sessionId: string | undefined, obj: Record<string, unknown>): void => {
    const payload = sessionId && sessionId !== DEFAULT_SID ? { ...obj, sessionId } : obj;
    eventRing.record({ at: Date.now(), ...payload });
    process.stdout.write(JSON.stringify(payload) + "\n");
  };

  // ─── Resident-session ceiling ────────────────────────────────────────────
  //
  // Every session the desktop touches gets a LIVE session here — engine,
  // full message history, tool surfaces, verifier, agent runtime — and until
  // now nothing ever removed one. Only `session delete` called sessions.delete.
  // So a day of clicking through the rail meant every transcript ever opened,
  // screenshots and tool output included, resident at once. That is the climb
  // behind "the more I use it the slower it gets", and the heap limit behind
  // exit 134.
  //
  // Eviction is not deletion: the session is on disk, and resolveEntry rebuilds
  // it on the next command through the SAME path a daemon restart uses. The
  // cost is one rehydration; the alternative is the process dying.
  const MAX_RESIDENT_SESSIONS = Math.max(2, Number(process.env.ARES_MAX_RESIDENT_SESSIONS) || 6);
  const SESSION_IDLE_MS = Math.max(60_000, Number(process.env.ARES_SESSION_IDLE_MS) || 15 * 60_000);
  /** Never evict something that just happened — a resolve is often followed
   *  immediately by the command that resolved it. */
  const EVICT_FLOOR_MS = 45_000;

  /**
   * Evictable = idle AND holding nothing the daemon still owes an answer for.
   * Every one of these fields is a promise to the surface (a turn mid-flight, a
   * steer awaiting acknowledgement, a recovered input not yet re-admitted);
   * dropping the session under any of them would strand it.
   */
  const isEvictable = (entry: DaemonEntry): boolean =>
    entry !== primaryEntry &&
    !entry.turnActive &&
    !entry.cancelRequested &&
    !entry.successorHandoff &&
    entry.pendingSteerInputIds.size === 0 &&
    entry.pendingSteerTasks.size === 0 &&
    entry.preparingSteers.size === 0 &&
    entry.deferredSteers.size === 0 &&
    entry.activeToolIds.size === 0 &&
    entry.steeringPhase === "idle" &&
    !entry.startupRecoveryInputId &&
    !entry.startupRecoveryPreparing &&
    entry.startupRecoveryQueue.length === 0;

  const evictSession = (sid: string, entry: DaemonEntry, reason: string, idleMs: number): void => {
    sessions.delete(sid);
    // Release process-local helpers. Durable background jobs deliberately
    // survive this (same posture as any other host teardown) — an evicted
    // session is a session that is still very much alive on disk.
    void disposeLiveSession(entry.live).catch(() => undefined);
    tagEmit(sid, {
      type: "session_evicted",
      reason,
      idleMs,
      residentSessions: sessions.size,
    });
  };

  /**
   * Drop idle sessions: everything past the idle deadline, then — oldest
   * first — whatever it takes to get back under the resident ceiling. Under
   * heap pressure the deadline collapses to the floor, because at that point a
   * rehydration is cheaper than an abort. Returns how many were evicted.
   */
  const evictIdleSessions = (reason: "idle" | "heap-pressure"): number => {
    const now = Date.now();
    const pressured = reason === "heap-pressure";
    const deadline = pressured ? EVICT_FLOOR_MS : SESSION_IDLE_MS;
    const candidates = [...sessions.entries()]
      .filter(([, entry]) => isEvictable(entry))
      .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);

    let evicted = 0;
    const remaining: Array<[string, DaemonEntry]> = [];
    for (const [sid, entry] of candidates) {
      const idleMs = now - entry.lastActiveAt;
      if (idleMs >= deadline) {
        evictSession(sid, entry, reason, idleMs);
        evicted++;
      } else {
        remaining.push([sid, entry]);
      }
    }
    // Still over the ceiling? Keep taking from the oldest end. The floor holds
    // even here: a session touched seconds ago is about to be used.
    for (const [sid, entry] of remaining) {
      if (sessions.size <= MAX_RESIDENT_SESSIONS) break;
      const idleMs = now - entry.lastActiveAt;
      if (idleMs < EVICT_FLOOR_MS) continue;
      evictSession(sid, entry, `${reason}:over-capacity`, idleMs);
      evicted++;
    }
    return evicted;
  };

  // ─── Background work: visible, stoppable, and never outliving its host ────
  //
  // A background shell runs behind a DETACHED supervisor, on purpose: that is
  // what makes it survive a daemon restart and stay pollable. The bug was that
  // it survived EVERYTHING — Stop, the app closing, the machine sitting idle
  // overnight — while being impossible to see or stop from the UI. One
  // dev-server job kept relaunching a game every few minutes for days.
  //
  // The rule now: a background job may outlive a RESTART, but never its host.
  // On Stop we suspend what that turn started; on shutdown we suspend
  // everything. Suspended is not cancelled — the record keeps the launch
  // request, reads as resumable, and is relaunched only when a human or the
  // model explicitly asks. Nothing ever resumes by itself.

  /** Every non-terminal background job the daemon knows about, newest first. */
  const backgroundJobsFor = (sid: string, entry: DaemonEntry): Array<Record<string, unknown>> => {
    try {
      return entry.live.shellRegistry.list(entry.live.session.meta.id).map((job) => ({ ...job, sessionId: sid }));
    } catch {
      return [];
    }
  };

  const emitBackgroundJobs = (sessionId: string | undefined, entry: DaemonEntry): void => {
    const jobs = backgroundJobsFor(sessionId ?? entry.live.session.meta.id, entry);
    tagEmit(sessionId, {
      type: "background_jobs",
      jobs,
      running: jobs.filter((job) => job.status === "running").length,
      resumable: jobs.filter((job) => job.resumable === true).length,
    });
  };

  /**
   * Stop background work on the host's behalf and say so.
   *
   * `since` scopes it to work a specific turn started, so an interrupted turn
   * takes its own launches down with it and leaves alone the dev server the
   * user deliberately started an hour ago.
   */
  const suspendBackgroundWork = async (
    reason: string,
    entries: DaemonEntry[],
    opts: { since?: number; sessionId?: string } = {},
  ): Promise<number> => {
    let stopped = 0;
    for (const entry of entries) {
      try {
        const suspended = await entry.live.shellRegistry.suspendForSession(
          entry.live.session.meta.id,
          { reason, ...(opts.since !== undefined ? { since: opts.since } : {}) },
        );
        if (suspended.length === 0) continue;
        stopped += suspended.length;
        tagEmit(opts.sessionId, {
          type: "background_suspended",
          reason,
          count: suspended.length,
          jobs: suspended.map((job) => ({ id: job.id, description: job.description, command: job.command, resumable: job.resumable === true })),
        });
      } catch {
        // Shutdown must never fail on a job that refuses to die.
      }
    }
    return stopped;
  };

  // OS known folders for natural-language drive-workspace rebinding. Resolved
  // once through the shell so OneDrive-redirected Desktops resolve correctly;
  // falls back to the conventional %USERPROFILE% layout when the query fails.
  let knownFoldersPromise: Promise<Record<string, string>> | undefined;
  const resolveKnownFolder = async (name: string): Promise<string | undefined> => {
    knownFoldersPromise ??= new Promise((resolve) => {
      const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
      const fallback = {
        desktop: path.join(home, "Desktop"),
        documents: path.join(home, "Documents"),
        downloads: path.join(home, "Downloads"),
      };
      if (process.platform !== "win32") { resolve(fallback); return; }
      const script = "[Console]::Out.WriteLine([Environment]::GetFolderPath('Desktop'));"
        + "[Console]::Out.WriteLine([Environment]::GetFolderPath('MyDocuments'));"
        + "[Console]::Out.WriteLine((New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path)";
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      let out = "";
      child.stdout.on("data", (chunk) => { out += String(chunk); });
      const settle = (): void => {
        const [desktop, documents, downloads] = out.split(/\r?\n/u).map((line) => line.trim());
        resolve({
          desktop: desktop || fallback.desktop,
          documents: documents || fallback.documents,
          downloads: downloads || fallback.downloads,
        });
      };
      child.once("close", settle);
      child.once("error", () => resolve(fallback));
      setTimeout(() => { try { child.kill(); } catch { /* settled */ } }, 8_000).unref?.();
    });
    const folders = await knownFoldersPromise;
    const candidate = folders[name];
    if (!candidate) return undefined;
    return await stat(candidate).then((s) => (s.isDirectory() ? candidate : undefined)).catch(() => undefined);
  };

  // Crash safety net. The desktop bridge is a long-lived process on a coworker's
  // machine; until now an uncaught error or stray rejection could kill it with
  // nothing on disk. Now every fatal lands in ~/.ares/crashes and is surfaced to
  // the UI; a stray background rejection is logged but no longer takes the chat
  // down with it (see crashLog.ts for the posture).
  // handleSignals:false on purpose: the desktop manages this process's lifecycle
  // (normal close ends stdin → the command loop exits → the `finally` below runs
  // the FULL teardown, incl. agent-runtime flush). Catching signals here would
  // process.exit() straight past that teardown. We only want the uncaught/
  // rejection net + crash log.
  const uninstallCrashHandlers = installGlobalCrashHandlers({
    home: live.context.home,
    process: "daemon",
    handleSignals: false,
    getContext: () => ({
      activeSessions: sessions.size,
      activeTurns,
      provider: mainProviderFamily,
      model: mainSelection.model,
      deadProviders: [...liveDeadProviders()],
    }),
    getRecentEvents: () => eventRing.snapshot(),
    emit: (notice) =>
      process.stdout.write(
        JSON.stringify({ type: "daemon_crash", kind: notice.kind, message: notice.message, logFile: notice.logFile }) + "\n",
      ),
  });

  // Boot sweep. Anything still "running" from before this process started
  // belongs to a host that no longer exists — usually one that crashed, since
  // the clean-shutdown path suspends its own work. Those are the jobs that kept
  // relaunching a game across restarts: every new host found them already
  // running and left them alone. They stop here, resumable, and the UI is told.
  void (async () => {
    try {
      const abandoned = await live.shellRegistry.suspendAbandoned({
        before: hostStartedAt,
        reason: "left running by a previous Ares",
      });
      if (abandoned.length > 0) {
        tagEmit(undefined, {
          type: "background_suspended",
          reason: "left running by a previous Ares",
          count: abandoned.length,
          jobs: abandoned.map((job) => ({ id: job.id, description: job.description, command: job.command, resumable: job.resumable === true })),
        });
      }
    } catch {
      // A boot must never fail on cleanup.
    }
  })();

  // ─── Heap watch: the crash that could never leave a note ──────────────────
  //
  // `The Garrison went down (exit code 134)` is V8 aborting on the heap limit.
  // That abort does NOT run uncaughtException, so the crash handler above never
  // fires and ~/.ares/crashes stays empty for the one crash we most need a
  // record of. And the slowdown people describe BEFORE it ("the more I use it
  // the slower it gets") is the GC thrashing against a ceiling nobody measured.
  //
  // So we measure it ourselves, from the inside, while the process is still
  // alive enough to act: say so on the way up, shed idle sessions at the top,
  // and write the artifact the abort itself never could.
  const heapGuard = new HeapGuard({
    elevatedRatio: Number(process.env.ARES_HEAP_WARN_RATIO) || 0.72,
    criticalRatio: Number(process.env.ARES_HEAP_CRITICAL_RATIO) || 0.86,
  });
  {
    const heapWatch = setInterval(() => {
      try {
        const verdict = heapGuard.observe(readHeapSample(), Date.now());
        let relief: { evicted: number; residentSessions: number } | undefined;
        if (verdict.shouldRelieve) {
          relief = { evicted: evictIdleSessions("heap-pressure"), residentSessions: sessions.size };
          // The last chance to leave a diagnosable trail. An abort a few
          // seconds from now writes nothing at all.
          writeCrashLogSync(live.context.home, {
            at: new Date().toISOString(),
            kind: "manual",
            process: "daemon",
            message: `heap pressure ${Math.round(verdict.ratio * 100)}% (${verdict.usedMb}MB / ${verdict.limitMb}MB)`,
            context: {
              reason: "heap-critical",
              ...verdict,
              ...relief,
              activeTurns,
              sessionIds: [...sessions.keys()],
            },
            recentEvents: eventRing.snapshot(),
          });
        }
        if (verdict.shouldReport) {
          tagEmit(undefined, {
            type: "daemon_memory_pressure",
            pressure: verdict.pressure,
            usedMb: verdict.usedMb,
            limitMb: verdict.limitMb,
            percent: Math.round(verdict.ratio * 100),
            residentSessions: sessions.size,
            ...(relief ? { evictedSessions: relief.evicted } : {}),
          });
        }
      } catch {
        // A diagnostic must never be the thing that kills the process.
      }
    }, Math.max(5_000, Number(process.env.ARES_HEAP_WATCH_MS) || 15_000));
    heapWatch.unref?.();
  }

  // Routine hygiene at a much lower frequency than the heap watch: a session
  // nobody has touched in a while is a full resident transcript (plus its tool
  // surfaces, verifier and agent runtime) held for nothing.
  {
    const idleSweep = setInterval(() => {
      try {
        evictIdleSessions("idle");
      } catch {
        // best-effort
      }
    }, 60_000);
    idleSweep.unref?.();
  }

  // ─── Deep dreaming on the DESKTOP path ───────────────────────────────────
  // The dream/reflection cadence lived only in `ares garrison`, which desktop
  // users never run — so MEMORY.md promotion, memory synthesis, and SOUL-rule
  // curation simply never happened for them (the owner's own index sat frozen
  // for 12 days holding two garbage entries while the living store grew
  // unconsolidated filler). The daemon now dreams too: at most once per
  // interval, only while no turn is active, lock-guarded so a concurrently
  // running garrison can't consolidate the same store.
  {
    const DREAM_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
    const dreamMarker = path.join(aresAgentHome(), "mind", ".last-deep-dream");
    const maybeDream = async () => {
      try {
        if ([primaryEntry, ...sessions.values()].some((entry) => entry.turnActive)) return;
        const last = await stat(dreamMarker).then((s) => s.mtimeMs).catch(() => 0);
        if (Date.now() - last < DREAM_MIN_INTERVAL_MS) return;
        const config = await loadAgentConfig(aresAgentHome());
        if (!config.dreaming.enabled) return;
        // Claim the slot BEFORE the run: a dream that crashes must not retry
        // hot every hour — it gets its next chance after the full interval.
        await mkdir(path.dirname(dreamMarker), { recursive: true });
        await writeFile(dreamMarker, new Date().toISOString() + "\n", "utf8");
        await withConsolidationLock(mindPaths(aresAgentHome()).memoryFile, () =>
          runDeepDream({ home: aresAgentHome(), workspace: live.context.workspace, config }),
        );
      } catch {
        // dreaming is maintenance — it must never touch the serving path
      }
    };
    const dreamTick = setInterval(() => void maybeDream(), 60 * 60 * 1000);
    dreamTick.unref?.();
    // One delayed check after boot so a machine that is only on during the day
    // (and therefore never crosses a 3am cron) still dreams regularly.
    const bootDream = setTimeout(() => void maybeDream(), 5 * 60 * 1000);
    bootDream.unref?.();
  }

  // ─── Consciousness: the always-on local watcher ──────────────────────────
  const consciousnessWatch = new ConsciousnessWatch({
    capture: () => captureScreen(),
    describe: (imagePath) => describeImage(live.context.home, imagePath),
    // Phrase a notable observation into one dry remark via the chat model. The
    // model gets final veto (returns NOTHING → the watcher stays silent).
    phrase: async (observation) => {
      // Ground STRICTLY in the current observation. No recent-context narrative —
      // that's what produced nonsense like "still working three distractions ago".
      if (/\b(unclear|uncertain|not sure|can't tell|cannot tell)\b/i.test(observation)) return null;
      try {
        const said = await sideQuery({
          provider: mainSelection.provider,
          model: mainSelection.model,
          system: WATCHER_VOICE_PROMPT,
          user:
            `This is what is on the user's screen RIGHT NOW (a literal description):\n"${observation}"\n\n` +
            `If there is something genuinely worth one calm remark, say it in ONE short sentence grounded ONLY in that description. ` +
            `Invent nothing — no past events, no "earlier", no continuity, nothing not stated above. ` +
            `If nothing is clearly worth saying, output exactly: NOTHING`,
          maxOutputTokens: 50,
        });
        const trimmed = said.trim().replace(/^["']|["']$/g, "");
        return !trimmed || /^nothing\b/i.test(trimmed) ? null : trimmed;
      } catch {
        return null; // phrasing failed — stay silent rather than blurt raw text
      }
    },
    emit: (event) => {
      process.stdout.write(JSON.stringify(event) + "\n");
      // Feed every observation into the peripheral-awareness buffer so the chat
      // agent has a SMALL, bounded sense of what the watcher sees (recordObservation
      // itself drops idle noise and caps the buffer — it never burns context).
      if (event.type === "consciousness_observation" && typeof event.observation === "string") {
        recordConsciousnessObservation({
          observation: event.observation,
          comment: typeof event.comment === "string" ? event.comment : null,
          at: typeof event.at === "number" ? event.at : Date.now(),
        });
      }
      // When the Watch decides to speak, surface it PROACTIVELY IN THE CHAT —
      // not just the settings panel. This is the whole point of the watcher.
      if (event.type === "consciousness_observation" && event.spoke === true && typeof event.comment === "string") {
        process.stdout.write(JSON.stringify({ type: "consciousness_say", text: event.comment }) + "\n");
      }
    },
    remember: (text) => {
      // Durable, dependency-free log of what the watcher chose to say — the
      // seed of "it remembers what it's been watching". Ensure the home exists
      // first so a fresh machine doesn't silently drop every observation.
      void mkdir(live.context.home, { recursive: true })
        .then(() =>
          appendFile(path.join(live.context.home, "consciousness-observations.jsonl"), JSON.stringify({ at: Date.now(), text }) + "\n"),
        )
        .catch(() => {});
    },
    enabled: () => true, // started/stopped explicitly; the gate is start/stop
    log: (line) => process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "consciousness", line } }) + "\n"),
  });
  const startConsciousnessWatch = (): void => consciousnessWatch.start();
  const stopConsciousnessWatch = (): void => consciousnessWatch.stop();
  // Resume the watch across restarts when the owner left Consciousness awake.
  void loadUiSettings()
    .then((s) => {
      if (s.consciousnessEnabled === true) startConsciousnessWatch();
    })
    .catch(() => {});

  // After-action reflection trigger: when a turn lands a NEW commit, summarize it
  // into the war map. Seed with the current HEAD so existing history isn't
  // re-reflected; reflectOnRun dedupes by SHA so a re-fire is a no-op. Disable
  // with ARES_REFLECT=0. Entirely best-effort — it never touches the turn.
  let lastReflectedSha = (await gatherGitRunFacts(live.context.workspace).catch(() => null))?.sha;
  const reflectAfterTurn = async (goal: string): Promise<void> => {
    if (process.env.ARES_REFLECT === "0") return;
    const facts = await gatherGitRunFacts(live.context.workspace).catch(() => null);
    if (!facts || facts.sha === lastReflectedSha) return; // no new commit this turn
    lastReflectedSha = facts.sha;
    const projectId = await detectWorkspaceProjectId(live.context.workspace).catch(() => undefined);
    const out = await reflectOnRun(
      {
        workspace: live.context.workspace,
        projectId,
        task: facts.subject || goal.slice(0, 120),
        result: "success",
        summary: facts.subject || `commit ${facts.sha.slice(0, 8)}`,
        commits: [facts.sha.slice(0, 10)],
        changedFiles: facts.changedFiles,
        sourcePointers: [facts.sha],
      },
      live.context.home,
    ).catch(() => null);
    if (out?.recorded) {
      tagEmit(undefined, { type: "lifecycle", event: { kind: "after_action", commit: facts.sha.slice(0, 10), task: facts.subject } });
    }
  };

  // Conversation reflection: every Nth completed turn, distill durable facts
  // (preferences, personal facts, decisions, relationships) from the recent chat
  // and write them to Living Memory once, deduped — so Ares learns from TALKING,
  // not just from commits, without ever re-reading the transcript. Token-smart:
  // a few short facts in, recalled compactly later. Best-effort; never blocks.
  const REFLECT_EVERY = Math.max(1, Number(process.env.ARES_REFLECT_EVERY) || 3);
  const convReflectTurns = new Map<string, number>();
  const reflectConversationAfterTurn = async (entry: DaemonEntry, sid: string): Promise<void> => {
    if (process.env.ARES_REFLECT === "0") return;
    const n = (convReflectTurns.get(sid) ?? 0) + 1;
    convReflectTurns.set(sid, n);
    if (n % REFLECT_EVERY !== 0) return; // throttle the side-call
    const turns = entry.live.session
      .history()
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.content.some((b) => b.type === "tool_result" || b.type === "tool_use"))
      .slice(-(2 * REFLECT_EVERY + 4))
      .map((m) => ({ role: m.role, text: messageText(m) }))
      .filter((t) => t.text.trim().length > 0 && !t.text.startsWith("(System:"));
    if (turns.length < 2) return;
    const digest = buildConversationDigest(turns);
    if (digest.length < 40) return;
    const sel = entry.live.selection;
    let facts: DurableFact[];
    try {
      facts = await sideQueryJson<DurableFact[]>({
        provider: sel.provider,
        model: sel.model,
        system: CONVERSATION_REFLECT_SYSTEM,
        user: digest,
        schemaHint: DURABLE_FACTS_SCHEMA_HINT,
        maxOutputTokens: 600,
      });
    } catch {
      return; // distillation failed — nothing learned this pass, no harm
    }
    if (!Array.isArray(facts) || facts.length === 0) return;
    try {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      const res = await mergeDurableFacts(store, facts);
      if (res.added > 0) {
        tagEmit(undefined, { type: "lifecycle", event: { kind: "reflected", added: res.added, facts: res.addedFacts.slice(0, 3) } });
      }
    } catch {
      // memory write is best-effort
    }
  };

  /** Map a persisted session-meta provider NAME onto the flag vocabulary
   *  selectProvider understands (same normalization as providerFamilyForSelection). */
  const providerFlagForMetaName = (name: string): string => {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("openai")) return "openai";
    if (normalized.startsWith("moa")) return "moa";
    if (normalized.startsWith("ollama")) return "ollama";
    if (normalized.startsWith("mock")) return "mock";
    return normalized;
  };

  const resolveEntry = async (sessionId: string | undefined): Promise<DaemonEntry> => {
    const sid = sessionId || DEFAULT_SID;
    if (sid === DEFAULT_SID) {
      primaryEntry.lastActiveAt = Date.now();
      return primaryEntry;
    }
    const existing = sessions.get(sid);
    if (existing) {
      // Every command for a session comes through here, so this is the one
      // place idleness has to be marked.
      existing.lastActiveAt = Date.now();
      return existing;
    }
    // A RESUMED card must come back on ITS OWN saved provider+model pair. The
    // daemon's main lane is a moving target (failover and model switches mutate
    // it), and pairing main's provider with another session's model built
    // Franken-selections — a deepseek-wire client asked to run gpt-5.6-sol
    // 400'd the same recovered input on four consecutive boots. Only a brand
    // new card (no snapshot on disk) inherits the daemon's provider.
    let saved = false;
    let savedProvider: { name: string; model: string } | undefined;
    try {
      const peek = await loadSessionSnapshot(live.context.workspace, sid, { maxMessages: 1 });
      saved = true;
      if (peek.meta?.provider?.name && peek.meta.provider.model) {
        savedProvider = { name: peek.meta.provider.name, model: peek.meta.provider.model };
      }
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
    }
    const selection = await selectProvider(
      savedProvider
        ? new Map([
            ["provider", providerFlagForMetaName(savedProvider.name)],
            ["model", savedProvider.model],
          ])
        : new Map([
            ["provider", mainProviderFamily],
            ["model", mainSelection.model],
          ]),
    );
    const fresh = await createSessionWithSelection(
      args,
      selection,
      saved ? sid : undefined,
      requestPermission,
      {
        startAgentRuntime: false,
        sessionId: saved ? undefined : sid,
        detachedStartupRecovery: false,
      },
    );
    const entry: DaemonEntry = {
      live: fresh,
      turnActive: false,
      cancelRequested: false,
      pendingSteerInputIds: new Set(),
      pendingSteerTasks: new Map(),
      steerAdmissionTail: Promise.resolve(),
      deferredSteers: new Map(),
      settledSteerInputIds: new Set(),
      preparingSteers: new Map(),
      steeringPhase: "idle",
      activeToolIds: new Set(),
      startupRecoveryQueue: [],
      startupRecoveryPrepared: false,
      startupRecoveryPreparing: false,
      startupRecoveryCancelRequested: false,
      personaGate: newPersonaGate(),
      lastActiveAt: Date.now(),
    };
    sessions.set(sid, entry);
    // Opening one more session is the moment to check we are not hoarding the
    // last twenty — before the new transcript is loaded on top of them.
    evictIdleSessions("idle");
    tagEmit(sid, { type: "session_opened", model: fresh.selection.model, provider: fresh.selection.provider.name });
    await prepareDaemonStartupRecovery(entry, sid);
    return entry;
  };

  const startupRecoveryGoal = (payload: unknown): string => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return "Continue the pending request.";
    }
    const value = payload as { content?: unknown; text?: unknown };
    if (typeof value.text === "string" && value.text.trim()) return value.text.trim();
    if (!Array.isArray(value.content)) return "Continue the pending request.";
    const text = value.content
      .flatMap((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) return [];
        const candidate = block as { type?: unknown; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string"
          ? [candidate.text]
          : [];
      })
      .join("\n")
      .trim();
    return text || "Continue the pending request with its attached content.";
  };

  // Object identity distinguishes daemon-scheduled recovery work from an
  // indistinguishable same-ID wire replay without expanding the public NDJSON
  // protocol (or trusting a client-supplied internal marker).
  const internalStartupRecoveryCommands = new WeakSet<object>();
  const suppressedInternalRecoveryReplays = new Set<string>();
  const enqueueStartupRecoveryCommand = (command: DaemonInputCommand): void => {
    internalStartupRecoveryCommands.add(command);
    commands.enqueue(command);
  };

  const scheduleNextStartupRecovery = async (entry: DaemonEntry): Promise<boolean> => {
    if (entry.turnActive || entry.startupRecoveryPreparing || entry.startupRecoveryInputId) return false;
    const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
    while (true) {
      const next = entry.startupRecoveryQueue.shift();
      if (!next) return false;
      const canonical = kernel.getInput(next.inputId);
      if (canonical?.state === "consumed" || canonical?.state === "cancelled") {
        // The recovered owner can consume attached steers in its own provider
        // generation. A stale startup snapshot must never turn those terminal
        // rows into synthetic follow-up turns (or re-run mutable preparation).
        tagEmit(next.sessionId, {
          type: "input_replayed",
          inputId: next.inputId,
          settled: true,
          delivery: canonical.delivery,
          status: canonical.state,
        });
        continue;
      }
      entry.startupRecoveryInputId = next.inputId;
      enqueueStartupRecoveryCommand({
        type: "send",
        goal: next.goal,
        sessionId: next.sessionId,
        inputId: next.inputId,
      });
      return true;
    }
  };

  const prepareDaemonStartupRecovery = async (
    entry: DaemonEntry,
    sessionId: string | undefined,
  ): Promise<void> => {
    if (entry.startupRecoveryPrepared) return;
    entry.startupRecoveryPrepared = true;
    // Preserve admission order. A queue owner followed by steers is one crashed
    // generation, not independent turns: Session's explicit recovery admission
    // lets that owner reclaim the head and drain its attached steer inbox.
    const discovered = entry.live.session.pendingHostManagedStartupRecovery();
    if (discovered.length === 0) return;
    const [first, ...rest] = discovered.map((input) => ({
      inputId: input.id,
      goal: startupRecoveryGoal(input.payload),
      sessionId,
    }));
    entry.startupRecoveryInputId = first.inputId;
    entry.startupRecoveryQueue.push(...rest);
    entry.startupRecoveryPreparing = true;
    tagEmit(sessionId, {
      type: "startup_recovery_preparing",
      inputId: first.inputId,
      inputIds: discovered.map((input) => input.id),
      count: discovered.length,
    });
    try {
      await entry.live.session.prepareHostManagedStartupRecovery();
      if (entry.startupRecoveryCancelRequested) {
        entry.live.session.interrupt(first.inputId);
      }
      entry.startupRecoveryPreparing = false;
      tagEmit(sessionId, {
        type: "startup_recovery_queued",
        inputIds: discovered.map((input) => input.id),
        count: discovered.length,
      });
      enqueueStartupRecoveryCommand({ type: "send", goal: first.goal, sessionId, inputId: first.inputId });
    } catch (error) {
      entry.startupRecoveryPreparing = false;
      entry.startupRecoveryInputId = undefined;
      entry.startupRecoveryQueue.length = 0;
      entry.startupRecoveryCancelRequested = false;
      tagEmit(sessionId, {
        type: "startup_recovery_failed",
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  };

  const trackSteeringBoundary = (entry: DaemonEntry, event: { type: string; id?: string }): void => {
    if (event.type === "turn_start") {
      entry.steeringPhase = "boundary";
    } else if (event.type === "provider_attempt_started") {
      entry.steeringPhase = "generation";
    } else if (event.type === "provider_attempt_superseded") {
      entry.steeringPhase = "boundary";
    } else if (event.type === "tool_start") {
      if (event.id) entry.activeToolIds.add(event.id);
      entry.steeringPhase = "action";
    } else if (event.type === "tool_end" || event.type === "tool_error") {
      if (event.id) entry.activeToolIds.delete(event.id);
      if (entry.activeToolIds.size === 0) entry.steeringPhase = "boundary";
    } else if (event.type === "compaction") {
      entry.steeringPhase = "boundary";
    } else if (event.type === "turn_end") {
      entry.steeringPhase = "settling";
    }
  };

  const announceSteerTerminal = (
    entry: DaemonEntry,
    sessionId: string | undefined,
    inputId: string,
    state: "consumed" | "cancelled",
  ): boolean => {
    if (entry.settledSteerInputIds.has(inputId)) return false;
    entry.settledSteerInputIds.add(inputId);
    while (entry.settledSteerInputIds.size > 512) {
      const oldest = entry.settledSteerInputIds.values().next().value as string | undefined;
      if (!oldest) break;
      entry.settledSteerInputIds.delete(oldest);
    }
    tagEmit(sessionId, {
      type: state === "consumed" ? "steer_applied" : "steer_cancelled",
      inputId,
      status: state,
    });
    return true;
  };

  const monitorDeferredSteer = (
    entry: DaemonEntry,
    sessionId: string | undefined,
    inputId: string,
  ): void => {
    void (async () => {
      const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
      // Exponential backoff, not a flat 20ms: this loop runs for the WHOLE
      // remaining turn (a 10-minute agentic turn = ~30k synchronous SQLite
      // reads per deferred steer — measurable fan spin). The first second
      // stays snappy; after that 500ms is plenty, since the owner settlement
      // drain re-checks every state synchronously anyway.
      let pollMs = 20;
      while (entry.turnActive && entry.deferredSteers.has(inputId)) {
        const state = kernel.getInput(inputId)?.state;
        if (state === "consumed" || state === "cancelled") {
          entry.deferredSteers.delete(inputId);
          announceSteerTerminal(entry, sessionId, inputId, state);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        pollMs = Math.min(500, Math.round(pollMs * 1.5));
      }
    })().catch((error) => {
      tagEmit(sessionId, {
        type: "steer_epilogue_warning",
        inputId,
        status: "admitted",
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const admitSteer = (
    entry: DaemonEntry,
    sessionId: string | undefined,
    text: string,
    inputId: string,
  ): void => {
    if (entry.cancelRequested) {
      tagEmit(sessionId, {
        type: "input_rejected",
        inputId,
        reason: "turn_cancelling",
        retryable: true,
      });
      return;
    }
    if (
      entry.pendingSteerInputIds.has(inputId) ||
      entry.deferredSteers.has(inputId) ||
      entry.settledSteerInputIds.has(inputId)
    ) {
      tagEmit(sessionId, {
        type: "input_replayed",
        inputId,
        settled: entry.settledSteerInputIds.has(inputId),
        delivery: "steer",
      });
      return;
    }
    const submittedDuring = entry.steeringPhase;
    entry.pendingSteerInputIds.add(inputId);
    tagEmit(sessionId, {
      type: "steer_submitted",
      inputId,
      steerPhase: submittedDuring,
    });
    // Each caller reserves an admission ticket synchronously. It waits for the
    // prior steer to finish attachment parsing + SQLite routing, but not for that
    // prior steer to be consumed by the owner turn.
    const previousAdmission = entry.steerAdmissionTail;
    let releaseAdmission!: () => void;
    const admissionDone = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    entry.steerAdmissionTail = previousAdmission.catch(() => undefined).then(() => admissionDone);
    let admissionReleased = false;
    const releaseAdmissionOnce = (): void => {
      if (admissionReleased) return;
      admissionReleased = true;
      releaseAdmission();
    };
    let terminalAnnounced = false;
    const task = (async () => {
      await previousAdmission.catch(() => undefined);
      let admissionAnnounced = false;
      // Parse attachments before Session admission. This makes the canonical
      // SQLite payload identical to an ordinary owner turn: text plus structured
      // image blocks, never an opaque data URL hidden inside one text block.
      const steerContent = await contentFromUserInput(text, entry.live.context.workspace);
      // `steer_routed` is emitted after input_admitted has crossed its audit
      // flush and QueryEngine has returned the actual live disposition. Do not
      // infer routing from the daemon phase sampled before that async boundary.
      const unsubscribe = entry.live.session.observeEvents((event) => {
        if (event.type !== "steer_routed" || event.inputId !== inputId || admissionAnnounced) return;
        admissionAnnounced = true;
        const routed = event.disposition === "provider_preempting"
          ? { steerPhase: "generation" as const, delivery: "interrupting_generation" as const }
          : event.disposition === "effect_settling"
            ? { steerPhase: "action" as const, delivery: "waiting_for_action" as const }
            : event.disposition === "idle"
              ? { steerPhase: "idle" as const, delivery: "next_boundary" as const }
              : { steerPhase: "boundary" as const, delivery: "next_boundary" as const };
        tagEmit(sessionId, {
          type: "steer_admitted",
          inputId,
          disposition: event.disposition,
          ...routed,
        });
        // This is the post-flush routing boundary. The next steer may now parse
        // and admit even while this one independently waits to be consumed.
        releaseAdmissionOnce();
      });
      try {
        const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
        // Admission-only: this sender never acquires the owner's FIFO lease and
        // therefore can never execute an inherited turn outside daemon routing,
        // vision, persona, recall, failover, and journal preparation.
        for await (const _event of entry.live.session.sendContent(
          steerContent,
          { inputId, delivery: "steer", admitOnlySteer: true },
        )) {
          // Existing terminal idempotency records can yield a synthetic boundary;
          // canonical SQLite state below is the exact acknowledgement authority.
        }
        releaseAdmissionOnce();
        const canonical = kernel.getInput(inputId);
        if (canonical?.state === "consumed" || canonical?.state === "cancelled") {
          terminalAnnounced = true;
          announceSteerTerminal(entry, sessionId, inputId, canonical.state);
        } else if (canonical?.state === "admitted" || canonical?.state === "claimed") {
          entry.deferredSteers.set(inputId, { text, sessionId });
          monitorDeferredSteer(entry, sessionId, inputId);
        } else {
          tagEmit(sessionId, { type: "steer_settled", inputId, status: canonical?.state ?? "unknown" });
        }
      } finally {
        unsubscribe();
      }
    })().catch(async (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      let canonical: ReturnType<Awaited<ReturnType<typeof openWorkspaceSessionKernel>>["getInput"]> | undefined;
      try {
        const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
        canonical = kernel.getInput(inputId) ?? undefined;
      } catch {
        // The original error is the useful diagnostic. A failed read-back means
        // there is no canonical evidence with which to override rejection.
      }

      if (terminalAnnounced || canonical) {
        if (!terminalAnnounced && (canonical?.state === "consumed" || canonical?.state === "cancelled")) {
          terminalAnnounced = true;
          announceSteerTerminal(entry, sessionId, inputId, canonical.state);
        } else if (canonical?.state === "admitted" || canonical?.state === "claimed") {
          entry.deferredSteers.set(inputId, { text, sessionId });
          monitorDeferredSteer(entry, sessionId, inputId);
        }
        // Admission/consumption is canonical. A later audit, forwarding, or
        // epilogue failure must never restore the same correction as a draft.
        tagEmit(sessionId, {
          type: "steer_epilogue_warning",
          error: detail,
          inputId,
          status: canonical?.state ?? "terminal",
          retryable: canonical?.state === "admitted" || canonical?.state === "claimed",
        });
        return;
      }

      tagEmit(sessionId, {
        type: "steer_rejected",
        error: detail,
        reason: "admission_failed",
        retryable: true,
        inputId,
      });
    }).finally(() => {
      releaseAdmissionOnce();
      entry.pendingSteerInputIds.delete(inputId);
      entry.pendingSteerTasks.delete(inputId);
    });
    entry.pendingSteerTasks.set(inputId, task);
  };

  const bufferPreparingSteer = (
    entry: DaemonEntry,
    sessionId: string | undefined,
    text: string,
    inputId: string,
  ): void => {
    if (
      entry.preparingSteers.has(inputId) ||
      entry.pendingSteerInputIds.has(inputId) ||
      entry.deferredSteers.has(inputId) ||
      entry.settledSteerInputIds.has(inputId)
    ) {
      tagEmit(sessionId, { type: "input_replayed", inputId, settled: entry.settledSteerInputIds.has(inputId), delivery: "steer" });
      return;
    }
    entry.preparingSteers.set(inputId, { text, sessionId });
    tagEmit(sessionId, {
      type: "steer_buffered",
      inputId,
      steerPhase: "preparing",
      delivery: "waiting_for_owner_admission",
    });
  };

  const flushPreparingSteers = (entry: DaemonEntry): void => {
    const buffered = [...entry.preparingSteers.entries()];
    entry.preparingSteers.clear();
    for (const [inputId, steer] of buffered) {
      if (entry.cancelRequested) {
        tagEmit(steer.sessionId, {
          type: "steer_cancelled",
          inputId,
          status: "cancelled",
        });
      } else {
        admitSteer(entry, steer.sessionId, steer.text, inputId);
      }
    }
  };

  commands.onInterrupt = (command) => {
    const entry = command.sessionId ? sessions.get(command.sessionId) : primaryEntry;
    // A terminal-fence steer becomes the next ordinary turn. The command is
    // queued out-of-band after its predecessor releases, so there is a real
    // (usually sub-millisecond) interval in which no turn is active. Keep exact
    // ownership across that handoff: Stop cancels the durable successor instead
    // of reporting idle and allowing it to start behind the user's back.
    if (entry?.successorHandoff && !entry.turnActive) {
      const handoff = entry.successorHandoff;
      if (handoff.cancelRequested) {
        tagEmit(command.sessionId, {
          type: "interrupt_pending",
          inputId: handoff.inputId,
          phase: "successor_handoff",
        });
        return;
      }
      handoff.cancelRequested = true;
      const accepted = entry.live.session.interrupt(handoff.inputId);
      if (accepted) {
        announceSteerTerminal(entry, handoff.sessionId, handoff.inputId, "cancelled");
      }
      tagEmit(command.sessionId, {
        type: accepted ? "interrupt_requested" : "interrupt_pending",
        inputId: handoff.inputId,
        phase: "successor_handoff",
      });
      return;
    }
    // Recovery owns this exact input from discovery until the ordinary send
    // wrapper takes over. Keep Stop bound across the tiny queued hand-off too;
    // otherwise a click after startup_recovery_queued but before turnActive
    // could be reported as idle and the recovered request would still run.
    if (entry?.startupRecoveryInputId && !entry.turnActive) {
      if (entry.startupRecoveryCancelRequested) {
        tagEmit(command.sessionId, {
          type: "interrupt_pending",
          inputId: entry.startupRecoveryInputId,
        });
        return;
      }
      entry.startupRecoveryCancelRequested = true;
      // During lease takeover the old generation still owns the claim, so the
      // recovery continuation applies this intent after fencing. Once takeover
      // has completed, cancel the admitted row immediately before dequeue.
      const accepted = entry.startupRecoveryPreparing
        ? true
        : entry.live.session.interrupt(entry.startupRecoveryInputId);
      tagEmit(command.sessionId, {
        type: accepted ? "interrupt_requested" : "interrupt_pending",
        inputId: entry.startupRecoveryInputId,
        phase: "startup_recovery",
      });
      return;
    }
    if (!entry || !entry.turnActive || !entry.activeInputId) {
      tagEmit(command.sessionId, { type: "interrupt_idle" });
      return;
    }
    if (entry.cancelRequested) {
      // A Stop that was already accepted but has NOT settled. Synthesising a
      // completion here would be a lie (the tool generator may still be mid
      // side effect), but leaving the owner with no exit is worse: a turn whose
      // subprocess was killed out from under it never unwinds, and the UI sits
      // on "stopping safely" forever with no way out. So: disclose, and after a
      // grace period let a SECOND Stop escalate to a real forced abort.
      // A force is already in flight — don't stack more kills and timers on
      // a triple-click; just restate the pending state.
      if (entry.forceStopRequested) {
        tagEmit(command.sessionId, {
          type: "interrupt_pending",
          inputId: entry.activeInputId,
          stalledMs: Date.now() - (entry.cancelRequestedAt ?? Date.now()),
          forceAvailableInMs: 0,
        });
        return;
      }
      const since = Date.now() - (entry.cancelRequestedAt ?? Date.now());
      if (since >= FORCE_STOP_AFTER_MS) {
        entry.forceStopRequested = true;
        const stalledInputId = entry.activeInputId;
        // onInterrupt is a synchronous callback — the kill runs detached and
        // reports when it lands. This is the honest version of "force": we do
        // not claim the turn ended cleanly, we end the thing holding it and
        // say exactly that.
        void entry.live.shellRegistry
          .killAllForSession(entry.live.session.meta.id)
          .catch(() => 0)
          .then((killed) => {
            entry.live.session.interrupt(stalledInputId);
            tagEmit(command.sessionId, {
              type: "interrupt_forced",
              inputId: stalledInputId,
              killed,
              error:
                `Stop did not settle after ${Math.round(since / 1000)}s, so the turn's running processes were force-killed (${killed}). ` +
                `Any side effect already in flight may be incomplete — check the workspace before continuing.`,
            });
            // The kill usually lets the generator unwind and settle normally.
            // When it does NOT (an await with no subprocess behind it — a hung
            // verifier drain, a dead promise), the entry stayed wedged forever
            // and only an app restart freed it. Grace-then-release: if the turn
            // is still holding the entry, declare it a zombie so its eventual
            // unwind is a no-op, release the entry, and evict the live session
            // so the next send rehydrates from disk under lease takeover.
            const releaseTimer = setTimeout(() => {
              if (!entry.turnActive || entry.activeInputId !== stalledInputId) return;
              (entry.zombieTurnInputIds ??= new Set()).add(stalledInputId);
              entry.turnActive = false;
              entry.activeInputId = undefined;
              entry.cancelRequested = false;
              entry.cancelRequestedAt = undefined;
              entry.forceStopRequested = false;
              entry.steeringPhase = "idle";
              entry.activeToolIds.clear();
              activeTurns--;
              tagEmit(command.sessionId, { type: "interrupt_settled", inputId: stalledInputId });
              emitBackgroundJobs(command.sessionId, entry);
              tagEmit(command.sessionId, { type: "turn_settled", inputId: stalledInputId, continuing: false });
              // The zombie generator may still hold the session's kernel run
              // lease. A rehydrated session takes the lease over the same way
              // startup recovery does after a crash.
              if (entry !== primaryEntry) {
                for (const [mappedSid, mapped] of sessions) {
                  if (mapped === entry) {
                    evictSession(mappedSid, entry, "force-stop", Date.now() - (entry.turnStartedAt ?? Date.now()));
                    break;
                  }
                }
              } else {
                // The primary cannot be evicted — but keeping the WEDGED live
                // session would leave its run lease held, so the next send
                // blocked forever anyway (the exact restart-to-recover loop
                // this path exists to end). Rebuild the live session from disk
                // under the same id, the same way eviction + rehydrate does.
                const wedged = entry.live;
                void (async () => {
                  try {
                    const selection = await selectProvider(new Map([
                      ["provider", providerFamilyForSelection(wedged.selection)],
                      ["model", wedged.selection.model],
                    ]));
                    const fresh = await createSessionWithSelection(
                      args,
                      selection,
                      wedged.session.meta.id,
                      requestPermission,
                      { startAgentRuntime: false, detachedStartupRecovery: false },
                    );
                    entry.live = fresh;
                    void disposeLiveSession(wedged).catch(() => undefined);
                  } catch (rebuildErr) {
                    console.error(`primary force-stop rebuild failed: ${rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr)}`);
                  }
                })();
              }
            }, FORCE_STOP_RELEASE_GRACE_MS);
            releaseTimer.unref?.();
          });
        return;
      }
      tagEmit(command.sessionId, {
        type: "interrupt_pending",
        inputId: entry.activeInputId,
        stalledMs: since,
        // Tell the surface when a second Stop becomes a force-stop, so it can
        // offer that instead of spinning silently.
        forceAvailableInMs: Math.max(0, FORCE_STOP_AFTER_MS - since),
      });
      return;
    }
    const inputId = entry.activeInputId;
    const accepted = entry.live.session.interrupt(inputId);
    // Even if Session already crossed its terminal boundary, the daemon wrapper
    // can still own routing/post-turn work. Gate fresh sends until finally
    // releases turnActive so they cannot be inferred as late steering.
    entry.cancelRequested = true;
    entry.cancelRequestedAt = Date.now();
    for (const [steerInputId, steer] of entry.preparingSteers) {
      tagEmit(steer.sessionId, {
        type: "steer_cancelled",
        inputId: steerInputId,
        status: "cancelled",
      });
    }
    entry.preparingSteers.clear();
    for (const steerInputId of entry.pendingSteerInputIds) {
      entry.live.session.interrupt(steerInputId);
    }
    for (const [steerInputId, deferred] of entry.deferredSteers) {
      if (!entry.live.session.interrupt(steerInputId)) continue;
      entry.deferredSteers.delete(steerInputId);
      announceSteerTerminal(entry, deferred.sessionId, steerInputId, "cancelled");
    }
    tagEmit(command.sessionId, {
      type: accepted ? "interrupt_requested" : "interrupt_pending",
      inputId,
    });
    // Stop means stop — including the work this turn pushed into the background.
    // A backgrounded launch is still this turn's side effect; leaving it running
    // after the user pressed Stop is how "I cancelled it and it kept going"
    // happens. Scoped to jobs this turn started, so a dev server the user asked
    // for an hour ago is left alone. Detached from the synchronous callback; the
    // suspension announces itself when it lands.
    void suspendBackgroundWork("turn interrupted", [entry], {
      since: entry.turnStartedAt,
      sessionId: command.sessionId,
    }).then((stopped) => {
      if (stopped > 0) emitBackgroundJobs(command.sessionId, entry);
    });
    // Do not synthesize completion on a timer. The Session owns a FIFO run lease
    // and remains busy until the provider/tool generator actually unwinds; a UI
    // timeout must never permit a second turn to overlap an unknown side effect.
  };

  // Apply any persisted Advanced-tab engine knobs (env-backed ones) on boot.
  applyEngineConfigEnv((await loadUiSettings()).engine ?? {});

  // Operator auto-tick: while the daemon idles, durable missions ADVANCE — one
  // worker tick on the ATTENTION-SELECTED active goal per interval (not naive
  // active[0]). This now runs through the SAME OperatorBackgroundLoop that drives
  // garrisonCommand — one autonomy driver, one gate — instead of a hand-rolled
  // setInterval that omitted the pause gate, standing-order materialization, and
  // next-action awareness (the two drivers had already drifted). The stdio JSON
  // bridge transport is unchanged: the loop's events are mirrored to NDJSON below.
  //
  // OPT-IN: ARES_OPERATOR_LOOP=1, OR the owner has queued standing orders (adding a
  // recurring mission IS the opt-in — same widening as the garrison). The live
  // ARES_OPERATOR_AUTOTICK=0 kill switch and a live user turn both park ticks via
  // the pause gate, so the operator_autotick toggle still takes effect next tick.
  const daemonStandingAtStart = await loadStandingOrders(live.context.home).catch(() => [] as StandingOrder[]);
  // Watchers widen the opt-in identically: adding a condition to watch IS the opt-in.
  const daemonWatchersAtStart = await loadWatchers(live.context.home).catch(() => []);
  // Build the loop whenever the opt-in holds (LOOP=1 or standing orders queued).
  // Do NOT gate construction on the ARES_OPERATOR_AUTOTICK kill switch: it's a
  // LIVE toggle handled by the paused() gate below, so a daemon booted with
  // autotick off (incl. the persisted UI setting) can still resume ticks when the
  // user flips it back on — without a restart. The loop ticks are cheap no-ops
  // while parked, exactly as the old per-tick-gated setInterval was.
  const autotickLoop =
    !(process.env.ARES_OPERATOR_LOOP === "1" || daemonStandingAtStart.length > 0 || daemonWatchersAtStart.length > 0)
      ? null
      : new OperatorBackgroundLoop(
          {
            home: live.context.home,
            workspace: live.context.workspace,
            dispatcher: new QueryEngineDispatcher({
              provider: live.selection.provider,
              model: live.selection.model,
              workspace: live.context.workspace,
              tools: live.tools,
              systemPrompt: buildSystemPrompt("workspace-write", live.context),
              sessionKernel: await openWorkspaceSessionKernel(live.context.workspace),
              telemetryDir: path.join(live.context.home, "telemetry"),
              sessionRegistryHome: live.context.home,
              // UNATTENDED gate: the owner isn't watching a background mission tick,
              // so anything that needs a human (payment, credential, send-mail,
              // destructive shell, computer-use) is hard-denied; only safe local
              // work flows.
              requestPermission: async (request) => {
                const gate = gateToolPermission(request, { attended: false });
                return gate.kind === "allow" ? "allow_once" : "deny";
              },
            }),
          },
          {
            everyMs: operatorTickIntervalMs(),
            // Park a tick whenever a live user turn is in flight (never steal the
            // foreground), the kill switch is flipped (live operator_autotick
            // toggle), or a remote /pause is set — mirrors the garrison's gates.
            paused: async () =>
              activeTurns > 0 ||
              process.env.ARES_OPERATOR_AUTOTICK === "0" ||
              (await isOperatorPaused(live.context.home).catch(() => false)),
            // Materialize due standing orders into goals so the same tick runs them
            // (the inline setInterval omitted this — recurring missions never fired).
            beforeTick: async () => {
              const { fired } = await materializeDueStandingOrders(live.context.home).catch(() => ({ goals: [], fired: [] as StandingOrder[] }));
              for (const order of fired) {
                process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "standing_order_fired", id: order.id, statement: order.statement.slice(0, 120) } }) + "\n");
              }
            },
            // Idle awareness: surface (never auto-run) the active project's next moves.
            nextActions: async () => {
              const projectId = await detectWorkspaceProjectId(live.context.workspace).catch(() => undefined);
              const project = projectId ? await loadProjectState(projectId, live.context.home).catch(() => null) : null;
              return project?.nextActions ?? [];
            },
            emit: (event) => {
              // Unified lifecycle shape (matches garrison) PLUS the legacy
              // operator_autotick event for older UI builds that key on it.
              process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "operator", ...event } }) + "\n");
              if (event.type === "operator_tick") {
                process.stdout.write(
                  JSON.stringify({
                    type: "lifecycle",
                    event: { kind: "operator_autotick", goalId: event.goalId, statement: event.summary.slice(0, 120), status: event.status },
                  }) + "\n",
                );
              }
            },
            onError: () => {},
          },
        );
  autotickLoop?.start();
  const readySettings = await loadUiSettings();
  // "Configured" must mean USABLE, not just "pasted into ui.json". A provider is
  // configured if its key is in settings OR in the environment, plus OpenAI via
  // its ChatGPT OAuth session. Otherwise an env-keyed Ollama-Cloud user (the
  // default!) or an OAuth'd OpenAI user wrongly sees "only deepseek configured".
  const readyAuth = await authStatus().catch(() => null);
  // Claude Pro/Max OAuth and the Ares account sign-in are real "ways to think"
  // too: without them here, an OAuth-only or gateway-only user has an all-false
  // keyStatus and the first-run gate re-prompts on every single launch.
  const readyAnthropicOAuth = Boolean(await loadAnthropicTokens().catch(() => null));
  process.stdout.write(
    JSON.stringify({
      type: "daemon_ready",
      sessionId: live.session.meta.id,
      provider: providerFamilyForSelection(live.selection),
      model: live.selection.model,
      reasoningLevel: resolveReasoningLevel(readySettings),
      routingMode: readySettings.routingMode ?? "manual",
      routing: readySettings.routing ?? {},
      engine: readySettings.engine ?? {},
      permissions: { ...DEFAULT_PERMISSIONS, ...(readySettings.permissions ?? {}) },
      keyStatus: {
        anthropic: Boolean(readySettings.anthropicKey || process.env.ANTHROPIC_API_KEY || process.env.ARES_ANTHROPIC_API_KEY || readyAnthropicOAuth),
        openai: Boolean(readyAuth?.configured),
        deepseek: Boolean(readySettings.deepSeekKey || process.env.DEEPSEEK_API_KEY),
        kimi: Boolean(readySettings.kimiKey || process.env.KIMI_API_KEY),
        openrouter: Boolean(readySettings.openRouterKey || process.env.OPENROUTER_API_KEY),
        ollama: Boolean(readySettings.ollamaApiKey || process.env.OLLAMA_API_KEY),
        brave: Boolean(readySettings.braveKey || process.env.ARES_BRAVE_API_KEY),
        ares: Boolean(readySettings.aresGatewayToken),
      },
    }) + "\n",
  );

  // Bridge lifecycle events (Bootstrap, SelfEvolve, capture, recall, dream,
  // skill_crafted, etc.) out as NDJSON so the Tauri shell can render +N
  // score popups and entity-status indicators. These are separate from the
  // per-turn TurnEvent stream — they're agent-evolution telemetry.
  const unsubscribeLifecycle = onLifecycle((event) => {
    if (activeTurns === 0) return; // only stream agent-evolution telemetry during live work
    try {
      process.stdout.write(JSON.stringify({ type: "lifecycle", event }) + "\n");
    } catch {
      // never let lifecycle bridging crash the daemon
    }
  });
  let unsubscribeGatewayMirror: (() => void) | undefined;
  startGatewayMirror(live.context, tagEmit).catch(() => {});

  // Recovery starts only after daemon_ready and every host-level observer is
  // installed. Incoming UI commands are already buffered by the router; the
  // gate in the send handler below places the oldest canonical recovered ID in
  // front of any command that arrived during expired-lease reconciliation.
  await prepareDaemonStartupRecovery(primaryEntry, live.session.meta.id);

  try {
    while (true) {
      const command = await commands.nextCommand();
      if (!command) break;
      if (command.type === "exit") break;
      if (command.type === "reasoning") {
        const level = command.level?.toLowerCase();
        if (!isReasoningLevel(level)) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `reasoning requires level: ${REASONING_LEVELS.join("|")}` }) + "\n");
          continue;
        }
        // ONE handler for all three dispatch sites — validates, sets the dial on
        // EVERY open session (not just the primary, which used to miss spawned
        // chats), persists, and clears any env override so the explicit choice wins.
        const change = await handleReasoningCommand(
          level,
          [...new Set([primaryEntry, ...sessions.values()])].map((e) => e.live),
        );
        process.stdout.write(JSON.stringify({ type: "reasoning_set", level: change.level, clearedEnvOverride: change.clearedEnvOverride }) + "\n");
        continue;
      }
      if (command.type === "routing") {
        // Owner per-lane model assignments. Normalize {provider,model} → {family,model}
        // and persist; the live turn resolves via @ares/core resolveRoute().
        const routing = normalizeRoutingCommand(command.routing);
        await updateUiSettings({ routing });
        process.stdout.write(JSON.stringify({ type: "routing_set", routing }) + "\n");
        continue;
      }
      if (command.type === "routing_mode") {
        const routingMode = command.enabled === true ? "auto" : "manual";
        await updateUiSettings({ routingMode });
        process.stdout.write(JSON.stringify({ type: "routing_mode_set", routingMode }) + "\n");
        continue;
      }
      if (command.type === "persona_style") {
        // The VOICE dial: which persona layer sits above the shared craft core.
        // Separate from persona_adopt (which wears a roster specialist) —
        // this is "how does Ares talk", and it survives restarts because it
        // lives in ui.json like every other owner preference.
        const raw = typeof command.name === "string" ? command.name.trim().toLowerCase() : "";
        const style = raw === "neutral" || raw === "custom" ? raw : "ares";
        const custom = typeof command.body === "string" ? command.body : undefined;
        await updateUiSettings({
          personaStyle: style,
          ...(custom !== undefined ? { personaCustom: custom } : {}),
        });
        process.stdout.write(JSON.stringify({
          type: "persona_style_set",
          style,
          custom: custom ?? null,
        }) + "\n");
        continue;
      }
      if (command.type === "workflow_mode") {
        // The owner's own Plan/Build toggle, per session. Carries ownerIntent,
        // so it supersedes an un-approved plan draft instead of being rejected
        // by the guard that exists to stop the MODEL leaving plan mode.
        const wantPlan = command.mode === "plan";
        const entry = await resolveEntry(command.sessionId);
        const target: PermissionMode = wantPlan
          ? "plan"
          : entry.live.runtime.permissions?.mode === "free"
            ? "bypass"
            : "workspace-write";
        try {
          await transitionPermissionMode(entry.live.runtime, target, { ownerIntent: true });
          tagEmit(command.sessionId, { type: "workflow_mode_set", mode: wantPlan ? "plan" : "build" });
        } catch (error) {
          // Never leave the UI showing a mode the session did not actually take.
          tagEmit(command.sessionId, {
            type: "workflow_mode_set",
            mode: entry.live.runtime.permissionMode === "plan" ? "plan" : "build",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      if (command.type === "set_permissions") {
        // Owner permission posture. Sanitize to known keys/types (never trust the
        // wire), apply LIVE to every open session, keep dangerousBypass in sync
        // (so the path-tool bypass + leash agree with "free"), and persist.
        const incoming = (command.permissions ?? {}) as Partial<PermissionSettings>;
        const permissions: PermissionSettings = {
          mode: incoming.mode === "free" ? "free" : "guarded",
          fileWrite: incoming.fileWrite !== false,
          shell: incoming.shell !== false,
          network: incoming.network !== false,
          sensitive: incoming.sensitive === true,
          fleetsInherit: incoming.fleetsInherit !== false,
        };
        const mode: PermissionMode = permissions.mode === "free" ? "bypass" : "workspace-write";
        live.runtime.permissions = permissions;
        // Global permission posture must not cancel a session's explicit plan
        // workflow. Plan/build is per-session state; only non-plan sessions
        // inherit the new guarded/bypass execution posture.
        if (live.runtime.permissionMode !== "plan") {
          await transitionPermissionMode(live.runtime, mode);
        }
        for (const e of sessions.values()) {
          e.live.runtime.permissions = permissions;
          if (e.live.runtime.permissionMode !== "plan") {
            await transitionPermissionMode(e.live.runtime, mode);
          }
        }
        await updateUiSettings({ permissions, dangerousBypass: permissions.mode === "free" });
        process.stdout.write(JSON.stringify({ type: "permissions_set", permissions }) + "\n");
        continue;
      }
      if (command.type === "consciousness_status") {
        const models = await consciousnessStatus(live.context.home);
        const settings = await loadUiSettings();
        const engine = await engineStatus(live.context.home);
        process.stdout.write(
          JSON.stringify({
            type: "consciousness_status",
            enabled: settings.consciousnessEnabled === true,
            downloading: consciousnessDownloading,
            watching: consciousnessWatch.isRunning(),
            engineStatus: { binaryInstalled: Boolean(engine.binary), available: engine.available },
            models,
          }) + "\n",
        );
        continue;
      }
      if (command.type === "consciousness_disable") {
        await updateUiSettings({ consciousnessEnabled: false });
        consciousnessAbort?.abort();
        stopConsciousnessWatch();
        process.stdout.write(JSON.stringify({ type: "consciousness_set", enabled: false }) + "\n");
        continue;
      }
      if (command.type === "consciousness_killswitch") {
        // Hard stop: blind the eyes and halt the download. The owner's brake.
        consciousnessAbort?.abort();
        stopConsciousnessWatch();
        await updateUiSettings({ consciousnessEnabled: false });
        process.stdout.write(JSON.stringify({ type: "consciousness_killed" }) + "\n");
        continue;
      }
      if (command.type === "consciousness_look_away") {
        // Pause the watch for N seconds (default 5 min) without disabling it.
        const seconds = typeof command.seconds === "number" ? command.seconds : 300;
        consciousnessWatch.pause(Math.max(1, seconds) * 1000);
        process.stdout.write(JSON.stringify({ type: "consciousness_paused", seconds }) + "\n");
        continue;
      }
      if (command.type === "consciousness_resume") {
        consciousnessWatch.resume();
        process.stdout.write(JSON.stringify({ type: "consciousness_resumed" }) + "\n");
        continue;
      }
      if (command.type === "consciousness_enable") {
        await updateUiSettings({ consciousnessEnabled: true });
        process.stdout.write(JSON.stringify({ type: "consciousness_set", enabled: true }) + "\n");
        // Start the watch right away (idempotent). It idles harmlessly until the
        // engine + weights are present — so it's running no matter how the
        // download/enable timing races.
        startConsciousnessWatch();
        // Pull any missing weights. Fire-and-forget so the command loop keeps
        // serving; a guard prevents overlapping downloads.
        if (!consciousnessDownloading) {
          consciousnessDownloading = true;
          consciousnessAbort = new AbortController();
          const ac = consciousnessAbort;
          void (async () => {
            try {
              await downloadAllConsciousnessModels(
                live.context.home,
                (p) => process.stdout.write(JSON.stringify({ type: "consciousness_progress", ...p }) + "\n"),
                (m) => process.stdout.write(JSON.stringify({ type: "consciousness_model_ready", id: m.id, filename: m.filename }) + "\n"),
                ac.signal,
              );
              // Install the local inference engine binary too — this is what
              // actually opens the eyes. Best-effort: if it fails, the models are
              // still down and the user can retry; the watch idles meanwhile.
              try {
                await prepareEngineBinary(
                  live.context.home,
                  (p) => process.stdout.write(JSON.stringify({ type: "consciousness_progress", ...p }) + "\n"),
                  ac.signal,
                );
                process.stdout.write(JSON.stringify({ type: "consciousness_model_ready", id: "engine", filename: "vision engine" }) + "\n");
              } catch (engineErr) {
                if (!ac.signal.aborted) {
                  process.stdout.write(
                    JSON.stringify({ type: "consciousness_error", error: `engine: ${engineErr instanceof Error ? engineErr.message : String(engineErr)}` }) + "\n",
                  );
                }
              }
              process.stdout.write(JSON.stringify({ type: "consciousness_ready" }) + "\n");
              startConsciousnessWatch();
            } catch (err) {
              if (ac.signal.aborted) {
                process.stdout.write(JSON.stringify({ type: "consciousness_cancelled" }) + "\n");
              } else {
                process.stdout.write(
                  JSON.stringify({ type: "consciousness_error", error: err instanceof Error ? err.message : String(err) }) + "\n",
                );
              }
            } finally {
              consciousnessDownloading = false;
              consciousnessAbort = undefined;
            }
          })();
        }
        continue;
      }
      if (command.type === "consciousness_cancel") {
        consciousnessAbort?.abort();
        process.stdout.write(JSON.stringify({ type: "consciousness_cancelled" }) + "\n");
        continue;
      }
      if (command.type === "model_switch") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const model = typeof command.model === "string" ? command.model.trim() : "";
        if (!provider || !model) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "model_switch requires provider and model" }) + "\n");
          continue;
        }
        try {
          const entry = await resolveEntry(command.sessionId);
          if (entry.turnActive) throw new Error("this chat is busy; stop the turn before changing its model");
          const flags = new Map<string, string>([["provider", provider], ["model", model]]);
          const selection = await selectProvider(flags);
          await preflightProviderSelection(selection);
          const previous = entry.live.selection;
          // The owner may have just repaired this provider; re-probe this one
          // without reviving unrelated providers that failed in other chats.
          deadProviders.delete(providerFamilyForSelection(selection));
          await entry.live.session.setProvider(selection.provider, selection.model, {
            contextBudgetTokens: chatContextBudget(selection),
            summarizeSpan: makeSpanSummarizer(selection, (usage) =>
              entry.live.session.recordAuxiliaryUsage("compaction", selection.provider.name, selection.model, usage),
            ),
          });
          entry.live.selection = selection;
          mainSelection = selection;
          mainProviderFamily = providerFamilyForSelection(selection);
          const settings = await loadUiSettings();
          await updateUiSettings({
            routingMode: "manual",
            lastProvider: provider as UiSettings["lastProvider"],
            lastOpenAIModel: provider === "openai" ? model : settings.lastOpenAIModel,
            lastOllamaModel: provider === "ollama" ? model : settings.lastOllamaModel,
            lastAnthropicModel: provider === "anthropic" ? model : settings.lastAnthropicModel,
            lastDeepSeekModel: provider === "deepseek" ? model : settings.lastDeepSeekModel,
            lastOpenRouterModel: provider === "openrouter" ? model : settings.lastOpenRouterModel,
            // Ares gateway + custom endpoints were omitted here, so picking one
            // of their models never persisted — next start snapped back to the
            // "ares-internal"/"" default. Remember them like every other provider.
            lastAresModel: provider === "ares" ? model : settings.lastAresModel,
            lastCustomModel: provider === "custom" ? model : settings.lastCustomModel,
            lastMoaModel: provider === "moa" ? model : settings.lastMoaModel,
          });
          tagEmit(command.sessionId, {
            type: "model_switched",
            provider: providerFamilyForSelection(selection),
            model: selection.model,
            previousProvider: providerFamilyForSelection(previous),
            previousModel: previous.model,
          });
        } catch (err) {
          const entry = await resolveEntry(command.sessionId).catch(() => null);
          tagEmit(command.sessionId, {
            type: "model_switch_failed",
            provider,
            model,
            currentProvider: entry ? providerFamilyForSelection(entry.live.selection) : mainProviderFamily,
            currentModel: entry?.live.selection.model ?? mainSelection.model,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (command.type === "provider_key") {
        // Generic per-provider credential drop: persist the owner's API key
        // (+ optional default model) for any keyed provider. Applied the next
        // time the daemon starts on that provider.
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const key = typeof command.key === "string" ? command.key.trim() : "";
        const model = typeof command.model === "string" && command.model.trim() ? command.model.trim() : undefined;
        const patch: Partial<UiSettings> = {};
        if (provider === "openrouter") {
          patch.openRouterKey = key;
          if (model) patch.lastOpenRouterModel = model;
        } else if (provider === "deepseek") {
          patch.deepSeekKey = key;
          if (model) patch.lastDeepSeekModel = model;
        } else if (provider === "anthropic") {
          patch.anthropicKey = key;
          if (model) patch.lastAnthropicModel = model;
        } else if (provider === "kimi") {
          patch.kimiKey = key;
          if (model) patch.lastKimiModel = model;
          if (key) process.env.KIMI_API_KEY = key;
          else delete process.env.KIMI_API_KEY;
        } else if (provider === "ollama") {
          patch.ollamaApiKey = key;
          if (model) patch.lastOllamaModel = model;
          if (key) process.env.OLLAMA_API_KEY = key;
          else delete process.env.OLLAMA_API_KEY;
        } else if (provider === "custom") {
          // Universal OpenAI-compatible provider: key + base URL (+ optional model).
          patch.customApiKey = key;
          const baseUrl = typeof command.baseUrl === "string" ? command.baseUrl.trim() : "";
          if (baseUrl) patch.customBaseUrl = baseUrl;
          if (model) patch.lastCustomModel = model;
        } else if (provider === "brave") {
          patch.braveKey = key;
          if (key) process.env.ARES_BRAVE_API_KEY = key; // live immediately, no restart
        } else {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `provider_key: unsupported provider "${provider}" (openrouter | deepseek | anthropic | kimi | ollama | custom | brave)` }) + "\n");
          continue;
        }
        await updateUiSettings(patch);
        process.stdout.write(JSON.stringify({ type: "provider_key_set", provider, hasKey: Boolean(key) }) + "\n");
        continue;
      }
      if (command.type === "openrouter_key") {
        // Persist the owner's OpenRouter key (+ optional default model). Applied
        // the next time the daemon starts on the openrouter provider.
        const patch: Partial<UiSettings> = { openRouterKey: typeof command.key === "string" ? command.key.trim() : "" };
        if (typeof command.model === "string" && command.model.trim()) patch.lastOpenRouterModel = command.model.trim();
        await updateUiSettings(patch);
        process.stdout.write(JSON.stringify({ type: "openrouter_key_set", hasKey: Boolean(patch.openRouterKey) }) + "\n");
        continue;
      }
      if (command.type === "undo") {
        const entry = await resolveEntry(command.sessionId);
        const depth = Number.isFinite(command.depth) ? String(command.depth) : "";
        const lines = await undoLines(entry.live, depth);
        tagEmit(command.sessionId, { type: "undo_result", text: lines.join("\n") });
        continue;
      }
      if (command.type === "sessions_list") {
        // SQLite is authoritative for canonical sessions. A projection/open
        // failure must surface, never masquerade as an empty session rail.
        try {
          const sessions = await listSessions(live.context.workspace, 100);
          process.stdout.write(JSON.stringify({ type: "sessions_list", sessions }) + "\n");
        } catch (error) {
          process.stdout.write(JSON.stringify({
            type: "daemon_error",
            error: `sessions_list: ${error instanceof Error ? error.message : String(error)}`,
          }) + "\n");
        }
        continue;
      }
      if (command.type === "model_catalog") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const models = await daemonModelCatalog(provider).catch(() => []);
        process.stdout.write(JSON.stringify({ type: "model_catalog", provider, models }) + "\n");
        continue;
      }
      if (command.type === "session_history") {
        // Read-only replay of a past session's transcript for the UI to render.
        const id = cleanCommandId(command.id);
        if (!id) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "session_history requires id" }) + "\n");
          continue;
        }
        try {
          const snap = await loadSessionSnapshot(live.context.workspace, id, { maxMessages: 400 });
          process.stdout.write(JSON.stringify({ type: "session_history", id, messages: snap.messages, meta: snap.meta }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `session_history: ${err instanceof Error ? err.message : String(err)}` }) + "\n");
        }
        continue;
      }
      // ─── Background jobs, from the UI ──────────────────────────────────
      // The desktop can now SEE this: what is running, what was suspended when
      // the app closed, and one click each to stop or resume. Before this, the
      // only surface for a runaway background job was Task Manager.
      if (
        command.type === "background_list" ||
        command.type === "background_stop" ||
        command.type === "background_resume"
      ) {
        const entry = await resolveEntry(command.sessionId).catch(() => undefined);
        if (!entry) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `${command.type}: unknown session` }) + "\n");
          continue;
        }
        const jobId = cleanCommandId(command.id);
        try {
          if (command.type === "background_stop") {
            if (!jobId) throw new Error("background_stop requires id");
            const killed = await entry.live.shellRegistry.kill(jobId, "user", entry.live.session.meta.id);
            tagEmit(command.sessionId, { type: "background_stopped", id: jobId, ok: killed });
          } else if (command.type === "background_resume") {
            if (!jobId) throw new Error("background_resume requires id");
            const resumed = await entry.live.shellRegistry.resume(jobId, entry.live.session.meta.id);
            tagEmit(command.sessionId, { type: "background_resumed", id: resumed.id, from: jobId, status: resumed.status });
          }
        } catch (err) {
          tagEmit(command.sessionId, {
            type: "daemon_error",
            error: `${command.type}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        emitBackgroundJobs(command.sessionId, entry);
        continue;
      }
      // ─── Subagent visibility: fleets + durable subagent jobs ───────────
      // Read-only windows for the desktop. Fleets are journaled on disk by the
      // conductor (<workspace>/.ares/fleets/<id>/manifest.json); durable
      // subagent work lives in the session kernel as kind:"task" jobs. Both
      // handlers are best-effort: a malformed manifest or a locked kernel DB
      // must never take the daemon down, so errors surface inside the reply.
      if (command.type === "fleets_list") {
        try {
          const workspace = (await resolveEntry(command.sessionId).catch(() => undefined))?.live.context.workspace
            ?? live.context.workspace;
          const fleetsDir = path.join(workspace, ".ares", "fleets");
          const dirents = await readdir(fleetsDir, { withFileTypes: true }).catch(() => []);
          const found: Array<{ mtimeMs: number; fleet: Record<string, unknown> }> = [];
          for (const dirent of dirents) {
            if (!dirent.isDirectory()) continue;
            const manifestPath = path.join(fleetsDir, dirent.name, "manifest.json");
            try {
              const [info, raw] = await Promise.all([stat(manifestPath), readFile(manifestPath, "utf8")]);
              const manifest = JSON.parse(raw) as Record<string, unknown>;
              if (!manifest || typeof manifest !== "object") continue;
              // Trim to a compact summary — manifests can carry long prompts,
              // failure texts, and per-leaf transcript paths that the list
              // view never needs. Pass through only what each level holds.
              const phases = Array.isArray(manifest.phases)
                ? manifest.phases.map((phase) => {
                    const p = (phase ?? {}) as Record<string, unknown>;
                    const agents = Array.isArray(p.agents)
                      ? p.agents.map((agent) => {
                          const a = (agent ?? {}) as Record<string, unknown>;
                          return {
                            ...(a.role !== undefined ? { role: a.role } : {}),
                            ...(a.status !== undefined ? { status: a.status } : {}),
                            ...(a.workStatus !== undefined ? { workStatus: a.workStatus } : {}),
                          };
                        })
                      : undefined;
                    return {
                      ...(p.id !== undefined ? { id: p.id } : {}),
                      ...(p.kind !== undefined ? { kind: p.kind } : {}),
                      ...(p.status !== undefined ? { status: p.status } : {}),
                      ...(p.build !== undefined ? { build: p.build } : {}),
                      ...(agents !== undefined ? { agents } : {}),
                    };
                  })
                : undefined;
              found.push({
                mtimeMs: info.mtimeMs,
                fleet: {
                  fleetId: typeof manifest.fleetId === "string" && manifest.fleetId ? manifest.fleetId : dirent.name,
                  ...(manifest.goal !== undefined ? { goal: manifest.goal } : {}),
                  ...(manifest.status !== undefined ? { status: manifest.status } : {}),
                  ...(manifest.startedAt !== undefined ? { startedAt: manifest.startedAt } : {}),
                  // journalFleet writes the manifest when the fleet settles, so
                  // the file's mtime is an honest finish time when the manifest
                  // itself doesn't carry one.
                  finishedAt: manifest.finishedAt !== undefined ? manifest.finishedAt : info.mtimeMs,
                  ...(phases !== undefined ? { phases } : {}),
                  manifestPath,
                },
              });
            } catch {
              // Malformed or vanished manifest — skip the entry silently.
            }
          }
          found.sort((a, b) => b.mtimeMs - a.mtimeMs);
          tagEmit(command.sessionId, { type: "fleets_list", fleets: found.slice(0, 30).map((f) => f.fleet) });
        } catch (err) {
          tagEmit(command.sessionId, {
            type: "fleets_list",
            fleets: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (command.type === "subagents_list") {
        try {
          const entry = await resolveEntry(command.sessionId);
          const sid = entry.live.session.meta.id;
          const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
          // kind:"task" is the durable subagent job kind (kind:"shell" is
          // background shells, which background_list already covers). Show
          // everything live plus anything that finished in the last day —
          // "what just happened" is the whole point of this window.
          const RECENT_MS = 24 * 60 * 60 * 1000;
          const now = Date.now();
          const jobs = kernel.listBackgroundJobs(sid, { kind: "task" })
            .filter((job) =>
              job.status === "queued" || job.status === "running" ||
              (job.finishedAtMs !== null && now - job.finishedAtMs <= RECENT_MS),
            )
            .sort((a, b) => b.createdAtMs - a.createdAtMs)
            .slice(0, 50)
            .map((job) => ({
              jobId: job.id,
              kind: job.kind,
              ...(job.description ? { description: job.description } : {}),
              status: job.status,
              ...(job.startedAtMs !== null ? { startedAt: job.startedAtMs } : {}),
              ...(job.finishedAtMs !== null ? { finishedAt: job.finishedAtMs } : {}),
              sessionId: job.sessionId,
            }));
          tagEmit(command.sessionId, { type: "subagents_list", jobs });
        } catch (err) {
          tagEmit(command.sessionId, {
            type: "subagents_list",
            jobs: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (command.type === "mcp_list") {
        process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
        continue;
      }
      if (command.type === "mcp_connect") {
        const url = typeof command.url === "string" ? command.url.trim() : "";
        if (!url) {
          process.stdout.write(JSON.stringify({ type: "mcp_connect_result", ok: false, error: "a connector URL is required" }) + "\n");
          continue;
        }
        const name = typeof command.name === "string" && command.name.trim() ? command.name.trim() : connectorNameFromUrl(url);
        // The OAuth dance can take minutes (the user authorizes in a browser), so
        // run it OFF the command loop and report via frames when it settles.
        void (async () => {
          try {
            const result = await connectMcpServer(url, {
              name,
              onAuthorizeUrl: (authUrl) => {
                // Reuse the existing oauth_url frame — the desktop opens it in the real browser.
                process.stdout.write(JSON.stringify({ type: "oauth_url", url: authUrl }) + "\n");
              },
            });
            process.stdout.write(
              JSON.stringify({
                type: "mcp_connect_result",
                ok: true,
                name: result.name,
                toolCount: result.toolCount ?? null,
                verified: result.verified,
                verifyError: result.verifyError ?? null,
              }) + "\n",
            );
            process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
          } catch (err) {
            process.stdout.write(JSON.stringify({ type: "mcp_connect_result", ok: false, name, error: err instanceof Error ? err.message : String(err) }) + "\n");
          }
        })();
        continue;
      }
      if (command.type === "mcp_set_token") {
        // API-key connectors: a pasted token goes into the ENCRYPTED vault as a
        // static bundle (never plaintext on disk) and is verified via tools/list.
        const url = typeof command.url === "string" ? command.url.trim() : "";
        const token = typeof command.token === "string" ? command.token.trim() : "";
        const name = typeof command.name === "string" && command.name.trim() ? command.name.trim() : connectorNameFromUrl(url);
        if (!url || !token) {
          process.stdout.write(JSON.stringify({ type: "mcp_connect_result", ok: false, name, error: "a connector URL and token are required" }) + "\n");
          continue;
        }
        void (async () => {
          try {
            const result = await setMcpServerToken(url, token, { name });
            process.stdout.write(
              JSON.stringify({
                type: "mcp_connect_result",
                ok: true,
                name: result.name,
                toolCount: result.toolCount ?? null,
                verified: result.verified,
                verifyError: result.verifyError ?? null,
              }) + "\n",
            );
            process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
          } catch (err) {
            process.stdout.write(JSON.stringify({ type: "mcp_connect_result", ok: false, name, error: err instanceof Error ? err.message : String(err) }) + "\n");
          }
        })();
        continue;
      }
      if (command.type === "mcp_disconnect") {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        await disconnectMcpServer(name).catch(() => false);
        process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
        continue;
      }
      if (command.type === "mcp_toggle") {
        // Pause/resume a connector without dropping its OAuth tokens.
        const name = typeof command.name === "string" ? command.name.trim() : "";
        const enabled = command.enabled !== false;
        if (name) await setMcpServerEnabled(name, enabled).catch(() => false);
        process.stdout.write(JSON.stringify({ type: "mcp_directory", connectors: await mcpDirectorySnapshot() }) + "\n");
        continue;
      }
      if (command.type === "mcp_tools") {
        // Live tool listing for one connector — the /mcp explorer's expand row.
        // Runs off the command loop: a slow/unreachable server must not block chat.
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name) {
          process.stdout.write(JSON.stringify({ type: "mcp_tools", name, tools: [], error: "a connector name is required" }) + "\n");
          continue;
        }
        void (async () => {
          const { listMcpServerTools } = await import("@ares/tools");
          const out = await listMcpServerTools(live.context.workspace, name, 15_000).catch(
            (err) => ({ tools: [], error: err instanceof Error ? err.message : String(err) }),
          );
          process.stdout.write(JSON.stringify({ type: "mcp_tools", name, tools: out.tools, error: out.error ?? null }) + "\n");
        })();
        continue;
      }
      if (command.type === "mcp_search") {
        // Search the public MCP registry for connect-able (remote HTTP) servers.
        const text = typeof command.text === "string" ? command.text.trim() : "";
        void (async () => {
          try {
            const res = await fetch(
              `https://registry.modelcontextprotocol.io/v0/servers?limit=30&search=${encodeURIComponent(text)}`,
              { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
            );
            if (!res.ok) throw new Error(`registry ${res.status}`);
            const json = await res.json() as {
              servers?: Array<{
                server?: {
                  name?: string;
                  description?: string;
                  remotes?: Array<{ type?: string; url?: string; headers?: Array<{ isRequired?: boolean; isSecret?: boolean }> }>;
                };
                _meta?: Record<string, { isLatest?: boolean; status?: string }>;
              }>;
            };
            const seen = new Set<string>();
            const results: Array<{ name: string; fullName: string; description: string; url: string; needsKey: boolean }> = [];
            for (const row of json.servers ?? []) {
              const server = row.server;
              const official = row._meta?.["io.modelcontextprotocol.registry/official"];
              if (!server?.name || official?.isLatest === false || (official?.status && official.status !== "active")) continue;
              for (const remote of server.remotes ?? []) {
                const url = remote.url ?? "";
                if (!/^https:\/\//i.test(url) || seen.has(url)) continue;
                if (remote.type && !/^(streamable-http|sse|http)$/i.test(remote.type)) continue;
                seen.add(url);
                results.push({
                  name: server.name.split("/").pop() ?? server.name,
                  fullName: server.name,
                  description: (server.description ?? "").slice(0, 160),
                  url,
                  needsKey: (remote.headers ?? []).some((h) => h.isRequired && h.isSecret),
                });
                break; // one remote per server is enough for the gallery
              }
              if (results.length >= 12) break;
            }
            process.stdout.write(JSON.stringify({ type: "mcp_search_results", text, results }) + "\n");
          } catch (err) {
            process.stdout.write(JSON.stringify({ type: "mcp_search_results", text, results: [], error: err instanceof Error ? err.message : String(err) }) + "\n");
          }
        })();
        continue;
      }
      if (command.type === "ollama_pull") {
        // Download a library model through the LOCAL ollama daemon, streaming
        // /api/pull progress to the model panel. Runs off the command loop.
        const model = typeof command.model === "string" ? command.model.trim() : "";
        if (!model || !/^[a-z0-9._:\/-]+$/i.test(model)) {
          process.stdout.write(JSON.stringify({ type: "ollama_pull_done", model, ok: false, error: "a valid model name is required" }) + "\n");
          continue;
        }
        if (model.toLowerCase().endsWith(":cloud")) {
          process.stdout.write(JSON.stringify({
            type: "ollama_pull_done",
            model,
            ok: false,
            error: "Ollama Cloud models run remotely and do not need to be pulled.",
          }) + "\n");
          continue;
        }
        void (async () => {
          const host = (process.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
          try {
            const res = await fetch(`${host}/api/pull`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model }),
            });
            if (!res.ok || !res.body) throw new Error(res.status === 404 ? "model not found in the library" : `local Ollama isn't running (${res.status})`);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            let lastEmit = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.trim()) continue;
                let p: { status?: string; total?: number; completed?: number; error?: string };
                try {
                  p = JSON.parse(line);
                } catch {
                  continue;
                }
                if (p.error) throw new Error(p.error);
                const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : null;
                const now = Date.now();
                if (now - lastEmit > 300) {
                  lastEmit = now;
                  process.stdout.write(JSON.stringify({ type: "ollama_pull_progress", model, status: p.status ?? "", pct }) + "\n");
                }
              }
            }
            process.stdout.write(JSON.stringify({ type: "ollama_pull_done", model, ok: true }) + "\n");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const friendly = /fetch failed|ECONNREFUSED/i.test(msg) ? "Local Ollama isn't running — start the Ollama app, then try again." : msg;
            process.stdout.write(JSON.stringify({ type: "ollama_pull_done", model, ok: false, error: friendly }) + "\n");
          }
        })();
        continue;
      }
      if (command.type === "discover_custom_models") {
        // Server-side model discovery for the Custom (OpenAI-compatible)
        // provider — runs here in Node so CORS / browser-origin rejection
        // (NVIDIA, Google AI Studio, most hosted APIs) can't block it.
        const base = typeof command.base === "string" ? command.base : "";
        const key = typeof command.key === "string" ? command.key : "";
        const result = await fetchCustomOpenAiModels(base, key).catch((err) => ({
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        }));
        process.stdout.write(JSON.stringify({ type: "custom_models", ...result }) + "\n");
        continue;
      }
      if (command.type === "bug_report") {
        // Opt-in: the user pressed "Report bug". Ship the FULL raw rollout of a
        // session to the owner's gateway so coding failures can be diagnosed —
        // every tool call, its output, every error, and all generated code.
        const id = cleanCommandId(command.id);
        if (!id) {
          process.stdout.write(JSON.stringify({ type: "bug_report_result", ok: false, error: "no session to report" }) + "\n");
          continue;
        }
        try {
          const note = typeof command.note === "string" ? command.note.slice(0, 2000) : "";
          const rollout = await loadSessionRollout(live.context.workspace, id);
          const brSettings = await loadUiSettings();
          // Trim pathological bulk (base64 images, giant tool dumps) so even an
          // extreme transcript stays serializable. Truncates any single
          // oversized string; the diagnosis value is in the code + errors, not
          // a multi-MB embedded screenshot. The COMPRESSED body is fitted to the
          // gateway's limit separately, inside postAresGatewayReport — that is
          // the number that decides whether the upload succeeds.
          const events = trimRolloutForReport(rollout.entries);
          const payload = {
            session_id: id,
            note,
            model: rollout.meta.provider?.model ?? "",
            app_version: await cliVersion(),
            os: `${process.platform} ${process.arch}`,
            event_count: rollout.eventCount,
            tool_failures: rollout.toolFailures,
            transcript: { meta: rollout.meta, events },
          };
          const result = await postAresGatewayReport(aresGatewayBase(brSettings), brSettings.aresGatewayToken, payload);
          if (!result.ok) {
            // The upload failing (no account, network, gateway down) must not
            // eat the report — the tester with the broken session is the whole
            // audience of this feature. Degrade to a local file they can attach.
            const savedPath = await saveReportLocally(payload, id, live.context.workspace).catch(() => undefined);
            process.stdout.write(JSON.stringify({ type: "bug_report_result", ...result, savedPath }) + "\n");
          } else {
            process.stdout.write(JSON.stringify({ type: "bug_report_result", ...result }) + "\n");
          }
        } catch (err) {
          process.stdout.write(JSON.stringify({ type: "bug_report_result", ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
        }
        continue;
      }
      if (command.type === "webview_result") {
        // The UI finished an embedded-browser op — resolve the awaiting tool call.
        if (typeof command.cmdId === "string") {
          embeddedBridge.resolve(command.cmdId, { ok: command.ok !== false, result: command.result, error: typeof command.error === "string" ? command.error : undefined });
        }
        continue;
      }
      if (command.type === "session_delete") {
        const id = cleanCommandId(command.id);
        if (!id) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "session_delete requires id" }) + "\n");
          continue;
        }
        try {
          // Drop any live in-memory entry so a deleted session can't resurrect,
          // then remove it from disk. The primary session is never deleted.
          const entry = sessions.get(id);
          if (entry && entry !== primaryEntry) {
            try { entry.live.session.interrupt?.(); } catch { /* best-effort */ }
            await entry.live.verifier.cancel().catch(() => undefined);
            await entry.live.shellRegistry.killAll().catch(() => 0);
            const deadline = Date.now() + 5_000;
            while (entry.turnActive && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (entry.turnActive) throw new Error("session is still quiescing after interrupt; deletion refused to prevent rollout resurrection");
            await disposeLiveSession(entry.live);
            sessions.delete(id);
          }
          const ok = await deleteSession(live.context.workspace, id);
          process.stdout.write(JSON.stringify({ type: "session_deleted", id, ok }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `session_delete: ${err instanceof Error ? err.message : String(err)}` }) + "\n");
        }
        continue;
      }
      if (command.type === "session_rename") {
        const id = cleanCommandId(command.id);
        const label = typeof command.label === "string" ? command.label : "";
        if (!id) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "session_rename requires id" }) + "\n");
          continue;
        }
        try {
          const ok = await renameSession(live.context.workspace, id, label);
          process.stdout.write(JSON.stringify({ type: "session_renamed", id, label: label.trim().slice(0, 120), ok }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: `session_rename: ${err instanceof Error ? err.message : String(err)}` }) + "\n");
        }
        continue;
      }
      if (command.type === "engine_config") {
        // Persist Advanced-tab knobs. Live ones (env-backed) apply immediately;
        // the rest take effect on the next session/turn.
        const cfg = normalizeEngineConfig(command.config);
        await updateUiSettings({ engine: cfg });
        applyEngineConfigEnv(cfg);
        for (const entry of new Set([primaryEntry, ...sessions.values()])) {
          if (!entry.turnActive) entry.live.session.setMaxTurns(cfg.maxTurns);
        }
        process.stdout.write(JSON.stringify({ type: "engine_config_set", config: cfg }) + "\n");
        continue;
      }
      if (command.type === "cognitive_state") {
        // Read-only: assembling the snapshot must never mutate agent state.
        const sid = typeof command.sessionId === "string" ? command.sessionId : undefined;
        const entry = sid ? sessions.get(sid) : primaryEntry;
        if (!entry) {
          // A resumed card only materializes its live entry on first SEND, so
          // the desktop's 5s HELM poll lands here for every dormant session —
          // and answering with daemon_error folded a red "unknown session"
          // notice into the transcript on every tick (field report,
          // 2026-08-08). Dormant is a NORMAL answer to a read-only poll:
          // reply with an empty snapshot (never another session's state, and
          // never resolveEntry — a poll must not materialize sessions on disk
          // just because the war room is open).
          process.stdout.write(JSON.stringify({ type: "cognitive_state", cognitive: null }) + "\n");
          continue;
        }
        const state = await assembleCognitiveState({
          live: entry.live,
          pendingApprovals: [...pendingApprovals.values()],
          lastTriage: lastTriageRun(),
        }).catch((err: unknown) => {
          process.stdout.write(
            JSON.stringify({ type: "daemon_error", error: `cognitive_state failed: ${err instanceof Error ? err.message : String(err)}` }) + "\n",
          );
          return null;
        });
        // Emitted as `cognitive`, not `state`: the desktop's AresEvent already
        // uses `state` for daemon/consciousness status strings, and reusing it
        // would be the same "keyed off a name that means something else"
        // mistake that made routing blank the status capsule.
        if (state) process.stdout.write(JSON.stringify({ type: "cognitive_state", cognitive: state }) + "\n");
        continue;
      }
      if (command.type === "roster_list") {
        const personas = await listPersonas(live.context.home).catch(() => []);
        const sid = typeof command.sessionId === "string" ? command.sessionId : undefined;
        const entry = sid ? sessions.get(sid) : primaryEntry;
        process.stdout.write(
          JSON.stringify({
            type: "roster_list",
            personas: personas.map(personaToWire),
            active: entry?.live.activePersona() ? personaToWire(entry.live.activePersona()!) : null,
          }) + "\n",
        );
        continue;
      }
      if (command.type === "persona_adopt") {
        // name omitted (or null) means "release" — one command for both so the
        // desktop's chip revert and its adopt button share a path.
        //
        // resolveEntry, NOT sessions.get: a resumed card only materializes a
        // live entry on its first SEND, so after any app restart the adopt
        // button on the active chat hit "unknown session" and died silently —
        // the whole roster read as broken. resolveEntry rebuilds the session
        // from disk exactly like every other per-session command.
        const sid = typeof command.sessionId === "string" && command.sessionId.trim() ? command.sessionId : undefined;
        let entry: DaemonEntry;
        try {
          entry = await resolveEntry(sid);
        } catch (error) {
          process.stdout.write(JSON.stringify({
            type: "persona_changed",
            sessionId: sid,
            active: null,
            origin: "owner",
            error: `couldn't open this chat to wear the persona: ${error instanceof Error ? error.message : String(error)}`,
          }) + "\n");
          continue;
        }
        const name = typeof command.name === "string" && command.name.trim() ? command.name.trim() : undefined;
        const result = await adoptPersonaByName(entry.live, name);
        // An owner decision is a standing order, not a one-turn preference.
        // "Back to Ares" holds until they wear something on purpose again —
        // otherwise the next message containing "fix" put the persona straight
        // back on and the button looked broken.
        if (result.ok) {
          entry.personaGate.off = !name;
          // Durably record the choice so a restart re-wears it (sessionFactory
          // resume reads this back). Best-effort — never fail the adopt.
          try {
            const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
            kernel.mergeSessionMetadata(entry.live.session.meta.id, {
              activePersona: result.active?.name ?? null,
            });
          } catch { /* persona still works for this run */ }
        }
        process.stdout.write(
          JSON.stringify({
            type: "persona_changed",
            sessionId: entry.live.session.meta.id,
            active: result.active,
            origin: "owner",
            error: result.error,
          }) + "\n",
        );
        continue;
      }
      if (command.type === "persona_write") {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        const body = typeof command.body === "string" ? command.body : "";
        // Failures come back as persona_written{ok:false}, NOT daemon_error:
        // daemon_error folds into the active session's transcript, and the
        // owner is looking at HELM when they hit Save, so a failed write was
        // completely silent — the composer just closed and nothing appeared.
        if (!name || !body.trim()) {
          process.stdout.write(
            JSON.stringify({ type: "persona_written", ok: false, name, error: "a persona needs a name and a method — the method IS the persona" }) + "\n",
          );
          continue;
        }
        try {
          const persona = await writePersona(
            {
              name,
              body,
              label: typeof command.label === "string" ? command.label : undefined,
              description: typeof command.description === "string" ? command.description : undefined,
              greeting: typeof command.greeting === "string" ? command.greeting : undefined,
              triggers: Array.isArray(command.triggers) ? command.triggers.filter((t): t is string => typeof t === "string") : undefined,
              tools: Array.isArray(command.tools) ? command.tools.filter((t): t is string => typeof t === "string") : undefined,
              glyph: typeof command.glyph === "string" ? command.glyph : undefined,
              tone: command.tone === "ember" || command.tone === "mint" || command.tone === "ivory" ? command.tone : undefined,
              autonomy:
                command.autonomy === "auto" || command.autonomy === "suggest" || command.autonomy === "manual"
                  ? command.autonomy
                  : undefined,
              model: typeof command.model === "string" ? command.model : undefined,
              effort: typeof command.effort === "string" ? command.effort : undefined,
              maxTurns: typeof command.maxTurns === "number" ? command.maxTurns : undefined,
            },
            live.context.home,
          );
          process.stdout.write(JSON.stringify({ type: "persona_written", ok: true, persona: personaToWire(persona) }) + "\n");
        } catch (err) {
          process.stdout.write(
            JSON.stringify({ type: "persona_written", ok: false, name, error: err instanceof Error ? err.message : String(err) }) + "\n",
          );
        }
        continue;
      }
      if (command.type === "persona_delete") {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "persona_delete requires name" }) + "\n");
          continue;
        }
        const removed = await deletePersona(name, live.context.home).catch(() => false);
        // A deleted persona must not stay worn — recheck every session, because
        // the roster is global while adoption is per-session.
        for (const entry of new Set([primaryEntry, ...sessions.values()])) {
          if (entry.live.activePersona()?.name === name) {
            entry.live.adoptPersona(null);
            process.stdout.write(
              JSON.stringify({ type: "persona_changed", sessionId: entry.live.session.meta.id, active: null, origin: "owner" }) + "\n",
            );
          }
        }
        process.stdout.write(JSON.stringify({ type: "persona_deleted", name, ok: removed }) + "\n");
        continue;
      }
      if (command.type === "skills_list") {
        const skills = await daemonSkillsList(live.context.home).catch(() => []);
        process.stdout.write(JSON.stringify({ type: "skills_list", skills }) + "\n");
        continue;
      }
      if (command.type === "skill_toggle") {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "skill_toggle requires name" }) + "\n");
          continue;
        }
        const settings = await loadUiSettings();
        const disabled = new Set(settings.disabledSkills ?? []);
        const enabled = command.enabled !== false;
        if (!enabled) disabled.add(name);
        else disabled.delete(name);
        await updateUiSettings({ disabledSkills: [...disabled] });
        // The UI-settings list above only drives the display; runSkill() actually
        // enforces disablement by checking for this marker file on disk (matches
        // the same skillsDir convention as daemonSkillsList above).
        const markerFile = path.join(aresAgentHome(live.context.home), "skills", name, ".disabled");
        try {
          if (!enabled) {
            await mkdir(path.dirname(markerFile), { recursive: true });
            await writeFile(markerFile, "");
          } else {
            await rm(markerFile, { force: true });
          }
        } catch {
          // Best-effort: the UI-settings flag above still reflects intent even if
          // the skill directory doesn't exist yet (e.g. toggled before install).
        }
        process.stdout.write(JSON.stringify({ type: "skill_toggle_set", name, enabled }) + "\n");
        continue;
      }
      if (command.type === "skill_invoke") {
        // One generic path for BOTH a tray surface-button click and a capability
        // call (e.g. TTS through a provider skill). The app never runs arbitrary
        // skills — it can only invoke what's already installed + enabled, and a
        // surface can only run its own skill.
        const name = typeof command.name === "string" ? command.name.trim() : "";
        const invokeId = typeof command.invokeId === "string" ? command.invokeId : undefined;
        if (!name) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "skill_invoke requires name" }) + "\n");
          continue;
        }
        const settings = await loadUiSettings();
        if ((settings.disabledSkills ?? []).includes(name)) {
          process.stdout.write(JSON.stringify({ type: "skill_result", invokeId, name, ok: false, error: `skill '${name}' is disabled` }) + "\n");
          continue;
        }
        // Self-heal divergence: UI settings are the source of truth here, but
        // runSkill enforces the on-disk `.disabled` marker. A stale marker (a
        // best-effort write from an old toggle) would make an enabled skill
        // refuse to run — clear it before invoking.
        if (/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
          await rm(path.join(aresAgentHome(live.context.home), "skills", name, ".disabled"), { force: true }).catch(() => {});
        }
        const started = Date.now();
        const run = await runSkill({ home: live.context.home, name, input: command.input, timeoutMs: 60_000 }).catch(
          (err) => ({ ok: false, result: undefined, error: err instanceof Error ? err.message : String(err) }) as { ok: boolean; result?: unknown; error?: string },
        );
        process.stdout.write(JSON.stringify({
          type: "skill_result",
          invokeId,
          name,
          ok: run.ok,
          result: run.ok ? run.result : undefined,
          error: run.ok ? undefined : (run.error ?? "skill failed"),
          durationMs: Date.now() - started,
        }) + "\n");
        continue;
      }
      if (command.type === "skillhub_list") {
        const gwSettings = await loadUiSettings();
        const base = aresGatewayBase(gwSettings);
        const reachable = await skillHubProbe(base);
        const skills = reachable ? await skillHubList(base, typeof command.text === "string" ? command.text : "").catch(() => []) : [];
        process.stdout.write(JSON.stringify({ type: "skillhub_list", reachable, skills }) + "\n");
        continue;
      }
      if (command.type === "skillhub_install") {
        const gwSettings = await loadUiSettings();
        const base = aresGatewayBase(gwSettings);
        const id = typeof command.id === "string" ? command.id : "";
        const files = id ? await skillHubGet(base, id).catch(() => null) : null;
        if (!files) {
          process.stdout.write(JSON.stringify({ type: "skillhub_installed", ok: false, error: "skill not found on the hub" }) + "\n");
          continue;
        }
        const res = await installHubSkill(live.context.home, files).then((r) => ({ ok: true as const, ...r })).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
        process.stdout.write(JSON.stringify({ type: "skillhub_installed", ...res }) + "\n");
        continue;
      }
      if (command.type === "skillhub_publish") {
        const gwSettings = await loadUiSettings();
        const base = aresGatewayBase(gwSettings);
        const token = gwSettings.aresGatewayToken || process.env.ARES_GATEWAY_TOKEN || "";
        const name = typeof command.name === "string" ? command.name : "";
        const files = name ? await readLocalSkillFiles(live.context.home, name).catch(() => null) : null;
        if (!files) {
          process.stdout.write(JSON.stringify({ type: "skillhub_published", ok: false, error: "local skill not found" }) + "\n");
          continue;
        }
        const res = await skillHubPublish(base, token, files);
        process.stdout.write(JSON.stringify({ type: "skillhub_published", ...res }) + "\n");
        continue;
      }
      if (command.type === "usage_stats") {
        const days = Number(command.days) > 0 ? Math.floor(Number(command.days)) : 30;
        const stats = await daemonUsageStats(live.context.workspace, days).catch(() => null);
        process.stdout.write(JSON.stringify({ type: "usage_stats", days, stats }) + "\n");
        continue;
      }
      if (command.type === "anthropic_login_start") {
        // Loopback OAuth flow: start a local callback server, open the browser,
        // catch the redirect automatically, exchange for tokens, then emit done.
        const sid = command.sessionId;
        // force: an explicit sign-in click always re-authenticates — this is
        // also the only way to recover from a limit-broken or stale account.
        runAnthropicLoginFlow((url) => {
          tagEmit(sid, { type: "anthropic_login_url", url });
        }, fetch, 300_000, true)
          .then(() => {
            tagEmit(sid, { type: "anthropic_login_done", ok: true });
            // Count the fresh OAuth session as a usable key so the first-run
            // gate closes live instead of re-prompting until an API key lands.
            process.stdout.write(JSON.stringify({ type: "provider_key_set", provider: "anthropic", hasKey: true }) + "\n");
          })
          .catch((err: unknown) => {
            tagEmit(sid, { type: "anthropic_login_done", ok: false, error: err instanceof Error ? err.message : String(err) });
          });
        continue;
      }
      if (command.type === "anthropic_login_finish") {
        // No-op: finish is handled automatically by the loopback server.
        // Kept so older UI builds don't crash the daemon.
        continue;
      }
      if (command.type === "openai_login_start") {
        // ChatGPT OAuth (loopback authorization-code + PKCE). The browser does
        // the /authorize page — clearing Cloudflare's bot challenge, which a
        // server-side device-code fetch cannot — and we catch the redirect on
        // localhost:1455. Routes GPT usage through the ChatGPT subscription.
        const sid = command.sessionId;
        void runOpenAILoginFlow({
          onAuthorizeUrl: (url) => tagEmit(sid, { type: "openai_login_url", url }),
        })
          .then((file) => {
            tagEmit(sid, { type: "openai_login_done", ok: true, email: file.profile.email ?? null, plan: file.profile.planType ?? null });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            tagEmit(sid, { type: "openai_login_done", ok: false, error: msg.slice(0, 200) });
          });
        continue;
      }
      if (command.type === "openai_auth_status") {
        const status = await authStatus().catch(() => null);
        process.stdout.write(JSON.stringify({
          type: "openai_auth_status",
          configured: !!status?.configured,
          email: status?.email ?? null,
          plan: status?.planType ?? null,
        }) + "\n");
        continue;
      }
      if (command.type === "kimi_login_start") {
        // Kimi subscription sign-in (RFC 8628 device flow) against auth.kimi.com,
        // owned by Ares itself. The verification URL goes to the UI card so the
        // owner can approve in a browser; tokens land in ~/.ares/kimi-auth.json.
        const sid = command.sessionId;
        void runKimiLoginFlow({
          force: true,
          onAuthorize: (auth) => tagEmit(sid, {
            type: "kimi_login_url",
            url: auth.verificationUriComplete ?? auth.verificationUri,
            userCode: auth.userCode,
          }),
        })
          .then(() => {
            tagEmit(sid, { type: "kimi_login_done", ok: true, detail: "subscription" });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            tagEmit(sid, { type: "kimi_login_done", ok: false, error: msg.slice(0, 200) });
          });
        continue;
      }
      if (command.type === "kimi_auth_status") {
        // An API key is a legitimate way to be configured, so the card reports
        // green on either credential rather than only on the OAuth token.
        const status = await kimiAuthStatus().catch(() => null);
        const apiKey = ((await loadUiSettings()).kimiKey ?? "") !== "" || (process.env.KIMI_API_KEY ?? "") !== "";
        process.stdout.write(JSON.stringify({
          type: "kimi_auth_status",
          configured: status?.connected === true || apiKey,
          detail: status?.connected === true ? (status.detail ?? "subscription") : apiKey ? "api-key" : null,
        }) + "\n");
        continue;
      }
      if (command.type === "computer_status") {
        // The agent's own computer (docs/AGENT-COMPUTER-DESIGN.md): WSL2
        // sandbox availability + display leases, for the UI chip and setup card.
        const status = await getAgentComputer().status().catch((err: unknown) => ({
          error: err instanceof Error ? err.message : String(err),
        }));
        const mode = (await loadUiSettings().catch(() => null))?.computerMode ?? "host";
        process.stdout.write(JSON.stringify({ type: "computer_status", status: { ...status, mode } }) + "\n");
        continue;
      }
      if (command.type === "computer_setup") {
        // Provision runs minutes (rootfs download + apt) — stream progress and
        // finish asynchronously so the daemon loop never blocks on it.
        const sid = command.sessionId;
        void getAgentComputer()
          .setup((line) => tagEmit(sid, { type: "computer_setup_progress", line }))
          .then((result) => tagEmit(sid, { type: "computer_setup_done", ok: true, result }))
          .catch((err: unknown) => tagEmit(sid, {
            type: "computer_setup_done",
            ok: false,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 400),
          }));
        continue;
      }
      if (command.type === "computer_mode") {
        // The sandbox-only switch. Flipping it ON with no machine yet would
        // strand the owner toolless, so provisioning kicks off in the same
        // gesture and the UI narrates it.
        const mode = command.mode === "sandbox" ? "sandbox" : "host";
        await updateUiSettings({ computerMode: mode });
        let setupStarted = false;
        if (mode === "sandbox") {
          const status = await getAgentComputer().status().catch(() => null);
          if (status && !status.provisioned && status.blocked !== "vm-platform") {
            setupStarted = true;
            const sid = command.sessionId;
            void getAgentComputer()
              .setup((line) => tagEmit(sid, { type: "computer_setup_progress", line }))
              .then((result) => tagEmit(sid, { type: "computer_setup_done", ok: true, result }))
              .catch((err: unknown) => tagEmit(sid, {
                type: "computer_setup_done",
                ok: false,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 400),
              }));
          }
        }
        process.stdout.write(JSON.stringify({ type: "computer_mode", mode, setupStarted }) + "\n");
        // Tools are composed per session, so the change lands on the next
        // rebuild; tell the owner rather than letting it look like a no-op.
        continue;
      }
      if (command.type === "computer_screen") {
        // Start (or reuse) the watchable noVNC screen and hand back its URL.
        try {
          const viewOnly = command.viewOnly === true;
          const screen = await getAgentComputer().ensureScreen(1, viewOnly);
          process.stdout.write(JSON.stringify({ type: "computer_screen", ok: true, url: screen.url, viewOnly }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({
            type: "computer_screen",
            ok: false,
            error: (err instanceof Error ? err.message : String(err)).replace(/<\/?tool_use_error>/g, "").slice(0, 400),
          }) + "\n");
        }
        continue;
      }
      if (command.type === "operator_status") {
        const goals = await listGoals(live.context.home).catch(() => []);
        const active = goals.filter((g) => g.status === "active");
        // Trust meter: earned leash per domain, same derivation the effects
        // rails use — the HELM's Favor slate renders this.
        const trust = await (async () => {
          try {
            const store = await MemoryStore.open(live.context.mind.memoryFile);
            const nodes = store.all();
            const domains = new Set<string>(["browser"]);
            for (const node of nodes) {
              const domain = domainOf(node);
              if (domain) domains.add(domain);
            }
            return [...domains].sort().map((domain) => {
              const basis = deriveLeash(nodes, domain);
              return { domain, level: basis.level, proven: basis.proven.length };
            });
          } catch {
            return [];
          }
        })();
        process.stdout.write(
          JSON.stringify({
            type: "operator_status",
            autotick: process.env.ARES_OPERATOR_AUTOTICK !== "0",
            intervalMs: operatorTickIntervalMs(),
            goals: goals.map((g) => ({ id: g.id, statement: g.statement.slice(0, 160), status: g.status, progress: g.progress, steps: g.stepLog?.length ?? 0 })),
            activeCount: active.length,
            trust,
          }) + "\n",
        );
        continue;
      }
      if (command.type === "gateway_connect" || command.type === "gateway_status") {
        // Ares Gateway account bridge (doingteam.com): connect persists the
        // URL+token; status (and the 20s poll below) snapshots /me for the
        // desktop Account panel. Grants surface as gateway_grant toasts.
        if (command.type === "gateway_connect") {
          const patch: Record<string, string> = {};
          if (typeof command.token === "string" && command.token.trim()) patch.aresGatewayToken = command.token.trim();
          if (typeof command.url === "string" && command.url.trim()) patch.aresGatewayUrl = command.url.trim().replace(/\/+$/, "");
          if (Object.keys(patch).length > 0) await updateUiSettings(patch);
        }
        const gwSettings = await loadUiSettings();
        const gwToken = gwSettings.aresGatewayToken;
        // Capability probe: does doingteam expose click-to-connect OAuth yet? The
        // desktop only shows the "Sign in" button when this is true, so the button
        // stays hidden (no broken UX) until the gateway endpoints go live.
        const oauthSupported = await probeAresOauth(aresGatewayBase(gwSettings)).catch(() => false);
        if (!gwToken) {
          process.stdout.write(JSON.stringify({ type: "gateway_account", connected: false, reason: "no token", oauthSupported }) + "\n");
          continue;
        }
        const me = await fetchAresGatewayMe(aresGatewayBase(gwSettings), gwToken);
        process.stdout.write(
          JSON.stringify(
            me
              ? { type: "gateway_account", connected: true, oauthSupported, ...me }
              : { type: "gateway_account", connected: false, reason: "unreachable or token rejected", oauthSupported },
          ) + "\n",
        );
        continue;
      }
      if (command.type === "gateway_signin") {
        // Click-to-connect: run the loopback code-exchange sign-in against
        // doingteam, then persist the returned account token into
        // aresGatewayToken — after which every gateway call authenticates with
        // no token paste. Fire-and-forget so the loop keeps serving; the desktop
        // opens the authorize URL from oauth_url and refreshes on oauth_connected.
        const siSettings = await loadUiSettings();
        const siBase = typeof command.url === "string" && command.url.trim()
          ? command.url.trim().replace(/\/+$/, "")
          : aresGatewayBase(siSettings);
        void runAresAccountSignin(siBase, {
          onAuthorizeUrl: (url) => { process.stdout.write(JSON.stringify({ type: "oauth_url", provider: "ares", url }) + "\n"); },
        })
          .then(async ({ token, base }) => {
            await updateUiSettings({ aresGatewayToken: token, aresGatewayUrl: base });
            process.stdout.write(JSON.stringify({ type: "oauth_connected", provider: "ares" }) + "\n");
            // The account IS the credential: reflect it into keyStatus so the
            // first-run gate closes now and stays closed on later launches.
            process.stdout.write(JSON.stringify({ type: "provider_key_set", provider: "ares", hasKey: true }) + "\n");
            // Immediately snapshot the freshly-connected account for the panel.
            const me = await fetchAresGatewayMe(base, token).catch(() => null);
            process.stdout.write(
              JSON.stringify(me ? { type: "gateway_account", connected: true, oauthSupported: true, ...me } : { type: "gateway_account", connected: true, oauthSupported: true }) + "\n",
            );
          })
          .catch((err) => process.stdout.write(JSON.stringify({ type: "oauth_error", provider: "ares", error: err instanceof Error ? err.message : String(err) }) + "\n"));
        continue;
      }
      if (command.type === "operator_autotick") {
        // Live toggle of the unattended mission loop. The tick reads the env each
        // pass, so this takes effect on the next tick; also persisted so it sticks.
        const enabled = command.enabled !== false;
        if (enabled) delete process.env.ARES_OPERATOR_AUTOTICK;
        else process.env.ARES_OPERATOR_AUTOTICK = "0";
        const settings = await loadUiSettings();
        await updateUiSettings({ engine: { ...(settings.engine ?? {}), operatorAutotick: enabled } });
        process.stdout.write(JSON.stringify({ type: "operator_autotick_set", enabled }) + "\n");
        process.stdout.write(
          JSON.stringify({
            type: "operator_status",
            autotick: enabled,
            intervalMs: operatorTickIntervalMs(),
            goals: (await listGoals(live.context.home).catch(() => [])).map((g) => ({ id: g.id, statement: g.statement.slice(0, 160), status: g.status, progress: g.progress, steps: g.stepLog?.length ?? 0 })),
            activeCount: (await listGoals(live.context.home).catch(() => [])).filter((g) => g.status === "active").length,
          }) + "\n",
        );
        continue;
      }
      if (command.type === "operator_control") {
        // Daemon-side entry point for the kill switch, alongside operator_status /
        // operator_autotick — so the Tauri desktop app can add a halt/resume button
        // without shelling out to the CLI. Mirrors `ares operator halt|resume`.
        const action = command.action === "resume" ? "resume" : command.action === "halt" ? "halt" : null;
        if (!action) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: 'operator_control requires action: "halt" | "resume"' }) + "\n");
          continue;
        }
        const killSwitch = new KillSwitch(live.context.effects.killSwitchFile);
        if (action === "halt") await killSwitch.engage(typeof command.reason === "string" ? command.reason : "manual");
        else await killSwitch.release();
        process.stdout.write(JSON.stringify({ type: "operator_control_set", action, engaged: await killSwitch.engaged() }) + "\n");
        continue;
      }
      if (command.type === "oauth_status") {
        // Report every provider: connected (tokens on file) + hasApp (client creds set).
        const home = live.context.home;
        const status = await connectedProviders(OAUTH_PROVIDERS, home).catch(() => ({}) as Record<string, boolean>);
        const providers = await Promise.all(
          Object.entries(OAUTH_PROVIDERS).map(async ([id, cfg]) => ({
            id,
            label: PROVIDER_LABELS[id] ?? id,
            connected: status[id] ?? false,
            hasApp: (await hasCredential(clientIdName(cfg), { home }).catch(() => false)) && (await hasCredential(clientSecretName(cfg), { home }).catch(() => false)),
          })),
        );
        process.stdout.write(JSON.stringify({ type: "oauth_status", providers }) + "\n");
        continue;
      }
      if (command.type === "oauth_set_credentials") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const cfg = getProviderConfig(provider);
        if (!cfg) { process.stdout.write(JSON.stringify({ type: "daemon_error", error: `oauth: unknown provider "${provider}"` }) + "\n"); continue; }
        const clientId = typeof command.clientId === "string" ? command.clientId.trim() : "";
        const clientSecret = typeof command.clientSecret === "string" ? command.clientSecret.trim() : "";
        if (!clientId || !clientSecret) { process.stdout.write(JSON.stringify({ type: "daemon_error", error: "oauth: clientId and clientSecret required" }) + "\n"); continue; }
        await setCredential(clientIdName(cfg), clientId, { home: live.context.home });
        await setCredential(clientSecretName(cfg), clientSecret, { home: live.context.home });
        process.stdout.write(JSON.stringify({ type: "oauth_credentials_set", provider }) + "\n");
        continue;
      }
      if (command.type === "oauth_start") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const cfg = getProviderConfig(provider);
        if (!cfg) { process.stdout.write(JSON.stringify({ type: "daemon_error", error: `oauth: unknown provider "${provider}"` }) + "\n"); continue; }
        // Spin up the loopback callback server, hand the consent URL to the UI to
        // open in the system browser, and emit the result. Fire-and-forget so the
        // command loop keeps serving while the owner authorizes.
        void startOAuthFlow({
          provider: cfg,
          home: live.context.home,
          onAuthorizeUrl: (url) => { process.stdout.write(JSON.stringify({ type: "oauth_url", provider, url }) + "\n"); },
          onSuccess: () => { process.stdout.write(JSON.stringify({ type: "oauth_connected", provider }) + "\n"); },
          onError: (err) => { process.stdout.write(JSON.stringify({ type: "oauth_error", provider, error: err.message }) + "\n"); },
        }).catch((err) => { process.stdout.write(JSON.stringify({ type: "oauth_error", provider, error: err instanceof Error ? err.message : String(err) }) + "\n"); });
        continue;
      }
      if (command.type === "oauth_disconnect") {
        const provider = typeof command.provider === "string" ? command.provider.trim().toLowerCase() : "";
        const cfg = getProviderConfig(provider);
        if (!cfg) { process.stdout.write(JSON.stringify({ type: "daemon_error", error: `oauth: unknown provider "${provider}"` }) + "\n"); continue; }
        await deleteCredential(`oauth/${cfg.provider}`, { home: live.context.home }).catch(() => {});
        process.stdout.write(JSON.stringify({ type: "oauth_disconnected", provider }) + "\n");
        continue;
      }
      let idleSteer = false;
      if (command.type === "steer") {
        // A steer is a canonical user input. It is admitted immediately and the
        // active engine claims it only at a settled model/tool boundary; no
        // provider or possibly-effectful tool is aborted to make it land.
        const text = typeof command.goal === "string" ? command.goal : typeof command.text === "string" ? command.text : "";
        if (!text.trim()) {
          tagEmit(command.sessionId, { type: "daemon_error", error: "steer requires text" });
          continue;
        }
        const requestedInputId = typeof command.inputId === "string" ? command.inputId.trim() : "";
        if (command.inputId !== undefined && (!requestedInputId || requestedInputId.length > 1_024)) {
          tagEmit(command.sessionId, { type: "daemon_error", error: "steer inputId must be 1-1024 characters" });
          continue;
        }
        // The registry is keyed by REAL session id; DEFAULT_SID is a lookup
        // sentinel handled only inside resolveEntry — sessions.get(DEFAULT_SID)
        // can never match, so an untagged steer silently skipped every
        // active-turn branch below.
        const entry = command.sessionId ? sessions.get(command.sessionId) : primaryEntry;
        if (entry?.turnActive) {
          if (entry.cancelRequested) {
            tagEmit(command.sessionId, {
              type: "input_rejected",
              inputId: requestedInputId || undefined,
              reason: "turn_cancelling",
              retryable: true,
            });
            continue;
          }
          if (entry.steeringPhase === "preparing") {
            bufferPreparingSteer(entry, command.sessionId, text.trim(), requestedInputId || `steer_${randomUUID()}`);
            continue;
          }
          if (entry.steeringPhase === "settling") {
            // The previous provider already committed its terminal boundary.
            // Durable FIFO turns this correction into the next ordinary turn;
            // admit it instead of bouncing a message the UI just showed as sent.
            admitSteer(entry, command.sessionId, text.trim(), requestedInputId || `steer_${randomUUID()}`);
            continue;
          }
          admitSteer(entry, command.sessionId, text.trim(), requestedInputId || `steer_${randomUUID()}`);
          continue;
        }
        // The process may have restarted between the UI submitting a steer and
        // receiving its acknowledgement. With no active generation, a steer is
        // defined to become the next ordinary turn; fall through to the normal
        // turn pipeline while retaining its durable delivery kind and input ID.
        idleSteer = true;
        command.type = "send";
        command.goal = text.trim();
      }
      if (command.type !== "send" || !command.goal) {
        tagEmit(command.sessionId, { type: "daemon_error", error: "expected {type:\"send\", goal:string}" });
        continue;
      }
      // Resolve (or lazily spawn) the target session. Then run the turn in the
      // BACKGROUND — the command loop keeps accepting commands so other sessions
      // stream concurrently and steer/interrupt land mid-turn.
      const sid = command.sessionId || DEFAULT_SID;
      const goal = command.goal;
      // Data URLs remain in `goal` until contentFromUserInput converts them to
      // provider image blocks. Routing, persona selection, reminders, and
      // durable reflection only need the semantic text and must never ingest
      // megabytes of base64 attachment bytes.
      const semanticGoal = semanticUserMessage(goal);
      const voiceMode = command.voice === true;
      const requestedInputId = typeof command.inputId === "string" ? command.inputId.trim() : "";
      if (command.inputId !== undefined && (!requestedInputId || requestedInputId.length > 1_024)) {
        tagEmit(command.sessionId, { type: "daemon_error", error: "send inputId must be 1-1024 characters" });
        continue;
      }
      const inputId = requestedInputId || `input_${randomUUID()}`;
      const entry = await resolveEntry(command.sessionId);
      const canonicalInput = (await openWorkspaceSessionKernel(entry.live.context.workspace)).getInput(inputId);
      if (canonicalInput && canonicalInput.sessionId !== entry.live.session.meta.id) {
        tagEmit(command.sessionId, {
          type: "daemon_error",
          error: `inputId ${inputId} already belongs to another session`,
        });
        continue;
      }
      const isSuccessorHandoff = entry.successorHandoff?.inputId === inputId;
      if (
        (canonicalInput?.state === "consumed" || canonicalInput?.state === "cancelled") &&
        !isSuccessorHandoff
      ) {
        const internalStartupRecovery = internalStartupRecoveryCommands.has(command);
        if (internalStartupRecovery && suppressedInternalRecoveryReplays.delete(inputId)) {
          // resolveEntry() may discover recovery while handling the Desktop's
          // same-ID replay, leaving one daemon-scheduled copy behind it. The
          // wire command already received the complete terminal lifecycle.
          continue;
        }
        // Exact-ID transport replay is a terminal acknowledgement, not a new
        // turn. Settle it before routing, reminders, persona/vision selection,
        // attachment parsing, or any other mutable preparation can run twice.
        tagEmit(command.sessionId, {
          type: "input_replayed",
          inputId,
          settled: true,
          delivery: canonicalInput.delivery,
          status: canonicalInput.state,
        });
        if (entry.turnActive) continue;

        const completesStartupRecovery = entry.startupRecoveryInputId === inputId;
        const settlesRequestedStartupStop = completesStartupRecovery && entry.startupRecoveryCancelRequested;
        if (completesStartupRecovery && !internalStartupRecovery) {
          suppressedInternalRecoveryReplays.add(inputId);
        }
        const queuedRecoveryIndex = entry.startupRecoveryQueue.findIndex((pending) => pending.inputId === inputId);
        if (queuedRecoveryIndex >= 0) entry.startupRecoveryQueue.splice(queuedRecoveryIndex, 1);
        if (completesStartupRecovery) {
          entry.startupRecoveryInputId = undefined;
          entry.startupRecoveryCancelRequested = false;
          await scheduleNextStartupRecovery(entry);
        }
        tagEmit(command.sessionId, {
          type: "turn_end",
          inputId,
          status: canonicalInput.state === "consumed" ? "completed" : "interrupted",
          workStatus: entry.live.session.lastWorkStatus,
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: 0,
        });
        if (settlesRequestedStartupStop) {
          tagEmit(command.sessionId, { type: "interrupt_settled", inputId });
        }
        tagEmit(command.sessionId, {
          type: "turn_settled",
          inputId,
          continuing: Boolean(entry.startupRecoveryInputId),
        });
        continue;
      }
      const canonicalPayload = canonicalInput?.payload;
      const canonicalTurnContent = canonicalPayload && typeof canonicalPayload === "object" && !Array.isArray(canonicalPayload)
        && Array.isArray((canonicalPayload as { content?: unknown }).content)
        ? (canonicalPayload as unknown as { content: ContentBlock[] }).content.map((block) => ({ ...block }))
        : null;
      if (
        !entry.turnActive &&
        entry.startupRecoveryInputId &&
        entry.startupRecoveryInputId !== inputId
      ) {
        const alreadyScheduled = entry.startupRecoveryQueue.some((pending) => pending.inputId === inputId);
        if (alreadyScheduled) {
          tagEmit(command.sessionId, {
            type: "input_replayed",
            inputId,
            settled: false,
            delivery: canonicalInput?.delivery ?? "queue",
            status: canonicalInput?.state ?? "admitted",
          });
        } else {
          // daemon_ready may prompt the UI to submit while lease takeover is
          // still normalizing the crashed generation. Requeue that fresh wire
          // command behind the exact recovered ID rather than letting it become
          // the owner of an older durable inbox head.
          commands.enqueue({ ...command });
        }
        continue;
      }
      if (entry.turnActive) {
        if (canonicalInput) {
          // This is a transport retry of an input the active Session already
          // owns. Changing queue<->steer would violate its idempotency contract;
          // the original generator/steering poll will settle it.
          tagEmit(command.sessionId, {
            type: "input_replayed",
            inputId,
            settled: false,
            delivery: canonicalInput.delivery,
            status: canonicalInput.state,
          });
          continue;
        }
        // A send mid-turn is the same durable steering path.
        if (entry.cancelRequested) {
          tagEmit(command.sessionId, {
            type: "input_rejected",
            inputId,
            reason: "turn_cancelling",
            retryable: true,
          });
          continue;
        }
        if (entry.steeringPhase === "preparing") {
          bufferPreparingSteer(entry, command.sessionId, goal.trim(), inputId);
          continue;
        }
        if (entry.steeringPhase === "settling") {
          admitSteer(entry, command.sessionId, goal.trim(), inputId);
          continue;
        }
        admitSteer(entry, command.sessionId, goal.trim(), inputId);
        continue;
      }
      const successorHandoff = isSuccessorHandoff
        ? entry.successorHandoff
        : undefined;
      // Deterministic fault window for the exact handoff regression. Production
      // never waits here; the hook only makes the otherwise tiny out-of-band
      // Stop interval reproducible in the daemon integration suite.
      const testSuccessorHandoffWindowMs = Number(process.env.ARES_TEST_DAEMON_SUCCESSOR_HANDOFF_WINDOW_MS ?? 0);
      if (
        successorHandoff &&
        Number.isFinite(testSuccessorHandoffWindowMs) &&
        testSuccessorHandoffWindowMs > 0
      ) {
        const deadline = Date.now() + Math.min(10_000, Math.floor(testSuccessorHandoffWindowMs));
        while (!successorHandoff.cancelRequested && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      }
      const inheritedHandoffCancellation = successorHandoff?.cancelRequested === true;
      const inputDelivery = canonicalInput?.delivery ?? (idleSteer ? "steer" : "queue");
      entry.turnActive = true;
      entry.activeInputId = inputId;
      // The fence for "background work THIS turn started" — what a Stop takes
      // down with it, leaving earlier jobs the user chose to keep alone.
      entry.turnStartedAt = Date.now();
      entry.cancelRequested = inheritedHandoffCancellation;
      // The Stop clock must start NOW for an inherited cancellation — a stale
      // timestamp from a previous Stop made the next Stop click an instant
      // force-kill ("since" measured from minutes ago).
      entry.cancelRequestedAt = inheritedHandoffCancellation ? Date.now() : undefined;
      entry.forceStopRequested = false;
      if (successorHandoff) entry.successorHandoff = undefined;
      entry.steeringPhase = "preparing";
      entry.activeToolIds.clear();
      activeTurns++;
      void (async () => {
        const ownerCancellationPending = (): boolean =>
          entry.cancelRequested && entry.activeInputId === inputId;
        // Deterministic fault window for the daemon regression suite. It is
        // inert unless explicitly enabled, and wakes as soon as Stop binds to
        // this exact pre-admission owner rather than delaying cancellation.
        const testPreAdmissionWindowMs = Number(process.env.ARES_TEST_DAEMON_PRE_ADMISSION_WINDOW_MS ?? 0);
        if (Number.isFinite(testPreAdmissionWindowMs) && testPreAdmissionWindowMs > 0) {
          const deadline = Date.now() + Math.min(10_000, Math.floor(testPreAdmissionWindowMs));
          while (!ownerCancellationPending() && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
        }
        // Auto routing is STICKY (S2): a model OWNS the conversation until the
        // task domain (lane) actually changes. No per-turn flip-flop and no
        // mid-conversation model swap — context and the prompt cache stay
        // coherent, so you never get quality/personality whiplash per message.
        // Remembered past the routing block so later emits (vision escalation)
        // know whether a lane tag is honest — a lane is a ROUTER decision and
        // manual mode ran no router.
        let turnRoutingMode: "auto" | "manual" = "manual";
        try {
          if (ownerCancellationPending()) throw new Error("owner cancelled before optional routing");
          const settings = await loadUiSettings();
          turnRoutingMode = settings.routingMode === "auto" ? "auto" : "manual";
          if (ownerCancellationPending()) throw new Error("owner cancelled during optional routing");
          const recentGoals = entry.live.session
            .history()
            .filter((message) => message.role === "user" && !message.content.some((block) => block.type === "tool_result"))
            .slice(-2)
            .map((message) => messageText(message));
          // The CURRENT message decides the lane. Folding recent history into
          // the classification made coding stick: two prior coding messages
          // kept classifying a fresh chat message as "coding", so the route
          // never flipped back. History now only breaks ties for short
          // follow-ups ("yes do it") that carry no lane signal of their own.
          const goalLane = classifyLane(semanticGoal);
          const lane = goalLane !== "chat"
            ? goalLane
            : semanticGoal.trim().split(/\s+/u).length < 8
              ? classifyLane([...recentGoals, semanticGoal].join("\n"))
              : "chat";
          let model = entry.live.selection.model;
          let providerName = providerFamilyForSelection(entry.live.selection);
          let source: "assigned" | "main" | "sticky" = "main";
          if (settings.routingMode === "auto") {
            const assigned = settings.routing?.[lane];
            const onAssigned = !!assigned && assigned.family === providerName && assigned.model === model;
            const laneChanged = entry.lane !== undefined && entry.lane !== lane;
            const firstTurn = entry.lane === undefined;
            // A dead current provider (auth/limit-parked) forfeits stickiness:
            // without this, a broken model owns the conversation forever and
            // the assigned route never gets a chance to take over.
            const currentDead = isProviderDead(providerName);
            // Switch when the domain genuinely changed (or on the very first
            // turn, or to escape a dead model) and there's a live assignment
            // for the lane. Otherwise the current model keeps the conversation.
            if (assigned?.family && assigned.model && !onAssigned && !isProviderDead(assigned.family) && (laneChanged || firstTurn || currentDead)) {
              try {
                if (ownerCancellationPending()) throw new Error("owner cancelled before route selection");
                const sel = await selectProvider(new Map([["provider", assigned.family], ["model", assigned.model]]));
                if (ownerCancellationPending()) throw new Error("owner cancelled during route selection");
                await preflightProviderSelection(sel);
                if (ownerCancellationPending()) throw new Error("owner cancelled during provider preflight");
                await entry.live.session.setProvider(sel.provider, sel.model, {
                  contextBudgetTokens: chatContextBudget(sel),
                  summarizeSpan: makeSpanSummarizer(sel, (usage) =>
                    entry.live.session.recordAuxiliaryUsage("compaction", sel.provider.name, sel.model, usage),
                  ),
                });
                entry.live.selection = sel;
                model = sel.model;
                providerName = providerFamilyForSelection(sel);
                source = "assigned";
              } catch {
                // bad family / missing key → keep the current model
              }
            } else if (onAssigned) {
              source = "assigned";
            } else {
              source = "sticky"; // staying on the model that already owns this conversation
            }
            if (!ownerCancellationPending()) entry.lane = lane;
          }
          if (!ownerCancellationPending()) {
            // The lane tag is a ROUTER decision. In manual mode no router ran —
            // advertising "CHAT"/"RESEARCH" on the badge made it look like one
            // had overridden the user's pick. Lane still drives internal
            // stickiness bookkeeping either way.
            tagEmit(command.sessionId, {
              type: "route_resolved",
              model,
              provider: providerName,
              ...(settings.routingMode === "auto" ? { lane } : {}),
              source,
            });
          }
        } catch {
          // best-effort — never block a turn on attribution
        }
        const turnState = { status: "completed" as "completed" | "interrupted" | "failed", fatalProvider: null as string | null };
        // Restore the user's pinned model after a one-turn vision escalation.
        let revertSelection: ProviderSelection | null = null;
        let escalatedSelection: ProviderSelection | null = null;
        try {
          if (!ownerCancellationPending()) {
            await prepareUserTurn(entry.live, semanticGoal);
          }
          // Persona triggers. Runs BEFORE the prompt is sent so an "auto"
          // persona is worn for the very turn that summoned it. It never
          // overrides a persona already in play, and it always emits an event —
          // the owner sees the switch (and can revert) rather than wondering why
          // the tone changed.
          const autoPersona = ownerCancellationPending()
            ? null
            : await personaForMessage(entry.live, semanticGoal, (payload) => tagEmit(sid, payload), entry.personaGate).catch(() => null);
          if (autoPersona && !ownerCancellationPending()) {
            entry.live.queueSystemReminder(
              `You are now wearing the ${autoPersona.label} persona (matched from the owner's message). Open your reply by greeting them briefly in that persona's voice — one or two sentences — so they know who they're talking to, then get to work. If they ask you to drop it, call Persona with action:"release".`,
              "instructions",
            );
          }
          // ── Vision guard: never ship a pasted image to a blind model. ──
          // A pinned text-only model (deepseek et al) used to receive the image
          // blocks anyway and answer "can't view the image" or guess blind
          // (sess_e4c6022d). If this turn carries images and the active model
          // lacks vision, escalate JUST this turn to a vision-capable provider
          // (never off the Ares Gateway), or tell the model to be honest.
          // An idempotent retry must submit byte/shape-equivalent content. In
          // particular, an image-bearing steer was originally admitted as one
          // text block; reparsing it as a fresh desktop message would conflict
          // with the canonical payload even though the input ID was identical.
          const turnContent = canonicalTurnContent ?? await contentFromUserInput(goal, entry.live.context.workspace);
          if (voiceMode && !canonicalTurnContent) turnContent.unshift({ type: "system_reminder", text: "<voice-mode/>" });
          const hasImages = turnContent.some((block) => block.type === "image");
          if (!ownerCancellationPending() && hasImages && !modelLikelyHasVision(entry.live.selection.model)) {
            const pinned = entry.live.selection;
            const visionSel = await pickVisionFallback(pinned, liveDeadProviders()).catch(() => null);
            if (visionSel && !ownerCancellationPending()) {
              await entry.live.session.setProvider(visionSel.provider, visionSel.model, {
                contextBudgetTokens: chatContextBudget(visionSel),
                summarizeSpan: makeSpanSummarizer(visionSel, (usage) =>
                  entry.live.session.recordAuxiliaryUsage("compaction", visionSel.provider.name, visionSel.model, usage),
                ),
              });
              entry.live.selection = visionSel;
              revertSelection = pinned;
              escalatedSelection = visionSel;
              tagEmit(sid, {
                type: "system_reminder_injected",
                source: "instructions",
                text: `Image attached — ${pinned.model} can't see images, so this turn runs on ${visionSel.provider.name}/${visionSel.model}. Your model choice is restored next turn.`,
              });
              tagEmit(sid, {
                type: "route_resolved",
                model: visionSel.model,
                provider: visionSel.provider.name,
                ...(turnRoutingMode === "auto" ? { lane: entry.lane ?? "chat" } : {}),
                source: "assigned",
              });
            } else {
              entry.live.queueSystemReminder(
                `The user attached an image, but the current model (${pinned.model}) cannot see images and no vision-capable provider is configured. Say so plainly, describe what you'd need (a vision model — e.g. Claude, GPT-4o, or Gemini — selected in the model picker), and work from the user's text only. Do NOT guess at the image's contents.`,
                "instructions",
              );
            }
          }
          // tool_end carries only `id`, so the name has to be remembered from
          // tool_start. Turn-scoped (not per-generator) because a steer can
          // interrupt between the two halves of one tool call.
          const toolNamesById = new Map<string, string>();
          let promotedSteerApplied = false;
          const streamOnce = async (gen: AsyncGenerator<unknown>) => {
            let eventCount = 0;
            for await (const event of gen) {
              eventCount++;
              const ev = event as { type: string; status?: "completed" | "interrupted" | "failed"; error?: { code?: string; message?: string }; touchedFiles?: string[]; text?: string; id?: string; name?: string; output?: unknown };
              trackSteeringBoundary(entry, ev);
              if (ev.type === "turn_start" && inputDelivery === "steer" && !promotedSteerApplied) {
                promotedSteerApplied = true;
                tagEmit(sid, { type: "steer_applied", inputId, status: "claimed" });
              }
              if (ev.type === "tool_start" && ev.id && ev.name) toolNamesById.set(ev.id, ev.name);
              // Persona adopt/release: the tool itself only validates and echoes
              // (it has no session handle), so the daemon is what actually swaps
              // the prompt layer. Doing it here — rather than inside the tool —
              // is also what lets the swap take effect on the NEXT turn while
              // this one keeps running with the belt it started with.
              if (ev.type === "tool_end" && ev.id && toolNamesById.get(ev.id) === "Persona") {
                toolNamesById.delete(ev.id);
                applyPersonaToolResult(entry.live, ev.output, (payload) => tagEmit(sid, payload), entry.personaGate);
              }
              // Continuous verification, daemon path: every edited file feeds the
              // verifier (same as the chat paths); the engine's end-of-turn gate
              // settles it and refuses "done" over red verdicts.
              if (ev.touchedFiles?.length) entry.live.verifier.scheduleFor(ev.touchedFiles);
              if (ev.type === "turn_end" && ev.status) turnState.status = ev.status;
              if (ev.type === "error" && isProviderFatalError(ev.error)) {
                turnState.fatalProvider = `${ev.error?.code ?? "provider_error"}: ${ev.error?.message ?? ""}`.slice(0, 200);
              }
              tagEmit(sid, event as Record<string, unknown>);
            }
            return eventCount;
          };
          let ownerAdmitted = false;
          const unsubscribeOwnerAdmission = entry.live.session.observeEvents((event) => {
            if (ownerAdmitted || event.type !== "input_admitted" || event.inputId !== inputId) return;
            ownerAdmitted = true;
            // Session reserves the owner's FIFO ticket in the same continuation
            // immediately after this observer. Flushing here cannot overtake it:
            // each buffered steer begins on a later microtask.
            queueMicrotask(() => flushPreparingSteers(entry));
          });
          let initialEventCount: number;
          try {
            initialEventCount = await streamOnce(
              entry.live.session.sendContent(turnContent, {
                inputId,
                delivery: inputDelivery,
                recoverExistingInput: entry.startupRecoveryInputId === inputId,
              }),
            );
          } finally {
            unsubscribeOwnerAdmission();
          }
          if (initialEventCount === 0) {
            // The stable input already completed before a desktop/daemon retry.
            // Acknowledge it without calling the provider, re-running post-turn
            // learning, or leaving the restarted UI spinner busy forever.
            tagEmit(sid, { type: "input_replayed", inputId, settled: true, status: canonicalInput?.state ?? "consumed" });
            tagEmit(sid, {
              type: "turn_end",
              status: "completed",
              workStatus: entry.live.session.lastWorkStatus,
              usage: { inputTokens: 0, outputTokens: 0 },
              durationMs: 0,
            });
            return;
          }

          // Let the integration suite deterministically submit a correction
          // after the engine's terminal fence but before host settlement. This
          // is inert in production and exercises the deferred-successor path,
          // not the easier live-generation steering path.
          if (
            !successorHandoff &&
            entry.settledSteerInputIds.size === 0 &&
            Number.isFinite(testSuccessorHandoffWindowMs) &&
            testSuccessorHandoffWindowMs > 0
          ) {
            const deadline = Date.now() + Math.min(10_000, Math.floor(testSuccessorHandoffWindowMs));
            while (
              entry.pendingSteerInputIds.size === 0 &&
              entry.deferredSteers.size === 0 &&
              Date.now() < deadline
            ) {
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
            }
          }

          // Self-healing fallback: if the turn died because the current provider
          // is unauthenticated / out of balance / unreachable, walk healthy
          // providers until one actually completes the turn — not just one hop.
          // Dead-on-balance providers are remembered so later turns skip them.
          // A force-released turn has already been settled for the user — its
          // late unwind must not run failover (setProvider/resumeTurn against
          // an entry a successor may own) or post-turn bookkeeping.
          if (entry.zombieTurnInputIds?.has(inputId)) return;
          let fallbackHops = 0;
          // Without this set, two congested siblings ping-pong A→B→A→B for all
          // four hops — four full re-runs of an already-slow turn.
          const triedCapacityModels = new Set<string>([entry.live.selection.model]);
          while (turnState.status === "failed" && turnState.fatalProvider && fallbackHops < 4) {
            fallbackHops++;
            // The provider that just failed: if it's a balance/auth death, retire
            // it for the session so we never waste another turn on it.
            if (isPermanentlyDeadError(turnState.fatalProvider)) {
              markProviderDead(providerFamilyForSelection(entry.live.selection));
            }
            const routingMode = (await loadUiSettings().catch(() => ({ routingMode: "manual" as const }))).routingMode;
            const overloaded = /overloaded|capacity|\b529\b|server is busy|service unavailable|temporarily unavailable/i.test(turnState.fatalProvider);
            // The pin is SACRED on manual routing (the opencode doctrine: retry
            // patiently, surface the wait, and let the OWNER decide any model
            // change). The old capacity-sibling slide "respected the pin" by
            // switching it — which read as the model changing on its own. The
            // engine already rode out its ~95s capacity ladder before reaching
            // here; on manual we stop and say so instead of switching.
            const fallback = routingMode !== "auto"
              ? null
              : (overloaded ? await pickCapacitySibling(entry.live.selection, triedCapacityModels).catch(() => null) : null) ??
                (await pickHealthyFallback(entry.live.selection, liveDeadProviders(), {
                  allowCrossProvider: true,
                }).catch(() => null));
            if (!fallback) {
              const onAres = providerFamilyForSelection(entry.live.selection) === "ares";
              tagEmit(sid, {
                type: "system_reminder_injected",
                source: "instructions",
                text: overloaded
                  ? `${entry.live.selection.model} stayed overloaded through every retry, and no other model on ${providerFamilyForSelection(entry.live.selection)} is available to take it. This is upstream congestion, not a problem with your setup or your message — send it again in a minute, or switch model in the status bar.`
                  : onAres
                  ? `Your Ares account couldn't run this turn (${turnState.fatalProvider}). Check your credits and granted models at doingteam.com → Account — you won't be switched to another provider's key.`
                  : routingMode !== "auto"
                    ? `Pinned provider ${providerFamilyForSelection(entry.live.selection)}/${entry.live.selection.model} failed (${turnState.fatalProvider}). The selection was kept. Enable Auto routing if you want cross-provider failover.`
                    : `All configured providers failed (${turnState.fatalProvider}). Add credit or a working API key in Settings → API Keys.`,
              });
              break;
            }
            await entry.live.session.setProvider(fallback.provider, fallback.model, {
              contextBudgetTokens: chatContextBudget(fallback),
              summarizeSpan: makeSpanSummarizer(fallback, (usage) =>
                entry.live.session.recordAuxiliaryUsage("compaction", fallback.provider.name, fallback.model, usage),
              ),
            });
            const overloadedModel = entry.live.selection.model;
            // Read the FAILED family before the selection is replaced — reading
            // it after resolved to the fallback's family, so the toast told the
            // user the WRONG provider's key was rejected and sent them to
            // replace a key that was fine.
            const failedFamily = providerFamilyForSelection(entry.live.selection);
            triedCapacityModels.add(fallback.model);
            entry.live.selection = fallback;
            // Deliberately NOT persisted to mainSelection: a failover is a
            // per-session rescue, never a change to the owner's default. The
            // old persistence is how "models switch by themselves" happened —
            // one bad night rewrote the daemon default, and every later card
            // inherited the switch. Dead-provider memory (markProviderDead)
            // already prevents re-running the gauntlet on every turn.
            // An auth/key death deserves a plain-language diagnosis, not the raw
            // upstream JSON blob — the owner's next action is "fix the key in
            // Settings", and the message should say so (the mid-landscape
            // OpenRouter-401 session surfaced the raw error and read as a crash).
            const authDead = isPermanentlyDeadError(turnState.fatalProvider);
            tagEmit(sid, {
              type: "system_reminder_injected",
              source: "instructions",
              text: overloaded
                ? `${overloadedModel} is overloaded upstream — finishing this turn on ${fallback.model} instead. Your pinned model is unchanged and the next message will use it again.`
                : authDead
                ? `The ${failedFamily} API key was rejected (invalid, expired, or out of credit) — it's retired for this session and the turn is continuing on ${providerFamilyForSelection(fallback)}/${fallback.model}. To use ${failedFamily} again, paste a fresh key in Settings → API Keys.`
                : `Provider failed (${turnState.fatalProvider}). Auto routing switched to ${providerFamilyForSelection(fallback)}/${fallback.model}.`,
            });
            tagEmit(sid, {
              type: "route_resolved",
              model: fallback.model,
              provider: providerFamilyForSelection(fallback),
              ...(routingMode === "auto" ? { lane: entry.lane ?? "chat" } : {}),
              // "failover" (not "assigned"): unlike a one-turn vision detour,
              // a failover durably changes the session's live selection — the
              // footer's pinned readout must follow it.
              source: "failover",
            });
            // Reset and re-run; if THIS one also fails fatally the loop continues.
            turnState.status = "completed";
            turnState.fatalProvider = null;
            await streamOnce(entry.live.session.resumeTurn());
          }
          // Post-turn settling (verifier/journal/memory). On a CANCELLED turn
          // this sits directly on the "stopping safely" path — bound it so
          // bookkeeping can never outlive the Stop; the detached remainder
          // still lands its writes whenever it finishes.
          if (ownerCancellationPending()) {
            await Promise.race([
              finishTurn(entry.live, turnState.status).catch(() => undefined),
              new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 15_000);
                timer.unref?.();
              }),
            ]);
          } else {
            // Normal completions get a generous bound too: post-turn settling
            // (witness/verifier/journal) sits between the visible reply and
            // turn_settled — a half-open socket here left the card "working"
            // forever after the answer was already on screen.
            await Promise.race([
              finishTurn(entry.live, turnState.status).catch(() => undefined),
              new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 60_000);
                timer.unref?.();
              }),
            ]);
          }
          // A completed turn may have landed a commit — reflect it into the war
          // map. Fire-and-forget; reflection never delays or breaks the turn.
          if (turnState.status === "completed" && (entry.live.session.lastWorkStatus === "verified" || entry.live.session.lastWorkStatus === "not_applicable")) {
            void reflectAfterTurn(semanticGoal).catch(() => {});
            // Learn from the conversation too — durable facts/preferences → memory.
            void reflectConversationAfterTurn(entry, sid).catch(() => {});
          }
        } catch (err) {
          turnState.status = "failed";
          // A force-released turn already told the surface it settled; stale
          // failure events from its late unwind would contradict that.
          if (!entry.zombieTurnInputIds?.has(inputId)) {
            tagEmit(command.sessionId, { type: "error", error: { code: "turn_throw", message: err instanceof Error ? err.message : String(err), retriable: false } });
            tagEmit(command.sessionId, { type: "turn_end", status: "failed", usage: {}, durationMs: 0 });
          }
        } finally {
          // Zombie unwind after a force-release: the daemon has already settled
          // this turn and released (possibly evicted/rehydrated) the entry — a
          // successor may own it now. Touching entry state or emitting
          // settlement events here would corrupt that successor. Drop out.
          if (entry.zombieTurnInputIds?.delete(inputId)) return;
          // Everything before the state-reset tail below is best-effort and can
          // THROW OR AWAIT: a momentarily locked kernel DB (Defender/OneDrive)
          // used to abort this finally before turnActive was cleared — the card
          // stayed "working" forever and only an app restart recovered. The
          // reset tail must run no matter what happens in here.
          let settlementRecoveryScheduled = false;
          const deferredCommands: Array<{ text: string; sessionId?: string; inputId: string }> = [];
          try {
          // A vision escalation was for THIS turn only — hand the conversation
          // back to the user's pinned model. If the failover loop replaced the
          // model mid-turn (provider death), its choice wins — don't revert onto
          // a pin that may itself be part of the problem.
          if (revertSelection && escalatedSelection && entry.live.selection === escalatedSelection) {
            try {
              const pinned = revertSelection;
              await entry.live.session.setProvider(pinned.provider, pinned.model, {
                contextBudgetTokens: chatContextBudget(pinned),
                summarizeSpan: makeSpanSummarizer(pinned, (usage) =>
                  entry.live.session.recordAuxiliaryUsage("compaction", pinned.provider.name, pinned.model, usage),
                ),
              });
              entry.live.selection = pinned;
            } catch {
              // keep the vision model rather than kill the session
            }
          }
          // Core deliberately requeues failed inputs so explicit resumeTurn()
          // remains possible for non-daemon hosts. This daemon has already
          // exhausted its live retry/failover policy and is about to unlock the
          // Desktop, so leaving that owner admitted would strand every later
          // queue input behind a row with no runner. Make the explicit failed
          // boundary terminal here; canonical messages/effects remain in the
          // ledger and a fresh user message can continue from them safely.
          if (turnState.status === "failed") {
            const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
            const failedOwner = kernel.getInput(inputId);
            if (failedOwner?.state === "admitted" || failedOwner?.state === "claimed") {
              try {
                kernel.cancelInput(inputId, {
                  sessionId: entry.live.session.meta.id,
                  ...(failedOwner.state === "claimed" && failedOwner.claimedGeneration !== null
                    ? { expectedGeneration: failedOwner.claimedGeneration }
                    : {}),
                  reason: {
                    code: "DAEMON_TURN_FAILED",
                    message: "The hosted turn exhausted retry/failover and reached an explicit failed boundary",
                  },
                });
              } catch (settlementError) {
                // Never unlock over an unowned queue head. Rebind the exact ID
                // to the ordinary recovery pipeline; the next wrapper either
                // settles it or keeps the UI truthfully busy.
                settlementRecoveryScheduled = true;
                entry.startupRecoveryInputId = inputId;
                commands.enqueue({ type: "send", goal, sessionId: command.sessionId, inputId });
                tagEmit(command.sessionId, {
                  type: "input_settlement_retry",
                  inputId,
                  error: settlementError instanceof Error ? settlementError.message : String(settlementError),
                });
              }
            }
          }
          // Preparation can fail before the owner input reaches its SQLite
          // admission fence. Corrections buffered behind that fence must return
          // to their exact drafts instead of surviving as invisible memory.
          for (const [bufferedInputId, buffered] of entry.preparingSteers) {
            tagEmit(buffered.sessionId, {
              type: "steer_rejected",
              inputId: bufferedInputId,
              reason: "owner_not_admitted",
              retryable: true,
              error: "the active turn ended before its input admission boundary",
            });
          }
          entry.preparingSteers.clear();
          // Admission tasks never own a run lease. Drain only their parse +
          // SQLite routing fences, then decide synchronously which corrections
          // the owner consumed and which must re-enter the ordinary turn runner.
          while (entry.pendingSteerTasks.size > 0) {
            await Promise.allSettled([...entry.pendingSteerTasks.values()]);
          }
          if (entry.deferredSteers.size > 0) {
            const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
            let nextDeferredChosen = false;
            for (const [deferredInputId, deferred] of entry.deferredSteers) {
              const state = kernel.getInput(deferredInputId)?.state;
              if (state === "consumed" || state === "cancelled") {
                announceSteerTerminal(entry, deferred.sessionId, deferredInputId, state);
                entry.deferredSteers.delete(deferredInputId);
              } else if (state === "admitted" || state === "claimed") {
                // The daemon runner itself is single-owner. Queue only the first
                // canonical correction now; later rows remain ordered in this
                // map and the promoted turn's own finally schedules the next.
                if (!nextDeferredChosen) {
                  nextDeferredChosen = true;
                  deferredCommands.push({ ...deferred, inputId: deferredInputId });
                  entry.deferredSteers.delete(deferredInputId);
                }
              } else {
                tagEmit(deferred.sessionId, {
                  type: "steer_epilogue_warning",
                  inputId: deferredInputId,
                  status: state ?? "missing",
                  retryable: true,
                  error: "durable steer could not be found at owner settlement",
                });
                entry.deferredSteers.delete(deferredInputId);
              }
            }
          }
          } catch (settleErr) {
            // Never let settlement bookkeeping wedge the session — log to
            // stderr (surfaces as daemon_stderr) and fall through to the reset.
            console.error(`post-turn settlement error (input ${inputId}): ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`);
          }
          // Zombie check #2: the force-release timer may have fired DURING the
          // awaits above — it already reset the entry, decremented activeTurns,
          // emitted settlement, and possibly evicted this entry while a
          // successor took over. Running the tail now would double-decrement
          // and clear the successor's state out from under it.
          if (entry.zombieTurnInputIds?.delete(inputId)) return;
          const completedStartupRecovery = entry.startupRecoveryInputId === inputId;
          const startupRecoveryWasCancelled = completedStartupRecovery && entry.startupRecoveryCancelRequested;
          const cancelledInputId = entry.cancelRequested
            ? entry.activeInputId
            : startupRecoveryWasCancelled
              ? inputId
              : undefined;
          const deferredSuccessor = deferredCommands[0];
          if (deferredSuccessor) {
            entry.successorHandoff = {
              inputId: deferredSuccessor.inputId,
              sessionId: deferredSuccessor.sessionId,
              cancelRequested: false,
            };
          }
          entry.turnActive = false;
          entry.activeInputId = undefined;
          entry.cancelRequested = false;
          // Stale Stop bookkeeping made the NEXT turn's first Stop click an
          // instant force-kill: `since` was computed from a timestamp left over
          // from a Stop that settled normally minutes earlier.
          entry.cancelRequestedAt = undefined;
          entry.forceStopRequested = false;
          entry.steeringPhase = "idle";
          entry.activeToolIds.clear();
          activeTurns--;
          if (cancelledInputId) {
            tagEmit(command.sessionId, { type: "interrupt_settled", inputId: cancelledInputId });
          }
          if (completedStartupRecovery && !settlementRecoveryScheduled) {
            entry.startupRecoveryInputId = undefined;
            entry.startupRecoveryCancelRequested = false;
          }
          // Poison-pill guard: a RECOVERED input that died on a non-retriable
          // provider rejection (400 invalid_request, 401/403 auth) will die
          // identically on every future boot — the same GameFPS input re-ran
          // and failed on four consecutive daemon starts across 16 hours.
          // Cancel it durably so recovery stops resurrecting it; transient
          // failures (rate limits, capacity) keep their retry-next-boot value.
          if (
            completedStartupRecovery &&
            turnState.status === "failed" &&
            turnState.fatalProvider &&
            /\b40[013]\b|invalid_request|invalid_authentication|unauthorized|forbidden|invalid.?api.?key/i.test(turnState.fatalProvider)
          ) {
            try {
              const kernel = await openWorkspaceSessionKernel(entry.live.context.workspace);
              kernel.cancelInput(inputId, {
                sessionId: entry.live.session.meta.id,
                reason: { kind: "startup_recovery_poison", error: turnState.fatalProvider.slice(0, 500) },
              });
              tagEmit(command.sessionId, {
                type: "system_reminder_injected",
                source: "instructions",
                text: `A recovered request from a previous run kept failing with a permanent provider error and has been cancelled (${turnState.fatalProvider.slice(0, 160)}). Re-send it if you still want it.`,
              });
            } catch {
              // Couldn't cancel (e.g. claimed under a live generation) — the
              // next boot may retry once more; never break turn settlement.
            }
          }
          // Same command path as a fresh owner turn: routing, vision escalation,
          // persona, recall, failover, verification, and journaling all run.
          for (const deferred of deferredCommands) {
            commands.enqueue({
              type: "send",
              goal: deferred.text,
              sessionId: deferred.sessionId,
              inputId: deferred.inputId,
            });
          }
          try {
            await scheduleNextStartupRecovery(entry);
          } catch (recoveryErr) {
            // Recovery scheduling must never block turn_settled below.
            console.error(`startup-recovery scheduling error: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`);
          }
          // Whatever the turn left running is now the user's to see. This is the
          // event the background panel folds; a turn that walks away from a live
          // job can no longer do it quietly.
          emitBackgroundJobs(command.sessionId, entry);
          tagEmit(command.sessionId, {
            type: "turn_settled",
            inputId,
            continuing: settlementRecoveryScheduled || deferredCommands.length > 0 || Boolean(entry.startupRecoveryInputId),
          });
          // Event-first autonomy, finally with a producer. A settled turn is the
          // moment the operator should look again — the workspace just changed
          // under it. Until now the ONLY wake was the fallback heartbeat, up to
          // thirty minutes out, so "Ares notices" meant "Ares notices after
          // lunch". Watcher cadences still rate-limit the probes; this only
          // decides WHEN the loop gets to check them.
          //
          // If another session is still mid-turn the pause gate parks this wake,
          // and the queue holds it for the tick that actually runs.
          autotickLoop?.enqueueEvent({ kind: "turn_settled", sessionId: command.sessionId, inputId });
        }
      })().catch((err) => {
        // Absolute backstop: the runner's own try/catch/finally should make
        // this unreachable, but a detached rejection here used to be silent.
        console.error(`turn runner escaped its guards: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      });
    }
  } finally {
    setExtensionBrowserBridge(null);
    await browserExtensionBridge?.close().catch(() => undefined);
    autotickLoop?.stop();
    uninstallCrashHandlers();
    commands.close();
    rl.close();
    unsubscribeLifecycle();
    try {
      unsubscribeGatewayMirror?.();
    } catch {
      // best-effort mirror teardown
    }
    // Tear down every session (the primary owns the shared mind loop).
    const allEntries = sessions.size > 0 ? [...sessions.values()] : [primaryEntry];
    // NOTHING OUTLIVES THE HOST. Background supervisors are detached and
    // unref'd — closing Ares used to leave them running forever, invisible,
    // with no window to stop them from. That is how a dev server kept
    // relaunching a game for days after the app was closed. Stop them here,
    // marked resumable, so picking the session back up OFFERS the work instead
    // of it having never stopped.
    await suspendBackgroundWork("Ares closed", allEntries);
    for (const entry of allEntries) {
      try {
        await disposeLiveSession(entry.live);
      } catch {
        // best-effort teardown
      }
    }
    await mindSessionEnded();
    rl.close();
  }
  return 0;
}
