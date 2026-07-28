import { type VanguardCreateOperationStoreOptions } from "./types.js";
export interface DurableCreateClaim {
    readonly version: 1;
    readonly operationIdSha256: string;
    /** Digest of the normalized, caller-supplied request before repo discovery. */
    readonly requestSha256: string;
    /** Digest of the canonical effective run configuration. */
    readonly configSha256: string;
    readonly sessionId: string;
    /** Source-tree identity captured before the durable session is published. */
    readonly sourceFingerprint: string;
    readonly runConfigurationSha256: string;
    readonly runConfiguration: unknown;
}
export interface DurableCreateReceipt {
    readonly version: 1;
    readonly operationIdSha256: string;
    readonly requestSha256: string;
    readonly configSha256: string;
    readonly sessionId: string;
    readonly sourceFingerprint: string;
    readonly runConfigurationSha256: string;
}
export interface DurableOwnershipLease {
    readonly version: 1;
    readonly operationIdSha256: string;
    readonly ownerToken: string;
    readonly epoch: number;
}
/** Permanent, CAS-published operation claims. There are no stale leases. */
export declare class FileCreateOperationStore {
    #private;
    constructor(options: VanguardCreateOperationStoreOptions);
    operationDirectory(operationIdSha256: string): string;
    sessionRoot(operationIdSha256: string): string;
    reserve(proposed: DurableCreateClaim): Promise<{
        readonly claim: DurableCreateClaim;
        readonly created: boolean;
    }>;
    readClaim(operationIdSha256: string): Promise<DurableCreateClaim | undefined>;
    readReceipt(operationIdSha256: string): Promise<DurableCreateReceipt | undefined>;
    validatePersistedClaim(expected: DurableCreateClaim): Promise<string>;
    commitReceipt(receipt: DurableCreateReceipt): Promise<DurableCreateReceipt>;
    acquireOwnership(operationIdSha256: string, ownerToken: string): Promise<DurableOwnershipLease>;
    assertOwnershipSync(lease: DurableOwnershipLease): void;
    releaseOwnership(lease: DurableOwnershipLease): Promise<void>;
}
export declare function createOperationIdDigest(operationId: string): string;
export declare function canonicalDigest(value: unknown): string;
export declare function sessionIdFor(operationIdSha256: string): string;
