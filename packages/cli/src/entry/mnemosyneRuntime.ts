// mnemosyneRuntime — the live adoption of the standalone memory server.
//
// Mnemosyne shipped in v0.38.0 as a complete package reachable only from its
// CLI; the recall spine still opened memory.jsonl directly from every process.
// This module is the deliberate single-writer migration for RECALL: the first
// process that needs memory HOSTS the server in-process (unref'd — it dies
// with its host); every other process finds it on /health and connects as a
// client. Recall is a write path (surfacing reinforces strength), so routing
// it through one owner removes the worst of the multi-writer contention that
// unifiedRecall.ts documents.
//
// Failure doctrine, in force at every step:
//   - never break a turn over memory: any wire failure falls back to the
//     direct store open that was the status quo;
//   - never fight another process for the port: EADDRINUSE means someone else
//     won the race — probe again and join them;
//   - a dead wire is forgotten, and a later turn re-probes from scratch.
//
// Writes (episodic capture, witness, reflection) stay on their direct
// router/store paths for now: the wire has no batch/all frames yet, and the
// router's channel policy must not be silently bypassed. That migration is a
// separate, deliberate step.

import { request } from "node:http";
import {
  DEFAULT_MNEMOSYNE_PORT,
  MnemosyneClient,
  MnemosyneServer,
  ensureToken,
} from "@ares/mnemosyne";
import { MemoryStore, type RecallResult } from "@ares/mind";

interface MnemosyneHandle {
  client: MnemosyneClient;
  /** True when THIS process owns the server. */
  hosted: boolean;
}

/** The structural shape unifiedRecallForTurn accepts as a LivingRecaller. */
export interface LiveRecallerShape {
  remember(cue: string, opts?: { limit?: number; scope?: string }): Promise<RecallResult[]>;
  peek(cue: string, opts?: { limit?: number; scope?: string }): Promise<RecallResult[]>;
}

const RETRY_AFTER_FAILURE_MS = 60_000;

let cached: { home: string; handle: MnemosyneHandle | null; at: number } | null = null;
let hostedServer: MnemosyneServer | null = null;

export function mnemosyneEnabled(): boolean {
  return process.env.ARES_MNEMOSYNE !== "0";
}

function mnemosynePort(): number {
  const parsed = Number(process.env.ARES_MNEMOSYNE_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MNEMOSYNE_PORT;
}

/** Is a Mnemosyne server already listening? Short fuse, never throws. */
function probeHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/health", method: "GET", timeout: 1_500 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function connectClient(home: string, port: number): Promise<MnemosyneClient> {
  const token = await ensureToken(home);
  const client = new MnemosyneClient({ url: `ws://127.0.0.1:${port}`, token, client: "ares-turn" });
  await client.connect();
  client.unref();
  return client;
}

/**
 * The per-process handle: connect to a running server, or host one. Cached —
 * a null (unavailable) answer is retried after a cooldown, never per-turn.
 */
export async function mnemosyneHandle(home: string): Promise<MnemosyneHandle | null> {
  if (!mnemosyneEnabled()) return null;
  if (cached && cached.home === home) {
    if (cached.handle) return cached.handle;
    if (Date.now() - cached.at < RETRY_AFTER_FAILURE_MS) return null;
  }
  const handle = await acquire(home).catch(() => null);
  cached = { home, handle, at: Date.now() };
  return handle;
}

async function acquire(home: string): Promise<MnemosyneHandle | null> {
  const port = mnemosynePort();
  if (await probeHealth(port)) {
    return { client: await connectClient(home, port), hosted: false };
  }
  const server = new MnemosyneServer({ home, port });
  try {
    await server.start();
    server.unref();
    hostedServer = server;
    return { client: await connectClient(home, port), hosted: true };
  } catch {
    // Lost the hosting race (EADDRINUSE), or the port is owned by something
    // that is NOT Mnemosyne (health said no, listen said busy). Join a sibling
    // if one answers now; otherwise leave the port alone entirely.
    await server.close().catch(() => undefined);
    if (await probeHealth(port)) {
      return { client: await connectClient(home, port), hosted: false };
    }
    return null;
  }
}

/** Forget a dead wire so the next turn re-probes instead of failing forever. */
function markDead(home: string): void {
  if (cached?.home !== home) return;
  cached.handle?.client.close();
  cached = { home, handle: null, at: Date.now() };
}

/**
 * The recaller mindBeforeTurn hands to unifiedRecallForTurn. Every call tries
 * the wire first and falls back to the direct store — the pre-Mnemosyne
 * behavior — the moment anything misbehaves, so a server crash mid-session
 * costs one failed frame, never a turn.
 */
export async function mnemosyneRecaller(home: string, memoryFile: string): Promise<LiveRecallerShape | null> {
  const handle = await mnemosyneHandle(home);
  if (!handle) return null;
  const direct = () => MemoryStore.open(memoryFile);
  return {
    remember: async (cue, opts = {}) => {
      try {
        return await handle.client.recall(cue, { ...opts, reinforce: true });
      } catch {
        markDead(home);
        return (await direct()).remember(cue, opts);
      }
    },
    peek: async (cue, opts = {}) => {
      try {
        return await handle.client.recall(cue, { ...opts, reinforce: false });
      } catch {
        markDead(home);
        return (await direct()).peek(cue, opts);
      }
    },
  };
}

/** Liveness for the cockpit: what this process knows about Mnemosyne. */
export function mnemosyneLiveness(): { state: "hosting" | "connected" | "unavailable" | "disabled" } {
  if (!mnemosyneEnabled()) return { state: "disabled" };
  if (!cached?.handle) return { state: "unavailable" };
  return { state: cached.handle.hosted ? "hosting" : "connected" };
}

/** Test seam: drop every cached handle and close a hosted server. */
export async function resetMnemosyneForTests(): Promise<void> {
  cached?.handle?.client.close();
  cached = null;
  await hostedServer?.close().catch(() => undefined);
  hostedServer = null;
}
