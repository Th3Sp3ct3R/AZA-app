// Gateway auth token — a random 32-hex secret at <home>/mnemosyne/token,
// created on first boot. Same pattern as the garrison token: loopback binding
// is the real wall; the token keeps other local processes out.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mnemosynePaths } from "./paths.js";

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function tokenPath(home?: string): string {
  return mnemosynePaths(home).tokenFile;
}

export async function ensureToken(home?: string): Promise<string> {
  const file = tokenPath(home);
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (TOKEN_PATTERN.test(existing)) return existing;
  } catch {
    // Missing or unreadable — mint a fresh one.
  }
  const token = randomBytes(16).toString("hex");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, token + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Best-effort on platforms without POSIX modes.
  }
  return token;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
