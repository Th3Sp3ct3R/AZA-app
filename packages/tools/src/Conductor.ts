// Conductor.ts — the model-facing shell over the deterministic runFleet runtime.
//
// The Ares agent AUTHORS a flat FleetSpec (the hardest element it faces is a
// shape-EXAMPLE object, not a JSON-Schema) and the runtime executes it
// start-to-finish. All the stateful failure modes — concurrency caps, abort
// cascade, schema retry, budget abort, pipeline barrier, journaling — live in
// runFleet, which the model never touches. Robust on ANY provider because every
// leaf inherits the parent's provider/model via runForkedTurn.
//
// This file owns the zod binding (the @ares/core runtime is deliberately
// zod-free). The schema seam is derived from a shape-EXAMPLE object so weak
// models can express "I want {summary:'...', score: 0}" without authoring a JSON
// Schema.

import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  rm,
  cp,
  readdir,
  readFile,
  readlink,
  lstat,
  symlink,
  writeFile,
  rename,
  stat,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { EngineTool, Provider, QueryEngineConfig, SessionKernelStore, WorkspaceMutationOperation } from "@ares/core";
import {
  applyWorkspaceMutation,
  runFleet,
  workspaceContentHash,
  type ConductorDeps,
  type FleetSpec,
  type LeafValidator,
  type SchemaHinter,
  type ValidatorResult,
  type Worktree,
} from "@ares/core";
import { buildTool } from "./_shared.js";

interface SnapshotFile {
  hash: string;
  mode: number;
  kind?: "file" | "symlink";
}

interface PersistedBranchBase {
  version: 2;
  workspace: string;
  label: string;
  durableKey: string;
  files: Array<[string, SnapshotFile]>;
  dependencyProjection: "materialized-cow-v1";
  dependencies: Array<[string, string]>;
}

const SNAPSHOT_EXCLUDES = new Set([".git", ".ares", "node_modules"]);
const DURABLE_BRANCH_INIT_GRACE_MS = 30_000;

function ignoredSnapshotPath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (!rel || rel === ".") return false;
  return rel.split(path.sep).some((part) => SNAPSHOT_EXCLUDES.has(part));
}

async function snapshotManifest(root: string, dir = root, out = new Map<string, SnapshotFile>()): Promise<Map<string, SnapshotFile>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (ignoredSnapshotPath(root, full)) continue;
    if (entry.isDirectory()) {
      await snapshotManifest(root, full, out);
      continue;
    }
    const info = await lstat(full);
    if (entry.isFile()) {
      const bytes = await readFile(full);
      out.set(path.relative(root, full), {
        hash: workspaceContentHash(bytes),
        mode: info.mode & 0o7777,
        kind: "file",
      });
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(full);
      out.set(path.relative(root, full), {
        hash: workspaceContentHash(Buffer.from(target, "utf8")),
        mode: info.mode & 0o7777,
        kind: "symlink",
      });
      continue;
    }
    throw new Error(`Conductor cannot snapshot unsupported filesystem entry: ${full}`);
  }
  return out;
}

interface DependencyFileCopy {
  source: string;
  target: string;
  mode: number;
}

interface DependencyLinkCopy {
  source: string;
  target: string;
}

/** True when `candidate` is the root itself or a descendant. This is used for
 * dependency-link validation, not user path authorization. */
function pathInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: count }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

/**
 * Materialize one dependency tree into the branch. `COPYFILE_FICLONE` asks the
 * filesystem for reflink/copy-on-write clones and portably falls back to a
 * normal byte copy when clones are unsupported (including ordinary NTFS).
 * Never use hard links: writes through a hard link would still mutate owner
 * bytes. Internal package-manager links are rewritten into the branch; an
 * external link fails closed because it cannot be isolated truthfully.
 */
async function materializeDependencyTree(
  mainRoot: string,
  branchRoot: string,
  sourceRoot: string,
  targetRoot: string,
): Promise<void> {
  const directories: Array<{ source: string; target: string; mode: number }> = [];
  const files: DependencyFileCopy[] = [];
  const links: DependencyLinkCopy[] = [];
  const pending = [{ source: sourceRoot, target: targetRoot }];

  while (pending.length > 0) {
    const current = pending.pop()!;
    const currentInfo = await lstat(current.source);
    directories.push({ source: current.source, target: current.target, mode: currentInfo.mode & 0o7777 });
    const entries = await readdir(current.source, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(current.source, entry.name);
      const target = path.join(current.target, entry.name);
      if (entry.isDirectory()) {
        pending.push({ source, target });
      } else if (entry.isFile()) {
        const info = await lstat(source);
        files.push({ source, target, mode: info.mode & 0o7777 });
      } else if (entry.isSymbolicLink()) {
        links.push({ source, target });
      } else {
        throw new Error(`Conductor cannot isolate unsupported dependency entry: ${source}`);
      }
    }
  }

  // Create every directory before links. Windows junction creation requires
  // the projected target to exist, and package-manager links frequently point
  // sideways into a sibling `.pnpm` directory.
  directories.sort((a, b) => a.target.length - b.target.length);
  for (const directory of directories) {
    await mkdir(directory.target, { recursive: true });
    if (process.platform !== "win32") await chmod(directory.target, directory.mode);
  }
  await runBounded(files, 24, async (file) => {
    await copyFile(file.source, file.target, fsConstants.COPYFILE_FICLONE);
    if (process.platform !== "win32") await chmod(file.target, file.mode);
  });
  for (const link of links) {
    const rawTarget = await readlink(link.source);
    const ownerTarget = path.resolve(path.dirname(link.source), rawTarget);
    if (!pathInside(mainRoot, ownerTarget)) {
      throw new Error(
        `Conductor cannot safely isolate dependency link '${link.source}' because it resolves outside ` +
          `the owner workspace (${ownerTarget}). Materialize that dependency inside the project or disable ` +
          `parallel worktree isolation for this phase.`,
      );
    }
    const projectedTarget = path.join(branchRoot, path.relative(mainRoot, ownerTarget));
    const targetInfo = await stat(link.source);
    const projectedLink = process.platform === "win32"
      ? projectedTarget
      : path.relative(path.dirname(link.target), projectedTarget) || ".";
    await symlink(
      projectedLink,
      link.target,
      targetInfo.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file",
    );
  }
}

async function dependencyTreeDigest(branchRoot: string, dependencyRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const pending = [dependencyRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      const full = path.join(current, entry.name);
      const rel = path.relative(dependencyRoot, full).replaceAll(path.sep, "/");
      const info = await lstat(full);
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0${info.mode & 0o7777}\0`);
        pending.push(full);
      } else if (entry.isFile()) {
        hash.update(`f\0${rel}\0${info.mode & 0o7777}\0`);
        hash.update(await readFile(full));
        hash.update("\0");
      } else if (entry.isSymbolicLink()) {
        const rawTarget = await readlink(full);
        const resolvedTarget = path.resolve(path.dirname(full), rawTarget);
        if (!pathInside(branchRoot, resolvedTarget)) {
          throw new Error(
            `Conductor dependency projection contains an escaping link '${full}' -> '${resolvedTarget}'. ` +
              `The branch is blocked before it can be resumed or integrated.`,
          );
        }
        hash.update(`l\0${rel}\0${info.mode & 0o7777}\0${rawTarget}\0`);
      } else {
        throw new Error(`Conductor cannot inspect unsupported dependency entry: ${full}`);
      }
    }
  }
  return hash.digest("hex");
}

/** Find every project-local node_modules tree and give the branch independent
 * bytes. Dependency roots are excluded from project mutation settlement; a
 * digest drift blocks integration explicitly instead of silently merging a
 * derived tree or mutating owner state through a shared junction. */
async function materializeDependencyTrees(
  mainRoot: string,
  branchRoot: string,
  dir = mainRoot,
  projections = new Map<string, string>(),
): Promise<Map<string, string>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return projections;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === ".ares") continue;
    const source = path.join(dir, entry.name);
    if (entry.name === "node_modules") {
      const rel = path.relative(mainRoot, source);
      const target = path.join(branchRoot, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await materializeDependencyTree(mainRoot, branchRoot, source, target);
      projections.set(rel, await dependencyTreeDigest(branchRoot, target));
      continue;
    }
    await materializeDependencyTrees(mainRoot, branchRoot, source, projections);
  }
  return projections;
}

async function changedDependencyRoots(
  branchRoot: string,
  base: ReadonlyMap<string, string>,
): Promise<string[]> {
  const changed = new Set<string>();
  const currentRoots = await discoverDependencyRoots(branchRoot);
  for (const rel of currentRoots) if (!base.has(rel)) changed.add(rel);
  for (const [rel, digest] of base) {
    const root = path.join(branchRoot, rel);
    let current: string;
    try {
      current = await dependencyTreeDigest(branchRoot, root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") current = "<missing>";
      else throw error;
    }
    if (current !== digest) changed.add(rel);
  }
  return [...changed].sort();
}

async function discoverDependencyRoots(
  root: string,
  dir = root,
  out = new Set<string>(),
): Promise<Set<string>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === ".ares") continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "node_modules") {
      out.add(path.relative(root, full));
      continue;
    }
    await discoverDependencyRoots(root, full, out);
  }
  return out;
}

/** Copy the owner's workspace contents rather than asking fs.cp to copy the
 * workspace root wholesale. Durable branches live below `<workspace>/.ares`,
 * so a root-to-descendant cp is rejected by Node before its exclusion filter
 * can prove `.ares` is skipped. Per-entry copies preserve the same exclusion
 * contract and make recursion structurally impossible. */
async function copyWorkspaceContents(mainRoot: string, branchRoot: string): Promise<void> {
  await mkdir(branchRoot, { recursive: true });
  const entries = await readdir(mainRoot, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(mainRoot, entry.name);
    if (ignoredSnapshotPath(mainRoot, source)) continue;
    await cp(source, path.join(branchRoot, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (candidate) => !ignoredSnapshotPath(mainRoot, candidate),
    });
  }
  await rewriteWorkspaceLinks(mainRoot, branchRoot);
}

/** `fs.cp` preserves symlinks, but a Windows junction normally stores an
 * absolute target. Re-point every copied internal link into the branch before
 * a child can receive it; reject external links because preserving one would
 * punch a writable path out of the isolation boundary. */
async function rewriteWorkspaceLinks(
  mainRoot: string,
  branchRoot: string,
  dir = mainRoot,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(dir, entry.name);
    if (ignoredSnapshotPath(mainRoot, source)) continue;
    if (entry.isDirectory()) {
      await rewriteWorkspaceLinks(mainRoot, branchRoot, source);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const rawTarget = await readlink(source);
    const ownerTarget = path.resolve(path.dirname(source), rawTarget);
    if (!pathInside(mainRoot, ownerTarget)) {
      throw new Error(
        `Conductor cannot safely isolate workspace link '${source}' because it resolves outside ` +
          `the owner workspace (${ownerTarget}).`,
      );
    }
    if (ignoredSnapshotPath(mainRoot, ownerTarget)) {
      throw new Error(
        `Conductor workspace link '${source}' targets excluded runtime state (${ownerTarget}); ` +
          `the branch is blocked rather than sharing that state.`,
      );
    }
    const target = path.join(branchRoot, path.relative(mainRoot, source));
    const projectedTarget = path.join(branchRoot, path.relative(mainRoot, ownerTarget));
    const targetInfo = await stat(source);
    await rm(target, { recursive: true, force: true });
    await symlink(
      process.platform === "win32"
        ? projectedTarget
        : path.relative(path.dirname(target), projectedTarget) || ".",
      target,
      targetInfo.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file",
    );
  }
}

async function changedSnapshotFiles(
  branchRoot: string,
  base: ReadonlyMap<string, SnapshotFile>,
): Promise<{ files: string[]; current: Map<string, SnapshotFile> }> {
  const current = await snapshotManifest(branchRoot);
  const files = new Set<string>();
  for (const [rel, before] of base) {
    const after = current.get(rel);
    if (after?.hash !== before.hash || after?.mode !== before.mode || (after?.kind ?? "file") !== (before.kind ?? "file")) {
      files.add(rel);
    }
  }
  for (const rel of current.keys()) if (!base.has(rel)) files.add(rel);
  return { files: [...files].sort(), current };
}

function durableBranchDigest(mainWorkspace: string, durableKey: string): string {
  return createHash("sha256")
    .update("ares-conductor-branch-v1\0")
    .update(path.resolve(mainWorkspace))
    .update("\0")
    .update(durableKey)
    .digest("hex");
}

async function readPersistedBranchBase(
  statePath: string,
  expectedWorkspace: string,
  label: string,
  durableKey: string,
): Promise<{ base: Map<string, SnapshotFile>; dependencies: Map<string, string> }> {
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<PersistedBranchBase>;
  if (
    parsed.version !== 2 ||
    parsed.workspace !== expectedWorkspace ||
    parsed.label !== label ||
    parsed.durableKey !== durableKey ||
    !Array.isArray(parsed.files) ||
    parsed.dependencyProjection !== "materialized-cow-v1" ||
    !Array.isArray(parsed.dependencies)
  ) {
    throw new Error(
      `durable Conductor branch metadata does not match the isolated v2 contract for ${durableKey}. ` +
        `Legacy branches that shared dependency junctions are intentionally fail-closed and must be recreated.`,
    );
  }
  const files = new Map<string, SnapshotFile>();
  for (const entry of parsed.files) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !entry[1] ||
      typeof entry[1].hash !== "string" ||
      typeof entry[1].mode !== "number" ||
      (entry[1].kind !== undefined && entry[1].kind !== "file" && entry[1].kind !== "symlink")
    ) {
      throw new Error(`durable Conductor branch metadata is malformed: ${statePath}`);
    }
    files.set(entry[0], {
      hash: entry[1].hash,
      mode: entry[1].mode & 0o7777,
      kind: entry[1].kind ?? "file",
    });
  }
  const dependencies = new Map<string, string>();
  for (const entry of parsed.dependencies) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !entry[1]
    ) {
      throw new Error(`durable Conductor dependency metadata is malformed: ${statePath}`);
    }
    dependencies.set(entry[0], entry[1]);
  }
  return { base: files, dependencies };
}

async function openDurableBranch(
  mainWorkspace: string,
  label: string,
  durableKey: string,
): Promise<{
  root: string;
  dir: string;
  base: Map<string, SnapshotFile>;
  dependencies: Map<string, string>;
}> {
  const workspace = path.resolve(mainWorkspace);
  const digest = durableBranchDigest(workspace, durableKey);
  // Durable child effects must survive reboot and OS temp cleanup. `.ares` is
  // excluded from every branch snapshot, so this owner-local store is durable
  // without recursively copying branch state into its own descendants.
  const parent = path.join(workspace, ".ares", "conductor-branches");
  const root = path.join(parent, digest);
  const dir = path.join(root, "workspace");
  const statePath = path.join(root, "base.json");
  await mkdir(parent, { recursive: true });

  let ownsInitialization = false;
  try {
    await mkdir(root);
    ownsInitialization = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (ownsInitialization) {
    try {
      await copyWorkspaceContents(workspace, dir);
      const dependencies = await materializeDependencyTrees(workspace, dir);
      const base = await snapshotManifest(dir);
      const persisted: PersistedBranchBase = {
        version: 2,
        workspace,
        label,
        durableKey,
        files: [...base.entries()],
        dependencyProjection: "materialized-cow-v1",
        dependencies: [...dependencies.entries()],
      };
      const pendingState = `${statePath}.${process.pid}.tmp`;
      await writeFile(pendingState, JSON.stringify(persisted), "utf8");
      await rename(pendingState, statePath);
      return { root, dir, base, dependencies };
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  // A second process can arrive while the first is still copying. Give the
  // atomic ready marker a brief chance to appear. A root left incomplete by a
  // dead process is only reclaimed after the normal 30s lease window, when no
  // child could have received this branch (makeCopyWorktree had not returned).
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const persisted = await readPersistedBranchBase(statePath, workspace, label, durableKey);
      // Computing the digest also rejects dependency links that were changed
      // to escape the isolated branch before a restarted child receives it.
      for (const rel of persisted.dependencies.keys()) {
        await dependencyTreeDigest(dir, path.join(dir, rel));
      }
      return { root, dir, base: persisted.base, dependencies: persisted.dependencies };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  const ageMs = Date.now() - (await stat(root)).mtimeMs;
  if (ageMs >= DURABLE_BRANCH_INIT_GRACE_MS) {
    await rm(root, { recursive: true, force: true });
    return openDurableBranch(workspace, label, durableKey);
  }
  throw new Error(
    `durable Conductor branch '${durableKey}' is still initializing at ${root}; retry after the session lease window`,
  );
}

/** A complete copy-on-write workspace branch. It includes tracked, untracked,
 * and dirty owner files; records a byte-hash base; detects adds/updates/deletes;
 * and integrates through one CAS mutation transaction. A parent edit after the
 * fork therefore conflicts cleanly instead of being overwritten. */
export async function makeCopyWorktree(
  mainWorkspace: string,
  label: string,
  durableKey?: string,
): Promise<Worktree> {
  let root: string;
  let dir: string;
  let base: Map<string, SnapshotFile>;
  let dependencyBase: Map<string, string>;
  if (durableKey) {
    ({ root, dir, base, dependencies: dependencyBase } = await openDurableBranch(mainWorkspace, label, durableKey));
  } else {
    const safe = label.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 48);
    root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), `ares-fleet-${safe}-`)),
    );
    dir = path.join(root, "workspace");
    try {
      await copyWorkspaceContents(path.resolve(mainWorkspace), dir);
      dependencyBase = await materializeDependencyTrees(path.resolve(mainWorkspace), dir);
      base = await snapshotManifest(dir);
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  const prepareApply = async (ownerWorkspace: string) => {
    const dependencyChanges = await changedDependencyRoots(dir, dependencyBase);
    if (dependencyChanges.length > 0) {
      throw new Error(
        `Conductor branch modified isolated dependency projection(s): ${dependencyChanges.join(", ")}. ` +
          `Dependency trees are branch-local execution inputs and are never merged into the owner. ` +
          `Keep manifest/lockfile changes, regenerate dependencies in the owner after integration, and ` +
          `revert these dependency-tree changes before retrying this retained branch.`,
      );
    }
    const { files, current } = await changedSnapshotFiles(dir, base);
    const main = await snapshotManifest(ownerWorkspace);
    const alreadyApplied: string[] = [];
    const operations: WorkspaceMutationOperation[] = [];
    for (const rel of files) {
      const before = base.get(rel);
      const after = current.get(rel);
      const mainNow = main.get(rel);
      const matchesAfter = after
        ? mainNow?.hash === after.hash &&
          mainNow.mode === after.mode &&
          (mainNow.kind ?? "file") === (after.kind ?? "file")
        : mainNow === undefined;
      if (matchesAfter) {
        alreadyApplied.push(rel);
        continue;
      }
      if ((before?.kind ?? "file") !== "file" || (after?.kind ?? "file") !== "file") {
        throw new Error(
          `Conductor branch changed symbolic link '${rel}'. Symlink settlement is intentionally rejected ` +
            `before owner mutation; preserve the durable branch and apply that link change explicitly.`,
        );
      }
      if (!before && after) {
        operations.push({
          kind: "add",
          path: rel,
          content: await readFile(path.join(dir, rel)),
          mode: after.mode,
        });
      } else if (before && !after) {
        operations.push({
          kind: "delete",
          path: rel,
          expectedHash: before.hash,
          expectedMode: before.mode,
        });
      } else if (before && after) {
        operations.push({
          kind: "update",
          path: rel,
          content: await readFile(path.join(dir, rel)),
          expectedHash: before.hash,
          expectedMode: before.mode,
          mode: after.mode,
        });
      }
    }
    return { operations, alreadyApplied, files };
  };
  return {
    dir,
    lifetime: durableKey ? "durable" : "disposable",
    changedFiles: async () => {
      const dependencyChanges = await changedDependencyRoots(dir, dependencyBase);
      const projectChanges = (await changedSnapshotFiles(dir, base)).files;
      return [
        ...projectChanges,
        ...dependencyChanges.map((rel) =>
          `${rel.split(path.sep).join("/")}/<dependency-projection-modified>`
        ),
      ].sort();
    },
    prepareApply: async (ownerWorkspace: string) => {
      const prepared = await prepareApply(ownerWorkspace);
      return { operations: prepared.operations, alreadyApplied: prepared.alreadyApplied };
    },
    applyTo: async (mainWorkspace: string) => {
      let prepared: Awaited<ReturnType<typeof prepareApply>>;
      try {
        prepared = await prepareApply(mainWorkspace);
      } catch (error) {
        return {
          applied: [],
          failed: [{
            rel: "<branch-isolation>",
            err: error instanceof Error ? error.message : String(error),
          }],
        };
      }
      const { files, operations, alreadyApplied } = prepared;
      if (files.length === 0) return { applied: [], failed: [] };
      if (operations.length === 0) return { applied: alreadyApplied, failed: [] };
      try {
        const receipt = await applyWorkspaceMutation(mainWorkspace, operations, {
          label: `Conductor ${label}`,
          ...(durableKey
            ? { transactionId: `conductor_${durableBranchDigest(mainWorkspace, durableKey).slice(0, 48)}` }
            : {}),
        });
        return {
          applied: [
            ...alreadyApplied,
            ...receipt.touchedFiles.map((file) => path.relative(mainWorkspace, file)),
          ],
          failed: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pending = files.filter((rel) => !alreadyApplied.includes(rel));
        return { applied: alreadyApplied, failed: pending.map((rel) => ({ rel, err: message })) };
      }
    },
    cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined),
  };
}

export interface ConductorToolDeps {
  provider: Provider;
  model: string;
  /** The parent catalog children are scoped from. MUST exclude the Conductor
   *  itself (and Task/Operator) to block recursive fleets — runFleet also rejects
   *  any whitelist naming those, but keep them out of the catalog too. */
  parentTools: readonly EngineTool[];
  baseSystemPrompt: string | (() => string | Promise<string>);
  subModel?: { summarize(req: { input: string; instructions?: string }): Promise<string> };
  summarizeSpan?: QueryEngineConfig["summarizeSpan"];
  defaultMaxTurns?: number;
  /** Unattended posture (default): non-read-only tools are stripped from each
   *  leaf's catalog so a child can't deny-loop on a human-gated tool. Set true
   *  only when the host arranged non-interactive auto-approve for writers. */
  allowWriteTools?: boolean;
  /** Policy-aware leaf permission (the owner's "fleets inherit my permissions"
   *  toggle). Forwarded to runFleet; absent → leaves deny everything. */
  leafRequestPermission?: ConductorDeps["leafRequestPermission"];
  sessionKernel?: SessionKernelStore;
  /** Roster persona resolver for FleetAgentSpec.persona (the host wires the
   *  ~/.ares roster here). Absent → persona names are ignored with a hint. */
  resolvePersona?: ConductorDeps["resolvePersona"];
}

// ─── Shape-example → validator + hint ──────────────────────────────────────
//
// A shape-example is a plain object whose VALUES illustrate the expected types:
//   { "summary": "a one-line gist", "score": 0, "risks": ["..."] }
// We validate a candidate by structural type-match per key (string/number/
// boolean/array/object), tolerating extra keys (weak models add noise) and
// requiring every example key to be present with a type-compatible value.

type JsonType = "string" | "number" | "boolean" | "array" | "object" | "null";

function typeOfValue(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t as JsonType;
  return "string";
}

function matchShape(example: unknown, candidate: unknown, pathStr: string, issues: string[]): void {
  const et = typeOfValue(example);
  const ct = typeOfValue(candidate);
  if (et === "object") {
    if (ct !== "object") {
      issues.push(`${pathStr || "root"}: expected object, got ${ct}`);
      return;
    }
    const ex = example as Record<string, unknown>;
    const ca = candidate as Record<string, unknown>;
    for (const key of Object.keys(ex)) {
      if (!(key in ca)) {
        issues.push(`${pathStr ? pathStr + "." : ""}${key}: missing`);
        continue;
      }
      matchShape(ex[key], ca[key], `${pathStr ? pathStr + "." : ""}${key}`, issues);
    }
    return;
  }
  if (et === "array") {
    if (ct !== "array") {
      issues.push(`${pathStr || "root"}: expected array, got ${ct}`);
      return;
    }
    const exArr = example as unknown[];
    if (exArr.length > 0) {
      for (let i = 0; i < (candidate as unknown[]).length; i++) {
        matchShape(exArr[0], (candidate as unknown[])[i], `${pathStr}[${i}]`, issues);
      }
    }
    return;
  }
  // primitive: number↔number, boolean↔boolean; everything coerces to string OK.
  if (et === "number" && ct !== "number") issues.push(`${pathStr || "root"}: expected number, got ${ct}`);
  else if (et === "boolean" && ct !== "boolean") issues.push(`${pathStr || "root"}: expected boolean, got ${ct}`);
}

export const exampleValidator: LeafValidator = (
  schema: Record<string, unknown>,
  parsed: unknown,
): ValidatorResult => {
  const issues: string[] = [];
  matchShape(schema, parsed, "", issues);
  return issues.length === 0 ? { ok: true, value: parsed } : { ok: false, issues: issues.join("; ") };
};

export const exampleHinter: SchemaHinter = (schema) => JSON.stringify(schema, null, 2);

// ─── Input schema (the FleetSpec the model fills in) ───────────────────────

const agentSchema = z
  .object({
    role: z.string().min(1).describe("Short role label, e.g. 'security-angle'."),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Self-contained instructions. The agent sees NONE of your context. In a pipeline phase you may reference the prior stage with {{prev}} or {{prev.field}}.",
      ),
    tools: z
      .array(z.string())
      .optional()
      .describe("Optional tool-name whitelist. Omit for full (read-only) access."),
    schema: z
      .record(z.any())
      .optional()
      .describe(
        'Optional shape-EXAMPLE object (NOT JSON-Schema), e.g. {"summary":"...","score":0}. The leaf output is validated to match it.',
      ),
    maxTurns: z.number().int().positive().optional().describe("Per-agent turn ceiling."),
    scope: z
      .array(z.string())
      .optional()
      .describe(
        "WRITE agents only: path prefixes this agent owns (e.g. [\"src/api\"]). Required (and checked for overlap) when a parallel build phase sets isolation:'none'.",
      ),
    persona: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional roster persona name (e.g. 'vitruvius', 'forge'). The agent adopts that persona's prompt layer, tool limits, and turn ceiling on top of this spec. An unknown name never fails the fleet — the agent runs without it and the result carries a hint.",
      ),
    contract: z
      .object({
        deliverables: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe("File globs this agent must create/modify (e.g. [\"src/api/**\", \"README.md\"])."),
      })
      .strict()
      .optional()
      .describe(
        "WORK CONTRACT (build agents): declared deliverables are checked against the files the agent actually changed. If NO changed file matches any pattern, the agent fails its work contract (treated like unverified work).",
      ),
  })
  .strict();

const phaseSchema = z
  .object({
    id: z.string().min(1).describe("Stable phase id (used for templates + journaling)."),
    kind: z
      .enum(["parallel", "pipeline"])
      .describe(
        "'parallel' = fan out all agents at once; 'pipeline' = run them in order, each seeded with the prior stage output.",
      ),
    agents: z.array(agentSchema).min(1).max(32),
    reduce: z
      .enum(["concat", "first", "judge"])
      .optional()
      .describe(
        "parallel only: 'concat' joins all outputs (default), 'first' keeps the first success, " +
          "'judge' runs ONE extra synthesis fork over all outputs (use for review/options PANELS).",
      ),
    judgeInstruction: z
      .string()
      .optional()
      .describe("'judge' only: how the synthesis fork should weigh the candidates (e.g. 'rank by severity, keep the top 3')."),
    build: z
      .boolean()
      .optional()
      .describe("BUILD phase: leaves get write tools (Bash/Edit/Write) to create files. Use kind:'pipeline' (serial writers) OR kind:'parallel' with isolation:'worktree'. Dangerous tools (payment/email/deploy/account/desktop) are still stripped."),
    repairRounds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("SELF-REPAIR: if the phase fails (or its last agent returns {ok:false}), re-run it up to N times with the failure injected — 'verify→fix→re-verify until green'. Put this on a verify phase whose agent has schema {ok:true,summary:'...'}."),
    isolation: z
      .enum(["worktree", "none"])
      .optional()
      .describe(
        "'worktree' runs a PARALLEL build phase's writers in isolated sandboxes, merged back file-disjoint (an overlap fails closed) — this is the DEFAULT for a parallel build phase with 2+ agents, so you rarely set it. 'none' opts out (shared workspace, faster) and is only accepted when EVERY agent declares a disjoint 'scope'.",
      ),
    successPolicy: z
      .enum(["all", "any", "quorum", "best_effort"])
      .optional()
      .describe("Phase completion rule. Defaults to 'all'. Use 'any' only for redundant search and 'quorum' for review panels."),
  })
  .strict();

const inputSchema = z
  .object({
    goal: z.string().optional().describe("Optional human label for the fleet."),
    plan: z
      .string()
      .optional()
      .describe("EASY MODE: a one-line goal (e.g. 'build a multiplayer FPS in the browser'). The planner expands it into a WIDE research→plan→build→verify fleet for you. Use this instead of authoring phases when you want a full build — omit 'phases' when you set 'plan'."),
    phases: z.array(phaseSchema).min(1).optional().describe("Phases run sequentially. Omit when you set 'plan' (the planner authors them)."),
    concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max in-flight forks in a parallel phase. Default 3 (clamped to 8); lower for local models."),
    maxTotalTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Hard ceiling on summed tokens across ALL forks. New forks stop being admitted on breach. Omit for a size-derived default."),
    maxWallClockMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Wall-clock backstop (ms). Aborts the whole fleet if it runs longer — catches a hung fork. Omit for a size-derived default."),
    resumeFleetId: z
      .string()
      .optional()
      .describe("Resume a prior fleet by its fleetId: completed leaves are reused from disk; only failed/missing ones re-run."),
  })
  .strict();

export function makeConductorTool(deps: ConductorToolDeps) {
  return buildTool({
    name: "Conductor",
    description: CONDUCTOR_DESCRIPTION,
    // Build phases and worktree merges can write the parent workspace. A
    // conservative parent checkpoint lets Session derive the exact merged diff
    // and schedule one authoritative parent-level verification generation.
    safety: "workspace-write",
    // It owns its own internal fan-out, so it must solo (no engine-level batching).
    concurrency: "exclusive",
    // Fleets legitimately run minutes; bounded by the parent's deadline signal.
    watchdogTimeoutMs: 0,
    inputZod: inputSchema,
    // WHEN-TO-SPAWN policy (deterministic, not model whim): a fleet must buy real
    // structure. A single phase with a single agent is just an inline task wearing
    // orchestration overhead — reject it with the fix. (A lone self-repairing
    // verify phase is exempt: repairRounds makes it a real loop, not one leaf.)
    validateInput: async (i) => {
      if (!i.plan && i.phases?.length === 1 && i.phases[0].agents.length === 1 && !(i.phases[0].repairRounds && i.phases[0].repairRounds > 0)) {
        return {
          ok: false,
          message:
            "This fleet is a single phase with a single agent — a fleet adds orchestration overhead " +
            "for zero parallelism. Run the task inline (or as one Task) instead; use Conductor only " +
            "for parallel fan-out, multi-stage pipelines, or a self-repairing verify phase.",
        };
      }
      // BUILD-DELIVERY guard: the #1 failure is a hand-authored fleet that
      // researches + plans for 20 minutes and writes ZERO code, because nothing
      // requires a build phase. If the goal clearly means "produce code" but no
      // phase has build:true, reject with the fix BEFORE the fleet burns time.
      // (Easy-mode `plan` is exempt — its planner always emits a build phase.)
      if (!i.plan && i.phases && i.phases.length > 0) {
        const hasBuildPhase = i.phases.some((p) => p.build === true);
        const goalText = i.goal ?? "";
        const buildIntent = /\b(build|implement|scaffold|develop|rebuild|reimplement|code\s*up|write\s+(the|a|an)\s)/i;
        // A goal that explicitly frames itself as research/analysis is allowed to be
        // build-phase-free even if it names "build" (e.g. "research how to build X") —
        // the user asked for findings, not code. Only a plain build directive is caught.
        const researchIntent = /\b(research|investigate|explore|survey|compare|evaluate|analy[sz]e|assess|feasibility|how\s+to|options?\s+for|approach(es)?\s+(to|for))\b/i;
        const looksLikeBuild = buildIntent.test(goalText) && !researchIntent.test(goalText);
        if (looksLikeBuild && !hasBuildPhase) {
          return {
            ok: false,
            message:
              "This fleet only researches/plans — no phase sets build:true, so it will write ZERO code, " +
              "yet the goal is to BUILD something. A research-only fleet for a build task is the #1 way to " +
              "burn 20 minutes and ship nothing. Fix it ONE of two ways: (a) add a build phase " +
              "(kind:'parallel' or 'pipeline', build:true) with file-disjoint agents that IMPLEMENT the code, " +
              "followed by a verify phase (repairRounds:3) that runs the build/tests and fails closed; or " +
              "(b) drop 'phases' entirely and use easy mode — {\"plan\":\"<one-line build goal>\"} — which " +
              "auto-authors research→plan→build→verify for you. Keep research to 1-2 phases; the deliverable is written, tested code.",
          };
        }
      }
      return { ok: true };
    },
    activityDescription: (i) =>
      i.plan
        ? `Conductor: planning a fleet for "${i.plan.slice(0, 60)}"`
        : `Conductor: ${i.goal ?? `${i.phases?.length ?? 0} phase(s)`} (${(i.phases ?? []).reduce((n, p) => n + p.agents.length, 0)} agents)`,
    async call(i, ctx) {
      const baseSystemPrompt = typeof deps.baseSystemPrompt === "function"
        ? await deps.baseSystemPrompt()
        : deps.baseSystemPrompt;
      const runtimeDeps: ConductorDeps = {
        provider: deps.provider,
        model: deps.model,
        parentTools: deps.parentTools,
        baseSystemPrompt,
        workspace: ctx.workspace,
        signal: ctx.signal,
        sessionKernel: deps.sessionKernel,
        parentSessionId: ctx.sessionId,
        invocationId: ctx.toolUseId,
        emitProgress: ctx.emitProgress,
        subModel: deps.subModel ?? ctx.subModel,
        summarizeSpan: deps.summarizeSpan,
        defaultMaxTurns: deps.defaultMaxTurns,
        allowWriteTools: deps.allowWriteTools,
        leafRequestPermission: deps.leafRequestPermission,
        validate: exampleValidator,
        schemaHint: exampleHinter,
        makeWorktree: (label, durableKey) => makeCopyWorktree(ctx.workspace, label, durableKey),
        resolvePersona: deps.resolvePersona,
      };
      const result = await runFleet(i as FleetSpec, runtimeDeps);
      // Corrective hints — turn the runtime's failure signals into one-line advice
      // the model will actually read and apply next time (closes the learning loop).
      const stripped = result.phases.flatMap((p) => p.leaves.flatMap((l) => l.strippedTools));
      const unresolved = result.phases.reduce((n, p) => n + p.unresolvedTemplates, 0);
      // Per-leaf advisories (unknown persona, unmet deliverable contract) —
      // surfaced verbatim so the model can correct the next spec.
      const hints: string[] = result.phases.flatMap((p) => p.leaves.flatMap((l) => l.hints ?? []));
      if (stripped.length > 0)
        hints.push(
          `${stripped.length} write tool(s) were stripped (unattended posture). Serialize writers into ONE pipeline stage, or don't whitelist write tools in a fleet.`,
        );
      if (unresolved > 0)
        hints.push(
          `${unresolved} {{template}} ref(s) didn't resolve — a hand-off broke. Check that the referenced phase/field exists and the upstream stage emitted a schema.`,
        );
      if (result.budgetExceeded)
        hints.push("The token budget was hit; later forks were skipped. Raise maxTotalTokens or split into smaller fleets — then resumeFleetId to finish.");
      if (result.status !== "completed")
        hints.push(`Fleet ${result.status}. Re-run with resumeFleetId: "${result.fleetId}" to reuse completed leaves and only retry the rest.`);
      // BUILD-DELIVERY backstop: if the fleet completed but no phase built and no
      // leaf wrote a file, it only produced research/plans. Loudly tell the model
      // NOT to stop here — the user asked for working code, so it must now build.
      const hadBuildPhase = (i as FleetSpec).phases?.some((p) => p.build === true) ?? false;
      if (result.status === "completed" && !hadBuildPhase) {
        hints.unshift(
          "⚠ This fleet wrote NO code — it only researched/planned. Do NOT stop here or summarize and end the turn. " +
            "If the task was to build something, IMPLEMENT it now: scaffold the files and write the code with Write/Edit/Bash " +
            "(or run one more Conductor with a build:true phase). Research without a shipped build is a failed turn.",
        );
      }
      return {
        output: {
          fleetId: result.fleetId,
          status: result.status,
          budgetExceeded: result.budgetExceeded,
          ...(hints.length > 0 ? { hints } : {}),
          summary: result.summary,
          usage: result.usage,
          phases: result.phases.map((p) => ({
            id: p.id,
            kind: p.kind,
            status: p.status,
            failureReason: p.failureReason,
            unresolvedTemplates: p.unresolvedTemplates,
            agents: p.leaves.map((l) => ({
              role: l.role,
              status: l.status,
              workStatus: l.workStatus,
              schemaValid: l.schemaValid,
              unresolvedTemplates: l.unresolvedTemplates,
              strippedTools: l.strippedTools,
              structured: l.structured,
              ...(l.deliverables ? { deliverables: l.deliverables } : {}),
            })),
          })),
          manifestPath: result.manifestPath,
        },
        display: `Fleet ${result.status} — ${result.phases.length} phase(s), ${result.phases.reduce((n, p) => n + p.leaves.length, 0)} agents`,
      };
    },
  });
}

const CONDUCTOR_DESCRIPTION = `Author and run a deterministic agent FLEET for work with structure the model-driven Task tool can't guarantee: capped parallel fan-out, typed multi-stage pipelines, schema-validated outputs, build phases that write code, and a token budget.

EASY MODE (preferred for builds): set "plan" to a ONE-LINE goal — e.g. {"plan":"build a browser multiplayer FPS with Node/Vite"} — and the planner expands it into an adaptive research→plan→build→verify fleet. Omit "phases" when you use "plan". This is the right call for "build me X": you get a tooled, self-verifying fleet without hand-authoring it.

ADVANCED: emit "phases" yourself. Either way a deterministic runtime executes it start-to-finish — it owns concurrency, cancellation, schema retries, the pipeline hand-off barrier, build-phase write tools, and the budget. You do NOT manage the fan-out turn-by-turn.

REACH FOR THIS when a task has genuinely independent research questions,
file-disjoint implementation boundaries, or a staged integration/repair loop.
Default to 3-8 agents total and use fewer when the ownership graph is small;
exceed 8 only when the repository really has that many independent boundaries.
For "build me X", structure it as focused research → integration plan →
file-disjoint build → independent verify/repair. More agents are not progress
unless each owns distinct evidence or code.

WHEN TO USE — fan out ONLY for parallelizable read/search/analysis work or isolated write shards (disjoint files/dirs):
- Build something real: research the stack in parallel, then build modules in parallel, then verify.
- Survey N angles in parallel then JUDGE them into one answer (research, design options, code-review panels).
- A pipeline where each stage consumes the PREVIOUS stage's structured output (extract → transform → write).
- Any fan-out where you need a concurrency cap, a token budget, or schema-valid leaf outputs.

BUILD FLEETS MUST BUILD: for any goal that means "produce code" (build/implement/scaffold/develop/rebuild X), a hand-authored fleet with NO build:true phase is REJECTED — research + planning that never writes code is a failed turn, not a deliverable. Keep research to 1-2 phases, then a build phase (build:true, file-disjoint agents) and a verify phase (repairRounds). When unsure how to structure it, use easy mode ({"plan":"..."}) which always ends in build→verify.

WHEN NOT TO USE (rejected or wasteful):
- NEVER for a single-file edit or a task needing shared evolving context — run it inline. A fleet that is one phase with one agent is REJECTED (pure overhead; exception: a lone verify phase with repairRounds).
- A build-goal fleet with no build:true phase is REJECTED (see BUILD FLEETS MUST BUILD) — you would research forever and ship nothing.
- One phase per dependency step; add a new phase (a barrier) ONLY when a step needs ALL prior results. Independent work belongs in ONE parallel phase, not a chain.

WORKED EXAMPLE — a review panel that fans out, then synthesizes:
{ "goal": "review the diff",
  "phases": [
    { "id": "review", "kind": "parallel", "reduce": "judge",
      "judgeInstruction": "Merge into one deduplicated list ranked by severity; drop anything two reviewers didn't both raise.",
      "agents": [
        { "role": "correctness", "prompt": "Review the staged diff for correctness bugs. Return findings.", "tools": ["Read","Grep","Bash"], "schema": {"findings":[{"title":"...","severity":0}]} },
        { "role": "security",    "prompt": "Review the staged diff for security issues. Return findings.", "tools": ["Read","Grep","Bash"], "schema": {"findings":[{"title":"...","severity":0}]} },
        { "role": "perf",        "prompt": "Review the staged diff for performance issues. Return findings.", "tools": ["Read","Grep"], "schema": {"findings":[{"title":"...","severity":0}]} } ] } ],
  "concurrency": 3 }

NOTES:
- 'schema' is a shape-EXAMPLE object (values illustrate types), NOT JSON-Schema.
- reduce: 'judge' adds one synthesis fork over all siblings — far better than 'concat' for panels (you get a merged answer, not N raw opinions to digest yourself).
- In a pipeline, reference the prior stage with {{prev}} / {{prev.field}}; reference an earlier phase with {{phaseId.reduced}}. If a stage's schema fails OR a downstream {{prev.field}} doesn't resolve, the pipeline FAILS CLOSED — it does not run the next stage on garbage.
- TYPED HANDOFF: when the upstream stage declares a schema, every {{prev.field}} you write is checked against it BEFORE the stage runs — referencing a field the schema doesn't declare fails immediately with the declared field list. Only reference fields the upstream schema actually has.
- Each agent is STATELESS — make every prompt self-contained.
- Children run UNATTENDED but CAN research: read-only tools (Read/Grep/Glob/CodebaseSearch/LSP) AND safe research tools (WebFetch/WebSearch/ImageSearch) are available — whitelist them freely on research agents. Write/destructive/credential/payment/account tools are stripped unless the host enabled write mode; serialize writers into a single pipeline stage.
- SELF-REPAIR: put repairRounds (e.g. 3) on your VERIFY phase, whose agent returns schema {"ok":true,"summary":"..."}. If it reports ok:false the runtime re-runs it with the failure injected until green or rounds run out — this is how the fleet catches a broken build and FIXES it before finishing.
- PARALLEL BUILD: to build many modules at once, use kind:'parallel' + build:true with FILE-DISJOINT agents (each owns different files). Isolation defaults to 'worktree' automatically (isolated sandboxes, merged back; an overlap fails closed). To share the workspace directly set isolation:'none' — accepted only when every agent declares a disjoint 'scope' (path prefixes it owns). Serial build is just kind:'pipeline' + build:true.
- If a fleet aborts (budget/time/crash), re-run with resumeFleetId: <the returned fleetId> — completed leaves are reused, only the rest re-runs. The result's 'hints' tell you what to fix.`;
