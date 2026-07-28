/**
 * Detection of degenerate model output in workspace mutations.
 *
 * A degenerating decoder repeats itself. The observed failure signatures are
 * a single non-trivial line emitted over and over ("// I'm a front-end
 * developer" ×N), a short cycle of lines alternated indefinitely (A/B/A/B…),
 * and a dominant line re-emitted with token-level jitter breaking up the
 * runs. The kernel's circuit breaker catches identical *tool calls*, and the
 * stagnation guard catches unchanged *observations* — neither inspects the
 * bytes a mutation is about to write. This rung does: it rejects a write
 * whose content shows a repetition signature before the mutation lands on
 * disk, turning a silent spiral into structured feedback the model must act
 * on.
 *
 * Repetition that already exists in the file being rewritten is never blamed
 * on the new mutation, and a genuinely repetitive deliverable can be written
 * deliberately via the tools' `allowRepetition` flag — the point is that
 * unintentional degeneration never sets a flag.
 */
export interface DegenerateRepetition {
    /** The trimmed line that repeats (for cycles, the block's first significant line). */
    readonly line: string;
    /** Repetitions: run length, cycle repetitions, or scattered occurrences. */
    readonly count: number;
    /** 1-based line number where the repetition starts in the new content. */
    readonly startLine: number;
    readonly kind: "run" | "cycle" | "scattered";
}
/** Consecutive identical significant lines at or beyond this count are degenerate. */
export declare const DEGENERATE_RUN_THRESHOLD = 5;
/** A 2-4 line block repeated consecutively at least this many times is a spiral. */
export declare const DEGENERATE_CYCLE_THRESHOLD = 8;
/**
 * Returns the worst degenerate repetition in `content`, or undefined when the
 * content is clean. Three signatures are checked: consecutive identical
 * lines, short repeated line cycles, and one line dominating its span with
 * small interruptions. A line only counts when it is long enough to be
 * meaningful and contains letters or digits, so structural repetition (blank
 * lines, braces, `# ----` rules) never trips the guard. Lines whose
 * repetition already trips the same detectors in `prior` are treated as
 * pre-existing and ignored.
 */
export declare function detectDegenerateRepetition(content: string, prior?: string): DegenerateRepetition | undefined;
/** Renders the guard's rejection as actionable model feedback. */
export declare function degenerateRepetitionError(found: DegenerateRepetition): string;
