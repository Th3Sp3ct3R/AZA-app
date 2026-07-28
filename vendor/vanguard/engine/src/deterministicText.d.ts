/**
 * Locale-independent ordering for persisted, hashed, signed, or otherwise
 * reproducibility-sensitive text. JavaScript relational string comparison is
 * defined over UTF-16 code units and does not consult ICU or the host locale.
 */
export declare function compareOrdinal(left: string, right: string): number;
/** Fold protocol identifiers and policy markers without consulting ICU. */
export declare function asciiLowercase(value: string): string;
/** Fold environment names and error codes without consulting ICU. */
export declare function asciiUppercase(value: string): string;
/**
 * Deterministic Unicode case mapping for filesystem paths. Unlike the locale
 * variants, this cannot change with the machine's configured locale.
 */
export declare function lowercaseInvariant(value: string): string;
