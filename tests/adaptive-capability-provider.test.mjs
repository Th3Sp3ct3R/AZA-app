import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RunSkillTool,
  SkillCraftTool,
  getCapability,
  loadSelfModel,
  parseCapabilityManifest,
  resolveCapabilityProvider,
  resolveSkill,
  runSkill,
  scanCapabilityRegistry,
} from "../packages/agent/dist/index.js";

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function capabilityManifest({
  scope = "user",
  id = "test/editor",
  applyEffect = "workspace-write",
  extraOperations = {},
} = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: "capability-provider",
    version: "1.0.0",
    scope,
    description: "Engine-agnostic test provider",
    operations: {
      apply: {
        description: "Apply a deterministic edit",
        effect: applyEffect,
        evidence: [],
        requiresFreshObservationAfter: false,
      },
      health: {
        description: "Observe whether the provider is ready",
        effect: "read-only",
        evidence: [],
        requiresFreshObservationAfter: false,
      },
      ...extraOperations,
    },
    provides: { "test/edit": "apply" },
    healthcheck: { operation: "health", timeoutMs: 1_000 },
  };
}

async function writeSkill(skillsRoot, name, { handler, manifest } = {}) {
  const dir = path.join(skillsRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: provider test\n---\n`,
    "utf8",
  );
  if (handler !== undefined) await fs.writeFile(path.join(dir, "handler.js"), handler, "utf8");
  if (manifest !== undefined) {
    const body = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2) + "\n";
    await fs.writeFile(path.join(dir, "capability.json"), body, "utf8");
  }
  return dir;
}

test("capability manifest is strict and healthchecks are read-only", () => {
  const parsed = parseCapabilityManifest(capabilityManifest());
  assert.deepEqual(parsed.compatibility, {});
  assert.deepEqual(parsed.match, { files: [], commands: [] });

  assert.throws(
    () => parseCapabilityManifest({ ...capabilityManifest(), inventedField: true }),
    /unrecognized key/i,
  );

  const unknownOperation = capabilityManifest();
  unknownOperation.provides["test/edit"] = "missing";
  assert.throws(() => parseCapabilityManifest(unknownOperation), /references unknown operation 'missing'/);

  const unsafeHealthcheck = capabilityManifest();
  unsafeHealthcheck.operations.health.effect = "workspace-write";
  assert.throws(() => parseCapabilityManifest(unsafeHealthcheck), /must reference a read-only operation/);

  const duplicateEvidence = capabilityManifest();
  duplicateEvidence.operations.apply.evidence = ["visual", "visual"];
  assert.throws(() => parseCapabilityManifest(duplicateEvidence), /duplicate evidence kinds/);
});

test("registry resolves workspace-local before user-global without manifest/code disagreement", async (t) => {
  const home = await tempDir("ares-provider-home-");
  const workspace = await tempDir("ares-provider-workspace-");
  t.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(workspace, { recursive: true, force: true }),
  ]));

  const userRoot = path.join(home, "skills");
  const localRoot = path.join(workspace, ".ares", "skills");
  await writeSkill(userRoot, "editor", {
    handler: "export default async () => 'global';",
    manifest: capabilityManifest({ scope: "user", id: "test/editor" }),
  });
  await writeSkill(localRoot, "editor", {
    handler: "export default async () => 'local';",
    manifest: capabilityManifest({ scope: "workspace", id: "test/editor" }),
  });

  const visible = await resolveSkill("editor", { home, workspace });
  assert.equal(visible.scope, "workspace");
  assert.equal(visible.dir, path.join(localRoot, "editor"));

  const registry = await scanCapabilityRegistry({ home, workspace });
  assert.equal(registry.errors.length, 0);
  assert.equal(registry.providers.filter((provider) => provider.name === "editor").length, 1);
  assert.equal(registry.providers.find((provider) => provider.name === "editor").scope, "workspace");
  assert.equal((await resolveCapabilityProvider({ capability: "test/edit" }, { home, workspace })).scope, "workspace");

  // A local non-provider still shadows the same-named global provider. This is
  // critical: otherwise the registry would choose global metadata while
  // runSkill executes different local code.
  await writeSkill(userRoot, "legacy_shadow", {
    handler: "export default async () => 'global-provider';",
    manifest: capabilityManifest({ scope: "user", id: "test/legacy-shadow" }),
  });
  await writeSkill(localRoot, "legacy_shadow", {
    handler: "export default async () => 'local-legacy';",
  });
  const afterLegacyShadow = await scanCapabilityRegistry({ home, workspace });
  assert.equal(afterLegacyShadow.providers.some((provider) => provider.name === "legacy_shadow"), false);

  // A malformed local contract also shadows rather than silently falling back.
  await writeSkill(userRoot, "broken_shadow", {
    handler: "export default async () => 'global-provider';",
    manifest: capabilityManifest({ scope: "user", id: "test/broken-shadow" }),
  });
  await writeSkill(localRoot, "broken_shadow", {
    handler: "export default async () => 'broken-local';",
    manifest: "{\"schemaVersion\":1}\n",
  });
  const afterBrokenShadow = await scanCapabilityRegistry({ home, workspace });
  assert.equal(afterBrokenShadow.providers.some((provider) => provider.name === "broken_shadow"), false);
  assert.equal(afterBrokenShadow.errors.some((error) => error.skill === "broken_shadow"), true);
});

test("workspace provider executes against an owner-selected target and returns a verified receipt", async (t) => {
  const home = await tempDir("ares-provider-run-home-");
  const workspace = await tempDir("ares-provider-run-workspace-");
  const target = await tempDir("ares-provider-run-target-");
  t.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(target, { recursive: true, force: true }),
  ]));

  await writeSkill(path.join(home, "skills"), "adaptive_editor", {
    handler: "export default async () => ({ source: 'global' });",
  });
  const localDir = await writeSkill(path.join(workspace, ".ares", "skills"), "adaptive_editor", {
    manifest: capabilityManifest({ scope: "workspace", id: "test/adaptive-editor" }),
    handler: `import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export default async function handler(input, ctx) {
  const content = String(input?.content ?? "");
  const file = path.join(ctx.targetRoot, "artifact.txt");
  await writeFile(file, content, "utf8");
  const afterHash = createHash("sha256").update(content, "utf8").digest("hex");
  return {
    contractVersion: 1,
    ok: true,
    providerId: "test/adaptive-editor",
    providerHash: ctx.providerHash,
    operation: "apply",
    targetRoot: ctx.targetRoot,
    result: {
      source: "workspace",
      workspace: ctx.workspace,
      targetRoot: ctx.targetRoot,
      sessionId: ctx.sessionId,
      skillDir: ctx.skillDir,
      cwd: process.cwd(),
    },
    mutations: [{ path: "artifact.txt", afterHash }],
    evidence: [],
  };
}`,
  });

  const run = await runSkill({
    home,
    workspace,
    targetRoot: target,
    sessionId: "session-provider-context",
    name: "adaptive_editor",
    operation: "apply",
    input: { content: "verified output" },
  });

  const artifact = path.join(target, "artifact.txt");
  assert.equal(run.ok, true, run.error);
  assert.equal(run.scope, "workspace");
  assert.equal(run.targetRoot, target);
  assert.deepEqual(run.touchedFiles, [artifact]);
  assert.equal(run.receipt.providerHash.length, 64);
  assert.equal(run.receipt.mutations[0].path, artifact);
  assert.equal(run.result.source, "workspace");
  assert.equal(run.result.workspace, workspace);
  assert.equal(run.result.targetRoot, target);
  assert.equal(run.result.sessionId, "session-provider-context");
  assert.equal(run.result.skillDir, localDir);
  assert.equal(run.result.cwd, target);
  assert.equal(await fs.readFile(artifact, "utf8"), "verified output");
});

test("legacy nested ok:false propagates as a failed run", async (t) => {
  const home = await tempDir("ares-provider-nested-home-");
  const workspace = await tempDir("ares-provider-nested-workspace-");
  t.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(workspace, { recursive: true, force: true }),
  ]));
  await writeSkill(path.join(home, "skills"), "semantic_failure", {
    handler: "export default async () => ({ ok: false, error: 'engine rejected the request' });",
  });

  const run = await runSkill({ home, workspace, name: "semantic_failure" });
  assert.equal(run.ok, false);
  assert.match(run.error, /engine rejected the request/);
  assert.deepEqual(run.result, { ok: false, error: "engine rejected the request" });
});

test("provider settlements reject bad hashes, escapes, read-only writes, and missing fresh evidence", async (t) => {
  const home = await tempDir("ares-provider-contract-home-");
  const workspace = await tempDir("ares-provider-contract-workspace-");
  const target = await tempDir("ares-provider-contract-target-");
  t.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(target, { recursive: true, force: true }),
  ]));

  const manifest = capabilityManifest({
    scope: "workspace",
    id: "test/settlement",
    extraOperations: {
      inspect: {
        description: "Observe the target",
        effect: "read-only",
        evidence: ["scene-observation"],
        requiresFreshObservationAfter: true,
      },
    },
  });
  await writeSkill(path.join(workspace, ".ares", "skills"), "settlement", {
    manifest,
    handler: `import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export default async function handler(input, ctx) {
  const op = input?.op ?? "apply";
  const base = {
    contractVersion: 1,
    providerId: "test/settlement",
    providerHash: ctx.providerHash,
    operation: op,
    targetRoot: ctx.targetRoot,
    mutations: [],
    evidence: [],
  };
  if (input?.mode === "provider-failure") {
    return { ...base, ok: false, error: "provider refused safely" };
  }
  if (input?.mode === "escape") {
    return { ...base, ok: true, mutations: [{ path: "../outside.txt", afterHash: null }] };
  }
  if (op === "health") {
    const content = "not read only";
    await writeFile(path.join(ctx.targetRoot, "health.txt"), content, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    return { ...base, ok: true, mutations: [{ path: "health.txt", afterHash: hash }] };
  }
  if (op === "inspect") {
    const evidence = input?.mode === "fresh"
      ? [{ kind: "scene-observation", observedAt: new Date().toISOString() }]
      : [];
    return { ...base, ok: true, result: { observed: true }, evidence };
  }
  const content = "hash me";
  await writeFile(path.join(ctx.targetRoot, "hash.txt"), content, "utf8");
  return { ...base, ok: true, mutations: [{ path: "hash.txt", afterHash: "0".repeat(64) }] };
}`,
  });

  const badHash = await runSkill({
    home, workspace, targetRoot: target, name: "settlement", operation: "apply", input: { op: "apply" },
  });
  assert.equal(badHash.ok, false);
  assert.match(badHash.error, /hash mismatch/);
  assert.deepEqual(badHash.touchedFiles, [path.join(target, "hash.txt")]);

  const escaped = await runSkill({
    home, workspace, targetRoot: target, name: "settlement", operation: "apply", input: { op: "apply", mode: "escape" },
  });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error, /escapes targetRoot/);

  const readOnlyWrite = await runSkill({
    home, workspace, targetRoot: target, name: "settlement", operation: "health", input: { op: "health" },
  });
  assert.equal(readOnlyWrite.ok, false);
  assert.match(readOnlyWrite.error, /read-only provider operation/);

  const missingEvidence = await runSkill({
    home, workspace, targetRoot: target, name: "settlement", operation: "inspect", input: { op: "inspect" },
  });
  assert.equal(missingEvidence.ok, false);
  assert.match(missingEvidence.error, /missing required 'scene-observation' evidence/);

  const freshEvidence = await runSkill({
    home, workspace, targetRoot: target, name: "settlement", operation: "inspect", input: { op: "inspect", mode: "fresh" },
  });
  assert.equal(freshEvidence.ok, true, freshEvidence.error);
  assert.deepEqual(freshEvidence.result, { observed: true });

  const providerFailure = await runSkill({
    home,
    workspace,
    targetRoot: target,
    name: "settlement",
    operation: "apply",
    input: { op: "apply", mode: "provider-failure" },
  });
  assert.equal(providerFailure.ok, false);
  assert.match(providerFailure.error, /provider refused safely/);
});

test("SkillCraft placeholders remain acquiring until RunSkill demonstrates success", async (t) => {
  const home = await tempDir("ares-skillcraft-home-");
  const workspace = await tempDir("ares-skillcraft-workspace-");
  const previousHome = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = previousHome;
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(workspace, { recursive: true, force: true }),
    ]);
  });
  const ctx = {
    workspace,
    sessionId: "session-skillcraft",
    signal: new AbortController().signal,
  };

  const crafted = await SkillCraftTool.call(
    { action: "create", name: "adaptive_scene", scope: "workspace", description: "Adapt to a scene tool" },
    ctx,
  );
  assert.equal(crafted.output.scope, "workspace");
  assert.equal(crafted.output.skillDir, path.join(workspace, ".ares", "skills", "adaptive_scene"));

  let capability = getCapability(await loadSelfModel(home), "skill/adaptive_scene");
  assert.equal(capability.status, "acquiring");
  assert.deepEqual(capability.tags, ["placeholder"]);

  const placeholderRun = await RunSkillTool.call({ name: "adaptive_scene" }, ctx);
  assert.equal(placeholderRun.output.ok, false);
  assert.match(placeholderRun.output.error, /handler not implemented yet/);
  capability = getCapability(await loadSelfModel(home), "skill/adaptive_scene");
  assert.equal(capability.status, "acquiring");
  assert.equal(capability.outcomes.fail, 1);

  await SkillCraftTool.call(
    {
      action: "update",
      name: "adaptive_scene",
      scope: "workspace",
      handler_js: "export default async () => ({ adapted: true });",
    },
    ctx,
  );
  const demonstrated = await RunSkillTool.call({ name: "adaptive_scene" }, ctx);
  assert.equal(demonstrated.output.ok, true, demonstrated.output.error);
  capability = getCapability(await loadSelfModel(home), "skill/adaptive_scene");
  assert.equal(capability.status, "have");
  assert.equal(capability.outcomes.ok, 1);
  assert.equal(capability.outcomes.fail, 1);
});

test("Windows timeout terminates the entire skill process tree", { skip: process.platform !== "win32" }, async (t) => {
  const home = await tempDir("ares-provider-tree-home-");
  const workspace = await tempDir("ares-provider-tree-workspace-");
  let descendantPid;
  t.after(async () => {
    if (descendantPid && isPidAlive(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(workspace, { recursive: true, force: true }),
    ]);
  });
  await writeSkill(path.join(home, "skills"), "tree_hang", {
    handler: `import { spawn } from "node:child_process";
export default async function handler() {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  console.log("ARES_DESCENDANT_PID=" + descendant.pid);
  await new Promise(() => {});
}`,
  });

  const run = await runSkill({ home, workspace, name: "tree_hang", timeoutMs: 1_000 });
  assert.equal(run.ok, false);
  assert.equal(run.timedOut, true);
  const match = run.logs.match(/ARES_DESCENDANT_PID=(\d+)/);
  assert.ok(match, `descendant pid was not captured in logs: ${run.logs}`);
  descendantPid = Number(match[1]);

  for (let attempt = 0; attempt < 20 && isPidAlive(descendantPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(isPidAlive(descendantPid), false, `descendant process ${descendantPid} survived timeout cleanup`);
});

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
