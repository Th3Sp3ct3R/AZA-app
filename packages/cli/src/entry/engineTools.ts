// Extracted from entry.ts — engineTools.

import { AresSubagentRunner, SubagentRegistry, type EngineTool, type ToolCallContext } from "@ares/core";
import path from "node:path";
import { DEFAULT_TOOLS, ReadTool, WriteTool, EditTool, ApplyIntentTool, GlobTool, GrepTool, CodebaseSearchTool, LspTool, PowerShellTool, BashTool, FindAndEditTool, CodeModeTool, adaptToolForEngine, buildTool, makeTodoWriteTool, makeTaskTool, makeConductorTool, makeCodingBackendTool, makeWebFetchTool, makeWebSearchTool, makeImageSearchTool, makeBashOutputTool, makeKillShellTool, makeEnterPlanModeTool, makeExitPlanModeTool, TodoStore, ShellRegistry, type RichToolContext, type FileReadStamp, type PathPermissionStore, type CommandPermissionStore } from "@ares/tools";
import { z } from "zod";
import { decidePermission } from "../permissionPolicy.js";
import { loadUiSettings } from "../uiSettings.js";
import { aresGatewayBase } from "./providers.js";
import { makeTelegramSetupTool } from "../telegramSetupTool.js";
import { makeTelegramRosterTool } from "../telegramRosterTool.js";
import { BootstrapTool, MissionTool, RunSkillTool, SelfEvolveTool, SelfTool, SkillCraftTool, makeSkillHubTool } from "@ares/agent";
import { QueryEngineDispatcher, acquireCapability, createGoal, listGoals, listAcquisitions, listCapabilities, newGoalId, novelDeltaCurve, reliabilityOf, runGoalToCompletion, saveGoal, loadStandingOrders, addStandingOrder, removeStandingOrder, renderStandingOrders, type StandingOrder, type Goal, type AcquisitionKind, type VerificationSpec } from "@ares/operator";
import { MemoryRouter, MemoryStore, withConsolidationLock } from "@ares/mind";
import { makeBrowserTool } from "./browserBridge.js";
import { ProviderSelection, fastModelFor } from "./providers.js";
import { AresRuntimeState, CliRuntimeContext, compactLine } from "./runtime.js";
import { buildSystemPrompt } from "./turnPipeline.js";

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
): Promise<EngineTool[]> {
  const enrich = (base: ToolCallContext): RichToolContext => ({
    ...base,
    permissionMode: runtime.permissionMode,
    // Prefer the engine-owned map (subagents supply their own) so parent and
    // child never share read state; fall back to the parent's shared map.
    fileReadStamps: (base.fileReadStamps as Map<string, FileReadStamp>) ?? fileReadStamps,
    pathPermissions,
    commandPermissions,
    shellRegistry,
    todoStore,
    subModel: selection.subModel,
  });

  const baseToolDefs = [
    ...DEFAULT_TOOLS,
    makeTodoWriteTool(todoStore),
    makeWebSearchTool(),
    makeImageSearchTool(),
    makeWebFetchTool(selection.subModel),
    makeBashOutputTool(shellRegistry),
    makeKillShellTool(shellRegistry),
    makeEnterPlanModeTool(runtime),
    makeExitPlanModeTool(runtime),
    BootstrapTool,
    SelfEvolveTool,
    SkillCraftTool,
    RunSkillTool,
    MissionTool,
    SelfTool,
    makeTelegramSetupTool(),
    makeTelegramRosterTool(),
  ];

  const baseTools = baseToolDefs.map((tool) => {
    const adapted = adaptToolForEngine(tool, (base: ToolCallContext): RichToolContext => ({
      ...enrich(base),
    }));
    return adapted as EngineTool;
  });

  const runner = new AresSubagentRunner({
    registry: new SubagentRegistry(),
    provider: selection.provider,
    model: selection.model,
    // Explorer subagents fan out on the family's cheap sibling (flash/haiku/
    // gateway-fast) — wide search shouldn't burn frontier tokens.
    fastModel: fastModelFor(selection),
    parentTools: baseTools,
    baseSystemPrompt: buildSystemPrompt(runtime.permissionMode, context),
    maxTurns: () => {
      const value = Number(process.env.ARES_SUBAGENT_TURN_LIMIT);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
    },
  });
  const taskTool = adaptToolForEngine(makeTaskTool(runner), enrich) as EngineTool;
  const workerTools = [...baseTools, taskTool];
  // The Conductor — author + run a deterministic agent FLEET (capped parallel
  // fan-out, typed pipelines, schema-validated leaves, token budget). parentTools
  // is baseTools (NOT workerTools) so fleet leaves can't get Task/Conductor and
  // recurse; it's added to the MAIN agent list only, so subagents can't orchestrate.
  const conductorTool = adaptToolForEngine(
    makeConductorTool({
      provider: selection.provider,
      model: selection.model,
      parentTools: baseTools,
      baseSystemPrompt: buildSystemPrompt(runtime.permissionMode, context),
      subModel: selection.subModel,
      // Was 20 — leaves doing several reads + producing structured output ran out
      // of turns mid-read and died, which read as "the fleet always fails." 40
      // gives a leaf room to finish; per-fleet overrides still apply.
      defaultMaxTurns: 40,
      // "Fleets inherit my permissions" toggle: leaves can't prompt, so the policy
      // resolves to allow_once / deny. Reads runtime.permissions LIVE so the
      // toggle applies to the next fleet without rebuilding the session.
      leafRequestPermission: async (req) =>
        decidePermission(req, runtime.permissions, { fleet: true }) === "allow" ? "allow_once" : "deny",
    }),
    enrich,
  ) as EngineTool;
  const livingMindTool = adaptToolForEngine(makeLivingMindTool(context), enrich) as EngineTool;
  const standingOrderTool = adaptToolForEngine(makeStandingOrderTool(context), enrich) as EngineTool;
  const browserTool = adaptToolForEngine(makeBrowserTool(context), enrich) as EngineTool;
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
  const operatorWorkerTools = [...workerTools, livingMindTool, browserTool];
  const operatorTool = adaptToolForEngine(
    makeOperatorChatTool({
      selection,
      runtime,
      context,
      workerTools: operatorWorkerTools,
    }),
    enrich,
  ) as EngineTool;
  return [...workerTools, livingMindTool, standingOrderTool, operatorTool, browserTool, conductorTool, codingBackendTool, skillHubTool];
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
): Promise<EngineTool[]> {
  const enrich = (base: ToolCallContext): RichToolContext => ({
    ...base,
    permissionMode: runtime.permissionMode,
    fileReadStamps: (base.fileReadStamps as Map<string, FileReadStamp>) ?? fileReadStamps,
    pathPermissions,
    commandPermissions,
    shellRegistry,
    todoStore,
    subModel: selection.subModel,
  });
  const codingDefs = [
    ReadTool,
    WriteTool,
    EditTool,
    ApplyIntentTool,
    GlobTool,
    GrepTool,
    CodebaseSearchTool,
    LspTool,
    ...(options.shell === false ? [] : process.platform === "win32" ? [PowerShellTool, BashTool] : [BashTool, PowerShellTool]),
    FindAndEditTool,
    CodeModeTool,
    makeTodoWriteTool(todoStore),
    ...(options.shell === false ? [] : [makeBashOutputTool(shellRegistry), makeKillShellTool(shellRegistry)]),
    makeEnterPlanModeTool(runtime),
    makeExitPlanModeTool(runtime),
  ];
  const baseTools = codingDefs.map((tool) => adaptToolForEngine(tool, enrich) as EngineTool);
  if (options.subagents === false) return baseTools;

  const runner = new AresSubagentRunner({
    registry: new SubagentRegistry(),
    provider: selection.provider,
    model: selection.model,
    fastModel: fastModelFor(selection),
    parentTools: baseTools,
    baseSystemPrompt: buildSystemPrompt(runtime.permissionMode, context),
    maxTurns: () => {
      const value = Number(process.env.ARES_SUBAGENT_TURN_LIMIT);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
    },
  });
  const taskTool = adaptToolForEngine(makeTaskTool(runner), enrich) as EngineTool;
  if (options.conductor === false) return [...baseTools, taskTool];
  const conductorTool = adaptToolForEngine(
    makeConductorTool({
      provider: selection.provider,
      model: selection.model,
      parentTools: baseTools,
      baseSystemPrompt: buildSystemPrompt(runtime.permissionMode, context),
      subModel: selection.subModel,
      defaultMaxTurns: 40,
      leafRequestPermission: async (request) =>
        decidePermission(request, runtime.permissions, { fleet: true }) === "allow" ? "allow_once" : "deny",
    }),
    enrich,
  ) as EngineTool;
  return [...baseTools, taskTool, conductorTool];
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
            // This dispatcher runs INSIDE an interactive tool call — bubble the
            // Worker's permission prompts to the live session instead of the
            // hard "no prompt available" death (workspace-escape fleet killer).
            requestPermission: ctx.requestPermission,
          });
          final = await runGoalToCompletion(
            {
              home,
              dispatcher,
              workspace: ctx.workspace,
              signal: ctx.signal,
            },
            acquired.goal.id,
            { maxTicks: ticks },
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
          // Interactive context — bubble Worker permission prompts (see acquire).
          requestPermission: ctx.requestPermission,
        });
        const result: Goal[] = [];
        for (const goal of targets) {
          result.push(
            await runGoalToCompletion(
              {
                home,
                dispatcher,
                workspace: ctx.workspace,
                signal: ctx.signal,
              },
              goal.id,
              { maxTicks: i.ticks ?? 1 },
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
