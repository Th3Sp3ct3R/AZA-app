import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Message, StreamEvent, TurnEvent } from "@ares/protocol";
import type { Provider } from "./queryEngine.js";
import {
  DEFAULT_SESSION_LEASE_TTL_MS,
  MAX_SESSION_LEASE_HEARTBEAT_MS,
  MAX_SESSION_LEASE_TTL_MS,
  MIN_SESSION_LEASE_HEARTBEAT_MS,
  MIN_SESSION_LEASE_TTL_MS,
  resolveSessionLeaseTiming,
  Session,
} from "./session.js";
import {
  LeaseHeldError,
  RunLeaseCoordinator,
  SessionKernelStore,
  StaleGenerationError,
  type BetterSqlite3Constructor,
} from "./sessionKernel/index.js";

const requireFromAgent = createRequire(new URL("../../agent/package.json", import.meta.url));
const BetterSqlite3 = requireFromAgent("better-sqlite3") as BetterSqlite3Constructor;

class RecordingKernel extends SessionKernelStore {
  readonly acquiredTtls: number[] = [];
  readonly renewedTtls: number[] = [];

  override acquireRunnerLease(sessionId: string, ownerId: string, ttlMs?: number) {
    if (ttlMs !== undefined) this.acquiredTtls.push(ttlMs);
    return super.acquireRunnerLease(sessionId, ownerId, ttlMs);
  }

  override renewRunnerLease(fence: Parameters<SessionKernelStore["renewRunnerLease"]>[0], ttlMs?: number) {
    if (ttlMs !== undefined) this.renewedTtls.push(ttlMs);
    return super.renewRunnerLease(fence, ttlMs);
  }
}

async function collect(stream: AsyncGenerator<TurnEvent>): Promise<void> {
  for await (const _event of stream) {
    // drain
  }
}

test("Session lease timing defaults to a 30s recovery window and keeps heartbeat at or below one-third TTL", () => {
  assert.deepEqual(resolveSessionLeaseTiming(), {
    leaseTtlMs: DEFAULT_SESSION_LEASE_TTL_MS,
    heartbeatIntervalMs: 10_000,
  });
  assert.deepEqual(resolveSessionLeaseTiming({ leaseTtlMs: 1, heartbeatIntervalMs: 999_999 }), {
    leaseTtlMs: MIN_SESSION_LEASE_TTL_MS,
    heartbeatIntervalMs: Math.floor(MIN_SESSION_LEASE_TTL_MS / 3),
  });
  assert.deepEqual(resolveSessionLeaseTiming({ leaseTtlMs: Number.POSITIVE_INFINITY, heartbeatIntervalMs: -5 }), {
    leaseTtlMs: DEFAULT_SESSION_LEASE_TTL_MS,
    heartbeatIntervalMs: MIN_SESSION_LEASE_HEARTBEAT_MS,
  });
  const maximum = resolveSessionLeaseTiming({ leaseTtlMs: 10 ** 9, heartbeatIntervalMs: 10 ** 9 });
  assert.equal(maximum.leaseTtlMs, MAX_SESSION_LEASE_TTL_MS);
  assert.equal(maximum.heartbeatIntervalMs, MAX_SESSION_LEASE_HEARTBEAT_MS);
});

test("Session passes the configured short TTL to acquire and heartbeat renewal", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-session-short-lease-"));
  const store = new RecordingKernel(new BetterSqlite3(":memory:"));
  const provider: Provider = {
    name: "slow-final",
    async *stream(): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => setTimeout(resolve, 140));
      const message: Message = {
        id: "lease-test-result",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        createdAt: new Date().toISOString(),
      };
      yield {
        type: "message_done",
        message,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };

  try {
    const session = new Session({
      sessionId: "short-lease-session",
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      sessionLeaseTtlMs: 1_000,
      sessionLeaseHeartbeatMs: 50,
    });
    await collect(session.sendContent([{ type: "text", text: "go" }], { inputId: "short-lease-input" }));
    assert.deepEqual(store.acquiredTtls, [1_000]);
    assert.ok(store.renewedTtls.length >= 1, "a long provider wait renews before the short lease expires");
    assert.ok(store.renewedTtls.every((ttl) => ttl === 1_000));
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a crashed short lease is taken over after expiry and the old generation stays fenced", () => {
  let now = 10_000;
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"), { now: () => now });
  try {
    store.createSession({ id: "takeover" });
    const first = store.acquireRunnerLease("takeover", "runner-a", MIN_SESSION_LEASE_TTL_MS);
    assert.throws(
      () => store.acquireRunnerLease("takeover", "runner-b", MIN_SESSION_LEASE_TTL_MS),
      LeaseHeldError,
    );

    now += MIN_SESSION_LEASE_TTL_MS + 1;
    const second = store.acquireRunnerLease("takeover", "runner-b", MIN_SESSION_LEASE_TTL_MS);
    assert.equal(second.generation, first.generation + 1);
    assert.throws(
      () => store.appendEvent(
        { sessionId: first.sessionId, generation: first.generation, leaseToken: first.leaseToken },
        "late.old_generation",
        { rejected: true },
      ),
      StaleGenerationError,
    );
    assert.ok(store.listEvents("takeover").some((event) => event.type === "runner.lease_expired"));
  } finally {
    store.close();
  }
});

test("the shared lease coordinator revokes once on takeover and never releases a stale generation", async () => {
  let now = 50_000;
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"), { now: () => now });
  try {
    store.createSession({ id: "coordinator-revocation" });
    let lost = 0;
    const coordinator = new RunLeaseCoordinator({
      store,
      ownerId: "coordinated-owner",
      leaseTtlMs: MIN_SESSION_LEASE_TTL_MS,
      heartbeatIntervalMs: MIN_SESSION_LEASE_HEARTBEAT_MS,
    });
    const owned = await coordinator.acquire("coordinator-revocation", {
      onLeaseLost: () => {
        lost += 1;
      },
    });

    now += MIN_SESSION_LEASE_TTL_MS + 1;
    const replacement = store.acquireRunnerLease(
      "coordinator-revocation",
      "replacement-owner",
      MIN_SESSION_LEASE_TTL_MS,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, MIN_SESSION_LEASE_HEARTBEAT_MS + 30));
    assert.equal(owned.context.signal.aborted, true);
    assert.equal(lost, 1);
    assert.throws(
      () => owned.release({ executionState: "completed", workOutcome: "verified" }),
      StaleGenerationError,
    );
    assert.equal(store.getRunnerLease("coordinator-revocation")?.ownerId, "replacement-owner");
    store.releaseRunnerLease(
      {
        sessionId: replacement.sessionId,
        generation: replacement.generation,
        leaseToken: replacement.leaseToken,
      },
      { executionState: "completed", workOutcome: "verified" },
    );
    await coordinator.shutdown();
  } finally {
    store.close();
  }
});
