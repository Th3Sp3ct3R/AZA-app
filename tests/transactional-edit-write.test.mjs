import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EditTool } from "../packages/tools/dist/Edit.js";
import { ReadTool } from "../packages/tools/dist/Read.js";
import { WriteTool } from "../packages/tools/dist/Write.js";
import { ApplyIntentTool } from "../packages/tools/dist/ApplyIntent.js";
import { CodeModeTool } from "../packages/tools/dist/CodeMode.js";
import { FindAndEditTool } from "../packages/tools/dist/FindAndEdit.js";

async function context(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-transactional-tools-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

async function mutationReceipts(workspace) {
  const root = path.join(workspace, ".ares", "mutations");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const receipts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const receiptPath = path.join(root, entry.name, "receipt.json");
    const raw = await fs.readFile(receiptPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (raw !== null) receipts.push(JSON.parse(raw));
  }
  return receipts;
}

test("Write routes an in-workspace overwrite through a durable CAS transaction", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "write.txt");
  await fs.writeFile(file, "before\n");
  await ReadTool.call({ file_path: file }, ctx);

  const result = await WriteTool.call({ file_path: file, content: "after\n" }, ctx);
  assert.equal(await fs.readFile(file, "utf8"), "after\n");
  assert.ok(result.output.backupPath, "legacy user-visible backup remains available");
  assert.equal(await fs.readFile(result.output.backupPath, "utf8"), "before\n");

  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "Write");
  assert.equal(receipts[0].status, "committed");
  assert.equal(receipts[0].operations[0].kind, "update");
  assert.equal(receipts[0].operations[0].path, file);
});

test("Edit routes the final resilient replacement through one durable transaction", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "edit.txt");
  await fs.writeFile(file, "alpha\nbeta\ngamma\n");
  await ReadTool.call({ file_path: file }, ctx);

  const result = await EditTool.call(
    { file_path: file, old_string: "beta", new_string: "BETA", replace_all: false },
    ctx,
  );
  assert.equal(result.output.replacements, 1);
  assert.equal(await fs.readFile(file, "utf8"), "alpha\nBETA\ngamma\n");

  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "Edit");
  assert.equal(receipts[0].operations.length, 1);
  assert.equal(receipts[0].operations[0].kind, "update");
});

test("a stale Edit is rejected before a mutation journal or project write", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "stale.txt");
  await fs.writeFile(file, "version one\n");
  await ReadTool.call({ file_path: file }, ctx);
  await fs.writeFile(file, "external version\n");

  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: "version one", new_string: "agent version", replace_all: false },
      ctx,
    ),
    /modified on disk since the last Read/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "external version\n");
  assert.deepEqual(await mutationReceipts(ctx.workspace), []);
});

test("FindAndEdit commits every matched file in one recoverable transaction", async (t) => {
  const ctx = await context(t);
  const first = path.join(ctx.workspace, "first.ts");
  const second = path.join(ctx.workspace, "second.ts");
  await fs.writeFile(first, "export const state = 'old';\n");
  await fs.writeFile(second, "export const other = 'old';\n");

  await FindAndEditTool.call(
    {
      pattern: "'old'",
      replacement: "'new'",
      flags: "g",
      file_glob: "*.ts",
      target_directories: [],
      max_files: 10,
      dry_run: false,
    },
    ctx,
  );

  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "FindAndEdit");
  assert.equal(receipts[0].operations.length, 2);
  assert.equal(await fs.readFile(first, "utf8"), "export const state = 'new';\n");
  assert.equal(await fs.readFile(second, "utf8"), "export const other = 'new';\n");
});

test("CodeMode stages writes until success and commits a successful batch once", async (t) => {
  const ctx = await context(t);
  const existing = path.join(ctx.workspace, "existing.txt");
  const added = path.join(ctx.workspace, "added.txt");
  await fs.writeFile(existing, "before\n");

  await assert.rejects(
    CodeModeTool.call(
      {
        code: "await ares.write('existing.txt', 'bad\\n'); await ares.write('added.txt', 'bad\\n'); throw new Error('stop');",
        timeout_ms: 5_000,
        allow_writes: true,
      },
      ctx,
    ),
    /stop/,
  );
  assert.equal(await fs.readFile(existing, "utf8"), "before\n");
  await assert.rejects(fs.access(added));
  assert.equal((await mutationReceipts(ctx.workspace)).length, 0);

  await CodeModeTool.call(
    {
      code: "await ares.write('existing.txt', 'after\\n'); ares.write('added.txt', 'new\\n'); return 'done';",
      timeout_ms: 5_000,
      allow_writes: true,
    },
    ctx,
  );
  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "CodeMode");
  assert.equal(receipts[0].operations.length, 2);
  assert.equal(await fs.readFile(existing, "utf8"), "after\n");
  assert.equal(await fs.readFile(added, "utf8"), "new\n");
});

test("ApplyIntent uses the same CAS mutation ledger for in-workspace files", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "intent.ts");
  await fs.writeFile(file, "export const before = true;\n");
  await ReadTool.call({ file_path: file }, ctx);

  const result = await ApplyIntentTool.call(
    {
      file_path: file,
      instructions: "rename the exported flag",
      sketch: "export const after = true;\n",
    },
    ctx,
  );

  assert.ok(result.output.backupPath);
  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "ApplyIntent");
  assert.equal(receipts[0].operations[0].kind, "update");
  assert.equal(await fs.readFile(file, "utf8"), "export const after = true;");
});

test("Write add uses create-if-absent transaction semantics and emits an add receipt", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "new", "file.txt");
  await WriteTool.call({ file_path: file, content: "created\n" }, ctx);

  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "Write");
  assert.equal(receipts[0].operations[0].kind, "add");
  assert.equal(await fs.readFile(file, "utf8"), "created\n");
});
