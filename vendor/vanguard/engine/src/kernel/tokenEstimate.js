export function estimateTokens(text) {
    if (text.length === 0)
        return 0;
    let tokens = 0;
    const matcher = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu;
    let match;
    while ((match = matcher.exec(text)) !== null) {
        const piece = match[0];
        tokens += /^[A-Za-z0-9_]/u.test(piece) ? Math.max(1, Math.ceil(piece.length / 3.5)) : 1;
    }
    return tokens;
}
export function tokenCeilingForBytes(maxBytes) {
    return Math.floor(maxBytes / 2.5);
}
const SAMPLE_LENGTH = 65_536;
export function estimateTokensFast(text) {
    if (text.length <= SAMPLE_LENGTH)
        return estimateTokens(text);
    return Math.ceil(estimateTokens(text.slice(0, SAMPLE_LENGTH)) * (text.length / SAMPLE_LENGTH));
}
