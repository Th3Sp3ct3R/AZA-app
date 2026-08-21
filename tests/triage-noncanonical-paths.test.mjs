// Self-triage must read its sources through a NON-CANONICAL path.
//
// The old guard demanded realpath(file) === file, which conflated "this path
// escaped the tree" with "this path simply wasn't canonical". On Windows it very
// often isn't: a GitHub runner's os.tmpdir() is C:\Users\RUNNER~1\… (an 8.3
// short name) whose realpath is C:\Users\runneradmin\…, so every input file was
// silently discarded — self-triage produced a clean empty run with no findings
// and no warning, and 11 triage tests failed on CI Windows for three releases.
// The same applied to any owner whose workspace sat behind a junction, a mapped
// drive, or a short-name profile directory.
//
// Here the workspace is reached through a symlink/junction, so the given path
// and its realpath genuinely differ — the exact shape that used to read nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReliabilityTriage } from "../packages/core/dist/index.js";

const NOW = new Date("2026-07-11T18:00:00.000Z");

function watchdogTurn(sessionId, turnId, millis) {
  return [
    { type: "turn_start", turnId, sessionId, userMessage: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { type: "tool_start", id: "tool-1", name: "Glob", input: { pattern: "**/*" }, activityDescription: "search" },
    { type: "tool_error", id: "tool-1", error: "Tool Glob exceeded its " + millis + "ms watchdog and was aborted — result unavailable.", durationMs: millis },
    { type: "turn_end", status: "completed", workStatus: "blocked", usage: {}, durationMs: millis, provider: "anthropic", model: "test" },
  ];
}

async function writeSession(workspace, id, events) {
  const dir = path.join(workspace, ".ares", "sessions", id);
  await mkdir(dir, { recursive: true });
  const rows = events.map((event, seq) => JSON.stringify({
    ts: new Date(NOW.getTime() - 60_000 + seq * 1_000).toISOString(),
    seq,
    event,
  }));
  await writeFile(path.join(dir, "events.jsonl"), rows.join("\n") + "\n", "utf8");
}

test("triage reads sources reached through a non-canonical (linked) path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ares-triage-noncanon-"));
  const home = path.join(root, "home");
  const realWorkspace = path.join(root, "real-workspace");
  await mkdir(home, { recursive: true });
  await mkdir(realWorkspace, { recursive: true });

  await writeSession(realWorkspace, "sess_one", watchdogTurn("sess_one", "turn_one", 30_000));
  await writeSession(realWorkspace, "sess_two", watchdogTurn("sess_two", "turn_two", 31_000));

  // Reach the same workspace through a link, so given path !== realpath.
  // "junction" is the Windows flavour that needs no elevation; on POSIX the
  // type argument is ignored.
  const linkedWorkspace = path.join(root, "linked-workspace");
  try {
    await symlink(realWorkspace, linkedWorkspace, "junction");
  } catch (err) {
    t.skip("cannot create a directory link in this environment: " + String(err));
    return;
  }
  // Sanity: the link really is non-canonical, otherwise this proves nothing.
  const canonical = await realpath(linkedWorkspace);
  if (path.resolve(canonical) === path.resolve(linkedWorkspace)) {
    t.skip("link resolved to itself; no non-canonical path to exercise");
    return;
  }

  const run = await runReliabilityTriage({
    home,
    workspace: linkedWorkspace,
    now: NOW,
    force: true,
    allowInTests: true,
  });

  assert.ok(run.coverage.files >= 2, `both rollouts are discovered through the link (saw ${run.coverage.files})`);
  assert.ok(run.coverage.observations > 0, "and their events are actually read");
  assert.equal(run.newCandidates.length, 1, "the recurring watchdog failure still clusters into one candidate");
});

test("triage still refuses a rollout file that is itself a symlink", async (t) => {
  // The containment fix must not weaken the real guard: a rollout PATH that is
  // a link to somewhere else is still never read.
  const root = await mkdtemp(path.join(os.tmpdir(), "ares-triage-linkfile-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home, { recursive: true });
  const sessionDir = path.join(workspace, ".ares", "sessions", "sess_link");
  await mkdir(sessionDir, { recursive: true });

  const outside = path.join(root, "outside.jsonl");
  await writeFile(outside, JSON.stringify({ ts: NOW.toISOString(), seq: 0, event: { type: "turn_end", status: "failed" } }) + "\n", "utf8");
  try {
    await symlink(outside, path.join(sessionDir, "events.jsonl"), "file");
  } catch (err) {
    t.skip("cannot create a file link in this environment: " + String(err));
    return;
  }

  const run = await runReliabilityTriage({
    home,
    workspace,
    now: NOW,
    force: true,
    allowInTests: true,
  });
  assert.equal(run.coverage.files, 0, "a symlinked rollout path is still skipped");
});
