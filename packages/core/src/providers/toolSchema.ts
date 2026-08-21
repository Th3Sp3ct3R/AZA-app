// Tool-schema narrowing for OpenAI-shaped providers.
//
// Anthropic accepts full JSON Schema. The OpenAI-compatible world does not, and
// it is not one dialect but many: OpenRouter fans a request out to whichever
// upstream is cheapest/available, so the SAME model can be served by a provider
// that accepts unions and, on the next request, by one that hard-rejects them.
// That is how this surfaced:
//
//   Google AI Studio → 429, OpenRouter failed over to another provider →
//   422 "auto tool schemas do not support multi-type anyOf/oneOf unions"
//
// Nothing about the request had changed; the upstream had. And the offending
// schema was ours: Grep's `path` and `glob` are `string | string[]`, which Zod
// renders as `anyOf: [{type:"string"},{type:"array",…}]`. So the whole tool belt
// was rejected — not just Grep — and every turn on that route died.
//
// The fix is to narrow, not to give up expressiveness everywhere: Anthropic
// still gets the real schema, and the OpenAI-shaped wire gets a version stated
// in the subset those endpoints agree on. Narrowing is lossy ON PURPOSE and the
// loss is recorded in the description, so the model is told in prose what the
// schema can no longer say.
//
// MCP tools make this load-bearing beyond our own belt: their schemas come from
// third-party servers we do not control and cannot audit, and any one of them
// can carry a union that kills every turn on a strict upstream.

/** JSON Schema keywords that OpenAI-shaped tool endpoints commonly reject. */
const DROPPED_KEYWORDS = new Set(["$schema", "$id", "$ref", "$defs", "definitions", "not", "if", "then", "else"]);

/**
 * Rewrite a JSON Schema into the conservative subset OpenAI-shaped tool
 * endpoints accept.
 *
 * - `anyOf`/`oneOf` collapse to their first concretely-typed branch.
 * - `allOf` merges shallowly (the common "base + extras" shape).
 * - multi-type `type: ["string","null"]` collapses to the first non-null type.
 * - meta/logic keywords that these endpoints choke on are dropped.
 *
 * Descriptions are preserved and, where a branch was discarded, extended so the
 * model still learns the shapes it may send — our tools accept the wider input
 * at runtime regardless of what the schema was able to declare.
 */
export function narrowToolSchema(schema: unknown): unknown {
  return narrow(schema, 0);
}

function narrow(node: unknown, depth: number): unknown {
  // Depth guard: a self-referential schema from an MCP server must not be able
  // to hang a turn before it even reaches the model.
  if (depth > 24) return { type: "string" };
  if (Array.isArray(node)) return node.map((n) => narrow(n, depth + 1));
  if (!node || typeof node !== "object") return node;

  const src = node as Record<string, unknown>;
  const union = pickUnion(src);
  let base: Record<string, unknown> = src;
  let discarded: string[] = [];

  if (union) {
    const { chosen, rest } = chooseBranch(union.branches);
    if (chosen) {
      // The union's own siblings (description, title) outrank the branch's, so
      // merge branch-first.
      base = { ...chosen, ...omit(src, [union.key]) };
      discarded = rest;
    } else {
      base = omit(src, [union.key]);
    }
  }

  if (Array.isArray(base.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const part of base.allOf) {
      if (part && typeof part === "object" && !Array.isArray(part)) Object.assign(merged, part);
    }
    base = { ...merged, ...omit(base, ["allOf"]) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "type" && Array.isArray(value)) {
      // ["string","null"] → "string". Optionality is carried by `required`,
      // which these endpoints do understand.
      const concrete = value.find((t) => typeof t === "string" && t !== "null");
      if (typeof concrete === "string") out.type = concrete;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        props[prop] = narrow(sub, depth + 1);
      }
      out.properties = props;
      continue;
    }
    if (key === "items" || key === "additionalProperties" || key === "prefixItems") {
      out[key] = narrow(value, depth + 1);
      continue;
    }
    out[key] = value;
  }

  if (discarded.length > 0) {
    const existing = typeof out.description === "string" ? out.description : "";
    const note = `Also accepts ${discarded.join(" or ")}.`;
    out.description = existing ? `${existing} ${note}` : note;
  }
  // A property with no type at all is rejected by some endpoints just as firmly
  // as a union is. Only fill one in when there is nothing else to go on.
  if (out.type === undefined && out.enum === undefined && out.properties === undefined) out.type = "string";
  return out;
}

function pickUnion(src: Record<string, unknown>): { key: string; branches: unknown[] } | null {
  for (const key of ["anyOf", "oneOf"]) {
    const value = src[key];
    if (Array.isArray(value) && value.length > 0) return { key, branches: value };
  }
  return null;
}

/** Prefer the first branch that actually declares a type; `null` branches are
 *  never chosen, because "nullable" is not a shape the model needs to aim for. */
function chooseBranch(branches: unknown[]): { chosen: Record<string, unknown> | null; rest: string[] } {
  const usable = branches.filter(
    (b): b is Record<string, unknown> => !!b && typeof b === "object" && !Array.isArray(b) && (b as Record<string, unknown>).type !== "null",
  );
  const chosen = usable.find((b) => b.type !== undefined || b.properties !== undefined || b.enum !== undefined) ?? usable[0] ?? null;
  const rest = usable.filter((b) => b !== chosen).map(describeBranch).filter(Boolean) as string[];
  return { chosen: chosen ? (narrow(chosen, 1) as Record<string, unknown>) : null, rest };
}

function describeBranch(branch: Record<string, unknown>): string | null {
  const type = typeof branch.type === "string" ? branch.type : null;
  if (type === "array") {
    const items = branch.items as Record<string, unknown> | undefined;
    const inner = typeof items?.type === "string" ? items.type : "value";
    return `an array of ${inner}s`;
  }
  if (type) return `a ${type}`;
  return null;
}

function omit(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (!keys.includes(k)) out[k] = v;
  return out;
}
