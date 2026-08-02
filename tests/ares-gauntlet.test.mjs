// C6 — the coding gauntlet. Scoring is reality probes only: these tests run
// REAL node processes against the task workspaces. A scripted "solver"
// provider that actually fixes the code scores 1.0; a confident talker that
// fixes nothing scores 0. The referee does not care about your feelings.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGauntlet, CODING_GAUNTLET, CODING_GAUNTLET_V2 } from "../packages/operator/dist/index.js";

/** Minimal real write tool — enough harness for a scripted solver. */
function writeTool(workspace) {
  return {
    schema: { name: "Write", description: "write a file", inputJsonSchema: { type: "object" }, safety: "workspace-write" },
    async call(input) {
      const target = path.resolve(workspace, input.file_path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, input.content, "utf8");
      return { output: `wrote ${input.file_path}` };
    },
  };
}

/** A provider that answers every prompt with one scripted Write, then stops. */
function solverProvider(decide) {
  return {
    name: "scripted-solver",
    async *stream(req) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      const sawToolResult = lastUser?.content.some((b) => b.type === "tool_result");
      if (!sawToolResult) {
        const write = decide(req);
        yield { type: "tool_use_start", id: "tu_1", name: "Write" };
        yield { type: "tool_use_input_done", id: "tu_1", input: write };
        yield {
          type: "message_done",
          message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Write", input: write }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
      } else {
        yield { type: "text_delta", text: "done" };
        yield {
          type: "message_done",
          message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      }
    },
  };
}

const talkOnlyProvider = {
  name: "confident-talker",
  async *stream() {
    yield { type: "text_delta", text: "I have analyzed the problem deeply and it is now certainly fixed." };
    yield {
      type: "message_done",
      message: { id: "m", role: "assistant", content: [{ type: "text", text: "fixed (trust me)" }], createdAt: new Date().toISOString() },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  },
};

test("a solver that actually fixes the bug scores 1.0 — probes run real node", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-"));
  const task = CODING_GAUNTLET.find((t) => t.id === "fix-failing-test");
  const provider = solverProvider(() => ({
    file_path: "math.mjs",
    content: "export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n",
  }));

  const report = await runGauntlet({
    provider,
    model: "scripted",
    tasks: [task],
    workspaceRoot: root,
    tools: (ws) => [writeTool(ws)],
  });

  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0].score, 1, JSON.stringify(report.tasks[0].probes));
  assert.equal(report.total, 1);
  assert.equal(report.tasks[0].toolCalls, 1);
  await rm(root, { recursive: true, force: true });
});

test("a confident talker that fixes nothing scores 0 — no credit for prose", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-"));
  const task = CODING_GAUNTLET.find((t) => t.id === "cross-file-bug");

  const report = await runGauntlet({
    provider: talkOnlyProvider,
    model: "talker",
    tasks: [task],
    workspaceRoot: root,
    tools: () => [],
  });

  assert.equal(report.tasks[0].score, 0);
  assert.equal(report.total, 0);
  await rm(root, { recursive: true, force: true });
});

test("the holo-viewer task scores structurally on the delivered file", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-"));
  const task = CODING_GAUNTLET.find((t) => t.id === "holo-viewer");
  const holo = [
    "<!doctype html><html><body>",
    '<script type="module">',
    'import * as THREE from "https://unpkg.com/three/build/three.module.js";',
    "// exploded view state",
    "const exploded = { t: 0 };",
    'const mat = new THREE.MeshBasicMaterial({ wireframe: true });',
    "</script>",
    '<input id="explode" type="range" min="0" max="1" step="0.01" />',
    "</body></html>",
  ].join("\n");
  const provider = solverProvider(() => ({ file_path: "holo.html", content: holo }));

  const report = await runGauntlet({
    provider,
    model: "scripted",
    tasks: [task],
    workspaceRoot: root,
    tools: (ws) => [writeTool(ws)],
  });

  assert.equal(report.tasks[0].score, 1, JSON.stringify(report.tasks[0].probes));
  await rm(root, { recursive: true, force: true });
});

test("mixed suite: the report carries per-task scores and an honest mean", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-"));
  const tasks = CODING_GAUNTLET.filter((t) => t.id === "fix-failing-test" || t.id === "cross-file-bug");
  // Solves the math task; whiffs the cross-file one (writes the wrong file).
  const provider = solverProvider((req) =>
    req.messages[0].content.some((b) => b.type === "text" && /math/.test(b.text))
      ? { file_path: "math.mjs", content: "export function add(a,b){return a+b}\nexport function mul(a,b){return a*b}\n" }
      : { file_path: "notes.txt", content: "looked into it" },
  );

  const report = await runGauntlet({ provider, model: "scripted", tasks, workspaceRoot: root, tools: (ws) => [writeTool(ws)] });

  const byId = Object.fromEntries(report.tasks.map((t) => [t.id, t]));
  assert.equal(byId["fix-failing-test"].score, 1);
  assert.equal(byId["cross-file-bug"].score, 0);
  assert.ok(Math.abs(report.total - 0.5) < 1e-9);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.suite, "coding-v1");
  await rm(root, { recursive: true, force: true });
});

test("a provider that throws still yields a scored (zero) task, not a crashed gauntlet", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-"));
  const provider = {
    name: "exploder",
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("provider exploded");
    },
  };
  const report = await runGauntlet({
    provider,
    model: "exploder",
    tasks: [CODING_GAUNTLET.find((t) => t.id === "cross-file-bug")],
    workspaceRoot: root,
    tools: () => [],
  });
  assert.equal(report.tasks[0].score, 0);
  assert.equal(report.complete, false);
  await rm(root, { recursive: true, force: true });
});

test("protected grader files are frozen and rejected before probes execute", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-integrity-"));
  const task = CODING_GAUNTLET.find((t) => t.id === "fix-failing-test");
  let probeCalls = 0;
  const report = await runGauntlet({
    provider: solverProvider(() => ({
      file_path: "math.test.mjs",
      content: "// candidate replaced the referee\n",
    })),
    model: "test-tamperer",
    tasks: [task],
    workspaceRoot: root,
    tools: (ws) => [writeTool(ws)],
    probe: async () => {
      probeCalls++;
      return { met: true, summary: "should not run" };
    },
  });
  assert.equal(report.tasks[0].integrityPassed, false);
  assert.equal(report.tasks[0].score, 0);
  assert.equal(probeCalls, 0);
  assert.ok(report.tasks[0].probes.every((probe) => /integrity failed/.test(probe.summary)));
  await rm(root, { recursive: true, force: true });
});

test("candidate tool teardown happens before the grading freeze", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-teardown-"));
  const task = CODING_GAUNTLET.find((t) => t.id === "fix-failing-test");
  let taskWorkspace;
  let probeCalls = 0;
  const report = await runGauntlet({
    provider: talkOnlyProvider,
    model: "background-watcher",
    tasks: [task],
    workspaceRoot: root,
    tools: (workspace) => {
      taskWorkspace = workspace;
      return {
        tools: [],
        dispose: async () => writeFile(path.join(taskWorkspace, "math.test.mjs"), "// watcher mutation during teardown\n"),
      };
    },
    probe: async () => {
      probeCalls++;
      return { met: true, summary: "should not run" };
    },
  });
  assert.equal(report.tasks[0].integrityPassed, false);
  assert.equal(report.tasks[0].score, 0);
  assert.equal(probeCalls, 0);
  await rm(root, { recursive: true, force: true });
});

test("each grader probe receives a fresh copy of the frozen candidate", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-probe-isolation-"));
  const task = {
    id: "probe-isolation",
    title: "probe isolation",
    prompt: "Inspect the fixture.",
    files: { "artifact.txt": "frozen\n" },
    probes: [{ kind: "always", met: true }, { kind: "always", met: true }],
    allProbesRequired: true,
  };
  let calls = 0;
  const report = await runGauntlet({
    provider: talkOnlyProvider,
    model: "talker",
    tasks: [task],
    workspaceRoot: root,
    tools: () => [],
    probe: async (_spec, { workspace }) => {
      calls++;
      const marker = path.join(workspace, "probe-one.marker");
      if (calls === 1) {
        await writeFile(marker, "side effect\n");
        return { met: true, summary: "first probe wrote state" };
      }
      const absent = await stat(marker).then(() => false).catch(() => true);
      return { met: absent, summary: absent ? "fresh fixture" : "probe state leaked" };
    },
  });
  assert.equal(report.tasks[0].score, 1, JSON.stringify(report.tasks[0].probes));
  await rm(root, { recursive: true, force: true });
});

test("a probe that mutates a protected file is failed even when its command returns green", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-probe-integrity-"));
  const task = {
    id: "probe-integrity",
    title: "probe integrity",
    prompt: "Inspect the fixture.",
    files: { "protected.test.mjs": "// original referee\n" },
    protectedFiles: ["protected.test.mjs"],
    probes: [{ kind: "always", met: true }],
    allProbesRequired: true,
  };
  const report = await runGauntlet({
    provider: talkOnlyProvider,
    model: "talker",
    tasks: [task],
    workspaceRoot: root,
    tools: () => [],
    probe: async (_spec, { workspace }) => {
      await writeFile(path.join(workspace, "protected.test.mjs"), "// rewritten by probe\n");
      return { met: true, summary: "green exit" };
    },
  });
  assert.equal(report.tasks[0].score, 0);
  assert.match(report.tasks[0].probes[0].summary, /mutated a protected file/);
  await rm(root, { recursive: true, force: true });
});

test("coding-v2 is multi-module, integrity-protected, and baseline-red", { timeout: 90_000 }, async () => {
  for (const task of CODING_GAUNTLET_V2) {
    assert.ok(Object.keys(task.files).length >= 10, `${task.id} must require real repository navigation`);
    assert.ok(task.protectedFiles?.length, `${task.id} must protect its tests`);
  }
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-v2-"));
  const report = await runGauntlet({
    provider: talkOnlyProvider,
    model: "talker",
    suite: "coding-v2",
    tasks: CODING_GAUNTLET_V2,
    workspaceRoot: root,
    tools: () => [],
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.total, 0, "the unsolved fixtures must not already pass");
  assert.equal(report.metrics.falseGreenRate, 1);
  assert.equal(report.tasks.length, CODING_GAUNTLET_V2.length);
  await rm(root, { recursive: true, force: true });
});

test("cancelled gauntlets are incomplete and cannot inflate the mean", async () => {
  const controller = new AbortController();
  controller.abort();
  const report = await runGauntlet({
    provider: talkOnlyProvider,
    model: "talker",
    tasks: CODING_GAUNTLET.slice(0, 2),
    signal: controller.signal,
    tools: () => [],
  });
  assert.equal(report.complete, false);
  assert.equal(report.total, 0);
  assert.equal(report.tasks.length, 0);
});
