import { inflateSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { objectInput, optionalStringField, stringField } from "./input.js";
const MAX_IMAGE_BYTES = 50_000_000;
const MAX_PIXELS = 25_000_000;
const ASCII_WIDTH = 32;
const ASCII_HEIGHT = 12;
const REGION_COLUMNS = 8;
const REGION_ROWS = 6;
export class ImageInspectionTool {
    workspace;
    name = "inspect_image";
    definition = {
        name: this.name,
        description: "Decode a workspace BMP or PNG and return model-readable visual evidence: exposure, color diversity, regional occlusion/detail, a luminance map, HUD-like contrast, and an optional pixel comparison.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Workspace-relative BMP or PNG path; an absolute path inside the workspace is also accepted." },
                comparePath: { type: "string", description: "Optional image to compare pixel-by-pixel; workspace-relative or absolute inside the workspace." },
            },
            required: ["path"],
            additionalProperties: false,
        },
        effect: "observe",
    };
    constructor(workspace) {
        this.workspace = workspace;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const relativePath = stringField(fields, "path");
        const compareRelativePath = optionalStringField(fields, "comparePath");
        const image = await this.#read(relativePath);
        const output = {
            path: relativePath,
            ...analyze(image),
        };
        if (compareRelativePath !== undefined) {
            const comparison = await this.#read(compareRelativePath);
            output.comparison = compareImages(image, comparison, compareRelativePath);
        }
        return { ok: true, output };
    }
    async #read(relativePath) {
        const file = await this.workspace.existing(this.#workspacePath(relativePath));
        const metadata = await stat(file);
        if (!metadata.isFile())
            throw new Error("Image path is not a file.");
        if (metadata.size > MAX_IMAGE_BYTES)
            throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte inspection limit.`);
        return decodeImage(await readFile(file));
    }
    #workspacePath(inputPath) {
        if (!path.isAbsolute(inputPath))
            return inputPath;
        const relative = path.relative(this.workspace.root, inputPath);
        if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Image path is outside the workspace: ${inputPath}`);
        }
        return relative;
    }
}
function decodeImage(buffer) {
    if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM")
        return decodeBmp(buffer);
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSignature))
        return decodePng(buffer);
    throw new Error("Unsupported image format. inspect_image currently accepts BMP and PNG files.");
}
function decodeBmp(buffer) {
    if (buffer.length < 54)
        throw new Error("BMP header is incomplete.");
    const pixelOffset = buffer.readUInt32LE(10);
    const width = buffer.readInt32LE(18);
    const signedHeight = buffer.readInt32LE(22);
    const bits = buffer.readUInt16LE(28);
    const compression = buffer.readUInt32LE(30);
    const height = Math.abs(signedHeight);
    validateDimensions(width, height);
    if (bits !== 24 && bits !== 32)
        throw new Error(`Unsupported BMP bit depth ${bits}; expected 24 or 32.`);
    if (compression !== 0)
        throw new Error("Compressed BMP files are not supported.");
    const bytesPerPixel = bits / 8;
    const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;
    if (buffer.length < pixelOffset + rowStride * height)
        throw new Error("BMP pixel payload is incomplete.");
    const rgb = new Uint8Array(width * height * 3);
    for (let fileY = 0; fileY < height; fileY += 1) {
        const visualY = signedHeight > 0 ? height - 1 - fileY : fileY;
        for (let x = 0; x < width; x += 1) {
            const source = pixelOffset + fileY * rowStride + x * bytesPerPixel;
            const target = (visualY * width + x) * 3;
            rgb[target] = buffer[source + 2];
            rgb[target + 1] = buffer[source + 1];
            rgb[target + 2] = buffer[source];
        }
    }
    return { format: "bmp", width, height, rgb };
}
function decodePng(buffer) {
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = -1;
    const data = [];
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
        const start = offset + 8;
        const end = start + length;
        if (end + 4 > buffer.length)
            throw new Error("PNG chunk payload is incomplete.");
        if (type === "IHDR") {
            width = buffer.readUInt32BE(start);
            height = buffer.readUInt32BE(start + 4);
            bitDepth = buffer[start + 8];
            colorType = buffer[start + 9];
            interlace = buffer[start + 12];
        }
        else if (type === "IDAT") {
            data.push(buffer.subarray(start, end));
        }
        else if (type === "IEND") {
            break;
        }
        offset = end + 4;
    }
    validateDimensions(width, height);
    if (bitDepth !== 8)
        throw new Error(`Unsupported PNG bit depth ${bitDepth}; expected 8.`);
    if (interlace !== 0)
        throw new Error("Interlaced PNG files are not supported.");
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (channels === 0)
        throw new Error(`Unsupported PNG color type ${colorType}.`);
    if (data.length === 0)
        throw new Error("PNG does not contain image data.");
    const inflated = inflateSync(Buffer.concat(data));
    const scanlineBytes = width * channels;
    const expected = (scanlineBytes + 1) * height;
    if (inflated.length !== expected)
        throw new Error("PNG scanline payload has an unexpected size.");
    const reconstructed = Buffer.alloc(scanlineBytes * height);
    for (let y = 0; y < height; y += 1) {
        const sourceRow = y * (scanlineBytes + 1);
        const filter = inflated[sourceRow];
        const targetRow = y * scanlineBytes;
        for (let x = 0; x < scanlineBytes; x += 1) {
            const raw = inflated[sourceRow + 1 + x];
            const left = x >= channels ? reconstructed[targetRow + x - channels] : 0;
            const up = y > 0 ? reconstructed[targetRow - scanlineBytes + x] : 0;
            const upLeft = y > 0 && x >= channels ? reconstructed[targetRow - scanlineBytes + x - channels] : 0;
            reconstructed[targetRow + x] = (raw + filterValue(filter, left, up, upLeft)) & 0xff;
        }
    }
    const rgb = new Uint8Array(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
        const source = pixel * channels;
        const target = pixel * 3;
        if (colorType === 0 || colorType === 4) {
            rgb[target] = reconstructed[source];
            rgb[target + 1] = reconstructed[source];
            rgb[target + 2] = reconstructed[source];
        }
        else {
            rgb[target] = reconstructed[source];
            rgb[target + 1] = reconstructed[source + 1];
            rgb[target + 2] = reconstructed[source + 2];
        }
    }
    return { format: "png", width, height, rgb };
}
function filterValue(filter, left, up, upLeft) {
    if (filter === 0)
        return 0;
    if (filter === 1)
        return left;
    if (filter === 2)
        return up;
    if (filter === 3)
        return Math.floor((left + up) / 2);
    if (filter === 4)
        return paeth(left, up, upLeft);
    throw new Error(`Unsupported PNG row filter ${filter}.`);
}
function paeth(left, up, upLeft) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const diagonalDistance = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= diagonalDistance)
        return left;
    return upDistance <= diagonalDistance ? up : upLeft;
}
function validateDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`Invalid image dimensions ${width}x${height}.`);
    }
    if (width * height > MAX_PIXELS)
        throw new Error(`Image exceeds ${MAX_PIXELS} pixel inspection limit.`);
}
function analyze(image) {
    const { width, height, rgb } = image;
    const pixels = width * height;
    const quantized = new Map();
    const regionStats = Array.from({ length: REGION_COLUMNS * REGION_ROWS }, () => ({
        pixels: 0,
        luminance: 0,
        luminanceSquared: 0,
        nearBlack: 0,
        colors: new Set(),
    }));
    let luminanceTotal = 0;
    let luminanceSquaredTotal = 0;
    let nearBlack = 0;
    let nearWhite = 0;
    let bottomPixels = 0;
    let bottomNeutralBright = 0;
    let bottomHardEdges = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 3;
            const red = rgb[index];
            const green = rgb[index + 1];
            const blue = rgb[index + 2];
            const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
            luminanceTotal += luminance;
            luminanceSquaredTotal += luminance * luminance;
            if (luminance < 18)
                nearBlack += 1;
            if (luminance > 245)
                nearWhite += 1;
            const color = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
            quantized.set(color, (quantized.get(color) ?? 0) + 1);
            const regionX = Math.min(REGION_COLUMNS - 1, Math.floor((x * REGION_COLUMNS) / width));
            const regionY = Math.min(REGION_ROWS - 1, Math.floor((y * REGION_ROWS) / height));
            const region = regionStats[regionY * REGION_COLUMNS + regionX];
            region.pixels += 1;
            region.luminance += luminance;
            region.luminanceSquared += luminance * luminance;
            if (luminance < 18)
                region.nearBlack += 1;
            region.colors.add(color);
            if (y >= Math.floor(height * 0.72)) {
                bottomPixels += 1;
                const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
                if (luminance >= 210 && chroma <= 45)
                    bottomNeutralBright += 1;
                if (x > 0) {
                    const previous = index - 3;
                    const previousLuminance = rgb[previous] * 0.2126 + rgb[previous + 1] * 0.7152 + rgb[previous + 2] * 0.0722;
                    if (Math.abs(luminance - previousLuminance) >= 100)
                        bottomHardEdges += 1;
                }
            }
        }
    }
    const meanLuminance = luminanceTotal / pixels;
    const deviation = Math.sqrt(Math.max(0, luminanceSquaredTotal / pixels - meanLuminance ** 2));
    const dominantColors = [...quantized.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([color, count]) => ({ color: quantizedHex(color), ratio: rounded(count / pixels, 4) }));
    const regions = regionStats.map((region, index) => {
        const mean = region.luminance / region.pixels;
        const regionDeviation = Math.sqrt(Math.max(0, region.luminanceSquared / region.pixels - mean ** 2));
        return {
            column: index % REGION_COLUMNS,
            row: Math.floor(index / REGION_COLUMNS),
            meanLuminance: rounded(mean, 1),
            luminanceDeviation: rounded(regionDeviation, 1),
            nearBlackRatio: rounded(region.nearBlack / region.pixels, 4),
            quantizedColors: region.colors.size,
        };
    });
    return {
        format: image.format,
        width,
        height,
        pixels,
        exposure: {
            meanLuminance: rounded(meanLuminance, 1),
            luminanceDeviation: rounded(deviation, 1),
            nearBlackRatio: rounded(nearBlack / pixels, 4),
            nearWhiteRatio: rounded(nearWhite / pixels, 4),
        },
        color: { quantizedColors: quantized.size, dominantColors },
        lowerRegion: {
            neutralBrightRatio: rounded(bottomNeutralBright / bottomPixels, 5),
            hardHorizontalEdgeRatio: rounded(bottomHardEdges / bottomPixels, 5),
            hudEvidence: bottomNeutralBright / bottomPixels >= 0.0005 && bottomHardEdges / bottomPixels >= 0.0005,
        },
        suspiciousRegions: regions.filter((region) => region.nearBlackRatio >= 0.5 || region.quantizedColors <= 2),
        regions,
        luminanceMap: luminanceMap(image),
    };
}
function luminanceMap(image) {
    const palette = " .:-=+*#%@";
    const rows = [];
    for (let cellY = 0; cellY < ASCII_HEIGHT; cellY += 1) {
        let row = "";
        const startY = Math.floor((cellY * image.height) / ASCII_HEIGHT);
        const endY = Math.max(startY + 1, Math.floor(((cellY + 1) * image.height) / ASCII_HEIGHT));
        for (let cellX = 0; cellX < ASCII_WIDTH; cellX += 1) {
            const startX = Math.floor((cellX * image.width) / ASCII_WIDTH);
            const endX = Math.max(startX + 1, Math.floor(((cellX + 1) * image.width) / ASCII_WIDTH));
            let total = 0;
            let count = 0;
            for (let y = startY; y < endY; y += 1) {
                for (let x = startX; x < endX; x += 1) {
                    const index = (y * image.width + x) * 3;
                    total += image.rgb[index] * 0.2126 + image.rgb[index + 1] * 0.7152 + image.rgb[index + 2] * 0.0722;
                    count += 1;
                }
            }
            row += palette[Math.min(palette.length - 1, Math.floor(((total / count) / 256) * palette.length))];
        }
        rows.push(row);
    }
    return rows;
}
function compareImages(left, right, comparePath) {
    if (left.width !== right.width || left.height !== right.height) {
        return {
            comparePath,
            sameDimensions: false,
            dimensions: `${right.width}x${right.height}`,
            exactPixelMatch: false,
        };
    }
    let absoluteDelta = 0;
    let changedPixels = 0;
    for (let pixel = 0; pixel < left.width * left.height; pixel += 1) {
        const index = pixel * 3;
        const redDelta = Math.abs(left.rgb[index] - right.rgb[index]);
        const greenDelta = Math.abs(left.rgb[index + 1] - right.rgb[index + 1]);
        const blueDelta = Math.abs(left.rgb[index + 2] - right.rgb[index + 2]);
        absoluteDelta += redDelta + greenDelta + blueDelta;
        if (redDelta !== 0 || greenDelta !== 0 || blueDelta !== 0)
            changedPixels += 1;
    }
    const channels = left.width * left.height * 3;
    return {
        comparePath,
        sameDimensions: true,
        exactPixelMatch: changedPixels === 0,
        changedPixelRatio: rounded(changedPixels / (left.width * left.height), 6),
        meanAbsoluteChannelDelta: rounded(absoluteDelta / channels, 3),
    };
}
function quantizedHex(color) {
    const red = ((color >> 8) & 0xf) * 17;
    const green = ((color >> 4) & 0xf) * 17;
    const blue = (color & 0xf) * 17;
    return `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
}
function rounded(value, digits) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}
