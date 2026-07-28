export class InlineRenderer {
    #out;
    #width;
    #liveRows = 0;
    #footer = [];
    #paintedLive = "";
    #streamOpen = false;
    #streamTail = "";
    #streamIndent = "";
    #streamSgr = "";
    constructor(out, width) {
        this.#out = out;
        this.#width = width;
    }
    get streamOpen() {
        return this.#streamOpen;
    }
    print(lines) {
        const list = typeof lines === "string" ? [lines] : lines;
        if (list.length === 0)
            return;
        this.#frame(`${list.join("\n")}\n`);
    }
    beginStream(prefix) {
        if (this.#streamOpen)
            this.endStream();
        this.#streamOpen = true;
        this.#streamTail = prefix;
        this.#streamSgr = "";
        const indentWidth = stripAnsi(prefix).length;
        this.#streamIndent = " ".repeat(indentWidth > 24 ? 2 : indentWidth);
        this.#frame("");
    }
    writeStream(chunk) {
        if (chunk.length === 0)
            return;
        if (!this.#streamOpen) {
            this.beginStream("");
        }
        const capacity = Math.max(8, Math.max(20, this.#width()) - 1);
        const layout = layoutStreamRows(this.#streamSgr + this.#streamTail + chunk, capacity, this.#streamIndent);
        this.#streamTail = layout.tail;
        this.#streamSgr = layout.tailSgr;
        this.#frame(layout.committed.length === 0 ? "" : `${layout.committed.join("\n")}\n`);
    }
    endStream() {
        if (!this.#streamOpen)
            return;
        this.#streamOpen = false;
        const tail = this.#streamSgr + this.#streamTail;
        this.#streamTail = "";
        this.#streamSgr = "";
        this.#frame(tail.length === 0 ? "" : `${tail}\x1b[0m\n`);
    }
    setFooter(lines) {
        this.#footer = lines;
        if (this.#liveRows > 0 && this.#paintLivePreview() === this.#paintedLive)
            return;
        this.#frame("");
    }
    clearFooter() {
        if (this.#liveRows === 0)
            return;
        this.#out.write(this.#eraseLive());
    }
    #frame(committed) {
        this.#out.write(this.#eraseLive() + committed + this.#paintLive());
    }
    #eraseLive() {
        if (this.#liveRows === 0)
            return "";
        const rows = this.#liveRows;
        this.#liveRows = 0;
        this.#paintedLive = "";
        return rows === 1 ? "\r\x1b[J" : `\x1b[${rows - 1}A\r\x1b[J`;
    }
    #paintLive() {
        const rows = this.#liveRowsPreview();
        if (rows.length === 0)
            return "";
        this.#liveRows = rows.length;
        this.#paintedLive = rows.join("\n");
        return this.#paintedLive;
    }
    #paintLivePreview() {
        return this.#liveRowsPreview().join("\n");
    }
    #liveRowsPreview() {
        const width = Math.max(20, this.#width());
        const rows = [];
        if (this.#streamOpen)
            rows.push(hardTruncate(this.#streamSgr + this.#streamTail, width - 1));
        for (const line of this.#footer)
            rows.push(hardTruncate(line, width - 1));
        return rows;
    }
}
export function layoutStreamRows(text, capacity, indent) {
    const committed = [];
    let sgr = [];
    let row = "";
    let cells = 0;
    let rowSgr = "";
    let lastSpace;
    const indentCells = Math.min(indent.length, Math.max(0, capacity - 8));
    const pad = " ".repeat(indentCells);
    const commit = (content) => {
        const styled = rowSgr.length > 0 || content.includes("\x1b[");
        committed.push(rowSgr + content + (styled ? "\x1b[0m" : ""));
    };
    const breakAtNewline = () => {
        commit(row);
        rowSgr = sgr.join("");
        row = pad;
        cells = indentCells;
        lastSpace = undefined;
    };
    const breakAtOverflow = () => {
        if (lastSpace !== undefined && lastSpace.cell > indentCells) {
            commit(row.slice(0, lastSpace.at));
            const carryCells = cells - lastSpace.cell - 1;
            rowSgr = lastSpace.sgr;
            row = pad + row.slice(lastSpace.at + 1);
            cells = indentCells + carryCells;
        }
        else {
            commit(row);
            rowSgr = sgr.join("");
            row = pad;
            cells = indentCells;
        }
        lastSpace = undefined;
    };
    let at = 0;
    while (at < text.length) {
        const escape = text.slice(at).match(/^\x1b\[[0-9;]*m/);
        if (escape !== null) {
            sgr = escape[0] === "\x1b[0m" ? [] : [...sgr, escape[0]];
            row += escape[0];
            at += escape[0].length;
            continue;
        }
        if (text[at] === "\n") {
            breakAtNewline();
            at += 1;
            continue;
        }
        const codePoint = text.codePointAt(at) ?? 0;
        const glyph = text.slice(at, at + (codePoint > 0xffff ? 2 : 1));
        const width = cellWidth(codePoint);
        if (cells + width > capacity)
            breakAtOverflow();
        if (glyph === " ") {
            if (row === pad && committed.length > 0) {
                at += 1;
                continue;
            }
            lastSpace = { at: row.length, cell: cells, sgr: sgr.join("") };
        }
        row += glyph;
        cells += width;
        at += glyph.length;
    }
    return { committed, tail: row, tailSgr: rowSgr };
}
function cellWidth(codePoint) {
    if (codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f))
        return 0;
    if ((codePoint >= 0x1100 && codePoint <= 0x115f)
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd))
        return 2;
    return 1;
}
export function visibleCells(value) {
    let cells = 0;
    for (const glyph of stripAnsi(value))
        cells += cellWidth(glyph.codePointAt(0) ?? 0);
    return cells;
}
export function hardTruncate(value, width) {
    if (visibleCells(value) <= width)
        return value;
    let cells = 0;
    let at = 0;
    let output = "";
    while (at < value.length) {
        const escape = value.slice(at).match(/^\x1b\[[0-9;]*m/);
        if (escape !== null) {
            output += escape[0];
            at += escape[0].length;
            continue;
        }
        const codePoint = value.codePointAt(at) ?? 0;
        const glyph = value.slice(at, at + (codePoint > 0xffff ? 2 : 1));
        const glyphWidth = cellWidth(codePoint);
        if (cells + glyphWidth > width)
            break;
        output += glyph;
        cells += glyphWidth;
        at += glyph.length;
    }
    return `${output}\x1b[0m`;
}
export const ansi = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    inverse: "\x1b[7m",
    cyan: "\x1b[38;2;112;216;255m",
    violet: "\x1b[38;2;158;118;255m",
    green: "\x1b[38;2;88;240;178m",
    red: "\x1b[38;2;255;72;110m",
    amber: "\x1b[38;2;255;196;92m",
    slate: "\x1b[38;2;136;142;178m",
    blue: "\x1b[38;2;126;152;255m",
    pink: "\x1b[38;2;226;132;255m",
    faint: "\x1b[38;2;86;92;130m",
    warmWhite: "\x1b[38;2;238;240;252m",
    ash: "\x1b[38;2;56;62;96m",
    gold: "\x1b[38;2;255;214;110m",
    white: "\x1b[38;2;246;248;255m",
    plumBg: "\x1b[48;2;22;17;44m",
};
export function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, "");
}
export function padAnsi(value, width) {
    const visible = visibleCells(value);
    if (visible > width)
        return hardTruncate(value, Math.max(0, width - 1)) + "…";
    return `${value}${" ".repeat(width - visible)}`;
}
export function bounded(value, max) {
    if (max <= 1)
        return "";
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
export function wrap(value, width) {
    const lines = [];
    for (const paragraph of value.split(/\r?\n/)) {
        const words = paragraph.split(/\s+/).filter(Boolean);
        let line = "";
        let lineCells = 0;
        for (const word of words) {
            const wordCells = visibleCells(word);
            if (line.length > 0 && lineCells + wordCells + 1 > width) {
                lines.push(line);
                line = "";
                lineCells = 0;
            }
            if (line.length === 0) {
                line = bounded(word, width);
                lineCells = visibleCells(line);
            }
            else {
                line = `${line} ${word}`;
                lineCells += wordCells + 1;
            }
        }
        if (line.length > 0)
            lines.push(line);
    }
    return lines;
}
export function justifyAnsi(left, right, width) {
    const gap = Math.max(1, width - visibleCells(left) - visibleCells(right));
    return `${left}${" ".repeat(gap)}${right}`;
}
export function elapsed(startedAt) {
    const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const seconds = total % 60;
    return hours > 0
        ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
export function formatToolDuration(milliseconds) {
    if (milliseconds < 1_000)
        return `${milliseconds}ms`;
    if (milliseconds < 60_000)
        return `${(milliseconds / 1_000).toFixed(1)}s`;
    return `${Math.floor(milliseconds / 60_000)}m${Math.round((milliseconds % 60_000) / 1_000)}s`;
}
export function trimTo(items, limit) {
    if (items.length > limit)
        items.splice(0, items.length - limit);
}
export function formatToolCard(options) {
    const { status, title, detail, durationMs, agentId } = options;
    const width = options.width ?? 100;
    const detailBudget = Math.max(24, width - title.length - 24);
    const glyph = status === "passed" ? `${ansi.green}✓${ansi.reset}` : `${ansi.red}×${ansi.reset}`;
    const who = agentId !== undefined && agentId !== "main" ? `${ansi.pink}${agentId}${ansi.reset} ` : "";
    const duration = durationMs === undefined ? "" : ` ${ansi.faint}${formatToolDuration(durationMs)}${ansi.reset}`;
    const lines = [];
    if (status === "failed" && detail !== undefined && detail.includes("\n")) {
        const [head, ...tail] = detail.split("\n");
        lines.push(`  ${glyph} ${who}${ansi.slate}${title}${ansi.reset} ${ansi.dim}${bounded(head ?? "", detailBudget)}${ansi.reset}${duration}`);
        for (const line of tail.slice(0, 3)) {
            lines.push(`    ${ansi.red}${bounded(line, Math.max(24, width - 6))}${ansi.reset}`);
        }
        return lines;
    }
    const reason = detail === undefined ? "" : ` ${status === "failed" ? ansi.red : ansi.dim}${bounded(detail, detailBudget)}${ansi.reset}`;
    lines.push(`  ${glyph} ${who}${ansi.slate}${title}${ansi.reset}${reason}${duration}`);
    return lines;
}
export function renderMarkdownLite(text) {
    let inFence = false;
    return text.split("\n").map((line) => {
        const fence = line.match(/^(\s*)```(\S*)\s*$/u);
        if (fence !== null) {
            inFence = !inFence;
            const label = fence[2] ?? "";
            return inFence
                ? `${fence[1] ?? ""}${ansi.ash}╭───${ansi.reset}${label.length === 0 ? "" : ` ${ansi.slate}${label}${ansi.reset}`}`
                : `${fence[1] ?? ""}${ansi.ash}╰───${ansi.reset}`;
        }
        if (inFence)
            return `${ansi.ash}│${ansi.reset} ${line}`;
        return renderInlineMarkdown(line);
    }).join("\n");
}
function renderInlineMarkdown(line) {
    const heading = line.match(/^#{1,4}\s+(.*)$/u);
    if (heading !== null)
        return `${ansi.bold}${ansi.cyan}${heading[1]}${ansi.reset}`;
    return line
        .replace(/\*\*([^*]+)\*\*/gu, `${ansi.bold}$1${ansi.reset}`)
        .replace(/`([^`]+)`/gu, `${ansi.cyan}$1${ansi.reset}`)
        .replace(/^(\s*)[-*] /u, `$1${ansi.violet}•${ansi.reset} `)
        .replace(/^(\s*)(\d{1,3})\. /u, `$1${ansi.violet}$2.${ansi.reset} `)
        .replace(/^> ?(.*)$/u, `${ansi.ash}▌${ansi.reset} ${ansi.dim}$1${ansi.reset}`);
}
export function splitStreamableMarkdown(buffer) {
    const hold = (at) => ({ ready: buffer.slice(0, at), held: buffer.slice(at) });
    let at = 0;
    while (at < buffer.length) {
        const lineStart = at === 0 || buffer[at - 1] === "\n";
        if (lineStart) {
            if (buffer.startsWith("```", at)) {
                const close = buffer.indexOf("\n```", at + 3);
                if (close === -1)
                    return hold(at);
                const closeLineEnd = buffer.indexOf("\n", close + 4);
                if (closeLineEnd === -1)
                    return hold(at);
                at = closeLineEnd + 1;
                continue;
            }
            if (/^`{1,2}$/u.test(buffer.slice(at)))
                return hold(at);
            if (/^#{1,4}(?: |$)/u.test(buffer.slice(at, at + 5))) {
                const lineEnd = buffer.indexOf("\n", at);
                if (lineEnd === -1)
                    return hold(at);
                at = lineEnd + 1;
                continue;
            }
        }
        if (buffer.startsWith("**", at)) {
            const close = buffer.indexOf("**", at + 2);
            if (close === -1)
                return hold(at);
            at = close + 2;
            continue;
        }
        if (buffer[at] === "`") {
            const close = buffer.indexOf("`", at + 1);
            if (close === -1)
                return hold(at);
            at = close + 1;
            continue;
        }
        if (buffer[at] === "*" && at === buffer.length - 1)
            return hold(at);
        at += 1;
    }
    return { ready: buffer, held: "" };
}
export function formatChatMessage(agentId, message, width) {
    const isUser = agentId === "you";
    const label = isUser ? "You" : agentId === "main" ? "Vanguard" : agentId;
    const color = isUser ? ansi.amber : ansi.violet;
    const glyph = isUser ? `${ansi.amber}❯${ansi.reset}` : `${color}◆${ansi.reset}`;
    const prefix = `${glyph} ${color}${ansi.bold}${label}${ansi.reset}  `;
    const indent = " ".repeat(visibleCells(`${glyph} ${label}  `));
    const capacity = Math.max(20, width - indent.length - 2);
    const rows = [];
    for (const logical of renderMarkdownLite(message.trimEnd()).split("\n")) {
        const layout = layoutStreamRows(logical, capacity, "");
        rows.push(...layout.committed);
        const tail = layout.tailSgr + layout.tail;
        rows.push(tail.includes("\x1b[") ? `${tail}\x1b[0m` : tail);
    }
    return rows.map((line, index) => `${index === 0 ? prefix : indent}${ansi.warmWhite}${line}${ansi.reset}`);
}
export function streamPrefix(agentId) {
    const label = agentId === "main" ? "Vanguard" : agentId;
    return `${ansi.violet}◆${ansi.reset} ${ansi.violet}${ansi.bold}${label}${ansi.reset}  `;
}
export function formatApprovalBlock(command, width) {
    const inner = Math.max(30, Math.min(76, width - 8));
    const rule = "─".repeat(inner);
    const lines = [
        `  ${ansi.amber}╭─ ${ansi.bold}APPROVAL REQUIRED${ansi.reset} ${ansi.amber}${"─".repeat(Math.max(2, inner - 19))}╮${ansi.reset}`,
    ];
    for (const info of wrap("A command is outside this session's allowlist. Nothing runs until you choose.", inner - 2)) {
        lines.push(`  ${ansi.amber}│${ansi.reset} ${ansi.dim}${info}${ansi.reset}`);
    }
    for (const [index, commandLine] of wrap(command, inner - 4).slice(0, 4).entries()) {
        lines.push(`  ${ansi.amber}│${ansi.reset} ${ansi.cyan}${index === 0 ? "$" : " "}${ansi.reset} ${ansi.warmWhite}${commandLine}${ansi.reset}`);
    }
    const options = `${ansi.amber}[1]${ansi.reset} ${ansi.warmWhite}${ansi.bold}RUN ONCE${ansi.reset}   ${ansi.amber}[2]${ansi.reset} ${ansi.warmWhite}${ansi.bold}ALLOW SESSION${ansi.reset}   ${ansi.amber}[3]${ansi.reset} ${ansi.warmWhite}${ansi.bold}DENY${ansi.reset}`;
    lines.push(`  ${ansi.amber}│${ansi.reset} ${stripAnsi(options).length > inner - 2
        ? `${ansi.amber}[1]${ansi.reset} ${ansi.warmWhite}${ansi.bold}RUN${ansi.reset}  ${ansi.amber}[2]${ansi.reset} ${ansi.warmWhite}${ansi.bold}ALLOW${ansi.reset}  ${ansi.amber}[3]${ansi.reset} ${ansi.warmWhite}${ansi.bold}DENY${ansi.reset}`
        : options}`, `  ${ansi.amber}╰${rule}╯${ansi.reset}`);
    return lines;
}
export function formatNote(text) {
    return `  ${ansi.faint}·${ansi.reset} ${ansi.dim}${text}${ansi.reset}`;
}
export function formatVerifiedSeal(stats) {
    return [
        `${ansi.gold}${ansi.bold}◈ VERIFIED ◈${ansi.reset}${stats.length === 0 ? "" : ` ${ansi.dim}${stats}${ansi.reset}`}`,
    ];
}
