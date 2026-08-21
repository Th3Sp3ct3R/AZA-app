// Gateway auth token — a random 32-hex secret at <home>/garrison/token,
// created on first boot. Loopback binding is the real wall; the token keeps
// other local processes from driving the daemon. File mode is restricted
// best-effort (chmod is advisory on Windows ACL filesystems).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function garrisonDir(home: string): string {
  return path.join(home, "garrison");
}

export function tokenPath(home: string): string {
  return path.join(garrisonDir(home), "token");
}

/**
 * Read the token at <home>/garrison/token, creating it (32 hex chars) when
 * missing or corrupt. Idempotent: every caller in one home sees one token.
 */
export async function ensureToken(home: string): Promise<string> {
  const file = tokenPath(home);
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (TOKEN_PATTERN.test(existing)) return existing;
  } catch {
    // Missing or unreadable — fall through and mint a fresh one.
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

/** The READ-ONLY companion token at <home>/garrison/token-read. A client that
 *  says hello with this one can list, attach and replay history, but every
 *  write frame (send/interrupt/permission/approval) is refused — safe to put
 *  on a phone via the viewer without handing over the keys to the session. */
export function readTokenPath(home: string): string {
  return path.join(garrisonDir(home), "token-read");
}

export async function ensureReadToken(home: string): Promise<string> {
  const file = readTokenPath(home);
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

/** Timing-safe string comparison for token checks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Burn comparable time; length is already observable from the wire anyway.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
