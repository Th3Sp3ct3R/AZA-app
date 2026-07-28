import type { RunEvent } from "./contracts.js";
/**
 * Returns the runtime workspace epoch after replaying the selected journal
 * prefix. The epoch is deliberately logical, not model supplied: successful
 * mutations and child restore/fork boundaries each advance it once.
 */
export declare function journalWorkspaceGeneration(events: readonly RunEvent[], throughSequence?: number): number | undefined;
export declare function validWorkspaceGeneration(value: unknown): value is number;
