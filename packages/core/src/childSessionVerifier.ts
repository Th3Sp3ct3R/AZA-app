// Production verifier composition for durable child Sessions.
//
// Task and Conductor used to set `requireVerificationEvidence` without giving
// their child QueryEngine a verifier. That made the proof gate honest (writes
// stayed unverified), but incapable of ever producing the fresh, child-local
// evidence needed to become verified. Keep the full composition in one place so
// every durable child gets the same scheduler, end gate, evidence snapshot, and
// lifecycle cleanup.

import path from "node:path";
import { Session, type SessionOptions } from "./session.js";
import type { SessionKernelStore } from "./sessionKernel/index.js";
import { ContinuousVerifier, type VerifierOptions } from "./verifier.js";

type VerifierOwnedSessionOption =
  | "confirmTurnEnd"
  | "requireVerificationEvidence"
  | "verificationEvidence"
  | "outstandingVerificationRequired"
  | "persistedVerificationDebt"
  | "persistedVerificationScopeComplete"
  | "observedMutationAt";

export type VerifiedChildSessionOptions = Omit<SessionOptions, VerifierOwnedSessionOption>;

/** Verification debt restored from a prior durable child turn. The touched
 * scope is rescheduled in the NEW child verifier, so an old green result can
 * never certify a resumed mutation. */
export interface ChildVerificationDebt {
  required: boolean;
  touchedFiles: string[];
  /** False means canonical mutation rows do not enumerate the complete scope. */
  scopeComplete: boolean;
}

export interface VerifiedChildSession {
  session: Session;
  verifier: ContinuousVerifier;
  /** True only for a child with at least one mutation-capable tool. */
  requiresProof: boolean;
  dispose(): Promise<void>;
}

const NO_CHILD_DEBT: ChildVerificationDebt = {
  required: false,
  touchedFiles: [],
  scopeComplete: true,
};

/** The child equivalent of the interactive session's completion barrier. */
export async function confirmChildTurnEnd(
  verifier: ContinuousVerifier,
): Promise<Array<{ text: string; source: "verifier" | "hook" }>> {
  const configured = Number(process.env.ARES_VERIFY_SETTLE_MS);
  const settleMs = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
  await verifier.settle(settleMs);
  return verifier.drainReminders().map((reminder) => ({
    text: `${reminder.text}

Fix this before finishing. The child workspace is red; establish whether this change introduced the failure or it is a documented baseline issue, and provide evidence either way.`,
    source: "verifier" as const,
  }));
}

/**
 * Construct one Session + one ContinuousVerifier for a durable Task/Conductor
 * child. Scheduling happens below Session's event tap, before QueryEngine
 * resumes past the yielded tool event and evaluates its completion gate.
 */
export function createVerifiedChildSession(
  options: VerifiedChildSessionOptions,
  verifierOptions: Omit<VerifierOptions, "workspace"> = {},
  persistedDebt: ChildVerificationDebt = NO_CHILD_DEBT,
): VerifiedChildSession {
  const requiresProof = options.tools.some((tool) => tool.schema.safety !== "read-only");
  const restoredDebt = requiresProof && persistedDebt.required;
  const verifier = new ContinuousVerifier({
    ...verifierOptions,
    workspace: options.workspace,
  });
  const upstreamReminders = options.drainSystemReminders;
  let observedMutationAt = 0;
  let currentTurnMutation = false;
  let unsubscribe = () => {};

  // A resumed red child must earn a NEW verifier generation. Merely restoring
  // old prose/tool results is not proof that its present child workspace is
  // green. If the persisted scope is incomplete, leave the debt fail-closed.
  if (restoredDebt && persistedDebt.touchedFiles.length > 0) {
    verifier.scheduleFor(persistedDebt.touchedFiles);
  }

  try {
    const session = new Session({
      ...options,
      drainSystemReminders: () => [
        ...(upstreamReminders?.() ?? []),
        ...verifier.drainReminders(),
      ],
      confirmTurnEnd: () => confirmChildTurnEnd(verifier),
      requireVerificationEvidence: requiresProof,
      verificationEvidence: () => verifier.evidenceSnapshot(),
      outstandingVerificationRequired: () => requiresProof && (restoredDebt || currentTurnMutation),
      persistedVerificationDebt: () => restoredDebt,
      persistedVerificationScopeComplete: () => !restoredDebt || persistedDebt.scopeComplete,
      // Persisted debt is deliberately not a current-turn mutation timestamp.
      // The generation-aware persisted-debt branch accepts only the new run we
      // scheduled above; current child edits use this timestamp as usual.
      observedMutationAt: () => observedMutationAt,
    });
    unsubscribe = session.observeEvents((event) => {
      if ((event.type === "tool_end" || event.type === "tool_error") && event.touchedFiles?.length) {
        currentTurnMutation = true;
        observedMutationAt = Date.now();
        verifier.scheduleFor(event.touchedFiles);
      }
    });

    let disposed = false;
    return {
      session,
      verifier,
      requiresProof,
      async dispose() {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        await verifier.cancel();
      },
    };
  } catch (error) {
    unsubscribe();
    void verifier.cancel();
    throw error;
  }
}

/** Recover affected scope only from the canonical kernel. JSONL is a readable
 * audit sidecar and is deliberately never restart authority: legacy red rows
 * without canonical mutation records remain fail-closed with incomplete scope. */
export async function loadChildVerificationDebt(
  kernel: SessionKernelStore,
  workspace: string,
  sessionId: string,
): Promise<ChildVerificationDebt> {
  const workStatus = kernel.requireSession(sessionId).workOutcome;
  if (workStatus !== "unverified" && workStatus !== "blocked" && workStatus !== "pending") {
    return { ...NO_CHILD_DEBT, touchedFiles: [] };
  }

  const touched = new Set<string>();
  let scopeTruncated = false;
  let scopeComplete = true;
  const mutations = kernel.listUnresolvedSessionMutations(sessionId);
  for (const mutation of mutations) {
    if (!mutation.scopeComplete) scopeComplete = false;
    for (const file of mutation.affectedPaths) {
      const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(workspace, file);
      if (!touched.has(absolute) && touched.size >= 240) {
        scopeTruncated = true;
        scopeComplete = false;
        continue;
      }
      touched.add(absolute);
    }
  }

  const touchedFiles = [...touched];
  return {
    required: true,
    touchedFiles,
    // A canonical red outcome with no mutation rows is still debt (upgrade or
    // unknown crash window), but it cannot claim exact affected-file coverage.
    scopeComplete: touchedFiles.length > 0 && scopeComplete && !scopeTruncated,
  };
}
