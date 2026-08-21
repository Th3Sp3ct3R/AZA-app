// Extracted from entry.ts — engineTools.

import { AresSubagentRunner, SubagentRegistry, openWorkspaceSessionKernel, type EngineTool, type QueryEngineConfig, type SessionKernelStore, type ToolCallContext } from "@ares/core";
import path from "node:path";
import { DEFAULT_TOOLS, ReadTool, WriteTool, EditTool, ApplyPatchTool, ApplyIntentTool, GlobTool, GrepTool, CodebaseSearchTool, LspTool, PowerShellTool, BashTool, FindAndEditTool, CodeModeTool, adaptToolForEngine, buildTool, makeTodoWriteTool, makeTaskTool, makeTaskOutputTool, makeKillTaskTool, makeConductorTool, makeCodingBackendTool, makeWebFetchTool, makeWebSearchTool, makeImageSearchTool, makeBashOutputTool, makeKillShellTool, makeBackgroundTasksTool, makeEnterPlanModeTool, makeUpdatePlanDraftTool, makeExitPlanModeTool, makeAgentComputerTools, TodoStore, ShellRegistry, type RichToolContext, type FileReadStamp, type PathPermissionStore, type CommandPermissionStore, type PlanModeState } from "@ares/tools";
import { z } from "zod";
import { decidePermission } from "../permissionPolicy.js";
import { loadUiSettings } from "../uiSettings.js";
import { aresGatewayBase } from "./providers.js";
import { makeTelegramSetupTool } from "../telegramSetupTool.js";
import { makeTelegramRosterTool } from "../telegramRosterTool.js";
import { BootstrapTool, MissionTool, PersonaTool, RunSkillTool, SelfEvolveTool, SelfTool, SkillCraftTool, listPersonas, makeCapabilityTool, makeSkillHubTool, renderPersonaLayer, resolveCapabilityProvider, runSkill, scanCapabilityRegistry } from "@ares/agent";
import { registerPersonaSubagents } from "./rosterBridge.js";
import { withMissionRunRecorded } from "./missionLiveness.js";
import { QueryEngineDispatcher, acquireCapability, createGoal, listGoals, listAcquisitions, listCapabilities, markAcquisitionAcquired, newGoalId, novelDeltaCurve, reliabilityOf, runGoalToCompletion, saveGoal, setAcquisitionStatus, loadStandingOrders, addStandingOrder, removeStandingOrder, renderStandingOrders, addWatcher, loadWatchers, removeWatcher, renderWatchers, type StandingOrder, type Goal, type AcquisitionKind, type VerificationSpec } from "@ares/operator";
import { MemoryRouter, MemoryStore, withConsolidationLock } from "@ares/mind";
import { makeBrowserTool } from "./browserBridge.js";
import { ProviderSelection, fastModelFor } from "./providers.js";
import { AresRuntimeState, CliRuntimeContext, compactLine } from "./runtime.js";
import { buildSystemPrompt } from "./turnPipeline.js";

export interface EngineToolStateResolver {
  shellRegistryFor(sessionId: string): ShellRegistry;
  todoStoreFor(sessionId: string): TodoStore;
  /** Multi-session hosts must resolve workflow authority from the calling
   * Session. Capturing the process-global runtime lets session A change the
   * permission posture (and plan) observed by session B. */
  planModeStateFor?(sessionId: string): PlanModeState;
}

export const SESSION_TRANSITION_TOOL_NAMES = new Set(["EnterPlanMode", "UpdatePlanDraft", "ExitPlanMode"]);

function childSpanSummarizer(selection: ProviderSelection): QueryEngineConfig["summarizeSpan"] | undefined {
  if (!selection.subModel) return undefined;
  return async (messages) => selection.subModel!.summarize({
    input: JSON.stringify(messages.map((message) => ({ role: message.role, content: message.content }))),
    instructions:
      "Compact this child coding session into a dense factual continuation: objective, completed work, exact files/symbols, decisions, failures, verification, and remaining steps. Do not address the user.",
  });
}

/** Leaf engines receive their own durable Session but no owner-facing workflow
 * surface. A child may edit under the authority delegated by its parent; it may
 * never enter/approve the parent's plan or mutate a shared host runtime. */
export function scopeChildEngineTools(tools: readonly EngineTool[]): EngineTool[] {
  return tools.filter((tool) => !SESSION_TRANSITION_TOOL_NAMES.has(tool.schema.name));
}

export async function buildEngineTools(
  pathPermissions: PathPermissionStore,
  commandPermissions: CommandPermissionStore,
  selection: ProviderSelection,
  runtime: AresRuntimeState,
  context: CliRuntimeContext,
  shellRegistry: ShellRegistry,
  todoStore: TodoStore,
  // Shared per-session state populated by the tool harness. Callers that need
  // to invalidate stamps (context-trim recovery) own the map and pass it in.
  fileReadStamps: Map<string, FileReadStamp> = new Map(),
  providedSessionKernel?: SessionKernelStore,
  stateResolver?: EngineToolStateResolver,
): Promise<EngineTool[]> {
  const sessionKernel = providedSessionKernel ?? await openWorkspaceSessionKernel(context.workspace);
  const planModeStateFor = (sessionId: string): PlanModeState =>
    stateResolver?.planModeStateFor?.(sessionId) ?? runtime;
  // The first caller is the owner Session (Task/Conductor cannot launch before
  // that call). Every durable child thereafter receives isolated mutable tool
  // state instead of sharing the parent's background processes and todo list.
  let ownerStateSessionId: string | undefined;
  const childShellRegistries = new Map<string, ShellRegistry>();
  const childTodoStores = new Map<string, TodoStore>();
  const fallbackShellRegistryFor = (sessionId: string): ShellRegistry => {
    ownerStateSessionId ??= sessionId;
    if (sessionId === ownerStateSessionId) return shellRegistry;
    let registry = childShellRegistries.get(sessionId);
    if (!registry) {
      registry = new ShellRegistry();
      childShellRegistries.set(sessionId, registry);
    }
    return registry;
  };
  const fallbackTodoStoreFor = (sessionId: string): TodoStore => {
    ownerStateSessionId ??= sessionId;
    if (sessionId === ownerStateSessionId) return todoStore;
    let store = childTodoStores.get(sessionId);
    if (!store) {
      store = new TodoStore();
      childTodoStores.set(sessionId, store);
    }
    return store;
  };
  const durableShellRegistryFor = (sessionId: string): ShellRegistry => {
    const registry = stateResolver?.shellRegistryFor(sessionId) ?? fallbackShellRegistryFor(sessionId);
    registry.configureDurability({ kernel: sessionKernel, workspace: context.workspace });
    registry.registerSession(sessionId);
    return registry;
  };
  const enrich = (base: ToolCallContext): RichToolContext => ({
    ...base,
    permissionMode: planModeStateFor(base.sessionId).permissionMode,
    // Prefer the engine-owned map (subagents supply their own) so parent and
    // child never share read state; fall back to the parent's shared map.
    fileReadStamps: (base.fileReadStamps as Map<string, FileReadStamp>) ?? fileReadStamps,
    pathPermissions,
    commandPermissions,
    shellRegistry: durableShellRegistryFor(base.sessionId),
    todoStore: stateResolver?.todoStoreFor(base.sessionId) ?? fallbackTodoStoreFor(base.sessionId),
    subModel: selection.subModel,
  });

  // One generic adaptive-provider surface for every environment. The registry
  // is preloaded so per-input safety is available synchronously on the first
  // call; the tool refreshes it after discovery/acquisition/invocation.
  const capabilitySnapshot = await scanCapabilityRegistry({
    home: context.home,
    workspace: context.workspace,
  });
  // Assigned after child scoping is built. The ensure callback cannot run
  // until buildEngineTools returns, so it always observes the final non-
  // recursive Worker catalog.
  let capabilityWorkerTools: readonly EngineTool[] = [];
  const capabilityTool = makeCapabilityTool({
    home: context.home,
    workspace: context.workspace,
    initialSnapshot: capabilitySnapshot,
    ensure: async (request, toolContext) => {
      const acquired = await acquireCapability({
        home: request.home,
        capabilityName: request.capability,
        kind: "skill",
        requires: request.requires,
        targetFiles: request.targetFiles,
        description: request.description,
        scope: request.scope,
        workspace: request.workspace,
        targetRoot: request.targetRoot,
      });
      await setAcquisitionStatus(request.home, acquired.acquisition.id, "building");

      const ticks = 1;
      const dispatcher = new QueryEngineDispatcher({
        provider: selection.provider,
        model: selection.model,
        workspace: request.workspace,
        tools: capabilityWorkerTools,
        systemPrompt: buildSystemPrompt(runtime.permissionMode, context),
        sessionKernel,
        parentSessionId: request.sessionId,
        telemetryDir: path.join(context.home, "telemetry"),
        sessionRegistryHome: context.home,
        requestPermission: toolContext.requestPermission,
      });
      let final: Goal;
      try {
        final = await withMissionRunRecorded(acquired.goal.id, ticks, () =>
          runGoalToCompletion(
            {
              home: request.home,
              dispatcher,
              workspace: request.workspace,
              signal: request.signal,
            },
            acquired.goal.id,
            { maxTicks: ticks },
          ),
        );
      } catch (error) {
        // An owner Stop is resumable durable work, not proof that acquisition
        // is blocked. Hard worker failures are made explicit for triage.
        if (!request.signal.aborted) {
          await setAcquisitionStatus(request.home, acquired.acquisition.id, "blocked").catch(() => {});
        }
        throw error;
      }

      const provider = await resolveCapabilityProvider(
        { capability: request.capability },
        { home: request.home, workspace: request.workspace },
      );
      let verification: Awaited<ReturnType<typeof runSkill>> | undefined;
      let verificationError: string | undefined;
      if (!provider && (final.status === "done" || final.status === "blocked")) {
        verificationError = `acquisition Worker ended ${final.status} without registering a provider for ${request.capability}`;
      }
      if (provider) {
        try {
          verification = await runSkill({
            home: request.home,
            workspace: request.workspace,
            name: provider.name,
            input: { reason: "post-acquisition-healthcheck" },
            targetRoot: request.targetRoot,
            operation: provider.manifest.healthcheck.operation,
            timeoutMs: provider.manifest.healthcheck.timeoutMs,
            signal: request.signal,
            sessionId: request.sessionId,
          });
        } catch (error) {
          verificationError = error instanceof Error ? error.message : String(error);
        }
      }
      const status = verification?.ok
        ? "available" as const
        : final.status === "blocked" || final.status === "done"
          ? "blocked" as const
          : "building" as const;
      if (status === "available") {
        await markAcquisitionAcquired(request.home, acquired.acquisition.id, {
          ok: verification!.ok,
          receipt: verification!.receipt,
          expectedProviderId: provider!.manifest.id,
          expectedOperation: provider!.manifest.healthcheck.operation,
        });
      } else {
        await setAcquisitionStatus(request.home, acquired.acquisition.id, status);
      }
      return {
        status,
        verification,
        error: verificationError,
        result: {
          ...acquired,
          final,
          requestedScope: request.scope,
          targetRoot: request.targetRoot ?? request.workspace,
          description: request.description,
          verificationError,
        },
      };
    },
  });

  const baseToolDefs = [
    ...DEFAULT_TOOLS,
    // The agent's own computer — a sandboxed Debian under WSL2 (Windows-only
    // for now). Registered ALONGSIDE host tools; both stay live and the target
    // is named by which tool is called. Subagents share the parent's machine
    // and screen (displays are per user-facing agent, not per worker).
    ...(process.platform === "win32" ? makeAgentComputerTools() : []),
    makeTodoWriteTool(todoStore),
    makeWebSearchTool(),
    makeImageSearchTool(),
    makeWebFetchTool(selection.subModel),
    makeBashOutputTool(shellRegistry),
    makeKillShellTool(shellRegistry),
    makeBackgroundTasksTool(shellRegistry),
    makeEnterPlanModeTool((call) => planModeStateFor(call.sessionId)),
    makeUpdatePlanDraftTool((call) => planModeStateFor(call.sessionId)),
    makeExitPlanModeTool((call) => planModeStateFor(call.sessionId)),
    BootstrapTool,
    SelfEvolveTool,
    SkillCraftTool,
    RunSkillTool,
    capabilityTool,
    MissionTool,
    SelfTool,
    PersonaTool,
    makeTelegramSetupTool(),
    makeTelegramRosterTool(),
  ];

  // Sandbox-only mode: the owner said "do your work on YOUR machine". Host
  // execution and host writes are withheld outright rather than merely
  // discouraged — a prompt rule is not a boundary. Host READS stay (Ares must
  // still see the project) and ComputerTransfer stays as the one sanctioned,
  // permission-gated bridge between the two machines.
  const sandboxOnly = (await loadUiSettings().catch(() => null))?.computerMode === "sandbox";
  const HOST_ONLY_TOOLS = new Set([
    "Bash", "PowerShell", "BashOutput", "KillShell", "BackgroundTasks",
    "ComputerUse", "Write", "Edit", "ApplyPatch", "ApplyIntent", "FindAndEdit", "CodeMode", "Deploy",
  ]);
  const admittedToolDefs = sandboxOnly
    ? baseToolDefs.filter((tool) => !HOST_ONLY_TOOLS.has(tool.schema.name))
    : baseToolDefs;

  const baseTools = admittedToolDefs.map((tool) => {
    const adapted = adaptToolForEngine(tool, (base: ToolCallContext): RichToolContext => ({
      ...enrich(base),
    }));
    return adapted as EngineTool;
  });
  const childBaseTools = scopeChildEngineTools(baseTools);

  // Every persona on the roster becomes a delegable subagent type, so authoring
  // one markdown file gets you both consumption modes. Never fatal: a broken or
  // absent roster leaves the built-in types intact.
  const subagentRegistry = new SubagentRegistry();
  registerPersonaSubagents(subagentRegistry, await listPersonas(context.home).catch(() => []));

  const runner = new AresSubagentRunner({
    registry: subagentRegistry,
    provider: selection.provider,
    model: selection.model,
    // Explorer subagents fan out on the family's cheap sibling (flash/haiku/
    // gateway-fast) — wide search shouldn't burn frontier tokens.
    fastModel: fastModelFor(selection),
    parentTools: childBaseTools,
    baseSystemPrompt: () =>
      runtime.composeChildSystemPrompt?.() ?? buildSystemPrompt(runtime.permissionMode, context),
    sessionKernel,
    summarizeSpan: childSpanSummarizer(selection),
    contextBudgetTokens: Number(process.env.ARES_SUBAGENT_CONTEXT_BUDGET) || 128_000,
    maxTurns: () => {
      const value = Number(process.env.ARES_SUBAGENT_TURN_LIMIT);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
    },
  });
  const taskTool = adaptToolForEngine(makeTaskTool(runner), enrich) as EngineTool;
  const taskOutputTool = adaptToolForEngine(makeTaskOutputTool(runner), enrich) as EngineTool;
  const killTaskTool = adaptToolForEngine(makeKillTaskTool(runner), enrich) as EngineTool;
  const workerTools = [...baseTools, taskTool, taskOutputTool, killTaskTool];
  // The Conductor — author + run a deterministic agent FLEET (capped parallel
  // fan-out, typed pipelines, schema-validated leaves, token budget). parentTools
  // is the child-scoped base catalog (NOT workerTools), so fleet leaves get
  // neither recursive orchestration nor owner-facing plan transitions.
  const conductorTool = adaptToolForEngine(
    makeConductorTool({
      provider: selection.provider,
      model: selection.model,
      parentTools: childBaseTools,
      baseSystemPrompt: () =>
        runtime.composeChildSystemPrompt?.() ?? buildSystemPrompt(runtime.permissionMode, context),
      subModel: selection.subModel,
      // Was 20 — leaves doing several reads + producing structured output ran out
      // of turns mid-read and died, which read as "the fleet always fails." 40
      // gives a leaf room to finish; per-fleet overrides still apply.
      defaultMaxTurns: 40,
      sessionKernel,
      summarizeSpan: childSpanSummarizer(selection),
      // "Fleets inherit my permissions" toggle: leaves can't prompt, so the policy
      // resolves to allow_once / deny. Reads runtime.permissions LIVE so the
      // toggle applies to the next fleet without rebuilding the session.
      leafRequestPermission: async (req) =>
        decidePermission(req, runtime.permissions, { fleet: true }) === "allow" ? "allow_once" : "deny",
      // FleetAgentSpec.persona → the ~/.ares roster. Read fresh per lookup so a
      // persona authored mid-session is usable by the very next fleet. Never
      // fatal: null → the leaf runs persona-less with a hint.
      resolvePersona: async (name) => {
        try {
          const personas = await listPersonas(context.home);
          const wanted = name.trim().toLowerCase();
          const match = personas.find(
            (p) => p.name.toLowerCase() === wanted || p.label.toLowerCase() === wanted,
          );
          if (!match) return null;
          return {
            promptLayer: renderPersonaLayer(match),
            tools: match.tools.length > 0 ? match.tools : undefined,
            maxTurns: match.maxTurns,
            model: match.model,
          };
        } catch {
          return null;
        }
      },
    }),
    enrich,
  ) as EngineTool;
  const livingMindTool = adaptToolForEngine(makeLivingMindTool(context), enrich) as EngineTool;
  const standingOrderTool = adaptToolForEngine(makeStandingOrderTool(context), enrich) as EngineTool;
  const watcherTool = adaptToolForEngine(makeWatcherTool(context), enrich) as EngineTool;
  const browserTool = adaptToolForEngine(makeBrowserTool(context), enrich) as EngineTool;
  capabilityWorkerTools = [
    ...childBaseTools.filter((tool) => tool.schema.name !== "Capability"),
    browserTool,
  ];
  // CodingBackend — optional bridge to an external coding harness
  // (Claude Code / Codex) on the ARES account. Main-agent only, like Conductor:
  // subagents/leaves can't recurse into it. It refuses any backend that is not
  // bound to Ares-owned auth, so it never falls back to the user's CLI OAuth.
  const settings = await loadUiSettings().catch(() => null);
  const codingBackendTool = adaptToolForEngine(
    makeCodingBackendTool({
      gatewayBase: settings ? aresGatewayBase(settings) : "https://www.doingteam.com",
      gatewayToken: settings?.aresGatewayToken || process.env.ARES_GATEWAY_TOKEN,
      defaultModel: settings?.lastAresModel ?? "ares-internal",
    }),
    enrich,
  ) as EngineTool;
  const skillHubTool = adaptToolForEngine(
    makeSkillHubTool({
      gatewayBase: settings ? aresGatewayBase(settings) : "https://www.doingteam.com",
      gatewayToken: settings?.aresGatewayToken || process.env.ARES_GATEWAY_TOKEN,
    }),
    enrich,
  ) as EngineTool;
  const operatorWorkerTools = [...childBaseTools, taskTool, livingMindTool, browserTool];
  const operatorTool = adaptToolForEngine(
    makeOperatorChatTool({
      selection,
      runtime,
      context,
      workerTools: operatorWorkerTools,
      sessionKernel,
    }),
    enrich,
  ) as EngineTool;
  return [...workerTools, livingMindTool, standingOrderTool, watcherTool, operatorTool, browserTool, conductorTool, codingBackendTool, skillHubTool];
}

/**
 * Focused, non-network coding profile used by isolated evaluations and other
 * code-only workers. Keeping this builder beside the production composition
 * prevents benchmarks from quietly testing a toy Write/Edit harness, while the
 * explicit allow-list prevents an eval model from reaching owner memory,
 * messaging, browser, deployment, payment, or gateway-backed tools.
 */
export async function buildCodingTools(
  pathPermissions: PathPermissionStore,
  commandPermissions: CommandPermissionStore,
  selection: ProviderSelection,
  runtime: AresRuntimeState,
  context: CliRuntimeContext,
  shellRegistry: ShellRegistry,
  todoStore: TodoStore,
  fileReadStamps: Map<string, FileReadStamp> = new Map(),
  options: { subagents?: boolean; conductor?: boolean; shell?: boolean } = {},
  providedSessionKernel?: SessionKernelStore,
): Promise<EngineTool[]> {
  const sessionKernel = providedSessionKernel ?? await openWorkspaceSessionKernel(context.workspace);
  let ownerStateSessionId: string | undefined;
  const childShellRegistries = new Map<string, ShellRegistry>();
  const childTodoStores = new Map<string, TodoStore>();
  const shellRegistryFor = (sessionId: string): ShellRegistry => {
    ownerStateSessionId ??= sessionId;
    if (sessionId === ownerStateSessionId) return shellRegistry;
    let registry = childShellRegistries.get(sessionId);
    if (!registry) {
      registry = new ShellRegistry();
      childShellRegistries.set(sessionId, registry);
    }
    return registry;
  };
  const todoStoreFor = (sessionId: string): TodoStore => {
    ownerStateSessionId ??= sessionId;
    if (sessionId === ownerStateSessionId) return todoStore;
    let store = childTodoStores.get(sessionId);
    if (!store) {
      store = new TodoStore();
      childTodoStores.set(sessionId, store);
    }
    return store;
  };
  const durableShellRegistryFor = (sessionId: string): ShellRegistry => {
    const registry = shellRegistryFor(sessionId);
    registry.configureDurability({ kernel: sessionKernel, workspace: context.workspace });
    registry.registerSession(sessionId);
    return registry;
  };
  const enrich = (base: ToolCallContext): RichToolContext => ({
    ...base,
    permissionMode: runtime.permissionMode,
    fileReadStamps: (base.fileReadStamps as Map<string, FileReadStamp>) ?? fileReadStamps,
    pathPermissions,
    commandPermissions,
    shellRegistry: durableShellRegistryFor(base.sessionId),
    todoStore: todoStoreFor(base.sessionId),
    subModel: selection.subModel,
  });
  const codingDefs = [
    ReadTool,
    WriteTool,
    EditTool,
    ApplyPatchTool,
    ApplyIntentTool,
    GlobTool,
    GrepTool,
    CodebaseSearchTool,
    LspTool,
    ...(options.shell === false ? [] : process.platform === "win32" ? [PowerShellTool, BashTool] : [BashTool, PowerShellTool]),
    FindAndEditTool,
    CodeModeTool,
    makeTodoWriteTool(todoStore),
    ...(options.shell === false
      ? []
      : [makeBashOutputTool(shellRegistry), makeKillShellTool(shellRegistry), makeBackgroundTasksTool(shellRegistry)]),
    makeEnterPlanModeTool(runtime),
    makeUpdatePlanDraftTool(runtime),
    makeExitPlanModeTool(runtime),
  ];
  const baseTools = codingDefs.map((tool) => adaptToolForEngine(tool, enrich) as EngineTool);
  if (options.subagents === false) return baseTools;
  const childBaseTools = scopeChildEngineTools(baseTools);

  const codingRegistry = new SubagentRegistry();
  registerPersonaSubagents(codingRegistry, await listPersonas(context.home).catch(() => []));

  const runner = new AresSubagentRunner({
    registry: codingRegistry,
    provider: selection.provider,
    model: selection.model,
    fastModel: fastModelFor(selection),
    parentTools: childBaseTools,
    baseSystemPrompt: () =>
      runtime.composeChildSystemPrompt?.() ?? buildSystemPrompt(runtime.permissionMode, context),
    sessionKernel,
    summarizeSpan: childSpanSummarizer(selection),
    contextBudgetTokens: Number(process.env.ARES_SUBAGENT_CONTEXT_BUDGET) || 128_000,
    maxTurns: () => {
      const value = Number(process.env.ARES_SUBAGENT_TURN_LIMIT);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
    },
  });
  const taskTool = adaptToolForEngine(makeTaskTool(runner), enrich) as EngineTool;
  const taskOutputTool = adaptToolForEngine(makeTaskOutputTool(runner), enrich) as EngineTool;
  const killTaskTool = adaptToolForEngine(makeKillTaskTool(runner), enrich) as EngineTool;
  if (options.conductor === false) return [...baseTools, taskTool, taskOutputTool, killTaskTool];
  const conductorTool = adaptToolForEngine(
    makeConductorTool({
      provider: selection.provider,
      model: selection.model,
      parentTools: childBaseTools,
      baseSystemPrompt: () =>
        runtime.composeChildSystemPrompt?.() ?? buildSystemPrompt(runtime.permissionMode, context),
      subModel: selection.subModel,
      defaultMaxTurns: 40,
      sessionKernel,
      summarizeSpan: childSpanSummarizer(selection),
      leafRequestPermission: async (request) =>
        decidePermission(request, runtime.permissions, { fleet: true }) === "allow" ? "allow_once" : "deny",
    }),
    enrich,
  ) as EngineTool;
  return [...baseTools, taskTool, taskOutputTool, killTaskTool, conductorTool];
}

const livingMindInput = z
  .object({
    action: z
      .enum(["remember", "recall", "list", "consolidate", "status"])
      .describe("Memory operation to perform."),
    cue: z.string().optional().describe("Recall cue for associative lookup."),
    content: z.string().optional().describe("Memory content to store."),
    kind: z.enum(["episodic", "semantic", "procedural"]).optional().describe("Kind of memory to store."),
    limit: z.number().int().min(1).max(30).optional().describe("Maximum memories/results to return."),
  })
  .strict();

interface LivingMindOutput {
  action: string;
  home: string;
  count?: number;
  result?: unknown;
}

function makeLivingMindTool(context: CliRuntimeContext) {
  return buildTool({
    name: "LivingMind",
    description:
      "Use Ares's V6 Living Memory naturally, with no keyword needed: remember durable facts, recall by association, inspect the mind, and consolidate recurring experiences into semantic knowledge.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: livingMindInput,
    activityDescription: (i) => `LivingMind ${i.action}`,

    async call(i): Promise<{ output: LivingMindOutput; display: string }> {
      const home = context.home;
      const store = await MemoryStore.open(context.mind.memoryFile);
      const limit = i.limit ?? 8;

      if (i.action === "remember") {
        const content = i.content?.trim();
        if (!content) throw new Error("LivingMind remember requires content");
        const report = await new MemoryRouter(store).write("manual", [{ kind: i.kind ?? "episodic", content, tags: ["chat-tool"] }]);
        const node = report.written[0]?.node;
        if (!node) throw new Error("LivingMind remember was not accepted by the memory router");
        return {
          output: { action: i.action, home, count: store.count(), result: node },
          display: `remembered ${node.kind}: ${compactLine(node.content, 140)}`,
        };
      }

      if (i.action === "recall") {
        const cue = (i.cue ?? i.content)?.trim();
        if (!cue) throw new Error("LivingMind recall requires cue");
        const result = await store.remember(cue, { limit });
        return {
          output: { action: i.action, home, count: store.count(), result },
          display: result.length
            ? `recalled ${result.length}: ${compactLine(result[0].node.content, 140)}`
            : "nothing came to mind",
        };
      }

      if (i.action === "consolidate") {
        const result = await withConsolidationLock(context.mind.memoryFile, () => store.consolidate());
        if (!result) {
          return {
            output: { action: i.action, home, count: store.count(), result: null },
            display: "consolidation skipped — another Ares process holds the consolidation lock",
          };
        }
        return {
          output: { action: i.action, home, count: store.count(), result },
          display: `consolidated: pruned ${result.pruned}, promoted ${result.promoted.length}, kept ${result.kept}`,
        };
      }

      if (i.action === "status") {
        return {
          output: { action: i.action, home, count: store.count(), result: { memoryFile: context.mind.memoryFile } },
          display: `LivingMind: ${store.count()} memories`,
        };
      }

      const result = store.all().slice(-limit).reverse();
      return {
        output: { action: i.action, home, count: store.count(), result },
        display: `listed ${result.length}/${store.count()} memories`,
      };
    },
  });
}

const standingOrderInput = z
  .object({
    action: z.enum(["add", "list", "cancel"]).describe("add a recurring mission, list them, or cancel one by id"),
    statement: z.string().optional().describe("The recurring mission, e.g. 'Summarize any new important email and report it'. Required for add."),
    every_minutes: z.number().int().min(5).optional().describe("How often to run it, in minutes (min 5). E.g. 120 for every 2 hours. Required for add."),
    id: z.string().optional().describe("Standing-order id to cancel. Required for cancel."),
  })
  .strict();

interface StandingOrderToolOutput {
  action: string;
  result: string;
  id?: string;
}

/** The natural-language path to autonomy: the agent calls this whenever the owner
 *  asks for recurring/standing work ("every 2 hours, check my email") — no slash
 *  command needed. Materialized due orders run unattended under the safety gate. */
function makeStandingOrderTool(context: CliRuntimeContext) {
  return buildTool({
    name: "StandingOrder",
    description:
      "Queue, list, or cancel STANDING ORDERS — recurring missions Ares runs on its own on a schedule, even while the owner is away (e.g. 'every 2 hours summarize new important email', 'each morning brief me on AI news'). " +
      "Call this whenever the owner expresses recurring/scheduled intent in plain language — you do NOT need them to use a command. Each order runs unattended under Ares's safety gates and reports back.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: standingOrderInput,
    activityDescription: (i) => (i.action === "add" ? "Queuing a standing order" : i.action === "cancel" ? "Cancelling a standing order" : "Listing standing orders"),
    async call(i): Promise<{ output: StandingOrderToolOutput; display: string }> {
      if (i.action === "add") {
        const statement = i.statement?.trim();
        if (!statement) throw new Error("StandingOrder add requires a statement");
        const minutes = i.every_minutes ?? 60;
        const order = await addStandingOrder(context.home, { statement, cadenceMs: minutes * 60_000 });
        const cadence = minutes >= 60 ? `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)}h` : `${minutes}m`;
        return {
          output: { action: i.action, id: order.id, result: `Standing order queued (${order.id}): "${statement}" every ${cadence}. It will run unattended and report back.` },
          display: `Standing order: ${compactLine(statement, 80)} every ${cadence}`,
        };
      }
      if (i.action === "cancel") {
        if (!i.id) throw new Error("StandingOrder cancel requires an id");
        const ok = await removeStandingOrder(context.home, i.id);
        return { output: { action: i.action, result: ok ? `Cancelled standing order ${i.id}.` : `No standing order ${i.id}.` }, display: ok ? `Cancelled ${i.id}` : `No ${i.id}` };
      }
      const orders = await loadStandingOrders(context.home);
      return { output: { action: i.action, result: renderStandingOrders(orders) }, display: `${orders.length} standing orders` };
    },
  });
}

const watcherInput = z
  .object({
    action: z.enum(["add", "list", "remove"]).describe("add a condition watcher, list them, or remove one by id"),
    label: z.string().optional().describe("Short human name, e.g. 'build failing'. Required for add."),
    condition: z
      .object({
        kind: z.enum(["always", "file", "command", "http"]),
        met: z.boolean().optional(),
        summary: z.string().optional(),
        path: z.string().optional(),
        contains: z.string().optional(),
        cmd: z.string().optional(),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        expectExit: z.number().int().optional(),
        url: z.string().optional(),
        expectStatus: z.number().int().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional()
      .describe("The reality probe — file present/absent, command exit, http status. Required for add."),
    fire_when: z.enum(["met", "unmet"]).optional().describe("Fire when the probe is red ('unmet', default) or green ('met')."),
    proposal: z.string().optional().describe("What Ares should investigate/do when it fires. Required for add."),
    every_minutes: z.number().int().min(1).optional().describe("How often to check, in minutes (min 1, default 15)."),
    mode: z
      .enum(["plan", "execute"])
      .optional()
      .describe("plan (default): a trip proposes for the owner's approval. execute: a trip asks the owner LIVE for consent to act; deny or no answer degrades to a proposal."),
    wake_on: z
      .array(z.string())
      .optional()
      .describe("Event kinds (e.g. 'turn_settled') that check this watcher immediately instead of waiting out its cadence."),
    id: z.string().optional().describe("Watcher id to remove. Required for remove."),
  })
  .strict();

interface WatcherToolOutput {
  action: string;
  result: string;
  id?: string;
}

/** The natural-language path to vigilance: the agent calls this whenever the
 *  owner asks Ares to keep an eye on a condition ("tell me if the build goes
 *  red", "watch the site and restart it if it's down"). Plan-mode trips
 *  propose; execute-mode trips ask the owner for live consent first. */
function makeWatcherTool(context: CliRuntimeContext) {
  return buildTool({
    name: "Watcher",
    description:
      "Add, list, or remove CONDITION WATCHERS — reality probes Ares checks on its own schedule (file present, command exit, http status). When one trips, Ares proposes what to do about it (mode 'plan', default), or — with mode 'execute' — asks the owner for live consent to act on it. " +
      "Call this whenever the owner expresses watch-this intent in plain language ('let me know if…', 'keep an eye on…', 'if the site goes down, restart it').",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: watcherInput,
    activityDescription: (i) => (i.action === "add" ? "Adding a watcher" : i.action === "remove" ? "Removing a watcher" : "Listing watchers"),
    async call(i): Promise<{ output: WatcherToolOutput; display: string }> {
      if (i.action === "add") {
        const label = i.label?.trim();
        const proposal = i.proposal?.trim();
        if (!label || !proposal || !i.condition) throw new Error("Watcher add requires label, condition, and proposal");
        const watcher = await addWatcher(context.home, {
          label,
          condition: i.condition as VerificationSpec,
          proposal,
          fireWhen: i.fire_when,
          cadenceMs: (i.every_minutes ?? 15) * 60_000,
          mode: i.mode,
          wakeOn: i.wake_on,
        });
        const gated = watcher.mode === "execute" ? " Trips will ask the owner for live consent before acting; without an answer it proposes instead." : " Trips propose — never act.";
        return {
          output: { action: i.action, id: watcher.id, result: `Watcher added (${watcher.id}): "${label}".${gated}` },
          display: `Watcher: ${compactLine(label, 60)} (${watcher.mode})`,
        };
      }
      if (i.action === "remove") {
        if (!i.id) throw new Error("Watcher remove requires an id");
        const ok = await removeWatcher(context.home, i.id);
        return { output: { action: i.action, result: ok ? `Removed watcher ${i.id}.` : `No watcher ${i.id}.` }, display: ok ? `Removed ${i.id}` : `No ${i.id}` };
      }
      const watchers = await loadWatchers(context.home);
      return { output: { action: i.action, result: renderWatchers(watchers) }, display: `${watchers.length} watchers` };
    },
  });
}

const verificationInput = z
  .object({
    kind: z.enum(["always", "file", "command", "http"]),
    met: z.boolean().optional(),
    summary: z.string().optional(),
    path: z.string().optional(),
    contains: z.string().optional(),
    cmd: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    expectExit: z.number().int().optional(),
    url: z.string().optional(),
    expectStatus: z.number().int().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const operatorChatInput = z
  .object({
    action: z
      .enum(["create", "run", "acquire", "list", "status", "caps", "stats", "acquisitions"])
      .describe("Operator operation: create/run durable goals, acquire a missing capability, or inspect the competence graph."),
    goal: z.string().optional().describe("Goal statement for create/run."),
    capability: z.string().optional().describe("Missing capability to acquire, e.g. email connector, Shopify connector, Stripe test-mode integration."),
    kind: z.enum(["skill", "connector", "tool", "mcp", "script"]).optional().describe("What kind of surface to build for the missing capability."),
    requires: z.array(z.string()).optional().describe("Reusable subskills this capability composes from."),
    targetFiles: z.array(z.string()).optional().describe("Expected files/skill paths the worker should create or edit."),
    id: z.string().optional().describe("Goal id for status/run."),
    ticks: z.number().int().min(0).max(20).optional().describe("Maximum ticks to run now. For acquire, defaults to 1 so Ares starts building immediately; pass 0 to only queue."),
    verification: verificationInput.optional().describe("Reality probe that decides whether the goal is truly met."),
  })
  .strict();

interface OperatorChatOutput {
  action: string;
  home: string;
  result: unknown;
}

function makeOperatorChatTool(opts: {
  selection: ProviderSelection;
  runtime: AresRuntimeState;
  context: CliRuntimeContext;
  workerTools: readonly EngineTool[];
  sessionKernel: SessionKernelStore;
}) {
  return buildTool({
    name: "Operator",
    description:
      "Ares's durable will and self-acquisition loop. Use it for long-horizon goals that should survive turns, and when a capability is missing use action=acquire to create the build packet, graph node, verification probe, and start a fresh Worker building it.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: operatorChatInput,
    activityDescription: (i) => `Operator ${i.action}`,

    async call(i, ctx): Promise<{ output: OperatorChatOutput; display: string }> {
      const home = opts.context.home;

      if (i.action === "create") {
        const statement = i.goal?.trim();
        if (!statement) throw new Error("Operator create requires goal");
        const goal = createGoal({
          id: i.id ?? newGoalId(),
          statement,
          verification: i.verification ? toVerificationSpec(i.verification) : undefined,
        });
        await saveGoal(home, goal);
        return {
          output: { action: i.action, home, result: goal },
          display: `created durable goal ${goal.id}`,
        };
      }

      if (i.action === "acquire") {
        const capabilityName = (i.capability ?? i.goal)?.trim();
        if (!capabilityName) throw new Error("Operator acquire requires capability or goal");
        const acquired = await acquireCapability({
          home,
          capabilityName,
          kind: i.kind as AcquisitionKind | undefined,
          requires: i.requires,
          targetFiles: i.targetFiles,
          verification: i.verification ? toVerificationSpec(i.verification) : undefined,
        });
        const ticks = i.ticks ?? 1;
        let final: Goal | null = null;
        if (ticks > 0) {
          const dispatcher = new QueryEngineDispatcher({
            provider: opts.selection.provider,
            model: opts.selection.model,
            workspace: ctx.workspace,
            tools: opts.workerTools,
            systemPrompt: buildSystemPrompt(opts.runtime.permissionMode, opts.context),
            sessionKernel: opts.sessionKernel,
            parentSessionId: ctx.sessionId,
            telemetryDir: path.join(opts.context.home, "telemetry"),
            sessionRegistryHome: opts.context.home,
            // This dispatcher runs INSIDE an interactive tool call — bubble the
            // Worker's permission prompts to the live session instead of the
            // hard "no prompt available" death (workspace-escape fleet killer).
            requestPermission: ctx.requestPermission,
          });
          // Wrapped so the cockpit can report whether the mission loop actually
          // ran. Previously it could only say "not instrumented" — the same
          // blind spot that hid dead triage for three releases.
          final = await withMissionRunRecorded(acquired.goal.id, ticks, () =>
            runGoalToCompletion(
              {
                home,
                dispatcher,
                workspace: ctx.workspace,
                signal: ctx.signal,
              },
              acquired.goal.id,
              { maxTicks: ticks },
            ),
          );
        }
        return {
          output: { action: i.action, home, result: { ...acquired, final } },
          display: final
            ? `acquiring ${capabilityName}: ${acquired.goal.id} -> ${final.status} (${final.progress}/${final.stepLog.length})`
            : `queued acquisition ${acquired.acquisition.id} for ${capabilityName}`,
        };
      }

      if (i.action === "run") {
        let targetId = i.id;
        if (!targetId && i.goal?.trim()) {
          const goal = createGoal({
            id: newGoalId(),
            statement: i.goal.trim(),
            verification: i.verification ? toVerificationSpec(i.verification) : undefined,
          });
          await saveGoal(home, goal);
          targetId = goal.id;
        }
        const active = (await listGoals(home)).filter((g) => g.status === "active");
        const targets = targetId ? active.filter((g) => g.id === targetId) : active;
        if (targets.length === 0) {
          return {
            output: { action: i.action, home, result: [] },
            display: "no active Operator goals matched",
          };
        }
        const dispatcher = new QueryEngineDispatcher({
          provider: opts.selection.provider,
          model: opts.selection.model,
          workspace: ctx.workspace,
          tools: opts.workerTools,
          systemPrompt: buildSystemPrompt(opts.runtime.permissionMode, opts.context),
          sessionKernel: opts.sessionKernel,
          parentSessionId: ctx.sessionId,
          telemetryDir: path.join(opts.context.home, "telemetry"),
          sessionRegistryHome: opts.context.home,
          // Interactive context — bubble Worker permission prompts (see acquire).
          requestPermission: ctx.requestPermission,
        });
        const result: Goal[] = [];
        for (const goal of targets) {
          result.push(
            await withMissionRunRecorded(goal.id, i.ticks ?? 1, () =>
              runGoalToCompletion(
                {
                  home,
                  dispatcher,
                  workspace: ctx.workspace,
                  signal: ctx.signal,
                },
                goal.id,
                { maxTicks: i.ticks ?? 1 },
              ),
            ),
          );
        }
        return {
          output: { action: i.action, home, result },
          display: result.map((g) => `${g.id} -> ${g.status} (${g.progress}/${g.stepLog.length})`).join("; "),
        };
      }

      if (i.action === "status") {
        const goals = await listGoals(home);
        const result = i.id ? goals.find((g) => g.id === i.id) ?? null : goals[0] ?? null;
        return {
          output: { action: i.action, home, result },
          display: result ? `${result.id}: ${result.status} - ${compactLine(result.statement, 120)}` : "no goals found",
        };
      }

      if (i.action === "list") {
        const result = await listGoals(home);
        return {
          output: { action: i.action, home, result },
          display: `listed ${result.length} Operator goals`,
        };
      }

      if (i.action === "acquisitions") {
        const result = await listAcquisitions(home);
        return {
          output: { action: i.action, home, result },
          display: `listed ${result.length} acquisition packet(s)`,
        };
      }

      if (i.action === "caps") {
        const caps = await listCapabilities(home);
        const result = caps.map((c) => ({
          ...c,
          reliability: reliabilityOf(c),
        }));
        return {
          output: { action: i.action, home, result },
          display: `listed ${result.length} learned capabilities`,
        };
      }

      const caps = await listCapabilities(home);
      const mastered = caps.filter((c) => c.status === "mastered").length;
      const result = { total: caps.length, mastered, curve: novelDeltaCurve(caps) };
      return {
        output: { action: i.action, home, result },
        display: `${caps.length} capabilities, ${mastered} mastered`,
      };
    },
  });
}

type VerificationInput = z.infer<typeof verificationInput>;

function toVerificationSpec(input: VerificationInput): VerificationSpec {
  if (input.kind === "always") {
    return { kind: "always", met: input.met ?? false, summary: input.summary };
  }
  if (input.kind === "file") {
    if (!input.path) throw new Error("file verification requires path");
    return { kind: "file", path: input.path, contains: input.contains };
  }
  if (input.kind === "command") {
    if (!input.cmd) throw new Error("command verification requires cmd");
    return {
      kind: "command",
      cmd: input.cmd,
      args: input.args,
      cwd: input.cwd,
      expectExit: input.expectExit,
      timeoutMs: input.timeoutMs,
    };
  }
  if (!input.url) throw new Error("http verification requires url");
  return {
    kind: "http",
    url: input.url,
    expectStatus: input.expectStatus,
    contains: input.contains,
    timeoutMs: input.timeoutMs,
  };
}
