import { createHash } from "node:crypto";
export const DEFAULT_ARES_VANGUARD_ROLLOUT = Object.freeze({
    enabled: false,
    killSwitch: false,
    stage: "off",
    cohortPercent: 0,
    cohortSalt: "replace-before-enabling",
    requireExplicitOptIn: true,
});
export function decideAresVanguardRollout(config, actorId, optedIn) {
    validateRolloutConfig(config);
    if (typeof optedIn !== "boolean")
        throw new Error("optedIn must be a boolean.");
    const bucket = rolloutBucket(config.cohortSalt, actorId);
    if (config.killSwitch)
        return { useVanguard: false, reason: "kill_switch", bucket };
    if (!config.enabled || config.stage === "off")
        return { useVanguard: false, reason: "disabled", bucket };
    if (config.requireExplicitOptIn && !optedIn)
        return { useVanguard: false, reason: "opt_in_required", bucket };
    const allowlisted = config.allowActorIds?.includes(actorId) === true;
    if (config.stage === "internal") {
        return allowlisted
            ? { useVanguard: true, reason: "eligible", bucket }
            : { useVanguard: false, reason: "outside_cohort", bucket };
    }
    const threshold = config.stage === "full" ? 100 : config.cohortPercent;
    return allowlisted || bucket < threshold
        ? { useVanguard: true, reason: "eligible", bucket }
        : { useVanguard: false, reason: "outside_cohort", bucket };
}
export function validateRolloutConfig(config) {
    if (config === null || typeof config !== "object")
        throw new Error("Rollout config must be an object.");
    if (typeof config.enabled !== "boolean" || typeof config.killSwitch !== "boolean"
        || typeof config.requireExplicitOptIn !== "boolean") {
        throw new Error("Rollout flags must be booleans.");
    }
    if (!(new Set(["off", "internal", "beta", "ramp", "full"])).has(config.stage)) {
        throw new Error("Rollout stage is invalid.");
    }
    if (!Number.isFinite(config.cohortPercent) || config.cohortPercent < 0 || config.cohortPercent > 100) {
        throw new Error("cohortPercent must be between 0 and 100.");
    }
    if (typeof config.cohortSalt !== "string")
        throw new Error("cohortSalt must be a string.");
    if (config.enabled && config.stage !== "off" && config.cohortSalt.length < 16) {
        throw new Error("Enabled rollout requires a non-secret cohortSalt of at least 16 characters.");
    }
    if (!Array.isArray(config.allowActorIds) && config.allowActorIds !== undefined) {
        throw new Error("allowActorIds must be an array when provided.");
    }
    if (config.allowActorIds !== undefined && config.allowActorIds.some((actorId) => (typeof actorId !== "string" || actorId.trim().length === 0 || actorId.length > 500))) {
        throw new Error("allowActorIds entries must be non-empty strings of at most 500 characters.");
    }
}
export function rolloutBucket(salt, actorId) {
    if (typeof actorId !== "string" || actorId.trim().length === 0)
        throw new Error("actorId must be non-empty.");
    const digest = createHash("sha256").update(salt).update("\0").update(actorId).digest();
    return (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
}
