// Dreaming synthesis core (Ares v6 / M1).
//
// The real "what should I believe now" pass: cluster recurring episodics into
// durable insight candidates, and recurring failure signatures into belief
// candidates the store crystallizes as semantic nodes. Pure, offline,
// deterministic — the optional LLM phrasing is INJECTED (a function type), never
// imported, so @ares/mind stays dependency-free.

import { buildIdf, tokenizeSalient, type IdfMap } from "./idf.js";
import { isOperationalNoise } from "./noise.js";
import type { MemoryNode } from "./types.js";

export interface InsightCandidate {
  /** Stable cluster key (sorted salient tokens) → idempotent `insight:`/`belief:` tags. */
  key: string;
  kind: "insight" | "belief";
  /** Member node ids this candidate was distilled from. */
  members: string[];
  salience: number;
  /** Deterministic fallback text when no LLM phraser is supplied. */
  defaultText: string;
}

const FAILURE = /\b(error|failed|failing|blocker|blocked|regress|broke|crash|timeout|reverted)\b/i;

/** Top-k salient tokens of a node by IDF weight. */
function topTokens(node: MemoryNode, idf: IdfMap, k = 3): string[] {
  return [...new Set(tokenizeSalient(node.content))]
    .map((t) => ({ t, w: idf.idf.get(t) ?? 0 }))
    .sort((a, b) => b.w - a.w)
    .slice(0, k)
    .map((x) => x.t);
}

function bucketBy(nodes: readonly MemoryNode[], idf: IdfMap): Map<string, MemoryNode[]> {
  const buckets = new Map<string, MemoryNode[]>();
  for (const n of nodes) {
    const key = topTokens(n, idf, 2).sort().join("+");
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(n);
  }
  return buckets;
}

export function clusterByConcept(
  nodes: readonly MemoryNode[],
  idf: IdfMap,
  opts: { minMembers?: number } = {},
): InsightCandidate[] {
  const minMembers = opts.minMembers ?? 3;
  const episodics = nodes.filter((n) => n.kind === "episodic");
  const out: InsightCandidate[] = [];
  for (const [key, members] of bucketBy(episodics, idf)) {
    if (members.length < minMembers) continue;
    out.push({
      key,
      kind: "insight",
      members: members.map((m) => m.id),
      salience: members.length,
      defaultText: `Recurring pattern across ${members.length} episodes (${key.replace(/\+/g, ", ")}).`,
    });
  }
  return out.sort((a, b) => b.salience - a.salience);
}

export function detectRecurringFailures(
  nodes: readonly MemoryNode[],
  idf: IdfMap,
  // 3, not 2: at 2 this pass amplified stored error noise — N distinct error
  // texts bucketed by token pair minted up to N/2 "recurring failure" beliefs,
  // each then EXEMPT from normal pruning (source: "synthesis"). Self-generated
  // noise was more durable than real memories.
  minMembers = 3,
): InsightCandidate[] {
  // Operational noise (raw tool/provider error text) is excluded even though
  // it matches FAILURE: a belief distilled from harness noise is still noise.
  const fails = nodes.filter((n) => FAILURE.test(n.content) && !isOperationalNoise(n.content));
  const out: InsightCandidate[] = [];
  for (const [key, members] of bucketBy(fails, idf)) {
    if (members.length < minMembers) continue;
    out.push({
      key,
      kind: "belief",
      members: members.map((m) => m.id),
      salience: members.length + 1,
      defaultText: `Recurring failure mode (${key.replace(/\+/g, ", ")}) seen ${members.length}×: treat as a known risk and verify before claiming done.`,
    });
  }
  return out.sort((a, b) => b.salience - a.salience);
}

/** Injected, optional: turn a candidate into one crisp sentence. Returns null offline. */
export type Phraser = (c: InsightCandidate, members: MemoryNode[]) => Promise<string | null>;

/** Convenience: build the IDF map and all candidates in one pass (for tests / callers). */
export function synthesizeCandidates(nodes: readonly MemoryNode[]): { idf: IdfMap; candidates: InsightCandidate[] } {
  const idf = buildIdf(nodes);
  return { idf, candidates: [...clusterByConcept(nodes, idf), ...detectRecurringFailures(nodes, idf)] };
}
