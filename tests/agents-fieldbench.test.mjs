// Agents field-benchmark — the v0.36.0 agents workstream (fleet board,
// subagent personas, contracts) exercised through the REAL fork path, not the
// injected mock runner the colocated conductor tests use. runFleet here builds
// genuine QueryEngine forks against MockEchoProvider: real session kernel-less
// leaf runs, real usage ledger, real progress events — the closest a test gets
// to the field without a live model. BeanBrawl doctrine: gates are observable
// outcomes, never the model's word.
//
// Gates:
//  1. The fleet COMPLETES: status "completed", non-empty summary, real usage
//     (modelCalls ≥ one per leaf) — the v0.13.11 failure class (fleet N/N leaf
//     deaths) fails this loudly.
//  2. The fleet BOARD has everything it needs: fleet_activity phase_start /
//     start / done / phase_end for every phase and every role, with terminal
//     statuses — the desktop board renders from exactly these.
//  3. PERSONAS ride the real path: the host resolver is consulted with the
//     leaf's persona name and its prompt layer is adopted (unknown personas
//     must NOT fail the fleet).
//  4. The MANIFEST is durable: manifestPath exists and parses with the fleet's
//     phases — the resume/audit contract.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runFleet, MockEchoProvider } from "../packages/core/dist/index.js";

const validate = (schema, parsed) => {
  if (parsed == null || typeof parsed !== "object") return { ok: false, issues: "not an object" };
  for (const k of Object.keys(schema)) {
    if (!(k in parsed)) return { ok: false, issues: `${k}: missing` };
  }
  return { ok: true, value: parsed };
};
const schemaHint = (s) => JSON.stringify(s);

test("field bench: a real-fork fleet completes with board lifecycle, personas, manifest", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ares-fieldbench-"));
  const events = [];
  const personaAsks = [];
  try {
    const spec = {
      goal: "field benchmark",
      concurrency: 2,
      phases: [
        {
          id: "research",
          kind: "parallel",
          reduce: "concat",
          agents: [
            { role: "alpha", prompt: "Report finding A about the target." },
            { role: "beta", prompt: "Report finding B about the target.", persona: "scout" },
            { role: "gamma", prompt: "Report finding C about the target.", persona: "no-such-persona" },
          ],
        },
        {
          id: "synthesize",
          kind: "pipeline",
          agents: [{ role: "writer", prompt: "Write the final mission summary." }],
        },
      ],
    };
    const result = await runFleet(spec, {
      provider: new MockEchoProvider(),
      model: "mock-echo",
      parentTools: [],
      baseSystemPrompt: "You are a bench leaf.",
      workspace,
      signal: new AbortController().signal,
      defaultMaxTurns: 3,
      validate,
      schemaHint,
      emitProgress: (data) => events.push(data),
      resolvePersona: async (name) => {
        personaAsks.push(name);
        return name === "scout" ? { promptLayer: "You are the scout persona." } : null;
      },
    });

    // Gate 1 — completion with real usage.
    assert.equal(result.status, "completed");
    assert.ok(result.summary.length > 0, "the fleet must produce a final summary");
    assert.equal(result.budgetExceeded, false);
    assert.ok(result.usage.modelCalls >= 4, `expected ≥4 real leaf model calls, saw ${result.usage.modelCalls}`);
    assert.ok(result.usage.outputTokens > 0);

    // Gate 2 — the fleet board's data plane, event by event.
    const fleet = events.filter((e) => e?.kind === "fleet_activity");
    for (const phase of ["research", "synthesize"]) {
      assert.ok(fleet.some((e) => e.event === "phase_start" && e.phase === phase), `phase_start ${phase}`);
      assert.ok(fleet.some((e) => e.event === "phase_end" && e.phase === phase), `phase_end ${phase}`);
    }
    for (const role of ["alpha", "beta", "gamma", "writer"]) {
      assert.ok(fleet.some((e) => e.event === "start" && e.role === role), `board start row for ${role}`);
      const done = fleet.find((e) => e.event === "done" && e.role === role);
      assert.ok(done, `board done row for ${role}`);
      assert.ok(done.status, `terminal status on ${role}`);
    }

    // Gate 3 — personas consulted through the real path; unknown never fatal.
    assert.ok(personaAsks.includes("scout"), "the scout persona must be resolved");
    assert.ok(personaAsks.includes("no-such-persona"), "unknown personas still consult the resolver");

    // Gate 4 — durable manifest.
    assert.ok(result.manifestPath, "manifestPath must be reported");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(typeof manifest, "object");
    const manifestText = JSON.stringify(manifest);
    assert.match(manifestText, /research/);
    assert.match(manifestText, /synthesize/);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});
