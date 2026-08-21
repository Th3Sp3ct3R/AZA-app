import type { JsonValue } from "./types.js";

/** Canonical JSON makes idempotency comparisons independent of key order. */
export function canonicalJson(value: JsonValue): string {
  return render(value, new Set<object>());
}

function render(value: JsonValue, seen: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new TypeError("JSON values must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => render(entry, seen)).join(",")}]`;
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${render(entry, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function parseJson(value: string | null): JsonValue | null {
  return value === null ? null : (JSON.parse(value) as JsonValue);
}
