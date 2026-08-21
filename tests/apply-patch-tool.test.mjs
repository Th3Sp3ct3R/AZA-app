import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplyPatchTool } from "../packages/tools/dist/ApplyPatch.js";

async function setup(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-apply-patch-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

test("ApplyPatch performs a complete GPT-style add/update/delete/rename transaction", async (t) => {
  const ctx = await setup(t);
  await fs.mkdir(path.join(ctx.workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(ctx.workspace, "src", "update.txt"), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("heading\r\nvalue = 1\r\n", "utf8"),
  ]));
  await fs.writeFile(path.join(ctx.workspace, "move.txt"), "before move\n");
  await fs.writeFile(path.join(ctx.workspace, "delete.txt"), "delete me\n");

  const patch = [
    "*** Begin Patch",
    "*** Add File: src/added.txt",
    "+new file",
    "*** Update File: src/update.txt",
    "@@ heading",
    "-value = 1",
    "+value = 2",
    "*** Update File: move.txt",
    "*** Move to: src/moved.txt",
    "@@",
    "-before move",
    "+after move",
    "*** Delete File: delete.txt",
    "*** End Patch",
  ].join("\n");

  const result = await ApplyPatchTool.call({ patch }, ctx);
  assert.equal(await fs.readFile(path.join(ctx.workspace, "src", "added.txt"), "utf8"), "new file\n");
  const updated = await fs.readFile(path.join(ctx.workspace, "src", "update.txt"));
  assert.equal(updated.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), true, "preserves UTF-8 BOM");
  assert.equal(updated.subarray(3).toString("utf8"), "heading\r\nvalue = 2\r\n", "preserves CRLF");
  await assert.rejects(fs.stat(path.join(ctx.workspace, "move.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(ctx.workspace, "src", "moved.txt"), "utf8"), "after move\n");
  await assert.rejects(fs.stat(path.join(ctx.workspace, "delete.txt")), { code: "ENOENT" });

  assert.deepEqual(result.output.added, ["src/added.txt"]);
  assert.deepEqual(result.output.modified, ["src/update.txt"]);
  assert.deepEqual(result.output.deleted, ["delete.txt"]);
  assert.deepEqual(result.output.renamed, [{ from: "move.txt", to: "src/moved.txt" }]);
  assert.match(result.display, /Success\. Applied the complete patch/);
  assert.equal(ctx.fileReadStamps.has(path.join(ctx.workspace, "src", "update.txt")), true);
  assert.equal(ctx.fileReadStamps.has(path.join(ctx.workspace, "src", "moved.txt")), true);
});

test("ApplyPatch computes every hunk before mutation, so a late bad hunk applies nothing", async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(path.join(ctx.workspace, "existing.txt"), "actual\n");
  const patch = [
    "*** Begin Patch",
    "*** Add File: should-not-exist.txt",
    "+not committed",
    "*** Update File: existing.txt",
    "@@",
    "-hallucinated",
    "+replacement",
    "*** End Patch",
  ].join("\n");

  await assert.rejects(
    ApplyPatchTool.call({ patch }, ctx),
    (error) => /could not find its expected lines/.test(error.message) && /no files were changed/i.test(error.message),
  );
  await assert.rejects(fs.stat(path.join(ctx.workspace, "should-not-exist.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(ctx.workspace, "existing.txt"), "utf8"), "actual\n");
});

test("ApplyPatch reaches an out-of-workspace project under bypass, like Write/Edit", async (t) => {
  // The FPSgame regression: workspace on the Desktop, project at D:\FPSgame —
  // ApplyPatch was the ONE mutation tool refusing owner-approved external
  // paths, forcing lossy full-file Write fallbacks.
  const ctx = await setup(t);
  ctx.permissionMode = "bypass";
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "ares-apply-patch-ext-"));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  // A real external project (repo marker), like D:\FPSgame — the transaction
  // root resolves to the project, not the workspace.
  await fs.mkdir(path.join(external, ".git"), { recursive: true });
  const target = path.join(external, "Weapons", "WeaponDefinition.h");
  const patch = [
    "*** Begin Patch",
    `*** Add File: ${target}`,
    "+#pragma once",
    "*** End Patch",
  ].join("\n");

  const verdict = await ApplyPatchTool.validateInput({ patch }, ctx);
  assert.equal(verdict.ok, true, `validation should pass: ${verdict.message ?? ""}`);
  await ApplyPatchTool.call({ patch }, ctx);
  assert.equal(await fs.readFile(target, "utf8"), "#pragma once\n");
});

test("ApplyPatch denies out-of-workspace targets when no permission channel exists", async (t) => {
  // Guarded mode without a prompt (subagent/deny-stub posture): the same
  // refusal contract as resolveWorkspacePath everywhere else — denied at the
  // permission layer, before any file is read or computed.
  const ctx = await setup(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "ares-apply-patch-deny-"));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  const patch = [
    "*** Begin Patch",
    `*** Add File: ${path.join(external, "escape.txt")}`,
    "+no",
    "*** End Patch",
  ].join("\n");
  await assert.rejects(
    ApplyPatchTool.call({ patch }, ctx),
    (error) => /escapes workspace|denied outside workspace/.test(error.message),
  );
  await assert.rejects(fs.stat(path.join(external, "escape.txt")), { code: "ENOENT" });
});
