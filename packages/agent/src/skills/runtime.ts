// Skill execution runtime — turns handler.js files from documentation islands
// into running code. This is the line between an agent that writes about
// capabilities and one that grows its own body.
//
// A skill lives either in <workspace>/.ares/skills/<name> (project-local) or
// ~/.ares/skills/<name> (user-global), with project-local taking precedence.
// Its handler.js default export is `async (input, ctx) => result`. This runtime
// runs that handler in an isolated child Node process:
//   - input is passed via a temp JSON file (no arg-size / escaping limits),
//   - the result is read back from a temp JSON file,
//   - a hard timeout + the caller's AbortSignal can kill a runaway handler,
//   - stdout/stderr are captured as logs.
//
// Isolation is a child process (not vm) on purpose: handlers are full ESM
// modules that may import node builtins and do real work, and a crashing or
// hanging handler must never take down the agent turn.

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { aresAgentHome } from "../paths.js";
import { exists, writeFileAtomic } from "../files.js";
import {
  SKILL_NAME,
  canonicalCapabilityManifest,
  parseCapabilityReceipt,
  type CapabilityManifest,
  type CapabilityReceipt,
  type CapabilityScope,
} from "./manifest.js";
import { resolveSkill } from "./registry.js";

export interface RunSkillOptions {
  home?: string;
  name: string;
  input?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Session workspace used for project-local skill resolution and exposed to
   * the handler. It does not confine an explicitly selected targetRoot. */
  workspace?: string;
  /** Exact directory the provider should operate against. May be any absolute
   * or workspace-relative owner-selected path. */
  targetRoot?: string;
  sessionId?: string;
  /** Explicit provider operation. Falls back to input.op for capability skills. */
  operation?: string;
}

export interface SkillRunResult {
  name: string;
  scope: CapabilityScope;
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  exitCode: number | null;
  targetRoot: string;
  touchedFiles: string[];
  receipt?: CapabilityReceipt;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LOG_CHARS = 8_000;
const leasedSkillPorts = new Set<number>();

/** Ask the OS for a free loopback port, then keep it reserved in Ares's own
 * process-level lease table for the lifetime of the skill. The tiny close→spawn
 * handoff is necessary because Node handlers bind their own socket; the OS is
 * still the authority, so a non-Ares process occupying it makes the handler's
 * bind fail honestly rather than killing anything. */
async function leaseSkillPort(): Promise<number> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const candidate = typeof address === "object" && address ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(candidate));
      });
    });
    if (port > 0 && !leasedSkillPorts.has(port)) {
      leasedSkillPorts.add(port);
      return port;
    }
  }
  throw new Error("could not lease a loopback port for the skill");
}

// Written once to skills/ so handler.js resolves as ESM. .mjs runner is ESM
// regardless, but handlers are plain .js and need the package.json type hint.
const SKILLS_PACKAGE_JSON = JSON.stringify({ type: "module", private: true }, null, 2) + "\n";

// The bootstrap runner: a tiny ESM script the child process executes. It
// imports the handler by file URL, feeds it the input file, and writes a
// structured result (or error) to the output file. Kept as a string so it
// needs no separate build step or dist-path resolution.
const RUNNER_SOURCE = `import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const handlerPath = process.env.ARES_SKILL_HANDLER;
const inputFile = process.env.ARES_SKILL_INPUT_FILE;
const outputFile = process.env.ARES_SKILL_OUTPUT_FILE;

// Handlers are ESM, but \`require(...)\` is a near-universal reflex that otherwise
// throws "require is not defined" — the exact friction first-run skills hit. Expose
// a require anchored at the handler so BOTH import and require work, and relative
// requires resolve from the skill dir.
globalThis.require = createRequire(handlerPath);

async function writeOut(payload) {
  try {
    await writeFile(outputFile, JSON.stringify(payload), "utf8");
  } catch {
    // last resort — surface on stderr so the parent still sees something
    process.stderr.write("ares-skill-runner: failed to write output file\\n");
  }
}

async function main() {
  let input;
  if (inputFile) {
    try {
      input = JSON.parse(await readFile(inputFile, "utf8"));
    } catch {
      input = undefined;
    }
  }
  const mod = await import(pathToFileURL(handlerPath).href);
  const handler = mod.default ?? mod.handler ?? mod.run;
  if (typeof handler !== "function") {
    throw new Error("skill handler.js must export a default async function (input, ctx) => result");
  }
  const ctx = {
    home: process.env.ARES_HOME,
    name: process.env.ARES_SKILL_NAME,
    skillDir: process.env.ARES_SKILL_DIR,
    workspace: process.env.ARES_SKILL_WORKSPACE,
    targetRoot: process.env.ARES_SKILL_TARGET_ROOT,
    sessionId: process.env.ARES_SKILL_SESSION_ID || undefined,
    providerHash: process.env.ARES_SKILL_PROVIDER_HASH || undefined,
    operation: process.env.ARES_SKILL_OPERATION || undefined,
    host: "127.0.0.1",
    port: Number(process.env.ARES_SKILL_PORT || process.env.PORT || 0),
  };
  const result = await handler(input, ctx);
  await writeOut({ ok: true, result: result === undefined ? null : result });
}

main().catch(async (err) => {
  const message = err && (err.stack || err.message) ? String(err.stack || err.message) : String(err);
  await writeOut({ ok: false, error: message });
  process.exitCode = 1;
});
`;

async function ensureSkillsModuleType(skillsDir: string): Promise<void> {
  const pkg = path.join(skillsDir, "package.json");
  if (await exists(pkg)) return;
  await writeFileAtomic(pkg, SKILLS_PACKAGE_JSON);
}

async function ensureRunner(): Promise<string> {
  const runner = path.join(os.tmpdir(), "ares-skill-runner.mjs");
  let current: string | null = null;
  try {
    current = await fs.readFile(runner, "utf8");
  } catch {
    current = null;
  }
  if (current !== RUNNER_SOURCE) await writeFileAtomic(runner, RUNNER_SOURCE);
  return runner;
}

function clampLog(text: string): string {
  return text.length > MAX_LOG_CHARS ? text.slice(-MAX_LOG_CHARS) : text;
}

export async function runSkill(opts: RunSkillOptions): Promise<SkillRunResult> {
  // Validate before ever touching disk — path.join does not clamp ".." segments,
  // so an unsanitized name (e.g. "../../../etc/whatever") would walk straight out
  // of skillsDir. Same pattern SkillCraft enforces on write; enforce it on read too.
  if (!SKILL_NAME.test(opts.name)) {
    throw new Error(`skill '${opts.name}' is not a valid skill name`);
  }

  const home = aresAgentHome(opts.home ?? process.env.ARES_HOME);
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const resolved = await resolveSkill(opts.name, { home, workspace });
  if (!resolved) {
    throw new Error(
      `skill '${opts.name}' was not found in ${path.join(workspace, ".ares", "skills")} or ${path.join(home, "skills")}`,
    );
  }
  const { dir: skillDir, handlerPath, manifest, scope } = resolved;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const targetRoot = path.resolve(workspace, opts.targetRoot ?? workspace);
  const targetStat = await fs.stat(targetRoot).catch(() => null);
  if (!targetStat?.isDirectory()) throw new Error(`skill targetRoot is not a directory: ${targetRoot}`);

  // Cosmetic-toggle fix: a skill marked disabled (marker file dropped/removed by
  // entry.ts's skill_toggle handler) must never spawn, not just show as off in the UI.
  if (resolved.disabled) {
    throw new Error(`skill '${opts.name}' is disabled`);
  }

  if (!(await exists(handlerPath))) {
    throw new Error(`skill '${opts.name}' has no handler.js to run (looked in ${skillDir})`);
  }
  const operation = providerOperation(manifest, opts.operation, opts.input);
  const providerHash = manifest ? await capabilityProviderHash(manifest, handlerPath) : undefined;

  await ensureSkillsModuleType(resolved.root);
  const runner = await ensureRunner();

  const id = randomUUID();
  const inputFile = path.join(os.tmpdir(), `ares-skill-${id}-in.json`);
  const outputFile = path.join(os.tmpdir(), `ares-skill-${id}-out.json`);
  await writeFileAtomic(inputFile, JSON.stringify(opts.input ?? null));

  const startedAt = Date.now();
  const skillPort = await leaseSkillPort();
  let run: { logs: string; timedOut: boolean; aborted: boolean; exitCode: number | null; spawnError?: Error };
  try {
    run = await new Promise<{ logs: string; timedOut: boolean; aborted: boolean; exitCode: number | null; spawnError?: Error }>((resolve) => {
      const child = spawn(process.execPath, [runner], {
        cwd: manifest ? targetRoot : skillDir,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          ARES_HOME: home,
          ARES_SKILL_NAME: opts.name,
          ARES_SKILL_DIR: skillDir,
          ARES_SKILL_WORKSPACE: workspace,
          ARES_SKILL_TARGET_ROOT: targetRoot,
          ARES_SKILL_SESSION_ID: opts.sessionId ?? "",
          ARES_SKILL_PROVIDER_HASH: providerHash ?? "",
          ARES_SKILL_OPERATION: operation ?? "",
          ARES_SKILL_HANDLER: handlerPath,
          ARES_SKILL_INPUT_FILE: inputFile,
          ARES_SKILL_OUTPUT_FILE: outputFile,
          ARES_SKILL_HOST: "127.0.0.1",
          ARES_SKILL_PORT: String(skillPort),
          HOST: "127.0.0.1",
          PORT: String(skillPort),
        },
      });

      const chunks: Buffer[] = [];
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(child);
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        void terminateProcessTree(child);
      };
      opts.signal?.addEventListener("abort", onAbort);
      if (opts.signal?.aborted) onAbort();

      const collect = (chunk: Buffer) => chunks.push(chunk);
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const finish = (exitCode: number | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({
          logs: clampLog(Buffer.concat(chunks).toString("utf8")),
          timedOut,
          aborted,
          exitCode,
          spawnError,
        });
      };
      child.on("error", (err) => {
        finish(null, err);
      });
      child.on("close", (code) => {
        finish(code);
      });
    });
  } finally {
    leasedSkillPorts.delete(skillPort);
  }

  const durationMs = Date.now() - startedAt;

  // Read the handler's structured result (if it managed to write one).
  let outcome: { ok: boolean; result?: unknown; error?: string } | null = null;
  try {
    outcome = JSON.parse(await fs.readFile(outputFile, "utf8"));
  } catch {
    outcome = null;
  }

  // Best-effort temp cleanup; never fatal.
  await fs.rm(inputFile, { force: true }).catch(() => {});
  await fs.rm(outputFile, { force: true }).catch(() => {});

  const base = {
    name: opts.name,
    scope,
    logs: run.logs,
    durationMs,
    timedOut: run.timedOut,
    aborted: run.aborted,
    exitCode: run.exitCode,
    targetRoot,
    touchedFiles: [] as string[],
  };

  if (run.spawnError) {
    return {
      ...base,
      ok: false,
      error: `failed to start skill runner: ${run.spawnError.message}`,
    };
  }

  if (run.timedOut) {
    return {
      ...base,
      ok: false,
      error: `skill '${opts.name}' timed out after ${timeoutMs}ms`,
      timedOut: true,
    };
  }

  if (run.aborted) {
    return {
      ...base,
      ok: false,
      error: `skill '${opts.name}' was aborted`,
    };
  }

  if (outcome?.ok) {
    const normalized = await normalizeHandlerOutcome({
      result: outcome.result,
      manifest,
      operation,
      targetRoot,
      providerHash,
      startedAt,
    });
    return { ...base, ...normalized, timedOut: false, aborted: false };
  }

  return {
    ...base,
    ok: false,
    error: outcome?.error ?? `skill '${opts.name}' exited ${run.exitCode} without a result`,
    timedOut: false,
    aborted: false,
  };
}

function providerOperation(
  manifest: CapabilityManifest | null,
  explicit: string | undefined,
  input: unknown,
): string | undefined {
  if (!manifest) return explicit;
  const fromInput = input && typeof input === "object" && typeof (input as Record<string, unknown>).op === "string"
    ? String((input as Record<string, unknown>).op)
    : undefined;
  const operation = explicit ?? fromInput;
  if (!operation) {
    throw new Error(`capability provider '${manifest.id}' requires an operation (pass operation or input.op)`);
  }
  if (!manifest.operations[operation]) {
    throw new Error(`capability provider '${manifest.id}' does not declare operation '${operation}'`);
  }
  return operation;
}

interface NormalizedHandlerOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  touchedFiles: string[];
  receipt?: CapabilityReceipt;
}

async function normalizeHandlerOutcome(input: {
  result: unknown;
  manifest: CapabilityManifest | null;
  operation: string | undefined;
  targetRoot: string;
  providerHash?: string;
  startedAt: number;
}): Promise<NormalizedHandlerOutcome> {
  if (!input.manifest) {
    const nested = objectRecord(input.result);
    if (nested?.ok === false) {
      return {
        ok: false,
        result: input.result,
        error: typeof nested.error === "string" && nested.error.trim()
          ? nested.error
          : "skill handler returned ok:false",
        touchedFiles: [],
      };
    }
    return { ok: true, result: input.result, touchedFiles: [] };
  }

  let receipt: CapabilityReceipt;
  try {
    receipt = parseCapabilityReceipt(input.result, `provider ${input.manifest.id}`);
  } catch (error) {
    return {
      ok: false,
      result: input.result,
      error: error instanceof Error ? error.message : String(error),
      touchedFiles: [],
    };
  }

  const expectedOperation = input.operation!;
  const expectedHash = input.providerHash!;
  const receiptTarget = path.resolve(receipt.targetRoot);
  const normalizedMutations = receipt.mutations.map((mutation) => ({
    ...mutation,
    path: path.resolve(input.targetRoot, mutation.path),
  }));
  const touchedByKey = new Map<string, string>();
  for (const mutation of normalizedMutations) {
    const absolute = path.resolve(mutation.path);
    if (!isWithinRoot(input.targetRoot, absolute)) {
      return {
        ok: false,
        result: input.result,
        error: `provider mutation escapes targetRoot: ${mutation.path}`,
        touchedFiles: [],
        receipt: { ...receipt, targetRoot: input.targetRoot, mutations: normalizedMutations },
      };
    }
    if (touchedByKey.has(normalizePath(absolute))) {
      return {
        ok: false,
        result: input.result,
        error: `provider receipt reports the same mutation more than once: ${absolute}`,
        touchedFiles: [...touchedByKey.values()],
        receipt: { ...receipt, targetRoot: input.targetRoot, mutations: normalizedMutations },
      };
    }
    touchedByKey.set(normalizePath(absolute), absolute);
  }
  const touchedFiles = [...touchedByKey.values()];

  let contractError: string | undefined;
  if (receipt.providerId !== input.manifest.id) {
    contractError = `provider receipt id '${receipt.providerId}' does not match manifest '${input.manifest.id}'`;
  } else if (receipt.providerHash !== expectedHash) {
    contractError = `provider receipt hash does not match the loaded manifest and handler`;
  } else if (receipt.operation !== expectedOperation) {
    contractError = `provider receipt operation '${receipt.operation}' does not match '${expectedOperation}'`;
  } else if (!samePath(receiptTarget, input.targetRoot)) {
    contractError = `provider receipt targetRoot '${receipt.targetRoot}' does not match '${input.targetRoot}'`;
  } else if (input.manifest.operations[expectedOperation].effect === "read-only" && normalizedMutations.length > 0) {
    contractError = `read-only provider operation '${expectedOperation}' reported mutations`;
  } else {
    contractError = validateEvidence(
      input.manifest.operations[expectedOperation],
      receipt,
      input.startedAt,
    ) ?? await validateMutationHashes(normalizedMutations);
  }

  const normalizedReceipt: CapabilityReceipt = {
    ...receipt,
    targetRoot: input.targetRoot,
    mutations: normalizedMutations,
  };
  if (contractError) {
    return {
      ok: false,
      result: input.result,
      error: contractError,
      touchedFiles,
      receipt: normalizedReceipt,
    };
  }
  if (!receipt.ok) {
    return {
      ok: false,
      result: receipt.result,
      error: receipt.error ?? "capability provider returned ok:false",
      touchedFiles,
      receipt: normalizedReceipt,
    };
  }
  return {
    ok: true,
    result: receipt.result,
    touchedFiles,
    receipt: normalizedReceipt,
  };
}

function validateEvidence(
  operation: CapabilityManifest["operations"][string],
  receipt: CapabilityReceipt,
  startedAt: number,
): string | undefined {
  const evidenceByKind = new Map<string, CapabilityReceipt["evidence"]>();
  for (const item of receipt.evidence) {
    const bucket = evidenceByKind.get(item.kind) ?? [];
    bucket.push(item);
    evidenceByKind.set(item.kind, bucket);
  }
  for (const required of operation.evidence) {
    const candidates = evidenceByKind.get(required) ?? [];
    if (candidates.length === 0) return `provider receipt is missing required '${required}' evidence`;
    if (operation.requiresFreshObservationAfter) {
      const fresh = candidates.some((item) => Date.parse(item.observedAt) >= startedAt);
      if (!fresh) return `provider receipt '${required}' evidence predates this invocation`;
    }
  }
  return undefined;
}

async function validateMutationHashes(
  mutations: readonly CapabilityReceipt["mutations"][number][],
): Promise<string | undefined> {
  for (const mutation of mutations) {
    const stat = await fs.lstat(mutation.path).catch(() => null);
    if (mutation.afterHash === null) {
      if (stat) return `provider reported deletion but path still exists: ${mutation.path}`;
      continue;
    }
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      return `provider mutation path is not a regular file: ${mutation.path}`;
    }
    const actual = createHash("sha256").update(await fs.readFile(mutation.path)).digest("hex");
    if (actual !== mutation.afterHash) {
      return `provider mutation hash mismatch for ${mutation.path}: expected ${mutation.afterHash}, observed ${actual}`;
    }
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function capabilityProviderHash(manifest: CapabilityManifest, handlerPath: string): Promise<string> {
  const handler = await fs.readFile(handlerPath);
  return createHash("sha256")
    .update(canonicalCapabilityManifest(manifest), "utf8")
    .update("\0", "utf8")
    .update(handler)
    .digest("hex");
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killed = await new Promise<boolean>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      killer.once("error", () => finish(false));
      killer.once("close", (code) => finish(code === 0 || child.exitCode !== null));
      setTimeout(() => finish(false), 3_000).unref();
    });
    if (!killed && child.exitCode === null) child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
}
