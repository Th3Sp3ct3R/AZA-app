export declare function vanguardHome(): string;
export declare function oauthFilePath(file: string): string;
/** Parse a stored token file, or null when absent/corrupt. Never throws. */
export declare function readJsonFile(file: string): Promise<unknown>;
export declare function writeJsonFile(file: string, value: unknown): Promise<void>;
export declare function removeFile(file: string): Promise<void>;
export declare function base64url(buffer: Buffer): string;
/**
 * Decode a JWT payload without verifying it. The id_token here arrives over TLS
 * from the token endpoint we just called, and is read only for display claims
 * (email, plan) and the account id header — never for an authorization decision.
 */
export declare function decodeJwtClaims(token: string): Record<string, unknown>;
/** Truncate provider error bodies so an HTML challenge page never reaches the UI. */
export declare function shortDetail(raw: string): string;
