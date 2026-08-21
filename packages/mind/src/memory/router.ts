// The ONE memory write spine (core-redesign §1: "Fold the other stores in").
//
// Every write into Living Memory flows through here. Before this, each writer —
// conversation reflection, the Witness, dreaming, learning cards, the v4
// migration — carried its own copy of dedupe + gating policy, four independent
// reimplementations that drifted. Now a writer shapes its intake (validation,
// vetting, volume caps) and hands the router a batch tagged with its CHANNEL;
// the router applies that channel's dedupe rule and salience gate in one place
// and flushes accepted writes once (addMany when the store supports it).
//
// Behavior-preserving by construction: each channel's policy IS the policy its
// writer enforced locally before the consolidation — same inputs, same nodes.
// ONE deliberate global exception: the operational-noise gate. No channel may
// store harness failure output (tool errors, provider errors, stack traces) as
// memory — that content buried a field user's index under 24 error entries
// against 5 real ones (2026-08-06). Failure signal belongs to friction
// telemetry, not the memory store.

import { jaccard, tokenizeSalient } from "./idf.js";
import { isOperationalNoise } from "./noise.js";
import type { AddInput } from "./store.js";

/** Where a write comes from. Each channel carries the dedupe/gating policy its
 *  writer historically enforced locally. */
export type MemoryChannel =
  | "conversation" // mergeDurableFacts: jaccard-similarity dedupe + importance floor
  | "witness" // Crucible Witness: exact normalized-content dedupe
  | "dream" // light-dream episodic candidates: no dedupe (consolidate() merges later)
  | "card" // mission learning cards: idempotent by source id + provenance tag
  | "v4-migration" // legacy vector-store fold: idempotent by v4-hash: tag
  | "manual"; // direct/CLI adds (`ares mind add`, chat-tool memory): ungated

export type DedupeRule =
  | { kind: "none" }
  | { kind: "exact" } // normalized (trim/lower/collapse-ws) content equality
  | { kind: "similar"; threshold: number } // salient-token jaccard over threshold
  | { kind: "tag-prefix"; prefix: string } // provenance tag (e.g. "v4-hash:<hex>") already present
  | { kind: "source-tag"; tag: string }; // same source id AND carrying the provenance tag

export interface ChannelPolicy {
  dedupe: DedupeRule;
  /** Writes with `salience` below this are dropped. Absent = no gate. */
  minSalience?: number;
  /** Trimmed content shorter than this is dropped as empty. */
  minContentChars?: number;
}

/** The single policy table — dedupe + salience gating for every channel. */
export const MEMORY_CHANNEL_POLICIES: Record<MemoryChannel, ChannelPolicy> = {
  conversation: { dedupe: { kind: "similar", threshold: 0.55 }, minSalience: 0.4, minContentChars: 6 },
  // similar, not exact: the Witness phrases the same lesson slightly
  // differently each turn ("Bash fails on X" / "Bash failed on X in ws2"),
  // and exact-match let every rewording pile up as a new node.
  witness: { dedupe: { kind: "similar", threshold: 0.7 } },
  dream: { dedupe: { kind: "none" } },
  card: { dedupe: { kind: "source-tag", tag: "learning-card" } },
  "v4-migration": { dedupe: { kind: "tag-prefix", prefix: "v4-hash:" } },
  manual: { dedupe: { kind: "none" } },
};

/** An AddInput plus an optional 0..1 salience for channels that gate on it. */
export type RoutedWrite = AddInput & { salience?: number };

export type SkipReason = "empty" | "below-salience" | "duplicate" | "operational-noise";

export interface RouteReport<N = unknown> {
  /** Accepted writes, in input order, with the node the store returned. */
  written: Array<{ input: RoutedWrite; node: N }>;
  skipped: Array<{ content: string; reason: SkipReason }>;
}

/** Minimal structural store the router writes through — satisfied by the real
 *  MemoryStore AND by the narrow fake stores reflection tests use. */
export interface RouterStoreLike<N = unknown> {
  all(): ReadonlyArray<{ content: string; tags?: string[]; source?: string }>;
  add(input: AddInput): Promise<N>;
  /** Optional batch add — one persist for the whole accepted set. */
  addMany?(inputs: readonly AddInput[]): Promise<N[]>;
}

export interface RouteOptions {
  /** Per-call policy override (e.g. a caller-supplied minImportance). */
  policy?: Partial<ChannelPolicy>;
}

export class MemoryRouter<N = unknown> {
  constructor(private readonly store: RouterStoreLike<N>) {}

  /** Route a batch of writes through `channel`'s policy. Accepted writes flush
   *  in ONE addMany() when the store supports it; skips are reported, never
   *  thrown. Intra-batch duplicates dedupe against earlier accepted writes. */
  async write(channel: MemoryChannel, writes: readonly RoutedWrite[], opts: RouteOptions = {}): Promise<RouteReport<N>> {
    const policy: ChannelPolicy = { ...MEMORY_CHANNEL_POLICIES[channel], ...opts.policy };
    const guard = buildDedupeGuard(policy.dedupe, this.store.all());
    const accepted: RoutedWrite[] = [];
    const skipped: RouteReport<N>["skipped"] = [];

    for (const write of writes) {
      const content = (write.content ?? "").trim();
      if (!content || (policy.minContentChars !== undefined && content.length < policy.minContentChars)) {
        skipped.push({ content, reason: "empty" });
        continue;
      }
      if (isOperationalNoise(content)) {
        skipped.push({ content, reason: "operational-noise" });
        continue;
      }
      if (policy.minSalience !== undefined && (write.salience ?? 0) < policy.minSalience) {
        skipped.push({ content, reason: "below-salience" });
        continue;
      }
      if (guard.isDuplicate(write, content)) {
        skipped.push({ content, reason: "duplicate" });
        continue;
      }
      guard.admit(write, content);
      accepted.push({ ...write, content });
    }

    const written: RouteReport<N>["written"] = [];
    if (accepted.length > 0) {
      const inputs = accepted.map(stripSalience);
      if (this.store.addMany) {
        const nodes = await this.store.addMany(inputs);
        for (let i = 0; i < accepted.length; i++) {
          written.push({ input: accepted[i], node: (Array.isArray(nodes) ? nodes[i] : undefined) as N });
        }
      } else {
        for (let i = 0; i < accepted.length; i++) {
          written.push({ input: accepted[i], node: await this.store.add(inputs[i]) });
        }
      }
    }
    return { written, skipped };
  }
}

function stripSalience(write: RoutedWrite): AddInput {
  const { salience: _salience, ...input } = write;
  return input;
}

interface DedupeGuard {
  isDuplicate(write: RoutedWrite, content: string): boolean;
  admit(write: RoutedWrite, content: string): void;
}

function buildDedupeGuard(rule: DedupeRule, existing: ReadonlyArray<{ content: string; tags?: string[]; source?: string }>): DedupeGuard {
  switch (rule.kind) {
    case "none":
      return { isDuplicate: () => false, admit: () => {} };
    case "exact": {
      const known = new Set(existing.map((n) => normalizeExact(n.content)));
      return {
        isDuplicate: (_w, content) => known.has(normalizeExact(content)),
        admit: (_w, content) => void known.add(normalizeExact(content)),
      };
    }
    case "similar": {
      const priors = existing.map((n) => new Set(tokenizeSalient(normalizeFact(n.content))));
      return {
        isDuplicate: (_w, content) => {
          const tokens = tokenizeSalient(normalizeFact(content));
          if (tokens.length === 0) return true; // nothing salient → not worth storing
          const set = new Set(tokens);
          return priors.some((prior) => prior.size > 0 && jaccard(set, prior) >= rule.threshold);
        },
        admit: (_w, content) => void priors.push(new Set(tokenizeSalient(normalizeFact(content)))),
      };
    }
    case "tag-prefix": {
      const present = new Set<string>();
      for (const node of existing) {
        for (const tag of node.tags ?? []) {
          if (tag.startsWith(rule.prefix)) present.add(tag);
        }
      }
      const keyOf = (write: RoutedWrite) => write.tags?.find((t) => t.startsWith(rule.prefix));
      return {
        isDuplicate: (write) => {
          const key = keyOf(write);
          return key !== undefined && present.has(key);
        },
        admit: (write) => {
          const key = keyOf(write);
          if (key !== undefined) present.add(key);
        },
      };
    }
    case "source-tag": {
      const sources = new Set<string>();
      for (const node of existing) {
        if (node.source && (node.tags?.includes(rule.tag) ?? false)) sources.add(node.source);
      }
      return {
        isDuplicate: (write) => write.source !== undefined && sources.has(write.source),
        admit: (write) => {
          if (write.source !== undefined) sources.add(write.source);
        },
      };
    }
  }
}

function normalizeExact(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Fact normalization for similarity dedupe: lowercase, strip punctuation,
 *  collapse whitespace (conversationReflect's historical normalizer). */
function normalizeFact(content: string): string {
  return content.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
