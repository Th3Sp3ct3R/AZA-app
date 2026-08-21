// Workspace checkpoints — lightweight DAG snapshots for sessions.
//
// Stores content blobs under .ares/checkpoints/blobs and checkpoint
// metadata under .ares/checkpoints/meta. This is intentionally local and
// VCS-agnostic: it can checkpoint untracked files too.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlobRef, CheckpointMeta } from "@ares/protocol";

/**
 * Is this workspace too broad to snapshot? A checkpoint of the user's HOME
 * directory (or a drive root) means hashing their entire digital life before
 * the first Write — minutes of dead time, locked app files (browser profiles),
 * and a restore that could touch everything they own. Real case: workspace
 * C:\Users\Clout hashed for 106s, hit a Chrome-locked cache under a sibling
 * agent home, and the EPERM killed the Write. Such workspaces get NO
 * checkpoints (tools run fine; undo is simply unavailable there).
 */
export function isUnsnapshotableWorkspace(workspace: string): boolean {
  const resolved = path.resolve(workspace);
  const home = path.resolve(os.homedir());
  if (resolved === home) return true;
  // home's parents (C:\Users, C:\) and filesystem roots
  if (home.startsWith(resolved + path.sep)) return true;
  return path.dirname(resolved) === resolved; // drive/fs root
}

const IGNORED_DIRS = new Set([
  ".git",
  ".ares",
  // Legacy pre-rename home left ~43k files (a Python voice-venv + old sessions)
  // that were being read+hashed before every single write/shell call.
  ".crix",
  // Sibling agent homes + Windows app data: browser profiles inside hold
  // LOCKED files (Chrome crx caches) that EPERM any reader while running.
  ".crypt",
  "AppData",
  "browser-profile",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
  // Common heavy state/venv/cache dirs that have no business in a snapshot.
  ".venv",
  "venv",
  "__pycache__",
  ".pnpm-store",
  ".turbo",
  ".cache",
  "out",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Per-process (path → mtime,size → hash) cache so a checkpoint re-hashes only
 * files that actually changed since the last snapshot. On a large workspace the
 * old behavior read+sha256'd every file before every write/shell tool call —
 * seconds of tax on the hottest coding path. With the cache, an unchanged file
 * costs one stat. Keyed by absolute path; the blob for a cached hash is assumed
 * present (verified cheaply on reuse).
 */
const fileHashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

/** Keep at most this many checkpoint metas per session; older ones are GC'd
 *  along with any blobs they solely referenced. Override with ARES_CHECKPOINT_RETENTION. */
function checkpointRetention(): number {
  const env = Number(process.env.ARES_CHECKPOINT_RETENTION);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 200;
}

export interface CreateCheckpointOptions {
  workspace: string;
  sessionId: string;
  turnSeq: number;
  parentCheckpointId?: string;
  label?: string;
  /** When the tool declares its exact target file(s) (Edit/Write — the HOT
   *  coding path), the checkpoint is INCREMENTAL: re-snapshot only those files
   *  layered on the parent's manifest, instead of walking the whole workspace.
   *  On a 30k-file repo that turns seconds-per-Edit into milliseconds. Tools
   *  with unknowable side effects (shells) omit this and get the full walk. */
  targetFiles?: readonly string[];
}

export async function createWorkspaceCheckpoint(opts: CreateCheckpointOptions): Promise<CheckpointMeta> {
  const manifest =
    (await incrementalManifest(opts).catch(() => null)) ?? (await fullManifest(opts.workspace));
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const id = sha256(
    JSON.stringify({
      parent: opts.parentCheckpointId ?? "",
      manifest: manifest.map((m) => `${m.path}:${m.blobHash}`).join("\n"),
    }),
  ).slice(0, 24);
  const meta: CheckpointMeta = {
    id,
    sessionId: opts.sessionId,
    turnSeq: opts.turnSeq,
    parentCheckpointId: opts.parentCheckpointId,
    label: opts.label,
    createdAt: new Date().toISOString(),
    fileManifest: manifest,
  };
  await fs.mkdir(metaDir(opts.workspace), { recursive: true });
  await fs.writeFile(path.join(metaDir(opts.workspace), `${id}.json`), JSON.stringify(meta, null, 2) + "\n", "utf8");
  // Throttled GC — a full meta+blob sweep on EVERY checkpoint was measurable
  // tax on the hottest coding path; every Nth keeps growth bounded all the same.
  if (++checkpointsSinceGc >= GC_EVERY) {
    checkpointsSinceGc = 0;
    await gcCheckpoints(opts.workspace).catch(() => {});
  }
  return meta;
}

let checkpointsSinceGc = 0;
const GC_EVERY = 25;

/** Full-walk manifest (parallel-stat; the base checkpoint + shell-tool path). */
async function fullManifest(workspace: string): Promise<BlobRef[]> {
  const files = await listWorkspaceFilesWithStats(workspace);
  const manifest: BlobRef[] = [];
  // Hash with bounded concurrency — unchanged files are one cache hit each.
  const CONC = 16;
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, files.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= files.length) return;
        const file = files[i];
        const hash = await hashFileCached(workspace, file.path, file.mtimeMs, file.size);
        if (hash === null) continue; // unreadable (locked/EPERM) — excluded from the snapshot
        manifest.push({ path: path.relative(workspace, file.path).replace(/\\/g, "/"), blobHash: hash, mode: 0o100644 });
      }
    }),
  );
  return manifest;
}

/** Incremental manifest: parent manifest + re-snapshot of ONLY the declared
 *  target files. Returns null (→ full walk) when there's no parent to layer on
 *  or no declared targets. */
async function incrementalManifest(opts: CreateCheckpointOptions): Promise<BlobRef[] | null> {
  if (!opts.targetFiles || opts.targetFiles.length === 0 || !opts.parentCheckpointId) return null;
  const parent = await loadWorkspaceCheckpoint(opts.workspace, opts.parentCheckpointId); // throws → full walk
  const byPath = new Map(parent.fileManifest.map((f) => [f.path, f]));
  for (const raw of opts.targetFiles) {
    const full = path.isAbsolute(raw) ? raw : path.join(opts.workspace, raw);
    const rel = path.relative(opts.workspace, full).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) continue; // outside the workspace — not snapshot territory
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
      byPath.delete(rel); // deleted (or no longer snapshotable) since the parent
      continue;
    }
    const hash = await hashFileCached(opts.workspace, full, stat.mtimeMs, stat.size);
    if (hash === null) continue; // unreadable — keep the parent's view of it
    byPath.set(rel, { path: rel, blobHash: hash, mode: 0o100644 });
  }
  return [...byPath.values()];
}

/** Blob hashes known to exist on disk this process. Replaces the per-file
 *  blob-existence stat on every cache hit (34k stats per checkpoint on a big
 *  repo). GC invalidates by deleting from this set. */
const knownBlobs = new Set<string>();

/** Hash a file, reusing the cached hash when mtime+size are unchanged AND the
 *  blob is known present (in-memory set; one stat only on first sighting).
 *  Re-reads only genuinely-changed files. Returns NULL when the file can't be
 *  read (EPERM/EBUSY — e.g. a browser's locked cache): an unreadable file is
 *  simply excluded from the snapshot. It must NEVER kill the checkpoint — a
 *  real turn died exactly this way (a locked Chrome profile under the
 *  workspace EPERM'd the walk and took the Write tool down with it). */
async function hashFileCached(workspace: string, full: string, mtimeMs: number, size: number): Promise<string | null> {
  const cached = fileHashCache.get(full);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    if (knownBlobs.has(cached.hash)) return cached.hash;
    const exists = await fs.stat(blobPath(workspace, cached.hash)).then(() => true).catch(() => false);
    if (exists) {
      knownBlobs.add(cached.hash);
      return cached.hash;
    }
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(full);
  } catch {
    return null; // locked/permission-denied — skip, never throw
  }
  const hash = sha256(bytes);
  await writeBlob(workspace, hash, bytes);
  fileHashCache.set(full, { mtimeMs, size, hash });
  knownBlobs.add(hash);
  return hash;
}

/** Prune checkpoint metas beyond the retention window (per session, newest
 *  kept), then delete blobs no surviving meta references. */
async function gcCheckpoints(workspace: string): Promise<void> {
  const retention = checkpointRetention();
  const metas = await listWorkspaceCheckpoints(workspace);
  // Group by session, keep newest `retention` per session.
  const bySession = new Map<string, CheckpointMeta[]>();
  for (const m of metas) {
    const arr = bySession.get(m.sessionId) ?? [];
    arr.push(m);
    bySession.set(m.sessionId, arr);
  }
  const survivors: CheckpointMeta[] = [];
  const doomed: CheckpointMeta[] = [];
  for (const arr of bySession.values()) {
    arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    survivors.push(...arr.slice(0, retention));
    doomed.push(...arr.slice(retention));
  }
  if (doomed.length === 0) return;
  for (const m of doomed) {
    await fs.rm(path.join(metaDir(workspace), `${m.id}.json`), { force: true }).catch(() => {});
  }
  // Sweep orphaned blobs: keep only hashes referenced by a surviving meta.
  const live = new Set<string>();
  for (const m of survivors) for (const ref of m.fileManifest) live.add(ref.blobHash);
  const blobsRoot = path.join(workspace, ".ares", "checkpoints", "blobs");
  const shards = await fs.readdir(blobsRoot).catch(() => [] as string[]);
  for (const shard of shards) {
    const shardDir = path.join(blobsRoot, shard);
    const blobs = await fs.readdir(shardDir).catch(() => [] as string[]);
    for (const hash of blobs) {
      if (!live.has(hash)) {
        await fs.rm(path.join(shardDir, hash), { force: true }).catch(() => {});
        knownBlobs.delete(hash); // keep the in-memory existence set honest
      }
    }
  }
}

export async function listWorkspaceCheckpoints(workspace: string): Promise<CheckpointMeta[]> {
  const entries = await fs.readdir(metaDir(workspace)).catch(() => []);
  const metas = await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await fs.readFile(path.join(metaDir(workspace), name), "utf8")) as CheckpointMeta),
  );
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadWorkspaceCheckpoint(workspace: string, id: string): Promise<CheckpointMeta> {
  return JSON.parse(await fs.readFile(path.join(metaDir(workspace), `${id}.json`), "utf8")) as CheckpointMeta;
}

export async function diffWorkspaceCheckpoint(
  workspace: string,
  id: string,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const current = new Map((await fullManifest(workspace)).map((file) => [file.path, file.blobHash]));
  const snap = new Map(checkpoint.fileManifest.map((f) => [f.path, f.blobHash]));
  const added = [...current.keys()].filter((p) => !snap.has(p)).sort();
  const deleted = [...snap.keys()].filter((p) => !current.has(p)).sort();
  const modified = [...current.entries()]
    .filter(([p, hash]) => snap.has(p) && snap.get(p) !== hash)
    .map(([p]) => p)
    .sort();
  return { added, modified, deleted };
}

export async function restoreWorkspaceCheckpoint(workspace: string, id: string): Promise<{ restored: number; deleted: number }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const manifest = new Map(checkpoint.fileManifest.map((f) => [f.path, f]));
  const current = await listWorkspaceFiles(workspace);
  let deleted = 0;
  for (const file of current) {
    const rel = path.relative(workspace, file).replace(/\\/g, "/");
    if (!manifest.has(rel)) {
      await fs.rm(file, { force: true });
      deleted++;
    }
  }
  let restored = 0;
  for (const ref of checkpoint.fileManifest) {
    const target = path.join(workspace, ref.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(blobPath(workspace, ref.blobHash), target);
    restored++;
  }
  return { restored, deleted };
}

export async function diffWorkspaceCheckpointUnified(
  workspace: string,
  id: string,
  files?: readonly string[],
  opts: { maxChars?: number; contextLines?: number } = {},
): Promise<{ diff: string; files: string[]; truncated: boolean }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const manifest = new Map(checkpoint.fileManifest.map((f) => [f.path, f]));
  // When the caller names the files (the per-tool touchedFiles diff — the hot
  // path), stat ONLY those instead of walking the whole workspace again.
  const currentStats = new Map<string, { path: string; mtimeMs: number; size: number }>();
  let currentFiles: Set<string>;
  let requested: string[];
  if (files?.length) {
    requested = [...new Set(files.map((file) => normalizeRel(workspace, file)))];
    currentFiles = new Set<string>();
    await Promise.all(
      requested.map(async (rel) => {
        const full = path.join(workspace, rel);
        const fileStat = await fs.stat(full).catch(() => null);
        if (fileStat?.isFile() && fileStat.size <= MAX_FILE_BYTES) {
          currentFiles.add(rel);
          currentStats.set(rel, { path: full, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
        }
      }),
    );
  } else {
    const filesWithStats = await listWorkspaceFilesWithStats(workspace);
    for (const file of filesWithStats) currentStats.set(relPath(workspace, file.path), file);
    currentFiles = new Set(currentStats.keys());
    requested = [...new Set([...manifest.keys(), ...currentFiles])].sort();
  }
  const maxChars = opts.maxChars ?? 40_000;
  const contextLines = opts.contextLines ?? 3;
  const parts: string[] = [];
  const changedFiles: string[] = [];
  let size = 0;
  let truncated = false;

  for (const rel of requested) {
    const ref = manifest.get(rel);
    const currentPath = path.join(workspace, rel);
    const currentStat = currentStats.get(rel);
    if (ref && currentStat) {
      const currentHash = await hashFileCached(workspace, currentStat.path, currentStat.mtimeMs, currentStat.size);
      if (currentHash === ref.blobHash) continue;
    }

    changedFiles.push(rel);
    if (truncated) continue; // keep enumerating file names; only patch text is capped
    const before = ref ? await fs.readFile(blobPath(workspace, ref.blobHash), "utf8").catch(() => "") : "";
    const after = currentFiles.has(rel) ? await fs.readFile(currentPath, "utf8").catch(() => "") : "";
    const patch = unifiedFileDiff(rel, before, after, contextLines);
    if (!patch) continue;
    if (size + patch.length > maxChars) {
      const remaining = Math.max(0, maxChars - size);
      if (remaining > 0) parts.push(patch.slice(0, remaining));
      truncated = true;
      continue;
    }
    parts.push(patch);
    size += patch.length;
  }

  return { diff: parts.join("\n"), files: changedFiles, truncated };
}

async function listWorkspaceFiles(workspace: string): Promise<string[]> {
  return (await listWorkspaceFilesWithStats(workspace)).map((f) => f.path);
}

async function listWorkspaceFilesWithStats(
  workspace: string,
): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const subdirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) subdirs.push(full);
      else if (entry.isFile()) files.push(full);
    }
    // Stat this directory's files CONCURRENTLY — the old one-await-per-file
    // pattern serialized ~34k round-trips through the fs (and the AV scanner).
    await Promise.all(
      files.map(async (full) => {
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.size <= MAX_FILE_BYTES) out.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }),
    );
    await Promise.all(subdirs.map((sub) => walk(sub)));
  }
  await walk(workspace);
  return out;
}

function unifiedFileDiff(rel: string, before: string, after: string, contextLines: number): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldStart = Math.max(0, prefix - contextLines);
  const newStart = Math.max(0, prefix - contextLines);
  const oldEnd = Math.min(beforeLines.length, beforeLines.length - suffix + contextLines);
  const newEnd = Math.min(afterLines.length, afterLines.length - suffix + contextLines);
  const oldCount = Math.max(0, oldEnd - oldStart);
  const newCount = Math.max(0, newEnd - newStart);
  const out = [`--- a/${rel}`, `+++ b/${rel}`, `@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`];

  const commonBefore = Math.min(prefix, oldEnd) - oldStart;
  for (let idx = 0; idx < commonBefore; idx++) out.push(` ${beforeLines[oldStart + idx]}`);

  for (let idx = prefix; idx < beforeLines.length - suffix; idx++) {
    if (idx >= oldStart && idx < oldEnd) out.push(`-${beforeLines[idx]}`);
  }
  for (let idx = prefix; idx < afterLines.length - suffix; idx++) {
    if (idx >= newStart && idx < newEnd) out.push(`+${afterLines[idx]}`);
  }

  const oldTailStart = Math.max(prefix, beforeLines.length - suffix);
  for (let idx = oldTailStart; idx < oldEnd; idx++) out.push(` ${beforeLines[idx]}`);
  return out.join("\n") + "\n";
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function relPath(workspace: string, file: string): string {
  return path.relative(workspace, file).replace(/\\/g, "/");
}

function normalizeRel(workspace: string, file: string): string {
  return path.isAbsolute(file) ? relPath(workspace, file) : file.replace(/\\/g, "/");
}

async function writeBlob(workspace: string, hash: string, bytes: Buffer): Promise<void> {
  const file = blobPath(workspace, hash);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, bytes, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

function blobPath(workspace: string, hash: string): string {
  return path.join(workspace, ".ares", "checkpoints", "blobs", hash.slice(0, 2), hash);
}

function metaDir(workspace: string): string {
  return path.join(workspace, ".ares", "checkpoints", "meta");
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
