// The Living Memory store (Ares v6 / M1).
//
// Durable, pluggable-home memory with the behaviors no filing-cabinet store has:
//   remember()    — spreading-activation recall that ALSO strengthens what it
//                   surfaces (recalling makes it stick) and wires co-activated
//                   memories together (fire together → wire together).
//   consolidate() — "sleep": forget trivial episodes, and crystallize recurring
//                   themes into lasting semantic knowledge.
//
// The store is just a path away from living anywhere — point `open()` at a
// flashdrive and Ares's whole memory lives there.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../io.js";
import { mindPaths } from "../paths.js";
import { currentStrength, reinforce, weaken } from "./strength.js";
import { recall, type RecallOptions, type RecallResult } from "./recall.js";
import { contentHash, type EmbedIndex, type Embedder } from "./embedIndex.js";
import { buildIdf } from "./idf.js";
import { isOperationalNoise } from "./noise.js";
import { clusterByConcept, detectRecurringFailures, type Phraser } from "./synthesis.js";
import { MEMORY_SCHEMA_VERSION, type CrucibleCheck, type HypothesisStatus, type MemoryKind, type MemoryNode, type ReflectionResult, type ReflectionSurface } from "./types.js";

export interface ConsolidationReport {
  pruned: number;
  deduped: number;
  promoted: string[];
  kept: number;
}

/** Input shape for adding a memory node (shared by add() and addMany()). */
export interface AddInput {
  kind: MemoryKind;
  content: string;
  tags?: string[];
  source?: string;
  strength?: number;
  at?: Date;
  status?: HypothesisStatus;
  check?: CrucibleCheck;
  /** Tenant this node belongs to (e.g. a Telegram chatId). Absent = the owner. */
  scope?: string;
}

export interface SynthesisReport {
  /** New insight (recurring-pattern) nodes written. */
  insights: number;
  /** New belief (recurring-failure) nodes written. */
  beliefs: number;
  /** Existing synthesis nodes reinforced/extended instead of duplicated. */
  updated: number;
}

const PRUNE_FLOOR = 0.05;
const EVIDENCE_CAP = 20;
const MAX_MEMORY_CONTENT_CHARS = 2_000;
/** Hard ceiling on how long remember() will wait for a cue embedding. */
const CUE_EMBED_TIMEOUT_MS = 300;
const EMBED_BATCH = 64;

function resolveFile(root: string): string {
  return root.endsWith(".jsonl") ? root : path.join(root, "memory.jsonl");
}

/**
 * Filter a node pool by tenant scope. `undefined` scope (the default, backward
 * compatible) returns the pool untouched. A given `scope` keeps nodes stamped
 * with that exact scope PLUS unscoped nodes (pre-existing/owner memories) —
 * never nodes belonging to a DIFFERENT scope, which is the actual isolation.
 */
function scopedNodes(nodes: readonly MemoryNode[], scope: string | undefined): readonly MemoryNode[] {
  if (scope === undefined) return nodes;
  return nodes.filter((n) => n.scope === scope || n.scope === undefined);
}

export class MemoryStore {
  /** V4 semantic seeds: optional embedder + sidecar index. Absent → classic store. */
  private embedder?: Embedder;
  private embedIndex?: EmbedIndex;
  /** Serializes background embedding refreshes; errors never escape the chain. */
  private embedQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly nodes: Map<string, MemoryNode>,
    /**
     * Raw JSONL lines from a *newer* schema version this binary doesn't
     * understand. Held verbatim and re-written on every persist() so an older
     * Ares can never silently destroy memory a newer one wrote.
     */
    private readonly quarantined: string[] = [],
  ) {}

  /** Open (or create) a memory store at a root dir/file — the pluggable home. */
  static async open(root?: string): Promise<MemoryStore> {
    const file = root ? resolveFile(root) : mindPaths().memoryFile;
    const nodes = new Map<string, MemoryNode>();
    const quarantined: string[] = [];
    let repaired = false;
    try {
      const raw = await fs.readFile(file, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: MemoryNode;
        try {
          parsed = JSON.parse(trimmed) as MemoryNode;
        } catch {
          // Genuinely corrupt (half-written / invalid JSON): skip — don't crash.
          continue;
        }
        // A record from a NEWER schema than we understand: never load it (we'd
        // mangle fields we don't know), never drop it. Hold it verbatim so the
        // next persist() rewrites it untouched — non-destructive forward-compat.
        if (typeof parsed.v === "number" && parsed.v > MEMORY_SCHEMA_VERSION) {
          quarantined.push(trimmed);
          continue;
        }
        // Missing `v` = the pre-versioned shape → backfill to version 1.
        const versioned = typeof parsed.v === "number" ? parsed : { ...parsed, v: MEMORY_SCHEMA_VERSION };
        repaired ||= versioned.v !== parsed.v;
        const node = sanitizeNode(versioned);
        repaired ||= node.content !== parsed.content;
        nodes.set(node.id, node);
      }
    } catch {
      // no memory yet
    }
    const ids = new Set(nodes.keys());
    for (const [id, node] of nodes) {
      const links = [...new Set(node.links)].filter((link) => link !== id && ids.has(link));
      if (links.length !== node.links.length) {
        nodes.set(id, { ...node, links });
        repaired = true;
      }
    }
    const store = new MemoryStore(file, nodes, quarantined);
    if (repaired) await store.persist();
    return store;
  }

  /** In-memory store (no file) — for tests and ephemeral runs. */
  static memory(): MemoryStore {
    return new MemoryStore("", new Map());
  }

  all(): MemoryNode[] {
    return [...this.nodes.values()];
  }

  get(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  count(): number {
    return this.nodes.size;
  }

  async add(input: AddInput): Promise<MemoryNode> {
    const node = this.insert(input);
    await this.persist();
    // Embed at write time — but in the background. A turn never waits on a model.
    this.scheduleEmbedRefresh();
    return node;
  }

  /**
   * Add many nodes with a SINGLE persist() at the end. A bulk write (durable-fact
   * merges, dream candidate batches) that looped add() rewrote the whole JSONL
   * file once per node — N adds → N full-file rewrites, O(N²). This inserts all
   * in memory, then flushes once. Same nodes, same embed refresh, one write.
   */
  async addMany(inputs: readonly AddInput[]): Promise<MemoryNode[]> {
    if (inputs.length === 0) return [];
    const nodes = inputs.map((input) => this.insert(input));
    await this.persist();
    this.scheduleEmbedRefresh();
    return nodes;
  }

  /** Build + register a node in memory WITHOUT persisting — the shared core of
   *  add()/addMany(). Callers own the flush so a batch can write the file once. */
  private insert(input: AddInput): MemoryNode {
    const at = (input.at ?? new Date()).toISOString();
    const node: MemoryNode = {
      v: MEMORY_SCHEMA_VERSION,
      id: `mem_${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      content: trimMemoryContent(input.content),
      at,
      strength: input.strength ?? 1,
      activations: 0,
      lastActivatedAt: at,
      links: [],
      tags: input.tags,
      source: input.source,
      status: input.status,
      check: input.check,
      scope: input.scope,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * Wire semantic seeding: an embedder plus the sidecar vector index. From here
   * on add() refreshes vectors in the background, consolidate() settles them,
   * and remember() blends embedding similarity into its seeds — using only
   * vectors already in the index, never blocking a recall on embedding work.
   */
  attachEmbedder(embedder: Embedder, index: EmbedIndex): void {
    this.embedder = embedder;
    this.embedIndex = index;
  }

  /** Embed every stale node now and persist the sidecar. Embedder errors propagate. */
  async reindex(): Promise<void> {
    await this.embedQueue.catch(() => {});
    await this.refreshEmbeddings();
  }

  /** Background, best-effort refresh — serialized so writes never interleave. */
  private scheduleEmbedRefresh(): void {
    if (!this.embedder || !this.embedIndex) return;
    this.embedQueue = this.embedQueue
      .catch(() => {})
      .then(() => this.refreshEmbeddings())
      .catch(() => {
        // Best-effort by design: an unreachable embedder costs freshness, never
        // a turn. reindex() is the path that surfaces the error.
      });
  }

  /** Drop vectors for deleted nodes, embed stale ones, persist if anything moved. */
  private async refreshEmbeddings(): Promise<void> {
    const embedder = this.embedder;
    const index = this.embedIndex;
    if (!embedder || !index) return;
    let changed = false;
    for (const id of index.ids()) {
      if (!this.nodes.has(id)) {
        index.remove(id);
        changed = true;
      }
    }
    const live = this.all().map((n) => ({ id: n.id, content: n.content }));
    const contentById = new Map(live.map((n) => [n.id, n.content]));
    const stale = index.staleIds(live);
    for (let i = 0; i < stale.length; i += EMBED_BATCH) {
      const batch = stale.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(batch.map((id) => contentById.get(id) ?? ""));
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        if (!Array.isArray(vector) || vector.length === 0) continue;
        const content = contentById.get(batch[j]);
        if (content === undefined) continue;
        index.upsert(batch[j], contentHash(content), vector);
        changed = true;
      }
    }
    if (changed) await index.persist();
  }

  /**
   * Embed the cue with a hard timeout. Anything but a prompt, well-formed
   * vector — slow model, network error, empty result — yields undefined and
   * recall proceeds purely lexical. The embedder is not even consulted when the
   * index holds no vectors (nothing to compare against).
   */
  private async embedCue(cue: string): Promise<Float32Array | undefined> {
    const embedder = this.embedder;
    const index = this.embedIndex;
    if (!embedder || !index || index.size === 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        // Deliberately NOT unref'd: this timer is the guarantee that a hung
        // embedder cannot hang remember() — an unref'd timer never fires when
        // it is the only thing left on the loop. Cleared in finally; worst
        // case it holds the process open for 300ms.
        timer = setTimeout(() => resolve(undefined), CUE_EMBED_TIMEOUT_MS);
      });
      const embedded = embedder.embed([cue]).then((vs) => vs[0]);
      // A rejection landing AFTER the timeout won the race must never surface
      // as an unhandled rejection — mark it handled up front.
      embedded.catch(() => {});
      const vector = await Promise.race([embedded, timeout]);
      if (!Array.isArray(vector) || vector.length === 0) return undefined;
      return Float32Array.from(vector);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Recall options with vector seeding wired in — or untouched when unavailable. */
  private async withCueVectors(cue: string, opts: RecallOptions): Promise<RecallOptions> {
    if (opts.vectors) return opts; // caller brought their own
    const index = this.embedIndex;
    if (!index) return opts;
    const cueVector = await this.embedCue(cue);
    if (!cueVector) return opts; // lexical fallback — the V4 invariant
    return { ...opts, vectors: { get: (id) => index.get(id), cueVector } };
  }

  /** Crucible hypotheses awaiting trial. */
  candidates(): MemoryNode[] {
    return this.all().filter((n) => n.status === "candidate");
  }

  /**
   * V6 consequence wiring — the part no shipped agent has. An outcome landed
   * (probe verdict, verifier result, turn status); every memory that was IN
   * PLAY for that outcome gets the evidence appended and its strength moved by
   * the result, not by recall popularity: wins reinforce, losses weaken. The
   * caller decides what "in play" means (recall-injected ids, a skill used,
   * a belief acted on).
   */
  async recordOutcome(
    ids: readonly string[],
    outcome: { won: boolean; note: string; fingerprint?: string; now?: Date },
  ): Promise<number> {
    const now = outcome.now ?? new Date();
    let touched = 0;
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const entry = {
        at: now.toISOString(),
        won: outcome.won,
        note: outcome.note.slice(0, 240),
        ...(outcome.fingerprint !== undefined ? { fingerprint: outcome.fingerprint } : {}),
      };
      const evidence = [...(node.evidence ?? []), entry].slice(-EVIDENCE_CAP);
      const adjusted = outcome.won ? reinforce(node, now, 0.4) : weaken(node, now);
      this.nodes.set(id, { ...adjusted, evidence });
      touched++;
    }
    if (touched > 0) await this.persist();
    return touched;
  }

  /** Crucible lifecycle transition (V7 trial verdicts). Records the reason as evidence. */
  async setStatus(
    id: string,
    status: HypothesisStatus,
    note: string,
    opts: { now?: Date } = {},
  ): Promise<MemoryNode | undefined> {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    const now = opts.now ?? new Date();
    const evidence = [
      ...(node.evidence ?? []),
      { at: now.toISOString(), won: status === "confirmed", note: note.slice(0, 240) },
    ].slice(-EVIDENCE_CAP);
    const next = { ...node, status, evidence };
    this.nodes.set(id, next);
    await this.persist();
    return next;
  }

  async link(aId: string, bId: string): Promise<void> {
    this.linkPair(aId, bId);
    await this.persist();
  }

  private linkPair(aId: string, bId: string): void {
    if (aId === bId) return;
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (!a || !b) return;
    if (!a.links.includes(bId)) this.nodes.set(aId, { ...a, links: [...a.links, bId] });
    if (!b.links.includes(aId)) this.nodes.set(bId, { ...b, links: [...b.links, aId] });
  }

  private deleteNode(id: string): void {
    if (!this.nodes.delete(id)) return;
    for (const node of this.all()) {
      if (node.links.includes(id)) {
        this.nodes.set(node.id, { ...node, links: node.links.filter((link) => link !== id) });
      }
    }
  }

  /**
   * Forget a single memory node by id — the public counterpart to consolidate()'s
   * internal auto-prune. Until now the only way to remove a node was to be a weak
   * episodic memory caught by consolidate(); there was no way for a human (or an
   * `ares mind forget <id>` command) to delete one on purpose. Returns whether a
   * node with that id existed and was removed.
   */
  async forget(id: string): Promise<boolean> {
    const existed = this.nodes.has(id);
    if (!existed) return false;
    this.deleteNode(id);
    await this.persist();
    return true;
  }

  /**
   * Recall a constellation of memories AND strengthen them. Surfacing a memory
   * reinforces it (so what's used stays vivid), and the top co-activated pair is
   * linked (Hebbian association forms from use).
   *
   * `scope` restricts the candidate pool to nodes owned by that tenant PLUS
   * unscoped (owner) nodes — never the reverse, so a guest scope can never see
   * another tenant's memories, and omitting scope entirely (the default) recalls
   * exactly as before.
   */
  async remember(cue: string, opts: RecallOptions & { scope?: string } = {}): Promise<RecallResult[]> {
    const now = opts.now ?? new Date();
    const pool = scopedNodes(this.all(), opts.scope);
    const results = recall(cue, pool, await this.withCueVectors(cue, opts));
    for (const r of results) {
      const current = this.nodes.get(r.node.id);
      if (current) this.nodes.set(current.id, reinforce(current, now));
    }
    if (results.length >= 2) this.linkPair(results[0].node.id, results[1].node.id);
    await this.persist();
    return results.map((r) => ({ ...r, node: this.nodes.get(r.node.id) ?? r.node }));
  }

  /**
   * Read-only recall: surface the same constellation as remember() but WITHOUT
   * reinforcing, linking, or persisting. For inspection paths (status recaps,
   * "what were we doing?") that must not mutate memory just by looking.
   *
   * `scope` behaves exactly as in remember() — see there.
   */
  peek(cue: string, opts: RecallOptions & { scope?: string } = {}): RecallResult[] {
    return recall(cue, scopedNodes(this.all(), opts.scope), opts);
  }

  /** Sleep: forget trivial episodes; crystallize recurring themes into knowledge. */
  async consolidate(opts: { now?: Date } = {}): Promise<ConsolidationReport> {
    const now = opts.now ?? new Date();
    let pruned = 0;
    let deduped = 0;
    const promoted: string[] = [];

    // 1. Forget faded one-off episodes and stale filler "theme" semantics.
    for (const node of this.all()) {
      // Operational noise (tool/provider error text) is never knowledge, no
      // matter its kind or source — stores populated BEFORE the write-spine
      // noise gate existed still carry these (a field index was 83% error
      // entries, 2026-08-06), and this sweep is what durably cleans them out.
      if (isOperationalNoise(node.content)) {
        this.deleteNode(node.id);
        pruned++;
        continue;
      }
      // Crystallized insight/belief nodes the deep dream synthesized are normally
      // spared pruning — but not unconditionally: a synthesized belief that keeps
      // getting DISPROVEN via recordOutcome (driven down to PRUNE_FLOOR by repeat
      // losses) is dead weight forever otherwise, a near-zero-strength node that
      // still surfaces as a recall candidate. Require enough evidence (>=3) so a
      // single early loss can't kill a fresh insight, and a losing majority.
      if (node.source === "synthesis") {
        if (isDisprovenSynthesis(node, now)) {
          this.deleteNode(node.id);
          pruned++;
        }
        continue;
      }
      if (node.kind === "episodic" && currentStrength(node, now) < PRUNE_FLOOR) {
        this.deleteNode(node.id);
        pruned++;
        continue;
      }
      if (isNoiseThemeSemantic(node)) {
        this.deleteNode(node.id);
        pruned++;
      }
    }

    // 2. Merge exact duplicates into one stronger node and redirect links.
    deduped += this.mergeDuplicateContent(now);

    // Theme promotion is GONE. Single-token "Recurring theme \"X\" observed
    // across N episodes" semantics carried no knowledge — just a token and a
    // count — and the stopword gate was unwinnable whack-a-mole: on the
    // owner's real store, 47 of 66 nodes were themes like "first", "every"
    // and "claude" (2026-08-10). Crystallization is synthesize()'s job — its
    // insight/belief nodes carry IDF-ranked multi-token keys, provenance
    // links, confidence, and optional phrased prose. isNoiseThemeSemantic now
    // treats EVERY legacy theme node as prunable filler (step 1 above).

    await this.persist();
    // Settle vectors with sleep: prune deleted ids, embed new/edited nodes.
    // Best-effort — consolidation must succeed even with the embedder down.
    await this.embedQueue.catch(() => {});
    await this.refreshEmbeddings().catch(() => {});
    return { pruned, deduped, promoted, kept: this.nodes.size };
  }

  /**
   * Dreaming synthesis: cluster recurring episodes into durable "insight" nodes
   * and recurring failure signatures into "belief" nodes — the real "what should
   * I believe now" pass. Idempotent by tag (re-running reinforces, never dupes),
   * provider-free by default; an optional injected phraser writes richer prose
   * without coupling @ares/mind to any model.
   */
  async synthesize(opts: { now?: Date; synthesizer?: Phraser; minMembers?: number } = {}): Promise<SynthesisReport> {
    const now = opts.now ?? new Date();
    // Synthesize over raw memory only — exclude prior synthesis output so its own
    // content can never perturb the IDF corpus or shift a cluster key (which would
    // break idempotency: the same recurring set must always map to the same tag).
    const nodes = this.all().filter((n) => n.source !== "synthesis");
    const idf = buildIdf(nodes);
    const candidates = [
      ...clusterByConcept(nodes, idf, { minMembers: opts.minMembers }),
      ...detectRecurringFailures(nodes, idf),
    ];
    let insights = 0;
    let beliefs = 0;
    let updated = 0;
    for (const c of candidates) {
      const tag = `${c.kind}:${c.key}`;
      const members = c.members
        .map((id) => this.nodes.get(id))
        .filter((n): n is MemoryNode => Boolean(n));
      if (members.length === 0) continue;
      const phrased = opts.synthesizer ? await opts.synthesizer(c, members).catch(() => null) : null;
      const content = phrased ?? c.defaultText;
      const existing = this.all().find((n) => n.kind === "semantic" && n.tags?.includes(tag));
      if (existing) {
        this.nodes.set(existing.id, {
          ...existing,
          content,
          confidence: Math.min(1, (existing.confidence ?? 0.5) + 0.1),
          derivedFrom: [...new Set([...(existing.derivedFrom ?? []), ...c.members])],
          strength: existing.strength + 0.5,
        });
        for (const m of members) this.linkPair(existing.id, m.id);
        updated++;
        continue;
      }
      const node = await this.add({
        kind: "semantic",
        content,
        tags: [tag],
        source: "synthesis",
        strength: 1.5 + Math.min(2, c.salience * 0.1),
        at: now,
      });
      const created = this.nodes.get(node.id);
      if (created) {
        this.nodes.set(node.id, { ...created, confidence: c.kind === "belief" ? 0.6 : 0.5, derivedFrom: c.members });
      }
      for (const m of members) this.linkPair(node.id, m.id);
      if (c.kind === "belief") beliefs++;
      else insights++;
    }
    await this.persist();
    return { insights, beliefs, updated };
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    // Active nodes first, then any quarantined newer-schema lines verbatim — so
    // a round-trip through an older binary never destroys forward-version data.
    const lines = [...this.all().map((n) => JSON.stringify(n)), ...this.quarantined];
    await writeFileAtomic(this.file, lines.length ? lines.join("\n") + "\n" : "");
  }

  private mergeDuplicateContent(now: Date): number {
    const byContent = new Map<string, MemoryNode[]>();
    for (const node of this.all()) {
      const key = normalizeForDedup(node.content);
      if (!key) continue;
      const bucket = byContent.get(key) ?? [];
      bucket.push(node);
      byContent.set(key, bucket);
    }

    let merged = 0;
    for (const group of byContent.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => {
        const strengthDelta = currentStrength(b, now) - currentStrength(a, now);
        if (strengthDelta !== 0) return strengthDelta;
        return b.activations - a.activations;
      });
      const keeper = sorted[0];
      const duplicates = sorted.slice(1);
      const duplicateIds = new Set(duplicates.map((node) => node.id));
      const allGroupIds = new Set(group.map((node) => node.id));
      const links = new Set<string>();
      const tags = new Set<string>();
      let activations = 0;
      let strength = 0;
      let lastActivatedAt = keeper.lastActivatedAt;

      for (const node of group) {
        activations += node.activations;
        strength += node.strength;
        if (node.lastActivatedAt > lastActivatedAt) lastActivatedAt = node.lastActivatedAt;
        for (const link of node.links) {
          if (!allGroupIds.has(link)) links.add(link);
        }
        for (const tag of node.tags ?? []) tags.add(tag);
      }

      this.nodes.set(keeper.id, {
        ...keeper,
        strength: Math.min(50, strength),
        activations,
        lastActivatedAt,
        links: [...links],
        tags: tags.size ? [...tags] : keeper.tags,
      });

      for (const duplicate of duplicates) this.nodes.delete(duplicate.id);
      for (const node of this.all()) {
        if (node.id === keeper.id) continue;
        const redirected = [...new Set(node.links.map((link) => (duplicateIds.has(link) ? keeper.id : link)))]
          .filter((link) => link !== node.id);
        if (redirected.length !== node.links.length || redirected.some((link, i) => link !== node.links[i])) {
          this.nodes.set(node.id, { ...node, links: redirected });
        }
      }
      merged += duplicates.length;
    }
    return merged;
  }
}

/** consolidate() as a {@link ReflectionSurface}: same call, uniform envelope. */
export const consolidateReflectionSurface: ReflectionSurface<{ store: MemoryStore; now?: Date }> = {
  name: "consolidate",
  async run({ store, now }): Promise<ReflectionResult> {
    const report = await store.consolidate(now === undefined ? {} : { now });
    const directives = [
      ...(report.pruned ? [`pruned ${report.pruned} faded memory(ies)`] : []),
      ...(report.deduped ? [`merged ${report.deduped} duplicate(s)`] : []),
      ...report.promoted.map((t) => `promoted theme "${t}"`),
    ];
    return { directives, persistedTo: "memory.jsonl" };
  },
};

/** synthesize() as a {@link ReflectionSurface}: same call, uniform envelope. */
export const synthesizeReflectionSurface: ReflectionSurface<{
  store: MemoryStore;
  now?: Date;
  synthesizer?: Phraser;
  minMembers?: number;
}> = {
  name: "synthesize",
  async run({ store, now, synthesizer, minMembers }): Promise<ReflectionResult> {
    const report = await store.synthesize({
      ...(now === undefined ? {} : { now }),
      ...(synthesizer === undefined ? {} : { synthesizer }),
      ...(minMembers === undefined ? {} : { minMembers }),
    });
    const directives = [
      ...(report.insights ? [`crystallized ${report.insights} insight(s)`] : []),
      ...(report.beliefs ? [`crystallized ${report.beliefs} belief(s)`] : []),
      ...(report.updated ? [`reinforced ${report.updated} synthesis node(s)`] : []),
    ];
    return { directives, persistedTo: "memory.jsonl" };
  },
};

function sanitizeNode(node: MemoryNode): MemoryNode {
  const content = trimMemoryContent(node.content);
  return content === node.content ? node : { ...node, content };
}

function trimMemoryContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_MEMORY_CONTENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_MEMORY_CONTENT_CHARS)}\n[truncated memory: ${trimmed.length - MAX_MEMORY_CONTENT_CHARS} chars omitted]`;
}

function normalizeForDedup(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}


const MIN_PRUNE_EVIDENCE = 3;

/**
 * True when a synthesized (insight/belief) node has been driven to (or near)
 * PRUNE_FLOOR by repeated recordOutcome losses — i.e. reality kept disproving
 * it. Requires at least MIN_PRUNE_EVIDENCE outcomes with a losing majority so
 * one bad early trial can't prune a belief that hasn't had a fair shake yet.
 */
function isDisprovenSynthesis(node: MemoryNode, now: Date): boolean {
  const evidence = node.evidence ?? [];
  if (evidence.length < MIN_PRUNE_EVIDENCE) return false;
  const losses = evidence.filter((e) => !e.won).length;
  if (losses <= evidence.length / 2) return false;
  return currentStrength(node, now) < PRUNE_FLOOR;
}

/** EVERY theme node is filler now that theme promotion is gone: a single
 *  token plus a count is not knowledge, and synthesize() owns crystallization.
 *  This prunes the legacy population (47 of 66 nodes on one real store). */
function isNoiseThemeSemantic(node: MemoryNode): boolean {
  if (node.kind !== "semantic") return false;
  return Boolean(
    node.tags?.some((t) => t.startsWith("theme:")) ||
    /^Recurring theme "[^"]+" observed across \d+ episodes\.?$/.test(node.content),
  );
}
