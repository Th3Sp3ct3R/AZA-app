// ShellRegistry — session-owned foreground handles plus restart-durable
// background shell jobs. BashOutput polls; KillShell terminates.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BackgroundJobRecord, JsonValue, SessionKernelStore } from "@ares/core";
import { toolError } from "./_shared.js";
import type { ShellSupervisorManifest, ShellSupervisorState } from "./ShellSupervisor.js";

const MAX_BUFFER_CHARS = 200_000;
const MAX_DURABLE_POLL_BYTES = 200_000;
const SUPERVISOR_HEARTBEAT_STALE_MS = 30_000;
const SUPERVISOR_LAUNCH_TIMEOUT_MS = 5_000;

export interface ShellLaunchOptions {
  program: string;
  args: string[];
  cwd: string;
  description: string;
  /** Canonical owner. Required when durable persistence is enabled. */
  sessionId?: string;
  /** Stable parent tool-use identity. Replays address, never duplicate, a job. */
  invocationKey?: string;
  /** Soft timeout (kill after). Optional — backgrounded shells often run forever. */
  timeoutMs?: number;
  /** Relaunch lineage: the job this one is a resumption of. */
  resumedFrom?: string;
  /** Which relaunch this is. 1 = the original launch. */
  attempt?: number;
}

export interface ShellSnapshot {
  id: string;
  description: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "errored" | "orphaned";
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  /** Total chars for legacy jobs; exact spool bytes for durable jobs. */
  totalChars: number;
  durable?: boolean;
  pid?: number | null;
  outputPath?: string;
  recovered?: boolean;
  /** Stopped because the host was going away (Stop, or the app closing) rather
   *  than because the work finished or the user killed it. */
  suspended?: boolean;
  /** Why it stopped, in words — shown in the UI and handed to the model. */
  stoppedReason?: string;
  /** A suspended job can be relaunched exactly as it was. */
  resumable?: boolean;
  /** Lineage when this job is a relaunch of an earlier one. */
  resumedFrom?: string;
}

export interface ShellRegistryDurability {
  kernel: SessionKernelStore;
  workspace: string;
}

interface ShellState {
  id: string;
  child: ChildProcess;
  description: string;
  command: string;
  cwd: string;
  status: ShellSnapshot["status"];
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  buffer: Array<{ stream: "stdout" | "stderr"; text: string; ts: number }>;
  totalChars: number;
  cursors: Map<string, number>;
  events: EventEmitter;
}

export class ShellRegistry {
  private readonly shells = new Map<string, ShellState>();
  private readonly knownSessionIds = new Set<string>();
  private counter = 0;
  private durability?: ShellRegistryDurability;

  configureDurability(options: ShellRegistryDurability): this {
    const workspace = path.resolve(options.workspace);
    if (this.durability) {
      if (this.durability.kernel !== options.kernel || path.resolve(this.durability.workspace) !== workspace) {
        throw new Error("ShellRegistry durability cannot be rebound to another kernel/workspace");
      }
      return this;
    }
    this.durability = { kernel: options.kernel, workspace };
    return this;
  }

  /** Register one canonical session with this registry. This never shares jobs:
   * every durable lookup still predicates on the caller's session id. */
  registerSession(sessionId: string): void {
    if (!sessionId.trim()) return;
    const fresh = !this.knownSessionIds.has(sessionId);
    this.knownSessionIds.add(sessionId);
    // Sweep this session's durable jobs the first time we see it — i.e. at
    // session start and after every restart.
    if (fresh) this.sweepDurableJobs(sessionId);
  }

  /**
   * Settle every job whose process is gone, and reap any tree still alive
   * behind a job that is no longer being watched.
   *
   * Reconciliation used to be PULL-ONLY: `reconcileDurableJob` ran when the
   * model polled a job, so a turn that fired background work and never polled
   * left the record at `running` forever. A real session accumulated FOURTEEN
   * jobs stuck in `running` — thirteen of them long-dead processes — because
   * nothing ever looked. The live one was an orphaned dev server the owner
   * never asked to keep, still respawning a game every few minutes.
   *
   * Best-effort by construction: a sweep must never break a turn, so every
   * failure here is swallowed.
   */
  sweepDurableJobs(sessionId: string): { settled: number; reaped: number } {
    const result = { settled: 0, reaped: 0 };
    if (!this.durability) return result;
    let jobs: BackgroundJobRecord[];
    try {
      jobs = this.durability.kernel.listBackgroundJobs(sessionId, { kind: "shell" });
    } catch {
      return result;
    }
    for (const job of jobs) {
      if (isTerminalJob(job)) continue;
      try {
        const before = job.status;
        const after = this.reconcileDurableJob(job);
        if (after.status !== before && isTerminalJob(after)) {
          result.settled++;
          // A settled job must not leave a live process behind. The supervisor
          // is detached and unref'd, so nothing else will ever reap it.
          if (after.pid && processAlive(after.pid)) {
            void killProcessTree(after.pid, () => false).catch(() => false);
            result.reaped++;
          }
        }
      } catch {
        // One unreadable record must not stop the sweep.
      }
    }
    return result;
  }

  list(sessionId?: string): ShellSnapshot[] {
    if (this.durability && sessionId) {
      this.registerSession(sessionId);
      return this.durability.kernel
        .listBackgroundJobs(sessionId, { kind: "shell" })
        .map((job) => this.reconcileDurableJob(job))
        .map((job) => durableSnapshot(job, true));
    }
    return [...this.shells.values()].map(snapshot);
  }

  has(id: string, sessionId?: string): boolean {
    return this.get(id, sessionId) !== undefined;
  }

  get(id: string, sessionId?: string): ShellSnapshot | undefined {
    if (this.durability && sessionId) {
      this.registerSession(sessionId);
      const job = this.durability.kernel.getBackgroundJob(id);
      if (!job || job.kind !== "shell" || job.sessionId !== sessionId) return undefined;
      return durableSnapshot(this.reconcileDurableJob(job), true);
    }
    const state = this.shells.get(id);
    return state ? snapshot(state) : undefined;
  }

  async spawn(opts: ShellLaunchOptions): Promise<ShellSnapshot> {
    if (this.durability) {
      if (!opts.sessionId || !opts.invocationKey) {
        throw new Error("Durable background shells require sessionId and invocationKey");
      }
      this.registerSession(opts.sessionId);
      return this.spawnDurable(opts as ShellLaunchOptions & { sessionId: string; invocationKey: string });
    }
    return this.spawnLegacy(opts);
  }

  private async spawnDurable(
    opts: ShellLaunchOptions & { sessionId: string; invocationKey: string },
  ): Promise<ShellSnapshot> {
    const id = stableJobId("sh", opts.sessionId, opts.invocationKey);
    const prior = this.durability!.kernel.getBackgroundJob(id);
    if (prior) {
      if (prior.sessionId !== opts.sessionId || prior.kind !== "shell") {
        throw new Error(`background shell identity collision: ${id}`);
      }
      const reconciled = this.reconcileDurableJob(prior);
      if (reconciled.status !== "queued") return durableSnapshot(reconciled, true);
      // A queued record means the host died before launch confirmation. Its
      // token-bound state file is checked once more before a safe relaunch.
      const state = readSupervisorState(reconciled);
      if (state) return durableSnapshot(this.reconcileDurableJob(reconciled), true);
    }

    const token = prior?.processToken ?? randomUUID();
    const root = path.join(this.durability!.workspace, ".ares", "background-jobs", opts.sessionId);
    const statePath = prior?.statePath ?? path.join(root, `${id}.state.json`);
    const outputPath = prior?.outputPath ?? path.join(root, `${id}.output.log`);
    const manifestPath = path.join(root, `${id}.launch.json`);
    const priorRequest = prior ? jobRequest(prior) : {};
    const request = {
      version: 1,
      program: opts.program,
      args: opts.args,
      cwd: opts.cwd,
      description: opts.description,
      // Enough to relaunch this exact job later, and to show where it came from.
      attempt: typeof priorRequest.attempt === "number" ? priorRequest.attempt : (opts.attempt ?? 1),
      ...(opts.resumedFrom ? { resumedFrom: opts.resumedFrom } : {}),
    } satisfies JsonValue;
    const created = prior ?? this.durability!.kernel.createBackgroundJob({
      id,
      sessionId: opts.sessionId,
      invocationKey: opts.invocationKey,
      kind: "shell",
      description: opts.description,
      request,
      processToken: token,
      statePath,
      outputPath,
    }).record;

    await mkdir(root, { recursive: true });
    const manifest: ShellSupervisorManifest = {
      version: 1,
      jobId: id,
      token: created.processToken!,
      program: opts.program,
      args: opts.args,
      cwd: opts.cwd,
      outputPath: created.outputPath!,
      statePath: created.statePath!,
      createdAtMs: created.createdAtMs,
    };
    await writeJsonAtomic(manifestPath, manifest);
    const supervisorPath = fileURLToPath(new URL("./ShellSupervisor.js", import.meta.url));
    const supervisor = spawn(process.execPath, [supervisorPath, manifestPath], {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      supervisor.once("spawn", resolve);
      supervisor.once("error", reject);
    }).catch((error: NodeJS.ErrnoException) => {
      this.durability!.kernel.settleBackgroundJob(id, {
        status: "failed",
        error: { message: error.message, code: error.code ?? null },
      });
      throw toolError(`Background shell supervisor failed to launch: ${error.code ?? error.message}`);
    });
    supervisor.unref();

    // Persist the supervisor pid immediately. If the host dies before its state
    // file arrives, restart can still distinguish "spawned" from "never ran".
    this.durability!.kernel.markBackgroundJobRunning(id, {
      pid: supervisor.pid ?? null,
      processToken: manifest.token,
      statePath: manifest.statePath,
      outputPath: manifest.outputPath,
      heartbeatAtMs: Date.now(),
    });
    const state = await waitForSupervisorState(created, SUPERVISOR_LAUNCH_TIMEOUT_MS);
    if (!state) {
      const alive = supervisor.pid ? processAlive(supervisor.pid) : false;
      if (!alive) {
        const failed = this.durability!.kernel.settleBackgroundJob(id, {
          status: "failed",
          error: { message: "Detached supervisor exited before publishing launch state" },
        });
        throw toolError(`Background shell failed to launch: ${failed.id}`);
      }
      // Process is proven live but its control plane is not ready. Keep the
      // durable running state; the next poll performs token/heartbeat recovery.
    }
    let job = this.reconcileDurableJob(this.durability!.kernel.getBackgroundJob(id)!);
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timer = setTimeout(() => void this.kill(id, "timeout", opts.sessionId), opts.timeoutMs);
      timer.unref();
    }
    job = this.durability!.kernel.getBackgroundJob(id) ?? job;
    return durableSnapshot(job, false);
  }

  private async spawnLegacy(opts: ShellLaunchOptions): Promise<ShellSnapshot> {
    const id = `sh_${(++this.counter).toString(36)}_${Date.now().toString(36)}`;
    const child = spawn(opts.program, opts.args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
    });
    const state: ShellState = {
      id,
      child,
      description: opts.description,
      command: `${opts.program} ${opts.args.join(" ")}`,
      cwd: opts.cwd,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      buffer: [],
      totalChars: 0,
      cursors: new Map(),
      events: new EventEmitter(),
    };
    const appendChunk = (stream: "stdout" | "stderr", buf: Buffer) => {
      const text = buf.toString("utf8");
      state.totalChars += text.length;
      state.buffer.push({ stream, text, ts: Date.now() });
      while (state.totalChars > MAX_BUFFER_CHARS && state.buffer.length > 1) {
        const removed = state.buffer.shift()!;
        state.totalChars -= removed.text.length;
        for (const [key, value] of state.cursors) state.cursors.set(key, Math.max(0, value - 1));
      }
      state.events.emit("data");
    };
    child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));
    child.on("error", () => {
      state.status = "errored";
      state.finishedAt = new Date().toISOString();
      state.events.emit("end");
    });
    child.on("close", (code) => {
      state.status = state.status === "killed" ? "killed" : "exited";
      state.exitCode = code;
      state.finishedAt = new Date().toISOString();
      state.events.emit("end");
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((error: NodeJS.ErrnoException) => {
      throw toolError(`Background shell failed to launch: ${error.code ?? error.message}`);
    });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timer = setTimeout(() => void this.kill(id, "timeout"), opts.timeoutMs);
      timer.unref();
    }
    this.shells.set(id, state);
    return snapshot(state);
  }

  /** Read all NEW output since this durable consumer last acknowledged bytes. */
  poll(id: string, cursorKey: string, filter?: RegExp, sessionId?: string): {
    snapshot: ShellSnapshot;
    output: string;
    newChunks: number;
  } | null {
    if (this.durability && sessionId) return this.pollDurable(id, cursorKey, filter, sessionId);
    const state = this.shells.get(id);
    if (!state) return null;
    const start = state.cursors.get(cursorKey) ?? 0;
    const chunks = state.buffer.slice(start);
    state.cursors.set(cursorKey, state.buffer.length);
    let text = chunks.map((chunk) => chunk.stream === "stderr" ? `[stderr] ${chunk.text}` : chunk.text).join("");
    if (filter) text = filterLines(text, filter);
    return { snapshot: snapshot(state), output: text, newChunks: chunks.length };
  }

  private pollDurable(id: string, cursorKey: string, filter: RegExp | undefined, sessionId: string): {
    snapshot: ShellSnapshot;
    output: string;
    newChunks: number;
  } | null {
    this.registerSession(sessionId);
    let job = this.durability!.kernel.getBackgroundJob(id);
    if (!job || job.kind !== "shell" || job.sessionId !== sessionId) return null;
    job = this.reconcileDurableJob(job);
    const outputPath = job.outputPath;
    if (!outputPath || !existsSync(outputPath)) {
      return { snapshot: durableSnapshot(job, true), output: "", newChunks: 0 };
    }
    const available = statSync(outputPath).size;
    this.durability!.kernel.updateBackgroundJobObservation(id, { outputBytes: available });
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = Math.min(this.durability!.kernel.getBackgroundJobCursor(id, cursorKey), available);
      const wanted = Math.min(MAX_DURABLE_POLL_BYTES, available - start);
      if (wanted <= 0) return { snapshot: durableSnapshot(job, true), output: "", newChunks: 0 };
      const fd = openSync(outputPath, "r");
      let bytesRead = 0;
      let buffer: Buffer;
      try {
        buffer = Buffer.allocUnsafe(wanted);
        bytesRead = readSync(fd, buffer, 0, wanted, start);
      } finally {
        closeSync(fd);
      }
      const safeBytes = completeUtf8Prefix(buffer.subarray(0, bytesRead));
      if (safeBytes === 0 && bytesRead > 0) continue;
      const end = start + safeBytes;
      const text = buffer.subarray(0, safeBytes).toString("utf8");
      if (!this.durability!.kernel.advanceBackgroundJobCursor(id, cursorKey, start, end)) continue;
      const rendered = filter ? filterLines(text, filter) : text;
      return {
        snapshot: durableSnapshot(this.durability!.kernel.getBackgroundJob(id) ?? job, true),
        output: rendered,
        newChunks: safeBytes > 0 ? 1 : 0,
      };
    }
    throw new Error(`background output cursor changed concurrently: ${id}/${cursorKey}`);
  }

  async kill(id: string, reason: "user" | "timeout" = "user", sessionId?: string): Promise<boolean> {
    if (this.durability && sessionId) return this.killDurable(id, reason, sessionId);
    const state = this.shells.get(id);
    if (!state || state.status !== "running") return false;
    void reason;
    const confirmed = await killProcessTree(state.child.pid, () => state.child.kill());
    if (confirmed && state.status === "running") {
      state.status = "killed";
      state.finishedAt = new Date().toISOString();
      state.events.emit("end");
    }
    return confirmed;
  }

  /**
   * Kill every non-terminal shell this session owns. Returns how many were
   * actually killed.
   *
   * This is the force-stop escape hatch. A turn whose subprocess dies out from
   * under it (or which is blocked on a command that never returns) never
   * unwinds its generator, so a normal Stop has nothing to settle and the owner
   * is left with no exit. Ending what the turn is blocked ON is the honest way
   * to break that: it does not pretend the turn finished cleanly, and the
   * caller is expected to disclose that side effects may be incomplete.
   */
  async killAllForSession(sessionId: string): Promise<number> {
    let killed = 0;
    if (this.durability && sessionId) {
      let jobs: BackgroundJobRecord[];
      try {
        jobs = this.durability.kernel.listBackgroundJobs(sessionId, { kind: "shell" });
      } catch {
        return 0;
      }
      for (const job of jobs) {
        if (isTerminalJob(job)) continue;
        try {
          if (await this.killDurable(job.id, "user", sessionId)) killed++;
        } catch {
          // One stubborn job must not stop the rest from being reaped.
        }
      }
      return killed;
    }
    for (const [id, state] of this.shells) {
      if (state.status !== "running") continue;
      try {
        if (await this.kill(id, "user")) killed++;
      } catch { /* best effort */ }
    }
    return killed;
  }

  /**
   * Stop background work because the HOST is going away — a Stop the user
   * pressed, or the app closing — and record it as resumable rather than
   * finished.
   *
   * Field origin: background supervisors are detached and unref'd, so they
   * outlive everything. Ares closed and a job kept running: a dev server that
   * relaunched a game every few minutes, for days, with no window open to show
   * it and nothing to stop it from. "Ares keeps launching Minecraft when I'm
   * not even using it" was a background job nobody could see and nothing ever
   * reaped.
   *
   * The rule this establishes: NO background job outlives the host that owns
   * it. It is stopped and marked resumable, so picking the session back up
   * offers it — deliberately, once, to a human — instead of resurrecting it
   * behind their back.
   *
   * `since` scopes it to work started after a moment (the turn being
   * interrupted), leaving older jobs the user deliberately kept alone.
   * Deliberately NO completion input is written: a suspension is not news the
   * model needs to wake up and act on, and a queue of them at startup is
   * exactly how an unattended relaunch loop begins.
   */
  async suspendForSession(
    sessionId: string,
    opts: { reason: string; since?: number } = { reason: "host stopped" },
  ): Promise<ShellSnapshot[]> {
    const suspended: ShellSnapshot[] = [];
    if (!this.durability || !sessionId) {
      for (const [id, state] of this.shells) {
        if (state.status !== "running") continue;
        if (opts.since !== undefined && Date.parse(state.startedAt) < opts.since) continue;
        if (await this.kill(id, "user")) suspended.push({ ...snapshot(state), suspended: true, stoppedReason: opts.reason, resumable: true });
      }
      return suspended;
    }
    let jobs: BackgroundJobRecord[];
    try {
      jobs = this.durability.kernel.listBackgroundJobs(sessionId, { kind: "shell" });
    } catch {
      return suspended;
    }
    for (const job of jobs) {
      if (isTerminalJob(job)) continue;
      if (opts.since !== undefined && (job.startedAtMs ?? job.createdAtMs) < opts.since) continue;
      try {
        const stopped = await this.stopJobProcess(job);
        // Record it even when the process was already gone: the point is that
        // the RECORD stops reading "running" and starts reading "resumable".
        const settled = this.settleShellJob(
          this.durability.kernel.getBackgroundJob(job.id) ?? job,
          "cancelled",
          null,
          null,
          job.outputBytes,
          { suspended: true, resumable: true, stoppedReason: opts.reason, processStopped: stopped },
          { completion: false },
        );
        suspended.push(durableSnapshot(settled, true));
      } catch {
        // One stubborn job must never block the rest of a shutdown sweep.
      }
    }
    return suspended;
  }

  /**
   * The BOOT sweep: stop background work left behind by a host that is gone.
   *
   * The shutdown sweep only runs when the host shuts down cleanly. The crash
   * path — and exit 134 made that path common — leaves every detached
   * supervisor running with nothing left that knows about it. That is the
   * state people actually hit: Ares died, and a job kept relaunching a game
   * for days across restarts, because each new host found it already "running"
   * and left it alone.
   *
   * `before` is this host's start time: anything that began earlier belongs to
   * a previous host and is suspended; anything a LIVE sibling host (the
   * garrison, a CLI session sharing this workspace) starts afterwards is
   * untouched.
   */
  async suspendAbandoned(opts: { before: number; reason: string }): Promise<ShellSnapshot[]> {
    const suspended: ShellSnapshot[] = [];
    if (!this.durability) return suspended;
    let jobs: BackgroundJobRecord[];
    try {
      // No session filter: leftovers belong to sessions this host has not
      // opened yet, and may never open. That is precisely why they are lost.
      jobs = this.durability.kernel.listBackgroundJobs(undefined, {
        kind: "shell",
        statuses: ["queued", "running"],
      });
    } catch {
      return suspended;
    }
    for (const job of jobs) {
      if ((job.startedAtMs ?? job.createdAtMs) >= opts.before) continue;
      try {
        const stopped = await this.stopJobProcess(job);
        const settled = this.settleShellJob(
          this.durability.kernel.getBackgroundJob(job.id) ?? job,
          "cancelled",
          null,
          null,
          job.outputBytes,
          { suspended: true, resumable: true, stoppedReason: opts.reason, processStopped: stopped },
          { completion: false },
        );
        suspended.push(durableSnapshot(settled, true));
      } catch {
        // Never let one unreadable record stop a boot.
      }
    }
    return suspended;
  }

  /** Suspend every session this registry has seen. The shutdown sweep. */
  async suspendAll(reason: string): Promise<ShellSnapshot[]> {
    const all: ShellSnapshot[] = [];
    for (const sessionId of [...this.knownSessionIds]) {
      all.push(...(await this.suspendForSession(sessionId, { reason })));
    }
    if (!this.durability) all.push(...(await this.suspendForSession("", { reason })));
    return all;
  }

  /**
   * Relaunch a stopped job exactly as it was, as a NEW attempt.
   *
   * Resumption is always explicit — a human or a model asking for it by id.
   * Nothing here is ever called automatically at startup, which is the whole
   * point: a resumable record is an offer, not a promise to run it again.
   */
  async resume(id: string, sessionId: string): Promise<ShellSnapshot> {
    if (!this.durability) throw toolError("resuming a background job requires durable storage");
    const job = this.durability.kernel.getBackgroundJob(id);
    if (!job || job.kind !== "shell" || job.sessionId !== sessionId) {
      throw toolError(`unknown background job: ${id}`);
    }
    const request = jobRequest(job);
    const program = typeof request.program === "string" ? request.program : "";
    const cwd = typeof request.cwd === "string" ? request.cwd : "";
    if (!program || !cwd) throw toolError(`background job ${id} cannot be resumed: its launch request is incomplete`);
    if (!isTerminalJob(this.reconcileDurableJob(job))) {
      // Still alive — resuming would double-launch it.
      return durableSnapshot(this.durability.kernel.getBackgroundJob(id) ?? job, true);
    }
    const attempt = (typeof request.attempt === "number" ? request.attempt : 1) + 1;
    return this.spawn({
      program,
      args: Array.isArray(request.args) ? request.args.filter((a): a is string => typeof a === "string") : [],
      cwd,
      description: job.description,
      sessionId,
      // A fresh invocation key so this becomes its own record instead of
      // returning the terminal one it descends from.
      invocationKey: `${job.invocationKey}#resume${attempt}`,
      resumedFrom: job.id,
      attempt,
    });
  }

  /** SIGTERM the supervisor tree behind a job. Returns whether a kill landed. */
  private async stopJobProcess(job: BackgroundJobRecord): Promise<boolean> {
    const pid = job.pid;
    if (!pid || !processAlive(pid)) return false;
    this.durability?.kernel.requestBackgroundJobCancellation(job.id);
    return await killProcessTree(pid, () => {
      try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
    });
  }

  private async killDurable(id: string, reason: "user" | "timeout", sessionId: string): Promise<boolean> {
    this.registerSession(sessionId);
    let job = this.durability!.kernel.getBackgroundJob(id);
    if (!job || job.kind !== "shell" || job.sessionId !== sessionId) return false;
    job = this.reconcileDurableJob(job);
    if (isTerminalJob(job)) return false;
    this.durability!.kernel.requestBackgroundJobCancellation(id);
    const pid = job.pid;
    if (!pid) return false;
    const sent = await killProcessTree(pid, () => {
      try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
    });
    if (!sent) return false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = this.durability!.kernel.getBackgroundJob(id)!;
      const supervisorState = readSupervisorState(job);
      if (supervisorState && (supervisorState.phase === "completed" || supervisorState.phase === "failed" || supervisorState.phase === "cancelled")) {
        job = this.reconcileDurableJob(job);
        return job.status === "cancelled" || job.status === "failed";
      }
      if (!processAlive(pid)) {
        const outputBytes = job.outputPath && existsSync(job.outputPath) ? statSync(job.outputPath).size : job.outputBytes;
        this.settleShellJob(job, "cancelled", null, null, outputBytes);
        return true;
      }
    }
    // A proven-dead supervisor without a terminal file is explicit orphaned
    // state, never a fabricated successful kill.
    if (!processAlive(pid)) {
      this.durability!.kernel.settleBackgroundJob(id, {
        status: "orphaned",
        error: { message: `Supervisor died after ${reason} kill without terminal state` },
      });
    }
    return false;
  }

  /** Explicit destructive cleanup. Normal session disposal deliberately does
   * not call this: durable jobs are supposed to survive host restart. */
  async killAll(): Promise<number> {
    let count = 0;
    for (const id of [...this.shells.keys()]) if (await this.kill(id)) count++;
    if (this.durability) {
      for (const sessionId of this.knownSessionIds) {
        for (const job of this.durability.kernel.listBackgroundJobs(sessionId, { kind: "shell", statuses: ["queued", "running"] })) {
          if (await this.kill(job.id, "user", sessionId)) count++;
        }
      }
    }
    return count;
  }

  /** Forget only in-memory handles. Detached supervisors and durable ownership
   * remain untouched and are rediscovered by the next host. */
  detachAll(): void {
    this.shells.clear();
    this.knownSessionIds.clear();
  }

  private reconcileDurableJob(job: BackgroundJobRecord): BackgroundJobRecord {
    if (!this.durability || isTerminalJob(job)) return job;
    const state = readSupervisorState(job);
    const outputBytes = job.outputPath && existsSync(job.outputPath) ? statSync(job.outputPath).size : job.outputBytes;
    if (!state) {
      if (job.status === "running" && job.pid && !processAlive(job.pid)) {
        return this.settleShellJob(job, "orphaned", {
          message: "Background supervisor disappeared before publishing terminal state",
        }, null, outputBytes);
      }
      return this.durability.kernel.updateBackgroundJobObservation(job.id, { outputBytes });
    }
    this.durability.kernel.updateBackgroundJobObservation(job.id, {
      outputBytes,
      heartbeatAtMs: state.heartbeatAtMs,
      pid: state.supervisorPid,
    });
    const settleTerminalPhase = (phase: ShellSupervisorState["phase"], terminal: ShellSupervisorState): BackgroundJobRecord | null => {
      if (phase === "completed") return this.settleShellJob(job, "completed", null, terminal.exitCode, outputBytes);
      if (phase === "failed") {
        return this.settleShellJob(job, "failed", { message: terminal.error ?? `Shell exited ${terminal.exitCode ?? "unknown"}` }, terminal.exitCode, outputBytes);
      }
      if (phase === "cancelled") return this.settleShellJob(job, "cancelled", null, terminal.exitCode, outputBytes);
      return null;
    };
    const settled = settleTerminalPhase(state.phase, state);
    if (settled) return settled;
    const fresh = Date.now() - state.heartbeatAtMs <= SUPERVISOR_HEARTBEAT_STALE_MS;
    if (!fresh || !processAlive(state.supervisorPid)) {
      // The supervisor publishes terminal state BEFORE it exits, so a dead pid
      // behind a running-phase file usually means the read raced the final
      // write by milliseconds. Re-read once before the orphaned verdict —
      // settling a finished job as orphaned is a lie that sticks (terminal).
      const reread = readSupervisorState(job);
      if (reread) {
        const late = settleTerminalPhase(reread.phase, reread);
        if (late) return late;
      }
      return this.settleShellJob(job, "orphaned", {
        message: fresh
          ? "Background supervisor pid is no longer alive"
          : "Background supervisor heartbeat is stale; process identity cannot be proven",
      }, null, outputBytes);
    }
    return this.durability.kernel.markBackgroundJobRunning(job.id, {
      pid: state.supervisorPid,
      heartbeatAtMs: state.heartbeatAtMs,
    });
  }

  private settleShellJob(
    job: BackgroundJobRecord,
    status: "completed" | "failed" | "cancelled" | "orphaned",
    error: JsonValue | null,
    exitCode: number | null,
    outputBytes: number,
    extra: Record<string, JsonValue> = {},
    opts: { completion?: boolean } = {},
  ): BackgroundJobRecord {
    const tail = readTail(job.outputPath, 16_000);
    const text = [
      `[background shell ${job.id} ${status}${exitCode === null ? "" : ` (exit ${exitCode})`}]`,
      tail ? `Latest output:\n${tail}` : "No output was captured.",
      job.outputPath ? `Complete output: ${job.outputPath}` : "",
    ].filter(Boolean).join("\n");
    return this.durability!.kernel.settleBackgroundJob(job.id, {
      status,
      result: { shellId: job.id, status, exitCode, outputPath: job.outputPath, outputBytes, ...extra },
      error,
      exitCode,
      outputBytes,
      // A suspension writes NO completion input. The completion row becomes a
      // recovered turn on the next start, and "the host stopped your job" is
      // not something the model should wake up and act on — that path is how an
      // unattended relaunch loop starts.
      ...(opts.completion === false ? {} : {
        completion: {
          id: stableJobId("input", job.sessionId, job.id, "completion"),
          idempotencyKey: `background-job:${job.id}:completion`,
          payload: {
            kind: "background-job-completion",
            jobId: job.id,
            content: [{ type: "text", text }],
          },
        },
      }),
    });
  }
}

function snapshot(state: ShellState): ShellSnapshot {
  return {
    id: state.id,
    description: state.description,
    command: state.command,
    cwd: state.cwd,
    status: state.status,
    exitCode: state.exitCode,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    totalChars: state.totalChars,
  };
}

/** A job's launch request as a plain record — the shape everything reads. */
function jobRequest(job: BackgroundJobRecord): Record<string, JsonValue> {
  return job.request && typeof job.request === "object" && !Array.isArray(job.request)
    ? job.request as Record<string, JsonValue>
    : {};
}

function jobResult(job: BackgroundJobRecord): Record<string, JsonValue> {
  return job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result as Record<string, JsonValue>
    : {};
}

function durableSnapshot(job: BackgroundJobRecord, recovered: boolean): ShellSnapshot {
  const request = jobRequest(job);
  const result = jobResult(job);
  const program = typeof request.program === "string" ? request.program : "shell";
  const args = Array.isArray(request.args) ? request.args.filter((value): value is string => typeof value === "string") : [];
  const status: ShellSnapshot["status"] = job.status === "completed"
    ? "exited"
    : job.status === "cancelled"
      ? "killed"
      : job.status === "failed"
        ? "errored"
        : job.status === "orphaned"
          ? "orphaned"
          : "running";
  return {
    id: job.id,
    description: job.description,
    command: `${program} ${args.join(" ")}`,
    cwd: typeof request.cwd === "string" ? request.cwd : "",
    status,
    exitCode: job.exitCode,
    startedAt: new Date(job.startedAtMs ?? job.createdAtMs).toISOString(),
    ...(job.finishedAtMs ? { finishedAt: new Date(job.finishedAtMs).toISOString() } : {}),
    totalChars: job.outputBytes,
    durable: true,
    pid: job.pid,
    ...(job.outputPath ? { outputPath: job.outputPath } : {}),
    recovered,
    ...(result.suspended === true ? { suspended: true } : {}),
    ...(typeof result.stoppedReason === "string" ? { stoppedReason: result.stoppedReason } : {}),
    // Resumable = we stopped it on the host's behalf and still hold everything
    // needed to run it again. A job that finished on its own is not "resumable"
    // — re-running it is a new decision, not a continuation.
    ...(result.resumable === true && typeof request.program === "string" ? { resumable: true } : {}),
    ...(typeof request.resumedFrom === "string" ? { resumedFrom: request.resumedFrom } : {}),
  };
}

function readSupervisorState(job: BackgroundJobRecord): ShellSupervisorState | null {
  if (!job.statePath || !job.processToken) return null;
  try {
    const parsed = JSON.parse(readFileSync(job.statePath, "utf8")) as ShellSupervisorState;
    if (parsed.version !== 1 || parsed.jobId !== job.id || parsed.token !== job.processToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function waitForSupervisorState(job: BackgroundJobRecord, timeoutMs: number): Promise<ShellSupervisorState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readSupervisorState(job);
    if (state && state.phase !== "launching") return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return readSupervisorState(job);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killProcessTree(pid: number | undefined, fallback: () => boolean): Promise<boolean> {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      return await new Promise<boolean>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => {
          try { resolve(fallback()); } catch { resolve(false); }
        });
        killer.once("close", (code) => resolve(code === 0));
      });
    }
    try {
      process.kill(-pid, "SIGTERM");
      return true;
    } catch {
      return fallback();
    }
  } catch {
    return false;
  }
}

function filterLines(text: string, filter: RegExp): string {
  return text.split("\n").filter((line) => {
    filter.lastIndex = 0;
    return filter.test(line);
  }).join("\n");
}

function completeUtf8Prefix(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim++) {
    const length = buffer.length - trim;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      return length;
    } catch {
      // A partial final code point may require up to three bytes of trim.
    }
  }
  return buffer.length;
}

function readTail(filename: string | null, maxBytes: number): string {
  if (!filename || !existsSync(filename)) return "";
  const fd = openSync(filename, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  const temp = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, filename);
  } catch {
    await rm(filename, { force: true });
    await rename(temp, filename);
  }
}

function stableJobId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return `${prefix}_${hash.digest("hex").slice(0, 32)}`;
}

function isTerminalJob(job: BackgroundJobRecord): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "orphaned";
}
