import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { makeCopyWorktree } from "../packages/tools/dist/Conductor.js";
import { runFleet } from "../packages/core/dist/index.js";

function isolatedBuildSpec() {
  return {
    phases: [{
      id: "build",
      kind: "parallel",
      build: true,
      isolation: "worktree",
      agents: [{ role: "writer", prompt: "write owned.txt" }],
    }],
  };
}

function isolatedBuildDeps(main, runAgent, makeWorktree) {
  return {
    provider: { name: "unused", async *stream() {} },
    model: "fixed",
    parentTools: [],
    baseSystemPrompt: "test",
    workspace: main,
    signal: new AbortController().signal,
    validate: (_schema, parsed) => ({ ok: true, value: parsed }),
    schemaHint: (schema) => JSON.stringify(schema),
    runAgent,
    makeWorktree,
  };
}

test("Conductor copy branch carries dirty state and merges add/update/delete transactionally", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-main-"));
  await writeFile(path.join(main, "update.txt"), "owner dirty state\n");
  await writeFile(path.join(main, "delete.txt"), "remove me\n");
  await mkdir(path.join(main, ".git"));
  await writeFile(path.join(main, ".git", "config"), "not copied");
  await mkdir(path.join(main, ".ares"));
  await writeFile(path.join(main, ".ares", "runtime"), "not copied");

  const branch = await makeCopyWorktree(main, "build-one");
  try {
    assert.equal(
      path.resolve(branch.dir).startsWith(path.join(path.resolve(main), ".ares", "conductor-branches")),
      false,
      "direct callers without a durable key retain disposable mkdtemp branches",
    );
    assert.equal(await readFile(path.join(branch.dir, "update.txt"), "utf8"), "owner dirty state\n");
    await assert.rejects(readFile(path.join(branch.dir, ".git", "config"), "utf8"));
    await assert.rejects(readFile(path.join(branch.dir, ".ares", "runtime"), "utf8"));

    await writeFile(path.join(branch.dir, "update.txt"), "child update\n");
    await writeFile(path.join(branch.dir, "add.txt"), "child add\n");
    await rm(path.join(branch.dir, "delete.txt"));
    assert.deepEqual(await branch.changedFiles(), ["add.txt", "delete.txt", "update.txt"]);

    const merged = await branch.applyTo(main);
    assert.deepEqual(merged.failed, []);
    assert.equal(await readFile(path.join(main, "update.txt"), "utf8"), "child update\n");
    assert.equal(await readFile(path.join(main, "add.txt"), "utf8"), "child add\n");
    await assert.rejects(readFile(path.join(main, "delete.txt"), "utf8"));
  } finally {
    await branch.cleanup();
  }
});

test("Conductor materializes dependency trees so branch junction writes cannot mutate owner bytes", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-deps-"));
  const ownerPackage = path.join(main, "node_modules", "fixture-package");
  await mkdir(ownerPackage, { recursive: true });
  await writeFile(path.join(ownerPackage, "value.txt"), "owner dependency\n");
  await writeFile(path.join(main, "source.txt"), "owner source\n");
  const ownerAlias = path.join(main, "node_modules", "fixture-alias");
  await symlink(
    ownerPackage,
    ownerAlias,
    process.platform === "win32" ? "junction" : "dir",
  );

  const branch = await makeCopyWorktree(main, "dependency-isolation");
  try {
    const branchDependencyRoot = path.join(branch.dir, "node_modules");
    assert.equal(
      (await lstat(branchDependencyRoot)).isSymbolicLink(),
      false,
      "the dependency root is independent materialized storage, never an owner junction",
    );
    const branchAlias = path.join(branchDependencyRoot, "fixture-alias", "value.txt");
    assert.equal(await readFile(branchAlias, "utf8"), "owner dependency\n");

    // This follows a package-manager-style link inside the branch. The link was
    // rewritten to the branch projection, so even an ordinary write cannot
    // reach the owner's dependency bytes.
    await writeFile(branchAlias, "branch-only dependency\n");
    assert.equal(
      await readFile(path.join(ownerPackage, "value.txt"), "utf8"),
      "owner dependency\n",
      "owner dependencies remain byte-identical before integration",
    );
    assert.deepEqual(
      await branch.changedFiles(),
      ["node_modules/<dependency-projection-modified>"],
    );

    await writeFile(path.join(branch.dir, "source.txt"), "child source\n");
    const blocked = await branch.applyTo(main);
    assert.equal(blocked.applied.length, 0);
    assert.equal(blocked.failed.length, 1);
    assert.match(blocked.failed[0].err, /dependency projection.*never merged/i);
    assert.equal(
      await readFile(path.join(main, "source.txt"), "utf8"),
      "owner source\n",
      "dependency drift blocks the complete branch before any project operation lands",
    );

    // Reverting the derived dependency change restores integration authority;
    // project/lockfile edits remain free to merge through the normal CAS path.
    await writeFile(branchAlias, "owner dependency\n");
    assert.deepEqual(await branch.changedFiles(), ["source.txt"]);
    const newDependencyRoot = path.join(branch.dir, "generated", "node_modules");
    await mkdir(newDependencyRoot, { recursive: true });
    await writeFile(path.join(newDependencyRoot, "cache.txt"), "branch cache\n");
    assert.deepEqual(
      await branch.changedFiles(),
      ["generated/node_modules/<dependency-projection-modified>", "source.txt"],
      "new dependency roots are not invisible to settlement",
    );
    await rm(path.join(branch.dir, "generated"), { recursive: true, force: true });
    const merged = await branch.applyTo(main);
    assert.deepEqual(merged.failed, []);
    assert.equal(await readFile(path.join(main, "source.txt"), "utf8"), "child source\n");
    assert.equal(await readFile(path.join(ownerPackage, "value.txt"), "utf8"), "owner dependency\n");
  } finally {
    await branch.cleanup();
    await rm(main, { recursive: true, force: true });
  }
});

test("Conductor fails closed when a dependency link escapes the owner workspace", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-external-dep-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-external-target-"));
  try {
    await mkdir(path.join(main, "node_modules"), { recursive: true });
    await writeFile(path.join(external, "value.txt"), "external owner bytes\n");
    await symlink(
      external,
      path.join(main, "node_modules", "external-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      makeCopyWorktree(main, "external-dependency-link"),
      /resolves outside.*owner workspace|cannot safely isolate/i,
    );
    assert.equal(
      await readFile(path.join(external, "value.txt"), "utf8"),
      "external owner bytes\n",
    );
  } finally {
    await rm(main, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("Conductor rewrites internal workspace junctions and rejects link retargeting before merge", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-project-link-"));
  const firstTarget = path.join(main, "linked-one");
  const secondTarget = path.join(main, "linked-two");
  await mkdir(firstTarget);
  await mkdir(secondTarget);
  await writeFile(path.join(firstTarget, "value.txt"), "owner one\n");
  await writeFile(path.join(secondTarget, "value.txt"), "owner two\n");
  await symlink(
    firstTarget,
    path.join(main, "project-link"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const branch = await makeCopyWorktree(main, "project-link-isolation");
  try {
    const branchLink = path.join(branch.dir, "project-link");
    await writeFile(path.join(branchLink, "value.txt"), "branch one\n");
    assert.equal(
      await readFile(path.join(firstTarget, "value.txt"), "utf8"),
      "owner one\n",
      "the copied junction resolves into the branch, not back into owner state",
    );

    await rm(branchLink, { recursive: true, force: true });
    await symlink(
      path.join(branch.dir, "linked-two"),
      branchLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    const blocked = await branch.applyTo(main);
    assert.equal(blocked.applied.length, 0);
    assert.match(blocked.failed[0].err, /changed symbolic link.*intentionally rejected/i);
    assert.equal(await readFile(path.join(firstTarget, "value.txt"), "utf8"), "owner one\n");
    assert.equal(await readFile(path.join(secondTarget, "value.txt"), "utf8"), "owner two\n");
  } finally {
    await branch.cleanup();
    await rm(main, { recursive: true, force: true });
  }
});

test("Conductor phase atomically blocks project integration when a leaf mutates dependencies", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-dep-phase-"));
  await mkdir(path.join(main, "node_modules", "fixture"), { recursive: true });
  await writeFile(path.join(main, "node_modules", "fixture", "value.txt"), "owner dependency\n");
  await writeFile(path.join(main, "owned.txt"), "owner source\n");
  let retainedBranch = "";
  try {
    const result = await runFleet(
      isolatedBuildSpec(),
      isolatedBuildDeps(
        main,
        async (args) => {
          retainedBranch = args.workspace;
          await writeFile(path.join(args.workspace, "node_modules", "fixture", "value.txt"), "child dependency\n");
          await writeFile(path.join(args.workspace, "owned.txt"), "child source\n");
          assert.equal(
            await readFile(path.join(main, "node_modules", "fixture", "value.txt"), "utf8"),
            "owner dependency\n",
            "the owner is isolated while the leaf is still running",
          );
          return {
            finalText: "implemented",
            events: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            status: "completed",
            workStatus: "verified",
          };
        },
        (label, durableKey) => makeCopyWorktree(main, label, durableKey),
      ),
    );

    assert.equal(result.status, "failed");
    assert.match(result.phases[0]?.failureReason ?? "", /dependency projection|settlement failed/i);
    assert.equal(await readFile(path.join(main, "owned.txt"), "utf8"), "owner source\n");
    assert.equal(
      await readFile(path.join(main, "node_modules", "fixture", "value.txt"), "utf8"),
      "owner dependency\n",
    );
    assert.equal(
      await readFile(path.join(retainedBranch, "owned.txt"), "utf8"),
      "child source\n",
      "the failed durable branch remains available for explicit reconciliation",
    );
  } finally {
    await rm(main, { recursive: true, force: true });
  }
});

test("Conductor copy branch detects parent drift instead of overwriting it", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-drift-"));
  const target = path.join(main, "shared.txt");
  await writeFile(target, "base\n");
  const branch = await makeCopyWorktree(main, "drift");
  try {
    await writeFile(path.join(branch.dir, "shared.txt"), "child\n");
    await writeFile(target, "owner newer\n");
    const merged = await branch.applyTo(main);
    assert.equal(merged.applied.length, 0);
    assert.equal(merged.failed.length, 1);
    assert.match(merged.failed[0].err, /stale|hash|expected/i);
    assert.equal(await readFile(target, "utf8"), "owner newer\n");
  } finally {
    await branch.cleanup();
  }
});

test("Conductor reopens a durable branch after restart and merge replay is idempotent", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-restart-"));
  await writeFile(path.join(main, "owned.txt"), "base\n");
  await mkdir(path.join(main, ".ares", "conductor-branches"), { recursive: true });
  await writeFile(path.join(main, ".ares", "runtime-state"), "owner runtime must never be copied\n");
  await writeFile(path.join(main, ".ares", "conductor-branches", "sentinel"), "branch store sentinel\n");
  const durableKey = `fleet_restart_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const first = await makeCopyWorktree(main, "build-0", durableKey);
  await writeFile(path.join(first.dir, "owned.txt"), "child\n");

  // Do not clean up `first`: this is the process-crash boundary after the leaf
  // changed its isolated branch but before Conductor merged/persisted the phase.
  const reopened = await makeCopyWorktree(main, "build-0", durableKey);
  const branchRoot = path.dirname(reopened.dir);
  try {
    assert.equal(
      branchRoot.startsWith(path.join(path.resolve(main), ".ares", "conductor-branches") + path.sep),
      true,
      "durable branches live below the owner workspace, not OS temp storage",
    );
    assert.equal(reopened.dir, first.dir, "the fleet node resolves to one persistent branch path");
    await assert.rejects(readFile(path.join(reopened.dir, ".ares", "runtime-state"), "utf8"));
    await assert.rejects(readFile(path.join(reopened.dir, ".ares", "conductor-branches", "sentinel"), "utf8"));
    assert.deepEqual(await reopened.changedFiles(), ["owned.txt"]);
    const merged = await reopened.applyTo(main);
    assert.deepEqual(merged.failed, []);
    assert.equal(await readFile(path.join(main, "owned.txt"), "utf8"), "child\n");

    // A crash after commit but before the phase checkpoint may replay applyTo.
    // Matching after-bytes are recognized as the prior commit, not a conflict.
    const replayedMerge = await reopened.applyTo(main);
    assert.deepEqual(replayedMerge.failed, []);
    assert.deepEqual(replayedMerge.applied, ["owned.txt"]);
  } finally {
    await reopened.cleanup();
    await assert.rejects(readFile(path.join(branchRoot, "base.json"), "utf8"));
    assert.equal(
      await readFile(path.join(main, ".ares", "conductor-branches", "sentinel"), "utf8"),
      "branch store sentinel\n",
      "branch cleanup removes only its deterministic digest directory",
    );
    await rm(main, { recursive: true, force: true });
  }
});

test("failed fleet merge retains the durable branch and base manifest for recovery", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-retain-failed-"));
  await writeFile(path.join(main, "owned.txt"), "base\n");
  let durableKey = "";
  let label = "";
  let branchDir = "";

  try {
    const result = await runFleet(
      isolatedBuildSpec(),
      isolatedBuildDeps(
        main,
        async (args) => {
          await writeFile(path.join(args.workspace, "owned.txt"), "child\n");
          // Parent drift after the fork forces the CAS integration to fail.
          await writeFile(path.join(main, "owned.txt"), "owner newer\n");
          return {
            finalText: "implemented",
            events: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            status: "completed",
            workStatus: "verified",
          };
        },
        async (nextLabel, nextKey) => {
          assert.ok(nextKey, "fleet worktrees receive a deterministic durable key");
          label = nextLabel;
          durableKey = nextKey;
          const branch = await makeCopyWorktree(main, nextLabel, nextKey);
          branchDir = branch.dir;
          return branch;
        },
      ),
    );

    assert.equal(result.status, "failed");
    assert.equal(await readFile(path.join(main, "owned.txt"), "utf8"), "owner newer\n");
    const branchRoot = path.dirname(branchDir);
    assert.equal(await readFile(path.join(branchDir, "owned.txt"), "utf8"), "child\n");
    assert.ok(JSON.parse(await readFile(path.join(branchRoot, "base.json"), "utf8")));
    assert.ok(
      JSON.parse(await readFile(path.join(main, ".ares", "fleets", result.fleetId, "leaves.json"), "utf8")),
      "the failed phase boundary itself remains checkpointed",
    );

    const reopened = await makeCopyWorktree(main, label, durableKey);
    assert.equal(reopened.dir, branchDir);
    assert.deepEqual(await reopened.changedFiles(), ["owned.txt"]);
    await reopened.cleanup();
  } finally {
    await rm(main, { recursive: true, force: true });
  }
});

test("successful integration retains a durable branch when the phase checkpoint cannot commit", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-retain-uncheckpointed-"));
  await writeFile(path.join(main, "owned.txt"), "base\n");
  await mkdir(path.join(main, ".ares"), { recursive: true });
  // A file at the directory path makes every leaves.json checkpoint fail while
  // leaving the sibling durable branch store available.
  await writeFile(path.join(main, ".ares", "fleets"), "checkpoint path blocked\n");
  let durableKey = "";
  let label = "";
  let branchDir = "";

  try {
    const result = await runFleet(
      isolatedBuildSpec(),
      isolatedBuildDeps(
        main,
        async (args) => {
          await writeFile(path.join(args.workspace, "owned.txt"), "child\n");
          return {
            finalText: "implemented",
            events: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            status: "completed",
            workStatus: "verified",
          };
        },
        async (nextLabel, nextKey) => {
          assert.ok(nextKey);
          label = nextLabel;
          durableKey = nextKey;
          const branch = await makeCopyWorktree(main, nextLabel, nextKey);
          branchDir = branch.dir;
          return branch;
        },
      ),
    );

    assert.equal(result.status, "failed", "a fleet cannot claim durable completion without its phase checkpoint");
    assert.match(result.phases[0]?.failureReason ?? "", /checkpoint.*retained/i);
    assert.equal(result.manifestPath, "", "the deliberately blocked checkpoint path is visible");
    assert.equal(await readFile(path.join(main, "owned.txt"), "utf8"), "child\n");
    assert.ok(JSON.parse(await readFile(path.join(path.dirname(branchDir), "base.json"), "utf8")));
    const reopened = await makeCopyWorktree(main, label, durableKey);
    assert.equal(reopened.dir, branchDir);
    assert.deepEqual(await reopened.changedFiles(), ["owned.txt"]);
    assert.deepEqual(await reopened.applyTo(main), { applied: ["owned.txt"], failed: [] });
    await reopened.cleanup();
  } finally {
    await rm(main, { recursive: true, force: true });
  }
});

test("successful integration cleans a durable branch only after its phase checkpoint commits", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-clean-checkpointed-"));
  await writeFile(path.join(main, "owned.txt"), "base\n");
  let branchRoot = "";

  try {
    const result = await runFleet(
      isolatedBuildSpec(),
      isolatedBuildDeps(
        main,
        async (args) => {
          await writeFile(path.join(args.workspace, "owned.txt"), "child\n");
          return {
            finalText: "implemented",
            events: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            status: "completed",
            workStatus: "verified",
          };
        },
        async (nextLabel, nextKey) => {
          assert.ok(nextKey);
          const branch = await makeCopyWorktree(main, nextLabel, nextKey);
          branchRoot = path.dirname(branch.dir);
          return branch;
        },
      ),
    );

    assert.equal(result.status, "completed");
    assert.equal(await readFile(path.join(main, "owned.txt"), "utf8"), "child\n");
    const checkpoint = JSON.parse(
      await readFile(path.join(main, ".ares", "fleets", result.fleetId, "leaves.json"), "utf8"),
    );
    assert.equal(checkpoint[0]?.workStatus, "verified");
    await assert.rejects(readFile(path.join(branchRoot, "base.json"), "utf8"));
  } finally {
    await rm(main, { recursive: true, force: true });
  }
});

test("parallel Conductor phase validates every branch before committing any branch", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "ares-conductor-phase-atomic-"));
  await writeFile(path.join(main, "left.txt"), "left base\n");
  await writeFile(path.join(main, "right.txt"), "right base\n");

  try {
    const spec = {
      phases: [{
        id: "atomic-build",
        kind: "parallel",
        build: true,
        isolation: "worktree",
        agents: [
          { role: "left", prompt: "update left" },
          { role: "right", prompt: "update right" },
        ],
      }],
    };
    const result = await runFleet(
      spec,
      isolatedBuildDeps(
        main,
        async (args) => {
          if (args.role === "left") {
            await writeFile(path.join(args.workspace, "left.txt"), "left child\n");
          } else {
            await writeFile(path.join(args.workspace, "right.txt"), "right child\n");
            // This drift occurs after both branches forked. The phase contains
            // one valid mutation and one stale mutation; neither may land.
            await writeFile(path.join(main, "right.txt"), "right owner newer\n");
          }
          return {
            finalText: "implemented",
            events: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            status: "completed",
            workStatus: "verified",
          };
        },
        (label, durableKey) => makeCopyWorktree(main, label, durableKey),
      ),
    );

    assert.equal(result.status, "failed");
    assert.match(result.phases[0]?.failureReason ?? "", /settlement failed before a successful phase commit/i);
    assert.equal(await readFile(path.join(main, "left.txt"), "utf8"), "left base\n");
    assert.equal(await readFile(path.join(main, "right.txt"), "utf8"), "right owner newer\n");
  } finally {
    await rm(main, { recursive: true, force: true });
  }
});
