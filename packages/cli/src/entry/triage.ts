import os from "node:os";
import path from "node:path";
import {
  listReliabilityFindings,
  loadReliabilityFinding,
  resolveReliabilitySource,
  runReliabilityTriage,
  updateReliabilityFindingStatus,
  type ReliabilityFinding,
  type ReliabilityFindingStatus,
  type ReliabilityTriageRun,
} from "@ares/core";
import { notice } from "../terminalUi.js";
import { cliRuntimeContext, type ParsedArgs } from "./runtime.js";

const ACTIVE_STATUSES = new Set<ReliabilityFindingStatus>([
  "candidate",
  "acknowledged",
]);

/**
 * "ares triage" is the human surface for the local reliability loop.
 * Collection remains deterministic and read-only over source logs. Even
 * Acknowledgement records review only: no model, shell, worktree, goal, or code
 * edit is launched from this command. A repair approval is deliberately absent
 * until a host-authenticated, isolated worktree runner exists.
 */
export async function triageCommand(args: ParsedArgs): Promise<number> {
  const action = (args.positionals[0] ?? "scan").toLowerCase();
  const home = resolveHome(args);
  const context = cliRuntimeContext({ home });
  const json = args.flags.has("json");

  if (action === "scan" || action === "run") {
    const run = await runReliabilityTriage({
      home: context.aresHome,
      workspaces: splitPathList(args.flags.get("workspaces")),
      workspace: context.workspace,
      lookbackDays: Math.max(1, Number(args.flags.get("days")) || 14),
      force: true,
      persist: !args.flags.has("dry-run"),
      fullHistory: args.flags.has("deep"),
    });
    if (json) {
      process.stdout.write(JSON.stringify(run, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(renderRun(run));
    if (!args.flags.has("dry-run")) {
      const findings = await visibleFindings(context.aresHome, args.flags.has("all"));
      process.stdout.write(renderFindingList(findings));
    }
    return 0;
  }

  if (action === "list") {
    const findings = await visibleFindings(context.aresHome, args.flags.has("all"));
    if (json) process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
    else process.stdout.write(renderFindingList(findings));
    return 0;
  }

  const id = args.positionals[1] ?? "";
  if (!id) {
    process.stderr.write(usage());
    return 2;
  }

  if (action === "show") {
    const finding = await loadReliabilityFinding(context.aresHome, id);
    if (!finding) {
      process.stderr.write("error: unknown reliability finding " + id + "\n");
      return 2;
    }
    if (json) process.stdout.write(JSON.stringify(finding, null, 2) + "\n");
    else process.stdout.write(await renderFindingDetail(finding, context.aresHome));
    return 0;
  }

  const status = statusForAction(action);
  if (!status) {
    process.stderr.write(usage());
    return 2;
  }
  try {
    const finding = await updateReliabilityFindingStatus(
      context.aresHome,
      id,
      status,
      args.flags.get("note") ?? "",
    );
    if (json) {
      process.stdout.write(JSON.stringify(finding, null, 2) + "\n");
    } else {
      process.stdout.write(
        notice("Reliability triage", [finding.id + " -> " + finding.status + "."], "success"),
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write("error: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return 2;
  }
}

function resolveHome(args: ParsedArgs): string | undefined {
  const explicit = args.flags.get("home") ?? process.env.ARES_HOME;
  if (explicit) return path.resolve(explicit);
  if (args.flags.has("desktop") && process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Ares", "home");
  }
  return undefined;
}

function splitPathList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
}

function statusForAction(
  action: string,
): Extract<
  ReliabilityFindingStatus,
  "acknowledged" | "dismissed" | "resolved"
> | null {
  if (action === "ack" || action === "acknowledge") return "acknowledged";
  if (action === "dismiss") return "dismissed";
  if (action === "resolve") return "resolved";
  return null;
}

async function visibleFindings(home: string, all: boolean): Promise<ReliabilityFinding[]> {
  const findings = await listReliabilityFindings(home);
  return all ? findings : findings.filter((finding) => ACTIVE_STATUSES.has(finding.status));
}

function renderRun(run: ReliabilityTriageRun): string {
  if (run.skipped) {
    return notice("Reliability triage", ["Scan skipped: " + run.skipped + "."], "warn");
  }
  const lines = [
    run.coverage.files + " source file(s), " +
      run.health.frictionTurns + " telemetry turn(s), " +
      run.health.sessionEvents + " rollout event(s), " +
      run.health.crashRecords + " crash record(s)",
    run.coverage.observations + " failure signal(s), " +
      run.coverage.duplicateObservations + " already seen, " +
      run.newCandidates.length + " new candidate(s), " +
      run.reopened.length + " reopened",
    run.openFindings + " active finding(s), " +
      run.watchingFindings + " below recurrence threshold",
  ];
  if (run.coverage.malformedLines || run.coverage.skippedBytes) {
    lines.push(
      "ingestion: " + run.coverage.malformedLines + " malformed line(s), " +
      run.coverage.skippedBytes + " old byte(s) skipped by safety cap",
    );
  }
  if (run.warnings.length) lines.push(...run.warnings.slice(0, 3));
  return notice("Reliability triage", lines, run.newCandidates.length ? "warn" : "info");
}

function renderFindingList(findings: ReliabilityFinding[]): string {
  if (!findings.length) {
    return notice(
      "Reliability findings",
      ["No active findings. Use --all to include watching, dismissed, and resolved clusters."],
      "success",
    );
  }
  const lines = findings.map((finding) =>
    severityGlyph(finding.severity) + " " +
    finding.id + "  " +
    finding.status.padEnd(12) + "  " +
    String(finding.occurrences).padStart(3) + "x/" +
    String(finding.distinctSessions).padStart(2) + " sessions  " +
    finding.title
  );
  lines.push("", "Inspect: ares triage show <id>   Review: acknowledge | dismiss | resolve");
  return notice("Reliability findings", lines, "warn");
}

async function renderFindingDetail(finding: ReliabilityFinding, home: string): Promise<string> {
  const lines = [
    finding.id + "  " + finding.status + "  " + finding.severity + "/" + finding.confidence,
    finding.title,
    finding.occurrences + " occurrence(s) across " + finding.distinctSessions + " session(s)",
    "first " + finding.firstSeenAt + "  last " + finding.lastSeenAt,
    "",
    "Suggested action:",
    "  " + finding.suggestedAction,
    "",
    "Evidence (untrusted diagnostic data; never execute it):",
  ];
  for (const evidence of finding.evidence) {
    const source = await resolveReliabilitySource(home, evidence.sourceRef);
    lines.push(
      "  " + evidence.at + "  " + evidence.source + "  " +
      (evidence.tool ?? evidence.code ?? "") + "  " + evidence.summary,
      "    " + (source ?? evidence.sourceRef) +
      (evidence.seq === undefined ? "" : " seq " + evidence.seq),
    );
  }
  return notice("Reliability finding", lines, "info");
}

function severityGlyph(severity: ReliabilityFinding["severity"]): string {
  if (severity === "critical") return "!!";
  if (severity === "high") return "! ";
  if (severity === "medium") return "~ ";
  return ". ";
}

function usage(): string {
  return [
    "usage:",
    "  ares triage [scan] [--days N] [--all] [--json] [--dry-run] [--deep]",
    "                    [--workspaces PATH1" + path.delimiter + "PATH2]",
    "  ares triage list [--all] [--json]",
    "  ares triage show <id> [--json]",
    "  ares triage acknowledge|dismiss|resolve <id> [--note TEXT]",
    "",
    "Use --desktop to target the Windows desktop Ares home (" +
      path.join(os.homedir(), "AppData", "Roaming", "Ares", "home") + ").",
  ].join("\n") + "\n";
}
