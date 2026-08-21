// Fixes driven by the 2026-08-02 sweep of 61 real sessions.
//
//  1. Memory must not eat the context window (24,112 chars observed injected
//     at session start; reminders ran 10.5:1 against the model's own output).
//  2. Tool errors must never become durable memories.
//  3. A truncated large Write must say "split it", not "try again".
//  4. Edit must be able to insert large content by reference, so shell
//     string-surgery has no honest reason to exist.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadMemoryReminders } from "../packages/core/dist/index.js";
import { coerceToolArgs } from "../packages/core/dist/providers/_toolPairs.js";
import { EditTool } from "../packages/tools/dist/index.js";

// ── 1. memory injection is capped ────────────────────────────────────────────

test("an oversized project memory.md is capped, and says how to fix itself", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "ares-mem-cap-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await mkdir(path.join(ws, ".ares"), { recursive: true });
  // The real file reached 24k chars. Write well past that.
  await writeFile(path.join(ws, ".ares", "memory.md"), "x".repeat(40_000), "utf8");

  const reminders = await loadMemoryReminders(ws);
  const projectMemory = reminders.find((r) => r.text.includes("project memory"));
  assert.ok(projectMemory, "project memory still loads");
  assert.ok(
    projectMemory.text.length < 6_000,
    `memory injection must stay small, got ${projectMemory.text.length} chars`,
  );
  assert.match(projectMemory.text, /truncated/, "truncation is disclosed, never silent");
  assert.match(projectMemory.text, /consolidate/, "names the command that actually fixes it");
});

test("a small curated memory is injected in full", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "ares-mem-small-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await mkdir(path.join(ws, ".ares"), { recursive: true });
  await writeFile(path.join(ws, ".ares", "memory.md"), "- User prefers pnpm over npm.\n", "utf8");
  const reminders = await loadMemoryReminders(ws);
  const mem = reminders.find((r) => r.text.includes("project memory"));
  assert.match(mem.text, /prefers pnpm/);
  assert.doesNotMatch(mem.text, /truncated/);
});

// ── 3. truncated large write gets a strategy, not a retry ────────────────────

test("a truncated large Write is told to split, not to re-send", () => {
  const cut = `{"file_path":"C:\\\\big.html","content":"${"a".repeat(3000)}`;
  assert.throws(
    () => coerceToolArgs(cut, "Write"),
    (error) => /cut off mid-value/.test(error.message) &&
      /output-token limit/.test(error.message) &&
      /Split the work/.test(error.message),
  );
});

test("a genuinely malformed SHORT payload keeps the plain syntax error", () => {
  assert.throws(
    () => coerceToolArgs('{"file_path": }', "Write"),
    (error) => /malformed or truncated/.test(error.message) && !/Split the work/.test(error.message),
  );
});

// ── 4. Edit composes large content by reference ──────────────────────────────

function ctxFor(ws, stamps) {
  return {
    workspace: ws,
    permissionMode: "bypass",
    fileReadStamps: stamps,
    signal: new AbortController().signal,
  };
}

test("Edit inlines another file's contents without the bytes passing through the model", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "ares-edit-compose-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const page = path.join(ws, "index.html");
  const lib = path.join(ws, "three.min.js");
  // The real case: a ~600 KB library that could never fit in new_string.
  const libBody = `/*lib*/${"z".repeat(200_000)}`;
  await writeFile(page, "<html>\n<script>/*INLINE_LIB*/</script>\n</html>\n", "utf8");
  await writeFile(lib, libBody, "utf8");

  const stamps = new Map();
  const { contentHash } = await import("../packages/tools/dist/_shared.js");
  const current = await readFile(page, "utf8");
  stamps.set(page, { mtimeMs: Date.now(), hash: contentHash(current) });

  await EditTool.call({
    file_path: page,
    old_string: "/*INLINE_LIB*/",
    new_string_from_file: lib,
    replace_all: false,
  }, ctxFor(ws, stamps));

  const after = await readFile(page, "utf8");
  assert.ok(after.includes(libBody), "the library body was spliced in from disk");
  assert.ok(!after.includes("/*INLINE_LIB*/"), "the marker was consumed");
});

test("Edit rejects new_string and new_string_from_file together", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "ares-edit-both-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const verdict = await EditTool.validateInput({
    file_path: path.join(ws, "a.txt"),
    old_string: "x",
    new_string: "y",
    new_string_from_file: path.join(ws, "b.txt"),
    replace_all: false,
  }, ctxFor(ws, new Map()));
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /both set|exactly one/i);
});

test("Edit still rejects a hunk with no replacement at all", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "ares-edit-none-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const verdict = await EditTool.validateInput({
    file_path: path.join(ws, "a.txt"),
    old_string: "x",
    replace_all: false,
  }, ctxFor(ws, new Map()));
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /new_string.*new_string_from_file/);
});

test("single-edit composition passes validation (the guard that predates it must not reject it)", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "ares-edit-validate-compose-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const verdict = await EditTool.validateInput({
    file_path: path.join(ws, "a.txt"),
    old_string: "/*MARKER*/",
    new_string_from_file: path.join(ws, "lib.js"),
    replace_all: false,
  }, ctxFor(ws, new Map()));
  assert.equal(verdict.ok, true, `composition must validate, got: ${verdict.message ?? ""}`);
});
