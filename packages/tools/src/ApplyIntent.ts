// ApplyIntent — cheap whole-file edit materialization through APPLY slot.
//
// The model describes the intended change and supplies a sketch. When a
// sub-model is available, the APPLY slot converts that into final file
// content. Without a sub-model, Ares still supports full-file sketches so
// tests and offline use remain deterministic.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, contentHash, mutationInstructionBlock, mutationWorkspaceForPaths, pathInputProblem, resolveWorkspacePath, zPath } from "./_shared.js";
import type { FileReadStamp } from "./_shared.js";
import { assertSafeReplacement } from "./safeWrite.js";
import { WorkspaceMutationService, workspaceContentHash, type PostMutationFeedback } from "@ares/core";
import { appendMutationFeedback, collectMutationFeedback } from "./postMutationFeedback.js";

// Post-write stamp carries `writtenNotRead` so Read's re-read guard does a real
// read afterward — the model supplied a sketch, not the materialized file, so it
// never saw the full result. Rides as an optional runtime extension.
type WrittenStamp = FileReadStamp & { writtenNotRead?: boolean };

const inputSchema = z
  .object({
    file_path: zPath,
    instructions: z
      .string()
      .min(1)
      .describe("Plain-English edit intent. State behavior, constraints, and any invariants to preserve."),
    sketch: z
      .string()
      .min(1)
      .describe(
        "Either full final file content, or a concise sketch using `... existing code ...` markers. Marker sketches require an APPLY sub-model.",
      ),
    allow_full_replace: z
      .boolean()
      .optional()
      .describe(
        "Set true only when you intend to replace the ENTIRE file with much smaller content. Without it, a full-file sketch that collapses a substantial file is refused (it's almost always a fragment mistaken for the whole file).",
      ),
  })
  .strict();

export interface ApplyIntentOutput {
  path: string;
  bytesWritten: number;
  engine: "apply-slot" | "full-file-sketch";
  /** Where the prior contents were saved before this overwrite, if any. */
  backupPath?: string;
  /** Immediate formatter/type diagnostics, attributed to the committed SHA-256. */
  feedback?: PostMutationFeedback;
}

export const ApplyIntentTool = buildTool({
  name: "ApplyIntent",
  description:
    "Materialize a large or multi-line edit from intent + sketch. Requires prior Read. Prefer this over huge Edit payloads: pass concise instructions plus a sketch. If the sketch uses `... existing code ...`, Ares routes through the APPLY slot; full-file sketches work offline.",
  safety: "workspace-write",
  concurrency: "exclusive",
  providerHint: "apply",
  inputZod: inputSchema,
  activityDescription: (i) => `ApplyIntent ${path.basename(i.file_path)}`,

  // Semantic pre-checks: whitespace-only instructions/sketch pass zod's min(1)
  // but always fail downstream (an empty sketch would blank the file).
  async validateInput(i, ctx) {
    const pathProblem = pathInputProblem(i.file_path, ctx?.workspace);
    if (pathProblem) return { ok: false, message: `file_path: ${pathProblem}` };
    if (i.instructions.trim() === "") {
      return { ok: false, message: "instructions is blank — describe the intended change in one or two plain-English sentences." };
    }
    if (i.sketch.trim() === "") {
      return {
        ok: false,
        message: "sketch is blank — pass either the full final file content, or a concise sketch with `... existing code ...` markers around the changed parts.",
      };
    }
    return { ok: true };
  },

  async checkPermissions(i, ctx) {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    if (!ctx.fileReadStamps.has(filePath)) {
      return { kind: "deny", reason: `Read ${filePath} before applying an intent edit.` };
    }
    const instructionBlock = await mutationInstructionBlock(ctx, [filePath]);
    if (instructionBlock) return { kind: "deny", reason: instructionBlock };
    return { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: ApplyIntentOutput; touchedFiles: string[]; display: string }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    const stamp = ctx.fileReadStamps.get(filePath);
    if (!stamp) throw new Error(`${filePath}: missing read stamp`);

    const original = await fs.readFile(filePath, "utf8");
    // Staleness check mirrors Edit.ts: the content hash is exact and immune to
    // Windows mtime-granularity races. Fall back to mtime only for stamps
    // written before the hash existed (resumed sessions / older rollouts).
    if (stamp.hash !== undefined) {
      if (contentHash(original) !== stamp.hash) {
        throw new Error(`${filePath} was modified on disk since the last Read. Re-Read and retry.`);
      }
    } else {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > stamp.mtimeMs + 5) {
        throw new Error(`${filePath} was modified on disk since the last Read. Re-Read and retry.`);
      }
    }
    const sketch = stripCodeFence(i.sketch);
    let finalContent: string;
    let engine: ApplyIntentOutput["engine"];

    if (hasExistingCodeMarker(sketch)) {
      if (ctx.subModel?.apply) {
        finalContent = stripCodeFence(
          await ctx.subModel.apply({
            file: filePath,
            original,
            instructions: i.instructions,
            sketch,
          }),
        );
        engine = "apply-slot";
      } else {
        // Offline fallback: no APPLY sub-model, but marker sketches must still
        // work or offline coding is degraded vs Edit (which has no such
        // dependency). Each `... existing code ...` marker is a span to KEEP
        // verbatim from the original; the literal segments between markers are
        // the model's new/edited text. We splice them deterministically by
        // anchoring each kept span to the original via the surrounding literals.
        const merged = applyMarkerSketch(original, sketch);
        if (!merged.ok) {
          throw new Error(
            `ApplyIntent could not deterministically apply the marker sketch offline (${merged.reason}). ` +
              `Provide full final file content in \`sketch\`, run with Ollama Cloud APPLY configured, or use Edit for a precise replacement.`,
          );
        }
        finalContent = merged.text;
        engine = "full-file-sketch";
      }
    } else {
      finalContent = sketch;
      engine = "full-file-sketch";
    }

    if (!finalContent.length) throw new Error("ApplyIntent produced empty output; refusing to overwrite file.");

    let written: { bytesWritten: number; backupPath?: string };
    let feedback: PostMutationFeedback | undefined;
    assertSafeReplacement({
      original,
      next: finalContent,
      label: "ApplyIntent",
      absPath: filePath,
      allowFullReplace: i.allow_full_replace,
    });
    const mutationWorkspace = await mutationWorkspaceForPaths(ctx.workspace, [filePath]);
    const receipt = await new WorkspaceMutationService(mutationWorkspace).apply(
      [{ kind: "update", path: filePath, content: finalContent, expectedHash: workspaceContentHash(original) }],
      { label: "ApplyIntent", transactionId: ctx.mutationTransactionId },
    );
    const operation = receipt.operations[0];
    written = {
      bytesWritten: Buffer.byteLength(finalContent, "utf8"),
      backupPath: operation && "backupPath" in operation ? operation.backupPath : undefined,
    };
    feedback = await collectMutationFeedback(mutationWorkspace, receipt);
    const newStat = await fs.stat(filePath);
    const writtenStamp: WrittenStamp = {
      mtimeMs: newStat.mtimeMs,
      size: newStat.size,
      hash: contentHash(finalContent),
      lines: finalContent.split("\n").length,
      writtenNotRead: true,
    };
    ctx.fileReadStamps.set(filePath, writtenStamp);

    return {
      output: { path: filePath, bytesWritten: written.bytesWritten, engine, backupPath: written.backupPath, feedback },
      touchedFiles: [filePath],
      display: appendMutationFeedback(`Applied intent to ${filePath} via ${engine}`, feedback),
    };
  },
});

function stripCodeFence(input: string): string {
  const s = input.replace(/\r\n/g, "\n").trim();
  const match = s.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : s;
}

function hasExistingCodeMarker(input: string): boolean {
  return /(^|\n)\s*(\/\/|#|<!--|\/\*)?\s*\.{3}\s*existing code\s*\.{3}\s*(-->| \*\/|\*\/)?\s*(\n|$)/i.test(input);
}

/** Matches a whole line that is just an `... existing code ...` marker. */
const MARKER_LINE = /^\s*(?:\/\/|#|<!--|\/\*)?\s*\.{3}\s*existing code\s*\.{3}\s*(?:-->|\*\/)?\s*$/i;

type MarkerApplyResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Deterministic, sub-model-free application of a `... existing code ...` marker
 * sketch. The sketch is a sequence of literal blocks (the model's new/edited code,
 * emitted verbatim) and marker lines (each meaning "keep whatever the original had
 * here"). Markers keep original spans bounded by ANCHORED literals — literal blocks
 * found verbatim in the original — or by the head/tail. This resolves insertions
 * and edits that keep a real anchor on the consumed side.
 *
 * Intentionally SAFE, not clever: when new code sits between a kept region and its
 * bounding anchor the kept span is ambiguous (the classic `marker / newBody /
 * marker` replace), so we bail and the caller surfaces a clear error pointing at
 * Edit (which locates the change precisely via `old_string`) — never guessing and
 * corrupting the file.
 */
function applyMarkerSketch(original: string, sketch: string): MarkerApplyResult {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const src = original.replace(/\r\n/g, "\n");

  // Tokenize the sketch into an ordered list of literal blocks and markers.
  type Token = { kind: "literal"; text: string } | { kind: "marker" };
  const tokens: Token[] = [];
  let current: string[] = [];
  const flushLiteral = () => {
    const text = current.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    if (text.length > 0) tokens.push({ kind: "literal", text });
    current = [];
  };
  for (const line of sketch.replace(/\r\n/g, "\n").split("\n")) {
    if (MARKER_LINE.test(line)) {
      flushLiteral();
      tokens.push({ kind: "marker" });
    } else {
      current.push(line);
    }
  }
  flushLiteral();

  // Collapse runs of consecutive markers (two adjacent "keep" gaps are one gap)
  // and drop them so we have a clean alternation to reason about.
  const compact: Token[] = [];
  for (const t of tokens) {
    if (t.kind === "marker" && compact[compact.length - 1]?.kind === "marker") continue;
    compact.push(t);
  }

  if (!compact.some((t) => t.kind === "literal")) return { ok: false, reason: "sketch is only markers" };
  if (!compact.some((t) => t.kind === "marker")) {
    return { ok: false, reason: "no `... existing code ...` markers — pass full file content instead" };
  }

  // Literal blocks are NEW content emitted verbatim; markers keep original spans.
  // A marker keeps the original from the last CONSUMED position (advanced only by
  // an ANCHORED literal — one found verbatim in the original — or the head) up to
  // the next anchored literal's start (or the tail). A literal not found in the
  // original is "new" and inserted inline WITHOUT consuming original. If new code
  // sits between a kept region and its bounding anchor, the kept region's extent is
  // ambiguous — we bail rather than guess (that's the SEARCH/REPLACE case Edit does
  // precisely with `old_string`). Insertions anchored to real code DO resolve.
  let out = "";
  let origPos = 0;
  let pendingKeepFrom = -1; // -1 = no kept region open; >=0 = keep starts here, end TBD
  for (const t of compact) {
    if (t.kind === "marker") {
      if (pendingKeepFrom === -1) pendingKeepFrom = origPos;
      continue;
    }
    const idx = src.indexOf(t.text, origPos);
    if (idx !== -1) {
      // Anchored: exists verbatim at/after the consumed position. Resolve any open
      // kept region up to this anchor, then emit the anchor and consume it.
      if (pendingKeepFrom !== -1) {
        out += src.slice(pendingKeepFrom, idx);
        pendingKeepFrom = -1;
      }
      out += t.text;
      origPos = idx + t.text.length;
    } else {
      // New content. We cannot place it relative to an unresolved kept region —
      // the original location it replaces is unknown. Fail SAFE, file untouched.
      if (pendingKeepFrom !== -1) {
        return { ok: false, reason: "new code between two kept regions can't be located in the original — use Edit for a precise replacement" };
      }
      out += t.text;
    }
  }
  // A trailing marker keeps the remainder of the original.
  if (pendingKeepFrom !== -1) out += src.slice(pendingKeepFrom);

  return { ok: true, text: eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out };
}
