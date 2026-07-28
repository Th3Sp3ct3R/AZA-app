import type { JournalPort, RunEvent } from "./contracts.js";
export declare const JOURNAL_GENESIS_HASH: string;
export interface JournalTip {
    readonly hash: string;
    readonly sequence: number;
}
export declare class FileJournal implements JournalPort {
    #private;
    readonly file: string;
    readonly genesisHash: string;
    private constructor();
    static open(file: string, options?: {
        readonly genesisHash?: string;
    }): Promise<FileJournal>;
    append(event: RunEvent): Promise<void>;
    readValidated(): Promise<readonly RunEvent[]>;
    tip(): Promise<JournalTip>;
}
