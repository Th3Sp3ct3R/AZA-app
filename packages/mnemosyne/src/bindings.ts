// Binding classes — memory with FORCE, not just presence.
//
// The 2026-08-10 failure class this exists to kill: an owner order was written
// to memory, recalled into context… and then lost a budget fight or simply
// wasn't honored. A Binding is a memory that BINDS behavior, with a class that
// says how hard:
//
//   law      — the owner's standing order. Always-on, outranks doctrine,
//              guard-compiled when parseable. Owner-sourced only.
//   pact     — a commitment Ares itself made to the owner ("I'll always ask
//              before pushing"). Same always-on force as law, agent-sourced —
//              and the attestation loop holds Ares to its own word.
//   doctrine — an agent-learned operating rule. Budgeted tier (rides normal
//              context compilation), tracked for compliance but never compiled
//              into hard guards.
//
// LAWS.md stays the sync read-through mirror: the CLI's prompt composer reads
// it synchronously per compose (lawsPromptBlock), so every law-class change
// here is exported back to that file. Mnemosyne owns the truth; LAWS.md is the
// hot cache.
//
// One JSON file per binding under <home>/mnemosyne/bindings/. Atomic writes,
// tolerant reads — the same resume-safe discipline as operator goals.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { mnemosynePaths } from "./paths.js";
import { writeFileAtomic } from "./io.js";
import { compileGuard, type CompiledGuard } from "./guards.js";

export const BINDING_SCHEMA = 1;
/** Mirror of laws.ts MAX_LAWS — the law tier stays scarce and loud at the cap. */
export const MAX_LAWS = 24;
export const MAX_BINDING_CHARS = 300;

export type BindingClass = "law" | "pact" | "doctrine";
export type BindingSource = "owner" | "agent";

export interface BindingStats {
  /** Turns that reported on this binding at all. */
  attested: number;
  honored: number;
  violated: number;
  lastAttestedAt?: string;
}

export interface Binding {
  schemaVersion: number;
  id: string;
  class: BindingClass;
  text: string;
  source: BindingSource;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present when the text compiled into a machine-checkable guard. */
  guard?: CompiledGuard;
  stats: BindingStats;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function bindingFile(home: string | undefined, id: string): string {
  return path.join(mnemosynePaths(home).bindingsDir, `${sanitizeId(id)}.json`);
}

export function newBindingId(now = new Date()): string {
  return `b_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;
}

/** Same normalization discipline as laws.ts — dedupe must survive punctuation drift. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[.!]+\s*$/, "").replace(/\s+/g, " ").trim();
}

export async function saveBinding(home: string | undefined, binding: Binding): Promise<string> {
  const file = bindingFile(home, binding.id);
  await writeFileAtomic(file, JSON.stringify(binding, null, 2) + "\n");
  return file;
}

export async function loadBindings(home?: string): Promise<Binding[]> {
  const dir = mnemosynePaths(home).bindingsDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const bindings: Binding[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      bindings.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Binding);
    } catch {
      // skip a corrupt binding file
    }
  }
  return bindings.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export interface AddBindingInput {
  class: BindingClass;
  text: string;
  source?: BindingSource;
}

/**
 * Add (or refresh) a binding. Dedupe is by normalized text within the class —
 * re-adding refreshes updatedAt and reactivates rather than duplicating. The
 * law tier throws LOUDLY at MAX_LAWS, mirroring laws.ts: silent eviction of an
 * owner's order is the one failure mode this system must never have.
 */
export async function addBinding(home: string | undefined, input: AddBindingInput, now = new Date()): Promise<Binding> {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("a binding needs text");
  if (text.length > MAX_BINDING_CHARS) {
    throw new Error(`a binding is a rule, not an essay — keep it under ${MAX_BINDING_CHARS} chars`);
  }
  if (input.class === "law" && (input.source ?? "owner") !== "owner") {
    throw new Error("only the owner sources laws — an agent commitment is a pact");
  }
  const existing = await loadBindings(home);
  const normalized = normalizeText(text);
  const match = existing.find((b) => b.class === input.class && normalizeText(b.text) === normalized);
  if (match) {
    match.text = text;
    match.active = true;
    match.updatedAt = now.toISOString();
    match.guard = compileGuard(text) ?? undefined;
    await saveBinding(home, match);
    return match;
  }
  if (input.class === "law") {
    const laws = existing.filter((b) => b.class === "law" && b.active);
    if (laws.length >= MAX_LAWS) {
      throw new Error(
        `LAWS is at its cap (${MAX_LAWS}). Retire one before adding another — laws are scarce on purpose.`,
      );
    }
  }
  const binding: Binding = {
    schemaVersion: BINDING_SCHEMA,
    id: newBindingId(now),
    class: input.class,
    text,
    source: input.source ?? (input.class === "pact" ? "agent" : "owner"),
    active: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    guard: compileGuard(text) ?? undefined,
    stats: { attested: 0, honored: 0, violated: 0 },
  };
  await saveBinding(home, binding);
  return binding;
}

/** Deactivate (never delete — the ledger's history stays meaningful). */
export async function retireBinding(home: string | undefined, id: string, now = new Date()): Promise<boolean> {
  const bindings = await loadBindings(home);
  const binding = bindings.find((b) => b.id === id);
  if (!binding) return false;
  binding.active = false;
  binding.updatedAt = now.toISOString();
  await saveBinding(home, binding);
  return true;
}

/** The always-on set: active laws and pacts. Doctrine rides the budgeted path. */
export function alwaysOnBindings(bindings: readonly Binding[]): Binding[] {
  return bindings.filter((b) => b.active && (b.class === "law" || b.class === "pact"));
}

/** All compiled guards from active bindings, for mechanical enforcement. */
export function activeGuards(bindings: readonly Binding[]): CompiledGuard[] {
  return bindings.filter((b) => b.active && b.guard).map((b) => b.guard as CompiledGuard);
}

// ── LAWS.md interop — the sync read-through mirror ─────────────────────────

const LAW_LINE = /^\s*-\s*(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.+?)\s*$/;

/**
 * Import LAWS.md lines as law bindings (dedupe by normalized text). Run once at
 * adoption; safe to re-run — existing bindings just refresh.
 */
export async function importLawsFile(home?: string): Promise<Binding[]> {
  const file = mnemosynePaths(home).lawsFile;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const imported: Binding[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(LAW_LINE);
    if (!m || !m[2] || m[2].startsWith("#")) continue;
    try {
      imported.push(await addBinding(home, { class: "law", text: m[2], source: "owner" }));
    } catch {
      // cap or malformed line — keep importing the rest
    }
  }
  return imported;
}

/**
 * Export active law bindings back to LAWS.md so the CLI's synchronous
 * lawsPromptBlock keeps working unchanged. Call after every law-class change.
 */
export async function exportLawsFile(home?: string): Promise<string> {
  const file = mnemosynePaths(home).lawsFile;
  const laws = (await loadBindings(home)).filter((b) => b.class === "law" && b.active);
  const lines = laws.map((b) => `- [${b.updatedAt.slice(0, 10)}] ${b.text}`);
  const body = `# LAWS.md — the owner's standing orders\n\n${lines.join("\n")}\n`;
  await writeFileAtomic(file, body);
  return file;
}
