// The 4.8GB-leak soak harness — desktop-free regression net for the v0.36.0
// renderer fixes (fa8d30ab). The WebView2 diagnosis was: unvirtualised
// transcript + per-frame data-URI churn. The DOM half lives in App.tsx
// (TRANSCRIPT_WINDOW / LiveFrameCanvas / BubbleImage); THIS harness pins the
// reducer half, which every client shares (desktop ingest, and now the
// garrison /view page): replaying a brutal event stream through foldEvent must
// not retain the streamed payloads.
//
// Invariants pinned:
//  1. browser_frame churn: hundreds of MB of data-URI frames streamed THROUGH
//     the reducer retain ZERO frame payloads in the session VM (the desktop
//     also intercepts frames pre-fold; this proves defense in depth for
//     clients that don't).
//  2. shell_output spam: the live tail stays clamped (≤200 lines), no matter
//     how many lines stream.
//  3. coding_backend lines stay clamped (≤6).
//  4. Retained heap after GC stays within an order of magnitude of the
//     session VM's own JSON size — NOT of the total streamed bytes. A
//     reintroduced retention bug fails this by ~10×, loudly.
//
// The default run streams ~120MB (CI-sized, a few seconds). ARES_SOAK=1
// scales it ~8× for a real soak.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

test("soak: foldEvent retains the transcript, never the stream", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-soak-"));
  try {
    const foldBundle = path.join(tmp, "foldEvent.mjs");
    await esbuild({
      entryPoints: [path.join(here, "..", "tauri", "src", "state", "foldEvent.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: foldBundle,
      logLevel: "silent",
    });

    const scale = process.env.ARES_SOAK === "1" ? 8 : 1;
    const child = path.join(tmp, "soak-child.mjs");
    writeFileSync(
      child,
      `
import { foldEvent } from ${JSON.stringify(pathToFileURL(foldBundle).href)};

const SCALE = ${scale};
const TURNS = 40 * SCALE;
const FRAMES_PER_TURN = 25;                       // browser frames per turn
const FRAME_BYTES = 120_000;                      // ~120KB data-URI each
const SHELL_LINES_PER_TURN = 500;
const MARKER = "FRAMEPAYLOADXYZ";

// One reusable frame body (the churn in production was distinct URIs; distinct
// prefixes below defeat any string-interning luck).
const frameBody = MARKER + "A".repeat(FRAME_BYTES);

function gcNow() { global.gc(); global.gc(); }

let session = { id: "soak", items: [] };
let streamedBytes = 0;

gcNow();
const baseline = process.memoryUsage().heapUsed;

for (let t = 0; t < TURNS; t++) {
  session = foldEvent(session, { type: "turn_start", turnId: "t" + t, sessionId: "soak", userMessage: { role: "user", content: "turn " + t + " question" } });
  session = foldEvent(session, { type: "tool_start", id: "tool" + t, name: "Browser", input: {}, activityDescription: "browsing" });
  for (let f = 0; f < FRAMES_PER_TURN; f++) {
    const image = "data:image/webp;base64," + t + "_" + f + "_" + frameBody;
    streamedBytes += image.length;
    session = foldEvent(session, { type: "tool_progress", id: "tool" + t, data: { kind: "browser_frame", image } });
  }
  for (let s = 0; s < SHELL_LINES_PER_TURN; s++) {
    const line = "shell line " + s + " of turn " + t + "\\n";
    streamedBytes += line.length;
    session = foldEvent(session, { type: "tool_progress", id: "tool" + t, data: { kind: "shell_output", text: line } });
  }
  session = foldEvent(session, { type: "tool_progress", id: "x", data: { kind: "coding_backend", backend: "claude", label: "Claude Code", phase: "running", line: "log line " + t } });
  session = foldEvent(session, { type: "tool_end", id: "tool" + t, output: { ok: true }, durationMs: 5 });
  session = foldEvent(session, { type: "text_delta", text: "answer chunk for turn " + t + " " });
  session = foldEvent(session, { type: "message_done" });
  session = foldEvent(session, { type: "turn_end" });
}

const json = JSON.stringify(session);
gcNow();
const retained = process.memoryUsage().heapUsed - baseline;

const tails = [];
for (const item of session.items) {
  if (item.kind !== "tools") continue;
  for (const step of item.steps) {
    if (typeof step.liveTail === "string") tails.push(step.liveTail.split("\\n").length);
  }
}

process.stdout.write(JSON.stringify({
  turns: TURNS,
  items: session.items.length,
  streamedBytes,
  jsonBytes: json.length,
  retained,
  frameMarkers: (json.match(new RegExp(MARKER, "g")) || []).length,
  maxTailLines: Math.max(...tails, 0),
  codingLines: session.codingBackend ? session.codingBackend.lines.length : 0,
}));
`,
      "utf8",
    );

    const run = spawnSync(process.execPath, ["--expose-gc", child], {
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(run.status, 0, `soak child failed: ${run.stderr}`);
    const m = JSON.parse(run.stdout);

    // 1. ZERO frame payloads survive in the VM.
    assert.equal(m.frameMarkers, 0, "browser_frame data-URIs must never be retained in the session VM");
    // 2/3. Bounded tails.
    assert.ok(m.maxTailLines <= 201, `liveTail must stay clamped, saw ${m.maxTailLines} lines`);
    assert.ok(m.codingLines <= 6, `codingBackend.lines must stay clamped, saw ${m.codingLines}`);
    // 4. Retention scales with the transcript, not the stream. The stream is
    // ~100MB+; the VM JSON is ~1-4MB. 10× VM + 32MB slack is an order of
    // magnitude below any real retention bug.
    const bound = m.jsonBytes * 10 + 32 * 1024 * 1024;
    assert.ok(
      m.retained < bound,
      `retained ${(m.retained / 1e6).toFixed(1)}MB exceeds bound ${(bound / 1e6).toFixed(1)}MB ` +
        `(streamed ${(m.streamedBytes / 1e6).toFixed(0)}MB, VM json ${(m.jsonBytes / 1e6).toFixed(1)}MB) — a stream-retention leak`,
    );
    // Sanity: the soak actually streamed something serious.
    assert.ok(m.streamedBytes > 100 * 1024 * 1024 * (process.env.ARES_SOAK === "1" ? 8 : 1) * 0.8);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the other three fa8d30ab leak fixes are still in place (static pins)", async () => {
  const { readFileSync } = await import("node:fs");
  const appTsx = readFileSync(path.join(here, "..", "tauri", "src", "App.tsx"), "utf8");
  const mainRs = readFileSync(path.join(here, "..", "tauri", "src-tauri", "src", "main.rs"), "utf8");
  // DOM cap: only the newest window of items mounts.
  assert.match(appTsx, /const TRANSCRIPT_WINDOW = \d+/);
  assert.match(appTsx, /\.slice\(-transcriptCap\)/);
  // One persistent canvas repainted in place — no per-frame <img src=data:>.
  assert.match(appTsx, /LiveFrameCanvas/);
  // Thumbnail-first images; the full data-URL mounts only in the lightbox.
  assert.match(appTsx, /THUMB_EDGE/);
  // Rust replay buffer refuses transient browser frames.
  assert.match(mainRs, /is_transient_frame/);
  assert.match(mainRs, /browser_frame/);
});
