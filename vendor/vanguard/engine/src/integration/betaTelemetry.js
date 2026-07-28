import { createHmac } from "node:crypto";
export class AresBetaTelemetry {
    #secret;
    #sink;
    #now;
    constructor(secret, sink, now = () => new Date()) {
        if (typeof secret !== "string" || secret.length < 32) {
            throw new Error("Beta telemetry pseudonym secret must be at least 32 characters.");
        }
        if (sink === null || typeof sink !== "object" || typeof sink.record !== "function") {
            throw new Error("Beta telemetry sink must provide record(metric).");
        }
        if (typeof now !== "function")
            throw new Error("Beta telemetry clock must be a function.");
        this.#secret = secret;
        this.#sink = sink;
        this.#now = now;
    }
    emit(input) {
        try {
            if (!validMetricInput(input))
                return;
            const metric = {
                version: 1,
                day: this.#now().toISOString().slice(0, 10),
                name: input.name,
                actor: this.pseudonym("actor", input.actorId),
                session: this.pseudonym("session", input.sessionId),
                route: input.route,
                ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
                ...(input.reason === undefined ? {} : { reason: input.reason }),
                ...(input.durationMs === undefined ? {} : { durationBucketMs: durationBucket(input.durationMs) }),
            };
            const result = this.#sink.record(Object.freeze(metric));
            if (result !== undefined)
                void Promise.resolve(result).catch(() => { });
        }
        catch {
        }
    }
    pseudonym(namespace, value) {
        if (namespace !== "actor" && namespace !== "session")
            throw new Error("Pseudonym namespace is invalid.");
        if (typeof value !== "string" || value.length === 0)
            throw new Error("Pseudonym input must be non-empty.");
        const digest = createHmac("sha256", this.#secret).update(namespace).update("\0").update(value).digest("hex");
        return `${namespace === "actor" ? "u" : "s"}_${digest.slice(0, 24)}`;
    }
}
const METRIC_NAMES = new Set([
    "session_routed",
    "turn_started",
    "turn_completed",
    "turn_failed",
    "fallback_started",
    "fallback_completed",
    "manual_recovery_required",
    "replay_gap",
    "kill_switch_applied",
]);
const ROUTES = new Set(["vanguard", "legacy", "manual_recovery"]);
const OUTCOMES = new Set(["success", "failure", "cancelled"]);
const REASONS = new Set([
    "rollout", "kill_switch", "startup", "protocol", "critical", "replay_gap",
]);
function validMetricInput(input) {
    return input !== null
        && typeof input === "object"
        && METRIC_NAMES.has(input.name)
        && ROUTES.has(input.route)
        && typeof input.actorId === "string"
        && input.actorId.length > 0
        && input.actorId.length <= 500
        && typeof input.sessionId === "string"
        && input.sessionId.length > 0
        && input.sessionId.length <= 500
        && (input.outcome === undefined || OUTCOMES.has(input.outcome))
        && (input.reason === undefined || REASONS.has(input.reason))
        && (input.durationMs === undefined || typeof input.durationMs === "number");
}
function durationBucket(durationMs) {
    const bounded = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 3_600_000;
    const buckets = [1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000];
    return buckets.find((bucket) => bounded <= bucket) ?? 3_600_000;
}
