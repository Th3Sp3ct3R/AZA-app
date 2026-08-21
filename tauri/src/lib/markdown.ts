// Markdown-lite renderer + rich-segment splitting (extracted from App.tsx).

import { escapeHtml } from "./format";

/** Markdown-lite renderer: fenced code, headings, lists, links, bold/italic,
 *  inline code. Escape-first, so the output is injection-safe. */
export const IMG_URL_SRC = String.raw`https?:[^\s<>"')]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s<>"')]*)?`;

export function inlineMd(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/!\[([^\]\n]*)\]\((https?:[^)\s]+)\)/g, '<span class="imgWrap"><img src="$2" alt="$1" loading="lazy" /><em>$1</em></span>')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(new RegExp(`(^|\\s)(${IMG_URL_SRC})`, "gi"), '$1<span class="imgWrap"><img src="$2" loading="lazy" /></span>');
}

/** Render a markdown table block (rows already split, header + separator + body). */
export function renderTable(rows: string[]): string {
  const cells = (line: string) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(rows[0]);
  const body = rows.slice(2).filter((r) => r.trim());
  let html = '<div class="tableWrap"><table><thead><tr>';
  for (const h of header) html += `<th>${inlineMd(h)}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of body) {
    const c = cells(row);
    html += "<tr>";
    for (let i = 0; i < header.length; i++) html += `<td>${inlineMd(c[i] ?? "")}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  return html;
}

/** Markdown → HTML for a PROSE segment (no fences). Tables, headings, lists,
 *  rules, inline. Escape-first, injection-safe. */
export function renderMarkdown(text: string): string {
  const lines = escapeHtml(text).split("\n");
  let html = "";
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      html += "</ul>";
      listOpen = false;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // table: a | row | followed by a |---|---| separator
    if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      closeList();
      const tableRows = [raw, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        tableRows.push(lines[j]);
        j++;
      }
      html += renderTable(tableRows);
      i = j - 1;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(raw)) {
      closeList();
      html += '<hr class="rule" />';
      continue;
    }
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!listOpen) {
        html += "<ul>";
        listOpen = true;
      }
      html += `<li>${inlineMd(li[1])}</li>`;
      continue;
    }
    closeList();
    if (h) {
      const level = Math.min(h[1].length + 2, 5);
      html += `<h${level}>${inlineMd(h[2])}</h${level}>`;
    } else {
      html += inlineMd(raw) + "\n";
    }
  }
  closeList();
  return html;
}

export type RichSegment =
  | { kind: "prose"; content: string }
  | { kind: "code"; lang: string; content: string }
  | { kind: "mermaid"; content: string; complete: boolean }
  | { kind: "chart"; content: string; complete: boolean };

/** Split assistant text on fenced blocks, classifying mermaid/chart/code.
 *  Handles an unterminated trailing fence (mid-stream). */
export function splitRich(text: string): RichSegment[] {
  const segments: RichSegment[] = [];
  const fence = /```(\w*)\n?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let inFence = false;
  let lang = "";
  let fenceStart = 0;
  while ((m = fence.exec(text))) {
    if (!inFence) {
      if (m.index > last) segments.push({ kind: "prose", content: text.slice(last, m.index) });
      inFence = true;
      lang = (m[1] || "").toLowerCase();
      fenceStart = fence.lastIndex;
    } else {
      const body = text.slice(fenceStart, m.index).replace(/\n$/, "");
      pushFence(segments, lang, body, true);
      inFence = false;
      last = fence.lastIndex;
    }
  }
  if (inFence) {
    // unterminated — still streaming this block
    pushFence(segments, lang, text.slice(fenceStart), false);
  } else if (last < text.length) {
    segments.push({ kind: "prose", content: text.slice(last) });
  }
  return segments;
}

export function pushFence(segments: RichSegment[], lang: string, content: string, complete: boolean): void {
  if (lang === "mermaid") segments.push({ kind: "mermaid", content, complete });
  else if (lang === "chart") segments.push({ kind: "chart", content, complete });
  else segments.push({ kind: "code", lang, content });
}
