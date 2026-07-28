export const DEGENERATE_RUN_THRESHOLD = 5;
export const DEGENERATE_CYCLE_THRESHOLD = 8;
const MIN_SIGNIFICANT_LINE_LENGTH = 8;
const MAX_CYCLE_PERIOD = 4;
const SCATTERED_OCCURRENCE_THRESHOLD = 2 * DEGENERATE_RUN_THRESHOLD;
const SCATTERED_DENSITY_THRESHOLD = 0.7;
export function detectDegenerateRepetition(content, prior) {
    const preExisting = prior === undefined
        ? new Set()
        : new Set(degenerateFindings(trimmedLines(prior)).map((finding) => finding.line));
    let worst;
    for (const finding of degenerateFindings(trimmedLines(content))) {
        if (preExisting.has(finding.line))
            continue;
        if (worst === undefined || finding.count > worst.count)
            worst = finding;
    }
    return worst;
}
export function degenerateRepetitionError(found) {
    const shape = found.kind === "run"
        ? `repeats ${found.count} times consecutively`
        : found.kind === "cycle"
            ? `repeats in a short cycle ${found.count} times`
            : `occurs ${found.count} times in close succession`;
    return `Mutation rejected: the line '${truncateLine(found.line)}' ${shape} starting at line `
        + `${found.startLine}. Runaway repetition is the signature of degenerated output, not `
        + "intentional code. Re-emit the change without the repetition (or express it as a loop or "
        + "constant). If the repetition is genuinely part of the deliverable, retry with "
        + "allowRepetition set to true.";
}
function trimmedLines(content) {
    return content.split(/\r?\n/u).map((line) => line.trim());
}
function degenerateFindings(lines) {
    return [...identicalRuns(lines), ...blockCycles(lines), ...scatteredDominance(lines)];
}
function* identicalRuns(lines) {
    let runLine;
    let runCount = 0;
    let runStart = 0;
    for (let index = 0; index <= lines.length; index += 1) {
        const line = index < lines.length ? lines[index] : undefined;
        if (line !== undefined && line === runLine) {
            runCount += 1;
            continue;
        }
        if (runLine !== undefined && runCount >= DEGENERATE_RUN_THRESHOLD) {
            yield { line: runLine, count: runCount, startLine: runStart + 1, kind: "run" };
        }
        if (line !== undefined && isSignificantLine(line)) {
            runLine = line;
            runCount = 1;
            runStart = index;
        }
        else {
            runLine = undefined;
            runCount = 0;
        }
    }
}
function* blockCycles(lines) {
    for (let period = 2; period <= MAX_CYCLE_PERIOD; period += 1) {
        let stretch = 0;
        for (let index = period; index <= lines.length; index += 1) {
            if (index < lines.length && lines[index] === lines[index - period]) {
                stretch += 1;
                continue;
            }
            if (stretch > 0) {
                const repetitions = Math.floor((stretch + period) / period);
                if (repetitions >= DEGENERATE_CYCLE_THRESHOLD) {
                    const blockStart = index - stretch - period;
                    const block = lines.slice(blockStart, blockStart + period);
                    const significant = block.find(isSignificantLine);
                    if (significant !== undefined) {
                        yield { line: significant, count: repetitions, startLine: blockStart + 1, kind: "cycle" };
                    }
                }
                stretch = 0;
            }
        }
    }
}
function* scatteredDominance(lines) {
    const positions = new Map();
    for (const [index, line] of lines.entries()) {
        if (!isSignificantLine(line))
            continue;
        const existing = positions.get(line);
        if (existing === undefined)
            positions.set(line, [index]);
        else
            existing.push(index);
    }
    for (const [line, occurrences] of positions) {
        if (occurrences.length < SCATTERED_OCCURRENCE_THRESHOLD)
            continue;
        const span = occurrences.at(-1) - occurrences[0] + 1;
        if (occurrences.length / span >= SCATTERED_DENSITY_THRESHOLD) {
            yield { line, count: occurrences.length, startLine: occurrences[0] + 1, kind: "scattered" };
        }
    }
}
function isSignificantLine(trimmed) {
    return trimmed.length >= MIN_SIGNIFICANT_LINE_LENGTH && /[\p{L}\p{N}]/u.test(trimmed);
}
function truncateLine(line, max = 120) {
    return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
