import { type TreeSnapshot } from "./treeSnapshot.js";
export interface SessionLineage {
    readonly parentSessionId: string;
    readonly parentCheckpointId: string;
    readonly parentJournalHash: string;
}
export interface CodingSession {
    readonly id: string;
    readonly sourceRoot: string;
    readonly workspaceRoot: string;
    readonly metadataFile: string;
    readonly baselineFile: string;
    /** Whether the disposable workspace copy exists yet. */
    readonly materialized: boolean;
    /** Source-tree fingerprint captured when the session began. */
    readonly sourceFingerprint?: string;
    /** True when the original project changed between conversation and copy. */
    readonly sourceChangedDuringConversation?: boolean;
    /** Genesis hash used by a forked journal; absent for root sessions. */
    readonly journalGenesisHash?: string;
    /** Cryptographic branch point for forked sessions. */
    readonly lineage?: SessionLineage;
    /**
     * In-place sessions edit the real project directly: workspaceRoot is the
     * source tree and the session-container copy becomes the pristine baseline
     * for review, drift detection, and undo. Persisted metadata always stores
     * the canonical container workspace path; the flip happens at open time.
     */
    readonly inPlace?: true;
    /** Pristine baseline copy for in-place sessions. */
    readonly pristineRoot?: string;
    /**
     * Direct sessions edit the real project with no ceremony at all: no source
     * fingerprint, no pristine copy, no baseline snapshot. The session container
     * still holds the journal, plan, and checkpoints — none of which touch the
     * project tree — but review/apply/undo and time travel have nothing to diff
     * against and are refused. Version control is the user's safety net.
     */
    readonly direct?: true;
    readonly createdAt: string;
}
export interface CreateSessionOptions {
    readonly inPlace?: boolean;
    /** Implies inPlace; skips fingerprints, copies, and baselines entirely. */
    readonly direct?: boolean;
}
export interface MaterializeSessionWorkspaceOptions {
    /**
     * Narrow injection seam for deterministic filesystem-race tests. Production
     * callers should use the default copier by omitting this option.
     * @internal
     */
    readonly copyWorkspace?: (sourceRoot: string, destinationRoot: string) => Promise<void>;
}
export declare function createCodingSession(source: string, options?: CreateSessionOptions): Promise<CodingSession>;
/**
 * Creates the durable session container (journal home, metadata) without
 * copying the project. Conversation happens against the read-only original;
 * the disposable workspace copy is created only when a task contract exists.
 */
export declare function createSessionShell(source: string, options?: CreateSessionOptions): Promise<CodingSession>;
/**
 * Atomically publishes an unmaterialized session at a caller-owned durable
 * location. The initializer runs inside an invisible staging directory, so
 * session metadata and engine-owned configuration become visible together.
 * Concurrent callers targeting the same container converge on the one
 * published session; no age-based lock takeover is used.
 */
export declare function createSessionShellAt(source: string, container: string, initialize?: (stagingRoot: string, session: CodingSession) => Promise<void>, options?: CreateSessionOptions): Promise<CodingSession>;
/**
 * Copies the original project into the disposable workspace. The copy is
 * prepared under a sibling temporary name and renamed into place, so a crash
 * cannot expose a half-materialized execution workspace. A content-addressed
 * baseline is captured at exactly the same boundary for later drift checks.
 * Fingerprints bracketing the copy must agree with the staged tree, preventing
 * a source mutation from publishing a mixed-time workspace snapshot.
 */
export declare function materializeSessionWorkspace(session: CodingSession, options?: MaterializeSessionWorkspaceOptions): Promise<CodingSession>;
/** Creates an isolated child at an already captured checkpoint. */
export declare function createForkedCodingSession(parent: CodingSession, checkpointWorkspace: string, lineage: SessionLineage): Promise<CodingSession>;
export declare function openCodingSession(location: string): Promise<CodingSession>;
export declare function loadSessionBaseline(session: CodingSession): Promise<TreeSnapshot>;
/**
 * Content-addressed source identity used across durable create and later
 * materialization. Paths and entry types are framed explicitly; file bytes
 * and symlink targets, rather than mutable timestamps, determine identity.
 *
 * Speed is a correctness property here: this walk runs before anything else
 * a user sees, and on cloud-synced folders (OneDrive) reading a file forces
 * a download while stat does not. Small files hash content in parallel;
 * files past the large-file threshold are identified by size alone — size
 * survives copying (mtime does not), so materialization checks still hold,
 * at the documented cost that a same-size edit to a huge asset reads as
 * unchanged. Assets that big are not what a coding session is guarding.
 */
export declare function fingerprintSessionSource(root: string): Promise<string>;
export declare function isLockedFileError(error: unknown): boolean;
