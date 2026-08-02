// CodebaseSearch — semantic-ish search via ripgrep + TF-IDF ranking.
//
// First cut uses term-frequency / inverse-document-frequency ranking
// over file chunks. No embeddings (yet) — but the tool surface and the
// prompt discipline are what changes the model's behavior, not the
// ranker. An embedding upgrade is drop-in via the same Tool shape.
//
// Tool description copies the GOOD/BAD QUERY pattern Cursor uses, so
// the model learns to phrase queries as full questions, not keywords.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, resolveWorkspacePath } from "./_shared.js";

export interface CodebaseSearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface CodebaseSearchOutput {
  query: string;
  hits: CodebaseSearchHit[];
  filesScanned: number;
  chunksRanked: number;
  durationMs: number;
}

const inputSchema = z
  .object({
    query: z
      .string()
      .min(3)
      .describe(
        "A natural-language question — NOT a keyword. Phrase as you'd ask a colleague.",
      ),
    target_directories: z
      .array(z.string())
      .default([])
      .describe(
        "Optional list of subdirectories to scope the search. Empty array = whole workspace.",
      ),
    max_results: z.number().int().positive().max(50).default(10),
  })
  .strict();

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".pnpm-store",
  ".ares",
  "coverage",
  ".turbo",
  ".cache",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
  ".swift",
  ".m",
  ".mm",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".lua",
  ".sh",
  ".ps1",
  ".sql",
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 10;
// Large generated artifacts are ignored by directory rules, but real product
// entrypoints routinely exceed 256 KiB (Ares' desktop App.tsx did). Excluding
// them made repository search silently blind to a central ownership surface.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const CodebaseSearchTool = buildTool({
  name: "CodebaseSearch",
  description: `Ranked KEYWORD search over the workspace (token/TF-IDF overlap, NOT true semantic search — it has no embeddings, so it can miss synonyms, e.g. searching "auth failure" may not surface "401" or "rejectUnauthorized"). Returns the most keyword-relevant code chunks for a question. For exact strings or symbol names, prefer Grep.

WHEN TO USE:
- "How does X work?" / "Where is Y handled?" / "Show me Z usage"
- Exploring unfamiliar code
- Finding the right entry point before reading whole files

WHEN NOT TO USE:
- Exact text matches → use Grep
- Filename patterns → use Glob
- Known specific file → use Read

QUERY GUIDANCE (this matters):
Good queries are complete questions phrased like you'd ask a colleague:
  ✓ "Where is user authentication implemented in the frontend?"
  ✓ "How do we handle file upload progress?"
  ✓ "What happens when the API rate-limits us?"

Bad queries:
  ✗ "auth"                    → too vague, use Grep for keywords
  ✗ "AuthService"             → single symbol, use Grep
  ✗ "What is X? How does Y?"  → two questions, run two searches in parallel

SEARCH STRATEGY:
1. Start broad with target_directories=[] (whole repo).
2. If results point to a directory, rerun with target_directories=["src/foo/"] to drill in.
3. Break complex questions into focused parallel sub-searches.

Pair CodebaseSearch with Task(researcher) when the investigation needs many follow-up reads — the researcher subagent will use CodebaseSearch itself and return a summary, keeping YOUR context clean.`,
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Searching the codebase for ${truncate(i.query, 60)}`,

  async call(i, ctx): Promise<{ output: CodebaseSearchOutput; display: string }> {
    const t0 = Date.now();
    // Confine every target_directories entry to the workspace (or an explicitly
    // granted out-of-workspace path), same as Grep/Glob/Read. Previously this
    // path.resolve'd straight off ctx.workspace with no guard — the one read tool
    // that could be steered to read ../../etc with a "../" target.
    const roots =
      i.target_directories.length > 0
        ? await Promise.all(
            i.target_directories.map((d) =>
              resolveWorkspacePath(ctx, d, "target_directories", "read"),
            ),
          )
        : [ctx.workspace];

    // 1. Tokenize query.
    const queryTokens = tokenize(i.query);
    if (queryTokens.length === 0) {
      return {
        output: { query: i.query, hits: [], filesScanned: 0, chunksRanked: 0, durationMs: 0 },
        display: "no tokens in query",
      };
    }

    // 2. Walk + chunk + score.
    const allChunks: Chunk[] = [];
    let filesScanned = 0;
    for (const root of roots) {
      await walk(root, async (file) => {
        const ext = path.extname(file).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) return;
        const stat = await fs.stat(file).catch(() => null);
        if (!stat || stat.size > MAX_FILE_BYTES) return;
        filesScanned++;
        const cached = chunkCache.get(file);
        // Skip the read entirely when mtime+size are unchanged.
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          for (const c of cached.chunks) allChunks.push(c);
          return;
        }
        const content = await fs.readFile(file, "utf8").catch(() => "");
        if (!content) return;
        for (const c of chunksForFile(file, content, stat.mtimeMs, stat.size)) allChunks.push(c);
      });
    }

    // 3. Score each chunk with TF-IDF over the query tokens.
    const df = computeDocFrequency(allChunks, queryTokens);
    const totalChunks = allChunks.length;
    const scored = allChunks.map((c) => ({
      chunk: c,
      score: tfIdfScore(c, queryTokens, df, totalChunks),
    }));

    scored.sort((a, b) => b.score - a.score);
    const topRaw = scored.filter((s) => s.score > 0).slice(0, i.max_results);

    const hits: CodebaseSearchHit[] = topRaw.map(({ chunk, score }) => ({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: Math.round(score * 1000) / 1000,
      snippet: chunk.text.length > 600 ? chunk.text.slice(0, 600) + "\n…" : chunk.text,
    }));

    return {
      output: {
        query: i.query,
        hits,
        filesScanned,
        chunksRanked: totalChunks,
        durationMs: Date.now() - t0,
      },
      display: `${hits.length} hit${hits.length === 1 ? "" : "s"} from ${filesScanned} file${filesScanned === 1 ? "" : "s"}`,
    };
  },
});

// ─── Chunking + ranking ────────────────────────────────────────────────

interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: Map<string, number>;
}

// Per-process chunk cache keyed by path → (mtime,size). A query previously
// re-read+re-chunked the WHOLE workspace every time; now only files that
// changed since last seen are re-chunked.
//
// Bounded LRU: the Map is module-level and was never evicted, so a long-lived
// process searching many repos grew it without limit. Map keeps insertion
// order, so the oldest entry is the first key — evict it once we exceed the cap.
const CHUNK_CACHE_MAX = 5_000;
const chunkCache = new Map<string, { mtimeMs: number; size: number; chunks: Chunk[] }>();

function cacheChunks(filePath: string, entry: { mtimeMs: number; size: number; chunks: Chunk[] }): void {
  // Re-insert moves the key to the most-recently-used end (Map ordering).
  chunkCache.delete(filePath);
  chunkCache.set(filePath, entry);
  while (chunkCache.size > CHUNK_CACHE_MAX) {
    const oldest = chunkCache.keys().next().value;
    if (oldest === undefined) break;
    chunkCache.delete(oldest);
  }
}

function chunksForFile(filePath: string, content: string, mtimeMs: number, size: number): Chunk[] {
  const cached = chunkCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.chunks;
  const chunks: Chunk[] = [];
  chunkify(filePath, content, chunks);
  cacheChunks(filePath, { mtimeMs, size, chunks });
  return chunks;
}

function chunkify(filePath: string, content: string, out: Chunk[]): void {
  const lines = content.split("\n");
  if (lines.length <= CHUNK_LINES) {
    const tokens = bagOfWords(content);
    out.push({
      path: filePath,
      startLine: 1,
      endLine: lines.length,
      text: content,
      tokens,
    });
    return;
  }
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const text = lines.slice(start, end).join("\n");
    out.push({
      path: filePath,
      startLine: start + 1,
      endLine: end,
      text,
      tokens: bagOfWords(text),
    });
    if (end === lines.length) break;
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function bagOfWords(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const tok of tokenize(s)) m.set(tok, (m.get(tok) ?? 0) + 1);
  return m;
}

function computeDocFrequency(chunks: Chunk[], queryTokens: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tok of queryTokens) {
    let count = 0;
    for (const c of chunks) if (c.tokens.has(tok)) count++;
    df.set(tok, count);
  }
  return df;
}

function tfIdfScore(
  chunk: Chunk,
  queryTokens: string[],
  df: Map<string, number>,
  totalChunks: number,
): number {
  let score = 0;
  for (const tok of queryTokens) {
    const tf = chunk.tokens.get(tok) ?? 0;
    if (tf === 0) continue;
    const docFreq = df.get(tok) ?? 0;
    if (docFreq === 0) continue;
    const idf = Math.log((totalChunks + 1) / (docFreq + 1)) + 1;
    score += Math.sqrt(tf) * idf;
  }
  // Slight boost for code-shaped chunks (lots of identifiers).
  if (chunk.tokens.size > 30) score *= 1.05;
  return score;
}

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      // Search code-bearing dot directories such as .github; explicit cache,
      // VCS, and Ares-state directories are already denied above.
      await walk(full, visit);
    } else if (e.isFile()) {
      if (e.name.startsWith(".")) {
        const ext = path.extname(e.name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
      }
      await visit(full);
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ─── Stopwords ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "must",
  "can",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "where",
  "when",
  "why",
  "how",
  "with",
  "from",
  "as",
  "if",
  "then",
  "than",
  "we",
  "us",
  "you",
  "your",
  "it",
  "its",
  "i",
  "me",
  "my",
  "our",
]);
