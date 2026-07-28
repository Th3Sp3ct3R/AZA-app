import { asciiLowercase } from "../deterministicText.js";
export function analyzeTrajectory(events) {
    let modelDecisions = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    let localTestFailures = 0;
    let testHarnessFailures = 0;
    let toolFrictionFailures = 0;
    let completionClaims = 0;
    let verificationAttempts = 0;
    let verificationFailures = 0;
    let policyBlocks = 0;
    let contextCompactions = 0;
    let contextProjections = 0;
    let recoveryDecisions = 0;
    let retriesScheduled = 0;
    let retriesExhausted = 0;
    let replansRequired = 0;
    let recoveryDelayMs = 0;
    const failuresByCode = {};
    const failuresByDisposition = {};
    const toolCallsByName = {};
    let pendingToolNames = [];
    for (const event of events) {
        const data = record(event.data);
        if (event.type === "model.decided") {
            modelDecisions += 1;
            pendingToolNames = [];
            const calls = data?.kind === "tools" && Array.isArray(data.calls)
                ? data.calls
                : data?.kind === "tool" ? [data.call] : [];
            for (const value of calls) {
                const call = record(value);
                if (typeof call?.name !== "string")
                    continue;
                toolCalls += 1;
                pendingToolNames.push(call.name);
                toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
            }
            if (data?.kind === "complete")
                completionClaims += 1;
        }
        if (event.type === "tool.failed") {
            toolFailures += 1;
            const serialized = asciiLowercase(JSON.stringify(event.data));
            const output = record(data?.output);
            const failedToolName = typeof data?.tool === "string" ? data.tool : pendingToolNames[0];
            const isLocalTestFailure = (failedToolName === "run_command" || failedToolName === "check_project")
                && typeof output?.exitCode === "number";
            const isHarnessFailure = isLocalTestFailure && (serialized.includes("syntaxerror") && serialized.includes("[eval")
                || serialized.includes("err_eval_esm_cannot_print"));
            if (isHarnessFailure) {
                testHarnessFailures += 1;
                toolFrictionFailures += 1;
            }
            else if (isLocalTestFailure)
                localTestFailures += 1;
            else
                toolFrictionFailures += 1;
            if (serialized.includes("process policy")
                || serialized.includes("evidence policy")
                || serialized.includes("workspace mutation policy")
                || serialized.includes("outside the declared editable roots"))
                policyBlocks += 1;
        }
        if (event.type === "tool.completed" || event.type === "tool.failed") {
            const completedName = typeof data?.tool === "string" ? data.tool : undefined;
            const index = completedName === undefined ? 0 : pendingToolNames.indexOf(completedName);
            if (index >= 0)
                pendingToolNames.splice(index, 1);
            else
                pendingToolNames.shift();
        }
        if (event.type === "verification.completed") {
            verificationAttempts += 1;
            if (data?.passed === false)
                verificationFailures += 1;
        }
        if (event.type === "context.compacted") {
            if (data?.operation === "request_projection" && data.durableHistoryChanged === false) {
                contextProjections += 1;
            }
            else {
                contextCompactions += 1;
            }
        }
        if (event.type === "recovery.decided") {
            recoveryDecisions += 1;
            if (data?.retry === true)
                retriesScheduled += 1;
            const failure = record(data?.failure);
            if (typeof failure?.code === "string") {
                failuresByCode[failure.code] = (failuresByCode[failure.code] ?? 0) + 1;
            }
            if (typeof failure?.disposition === "string") {
                failuresByDisposition[failure.disposition] = (failuresByDisposition[failure.disposition] ?? 0) + 1;
            }
        }
        if (event.type === "recovery.delayed" && typeof data?.delayMs === "number") {
            recoveryDelayMs += data.delayMs;
        }
        if (event.type === "recovery.exhausted")
            retriesExhausted += 1;
        if (event.type === "recovery.replan_required")
            replansRequired += 1;
    }
    return {
        modelDecisions,
        toolCalls,
        toolFailures,
        localTestFailures,
        testHarnessFailures,
        toolFrictionFailures,
        completionClaims,
        verificationAttempts,
        verificationFailures,
        policyBlocks,
        contextCompactions,
        contextProjections,
        recoveryDecisions,
        retriesScheduled,
        retriesExhausted,
        replansRequired,
        recoveryDelayMs,
        failuresByCode,
        failuresByDisposition,
        toolCallsByName,
    };
}
function record(value) {
    return value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object" ? value : undefined;
}
