// Stream-speech chunking: split streaming assistant text into speakable phrases
// (extracted from App.tsx).

export const STREAM_SPEECH_SENTENCE_MIN = 16;
export const STREAM_SPEECH_RELAXED_MIN = 72;
export const STREAM_SPEECH_HARD_MAX = 180;
// After the FIRST spoken chunk (which fires small so speech starts fast), batch
// subsequent chunks into larger spans. Each provider (Piper/API) synth is a
// round-trip with real per-call overhead, so 3 sentences in one call ≈ 1/3 the
// latency of one call each — the biggest lever on "it's delayed".
export const STREAM_SPEECH_BATCH_MIN = 150;

export function codeBlockSummary(body: string, lang: string): string {
  const lines = body.split(/\r?\n/).filter((line) => line.trim()).length;
  const label = lang ? `${lang} code block` : "code block";
  return ` (${label}, ${lines} line${lines === 1 ? "" : "s"}) `;
}

export function normalizeCompletedSpeechFences(raw: string, force = false): string {
  let out = "";
  let pos = 0;
  while (pos < raw.length) {
    const start = raw.indexOf("```", pos);
    if (start < 0) {
      out += raw.slice(pos);
      break;
    }
    out += raw.slice(pos, start);
    const headerStart = start + 3;
    const newline = raw.indexOf("\n", headerStart);
    const close = raw.indexOf("```", headerStart);
    const hasHeaderLine = newline >= 0 && (close < 0 || newline < close);
    const headerEnd = hasHeaderLine ? newline : headerStart;
    const bodyStart = hasHeaderLine ? newline + 1 : headerStart;
    const lang = raw.slice(headerStart, headerEnd).trim().split(/\s+/)[0] ?? "";
    if (close < 0) {
      if (force) out += codeBlockSummary(raw.slice(bodyStart), lang);
      else out += raw.slice(start);
      break;
    }
    out += codeBlockSummary(raw.slice(bodyStart, close), lang);
    pos = close + 3;
  }
  return out;
}

export function firstUnclosedFence(raw: string): number {
  let pos = 0;
  while (pos < raw.length) {
    const start = raw.indexOf("```", pos);
    if (start < 0) return -1;
    const close = raw.indexOf("```", start + 3);
    if (close < 0) return start;
    pos = close + 3;
  }
  return -1;
}

export function boundaryAfter(text: string, min: number): number {
  const sentence = /[.!?…]["')\]]?\s+/g;
  for (let match = sentence.exec(text); match; match = sentence.exec(text)) {
    const end = match.index + match[0].length;
    if (end >= min) return end;
  }
  const paragraph = /\n{2,}/g;
  for (let match = paragraph.exec(text); match; match = paragraph.exec(text)) {
    const end = match.index + match[0].length;
    if (end >= min) return end;
  }
  return 0;
}

export function relaxedBoundary(text: string): number {
  if (text.length < STREAM_SPEECH_RELAXED_MIN) return 0;
  const phrase = /[,;:]\s+/g;
  for (let match = phrase.exec(text); match; match = phrase.exec(text)) {
    const end = match.index + match[0].length;
    if (end >= STREAM_SPEECH_RELAXED_MIN) return end;
  }
  const target = Math.min(text.length, STREAM_SPEECH_HARD_MAX);
  const beforeTarget = text.slice(0, target).search(/\s+\S*$/);
  if (beforeTarget >= STREAM_SPEECH_RELAXED_MIN) return beforeTarget;
  const afterMin = text.slice(STREAM_SPEECH_RELAXED_MIN).search(/\s/);
  return afterMin >= 0 ? STREAM_SPEECH_RELAXED_MIN + afterMin + 1 : 0;
}

export function takeStreamSpeechChunk(raw: string, force = false, relaxed = false, min = STREAM_SPEECH_SENTENCE_MIN): { chunk: string; rest: string } {
  const normalized = normalizeCompletedSpeechFences(raw, force);
  const fenceAt = firstUnclosedFence(normalized);
  const held = fenceAt >= 0 ? normalized.slice(fenceAt) : "";
  const speakable = fenceAt >= 0 ? normalized.slice(0, fenceAt) : normalized;
  if (force) return { chunk: speakable.trim(), rest: held };
  const boundary = boundaryAfter(speakable, min) || (relaxed ? relaxedBoundary(speakable) : 0);
  if (!boundary) return { chunk: "", rest: normalized };
  return { chunk: speakable.slice(0, boundary).trim(), rest: speakable.slice(boundary) + held };
}
