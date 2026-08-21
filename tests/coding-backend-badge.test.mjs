// The harness disclosure badge. Pins:
//  1. A coding_backend tool_progress event populates BOTH the live cut-scene VM
//     (codingBackend) and the sticky per-session record (lastCodingBackend).
//  2. turn_start clears the cut-scene (fresh elapsed clock) but MUST NOT clear
//     the sticky record — the footer chip is the only disclosure that an
//     external harness (Claude Code / Codex on the Ares account) touched the
//     session once the cut-scene scrolls away.
//  3. The footer actually renders a data-seg="harness" chip (static App.tsx
//     pin, same technique as daemon-command-routing).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadFoldEvent(tmp) {
  const outfile = path.join(tmp, "foldEvent.mjs");
  await esbuild({
    entryPoints: [path.join(here, "..", "tauri", "src", "state", "foldEvent.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

test("coding_backend progress sets the sticky record; turn_start keeps it", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-badge-"));
  try {
    const { foldEvent } = await loadFoldEvent(tmp);
    let session = { id: "s1", items: [] };

    session = foldEvent(session, {
      type: "tool_progress",
      id: "t1",
      data: { kind: "coding_backend", backend: "claude", label: "Claude Code", phase: "running" },
    });
    assert.equal(session.codingBackend?.backend, "claude");
    assert.equal(session.lastCodingBackend?.backend, "claude");
    assert.equal(session.lastCodingBackend?.phase, "running");

    session = foldEvent(session, {
      type: "tool_progress",
      id: "t1",
      data: { kind: "coding_backend", phase: "done" },
    });
    assert.equal(session.lastCodingBackend?.phase, "done");

    // A new turn resets the cut-scene but the disclosure survives.
    session = foldEvent(session, { type: "turn_start" });
    assert.equal(session.codingBackend, undefined);
    assert.equal(session.lastCodingBackend?.backend, "claude");
    assert.equal(session.lastCodingBackend?.phase, "done");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the footer renders the harness chip", () => {
  const appTsx = readFileSync(path.join(here, "..", "tauri", "src", "App.tsx"), "utf8");
  assert.match(appTsx, /data-seg="harness"/);
  // The chip reads the live VM first, then the sticky record.
  assert.match(appTsx, /active\?\.codingBackend \?\? active\?\.lastCodingBackend/);
});
