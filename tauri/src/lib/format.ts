// Small formatting utilities (extracted from App.tsx).

export function compact(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Rolling tail for live streaming previews: the NEWEST text, whitespace
 *  flattened to one line and snapped to a word boundary with a leading
 *  ellipsis. A raw slice(-n) starts mid-word at an arbitrary cut ("e.") and
 *  keeps stream newlines, so a line-clamped preview shows stale fragments
 *  instead of what's being written right now. */
export function liveTail(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= max) return flat;
  let tail = flat.slice(-max);
  const firstSpace = tail.indexOf(" ");
  if (firstSpace > 0 && firstSpace < 40) tail = tail.slice(firstSpace + 1);
  return `…${tail}`;
}

/** Pull a file_path (or path/url) out of PARTIAL tool-input JSON while the
 *  model is still authoring it — so a streaming Write names its target file
 *  long before the input is complete. Returns a short basename-ish label. */
export function draftTargetPath(partialJson: string): string {
  const m = /"(?:file_path|path|notebook_path|url)"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(partialJson);
  if (!m) return "";
  let raw = m[1];
  try {
    raw = JSON.parse(`"${raw}"`) as string;
  } catch {
    /* partial escape at the cut point — use as-is */
  }
  const parts = raw.split(/[\\/]/).filter(Boolean);
  const short = parts.length > 2 ? parts.slice(-2).join("/") : raw;
  return short.length > 48 ? `…${short.slice(-48)}` : short;
}

export function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 1) ?? String(v);
  } catch {
    return String(v);
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Total estimated spend across providers with known pricing; "—" if nothing priced. */
export function fmtSpend(usage: { providers?: Array<{ costUsd?: number }> }): string {
  const known = (usage.providers ?? []).filter((p) => p.costUsd !== undefined);
  if (known.length === 0) return "—";
  return `≈$${known.reduce((total, p) => total + (p.costUsd ?? 0), 0).toFixed(2)}`;
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function fmtBytes(n?: number | null): string {
  if (!n) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${n} B`;
}

export const escapeHtml = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Base64 payload of a data URL (the part that actually crosses the wire).
export function dataUrlB64Len(dataUrl: string): number {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.length - i - 1 : dataUrl.length;
}

/** Pull data:image URLs out of a message string so the transcript shows the
 *  IMAGE, not a giant truncated base64 blob (which read as a "random directory").
 *  Used for history replay; the live send path passes images out of band. */
export function splitDataImages(raw: string): { text: string; images: string[] } {
  const images: string[] = [];
  const text = raw
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, (m) => { images.push(m); return ""; })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, images };
}
