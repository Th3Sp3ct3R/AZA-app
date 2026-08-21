import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

test("desktop daemon-ready replay keeps exact steer IDs and attachments once per epoch", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-steer-restart-"));
  try {
    const outfile = path.join(tmp, "steer-replay.mjs");
    await esbuild({
      entryPoints: [path.join(here, "..", "tauri", "src", "state", "steerReplay.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "silent",
    });
    const replay = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    const images = ["data:image/png;base64,ONE", "data:image/webp;base64,TWO"];
    const session = {
      id: "session-a",
      items: [
        { kind: "steer", inputId: "submitting", text: "course correct", images, status: "submitting" },
        { kind: "steer", inputId: "generation", text: "stop that", status: "interrupting_generation" },
        { kind: "steer", inputId: "action", text: "after the write", status: "waiting_for_action" },
        { kind: "steer", inputId: "boundary", text: "next round", status: "waiting_for_boundary" },
        { kind: "steer", inputId: "applied", text: "done", status: "applied" },
        { kind: "steer", inputId: "cancelled", text: "back in draft", status: "cancelled" },
        { kind: "steer", inputId: "rejected", text: "also in draft", status: "rejected" },
        { kind: "steer", inputId: "legacy", text: "unknown state" },
        { kind: "steer", inputId: "live-send", text: "already sent in this process", status: "submitting" },
      ],
    };

    const epoch = replay.createSteerReplayEpoch();
    replay.markSteerSentInEpoch(epoch, session.id, "live-send");
    const first = replay.claimSteersForDaemonReady([session], epoch);

    assert.deepEqual(first.map((item) => item.inputId), ["submitting", "generation", "action", "boundary"]);
    assert.equal(first[0].sessionId, "session-a");
    assert.deepEqual(first[0].images, images, "attachments survive collection");
    assert.notEqual(first[0].images, images, "replay owns a stable attachment snapshot");
    assert.equal(
      replay.steerReplayWireText(first[0]),
      "course correct\ndata:image/png;base64,ONE\ndata:image/webp;base64,TWO",
      "wire text preserves the original steer text and every image",
    );
    assert.deepEqual(
      replay.claimSteersForDaemonReady([session], epoch),
      [],
      "a duplicate daemon_ready in one process cannot submit any ID twice",
    );

    replay.resetSteerReplayEpoch(epoch);
    assert.deepEqual(
      replay.claimSteersForDaemonReady([session], epoch).map((item) => item.inputId),
      ["submitting", "generation", "action", "boundary", "live-send"],
      "a genuinely new daemon process may retry every still-nonterminal bubble",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("desktop transport loss leaves steer settlement to same-ID daemon replay", () => {
  const app = readFileSync(path.join(here, "..", "tauri", "src", "App.tsx"), "utf8");
  const steerStart = app.indexOf("const steer = useCallback");
  const steerEnd = app.indexOf("const stopTurn = useCallback", steerStart);
  const steerBlock = app.slice(steerStart, steerEnd);
  const readyStart = app.indexOf("const onDaemonReady = useCallback");
  const readyEnd = app.indexOf("// ── daemon boot + event ingestion", readyStart);
  const readyBlock = app.slice(readyStart, readyEnd);
  const stopStart = app.indexOf("const stopTurn = useCallback");
  const stopEnd = app.indexOf("const undoLastChange", stopStart);
  const stopBlock = app.slice(stopStart, stopEnd);

  assert.ok(steerStart >= 0 && steerEnd > steerStart, "steer callback remains discoverable");
  assert.match(steerBlock, /markSteerSentInEpoch/);
  assert.match(steerBlock, /lost transport[\s\S]*restartDaemon\(\)/);
  assert.doesNotMatch(steerBlock, /steer_rejected/, "ambiguous IPC failure must not restore a possibly canonical steer");
  assert.match(readyBlock, /claimSteersForDaemonReady\(sessionsRef\.current/);
  assert.match(readyBlock, /applyTo\(replay\.sessionId[\s\S]*busy:\s*true/,
    "daemon-ready replay immediately restores the Stop/steer UI gate");
  assert.match(readyBlock, /inputId:\s*replay\.inputId/);
  assert.match(readyBlock, /const queued = pendingGoal\.current[\s\S]*ares_send[\s\S]*inputId: queued\.inputId/,
    "ordinary queued goals still flush through their original path");
  assert.match(stopBlock, /daemon !== "running" && localPending[\s\S]*pendingGoal\.current = null[\s\S]*desktop_pending_input_cancelled/,
    "offline Stop revokes the local exact-ID replay before daemon_ready can execute it");
  assert.ok(
    stopBlock.indexOf("pendingGoal.current = null") < stopBlock.indexOf("desktop_pending_input_cancelled"),
    "the replay pointer is cleared before draft restoration can schedule a render",
  );
  assert.match(
    app,
    /!cancelling && \(text\.trim\(\) \|\| attachments\.length > 0\)[\s\S]*className="send steer"/,
    "an attachment-only correction exposes the same mid-turn steer action as text",
  );
  assert.match(app, /supportedAttachmentMediaType\(file\)/);
  assert.match(app, /Attachment skipped:[\s\S]*convert it to PNG, JPEG, WebP, or GIF/,
    "unsupported image formats are disclosed instead of becoming opaque prompt text");
  assert.match(
    app,
    /case "startup_recovery_failed"[\s\S]*stoppingSessionsRef\.current\.delete\(recoverySession\)/,
    "a failed restart takeover releases any Desktop Stop gate",
  );
});

test("desktop keeps recovered work steerable and stoppable across lease takeover", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-recovery-ui-"));
  try {
    const outfile = path.join(tmp, "fold-event.mjs");
    await esbuild({
      entryPoints: [path.join(here, "..", "tauri", "src", "state", "foldEvent.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "silent",
    });
    const { foldEvent } = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    const base = {
      id: "recovered-session",
      title: "Recovered",
      items: [{ kind: "steer", key: "recovering", inputId: "recovering", text: "fix it", status: "submitting" }],
      busy: false,
      workflowMode: "build",
      tokensIn: 0,
      cacheReadTokens: 0,
      tokensOut: 0,
      todos: [],
      steerQueued: 1,
    };

    const preparing = foldEvent(base, {
      type: "startup_recovery_preparing",
      inputId: "recovering",
      inputIds: ["recovering"],
    });
    assert.equal(preparing.busy, true, "the Stop/steer controls remain available while a dead lease is fenced");
    assert.equal(preparing.activity, "recovering interrupted work");

    const queued = foldEvent(preparing, { type: "startup_recovery_queued", inputIds: ["recovering"] });
    assert.equal(queued.busy, true, "the queued-to-turn_start hand-off cannot flash back to idle");
    assert.equal(queued.activity, "resuming recovered work");

    const failed = foldEvent(queued, { type: "startup_recovery_failed", error: "lease database unavailable" });
    assert.equal(failed.busy, false, "an explicit recovery failure releases the UI gate");
    assert.ok(failed.items.some((item) => item.kind === "notice" && /remains durable/.test(item.text ?? "")));

    const approval = {
      ...base,
      items: [{ kind: "permission", key: "approval", id: "approval-1", toolName: "Browser", reason: "sign in" }],
      steerQueued: 0,
    };
    const sending = foldEvent(approval, {
      type: "permission_submission_started",
      id: "approval-1",
      decision: "allow_once",
    });
    assert.equal(sending.items[0].submitting, "allow_once");
    assert.equal(sending.items[0].decided, undefined, "an optimistic click is not daemon settlement");

    const deliveryFailed = foldEvent(sending, {
      type: "permission_submission_failed",
      id: "approval-1",
      error: "daemon pipe closed",
    });
    assert.equal(deliveryFailed.items[0].submitting, undefined, "failed IPC re-enables the exact approval");
    assert.equal(deliveryFailed.items[0].decided, undefined);
    assert.ok(deliveryFailed.items.some((item) => item.kind === "notice" && /buttons are active again/.test(item.text ?? "")));

    const acknowledged = foldEvent(sending, {
      type: "permission_response",
      id: "approval-1",
      decision: "allow_once",
    });
    assert.equal(acknowledged.items[0].decided, "allow_once", "only the daemon response settles the approval card");
    assert.equal(acknowledged.items[0].submitting, undefined);

    const locallyQueued = {
      ...base,
      title: "queued while offline",
      busy: true,
      cancelling: true,
      activity: "stopping safely",
      items: [{
        kind: "user",
        key: "local-user",
        inputId: "input-offline",
        text: "queued while offline",
        images: ["data:image/png;base64,LOCAL"],
      }],
      steerQueued: 0,
    };
    const localCancelled = foldEvent(locallyQueued, {
      type: "desktop_pending_input_cancelled",
      inputId: "input-offline",
      text: "queued while offline",
      images: ["data:image/png;base64,LOCAL"],
    });
    assert.equal(localCancelled.busy, false);
    assert.equal(localCancelled.cancelling, false);
    assert.equal(localCancelled.activity, undefined);
    assert.equal(localCancelled.title, "New session");
    assert.equal(localCancelled.items.some((item) => item.kind === "user" && item.inputId === "input-offline"), false,
      "the exact unsent transcript bubble is removed before the draft is restored");
    assert.deepEqual(localCancelled.recoverableDrafts, [{
      inputId: "input-offline",
      text: "queued while offline",
      images: ["data:image/png;base64,LOCAL"],
    }]);

    const terminal = foldEvent({ ...base, busy: true }, {
      type: "turn_end",
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    assert.equal(terminal.busy, true, "model turn_end cannot unlock before daemon epilogue ownership releases");
    assert.equal(terminal.activity, "settling turn");
    const hostSettled = foldEvent(terminal, { type: "turn_settled", inputId: "owner" });
    assert.equal(hostSettled.busy, false, "the explicit host settlement fence unlocks the next ordinary send");
    assert.equal(hostSettled.activity, undefined);
    const continuing = foldEvent(terminal, { type: "turn_settled", inputId: "owner", continuing: true });
    assert.equal(continuing.busy, true, "a scheduled exact-ID successor keeps the composer in steer/Stop mode");
    assert.equal(continuing.activity, "continuing queued correction");
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("specialized approval cards share the generic one-decision submission fence", () => {
  const app = readFileSync(path.join(here, "..", "tauri", "src", "App.tsx"), "utf8");
  const offerStart = app.indexOf('item.toolName === "CodingBackend:offer"');
  const planStart = app.indexOf('item.toolName === "ExitPlanMode"', offerStart);
  const genericStart = app.indexOf('if (item.kind === "permission")', planStart);
  const offer = app.slice(offerStart, planStart);
  const plan = app.slice(planStart, genericStart);
  const respondStart = app.indexOf("const respondPermission");
  const respondEnd = app.indexOf("const applySettings", respondStart);
  const respond = app.slice(respondStart, respondEnd);

  assert.match(offer, /aria-busy=\{item\.submitting/);
  assert.match(offer, /cbOfferClaude" disabled=\{!!item\.submitting\}/);
  assert.match(offer, /cbOfferSelf" disabled=\{!!item\.submitting\}/);
  assert.match(plan, /aria-busy=\{item\.submitting/);
  assert.match(plan, /gateAllow" disabled=\{!!item\.submitting\}/);
  assert.match(plan, /gateDeny" disabled=\{!!item\.submitting\}/);
  assert.match(respond, /permissionSubmissionLocks\.current\.has\(id\)[\s\S]*permissionSubmissionLocks\.current\.add\(id\)/,
    "a synchronous lock closes the pre-render double-click window too");
});
