import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireCapability,
  listAcquisitions,
  markAcquisitionAcquired,
  setAcquisitionStatus,
} from "../packages/operator/dist/index.js";

test("capability acquisition is idempotent and hands Workers the real provider contract", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-acquisition-"));
  const workspace = path.join(home, "workspace");
  const targetRoot = path.join(home, "owner-game");
  const first = await acquireCapability({
    home,
    capabilityName: "editor.scene.observe",
    kind: "skill",
    targetFiles: ["provider-selected"],
    description: "Observe the live editor scene and return fresh visual evidence.",
    scope: "workspace",
    workspace,
    targetRoot,
    now: new Date("2026-08-01T12:00:00.000Z"),
  });
  const second = await acquireCapability({
    home,
    capabilityName: "EDITOR.SCENE.OBSERVE",
    kind: "skill",
    scope: "workspace",
    workspace,
    targetRoot,
    now: new Date("2026-08-01T12:01:00.000Z"),
  });

  assert.equal(second.acquisition.id, first.acquisition.id, "repeated ensure reconnects to one job");
  assert.equal(second.goal.id, first.goal.id, "the durable Worker goal is reused");
  assert.match(first.goal.statement, new RegExp(first.acquisition.packetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(first.goal.statement, /fresh visual evidence/);
  assert.match(first.goal.statement, new RegExp(targetRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const packet = await fs.readFile(first.acquisition.packetFile, "utf8");
  assert.match(packet, /capability\.json/);
  assert.match(packet, /healthcheck MUST reference a declared read-only\s+operation/);
  assert.match(packet, /owner-selected `targetRoot`/);
  assert.match(packet, /provider scope\*\*: workspace/);
  assert.match(packet, /fresh visual evidence/);
  assert.match(packet, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(packet, /\{ok:false\}.*NOT acquired/s);

  const building = await setAcquisitionStatus(home, first.acquisition.id, "building", new Date("2026-08-01T12:02:00.000Z"));
  assert.equal(building.status, "building");
  await assert.rejects(
    setAcquisitionStatus(home, first.acquisition.id, "acquired", new Date("2026-08-01T12:03:00.000Z")),
    /requires markAcquisitionAcquired/,
    "plain bookkeeping cannot promote an unverified provider",
  );
  await assert.rejects(
    markAcquisitionAcquired(home, first.acquisition.id, {
      ok: true,
      expectedProviderId: "editor.scene.provider",
      expectedOperation: "inspect",
      receipt: {
        contractVersion: 1,
        ok: true,
        providerId: "editor.scene.provider",
        providerHash: "a".repeat(64),
        operation: "health",
        targetRoot,
        mutations: [],
        evidence: [],
        diagnostics: [],
        jobRefs: [],
      },
    }),
    /operation mismatch/,
    "a receipt for any operation other than the declared healthcheck cannot promote",
  );
  const acquired = await markAcquisitionAcquired(
    home,
    first.acquisition.id,
    {
      ok: true,
      expectedProviderId: "editor.scene.provider",
      expectedOperation: "health",
      receipt: {
        contractVersion: 1,
        ok: true,
        providerId: "editor.scene.provider",
        providerHash: "a".repeat(64),
        operation: "health",
        targetRoot,
        result: { reachable: true },
        mutations: [],
        evidence: [{ kind: "editor-state", observedAt: "2026-08-01T12:03:00.000Z" }],
        diagnostics: [],
        jobRefs: [],
      },
    },
    new Date("2026-08-01T12:03:00.000Z"),
  );
  assert.equal(acquired.status, "acquired");
  assert.deepEqual(acquired.verification, {
    providerId: "editor.scene.provider",
    providerHash: "a".repeat(64),
    operation: "health",
    targetRoot,
    verifiedAt: "2026-08-01T12:03:00.000Z",
  });
  assert.equal((await listAcquisitions(home))[0].status, "acquired");
});
