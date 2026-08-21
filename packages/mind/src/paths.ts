// Where the mind lives. Default is under the immortal home, but the memory
// root is PLUGGABLE — point it at a flashdrive and Ares just lives there
// ("make this your home"). That's the whole portability story: one path.
//
// Mind is the foundational layer, so it owns its own home resolution and depends
// on nothing above it. `aresHome` MUST resolve identically to the agent/operator
// home so the whole entity shares one ~/.ares.

import os from "node:os";
import path from "node:path";

export interface MindPaths {
  home: string;
  mindDir: string;
  memoryFile: string;
}

/** Resolve Ares's immortal home (`$ARES_HOME`, or ~/.ares). */
export function aresHome(explicit?: string): string {
  return path.resolve(explicit ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"));
}

export function mindPaths(explicit?: string): MindPaths {
  const home = aresHome(explicit);
  const mindDir = path.join(home, "mind");
  return { home, mindDir, memoryFile: path.join(mindDir, "memory.jsonl") };
}
