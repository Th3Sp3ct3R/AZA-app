// Vanguard drive mode — a second engine behind the same Ares cockpit.
//
// When a session's Vanguard mode is on, its sends are driven by the embedded
// VanguardEngine instead of the legacy turn pipeline, using the SAME Ares
// session identity, workspace, and current model selection. Vanguard's
// sanitized public events are translated into the daemon's native event
// vocabulary (turn_start / text_delta / thinking_delta / tool_start /
// tool_end / turn_end) tagged with the Ares session id, so the existing
// transcript renders a Vanguard turn exactly like any other — it just says
// Vanguard on the tin.
//
// The engine loads lazily on first use, so Ares boots and runs normally when
// the vanguard package is missing; the failure surfaces as a turn error.

import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface EngineModule {
  VanguardEngine: new (options: { logger?: (line: string) => void; runner?: unknown }) => VanguardEngineLike;
  CliVanguardRunner: new (cliFile?: string) => unknown;
  supportsOAuth: (provider: string) => boolean;
  oauthStatus: (provider: string) => Promise<{ connected: boolean }>;
  credentialVariable: (provider: string) => string;
  saveAnthropicTokens: (tokens: { accessToken: string; refreshToken: string; expiresAt: number; scopes?: readonly string[] }) => Promise<void>;
}

/**
 * The engine's session workers are real child processes spawned from
 * Vanguard's cli.js. When the daemon runs as an esbuild bundle, the engine's
 * own relative default (next to the inlined module) does not exist on disk,
 * so the worker entry is resolved explicitly:
 *   1. ARES_VANGUARD_CLI — explicit override;
 *   2. runtime/vanguard/engine/src/cli.js — shipped beside the packaged bundle;
 *   3. the vendored node_modules copy next to the resolvable vanguard module.
 */
async function resolveWorkerCli(): Promise<string | undefined> {
  const candidates: Array<string | undefined> = [
    process.env.ARES_VANGUARD_CLI,
    fileURLToPath(new URL("../vanguard/engine/src/cli.js", import.meta.url)),
  ];
  try {
    const resolved = createRequire(import.meta.url).resolve("vanguard");
    candidates.push(path.join(path.dirname(resolved), "cli.js"));
  } catch {
    // no resolvable vanguard package (fully bundled) — earlier candidates cover it
  }
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

interface VanguardEngineLike {
  create(config: Record<string, unknown>): Promise<{ sessionId: string }>;
  advance(sessionId: string, message?: string): Record<string, unknown>;
  steer(sessionId: string, message: string): Record<string, unknown>;
  cancel(sessionId: string): Record<string, unknown>;
  stopAndWait(sessionId: string): Promise<Record<string, unknown>>;
  status(sessionId: string): { state?: string };
  subscribe(handler: (envelope: { sessionId: string; event: Record<string, unknown> }) => void): () => void;
  shutdown(): Promise<void>;
}

/** The daemon's tagEmit: events tagged with the Ares session id. */
type TagEmit = (sessionId: string | undefined, obj: Record<string, unknown>) => void;

/** Persists a drive event into the owning Ares session's rollout. */
type PersistEvent = (sessionId: string | undefined, event: Record<string, unknown>) => void;

/** The slice of Ares uiSettings the drive needs to authenticate any family. */
export interface DriveSettings {
  readonly anthropicKey?: string;
  readonly deepSeekKey?: string;
  readonly ollamaApiKey?: string;
  readonly kimiKey?: string;
  readonly openRouterKey?: string;
  readonly customBaseUrl?: string;
  readonly customApiKey?: string;
  readonly aresGatewayUrl?: string;
  readonly aresGatewayToken?: string;
}

/** Families Vanguard drives natively, with their Ares settings key. */
const NATIVE_FAMILIES: Readonly<Record<string, { settingsKey?: keyof DriveSettings }>> = {
  anthropic: { settingsKey: "anthropicKey" },
  openai: {},
  deepseek: { settingsKey: "deepSeekKey" },
  kimi: { settingsKey: "kimiKey" },
  ollama: { settingsKey: "ollamaApiKey" },
};

interface DriveTarget {
  readonly provider: string;
  readonly endpoint?: string;
  readonly credentialVariable?: string;
  /** Key to inject into the credential variable when the env has none. */
  readonly settingsValue?: string;
  /** Native family for OAuth checks; undefined disables OAuth. */
  readonly oauthFamily?: string;
}

/**
 * Every Ares selection maps onto the engine: native families directly, and
 * openrouter / custom / the in-house ares gateway through explicit endpoints
 * with dedicated credential variables, so first-party key env vars are never
 * clobbered by gateway tokens.
 */
function driveTarget(family: string, settings: DriveSettings): DriveTarget {
  const native = NATIVE_FAMILIES[family];
  if (native !== undefined) {
    return {
      provider: family,
      oauthFamily: family,
      ...(native.settingsKey === undefined ? {} : { settingsValue: settings[native.settingsKey] as string | undefined }),
    };
  }
  if (family === "openrouter") {
    return {
      provider: "openai-compatible",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      credentialVariable: "OPENROUTER_API_KEY",
      settingsValue: settings.openRouterKey,
    };
  }
  if (family === "custom") {
    const base = (settings.customBaseUrl || process.env.ARES_CUSTOM_BASE_URL || "").replace(/\/+$/u, "");
    if (base === "") throw new Error("The custom provider has no base URL configured.");
    return {
      provider: "openai-compatible",
      endpoint: `${base}/chat/completions`,
      credentialVariable: "ARES_CUSTOM_API_KEY",
      settingsValue: settings.customApiKey,
    };
  }
  if (family === "ares") {
    // The in-house gateway speaks Anthropic Messages; the account token rides
    // its own variable so a real Anthropic key elsewhere stays untouched.
    const raw = settings.aresGatewayUrl || process.env.ARES_GATEWAY_URL || "https://www.doingteam.com";
    const base = raw.replace(/\/+$/u, "").replace("://doingteam.com", "://www.doingteam.com");
    return {
      provider: "anthropic",
      endpoint: `${base}/api/gateway/v1/messages`,
      credentialVariable: "ARES_GATEWAY_TOKEN",
      settingsValue: settings.aresGatewayToken,
    };
  }
  throw new Error(
    family === "moa"
      ? "Vanguard drives one concrete model at a time — pick a specific provider instead of a MoA ensemble, or turn Vanguard mode off."
      : `Vanguard cannot drive the '${family}' selection. Switch model or turn Vanguard mode off.`,
  );
}

interface Binding {
  vanguardSessionId: string;
  family: string;
  model: string;
  workspace: string;
  /** True when the engine's Anthropic session is bridged from Ares's OAuth
   *  store — re-synced every turn so the copy tracks Ares's refreshes. */
  aresOAuthBridge: boolean;
  /** Ares session tag for emitted events (undefined = primary/untagged). */
  tag: string | undefined;
  /** FIFO of live tool-card ids, per tool name, for start/end matching. */
  pendingTools: Map<string, string[]>;
  /** Bytes streamed since the last committed message — dedupes agent.message. */
  deltaBytes: number;
  /** Visible text emitted this turn — the blank-reply safety net reads this. */
  turnTextBytes: number;
  /** Assistant text accumulated this turn, persisted as the rollout message. */
  turnText: string;
  turnActive: boolean;
  turnStartedAt: number;
  /** Wall-clock of the last public event — the liveness signal the hang watchdog reads. */
  lastEventAt: number;
  /** Highest journal sequence rendered. A resumed worker re-presents its
   *  journal; replayed events must not re-render as fresh tool cards. */
  lastSequence: number;
}

export interface VanguardDrive {
  isTurnActive(key: string): boolean;
  runTurn(
    key: string,
    tag: string | undefined,
    goal: string,
    selection: { workspace: string; family: string; model: string; settings: DriveSettings },
  ): Promise<void>;
  steerTurn(key: string, text: string): boolean;
  interrupt(key: string): boolean;
  shutdown(): Promise<void>;
}

export function createVanguardDrive(tagEmit: TagEmit, persist?: PersistEvent): VanguardDrive {
  let modulePromise: Promise<EngineModule> | undefined;
  let engine: VanguardEngineLike | undefined;
  let unsubscribe: (() => void) | undefined;
  const bindings = new Map<string, Binding>();
  const byVanguardId = new Map<string, Binding>();
  let toolCardSequence = 0;

  const loadModule = (): Promise<EngineModule> => {
    modulePromise ??= import("vanguard") as unknown as Promise<EngineModule>;
    return modulePromise;
  };

  const translate = (binding: Binding, ev: Record<string, unknown>): void => {
    binding.lastEventAt = Date.now();
    // Journal replay dedupe: sequenced events already rendered are history,
    // not progress. Unsequenced frames (live stream deltas) pass through.
    const sequence = typeof ev.sequence === "number" ? ev.sequence : undefined;
    if (sequence !== undefined) {
      if (sequence <= binding.lastSequence) return;
      binding.lastSequence = sequence;
    }
    const type = typeof ev.type === "string" ? ev.type : "";
    const title = typeof ev.title === "string" ? ev.title : "";
    const detail = typeof ev.detail === "string" ? ev.detail : undefined;
    const message = typeof ev.message === "string" ? ev.message : "";
    const emit = (obj: Record<string, unknown>): void => tagEmit(binding.tag, obj);
    switch (type) {
      case "agent.delta":
        binding.deltaBytes += message.length;
        binding.turnTextBytes += message.length;
        if (binding.turnText.length < 400_000) binding.turnText += message;
        emit({ type: "text_delta", text: message });
        return;
      case "agent.thinking":
        emit({ type: "thinking_delta", text: message });
        return;
      case "agent.message":
        // Streamed replies already went out as deltas; only surface a message
        // that never streamed (non-streaming providers, control decisions).
        // Safety net: if NOTHING visible has rendered this turn, always show
        // the committed message — a silent-looking turn is worse than a rare
        // duplicate sentence.
        if (message && (binding.deltaBytes === 0 || binding.turnTextBytes === 0)) {
          binding.turnTextBytes += message.length;
          if (binding.turnText.length < 400_000) binding.turnText += `${binding.turnText.length > 0 ? "\n" : ""}${message}`;
          emit({ type: "text_delta", text: message });
        }
        binding.deltaBytes = 0;
        return;
      case "tool.started": {
        const tool = typeof ev.tool === "string" ? ev.tool : "tool";
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        const queue = binding.pendingTools.get(tool) ?? [];
        queue.push(id);
        binding.pendingTools.set(tool, queue);
        emit({ type: "tool_start", id, name: tool, activityDescription: detail ?? title ?? tool });
        persist?.(binding.tag, { type: "tool_start", id, name: tool, input: {}, activityDescription: detail ?? title ?? tool });
        return;
      }
      case "tool.completed":
      case "tool.failed": {
        const tool = typeof ev.tool === "string" ? ev.tool : "tool";
        const id = binding.pendingTools.get(tool)?.shift();
        const durationMs = typeof ev.durationMs === "number" ? ev.durationMs : undefined;
        if (id === undefined) return;
        if (type === "tool.completed") {
          emit({ type: "tool_end", id, display: detail ?? "done", durationMs });
          persist?.(binding.tag, { type: "tool_end", id, output: detail ?? "done", durationMs: durationMs ?? 0, display: detail ?? "done" });
        } else {
          emit({ type: "tool_error", id, error: detail ?? "failed", durationMs });
          persist?.(binding.tag, { type: "tool_error", id, error: detail ?? "failed", durationMs: durationMs ?? 0 });
        }
        return;
      }
      case "run.contracted": {
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        emit({ type: "tool_start", id, name: "vanguard.contract", activityDescription: "task contracted" });
        emit({ type: "tool_end", id, display: detail ?? title ?? "objective and success criteria locked" });
        return;
      }
      case "completion.claimed": {
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        emit({ type: "tool_start", id, name: "vanguard.verify", activityDescription: "completion claimed — verifying" });
        binding.pendingTools.set("vanguard.verify", [...(binding.pendingTools.get("vanguard.verify") ?? []), id]);
        return;
      }
      case "verification.completed": {
        const pending = binding.pendingTools.get("vanguard.verify")?.shift();
        const passed = ev.status === "passed";
        if (pending !== undefined) {
          if (passed) tagEmit(binding.tag, { type: "tool_end", id: pending, display: detail ?? "verifiers accepted the completion" });
          else tagEmit(binding.tag, { type: "tool_error", id: pending, error: detail ?? "verifiers rejected the completion" });
          return;
        }
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        emit({ type: "tool_start", id, name: "vanguard.verify", activityDescription: title || "independent verification" });
        if (passed) emit({ type: "tool_end", id, display: detail ?? "passed" });
        else emit({ type: "tool_error", id, error: detail ?? "failed" });
        return;
      }
      case "run.waiting_for_user":
        if (message && (binding.deltaBytes === 0 || binding.turnTextBytes === 0)) {
          binding.turnTextBytes += message.length;
          emit({ type: "text_delta", text: message });
        }
        binding.deltaBytes = 0;
        return;
      case "run.failed": {
        // The engine's failure REASON must reach the transcript — a red turn
        // with no text is indistinguishable from a broken app.
        const reason = detail || message || title || "the engine reported a failure without a reason";
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        emit({ type: "tool_start", id, name: "vanguard.engine", activityDescription: "run failed" });
        emit({ type: "tool_error", id, error: reason, durationMs: 0 });
        if (binding.turnTextBytes === 0) {
          const text = `Vanguard run failed: ${reason}`;
          binding.turnTextBytes += text.length;
          if (binding.turnText.length < 400_000) binding.turnText += `${binding.turnText.length > 0 ? "\n" : ""}${text}`;
          emit({ type: "text_delta", text });
        }
        return;
      }
      default:
        return; // lifecycle/usage frames feed the turn loop, not the transcript
    }
  };

  const ensureEngine = async (): Promise<VanguardEngineLike> => {
    const mod = await loadModule();
    if (engine === undefined) {
      const workerCli = await resolveWorkerCli();
      engine = new mod.VanguardEngine({
        logger: () => {},
        ...(workerCli === undefined ? {} : { runner: new mod.CliVanguardRunner(workerCli) }),
      });
      unsubscribe = engine.subscribe(({ sessionId, event }) => {
        const binding = byVanguardId.get(sessionId);
        if (binding !== undefined) translate(binding, event);
      });
    }
    return engine;
  };

  /**
   * The owner signed into Claude through ARES's OAuth; the engine reads its
   * own token store. Same OAuth contract, identical token shape — so sync the
   * (auto-refreshed) Ares tokens across whenever the engine store is stale.
   * Returns true when the engine now holds a usable Anthropic session.
   */
  const syncAresAnthropicOAuth = async (): Promise<boolean> => {
    try {
      const mod = await loadModule();
      const core = await import("@ares/core") as {
        resolveAnthropicAccessToken: () => Promise<string | null>;
        loadAnthropicTokens: () => Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] } | null>;
      };
      const access = await core.resolveAnthropicAccessToken();
      if (!access) return false;
      const tokens = await core.loadAnthropicTokens();
      if (!tokens?.accessToken || !tokens.refreshToken) return false;
      await mod.saveAnthropicTokens({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.scopes === undefined ? {} : { scopes: tokens.scopes }),
      });
      return true;
    } catch {
      return false;
    }
  };

  const resolveAuth = async (target: DriveTarget, family: string): Promise<{ auth: "oauth" | "api-key"; aresBridged: boolean }> => {
    const mod = await loadModule();
    if (target.oauthFamily !== undefined && mod.supportsOAuth(target.oauthFamily)) {
      const status = await mod.oauthStatus(target.oauthFamily).catch(() => ({ connected: false }));
      if (status.connected) return { auth: "oauth", aresBridged: false };
      if (target.oauthFamily === "anthropic" && await syncAresAnthropicOAuth()) return { auth: "oauth", aresBridged: true };
    }
    const variable = target.credentialVariable ?? mod.credentialVariable(target.provider);
    if ((process.env[variable] ?? "") !== "") return { auth: "api-key", aresBridged: false };
    // Fall back to the credential the owner already gave Ares itself, so
    // Vanguard mode needs zero extra setup. Injected into this process only.
    if (target.settingsValue !== undefined && target.settingsValue !== "") {
      process.env[variable] = target.settingsValue;
      return { auth: "api-key", aresBridged: false };
    }
    if (family === "ollama") return { auth: "api-key", aresBridged: false }; // local daemon needs no key
    throw new Error(`Vanguard has no ${family} credential: sign in with the Claude/ChatGPT/Kimi card in Settings, or set ${variable}.`);
  };

  const ensureBinding = async (
    key: string,
    tag: string | undefined,
    selection: { workspace: string; family: string; model: string; settings: DriveSettings },
  ): Promise<Binding> => {
    const existing = bindings.get(key);
    if (existing !== undefined
      && existing.family === selection.family
      && existing.model === selection.model
      && existing.workspace === selection.workspace) {
      return existing;
    }
    // "It works where I tell it": a fresh workspace may not exist yet.
    await mkdir(selection.workspace, { recursive: true });
    const target = driveTarget(selection.family, selection.settings);
    const live = await ensureEngine();
    const { auth, aresBridged } = await resolveAuth(target, selection.family);
    const config = {
      workspace: selection.workspace,
      provider: target.provider,
      model: selection.model,
      auth,
      ...(target.endpoint === undefined ? {} : { endpoint: target.endpoint }),
      ...(target.credentialVariable === undefined || auth === "oauth" ? {} : { credentialVariable: target.credentialVariable }),
      direct: true, // same trust model as the Ares agent: real tree, git undo
      maxSteps: 240,
      // No-hang layer 1: any command silent for 90s dies (same watchdog the
      // Vanguard TUI uses) — installers waiting on prompts, wedged spawns.
      commandIdleTimeoutMs: 90_000,
      // No-hang layer 2: no single command may run past 10 minutes, chatty or
      // not — a log-spewing server that never exits is still a hang.
      commandTimeoutMs: 600_000,
    };
    let created;
    try {
      created = await live.create(config);
    } catch (error) {
      // Engine swap means Vanguard works ANYWHERE, not only inside projects.
      // When the workspace has no detectable build/test contract, fall back to
      // the builtin adaptive verifier in "build" mode: a contract that exists
      // still runs and still gates completion; its absence stops being fatal
      // and completion honestly rests on tool evidence + syntax checks.
      const text = error instanceof Error ? error.message : String(error);
      if (!/detect project verification/iu.test(text)) throw error;
      created = await live.create({
        ...config,
        verification: { command: "vanguard:adaptive-verify", args: ["--mode", "build"] },
        executionEvidence: "syntax",
      });
    }
    if (existing !== undefined) byVanguardId.delete(existing.vanguardSessionId);
    const binding: Binding = {
      vanguardSessionId: created.sessionId,
      family: selection.family,
      model: selection.model,
      workspace: selection.workspace,
      aresOAuthBridge: aresBridged,
      tag,
      pendingTools: new Map(),
      deltaBytes: 0,
      turnTextBytes: 0,
      turnText: "",
      turnActive: false,
      turnStartedAt: 0,
      lastEventAt: Date.now(),
      lastSequence: 0,
    };
    bindings.set(key, binding);
    byVanguardId.set(created.sessionId, binding);
    return binding;
  };

  return {
    isTurnActive(key: string): boolean {
      return bindings.get(key)?.turnActive === true;
    },

    async runTurn(key, tag, goal, selection): Promise<void> {
      const startedAt = Date.now();
      tagEmit(tag, { type: "turn_start" });
      let binding: Binding | undefined;
      try {
        binding = await ensureBinding(key, tag, selection);
        binding.tag = tag;
        binding.turnActive = true;
        binding.turnStartedAt = startedAt;
        binding.deltaBytes = 0;
        binding.turnTextBytes = 0;
        binding.turnText = "";
        binding.lastEventAt = Date.now();
        // Drive turns are exactly as durable as native ones: the goal, tool
        // activity, the assistant message, and the turn end all persist to the
        // Ares session rollout (history, restore, bug reports).
        persist?.(tag, {
          type: "turn_start",
          turnId: `vanguard-turn-${startedAt}`,
          sessionId: tag ?? "",
          userMessage: {
            id: `vanguard-user-${startedAt}`,
            role: "user",
            content: [{ type: "text", text: goal }],
            createdAt: new Date(startedAt).toISOString(),
          },
        });
        const persistTurnClose = (status: string): void => {
          if (binding !== undefined && binding.turnText.length > 0) {
            persist?.(tag, {
              type: "message_done",
              message: {
                id: `vanguard-assistant-${startedAt}`,
                role: "assistant",
                content: [{ type: "text", text: binding.turnText }],
                createdAt: new Date().toISOString(),
              },
              usage: { inputTokens: 0, outputTokens: 0 },
              stopReason: "end_turn",
            });
          }
          persist?.(tag, { type: "turn_end", status, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: Date.now() - startedAt });
        };
        const live = await ensureEngine();
        // Keep the bridged Anthropic session tracking Ares's token refreshes.
        if (binding.aresOAuthBridge) await syncAresAnthropicOAuth();
        try {
          live.advance(binding.vanguardSessionId, goal);
        } catch (error) {
          // A lingering worker from a cancelled or wedged prior turn means the
          // session is still mid-advance. Attach instead of failing: steering
          // delivers this message into the running run.
          const text = error instanceof Error ? error.message : String(error);
          if (!/active advance|session_busy/iu.test(text)) throw error;
          live.steer(binding.vanguardSessionId, goal);
        }
        // No-hang layer 3: the worker runs in the background and public events
        // are its heartbeat. Tool execution windows are already bounded by the
        // command watchdogs (their completions produce events), so a long
        // event-free stretch with NO tool pending means a wedged worker or a
        // stalled provider stream. Cancel it and restart from the session
        // journal — Vanguard's durable execution makes the resume lossless and
        // queued steering survives. Two restarts, then fail honestly.
        let recoveries = 0;
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          const state = live.status(binding.vanguardSessionId).state;
          if (state !== "running") {
            persistTurnClose(state === "failed" ? "failed" : "completed");
            tagEmit(tag, {
              type: "turn_end",
              status: state === "failed" ? "failed" : "ok",
              usage: {},
              durationMs: Date.now() - startedAt,
            });
            return;
          }
          const toolPending = [...binding.pendingTools.values()].some((queue) => queue.length > 0);
          const idleMs = Date.now() - binding.lastEventAt;
          if (!toolPending && idleMs > 180_000) {
            recoveries += 1;
            toolCardSequence += 1;
            const cardId = `vanguard-${toolCardSequence}`;
            if (recoveries > 2) {
              tagEmit(tag, { type: "tool_start", id: cardId, name: "vanguard.watchdog", activityDescription: "worker unresponsive" });
              tagEmit(tag, { type: "tool_error", id: cardId, error: "no activity for 3 minutes after two restarts — stopping this turn; send again to resume the contract" });
              live.cancel(binding.vanguardSessionId);
              persistTurnClose("failed");
              tagEmit(tag, { type: "turn_end", status: "failed", usage: {}, durationMs: Date.now() - startedAt });
              return;
            }
            tagEmit(tag, { type: "tool_start", id: cardId, name: "vanguard.watchdog", activityDescription: `no activity for ${Math.round(idleMs / 1000)}s — restarting the worker from its journal` });
            // stopAndWait returns only when the worker generation has actually
            // settled — restarting off a bare cancel raced lingering workers
            // and collided with "the session already has an active advance".
            try {
              await live.stopAndWait(binding.vanguardSessionId);
            } catch {
              live.cancel(binding.vanguardSessionId);
              const cancelledAt = Date.now();
              while (live.status(binding.vanguardSessionId).state === "running" && Date.now() - cancelledAt < 30_000) {
                await new Promise((resolve) => setTimeout(resolve, 400));
              }
            }
            if (live.status(binding.vanguardSessionId).state === "running") {
              tagEmit(tag, { type: "tool_end", id: cardId, display: "worker still settling — will retry on the next quiet window" });
              binding.lastEventAt = Date.now();
              continue;
            }
            live.advance(binding.vanguardSessionId);
            binding.lastEventAt = Date.now();
            tagEmit(tag, { type: "tool_end", id: cardId, display: `worker restarted (recovery ${recoveries}/2) — the journal replays completed work` });
          }
        }
      } catch (error) {
        const text = `Vanguard engine: ${error instanceof Error ? error.message : String(error)}`;
        // A failed turn must NEVER render blank: prose plus an error card, so
        // the reason survives even if one rendering path drops it.
        tagEmit(tag, { type: "text_delta", text });
        toolCardSequence += 1;
        const cardId = `vanguard-${toolCardSequence}`;
        tagEmit(tag, { type: "tool_start", id: cardId, name: "vanguard.engine", activityDescription: "engine error" });
        tagEmit(tag, { type: "tool_error", id: cardId, error: text, durationMs: 0 });
        if (binding !== undefined && binding.turnText.length < 400_000) binding.turnText += `${binding.turnText.length > 0 ? "\n" : ""}${text}`;
        persist?.(tag, {
          type: "message_done",
          message: { id: `vanguard-assistant-${startedAt}`, role: "assistant", content: [{ type: "text", text: binding?.turnText || text }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "error",
        });
        persist?.(tag, { type: "turn_end", status: "failed", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: Date.now() - startedAt });
        tagEmit(tag, { type: "turn_end", status: "failed", usage: {}, durationMs: Date.now() - startedAt });
      } finally {
        if (binding !== undefined) binding.turnActive = false;
      }
    },

    steerTurn(key: string, text: string): boolean {
      const binding = bindings.get(key);
      if (binding === undefined || !binding.turnActive || engine === undefined) return false;
      try {
        engine.steer(binding.vanguardSessionId, text);
        return true;
      } catch {
        return false;
      }
    },

    interrupt(key: string): boolean {
      const binding = bindings.get(key);
      if (binding === undefined || !binding.turnActive || engine === undefined) return false;
      try {
        engine.cancel(binding.vanguardSessionId);
        return true;
      } catch {
        return false;
      }
    },

    async shutdown(): Promise<void> {
      unsubscribe?.();
      await engine?.shutdown().catch(() => undefined);
      engine = undefined;
    },
  };
}
