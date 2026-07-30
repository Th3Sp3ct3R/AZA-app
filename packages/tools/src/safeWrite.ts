// safeWrite — the one chokepoint every destructive overwrite passes through.
//
// Two protections live here, and both exist because of a real incident: an
// ApplyIntent full-file sketch that was actually a fragment silently replaced a
// 1251-line file with 23 lines, and the file lived outside the workspace so the
// workspace checkpoint never captured it. Nothing stood between the fragment and
// the file. This module closes both holes:
//
//   1. A shrink guard that refuses to replace a substantial file with something
//      dramatically smaller unless the caller explicitly opts in. A fragment
//      can no longer masquerade as a full file.
//   2. A pre-write backup of the prior contents — taken for ANY existing file,
//      including ones outside the workspace — so every overwrite is recoverable
//      even when the checkpoint system (workspace-only) doesn't cover it.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface SafeOverwriteOptions {
  /** Workspace root — backups land under `<workspace>/.ares/backups`. */
  workspace: string;
  /** Absolute path being written. May be outside the workspace. */
  absPath: string;
  /** Final content to write. */
  content: string;
  /** Tool name, for the backup index and error text (e.g. "ApplyIntent"). */
  label: string;
  /** Caller's explicit opt-in to a catastrophic replacement. */
  allowFullReplace?: boolean;
}

export interface SafeOverwriteResult {
  bytesWritten: number;
  created: boolean;
  /** Absolute path of the saved prior contents, if the file already existed. */
  backupPath?: string;
}

/**
 * Guard + backup + write. Throws a self-correcting error if the write would
 * collapse a substantial file and `allowFullReplace` is not set. Otherwise it
 * backs up any prior contents before writing.
 */
export async function safeOverwrite(opts: SafeOverwriteOptions): Promise<SafeOverwriteResult> {
  const original = await fs.readFile(opts.absPath, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });

  if (original !== null) {
    const verdict = assessShrink(original, opts.content);
    if (verdict.catastrophic && !opts.allowFullReplace) {
      throw new Error(shrinkRefusal(opts.label, opts.absPath, verdict));
    }
  }

  let backupPath: string | undefined;
  if (original !== null) {
    backupPath = await backupFile(opts.workspace, opts.absPath, original, opts.label);
  }

  await fs.mkdir(path.dirname(opts.absPath), { recursive: true });
  await fs.writeFile(opts.absPath, opts.content, "utf8");
  const stat = await fs.stat(opts.absPath);

  // Post-write readback: writeFile resolving is NOT proof the bytes landed —
  // cloud-sync filesystems (OneDrive placeholders) have produced files that
  // read back EMPTY while the tool reported success, sending the agent down
  // "why is my scene blank" rabbit holes. Verify what's actually on disk.
  const expectedBytes = Buffer.byteLength(opts.content, "utf8");
  if (stat.size !== expectedBytes) {
    const readback = await fs.readFile(opts.absPath, "utf8").catch(() => null);
    if (readback !== opts.content) {
      throw new Error(
        `${opts.label}: post-write verification failed for ${opts.absPath} — expected ${expectedBytes} bytes but the file on disk has ${stat.size}. ` +
          `The filesystem (cloud-sync folder?) did not persist the content. Retry the write; if it keeps failing, work outside the synced folder.`,
      );
    }
  }

  return { bytesWritten: stat.size, created: original === null, backupPath };
}

export interface ShrinkVerdict {
  catastrophic: boolean;
  origBytes: number;
  nextBytes: number;
  origLines: number;
  nextLines: number;
  /** nextBytes / origBytes, 0..1 (1 when the original was empty). */
  ratio: number;
}

/**
 * Decide whether replacing `original` with `next` is a suspicious collapse.
 *
 * Fires only on substantial originals, and only on a large drop in BOTH bytes
 * and lines — or an extreme byte collapse (under 10% of the original) which
 * catches minified single-line files too. Tuned to stay quiet on ordinary
 * refactors (even ones that halve a file) and loud on fragment-as-full-file
 * mistakes, so it doesn't add friction to real work on large repos.
 */
export function assessShrink(original: string, next: string): ShrinkVerdict {
  const origBytes = Buffer.byteLength(original, "utf8");
  const nextBytes = Buffer.byteLength(next, "utf8");
  const origLines = lineCount(original);
  const nextLines = lineCount(next);
  const ratio = origBytes === 0 ? 1 : nextBytes / origBytes;

  const substantial = origLines >= 40 || origBytes >= 2000;
  const extremeCollapse = nextBytes < origBytes * 0.1;
  const largeShrink = nextBytes < origBytes * 0.34 && origLines - nextLines >= 25;
  const catastrophic = substantial && (extremeCollapse || largeShrink);

  return { catastrophic, origBytes, nextBytes, origLines, nextLines, ratio };
}

function shrinkRefusal(label: string, absPath: string, v: ShrinkVerdict): string {
  const pct = Math.round((1 - v.ratio) * 100);
  return (
    `${label}: refusing to replace ${absPath} (${v.origLines} lines, ${v.origBytes} B) ` +
    `with ${v.nextLines} lines (${v.nextBytes} B) — a ${pct}% shrink. ` +
    `This usually means the content is a fragment, not the whole file. ` +
    `To change part of the file use Edit, or include \`... existing code ...\` markers (APPLY sub-model). ` +
    `If you genuinely mean to replace the entire file, set allow_full_replace: true.`
  );
}

/**
 * Copy prior file contents into `<workspace>/.ares/backups/` and append a line
 * to the backup index. Returns the absolute backup path. Backups are kept for
 * out-of-workspace targets too — that's the case the checkpoint system misses.
 */
async function backupFile(
  workspace: string,
  absPath: string,
  contents: string,
  label: string,
): Promise<string> {
  const dir = path.join(path.resolve(workspace), ".ares", "backups");
  await fs.mkdir(dir, { recursive: true });

  const key = sha1(absPath).slice(0, 12);
  const stamp = fsTimestamp();
  const backupName = `${key}-${stamp}-${path.basename(absPath)}.bak`;
  const backupPath = path.join(dir, backupName);
  await fs.writeFile(backupPath, contents, "utf8");

  const entry = {
    ts: new Date().toISOString(),
    tool: label,
    original: absPath,
    backup: backupPath,
    bytes: Buffer.byteLength(contents, "utf8"),
  };
  await fs.appendFile(path.join(dir, "index.jsonl"), JSON.stringify(entry) + "\n", "utf8");

  return backupPath;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const normalized = text.replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.split("\n").length;
}

function fsTimestamp(): string {
  // ISO without characters that are illegal in filenames on Windows.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}
