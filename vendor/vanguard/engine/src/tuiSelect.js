import { emitKeypressEvents } from "node:readline";
const ansi = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    violet: "\x1b[38;2;158;118;255m",
    cyan: "\x1b[38;2;112;216;255m",
    green: "\x1b[38;2;88;240;178m",
    slate: "\x1b[38;2;136;142;178m",
    faint: "\x1b[38;2;86;92;130m",
    warmWhite: "\x1b[38;2;238;240;252m",
    activeRow: "\x1b[48;2;24;20;48m",
    panelBg: "\x1b[48;2;6;8;16m",
    headerBg: "\x1b[48;2;14;17;32m",
};
function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*m/gu, "");
}
function padVisible(value, width) {
    const visible = stripAnsi(value).length;
    return visible >= width ? value : `${value}${" ".repeat(width - visible)}`;
}
function truncatePlain(value, max) {
    return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
export class SelectCancelled extends Error {
    constructor() {
        super("Selection cancelled.");
        this.name = "SelectCancelled";
    }
}
export function filterSelectItems(items, query) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    if (terms.length === 0)
        return items;
    return items.filter((item) => {
        const haystack = `${item.label} ${item.note ?? ""}`.toLocaleLowerCase();
        return terms.every((term) => haystack.includes(term));
    });
}
export async function select(options) {
    const items = options.items;
    if (items.length === 0)
        throw new Error("A selector needs at least one item.");
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("The Vanguard selector requires an interactive terminal.");
    }
    const searchable = options.searchable ?? items.length > 8;
    let query = "";
    let filtered = [...items];
    let index = clamp(options.initialIndex ?? 0, filtered.length);
    const out = process.stdout;
    const hint = options.hint ?? `${searchable ? "Type to filter · " : ""}↑↓ move · Enter select · Esc cancel`;
    let painted = 0;
    let paintedTop = 1;
    const applyFilter = () => {
        filtered = [...filterSelectItems(items, query)];
        index = clamp(index, Math.max(1, filtered.length));
    };
    const paint = () => {
        const columns = out.columns ?? 80;
        const rows = out.rows ?? 24;
        const labelWidth = Math.max(...items.map((item) => item.label.length));
        const widest = Math.max(options.title.length + 6, hint.length + 6, ...items.map((item) => labelWidth + (item.note === undefined ? 0 : item.note.length + 2) + 6));
        const inner = Math.max(40, Math.min(widest, columns - 4));
        const leftMargin = " ".repeat(Math.max(0, Math.floor((columns - inner - 2) / 2)));
        const lines = [];
        const count = filtered.length === items.length ? `${items.length}` : `${filtered.length}/${items.length}`;
        const title = truncatePlain(options.title, Math.max(10, inner - count.length - 12));
        const titleFill = "─".repeat(Math.max(1, inner + 3 - 6 - title.length - 1 - 1 - count.length - 2));
        lines.push(`${ansi.headerBg}${ansi.faint} ╭─ ${ansi.reset}${ansi.headerBg}${ansi.violet}◆ ${ansi.reset}`
            + `${ansi.headerBg}${ansi.bold}${title}${ansi.reset}${ansi.headerBg} ${ansi.faint}${titleFill}${ansi.reset}`
            + `${ansi.headerBg} ${ansi.slate}${count}${ansi.reset}${ansi.headerBg}${ansi.faint} ╮${ansi.reset}`);
        if (searchable) {
            const filterText = query.length === 0 ? `${ansi.faint}type to filter models…${ansi.reset}` : `${ansi.warmWhite}${truncatePlain(query, inner - 8)}${ansi.reset}`;
            const filterRow = ` ${ansi.violet}⌕${ansi.reset}  ${filterText}`;
            lines.push(`${ansi.panelBg} ${ansi.faint}│${ansi.reset}${ansi.panelBg}${padVisible(filterRow, inner)}${ansi.faint}│${ansi.reset}`);
            lines.push(`${ansi.panelBg} ${ansi.faint}├${"─".repeat(inner)}┤${ansi.reset}`);
        }
        const reservedRows = searchable ? 17 : 15;
        const viewportSize = Math.max(3, Math.min(filtered.length || 1, rows - reservedRows));
        const start = Math.max(0, Math.min(index - Math.floor(viewportSize / 2), filtered.length - viewportSize));
        const visible = filtered.slice(start, start + viewportSize);
        for (const [offset, item] of visible.entries()) {
            const position = start + offset;
            const active = position === index;
            const label = padVisible(item.label, labelWidth);
            const note = item.note === undefined ? "" : `  ${truncatePlain(item.note, Math.max(4, inner - labelWidth - 6))}`;
            const padding = " ".repeat(Math.max(0, inner - 3 - labelWidth - note.length));
            const row = active
                ? `${ansi.activeRow}${ansi.cyan}${ansi.bold} ❯ ${label}\x1b[22m${ansi.warmWhite}${note}${padding}${ansi.reset}`
                : `${ansi.panelBg}   ${ansi.slate}${label}${ansi.reset}${ansi.panelBg}${ansi.faint}${note}${ansi.reset}${ansi.panelBg}${padding}`;
            lines.push(`${ansi.panelBg} ${ansi.faint}│${ansi.reset}${ansi.panelBg}${row}${ansi.panelBg}${ansi.faint}│${ansi.reset}`);
        }
        if (filtered.length === 0) {
            lines.push(`${ansi.panelBg} ${ansi.faint}│${ansi.reset}${ansi.panelBg}${padVisible(`   ${ansi.faint}No models match “${truncatePlain(query, inner - 24)}”${ansi.reset}`, inner)}${ansi.faint}│${ansi.reset}`);
        }
        const hintText = truncatePlain(hint, inner - 6);
        const hintFill = "─".repeat(Math.max(1, inner + 3 - 4 - hintText.length - 1 - 1));
        lines.push(`${ansi.headerBg}${ansi.faint} ╰─ ${hintText} ${hintFill}╯${ansi.reset}`);
        const maximumTop = Math.max(1, rows - lines.length);
        const centeredTop = Math.floor((rows - lines.length) / 2) + 1;
        const top = Math.max(1, Math.min(Math.max(10, centeredTop), maximumTop));
        let output = "";
        for (let offset = 0; offset < painted; offset += 1) {
            output += `\x1b[${paintedTop + offset};1H\x1b[2K`;
        }
        for (const [offset, line] of lines.entries()) {
            output += `\x1b[${top + offset};1H\x1b[2K${leftMargin}${line}`;
        }
        output += `\x1b[${Math.min(rows, top + lines.length)};1H\x1b[0J`;
        out.write(output);
        painted = lines.length;
        paintedTop = top;
    };
    const step = (delta) => {
        if (filtered.length === 0)
            return;
        index = (index + delta + filtered.length) % filtered.length;
        paint();
    };
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    out.write("\x1b[?25l");
    return new Promise((resolve, reject) => {
        const done = (error, value) => {
            process.stdin.off("keypress", onKeypress);
            process.stdin.setRawMode(wasRaw === true);
            process.stdin.pause();
            if (options.collapseOnClose === true && painted > 0) {
                let erase = "";
                for (let offset = 0; offset < painted; offset += 1) {
                    erase += `\x1b[${paintedTop + offset};1H\x1b[2K`;
                }
                out.write(`${erase}\x1b[${paintedTop};1H`);
                painted = 0;
            }
            out.write("\x1b[?25h");
            if (error !== undefined)
                reject(error);
            else
                resolve(value);
        };
        function onKeypress(chunk, key) {
            if (key === undefined)
                return;
            if (key.ctrl === true && key.name === "c") {
                done(new SelectCancelled());
                return;
            }
            if (key.name === "escape") {
                if (query.length > 0) {
                    query = "";
                    applyFilter();
                    paint();
                }
                else {
                    done(new SelectCancelled());
                }
                return;
            }
            if (key.name === "up" || (!searchable && key.name === "k"))
                step(-1);
            else if (key.name === "down" || (!searchable && key.name === "j"))
                step(1);
            else if (key.name === "pageup")
                step(-8);
            else if (key.name === "pagedown")
                step(8);
            else if (key.name === "home") {
                index = 0;
                paint();
            }
            else if (key.name === "end") {
                index = Math.max(0, filtered.length - 1);
                paint();
            }
            else if (searchable && key.name === "backspace") {
                query = query.slice(0, -1);
                applyFilter();
                paint();
            }
            else if (searchable && key.ctrl === true && key.name === "u") {
                query = "";
                applyFilter();
                paint();
            }
            else if (key.name === "return" || key.name === "enter") {
                const chosen = filtered[index];
                if (chosen === undefined)
                    return;
                done(undefined, chosen.value);
            }
            else if (searchable && key.ctrl !== true && typeof chunk === "string" && /^[\p{L}\p{N}._:/@+\- ]$/u.test(chunk)) {
                query += chunk;
                applyFilter();
                paint();
            }
        }
        process.stdin.on("keypress", onKeypress);
        paint();
    });
}
function clamp(value, length) {
    if (!Number.isInteger(value) || value < 0)
        return 0;
    return Math.min(value, length - 1);
}
