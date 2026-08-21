// Operational-noise gate for the memory write spine.
//
// A field user's MEMORY.md was 24 "Tool error observed:" entries against 5
// real memories — 83% garbage — because nothing in the write spine ever asked
// "is this content a harness failure rather than knowledge?" before storing
// it. Tool errors, provider errors and stack traces are FRICTION signal (the
// telemetry files own that), never durable memory: remembering them verbatim
// buries the real memories and teaches recall to surface noise.
//
// The patterns here are OPERATIONAL SIGNATURES (error codes, stack frames,
// harness prefixes) — deliberately not semantic failure words. "X breaks when
// Y" is a legitimate belief the agent should keep; "ENOENT: no such file or
// directory" is not.
const NOISE_SIGNATURES: RegExp[] = [
  /<tool_use_error>/i,
  /\btool error observed\b/i,
  // Raw errno codes are uppercase on the wire; lowercase "enoent" in prose is
  // someone TALKING about an error, which a belief may legitimately do.
  /\bE(NOENT|CONNRESET|CONNREFUSED|TIMEDOUT|ACCES|PERM|PIPE|MFILE|ADDRINUSE|AI_AGAIN)\b/,
  /\bat .*[\\/(].*:\d+:\d+/, // stack frames: "at foo (src/x.ts:12:5)"
  /\bHTTP\/?\s?[45]\d\d\b|\bstatus(?: code)? [45]\d\d\b/i,
  /\brate.?limited\b/i,
  /\b(exit code [1-9]\d*|command failed with|non-zero exit)\b/i,
  /\bprovider (error|stalled|overloaded)\b/i,
  /\bno stream events for\b/i,
  /\b(request|response|stream) timed out\b/i,
  /\btool_use_id\b/,
];

/** True when `content` reads as harness/tool/provider failure output rather
 *  than knowledge worth keeping. Applied by the memory router on every
 *  channel, by dream promotion (which re-reads legacy stores that cannot
 *  delete), and by living-memory consolidation (which durably prunes noise
 *  already stored before this gate existed). */
export function isOperationalNoise(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  return NOISE_SIGNATURES.some((re) => re.test(text));
}
