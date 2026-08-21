import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  composeVerifiedChildSession,
  composeVerifiedChildSessionSync,
  loadChildVerificationDebt,
  openWorkspaceSessionKernel,
} from "../packages/core/dist/index.js";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fenceOf(lease) {
  return {
    sessionId: lease.sessionId,
    generation: lease.generation,
    leaseToken: lease.leaseToken,
  };
}

function seedCanonicalDebt(kernel, sessionId, workspace, touchedFile) {
  kernel.createSession({ id: sessionId, workspaceKey: workspace });
  const lease = kernel.acquireRunnerLease(sessionId, `seed-${sessionId}`, 30_000);
  const fence = fenceOf(lease);
  let run = kernel.beginToolRun(fence, {
    callKey: `1:${sessionId}-write`,
    toolName: "Write",
    arguments: { file_path: touchedFile },
  });
  run = kernel.transitionToolRun(fence, run.id, "executing");
  kernel.transitionToolRun(fence, run.id, "succeeded", {
    result: "written",
    mutation: {
      toolUseId: `${sessionId}-write`,
      affectedPaths: [touchedFile],
    },
  });
  kernel.releaseRunnerLease(fence, {
    executionState: "completed",
    workOutcome: "unverified",
  });
}

function writeTool() {
  return {
    schema: {
      name: "Write",
      description: "composition parity writer",
      inputJsonSchema: { type: "object" },
      safety: "workspace-write",
      concurrency: "exclusive",
    },
    async call() {
      return { output: "unused" };
    },
  };
}

test("Task, Conductor, Operator, and Garrison share hooks, live manifests, fresh verifiers, and canonical debt", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-child-composition-"));
  const hookCommand = "node -e \"process.exit(0)\"";
  await fs.mkdir(path.join(workspace, ".ares"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".ares", "hooks.json"), JSON.stringify({
    hooks: [{ event: "PostToolUse", matcher: "Write(*)", command: hookCommand }],
  }), "utf8");
  const kernel = await openWorkspaceSessionKernel(workspace);
  const children = [];
  const tools = [writeTool()];
  const toolCatalogHash = sha256(JSON.stringify(tools.map((tool) => tool.schema)));
  const surfaces = ["task", "conductor", "operator", "garrison"];
  try {
    for (const surface of surfaces) {
      const sessionId = `composition-${surface}`;
      const touched = path.join(workspace, `${surface}.ts`);
      seedCanonicalDebt(kernel, sessionId, workspace, touched);
      let livePrompt = `${surface}-prompt-v1`;
      const summarizeSpan = async () => `${surface} summary`;
      const common = {
        surface,
        workspace,
        provider: { name: "composition-provider", async *stream() {} },
        model: "composition-model",
        systemPrompt: () => livePrompt,
        tools,
        sessionId,
        sessionKernel: kernel,
        summarizeSpan,
        contextInputs: () => ({ policy: { surface, revision: 1 } }),
        verifierOptions: {
          debounceMs: 60_000,
          async runCommand() {
            throw new Error("composition parity does not execute verification");
          },
        },
      };
      const child = surface === "garrison"
        ? composeVerifiedChildSessionSync({
            ...common,
            persistedDebt: await loadChildVerificationDebt(kernel, workspace, sessionId),
          })
        : await composeVerifiedChildSession(common);
      children.push(child);

      const hookMatches = child.composition.hookManager.matching({
        event: "PostToolUse",
        toolName: "Write",
        input: { file_path: touched },
        workspace,
      });
      assert.ok(
        hookMatches.some((hook) => hook.command === hookCommand),
        `${surface} receives workspace PostToolUse hooks`,
      );
      assert.deepEqual(child.composition.persistedDebt, {
        required: true,
        touchedFiles: [touched],
        scopeComplete: true,
      }, `${surface} restores exact debt from canonical mutation rows`);
      assert.equal(child.composition.summarizeSpan, summarizeSpan, `${surface} receives the host summarizer`);

      const firstManifest = child.composition.contextSourceVersions();
      assert.equal(firstManifest.systemPromptSha256, sha256(`${surface}-prompt-v1`));
      assert.equal(firstManifest.toolCatalogSha256, toolCatalogHash);
      assert.equal(
        firstManifest.policySha256,
        sha256(JSON.stringify({ surface, revision: 1 })),
      );
      livePrompt = `${surface}-prompt-v2`;
      assert.equal(
        child.composition.contextSourceVersions().systemPromptSha256,
        sha256(`${surface}-prompt-v2`),
        `${surface} hashes the live prompt source rather than a stale construction snapshot`,
      );
      assert.equal(
        child.composition.cleanupPolicy,
        surface === "garrison" ? "session-lifetime" : "after-turn",
      );
    }

    assert.equal(
      new Set(children.map((child) => child.verifier)).size,
      surfaces.length,
      "every production surface owns a fresh verifier instance",
    );
  } finally {
    await Promise.all(children.map((child) => child.dispose()));
    kernel.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("production child call sites use only the shared composition boundary", async () => {
  const files = [
    ["packages/core/src/subagents.ts", /surface: "task"/, /withComposedVerifiedChildSession/],
    ["packages/core/src/conductor.ts", /surface: "conductor"/, /withComposedVerifiedChildSession/],
    ["packages/operator/src/dispatcher.ts", /surface: "operator"/, /withComposedVerifiedChildSession/],
    ["packages/cli/src/entry/garrisonCmd.ts", /surface: "garrison"/, /composeVerifiedChildSessionSync/],
  ];
  for (const [relative, surfacePattern, composerPattern] of files) {
    const source = await fs.readFile(path.join(process.cwd(), relative), "utf8");
    assert.match(source, surfacePattern, `${relative} declares its explicit surface policy`);
    assert.match(source, composerPattern, `${relative} enters the shared composer`);
    assert.doesNotMatch(source, /createVerifiedChildSession\(/, `${relative} does not hand-compose verifier sessions`);
  }
});
