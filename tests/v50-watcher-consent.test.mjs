// V50 — gated watcher execution + event-driven wakes.
//
// Pins the consent contract:
//   - an execute-mode watcher may materialize an EXECUTION goal ONLY through a
//     live gate answering allow; deny, throw, or no gate at all degrades to
//     plan-only (the v49 behavior, verbatim);
//   - a plan-mode watcher NEVER consults the gate;
//   - consent is recorded structurally (goal.mode/goal.consent), keyed on the
//     watcher+fingerprint the approval covered;
//   - wakeOn routes drained queue events to watchers (due now, floored by the
//     probe cadence minimum) instead of counting-and-discarding them;
//   - operatorTickIntervalMs is the single source for the heartbeat literal.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addWatcher,
  checkWatchers,
  loadWatchers,
  normalizeWatcher,
  operatorTickIntervalMs,
  wakeMatchedWatchers,
} from "../packages/operator/dist/index.js";

function freshHome() {
  return mkdtempSync(path.join(os.tmpdir(), "ares-watcher-consent-"));
}

const tripped = { kind: "always", met: false, summary: "condition is red" };

test("execute-mode watcher + allow gate materializes an execution goal with recorded consent", async () => {
  const home = freshHome();
  try {
    await addWatcher(home, {
      label: "restart the dev server",
      condition: tripped,
      proposal: "restart the workspace dev server",
      mode: "execute",
    });
    const asked = [];
    const result = await checkWatchers(home, {
      requestExecution: async (req) => {
        asked.push(req);
        return "allow_once";
      },
    });
    assert.equal(result.fired.length, 1);
    const goal = result.goals[0];
    assert.equal(goal.mode, "execute");
    assert.ok(!/Plan ONLY/.test(goal.statement), "a consented goal drops the plan-only prefix");
    assert.match(goal.statement, /owner approved/);
    assert.ok(goal.consent, "consent is recorded structurally");
    assert.ok(goal.consent.approvalId.includes(asked[0].watcherId), "consent is keyed to the watcher");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].proposal, "restart the workspace dev server");
    assert.ok(asked[0].fingerprint, "the gate is told which condition state it is approving");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("deny, gate crash, and no-gate all degrade to plan-only", async () => {
  for (const requestExecution of [
    async () => "deny",
    async () => {
      throw new Error("gate unreachable");
    },
    undefined,
  ]) {
    const home = freshHome();
    try {
      await addWatcher(home, {
        label: "risky",
        condition: tripped,
        proposal: "do the risky thing",
        mode: "execute",
      });
      const result = await checkWatchers(home, { requestExecution });
      assert.equal(result.goals.length, 1);
      assert.equal(result.goals[0].mode, "plan");
      assert.match(result.goals[0].statement, /^Plan ONLY — do NOT execute\./);
      assert.equal(result.goals[0].consent, undefined);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

test("a plan-mode watcher never consults the gate", async () => {
  const home = freshHome();
  try {
    await addWatcher(home, { label: "plain", condition: tripped, proposal: "look into it" });
    let gateCalls = 0;
    const result = await checkWatchers(home, {
      requestExecution: async () => {
        gateCalls++;
        return "allow_once";
      },
    });
    assert.equal(result.goals.length, 1);
    assert.equal(gateCalls, 0, "plan-mode trips must not prompt the owner");
    assert.match(result.goals[0].statement, /^Plan ONLY/);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("wakeOn marks a watcher due on a matching event, floored by the probe minimum", () => {
  const base = normalizeWatcher({
    label: "after turns",
    condition: tripped,
    proposal: "check the build",
    wakeOn: ["turn_settled"],
    cadenceMs: 60 * 60_000,
  });
  const now = new Date("2026-08-17T12:00:00Z");

  // Never checked → a matching wake makes it due immediately.
  assert.equal(wakeMatchedWatchers([base], [{ kind: "turn_settled" }], now).length, 1);
  // Non-matching kind → not due.
  assert.equal(wakeMatchedWatchers([base], [{ kind: "inbound_email" }], now).length, 0);
  // No events → not due (cadence path owns it).
  assert.equal(wakeMatchedWatchers([base], [], now).length, 0);
  // Checked 10s ago → the probe floor suppresses a wake storm.
  const justChecked = { ...base, lastCheckedAt: new Date(now.getTime() - 10_000).toISOString() };
  assert.equal(wakeMatchedWatchers([justChecked], [{ kind: "turn_settled" }], now).length, 0);
  // Checked 2 minutes ago → due again on wake, even though cadence is an hour.
  const checkedAWhileAgo = { ...base, lastCheckedAt: new Date(now.getTime() - 120_000).toISOString() };
  assert.equal(wakeMatchedWatchers([checkedAWhileAgo], [{ kind: "turn_settled" }], now).length, 1);
  // Disabled → never.
  assert.equal(wakeMatchedWatchers([{ ...base, enabled: false }], [{ kind: "turn_settled" }], now).length, 0);
});

test("checkWatchers routes wokenBy events to wakeOn watchers ahead of cadence", async () => {
  const home = freshHome();
  try {
    await addWatcher(home, {
      label: "wake-routed",
      condition: tripped,
      proposal: "probe after every settled turn",
      wakeOn: ["turn_settled"],
      cadenceMs: 60 * 60_000,
    });
    // Without a wake, an hour-cadence fresh watcher is due (never checked)…
    const first = await checkWatchers(home, {});
    assert.equal(first.checked, 1);
    // …but once checked, only a matching wake can bring it back before the hour.
    const idle = await checkWatchers(home, {});
    assert.equal(idle.checked, 0, "cadence keeps it quiet");
    // Age the check past the probe floor, then wake it.
    const watchers = await loadWatchers(home);
    const aged = { ...watchers[0], lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    const { saveWatcher } = await import("../packages/operator/dist/index.js");
    await saveWatcher(home, aged);
    const woken = await checkWatchers(home, { wokenBy: [{ kind: "turn_settled" }] });
    assert.equal(woken.checked, 1, "a matching wake probes ahead of cadence");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("operatorTickIntervalMs is the one heartbeat literal", () => {
  assert.equal(operatorTickIntervalMs({}), 30 * 60_000);
  assert.equal(operatorTickIntervalMs({ ARES_OPERATOR_TICK_MS: "120000" }), 120_000);
  assert.equal(operatorTickIntervalMs({ ARES_OPERATOR_TICK_MS: "5" }), 60_000, "floored at one minute");
  assert.equal(operatorTickIntervalMs({ ARES_OPERATOR_TICK_MS: "garbage" }), 30 * 60_000);
});
