// Mnemosyne filesystem layout. Lives under the same immortal home as the rest
// of the mind (~/.ares or $ARES_HOME), in its own mnemosyne/ subtree.

import path from "node:path";
import { aresHome } from "@ares/mind";

export interface MnemosynePaths {
  home: string;
  mnemosyneDir: string;
  /** One JSON file per binding. */
  bindingsDir: string;
  /** Append-only attestation ledger (JSONL). */
  attestationsFile: string;
  /** Gateway auth token. */
  tokenFile: string;
  /** The living-memory substrate Mnemosyne is the single writer of. */
  memoryFile: string;
  /** The sync read-through mirror the CLI prompt composer reads (LAWS.md). */
  lawsFile: string;
}

export function mnemosynePaths(explicit?: string): MnemosynePaths {
  const home = explicit ?? aresHome();
  const mnemosyneDir = path.join(home, "mnemosyne");
  return {
    home,
    mnemosyneDir,
    bindingsDir: path.join(mnemosyneDir, "bindings"),
    attestationsFile: path.join(mnemosyneDir, "attestations.jsonl"),
    tokenFile: path.join(mnemosyneDir, "token"),
    memoryFile: path.join(home, "mind", "memory.jsonl"),
    lawsFile: path.join(home, "LAWS.md"),
  };
}
