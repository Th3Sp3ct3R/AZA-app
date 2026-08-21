// V10 — the multi-session daemon. Two concurrent chats must NOT bleed into
// each other: each send is tagged with its own sessionId, runs in its own
// isolated Session, and its events come back tagged. This is the fix for the
// "send to one chat, another responds" bug.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "packages", "cli", "dist", "entry.js");

// Stop a daemon AND its whole process tree, then wait for it to be truly gone.
// child.kill() alone terminates only the daemon: its own children (agent
// runtime, background supervisors) survived it holding open handles inside the
// workspace, and the v0.39.0 release gate went red on exactly that — EBUSY
// from rmSync on a workspace a grandchild still lived in.
function stopDaemon(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("close", resolve);
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => child.kill());
    } else {
      child.kill();
    }
  });
}

// Windows releases a dead tree's handles (and Defender lets go of freshly
// written sqlite/WAL files) asynchronously. 5×100ms lost that race on a loaded
// release runner; a longer ceiling costs nothing on a passing run.
function cleanupWorkspace(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 250 });
}

// Resolves once `expectedTurnEnds` turn_end events arrive (the daemon is
// kill-on-resolve), with a generous ceiling for loaded CI machines — a fixed
// short window flakes when the full suite runs in parallel.
function runDaemon(workspace, commands, expectedTurnEnds, ms = 60000) { // CLI cold boot is 6-10s on Windows; two sessions + agent runtime need real headroom
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"], {
      env: { ...process.env, ARES_AGENT_ENABLED: "1", ARES_HOME: path.join(workspace, "home"), ARES_OPERATOR_AUTOTICK: "0" },
    });
    const lines = [];
    let ends = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      void stopDaemon(child).then(() => resolve(lines));
    };
    const deadline = setTimeout(finish, ms);
    child.stdout.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          lines.push(evt);
          if (evt.type === "turn_end" && ++ends >= expectedTurnEnds) {
            // small grace so trailing events (session metadata) flush
            setTimeout(finish, 250);
          }
        } catch {
          /* non-JSON */
        }
      }
    });
    for (const c of commands) child.stdin.write(JSON.stringify(c) + "\n");
  });
}

test("multi-session: two chats stream concurrently without bleed-over", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-multi-"));
  const events = await runDaemon(ws, [
    { type: "send", sessionId: "chatA", goal: "ALPHA-ONLY" },
    { type: "send", sessionId: "chatB", goal: "BRAVO-ONLY" },
  ], 2);

  const textBy = { chatA: "", chatB: "" };
  for (const e of events) {
    if (e.type === "text_delta") textBy[e.sessionId] = (textBy[e.sessionId] ?? "") + (e.text ?? "");
  }
  // mock-echo replies with the goal — each chat sees ONLY its own.
  assert.match(textBy.chatA, /ALPHA/, "chatA must contain its own message");
  assert.ok(!/BRAVO/.test(textBy.chatA), "chatA must NOT contain chatB's message");
  assert.match(textBy.chatB, /BRAVO/, "chatB must contain its own message");
  assert.ok(!/ALPHA/.test(textBy.chatB), "chatB must NOT contain chatA's message");

  // both turns end, each tagged with its own session
  const endsA = events.filter((e) => e.type === "turn_end" && e.sessionId === "chatA");
  const endsB = events.filter((e) => e.type === "turn_end" && e.sessionId === "chatB");
  assert.ok(endsA.length >= 1, "chatA turn must complete");
  assert.ok(endsB.length >= 1, "chatB turn must complete");

  // the second chat spawned its own isolated session
  assert.ok(events.some((e) => e.type === "session_opened" && e.sessionId === "chatB"), "chatB should open a fresh session");
});

test("steering UI reducer settles exact bubbles, rolls back one attempt, and restores rejected drafts", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-steer-reducer-"));
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
      id: "ui-steer",
      title: "Steering",
      items: [
        { kind: "steer", key: "steer-a", inputId: "input-a", text: "first correction", status: "interrupting_generation" },
        { kind: "assistant", key: "stale", text: "stale output", thinking: "", streaming: true, providerAttemptId: "attempt-a" },
        {
          kind: "tools",
          key: "attempt-tools",
          startedAt: Date.now(),
          steps: [
            { id: "skipped", label: "skipped", name: "Edit", status: "error", providerAttemptId: "attempt-a" },
            { id: "settled", label: "settled", name: "Read", status: "ok", providerAttemptId: "attempt-a", actuallyStarted: true },
          ],
        },
        { kind: "steer", key: "steer-b", inputId: "input-b", text: "second correction", status: "submitting" },
      ],
      busy: true,
      workflowMode: "build",
      tokensIn: 0,
      cacheReadTokens: 0,
      tokensOut: 0,
      todos: [],
      steerQueued: 2,
      providerAttempt: { id: "attempt-a", itemBoundary: 0 },
    };

    const superseded = foldEvent(base, { type: "provider_attempt_superseded", attemptId: "attempt-a", reason: "steering" });
    assert.ok(!superseded.items.some((item) => item.kind === "assistant" && item.key === "stale"), "only stale provider output is rolled back");
    assert.equal(superseded.items.filter((item) => item.kind === "steer").length, 2, "owner steer bubbles survive rollback");
    const toolGroup = superseded.items.find((item) => item.kind === "tools");
    assert.deepEqual(toolGroup?.steps.map((step) => step.id), ["settled"], "synthetic skipped errors disappear while genuinely started tools remain");

    const applied = foldEvent(superseded, { type: "steer_applied", inputId: "input-a" });
    const first = applied.items.find((item) => item.kind === "steer" && item.inputId === "input-a");
    const second = applied.items.find((item) => item.kind === "steer" && item.inputId === "input-b");
    assert.equal(first?.status, "applied", "the matching bubble alone is settled");
    assert.equal(second?.status, "submitting", "an out-of-order ack cannot settle another bubble");

    const rejected = foldEvent(applied, { type: "input_rejected", inputId: "input-b", reason: "turn_cancelling" });
    assert.equal(rejected.recoverableDrafts?.length, 1, "one rejected steer creates one recoverable draft");
    assert.equal(rejected.recoverableDrafts?.[0]?.inputId, "input-b");
    assert.equal(rejected.recoverableDrafts?.[0]?.text, "second correction");

    const retryBase = {
      ...base,
      items: [
        { kind: "assistant", key: "retry-stale", text: "partial stale", thinking: "", streaming: true, providerAttemptId: "retry-old" },
        {
          kind: "tools",
          key: "retry-tools",
          startedAt: Date.now(),
          steps: [{ id: "retry-draft", label: "draft", name: "Edit", status: "drafting", providerAttemptId: "retry-old" }],
        },
      ],
      steerQueued: 0,
      providerAttempt: { id: "retry-old", itemBoundary: 0 },
    };
    const retried = foldEvent(retryBase, { type: "provider_attempt_started", attemptId: "retry-new" });
    assert.ok(!retried.items.some((item) => item.kind === "assistant" && item.providerAttemptId === "retry-old"), "a new retry attempt fences stale assistant deltas");
    assert.ok(!retried.items.some((item) => item.kind === "tools"), "a new retry attempt removes never-started stale tool drafts");
    assert.equal(retried.providerAttempt?.id, "retry-new");

    const freshDelta = foldEvent(retried, { type: "text_delta", text: "fresh response" });
    const freshAssistant = freshDelta.items.find((item) => item.kind === "assistant" && item.providerAttemptId === "retry-new");
    assert.equal(freshAssistant?.text, "fresh response", "replacement deltas are attributed to the replacement attempt");
    const committed = foldEvent(freshDelta, { type: "message_done", stopReason: "end_turn" });
    assert.equal(committed.providerAttempt, undefined, "message_done commits and clears the speculative attempt fence");
    assert.equal(committed.items.find((item) => item.kind === "assistant" && item.providerAttemptId === "retry-new")?.streaming, false);
    const afterCommit = foldEvent(committed, { type: "provider_attempt_started", attemptId: "later-attempt" });
    assert.ok(afterCommit.items.some((item) => item.kind === "assistant" && item.providerAttemptId === "retry-new"), "a later attempt never rolls back a committed assistant");

    const mismatchedTail = {
      ...retried,
      items: [{ kind: "assistant", key: "wrong-tail", text: "wrong", thinking: "", streaming: true, providerAttemptId: "retry-old" }],
    };
    const separated = foldEvent(mismatchedTail, { type: "text_delta", text: "new" });
    assert.equal(separated.items.length, 2, "a delta cannot append into another attempt's streaming bubble");
    assert.equal(separated.items[0].text, "wrong");
    assert.equal(separated.items[1].providerAttemptId, "retry-new");

    const effectsBase = {
      ...base,
      items: [
        { kind: "assistant", key: "committed-effects", text: "I will edit", thinking: "", streaming: false, providerAttemptId: "effects-attempt" },
        {
          kind: "tools",
          key: "effects-tools",
          startedAt: Date.now(),
          steps: [
            { id: "never-started", label: "skipped", name: "Edit", status: "error", providerAttemptId: "effects-attempt" },
            { id: "really-started", label: "ran", name: "Read", status: "ok", providerAttemptId: "effects-attempt", actuallyStarted: true },
          ],
        },
      ],
      providerAttempt: undefined,
    };
    const effectsSkipped = foldEvent(effectsBase, {
      type: "provider_attempt_effects_skipped",
      attemptId: "effects-attempt",
      reason: "steering",
      toolUseIds: ["never-started", "really-started"],
    });
    assert.ok(effectsSkipped.items.some((item) => item.kind === "assistant" && item.key === "committed-effects"), "post-commit steering preserves the canonical assistant");
    const effectSteps = effectsSkipped.items.find((item) => item.kind === "tools")?.steps ?? [];
    assert.deepEqual(effectSteps.map((step) => step.id), ["never-started", "really-started"]);
    assert.equal(effectSteps[0]?.status, "error", "a skipped canonical proposal remains visibly settled as an error");
    assert.match(effectSteps[0]?.detail ?? "", /Skipped before execution/);

    const retryDiagnostic = foldEvent(base, {
      type: "error",
      error: { code: "overloaded", message: "retry me", retriable: true },
    });
    assert.equal(retryDiagnostic.busy, true, "a retriable provider error cannot unlock the composer before turn_end");
    assert.equal(retryDiagnostic.activity, "retrying provider");

    const warning = foldEvent(base, {
      type: "steer_epilogue_warning",
      inputId: "input-a",
      status: "consumed",
      error: "audit flush failed after settlement",
    });
    assert.equal(warning.recoverableDrafts, undefined, "a post-admission epilogue warning never restores a duplicate draft");

    const sessionOutfile = path.join(tmp, "session-state.mjs");
    await esbuild({
      entryPoints: [path.join(here, "..", "tauri", "src", "state", "session.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: sessionOutfile,
      logLevel: "silent",
    });
    const { sessionFromHistory } = await import(`${pathToFileURL(sessionOutfile).href}?v=${Date.now()}`);
    const hydrated = sessionFromHistory("history-tools", [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this image" },
          { type: "image", source: { kind: "base64", mediaType: "image/webp", data: "AA==" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-ok", name: "Read", input: { file: "ok.ts" } },
          { type: "tool_use", id: "tool-failed", name: "Edit", input: { file: "bad.ts" } },
          { type: "tool_use", id: "tool-missing", name: "Write", input: { file: "never.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-ok", content: "read complete" },
          { type: "tool_result", tool_use_id: "tool-failed", content: "skipped before execution by steering", is_error: true },
        ],
      },
    ], {});
    const hydratedSteps = hydrated.items.find((item) => item.kind === "tools")?.steps ?? [];
    assert.deepEqual(hydratedSteps.map((step) => step.status), ["ok", "error", "error"], "history hydration derives truth from canonical tool_result blocks");
    assert.match(hydratedSteps[1]?.detail ?? "", /skipped before execution/);
    assert.match(hydratedSteps[2]?.detail ?? "", /No settled tool result/);
    const hydratedImage = hydrated.items.find((item) => item.kind === "user")?.images?.[0];
    assert.equal(hydratedImage, "data:image/webp;base64,AA==", "canonical camelCase mediaType survives desktop history reload");
  } finally {
    cleanupWorkspace(tmp);
  }
});

test("active steering durably redirects the turn and dedupes its exact input ID", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-live-steer-"));
  const pathImage = path.join(ws, "slow-image.png");
  writeFileSync(pathImage, Buffer.from("not-a-real-png-but-valid-attachment-bytes"));
  const sharedImagePrefix = "A".repeat(120);
  try {
    const events = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cli, "daemon", "--json", "--workspace", ws, "--provider", "mock", "--model", "mock-echo"],
        {
          env: {
            ...process.env,
            ARES_AGENT_ENABLED: "0",
            ARES_HOME: path.join(ws, "home"),
            ARES_OPERATOR_AUTOTICK: "0",
          },
        },
      );
      const seen = [];
      let stdout = "";
      let stderr = "";
      let steerSent = false;
      let settled = false;
      const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        void stopDaemon(child).then(() => (error ? reject(error) : resolve(seen)));
      };
      const deadline = setTimeout(
        () => finish(new Error(`live steering timed out\nstderr=${stderr.slice(-1200)}\nevents=${JSON.stringify(seen.slice(-40))}`)),
        60_000,
      );
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("exit", (code) => {
        if (!settled && code !== null) finish(new Error(`daemon exited ${code}\nstderr=${stderr.slice(-1200)}`));
      });
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        while (true) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) break;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          seen.push(event);
          if (event.type === "daemon_ready" || event.type === "ready") {
            send({
              type: "send",
              sessionId: "steer-chat",
              inputId: "steer-owner",
              goal: "ORIGINAL-STALE __mock_steer_window__",
            });
          } else if (event.type === "text_delta" && event.sessionId === "steer-chat" && !steerSent) {
            steerSent = true;
            const correction = {
              type: "steer",
              sessionId: "steer-chat",
              inputId: "exact-steer-once",
              text: [
                "CORRECTION-FIRST",
                `"${pathImage}"`,
                `data:image/png;base64,${sharedImagePrefix}AQ==`,
                `data:image/png;base64,${sharedImagePrefix}Ag==`,
              ].join("\n"),
            };
            // An IPC retry with the same stable ID must acknowledge replay, not
            // create a second correction or settle another bubble.
            send(correction);
            send(correction);
            // The first correction must await an async path stat/read. This
            // later text-only steer must still cross SQLite admission second.
            send({
              type: "steer",
              sessionId: "steer-chat",
              inputId: "exact-steer-two",
              text: "CORRECTION-SECOND",
            });
          }
          if (
            seen.some((candidate) => candidate.type === "turn_end" && candidate.sessionId === "steer-chat" && candidate.status === "completed") &&
            seen.some((candidate) => candidate.type === "steer_applied" && candidate.inputId === "exact-steer-once") &&
            seen.some((candidate) => candidate.type === "steer_applied" && candidate.inputId === "exact-steer-two")
          ) {
            setTimeout(() => finish(), 100);
          }
        }
      });
    });

    const admitted = events.filter((event) => event.type === "steer_admitted" && event.inputId === "exact-steer-once");
    const applied = events.filter((event) => event.type === "steer_applied" && event.inputId === "exact-steer-once");
    const secondAdmitted = events.filter((event) => event.type === "steer_admitted" && event.inputId === "exact-steer-two");
    const secondApplied = events.filter((event) => event.type === "steer_applied" && event.inputId === "exact-steer-two");
    const superseded = events.filter((event) => event.type === "provider_attempt_superseded" && event.reason === "steering");
    assert.equal(admitted.length, 1, "one stable steer ID crosses durable admission exactly once");
    const expectedDelivery = admitted[0]?.disposition === "provider_preempting"
      ? "interrupting_generation"
      : admitted[0]?.disposition === "effect_settling"
        ? "waiting_for_action"
        : "next_boundary";
    assert.equal(admitted[0]?.delivery, expectedDelivery, "daemon maps the engine's post-durability disposition without sampling a stale phase");
    assert.ok(
      ["provider_preempting", "effect_settling", "boundary_pending", "idle"].includes(admitted[0]?.disposition),
      "admission status comes from QueryEngine after the durability barrier",
    );
    assert.equal(applied.length, 1, "one stable steer ID is acknowledged exactly once");
    assert.equal(secondAdmitted.length, 1);
    assert.equal(secondApplied.length, 1);
    assert.ok(
      events.indexOf(admitted[0]) < events.indexOf(secondAdmitted[0]),
      "a later text steer cannot overtake an earlier image/path steer during parsing",
    );
    // mock-echo has no I/O await and can naturally finish between the first
    // stdout delta and the daemon reading stdin. A real blocking provider emits
    // one supersession (covered by the core integration test); never more than
    // one may leak through this daemon boundary.
    assert.ok(superseded.length <= 2, "two stable corrections cannot supersede more than two provider attempts");
    assert.ok(events.some((event) => event.type === "input_replayed" && event.inputId === "exact-steer-once"), "duplicate transport is idempotently acknowledged");
    const supersededIndex = events.findIndex((event) => event.type === "provider_attempt_superseded" && event.reason === "steering");
    const finalText = events
      .slice(supersededIndex + 1)
      .filter((event) => event.type === "text_delta" && event.sessionId === "steer-chat")
      .map((event) => event.text ?? "")
      .join("");
    assert.match(finalText, /CORRECTION-SECOND/, "the replacement provider attempt sees the newest ordered correction");

    const steerLifecycle = events.filter((event) => event.inputId === "exact-steer-once");
    assert.ok(
      steerLifecycle.every((event) => !JSON.stringify(event).includes("base64,")),
      "steer lifecycle events never echo screenshot data URLs back through event buffers",
    );

    const core = await import(pathToFileURL(path.join(here, "..", "packages", "core", "dist", "index.js")).href);
    const kernel = await core.openWorkspaceSessionKernel(ws);
    try {
      const canonical = kernel.getInput("exact-steer-once");
      const content = canonical?.payload?.content;
      assert.ok(Array.isArray(content), "the steer has canonical structured content");
      assert.deepEqual(content.map((block) => block.type), ["text", "image", "image", "image"]);
      assert.ok(!content[0].text.includes("base64,"), "the data URL is stripped out of the canonical text block");
      assert.equal(content[1].source.kind, "base64");
      assert.equal(content[1].source.mediaType, "image/png");
      assert.equal(content[1].source.data, `${sharedImagePrefix}AQ==`);
      assert.equal(content[2].source.data, `${sharedImagePrefix}Ag==`);
      assert.equal(content[3].source.data, Buffer.from("not-a-real-png-but-valid-attachment-bytes").toString("base64"));
    } finally {
      kernel.close();
    }
  } finally {
    cleanupWorkspace(ws);
  }
});

test("Stop settles its exact input before a fresh send can be treated as steering", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-stop-settlement-"));
  try {
    const events = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cli, "daemon", "--json", "--workspace", ws, "--provider", "mock", "--model", "mock-echo"],
        {
          env: {
            ...process.env,
            ARES_AGENT_ENABLED: "0",
            ARES_HOME: path.join(ws, "home"),
            ARES_OPERATOR_AUTOTICK: "0",
          },
        },
      );
      const seen = [];
      let stdout = "";
      let stderr = "";
      let stopSent = false;
      let retrySent = false;
      let secondText = "";
      let settled = false;
      const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        void stopDaemon(child).then(() => (error ? reject(error) : resolve(seen)));
      };
      const deadline = setTimeout(
        () => finish(new Error(`Stop settlement timed out\nstderr=${stderr.slice(-1200)}`)),
        60_000,
      );
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("exit", (code) => {
        if (!settled && code !== null) finish(new Error(`daemon exited ${code}\nstderr=${stderr.slice(-1200)}`));
      });
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        while (true) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) break;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          seen.push(event);
          if (event.type === "daemon_ready" || event.type === "ready") {
            send({
              type: "send",
              sessionId: "stop-chat",
              inputId: "cancel-one",
              goal: "FIRST-MUST-CANCEL __mock_steer_window__",
            });
          } else if (event.type === "text_delta" && event.sessionId === "stop-chat" && !stopSent) {
            stopSent = true;
            send({ type: "interrupt", sessionId: "stop-chat" });
            // This line is intentionally queued immediately behind Stop. The
            // daemon must reject it as a fresh queue input, never infer steer.
            send({
              type: "send",
              sessionId: "stop-chat",
              inputId: "after-stop",
              goal: "SECOND-AFTER-STOP",
            });
          } else if (event.type === "interrupt_settled" && event.sessionId === "stop-chat" && !retrySent) {
            retrySent = true;
            send({
              type: "send",
              sessionId: "stop-chat",
              inputId: "after-stop",
              goal: "SECOND-AFTER-STOP",
            });
          } else if (event.type === "text_delta" && event.sessionId === "stop-chat" && retrySent) {
            secondText += event.text ?? "";
          } else if (
            event.type === "turn_end" &&
            event.sessionId === "stop-chat" &&
            event.status === "completed" &&
            retrySent &&
            secondText.includes("SECOND-AFTER-STOP")
          ) {
            setTimeout(() => finish(), 100);
          }
        }
      });
    });

    const requested = events.findIndex((event) => event.type === "interrupt_requested");
    const rejected = events.findIndex(
      (event) => event.type === "input_rejected" && event.inputId === "after-stop" && event.reason === "turn_cancelling",
    );
    const interrupted = events.findIndex(
      (event) => event.type === "turn_end" && event.sessionId === "stop-chat" && event.status === "interrupted",
    );
    const settled = events.findIndex((event) => event.type === "interrupt_settled");
    assert.ok(requested >= 0, "Stop receives an acceptance acknowledgement");
    assert.ok(rejected > requested, "Stop-then-send is rejected while cancellation owns the turn");
    assert.ok(interrupted > requested, "the exact active turn reaches an interrupted terminal boundary");
    assert.ok(settled > interrupted, "fresh sends unlock only after daemon settlement");
    const textAfterSettlement = events
      .slice(settled)
      .filter((event) => event.type === "text_delta" && event.sessionId === "stop-chat")
      .map((event) => event.text ?? "")
      .join("");
    assert.match(textAfterSettlement, /SECOND-AFTER-STOP/, "the preserved/retried message runs as a normal next turn");
    assert.ok(
      !events.some((event) => event.type === "steer_queued" && event.inputId === "after-stop"),
      "the post-Stop input is never converted into steering",
    );
  } finally {
    cleanupWorkspace(ws);
  }
});
