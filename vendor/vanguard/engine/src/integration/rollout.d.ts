export type AresRolloutStage = "off" | "internal" | "beta" | "ramp" | "full";
export interface AresVanguardRolloutConfig {
    /** Master feature flag. Off by default. */
    readonly enabled: boolean;
    /** Emergency override. A dynamic config provider makes this live. */
    readonly killSwitch: boolean;
    readonly stage: AresRolloutStage;
    readonly cohortPercent: number;
    readonly cohortSalt: string;
    readonly allowActorIds?: readonly string[];
    readonly requireExplicitOptIn: boolean;
}
export declare const DEFAULT_ARES_VANGUARD_ROLLOUT: Readonly<AresVanguardRolloutConfig>;
export interface AresRolloutDecision {
    readonly useVanguard: boolean;
    readonly reason: "eligible" | "disabled" | "kill_switch" | "opt_in_required" | "outside_cohort";
    readonly bucket: number;
}
export type AresRolloutConfigProvider = () => AresVanguardRolloutConfig;
export declare function decideAresVanguardRollout(config: AresVanguardRolloutConfig, actorId: string, optedIn: boolean): AresRolloutDecision;
export declare function validateRolloutConfig(config: AresVanguardRolloutConfig): void;
/** Stable across processes and independent of JavaScript hash implementation. */
export declare function rolloutBucket(salt: string, actorId: string): number;
