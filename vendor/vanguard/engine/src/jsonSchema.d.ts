import type { JsonValue } from "./kernel/contracts.js";
/**
 * Validate a JSON value against the deliberately small JSON-schema subset
 * accepted by Vanguard tool definitions. The validator is dependency-free so
 * the kernel, extension boundary, and MCP adapter all enforce identical rules.
 */
export declare function validateJsonSchema(value: JsonValue, schema: JsonValue): readonly string[];
/** Validate that a schema uses only Vanguard's supported declaration subset. */
export declare function validateSchemaDefinition(schema: JsonValue, label: string): void;
