// The event half of "event-driven first, interval-second".
//
// The Scheduler has accepted enqueued events since O1 and the background loop
// has forwarded them since it was wired — but nothing ever produced one, and
// more quietly, nothing ever DRAINED one. An enqueued event woke the loop, its
// payload was ignored, and it sat in the array forever. On a daemon whose
// fallback heartbeat is thirty minutes, that queue was the difference between
// noticing something now and noticing it after lunch.
//
// Note the wake semantics these tests encode: enqueueing IS the wake. The
// Scheduler fires a tick on the spot, so there is no "queue it now, tick it
// later" — the only thing that defers a wake is the pause gate.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OperatorBackgroundLoop,
  Scheduler,
  MAX_QUEUED_EVENTS,
} from "../packages/operator/dist/index.js";

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-events-"));

/** A context whose dispatcher is never reached — these tests never run a goal. */
const ctx = (home) => ({
  home,
  workspace: home,
  dispatcher: { dispatch: async () => ({ ok: true, summary: "unused" }) },
});

/**
 * Build a loop plus a promise that settles when a tick finishes. Every tick
 * ends in operator_idle here (no goals exist), including a parked one.
 */
function loopWithTickSignal(home, opts = {}) {
  const seen = [];
  const waiting = [];
  const loop = new OperatorBackgroundLoop(ctx(home), {
    everyMs: 60_000,
    ...opts,
    emit: (event) => {
      seen.push(event);
      // Every tick here ends in exactly one of these, a parked one included.
      if (event.type === "operator_idle" || event.type === "operator_tick" || event.type === "operator_error") {
        for (const resolve of waiting.splice(0, waiting.length)) resolve(event);
      }
    },
  });
  return {
    loop,
    seen,
    /** Resolves on the next tick that COMPLETES after this call. */
    nextTick: () => new Promise((resolve) => waiting.push(resolve)),
  };
}

test("scheduler: the event queue is bounded — a parked loop cannot grow forever", () => {
  const sched = new Scheduler({ everyMs: 60_000, onTick: () => {} });
  for (let i = 0; i < MAX_QUEUED_EVENTS + 50; i++) sched.enqueueEvent({ n: i });
  assert.equal(sched.pendingEvents(), MAX_QUEUED_EVENTS);
  const drained = sched.drainEvents();
  assert.equal(drained.length, MAX_QUEUED_EVENTS);
  // The OLDEST are dropped: what woke you most recently is what matters.
  assert.equal(drained[drained.length - 1].n, MAX_QUEUED_EVENTS + 49);
  assert.equal(sched.pendingEvents(), 0);
});

test("enqueueing wakes the loop, and that tick consumes the wake", async () => {
  const home = await makeHome();
  const { loop, seen, nextTick } = loopWithTickSignal(home);
  const tick = nextTick();
  loop.enqueueEvent({ kind: "turn_end", sessionId: "s1" });
  await tick;

  assert.equal(loop.pendingEvents(), 0, "the wake was consumed, not left to pile up");
  const woken = seen.filter((e) => e.type === "operator_woken");
  assert.equal(woken.length, 1, "the tick says it was woken by an event");
  assert.equal(woken[0].events, 1);
  assert.equal(woken[0].reason, "event");
});

test("a PARKED tick keeps its events for the tick that actually runs", async () => {
  const home = await makeHome();
  let paused = true;
  const { loop, seen, nextTick } = loopWithTickSignal(home, { paused: () => paused });

  const parked = nextTick();
  loop.enqueueEvent({ kind: "turn_end" });
  await parked;
  assert.equal(loop.pendingEvents(), 1, "a parked tick consumed nothing — the wake survives");
  assert.equal(seen.filter((e) => e.type === "operator_woken").length, 0);

  paused = false;
  const ran = await loop.tickOnce("event");
  assert.equal(ran.events.length, 1, "the tick that runs gets the event");
  assert.equal(ran.events[0].kind, "turn_end");
  assert.equal(loop.pendingEvents(), 0);
});

test("an interval tick with nothing queued reports no events", async () => {
  const home = await makeHome();
  const { loop, seen } = loopWithTickSignal(home);
  const tick = await loop.tickOnce("interval");
  assert.deepEqual(tick.events, []);
  assert.equal(seen.filter((e) => e.type === "operator_woken").length, 0, "no wake, no noise");
});

test("a wake is delivered exactly once, never to two ticks", async () => {
  const home = await makeHome();
  const { loop, nextTick } = loopWithTickSignal(home);
  const tick = nextTick();
  loop.enqueueEvent({ kind: "turn_end" });
  // A manual tick racing the wake-fired one is dropped by backpressure; between
  // them the event must be consumed once and only once.
  const manual = await loop.tickOnce("manual");
  await tick;
  assert.ok(manual.events.length <= 1);
  assert.equal(loop.pendingEvents(), 0);
});
