// LAWS — the owner's standing orders, as an ALWAYS-ON prompt layer.
//
// The failure this exists to kill: the owner says "stop verifying with GitHub
// every time", the agent acknowledges, writes it to memory — and does it again
// four more times. Root cause, measured: the built-in doctrine (verify, prove,
// re-check) ships in the system prompt EVERY turn, unbudgeted, while the
// owner's countermanding instruction landed in SOUL — a budgeted context block
// competing with six other files for ~3.5k tokens, where a SHORT user message
// shrinks the budget further. The owner's order was structurally guaranteed to
// lose to the developer's defaults.
//
// So laws are the opposite of memories on every axis:
//   - always injected, never budgeted, never similarity-recalled;
//   - a small capped list of one-sentence imperatives, not a knowledge store;
//   - they explicitly OUTRANK default doctrine when they conflict;
//   - the file is the owner's (LAWS.md, human-editable), the agent writes it
//     only through SelfEvolve target=laws.
//
// Facts belong in memory, where retrieval can be clever. Rules belong here,
// where nothing clever can lose them.

import * as fs from "node:fs";
import path from "node:path";
import { agentPaths, aresAgentHome } from "./paths.js";
import { writeFileAtomic } from "./files.js";

/** Hard cap. Laws are the ALWAYS-ON tier — an unbounded list would quietly
 *  rebuild the context-budget problem this layer exists to escape. When full,
 *  adding fails loudly with instructions to consolidate; silently evicting an
 *  owner's standing order is exactly the betrayal this system prevents. */
export const MAX_LAWS = 24;

const LAW_LINE = /^\s*-\s*(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.+?)\s*$/;

export interface Law {
  date: string;
  text: string;
}

export function lawsPath(home = aresAgentHome()): string {
  return agentPaths(home).laws;
}

function parseLaws(raw: string): Law[] {
  const laws: Law[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("-")) continue;
    const m = LAW_LINE.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (text) laws.push({ date: m[1] ?? "", text });
  }
  return laws;
}

function renderLaws(laws: readonly Law[]): string {
  const lines = [
    "# Laws — the owner's standing orders",
    "",
    "One imperative sentence per law. This file is injected into EVERY system",
    "prompt, unbudgeted — edit or delete lines freely; the agent honors what is",
    "here and only here.",
    "",
    ...laws.map((l) => `- ${l.date ? `[${l.date}] ` : ""}${l.text}`),
    "",
  ];
  return lines.join("\n");
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[.!]\s*$/, "").replace(/\s+/g, " ").trim();
}

export async function listLaws(home = aresAgentHome()): Promise<Law[]> {
  try {
    return parseLaws(await fs.promises.readFile(lawsPath(home), "utf8"));
  } catch {
    return [];
  }
}

/** Add a standing order. Idempotent: re-adding an existing law refreshes its
 *  date instead of duplicating. Throws when the cap is reached — the agent is
 *  told to consolidate or remove, never to silently drop an order. */
export async function addLaw(text: string, home = aresAgentHome()): Promise<Law[]> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("a law needs text");
  if (clean.length > 300) throw new Error("a law is ONE imperative sentence (max 300 chars) — distill it");
  const laws = await listLaws(home);
  const today = new Date().toISOString().slice(0, 10);
  const existing = laws.find((l) => normalize(l.text) === normalize(clean));
  if (existing) {
    existing.date = today;
  } else {
    if (laws.length >= MAX_LAWS) {
      throw new Error(
        `LAWS.md is at its cap (${MAX_LAWS}). Laws are always-on and must stay small: ` +
          `consolidate overlapping laws into one, or remove an obsolete one (SelfEvolve target=laws), then add this.`,
      );
    }
    laws.push({ date: today, text: clean });
  }
  await writeFileAtomic(lawsPath(home), renderLaws(laws));
  invalidateLawsCache();
  return laws;
}

/** Remove a law by exact-or-normalized text match. Returns remaining laws. */
export async function removeLaw(text: string, home = aresAgentHome()): Promise<Law[]> {
  const laws = await listLaws(home);
  const target = normalize(text);
  const kept = laws.filter((l) => normalize(l.text) !== target);
  if (kept.length === laws.length) throw new Error(`no law matches: ${text}`);
  await writeFileAtomic(lawsPath(home), renderLaws(kept));
  invalidateLawsCache();
  return kept;
}

// ── the always-on prompt block ──────────────────────────────────────────────
// Prompt composition is synchronous and runs per provider call, so the file is
// read sync with an mtime cache — a stat per compose, a read only on change.

let cachedBlock: { file: string; mtimeMs: number; block: string } | null = null;

function invalidateLawsCache(): void {
  cachedBlock = null;
}

/** The rendered prompt section, or "" when no laws exist. ALWAYS-ON: callers
 *  join this into the system prompt itself, never into a budgeted context
 *  block and never behind recall. */
export function lawsPromptBlock(home = aresAgentHome()): string {
  const file = lawsPath(home);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return "";
  }
  if (cachedBlock && cachedBlock.file === file && cachedBlock.mtimeMs === mtimeMs) {
    return cachedBlock.block;
  }
  let laws: Law[];
  try {
    laws = parseLaws(fs.readFileSync(file, "utf8"));
  } catch {
    return "";
  }
  const block = laws.length === 0 ? "" : [
    "## The owner's laws — standing orders, ALWAYS in force",
    "",
    "The owner gave these as standing orders. They are not memories and not",
    "suggestions: they are in force RIGHT NOW, this turn, and they OVERRIDE any",
    "default habit or doctrine in this prompt when they conflict — verification",
    "cadence, when to push or ask, formatting, tool choices, all of it. Only",
    "hard safety floors rank above them (never destroy unrecoverable data,",
    "photosensitivity protections, the permission system itself). Before you",
    "act, check the action against this list. Violating a law and apologizing",
    "afterwards is a failure; so is making the owner repeat one.",
    "",
    ...laws.map((l) => `- ${l.text}${l.date ? ` (given ${l.date})` : ""}`),
  ].join("\n");
  cachedBlock = { file, mtimeMs, block };
  return block;
}
