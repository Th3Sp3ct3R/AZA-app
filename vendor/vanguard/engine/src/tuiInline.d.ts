/**
 * Inline terminal renderer: an append-only transcript in the terminal's own
 * scrollback buffer plus a two-row live footer (status + composer) pinned to
 * the bottom of the output.
 *
 * Why not the alternate screen: `\x1b[?1049h` gives a clean grid but takes
 * away the terminal's scrollback — every message older than one screen is
 * unreachable, which users read as "messages disappear". Printing inline
 * keeps the whole session scrollable, copyable, and survives truncation of
 * any single frame.
 *
 * Invariant: after every operation the footer is the last thing on screen and
 * the cursor sits on the last footer row. Every write therefore follows the
 * same shape — erase the footer rows (relative cursor moves only, so user
 * scrollback is never disturbed), append content, repaint the footer — and is
 * issued as ONE batched write so rapid token streams cannot tear the frame.
 */
export interface InlineOutput {
    write(text: string): unknown;
}
export declare class InlineRenderer {
    #private;
    constructor(out: InlineOutput, width: () => number);
    get streamOpen(): boolean;
    /** Append transcript lines above the live region. Lines may wrap naturally. */
    print(lines: string | readonly string[]): void;
    /** Open a streamed text line (an agent reply as it is generated). */
    beginStream(prefix: string): void;
    /**
     * Append the next streamed chunk. Rows are soft-wrapped explicitly and
     * committed to scrollback as they complete; only the final partial row stays
     * in the live region, so physical-row accounting is exact by construction.
     */
    writeStream(chunk: string): void;
    /** Close the streamed line; the text stays in scrollback forever. */
    endStream(): void;
    /** Store new footer content and repaint it in place (the animation tick).
     * Identical repaints are skipped: an idle composer costs zero terminal I/O. */
    setFooter(lines: readonly string[]): void;
    /** Remove the footer from the screen (selectors, prompts, shutdown). */
    clearFooter(): void;
}
/**
 * Split streamed text into complete physical rows (committed to scrollback)
 * and the final partial row (kept live). Soft-wraps at `capacity` visible
 * cells, ANSI-aware, and re-opens active SGR codes on continuation rows so a
 * bold or colored span survives the row boundary — committed rows are
 * reset-terminated and therefore self-contained in scrollback.
 */
export declare function layoutStreamRows(text: string, capacity: number, indent: string): {
    committed: string[];
    tail: string;
    tailSgr: string;
};
/** Visible cell count of a string, ANSI stripped, wide glyphs counted as two. */
export declare function visibleCells(value: string): number;
/** ANSI-aware truncation to a visible cell count, reset-terminated. */
export declare function hardTruncate(value: string, width: number): string;
/** The aurora spectrum: deep-space blues, an ice-to-violet brand axis, mint
 * for passing evidence, and gold reserved for one thing only: proof. */
export declare const ansi: {
    readonly reset: "\u001B[0m";
    readonly bold: "\u001B[1m";
    readonly dim: "\u001B[2m";
    readonly italic: "\u001B[3m";
    readonly inverse: "\u001B[7m";
    readonly cyan: "\u001B[38;2;112;216;255m";
    readonly violet: "\u001B[38;2;158;118;255m";
    readonly green: "\u001B[38;2;88;240;178m";
    readonly red: "\u001B[38;2;255;72;110m";
    readonly amber: "\u001B[38;2;255;196;92m";
    readonly slate: "\u001B[38;2;136;142;178m";
    readonly blue: "\u001B[38;2;126;152;255m";
    readonly pink: "\u001B[38;2;226;132;255m";
    readonly faint: "\u001B[38;2;86;92;130m";
    readonly warmWhite: "\u001B[38;2;238;240;252m";
    readonly ash: "\u001B[38;2;56;62;96m";
    readonly gold: "\u001B[38;2;255;214;110m";
    readonly white: "\u001B[38;2;246;248;255m";
    readonly plumBg: "\u001B[48;2;22;17;44m";
};
export declare function stripAnsi(value: string): string;
export declare function padAnsi(value: string, width: number): string;
export declare function bounded(value: string, max: number): string;
export declare function wrap(value: string, width: number): string[];
/** Left and right segments on one row: left-aligned, right-aligned, one row wide. */
export declare function justifyAnsi(left: string, right: string, width: number): string;
export declare function elapsed(startedAt: number): string;
export declare function formatToolDuration(milliseconds: number): string;
export declare function trimTo<T>(items: T[], limit: number): void;
/**
 * One settled tool call as a transcript card. Failures carry their reason
 * inline; a multi-line reason (a stderr tail) is indented beneath the card.
 * Cards are bounded to the terminal width so they never wrap into each other.
 */
export declare function formatToolCard(options: {
    readonly status: "passed" | "failed";
    readonly title: string;
    readonly detail?: string | undefined;
    readonly durationMs?: number | undefined;
    readonly agentId?: string | undefined;
    readonly width?: number | undefined;
}): string[];
/**
 * Minimal markdown for terminal chat: **bold**, `code`, headings, quotes,
 * list bullets, and fenced code blocks (rendered with a gutter, verbatim
 * content, and no raw ``` markers). Everything else passes through verbatim;
 * no HTML, no links, no surprises. splitStreamableMarkdown holds partial
 * fences and headings upstream, so complete blocks arrive here whole.
 */
export declare function renderMarkdownLite(text: string): string;
/**
 * Split streamed text into the part that can be formatted and printed now, and
 * a tail to hold until more arrives.
 *
 * Markdown spans cross chunk boundaries, so emitting every chunk the moment it
 * lands prints the markers raw — the reader sees literal `**bold**`. Holding
 * back from the first unclosed marker means a span is only ever printed once it
 * is complete, which keeps the stream live without leaking syntax.
 */
export declare function splitStreamableMarkdown(buffer: string): {
    ready: string;
    held: string;
};
/** A chat message (user or agent) as wrapped transcript lines. */
export declare function formatChatMessage(agentId: string, message: string, width: number): string[];
/** The streaming counterpart of formatChatMessage's first-line prefix. */
export declare function streamPrefix(agentId: string): string;
/** A boxed approval request printed into the transcript. */
export declare function formatApprovalBlock(command: string, width: number): string[];
/** A dim single-line note (compaction, retries, session lifecycle). */
export declare function formatNote(text: string): string;
/** The gold seal printed when independent verification accepts the result. */
export declare function formatVerifiedSeal(stats: string): string[];
