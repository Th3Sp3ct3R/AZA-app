export declare class WorkspaceVersionLedger {
    #private;
    record(relativePath: string, sha256: string): void;
    get(relativePath: string): string | undefined;
    forget(relativePath: string): void;
    /** Every path this session has observed or written through the file tools. */
    paths(): readonly string[];
}
