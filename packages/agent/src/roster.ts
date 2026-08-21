// The roster — persona definitions Ares can wear or delegate to.
//
// A persona is ONE markdown file: <home>/roster/<name>/AGENT.md. Frontmatter
// declares the mechanics (expertise, triggers, tools, model preference); the
// body is the soul — the voice and standards that persona works by.
//
// The same definition feeds two very different consumption modes, and keeping
// them one file is the whole point:
//   adopt    — the live session wears it. Context is preserved, the greeting
//              discloses the switch, and the owner can revert in one click.
//   delegate — the CLI adapts it into a core SubagentTypeDef, so every persona
//              on disk is automatically a valid `subagent_type` for the Task
//              tool and for Conductor fleets.
//
// This module is deliberately PURE (fs + string work, no engine imports): the
// agent package does not depend on @ares/core, and adding that edge just to
// share a type would couple the mind layer to the turn loop. The CLI owns the
// adaptation because it already depends on both.
//
// Safety note that must survive refactors: an adopted persona is layered ABOVE
// the sealed core in composeAgentSystemPrompt, never below it. A persona shifts
// expertise and tone; it can never soften verification, and it is not a channel
// for rewriting who Ares is.

import path from "node:path";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { aresAgentHome, agentPaths } from "./paths.js";
import { writeFileAtomic } from "./files.js";

/** How eagerly a persona may take the wheel when its triggers match. */
export type PersonaAutonomy =
  /** Matches adopt themselves and announce it. The greeting IS the disclosure. */
  | "auto"
  /** Matches surface a suggestion chip; the owner taps to accept. */
  | "suggest"
  /** Never matches on its own — only explicit adoption or delegation. */
  | "manual";

export interface PersonaDef {
  /** Directory-safe slug; unique key across builtin + disk. */
  name: string;
  /** Display name shown on the card and in the chip. */
  label: string;
  /** One line: what this persona is expert at. Shown in the gallery. */
  description: string;
  /** Longer body — the actual persona prompt (voice, standards, method). */
  body: string;
  /** First words on adoption. Empty → the caller renders a neutral default. */
  greeting: string;
  /** Lowercase phrases that suggest this persona. Matched on the user's text. */
  triggers: string[];
  /** Tool names this persona is limited to WHEN DELEGATED. Empty → inherit all.
   *  Adoption never narrows the live session's belt — silently removing the
   *  owner's tools mid-conversation would be a trap, not a feature. */
  tools: string[];
  /** Sigil glyph name for the medallion (see tauri modernIcons). */
  glyph: string;
  /** Accent tone for the card. */
  tone: "ember" | "mint" | "ivory";
  autonomy: PersonaAutonomy;
  /** Optional model hint. Advisory ONLY — an owner pin always wins, exactly as
   *  with the routing lanes. A persona expresses a preference, not a pin. */
  model?: string;
  /** Optional reasoning-effort hint, clamped to the model's real ladder later. */
  effort?: string;
  /** Iteration ceiling when delegated. */
  maxTurns?: number;
  /** "builtin" ships in code; "roster" was authored on disk (by the owner or
   *  by Ares itself). Disk always wins on name collision. */
  source: "builtin" | "roster";
  /** Absolute AGENT.md path for disk personas; "" for builtins. */
  file: string;
  modifiedAt?: number;
}

// ─── Built-in roster ───────────────────────────────────────────────────
//
// These ship in code so the gallery is never empty on a fresh install, and so
// a broken/emptied roster directory can't leave Ares with nothing to delegate
// to. They are overridable: an AGENT.md with the same name shadows the builtin
// entirely, which is how the owner (or Ares) edits one — write it to disk.
//
// Every builtin is `suggest`, never `auto`, and that is not a stylistic choice.
// Forge's triggers ("fix", "build", "add a", "implement") match nearly every
// message anyone sends a coding agent, so as `auto` it seized the wheel on turn
// one of almost every conversation and the owner spent their time fighting the
// roster instead of using it. Ships-in-code personas OFFER; only a persona the
// owner deliberately authored may set itself to step in unasked.

const BUILTIN_PERSONAS: ReadonlyArray<Omit<PersonaDef, "source" | "file">> = [
  {
    name: "vitruvius",
    label: "Vitruvius",
    description: "Research and architecture. Reads widely, cites everything, argues trade-offs before writing code.",
    greeting: "Research hat on. I read before I opine and I cite what I find — what are we digging into?",
    triggers: [
      "research", "investigate", "look into", "compare", "trade-off", "tradeoff",
      "architecture", "design doc", "how does", "why does", "evaluate", "assess",
      "pros and cons", "deep dive", "explore options",
    ],
    tools: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP", "WebSearch", "WebFetch"],
    glyph: "search",
    tone: "mint",
    autonomy: "suggest",
    maxTurns: 30,
    body: `You are working as VITRUVIUS — the research and architecture specialist.

Method:
- Read before you opine. Every claim carries a file_path:line or a URL. A claim you cannot cite is a guess, and you label it as one.
- Map the ground first: what exists, what owns it, what depends on it. Then argue.
- Surface trade-offs explicitly. Name the option you would NOT take and why — a recommendation without a rejected alternative hasn't been thought through.
- Say plainly when the evidence is thin. "I could not confirm X" is a finding, not a failure.

You prefer reading and reasoning to editing. When a change is clearly warranted, say what you would change and where, then let the owner or a builder persona execute it.`,
  },
  {
    name: "forge",
    label: "Forge",
    description: "Implementation. Writes and ships code, verifies against the real thing, refuses to claim done without proof.",
    greeting: "Forge here. Point me at it — I build, I run it, and I tell you what I actually saw.",
    triggers: [
      "implement", "build", "write the", "add a", "refactor", "fix", "patch",
      "ship it", "make it work", "wire up", "hook up", "migrate",
    ],
    tools: [],
    glyph: "forge",
    tone: "ember",
    autonomy: "suggest",
    maxTurns: 60,
    body: `You are working as FORGE — the implementation specialist.

Method:
- Read the surrounding code before you touch it. Match its idiom, naming, and comment density; new code should be indistinguishable from what was already there.
- Verify against the real thing that was asked for, never a convenient proxy. A green test suite is context, not proof — run the actual path.
- When a check goes red, say so FIRST and plainly, with the output. Never dress a failure as a success.
- Finish the whole ask. If part of it is blocked, complete everything else and state exactly what you left and why.

You are allowed the full belt. Use it — but read before you edit, and never claim "done" without naming what you checked and what you saw.`,
  },
  {
    name: "aegis",
    label: "Aegis",
    description: "Adversarial review. Tries to break the work — security, edge cases, and the last 20% nobody checks.",
    greeting: "Aegis. I'm here to break it, not bless it. What am I attacking?",
    triggers: [
      "review", "audit", "check my", "is this safe", "security", "vulnerab",
      "edge case", "break this", "what could go wrong", "harden", "threat",
    ],
    tools: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP", "Bash", "PowerShell"],
    glyph: "shield",
    tone: "ember",
    autonomy: "suggest",
    maxTurns: 30,
    body: `You are working as AEGIS — adversarial review.

Your job is NOT to confirm the work works. It is to try to break it.

Two failure patterns to catch yourself doing:
1. Verification avoidance — reading the code, narrating what you WOULD test, writing "looks good", and moving on. Reading is not verification.
2. Seduced by the first 80% — a polished surface makes you want to pass it, while half the buttons do nothing and state vanishes on refresh. The last 20% is your entire value.

Probe deliberately: boundary values (0, -1, empty, huge, unicode), the same mutating call twice, concurrent writes, IDs that don't exist, and what happens when the network dies mid-operation.

Report findings with file_path:line, a concrete failure scenario, and severity. If you find nothing real, say so — an invented finding is worse than none.`,
  },
  {
    name: "scribe",
    label: "Scribe",
    description: "Writing and explanation. Docs, changelogs, commit messages, and turning tangled work into plain language.",
    greeting: "Scribe. Tell me what needs saying and who's reading it.",
    triggers: [
      "document", "write up", "explain", "readme", "changelog", "release notes",
      "commit message", "summarize", "draft", "rewrite this", "plain english",
    ],
    tools: ["Read", "Glob", "Grep", "CodebaseSearch", "Write", "Edit"],
    glyph: "scroll",
    tone: "ivory",
    autonomy: "suggest",
    maxTurns: 25,
    body: `You are working as SCRIBE — writing and explanation.

Method:
- Know the reader before the first sentence. A changelog entry for an owner, an API doc for a stranger, and a commit message for whoever bisects this in a year are three different documents.
- Lead with what changed for the reader, not with how it was built.
- Prefer the concrete: name the file, the flag, the command. Delete every sentence that would survive unchanged in an unrelated project.
- Read the code before describing it. Never document behaviour you haven't confirmed.

Match the surrounding voice. If the project writes terse and why-shaped comments, write those — not marketing copy.`,
  },
];

// ─── Frontmatter parsing ───────────────────────────────────────────────
//
// Tolerant on purpose, and for a specific reason: Ares writes these files
// itself. A model that emits `triggers: research, planning` instead of a YAML
// list, or indents a block oddly, should still get a working persona rather
// than a silently-empty one. Same posture as the SKILL.md reader.

interface Frontmatter {
  get(key: string): string;
  list(key: string): string[];
}

export function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const match = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const raw = match?.[1] ?? "";
  const body = (match?.[2] ?? (match ? "" : text)).trim();
  const lines = raw.split(/\r?\n/);

  const get = (key: string): string => {
    const re = new RegExp(`^${escapeRe(key)}:\\s*(.*)$`, "i");
    for (const line of lines) {
      const m = line.match(re);
      if (m) return unquote(m[1].trim());
    }
    return "";
  };

  const list = (key: string): string[] => {
    const inline = get(key);
    // Inline JSON array, inline comma list, or a YAML block beneath the key.
    if (inline.startsWith("[")) {
      try {
        const arr = JSON.parse(inline);
        if (Array.isArray(arr)) return arr.map((v) => unquote(String(v).trim())).filter(Boolean);
      } catch {
        // fall through to comma splitting — a near-miss array still has intent
      }
    }
    if (inline) return inline.split(",").map((s) => unquote(s.trim())).filter(Boolean);

    const start = lines.findIndex((l) => new RegExp(`^${escapeRe(key)}:\\s*$`, "i").test(l));
    if (start < 0) return [];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break; // next top-level key
      const item = lines[i].match(/^\s*-\s*(.+)$/);
      if (item) out.push(unquote(item[1].trim()));
    }
    return out.filter(Boolean);
  };

  return { fm: { get, list }, body };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Directory-safe, collision-safe slug. Empty input yields "" so callers can reject. */
export function personaSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const TONES = new Set(["ember", "mint", "ivory"]);
const AUTONOMIES = new Set(["auto", "suggest", "manual"]);

/** Build a PersonaDef from one AGENT.md. Returns null only when there is no
 *  usable name — everything else falls back to a sane default, because a
 *  half-written persona is more useful than a dropped one. */
export function personaFromMarkdown(text: string, opts: { name: string; file?: string; modifiedAt?: number }): PersonaDef | null {
  const name = personaSlug(opts.name || "");
  if (!name) return null;
  const { fm, body } = parseFrontmatter(text);
  const tone = fm.get("tone").toLowerCase();
  const autonomy = fm.get("autonomy").toLowerCase();
  const maxTurns = Number.parseInt(fm.get("maxturns") || fm.get("max_turns"), 10);
  return {
    name,
    label: fm.get("label") || fm.get("name") || titleCase(name),
    description: fm.get("description") || "A local persona.",
    body,
    greeting: fm.get("greeting"),
    // Triggers are matched case-insensitively, so normalise once here rather
    // than lowercasing on every keystroke of every turn.
    triggers: fm.list("triggers").map((t) => t.toLowerCase()).filter(Boolean).slice(0, 40),
    tools: fm.list("tools").slice(0, 40),
    glyph: fm.get("glyph") || "helm",
    tone: (TONES.has(tone) ? tone : "ivory") as PersonaDef["tone"],
    autonomy: (AUTONOMIES.has(autonomy) ? autonomy : "suggest") as PersonaAutonomy,
    model: fm.get("model") || undefined,
    effort: fm.get("effort") || undefined,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.min(maxTurns, 500) : undefined,
    source: "roster",
    file: opts.file ?? "",
    modifiedAt: opts.modifiedAt,
  };
}

function titleCase(slug: string): string {
  return slug.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Serialise a persona back to AGENT.md. Round-trips through personaFromMarkdown. */
export function personaToMarkdown(p: Omit<PersonaDef, "source" | "file" | "modifiedAt">): string {
  const fm: string[] = [
    "---",
    `label: ${p.label}`,
    `description: ${p.description}`,
  ];
  if (p.greeting) fm.push(`greeting: ${p.greeting}`);
  fm.push(`glyph: ${p.glyph}`, `tone: ${p.tone}`, `autonomy: ${p.autonomy}`);
  if (p.model) fm.push(`model: ${p.model}`);
  if (p.effort) fm.push(`effort: ${p.effort}`);
  if (p.maxTurns) fm.push(`maxTurns: ${p.maxTurns}`);
  if (p.triggers.length) {
    fm.push("triggers:");
    for (const t of p.triggers) fm.push(`  - ${t}`);
  }
  if (p.tools.length) {
    fm.push("tools:");
    for (const t of p.tools) fm.push(`  - ${t}`);
  }
  fm.push("---", "");
  return `${fm.join("\n")}\n${p.body.trim()}\n`;
}

// ─── Disk I/O ──────────────────────────────────────────────────────────

export function rosterPaths(home?: string): { rosterDir: string; fileFor: (name: string) => string } {
  const rosterDir = agentPaths(aresAgentHome(home)).rosterDir;
  return { rosterDir, fileFor: (name) => path.join(rosterDir, personaSlug(name), "AGENT.md") };
}

/**
 * The full roster: builtins merged with disk, disk winning on name collision.
 * Never throws — a missing or unreadable roster directory yields the builtins,
 * so delegation and the gallery keep working on a fresh install.
 */
export async function listPersonas(home?: string): Promise<PersonaDef[]> {
  const builtins: PersonaDef[] = BUILTIN_PERSONAS.map((p) => ({ ...p, source: "builtin", file: "" }));
  const byName = new Map<string, PersonaDef>(builtins.map((p) => [p.name, p]));

  const { rosterDir } = rosterPaths(home);
  let entries: Dirent[] = [];
  try {
    entries = await readdir(rosterDir, { withFileTypes: true });
  } catch {
    return sortRoster([...byName.values()]);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(rosterDir, entry.name, "AGENT.md");
    const text = await readFile(file, "utf8").catch(() => "");
    if (!text.trim()) continue;
    const modifiedAt = (await stat(file).catch(() => null))?.mtimeMs;
    const persona = personaFromMarkdown(text, { name: entry.name, file, modifiedAt });
    // Disk shadows a builtin of the same name completely — that is how a
    // builtin gets edited: write your own version over it.
    if (persona) byName.set(persona.name, persona);
  }
  return sortRoster([...byName.values()]);
}

function sortRoster(list: PersonaDef[]): PersonaDef[] {
  return list.sort((a, b) => a.label.localeCompare(b.label));
}

export async function readPersona(name: string, home?: string): Promise<PersonaDef | null> {
  const slug = personaSlug(name);
  if (!slug) return null;
  return (await listPersonas(home)).find((p) => p.name === slug) ?? null;
}

/** Write (create or overwrite) a persona on disk. Returns the stored definition. */
export async function writePersona(
  input: Partial<Omit<PersonaDef, "source" | "file" | "modifiedAt">> & { name: string },
  home?: string,
): Promise<PersonaDef> {
  const slug = personaSlug(input.name);
  if (!slug) throw new Error("persona name must contain at least one letter or digit");
  const { fileFor } = rosterPaths(home);
  const file = fileFor(slug);
  const body = (input.body ?? "").trim();
  if (!body) throw new Error(`persona "${slug}" needs a body — the body IS the persona`);

  const md = personaToMarkdown({
    name: slug,
    label: input.label || titleCase(slug),
    description: input.description || "A local persona.",
    body,
    greeting: input.greeting ?? "",
    triggers: (input.triggers ?? []).map((t) => t.toLowerCase()),
    tools: input.tools ?? [],
    glyph: input.glyph || "helm",
    tone: input.tone && TONES.has(input.tone) ? input.tone : "ivory",
    autonomy: input.autonomy && AUTONOMIES.has(input.autonomy) ? input.autonomy : "suggest",
    model: input.model,
    effort: input.effort,
    maxTurns: input.maxTurns,
  });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, md);
  const stored = personaFromMarkdown(md, { name: slug, file, modifiedAt: Date.now() });
  if (!stored) throw new Error(`failed to re-read persona "${slug}" after writing`);
  return stored;
}

/** Delete a disk persona. A builtin of the same name becomes visible again. */
export async function deletePersona(name: string, home?: string): Promise<boolean> {
  const slug = personaSlug(name);
  if (!slug) return false;
  const { rosterDir } = rosterPaths(home);
  const dir = path.join(rosterDir, slug);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ─── Trigger matching ──────────────────────────────────────────────────
//
// Deliberately NOT wired to modelRouter.classifyLane(). That classifier exists
// to pick a model for one of four fixed lanes; its vocabulary is tuned for that
// and is broad enough that the word "website" reads as coding. Personas are an
// open set with their own vocabularies, so they get their own matcher — and a
// persona that matches must ANNOUNCE itself, because a silent behaviour change
// keyed to fuzzy keywords is exactly the kind of bug that hides for months.

export interface PersonaMatch {
  persona: PersonaDef;
  /** Trigger phrases that fired, for display: "matched: research, trade-off". */
  hits: string[];
  score: number;
}

/**
 * Score the roster against a user message. Pure and offline — no model call, so
 * the desktop can run it as the owner types.
 *
 * Only `auto` and `suggest` personas are considered; `manual` ones never match.
 * A longer trigger phrase outscores a short one, because "look into" is far
 * more intentional than "fix" appearing somewhere in a paragraph.
 */
export function matchPersonas(text: string, roster: readonly PersonaDef[]): PersonaMatch[] {
  const haystack = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  if (haystack.trim().length < 3) return [];
  const out: PersonaMatch[] = [];
  for (const persona of roster) {
    if (persona.autonomy === "manual") continue;
    const hits: string[] = [];
    let score = 0;
    for (const trigger of persona.triggers) {
      if (!trigger) continue;
      // Word-boundary-ish containment: a trigger must start at a word edge so
      // "fix" doesn't fire inside "prefix" or "suffix".
      const idx = haystack.indexOf(trigger);
      if (idx < 0) continue;
      const before = haystack[idx - 1] ?? " ";
      if (/[a-z0-9]/.test(before)) continue;
      hits.push(trigger);
      score += 1 + trigger.length / 20;
    }
    if (hits.length === 0) continue;
    // An explicit name-drop is decisive: "ask Aegis to look at this".
    if (haystack.includes(` ${persona.name} `) || haystack.includes(` ${persona.label.toLowerCase()} `)) score += 10;
    out.push({ persona, hits, score });
  }
  return out.sort((a, b) => b.score - a.score || a.persona.label.localeCompare(b.persona.label));
}

/**
 * The single persona that should take the wheel for this message, or null.
 * Requires a clear winner: a near-tie means the intent is genuinely ambiguous,
 * and guessing would be worse than staying as Ares.
 */
export function bestPersonaFor(text: string, roster: readonly PersonaDef[]): PersonaMatch | null {
  const matches = matchPersonas(text, roster);
  if (matches.length === 0) return null;
  const [top, next] = matches;
  if (next && top.score - next.score < 0.5) return null;
  return top;
}

// ─── System-prompt layer ───────────────────────────────────────────────

/**
 * Render the adopted persona as a system-prompt section.
 *
 * The caller MUST place this above the sealed core (see composeAgentSystemPrompt).
 * The wording is chosen to be additive: a persona narrows focus and colours
 * voice, and is told explicitly that it does not relax the standards beneath it
 * — otherwise "you are a friendly helper" becomes a lever for skipping proof.
 */
export function renderPersonaLayer(persona: PersonaDef, agentName = "Ares"): string {
  const lines = [
    `# Active persona — ${persona.label}`,
    "",
    `You are currently working as **${persona.label}**: ${persona.description}`,
    "",
    persona.body.trim(),
    "",
    `You are still ${agentName}. ${persona.label} is the expertise and voice you are wearing right now, not a different entity and not a new set of rules — every standard below this section still binds you, especially about verifying your work and reporting failure plainly. If the owner asks you to drop the persona, do it immediately and without argument.`,
  ];
  return lines.join("\n");
}
