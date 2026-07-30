import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  ".ares",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const INSTRUCTION_FILES = new Set(["AGENTS.md", "ARES.md", "CLAUDE.md", "CRIX.md"]);
const ROOT_LANDMARKS = new Set([
  "Cargo.toml",
  "Makefile",
  "README.md",
  "biome.json",
  "go.mod",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "turbo.json",
]);

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".go": "Go",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".mjs": "JavaScript",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".vue": "Vue",
};

export interface RepositoryPackageMap {
  path: string;
  name?: string;
  scripts: string[];
  sourceRoots: string[];
  testRoots: string[];
  entrypoints: string[];
}

export interface RepositoryMap {
  schemaVersion: 1;
  workspace: string;
  fingerprint: string;
  scannedFiles: number;
  truncated: boolean;
  languages: Array<{ name: string; files: number }>;
  rootLandmarks: string[];
  instructions: string[];
  topLevel: Array<{ path: string; files: number }>;
  packages: RepositoryPackageMap[];
  testFiles: number;
}

export interface RepositoryMapOptions {
  /** Bound startup work on enormous repositories. Defaults to 8,000 files. */
  maxFiles?: number;
  /** Bound the reminder injected into the model. Defaults to 8,000 chars. */
  maxReminderChars?: number;
}

interface WalkResult {
  files: string[];
  truncated: boolean;
}

/**
 * Build a deterministic, bounded map of a repository. This deliberately avoids
 * an LLM summary: the same checkout produces the same ordering and fingerprint,
 * so long sessions can refresh their bearings without accumulating invented
 * architecture. Generated artifacts and Ares' own state are excluded.
 */
export async function buildRepositoryMap(
  workspace: string,
  options: RepositoryMapOptions = {},
): Promise<RepositoryMap> {
  const root = path.resolve(workspace);
  const maxFiles = Math.max(100, options.maxFiles ?? 8_000);
  const walked = await walkRepository(root, maxFiles);
  const files = walked.files.sort((a, b) => a.localeCompare(b));
  const languages = new Map<string, number>();
  const topLevel = new Map<string, number>();
  const instructions: string[] = [];
  const rootLandmarks: string[] = [];
  const packageJsonFiles: string[] = [];
  let testFiles = 0;

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext];
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
    const first = rel.split("/")[0] || ".";
    topLevel.set(first, (topLevel.get(first) ?? 0) + 1);
    const base = path.posix.basename(rel);
    if (INSTRUCTION_FILES.has(base)) instructions.push(rel);
    if (!rel.includes("/") && ROOT_LANDMARKS.has(base)) rootLandmarks.push(rel);
    if (base === "package.json") packageJsonFiles.push(rel);
    if (isTestPath(rel)) testFiles++;
  }

  const packages = await Promise.all(
    packageJsonFiles.slice(0, 80).map((rel) => describePackage(root, rel, files, packageJsonFiles)),
  );
  const fingerprint = createHash("sha256")
    .update(files.join("\n"))
    .update("\0")
    .update(packages.map((pkg) => `${pkg.path}:${pkg.name ?? ""}:${pkg.scripts.join(",")}`).join("\n"))
    .digest("hex")
    .slice(0, 16);

  return {
    schemaVersion: 1,
    workspace: root,
    fingerprint,
    scannedFiles: files.length,
    truncated: walked.truncated,
    languages: [...languages.entries()]
      .map(([name, count]) => ({ name, files: count }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    rootLandmarks: rootLandmarks.sort(),
    instructions: instructions.sort(),
    topLevel: [...topLevel.entries()]
      .map(([entryPath, count]) => ({ path: entryPath, files: count }))
      .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
      .slice(0, 24),
    packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
    testFiles,
  };
}

/** Render the map as a compact system reminder, not a wall of inventory. */
export function renderRepositoryMap(
  map: RepositoryMap,
  options: Pick<RepositoryMapOptions, "maxReminderChars"> = {},
): string {
  const packageLines = map.packages.slice(0, 36).map((pkg) => {
    const details = [
      pkg.name ? `name=${pkg.name}` : "",
      pkg.sourceRoots.length ? `src=${pkg.sourceRoots.join(",")}` : "",
      pkg.testRoots.length ? `tests=${pkg.testRoots.join(",")}` : "",
      pkg.entrypoints.length ? `entry=${pkg.entrypoints.join(",")}` : "",
      pkg.scripts.length ? `scripts=${pkg.scripts.join(",")}` : "",
    ].filter(Boolean);
    return `- ${pkg.path}${details.length ? ` (${details.join("; ")})` : ""}`;
  });
  const lines = [
    "REPOSITORY CARTOGRAPHY (deterministic; use this to orient before editing)",
    `fingerprint=${map.fingerprint}; scanned=${map.scannedFiles}${map.truncated ? "+ (bounded scan)" : ""}; tests=${map.testFiles}`,
    `languages: ${map.languages.slice(0, 10).map((item) => `${item.name} ${item.files}`).join(", ") || "none detected"}`,
    `root landmarks: ${map.rootLandmarks.join(", ") || "none"}`,
    `instruction files: ${map.instructions.join(", ") || "none"}`,
    `top-level density: ${map.topLevel.map((item) => `${item.path}(${item.files})`).join(", ") || "empty"}`,
  ];
  if (packageLines.length) lines.push("package/module boundaries:", ...packageLines);
  lines.push(
    "Treat this as a navigation index, not proof of behavior. Read the owning instructions, callers, tests, and local conventions before changing a boundary.",
  );
  const text = lines.join("\n");
  const max = Math.max(1_000, options.maxReminderChars ?? 8_000);
  return text.length <= max ? text : `${text.slice(0, max - 80)}\n... repository map truncated to ${max} characters`;
}

export async function repositoryMapReminder(
  workspace: string,
  options: RepositoryMapOptions = {},
): Promise<string> {
  return renderRepositoryMap(await buildRepositoryMap(workspace, options), options);
}

async function walkRepository(root: string, maxFiles: number): Promise<WalkResult> {
  const files: string[] = [];
  const pending = [root];
  let truncated = false;
  while (pending.length > 0) {
    const dir = pending.shift()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) pending.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(toPosix(path.relative(root, abs)));
      if (files.length >= maxFiles) {
        truncated = pending.length > 0 || entries.at(-1) !== entry;
        return { files, truncated };
      }
    }
  }
  return { files, truncated };
}

async function describePackage(
  root: string,
  packageJsonRel: string,
  allFiles: readonly string[],
  allPackageJsonFiles: readonly string[],
): Promise<RepositoryPackageMap> {
  const packageDir = path.posix.dirname(packageJsonRel) === "." ? "." : path.posix.dirname(packageJsonRel);
  const prefix = packageDir === "." ? "" : `${packageDir}/`;
  const descendantPrefixes = allPackageJsonFiles
    .map((file) => path.posix.dirname(file) === "." ? "." : path.posix.dirname(file))
    .filter((candidate) => candidate !== packageDir && isInsidePackage(candidate, packageDir))
    .map((candidate) => `${candidate}/`);
  // A package owns files up to (but not through) a nested package boundary.
  // Without this partition, the root package appears to own every monorepo
  // test and a parent package absorbs all descendant source roots.
  const local = allFiles
    .filter((file) => file.startsWith(prefix) && !descendantPrefixes.some((child) => file.startsWith(child)))
    .map((file) => file.slice(prefix.length));
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await fs.readFile(path.join(root, packageJsonRel), "utf8")) as Record<string, unknown>;
  } catch {
    // A malformed package is still a useful boundary; leave metadata empty.
  }
  const scripts = Object.keys((parsed.scripts as Record<string, unknown> | undefined) ?? {}).sort().slice(0, 16);
  const entryCandidates = new Set<string>();
  for (const key of ["main", "module", "types", "bin"]) {
    const value = parsed[key];
    if (typeof value === "string") entryCandidates.add(toPosix(value));
    if (value && typeof value === "object") {
      for (const candidate of Object.values(value as Record<string, unknown>)) {
        if (typeof candidate === "string") entryCandidates.add(toPosix(candidate));
      }
    }
  }
  for (const candidate of ["src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx", "index.ts", "index.js"]) {
    if (local.includes(candidate)) entryCandidates.add(candidate);
  }
  const sourceRoots = uniqueRoots(local.filter((file) => /^(src|lib|app|cmd)\//.test(file)));
  const testRoots = uniqueRoots(local.filter(isTestPath));
  return {
    path: packageDir,
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    scripts,
    sourceRoots,
    testRoots,
    entrypoints: [...entryCandidates].sort().slice(0, 12),
  };
}

function isInsidePackage(candidate: string, owner: string): boolean {
  if (owner === ".") return candidate !== ".";
  return candidate.startsWith(`${owner}/`);
}

function uniqueRoots(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => file.split("/").slice(0, file.startsWith("packages/") ? 2 : 1).join("/")))]
    .filter(Boolean)
    .sort()
    .slice(0, 12);
}

function isTestPath(file: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.py$/.test(file);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
