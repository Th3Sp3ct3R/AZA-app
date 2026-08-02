// M1.3 — verify the seven core tools.
//
// Each tool is exercised against a real temp directory. RichToolContext
// is built inline; no provider/engine wiring needed at this stage.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ReadTool,
  WriteTool,
  EditTool,
  GlobTool,
  GrepTool,
  BashTool,
  PowerShellTool,
  adaptToolForEngine,
  resolveWorkspacePath,
} from "../packages/tools/dist/index.js";

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-m1-"));
  return dir;
}

function ctx(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

function pathStore() {
  const grants = [];
  return {
    grants,
    isAllowed(absPath, access) {
      const candidate = path.resolve(absPath);
      return grants.some((grant) => {
        const relative = path.relative(grant.path, candidate);
        const contains = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        const covers = grant.access === "all" || grant.access === access || (grant.access === "write" && access === "read");
        return contains && covers;
      });
    },
    grant(absPath, access, scope) {
      grants.push({ path: path.resolve(absPath), access, scope });
    },
  };
}

// ─── Read ──────────────────────────────────────────────────────────────

test("Read: full file with line numbers", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "a.txt");
  await fs.writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
  const c = ctx(tmp);
  const r = await ReadTool.call({ file_path: file }, c);
  assert.equal(r.output.totalLines, 4); // 4 because trailing newline produces empty line
  assert.match(r.output.content, /^\s+1\talpha/);
  assert.match(r.output.content, /\s+3\tgamma/);
  assert.ok(c.fileReadStamps.has(file));
});

test("Read: offset/limit slice", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "big.txt");
  await fs.writeFile(file, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n"), "utf8");
  const c = ctx(tmp);
  const r = await ReadTool.call({ file_path: file, offset: 10, limit: 5 }, c);
  assert.equal(r.output.startLine, 11);
  assert.equal(r.output.endLine, 15);
  assert.match(r.output.content, /\s+11\tline11/);
  assert.match(r.output.content, /\s+15\tline15/);
});

test("Read: accepts workspace-relative paths and blocks escapes", async () => {
  const tmp = await makeTmp();
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src", "rel.txt"), "ok", "utf8");
  const outside = path.join(tmp, "..", `outside-${Date.now()}.txt`);
  await fs.writeFile(outside, "secret", "utf8");
  const c = ctx(tmp);

  const r = await ReadTool.call({ file_path: "src/rel.txt" }, c);
  assert.equal(r.output.path, path.join(tmp, "src", "rel.txt"));
  assert.ok(c.fileReadStamps.has(path.join(tmp, "src", "rel.txt")));

  await assert.rejects(
    ReadTool.call({ file_path: outside }, c),
    /escapes workspace/,
  );
  await fs.rm(outside, { force: true });
});

test("Read: outside workspace can be allowed once by prompt", async () => {
  const tmp = await makeTmp();
  const outsideDir = await makeTmp();
  const outside = path.join(outsideDir, "allowed-once.txt");
  await fs.writeFile(outside, "outside read allowed once", "utf8");
  const store = pathStore();
  let asked = 0;
  const c = {
    ...ctx(tmp),
    pathPermissions: store,
    requestPermission: async (request) => {
      asked += 1;
      assert.equal(request.toolName, "Filesystem");
      assert.deepEqual(request.input, { path: outside, access: "read" });
      return "allow_once";
    },
  };

  const r = await ReadTool.call({ file_path: outside }, c);
  assert.match(r.output.content, /outside read allowed once/);
  assert.equal(asked, 1);
  // Approving an out-of-workspace file now covers its DIRECTORY (read/write),
  // not just the one file — so "work on this project" means the project, and
  // subagents/fleet leaves (which share this store but cannot prompt) can read
  // siblings instead of dying on the second file.
  assert.deepEqual(store.grants, [{ path: outsideDir, access: "read", scope: "once" }]);
  // Prove it: a sibling in the approved dir reads WITHOUT a second prompt.
  const sibling = path.join(outsideDir, "sibling.txt");
  await fs.writeFile(sibling, "sibling content", "utf8");
  const r2 = await ReadTool.call({ file_path: sibling }, c);
  assert.match(r2.output.content, /sibling content/);
  assert.equal(asked, 1, "sibling covered by the dir grant — no re-prompt");
});

test("Read: outside workspace can be allowed always by prompt", async () => {
  const tmp = await makeTmp();
  const outsideDir = await makeTmp();
  const outside = path.join(outsideDir, "allowed-always.txt");
  await fs.writeFile(outside, "outside read allowed always", "utf8");
  const store = pathStore();
  const c = {
    ...ctx(tmp),
    pathPermissions: store,
    requestPermission: async () => "allow_always",
  };

  const r = await ReadTool.call({ file_path: outside }, c);
  assert.match(r.output.content, /outside read allowed always/);
  assert.deepEqual(store.grants, [{ path: outsideDir, access: "read", scope: "always" }]);
});

test("Read: outside workspace decline blocks access", async () => {
  const tmp = await makeTmp();
  const outsideDir = await makeTmp();
  const outside = path.join(outsideDir, "declined.txt");
  await fs.writeFile(outside, "blocked", "utf8");
  const c = {
    ...ctx(tmp),
    pathPermissions: pathStore(),
    requestPermission: async () => "deny",
  };

  await assert.rejects(
    ReadTool.call({ file_path: outside }, c),
    /denied outside workspace/,
  );
});

test("permissions: allow always on outside cwd grants all access under that directory", async () => {
  const tmp = await makeTmp();
  const outsideDir = await makeTmp();
  const store = pathStore();
  const c = {
    ...ctx(tmp),
    pathPermissions: store,
    requestPermission: async () => "allow_always",
  };

  const resolved = await resolveWorkspacePath(c, outsideDir, "cwd", "execute");
  assert.equal(resolved, outsideDir);
  assert.deepEqual(store.grants, [{ path: outsideDir, access: "all", scope: "always" }]);
  assert.equal(store.isAllowed(path.join(outsideDir, "child.txt"), "write"), true);
  assert.equal(store.isAllowed(path.join(outsideDir, "nested", "thing.java"), "read"), true);
});

// ─── Write ─────────────────────────────────────────────────────────────

test("Write: create new file (no prior read required)", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "new.txt");
  const c = ctx(tmp);
  const decision = await WriteTool.checkPermissions({ file_path: file, content: "hello" }, c);
  assert.equal(decision.kind, "allow");
  const r = await WriteTool.call({ file_path: file, content: "hello" }, c);
  assert.equal(r.output.created, true);
  assert.equal(await fs.readFile(file, "utf8"), "hello");
  assert.ok(c.fileReadStamps.has(file));
});

test("Write: overwrite REQUIRES prior Read", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "existing.txt");
  await fs.writeFile(file, "original", "utf8");
  const c = ctx(tmp);
  const decision = await WriteTool.checkPermissions({ file_path: file, content: "new" }, c);
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /Read .* before overwriting/);
});

test("Write: overwrite OK after Read", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "existing.txt");
  await fs.writeFile(file, "original", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  const decision = await WriteTool.checkPermissions({ file_path: file, content: "new" }, c);
  assert.equal(decision.kind, "allow");
});

test("Write: creates relative files inside workspace and rejects escapes", async () => {
  const tmp = await makeTmp();
  const c = ctx(tmp);
  const r = await WriteTool.call({ file_path: "nested/new.txt", content: "hello" }, c);
  assert.equal(r.output.path, path.join(tmp, "nested", "new.txt"));
  assert.equal(await fs.readFile(path.join(tmp, "nested", "new.txt"), "utf8"), "hello");

  await assert.rejects(
    WriteTool.call({ file_path: "../outside.txt", content: "nope" }, c),
    /escapes workspace/,
  );
});

test("permissions: plan denies writes and ask does not execute headless", async () => {
  const tmp = await makeTmp();
  const planCtx = { ...ctx(tmp), permissionMode: "plan" };
  const planDecision = await WriteTool.checkPermissions({ file_path: "new.txt", content: "x" }, planCtx);
  assert.equal(planDecision.kind, "deny");

  const askCtx = { ...ctx(tmp), permissionMode: "ask" };
  const adapted = adaptToolForEngine(WriteTool, () => askCtx);
  await assert.rejects(
    adapted.call(
      { file_path: "new.txt", content: "x" },
      { workspace: tmp, signal: new AbortController().signal },
    ),
    /permission required/,
  );
  await assert.rejects(fs.stat(path.join(tmp, "new.txt")), /ENOENT/);
});

// ─── Edit ──────────────────────────────────────────────────────────────

test("Edit: requires prior Read", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "hello world", "utf8");
  const c = ctx(tmp);
  const decision = await EditTool.checkPermissions(
    { file_path: file, old_string: "hello", new_string: "hi", replace_all: false },
    c,
  );
  assert.equal(decision.kind, "deny");
});

test("Edit: rejects identical old/new strings", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "x", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  const decision = await EditTool.checkPermissions(
    { file_path: file, old_string: "x", new_string: "x", replace_all: false },
    c,
  );
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /identical/);
});

test("Edit: replaces unique match", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "before middle after", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call(
    { file_path: file, old_string: "middle", new_string: "MIDDLE", replace_all: false },
    c,
  );
  assert.equal(r.output.replacements, 1);
  assert.equal(await fs.readFile(file, "utf8"), "before MIDDLE after");
});

test("Edit: rejects non-unique match without replace_all", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "foo foo foo", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: "foo", new_string: "bar", replace_all: false },
      c,
    ),
    /not unique/,
  );
});

test("Edit: replace_all changes every occurrence", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "foo foo foo", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call(
    { file_path: file, old_string: "foo", new_string: "bar", replace_all: true },
    c,
  );
  assert.equal(r.output.replacements, 3);
  assert.equal(await fs.readFile(file, "utf8"), "bar bar bar");
});

// ─── Glob ──────────────────────────────────────────────────────────────

test("Glob: finds files by extension", async () => {
  const tmp = await makeTmp();
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src", "a.ts"), "", "utf8");
  await fs.writeFile(path.join(tmp, "src", "b.ts"), "", "utf8");
  await fs.writeFile(path.join(tmp, "src", "c.js"), "", "utf8");
  const c = ctx(tmp);
  const r = await GlobTool.call({ pattern: "**/*.ts", max_results: 500 }, c);
  assert.equal(r.output.matches.length, 2);
  assert.ok(r.output.matches.every((m) => m.path.endsWith(".ts")));
});

test("Glob: respects max_results", async () => {
  const tmp = await makeTmp();
  for (let i = 0; i < 10; i++) {
    await fs.writeFile(path.join(tmp, `f${i}.txt`), "", "utf8");
  }
  const c = ctx(tmp);
  const r = await GlobTool.call({ pattern: "*.txt", max_results: 3 }, c);
  assert.equal(r.output.matches.length, 3);
  assert.equal(r.output.truncated, true);
});

// ─── Grep ──────────────────────────────────────────────────────────────

test("Grep: files_with_matches", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(path.join(tmp, "a.txt"), "needle in haystack\n", "utf8");
  await fs.writeFile(path.join(tmp, "b.txt"), "no match here\n", "utf8");
  await fs.writeFile(path.join(tmp, "c.txt"), "another needle\n", "utf8");
  const c = ctx(tmp);
  const r = await GrepTool.call(
    { pattern: "needle", output_mode: "files_with_matches", case_insensitive: false, max_results: 50, context_before: 0, context_after: 0 },
    c,
  );
  assert.equal(r.output.files.length, 2);
  assert.equal(r.output.totalMatches, 2);
});

test("Grep: content mode returns matching lines", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(path.join(tmp, "log.txt"), "info: ok\nerror: bad\ninfo: yay\n", "utf8");
  const c = ctx(tmp);
  const r = await GrepTool.call(
    { pattern: "^error", output_mode: "content", case_insensitive: false, max_results: 50, context_before: 0, context_after: 0 },
    c,
  );
  assert.equal(r.output.matches.length, 1);
  assert.equal(r.output.matches[0].line, 2);
  assert.match(r.output.matches[0].text, /^error: bad$/);
});

test("Grep: ignores Ares session artifacts by default", async () => {
  const tmp = await makeTmp();
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.mkdir(path.join(tmp, ".ares", "sessions", "sess_test"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src", "real.txt"), "needle from source\n", "utf8");
  await fs.writeFile(path.join(tmp, ".ares", "sessions", "sess_test", "events.jsonl"), "needle from artifact\n", "utf8");
  const c = ctx(tmp);
  const r = await GrepTool.call(
    { pattern: "needle", output_mode: "files_with_matches", case_insensitive: false, max_results: 50, context_before: 0, context_after: 0 },
    c,
  );

  assert.equal(r.output.files.length, 1);
  assert.match(r.output.files[0], /src[\\/]+real\.txt$/);
});

// ─── Bash / PowerShell ─────────────────────────────────────────────────

test("Bash: runs echo and returns stdout", async () => {
  const tmp = await makeTmp();
  const c = ctx(tmp);
  const r = await BashTool.call(
    { command: "echo hello", description: "test echo", timeout: 30000 },
    c,
  );
  assert.equal(r.output.exitCode, 0, r.output.stderr || r.output.stdout);
  assert.match(r.output.stdout, /hello/);
});

test("PowerShell: rejects cwd outside workspace before spawning", async () => {
  const tmp = await makeTmp();
  const c = ctx(tmp);
  await assert.rejects(
    PowerShellTool.call(
      { command: "Write-Output no", description: "escape cwd", timeout: 30000, cwd: ".." },
      c,
    ),
    /escapes workspace/,
  );
});

test("PowerShell: runs Write-Output", async () => {
  if (process.platform !== "win32") return; // skip on non-Windows
  const tmp = await makeTmp();
  const c = ctx(tmp);
  const r = await PowerShellTool.call(
    { command: "Write-Output ok", description: "test write", timeout: 30000 },
    c,
  );
  assert.equal(r.output.exitCode, 0);
  assert.match(r.output.stdout, /ok/);
});

test("PowerShell: abort tears down a spawned process tree promptly", async () => {
  if (process.platform !== "win32") return;
  const tmp = await makeTmp();
  const controller = new AbortController();
  const c = { ...ctx(tmp), signal: controller.signal };
  const started = Date.now();
  const running = PowerShellTool.call(
    {
      command: "Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30' -NoNewWindow -Wait",
      description: "test process tree abort",
      timeout: 30000,
    },
    c,
  );
  setTimeout(() => controller.abort(), 150);
  await running;
  // Full-suite Windows CI can take several seconds to schedule taskkill while
  // hundreds of child-process tests run in parallel. The contract is that Stop
  // beats the command's 30s timeout by a wide margin, not a brittle 5s wall.
  assert.ok(Date.now() - started < 15000, "abort must not wait for the command timeout while a grandchild holds inherited pipes");
});

test("shell permissions: destructive commands require explicit approval", async () => {
  const tmp = await makeTmp();
  const c = ctx(tmp);
  const bashDecision = await BashTool.checkPermissions(
    { command: "rm -rf build", description: "remove build", timeout: 30000, run_in_background: false },
    c,
  );
  const powershellDecision = await PowerShellTool.checkPermissions(
    { command: "Remove-Item -Recurse -Force build", description: "remove build", timeout: 30000, run_in_background: false },
    c,
  );
  const safeDecision = await PowerShellTool.checkPermissions(
    { command: "Get-ChildItem", description: "list files", timeout: 30000, run_in_background: false },
    c,
  );

  assert.equal(bashDecision.kind, "ask");
  assert.equal(powershellDecision.kind, "ask");
  assert.equal(safeDecision.kind, "allow");
});

test("lenient tool input: an extra model-invented key is stripped, not a hard failure", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(path.join(tmp, "a.txt"), "hello\nworld\n", "utf8");
  const adapted = adaptToolForEngine(ReadTool, () => ctx(tmp));
  // A model adds `max_results` (not in Read's strict schema). Pre-fix this threw
  // a Zod unrecognized_keys error and the whole call failed.
  const r = await adapted.call({ file_path: path.join(tmp, "a.txt"), max_results: 5 }, ctx(tmp));
  assert.match(r.output.content, /hello/);
});

test("lenient tool input: a genuine validation error still throws a readable message", async () => {
  const tmp = await makeTmp();
  const adapted = adaptToolForEngine(ReadTool, () => ctx(tmp));
  await assert.rejects(
    () => adapted.call({ offset: 3 }, ctx(tmp)), // missing required file_path
    /Read: invalid arguments/,
  );
});
