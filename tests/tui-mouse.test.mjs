// Unit tests for the TUI mouse engine + clickable chrome (packages/cli/src/
// mouseInput.ts + tuiChrome.ts): SGR sequence parsing, fragment swallowing,
// toolbar/modal hit-testing, number-key fallback, effort-slider math, and THE
// ULTRA SURGE frame math. Ink-free by design — plain data in, data out.
// Run: pnpm --filter @ares/cli build && node --test tests/tui-mouse.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSgrMouse,
  isMouseFragment,
  mouseTrackingSupported,
} from "../packages/cli/dist/mouseInput.js";

import {
  charWidth,
  textWidth,
  TOOLBAR_ITEMS,
  CHROME_SEPARATOR,
  CHROME_START_COL,
  toolbarButtons,
  toolbarRow,
  toolbarHitTest,
  terminalRowToAppRow,
  MODAL_TAB_ROW,
  MODAL_BODY_START_ROW,
  modalTabSpans,
  modalHitTest,
  indexForKey,
  keyForIndex,
  SLIDER_LEVELS,
  sliderIndexAt,
  sliderHandleOffset,
  sliderFillColor,
  sliderGlyph,
  sliderSpans,
  sliderFlameRow,
  SURGE_TICKS,
  SURGE_TICK_MS,
  surgeStrobeColor,
  surgeWaveRow,
  surgeFrame,
  ULTRA_BADGE,
  ultraBadgeFrame,
  parseReasoningLevel,
} from "../packages/cli/dist/tuiChrome.js";

const TOKENS = { steel: "STEEL", ember: "EMBER", crimson: "CRIMSON", gold: "GOLD", dim: "DIM" };

// ─── SGR mouse parser ─────────────────────────────────────────────────────────

test("parseSgrMouse decodes a left press with coordinates", () => {
  const events = parseSgrMouse("[<0;12;5M");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { button: 0, x: 12, y: 5, kind: "down" });
});

test("parseSgrMouse decodes a release (lowercase m)", () => {
  const events = parseSgrMouse("[<0;12;5m");
  assert.equal(events[0].kind, "up");
});

test("parseSgrMouse decodes drag (motion bit 32)", () => {
  const events = parseSgrMouse("[<32;40;9M");
  assert.equal(events[0].kind, "drag");
});

test("parseSgrMouse decodes wheel up/down (64/65) regardless of case", () => {
  assert.equal(parseSgrMouse("[<64;1;1M")[0].kind, "wheel-up");
  assert.equal(parseSgrMouse("[<65;1;1M")[0].kind, "wheel-down");
  // Wheel + shift modifier (64+4) still reads as wheel.
  assert.equal(parseSgrMouse("[<68;1;1M")[0].kind, "wheel-up");
});

test("parseSgrMouse handles ESC-stripped and bracket-stripped variants (Ink mangling)", () => {
  assert.equal(parseSgrMouse("[<0;3;4M")[0].x, 3);
  assert.equal(parseSgrMouse("<0;3;4M")[0].y, 4);
});

test("parseSgrMouse parses multiple events in one buffered chunk", () => {
  const events = parseSgrMouse("[<32;10;5M[<32;11;5M[<0;12;5m");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.kind), ["drag", "drag", "up"]);
});

test("parseSgrMouse returns null for plain text and near-misses", () => {
  assert.equal(parseSgrMouse("hello world"), null);
  assert.equal(parseSgrMouse("Array<string>"), null);
  assert.equal(parseSgrMouse(""), null);
  assert.equal(parseSgrMouse("[<;;M"), null); // digits required
});

test("isMouseFragment swallows split sequences but NOT a typed '<'", () => {
  assert.equal(isMouseFragment("[<0;12"), true);
  assert.equal(isMouseFragment("[<64;"), true);
  assert.equal(isMouseFragment("<0;12;"), true);
  assert.equal(isMouseFragment("<"), false); // lone typed angle bracket
  assert.equal(isMouseFragment("Array<T"), false);
  assert.equal(isMouseFragment("plain text"), false);
});

test("mouseTrackingSupported gates on TTY and ARES_NO_MOUSE", () => {
  assert.equal(mouseTrackingSupported({}, true), true);
  assert.equal(mouseTrackingSupported({}, false), false);
  assert.equal(mouseTrackingSupported({ ARES_NO_MOUSE: "1" }, true), false);
  assert.equal(mouseTrackingSupported({ ARES_NO_MOUSE: "true" }, true), false);
  assert.equal(mouseTrackingSupported({ ARES_NO_MOUSE: "0" }, true), true);
});

// ─── Display width ────────────────────────────────────────────────────────────

test("charWidth: emoji are 2 cells, ASCII 1, ZWJ 0", () => {
  assert.equal(charWidth("🔥".codePointAt(0)), 2);
  assert.equal(charWidth("🎨".codePointAt(0)), 2);
  assert.equal(charWidth("A".codePointAt(0)), 1);
  assert.equal(charWidth("⚔".codePointAt(0)), 1);
  assert.equal(charWidth(0x200d), 0);
});

test("textWidth sums cells across code points", () => {
  assert.equal(textWidth("abc"), 3);
  assert.equal(textWidth("🔥 Effort"), 2 + 1 + 6);
  assert.equal(textWidth(""), 0);
});

// ─── Toolbar hit-testing ──────────────────────────────────────────────────────

test("toolbarButtons lays out sequential non-overlapping spans", () => {
  const spans = toolbarButtons();
  assert.equal(spans.length, TOOLBAR_ITEMS.length);
  assert.equal(spans[0].start, CHROME_START_COL);
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].start > spans[i - 1].end, `button ${i} starts after button ${i - 1} ends`);
    // Gap equals the separator width — dead zone between buttons.
    assert.equal(spans[i].start - spans[i - 1].end - 1, textWidth(CHROME_SEPARATOR));
  }
});

test("toolbarHitTest hits each button across its full span, on the bottom row only", () => {
  const screenH = 40;
  const screenW = 120;
  for (const span of toolbarButtons()) {
    assert.equal(toolbarHitTest(span.start, screenH, screenH, screenW), span.id);
    assert.equal(toolbarHitTest(span.end, screenH, screenH, screenW), span.id);
  }
  // Wrong row → miss; separator gap → miss; off-screen → miss.
  const first = toolbarButtons()[0];
  assert.equal(toolbarHitTest(first.start, screenH - 1, screenH, screenW), null);
  assert.equal(toolbarHitTest(first.end + 1, screenH, screenH, screenW), null);
  assert.equal(toolbarHitTest(0, screenH, screenH, screenW), null);
  assert.equal(toolbarHitTest(screenW + 1, screenH, screenH, screenW), null);
});

test("toolbarRow is the frame's bottom row", () => {
  assert.equal(toolbarRow(39), 39);
});

test("terminalRowToAppRow maps a bottom-aligned frame", () => {
  // Terminal 40 rows, frame 39 tall → frame row 1 is terminal row 2.
  assert.equal(terminalRowToAppRow(2, 40, 39), 1);
  assert.equal(terminalRowToAppRow(40, 40, 39), 39);
  // Frame as tall as the terminal → identity.
  assert.equal(terminalRowToAppRow(7, 30, 30), 7);
});

// ─── Modal hit-testing ────────────────────────────────────────────────────────

const TABS = ["ollama", "openai", "anthropic"];

test("modalTabSpans mirror the rendered tab row", () => {
  const spans = modalTabSpans(TABS);
  assert.equal(spans[0].start, CHROME_START_COL);
  assert.equal(spans[0].end, CHROME_START_COL + textWidth("ollama") - 1);
  assert.equal(spans[1].start, spans[0].end + 1 + textWidth(CHROME_SEPARATOR));
});

test("modalHitTest resolves tabs on the tab row", () => {
  const spans = modalTabSpans(TABS);
  assert.deepEqual(modalHitTest(spans[1].start, MODAL_TAB_ROW, TABS, 5), { kind: "tab", index: 1 });
  assert.equal(modalHitTest(spans[2].end + 1, MODAL_TAB_ROW, TABS, 5), null); // gap after last tab
});

test("modalHitTest resolves visible item slots on body rows", () => {
  assert.deepEqual(modalHitTest(10, MODAL_BODY_START_ROW, TABS, 5), { kind: "item", index: 0 });
  assert.deepEqual(modalHitTest(10, MODAL_BODY_START_ROW + 4, TABS, 5), { kind: "item", index: 4 });
  assert.equal(modalHitTest(10, MODAL_BODY_START_ROW + 5, TABS, 5), null); // past the list
  assert.equal(modalHitTest(10, MODAL_BODY_START_ROW - 1, TABS, 5), null); // hint row
  assert.equal(modalHitTest(10, MODAL_BODY_START_ROW, TABS, 0), null); // empty list
});

// ─── Number-key fallback ──────────────────────────────────────────────────────

test("indexForKey: 1-9 then a-z, everything else null", () => {
  assert.equal(indexForKey("1"), 0);
  assert.equal(indexForKey("9"), 8);
  assert.equal(indexForKey("a"), 9);
  assert.equal(indexForKey("z"), 34);
  assert.equal(indexForKey("0"), null);
  assert.equal(indexForKey("A"), null);
  assert.equal(indexForKey("!"), null);
  assert.equal(indexForKey(""), null);
  assert.equal(indexForKey("ab"), null);
});

test("keyForIndex is the inverse of indexForKey over the covered range", () => {
  for (let i = 0; i < 35; i++) {
    assert.equal(indexForKey(keyForIndex(i)), i);
  }
  assert.equal(keyForIndex(35), null);
  assert.equal(keyForIndex(-1), null);
});

// ─── Effort slider math ───────────────────────────────────────────────────────

test("SLIDER_LEVELS matches the protocol dial order", () => {
  assert.deepEqual([...SLIDER_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("sliderIndexAt maps bar columns to nearest stop and clamps", () => {
  const start = 5;
  const width = 25; // seven stops at offsets 0,4,8,12,16,20,24
  assert.equal(sliderIndexAt(start, start, width), 0);
  assert.equal(sliderIndexAt(start + 4, start, width), 1);
  assert.equal(sliderIndexAt(start + 12, start, width), 3);
  assert.equal(sliderIndexAt(start + 24, start, width), 6);
  assert.equal(sliderIndexAt(0, start, width), 0); // left of bar → clamp
  assert.equal(sliderIndexAt(999, start, width), 6); // right of bar → clamp
});

test("sliderIndexAt and sliderHandleOffset round-trip every level", () => {
  const start = 5;
  const width = 24;
  for (let level = 0; level < SLIDER_LEVELS.length; level++) {
    const x = start + sliderHandleOffset(level, width);
    assert.equal(sliderIndexAt(x, start, width), level, `level ${level} round-trips`);
  }
});

test("slider ramp: colors go steel→ember→crimson→gold, glyphs densify", () => {
  assert.equal(sliderFillColor(0, TOKENS), "DIM");
  assert.equal(sliderFillColor(1, TOKENS), "STEEL");
  assert.equal(sliderFillColor(2, TOKENS), "STEEL");
  assert.equal(sliderFillColor(3, TOKENS), "EMBER");
  assert.equal(sliderFillColor(4, TOKENS), "CRIMSON");
  assert.equal(sliderFillColor(5, TOKENS), "GOLD");
  assert.equal(sliderFillColor(6, TOKENS), "GOLD");
  assert.equal(sliderGlyph(1), "─");
  assert.equal(sliderGlyph(2), "━");
  assert.equal(sliderGlyph(3), "▬");
  assert.equal(sliderGlyph(4), "▬");
});

test("sliderSpans always concatenate to exactly the bar width", () => {
  for (let level = 0; level < SLIDER_LEVELS.length; level++) {
    const spans = sliderSpans(level, 24, TOKENS);
    const text = spans.map((s) => s.text).join("");
    assert.equal(textWidth(text), 24, `level ${level} spans fill the bar`);
    assert.ok(text.includes("●"), "handle present");
  }
});

test("sliderSpans: level 0 parks the handle at the left, MAX at the right", () => {
  const off = sliderSpans(0, 24, TOKENS).map((s) => s.text).join("");
  const max = sliderSpans(SLIDER_LEVELS.length - 1, 24, TOKENS).map((s) => s.text).join("");
  assert.equal(off.indexOf("●"), 0);
  assert.equal(max.indexOf("●"), max.length - 1);
});

test("sliderFlameRow accumulates flames with the level and never overflows", () => {
  const width = 24;
  assert.equal(sliderFlameRow(0, width), "");
  assert.equal(sliderFlameRow(1, width), "");
  const counts = [2, 4, 6].map((lvl) => {
    const row = sliderFlameRow(lvl, width);
    assert.ok(textWidth(row) <= width, `level ${lvl} row fits`);
    return (row.match(/[ᐟ🔥]/gu) ?? []).length;
  });
  assert.ok(counts[0] < counts[1], "high has more flames than medium");
  assert.ok(counts[1] < counts[2], "MAX has the most flames");
  assert.ok(sliderFlameRow(6, width).includes("🔥"), "MAX earns real fire");
});

// ─── THE ULTRA SURGE ─────────────────────────────────────────────────────────

test("surge timing: ~1.2s of 80ms ticks", () => {
  assert.equal(SURGE_TICK_MS, 80);
  assert.ok(SURGE_TICKS * SURGE_TICK_MS >= 1100 && SURGE_TICKS * SURGE_TICK_MS <= 1400);
});

test("surgeStrobeColor cycles crimson→ember→gold", () => {
  assert.equal(surgeStrobeColor(0, TOKENS), "CRIMSON");
  assert.equal(surgeStrobeColor(1, TOKENS), "EMBER");
  assert.equal(surgeStrobeColor(2, TOKENS), "GOLD");
  assert.equal(surgeStrobeColor(3, TOKENS), "CRIMSON");
});

test("surgeWaveRow ripples: fixed width, pattern moves between ticks", () => {
  const a = surgeWaveRow(0, 30);
  const b = surgeWaveRow(1, 30);
  assert.equal([...a].length, 30);
  assert.equal([...b].length, 30);
  assert.notEqual(a, b, "the wave moves");
  for (const ch of a) assert.ok(["▁", "▂", "▃", "▅", "▇"].includes(ch));
});

test("surgeFrame: live frames strobe + jitter, then it reports done", () => {
  const live = surgeFrame(3, 30, TOKENS);
  assert.equal(live.done, false);
  assert.equal([...live.bar].length, 30);
  assert.equal([...live.above].length, 30);
  assert.equal([...live.below].length, 30);
  assert.notEqual(live.above, live.below, "counter-phase rows differ");
  assert.equal(live.color, surgeStrobeColor(3, TOKENS));
  for (let t = 0; t < SURGE_TICKS; t++) {
    const f = surgeFrame(t, 30, TOKENS);
    assert.ok([-1, 0, 1].includes(f.titleOffset), "jitter stays within ±1 col");
    assert.equal(f.done, false);
  }
  const done = surgeFrame(SURGE_TICKS, 30, TOKENS);
  assert.equal(done.done, true);
  assert.equal(done.bar, "");
  assert.equal(done.color, "GOLD", "settles on gold");
});

test("ultraBadgeFrame breathes crimson↔gold and keeps the badge text", () => {
  assert.equal(ultraBadgeFrame(0, TOKENS).color, "CRIMSON");
  assert.equal(ultraBadgeFrame(1, TOKENS).color, "GOLD");
  assert.equal(ultraBadgeFrame(2, TOKENS).color, "CRIMSON");
  assert.equal(ultraBadgeFrame(0, TOKENS).text, ULTRA_BADGE);
  assert.equal(ultraBadgeFrame(0, TOKENS).bold, true);
});

// ─── Reasoning-line parsing ──────────────────────────────────────────────────

test("parseReasoningLevel pulls the level out of the host's /reasoning line", () => {
  assert.equal(parseReasoningLevel(["Reasoning: Deep (high). Change with /reasoning <off|low|medium|high|max>."]), "high");
  assert.equal(parseReasoningLevel(["Reasoning: Off (off). …"]), "off");
  assert.equal(parseReasoningLevel(["noise", "Reasoning: Max (max)."]), "max");
  assert.equal(parseReasoningLevel(["no level here"]), null);
  assert.equal(parseReasoningLevel([]), null);
});
