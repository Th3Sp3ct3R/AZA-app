// Contract for the version the CLI reports about itself (cliVersion in
// packages/cli/src/entry/runtime.ts).
//
// The number is not decoration. It is printed by `ares help`, sent as
// `app_version` in the daemon handshake, and attached as `aresVersion` on the
// agent side, so a stale one misreports the running build to the operator and
// to every client that reads the handshake.
//
// The regression this guards: resolution stopped at the first package.json
// above the module, which is `packages/cli/package.json` — a private workspace
// member no release bumps. It read 0.16.0 while the product shipped 0.37.2.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cliVersion } from "../packages/cli/dist/entry/runtime.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readVersion = (file) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")).version;

test("the CLI reports the product version, not its workspace member version", async () => {
  const reported = await cliVersion();
  assert.equal(
    reported,
    readVersion("package.json"),
    "cliVersion() must resolve the root manifest — the one the release bumps",
  );
});

test("the reported version matches what the desktop shell ships", async () => {
  // Root package.json and tauri.conf.json are bumped together at release time;
  // the CLI and the desktop claiming different versions of the same build is
  // exactly the confusion this test exists to catch.
  const reported = await cliVersion();
  assert.equal(reported, readVersion("tauri/src-tauri/tauri.conf.json"));
});

test("the version is a real semver triple, never the 0.0.0 fallback", async () => {
  const reported = await cliVersion();
  assert.match(reported, /^\d+\.\d+\.\d+/);
  assert.notEqual(reported, "0.0.0", "0.0.0 means every manifest lookup failed");
});
