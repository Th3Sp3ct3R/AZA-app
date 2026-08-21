// `git clean -x/-X` is refused outright — the one deletion git cannot undo.
//
// Incident (2026-08-10, D:\Olympus): cleaning up 16 test artifacts, the agent
// reached for `git clean -fdX`. -X deletes IGNORED files, and in that repo the
// ignore list was the docs firewall — deliberately untracked, local-only, and
// therefore irreplaceable. 197 files went: the .env, eight vault databases,
// the whole docs corpus, and the .docs-backup directory that existed to
// survive exactly this. It then ran the same command a SECOND time, after
// detecting and reporting the first loss.
//
// The heuristic already classed it destructive, but destructive only produces
// a PROMPT, and the session was in bypass/YOLO where every prompt is
// auto-allowed. So the refusal has to live at execution, not in permissions.

import test from "node:test";
import assert from "node:assert/strict";
import { irrecoverableShellRefusal } from "../packages/tools/dist/_shared.js";

test("refuses git clean that removes ignored files, in every spelling", () => {
  const refused = [
    "git clean -fdX",
    "git clean -fdXq",
    "git clean -xfd",
    "git clean -f -d -x",
    "git clean -fdx",
    "cd /repo && git clean -fdX",
    "git clean -fd && git clean -fdX",
    "git -C D:/Olympus clean -fdX",
  ];
  for (const cmd of refused) {
    const msg = irrecoverableShellRefusal(cmd);
    assert.ok(msg, `must refuse: ${cmd}`);
    assert.match(msg, /IGNORED files/);
    assert.match(msg, /-ndX/, "the refusal must hand back the dry-run that would have prevented it");
  }
});

test("a preview is always allowed — seeing the kill list is the remedy", () => {
  for (const cmd of ["git clean -ndX", "git clean -nX", "git clean --dry-run -X", "git clean -xdn"]) {
    assert.equal(irrecoverableShellRefusal(cmd), null, `preview must pass: ${cmd}`);
  }
});

test("ordinary cleans and unrelated commands are untouched", () => {
  const fine = [
    "git clean -fd",              // tracked-but-untracked files only; git can't lose ignored state
    "git clean -f",
    "git status",
    "git checkout -- .",
    "rm -rf node_modules",        // destructive, but that is the prompt path's job
    "npm run clean",
    "git clean-untracked-helper", // not the clean subcommand at all
  ];
  for (const cmd of fine) {
    assert.equal(irrecoverableShellRefusal(cmd), null, `must not refuse: ${cmd}`);
  }
});

test("the refusal explains the alternatives rather than just saying no", () => {
  const msg = irrecoverableShellRefusal("git clean -fdX");
  assert.match(msg, /BY NAME/, "deleting the known list by name");
  assert.match(msg, /scratch directory OUTSIDE the repo/, "and where probe files belong");
  assert.match(msg, /bypass\/YOLO/, "and why the mode did not save it");
});
