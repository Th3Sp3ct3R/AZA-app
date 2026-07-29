// Bug-report rollout trimming for the daemon's bug_report command.

/** Cap a bug-report rollout so even an extreme session gzips under the gateway's
 *  request-body limit. Deep-clones while truncating any single string over
 *  ~256KB (base64 images, huge tool outputs), then, if the whole thing is still
 *  over ~28MB serialized, keeps the MOST RECENT events (where the failure being
 *  reported usually is) and notes how many were dropped. */
export function trimRolloutForReport(entries: unknown[]): unknown[] {
  const MAX_STRING = 256 * 1024;
  const MAX_TOTAL = 28 * 1024 * 1024;
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
  if (JSON.stringify(trimmed).length <= MAX_TOTAL) return trimmed;
  // Still too big: keep the tail (recent events) that fits the budget.
  const kept: unknown[] = [];
  let size = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const len = JSON.stringify(trimmed[i]).length + 1;
    if (size + len > MAX_TOTAL) break;
    kept.unshift(trimmed[i]);
    size += len;
  }
  const dropped = trimmed.length - kept.length;
  if (dropped > 0) {
    kept.unshift({ ts: null, seq: -1, event: { type: "report_note", text: `[${dropped} earlier events omitted to fit the size limit]` } });
  }
  return kept;
}
