// C7 — "allow always" for shell commands now persists (v0.11.0, daily-friction).
//
// Before: picking "allow always" on a Bash/PowerShell command behaved exactly
// like "allow once" — the command permission store was read-only (no grant()),
// so the next session re-asked for `pnpm test` every time. Path grants persisted
// fine; commands silently didn't.
//
// The fix: a `grant()` on the command store + a `commandFor` hook on command
// tools, persisted by the permission gate (adaptToolForEngine) on allow_always.
// This drives the REAL BashTool through the gate with a grant() spy. The store's
// decide() forces the prompt; the command is a harmless `echo` so the real call
// is side-effect free.

import test from "node:test";
import assert from "node:assert/strict";
import { BashTool, adaptToolForEngine } from "../packages/tools/dist/index.js";

function run(answer, store) {
  const adapted = adaptToolForEngine(BashTool, (base) => ({
    ...base,
    permissionMode: "guarded",
    fileReadStamps: new Map(),
    commandPermissions: store,
  }));
  return adapted.call(
    { command: "echo hi", description: "say hi" },
    {
      workspace: process.cwd(),
      sessionId: "sess_command_allow_always",
      signal: new AbortController().signal,
      requestPermission: async () => answer,
    },
  );
}

// decide() returning "ask" forces the host prompt path for any command.
const asking = (calls) => ({
  decide: () => ({ kind: "ask", prompt: "run it?", suggestion: "allow_once" }),
  grant: (t, c, s) => calls.push({ t, c, s }),
});

test("allow_always on a command persists via commandPermissions.grant", async () => {
  const calls = [];
  await run("allow_always", asking(calls));
  assert.deepEqual(calls, [{ t: "Bash", c: "echo hi", s: "always" }]);
});

test("allow_once does NOT persist", async () => {
  const calls = [];
  await run("allow_once", asking(calls));
  assert.equal(calls.length, 0);
});

test("a read-only store (no grant) is a safe no-op, not a crash", async () => {
  // Hosts without a writable store omit grant() — allow_always then behaves like
  // allow_once, exactly as before. Must not throw.
  await run("allow_always", { decide: () => ({ kind: "ask", prompt: "?", suggestion: "allow_once" }) });
});
