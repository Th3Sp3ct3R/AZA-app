import type { AresAdapterRoute } from "./aresTypes.js";
export type AresBetaMetricName = "session_routed" | "turn_started" | "turn_completed" | "turn_failed" | "fallback_started" | "fallback_completed" | "manual_recovery_required" | "replay_gap" | "kill_switch_applied";
export interface AresBetaMetric {
    readonly version: 1;
    /** UTC day only; intentionally not a precise activity timestamp. */
    readonly day: string;
    readonly name: AresBetaMetricName;
    readonly actor: string;
    readonly session: string;
    readonly route: AresAdapterRoute;
    readonly outcome?: "success" | "failure" | "cancelled";
    readonly reason?: "rollout" | "kill_switch" | "startup" | "protocol" | "critical" | "replay_gap";
    readonly durationBucketMs?: 1_000 | 5_000 | 15_000 | 60_000 | 300_000 | 900_000 | 3_600_000;
}
export interface AresBetaMetricSink {
    record(metric: AresBetaMetric): void | Promise<void>;
}
/**
 * Metadata-only telemetry. The API intentionally has no prompt, response,
 * source path, model, provider, tool arguments, reasoning, or arbitrary tags.
 */
export declare class AresBetaTelemetry {
    #private;
    constructor(secret: string, sink: AresBetaMetricSink, now?: () => Date);
    emit(input: {
        readonly name: AresBetaMetricName;
        readonly actorId: string;
        readonly sessionId: string;
        readonly route: AresAdapterRoute;
        readonly outcome?: AresBetaMetric["outcome"];
        readonly reason?: AresBetaMetric["reason"];
        readonly durationMs?: number;
    }): void;
    pseudonym(namespace: "actor" | "session", value: string): string;
}
