import { asciiLowercase } from "../deterministicText.js";
export function classifyOutcome(outcome) {
    if (outcome.status === "completed")
        return "verified";
    if (outcome.status !== "failed")
        return "capability_failure";
    const infrastructureMarkers = [
        "inference endpoint returned http",
        "missing credential environment variable",
        "fetch failed",
        "network error",
        "request timed out",
    ];
    const reason = asciiLowercase(outcome.reason);
    if (outcome.reason.startsWith("Model failure:")
        && infrastructureMarkers.some((marker) => reason.includes(marker)))
        return "infrastructure_error";
    return "capability_failure";
}
