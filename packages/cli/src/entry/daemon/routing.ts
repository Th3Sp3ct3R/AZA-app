// Routing-table normalization for the daemon's set_routing command.

import type { RouteAssignments } from "@ares/core";

export const ROUTING_LANES = ["chat", "coding", "research", "tool-use"] as const;

/** Normalize the UI's {provider,model} routing table into core's {family,model}. */
export function normalizeRoutingCommand(raw: unknown): RouteAssignments {
  const out: RouteAssignments = {};
  if (!raw || typeof raw !== "object") return out;
  for (const lane of ROUTING_LANES) {
    const entry = (raw as Record<string, unknown>)[lane];
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const family = typeof rec.family === "string" ? rec.family : typeof rec.provider === "string" ? rec.provider : "";
      const model = typeof rec.model === "string" ? rec.model : "";
      if (family && model) out[lane] = { family, model };
    }
  }
  return out;
}
