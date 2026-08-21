// Atomic file write (temp + rename) — same discipline as @ares/mind's io, kept
// local because mind deliberately doesn't export it.

import path from "node:path";
import { promises as fs } from "node:fs";

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Windows can refuse a rename over a just-written target; retry once after unlink.
    try {
      await fs.unlink(file);
      await fs.rename(tmp, file);
    } catch {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}
