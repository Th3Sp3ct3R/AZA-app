// entry.ts must import its command modules STATICALLY.
//
// v0.29.0 shipped a dispatcher that used `await import("./entry/<cmd>.js")` for
// every command. That is fine under plain `node dist/entry.js`, but the desktop
// app runs the esbuild ESM bundle (tauri/src-tauri/runtime/cli/ares-cli.mjs) —
// and ink → yoga-layout carries a genuine top-level await. In a bundle, a
// dynamic import of anything in that graph compiles to an async `__esm(...)`
// module initializer; those deadlocked, so `main()` never settled, the event
// loop drained, and the CLI exited 0 with NO output. 22 of 34 commands died
// silently, including `daemon`, `chat` and `garrison` — the desktop app could
// not start its own backend.
//
// The failure is invisible to `pnpm test` (dist is not the bundle) and to
// typecheck, so it is pinned here at the source level: no lazy entry imports,
// and no async module initializers in the packaged bundle when one exists.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const ENTRY = new URL("../packages/cli/src/entry.ts", import.meta.url);
const BUNDLE = new URL("../tauri/src-tauri/runtime/cli/ares-cli.mjs", import.meta.url);

test("entry.ts never lazily imports a command module", async () => {
  const src = await readFile(ENTRY, "utf8");
  const lazy = [...src.matchAll(/await import\("(\.\/entry\/[^"]+)"\)/gu)].map((m) => m[1]);
  assert.deepEqual(
    lazy,
    [],
    `entry.ts must import command modules statically; found lazy import(s): ${lazy.join(", ")}`,
  );
});

test("entry.ts statically imports the dispatcher's command modules", async () => {
  const src = await readFile(ENTRY, "utf8");
  // The modules whose graphs reach ink/yoga — the ones that actually deadlocked.
  for (const mod of ["./entry/chat.js", "./entry/daemon.js", "./entry/garrisonCmd.js",
    "./entry/telegramWiring.js", "./entry/introspect.js"]) {
    assert.ok(
      new RegExp(`^import \\{[^}]+\\} from "${mod.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}";`, "mu").test(src),
      `expected a static import of ${mod} in entry.ts`,
    );
  }
});

test("the packaged bundle has no async module initializers", async (t) => {
  // Only meaningful once `pnpm --filter ares-tauri build:runtime` has run; CI
  // builds dist but not always the bundle, so skip rather than fail spuriously.
  const exists = await stat(BUNDLE).then((s) => s.isFile()).catch(() => false);
  if (!exists) {
    t.skip("packaged runtime not built (run pnpm build:runtime)");
    return;
  }
  const bundle = await readFile(BUNDLE, "utf8");
  const asyncInits = [...bundle.matchAll(/__esm\(\{\s*async "([^"]+)"\(\)/gu)].map((m) => m[1]);
  assert.deepEqual(
    asyncInits,
    [],
    `bundle contains async __esm initializers, which can deadlock: ${asyncInits.slice(0, 5).join(", ")}`,
  );
});
