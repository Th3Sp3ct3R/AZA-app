// Extracted from entry.ts — operatorCmd.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { notice } from "../terminalUi.js";
import { QueryEngineDispatcher, acquireCapability, attentionItemsFromCapabilities, attentionItemsFromGoals, capabilityReviewLine, deriveLeash, domainOf, capabilityReviewQueue, createGoal, decideAttention, ensureGoalMissionContract, listGoals, listAcquisitions, listCapabilities, listMissionContracts, loadCapability, loadMissionContract, missionContractCanComplete, missionContractNextVerificationAction, seedAllCapabilities, writeCapabilitiesDoc, newGoalId, novelDeltaCurve, saveCapability, reliabilityOf, runGoalToCompletion, parseEvalReportJson, draftCapability, capabilityEvidence, missionContractSummary, missionContractUnmetRequirements, promoteCapability, rejectCapabilityDraft, verificationSpecSummary, type Goal, type CapabilityEvidence, type MissionContract, type AcquisitionKind, type EvalReport, type VerificationSpec } from "@ares/operator";
import { KillSwitch, runEffect } from "@ares/effects";
import { MemoryStore } from "@ares/mind";
import { openWorkspaceSessionKernel } from "@ares/core";
import { ShellRegistry, TodoStore } from "@ares/tools";
import { capGlyph, statusGlyph } from "./mindCmd.js";
import { selectProvider, type ProviderSelection } from "./providers.js";
import { AresCommandPermissionStore, AresPathPermissionStore, promptPermission } from "./permissions.js";
import { buildCodingTools } from "./engineTools.js";
import { ParsedArgs, cliRuntimeContext, type CliRuntimeContext } from "./runtime.js";

// ─── operator command (Ares v5 / O1 — the durable autonomy spine) ──────
export async function operatorCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] ?? "list";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const home = context.home;
  await seedAllCapabilities(home)
    .then(() => listCapabilities(home))
    .then((caps) => writeCapabilitiesDoc(home, caps))
    .catch(() => undefined);

  if (subcommand === "add" || subcommand === "goal") {
    const statement = args.flags.get("goal") ?? args.positionals.slice(1).join(" ").trim();
    if (!statement) {
      process.stderr.write('error: usage: ares operator add --goal "<goal>"\n');
      return 2;
    }
    let verificationProbes: VerificationSpec[];
    try {
      verificationProbes = verificationProbesFromFlags(args);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    const criteria = textListFlag(args.flags.get("criteria") ?? args.flags.get("criterion"));
    const constraints = textListFlag(args.flags.get("constraint") ?? args.flags.get("constraints"));
    const goal = createGoal({ id: newGoalId(), statement, verification: verificationProbes[0] });
    const attached = await ensureGoalMissionContract(home, goal, {
      acceptanceCriteria: criteria,
      constraints,
      verificationProbes,
    });
    process.stdout.write(
      notice(
        "Operator",
        [
          `goal created: ${attached.goal.id}`,
          `mission contract: ${attached.contract.id}`,
          `${attached.contract.acceptanceCriteria.length} criterion/criteria, ${attached.contract.verificationProbeResults.length} probe(s)`,
          statement,
        ],
        "success",
      ),
    );
    return 0;
  }

  if (subcommand === "acquire") {
    const capabilityName = args.flags.get("capability") ?? args.flags.get("goal") ?? args.positionals.slice(1).join(" ").trim();
    if (!capabilityName) {
      process.stderr.write('error: usage: ares operator acquire --capability "<name>" [--kind skill|connector|tool|mcp|script]\n');
      return 2;
    }
    const result = await acquireCapability({
      home,
      capabilityName,
      kind: parseAcquisitionKind(args.flags.get("kind")),
      requires: csvFlag(args.flags.get("requires")),
      targetFiles: csvFlag(args.flags.get("target-files") ?? args.flags.get("targets")),
    });
    const ticks = Number(args.flags.get("ticks") ?? "0") || 0;
    let final: Goal | null = null;
    if (ticks > 0) {
      const selection = await selectProvider(args.flags);
      const dispatcher = await buildOperatorDispatcher(context, selection);
      final = await runGoalToCompletion({ home, dispatcher, workspace: context.workspace }, result.goal.id, { maxTicks: ticks });
    }
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify({ ...result, final }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      notice(
        "Operator Acquire",
        [
          `capability ${result.capability.name} [${result.capability.status}]`,
          `packet ${result.acquisition.packetFile}`,
          `goal ${result.goal.id}`,
          final ? `ran ${ticks} tick(s): ${final.status} (${final.progress}/${final.stepLog.length})` : "queued (pass --ticks N to start workers now)",
        ],
        "success",
      ),
    );
    return 0;
  }

  if (subcommand === "draft") {
    const capabilityName = args.flags.get("capability") ?? args.positionals.slice(1).join(" ").trim();
    if (!capabilityName) {
      process.stderr.write('error: usage: ares operator draft --capability "<name>" [--requires a,b]\n');
      return 2;
    }
    const capability = draftCapability({
      name: capabilityName,
      requires: csvFlag(args.flags.get("requires")),
    });
    await saveCapability(home, capability);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(capability, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Capability Draft", [`${capability.id} [${capability.status}]`, capability.name], "success"));
    return 0;
  }

  if (subcommand === "promote") {
    const capabilityId = args.flags.get("capability") ?? args.flags.get("id") ?? args.positionals[1];
    if (!capabilityId) {
      process.stderr.write('error: usage: ares operator promote --capability "<id>" --eval-report report.json [--evidence "..."]\n');
      return 2;
    }
    const capability = await loadCapability(home, capabilityId);
    if (!capability) {
      process.stderr.write(`error: capability not found: ${capabilityId}\n`);
      return 2;
    }
    const evalReport = await loadEvalReportFlag(args.flags.get("eval-report"));
    const evidence = promotionEvidenceFromFlags(args, evalReport);
    const result = promoteCapability(capability, {
      evidence,
      evalReport,
      skillRef: args.flags.get("skill") ?? args.flags.get("skill-ref") ?? undefined,
      playbookRef: args.flags.get("playbook") ?? args.flags.get("playbook-ref") ?? undefined,
      policy: promotionPolicyFromFlags(args),
    });
    if (result.promoted) await saveCapability(home, result.node);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return result.promoted ? 0 : 1;
    }
    const lines = result.promoted
      ? [`promoted ${result.node.name} -> mastered`, `skill ${result.node.skillRef ?? "(none)"}`]
      : [`held ${result.node.name}`, ...result.readiness.reasons.map((reason) => `- ${reason}`)];
    process.stdout.write(notice("Capability Promotion", lines, result.promoted ? "success" : "warn"));
    return result.promoted ? 0 : 1;
  }

  if (subcommand === "reject" || subcommand === "prune") {
    const capabilityId = args.flags.get("capability") ?? args.flags.get("id") ?? args.positionals[1];
    const reason = args.flags.get("reason") ?? args.positionals.slice(2).join(" ").trim();
    if (!capabilityId || !reason) {
      process.stderr.write('error: usage: ares operator reject --capability "<id>" --reason "<why>" [--forbidden]\n');
      return 2;
    }
    const capability = await loadCapability(home, capabilityId);
    if (!capability) {
      process.stderr.write(`error: capability not found: ${capabilityId}\n`);
      return 2;
    }
    const rejected = rejectCapabilityDraft(capability, { reason, forbidden: args.flags.has("forbidden") });
    await saveCapability(home, rejected);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(rejected, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Capability Rejected", [`${rejected.name} -> ${rejected.status}`, reason], "warn"));
    return 0;
  }

  if (subcommand === "review" || subcommand === "cap-status") {
    const capabilityId = args.flags.get("capability") ?? args.flags.get("id") ?? args.positionals[1];
    const queue = await capabilityReviewQueue(home);
    const items = capabilityId
      ? queue.filter((item) => item.id === capabilityId || item.name.toLowerCase() === capabilityId.toLowerCase())
      : queue;
    if (capabilityId && items.length === 0) {
      process.stderr.write(`error: capability not found in review queue: ${capabilityId}\n`);
      return 2;
    }
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(capabilityId ? items[0] : items, null, 2) + "\n");
      return 0;
    }
    if (items.length === 0) {
      process.stdout.write(notice("Capability Review", ["No capabilities in the review queue."], "warn"));
      return 0;
    }
    process.stdout.write(notice("Capability Review", items.map(capabilityReviewLine), "info"));
    return 0;
  }

  if (subcommand === "missions") {
    const contracts = await listMissionContracts(home);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(contracts.map(missionContractView), null, 2) + "\n");
      return 0;
    }
    if (contracts.length === 0) {
      process.stdout.write(notice("Missions", ["No mission contracts yet."], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Missions",
        contracts.map((contract) => `${contract.id} [${contract.progress.status}] ${missionContractSummary(contract)} ${contract.intent}`),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "mission") {
    const nested = args.positionals[1] ?? "status";
    if (nested !== "status") {
      process.stderr.write('error: usage: ares operator mission status <id> [--json]\n');
      return 2;
    }
    const id = args.positionals[2] ?? args.flags.get("id") ?? args.flags.get("mission");
    if (!id) {
      process.stderr.write('error: usage: ares operator mission status <id> [--json]\n');
      return 2;
    }
    const contract = await findMissionContract(home, id);
    if (!contract) {
      process.stderr.write(`error: mission not found: ${id}\n`);
      return 2;
    }
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(missionContractView(contract), null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice(`Mission ${contract.id}`, missionDetailLines(contract), contract.progress.status === "blocked" ? "warn" : "info"));
    return 0;
  }

  if (subcommand === "list") {
    const goals = await listGoals(home);
    if (goals.length === 0) {
      process.stdout.write(notice("Operator", ['No goals yet. Add one: ares operator add --goal "..."'], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Operator Goals",
        goals.map((g) => `${statusGlyph(g.status)} ${g.id}  [${g.status}]  ${g.progress} moved / ${g.stepLog.length} steps — ${g.statement}`),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "status") {
    const id = args.positionals[1] ?? args.flags.get("id");
    const goals = await listGoals(home);
    const goal = id ? goals.find((g) => g.id === id) : goals[0];
    if (!goal) {
      process.stderr.write("error: no matching goal\n");
      return 2;
    }
    const contract = goal.missionIds[0] ? await loadMissionContract(home, goal.missionIds[0]) : null;
    const contractLines = contract
      ? [`mission ${contract.id}: ${missionContractSummary(contract)}`, ...completionRefusalLines(contract)]
      : ["mission contract: pending attachment"];
    process.stdout.write(
      notice(
        `Goal ${goal.id}`,
        [
          goal.statement,
          `status ${goal.status}${goal.verdict ? ` — ${goal.verdict}` : ""}`,
          `progress ${goal.progress} moved across ${goal.stepLog.length} step(s)`,
          ...contractLines,
          `divergence ${goal.noProgressStreak}/${goal.maxNoProgress}`,
          `updated ${goal.updatedAt}`,
        ],
        goal.status === "blocked" ? "warn" : "info",
      ),
    );
    return 0;
  }

  if (subcommand === "run") {
    const statement = args.flags.get("goal") ?? args.positionals.slice(1).join(" ").trim();
    if (statement) {
      let verificationProbes: VerificationSpec[];
      try {
        verificationProbes = verificationProbesFromFlags(args);
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      await ensureGoalMissionContract(
        home,
        createGoal({ id: newGoalId(), statement, verification: verificationProbes[0] }),
        {
          acceptanceCriteria: textListFlag(args.flags.get("criteria") ?? args.flags.get("criterion")),
          constraints: textListFlag(args.flags.get("constraint") ?? args.flags.get("constraints")),
          verificationProbes,
        },
      );
    }
    const goals = (await listGoals(home)).filter((g) => g.status === "active");
    if (goals.length === 0) {
      process.stdout.write(notice("Operator", ["No active goals to run."], "warn"));
      return 0;
    }
    const selection = await selectProvider(args.flags);
    const maxTicks = Number(args.flags.get("ticks") ?? "1") || 1;
    const dispatcher = await buildOperatorDispatcher(context, selection);
    const lines: string[] = [`provider ${selection.source} · model ${selection.model} · up to ${maxTicks} tick(s)/goal`];
    for (const g of goals) {
      const final = await runGoalToCompletion({ home, dispatcher, workspace: context.workspace }, g.id, { maxTicks });
      lines.push(`${statusGlyph(final.status)} ${g.id} → ${final.status} (${final.progress} moved / ${final.stepLog.length} steps)`);
      const contract = final.missionIds[0] ? await loadMissionContract(home, final.missionIds[0]) : null;
      if (contract) lines.push(...completionRefusalLines(contract).map((line) => `  ${line}`));
    }
    process.stdout.write(notice("Operator Run", lines, "info"));
    return 0;
  }

  if (subcommand === "halt") {
    // The kill switch was previously unreachable: nothing anywhere called
    // .engage(). This is its first real entry point — a durable file flag
    // (survives process restarts) that runEffect checks before every commit.
    const killSwitch = new KillSwitch(context.effects.killSwitchFile);
    const reason = args.flags.get("reason") || args.positionals.slice(1).join(" ").trim() || "manual";
    await killSwitch.engage(reason);
    process.stdout.write(notice("Operator Halt", [`kill switch ENGAGED (${reason})`, "every staged effect will throw HaltedError before committing.", "release with: ares operator resume"], "warn"));
    return 0;
  }

  if (subcommand === "resume") {
    const killSwitch = new KillSwitch(context.effects.killSwitchFile);
    await killSwitch.release();
    process.stdout.write(notice("Operator Resume", ["kill switch released. Effects will commit normally again."], "success"));
    return 0;
  }

  if (subcommand === "caps") {
    const caps = await listCapabilities(home);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(caps, null, 2) + "\n");
      return 0;
    }
    if (caps.length === 0) {
      process.stdout.write(notice("Capabilities", ["No capabilities learned yet. They accrue as Ares masters things."], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Capabilities",
        caps.map((c) => {
          const rel = reliabilityOf(c);
          const relStr = rel === null ? "untested" : `${Math.round(rel * 100)}% (${c.outcomes.ok}/${c.outcomes.ok + c.outcomes.fail})`;
          return `${capGlyph(c.status)} ${c.name} [${c.status}] ${relStr}${c.skillRef ? ` · skill:${c.skillRef}` : ""}${c.requires.length ? ` · composes ${c.requires.length}` : ""}`;
        }),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "acquisitions") {
    const acquisitions = await listAcquisitions(home);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(acquisitions, null, 2) + "\n");
      return 0;
    }
    if (acquisitions.length === 0) {
      process.stdout.write(notice("Acquisitions", ["No acquisition packets yet."], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Acquisitions",
        acquisitions.map((a) => `${a.id} [${a.status}] ${a.capabilityName} -> goal ${a.goalId}`),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "attention" || subcommand === "queue") {
    const goals = await listGoals(home);
    const caps = await listCapabilities(home);
    const decision = decideAttention([
      ...attentionItemsFromGoals(goals),
      ...attentionItemsFromCapabilities(caps),
    ]);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
      return 0;
    }
    const lines = [decision.summary];
    if (decision.queue.length) {
      lines.push("Runnable:");
      for (const item of decision.queue.slice(0, 12)) {
        lines.push(`  ${item.kind} ${Math.round(item.score)} - ${item.title}${item.reason ? ` (${item.reason})` : ""}`);
      }
    }
    if (decision.parked.length) {
      lines.push("Parked:");
      for (const item of decision.parked.slice(0, 8)) {
        lines.push(`  ${item.kind} - ${item.title}${item.reason ? ` (${item.reason})` : ""}`);
      }
    }
    process.stdout.write(notice("Operator Attention", lines, decision.selected ? "info" : "warn"));
    return 0;
  }

  if (subcommand === "trust" || subcommand === "leash") {
    const store = await MemoryStore.open(context.mind.memoryFile);
    const nodes = store.all();
    // "browser" is the one live effect domain today; any domain a memory has
    // earned a `domain:` tag for shows up alongside it.
    const domains = new Set<string>(["browser"]);
    for (const node of nodes) {
      const domain = domainOf(node);
      if (domain) domains.add(domain);
    }
    const basis = [...domains].sort().map((domain) => ({ domain, ...deriveLeash(nodes, domain) }));
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(basis, null, 2) + "\n");
      return 0;
    }
    const lines = [
      "Earned leash per domain — 1 (reversible only) … 5 (irreversible unsupervised).",
      "Trust is earned: +1 per confirmed procedure with a net-positive record (margin ≥2).",
      "",
    ];
    for (const b of basis) {
      const meter = "▰".repeat(b.level) + "▱".repeat(Math.max(0, 5 - b.level));
      lines.push(`  ${meter} ${b.level}/5  ${b.domain}${b.proven.length === 0 ? "  — no proven procedures, base trust" : ""}`);
      for (const p of b.proven.slice(0, 4)) {
        lines.push(`         ↳ ${p.id.slice(0, 10)} ${p.wins}W/${p.losses}L`);
      }
    }
    process.stdout.write(notice("Trust Governor", lines, "info"));
    return 0;
  }

  if (subcommand === "stats") {
    const caps = await listCapabilities(home);
    const curve = novelDeltaCurve(caps);
    const mastered = caps.filter((c) => c.status === "mastered").length;
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify({ total: caps.length, mastered, curve }, null, 2) + "\n");
      return 0;
    }
    const lines = [`${caps.length} capabilities · ${mastered} mastered`];
    if (curve.length === 0) {
      lines.push("novel-delta curve: no data yet — learn a capability to start the curve.");
    } else {
      lines.push("novel-delta curve (new sub-skills to learn per capability, oldest → newest):");
      for (const point of curve) {
        lines.push(`  ${String(point.delta).padStart(2)}  ${"#".repeat(Math.min(point.delta, 40)) || "·"}  ${point.name}`);
      }
      const first = curve[0].delta;
      const last = curve[curve.length - 1].delta;
      lines.push(
        curve.length > 1
          ? `trend: ${first} → ${last} ${last < first ? "↓ getting smarter" : last > first ? "↑" : "flat"}`
          : "trend: need ≥2 capabilities to see the curve move",
      );
    }
    process.stdout.write(notice("Operator Stats", lines, "info"));
    return 0;
  }

  process.stderr.write(`error: unknown operator subcommand "${subcommand}". Try: add | draft | acquire | promote | reject | review | missions | mission | list | status | run | caps | stats | attention | acquisitions\n`);
  return 2;
}

async function buildOperatorDispatcher(
  context: CliRuntimeContext,
  selection: ProviderSelection,
): Promise<QueryEngineDispatcher> {
  const pathPermissions = await AresPathPermissionStore.load(context);
  const commandPermissions = await AresCommandPermissionStore.load(context);
  const shellRegistry = new ShellRegistry();
  const todoStore = new TodoStore();
  const sessionKernel = await openWorkspaceSessionKernel(context.workspace);
  const tools = await buildCodingTools(
    pathPermissions,
    commandPermissions,
    selection,
    { permissionMode: "workspace-write" },
    context,
    shellRegistry,
    todoStore,
    new Map(),
    { subagents: true, conductor: false },
    sessionKernel,
  );
  return new QueryEngineDispatcher({
    provider: selection.provider,
    model: selection.model,
    workspace: context.workspace,
    tools,
    requestPermission: promptPermission,
    sessionKernel,
    telemetryDir: path.join(context.home, "telemetry"),
    sessionRegistryHome: context.home,
  });
}

async function findMissionContract(home: string, id: string): Promise<MissionContract | null> {
  const direct = await loadMissionContract(home, id);
  if (direct) return direct;
  return (await listMissionContracts(home)).find((contract) => contract.goalId === id) ?? null;
}

function missionContractView(contract: MissionContract) {
  return {
    id: contract.id,
    goalId: contract.goalId,
    intent: contract.intent,
    status: contract.progress.status,
    progress: contract.progress,
    criteria: contract.acceptanceCriteria,
    constraints: contract.constraints,
    probes: contract.verificationProbeResults,
    blockers: contract.blockers,
    evidence: contract.evidenceLog,
    nextAction: contract.nextAction,
    canComplete: missionContractCanComplete(contract),
    unmet: missionContractUnmetRequirements(contract),
    nextVerificationAction: missionContractNextVerificationAction(contract),
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
  };
}

function missionDetailLines(contract: MissionContract): string[] {
  const lines = [
    contract.intent,
    `status ${contract.progress.status}`,
    `progress ${contract.progress.completedCriteria}/${contract.progress.totalCriteria} criteria (${contract.progress.percent}%)`,
    `goal ${contract.goalId ?? "(none)"}`,
    "criteria:",
    ...sectionLines(contract.acceptanceCriteria, (criterion) =>
      `${criterion.id} [${criterion.status}] ${criterion.description}${criterion.evidenceIds.length ? ` evidence:${criterion.evidenceIds.join(",")}` : ""}`,
    ),
    "constraints:",
    ...sectionLines(contract.constraints, (constraint) => `${constraint.id}${constraint.required ? " [required]" : ""} ${constraint.description}`),
    "probes:",
    ...sectionLines(contract.verificationProbeResults, (probe) =>
      `${probe.id} [${probe.status}] ${verificationSpecSummary(probe.spec)}${probe.summary ? ` - ${probe.summary}` : ""}`,
    ),
    "blockers:",
    ...sectionLines(contract.blockers, (blocker) =>
      `${blocker.id} ${blocker.resolvedAt ? "[resolved]" : "[active]"} ${blocker.reason}${blocker.resolution ? ` - ${blocker.resolution}` : ""}`,
    ),
    "evidence:",
    ...sectionLines(contract.evidenceLog, (evidence) =>
      `${evidence.id} [${evidence.kind}${evidence.passed === undefined ? "" : evidence.passed ? ":pass" : ":fail"}] ${evidence.summary}`,
    ),
    `next action: ${contract.nextAction?.summary ?? "(none)"}`,
  ];
  const unmet = completionRefusalLines(contract);
  if (unmet.length) lines.push(...unmet);
  return lines;
}

function completionRefusalLines(contract: MissionContract): string[] {
  if (missionContractCanComplete(contract)) return [];
  const unmet = missionContractUnmetRequirements(contract);
  if (unmet.length === 0) return [];
  const next = missionContractNextVerificationAction(contract);
  return [
    "completion blocked:",
    ...unmet.map((item) => `- ${item}`),
    `next verification: ${next ?? "review mission contract"}`,
  ];
}

function sectionLines<T>(items: readonly T[], format: (item: T) => string): string[] {
  return items.length ? items.map((item) => `  ${format(item)}`) : ["  (none)"];
}

function verificationProbesFromFlags(args: ParsedArgs): VerificationSpec[] {
  const probes: VerificationSpec[] = [];
  if (args.flags.has("verify-file")) {
    probes.push({
      kind: "file",
      path: args.flags.get("verify-file") ?? "",
      contains: args.flags.get("verify-contains"),
    });
  }
  if (args.flags.has("verify-command")) {
    probes.push({
      kind: "command",
      cmd: args.flags.get("verify-command") ?? "",
      args: csvFlag(args.flags.get("verify-args")),
      cwd: args.flags.get("verify-cwd"),
      expectExit: numberFlag(args, "verify-exit"),
      timeoutMs: numberFlag(args, "verify-timeout"),
    });
  }
  if (args.flags.has("verify-http")) {
    probes.push({
      kind: "http",
      url: args.flags.get("verify-http") ?? "",
      expectStatus: numberFlag(args, "verify-status"),
      contains: args.flags.get("verify-contains"),
      timeoutMs: numberFlag(args, "verify-timeout"),
    });
  }
  if (args.flags.has("verify-always")) {
    probes.push({
      kind: "always",
      met: booleanFlag(args.flags.get("verify-always")),
      summary: args.flags.get("verify-summary"),
    });
  }
  if (probes.length > 1) throw new Error("provide only one verification probe flag set");
  for (const probe of probes) {
    if (probe.kind === "file" && !probe.path.trim()) throw new Error("--verify-file requires a path");
    if (probe.kind === "command" && !probe.cmd.trim()) throw new Error("--verify-command requires a command");
    if (probe.kind === "http" && !probe.url.trim()) throw new Error("--verify-http requires a URL");
  }
  return probes;
}

function booleanFlag(value: string | undefined): boolean {
  const raw = (value ?? "true").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y" || raw === "met" || raw === "pass";
}

function textListFlag(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(/[;\n]+/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function parseAcquisitionKind(value: string | undefined): AcquisitionKind | undefined {
  if (value === "skill" || value === "connector" || value === "tool" || value === "mcp" || value === "script") return value;
  return undefined;
}

async function loadEvalReportFlag(file: string | undefined): Promise<EvalReport | undefined> {
  if (!file) return undefined;
  return parseEvalReportJson(await readFile(path.resolve(file), "utf8"));
}

function promotionEvidenceFromFlags(args: ParsedArgs, report: EvalReport | undefined): CapabilityEvidence[] {
  const evidenceText = args.flags.get("evidence");
  if (evidenceText?.trim()) {
    return [
      capabilityEvidence({
        kind: args.flags.has("evidence-failed") ? "manual" : "verification",
        summary: evidenceText,
        passed: !args.flags.has("evidence-failed"),
      }),
    ];
  }
  if (!report) return [];
  return [
    capabilityEvidence({
      kind: "eval",
      summary: `eval report ${report.suite}: ${report.passed}/${report.total} passed, score ${report.score}`,
      passed: report.failed === 0,
      score: report.score,
    }),
  ];
}

function promotionPolicyFromFlags(args: ParsedArgs) {
  return {
    minVerifiedSuccesses: numberFlag(args, "min-successes"),
    minEvidence: numberFlag(args, "min-evidence"),
    minEvalPasses: numberFlag(args, "min-evals"),
    minEvalScore: numberFlag(args, "min-score"),
  };
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function csvFlag(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((v) => v.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}
