// Bug-report upload sizing.
//
// The reported failure: "when the session is too big they can't upload chat
// history". The old code capped the UNCOMPRESSED transcript at 28MB and assumed
// gzip's ~10x would put it under the gateway's ~4.5MB body limit. Coding
// transcripts are diffs, base64 fragments and stack traces — closer to 5x — so
// a big session gzipped to well over the limit and got a flat 413 with no
// recovery path. The sessions most worth reporting were the ones that couldn't
// be.
//
// The property that matters: the size that gets CHECKED is the size that gets
// SENT, and a body that doesn't fit sheds old events rather than failing.

import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { buildReportBody, trimRolloutForReport, REPORT_WIRE_LIMIT } from "../packages/cli/dist/entry/daemon/report.js";

/** Events that compress poorly, like the real thing. Deterministic, so a
 *  failure is reproducible rather than "sometimes over the limit". */
function bulkyEvents(count, bytesEach) {
  // xorshift32 via Math.imul — exact 32-bit arithmetic. A plain `seed * bigConst`
  // LCG silently loses precision past 2^53 and degenerates into a near-constant
  // stream, which gzip then crushes to nothing; the fixture has to be genuinely
  // incompressible or it isn't testing the case that fails in the field.
  let seed = 0x9e3779b9;
  const next = () => {
    seed ^= seed << 13;
    seed = Math.imul(seed, 1) | 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed = seed | 0;
    return seed >>> 0;
  };
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/";
  return Array.from({ length: count }, (_, i) => {
    const chars = new Array(bytesEach);
    for (let n = 0; n < bytesEach; n++) chars[n] = alphabet[next() % alphabet.length];
    return { ts: i, seq: i, event: { type: "tool_result", text: chars.join("") } };
  });
}

function payloadWith(events) {
  return {
    session_id: "sess_test",
    note: "it broke",
    transcript: { meta: { provider: { model: "test" } }, events },
  };
}

test("a normal report goes out whole", () => {
  const events = bulkyEvents(20, 500);
  const { body, droppedEvents, bytes } = buildReportBody(payloadWith(events));
  assert.equal(droppedEvents, 0);
  assert.ok(bytes < REPORT_WIRE_LIMIT);
  const sent = JSON.parse(gunzipSync(body).toString("utf8"));
  assert.equal(sent.transcript.events.length, 20);
  assert.equal(sent.truncated, undefined, "an untrimmed report must not claim to be partial");
});

test("an incompressible transcript is shed down until it actually fits the wire", () => {
  // ~30MB of high-entropy text: past the old uncompressed cap AND past the
  // wire limit once gzipped, which is precisely the case that used to 413.
  const events = bulkyEvents(600, 50_000);
  const raw = JSON.stringify(payloadWith(events)).length;
  assert.ok(raw > 25 * 1024 * 1024, `test fixture too small: ${raw} bytes`);

  const { body, droppedEvents, bytes } = buildReportBody(payloadWith(events));
  assert.ok(bytes <= REPORT_WIRE_LIMIT, `body is ${bytes} bytes, over the ${REPORT_WIRE_LIMIT} limit`);
  assert.ok(droppedEvents > 0, "an oversized report must report what it dropped");

  const sent = JSON.parse(gunzipSync(body).toString("utf8"));
  assert.equal(sent.truncated, true);
  assert.equal(sent.dropped_events, droppedEvents);
  // The tail is what diagnoses the failure, so the tail is what survives.
  const kept = sent.transcript.events.filter((e) => e.event?.type !== "report_note");
  assert.equal(kept.at(-1).seq, events.at(-1).seq, "the newest event must always survive");
  assert.equal(sent.transcript.events[0].event.type, "report_note");
});

test("the note names the real number of dropped events", () => {
  const events = bulkyEvents(600, 50_000);
  const { body, droppedEvents } = buildReportBody(payloadWith(events));
  const sent = JSON.parse(gunzipSync(body).toString("utf8"));
  const kept = sent.transcript.events.filter((e) => e.event?.type !== "report_note").length;
  assert.equal(kept + droppedEvents, events.length, "dropped + kept must account for every event");
  const note = sent.transcript.events[0].event.text;
  assert.ok(note.includes(`${droppedEvents} earlier events`), `note read: ${note}`);
});

test("a payload with no transcript still produces a body", () => {
  const { body, droppedEvents } = buildReportBody({ session_id: "x", note: "y" });
  assert.equal(droppedEvents, 0);
  assert.deepEqual(JSON.parse(gunzipSync(body).toString("utf8")), { session_id: "x", note: "y" });
});

test("trimRolloutForReport still truncates individual monster strings", () => {
  const huge = "x".repeat(600 * 1024);
  const [out] = trimRolloutForReport([{ event: { text: huge } }]);
  assert.ok(out.event.text.length < huge.length);
  assert.match(out.event.text, /\[trimmed \d+ chars\]/);
});

test("a failed upload degrades to a local file the tester can attach", async () => {
  const { saveReportLocally } = await import("../packages/cli/dist/entry/daemon/report.js");
  const { mkdtempSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const payload = payloadWith(bulkyEvents(5, 200));

  // Desktop route: the visible, attachable place.
  const desktop = mkdtempSync(path.join(os.tmpdir(), "ares-report-desk-"));
  const onDesk = await saveReportLocally(payload, "sess_abcdefghij123456789", "unused-ws", desktop);
  assert.ok(onDesk.startsWith(desktop), `saved to the desktop dir, got ${onDesk}`);
  assert.match(path.basename(onDesk), /^ares-bug-report-sess_abcdefghij123-.*\.json\.gz$/);
  const roundTrip = JSON.parse(gunzipSync(await readFile(onDesk)).toString("utf8"));
  assert.equal(roundTrip.session_id, payload.session_id, "the file is the actual report payload");

  // No desktop: falls back into the workspace where nothing else could fail.
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-report-ws-"));
  const fallback = await saveReportLocally(payload, "sess_x", ws, path.join(ws, "no-such-desktop"));
  assert.ok(fallback.startsWith(path.join(ws, ".ares", "bug-reports")), `fell back to workspace, got ${fallback}`);
});
