// Global session-location registry.
//
// Session rollouts deliberately live beside their workspaces, which means a
// scheduled reliability pass cannot discover "every session" from ARES_HOME
// alone. Each live session therefore leaves one small atomic pointer record in
// the global telemetry home. Records are one-file-per-session so independent
// processes never interleave JSONL appends or contend on one shared index.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { aresHome } from "./providers/openaiAuth.js";

export type SessionLocationSource = "core" | "garrison";
export type SessionRolloutFormat = "core-rollout-v1" | "garrison-rollout-v1";

export interface SessionLocationRecord {
  schemaVersion: 1;
  sessionId: string;
  source: SessionLocationSource;
  format: SessionRolloutFormat;
  /** Stable correlation key; the raw workspace is intentionally not duplicated. */
  workspaceHash: string;
  /** Absolute source pointer. This is the purpose of the local-only registry. */
  rolloutPath: string;
  metaPath?: string;
  updatedAt: string;
}

/** Public reader name used by the reliability/triage layer. */
export type SessionLocation = SessionLocationRecord;

export interface RegisterSessionLocationInput {
  sessionId: string;
  source: SessionLocationSource;
  format: SessionRolloutFormat;
  workspace: string;
  rolloutPath: string;
  metaPath?: string;
}

export interface SessionRegistryOptions {
  /** Explicit directory for isolated tests/portable runtimes. */
  dir?: string;
  /** Explicit Ares home. Ignored when dir is provided. */
  home?: string;
}

export function sessionLocationRegistryDir(home = aresHome()): string {
  return path.join(home, "telemetry", "session-locations");
}

/** Hash a normalized absolute workspace identity without persisting the path. */
export function hashWorkspaceIdentity(workspace: string): string {
  let normalized = path.resolve(workspace).replace(/\\/g, "/");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/** Stable file name for one session. Standard sess_UUID ids remain readable. */
export function sessionLocationFile(dir: string, source: SessionLocationSource, sessionId: string): string {
  const readable = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "session";
  const suffix = createHash("sha256").update(`${source}\0${sessionId}`).digest("hex").slice(0, 10);
  return path.join(dir, `${source}-${readable}-${suffix}.json`);
}

/**
 * Best-effort registration. Observability must never fail a live turn.
 *
 * node:test constructs real Sessions; an implicit/default registry is disabled
 * there so tests cannot contaminate the owner's home. Supplying dir/home is an
 * explicit isolation boundary and remains enabled for focused tests.
 */
export async function registerSessionLocation(
  input: RegisterSessionLocationInput,
  options: SessionRegistryOptions = {},
): Promise<string | null> {
  const explicit = options.dir !== undefined || options.home !== undefined;
  if (process.env.NODE_TEST_CONTEXT && !explicit) return null;
  try {
    const dir = options.dir ?? sessionLocationRegistryDir(options.home);
    const file = sessionLocationFile(dir, input.source, input.sessionId);
    const record: SessionLocationRecord = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      source: input.source,
      format: input.format,
      workspaceHash: hashWorkspaceIdentity(input.workspace),
      rolloutPath: path.resolve(input.rolloutPath),
      ...(input.metaPath ? { metaPath: path.resolve(input.metaPath) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeSessionLocationAtomic(file, record);
    return file;
  } catch {
    return null;
  }
}

/** Atomic rewrite used by registration and directly exercised by tests. */
export async function writeSessionLocationAtomic(file: string, record: SessionLocationRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2) + "\n", "utf8");
  try {
    await rename(temp, file);
    await rm(`${file}.bak`, { force: true }).catch(() => undefined);
    return;
  } catch {
    // Windows does not consistently replace an existing destination. Preserve
    // the prior valid record until the fully-written temp is ready, and restore
    // it if promotion fails.
  }

  const backup = `${file}.bak`;
  const liveValid = await readSessionLocationFile(file) !== null;
  let backedUp = await readFile(backup).then(() => true).catch(() => false);
  if (liveValid) {
    await rm(backup, { force: true }).catch(() => undefined);
    backedUp = false;
    try {
      await rename(file, backup);
      backedUp = true;
    } catch {
      // Another process may have moved/replaced the old record.
    }
  } else {
    await rm(file, { force: true }).catch(() => undefined);
  }
  try {
    await rename(temp, file);
  } catch (error) {
    if (backedUp) await rename(backup, file).catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (backedUp) await rm(backup, { force: true }).catch(() => undefined);
}

export async function readSessionLocation(file: string): Promise<SessionLocationRecord | null> {
  const primary = await readSessionLocationFile(file);
  if (primary) return primary;
  const backup = await readSessionLocationFile(`${file}.bak`);
  if (!backup) return null;
  return backup;
}

async function readSessionLocationFile(file: string): Promise<SessionLocationRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as SessionLocationRecord;
    return parsed?.schemaVersion === 1 && typeof parsed.sessionId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** List every valid registry pointer, newest first; corrupt/temp files are skipped. */
export async function listRegisteredSessionLocations(
  optionsOrDir: SessionRegistryOptions | string = {},
): Promise<SessionLocation[]> {
  const options = typeof optionsOrDir === "string" ? { dir: optionsOrDir } : optionsOrDir;
  const explicit = options.dir !== undefined || options.home !== undefined;
  if (process.env.NODE_TEST_CONTEXT && !explicit) return [];
  const dir = options.dir ?? sessionLocationRegistryDir(options.home);
  const names = await readdir(dir).catch(() => [] as string[]);
  const liveNames = new Set(
    names
      .map((name) => name.endsWith(".json.bak") ? name.slice(0, -4) : name)
      .filter((name) => name.endsWith(".json")),
  );
  const records = await Promise.all(
    [...liveNames]
      .map((name) => readSessionLocation(path.join(dir, name))),
  );
  return records
    .filter((record): record is SessionLocation => record !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
