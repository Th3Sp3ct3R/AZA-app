import type { JournalPort, RunEvent } from "./contracts.js";
export declare class MemoryJournal implements JournalPort {
    readonly events: RunEvent[];
    append(event: RunEvent): Promise<void>;
    readValidated(): Promise<readonly RunEvent[]>;
}
