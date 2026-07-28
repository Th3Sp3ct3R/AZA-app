import type { RunEvent } from "./contracts.js";
/**
 * Returns the auditable journal events that belong to the current logical
 * execution branch. An in-place restore keeps the abandoned suffix in the
 * hash-chained journal, but step/retry budgets and model context must resume
 * from the checkpoint branch point rather than replaying that suffix.
 */
export declare function logicalRunEvents(events: readonly RunEvent[]): readonly RunEvent[];
