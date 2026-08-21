import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BashTool,
  EditTool,
  ReadTool,
  WriteTool,
  adaptToolForEngine,
} from "../packages/tools/dist/index.js";

function makeHarness({ workspace, permissionMode, pathPermissions, requestPermission }) {
  const fileReadStamps = new Map();
  const base = {
    workspace,
    sessionId: "workspace-freedom",
    signal: new AbortController().signal,
    requestPermission,
  };

  return {
    async call(tool, input) {
      const adapted = adaptToolForEngine(tool, (context) => ({
        ...context,
        permissionMode,
        fileReadStamps,
        pathPermissions,
      }));
      return adapted.call(input, base);
    },
  };
}

function inMemoryPathPermissions() {
  const grants = [];
  return {
    grants,
    isAllowed(absPath, access) {
      const candidate = path.resolve(absPath);
      return grants.some((grant) =>
        (grant.access === access || grant.access === "all") &&
        (candidate === grant.path || candidate.startsWith(grant.path + path.sep))
      );
    },
    async grant(absPath, access, scope) {
      grants.push({ path: path.resolve(absPath), access, scope });
    },
  };
}

async function missing(file) {
  return stat(file).then(() => false, (error) => error?.code === "ENOENT");
}

test("bypass tools read, edit, write, and run shell directly in an absolute external project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ares-workspace-freedom-"));
  const startupWorkspace = path.join(root, "startup-workspace");
  const externalProject = path.join(root, "chosen-project");
  await Promise.all([
    mkdir(startupWorkspace, { recursive: true }),
    mkdir(externalProject, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(startupWorkspace, ".keep"), "startup\n", "utf8"),
    writeFile(path.join(externalProject, "editable.txt"), "alpha\n", "utf8"),
  ]);

  const editable = path.join(externalProject, "editable.txt");
  const created = path.join(externalProject, "created.txt");
  const shellCreated = path.join(externalProject, "shell-direct.txt");
  const harness = makeHarness({ workspace: startupWorkspace, permissionMode: "bypass" });

  try {
    const read = await harness.call(ReadTool, { file_path: editable });
    assert.equal(read.output.path, editable);
    assert.match(read.output.content, /alpha/);

    const edit = await harness.call(EditTool, {
      file_path: editable,
      old_string: "alpha",
      new_string: "beta",
      replace_all: false,
    });
    assert.equal(edit.output.path, editable);
    assert.equal(await readFile(editable, "utf8"), "beta\n");

    const write = await harness.call(WriteTool, {
      file_path: created,
      content: "written where the owner asked\n",
    });
    assert.equal(write.output.path, created);
    assert.equal(await readFile(created, "utf8"), "written where the owner asked\n");

    const shell = await harness.call(BashTool, {
      command: "printf shell-direct > shell-direct.txt",
      description: "Write in chosen external project",
      timeout: 30_000,
      cwd: externalProject,
      run_in_background: false,
    });
    assert.equal(shell.output.exitCode, 0, shell.output.stderr);
    assert.equal(await readFile(shellCreated, "utf8"), "shell-direct");

    for (const basename of ["editable.txt", "created.txt", "shell-direct.txt"]) {
      assert.equal(
        await missing(path.join(startupWorkspace, basename)),
        true,
        `${basename} must not be copied or staged as a project file in the startup workspace`,
      );
    }
    assert.equal(
      await missing(path.join(startupWorkspace, path.basename(externalProject))),
      true,
      "the selected project must never be mirrored under the startup workspace",
    );
    const transactions = await readdir(path.join(externalProject, ".ares", "mutations"));
    assert.ok(transactions.length >= 2, "external edits commit through that project's own recovery journal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one guarded approval grants the external directory for sibling writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ares-workspace-grant-"));
  const startupWorkspace = path.join(root, "startup-workspace");
  const externalProject = path.join(root, "chosen-project");
  await Promise.all([
    mkdir(startupWorkspace, { recursive: true }),
    mkdir(externalProject, { recursive: true }),
  ]);

  const pathPermissions = inMemoryPathPermissions();
  const prompts = [];
  const harness = makeHarness({
    workspace: startupWorkspace,
    permissionMode: "workspace-write",
    pathPermissions,
    requestPermission: async (request) => {
      prompts.push(request);
      return "allow_once";
    },
  });

  try {
    const first = path.join(externalProject, "first.txt");
    const sibling = path.join(externalProject, "sibling.txt");
    await harness.call(WriteTool, { file_path: first, content: "first\n" });
    await harness.call(WriteTool, { file_path: sibling, content: "sibling\n" });

    assert.equal(prompts.length, 1, "the sibling write must reuse the project-directory grant");
    assert.equal(prompts[0].toolName, "Filesystem");
    assert.deepEqual(pathPermissions.grants, [{
      path: externalProject,
      access: "write",
      scope: "once",
    }]);
    assert.equal(await readFile(first, "utf8"), "first\n");
    assert.equal(await readFile(sibling, "utf8"), "sibling\n");
    assert.equal(await missing(path.join(startupWorkspace, "first.txt")), true);
    assert.equal(await missing(path.join(startupWorkspace, "sibling.txt")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
