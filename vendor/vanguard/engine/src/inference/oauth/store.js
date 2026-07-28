import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export function vanguardHome() {
    const configured = process.env.VANGUARD_HOME?.trim();
    if (configured !== undefined && configured.length > 0)
        return configured;
    return path.join(os.homedir(), ".vanguard");
}
export function oauthFilePath(file) {
    return path.join(vanguardHome(), file);
}
export async function readJsonFile(file) {
    try {
        return JSON.parse(await readFile(file, "utf8"));
    }
    catch {
        return null;
    }
}
export async function writeJsonFile(file, value) {
    const temp = `${file}.tmp`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
}
export async function removeFile(file) {
    await rm(file, { force: true }).catch(() => { });
}
export function base64url(buffer) {
    return buffer.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
export function decodeJwtClaims(token) {
    try {
        const payload = token.split(".")[1];
        if (payload === undefined)
            return {};
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
            return {};
        return decoded;
    }
    catch {
        return {};
    }
}
export function shortDetail(raw) {
    const text = raw.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
    if (text.length === 0)
        return "";
    if (text.length > 140)
        return "the sign-in service returned an unexpected page (possibly a bot check)";
    return text;
}
