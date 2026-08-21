// Capability — one engine-agnostic door into Ares's learned provider registry.
//
// The core harness does not know about Unity, Unreal, Godot, Blender, or any
// future environment. Providers describe themselves with capability.json;
// this tool discovers the best visible provider, classifies its declared
// operation before admission, and executes it through the isolated skill
// runtime. Workspace-local providers deliberately shadow user-global ones.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { buildTool, type RichToolContext } from "@ares/tools";
import { emitLifecycle } from "../lifecycle/bus.js";
import { aresAgentHome } from "../paths.js";
import { gainForTarget } from "../voice.js";
import { recordOutcome } from "../self/store.js";
import { runSkill, type SkillRunResult } from "../skills/runtime.js";
import {
  parseCapabilityManifest,
  type CapabilityEffect,
  type CapabilityManifest,
} from "../skills/manifest.js";
import {
  resolveCapabilityProvider,
  scanCapabilityRegistry,
  type CapabilityProvider,
  type CapabilityRegistrySnapshot,
} from "../skills/registry.js";

const actionSchema = z.enum(["list", "resolve", "invoke", "healthcheck", "ensure"]);

const inputSchema = z
  .object({
    action: actionSchema.describe(
      "list providers, resolve one without executing it, invoke an operation, run its healthcheck, or ensure a missing capability is acquired",
    ),
    provider_id: z.string().trim().min(1).optional().describe("Exact provider id from capability.json."),
    name: z.string().trim().min(1).optional().describe("Exact local skill/provider directory name."),
    capability: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Engine-agnostic capability id to resolve or ensure, such as scene/observe or editor/mutate."),
    operation: z.string().trim().min(1).optional().describe("Declared provider operation to invoke."),
    arguments: z.unknown().optional().describe("JSON-serializable arguments passed to the provider handler."),
    target_root: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Directory the provider should act on. May be any absolute directory; relative paths resolve from the active workspace.",
      ),
    timeout_ms: z.number().int().positive().max(600_000).optional(),
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("For ensure: what the missing capability must accomplish and how reality can prove it."),
    scope: z.enum(["workspace", "user"]).optional().describe("Preferred provider scope when ensuring a capability."),
    requires: z.array(z.string().trim().min(1)).max(64).optional(),
    target_files: z.array(z.string().trim().min(1)).max(128).optional(),
  })
  .strict();

export type CapabilityToolAction = z.infer<typeof actionSchema>;
export type CapabilityToolInput = z.infer<typeof inputSchema>;

export interface CapabilityEnsureRequest {
  capability: string;
  description?: string;
  scope: "workspace" | "user";
  requires: string[];
  targetFiles: string[];
  targetRoot?: string;
  home: string;
  workspace: string;
  sessionId: string;
  signal: AbortSignal;
}

export type CapabilityEnsureStatus = "queued" | "building" | "available" | "blocked";

export interface CapabilityEnsureOutcome {
  status: CapabilityEnsureStatus;
  /** Host-owned durable acquisition/goal metadata. */
  result?: unknown;
  /** A contract-validated healthcheck run. `available` is rejected without it. */
  verification?: SkillRunResult;
  error?: string;
}

export type CapabilityEnsureCallback = (
  request: CapabilityEnsureRequest,
  context: RichToolContext,
) => Promise<CapabilityEnsureOutcome>;

export interface CapabilityToolOptions {
  home?: string;
  workspace: string;
  /** Preload the registry so dynamic safety can be decided synchronously on
   * the very first invocation. Calls refresh this snapshot, so skills forged
   * during a long session become visible without rebuilding the engine. */
  initialSnapshot?: CapabilityRegistrySnapshot;
  /** Acquisition stays above @ares/agent. The CLI injects Operator's durable
   * acquisition path; embedders can supply their own or omit ensure entirely. */
  ensure?: CapabilityEnsureCallback;
}

export interface CapabilityProviderView {
  id: string;
  name: string;
  scope: "workspace" | "user";
  kind: CapabilityManifest["kind"];
  version: string;
  description: string;
  skillDir: string;
  provides: CapabilityManifest["provides"];
  operations: CapabilityManifest["operations"];
  healthcheck: CapabilityManifest["healthcheck"];
}

export interface CapabilityToolOutput {
  action: CapabilityToolAction;
  ok: boolean;
  provider?: CapabilityProviderView | null;
  providers?: CapabilityProviderView[];
  registryErrors?: CapabilityRegistrySnapshot["errors"];
  operation?: string;
  targetRoot?: string;
  result?: unknown;
  receipt?: SkillRunResult["receipt"];
  touchedFiles?: string[];
  logs?: string;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  acquisition?: unknown;
  status?: CapabilityEnsureStatus | "unavailable";
  error?: string;
}

/** Build a Capability tool around a mutable registry snapshot. The static
 * schema is read-only so list/resolve remain available in plan mode. Admission
 * still uses dynamicSafety for each concrete call, preventing ensure/mutation
 * from slipping through plan mode or the permission gate. */
export function makeCapabilityTool(options: CapabilityToolOptions) {
  const home = aresAgentHome(options.home);
  const workspace = options.workspace;
  let snapshot: CapabilityRegistrySnapshot = options.initialSnapshot ?? {
    roots: [],
    providers: [],
    errors: [],
  };

  const refresh = async (activeWorkspace = workspace): Promise<CapabilityRegistrySnapshot> => {
    snapshot = await scanCapabilityRegistry({ home, workspace: activeWorkspace });
    return snapshot;
  };

  return buildTool({
    name: "Capability",
    description:
      "Discover and use Ares's engine-agnostic capability providers. Providers are learned skills with a strict capability.json contract, so do not hard-code a product-specific path into the harness. Use list/resolve to inspect available operations (safe in plan mode), invoke to act through a resolved provider, healthcheck to verify one, and ensure when the required capability is missing so Ares can durably acquire an adapter. Workspace-local providers override user-global providers. target_root may be any owner-selected directory.",
    safety: "read-only",
    dynamicSafety: (input) => classifyCapabilitySafety(input, snapshot.providers),
    concurrency: "exclusive",
    watchdogTimeoutMs: 0,
    inputZod: inputSchema,
    activityDescription: (input) => {
      const subject = input.capability ?? input.provider_id ?? input.name ?? "providers";
      return `Capability ${input.action} ${subject}`;
    },

    async call(input, ctx): Promise<{
      output: CapabilityToolOutput;
      touchedFiles?: string[];
      display: string;
      failure?: string;
    }> {
      const activeWorkspace = ctx.workspace || workspace;

      if (input.action === "list") {
        const current = await refresh(activeWorkspace);
        const providers = current.providers.filter((provider) => matchesOptionalQuery(provider, input));
        return {
          output: {
            action: input.action,
            ok: current.errors.length === 0,
            providers: providers.map(providerView),
            registryErrors: current.errors,
          },
          display: `${providers.length} capability provider${providers.length === 1 ? "" : "s"}`,
        };
      }

      if (input.action === "ensure") {
        const capability = input.capability?.trim();
        if (!capability) throw new Error("Capability ensure requires capability");
        const existing = await resolveCapabilityProvider(
          { capability },
          { home, workspace: activeWorkspace },
        );
        if (existing) {
          await refresh(activeWorkspace);
          const verification = await runProviderHealthcheck({
            provider: existing,
            home,
            workspace: activeWorkspace,
            targetRoot: input.target_root,
            sessionId: ctx.sessionId,
            signal: ctx.signal,
            timeoutMs: input.timeout_ms,
          });
          await recordProviderOutcome(home, existing, verification);
          const status: CapabilityEnsureStatus = verification.ok ? "available" : "blocked";
          return {
            output: {
              action: input.action,
              ok: verification.ok,
              provider: providerView(existing),
              status,
              operation: existing.manifest.healthcheck.operation,
              targetRoot: verification.targetRoot,
              result: verification.result,
              receipt: verification.receipt,
              touchedFiles: verification.touchedFiles,
              logs: verification.logs,
              durationMs: verification.durationMs,
              error: verification.error,
            },
            display: verification.ok
              ? `capability available: ${capability} via ${existing.manifest.id}`
              : `capability healthcheck failed: ${truncate(verification.error ?? "unknown error", 120)}`,
            failure: verification.ok ? undefined : verification.error ?? "capability healthcheck failed",
          };
        }
        if (!options.ensure) {
          const error = "Capability acquisition is not configured in this host";
          return {
            output: { action: input.action, ok: false, provider: null, status: "unavailable", error },
            display: error,
            failure: error,
          };
        }

        ctx.emitProgress?.({
          kind: "capability_progress",
          phase: "acquiring",
          capability,
          scope: input.scope ?? "workspace",
        });
        const ensured = await options.ensure(
          {
            capability,
            description: input.description,
            scope: input.scope ?? "workspace",
            requires: input.requires ?? [],
            targetFiles: input.target_files ?? [],
            targetRoot: input.target_root,
            home,
            workspace: activeWorkspace,
            sessionId: ctx.sessionId,
            signal: ctx.signal,
          },
          ctx,
        );
        const current = await refresh(activeWorkspace);
        const provider = current.providers.find((candidate) => capability in candidate.manifest.provides) ?? null;
        const verification = ensured.verification;
        const verifiedAvailable = !!provider && healthcheckProvesProvider(provider, verification);
        if (provider && verification) await recordProviderOutcome(home, provider, verification);
        let status: CapabilityEnsureStatus = verifiedAvailable ? "available" : ensured.status;
        let error: string | undefined = ensured.error;
        if (ensured.status === "available" && !verifiedAvailable) {
          status = "blocked";
          error = provider
            ? "Acquisition claimed available without a successful contract-valid healthcheck receipt"
            : "Acquisition claimed available but no provider is registered";
        }
        ctx.emitProgress?.({
          kind: "capability_progress",
          phase: status,
          capability,
          providerId: provider?.manifest.id,
          error: error ?? verification?.error,
        });
        return {
          output: {
            action: input.action,
            ok: status !== "blocked",
            provider: provider ? providerView(provider) : null,
            acquisition: ensured.result,
            status,
            operation: verification?.receipt?.operation,
            targetRoot: verification?.targetRoot,
            result: verification?.result,
            receipt: verification?.receipt,
            touchedFiles: verification?.touchedFiles,
            logs: verification?.logs,
            durationMs: verification?.durationMs,
            timedOut: verification?.timedOut,
            aborted: verification?.aborted,
            error: error ?? verification?.error,
          },
          touchedFiles: verification?.touchedFiles.length ? verification.touchedFiles : undefined,
          display: status === "available"
            ? `capability acquired: ${capability} via ${provider!.manifest.id}`
            : status === "blocked"
              ? `capability acquisition blocked: ${error ?? verification?.error ?? capability}`
              : `capability acquisition ${status}: ${capability}`,
          failure: status === "blocked" ? error ?? verification?.error ?? "capability acquisition blocked" : undefined,
        };
      }

      const query = requiredQuery(input);
      const provider = await resolveCapabilityProvider(query, { home, workspace: activeWorkspace });
      await refresh(activeWorkspace);
      if (!provider) {
        const requested = input.capability ?? input.provider_id ?? input.name ?? "requested provider";
        const error = `No enabled capability provider resolves '${requested}'. Use Capability ensure to acquire it.`;
        return {
          output: { action: input.action, ok: false, provider: null, error },
          display: error,
          failure: error,
        };
      }

      if (input.action === "resolve") {
        return {
          output: { action: input.action, ok: true, provider: providerView(provider) },
          display: `resolved ${provider.manifest.id} (${provider.scope})`,
        };
      }

      const operation = input.action === "healthcheck"
        ? provider.manifest.healthcheck.operation
        : resolveInvokeOperation(provider.manifest, input);
      const timeoutMs = input.timeout_ms ?? (
        input.action === "healthcheck" ? provider.manifest.healthcheck.timeoutMs : undefined
      );
      ctx.emitProgress?.({
        kind: "capability_progress",
        phase: input.action === "healthcheck" ? "healthchecking" : "invoking",
        providerId: provider.manifest.id,
        operation,
        targetRoot: input.target_root ?? activeWorkspace,
      });
      const run = await runSkill({
        home,
        workspace: activeWorkspace,
        name: provider.name,
        input: input.arguments,
        targetRoot: input.target_root,
        operation,
        timeoutMs,
        signal: ctx.signal,
        sessionId: ctx.sessionId,
      });
      await recordProviderOutcome(home, provider, run);
      ctx.emitProgress?.({
        kind: "capability_progress",
        phase: run.ok ? "completed" : "failed",
        providerId: provider.manifest.id,
        operation,
        touchedFiles: run.touchedFiles,
        error: run.error,
      });

      const output: CapabilityToolOutput = {
        action: input.action,
        ok: run.ok,
        provider: providerView(provider),
        operation,
        targetRoot: run.targetRoot,
        result: run.result,
        receipt: run.receipt,
        touchedFiles: run.touchedFiles,
        logs: run.logs,
        durationMs: run.durationMs,
        timedOut: run.timedOut,
        aborted: run.aborted,
        error: run.error,
      };
      return {
        output,
        touchedFiles: run.touchedFiles.length ? run.touchedFiles : undefined,
        display: run.ok
          ? `${input.action} ${provider.manifest.id}.${operation} (${run.durationMs}ms)`
          : `${provider.manifest.id}.${operation} failed: ${truncate(run.error ?? "unknown error", 120)}`,
        failure: run.ok ? undefined : run.error ?? "capability provider failed",
      };
    },
  });
}

function providerView(provider: CapabilityProvider): CapabilityProviderView {
  return {
    id: provider.manifest.id,
    name: provider.name,
    scope: provider.scope,
    kind: provider.manifest.kind,
    version: provider.manifest.version,
    description: provider.manifest.description,
    skillDir: provider.dir,
    provides: provider.manifest.provides,
    operations: provider.manifest.operations,
    healthcheck: provider.manifest.healthcheck,
  };
}

function requiredQuery(input: CapabilityToolInput): { id?: string; capability?: string; name?: string } {
  if (!input.provider_id && !input.capability && !input.name) {
    throw new Error(`Capability ${input.action} requires provider_id, capability, or name`);
  }
  return { id: input.provider_id, capability: input.capability, name: input.name };
}

function matchesOptionalQuery(provider: CapabilityProvider, input: CapabilityToolInput): boolean {
  if (input.provider_id && provider.manifest.id !== input.provider_id) return false;
  if (input.name && provider.name !== input.name) return false;
  if (input.capability && !(input.capability in provider.manifest.provides)) return false;
  return true;
}

function resolveInvokeOperation(manifest: CapabilityManifest, input: CapabilityToolInput): string {
  const operation = input.operation ?? (
    input.capability ? manifest.provides[input.capability] : undefined
  ) ?? singleProvidedOperation(manifest);
  if (!operation) {
    throw new Error(
      `Capability invoke for '${manifest.id}' requires operation (the provider exposes multiple operations)`,
    );
  }
  if (!manifest.operations[operation]) {
    throw new Error(`Capability provider '${manifest.id}' does not declare operation '${operation}'`);
  }
  return operation;
}

function singleProvidedOperation(manifest: CapabilityManifest): string | undefined {
  const operations = [...new Set(Object.values(manifest.provides))];
  return operations.length === 1 ? operations[0] : undefined;
}

function classifyCapabilitySafety(
  input: CapabilityToolInput,
  providers: readonly CapabilityProvider[],
): CapabilityEffect {
  if (input.action === "list" || input.action === "resolve") return "read-only";
  if (input.action === "ensure") return "workspace-write";

  const cached = providers.find((provider) => matchesOptionalQuery(provider, input));
  const manifest = cached ? rereadMatchingManifest(cached, input) : null;
  if (!manifest) return "external-state";
  const operation = input.action === "healthcheck"
    ? manifest.healthcheck.operation
    : input.operation ?? (input.capability ? manifest.provides[input.capability] : undefined) ?? singleProvidedOperation(manifest);
  return operationEffect(manifest, operation);
}

/** Re-read cached metadata synchronously at the admission boundary. A provider
 * edited after engine startup must not retain an obsolete, weaker safety tier.
 * New/unresolvable/invalid providers fall back to external-state. */
function rereadMatchingManifest(
  provider: CapabilityProvider,
  input: CapabilityToolInput,
): CapabilityManifest | null {
  try {
    const manifest = parseCapabilityManifest(JSON.parse(readFileSync(provider.manifestPath, "utf8")), provider.manifestPath);
    if (manifest.scope !== provider.scope) return null;
    if (input.provider_id && manifest.id !== input.provider_id) return null;
    if (input.capability && !(input.capability in manifest.provides)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function operationEffect(manifest: CapabilityManifest, operation: string | undefined): CapabilityEffect {
  if (!operation || !manifest.operations[operation]) return "external-state";
  return manifest.operations[operation].effect;
}

async function runProviderHealthcheck(input: {
  provider: CapabilityProvider;
  home: string;
  workspace: string;
  targetRoot?: string;
  sessionId: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<SkillRunResult> {
  return runSkill({
    home: input.home,
    workspace: input.workspace,
    name: input.provider.name,
    input: { reason: "capability-ensure" },
    targetRoot: input.targetRoot,
    operation: input.provider.manifest.healthcheck.operation,
    timeoutMs: input.timeoutMs ?? input.provider.manifest.healthcheck.timeoutMs,
    signal: input.signal,
    sessionId: input.sessionId,
  });
}

function healthcheckProvesProvider(
  provider: CapabilityProvider,
  verification: SkillRunResult | undefined,
): boolean {
  return !!verification?.ok &&
    verification.receipt?.providerId === provider.manifest.id &&
    verification.receipt.operation === provider.manifest.healthcheck.operation;
}

async function recordProviderOutcome(
  home: string,
  provider: CapabilityProvider,
  run: SkillRunResult,
): Promise<void> {
  emitLifecycle({
    type: "skill_ran",
    name: provider.name,
    ok: run.ok,
    durationMs: run.durationMs,
    gain: gainForTarget("SKILL", 1, run.ok ? "ran" : "failed"),
  });
  try {
    await recordOutcome(home, {
      id: `skill/${provider.name}`,
      kind: "skill",
      name: provider.name,
      ok: run.ok,
      ms: run.durationMs,
      error: run.error,
      provenance: `Capability:${provider.manifest.id}`,
    });
  } catch {
    // The provider result remains authoritative even if optional self-model
    // telemetry cannot be written. Never invert a successful tool outcome.
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
