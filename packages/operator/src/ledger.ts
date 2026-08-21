// The capabilities ledger — ONE source of truth.
//
// Before this file there were two: the JSON capability graph (what the planner
// reads) and a hand-maintained CAPABILITIES.md (what the model narrates to
// itself). They diverged — the markdown claimed skills the graph had never
// heard of and pointed at a home that no longer existed. Divergent ledgers are
// poison: the entity believes one thing and plans on another.
//
// Resolution: the JSON graph is authoritative. CAPABILITIES.md is GENERATED
// from it (never hand-edited, never trusted by the planner). `renderCapabilities
// Doc` is a pure function of the graph, so the doc can never silently drift —
// regenerate and it matches reality by construction.

import { agentPaths, writeFileAtomic } from "@ares/agent";
import type { CapabilityNode, CapabilityStatus } from "./capability.js";
import { reliabilityOf } from "./capability.js";

const PREAMBLE = `# Capabilities ledger

_GENERATED FROM the operator capability graph (~/.ares/operator/graph/). Do not
hand-edit — edits are overwritten on the next seed/sync. The JSON graph is the
single source of truth; this file is a human-readable projection of it._

_Status legend: **mastered** (crystallized + verified) · **have** (>=1 verified
success) · **available** (real tool/skill wired, not yet proven) · **learning**
· **want** (gap, no method) · **rotted** (health check failing) · **forbidden**._
`;

const STATUS_ORDER: CapabilityStatus[] = [
  "mastered",
  "have",
  "available",
  "learning",
  "want",
  "rotted",
  "forbidden",
];

const STATUS_HEADING: Record<CapabilityStatus, string> = {
  mastered: "Mastered",
  have: "Have (verified, not yet crystallized)",
  available: "Available (wired, not yet proven)",
  learning: "Learning",
  want: "Want (gap — no method yet)",
  rotted: "Rotted (was working, now failing)",
  forbidden: "Forbidden (ToS/KYC/policy)",
};

function renderNode(node: CapabilityNode): string {
  const methods = (node.methods ?? []).map((m) => `${m.kind}:${m.ref}`).join(", ") || "—";
  const rel = reliabilityOf(node);
  const bits = [
    node.domain ? `domain ${node.domain}` : null,
    `via ${methods}`,
    `${node.outcomes.ok}✓/${node.outcomes.fail}✗`,
    rel === null ? null : `${Math.round(rel * 100)}% reliable`,
    node.requiresHumanApproval ? "**requires human approval**" : null,
  ].filter(Boolean);
  return `- \`${node.id}\` — ${node.name} (${bits.join(", ")})`;
}

/** Pure projection of the capability graph into the ledger markdown. */
export function renderCapabilitiesDoc(nodes: readonly CapabilityNode[]): string {
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sections: string[] = [PREAMBLE];
  for (const status of STATUS_ORDER) {
    const inStatus = sorted.filter((n) => n.status === status);
    if (inStatus.length === 0) continue;
    sections.push(`## ${STATUS_HEADING[status]}\n\n${inStatus.map(renderNode).join("\n")}`);
  }
  sections.push(`_${sorted.length} capabilities — generated ${nodes.length ? "from the live graph" : "(empty graph)"}._`);
  return sections.join("\n\n") + "\n";
}

/** Write the generated ledger to ~/.ares/CAPABILITIES.md from the live graph. */
export async function writeCapabilitiesDoc(home: string, nodes: readonly CapabilityNode[]): Promise<string> {
  const file = agentPaths(home).capabilities;
  await writeFileAtomic(file, renderCapabilitiesDoc(nodes));
  return file;
}
