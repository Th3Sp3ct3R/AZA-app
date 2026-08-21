import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runShell } from "../packages/tools/dist/Bash.js";

test("runShell preserves complete output on disk when the inline result is capped", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ares-shell-spill-"));
  const capture = path.join(dir, "complete.log");
  const marker = "FULL_OUTPUT_SENTINEL";
  const result = await runShell(
    process.execPath,
    ["-e", `process.stdout.write("x".repeat(100000) + "${marker}")`],
    dir,
    10_000,
    new AbortController().signal,
    undefined,
    capture,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.fullOutputPath, capture);
  assert.equal(existsSync(capture), true);
  assert.match(readFileSync(capture, "utf8"), new RegExp(`${marker}$`));
  assert.match(result.stdout, new RegExp(`${marker}$`));
  assert.ok(result.stdout.length < 100_000, "inline stdout remains bounded");
});

test("runShell removes the temporary capture when inline output is complete", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ares-shell-small-"));
  const capture = path.join(dir, "temporary.log");
  const result = await runShell(
    process.execPath,
    ["-e", 'process.stdout.write("small")'],
    dir,
    10_000,
    new AbortController().signal,
    undefined,
    capture,
  );

  assert.equal(result.truncated, false);
  assert.equal(result.fullOutputPath, undefined);
  assert.equal(existsSync(capture), false);
});

test("runShell preserves UTF-8 code points split across process chunks", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ares-shell-unicode-"));
  const capture = path.join(dir, "unicode.log");
  const progress = [];
  const result = await runShell(
    process.execPath,
    ["-e", "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82,0xac,0x0a])), 15)"],
    dir,
    10_000,
    new AbortController().signal,
    (_stream, text) => progress.push(text),
    capture,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(progress.join(""), "€\n");
  assert.equal(result.stdout, "€\n");
  assert.doesNotMatch(progress.join(""), /�/);
});
