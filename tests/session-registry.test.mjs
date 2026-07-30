import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  hashWorkspaceIdentity,
  listRegisteredSessionLocations,
  registerSessionLocation,
} from "../packages/core/dist/sessionRegistry.js";

function location(over = {}) {
  return {
    sessionId: "sess_registry_test",
    source: "core",
    format: "core-rollout-v1",
    workspace: path.join(tmpdir(), "Ares Registry Workspace"),
    rolloutPath: path.join(tmpdir(), "Ares Registry Workspace", ".ares", "sessions", "sess_registry_test", "events.jsonl"),
    metaPath: path.join(tmpdir(), "Ares Registry Workspace", ".ares", "sessions", "sess_registry_test", "meta.json"),
    ...over,
  };
}

test("session registry atomically rewrites one valid record per session", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-session-registry-"));
  try {
    const first = location();
    const firstFile = await registerSessionLocation(first, { home });
    assert.ok(firstFile);

    const nextRollout = path.join(tmpdir(), "moved-workspace", ".ares", "sessions", first.sessionId, "events.jsonl");
    const secondFile = await registerSessionLocation(location({ rolloutPath: nextRollout }), { home });
    assert.equal(secondFile, firstFile, "same session rewrites its one pointer record");

    const dir = path.dirname(firstFile);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".json")), [path.basename(firstFile)]);
    const parsed = JSON.parse(await readFile(firstFile, "utf8"));
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.sessionId, first.sessionId);
    assert.equal(parsed.source, "core");
    assert.equal(parsed.format, "core-rollout-v1");
    assert.equal(parsed.workspaceHash, hashWorkspaceIdentity(first.workspace));
    assert.equal(parsed.rolloutPath, path.resolve(nextRollout));

    const listed = await listRegisteredSessionLocations({ home });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, first.sessionId);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("implicit registry is disabled under node:test but explicit isolation remains enabled", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-session-registry-safe-"));
  const priorHome = process.env.ARES_HOME;
  try {
    process.env.ARES_HOME = home;
    const implicit = await registerSessionLocation(location());
    assert.equal(implicit, null);
    assert.deepEqual(await readdir(home), [], "owner/default registry was not touched");

    const explicit = await registerSessionLocation(location(), { home });
    assert.ok(explicit);
    assert.equal((await listRegisteredSessionLocations({ home })).length, 1);
  } finally {
    if (priorHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("registry readers recover a valid backup left by an interrupted promotion", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-session-registry-backup-"));
  try {
    const file = await registerSessionLocation(location(), { home });
    assert.ok(file);
    await rename(file, file + ".bak");
    const recovered = await listRegisteredSessionLocations({ home });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].sessionId, "sess_registry_test");
    await registerSessionLocation(location(), { home });
    assert.equal(await readFile(file, "utf8").then(Boolean), true);

    const valid = await readFile(file, "utf8");
    await rename(file, file + ".bak");
    await writeFile(file, "{torn", "utf8");
    const recoveredFromTorn = await listRegisteredSessionLocations({ home });
    assert.equal(recoveredFromTorn.length, 1);
    await registerSessionLocation(location(), { home });
    const promoted = JSON.parse(await readFile(file, "utf8"));
    const prior = JSON.parse(valid);
    delete promoted.updatedAt;
    delete prior.updatedAt;
    assert.deepEqual(promoted, prior);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
