import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  QueryEngine,
  RepositoryInstructionResolver,
  Session,
  SessionKernelStore,
  WorkspaceMutationService,
} from "../packages/core/dist/index.js";
import {
  BashTool,
  PowerShellTool,
  ReadTool,
  WriteTool,
  adaptToolForEngine,
  buildTool,
  toolError,
} from "../packages/tools/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");
const requireFromTools = createRequire(new URL("../packages/tools/package.json", import.meta.url));
const { z } = requireFromTools("zod");

function toolThenDoneProvider(name, input, options = {}) {
  let calls = 0;
  return {
    name: options.providerName ?? "harness-test-provider",
    async *stream(request) {
      calls += 1;
      options.onRequest?.(request, calls);
      if (calls === 1) {
        const use = { type: "tool_use", id: options.toolUseId ?? "tool-1", name, input };
        yield { type: "tool_use_start", id: use.id, name: use.name };
        yield { type: "tool_use_input_done", id: use.id, input: use.input };
        yield {
          type: "message_done",
          message: {
            id: `assistant-tools-${name}`,
            role: "assistant",
            content: [use],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: {
          id: `assistant-done-${name}`,
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function rich(base, permissionMode = "workspace-write") {
  return {
    ...base,
    permissionMode,
    fileReadStamps: base.fileReadStamps ?? new Map(),
  };
}

async function drain(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

function simplePdf(pageTexts) {
  const escapePdfText = (text) => text.replace(/([\\()])/g, "\\$1");
  const objects = new Map();
  const pageRefs = [];
  let nextId = 3;
  const fontId = 3 + pageTexts.length * 2;
  for (const text of pageTexts) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageRefs.push(`${pageId} 0 R`);
    // Keep individual PDF string operands modest so pdf.js does not apply its
    // own parser-token guard before Read's output cap can be exercised.
    const operands = (text.match(/[\s\S]{1,32}/g) ?? [""])
      .map((chunk) => `1 0 0 1 72 720 Tm (${escapePdfText(chunk)}) Tj`)
      .join("\n");
    const stream = `BT /F1 18 Tf 72 720 Td ${operands} ET`;
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  }
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageTexts.length} >>`);
  objects.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let body = "%PDF-1.4\n";
  const offsets = new Map();
  for (let id = 1; id <= fontId; id++) {
    offsets.set(id, Buffer.byteLength(body, "latin1"));
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id++) {
    body += `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("writer throw after commit is effect_unknown, then journal-reconciled without replay", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-effect-reconcile-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    const target = path.join(workspace, "committed.txt");
    const writer = buildTool({
      name: "Write",
      description: "commit then simulate a lost result",
      safety: "workspace-write",
      concurrency: "exclusive",
      inputZod: z.object({ content: z.string() }).strict(),
      activityDescription: () => "Writing fixture",
      async call(input, ctx) {
        await new WorkspaceMutationService(ctx.workspace).apply(
          [{ kind: "add", path: target, content: input.content }],
          { label: "effect-reconcile-test", transactionId: ctx.mutationTransactionId },
        );
        throw toolError("simulated response loss after the durable commit");
      },
    });
    const session = new Session({
      sessionId: "effect-reconcile-session",
      workspace,
      provider: toolThenDoneProvider("Write", { content: "committed exactly once\n" }),
      model: "mock",
      systemPrompt: "test",
      tools: [adaptToolForEngine(writer, rich)],
      sessionKernel: store,
      contextBudgetTokens: 0,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
    });

    const events = await drain(session.sendContent(
      [{ type: "text", text: "write it" }],
      { inputId: "effect-input" },
    ));

    assert.equal(await readFile(target, "utf8"), "committed exactly once\n");
    const error = events.find((event) => event.type === "tool_error");
    assert.match(error?.error ?? "", /effect status is unknown/i);
    const [run] = store.listToolRuns("effect-reconcile-session");
    assert.match(run.mutationTransactionId ?? "", /^tool_[a-f0-9]{48}$/);
    assert.equal(run.executionState, "succeeded", "full journal after-state reconciles the committed effect");
    assert.equal(run.verificationState, "unverified", "recovery is not behavioral proof");
    assert.equal(
      store.listEvents("effect-reconcile-session", { limit: 100 }).filter((event) => event.type === "tool.effect_reconciled").length,
      1,
    );
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("adapter validation rejection remains a known pre-effect failure", async () => {
  const settlements = [];
  let implementationCalls = 0;
  const definition = buildTool({
    name: "GuardedWriter",
    description: "fixture",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: z.object({ value: z.string() }).strict(),
    activityDescription: () => "Validating fixture",
    async validateInput() {
      return { ok: false, message: "fixture rejected before execution" };
    },
    async call() {
      implementationCalls += 1;
      return { output: { ok: true } };
    },
  });
  const engine = QueryEngine.forTesting({
    provider: toolThenDoneProvider("GuardedWriter", { value: "x" }),
    model: "mock",
    systemPrompt: "test",
    tools: [adaptToolForEngine(definition, rich)],
    workspace: process.cwd(),
    beforeToolExecution: async () => {},
    afterToolExecution: async (settlement) => settlements.push(settlement),
  }, "known-pre-effect");
  engine.appendUserMessage("run");
  await drain(engine.streamTurn());
  assert.equal(implementationCalls, 0);
  assert.equal(settlements[0]?.status, "failed");
  assert.doesNotMatch(settlements[0]?.error ?? "", /effect status is unknown/i);
});

test("Read streams huge UTF-8 text, caps context, lists directories, and rejects binary decoding", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-read-stream-"));
  try {
    const splitUtf8 = `${"a".repeat(65_534)}\n€ survives a chunk boundary\nlast\n`;
    const textFile = path.join(workspace, "large.txt");
    await writeFile(textFile, splitUtf8, "utf8");
    await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 3, 4]));
    await mkdir(path.join(workspace, "folder"));
    await writeFile(path.join(workspace, "folder", "child.txt"), "child", "utf8");
    const ctx = {
      workspace,
      sessionId: "read-stream-session",
      signal: new AbortController().signal,
      permissionMode: "workspace-write",
      fileReadStamps: new Map(),
    };

    const textResult = await ReadTool.call({ file_path: textFile, offset: 0, limit: 10 }, ctx);
    assert.equal(textResult.output.totalLines, 4);
    assert.match(textResult.output.content, /€ survives a chunk boundary/);
    assert.doesNotMatch(textResult.output.content, /�/);
    assert.ok(Buffer.byteLength(textResult.output.content, "utf8") < 60 * 1024);
    assert.equal(
      ctx.fileReadStamps.get(textFile)?.hash,
      createHash("sha256").update(splitUtf8, "utf8").digest("hex"),
    );

    const directory = await ReadTool.call({ file_path: path.join(workspace, "folder") }, ctx);
    assert.match(directory.output.content, /child\.txt/);
    const binary = await ReadTool.call({ file_path: path.join(workspace, "binary.bin") }, ctx);
    assert.match(binary.output.content, /binary or uses an unsupported text encoding/i);
    assert.equal(ctx.fileReadStamps.has(path.join(workspace, "binary.bin")), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Read extracts bounded PDF pages and preserves exact read evidence", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-read-pdf-"));
  try {
    const pdf = simplePdf(["First page contract", "Second page evidence"]);
    const file = path.join(workspace, "spec.pdf");
    await writeFile(file, pdf);
    const ctx = {
      workspace,
      sessionId: "read-pdf-session",
      signal: new AbortController().signal,
      permissionMode: "workspace-write",
      fileReadStamps: new Map(),
    };

    const first = await ReadTool.call({ file_path: file, offset: 0, limit: 1 }, ctx);
    assert.equal(first.output.unit, "pages");
    assert.equal(first.output.totalLines, 2);
    assert.match(first.output.content, /First page contract/);
    assert.doesNotMatch(first.output.content, /Second page evidence/);
    assert.equal(first.output.truncated, true);

    const second = await ReadTool.call({ file_path: file, offset: 1, limit: 1 }, ctx);
    assert.match(second.output.content, /Second page evidence/);
    assert.equal(second.output.truncated, false);
    assert.equal(ctx.fileReadStamps.get(file)?.hash, createHash("sha256").update(pdf).digest("hex"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Read caps an oversized first PDF page and advances continuation to the next page", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-read-pdf-oversized-"));
  try {
    const hugeFirstPage = `first-page-prefix ${"x".repeat(80 * 1024)} first-page-tail`;
    const pdf = simplePdf([hugeFirstPage, "second page remains reachable"]);
    const file = path.join(workspace, "oversized.pdf");
    await writeFile(file, pdf);
    const ctx = {
      workspace,
      sessionId: "read-pdf-oversized-session",
      signal: new AbortController().signal,
      permissionMode: "workspace-write",
      fileReadStamps: new Map(),
    };

    const first = await ReadTool.call({ file_path: file, offset: 0, limit: 2 }, ctx);
    assert.equal(first.output.unit, "pages");
    assert.equal(first.output.endLine, 1, "an oversized page is consumed exactly once");
    assert.equal(first.output.truncated, true);
    assert.ok(Buffer.byteLength(first.output.content, "utf8") <= 50 * 1024, "the complete result obeys the 50KB cap");
    assert.match(first.output.content, /remaining text on that page was omitted/i);
    assert.match(first.output.content, /Use offset=1 to continue with page 2/i);
    assert.doesNotMatch(first.output.content, /second page remains reachable/);

    const second = await ReadTool.call({ file_path: file, offset: 1, limit: 1 }, ctx);
    assert.match(second.output.content, /second page remains reachable/);
    assert.equal(second.output.endLine, 2);
    assert.equal(second.output.truncated, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("nested repository instructions are session-local, hash-versioned inputs to reads and writes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-nested-rules-"));
  try {
    const nested = path.join(workspace, "packages", "api", "src");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "root-rule: preserve public APIs\n");
    const nestedRule = path.join(workspace, "packages", "api", "ARES.md");
    await writeFile(nestedRule, "nested-rule: use the API test helper\n");
    const target = path.join(nested, "index.ts");
    await writeFile(target, "export const api = 1;\n");

    const resolverA = new RepositoryInstructionResolver(workspace);
    const ctxA = {
      workspace,
      sessionId: "rules-a",
      signal: new AbortController().signal,
      permissionMode: "workspace-write",
      fileReadStamps: new Map(),
      repositoryInstructions: resolverA,
    };
    const first = await ReadTool.call({ file_path: target }, ctxA);
    assert.match(first.output.content, /root-rule: preserve public APIs/);
    assert.match(first.output.content, /nested-rule: use the API test helper/);
    assert.equal(resolverA.claims().length, 2);

    const duplicate = await ReadTool.call({ file_path: target }, ctxA);
    assert.doesNotMatch(duplicate.output.content, /<repository-instructions>/);

    await writeFile(nestedRule, "nested-rule: run the contract fixture\n");
    const changed = await ReadTool.call({ file_path: target }, ctxA);
    assert.match(changed.output.content, /nested-rule: run the contract fixture/);
    assert.doesNotMatch(changed.output.content, /nested-rule: use the API test helper/);

    const resolverB = new RepositoryInstructionResolver(workspace);
    const ctxB = { ...ctxA, sessionId: "rules-b", fileReadStamps: new Map(), repositoryInstructions: resolverB };
    const directory = await ReadTool.call({ file_path: nested }, ctxB);
    assert.match(directory.output.content, /root-rule: preserve public APIs/);
    assert.match(directory.output.content, /nested-rule: run the contract fixture/);

    const resolverWriter = new RepositoryInstructionResolver(workspace);
    const writer = adaptToolForEngine(WriteTool, (base) => ({
      ...base,
      permissionMode: "workspace-write",
      fileReadStamps: base.fileReadStamps ?? new Map(),
      repositoryInstructions: resolverWriter,
    }));
    const newFile = path.join(nested, "new.ts");
    const base = {
      workspace,
      sessionId: "rules-writer",
      toolUseId: "write-rules",
      signal: new AbortController().signal,
      fileReadStamps: new Map(),
    };
    await assert.rejects(
      writer.call({ file_path: newFile, content: "export const next = 2;\n" }, base),
      /Repository instructions were loaded before this mutation/,
    );
    await assert.rejects(readFile(newFile, "utf8"), /ENOENT/);
    await writer.call({ file_path: newFile, content: "export const next = 2;\n" }, base);
    assert.equal(await readFile(newFile, "utf8"), "export const next = 2;\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("both shell adapters share one contract and load cwd rules before process execution", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-shell-rules-"));
  try {
    const nested = path.join(workspace, "packages", "service");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "root shell rule\n");
    await writeFile(path.join(nested, "ARES.md"), "nested shell rule\n");

    const exercise = async (shell, sessionId) => {
      const resolver = new RepositoryInstructionResolver(workspace);
      const ctx = {
        workspace,
        sessionId,
        signal: new AbortController().signal,
        permissionMode: "workspace-write",
        fileReadStamps: new Map(),
        repositoryInstructions: resolver,
      };
      const input = {
        command: "node --version",
        description: "Inspect Node version",
        timeout: 120_000,
        cwd: workspace,
        target_paths: [nested],
        run_in_background: false,
      };
      const first = await shell.checkPermissions(input, ctx);
      assert.equal(first.kind, "deny");
      assert.match(first.reason, /root shell rule/);
      assert.match(first.reason, /nested shell rule/);
      const second = await shell.checkPermissions(input, ctx);
      assert.deepEqual(second, { kind: "allow" });
    };

    await exercise(BashTool, "bash-rules");
    await exercise(PowerShellTool, "powershell-rules");

    const stripDescriptions = (value) => JSON.parse(JSON.stringify(value), (key, entry) =>
      key === "description" ? undefined : entry);
    assert.deepEqual(
      stripDescriptions(BashTool.schema.inputJsonSchema),
      stripDescriptions(PowerShellTool.schema.inputJsonSchema),
      "Bash and PowerShell expose the same cwd/timeout/background schema",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("shell rules follow approved external cwd and resolve relative targets from that cwd", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-shell-session-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "ares-shell-external-project-"));
  try {
    const nested = path.join(external, "packages", "service");
    const target = path.join(nested, "src", "index.ts");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(path.join(external, "package.json"), "{\"private\":true}\n");
    await writeFile(path.join(external, "AGENTS.md"), "external root shell rule\n");
    await writeFile(target, "export const service = true;\n");

    const approvedExternalPaths = {
      isAllowed(candidate) {
        const relative = path.relative(external, path.resolve(candidate));
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      },
      grant() {},
    };

    const exercise = async (shell, sessionId, permissionMode, pathPermissions) => {
      const nestedRule = path.join(nested, "CLAUDE.md");
      await writeFile(nestedRule, "external nested shell rule v1\n");
      const resolver = new RepositoryInstructionResolver(workspace);
      const ctx = {
        workspace,
        sessionId,
        signal: new AbortController().signal,
        permissionMode,
        fileReadStamps: new Map(),
        repositoryInstructions: resolver,
        ...(pathPermissions ? { pathPermissions } : {}),
      };
      const input = {
        command: "node --version",
        description: "Inspect external Node version",
        timeout: 120_000,
        cwd: external,
        target_paths: ["packages/service/src/index.ts"],
        run_in_background: false,
      };

      const first = await shell.checkPermissions(input, ctx);
      assert.equal(first.kind, "deny");
      assert.match(first.reason, /external root shell rule/);
      assert.match(first.reason, /external nested shell rule v1/);
      assert.equal(resolver.claims().length, 2);
      assert.deepEqual(await shell.checkPermissions(input, ctx), { kind: "allow" });

      await writeFile(nestedRule, "external nested shell rule v2\n");
      const changed = await shell.checkPermissions(input, ctx);
      assert.equal(changed.kind, "deny", "changed external rules are reattached by content hash");
      assert.match(changed.reason, /external nested shell rule v2/);
      assert.doesNotMatch(changed.reason, /external nested shell rule v1/);
    };

    await exercise(BashTool, "bash-external-rules", "bypass");
    await exercise(PowerShellTool, "powershell-external-rules", "workspace-write", approvedExternalPaths);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("every Session owns a distinct read-before-write evidence map", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-read-isolation-"));
  try {
    const seen = [];
    const probe = {
      schema: {
        name: "Probe",
        description: "fixture",
        inputJsonSchema: { type: "object" },
        safety: "read-only",
        concurrency: "parallel-safe",
      },
      async call(_input, ctx) {
        seen.push(ctx.fileReadStamps);
        ctx.fileReadStamps.set(path.join(workspace, "only-this-session"), { mtimeMs: 1, size: 1 });
        return { output: { ok: true } };
      },
    };
    const makeSession = (id) => new Session({
      sessionId: id,
      workspace,
      provider: toolThenDoneProvider("Probe", {}),
      model: "mock",
      systemPrompt: "test",
      tools: [probe],
      contextBudgetTokens: 0,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
    });
    await drain(makeSession("read-map-a").send("probe"));
    await drain(makeSession("read-map-b").send("probe"));
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("input-aware safety lets plan mode inspect but blocks the effectful variant", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-plan-dynamic-safety-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  let safeCalls = 0;
  let effectfulCalls = 0;
  try {
    const browserFixture = (counter) => buildTool({
      name: "Browser",
      description: "mixed read/action fixture",
      safety: "workspace-write",
      concurrency: "exclusive",
      dynamicSafety: (input) => input.action === "tree" ? "read-only" : "external-state",
      inputZod: z.object({ action: z.enum(["tree", "click"]) }).strict(),
      activityDescription: (input) => input.action,
      async call(input) {
        counter();
        return { output: { action: input.action } };
      },
    });
    const make = (id, input, tool) => {
      const session = new Session({
        sessionId: id,
        workspace,
        provider: toolThenDoneProvider("Browser", input),
        model: "mock",
        systemPrompt: "test",
        tools: [adaptToolForEngine(tool, (base) => rich(base, "plan"))],
        sessionKernel: store,
        contextBudgetTokens: 0,
        telemetryDir: path.join(workspace, "telemetry"),
        sessionRegistryHome: workspace,
      });
      session.setWorkflowMode("plan");
      return session;
    };

    await drain(make("plan-safe-input", { action: "tree" }, browserFixture(() => safeCalls += 1)).send("inspect"));
    await drain(make("plan-effect-input", { action: "click" }, browserFixture(() => effectfulCalls += 1)).send("act"));
    assert.equal(safeCalls, 1);
    assert.equal(effectfulCalls, 0);
    assert.equal(store.listToolRuns("plan-safe-input")[0]?.effectKind, "read-only");
    assert.equal(store.listToolRuns("plan-safe-input")[0]?.executionState, "succeeded");
    assert.equal(store.listToolRuns("plan-effect-input").length, 0, "blocked effects never cross durable tool admission");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("two Session instances execute durable queue inputs in admission order and rehydrate canonical history", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-cross-session-fifo-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  const invocationOrder = [];
  let secondFirstRequest;
  try {
    const delayedTextProvider = (label, delayMs, onRequest) => ({
      name: `fifo-${label}`,
      async *stream(request) {
        invocationOrder.push(label);
        onRequest?.(request);
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield {
          type: "message_done",
          message: {
            id: `fifo-reply-${label}`,
            role: "assistant",
            content: [{ type: "text", text: `reply ${label}` }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    });
    const base = {
      sessionId: "shared-fifo-session",
      workspace,
      model: "mock",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
    };
    const first = new Session({ ...base, provider: delayedTextProvider("A", 100) });
    const second = new Session({
      ...base,
      provider: delayedTextProvider("B", 0, (request) => { secondFirstRequest ??= request; }),
    });

    const firstRun = drain(first.sendContent([{ type: "text", text: "input A" }], { inputId: "fifo-A" }));
    while (!store.getInput("fifo-A")) await new Promise((resolve) => setTimeout(resolve, 1));
    const secondRun = drain(second.sendContent([{ type: "text", text: "input B" }], { inputId: "fifo-B" }));
    await Promise.all([firstRun, secondRun]);

    assert.deepEqual(invocationOrder, ["A", "B"]);
    assert.equal(store.getInput("fifo-A")?.state, "consumed");
    assert.equal(store.getInput("fifo-B")?.state, "consumed");
    const secondText = secondFirstRequest.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.match(secondText, /reply A/, "the second process sees the first process's canonical assistant turn");
    assert.match(secondText, /input B/);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
