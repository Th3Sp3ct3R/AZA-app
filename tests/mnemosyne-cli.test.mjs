// `ares mnemosyne` — the adoption step the package was missing.
//
// Mnemosyne shipped complete and unreachable: a server, a client, bindings,
// guards and an attestation loop that nothing outside its own unit test ever
// imported. These tests drive the REAL CLI entrypoint against a throwaway home,
// because the failure this guards against is not "the library is wrong" — the
// library was always fine — it is "the command does not exist, or silently
// stops reaching the library."

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages", "cli", "dist", "entry.js");

function ares(home, ...args) {
  const result = spawnSync(process.execPath, [entry, "mnemosyne", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ARES_HOME: home },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-mnemo-cli-"));

test("mnemosyne: status answers on an empty home without a server running", async () => {
  const home = await makeHome();
  const r = ares(home, "status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server not running/);
  assert.match(r.stdout, /0 active bindings/);
});

test("mnemosyne: a law round-trips from add to bindings", async () => {
  const home = await makeHome();
  const added = ares(home, "add", "never force-push to main", "--class", "law");
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /\[law\] never force-push to main/);
  // No server is up, and the command must say which writer it used rather than
  // pretending the single-writer path was taken.
  assert.match(added.stdout, /written directly/);

  const listed = ares(home, "bindings", "--json");
  assert.equal(listed.status, 0, listed.stderr);
  const bindings = JSON.parse(listed.stdout);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].class, "law");
  assert.equal(bindings[0].source, "owner");
  assert.equal(bindings[0].active, true);
});

test("mnemosyne: a pact is sourced to the agent, never the owner", async () => {
  const home = await makeHome();
  assert.equal(ares(home, "add", "I will run the tests before claiming done", "--class", "pact").status, 0);
  const [binding] = JSON.parse(ares(home, "bindings", "--json").stdout);
  assert.equal(binding.class, "pact");
  assert.equal(binding.source, "agent");
});

test("mnemosyne: retiring drops it from the active list but keeps the record", async () => {
  const home = await makeHome();
  ares(home, "add", "no destructive git without asking", "--class", "law");
  const [binding] = JSON.parse(ares(home, "bindings", "--json").stdout);

  const retired = ares(home, "retire", binding.id);
  assert.equal(retired.status, 0, retired.stderr);
  assert.deepEqual(JSON.parse(ares(home, "bindings", "--json").stdout), []);

  const all = JSON.parse(ares(home, "bindings", "--json", "--all").stdout);
  assert.equal(all.length, 1, "the binding is retired, not erased");
  assert.equal(all[0].active, false);
});

test("mnemosyne: bad input fails loudly instead of writing something wrong", async () => {
  const home = await makeHome();
  const noText = ares(home, "add", "--class", "law");
  assert.equal(noText.status, 2);
  assert.match(noText.stderr, /the rule/);

  const badClass = ares(home, "add", "something", "--class", "vibes");
  assert.equal(badClass.status, 2);
  assert.match(badClass.stderr, /law, pact, doctrine/);

  const missing = ares(home, "retire", "b_does_not_exist");
  assert.equal(missing.status, 1);

  assert.deepEqual(JSON.parse(ares(home, "bindings", "--json").stdout), [], "nothing was written");
});

test("mnemosyne: compliance reports the recalled-but-violated set", async () => {
  const home = await makeHome();
  ares(home, "add", "always verify before claiming done", "--class", "law");
  const report = ares(home, "compliance", "--json");
  assert.equal(report.status, 0, report.stderr);
  const parsed = JSON.parse(report.stdout);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].attested, 0);
  assert.deepEqual(parsed.flagged, [], "nothing attested yet, so nothing can be flagged");
});

test("mnemosyne: an unknown subcommand is a usage error, not a silent no-op", async () => {
  const home = await makeHome();
  const r = ares(home, "elaborate");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: ares mnemosyne/);
});
