// Verifies Read never hands the model blind content:
//   - a genuinely empty file says so explicitly (not "" / a lone blank line)
//   - an unchanged re-read returns the requested bytes again (context may have
//     been compacted since the first Read)
//   - a normal read returns the file contents
//   - read stamps don't cross between independent contexts (no phantom
//     read-before-write grant from one ctx to another)

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ReadTool, EditTool } from "../packages/tools/dist/index.js";

const makeTmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-v23-"));
const ctx = (workspace) => ({
  workspace,
  signal: new AbortController().signal,
  permissionMode: "workspace-write",
  fileReadStamps: new Map(),
});

// ── 1. Empty file → explicit, never blank ─────────────────────────────────────

test("read: a genuinely empty file returns an explicit empty-file message", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "empty.txt");
  await fs.writeFile(file, "", "utf8");
  const r = await ReadTool.call({ file_path: file }, ctx(tmp));
  assert.equal(r.output.totalLines, 0, "zero lines, not a phantom blank line");
  assert.match(r.output.content, /empty \(0 bytes\)/i, "says the file is empty");
  assert.notEqual(r.output.content.trim(), "", "content is never blank");
});

// ── 2. Unchanged re-read → requested bytes again ──────────────────────────────

test("read: an unchanged re-read returns file bytes instead of relying on stale context", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "app.ts");
  await fs.writeFile(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
  const c = ctx(tmp);

  const first = await ReadTool.call({ file_path: file }, c);
  assert.match(first.output.content, /const a = 1;/, "first read returns the real contents");

  const again = await ReadTool.call({ file_path: file }, c); // same ctx, unchanged file
  assert.notEqual(again.output.content.trim(), "", "re-read content is NOT empty");
  assert.match(again.output.content, /const a = 1;/, "re-read returns the real contents again");
  assert.match(again.output.content, /const c = 3;/, "re-read is complete within the normal cap");
  assert.doesNotMatch(again.output.content, /already in your context/i);
  assert.equal(again.output.totalLines, 4, "line count remains exact");
});

// ── 3. Normal read is unchanged ───────────────────────────────────────────────

test("read: a normal read still returns cat -n file contents", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "hello.txt");
  await fs.writeFile(file, "first\nsecond\n", "utf8");
  const r = await ReadTool.call({ file_path: file }, ctx(tmp));
  assert.match(r.output.content, /1\tfirst/);
  assert.match(r.output.content, /2\tsecond/);
  assert.equal(r.output.totalLines, 3, "two lines + trailing newline split");
});

// ── 4. Read stamps don't leak across contexts (no phantom read grant) ─────────

test("read: a read in one context does not bless another context's edit", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "shared.ts");
  await fs.writeFile(file, "let x = 1;\n", "utf8");

  const parent = ctx(tmp);
  const child = ctx(tmp); // independent fileReadStamps map (a separate engine/subagent)

  await ReadTool.call({ file_path: file }, child); // ONLY the child reads it
  assert.equal(parent.fileReadStamps.has(path.resolve(file)), false, "parent never gained a stamp from the child's read");

  // The parent, never having read it, must be refused the edit (read-before-write).
  await assert.rejects(
    EditTool.call({ file_path: file, old_string: "let x = 1;", new_string: "let x = 2;", replace_all: false }, parent),
    /read/i,
    "parent edit is blocked because it never read the file in its own context",
  );

  // The child, which did read it, can edit.
  const ok = await EditTool.call({ file_path: file, old_string: "let x = 1;", new_string: "let x = 2;", replace_all: false }, child);
  assert.equal(ok.output.replacements, 1, "the context that actually read the file can edit it");
});
