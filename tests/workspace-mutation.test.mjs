import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  WorkspaceMutationError,
  WorkspaceMutationService,
  workspaceContentHash,
} from "../packages/core/dist/workspaceMutation.js";

async function tempWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-mutation-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("workspace mutation commits add/update/delete/rename and can roll back exactly", async (t) => {
  const workspace = await tempWorkspace(t);
  await fs.writeFile(path.join(workspace, "update.txt"), "before update\n");
  await fs.writeFile(path.join(workspace, "delete.txt"), "before delete\n");
  await fs.writeFile(path.join(workspace, "rename.txt"), "before rename\n");

  const service = new WorkspaceMutationService(workspace);
  const receipt = await service.apply(
    [
      { kind: "add", path: "nested/added.txt", content: "added\n" },
      {
        kind: "update",
        path: "update.txt",
        expectedHash: workspaceContentHash("before update\n"),
        content: "after update\n",
      },
      {
        kind: "delete",
        path: "delete.txt",
        expectedHash: workspaceContentHash("before delete\n"),
      },
      {
        kind: "rename",
        fromPath: "rename.txt",
        toPath: "moved/renamed.txt",
        expectedHash: workspaceContentHash("before rename\n"),
        content: "after rename\n",
      },
    ],
    { transactionId: "complete-transaction", label: "test" },
  );

  assert.equal(await fs.readFile(path.join(workspace, "nested/added.txt"), "utf8"), "added\n");
  assert.equal(await fs.readFile(path.join(workspace, "update.txt"), "utf8"), "after update\n");
  await assert.rejects(fs.stat(path.join(workspace, "delete.txt")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(workspace, "rename.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(workspace, "moved/renamed.txt"), "utf8"), "after rename\n");
  assert.equal(receipt.operations.length, 4);
  assert.equal((await fs.stat(receipt.receiptPath)).isFile(), true);
  assert.match(await fs.readFile(receipt.journalPath, "utf8"), /"event":"commit_complete"/);

  const after = await service.reconcile(receipt.id);
  assert.equal(after.disposition, "fully_applied");
  assert.equal(after.canRollback, true);

  const rollback = await service.rollback(receipt.id);
  assert.equal(rollback.status, "committed");
  await assert.rejects(fs.stat(path.join(workspace, "nested/added.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(workspace, "update.txt"), "utf8"), "before update\n");
  assert.equal(await fs.readFile(path.join(workspace, "delete.txt"), "utf8"), "before delete\n");
  assert.equal(await fs.readFile(path.join(workspace, "rename.txt"), "utf8"), "before rename\n");
  await assert.rejects(fs.stat(path.join(workspace, "moved/renamed.txt")), { code: "ENOENT" });

  const restored = await service.reconcile(receipt.id);
  assert.equal(restored.transactionStatus, "rolled_back");
  assert.equal(restored.disposition, "not_applied");
});

test("workspace mutation validates the complete file-set before the first project write", async (t) => {
  const workspace = await tempWorkspace(t);
  const first = path.join(workspace, "first.txt");
  const second = path.join(workspace, "second.txt");
  await fs.writeFile(first, "first-v1\n");
  await fs.writeFile(second, "second-v2\n");

  const service = new WorkspaceMutationService(workspace);
  await assert.rejects(
    service.apply(
      [
        {
          kind: "update",
          path: first,
          expectedHash: workspaceContentHash("first-v1\n"),
          content: "first-v2\n",
        },
        {
          kind: "update",
          path: second,
          expectedHash: workspaceContentHash("stale second\n"),
          content: "second-v3\n",
        },
      ],
      { transactionId: "validation-failure" },
    ),
    (error) => error instanceof WorkspaceMutationError && error.code === "BASE_MISMATCH",
  );

  assert.equal(await fs.readFile(first, "utf8"), "first-v1\n");
  assert.equal(await fs.readFile(second, "utf8"), "second-v2\n");
  await assert.rejects(fs.stat(path.join(workspace, ".ares", "mutations", "validation-failure")), { code: "ENOENT" });
});

test("workspace-global path lock serializes CAS writers so only one stale-base update wins", async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "shared.txt");
  await fs.writeFile(file, "base\n");
  const expectedHash = workspaceContentHash("base\n");

  const one = new WorkspaceMutationService(workspace).apply([
    { kind: "update", path: file, expectedHash, content: "winner-one\n" },
  ]);
  const two = new WorkspaceMutationService(workspace).apply([
    { kind: "update", path: file, expectedHash, content: "winner-two\n" },
  ]);
  const settled = await Promise.allSettled([one, two]);

  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const failure = settled.find((result) => result.status === "rejected");
  assert.equal(failure?.reason instanceof WorkspaceMutationError, true);
  assert.equal(failure?.reason.code, "BASE_MISMATCH");
  assert.match(await fs.readFile(file, "utf8"), /^winner-(one|two)\n$/);
});

test("cross-process path leases serialize stale-base Ares writers", { timeout: 20_000 }, async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "cross-process.txt");
  await fs.writeFile(file, "base\n");
  const ready = path.join(workspace, "first.ready");
  const secondStarted = path.join(workspace, "second.started");
  const release = path.join(workspace, "release");
  const moduleUrl = pathToFileURL(path.resolve("packages/core/dist/workspaceMutation.js")).href;
  const childScript = `
    import { promises as fs } from "node:fs";
    import { WorkspaceMutationService, workspaceContentHash } from ${JSON.stringify(moduleUrl)};
    const [role, workspace, file, ready, release] = process.argv.slice(1);
    const originalRename = fs.rename.bind(fs);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const exists = async (target) => fs.stat(target).then(() => true, () => false);
    if (role === "first") {
      fs.rename = async (source, target) => {
        if (source === file && target.endsWith(".old")) {
          await fs.writeFile(ready, "ready");
          while (!(await exists(release))) await wait(10);
        }
        return originalRename(source, target);
      };
    } else {
      await fs.writeFile(ready, "started");
    }
    try {
      const receipt = await new WorkspaceMutationService(workspace).apply([{
        kind: "update", path: file, expectedHash: workspaceContentHash("base\\n"),
        content: role + " wins\\n",
      }], { transactionId: "cross-process-" + role });
      process.stdout.write(JSON.stringify({ ok: true, id: receipt.id }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error?.code, message: String(error?.message ?? error) }));
    }
  `;

  const first = startChild(childScript, ["first", workspace, file, ready, release]);
  t.after(() => first.child.kill());
  await waitForFile(ready);
  const second = startChild(childScript, ["second", workspace, file, secondStarted, release]);
  t.after(() => second.child.kill());
  await waitForFile(secondStarted);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(second.child.exitCode, null, "second process must wait behind the first path lease");
  await fs.writeFile(release, "release");

  const [firstResult, secondResult] = await Promise.all([first.done, second.done]);
  assert.equal(JSON.parse(firstResult).ok, true);
  const loser = JSON.parse(secondResult);
  assert.equal(loser.ok, false);
  assert.equal(loser.code, "BASE_MISMATCH");
  assert.equal(await fs.readFile(file, "utf8"), "first wins\n");
});

test("a path lease from a killed writer is reclaimed before the next mutation", { timeout: 20_000 }, async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "crashed-owner.txt");
  const ready = path.join(workspace, "crashed.ready");
  await fs.writeFile(file, "base\n");
  const moduleUrl = pathToFileURL(path.resolve("packages/core/dist/workspaceMutation.js")).href;
  const childScript = `
    import { promises as fs } from "node:fs";
    import { WorkspaceMutationService, workspaceContentHash } from ${JSON.stringify(moduleUrl)};
    const [workspace, file, ready] = process.argv.slice(1);
    const originalRename = fs.rename.bind(fs);
    fs.rename = async (source, target) => {
      if (source === file && target.endsWith(".old")) {
        await fs.writeFile(ready, "ready");
        await new Promise(() => {});
      }
      return originalRename(source, target);
    };
    await new WorkspaceMutationService(workspace).apply([{
      kind: "update", path: file, expectedHash: workspaceContentHash("base\\n"), content: "never commits\\n",
    }], { transactionId: "killed-lock-owner" });
  `;
  const crashed = startChild(childScript, [workspace, file, ready]);
  t.after(() => crashed.child.kill());
  const crashedDone = crashed.done.catch(() => undefined);
  await waitForFile(ready);
  crashed.child.kill();
  await crashedDone;

  const receipt = await new WorkspaceMutationService(workspace).apply([{
    kind: "update",
    path: file,
    expectedHash: workspaceContentHash("base\n"),
    content: "recovered writer\n",
  }], { transactionId: "post-crash-writer" });
  assert.equal(receipt.status, "committed");
  assert.equal(await fs.readFile(file, "utf8"), "recovered writer\n");
});

test("an external process replacing the source between compare and rename is preserved", { timeout: 20_000 }, async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "external-race.txt");
  const trigger = path.join(workspace, "editor.trigger");
  const done = path.join(workspace, "editor.done");
  const transactionId = "external-generation-race";
  const tombstone = path.join(workspace, `.ares-${transactionId}-0000.old`);
  await fs.writeFile(file, "base\n");
  const editor = startExternalEditor(trigger, done, file, "external editor\n", false);
  t.after(() => editor.child.kill());
  const originalRename = fs.rename.bind(fs);
  fs.rename = async (source, target) => {
    if (source === file && target === tombstone) {
      await fs.writeFile(trigger, "go");
      await waitForFile(done);
    }
    return originalRename(source, target);
  };

  try {
    await assert.rejects(
      new WorkspaceMutationService(workspace).apply([{
        kind: "update",
        path: file,
        expectedHash: workspaceContentHash("base\n"),
        content: "Ares replacement\n",
      }], { transactionId }),
      (error) => error instanceof WorkspaceMutationError && error.code === "BASE_MISMATCH",
    );
  } finally {
    fs.rename = originalRename;
  }
  await editor.done;

  assert.equal(await fs.readFile(file, "utf8"), "external editor\n");
  await assert.rejects(fs.stat(tombstone), { code: "ENOENT" });
  const journal = await fs.readFile(path.join(workspace, ".ares", "mutations", transactionId, "journal.jsonl"), "utf8");
  assert.match(journal, /"event":"source_generation_conflict"/);
  assert.match(journal, /"disposition":"source_preserved"/);
  assert.equal((await new WorkspaceMutationService(workspace).reconcile(transactionId)).disposition, "diverged");
});

test("a same-content atomic replacement is rejected by file generation identity", { timeout: 20_000 }, async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "identity-race.txt");
  const trigger = path.join(workspace, "identity.trigger");
  const done = path.join(workspace, "identity.done");
  const transactionId = "same-content-generation-race";
  const tombstone = path.join(workspace, `.ares-${transactionId}-0000.old`);
  await fs.writeFile(file, "base\n");
  const before = await fs.lstat(file);
  const editor = startExternalEditor(trigger, done, file, "base\n", false);
  t.after(() => editor.child.kill());
  const originalRename = fs.rename.bind(fs);
  fs.rename = async (source, target) => {
    if (source === file && target === tombstone) {
      await fs.writeFile(trigger, "go");
      await waitForFile(done);
    }
    return originalRename(source, target);
  };

  try {
    await assert.rejects(
      new WorkspaceMutationService(workspace).apply([{
        kind: "update",
        path: file,
        expectedHash: workspaceContentHash("base\n"),
        content: "Ares replacement\n",
      }], { transactionId }),
      (error) => error instanceof WorkspaceMutationError && error.code === "BASE_MISMATCH",
    );
  } finally {
    fs.rename = originalRename;
  }
  await editor.done;

  assert.equal(await fs.readFile(file, "utf8"), "base\n");
  const after = await fs.lstat(file);
  if (before.ino !== 0 && after.ino !== 0) assert.notEqual(after.ino, before.ino);
  await assert.rejects(fs.stat(tombstone), { code: "ENOENT" });
  const journal = await fs.readFile(path.join(workspace, ".ares", "mutations", transactionId, "journal.jsonl"), "utf8");
  assert.match(journal, /"event":"source_generation_conflict"/);
});

test("a same-content editor recreation is not claimed as Ares output and retains the parked generation", { timeout: 20_000 }, async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "recreated-race.txt");
  const trigger = path.join(workspace, "recreate.trigger");
  const done = path.join(workspace, "recreate.done");
  const transactionId = "external-recreate-race";
  const stage = path.join(workspace, `.ares-${transactionId}-0000.stage`);
  const tombstone = path.join(workspace, `.ares-${transactionId}-0000.old`);
  const retained = path.join(
    workspace,
    ".ares",
    "mutations",
    transactionId,
    "source-generation-0000.bin",
  );
  await fs.writeFile(file, "base\n");
  const editor = startExternalEditor(trigger, done, file, "Ares replacement\n", true);
  t.after(() => editor.child.kill());
  const originalLink = fs.link.bind(fs);
  fs.link = async (source, target) => {
    if (source === stage && target === file) {
      await fs.writeFile(trigger, "go");
      await waitForFile(done);
    }
    return originalLink(source, target);
  };

  try {
    await assert.rejects(
      new WorkspaceMutationService(workspace).apply([{
        kind: "update",
        path: file,
        expectedHash: workspaceContentHash("base\n"),
        content: "Ares replacement\n",
      }], { transactionId }),
      (error) => error instanceof WorkspaceMutationError && error.code === "ROLLBACK_FAILED",
    );
  } finally {
    fs.link = originalLink;
  }
  await editor.done;

  assert.equal(await fs.readFile(file, "utf8"), "Ares replacement\n");
  assert.equal(await fs.readFile(retained, "utf8"), "base\n");
  await assert.rejects(fs.stat(tombstone), { code: "ENOENT" });
  const journal = await fs.readFile(path.join(workspace, ".ares", "mutations", transactionId, "journal.jsonl"), "utf8");
  assert.match(journal, /"event":"reconcile_required"/);
  assert.ok(journal.includes(JSON.stringify(retained).slice(1, -1)), "journal points to the retained source generation");
  const reconciliation = await new WorkspaceMutationService(workspace).reconcile(transactionId);
  assert.equal(reconciliation.transactionStatus, "incomplete");
  assert.equal(reconciliation.disposition, "fully_applied", "bytes match after-state but ownership was not fabricated");
  assert.equal(reconciliation.canRollback, false, "an incomplete transaction has no committed receipt to roll back");
});

test("late writes through the parked source inode remain durably reachable after commit", { timeout: 20_000 }, async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "open-editor.txt");
  const transactionId = "open-editor-late-write";
  const stage = path.join(workspace, `.ares-${transactionId}-0000.stage`);
  const tombstone = path.join(workspace, `.ares-${transactionId}-0000.old`);
  await fs.writeFile(file, "base\n");
  const editorHandle = await fs.open(file, "r+");
  const originalLink = fs.link.bind(fs);
  let wroteAfterPark = false;
  fs.link = async (source, target) => {
    if (source === stage && target === file) {
      const bytes = Buffer.from("external late bytes\n", "utf8");
      await editorHandle.truncate(0);
      await editorHandle.write(bytes, 0, bytes.length, 0);
      await editorHandle.sync();
      wroteAfterPark = true;
    }
    return originalLink(source, target);
  };

  let receipt;
  try {
    receipt = await new WorkspaceMutationService(workspace).apply([{
      kind: "update",
      path: file,
      expectedHash: workspaceContentHash("base\n"),
      content: "Ares replacement\n",
    }], { transactionId });
  } finally {
    fs.link = originalLink;
    await editorHandle.close();
  }

  assert.equal(wroteAfterPark, true, "the editor write occurs after source parking and before installation");
  assert.equal(await fs.readFile(file, "utf8"), "Ares replacement\n");
  assert.equal(receipt.retainedSourceGenerations.length, 1);
  const retained = receipt.retainedSourceGenerations[0];
  assert.equal(retained.sourcePath, file);
  assert.equal(await fs.readFile(retained.artifactPath, "utf8"), "external late bytes\n");
  assert.equal(path.dirname(retained.artifactPath), path.dirname(receipt.receiptPath));
  await assert.rejects(fs.stat(tombstone), { code: "ENOENT" });

  const reconciliation = await new WorkspaceMutationService(workspace).reconcile(transactionId);
  assert.equal(reconciliation.disposition, "fully_applied");
  assert.equal(reconciliation.hasRetainedSourceChanges, true);
  assert.equal(reconciliation.retainedSourceGenerations.length, 1);
  assert.equal(reconciliation.retainedSourceGenerations[0]?.state, "modified");
  assert.equal(
    reconciliation.retainedSourceGenerations[0]?.actualHash,
    workspaceContentHash("external late bytes\n"),
  );
  const rootArtifacts = (await fs.readdir(workspace)).filter((entry) => entry.includes(transactionId));
  assert.deepEqual(rootArtifacts, [], "ordinary cleanup leaves no stage/tombstone clutter beside project files");
});

test("workspace mutation rejects escaping and conflicting paths", async (t) => {
  const workspace = await tempWorkspace(t);
  const service = new WorkspaceMutationService(workspace);
  await assert.rejects(
    service.apply([{ kind: "add", path: "../escape.txt", content: "no" }]),
    (error) => error instanceof WorkspaceMutationError && error.code === "PATH_OUTSIDE_WORKSPACE",
  );
  await assert.rejects(
    service.apply([
      { kind: "add", path: "same.txt", content: "one" },
      { kind: "add", path: "same.txt", content: "two" },
    ]),
    (error) => error instanceof WorkspaceMutationError && error.code === "PATH_CONFLICT",
  );
  await assert.rejects(fs.stat(path.join(workspace, "same.txt")), { code: "ENOENT" });
});

test("workspace mutation applies mode-only updates and includes mode in CAS", {
  skip: process.platform === "win32" ? "Windows does not expose POSIX executable mode semantics" : false,
}, async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "script.sh");
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  const before = await fs.lstat(file);
  const service = new WorkspaceMutationService(workspace);

  const receipt = await service.apply([{
    kind: "update",
    path: file,
    expectedHash: workspaceContentHash("#!/bin/sh\nexit 0\n"),
    expectedMode: before.mode & 0o7777,
    content: "#!/bin/sh\nexit 0\n",
    mode: (before.mode & 0o7000) | 0o755,
  }]);

  assert.equal((await fs.lstat(file)).mode & 0o777, 0o755);
  assert.equal(receipt.operations[0]?.kind, "update");
  assert.equal(receipt.operations[0]?.afterMode & 0o777, 0o755);
  assert.equal((await service.reconcile(receipt.id)).disposition, "fully_applied");

  await service.rollback(receipt.id);
  assert.equal((await fs.lstat(file)).mode & 0o777, 0o644);
  assert.equal((await service.reconcile(receipt.id)).disposition, "not_applied");
});

test("exclusive install fallback claims its final inode-less generation for rollback", async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "fallback-install.txt");
  const blocker = path.join(workspace, "blocker.txt");
  const transactionId = "fallback-install-final-identity";
  await fs.writeFile(file, "base\n");
  const originalLink = fs.link.bind(fs);
  const originalOpen = fs.open.bind(fs);
  fs.link = async (source, target) => {
    if (target === file && source.endsWith(".stage")) throw filesystemError("ENOTSUP");
    if (target === blocker) throw filesystemError("EACCES");
    return originalLink(source, target);
  };
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file && args[1] === "wx") maskHandleInode(handle);
    return handle;
  };

  try {
    await assert.rejects(
      new WorkspaceMutationService(workspace).apply([
        {
          kind: "update",
          path: file,
          expectedHash: workspaceContentHash("base\n"),
          content: "temporary Ares bytes\n",
        },
        { kind: "add", path: blocker, content: "must fail\n" },
      ], { transactionId }),
      (error) => error instanceof WorkspaceMutationError && error.code === "COMMIT_FAILED",
    );
  } finally {
    fs.link = originalLink;
    fs.open = originalOpen;
  }

  assert.equal(await fs.readFile(file, "utf8"), "base\n");
  await assert.rejects(fs.stat(blocker), { code: "ENOENT" });
});

test("exclusive parked-source copy fallback verifies its final inode-less identity", async (t) => {
  const workspace = await tempWorkspace(t);
  const file = path.join(workspace, "fallback-restore.txt");
  const blocker = path.join(workspace, "restore-blocker.txt");
  const transactionId = "fallback-restore-final-identity";
  const retained = path.join(
    workspace,
    ".ares",
    "mutations",
    transactionId,
    "source-generation-0000.bin",
  );
  await fs.writeFile(file, "base\n");
  const originalLink = fs.link.bind(fs);
  const originalOpen = fs.open.bind(fs);
  fs.link = async (source, target) => {
    if (source === retained && target === file) throw filesystemError("ENOTSUP");
    if (target === blocker) throw filesystemError("EACCES");
    return originalLink(source, target);
  };
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file && args[1] === "wx") maskHandleInode(handle);
    return handle;
  };

  try {
    await assert.rejects(
      new WorkspaceMutationService(workspace).apply([
        {
          kind: "update",
          path: file,
          expectedHash: workspaceContentHash("base\n"),
          content: "temporary Ares bytes\n",
        },
        { kind: "add", path: blocker, content: "must fail\n" },
      ], { transactionId }),
      (error) => error instanceof WorkspaceMutationError && error.code === "COMMIT_FAILED",
    );
  } finally {
    fs.link = originalLink;
    fs.open = originalOpen;
  }

  assert.equal(await fs.readFile(file, "utf8"), "base\n");
  await assert.rejects(fs.stat(blocker), { code: "ENOENT" });
  await assert.rejects(fs.stat(retained), { code: "ENOENT" }, "restoration consumes the parked generation");
});

function filesystemError(code) {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

function maskHandleInode(handle) {
  const originalStat = handle.stat.bind(handle);
  handle.stat = async (...args) => {
    const stat = await originalStat(...args);
    Object.defineProperty(stat, "dev", { configurable: true, value: 0 });
    Object.defineProperty(stat, "ino", { configurable: true, value: 0 });
    return stat;
  };
}

function startExternalEditor(trigger, done, target, content, exclusive) {
  const script = `
    import { promises as fs } from "node:fs";
    const [trigger, done, target, content, exclusive] = process.argv.slice(1);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    while (!(await fs.stat(trigger).then(() => true, () => false))) await wait(10);
    if (exclusive === "true") {
      await fs.writeFile(target, content, { flag: "wx" });
    } else {
      const temp = target + ".editor-" + process.pid;
      await fs.writeFile(temp, content, "utf8");
      await fs.rename(temp, target);
    }
    await fs.writeFile(done, "done");
  `;
  return startChild(script, [trigger, done, target, content, String(exclusive)]);
}

function startChild(script, args) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`workspace mutation child exited code=${code} signal=${signal}: ${stderr || stdout}`));
    });
  });
  return { child, done };
}

async function waitForFile(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await fs.stat(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}
