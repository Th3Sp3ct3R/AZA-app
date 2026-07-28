import type { JsonValue, RunEvent } from "./contracts.js";
export interface DurableStateAnchor {
    readonly tool: string;
    readonly sequence: number;
    readonly sha256: string;
}
export interface DurableStateAnchorRequirement {
    /** Require an anchor whenever the durable state file exists. */
    readonly required?: boolean;
    readonly expectedSha256?: string;
}
/** Hashes semantic JSON independent of object key insertion order. */
export declare function durableStateSha256(value: JsonValue): string;
/**
 * Finds the latest committed hash emitted by one runtime-owned state tool.
 * The hash is itself protected by the validated journal chain.
 */
export declare function latestDurableStateAnchor(events: readonly RunEvent[], tool: string): DurableStateAnchor | undefined;
