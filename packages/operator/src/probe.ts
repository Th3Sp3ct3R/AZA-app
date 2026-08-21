// Reality probes (Ares v5 / O3 / concept C1).
//
// A probe answers one question against REALITY, not against the agent's memory
// of acting: "is this true right now?" The control loop uses a goal's probe to
// decide `goalMet` — so a Worker can claim it finished, but if the probe is red
// the goal does NOT complete. Reality wins over the worker's word. This is the
// antidote to hallucinated success and the thing that makes the loop converge.
//
// Probe kinds are deliberately concrete and serializable so a goal can carry
// its own verification spec on disk:
//   always  — a stub / manual gate (mostly for tests)
//   file    — a path exists (and optionally contains text)
//   command — a process exits with the expected code (boot the app, run tests)
//   http    — an endpoint returns the expected status/body (hit the live app)

import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { VerificationSpec } from "./types.js";

export interface ProbeResult {
  met: boolean;
  summary: string;
  /** A cheap value that changes when reality changes — lets the loop detect "moved". */
  fingerprint?: string;
}

export interface ProbeContext {
  workspace?: string;
  signal?: AbortSignal;
}

export async function runProbe(spec: VerificationSpec, ctx: ProbeContext = {}): Promise<ProbeResult> {
  switch (spec.kind) {
    case "always":
      return { met: spec.met, summary: spec.summary ?? `always:${spec.met}`, fingerprint: String(spec.met) };
    case "file":
      return probeFile(spec, ctx);
    case "command":
      return probeCommand(spec, ctx);
    case "http":
      return probeHttp(spec, ctx);
    default: {
      const exhaustive: never = spec;
      return { met: false, summary: `unknown probe ${JSON.stringify(exhaustive)}` };
    }
  }
}

async function probeFile(spec: Extract<VerificationSpec, { kind: "file" }>, ctx: ProbeContext): Promise<ProbeResult> {
  const target = path.isAbsolute(spec.path) ? spec.path : path.join(ctx.workspace ?? process.cwd(), spec.path);
  try {
    const info = await fs.stat(target);
    if (!info.isFile()) return { met: false, summary: `${spec.path} is not a file`, fingerprint: "notfile" };
    if (spec.contains !== undefined) {
      const text = await fs.readFile(target, "utf8");
      const ok = text.includes(spec.contains);
      return { met: ok, summary: ok ? `${spec.path} contains expected text` : `${spec.path} is missing expected text`, fingerprint: `${info.size}:${ok}` };
    }
    return { met: true, summary: `${spec.path} exists (${info.size}b)`, fingerprint: `${info.size}:${Math.round(info.mtimeMs)}` };
  } catch {
    return { met: false, summary: `${spec.path} does not exist`, fingerprint: "absent" };
  }
}

async function probeCommand(spec: Extract<VerificationSpec, { kind: "command" }>, ctx: ProbeContext): Promise<ProbeResult> {
  const expect = spec.expectExit ?? 0;
  const cwd = spec.cwd ?? ctx.workspace ?? process.cwd();
  const { code, out } = await runCommand(spec.cmd, spec.args ?? [], cwd, spec.timeoutMs ?? 30_000, ctx.signal);
  const exitOk = code === expect;
  const containsOk = spec.contains === undefined || out.includes(spec.contains);
  return {
    met: exitOk && containsOk,
    summary: containsOk
      ? `${spec.cmd} exited ${code} (expected ${expect})`
      : `${spec.cmd} exited ${code} but output is missing "${spec.contains}"`,
    fingerprint: `${code}:${out.slice(0, 48)}`,
  };
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number; out: string }> {
  // Probes judge reality with a clean slate. Under a node:test parent the
  // inherited NODE_TEST_CONTEXT turns a grandchild `node --test` into a
  // reporter-less child that exits 0 regardless of failures — a false-green
  // oracle that let an unsolved gauntlet fixture score 100% in CI.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("NODE_TEST_")) delete env[key];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell: false, env });
    let out = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, out });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      finish(-1);
    };
    signal?.addEventListener("abort", onAbort);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

async function probeHttp(spec: Extract<VerificationSpec, { kind: "http" }>, ctx: ProbeContext): Promise<ProbeResult> {
  const expect = spec.expectStatus ?? 200;
  // ALWAYS impose a deadline. The caller (controlLoop) always threads a signal,
  // and it's usually a never-firing one — so `ctx.signal ?? timeout` would drop
  // spec.timeoutMs and fetch() would have no deadline, hanging the loop forever.
  // Race the caller's signal against our own timeout the way probeCommand does.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), spec.timeoutMs ?? 10_000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(spec.url, { signal });
    const body = spec.contains !== undefined ? await res.text() : "";
    const statusOk = res.status === expect;
    const containsOk = spec.contains === undefined || body.includes(spec.contains);
    return {
      met: statusOk && containsOk,
      summary: `GET ${spec.url} -> ${res.status} (expected ${expect})${spec.contains !== undefined ? `, contains=${containsOk}` : ""}`,
      fingerprint: `${res.status}:${body.length}`,
    };
  } catch (err) {
    return { met: false, summary: `GET ${spec.url} failed: ${err instanceof Error ? err.message : String(err)}`, fingerprint: "error" };
  } finally {
    clearTimeout(timer);
  }
}
