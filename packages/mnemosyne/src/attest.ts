// The attestation loop — the accountability half of binding force.
//
// Injecting a rule into context proves nothing; the 2026-08-10 incident was
// precisely a rule that WAS in context and still lost. So Mnemosyne closes the
// loop: each turn the client fetches a binding packet (the always-on set), and
// after the turn it ATTESTS — per binding: honored, violated, or merely
// surfaced. The ledger is append-only JSONL; per-binding stats accumulate on
// the binding files. complianceReport() then surfaces the exact failure class
// that used to be invisible: bindings that keep getting recalled AND violated.

import { promises as fs } from "node:fs";
import path from "node:path";
import { mnemosynePaths } from "./paths.js";
import { loadBindings, saveBinding, type Binding } from "./bindings.js";

export type AttestOutcome = "honored" | "violated" | "surfaced";

export interface AttestationRecord {
  at: string;
  /** The turn (or packet) this attestation reports on. */
  turnId: string;
  bindingId: string;
  outcome: AttestOutcome;
  note?: string;
}

export async function recordAttestations(
  home: string | undefined,
  turnId: string,
  outcomes: ReadonlyArray<{ bindingId: string; outcome: AttestOutcome; note?: string }>,
  now = new Date(),
): Promise<AttestationRecord[]> {
  if (outcomes.length === 0) return [];
  const paths = mnemosynePaths(home);
  const records: AttestationRecord[] = outcomes.map((o) => ({
    at: now.toISOString(),
    turnId,
    bindingId: o.bindingId,
    outcome: o.outcome,
    note: o.note?.slice(0, 300),
  }));
  await fs.mkdir(path.dirname(paths.attestationsFile), { recursive: true });
  await fs.appendFile(paths.attestationsFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  // Roll the stats onto the binding files so compliance is visible without
  // replaying the ledger.
  const bindings = await loadBindings(home);
  const byId = new Map(bindings.map((b) => [b.id, b]));
  for (const record of records) {
    const binding = byId.get(record.bindingId);
    if (!binding) continue;
    binding.stats.attested += 1;
    if (record.outcome === "honored") binding.stats.honored += 1;
    if (record.outcome === "violated") binding.stats.violated += 1;
    binding.stats.lastAttestedAt = record.at;
    await saveBinding(home, binding);
  }
  return records;
}

export async function loadAttestations(
  home?: string,
  opts: { bindingId?: string; limit?: number } = {},
): Promise<AttestationRecord[]> {
  const file = mnemosynePaths(home).attestationsFile;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const records: AttestationRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AttestationRecord;
      if (opts.bindingId && parsed.bindingId !== opts.bindingId) continue;
      records.push(parsed);
    } catch {
      // half-written tail line — skip
    }
  }
  return opts.limit ? records.slice(-opts.limit) : records;
}

export interface ComplianceEntry {
  binding: Binding;
  attested: number;
  honored: number;
  violated: number;
  /** violated / attested (0 when never attested). */
  violationRate: number;
  /** The red flag: repeatedly recalled AND violated — memory without force. */
  recalledButViolated: boolean;
}

export interface ComplianceReport {
  entries: ComplianceEntry[];
  flagged: ComplianceEntry[];
}

/** Threshold for the red flag: 2+ violations and violating more than honoring. */
export function complianceReport(bindings: readonly Binding[]): ComplianceReport {
  const entries: ComplianceEntry[] = bindings.map((binding) => {
    const { attested, honored, violated } = binding.stats;
    const violationRate = attested > 0 ? violated / attested : 0;
    return {
      binding,
      attested,
      honored,
      violated,
      violationRate,
      recalledButViolated: violated >= 2 && violated > honored,
    };
  });
  return { entries, flagged: entries.filter((e) => e.recalledButViolated) };
}
