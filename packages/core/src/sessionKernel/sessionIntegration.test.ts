import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Message, StreamEvent, TurnEvent } from "@ares/protocol";
import { HookManager } from "../hooks.js";
import { QueryEngine, type EngineTool, type Provider, type ProviderRequest } from "../queryEngine.js";
import { projectMessagesFromKernel, Session } from "../session.js";
import { SessionKernelStore, type BetterSqlite3Constructor } from "./index.js";

const requireFromAgent = createRequire(new URL("../../../agent/package.json", import.meta.url));
const BetterSqlite3 = requireFromAgent("better-sqlite3") as BetterSqlite3Constructor;

function createKernel(): { db: InstanceType<BetterSqlite3Constructor>; store: SessionKernelStore } {
  const db = new BetterSqlite3(":memory:");
  return { db, store: new SessionKernelStore(db) };
}

async function collect(stream: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function assistant(id: string, text = "done"): Message {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
}

function finalProvider(id: string, onRequest?: (request: ProviderRequest) => void | Promise<void>): Provider {
  return {
    name: "fixed-final",
    async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
      await onRequest?.(request);
      yield {
        type: "message_done",
        message: assistant(id),
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

test("Session durably admits before provider work and retries one idempotent input exactly once", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-admission-"));
  const { db, store } = createKernel();
  try {
    // FULL (2) is required because admission/settlement commits fence real side effects.
    assert.equal(db.pragma("synchronous", { simple: true }), 2);
    let providerCalls = 0;
    const sessionId = "admission-session";
    const provider = finalProvider("wire-admission-reply", async () => {
      providerCalls += 1;
      const input = store.listInputs(sessionId)[0];
      assert.equal(input?.state, "claimed", "provider cannot start before the durable input is claimed");
      assert.ok(
        store.listEvents(sessionId).some((event) => event.type === "input.admitted"),
        "canonical admission must precede provider execution",
      );
      const rollout = await readFile(
        path.join(workspace, ".ares", "sessions", sessionId, "events.jsonl"),
        "utf8",
      );
      assert.match(rollout, /"type":"input_admitted"/, "portable admission must also cross its flush barrier");
    });
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const admissions: string[] = [];
    session.observeEvents((event) => {
      if (event.type === "input_admitted") admissions.push(event.inputId);
    });

    const firstEvents = await collect(
      session.sendContent([{ type: "text", text: "build it" }], { inputId: "owner-request-1" }),
    );
    assert.equal(firstEvents[0]?.type, "turn_start", "wire compatibility keeps admission on the observer/audit tap");
    assert.equal(firstEvents.at(-1)?.type, "turn_end");
    assert.deepEqual(admissions, ["owner-request-1"]);
    assert.equal(providerCalls, 1);
    assert.equal(store.listInputs(sessionId).length, 1);
    assert.equal(store.listInputs(sessionId)[0]?.state, "consumed");

    // A network/UI retry after completion acknowledges the same durable input
    // but never calls the provider or creates another logical message.
    const duplicateEvents = await collect(
      session.sendContent([{ type: "text", text: "build it" }], { inputId: "owner-request-1" }),
    );
    assert.deepEqual(duplicateEvents, []);
    assert.deepEqual(admissions, ["owner-request-1", "owner-request-1"]);
    assert.equal(providerCalls, 1);
    assert.equal(store.listMessages(sessionId).filter((message) => message.role === "user").length, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Session admits a concurrent input before FIFO wait and later streams it under exclusive execution", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-concurrent-admission-"));
  const { store } = createKernel();
  let releaseFirstProvider = (): void => {};
  let firstTurn: Promise<TurnEvent[]> | undefined;
  let secondTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalFirstProviderStarted!: () => void;
    const firstProviderStarted = new Promise<void>((resolve) => {
      signalFirstProviderStarted = resolve;
    });
    const firstProviderGate = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    let providerCalls = 0;
    let activeProviders = 0;
    let maxActiveProviders = 0;
    const provider: Provider = {
      name: "fifo-gated-final",
      async *stream(): AsyncGenerator<StreamEvent> {
        const call = ++providerCalls;
        activeProviders += 1;
        maxActiveProviders = Math.max(maxActiveProviders, activeProviders);
        try {
          if (call === 1) {
            signalFirstProviderStarted();
            await firstProviderGate;
          }
          yield {
            type: "message_done",
            message: assistant(`wire-concurrent-${call}`, `reply ${call}`),
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "end_turn",
          };
        } finally {
          activeProviders -= 1;
        }
      },
    };
    const sessionId = "concurrent-admission-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const admissions: string[] = [];
    session.observeEvents((event) => {
      if (event.type === "input_admitted") admissions.push(event.inputId);
    });

    firstTurn = collect(
      session.sendContent([{ type: "text", text: "first request" }], { inputId: "input-a" }),
    );
    await firstProviderStarted;
    secondTurn = collect(
      session.sendContent([{ type: "text", text: "second request" }], { inputId: "input-b" }),
    );

    const rolloutPath = path.join(workspace, ".ares", "sessions", sessionId, "events.jsonl");
    await waitFor(async () => {
      if (!admissions.includes("input-b") || store.getInput("input-b")?.state !== "admitted") return false;
      const rollout = await readFile(rolloutPath, "utf8");
      return rollout.includes('"type":"input_admitted"') && rollout.includes('"inputId":"input-b"');
    }, "input B did not cross SQLite, observer, and audit admission before waiting on input A");

    assert.deepEqual(admissions, ["input-a", "input-b"]);
    assert.equal(providerCalls, 1, "input B must not overlap input A's provider execution");
    assert.equal(maxActiveProviders, 1);
    assert.equal(store.getInput("input-a")?.state, "claimed");
    assert.equal(store.getInput("input-b")?.state, "admitted");

    releaseFirstProvider();
    const [firstEvents, secondEvents] = await Promise.all([firstTurn, secondTurn]);
    assert.equal(providerCalls, 2);
    assert.equal(maxActiveProviders, 1, "the provider/tool loop remains single-owner");
    assert.equal(store.getInput("input-a")?.state, "consumed");
    assert.equal(store.getInput("input-b")?.state, "consumed");

    const firstStarts = firstEvents.filter((event) => event.type === "turn_start");
    const secondStarts = secondEvents.filter((event) => event.type === "turn_start");
    assert.equal(firstStarts.length, 1);
    assert.equal(secondStarts.length, 1);
    assert.match(JSON.stringify(firstStarts[0]), /first request/);
    assert.match(JSON.stringify(secondStarts[0]), /second request/);
    assert.equal(firstEvents.at(-1)?.type, "turn_end");
    assert.equal(secondEvents.at(-1)?.type, "turn_end");
  } finally {
    releaseFirstProvider();
    await Promise.allSettled([firstTurn, secondTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)));
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("forced audit scheduling cannot make one sender stream another sender's input", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-caller-ownership-"));
  const { store } = createKernel();
  let releaseFirstAudit = (): void => {};
  let firstTurn: Promise<TurnEvent[]> | undefined;
  let secondTurn: Promise<TurnEvent[]> | undefined;
  try {
    const providerInputs: string[] = [];
    const provider = finalProvider("wire-owned", (request) => {
      const latestInput = [...request.messages]
        .reverse()
        .find((message) => message.role === "user" && message.content.some((block) => block.type === "text"));
      providerInputs.push(JSON.stringify(latestInput?.content ?? []));
    });
    const sessionId = "caller-ownership-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    // Force A to finish durable DB admission first but pause its portable audit
    // barrier. B crosses its later audit and reserves the local execution FIFO
    // first. A global-oldest claim would now make B steal A's stream.
    let signalFirstAuditReached!: () => void;
    let signalSecondAuditFlushed!: () => void;
    const firstAuditReached = new Promise<void>((resolve) => {
      signalFirstAuditReached = resolve;
    });
    const secondAuditFlushed = new Promise<void>((resolve) => {
      signalSecondAuditFlushed = resolve;
    });
    const firstAuditGate = new Promise<void>((resolve) => {
      releaseFirstAudit = resolve;
    });
    const internals = session as unknown as { flush: () => Promise<void> };
    const originalFlush = internals.flush.bind(session);
    let flushCalls = 0;
    internals.flush = async () => {
      flushCalls += 1;
      if (flushCalls === 1) {
        signalFirstAuditReached();
        await firstAuditGate;
      }
      await originalFlush();
      if (flushCalls === 2) signalSecondAuditFlushed();
    };

    firstTurn = collect(
      session.sendContent([{ type: "text", text: "caller A payload" }], { inputId: "z-caller-a" }),
    );
    await firstAuditReached;
    secondTurn = collect(
      session.sendContent([{ type: "text", text: "caller B payload" }], { inputId: "a-caller-b" }),
    );

    await secondAuditFlushed;
    assert.equal(store.getInput("z-caller-a")?.state, "admitted");
    assert.equal(store.getInput("a-caller-b")?.state, "admitted");
    assert.deepEqual(store.listInputs(sessionId).map((input) => input.admissionSequence), [1, 2]);
    assert.deepEqual(providerInputs, [], "B crossed its audit first but cannot overtake A's admission ticket");

    releaseFirstAudit();
    const [firstEvents, secondEvents] = await Promise.all([firstTurn, secondTurn]);
    assert.match(JSON.stringify(firstEvents.find((event) => event.type === "turn_start")), /caller A payload/);
    assert.doesNotMatch(JSON.stringify(firstEvents), /caller B payload/);
    assert.match(JSON.stringify(secondEvents.find((event) => event.type === "turn_start")), /caller B payload/);
    assert.doesNotMatch(JSON.stringify(secondEvents), /caller A payload/);
    assert.match(providerInputs[0] ?? "", /caller A payload/);
    assert.match(providerInputs[1] ?? "", /caller B payload/);
    assert.equal(store.getInput("z-caller-a")?.state, "consumed");
    assert.equal(store.getInput("a-caller-b")?.state, "consumed");
  } finally {
    releaseFirstAudit();
    await Promise.allSettled([firstTurn, secondTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)));
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an idle steering input behaves as the next queued turn", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-idle-steer-"));
  const { store } = createKernel();
  try {
    let requestSeen: ProviderRequest | undefined;
    const sessionId = "idle-steer-session";
    const session = new Session({
      sessionId,
      workspace,
      provider: finalProvider("wire-idle-steer", (request) => {
        requestSeen = request;
      }),
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    const events = await collect(
      session.sendContent(
        [{ type: "text", text: "use the smaller API" }],
        { inputId: "idle-steer", delivery: "steer" },
      ),
    );

    assert.equal(events[0]?.type, "turn_start");
    assert.equal(events.at(-1)?.type, "turn_end");
    assert.equal(store.getInput("idle-steer")?.state, "consumed");
    const visibleSteers = requestSeen?.messages.filter((message) => message.metadata?.source === "steer") ?? [];
    assert.equal(visibleSteers.length, 1);
    assert.match(JSON.stringify(visibleSteers[0]), /use the smaller API/);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("admission-only steering cannot release or settle the active owner's kernel run", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-admit-only-steer-"));
  const { store } = createKernel();
  let releaseProvider = (): void => {};
  let ownerTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { signalProviderStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let providerCalls = 0;
    const provider: Provider = {
      name: "admit-only-owner-fence",
      async *stream(): AsyncGenerator<StreamEvent> {
        providerCalls += 1;
        if (providerCalls === 1) {
          signalProviderStarted();
          // Deliberately ignore the steering abort so the owner fence remains
          // observably live while the admission-only sender returns.
          await providerGate;
        }
        yield {
          type: "message_done",
          message: assistant(`wire-admit-only-${providerCalls}`),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const sessionId = "admit-only-owner-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    ownerTurn = collect(session.sendContent(
      [{ type: "text", text: "owner request" }],
      { inputId: "admit-only-owner" },
    ));
    await providerStarted;

    const internals = session as unknown as {
      kernelFence: unknown;
      kernelLease: unknown;
      activeInputId: string | null;
    };
    const ownerFence = internals.kernelFence;
    const ownerLease = internals.kernelLease;
    assert.ok(ownerFence, "owner run fence must be active before steering admission");
    assert.ok(ownerLease, "owner run lease must be active before steering admission");
    assert.equal(store.getRun(sessionId, 1)?.executionState, "running");

    const steerEvents = await collect(session.sendContent(
      [{ type: "text", text: "admit this correction only" }],
      { inputId: "admit-only-steer", delivery: "steer", admitOnlySteer: true },
    ));
    assert.deepEqual(steerEvents, []);
    assert.ok(
      store.getInput("admit-only-steer")?.state === "admitted" ||
      store.getInput("admit-only-steer")?.state === "consumed",
      "the correction is durable and may already be consumed by the still-owning generation",
    );
    assert.strictEqual(internals.kernelFence, ownerFence, "steer sender cannot clear/replace the owner's fence");
    assert.strictEqual(internals.kernelLease, ownerLease, "steer sender cannot release the owner's lease");
    assert.equal(internals.activeInputId, "admit-only-owner");
    assert.equal(store.getRun(sessionId, 1)?.executionState, "running");
    assert.equal(store.getRun(sessionId, 2), null, "admission-only steering never creates a runner generation");

    releaseProvider();
    const ownerEvents = await ownerTurn;
    assert.equal(ownerEvents.at(-1)?.type, "turn_end");
    assert.equal(store.getInput("admit-only-steer")?.state, "consumed");
    assert.equal(providerCalls, 2, "the owner restarts once with the durable correction");
  } finally {
    releaseProvider();
    if (ownerTurn) await Promise.allSettled([ownerTurn]);
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("active provider steering preempts only the speculative attempt and continues in one generation", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-provider-steer-"));
  const { store } = createKernel();
  let ownerTurn: Promise<TurnEvent[]> | undefined;
  let steeringTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalFirstProviderStarted!: () => void;
    const firstProviderStarted = new Promise<void>((resolve) => {
      signalFirstProviderStarted = resolve;
    });
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    let steerAuditWasDurableBeforeAbort = false;
    let steerAuditAtAbort = "";
    let steerAuditReadSettled = false;
    let stopAfterSteerInstall: boolean | undefined;
    const sessionId = "provider-steer-session";
    const provider: Provider = {
      name: "steer-preemptible-provider",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({
          ...request,
          messages: request.messages.map((message) => ({
            ...message,
            content: message.content.map((block) => ({ ...block })),
          })),
        });
        const call = ++providerCalls;
        if (call === 1) {
          signalFirstProviderStarted();
          await new Promise<void>((_resolve, reject) => {
            const aborted = () => {
              void readFile(
                path.join(workspace, ".ares", "sessions", sessionId, "events.jsonl"),
                "utf8",
              ).then((audit) => {
                steerAuditAtAbort = audit;
                steerAuditWasDurableBeforeAbort = audit.includes("provider-steer");
              }).catch((error: unknown) => {
                steerAuditAtAbort = `READ FAILED: ${error instanceof Error ? error.message : String(error)}`;
              }).finally(() => {
                steerAuditReadSettled = true;
                const error = new Error("speculative provider attempt superseded by steering");
                error.name = "AbortError";
                reject(error);
              });
            };
            if (request.signal?.aborted) aborted();
            else request.signal?.addEventListener("abort", aborted, { once: true });
          });
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-after-provider-steer", "corrected response"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const originalConsumeInput = store.consumeInput.bind(store);
    store.consumeInput = ((fence, inputId) => {
      if (inputId === "provider-steer") {
        assert.equal(store.getInput(inputId)?.state, "claimed");
        assert.equal(
          session.history().filter((message) => message.metadata?.source === "steer").length,
          1,
          "steering history installation precedes acknowledgement",
        );
        stopAfterSteerInstall = session.interrupt(inputId);
      }
      return originalConsumeInput(fence, inputId);
    }) as SessionKernelStore["consumeInput"];

    ownerTurn = collect(
      session.sendContent(
        [{ type: "text", text: "continue the original implementation" }],
        { inputId: "provider-owner" },
      ),
    );
    await firstProviderStarted;
    steeringTurn = collect(
      session.sendContent(
        [{ type: "text", text: "correction: preserve the public API" }],
        { inputId: "provider-steer", delivery: "steer" },
      ),
    );

    const [ownerEvents, steerEvents] = await Promise.all([ownerTurn, steeringTurn]);
    await waitFor(() => steerAuditReadSettled, "the preempted provider did not observe its abort signal");
    assert.equal(
      steerAuditWasDurableBeforeAbort,
      true,
      `provider abort cannot race ahead of durable steer audit: ${steerAuditAtAbort.slice(-500)}`,
    );
    assert.equal(providerCalls, 2, "the obsolete attempt is replaced immediately");
    assert.equal(ownerEvents.filter((event) => event.type === "turn_start").length, 1);
    assert.equal(ownerEvents.filter((event) => event.type === "turn_end").length, 1);
    assert.equal(ownerEvents.find((event) => event.type === "turn_end")?.status, "completed");
    assert.deepEqual(steerEvents, [], "the correction is acknowledged by the active owner generation");
    assert.equal(
      stopAfterSteerInstall,
      false,
      "a steer cannot become cancelled after its canonical/model-history acceptance boundary",
    );
    assert.equal(store.getInput("provider-owner")?.state, "consumed");
    assert.equal(store.getInput("provider-steer")?.state, "consumed");
    assert.equal(store.getRun(sessionId, 1)?.executionState, "completed");
    assert.equal(store.getRun(sessionId, 2), null, "steering never creates a replacement generation");
    assert.equal(store.listMessages(sessionId).filter((message) => message.inputId === "provider-steer").length, 1);
    assert.equal(
      store.listEvents(sessionId).filter((event) => event.type === "provider.attempt_superseded").length,
      1,
      "the discarded provider attempt is canonical restart evidence",
    );

    const correctionMessages = requests[1]?.messages.filter(
      (message) => message.metadata?.source === "steer",
    ) ?? [];
    assert.equal(correctionMessages.length, 1);
    assert.match(JSON.stringify(correctionMessages[0]), /preserve the public API/);
  } finally {
    await Promise.allSettled(
      [ownerTurn, steeringTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)),
    );
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("steering detaches a non-cooperative provider and leaves no partial tool blocks in canonical history", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-stubborn-provider-steer-"));
  const { store } = createKernel();
  let ownerTurn: Promise<TurnEvent[]> | undefined;
  let steeringTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalFirstAttemptBlocked!: () => void;
    const firstAttemptBlocked = new Promise<void>((resolve) => {
      signalFirstAttemptBlocked = resolve;
    });
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: "signal-ignoring-provider",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({ ...request, messages: request.messages.map((message) => ({
          ...message,
          content: message.content.map((block) => ({ ...block })),
        })) });
        providerCalls += 1;
        if (providerCalls === 1) {
          yield { type: "text_delta", text: "obsolete partial" };
          yield { type: "tool_use_start", id: "orphan-draft", name: "NeverRun" };
          yield { type: "tool_use_input_delta", id: "orphan-draft", deltaJson: "{\"x\":" };
          signalFirstAttemptBlocked();
          // Intentionally ignore request.signal forever. guardStreamStalls must
          // race the steering signal directly rather than trust this adapter.
          await new Promise<void>(() => undefined);
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-after-stubborn-steer", "replacement response"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const sessionId = "stubborn-provider-steer-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    ownerTurn = collect(
      session.sendContent([{ type: "text", text: "start" }], { inputId: "stubborn-owner" }),
    );
    await firstAttemptBlocked;
    steeringTurn = collect(
      session.sendContent(
        [{ type: "text", text: "correction: abandon that draft" }],
        { inputId: "stubborn-steer", delivery: "steer" },
      ),
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("steering did not detach the non-cooperative provider")), 1_000);
    });
    const [ownerEvents, steerEvents] = await Promise.race([
      Promise.all([ownerTurn, steeringTurn]),
      timeout,
    ]);

    assert.equal(providerCalls, 2);
    assert.deepEqual(steerEvents, []);
    assert.ok(ownerEvents.some((event) => event.type === "text_delta" && /obsolete/.test(event.text)));
    assert.ok(ownerEvents.some((event) => event.type === "tool_use_start" && event.id === "orphan-draft"));
    assert.equal(ownerEvents.filter((event) => event.type === "provider_attempt_superseded").length, 1);
    assert.equal(
      store.listMessages(sessionId).some((message) => JSON.stringify(message).includes("orphan-draft")),
      false,
      "speculative tool drafts never enter canonical message history",
    );
    const correctionMessages = requests[1]?.messages.filter((message) => message.metadata?.source === "steer") ?? [];
    assert.equal(correctionMessages.length, 1);
    assert.equal(store.getRun(sessionId, 2), null);
  } finally {
    await Promise.allSettled(
      [ownerTurn, steeringTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)),
    );
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("steering at message commit skips proposed tools, pairs their results, and never executes effects", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-pre-effect-steer-"));
  const { store } = createKernel();
  let steeringTurn: Promise<TurnEvent[]> | undefined;
  try {
    let toolCalls = 0;
    const proposedTool: EngineTool = {
      schema: {
        name: "ProposedEffect",
        description: "A proposal that steering must suppress before entry",
        inputJsonSchema: { type: "object", additionalProperties: false },
        safety: "read-only",
        concurrency: "parallel-safe",
      },
      call: async () => {
        toolCalls += 1;
        return { output: "must not run" };
      },
    };
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: "pre-effect-steer-provider",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({
          ...request,
          messages: request.messages.map((message) => ({
            ...message,
            content: message.content.map((block) => ({ ...block })),
          })),
        });
        providerCalls += 1;
        if (providerCalls === 1) {
          yield { type: "tool_use_start", id: "proposed-1", name: "ProposedEffect" };
          yield { type: "tool_use_input_done", id: "proposed-1", input: {} };
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-proposed-effect", ""),
              content: [{ type: "tool_use", id: "proposed-1", name: "ProposedEffect", input: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-after-pre-effect-steer", "followed correction"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const sessionId = "pre-effect-steer-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [proposedTool],
      sessionKernel: store,
      contextBudgetTokens: 0,
      maxTurns: 1,
    });

    // Pull exactly through message_done. QueryEngine has committed the assistant
    // proposal, while its pre-effect window remains paused at the caller yield.
    const ownerStream = session.sendContent(
      [{ type: "text", text: "prepare the change" }],
      { inputId: "pre-effect-owner" },
    );
    const ownerEvents: TurnEvent[] = [];
    while (true) {
      const next = await ownerStream.next();
      assert.equal(next.done, false, "owner turn ended before its proposal boundary");
      ownerEvents.push(next.value);
      if (next.value.type === "message_done") break;
    }

    steeringTurn = collect(
      session.sendContent(
        [{ type: "text", text: "correction: do not execute that proposed call" }],
        { inputId: "pre-effect-steer", delivery: "steer" },
      ),
    );
    await waitFor(
      () => store.getInput("pre-effect-steer")?.state === "admitted",
      "pre-effect steer was not durably admitted",
    );
    for await (const event of ownerStream) ownerEvents.push(event);
    const steerEvents = await steeringTurn;

    assert.equal(toolCalls, 0, "a correction before tool_start prevents implementation entry");
    assert.equal(providerCalls, 2);
    assert.deepEqual(steerEvents, []);
    assert.equal(ownerEvents.filter((event) => event.type === "provider_attempt_superseded").length, 0);
    const effectsSkipped = ownerEvents.filter((event) => event.type === "provider_attempt_effects_skipped");
    assert.equal(effectsSkipped.length, 1);
    assert.deepEqual(effectsSkipped[0]?.toolUseIds, ["proposed-1"]);
    assert.ok(
      ownerEvents.some((event) => event.type === "tool_error" && /skipped because the user steered/.test(event.error)),
      "the committed tool_use receives an explicit paired skipped result",
    );

    const secondRequest = requests[1]?.messages ?? [];
    const proposedAssistant = secondRequest.findIndex((message) =>
      message.content.some((block) => block.type === "tool_use" && block.id === "proposed-1"),
    );
    const pairedResult = secondRequest.findIndex((message) =>
      message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "proposed-1"),
    );
    const correction = secondRequest.findIndex((message) => message.metadata?.source === "steer");
    assert.ok(proposedAssistant >= 0 && proposedAssistant < pairedResult, "tool proposal precedes its result");
    assert.ok(pairedResult < correction, "the skipped result is paired before correction injection");
    assert.match(JSON.stringify(secondRequest[pairedResult]), /skipped because the user steered/);
    assert.match(JSON.stringify(secondRequest[correction]), /do not execute/);
    assert.equal(store.getInput("pre-effect-steer")?.state, "consumed");
    assert.equal(store.getRun(sessionId, 2), null, "pre-effect steering stays in the owner generation");
    assert.ok(
      store.listMessages(sessionId).some((message) => JSON.stringify(message).includes("wire-proposed-effect")),
      "message_done remains canonical when only its effects are skipped",
    );
    assert.equal(
      store.listEvents(sessionId).filter((event) => event.type === "provider.attempt_effects_skipped").length,
      1,
    );
  } finally {
    if (steeringTurn) await Promise.allSettled([steeringTurn]);
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("steering fences queued worker calls and every later dependency batch", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-steer-batch-fence-"));
  const { store } = createKernel();
  const previousConcurrency = process.env.ARES_MAX_TOOL_CONCURRENCY;
  process.env.ARES_MAX_TOOL_CONCURRENCY = "1";
  let releaseHold = (): void => {};
  let ownerTurn: Promise<TurnEvent[]> | undefined;
  let steeringTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalHoldStarted!: () => void;
    const holdStarted = new Promise<void>((resolve) => {
      signalHoldStarted = resolve;
    });
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let holdCalls = 0;
    let readCalls = 0;
    let editCalls = 0;
    let holdSignal: AbortSignal | undefined;
    const tools: EngineTool[] = [
      {
        schema: {
          name: "Hold",
          description: "Keep the first worker occupied",
          inputJsonSchema: { type: "object", additionalProperties: false },
          safety: "read-only",
          concurrency: "parallel-safe",
        },
        call: async (_input, ctx) => {
          holdCalls += 1;
          holdSignal = ctx.signal;
          signalHoldStarted();
          await holdGate;
          return { output: "settled original call" };
        },
      },
      {
        schema: {
          name: "Read",
          description: "A queued same-batch read",
          inputJsonSchema: { type: "object", additionalProperties: true },
          safety: "read-only",
          concurrency: "parallel-safe",
        },
        call: async () => {
          readCalls += 1;
          return { output: "must not read" };
        },
      },
      {
        schema: {
          name: "Edit",
          description: "A later conflicting dependency batch",
          inputJsonSchema: { type: "object", additionalProperties: true },
          safety: "workspace-write",
          concurrency: "exclusive",
        },
        call: async () => {
          editCalls += 1;
          return { output: "must not edit" };
        },
      },
    ];
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: "queued-effect-steer-provider",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({
          ...request,
          messages: request.messages.map((message) => ({
            ...message,
            content: message.content.map((block) => ({ ...block })),
          })),
        });
        providerCalls += 1;
        if (providerCalls === 1) {
          const proposed = [
            { id: "running-hold", name: "Hold", input: {} },
            { id: "queued-read", name: "Read", input: { file_path: "target.txt" } },
            {
              id: "later-edit",
              name: "Edit",
              input: { file_path: "target.txt", old_string: "before", new_string: "after" },
            },
          ];
          for (const use of proposed) {
            yield { type: "tool_use_start", id: use.id, name: use.name };
            yield { type: "tool_use_input_done", id: use.id, input: use.input };
          }
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-queued-effects", ""),
              content: proposed.map((use) => ({ type: "tool_use" as const, ...use })),
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-after-queued-effect-steer", "correction applied"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const sessionId = "queued-effect-steer-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools,
      sessionKernel: store,
      contextBudgetTokens: 0,
      maxTurns: 1,
    });

    ownerTurn = collect(
      session.sendContent([{ type: "text", text: "inspect then edit target.txt" }], { inputId: "batch-owner" }),
    );
    await holdStarted;
    steeringTurn = collect(
      session.sendContent(
        [{ type: "text", text: "correction: leave target.txt unchanged" }],
        { inputId: "batch-steer", delivery: "steer" },
      ),
    );
    await waitFor(
      () => store.getInput("batch-steer")?.state === "admitted",
      "batch steer was not durably admitted while the first call was running",
    );
    assert.equal(holdSignal?.aborted, false, "the already-running call settles instead of being aborted");
    releaseHold();
    const [ownerEvents, steerEvents] = await Promise.all([ownerTurn, steeringTurn]);

    assert.deepEqual(steerEvents, []);
    assert.equal(providerCalls, 2);
    assert.equal(holdCalls, 1);
    assert.equal(readCalls, 0, "a worker dequeue after the steering epoch is fenced");
    assert.equal(editCalls, 0, "a later dependency batch inherits the same steering fence");
    assert.deepEqual(
      ownerEvents
        .filter((event) => event.type === "provider_attempt_effects_skipped")
        .flatMap((event) => event.toolUseIds),
      ["queued-read", "later-edit"],
      "the audit event preserves provider proposal order across batches",
    );
    assert.equal(
      ownerEvents.filter((event) => event.type === "tool_start").map((event) => event.id).join(","),
      "running-hold",
      "fenced calls never claim implementation entry",
    );
    const secondRequest = requests[1]?.messages ?? [];
    for (const toolUseId of ["running-hold", "queued-read", "later-edit"]) {
      assert.ok(
        secondRequest.some((message) =>
          message.content.some((block) => block.type === "tool_result" && block.tool_use_id === toolUseId)
        ),
        `${toolUseId} has a paired result before the correction response`,
      );
    }
    assert.match(JSON.stringify(secondRequest), /leave target\.txt unchanged/);
    assert.equal(store.getInput("batch-steer")?.state, "consumed");
    assert.equal(store.getRun(sessionId, 2), null, "replacement response remains in the owner generation");
  } finally {
    releaseHold();
    await Promise.allSettled(
      [ownerTurn, steeringTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)),
    );
    if (previousConcurrency === undefined) delete process.env.ARES_MAX_TOOL_CONCURRENCY;
    else process.env.ARES_MAX_TOOL_CONCURRENCY = previousConcurrency;
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("steering during a slow PreToolUse hook settles uncertainty and never enters the primary tool", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-steer-prehook-fence-"));
  const { store } = createKernel();
  let releaseHook = (): void => {};
  let ownerTurn: Promise<TurnEvent[]> | undefined;
  let steeringTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      signalHookStarted = resolve;
    });
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const hookManager = new HookManager([]);
    hookManager.run = async () => {
      signalHookStarted();
      await hookGate;
      return { blocked: false, reminders: [], executed: 1 };
    };

    let toolCalls = 0;
    const hookedTool: EngineTool = {
      schema: {
        name: "HookedEffect",
        description: "A primary effect behind a slow pre-tool hook",
        inputJsonSchema: { type: "object", additionalProperties: true },
        safety: "workspace-write",
        concurrency: "exclusive",
      },
      call: async () => {
        toolCalls += 1;
        return { output: "must not enter" };
      },
    };
    let providerCalls = 0;
    const provider: Provider = {
      name: "prehook-steer-provider",
      async *stream(): AsyncGenerator<StreamEvent> {
        providerCalls += 1;
        if (providerCalls === 1) {
          const input = { file_path: "hooked.txt" };
          yield { type: "tool_use_start", id: "hooked-1", name: "HookedEffect" };
          yield { type: "tool_use_input_done", id: "hooked-1", input };
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-hooked-effect", ""),
              content: [{ type: "tool_use", id: "hooked-1", name: "HookedEffect", input }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-after-prehook-steer", "correction applied after hook settlement"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const sessionId = "prehook-steer-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [hookedTool],
      hookManager,
      sessionKernel: store,
      contextBudgetTokens: 0,
      maxTurns: 1,
    });

    ownerTurn = collect(
      session.sendContent([{ type: "text", text: "run the hooked effect" }], { inputId: "prehook-owner" }),
    );
    await hookStarted;
    steeringTurn = collect(
      session.sendContent(
        [{ type: "text", text: "correction: do not run the primary effect" }],
        { inputId: "prehook-steer", delivery: "steer" },
      ),
    );
    await waitFor(
      () => store.getInput("prehook-steer")?.state === "admitted",
      "prehook steer was not admitted while host code was paused",
    );
    releaseHook();
    const [ownerEvents, steerEvents] = await Promise.all([ownerTurn, steeringTurn]);

    assert.deepEqual(steerEvents, []);
    assert.equal(providerCalls, 2);
    assert.equal(toolCalls, 0, "the primary implementation is fenced after the awaited hook");
    assert.equal(
      ownerEvents.some((event) => event.type === "tool_start" && event.id === "hooked-1"),
      false,
      "tool_start is implementation-entry authority and must not be emitted",
    );
    const skipped = ownerEvents.find((event) => event.type === "provider_attempt_effects_skipped");
    assert.deepEqual(skipped?.toolUseIds, ["hooked-1"]);
    const hookError = ownerEvents.find(
      (event): event is Extract<TurnEvent, { type: "tool_error" }> =>
        event.type === "tool_error" && event.id === "hooked-1",
    );
    assert.match(hookError?.error ?? "", /primary tool implementation did not run/i);
    assert.match(hookError?.error ?? "", /hook's effect status is unknown/i);
    assert.equal(store.listToolRuns(sessionId)[0]?.executionState, "effect_unknown");
    assert.equal(store.getInput("prehook-steer")?.state, "consumed");
  } finally {
    releaseHook();
    await Promise.allSettled(
      [ownerTurn, steeringTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)),
    );
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("steering wakes a pending permission prompt and skips the unapproved effect without interrupting the turn", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-steer-permission-wake-"));
  const { store } = createKernel();
  let resolvePermission = (_decision: "deny" | "allow_once"): void => {};
  let ownerTurn: Promise<TurnEvent[]> | undefined;
  let steeringTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalPermissionRequested!: () => void;
    const permissionRequested = new Promise<void>((resolve) => {
      signalPermissionRequested = resolve;
    });
    const ownerDecision = new Promise<"deny" | "allow_once">((resolve) => {
      resolvePermission = resolve;
    });
    let adapterEntries = 0;
    let effects = 0;
    let hostPermissionSignal: AbortSignal | undefined;
    const permissionTool: EngineTool = {
      schema: {
        name: "PermissionEffect",
        description: "Wait for owner authority before changing external state",
        inputJsonSchema: { type: "object", additionalProperties: false },
        safety: "external-state",
        concurrency: "exclusive",
      },
      call: async (_input, context) => {
        adapterEntries += 1;
        const decision = await context.requestPermission?.({
          toolName: "PermissionEffect",
          input: {},
          reason: "test pending authority",
          suggestion: "allow_once",
        });
        if (decision !== "allow_once") {
          const error = new Error("owner denied permission");
          error.name = "PermissionDeniedError";
          throw error;
        }
        effects += 1;
        return { output: "effect entered" };
      },
    };
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: "permission-steer-provider",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({
          ...request,
          messages: request.messages.map((message) => ({
            ...message,
            content: message.content.map((block) => ({ ...block })),
          })),
        });
        providerCalls += 1;
        if (providerCalls === 1) {
          yield { type: "tool_use_start", id: "permission-1", name: "PermissionEffect" };
          yield { type: "tool_use_input_done", id: "permission-1", input: {} };
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-permission-effect", ""),
              content: [{ type: "tool_use", id: "permission-1", name: "PermissionEffect", input: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-after-permission-steer", "continued from the correction"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const sessionId = "permission-steer-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [permissionTool],
      sessionKernel: store,
      requestPermission: async (request) => {
        assert.equal(request.toolName, "PermissionEffect");
        hostPermissionSignal = request.signal;
        signalPermissionRequested();
        return await new Promise<"deny" | "allow_once">((resolve, reject) => {
          let settled = false;
          const finish = (decision: "deny" | "allow_once") => {
            if (settled) return;
            settled = true;
            request.signal?.removeEventListener("abort", onAbort);
            resolve(decision);
          };
          const onAbort = () => {
            if (settled) return;
            settled = true;
            const error = new Error("host permission waiter aborted");
            error.name = "AbortError";
            reject(error);
          };
          request.signal?.addEventListener("abort", onAbort, { once: true });
          if (request.signal?.aborted) onAbort();
          else void ownerDecision.then(finish, reject);
        });
      },
      permissionDenialInterrupts: true,
      contextBudgetTokens: 0,
      maxTurns: 1,
    });

    ownerTurn = collect(
      session.sendContent([{ type: "text", text: "attempt the permission effect" }], { inputId: "permission-owner" }),
    );
    await permissionRequested;
    steeringTurn = collect(
      session.sendContent(
        [{ type: "text", text: "correction: do not request or perform that effect" }],
        { inputId: "permission-steer", delivery: "steer" },
      ),
    );
    await waitFor(
      () => store.getInput("permission-steer") !== null,
      "permission steer was not durably recorded",
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("steering did not wake the pending permission prompt")), 1_000);
      timer.unref?.();
    });
    const [ownerEvents, steerEvents] = await Promise.race([
      Promise.all([ownerTurn, steeringTurn]),
      timeout,
    ]);

    assert.deepEqual(steerEvents, []);
    assert.equal(providerCalls, 2);
    assert.equal(adapterEntries, 1, "the adapter entered only to request authority");
    assert.equal(effects, 0, "no owner-approved effect began");
    assert.equal(hostPermissionSignal?.aborted, true, "steering cancels the host-side approval waiter");
    assert.ok(
      ownerEvents.some((event) => event.type === "permission_response" && event.decision === "deny"),
      "the pending surface prompt receives a synthetic deny settlement",
    );
    assert.deepEqual(
      ownerEvents.find((event) => event.type === "provider_attempt_effects_skipped")?.toolUseIds,
      ["permission-1"],
    );
    assert.equal(
      ownerEvents.find((event) => event.type === "turn_end")?.status,
      "completed",
      "a steering wake is not misclassified as a user permission denial interrupt",
    );
    assert.equal(store.listToolRuns(sessionId)[0]?.executionState, "failed");
    assert.equal(store.getInput("permission-steer")?.state, "consumed");
    assert.match(JSON.stringify(requests[1]?.messages), /do not request or perform/);
  } finally {
    resolvePermission("deny");
    await Promise.allSettled(
      [ownerTurn, steeringTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)),
    );
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("permission denial terminally cancels its owner so the immediate next input can run", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-permission-deny-terminal-"));
  const { store } = createKernel();
  try {
    const sessionId = "permission-deny-terminal-session";
    let providerCalls = 0;
    let effectCalls = 0;
    const provider: Provider = {
      name: "permission-deny-then-final",
      async *stream(): AsyncGenerator<StreamEvent> {
        providerCalls += 1;
        if (providerCalls === 1) {
          yield { type: "tool_use_start", id: "denied-effect-1", name: "PermissionEffect" };
          yield { type: "tool_use_input_done", id: "denied-effect-1", input: {} };
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-denied-effect", ""),
              content: [{ type: "tool_use", id: "denied-effect-1", name: "PermissionEffect", input: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-after-denial", "the next message ran"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const permissionTool: EngineTool = {
      schema: {
        name: "PermissionEffect",
        description: "Require explicit owner approval",
        inputJsonSchema: { type: "object", additionalProperties: false },
        safety: "external-state",
        concurrency: "exclusive",
      },
      call: async (_input, context) => {
        const decision = await context.requestPermission?.({
          toolName: "PermissionEffect",
          input: {},
          reason: "test denial terminal settlement",
          suggestion: "allow_once",
        });
        if (decision !== "allow_once") {
          const error = new Error("owner denied permission");
          error.name = "PermissionDeniedError";
          throw error;
        }
        effectCalls += 1;
        return { output: "effect entered" };
      },
    };
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [permissionTool],
      sessionKernel: store,
      requestPermission: async () => "deny",
      permissionDenialInterrupts: true,
      contextBudgetTokens: 0,
    });

    const denied = await collect(
      session.sendContent(
        [{ type: "text", text: "attempt the denied effect" }],
        { inputId: "permission-denied-owner" },
      ),
    );
    const deniedEnd = [...denied].reverse().find(
      (event): event is Extract<TurnEvent, { type: "turn_end" }> => event.type === "turn_end",
    );
    assert.equal(deniedEnd?.status, "interrupted");
    assert.ok(
      denied.some((event) => event.type === "permission_response" && event.decision === "deny"),
      "the denial remains visible on the event stream",
    );
    assert.equal(effectCalls, 0);
    assert.equal(
      store.getInput("permission-denied-owner")?.state,
      "cancelled",
      "an explicit interrupted boundary is terminal and cannot be requeued by lease release",
    );
    const ownerEvents = store.listEvents(sessionId).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.inputId === "permission-denied-owner";
    });
    assert.equal(ownerEvents.filter((event) => event.type === "input.cancelled").length, 1);
    const cancellation = ownerEvents.find((event) => event.type === "input.cancelled");
    assert.equal(
      ((cancellation?.payload as Record<string, unknown>)?.reason as Record<string, unknown>)?.code,
      "TURN_INTERRUPTED",
    );
    assert.equal(store.listEvents(sessionId).some((event) => event.type === "input.requeued"), false);
    assert.equal(store.getRun(sessionId, 1)?.executionState, "interrupted");

    const immediateNext = collect(
      session.sendContent(
        [{ type: "text", text: "run immediately after denial" }],
        { inputId: "after-permission-denial" },
      ),
    );
    const next = await Promise.race([
      immediateNext,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the next input remained blocked behind the denied owner")),
          2_000,
        );
        timer.unref?.();
      }),
    ]);
    const nextEnd = [...next].reverse().find(
      (event): event is Extract<TurnEvent, { type: "turn_end" }> => event.type === "turn_end",
    );
    assert.equal(nextEnd?.status, "completed");
    assert.equal(store.getInput("after-permission-denial")?.state, "consumed");
    assert.equal(store.getRun(sessionId, 2)?.executionState, "completed");
    assert.equal(providerCalls, 2);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("active steering waits for a settled tool boundary and is injected exactly once", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-active-steer-"));
  const { store } = createKernel();
  let releaseTool = (): void => {};
  let ownerTurn: Promise<TurnEvent[]> | undefined;
  let firstSteerSend: Promise<TurnEvent[]> | undefined;
  let duplicateSteerSend: Promise<TurnEvent[]> | undefined;
  try {
    let signalToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let toolActive = false;
    let toolCalls = 0;
    let toolSignal: AbortSignal | undefined;
    const holdTool: EngineTool = {
      schema: {
        name: "Hold",
        description: "Hold one tool round open",
        inputJsonSchema: { type: "object", additionalProperties: false },
        safety: "read-only",
        concurrency: "parallel-safe",
      },
      call: async (_input, ctx) => {
        toolCalls += 1;
        toolActive = true;
        toolSignal = ctx.signal;
        signalToolStarted();
        try {
          await toolGate;
          return { output: "held" };
        } finally {
          toolActive = false;
        }
      },
    };
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const sessionId = "active-steer-session";
    const provider: Provider = {
      name: "tool-then-final",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({ ...request, messages: request.messages.map((message) => ({
          ...message,
          content: message.content.map((block) => ({ ...block })),
        })) });
        providerCalls += 1;
        if (providerCalls === 1) {
          yield { type: "tool_use_start", id: "hold-1", name: "Hold" };
          yield { type: "tool_use_input_done", id: "hold-1", input: {} };
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-hold-request", ""),
              content: [{ type: "tool_use", id: "hold-1", name: "Hold", input: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        assert.equal(toolActive, false, "the next provider round cannot overlap the active tool");
        assert.equal(store.getInput("steer-once")?.state, "consumed", "steer is acknowledged before provider reuse");
        yield {
          type: "message_done",
          message: assistant("wire-after-steer"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [holdTool],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    ownerTurn = collect(
      session.sendContent([{ type: "text", text: "start the original work" }], { inputId: "steer-owner" }),
    );
    await toolStarted;
    firstSteerSend = collect(
      session.sendContent(
        [{ type: "text", text: "correction: keep the public API unchanged" }],
        { inputId: "steer-once", delivery: "steer" },
      ),
    );
    duplicateSteerSend = collect(
      session.sendContent(
        [{ type: "text", text: "correction: keep the public API unchanged" }],
        { inputId: "steer-once", delivery: "steer" },
      ),
    );

    await waitFor(
      () => store.getInput("steer-once")?.state === "admitted",
      "steering input was not durably admitted while the tool was active",
    );
    assert.equal(toolActive, true);
    assert.equal(toolSignal?.aborted, false, "steering cannot abort a tool effect before settlement");
    assert.equal(providerCalls, 1);
    assert.equal(store.listMessages(sessionId).some((message) => message.inputId === "steer-once"), false);

    releaseTool();
    const [ownerEvents, firstSteerEvents, duplicateSteerEvents] = await Promise.all([
      ownerTurn,
      firstSteerSend,
      duplicateSteerSend,
    ]);

    assert.equal(providerCalls, 2);
    assert.equal(toolCalls, 1);
    assert.equal(ownerEvents.at(-1)?.type, "turn_end");
    assert.deepEqual(firstSteerEvents, []);
    assert.deepEqual(duplicateSteerEvents, []);
    assert.equal(store.getInput("steer-once")?.state, "consumed");
    assert.equal(store.listInputs(sessionId).filter((input) => input.id === "steer-once").length, 1);
    assert.equal(store.listMessages(sessionId).filter((message) => message.inputId === "steer-once").length, 1);

    const secondMessages = requests[1]?.messages ?? [];
    const toolResultIndex = secondMessages.findIndex((message) =>
      message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "hold-1"),
    );
    const steerIndexes = secondMessages
      .map((message, index) => message.metadata?.source === "steer" ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(steerIndexes.length, 1, "the provider sees one logical correction despite a concurrent retry");
    assert.ok(toolResultIndex >= 0 && toolResultIndex < steerIndexes[0]!, "steer is injected after the settled tool result");
    assert.match(JSON.stringify(secondMessages[steerIndexes[0]!]), /keep the public API unchanged/);

    const steerEvents = store.listEvents(sessionId).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.inputId === "steer-once";
    });
    assert.equal(steerEvents.filter((event) => event.type === "input.claimed").length, 1);
    assert.equal(steerEvents.filter((event) => event.type === "input.consumed").length, 1);
    assert.equal(steerEvents.find((event) => event.type === "input.consumed")?.generation, 1);
    assert.equal(store.getRun(sessionId, 2), null, "steer retries do not create a second runner generation");

    const replay = await collect(
      session.sendContent(
        [{ type: "text", text: "correction: keep the public API unchanged" }],
        { inputId: "steer-once", delivery: "steer" },
      ),
    );
    assert.deepEqual(replay, []);
    assert.equal(providerCalls, 2);
  } finally {
    releaseTool();
    await Promise.allSettled(
      [ownerTurn, firstSteerSend, duplicateSteerSend].filter(
        (turn): turn is Promise<TurnEvent[]> => Boolean(turn),
      ),
    );
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("steering acknowledgement failure requeues and replays one stable correction", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-steer-fault-"));
  const { store } = createKernel();
  let releaseFirstProvider = (): void => {};
  let ownerTurn: Promise<{ ok: true; events: TurnEvent[] } | { ok: false; error: unknown }> | undefined;
  let steeringTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalFirstProviderStarted!: () => void;
    const firstProviderStarted = new Promise<void>((resolve) => {
      signalFirstProviderStarted = resolve;
    });
    const firstProviderGate = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: "steer-fault-recovery",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({ ...request, messages: request.messages.map((message) => ({
          ...message,
          content: message.content.map((block) => ({ ...block })),
        })) });
        providerCalls += 1;
        if (providerCalls === 1) {
          signalFirstProviderStarted();
          await firstProviderGate;
        }
        yield {
          type: "message_done",
          message: assistant(`wire-steer-fault-${providerCalls}`),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const sessionId = "steer-fault-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    const originalConsumeInput = store.consumeInput.bind(store);
    let failFirstSteeringAck = true;
    store.consumeInput = ((fence, inputId) => {
      if (inputId === "fault-steer" && failFirstSteeringAck) {
        failFirstSteeringAck = false;
        throw new Error("injected steering acknowledgement fault");
      }
      return originalConsumeInput(fence, inputId);
    }) as SessionKernelStore["consumeInput"];

    ownerTurn = collect(
      session.sendContent([{ type: "text", text: "original request" }], { inputId: "fault-owner" }),
    ).then(
      (events) => ({ ok: true as const, events }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await firstProviderStarted;
    steeringTurn = collect(
      session.sendContent(
        [{ type: "text", text: "fault-safe correction" }],
        { inputId: "fault-steer", delivery: "steer" },
      ),
    );
    await waitFor(
      () => store.listEvents(sessionId).some((event) => {
        const payload = event.payload as Record<string, unknown>;
        return event.type === "input.claimed" && payload.inputId === "fault-steer";
      }),
      "fault steering input was not claimed by the preempted owner generation",
    );

    releaseFirstProvider();
    const failedOwner = await ownerTurn;
    assert.equal(failedOwner.ok, false);
    if (failedOwner.ok) assert.fail("owner turn unexpectedly survived the injected acknowledgement fault");
    assert.match(String(failedOwner.error), /injected steering acknowledgement fault/);

    const recoveryEvents = await steeringTurn;
    assert.equal(recoveryEvents.at(-1)?.type, "turn_end");
    assert.equal(providerCalls, 2);
    assert.equal(
      store.getInput("fault-owner")?.state,
      "admitted",
      "the failed owner's input remains recoverable; the steering sender must not steal it",
    );
    assert.equal(store.getInput("fault-steer")?.state, "consumed");
    assert.equal(store.getRun(sessionId, 1)?.executionState, "failed");
    assert.equal(store.getRun(sessionId, 2)?.executionState, "completed");
    assert.equal(store.listMessages(sessionId).filter((message) => message.inputId === "fault-steer").length, 1);
    assert.equal(session.history().filter((message) => message.metadata?.source === "steer").length, 1);

    const recoveredSteers = requests[1]?.messages.filter((message) => message.metadata?.source === "steer") ?? [];
    assert.equal(recoveredSteers.length, 1);
    assert.match(JSON.stringify(recoveredSteers[0]), /fault-safe correction/);
    const steerEvents = store.listEvents(sessionId).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.inputId === "fault-steer";
    });
    assert.equal(steerEvents.filter((event) => event.type === "input.claimed").length, 2);
    assert.equal(steerEvents.filter((event) => event.type === "input.consumed").length, 1);
    assert.equal(steerEvents.find((event) => event.type === "input.consumed")?.generation, 2);
  } finally {
    releaseFirstProvider();
    const pendingTurns: Promise<unknown>[] = [];
    if (ownerTurn) pendingTurns.push(ownerTurn);
    if (steeringTurn) pendingTurns.push(steeringTurn);
    await Promise.allSettled(pendingTurns);
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("failed provider generation releases and requeues its claim for resume", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-requeue-"));
  const { store } = createKernel();
  try {
    let calls = 0;
    const provider: Provider = {
      name: "fail-then-recover",
      async *stream(): AsyncGenerator<StreamEvent> {
        calls += 1;
        if (calls === 1) throw new Error("simulated provider process loss");
        yield {
          type: "message_done",
          message: assistant("wire-recovered"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const session = new Session({
      sessionId: "requeue-session",
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    const failed = await collect(
      session.sendContent([{ type: "text", text: "survive this" }], { inputId: "recoverable-input" }),
    );
    const failedEnd = [...failed].reverse().find(
      (event): event is Extract<TurnEvent, { type: "turn_end" }> => event.type === "turn_end",
    );
    assert.equal(failedEnd?.status, "failed");
    assert.equal(store.listInputs("requeue-session")[0]?.state, "admitted");
    assert.equal(store.requireSession("requeue-session").executionState, "admitted");
    assert.equal(store.getRun("requeue-session", 1)?.executionState, "failed");
    assert.ok(store.listEvents("requeue-session").some((event) => event.type === "input.requeued"));

    const resumed = await collect(session.resumeTurn());
    const resumedEnd = [...resumed].reverse().find(
      (event): event is Extract<TurnEvent, { type: "turn_end" }> => event.type === "turn_end",
    );
    assert.equal(resumedEnd?.status, "completed");
    assert.equal(calls, 2);
    assert.equal(store.listInputs("requeue-session")[0]?.state, "consumed");
    assert.equal(store.listMessages("requeue-session").filter((message) => message.role === "user").length, 1);
    assert.equal(store.getRun("requeue-session", 2)?.executionState, "completed");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Stop before admission is input-bound, idempotent, and cannot poison the next turn", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-pre-admission-cancel-"));
  const { store } = createKernel();
  try {
    let providerCalls = 0;
    const session = new Session({
      sessionId: "pre-admission-cancel",
      workspace,
      provider: finalProvider("wire-after-idle-stop", () => {
        providerCalls += 1;
      }),
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    assert.equal(session.interrupt(), false, "idle Stop has no target");
    assert.equal(session.interrupt("future-request"), true, "routing-stage Stop binds to the future input id");
    assert.equal(session.interrupt("future-request"), false, "duplicate Stop is a no-op");
    const cancelledEvents = await collect(
      session.sendContent([{ type: "text", text: "never run this" }], { inputId: "future-request" }),
    );
    const cancelledEnd = cancelledEvents.find(
      (event): event is Extract<TurnEvent, { type: "turn_end" }> => event.type === "turn_end",
    );
    assert.equal(cancelledEnd?.status, "interrupted");
    assert.equal(providerCalls, 0);
    assert.equal(store.getInput("future-request")?.state, "cancelled");
    assert.equal(store.requireSession("pre-admission-cancel").executionState, "idle");
    assert.equal(session.interrupt(), false, "settled cancellation leaves the session idle");

    const nextEvents = await collect(
      session.sendContent([{ type: "text", text: "run the next request" }], { inputId: "next-request" }),
    );
    assert.equal(
      nextEvents.find((event) => event.type === "turn_end")?.status,
      "completed",
      "the next input receives a fresh, unpoisoned abort controller",
    );
    assert.equal(providerCalls, 1);
    assert.equal(store.getInput("next-request")?.state, "consumed");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("active Stop cancels the owning generation and restart never replays it", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-active-cancel-"));
  const { store } = createKernel();
  let releaseProvider = (): void => {};
  try {
    let providerCalls = 0;
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    const provider: Provider = {
      name: "abort-aware",
      async *stream(request): AsyncGenerator<StreamEvent> {
        providerCalls += 1;
        if (providerCalls === 1) {
          signalProviderStarted();
          await new Promise<void>((resolve, reject) => {
            releaseProvider = resolve;
            const aborted = () => {
              const error = new Error("provider aborted by Stop");
              error.name = "AbortError";
              reject(error);
            };
            if (request.signal?.aborted) aborted();
            else request.signal?.addEventListener("abort", aborted, { once: true });
          });
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-after-cancel-restart"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const options = {
      sessionId: "active-cancel",
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    } as const;
    const session = new Session(options);
    const activeTurn = collect(
      session.sendContent([{ type: "text", text: "stop while running" }], { inputId: "active-request" }),
    );
    await providerStarted;
    assert.equal(store.getInput("active-request")?.state, "claimed");
    assert.equal(session.interrupt("active-request"), true);
    assert.equal(session.interrupt("active-request"), false, "double Stop cannot target terminal input state");

    const interruptedEvents = await activeTurn;
    assert.equal(
      interruptedEvents.find((event) => event.type === "turn_end")?.status,
      "interrupted",
    );
    assert.equal(store.getInput("active-request")?.state, "cancelled");
    assert.equal(
      store.listEvents("active-cancel").filter((event) => event.type === "input.requeued").length,
      0,
      "lease release must not resurrect a cancelled claim",
    );

    const restarted = new Session(options);
    await restarted.waitForStartupRecovery();
    assert.equal(providerCalls, 1, "startup recovery ignores terminal cancelled inputs");
    const nextEvents = await collect(
      restarted.sendContent([{ type: "text", text: "fresh work" }], { inputId: "fresh-request" }),
    );
    assert.equal(nextEvents.find((event) => event.type === "turn_end")?.status, "completed");
    assert.equal(providerCalls, 2);
    assert.equal(store.getInput("fresh-request")?.state, "consumed");
  } finally {
    releaseProvider();
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical steering routes before audit flush and cannot be independently cancelled", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-cancel-steer-"));
  const { store } = createKernel();
  let releaseProvider = (): void => {};
  let releaseSteerAudit = (): void => {};
  try {
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    let providerCalls = 0;
    const provider: Provider = {
      name: "queued-steer-cancel",
      async *stream(request): AsyncGenerator<StreamEvent> {
        providerCalls += 1;
        signalProviderStarted();
        await new Promise<void>((resolve, reject) => {
          releaseProvider = resolve;
          const aborted = () => {
            const error = new Error("stopped with queued steer");
            error.name = "AbortError";
            reject(error);
          };
          if (request.signal?.aborted) aborted();
          else request.signal?.addEventListener("abort", aborted, { once: true });
        });
      },
    };
    const sessionId = "cancel-queued-steer";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const ownerTurn = collect(
      session.sendContent([{ type: "text", text: "owner work" }], { inputId: "steer-owner" }),
    );
    await providerStarted;

    // Pause the portable audit acknowledgement. Canonical SQLite admission now
    // wakes the owner synchronously before this await, so no stale provider/tool
    // work can start merely because JSONL is slow.
    let signalSteerAuditFlushed!: () => void;
    const steerAuditFlushed = new Promise<void>((resolve) => {
      signalSteerAuditFlushed = resolve;
    });
    const steerAuditGate = new Promise<void>((resolve) => {
      releaseSteerAudit = resolve;
    });
    const internals = session as unknown as { flush: () => Promise<void> };
    const originalFlush = internals.flush.bind(session);
    internals.flush = async () => {
      await originalFlush();
      signalSteerAuditFlushed();
      await steerAuditGate;
    };
    const steerTurn = collect(
      session.sendContent(
        [{ type: "text", text: "correction that belongs to this turn" }],
        { inputId: "queued-correction", delivery: "steer" },
      ),
    );
    await steerAuditFlushed;
    await waitFor(
      () => store.getInput("queued-correction")?.state === "consumed" && providerCalls === 2,
      "the owner did not apply canonical steering while the audit acknowledgement was paused",
    );

    assert.equal(session.interrupt("steer-owner"), true);
    assert.equal(
      session.interrupt("queued-correction"),
      false,
      "history accepted by the owner generation cannot be retracted independently",
    );
    releaseSteerAudit();
    const [ownerEvents, steerEvents] = await Promise.all([ownerTurn, steerTurn]);
    assert.equal(ownerEvents.find((event) => event.type === "turn_end")?.status, "interrupted");
    assert.deepEqual(steerEvents, []);
    assert.equal(store.getInput("steer-owner")?.state, "cancelled");
    assert.equal(store.getInput("queued-correction")?.state, "consumed");
    assert.equal(providerCalls, 2, "the corrected provider attempt starts before audit acknowledgement");
    assert.equal(store.listInputs(sessionId, "admitted").length, 0);
    assert.equal(
      store.listEvents(sessionId).filter((event) => event.type === "input.requeued").length,
      0,
    );
  } finally {
    releaseProvider();
    releaseSteerAudit();
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("startup coordinator drains an orphan admitted before claim and publishes one durable detached result", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-orphan-before-claim-"));
  const { store } = createKernel();
  try {
    const sessionId = "orphan-before-claim";
    store.createSession({ id: sessionId, workspaceKey: workspace });
    store.admitInput({
      id: "orphan-input",
      sessionId,
      idempotencyKey: "orphan-input",
      delivery: "queue",
      payload: { content: [{ type: "text", text: "recover without a caller" }] },
    });
    let providerCalls = 0;
    const session = new Session({
      sessionId,
      workspace,
      provider: finalProvider("wire-orphan-recovered", () => {
        providerCalls += 1;
      }),
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    await session.waitForStartupRecovery();
    assert.equal(providerCalls, 1, "construction alone wakes recovery; resumeTurn is not required");
    assert.equal(store.getInput("orphan-input")?.state, "consumed");
    const result = store.getDetachedInputResult("orphan-input");
    assert.equal(result?.executionState, "completed");
    assert.ok(result?.outputMessageId);
    assert.ok(store.getMessage(result!.outputMessageId!));
    assert.equal(store.listDetachedInputResults(sessionId).length, 1);

    const transportRetry = await collect(
      session.sendContent(
        [{ type: "text", text: "recover without a caller" }],
        { inputId: "orphan-input" },
      ),
    );
    assert.deepEqual(transportRetry, []);
    assert.equal(providerCalls, 1, "a detached result is an acknowledgement, never replay authority");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("startup coordinator takes over an expired claimed input without duplicating its logical request", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-orphan-after-claim-"));
  let now = 25_000;
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"), { now: () => now });
  try {
    const sessionId = "orphan-after-claim";
    store.createSession({ id: sessionId, workspaceKey: workspace });
    store.admitInput({
      id: "claimed-orphan",
      sessionId,
      idempotencyKey: "claimed-orphan",
      delivery: "queue",
      payload: { content: [{ type: "text", text: "claimed before the crash" }] },
    });
    const crashed = store.acquireRunnerLease(sessionId, "crashed-host", 250);
    store.claimInput(
      { sessionId, generation: crashed.generation, leaseToken: crashed.leaseToken },
      "claimed-orphan",
    );

    let providerCalls = 0;
    const session = new Session({
      sessionId,
      workspace,
      provider: finalProvider("wire-claimed-orphan", () => {
        providerCalls += 1;
      }),
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      sessionLeaseTtlMs: 250,
      sessionLeaseHeartbeatMs: 50,
      contextBudgetTokens: 0,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(providerCalls, 0, "a healthy prior lease is never stolen");
    now += 251;
    await session.waitForStartupRecovery();

    assert.equal(providerCalls, 1);
    assert.equal(store.getRun(sessionId, 1)?.executionState, "interrupted");
    assert.equal(store.getRun(sessionId, 2)?.executionState, "completed");
    assert.equal(store.getInput("claimed-orphan")?.state, "consumed");
    assert.equal(store.getDetachedInputResult("claimed-orphan")?.generation, 2);
    const inputEvents = store.listEvents(sessionId).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.inputId === "claimed-orphan";
    });
    assert.equal(inputEvents.filter((event) => event.type === "input.claimed").length, 2);
    assert.equal(inputEvents.filter((event) => event.type === "input.consumed").length, 1);
    assert.equal(inputEvents.filter((event) => event.type === "input.detached_result").length, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("host-managed startup recovery reunites a queue owner, assistant tail, and later steer in one provider generation", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-host-recovery-owner-steer-"));
  let now = 40_000;
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"), { now: () => now });
  try {
    const sessionId = "host-recovery-owner-steer";
    const ownerInputId = "recovered-owner";
    const steerInputId = "recovered-owner-steer";
    const ownerText = "finish the renderer repair";
    const steerText = "correction: keep the original camera transform";
    store.createSession({ id: sessionId, workspaceKey: workspace });
    store.admitInput({
      id: ownerInputId,
      sessionId,
      idempotencyKey: ownerInputId,
      delivery: "queue",
      payload: { content: [{ type: "text", text: ownerText }] },
    });
    store.admitInput({
      id: steerInputId,
      sessionId,
      idempotencyKey: steerInputId,
      delivery: "steer",
      payload: { content: [{ type: "text", text: steerText }] },
    });
    const crashed = store.acquireRunnerLease(sessionId, "crashed-daemon", 250);
    const crashedFence = {
      sessionId,
      generation: crashed.generation,
      leaseToken: crashed.leaseToken,
    };
    store.claimInput(crashedFence, ownerInputId);

    // The provider response crossed SQLite, but the enclosing turn_end did not.
    // Recovery must not leave an assistant tail or replay the original request.
    const ownerMessageId = `msg_${createHash("sha256")
      .update(`${sessionId}\0${ownerInputId}`)
      .digest("hex")
      .slice(0, 32)}`;
    store.appendMessage(crashedFence, {
      id: ownerMessageId,
      inputId: ownerInputId,
      role: "user",
      metadata: { source: "user-input" },
      parts: [{ type: "text", data: { type: "text", text: ownerText } }],
      createdAtMs: now,
    });
    store.appendMessage(crashedFence, {
      id: "crashed-assistant-tail",
      inputId: ownerInputId,
      role: "assistant",
      metadata: {},
      parts: [{ type: "text", data: { type: "text", text: "partial response survived" } }],
      createdAtMs: now,
    });

    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const session = new Session({
      sessionId,
      workspace,
      provider: finalProvider("wire-host-recovery", (request) => {
        providerCalls += 1;
        requests.push(request);
      }),
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      sessionLeaseTtlMs: 250,
      sessionLeaseHeartbeatMs: 50,
      contextBudgetTokens: 0,
      detachedStartupRecovery: false,
    });

    assert.equal(providerCalls, 0, "construction cannot run daemon-owned recovery");
    assert.deepEqual(
      session.pendingHostManagedStartupRecovery().map((input) => input.id),
      [ownerInputId, steerInputId],
    );
    now += 251;
    const recovered = await session.prepareHostManagedStartupRecovery();
    assert.deepEqual(recovered.map((input) => input.id), [ownerInputId, steerInputId]);
    assert.equal(providerCalls, 0, "lease takeover reconciles but never invokes the provider");

    const events = await collect(session.sendContent(
      [{ type: "text", text: ownerText }],
      { inputId: ownerInputId, delivery: "queue", recoverExistingInput: true },
    ));
    assert.equal(events.at(-1)?.type, "turn_end");
    assert.equal(events.find((event) => event.type === "turn_end")?.status, "completed");
    assert.equal(providerCalls, 1, "owner and correction share one recovered provider generation");
    assert.equal(store.getInput(ownerInputId)?.state, "consumed");
    assert.equal(store.getInput(steerInputId)?.state, "consumed");
    assert.equal(store.getRun(sessionId, 4), null, "no second execution generation is created for the steer");
    assert.equal(store.listDetachedInputResults(sessionId).length, 0);
    assert.match(JSON.stringify(requests[0]?.messages), /partial response survived/);
    assert.match(JSON.stringify(requests[0]?.messages), /RECOVERY BOUNDARY/);
    assert.match(JSON.stringify(requests[0]?.messages), /keep the original camera transform/);
    assert.ok(
      store.listMessages(sessionId).some((message) =>
        message.metadata &&
        typeof message.metadata === "object" &&
        !Array.isArray(message.metadata) &&
        message.metadata.source === "session-kernel-recovery"),
      "assistant-tail recovery appends an explicit user-role boundary",
    );
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a later caller may admit while startup recovery runs but cannot overtake or receive the orphan stream", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-orphan-order-"));
  const { store } = createKernel();
  let releaseOrphan = (): void => {};
  let laterTurn: Promise<TurnEvent[]> | undefined;
  try {
    const sessionId = "orphan-order";
    store.createSession({ id: sessionId, workspaceKey: workspace });
    store.admitInput({
      id: "orphan-head",
      sessionId,
      idempotencyKey: "orphan-head",
      delivery: "queue",
      payload: { content: [{ type: "text", text: "durable orphan head" }] },
    });
    let signalOrphanStarted!: () => void;
    const orphanStarted = new Promise<void>((resolve) => {
      signalOrphanStarted = resolve;
    });
    const orphanGate = new Promise<void>((resolve) => {
      releaseOrphan = resolve;
    });
    const requests: ProviderRequest[] = [];
    let calls = 0;
    const provider: Provider = {
      name: "orphan-order-provider",
      async *stream(request): AsyncGenerator<StreamEvent> {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          signalOrphanStarted();
          await orphanGate;
        }
        yield {
          type: "message_done",
          message: assistant(`wire-orphan-order-${calls}`, `reply ${calls}`),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    laterTurn = collect(
      session.sendContent([{ type: "text", text: "later caller payload" }], { inputId: "later-caller" }),
    );

    await orphanStarted;
    await waitFor(
      () => store.getInput("later-caller")?.state === "admitted",
      "later caller did not cross its independent admission barrier",
    );
    assert.equal(calls, 1);
    assert.equal(store.getInput("orphan-head")?.state, "claimed");
    assert.equal(store.getInput("later-caller")?.state, "admitted");
    assert.match(JSON.stringify(requests[0]?.messages), /durable orphan head/);
    assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /later caller payload/);

    releaseOrphan();
    await session.waitForStartupRecovery();
    const laterEvents = await laterTurn;
    assert.equal(calls, 2);
    assert.match(JSON.stringify(laterEvents.find((event) => event.type === "turn_start")), /later caller payload/);
    assert.doesNotMatch(JSON.stringify(laterEvents), /durable orphan head/);
    assert.equal(store.getDetachedInputResult("orphan-head")?.executionState, "completed");
    assert.equal(store.getDetachedInputResult("later-caller"), null, "the live sender owns normal delivery");
    assert.equal(store.getInput("later-caller")?.state, "consumed");
  } finally {
    releaseOrphan();
    if (laterTurn) await Promise.allSettled([laterTurn]);
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("QueryEngine withholds tool_start until durable pre-execution admission commits", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-tool-start-barrier-"));
  try {
    let round = 0;
    const provider: Provider = {
      name: "barrier-provider",
      async *stream(): AsyncGenerator<StreamEvent> {
        round += 1;
        if (round === 1) {
          yield { type: "tool_use_start", id: "barrier-tool", name: "Barrier" };
          yield { type: "tool_use_input_done", id: "barrier-tool", input: {} };
          yield {
            type: "message_done",
            message: {
              ...assistant("barrier-request", ""),
              content: [{ type: "tool_use", id: "barrier-tool", name: "Barrier", input: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("barrier-finished"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    let releaseAdmission!: () => void;
    let markAdmissionStarted!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const admissionStarted = new Promise<void>((resolve) => {
      markAdmissionStarted = resolve;
    });
    const order: string[] = [];
    const tool: EngineTool = {
      schema: {
        name: "Barrier",
        description: "Exercise admission ordering",
        inputJsonSchema: { type: "object", additionalProperties: false },
        safety: "read-only",
        concurrency: "parallel-safe",
      },
      call: async () => {
        order.push("tool-call");
        return { output: "ok" };
      },
    };
    const engine = QueryEngine.forTesting({
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [tool],
      workspace,
      beforeToolExecution: async () => {
        order.push("admission-started");
        markAdmissionStarted();
        await admissionGate;
        order.push("admission-committed");
      },
      afterToolExecution: async () => {
        order.push("settlement-committed");
      },
      contextBudgetTokens: 0,
    }, "barrier-session");
    engine.appendUserMessage("run barrier");
    const events: TurnEvent[] = [];
    const pumping = (async () => {
      for await (const event of engine.streamTurn()) {
        if (event.type === "tool_start") order.push("tool-start-exposed");
        if (event.type === "tool_end") order.push("tool-end-exposed");
        events.push(event);
      }
    })();

    await admissionStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.some((event) => event.type === "tool_start"), false);
    assert.equal(order.includes("tool-call"), false);
    releaseAdmission();
    await pumping;
    assert.ok(order.indexOf("admission-committed") < order.indexOf("tool-start-exposed"), order.join(" -> "));
    assert.ok(order.indexOf("admission-committed") < order.indexOf("tool-call"), order.join(" -> "));
    assert.ok(order.indexOf("settlement-committed") < order.indexOf("tool-end-exposed"), order.join(" -> "));
    assert.ok(
      events.findIndex((event) => event.type === "tool_start") <
        events.findIndex((event) => event.type === "tool_end"),
      "stream ordering must still expose tool_start before tool_end",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool execution is durable before entry and settled before tool_end exposure", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-tool-"));
  const { store } = createKernel();
  try {
    const sessionId = "tool-session";
    let round = 0;
    const provider: Provider = {
      name: "one-tool",
      async *stream(): AsyncGenerator<StreamEvent> {
        round += 1;
        if (round === 1) {
          yield { type: "tool_use_start", id: "wire-tool-1", name: "Inspect" };
          yield { type: "tool_use_input_done", id: "wire-tool-1", input: { target: "state" } };
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-tool-request", ""),
              content: [{ type: "tool_use", id: "wire-tool-1", name: "Inspect", input: { target: "state" } }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-tool-finished"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const tool: EngineTool = {
      schema: {
        name: "Inspect",
        description: "Inspect durable state",
        inputJsonSchema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
          additionalProperties: false,
        },
        safety: "read-only",
        concurrency: "parallel-safe",
      },
      call: async (_input, context) => {
        const run = store.listToolRuns(sessionId)[0];
        assert.equal(run?.executionState, "executing", "durable adapter-entry state must precede implementation");
        const decision = await context.requestPermission?.({
          toolName: "Inspect",
          input: { target: "state" },
          reason: "exercise permission ordering",
          suggestion: "allow_once",
        });
        assert.equal(decision, "allow_once");
        return { output: { ok: true, value: 42 } };
      },
    };
    let resolvePermission!: (decision: "allow_once") => void;
    const ownerDecision = new Promise<"allow_once">((resolve) => {
      resolvePermission = resolve;
    });
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [tool],
      sessionKernel: store,
      requestPermission: async () => ownerDecision,
      contextBudgetTokens: 0,
    });
    const observerStates: string[] = [];
    session.observeEvents((event) => {
      if (event.type === "tool_end") {
        observerStates.push(store.listToolRuns(sessionId)[0]?.executionState ?? "missing");
      }
    });

    const events: TurnEvent[] = [];
    for await (const event of session.send("inspect")) {
      if (event.type === "permission_request") {
        const toolRun = store.listToolRuns(sessionId)[0];
        assert.equal(toolRun?.executionState, "executing");
        assert.equal(
          store.listEvents(sessionId).some((stored) => stored.type === "tool.authorized"),
          false,
          "adapter entry must not be mislabeled as owner authorization while permission is pending",
        );
        resolvePermission("allow_once");
      }
      if (event.type === "tool_end") {
        assert.equal(store.listToolRuns(sessionId)[0]?.executionState, "succeeded");
        assert.equal(store.listMessages(sessionId).filter((message) => message.role === "tool").length, 1);
      }
      events.push(event);
    }
    assert.ok(events.some((event) => event.type === "tool_end"));
    assert.deepEqual(observerStates, ["succeeded"]);
    const toolRun = store.listToolRuns(sessionId)[0];
    assert.equal(toolRun?.executionState, "succeeded");
    assert.equal(toolRun?.verificationState, "not_required");
    assert.deepEqual(toolRun?.result, { ok: true, value: 42 });
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("provider message ids are namespaced in SQLite and restored for each session replay", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-message-id-"));
  const { store } = createKernel();
  try {
    const provider = finalProvider("provider-reused-message-id");
    const first = new Session({
      sessionId: "collision-a",
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const second = new Session({
      sessionId: "collision-b",
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    await collect(first.send("one"));
    await collect(second.send("two"));

    const firstStored = store.listMessages("collision-a").find((message) => message.role === "assistant");
    const secondStored = store.listMessages("collision-b").find((message) => message.role === "assistant");
    assert.ok(firstStored && secondStored);
    assert.notEqual(firstStored.id, secondStored.id);
    assert.notEqual(firstStored.id, "provider-reused-message-id");
    assert.notEqual(secondStored.id, "provider-reused-message-id");

    const firstReplay = projectMessagesFromKernel(store, "collision-a");
    const secondReplay = projectMessagesFromKernel(store, "collision-b");
    assert.equal(firstReplay.find((message) => message.role === "assistant")?.id, "provider-reused-message-id");
    assert.equal(secondReplay.find((message) => message.role === "assistant")?.id, "provider-reused-message-id");
    assert.equal(firstReplay.filter((message) => message.role === "assistant").length, 1);
    assert.equal(secondReplay.filter((message) => message.role === "assistant").length, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
