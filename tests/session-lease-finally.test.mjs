import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreUrl = pathToFileURL(path.join(here, "..", "packages", "core", "dist", "index.js")).href;
const requireFromCore = createRequire(path.join(here, "..", "packages", "core", "package.json"));
const BetterSqlite3 = requireFromCore("better-sqlite3");

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function bounded(promise, label, ms = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function finalProvider() {
  let calls = 0;
  return {
    get calls() { return calls; },
    provider: {
      name: "lease-finally-provider",
      async *stream() {
        calls += 1;
        const text = `settled-${calls}`;
        yield {
          type: "message_done",
          message: {
            id: `lease-finally-${calls}`,
            role: "assistant",
            content: [{ type: "text", text }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    },
  };
}

test("process-local Session FIFO releases even when durable run settlement throws", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-local-lease-finally-"));
  const core = await import(`${coreUrl}?leaseFinally=${Date.now()}`);
  const store = new core.SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const fixed = finalProvider();
    const session = new core.Session({
      sessionId: "lease-finally",
      workspace,
      provider: fixed.provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    const realRelease = store.releaseRunnerLease.bind(store);
    let inject = true;
    store.releaseRunnerLease = (...args) => {
      const released = realRelease(...args);
      if (inject) {
        inject = false;
        throw new Error("injected post-release settlement failure");
      }
      return released;
    };

    await assert.rejects(
      collect(session.sendContent([{ type: "text", text: "first" }], { inputId: "lease-first" })),
      /injected post-release settlement failure/,
    );
    assert.equal(store.getInput("lease-first")?.state, "consumed", "the terminal input settled before the injected epilogue fault");

    const second = await bounded(
      collect(session.sendContent([{ type: "text", text: "second" }], { inputId: "lease-second" })),
      "second sender behind failed settlement",
    );
    assert.equal(second.find((event) => event.type === "turn_end")?.status, "completed");
    assert.equal(store.getInput("lease-second")?.state, "consumed");
    assert.equal(fixed.calls, 2);
  } finally {
    store.close();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a reconciliation throw after durable lease install releases authority and local FIFO", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-begin-lease-finally-"));
  const core = await import(`${coreUrl}?beginFinally=${Date.now()}`);
  const store = new core.SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const fixed = finalProvider();
    const session = new core.Session({
      sessionId: "begin-finally",
      workspace,
      provider: fixed.provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const realReconcile = session.reconcileUnknownToolEffects.bind(session);
    let inject = true;
    session.reconcileUnknownToolEffects = async (...args) => {
      if (inject) {
        inject = false;
        throw new Error("injected reconciliation failure");
      }
      return realReconcile(...args);
    };

    await assert.rejects(
      collect(session.sendContent([{ type: "text", text: "recover me" }], { inputId: "begin-owner" })),
      /injected reconciliation failure/,
    );
    assert.equal(store.getInput("begin-owner")?.state, "admitted");
    assert.equal(store.getRunnerLease("begin-finally"), null, "failed begin cannot retain durable runner authority");

    const resumed = await bounded(collect(session.resumeTurn()), "resume behind failed begin");
    assert.equal(resumed.find((event) => event.type === "turn_end")?.status, "completed");
    assert.equal(store.getInput("begin-owner")?.state, "consumed");
    assert.equal(fixed.calls, 1);
  } finally {
    store.close();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
