// Edit — string replacement in a file, resilient to line-ending drift.
//
// Rules (matching Claude Code's Edit semantics):
//   - File must have been Read in this session.
//   - old_string must appear exactly once unless replace_all is true.
//   - File mtime must match the last Read stamp (no race with disk edits).
//
// Matching is layered because models reliably reproduce file text with LF line
// endings even when the file on disk is CRLF (the classic Windows edit-killer),
// and often drop trailing whitespace:
//   1. exact match in EOL-normalized space (covers both exact and CRLF-vs-LF)
//   2. trailing-whitespace-insensitive line-block match (single occurrence only)
//   3. diff-anchor / fuzzy match: anchor on the first & last non-blank lines of
//      old_string (the most stable lines under line-shift + reflow drift), then
//      verify the interior modulo leading/trailing whitespace and blank lines. A
//      unique anchored region is replaced; MULTIPLE candidates fail loudly with
//      their line numbers rather than guessing.
// The file's dominant EOL style is preserved on write.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, contentHash, pathInputProblem, resolveWorkspacePath, toolError, zPath } from "./_shared.js";
import type { FileReadStamp } from "./_shared.js";

// A post-write stamp carries `writtenNotRead` so Read's re-read guard does a
// real re-read (the model wrote these bytes but never saw the full file). The
// flag isn't on the shared FileReadStamp type — it rides as an optional runtime
// extension so this package needn't widen _shared.ts.
type WrittenStamp = FileReadStamp & { writtenNotRead?: boolean };

const editHunk = z
  .object({
    old_string: z.string().describe("Exact text to replace. Must be unique unless replace_all."),
    new_string: z.string().describe("Replacement text. Must differ from old_string."),
    replace_all: z.boolean().default(false).describe("If true, replace every occurrence of this hunk."),
  })
  .strict();

const inputSchema = z
  .object({
    file_path: zPath,
    // Single-edit mode (omit when using `edits`).
    old_string: z.string().optional().describe("Single-edit mode: exact text to replace. Omit when using `edits`."),
    new_string: z.string().optional().describe("Single-edit mode: replacement text."),
    replace_all: z.boolean().default(false).describe("Single-edit mode: replace every occurrence."),
    // Batch mode.
    edits: z
      .array(editHunk)
      .optional()
      .describe(
        "Batch mode: multiple edits applied ATOMICALLY and in order to this ONE file. When set, the top-level old_string/new_string are ignored. All-or-nothing — if ANY hunk fails to match, NOTHING is written. Prefer this over several separate Edit calls for multi-site changes in the same file.",
      ),
  })
  .strict();

type EditInput = z.infer<typeof inputSchema>;

/** Normalize either mode into an ordered list of hunks. */
function editHunks(i: EditInput): Array<{ old_string: string; new_string: string; replace_all: boolean }> {
  if (Array.isArray(i.edits) && i.edits.length > 0) {
    return i.edits.map((h) => ({ old_string: h.old_string, new_string: h.new_string, replace_all: h.replace_all }));
  }
  return [{ old_string: i.old_string ?? "", new_string: i.new_string ?? "", replace_all: i.replace_all }];
}

export interface EditOutput {
  path: string;
  replacements: number;
  /** Which matching layer landed the edit: "exact" | "whitespace" | "anchor". */
  matchedBy: string;
  /** cat -n style excerpt of each edited region WITH a few lines of surrounding
   *  context, so the model can verify the change landed without a follow-up Read
   *  (which would only re-read the file it just wrote). */
  diff: string;
}

export const EditTool = buildTool({
  name: "Edit",
  description:
    "Replace exact text in a file (requires prior Read; tolerates CRLF/LF + trailing-whitespace drift). Single edit: old_string/new_string. Multi-site: pass `edits` — an ATOMIC, all-or-nothing batch applied in order (use this instead of many separate Edit calls on one file). Fails if an old_string is non-unique (set replace_all). Pick the SMALLEST old_string that is still unique — usually 2-4 adjacent lines with a distinctive token; over-long anchors are brittle to whitespace/edits, and single-line anchors are often non-unique.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Editing ${path.basename(i.file_path)}`,

  // Cheap, pure pre-checks (run before permission/exec), per hunk for both modes:
  // a missing mode, an empty old_string, or a no-op identical edit are common
  // model mistakes that would otherwise fail deep in matching. Catch them early
  // with a clear, correctable message.
  async validateInput(i, ctx) {
    const pathProblem = pathInputProblem(i.file_path, ctx?.workspace);
    if (pathProblem) return { ok: false, message: `file_path: ${pathProblem}` };
    const usingBatch = Array.isArray(i.edits) && i.edits.length > 0;
    if (!usingBatch && (i.old_string === undefined || i.new_string === undefined)) {
      return {
        ok: false,
        message: "Provide both old_string and new_string for a single edit, or an `edits` array for an atomic batch.",
      };
    }
    const hunks = editHunks(i);
    for (let idx = 0; idx < hunks.length; idx++) {
      const where = hunks.length > 1 ? ` (edit ${idx + 1})` : "";
      if (hunks[idx].old_string === "") {
        return {
          ok: false,
          message: `old_string is empty${where}. Provide the exact existing text to replace, or use Write to create/replace the whole file.`,
        };
      }
      if (hunks[idx].old_string === hunks[idx].new_string) {
        return { ok: false, message: `old_string and new_string are identical${where} — the edit would be a no-op.` };
      }
      if (looksLineNumberPrefixed(hunks[idx].old_string)) {
        return {
          ok: false,
          message: `old_string${where} still carries Read's line-number prefixes ("   12\\t…") — copy only the text AFTER the tab on each line.`,
        };
      }
    }
    return { ok: true };
  },

  async checkPermissions(i, ctx) {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    // Guard the identical check on single mode (old_string defined) — in batch
    // mode both are undefined and this must not fire.
    if (i.old_string !== undefined && i.old_string === i.new_string) {
      return { kind: "deny", reason: "old_string and new_string are identical" };
    }
    if (!ctx.fileReadStamps.has(filePath)) {
      return { kind: "deny", reason: `Read ${filePath} before editing it.` };
    }
    return { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: EditOutput; touchedFiles: string[]; display: string }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    const stamp = ctx.fileReadStamps.get(filePath);
    if (!stamp) throw new Error(`${filePath}: missing read stamp`);

    const content = await fs.readFile(filePath, "utf8");
    // Staleness check (C2): the content hash is exact and immune to mtime
    // granularity races. Fall back to mtime only for stamps written before the
    // hash existed (resumed sessions / older rollouts).
    if (stamp.hash !== undefined) {
      if (contentHash(content) !== stamp.hash) {
        throw toolError(
          `${filePath} was modified on disk since the last Read. Re-Read and retry.`,
        );
      }
    } else {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > stamp.mtimeMs + 5) {
        throw toolError(
          `${filePath} was modified on disk since the last Read. Re-Read and retry.`,
        );
      }
    }
    // Atomic batch: apply every hunk in order to an in-memory working copy.
    // Only write once ALL hunks resolve — if any fails the file is untouched, so
    // a multi-site edit can never half-apply (the classic "edit 2's text is gone
    // after edit 1" failure becomes a clean, recoverable error instead).
    const hunks = editHunks(i);
    let working = content;
    let totalReplacements = 0;
    const matchedBys = new Set<string>();
    for (let idx = 0; idx < hunks.length; idx++) {
      const h = hunks[idx];
      const result = replaceResilient(working, h.old_string, h.new_string, h.replace_all);
      if (!result.ok) {
        const where = hunks.length > 1 ? ` (edit ${idx + 1} of ${hunks.length})` : "";
        const batchNote = hunks.length > 1 ? " No edits were applied — the batch is all-or-nothing." : "";
        if (result.reason === "not-found") {
          // Make the dead end ACTIONABLE: name the indentation-only miss when
          // that's what happened, show the closest near-miss so the model can
          // re-copy without a full re-Read, and give the explicit escape hatch.
          const hint = nearMissHint(working, h.old_string);
          throw toolError(
            `old_string not found in ${filePath}${where} (tried exact, whitespace-tolerant, and diff-anchor matching). ` +
              `Re-Read the file and copy the text exactly as it appears, without line-number prefixes.` +
              `${hint ? `\n${hint}` : ""}${batchNote} ` +
              `If the target drifted too far, use ApplyIntent with a concise instruction + sketch instead of retrying Edit.`,
          );
        }
        if (result.reason === "anchor-ambiguous") {
          throw toolError(
            `old_string is ambiguous in ${filePath}${where}: the diff-anchor matcher found ${result.lines.length} regions ` +
              `sharing its first/last lines (near line${result.lines.length === 1 ? "" : "s"} ${result.lines.join(", ")}). ` +
              `Add more surrounding context so the target is unique — the edit was NOT applied to avoid changing the wrong place.${batchNote}`,
          );
        }
        throw toolError(
          `old_string is not unique in ${filePath}${where} (${result.occurrences} matches). Provide more context or set replace_all to true.${batchNote}`,
        );
      }
      working = result.text;
      totalReplacements += result.replacements;
      matchedBys.add(result.matchedBy);
    }

    await fs.writeFile(filePath, working, "utf8");
    const newStat = await fs.stat(filePath);
    // Post-write readback (cloud-sync folders can report success yet persist
    // an empty/partial file — see safeOverwrite's identical guard).
    if (newStat.size !== Buffer.byteLength(working, "utf8")) {
      const readback = await fs.readFile(filePath, "utf8").catch(() => null);
      if (readback !== working) {
        throw new Error(
          `Edit: post-write verification failed for ${filePath} — the file on disk does not match what was written (${newStat.size} bytes vs ${Buffer.byteLength(working, "utf8")} expected). The filesystem (cloud-sync folder?) did not persist the content; retry the edit.`,
        );
      }
    }
    // Stamp the WRITE, not a read: keep the hash/size current so a follow-up Edit
    // in the same turn passes read-before-write + staleness, but mark it
    // writtenNotRead so a whole-file Read still does a REAL read — the model
    // wrote these bytes but never saw the full post-edit file.
    const writtenStamp: WrittenStamp = {
      mtimeMs: newStat.mtimeMs,
      size: newStat.size,
      hash: contentHash(working),
      lines: countLines(working),
      writtenNotRead: true,
    };
    ctx.fileReadStamps.set(filePath, writtenStamp);

    const matchedBy = [...matchedBys].join(",");
    const note = matchedBy === "exact" ? "" : ` [matched via ${matchedBy}]`;
    const across = hunks.length > 1 ? ` across ${hunks.length} edits` : "";
    // Return the edited region(s) with surrounding context so the model can
    // verify the change from the tool result alone (like Claude Code's Edit),
    // instead of issuing a follow-up Read that would only re-read what it wrote.
    const diff = editedExcerpt(content, working);
    return {
      output: { path: filePath, replacements: totalReplacements, matchedBy, diff },
      touchedFiles: [filePath],
      display: `Edited ${filePath} (${totalReplacements} replacement${totalReplacements === 1 ? "" : "s"}${across})${note}${diff ? `\n${diff}` : ""}`,
    };
  },
});

type ReplaceResult =
  | { ok: true; text: string; replacements: number; matchedBy: "exact" | "whitespace" | "anchor" | "normalized" }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "not-unique"; occurrences: number }
  // Anchor tier found several regions whose first/last lines match — refuse to
  // guess. `lines` are 1-based start line numbers of each candidate region.
  | { ok: false; reason: "anchor-ambiguous"; lines: number[] };

/**
 * Layered replacement. All matching happens in LF-normalized space so CRLF
 * files and LF-quoting models agree; the file's dominant EOL is re-applied to
 * the final text. Mixed-EOL files come out consistently in their dominant
 * style — an acceptable trade for edits that actually land.
 */
export function replaceResilient(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplaceResult {
  const eol = dominantEol(content);
  const haystack = toLf(content);
  const needle = toLf(oldString);
  const replacement = toLf(newString);

  // Layer 1: exact (in normalized space — equals raw exact for LF files,
  // and transparently fixes the CRLF-vs-LF mismatch).
  const occurrences = countOccurrences(haystack, needle);
  if (occurrences > 0) {
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, reason: "not-unique", occurrences };
    }
    const text = replaceAll
      ? haystack.split(needle).join(replacement)
      : haystack.replace(needle, replacement);
    return {
      ok: true,
      text: fromLf(text, eol),
      replacements: replaceAll ? occurrences : 1,
      matchedBy: "exact",
    };
  }

  // Layer 2: line-block match ignoring trailing whitespace on each line.
  // Only safe for a single unambiguous occurrence.
  const fuzzy = fuzzyLineReplace(haystack, needle, replacement);
  if (fuzzy.kind === "replaced") {
    return { ok: true, text: fromLf(fuzzy.text, eol), replacements: 1, matchedBy: "whitespace" };
  }
  if (fuzzy.kind === "ambiguous") {
    return { ok: false, reason: "not-unique", occurrences: fuzzy.matches };
  }

  // Layer 3: diff-anchor / fuzzy match. Anchor on the first & last non-blank
  // lines of old_string (the lines a model reproduces most faithfully), then
  // verify the interior modulo leading/trailing whitespace and blank lines. Only
  // ever replaces a UNIQUE anchored region; multiple candidates fail loudly.
  const anchored = anchorReplace(haystack, needle, replacement);
  if (anchored.kind === "replaced") {
    return { ok: true, text: fromLf(anchored.text, eol), replacements: 1, matchedBy: "anchor" };
  }
  if (anchored.kind === "ambiguous") {
    return { ok: false, reason: "anchor-ambiguous", lines: anchored.lines };
  }

  // Layer 4: canonical match — the two remaining burn-a-turn classes. (a) The
  // model reproduced curly quotes/dashes/NBSP/zero-width chars imperfectly
  // (unicode drift); (b) it guessed the block's indentation wrong by a uniform
  // amount (incl. SINGLE-line targets, which layers 2-3 can't rescue). Compare
  // per-line in canonical space (NFC + homoglyph fold + whitespace collapse),
  // require a UNIQUE window, require the indent delta be UNIFORM, then re-indent
  // new_string by that delta so the replacement lands at the file's real depth.
  const normalized = normalizedReplace(haystack, needle, replacement);
  if (normalized.kind === "replaced") {
    return { ok: true, text: fromLf(normalized.text, eol), replacements: 1, matchedBy: "normalized" };
  }
  if (normalized.kind === "ambiguous") {
    return { ok: false, reason: "not-unique", occurrences: normalized.matches };
  }
  return { ok: false, reason: "not-found" };
}

/** Fold the characters a model most often reproduces "close but not byte-equal":
 *  curly quotes → straight, en/em/horizontal dashes → '-', ellipsis → '...',
 *  zero-width chars → gone. NFC first so composed/decomposed accents agree. */
function homoglyphFold(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‒–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[​‌‍﻿]/g, "");
}

function normalizedReplace(
  content: string,
  oldString: string,
  newString: string,
): { kind: "replaced"; text: string } | { kind: "ambiguous"; matches: number } | { kind: "none" } {
  // Canonical per-line form. \s+ collapse also folds NBSP/thin spaces (JS \s
  // matches unicode spaces); homoglyphFold handles the rest.
  const canon = (line: string): string => homoglyphFold(line).trim().replace(/\s+/g, " ");
  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n");
  // Drop pure-blank edge lines from the needle (models pad blocks with them).
  while (oldLines.length > 0 && oldLines[0].trim() === "") oldLines.shift();
  while (oldLines.length > 0 && oldLines[oldLines.length - 1].trim() === "") oldLines.pop();
  if (oldLines.length === 0) return { kind: "none" };
  const oldCanon = oldLines.map(canon);
  if (oldCanon.every((l) => l === "")) return { kind: "none" };

  let matchIndex = -1;
  let matches = 0;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let hit = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (canon(contentLines[i + j]) !== oldCanon[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      matches++;
      matchIndex = i;
      if (matches > 1) return { kind: "ambiguous", matches };
    }
  }
  if (matches !== 1) return { kind: "none" };

  // Indent delta must be UNIFORM across non-blank lines — a canon match with
  // scattered indent differences means the file's structure differs from what
  // the model believes, and auto-replacing would plant mis-indented code.
  const leading = (s: string): number => s.length - s.trimStart().length;
  let delta: number | null = null;
  for (let j = 0; j < oldLines.length; j++) {
    if (oldLines[j].trim() === "") continue;
    const d = leading(contentLines[matchIndex + j]) - leading(oldLines[j]);
    if (delta === null) delta = d;
    else if (d !== delta) return { kind: "none" };
  }
  const shift = delta ?? 0;
  const reindented = newString.split("\n").map((line) => {
    if (line.trim() === "") return line;
    if (shift > 0) return " ".repeat(shift) + line;
    if (shift < 0) {
      const cut = Math.min(-shift, leading(line));
      return line.slice(cut);
    }
    return line;
  });

  const updated = [
    ...contentLines.slice(0, matchIndex),
    ...reindented,
    ...contentLines.slice(matchIndex + oldLines.length),
  ];
  return { kind: "replaced", text: updated.join("\n") };
}

/**
 * Diff-anchor replacement (Layer 3). When both exact and whitespace-tolerant
 * matching miss — typically because interior lines drifted (indentation reflow,
 * a blank line added/removed) or the block moved — we locate the target by its
 * two most stable lines: the first and last NON-BLANK lines of old_string.
 *
 * Algorithm:
 *   1. Reduce old_string to its "significant" lines: non-blank lines with
 *      leading+trailing whitespace collapsed. Need >= 2 to anchor safely (a
 *      single-line target is what the whitespace tier already handles; anchoring
 *      on one line is far too loose to be safe).
 *   2. Find every content line matching the first significant line (whitespace-
 *      insensitive). For each such start, scan forward for the first line
 *      matching the last significant line — that pair bounds a candidate region.
 *   3. Verify the candidate: its significant lines (blank lines dropped, inner
 *      whitespace normalized) must equal old_string's significant lines exactly,
 *      in order. This guards against two blocks that merely share end-lines.
 *   4. If exactly one region verifies, replace the WHOLE region (its literal
 *      lines, blanks included) with new_string. If two or more verify, return
 *      their start line numbers and refuse — the caller turns this into a
 *      "N candidates, add more context" error. Never guess.
 */
function anchorReplace(
  content: string,
  oldString: string,
  newString: string,
): { kind: "replaced"; text: string } | { kind: "ambiguous"; lines: number[] } | { kind: "none" } {
  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n");

  // Significant = non-blank, with interior whitespace normalized to single
  // spaces and edges trimmed. Two lines that differ only in indentation or run
  // of spaces are considered equal for anchoring.
  const sig = (line: string): string => line.trim().replace(/\s+/g, " ");
  const oldSig: string[] = [];
  for (const l of oldLines) {
    if (l.trim() !== "") oldSig.push(sig(l));
  }
  // Anchoring needs a first AND last line to bound a region. One significant
  // line is too loose to anchor on safely — decline and let it fall through to
  // "not-found" so the model re-reads.
  if (oldSig.length < 2) return { kind: "none" };

  const firstSig = oldSig[0];
  const lastSig = oldSig[oldSig.length - 1];

  // Candidate regions: each starts at a line matching firstSig and ends at the
  // NEXT line matching lastSig at or after the minimum possible span.
  const candidates: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() === "" || sig(contentLines[i]) !== firstSig) continue;
    // The region must be at least as long as the significant-line count (minus 1
    // for a 2-line block whose ends coincide only when oldSig.length === 2).
    const minEnd = i + oldSig.length - 1;
    for (let k = minEnd; k < contentLines.length; k++) {
      if (contentLines[k].trim() === "") continue;
      if (sig(contentLines[k]) === lastSig) {
        candidates.push({ start: i, end: k });
        break; // shortest region for this start; longer ones would over-capture
      }
    }
  }

  // Verify each candidate: significant lines within [start, end] must match
  // oldSig exactly (blank lines ignored, whitespace normalized).
  const verified: Array<{ start: number; end: number }> = [];
  for (const cand of candidates) {
    const regionSig: string[] = [];
    for (let k = cand.start; k <= cand.end; k++) {
      if (contentLines[k].trim() !== "") regionSig.push(sig(contentLines[k]));
    }
    if (regionSig.length === oldSig.length && regionSig.every((v, idx) => v === oldSig[idx])) {
      verified.push(cand);
    }
  }

  if (verified.length === 0) return { kind: "none" };
  if (verified.length > 1) {
    return { kind: "ambiguous", lines: verified.map((v) => v.start + 1) };
  }

  const { start, end } = verified[0];
  const updated = [
    ...contentLines.slice(0, start),
    ...newString.split("\n"),
    ...contentLines.slice(end + 1),
  ];
  return { kind: "replaced", text: updated.join("\n") };
}

function fuzzyLineReplace(
  content: string,
  oldString: string,
  newString: string,
): { kind: "replaced"; text: string } | { kind: "ambiguous"; matches: number } | { kind: "none" } {
  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n").map(stripTrailingWs);
  if (oldLines.length === 0 || (oldLines.length === 1 && oldLines[0] === "")) return { kind: "none" };

  let matchIndex = -1;
  let matches = 0;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let hit = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (stripTrailingWs(contentLines[i + j]) !== oldLines[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      matches++;
      matchIndex = i;
      if (matches > 1) return { kind: "ambiguous", matches };
    }
  }
  if (matches !== 1) return { kind: "none" };

  const updated = [
    ...contentLines.slice(0, matchIndex),
    ...newString.split("\n"),
    ...contentLines.slice(matchIndex + oldLines.length),
  ];
  return { kind: "replaced", text: updated.join("\n") };
}

function dominantEol(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function fromLf(text: string, eol: "\r\n" | "\n"): string {
  return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function stripTrailingWs(line: string): string {
  return line.replace(/[ \t\r]+$/, "");
}

/** Line count of a text blob (matches Read's `total = raw.split("\n").length`). */
function countLines(text: string): number {
  return text.split("\n").length;
}

/**
 * Build a bounded cat -n excerpt of the regions that changed between `before`
 * and `after`, with a few lines of surrounding context per hunk — so the model
 * can verify the edit landed straight from the tool result. Line numbers are
 * post-edit (what a subsequent Read would show). Whole-file rewrites are capped.
 */
function editedExcerpt(before: string, after: string): string {
  const CONTEXT = 3;
  const MAX_LINES = 60; // hard ceiling so a huge edit can't flood the result
  const a = toLf(before).split("\n");
  const b = toLf(after).split("\n");

  // Cheap common-prefix / common-suffix trim to localize the changed span(s).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  if (start === endB) return ""; // nothing visibly changed (e.g. pure EOL)

  const from = Math.max(0, start - CONTEXT);
  const to = Math.min(b.length, endB + CONTEXT);
  const lines = b.slice(from, to);
  const clipped = lines.length > MAX_LINES;
  const shown = clipped ? lines.slice(0, MAX_LINES) : lines;

  const body = shown
    .map((line, idx) => `${(from + idx + 1).toString().padStart(5, " ")}\t${line}`)
    .join("\n");
  return clipped ? `${body}\n     …\t[${lines.length - MAX_LINES} more changed lines]` : body;
}

/**
 * True when old_string still carries Read's `cat -n` line-number prefixes
 * ("   12\tcode") — the classic copy-paste burn. Every non-blank line must be
 * number+tab prefixed, and for multi-line blocks the numbers must be
 * CONSECUTIVE (so numeric TSV data can't false-positive).
 */
export function looksLineNumberPrefixed(oldString: string): boolean {
  const lines = toLf(oldString).split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return false;
  const nums: number[] = [];
  for (const line of lines) {
    const m = /^(\s*)(\d+)\t/.exec(line);
    if (!m) return false;
    // A single line needs the padded-number shape ("   12\t"), not just "0\t".
    if (lines.length === 1 && m[1].length === 0) return false;
    nums.push(Number(m[2]));
  }
  for (let k = 1; k < nums.length; k++) {
    if (nums[k] !== nums[k - 1] + 1) return false;
  }
  return true;
}

/**
 * Near-miss context for the "not found" dead end. Two cheap, line-based probes
 * over the LF-normalized content:
 *   1. indentation-only miss: a contiguous region equals old_string line-for-line
 *      once leading/trailing whitespace is stripped — say exactly that, with the
 *      line number (the classic single-line wrong-indent failure the anchor tier
 *      can't rescue).
 *   2. closest candidate: the content line with the best token overlap against
 *      old_string's first significant line, shown as a small cat -n excerpt.
 * Returns "" when nothing plausible is found.
 */
export function nearMissHint(content: string, oldString: string): string {
  const contentLines = toLf(content).split("\n");
  const needleLines = toLf(oldString).split("\n");
  const trimmed = needleLines.map((l) => l.trim());
  const n = needleLines.length;

  if (trimmed.some((l) => l !== "")) {
    const indentHits: number[] = [];
    for (let i = 0; i + n <= contentLines.length && indentHits.length < 4; i++) {
      let hit = true;
      for (let j = 0; j < n; j++) {
        if (contentLines[i + j].trim() !== trimmed[j]) {
          hit = false;
          break;
        }
      }
      if (hit) indentHits.push(i + 1);
    }
    if (indentHits.length > 0) {
      const also = indentHits.length > 1 ? ` (also at line${indentHits.length > 2 ? "s" : ""} ${indentHits.slice(1).join(", ")})` : "";
      return (
        `The same text DOES appear at line ${indentHits[0]}${also} — every line differs only in leading whitespace. ` +
        `Copy the indentation exactly as it appears in the file.`
      );
    }
  }

  const firstSig = trimmed.find((l) => l !== "");
  if (!firstSig) return "";
  const tokens = firstSig.split(/[^\w$]+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return "";
  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    if (line.trim() === "") continue;
    let score = 0;
    for (const t of tokens) if (line.includes(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  // Require a real overlap (more than half the tokens) before claiming a near miss.
  if (bestLine < 0 || bestScore * 2 <= tokens.length) return "";
  const from = Math.max(0, bestLine - 2);
  const to = Math.min(contentLines.length, bestLine + 3);
  const excerpt = contentLines
    .slice(from, to)
    .map((line, idx) => `${(from + idx + 1).toString().padStart(5, " ")}\t${line}`)
    .join("\n");
  return `Closest near-miss in the file is around line ${bestLine + 1}:\n${excerpt}`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
