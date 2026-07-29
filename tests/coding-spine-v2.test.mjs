import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CodingJournal,
  ContinuousVerifier,
  QueryEngine,
  Session,
  buildRepositoryMap,
  deriveScopedVerify,
  findRelatedTestFiles,
  loadSessionSnapshot,
  renderRepositoryMap,
} from "../packages/core/dist/index.js";

function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "coding-spine-scripted",
    async *stream() {
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        const id = `tool_${call}`;
        yield { type: "tool_use_start", id, name: script.tool.name };
        yield { type: "tool_use_input_done", id, input: script.tool.input };
        yield {
          type: "message_done",
          message: { id: `m_${call}`, role: "assistant", content: [{ type: "tool_use", id, name: script.tool.name, input: script.tool.input }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: script.text ?? "done" };
      yield {
        type: "message_done",
        message: { id: `m_${call}`, role: "assistant", content: [{ type: "text", text: script.text ?? "done" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function collect(engine) {
  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);
  return events;
}

function editTool(file) {
  return {
    schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call() { return { output: "edited", touchedFiles: [file] }; },
  };
}

function bashTool() {
  return {
    schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) { return { output: { command: input.command, exitCode: 0, timedOut: false, stdout: "ok", stderr: "" } }; },
  };
}

test("coding proof gate marks post-edit checked work verified", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-"));
  const file = path.join(root, "src", "feature.ts");
  const engine = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "src/feature.ts" } } },
      { text: "done" },
      { tool: { name: "Bash", input: { command: "pnpm test", description: "Run tests" } } },
      { text: "verified" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(file), bashTool()],
    workspace: root,
    requireVerificationEvidence: true,
  }, "sess_proof_green");
  engine.appendUserMessage("fix the feature");
  const events = await collect(engine);
  assert.ok(events.some((event) => event.type === "system_reminder_injected" && /no complete all-green behavior-capable verifier run/i.test(event.text)));
  const end = events.findLast((event) => event.type === "turn_end");
  assert.equal(end.status, "completed");
  assert.equal(end.workStatus, "verified");
  await rm(root, { recursive: true, force: true });
});

test("coding proof gate surfaces an honest unverified work status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-"));
  const engine = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "a.ts" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "a.ts"))],
    workspace: root,
    requireVerificationEvidence: true,
  }, "sess_proof_missing");
  engine.appendUserMessage("change a.ts");
  const events = await collect(engine);
  assert.ok(events.some((event) => event.type === "system_reminder_injected" && /UNVERIFIED at turn end/.test(event.text)));
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("manual proof rejects lookalike commands and shell-chain forgery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-forgery-"));
  for (const command of ["echo test", "pnpm test; exit 0", "cargo test --no-run", "npx tsc --version", "vitest --passWithNoTests"]) {
    const engine = new QueryEngine({
      provider: scriptedProvider([
        { tool: { name: "Edit", input: { file_path: "a.ts" } } },
        { tool: { name: "Bash", input: { command, description: "Pretend to test" } } },
        { text: "done" },
        { text: "still done" },
      ]),
      model: "scripted",
      systemPrompt: "code",
      tools: [editTool(path.join(root, "a.ts")), bashTool()],
      workspace: root,
      requireVerificationEvidence: true,
    }, `sess_forgery_${command.length}`);
    engine.appendUserMessage("change a.ts");
    const events = await collect(engine);
    assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified", command);
  }
  await rm(root, { recursive: true, force: true });
});

test("a later failed manual check invalidates an earlier pass", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-order-"));
  const shell = {
    schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) {
      const failed = String(input.command).includes("second");
      return { output: { command: input.command, exitCode: failed ? 1 : 0, timedOut: false, stdout: "", stderr: failed ? "red" : "" } };
    },
  };
  const engine = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "a.ts" } } },
      { tool: { name: "Bash", input: { command: "pnpm test -- first", description: "First run" } } },
      { tool: { name: "Bash", input: { command: "pnpm test -- second", description: "Second run" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "a.ts")), shell],
    workspace: root,
    requireVerificationEvidence: true,
  }, "sess_proof_order");
  engine.appendUserMessage("change a.ts");
  const events = await collect(engine);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("a narrower manual pass cannot clear a broader failed command", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-scope-"));
  const shell = {
    schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) {
      const broadFailure = String(input.command) === "pnpm test";
      return { output: { command: input.command, exitCode: broadFailure ? 1 : 0, timedOut: false, stdout: "", stderr: broadFailure ? "integration red" : "" } };
    },
  };
  const engine = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "a.ts" } } },
      { tool: { name: "Bash", input: { command: "pnpm test", description: "Broad suite" } } },
      { tool: { name: "Bash", input: { command: "pnpm test unit", description: "Narrow suite" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "a.ts")), shell],
    workspace: root,
    requireVerificationEvidence: true,
  }, "sess_proof_scope");
  engine.appendUserMessage("change a.ts");
  const events = await collect(engine);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("manual proof cannot reuse no-checks evidence from an older mutation generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-generation-"));
  const engine = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "a.unknown" } } },
      { tool: { name: "Bash", input: { command: "pnpm test", description: "Run tests" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "a.unknown")), bashTool()],
    workspace: root,
    requireVerificationEvidence: true,
    verificationEvidence: () => ({
      mutationGeneration: 2,
      scheduledRuns: 1,
      finishedCommands: 0,
      passedCommands: 0,
      failedCommands: 0,
      skippedCommands: 0,
      latestRunGeneration: 1,
      latestRunStatus: "no_checks",
      latestLabels: [],
    }),
  }, "sess_proof_generation");
  engine.appendUserMessage("change the file");
  const events = await collect(engine);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("persisted proof cannot certify a brand-new mutation in the resumed turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-resume-edit-"));
  const engine = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "fresh.ts" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "fresh.ts"))],
    workspace: root,
    requireVerificationEvidence: true,
    outstandingVerificationRequired: () => true,
    persistedVerificationDebt: () => true,
    verificationEvidence: () => ({
      mutationGeneration: 1,
      passedCommands: 1,
      failedCommands: 0,
      skippedCommands: 0,
      latestPassedAt: 1,
      latestRunGeneration: 1,
      latestRunStatus: "passed",
      latestRunStrength: "behavioral",
      latestLabels: ["old-pass"],
    }),
  }, "sess_resume_edit");
  engine.appendUserMessage("continue and change fresh.ts");
  const events = await collect(engine);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("syntax-only automatic evidence is not behavioral completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-strength-"));
  const engine = new QueryEngine({
    provider: scriptedProvider([{ text: "done" }, { text: "still done" }]),
    model: "scripted",
    systemPrompt: "code",
    tools: [],
    workspace: root,
    requireVerificationEvidence: true,
    outstandingVerificationRequired: () => true,
    persistedVerificationDebt: () => true,
    verificationEvidence: () => ({
      mutationGeneration: 1,
      passedCommands: 1,
      failedCommands: 0,
      skippedCommands: 0,
      latestRunGeneration: 1,
      latestRunStatus: "passed",
      latestRunStrength: "syntax",
      latestLabels: ["node-check feature.js"],
    }),
  }, "sess_strength");
  engine.appendUserMessage("finish the change");
  const events = await collect(engine);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("a broader manual failure after automatic green invalidates completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-auto-then-red-"));
  const shell = {
    schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) { return { output: { command: input.command, exitCode: 1, timedOut: false, stdout: "", stderr: "integration red" } }; },
  };
  const engine = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Bash", input: { command: "pnpm test", description: "Run broader suite" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [shell],
    workspace: root,
    requireVerificationEvidence: true,
    outstandingVerificationRequired: () => true,
    persistedVerificationDebt: () => true,
    verificationEvidence: () => ({
      mutationGeneration: 1,
      passedCommands: 1,
      failedCommands: 0,
      skippedCommands: 0,
      latestPassedAt: 1,
      latestRunGeneration: 1,
      latestRunStatus: "passed",
      latestRunStrength: "behavioral",
      latestLabels: ["package-tests"],
    }),
  }, "sess_auto_then_red");
  engine.appendUserMessage("finish verification");
  const events = await collect(engine);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("a later narrow automatic pass cannot erase an unresolved broader manual failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-proof-red-then-auto-"));
  let evidence = {
    mutationGeneration: 1,
    passedCommands: 0,
    failedCommands: 0,
    skippedCommands: 0,
    latestRunGeneration: 1,
    latestRunStatus: "no_checks",
    latestLabels: [],
  };
  const shell = {
    schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) { return { output: { command: input.command, exitCode: 1, timedOut: false, stdout: "", stderr: "integration red" } }; },
  };
  const refresh = {
    schema: { name: "Read", description: "refresh verifier", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "parallel-safe" },
    async call() {
      evidence = { ...evidence, passedCommands: 1, latestRunStatus: "passed", latestRunStrength: "behavioral", latestPassedAt: Date.now(), latestLabels: ["unit-tests"] };
      return { output: "automatic syntax check passed" };
    },
  };
  const engine = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Bash", input: { command: "pnpm test", description: "Run broader suite" } } },
      { tool: { name: "Read", input: { file_path: "automatic-result" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [shell, refresh],
    workspace: root,
    requireVerificationEvidence: true,
    outstandingVerificationRequired: () => true,
    persistedVerificationDebt: () => true,
    verificationEvidence: () => evidence,
  }, "sess_red_then_auto");
  engine.appendUserMessage("finish verification");
  const events = await collect(engine);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("Session derives touched files and diffs for shell-mediated edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-shell-diff-"));
  await writeFile(path.join(root, "before.txt"), "before\n");
  const target = path.join(root, "created.txt");
  const session = new Session({
    provider: scriptedProvider([
      { tool: { name: "Bash", input: { command: "create file", description: "Create file" } } },
      { text: "done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    workspace: root,
    tools: [{
      schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
      async call() { await writeFile(target, "created\n"); return { output: { exitCode: 0, timedOut: false } }; },
    }],
  });
  const events = [];
  for await (const event of session.send("create it")) events.push(event);
  const end = events.find((event) => event.type === "tool_end");
  assert.ok(end.touchedFiles.includes(target), JSON.stringify(end));
  const diff = events.find((event) => event.type === "workspace_diff");
  assert.ok(diff.files.includes("created.txt"));
  assert.match(diff.diff, /\+created/);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("Session fails closed when an opaque shell checkpoint diff is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-shell-diff-failure-"));
  const session = new Session({
    provider: scriptedProvider([
      { tool: { name: "Bash", input: { command: "node generator.mjs", description: "Generate files" } } },
      { text: "done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    workspace: root,
    tools: [{
      schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
      async call() {
        await rm(path.join(root, ".ares", "checkpoints", "meta"), { recursive: true, force: true });
        return { output: { exitCode: 0, timedOut: false } };
      },
    }],
  });
  const events = [];
  for await (const event of session.send("generate code")) events.push(event);
  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.ok(toolEnd.touchedFiles.some((file) => file.endsWith(".ares-unknown-mutation")), JSON.stringify(toolEnd));
  assert.ok(events.some((event) => event.type === "workspace_diff" && /diff unavailable/i.test(event.diff)));
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("Session promotes delegated Task edits into parent verification debt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-delegated-diff-"));
  const target = path.join(root, "delegated.js");
  const session = new Session({
    provider: scriptedProvider([
      { tool: { name: "Task", input: { description: "Implement module", prompt: "write delegated.js", subagent_type: "general-purpose" } } },
      { text: "done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    workspace: root,
    tools: [{
      schema: { name: "Task", description: "delegate", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
      async call() {
        await writeFile(target, "export const delegated = true;\n");
        return { output: { status: "completed", summary: "implemented" } };
      },
    }],
  });
  const events = [];
  for await (const event of session.send("delegate the implementation")) events.push(event);
  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.ok(toolEnd.touchedFiles.includes(target), JSON.stringify(toolEnd));
  assert.ok(events.some((event) => event.type === "workspace_diff" && event.files.includes("delegated.js")));
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");
  await rm(root, { recursive: true, force: true });
});

test("repository cartography is deterministic, bounded, and boundary-aware", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-map-"));
  await mkdir(path.join(root, "packages", "api", "src"), { recursive: true });
  await mkdir(path.join(root, "packages", "api", "tests"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "follow local patterns\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "root", scripts: { check: "tsc -b" } }));
  await writeFile(path.join(root, "packages", "api", "package.json"), JSON.stringify({ name: "@demo/api", scripts: { test: "node --test" }, main: "src/index.ts" }));
  await writeFile(path.join(root, "packages", "api", "src", "index.ts"), "export const api = 1;\n");
  await writeFile(path.join(root, "packages", "api", "tests", "api.test.mjs"), "// test\n");
  const first = await buildRepositoryMap(root);
  const second = await buildRepositoryMap(root);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.ok(first.languages.some((entry) => entry.name === "TypeScript"));
  assert.ok(first.instructions.includes("AGENTS.md"));
  assert.ok(first.packages.some((entry) => entry.name === "@demo/api" && entry.testRoots.includes("tests")));
  assert.ok(!first.packages.find((entry) => entry.path === ".").sourceRoots.includes("packages"), "root package must not absorb nested package files");
  assert.match(renderRepositoryMap(first), /package\/module boundaries/i);
  await rm(root, { recursive: true, force: true });
});

test("related-test discovery follows reverse imports across directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-impact-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests", "integration"), { recursive: true });
  const service = path.join(root, "src", "service.mjs");
  await writeFile(service, "export const service = () => 1;\n");
  await writeFile(path.join(root, "src", "controller.mjs"), 'import { service } from "./service.mjs"; export const controller = service;\n');
  const integration = path.join(root, "tests", "integration", "order-flow.test.mjs");
  await writeFile(integration, 'import { controller } from "../../src/controller.mjs"; controller();\n');
  const related = await findRelatedTestFiles([service], root);
  assert.ok(related.includes(integration), JSON.stringify(related));
  await rm(root, { recursive: true, force: true });
});

test("scoped verification resolves nested polyglot project owners", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-scoped-"));
  const desktop = path.join(root, "apps", "desktop");
  const rust = path.join(root, "native");
  await mkdir(path.join(desktop, "src"), { recursive: true });
  await mkdir(path.join(desktop, "node_modules", "typescript", "bin"), { recursive: true });
  await mkdir(path.join(rust, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(desktop, "package.json"), JSON.stringify({ name: "desktop", devDependencies: { typescript: "^5.0.0" } }));
  await writeFile(path.join(desktop, "node_modules", "typescript", "bin", "tsc"), "// installed compiler\n");
  await writeFile(path.join(desktop, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  const tsFile = path.join(desktop, "src", "main.ts");
  await writeFile(tsFile, "export const main = true;\n");
  await writeFile(path.join(rust, "Cargo.toml"), '[package]\nname="native"\nversion="0.1.0"\n');
  const rsFile = path.join(rust, "src", "lib.rs");
  await writeFile(rsFile, "pub fn value() -> i32 { 1 }\n");
  const commands = await deriveScopedVerify([tsFile, rsFile], root);
  assert.ok(commands.some((command) => command.label === "typescript" && path.resolve(command.cwd) === path.resolve(desktop)));
  assert.ok(commands.some((command) => command.label === "cargo-test" && path.resolve(command.cwd) === path.resolve(rust)));
  await rm(root, { recursive: true, force: true });
});

test("scoped verification never syntax-checks a deleted path and falls back to owner tests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-scoped-delete-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  const deleted = path.join(root, "deleted.mjs");
  const commands = await deriveScopedVerify([deleted], root);
  assert.ok(!commands.some((command) => command.args.some((arg) => arg.includes("deleted.mjs"))), JSON.stringify(commands));
  assert.ok(commands.some((command) => command.label === "package-tests"), JSON.stringify(commands));
  await rm(root, { recursive: true, force: true });
});

test("continuous verifier exposes green evidence separately from no checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-evidence-"));
  const file = path.join(root, "ok.js");
  await writeFile(file, "export const ok = true;\n");
  const verifier = new ContinuousVerifier({
    workspace: root,
    debounceMs: 0,
    runCommand: async (command) => ({ ok: true, command, exitCode: 0, stdoutTail: "", stderrTail: "", durationMs: 1 }),
  });
  verifier.scheduleFor([file]);
  await verifier.settle(5_000);
  const evidence = verifier.evidenceSnapshot();
  assert.ok(evidence.scheduledRuns >= 1);
  assert.ok(evidence.passedCommands >= 1);
  assert.ok(evidence.latestPassedAt > 0);
  assert.equal(evidence.latestRunStrength, "syntax");
  await verifier.cancel();
  await rm(root, { recursive: true, force: true });
});

test("continuous verifier requires the whole current run to pass", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-evidence-mixed-"));
  await mkdir(path.join(root, "tests"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "typescript", "bin"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" }, devDependencies: { typescript: "^5.0.0" } }));
  await writeFile(path.join(root, "node_modules", "typescript", "bin", "tsc"), "// installed compiler\n");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
  const file = path.join(root, "feature.ts");
  await writeFile(file, "export const feature = true;\n");
  await writeFile(path.join(root, "tests", "feature.test.ts"), 'import "../feature.js";\n');
  const verifier = new ContinuousVerifier({
    workspace: root,
    debounceMs: 0,
    runCommand: async (command) => {
      const failed = command.args.includes("--test") || command.label.includes("tests");
      return { ok: !failed, command, exitCode: failed ? 1 : 0, stdoutTail: "", stderrTail: failed ? "test failed" : "", durationMs: 1 };
    },
  });
  verifier.scheduleFor([file]);
  await verifier.settle(5_000);
  const evidence = verifier.evidenceSnapshot();
  assert.ok(evidence.passedCommands >= 1);
  assert.ok(evidence.failedCommands >= 1);
  assert.equal(evidence.latestRunGeneration, evidence.mutationGeneration);
  assert.equal(evidence.latestRunStatus, "failed");
  await verifier.cancel();
  await rm(root, { recursive: true, force: true });
});

test("continuous verifier serializes edit bursts and certifies only the newest generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-evidence-burst-"));
  const file = path.join(root, "feature.mjs");
  await writeFile(file, "export const feature = true;\n");
  let active = 0;
  let maxActive = 0;
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const verifier = new ContinuousVerifier({
    workspace: root,
    debounceMs: 0,
    runCommand: async (command, signal) => {
      active++;
      maxActive = Math.max(maxActive, active);
      started();
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { ok: !signal.aborted, command, exitCode: signal.aborted ? 1 : 0, stdoutTail: "", stderrTail: "", durationMs: 20 };
    },
  });
  verifier.scheduleFor([file]);
  await firstStarted;
  verifier.scheduleFor([file]);
  verifier.scheduleFor([file]);
  await verifier.settle(5_000);
  const evidence = verifier.evidenceSnapshot();
  assert.equal(maxActive, 1);
  assert.equal(evidence.mutationGeneration, 3);
  assert.equal(evidence.latestRunGeneration, 3);
  assert.equal(evidence.latestRunStatus, "passed");
  await verifier.cancel();
  await rm(root, { recursive: true, force: true });
});

test("continuous verifier refreshes project setup after package configuration changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-evidence-setup-"));
  const file = path.join(root, "feature.mjs");
  await writeFile(file, "export const feature = true;\n");
  const labels = [];
  const verifier = new ContinuousVerifier({
    workspace: root,
    debounceMs: 0,
    runCommand: async (command) => {
      labels.push(command.label);
      return { ok: true, command, exitCode: 0, stdoutTail: "", stderrTail: "", durationMs: 1 };
    },
  });
  verifier.scheduleFor([file]);
  await verifier.settle(5_000);
  assert.ok(labels.some((label) => label.startsWith("node-check")));

  const manifest = path.join(root, "package.json");
  await writeFile(manifest, JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  verifier.scheduleFor([manifest]);
  await verifier.settle(5_000);
  labels.length = 0;
  verifier.scheduleFor([file]);
  await verifier.settle(5_000);
  assert.ok(labels.includes("package-tests"), JSON.stringify(labels));
  assert.equal(verifier.evidenceSnapshot().latestRunStatus, "passed");
  labels.length = 0;
  verifier.scheduleFor([file]);
  await verifier.settle(5_000);
  assert.ok(labels.includes("package-tests"), "project-wide test results must never reuse a touched-file-only cache key");
  await verifier.cancel();
  await rm(root, { recursive: true, force: true });
});

test("coding journal persists objective, todos, touched files, and check evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-journal-"));
  const journal = await CodingJournal.open({ workspace: root, sessionId: "sess_journal" });
  assert.match(journal.beginTurn("Implement the parser and run its tests"), /DURABLE CODING STATE/);
  journal.beginTurn("Also keep the public API backward compatible");
  journal.recordTurnEvent({ type: "tool_start", id: "w1", name: "Write", input: { file_path: "src/parser.ts" }, activityDescription: "write" });
  journal.recordTurnEvent({ type: "tool_end", id: "w1", output: "ok", touchedFiles: [path.join(root, "src", "parser.ts")], durationMs: 1 });
  journal.recordTurnEvent({ type: "todo_updated", todos: [{ id: "1", content: "Run tests", activeForm: "Running tests", status: "in_progress" }] });
  journal.recordVerifyEvent({ type: "finished", result: { ok: true, command: { program: "node", args: ["--test"], cwd: root, label: "tests" }, exitCode: 0, stdoutTail: "ok", stderrTail: "", durationMs: 2 } });
  await journal.finishTurn("completed");
  const reopened = await CodingJournal.open({ workspace: root, sessionId: "sess_journal" });
  const state = reopened.snapshot();
  assert.match(state.objective, /Implement the parser/);
  assert.ok(state.steering.some((item) => /backward compatible/.test(item)));
  assert.deepEqual(state.touchedFiles, ["src/parser.ts"]);
  assert.equal(state.todos[0].status, "in_progress");
  assert.equal(state.checks.at(-1).ok, true);
  await rm(root, { recursive: true, force: true });
});

test("coding journal promotes the original natural-language request when edits reveal coding intent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-journal-intent-"));
  const journal = await CodingJournal.open({ workspace: root, sessionId: "sess_intent" });
  assert.equal(journal.beginTurn("make the header cobalt and give it more breathing room"), null);
  journal.recordTurnEvent({ type: "tool_start", id: "e1", name: "Edit", input: { file_path: "ui.css" }, activityDescription: "edit" });
  journal.recordTurnEvent({ type: "tool_end", id: "e1", output: "ok", touchedFiles: [path.join(root, "ui.css")], durationMs: 1 });
  assert.equal(journal.snapshot().objective, "make the header cobalt and give it more breathing room");
  await journal.finishTurn("completed");
  await rm(root, { recursive: true, force: true });
});

test("coding journal replaces a paused artifact when the user names a fresh deliverable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-journal-new-deliverable-"));
  const journal = await CodingJournal.open({ workspace: root, sessionId: "sess_new_deliverable" });
  journal.beginTurn("vein: build a simple stopwatch webpage — start, stop, reset");
  journal.recordTurnEvent({ type: "tool_start", id: "w1", name: "Write", input: { file_path: "stopwatch.html" } });
  journal.recordTurnEvent({ type: "tool_end", id: "w1", output: "ok", touchedFiles: [path.join(root, "stopwatch.html")], durationMs: 1 });
  journal.recordTurnEvent({ type: "turn_end", status: "completed", workStatus: "unverified", usage: {}, durationMs: 1 });
  await journal.finishTurn("completed");

  const reminder = journal.beginTurn("vein: build a pomodoro timer webpage — 25 min work / 5 min break");
  const state = journal.snapshot();
  assert.match(state.objective, /pomodoro timer/i);
  assert.deepEqual(state.steering, []);
  assert.deepEqual(state.touchedFiles, []);
  assert.doesNotMatch(reminder, /objective: .*stopwatch/i);
  await rm(root, { recursive: true, force: true });
});

test("coding journal keeps restart verification debt immutable through the end gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-journal-debt-"));
  const sessionId = "sess_debt";
  const journal = await CodingJournal.open({ workspace: root, sessionId });
  journal.beginTurn("Implement the feature");
  journal.recordTurnEvent({ type: "tool_start", id: "e1", name: "Edit", input: { file_path: "feature.js" }, activityDescription: "edit" });
  journal.recordTurnEvent({ type: "tool_end", id: "e1", output: "ok", touchedFiles: [path.join(root, "feature.js")], durationMs: 1 });
  journal.recordTurnEvent({ type: "turn_end", status: "completed", workStatus: "unverified", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
  await journal.finishTurn("completed");

  const resumed = await CodingJournal.open({ workspace: root, sessionId });
  resumed.beginTurn("finish and verify it");
  assert.equal(resumed.persistedVerificationDebtForCurrentTurn(), true);
  resumed.recordVerifyEvent({
    type: "all_finished",
    ok: true,
    generation: 1,
    results: [{ ok: true, command: { program: "node", args: ["--check", "feature.js"], cwd: root, label: "syntax" }, exitCode: 0, stdoutTail: "", stderrTail: "", durationMs: 1 }],
  });
  assert.equal(resumed.verificationRequiredForCurrentTurn(), true, "proof debt must remain armed until workStatus is emitted");
  resumed.recordTurnEvent({ type: "turn_end", status: "completed", workStatus: "verified", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
  await resumed.finishTurn("completed");
  assert.equal(resumed.snapshot().lastWorkStatus, "verified");
  await rm(root, { recursive: true, force: true });
});

test("truncated restart scope cannot be certified by tail-only automatic checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-journal-overflow-"));
  const evidence = () => ({
    mutationGeneration: 1,
    passedCommands: 1,
    failedCommands: 0,
    skippedCommands: 0,
    latestPassedAt: Date.now(),
    latestRunGeneration: 1,
    latestRunStatus: "passed",
    latestRunStrength: "behavioral",
    latestLabels: ["tail-only"],
  });
  const engine = new QueryEngine({
    provider: scriptedProvider([{ text: "done" }, { text: "still done" }]),
    model: "scripted",
    systemPrompt: "code",
    tools: [],
    workspace: root,
    requireVerificationEvidence: true,
    outstandingVerificationRequired: () => true,
    persistedVerificationDebt: () => true,
    persistedVerificationScopeComplete: () => false,
    verificationEvidence: evidence,
  }, "sess_overflow_tail");
  engine.appendUserMessage("resume the large migration");
  const events = await collect(engine);
  assert.equal(events.findLast((event) => event.type === "turn_end").workStatus, "unverified");

  const broad = new QueryEngine({
    provider: scriptedProvider([
      { tool: { name: "Bash", input: { command: "pnpm test", description: "Run broad suite" } } },
      { text: "verified" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [bashTool()],
    workspace: root,
    requireVerificationEvidence: true,
    outstandingVerificationRequired: () => true,
    persistedVerificationDebt: () => true,
    persistedVerificationScopeComplete: () => false,
    verificationEvidence: evidence,
  }, "sess_overflow_broad");
  broad.appendUserMessage("run the full suite");
  const broadEvents = await collect(broad);
  assert.equal(broadEvents.findLast((event) => event.type === "turn_end").workStatus, "verified");
  await rm(root, { recursive: true, force: true });
});

test("coding journal discards failures from superseded verifier generations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-journal-stale-"));
  const journal = await CodingJournal.open({ workspace: root, sessionId: "sess_stale" });
  journal.beginTurn("Fix the implementation");
  const failed = { ok: false, command: { program: "node", args: ["--test"], cwd: root, label: "tests" }, exitCode: 1, stdoutTail: "", stderrTail: "old failure", durationMs: 1 };
  journal.recordVerifyEvent({ type: "finished", generation: 1, result: failed });
  journal.recordVerifyEvent({ type: "all_finished", generation: 1, ok: false, superseded: true, results: [failed] });
  assert.equal(journal.snapshot().checks.length, 0);
  assert.equal(journal.snapshot().failures.length, 0);
  await journal.finishTurn("completed");
  await rm(root, { recursive: true, force: true });
});

test("coding journal recovers a valid backup after a torn primary write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-journal-recovery-"));
  const sessionId = "sess_recovery";
  const dir = path.join(root, ".ares", "sessions", sessionId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "coding-state.json");
  await writeFile(file, "{torn");
  await writeFile(`${file}.bak`, JSON.stringify({
    schemaVersion: 1,
    sessionId,
    workspace: root,
    objective: "Recover this long task",
    requests: ["Recover this long task"],
    steering: [],
    phase: "paused",
    touchedFiles: ["src/feature.ts"],
    todos: [],
    checks: [],
    failures: [],
    turns: 3,
    updatedAt: new Date().toISOString(),
  }));
  const recovered = await CodingJournal.open({ workspace: root, sessionId });
  assert.equal(recovered.snapshot().objective, "Recover this long task");
  assert.deepEqual(recovered.snapshot().touchedFiles, ["src/feature.ts"]);
  await rm(root, { recursive: true, force: true });
});

test("session resume folds the latest TodoWrite event independently of message replay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-todos-"));
  const id = "sess_todos";
  const dir = path.join(root, ".ares", "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "meta.json"), JSON.stringify({ id, workspace: root, provider: { name: "mock", model: "mock" }, createdAt: new Date().toISOString() }));
  const todo = { id: "t1", content: "Verify behavior", activeForm: "Verifying behavior", status: "in_progress" };
  await writeFile(path.join(dir, "events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), seq: 0, event: { type: "todo_updated", todos: [todo] } }) + "\n");
  const snapshot = await loadSessionSnapshot(root, id);
  assert.deepEqual(snapshot.todos, [todo]);
  await rm(root, { recursive: true, force: true });
});
