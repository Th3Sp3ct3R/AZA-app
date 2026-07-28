import type { FileJournal } from "../kernel/fileJournal.js";
import type { CodingSession } from "./session.js";
import { type TreeEntry, type TreeSnapshot } from "./treeSnapshot.js";
export type PatchChange = {
    readonly kind: "add" | "delete" | "modify";
    readonly path: string;
    readonly before?: TreeEntry;
    readonly after?: TreeEntry;
    readonly binary: boolean;
    readonly supported: boolean;
} | {
    readonly kind: "rename";
    readonly fromPath: string;
    readonly toPath: string;
    readonly before: TreeEntry;
    readonly after: TreeEntry;
    readonly binary: boolean;
    readonly supported: boolean;
};
interface PatchManifestCore {
    readonly version: 1;
    readonly sessionId: string;
    readonly baselineRootHash: string;
    readonly candidateRootHash: string;
    readonly changes: readonly PatchChange[];
}
export interface PatchManifest extends PatchManifestCore {
    readonly manifestHash: string;
}
export interface ApplyResult {
    readonly transactionId: string;
    readonly manifestHash: string;
    readonly beforeRootHash: string;
    readonly afterRootHash: string;
    readonly changedPaths: readonly string[];
}
export interface UndoResult {
    readonly transactionId: string;
    readonly restoredRootHash: string;
}
/** Internal fault hooks are public only so adversarial tests can prove recovery. */
export interface TransactionTestOptions {
    readonly failAfterOperation?: number;
    readonly simulateCrashAfterOperation?: number;
}
export declare function reviewSessionChanges(session: CodingSession, journal: FileJournal): Promise<PatchManifest>;
export declare function buildPatchManifest(sessionId: string, baseline: TreeSnapshot, candidate: TreeSnapshot): PatchManifest;
export declare function applyReviewedManifest(session: CodingSession, journal: FileJournal, manifestHash: string, confirmation: string, testOptions?: TransactionTestOptions): Promise<ApplyResult>;
export declare function undoAppliedTransaction(session: CodingSession, journal: FileJournal, transactionId: string, confirmation: string, testOptions?: TransactionTestOptions): Promise<UndoResult>;
/** Rolls incomplete apply/revert operations back to their last committed state. */
export declare function recoverApplyTransactions(session: CodingSession): Promise<readonly string[]>;
export {};
