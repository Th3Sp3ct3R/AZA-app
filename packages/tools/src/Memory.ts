import { randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceMutationError,
  WorkspaceMutationService,
  workspaceContentHash,
} from "@ares/core";
import { z } from "zod";
import { buildTool } from "./_shared.js";

const SHA_256 = /^[a-f0-9]{64}$/i;

const inputSchema = z
  .object({
    action: z.enum(["add", "update", "search", "recall", "forget", "list"]),
    scope: z.enum(["user", "project"]).default("project"),
    id: z.string().optional().describe("Memory id for update/forget."),
    category: z.string().default("General").describe("Section name, e.g. Preferences, Project, Commands."),
    content: z.string().optional().describe("Memory body for add/update."),
    tags: z.array(z.string()).default([]),
    query: z.string().optional().describe("Search query for search/recall/list filtering."),
    limit: z.number().int().positive().max(100).default(20),
    expectedVersion: z
      .string()
      .regex(SHA_256, "expectedVersion must be a SHA-256 hex digest")
      .optional()
      .describe("Optional version returned by an earlier Memory call. Mutations fail instead of overwriting a newer snapshot."),
  })
  .strict();

export interface MemoryItem {
  id: string;
  category: string;
  content: string;
  tags: string[];
  updatedAt: string;
}

export interface MemoryOutput {
  scope: "user" | "project";
  path: string;
  /** SHA-256 of the exact backing markdown snapshot from which `items` was selected. */
  version: string;
  items: MemoryItem[];
  changed: boolean;
  message: string;
}

export interface MemoryCommitContext {
  action: "add" | "update" | "forget";
  scope: "user" | "project";
  path: string;
  baseVersion: string;
  nextVersion: string;
}

export interface MemoryToolOptions {
  /** Embedders/tests may pause immediately before the durable CAS commit. */
  beforeCommit?(context: MemoryCommitContext): Promise<void> | void;
  /** Override the bounded cross-process lock wait. Environment default below. */
  lockTimeoutMs?: number;
  /** Override when a dead owner's lock becomes reclaimable. */
  lockStaleMs?: number;
}

/** A caller supplied a stale version, or a non-cooperating writer changed the
 * file after Ares read it. The mutation service has not overwritten that edit. */
export class MemoryConflictError extends Error {
  readonly code = "MEMORY_CONFLICT" as const;

  constructor(
    readonly path: string,
    readonly expectedVersion: string,
    readonly actualVersion: string,
    options?: ErrorOptions,
  ) {
    super(
      `Memory changed before this write could commit: ${path}. ` +
        `Expected ${expectedVersion}, found ${actualVersion}. Re-read Memory and retry against the new version.`,
      options,
    );
    this.name = "MemoryConflictError";
  }
}

/** A live Ares process is already mutating this memory file and did not finish
 * within the configured bound. Timing out is safer than stealing its lease. */
export class MemoryLockTimeoutError extends Error {
  readonly code = "MEMORY_LOCK_TIMEOUT" as const;

  constructor(readonly path: string, readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for the memory transaction lock: ${path}`);
    this.name = "MemoryLockTimeoutError";
  }
}

export function makeMemoryTool(options: MemoryToolOptions = {}) {
  return buildTool({
    name: "Memory",
    description:
      "Read or update persistent Ares memory. Use add/update for stable preferences, project conventions, commands, or decisions worth remembering across sessions. Use search/list before writing if unsure. Pass expectedVersion from a prior read when stale-write rejection matters.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: inputSchema,
    activityDescription: (i) => `Memory ${i.action} ${i.scope}`,

    async call(i, ctx): Promise<{ output: MemoryOutput; touchedFiles?: string[]; display: string }> {
      const file = memoryPath(i.scope, ctx.workspace);
      return withMemoryFileLock(
        file,
        ctx.signal,
        options,
        async () => {
          const doc = await readMemoryFile(file);
          let changed = false;
          let message = "";

          if (isMutation(i.action) && i.expectedVersion && i.expectedVersion !== doc.version) {
            throw new MemoryConflictError(file, i.expectedVersion, doc.version);
          }

          if (i.action === "add") {
            const content = requireContent(i.content, "add");
            const item: MemoryItem = {
              id: uniqueMemoryId(doc.items),
              category: normalizeCategory(i.category),
              content,
              tags: normalizeTags(i.tags),
              updatedAt: new Date().toISOString(),
            };
            doc.items.push(item);
            message = `added ${item.id}`;
            await persistMutation(i.action, i.scope, ctx.workspace, file, doc, options);
            changed = true;
          } else if (i.action === "update") {
            const id = requireId(i.id, "update");
            const item = doc.items.find((entry) => entry.id === id);
            if (!item) throw new Error(`memory not found: ${id}`);
            item.content = requireContent(i.content, "update");
            item.category = normalizeCategory(i.category || item.category);
            item.tags = normalizeTags(i.tags.length > 0 ? i.tags : item.tags);
            item.updatedAt = new Date().toISOString();
            message = `updated ${id}`;
            await persistMutation(i.action, i.scope, ctx.workspace, file, doc, options);
            changed = true;
          } else if (i.action === "forget") {
            const id = requireId(i.id, "forget");
            const before = doc.items.length;
            doc.items = doc.items.filter((entry) => entry.id !== id);
            if (doc.items.length === before) throw new Error(`memory not found: ${id}`);
            message = `forgot ${id}`;
            await persistMutation(i.action, i.scope, ctx.workspace, file, doc, options);
            changed = true;
          } else {
            message = i.action === "recall"
              ? `recalled ${i.query ?? ""}`
              : i.action === "search"
                ? `searched ${i.query ?? ""}`
                : "listed memory";
          }

          const items = (i.action === "recall" ? recallItems(doc.items, i.query) : filterItems(doc.items, i.query)).slice(0, i.limit);
          return {
            output: { scope: i.scope, path: file, version: doc.version, items, changed, message },
            touchedFiles: changed ? [file] : undefined,
            display: `${message}; ${items.length} item${items.length === 1 ? "" : "s"}; version ${doc.version.slice(0, 12)}`,
          };
        },
      );
    },
  });
}

export const MemoryTool = makeMemoryTool();

interface MemoryDocument {
  exists: boolean;
  raw: string;
  version: string;
  items: MemoryItem[];
}

function memoryPath(scope: "user" | "project", workspace: string): string {
  if (scope === "user") {
    return path.join(process.env.ARES_HOME || path.join(os.homedir(), ".ares"), "memory.md");
  }
  return path.join(workspace, ".ares", "memory.md");
}

async function readMemoryFile(file: string): Promise<MemoryDocument> {
  let raw: string;
  let exists = true;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
    raw = "";
    exists = false;
  }

  const items: MemoryItem[] = [];
  let category = "General";
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      category = normalizeCategory(heading[1]);
      continue;
    }
    const item = parseMemoryLine(line, category);
    if (item) items.push(item);
  }
  return { exists, raw, version: memoryContentVersion(raw), items };
}

/** Exact content version used by MemoryOutput and expectedVersion. */
export function memoryContentVersion(markdown: string): string {
  return workspaceContentHash(markdown);
}

async function persistMutation(
  action: "add" | "update" | "forget",
  scope: "user" | "project",
  workspace: string,
  file: string,
  doc: MemoryDocument,
  options: MemoryToolOptions,
): Promise<void> {
  const nextRaw = renderMemoryFile(doc.items);
  const nextVersion = memoryContentVersion(nextRaw);
  await options.beforeCommit?.({
    action,
    scope,
    path: file,
    baseVersion: doc.version,
    nextVersion,
  });

  // Project memory commits under the active workspace transaction root. User
  // memory commits directly under ARES_HOME: arbitrary workspaces remain free,
  // and no temporary copy/move bridge is involved.
  const transactionRoot = scope === "project" ? path.resolve(workspace) : path.dirname(file);
  await fs.mkdir(transactionRoot, { recursive: true });
  const service = new WorkspaceMutationService(transactionRoot);
  try {
    await service.apply(
      [doc.exists
        ? { kind: "update", path: file, content: nextRaw, expectedHash: doc.version }
        : { kind: "add", path: file, content: nextRaw }],
      { label: `${scope}-markdown-memory:${action}` },
    );
  } catch (error) {
    if (!isConcurrentMutationError(error)) throw error;
    const actual = await readMemoryFile(file);
    throw new MemoryConflictError(file, doc.version, actual.version, { cause: error });
  }

  doc.exists = true;
  doc.raw = nextRaw;
  doc.version = nextVersion;
}

function renderMemoryFile(items: readonly MemoryItem[]): string {
  const grouped = new Map<string, MemoryItem[]>();
  for (const item of items) {
    const category = normalizeCategory(item.category);
    const list = grouped.get(category) ?? [];
    list.push({ ...item, category });
    grouped.set(category, list);
  }

  const lines = ["# Ares Memory", ""];
  for (const [category, categoryItems] of grouped) {
    lines.push(`## ${category}`);
    for (const item of categoryItems) {
      const tags = item.tags.length ? ` tags=${item.tags.join(",")}` : "";
      lines.push(`- [${item.id}] ${item.content} <!-- updated=${item.updatedAt}${tags} -->`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

interface MemoryLockRecord {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
}

async function withMemoryFileLock<T>(
  file: string,
  signal: AbortSignal,
  options: MemoryToolOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${file}.ares-lock`;
  const timeoutMs = boundedMilliseconds(
    options.lockTimeoutMs,
    process.env.ARES_MEMORY_LOCK_TIMEOUT_MS,
    10_000,
    100,
    300_000,
  );
  const staleMs = boundedMilliseconds(
    options.lockStaleMs,
    process.env.ARES_MEMORY_LOCK_STALE_MS,
    60_000,
    1_000,
    3_600_000,
  );
  const release = await acquireMemoryFileLock(lockPath, timeoutMs, staleMs, signal);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireMemoryFileLock(
  lockPath: string,
  timeoutMs: number,
  staleMs: number,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  const token = randomUUID();

  for (;;) {
    throwIfAborted(signal);
    const record: MemoryLockRecord = {
      version: 1,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return () => releaseMemoryFileLock(lockPath, token);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }

    if (await reclaimDeadMemoryLock(lockPath, staleMs)) continue;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) throw new MemoryLockTimeoutError(lockPath, timeoutMs);
    await abortableDelay(Math.min(25, timeoutMs - elapsed), signal);
  }
}

async function reclaimDeadMemoryLock(lockPath: string, staleMs: number): Promise<boolean> {
  const observed = await readLockRecord(lockPath);
  if (!observed) return true;
  if (Date.now() - observed.mtimeMs < staleMs) return false;
  if (observed.record && processIsAlive(observed.record.pid)) return false;

  // Renaming to a unique tombstone means competing reclaimers cannot both
  // believe they removed the same lease. A live owner is never reclaimed.
  const tombstone = `${lockPath}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockPath, tombstone);
    const moved = await readLockRecord(tombstone);
    if (!moved || !sameLockGeneration(observed, moved)) {
      // Another contender may have quarantined the generation we observed and
      // a fresh owner acquired the stable path before our rename. Never delete
      // that fresh lease. Restore it only if the stable name is still vacant.
      if (!(await readLockRecord(lockPath))) {
        await fs.rename(tombstone, lockPath).catch(() => undefined);
      }
      return false;
    }
    await fs.unlink(tombstone).catch(() => undefined);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    return false;
  }
}

interface ObservedMemoryLock {
  record: MemoryLockRecord | null;
  mtimeMs: number;
  size: number;
  ino: number;
  dev: number;
}

async function readLockRecord(lockPath: string): Promise<ObservedMemoryLock | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
    const parsed = JSON.parse(raw) as Partial<MemoryLockRecord>;
    const record = parsed.version === 1 && typeof parsed.token === "string" && Number.isInteger(parsed.pid)
      ? parsed as MemoryLockRecord
      : null;
    return lockObservation(record, stat);
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    // A partially written or malformed lease remains protected until its mtime
    // is stale; then it is safe to treat it as ownerless and reclaim it.
    const stat = await fs.stat(lockPath).catch(() => null);
    return stat ? lockObservation(null, stat) : null;
  }
}

function lockObservation(record: MemoryLockRecord | null, stat: Stats): ObservedMemoryLock {
  return {
    record,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    ino: stat.ino,
    dev: stat.dev,
  };
}

function sameLockGeneration(left: ObservedMemoryLock, right: ObservedMemoryLock): boolean {
  if (left.record?.token || right.record?.token) return left.record?.token === right.record?.token;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

async function releaseMemoryFileLock(lockPath: string, token: string): Promise<void> {
  const observed = await readLockRecord(lockPath);
  if (!observed || observed.record?.token !== token) return;
  await fs.unlink(lockPath).catch((error) => {
    if (errno(error) !== "ENOENT") throw error;
  });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

function boundedMilliseconds(
  explicit: number | undefined,
  environment: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const candidate = explicit ?? (environment === undefined ? Number.NaN : Number(environment));
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(candidate)));
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Memory operation aborted");
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Memory operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isConcurrentMutationError(error: unknown): boolean {
  return error instanceof WorkspaceMutationError && [
    "BASE_MISMATCH",
    "TARGET_EXISTS",
    "TARGET_MISSING",
    "COMMIT_FAILED",
  ].includes(error.code);
}

function parseMemoryLine(line: string, category: string): MemoryItem | null {
  const match = line.match(/^\s*-\s+\[([^\]]+)]\s+(.+?)(?:\s+<!--\s*(.*?)\s*-->)?\s*$/);
  if (!match) return null;
  const meta = parseMeta(match[3] ?? "");
  return {
    id: match[1],
    category,
    content: match[2].trim(),
    tags: meta.tags ? meta.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    updatedAt: meta.updated ?? new Date(0).toISOString(),
  };
}

function parseMeta(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/\s+/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

function filterItems(items: readonly MemoryItem[], query?: string): MemoryItem[] {
  const q = query?.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) =>
    [item.id, item.category, item.content, ...item.tags].some((part) => part.toLowerCase().includes(q)),
  );
}

function recallItems(items: readonly MemoryItem[], query?: string): MemoryItem[] {
  const q = query?.trim().toLowerCase();
  if (!q) return [...items];
  const queryTokens = tokens(q);
  return [...items]
    .map((item) => ({ item, score: scoreItem(item, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
    .map((entry) => entry.item);
}

function scoreItem(item: MemoryItem, queryTokens: Set<string>): number {
  const haystack = tokens([item.id, item.category, item.content, ...item.tags].join(" "));
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) score += 2;
    for (const candidate of haystack) {
      if (candidate.includes(token) || token.includes(candidate)) score += 0.25;
    }
  }
  return score;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_:-]+/g) ?? []);
}

function isMutation(action: string): action is "add" | "update" | "forget" {
  return action === "add" || action === "update" || action === "forget";
}

function uniqueMemoryId(items: readonly MemoryItem[]): string {
  const known = new Set(items.map((item) => item.id));
  for (;;) {
    const candidate = `mem_${randomUUID().slice(0, 8)}`;
    if (!known.has(candidate)) return candidate;
  }
}

function requireId(id: string | undefined, action: string): string {
  if (!id?.trim()) throw new Error(`Memory.${action} requires id`);
  return id.trim();
}

function requireContent(content: string | undefined, action: string): string {
  if (!content?.trim()) throw new Error(`Memory.${action} requires content`);
  return content.trim();
}

function normalizeCategory(category: string): string {
  const clean = category.trim().replace(/^#+\s*/, "");
  return clean || "General";
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
