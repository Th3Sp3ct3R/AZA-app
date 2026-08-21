// One tools-layer gateway for post-edit feedback. Mutation tools call this
// exactly once after a successful commit/direct approved write, so adapters do
// not independently spawn duplicate formatter/type-check processes.

import {
  PostMutationFeedbackService,
  committedFilesFromReceipt,
  renderPostMutationFeedback,
  type PostMutationCommittedFile,
  type PostMutationFeedback,
  type WorkspaceMutationReceipt,
} from "@ares/core";

export type MutationFeedbackSource = WorkspaceMutationReceipt | readonly PostMutationCommittedFile[];

export async function collectMutationFeedback(
  workspace: string,
  source: MutationFeedbackSource,
): Promise<PostMutationFeedback> {
  const files = Array.isArray(source)
    ? source
    : committedFilesFromReceipt(source as WorkspaceMutationReceipt);
  // The core service has its own total error boundary. Keep this second boundary
  // at the tool integration point: observational feedback can never change a
  // successful editor result into a thrown tool failure.
  try {
    return await new PostMutationFeedbackService(workspace).inspect(files);
  } catch (error) {
    return {
      version: 1,
      workspace,
      status: "incomplete",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      files: [],
      checks: [],
      detail: `Post-edit feedback was unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function appendMutationFeedback(display: string, feedback: PostMutationFeedback | undefined): string {
  if (!feedback) return display;
  const rendered = renderPostMutationFeedback(feedback);
  return rendered ? `${display}\n${rendered}` : display;
}
