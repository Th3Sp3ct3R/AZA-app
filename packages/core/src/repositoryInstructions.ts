import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { ContentBlock, Message } from "@ares/protocol";

/** Same-directory precedence. Only the first existing convention file in a
 * directory applies; nested directories are then layered root -> leaf so the
 * most specific rule is last and can override broader repository guidance. */
export const REPOSITORY_INSTRUCTION_FILES = [
  "ARES.md",
  "AGENTS.md",
  "CLAUDE.md",
] as const;

export const MAX_REPOSITORY_INSTRUCTION_CHARS = 24_000;

/** External targets are intentionally supported, but rule discovery must not
 * turn into an unbounded walk of the owner's whole filesystem. This is far
 * deeper than ordinary repository nesting while still putting a hard ceiling
 * on the pre-tool filesystem work. */
const MAX_EXTERNAL_REPOSITORY_ANCESTORS = 32;

const REPOSITORY_ROOT_MARKERS = [
  ".git",
  ".hg",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

export interface ResolvedRepositoryInstruction {
  path: string;
  relativePath: string;
  content: string;
  contentHash: string;
  truncated: boolean;
}

export interface RepositoryInstructionClaim {
  path: string;
  contentHash: string;
}

export interface RepositoryInstructionContext {
  resolve(targetPath: string): Promise<ResolvedRepositoryInstruction[]>;
  claim(claims: readonly RepositoryInstructionClaim[]): void;
  claims(): RepositoryInstructionClaim[];
  /** Current contents of every claimed rule, used to pin them through heavy
   * compaction instead of trusting a lossy summary to preserve constraints. */
  active(): Promise<ResolvedRepositoryInstruction[]>;
}

/** Path-sensitive repository rules with a cache owned by exactly one Session.
 * There is deliberately no module-global state: parent, Task, Conductor, and
 * Operator contexts must each see (and claim) their own applicable rules. */
export class RepositoryInstructionResolver implements RepositoryInstructionContext {
  private readonly root: string;
  private readonly claimed = new Map<string, RepositoryInstructionClaim>();
  private tail: Promise<void> = Promise.resolve();

  constructor(workspace: string) {
    this.root = path.resolve(workspace);
  }

  claim(claims: readonly RepositoryInstructionClaim[]): void {
    for (const claim of claims) {
      if (!claim || typeof claim.path !== "string" || !isContentHash(claim.contentHash)) continue;
      const absolute = path.resolve(claim.path);
      this.claimed.set(pathKey(absolute), {
        path: absolute,
        contentHash: claim.contentHash.toLowerCase(),
      });
    }
  }

  claims(): RepositoryInstructionClaim[] {
    return [...this.claimed.values()]
      .map((claim) => ({ ...claim }))
      .sort((a, b) => comparePaths(a.path, b.path));
  }

  async active(): Promise<ResolvedRepositoryInstruction[]> {
    const active: ResolvedRepositoryInstruction[] = [];
    for (const claim of this.claims()) {
      const stat = await lstat(claim.path).catch(() => null);
      if (!stat?.isFile()) continue;
      const loaded = await readBoundedInstruction(claim.path);
      this.claimed.set(pathKey(claim.path), {
        path: claim.path,
        contentHash: loaded.contentHash,
      });
      if (!loaded.content) continue;
      active.push({
        path: claim.path,
        relativePath: displayPath(this.root, claim.path),
        content: loaded.content,
        contentHash: loaded.contentHash,
        truncated: loaded.truncated,
      });
    }
    return active;
  }

  async resolve(targetPath: string): Promise<ResolvedRepositoryInstruction[]> {
    // Reads and disjoint edits can execute concurrently. Serialize the tiny
    // discovery/claim transaction so one rule cannot be attached twice by two
    // simultaneous tool calls in the same Session.
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.resolveExclusive(targetPath);
    } finally {
      release();
    }
  }

  private async resolveExclusive(targetPath: string): Promise<ResolvedRepositoryInstruction[]> {
    const target = path.resolve(this.root, targetPath);
    const targetStat = await lstat(target).catch(() => null);
    const targetDirectory = targetStat?.isDirectory() ? target : path.dirname(target);
    // The Session workspace is the discovery root for its own tree. When the
    // owner explicitly points a tool at another project, discover that
    // project's root instead of silently dropping all of its AGENTS/CLAUDE
    // rules. Claims remain on this resolver, so the behavior is still
    // session-local and content-hash versioned across both projects.
    const discoveryRoot = isInside(this.root, targetDirectory)
      ? this.root
      : await externalRepositoryRoot(targetDirectory);
    if (!discoveryRoot || !isInside(discoveryRoot, targetDirectory)) return [];

    const directories = directoriesFromRoot(discoveryRoot, targetDirectory);
    const resolved: ResolvedRepositoryInstruction[] = [];
    for (const directory of directories) {
      const instructionPath = await firstInstructionFile(directory);
      if (!instructionPath) continue;
      const key = pathKey(instructionPath);
      const loaded = await readBoundedInstruction(instructionPath);
      const prior = this.claimed.get(key);
      const nextClaim = { path: instructionPath, contentHash: loaded.contentHash };

      // Reading the instruction file itself already puts its bytes in context.
      // Claim it without redundantly appending the same file to its own result.
      if (key === pathKey(target)) {
        this.claimed.set(key, nextClaim);
        continue;
      }
      if (prior?.contentHash === loaded.contentHash) continue;

      // Content identity, not path alone, is the claim. A modified rule file is
      // therefore reattached on the next path access in this same Session.
      this.claimed.set(key, nextClaim);
      if (!loaded.content) continue;
      resolved.push({
        path: instructionPath,
        relativePath: displayPath(discoveryRoot, instructionPath),
        content: loaded.content,
        contentHash: loaded.contentHash,
        truncated: loaded.truncated,
      });
    }
    return resolved;
  }
}

/** Find a bounded, project-local root for a target outside the Session's
 * original workspace. A nearest VCS boundary is authoritative (nested repos
 * stay isolated). Without VCS metadata, the outermost nearby project marker is
 * used so monorepo root rules are not lost behind a nested package.json. A
 * rule-bearing directory is the final fallback for lightweight projects. */
async function externalRepositoryRoot(targetDirectory: string): Promise<string> {
  const start = path.resolve(targetDirectory);
  const home = path.resolve(homedir());
  const ancestors: string[] = [];
  let current = start;

  for (let depth = 0; depth < MAX_EXTERNAL_REPOSITORY_ANCESTORS; depth++) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    // Do not accidentally treat an owner's home-level package.json/AGENTS.md
    // as the root of every unrelated repo below it. Working in the home itself
    // remains valid and therefore includes it when it is the actual target.
    if (home && pathKey(parent) === pathKey(home) && pathKey(start) !== pathKey(home)) break;
    current = parent;
  }

  for (const directory of ancestors) {
    if (await hasAnyEntry(directory, [".git", ".hg"])) return directory;
  }

  const marked: string[] = [];
  const ruled: string[] = [];
  for (const directory of ancestors) {
    if (await hasAnyEntry(directory, REPOSITORY_ROOT_MARKERS.slice(2))) marked.push(directory);
    if (await firstInstructionFile(directory)) ruled.push(directory);
  }
  return marked.at(-1) ?? ruled.at(-1) ?? start;
}

async function hasAnyEntry(directory: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await lstat(path.join(directory, name)).then(() => true, () => false)) return true;
  }
  return false;
}

export function renderRepositoryInstructions(
  instructions: readonly ResolvedRepositoryInstruction[],
): string {
  if (instructions.length === 0) return "";
  const blocks = instructions.map((instruction) => [
    `Instructions from: ${instruction.path} [sha256:${instruction.contentHash}]`,
    instruction.content,
    instruction.truncated
      ? `[truncated at ${MAX_REPOSITORY_INSTRUCTION_CHARS.toLocaleString()} characters]`
      : "",
  ].filter(Boolean).join("\n"));
  return [
    "<repository-instructions>",
    "The following repository rules apply to this path. They are ordered from broadest to most specific; later rules take precedence when they conflict.",
    ...blocks,
    "</repository-instructions>",
  ].join("\n\n");
}

/** Recover claims from hydrated history so a resumed Session does not reattach
 * rules that are already present in its model-visible context. Durable Session
 * metadata is the primary source; this also covers legacy/non-kernel sessions. */
export function repositoryInstructionClaimsFromMessages(
  messages: readonly Message[] | undefined,
): RepositoryInstructionClaim[] {
  if (!messages?.length) return [];
  const claims = new Map<string, RepositoryInstructionClaim>();
  const pattern = /^(?:Instructions from: |Loaded project instructions from )(.+?(?:ARES|AGENTS|CLAUDE)\.md) \[sha256:([a-f0-9]{64})\]:?\s*$/gim;
  for (const message of messages) {
    for (const text of textFromBlocks(message.content)) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text))) {
        const absolute = path.resolve(match[1]);
        claims.set(pathKey(absolute), { path: absolute, contentHash: match[2].toLowerCase() });
      }
    }
  }
  return [...claims.values()];
}

async function firstInstructionFile(directory: string): Promise<string | null> {
  for (const name of REPOSITORY_INSTRUCTION_FILES) {
    const candidate = path.join(directory, name);
    const stat = await lstat(candidate).catch(() => null);
    // Symlinked instruction files can escape the workspace and disclose owner
    // files. Only ordinary files participate in repository-local discovery.
    if (stat?.isFile()) return path.resolve(candidate);
  }
  return null;
}

async function readBoundedInstruction(file: string): Promise<{
  content: string;
  contentHash: string;
  truncated: boolean;
}> {
  const hash = createHash("sha256");
  const retained: Buffer[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  try {
    for await (const raw of createReadStream(file, { highWaterMark: 32 * 1024 })) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      hash.update(chunk);
      totalBytes += chunk.length;
      if (retainedBytes < MAX_REPOSITORY_INSTRUCTION_CHARS) {
        const slice = chunk.subarray(0, MAX_REPOSITORY_INSTRUCTION_CHARS - retainedBytes);
        retained.push(slice);
        retainedBytes += slice.length;
      }
    }
  } catch {
    return {
      content: "",
      contentHash: createHash("sha256").digest("hex"),
      truncated: false,
    };
  }
  return {
    content: Buffer.concat(retained).toString("utf8").replace(/^\uFEFF/, "").trim(),
    contentHash: hash.digest("hex"),
    truncated: totalBytes > MAX_REPOSITORY_INSTRUCTION_CHARS,
  };
}

function directoriesFromRoot(root: string, targetDirectory: string): string[] {
  const relative = path.relative(root, targetDirectory);
  const directories = [root];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayPath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") ? relative.replace(/\\/g, "/") : candidate;
}

function pathKey(candidate: string): string {
  const normalized = path.normalize(path.resolve(candidate));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function isContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function isRepositoryInstructionClaim(value: unknown): value is RepositoryInstructionClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as { path?: unknown; contentHash?: unknown };
  return typeof claim.path === "string" && claim.path.trim().length > 0 && isContentHash(claim.contentHash);
}

function textFromBlocks(blocks: readonly ContentBlock[]): string[] {
  const text: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" || block.type === "system_reminder") text.push(block.text);
    if (block.type === "tool_result") {
      if (typeof block.content === "string") text.push(block.content);
      else text.push(...textFromBlocks(block.content));
    }
  }
  return text;
}
