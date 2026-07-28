export declare const ARES_ROUTE_CLAIM_CAPABILITY: "routes.create.atomic-durable-v1";
export type AresClaimedCore = "vanguard" | "legacy";
export interface AresRouteClaimRequest {
    readonly operationId: string;
    readonly inputFingerprintSha256: string;
    readonly proposedCore: AresClaimedCore;
    readonly policySha256: string;
}
export interface AresDurableRouteClaim {
    readonly version: 1;
    readonly operationIdSha256: string;
    readonly inputFingerprintSha256: string;
    readonly chosenCore: AresClaimedCore;
    readonly adapterSessionId: string;
    readonly policySha256: string;
}
export interface AresRouteClaimResult {
    readonly claim: AresDurableRouteClaim;
    readonly created: boolean;
}
export interface AresRouteReceiptRequest {
    readonly operationId: string;
    readonly source: AresClaimedCore;
    readonly upstreamSessionId: string;
}
export interface AresDurableRouteReceipt {
    readonly version: 1;
    readonly operationIdSha256: string;
    readonly claimSha256: string;
    readonly source: AresClaimedCore;
    readonly upstreamSessionId: string;
    readonly upstreamIdentitySha256: string;
}
export interface AresRouteReceiptResult {
    readonly receipt: AresDurableRouteReceipt;
    readonly created: boolean;
}
export interface AresRouteClaimStorePort {
    capabilities(): readonly string[];
    claim(request: AresRouteClaimRequest): Promise<AresRouteClaimResult>;
    read(operationId: string): Promise<AresDurableRouteClaim | undefined>;
    commitReceipt(request: AresRouteReceiptRequest): Promise<AresRouteReceiptResult>;
    readReceipt(operationId: string): Promise<AresDurableRouteReceipt | undefined>;
}
export interface FileAresRouteClaimStoreOptions {
    readonly root: string;
    /** Test/host crash-seam hook. Context contains digests only. */
    readonly faultInjector?: (point: "claim_published" | "identity_published" | "receipt_published", context: Readonly<{
        operationIdSha256: string;
        recordSha256: string;
    }>) => void | Promise<void>;
}
export type AresRouteClaimStoreErrorCode = "invalid_route_claim_request" | "invalid_route_claim_store" | "route_claim_store_replaced" | "route_claim_corrupt" | "route_claim_conflict" | "route_receipt_conflict" | "upstream_identity_conflict";
export declare class AresRouteClaimStoreError extends Error {
    readonly code: AresRouteClaimStoreErrorCode;
    constructor(code: AresRouteClaimStoreErrorCode, message: string);
}
/**
 * Immutable route arbitration for Ares create operations.
 *
 * The store intentionally has no delete or garbage-collection API. Its root
 * must be writable only by the trusted host identity. Node does not expose
 * openat-style directory handles on every supported platform, so a malicious
 * same-user process that can replace paths during a syscall remains outside
 * this store's trust boundary; stable directory identities and link rejection
 * make replacement before or between calls fail closed.
 */
export declare class FileAresRouteClaimStore implements AresRouteClaimStorePort {
    #private;
    constructor(options: FileAresRouteClaimStoreOptions);
    capabilities(): readonly string[];
    claim(request: AresRouteClaimRequest): Promise<AresRouteClaimResult>;
    read(operationId: string): Promise<AresDurableRouteClaim | undefined>;
    commitReceipt(request: AresRouteReceiptRequest): Promise<AresRouteReceiptResult>;
    readReceipt(operationId: string): Promise<AresDurableRouteReceipt | undefined>;
}
export declare function aresRouteOperationDigest(operationId: string): string;
export declare function aresAdapterSessionIdForOperationDigest(operationIdSha256: string): string;
export declare function aresRouteClaimDigest(claim: AresDurableRouteClaim): string;
export declare function aresUpstreamIdentityDigest(source: AresClaimedCore, upstreamSessionId: string): string;
export declare function validateAresDurableRouteClaim(value: unknown): asserts value is AresDurableRouteClaim;
export declare function validateAresDurableRouteReceipt(value: unknown): asserts value is AresDurableRouteReceipt;
