// The Witness (ARES V5) — the LLM enters the learning loop.
//
// After a substantive turn, a cheap one-shot judgment call reviews the
// conversation snapshot and proposes CANDIDATE hypotheses: beliefs, user
// facts, feedback rules, procedures — each optionally carrying a falsifiable
// check the Crucible trial (V7) can run. The Witness replaces the regex
// capture path: judgment comes from a model, intake stays deterministic.
//
// Boundary discipline: this module does not import @ares/core. The ask()
// function (entry/garrison compose it from sideQueryJson + the session's
// provider) is injected structurally, so the agent package stays core-free
// and the Witness is fully testable with a stub.
//
// The intake is the spine: it validates shape, rejects unsafe checks,
// dedupes against what the store already knows, and caps volume. A model
// can propose anything; only disciplined candidates land.

import { MemoryRouter, type CrucibleCheck, type HypothesisStatus, type MemoryKind, type MemoryNode } from "@ares/mind";

export type WitnessKind = "belief" | "user_fact" | "feedback" | "procedure";

export interface WitnessCandidate {
  kind: WitnessKind;
  claim: string;
  why?: string;
  check?: CrucibleCheck;
}

/** One-shot judgment call. Entry composes this from @ares/core sideQueryJson. */
export type WitnessAsk = (opts: {
  system: string;
  user: string;
  schemaHint: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

/** The slice of MemoryStore the Witness needs (structural, test-friendly). */
export interface WitnessStore {
  all(): MemoryNode[];
  add(input: {
    kind: MemoryKind;
    content: string;
    tags?: string[];
    source?: string;
    status?: HypothesisStatus;
    check?: CrucibleCheck;
  }): Promise<MemoryNode>;
}

export interface WitnessReport {
  /** Raw proposals the model returned (pre-validation). */
  proposed: number;
  /** Candidates that passed intake and were written. */
  accepted: MemoryNode[];
  /** Human-readable reasons for every rejected proposal. */
  rejected: string[];
}

export interface WitnessOptions {
  conversation: { user: string; assistant: string; status: string };
  store: WitnessStore;
  ask: WitnessAsk;
  source?: string;
  maxCandidates?: number;
  signal?: AbortSignal;
}

export const WITNESS_SYSTEM_PROMPT = `You are the Witness — the learning reviewer for the agent Ares. You read one conversation turn and decide what, if anything, is worth learning durably. Most turns teach nothing; an empty list is a perfectly good answer. Never invent learnings to fill space.

Propose a candidate ONLY when the turn contains:
- user_fact: something durable about the user (role, preference, constraint) stated or clearly implied
- feedback: the user corrected the agent's approach OR confirmed a non-obvious approach worked — include the why
- belief: a falsifiable fact about the world/codebase the agent acted on or discovered ("the build uses pnpm", "X breaks when Y")
- procedure: a reusable multi-step method that just SUCCEEDED (never from a failed attempt)

Never propose a claim whose substance is a tool failure, provider error, exit code, stack trace, or other harness noise ("Bash failed with ENOENT", "the provider timed out"). Failure mechanics belong to friction telemetry, not durable memory. A failure teaches something only when the LESSON is stated without the error text ("this repo's tests need the daemon stopped first").

Each candidate: {"kind": "...", "claim": "<one self-contained sentence, 12-300 chars>", "why": "<why durable>", "check": optional}.
A check makes the claim testable later: {"type":"command","cmd":"<READ-ONLY command>","expect":"<substring>"} or {"type":"file_exists","path":"<path>"}. Only attach a check when one genuinely verifies the claim; never attach destructive commands.`;

const CLAIM_MIN = 12;
const CLAIM_MAX = 300;
const DEFAULT_MAX_CANDIDATES = 4;
const KIND_TO_MEMORY: Record<WitnessKind, MemoryKind> = {
  belief: "semantic",
  user_fact: "semantic",
  feedback: "semantic",
  procedure: "procedural",
};
/** Commands a check may never run — the trial executes these unattended. */
const UNSAFE_CMD = /\b(rm|del|rmdir|rd|format|mkfs|shutdown|reboot|kill|taskkill|curl|wget|git\s+push|npm\s+publish)\b|[>|&;]/i;

/**
 * Run one Witness pass over a finished turn. Throws only when ask() itself
 * throws (caller decides whether that is fatal); a malformed model reply
 * yields an empty accepted list with the reason in `rejected`.
 */
export async function runWitness(opts: WitnessOptions): Promise<WitnessReport> {
  const max = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const user = [
    `Turn status: ${opts.conversation.status}`,
    "",
    "── User said ──",
    clip(opts.conversation.user, 2_000),
    "",
    "── Agent replied ──",
    clip(opts.conversation.assistant, 4_000),
    "",
    `Return a JSON array of 0 to ${max} candidates. [] when nothing is durable.`,
  ].join("\n");

  const raw = await opts.ask({
    system: WITNESS_SYSTEM_PROMPT,
    user,
    schemaHint: `JSON array of {"kind":"belief"|"user_fact"|"feedback"|"procedure","claim":string,"why"?:string,"check"?:{"type":"command"|"file_exists","cmd"?:string,"path"?:string,"expect"?:string}}`,
    signal: opts.signal,
  });

  const report: WitnessReport = { proposed: 0, accepted: [], rejected: [] };
  if (!Array.isArray(raw)) {
    report.rejected.push(`model reply was not a JSON array (${typeof raw})`);
    return report;
  }
  report.proposed = raw.length;

  // Duplicate detection now lives in the ONE write spine: the router's
  // "witness" channel dedupes on normalized content against the store (and
  // against candidates accepted earlier in this same pass, since each accepted
  // write lands in the store before the next is routed). vetCandidate() keeps
  // its `known` parameter for direct callers; the runWitness path hands it an
  // empty set and lets the router judge.
  const router = new MemoryRouter<MemoryNode>(opts.store);
  const noKnown: ReadonlySet<string> = new Set();
  for (const item of raw) {
    if (report.accepted.length >= max) {
      report.rejected.push("candidate cap reached");
      break;
    }
    const verdict = vetCandidate(item, noKnown);
    if (typeof verdict === "string") {
      report.rejected.push(verdict);
      continue;
    }
    const routed = await router.write("witness", [{
      kind: KIND_TO_MEMORY[verdict.kind],
      content: verdict.claim,
      tags: ["witness", `crucible:${verdict.kind}`],
      source: opts.source,
      status: "candidate",
      check: verdict.check,
    }]);
    const hit = routed.written[0];
    if (hit) {
      report.accepted.push(hit.node);
    } else {
      report.rejected.push(`duplicate of an existing memory: "${verdict.claim.slice(0, 60)}"`);
    }
  }
  return report;
}

/** Validate one raw proposal. Returns the clean candidate or a rejection reason. */
export function vetCandidate(item: unknown, known: ReadonlySet<string>): WitnessCandidate | string {
  if (!item || typeof item !== "object") return "proposal is not an object";
  const p = item as Record<string, unknown>;
  const kind = p.kind;
  if (kind !== "belief" && kind !== "user_fact" && kind !== "feedback" && kind !== "procedure") {
    return `unknown kind: ${String(kind)}`;
  }
  const claim = typeof p.claim === "string" ? p.claim.replace(/\s+/g, " ").trim() : "";
  if (claim.length < CLAIM_MIN) return `claim too short: "${claim.slice(0, 40)}"`;
  if (claim.length > CLAIM_MAX) return `claim too long (${claim.length} chars)`;
  if (known.has(normalize(claim))) return `duplicate of an existing memory: "${claim.slice(0, 60)}"`;

  let check: CrucibleCheck | undefined;
  if (p.check !== undefined && p.check !== null) {
    const c = p.check as Record<string, unknown>;
    if (c.type === "command") {
      const cmd = typeof c.cmd === "string" ? c.cmd.trim() : "";
      if (!cmd) return "command check without cmd";
      if (UNSAFE_CMD.test(cmd)) return `unsafe check command rejected: "${cmd.slice(0, 60)}"`;
      check = { type: "command", cmd, ...(typeof c.expect === "string" && c.expect ? { expect: c.expect } : {}) };
    } else if (c.type === "file_exists") {
      const file = typeof c.path === "string" ? c.path.trim() : "";
      if (!file) return "file_exists check without path";
      check = { type: "file_exists", path: file };
    } else {
      return `unknown check type: ${String(c.type)}`;
    }
  }
  return { kind, claim, ...(typeof p.why === "string" && p.why ? { why: p.why } : {}), check };
}

function normalize(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n[clipped ${t.length - max} chars]`;
}
