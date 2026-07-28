import type { JsonValue, RunEventType } from "../kernel/contracts.js";
import type { FileJournal } from "../kernel/fileJournal.js";
export declare function appendSessionEvent(journal: FileJournal, type: RunEventType, data: JsonValue): Promise<void>;
