import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { aresHome } from "./providers/openaiAuth.js";
import {
  REPOSITORY_INSTRUCTION_FILES,
  type RepositoryInstructionClaim,
} from "./repositoryInstructions.js";

export type StartupReminderSource = "memory" | "instructions";

export interface StartupReminder {
  text: string;
  source: StartupReminderSource;
  /** Canonical files whose contents this reminder already put in the Session's
   * model context. QueryEngine claims them before path-sensitive discovery. */
  instructionClaims?: RepositoryInstructionClaim[];
}

/** Project instruction files (ARES.md/AGENTS.md/CLAUDE.md) are rules the OWNER
 *  wrote and expects honored in full — they earn a generous budget. */
const MAX_INSTRUCTION_CHARS = 24_000;

/**
 * Memory gets a FAR tighter budget than instructions, and the difference is
 * the whole point.
 *
 * Field evidence (2026-08-02 session sweep): memory.md reached 24,112 chars and
 * was injected verbatim at the head of every session — ~6k tokens spent before
 * the owner's message was even read. Measured against the model's own output,
 * reminders ran as high as 10.5:1, and `memory` was the dominant source by an
 * order of magnitude over every other reminder channel.
 *
 * Curated long-term memory that cannot fit in this budget is not curated. If
 * it overflows, the fix is consolidation (`ares mind consolidate`), never a
 * bigger context bite.
 */
const MAX_MEMORY_CHARS = 4_000;

export async function loadStartupReminders(workspace: string): Promise<StartupReminder[]> {
  const reminders: StartupReminder[] = [];
  reminders.push(...(await loadMemoryReminders(workspace)));
  reminders.push(...(await loadInstructionReminders(workspace)));
  return reminders;
}

export async function loadMemoryReminders(workspace: string): Promise<StartupReminder[]> {
  const files = [
    { label: "global memory", file: path.join(aresHome(), "memory.md") },
    { label: "project memory", file: path.join(workspace, ".ares", "memory.md") },
  ];
  const reminders: StartupReminder[] = [];
  for (const entry of files) {
    const text = await readSmallText(entry.file, MAX_MEMORY_CHARS);
    if (!text) continue;
    reminders.push({
      source: "memory",
      text: `Loaded ${entry.label} from ${entry.file}:\n\n${text}`,
    });
  }
  return reminders;
}

export async function loadInstructionReminders(workspace: string): Promise<StartupReminder[]> {
  const reminders: StartupReminder[] = [];
  for (const dir of ancestorDirs(path.resolve(workspace))) {
    for (const name of REPOSITORY_INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      const text = await readSmallText(file, MAX_INSTRUCTION_CHARS);
      if (!text) continue;
      const contentHash = await fs.readFile(file)
        .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
        .catch(() => null);
      if (!contentHash) continue;
      reminders.push({
        source: "instructions",
        text: `Loaded project instructions from ${file} [sha256:${contentHash}]:\n\n${text}`,
        instructionClaims: [{ path: path.resolve(file), contentHash }],
      });
    }
  }
  return reminders;
}

async function readSmallText(file: string, maxChars: number): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) return null;
    const text = await fs.readFile(file, "utf8");
    if (text.length <= maxChars) return text;
    // Keep the HEAD: curated files put their durable facts first, and a
    // truncation notice that names the consolidation command turns an
    // invisible context bite into an actionable one.
    return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted — this file is too large to inject in full. Run \`ares mind consolidate\` to distil it.]`;
  } catch {
    return null;
  }
}

function ancestorDirs(workspace: string): string[] {
  const dirs: string[] = [];
  let current = path.parse(workspace).root;
  const parts = path.relative(current, workspace).split(path.sep).filter(Boolean);
  dirs.push(current);
  for (const part of parts) {
    current = path.join(current, part);
    dirs.push(current);
  }
  return dirs;
}
