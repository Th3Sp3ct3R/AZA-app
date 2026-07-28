const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const ink = {
    ice: rgb(112, 216, 255),
    violet: rgb(158, 118, 255),
    pink: rgb(226, 132, 255),
    gold: rgb(255, 214, 110),
    white: `${BOLD}${rgb(246, 248, 255)}`,
    steel: rgb(122, 130, 170),
    slate: rgb(136, 142, 178),
    faint: rgb(62, 68, 104),
    dimStar: rgb(40, 45, 72),
};
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}
function newGrid(width, height) {
    return Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: " ", color: "" })));
}
function plot(grid, x, y, ch, color) {
    const row = grid[Math.round(y)];
    if (row === undefined)
        return;
    const column = Math.round(x);
    if (column < 0 || column >= row.length)
        return;
    row[column] = { ch, color };
}
function serialize(grid) {
    return grid.map((row) => {
        let out = "";
        let runColor = row[0]?.color ?? "";
        let run = "";
        for (const cell of row) {
            if (cell.color === runColor) {
                run += cell.ch;
                continue;
            }
            out += runColor.length === 0 ? run : `${runColor}${run}${RESET}`;
            runColor = cell.color;
            run = cell.ch;
        }
        out += runColor.length === 0 ? run : `${runColor}${run}${RESET}`;
        return out;
    });
}
function lerp(start, end, t) {
    return start + (end - start) * t;
}
function rampColor(t) {
    if (t < 0.45)
        return ink.violet;
    if (t < 0.8)
        return ink.ice;
    return ink.white;
}
function makeStars(count, width, height, seed) {
    const random = mulberry32(seed);
    const stars = [];
    for (let index = 0; index < count; index += 1) {
        stars.push({
            x: Math.floor(random() * width),
            y: Math.floor(random() * height),
            phase: Math.floor(random() * 3),
            stagger: random() * 0.25,
        });
    }
    return stars;
}
function centerOutOrder(length) {
    const order = [];
    let left = Math.floor((length - 1) / 2);
    let right = left + 1;
    if (length % 2 === 0) {
        order.push(left, right);
        left -= 1;
        right += 1;
    }
    else {
        order.push(left);
        left -= 1;
    }
    while (left >= 0 || right < length) {
        if (left >= 0)
            order.push(left);
        if (right < length)
            order.push(right);
        left -= 1;
        right += 1;
    }
    return order;
}
function paintEmblem(grid, cx, cy, wordmark, tagline, options) {
    const width = grid[0].length;
    const innerWidth = wordmark.length + 2;
    const left = cx - Math.floor(innerWidth / 2) - 1;
    const borderColor = options.ghost === true ? ink.faint : ink.violet;
    const halfReach = Math.floor(options.borderGrow * (innerWidth / 2 + 1));
    for (let x = cx - halfReach; x <= cx + halfReach; x += 1) {
        const edge = x === cx - halfReach || x === cx + halfReach;
        plot(grid, x, cy - 2, edge && options.borderGrow < 1 ? "•" : "─", borderColor);
        plot(grid, x, cy + 2, edge && options.borderGrow < 1 ? "•" : "─", borderColor);
    }
    if (options.borderGrow >= 1) {
        plot(grid, left, cy - 2, "╭", borderColor);
        plot(grid, left + innerWidth + 1, cy - 2, "╮", borderColor);
        plot(grid, left, cy + 2, "╰", borderColor);
        plot(grid, left + innerWidth + 1, cy + 2, "╯", borderColor);
        for (const y of [cy - 1, cy, cy + 1]) {
            plot(grid, left, y, "│", borderColor);
            plot(grid, left + innerWidth + 1, y, "│", borderColor);
        }
    }
    const letterPositions = [...wordmark].flatMap((character, index) => (character === " " ? [] : [index]));
    const order = centerOutOrder(letterPositions.length).map((position) => letterPositions[position]);
    const visible = new Set(order.slice(0, options.lettersVisible));
    const wordLeft = left + 2;
    for (let index = 0; index < wordmark.length; index += 1) {
        const character = wordmark[index];
        const x = wordLeft + index;
        if (character === " ")
            continue;
        if (!visible.has(index)) {
            if (options.lettersVisible > 0 && options.ghost !== true)
                plot(grid, x, cy, "·", ink.faint);
            continue;
        }
        let color = options.ghost === true ? ink.faint : rampColor(index / Math.max(1, wordmark.length - 1));
        if (options.sweepX !== undefined && options.ghost !== true) {
            const distance = Math.abs(x - options.sweepX);
            if (distance === 0)
                color = ink.white;
            else if (distance <= 2)
                color = ink.gold;
        }
        plot(grid, x, cy, character, color);
    }
    if (options.seal > 0 && options.borderGrow >= 1) {
        const sealed = Math.floor(options.seal * innerWidth);
        for (let offset = 0; offset < sealed; offset += 1) {
            plot(grid, left + 1 + offset, cy + 1, "─", options.ghost === true ? ink.faint : ink.gold);
        }
    }
    if (options.taglineVisible > 0) {
        const tagOrder = centerOutOrder(tagline.length);
        const tagVisible = new Set(tagOrder.slice(0, options.taglineVisible));
        const tagLeft = Math.max(0, Math.floor((width - tagline.length) / 2));
        for (let index = 0; index < tagline.length; index += 1) {
            if (!tagVisible.has(index))
                continue;
            plot(grid, tagLeft + index, cy + 4, tagline[index], options.ghost === true ? ink.faint : ink.slate);
        }
    }
}
export function buildIntroFrames(columns = 80, rows = 24) {
    const grand = columns >= 96 && rows >= 28;
    const width = Math.max(40, Math.min(columns - 2, grand ? 92 : 72));
    const height = grand ? 17 : 13;
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const wordmark = grand ? "V A N G U A R D" : "VANGUARD";
    const tagline = "VERIFICATION-FIRST · AGENTIC ENGINE";
    const letters = [...wordmark].filter((character) => character !== " ").length;
    const stars = makeStars(grand ? 30 : 20, width, height, 0x9e3779b9);
    const frames = [];
    const push = (grid, holdMs) => {
        frames.push({ lines: serialize(grid), holdMs });
    };
    for (let frame = 0; frame < 6; frame += 1) {
        const grid = newGrid(width, height);
        for (const star of stars) {
            const brightness = (frame + star.phase) % 3;
            if (brightness === 0)
                plot(grid, star.x, star.y, "·", ink.dimStar);
            else if (brightness === 1)
                plot(grid, star.x, star.y, "+", ink.steel);
            else
                plot(grid, star.x, star.y, "✦", ink.violet);
        }
        push(grid, 88);
    }
    for (let frame = 0; frame < 8; frame += 1) {
        const grid = newGrid(width, height);
        const t = (frame + 1) / 8;
        for (const star of stars) {
            const local = Math.min(1, Math.max(0, t * t - star.stagger * 0.4));
            const headX = lerp(star.x, cx, local);
            const headY = lerp(star.y, cy, local);
            const trailX = lerp(star.x, cx, Math.max(0, local - 0.16));
            const trailY = lerp(star.y, cy, Math.max(0, local - 0.16));
            plot(grid, trailX, trailY, "·", ink.faint);
            const glyph = local < 0.5 ? "·" : local < 0.85 ? "•" : "●";
            const color = local < 0.35 ? ink.steel : local < 0.7 ? ink.violet : local < 0.95 ? ink.ice : ink.white;
            plot(grid, headX, headY, glyph, color);
        }
        push(grid, 58);
    }
    {
        const grid = newGrid(width, height);
        plot(grid, cx, cy, "●", ink.white);
        push(grid, 120);
    }
    {
        const grid = newGrid(width, height);
        plot(grid, cx, cy, "◉", ink.white);
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0], [-1, -1], [1, 1]]) {
            plot(grid, cx + dx, cy + dy, "·", ink.ice);
        }
        push(grid, 100);
    }
    {
        const grid = newGrid(width, height);
        for (let x = 0; x < width; x += 1) {
            const distance = Math.abs(x - cx) / cx;
            plot(grid, x, cy, "═", distance < 0.12 ? ink.white : distance < 0.55 ? ink.ice : ink.faint);
        }
        plot(grid, cx, cy, "◉", ink.white);
        push(grid, 95);
    }
    const radii = [2, 3.8, 5.8, 8, 10.4];
    for (const [ringIndex, radius] of radii.entries()) {
        const grid = newGrid(width, height);
        const cooling = ringIndex / (radii.length - 1);
        const color = cooling < 0.34 ? ink.ice : cooling < 0.67 ? ink.violet : ink.faint;
        for (let degree = 0; degree < 360; degree += 2) {
            const angle = (degree * Math.PI) / 180;
            plot(grid, cx + Math.cos(angle) * radius * 2.1, cy + Math.sin(angle) * radius, "·", color);
        }
        plot(grid, cx, cy, ringIndex < 2 ? "●" : "·", ringIndex < 2 ? ink.violet : ink.faint);
        push(grid, 54);
    }
    const crystallizeFrames = 7;
    for (let frame = 0; frame < crystallizeFrames; frame += 1) {
        const grid = newGrid(width, height);
        for (const star of stars)
            plot(grid, star.x, star.y, "·", ink.dimStar);
        const grow = Math.min(1, ((frame + 1) / crystallizeFrames) * 1.35);
        const lettersVisible = frame < 2 ? 0 : Math.min(letters, (frame - 1) * 2);
        paintEmblem(grid, cx, cy, wordmark, tagline, {
            borderGrow: grow,
            lettersVisible,
            seal: 0,
            taglineVisible: 0,
        });
        push(grid, 64);
    }
    for (let frame = 0; frame < 3; frame += 1) {
        const grid = newGrid(width, height);
        for (const star of stars)
            plot(grid, star.x, star.y, "·", ink.dimStar);
        paintEmblem(grid, cx, cy, wordmark, tagline, {
            borderGrow: 1,
            lettersVisible: letters,
            seal: 0,
            taglineVisible: Math.floor(((frame + 1) / 3) * tagline.length),
        });
        push(grid, 62);
    }
    for (let frame = 0; frame < 4; frame += 1) {
        const grid = newGrid(width, height);
        for (const star of stars)
            plot(grid, star.x, star.y, "·", ink.dimStar);
        paintEmblem(grid, cx, cy, wordmark, tagline, {
            borderGrow: 1,
            lettersVisible: letters,
            seal: (frame + 1) / 4,
            sweepX: Math.floor(((frame + 1) / 4) * (width - 1)),
            taglineVisible: tagline.length,
        });
        push(grid, 66);
    }
    {
        const grid = newGrid(width, height);
        for (const star of stars)
            plot(grid, star.x, star.y, "·", ink.dimStar);
        paintEmblem(grid, cx, cy, wordmark, tagline, {
            borderGrow: 1,
            lettersVisible: letters,
            seal: 1,
            taglineVisible: tagline.length,
        });
        push(grid, 620);
    }
    {
        const grid = newGrid(width, height);
        paintEmblem(grid, cx, cy, wordmark, tagline, {
            borderGrow: 1,
            lettersVisible: letters,
            seal: 1,
            taglineVisible: tagline.length,
            ghost: true,
        });
        push(grid, 110);
    }
    {
        const grid = newGrid(width, height);
        paintEmblem(grid, cx, cy, wordmark, tagline, {
            borderGrow: 1,
            lettersVisible: 0,
            seal: 0,
            taglineVisible: 0,
            ghost: true,
        });
        push(grid, 95);
    }
    return frames;
}
export async function playIntroAnimation(out = process.stdout) {
    if (out.isTTY !== true)
        return;
    if (process.env.VANGUARD_NO_INTRO === "1")
        return;
    const columns = out.columns ?? 0;
    const rows = out.rows ?? 0;
    if (columns < 47 || rows < 17)
        return;
    const frames = buildIntroFrames(columns, rows);
    const height = frames[0].lines.length;
    const top = Math.max(1, Math.floor((rows - height) / 2) + 1);
    out.write("\x1b[?25l\x1b[2J\x1b[H");
    try {
        for (const frame of frames) {
            out.write(`\x1b[${top};1H${frame.lines.map((line) => `\x1b[2K${line}`).join("\n")}`);
            await new Promise((resolve) => setTimeout(resolve, frame.holdMs));
        }
    }
    finally {
        out.write("\x1b[2J\x1b[H\x1b[?25h");
    }
}
