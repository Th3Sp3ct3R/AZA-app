// Tool-call hardening — semantic validateInput across the high-traffic tools,
// Edit's actionable not-found escalation, and ComputerUse per-action permission
// tiers (read-only observation vs. state-changing vs. keyboard injection).
//
// Style mirrors tests/m1-tools.test.mjs / computeruse-verify.test.mjs: real temp
// dirs for file tools, injected fake runners for ComputerUse, dist imports, no
// real network or screen.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EditTool,
  WriteTool,
  ReadTool,
  GrepTool,
  GlobTool,
  ApplyIntentTool,
  makeWebFetchTool,
  makeWebSearchTool,
  makeComputerUseTool,
  adaptToolForEngine,
  regexInputProblem,
  looksLineNumberPrefixed,
  nearMissHint,
  pathInputProblem,
} from "../packages/tools/dist/index.js";

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ares-hardening-"));
}

function ctx(workspace, permissionMode = "workspace-write") {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode,
    fileReadStamps: new Map(),
  };
}

// ─── shared path sanity ──────────────────────────────────────────────────────

test("pathInputProblem: glob chars, newlines, and .. escapes are named; concrete paths pass", () => {
  assert.match(pathInputProblem("src/**/*.ts"), /glob\/wildcard/);
  assert.match(pathInputProblem("a.ts\nb.ts"), /newline/);
  assert.match(pathInputProblem("   "), /empty/);
  assert.match(pathInputProblem("../../outside.txt", "D:/proj"), /climbs out of the workspace/);
  assert.equal(pathInputProblem("src/inner/../file.ts", "D:/proj"), null, ".. that stays inside is fine");
  assert.equal(pathInputProblem("C:/abs/file.ts", "D:/proj"), null, "absolute paths flow to the permission system");
  assert.equal(pathInputProblem("src/file.ts"), null);
});

// ─── Edit: semantic validateInput ────────────────────────────────────────────

test("Edit: old_string with Read's line-number prefixes is rejected with the fix", async () => {
  const v = await EditTool.validateInput({
    file_path: "f.ts",
    old_string: "   10\tconst a = 1;\n   11\tconst b = 2;",
    new_string: "x",
  });
  assert.equal(v.ok, false);
  assert.match(v.message, /line-number prefixes/);
  assert.match(v.message, /AFTER the tab/);
});

test("Edit: line-number detection needs consecutive numbers (TSV data is safe)", () => {
  assert.equal(looksLineNumberPrefixed("   10\ta\n   11\tb\n   12\tc"), true);
  assert.equal(looksLineNumberPrefixed("10\t500\n99\t700"), false, "non-consecutive = data, not prefixes");
  assert.equal(looksLineNumberPrefixed("   42\tfoo"), true, "single padded line");
  assert.equal(looksLineNumberPrefixed("0\tfoo"), false, "single unpadded line = plausible TSV");
  assert.equal(looksLineNumberPrefixed("const a = 1;"), false);
});

test("Edit: a pattern-looking file_path is rejected before matching", async () => {
  const v = await EditTool.validateInput({ file_path: "src/*.ts", old_string: "a", new_string: "b" });
  assert.equal(v.ok, false);
  assert.match(v.message, /glob\/wildcard/);
});

// ─── Edit: not-found escalation ──────────────────────────────────────────────

async function seedAndRead(c, file, content) {
  await fs.writeFile(file, content, "utf8");
  await ReadTool.call({ file_path: file }, c);
}

test("Edit: indentation-only miss is RESCUED by the normalized tier (re-indented to the file)", async () => {
  // This used to fail with a "DOES appear at line 2 / leading whitespace" hint
  // and burn a model round-trip. Layer 4 (canonical match) now applies it,
  // re-indenting the replacement to the FILE's real depth.
  const tmp = await makeTmp();
  const file = path.join(tmp, "indent.ts");
  const c = ctx(tmp);
  await seedAndRead(c, file, "function f() {\n  const total = 1;\n}\n");

  const result = await EditTool.call(
    { file_path: file, old_string: "      const total = 1;", new_string: "      const total = 2;", replace_all: false },
    c,
  );
  assert.equal(result.output.matchedBy, "normalized");
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /^ {2}const total = 2;$/m, "replacement landed at the file's 2-space depth, not the model's 6");
});

test("Edit not-found: closest near-miss excerpt + ApplyIntent escalation", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "near.ts");
  const c = ctx(tmp);
  await seedAndRead(c, file, "const one = 1;\nconst total = computeTotal(items, taxRate);\nconst two = 2;\n");

  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: "const total = computeTotal(items);", new_string: "x", replace_all: false },
      c,
    ),
    (err) => {
      assert.match(err.message, /not found/i);
      assert.match(err.message, /Closest near-miss.*line 2/s);
      assert.match(err.message, /computeTotal\(items, taxRate\)/); // shows the real text
      assert.match(err.message, /use ApplyIntent with a concise instruction \+ sketch/);
      return true;
    },
  );
});

test("Edit not-found: no plausible near-miss stays clean but still escalates", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "clean.ts");
  const c = ctx(tmp);
  await seedAndRead(c, file, "const alpha = 1;\n");

  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: "zzz qqq www", new_string: "x", replace_all: false },
      c,
    ),
    (err) => {
      assert.match(err.message, /not found/i);
      assert.doesNotMatch(err.message, /Closest near-miss/);
      assert.match(err.message, /ApplyIntent/);
      return true;
    },
  );
});

test("nearMissHint: pure helper finds indent-only and token-overlap candidates", () => {
  assert.match(nearMissHint("  const a = 1;\n", "    const a = 1;"), /leading whitespace/);
  assert.match(nearMissHint("const total = computeTotal(items, tax);\n", "const total = computeTotal(items);"), /line 1/);
  assert.equal(nearMissHint("const a = 1;\n", "zzz qqq"), "");
});

// ─── Write ───────────────────────────────────────────────────────────────────

test("Write: empty content is rejected unless allow_full_replace", async () => {
  const v = await WriteTool.validateInput({ file_path: "a.txt", content: "" }, ctx("D:/proj"));
  assert.equal(v.ok, false);
  assert.match(v.message, /content is empty/);
  assert.match(v.message, /allow_full_replace/);

  const ok = await WriteTool.validateInput({ file_path: "a.txt", content: "", allow_full_replace: true }, ctx("D:/proj"));
  assert.equal(ok.ok, true);
});

test("Write: relative path escaping the workspace is rejected with the absolute-path fix", async () => {
  const v = await WriteTool.validateInput({ file_path: "../../outside.txt", content: "hi" }, ctx("D:/proj/sub"));
  assert.equal(v.ok, false);
  assert.match(v.message, /climbs out of the workspace/);
  assert.match(v.message, /absolute path/);
});

// ─── Read ────────────────────────────────────────────────────────────────────

test("Read: offset past a known, unchanged file's end is rejected with the line count", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "r.txt");
  const c = ctx(tmp);
  await fs.writeFile(file, "l1\nl2\nl3\n", "utf8");
  await ReadTool.call({ file_path: file }, c);

  const v = await ReadTool.validateInput({ file_path: file, offset: 9999 }, c);
  assert.equal(v.ok, false);
  assert.match(v.message, /past the end/);
  assert.match(v.message, /4 lines/);

  const ok = await ReadTool.validateInput({ file_path: file, offset: 2 }, c);
  assert.equal(ok.ok, true);
});

test("Read: offset check does not fire without a read stamp (unknown file size)", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "unknown.txt");
  await fs.writeFile(file, "x\n", "utf8");
  const v = await ReadTool.validateInput({ file_path: file, offset: 9999 }, ctx(tmp));
  assert.equal(v.ok, true);
});

// ─── Grep ────────────────────────────────────────────────────────────────────

test("Grep: regexInputProblem names the bad construct", () => {
  assert.match(regexInputProblem("a("), /invalid regular expression/i);
  assert.match(regexInputProblem("interface{}"), /unescaped '\{'/);
  assert.match(regexInputProblem("interface{}"), /interface\\\{\\\}/); // shows the fix
  assert.match(regexInputProblem("foo(?=bar)"), /lookaround/);
  assert.match(regexInputProblem("foo(?<!bar)"), /lookaround/);
  assert.match(regexInputProblem("(a)\\1"), /backreference/);
});

test("Grep: valid patterns (quantifiers, classes, escaped braces) pass", () => {
  assert.equal(regexInputProblem("\\d{2,3}"), null);
  assert.equal(regexInputProblem("x{5}"), null);
  assert.equal(regexInputProblem("[{}]"), null, "braces in a character class are literal");
  assert.equal(regexInputProblem("interface\\{\\}"), null);
  assert.equal(regexInputProblem("(?:foo|bar)\\.ts"), null);
  assert.equal(regexInputProblem("(?<name>x)"), null, "named groups are supported by ripgrep");
});

test("Grep: through the engine gate the bad pattern is a correctable <tool_use_error>", async () => {
  const adapted = adaptToolForEngine(GrepTool, (b) => b);
  await assert.rejects(
    () => adapted.call({ pattern: "interface{}" }, ctx(process.cwd())),
    (err) => {
      assert.match(err.message, /<tool_use_error>/);
      assert.match(err.message, /Escape literal braces/);
      return true;
    },
  );
});

// ─── Glob ────────────────────────────────────────────────────────────────────

test("Glob: backslash and absolute patterns are rejected with the fix", async () => {
  const bs = await GlobTool.validateInput({ pattern: "src\\**\\*.ts", max_results: 500 });
  assert.equal(bs.ok, false);
  assert.match(bs.message, /forward slashes/);

  const abs = await GlobTool.validateInput({ pattern: "C:/proj/src/**/*.ts", max_results: 500 });
  assert.equal(abs.ok, false);
  assert.match(abs.message, /`cwd`/);

  const ok = await GlobTool.validateInput({ pattern: "src/**/*.{ts,tsx}", max_results: 500 });
  assert.equal(ok.ok, true);
});

// ─── WebFetch / WebSearch ────────────────────────────────────────────────────

test("WebFetch: non-http(s) schemes are rejected, http(s) passes", async () => {
  const tool = makeWebFetchTool();
  const file = await tool.validateInput({ url: "file:///etc/passwd", max_chars: 20000, offset: 0 });
  assert.equal(file.ok, false);
  assert.match(file.message, /only fetches http/);
  assert.match(file.message, /use Read/);

  const ftp = await tool.validateInput({ url: "ftp://host/x", max_chars: 20000, offset: 0 });
  assert.equal(ftp.ok, false);

  const ok = await tool.validateInput({ url: "https://example.com/docs", max_chars: 20000, offset: 0 });
  assert.equal(ok.ok, true);
});

test("WebSearch: blank and page-length queries are rejected", async () => {
  const tool = makeWebSearchTool({ name: "Fake", search: async () => [] });
  const blank = await tool.validateInput({ query: "  ", max_results: 10 });
  assert.equal(blank.ok, false);
  assert.match(blank.message, /blank/);

  const long = await tool.validateInput({ query: "x".repeat(401), max_results: 10 });
  assert.equal(long.ok, false);
  assert.match(long.message, /401 chars/);

  const ok = await tool.validateInput({ query: "node test runner", max_results: 10 });
  assert.equal(ok.ok, true);
});

// ─── ApplyIntent ─────────────────────────────────────────────────────────────

test("ApplyIntent: whitespace-only instructions or sketch are rejected", async () => {
  const c = ctx("D:/proj");
  const noSketch = await ApplyIntentTool.validateInput({ file_path: "a.ts", instructions: "do it", sketch: "  \n " }, c);
  assert.equal(noSketch.ok, false);
  assert.match(noSketch.message, /sketch is blank/);
  assert.match(noSketch.message, /existing code/);

  const noInstr = await ApplyIntentTool.validateInput({ file_path: "a.ts", instructions: "   ", sketch: "content" }, c);
  assert.equal(noInstr.ok, false);
  assert.match(noInstr.message, /instructions is blank/);

  const ok = await ApplyIntentTool.validateInput({ file_path: "a.ts", instructions: "rename x to y", sketch: "const y = 1;" }, c);
  assert.equal(ok.ok, true);
});

// ─── ComputerUse: per-action permission tiers ────────────────────────────────

const fakeShot = {
  ok: true,
  action: "screenshot",
  image: Buffer.from("img").toString("base64"),
  width: 100,
  height: 80,
  captureW: 100,
  captureH: 80,
  scale: 1,
  originX: 0,
  originY: 0,
};

function fakeRunner(script) {
  const calls = [];
  const runner = async (input, lastShot) => {
    calls.push({ input, lastShot });
    const step = script.shift();
    if (!step) throw new Error(`fake runner exhausted at ${input.action}`);
    return step;
  };
  runner.calls = calls;
  return runner;
}

test("ComputerUse tiers: observation actions are read-only (no permission ask)", async () => {
  const tool = makeComputerUseTool(fakeRunner([]));
  for (const action of ["screenshot", "zoom", "window", "windows", "cursor"]) {
    const d = await tool.checkPermissions({ action, x: 1, y: 1 }, ctx(process.cwd(), "workspace-write"));
    assert.equal(d.kind, "allow", `${action} must not prompt`);
  }
});

test("ComputerUse tiers: state-changing actions still ask in guarded modes", async () => {
  const tool = makeComputerUseTool(fakeRunner([]));
  for (const action of ["click", "scroll", "type", "key", "launch", "activate", "move"]) {
    const d = await tool.checkPermissions({ action }, ctx(process.cwd(), "workspace-write"));
    assert.equal(d.kind, "ask", `${action} must ask`);
    assert.match(d.prompt, /external-state/);
  }
});

test("ComputerUse tiers: plan mode allows observation, denies state changes; bypass allows all", async () => {
  const tool = makeComputerUseTool(fakeRunner([]));
  assert.equal((await tool.checkPermissions({ action: "screenshot" }, ctx(process.cwd(), "plan"))).kind, "allow");
  assert.equal((await tool.checkPermissions({ action: "click" }, ctx(process.cwd(), "plan"))).kind, "deny");
  assert.equal((await tool.checkPermissions({ action: "click" }, ctx(process.cwd(), "bypass"))).kind, "allow");
});

test("ComputerUse tiers: static schema safety stays external-state (watchdog/conductor unchanged)", () => {
  const tool = makeComputerUseTool(fakeRunner([]));
  assert.equal(tool.schema.safety, "external-state");
});

// ─── ComputerUse: semantic validateInput + typing gate ───────────────────────

test("ComputerUse: per-action required params are checked with a one-sentence fix", async () => {
  const tool = makeComputerUseTool(fakeRunner([]));
  const noText = await tool.validateInput({ action: "type" });
  assert.equal(noText.ok, false);
  assert.match(noText.message, /type needs `text`/);

  const noKey = await tool.validateInput({ action: "key" });
  assert.equal(noKey.ok, false);
  assert.match(noKey.message, /SendKeys/);

  const noCoords = await tool.validateInput({ action: "move" });
  assert.equal(noCoords.ok, false);
  assert.match(noCoords.message, /both x and y/);

  const halfCoords = await tool.validateInput({ action: "click", x: 10 });
  assert.equal(halfCoords.ok, false);
  assert.match(halfCoords.message, /only one of x\/y/);

  const clickNoCoords = await tool.validateInput({ action: "click" });
  assert.equal(clickNoCoords.ok, true, "coordinate-less click acts at the cursor");

  const noTarget = await tool.validateInput({ action: "activate" });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.message, /window's title/);
});

test("ComputerUse: ARES_COMPUTERUSE_ALLOW_TYPING=0 blocks type/key with an explanation", async () => {
  const tool = makeComputerUseTool(fakeRunner([]));
  process.env.ARES_COMPUTERUSE_ALLOW_TYPING = "0";
  try {
    const t = await tool.validateInput({ action: "type", text: "hi" });
    assert.equal(t.ok, false);
    assert.match(t.message, /ARES_COMPUTERUSE_ALLOW_TYPING=0/);
    const k = await tool.validateInput({ action: "key", key: "{ENTER}" });
    assert.equal(k.ok, false);
    const click = await tool.validateInput({ action: "click", x: 1, y: 2 });
    assert.equal(click.ok, true, "the gate only covers keyboard injection");
  } finally {
    delete process.env.ARES_COMPUTERUSE_ALLOW_TYPING;
  }
  const on = await tool.validateInput({ action: "type", text: "hi" });
  assert.equal(on.ok, true, "default is allowed");
});

test("ComputerUse: browser-window activation is owner-gated via ARES_COMPUTERUSE_ALLOW_BROWSER", async () => {
  const tool = makeComputerUseTool(fakeRunner([]));
  delete process.env.ARES_COMPUTERUSE_ALLOW_BROWSER;
  const blocked = await tool.validateInput({ action: "activate", text: "Home / X - Google Chrome" });
  assert.equal(blocked.ok, false, "default-closed: web content must not reach the physical mouse");
  assert.match(blocked.message, /Desktop control of browser windows/);
  process.env.ARES_COMPUTERUSE_ALLOW_BROWSER = "1";
  try {
    const allowed = await tool.validateInput({ action: "activate", text: "Home / X - Google Chrome" });
    assert.equal(allowed.ok, true, "the owner toggle lifts the gate");
  } finally {
    delete process.env.ARES_COMPUTERUSE_ALLOW_BROWSER;
  }
});

// ─── ComputerUse: keyboard audit line ────────────────────────────────────────

test("ComputerUse: type carries a 'typed N chars into <window>' audit line", async () => {
  process.env.ARES_COMPUTERUSE_VERIFY = "0";
  try {
    const tool = makeComputerUseTool(fakeRunner([{ ok: true, action: "type", focus: "Notepad — untitled" }]));
    const r = await tool.call({ action: "type", text: "hello" }, ctx(process.cwd(), "bypass"));
    assert.equal(r.output.audit, 'typed 5 chars into "Notepad — untitled"');
    assert.match(r.display, /^Typed 5 chars into "Notepad — untitled"/);
  } finally {
    delete process.env.ARES_COMPUTERUSE_VERIFY;
  }
});

test("ComputerUse: key audit falls back to 'the focused window' when no title is known", async () => {
  process.env.ARES_COMPUTERUSE_VERIFY = "0";
  try {
    const tool = makeComputerUseTool(fakeRunner([{ ok: true, action: "key" }]));
    const r = await tool.call({ action: "key", key: "{ENTER}" }, ctx(process.cwd(), "bypass"));
    assert.equal(r.output.audit, "pressed {ENTER} in the focused window");
  } finally {
    delete process.env.ARES_COMPUTERUSE_VERIFY;
  }
});

test("ComputerUse: the audit line survives the post-action verification note", async () => {
  process.env.ARES_COMPUTERUSE_SETTLE_MS = "0";
  try {
    const tool = makeComputerUseTool(
      fakeRunner([{ ok: true, action: "type", focus: "Form" }, { ...fakeShot }]),
    );
    const r = await tool.call({ action: "type", text: "abc" }, ctx(process.cwd(), "bypass"));
    assert.equal(r.output.audit, 'typed 3 chars into "Form"');
    assert.equal(r.output.verified, true);
    assert.match(r.display, /Typed 3 chars into "Form"/);
  } finally {
    delete process.env.ARES_COMPUTERUSE_SETTLE_MS;
  }
});
