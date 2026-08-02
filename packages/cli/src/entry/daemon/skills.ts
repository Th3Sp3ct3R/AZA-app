// Skill discovery for the daemon's skills_list command: SKILL.md frontmatter
// parsing, surface validation, and capability inference. daemon.ts re-exports
// parseSurfaces + inferSkillProvides (compiled dist tests import them from
// dist/entry/daemon.js).

import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { aresAgentHome } from "@ares/agent";
import { loadUiSettings } from "../../uiSettings.js";

/** A UI surface a skill contributes — a button (and, later, toggles/panels)
 *  that the app renders in the active-skills tray. Clicking it invokes the
 *  skill itself with `input` (the whole security model: a surface can only run
 *  its own skill). */
export interface SkillSurface {
  id: string;
  label: string;
  icon?: string;
  kind?: "button" | "toggle";
  /** JSON passed to the skill's handler when the surface is activated. */
  input?: unknown;
  /** Optional hint shown on hover. */
  hint?: string;
}

export interface DaemonSkillInfo {
  name: string;
  description: string;
  status: string;
  category: string;
  enabled: boolean;
  /** Capabilities this skill supplies (e.g. ["tts"]) — Ares routes the matching
   *  built-in through the toggled-on provider skill instead. */
  provides: string[];
  /** UI buttons this skill contributes to the active-skills tray. */
  surfaces: SkillSurface[];
  /** Whether this skill has executable code, versus prompt/docs only. */
  runnable: boolean;
  modifiedAt?: number;
}

/** Parse a `surfaces:` value (JSON array) into validated SkillSurface[]. Tolerant:
 *  a malformed value yields no surfaces rather than breaking the whole list. */
export function parseSurfaces(raw: string): SkillSurface[] {
  if (!raw || !raw.trim().startsWith("[")) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: SkillSurface[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const id = typeof s.id === "string" ? s.id : "";
    const label = typeof s.label === "string" ? s.label : "";
    if (!id || !label) continue;
    out.push({
      id,
      label,
      icon: typeof s.icon === "string" ? s.icon : undefined,
      kind: s.kind === "toggle" ? "toggle" : "button",
      input: s.input,
      hint: typeof s.hint === "string" ? s.hint : undefined,
    });
    if (out.length >= 12) break; // a tray, not a dashboard
  }
  return out;
}

export function inferSkillProvides(entryName: string, skillMd: string, surfaces: SkillSurface[], declared: string[]): string[] {
  const provides = new Set(declared.map((s) => s.trim()).filter(Boolean));
  const surfaceProvidesTts = surfaces.some((surface) => {
    const input = surface.input;
    return !!input && typeof input === "object" && (input as Record<string, unknown>).op === "tts";
  });
  const bodyClaimsTts =
    /\bprovides\s+(?:the\s+)?['"`]?tts['"`]?\s+capability\b/i.test(skillMd) ||
    /\btext[- ]to[- ]speech\b/i.test(skillMd) ||
    // Known voice engines named in the manifest are as clear a signal as any.
    /\b(piper|kokoro|elevenlabs|coqui)\b/i.test(skillMd);
  // "tts" anywhere in the skill's NAME (piper_tts, tts-eleven, my_tts…) — users
  // name their voice skills exactly this way and expect them to just be used.
  const nameSignalsTts = /(^|[_-])tts([_-]|$)/i.test(entryName);

  // A hand-authored voice provider should not fail silently because its
  // frontmatter omitted one line. The explicit `provides:` field still wins,
  // but a tts-ish name, a TTS surface, or a clear manifest body claim are
  // enough for the desktop to route speech through the provider.
  if (!provides.has("tts") && (nameSignalsTts || surfaceProvidesTts || bodyClaimsTts)) {
    provides.add("tts");
  }
  // Same courtesy for speech-to-text providers (whisper.cpp, Deepgram, …):
  // a transcribe surface, an stt name, or a clear body claim registers them.
  const surfaceProvidesStt = surfaces.some((surface) => {
    const input = surface.input;
    return !!input && typeof input === "object" && (input as Record<string, unknown>).op === "transcribe";
  });
  const bodyClaimsStt =
    /\bprovides\s+(?:the\s+)?['"`]?stt['"`]?\s+capability\b/i.test(skillMd) ||
    /\bspeech[- ]to[- ]text\b/i.test(skillMd);
  if (!provides.has("stt") && (entryName === "stt" || surfaceProvidesStt || bodyClaimsStt)) {
    provides.add("stt");
  }
  return [...provides];
}

/** List skills under ~/.ares/skills, parsing SKILL.md frontmatter + enabled set. */
export async function daemonSkillsList(home: string): Promise<DaemonSkillInfo[]> {
  const settings = await loadUiSettings();
  const disabled = new Set(settings.disabledSkills ?? []);
  const skillsDir = path.join(aresAgentHome(home), "skills");
  let entries: import("node:fs").Dirent[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: DaemonSkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const md = path.join(skillsDir, entry.name, "SKILL.md");
    const text = await readFile(md, "utf8").catch(() => "");
    if (!text) continue;
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const field = (key: string) => fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
    // Multi-line frontmatter tolerance: authors write normal YAML —
    //   provides:
    //     - tts
    // or a surfaces JSON array spread over lines. Capture everything from the
    // key to the next top-level key and flatten it, so those parse instead of
    // silently yielding nothing (the old reader was strictly single-line).
    const fieldBlock = (key: string) => {
      const lines = (fm?.[1] ?? "").split("\n");
      const start = lines.findIndex((l) => l.startsWith(`${key}:`));
      if (start < 0) return "";
      const out: string[] = [lines[start].slice(key.length + 1)];
      for (let i = start + 1; i < lines.length; i++) {
        if (/^\S/.test(lines[i])) break; // next top-level key
        out.push(lines[i]);
      }
      return out.join("\n").trim();
    };
    const listField = (key: string) => {
      const inline = field(key);
      if (inline && !inline.startsWith("-")) return inline.split(",").map((s) => s.trim()).filter(Boolean);
      const block = fieldBlock(key);
      const items = [...block.matchAll(/^\s*-\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      return items.length > 0 ? items : inline.split(",").map((s) => s.trim()).filter(Boolean);
    };
    const declaredProvides = listField("provides");
    let surfaces = parseSurfaces(field("surfaces"));
    if (surfaces.length === 0) {
      const block = fieldBlock("surfaces").split("\n").map((l) => l.trim()).join(" ").trim();
      if (block.startsWith("[")) surfaces = parseSurfaces(block);
    }
    if (surfaces.length === 0) {
      const sj = await readFile(path.join(skillsDir, entry.name, "surfaces.json"), "utf8").catch(() => "");
      if (sj) surfaces = parseSurfaces(sj);
    }
    const provides = inferSkillProvides(entry.name, text, surfaces, declaredProvides);
    const handlerPath = path.join(skillsDir, entry.name, "handler.js");
    const handlerStat = await stat(handlerPath).catch(() => null);
    const manifestStat = await stat(md).catch(() => null);
    skills.push({
      name: entry.name,
      description: field("description") || "Local skill.",
      status: field("status") || "ready",
      category: field("category") || "general",
      enabled: !disabled.has(entry.name),
      provides,
      surfaces,
      runnable: !!handlerStat,
      modifiedAt: Math.max(handlerStat?.mtimeMs ?? 0, manifestStat?.mtimeMs ?? 0) || undefined,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
