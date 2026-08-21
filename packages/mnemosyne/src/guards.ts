// Guard compilation — the teeth. A binding whose text is a clear imperative
// ("never run git clean", "always ask before pushing") compiles into a
// machine-checkable guard the policy gate can enforce BELOW the model. This is
// the structural fix for "wrote it to memory, then did it anyway": the model's
// goodwill stops being the only enforcement layer.
//
// Deliberately conservative: only confidently-parseable imperatives compile.
// Everything else stays prompt-tier (the binding still rides the system prompt;
// it just has no mechanical guard). A wrong guard is worse than no guard.

export type GuardEffect = "deny" | "confirm" | "warn";

export interface CompiledGuard {
  effect: GuardEffect;
  /**
   * Lowercase keywords that must ALL appear in a candidate action's text
   * (command line, tool summary) for the guard to trip. Conjunction, not regex —
   * boring on purpose: predictable matching beats clever matching in a guard.
   */
  match: string[];
  /** Human explanation — always cites the binding's own words. */
  reason: string;
}

export interface GuardVerdict {
  guard: CompiledGuard;
  tripped: boolean;
}

/** Words too generic to anchor a guard on their own. */
const STOPWORDS = new Set([
  "the", "a", "an", "any", "my", "your", "our", "this", "that", "it", "them",
  "to", "of", "in", "on", "at", "for", "with", "without", "from", "into",
  "and", "or", "ever", "again", "me", "first", "always", "never", "please",
  "you", "must", "should", "shall", "will", "be", "is", "are", "do", "doing",
  "not", "don't", "dont", "run", "running", "use", "using", "execute", "executing",
  "here", "there", "anywhere", "everywhere", "immediately", "under", "over",
]);

/**
 * Light stem so a rule's verb form matches the action's ("pushing" must trip on
 * "git push"). Anchors are matched as SUBSTRINGS, so a stem is safe: "delet"
 * hits delete/deleted/deleting alike.
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && (w.endsWith("ed") || w.endsWith("es"))) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
  // Gerund doubling: tagging → tagg → tag.
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) w = w.slice(0, -1);
  return w;
}

/**
 * Extract the match keywords from an action phrase. Backtick-quoted spans are
 * taken VERBATIM and EXCLUSIVELY (the owner quoting `git clean` means that
 * exact string — surrounding prose must not narrow the guard); otherwise
 * salient stemmed words minus stopwords.
 */
function extractAnchors(phrase: string): string[] {
  const quoted = [...phrase.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim().toLowerCase()).filter(Boolean);
  if (quoted.length > 0) return [...new Set(quoted)];
  const anchors: string[] = [];
  for (const raw of phrase.toLowerCase().split(/[^a-z0-9._\/-]+/)) {
    const word = raw.trim();
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    anchors.push(stem(word));
  }
  return [...new Set(anchors)];
}

interface Pattern {
  re: RegExp;
  effect: GuardEffect;
}

// Order matters: first match wins. "never/do not X" is a hard deny; "ask
// before X" requires confirmation; "always X" alone is only advisably
// checkable, so it compiles to a warn.
const PATTERNS: Pattern[] = [
  { re: /^(?:never|do\s+not|don'?t)\s+(?:ever\s+)?(.+)$/i, effect: "deny" },
  { re: /^(?:always\s+)?(?:ask|check\s+with\s+me|confirm(?:\s+with\s+me)?)\s+(?:me\s+)?(?:first\s+)?before\s+(.+)$/i, effect: "confirm" },
  { re: /^(?:always|make\s+sure\s+(?:to|you))\s+(.+)$/i, effect: "warn" },
];

/**
 * Compile one binding's text into a guard, or null when it isn't a confidently
 * parseable imperative. Null is the COMMON case and is fine — the binding still
 * binds at prompt tier.
 */
export function compileGuard(text: string): CompiledGuard | null {
  const line = text.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!line) return null;
  for (const { re, effect } of PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    const anchors = extractAnchors(m[1]);
    // No anchors, or only one weak word => the guard would trip on noise. Refuse.
    if (anchors.length === 0) return null;
    return { effect, match: anchors, reason: `bound by: "${text.trim()}"` };
  }
  return null;
}

/**
 * Evaluate an action's text (a shell command line, a tool-call summary) against
 * a set of guards. A guard trips when EVERY anchor appears in the action text.
 */
export function evaluateGuards(guards: readonly CompiledGuard[], actionText: string): GuardVerdict[] {
  const haystack = actionText.toLowerCase();
  return guards.map((guard) => ({
    guard,
    tripped: guard.match.every((anchor) => haystack.includes(anchor)),
  }));
}

/** The strongest tripped effect, or null when nothing tripped. deny > confirm > warn. */
export function strongestVerdict(verdicts: readonly GuardVerdict[]): GuardVerdict | null {
  const rank: Record<GuardEffect, number> = { deny: 3, confirm: 2, warn: 1 };
  let best: GuardVerdict | null = null;
  for (const v of verdicts) {
    if (!v.tripped) continue;
    if (!best || rank[v.guard.effect] > rank[best.guard.effect]) best = v;
  }
  return best;
}
