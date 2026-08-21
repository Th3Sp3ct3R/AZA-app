import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentPaths, aresAgentHome } from "./paths.js";
import { readTextIfExists, writeFileAtomic } from "./files.js";
import { expandHomePath, type AresAgentConfig } from "./config.js";
import { createMemoryStore } from "./memory/vectorStore.js";
import type { MemoryCategory } from "./memory/types.js";
import { emitLifecycle } from "./lifecycle/bus.js";
import { loadSelfModel } from "./self/store.js";
import { reflect } from "./self/reflect.js";
import { gainForTarget } from "./voice.js";
import { MemoryRouter, MemoryStore as LivingMemoryStore, isOperationalNoise, migrateLegacyVectors, mindPaths } from "@ares/mind";

const DREAM_MEMORY_ITEM_CHARS = 420;
const DREAM_MEMORY_MAX_ITEMS = 120;

export interface DreamResult {
  phase: "light" | "deep" | "rem";
  promoted: number;
  pruned: number;
  report: string;
}

export async function runLightDream(opts: {
  home?: string;
  workspace: string;
  sessionId: string;
  transcriptPath?: string;
  config: AresAgentConfig;
  now?: Date;
}): Promise<DreamResult> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  emitLifecycle({ type: "dream_phase_started", phase: "light" });
  const now = opts.now ?? new Date();
  const events = opts.transcriptPath ? await readTextIfExists(opts.transcriptPath, 2_000_000) : "";
  // Noise-gated at the source: a pasted stack trace in a user message is
  // still a user message to extractSessionSignals, but it is not knowledge.
  const snippets = extractSessionSignals(events ?? "").filter((s) => !isOperationalNoise(s)).slice(0, 5);
  const daily = path.join(paths.memoryDir, `${now.toISOString().slice(0, 10)}.md`);
  await mkdir(path.dirname(daily), { recursive: true });
  if (snippets.length > 0) {
    await appendFile(daily, [`\n## Session ${opts.sessionId}`, ...snippets.map((s) => `- ${s}`), ""].join("\n"), "utf8");
    const store = await createMemoryStore(opts.config, home);
    // Dream candidates must land in BOTH substrates: the v4 vector store (for the
    // DEEP-dream promotion pass that reads store.list()) AND the v6 living memory
    // the live turn actually recalls from. Writing only v4 left dreamed memories
    // invisible to recall — staged into a silo the live brain never reads.
    const living = await LivingMemoryStore.open(mindPaths(home).memoryFile).catch(() => null);
    for (const snippet of snippets) {
      await store.add({ category: classifySignal(snippet), workspace: opts.workspace, content: snippet, source: "light-dreaming", score: 0.55 });
    }
    // Episodic in v6: a dream candidate is a raw session signal; consolidation
    // crystallizes the recurring ones into semantic. Routed through the ONE
    // write spine ("dream" channel: ungated — consolidate() merges repeats into
    // strength later) and flushed as a single batch. Best-effort — a dream is
    // never broken by the living store being unavailable.
    if (living) {
      await new MemoryRouter(living)
        .write("dream", snippets.map((snippet) => ({ kind: "episodic" as const, content: snippet, source: "light-dreaming", strength: 0.55 })))
        .catch(() => undefined);
    }
  }
  const report = snippets.length > 0 ? `LIGHT staged ${snippets.length} memory candidate(s).` : "LIGHT found no durable memory candidates.";
  await appendDreamDiary(paths.dreamsDiary, now, report);
  emitLifecycle({ type: "dream_phase_ended", phase: "light", promoted: snippets.length, pruned: 0 });
  return { phase: "light", promoted: snippets.length, pruned: 0, report };
}

export async function runDeepDream(opts: {
  home?: string;
  workspace?: string;
  config: AresAgentConfig;
  now?: Date;
}): Promise<DreamResult> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  emitLifecycle({ type: "dream_phase_started", phase: "deep" });
  const store = await createMemoryStore(opts.config, home);
  const memories = await store.list();
  // The noise gate applies at PROMOTION, not just at write time: the v4 vector
  // store is append-only (no delete API), so "Tool error observed:" rows
  // harvested by long-gone code re-surfaced into MEMORY.md on every deep dream
  // — a field user's index was 24 error entries against 5 real memories
  // (2026-08-06). Filtering here starves legacy noise out of the index for
  // good, because this pass REWRITES MEMORY.md wholesale.
  const promoted = memories.filter((memory) =>
    memory.score >= opts.config.dreaming.minScore &&
    (memory.hits >= opts.config.dreaming.minRecallCount || memory.source === "light-dreaming") &&
    !isOperationalNoise(memory.content)
  );
  if (promoted.length > 0) {
    const lines = ["# Memory", "", "_(Curated long-term memory. Only DEEP dreaming writes here.)_", ""];
    for (const memory of promoted.slice(-DREAM_MEMORY_MAX_ITEMS)) {
      lines.push(`- [${memory.category}#${memory.id}] ${compact(memory.content, DREAM_MEMORY_ITEM_CHARS)}`);
    }
    await writeFileAtomic(paths.memory, lines.join("\n") + "\n");
  }
  const soulPromoted = await promoteSoulRules(paths.soul, promoted, opts.config.dreaming.soulRewriteThreshold);
  // One-time v4→v6 fold: migrate the legacy vector store into living memory once,
  // guarded by a marker file so it never re-scans. Idempotent on its own too
  // (content-hash dedup) — the marker just avoids the read every deep dream.
  await migrateLegacyVectorsOnce(home, expandHomePath(opts.config.memory.jsonFallbackPath, home));
  const now = opts.now ?? new Date();
  // Real reflection: reason over the self-model and record what to fix, acquire,
  // or prune. This is the "why did I fail / what should I become" layer.
  const selfDirectives = await reflectSelfModel(home, paths.dreamsDiary, now);
  // Real synthesis over the v6 living memory: crystallize recurring episodes into
  // insight nodes and recurring failures into belief nodes — the "what should I
  // believe now" pass that turns raw episodes into durable knowledge.
  const synthesized = await synthesizeLivingMemory(home, now);
  const report = `DEEP promoted ${promoted.length} memory candidate(s), ${soulPromoted} SOUL rule(s), ${selfDirectives} self-directive(s)${synthesized ? `, ${synthesized}` : ""}.`;
  await appendDreamDiary(paths.dreamsDiary, now, report);
  emitLifecycle({ type: "dream_phase_ended", phase: "deep", promoted: promoted.length, pruned: 0 });
  return { phase: "deep", promoted: promoted.length, pruned: 0, report };
}

export async function runRemDream(opts: {
  home?: string;
  config: AresAgentConfig;
  now?: Date;
}): Promise<DreamResult> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  emitLifecycle({ type: "dream_phase_started", phase: "rem" });
  const files = await readdir(paths.memoryDir).catch(() => []);
  const report = `REM scanned ${files.filter((file) => file.endsWith(".md")).length} daily memory file(s) for cross-workspace patterns.`;
  await appendDreamDiary(paths.dreamsDiary, opts.now ?? new Date(), report);
  emitLifecycle({ type: "dream_phase_ended", phase: "rem", promoted: 0, pruned: 0 });
  return { phase: "rem", promoted: 0, pruned: 0, report };
}

/**
 * Synthesize durable insight/belief nodes from the v6 living memory — best-effort,
 * never throws, so a dream can never be broken by it. Opens the SAME living store
 * the live turn reads/writes (mindPaths(home).memoryFile) so insights surface in
 * future recall.
 */
async function synthesizeLivingMemory(home: string, now: Date): Promise<string> {
  try {
    const store = await LivingMemoryStore.open(mindPaths(home).memoryFile);
    const report = await store.synthesize({ now });
    if (report.insights + report.beliefs + report.updated === 0) return "";
    emitLifecycle({
      type: "thought",
      kind: "reflect",
      text: `Crystallized ${report.insights} insight(s) and ${report.beliefs} belief(s) from recurring memory.`,
    });
    return `${report.insights} insight(s) + ${report.beliefs} belief(s) crystallized`;
  } catch {
    return "";
  }
}

/**
 * Fold the legacy v4 vector store into v6 living memory exactly once. Guarded by a
 * `.v4-migrated` marker beside the memory file so it doesn't re-scan vectors.json
 * on every deep dream. Best-effort — never throws, so a dream can't be broken by a
 * missing/corrupt legacy file (migrateLegacyVectors already no-ops on those).
 */
async function migrateLegacyVectorsOnce(home: string, legacyDbJsonPath: string): Promise<void> {
  try {
    const memoryFile = mindPaths(home).memoryFile;
    const marker = path.join(path.dirname(memoryFile), ".v4-migrated");
    if (await readTextIfExists(marker, 256)) return; // already migrated
    const store = await LivingMemoryStore.open(memoryFile);
    const report = await migrateLegacyVectors({ store, legacyDbJsonPath });
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, `${new Date().toISOString()} migrated=${report.migrated} scanned=${report.scanned}\n`, "utf8");
    if (report.migrated > 0) {
      emitLifecycle({
        type: "thought",
        kind: "reflect",
        text: `Folded ${report.migrated} legacy v4 memory(ies) into living memory.`,
      });
    }
  } catch {
    // Migration is an upgrade convenience; a failure must never break a dream.
  }
}

async function reflectSelfModel(home: string, dreamsDiary: string, now: Date): Promise<number> {
  try {
    const directives = reflect(await loadSelfModel(home));
    if (directives.length === 0) return 0;
    const lines = directives.slice(0, 8).map((d) => `- [${d.kind}] ${d.capabilityName}: ${d.reason}`);
    await appendFile(dreamsDiary, `\n### Self-reflection (${now.toISOString()})\n\n${lines.join("\n")}\n`, "utf8");
    emitLifecycle({
      type: "self_reflected",
      directives: directives.length,
      topKind: directives[0].kind,
      gain: gainForTarget("SELF", directives.length, "reflected"),
    });
    return directives.length;
  } catch {
    return 0;
  }
}

function extractSessionSignals(eventsJsonl: string): string[] {
  const signals = new Set<string>();
  for (const line of eventsJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { event?: { type?: string; userMessage?: unknown; message?: unknown; error?: string } };
      const event = entry.event;
      if (!event) continue;
      if (event.type === "turn_start") {
        const text = messageText((event as any).userMessage);
        if (durable(text)) signals.add(`User asked: ${compact(text)}`);
      }
      // Tool errors are DELIBERATELY not memories.
      //
      // They used to be captured here as durable FEEDBACK entries, which meant
      // long-term memory filled with lines like "Tool error observed:
      // <tool_use_error>...". Every session then injected that history back
      // into context, priming the model on its own past failures — and worse,
      // preserving bugs forever: memory still carried "SearXNG: no instance
      // URL" long after that bug was fixed in the harness.
      //
      // Transient failures already have a proper home: the friction telemetry
      // (~/.ares/telemetry/friction-*.jsonl), which reliabilityTriage and the
      // Self tool read on demand. Memory is for what stays true.
    } catch {
      // Ignore torn JSONL tails.
    }
  }
  return [...signals];
}

/**
 * Does this message state something that stays TRUE after the session ends?
 *
 * The old test was a bare keyword list including "use", "tool", and "test" —
 * words present in nearly every message anyone sends a coding agent. That is
 * how conversational openers ("...just to test your capabilities...") became
 * permanent memories, stored as truncated mid-sentence fragments.
 *
 * A standing fact is a STATEMENT, not a request: an expressed preference, a
 * settled decision, or an explicit instruction to remember. Questions and
 * task requests are work, not knowledge — the coding journal and the session
 * transcript already hold those.
 */
function durable(text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim();
  // Too short to carry a fact, or a bare question → not knowledge.
  if (clean.length < 25) return false;
  if (/^(?:hi|hey|yo|hello|sup|thanks|ok|okay)\b/i.test(clean)) return false;
  if (clean.endsWith("?")) return false;
  return (
    // Explicit instruction to retain.
    /\b(?:remember|keep in mind|for future reference|from now on|going forward)\b/i.test(clean) ||
    // Expressed preference / standing rule, stated in the first person.
    /\b(?:i|we)\s+(?:prefer|always|never|usually|don'?t|do not|like to|want you to|need you to)\b/i.test(clean) ||
    /\b(?:always|never)\s+(?:use|write|run|commit|verify|assume|ask)\b/i.test(clean) ||
    // A settled decision about how the work is done.
    /\b(?:we (?:decided|agreed|settled on|are using)|the (?:convention|standard|rule) is|stick (?:to|with))\b/i.test(clean)
  );
}

function classifySignal(text: string): MemoryCategory {
  if (/\b(user|prefer|style)\b/i.test(text)) return "USER";
  if (/\b(soul|voice|emoji|commit)\b/i.test(text)) return "SELF";
  if (/\b(decision|architecture)\b/i.test(text)) return "DECISION";
  if (/\b(error|correction|pushed back)\b/i.test(text)) return "FEEDBACK";
  return "PROJECT";
}

function messageText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
}

function compact(text: string, limit = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, Math.max(0, limit - 3))}...` : clean;
}

async function promoteSoulRules(soulPath: string, memories: readonly { id: number; category: string; content: string; hits: number }[], threshold: number): Promise<number> {
  const candidates = memories.filter((memory) => memory.category === "SELF" && memory.hits >= threshold);
  if (candidates.length === 0) return 0;
  const current = (await readTextIfExists(soulPath, 1_000_000)) ?? "# SOUL.md - Who I Am\n\n## Learned Rules\n";
  const lines = [current.trimEnd(), ""];
  let added = 0;
  for (const memory of candidates) {
    const rule = `- ${compact(memory.content, DREAM_MEMORY_ITEM_CHARS)} (source memory #${memory.id})`;
    if (current.includes(rule)) continue;
    lines.push(rule);
    added += 1;
  }
  if (added > 0) await writeFileAtomic(soulPath, lines.join("\n") + "\n");
  return added;
}

async function appendDreamDiary(file: string, now: Date, report: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `\n## ${now.toISOString()}\n\n${report}\n`, "utf8");
}

