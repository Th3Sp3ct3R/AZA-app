// Tool-schema narrowing for OpenAI-shaped providers.
//
// The bug this pins: OpenRouter failed a request over from Google AI Studio
// (429) to another upstream, which rejected the ENTIRE tool array with
//   422 "auto tool schemas do not support multi-type anyOf/oneOf unions"
// The offending schema was ours — Grep's `path`/`glob` are `string | string[]`,
// which Zod renders as anyOf. One union in one property killed every turn on
// that route, and nothing about the request had changed to explain it.
//
// The invariant worth keeping: nothing that reaches an OpenAI-shaped wire may
// contain anyOf/oneOf/allOf or a multi-type `type`. Asserted by walking the
// real, live tool belt — not a fixture — because the next union will arrive the
// same way this one did: someone writes a perfectly reasonable z.union().

import test from "node:test";
import assert from "node:assert/strict";
import { narrowToolSchema } from "../packages/core/dist/index.js";
import * as tools from "../packages/tools/dist/index.js";
import * as agentTools from "../packages/agent/dist/index.js";

/** Every keyword an OpenAI-shaped tool endpoint may reject. */
function findUnsupported(node, path = "") {
  const bad = [];
  if (Array.isArray(node)) {
    node.forEach((n, i) => bad.push(...findUnsupported(n, `${path}[${i}]`)));
    return bad;
  }
  if (!node || typeof node !== "object") return bad;
  for (const key of ["anyOf", "oneOf", "allOf", "not", "$ref", "$defs", "definitions"]) {
    if (key in node) bad.push(`${path}.${key}`);
  }
  if (Array.isArray(node.type)) bad.push(`${path}.type=${JSON.stringify(node.type)}`);
  for (const [k, v] of Object.entries(node)) bad.push(...findUnsupported(v, `${path}.${k}`));
  return bad;
}

function liveToolSchemas() {
  const out = [];
  for (const mod of [tools, agentTools]) {
    for (const value of Object.values(mod)) {
      if (value && typeof value === "object" && value.schema?.inputJsonSchema) {
        out.push([value.schema.name, value.schema.inputJsonSchema]);
      }
    }
  }
  return out;
}

test("the live tool belt narrows to a union-free schema", () => {
  const schemas = liveToolSchemas();
  assert.ok(schemas.length > 20, `expected the real tool belt, got ${schemas.length} schemas`);
  for (const [name, schema] of schemas) {
    const bad = findUnsupported(narrowToolSchema(schema));
    assert.deepEqual(bad, [], `${name} still carries schema keywords a strict upstream rejects: ${bad.join(", ")}`);
  }
});

test("at least one live tool actually HAS a union — otherwise this test proves nothing", () => {
  // Guards against the narrowing being silently vacuous if Grep is ever
  // rewritten: if no tool has a union, the test above passes trivially and the
  // regression it exists to catch would sail through.
  const anyUnion = liveToolSchemas().some(([, schema]) => findUnsupported(schema).length > 0);
  assert.ok(anyUnion, "no live tool has a union — re-point this test at whatever now needs narrowing");
});

test("a string|array union collapses to the first branch and says so in prose", () => {
  const narrowed = narrowToolSchema({
    type: "object",
    properties: {
      path: {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "File or directory to search.",
      },
    },
  });
  const path = narrowed.properties.path;
  assert.equal(path.type, "string");
  assert.equal(path.anyOf, undefined);
  // The model has to learn from the description what the schema can no longer
  // express, because the tool still accepts both shapes at runtime.
  assert.match(path.description, /File or directory to search\./);
  assert.match(path.description, /array of strings/);
});

test("multi-type `type` collapses to the first non-null type", () => {
  const narrowed = narrowToolSchema({
    type: "object",
    properties: { limit: { type: ["number", "null"], description: "Max results." } },
  });
  assert.equal(narrowed.properties.limit.type, "number");
  assert.equal(narrowed.properties.limit.description, "Max results.");
});

test("nested unions inside arrays and objects are narrowed too", () => {
  const narrowed = narrowToolSchema({
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } },
        },
      },
    },
  });
  assert.deepEqual(findUnsupported(narrowed), []);
  assert.equal(narrowed.properties.edits.items.properties.value.type, "string");
});

test("allOf merges instead of being dropped", () => {
  const narrowed = narrowToolSchema({
    allOf: [
      { type: "object", properties: { a: { type: "string" } } },
      { required: ["a"] },
    ],
  });
  assert.equal(narrowed.type, "object");
  assert.deepEqual(narrowed.required, ["a"]);
  assert.equal(narrowed.properties.a.type, "string");
});

test("a null-only branch is never the one chosen", () => {
  const narrowed = narrowToolSchema({ anyOf: [{ type: "null" }, { type: "integer" }] });
  assert.equal(narrowed.type, "integer");
});

test("a self-referential schema terminates instead of hanging the turn", () => {
  // MCP servers hand us schemas we neither wrote nor audited.
  const cyclic = { type: "object", properties: {} };
  cyclic.properties.self = cyclic;
  const narrowed = narrowToolSchema(cyclic);
  assert.ok(narrowed, "narrowing a cyclic schema must return, not recurse forever");
});

test("an already-clean schema is left semantically intact", () => {
  const clean = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex." },
      max: { type: "number" },
      mode: { type: "string", enum: ["content", "files"] },
    },
    required: ["pattern"],
  };
  const narrowed = narrowToolSchema(clean);
  assert.equal(narrowed.properties.pattern.description, "The regex.");
  assert.deepEqual(narrowed.properties.mode.enum, ["content", "files"]);
  assert.deepEqual(narrowed.required, ["pattern"]);
});
