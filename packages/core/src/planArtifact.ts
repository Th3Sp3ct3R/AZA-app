import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanRevisionRecord } from "./sessionKernel/index.js";

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Stable workspace-relative projection path. Ordinary session IDs remain
 * human-readable; unsafe, reserved, or path-length-hostile IDs use a stable
 * digest rather than gaining filesystem traversal semantics. */
export function planArtifactRelativePath(sessionId: string): string {
  const safe =
    /^[A-Za-z0-9._-]{1,160}$/.test(sessionId) &&
    sessionId !== "." &&
    sessionId !== ".." &&
    !WINDOWS_RESERVED_BASENAME.test(sessionId)
      ? sessionId
      : `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`;
  return path.join(".ares", "plans", `${safe}.md`);
}

export function planArtifactPath(workspace: string, sessionId: string): string {
  return path.join(path.resolve(workspace), planArtifactRelativePath(sessionId));
}

export function renderApprovedPlanBuildHandoff(plan: PlanRevisionRecord): string {
  const artifact = planArtifactRelativePath(plan.sessionId).split(path.sep).join("/");
  return [
    "APPROVED BUILD HANDOFF (SQLite-authoritative)",
    `Plan revision ID: ${plan.id}`,
    `Plan revision: ${plan.revision}`,
    `Plan SHA-256: ${plan.planHash}`,
    `Readable artifact: ${artifact}`,
    "Execute this exact approved revision. Do not substitute a newer or inferred plan.",
    "Do not repeat work already shown as settled in the conversation. Any refinement requires a new plan revision and a new exact approval.",
    "The canonical approved plan body follows:",
    "<approved-plan>",
    plan.body,
    "</approved-plan>",
  ].join("\n");
}

/** The Markdown body is byte-for-byte the canonical SQLite body after the
 * metadata comment. The hash covers that body only, never this projection. */
export function renderPlanArtifact(plan: PlanRevisionRecord): string {
  return [
    "<!-- ares-plan-v1",
    `session-id: ${JSON.stringify(plan.sessionId)}`,
    `revision-id: ${JSON.stringify(plan.id)}`,
    `revision: ${plan.revision}`,
    `sha256: ${plan.planHash}`,
    "authority: .ares/session-kernel.sqlite",
    "-->",
    "",
  ].join("\n") + plan.body;
}

/** Atomically replace the readable plan projection. SQLite is authoritative;
 * this function is deliberately reusable to heal a missing/stale artifact on
 * an idempotent approval retry or after restart. */
export async function writePlanArtifact(
  workspace: string,
  plan: PlanRevisionRecord,
): Promise<string> {
  const target = planArtifactPath(workspace, plan.sessionId);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${target}.bak`;
  await writeFile(temp, renderPlanArtifact(plan), "utf8");
  try {
    await rename(temp, target);
  } catch {
    // Windows may reject rename-over-existing. Keep the old complete artifact
    // recoverable until the new complete bytes occupy the stable path.
    await rm(backup, { force: true }).catch(() => undefined);
    let backedUp = false;
    try {
      await rename(target, backup);
      backedUp = true;
    } catch {
      // First projection has no target to move aside.
    }
    try {
      await rename(temp, target);
    } catch (error) {
      if (backedUp) await rename(backup, target).catch(() => undefined);
      throw error;
    }
    if (backedUp) await rm(backup, { force: true }).catch(() => undefined);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  return target;
}
