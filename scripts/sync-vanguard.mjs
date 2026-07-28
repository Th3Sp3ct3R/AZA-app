// Vendors the compiled Vanguard engine into vendor/vanguard so CI (which has
// no D:\Vanguard checkout) can build the desktop runtime. Local dev keeps the
// pnpm link for live iteration; this copy is what release builds consume.
//
//   node scripts/sync-vanguard.mjs [path-to-vanguard-checkout]
//
// Copies dist/src (compiled JS + type declarations, no maps, no tests) into
// vendor/vanguard/engine/src — "engine", not "dist", because the repo's
// .gitignore swallows any dist/ directory.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[2] ?? path.join(repoRoot, "..", "Vanguard"));
const target = path.join(repoRoot, "vendor", "vanguard");

const sourcePackage = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));

await rm(target, { recursive: true, force: true });
await mkdir(path.join(target, "engine"), { recursive: true });
await cp(path.join(source, "dist", "src"), path.join(target, "engine", "src"), {
  recursive: true,
  filter: (entry) => {
    const base = path.basename(entry);
    if (base.endsWith(".map")) return false;
    return true;
  },
});
await cp(path.join(source, "LICENSE"), path.join(target, "LICENSE"));

await writeFile(path.join(target, "package.json"), `${JSON.stringify({
  name: "vanguard",
  version: sourcePackage.version,
  private: true,
  type: "module",
  description: sourcePackage.description,
  license: sourcePackage.license,
  exports: {
    ".": {
      types: "./engine/src/index.d.ts",
      import: "./engine/src/index.js",
    },
  },
  dependencies: sourcePackage.dependencies ?? {},
}, null, 2)}\n`);

await writeFile(path.join(target, "README.md"), [
  "# vendored Vanguard engine",
  "",
  "Compiled build of the closed-source Vanguard engine (see LICENSE), vendored",
  "so release CI can bundle it into the desktop runtime. Do not edit by hand —",
  "regenerate from a Vanguard checkout with:",
  "",
  "    node scripts/sync-vanguard.mjs [path-to-vanguard]",
  "",
].join("\n"));

console.log(`Vendored vanguard ${sourcePackage.version} from ${source} into ${target}`);
