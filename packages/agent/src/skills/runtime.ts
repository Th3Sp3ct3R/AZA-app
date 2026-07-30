// Skill execution runtime — turns handler.js files from documentation islands
// into running code. This is the line between an agent that writes about
// capabilities and one that grows its own body.
//
// A skill lives at ~/.ares/skills/<name>/ with a SKILL.md and an optional
// handler.js whose default export is `async (input, ctx) => result`. This
// runtime runs that handler in an isolated child Node process:
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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { agentPaths, aresAgentHome } from "../paths.js";
import { exists, writeFileAtomic } from "../files.js";
import { SKILL_NAME } from "../tools/SkillCraft.js";

export interface RunSkillOptions {
  home?: string;
  name: string;
  input?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SkillRunResult {
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
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
  const paths = agentPaths(home);
  const skillDir = path.join(paths.skillsDir, opts.name);
  // Defense-in-depth: confirm the resolved dir still lives under skillsDir.
  if (!path.resolve(skillDir).startsWith(path.resolve(paths.skillsDir) + path.sep)) {
    throw new Error(`skill '${opts.name}' resolves outside the skills directory`);
  }
  const handlerPath = path.join(skillDir, "handler.js");
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  // Cosmetic-toggle fix: a skill marked disabled (marker file dropped/removed by
  // entry.ts's skill_toggle handler) must never spawn, not just show as off in the UI.
  if (await exists(path.join(skillDir, ".disabled"))) {
    throw new Error(`skill '${opts.name}' is disabled`);
  }

  if (!(await exists(handlerPath))) {
    throw new Error(`skill '${opts.name}' has no handler.js to run (looked in ${skillDir})`);
  }

  await ensureSkillsModuleType(paths.skillsDir);
  const runner = await ensureRunner();

  const id = randomUUID();
  const inputFile = path.join(os.tmpdir(), `ares-skill-${id}-in.json`);
  const outputFile = path.join(os.tmpdir(), `ares-skill-${id}-out.json`);
  await writeFileAtomic(inputFile, JSON.stringify(opts.input ?? null));

  const startedAt = Date.now();
  const skillPort = await leaseSkillPort();
  let run: { logs: string; timedOut: boolean; exitCode: number | null; spawnError?: Error };
  try {
    run = await new Promise<{ logs: string; timedOut: boolean; exitCode: number | null; spawnError?: Error }>((resolve) => {
      const child = spawn(process.execPath, [runner], {
        cwd: skillDir,
        windowsHide: true,
        env: {
          ...process.env,
          ARES_HOME: home,
          ARES_SKILL_NAME: opts.name,
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
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      const onAbort = () => child.kill();
      opts.signal?.addEventListener("abort", onAbort);

      const collect = (chunk: Buffer) => chunks.push(chunk);
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      child.on("error", (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ logs: clampLog(Buffer.concat(chunks).toString("utf8")), timedOut, exitCode: null, spawnError: err });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ logs: clampLog(Buffer.concat(chunks).toString("utf8")), timedOut, exitCode: code });
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

  if (run.spawnError) {
    return {
      name: opts.name,
      ok: false,
      error: `failed to start skill runner: ${run.spawnError.message}`,
      logs: run.logs,
      durationMs,
      timedOut: run.timedOut,
      exitCode: run.exitCode,
    };
  }

  if (run.timedOut) {
    return {
      name: opts.name,
      ok: false,
      error: `skill '${opts.name}' timed out after ${timeoutMs}ms`,
      logs: run.logs,
      durationMs,
      timedOut: true,
      exitCode: run.exitCode,
    };
  }

  if (outcome?.ok) {
    return {
      name: opts.name,
      ok: true,
      result: outcome.result,
      logs: run.logs,
      durationMs,
      timedOut: false,
      exitCode: run.exitCode,
    };
  }

  return {
    name: opts.name,
    ok: false,
    error: outcome?.error ?? `skill '${opts.name}' exited ${run.exitCode} without a result`,
    logs: run.logs,
    durationMs,
    timedOut: false,
    exitCode: run.exitCode,
  };
}
