// Extracted from entry.ts — garrisonCmd.

import { QueryEngine, installGlobalCrashHandlers, runReliabilityTriage, writeCrashLogSync } from "@ares/core";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { TodoStore, ShellRegistry, type FileReadStamp } from "@ares/tools";
import { dim, notice } from "../terminalUi.js";
import { loadUiSettings } from "../uiSettings.js";
import { prepareAresAgent, runDeepDream, runHeartbeatTick } from "@ares/agent";
import { QueryEngineDispatcher, OperatorBackgroundLoop, isOperatorPaused, runCrucibleTrials, loadStandingOrders, materializeDueStandingOrders, type StandingOrder } from "@ares/operator";
import { MemoryStore, detectWorkspaceProjectId, loadProjectState, withConsolidationLock } from "@ares/mind";
import { SessionManager, GarrisonServer, Scheduler, ApprovalQueue, tokenPath, DEFAULT_GARRISON_PORT, type GatewayServerFrame } from "@ares/garrison";
import { buildHolotableHtml, MECH_SPEC, ROBOT_ARM_SPEC, type HoloSpec } from "../holotable.js";
import { runEffect } from "@ares/effects";
import { gateToolPermission, remoteAutonomyDecision } from "../policyGate.js";
import { applyEngineConfigEnv } from "./daemon.js";
import { buildEngineTools } from "./engineTools.js";
import { AresCommandPermissionStore, AresPathPermissionStore } from "./permissions.js";
import { providerFamilyForSelection, selectProvider } from "./providers.js";
import { AresRuntimeState, ParsedArgs, cliRuntimeContext } from "./runtime.js";
import { chatContextBudget, chatMaxOutputTokens, invalidateTrimmedReadStamps, makeSpanSummarizer, resolveReasoningLevel } from "./sessionFactory.js";
import { TelegramModelControl, buildOperatorReporter, sendWarMapBriefing, startTelegramBridge, startTelegramCheckins } from "./telegramWiring.js";
import { persistTerminalModelPreference, terminalModelCatalogLines } from "./terminalLines.js";
import { buildSystemPrompt, loadGitContext } from "./turnPipeline.js";

/**
 * The Holotable — `ares holo [model.glb] [--out file] [--title text]`.
 * Emits a self-contained hologram-style 3D viewer (bronze wireframe + glow,
 * exploded-view slider, orbit controls). No model -> the procedural mech.
 */
export async function holoCommand(args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  const out = path.resolve(args.flags.get("out") ?? "holo.html");
  let html: string;
  let what: string;
  try {
    if (target && /\.(glb|gltf)$/i.test(target)) {
      html = buildHolotableHtml({ title: args.flags.get("title") ?? `ARES // HOLOTABLE — ${path.basename(target)}`, modelUrl: target });
      what = `model ${path.basename(target)} (radial explode)`;
    } else if (target && /\.json$/i.test(target)) {
      const spec = JSON.parse(await readFile(path.resolve(target), "utf8")) as HoloSpec;
      html = buildHolotableHtml({ spec, title: args.flags.get("title") });
      what = `spec "${spec.title}" — ${spec.parts.length} parts, ${spec.wires?.length ?? 0} wires, ${spec.steps?.length ?? 0} steps`;
    } else if (target === "arm") {
      html = buildHolotableHtml({ spec: ROBOT_ARM_SPEC, title: args.flags.get("title") });
      what = "the DIY robot arm build (print list, vendor list, wiring, 8 steps)";
    } else {
      html = buildHolotableHtml({ spec: MECH_SPEC, title: args.flags.get("title") });
      what = "the MK I mech showpiece";
    }
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}
`);
    return 2;
  }
  await writeFile(out, html, "utf8");
  process.stdout.write(
    notice(
      "Holotable",
      [
        `forged ${out} — ${what}`,
        "drag · rotate   slider · disassemble   ASSEMBLY MODE · step-by-step build",
        "WIRING · routed runs   PARTS/BOM · print-vs-buy + STL export",
      ],
      "success",
    ),
  );
  return 0;
}

export async function garrisonCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "serve";
  if (sub !== "serve") {
    process.stderr.write("error: usage: ares garrison serve [--port N] [--provider mock|openai|ollama|anthropic|deepseek|openrouter] [--model X]\n");
    return 2;
  }
  // Reassignable so a Telegram /model switch reconfigures the provider for new
  // sessions in place — the session factory closure reads the latest `selection`.
  let selection = await selectProvider(args.flags);
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const pathPermissions = await AresPathPermissionStore.load(context);
  const commandPermissions = await AresCommandPermissionStore.load(context);
  const settings = await loadUiSettings();
  applyEngineConfigEnv(settings.engine ?? {});
  const runtime: AresRuntimeState = { permissionMode: settings.dangerousBypass === true ? "bypass" : "workspace-write" };
  // Crash safety for the gateway process (Telegram + any garrison clients). It
  // keeps its own SIGINT/SIGTERM shutdown below, so we only add the uncaught/
  // rejection net here (handleSignals:false). Fatals land in ~/.ares/crashes;
  // a stray rejection is logged but no longer kills the channel.
  const uninstallGarrisonCrashHandlers = installGlobalCrashHandlers({
    home: context.home,
    process: "garrison",
    getContext: () => ({ provider: selection.provider.name, model: selection.model }),
    emit: (notice) => process.stderr.write(`garrison: crash(${notice.kind}): ${notice.message} → ${notice.logFile ?? "(unwritten)"}\n`),
    handleSignals: false,
  });
  // V1 slice tradeoff: one shared tool harness across daemon sessions (shell
  // registry and todo state are daemon-global). Per-session isolation arrives
  // with the full V2 composition.
  const shellRegistry = new ShellRegistry();
  const todoStore = new TodoStore();
  const garrisonReadStamps = new Map<string, FileReadStamp>();
  const tools = await buildEngineTools(pathPermissions, commandPermissions, selection, runtime, context, shellRegistry, todoStore, garrisonReadStamps);
  const isMock = selection.provider.name.startsWith("mock");
  const agent = await prepareAresAgent({
    home: context.home,
    workspace: context.workspace,
    enabled: process.env.ARES_AGENT_ENABLED === "1" || (!isMock && process.env.ARES_AGENT_ENABLED !== "0"),
  });
  const systemPrompt =
    agent.composeSystemPrompt(buildSystemPrompt(runtime.permissionMode, context)) + (await loadGitContext(context));

  const sessions = new SessionManager({
    home: context.home,
    factory: (req) => ({
      engine: new QueryEngine(
        {
          provider: selection.provider,
          model: req.model ?? selection.model,
          systemPrompt,
          tools,
          workspace: req.workspace ?? context.workspace,
          signal: req.signal,
          // Remote-autonomy gate: safe work (research, fetch, read, navigate,
          // desktop control, workspace edits) runs without a prompt so Ares
          // doesn't freeze waiting on a tap nobody's there to give. Only the
          // dangerous few — money, mail, publish, credentials, wipes — escalate
          // to the owner's phone (and auto-deny if unanswered — the safe miss).
          requestPermission: req.requestPermission
            ? async (request) => {
                const decision = remoteAutonomyDecision(request);
                if (decision === "allow") return "allow_once";
                if (decision === "deny") return "deny";
                return req.requestPermission!(request);
              }
            : req.requestPermission,
          reasoningLevel: resolveReasoningLevel(settings),
          maxOutputTokens: chatMaxOutputTokens(selection),
          contextBudgetTokens: chatContextBudget(selection),
          onHistoryTrimmed: (dropped) =>
            invalidateTrimmedReadStamps(garrisonReadStamps, req.workspace ?? context.workspace, dropped),
          summarizeSpan: makeSpanSummarizer(selection),
        },
        req.sessionId,
      ),
      providerName: selection.provider.name,
      model: req.model ?? selection.model,
      workspace: req.workspace ?? context.workspace,
    }),
  });
  const restored = await sessions.rehydrate();

  const scheduler = new Scheduler({
    hooks: {
      heartbeat: async () => {
        const triage = runReliabilityTriage({ home: context.aresHome, workspace: context.workspace }).catch((error: unknown) => {
          writeCrashLogSync(context.aresHome, {
            at: new Date().toISOString(),
            kind: "manual",
            process: "reliability-triage",
            message: error instanceof Error ? error.message : String(error),
          });
          process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "triage-error" } }) + "\n");
        });
        const [heartbeat] = await Promise.allSettled([
          runHeartbeatTick({ home: context.home, workspace: context.workspace, config: agent.config }),
          triage,
        ]);
        if (heartbeat.status === "rejected") throw heartbeat.reason;
        return heartbeat.value;
      },
      // Dreams become the trial: every dream tick runs the Crucible first,
      // then the existing deep-dream consolidation.
      dream: async () => {
        const store = await MemoryStore.open(context.mind.memoryFile);
        const trial = await runCrucibleTrials({ store, workspace: context.workspace });
        if (agent.config.dreaming.enabled) {
          // Lock-guarded: the daemon may be consolidating the same ~/.ares memory.
          await withConsolidationLock(context.mind.memoryFile, () =>
            runDeepDream({ home: context.home, workspace: context.workspace, config: agent.config }),
          ).catch(() => undefined);
        }
        return trial;
      },
    },
    lastActivityAt: () => sessions.lastActivityAt(),
  });

  // Telegram reports: a voice outside the app. When ARES_TELEGRAM=1 + a bot token
  // + chat id are set, the operator loop's events become compact mission updates
  // on your phone. Best-effort — a Telegram outage never touches the loop.
  const telegramReporter = await buildOperatorReporter();

  // Always-on autonomy: advance durable Operator goals unattended, attention-
  // ranked (not naive active[0]), fed the active project's war map. OPT-IN only —
  // runs solely with ARES_OPERATOR_LOOP=1, never by surprise. Outward/risky tool
  // use is hard-denied unattended (the policy gate), so an idle tick can't move
  // money, send mail, or drive the browser without a human.
  // Autonomy runs when explicitly opted in (ARES_OPERATOR_LOOP=1) OR when the
  // owner has queued standing orders — adding a recurring mission IS the opt-in.
  // The autotick kill switch still wins. Standing orders that come due each tick
  // materialize into goals the loop then executes under the unattended gate.
  const standingAtStart = await loadStandingOrders(context.home).catch(() => [] as StandingOrder[]);
  const loopActive = process.env.ARES_OPERATOR_AUTOTICK !== "0" && (process.env.ARES_OPERATOR_LOOP === "1" || standingAtStart.length > 0);
  const operatorLoop = !loopActive
    ? null
    : new OperatorBackgroundLoop(
        {
          home: context.home,
          workspace: context.workspace,
          dispatcher: new QueryEngineDispatcher({
            provider: selection.provider,
            model: selection.model,
            workspace: context.workspace,
            tools,
            systemPrompt: agent.composeSystemPrompt(buildSystemPrompt("workspace-write", context)),
            requestPermission: async (request) => {
              const gate = gateToolPermission(request, { attended: false });
              return gate.kind === "allow" ? "allow_once" : "deny";
            },
          }),
        },
        {
          everyMs: Math.max(60_000, Number(process.env.ARES_OPERATOR_TICK_MS) || 30 * 60_000),
          // Materialize due standing orders into goals so the same tick runs them.
          beforeTick: async () => {
            const { fired } = await materializeDueStandingOrders(context.home).catch(() => ({ goals: [], fired: [] as StandingOrder[] }));
            for (const order of fired) {
              process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "standing_order_fired", id: order.id, statement: order.statement.slice(0, 120) } }) + "\n");
              void telegramReporter?.report({ type: "operator_tick", goalId: order.id, status: "active", summary: `🜂 Standing order fired: ${order.statement.slice(0, 80)}` }).catch(() => {});
            }
          },
          // Mission-aware idle: surface the active project's next strategic moves.
          nextActions: async () => {
            const projectId = await detectWorkspaceProjectId(context.workspace).catch(() => undefined);
            const project = projectId ? await loadProjectState(projectId, context.home).catch(() => null) : null;
            return project?.nextActions ?? [];
          },
          // Remote /pause from Telegram (cross-process control flag) parks ticks.
          paused: () => isOperatorPaused(context.home),
          emit: (event) => {
            process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "operator", ...event } }) + "\n");
            void telegramReporter?.report(event).catch(() => {});
          },
          onError: () => {},
        },
      );

  const requestedPort = Number(args.flags.get("port") ?? process.env.ARES_GARRISON_PORT ?? DEFAULT_GARRISON_PORT);
  // The approval surface: staged outward effects (a browser submit, any
  // irreversible connector effect over its leash) pause here and broadcast to
  // every attached client as approval.pending; the owner's approval.respond
  // resumes or refuses them. Wired into the rails via context.approvals so
  // runEffect actually consults it. ARES_APPROVAL_TIMEOUT_MS auto-denies a
  // forgotten prompt (default: wait for the owner).
  const approvalTimeoutMs = Number(process.env.ARES_APPROVAL_TIMEOUT_MS) || undefined;
  const approvals = new ApprovalQueue({ approver: "owner", timeoutMs: approvalTimeoutMs });
  context.approvals = { requestApproval: approvals.requestApproval };
  const server = new GarrisonServer({ home: context.home, sessions, scheduler, approvals, port: requestedPort });
  const bound = await server.start();
  scheduler.start();
  operatorLoop?.start();
  if (telegramReporter) void sendWarMapBriefing(telegramReporter, context).catch(() => {});
  // Auto-start the Telegram bridge in-process when configured — no second
  // terminal. Connects to this gateway; best-effort, never blocks the daemon.
  const gatewayToken = await readFile(tokenPath(context.home), "utf8").then((t) => t.trim()).catch(() => "");
  // Model control over Telegram: list the catalog, and switch the live provider/
  // model by rebuilding `selection` (new sessions pick it up; the bridge resets
  // the chat's session so the switch takes effect on the next message).
  const modelControl: TelegramModelControl = {
    listModels: (provider) => terminalModelCatalogLines(provider),
    switchModel: async (provider, model) => {
      try {
        const flags = new Map<string, string>([["provider", provider]]);
        if (model) flags.set("model", model);
        const next = await selectProvider(flags);
        selection = next;
        await persistTerminalModelPreference(provider, next.model).catch(() => undefined);
        return { ok: true, text: `🔀 Switched to ${providerFamilyForSelection(next)} / ${next.model}. It applies on your next message.` };
      } catch (err) {
        return { ok: false, text: `Couldn't switch: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
  const telegramBridge = gatewayToken
    ? await startTelegramBridge(context, `ws://127.0.0.1:${bound.port}`, gatewayToken, modelControl, operatorLoop).catch(() => null)
    : null;

  // Proactive scheduled check-ins over Telegram — 9am/12pm/3pm by default.
  // Each check-in includes weather for the owner's area when configured.
  const tgCheckinScheduler = await startTelegramCheckins(context).catch(() => null);

  process.stdout.write(
    notice(
      "Garrison · standing watch",
      [
        `gateway   ws://${bound.host}:${bound.port}  (health: http://${bound.host}:${bound.port}/health)`,
        `provider  ${selection.provider.name} · ${selection.model}`,
        `sessions  ${restored.length} rehydrated`,
        `telegram  ${telegramBridge ? "bridge online" : "off"}${tgCheckinScheduler ? " + check-ins" : ""}`,
        `token     ${tokenPath(context.home)}`,
        `attach    ares attach${bound.port === DEFAULT_GARRISON_PORT ? "" : ` --port ${bound.port}`}`,
      ],
      "success",
    ),
  );

  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      process.stdout.write("\ngarrison: standing down…\n");
      uninstallGarrisonCrashHandlers();
      scheduler.stop();
      tgCheckinScheduler?.stop();
      operatorLoop?.stop();
      void telegramBridge?.stop().catch(() => {});
      approvals.dispose();
      void sessions.flush().finally(() => server.close().finally(() => resolve(0)));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export async function attachCommand(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const port = Number(args.flags.get("port") ?? process.env.ARES_GARRISON_PORT ?? DEFAULT_GARRISON_PORT);
  const url = args.flags.get("url") ?? `ws://127.0.0.1:${port}`;
  let token: string;
  try {
    token = (await readFile(tokenPath(context.home), "utf8")).trim();
  } catch {
    process.stderr.write(`error: no garrison token at ${tokenPath(context.home)} — is the Garrison running? (ares garrison serve)\n`);
    return 2;
  }

  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(url);
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  const requestedSessionId = args.flags.get("session");
  const attached = new Set<string>();
  let activeSessionId: string | undefined = requestedSessionId;
  let streaming = false;
  let lastEventSessionId: string | undefined;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    if (!streaming) rl.prompt();
  };
  rl.setPrompt("ares> ");

  return await new Promise<number>((resolve) => {
    const bail = (message: string, code: number) => {
      process.stderr.write(`${message}\n`);
      rl.close();
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(code);
    };

    const attach = (id: string, label?: string) => {
      if (attached.has(id)) return;
      attached.add(id);
      send({ type: "session.attach", sessionId: id });
      if (label) process.stdout.write(dim(`${label}\n`));
    };

    ws.on("open", () => send({ type: "hello", token, client: "cli-attach", proto: 1 }));
    ws.on("error", (err: Error) => bail(`gateway error: ${err.message}`, 1));
    ws.on("close", () => bail("gateway closed", 0));
    ws.on("message", (raw: Buffer) => {
      let frame: GatewayServerFrame;
      try {
        frame = JSON.parse(String(raw)) as GatewayServerFrame;
      } catch {
        return;
      }
      if (frame.type === "error") {
        process.stderr.write(notice("Gateway", [frame.message], "warn"));
        streaming = false;
        prompt();
        return;
      }
      if (frame.type === "welcome") {
        if (frame.sessions.length > 0) {
          process.stdout.write(
            notice(
              "Garrison ? sessions",
              frame.sessions.map((s) => `${s.busy ? "?" : "?"} ${s.id}  ${s.title}`),
              "info",
            ),
          );
          // Mirror every existing session so the terminal reflects ongoing
          // conversations from Telegram, the desktop UI, or other clients.
          for (const s of frame.sessions) {
            attach(s.id, `attached to ${s.id} (${s.provider} ? ${s.model})`);
          }
        }
        // If the user asked for a specific session, prefer that as the send target.
        if (requestedSessionId && !attached.has(requestedSessionId)) {
          attach(requestedSessionId, `attached to ${requestedSessionId}`);
        }
        if (attached.size === 0) {
          // No sessions exist yet and no --session was requested: create one.
          send({ type: "session.create" });
        } else {
          activeSessionId ??= frame.sessions[0]?.id;
          prompt();
        }
        return;
      }
      if (frame.type === "session.created") {
        // New session broadcast by the server (e.g., Telegram just started a
        // chat). Attach to it so the terminal sees the conversation live.
        attach(frame.session.id, `session ${frame.session.id} (${frame.session.provider} ? ${frame.session.model})`);
        activeSessionId ??= frame.session.id;
        prompt();
        return;
      }
      if (frame.type === "event" && typeof frame.sessionId === "string" && attached.has(frame.sessionId)) {
        lastEventSessionId = frame.sessionId;
        const event = frame.event as { type: string } & Record<string, unknown>;
        const prefix = frame.sessionId === activeSessionId ? "" : dim(`[${frame.sessionId}] `);
        if (event.type === "text_delta") {
          streaming = true;
          process.stdout.write(prefix + String(event.text ?? ""));
        } else if (event.type === "tool_start") {
          process.stderr.write(dim(`\n[${frame.sessionId}] ? ${String(event.activityDescription ?? event.name ?? "tool")}\n`));
        } else if (event.type === "turn_end") {
          streaming = false;
          if (prefix) process.stdout.write(prefix);
          process.stdout.write("\n");
          if (event.status !== "completed") {
            process.stderr.write(notice("Turn", [`[${frame.sessionId}] status ${String(event.status)}`], "warn"));
          }
          prompt();
        }
      }
    });

    rl.on("line", (line: string) => {
      const text = line.trim();
      if (!text) {
        prompt();
        return;
      }
      if (text === "/quit" || text === "/exit") {
        bail("detached (the session lives on in the Garrison)", 0);
        return;
      }
      if (text === "/sessions") {
        send({ type: "sessions.list" });
        return;
      }
      if (text.startsWith("/use ")) {
        const id = text.slice(5).trim();
        if (attached.has(id)) {
          activeSessionId = id;
          process.stdout.write(dim(`active session: ${id}\n`));
        } else {
          attach(id, `attached to ${id}`);
          activeSessionId = id;
        }
        prompt();
        return;
      }
      const target = activeSessionId ?? lastEventSessionId ?? requestedSessionId;
      if (!target || !attached.has(target)) {
        process.stderr.write("no session yet ? waiting for the gateway\n");
        return;
      }
      streaming = true;
      send({ type: "session.send", sessionId: target, text });
    });
    rl.on("SIGINT", () => bail("detached (the session lives on in the Garrison)", 0));
  });
}
