// The "premium computer use" hardening pass — regression coverage for the
// failure modes seen live in the 2026-07-10 sessions (Discord/oCupid trial,
// X posting): zoom coordinates read as physical instead of image space,
// activate that never worked, clicks with no window accountability, and
// same-spot click loops that burned all 80 turn iterations.

import test from "node:test";
import assert from "node:assert/strict";

import { makeComputerUseTool, normalizeActionCoords } from "../packages/tools/dist/index.js";

process.env.ARES_COMPUTERUSE_SETTLE_MS = "0";

const PNG_A = Buffer.from("fake-image-A").toString("base64");
const PNG_B = Buffer.from("fake-image-B").toString("base64");

function shot(image, extra = {}) {
  return {
    ok: true,
    action: "screenshot",
    image,
    width: 100,
    height: 80,
    captureW: 200,
    captureH: 160,
    scale: 2,
    originX: 10,
    originY: 20,
    ...extra,
  };
}

function fakeRunner(script) {
  const calls = [];
  const runner = async (input, lastShot) => {
    calls.push({ input, lastShot });
    const step = typeof script[0] === "function" ? script.shift()(input) : script.shift();
    if (!step) throw new Error(`fake runner exhausted at ${input.action}`);
    return step;
  };
  runner.calls = calls;
  return runner;
}

function ctx() {
  return {
    workspace: process.cwd(),
    signal: new AbortController().signal,
    permissionMode: "bypass",
    fileReadStamps: new Map(),
  };
}

// ── zoom coordinate mapping (the "clicked something random" bug) ─────────────

test("zoom: model image-space coords map to physical pixels, w/h scale too", () => {
  // 2x downscale, origin (10,20): image (15,25) → physical (40,70).
  const s = { originX: 10, originY: 20, captureW: 200, captureH: 160, imageW: 100, imageH: 80 };
  const r = normalizeActionCoords({ action: "zoom", x: 15, y: 25, w: 50, h: 40 }, s);
  assert.equal(r.physX, 40);
  assert.equal(r.physY, 70);
  assert.equal(r.physW, 100, "width doubles at 2x scale");
  assert.equal(r.physH, 80, "height doubles at 2x scale");
});

test("zoom: internal captures marked _phys pass through unmapped", () => {
  const s = { originX: 10, originY: 20, captureW: 200, captureH: 160, imageW: 100, imageH: 80 };
  const r = normalizeActionCoords({ action: "zoom", x: 10, y: 20, w: 200, h: 160, _phys: true }, s);
  assert.equal(r.physX, 10);
  assert.equal(r.physY, 20);
  assert.equal(r.physW, 200);
  assert.equal(r.physH, 160);
});

test("click: image-space coords still map (unchanged behavior)", () => {
  const s = { originX: 10, originY: 20, captureW: 200, captureH: 160, imageW: 100, imageH: 80 };
  const r = normalizeActionCoords({ action: "click", x: 15, y: 25 }, s);
  assert.equal(r.physX, 40);
  assert.equal(r.physY, 70);
});

// ── activate: auto-capture + title feedback ───────────────────────────────────

test("activate attaches a window capture and reports the matched title", async () => {
  const runner = fakeRunner([
    { ok: true, action: "activate", title: "Lounge | DoingTeam - Discord", foreground: true, x: 100, y: 50, width: 800, height: 600 },
    { ...shot(PNG_A), action: "zoom", originX: 100, originY: 50, captureW: 800, captureH: 600 },
  ]);
  const tool = makeComputerUseTool(runner);
  const r = await tool.call({ action: "activate", text: "Discord" }, ctx());

  assert.equal(r.output.title, "Lounge | DoingTeam - Discord");
  assert.match(r.output.note, /activated "Lounge \| DoingTeam - Discord"/);
  assert.match(r.output.note, /window capture attached/);
  assert.equal(r.images.length, 1);

  // The follow-up capture is an internal physical zoom of the window rect.
  const cap = runner.calls[1];
  assert.equal(cap.input.action, "zoom");
  assert.equal(cap.input._phys, true);
  assert.equal(cap.input.x, 100);
  assert.equal(cap.input.w, 800);
});

test("activate that failed to reach foreground warns instead of lying", async () => {
  const runner = fakeRunner([
    { ok: true, action: "activate", title: "Discord", foreground: false, x: 0, y: 0, width: 400, height: 300 },
    { ...shot(PNG_A), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  const r = await tool.call({ action: "activate", text: "Discord" }, ctx());
  assert.match(r.output.note, /did NOT grant it foreground focus/);
});

test("activate capture becomes the coordinate baseline for the next click", async () => {
  const runner = fakeRunner([
    { ok: true, action: "activate", title: "App", foreground: true, x: 100, y: 50, width: 200, height: 160 },
    { ...shot(PNG_A), action: "zoom", originX: 100, originY: 50, captureW: 200, captureH: 160 },
    { ok: true, action: "click", x: 0, y: 0 },
    { ...shot(PNG_B), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "activate", text: "App" }, ctx());
  await tool.call({ action: "click", x: 10, y: 10 }, ctx());
  const clickCall = runner.calls[2];
  assert.equal(clickCall.lastShot.originX, 100, "click maps against the activate capture");
  assert.equal(clickCall.lastShot.captureW, 200);
});

// ── click accountability ──────────────────────────────────────────────────────

test("click reports the window that received it", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "click", x: 30, y: 40, focus: "Lounge | DoingTeam - Discord" },
    { ...shot(PNG_B), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r = await tool.call({ action: "click", x: 15, y: 25 }, ctx());
  assert.equal(r.output.window, "Lounge | DoingTeam - Discord");
  assert.match(r.display, /on "Lounge \| DoingTeam - Discord"/);
});

test("clicking the Ares window itself raises an unmissable warning", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "click", x: 30, y: 40, focus: "Ares" },
    { ...shot(PNG_B), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r = await tool.call({ action: "click", x: 15, y: 25 }, ctx());
  assert.match(r.output.note, /landed on the ARES window itself/);
});

// ── loop guard ────────────────────────────────────────────────────────────────

test("3 same-spot clicks with no screen change trip the dead-click loop guard", async () => {
  const script = [shot(PNG_A)];
  for (let i = 0; i < 3; i++) {
    script.push({ ok: true, action: "click", x: 30, y: 40, focus: "App" });
    script.push({ ...shot(PNG_A), action: "zoom" }); // unchanged every time
  }
  const runner = fakeRunner(script);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r1 = await tool.call({ action: "click", x: 15, y: 25 }, ctx());
  assert.doesNotMatch(r1.output.note ?? "", /LOOP GUARD/);
  const r2 = await tool.call({ action: "click", x: 16, y: 25 }, ctx());
  assert.doesNotMatch(r2.output.note ?? "", /LOOP GUARD/);
  const r3 = await tool.call({ action: "click", x: 15, y: 26 }, ctx());
  assert.match(r3.output.note, /LOOP GUARD/);
  assert.match(r3.output.note, /DEAD/);
});

test("4 same-spot clicks WITH screen changes trip the toggle loop guard", async () => {
  const pngs = [PNG_A, PNG_B];
  const script = [shot(PNG_A)];
  for (let i = 0; i < 4; i++) {
    script.push({ ok: true, action: "click", x: 30, y: 40, focus: "App" });
    script.push({ ...shot(pngs[i % 2]), action: "zoom" }); // toggles A/B — always "changed"
  }
  const runner = fakeRunner(script);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  let last;
  for (let i = 0; i < 4; i++) last = await tool.call({ action: "click", x: 15, y: 25 }, ctx());
  assert.match(last.output.note, /LOOP GUARD/);
  assert.match(last.output.note, /toggling/);
});

test("far-apart clicks never trip the loop guard", async () => {
  const script = [shot(PNG_A)];
  const spots = [[10, 10], [80, 10], [10, 70], [80, 70]];
  for (const [x, y] of spots) {
    script.push({ ok: true, action: "click", x: x * 2 + 10, y: y * 2 + 20, focus: "App" });
    script.push({ ...shot(PNG_A), action: "zoom" });
  }
  const runner = fakeRunner(script);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  for (const [x, y] of spots) {
    const r = await tool.call({ action: "click", x, y }, ctx());
    assert.doesNotMatch(r.output.note ?? "", /LOOP GUARD/);
  }
});

// ── verification uses the driver's unmarked hash when present ────────────────

test("change detection uses rawHash (marker never fakes a change)", async () => {
  const runner = fakeRunner([
    { ...shot(PNG_A), rawHash: "same" },
    { ok: true, action: "click", x: 30, y: 40, focus: "App" },
    // Marked image differs (marker drawn) but rawHash says content is identical.
    { ...shot(PNG_B), action: "zoom", rawHash: "same" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r = await tool.call({ action: "click", x: 15, y: 25 }, ctx());
  assert.equal(r.output.changed, false, "marker-only difference must not count as a screen change");
});

test("verification capture asks the driver to draw the click marker", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "click", x: 30, y: 40, focus: "App" },
    { ...shot(PNG_B), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  await tool.call({ action: "click", x: 15, y: 25 }, ctx());
  const verify = runner.calls[2];
  assert.equal(verify.input.markX, 30, "marker at the physical click point");
  assert.equal(verify.input.markY, 40);
  assert.equal(verify.input._phys, true, "verification zoom is a physical-space capture");
});

test("target focus handshake re-activates and verifies the window immediately before a click", async () => {
  const runner = fakeRunner([
    { ok: true, action: "activate", title: "Target App", foreground: true },
    { ok: true, action: "click", x: 30, y: 40, focus: "Target App" },
    shot(PNG_B),
  ]);
  const tool = makeComputerUseTool(runner);
  const result = await tool.call({ action: "click", target: "Target App", x: 30, y: 40 }, ctx());
  assert.equal(runner.calls[0].input.action, "activate");
  assert.equal(runner.calls[1].input.action, "click");
  assert.equal(result.output.window, "Target App");
});

test("act batches desktop/UIA steps behind one focus contract and one final capture", async () => {
  const runner = fakeRunner([
    { ok: true, action: "activate", title: "Settings", foreground: true },
    { ok: true, action: "uia_fill", observed: "filled Edit 'Search'", focus: "Settings" },
    { ok: true, action: "activate", title: "Settings", foreground: true },
    { ok: true, action: "uia_click", observed: "invoked Button 'Apply'", focus: "Settings" },
    { ...shot(PNG_B), action: "window" },
  ]);
  const tool = makeComputerUseTool(runner);
  const result = await tool.call({
    action: "act",
    target: "Settings",
    steps: [
      { action: "uia_fill", name: "Search", role: "Edit", value: "privacy" },
      { action: "uia_click", name: "Apply", role: "Button" },
    ],
  }, ctx());
  assert.deepEqual(runner.calls.map((c) => c.input.action), ["activate", "uia_fill", "activate", "uia_click", "window"]);
  assert.equal(result.output.completed.length, 2);
  assert.equal(result.output.verified, true);
  assert.equal(result.images.length, 1);
});

test("uia_tree returns named controls for selector-first native operation", async () => {
  const runner = fakeRunner([{
    ok: true,
    action: "uia_tree",
    elements: [{ name: "Save", role: "Button", automationId: "save", enabled: true }],
  }]);
  const tool = makeComputerUseTool(runner);
  const result = await tool.call({ action: "uia_tree" }, ctx());
  assert.equal(result.output.elements[0].name, "Save");
  assert.match(result.output.note, /prefer uia_click\/uia_fill/);
});
