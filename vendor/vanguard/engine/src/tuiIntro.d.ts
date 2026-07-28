export interface IntroFrame {
    readonly lines: readonly string[];
    readonly holdMs: number;
}
/**
 * Deterministic frame script for the launch animation; exported for tests.
 * Every frame paints the same fixed-size canvas, so the sequence can never
 * jitter or shear the terminal.
 */
export declare function buildIntroFrames(columns?: number, rows?: number): readonly IntroFrame[];
/**
 * Plays CONVERGENCE over a cleared screen — centered vertically and
 * horizontally — then wipes it so the welcome starts clean. Returns
 * immediately anywhere the animation could misbehave.
 */
export declare function playIntroAnimation(out?: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns" | "rows">): Promise<void>;
