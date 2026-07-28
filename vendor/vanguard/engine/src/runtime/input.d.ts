import type { JsonValue } from "../kernel/contracts.js";
export declare function objectInput(input: JsonValue): Record<string, JsonValue>;
export declare function stringField(input: Record<string, JsonValue>, name: string): string;
export declare function optionalStringField(input: Record<string, JsonValue>, name: string): string | undefined;
export declare function stringArrayField(input: Record<string, JsonValue>, name: string): string[];
