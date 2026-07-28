export function scoreExecutionQuality(verified, trajectory, patch) {
    const writes = (trajectory.toolCallsByName["write_file"] ?? 0)
        + (trajectory.toolCallsByName["edit_file"] ?? 0);
    const changedFiles = patch.changedFiles.length;
    const penalties = {
        toolFriction: Math.min(0.32, trajectory.toolFrictionFailures * 0.08),
        verificationFailures: Math.min(0.36, trajectory.verificationFailures * 0.12),
        repeatedCompletionClaims: Math.min(0.16, Math.max(0, trajectory.completionClaims - 1) * 0.04),
    };
    const totalPenalty = Object.values(penalties).reduce((sum, value) => sum + value, 0);
    const patchExpansionRatio = patch.beforeLines === 0 ? null : round(patch.afterLines / patch.beforeLines);
    const reviewFlags = [];
    if (patch.beforeLines >= 10 && patchExpansionRatio !== null && patchExpansionRatio > 4) {
        reviewFlags.push("large-patch-expansion");
    }
    if (patch.beforeLines === 0 && patch.afterLines > 300)
        reviewFlags.push("large-new-code-surface");
    if (changedFiles > 0 && writes > changedFiles * 4)
        reviewFlags.push("high-edit-churn");
    if ((trajectory.toolCallsByName["run_command"] ?? 0) > 12)
        reviewFlags.push("high-test-fragmentation");
    return {
        score: verified ? round(Math.max(0, 1 - totalPenalty)) : 0,
        cleanFirstPass: verified
            && trajectory.toolFrictionFailures === 0
            && trajectory.verificationFailures === 0
            && trajectory.completionClaims === 1,
        patchExpansionRatio,
        productiveTestFailures: trajectory.localTestFailures,
        writeIterations: writes,
        reviewFlags,
        penalties,
    };
}
function round(value) {
    return Math.round(value * 1_000) / 1_000;
}
