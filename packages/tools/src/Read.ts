// Read - bounded, binary-aware workspace reads with session-local CAS stamps.

import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { z } from "zod";
import {
  appendRepositoryInstructions,
  buildTool,
  pathInputProblem,
  repositoryInstructionsForTargets,
  resolveWorkspacePath,
  toolError,
  type RichToolContext,
  zPath,
} from "./_shared.js";
import type { ResolvedRepositoryInstruction } from "@ares/core";

const inputSchema = z
  .object({
    file_path: zPath,
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Line, PDF page, or directory-entry number to start reading from (0-indexed)."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum lines, PDF pages, or directory entries. Text defaults to 2000; PDFs are capped at 8 pages per call."),
  })
  .strict();

const DEFAULT_READ_LINES = (() => {
  const raw = Number(process.env.ARES_READ_MAX_LINES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2_000;
})();

/** A pathological minified line cannot dominate a turn. */
const MAX_LINE_CHARS = 4_000;

/** Bound model-facing bytes independently of line count. The source is still
 * streamed to compute exact line metadata and a full-content CAS hash. */
const MAX_PAGE_BYTES = (() => {
  const raw = Number(process.env.ARES_READ_MAX_BYTES);
  return Number.isFinite(raw) && raw >= 4_096
    ? Math.min(Math.floor(raw), 1024 * 1024)
    : 50 * 1024;
})();

export interface ReadOutput {
  path: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  /** Unit represented by total/start/end. Omitted for legacy text results. */
  unit?: "lines" | "pages" | "entries";
  /** cat -n style: "    1\tcontent". */
  content: string;
  truncated: boolean;
}

type ReadCallResult = {
  output: ReadOutput;
  touchedFiles?: string[];
  display?: string;
  images?: Array<{ mediaType: string; data: string }>;
};

export const ReadTool = buildTool({
  name: "Read",
  description:
    "Read bounded text, PDF pages, a directory listing, or a supported image. Text is line numbered; use offset/limit to continue large files and documents.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Reading ${path.basename(i.file_path)}`,

  async validateInput(i, ctx) {
    const pathProblem = pathInputProblem(i.file_path, ctx?.workspace);
    if (pathProblem) return { ok: false, message: `file_path: ${pathProblem}` };
    if (i.offset !== undefined && i.offset > 0 && ctx?.fileReadStamps) {
      const abs = path.resolve(ctx.workspace, i.file_path);
      const stamp = ctx.fileReadStamps.get(abs);
      if (stamp?.lines !== undefined && i.offset >= stamp.lines) {
        const current = await fs.stat(abs).catch(() => null);
        if (current && current.size === stamp.size && current.mtimeMs === stamp.mtimeMs) {
          return {
            ok: false,
            message: `offset ${i.offset} is past the end of ${path.basename(i.file_path)} - the file has only ${stamp.lines} lines. Use an offset below ${stamp.lines}.`,
          };
        }
      }
    }
    return { ok: true };
  },

  async call(i, ctx): Promise<ReadCallResult> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "read");
    const before = await fs.stat(filePath);
    const offset = i.offset ?? 0;
    const limit = i.limit ?? DEFAULT_READ_LINES;
    const repositoryInstructions = await repositoryInstructionsForTargets(ctx, [filePath]);

    if (before.isDirectory()) {
      return attachRepositoryInstructions(
        await readDirectoryPage(filePath, offset, limit),
        repositoryInstructions,
      );
    }
    if (!before.isFile()) throw new Error(`${filePath} is not a regular file`);

    if (path.extname(filePath).toLowerCase() === ".pdf") {
      return attachRepositoryInstructions(
        await readPdfPages(filePath, before, offset, limit, ctx),
        repositoryInstructions,
      );
    }

    const imageMedia = imageMediaType(filePath);
    if (imageMedia) {
      const maxImageBytes = 12 * 1024 * 1024;
      if (before.size > maxImageBytes) {
        return attachRepositoryInstructions({
          output: {
            path: filePath,
            totalLines: 0,
            startLine: 0,
            endLine: 0,
            content: `<system>Image "${path.basename(filePath)}" is ${(before.size / 1048576).toFixed(1)}MB - too large to inline (cap 12MB). Downscale it first, then Read again.</system>`,
            truncated: true,
          },
          display: `Read ${path.basename(filePath)} - image too large (${(before.size / 1048576).toFixed(1)}MB)`,
        }, repositoryInstructions);
      }
      const data = (await fs.readFile(filePath)).toString("base64");
      const kb = Math.max(1, Math.round(before.size / 1024));
      return attachRepositoryInstructions({
        output: {
          path: filePath,
          totalLines: 0,
          startLine: 0,
          endLine: 0,
          content: `<system>Image "${path.basename(filePath)}" (${imageMedia}, ${kb}KB) is attached to this tool result.</system>`,
          truncated: false,
        },
        images: [{ mediaType: imageMedia, data }],
        display: `Read ${path.basename(filePath)} (image, ${kb}KB)`,
      }, repositoryInstructions);
    }

    if (before.size === 0) {
      ctx.fileReadStamps.set(filePath, {
        mtimeMs: before.mtimeMs,
        size: before.size,
        hash: createHash("sha256").digest("hex"),
        lines: 0,
      });
      return attachRepositoryInstructions({
        output: {
          path: filePath,
          totalLines: 0,
          startLine: 0,
          endLine: 0,
          content: `<system>File "${path.basename(filePath)}" is empty (0 bytes). Use Write to add contents.</system>`,
          truncated: false,
        },
        display: `Read ${filePath} (empty file)`,
      }, repositoryInstructions);
    }

    let page: StreamedTextPage;
    try {
      page = await streamTextPage(filePath, offset, limit);
    } catch (error) {
      if (!(error instanceof BinaryReadError)) throw error;
      return attachRepositoryInstructions({
        output: {
          path: filePath,
          totalLines: 0,
          startLine: 0,
          endLine: 0,
          content: `<system>"${path.basename(filePath)}" is binary or uses an unsupported text encoding. Read did not decode or put its bytes in model context. Use a format-specific inspection tool.</system>`,
          truncated: false,
        },
        display: `Read ${path.basename(filePath)} (binary metadata only)`,
      }, repositoryInstructions);
    }

    const after = await fs.stat(filePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw toolError(`${path.basename(filePath)} changed while it was being read. Read it again before editing.`);
    }
    if (offset >= page.totalLines) {
      throw toolError(
        `offset ${offset} is past the end of ${path.basename(filePath)} - the file has only ${page.totalLines} lines. Use an offset below ${page.totalLines}.`,
      );
    }

    const end = offset + page.lines.length;
    const formatted = page.lines
      .map((line, index) => `${(offset + index + 1).toString().padStart(5, " ")}\t${line}`)
      .join("\n");
    const truncated = end < page.totalLines;
    const content = truncated
      ? `${formatted}\n\n[Read stopped at line ${end} of ${page.totalLines}${page.byteCapped ? ` after reaching the ${MAX_PAGE_BYTES}-byte output cap` : ""}. Use offset=${end}${i.limit !== undefined ? ` limit=${i.limit}` : ""} to continue.]`
      : formatted;

    // This exact full-file hash is session-local evidence for Edit/Write CAS.
    ctx.fileReadStamps.set(filePath, {
      mtimeMs: before.mtimeMs,
      size: before.size,
      hash: page.hash,
      lines: page.totalLines,
    });

    return attachRepositoryInstructions({
      output: {
        path: filePath,
        totalLines: page.totalLines,
        startLine: offset + 1,
        endLine: end,
        content,
        truncated,
      },
      display: `Read ${filePath} (${page.lines.length}/${page.totalLines} lines)`,
    }, repositoryInstructions);
  },
});

function attachRepositoryInstructions(
  result: ReadCallResult,
  instructions: readonly ResolvedRepositoryInstruction[],
): ReadCallResult {
  if (instructions.length === 0) return result;
  return {
    ...result,
    output: {
      ...result.output,
      content: appendRepositoryInstructions(result.output.content, instructions),
    },
  };
}

interface StreamedTextPage {
  lines: string[];
  totalLines: number;
  hash: string;
  byteCapped: boolean;
}

class BinaryReadError extends Error {}

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_PDF_PAGES_PER_CALL = 8;
/** Leave room inside MAX_PAGE_BYTES for a truthful continuation/truncation
 * marker. The body budget is still large, and the complete model-facing
 * result—including the marker—never crosses the advertised cap. */
const PDF_CONTINUATION_RESERVE_BYTES = 512;

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  // Move back to a UTF-8 code-point boundary instead of decoding a partial
  // multibyte character into U+FFFD at the cap.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** Bounded, lazy PDF extraction. pdf.js is imported only for a PDF call so the
 * ordinary coding hot path pays no document-parser startup cost. The complete
 * file is hashed before parsing and stat-checked afterwards, preserving the
 * same read-before-write evidence contract as text files. */
async function readPdfPages(
  file: string,
  before: { size: number; mtimeMs: number },
  offset: number,
  requestedLimit: number,
  ctx: RichToolContext,
): Promise<ReadCallResult> {
  if (before.size > MAX_PDF_BYTES) {
    throw toolError(
      `${path.basename(file)} is ${(before.size / 1048576).toFixed(1)}MB; PDF extraction is capped at ${MAX_PDF_BYTES / 1048576}MB. Split or compress the document first.`,
    );
  }

  const bytes = await fs.readFile(file);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    useSystemFonts: true,
    useWorkerFetch: false,
    stopAtErrors: false,
    verbosity: 0,
  });

  let document: Awaited<typeof loading.promise> | null = null;
  try {
    document = await loading.promise;
    if (offset >= document.numPages) {
      throw toolError(
        `offset ${offset} is past the end of ${path.basename(file)} - the PDF has ${document.numPages} page(s). Use an offset below ${document.numPages}.`,
      );
    }
    const pageLimit = Math.min(requestedLimit, MAX_PDF_PAGES_PER_CALL);
    const endPageExclusive = Math.min(document.numPages, offset + pageLimit);
    const sections: string[] = [];
    let retainedBytes = 0;
    let byteCapped = false;
    let pageTextTruncated = false;
    const bodyBudget = MAX_PAGE_BYTES - PDF_CONTINUATION_RESERVE_BYTES;

    for (let index = offset; index < endPageExclusive; index++) {
      const page = await document.getPage(index + 1);
      const text = await page.getTextContent({ includeMarkedContent: false });
      const lines: string[] = [];
      let current = "";
      for (const item of text.items) {
        if (!("str" in item)) continue;
        const fragment = item.str.trim();
        if (fragment) current += `${current ? " " : ""}${fragment}`;
        if (item.hasEOL && current) {
          lines.push(current);
          current = "";
        }
      }
      if (current) lines.push(current);
      const body = lines.join("\n").trim() || "[No extractable text on this page; it may be scanned/image-only.]";
      const section = `--- Page ${index + 1} of ${document.numPages} ---\n${body}`;
      const separatorBytes = sections.length > 0 ? 2 : 0;
      const cost = separatorBytes + Buffer.byteLength(section, "utf8");
      if (retainedBytes + cost > bodyBudget) {
        byteCapped = true;
        // Always consume at least one page. Returning zero pages with
        // "offset=<same offset>" creates an infinite continuation loop when a
        // single PDF page contains more than the cap. Instead retain a bounded
        // prefix, truthfully mark the page text as omitted, and advance the
        // continuation to the following page.
        if (sections.length === 0) {
          const retained = truncateUtf8(section, Math.max(0, bodyBudget));
          sections.push(retained);
          retainedBytes = Buffer.byteLength(retained, "utf8");
          pageTextTruncated = true;
        }
        break;
      }
      sections.push(section);
      retainedBytes += cost;
    }

    const after = await fs.stat(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw toolError(`${path.basename(file)} changed while it was being extracted. Read it again.`);
    }
    ctx.fileReadStamps.set(file, {
      mtimeMs: before.mtimeMs,
      size: before.size,
      hash,
      lines: document.numPages,
    });

    const pagesRead = sections.length;
    const end = offset + pagesRead;
    const truncated = pageTextTruncated || byteCapped || end < document.numPages;
    let continuation = "";
    if (pageTextTruncated) {
      continuation = end < document.numPages
        ? `\n\n[PDF page ${end} text was truncated at the ${MAX_PAGE_BYTES}-byte output cap; remaining text on that page was omitted. Use offset=${end} to continue with page ${end + 1}.]`
        : `\n\n[PDF page ${end} text was truncated at the ${MAX_PAGE_BYTES}-byte output cap; remaining text on that final page was omitted. There are no later pages to continue.]`;
    } else if (truncated) {
      continuation = `\n\n[PDF read stopped after page ${end} of ${document.numPages}${byteCapped ? ` at the ${MAX_PAGE_BYTES}-byte output cap` : ""}. Use offset=${end} to continue.]`;
    }
    const content = sections.join("\n\n") + continuation;
    // The fixed reserve above is intentionally much larger than these compact
    // markers. Keep a defensive assertion so a future copy edit cannot
    // silently violate Read's hard output contract.
    if (Buffer.byteLength(content, "utf8") > MAX_PAGE_BYTES) {
      throw new Error("internal PDF read output exceeded its byte cap");
    }
    return {
      output: {
        path: file,
        totalLines: document.numPages,
        startLine: offset + 1,
        endLine: end,
        unit: "pages",
        content,
        truncated,
      },
      display: `Read ${path.basename(file)} (${pagesRead}/${document.numPages} PDF pages)`,
    };
  } catch (error) {
    if (error instanceof Error && /<tool_use_error>/.test(error.message)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw toolError(`Could not extract ${path.basename(file)} as PDF: ${message}`);
  } finally {
    await loading.destroy().catch(() => undefined);
  }
}

/** Stream once, retain only a bounded page, and hash the complete byte stream. */
async function streamTextPage(file: string, offset: number, limit: number): Promise<StreamedTextPage> {
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const lines: string[] = [];
  let totalLines = 0;
  let sawBytes = false;
  let currentPrefix = "";
  let currentLength = 0;
  let pageBytes = 0;
  let byteCapped = false;

  const consumeSegment = (segment: string) => {
    currentLength += segment.length;
    if (currentPrefix.length < MAX_LINE_CHARS) {
      currentPrefix += segment.slice(0, MAX_LINE_CHARS - currentPrefix.length);
    }
  };
  const finishLine = () => {
    const lineIndex = totalLines++;
    if (lineIndex >= offset && lineIndex < offset + limit && !byteCapped) {
      let shown = currentPrefix;
      if (currentLength <= MAX_LINE_CHARS && shown.endsWith("\r")) shown = shown.slice(0, -1);
      if (currentLength > MAX_LINE_CHARS) {
        shown = `${shown}... [line truncated: ${currentLength} chars total]`;
      }
      const cost = Buffer.byteLength(shown, "utf8") + 7;
      if (lines.length > 0 && pageBytes + cost > MAX_PAGE_BYTES) {
        byteCapped = true;
      } else {
        lines.push(shown);
        pageBytes += cost;
      }
    }
    currentPrefix = "";
    currentLength = 0;
  };
  const consumeDecoded = (text: string) => {
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      if (newline < 0) {
        consumeSegment(text.slice(cursor));
        return;
      }
      consumeSegment(text.slice(cursor, newline));
      finishLine();
      cursor = newline + 1;
    }
  };

  for await (const rawChunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    sawBytes ||= chunk.length > 0;
    if (looksBinary(chunk)) throw new BinaryReadError("binary data");
    hash.update(chunk);
    consumeDecoded(decoder.write(chunk));
  }
  consumeDecoded(decoder.end());
  if (sawBytes) finishLine();

  return { lines, totalLines, hash: hash.digest("hex"), byteCapped };
}

function looksBinary(chunk: Buffer): boolean {
  if (chunk.includes(0)) return true;
  let controls = 0;
  for (const byte of chunk) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) controls++;
  }
  return chunk.length >= 64 && controls / chunk.length > 0.08;
}

async function readDirectoryPage(filePath: string, offset: number, limit: number): Promise<ReadCallResult> {
  const entries = (await fs.readdir(filePath, { withFileTypes: true }))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`)
    .sort((a, b) => a.localeCompare(b));
  if (entries.length === 0) {
    return {
      output: {
        path: filePath,
        totalLines: 0,
        startLine: 0,
        endLine: 0,
        content: `<system>Directory "${path.basename(filePath)}" is empty.</system>`,
        truncated: false,
      },
      display: `Read ${filePath} (empty directory)`,
    };
  }
  if (offset >= entries.length) {
    throw toolError(`offset ${offset} is past the end of ${path.basename(filePath)} - the directory has ${entries.length} entries.`);
  }

  const page: string[] = [];
  let pageBytes = 0;
  for (const entry of entries.slice(offset, offset + limit)) {
    const cost = Buffer.byteLength(entry, "utf8") + 7;
    if (page.length > 0 && pageBytes + cost > MAX_PAGE_BYTES) break;
    page.push(entry);
    pageBytes += cost;
  }
  const end = offset + page.length;
  const formatted = page
    .map((entry, index) => `${(offset + index + 1).toString().padStart(5, " ")}\t${entry}`)
    .join("\n");
  const truncated = end < entries.length;
  return {
    output: {
      path: filePath,
      totalLines: entries.length,
      startLine: offset + 1,
      endLine: end,
      content: truncated
        ? `${formatted}\n\n[Directory listing stopped at entry ${end} of ${entries.length}. Use offset=${end} to continue.]`
        : formatted,
      truncated,
    },
    display: `Read ${filePath} (${page.length}/${entries.length} entries)`,
  };
}

function imageMediaType(file: string): string | null {
  switch (path.extname(file).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return null;
  }
}
