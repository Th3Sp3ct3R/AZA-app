import path from "node:path";
import { aresAgentHome } from "./paths.js";
import { ensureAgentScaffold, bootstrapReminder } from "./bootstrap/bootstrap.js";
import { loadAgentConfig, type AresAgentConfig } from "./config.js";
import { composeAgentSystemPrompt, loadAgentSystemContext, type AgentSystemContext } from "./identity/context.js";
import { runLightDream } from "./dreaming.js";
import { MemoryStore as LivingMemoryStore, mindPaths, withConsolidationLock } from "@ares/mind";
import { heartbeatEveryMs, heartbeatPass } from "./heartbeat.js";
import { ReflectionScheduler } from "./reflection/scheduler.js";
import { emitLifecycle } from "./lifecycle/bus.js";
import { captureUserMessage } from "./capture.js";
import { snapshotBrain } from "./persistence.js";
import { renderPersonaLayer, type PersonaDef } from "./roster.js";

export interface PreparedAgent {
  enabled: boolean;
  home: string;
  config: AresAgentConfig;
  context: AgentSystemContext;
  startupReminders: Array<{ text: string; source: "memory" | "instructions" }>;
  composeSystemPrompt(base: string): string;
  /** The persona currently worn, or null for plain Ares. */
  activePersona(): PersonaDef | null;
  /**
   * Wear a persona (or null to drop it). Read at compose time rather than
   * baked into the closure, so adoption takes effect on the very next turn in
   * every channel — desktop, TUI, and Telegram all go through
   * composeSystemPrompt, so there is one place to change and no per-channel
   * plumbing to forget.
   */
  setPersona(persona: PersonaDef | null): void;
}

export async function prepareAresAgent(opts: {
  home?: string;
  workspace: string;
  includeMemory?: boolean;
  enabled?: boolean;
}): Promise<PreparedAgent> {
  const enabled = opts.enabled ?? process.env.ARES_AGENT_ENABLED !== "0";
  const home = aresAgentHome(opts.home);
  const config = await loadAgentConfig(home);
  // Mutable across turns — see PreparedAgent.setPersona.
  let persona: PersonaDef | null = null;
  const personaSlot = {
    activePersona: () => persona,
    setPersona: (next: PersonaDef | null) => {
      persona = next;
    },
  };
  if (!enabled) {
    const context = await loadAgentSystemContext({ home, workspace: opts.workspace, includeMemory: false });
    return { enabled: false, home, config, context, startupReminders: [], composeSystemPrompt: (base) => base, ...personaSlot };
  }

  await ensureAgentScaffold({ home, workspace: opts.workspace });
  const context = await loadAgentSystemContext({ home, workspace: opts.workspace, includeMemory: opts.includeMemory ?? true });
  const bootstrap = await bootstrapReminder(home);
  const startupReminders = bootstrap
    ? [{ text: bootstrap, source: "instructions" as const }]
    : [];

  return {
    enabled: true,
    home,
    config,
    context,
    startupReminders,
    composeSystemPrompt: (base) =>
      composeAgentSystemPrompt(base, context, {
        personaLayer: persona ? renderPersonaLayer(persona, context.agentName) : undefined,
      }),
    ...personaSlot,
  };
}

export class AresAgentRuntime {
  /** The ONE reflection scheduler: owns the heartbeat timer AND the session-end
   *  reflection passes (light dream, consolidate). No pass owns its own timer. */
  private scheduler: ReflectionScheduler | undefined;

  constructor(
    readonly prepared: PreparedAgent,
    private readonly opts: {
      workspace: string;
      sessionId: string;
      queueReminder: (text: string, source: "memory" | "instructions" | "self-revise") => void;
    },
  ) {}

  start(): void {
    if (!this.prepared.enabled) return;
    emitLifecycle({ type: "session_started", sessionId: this.opts.sessionId, workspace: this.opts.workspace });
    // Snapshot the agent's brain at session start so post-bootstrap drift
    // or accidental corruption can always be rolled back. Runs in the
    // background — never blocks the session loop.
    void snapshotBrain({ home: this.prepared.home, id: `snap_${this.opts.sessionId}` }).catch(() => undefined);

    const scheduler = new ReflectionScheduler();
    scheduler.register("interval", "heartbeat", heartbeatPass({
      home: this.prepared.home,
      workspace: this.opts.workspace,
      config: this.prepared.config,
      // Heartbeat alerts are AMBIENT background signals, never user requests.
      // Label them so a weak model doesn't treat them as a task to act on.
      onAlert: (text) =>
        this.opts.queueReminder(
          `BACKGROUND SIGNAL (ambient self-check — not a request, do not act on it unless it bears on the user's current message): ${text}`,
          "memory",
        ),
    }));
    this.registerSessionEndPasses(scheduler);
    scheduler.start(heartbeatEveryMs(this.prepared.config));
    this.scheduler = scheduler;
  }

  /** Session-end reflection: stage 1 distills the transcript into dream
   *  candidates; stage 2 consolidates the living store — prune faded
   *  episodics, dedupe, promote themes. Without a scheduled invoker the store
   *  grows append-only and the dedupe/theme passes never fire (3-month rot). */
  private registerSessionEndPasses(scheduler: ReflectionScheduler): void {
    scheduler.register("sessionEnd", "light-dream", async () => {
      await runLightDream({
        home: this.prepared.home,
        workspace: this.opts.workspace,
        sessionId: this.opts.sessionId,
        transcriptPath: this.transcriptPath ?? path.join(this.opts.workspace, ".ares", "sessions", this.opts.sessionId, "events.jsonl"),
        config: this.prepared.config,
      }).catch(() => undefined);
    });
    scheduler.register("sessionEnd", "consolidate", async ({ now }) => {
      const memoryFile = mindPaths(this.prepared.home).memoryFile;
      // Cross-process lock: daemon + garrison both reflect over the same
      // ~/.ares — a concurrent consolidate() from another process would
      // clobber this one's persist(). Skipping under contention is safe.
      await withConsolidationLock(memoryFile, async () => {
        const store = await LivingMemoryStore.open(memoryFile);
        await store.consolidate({ now });
      }).catch(() => undefined);
    });
  }

  stop(): void {
    this.scheduler?.stop();
    this.scheduler = undefined;
    emitLifecycle({ type: "session_ended", sessionId: this.opts.sessionId });
  }

  async beforeTurn(userMessage: string): Promise<void> {
    if (!this.prepared.enabled) return;
    emitLifecycle({ type: "turn_started", sessionId: this.opts.sessionId, userMessage });

    // Auto-capture: scan every user message for durable signals and write them
    // to today's raw memory log so the agent sees them on next context load.
    // Runs even pre-bootstrap so the birth conversation gets logged too.
    await captureUserMessage({ home: this.prepared.home, userMessage }).catch(() => null);

    // Recall is no longer done here. The live turn reads memory through the
    // single `unifiedRecallForTurn` interface (v6 living memory + this v4 vector
    // store, merged into one reminder) so both substrates are never queried —
    // and never surfaced — as two disconnected stores again.
  }

  async afterTurn(status: "completed" | "interrupted" | "failed"): Promise<void> {
    if (!this.prepared.enabled) return;
    emitLifecycle({ type: "turn_ended", sessionId: this.opts.sessionId, status });
  }

  async sessionEnded(transcriptPath?: string): Promise<void> {
    if (!this.prepared.enabled || !this.prepared.config.dreaming.enabled) return;
    this.transcriptPath = transcriptPath;
    // A runtime that was never start()ed (some sessions skip the heartbeat)
    // still reflects through the single scheduler path — a transient, timerless
    // scheduler with the same passes, fired once.
    let scheduler = this.scheduler;
    if (!scheduler) {
      scheduler = new ReflectionScheduler();
      this.registerSessionEndPasses(scheduler);
    }
    await scheduler.fire("sessionEnd");
  }

  private transcriptPath: string | undefined;
}
