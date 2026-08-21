// Acquisition — turning "I can't do X yet" into a durable build job (Ares v5 / O4–O5).
//
// When Ares hits a capability it doesn't have, it doesn't shrug or ask for magic
// words: it ACQUIRES. acquireCapability() mints three durable artifacts that
// survive the process dying, then hands them to the Operator's Worker loop:
//
//   1. a capability-graph node (status "learning") — the competence asset,
//   2. a reality-verifiable Goal — what "done" actually means,
//   3. a build packet on disk — the brief the Worker reads to build it.
//
// The Worker (QueryEngineDispatcher) drives the Goal; reality verification (O3)
// decides if it worked; recordOutcome() promotes the node learning → have. This
// is the self-extension loop made concrete: a gap becomes a job becomes a skill.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseCapabilityReceipt, writeFileAtomic, type CapabilityReceipt } from "@ares/agent";
import { operatorPaths } from "./paths.js";
import { createGoal } from "./goal.js";
import { loadGoal, newGoalId, saveGoal } from "./store.js";
import { createCapability, type CapabilityNode } from "./capability.js";
import { loadCapability, saveCapability, slugify } from "./graphStore.js";
import type { Goal, VerificationSpec } from "./types.js";

/** How Ares intends to satisfy the capability — the method ladder, cheapest first. */
export type AcquisitionKind = "skill" | "connector" | "tool" | "mcp" | "script";

export type AcquisitionStatus = "queued" | "building" | "acquired" | "blocked";

export interface Acquisition {
  id: string;
  capabilityName: string;
  capabilityId: string;
  kind: AcquisitionKind;
  goalId: string;
  /** Path to the human/Worker-readable build brief. */
  packetFile: string;
  /** Sub-capabilities this one composes from (graph edges). */
  requires: string[];
  /** Files the Worker is expected to create/modify. */
  targetFiles: string[];
  /** Task-specific behavioral contract carried into every resumed Worker. */
  description?: string;
  /** Provider authoring scope. This does not confine its runtime target. */
  scope?: "workspace" | "user";
  workspace?: string;
  targetRoot?: string;
  status: AcquisitionStatus;
  /** Minimal immutable proof pointer retained when the acquisition crosses the
   * final truth boundary. The full provider receipt remains in the tool/session
   * settlement log; this prevents a plain status write from impersonating it. */
  verification?: AcquisitionVerification;
  createdAt: string;
  updatedAt: string;
}

export interface AcquisitionVerification {
  providerId: string;
  providerHash: string;
  operation: string;
  targetRoot: string;
  verifiedAt: string;
}

export interface AcquisitionHealthcheckProof {
  ok: boolean;
  receipt?: CapabilityReceipt;
  expectedProviderId: string;
  expectedOperation: string;
}

export interface AcquisitionResult {
  capability: CapabilityNode;
  acquisition: Acquisition;
  goal: Goal;
}

export interface AcquireCapabilityInput {
  home: string;
  capabilityName: string;
  kind?: AcquisitionKind;
  requires?: string[];
  targetFiles?: string[];
  description?: string;
  scope?: "workspace" | "user";
  workspace?: string;
  /** May be absolute or workspace-relative; never clamped to the authoring
   * registry or to Ares's own repository. */
  targetRoot?: string;
  /** What reality must show for the acquisition to count as done (O3). */
  verification?: VerificationSpec;
  now?: Date;
}

function acquisitionFile(home: string, id: string): string {
  return path.join(operatorPaths(home).acquisitionsDir, `${id}.json`);
}

function newAcquisitionId(): string {
  return `acq_${randomUUID().slice(0, 8)}`;
}

/**
 * Acquire a capability Ares doesn't have yet: mint the graph node, a verifiable
 * goal, and a build packet, then persist all three. Pass the result's goal to a
 * QueryEngineDispatcher (via runGoalToCompletion) to actually build it.
 */
export async function acquireCapability(input: AcquireCapabilityInput): Promise<AcquisitionResult> {
  const name = input.capabilityName.trim();
  if (!name) throw new Error("acquireCapability requires a capabilityName");

  const home = input.home;
  const kind: AcquisitionKind = input.kind ?? "skill";
  const requires = (input.requires ?? []).filter(Boolean);
  const targetFiles = (input.targetFiles ?? []).filter(Boolean);
  const description = input.description?.trim() || undefined;
  const scope = input.scope;
  const workspace = input.workspace ? path.resolve(input.workspace) : undefined;
  const targetRoot = input.targetRoot
    ? path.resolve(workspace ?? process.cwd(), input.targetRoot)
    : workspace;
  const at = (input.now ?? new Date()).toISOString();

  // Idempotent acquisition: repeated `ensure` calls across turns/restarts must
  // reconnect to one durable job instead of creating parallel workers that
  // race to author the same provider.
  const existing = (await listAcquisitions(home)).find((candidate) =>
    candidate.kind === kind &&
    candidate.capabilityName.localeCompare(name, undefined, { sensitivity: "accent" }) === 0 &&
    candidate.scope === scope &&
    candidate.workspace === workspace &&
    candidate.targetRoot === targetRoot &&
    (candidate.status === "queued" || candidate.status === "building")
  );
  if (existing) {
    const [capability, goal] = await Promise.all([
      loadCapability(home, existing.capabilityId),
      loadGoal(home, existing.goalId),
    ]);
    if (capability && goal) return { capability, acquisition: existing, goal };
  }

  // 1. The competence asset, in the durable graph.
  const capabilityId = `${kind}/${slugify(name)}`;
  const capability = createCapability({
    id: capabilityId,
    name,
    requires,
    status: "learning",
    now: input.now,
  });
  await saveCapability(home, capability);

  // Allocate packet identity before the goal so every mortal Worker receives
  // the exact durable brief path, rather than merely being told one exists.
  const id = newAcquisitionId();
  const packetFile = path.join(operatorPaths(home).acquisitionsDir, `${id}.packet.md`);

  // 2. The reality-verifiable goal the Worker drives.
  const goal = createGoal({
    id: newGoalId(),
    statement: buildGoalStatement({
      name,
      kind,
      requires,
      targetFiles,
      packetFile,
      description,
      scope,
      workspace,
      targetRoot,
    }),
    verification: input.verification,
  });
  await saveGoal(home, goal);

  // 3. The build packet — the brief the Worker reads.
  await writeFileAtomic(packetFile, buildPacket({
    id,
    name,
    kind,
    capabilityId,
    goalId: goal.id,
    requires,
    targetFiles,
    description,
    scope,
    workspace,
    targetRoot,
    home,
  }));

  const acquisition: Acquisition = {
    id,
    capabilityName: name,
    capabilityId,
    kind,
    goalId: goal.id,
    packetFile,
    requires,
    targetFiles,
    description,
    scope,
    workspace,
    targetRoot,
    status: "queued",
    createdAt: at,
    updatedAt: at,
  };
  await writeFileAtomic(acquisitionFile(home, id), JSON.stringify(acquisition, null, 2) + "\n");

  return { capability, acquisition, goal };
}

export async function listAcquisitions(home: string): Promise<Acquisition[]> {
  const dir = operatorPaths(home).acquisitionsDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Acquisition[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Acquisition);
    } catch {
      // skip corrupt record
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  return out;
}

/** Persist one explicit lifecycle transition. Only a contract-valid healthcheck
 * settlement may move a build to `acquired`; authoring files is not proof. */
export async function setAcquisitionStatus(
  home: string,
  id: string,
  status: Exclude<AcquisitionStatus, "acquired">,
  now = new Date(),
): Promise<Acquisition> {
  if ((status as AcquisitionStatus) === "acquired") {
    throw new Error("acquired requires markAcquisitionAcquired with a validated healthcheck receipt");
  }
  const file = acquisitionFile(home, id);
  let acquisition: Acquisition;
  try {
    acquisition = JSON.parse(await fs.readFile(file, "utf8")) as Acquisition;
  } catch (error) {
    throw new Error(`acquisition not found: ${id}`, { cause: error });
  }
  const next = { ...acquisition, status, updatedAt: now.toISOString() };
  await writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** The only acquisition-record promotion path. A worker finishing, files
 * appearing, or a process exiting zero are insufficient: the exact declared
 * provider healthcheck must have returned a contract-valid successful receipt. */
export async function markAcquisitionAcquired(
  home: string,
  id: string,
  proof: AcquisitionHealthcheckProof,
  now = new Date(),
): Promise<Acquisition> {
  if (!proof.ok || !proof.receipt) {
    throw new Error("acquisition promotion requires a successful healthcheck run and receipt");
  }
  const receipt = parseCapabilityReceipt(proof.receipt, `acquisition ${id} healthcheck`);
  if (!receipt.ok) throw new Error("acquisition healthcheck receipt reports failure");
  if (receipt.providerId !== proof.expectedProviderId) {
    throw new Error(`acquisition healthcheck provider mismatch: expected ${proof.expectedProviderId}, got ${receipt.providerId}`);
  }
  if (receipt.operation !== proof.expectedOperation) {
    throw new Error(`acquisition healthcheck operation mismatch: expected ${proof.expectedOperation}, got ${receipt.operation}`);
  }

  const file = acquisitionFile(home, id);
  let acquisition: Acquisition;
  try {
    acquisition = JSON.parse(await fs.readFile(file, "utf8")) as Acquisition;
  } catch (error) {
    throw new Error(`acquisition not found: ${id}`, { cause: error });
  }
  const verifiedAt = now.toISOString();
  const next: Acquisition = {
    ...acquisition,
    status: "acquired",
    verification: {
      providerId: receipt.providerId,
      providerHash: receipt.providerHash,
      operation: receipt.operation,
      targetRoot: receipt.targetRoot,
      verifiedAt,
    },
    updatedAt: verifiedAt,
  };
  await writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

function buildGoalStatement(input: {
  name: string;
  kind: AcquisitionKind;
  requires: string[];
  targetFiles: string[];
  packetFile: string;
  description?: string;
  scope?: "workspace" | "user";
  workspace?: string;
  targetRoot?: string;
}): string {
  const parts = [`Acquire the "${input.name}" capability, implemented as a ${input.kind}.`];
  parts.push(`Read and follow the durable acquisition packet at ${input.packetFile}.`);
  if (input.description) parts.push(`Required behavior: ${input.description}`);
  if (input.scope) parts.push(`Author the reusable provider in ${input.scope} scope.`);
  if (input.workspace) parts.push(`Acquisition workspace: ${input.workspace}.`);
  if (input.targetRoot) parts.push(`Prove it against the owner-selected target root: ${input.targetRoot}.`);
  if (input.requires.length) parts.push(`Compose it from existing sub-capabilities: ${input.requires.join(", ")}.`);
  if (input.targetFiles.length) parts.push(`Expected artifacts: ${input.targetFiles.join(", ")}.`);
  parts.push("Build the smallest working provider, run its read-only healthcheck against reality, and require a contract-valid success receipt before claiming done.");
  return parts.join(" ");
}

function buildPacket(p: {
  id: string;
  name: string;
  kind: AcquisitionKind;
  capabilityId: string;
  goalId: string;
  requires: string[];
  targetFiles: string[];
  description?: string;
  scope?: "workspace" | "user";
  workspace?: string;
  targetRoot?: string;
  home: string;
}): string {
  const registry = p.scope === "workspace" && p.workspace
    ? path.join(p.workspace, ".ares", "skills")
    : path.join(p.home, "skills");
  return `# Acquisition packet — ${p.name}

- **acquisition**: ${p.id}
- **kind**: ${p.kind}
- **capability id**: ${p.capabilityId}
- **goal id**: ${p.goalId}
- **composes**: ${p.requires.length ? p.requires.join(", ") : "(nothing yet — novel)"}
- **target files**: ${p.targetFiles.length ? p.targetFiles.join(", ") : "(Worker decides)"}
- **provider scope**: ${p.scope ?? "(Worker decides)"}
- **provider registry**: ${registry}
- **acquisition workspace**: ${p.workspace ?? "(current Operator workspace)"}
- **owner-selected runtime target**: ${p.targetRoot ?? "(select at invocation time)"}

## Required behavior
${p.description ?? `Provide the namespaced capability \`${p.name}\` and prove its declared operations.`}

## Brief
Acquire the ability to **${p.name}** as a \`${p.kind}\`. Take the cheapest, most
grounded method that works, escalating only if it must:

1. **Reuse** — can existing sub-capabilities (${p.requires.join(", ") || "none registered"}) already compose this?
2. **CLI / API** — is there a tool already on PATH or an API with creds present?
3. **Skill** — write the provider under \`${registry}\` and run it against the selected target.
4. **Tool / connector** — only if a new primitive in \`packages/\` is truly required.

For a skill/provider, create a strict \`capability.json\` beside \`SKILL.md\`
and \`handler.js\`. The contract declares namespaced capabilities, operations,
and their real effects; its healthcheck MUST reference a declared read-only
operation. Keep the provider environment-neutral: invocation receives the
owner-selected \`targetRoot\`, so it can operate on any chosen project rather
than being tied to the directory where the skill was authored. When this is an
environment/editor provider, fill \`match.files\` and \`match.commands\` with
the concrete project/CLI patterns it recognizes. Those manifest matchers—not a
hard-coded engine list—let Ares rediscover and route the adapter automatically.

Build the smallest version that works, then **verify against reality**: invoke
the healthcheck through RunSkill, inspect its validated receipt/evidence, and
confirm the goal's verification probe passes. A scaffold, manifest, process
exit 0, or handler return shaped like \`{ok:false}\` is NOT acquired. Do not
claim the capability on a hopeful guess.
`;
}
