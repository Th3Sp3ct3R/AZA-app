// Self-model persistence + the outcome-feedback write path.
//
// One JSON document at ~/.ares/self/model.json. Reads are tolerant (a corrupt
// or missing file yields an empty model, never a throw); writes are atomic.
// recordOutcome is the feedback signal: every skill/mission run flows through
// here so the model always reflects reality, not intention.

import { promises as fs } from "node:fs";
import { agentPaths, aresAgentHome } from "../paths.js";
import { writeFileAtomic } from "../files.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";
import {
  type Capability,
  type CapabilityKind,
  type CapabilityOutcomes,
  type CapabilityStatus,
  type CapabilityReliability,
  type SelfModel,
  type SelfSummary,
  emptyOutcomes,
  reliabilityOf,
} from "./types.js";

export function emptyModel(now = new Date()): SelfModel {
  return { version: 1, updatedAt: now.toISOString(), capabilities: {} };
}

export async function loadSelfModel(home = aresAgentHome()): Promise<SelfModel> {
  const file = agentPaths(home).selfModel;
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<SelfModel>;
    if (!parsed || typeof parsed !== "object" || !parsed.capabilities) return emptyModel();
    // Normalize: ensure every capability has an outcomes block.
    for (const cap of Object.values(parsed.capabilities)) {
      if (cap && !cap.outcomes) cap.outcomes = emptyOutcomes();
    }
    return { version: 1, updatedAt: parsed.updatedAt ?? new Date().toISOString(), capabilities: parsed.capabilities };
  } catch {
    return emptyModel();
  }
}

export async function saveSelfModel(home: string, model: SelfModel, now = new Date()): Promise<string> {
  const file = agentPaths(home).selfModel;
  model.updatedAt = now.toISOString();
  await writeFileAtomic(file, JSON.stringify(model, null, 2) + "\n");
  return file;
}

export function getCapability(model: SelfModel, id: string): Capability | undefined {
  return model.capabilities[id];
}

export interface UpsertCapabilityInput {
  id: string;
  kind: CapabilityKind;
  name?: string;
  status?: CapabilityStatus;
  provenance?: string;
  description?: string;
  tags?: string[];
}

/**
 * Create or update a capability node. Emits capability_changed only on a
 * genuine create or status transition, so explicit self-edits pulse the UI
 * but routine outcome writes (recordOutcome) stay quiet.
 */
export async function upsertCapability(home: string, input: UpsertCapabilityInput, now = new Date()): Promise<Capability> {
  const model = await loadSelfModel(home);
  const cap = applyUpsert(model, input, now);
  await saveSelfModel(home, model, now);
  return cap;
}

function applyUpsert(model: SelfModel, input: UpsertCapabilityInput, now: Date): Capability {
  const iso = now.toISOString();
  const existing = model.capabilities[input.id];
  const wasStatus = existing?.status;
  const cap: Capability = existing ?? {
    id: input.id,
    name: input.name ?? input.id,
    kind: input.kind,
    status: input.status ?? "have",
    createdAt: iso,
    updatedAt: iso,
    outcomes: emptyOutcomes(),
  };
  if (input.name !== undefined) cap.name = input.name;
  cap.kind = input.kind;
  if (input.status !== undefined) cap.status = input.status;
  if (input.provenance !== undefined) cap.provenance = input.provenance;
  if (input.description !== undefined) cap.description = input.description;
  if (input.tags !== undefined) cap.tags = input.tags;
  cap.updatedAt = iso;
  model.capabilities[cap.id] = cap;

  const created = !existing;
  const statusChanged = wasStatus !== undefined && wasStatus !== cap.status;
  if (created || statusChanged) {
    emitLifecycle({
      type: "capability_changed",
      capability: cap.name,
      gain: gainForTarget("CAPABILITY", 1, cap.status),
    });
  }
  return cap;
}

export async function dropCapability(home: string, id: string, now = new Date()): Promise<boolean> {
  const model = await loadSelfModel(home);
  if (!model.capabilities[id]) return false;
  delete model.capabilities[id];
  await saveSelfModel(home, model, now);
  return true;
}

export interface RecordOutcomeInput {
  id: string;
  kind: CapabilityKind;
  name?: string;
  ok: boolean;
  ms?: number;
  error?: string;
  provenance?: string;
}

/**
 * The feedback signal. Upserts a successfully demonstrated capability as
 * "have" and an unsuccessful first attempt as "acquiring",
 * then folds one run into its rolling outcome stats. Never pulses — the
 * acting tool already emits its own lifecycle event.
 */
export async function recordOutcome(home: string, input: RecordOutcomeInput, now = new Date()): Promise<Capability> {
  const model = await loadSelfModel(home);
  const iso = now.toISOString();
  const existing = model.capabilities[input.id];
  const cap: Capability = existing ?? {
    id: input.id,
    name: input.name ?? input.id,
    kind: input.kind,
    status: input.ok ? "have" : "acquiring",
    provenance: input.provenance,
    createdAt: iso,
    updatedAt: iso,
    outcomes: emptyOutcomes(),
  };
  if (input.name !== undefined) cap.name = input.name;
  if (input.provenance !== undefined && !cap.provenance) cap.provenance = input.provenance;
  // Only demonstrated success promotes intent/acquisition to possession. A
  // failed placeholder or malformed provider receipt is evidence that the
  // capability is not ready yet, not proof that we have it.
  if (input.ok && (cap.status === "want" || cap.status === "acquiring")) cap.status = "have";

  cap.outcomes = foldOutcome(cap.outcomes, input, iso);
  cap.updatedAt = iso;
  model.capabilities[cap.id] = cap;
  await saveSelfModel(home, model, now);
  return cap;
}

function foldOutcome(prev: CapabilityOutcomes, input: RecordOutcomeInput, iso: string): CapabilityOutcomes {
  const runs = prev.runs + 1;
  const ok = prev.ok + (input.ok ? 1 : 0);
  const fail = prev.fail + (input.ok ? 0 : 1);
  const ms = typeof input.ms === "number" && input.ms >= 0 ? input.ms : undefined;
  // Rolling mean of measured durations only.
  const avgMs = ms === undefined ? prev.avgMs : prev.avgMs === 0 ? ms : Math.round(prev.avgMs + (ms - prev.avgMs) / runs);
  return {
    runs,
    ok,
    fail,
    avgMs,
    lastMs: ms ?? prev.lastMs,
    lastError: input.ok ? prev.lastError : input.error ?? prev.lastError,
    lastUsedAt: iso,
  };
}

export function summarizeSelf(model: SelfModel): SelfSummary {
  const caps = Object.values(model.capabilities).filter((c) => c.status !== "removed");
  let totalRuns = 0;
  let okAll = 0;
  let failAll = 0;
  const rated: CapabilityReliability[] = [];

  for (const c of caps) {
    totalRuns += c.outcomes.runs;
    okAll += c.outcomes.ok;
    failAll += c.outcomes.fail;
    const r = reliabilityOf(c.outcomes);
    if (r !== null) {
      rated.push({ id: c.id, name: c.name, reliability: r, runs: c.outcomes.ok + c.outcomes.fail, lastError: c.outcomes.lastError });
    }
  }

  const decidedAll = okAll + failAll;
  const topReliable = [...rated].sort((a, b) => b.reliability - a.reliability || b.runs - a.runs).slice(0, 5);
  const flaky = rated.filter((r) => r.reliability < 1).sort((a, b) => a.reliability - b.reliability || b.runs - a.runs).slice(0, 5);

  return {
    total: caps.length,
    have: caps.filter((c) => c.status === "have").length,
    want: caps.filter((c) => c.status === "want").length,
    acquiring: caps.filter((c) => c.status === "acquiring").length,
    skills: caps.filter((c) => c.kind === "skill").length,
    totalRuns,
    reliability: decidedAll === 0 ? null : okAll / decidedAll,
    topReliable,
    flaky,
  };
}
