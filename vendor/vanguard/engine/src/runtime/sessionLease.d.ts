export interface SessionLease {
    readonly root: string;
    readonly operation: string;
    release(): Promise<void>;
}
/**
 * Cross-process exclusive ownership for any operation that can append to a
 * session journal or observe/mutate its live workspace. Atomic directory
 * rename is the arbitration primitive on both Windows and POSIX.
 */
export declare function acquireSessionLease(sessionRoot: string, operation: string): Promise<SessionLease>;
export declare function withSessionLease<T>(sessionRoot: string, operation: string, work: () => Promise<T>): Promise<T>;
