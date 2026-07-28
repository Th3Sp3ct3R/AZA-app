import { FileJournal } from "../kernel/fileJournal.js";
import { type CodingSession } from "./session.js";
export interface SessionCheckpoint {
    readonly version: 1;
    readonly id: string;
    readonly sessionId: string;
    readonly rootHash: string;
    readonly journalHash: string;
    readonly journalSequence: number;
    readonly journalGenesisHash?: string;
    readonly parentCheckpointId?: string;
    readonly label?: string;
    readonly createdAt: string;
}
export interface RestoreResult {
    readonly checkpointId: string;
    readonly fromRootHash: string;
    readonly restoredRootHash: string;
    /** Exact logical journal branch point restored with the workspace. */
    readonly checkpointJournalHash: string;
    readonly checkpointJournalSequence: number;
    readonly checkpointRootHash: string;
}
export interface ForkResult {
    readonly checkpointId: string;
    readonly parentSessionId: string;
    readonly parentJournalHash: string;
    readonly session: CodingSession;
    readonly journalFile: string;
}
export declare function createSessionCheckpoint(session: CodingSession, journal: FileJournal, label?: string): Promise<SessionCheckpoint>;
export declare function listSessionCheckpoints(session: CodingSession): Promise<readonly SessionCheckpoint[]>;
export declare function restoreSessionCheckpoint(session: CodingSession, journal: FileJournal, checkpointId: string, confirmation: string, options?: {
    readonly simulateCrashAfterOldMove?: boolean;
}): Promise<RestoreResult>;
/** Any interrupted swap is rolled back to the pre-restore workspace. */
export declare function recoverSessionRestore(session: CodingSession): Promise<boolean>;
export declare function forkSessionCheckpoint(parent: CodingSession, parentJournal: FileJournal, checkpointId: string): Promise<ForkResult>;
