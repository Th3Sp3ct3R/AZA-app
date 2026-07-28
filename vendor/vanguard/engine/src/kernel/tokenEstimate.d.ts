/**
 * Cheap, deterministic token estimation for context budgeting.
 *
 * Providers bill and truncate by tokens while the kernel budgets bytes, and
 * bytes-per-token swings roughly 2.5-5x between dense code and prose. This
 * estimator does not try to match any one tokenizer; it tracks the *shape*
 * of tokenization — identifiers cost about a token per few characters,
 * punctuation costs about a token each — so token-dense content is seen as
 * expensive before the provider window overflows on it.
 */
export declare function estimateTokens(text: string): number;
/**
 * The token ceiling a byte budget implies. 2.5 bytes/token is the dense end
 * of real content: ordinary prose and JSON structure sit comfortably under
 * this ceiling, while pathologically token-dense content (minified code,
 * symbol soup) trims earlier instead of overflowing the provider window.
 */
export declare function tokenCeilingForBytes(maxBytes: number): number;
/**
 * Budget-check variant with bounded cost: exact under 64KB, deterministic
 * head-sample extrapolation above. Context selection calls this several
 * times per step over multi-megabyte transcripts; an exact walk there turned
 * a second of budgeting into minutes. Density is what matters for the
 * ceiling, and density is well estimated from a 64KB prefix.
 */
export declare function estimateTokensFast(text: string): number;
