// ApplyPatch — the native GPT/Codex editing dialect.
//
// The model supplies one compact patch. We parse and compute every resulting
// file in memory first, then hand the complete file-set to the core mutation
// transaction. A stale base, malformed hunk, conflicting destination, or failed
// write therefore cannot leave the first half of a multi-file patch applied.

import { promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  parsePatch,
  PatchParseError,
  WorkspaceMutationError,
  WorkspaceMutationService,
  workspaceContentHash,
  type UpdateFileChunk,
  type PostMutationFeedback,
  type WorkspaceMutationOperation,
  type WorkspaceMutationReceipt,
} from "@ares/core";
import { buildTool, contentHash, mutationInstructionBlock, mutationWorkspaceForPaths, resolveWorkspacePath, toolError } from "./_shared.js";
import { appendMutationFeedback, collectMutationFeedback } from "./postMutationFeedback.js";

const inputSchema = z
  .object({
    patch: z
      .string()
      .min(1)
      .describe("Complete patch text from '*** Begin Patch' through '*** End Patch'."),
  })
  .strict();

export interface ApplyPatchOutput {
  transactionId: string;
  receiptPath: string;
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  /** Immediate formatter/type diagnostics, attributed to the committed SHA-256. */
  feedback?: PostMutationFeedback;
}

export const ApplyPatchTool = buildTool({
  name: "ApplyPatch",
  description:
    "Apply one atomic, multi-file patch. Use *** Add File, *** Update File, optional *** Move to, and *** Delete File hunks between *** Begin Patch / *** End Patch. Paths are workspace-relative; absolute paths into another project directory are also accepted (same permission rules as Write/Edit). All hunks are validated before any project file changes; stale or ambiguous patches fail without partial edits.",
  safety: "workspace-write",
  concurrency: "exclusive",
  maxResultSizeChars: 24_000,
  inputZod: inputSchema,
  activityDescription: () => "Applying patch",

  async validateInput(input, ctx) {
    try {
      const parsed = parsePatch(input.patch);
      if (parsed.hunks.length === 0) {
        return { ok: false, message: "The patch is empty. Include at least one Add, Update, Delete, or Move hunk." };
      }
      for (const hunk of parsed.hunks) {
        const problem = patchPathProblem(ctx.workspace, hunk.path);
        if (problem) return { ok: false, message: `${hunk.kind} path: ${problem}` };
        if (hunk.kind === "update" && hunk.movePath) {
          const moveProblem = patchPathProblem(ctx.workspace, hunk.movePath);
          if (moveProblem) return { ok: false, message: `move destination: ${moveProblem}` };
        }
      }
      const instructionTargets = parsed.hunks.flatMap((hunk) => [
        path.resolve(ctx.workspace, hunk.path),
        ...(hunk.kind === "update" && hunk.movePath
          ? [path.resolve(ctx.workspace, hunk.movePath)]
          : []),
      ]);
      const instructionBlock = await mutationInstructionBlock(ctx, instructionTargets);
      if (instructionBlock) return { ok: false, message: instructionBlock };
      return { ok: true };
    } catch (error) {
      return { ok: false, message: formatPatchError(error) };
    }
  },

  async call(input, ctx): Promise<{ output: ApplyPatchOutput; touchedFiles: string[]; display: string }> {
    try {
      const parsed = parsePatch(input.patch);
      if (parsed.hunks.length === 0) throw new Error("The patch contains no file hunks.");

      // Settle out-of-workspace permission FIRST, before any file reads: the
      // same gate Write/Edit use (bypass mode passes instantly; guarded mode
      // prompts once per directory). Every target is known up front, so a
      // denial aborts before anything is read or computed.
      const allTargets = parsed.hunks.flatMap((hunk) => [
        resolvePatchPath(ctx.workspace, hunk.path),
        ...(hunk.kind === "update" && hunk.movePath
          ? [resolvePatchPath(ctx.workspace, hunk.movePath)]
          : []),
      ]);
      for (const target of allTargets) {
        await resolveWorkspacePath(ctx, target, "patch path", "write");
      }

      // Compute every new byte sequence before entering the mutation service.
      // The service's expectedHash checks close the read-to-commit race.
      const operations: WorkspaceMutationOperation[] = [];
      for (const hunk of parsed.hunks) {
        const filePath = resolvePatchPath(ctx.workspace, hunk.path);
        switch (hunk.kind) {
          case "add":
            operations.push({ kind: "add", path: filePath, content: Buffer.from(hunk.contents, "utf8") });
            break;
          case "delete": {
            const original = await readPatchFile(filePath, "delete");
            operations.push({ kind: "delete", path: filePath, expectedHash: workspaceContentHash(original) });
            break;
          }
          case "update": {
            const original = await readPatchFile(filePath, "update");
            const next = derivePatchedBytes(filePath, original, hunk.chunks);
            const expectedHash = workspaceContentHash(original);
            if (hunk.movePath) {
              operations.push({
                kind: "rename",
                fromPath: filePath,
                toPath: resolvePatchPath(ctx.workspace, hunk.movePath),
                expectedHash,
                content: next,
              });
            } else {
              operations.push({ kind: "update", path: filePath, expectedHash, content: next });
            }
            break;
          }
        }
      }

      // The transaction root follows the TARGETS (an external project keeps its
      // own CAS/recovery journal), exactly like Write/Edit.
      const mutationWorkspace = await mutationWorkspaceForPaths(ctx.workspace, allTargets);
      const receipt = await new WorkspaceMutationService(mutationWorkspace).apply(operations, {
        label: "ApplyPatch",
        transactionId: ctx.mutationTransactionId,
      });
      await refreshReadStamps(receipt, ctx.fileReadStamps);
      const output = summarizeReceipt(receipt, ctx.workspace);
      output.feedback = await collectMutationFeedback(ctx.workspace, receipt);
      return {
        output,
        touchedFiles: receipt.touchedFiles,
        display: appendMutationFeedback(renderSummary(output), output.feedback),
      };
    } catch (error) {
      const detail =
        error instanceof WorkspaceMutationError
          ? `${error.message} ${error.actionable}`
          : formatPatchError(error);
      throw toolError(`ApplyPatch failed before a complete commit: ${detail}`);
    }
  },
});

function derivePatchedBytes(filePath: string, original: Buffer, chunks: readonly UpdateFileChunk[]): Buffer {
  const bom = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const body = bom ? original.subarray(3) : original;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error(`${filePath} is not valid UTF-8. ApplyPatch edits text files only; use a binary-aware tool instead.`);
  }

  const eol = dominantEol(source);
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  const sourceLines = normalized.length === 0
    ? []
    : (hadTrailingNewline ? normalized.slice(0, -1) : normalized).split("\n");
  const replacements: Array<{ start: number; oldLength: number; newLines: string[] }> = [];
  let cursor = 0;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    let searchStart = cursor;
    if (chunk.changeContext !== undefined) {
      const context = findSequence(sourceLines, [chunk.changeContext], cursor, false);
      if (!context) {
        throw new Error(
          `${filePath}: chunk ${index + 1} could not find context ${JSON.stringify(chunk.changeContext)} at or after line ${cursor + 1}. Re-read the file and regenerate this hunk.`,
        );
      }
      searchStart = context.index + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertion = chunk.isEndOfFile || chunk.changeContext === undefined ? sourceLines.length : searchStart;
      replacements.push({ start: insertion, oldLength: 0, newLines: chunk.newLines });
      cursor = insertion;
      continue;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = findSequence(sourceLines, oldLines, searchStart, chunk.isEndOfFile);
    // GPT occasionally includes the synthetic final empty line in a hunk. The
    // parser works line-wise, so retry without it exactly as Codex/OpenCode do.
    if (!found && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = findSequence(sourceLines, oldLines, searchStart, chunk.isEndOfFile);
    }
    if (!found) {
      const expected = chunk.oldLines.slice(0, 12).join("\n");
      const clipped = chunk.oldLines.length > 12 ? `${expected}\n…` : expected;
      throw new Error(
        `${filePath}: chunk ${index + 1} could not find its expected lines at or after line ${searchStart + 1}:\n${clipped}\nRe-read the file and copy current context into the patch; no files were changed.`,
      );
    }
    replacements.push({ start: found.index, oldLength: oldLines.length, newLines });
    cursor = found.index + oldLines.length;
  }

  const result = [...sourceLines];
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index];
    result.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
  }
  let next = result.join("\n");
  if (hadTrailingNewline && result.length > 0) next += "\n";
  if (eol !== "\n") next = next.replace(/\n/g, eol);
  const encoded = Buffer.from(next, "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]) : encoded;
}

type MatchMode = "exact" | "trailing-whitespace" | "whitespace" | "unicode";

function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): { index: number; mode: MatchMode } | null {
  if (pattern.length === 0) return null;
  const passes: Array<{ mode: MatchMode; compare: (left: string, right: string) => boolean }> = [
    { mode: "exact", compare: (left, right) => left === right },
    { mode: "trailing-whitespace", compare: (left, right) => left.trimEnd() === right.trimEnd() },
    { mode: "whitespace", compare: (left, right) => left.trim() === right.trim() },
    { mode: "unicode", compare: (left, right) => normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()) },
  ];

  for (const pass of passes) {
    if (endOfFile) {
      const candidate = lines.length - pattern.length;
      if (candidate >= start && sequenceMatches(lines, pattern, candidate, pass.compare)) {
        return { index: candidate, mode: pass.mode };
      }
    }
    for (let index = start; index <= lines.length - pattern.length; index++) {
      if (sequenceMatches(lines, pattern, index, pass.compare)) return { index, mode: pass.mode };
    }
  }
  return null;
}

function sequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  compare: (left: string, right: string) => boolean,
): boolean {
  for (let offset = 0; offset < pattern.length; offset++) {
    if (!compare(lines[start + offset], pattern[offset])) return false;
  }
  return true;
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ");
}

function dominantEol(value: string): "\n" | "\r\n" | "\r" {
  const crlf = (value.match(/\r\n/g) ?? []).length;
  const withoutCrlf = value.replace(/\r\n/g, "");
  const lf = (withoutCrlf.match(/\n/g) ?? []).length;
  const cr = (withoutCrlf.match(/\r/g) ?? []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

async function readPatchFile(filePath: string, action: string): Promise<Buffer> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${filePath} is not a regular file.`);
    }
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Cannot ${action} ${filePath}: the file does not exist. Use *** Add File for a new path.`);
    }
    throw error;
  }
}

/** Syntactic resolution only. Out-of-workspace targets are a PERMISSION
 *  question (settled at call time through the same resolveWorkspacePath gate
 *  Write/Edit use), not a validity one — the old inside-the-root rejection made
 *  ApplyPatch the one mutation tool that refused an owner-approved external
 *  project, forcing lossy full-file Write fallbacks mid-task. */
function resolvePatchPath(workspace: string, rawPath: string): string {
  const root = path.resolve(workspace);
  const cleaned = rawPath.trim();
  if (!cleaned) throw new Error(`Patch path must name one concrete file: ${JSON.stringify(rawPath)}`);
  const absolute = path.resolve(root, cleaned);
  if (absolute === root || absolute === path.parse(absolute).root) {
    throw new Error(`Patch path must name one concrete file, not a directory root: ${JSON.stringify(rawPath)}`);
  }
  return absolute;
}

function patchPathProblem(workspace: string, rawPath: string): string | null {
  try {
    resolvePatchPath(workspace, rawPath);
    if (/[*?"<>|\0\r\n]/.test(rawPath.replace(/^[A-Za-z]:/, ""))) {
      return `${JSON.stringify(rawPath)} is not one concrete file path.`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function summarizeReceipt(receipt: WorkspaceMutationReceipt, workspace: string): ApplyPatchOutput {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const relative = (filePath: string) => path.relative(workspace, filePath).replace(/\\/g, "/");
  for (const operation of receipt.operations) {
    if (operation.kind === "add") added.push(relative(operation.path));
    else if (operation.kind === "update") modified.push(relative(operation.path));
    else if (operation.kind === "delete") deleted.push(relative(operation.path));
    else renamed.push({ from: relative(operation.fromPath), to: relative(operation.toPath) });
  }
  return { transactionId: receipt.id, receiptPath: receipt.receiptPath, added, modified, deleted, renamed };
}

function renderSummary(output: ApplyPatchOutput): string {
  const lines = ["Success. Applied the complete patch:"];
  for (const file of output.added) lines.push(`A ${file}`);
  for (const file of output.modified) lines.push(`M ${file}`);
  for (const file of output.deleted) lines.push(`D ${file}`);
  for (const move of output.renamed) lines.push(`R ${move.from} -> ${move.to}`);
  lines.push(`Rollback receipt: ${output.receiptPath}`);
  return lines.join("\n");
}

async function refreshReadStamps(
  receipt: WorkspaceMutationReceipt,
  stamps: Map<string, { mtimeMs: number; size: number; hash?: string; writtenNotRead?: boolean }>,
): Promise<void> {
  for (const operation of receipt.operations) {
    if (operation.kind === "delete") {
      stamps.delete(operation.path);
      continue;
    }
    if (operation.kind === "rename") {
      stamps.delete(operation.fromPath);
      await stampWrittenFile(operation.toPath, stamps);
      continue;
    }
    await stampWrittenFile(operation.path, stamps);
  }
}

async function stampWrittenFile(
  filePath: string,
  stamps: Map<string, { mtimeMs: number; size: number; hash?: string; writtenNotRead?: boolean }>,
): Promise<void> {
  const [stat, text] = await Promise.all([fs.stat(filePath), fs.readFile(filePath, "utf8")]);
  stamps.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: contentHash(text),
    writtenNotRead: true,
  });
}

function formatPatchError(error: unknown): string {
  if (error instanceof PatchParseError) {
    return `Invalid patch${error.lineNumber ? ` near line ${error.lineNumber}` : ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
