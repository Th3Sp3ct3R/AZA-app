// The Rust allowlist is a silent chokepoint. This test is the guard.
//
// tauri/src-tauri/src/main.rs holds ALLOWED_DAEMON_COMMANDS; anything the UI
// sends that is missing from it is rejected with a Result::Err the frontend
// discards. The button then does NOTHING, with no error anywhere the owner can
// see.
//
// Six commands shipped that way and were dead for their entire lifetime: the
// whole persona/roster feature (persona_adopt, persona_write, persona_delete,
// roster_list), the Plan/Build pill (workflow_mode), and the Mind cockpit's
// state read (cognitive_state). A "fix" was even shipped for persona adoption
// that could never have run, because the command never reached the daemon.
//
// Same failure class as the missing ShellSupervisor: fine in dev, dead in the
// packaged app, invisible to every existing test.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

/** Command types the desktop UI can send. */
function uiCommandTypes() {
  const app = read("tauri/src/App.tsx");
  const types = new Set();
  for (const m of app.matchAll(/daemonCmd\(\{\s*type:\s*"([a-z_]+)"/g)) types.add(m[1]);
  return types;
}

/** Command types the Rust bridge will forward. */
function allowedCommandTypes() {
  const rs = read("tauri/src-tauri/src/main.rs");
  const block = rs.match(/ALLOWED_DAEMON_COMMANDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
  assert.ok(block, "ALLOWED_DAEMON_COMMANDS not found in main.rs");
  return new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
}

/** Command types the daemon actually implements. */
function daemonHandledTypes() {
  const src = read("packages/cli/src/entry/daemon.ts");
  const types = new Set();
  for (const m of src.matchAll(/command\.type === "([a-z_]+)"/g)) types.add(m[1]);
  return types;
}

test("every command the UI sends is allowed through the Rust bridge", () => {
  const ui = uiCommandTypes();
  const allowed = allowedCommandTypes();
  assert.ok(ui.size > 20, `expected to find the UI's command vocabulary, found ${ui.size}`);
  const blocked = [...ui].filter((t) => !allowed.has(t)).sort();
  assert.deepEqual(
    blocked,
    [],
    `these UI commands are silently rejected by ALLOWED_DAEMON_COMMANDS in tauri/src-tauri/src/main.rs — ` +
      `the buttons that send them do nothing: ${blocked.join(", ")}`,
  );
});

test("every command the UI sends is actually implemented by the daemon", () => {
  const ui = uiCommandTypes();
  const handled = daemonHandledTypes();
  // A few are handled outside the main switch (send/steer/interrupt go through
  // the input router, permission responses through the permission channel).
  const routedElsewhere = new Set(["send", "steer", "interrupt", "permission", "permission_response", "exit"]);
  const unimplemented = [...ui].filter((t) => !handled.has(t) && !routedElsewhere.has(t)).sort();
  assert.deepEqual(
    unimplemented,
    [],
    `these UI commands reach the daemon but nothing handles them: ${unimplemented.join(", ")}`,
  );
});

test("the roster + workflow surfaces are specifically routable", () => {
  // Named explicitly so a future allowlist edit that drops them fails loudly
  // rather than silently re-killing the feature.
  const allowed = allowedCommandTypes();
  for (const t of [
    "roster_list", "persona_adopt", "persona_write", "persona_delete", "persona_style",
    "workflow_mode", "cognitive_state",
  ]) {
    assert.ok(allowed.has(t), `${t} must stay in ALLOWED_DAEMON_COMMANDS`);
  }
});
