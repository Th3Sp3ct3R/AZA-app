// Bug-report rollout trimming and wire-fitting for the daemon's bug_report
// command.
//
// Two different limits are in play and conflating them is what broke this:
//
//   MAX_TOTAL       — a sanity cap on the UNCOMPRESSED transcript, so a
//                     pathological session doesn't cost gigabytes of RAM to
//                     serialize.
//   REPORT_WIRE_LIMIT — the only limit that actually decides success. The Ares
//                     Gateway runs on Vercel, whose serverless functions reject
//                     any request body over ~4.5MB with a flat 413 ("Request
//                     Entity Too Large"). That check is on the COMPRESSED bytes,
//                     because that is what goes on the wire.
//
// The old code capped only the uncompressed size and then assumed "gzip shrinks
// text ~10x so it fits". For prose that holds. For a coding transcript — which
// is mostly high-entropy diffs, base64 fragments, minified output and stack
// traces — the real ratio is closer to 5x, so a 28MB transcript could gzip to
// well over 4.5MB and 413 with no recovery path at all. That is the "my session
// is too big, I can't upload my chat history" report: the bigger the session,
// the more worth reporting it is, and the more certain the upload was to fail.
//
// So the size that is checked here is the size that is actually sent, and when
// it doesn't fit we drop OLD events until it does rather than failing.

import { gzipSync } from "node:zlib";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Compressed request-body ceiling. 4MB against the platform's ~4.5MB, so the
 *  headers and the gateway's own framing can't push a "just fits" body over. */
export const REPORT_WIRE_LIMIT = 4 * 1024 * 1024;

/** Uncompressed sanity cap — see the header note. */
const MAX_TOTAL = 28 * 1024 * 1024;

/** Cap a bug-report rollout so even an extreme session stays serializable.
 *  Deep-clones while truncating any single string over ~256KB (base64 images,
 *  huge tool outputs), then, if the whole thing is still over the budget, keeps
 *  the MOST RECENT events (where the failure being reported usually is) and
 *  notes how many were dropped. */
export function trimRolloutForReport(entries: unknown[], maxTotal = MAX_TOTAL): unknown[] {
  const MAX_STRING = 256 * 1024;
  const truncateStrings = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[trimmed ${value.length - MAX_STRING} chars]` : value;
    }
    if (Array.isArray(value)) return value.map(truncateStrings);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = truncateStrings(v);
      return out;
    }
    return value;
  };
  const trimmed = entries.map(truncateStrings);
  if (JSON.stringify(trimmed).length <= maxTotal) return trimmed;
  return keepTail(trimmed, maxTotal);
}

/** Keep the newest events that fit `budget` serialized bytes, with a note in
 *  place of what was dropped. Recent events are kept because the failure being
 *  reported is almost always at the end. */
function keepTail(entries: unknown[], budget: number): unknown[] {
  const kept: unknown[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const len = JSON.stringify(entries[i]).length + 1;
    if (size + len > budget) break;
    kept.unshift(entries[i]);
    size += len;
  }
  const dropped = entries.length - kept.length;
  if (dropped > 0) kept.unshift(droppedNote(dropped));
  return kept;
}

function droppedNote(dropped: number): unknown {
  return { ts: null, seq: -1, event: { type: "report_note", text: `[${dropped} earlier events omitted to fit the size limit]` } };
}

/**
 * Save a bug-report payload to disk when the gateway can't take it (no Ares
 * account connected, network down, upload rejected). A field tester whose
 * report upload fails is EXACTLY the person whose report matters — "can't send
 * it as a bug report" must degrade to "here's the file, attach it in Discord",
 * never to nothing (field report, 2026-08-06). Desktop first (visible,
 * attachable), workspace .ares/bug-reports as fallback. Gzipped: these run to
 * tens of MB raw and chat apps cap attachments.
 */
export async function saveReportLocally(
  payload: Record<string, unknown>,
  sessionId: string,
  workspace: string,
  desktopDir?: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `ares-bug-report-${sessionId.slice(0, 18)}-${stamp}.json.gz`;
  const desktop = desktopDir ?? join(homedir(), "Desktop");
  const onDesktop = await stat(desktop).then((s) => s.isDirectory()).catch(() => false);
  const dir = onDesktop ? desktop : join(workspace, ".ares", "bug-reports");
  if (!onDesktop) await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, gzipSync(Buffer.from(JSON.stringify(payload), "utf8")));
  return file;
}

/** How many real events a payload carries, ignoring any note we prepended. */
function eventsOf(payload: Record<string, unknown>): unknown[] | null {
  const transcript = payload.transcript as { events?: unknown } | undefined;
  return Array.isArray(transcript?.events) ? (transcript.events as unknown[]) : null;
}

/**
 * Gzip a report payload down to something the gateway will actually accept.
 *
 * Measures the COMPRESSED body — the only number the platform cares about — and,
 * while it is over the limit, keeps halving the retained event tail and
 * re-compressing. Always returns a body: a report with the last handful of
 * events still diagnoses the failure, whereas a 413 diagnoses nothing.
 *
 * `attempts` is bounded rather than looping to convergence because gzip is not
 * monotonic in a way we can predict, and a report is not worth an unbounded
 * compress loop on a huge transcript.
 */
export function buildReportBody(
  payload: Record<string, unknown>,
  limit = REPORT_WIRE_LIMIT,
): { body: Uint8Array; droppedEvents: number; bytes: number } {
  let events = eventsOf(payload);
  let current = payload;
  let droppedEvents = 0;
  // Uint8Array, not Buffer: this goes straight into fetch's BodyInit.
  let body: Uint8Array = gzipSync(Buffer.from(JSON.stringify(current), "utf8"));

  for (let attempt = 0; body.length > limit && events && events.length > 1 && attempt < 12; attempt++) {
    // Halve toward the tail. Overshooting is fine and undershooting is not: a
    // body that still 413s is worth nothing, a smaller one is worth most of it.
    const keep = Math.max(1, Math.floor(events.length / 2));
    const tail = events.slice(events.length - keep);
    droppedEvents = (eventsOf(payload)?.length ?? 0) - keep;
    const note = droppedNote(droppedEvents);
    current = {
      ...payload,
      transcript: { ...(payload.transcript as object), events: [note, ...tail] },
      // Tell the reader this is partial, in the payload itself — a truncated
      // transcript that doesn't say it's truncated reads as a complete one.
      truncated: true,
      dropped_events: droppedEvents,
    };
    events = tail;
    body = gzipSync(Buffer.from(JSON.stringify(current), "utf8"));
  }

  return { body, droppedEvents, bytes: body.length };
}
