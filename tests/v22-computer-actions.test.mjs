// Verifies the ComputerUse action surface added for desktop recovery:
//   window  — capture only the focused window
//   windows — enumerate open top-level windows
//   launch  — (hardened) open apps by name/URI
// The PowerShell driver is Windows-only and can't run on the CI Linux box, so
// these cover the schema contract + the coordinate mapping for a window capture
// (the driver itself is verified live on Windows).

import test from "node:test";
import assert from "node:assert/strict";

import { ComputerUseTool, mapImageToVirtual } from "../packages/tools/dist/index.js";

// ── Schema accepts the new actions ────────────────────────────────────────────

test("schema: window / windows are valid actions", () => {
  for (const action of ["window", "windows", "launch", "zoom", "screenshot"]) {
    assert.equal(ComputerUseTool.inputZod.safeParse({ action }).success, true, `${action} accepted`);
  }
});

test("schema: an unknown action is rejected", () => {
  assert.equal(ComputerUseTool.inputZod.safeParse({ action: "teleport" }).success, false);
});

test("schema: windows needs no coordinates", () => {
  const parsed = ComputerUseTool.inputZod.safeParse({ action: "windows" });
  assert.equal(parsed.success, true);
});

test("guard: browser windows are rejected before ComputerUse can steal the mouse", async () => {
  const verdict = await ComputerUseTool.validateInput({ action: "activate", text: "Home / X - Google Chrome" }, {});
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /Use Browser tabs\/attach\/open/);
});

// ── Active-window capture: clicks map into the window, not the whole desktop ───

test("window capture: a click maps into the window using its own origin", () => {
  // Foreground window at (142,125), 1389x907, shown 1:1 (no downscale).
  const shot = { originX: 142, originY: 125, captureW: 1389, captureH: 907, imageW: 1389, imageH: 907 };
  assert.deepEqual(mapImageToVirtual(0, 0, shot), { x: 142, y: 125 }, "image origin = window top-left");
  assert.deepEqual(mapImageToVirtual(10, 20, shot), { x: 152, y: 145 });
  assert.deepEqual(mapImageToVirtual(1389, 907, shot), { x: 1531, y: 1032 }, "far corner = window bottom-right");
});

test("window capture: a large window downscaled past 1568 still maps exactly", () => {
  // A 2400x1500 window shown at 1568x980 (scale 2400/1568 ≈ 1.53), origin (100,50).
  const shot = { originX: 100, originY: 50, captureW: 2400, captureH: 1500, imageW: 1568, imageH: 980 };
  assert.deepEqual(mapImageToVirtual(0, 0, shot), { x: 100, y: 50 });
  assert.deepEqual(mapImageToVirtual(1568, 980, shot), { x: 2500, y: 1550 }, "maps to window's far corner in virtual coords");
});
