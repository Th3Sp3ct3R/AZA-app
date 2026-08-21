// Shared production composition for durable child/session surfaces.
//
// A child is more than `new Session(...)`: it needs the workspace hooks, a
// fresh verifier, canonical restart debt, a complete compaction-source
// manifest, and an explicit owner for lifecycle cleanup. Keeping those pieces
// here prevents Task, Conductor, Operator, and Garrison from silently drifting
// into four different coding harnesses.

import { createHash } from "node:crypto";
import { createVerifiedChildSession, loadChildVerificationDebt, type ChildVerificationDebt, type VerifiedChildSession, type VerifiedChildSessionOptions } from "./childSessionVerifier.js";
import { HookManager } from "./hooks.js";
import type { JsonValue, SessionKernelStore } from "./sessionKernel/index.js";
import type { VerifierOptions } from "./verifier.js";

export type ChildSessionSurface = "task" | "conductor" | "operator" | "garrison";
export type ChildSessionCleanupPolicy = "after-turn" | "session-lifetime";

interface ChildSessionProfile {
  compiler: string;
  cleanupPolicy: ChildSessionCleanupPolicy;
}

/** The only implicit policy differences between production child surfaces. */
export const CHILD_SESSION_COMPOSITION_PROFILES: Readonly<Record<ChildSessionSurface, ChildSessionProfile>> = {
  task: {
    compiler: "ares-subagent-context-v1",
    cleanupPolicy: "after-turn",
  },
  conductor: {
    compiler: "ares-conductor-leaf-context-v1",
    cleanupPolicy: "after-turn",
  },
  operator: {
    compiler: "ares-operator-worker-context-v1",
    cleanupPolicy: "after-turn",
  },
  garrison: {
    compiler: "ares-garrison-context-v1",
    cleanupPolicy: "session-lifetime",
  },
};

type CompositionOwnedSessionOption =
  | "systemPrompt"
  | "hookManager"
  | "contextSourceVersions"
  | "summarizeSpan"
  | "sessionKernel";

export interface ChildSessionCompositionOptions
  extends Omit<VerifiedChildSessionOptions, CompositionOwnedSessionOption> {
  surface: ChildSessionSurface;
  /** A function is evaluated once for the Session and again whenever a durable
   * context epoch is captured, so live plan/persona inputs cannot masquerade as
   * the original prompt after compaction or restart. */
  systemPrompt: string | (() => string);
  sessionKernel: SessionKernelStore;
  summarizeSpan?: VerifiedChildSessionOptions["summarizeSpan"];
  verifierOptions?: Omit<VerifierOptions, "workspace">;
  /** Additional live prompt/context inputs. Keys are logical source names; the
   * receipt stores their sha256 under `<name>Sha256`. */
  contextInputs?: () => Readonly<Record<string, unknown>>;
  /** Required by synchronous hosts for restored red sessions. Async callers
   * normally omit this and let the canonical kernel-backed loader resolve it. */
  persistedDebt?: ChildVerificationDebt;
}

export interface ChildSessionCompositionReceipt {
  surface: ChildSessionSurface;
  compiler: string;
  cleanupPolicy: ChildSessionCleanupPolicy;
  hookManager: HookManager;
  persistedDebt: ChildVerificationDebt;
  summarizeSpan?: VerifiedChildSessionOptions["summarizeSpan"];
  /** The same live function installed on Session for durable context epochs. */
  contextSourceVersions: () => Readonly<Record<string, JsonValue>>;
}

export interface ComposedVerifiedChildSession extends VerifiedChildSession {
  composition: ChildSessionCompositionReceipt;
}

const NO_CHILD_DEBT: ChildVerificationDebt = {
  required: false,
  touchedFiles: [],
  scopeComplete: true,
};

/** Compose an ordinary durable child. Hooks and restart debt are loaded from
 * the child workspace/canonical kernel before any Session code can execute. */
export async function composeVerifiedChildSession(
  options: ChildSessionCompositionOptions,
): Promise<ComposedVerifiedChildSession> {
  const sessionId = compositionSessionId(options);
  const [hookManager, persistedDebt] = await Promise.all([
    HookManager.load(options.workspace),
    options.persistedDebt
      ? Promise.resolve(copyDebt(options.persistedDebt))
      : loadCanonicalChildDebt(options, sessionId),
  ]);
  return finishChildSessionComposition(options, hookManager, persistedDebt);
}

/** Garrison's public SessionFactory is intentionally synchronous. This twin
 * performs the same tiny hook-config read synchronously and requires canonical
 * debt to have been preloaded for any existing red/pending session. */
export function composeVerifiedChildSessionSync(
  options: ChildSessionCompositionOptions,
): ComposedVerifiedChildSession {
  const sessionId = compositionSessionId(options);
  const durable = options.sessionKernel.getSession(sessionId);
  if (!options.persistedDebt && durable && requiresRestoredVerification(durable.workOutcome)) {
    throw new Error(
      `synchronous child composition for ${sessionId} requires preloaded canonical verification debt`,
    );
  }
  return finishChildSessionComposition(
    options,
    HookManager.loadSync(options.workspace),
    copyDebt(options.persistedDebt ?? NO_CHILD_DEBT),
  );
}

/** Ephemeral Task/Conductor/Operator ownership helper. The profile, not an
 * ad-hoc caller convention, decides that the verifier is cancelled after the
 * turn. Long-lived Garrison sessions are rejected and must be disposed by the
 * owning session table at replacement/shutdown. */
export async function withComposedVerifiedChildSession<T>(
  options: ChildSessionCompositionOptions,
  run: (child: ComposedVerifiedChildSession) => Promise<T>,
): Promise<T> {
  const child = await composeVerifiedChildSession(options);
  if (child.composition.cleanupPolicy !== "after-turn") {
    await child.dispose();
    throw new Error(
      `${child.composition.surface} sessions use ${child.composition.cleanupPolicy} cleanup and cannot be turn-scoped`,
    );
  }
  try {
    return await run(child);
  } finally {
    await child.dispose();
  }
}

async function loadCanonicalChildDebt(
  options: ChildSessionCompositionOptions,
  sessionId: string,
): Promise<ChildVerificationDebt> {
  const durable = options.sessionKernel.getSession(sessionId);
  if (!durable) return copyDebt(NO_CHILD_DEBT);
  return loadChildVerificationDebt(
    options.sessionKernel,
    options.workspace,
    sessionId,
  );
}

function finishChildSessionComposition(
  options: ChildSessionCompositionOptions,
  hookManager: HookManager,
  persistedDebt: ChildVerificationDebt,
): ComposedVerifiedChildSession {
  const profile = CHILD_SESSION_COMPOSITION_PROFILES[options.surface];
  const prompt = liveString(options.systemPrompt);
  const contextSourceVersions = () => buildChildContextManifest(options, profile);
  const {
    surface: _surface,
    systemPrompt: _systemPrompt,
    summarizeSpan,
    verifierOptions,
    contextInputs: _contextInputs,
    persistedDebt: _persistedDebt,
    ...sessionOptions
  } = options;
  const debt = copyDebt(persistedDebt);
  const verified = createVerifiedChildSession({
    ...sessionOptions,
    systemPrompt: prompt,
    summarizeSpan,
    hookManager,
    contextSourceVersions,
  }, verifierOptions, debt);
  return {
    ...verified,
    composition: {
      surface: options.surface,
      compiler: profile.compiler,
      cleanupPolicy: profile.cleanupPolicy,
      hookManager,
      persistedDebt: copyDebt(debt),
      summarizeSpan,
      contextSourceVersions,
    },
  };
}

function buildChildContextManifest(
  options: ChildSessionCompositionOptions,
  profile: ChildSessionProfile,
): Readonly<Record<string, JsonValue>> {
  const manifest: Record<string, JsonValue> = {
    compiler: profile.compiler,
    systemPromptSha256: sha256(liveString(options.systemPrompt)),
    toolCatalogSha256: sha256(JSON.stringify(options.tools.map((tool) => tool.schema))),
  };
  for (const [name, value] of Object.entries(options.contextInputs?.() ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
      throw new Error(`invalid child context source name '${name}'`);
    }
    const key = `${name}Sha256`;
    if (key in manifest) {
      throw new Error(`duplicate child context source '${name}'`);
    }
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`child context source '${name}' is not JSON-serializable`);
    }
    manifest[key] = sha256(serialized);
  }
  return manifest;
}

function liveString(value: string | (() => string)): string {
  const resolved = typeof value === "function" ? value() : value;
  if (typeof resolved !== "string") throw new Error("child system prompt source must return a string");
  return resolved;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compositionSessionId(options: ChildSessionCompositionOptions): string {
  const sessionId = options.sessionId ?? options.sessionMeta?.id;
  if (!sessionId) throw new Error("durable child composition requires a canonical session id");
  return sessionId;
}

function requiresRestoredVerification(workOutcome: string): boolean {
  return workOutcome === "pending" || workOutcome === "unverified" || workOutcome === "blocked";
}

function copyDebt(debt: ChildVerificationDebt): ChildVerificationDebt {
  return {
    required: debt.required,
    touchedFiles: [...debt.touchedFiles],
    scopeComplete: debt.scopeComplete,
  };
}
