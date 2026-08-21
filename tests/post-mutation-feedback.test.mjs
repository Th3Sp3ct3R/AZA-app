import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PostMutationFeedbackService,
  workspaceContentHash,
} from "../packages/core/dist/index.js";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ares-post-mutation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".prettierrc.json"), "{}\n");
  return root;
}

async function installFakePrettier(root, source) {
  const packageRoot = path.join(root, "node_modules", "prettier");
  await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "prettier", version: "0.0.0-test", bin: { prettier: "bin/prettier.cjs" } }),
  );
  await fs.writeFile(path.join(packageRoot, "bin", "prettier.cjs"), source);
}

test("post-mutation feedback groups formatter work once and binds every result to committed hashes", async (t) => {
  const root = await workspace(t);
  await installFakePrettier(root, `
    const fs = require("node:fs");
    const path = require("node:path");
    const files = process.argv.slice(2).filter((arg) => path.isAbsolute(arg) && /\\.[cm]?[jt]s$/.test(arg));
    const bad = files.filter((file) => fs.readFileSync(file, "utf8").includes("BAD"));
    if (bad.length) {
      process.stdout.write("Needs formatting: " + bad.join(", "));
      process.exitCode = 1;
    }
  `);
  const first = path.join(root, "src", "a.ts");
  const second = path.join(root, "src", "b.ts");
  const firstText = "export const BAD=1;\n";
  const secondText = "export const good = 2;\n";
  await fs.writeFile(first, firstText);
  await fs.writeFile(second, secondText);

  const feedback = await new PostMutationFeedbackService(root).inspect([
    { path: first, committedHash: workspaceContentHash(firstText) },
    { path: second, committedHash: workspaceContentHash(secondText) },
  ]);

  assert.equal(feedback.status, "issues");
  assert.equal(feedback.checks.length, 1, "one configured formatter runs once for the complete transaction");
  const [check] = feedback.checks;
  assert.equal(check.tool, "prettier");
  assert.equal(check.kind, "format");
  assert.equal(check.status, "issues");
  assert.deepEqual(new Set(check.files), new Set([first, second]));
  assert.equal(check.committedHashes[first], workspaceContentHash(firstText));
  assert.equal(check.committedHashes[second], workspaceContentHash(secondText));
  assert.match(check.output, /Needs formatting/);
  assert.equal(await fs.readFile(first, "utf8"), firstText, "check-mode feedback never rewrites or rolls back a valid edit");
});

test("post-mutation feedback kills slow tools, bounds output, and preserves committed bytes", async (t) => {
  const root = await workspace(t);
  await installFakePrettier(root, `
    process.stdout.write("x".repeat(100000));
    setInterval(() => {}, 1000);
  `);
  const file = path.join(root, "src", "slow.ts");
  const text = "export const stillHere = true;\n";
  await fs.writeFile(file, text);

  const feedback = await new PostMutationFeedbackService(root, {
    formatTimeoutMs: 250,
    totalTimeoutMs: 1_000,
    maxOutputChars: 2_000,
    diagnostics: false,
  }).inspect([{ path: file, committedHash: workspaceContentHash(text) }]);

  assert.equal(feedback.status, "incomplete");
  assert.equal(feedback.checks[0].status, "timed_out");
  assert.equal(feedback.checks[0].outputTruncated, true);
  assert.ok(feedback.checks[0].output.length < 2_100, "captured diagnostics stay inside the bounded envelope");
  assert.equal(await fs.readFile(file, "utf8"), text);
});

test("post-mutation feedback refuses to attribute checks after hash drift", async (t) => {
  const root = await workspace(t);
  await installFakePrettier(root, "process.exitCode = 0;");
  const file = path.join(root, "src", "drifted.ts");
  await fs.writeFile(file, "export const now = 2;\n");

  const feedback = await new PostMutationFeedbackService(root).inspect([
    { path: file, committedHash: workspaceContentHash("export const before = 1;\n") },
  ]);

  assert.equal(feedback.status, "stale");
  assert.equal(feedback.checks.length, 0);
  assert.equal(feedback.files[0].state, "drifted");
});

test("configured tooling that is not installed is returned as actionable incomplete feedback", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "src", "missing-tool.ts");
  const text = "export const value = 1;\n";
  await fs.writeFile(file, text);

  const feedback = await new PostMutationFeedbackService(root).inspect([
    { path: file, committedHash: workspaceContentHash(text) },
  ]);

  assert.equal(feedback.status, "incomplete");
  assert.equal(feedback.checks[0].status, "unavailable");
  assert.match(feedback.checks[0].detail, /configured.*no safe local\/native executable/i);
});

test("all core editing tools use the single shared post-mutation feedback gateway", async () => {
  const toolsRoot = path.resolve("packages", "tools", "src");
  for (const file of ["Write.ts", "Edit.ts", "ApplyPatch.ts", "ApplyIntent.ts", "FindAndEdit.ts", "CodeMode.ts"]) {
    const source = await fs.readFile(path.join(toolsRoot, file), "utf8");
    assert.match(source, /collectMutationFeedback\(/, `${file} must return centralized post-mutation feedback`);
    assert.match(source, /appendMutationFeedback\(/, `${file} must expose bounded feedback in its model-visible result`);
  }
});
